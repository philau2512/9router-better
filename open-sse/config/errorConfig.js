// OpenAI-compatible error types mapping (client-facing)
export const ERROR_TYPES = {
  400: { type: "invalid_request_error", code: "bad_request" },
  401: { type: "authentication_error", code: "invalid_api_key" },
  402: { type: "billing_error", code: "payment_required" },
  403: { type: "permission_error", code: "insufficient_quota" },
  404: { type: "invalid_request_error", code: "model_not_found" },
  406: { type: "invalid_request_error", code: "model_not_supported" },
  429: { type: "rate_limit_error", code: "rate_limit_exceeded" },
  500: { type: "server_error", code: "internal_server_error" },
  502: { type: "server_error", code: "bad_gateway" },
  503: { type: "server_error", code: "service_unavailable" },
  504: { type: "server_error", code: "gateway_timeout" },
};

// Default error messages per status code (client-facing)
export const DEFAULT_ERROR_MESSAGES = {
  400: "Bad request",
  401: "Invalid API key provided",
  402: "Payment required",
  403: "You exceeded your current quota",
  404: "Model not found",
  406: "Model not supported",
  429: "Rate limit exceeded",
  500: "Internal server error",
  502: "Bad gateway - upstream provider error",
  503: "Service temporarily unavailable",
  504: "Gateway timeout",
};

// Exponential backoff config for rate limits
export const BACKOFF_CONFIG = {
  base: 2000,
  max: 5 * 60 * 1000,
  maxLevel: 15,
};

// Default cooldown for transient/unknown errors
export const TRANSIENT_COOLDOWN_MS = 30 * 1000;

// Hard cap for provider-reported rate limit cooldown (e.g. codex/antigravity quota reset can be 3-6h)
export const MAX_RATE_LIMIT_COOLDOWN_MS = 30 * 60 * 1000;

// Soft-rate-limit tuning (Phase 2: instant-retry-same-auth).
// A 429 whose reset window is within THRESHOLD is treated as a brief hiccup:
// retry the SAME auth after a short capped wait instead of cooling it down and
// rotating to another account (avoids needless account churn). Longer windows
// (quota exhausted, multi-hour resets) fall back to another account as before.
export const SOFT_RATE_LIMIT_THRESHOLD_MS = 5000; // <= 5s → retry same auth
export const SOFT_RETRY_WAIT_CAP_MS = 1500; // never hold a request longer than this per retry
export const MAX_SOFT_RETRY = 2; // max instant retries before falling back

/**
 * Parse a retry-after / quota-reset hint into milliseconds from now.
 * Tries, in order:
 *   1. `resetsAtMs` absolute epoch (already extracted by executor.parseError)
 *   2. HTTP `Retry-After` header (delta-seconds or HTTP-date)
 *   3. Body fields: quotaResetDelay / quotaResetTimeStamp / retryAfter
 *   4. Free-text duration in the message: "reset after 1h43m56s", "479ms", "3s"
 * Returns milliseconds (>=0) or null when nothing parseable is found.
 * @param {{ body?: any, headers?: Headers|object, message?: string, resetsAtMs?: number }} src
 */
