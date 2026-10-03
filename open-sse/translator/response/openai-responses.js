/**
 * Translator: OpenAI Chat Completions → OpenAI Responses API (response)
 * Converts streaming chunks from Chat Completions to Responses API events
 */
import { register } from "../index.js";
import { FORMATS } from "../formats.js";
import { buildChunk } from "../concerns/chunk.js";
import { clampResponsesCallId } from "../formats/responsesApi.js";
import { OPENAI_BLOCK, RESPONSES_ITEM, MODEL_FALLBACK } from "../schema/index.js";

// Upstream Chat Completions usage -> Responses API usage shape.
// Without this, /v1/responses never reports usage: Responses clients (Codex CLI)
// keep their "context used" gauge pinned at 0 and never auto-compact, so a long
// session grows until the upstream context limit rejects it (9router issue #3432).
//
// Note this is stored under state.responsesUsage, NOT state.usage: state.usage is
// owned by the stream layer, which fills it with normalizeUsage()-shaped counts
// (prompt_tokens/prompt_tokens_details) and hands it to finalizeStream() for
// logging and cost accounting. Overwriting it with this shape silently drops
// cached/reasoning tokens from those stats.
function toResponsesUsage(usage) {
  if (!usage || typeof usage !== "object") return null;

  const inputTokens = [usage.input_tokens, usage.prompt_tokens].find(Number.isInteger);
  const outputTokens = [usage.output_tokens, usage.completion_tokens].find(Number.isInteger);
  // Some upstreams attach zeroed placeholders to every chunk. Wait for real counts
  // so response.completed cannot freeze the placeholder before the usage trailer.
  if (inputTokens === undefined || outputTokens === undefined || inputTokens + outputTokens <= 0) {
    return null;
  }
  const responseUsage = {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens
  };
  const cachedTokens = [usage.input_tokens_details?.cached_tokens, usage.prompt_tokens_details?.cached_tokens].find(Number.isInteger);
  const reasoningTokens = [usage.output_tokens_details?.reasoning_tokens, usage.completion_tokens_details?.reasoning_tokens].find(Number.isInteger);
  if (Number.isInteger(cachedTokens)) responseUsage.input_tokens_details = { cached_tokens: cachedTokens };
  if (Number.isInteger(reasoningTokens)) responseUsage.output_tokens_details = { reasoning_tokens: reasoningTokens };

  return responseUsage;
}

/**
 * Translate OpenAI chunk to Responses API events
 * @returns {Array} Array of events with { event, data } structure
 */
