/**
 * OAuth Configuration Constants
 */
import { platform, arch } from "os";

/**
 * Get the platform enum value based on the current OS.
 * Matches Antigravity binary's ClientMetadata.Platform enum.
 */
function getOAuthPlatformEnum() {
  const os = platform();
  const architecture = arch();
  if (os === "darwin") return architecture === "arm64" ? 2 : 1;
  if (os === "linux") return architecture === "arm64" ? 4 : 3;
  if (os === "win32") return 5;
  return 0;
}

// Claude OAuth Configuration (Authorization Code Flow with PKCE)
export const CLAUDE_CONFIG = {
  clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  authorizeUrl: "https://claude.ai/oauth/authorize",
  tokenUrl: "https://api.anthropic.com/v1/oauth/token",
  scopes: ["org:create_api_key", "user:profile", "user:inference"],
  codeChallengeMethod: "S256",
};

// Codex (OpenAI) OAuth Configuration (Authorization Code Flow with PKCE)
export const CODEX_CONFIG = {
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  authorizeUrl: "https://auth.openai.com/oauth/authorize",
  tokenUrl: "https://auth.openai.com/oauth/token",
  scope: "openid profile email offline_access",
  codeChallengeMethod: "S256",
  // Additional OpenAI-specific params
  extraParams: {
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    originator: "codex_cli_rs",
  },
};

// Gemini (Google) OAuth Configuration (Standard OAuth2)
export const GEMINI_CONFIG = {
  clientId:
    "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com",
  clientSecret: "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",
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  userInfoUrl: "https://www.googleapis.com/oauth2/v1/userinfo",
  scopes: [
    "https://www.googleapis.com/auth/cloud-platform",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
  ],
};

// Qwen OAuth Configuration (Device Code Flow with PKCE)
export const QWEN_CONFIG = {
  clientId: "f0304373b74a44d2b584a3fb70ca9e56",
  deviceCodeUrl: "https://chat.qwen.ai/api/v1/oauth2/device/code",
  tokenUrl: "https://chat.qwen.ai/api/v1/oauth2/token",
  scope: "openid profile email model.completion",
  codeChallengeMethod: "S256",
};

// Qoder OAuth Configuration (Device Token Flow)
export const QODER_CONFIG = {
  apiBaseUrl: "https://api2.qoder.sh",
  deviceTokenUrl: "https://api2.qoder.sh/api/v1/deviceToken/poll",
  deviceRefreshUrl: "https://api2.qoder.sh/api/v1/deviceToken/refresh",
  refreshUrl: "https://api2.qoder.sh/api/v3/user/refresh_token",
  userInfoUrl: "https://api2.qoder.sh/api/v1/userinfo",
  statusUrl: "https://api2.qoder.sh/api/v3/user/status",
  loginUrl: "https://qoder.com/login",
};

// iFlow OAuth Configuration (Authorization Code)
export const IFLOW_CONFIG = {
  clientId: "10009311001",
  clientSecret: "4Z3YjXycVsQvyGF1etiNlIBB4RsqSDtW",
  authorizeUrl: "https://iflow.cn/oauth",
  tokenUrl: "https://iflow.cn/oauth/token",
  userInfoUrl: "https://iflow.cn/api/oauth/getUserInfo",
  extraParams: {
    loginMethod: "phone",
    type: "phone",
  },
};

// Antigravity OAuth Configuration (Standard OAuth2 with Google)
export const ANTIGRAVITY_CONFIG = {
  clientId:
    "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
  clientSecret: "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",
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  userInfoUrl: "https://www.googleapis.com/oauth2/v1/userinfo",
  scopes: [
    "https://www.googleapis.com/auth/cloud-platform",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/cclog",
    "https://www.googleapis.com/auth/experimentsandconfigs",
  ],
  // Antigravity specific
  apiEndpoint: "https://cloudcode-pa.googleapis.com",
  apiVersion: "v1internal",
  loadCodeAssistEndpoint:
    "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
  onboardUserEndpoint:
    "https://cloudcode-pa.googleapis.com/v1internal:onboardUser",
  loadCodeAssistUserAgent: "google-api-nodejs-client/9.15.1",
  loadCodeAssistApiClient: "google-cloud-sdk vscode_cloudshelleditor/0.1",
  // Numeric enums matching Antigravity binary ClientMetadata (see getOAuthClientMetadata below)
  loadCodeAssistClientMetadata: JSON.stringify({
    ideType: 9,
    platform: getOAuthPlatformEnum(),
    pluginType: 2,
  }),
};

