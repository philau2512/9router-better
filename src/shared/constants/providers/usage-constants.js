/**
 * Usage/quota supported provider lists.
 * @module providers/usage-constants
 */

// Providers that support usage/quota API
export const USAGE_SUPPORTED_PROVIDERS = [
  "claude",
  "antigravity",
  "kiro",
  "github",
  "codex",
  "kimi",
  "kimi-coding",
  "deepseek",
  "ollama",
  "gemini-cli",
  "glm",
  "glm-cn",
  "minimax",
  "minimax-cn",
  "qoder",
  "vercel-ai-gateway",
  "grok-cli",
  "xai", // Grok Build OAuth connections are stored under provider "xai"
  "opencode-go",
  "groq",
  "zed",
  "commandcode",
];

// Subset that uses apikey auth (still surfaced on quota page).
// kiro headless keys use authType "api_key" (underscore) — still listed here so
// /api/providers/client and /api/usage accept them for Quota Tracker.
export const USAGE_APIKEY_PROVIDERS = [
  "ollama",
  "glm",
  "glm-cn",
  "minimax",
  "minimax-cn",
  "vercel-ai-gateway",
  "kiro",
  "kimi",
  "deepseek",
  "opencode-go",
  "groq",
  "commandcode",
];
