import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const originalObservabilityEnabled = process.env.OBSERVABILITY_ENABLED;
const originalEnableSlowObservability = process.env.ENABLE_SLOW_REQUEST_OBSERVABILITY;
const originalSlowThreshold = process.env.SLOW_REQUEST_THRESHOLD_MS;

async function loadRepo() {
  vi.resetModules();
  return await import("../../src/lib/db/repos/requestDetailsRepo.js");
}

describe("slow request observability trap", () => {
  beforeEach(() => {
    process.env.OBSERVABILITY_ENABLED = "false";
    process.env.ENABLE_SLOW_REQUEST_OBSERVABILITY = "true";
    process.env.SLOW_REQUEST_THRESHOLD_MS = "30000";
  });

  afterEach(() => {
    process.env.OBSERVABILITY_ENABLED = originalObservabilityEnabled;
    process.env.ENABLE_SLOW_REQUEST_OBSERVABILITY = originalEnableSlowObservability;
    process.env.SLOW_REQUEST_THRESHOLD_MS = originalSlowThreshold;
  });

  it("identifies slow requests (>= 30s) as slow/error even when observability is off", async () => {
    const { __test__ } = await loadRepo();
    const { isSlowOrErrorRequest } = __test__;

    const fastSuccess = {
      latency: { total: 2100 },
      status: "success",
    };
    expect(isSlowOrErrorRequest(fastSuccess)).toBe(false);

    const slowSuccess = {
      latency: { total: 220820 },
      status: "success",
    };
    expect(isSlowOrErrorRequest(slowSuccess)).toBe(true);

    const errorRequest = {
      latency: { total: 94260 },
      status: "error",
      error: "Upstream timeout",
    };
    expect(isSlowOrErrorRequest(errorRequest)).toBe(true);
  });

  it("respects ENABLE_SLOW_REQUEST_OBSERVABILITY=false override", async () => {
    process.env.ENABLE_SLOW_REQUEST_OBSERVABILITY = "false";
    const { __test__ } = await loadRepo();
    const { isSlowOrErrorRequest } = __test__;

    const slowSuccess = {
      latency: { total: 220820 },
      status: "success",
    };
    expect(isSlowOrErrorRequest(slowSuccess)).toBe(false);
  });
});
