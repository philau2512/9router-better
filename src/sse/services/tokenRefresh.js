// Re-export from open-sse with local logger
import * as log from "../utils/logger.js";
import {
  getProviderConnections,
  getProviderConnectionById,
  updateProviderConnection,
} from "../../lib/localDb.js";
import {
  getProjectIdForConnection,
  invalidateProjectId,
  removeConnection,
} from "open-sse/services/projectId.js";
import {
  TOKEN_EXPIRY_BUFFER_MS as BUFFER_MS,
  refreshAccessToken as _refreshAccessToken,
  refreshClaudeOAuthToken as _refreshClaudeOAuthToken,
  refreshGoogleToken as _refreshGoogleToken,
  refreshCodexToken as _refreshCodexToken,
  refreshIflowToken as _refreshIflowToken,
  refreshGitHubToken as _refreshGitHubToken,
  refreshCopilotToken as _refreshCopilotToken,
  getAccessToken as _getAccessToken,
  refreshTokenByProvider as _refreshTokenByProvider,
  formatProviderCredentials as _formatProviderCredentials,
  getAllAccessTokens as _getAllAccessTokens,
  refreshKiroToken as _refreshKiroToken,
  getRefreshLeadMs as _getRefreshLeadMs,
  isUnrecoverableRefreshError,
} from "open-sse/services/tokenRefresh.js";
import { refreshQwenToken as _refreshQwenToken } from "open-sse/services/refresh-providers.js";
import { CODEX_AUTO_REFRESH } from "open-sse/config/appConstants.js";
import {
  refreshProviderCredentials as _refreshProviderCredentials,
  shouldRefreshCredentials as _shouldRefreshCredentials,
} from "open-sse/services/oauthCredentialManager.js";

export const TOKEN_EXPIRY_BUFFER_MS = BUFFER_MS;

// ─── Re-exports wrapped with local logger ─────────────────────────────────────

export const refreshAccessToken = (provider, refreshToken, credentials) =>
  _refreshAccessToken(provider, refreshToken, credentials, log);

export const refreshClaudeOAuthToken = (refreshToken) =>
  _refreshClaudeOAuthToken(refreshToken, log);

export const refreshGoogleToken = (refreshToken, clientId, clientSecret) =>
  _refreshGoogleToken(refreshToken, clientId, clientSecret, log);

export const refreshQwenToken = (refreshToken) =>
  _refreshQwenToken(refreshToken, log);

export const refreshCodexToken = (refreshToken) =>
  _refreshCodexToken(refreshToken, log);

export const refreshIflowToken = (refreshToken) =>
  _refreshIflowToken(refreshToken, log);

export const refreshGitHubToken = (refreshToken) =>
  _refreshGitHubToken(refreshToken, log);

export const refreshCopilotToken = (githubAccessToken) =>
  _refreshCopilotToken(githubAccessToken, log);

export const refreshKiroToken = (refreshToken, providerSpecificData) =>
  _refreshKiroToken(refreshToken, providerSpecificData, log);

export const getAccessToken = (provider, credentials) =>
  _getAccessToken(provider, credentials, log);

export const refreshTokenByProvider = (provider, credentials) =>
  _refreshTokenByProvider(provider, credentials, log);

export const formatProviderCredentials = (provider, credentials) =>
  _formatProviderCredentials(provider, credentials, log);

export const getAllAccessTokens = (userInfo) =>
  _getAllAccessTokens(userInfo, log);

export const shouldRefreshCredentials = (provider, credentials) =>
  _shouldRefreshCredentials(provider, credentials);

// ─── Lifecycle hook ───────────────────────────────────────────────────────────

/**
 * Call this when a connection is fully closed / removed.
 * Aborts any in-flight projectId fetch and evicts its cache entry,
 * preventing the module-level Maps from accumulating stale entries.
 *
 * @param {string} connectionId
 */
