/**
 * Codex executor: verify remote image URLs are fetched and inlined as
 * base64 data URIs BEFORE the request body reaches the upstream API.
 *
 * Covers bug #575:
 *  - prefetchImages must await async image fetches
 *  - execute() must run prefetchImages before super.execute so the body
 *    sent to upstream contains base64 data, not remote URLs
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock DNS so the SSRF guard treats example.com as public.
// image.js resolves with { all: true } (DNS pinning, c7d07448) and expects an array.
vi.mock("node:dns/promises", () => ({
  lookup: async (_host, opts) => (opts?.all ? [{ address: "93.184.216.34", family: 4 }] : { address: "93.184.216.34", family: 4 }),
}));

import { CodexExecutor } from "../../open-sse/executors/codex.js";
import { fetchImageAsBase64 } from "../../open-sse/translator/concerns/image.js";
import * as proxyFetchModule from "../../open-sse/utils/proxyFetch.js";

const IMAGE_1MB_BYTES = 1024 * 1024;
const REMOTE_URL = "https://example.com/big.jpg";
const DATA_URI = "data:image/png;base64,iVBORw0KGgo=";

function makeImageBuffer(sizeBytes) {
  const buf = new Uint8Array(sizeBytes);
  buf.set([0xff, 0xd8, 0xff]);
  for (let i = 3; i < sizeBytes; i++) buf[i] = i & 0xff;
  return buf.buffer;
}

function mockImageFetch(sizeBytes, mimeType = "image/jpeg") {
  const bytes = new Uint8Array(makeImageBuffer(sizeBytes));
  return {
    ok: true,
    headers: { get: (k) => (k === "Content-Type" ? mimeType : null) },
    arrayBuffer: async () => makeImageBuffer(sizeBytes),
    body: {
      getReader() {
        let sent = false;
        return {
          read: async () =>
            sent
              ? { done: true, value: undefined }
              : ((sent = true), { done: false, value: bytes }),
          cancel: async () => {},
        };
      },
    },
  };
}

describe("CodexExecutor image handling", () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    // Default: example.com resolves to a public IP (SSRF guard passes)
    lookupMock.mockReset();
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("fetches 1MB remote image and inlines it as base64 data URI", async () => {
    global.fetch = vi.fn(async () => mockImageFetch(IMAGE_1MB_BYTES));

    const executor = new CodexExecutor();
    const body = {
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "describe this" },
            {
              type: "image_url",
              image_url: { url: REMOTE_URL, detail: "high" },
            },
          ],
        },
      ],
    };

    await executor.prefetchImages(body);

    const imgBlock = body.input[0].content.find(
      (c) => c.type === "input_image",
    );
    expect(
      imgBlock,
      "input_image block must be present after prefetch",
    ).toBeDefined();
    expect(imgBlock.image_url.startsWith("data:image/jpeg;base64,")).toBe(true);
    expect(imgBlock.detail).toBe("high");

    const base64Payload = imgBlock.image_url.split(",")[1];
    const decodedLen = Buffer.from(base64Payload, "base64").length;
    expect(decodedLen).toBe(IMAGE_1MB_BYTES);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("passes through existing data URIs without calling fetch", async () => {
    global.fetch = vi.fn();

    const executor = new CodexExecutor();
    const body = {
      input: [
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: DATA_URI } }],
        },
      ],
    };

    await executor.prefetchImages(body);

    const imgBlock = body.input[0].content.find(
      (c) => c.type === "input_image",
    );
    expect(imgBlock.image_url).toBe(DATA_URI);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("combines client abort and timeout signals", async () => {
    const controller = new AbortController();
    const received = [];
    global.fetch = vi.fn((_url, options) => {
      received.push(options.signal);
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      });
    });

    await expect(fetchImageAsBase64("https://example.com/image.png", {
      signal: controller.signal,
      timeoutMs: 1,
    })).resolves.toBeNull();
    expect(received[0]).not.toBe(controller.signal);
  });

  it("falls back to original URL when remote fetch fails", async () => {
    global.fetch = vi.fn(async () => {
      throw new Error("network down");
    });

    const executor = new CodexExecutor();
    const body = {
      input: [
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: REMOTE_URL } }],
        },
      ],
    };

    await executor.prefetchImages(body);

    const imgBlock = body.input[0].content.find(
      (c) => c.type === "input_image",
    );
    expect(imgBlock.image_url).toBe(REMOTE_URL);
  });

  it("routes compact and normal requests independently on one executor", async () => {
    const executor = new CodexExecutor();
    const urls = [];
    vi.spyOn(proxyFetchModule, "proxyAwareFetch").mockImplementation(async (url) => {
      urls.push(url);
      return { ok: true, status: 200, headers: new Headers(), body: null };
    });

    await executor.execute({
      model: "gpt-5.3-codex",
      body: { _compact: true, input: "compact" },
      stream: true,
      credentials: { accessToken: "test" },
    });
    await executor.execute({
      model: "gpt-5.3-codex",
      body: { input: "normal" },
      stream: true,
      credentials: { accessToken: "test" },
    });

    expect(urls[0]).toMatch(/\/compact$/);
    expect(urls[1]).not.toMatch(/\/compact$/);
  });

  it("execute() prefetches images before sending to upstream", async () => {
    global.fetch = vi.fn(async () => mockImageFetch(IMAGE_1MB_BYTES));

    let capturedBodyString = null;
    vi.spyOn(proxyFetchModule, "proxyAwareFetch").mockImplementation(
      async (url, init) => {
        capturedBodyString = init.body;
        return { ok: true, status: 200, headers: new Map() };
      },
    );

    const executor = new CodexExecutor();
    const body = {
      input: [
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: REMOTE_URL } }],
        },
      ],
    };

    await executor.execute({
      model: "gpt-5.3-codex",
      body,
      stream: true,
      credentials: { accessToken: "test" },
    });

    expect(capturedBodyString).toBeTypeOf("string");
    expect(capturedBodyString).not.toBe("{}");
    const parsed = JSON.parse(capturedBodyString);
    const imgBlock = parsed.input[0].content.find(
      (c) => c.type === "input_image",
    );
    expect(imgBlock.image_url.startsWith("data:image/jpeg;base64,")).toBe(true);
  });
});
