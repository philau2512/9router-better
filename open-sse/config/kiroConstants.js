/**
 * Kiro-specific constants and helpers.
 *
 * Mirrors the behaviour of `internal/translator/kiro/common/constants.go` and
 * `internal/translator/kiro/claude/kiro_claude_request.go` from the
 * CLIProxyAPIPlus reference implementation, scoped down to what 9router needs:
 *
 *   - `-agentic` model suffix detection + chunked-write system prompt
 *   - reasoning / thinking trigger detection (Anthropic-Beta header,
 *     Claude `thinking`, OpenAI `reasoning_effort`, AMP/Cursor magic tag)
 *   - schema-specific native effort fields for supported GPT and Claude models
 *   - legacy `<thinking_mode>` system-prompt injection for other models
 *
 * Kiro upstream does not advertise `-agentic` model IDs; they are a 9router
 * fiction. The suffix is stripped before the request leaves this process.
 */

import { createHash } from "crypto";
import {
  extractThinking,
  parseSuffix,
} from "../translator/concerns/thinkingUnified.js";
import { effortToBudget } from "../translator/concerns/thinking.js";
export const KIRO_THINKING_SUFFIX = "-thinking";
export const KIRO_AGENTIC_SUFFIX = "-agentic";
export const KIRO_TOOL_NAME_MAX_LENGTH = 64;
export const KIRO_TOOL_DESCRIPTION_MAX_LENGTH = 10237;
export const KIRO_TOOL_ID_MAX_LENGTH = 64;
export const KIRO_CODEWHISPERER_TARGET =
  "AmazonCodeWhispererStreamingService.GenerateAssistantResponse";
export const KIRO_ENDPOINT_FALLBACK_STATUSES = new Set([401, 403, 404]);

// Namespace for deterministic conversationId (uuidv5). Shared by both the
// OpenAI and Claude routes so two requests with the same first-user-content
// hash to the same Kiro/AWS conversation context (reuses the Builder ID prompt
// cache instead of burning free-tier quota on a fresh context per request).
export const KIRO_CONVERSATION_NAMESPACE =
  "34f7193f-561d-4050-bc84-9547d953d6bf";

// --- Client fidelity (Phase 2, Group A) ---------------------------------
// The Kiro IDE talks to CodeWhisperer via the aws-sdk-js v1 client. Emulating
// its real User-Agent + agent-mode/optout headers (instead of the thin
// "AWS-SDK-JS/3.0.0 kiro-ide/1.0.0") lowers the risk of an upstream flagging a
// free-tier account for looking like an unknown client.
//
// SINGLE SOURCE OF TRUTH for the client identity. The chat/streaming path
// (generateAssistantResponse) and the model-listing path (ListAvailableModels
// in services/kiroModels.js) are two aws-sdk sub-clients of the SAME IDE
// install: the `api/<service>#<ver>` segment legitimately differs per
// sub-client, but the IDE build, node runtime, OS and — crucially — the
// machineId MUST be identical, or the same account presents two conflicting
// fingerprints on the same surface (the opposite of the ban-avoidance goal).

// aws-sdk sub-client versions — legitimately differ per service surface.
export const KIRO_STREAMING_SDK_VERSION = "1.0.34"; // codewhispererstreaming
export const KIRO_RUNTIME_SDK_VERSION = "1.0.0"; // codewhispererruntime (listing)
// Shared IDE-install identity — MUST match across every sub-client call.
export const KIRO_CLIENT_VERSION = "0.10.32"; // KiroIDE build the reference client reports
export const KIRO_NODE_VERSION = "22.21.1"; // node runtime the IDE bundles
export const KIRO_AGENT_OS = "windows";
export const KIRO_AGENT_OS_VERSION = "10.0.26200";

/**
 * Derive a STABLE per-account machineId. Keyed off whatever durable identifier
 * the credential carries, so the same account always presents the same id
 * across restarts and across both sub-client surfaces. Never random — a
 * per-request random id would itself be an anomalous fingerprint.
 *
 * @param {object} credentials
 * @returns {string} 64-char hex machine id
 */
