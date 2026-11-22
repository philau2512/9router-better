import { PROVIDERS } from "../config/providers.js";
import {
  refreshAccessToken,
  refreshClaudeOAuthToken,
  refreshGoogleToken,
  refreshQwenToken,
  refreshCodexToken,
  refreshKiroToken,
  refreshIflowToken,
  refreshGitHubToken,
  refreshCopilotToken,
  refreshXaiToken,
  refreshCodebuddyToken,
} from "./refresh-providers.js";
import {
  refreshClineToken,
  refreshCodebuddyIntlToken,
  refreshTraeToken,
  refreshZedToken,
  refreshWindsurfToken,
  refreshMiniMaxCodeToken,
  refreshNousToken,
} from "./tokenRefresh/providers.js";
import { parseVertexSaJson, refreshVertexToken } from "./refresh-vertex.js";

/**
 * Human-readable account label for TOKEN_REFRESH logs (name / email / short id).
 * @param {object|null|undefined} credentials
 * @returns {string|null}
 */
export function resolveRefreshAccountLabel(credentials) {
  if (!credentials || typeof credentials !== "object") return null;
  const fromCreds =
    credentials.connectionName ||
    credentials.displayName ||
    credentials.name ||
    credentials.email ||
    credentials.providerSpecificData?.email ||
    credentials.providerSpecificData?.name ||
    credentials.providerSpecificData?.displayName ||
    null;
  if (fromCreds) return String(fromCreds);
  // Some paths pass a raw connection row (id + name) without connectionId/connectionName.
  if (credentials.id && (credentials.name || credentials.email)) {
    return String(credentials.name || credentials.email);
  }
  const id = credentials.connectionId || credentials.id || null;
  if (id) return String(id).slice(0, 8);
  return null;
}

/**
 * Wrap a logger so TOKEN_REFRESH entries include which connection/account.
 * Other tags pass through unchanged.
 * @param {object|null|undefined} credentials
 * @param {object|null|undefined} log
 */
export function withRefreshAccountLog(credentials, log) {
  if (!log) return log;
  const account = resolveRefreshAccountLabel(credentials);
  const emailRaw =
    credentials?.email ||
    credentials?.providerSpecificData?.email ||
    null;
  const email = emailRaw ? String(emailRaw) : null;
  const rawId = credentials?.connectionId || credentials?.id || null;
  // Full id in logs — short slice is hard to match against localDb rows.
  const connectionId = rawId ? String(rawId) : null;
  if (!account && !email && !connectionId) return log;

  const identity = {
    ...(account ? { account } : {}),
    ...(email ? { email } : {}),
    ...(connectionId ? { connectionId } : {}),
  };

  const inject = (data) => {
    if (data == null) {
      return { ...identity };
    }
    if (typeof data !== "object" || Array.isArray(data)) {
      return {
        detail: data,
        ...identity,
      };
    }
    return {
      ...data,
      ...(account && data.account == null ? { account } : {}),
      ...(email && data.email == null ? { email } : {}),
      ...(connectionId && data.connectionId == null ? { connectionId } : {}),
    };
  };

  const wrap =
    (fn) =>
    (tag, message, data) => {
      if (typeof fn !== "function") return;
      if (tag === "TOKEN_REFRESH") {
        return fn(tag, message, inject(data));
      }
      return fn(tag, message, data);
    };

  return {
    ...log,
    debug: wrap(log.debug?.bind?.(log) ?? log.debug),
    info: wrap(log.info?.bind?.(log) ?? log.info),
    warn: wrap(log.warn?.bind?.(log) ?? log.warn),
    error: wrap(log.error?.bind?.(log) ?? log.error),
  };
}

/**
 * Get access token for a specific provider (with in-flight dedup).
 * If a refresh is already in-flight for same provider+token, share the promise
 * to prevent parallel OAuth requests → Auth0 'refresh_token_reused' family revoke.
 */
export async function getAccessToken(provider, credentials, log) {
  if (
    !credentials ||
    !credentials.refreshToken ||
    typeof credentials.refreshToken !== "string"
  ) {
    log?.warn?.(
      "TOKEN_REFRESH",
      `No valid refresh token available for provider: ${provider}`,
    );
    return null;
  }
  // Dedup is handled inside each refreshXxxToken function
  return _getAccessTokenInternal(
    provider,
    credentials,
    withRefreshAccountLog(credentials, log),
  );
}

async function _getAccessTokenInternal(provider, credentials, log) {
  switch (provider) {
    case "gemini":
    case "gemini-cli":
    case "antigravity":
      return await refreshGoogleToken(
        credentials.refreshToken,
        PROVIDERS[provider].clientId,
        PROVIDERS[provider].clientSecret,
        log,
      );

    case "claude":
      return await refreshClaudeOAuthToken(credentials.refreshToken, log);

    case "codex":
      return await refreshCodexToken(credentials.refreshToken, log);

    case "qwen":
      return await refreshQwenToken(credentials.refreshToken, log);

    case "iflow":
      return await refreshIflowToken(credentials.refreshToken, log);

    case "github":
      return await refreshGitHubToken(credentials.refreshToken, log);

    case "kiro":
      return await refreshKiroToken(
        credentials.refreshToken,
        credentials.providerSpecificData,
        log,
      );

    case "xai":
      return await refreshXaiToken(credentials.refreshToken, log);

    // Grok CLI shares xAI token endpoint. See upstream a11937cdd.
    case "grok-cli":
    case "gcli":
      return await refreshXaiToken(credentials.refreshToken, log);

    case "codebuddy-cn":
      return await refreshCodebuddyToken(credentials.refreshToken, log);

    case "codebuddy-intl":
      return await refreshCodebuddyIntlToken(credentials.refreshToken, log);

    case "trae":
      return await refreshTraeToken(credentials.refreshToken, credentials, log);

    case "zed":
      return await refreshZedToken();

    case "windsurf":
      return await refreshWindsurfToken(credentials, log);

    case "vertex":
    case "vertex-partner": {
      const saJson = parseVertexSaJson(credentials.apiKey);
      if (!saJson) return null;
      return await refreshVertexToken(saJson, log);
    }

    default:
      log?.warn?.(
        "TOKEN_REFRESH",
        `Unsupported provider for token refresh: ${provider}`,
      );
      return null;
  }
}

