import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import {
  ANTIGRAVITY_BASE_URLS,
} from "../../open-sse/providers/antigravity-provider-metadata.js";

const credentials = {
  accessToken: "ag-token",
  projectId: "ag-project",
  connectionId: "ag-executor-test",
};
const body = {
  request: {
    contents: [{ role: "user", parts: [{ text: "hello" }] }],
    generationConfig: { maxOutputTokens: 99999 },
  },
};
const log = { debug: vi.fn(), info: vi.fn(), error: vi.fn() };

describe("AntigravityExecutor", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useRealTimers();
  });

  afterEach(() => vi.useRealTimers());

  it("uses deterministic fallback project ID when credentials lack explicit projectId", () => {
    const executor = new AntigravityExecutor();
    const credsWithoutProject = { accessToken: "ag-token", connectionId: "conn-stable-xyz" };
    const req1 = executor.transformRequest("gemini-3-flash-agent", body, true, credsWithoutProject);
    const req2 = executor.transformRequest("gemini-3-flash-agent", body, true, credsWithoutProject);

    expect(req1.project).toBe(req2.project);
    expect(typeof req1.project).toBe("string");
    expect(req1.project.length).toBeGreaterThan(0);
  });

  it("builds production-first URLs and forces image generation to non-streaming", () => {
    const executor = new AntigravityExecutor();

    expect(executor.getBaseUrls()).toBe(ANTIGRAVITY_BASE_URLS);
    expect(
      ANTIGRAVITY_BASE_URLS.map((_, index) =>
        executor.buildUrl("gemini-3-flash", true, index),
      ),
    ).toEqual(
      ANTIGRAVITY_BASE_URLS.map(
        (base) => `${base}/v1internal:streamGenerateContent?alt=sse`,
      ),
    );
    expect(executor.buildUrl("gemini-3-flash", true, 99)).toBe(
      `${ANTIGRAVITY_BASE_URLS[0]}/v1internal:streamGenerateContent?alt=sse`,
    );
    expect(executor.buildUrl("gemini-3.1-flash-image-16x9", true)).toBe(
      `${ANTIGRAVITY_BASE_URLS[0]}/v1internal:generateContent`,
    );
  });

  it("transforms image and chat requests without changing URL metadata", () => {
    const executor = new AntigravityExecutor();
    const image = executor.transformRequest(
      "gemini-3.1-flash-image-16x9",
      {
        request: {
          contents: [
            { role: "user", parts: [{ text: "draw" }, { inlineData: { data: "ignored" } }] },
          ],
          tools: [{ functionDeclarations: [{ name: "ignored" }] }],
        },
      },
      true,
      credentials,
    );
    const chat = executor.transformRequest(
      "gemini-3-flash",
      {
        request: {
          contents: [
            {
              role: "model",
              parts: [
                { thought: true, text: "hidden" },
                { thoughtSignature: "sig" },
                { functionResponse: { name: "tool" } },
              ],
            },
          ],
          output_config: { effort: "high" },
          generationConfig: { maxOutputTokens: 99999 },
          tools: [
            {
              functionDeclarations: [
                { name: "bad tool!", parameters: { type: "OBJECT", enumDescriptions: ["x"] } },
                { name: "bad tool!", parameters: { type: "OBJECT" } },
              ],
            },
          ],
        },
      },
      true,
      credentials,
    );

    expect(image).toMatchObject({
      project: "ag-project",
      model: "gemini-3.1-flash-image",
      requestType: "image_gen",
      request: {
        contents: [{ role: "user", parts: [{ text: "draw" }] }],
        generationConfig: { imageConfig: { aspectRatio: "16:9" } },
      },
    });
    expect(image.request.tools).toBeUndefined();
    expect(chat.request).toMatchObject({
      generationConfig: { maxOutputTokens: 16384 },
      contents: [{ role: "user", parts: [{ functionResponse: { name: "tool" } }] }],
      toolConfig: { functionCallingConfig: { mode: "VALIDATED" } },
    });
    expect(chat.request.output_config).toBeUndefined();
    expect(chat.request.tools[0].functionDeclarations).toHaveLength(1);
    expect(chat.request.tools[0].functionDeclarations[0].name).toBe("bad_tool_");
  });

  it("does not mutate the canonical request body while transforming", () => {
    const executor = new AntigravityExecutor();
    const input = {
      request: {
        contents: [{ role: "model", parts: [{ thought: true, text: "hidden" }, { text: "visible" }] }],
        generationConfig: { maxOutputTokens: 99999 },
        systemInstruction: { parts: [{ text: "You are an AI assistant" }] },
      },
      thinking: { type: "adaptive" },
    };
    const snapshot = structuredClone(input);

    const transformed = executor.transformRequest("gemini-3-flash", input, true, credentials);

    expect(input).toEqual(snapshot);
    expect(transformed).not.toBe(input);
    expect(transformed.request.generationConfig.maxOutputTokens).toBe(16384);
    expect(transformed.thinking).toBeUndefined();
  });

  it("strips Claude adaptive thinking from the Google request envelope", () => {
    // Reproduced from logs/openai-responses_antigravity_claude-sonnet-4-6_20260719_004054_961.
    // The Antigravity v1internal endpoint rejects top-level `thinking` with:
    // "Unknown name \"thinking\": Cannot find field."
    const executor = new AntigravityExecutor();
    const result = executor.transformRequest(
      "claude-sonnet-4-6",
      {
        request: {
          contents: [{ role: "user", parts: [{ text: "think" }] }],
          generationConfig: { maxOutputTokens: 65535 },
        },
        thinking: { type: "adaptive" },
        output_config: { effort: "high" },
      },
      true,
      credentials,
    );

    expect(result.thinking).toBeUndefined();
    expect(result.output_config).toBeUndefined();
    expect(result.request.generationConfig.maxOutputTokens).toBe(16384);
  });

  it("preserves the medium, high, and auto thinking output floor", () => {
    const executor = new AntigravityExecutor();
    const transform = (thinkingConfig, maxOutputTokens) =>
      executor.transformRequest(
        "gemini-3-flash-agent",
        {
          request: {
            contents: [{ role: "user", parts: [{ text: "think" }] }],
            generationConfig: { thinkingConfig, maxOutputTokens },
          },
        },
        true,
        credentials,
      );

    expect(
      transform({ thinkingBudget: 8192 }, 65535).request.generationConfig
        .maxOutputTokens,
    ).toBe(65535);
    expect(
      transform({ thinkingBudget: 24576 }, 65535).request.generationConfig
        .maxOutputTokens,
    ).toBe(65535);
    expect(
      transform({ thinkingBudget: -1 }, 99999).request.generationConfig
        .maxOutputTokens,
    ).toBe(65535);
    expect(
      transform({ thinkingLevel: "medium" }, 99999).request.generationConfig
        .maxOutputTokens,
    ).toBe(65535);
    expect(
      transform({ thinkingLevel: "high" }, 99999).request.generationConfig
        .maxOutputTokens,
    ).toBe(65535);
  });

  it("keeps Gemini 3 thinkingLevel requests at the extended ceiling", () => {
    const executor = new AntigravityExecutor();
    for (const effort of ["medium", "high", "auto"]) {
      const translated = translateRequest(
        FORMATS.OPENAI,
        FORMATS.ANTIGRAVITY,
        "gemini-3-flash-agent",
        {
          messages: [{ role: "user", content: "think" }],
          reasoning_effort: effort,
          max_tokens: 99999,
        },
        true,
        credentials,
      );
      const transformed = executor.transformRequest(
        "gemini-3-flash-agent",
        translated,
        true,
        credentials,
      );

      expect(transformed.request.generationConfig.thinkingConfig.thinkingLevel).toBe(
        effort === "auto" ? "high" : effort,
      );
      expect(transformed.request.generationConfig.maxOutputTokens).toBe(65535);
    }
  });

  it("keeps low thinking at the normal output ceiling", () => {
    const executor = new AntigravityExecutor();
    const transform = (thinkingBudget) =>
      executor.transformRequest(
        "gemini-3-flash-agent",
        {
          request: {
            contents: [{ role: "user", parts: [{ text: "think" }] }],
            generationConfig: {
              thinkingConfig: { thinkingBudget },
              maxOutputTokens: 99999,
            },
          },
        },
        true,
        credentials,
      );

    expect(transform(1024).request.generationConfig.maxOutputTokens).toBe(16384);
  });

  it("falls back from daily to the production chat endpoint", async () => {
    const executor = new AntigravityExecutor();
    proxyAwareFetch.mockRejectedValue(new Error("endpoint offline"));

    await expect(
      executor.execute({
        model: "gemini-3-flash",
        body,
        stream: true,
        credentials,
        log,
        proxyOptions: { proxy: "http://proxy.test" },
      }),
    ).rejects.toThrow("endpoint offline");

    const chatUrls = ANTIGRAVITY_BASE_URLS.map(
      (base) => `${base}/v1internal:streamGenerateContent?alt=sse`,
    );
    expect(proxyAwareFetch.mock.calls.map(([url]) => url)).toEqual(chatUrls);
  });

  it("throws when the daily chat endpoint fails", async () => {
    const executor = new AntigravityExecutor();
    proxyAwareFetch.mockRejectedValue(new Error("unreachable"));

    await expect(
      executor.execute({
        model: "gemini-3-flash",
        body,
        stream: false,
        credentials,
        log,
      }),
    ).rejects.toThrow("unreachable");
    expect(proxyAwareFetch).toHaveBeenCalledTimes(ANTIGRAVITY_BASE_URLS.length);
  });

  it("parses retry headers, duration text, and gRPC quota reset details", () => {
    const executor = new AntigravityExecutor();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-16T00:00:00Z"));

    expect(executor.parseRetryHeaders(new Headers({ "retry-after": "12" }))).toBe(
      12000,
    );
    expect(executor.parseRetryHeaders(new Headers({ "x-ratelimit-reset-after": "3" }))).toBe(
      3000,
    );
    expect(executor.parseRetryFromErrorMessage("quota will reset after 1h2m3s")).toBe(
      3723000,
    );
    expect(
      executor.parseError(
        { status: 429 },
        JSON.stringify({
          error: {
            message: "quota",
            details: [
              {
                "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                metadata: { quotaResetTimeStamp: "2026-07-16T01:00:00Z" },
              },
              {
                "@type": "type.googleapis.com/google.rpc.RetryInfo",
                retryDelay: "30s",
              },
            ],
          },
        }),
      ),
    ).toMatchObject({ status: 429, resetsAtMs: Date.parse("2026-07-16T01:00:00Z") });
  });
});