export function deriveKiroMachineId(credentials) {
  const seed =
    credentials?.providerSpecificData?.clientId ||
    credentials?.refreshToken ||
    credentials?.providerSpecificData?.profileArn ||
    credentials?.accessToken ||
    "kiro-anonymous";
  return createHash("sha256").update(String(seed)).digest("hex");
}

/**
 * Build the two User-Agent strings a real Kiro IDE client sends for a given
 * sub-client surface:
 *   - `streaming` → the long `User-Agent` header
 *   - `short`     → the compact `X-Amz-User-Agent` header
 *
 * The machineId is derived from the credential (stable per account) and always
 * appended, matching the model-listing path so both calls from one account
 * carry the identical `KiroIDE-<ver>-<machineId>` tag.
 *
 * @param {object} [opts]
 * @param {object} [opts.credentials] Credential to derive the machineId from.
 * @param {"streaming"|"runtime"} [opts.surface="streaming"] aws-sdk sub-client.
 * @returns {{ streaming: string, short: string, machineId: string }}
 */
export function buildKiroClientUserAgent({
  credentials,
  surface = "streaming",
} = {}) {
  const machineId = deriveKiroMachineId(credentials);
  const sdkVersion =
    surface === "runtime"
      ? KIRO_RUNTIME_SDK_VERSION
      : KIRO_STREAMING_SDK_VERSION;
  const apiName =
    surface === "runtime" ? "codewhispererruntime" : "codewhispererstreaming";
  // Retrieval-mode token: listing advertises N,E (name + endpoint discovery);
  // streaming advertises E only. Matches the reference client per surface.
  const retrievalMode = surface === "runtime" ? "N,E" : "E";
  const kiroTag = `KiroIDE-${KIRO_CLIENT_VERSION}-${machineId}`;
  const streaming =
    `aws-sdk-js/${sdkVersion} ua/2.1 ` +
    `os/${KIRO_AGENT_OS}#${KIRO_AGENT_OS_VERSION} lang/js ` +
    `md/nodejs#${KIRO_NODE_VERSION} ` +
    `api/${apiName}#${sdkVersion} m/${retrievalMode} ${kiroTag}`;
  const short = `aws-sdk-js/${sdkVersion} ${kiroTag}`;
  return { streaming, short, machineId };
}

// Shared CodeWhisperer profile ARNs. These are ENDPOINT-SPECIFIC — the same
// account needs a DIFFERENT profileArn depending on which host it hits. This
// was verified empirically against a real Builder ID account (see matrix below,
// generateAssistantResponse):
//
//   endpoint                              omit profileArn   AAAACCCCXXXX
//   runtime.us-east-1.kiro.dev            400 "required"    200 OK
//   codewhisperer.us-east-1.amazonaws     200 OK            403 "not authorized"
//   q.us-east-1.amazonaws                 200 OK            403 "not authorized"
//
// So for a free-tier Builder ID account (which CANNOT resolve its own ARN —
// ListAvailableProfiles returns 403 "AWS Builder ID is not supported"):
//   * kiro.dev surface  -> MUST send the shared builder ARN (AAAACCCCXXXX)
//   * amazonaws surface -> MUST omit the ARN entirely
// Social (google/github) tokens carry their own real ARN from token refresh.
export const KIRO_DEFAULT_PROFILE_ARNS = {
  // kiro.dev shared free-tier Builder ID profile (required on that surface).
  "builder-id":
    "arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX",
  social: "arn:aws:codewhisperer:us-east-1:699475941385:profile/EHGA3GRVQMUK",
};

// Backward-compatible Builder ID default for legacy callers.
export const KIRO_DEFAULT_PROFILE_ARN = KIRO_DEFAULT_PROFILE_ARNS["builder-id"];

