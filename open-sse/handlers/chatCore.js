import { detectFormat, getTargetFormat, resolveTransport } from "../services/provider.js";
import { translateRequest } from "../translator/index.js";
import { FORMATS } from "../translator/formats.js";
import { COLORS } from "../utils/stream.js";
import { createStreamController } from "../utils/streamHandler.js";
import { refreshWithRetry } from "../services/tokenRefresh.js";
import { createRequestLogger } from "../utils/requestLogger.js";
import {
  getModelTargetFormat,
  getModelSupportedFormats,
  getModelStrip,
  getModelUpstreamId,
  getModelType,
  PROVIDER_ID_TO_ALIAS,
} from "../config/providerModels.js";
import {
  createErrorResult,
  parseUpstreamError,
  formatProviderError,
} from "../utils/error.js";
import { HTTP_STATUS, TOKEN_SAVER_HEADER } from "../config/runtimeConfig.js";
import { handleBypassRequest } from "../utils/bypassHandler.js";
import {
  trackPendingRequest,
  appendRequestLog,
  saveRequestDetail,
} from "@/lib/usageDb.js";
import { getExecutor } from "../executors/index.js";
import { PROVIDERS } from "../providers/index.js";
import { buildAntigravityEmptyStopContinuation } from "../executors/antigravity.js";
import {
  buildRequestDetail,
  extractRequestConfig,
} from "./chatCore/requestDetail.js";
import { handleForcedSSEToJson } from "./chatCore/sseToJsonHandler.js";
import { handleNonStreamingResponse } from "./chatCore/nonStreamingHandler.js";
import {
  handleStreamingResponse,
  buildOnStreamComplete,
} from "./chatCore/streamingHandler.js";
import {
  detectClientTool,
  isNativePassthrough,
} from "../utils/clientDetector.js";
import { dedupeTools } from "../utils/toolDeduper.js";
import { injectCaveman } from "../rtk/caveman.js";
import { injectPonytail } from "../rtk/ponytail.js";
import { compressMessages, formatRtkLog } from "../rtk/index.js";
import {
  compressWithHeadroom,
  formatHeadroomLog,
  formatHeadroomSizeLog,
  isHeadroomPhantomSavings,
} from "../rtk/headroom.js";
import {
  extractThinking,
  parseSuffix,
  stripThinkingSuffix,
} from "../translator/concerns/thinkingUnified.js";
import { normalizeClaudePassthrough } from "../translator/formats/claude.js";
import { resolveSessionId } from "../utils/sessionManager.js";
import {
  getAntigravitySessionKey,
  getCachedThinking,
  setCachedThinking,
  injectThinkingReplay,
} from "../utils/antigravityReasoningReplay.js";
import {
  defaultClaudeToolType,
  shouldDefaultClaudeToolType,
  stripOrphanedToolResults,
} from "../translator/concerns/toolCall.js";
import { compressWithPxpipe, formatPxpipeLog } from "../rtk/pxpipe.js";
import { decideSoftRetry } from "../services/accountFallback.js";
import { getThinkingLevels } from "../providers/thinkingLevels.js";
import { getCapabilitiesForModel } from "../providers/capabilities.js";
import { stripUnsupportedModalities } from "../translator/concerns/modality.js";
import { prefetchRemoteImages } from "../translator/concerns/prefetch.js";

export function sanitizeQoderPromptEnhanceRequest(body) {
  if (!body || !Array.isArray(body.messages)) return body;
  const lastMsg = body.messages[body.messages.length - 1];
  const lastContent = typeof lastMsg?.content === "string" ? lastMsg.content : "";
  if (
    lastContent.includes("<enhanced-prompt>") &&
    lastContent.includes("<context_placeholder_instructions>")
  ) {
    // Disable thinking/reasoning for prompt enhance to make it instant and prevent SSE delta incompatibility
    body.reasoning_effort = "none";
    if (body.thinking) body.thinking = { type: "disabled" };

    const sysMsg = body.messages.find((m) => m.role === "system");
    const rule =
      "\n\nCRITICAL OUTPUT FORMAT: If you do not suggest adding any new context files, you MUST NOT output <added_contexts> or </added_contexts> tags at all. Only output <added_contexts> if you include at least one complete <add_context> block.";
    if (sysMsg && typeof sysMsg.content === "string") {
      if (!sysMsg.content.includes("CRITICAL OUTPUT FORMAT")) {
        sysMsg.content += rule;
      }
    } else {
      body.messages.unshift({
        role: "system",
        content: rule.trim(),
      });
    }
  }
  return body;
}

