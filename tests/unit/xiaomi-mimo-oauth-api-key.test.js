import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  createProviderConnection: vi.fn(async (data) => ({ id: "conn-1", ...data })),
  getProviderConnections: vi.fn(async () => []),
  updateProviderConnection: vi.fn(),
  fetchPublic: vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "m1" }] }), { status: 200 })),
}));

vi.mock("next/server", () => ({
  NextResponse: { json: (body, init) => ({ status: init?.status || 200, body, json: async () => body }) },
}));
vi.mock("@/models", () => ({
  createProviderConnection: mocks.createProviderConnection,
  getProviderConnections: mocks.getProviderConnections,
  updateProviderConnection: mocks.updateProviderConnection,
}));
vi.mock("@/shared/utils/ssrfGuard", () => ({ fetchPublic: mocks.fetchPublic }));

const { POST } = await import("../../src/app/api/oauth/xiaomi-mimo/api-key/route.js");

function request(body) {
  return new Request("http://localhost/api/oauth/xiaomi-mimo/api-key", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("Xiaomi MiMo API-key import URL security", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    "http://127.0.0.1:8080/v1",
    "http://169.254.169.254/latest/meta-data",
    "https://evil.example/v1",
    "file:///etc/passwd",
  ])("rejects untrusted base URL %s without forwarding the API key", async (baseUrl) => {
    const response = await POST(request({ apiKey: "sk-secret", baseUrl }));
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/base URL/i);
    expect(mocks.fetchPublic).not.toHaveBeenCalled();
    expect(mocks.createProviderConnection).not.toHaveBeenCalled();
  });

  it("keeps the valid Xiaomi endpoint import contract", async () => {
    const response = await POST(request({ apiKey: "sk-valid", uid: "u1" }));
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ success: true, validated: true, modelCount: 1 });
    expect(mocks.fetchPublic).toHaveBeenCalledWith(
      "https://api.xiaomimimo.com/v1/models",
      expect.objectContaining({ method: "GET", headers: expect.objectContaining({ Authorization: "Bearer sk-valid" }) }),
    );
  });
});