export function openaiToOpenAIResponsesResponse(chunk, state) {
  if (!chunk) {
    return flushEvents(state);
  }

  // Capture usage before the choices guard: OpenAI may send it in a trailer
  // whose choices array is empty.
  const responseUsage = toResponsesUsage(chunk.usage);
  if (responseUsage) state.responsesUsage = responseUsage;

  if (!chunk.choices?.length) {
    return state.completionPending && state.responsesUsage ? flushEvents(state) : [];
  }

  const events = [];
  const nextSeq = () => ++state.seq;

  const emit = (eventType, data) => {
    data.sequence_number = nextSeq();
    events.push({ event: eventType, data });
  };

  const choice = chunk.choices[0];
  const idx = choice.index || 0;
  const delta = choice.delta || {};

  // Emit initial events
  if (!state.started) {
    state.started = true;
    state.responseId = chunk.id ? `resp_${chunk.id}` : state.responseId;

    emit("response.created", {
      type: "response.created",
      response: {
        id: state.responseId,
        object: "response",
        created_at: state.created,
        status: "in_progress",
        background: false,
        error: null,
        output: [],
      },
    });

    emit("response.in_progress", {
      type: "response.in_progress",
      response: {
        id: state.responseId,
        object: "response",
        created_at: state.created,
        status: "in_progress",
      },
    });
  }

  // Handle reasoning_content
  if (delta.reasoning_content) {
    startReasoning(state, emit, idx);
    emitReasoningDelta(state, emit, delta.reasoning_content);
  }

  // Handle text content
  if (delta.content) {
    let content = delta.content;

    if (content.includes("<think>")) {
      state.inThinking = true;
      content = content.replace("<think>", "");
      startReasoning(state, emit, idx);
    }

    if (content.includes("</think>")) {
      const parts = content.split("</think>");
      const thinkPart = parts[0];
      const textPart = parts.slice(1).join("</think>");
      if (thinkPart) emitReasoningDelta(state, emit, thinkPart);
      closeReasoning(state, emit);
      state.inThinking = false;
      content = textPart;
    }

    if (state.inThinking && content) {
      emitReasoningDelta(state, emit, content);
      return events;
    }

    if (content) {
      emitTextContent(state, emit, idx, content);
    }
  }

  // Handle tool_calls (empty array is truthy; require a real call)
  if (delta.tool_calls && delta.tool_calls.length) {
    closeMessage(state, emit, idx);
    for (const tc of delta.tool_calls) {
      emitToolCall(state, emit, tc);
    }
  }

  // Handle finish_reason
  if (choice.finish_reason) {
    for (const i in state.msgItemAdded) closeMessage(state, emit, i);
    closeReasoning(state, emit);
    for (const i in state.funcCallIds) closeToolCall(state, emit, i);
    if (choice.finish_reason === "error") {
      const providerError = state.providerError;
      sendFailed(state, emit, {
        code: providerError?.code || "empty_provider_response",
        message:
          providerError?.message ||
          "Provider returned an empty STOP with no content or tool calls",
      });
    } else if (state.targetFormat === FORMATS.OPENAI && !state.responsesUsage) {
      // Direct openai:openai-responses route: finish_reason arrived before
      // usage. Defer response.completed until the trailer chunk, [DONE],
      // or the stream watchdog flushes it.
      state.completionPending = true;
    } else {
      sendCompleted(state, emit);
    }
  }

  return events;
}

// Helper functions
function getOutputIndex(state, type, key) {
  const indexes = (state.outputIndexes ??= {});
  const id = `${type}:${key}`;
  if (indexes[id] === undefined) {
    indexes[id] = state.nextOutputIndex ?? 0;
    state.nextOutputIndex = indexes[id] + 1;
  }
  return indexes[id];
}

function startReasoning(state, emit, idx) {
  if (!state.reasoningId) {
    state.reasoningIndex = getOutputIndex(state, "reasoning", idx);
    state.reasoningId = `rs_${state.responseId}_${state.reasoningIndex}`;

    emit("response.output_item.added", {
      type: "response.output_item.added",
      output_index: state.reasoningIndex,
      item: { id: state.reasoningId, type: "reasoning", summary: [] },
    });

    emit("response.reasoning_summary_part.added", {
      type: "response.reasoning_summary_part.added",
      item_id: state.reasoningId,
      output_index: state.reasoningIndex,
      summary_index: 0,
      part: { type: "summary_text", text: "" },
    });
    state.reasoningPartAdded = true;
  }
}

function emitReasoningDelta(state, emit, text) {
  if (!text) return;
  state.reasoningBuf += text;
  emit("response.reasoning_summary_text.delta", {
    type: "response.reasoning_summary_text.delta",
    item_id: state.reasoningId,
    output_index: state.reasoningIndex,
    summary_index: 0,
    delta: text,
  });
}

function closeReasoning(state, emit) {
  if (state.reasoningId && !state.reasoningDone) {
    state.reasoningDone = true;

    emit("response.reasoning_summary_text.done", {
      type: "response.reasoning_summary_text.done",
      item_id: state.reasoningId,
      output_index: state.reasoningIndex,
      summary_index: 0,
      text: state.reasoningBuf,
    });

    emit("response.reasoning_summary_part.done", {
      type: "response.reasoning_summary_part.done",
      item_id: state.reasoningId,
      output_index: state.reasoningIndex,
      summary_index: 0,
      part: { type: "summary_text", text: state.reasoningBuf },
    });

    const item = {
      id: state.reasoningId,
      type: "reasoning",
      summary: [{ type: "summary_text", text: state.reasoningBuf }],
    };

    emit("response.output_item.done", {
      type: "response.output_item.done",
      output_index: state.reasoningIndex,
      item,
    });

    recordCompletedOutputItem(state, state.reasoningIndex, item);
  }
}