export function releaseConnection(connectionId) {
  if (!connectionId) return;
  removeConnection(connectionId);
  log.debug("TOKEN_REFRESH", "Released connection resources", { connectionId });
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Compute an ISO expiry timestamp from a relative expiresIn (seconds).
 * @param {number} expiresIn
 * @returns {string}
 */
function toExpiresAt(expiresIn) {
  return new Date(Date.now() + expiresIn * 1000).toISOString();
}

function normalizeExpiresAt(expiresAt) {
  if (!expiresAt) return null;
  const date = new Date(expiresAt);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toISOString();
}

/**
 * Providers that carry a real Google project ID.
 * @param {string} provider
 * @returns {boolean}
 */
function needsProjectId(provider) {
  return provider === "antigravity" || provider === "gemini-cli";
}

/**
 * Non-blocking: fetch the project ID for a connection after a token refresh and
 * persist it to localDb.  Invalidates the stale cached value first so the fetch
 * always retrieves a fresh one.
 *
 * @param {string} provider
 * @param {string} connectionId
 * @param {string} accessToken
 */
function _refreshProjectId(provider, connectionId, accessToken) {
  if (!needsProjectId(provider) || !connectionId || !accessToken) return;

  // Evict stale cached value; the next runtime request will resolve it lazily.
  invalidateProjectId(connectionId);

  // Lazy resolution: avoid triggering onboardUser for every account during a
  // background token refresh. Runtime handlers resolve project IDs on demand.
  if (process.env.EAGER_PROJECT_ID_REFRESH === "true") {
    getProjectIdForConnection(connectionId, accessToken, provider)
      .then((projectId) => {
        if (!projectId) return;
        updateProviderCredentials(connectionId, { projectId }).catch((err) => {
          log.debug("TOKEN_REFRESH", "Failed to persist refreshed projectId", {
            connectionId,
            error: err?.message ?? err,
          });
        });
      })
      .catch((err) => {
        log.debug("TOKEN_REFRESH", "Failed to fetch projectId after token refresh", {
          connectionId,
          error: err?.message ?? err,
        });
      });
  }
}

// ─── Local-specific: persist credentials to localDb ──────────────────────────

/**
 * Persist updated credentials for a connection to localDb.
 * Only fields that are present in `newCredentials` are written.
 *
 * @param {string} connectionId
 * @param {object} newCredentials
 * @returns {Promise<boolean>}
 */
export async function updateProviderCredentials(connectionId, newCredentials) {
  try {
    const updates = {};

    if (newCredentials.accessToken)
      updates.accessToken = newCredentials.accessToken;
    if (newCredentials.refreshToken)
      updates.refreshToken = newCredentials.refreshToken;
    if (newCredentials.idToken) updates.idToken = newCredentials.idToken;
    if (newCredentials.lastRefreshAt)
      updates.lastRefreshAt = newCredentials.lastRefreshAt;
    if (newCredentials.expiresAt) updates.expiresAt = newCredentials.expiresAt;
    if (newCredentials.expiresIn) {
      updates.expiresAt = toExpiresAt(newCredentials.expiresIn);
      updates.expiresIn = newCredentials.expiresIn;
    } else if (newCredentials.expiresAt) {
      const expiresAt = normalizeExpiresAt(newCredentials.expiresAt);
      if (expiresAt) {
        updates.expiresAt = expiresAt;
        updates.expiresIn = Math.max(
          1,
          Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000),
        );
      }
    }
    if (newCredentials.providerSpecificData) {
      updates.providerSpecificData = {
        ...(newCredentials.existingProviderSpecificData || {}),
        ...newCredentials.providerSpecificData,
      };
    }
    if (newCredentials.copilotToken || newCredentials.copilotTokenExpiresAt) {
      updates.providerSpecificData = {
        ...(updates.providerSpecificData ||
          newCredentials.existingProviderSpecificData ||
          {}),
        ...(newCredentials.copilotToken
          ? { copilotToken: newCredentials.copilotToken }
          : {}),
        ...(newCredentials.copilotTokenExpiresAt
          ? { copilotTokenExpiresAt: newCredentials.copilotTokenExpiresAt }
          : {}),
      };
    }
    if (newCredentials.projectId) updates.projectId = newCredentials.projectId;
    if (newCredentials.testStatus !== undefined)
      updates.testStatus = newCredentials.testStatus;
    if (newCredentials.errorCode !== undefined)
      updates.errorCode = newCredentials.errorCode;
    if (newCredentials.lastError !== undefined)
      updates.lastError = newCredentials.lastError;
    if (newCredentials.lastErrorAt !== undefined)
      updates.lastErrorAt = newCredentials.lastErrorAt;

    const account =
      newCredentials.connectionName ||
      newCredentials.displayName ||
      newCredentials.name ||
      newCredentials.email ||
      null;
    const email = newCredentials.email || null;

    const result = await updateProviderConnection(connectionId, updates);
    log.info("TOKEN_REFRESH", "Credentials updated in localDb", {
      connectionId,
      ...(account ? { account: String(account) } : {}),
      ...(email ? { email: String(email) } : {}),
      success: !!result,
    });
    return !!result;
  } catch (error) {
    log.error("TOKEN_REFRESH", "Error updating credentials in localDb", {
      connectionId,
      ...(newCredentials?.connectionName || newCredentials?.name || newCredentials?.email
        ? {
            account: String(
              newCredentials.connectionName ||
                newCredentials.name ||
                newCredentials.email,
            ),
          }
        : {}),
      ...(newCredentials?.email ? { email: String(newCredentials.email) } : {}),
      error: error.message,
    });
    return false;
  }
}

