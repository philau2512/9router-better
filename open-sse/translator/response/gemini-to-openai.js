import { register } from "../index.js";
import { FORMATS } from "../formats.js";
import { GEMINI_FINISH } from "../schema/finishReasons.js";
import { storeGeminiThoughtSignature } from "../../services/thoughtSignatureStore.js";

// Convert Gemini response chunk to OpenAI format
export function geminiToOpenAIResponse(chunk, state) {
  if (!chunk) return null;

  // Handle Antigravity wrapper
  const response = chunk.response || chunk;
  if (!response || !response.candidates?.[0]) return null;

  const results = [];
  const candidate = response.candidates[0];
  const content = candidate.content;
  const isAntigravityResponse = state.responseTargetFormat === FORMATS.ANTIGRAVITY;

  // Initialize state
  if (!state.messageId) {
    state.messageId = response.responseId || `msg_${Date.now()}`;
    state.model = response.modelVersion || state.model || "gemini";
    state.functionIndex = 0;
    // Keep Gemini bookkeeping separate from the shared translator state.toolCalls map.
    // The downstream OpenAI→Claude translator uses state.toolCalls for Claude block
    // metadata; pre-populating it here makes Anthropic tool deltas lose index.
    state.geminiToolCallCount = 0;
    results.push({
      id: `chatcmpl-${state.messageId}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: state.model,
      choices: [
        {
          index: 0,
          delta: { role: "assistant" },
          finish_reason: null,
        },
      ],
    });
  }

  const emitVisibleText = (text) => {
    if (text) state.geminiEmittedVisible = true;
    results.push({
      id: `chatcmpl-${state.messageId}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: state.model,
      choices: [
        {
          index: 0,
          delta: { content: text },
          finish_reason: null,
        },
      ],
    });
  };

  const emitText = (text, isThought) => {
    if (isThought) {
      if (state.geminiPendingContent) {
        const pending = state.geminiPendingContent;
        state.geminiPendingContent = "";
        emitVisibleText(pending);
      }
      state.geminiSawThought = true;
      results.push({
        id: `chatcmpl-${state.messageId}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: state.model,
        choices: [
          {
            index: 0,
            delta: { reasoning_content: text },
            finish_reason: null,
          },
        ],
      });
      return;
    }

    if (isAntigravityResponse) {
      // Antigravity sometimes streams agent self-talk as plain text, then only
      // establishes its private context with a signed tool call. Hold all
      // unmarked Antigravity text until that boundary or a terminal result
      // proves whether it is visible assistant output.
      state.geminiPendingContent = (state.geminiPendingContent || "") + text;
      return;
    }

    emitVisibleText(text);
  };

  const emitToolCall = (toolCall) => {
    results.push({
      id: `chatcmpl-${state.messageId}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: state.model,
      choices: [
        {
          index: 0,
          delta: { tool_calls: [toolCall] },
          finish_reason: null,
        },
      ],
    });
  };

  const flushPendingContent = () => {
    if (!state.geminiPendingContent) return;
    const pending = state.geminiPendingContent;
    state.geminiPendingContent = "";
    state.geminiSawThought = false;
    emitVisibleText(pending);
  };

  const flushPendingToolCalls = () => {
    for (const toolCall of state.geminiPendingToolCalls || []) {
      emitToolCall(toolCall);
    }
    state.geminiPendingToolCalls = [];
  };

  // Process parts
  if (content?.parts) {
    for (const part of content.parts) {
      const hasThoughtSig = part.thoughtSignature || part.thought_signature;
      if (hasThoughtSig && typeof hasThoughtSig === "string") {
        state.pendingThoughtSignature = hasThoughtSig;
      }
      const isThought = part.thought === true;

      // Handle thought signature (thinking mode)
      if (hasThoughtSig) {
        const hasTextContent = part.text !== undefined && part.text !== "";
        const hasFunctionCall = !!part.functionCall;

        // Standalone signatures apply to the following function call.
        if (!hasTextContent && !hasFunctionCall) {
          continue;
        }

        if (hasTextContent) {
          // A signature without `thought:true` belongs to a visible Gemini
          // response part. Only unmarked text is ambiguous before a signed
          // tool boundary.
          if (isThought) emitText(part.text, true);
          else emitVisibleText(part.text);
        }

        if (hasFunctionCall) {
          const rawName = part.functionCall.name;
          const fcName = state.toolNameMap?.get(rawName) || rawName;
          const fcArgs = part.functionCall.args || {};
          const toolCallIndex = state.functionIndex++;
          const callId =
            part.functionCall.id ||
            `gemini_call_${toolCallIndex}_${String(fcName || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_")}`;
          const thoughtSignature =
            typeof hasThoughtSig === "string"
              ? hasThoughtSig
              : state.pendingThoughtSignature;
          const toolCall = {
            id: callId,
            index: toolCallIndex,
            type: "function",
            function: { name: fcName, arguments: JSON.stringify(fcArgs) },
            ...(thoughtSignature && { thought_signature: thoughtSignature, thoughtSignature }),
          };
          if (thoughtSignature) {
            storeGeminiThoughtSignature(callId, thoughtSignature, state.sessionId, state.model);
          }
          state.pendingThoughtSignature = null;
          state.geminiToolCallCount = (state.geminiToolCallCount || 0) + 1;

          if (isAntigravityResponse && thoughtSignature) {
            state.geminiPendingContent = "";
          }
          if (isAntigravityResponse && state.geminiSawThought) {
            state.geminiPendingToolCalls = [
              ...(state.geminiPendingToolCalls || []),
              toolCall,
            ];
          } else {
            emitToolCall(toolCall);
          }
        }
        continue;
      }

      // Text content. Gemini marks model-internal thinking with `thought: true`.
      // Some responses include a thoughtSignature, but Google AI Studio/Gemini API
      // can also stream thought parts without a signature; those must not be
      // surfaced as normal assistant content in OpenAI-compatible clients.
      if (part.text !== undefined && part.text !== "") {
        emitText(part.text, isThought);
      }

      // Function call
      if (part.functionCall) {
        const rawName = part.functionCall.name;
        const fcName = state.toolNameMap?.get(rawName) || rawName;
        const fcArgs = part.functionCall.args || {};
        const toolCallIndex = state.functionIndex++;
        const callId =
          part.functionCall.id ||
          `gemini_call_${toolCallIndex}_${String(fcName || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_")}`;
        const thoughtSignature = state.pendingThoughtSignature || null;
        const toolCall = {
          id: callId,
          index: toolCallIndex,
          type: "function",
          function: { name: fcName, arguments: JSON.stringify(fcArgs) },
          ...(thoughtSignature && { thought_signature: thoughtSignature, thoughtSignature }),
        };
        if (thoughtSignature) {
          storeGeminiThoughtSignature(callId, thoughtSignature, state.sessionId, state.model);
        }
        state.pendingThoughtSignature = null;
        state.geminiToolCallCount = (state.geminiToolCallCount || 0) + 1;

        if (isAntigravityResponse && state.geminiSawThought) {
          state.geminiPendingToolCalls = [
            ...(state.geminiPendingToolCalls || []),
            toolCall,
          ];
        } else {
          emitToolCall(toolCall);
        }
      }

      // Inline data (images)
      const inlineData = part.inlineData || part.inline_data;
      if (inlineData?.data) {
        const mimeType =
          inlineData.mimeType || inlineData.mime_type || "image/png";
        results.push({
          id: `chatcmpl-${state.messageId}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: state.model,
          choices: [
            {
              index: 0,
              delta: {
                images: [
                  {
                    type: "image_url",
                    image_url: {
                      url: `data:${mimeType};base64,${inlineData.data}`,
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        });
      }
    }
  }

  // Usage metadata - extract before finish reason so we can include it
  const usageMeta = response.usageMetadata || chunk.usageMetadata;
  if (usageMeta && typeof usageMeta === "object") {
    const cachedTokens =
      typeof usageMeta.cachedContentTokenCount === "number"
        ? usageMeta.cachedContentTokenCount
        : 0;
    const promptTokenCountRaw =
      typeof usageMeta.promptTokenCount === "number"
        ? usageMeta.promptTokenCount
        : 0;
    const thoughtsTokens =
      typeof usageMeta.thoughtsTokenCount === "number"
        ? usageMeta.thoughtsTokenCount
        : 0;
    let candidatesTokens =
      typeof usageMeta.candidatesTokenCount === "number"
        ? usageMeta.candidatesTokenCount
        : 0;
    const totalTokens =
      typeof usageMeta.totalTokenCount === "number"
        ? usageMeta.totalTokenCount
        : 0;

    // prompt_tokens = promptTokenCount (includes cached tokens, matching claude-to-openai.js behavior)
    const promptTokens = promptTokenCountRaw;

    // Fallback calculation if candidatesTokenCount is 0 but totalTokenCount exists
    if (candidatesTokens === 0 && totalTokens > 0) {
      candidatesTokens = totalTokens - promptTokenCountRaw - thoughtsTokens;
      if (candidatesTokens < 0) candidatesTokens = 0;
    }

    // completion_tokens = candidatesTokenCount + thoughtsTokenCount (match Go code)
    const completionTokens = candidatesTokens + thoughtsTokens;

    state.usage = {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: totalTokens,
    };

    // Add prompt_tokens_details if cached tokens exist
    if (cachedTokens > 0) {
      state.usage.prompt_tokens_details = {
        cached_tokens: cachedTokens,
      };
    }

    // Add completion_tokens_details if reasoning tokens exist
    if (thoughtsTokens > 0) {
      state.usage.completion_tokens_details = {
        reasoning_tokens: thoughtsTokens,
      };
    }
  }

  // Finish reason - include usage in final chunk
  if (candidate.finishReason) {
    const rawFinishReason = String(candidate.finishReason);
    let finishReason = rawFinishReason.toLowerCase();
    if (rawFinishReason === GEMINI_FINISH.MALFORMED_FUNCTION_CALL) {
      state.providerError = {
        code: "malformed_function_call",
        message:
          candidate.finishMessage ||
          "Provider returned an empty or malformed function call",
      };
      finishReason = "error";
    }
    if (finishReason === "stop" && state.geminiToolCallCount > 0) {
      finishReason = "tool_calls";
    }

    if (isAntigravityResponse && finishReason === "max_tokens") {
      // Antigravity can emit an unmarked continuation of thought before a
      // truncated completion. It is ambiguous until this terminal reason, so
      // never surface that pending continuation as visible assistant text.
      state.geminiPendingContent = "";
    } else {
      flushPendingContent();
    }
    flushPendingToolCalls();

    // Empty STOP: provider returned no text/tools/thoughts (seen with AG tool
    // continuations). Mark state so callers can retry; do not present as a
    // successful empty completion that makes agent UIs exit.
    const parts = content?.parts || [];
    const partHasSubstance = parts.some(
      (p) =>
        !!p.functionCall ||
        !!p.inlineData ||
        (typeof p.text === "string" && p.text.length > 0),
    );
    const streamHadOutput =
      state.geminiToolCallCount > 0 ||
      state.geminiSawThought === true ||
      state.geminiEmittedVisible === true ||
      !!(state.geminiPendingContent && state.geminiPendingContent.length > 0);
    const usageEmpty =
      !state.usage ||
      !Number(state.usage.completion_tokens) ||
      Number(state.usage.completion_tokens) <= 0;
    if (
      finishReason === "stop" &&
      !partHasSubstance &&
      !streamHadOutput &&
      usageEmpty
    ) {
      state.emptyProviderResponse = true;
      finishReason = "error";
    }

    if (
      rawFinishReason === GEMINI_FINISH.MALFORMED_FUNCTION_CALL &&
      !partHasSubstance &&
      state.geminiToolCallCount === 0 &&
      !state.geminiEmittedVisible
    ) {
      state.emptyProviderResponse = true;
    }

    const finalChunk = {
      id: `chatcmpl-${state.messageId}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: state.model,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: finishReason,
        },
      ],
    };

    // Include usage in final chunk for downstream translators
    if (state.usage) {
      finalChunk.usage = state.usage;
    }

    results.push(finalChunk);
    state.finishReason = finishReason;
  }

  return results.length > 0 ? results : null;
}

// Register
register(FORMATS.GEMINI, FORMATS.OPENAI, null, geminiToOpenAIResponse);
register(FORMATS.GEMINI_CLI, FORMATS.OPENAI, null, geminiToOpenAIResponse);
register(FORMATS.ANTIGRAVITY, FORMATS.OPENAI, null, geminiToOpenAIResponse);
register(FORMATS.VERTEX, FORMATS.OPENAI, null, geminiToOpenAIResponse);
