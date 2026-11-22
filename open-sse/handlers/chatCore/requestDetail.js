import {
  saveRequestUsage,
  appendRequestLog,
  saveRequestDetail,
} from "@/lib/usageDb.js";
import { COLORS } from "../../utils/stream.js";
import { canonicalizeUsage } from "../../utils/usageTracking.js";

const OPTIONAL_PARAMS = [
  "temperature",
  "top_p",
  "top_k",
  "max_tokens",
  "max_completion_tokens",
  "thinking",
  "reasoning",
  "enable_thinking",
  "presence_penalty",
  "frequency_penalty",
  "seed",
  "stop",
  "tools",
  "tool_choice",
  "response_format",
  "prediction",
  "store",
  "metadata",
  "n",
  "logprobs",
  "top_logprobs",
  "logit_bias",
  "user",
  "parallel_tool_calls",
];

export function extractRequestConfig(body, stream) {
  const config = { messages: body.messages || [], model: body.model, stream };
  for (const param of OPTIONAL_PARAMS) {
    if (body[param] !== undefined) config[param] = body[param];
  }
  return config;
}

export function extractUsageFromResponse(responseBody) {
  if (!responseBody || typeof responseBody !== "object") return null;

  // Claude format
  // Note: OpenAI Responses usage ({input_tokens, input_tokens_details:{cached_tokens}})
  // also matches this branch. Its prompt is cache-INCLUSIVE and its cache rides in
  // input_tokens_details, so emit it as cached_tokens — the convention
  // canonicalizeUsage() passes through without folding. Reading it here keeps
  // cache accounting correct for /v1/responses and codex traffic.
  if (responseBody.usage?.input_tokens !== undefined) {
    return {
      prompt_tokens: responseBody.usage.input_tokens || 0,
      completion_tokens: responseBody.usage.output_tokens || 0,
      cached_tokens: responseBody.usage.cached_tokens ?? responseBody.usage.input_tokens_details?.cached_tokens,
      cache_read_input_tokens: responseBody.usage.cache_read_input_tokens,
      cache_creation_input_tokens:
        responseBody.usage.cache_creation_input_tokens,
    };
  }

  // OpenAI format
  if (responseBody.usage?.prompt_tokens !== undefined) {
    return {
      prompt_tokens: responseBody.usage.prompt_tokens || 0,
      completion_tokens: responseBody.usage.completion_tokens || 0,
      cached_tokens:
        responseBody.usage.cached_tokens ??
        responseBody.usage.prompt_tokens_details?.cached_tokens,
      reasoning_tokens:
        responseBody.usage.completion_tokens_details?.reasoning_tokens,
    };
  }

  // Gemini format. Antigravity's non-streaming response wraps this in `response`.
  const usageMetadata = responseBody.usageMetadata || responseBody.response?.usageMetadata;
  if (usageMetadata) {
    return {
      prompt_tokens: usageMetadata.promptTokenCount || 0,
      completion_tokens: usageMetadata.candidatesTokenCount || 0,
      cached_tokens: usageMetadata.cachedContentTokenCount,
      reasoning_tokens: usageMetadata.thoughtsTokenCount,
    };
  }

  return null;
}

export function buildRequestDetail(base, overrides = {}) {
  const canonicalTokens = base.tokens
    ? canonicalizeUsage(base.tokens) || base.tokens
    : { prompt_tokens: 0, completion_tokens: 0 };
  return {
    provider: base.provider || "unknown",
    model: base.model || "unknown",
    connectionId: base.connectionId || undefined,
    timestamp: new Date().toISOString(),
    latency: base.latency || { ttft: 0, total: 0 },
    tokens: canonicalTokens,
    performance: base.performance || null,
    request: base.request,
    providerRequest: base.providerRequest || null,
    providerResponse: base.providerResponse || null,
    response: base.response || {},
    status: base.status || "success",
    ...overrides,
  };
}

export function saveUsageStats({
  provider,
  model,
  tokens,
  connectionId,
  apiKey,
  endpoint,
  performance,
  label = "USAGE",
}) {
  if (!tokens || typeof tokens !== "object") return;

  // Canonicalize to one storage convention (prompt_tokens cache-inclusive) so
  // cached/cache-creation tokens survive to cost calc + stats. See canonicalizeUsage.
  const normalized = canonicalizeUsage(tokens) || {
    prompt_tokens: tokens.prompt_tokens ?? tokens.input_tokens ?? 0,
    completion_tokens: tokens.completion_tokens ?? tokens.output_tokens ?? 0,
  };

  const inTokens = normalized.prompt_tokens;
  const outTokens = normalized.completion_tokens;

  if (inTokens === 0 && outTokens === 0) return;

  const time = new Date().toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const accountSuffix = connectionId
    ? ` | account=${connectionId.slice(0, 8)}...`
    : "";
  if (label !== "STREAM USAGE") {
    console.log(
      `${COLORS.green}[${time}] 📊 [${label}] ${provider.toUpperCase()} | in=${inTokens} | out=${outTokens}${accountSuffix}${COLORS.reset}`,
    );
  }

  saveRequestUsage({
    provider: provider || "unknown",
    model: model || "unknown",
    tokens: normalized,
    timestamp: new Date().toISOString(),
    connectionId: connectionId || undefined,
    apiKey: apiKey || undefined,
    endpoint: endpoint || null,
    performance: performance || null,
  }).catch(() => {});
}

export function formatDoneLine({ usage, latency }) {
  const canonical = canonicalizeUsage(usage) || usage || {};
  const inTok = canonical.prompt_tokens ?? canonical.input_tokens ?? 0;
  const outTok = canonical.completion_tokens ?? canonical.output_tokens ?? 0;
  const cacheRead =
    canonical.cached_tokens ??
    canonical.cache_read_input_tokens ??
    canonical.prompt_tokens_details?.cached_tokens ??
    0;
  const cacheCreate = canonical.cache_creation_input_tokens ?? 0;
  let inStr = `IN ${inTok}`;
  if (cacheRead || cacheCreate) {
    const parts = [];
    if (cacheRead) parts.push(`↻${cacheRead}`);
    if (cacheCreate) parts.push(`+${cacheCreate}`);
    inStr += ` (CACHE ${parts.join(" ")})`;
  }
  const ttftStr = latency?.ttft ? ` · TTFT ${latency.ttft}ms` : "";
  return `DONE ${latency?.total ?? 0}ms${ttftStr} · ${inStr} · OUT ${outTok}`;
}