/** True when the resolved request URL targets the kiro.dev gateway surface. */
export function isKiroDevEndpoint(url) {
  return typeof url === "string" && url.includes("kiro.dev");
}

/**
 * Last-resort shared profileArn for a given auth method + endpoint when no
 * account-specific ARN is available.
 * - social (google/github): shared social profile.
 * - builder-id / imported / unknown free-tier: shared builder ARN ONLY on the
 *   kiro.dev surface; "" (omit) on the amazonaws surface.
 */
export function resolveDefaultProfileArn(authMethod, endpoint) {
  if (authMethod === "google" || authMethod === "github") {
    return KIRO_DEFAULT_PROFILE_ARNS.social;
  }
  // Free-tier Builder ID (and imported/unknown): endpoint-dependent.
  return isKiroDevEndpoint(endpoint)
    ? KIRO_DEFAULT_PROFILE_ARNS["builder-id"]
    : "";
}

/**
 * Single source of truth for the profileArn sent with a Kiro request.
 *
 * ENDPOINT-AWARE (see the matrix on KIRO_DEFAULT_PROFILE_ARNS):
 * - An account-specific ARN (stored on the credential, e.g. IDC/api_key/social
 *   discovered ARN) always wins — it's the account's own profile.
 * - Otherwise, free-tier Builder ID accounts have NO discoverable profile, so
 *   we use the endpoint-specific shared value: AAAACCCCXXXX on kiro.dev, omit
 *   on amazonaws. Sending the wrong one for the endpoint yields 400 (omit on
 *   kiro.dev) or 403 (AAAA on amazonaws).
 *
 * @param {object} credentials Credential object with providerSpecificData
 * @param {object} [opts]
 * @param {string} [opts.endpoint] The resolved request URL for this attempt.
 * @returns {string} profileArn to send ('' means "omit the ARN")
 */
export function resolveKiroRequestProfileArn(credentials, opts = {}) {
  const psd = credentials?.providerSpecificData || {};
  const endpoint = opts.endpoint;
  // A real, account-specific ARN (not the shared builder placeholder) always wins.
  const stored = psd.profileArn;
  if (stored && stored !== KIRO_DEFAULT_PROFILE_ARNS["builder-id"]) {
    return stored;
  }
  return resolveDefaultProfileArn(psd.authMethod, endpoint);
}

export const KIRO_THINKING_BUDGET_DEFAULT = 16000;

/**
 * Anthropic date-suffixed snapshot id, e.g. `claude-sonnet-4-5-20250929`.
 * Kiro's data plane only accepts the dotted alias (`claude-sonnet-4.5`).
 */
const ANTHROPIC_SNAPSHOT_SUFFIX = /-\d{8}$/;

/**
 * Fold an Anthropic model id onto the Kiro upstream alias.
 *
 * Anthropic and Kiro disagree on id spelling: Anthropic ships
 * `claude-sonnet-4-5-20250929` / `claude-opus-4-5`, while Kiro's
 * `GenerateAssistantResponse` only accepts `claude-sonnet-4.5` and answers
 * anything else with `400 INVALID_MODEL_ID`.
 *
 * Clients that speak the Anthropic Messages API (Claude Code, cc-switch, …)
 * send the Anthropic spelling, so the raw id has to be folded onto the Kiro
 * alias before the request leaves this process. Matching is keyword-based
 * rather than an exact-id table: snapshot suffixes and future minor revisions
 * would otherwise fall through and 400 upstream.
 *
 * Unknown ids are returned untouched so operators can still pass through
 * models Kiro adds ahead of this list.
 *
 * @param {string} model
 * @returns {string}
 */
