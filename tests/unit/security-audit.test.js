import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Source paths are repo-relative; vitest runs from tests/, so resolve from the repo root.
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

// ============================================================
// AUDIT-002 (#1962): API key masking in usage stats
// Note: fork modularized usageRepo.js into usage/ sub-modules
// ============================================================
describe("AUDIT-002: API key masking", () => {
  it("usage-helpers.js should contain maskApiKey function", () => {
    const source = fs.readFileSync(
      path.resolve(REPO_ROOT, "src/lib/db/repos/usageRepo.js"),
      "utf-8"
    );
    expect(source).toContain("function maskApiKey");
    expect(source).toContain("export function maskApiKey");
  });

  it("getUsageHistory (usage-query.js) should use apiKeyMasked instead of apiKey", () => {
    const source = fs.readFileSync(
      path.resolve(REPO_ROOT, "src/lib/db/repos/usageRepo.js"),
      "utf-8"
    );
    expect(source).toContain("apiKeyMasked: maskApiKey(r.apiKey)");
    expect(source).not.toContain("apiKey: r.apiKey,");
  });

  it("getUsageStats (usage-stats.js) should use apiKeyMasked in byApiKey entries", () => {
    const source = fs.readFileSync(
      path.resolve(REPO_ROOT, "src/lib/db/repos/usageRepo.js"),
      "utf-8"
    );
    const maskedCount = (source.match(/apiKeyMasked/g) || []).length;
    expect(maskedCount).toBeGreaterThanOrEqual(4);

    // Daily summary path (aggregateByApiKey)
    const dailyPath = source.match(
      /stats\.byApiKey\[akKey\] = createStatsEntry\(\{[^)]*apiKeyMasked[^)]*\}\)/s,
    );
    expect(dailyPath).not.toBeNull();
  });

  it("byApiKey object keys should use masked key, not raw key (usage-stats.js)", () => {
    const source = fs.readFileSync(
      path.resolve(REPO_ROOT, "src/lib/db/repos/usageRepo.js"),
      "utf-8"
    );
    expect(source).toContain("${apiKeyMasked}|${r.model}|${r.provider");
    expect(source).not.toContain("${r.apiKey}|${r.model}|${r.provider");
  });

  it("usage-stats.js should import maskApiKey from usage-helpers", () => {
    const source = fs.readFileSync(
      path.resolve("src/lib/db/repos/usage/usage-stats.js"),
      "utf-8",
    );
    expect(source).toContain("maskApiKey");
    expect(source).toContain("usage-helpers.js");
  });
});

// ============================================================
// AUDIT-003 (#1961): Proxy URL validation
// ============================================================
describe("AUDIT-003: Proxy URL validation", () => {
  beforeEach(() => {
    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
    delete process.env.ALL_PROXY;
    delete process.env.NINE_ROUTER_PROXY_MANAGED;
    delete process.env.NINE_ROUTER_PROXY_URL;
    delete process.env.NINE_ROUTER_NO_PROXY;
    delete process.env.NO_PROXY;
  });

  it("source should contain validateProxyUrl function", () => {
    const source = fs.readFileSync(
      path.resolve(REPO_ROOT, "src/lib/network/outboundProxy.js"),
      "utf-8"
    );
    expect(source).toContain("function validateProxyUrl");
    expect(source).toContain("ALLOWED_PROXY_SCHEMES");
  });

  it("should accept valid http proxy URLs", async () => {
    vi.resetModules();
    const { applyOutboundProxyEnv } =
      await import("../../src/lib/network/outboundProxy.js");
    applyOutboundProxyEnv({
      outboundProxyEnabled: true,
      outboundProxyUrl: "http://proxy.example.com:8080",
    });
    expect(process.env.HTTP_PROXY).toContain("http://proxy.example.com:8080");
    expect(process.env.HTTPS_PROXY).toContain("http://proxy.example.com:8080");
  });

  it("should accept valid socks5 proxy URLs", async () => {
    vi.resetModules();
    const { applyOutboundProxyEnv } =
      await import("../../src/lib/network/outboundProxy.js");
    applyOutboundProxyEnv({
      outboundProxyEnabled: true,
      outboundProxyUrl: "socks5://proxy.example.com:1080",
    });
    expect(process.env.ALL_PROXY).toBe("socks5://proxy.example.com:1080");
  });

  it("should reject URLs with shell metacharacters (newline)", async () => {
    vi.resetModules();
    const { applyOutboundProxyEnv } =
      await import("../../src/lib/network/outboundProxy.js");
    applyOutboundProxyEnv({
      outboundProxyEnabled: true,
      outboundProxyUrl: "http://proxy.example.com:8080\nmalicious",
    });
    expect(process.env.HTTP_PROXY).toBeUndefined();
  });

  it("should reject URLs with shell metacharacters (backtick)", async () => {
    vi.resetModules();
    const { applyOutboundProxyEnv } =
      await import("../../src/lib/network/outboundProxy.js");
    applyOutboundProxyEnv({
      outboundProxyEnabled: true,
      outboundProxyUrl: "http://`whoami`.example.com:8080",
    });
    expect(process.env.HTTP_PROXY).toBeUndefined();
  });

  it("should reject non-allowed schemes (file://)", async () => {
    vi.resetModules();
    const { applyOutboundProxyEnv } =
      await import("../../src/lib/network/outboundProxy.js");
    applyOutboundProxyEnv({
      outboundProxyEnabled: true,
      outboundProxyUrl: "file:///etc/passwd",
    });
    expect(process.env.HTTP_PROXY).toBeUndefined();
  });

  it("should reject non-allowed schemes (javascript:)", async () => {
    vi.resetModules();
    const { applyOutboundProxyEnv } =
      await import("../../src/lib/network/outboundProxy.js");
    applyOutboundProxyEnv({
      outboundProxyEnabled: true,
      outboundProxyUrl: "javascript:alert(1)",
    });
    expect(process.env.HTTP_PROXY).toBeUndefined();
  });
});