function emitTextContent(state, emit, idx, content) {
  const outputIndex = getOutputIndex(state, "message", idx);
  if (!state.msgItemAdded[idx]) {
    state.msgItemAdded[idx] = true;
    const msgId = `msg_${state.responseId}_${outputIndex}`;

    emit("response.output_item.added", {
      type: "response.output_item.added",
      output_index: outputIndex,
      item: { id: msgId, type: "message", content: [], role: "assistant" },
    });
  }

  if (!state.msgContentAdded[idx]) {
    state.msgContentAdded[idx] = true;

    emit("response.content_part.added", {
      type: "response.content_part.added",
      item_id: `msg_${state.responseId}_${outputIndex}`,
      output_index: outputIndex,
      content_index: 0,
      part: { type: "output_text", annotations: [], logprobs: [], text: "" },
    });
  }

  emit("response.output_text.delta", {
    type: "response.output_text.delta",
    item_id: `msg_${state.responseId}_${outputIndex}`,
    output_index: outputIndex,
    content_index: 0,
    delta: content,
    logprobs: [],
  });

  if (!state.msgTextBuf[idx]) state.msgTextBuf[idx] = "";
  state.msgTextBuf[idx] += content;
}

function closeMessage(state, emit, idx) {
  if (state.msgItemAdded[idx] && !state.msgItemDone[idx]) {
    state.msgItemDone[idx] = true;
    const fullText = state.msgTextBuf[idx] || "";
    const outputIndex = getOutputIndex(state, "message", idx);
    const msgId = `msg_${state.responseId}_${outputIndex}`;

    emit("response.output_text.done", {
      type: "response.output_text.done",
      item_id: msgId,
      output_index: outputIndex,
      content_index: 0,
      text: fullText,
      logprobs: [],
    });

    emit("response.content_part.done", {
      type: "response.content_part.done",
      item_id: msgId,
      output_index: outputIndex,
      content_index: 0,
      part: {
        type: "output_text",
        annotations: [],
        logprobs: [],
        text: fullText,
      },
    });

    const item = {
      id: msgId,
      type: "message",
      content: [
        {
          type: "output_text",
          annotations: [],
          logprobs: [],
          text: fullText,
        },
      ],
      role: "assistant",
    };

    emit("response.output_item.done", {
      type: "response.output_item.done",
      output_index: outputIndex,
      item,
    });

    recordCompletedOutputItem(state, outputIndex, item);
  }
}

