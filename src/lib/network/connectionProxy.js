import { getProxyPoolById } from "@/models";
import { getSettings } from "@/lib/localDb";

// Safely normalize any value into a trimmed string.
function normalizeString(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

/**
 * Normalize legacy proxy configuration.
 */
function normalizeLegacyProxy(providerSpecificData = {}) {
  const connectionProxyEnabled =
    providerSpecificData?.connectionProxyEnabled === true;

  const connectionProxyUrl = normalizeString(
    providerSpecificData?.connectionProxyUrl,
  );

  const connectionNoProxy = normalizeString(
    providerSpecificData?.connectionNoProxy,
  );

  return {
    connectionProxyEnabled,
    connectionProxyUrl,
    connectionNoProxy,
  };
}

/**
 * Resolve final proxy configuration.
 *
 * Priority:
 * 1. Proxy Pool
 * 2. Legacy Proxy
 * 3. No Proxy
 */
export async function resolveConnectionProxyConfig(providerSpecificData = {}, options = {}) {
  try {
    const settings = options.settings || await getSettings();
    const proxyHeadersTimeout =
      Number(settings?.connectionProxyHeadersTimeoutMs) || undefined;
    const proxyPoolIdRaw = normalizeString(providerSpecificData?.proxyPoolId);

    // "__none__" means explicitly disabled
    const proxyPoolId = proxyPoolIdRaw === "__none__" ? "" : proxyPoolIdRaw;

    const legacy = normalizeLegacyProxy(providerSpecificData);

    /**
     * -----------------------------
     * Proxy Pool Resolution
     * -----------------------------
     */
    if (proxyPoolId) {
      const proxyPool = await getProxyPoolById(proxyPoolId);

      const proxyUrl = normalizeString(proxyPool?.proxyUrl);
      const noProxy = normalizeString(proxyPool?.noProxy);

      const isValidPool = proxyPool && proxyPool.isActive === true && proxyUrl;

      if (isValidPool) {
        /**
         * Vercel/Cloudflare relay proxies use base URL rewriting
         * instead of HTTP_PROXY environment variables.
         */
        if (
          proxyPool.type === "vercel" ||
          proxyPool.type === "cloudflare" ||
          proxyPool.type === "deno" ||
          proxyPool.type === "netlify"
        ) {
          return {
            source: proxyPool.type,

            proxyPoolId,
            proxyPool,

            connectionProxyEnabled: false,
            connectionProxyUrl: "",
            connectionNoProxy: noProxy,

            strictProxy: proxyPool.strictProxy === true,

            vercelRelayUrl: proxyUrl, // Still mapped to vercelRelayUrl in the unified payload since they use the exact same header spec
            connectionProxyHeadersTimeoutMs: proxyHeadersTimeout,
          };
        }

        /**
         * Standard proxy pool
         */
        return {
          source: "pool",

          proxyPoolId,
          proxyPool,

          connectionProxyEnabled: true,
          connectionProxyUrl: proxyUrl,
          connectionNoProxy: noProxy,

          strictProxy: proxyPool.strictProxy === true,
          connectionProxyHeadersTimeoutMs: proxyHeadersTimeout,
        };
      }
    }

    /**
     * -----------------------------
     * Legacy Proxy Fallback
     * -----------------------------
     */
    if (legacy.connectionProxyEnabled && legacy.connectionProxyUrl) {
      return {
        source: "legacy",

        proxyPoolId: proxyPoolId || null,
        proxyPool: null,

        ...legacy,
        connectionProxyHeadersTimeoutMs: proxyHeadersTimeout,
      };
    }

    /**
     * -----------------------------
     * No Proxy Config
     * -----------------------------
     */
    return {
      source: "none",

      proxyPoolId: proxyPoolId || null,
      proxyPool: null,

      ...legacy,
      connectionProxyHeadersTimeoutMs: proxyHeadersTimeout,
    };
  } catch (error) {
    console.error(
      "[resolveConnectionProxyConfig] Failed to resolve proxy config:",
      error,
    );

    return {
      source: "error",

      proxyPoolId: null,
      proxyPool: null,

      connectionProxyEnabled: false,
      connectionProxyUrl: "",
      connectionNoProxy: "",

      strictProxy: false,
      connectionProxyHeadersTimeoutMs: undefined,
    };
  }
}

// In-memory round-robin counters keyed by providerId.
// Intentionally not persisted — resets on restart.
const _rrCounters = new Map();

/**
 * Pick a proxy pool ID from a list according to the given strategy.
 * @param {string[]} poolIds - Active pool IDs to rotate across
 * @param {"round-robin"|"random"} strategy
 * @param {string} providerId - Used as round-robin key
 * @returns {string} Selected pool ID
 */
export function pickProxyPoolId(poolIds, strategy, providerId) {
  if (!poolIds || poolIds.length === 0) return "";
  if (poolIds.length === 1) return poolIds[0];

  if (strategy === "random") {
    return poolIds[Math.floor(Math.random() * poolIds.length)];
  }

  // round-robin (default)
  const current = _rrCounters.get(providerId) || 0;
  const picked = poolIds[current % poolIds.length];
  _rrCounters.set(providerId, current + 1);
  return picked;
}
