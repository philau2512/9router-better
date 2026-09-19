import {
  ERROR_RULES,
  BACKOFF_CONFIG,
  TRANSIENT_COOLDOWN_MS,
  SOFT_RATE_LIMIT_THRESHOLD_MS,
  SOFT_RETRY_WAIT_CAP_MS,
  MAX_SOFT_RETRY,
  parseRetryAfter,
} from "../config/errorConfig.js";
import {
  upsertCooldown,
  clearCooldown,
} from "@/lib/db/repos/usage/cooldown.js";

/**
 * Classify a 429 into one of three kinds (learned from CLIProxyAPI's
 * classifyAntigravity429 / xaiStatusErr):
 *   - "quotaExhausted": hard exhaustion (RESOURCE_EXHAUSTED / QUOTA_EXHAUSTED /
 *     free-usage-exhausted). Long cooldown + fallback to another account.
 *   - "softRateLimit": transient throttle with a short reset window
 *     (<= SOFT_RATE_LIMIT_THRESHOLD_MS). Retry the SAME auth after a brief wait.
 *   - "rateLimited": everything else 429. Existing exponential backoff + fallback.
 * @param {number} status
 * @param {{ message?: string, body?: any, headers?: Headers|object, resetsAtMs?: number }} info
 * @returns {{ kind: "quotaExhausted"|"softRateLimit"|"rateLimited", retryAfterMs: number|null }}
 */
export function classify429(status, info = {}) {
  const text = (info.message || "").toString().toLowerCase();

  // Hard exhaustion signals → never retry same auth; cooldown + fallback.
  if (
    text.includes("resource_exhausted") ||
    text.includes("quota_exhausted") ||
    text.includes("free-usage-exhausted") ||
    text.includes("free usage") ||
    text.includes("spending-limit") ||
    text.includes("usage_limit_reached")
  ) {
    return { kind: "quotaExhausted", retryAfterMs: parseRetryAfter(info) };
  }

  const retryAfterMs = parseRetryAfter(info);
  // A short, known reset window is a soft throttle → retry same auth.
  if (
    retryAfterMs != null &&
    retryAfterMs >= 0 &&
    retryAfterMs <= SOFT_RATE_LIMIT_THRESHOLD_MS
  ) {
    return { kind: "softRateLimit", retryAfterMs };
  }

  return { kind: "rateLimited", retryAfterMs };
}

/**
 * Decide whether a 429 should be retried on the SAME auth (instant-retry) or
 * fall back to another account. Owner of the retry policy; the caller only
 * executes the returned action.
 * @param {number} status
 * @param {object} info - same shape as classify429 info
 * @param {number} retryCount - how many soft-retries already attempted this request
 * @returns {{ action: "retry-same-auth", waitMs: number } | { action: "fallback" }}
 */
export function decideSoftRetry(status, info = {}, retryCount = 0) {
  if (status !== 429) return { action: "fallback" };
  const { kind, retryAfterMs } = classify429(status, info);
  if (kind === "softRateLimit" && retryCount < MAX_SOFT_RETRY) {
    const waitMs = Math.min(
      Math.max(0, retryAfterMs ?? 0),
      SOFT_RETRY_WAIT_CAP_MS,
    );
    return { action: "retry-same-auth", waitMs };
  }
  return { action: "fallback" };
}

/**
 * Calculate exponential backoff cooldown for rate limits (429)
 * Level 1: 1s, Level 2: 2s, Level 3: 4s... → max 4 min
 * @param {number} backoffLevel - Current backoff level
 * @returns {number} Cooldown in milliseconds
 */
export function getQuotaCooldown(backoffLevel = 0) {
  const level = Math.max(0, backoffLevel - 1);
  const cooldown = BACKOFF_CONFIG.base * Math.pow(2, level);
  return Math.min(cooldown, BACKOFF_CONFIG.max);
}

/**
 * Check if error should trigger account fallback (switch to next account)
 * Config-driven: matches ERROR_RULES top-to-bottom (text rules first, then status)
 * @param {number} status - HTTP status code
 * @param {string} errorText - Error message text
 * @param {number} backoffLevel - Current backoff level for exponential backoff
 * @returns {{ shouldFallback: boolean, cooldownMs: number, newBackoffLevel?: number }}
 */