export function normalizeKiroUpstreamModelId(model) {
  if (typeof model !== "string" || model === "") return model;

  const id = model.toLowerCase().replace(ANTHROPIC_SNAPSHOT_SUFFIX, "");

  if (id.includes("sonnet")) {
    if (id.includes("5.5") || id.includes("5-5")) return "claude-sonnet-5.5";
    if (id.includes("4.6") || id.includes("4-6")) return "claude-sonnet-4.6";
    if (id.includes("sonnet-5") || id.includes("sonnet.5")) return "claude-sonnet-5";
    if (id.includes("4.5") || id.includes("4-5")) return "claude-sonnet-4.5";
    if (id.includes("sonnet-4") || id.includes("sonnet.4")) return "claude-sonnet-4";
    return "claude-sonnet-4.5";
  }
  if (id.includes("fable")) return "claude-fable-5";
  if (id.includes("opus")) {
    if (id.includes("5.5") || id.includes("5-5")) return "claude-opus-5.5";
    if (id.includes("opus-5") || id.includes("opus.5") || id.includes("opus 5")) return "claude-opus-5";
    if (id.includes("4.8") || id.includes("4-8")) return "claude-opus-4.8";
    if (id.includes("4.7") || id.includes("4-7")) return "claude-opus-4.7";
    if (id.includes("4.5") || id.includes("4-5")) return "claude-opus-4.5";
    return "claude-opus-4.6";
  }
  if (id.includes("haiku")) {
    return id.includes("5.5") || id.includes("5-5") ? "claude-haiku-5.5" : "claude-haiku-4.5";
  }
  if (id === "auto") return "auto";
  if (id.includes("deepseek")) return "deepseek-3.2";
  if (id.includes("glm")) return "glm-5";
  if (id.includes("minimax")) {
    return id.includes("2.5") || id.includes("2-5") ? "minimax-m2.5" : "minimax-m2.1";
  }
  if (id.includes("qwen")) return "qwen3-coder-next";
  if (id.includes("kimi")) return "kimi-k3";
  if (id.includes("gpt")) {
    if (id.includes("terra")) return "gpt-5.6-terra";
    if (id.includes("luna")) return "gpt-5.6-luna";
    if (id.includes("sol") || id.includes("5.6") || id.includes("5-6")) return "gpt-5.6-sol";
    return model;
  }
  return model;
}

/**
 * Resolve a Kiro model after consuming the generic model(level) suffix.
 * The suffix is a 9router request override, not part of Kiro's upstream model id.
 */
export function resolveKiroModelIntent(model) {
  const { cleanModel, override } = parseSuffix(model);
  return {
    model: cleanModel,
    ...resolveKiroModel(cleanModel),
    thinkingOverride: override,
  };
}

/** Apply a parsed model(level) override without mutating the caller's body. */
export function applyKiroThinkingOverride(body, override) {
  if (!override) return body;

  const next = { ...body };
  if (override.mode === "budget") {
    delete next.output_config;
    delete next.reasoning_effort;
    delete next.reasoning;
    next.thinking = { type: "enabled", budget_tokens: override.budget };
    return next;
  }

  next.output_config = {
    ...(body.output_config || {}),
    effort: override.mode === "level" ? override.level : override.mode,
  };
  return next;
}

