import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("DNS Cache SWR (Stale-While-Revalidate)", () => {
  let mockResolve4;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();

    // 1. Mock dns module supporting promises.Resolver and default export before any import
    mockResolve4 = vi.fn().mockResolvedValue(["1.1.1.1"]);
    const mockLookup = vi.fn((hostname, cb) => cb(null, "172.217.115.4"));
    vi.doMock("dns", () => {
      const mockDns = {
        lookup: (hostname, options, callback) => {
          const cb = typeof options === "function" ? options : callback;
          mockLookup(hostname, cb);
        },
        Resolver: class {
          setServers() {}
          resolve4(hostname, callback) {
            mockResolve4(hostname)
              .then((ips) => callback(null, ips))
              .catch((err) => callback(err));
          }
        },
        promises: {
          Resolver: class {
            setServers() {}
            async resolve4(hostname) {
              return await mockResolve4(hostname);
            }
          },
        },
      };
      return {
        ...mockDns,
        default: mockDns,
      };
    });

    // 2. Clear DNS_CACHE singleton to isolate tests
    const { DNS_CACHE } = await import("open-sse/utils/dns-resolver.js");
    DNS_CACHE.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("performs synchronous resolve on cache miss and caches the result", async () => {
    const { resolveRealIP } = await import("open-sse/utils/dns-resolver.js");

    const ip = await resolveRealIP("api.opencode.ai");
    expect(ip).toBe("1.1.1.1");
    expect(mockResolve4).toHaveBeenCalledOnce();
  });

  it("returns cached IP instantly on cache hit without re-resolving", async () => {
    const { resolveRealIP } = await import("open-sse/utils/dns-resolver.js");

    // 1st call - Cache miss
    await resolveRealIP("api.opencode.ai");
    mockResolve4.mockClear();

    // 2nd call - Cache hit
    const ip = await resolveRealIP("api.opencode.ai");
    expect(ip).toBe("1.1.1.1");
    expect(mockResolve4).not.toHaveBeenCalled();
  });

  it("triggers background refresh when cache is stale (30s before expiry) but returns old IP instantly", async () => {
    const { resolveRealIP, DNS_CACHE } =
      await import("open-sse/utils/dns-resolver.js");
    const { MEMORY_CONFIG } = await import("open-sse/config/runtimeConfig.js");

    // 1st call - Cache miss
    await resolveRealIP("api.opencode.ai");
    mockResolve4.mockClear();

    // Advance time to stale state (leaves 20 seconds of TTL)
    const staleTime = MEMORY_CONFIG.dnsCacheTtlMs - 20000;
    vi.advanceTimersByTime(staleTime);

    // Mock next DNS resolve to return a new IP
    mockResolve4.mockResolvedValue(["2.2.2.2"]);

    // 2nd call - Cache is stale.
    const ip = await resolveRealIP("api.opencode.ai");
    expect(ip).toBe("1.1.1.1");

    // Wait for background promise microtasks to resolve
    await vi.runAllTicks();

    expect(mockResolve4).toHaveBeenCalledOnce();

    // Next call should now get the refreshed IP "2.2.2.2"
    const freshIp = await resolveRealIP("api.opencode.ai");
    expect(freshIp).toBe("2.2.2.2");
  });

  it("does not trigger multiple background refreshes concurrently (race protection)", async () => {
    const { resolveRealIP } = await import("open-sse/utils/dns-resolver.js");
    const { MEMORY_CONFIG } = await import("open-sse/config/runtimeConfig.js");

    // 1st call - Cache miss
    await resolveRealIP("api.opencode.ai");
    mockResolve4.mockClear();

    // Advance time to stale state
    const staleTime = MEMORY_CONFIG.dnsCacheTtlMs - 20000;
    vi.advanceTimersByTime(staleTime);

    // Make multiple concurrent calls
    const results = await Promise.all([
      resolveRealIP("api.opencode.ai"),
      resolveRealIP("api.opencode.ai"),
      resolveRealIP("api.opencode.ai"),
    ]);

    // All should return the old IP instantly
    expect(results).toEqual(["1.1.1.1", "1.1.1.1", "1.1.1.1"]);

    // Wait for background promise microtasks to resolve
    await vi.runAllTicks();

    // Only exactly ONE DNS resolve should be triggered
    expect(mockResolve4).toHaveBeenCalledOnce();
  });

  it("retains old IP if background refresh fails", async () => {
    const { resolveRealIP } = await import("open-sse/utils/dns-resolver.js");
    const { MEMORY_CONFIG } = await import("open-sse/config/runtimeConfig.js");

    // 1st call - Cache miss
    await resolveRealIP("api.opencode.ai");
    mockResolve4.mockClear();

    // Advance time to stale state
    const staleTime = MEMORY_CONFIG.dnsCacheTtlMs - 20000;
    vi.advanceTimersByTime(staleTime);

    // Mock next DNS resolve to fail
    mockResolve4.mockRejectedValue(new Error("DNS query timeout"));

    // 2nd call - triggers refresh which will fail in background
    const ip = await resolveRealIP("api.opencode.ai");
    expect(ip).toBe("1.1.1.1"); // old IP returned

    await vi.runAllTicks();

    // 3rd call - should still return the old IP ("1.1.1.1") since refresh failed and cache was not evicted/cleared
    const postFailIp = await resolveRealIP("api.opencode.ai");
    expect(postFailIp).toBe("1.1.1.1");
  });

  it("shouldBypassMitmDns returns false when target host resolves to a public IP", async () => {
    const { shouldBypassMitmDns } = await import("open-sse/utils/dns-resolver.js");
    const result = await shouldBypassMitmDns("https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent");
    expect(result).toBe(false);
  });

  it("shouldBypassMitmDns returns true when target host is spoofed to loopback", async () => {
    const dns = await import("dns");
    vi.spyOn(dns.default, "lookup").mockImplementation((hostname, options, callback) => {
      const cb = typeof options === "function" ? options : callback;
      cb(null, "127.0.0.1", 4);
    });

    const { shouldBypassMitmDns } = await import("open-sse/utils/dns-resolver.js");
    const result = await shouldBypassMitmDns("https://daily-cloudcode-pa.googleapis.com:443/v1internal:generateContent");
    expect(result).toBe(true);
  });
});