/**
 * Get client metadata using numeric enum values for API calls.
 * @returns {{ ideType: number, platform: number, pluginType: number }}
 */
export function getOAuthClientMetadata() {
  return { ideType: 9, platform: getOAuthPlatformEnum(), pluginType: 2 };
}

// OpenAI OAuth Configuration (Authorization Code Flow with PKCE)
export const OPENAI_CONFIG = {
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  authorizeUrl: "https://auth.openai.com/oauth/authorize",
  tokenUrl: "https://auth.openai.com/oauth/token",
  scope: "openid profile email offline_access",
  codeChallengeMethod: "S256",
  extraParams: {
    id_token_add_organizations: "true",
    originator: "openai_native",
  },
};

// GitHub Copilot OAuth Configuration (Device Code Flow)
export const GITHUB_CONFIG = {
  clientId: "Iv1.b507a08c87ecfe98",
  deviceCodeUrl: "https://github.com/login/device/code",
  tokenUrl: "https://github.com/login/oauth/access_token",
  userInfoUrl: "https://api.github.com/user",
  scopes: "read:user",
  apiVersion: "2022-11-28", // Updated to supported version
  copilotTokenUrl: "https://api.github.com/copilot_internal/v2/token",
  userAgent: "GitHubCopilotChat/0.26.7",
  editorVersion: "vscode/1.85.0",
  editorPluginVersion: "copilot-chat/0.26.7",
};

// Kiro OAuth Configuration
// Supports multiple auth methods:
// 1. AWS Builder ID (Device Code Flow)
// 2. AWS IAM Identity Center/IDC (Device Code Flow with custom startUrl/region)
// 3. Google/GitHub Social Login (Authorization Code Flow - manual callback)
// 4. Import Token (paste refresh token from Kiro IDE)
export const KIRO_CONFIG = {
  // AWS SSO OIDC endpoints for Builder ID/IDC (Device Code Flow)
  ssoOidcEndpoint: "https://oidc.us-east-1.amazonaws.com",
  registerClientUrl: "https://oidc.us-east-1.amazonaws.com/client/register",
  deviceAuthUrl: "https://oidc.us-east-1.amazonaws.com/device_authorization",
  tokenUrl: "https://oidc.us-east-1.amazonaws.com/token",
  // AWS Builder ID default start URL
  startUrl: "https://view.awsapps.com/start",
  // Client registration params
  clientName: "kiro-oauth-client",
  clientType: "public",
  scopes: [
    "codewhisperer:completions",
    "codewhisperer:analysis",
    "codewhisperer:conversations",
  ],
  grantTypes: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
  issuerUrl: "https://identitycenter.amazonaws.com/ssoins-722374e8c3c8e6c6",
  // Social auth endpoints (Google/GitHub via AWS Cognito)
  socialAuthEndpoint: "https://prod.us-east-1.auth.desktop.kiro.dev",
  socialLoginUrl: "https://prod.us-east-1.auth.desktop.kiro.dev/login",
  socialTokenUrl: "https://prod.us-east-1.auth.desktop.kiro.dev/oauth/token",
  socialRefreshUrl: "https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken",
  // Auth methods
  authMethods: ["builder-id", "idc", "google", "github", "import"],
};

// AWS region allowlist pattern — prevents SSRF via region injection into upstream URLs (GHSA-6mwv-4mrm-5p3m)
export const AWS_REGION_PATTERN = /^[a-z]{2}-[a-z]+-\d{1,2}$/;