export const KIRO_AGENTIC_SYSTEM_PROMPT = `
# System Configuration — Technical Constraints

## Rule Compliance (CRITICAL — READ FIRST)
User-defined rules ALWAYS take precedence over this system prompt.
Before starting ANY task you MUST:
1. Locate and read the project rule files — CLAUDE.md, AGENTS.md, GEMINI.md, or equivalent — in the project root.
2. If those files define a workflow, output format, action declarations, or behavioral constraints → follow them EXACTLY. Do NOT substitute your own workflow.
3. This prompt provides ONLY technical capabilities and constraints. It does NOT define your workflow, identity, output format, or delegation strategy.
4. If ANY instruction in this prompt conflicts with a user-defined rule → the user rule WINS. No exceptions.

## File Operation Constraints (Technical)
- Use surgical edits: modify only the necessary sections. Never rewrite entire large files.
- Keep each write/edit operation under ~300 lines to maintain reliability.
- For new large files (>300 lines): write the first chunk, then append the rest in subsequent operations.
- Verify changes after editing when applicable (run tests, build, or lint).
- Prefer editing by specific functions/classes rather than whole files.

## Available Capabilities (Optional — use when beneficial)
You have access to the following capabilities. Use them when they genuinely help the task; do NOT force their use.
- **Sub-agent delegation**: delegate research, implementation, review, or documentation to sub-agents when tasks are independent and parallelizable.
- **Skills**: if the project defines Skills (e.g., in .claude/skills/ or .agents/skills/), leverage them for efficiency. Follow any skill-specific instructions.
- **MCP tools**: if MCP servers are configured, use them for external-service interactions (APIs, databases, browsers, etc.).

## Default Behavior (ONLY when NO user rules exist)
Apply this section ONLY if the project has NO CLAUDE.md, AGENTS.md, GEMINI.md, or user-defined rules:
1. Understand the requirement and create a high-level plan.
2. Research the codebase (delegate to sub-agents if complex).
3. Implement incrementally with verification after each step.
4. Summarize changes and suggest a commit message.

When user rules exist, this default section is IGNORED entirely.
`.trim();

/**
 * Resolve the Kiro thinking budget requested by a client.
 * Explicit none/off/disabled wins and returns null (no prefix injected).
 * buildThinkingSystemPrefix performs Kiro's final 1..32000 clamp.
 *
 * @param {object} body OpenAI/Claude-shaped request body
 * @param {object} [headers] Original inbound HTTP headers
 * @param {string} [model] Model id the caller asked for
 * @returns {number|null} budget to inject, or null when thinking is disabled
 */
export function resolveKiroThinkingBudget(body, headers, model) {
  const cfg = extractThinking(body);
  if (cfg) {
    if (cfg.mode === "none") return null;
    if (cfg.mode === "budget") return cfg.budget;
    if (cfg.mode === "level")
      return effortToBudget(cfg.level) ?? KIRO_THINKING_BUDGET_DEFAULT;
    return KIRO_THINKING_BUDGET_DEFAULT;
  }

  if (headers) {
    const beta = pickHeader(headers, "anthropic-beta");
    if (
      typeof beta === "string" &&
      beta.toLowerCase().includes("interleaved-thinking")
    ) {
      return KIRO_THINKING_BUDGET_DEFAULT;
    }
  }

  if (containsThinkingModeTag(body)) return KIRO_THINKING_BUDGET_DEFAULT;

  if (typeof model === "string" && model) {
    const m = model.toLowerCase();
    if (m.includes("thinking") || m.includes("-reason"))
      return KIRO_THINKING_BUDGET_DEFAULT;
  }

  return null;
}

export function extractKiroEffortLevel(body) {
  const effort =
    body?.output_config?.effort ??
    body?.reasoning_effort ??
    (typeof body?.reasoning === "object" ? body.reasoning?.effort : null);
  if (typeof effort !== "string") return null;
  const normalized = effort.toLowerCase();
  if (["none", "off", "disabled"].includes(normalized)) return null;
  if (["xhigh", "max"].includes(normalized)) return "high";
  return ["low", "medium", "high"].includes(normalized)
    ? normalized
    : null;
}

function extractKiroGptEffortLevel(body) {
  const effort =
    body?.output_config?.effort ??
    body?.reasoning_effort ??
    (typeof body?.reasoning === "object" ? body.reasoning?.effort : null);
  if (typeof effort !== "string") return null;
  const normalized = effort.toLowerCase();
  if (normalized === "max") return "xhigh";
  return ["low", "medium", "high", "xhigh"].includes(normalized)
    ? normalized
    : null;
}

export function buildKiroAdditionalModelRequestFields(
  body,
  effortPath = "output_config",
) {
  if (effortPath === "reasoning") {
    const effort = extractKiroGptEffortLevel(body);
    if (!effort) return undefined;
    return { reasoning: { effort } };
  }
  const effort = extractKiroEffortLevel(body);
  if (!effort) return undefined;
  return {
    thinking: { type: "adaptive", display: "summarized" },
    output_config: { effort },
  };
}

