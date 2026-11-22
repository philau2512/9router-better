import { describe, expect, it, vi } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

import {
  ANTIGRAVITY_BASE_URLS,
  ANTIGRAVITY_DYNAMIC_MODEL_SKIP_IDS,
  ANTIGRAVITY_OPERATIONS,
  ANTIGRAVITY_STATIC_MODELS,
  ANTIGRAVITY_USAGE_ENDPOINTS,
  ANTIGRAVITY_USAGE_MODEL_IDS,
} from "../../open-sse/providers/antigravity-provider-metadata.js";
import REGISTRY from "../../open-sse/providers/registry/index.js";
import { PROVIDERS } from "../../open-sse/config/providers.js";
import { getProviderModels } from "../../open-sse/config/providerModels.js";

const activeRegistry = REGISTRY.find(({ id }) => id === "antigravity");

describe("Antigravity provider metadata", () => {
  it("uses daily first and falls back to the production chat endpoint", () => {
    expect(ANTIGRAVITY_BASE_URLS).toEqual([
      "https://daily-cloudcode-pa.sandbox.googleapis.com",
      "https://daily-cloudcode-pa.googleapis.com",
      "https://cloudcode-pa.googleapis.com",
    ]);
    expect(PROVIDERS.antigravity.baseUrls).toBe(ANTIGRAVITY_BASE_URLS);
    expect(activeRegistry).toBeDefined();
    expect(activeRegistry.transport.baseUrls).toBe(ANTIGRAVITY_BASE_URLS);
  });

  it("derives registry models and usage endpoints from canonical metadata", () => {
    expect(activeRegistry.models).toBe(ANTIGRAVITY_STATIC_MODELS);
    expect(getProviderModels("ag")).toBe(ANTIGRAVITY_STATIC_MODELS);
    expect(activeRegistry.transport.usage).toMatchObject(
      ANTIGRAVITY_USAGE_ENDPOINTS,
    );
    expect(ANTIGRAVITY_USAGE_ENDPOINTS.quotaApiUrl).toBe(
      `https://cloudcode-pa.googleapis.com${ANTIGRAVITY_OPERATIONS.fetchAvailableModels}`,
    );
    expect(ANTIGRAVITY_USAGE_ENDPOINTS.loadProjectApiUrl).toBe(
      `https://cloudcode-pa.googleapis.com${ANTIGRAVITY_OPERATIONS.loadCodeAssist}`,
    );
  });

  it("keeps every static model eligible for quota, including image generation", () => {
    expect([...ANTIGRAVITY_USAGE_MODEL_IDS]).toEqual(
      ANTIGRAVITY_STATIC_MODELS.map(({ id }) => id),
    );
    expect(ANTIGRAVITY_USAGE_MODEL_IDS.has("gemini-3.1-flash-image")).toBe(
      true,
    );
  });

  it("keeps active registry and public image-model contracts intact", () => {
    const antigravityEntries = REGISTRY.filter(({ id }) => id === "antigravity");
    const imageModel = ANTIGRAVITY_STATIC_MODELS.find(
      ({ id }) => id === "gemini-3.1-flash-image",
    );

    expect(antigravityEntries).toHaveLength(1);
    expect(activeRegistry.transport.format).toBe("antigravity");
    expect(activeRegistry.serviceKinds).toEqual(["llm", "image", "webSearch"]);
    expect(imageModel).toMatchObject({
      kind: "image",
      type: "image",
      imageGen: true,
      capabilities: ["textToImage"],
    });
  });

  it("keeps model IDs unique and live-catalog exclusions separate from quota models", () => {
    const modelIds = ANTIGRAVITY_STATIC_MODELS.map(({ id }) => id);

    expect(new Set(modelIds).size).toBe(modelIds.length);
    expect(modelIds.every(Boolean)).toBe(true);
    expect(ANTIGRAVITY_DYNAMIC_MODEL_SKIP_IDS.has("tab_flash_lite_preview")).toBe(
      true,
    );
    expect(
      ANTIGRAVITY_DYNAMIC_MODEL_SKIP_IDS.has("gemini-3.1-flash-image"),
    ).toBe(false);
    expect(
      [...ANTIGRAVITY_DYNAMIC_MODEL_SKIP_IDS].some((id) =>
        ANTIGRAVITY_USAGE_MODEL_IDS.has(id),
      ),
    ).toBe(false);
  });

  it("exports valid model aliases for Gemini 3.6 & 3.7 Flash family", () => {
    const { ANTIGRAVITY_MODEL_ALIASES } = require("../../open-sse/providers/antigravity-provider-metadata.js");
    expect(ANTIGRAVITY_MODEL_ALIASES["gemini-3.7-flash"]).toBe("gemini-3.7-flash-high");
    expect(ANTIGRAVITY_MODEL_ALIASES["gemini-3.7-flash-thinking"]).toBe("gemini-3.7-flash-high");
    expect(ANTIGRAVITY_MODEL_ALIASES["gemini-3.6-flash"]).toBe("gemini-3.6-flash-high");
    expect(ANTIGRAVITY_MODEL_ALIASES["gemini-3.6-flash-agent"]).toBe("gemini-3-flash-agent");
    expect(ANTIGRAVITY_MODEL_ALIASES["gemini-3.6-flash-extra-low"]).toBe("gemini-3.5-flash-extra-low");
    expect(ANTIGRAVITY_MODEL_ALIASES["claude-3-7-sonnet"]).toBe("claude-sonnet-4-6");
  });
});
