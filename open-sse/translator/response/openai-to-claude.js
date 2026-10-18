import { register } from "../index.js";
import { FORMATS } from "../formats.js";
import * as log from "../../../src/sse/utils/logger.js";

// Prefix for Claude OAuth tool names (must match request translator)
const CLAUDE_OAUTH_TOOL_PREFIX = "proxy_";

// Sanitize tool call arguments to fix bad params from non-Anthropic models
function sanitizeToolArgs(toolName, argsJson) {
  try {
    const args = JSON.parse(argsJson);
    const name = toolName.startsWith(CLAUDE_OAUTH_TOOL_PREFIX)
      ? toolName.slice(CLAUDE_OAUTH_TOOL_PREFIX.length)
      : toolName;
    if (name === "Read") sanitizeReadArgs(args);
    return JSON.stringify(args);
  } catch {
    return argsJson;
  }
}

function sanitizeReadArgs(args) {
  if (typeof args.limit === "string" && /^\d+$/.test(args.limit))
    args.limit = Number(args.limit);
  if (typeof args.offset === "string" && /^-?\d+$/.test(args.offset))
    args.offset = Number(args.offset);

  if (typeof args.limit === "number") {
    if (args.limit > 2000) args.limit = 2000;
    if (args.limit < 1) delete args.limit;
  }
  if (typeof args.offset === "number" && args.offset < 0) args.offset = 0;

  if ("pages" in args && !isValidPdfPagesArg(args.file_path, args.pages)) {
    delete args.pages;
  }
}

function isValidPdfPagesArg(filePath, pages) {
  return (
    typeof filePath === "string" &&
    filePath.toLowerCase().endsWith(".pdf") &&
    typeof pages === "string" &&
    /^\d+(?:-\d+)?$/.test(pages)
  );
}

// Helper: stop thinking block if started
function stopThinkingBlock(state, results) {
  if (!state.thinkingBlockStarted) return;
  results.push({
    type: "content_block_stop",
    index: state.thinkingBlockIndex,
  });
  state.thinkingBlockStarted = false;
}

// Helper: stop text block if started
function stopTextBlock(state, results) {
  if (!state.textBlockStarted || state.textBlockClosed) return;
  state.textBlockClosed = true;
  results.push({
    type: "content_block_stop",
    index: state.textBlockIndex,
  });
  state.textBlockStarted = false;
}

