import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderCredentials: vi.fn(),
  handleChatCore: vi.fn(),
  markAccountUnavailable: vi.fn(),
  clearAccountError: vi.fn(),
  handleAntigravityQuotaError: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: async () => ({ requireApiKey: false }),
  getModelAliases: async () => ({}),
  getComboByName: async () => null,
  getProviderNodes: async () => [],
  getCombos: async () => [],
  getProviderConnections: async () => [],
  getProviderConnectionById: async () => null,
  getCustomModels: async () => [],
  getApiKeyValidationInfo: async () => ({ isValid: true }),
}));

vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: mocks.markAccountUnavailable,
  clearAccountError: mocks.clearAccountError,
  extractApiKey: () => null,
  isValidApiKey: async () => true,
  enforceApiKeyPolicy: async () => ({ ok: true, auth: { key: "mock" } }),
  getApiKeyValue: () => null,
  logApiKeyPresence: vi.fn(),
  normalizeApiKeyFailureLog: vi.fn(),
}));

vi.mock("@/sse/services/antigravityQuota.js", () => ({
  handleAntigravityQuotaError: mocks.handleAntigravityQuotaError,
  clearAntigravityStrikes: vi.fn(),
}));

vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: async (_p, c) => c,
  updateProviderCredentials: vi.fn(),
}));

vi.mock("open-sse/handlers/chatCore.js", () => ({
  handleChatCore: mocks.handleChatCore,
}));

const { handleChat } = await import("../../src/sse/handlers/chat.js");

const post = (body) =>
  new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("Antigravity 429 Fallback to Next Account", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should mark account unavailable and route to next Antigravity account on 429 RESOURCE_EXHAUSTED", async () => {
    const acc1 = {
      connectionId: "conn-ag-1",
      connectionName: "acc1@gmail.com",
      provider: "antigravity",
    };
    const acc2 = {
      connectionId: "conn-ag-2",
      connectionName: "acc2@gmail.com",
      provider: "antigravity",
    };

    // getProviderCredentials returns acc1 on first call, acc2 on second call (when conn-ag-1 is excluded)
    mocks.getProviderCredentials.mockImplementation(async (_provider, excludeSet) => {
      if (excludeSet?.has("conn-ag-1")) {
        return acc2;
      }
      return acc1;
    });

    mocks.handleAntigravityQuotaError.mockResolvedValue(null);

    mocks.markAccountUnavailable.mockResolvedValue({
      shouldFallback: true,
      cooldownMs: 5 * 60 * 60 * 1000,
    });

    // acc1 fails with 429; acc2 succeeds with 200
    mocks.handleChatCore.mockImplementation(async ({ credentials }) => {
      if (credentials.connectionId === "conn-ag-1") {
        return {
          success: false,
          status: 429,
          error: `[ERROR] [429]: { "error": { "code": 429, "message": "Resource has been exhausted (e.g. check quota).", "status": "RESOURCE_EXHAUSTED" } }`,
          response: new Response(JSON.stringify({ error: "429" }), {
            status: 429,
            headers: { "Content-Type": "application/json" },
          }),
        };
      }
      return {
        success: true,
        response: new Response("OK", { status: 200 }),
      };
    });

    const res = await handleChat(
      post({ model: "antigravity/gemini-3.8-flash-medium", messages: [{ role: "user", content: "hi" }] })
    );

    expect(res.status).toBe(200);

    // markAccountUnavailable must be called for acc1 on 429
    expect(mocks.markAccountUnavailable).toHaveBeenCalledWith(
      "conn-ag-1",
      429,
      expect.stringContaining("RESOURCE_EXHAUSTED"),
      "antigravity",
      "gemini-3.8-flash-medium",
      undefined
    );

    // Both accounts must have been tried
    expect(mocks.handleChatCore).toHaveBeenCalledTimes(2);
  });

  it("should fail gracefully when all accounts are exhausted", async () => {
    const acc1 = {
      connectionId: "conn-ag-1",
      connectionName: "acc1@gmail.com",
      provider: "antigravity",
    };

    mocks.getProviderCredentials.mockImplementation(async (_provider, excludeSet) => {
      if (excludeSet?.has("conn-ag-1")) {
        return null; // no more accounts
      }
      return acc1;
    });

    mocks.handleAntigravityQuotaError.mockResolvedValue(null);
    mocks.markAccountUnavailable.mockResolvedValue({
      shouldFallback: true,
      cooldownMs: 5 * 60 * 60 * 1000,
    });

    mocks.handleChatCore.mockResolvedValue({
      success: false,
      status: 429,
      error: `[ERROR] [429]: { "error": { "code": 429, "message": "Resource has been exhausted.", "status": "RESOURCE_EXHAUSTED" } }`,
      response: new Response(JSON.stringify({ error: "429" }), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      }),
    });

    const res = await handleChat(
      post({ model: "antigravity/gemini-3.8-flash-medium", messages: [{ role: "user", content: "hi" }] })
    );

    // Expect error response because no more accounts exist
    expect([429, 503]).toContain(res.status);
    expect(mocks.handleChatCore).toHaveBeenCalledTimes(1);
  });
});