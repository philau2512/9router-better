// Ensure proxyFetch is loaded to patch globalThis.fetch
import "open-sse/index.js";

import {
  getProviderConnectionById,
  updateProviderConnection,
} from "@/lib/localDb";
import { getUsageForProvider } from "open-sse/services/usage.js";
import { getCodexRateLimitResetCredits } from "open-sse/services/usage/codex.js";
import { getExecutor } from "open-sse/executors/index.js";
import {
  refreshProviderCredentials,
  shouldRefreshCredentialsForUsage,
} from "open-sse/services/oauthCredentialManager.js";
import { isUnrecoverableRefreshError } from "open-sse/services/tokenRefresh.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { USAGE_APIKEY_PROVIDERS } from "@/shared/constants/providers";

// Detect auth-expired messages returned by usage providers instead of throwing
const AUTH_EXPIRED_PATTERNS = [
  "expired",
  "authentication",
  "unauthorized",
  "401",
  "re-authorize",
];
function isAuthExpiredMessage(usage) {
  if (!usage?.message) return false;
  const msg = usage.message.toLowerCase();
  return AUTH_EXPIRED_PATTERNS.some((p) => msg.includes(p));
}

function buildCredentialsFromConnection(connection) {
  return {
    accessToken: connection.accessToken,
    refreshToken: connection.refreshToken,
    idToken: connection.idToken,
    expiresAt: connection.expiresAt || connection.tokenExpiresAt,
    lastRefreshAt: connection.lastRefreshAt,
    connectionId: connection.id,
    // Account label for TOKEN_REFRESH logs (name / email)
    connectionName:
      connection.displayName || connection.name || connection.email || null,
    name: connection.name || null,
    email: connection.email || null,
    displayName: connection.displayName || null,
    providerSpecificData: connection.providerSpecificData,
    // For GitHub
    copilotToken: connection.providerSpecificData?.copilotToken,
    copilotTokenExpiresAt:
      connection.providerSpecificData?.copilotTokenExpiresAt,
  };
}

/**
 * Refresh OAuth credentials the same way chat does (oauthCredentialManager),
 * then persist to localDb. GitHub still uses its executor for Copilot token.
 *
 * @param {boolean} force - Skip needsRefresh check and always attempt refresh
 * @returns Promise<{ connection, refreshed: boolean }>
 */
export async function refreshAndUpdateCredentials(
  connection,
  force = false,
  proxyOptions = null,
) {
  // Re-read latest tokens: OpenAI rotates the refresh token on every refresh, and
  // refreshing with a stale snapshot (reuse) revokes the whole session → account logout.
  const latest = connection.id ? await getProviderConnectionById(connection.id) : null;
  if (latest) connection = latest;

  const provider = connection.provider;
  const credentials = buildCredentialsFromConnection(connection);
  // GitHub needs specialized Copilot exchange; other OAuth providers use the
  // shared manager so aliases like `xai` (no dedicated executor) still refresh.
  const useExecutorPath = provider === "github";
  const executor = useExecutorPath ? getExecutor(provider) : null;

  // Usage/quota must not use chat proactive leads (Codex 5d) or 8d lastRefresh
  // stale rotation — those rotate single-use refresh tokens on every quota poll.
  // GitHub still uses executor.needsRefresh (Copilot token window).
  const needsRefresh =
    force ||
    (useExecutorPath
      ? executor.needsRefresh(credentials)
      : shouldRefreshCredentialsForUsage(provider, credentials));

  if (!needsRefresh) {
    return { connection, refreshed: false };
  }

  let refreshResult = null;
  if (useExecutorPath) {
    refreshResult = await executor.refreshCredentials(
      credentials,
      console,
      proxyOptions,
    );
  } else {
    refreshResult = await refreshProviderCredentials(
      provider,
      credentials,
      console,
    );
    if (isUnrecoverableRefreshError(refreshResult)) {
      throw new Error(
        "Failed to refresh credentials. Please re-authorize the connection.",
      );
    }
  }

  if (!refreshResult?.accessToken && !refreshResult?.apiKey && !refreshResult?.copilotToken) {
    // Refresh failed but we still have an accessToken — try with existing token
    if (connection.accessToken) {
      return { connection, refreshed: false };
    }
    throw new Error(
      "Failed to refresh credentials. Please re-authorize the connection.",
    );
  }

  // Build update object
  const now = new Date().toISOString();
  const updateData = {
    updatedAt: now,
  };

  // Update accessToken if present
  if (refreshResult.accessToken) {
    updateData.accessToken = refreshResult.accessToken;
  }

  // Update refreshToken if present
  if (refreshResult.refreshToken) {
    updateData.refreshToken = refreshResult.refreshToken;
  }

  if (refreshResult.idToken) {
    updateData.idToken = refreshResult.idToken;
  }

  if (refreshResult.lastRefreshAt) {
    updateData.lastRefreshAt = refreshResult.lastRefreshAt;
  }

  // Update token expiry
  if (refreshResult.expiresIn) {
    updateData.expiresAt = new Date(
      Date.now() + refreshResult.expiresIn * 1000,
    ).toISOString();
    updateData.expiresIn = refreshResult.expiresIn;
  } else if (refreshResult.expiresAt) {
    updateData.expiresAt = refreshResult.expiresAt;
  }

  // Handle provider-specific data (copilotToken for GitHub, etc.)
  const providerSpecificUpdates = {
    ...(refreshResult.providerSpecificData || {}),
    ...(refreshResult.copilotToken
      ? { copilotToken: refreshResult.copilotToken }
      : {}),
    ...(refreshResult.copilotTokenExpiresAt
      ? { copilotTokenExpiresAt: refreshResult.copilotTokenExpiresAt }
      : {}),
  };
  if (Object.keys(providerSpecificUpdates).length > 0) {
    updateData.providerSpecificData = {
      ...(connection.providerSpecificData || {}),
      ...providerSpecificUpdates,
    };
  }

  // Update database
  await updateProviderConnection(connection.id, updateData);

  // Return updated connection
  const updatedConnection = {
    ...connection,
    ...updateData,
    providerSpecificData:
      updateData.providerSpecificData || connection.providerSpecificData,
  };

  return {
    connection: updatedConnection,
    refreshed: true,
  };
}

