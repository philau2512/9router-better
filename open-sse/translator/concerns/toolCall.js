import { ensureToolCallIds } from "../helpers/toolCallHelper.js";
import { FORMATS } from "../formats.js";

// Anthropic tool_use.id must match: ^[a-zA-Z0-9_-]+$
const TOOL_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * Strip orphaned tool results from a request body before upstream dispatch.
 *
 * When client-side history compaction removes an assistant turn containing
 * tool calls but keeps the corresponding tool results, strict APIs like
 * Anthropic and Gemini reject the request with HTTP 400.
 *
 * Handles two wire formats:
 *   - OpenAI Chat Completions: role:"tool" messages matched by tool_call_id
 *   - Anthropic Messages: content[type=tool_result] blocks matched by tool_use_id
 *
 * NOTE: Kiro path is handled separately by reconcileOrphanedToolResults()
 * in openai-to-kiro.js — do not call this for Kiro targets.
 *
 * Port of upstream PR #2298.
 *
 * @param {object} body - Request body (mutated in place for efficiency)
 * @returns {object} body (same reference)
 */
export function stripOrphanedToolResults(body) {
  if (!body?.messages || !Array.isArray(body.messages)) return body;

  // Phase 1: Collect all live tool-call IDs from assistant messages only.
  // Gate to role === "assistant" to avoid false positives from user messages
  // that happen to contain tool_use blocks (e.g. Anthropic vision payloads).
  const liveIds = new Set();
  for (const msg of body.messages) {
    if (msg?.role !== "assistant") continue;

    // OpenAI Chat format: assistant.tool_calls[].id
    if (Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        if (tc?.id) liveIds.add(tc.id);
      }
    }

    // Anthropic format: assistant.content[type=tool_use].id
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block?.type === "tool_use" && block.id) liveIds.add(block.id);
      }
    }
  }

  // No tool calls in history at all — nothing to orphan
  if (liveIds.size === 0) return body;

  // Phase 2: Remove orphaned references
  const cleaned = [];
  let removed = 0;

  for (const msg of body.messages) {
    // OpenAI Chat: role:"tool" messages matched by tool_call_id
    if (msg.role === "tool") {
      if (liveIds.has(msg.tool_call_id)) {
        cleaned.push(msg);
      } else {
        removed++;
      }
      continue;
    }

    // Anthropic: user messages may contain tool_result content blocks
    if (msg.role === "user" && Array.isArray(msg.content)) {
      const filteredContent = msg.content.filter((block) => {
        if (block?.type !== "tool_result") return true;
        if (liveIds.has(block.tool_use_id)) return true;
        removed++;
        return false;
      });

      if (filteredContent.length === 0 && msg.content.length > 0) {
        // Entire user message was only orphaned tool results — drop the message
        removed++;
        continue;
      }

      cleaned.push(
        filteredContent.length === msg.content.length
          ? msg
          : { ...msg, content: filteredContent },
      );
      continue;
    }

    cleaned.push(msg);
  }

  if (removed > 0) {
    body.messages = cleaned;
  }

  return body;
}

// Get tool_call ids from assistant message (OpenAI format: tool_calls, Claude format: tool_use in content)
export function getToolCallIds(msg) {
  if (msg.role !== "assistant") return [];

  const ids = [];

  // OpenAI format: tool_calls array
  if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      if (tc.id) ids.push(tc.id);
    }
  }

  // Claude format: tool_use blocks in content
  if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (block.type === "tool_use" && block.id) {
        ids.push(block.id);
      }
    }
  }

  return ids;
}

// Check if user message has tool_result for given ids (OpenAI format: role=tool, Claude format: tool_result in content)
export function hasToolResults(msg, toolCallIds) {
  if (!msg || !toolCallIds.length) return false;

  // OpenAI format: role = "tool" with tool_call_id
  if (msg.role === "tool" && msg.tool_call_id) {
    return toolCallIds.includes(msg.tool_call_id);
  }

  // Claude format: tool_result blocks in user message content
  if (msg.role === "user" && Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (block.type === "tool_result" && toolCallIds.includes(block.tool_use_id)) {
        return true;
      }
    }
  }

  return false;
}

// Fix missing tool responses - insert empty tool_result if assistant has tool_use but next message has no tool_result
export function fixMissingToolResponses(body) {
  if (!body.messages || !Array.isArray(body.messages)) return body;

  const newMessages = [];

  for (let i = 0; i < body.messages.length; i++) {
    const msg = body.messages[i];
    const nextMsg = body.messages[i + 1];

    newMessages.push(msg);

    // Check if this is assistant with tool_calls/tool_use
    const toolCallIds = getToolCallIds(msg);
    if (toolCallIds.length === 0) continue;

    // Check if next message has tool_result
    if (nextMsg && !hasToolResults(nextMsg, toolCallIds)) {
      // Insert tool responses for each tool_call
      for (const id of toolCallIds) {
        // OpenAI format: role = "tool"
        newMessages.push({
          role: "tool",
          tool_call_id: id,
          content: ""
        });
      }
    }
  }

  body.messages = newMessages;
  return body;
}

// Default `type: "custom"` on Claude-format tools that arrive without one.
// Anthropic's Claude tool schema requires `type` to be explicitly set; strict gateways
// (e.g., MiniMax Anthropic-compatible endpoint, error 2013) reject legacy payloads that
// omit it with HTTP 400. Tools that already carry a truthy `type` (e.g., `computer_use`,
// `bash`, `web_search_20250305`) are passed through untouched.
//
// Spread order matters: `{ ...tool, type: "custom" }` (spread first, override last)
// ensures that falsy `type` values (null, undefined, "") in the original tool don't
// overwrite the default. `{ type: "custom", ...tool }` would let `type: null` survive.
export function defaultClaudeToolType(tools) {
  if (!Array.isArray(tools)) return tools;
  return tools.map(tool => tool?.type ? tool : { ...tool, type: "custom" });
}

// Whether Claude-format tools need explicit `type` defaulting before dispatch.
// Only gateways that declare the `requireClaudeToolType` quirk (MiniMax) reject typeless
// tools. Applying the default globally breaks Claude-format endpoints that only accept the
// legacy typeless tool shape — DeepSeek's Anthropic-compatible endpoint answers HTTP 400
// "unknown variant `custom`" and every Claude Code request routed there fails (#3905).
export function shouldDefaultClaudeToolType(provider, finalFormat, tools, PROVIDERS) {
  return (
    finalFormat === FORMATS.CLAUDE
    && Array.isArray(tools)
    && PROVIDERS?.[provider]?.quirks?.requireClaudeToolType === true
  );
}