export function resolveKiroEffortPath(model) {
  if (typeof model !== "string") return null;
  const normalized = model.toLowerCase().replace(/-/g, ".");
  if (/(?:^|[/.])gpt[/.]5[/.]6(?:[/.]|$)/.test(normalized)) {
    return "reasoning";
  }
  if (!normalized.includes("claude")) return null;
  const match = normalized.match(
    /(?:^|[/.])claude(?:[/.][a-z]+)*[/.](\d+)(?:[/.](\d+))?(?:[/.]|$)/,
  );
  if (!match) return null;
  const [, majorText, minorText] = match;
  const major = Number(majorText);
  const minor = minorText === undefined ? null : Number(minorText);
  const dateSuffixMinor = minor !== null && minor >= 1000;
  return major < 4 || (major === 4 && (minor === null || minor <= 5 || dateSuffixMinor))
    ? null
    : "output_config";
}

export function supportsKiroAdditionalModelRequestFields(model) {
  return resolveKiroEffortPath(model) !== null;
}

export function usesKiroNativeGptEffort(body, model) {
  return (
    resolveKiroEffortPath(model) === "reasoning" &&
    extractKiroGptEffortLevel(body) !== null
  );
}

export function buildKiroAdditionalModelRequestFieldsForModel(body, model) {
  const effortPath = resolveKiroEffortPath(model);
  return effortPath
    ? buildKiroAdditionalModelRequestFields(body, effortPath)
    : undefined;
}
/**
 * Detect whether reasoning features are explicitly requested via body or model id.
 * Used to decide whether to inject thinking tags even without a -thinking suffix.
 *
 * @param {object} body OpenAI/Claude-shaped request body
 * @param {object} [headers] Original inbound HTTP headers
 * @param {string} [model] Model id the caller asked for
 * @returns {boolean}
 */
export function isReasoningRequested(body, headers, model) {
  if (headers) {
    const beta = pickHeader(headers, "anthropic-beta");
    if (typeof beta === "string") {
      const b = beta.toLowerCase();
      if (b.includes("thinking") || b.includes("interleaved-thinking")) {
        return true;
      }
    }
  }

  if (body && typeof body === "object") {
    const oc = body.output_config?.effort;
    if (typeof oc === "string") {
      const v = oc.toLowerCase();
      if (
        v !== "none" &&
        (v === "low" || v === "medium" || v === "high" || v === "auto")
      ) {
        return true;
      }
    }

    if (containsThinkingModeTag(body)) {
      return true;
    }
  }

  if (typeof model === "string" && model) {
    const m = model.toLowerCase();
    if (m.includes("thinking") || m.includes("-reason")) {
      return true;
    }
  }

  return false;
}

/**
 * Detect whether an inbound request is asking for reasoning / thinking output.
 *
 * This remains a thin wrapper around the fork's unified budget parser so
 * disabled/adaptive and model-suffix paths remain behaviorally aligned.
 */
export function isThinkingEnabled(body, headers, model) {
  return resolveKiroThinkingBudget(body, headers, model) !== null;
}

/**
 * Detect whether a model id refers to a 9router synthetic agentic variant.
 * Agentic variants share the same upstream model as the base; the only
 * difference is the chunked-write system prompt this module injects.
 *
 * @param {string} model
 * @returns {boolean}
 */
export function isAgenticModel(model) {
  return typeof model === "string" && model.endsWith(KIRO_AGENTIC_SUFFIX);
}

/**
 * Strip the `-agentic` suffix from a model id, leaving the upstream-real id.
 *
 * @param {string} model
 * @returns {string}
 */
export function stripAgenticSuffix(model) {
  if (!isAgenticModel(model)) return model;
  return model.slice(0, -KIRO_AGENTIC_SUFFIX.length);
}