function emitToolCall(state, emit, tc) {
  const tcIdx = tc.index ?? 0;
  const newCallId = tc.id;
  const funcName = tc.function?.name;
  const thoughtSig =
    tc.thought_signature ||
    tc.thoughtSignature ||
    tc.function?.thought_signature ||
    tc.function?.thoughtSignature;

  if (funcName) state.funcNames[tcIdx] = funcName;
  if (typeof thoughtSig === "string" && thoughtSig.length > 0) {
    state.funcThoughtSigs ??= {};
    state.funcThoughtSigs[tcIdx] = thoughtSig;
  }

  const emitAdded = () => {
    if (state.funcCallIds[tcIdx] && state.funcNames[tcIdx] && !state.funcItemAdded?.[tcIdx]) {
      state.funcItemAdded ??= {};
      state.funcItemAdded[tcIdx] = true;
      const callId = state.funcCallIds[tcIdx];
      const outputIndex = getOutputIndex(state, "tool", tcIdx);
      const isCustom = state.customToolNames?.has(state.funcNames[tcIdx]);
      const item = isCustom
        ? {
            id: `fc_${callId}`,
            type: "custom_tool_call",
            call_id: callId,
            name: state.funcNames[tcIdx],
            input: "",
          }
        : {
            id: `fc_${callId}`,
            type: "function_call",
            arguments: "",
            call_id: callId,
            name: state.funcNames[tcIdx],
          };
      if (state.funcThoughtSigs?.[tcIdx]) item.thought_signature = state.funcThoughtSigs[tcIdx];
      emit("response.output_item.added", { type: "response.output_item.added", output_index: outputIndex, item });
    }
  };

  if (!state.funcCallIds[tcIdx] && newCallId) state.funcCallIds[tcIdx] = newCallId;
  emitAdded();

  if (!state.funcArgsBuf[tcIdx]) state.funcArgsBuf[tcIdx] = "";

  if (tc.function?.arguments) {
    const callId = state.funcCallIds[tcIdx];
    const isCustom = state.customToolNames?.has(state.funcNames[tcIdx]);
    const raw = tc.function.arguments;
    const input = isCustom ? parseCustomToolInput(raw) : raw;
    if (callId) {
      emit(isCustom ? "response.custom_tool_call_input.delta" : "response.function_call_arguments.delta", isCustom
        ? { type: "response.custom_tool_call_input.delta", item_id: `fc_${callId}`, output_index: getOutputIndex(state, "tool", tcIdx), delta: input }
        : { type: "response.function_call_arguments.delta", item_id: `fc_${callId}`, output_index: getOutputIndex(state, "tool", tcIdx), delta: raw });
    }
    state.funcArgsBuf[tcIdx] += input;
  }
}

function parseCustomToolInput(argumentsText) {
  try {
    const parsed = JSON.parse(argumentsText);
    return typeof parsed?.input === "string" ? parsed.input : "";
  } catch {
    return "";
  }
}

function closeToolCall(state, emit, idx) {
  const callId = state.funcCallIds[idx];
  if (callId && !state.funcItemDone[idx]) {
    const args = state.funcArgsBuf[idx] || "{}";

    const outputIndex = getOutputIndex(state, "tool", idx);
    const isCustom = state.customToolNames?.has(state.funcNames[idx]);
    if (!isCustom) {
      emit("response.function_call_arguments.done", {
        type: "response.function_call_arguments.done",
        item_id: `fc_${callId}`,
        output_index: outputIndex,
        arguments: args,
      });
    }

    const item = isCustom
      ? {
          id: `fc_${callId}`,
          type: "custom_tool_call",
          call_id: callId,
          name: state.funcNames[idx] || "",
          input: args,
        }
      : {
          id: `fc_${callId}`,
          type: "function_call",
          arguments: args,
          call_id: callId,
          name: state.funcNames[idx] || "",
        };
    if (state.funcThoughtSigs?.[idx]) {
      item.thought_signature = state.funcThoughtSigs[idx];
    }

    emit("response.output_item.done", {
      type: "response.output_item.done",
      output_index: outputIndex,
      item,
    });

    recordCompletedOutputItem(state, outputIndex, item);

    state.funcItemDone[idx] = true;
    state.funcArgsDone[idx] = true;
  }
}

// response.completed carries the finished Response object, so response.output has
// to repeat the items already delivered in response.output_item.done. Clients that
// build their final result from the terminal event (GitHub Copilot CLI, the OpenAI
// SDK "final response" helpers) otherwise treat the turn as empty even though the
// text was streamed - see issue #4307.
//
// Keyed by output_index so a repeated close overwrites rather than duplicating the
// item, and ordered by output_index so response.output matches the order the items
// were emitted in. Lazily created because stream.js can hand us a state it built
// itself rather than one from initState().
function recordCompletedOutputItem(state, outputIndex, item) {
  state.completedOutputItems ??= new Map();
  const index = Number.isInteger(outputIndex) ? outputIndex : Number.parseInt(outputIndex, 10) || 0;
  state.completedOutputItems.set(index, item);
}

