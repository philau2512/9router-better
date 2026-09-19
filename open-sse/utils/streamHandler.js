// Stream handler with disconnect detection - shared for all providers
const _sharedEnc = new TextEncoder(); // module-level — reuse across requests
import {
  STREAM_STALL_TIMEOUT_MS,
  STREAM_SEMANTIC_STALL_TIMEOUT_MS,
} from "../config/runtimeConfig.js";
import { dbg, isDebugEnabled } from "./debugLog.js";
import { executeResumeRequest } from "./streamResumer.js";
import {
  createSSETransformStreamWithLogger,
  createPassthroughStreamWithLogger,
} from "./stream.js";
import { needsTranslation } from "../translator/index.js";
import { hlModel } from "../../src/sse/utils/logger.js";

// Get HH:MM:SS timestamp
function getTimeString() {
  return new Date().toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/**
 * Create stream controller with abort and disconnect detection
 * @param {object} options
 * @param {function} options.onDisconnect - Callback when client disconnects
 * @param {object} options.log - Logger instance
 * @param {string} options.provider - Provider name
 * @param {string} options.model - Model name
 */
export function createStreamController({
  onDisconnect,
  onError,
  log,
  provider,
  model,
  clientSignal,
} = {}) {
  const abortController = new AbortController();
  const startTime = Date.now();
  let disconnected = false;
  let abortTimeout = null;

  const onAbort = () => {
    abortController.abort();
  };

  if (clientSignal) {
    if (clientSignal.aborted) {
      abortController.abort();
    } else {
      clientSignal.addEventListener("abort", onAbort);
    }
  }

  const cleanupClientSignal = () => {
    if (clientSignal) {
      clientSignal.removeEventListener("abort", onAbort);
    }
  };

  const logStream = (status) => {
    const duration = Date.now() - startTime;
    const p = provider?.toUpperCase() || "UNKNOWN";
    console.log(
      `[${getTimeString()}] 🌊 [STREAM] ${p} | ${hlModel(model || "unknown")} | ${duration}ms | ${status}`,
    );
  };

  return {
    signal: abortController.signal,
    startTime,

    isConnected: () => !disconnected,

    // Call when client disconnects
    handleDisconnect: (reason = "client_closed") => {
      if (disconnected) return;
      disconnected = true;
      cleanupClientSignal();

      logStream(`disconnect: ${reason}`);
      // Debug-only: Responses API has no [DONE] sentinel, so codex/droid close the
      // socket on every completed request. "📊 done" is the authoritative outcome line.
      dbg(
        "CTRL",
        `${provider}/${model} | disconnect=${reason} | dur=${Date.now() - startTime}ms`,
      );

      // Delay abort to allow cleanup
      abortTimeout = setTimeout(() => {
        abortController.abort();
      }, 500);

      onDisconnect?.({ reason, duration: Date.now() - startTime });
    },

    // Call when stream completes normally
    handleComplete: () => {
      if (disconnected) return;
      disconnected = true;
      cleanupClientSignal();

      logStream("complete");

      if (abortTimeout) {
        clearTimeout(abortTimeout);
        abortTimeout = null;
      }
    },

    // Call on error
    handleError: (error) => {
      if (disconnected) return;
      disconnected = true;
      cleanupClientSignal();

      if (abortTimeout) {
        clearTimeout(abortTimeout);
        abortTimeout = null;
      }

      if (error.name === "AbortError") {
        logStream("aborted");
        return;
      }

      logStream(`error: ${error.message}`);
      onError?.(error);
    },

    abort: () => {
      cleanupClientSignal();
      abortController.abort();
    },
  };
}

/**
 * Create transform stream with disconnect detection
 * Wraps existing transform stream and adds abort capability.
 *
 * Stall detection lives in pipeWithDisconnect (tied to upstream byte
 * activity), not here — output of the transform stream may be silent
 * for long periods while raw bytes still flow (e.g. Kiro EventStream
 * binary frames buffering, Claude reasoning streams).
 *
 * @param {function} [onAbortTerminal] - Receives a human-readable abort
 * message and returns terminal SSE bytes to emit downstream.
 */
export function createDisconnectAwareStream(
  transformStream,
  streamController,
  onAbortTerminal = null,
  streamStateTracker = null,
  resumeCtx = null,
  onClientFirstChunk = null,
) {
  let reader = transformStream.readable.getReader();
  let writer = transformStream.writable.getWriter();
  let terminalEmitted = false;
  let chunksReceived = 0;
  let resumeAttempts = 0;
  const maxResumeAttempts = 2;
  let emptyStopRetryAttempts = 0;
  const maxEmptyStopRetryAttempts = 2;

  // Emit a synthesized terminal payload (e.g. Responses response.failed + [DONE]) once
  const emitTerminal = (controller) => {
    if (terminalEmitted || !onAbortTerminal) return;
    terminalEmitted = true;
    try {
      const bytes = onAbortTerminal();
      if (bytes) controller.enqueue(bytes);
    } catch {
      /* best-effort terminal */
    }
  };

  return new ReadableStream({
    async pull(controller) {
      if (!streamController.isConnected()) {
        emitTerminal(controller);
        controller.close();
        return;
      }

      try {
        const { done, value } = await reader.read();

        if (done) {
          const canRetryEmptyStop =
            streamController.isConnected() &&
            streamStateTracker?.emptyProviderResponse === true &&
            streamStateTracker.hasMeaningfulProviderOutput !== true &&
            emptyStopRetryAttempts < maxEmptyStopRetryAttempts &&
            typeof resumeCtx?.retryEmptyAntigravityStop === "function";
          if (canRetryEmptyStop) {
            emptyStopRetryAttempts++;
            const backoffMs = emptyStopRetryAttempts === 1 ? 500 : 1500;
            console.warn(
              `[ANTIGRAVITY] Empty STOP; retry ${emptyStopRetryAttempts}/${maxEmptyStopRetryAttempts} with the same account/session after ${backoffMs}ms`,
            );
            await new Promise((resolve) => setTimeout(resolve, backoffMs));
            if (!streamController.isConnected()) {
              controller.close();
              return;
            }
            try {
              const retryResponse = await resumeCtx.retryEmptyAntigravityStop(
                emptyStopRetryAttempts,
              );
              if (!retryResponse?.body) {
                throw new Error("Empty STOP retry returned no stream body");
              }
              await reader.cancel().catch(() => {});
              if (writer && typeof writer.abort === "function") {
                await writer.abort().catch(() => {});
              }
              let retryTransform;
              if (needsTranslation(resumeCtx.sourceFormat, resumeCtx.targetFormat)) {
                retryTransform = createSSETransformStreamWithLogger(
                  resumeCtx.targetFormat,
                  resumeCtx.sourceFormat,
                  resumeCtx.provider,
                  resumeCtx.reqLogger,
                  resumeCtx.toolNameMap,
                  resumeCtx.model,
                  resumeCtx.connectionId,
                  resumeCtx.body,
                  null,
                  resumeCtx.apiKey,
                  streamStateTracker,
                );
              } else {
                retryTransform = createPassthroughStreamWithLogger(
                  resumeCtx.provider,
                  resumeCtx.reqLogger,
                  resumeCtx.model,
                  resumeCtx.connectionId,
                  resumeCtx.body,
                  null,
                  resumeCtx.apiKey,
                  streamStateTracker,
                );
              }
              streamStateTracker.emptyProviderResponse = false;
              streamStateTracker.hasMeaningfulProviderOutput = false;
              chunksReceived = 0;
              reader = retryResponse.body.pipeThrough(retryTransform).getReader();
              writer = { abort: () => Promise.resolve() };
              return this.pull(controller);
            } catch (retryError) {
              console.warn(
                `[ANTIGRAVITY] Empty STOP retry ${emptyStopRetryAttempts} failed: ${retryError.message}`,
              );
              throw retryError;
            }
          }
          if (
            streamStateTracker?.emptyProviderResponse === true &&
            streamStateTracker.hasMeaningfulProviderOutput !== true
          ) {
            throw new Error(
              `Antigravity returned an empty STOP after ${emptyStopRetryAttempts + 1} attempts`,
            );
          }
          if (chunksReceived === 0) {
            throw new Error("API returned an empty response (HTTP 200)");
          }
          streamController.handleComplete();
          controller.close();
          return;
        }

        if (value && chunksReceived === 0) {
          try {
            const decoder = new TextDecoder("utf-8");
            const chunkText = decoder.decode(value, { stream: true });
            const hasOverload =
              chunkText.includes("overloaded") ||
              chunkText.includes("overload");
            const hasError =
              chunkText.includes("Error") ||
              chunkText.includes("error") ||
              chunkText.includes("●") ||
              chunkText.includes("[Error]");
            const hasTryAgain =
              chunkText.includes("try again later") ||
              chunkText.includes("Please try again") ||
              chunkText.includes("try again");

            if (hasOverload || (hasTryAgain && hasError)) {
              throw new Error(
                "Upstream error: Our servers are currently overloaded",
              );
            }
          } catch (e) {
            if (e.message?.startsWith("Upstream error:")) {
              throw e;
            }
          }
        }

        chunksReceived++;
        onClientFirstChunk?.();
        controller.enqueue(value);
      } catch (error) {
        const wasConnected = streamController.isConnected();
        const textBuffer = streamStateTracker;
        const hasGeneratedText =
          textBuffer &&
          (textBuffer.accumulatedContent || textBuffer.accumulatedThinking);
        const isEarlyStreamError = chunksReceived === 0;
        const canResume = hasGeneratedText || isEarlyStreamError;

        const msg = error?.message || "";
        const code = error?.code || error?.cause?.code || "";
        const isNetworkOrOverloadError =
          error.name === "AbortError" ||
          msg.includes("aborted") ||
          msg.includes("socket hang up") ||
          msg.includes("ECONNRESET") ||
          msg.includes("ETIMEDOUT") ||
          msg.includes("EPIPE") ||
          msg.includes("overloaded") ||
          msg.includes("overload") ||
          msg.includes("busy") ||
          msg.includes("empty response") ||
          msg.includes("terminated") ||
          msg.includes("premature close") ||
          msg.includes("fetch failed") ||
          msg.includes("closed unexpectedly") ||
          code === "ECONNRESET" ||
          code === "ETIMEDOUT" ||
          code === "EPIPE" ||
          code === "UND_ERR_SOCKET";

        if (
          wasConnected &&
          isNetworkOrOverloadError &&
          canResume &&
          resumeAttempts < maxResumeAttempts &&
          resumeCtx
        ) {
          resumeAttempts++;

          // Apply backoff strategy: 1st retry = immediate, 2nd retry = 1.5s delay
          if (resumeAttempts === 2) {
            console.log(
              `[RESUME] Applying backoff delay of 1.5s before attempt 2...`,
            );
            await new Promise((resolve) => setTimeout(resolve, 1500));
          }

          console.log(
            `[RESUME] Mid-stream connection lost (${error.message}). Attempting transparent resume ${resumeAttempts}/${maxResumeAttempts}...`,
          );

          try {
            const newResponse = await executeResumeRequest({
              originalBody: resumeCtx.body,
              textBuffer,
              provider: resumeCtx.provider,
              model: resumeCtx.model,
              credentials: resumeCtx.credentials,
              sourceFormat: resumeCtx.sourceFormat,
              targetFormat: resumeCtx.targetFormat,
              userAgent: resumeCtx.userAgent,
              apiKey: resumeCtx.apiKey,
              connectionId: resumeCtx.connectionId,
              toolNameMap: resumeCtx.toolNameMap,
              reqLogger: resumeCtx.reqLogger,
              clientRawRequest: resumeCtx.clientRawRequest,
            });

            if (newResponse) {
              console.log(
                "[RESUME] Resume request successful! Piping new stream chunks...",
              );

              chunksReceived = 0;
              await reader.cancel().catch(() => {});
              if (writer && typeof writer.abort === "function") {
                await writer.abort().catch(() => {});
              }

              // Static imports used (converted from dynamic — F11)

              let newTransformStream;
              if (
                needsTranslation(resumeCtx.sourceFormat, resumeCtx.targetFormat)
              ) {
                newTransformStream = createSSETransformStreamWithLogger(
                  resumeCtx.targetFormat,
                  resumeCtx.sourceFormat,
                  resumeCtx.provider,
                  resumeCtx.reqLogger,
                  resumeCtx.toolNameMap,
                  resumeCtx.model,
                  resumeCtx.connectionId,
                  resumeCtx.body,
                  null, // no need to re-trigger onStreamComplete
                  resumeCtx.apiKey,
                  textBuffer,
                );
              } else {
                newTransformStream = createPassthroughStreamWithLogger(
                  resumeCtx.provider,
                  resumeCtx.reqLogger,
                  resumeCtx.model,
                  resumeCtx.connectionId,
                  resumeCtx.body,
                  null,
                  resumeCtx.apiKey,
                  textBuffer,
                );
              }

              // resumeStallTap resets outer stall timer for each resumed chunk (R2-F5)
              const resumeStallTap = new TransformStream({
                transform(chunk, controller) {
                  resumeCtx.onResumeStall?.();
                  controller.enqueue(chunk);
                },
              });

              const newTransformedBody = newResponse.body
                .pipeThrough(resumeStallTap)
                .pipeThrough(newTransformStream);

              reader = newTransformedBody.getReader();
              writer = { abort: () => Promise.resolve() };
              resumeCtx.onResumeStall?.(); // immediate reset on resume start (R2-F5)

              // Read next chunks from the resumed stream!
              return this.pull(controller);
            }
          } catch (resumeErr) {
            console.error("[RESUME] Resume attempt failed:", resumeErr.message);
          }
        }

        if (error.name !== "AbortError") {
          try {
            const errorBody = {
              error: {
                message: `[9Router] Stream error: ${error.message || "Unknown error"}`,
                type: "stream_error",
                code: "stream_failed",
              },
            };
            controller.enqueue(
              _sharedEnc.encode(`data: ${JSON.stringify(errorBody)}\n\n`),
            );
          } catch (e) {
            // Ignore if stream is already closed
          }
        }

        streamController.handleError(error);
        reader.cancel().catch(() => {});
        if (writer && typeof writer.abort === "function") {
          writer.abort().catch(() => {});
        }

        const isNetworkClose =
          error.name === "AbortError" ||
          msg.includes("aborted") ||
          msg.includes("socket hang up") ||
          msg.includes("ECONNRESET") ||
          msg.includes("ETIMEDOUT") ||
          msg.includes("EPIPE") ||
          msg.includes("terminated") ||
          msg.includes("premature close") ||
          msg.includes("fetch failed") ||
          msg.includes("closed unexpectedly") ||
          code === "ECONNRESET" ||
          code === "ETIMEDOUT" ||
          code === "EPIPE" ||
          code === "UND_ERR_SOCKET";

        // Graceful close on network/abort, or when a structured terminal is available
        // (Responses passthrough prefers response.failed + [DONE] over a raw transport error)
        try {
          if (!wasConnected || isNetworkClose || onAbortTerminal) {
            emitTerminal(controller);
            controller.close();
          } else {
            controller.error(error);
          }
        } catch (e) {
          /* already closed or cancelled */
        }
      }
    },

    cancel(reason) {
      streamController.handleDisconnect(reason || "cancelled");
      reader.cancel();
      if (writer && typeof writer.abort === "function") {
        writer.abort();
      }
    },
  });
}

/**
 * Pipe provider response through transform with disconnect detection.
 *
 * Stall watchdog tracks raw upstream byte activity, not transform output.
 * Reasoning models (Claude thinking via Kiro, etc.) can produce zero SSE
 * output for long stretches while partial EventStream frames keep arriving.
 * Measuring stall on the transform output caused false stalls and the
 * "failed to pipe response" error in Next.
 *
 * Any upstream chunk resets the timer. If no bytes arrive for
 * STREAM_STALL_TIMEOUT_MS, abort the underlying fetch via the controller.
 *
 * @param {Response} providerResponse - Response from provider
 * @param {TransformStream} transformStream - Transform stream for SSE
 * @param {object} streamController - Stream controller from createStreamController
 * @param {object} streamStateTracker - Stream state tracker to extract generated text
 * @param {object} resumeCtx - Context to resume the stream if connection breaks
 */
export function pipeWithDisconnect(
  providerResponse,
  transformStream,
  streamController,
  onAbortTerminal = null,
  streamStateTracker = null,
  timing = null,
  stallTimeoutMs = STREAM_STALL_TIMEOUT_MS,
  model = null,
  provider = null,
  resumeCtx = null,
  // Phase 3 (option c): when set, pipe THIS stream (Kiro's object-mode decode
  // output) through the stall tap + transform instead of providerResponse.body.
  // The transform is the object-input translate builder, so its output is bytes
  // and everything downstream (tap byte-count is guarded for non-byte chunks,
  // client Response) is unchanged. Resume path is unaffected: it re-executes the
  // provider in byte mode and rebuilds a byte transform.
  bodyOverride = null,
) {
  let stallTimer = null;
  let semanticStallTimer = null;
  let lastContentLength = 0;

  let chunkCount = 0;
  let totalBytes = 0;
  let lastChunkAt = Date.now();
  let upstreamFirstByteAt = null;
  let clientFirstChunkAt = null;
  let abortMessage = "upstream connection lost";
  const t0 = Date.now();
  const tag = "STREAM";

  const clearSemanticStall = () => {
    if (semanticStallTimer) {
      clearInterval(semanticStallTimer);
      semanticStallTimer = null;
    }
  };

  const clearStall = () => {
    if (stallTimer) {
      clearTimeout(stallTimer);
      stallTimer = null;
    }
    clearSemanticStall();
  };

  const armStall = () => {
    clearStall();
    stallTimer = setTimeout(() => {
      stallTimer = null;
      abortMessage = "stream stall timeout";
      dbg(
        tag,
        `STALL TIMEOUT ${stallTimeoutMs}ms | chunks=${chunkCount} | bytes=${totalBytes} | sinceLast=${Date.now() - lastChunkAt}ms`,
      );
      streamController.handleError?.(new Error("stream stall timeout"));
      streamController.abort?.();
    }, stallTimeoutMs);
  };

  const startSemanticStallWatchdog = () => {
    clearSemanticStall();
    const isReasoningModel =
      (model &&
        (model.includes("reasoning") ||
          model.includes("gpt-5") ||
          model.includes("deepseek"))) ||
      provider === "codex";
    const dynamicTimeoutMs = isReasoningModel
      ? 180000
      : STREAM_SEMANTIC_STALL_TIMEOUT_MS;

    semanticStallTimer = setInterval(() => {
      if (!streamController.isConnected()) {
        clearSemanticStall();
        return;
      }

      if (streamStateTracker?.inThinking) {
        return;
      }

      const currentLength =
        (streamStateTracker?.accumulatedContent?.length || 0) +
        (streamStateTracker?.accumulatedThinking?.length || 0);

      if (currentLength > 0) {
        if (currentLength === lastContentLength) {
          dbg(
            tag,
            `SEMANTIC STALL TIMEOUT ${dynamicTimeoutMs}ms | content size ${currentLength} has not grown in the last interval. Aborting stream.`,
          );
          clearSemanticStall();
          clearStall();
          streamController.handleError?.(
            new Error("stream semantic stall timeout"),
          );
          streamController.abort?.();
        } else {
          lastContentLength = currentLength;
        }
      }
    }, dynamicTimeoutMs);
  };

  // Wrap controller so every termination path clears the stall timer.
  // Without this, abort/cancel/downstream-error paths leave the timer armed
  // and a stale abort could fire after the request has already ended.
  const wrappedController = {
    signal: streamController.signal,
    startTime: streamController.startTime,
    isConnected: () => streamController.isConnected(),
    handleComplete: () => {
      dbg(
        tag,
        `complete | chunks=${chunkCount} | bytes=${totalBytes} | dur=${Date.now() - t0}ms`,
      );
      clearStall();
      streamController.handleComplete();
    },
    handleError: (e) => {
      dbg(
        tag,
        `error: ${e?.message} | chunks=${chunkCount} | bytes=${totalBytes} | dur=${Date.now() - t0}ms`,
      );
      clearStall();
      streamController.handleError(e);
    },
    handleDisconnect: (r) => {
      dbg(
        tag,
        `disconnect: ${r} | chunks=${chunkCount} | bytes=${totalBytes} | dur=${Date.now() - t0}ms`,
      );
      clearStall();
      streamController.handleDisconnect(r);
    },
    abort: () => {
      clearStall();
      streamController.abort();
    },
  };

  armStall();
  // Note: startSemanticStallWatchdog() is called after first chunk arrives
  // (not at init) so fake-timer tests using runAllTimersAsync don't infinite-loop.
  dbg(
    tag,
    `pipe start | stallTimeout=${stallTimeoutMs}ms | semanticStallTimeout=${STREAM_SEMANTIC_STALL_TIMEOUT_MS}ms`,
  );

  // Stall tap: tracks bytes/timing, resets stall timer per chunk
  const upstreamStallTap = new TransformStream({
    transform(chunk, controller) {
      chunkCount++;
      if (!upstreamFirstByteAt) {
        upstreamFirstByteAt = Date.now();
        if (timing && !timing.upstreamFirstByteAt)
          timing.upstreamFirstByteAt = upstreamFirstByteAt;
        startSemanticStallWatchdog();
      }
      const sz = chunk?.byteLength || chunk?.length || 0;
      totalBytes += sz;
      const now = Date.now();
      const gap = now - lastChunkAt;
      lastChunkAt = now;
      if (
        isDebugEnabled &&
        (chunkCount <= 5 || chunkCount % 20 === 0 || gap > 5000)
      ) {
        dbg(
          tag,
          `chunk #${chunkCount} | size=${sz}B | gap=${gap}ms | total=${totalBytes}B`,
        );
      }
      armStall();
      controller.enqueue(chunk);
    },
    flush() {
      dbg(
        tag,
        `upstream EOF | chunks=${chunkCount} | bytes=${totalBytes} | dur=${Date.now() - t0}ms`,
      );
      clearStall();
    },
  });

  // Phase 3 (option c): pipe the object-mode source when provided, else the
  // provider's byte body. Either way the stall tap (byte-count guarded) and the
  // transform (object-input translate when overridden) run identically.
  const pipeSource = bodyOverride || providerResponse.body;
  const transformedBody = pipeSource
    .pipeThrough(upstreamStallTap)
    .pipeThrough(transformStream);

  const onClientFirstChunk = () => {
    if (!clientFirstChunkAt) {
      clientFirstChunkAt = Date.now();
      if (timing && !timing.clientFirstChunkAt)
        timing.clientFirstChunkAt = clientFirstChunkAt;
    }
  };

  return createDisconnectAwareStream(
    {
      readable: transformedBody,
      writable: { getWriter: () => ({ abort: () => Promise.resolve() }) },
    },
    wrappedController,
    onAbortTerminal ? () => onAbortTerminal(abortMessage) : null,
    streamStateTracker,
    { ...resumeCtx, onResumeStall: armStall },
    onClientFirstChunk,
  );
}
