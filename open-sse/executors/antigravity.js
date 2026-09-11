import crypto from "crypto";
import { BaseExecutor, waitForAbortableDelay } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import {
  OAUTH_ENDPOINTS,
  ANTIGRAVITY_HEADERS,
  AG_DEFAULT_TOOLS,
  AG_TOOL_SUFFIX,
  ANTIGRAVITY_PROMPT_REWRITES,
} from "../config/appConstants.js";
import { HTTP_STATUS } from "../config/runtimeConfig.js";
import {
  deriveSessionId,
  resolveSessionId,
  toNumericSessionId,
} from "../utils/sessionManager.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import {
  cleanJSONSchemaForAntigravity,
  sanitizeFunctionResponseData,
} from "../translator/helpers/geminiHelper.js";
import { ANTIGRAVITY_MODEL_ALIASES } from "../providers/antigravity-provider-metadata.js";
import { stripThinkingSuffix } from "../translator/concerns/thinkingUnified.js";
import { normalizeGeminiContents } from "../translator/formats/gemini.js";
import { DEFAULT_THINKING_AG_SIGNATURE } from "../config/defaultThinkingSignature.js";
import { getGeminiThoughtSignatureSync } from "../services/thoughtSignatureStore.js";

// Sanitize function name: Gemini requires [a-zA-Z_][a-zA-Z0-9_.:\-]{0,63}
function sanitizeFunctionName(name) {
  if (!name) return "_unknown";
  let s = name.replace(/[^a-zA-Z0-9_.:\-]/g, "_");
  if (!/^[a-zA-Z_]/.test(s)) s = "_" + s;
  return s.substring(0, 64);
}

const MAX_RETRY_AFTER_MS = 10000;
const ANTIGRAVITY_TRANSIENT_RETRY_MAX_MS = 15000;
const MAX_ANTIGRAVITY_OUTPUT_TOKENS = 16384;
const MAX_ANTIGRAVITY_THINKING_OUTPUT_TOKENS = 65535;
const MEDIUM_THINKING_BUDGET = 8192;

function getAntigravityOutputTokenLimit(generationConfig) {
  const thinkingConfig = generationConfig?.thinkingConfig;
  const thinkingBudget = thinkingConfig?.thinkingBudget;
  const thinkingLevel = String(thinkingConfig?.thinkingLevel || "").toLowerCase();
  const needsExtendedThinkingOutput =
    thinkingBudget === -1 ||
    (Number.isFinite(thinkingBudget) &&
      thinkingBudget >= MEDIUM_THINKING_BUDGET) ||
    thinkingLevel === "medium" ||
    thinkingLevel === "high";
  return needsExtendedThinkingOutput
    ? MAX_ANTIGRAVITY_THINKING_OUTPUT_TOKENS
    : MAX_ANTIGRAVITY_OUTPUT_TOKENS;
}

/** Keep thought parts on tool continuations when Gemini thinking is active. */
function shouldPreserveThoughtParts(generationConfig) {
  const tc = generationConfig?.thinkingConfig;
  if (!tc || typeof tc !== "object") return false;
  if (tc.includeThoughts === true) return true;
  if (tc.thinkingBudget === -1) return true;
  if (Number.isFinite(tc.thinkingBudget) && tc.thinkingBudget > 0) return true;
  const level = String(tc.thinkingLevel || "").toLowerCase();
  return level === "low" || level === "medium" || level === "high";
}

const ANTIGRAVITY_TRANSIENT_ERROR_PATTERNS = [
  /high\s+traffic/i,
  /agent\s+(execution\s+)?terminated\s+due\s+to\s+error/i,
  /capacity/i,
  /temporarily\s+unavailable/i,
  /timeout/i,
  /stream\s+(ended|closed|terminated|interrupted)/i,
  /empty\s+response/i,
];

const ANTIGRAVITY_TRANSIENT_STATUSES = new Set([
  HTTP_STATUS.SERVER_ERROR,
  HTTP_STATUS.BAD_GATEWAY,
  HTTP_STATUS.SERVICE_UNAVAILABLE,
  HTTP_STATUS.GATEWAY_TIMEOUT,
]);

// Fields Google generateContent rejects — stripped from the Antigravity request envelope.
// `thinking` is Claude's adaptive-thinking shape; Antigravity's v1internal
// Google envelope has no such top-level field and rejects it with HTTP 400.
const ANTIGRAVITY_REQUEST_BLACKLIST = ["output_config", "thinking"];