// ─── Local-specific: proactive token refresh ─────────────────────────────────

/**
 * Check whether the provider token (and, for GitHub, the Copilot token) is
 * about to expire and refresh it proactively.
 *
 * @param {string} provider
 * @param {object} credentials
 * @param {{ force?: boolean }} [options] force=true skips the on-request lead check
 * @returns {Promise<object>} updated credentials object
 */
export async function checkAndRefreshToken(provider, credentials, options = {}) {
  const connectionId = credentials?.connectionId || credentials?.id || null;
  let creds = { ...credentials, ...(connectionId ? { connectionId } : {}) };

  // Adopt latest DB tokens: OpenAI rotates the refresh token on every refresh, and
  // refreshing with a stale snapshot (reuse) revokes the whole session → account logout.
  if (creds.connectionId) {
    const latest = await getProviderConnectionById(creds.connectionId).catch(() => null);
    const latestRefreshMs = Date.parse(latest?.lastRefreshAt || "");
    const credsRefreshMs = Date.parse(creds.lastRefreshAt || "");
    const dbIsNewer = Number.isFinite(latestRefreshMs)
      && (!Number.isFinite(credsRefreshMs) || latestRefreshMs > credsRefreshMs);
    if (dbIsNewer && latest.refreshToken && latest.refreshToken !== creds.refreshToken) {
      creds = {
        ...creds,
        refreshToken: latest.refreshToken,
        accessToken: latest.accessToken || creds.accessToken,
        expiresAt: latest.expiresAt || latest.tokenExpiresAt || creds.expiresAt,
        lastRefreshAt: latest.lastRefreshAt || creds.lastRefreshAt,
      };
    }
  }

  const force = options?.force === true;

  // ── 1. Regular access-token expiry ────────────────────────────────────────
  if (force || _shouldRefreshCredentials(provider, creds)) {
    const expiresAt = creds.expiresAt
      ? new Date(creds.expiresAt).getTime()
      : null;
    const remaining = expiresAt ? expiresAt - Date.now() : null;
    const refreshLead = _getRefreshLeadMs(provider);

    log.info("TOKEN_REFRESH", "Refreshing provider credentials proactively", {
      provider,
      account:
        creds.connectionName ||
        creds.displayName ||
        creds.name ||
        creds.email ||
        (creds.connectionId ? String(creds.connectionId) : null),
      ...(creds.email ? { email: String(creds.email) } : {}),
      ...(creds.connectionId
        ? { connectionId: String(creds.connectionId) }
        : {}),
      expiresIn: remaining === null ? null : Math.round(remaining / 1000),
      refreshLeadMs: refreshLead,
      lastRefreshAt: creds.lastRefreshAt || null,
    });

    const newCreds = await _refreshProviderCredentials(provider, creds, log);
    if (provider === "codex" && isCodexReauthRequired(newCreds)) {
      await updateProviderCredentials(creds.connectionId, {
        testStatus: getCodexRefreshFailureStatus(newCreds),
        errorCode: getCodexRefreshFailureCode(newCreds),
        lastError: "Refresh token invalid or already used. Re-auth required.",
        lastErrorAt: new Date().toISOString(),
        connectionId: creds.connectionId,
        connectionName: creds.connectionName,
        name: creds.name,
        email: creds.email,
        displayName: creds.displayName,
      });
    } else if (newCreds?.accessToken || newCreds?.apiKey || newCreds?.copilotToken) {
      const mergedCreds = {
        ...newCreds,
        existingProviderSpecificData: creds.providerSpecificData,
        // Log-only identity for "Credentials updated in localDb"
        connectionId: creds.connectionId,
        connectionName: creds.connectionName,
        name: creds.name,
        email: creds.email,
        displayName: creds.displayName,
      };

      // Persist to DB (non-blocking path continues below)
      await updateProviderCredentials(creds.connectionId, mergedCreds);

      creds = {
        ...creds,
        ...newCreds,
        expiresAt: newCreds.expiresIn
          ? toExpiresAt(newCreds.expiresIn)
          : normalizeExpiresAt(newCreds.expiresAt) ||
            newCreds.expiresAt ||
            creds.expiresAt,
        providerSpecificData: newCreds.providerSpecificData
          ? { ...creds.providerSpecificData, ...newCreds.providerSpecificData }
          : creds.providerSpecificData,
      };

      // Non-blocking: refresh projectId with the new access token
      _refreshProjectId(provider, creds.connectionId, creds.accessToken);
    }
  }

  // ── 2. GitHub Copilot token expiry ────────────────────────────────────────
  if (
    provider === "github" &&
    creds.providerSpecificData?.copilotTokenExpiresAt
  ) {
    const copilotExpiresAt =
      creds.providerSpecificData.copilotTokenExpiresAt * 1000;
    const now = Date.now();
    const remaining = copilotExpiresAt - now;

    if (remaining < TOKEN_EXPIRY_BUFFER_MS) {
      log.info(
        "TOKEN_REFRESH",
        "Copilot token expiring soon, refreshing proactively",
        {
          provider,
          expiresIn: Math.round(remaining / 1000),
        },
      );

      const copilotToken = await refreshCopilotToken(creds.accessToken);
      if (copilotToken) {
        const updatedSpecific = {
          ...creds.providerSpecificData,
          copilotToken: copilotToken.token,
          copilotTokenExpiresAt: copilotToken.expiresAt,
        };

        await updateProviderCredentials(creds.connectionId, {
          providerSpecificData: updatedSpecific,
        });

        creds.providerSpecificData = updatedSpecific;
        creds.copilotToken = copilotToken.token;
      }
    }
  }

  return creds;
}