// ============================================================
// AUDIT-018 (#1972): XSS escaping in OAuth callback
// ============================================================
describe("AUDIT-018: XSS escaping in OAuth callback", () => {
  it("source should contain escapeHtml function", () => {
    const source = fs.readFileSync(
      path.resolve(REPO_ROOT, "src/lib/oauth/utils/server.js"),
      "utf-8"
    );
    expect(source).toContain("function escapeHtml");
  });

  it("should escape ampersand, angle brackets, and quotes", () => {
    const source = fs.readFileSync(
      path.resolve(REPO_ROOT, "src/lib/oauth/utils/server.js"),
      "utf-8"
    );
    expect(source).toContain("&amp;");
    expect(source).toContain("&lt;");
    expect(source).toContain("&gt;");
    expect(source).toContain("&quot;");
    expect(source).toContain("&#39;");
  });

  it("should use safeMessage in rendered HTML, not raw message", () => {
    const source = fs.readFileSync(
      path.resolve(REPO_ROOT, "src/lib/oauth/utils/server.js"),
      "utf-8"
    );
    expect(source).toContain("safeMessage");
    expect(source).toContain("${safeMessage}");
    expect(source).not.toContain("<p>${message}</p>");
  });
});

// ============================================================
// AUDIT-004 (#1963): TOCTOU race - atomic lock file
// ============================================================
describe("AUDIT-004: Atomic lock file for MITM startup", () => {
  it("manager.js should define LOCK_FILE constant", () => {
    const source = fs.readFileSync(
      path.resolve(REPO_ROOT, "src/mitm/manager.js"),
      "utf-8"
    );
    expect(source).toContain("LOCK_FILE");
    expect(source).toContain(".mitm.lock");
  });

  it("should use O_EXCL flag (wx) for atomic creation", () => {
    const source = fs.readFileSync(
      path.resolve(REPO_ROOT, "src/mitm/manager.js"),
      "utf-8"
    );
    expect(source).toContain('"wx"');
    expect(source).toContain("EEXIST");
  });

  it("should clean up lock file on all exit paths", () => {
    const source = fs.readFileSync(
      path.resolve(REPO_ROOT, "src/mitm/manager.js"),
      "utf-8"
    );
    const matches = source.match(/unlinkSync\(LOCK_FILE\)/g);
    expect(matches).not.toBeNull();
    expect(matches.length).toBeGreaterThanOrEqual(4);
  });
});

// ============================================================
// AUDIT-001 (#1965): Race condition in retry tracking
// ============================================================
describe("AUDIT-001: Synchronous restart guard", () => {
  it("mitmIsRestarting should be set before first await expression", () => {
    const source = fs.readFileSync(
      path.resolve(REPO_ROOT, "src/mitm/manager.js"),
      "utf-8"
    );

    const funcStart = source.indexOf("async function scheduleMitmRestart");
    expect(funcStart).toBeGreaterThan(-1);

    const funcBody = source.substring(funcStart, funcStart + 2000);
    const guardCheckIdx = funcBody.indexOf("if (mitmIsRestarting) return;");
    expect(guardCheckIdx).toBeGreaterThan(-1);

    const afterGuard = funcBody.substring(guardCheckIdx);
    const noComments = afterGuard.replace(/\/\/.*$/gm, "");

    const firstAwaitIdx = noComments.search(/\bawait\s+/);
    expect(firstAwaitIdx).toBeGreaterThan(-1);

    const setFlagIdx = noComments.indexOf("mitmIsRestarting = true");
    expect(setFlagIdx).toBeGreaterThan(-1);
    expect(setFlagIdx).toBeLessThan(firstAwaitIdx);
  });

  it("mitmIsRestarting should be reset on max-restarts early return", () => {
    const source = fs.readFileSync(
      path.resolve(REPO_ROOT, "src/mitm/manager.js"),
      "utf-8"
    );

    const funcStart = source.indexOf("async function scheduleMitmRestart");
    const funcBody = source.substring(funcStart, funcStart + 2000);

    const maxRestartsIdx = funcBody.indexOf("Max restart attempts reached");
    expect(maxRestartsIdx).toBeGreaterThan(-1);

    const afterMax = funcBody.substring(maxRestartsIdx, maxRestartsIdx + 200);
    expect(afterMax).toContain("mitmIsRestarting = false");
  });
});
