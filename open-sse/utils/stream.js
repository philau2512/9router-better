import { translateResponse, initState } from "../translator/index.js";
import { FORMATS } from "../translator/formats.js";
import { trackPendingRequest, appendRequestLog } from "@/lib/usageDb.js";
import {
  extractUsage,
  mergeUsage,
  hasValidUsage,
  estimateUsage,
  logUsage,
  addBufferToUsage,
  filterUsageForFormat,
  COLORS,
} from "./usageTracking.js";
import {
  parseSSELine,
  hasValuableContent,
  fixInvalidId,
  formatSSE,
} from "./streamHelpers.js";
import {
  getOpenAIResponsesEventName,
  isOpenAIResponsesTerminalEvent,
  formatIncompleteOpenAIResponsesStreamFailure,
  createOutputItemCollector,
  collectOutputItemDone,
  patchCompletedOutput,
} from "./responsesStreamHelpers.js";
import { dbg, isDebugEnabled } from "./debugLog.js";
import * as log from "../../src/sse/utils/logger.js";

export { COLORS, formatSSE };

// sharedEncoder is stateless — safe to share across streams
const sharedEncoder = new TextEncoder();

/**
 * Stream modes
 */
const STREAM_MODE = {
  TRANSLATE: "translate", // Full translation between formats
  PASSTHROUGH: "passthrough", // No translation, normalize output, extract usage
};

// Upper bound on the deferred response.completed wait: a chat->responses stream
// that saw finish_reason without usage must not hold the client's terminal event
// forever when the upstream stalls with no usage trailer and no [DONE].
const PENDING_COMPLETION_FLUSH_MS = 3000;

/**
 * Create unified SSE transform stream
 * @param {object} options
 * @param {string} options.mode - Stream mode: translate, passthrough
 * @param {string} options.targetFormat - Provider format (for translate mode)
 * @param {string} options.sourceFormat - Client format (for translate mode)
 * @param {string} options.provider - Provider name
 * @param {object} options.reqLogger - Request logger instance
 * @param {string} options.model - Model name
 * @param {string} options.connectionId - Connection ID for usage tracking
 * @param {object} options.body - Request body (for input token estimation)
 * @param {function} options.onStreamComplete - Callback when stream completes (content, usage)
 * @param {string} options.apiKey - API key for usage tracking
 */
/**
 * Visible assistant text only (not thinking/reasoning, not whitespace).
 * Used for TTFT "first text" — aligned with cursor-byok firstTextToken semantics.
 */
export function isNonEmptyVisibleText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Build passive stream performance metrics.
 * TTFT baseline MUST be request entry (requestStartTime), not transform creation —
 * createSSEStream only runs after upstream headers/body are already available.
 *
 * firstTokenTime = first **visible text** (not thinking/reasoning).
 * t/s uses generation window (first text → endAt), not wall-clock.
 * endTime should be captured at stream flush (before setImmediate DB work).
 */
export function buildStreamPerformance({
  requestStartTime,
  firstTokenTime,
  endTime = Date.now(),
  outTokens = 0,
}) {
  if (!Number.isFinite(firstTokenTime) || !(outTokens > 0)) return null;
  const origin = Number.isFinite(requestStartTime)
    ? requestStartTime
    : firstTokenTime;
  const genMs = Math.max(1, endTime - firstTokenTime);
  return {
    firstTokenMs: Math.max(0, firstTokenTime - origin),
    tokensPerSecond: outTokens / (genMs / 1000),
    durationMs: Math.max(0, endTime - origin),
  };
}