// ─── Local-specific: combined GitHub + Copilot refresh ───────────────────────

/**
 * Refresh the GitHub OAuth token and immediately exchange it for a fresh
 * Copilot token.
 *
 * @param {object} credentials  – must contain `refreshToken`
 * @returns {Promise<object|null>} merged credentials or the raw GitHub credentials on Copilot failure
 */
export async function refreshGitHubAndCopilotTokens(credentials) {
  const newGitHubCreds = await refreshGitHubToken(credentials.refreshToken);
  if (!newGitHubCreds?.accessToken) return newGitHubCreds;

  const copilotToken = await refreshCopilotToken(newGitHubCreds.accessToken);
  if (!copilotToken) return newGitHubCreds;

  return {
    ...newGitHubCreds,
    providerSpecificData: {
      copilotToken: copilotToken.token,
      copilotTokenExpiresAt: copilotToken.expiresAt,
    },
  };
}

const codexConnectionRefreshLocks = new Map();
export const CODEX_PROACTIVE_REFRESH_LEAD_MS = CODEX_AUTO_REFRESH.leadMs;

function hasCodexRefreshCredentials(result) {
  return Boolean(result?.accessToken);
}

function isCodexReauthRequired(result) {
  return isUnrecoverableRefreshError(result);
}

function getCodexRefreshFailureStatus(result) {
  return isCodexReauthRequired(result) ? "401" : "error";
}