/**
 * GET /api/usage/[connectionId] - Get usage data for a specific connection
 */
export async function GET(request, { params }) {
  let connection;
  try {
    const { connectionId } = await params;
    const force = new URL(request.url).searchParams.get("force") === "1";

    // Get connection from database
    connection = await getProviderConnectionById(connectionId);
    if (!connection) {
      return Response.json({ error: "Connection not found" }, { status: 404 });
    }

    // Allow OAuth connections, plus whitelisted apikey providers (glm/minimax/kiro/...)
    // Kiro headless flow persists authType "api_key" (underscore); generic
    // providers use "apikey" — accept both spellings.
    const isOAuth = connection.authType === "oauth";
    const isApikeyAuth =
      connection.authType === "apikey" || connection.authType === "api_key";
    const isApikeyEligible =
      isApikeyAuth && USAGE_APIKEY_PROVIDERS.includes(connection.provider);

    const isAccessTokenEligible =
      connection.authType === "access_token" && connection.provider === "codex";

    if (!isOAuth && !isApikeyEligible && !isAccessTokenEligible) {
      return Response.json({
        message: "Usage not available for this connection",
      });
    }

    // Resolve connection proxy config; force strictProxy=false so quota/refresh fall back to direct on failure
    const proxyConfig = await resolveConnectionProxyConfig(
      connection.providerSpecificData,
    );
    const proxyOptions = {
      connectionProxyEnabled: proxyConfig.connectionProxyEnabled === true,
      connectionProxyUrl: proxyConfig.connectionProxyUrl || "",
      connectionNoProxy: proxyConfig.connectionNoProxy || "",
      vercelRelayUrl: proxyConfig.vercelRelayUrl || "",
      strictProxy: false,
    };

    // Refresh credentials only for OAuth connections (apikey/access_token have no token refresh)
    if (isOAuth) {
      try {
        const result = await refreshAndUpdateCredentials(
          connection,
          false,
          proxyOptions,
        );
        connection = result.connection;
      } catch (refreshError) {
        console.error("[Usage API] Credential refresh failed:", refreshError);
        return Response.json(
          {
            error: `Credential refresh failed: ${refreshError.message}`,
          },
          { status: 401 },
        );
      }
    }

    // Fetch usage from provider API
    let usage = await getUsageForProvider(connection, proxyOptions, { force });

    // If provider returned an auth-expired message instead of throwing,
    // force-refresh token and retry once (OAuth only)
    if (isOAuth && isAuthExpiredMessage(usage) && connection.refreshToken) {
      try {
        const retryResult = await refreshAndUpdateCredentials(
          connection,
          true,
          proxyOptions,
        );
        connection = retryResult.connection;
        usage = await getUsageForProvider(connection, proxyOptions, { force });
      } catch (retryError) {
        console.warn(
          `[Usage] ${connection.provider}: force refresh failed: ${retryError.message}`,
        );
      }
    }

    if (connection.provider === "codex" && connection.accessToken) {
      try {
        usage = {
          ...usage,
          resetCredits: await getCodexRateLimitResetCredits(
            connection.accessToken,
            proxyOptions,
            connection.providerSpecificData,
          ),
        };
      } catch (error) {
        console.warn(`[Usage] codex reset-credit inventory unavailable: ${error.message}`);
      }
    }

    return Response.json(usage);
  } catch (error) {
    const provider = connection?.provider ?? "unknown";
    console.warn(`[Usage] ${provider}: ${error.message}`);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