export function checkFallbackError(status, errorText, backoffLevel = 0) {
  const lowerError = errorText
    ? (typeof errorText === "string"
        ? errorText
        : JSON.stringify(errorText)
      ).toLowerCase()
    : "";

  // Client closed the request (nginx-style 499 / AbortError). Not a provider
  // fault — do not lock modelLock_* or rotate accounts/combo models.
  if (
    status === 499 ||
    lowerError.includes("request aborted") ||
    lowerError.includes("client disconnected") ||
    lowerError.includes("the user aborted a request")
  ) {
    return { shouldFallback: false, cooldownMs: 0 };
  }

  if (
    lowerError.includes("model is not supported") ||
    lowerError.includes("invalid model id") ||
    lowerError.includes("invalid_model_id") ||
    lowerError.includes(
      "encountered an unexpected error when processing the request",
    )
  ) {
    return { shouldFallback: false, cooldownMs: 0 };
  }

  for (const rule of ERROR_RULES) {
    // Text-based rule: match substring in error message
    if (rule.text && lowerError && lowerError.includes(rule.text)) {
      if (rule.backoff) {
        const newLevel = Math.min(backoffLevel + 1, BACKOFF_CONFIG.maxLevel);
        return {
          shouldFallback: true,
          cooldownMs: getQuotaCooldown(newLevel),
          newBackoffLevel: newLevel,
        };
      }
      return { shouldFallback: true, cooldownMs: rule.cooldownMs };
    }

    // Status-based rule: match HTTP status code
    if (rule.status && rule.status === status) {
      if (rule.backoff) {
        const newLevel = Math.min(backoffLevel + 1, BACKOFF_CONFIG.maxLevel);
        return {
          shouldFallback: true,
          cooldownMs: getQuotaCooldown(newLevel),
          newBackoffLevel: newLevel,
        };
      }
      return { shouldFallback: true, cooldownMs: rule.cooldownMs };
    }
  }

  // Request-scoped client errors that matched no rule above: a 400 caused by the
  // request itself (context overflow, malformed body, unsupported parameter) says
  // nothing about the credential, so cooling the account down only removes a
  // healthy connection from rotation. With a single connection it is worse: every
  // later request in the window fails with a copy of this very error
  // ("all 1 accounts locked for <model> | lastError=[400]: ..."), which hides the
  // real cause from the caller and makes unrelated sessions look like they hit the
  // same limit. Hand the upstream error back for this request instead.
  // Account-scoped statuses keep their rules above (401/402/403/404/429), and the
  // text rules still win for rate-limit / quota / capacity wording.
  if (status >= 400 && status < 500 && status !== 401 && status !== 402 && status !== 403 && status !== 429) {
    return { shouldFallback: false, cooldownMs: 0 };
  }

  // Default: transient cooldown for any unmatched error
  return { shouldFallback: true, cooldownMs: TRANSIENT_COOLDOWN_MS };
}

/**
 * Check if account is currently unavailable (cooldown not expired)
 */
export function isAccountUnavailable(unavailableUntil) {
  if (!unavailableUntil) return false;
  return new Date(unavailableUntil).getTime() > Date.now();
}

/**
 * Calculate unavailable until timestamp
 */
export function getUnavailableUntil(cooldownMs) {
  return new Date(Date.now() + cooldownMs).toISOString();
}

/**
 * Get the earliest rateLimitedUntil from a list of accounts
 * @param {Array} accounts - Array of account objects with rateLimitedUntil
 * @returns {string|null} Earliest rateLimitedUntil ISO string, or null
 */
export function getEarliestRateLimitedUntil(accounts) {
  let earliest = null;
  const now = Date.now();
  for (const acc of accounts) {
    if (!acc.rateLimitedUntil) continue;
    const until = new Date(acc.rateLimitedUntil).getTime();
    if (until <= now) continue;
    if (!earliest || until < earliest) earliest = until;
  }
  if (!earliest) return null;
  return new Date(earliest).toISOString();
}

/**
 * Format rateLimitedUntil to human-readable "reset after Xm Ys"
 * @param {string} rateLimitedUntil - ISO timestamp
 * @returns {string} e.g. "reset after 2m 30s"
 */