// Strip blacklisted fields from an object (used for both body.request and top-level body)
const stripBlacklisted = (obj) => {
  for (const key of ANTIGRAVITY_REQUEST_BLACKLIST) delete obj[key];
};

// Image generation model name patterns
const IMAGE_MODEL_PATTERNS = [/image/i, /imagen/i, /image-generation/i];

// Detect if a model is an image generation model
function isImageModel(model) {
  if (!model) return false;
  return IMAGE_MODEL_PATTERNS.some((p) => p.test(model));
}

/**
 * Follow an empty Antigravity STOP with an explicit user continuation while
 * retaining the original session ID and every prior conversation item.
 */
export function buildAntigravityEmptyStopContinuation(body) {
  const continuation = structuredClone(body);
  const request = continuation?.request;
  if (!request || !Array.isArray(request.contents)) {
    throw new Error("Antigravity continuation requires request.contents");
  }
  request.contents.push({ role: "user", parts: [{ text: "continue" }] });
  return continuation;
}

// Parse aspect ratio / resolution from model name suffixes
// e.g. "gemini-3.1-flash-image-16x9" -> { aspectRatio: "16:9" }
// e.g. "gemini-3.1-flash-image-1024x768" -> { aspectRatio: "4:3" }
function parseImageConfig(model) {
  const config = { aspectRatio: "1:1" };
  const resMatch = model.match(/(\d+)x(\d+)$/);
  if (resMatch) {
    const w = parseInt(resMatch[1]);
    const h = parseInt(resMatch[2]);
    if (w <= 16 && h <= 16) {
      config.aspectRatio = `${w}:${h}`;
    } else {
      // Resolution like 1024x768 — derive aspect ratio
      const gcd = (a, b) => (b ? gcd(b, a % b) : a);
      const d = gcd(w, h);
      config.aspectRatio = `${w / d}:${h / d}`;
    }
  }
  return config;
}

export class AntigravityExecutor extends BaseExecutor {
  constructor() {
    super("antigravity", PROVIDERS.antigravity);
  }

  buildUrl(model, stream, urlIndex = 0) {
    const baseUrls = this.getBaseUrls();
    const baseUrl = baseUrls[urlIndex] || baseUrls[0];
    // Image generation MUST use non-streaming generateContent
    const forceNonStream = isImageModel(model);
    const action =
      stream && !forceNonStream
        ? "streamGenerateContent?alt=sse"
        : "generateContent";
    return `${baseUrl}/v1internal:${action}`;
  }

