import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { getUsageForProvider } from "../../open-sse/services/usage.js";
import {
  extractSubscriptionTier,
  extractValidationInfo,
} from "../../open-sse/services/usage/antigravity.js";
import {
  ANTIGRAVITY_USAGE_ENDPOINT_SETS,
} from "../../open-sse/providers/antigravity-provider-metadata.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const request = {
  provider: "antigravity",
  accessToken: "ag-token",
};
const proxyOptions = { proxy: "http://proxy.test" };

describe("Antigravity usage", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses project cache and maps model plus grouped quotas", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(
        jsonResponse({
          models: {
            "gemini-3-flash": {
              displayName: "Gemini Flash",
              quotaInfo: { remainingFraction: 0.75, resetTime: "2026-07-17T00:00:00Z" },
            },
            internal: { isInternal: true, quotaInfo: { remainingFraction: 1 } },
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          groups: [{
            displayName: "Gemini Models",
            buckets: [{
              bucketId: "gemini-weekly",
              window: "weekly",
              remainingFraction: 0.8,
              resetTime: "2026-07-18T00:00:00Z",
            }],
          }],
        }),
      );

    const usage = await getUsageForProvider(
      { ...request, projectId: "cached-project" },
      proxyOptions,
    );

    expect(proxyAwareFetch).toHaveBeenNthCalledWith(
      1,
      ANTIGRAVITY_USAGE_ENDPOINT_SETS.quota[0],
      expect.objectContaining({ body: JSON.stringify({ project: "cached-project" }) }),
      proxyOptions,
    );
    expect(usage).toMatchObject({
      plan: "Unknown",
      quotas: {
        "gemini-3-flash": {
          used: 250,
          total: 1000,
          remainingPercentage: 75,
          displayName: "Gemini Flash",
        },
      },
      quotaGroups: [{
        displayName: "Gemini Models",
        buckets: [{ window: "weekly", remainingFraction: 0.8 }],
      }],
    });
    expect(usage.quotas).not.toHaveProperty("internal");
  });

  it("prefers paid tier and supports restricted allowed tier fallback", () => {
    expect(extractSubscriptionTier({
      currentTier: { name: "Free" },
      paidTier: { id: "PRO" },
    })).toBe("PRO");
    expect(extractSubscriptionTier({
      currentTier: { name: "Free" },
      ineligibleTiers: [{ reasonCode: "NOT_ELIGIBLE" }],
      allowedTiers: [{ isDefault: true, name: "Free" }],
    })).toBe("Free (Restricted)");
  });

  it("falls back across quota endpoints and retries 403 without project", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse({}, 503))
      .mockResolvedValueOnce(jsonResponse({}, 403))
      .mockResolvedValueOnce(jsonResponse({ models: {} }))
      .mockResolvedValueOnce(jsonResponse({ groups: [] }));

    const usage = await getUsageForProvider(
      { ...request, projectId: "stale-project" },
      proxyOptions,
    );

    expect(proxyAwareFetch).toHaveBeenNthCalledWith(
      1,
      ANTIGRAVITY_USAGE_ENDPOINT_SETS.quota[0],
      expect.objectContaining({ body: JSON.stringify({ project: "stale-project" }) }),
      proxyOptions,
    );
    expect(proxyAwareFetch).toHaveBeenNthCalledWith(
      2,
      ANTIGRAVITY_USAGE_ENDPOINT_SETS.quota[1],
      expect.objectContaining({ body: JSON.stringify({ project: "stale-project" }) }),
      proxyOptions,
    );
    expect(proxyAwareFetch).toHaveBeenNthCalledWith(
      3,
      ANTIGRAVITY_USAGE_ENDPOINT_SETS.quota[1],
      expect.objectContaining({ body: "{}" }),
      proxyOptions,
    );
    expect(proxyAwareFetch).toHaveBeenNthCalledWith(
      4,
      ANTIGRAVITY_USAGE_ENDPOINT_SETS.quotaSummary[0],
      expect.objectContaining({ body: JSON.stringify({ project: "stale-project" }) }),
      proxyOptions,
    );
    expect(usage).toMatchObject({ quotas: {} });
  });

  it("falls back to quota without a project when subscription lookup fails", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse({}, 500))
      .mockResolvedValueOnce(jsonResponse({}, 500))
      .mockResolvedValueOnce(jsonResponse({}, 500))
      .mockResolvedValueOnce(jsonResponse({ models: {} }))
      .mockResolvedValueOnce(jsonResponse({ groups: [] }));

    const usage = await getUsageForProvider(request, proxyOptions);

    expect(usage).toMatchObject({ plan: "Unknown", quotas: {} });
  });

  it("fails open for authentication and forbidden quota responses", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse({}, 401));

    await expect(getUsageForProvider({ ...request, projectId: "cached-project" })).resolves.toMatchObject({
      message: expect.stringContaining("authentication expired"),
      quotas: {},
    });
  });

  it("extracts validation info when account requires verification", () => {
    const info = {
      ineligibleTiers: [
        {
          reasonCode: "VALIDATION_REQUIRED",
          reasonMessage: "Your current account is not eligible for Antigravity. Verify your account to continue.",
          validationErrorMessage: "Verify your account to continue.",
          validationUrlLinkText: "Verify your account",
          validationUrl: "https://accounts.google.com/signin/continue?sarp=1",
          validationLearnMoreUrl: "https://support.google.com/accounts?p=al_alert",
        },
      ],
    };

    expect(extractValidationInfo(info)).toEqual({
      reasonCode: "VALIDATION_REQUIRED",
      message: "Verify your account to continue.",
      url: "https://accounts.google.com/signin/continue?sarp=1",
      urlText: "Verify your account",
      learnMoreUrl: "https://support.google.com/accounts?p=al_alert",
    });

    expect(extractValidationInfo({})).toBeNull();
  });

  it("surfaces validation payload in usage when subscription lookup indicates verification needed", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(
        jsonResponse({
          cloudaicompanionProject: "aicode-consumers",
          ineligibleTiers: [
            {
              reasonCode: "VALIDATION_REQUIRED",
              validationErrorMessage: "Verify your account to continue.",
              validationUrl: "https://accounts.google.com/signin/continue?sarp=1",
              validationUrlLinkText: "Verify your account",
              validationLearnMoreUrl: "https://support.google.com/accounts?p=al_alert",
            },
          ],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ models: {} }))
      .mockResolvedValueOnce(jsonResponse({ groups: [] }));

    const usage = await getUsageForProvider(request, proxyOptions);

    expect(usage).toMatchObject({
      validation: {
        reasonCode: "VALIDATION_REQUIRED",
        message: "Verify your account to continue.",
        url: "https://accounts.google.com/signin/continue?sarp=1",
        urlText: "Verify your account",
        learnMoreUrl: "https://support.google.com/accounts?p=al_alert",
      },
    });
  });
});