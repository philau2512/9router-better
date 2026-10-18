// All intercepted domains + URL patterns per tool

const fs = require("fs");

const IS_DEV = process.env.NODE_ENV === "development";

// Resolve lsof absolute path — packaged apps / sudo secure_path may strip /usr/sbin from PATH
const LSOF_BIN = (() => {
  if (process.platform === "win32") return null;
  for (const p of ["/usr/sbin/lsof", "/usr/bin/lsof", "/sbin/lsof"]) {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      /* try next */
    }
  }
  return "lsof"; // last-resort fallback (depends on PATH)
})();

const TARGET_HOSTS = [
  "daily-cloudcode-pa.googleapis.com",
  "cloudcode-pa.googleapis.com",
  "api.individual.githubcopilot.com",
  "q.us-east-1.amazonaws.com",
  "api2.cursor.sh",
  "api2.qoder.sh",
  "api3.qoder.sh",
  "openapi.qoder.sh",
  "center.qoder.sh",
  "api.qoder.sh",
  "repo2.qoder.sh",
];

const QODER_DIRECT_IPS = ["47.57.243.249"];
const QODER_CONNECT_HOST = "api3.qoder.sh";

const URL_PATTERNS = {
  antigravity: [":generateContent", ":streamGenerateContent"],
  copilot: ["/chat/completions", "/v1/messages", "/responses"],
  kiro: ["/generateAssistantResponse"],
  cursor: ["/BidiAppend", "/RunSSE", "/RunPoll", "/Run"],
  qoder: ["/agent_chat_generation", "/service/pro/sse/agent_chat_generation"],
};

// Synonym map: rawModel from request → canonical alias key in mitmAlias DB
const MODEL_SYNONYMS = {
  antigravity: {
    "gemini-default": "gemini-3.5-flash-low",
    "gemini-3.5-flash-high": "gemini-3-flash-agent",
    "gemini-3.5-flash-medium": "gemini-3.5-flash-low",
    "gemini-3.5-flash-extra-low": "gemini-3.5-flash-extra-low",
    "gemini-3.8-flash": "gemini-3.8-flash-medium",
    "gemini-3.8-flash-high": "gemini-3.8-flash-high",
    "gemini-3.8-flash-medium": "gemini-3.8-flash-medium",
    "gemini-3.8-flash-low": "gemini-3.8-flash-low",
    "gemini-3.7-flash": "gemini-3.7-flash-high",
    "gemini-3.7-flash-high": "gemini-3.7-flash-high",
    "gemini-3.7-flash-medium": "gemini-3.7-flash-medium",
    "gemini-3.7-flash-low": "gemini-3.7-flash-low",
    "gemini-3.6-flash": "gemini-3.6-flash-high",
    "gemini-3.6-flash-high": "gemini-3.6-flash-high",
    "gemini-3.6-flash-medium": "gemini-3.6-flash-medium",
    "gemini-3.6-flash-low": "gemini-3.6-flash-low",
    "gemini-3.1-pro-high": "gemini-pro-agent",
    "gemini-3-pro-high": "gemini-pro-agent",
    "gemini-3-pro-low": "gemini-3.1-pro-low",
    "claude-sonnet-5-5-high": "claude-sonnet-5-5-high",
    "claude-sonnet-5-5-medium": "claude-sonnet-5-5-medium",
    "claude-sonnet-5-5-low": "claude-sonnet-5-5-low",
    "claude-sonnet-5-5": "claude-sonnet-5-5",
    "claude-sonnet-5.5": "claude-sonnet-5-5",
    "claude-sonnet-5.5-high": "claude-sonnet-5-5-high",
    "claude-sonnet-5.5-medium": "claude-sonnet-5-5-medium",
    "claude-sonnet-5.5-low": "claude-sonnet-5-5-low",
    "claude-sonnet-5-5-thinking": "claude-sonnet-5-5",
    "claude-sonnet-5.5-thinking": "claude-sonnet-5-5",
    "claude-opus-5-5-high": "claude-opus-5-5-high",
    "claude-opus-5-5-medium": "claude-opus-5-5-medium",
    "claude-opus-5-5-low": "claude-opus-5-5-low",
    "claude-opus-5-5": "claude-opus-5-5",
    "claude-opus-5.5": "claude-opus-5-5",
    "claude-opus-5.5-high": "claude-opus-5-5-high",
    "claude-opus-5.5-medium": "claude-opus-5-5-medium",
    "claude-opus-5.5-low": "claude-opus-5-5-low",
    "claude-opus-5-5-thinking": "claude-opus-5-5",
    "claude-opus-5.5-thinking": "claude-opus-5-5",
    "claude-sonnet-4.6": "claude-sonnet-4-6",
    "claude-opus-4.6": "claude-opus-4-6-thinking",
    "claude-opus-4.6-thinking": "claude-opus-4-6-thinking",
  },
  qoder: {
    "auto": "qmodel_latest",
  },
};

