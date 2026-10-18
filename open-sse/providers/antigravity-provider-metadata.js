export const ANTIGRAVITY_BASE_URLS = [
  "https://daily-cloudcode-pa.sandbox.googleapis.com",
  "https://daily-cloudcode-pa.googleapis.com",
  "https://cloudcode-pa.googleapis.com",
];

export const ANTIGRAVITY_OPERATIONS = {
  fetchAvailableModels: "/v1internal:fetchAvailableModels",
  retrieveUserQuotaSummary: "/v1internal:retrieveUserQuotaSummary",
  loadCodeAssist: "/v1internal:loadCodeAssist",
};

const ANTIGRAVITY_DISCOVERY_BASE_URL = "https://cloudcode-pa.googleapis.com";

export const ANTIGRAVITY_USAGE_ENDPOINTS = {
  quotaApiUrl: `${ANTIGRAVITY_DISCOVERY_BASE_URL}${ANTIGRAVITY_OPERATIONS.fetchAvailableModels}`,
  quotaSummaryApiUrl: `${ANTIGRAVITY_DISCOVERY_BASE_URL}${ANTIGRAVITY_OPERATIONS.retrieveUserQuotaSummary}`,
  loadProjectApiUrl: `${ANTIGRAVITY_DISCOVERY_BASE_URL}${ANTIGRAVITY_OPERATIONS.loadCodeAssist}`,
};

export const ANTIGRAVITY_USAGE_ENDPOINT_SETS = {
  quota: ANTIGRAVITY_BASE_URLS.map(
    (baseUrl) => `${baseUrl}${ANTIGRAVITY_OPERATIONS.fetchAvailableModels}`,
  ),
  quotaSummary: ANTIGRAVITY_BASE_URLS.map(
    (baseUrl) => `${baseUrl}${ANTIGRAVITY_OPERATIONS.retrieveUserQuotaSummary}`,
  ),
  loadProject: ANTIGRAVITY_BASE_URLS.map(
    (baseUrl) => `${baseUrl}${ANTIGRAVITY_OPERATIONS.loadCodeAssist}`,
  ),
};

export const ANTIGRAVITY_MODEL_ALIASES = {
  "gemini-3.8-flash": "gemini-3.8-flash-tiered",
  "gemini-3.8-flash-high": "gemini-3.8-flash-tiered",
  "gemini-3.8-flash-medium": "gemini-3.8-flash-tiered",
  "gemini-3.8-flash-low": "gemini-3.8-flash-tiered",
  "gemini-3.7-flash": "gemini-3.7-flash-high",
  "gemini-3.7-flash-thinking": "gemini-3.7-flash-high",
  "gemini-3.6-flash": "gemini-3.6-flash-high",
  "gemini-3.6-flash-agent": "gemini-3-flash-agent",
  "gemini-3.6-flash-extra-low": "gemini-3.5-flash-extra-low",
  "claude-3-7-sonnet": "claude-sonnet-4-6",
  "claude-3.7-sonnet": "claude-sonnet-4-6",
  "claude-3-5-sonnet": "claude-sonnet-4-6",
  "claude-3.5-sonnet": "claude-sonnet-4-6",
  "claude-3-5-haiku": "claude-sonnet-4-6",
  "claude-3.5-haiku": "claude-sonnet-4-6",
  "claude-3-7-opus": "claude-opus-4-6-thinking",
  "claude-3.7-opus": "claude-opus-4-6-thinking",
  "claude-opus-4": "claude-opus-4-6-thinking",
};