function getCodexRefreshFailureCode(result) {
  return result?.status ? String(result.status) : result?.code || null;
}

async function refreshCodexWithRetry(credentials) {
  for (let attempt = 1; attempt <= CODEX_AUTO_REFRESH.maxAttempts; attempt++) {
    let result = null;

    try {
      result = await getAccessToken("codex", credentials, log);
    } catch (error) {
      log.warn("TOKEN_REFRESH", "Codex refresh attempt failed", {
        attempt,
        maxAttempts: CODEX_AUTO_REFRESH.maxAttempts,
        error: error.message,
      });
    }

    if (hasCodexRefreshCredentials(result) || isUnrecoverableRefreshError(result)) {
      return result;
    }

    if (attempt < CODEX_AUTO_REFRESH.maxAttempts) {
      const delayMs = attempt * CODEX_AUTO_REFRESH.retryDelayMs;
      log.warn("TOKEN_REFRESH", "Retrying Codex refresh after temporary failure", {
        attempt,
        maxAttempts: CODEX_AUTO_REFRESH.maxAttempts,
        delayMs,
      });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  log.error("TOKEN_REFRESH", "Codex refresh failed after all retry attempts", {
    maxAttempts: CODEX_AUTO_REFRESH.maxAttempts,
  });
  return null;
}

export async function refreshCodexConnection(connection, options = {}) {
  if (!connection || connection.provider !== "codex") {
    return { ok: false, error: "Unsupported provider" };
  }

  if (!connection.id) {
    return { ok: false, error: "Missing connection id" };
  }

  if (codexConnectionRefreshLocks.has(connection.id)) {
    return codexConnectionRefreshLocks.get(connection.id);
  }

  const refreshPromise = (async () => {
    const freshConnection = await getProviderConnectionById(connection.id);
    if (!freshConnection) {
      return { ok: false, error: "Connection not found" };
    }

    // Pass name/email so TOKEN_REFRESH logs (success + refresh_token_reused) show account.
    const accountMeta = {
      connectionId: freshConnection.id,
      connectionName:
        freshConnection.displayName ||
        freshConnection.name ||
        freshConnection.email ||
        null,
      name: freshConnection.name || null,
      email: freshConnection.email || null,
      displayName: freshConnection.displayName || null,
    };

    const result = await refreshCodexWithRetry({
      refreshToken: freshConnection.refreshToken,
      providerSpecificData: freshConnection.providerSpecificData,
      ...accountMeta,
    });

    if (!result?.accessToken) {
      const unrecoverable = isCodexReauthRequired(result);
      const errorMessage = unrecoverable
        ? "Refresh token invalid or already used. Re-auth required."
        : "Failed to refresh Codex token";

      if (unrecoverable) {
        await updateProviderCredentials(connection.id, {
          testStatus: getCodexRefreshFailureStatus(result),
          errorCode: getCodexRefreshFailureCode(result),
          lastError: errorMessage,
          lastErrorAt: new Date().toISOString(),
          ...accountMeta,
        });
      }

      return {
        ok: false,
        error: errorMessage,
        unrecoverable,
      };
    }

    const mergedProviderSpecificData = {
      ...(freshConnection.providerSpecificData || {}),
      ...(result.providerSpecificData || {}),
    };

    await updateProviderCredentials(connection.id, {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiresIn: result.expiresIn,
      expiresAt: result.expiresAt,
      providerSpecificData: mergedProviderSpecificData,
      existingProviderSpecificData: freshConnection.providerSpecificData,
      testStatus: "active",
      errorCode: null,
      lastError: null,
      lastErrorAt: null,
      // Log-only identity (not persisted as credential fields)
      ...accountMeta,
    });

    return {
      ok: true,
      connectionId: connection.id,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken || freshConnection.refreshToken,
      expiresIn: result.expiresIn,
      expiresAt:
        result.expiresAt ||
        (result.expiresIn ? toExpiresAt(result.expiresIn) : null),
      providerSpecificData: mergedProviderSpecificData,
    };
  })().finally(() => {
    codexConnectionRefreshLocks.delete(connection.id);
  });

  codexConnectionRefreshLocks.set(connection.id, refreshPromise);
  return refreshPromise;
}

export async function refreshSelectedCodexConnections(connections) {
  const selected = Array.isArray(connections)
    ? connections.filter((connection) => connection?.provider === "codex")
    : [];
  const results = [];

  for (const connection of selected) {
    try {
      const result = await refreshCodexConnection(connection);
      results.push({
        connectionId: connection.id,
        ok: !!result?.ok,
        error: result?.error || null,
        expiresAt: result?.expiresAt || null,
      });
    } catch (error) {
      results.push({
        connectionId: connection.id,
        ok: false,
        error: error.message,
        expiresAt: null,
      });
    }
  }

  return results;
}

export function isCodexAutoRefreshCandidate(
  connection,
  now = Date.now(),
  leadMs = CODEX_PROACTIVE_REFRESH_LEAD_MS,
) {
  if (!connection || connection.provider !== "codex") return false;
  if (connection.providerSpecificData?.autoRefreshEnabled !== true)
    return false;
  if (!connection.refreshToken) return false;
  if (!connection.expiresAt) return false;

  const expiresAtMs = new Date(connection.expiresAt).getTime();
  if (!Number.isFinite(expiresAtMs)) return false;
  return expiresAtMs <= now + leadMs;
}

export async function runCodexProactiveRefreshCheckpoint(options = {}) {
  const leadMs = options.leadMs ?? CODEX_PROACTIVE_REFRESH_LEAD_MS;
  const now = Date.now();
  const connections = await getProviderConnections();
  const candidates = (connections || []).filter((connection) =>
    isCodexAutoRefreshCandidate(connection, now, leadMs),
  );

  if (candidates.length === 0) {
    log.info("TOKEN_REFRESH", "Codex proactive checkpoint skipped", {
      reason: "no_candidates",
    });
    return { total: 0, refreshed: 0, failed: 0 };
  }

  const results = await refreshSelectedCodexConnections(candidates);
  const refreshed = results.filter((result) => result.ok).length;
  const failed = results.filter((result) => !result.ok).length;

  log.info("TOKEN_REFRESH", "Codex proactive checkpoint finished", {
    total: results.length,
    refreshed,
    failed,
  });

  return { total: results.length, refreshed, failed, results };
}

export function getCodexProactiveRefreshIntervalMs() {
  return 15 * 60 * 1000;
}

export async function startCodexProactiveRefreshTick() {
  try {
    return await runCodexProactiveRefreshCheckpoint({
      leadMs: CODEX_PROACTIVE_REFRESH_LEAD_MS,
    });
  } catch (error) {
    log.error("TOKEN_REFRESH", "Codex proactive checkpoint failed", {
      error: error.message,
    });
    return { total: 0, refreshed: 0, failed: 1, error: error.message };
  }
}

export { codexConnectionRefreshLocks };