// Pattern fallback: rawModel regex → canonical alias key (when exact + prefix match fail)
// Order matters: more specific patterns first. Catches AG renamed variants (e.g. gemini-pro-agent)
const MODEL_PATTERNS = {
  antigravity: [
    {
      match: /flash.*low|low.*flash|flash.*medium|medium.*flash/i,
      alias: "gemini-3.5-flash-low",
    },
    {
      match: /flash.*agent|agent.*flash|flash/i,
      alias: "gemini-3-flash-agent",
    },
    { match: /pro.*low|low.*pro/i, alias: "gemini-3.1-pro-low" },
    { match: /gemini.*pro|pro.*gemini/i, alias: "gemini-pro-agent" },
    { match: /opus.*5[.-]5.*high|5[.-]5.*opus.*high/i, alias: "claude-opus-5-5-high" },
    { match: /opus.*5[.-]5.*medium|5[.-]5.*opus.*medium/i, alias: "claude-opus-5-5-medium" },
    { match: /opus.*5[.-]5.*low|5[.-]5.*opus.*low/i, alias: "claude-opus-5-5-low" },
    { match: /sonnet.*5[.-]5.*high|5[.-]5.*sonnet.*high/i, alias: "claude-sonnet-5-5-high" },
    { match: /sonnet.*5[.-]5.*medium|5[.-]5.*sonnet.*medium/i, alias: "claude-sonnet-5-5-medium" },
    { match: /sonnet.*5[.-]5.*low|5[.-]5.*sonnet.*low/i, alias: "claude-sonnet-5-5-low" },
    { match: /opus.*5[.-]5|5[.-]5.*opus/i, alias: "claude-opus-5-5" },
    { match: /sonnet.*5[.-]5|5[.-]5.*sonnet/i, alias: "claude-sonnet-5-5" },
    { match: /opus/i, alias: "claude-opus-4-6-thinking" },
    { match: /sonnet|claude/i, alias: "claude-sonnet-4-6" },
    { match: /gpt.*oss|oss/i, alias: "gpt-oss-120b-medium" },
  ],
  qoder: [
    { match: /qmodel_38max|qwen.*3\.8.*max/i, alias: "qmodel_38max" },
    { match: /qmodel_latest|qwen.*3\.7.*max/i, alias: "qmodel_latest" },
    { match: /qmodel(?!_)|qwen.*3\.7.*plus/i, alias: "qmodel" },
    { match: /kmodel_latest|kimi.*k3/i, alias: "kmodel_latest" },
    { match: /kmodel(?!_)|kimi.*k2\.7/i, alias: "kmodel" },
    { match: /gm51model|glm.*5\.2/i, alias: "gm51model" },
    { match: /gmodel|glm.*5\.3|glm/i, alias: "gmodel" },
    { match: /dfmodel|deepseek.*flash/i, alias: "dfmodel" },
    { match: /dmodel|deepseek.*pro|deepseek/i, alias: "dmodel" },
    { match: /cantus|cmodel/i, alias: "cmodel" },
    { match: /minimax|mmodel/i, alias: "mmodel" },
    { match: /ultimate/i, alias: "ultimate" },
    { match: /performance/i, alias: "performance" },
    { match: /efficient/i, alias: "efficient" },
    { match: /lite/i, alias: "lite" },
    { match: /qwen/i, alias: "qmodel_latest" },
  ],
};

// URL substrings whose request/response should NOT be dumped to file (telemetry, polling, empty)
const LOG_BLACKLIST_URL_PARTS = [
  "recordCodeAssistMetrics",
  "recordTrajectoryAnalytics",
  "fetchAdminControls",
  "listExperiments",
  "fetchUserInfo",
];