function collectCompletedOutputItems(state) {
  const recorded = state.completedOutputItems;
  if (!(recorded instanceof Map) || recorded.size === 0) return [];
  return [...recorded.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([, item]) => item);
}

function formatResponsesUsage(usage) {
  if (!usage || typeof usage !== "object") return null;

  const promptTokens =
    usage.prompt_tokens ?? usage.input_tokens ?? 0;
  const completionTokens =
    usage.completion_tokens ?? usage.output_tokens ?? 0;
  const totalTokens =
    usage.total_tokens ?? promptTokens + completionTokens;

  const cachedTokens =
    usage.prompt_tokens_details?.cached_tokens ??
    usage.input_token_details?.cached_tokens ??
    usage.cache_read_input_tokens ??
    0;

  const reasoningTokens =
    usage.completion_tokens_details?.reasoning_tokens ??
    usage.output_token_details?.reasoning_tokens ??
    0;

  return {
    total_tokens: totalTokens,
    input_tokens: promptTokens,
    output_tokens: completionTokens,
    input_token_details: {
      cached_tokens: cachedTokens,
    },
    output_token_details: {
      reasoning_tokens: reasoningTokens,
    },
  };
}

function sendCompleted(state, emit) {
  if (!state.completedSent) {
    state.completedSent = true;
    const responseObj = {
      id: state.responseId,
      object: "response",
      created_at: state.created,
      status: "completed",
      background: false,
      error: null,
      output: collectCompletedOutputItems(state),
      ...(state.responsesUsage ? { usage: state.responsesUsage } : {}),
    };

    emit("response.completed", {
      type: "response.completed",
      response: responseObj,
    });
  }
}

function sendFailed(state, emit, error) {
  if (!state.completedSent) {
    state.completedSent = true;
    emit("response.failed", {
      type: "response.failed",
      response: {
        id: state.responseId,
        object: "response",
        created_at: state.created,
        status: "failed",
        background: false,
        error: {
          code: error?.code || "provider_error",
          message: error?.message || "Provider stream failed",
        },
      },
    });
  }
}

function flushEvents(state) {
  if (state.completedSent) return [];

  const events = [];
  const nextSeq = () => ++state.seq;
  const emit = (eventType, data) => {
    data.sequence_number = nextSeq();
    events.push({ event: eventType, data });
  };

  for (const i in state.msgItemAdded) closeMessage(state, emit, i);
  closeReasoning(state, emit);
  for (const i in state.funcCallIds) closeToolCall(state, emit, i);
  sendCompleted(state, emit);

  return events;
}

// currentToolCallId is intentionally sticky for the current turn so flush/completion
// can still finalize as tool_calls even if the tool call was emitted before stream end.
function computeFinishReason(state) {
  return state.toolCallIndex > 0 || state.currentToolCallId
    ? "tool_calls"
    : "stop";
}

function shouldEmitInitialAssistantChunk(eventType) {
  if (!eventType?.startsWith?.("response.")) return false;
  return ![
    "response.completed",
    "response.failed",
    "response.cancelled",
    "response.incomplete",
    "response.output_text.done",
    "response.reasoning_summary_text.done",
    "response.reasoning_summary_part.done",
    "response.content_part.done",
    "response.output_item.done",
  ].includes(eventType);
}

/**
 * Translate OpenAI Responses API chunk to OpenAI Chat Completions format
 * This is for when Codex returns data and we need to send it to an OpenAI-compatible client
 */
