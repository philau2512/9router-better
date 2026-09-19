/**
 * Phase 3 (Group A) — Kiro tool-name sanitize + restore.
 *
 * Kiro upstream can reject tool names with unusual characters, excessive
 * length, or the MCP `mcp__server__tool` form (400). We sanitize ONLY names
 * that are actually invalid — valid names like `read_file` stay byte-identical
 * so the common Claude Code / Cursor path is untouched — and keep a
 * sanitized→original map so the response side can restore the client's name.
 *
 * NARROW rule (diverges from Kiro-Go's camelCase-everything): only rewrite when
 * a name has chars outside [a-zA-Z0-9_-], is >64 chars, or is an MCP triple.
 */

import { describe, it, expect } from "vitest";
import {
  sanitizeKiroToolName,
  buildKiroToolNameMap,
  restoreToolNamesInOpenAIResponse,
} from "../../open-sse/translator/helpers/toolCallHelper.js";

const VALID = /^[a-zA-Z0-9_-]{1,64}$/;

describe("sanitizeKiroToolName", () => {
  it("leaves an already-valid name byte-identical", () => {
    expect(sanitizeKiroToolName("read_file")).toBe("read_file");
    expect(sanitizeKiroToolName("Bash")).toBe("Bash");
    expect(sanitizeKiroToolName("get-weather_v2")).toBe("get-weather_v2");
  });

  it("shortens an MCP triple to a valid <=64 name that keeps the mcp__ prefix", () => {
    const out = sanitizeKiroToolName("mcp__github__create_issue");
    expect(out).not.toBe("mcp__github__create_issue");
    expect(out.startsWith("mcp__")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(64);
    expect(out).toMatch(VALID);
  });

  it("strips characters outside [a-zA-Z0-9_-]", () => {
    const out = sanitizeKiroToolName("weird name.with/chars!");
    expect(out).toMatch(VALID);
    expect(out).not.toMatch(/[ ./!]/);
  });

  it("truncates names longer than 64 chars", () => {
    const long = "a".repeat(100);
    const out = sanitizeKiroToolName(long);
    expect(out.length).toBeLessThanOrEqual(64);
    expect(out).toMatch(VALID);
  });

  it("is idempotent: sanitize(sanitize(x)) === sanitize(x)", () => {
    for (const x of [
      "read_file",
      "mcp__github__create_issue",
      "weird name.with/chars!",
      "a".repeat(100),
    ]) {
      const once = sanitizeKiroToolName(x);
      expect(sanitizeKiroToolName(once)).toBe(once);
    }
  });
});

describe("buildKiroToolNameMap", () => {
  it("only contains entries for names that actually changed", () => {
    const map = buildKiroToolNameMap([
      "read_file",
      "mcp__github__create_issue",
    ]);
    // valid name is not in the map
    expect([...map.values()]).toContain("mcp__github__create_issue");
    expect([...map.values()]).not.toContain("read_file");
    // key is the sanitized form → value is the original
    const sanitized = sanitizeKiroToolName("mcp__github__create_issue");
    expect(map.get(sanitized)).toBe("mcp__github__create_issue");
  });

  it("returns an empty map when every name is valid", () => {
    const map = buildKiroToolNameMap(["read_file", "Bash", "grep"]);
    expect(map.size).toBe(0);
  });

  it("disambiguates two originals that collapse to the same sanitized name", () => {
    // Both strip to the same base → second must get a numeric suffix.
    const map = buildKiroToolNameMap(["a!b", "a@b"]);
    expect(map.size).toBe(2);
    const keys = [...map.keys()];
    expect(new Set(keys).size).toBe(2); // keys are unique
    keys.forEach((k) => expect(k).toMatch(VALID));
  });

  it("does not let a sanitized name collide with a distinct already-valid name", () => {
    // "mcp__server__foo" collapses to "mcp__foo"; a separate genuinely-valid
    // tool is literally named "mcp__foo". The sanitized MCP name MUST be
    // disambiguated so restore stays 1:1 and upstream sees no duplicate.
    const map = buildKiroToolNameMap(["mcp__server__foo", "mcp__foo"]);
    // Only the MCP triple changed → exactly one entry, and its key is NOT the
    // valid name it would otherwise clash with.
    expect(map.size).toBe(1);
    const [key] = [...map.keys()];
    expect(key).not.toBe("mcp__foo");
    expect(map.get(key)).toBe("mcp__server__foo");
  });
});

describe("request round-trip — payload sanitize + map attach", () => {
  const mcpName = "mcp.github:create_issue";

  it("[claude route] sanitizes MCP tool def, keeps valid tool, attaches map", async () => {
    const { claudeToKiroRequest } = await import(
      "../../open-sse/translator/request/claude-to-kiro.js"
    );
    const body = {
      messages: [{ role: "user", content: "do it" }],
      tools: [
        { name: "read_file", input_schema: {} },
        { name: mcpName, input_schema: {} },
      ],
    };
    const payload = claudeToKiroRequest("claude-sonnet-4.5", body, true, {});
    const tools =
      payload.conversationState.currentMessage.userInputMessage
        .userInputMessageContext.tools;
    const names = tools.map((t) => t.toolSpecification.name);

    // valid name untouched
    expect(names).toContain("read_file");
    // MCP name rewritten (not present in raw form)
    expect(names).not.toContain(mcpName);
    // map present and restores the sanitized name back to the original
    const map = payload._toolNameMap;
    expect(map).toBeInstanceOf(Map);
    expect([...map.values()]).toContain(mcpName);
  });

  it("[openai route] sanitizes MCP tool def and attaches map", async () => {
    const { buildKiroPayload } = await import(
      "../../open-sse/translator/request/openai-to-kiro.js"
    );
    const body = {
      messages: [{ role: "user", content: "do it" }],
      tools: [
        { type: "function", function: { name: "read_file", parameters: {} } },
        { type: "function", function: { name: mcpName, parameters: {} } },
      ],
    };
    const payload = buildKiroPayload("claude-sonnet-4.5", body, true, {});
    const map = payload._toolNameMap;
    expect(map).toBeInstanceOf(Map);
    expect([...map.values()]).toContain(mcpName);
  });

  it("valid-only tool set leaves the payload without a map (common path untouched)", async () => {
    const { claudeToKiroRequest } = await import(
      "../../open-sse/translator/request/claude-to-kiro.js"
    );
    const body = {
      messages: [{ role: "user", content: "do it" }],
      tools: [{ name: "read_file", input_schema: {} }],
    };
    const payload = claudeToKiroRequest("claude-sonnet-4.5", body, true, {});
    expect(payload._toolNameMap).toBeUndefined();
  });
});

describe("response restore — sanitized → original at emit", () => {
  it("[claude route] restores the original tool name on the tool_use block", async () => {
    const { kiroToClaudeResponse } = await import(
      "../../open-sse/translator/response/kiro-to-claude.js"
    );
    const sanitized = sanitizeKiroToolName("mcp__github__create_issue");
    const state = {
      nextBlockIndex: 0,
      toolNameMap: new Map([[sanitized, "mcp__github__create_issue"]]),
    };
    const chunk = {
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: "call_1", function: { name: sanitized } },
            ],
          },
        },
      ],
    };
    const results = kiroToClaudeResponse(chunk, state);
    const start = results.find((r) => r.type === "content_block_start");
    expect(start.content_block.name).toBe("mcp__github__create_issue");
  });

  it("[claude route] fail-open: a name not in the map passes through unchanged", async () => {
    const { kiroToClaudeResponse } = await import(
      "../../open-sse/translator/response/kiro-to-claude.js"
    );
    const state = { nextBlockIndex: 0, toolNameMap: new Map() };
    const chunk = {
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: "call_1", function: { name: "read_file" } },
            ],
          },
        },
      ],
    };
    const results = kiroToClaudeResponse(chunk, state);
    const start = results.find((r) => r.type === "content_block_start");
    expect(start.content_block.name).toBe("read_file");
  });

  it("[openai route] restores the original tool name in the tool_call chunk", async () => {
    const { convertKiroToOpenAI } = await import(
      "../../open-sse/translator/response/kiro-to-openai.js"
    );
    const sanitized = sanitizeKiroToolName("mcp__github__create_issue");
    const state = {
      chunkIndex: 0,
      responseId: "r",
      created: 0,
      toolNameMap: new Map([[sanitized, "mcp__github__create_issue"]]),
    };
    const chunk = {
      toolUseEvent: { toolUseId: "call_1", name: sanitized, input: {} },
    };
    const out = convertKiroToOpenAI(chunk, state);
    expect(out.choices[0].delta.tool_calls[0].function.name).toBe(
      "mcp__github__create_issue",
    );
  });
});

describe("restoreToolNamesInOpenAIResponse — non-streaming restore", () => {
  it("restores sanitized names on an OpenAI-shaped body and fails open", () => {
    const map = buildKiroToolNameMap(["mcp__github__create_issue"]);
    const sanitized = sanitizeKiroToolName("mcp__github__create_issue");
    const body = {
      choices: [
        {
          message: {
            tool_calls: [
              { function: { name: sanitized } }, // in map → restored
              { function: { name: "read_file" } }, // not in map → unchanged
            ],
          },
        },
      ],
    };
    restoreToolNamesInOpenAIResponse(body, map);
    const names = body.choices[0].message.tool_calls.map(
      (t) => t.function.name,
    );
    expect(names).toEqual(["mcp__github__create_issue", "read_file"]);
  });

  it("is a no-op with an empty map or a non-OpenAI body", () => {
    const body = { choices: [{ message: { tool_calls: [] } }] };
    expect(restoreToolNamesInOpenAIResponse(body, new Map())).toBe(body);
    expect(restoreToolNamesInOpenAIResponse({}, new Map([["a", "b"]]))).toEqual(
      {},
    );
  });
});