export function createSSEStream(options = {}) {
  const {
    mode = STREAM_MODE.TRANSLATE,
    targetFormat,
    sourceFormat,
    provider = null,
    reqLogger = null,
    toolNameMap = null,
    model = null,
    connectionId = null,
    body = null,
    onStreamComplete = null,
    apiKey = null,
    credentials = null,
    customToolNames = null,
    streamStateTracker = null,
    targetModelAlias = null,
    // Absolute request entry time (ms). Required for correct TTFT; falls back to
    // transform-create time only when callers omit it (tests / legacy).
    requestStartTime = null,
    // Kiro object-mode hand-off skips decode/parse but uses the same translation
    // pipeline as bytes so usage and terminal events remain identical.
    objectInput = false,
  } = options;

  let buffer = "";
  let usage = null;

  // Performance tracking — anchor TTFT to request entry when available.
  // firstTokenTime = first visible text only (not thinking/reasoning).
  const startTime = Number.isFinite(requestStartTime)
    ? requestStartTime
    : Date.now();
  let firstTokenTime = null;
  const noteFirstVisibleText = () => {
    if (!firstTokenTime) firstTokenTime = Date.now();
  };
  let completionTokenCount = 0;

  // Per-stream decoder with stream:true to correctly handle multi-byte chars split across chunks
  const decoder = new TextDecoder("utf-8", { fatal: false });

  const resumedAfterAntigravityThought =
    targetFormat === FORMATS.ANTIGRAVITY &&
    Boolean(streamStateTracker?.accumulatedThinking);
  const state =
    mode === STREAM_MODE.TRANSLATE
      ? {
          ...initState(sourceFormat),
          provider,
          toolNameMap,
          customToolNames: new Set(customToolNames || []),
          model,
          sessionId: credentials?._clientSessionId || null,
          geminiSawThought: resumedAfterAntigravityThought,
          // Which upstream format this stream came from. A response translator can be
          // reached either directly (target === its registered source) or as the second
          // hop of a pivot, and on the terminal null chunk the pivot drops it — so a
          // translator that defers closing events until flush needs to know which case
          // it is in. Absent/undefined means "unknown", i.e. do not defer.
          targetFormat,
        }
      : null;
  if (streamStateTracker) {
    streamStateTracker.emptyProviderResponse = false;
    streamStateTracker.hasMeaningfulProviderOutput = false;
  }

  let totalContentLength = 0;
  let accumulatedContent = streamStateTracker?.accumulatedContent || "";
  let accumulatedThinking = streamStateTracker?.accumulatedThinking || "";
  let ttftAt = null;
  let firstRawChunkLogged = false;
  let firstParsedEventLogged = false;
  let firstEmittedChunkAt = null;
  let firstEmittedChunkBytes = 0;
  let sseLineCount = 0;
  let sseEmittedCount = 0;
  const eventTypeCounts = {};
  const streamStartAt = Date.now();
  const emitFirstChunkLog = (output, meta = {}) => {
    if (firstEmittedChunkAt) return;
    firstEmittedChunkAt = Date.now();
    firstEmittedChunkBytes = sharedEncoder.encode(output || "").byteLength;
    log.debug(
      "SSE-FIRST",
      `${provider || "unknown"}/${model || "unknown"} | mode=${mode} | firstEmitMs=${firstEmittedChunkAt - streamStartAt}ms | bytes=${firstEmittedChunkBytes}${meta.kind ? ` | kind=${meta.kind}` : ""}`,
    );
  };
  // rawChunkEncoder removed — use sharedEncoder (module-level)

  const updateTracker = () => {
    if (streamStateTracker) {
      streamStateTracker.accumulatedContent = accumulatedContent;
      streamStateTracker.accumulatedThinking = accumulatedThinking;
      streamStateTracker.totalContentLength = totalContentLength;
      streamStateTracker.inThinking =
        accumulatedThinking.length > 0 && accumulatedContent.length === 0;
    }
  };

  // Track Responses API event framing for same-format passthrough (codex)
  let currentOpenAIResponsesEvent = null;
  let openAIResponsesTerminalSeen = false;
  let openAIResponsesDoneSent = false;
  let streamDoneSent = false; // track duplicate [DONE] across transform + flush
  let completionFlushTimer = null;
  const outputItemCollector = createOutputItemCollector(); // Phase 4: Codex output reconstruction

  // Emit the deferred response.completed now — at [DONE], or when the watchdog
  // below gives up on a usage trailer that never arrives.
  const flushPendingCompletion = (controller) => {
    if (completionFlushTimer) {
      clearTimeout(completionFlushTimer);
      completionFlushTimer = null;
    }
    const completed = translateResponse(targetFormat, sourceFormat, null, state);
    for (const item of completed || []) {
      if (item === null || item === undefined) continue;
      const output = formatSSE(item, sourceFormat);
      reqLogger?.appendConvertedChunk?.(output);
      controller.enqueue(sharedEncoder.encode(output));
      sseEmittedCount++;
    }
  };

  // Translate a single already-parsed event object into client-format SSE bytes.
  // Shared by the byte line-loop (after parseSSELine) AND the Phase 3 object-input
  // fast path, so all translate-branch side effects run once, identically, in
  // both modes. `parsed` may be a provider chunk object or the { done: true }
  // sentinel. Returns nothing; enqueues to `controller`.
  const translateOneEvent = (parsed, controller) => {
    if (!firstParsedEventLogged) {
      firstParsedEventLogged = true;
      log.debug(
        "SSE-FIRST",
        `${provider || "unknown"}/${model || "unknown"} | mode=${mode} | firstEvent=${parsed.type || parsed.event || "unknown"}`,
      );
    }

    // Responses API same-format passthrough: preserve event framing + track terminal state
    const isOpenAIResponsesStream = targetFormat === FORMATS.OPENAI_RESPONSES;
    const keepsOpenAIResponsesFormat =
      isOpenAIResponsesStream && sourceFormat === FORMATS.OPENAI_RESPONSES;
    const openAIResponsesEventName = isOpenAIResponsesStream
      ? getOpenAIResponsesEventName(currentOpenAIResponsesEvent, parsed)
      : null;

    if (
      isOpenAIResponsesStream &&
      isOpenAIResponsesTerminalEvent(openAIResponsesEventName, parsed)
    ) {
      openAIResponsesTerminalSeen = true;
    }

    // For Ollama: done=true is the final chunk with finish_reason/usage, must translate
    // For other formats: done=true is the [DONE] sentinel, skip
    if (parsed && parsed.done && targetFormat !== FORMATS.OLLAMA) {
      // A direct Chat-to-Responses translation can defer response.completed
      // while waiting for a usage trailer. [DONE] ends that opportunity even
      // if the upstream keeps the HTTP connection open, so finish now.
      if (
        targetFormat === FORMATS.OPENAI &&
        sourceFormat === FORMATS.OPENAI_RESPONSES &&
        state?.completionPending &&
        !state?.completedSent
      ) {
        flushPendingCompletion(controller);
      }

      // Synthesize response.failed if the Responses stream never sent a terminal event
      if (keepsOpenAIResponsesFormat && !openAIResponsesTerminalSeen) {
        const failedOutput = formatIncompleteOpenAIResponsesStreamFailure();
        reqLogger?.appendConvertedChunk?.(failedOutput);
        controller.enqueue(sharedEncoder.encode(failedOutput));
        openAIResponsesTerminalSeen = true;
        sseEmittedCount++;
      }

      // [DONE] not emitted in translate mode — some clients' SSE decoders
      // fail to parse the OpenAI sentinel on Claude-format translated streams.
      // message_stop already signals end-of-response; stream close handles it.
      streamDoneSent = true;
      return;
    }

    // Claude format - content (visible text → TTFT)
    if (isNonEmptyVisibleText(parsed.delta?.text)) {
      totalContentLength += parsed.delta.text.length;
      accumulatedContent += parsed.delta.text;
      noteFirstVisibleText();
    }
    // Claude format - thinking (not TTFT)
    if (parsed.delta?.thinking) {
      totalContentLength += parsed.delta.thinking.length;
      accumulatedThinking += parsed.delta.thinking;
    }

    // OpenAI format - content (visible text → TTFT)
    if (isNonEmptyVisibleText(parsed.choices?.[0]?.delta?.content)) {
      totalContentLength += parsed.choices[0].delta.content.length;
      accumulatedContent += parsed.choices[0].delta.content;
      noteFirstVisibleText();
    }
    // OpenAI format - reasoning (not TTFT)
    if (parsed.choices?.[0]?.delta?.reasoning_content) {
      totalContentLength += parsed.choices[0].delta.reasoning_content.length;
      accumulatedThinking += parsed.choices[0].delta.reasoning_content;
    }

    // OpenAI Responses format (Codex) - visible text is carried directly in
    // `delta`, not under Chat Completions' choices[].delta.content.
    if (
      parsed.type === "response.output_text.delta" &&
      isNonEmptyVisibleText(parsed.delta)
    ) {
      totalContentLength += parsed.delta.length;
      accumulatedContent += parsed.delta;
      noteFirstVisibleText();
    }

    // Gemini format — only non-thought visible text counts as first text.
    // Antigravity unmarked parts are buffered (may become thinking); skip TTFT here.
    const geminiResponse = parsed.response || parsed;
    if (geminiResponse.candidates?.[0]?.content?.parts) {
      for (const part of geminiResponse.candidates[0].content.parts) {
        if (part.text && typeof part.text === "string") {
          totalContentLength += part.text.length;
          if (part.thought === true) {
            accumulatedThinking += part.text;
          } else if (targetFormat !== FORMATS.ANTIGRAVITY) {
            accumulatedContent += part.text;
            if (isNonEmptyVisibleText(part.text)) noteFirstVisibleText();
          }
        }
      }
    }

    // Extract usage and track completion tokens
    const extracted = extractUsage(parsed);
    if (extracted) {
      state.usage = mergeUsage(state.usage, extracted);
      // Track completion token count for TPS calculation
      if (extracted.completion_tokens > completionTokenCount) {
        completionTokenCount = extracted.completion_tokens;
      }
    }

    // Codex output_item.done reconstruction (Phase 4)
    if (
      keepsOpenAIResponsesFormat &&
      parsed.type === "response.output_item.done"
    ) {
      collectOutputItemDone(outputItemCollector, parsed);
    }
    if (keepsOpenAIResponsesFormat && parsed.type === "response.completed") {
      const patched = patchCompletedOutput(parsed, outputItemCollector);
      if (patched !== parsed) {
        const output = formatSSE(
          {
            event: openAIResponsesEventName || "response.completed",
            data: patched,
          },
          sourceFormat,
        );
        reqLogger?.appendConvertedChunk?.(output);
        controller.enqueue(sharedEncoder.encode(output));
        currentOpenAIResponsesEvent = null;
        sseEmittedCount++;
        return;
      }
    }

    // Responses same-format passthrough: re-emit with original event framing
    if (keepsOpenAIResponsesFormat && openAIResponsesEventName) {
      const output = formatSSE(
        { event: openAIResponsesEventName, data: parsed },
        sourceFormat,
      );
      reqLogger?.appendConvertedChunk?.(output);
      controller.enqueue(sharedEncoder.encode(output));
      currentOpenAIResponsesEvent = null;
      sseEmittedCount++;
      return;
    }

    currentOpenAIResponsesEvent = null;

    // Translate: targetFormat -> openai -> sourceFormat
    const translated = translateResponse(
      targetFormat,
      sourceFormat,
      parsed,
      state,
    );

    // Log OpenAI intermediate chunks (if available)
    if (translated?._openaiIntermediate) {
      for (const item of translated._openaiIntermediate) {
        const openaiOutput = formatSSE(item, FORMATS.OPENAI);
        reqLogger?.appendOpenAIChunk?.(openaiOutput);
      }
    }

    if (translated?.length > 0) {
      const isEmptyAntigravityResponse =
        targetFormat === FORMATS.ANTIGRAVITY &&
        state.emptyProviderResponse === true;
      if (targetFormat === FORMATS.ANTIGRAVITY && streamStateTracker) {
        streamStateTracker.emptyProviderResponse = isEmptyAntigravityResponse;
        streamStateTracker.hasMeaningfulProviderOutput =
          state.geminiToolCallCount > 0 ||
          state.geminiEmittedVisible === true;
      }
      for (const item of translated) {
        // Empty STOP is retryable for Antigravity. Do not leak any event from
        // this discarded attempt, including Responses lifecycle events, before
        // streamHandler replaces it with a same-account retry.
        if (isEmptyAntigravityResponse) {
          continue;
        }
        if (item === null || item === undefined) continue;
        if (!hasValuableContent(item, sourceFormat)) continue;

        // Antigravity's unmarked text after thought is ambiguous until the
        // response translator decides whether to emit or discard it. Track
        // only the translated visible content so stream resume never prefills
        // private reasoning, while normal terminal responses keep their text.
        const confirmedVisibleContent =
          item.choices?.[0]?.delta?.content ||
          (item.type === "content_block_delta" &&
          item.delta?.type === "text_delta"
            ? item.delta.text
            : "") ||
          (item.data?.type === "response.output_text.delta"
            ? item.data.delta
            : "");
        if (targetFormat === FORMATS.ANTIGRAVITY && confirmedVisibleContent) {
          accumulatedContent += confirmedVisibleContent;
        }

        // Inject estimated usage if finish chunk has no valid usage
        const isFinishChunk =
          item.type === "message_delta" || item.choices?.[0]?.finish_reason;
        if (
          state.finishReason &&
          isFinishChunk &&
          !hasValidUsage(item.usage) &&
          totalContentLength > 0
        ) {
          const estimated = estimateUsage(
            body,
            totalContentLength,
            sourceFormat,
          );
          item.usage = filterUsageForFormat(estimated, sourceFormat);
          state.usage = estimated;
        } else if (state.finishReason && isFinishChunk && state.usage) {
          const buffered = addBufferToUsage(state.usage);
          item.usage = filterUsageForFormat(buffered, sourceFormat);
        }

        const output = formatSSE(item, sourceFormat);
        reqLogger?.appendConvertedChunk?.(output);
        emitFirstChunkLog(output, { kind: item.type || "translated" });
        controller.enqueue(sharedEncoder.encode(output));
        sseEmittedCount++;
      }

      // The completion deferral can outlive the upstream: a broken chat upstream
      // may stall after finish_reason with no usage trailer and no [DONE], holding
      // the connection open. Bound the wait so the client still gets a terminal event.
      if (
        targetFormat === FORMATS.OPENAI &&
        sourceFormat === FORMATS.OPENAI_RESPONSES &&
        state?.completionPending &&
        !state?.completedSent &&
        !completionFlushTimer
      ) {
        completionFlushTimer = setTimeout(() => {
          completionFlushTimer = null;
          if (state?.completedSent) return;
          try {
            flushPendingCompletion(controller);
          } catch {
            /* controller already closed */
          }
        }, PENDING_COMPLETION_FLUSH_MS);
      }
    }
  };

  return new TransformStream({
    transform(chunk, controller) {
      if (!ttftAt) ttftAt = Date.now();

      // Phase 3 (option c) object-input fast path: `chunk` is an already-parsed
      // OpenAI event object (or { done: true }) handed off directly by Kiro's
      // object-mode decode. Skip decode/line-split/JSON.parse and translate it
      // through the exact same pipeline as the byte path.
      if (objectInput) {
        if (isDebugEnabled) sseLineCount++;
        translateOneEvent(chunk, controller);
        updateTracker();
        return;
      }

      const text = decoder.decode(chunk, { stream: true });
      if (!firstRawChunkLogged) {
        firstRawChunkLogged = true;
        log.debug(
          "SSE-FIRST",
          `${provider || "unknown"}/${model || "unknown"} | mode=${mode} | firstRawMs=${Date.now() - streamStartAt}ms | bytes=${sharedEncoder.encode(text).byteLength}`,
        );
      }
      buffer += text;
      reqLogger?.appendProviderChunk?.(text);

      // Phase 5(a): iterate complete lines via indexOf instead of allocating a
      // whole lines[] array from split("\n") each chunk. The partial-line carry
      // is preserved (the incomplete trailing segment stays in `buffer`) and
      // lines are processed strictly in order, so a Responses `event:` line is
      // still seen before its paired `data:` line within the same chunk.
      let lineStart = 0;
      let nlIdx;
      while ((nlIdx = buffer.indexOf("\n", lineStart)) !== -1) {
        const line = buffer.slice(lineStart, nlIdx);
        lineStart = nlIdx + 1;
        const trimmed = line.trim();
        if (isDebugEnabled && trimmed) {
          sseLineCount++;
          if (trimmed.startsWith("event:")) {
            const evt = trimmed.slice(6).trim();
            eventTypeCounts[evt] = (eventTypeCounts[evt] || 0) + 1;
          }
        }

        // Capture Responses API event name to preserve framing in same-format passthrough
        if (
          mode === STREAM_MODE.TRANSLATE &&
          targetFormat === FORMATS.OPENAI_RESPONSES &&
          trimmed.startsWith("event:")
        ) {
          currentOpenAIResponsesEvent = trimmed.slice(6).trim();
        }

        // Passthrough mode: normalize and forward
        if (mode === STREAM_MODE.PASSTHROUGH) {
          // Upstream-emitted [DONE] (e.g. Kiro's own transform emits it): forward
          // once and mark it sent so flush() does not append a SECOND [DONE].
          // (Red Team S3 / Phase 3 double-DONE fix)
          if (
            trimmed.startsWith("data:") &&
            trimmed.slice(5).trim() === "[DONE]"
          ) {
            if (!streamDoneSent) {
              const doneOutput = "data: [DONE]\n\n";
              reqLogger?.appendConvertedChunk?.(doneOutput);
              controller.enqueue(sharedEncoder.encode(doneOutput));
              streamDoneSent = true;
            }
            continue;
          }

          let output;
          let injectedUsage = false;

          // Fast-path: forward raw SSE without JSON.parse for pure delta chunks
          // Conservative heuristics — false positive = falls through to full parse
          if (
            trimmed.startsWith("data:") &&
            trimmed.slice(5).trim() !== "[DONE]"
          ) {
            const dataStr = trimmed.slice(5).trim();
            // ORDERING MATTERS: Azure fields must be checked before hasContent (R2-F8)
            // OpenAI Responses API uses event/data pairs with types like
            // response.output_text.delta / response.reasoning_summary_text.delta.
            // Those payloads carry text in `delta`, not chat-completions
            // `choices[].delta.content`. Treating them as "empty" drops the body
            // while still forwarding bare `event:` lines — clients then only see
            // rare tokens that accidentally match other heuristics (e.g. "usage").
            const isOpenAIResponsesChunk =
              dataStr.includes('"type":"response.') ||
              dataStr.includes('"type": "response.');
            const needsFullParse =
              dataStr.includes('"finish_reason"') ||
              dataStr.includes('"prompt_filter_results"') ||
              dataStr.includes('"content_filter_results"') || // Azure — before hasContent (R2-F8)
              dataStr.includes('"usage"') ||
              dataStr.includes('"id":"') || // tighter than '"id":' to avoid content false positives (R2-F7)
              isOpenAIResponsesChunk;

            if (!needsFullParse) {
              const hasContent =
                dataStr.includes('"content":') ||
                dataStr.includes('"reasoning_content":');

              if (!hasContent) {
                updateTracker();
                continue; // empty delta — skip (F7)
              }

              // Accurate first-text TTFT: content-bearing chunks before first
              // visible text must full-parse (fast-path cannot distinguish
              // "content":"" / null / reasoning-only from real text).
              if (!firstTokenTime) {
                // fall through to full JSON parse below
              } else {
                // Track reasoning for semantic stall watchdog (F3)
                if (
                  dataStr.includes('"reasoning_content":') &&
                  streamStateTracker
                ) {
                  streamStateTracker.inThinking = true;
                }

                // Rough token estimate only — no regex content extraction (F6)
                // accumulatedContent not populated from fast-path (R2-F6 trade-off)
                totalContentLength += Math.ceil(dataStr.length / 4);
                updateTracker(); // F10 + R2-F2

                const fastOutput =
                  line.startsWith("data:") && !line.startsWith("data: ")
                    ? "data: " + line.slice(5) + "\n"
                    : line + "\n";

                emitFirstChunkLog(fastOutput, { kind: "passthrough-fast" }); // R2-F1
                reqLogger?.appendConvertedChunk?.(fastOutput);
                controller.enqueue(sharedEncoder.encode(fastOutput));
                sseEmittedCount++;
                continue;
              }
            }
          }

          if (
            trimmed.startsWith("data:") &&
            trimmed.slice(5).trim() !== "[DONE]"
          ) {
            try {
              const parsed = JSON.parse(trimmed.slice(5).trim());

              const idFixed = fixInvalidId(parsed);

              // Ensure OpenAI-required fields are present on streaming chunks (Letta compat)
              let fieldsInjected = false;
              if (parsed.choices !== undefined) {
                if (!parsed.object) {
                  parsed.object = "chat.completion.chunk";
                  fieldsInjected = true;
                }
                if (!parsed.created) {
                  parsed.created = Math.floor(Date.now() / 1000);
                  fieldsInjected = true;
                }
              }

              // Strip Azure-specific non-standard fields from streaming chunks
              if (parsed.prompt_filter_results !== undefined) {
                delete parsed.prompt_filter_results;
                fieldsInjected = true;
              }
              if (parsed?.choices) {
                for (const choice of parsed.choices) {
                  if (choice.content_filter_results !== undefined) {
                    delete choice.content_filter_results;
                    fieldsInjected = true;
                  }
                }
              }

              // Rewrite model alias so client receives the alias they requested (Phase 2)
              if (
                targetModelAlias &&
                parsed.model &&
                parsed.model !== targetModelAlias
              ) {
                parsed.model = targetModelAlias;
                fieldsInjected = true;
              }
              if (
                targetModelAlias &&
                parsed.response?.model &&
                parsed.response.model !== targetModelAlias
              ) {
                parsed.response = {
                  ...parsed.response,
                  model: targetModelAlias,
                };
                fieldsInjected = true;
              }

              // Strip empty tool_calls arrays that break AI SDK reasoning tracking.
              // Some providers (e.g. CodeBuddy CN) include `"tool_calls": []` in
              // every streaming delta. @ai-sdk/openai-compatible checks
              // `delta.tool_calls != null` — an empty array passes this check,
              // causing premature `reasoning-end` on every chunk.
              if (parsed?.choices) {
                for (const choice of parsed.choices) {
                  if (
                    choice.delta?.tool_calls &&
                    Array.isArray(choice.delta.tool_calls) &&
                    choice.delta.tool_calls.length === 0
                  ) {
                    delete choice.delta.tool_calls;
                    fieldsInjected = true;
                  }
                }
              }

              if (!hasValuableContent(parsed, FORMATS.OPENAI)) {
                continue;
              }

              const delta = parsed.choices?.[0]?.delta;
              const content = delta?.content;
              const reasoning = delta?.reasoning_content;
              if (content && typeof content === "string") {
                totalContentLength += content.length;
                accumulatedContent += content;
              }
              if (reasoning && typeof reasoning === "string") {
                totalContentLength += reasoning.length;
                accumulatedThinking += reasoning;
              }
              // Responses API: stream text is top-level `delta` on *.delta events
              if (
                typeof parsed?.delta === "string" &&
                typeof parsed?.type === "string" &&
                parsed.type.startsWith("response.") &&
                parsed.type.endsWith(".delta")
              ) {
                totalContentLength += parsed.delta.length;
                if (parsed.type.includes("reasoning")) {
                  accumulatedThinking += parsed.delta;
                } else if (
                  parsed.type.includes("output_text") ||
                  parsed.type.includes("refusal")
                ) {
                  accumulatedContent += parsed.delta;
                }
              }

              const extracted = extractUsage(parsed);
              if (extracted) {
                usage = mergeUsage(usage, extracted);
                if (extracted.completion_tokens > completionTokenCount) {
                  completionTokenCount = extracted.completion_tokens;
                }
              }

              // Track first visible text for TTFT / t/s (passthrough full-parse).
              // Thinking / reasoning / empty content do NOT count.
              if (!firstTokenTime) {
                if (isNonEmptyVisibleText(parsed.choices?.[0]?.delta?.content)) {
                  noteFirstVisibleText();
                } else if (
                  typeof parsed?.delta === "string" &&
                  typeof parsed?.type === "string" &&
                  parsed.type.startsWith("response.") &&
                  parsed.type.endsWith(".delta") &&
                  !parsed.type.includes("reasoning") &&
                  (parsed.type.includes("output_text") ||
                    parsed.type.includes("refusal")) &&
                  isNonEmptyVisibleText(parsed.delta)
                ) {
                  noteFirstVisibleText();
                }
              }

              const isFinishChunk = parsed.choices?.[0]?.finish_reason;
              if (isFinishChunk && !hasValidUsage(parsed.usage)) {
                const estimated = estimateUsage(
                  body,
                  totalContentLength,
                  FORMATS.OPENAI,
                );
                parsed.usage = filterUsageForFormat(estimated, FORMATS.OPENAI);
                output = `data: ${JSON.stringify(parsed)}\n`;
                usage = estimated;
                injectedUsage = true;
              } else if (isFinishChunk && usage) {
                const buffered = addBufferToUsage(usage);
                parsed.usage = filterUsageForFormat(buffered, FORMATS.OPENAI);
                output = `data: ${JSON.stringify(parsed)}\n`;
                injectedUsage = true;
              } else if (idFixed || fieldsInjected) {
                output = `data: ${JSON.stringify(parsed)}\n`;
                injectedUsage = true;
              }
            } catch {
              // Skip non-JSON data lines silently — don't forward garbage to clients.
              // Upstream providers sometimes return plain-text errors (HTML, rate-limit
              // messages) in the SSE stream that would break downstream JSON decoders.
              continue;
            }
          }

          if (!injectedUsage) {
            if (line.startsWith("data:") && !line.startsWith("data: ")) {
              output = "data: " + line.slice(5) + "\n";
            } else {
              output = line + "\n";
            }
          }

          emitFirstChunkLog(output, { kind: "passthrough-full" }); // R2-F1
          reqLogger?.appendConvertedChunk?.(output);
          controller.enqueue(sharedEncoder.encode(output));
          updateTracker(); // R2-F2
          continue;
        }

        // Translate mode
        if (!trimmed) continue;
        const parsed = parseSSELine(trimmed, targetFormat);
        if (!parsed) continue;
        // Shared translate pipeline (also used by the Phase 3 object-input path).
        translateOneEvent(parsed, controller);
      }
      // Keep only the incomplete trailing segment (after the last newline) for
      buffer = lineStart > 0 ? buffer.slice(lineStart) : buffer;
      updateTracker();
    },

    flush(controller) {
      const evtSummary =
        Object.entries(eventTypeCounts)
          .map(([k, v]) => `${k}=${v}`)
          .join(",") || "none";
      dbg(
        "SSE",
        `flush | provider=${provider} | model=${model} | recvLines=${sseLineCount} | emitted=${sseEmittedCount} | events=[${evtSummary}]`,
      );
      trackPendingRequest(model, provider, connectionId, false);
      try {
        const remaining = decoder.decode();
        if (remaining) buffer += remaining;

        if (mode === STREAM_MODE.PASSTHROUGH) {
          if (buffer) {
            let output = buffer;
            if (buffer.startsWith("data:") && !buffer.startsWith("data: ")) {
              output = "data: " + buffer.slice(5);
            }
            reqLogger?.appendConvertedChunk?.(output);
            controller.enqueue(sharedEncoder.encode(output));
          }

          // IMPORTANT: Enqueue [DONE] sentinel FIRST — before any heavy logging.
          // Clients (e.g. OpenClaw) can hang without it.
          if (!streamDoneSent) {
            const doneOutput = "data: [DONE]\n\n";
            reqLogger?.appendConvertedChunk?.(doneOutput);
            controller.enqueue(sharedEncoder.encode(doneOutput));
          }

          // Defer heavy operations (usage estimation, DB writes) to next tick
          // so the stream closes immediately for the client.
          // Capture endAt HERE (not inside setImmediate) for accurate gen t/s.
          const endAt = Date.now();
          const _usage = usage;
          const _body = body;
          const _totalContentLength = totalContentLength;
          const _accumulatedContent = accumulatedContent;
          const _accumulatedThinking = accumulatedThinking;
          const _ttftAt = ttftAt;
          const _startTime = startTime;
          const _firstTokenTime = firstTokenTime;
          const _completionTokenCount = completionTokenCount;
          const _endAt = endAt;
          setImmediate(() => {
            let finalUsage = _usage;
            if (!hasValidUsage(finalUsage) && _totalContentLength > 0) {
              finalUsage = estimateUsage(
                _body,
                _totalContentLength,
                FORMATS.OPENAI,
              );
            }
            
            // Calculate performance metrics (TTFT from request entry + gen t/s)
            const outTokens =
              _completionTokenCount ||
              finalUsage?.completion_tokens ||
              finalUsage?.output_tokens ||
              0;
            const performance = buildStreamPerformance({
              requestStartTime: _startTime,
              firstTokenTime: _firstTokenTime,
              endTime: _endAt,
              outTokens,
            });
            
            if (hasValidUsage(finalUsage)) {
              logUsage(provider, finalUsage, model, connectionId, apiKey);
            } else {
              appendRequestLog({
                model,
                provider,
                connectionId,
                tokens: null,
                status: "200 OK",
              }).catch(() => {});
            }
            if (onStreamComplete) {
              onStreamComplete(
                {
                  content: _accumulatedContent,
                  thinking: _accumulatedThinking,
                },
                finalUsage,
                _ttftAt,
                performance,
              );
            }
          });
          return;
        }

        if (buffer.trim()) {
          const parsed = parseSSELine(buffer.trim());
          if (parsed) {
            // Use the normal translation path so terminal events without a
            // trailing newline update confirmed content before resume/logging.
            translateOneEvent(parsed, controller);
            updateTracker();
          }
        }

        if (completionFlushTimer) {
          clearTimeout(completionFlushTimer);
          completionFlushTimer = null;
        }

        const flushed = translateResponse(
          targetFormat,
          sourceFormat,
          null,
          state,
        );

        if (flushed?._openaiIntermediate) {
          for (const item of flushed._openaiIntermediate) {
            const openaiOutput = formatSSE(item, FORMATS.OPENAI);
            reqLogger?.appendOpenAIChunk?.(openaiOutput);
          }
        }

        if (flushed?.length > 0) {
          for (const item of flushed) {
            if (item === null || item === undefined) continue;
            const output = formatSSE(item, sourceFormat);
            reqLogger?.appendConvertedChunk?.(output);
            emitFirstChunkLog(output, { kind: item.type || "tail-translated" });
            controller.enqueue(sharedEncoder.encode(output));
          }
        }

        // Synthesize response.failed if a Responses passthrough stream never reached a terminal event
        const keepsOpenAIResponsesFormat =
          targetFormat === FORMATS.OPENAI_RESPONSES &&
          sourceFormat === FORMATS.OPENAI_RESPONSES;
        if (keepsOpenAIResponsesFormat && !openAIResponsesTerminalSeen) {
          const failedOutput = formatIncompleteOpenAIResponsesStreamFailure();
          reqLogger?.appendConvertedChunk?.(failedOutput);
          controller.enqueue(sharedEncoder.encode(failedOutput));
          openAIResponsesTerminalSeen = true;
        }

        // [DONE] not emitted in plain translate mode — message_stop already signals end-of-stream.
        // OpenAI Responses format (Codex) clients still need [DONE] for protocol compatibility.
        if (keepsOpenAIResponsesFormat && !openAIResponsesDoneSent) {
          const doneOutput = "data: [DONE]\n\n";
          reqLogger?.appendConvertedChunk?.(doneOutput);
          controller.enqueue(sharedEncoder.encode(doneOutput));
        }

        // Defer heavy operations (usage estimation, DB writes) to next tick.
        // Capture endAt HERE (not inside setImmediate) for accurate gen t/s.
        const endAt = Date.now();
        const _state = state;
        const _body = body;
        const _totalContentLength = totalContentLength;
        const _accumulatedContent = accumulatedContent;
        const _accumulatedThinking = accumulatedThinking;
        const _ttftAt = ttftAt;
        const _startTime = startTime;
        const _firstTokenTime = firstTokenTime;
        const _completionTokenCount = completionTokenCount;
        const _endAt = endAt;
        setImmediate(() => {
          if (!hasValidUsage(_state?.usage) && _totalContentLength > 0) {
            _state.usage = estimateUsage(
              _body,
              _totalContentLength,
              sourceFormat,
            );
          }
          
          // Calculate performance metrics (TTFT from request entry + gen t/s)
          const finalUsage = _state?.usage;
          const outTokens =
            _completionTokenCount ||
            finalUsage?.completion_tokens ||
            finalUsage?.output_tokens ||
            0;
          const performance = buildStreamPerformance({
            requestStartTime: _startTime,
            firstTokenTime: _firstTokenTime,
            endTime: _endAt,
            outTokens,
          });
          
          if (hasValidUsage(_state?.usage)) {
            logUsage(
              _state.provider || targetFormat,
              _state.usage,
              model,
              connectionId,
              apiKey,
            );
          } else {
            appendRequestLog({
              model,
              provider,
              connectionId,
              tokens: null,
              status: "200 OK",
            }).catch(() => {});
          }
          if (onStreamComplete) {
            onStreamComplete(
              { content: _accumulatedContent, thinking: _accumulatedThinking },
              _state?.usage,
              _ttftAt,
              performance,
            );
          }
        });
      } catch (error) {
        console.log("Error in flush:", error);
      }
    },
  });
}

