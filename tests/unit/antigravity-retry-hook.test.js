import { describe, it, expect } from "vitest";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";
import antigravity from "../../open-sse/providers/registry/antigravity.js";

const MAX = 10000;
function res(status, headers = {}, body = null) {
  return {
    status,
    headers: { get: (key) => headers[key.toLowerCase()] ?? null },
    clone: () => ({
      text: async () => (body == null ? "" : JSON.stringify(body)),
    }),
  };
}

describe("antigravity computeRetryDelay hook", () => {
  const executor = new AntigravityExecutor();

  it("uses Retry-After and rejects delays above the cap", async () => {
    expect(
      await executor.computeRetryDelay(res(429, { "retry-after": "5" }), 1),
    ).toBe(5000);
    expect(
      await executor.computeRetryDelay(res(429, { "retry-after": "60" }), 1),
    ).toBe(false);
  });

  it("parses transient retry delays and uses backoff as fallback", async () => {
    expect(
      await executor.computeRetryDelay(
        res(429, {}, { error: { message: "quota will reset after 3s" } }),
        1,
      ),
    ).toBe(3000);
    expect(await executor.computeRetryDelay(res(429), 3)).toBe(
      Math.min(1000 * 2 ** 3, MAX),
    );
    expect(await executor.computeRetryDelay(res(503), 1)).toBe(2000);
  });

  it("retries known transient upstream errors only", async () => {
    expect(
      await executor.computeRetryDelay(
        res(
          500,
          {},
          { error: { message: "Agent execution terminated due to error" } },
        ),
        1,
      ),
    ).toBe(2000);
    expect(
      await executor.computeRetryDelay(
        res(
          500,
          {},
          { error: { message: "Our servers are experiencing high traffic" } },
        ),
        2,
      ),
    ).toBe(4000);
    expect(
      await executor.computeRetryDelay(
        res(400, {}, { error: { message: "Invalid request" } }),
        1,
      ),
    ).toBe(false);
  });

  it("deduplicates sanitized tool names", () => {
    const out = executor.transformRequest(
      "claude-opus-4-6-thinking",
      {
        request: {
          contents: [{ role: "user", parts: [{ text: "hi" }] }],
          tools: [
            {
              functionDeclarations: [
                {
                  name: "read/file",
                  parameters: { type: "object", properties: {} },
                },
                {
                  name: "read file",
                  parameters: { type: "object", properties: {} },
                },
                {
                  name: "read/file",
                  parameters: { type: "object", properties: {} },
                },
              ],
            },
          ],
        },
      },
      true,
      { projectId: "project-1", connectionId: "conn-1" },
    );

    expect(
      out.request.tools[0].functionDeclarations.map((fn) => fn.name),
    ).toEqual(["read_file"]);
  });

  it("uses the official IDE transport fingerprint", () => {
    expect(antigravity.transport.baseUrls).toContain(
      "https://daily-cloudcode-pa.googleapis.com",
    );
    expect(antigravity.transport.headers["User-Agent"]).toBe(
      "antigravity/hub/2.24.0 darwin/arm64",
    );
    const headers = executor.buildHeaders({ accessToken: "tok" }, true);
    expect(headers["User-Agent"]).toBe("antigravity/hub/2.24.0 darwin/arm64");
    expect(headers).not.toHaveProperty("x-request-source");
  });

  it("keeps ordinary output below 16384 and permits active thinking up to 65535", () => {
    const ordinary = executor.transformRequest(
      "gemini-2.5-pro",
      {
        request: {
          contents: [{ role: "user", parts: [{ text: "hi" }] }],
          generationConfig: { maxOutputTokens: 90000 },
        },
      },
      true,
      { projectId: "project-1", connectionId: "conn-1" },
    );
    const thinking = executor.transformRequest(
      "claude-opus-4-6-thinking",
      {
        request: {
          contents: [{ role: "user", parts: [{ text: "hi" }] }],
          generationConfig: {
            maxOutputTokens: 90000,
            thinkingConfig: { thinkingLevel: "high" },
          },
        },
      },
      true,
      { projectId: "project-1", connectionId: "conn-1" },
    );

    expect(ordinary.request.generationConfig.maxOutputTokens).toBe(16384);
    expect(thinking.request.generationConfig.maxOutputTokens).toBe(65535);
  });
});