/**
 * Detect whether a model id is a 9router synthetic thinking variant
 * (e.g. `claude-sonnet-4.5-thinking`). Same upstream model as the base; the
 * only difference is `<thinking_mode>enabled</thinking_mode>` injection.
 *
 * Note: real Kiro thinking-capable variants exist (e.g. `kimi-k2-thinking` in
 * other providers), but for the `kr/` namespace there is no `-thinking`
 * model on Kiro upstream. Treat the suffix as a synthetic alias.
 *
 * @param {string} model Model id with `-agentic` already stripped
 * @returns {boolean}
 */
export function isThinkingModel(model) {
  return typeof model === "string" && model.endsWith(KIRO_THINKING_SUFFIX);
}

/**
 * Strip the `-thinking` suffix from a model id.
 *
 * @param {string} model
 * @returns {string}
 */
export function stripThinkingSuffix(model) {
  if (!isThinkingModel(model)) return model;
  return model.slice(0, -KIRO_THINKING_SUFFIX.length);
}

/**
 * Resolve a 9router model id to the real upstream Kiro model id, plus flags
 * describing which behaviours the suffixes implied.
 *
 *   resolveKiroModel("claude-sonnet-4.5-thinking-agentic")
 *     => { upstream: "claude-sonnet-4.5", agentic: true, thinking: true }
 *   resolveKiroModel("claude-sonnet-4.5-thinking")
 *     => { upstream: "claude-sonnet-4.5", agentic: false, thinking: true }
 *   resolveKiroModel("claude-sonnet-4.5-agentic")
 *     => { upstream: "claude-sonnet-4.5", agentic: true, thinking: false }
 *   resolveKiroModel("claude-sonnet-4.5")
 *     => { upstream: "claude-sonnet-4.5", agentic: false, thinking: false }
 *
 * @param {string} model
 * @returns {{ upstream: string, agentic: boolean, thinking: boolean }}
 */
export function resolveKiroModel(model) {
  let upstream = model;
  let agentic = false;
  let thinking = false;
  if (isAgenticModel(upstream)) {
    agentic = true;
    upstream = stripAgenticSuffix(upstream);
  }
  if (isThinkingModel(upstream)) {
    thinking = true;
    upstream = stripThinkingSuffix(upstream);
  }
  return { upstream: normalizeKiroUpstreamModelId(upstream), agentic, thinking };
}

/**
 * Build the magic system-prompt prefix that turns Kiro reasoning on.
 * Same shape as CLIProxyAPIPlus.
 *
 * @param {number} [budget=KIRO_THINKING_BUDGET_DEFAULT]
 */
export function buildThinkingSystemPrefix(
  budget = KIRO_THINKING_BUDGET_DEFAULT,
) {
  const safeBudget = Math.max(
    1,
    Math.min(32000, Number(budget) || KIRO_THINKING_BUDGET_DEFAULT),
  );
  return `<thinking_mode>enabled</thinking_mode>\n<max_thinking_length>${safeBudget}</max_thinking_length>`;
}

function pickHeader(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === "function") {
    return headers.get(name);
  }
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) {
      return headers[key];
    }
  }
  return undefined;
}

function containsThinkingModeTag(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (const msg of messages) {
    if (!msg) continue;
    if (msg.role !== "system" && msg.role !== "user") continue;
    const content = msg.content;
    if (typeof content === "string") {
      if (containsTagInText(content)) return true;
    } else if (Array.isArray(content)) {
      for (const part of content) {
        const text = part?.text;
        if (typeof text === "string" && containsTagInText(text)) return true;
      }
    }
  }
  if (typeof body?.system === "string" && containsTagInText(body.system))
    return true;
  return false;
}

function containsTagInText(text) {
  if (!text) return false;
  if (!text.includes("<thinking_mode>")) return false;
  return (
    text.includes("<thinking_mode>enabled</thinking_mode>") ||
    text.includes("<thinking_mode>interleaved</thinking_mode>")
  );
}
