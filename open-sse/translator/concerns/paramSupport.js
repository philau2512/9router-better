// Strip request params a given provider/model rejects upstream (e.g. HTTP 400).
// Config-driven: add a rule instead of scattering `delete body.x` across executors.
import { getCapabilitiesForModel } from "../../providers/capabilities.js";

// Each rule: optional provider, regex match on model, list of params to drop.
// A param is removed only when it is present (!== undefined).
const STRIP_RULES = [
  // All Claude models: temperature deprecated/rejected upstream (Anthropic 400). #1748
  { match: /claude/i, drop: ["temperature"] },
  // GitHub Copilot gpt-5.4: temperature unsupported.
  { provider: "github", match: /gpt-5\.4/i, drop: ["temperature"] },
  // GitHub Copilot Claude (except opus/sonnet 4.6): thinking + reasoning_effort rejected. #713
  {
    provider: "github",
    match: (m) => /claude/i.test(m) && !/claude.*(opus|sonnet).*4\.6/i.test(m),
    drop: ["thinking", "reasoning_effort"],
  },
  // Cloudflare Workers AI: content must be plain string, rejects OpenAI content-part array (#1926)
  { provider: "cloudflare-ai", flattenContent: true },
  // xAI: all models reject reasoning/thinking parameters with HTTP 400.
  {
    provider: "xai",
    drop: ["reasoning", "reasoning_effort", "thinking"],
  },
  // Volcengine Ark GLM-5 rejects max_tokens above the model output ceiling.
  // MiMo Desktop Preview models (account-service route): content must be plain string,
  // rejects OpenAI content-part array. Cloud models keep their parts (mimo-v2-omni is multi-modal).
  { provider: "xiaomi-mimo", match: /preview/i, flattenContent: true },
  { provider: "volcengine-ark", match: /glm-5/i, clampToModelMaxOutput: true },
  // VolcEngine Ark caps Kimi family at max_tokens <= 32768. Model's advertised
  // ceiling is far higher (Kimi-K2.7-Code → maxOutput 262144), so clampToModelMaxOutput
  // alone leaves it uncapped and requests 400. Pin explicit endpoint cap; min()
  // with model ceiling still applies if variant's own limit is lower.
  // See upstream fix cfbdf0604.
  {
    provider: "volcengine-ark",
    match: /kimi/i,
    maxOutputCap: 32768,
    clampToModelMaxOutput: true,
  },
];

// Test a rule's match (regex or predicate) against the model id.
function matches(rule, model) {
  return typeof rule.match === "function"
    ? rule.match(model)
    : rule.match.test(model);
}

function clampNumber(body, key, ceiling) {
  if (!Number.isFinite(ceiling) || body[key] === undefined) return;
  const value = Number(body[key]);
  if (!Number.isFinite(value) || value <= ceiling) return;
  body[key] = ceiling;
}

// Remove unsupported params from body in place; returns body.
export function stripUnsupportedParams(provider, model, body) {
  if (!model || !body || typeof body !== "object") return body;
  for (const rule of STRIP_RULES) {
    if (rule.provider && rule.provider !== provider) continue;
    if (rule.match && !matches(rule, model)) continue;
    if (Array.isArray(rule.drop)) {
      for (const key of rule.drop) {
        if (body[key] !== undefined) delete body[key];
      }
    }
    // CF Workers AI oneOf root schema only accepts content as plain string (#1926)
    if (rule.flattenContent && Array.isArray(body.messages)) {
      for (const msg of body.messages) {
        if (msg && Array.isArray(msg.content)) {
          msg.content = msg.content
            .map((b) =>
              b?.type === "text" && typeof b.text === "string" ? b.text : "",
            )
            .join("");
        }
      }
    }
    if (rule.clampToModelMaxOutput || Number.isFinite(rule.maxOutputCap)) {
      const modelCeiling = getCapabilitiesForModel(provider, model).maxOutput;
      const candidates = [];
      if (
        rule.clampToModelMaxOutput &&
        Number.isFinite(modelCeiling) &&
        modelCeiling > 0
      ) {
        candidates.push(modelCeiling);
      }
      if (Number.isFinite(rule.maxOutputCap) && rule.maxOutputCap > 0) {
        candidates.push(rule.maxOutputCap);
      }
      if (candidates.length > 0) {
        const ceiling = Math.min(...candidates);
        clampNumber(body, "max_tokens", ceiling);
        clampNumber(body, "max_completion_tokens", ceiling);
        clampNumber(body, "max_output_tokens", ceiling);
      }
    }
  }
  // Clamp reasoning_effort "max" → "xhigh" for all OpenAI-format providers.
  // OpenAI enum caps at "xhigh"; sending "max" returns HTTP 400.
  // RED-TEAM fix H-1: covers non-Codex providers (cursor, grok-web, openrouter, etc.)
  // See upstream commit 288940960.
  if (body.reasoning_effort === "max") body.reasoning_effort = "xhigh";
  if (body.reasoning?.effort === "max") body.reasoning.effort = "xhigh";
  return body;
}