export function createSSETransformStreamWithLogger(
  targetFormat,
  sourceFormat,
  provider = null,
  reqLogger = null,
  toolNameMap = null,
  model = null,
  connectionId = null,
  body = null,
  onStreamComplete = null,
  apiKey = null,
  streamStateTracker = null,
  requestStartTime = null,
  customToolNames = null,
  credentials = null,
) {
  return createSSEStream({
    mode: STREAM_MODE.TRANSLATE,
    targetFormat,
    sourceFormat,
    provider,
    reqLogger,
    toolNameMap,
    model,
    connectionId,
    body,
    onStreamComplete,
    apiKey,
    streamStateTracker,
    requestStartTime,
    customToolNames,
    credentials,
  });
}

// Phase 3 (option c): object-input translate transform. Consumes Kiro's
// object-mode decode output (parsed OpenAI chunk objects + { done: true }) and
// emits client-format SSE bytes, skipping the serialize->reparse round-trip.
// Same signature/semantics as createSSETransformStreamWithLogger, just objectInput.
export function createObjectTranslateStreamWithLogger(
  targetFormat,
  sourceFormat,
  provider = null,
  reqLogger = null,
  toolNameMap = null,
  model = null,
  connectionId = null,
  body = null,
  onStreamComplete = null,
  apiKey = null,
  streamStateTracker = null,
  requestStartTime = null,
  customToolNames = null,
  credentials = null,
) {
  return createSSEStream({
    mode: STREAM_MODE.TRANSLATE,
    objectInput: true,
    targetFormat,
    sourceFormat,
    provider,
    reqLogger,
    toolNameMap,
    model,
    connectionId,
    body,
    onStreamComplete,
    apiKey,
    streamStateTracker,
    requestStartTime,
  });
}

export function createPassthroughStreamWithLogger(
  provider = null,
  reqLogger = null,
  model = null,
  connectionId = null,
  body = null,
  onStreamComplete = null,
  apiKey = null,
  streamStateTracker = null,
  targetModelAlias = null,
  requestStartTime = null,
) {
  return createSSEStream({
    mode: STREAM_MODE.PASSTHROUGH,
    provider,
    reqLogger,
    model,
    connectionId,
    body,
    onStreamComplete,
    apiKey,
    streamStateTracker,
    targetModelAlias,
    requestStartTime,
  });
}
