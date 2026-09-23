import dns from "dns";
import { MEMORY_CONFIG } from "../config/runtimeConfig.js";
import { dbg } from "./debugLog.js";

// DNS cache — use Map to avoid prototype pollution via malformed hostnames
export const DNS_CACHE = new Map();

export const GOOGLE_DNS_SERVERS = ["8.8.8.8", "8.8.4.4"];

const MITM_BYPASS_HOSTS = [
  "cloudcode-pa.googleapis.com",
  "daily-cloudcode-pa.googleapis.com",
  "daily-cloudcode-pa.sandbox.googleapis.com",
  "sandbox.googleapis.com",
  "api.individual.githubcopilot.com",
  "q.us-east-1.amazonaws.com",
  "codewhisperer.us-east-1.amazonaws.com",
  "api2.cursor.sh",
];

/**
 * Helper to perform actual DNS resolution and update the cache
 */
export async function performDnsResolve(hostname) {
  try {
    const resolver = new dns.promises.Resolver();
    resolver.setServers(GOOGLE_DNS_SERVERS);
    const addresses = await resolver.resolve4(hostname);
    const ip = addresses[0];
    DNS_CACHE.set(hostname, {
      ip,
      expiry: Date.now() + MEMORY_CONFIG.dnsCacheTtlMs,
      refreshing: false,
    });
    return ip;
  } catch (error) {
    console.warn(
      `[ProxyFetch] DNS resolve failed for ${hostname}:`,
      error.message,
    );
    const existing = DNS_CACHE.get(hostname);
    if (existing) {
      existing.refreshing = false;
      return existing.ip;
    }
    return null;
  }
}

/**
 * Resolve real IP using Google DNS (bypass system DNS) with SWR (Stale-While-Revalidate) caching
 */
export async function resolveRealIP(hostname) {
  const cached = DNS_CACHE.get(hostname);
  const now = Date.now();

  if (cached) {
    // 1. Cache has expired completely -> Force synchronous resolve
    if (now >= cached.expiry) {
      return await performDnsResolve(hostname);
    }

    // 2. Cache is close to expiry (within last 30s) and not already refreshing -> Trigger background resolve
    const refreshThresholdMs = 30 * 1000;
    if (now >= cached.expiry - refreshThresholdMs && !cached.refreshing) {
      cached.refreshing = true;
      performDnsResolve(hostname)
        .then(() => {
          dbg("DNS", `Background DNS refresh succeeded for ${hostname}`);
        })
        .catch((err) => {
          dbg(
            "DNS",
            `Background DNS refresh failed for ${hostname}: ${err.message}`,
          );
        });
    }

    // 3. Return cached IP instantly (0ms delay)
    return cached.ip;
  }

  // 4. Cache miss -> Synchronous resolve first time
  return await performDnsResolve(hostname);
}

/**
 * Check if request should bypass MITM DNS redirect
 */
export function shouldBypassMitmDns(url) {
  try {
    const hostname = new URL(url).hostname;
    return MITM_BYPASS_HOSTS.some((host) => hostname.includes(host));
  } catch {
    return false;
  }
}

/**
 * Pre-resolve DNS for a list of hostnames using Google DNS.
 * Fire-and-forget — does not block startup.
 * @param {string[]} hostnames
 */
export async function warmupDnsCache(hostnames) {
  if (!Array.isArray(hostnames) || hostnames.length === 0) return;
  const results = await Promise.allSettled(
    hostnames.map((h) => performDnsResolve(h)),
  );
  const ok = results.filter((r) => r.status === "fulfilled" && r.value).length;
  console.log(`[WARMUP] Pre-resolved ${ok}/${hostnames.length} DNS entries`);
}