function getToolForHost(host) {
  const h = (host || "").split(":")[0];
  if (h === "api.individual.githubcopilot.com") return "copilot";
  if (
    h === "daily-cloudcode-pa.googleapis.com" ||
    h === "cloudcode-pa.googleapis.com"
  )
    return "antigravity";
  if (h === "q.us-east-1.amazonaws.com") return "kiro";
  if (h === "api2.cursor.sh") return "cursor";
  if (h.endsWith(".qoder.sh") || h.endsWith(".qoder.com")) return "qoder";
  return null;
}

function isQoderConnectTarget(hostname) {
  return QODER_DIRECT_IPS.includes(hostname);
}

function isQoderPromptCacheKeyEnabled(mappedModel) {
  const configuredModels = String(
    process.env.MITM_QODER_PROMPT_CACHE_MODELS || "",
  )
    .replace(/#.*$/, "")
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean);
  return configuredModels.includes("*") || configuredModels.includes(mappedModel);
}

// Patterns for models that must NOT be re-routed — pass through natively
// (e.g. tab-autocomplete: latency-critical inline completion)
const MODEL_NO_MAP = {
  antigravity: [/^tab_jump_flash_lite_preview$/i, /^tab_flash_lite_preview$/i],
};

function isBinaryData(buffer) {
  if (!buffer || buffer.length === 0) return false;
  const sample = buffer.slice(0, Math.min(100, buffer.length));
  let nonPrintable = 0;
  for (let i = 0; i < sample.length; i++) {
    const byte = sample[i];
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0A && byte !== 0x0D) {
      nonPrintable++;
    }
    if (byte > 0x7E) nonPrintable++;
  }
  return nonPrintable / sample.length > 0.3;
}

// Extract model from URL path (Gemini), body (OpenAI/Anthropic/Qoder), or Kiro conversationState.
function extractModel(url, body) {
  const urlMatch = url.match(/\/models\/([^/:]+)/);
  const urlModel = urlMatch?.[1] || null;

  if (isBinaryData(body)) return urlModel;

  const rawStr = body.toString("utf8");
  let parsed = null;
  try {
    parsed = JSON.parse(rawStr);
  } catch {
    try {
      const { qoderDecodeBody } = require("../lib/qoder/encoding.js");
      const decoded = qoderDecodeBody(rawStr);
      if (decoded) parsed = JSON.parse(decoded);
    } catch {
      /* ignore */
    }
  }

  if (!parsed) return urlModel;

  if (parsed.conversationState) {
    return (
      parsed.conversationState.currentMessage?.userInputMessage?.modelId || null
    );
  }
  if (parsed.chat_context?.modelConfig?.model) {
    return parsed.chat_context.modelConfig.model;
  }
  const model = urlModel || parsed.model || null;
  const cleanModelName = String(model).replace(/^models\//, "");
  if (
    cleanModelName === "gemini-3.6-flash-tiered" ||
    cleanModelName === "gemini-3.7-flash-tiered" ||
    cleanModelName === "gemini-3.8-flash-tiered"
  ) {
    const ver = cleanModelName.includes("3.8")
      ? "3.8"
      : cleanModelName.includes("3.7")
        ? "3.7"
        : "3.6";
    const rawLevel =
      parsed.request?.generationConfig?.thinkingConfig?.thinkingLevel ||
      parsed.generationConfig?.thinkingConfig?.thinkingLevel;
    const level = ["high", "medium", "low"].includes(
      String(rawLevel).toLowerCase(),
    )
      ? String(rawLevel).toLowerCase()
      : "medium";
    return `gemini-${ver}-flash-${level}`;
  }
  return model;
}

module.exports = {
  IS_DEV,
  LSOF_BIN,
  TARGET_HOSTS,
  QODER_DIRECT_IPS,
  QODER_CONNECT_HOST,
  URL_PATTERNS,
  MODEL_SYNONYMS,
  MODEL_PATTERNS,
  MODEL_NO_MAP,
  LOG_BLACKLIST_URL_PARTS,
  getToolForHost,
  isQoderConnectTarget,
  isQoderPromptCacheKeyEnabled,
  extractModel,
};