export function formatRetryAfter(rateLimitedUntil) {
  if (!rateLimitedUntil) return "";
  const diffMs = new Date(rateLimitedUntil).getTime() - Date.now();
  if (diffMs <= 0) return "reset after 0s";
  const totalSec = Math.ceil(diffMs / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const parts = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (s > 0 || parts.length === 0) parts.push(`${s}s`);
  return `reset after ${parts.join(" ")}`;
}

/** Prefix for model lock flat fields on connection record */
export const MODEL_LOCK_PREFIX = "modelLock_";

/** Special key used when no model is known (account-level lock) */
export const MODEL_LOCK_ALL = `${MODEL_LOCK_PREFIX}__all`;

/** Build the flat field key for a model lock */
export function getModelLockKey(model) {
  return model ? `${MODEL_LOCK_PREFIX}${model}` : MODEL_LOCK_ALL;
}

/**
 * Check if a model lock on a connection is still active.
 * Reads flat field `modelLock_${model}` (or `modelLock___all` when model=null).
 */
export function isModelLockActive(connection, model) {
  const key = getModelLockKey(model);
  const expiry = connection[key] || connection[MODEL_LOCK_ALL];
  if (!expiry) return false;
  return new Date(expiry).getTime() > Date.now();
}

/**
 * Get earliest active model lock expiry across all modelLock_* fields.
 * Used for UI cooldown display.
 */
export function getEarliestModelLockUntil(connection) {
  if (!connection) return null;
  let earliest = null;
  const now = Date.now();
  for (const [key, val] of Object.entries(connection)) {
    if (!key.startsWith(MODEL_LOCK_PREFIX) || !val) continue;
    const t = new Date(val).getTime();
    if (t <= now) continue;
    if (!earliest || t < earliest) earliest = t;
  }
  return earliest ? new Date(earliest).toISOString() : null;
}

/**
 * Build update object to set a model lock on a connection.
 */
export function buildModelLockUpdate(model, cooldownMs) {
  const key = getModelLockKey(model);
  return { [key]: new Date(Date.now() + cooldownMs).toISOString() };
}

/**
 * Build update object to clear all model locks on a connection.
 */
export function buildClearModelLocksUpdate(connection) {
  const cleared = {};
  for (const key of Object.keys(connection)) {
    if (key.startsWith(MODEL_LOCK_PREFIX)) cleared[key] = null;
  }
  return cleared;
}

/**
 * Filter available accounts (not in cooldown)
 */
export function filterAvailableAccounts(accounts, excludeId = null) {
  const now = Date.now();
  return accounts.filter((acc) => {
    if (excludeId && acc.id === excludeId) return false;
    if (acc.rateLimitedUntil) {
      const until = new Date(acc.rateLimitedUntil).getTime();
      if (until > now) return false;
    }
    return true;
  });
}

/**
 * Reset account state when request succeeds
 * Clears cooldown and resets backoff level to 0
 * @param {object} account - Account object
 * @returns {object} Updated account with reset state
 */
export function resetAccountState(account) {
  if (!account) return account;
  return {
    ...account,
    rateLimitedUntil: null,
    backoffLevel: 0,
    lastError: null,
    status: "active",
  };
}

/**
 * Apply error state to account
 * @param {object} account - Account object
 * @param {number} status - HTTP status code
 * @param {string} errorText - Error message
 * @returns {object} Updated account with error state
 */
export function applyErrorState(account, status, errorText) {
  if (!account) return account;

  const backoffLevel = account.backoffLevel || 0;
  const { cooldownMs, newBackoffLevel } = checkFallbackError(
    status,
    errorText,
    backoffLevel,
  );

  const nextAccount = {
    ...account,
    rateLimitedUntil: cooldownMs > 0 ? getUnavailableUntil(cooldownMs) : null,
    backoffLevel: newBackoffLevel ?? backoffLevel,
    lastError: {
      status,
      message: errorText,
      timestamp: new Date().toISOString(),
    },
    status: "error",
  };
  // Persist cooldown state so it survives server restart
  if (cooldownMs > 0 && account.provider && (account.id || account.email)) {
    const authId =
      account.id ||
      account.email ||
      account.accessToken?.slice(-12) ||
      "unknown";
    setImmediate(() =>
      upsertCooldown({
        provider: account.provider,
        authId,
        model: "",
        nextRetryAfter: Date.now() + cooldownMs,
        reason: errorText?.toString?.()?.slice(0, 200),
        status: String(status),
      }).catch(() => {}),
    );
  }
  return nextAccount;
}