// Reject any region that is not a valid AWS region before interpolating it into a URL
export function assertValidAwsRegion(region) {
  if (typeof region !== "string" || !AWS_REGION_PATTERN.test(region)) {
    throw new Error("Invalid region");
  }
  return region;
}

// Cursor OAuth Configuration (Import Token from Cursor IDE)
// Cursor stores credentials in SQLite database: state.vscdb
// Keys: cursorAuth/accessToken, storage.serviceMachineId
export const CURSOR_CONFIG = {
  // API endpoints
  apiEndpoint: "https://api2.cursor.sh",
  chatEndpoint: "/aiserver.v1.ChatService/StreamUnifiedChatWithTools",
  modelsEndpoint: "/aiserver.v1.AiService/GetDefaultModelNudgeData",
  // Additional endpoints
  api3Endpoint: "https://api3.cursor.sh", // Telemetry
  agentEndpoint: "https://agent.api5.cursor.sh", // Privacy mode
  agentNonPrivacyEndpoint: "https://agentn.api5.cursor.sh", // Non-privacy mode
  // Client metadata
  clientVersion: "3.1.0",
  clientType: "ide",
  // Token storage locations (for user reference)
  tokenStoragePaths: {
    linux: "~/.config/Cursor/User/globalStorage/state.vscdb",
    macos:
      "/Users/<user>/Library/Application Support/Cursor/User/globalStorage/state.vscdb",
    windows: "%APPDATA%\\Cursor\\User\\globalStorage\\state.vscdb",
  },
  // Database keys
  dbKeys: {
    accessToken: "cursorAuth/accessToken",
    machineId: "storage.serviceMachineId",
  },
};

// Kimi Code OAuth is now canonicalized as `kimi`; retain the old export for callers
// that still import the historical name.
export const KIMI_CONFIG = {
  clientId:
    process.env.KIMI_CODING_OAUTH_CLIENT_ID ||
    process.env.KIMI_OAUTH_CLIENT_ID ||
    "17e5f671-d194-4dfb-9706-5516cb48c098",
  deviceCodeUrl: "https://auth.kimi.com/api/oauth/device_authorization",
  tokenUrl: "https://auth.kimi.com/api/oauth/token",
};
// Back-compat alias for any remaining KIMI_CODING_CONFIG imports
export const KIMI_CODING_CONFIG = KIMI_CONFIG;

// KiloCode OAuth Configuration (Custom Device Auth Flow)
export const KILOCODE_CONFIG = {
  apiBaseUrl: "https://api.kilo.ai",
  initiateUrl: "https://api.kilo.ai/api/device-auth/codes",
  pollUrlBase: "https://api.kilo.ai/api/device-auth/codes",
};

// Cline OAuth Configuration (Local Callback Flow via app.cline.bot)
export const CLINE_CONFIG = {
  appBaseUrl: "https://app.cline.bot",
  apiBaseUrl: "https://api.cline.bot",
  authorizeUrl: "https://api.cline.bot/api/v1/auth/authorize",
  tokenExchangeUrl: "https://api.cline.bot/api/v1/auth/token",
  refreshUrl: "https://api.cline.bot/api/v1/auth/refresh",
};

// ClinePass OAuth Configuration (shares Cline's OAuth endpoints)
export const CLINEPASS_CONFIG = { ...CLINE_CONFIG };

// GitLab Duo OAuth Configuration (Authorization Code Flow with PKCE)
// Supports both OAuth (PKCE) and Personal Access Token (PAT) modes
export const GITLAB_CONFIG = {
  defaultBaseUrl: "https://gitlab.com",
  authorizeUrlPath: "/oauth/authorize",
  tokenUrlPath: "/oauth/token",
  userInfoUrlPath: "/api/v4/user",
  scope: "api read_user",
  codeChallengeMethod: "S256",
};

