/**
 * Free-tier providers (may require account/API key but offer free access).
 * @module providers/free-tier-providers
 */

// Free Tier Providers (has free access but may require account/API key)
export const FREE_TIER_PROVIDERS = {
  nous: {
    id: "nous",
    alias: "nous",
    aliases: ["nous-portal", "nous-research", "ns"],
    uiAlias: "nous",
    name: "Nous Research",
    icon: "psychology",
    color: "#7C3AED",
    textIcon: "NR",
    website: "https://nousresearch.com",
    notice: {
      text: "Connect with OAuth Device Code (free account, no payment required) or a Nous Portal API key.",
      signupUrl: "https://portal.nousresearch.com",
      apiKeyUrl: "https://portal.nousresearch.com/api-keys",
    },
    category: "freeTier",
    authType: "oauth",
    authModes: ["oauth", "apikey"],
    hasOAuth: true,
    hasFree: true,
    modelsFetcher: {
      url: "https://inference-api.nousresearch.com/v1/models",
      type: "nous-free",
    },
    passthroughModels: true,
    serviceKinds: ["llm"],
  },
  openrouter: {
    id: "openrouter",
    alias: "openrouter",
    name: "OpenRouter",
    icon: "router",
    color: "#F97316",
    textIcon: "OR",
    website: "https://openrouter.ai",
    notice: {
      text: "Free tier: 27+ free models, no credit card needed, 200 req/day. After $10 credit: 1,000 req/day.",
      apiKeyUrl: "https://openrouter.ai/settings/keys",
    },
    modelsFetcher: {
      url: "https://openrouter.ai/api/v1/models",
      type: "openrouter-free",
    },
    passthroughModels: true,
    serviceKinds: ["llm", "embedding", "tts", "imageToText"],
    embeddingConfig: {
      baseUrl: "https://openrouter.ai/api/v1/embeddings",
      authType: "apikey",
      authHeader: "bearer",
      models: [
        {
          id: "openai/text-embedding-3-small",
          name: "Text Embedding 3 Small (OpenRouter)",
          dimensions: 1536,
        },
        {
          id: "openai/text-embedding-3-large",
          name: "Text Embedding 3 Large (OpenRouter)",
          dimensions: 3072,
        },
        {
          id: "openai/text-embedding-ada-002",
          name: "Text Embedding Ada 002 (OpenRouter)",
          dimensions: 1536,
        },
      ],
    },
  },
  nvidia: {
    id: "nvidia",
    alias: "nvidia",
    name: "NVIDIA NIM",
    icon: "developer_board",
    color: "#76B900",
    textIcon: "NV",
    website: "https://developer.nvidia.com/nim",
    notice: {
      text: "Free access for NVIDIA Developer Program members (prototyping & testing).",
      apiKeyUrl: "https://build.nvidia.com/settings/api-keys",
    },
    serviceKinds: ["llm", "tts", "embedding"],
    ttsConfig: {
      baseUrl: "https://integrate.api.nvidia.com/v1/audio/speech",
      authType: "apikey",
      authHeader: "bearer",
      format: "nvidia-tts",
      models: [
        { id: "fastpitch", name: "FastPitch" },
        { id: "tacotron2", name: "Tacotron2" },
      ],
    },
    embeddingConfig: {
      baseUrl: "https://integrate.api.nvidia.com/v1/embeddings",
      authType: "apikey",
      authHeader: "bearer",
      models: [
        {
          id: "nvidia/nv-embedqa-e5-v5",
          name: "NV EmbedQA E5 v5",
          dimensions: 1024,
        },
      ],
    },
  },
  ollama: {
    id: "ollama",
    alias: "ollama",
    name: "Ollama Cloud",
    icon: "cloud",
    color: "#ffffffff",
    textIcon: "OL",
    website: "https://ollama.com",
    notice: {
      text: "Free tier: light usage, 1 cloud model at a time (limits reset every 5h & 7d). Pro $20/mo · Max $100/mo.",
      apiKeyUrl: "https://ollama.com/settings/keys",
    },
    serviceKinds: ["llm", "webFetch"],
    fetchConfig: {
      baseUrl: "https://ollama.com/api/web_fetch",
      method: "POST",
      authType: "apikey",
      authHeader: "bearer",
      formats: ["markdown"],
      maxCharacters: 200000,
      timeoutMs: 30000,
    },
  },
  vertex: {
    id: "vertex",
    alias: "vx",
    name: "Vertex AI",
    icon: "cloud",
    color: "#4285F4",
    textIcon: "VX",
    website: "https://cloud.google.com/vertex-ai",
    notice: {
      text: "New Google Cloud accounts get $300 free credits. Requires GCP project + Service Account with Vertex AI API enabled.",
      apiKeyUrl: "https://console.cloud.google.com/iam-admin/serviceaccounts",
    },
  },
  gemini: {
    id: "gemini",
    alias: "gemini",
    name: "Gemini",
    icon: "diamond",
    color: "#4285F4",
    textIcon: "GE",
    mediaPriority: 1,
    website: "https://ai.google.dev",
    notice: { apiKeyUrl: "https://aistudio.google.com/app/apikey" },
    serviceKinds: [
      "llm",
      "embedding",
      "image",
      "imageToText",
      "webSearch",
      "tts",
      "stt",
    ],
    sttConfig: {
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/models",
      authType: "apikey",
      authHeader: "key",
      format: "gemini-stt",
      models: [
        { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro (Best)" },
        { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
        {
          id: "gemini-2.5-flash-lite",
          name: "Gemini 2.5 Flash Lite (Cheapest)",
        },
        { id: "gemini-2.0-flash", name: "Gemini 2.0 Flash" },
      ],
    },
    searchViaChat: {
      defaultModel: "gemini-2.5-flash",
      pricingUrl: "https://ai.google.dev/pricing",
      freeTier:
        "Free tier: 15 RPM, 1M tokens/day on gemini-2.5-flash via AI Studio.",
    },
    embeddingConfig: {
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/models",
      authType: "apikey",
      authHeader: "key",
      models: [
        {
          id: "text-embedding-004",
          name: "Text Embedding 004",
          dimensions: 768,
        },
        { id: "embedding-001", name: "Embedding 001", dimensions: 768 },
      ],
    },
    ttsConfig: {
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/models",
      authType: "apikey",
      authHeader: "key",
      format: "gemini-tts",
      models: [
        { id: "gemini-2.5-flash-preview-tts", name: "Gemini 2.5 Flash TTS" },
        { id: "gemini-2.5-pro-preview-tts", name: "Gemini 2.5 Pro TTS" },
      ],
    },
  },
  "cloudflare-ai": {
    id: "cloudflare-ai",
    alias: "cf",
    name: "Cloudflare",
    icon: "cloud",
    color: "#F38020",
    textIcon: "CF",
    website: "https://developers.cloudflare.com/workers-ai/",
    notice: {
      text: "Workers AI free tier. Requires a Cloudflare API token and Account ID.",
      apiKeyUrl: "https://dash.cloudflare.com/profile/api-tokens",
    },
    serviceKinds: ["llm", "image"],
    authType: "apikey",
    authModes: ["apikey"],
    hasProviderSpecificData: true,
  },
  byteplus: {
    id: "byteplus",
    alias: "bpm",
    name: "BytePlus ModelArk",
    icon: "cloud",
    color: "#2563EB",
    textIcon: "BP",
    website: "https://console.byteplus.com/ark",
    notice: {
      text: "Free credits for new accounts. Access to Seed 2.0, Kimi K2 Thinking, GLM 4.7, GPT-OSS-120B models.",
      apiKeyUrl:
        "https://console.byteplus.com/ark/region:ark+ap-southeast-1/apiKey",
    },
    serviceKinds: ["llm"],
  },
};
