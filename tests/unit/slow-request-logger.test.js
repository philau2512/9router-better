import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";

const originalEnableRequestLogs = process.env.ENABLE_REQUEST_LOGS;
const originalEnableSlowLogs = process.env.ENABLE_SLOW_REQUEST_LOGS;
const originalSlowThreshold = process.env.SLOW_REQUEST_THRESHOLD_MS;
const originalSlowWatchdog = process.env.SLOW_REQUEST_WATCHDOG_MS;
const originalCwd = process.cwd;

async function loadLogger() {
  vi.resetModules();
  return await import("../../open-sse/utils/requestLogger.js");
}

describe("slow request logger auto-trap", () => {
  const tempRoot = path.join(process.cwd(), "tmp-slow-request-logger-test");

  beforeEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    fs.mkdirSync(tempRoot, { recursive: true });
    process.cwd = () => tempRoot;
    process.env.ENABLE_REQUEST_LOGS = "false";
    process.env.ENABLE_SLOW_REQUEST_LOGS = "true";
    process.env.SLOW_REQUEST_THRESHOLD_MS = "5000"; // 5s for testing
    process.env.SLOW_REQUEST_WATCHDOG_MS = "0"; // Disable automatic timer by default in test unless tested
  });

  afterEach(() => {
    process.env.ENABLE_REQUEST_LOGS = originalEnableRequestLogs;
    process.env.ENABLE_SLOW_REQUEST_LOGS = originalEnableSlowLogs;
    process.env.SLOW_REQUEST_THRESHOLD_MS = originalSlowThreshold;
    process.env.SLOW_REQUEST_WATCHDOG_MS = originalSlowWatchdog;
    process.cwd = originalCwd;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("does not write any files to disk for fast successful requests (2s, 200 OK)", async () => {
    const { createRequestLogger } = await loadLogger();
    const logger = await createRequestLogger("openai-responses", "antigravity", "gemini-3.7-flash-tiered");

    logger.logClientRawRequest("https://example.com/chat", { prompt: "hi" }, { authorization: "Bearer sk-123" });
    logger.logRawRequest({ prompt: "hi" });
    logger.logOpenAIRequest({ messages: [{ role: "user", content: "hi" }] });
    logger.logTargetRequest("https://gemini.api", { "x-api-key": "secret" }, { contents: [] });
    logger.appendProviderChunk("data: hello\n\n");

    await logger.finalize({
      durationMs: 2100,
      status: "success",
      ttft: 2000,
    });

    const logsDir = path.join(tempRoot, "logs");
    expect(fs.existsSync(logsDir)).toBe(false);
  });

  it("automatically writes full pipeline to logs/slow-requests/ with seconds for slow requests (94s / 220s)", async () => {
    const { createRequestLogger } = await loadLogger();
    const logger = await createRequestLogger("openai-responses", "antigravity", "gemini-3.7-flash-tiered");

    logger.logClientRawRequest("https://example.com/chat", { prompt: "complex code task" }, { authorization: "Bearer secret-token" });
    logger.logRawRequest({ prompt: "complex code task" });
    logger.logOpenAIRequest({ messages: [{ role: "user", content: "complex code task" }] });
    logger.logTargetRequest("https://antigravity.api", {}, { contents: [{ role: "user", parts: [{ text: "complex code task" }] }] });
    logger.appendProviderChunk("data: chunk1\n\n");
    logger.appendProviderChunk("data: chunk2\n\n");

    await logger.finalize({
      durationMs: 220820,
      status: "success",
      ttft: 220230,
      usage: { prompt_tokens: 69100, completion_tokens: 243 },
    });

    const slowDir = path.join(tempRoot, "logs", "slow-requests");
    expect(fs.existsSync(slowDir)).toBe(true);

    const folders = fs.readdirSync(slowDir);
    expect(folders.length).toBe(1);
    expect(folders[0]).toMatch(/^221s_OK_openai-responses_antigravity_gemini-3.7-flash-tiered_/);

    const sessionDir = path.join(slowDir, folders[0]);
    expect(fs.existsSync(path.join(sessionDir, "1_req_client.json"))).toBe(true);
    expect(fs.existsSync(path.join(sessionDir, "2_req_source.json"))).toBe(true);
    expect(fs.existsSync(path.join(sessionDir, "3_req_openai.json"))).toBe(true);
    expect(fs.existsSync(path.join(sessionDir, "4_req_target.json"))).toBe(true);
    expect(fs.existsSync(path.join(sessionDir, "5_res_provider.txt"))).toBe(true);
    expect(fs.existsSync(path.join(sessionDir, "metadata.json"))).toBe(true);

    const clientJson = JSON.parse(fs.readFileSync(path.join(sessionDir, "1_req_client.json"), "utf8"));
    expect(clientJson.headers.authorization).toBe("[REDACTED]");

    const meta = JSON.parse(fs.readFileSync(path.join(sessionDir, "metadata.json"), "utf8"));
    expect(meta.durationMs).toBe(220820);
    expect(meta.seconds).toBe(221);
    expect(meta.ttft).toBe(220230);
  });

  it("automatically writes error request logs with ERROR status tag and 6_error.json", async () => {
    const { createRequestLogger } = await loadLogger();
    const logger = await createRequestLogger("claude", "antigravity", "gemini-3.7-flash-tiered");

    logger.logRawRequest({ message: "failing request" });
    logger.logError(new Error("504 Gateway Timeout: Upstream hung"));

    await logger.finalize({
      durationMs: 94260,
      status: "error",
      error: new Error("504 Gateway Timeout: Upstream hung"),
    });

    const slowDir = path.join(tempRoot, "logs", "slow-requests");
    const folders = fs.readdirSync(slowDir);
    expect(folders.length).toBe(1);
    expect(folders[0]).toMatch(/^94s_ERROR_claude_antigravity_gemini-3.7-flash-tiered_/);

    const sessionDir = path.join(slowDir, folders[0]);
    expect(fs.existsSync(path.join(sessionDir, "6_error.json"))).toBe(true);
    const errJson = JSON.parse(fs.readFileSync(path.join(sessionDir, "6_error.json"), "utf8"));
    expect(errJson.error).toContain("504 Gateway Timeout");
  });
});