// CodeBuddy (Tencent) OAuth Configuration (Browser OAuth Polling Flow)
// Step 1: POST /v2/plugin/auth/state?platform=CLI → get { state, authUrl }
// Step 2: Open authUrl in browser
// Step 3: Poll POST /v2/plugin/auth/token with state until success
export const CODEBUDDY_CONFIG = {
  baseUrl: "https://copilot.tencent.com",
  stateUrl: "https://copilot.tencent.com/v2/plugin/auth/state",
  tokenUrl: "https://copilot.tencent.com/v2/plugin/auth/token",
  refreshUrl: "https://copilot.tencent.com/v2/plugin/auth/token/refresh",
  userAgent: "CLI/2.63.2 CodeBuddy/2.63.2",
  platform: "CLI",
  pollInterval: 5000,
};

export const KIMCHI_CONFIG = {
  webAppUrl: "https://app.kimchi.dev",
  validationUrl: "https://api.cast.ai/v1/llm/openai/supported-providers",
  meUrl: "https://app.kimchi.dev/api/v1/me",
  callbackPath: "/oauth/callback",
  callbackTimeoutMs: 5 * 60 * 1000,
};

// CodeBuddy International OAuth configuration.
export const CODEBUDDY_INTL_CONFIG = {
  baseUrl: "https://www.codebuddy.ai",
  refreshUrl: "https://www.codebuddy.ai/v2/plugin/auth/token/refresh",
};

// Trae (ByteDance marscode) OAuth — authorization_code flow with local callback.
//   1) POST GetLoginGuidance {loginTraceID} → {Result.LoginHost}
//   2) Browser opens ${loginHost}/authorization?client_id=...&login_trace_id=...&auth_callback_url=${cb}
//   3) Redirect → ${cb}?refreshToken=...&loginHost=...&isRedirect=true
//   4) POST ExchangeToken {ClientID, RefreshToken, ClientSecret:"-"} → {Result.AccessToken, ExpiresAt}
//   5) POST GetUserInfo (x-cloudide-token) → email/name
// Xiaomi MiMo Desktop OAuth — custom ECDH encrypted-callback flow (NOT standard OAuth2).
//   1) Client generates X25519 keypair
//   2) Browser opens ${platformUrl}/authorize?pk=<pubkey>&redirect_uri=http://localhost:<port>/&kn=mimocode&key_name=...
//   3) Redirect → http://localhost:<port>/?u=<base64 encrypted payload>
//   4) Decrypt: ECDH(shared) → SHA256 → AES-256-GCM
//      Layout: [12-byte nonce][32-byte ephemeral pubkey][ciphertext][16-byte GCM tag]
//   5) Result JSON: { uid, sk, url }
export const XIAOMI_MIMO_CONFIG = {
  platformUrl: process.env.MIMO_PLATFORM_URL || "https://platform.xiaomimimo.com",
  defaultBaseUrl: "https://api.xiaomimimo.com/v1",
  kn: "mimocode",
  callbackPath: "/",
  timeoutMs: 300000, // 5 minutes
};

export const TRAE_CONFIG = {
  clientId: "ono9krqynydwx5",
  clientSecret: "-",
  loginGuidanceUrls: [
    "https://api.marscode.com/cloudide/api/v3/trae/GetLoginGuidance",
    "https://api.trae.ai/cloudide/api/v3/trae/GetLoginGuidance",
    "https://www.trae.ai/cloudide/api/v3/trae/GetLoginGuidance",
  ],
  apiOrigins: [
    "https://api.marscode.com",
    "https://api.trae.ai",
    "https://www.trae.ai",
    "https://www.marscode.com",
  ],
  exchangeTokenPath: "/cloudide/api/v3/trae/oauth/ExchangeToken",
  getUserInfoPath: "/cloudide/api/v3/trae/GetUserInfo",
  authorizationPath: "/authorization",
  callbackPath: "/callback",
  minAppVersion: "3.5.54",
  defaultAppVersion: "3.5.54",
  defaultAppType: "stable",
  defaultPluginVersion: "local",
  // service machine id is derived at runtime; device_id "0" is the stable default
  defaultDeviceId: "0",
  userAgent: "Trae/1.0.0 antigravity-cockpit-tools",
  webUrl: "https://www.trae.ai",
  authScheme: "Cloud-IDE-JWT",
  tokenLifetimeDays: 14,
  oauthTimeoutMs: 600_000,
};

