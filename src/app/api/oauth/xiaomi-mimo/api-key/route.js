import { NextResponse } from "next/server";
import { createProviderConnection } from "@/models";
import { fetchPublic } from "@/shared/utils/ssrfGuard";

const DEFAULT_BASE_URL = "https://api.xiaomimimo.com/v1";
const ALLOWED_BASE_ORIGIN = "https://api.xiaomimimo.com";

function normalizeXiaomiBaseUrl(value) {
  const raw = String(value || DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("Invalid Xiaomi base URL");
  }
  if (parsed.origin !== ALLOWED_BASE_ORIGIN || parsed.username || parsed.password) {
    throw new Error("Untrusted Xiaomi base URL");
  }
  return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, "");
}

/**
 * POST /api/oauth/xiaomi-mimo/api-key
 * Import a Xiaomi MiMo API key manually (or from auto-import).
 * The key is validated against the models endpoint, then stored.
 *
 * Body: { apiKey, uid?, baseUrl? }
 */
export async function POST(request) {
  try {
    const { apiKey, uid, baseUrl, mimoPassToken, mimoUserId, mimoCUserId } = await request.json();

    if (!apiKey || typeof apiKey !== "string" || !apiKey.trim()) {
      return NextResponse.json(
        { error: "API key is required" },
        { status: 400 },
      );
    }

    const key = apiKey.trim();
    if (!key.startsWith("sk-")) {
      return NextResponse.json(
        { error: "Invalid key format — expected sk- prefix" },
        { status: 400 },
      );
    }

    let effectiveBaseUrl;
    try {
      effectiveBaseUrl = normalizeXiaomiBaseUrl(baseUrl);
    } catch (error) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    // Validate the key against the configured Xiaomi models endpoint. The
    // allowlist above prevents forwarding the bearer key to arbitrary hosts;
    // fetchPublic also validates DNS and any redirect target.
    let validated = false;
    let modelCount = 0;
    try {
      const resp = await fetchPublic(`${effectiveBaseUrl}/models`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${key}`,
          "X-Mimo-Source": "mimocode-cli",
        },
        signal: AbortSignal.timeout(10000),
      });
      if (resp.ok) {
        const data = await resp.json();
        modelCount = Array.isArray(data?.data) ? data.data.length : 0;
        validated = true;
      }
    } catch {
      // Network error — still allow import (key may be valid but network blocked)
    }

    if (!validated) {
      // Soft-fail: store the key but mark as untested
      console.log("[xiaomi-mimo] key validation failed, storing as untested");
    }

    // Dedup: if a connection with the same uid or same key already exists, update it
    const { getProviderConnections, updateProviderConnection } = await import("@/models");
    const existing = (await getProviderConnections()).find(
      (c) => c.provider === "xiaomi-mimo" && (
        (uid && c.email === `${uid}@xiaomi`) ||
        c.accessToken === key
      ),
    );
    if (existing) {
      const updated = await updateProviderConnection(existing.id, {
        accessToken: key,
        providerSpecificData: {
          ...existing.providerSpecificData,
          uid: uid || existing.providerSpecificData?.uid || null,
          baseUrl: effectiveBaseUrl,
          // Per-account session credential — enables multi-account rotation.
          mimoPassToken: mimoPassToken || existing.providerSpecificData?.mimoPassToken || null,
          mimoUserId: mimoUserId || existing.providerSpecificData?.mimoUserId || null,
          mimoCUserId: mimoCUserId || existing.providerSpecificData?.mimoCUserId || null,
          modelCount,
        },
        testStatus: validated ? "active" : existing.testStatus,
      });
      return NextResponse.json({
        success: true,
        validated,
        modelCount,
        updated: true,
        connection: {
          id: existing.id,
          provider: existing.provider,
          email: existing.email,
          displayName: existing.displayName,
        },
      });
    }

    const connection = await createProviderConnection({
      provider: "xiaomi-mimo",
      authType: "api_key",
      accessToken: key,
      refreshToken: null,
      // API keys don't expire on a fixed schedule; use a long horizon
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      email: uid ? `${uid}@xiaomi` : null,
      displayName: uid ? `Xiaomi ${uid}` : "Xiaomi MiMo",
      providerSpecificData: {
        uid: uid || null,
        baseUrl: effectiveBaseUrl,
        authMethod: "api_key",
        provider: "API Key",
        modelCount,
        // Per-account session credential — enables multi-account rotation.
        mimoPassToken: mimoPassToken || null,
        mimoUserId: mimoUserId || null,
        mimoCUserId: mimoCUserId || null,
      },
      testStatus: validated ? "active" : "untested",
    });

    return NextResponse.json({
      success: true,
      validated,
      modelCount,
      connection: {
        id: connection.id,
        provider: connection.provider,
        email: connection.email,
        displayName: connection.displayName,
      },
    });
  } catch (error) {
    console.log("Xiaomi MiMo API key import error:", error);
    return NextResponse.json(
      { error: "API key import failed" },
      { status: 500 },
    );
  }
}