// Convert OpenAI stream chunk to Claude format
export function openaiToClaudeResponse(chunk, state) {
  if (!chunk || !chunk.choices?.[0]) return null;

  const results = [];
  const choice = chunk.choices[0];
  const delta = choice.delta;

  // Track usage from OpenAI chunk if available
  if (chunk.usage && typeof chunk.usage === "object") {
    const promptTokens =
      typeof chunk.usage.prompt_tokens === "number"
        ? chunk.usage.prompt_tokens
        : 0;
    const outputTokens =
      typeof chunk.usage.completion_tokens === "number"
        ? chunk.usage.completion_tokens
        : 0;

    // Extract cache tokens from prompt_tokens_details
    const cachedTokens = chunk.usage.prompt_tokens_details?.cached_tokens;
    const cacheCreationTokens =
      chunk.usage.prompt_tokens_details?.cache_creation_tokens;
    const cacheReadTokens = typeof cachedTokens === "number" ? cachedTokens : 0;
    const cacheCreateTokens =
      typeof cacheCreationTokens === "number" ? cacheCreationTokens : 0;

    // input_tokens = prompt_tokens - cached_tokens - cache_creation_tokens
    // Because OpenAI's prompt_tokens includes all prompt-side tokens
    const inputTokens = promptTokens - cacheReadTokens - cacheCreateTokens;

    state.usage = {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
    };

    // Add cache_read_input_tokens if present
    if (cacheReadTokens > 0) {
      state.usage.cache_read_input_tokens = cacheReadTokens;
    }

    // Add cache_creation_input_tokens if present
    if (cacheCreateTokens > 0) {
      state.usage.cache_creation_input_tokens = cacheCreateTokens;
    }

    // Note: completion_tokens_details.reasoning_tokens is already included in output_tokens
    // No need to add separately as Claude expects total output_tokens
  }

  // First chunk - ALWAYS send message_start first
  if (!state.messageStartSent) {
    state.messageStartSent = true;
    state.messageId = chunk.id?.replace("chatcmpl-", "") || `msg_${Date.now()}`;
    if (
      !state.messageId ||
      state.messageId === "chat" ||
      state.messageId.length < 8
    ) {
      state.messageId =
        chunk.extend_fields?.requestId ||
        chunk.extend_fields?.traceId ||
        `msg_${Date.now()}`;
    }
    state.model = chunk.model || "unknown";
    state.nextBlockIndex = 0;
    results.push({
      type: "message_start",
      message: {
        id: state.messageId,
        type: "message",
        role: "assistant",
        model: state.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  }

  // Handle reasoning_content (thinking) - GLM, DeepSeek, etc.
  const reasoningContent = delta?.reasoning_content || delta?.reasoning;
  if (reasoningContent) {
    stopTextBlock(state, results);

    if (!state.thinkingBlockStarted) {
      state.thinkingBlockIndex = state.nextBlockIndex++;
      state.thinkingBlockStarted = true;
      results.push({
        type: "content_block_start",
        index: state.thinkingBlockIndex,
        content_block: { type: "thinking", thinking: "" },
      });
    }

    results.push({
      type: "content_block_delta",
      index: state.thinkingBlockIndex,
      delta: { type: "thinking_delta", thinking: reasoningContent },
    });
  }

  // Handle regular content
  if (delta?.content) {
    stopThinkingBlock(state, results);

    if (!state.textBlockStarted) {
      state.textBlockIndex = state.nextBlockIndex++;
      state.textBlockStarted = true;
      state.textBlockClosed = false;
      results.push({
        type: "content_block_start",
        index: state.textBlockIndex,
        content_block: { type: "text", text: "" },
      });
    }

    results.push({
      type: "content_block_delta",
      index: state.textBlockIndex,
      delta: { type: "text_delta", text: delta.content },
    });
  }

  // Tool calls
  if (delta?.tool_calls) {
    if (!state.toolCalls) state.toolCalls = new Map();
    for (const tc of delta.tool_calls) {
      const idx = tc.index ?? 0;

      // Diagnostic: surface whether upstream sent tc.id on this delta. A tool
      // block only opens when tc.id is present (see below); providers that omit
      // it never emit content_block_start → tool_use is silently dropped.
      log.debug(
        "O2C-TOOL",
        `idx=${idx} | hasId=${!!tc.id} | name=${tc.function?.name || "-"} | argLen=${tc.function?.arguments?.length || 0}`,
      );

      // Open a tool_use block the first time we see this tool-call index —
      // NOT gated on tc.id. Standard OpenAI streams the id only on the first
      // fragment (so first-seen == has-id there), but some compatible upstreams
      // (Kiro-flavored) identify a tool call by index alone and never send an
      // id. Synthesize a deterministic, Anthropic-valid id in that case so the
      // block still opens and argument deltas are not discarded.
      if (!state.toolCalls.has(idx)) {
        stopThinkingBlock(state, results);
        stopTextBlock(state, results);

        const toolId = tc.id || `call_idx_${idx}`;
        const toolBlockIndex = state.nextBlockIndex++;
        state.toolCalls.set(idx, {
          id: toolId,
          name: tc.function?.name || "",
          blockIndex: toolBlockIndex,
        });

        // Strip prefix from tool name for response
        let toolName = tc.function?.name || "";
        if (toolName.startsWith(CLAUDE_OAUTH_TOOL_PREFIX)) {
          toolName = toolName.slice(CLAUDE_OAUTH_TOOL_PREFIX.length);
        }

        results.push({
          type: "content_block_start",
          index: toolBlockIndex,
          content_block: {
            type: "tool_use",
            id: toolId,
            name: toolName,
            input: {},
          },
        });
      } else if (tc.function?.name && !state.toolCalls.get(idx).name) {
        // Name arrived on a later fragment than the block open — backfill it so
        // the tool_use block isn't left nameless. (content_block_start already
        // emitted; Anthropic clients read the name from that event, so this
        // only keeps internal state consistent for arg sanitization.)
        state.toolCalls.get(idx).name = tc.function.name;
      }

      if (tc.function?.arguments) {
        const toolInfo = state.toolCalls.get(idx);
        if (toolInfo) {
          let toolName = toolInfo.name;
          if (toolName.startsWith(CLAUDE_OAUTH_TOOL_PREFIX)) {
            toolName = toolName.slice(CLAUDE_OAUTH_TOOL_PREFIX.length);
          }

          if (toolName === "Read") {
            if (!state.toolArgBuffers) state.toolArgBuffers = new Map();
            const current =
              (state.toolArgBuffers.get(idx) || "") + tc.function.arguments;
            state.toolArgBuffers.set(idx, current);

            // Try to parse early only if the arguments look like closed JSON (avoids throwing on every chunk)
            if (current.trimEnd().endsWith("}")) {
              try {
                JSON.parse(current);
                const sanitized = sanitizeToolArgs(toolInfo.name, current);
                results.push({
                  type: "content_block_delta",
                  index: toolInfo.blockIndex,
                  delta: { type: "input_json_delta", partial_json: sanitized },
                });
                state.toolArgBuffers.delete(idx);
              } catch {
                // JSON is incomplete, continue buffering
              }
            }
          } else {
            // Stream arguments directly in real-time
            results.push({
              type: "content_block_delta",
              index: toolInfo.blockIndex,
              delta: {
                type: "input_json_delta",
                partial_json: tc.function.arguments,
              },
            });
          }
        }
      }
    }
  }

  // Finish
  if (choice.finish_reason) {
    // Diagnostic: the mismatch that ends a turn early is when tool blocks were
    // streamed (toolBlocks>0) but finish_reason isn't "tool_calls", so the
    // mapped stop_reason becomes end_turn and the client stops instead of
    // running the tool. Log all three to confirm which side is at fault.
    log.debug(
      "O2C-FINISH",
      `finish_reason=${choice.finish_reason} | toolBlocks=${state.toolCalls?.size || 0} | mappedStop=${convertFinishReason(choice.finish_reason)}`,
    );

    stopThinkingBlock(state, results);
    stopTextBlock(state, results);

    for (const [idx, toolInfo] of state.toolCalls || []) {
      let toolName = toolInfo.name;
      if (toolName.startsWith(CLAUDE_OAUTH_TOOL_PREFIX)) {
        toolName = toolName.slice(CLAUDE_OAUTH_TOOL_PREFIX.length);
      }

      if (toolName === "Read") {
        const buffered = state.toolArgBuffers?.get(idx);
        if (buffered) {
          const sanitized = sanitizeToolArgs(toolInfo.name, buffered);
          results.push({
            type: "content_block_delta",
            index: toolInfo.blockIndex,
            delta: { type: "input_json_delta", partial_json: sanitized },
          });
        }
      }
      results.push({
        type: "content_block_stop",
        index: toolInfo.blockIndex,
      });
    }

    // Mark finish for later usage injection in stream.js
    state.finishReason = choice.finish_reason;

    // Use tracked usage (will be estimated in stream.js if not valid)
    const finalUsage = state.usage || { input_tokens: 0, output_tokens: 0 };
    // If any tool_use block was emitted this turn, the stop_reason MUST be
    // tool_use regardless of what the upstream reported — otherwise the client
    // sees end_turn and stops without running the tool. Some OpenAI-compatible
    // providers (e.g. Kiro-flavored) finish a tool turn with "stop" or a
    // non-standard "tool_use" reason; both would otherwise map to end_turn.
    const emittedToolUse = (state.toolCalls?.size || 0) > 0;
    results.push({
      type: "message_delta",
      delta: {
        stop_reason: emittedToolUse
          ? "tool_use"
          : convertFinishReason(choice.finish_reason),
      },
      usage: finalUsage,
    });
    results.push({ type: "message_stop" });
  }

  return results.length > 0 ? results : null;
}

// Convert OpenAI finish_reason to Claude stop_reason
function convertFinishReason(reason) {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "tool_calls":
    case "tool_use":
      return "tool_use";
    default:
      return "end_turn";
  }
}

// Register
register(FORMATS.OPENAI, FORMATS.CLAUDE, null, openaiToClaudeResponse);