export function openaiResponsesToOpenAIResponse(chunk, state) {
  if (!chunk) {
    // Flush: send final chunk with finish_reason
    if (state.finishReasonSent || !state.started) return null;

    const finishReason = computeFinishReason(state);

    state.finishReasonSent = true;
    state.finishReason = finishReason;

    const finalChunk = {
      id: state.chatId || `chatcmpl-${Date.now()}`,
      object: "chat.completion.chunk",
      created: state.created || Math.floor(Date.now() / 1000),
      model: state.model || "unknown",
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: finishReason,
        },
      ],
    };

    if (state.usage && typeof state.usage === "object") {
      finalChunk.usage = state.usage;
    }

    return finalChunk;
  }

  // Handle different event types from Responses API
  const eventType = chunk.type || chunk.event;
  const data = chunk.data || chunk;

  // Initialize state and emit initial chunk immediately
  // This ensures clients (e.g. Claude Code) see message_start right away
  // instead of waiting 15-26s for the first reasoning/content delta
  if (!state.started) {
    state.started = true;
    state.chatId = `chatcmpl-${Date.now()}`;
    state.created = Math.floor(Date.now() / 1000);
    state.toolCallIndex = 0;
    state.currentToolCallId = null;
    state.respToolChatIndex ??= new Map();
    state.respToolArgsEmitted ??= new Set();

    // Return initial chunk so downstream translators emit message_start immediately,
    // except when the initial event itself starts a tool call: that event must
    // continue to the handler below so its index and identity are retained.
    const startsToolCall =
      eventType === "response.output_item.added" &&
      (data.item?.type === RESPONSES_ITEM.FUNCTION_CALL ||
        data.item?.type === "custom_tool_call");
    if (shouldEmitInitialAssistantChunk(eventType) && !startsToolCall) {
      return {
        id: state.chatId,
        object: "chat.completion.chunk",
        created: state.created,
        model: state.model || "unknown",
        choices: [
          {
            index: 0,
            delta: { role: "assistant" },
            finish_reason: null,
          },
        ],
      };
    }
  }

  // Text content delta
  if (eventType === "response.output_text.delta") {
    const delta = data.delta || "";
    if (!delta) return null;

    return {
      id: state.chatId,
      object: "chat.completion.chunk",
      created: state.created,
      model: state.model || "unknown",
      choices: [
        {
          index: 0,
          delta: { content: delta },
          finish_reason: null,
        },
      ],
    };
  }

  // Text content done (ignore, we handle via delta)
  if (eventType === "response.output_text.done") {
    return null;
  }

  // Function call started (standard function_call or custom_tool_call).
  // Assigning by upstream item id prevents interleaved parallel calls from
  // merging their argument fragments into a single OpenAI tool call.
  if (
    eventType === "response.output_item.added" &&
    (data.item?.type === RESPONSES_ITEM.FUNCTION_CALL ||
      data.item?.type === "custom_tool_call")
  ) {
    const item = data.item;
    state.currentToolCallId = item.call_id || clampResponsesCallId();
    const key = item.id || data.item_id || state.currentToolCallId;
    const toolCallIndex = state.respToolChatIndex.has(key)
      ? state.respToolChatIndex.get(key)
      : state.toolCallIndex++;
    state.respToolChatIndex.set(key, toolCallIndex);

    return buildChunk(
      {
        id: state.chatId,
        created: state.created,
        model: state.model || MODEL_FALLBACK,
      },
      {
        tool_calls: [
          {
            index: toolCallIndex,
            id: state.currentToolCallId,
            type: OPENAI_BLOCK.FUNCTION,
            function: { name: item.name || "", arguments: "" },
          },
        ],
      },
    );
  }

  if (
    eventType === "response.function_call_arguments.delta" ||
    eventType === "response.custom_tool_call_input.delta"
  ) {
    const argumentsDelta = data.delta || "";
    if (!argumentsDelta) return null;
    const toolCallIndex =
      state.respToolChatIndex.get(data.item_id) ??
      Math.max(0, state.toolCallIndex - 1);
    state.respToolArgsEmitted.add(toolCallIndex);
    return buildChunk(
      {
        id: state.chatId,
        created: state.created,
        model: state.model || MODEL_FALLBACK,
      },
      {
        tool_calls: [
          { index: toolCallIndex, function: { arguments: argumentsDelta } },
        ],
      },
    );
  }

  if (
    eventType === "response.output_item.done" &&
    (data.item?.type === RESPONSES_ITEM.FUNCTION_CALL ||
      data.item?.type === "custom_tool_call")
  ) {
    const key = data.item?.id || data.item_id;
    const toolCallIndex =
      state.respToolChatIndex.get(key) ?? Math.max(0, state.toolCallIndex - 1);
    const argumentsValue = data.item?.arguments;
    if (
      typeof argumentsValue === "string" &&
      argumentsValue &&
      !state.respToolArgsEmitted.has(toolCallIndex)
    ) {
      state.respToolArgsEmitted.add(toolCallIndex);
      return buildChunk(
        {
          id: state.chatId,
          created: state.created,
          model: state.model || MODEL_FALLBACK,
        },
        {
          tool_calls: [
            { index: toolCallIndex, function: { arguments: argumentsValue } },
          ],
        },
      );
    }
    return null;
  }

  // Response completed
  if (eventType === "response.completed" || eventType === "response.done") {
    // Extract usage from response.completed event
    const responseUsage = data.response?.usage;
    if (responseUsage && typeof responseUsage === "object") {
      const inputTokens =
        responseUsage.input_tokens || responseUsage.prompt_tokens || 0;
      const outputTokens =
        responseUsage.output_tokens || responseUsage.completion_tokens || 0;
      // OpenAI Responses API: input_tokens already includes cached_tokens
      // Cache info is in input_tokens_details.cached_tokens
      const cacheReadTokens =
        responseUsage.input_tokens_details?.cached_tokens ||
        responseUsage.cache_read_input_tokens ||
        0;

      state.usage = {
        prompt_tokens: inputTokens,
        completion_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
      };

      // Add prompt_tokens_details if cache tokens exist
      if (cacheReadTokens > 0) {
        state.usage.prompt_tokens_details = {
          cached_tokens: cacheReadTokens,
        };
      }
    }

    if (!state.finishReasonSent) {
      const finishReason = computeFinishReason(state);

      state.finishReasonSent = true;
      state.finishReason = finishReason; // Mark for usage injection in stream.js

      const finalChunk = {
        id: state.chatId,
        object: "chat.completion.chunk",
        created: state.created,
        model: state.model || "unknown",
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: finishReason,
          },
        ],
      };

      // Include usage in final chunk if available
      if (state.usage && typeof state.usage === "object") {
        finalChunk.usage = state.usage;
      }

      return finalChunk;
    }
    return null;
  }

  // Error events from Responses API (e.g. model_not_found)
  if (eventType === "error" || eventType === "response.failed") {
    // Avoid emitting duplicate errors (error + response.failed arrive back-to-back)
    if (state.finishReasonSent) return null;

    const error = data.error || data.response?.error;
    if (error) {
      state.error = error;
      state.finishReasonSent = true;

      // Surface the error as an OpenAI-compatible error chunk
      return {
        id: state.chatId || `chatcmpl-${Date.now()}`,
        object: "chat.completion.chunk",
        created: state.created || Math.floor(Date.now() / 1000),
        model: state.model || "unknown",
        choices: [
          {
            index: 0,
            delta: {
              content: `[Error] ${error.message || JSON.stringify(error)}`,
            },
            finish_reason: "stop",
          },
        ],
      };
    }
    return null;
  }

  // Reasoning summary delta → emit as reasoning_content for client thinking display
  if (eventType === "response.reasoning_summary_text.delta") {
    const delta = data.delta || "";
    if (!delta) return null;
    return {
      id: state.chatId,
      object: "chat.completion.chunk",
      created: state.created,
      model: state.model || "unknown",
      choices: [
        { index: 0, delta: { reasoning_content: delta }, finish_reason: null },
      ],
    };
  }

  // Ignore other events
  return null;
}

// Register both directions
register(
  FORMATS.OPENAI,
  FORMATS.OPENAI_RESPONSES,
  null,
  openaiToOpenAIResponsesResponse,
);
register(
  FORMATS.OPENAI_RESPONSES,
  FORMATS.OPENAI,
  null,
  openaiResponsesToOpenAIResponse,
);