export function stripContinuityFields(body) {
  if (!body || !Array.isArray(body.messages)) return body;
  for (const message of body.messages) {
    if (message && typeof message === "object") {
      delete message.encrypted_content;
      delete message.reasoning_encrypted_content;
    }
  }
  return body;
}

function maskLoggedUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return "<invalid-url>";
  }
}

/**
 * Core chat handler - shared between SSE and Worker
 * @param {object} options.body - Request body
 * @param {object} options.modelInfo - { provider, model }
 * @param {object} options.credentials - Provider credentials
 * @param {string} options.sourceFormatOverride - Override detected source format (e.g. "openai-responses")
 */
function waitForAbortableDelay(ms, signal) {
  if (!ms || ms <= 0) return Promise.resolve();
  if (signal?.aborted) {
    return Promise.reject(new DOMException("Request aborted", "AbortError"));
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(cleanupAndResolve, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      cleanup();
      reject(new DOMException("Request aborted", "AbortError"));
    };
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    function cleanupAndResolve() {
      cleanup();
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function handleChatCore({
  body,
  modelInfo,
  credentials,
  log,
  onCredentialsRefreshed,
  onProfileArnDiscovered,
  onRequestSuccess,
  onDisconnect,
  clientRawRequest,
  connectionId,
  userAgent,
  apiKey,
  ccFilterNaming,
  rtkEnabled,
  headroomEnabled,
  headroomUrl,
  headroomCompressUserMessages,
  headroomTimeoutMs,
  cavemanEnabled,
  cavemanLevel,
  ponytailEnabled,
  ponytailLevel,
  midStreamResumeEnabled,
  sourceFormatOverride,
  providerThinking,
  pxpipeEnabled = false,
  pxpipeMinChars,
  pxpipeTimeoutMs,
  pxpipeTransform,
  onPxpipeEvent,
  timing = null,
  clientSignal = null,
}) {
  const { provider, model } = modelInfo;
  const requestStartTime = timing?.requestStartTime || Date.now();

  const sourceFormat = sourceFormatOverride || detectFormat(body);

  // Resolve session tag for unified request lifecycle logging (a625ea9fd).
  // Additive — does not replace existing log calls.
  const sessionSeed = (() => {
    try {
      return resolveSessionId({
        headers: clientRawRequest?.headers,
        body,
        connectionId,
        scope: provider,
      });
    } catch {
      return connectionId || "";
    }
  })();
  const reqTag = log?.tagForSession
    ? log.tagForSession(sessionSeed)
    : log?.nextTag
      ? log.nextTag()
      : "";

  // Check for bypass patterns (warmup, skip, cc naming)
  const bypassResponse = handleBypassRequest(
    body,
    model,
    userAgent,
    ccFilterNaming,
  );
  if (bypassResponse) return bypassResponse;

  const alias = PROVIDER_ID_TO_ALIAS[provider] || provider;
  const modelTargetFormat = getModelTargetFormat(alias, model);
  // Multi-endpoint providers: preserve matching client formats where the model supports it.
  // A model-specific declaration prevents OpenCode Go models that only support
  // Chat Completions from being routed to Claude or Responses endpoints.
  const modelSupportedFormats = getModelSupportedFormats(alias, model);
  const runtimeTransport = resolveTransport(provider, sourceFormat);
  const useTransport =
    !modelSupportedFormats || modelSupportedFormats.includes(sourceFormat)
      ? runtimeTransport
      : null;
  // A source-format matched endpoint avoids an unnecessary lossy translation.
  const targetFormat =
    useTransport?.format ||
    modelTargetFormat ||
    getTargetFormat(provider, credentials);
  if (useTransport && credentials) {
    credentials.runtimeTransport = useTransport;
  }
  const stripList = getModelStrip(alias, model);
  const upstreamModel = getModelUpstreamId(alias, model) || model;

  // Inject provider-level thinking config override (only if client hasn't set)
  // on/off → extended type (body.thinking), none/low/medium/high → effort type (body.reasoning_effort)
  if (providerThinking?.mode && providerThinking.mode !== "auto") {
    const mode = providerThinking.mode;
    if (mode === "on" && !body.thinking) {
      console.log("Injecting provider-level thinking config override: on");
      body = { ...body, thinking: { type: "enabled", budget_tokens: 10000 } };
    } else if (mode === "off" && !body.thinking) {
      body = { ...body, thinking: { type: "disabled" } };
    } else if (!body.reasoning_effort) {
      body = { ...body, reasoning_effort: mode };
    }
  }

  // Antigravity reasoning replay: inject cached thinking into last assistant turn (Phase 5)
  if (provider === "antigravity" && body?.request?.contents) {
    const _replayKey = getAntigravitySessionKey(model, body);
    const _cachedThinking = _replayKey ? getCachedThinking(_replayKey) : null;
    if (_cachedThinking) body = injectThinkingReplay(body, _cachedThinking);
  }

  const clientRequestedStreaming =
    body.stream === true ||
    sourceFormat === FORMATS.ANTIGRAVITY ||
    sourceFormat === FORMATS.GEMINI ||
    sourceFormat === FORMATS.GEMINI_CLI;
  const providerRequiresStreaming =
    provider === "openai" || provider === "codex" || provider === "commandcode";
  let stream = providerRequiresStreaming ? true : body.stream !== false;

  // Image generation models require non-streaming (Google v1internal:generateContent)
  const modelType = getModelType(alias, model);
  const isImageGenModel =
    modelType === "image" || /image|imagen|image-generation/i.test(model);
  if (
    isImageGenModel &&
    (provider === "antigravity" || provider === "gemini-cli")
  ) {
    stream = false;
  }

  // DeepSeek-TUI: interactive TUI panel sends stream:true and needs SSE.
  // Non-interactive mode (-p flag) sends without stream and can't parse SSE.
  // Only force non-streaming when client didn't explicitly request it.
  const detectedTool = detectClientTool(clientRawRequest?.headers || {}, body);
  if (detectedTool === "deepseek-tui" && body.stream !== true) stream = false;

  // Check client Accept header preference for non-streaming requests
  // This fixes AI SDK compatibility where clients send Accept: application/json
  const acceptHeader = clientRawRequest?.headers?.accept || "";
  const clientPrefersJson = acceptHeader.includes("application/json");
  const clientPrefersSSE = acceptHeader.includes("text/event-stream");
  if (
    clientPrefersJson &&
    !clientPrefersSSE &&
    body.stream !== true &&
    !providerRequiresStreaming
  ) {
    stream = false;
  }

  const reqLogger = await createRequestLogger(
    sourceFormat,
    targetFormat,
    model,
  );
  if (clientRawRequest)
    reqLogger.logClientRawRequest(
      clientRawRequest.endpoint,
      clientRawRequest.body,
      clientRawRequest.headers,
    );
  reqLogger.logRawRequest(body);
  log?.debug?.(
    "FORMAT",
    `${sourceFormat} → ${targetFormat} | stream=${stream}`,
  );

  // Native passthrough: CLI tool and provider are the same ecosystem
  // Skip all translation/normalization — only model and Bearer are swapped
  const clientTool = detectClientTool(clientRawRequest?.headers || {}, body);
  const passthrough = isNativePassthrough(clientTool, provider);

  // Sanitize Qoder prompt enhance requests to prevent hallucinated orphan </added_contexts> tags
  sanitizeQoderPromptEnhanceRequest(body);

  // Strip orphaned tool results before translation for non-Kiro paths.
  // Kiro has its own reconcileOrphanedToolResults inside openai-to-kiro.js.
  // Dangling tool results from client-side history compaction cause HTTP 400
  // on strict upstreams (Anthropic, Gemini). Port of upstream PR #2298.
  if (targetFormat !== FORMATS.KIRO) {
    stripOrphanedToolResults(body);
  }

  // Auto-strip media blocks the model can't read (vision/audio/pdf) before translation.
  // Upstream decolua: strip + optional remote image prefetch for non-passthrough paths.
  if (!passthrough) {
    const caps = getCapabilitiesForModel(provider, model);
    if (stripUnsupportedModalities(body, sourceFormat, caps)) {
      log?.debug?.(
        "MODALITY",
        `stripped unsupported media for ${provider}/${model}`,
      );
    }
    try {
      const n = await prefetchRemoteImages(body, sourceFormat, targetFormat, {
        signal: clientSignal || undefined,
      });
      if (n > 0) {
        log?.debug?.(
          "MODALITY",
          `prefetched ${n} remote image(s) for ${targetFormat}`,
        );
      }
    } catch (e) {
      log?.warn?.("MODALITY", `image prefetch failed: ${e.message}`);
    }
  }

  let translatedBody;
  let toolNameMap;
  let customToolNames;
  if (passthrough) {
    log?.debug?.(
      "PASSTHROUGH",
      `${clientTool} → ${provider} | native lossless`,
    );
    const suffix = parseSuffix(upstreamModel);
    translatedBody = {
      ...body,
      model: suffix.cleanModel,
    };
    if (provider === "codex" && suffix.override?.mode === "level") {
      const supportedLevels = getThinkingLevels("codex", suffix.cleanModel);
      const effort = supportedLevels?.includes(suffix.override.level)
        ? suffix.override.level
        : suffix.override.level === "ultra" && supportedLevels?.includes("max")
          ? "max"
          : suffix.override.level;
      translatedBody.reasoning = {
        ...(translatedBody.reasoning || {}),
        effort,
      };
      delete translatedBody.reasoning_effort;
    }
    // Normalize newer Cowork/CC beta shapes the API rejects
    if (clientTool === "claude") {
      normalizeClaudePassthrough(translatedBody, translatedBody.model);
    }
  } else {
    translatedBody = translateRequest(
      sourceFormat,
      targetFormat,
      upstreamModel,
      body,
      stream,
      credentials,
      provider,
      reqLogger,
      stripList,
      connectionId,
      clientTool,
    );
    if (!translatedBody) {
      trackPendingRequest(model, provider, connectionId, false, true);
      return createErrorResult(
        HTTP_STATUS.BAD_REQUEST,
        `Failed to translate request for ${sourceFormat} → ${targetFormat}`,
      );
    }
    toolNameMap = translatedBody._toolNameMap;
    customToolNames = translatedBody._customToolNames;
    delete translatedBody._toolNameMap;
    delete translatedBody._customToolNames;
    translatedBody.model = stripThinkingSuffix(upstreamModel);
  }

  // Unified ▶ request summary line — correlates all lifecycle logs by session tag.
  // Additive: COLORS/formatRtkLog imports are kept below. See upstream a625ea9fd.
  if (log?.line) {
    try {
      const clientModel =
        clientRawRequest?.body?.model || `${provider}/${model}`;
      const msgN =
        translatedBody.messages?.length || body.messages?.length || 0;
      const toolN = translatedBody.tools?.length || body.tools?.length || 0;
      const fmtStr = passthrough
        ? `FMT:${sourceFormat}(pass)`
        : `FMT:${sourceFormat}→${targetFormat}`;
      const think = log.fmtThink?.(extractThinking(translatedBody));
      const acc = credentials?.connectionName || "-";
      const parts = [
        `POST ${log.hlModel?.(clientModel) ?? clientModel} → ${log.hlModel?.(`${provider}/${model}`) ?? `${provider}/${model}`}`,
        fmtStr,
        stream ? "STREAM" : "JSON",
        `${msgN}MSG`,
      ];
      if (toolN) parts.push(`${toolN}TOOL`);
      if (think) parts.push(`THINK:${think}`);
      parts.push(`ACC:${acc}`);
      log.line(reqTag, "▶", parts.join(" · "));
    } catch {
      /* never crash on logging */
    }
  }

  // Dedupe duplicate built-in tools when equivalent MCP tools are present (Claude clients only).
  if (clientTool === "claude" && Array.isArray(translatedBody.tools)) {
    const { tools: deduped, stripped } = dedupeTools(translatedBody.tools);
    if (stripped.length > 0) {
      translatedBody.tools = deduped;
      log?.debug?.(
        "TOOLDEDUP",
        `stripped ${stripped.length}: ${stripped.slice(0, 3).join(", ")}${stripped.length > 3 ? "..." : ""}`,
      );
    }
  }

  // Token savers: applied at the final body just before dispatch
  // Covers both passthrough (source shape) and translated (target shape) flows
  const finalFormat = passthrough ? sourceFormat : targetFormat;

  // Per-request opt-out: client can bypass all token savers via header.
  const tokenSaverEnabled =
    clientRawRequest?.headers?.[TOKEN_SAVER_HEADER]?.toLowerCase() !== "off";

  // Headroom: compress messages via external proxy when configured (fail-open)
  const headroomDiagnostics = {};
  const headroomStats = await compressWithHeadroom(translatedBody, {
    enabled: tokenSaverEnabled && headroomEnabled,
    url: headroomUrl,
    model: upstreamModel,
    format: finalFormat,
    compressUserMessages: headroomCompressUserMessages,
    timeoutMs: headroomTimeoutMs,
    diagnostics: headroomDiagnostics,
  });
  const headroomLine = formatHeadroomLog(headroomStats);
  const headroomSizeLine = formatHeadroomSizeLog(headroomDiagnostics);
  if (headroomLine) {
    log?.info?.(
      "HEADROOM",
      `${headroomLine}${headroomSizeLine ? ` | ${headroomSizeLine}` : ""}`,
    );
    if (isHeadroomPhantomSavings(headroomStats, headroomDiagnostics)) {
      log?.warn?.(
        "HEADROOM",
        `reported token delta, but outbound JSON shrank <5%; provider may bill near-original payload | ${headroomSizeLine}`,
      );
    }
  } else if (tokenSaverEnabled && headroomEnabled) {
    log?.warn?.(
      "HEADROOM",
      `skipped: ${headroomDiagnostics.reason || "compression unavailable"}${headroomDiagnostics.endpoint ? ` (${headroomDiagnostics.endpoint})` : ""}`,
    );
  }

  // TTS models don't support tool messages/function calling
  if (getModelType(alias, model) === "tts" && translatedBody.messages) {
    translatedBody.messages = translatedBody.messages.filter(
      (msg) => msg.role !== "tool",
    );
    delete translatedBody.tools;
  }

  // Claude tool schema requires `type` to be explicitly set; strict gateways (e.g., MiniMax)
  // reject legacy payloads that omit it with HTTP 400. Default to "custom" when missing.
  // Provider-scoped via quirks (shouldDefaultClaudeToolType): only gateways that declare
  // requireClaudeToolType get the explicit type. Applying it unconditionally breaks
  // Claude-format endpoints that only accept the legacy typeless tool shape — DeepSeek's
  // Anthropic-compatible endpoint 400s with "unknown variant `custom`" (#3905).
  if (shouldDefaultClaudeToolType(provider, finalFormat, translatedBody.tools, PROVIDERS)) {
    translatedBody.tools = defaultClaudeToolType(translatedBody.tools);
  }

  // RTK: compress tool_result content
  const rtkStats = compressMessages(translatedBody, tokenSaverEnabled && rtkEnabled);
  const rtkLine = formatRtkLog(rtkStats);
  if (rtkLine) console.log(rtkLine);

  // PxPipe: multimodal prompt compression. Runs after RTK, before dispatch.
  let pxpipeSummary = null;
  if (tokenSaverEnabled && pxpipeEnabled) {
    try {
      const pxpipeResult = await compressWithPxpipe(translatedBody, {
        enabled: true,
        format: finalFormat,
        model,
        minChars: pxpipeMinChars,
        timeoutMs: pxpipeTimeoutMs,
        transform: pxpipeTransform,
      });
      pxpipeSummary = pxpipeResult.summary;
      if (pxpipeResult.body) translatedBody = pxpipeResult.body;
      const pxpipeLine = formatPxpipeLog(pxpipeSummary);
      if (pxpipeLine) log?.info?.("PXPIPE", pxpipeLine);
      try {
        onPxpipeEvent?.({ provider, model, ...pxpipeSummary });
      } catch {
        /* stats must not break requests */
      }
    } catch (e) {
      log?.debug?.("PXPIPE", `error: ${e?.message}`);
    }
  }
  // PxPipe summary wired into sharedCtx so requestDetail builders can include compression stats.

  // Caveman: inject terse-style system prompt
  if (tokenSaverEnabled && cavemanEnabled && cavemanLevel) {
    injectCaveman(translatedBody, finalFormat, cavemanLevel);
    log?.debug?.("CAVEMAN", `${cavemanLevel} | ${finalFormat}`);
  }

  // Ponytail: inject deletion-biased coding style system prompt (token saver)
  if (tokenSaverEnabled && ponytailEnabled && ponytailLevel) {
    injectPonytail(translatedBody, finalFormat, ponytailLevel);
    log?.debug?.("PONYTAIL", `${ponytailLevel} | ${finalFormat}`);
  }

  const executor = getExecutor(provider);
  stripContinuityFields(translatedBody);
  trackPendingRequest(model, provider, connectionId, true);
  appendRequestLog({ model, provider, connectionId, status: "PENDING" }).catch(
    () => {},
  );

  const msgCount =
    translatedBody.messages?.length ||
    translatedBody.input?.length ||
    translatedBody.contents?.length ||
    translatedBody.request?.contents?.length ||
    0;
  log?.debug?.(
    "REQUEST",
    `${provider.toUpperCase()} | ${model} | ${msgCount} msgs`,
  );

  const streamController = createStreamController({
    onDisconnect: (reason) => {
      trackPendingRequest(model, provider, connectionId, false);
      if (onDisconnect) onDisconnect(reason);
    },
    onError: () => trackPendingRequest(model, provider, connectionId, false),
    log,
    provider,
    model,
    clientSignal,
  });

  const proxyOptions = {
    connectionProxyEnabled:
      credentials?.providerSpecificData?.connectionProxyEnabled === true,
    connectionProxyUrl:
      credentials?.providerSpecificData?.connectionProxyUrl || "",
    connectionNoProxy:
      credentials?.providerSpecificData?.connectionNoProxy || "",
    connectionProxyHeadersTimeoutMs:
      credentials?.providerSpecificData?.connectionProxyHeadersTimeoutMs,
    vercelRelayUrl: credentials?.providerSpecificData?.vercelRelayUrl || "",
  };

  if (proxyOptions.vercelRelayUrl) {
    const connectionName =
      credentials?.connectionName || credentials?.connectionId || "unknown";
    const poolId =
      credentials?.providerSpecificData?.connectionProxyPoolId || "none";
    log?.debug?.(
      "PROXY",
      `${provider.toUpperCase()} | ${model} | conn=${connectionName} | pool=${poolId} | vercel-relay=${maskLoggedUrl(proxyOptions.vercelRelayUrl)}`,
    );
  } else if (
    proxyOptions.connectionProxyEnabled &&
    proxyOptions.connectionProxyUrl
  ) {
    let maskedProxyUrl = proxyOptions.connectionProxyUrl;
    try {
      const parsed = new URL(proxyOptions.connectionProxyUrl);
      const host = parsed.hostname || "";
      const port = parsed.port ? `:${parsed.port}` : "";
      const protocol = parsed.protocol || "http:";
      maskedProxyUrl = `${protocol}//${host}${port}`;
    } catch {
      // Keep raw if URL parsing fails
    }

    const poolId =
      credentials?.providerSpecificData?.connectionProxyPoolId || "none";
    const connectionName =
      credentials?.connectionName || credentials?.connectionId || "unknown";
    log?.debug?.(
      "PROXY",
      `${provider.toUpperCase()} | ${model} | conn=${connectionName} | pool=${poolId} | url=${maskedProxyUrl}`,
    );
  }

  if (proxyOptions.connectionProxyEnabled && proxyOptions.connectionNoProxy) {
    const connectionName =
      credentials?.connectionName || credentials?.connectionId || "unknown";
    log?.debug?.(
      "PROXY",
      `${provider.toUpperCase()} | ${model} | conn=${connectionName} | no_proxy=${proxyOptions.connectionNoProxy}`,
    );
  }

  // Phase 3 (option c) fused path: for a STREAMING Kiro request that needs
  // translation (dominant traffic: Claude/other client through Kiro→OpenAI),
  // ask the executor to hand off parsed OpenAI objects instead of re-serialized
  // SSE bytes, skipping the downstream serialize→reparse hop. sourceFormat is
  // the client format, targetFormat the provider format; needsTranslation is
  // simply sourceFormat !== targetFormat. Non-streaming / same-format / non-Kiro
  // requests are unaffected (emitObjects stays false → byte path).
  const wantKiroObjects =
    provider === "kiro" && stream && sourceFormat !== targetFormat;

  // Execute request
  let providerResponse, providerUrl, providerHeaders, finalBody;
  let providerObjectStream = null;
  let providerResponseFormat = targetFormat;
  // All retry paths must keep executor-specific output metadata in sync.
  const runExecutor = () =>
    executor.execute({
      model,
      body: translatedBody,
      stream,
      credentials,
      providerSessionId: sessionSeed,
      clientTool,
      signal: streamController.signal,
      log,
      proxyOptions,
      emitObjects: wantKiroObjects,
      onProfileArnDiscovered,
      timing,
    });
  try {
    if (timing && !timing.upstreamFetchStartedAt) {
      timing.upstreamFetchStartedAt = Date.now();
    }
    const result = await runExecutor();
    providerResponse = result.response;
    providerUrl = result.url;
    providerHeaders = result.headers;
    finalBody = result.transformedBody;
    providerObjectStream = result.kiroObjectStream || null;
    providerResponseFormat = result.responseFormat || targetFormat;
    reqLogger.logTargetRequest(providerUrl, providerHeaders, finalBody);
  } catch (error) {
    trackPendingRequest(model, provider, connectionId, false, true);

    const isTimeout = error.name === "TimeoutError" || error.status === 504;
    const status = isTimeout
      ? 504
      : error.name === "AbortError"
        ? 499
        : HTTP_STATUS.BAD_GATEWAY;

    appendRequestLog({
      model,
      provider,
      connectionId,
      status: `FAILED ${status}`,
    }).catch(() => {});
    saveRequestDetail(
      buildRequestDetail({
        provider,
        model,
        connectionId,
        latency: { ttft: 0, total: Date.now() - requestStartTime },
        tokens: { prompt_tokens: 0, completion_tokens: 0 },
        request: extractRequestConfig(body, stream),
        providerRequest: translatedBody || null,
        response: {
          error: error.message || String(error),
          status,
          thinking: null,
        },
        status: "error",
      }),
    ).catch(() => {});

    if (error.name === "AbortError") {
      streamController.handleError(error);
      return createErrorResult(499, "Request aborted");
    }
    const errMsg = formatProviderError(error, provider, model, status);
    console.log(`${COLORS.red}[ERROR] ${errMsg}${COLORS.reset}`);
    return createErrorResult(status, errMsg);
  }

  // Handle 401/403 - try token refresh (skip for noAuth providers)
  if (
    !executor.noAuth &&
    (providerResponse.status === HTTP_STATUS.UNAUTHORIZED ||
      providerResponse.status === HTTP_STATUS.FORBIDDEN)
  ) {
    try {
      // Persist a rotating refresh token between retry attempts while retaining
      // connection-level proxy routing for every provider refresh request.
      const newCredentials = await refreshWithRetry(async () => {
        const result = await executor.refreshCredentials(
          credentials,
          log,
          proxyOptions,
        );
        if (
          result?.refreshToken &&
          result.refreshToken !== credentials.refreshToken
        ) {
          if (result.accessToken) credentials.accessToken = result.accessToken;
          credentials.refreshToken = result.refreshToken;
        }
        return result;
      }, 3, log);
      if (newCredentials?.accessToken || newCredentials?.copilotToken) {
        log?.info?.("TOKEN", `${provider.toUpperCase()} | refreshed`);
        Object.assign(credentials, newCredentials);
        if (onCredentialsRefreshed) {
          try {
            await onCredentialsRefreshed(newCredentials);
          } catch (e) {
            log?.warn?.("TOKEN", `onCredentialsRefreshed failed: ${e.message}`);
          }
        }
        try {
          const retryResult = await runExecutor();
          if (retryResult.response.ok) {
            providerResponse = retryResult.response;
            providerUrl = retryResult.url;
            providerHeaders = retryResult.headers;
            finalBody = retryResult.transformedBody;
            providerObjectStream = retryResult.kiroObjectStream || null;
            providerResponseFormat = retryResult.responseFormat || targetFormat;
          }
        } catch {
          log?.warn?.(
            "TOKEN",
            `${provider.toUpperCase()} | retry after refresh failed`,
          );
        }
      } else {
        log?.warn?.("TOKEN", `${provider.toUpperCase()} | refresh failed`);
      }
    } catch (e) {
      log?.warn?.(
        "TOKEN",
        `${provider.toUpperCase()} | refresh threw: ${e.message}`,
      );
    }
  }

  // Phase 2: soft-rate-limit instant-retry-same-auth. A 429 whose reset window
  // is within SOFT_RATE_LIMIT_THRESHOLD_MS (~5s) is a brief throttle: retry the
  // SAME credential after a short capped wait instead of cooling it down and
  // rotating accounts. Hard/long 429s (quota exhausted, multi-hour resets) skip
  // this and fall through to the normal error path so the caller rotates auth.
  {
    let softRetryCount = 0;
    while (!providerResponse.ok && providerResponse.status === 429) {
      // Peek the error on a clone so the original body stays readable for the
      // final error path if we decide not to retry.
      let peeked;
      try {
        peeked = await parseUpstreamError(providerResponse.clone(), executor);
      } catch {
        break;
      }
      const decision = decideSoftRetry(
        peeked.statusCode,
        {
          message: peeked.message,
          resetsAtMs: peeked.resetsAtMs,
          headers: providerResponse.headers,
        },
        softRetryCount,
      );
      if (decision.action !== "retry-same-auth") break;
      softRetryCount++;
      log?.warn?.(
        "RATELIMIT",
        `${provider.toUpperCase()} | soft 429, instant retry #${softRetryCount} in ${decision.waitMs}ms (same auth)`,
      );
      if (decision.waitMs > 0) {
        try {
          await waitForAbortableDelay(decision.waitMs, streamController.signal);
        } catch (error) {
          if (error.name === "AbortError") {
            streamController.handleError(error);
            return createErrorResult(499, "Request aborted");
          }
          throw error;
        }
      }
      try {
        const r = await runExecutor();
        providerResponse = r.response;
        providerUrl = r.url;
        providerHeaders = r.headers;
        finalBody = r.transformedBody;
        providerObjectStream = r.kiroObjectStream || null;
        providerResponseFormat = r.responseFormat || targetFormat;
      } catch (e) {
        log?.warn?.(
          "RATELIMIT",
          `${provider.toUpperCase()} | soft-retry threw: ${e.message}`,
        );
        break;
      }
    }
  }

  // Provider returned error
  if (!providerResponse.ok) {
    trackPendingRequest(model, provider, connectionId, false, true);
    const { statusCode, message, resetsAtMs } = await parseUpstreamError(
      providerResponse,
      executor,
    );
    appendRequestLog({
      model,
      provider,
      connectionId,
      status: `FAILED ${statusCode}`,
    }).catch(() => {});
    saveRequestDetail(
      buildRequestDetail({
        provider,
        model,
        connectionId,
        latency: { ttft: 0, total: Date.now() - requestStartTime },
        tokens: { prompt_tokens: 0, completion_tokens: 0 },
        request: extractRequestConfig(body, stream),
        providerRequest: finalBody || translatedBody || null,
        response: { error: message, status: statusCode, thinking: null },
        status: "error",
      }),
    ).catch(() => {});

    const errMsg = formatProviderError(
      new Error(message),
      provider,
      model,
      statusCode,
    );
    console.log(`${COLORS.red}[ERROR] ${errMsg}${COLORS.reset}`);
    reqLogger.logError(new Error(message), finalBody || translatedBody);
    return createErrorResult(statusCode, errMsg, resetsAtMs);
  }

  const sharedCtx = {
    provider,
    model,
    body,
    stream,
    translatedBody,
    finalBody,
    requestStartTime,
    connectionId,
    apiKey,
    clientRawRequest,
    onRequestSuccess,
    midStreamResumeEnabled,
    // PxPipe compression stats — included so requestDetail builders can persist them.
    pxpipe: pxpipeSummary || undefined,
  };
  const appendLog = (extra) =>
    appendRequestLog({ model, provider, connectionId, ...extra }).catch(
      () => {},
    );
  const trackDone = () =>
    trackPendingRequest(model, provider, connectionId, false);

  // Provider forced streaming but client wants JSON
  if (!clientRequestedStreaming && providerRequiresStreaming) {
    const result = await handleForcedSSEToJson({
      ...sharedCtx,
      providerResponse,
      sourceFormat,
      trackDone,
      appendLog,
    });
    if (result) {
      streamController.handleComplete();
      return result;
    }
  }

  // True non-streaming response
  if (!stream) {
    const result = await handleNonStreamingResponse({
      ...sharedCtx,
      providerResponse,
      sourceFormat,
      targetFormat: providerResponseFormat,
      reqLogger,
      toolNameMap,
      trackDone,
      appendLog,
    });
    streamController.handleComplete();
    return result;
  }

  // Streaming response
  const { onStreamComplete: baseOnStreamComplete, streamDetailId } =
    buildOnStreamComplete({
      ...sharedCtx,
      timing,
    });
  const antigravityReplayKey =
    provider === "antigravity" ? getAntigravitySessionKey(model, body) : null;
  const onStreamComplete = antigravityReplayKey
    ? (contentObj, usage, ttftAt, performance, detailId) => {
        if (contentObj?.thinking) {
          setCachedThinking(antigravityReplayKey, contentObj.thinking);
        }
        return baseOnStreamComplete?.(
          contentObj,
          usage,
          ttftAt,
          performance,
          detailId,
        );
      }
    : baseOnStreamComplete;

  const retryEmptyAntigravityStop =
    provider === "antigravity"
      ? async (attempt) => {
          if (streamController.signal.aborted) {
            throw new DOMException("Client request aborted", "AbortError");
          }
          const continuationBody = buildAntigravityEmptyStopContinuation(
            translatedBody,
          );
          log?.warn?.(
            "RETRY",
            `ANTIGRAVITY | ${model} | empty STOP continuation ${attempt}/2 | same account/session`,
          );
          const retryResult = await executor.execute({
            model,
            body: continuationBody,
            stream,
            credentials,
            providerSessionId: sessionSeed,
            clientTool,
            signal: streamController.signal,
            log,
            proxyOptions,
            emitObjects: wantKiroObjects,
            onProfileArnDiscovered,
            timing,
          });
          if (!retryResult.response?.ok) {
            throw new Error(
              `Empty STOP continuation returned HTTP ${retryResult.response?.status || "unknown"}`,
            );
          }
          reqLogger.logTargetRequest(
            retryResult.url,
            retryResult.headers,
            retryResult.transformedBody,
          );
          return retryResult.response;
        }
      : null;

  return handleStreamingResponse({
    ...sharedCtx,
    providerResponse,
    sourceFormat,
    targetFormat: providerResponseFormat,
    userAgent,
    reqLogger,
    toolNameMap,
    customToolNames,
    streamController,
    onStreamComplete,
    credentials,
    timing,
    streamDetailId,
    kiroObjectStream: providerObjectStream,
    retryEmptyAntigravityStop,
  });
}

export function isTokenExpiringSoon(expiresAt, bufferMs = 5 * 60 * 1000) {
  if (!expiresAt) return false;
  return new Date(expiresAt).getTime() - Date.now() < bufferMs;
}