/**
 * Refresh token by provider type (helper for handlers)
 */
export async function refreshTokenByProvider(provider, credentials, log) {
  if (!credentials.refreshToken) return null;
  const refreshLog = withRefreshAccountLog(credentials, log);

  switch (provider) {
    case "gemini-cli":
    case "antigravity":
      return refreshGoogleToken(
        credentials.refreshToken,
        PROVIDERS[provider].clientId,
        PROVIDERS[provider].clientSecret,
        refreshLog,
      );
    case "claude":
      return refreshClaudeOAuthToken(credentials.refreshToken, refreshLog);
    case "codex":
      return refreshCodexToken(credentials.refreshToken, refreshLog);
    case "qwen":
      return refreshQwenToken(credentials.refreshToken, refreshLog);
    case "iflow":
      return refreshIflowToken(credentials.refreshToken, refreshLog);
    case "github":
      return refreshGitHubToken(credentials.refreshToken, refreshLog);
    case "kiro":
      return refreshKiroToken(
        credentials.refreshToken,
        credentials.providerSpecificData,
        refreshLog,
      );
    case "xai":
      return refreshXaiToken(credentials.refreshToken, refreshLog);
    case "grok-cli":
    case "gcli":
      // Grok CLI shares xAI token endpoint. See upstream a11937cdd.
      return refreshXaiToken(credentials.refreshToken, refreshLog);
    case "codebuddy-cn":
      return refreshCodebuddyToken(credentials.refreshToken, refreshLog);
    case "codebuddy-intl":
      return refreshCodebuddyIntlToken(credentials.refreshToken, refreshLog);
    case "cline":
      return refreshClineToken(credentials.refreshToken, refreshLog);
    case "trae":
      return refreshTraeToken(credentials.refreshToken, credentials, refreshLog);
    case "zed":
      return refreshZedToken();
    case "windsurf":
      return refreshWindsurfToken(credentials, refreshLog);
    case "minimax-code":
    case "minimax-code-global":
      return refreshMiniMaxCodeToken(provider, credentials.refreshToken, refreshLog);
    case "nous":
      return refreshNousToken(credentials.refreshToken, refreshLog);
    case "vertex":
    case "vertex-partner": {
      const saJson = parseVertexSaJson(credentials.apiKey);
      if (!saJson) return null;
      return refreshVertexToken(saJson, refreshLog);
    }
    default:
      return refreshAccessToken(
        provider,
        credentials.refreshToken,
        credentials,
        refreshLog,
      );
  }
}

/**
 * Format credentials for provider
 */
export function formatProviderCredentials(provider, credentials, log) {
  const config = PROVIDERS[provider];
  if (!config) {
    log?.warn?.(
      "TOKEN_REFRESH",
      `No configuration found for provider: ${provider}`,
    );
    return null;
  }

  switch (provider) {
    case "gemini":
      return {
        apiKey: credentials.apiKey,
        accessToken: credentials.accessToken,
        projectId: credentials.projectId,
      };

    case "claude":
      return {
        apiKey: credentials.apiKey,
        accessToken: credentials.accessToken,
      };

    case "codex":
    case "qwen":
    case "iflow":
    case "openai":
    case "openrouter":
    case "xai":
    case "grok-cli":
    case "gcli":
      return {
        apiKey: credentials.apiKey,
        accessToken: credentials.accessToken,
      };

    case "antigravity":
    case "gemini-cli":
      return {
        accessToken: credentials.accessToken,
        refreshToken: credentials.refreshToken,
        projectId: credentials.projectId,
      };

    default:
      return {
        apiKey: credentials.apiKey,
        accessToken: credentials.accessToken,
        refreshToken: credentials.refreshToken,
      };
  }
}

/**
 * Get all access tokens for a user
 */
export async function getAllAccessTokens(userInfo, log) {
  const results = {};

  if (userInfo.connections && Array.isArray(userInfo.connections)) {
    for (const connection of userInfo.connections) {
      if (connection.isActive && connection.provider) {
        const token = await getAccessToken(
          connection.provider,
          {
            refreshToken: connection.refreshToken,
          },
          log,
        );

        if (token) {
          results[connection.provider] = token;
        }
      }
    }
  }

  return results;
}

/**
 * Refresh token with retry and exponential backoff
 * Retries on failure with increasing delay: 1s, 2s, 3s...
 * @param {function} refreshFn - Async function that returns token or null
 * @param {number} maxRetries - Max retry attempts (default 3)
 * @param {object} log - Logger instance (optional)
 * @returns {Promise<object|null>} Token result or null if all retries fail
 */
export async function refreshWithRetry(refreshFn, maxRetries = 3, log = null) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (attempt > 0) {
      const delay = attempt * 1000;
      log?.debug?.(
        "TOKEN_REFRESH",
        `Retry ${attempt}/${maxRetries} after ${delay}ms`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }

    try {
      const result = await refreshFn();
      if (result) return result;
    } catch (error) {
      log?.warn?.(
        "TOKEN_REFRESH",
        `Attempt ${attempt + 1}/${maxRetries} failed: ${error.message}`,
      );
    }
  }

  log?.error?.("TOKEN_REFRESH", `All ${maxRetries} retry attempts failed`);
  return null;
}