// Windsurf / Devin CLI OAuth — authorization_code (implicit) flow with local callback.
//   1) Browser opens windsurf.com/windsurf/signin?response_type=token&client_id=...&redirect_uri=${cb}
//   2) Redirect → ${cb}?access_token=${firebaseJWT}&state=...
//   3) POST RegisterUser {firebase_id_token} → {apiKey, apiServerUrl, name}
//   4) POST GetOneTimeAuthToken → GetCurrentUser (best-effort email/plan)
export const WINDSURF_CONFIG = {
  clientId: "3GUryQ7ldAeKEuD2obYnppsnmj58eP5u",
  authBaseUrl: "https://www.windsurf.com",
  signInPath: "/windsurf/signin",
  registerApiBaseUrl: "https://register.windsurf.com",
  registerPath: "/exa.seat_management_pb.SeatManagementService/RegisterUser",
  oneTimeAuthPath: "/exa.seat_management_pb.SeatManagementService/GetOneTimeAuthToken",
  currentUserPath: "/exa.seat_management_pb.SeatManagementService/GetCurrentUser",
  planStatusPath: "/exa.seat_management_pb.SeatManagementService/GetPlanStatus",
  userStatusPath: "/exa.seat_management_pb.SeatManagementService/GetUserStatus",
  defaultApiServerUrl: "https://server.codeium.com",
  firebaseApiKey: "AIzaSyDsOl-1XpT5err0Tcn0TFFod1H8gVGIycY",
  callbackPath: "/windsurf-auth-callback",
  userAgent: "antigravity-cockpit-tools",
  oauthTimeoutMs: 600_000,
};

// Zed hosted LLM aggregator — RSA keypair native-app auth (NOT OAuth).
// Client generates ephemeral RSA-2048 keypair; user signs in at zed.dev/native_app_signin;
// Zed redirects to local callback with access_token RSA-encrypted against our public key.
// See open-sse/shared/zedAuth.js for the keypair/decrypt helpers.
export const ZED_HOSTED_CONFIG = {
  webBaseUrl: "https://zed.dev",
  cloudBaseUrl: "https://cloud.zed.dev",
  llmBaseUrl: "https://cloud.zed.dev",
  defaultNativeAppPort: 58443,
  oauthTimeoutMs: 600_000,
};

// OAuth timeout (5 minutes)
export const OAUTH_TIMEOUT = 300000;

// Grok CLI / Grok Build OAuth Configuration (Device Code Flow to auth.x.ai).
// Same client_id as xAI PKCE flow; different grant + scopes. See upstream a11937cdd.
export const GROK_CLI_CONFIG = {
  clientId: "b1a00492-073a-47ea-816f-4c329264a828",
  deviceCodeUrl: "https://auth.x.ai/oauth2/device/code",
  tokenUrl: "https://auth.x.ai/oauth2/token",
  // Scope from HAR capture of official grok-shell/grok-pager — matches registry/grok-cli.js
  scope:
    "openid profile email offline_access grok-cli:access api:access conversations:read conversations:write",
  referrer: "grok-build",
  pollInterval: 5000,
};

// Provider list
export const PROVIDERS = {
  CLAUDE: "claude",
  CODEX: "codex",
  GEMINI: "gemini-cli",
  QWEN: "qwen",
  QODER: "qoder",
  IFLOW: "iflow",
  ANTIGRAVITY: "antigravity",
  OPENAI: "openai",
  GITHUB: "github",
  KIRO: "kiro",
  CURSOR: "cursor",
  KIMI: "kimi",
  KIMI_CODING: "kimi",
  KILOCODE: "kilocode",
  CLINE: "cline",
  CLINEPASS: "clinepass",
  GITLAB: "gitlab",
  CODEBUDDY: "codebuddy-cn",
  CODEBUDDY_INTL: "codebuddy-intl",
  KIMCHI: "kimchi",
  GROK_CLI: "grok-cli",
  TRAE: "trae",
  WINDSURF: "windsurf",
  ZED: "zed",
};