export function parseRetryAfter(src = {}) {
  const now = Date.now();
  const { body, headers, message, resetsAtMs } = src;

  // 1. Absolute epoch already resolved upstream.
  if (typeof resetsAtMs === "number" && Number.isFinite(resetsAtMs)) {
    return Math.max(0, resetsAtMs - now);
  }

  // 2. Retry-After header (seconds or HTTP-date).
  const getHeader = (h, name) => {
    if (!h) return null;
    if (typeof h.get === "function") return h.get(name);
    return h[name] ?? h[name.toLowerCase()] ?? null;
  };
  const ra = getHeader(headers, "Retry-After");
  if (ra != null && String(ra).trim() !== "") {
    const raStr = String(ra).trim();
    if (/^\d+$/.test(raStr)) return Math.max(0, Number(raStr) * 1000);
    const asDate = Date.parse(raStr);
    if (Number.isFinite(asDate)) return Math.max(0, asDate - now);
  }

  // 3. Structured body fields.
  const b = body && typeof body === "object" ? body : null;
  if (b) {
    const delay = b.quotaResetDelay ?? b.retryAfter ?? b.retry_after;
    if (typeof delay === "number" && Number.isFinite(delay)) {
      // Heuristic: values < 1000 are usually seconds, larger are ms.
      return delay < 1000 ? delay * 1000 : delay;
    }
    if (typeof delay === "string") {
      const parsedDelay = parseDurationText(delay);
      if (parsedDelay != null) return parsedDelay;
    }
    const ts = b.quotaResetTimeStamp ?? b.resetsAt ?? b.reset;
    if (ts != null) {
      const t = typeof ts === "number" ? ts : Date.parse(String(ts));
      if (Number.isFinite(t)) return Math.max(0, t - now);
    }
  }

  // 4. Free-text duration inside the message.
  if (typeof message === "string" && message) {
    const parsedMsg = parseDurationText(message);
    if (parsedMsg != null) return parsedMsg;
  }

  return null;
}

/**
 * Extract a duration in ms from free text. Supports "1h43m56s", "479ms", "3s",
 * "2m30s". Returns ms or null if no duration token is found.
 */
export function parseDurationText(text) {
  if (typeof text !== "string" || !text) return null;
  // Milliseconds token takes precedence (e.g. "479ms").
  const msMatch = text.match(/(\d+(?:\.\d+)?)\s*ms\b/i);
  if (msMatch) return Math.round(Number(msMatch[1]));
  // Sum every h/m/s token found (e.g. "1h43m56s", "3s", "2m30s"). The \b after
  // the unit avoids matching the "m" in "ms" (handled above) and stray letters.
  const unitMatches = text.matchAll(/(\d+(?:\.\d+)?)\s*(h|m(?!s)|s)/gi);
  let totalMs = 0;
  let found = false;
  for (const m of unitMatches) {
    const value = Number(m[1]);
    const unit = m[2].toLowerCase();
    const factor = unit === "h" ? 3600000 : unit === "m" ? 60000 : 1000;
    totalMs += value * factor;
    found = true;
  }
  return found && totalMs > 0 ? Math.round(totalMs) : null;
}

// Cooldown durations (ms)
const COOLDOWN = {
  long: 2 * 60 * 1000,
  short: 5 * 1000,
};

/**
 * Unified error classification rules.
 * Checked top-to-bottom: text rules first (by order), then status rules.
 * Each rule: { text?, status?, cooldownMs?, backoff? }
 *   - text: substring match (case-insensitive) on error message
 *   - status: HTTP status code match
 *   - cooldownMs: fixed cooldown duration
 *   - backoff: true = use exponential backoff (rate limit)
 */
export const ERROR_RULES = [
  // --- Text-based rules (checked first, order = priority) ---
  { provider: "codex", text: "model is not supported when using codex with a chatgpt account", cooldownMs: MAX_RATE_LIMIT_COOLDOWN_MS },
  { text: "no credentials", cooldownMs: COOLDOWN.long },
  { text: "request not allowed", cooldownMs: COOLDOWN.short },
  { text: "improperly formed request", cooldownMs: COOLDOWN.long },
  { text: "rate limit", backoff: true },
  { text: "too many requests", backoff: true },
  { text: "quota exceeded", backoff: true },
  { text: "capacity", backoff: true },
  { text: "overloaded", backoff: true },

  // --- Status-based rules (fallback when text doesn't match) ---
  { status: 401, cooldownMs: COOLDOWN.long },
  { status: 402, cooldownMs: COOLDOWN.long },
  { status: 403, cooldownMs: COOLDOWN.long },
  { status: 404, cooldownMs: COOLDOWN.long },
  { status: 429, backoff: true },
];

// Backward compat: COOLDOWN_MS object (used by index.js re-export)
export const COOLDOWN_MS = {
  unauthorized: COOLDOWN.long,
  paymentRequired: COOLDOWN.long,
  notFound: COOLDOWN.long,
  transient: TRANSIENT_COOLDOWN_MS,
  requestNotAllowed: COOLDOWN.short,
};