export const ANTIGRAVITY_STATIC_MODELS = [
  {
    id: "gemini-4-argon-high",
    name: "Gemini 4 Argon (High)",
    upstreamModelId: "gemini-4-argon-high(high)",
  },
  {
    id: "gemini-3.8-flash-high",
    name: "Gemini 3.8 Flash (High)",
    upstreamModelId: "gemini-3.8-flash-tiered(high)",
  },
  {
    id: "gemini-3.8-flash-medium",
    name: "Gemini 3.8 Flash (Medium)",
    upstreamModelId: "gemini-3.8-flash-tiered(medium)",
  },
  {
    id: "gemini-3.8-flash-low",
    name: "Gemini 3.8 Flash (Low)",
    upstreamModelId: "gemini-3.8-flash-tiered(low)",
  },
  {
    id: "gemini-3.7-flash",
    name: "Gemini 3.7 Flash",
    upstreamModelId: "gemini-3.7-flash-high",
  },
  {
    id: "gemini-3.7-flash-high",
    name: "Gemini 3.7 Flash (High)",
    upstreamModelId: "gemini-3.7-flash-high",
  },
  {
    id: "gemini-3.7-flash-medium",
    name: "Gemini 3.7 Flash (Medium)",
    upstreamModelId: "gemini-3.7-flash-medium",
  },
  {
    id: "gemini-3.7-flash-low",
    name: "Gemini 3.7 Flash (Low)",
    upstreamModelId: "gemini-3.7-flash-low",
  },
  {
    id: "gemini-3.6-flash-high",
    name: "Gemini 3.6 Flash (High)",
    upstreamModelId: "gemini-3.6-flash-high",
  },
  {
    id: "gemini-3.6-flash-medium",
    name: "Gemini 3.6 Flash (Medium)",
    upstreamModelId: "gemini-3.6-flash-medium",
  },
  {
    id: "gemini-3.6-flash-low",
    name: "Gemini 3.6 Flash (Low)",
    upstreamModelId: "gemini-3.6-flash-low",
  },
  { id: "gemini-3.6-flash-agent", name: "Gemini 3.6 Flash (High)" },
  {
    id: "gemini-3.6-flash-extra-low",
    name: "Gemini 3.6 Flash (Low)",
  },
  { id: "gemini-3-flash-agent", name: "Gemini 3.5 Flash (High)" },
  { id: "gemini-3.5-flash-low", name: "Gemini 3.5 Flash (Medium)" },
  {
    id: "gemini-3.5-flash-extra-low",
    name: "Gemini 3.5 Flash (Low)",
  },
  { id: "gemini-pro-agent", name: "Gemini 3.1 Pro (High)" },
  { id: "gemini-3.1-pro-low", name: "Gemini 3.1 Pro (Low)" },
  { id: "claude-sonnet-5-5-high", name: "Claude Sonnet 5.5 (High)", upstreamModelId: "claude-sonnet-5-5-high(high)" },
  { id: "claude-sonnet-5-5-medium", name: "Claude Sonnet 5.5 (Medium)", upstreamModelId: "claude-sonnet-5-5-medium(medium)" },
  { id: "claude-sonnet-5-5-low", name: "Claude Sonnet 5.5 (Low)", upstreamModelId: "claude-sonnet-5-5-low(low)" },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5 (Thinking)", upstreamModelId: "claude-sonnet-5-5-high(high)" },
  { id: "claude-opus-5-5-high", name: "Claude Opus 5.5 (High)", upstreamModelId: "claude-opus-5-5-high(high)" },
  { id: "claude-opus-5-5-medium", name: "Claude Opus 5.5 (Medium)", upstreamModelId: "claude-opus-5-5-medium(medium)" },
  { id: "claude-opus-5-5-low", name: "Claude Opus 5.5 (Low)", upstreamModelId: "claude-opus-5-5-low(low)" },
  { id: "claude-opus-5-5", name: "Claude Opus 5.5 (Thinking)", upstreamModelId: "claude-opus-5-5-high(high)" },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (Thinking)" },
  {
    id: "claude-opus-4-6-thinking",
    name: "Claude Opus 4.6 (Thinking)",
  },
  { id: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
  { id: "gemini-3-flash", name: "Gemini 3 Flash", thinking: false },
  {
    id: "gemini-3.1-flash-image",
    name: "Gemini 3.1 Flash (Image)",
    kind: "image",
    type: "image",
    imageGen: true,
    capabilities: ["textToImage"],
  },
];

export const ANTIGRAVITY_USAGE_MODEL_IDS = new Set(
  ANTIGRAVITY_STATIC_MODELS.map(({ id }) => id),
);

export const ANTIGRAVITY_DYNAMIC_MODEL_SKIP_IDS = new Set([
  "chat_20706",
  "chat_23310",
  "tab_flash_lite_preview",
  "tab_jump_flash_lite_preview",
  "gemini-2.5-flash-thinking",
  "gemini-2.5-pro",
]);