  buildHeaders(credentials, stream = true, sessionId = null) {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${credentials.accessToken}`,
      "User-Agent":
        this.config.headers?.["User-Agent"] ||
        ANTIGRAVITY_HEADERS["User-Agent"],
      ...(sessionId && { "X-Machine-Session-Id": sessionId }),
      Accept: stream ? "text/event-stream" : "application/json",
    };
  }

  transformRequest(model, body, stream, credentials) {
    body = structuredClone(body);
    const projectId = credentials?.projectId || this.generateProjectId();

    // OpenAI clients may include stream_options even for non-streaming calls.
    // Google generateContent rejects that combination before processing the request.
    if (stream !== true) delete body.stream_options;

    // ─── Image generation: completely different request structure ───
    if (isImageModel(model)) {
      const imageConfig = parseImageConfig(model);
      // Strip model name suffixes for the actual API model name
      const cleanModel = model.replace(/-(\d+)x(\d+)$/, "");

      // Build simplified contents — text-only, merge all user messages
      const contents = [];
      const srcContents = body.request?.contents || body.contents || [];
      for (const c of srcContents) {
        const textParts = (c.parts || [])
          .filter((p) => p.text !== undefined)
          .map((p) => ({ text: p.text }));
        if (textParts.length > 0) {
          contents.push({ role: c.role || "user", parts: textParts });
        }
      }

      const sessionId =
        body.request?.sessionId ||
        deriveSessionId(credentials?.email || credentials?.connectionId);

      return {
        project: projectId,
        model: cleanModel,
        userAgent: "antigravity",
        requestType: "image_gen",
        requestId: `agent-${crypto.randomUUID()}`,
        request: {
          contents,
          generationConfig: {
            temperature: 1.0,
            topP: 0.95,
            topK: 40,
            maxOutputTokens: 8192,
            imageConfig,
          },
          sessionId,
          // No tools, no systemInstruction, no safetySettings for image gen
        },
      };
    }

    const rawSessionId = body.request?.sessionId || resolveSessionId({ headers: credentials?.rawHeaders, body, connectionId: credentials?.email || credentials?.connectionId, scope: "antigravity" });
    const sessionId = toNumericSessionId(rawSessionId) || rawSessionId;

    // ─── Standard (non-image) request ───
    // Fix contents for Claude models via Antigravity
    const keepThoughtParts = shouldPreserveThoughtParts(
      body.request?.generationConfig,
    );
    const rawContents = (body.request?.contents || []).map((c) => {
      let role = c.role;
      // functionResponse must be role "user" for Claude models
      if (c.parts?.some((p) => p.functionResponse)) {
        role = "user";
      }
      // Default: strip thought-only parts (Claude-via-AG / non-thinking).
      // When thinking is active, keep thought text for tool continuity; still
      // drop orphan signature-only parts (no text / no functionCall).
      const filteredParts = c.parts?.filter((p) => {
        if (p.thought && !p.functionCall && !keepThoughtParts) return false;
        if (p.thoughtSignature && !p.functionCall && !p.text) return false;
        return true;
      });
      // Gemini 3+ requires a thoughtSignature on the leading function call.
      // Preserve fork sanitization for function results and restore cached
      // signatures before using the safe default for clients that omit them.
      let firstFunctionCallSeen = false;
      const parts = filteredParts?.map((part) => {
        let nextPart = part;
        if (part.functionCall) {
          const callId = part.functionCall.id;
          const cachedSignature = callId
            ? getGeminiThoughtSignatureSync(callId, sessionId)
            : null;
          const thoughtSignature =
            part.thoughtSignature ||
            cachedSignature ||
            (!firstFunctionCallSeen
              ? DEFAULT_THINKING_AG_SIGNATURE
              : undefined);
          firstFunctionCallSeen = true;
          if (thoughtSignature && thoughtSignature !== part.thoughtSignature) {
            nextPart = { ...nextPart, thoughtSignature };
          }
        }
        if (nextPart.functionResponse?.response) {
          nextPart = {
            ...nextPart,
            functionResponse: {
              ...nextPart.functionResponse,
              response: sanitizeFunctionResponseData(
                nextPart.functionResponse.response,
              ),
            },
          };
        }
        return nextPart;
      });

      const partsChanged =
        parts?.length !== c.parts?.length ||
        parts?.some((part, index) => part !== c.parts[index]);
      if (role !== c.role || partsChanged) {
        return {
          ...c,
          role,
          parts: parts ?? c.parts,
        };
      }
      return c;
    });
    const normalizedContents = normalizeGeminiContents(rawContents);
    const contents =
      rawContents[0]?.role === "model" &&
      rawContents[0]?.parts?.some((part) => part.thought === true)
        ? normalizedContents.slice(1)
        : normalizedContents;

    // Sanitize tool schemas and function names before sending to Antigravity.
    let tools = body.request?.tools;

    if (tools && tools.length > 0) {
      // Merge all groups into a single functionDeclarations group (Gemini expects 1 group)
      // Deduplicate by sanitized name to avoid "Tool names must be unique" rejections.
      const seenToolNames = new Set();
      const allDeclarations = [];
      for (const group of tools) {
        for (const fn of group.functionDeclarations || []) {
          const name = sanitizeFunctionName(fn.name);
          if (seenToolNames.has(name)) continue;
          seenToolNames.add(name);
          allDeclarations.push({
            ...fn,
            name,
            parameters: fn.parameters
              ? cleanJSONSchemaForAntigravity(structuredClone(fn.parameters))
              : {
                  type: "object",
                  properties: {
                    reason: {
                      type: "string",
                      description: "Brief explanation",
                    },
                  },
                  required: ["reason"],
                },
          });
        }
      }
      tools =
        allDeclarations.length > 0
          ? [{ functionDeclarations: allDeclarations }]
          : [];
    }

    // Strip tools/toolConfig (handled separately) and blacklisted fields that Google rejects
    const {
      tools: _originalTools,
      toolConfig: _originalToolConfig,
      ...requestWithoutTools
    } = body.request || {};
    stripBlacklisted(requestWithoutTools);
    if (requestWithoutTools.systemInstruction?.parts) {
      for (const part of requestWithoutTools.systemInstruction.parts) {
        if (typeof part.text !== "string") continue;
        for (const { from, to } of ANTIGRAVITY_PROMPT_REWRITES) {
          part.text = part.text.replaceAll(from, to);
        }
      }
    }

    const generationConfig = {
      ...(requestWithoutTools.generationConfig || {}),
    };
    const maxOutputTokens = getAntigravityOutputTokenLimit(generationConfig);
    if (generationConfig.maxOutputTokens > maxOutputTokens) {
      generationConfig.maxOutputTokens = maxOutputTokens;
    }

    const transformedRequest = {
      ...requestWithoutTools,
      generationConfig,
      ...(contents && { contents }),
      ...(tools && { tools }),
      sessionId:
        sessionId ||
        deriveSessionId(credentials?.email || credentials?.connectionId),
      safetySettings: undefined,
      ...(tools?.length > 0 && {
        toolConfig: { functionCallingConfig: { mode: "VALIDATED" } },
      }),
    };

    // Strip blacklisted thinking fields from top-level body (set by thinkingUnified.js at root, not body.request)
    stripBlacklisted(body);

    const upstreamModel =
      ANTIGRAVITY_MODEL_ALIASES[stripThinkingSuffix(model)] ||
      stripThinkingSuffix(model);

    return {
      ...body,
      project: projectId,
      model: upstreamModel,
      userAgent: "antigravity",
      requestType: "agent",
      requestId: `agent-${crypto.randomUUID()}`,
      request: transformedRequest,
    };
  }

  async refreshCredentials(credentials, log, proxyOptions = null) {
    if (!credentials.refreshToken) return null;

    try {
      const response = await proxyAwareFetch(
        OAUTH_ENDPOINTS.google.token,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
          },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: credentials.refreshToken,
            client_id: this.config.clientId,
            client_secret: this.config.clientSecret,
          }),
        },
        proxyOptions,
      );

      if (!response.ok) return null;

      const tokens = await response.json();
      log?.info?.("TOKEN", "Antigravity refreshed");

      return {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || credentials.refreshToken,
        expiresIn: tokens.expires_in,
        projectId: credentials.projectId,
      };
    } catch (error) {
      log?.error?.("TOKEN", `Antigravity refresh error: ${error.message}`);
      return null;
    }
  }

  generateProjectId() {
    const adj = ["useful", "bright", "swift", "calm", "bold"][
      Math.floor(Math.random() * 5)
    ];
    const noun = ["fuze", "wave", "spark", "flow", "core"][
      Math.floor(Math.random() * 5)
    ];
    return `${adj}-${noun}-${crypto.randomUUID().slice(0, 5)}`;
  }

  generateSessionId() {
    return crypto.randomUUID() + Date.now().toString();
  }

  parseRetryHeaders(headers) {
    if (!headers?.get) return null;

    const retryAfter = headers.get("retry-after");
    if (retryAfter) {
      const seconds = parseInt(retryAfter, 10);
      if (!isNaN(seconds) && seconds > 0) return seconds * 1000;

      const date = new Date(retryAfter);
      if (!isNaN(date.getTime())) {
        const diff = date.getTime() - Date.now();
        return diff > 0 ? diff : null;
      }
    }

    const resetAfter = headers.get("x-ratelimit-reset-after");
    if (resetAfter) {
      const seconds = parseInt(resetAfter, 10);
      if (!isNaN(seconds) && seconds > 0) return seconds * 1000;
    }

    const resetTimestamp = headers.get("x-ratelimit-reset");
    if (resetTimestamp) {
      const ts = parseInt(resetTimestamp, 10) * 1000;
      const diff = ts - Date.now();
      return diff > 0 ? diff : null;
    }

    return null;
  }

  async computeRetryDelay(response, attempt) {
    let bodyText = "";
    let errorJson = null;
    try {
      bodyText = await response.clone().text();
      errorJson = bodyText ? JSON.parse(bodyText) : null;
    } catch {
      // Retry decisions remain fail-open when a response body cannot be read.
    }

    const message = this.extractErrorMessage(errorJson, bodyText);
    if (!this.isTransientAntigravityError(response.status, message)) {
      return false;
    }

    const retryMs =
      this.parseRetryHeaders(response.headers) ||
      this.parseRetryFromErrorMessage(message);
    if (retryMs) {
      return retryMs <= MAX_RETRY_AFTER_MS ? retryMs : false;
    }

    const cap =
      response.status === HTTP_STATUS.RATE_LIMITED
        ? MAX_RETRY_AFTER_MS
        : ANTIGRAVITY_TRANSIENT_RETRY_MAX_MS;
    return Math.min(1000 * 2 ** attempt, cap);
  }

  // Parse retry time from Antigravity error message body
  // Format: "Your quota will reset after 2h7m23s" or "1h30m" or "45m" or "30s"
  parseRetryFromErrorMessage(errorMessage) {
    if (!errorMessage || typeof errorMessage !== "string") return null;

    const match = errorMessage.match(/reset after (\d+h)?(\d+m)?(\d+s)?/i);
    if (!match) return null;

    let totalMs = 0;
    if (match[1]) totalMs += parseInt(match[1]) * 3600 * 1000; // hours
    if (match[2]) totalMs += parseInt(match[2]) * 60 * 1000; // minutes
    if (match[3]) totalMs += parseInt(match[3]) * 1000; // seconds

    return totalMs > 0 ? totalMs : null;
  }

  extractErrorMessage(errorJson, bodyText = "") {
    return [
      errorJson?.error?.message,
      errorJson?.message,
      errorJson?.error,
      bodyText,
    ]
      .filter(Boolean)
      .map((v) => (typeof v === "string" ? v : JSON.stringify(v)))
      .join("\n");
  }

  isTransientAntigravityError(status, message) {
    if (status === HTTP_STATUS.RATE_LIMITED) return true;
    if (ANTIGRAVITY_TRANSIENT_STATUSES.has(status)) return true;
    return ANTIGRAVITY_TRANSIENT_ERROR_PATTERNS.some((pattern) =>
      pattern.test(message || ""),
    );
  }

  /**
   * Parse Antigravity 429 quota errors to extract precise reset timestamp.
   * Looks for ErrorInfo.metadata.quotaResetTimeStamp (absolute) or
   * RetryInfo.retryDelay (relative seconds, e.g. "12872.41s") in gRPC details array.
   * Without this, the fallback backoff only locks for a few seconds despite a 3-4h quota reset.
   * @param {Response} response
   * @param {string} bodyText
   */
  parseError(response, bodyText) {
    if (response.status === 429 && bodyText) {
      try {
        const json = JSON.parse(bodyText);
        const details = json?.error?.details;
        if (Array.isArray(details)) {
          // Prefer absolute reset timestamp from ErrorInfo metadata (most reliable)
          for (const detail of details) {
            if (
              detail["@type"]?.includes("ErrorInfo") &&
              detail?.metadata?.quotaResetTimeStamp
            ) {
              const resetMs = new Date(
                detail.metadata.quotaResetTimeStamp,
              ).getTime();
              if (resetMs > Date.now()) {
                return {
                  status: 429,
                  message: json.error?.message || bodyText,
                  resetsAtMs: resetMs,
                };
              }
            }
          }
          // Fallback: relative delay from RetryInfo (e.g. "12872.411299746s")
          for (const detail of details) {
            if (detail["@type"]?.includes("RetryInfo") && detail?.retryDelay) {
              const seconds = parseFloat(
                String(detail.retryDelay).replace(/s$/, ""),
              );
              if (seconds > 0) {
                return {
                  status: 429,
                  message: json.error?.message || bodyText,
                  resetsAtMs: Date.now() + seconds * 1000,
                };
              }
            }
          }
        }
      } catch {
        /* fall through to default */
      }
    }
    return super.parseError(response, bodyText);
  }

  async execute({
    model,
    body,
    stream,
    credentials,
    signal,
    log,
    proxyOptions = null,
  }) {
    const fallbackCount = this.getFallbackCount();
    let lastError = null;
    let lastStatus = 0;
    const MAX_AUTO_RETRIES = 3;
    const MAX_RETRY_AFTER_RETRIES = 3;
    const retryAttemptsByUrl = {}; // Track retry attempts per URL
    const retryAfterAttemptsByUrl = {}; // Track Retry-After retries per URL

    for (let urlIndex = 0; urlIndex < fallbackCount; urlIndex++) {
      const url = this.buildUrl(model, stream, urlIndex);
      const transformedBody = this.transformRequest(
        model,
        body,
        stream,
        credentials,
      );
      const sessionId = transformedBody.request?.sessionId;
      const headers = this.buildHeaders(credentials, stream, sessionId);

      // Initialize retry counters for this URL
      if (!retryAttemptsByUrl[urlIndex]) {
        retryAttemptsByUrl[urlIndex] = 0;
      }
      if (!retryAfterAttemptsByUrl[urlIndex]) {
        retryAfterAttemptsByUrl[urlIndex] = 0;
      }

      try {
        const response = await proxyAwareFetch(
          url,
          {
            method: "POST",
            headers,
            body: JSON.stringify(transformedBody),
            signal,
          },
          proxyOptions,
        );

        if (
          response.status === HTTP_STATUS.RATE_LIMITED ||
          ANTIGRAVITY_TRANSIENT_STATUSES.has(response.status)
        ) {
          // Read error body once for Retry-After parsing + transient error detection
          let retryMs = this.parseRetryHeaders(response.headers);
          let retryBodyText = "";
          let retryErrorJson = null;
          try {
            retryBodyText = await response.clone().text();
            retryErrorJson = retryBodyText ? JSON.parse(retryBodyText) : null;
          } catch {
            // ignore parse errors — fall through to status/message based retry
          }
          const retryErrorMessage = this.extractErrorMessage(
            retryErrorJson,
            retryBodyText,
          );

          if (!retryMs) {
            retryMs = this.parseRetryFromErrorMessage(retryErrorMessage);
          }

          if (
            retryMs &&
            retryMs <= MAX_RETRY_AFTER_MS &&
            retryAfterAttemptsByUrl[urlIndex] < MAX_RETRY_AFTER_RETRIES
          ) {
            retryAfterAttemptsByUrl[urlIndex]++;
            log?.debug?.(
              "RETRY",
              `${response.status} with Retry-After: ${Math.ceil(retryMs / 1000)}s, waiting... (${retryAfterAttemptsByUrl[urlIndex]}/${MAX_RETRY_AFTER_RETRIES})`,
            );
            await waitForAbortableDelay(retryMs, signal);
            urlIndex--;
            continue;
          }

          // Auto retry transient errors (429 + 5xx capacity patterns) with bounded backoff
          if (
            this.isTransientAntigravityError(
              response.status,
              retryErrorMessage,
            ) &&
            (!retryMs || retryMs === 0) &&
            retryAttemptsByUrl[urlIndex] < MAX_AUTO_RETRIES
          ) {
            retryAttemptsByUrl[urlIndex]++;
            const cap =
              response.status === HTTP_STATUS.RATE_LIMITED
                ? MAX_RETRY_AFTER_MS
                : ANTIGRAVITY_TRANSIENT_RETRY_MAX_MS;
            const backoffMs = Math.min(
              1000 * 2 ** retryAttemptsByUrl[urlIndex],
              cap,
            );
            const label =
              response.status === HTTP_STATUS.RATE_LIMITED
                ? "429"
                : `${response.status} transient`;
            log?.debug?.(
              "RETRY",
              `${label} auto retry ${retryAttemptsByUrl[urlIndex]}/${MAX_AUTO_RETRIES} after ${backoffMs / 1000}s`,
            );
            await waitForAbortableDelay(backoffMs, signal);
            urlIndex--;
            continue;
          }

          log?.debug?.(
            "RETRY",
            `${response.status}, Retry-After ${retryMs ? `too long (${Math.ceil(retryMs / 1000)}s)` : "missing"}, trying fallback`,
          );
          lastStatus = response.status;

          if (urlIndex + 1 < fallbackCount) {
            continue;
          }
        }

        if (this.shouldRetry(response.status, urlIndex)) {
          log?.debug?.(
            "RETRY",
            `${response.status} on ${url}, trying fallback ${urlIndex + 1}`,
          );
          lastStatus = response.status;
          continue;
        }

        return { response, url, headers, transformedBody };
      } catch (error) {
        lastError = error;
        if (urlIndex + 1 < fallbackCount) {
          log?.debug?.(
            "RETRY",
            `Error on ${url}, trying fallback ${urlIndex + 1}`,
          );
          continue;
        }
        throw error;
      }
    }

    throw (
      lastError ||
      new Error(`All ${fallbackCount} URLs failed with status ${lastStatus}`)
    );
  }

  /**
   * Cloak tools before sending to Antigravity provider (anti-ban):
   * - Rename client tools with _ide suffix
   * - Inject AG default decoy tools after client tools
   * Returns { cloakedBody, toolNameMap } where toolNameMap maps suffixed → original
   */
  static cloakTools(body, clientTool = null) {
    const tools = body.request?.tools;
    if (!tools || tools.length === 0) {
      return { cloakedBody: body, toolNameMap: null };
    }

    const isCopilot = clientTool === "github-copilot";
    const toolNameMap = new Map();
    const clientDeclarations = [];
    const decoyNames = new Set(AG_DECOY_TOOLS.map((tool) => tool.name));

    // First: collect renamed client tools
    for (const toolGroup of tools) {
      if (!toolGroup.functionDeclarations) continue;

      for (const func of toolGroup.functionDeclarations) {
        // For GitHub Copilot, avoid emitting duplicate native Antigravity tool names.
        // Keep the decoys only once in the final declaration list.
        if (isCopilot && AG_DEFAULT_TOOLS.has(func.name)) {
          continue;
        }

        // Skip if already covered by decoys for Copilot
        if (isCopilot && decoyNames.has(func.name)) {
          continue;
        }

        // Preserve native AG names for non-Copilot clients
        if (AG_DEFAULT_TOOLS.has(func.name)) {
          clientDeclarations.push(func);
          continue;
        }

        const suffixed = `${func.name}${AG_TOOL_SUFFIX}`;
        toolNameMap.set(suffixed, func.name);
        clientDeclarations.push({ ...func, name: suffixed });
      }
    }

    // Client tools first, then AG decoy tools
    const allDeclarations = [];
    const seenNames = new Set();
    for (const decl of [...clientDeclarations, ...AG_DECOY_TOOLS]) {
      if (!decl?.name || seenNames.has(decl.name)) continue;
      seenNames.add(decl.name);
      allDeclarations.push(decl);
    }

    // Rename tool names in conversation history (contents)
    const cloakedContents = body.request?.contents?.map((msg) => {
      if (!msg.parts) return msg;

      const cloakedParts = msg.parts.map((part) => {
        // Rename functionCall.name
        if (
          part.functionCall &&
          !AG_DEFAULT_TOOLS.has(part.functionCall.name)
        ) {
          return {
            ...part,
            functionCall: {
              ...part.functionCall,
              name: `${part.functionCall.name}${AG_TOOL_SUFFIX}`,
            },
          };
        }

        // Rename functionResponse.name
        if (
          part.functionResponse &&
          !AG_DEFAULT_TOOLS.has(part.functionResponse.name)
        ) {
          return {
            ...part,
            functionResponse: {
              ...part.functionResponse,
              name: `${part.functionResponse.name}${AG_TOOL_SUFFIX}`,
            },
          };
        }

        return part;
      });

      return { ...msg, parts: cloakedParts };
    });

    // Single functionDeclarations group: client tools first, then decoys
    return {
      cloakedBody: {
        ...body,
        request: {
          ...body.request,
          tools: [{ functionDeclarations: allDeclarations }],
          contents: cloakedContents || body.request.contents,
        },
      },
      toolNameMap,
    };
  }
}

// AG decoy tools — same names as AG native defaults, redirect to _ide suffixed tools
const AG_DECOY_TOOLS = [
  {
    name: "browser_subagent",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] },
  },
  {
    name: "command_status",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] },
  },
  {
    name: "find_by_name",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] },
  },
  {
    name: "generate_image",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] },
  },
  {
    name: "grep_search",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] },
  },
  {
    name: "list_dir",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] },
  },
  {
    name: "list_resources",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] },
  },
  {
    name: "mcp_sequential-thinking_sequentialthinking",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] },
  },
  {
    name: "multi_replace_file_content",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] },
  },
  {
    name: "notify_user",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] },
  },
  {
    name: "read_resource",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] },
  },
  {
    name: "read_terminal",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] },
  },
  {
    name: "read_url_content",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] },
  },
  {
    name: "replace_file_content",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] },
  },
  {
    name: "run_command",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] },
  },
  {
    name: "search_web",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] },
  },
  {
    name: "send_command_input",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] },
  },
  {
    name: "task_boundary",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] },
  },
  {
    name: "view_content_chunk",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] },
  },
  {
    name: "view_file",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] },
  },
  {
    name: "write_to_file",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] },
  },
];

export default AntigravityExecutor;
