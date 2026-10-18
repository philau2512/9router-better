# Báo Cáo Phân Tích Upstream: v0.5.95 (a99cf57) -> v0.5.104 (87a74e1)
Repository: https://github.com/decolua/9router
Tổng số commits trong khoảng: **67 commits**

---

## I. TỔNG QUAN ĐÁNH GIÁ & ĐỀ XUẤT CHERRY-PICK

Từ `v0.5.95` đến `v0.5.104`, upstream có nhiều cải tiến lớn về:
1. **Providers mới**: AWS Bedrock (+ SSO, SigV4), MiniMax Code (mcode), Nous Research (OAuth + free tier), ElevenLabs Scribe STT.
2. **Models mới & Cập nhật**: Gemini 4 Argon, Claude Sonnet 5.5 & Opus 5.5 (Antigravity), GLM-5.3 1M context, Cursor Auto (Server Picks).
3. **Sửa lỗi giao thức trọng yếu**: 
   - Gemini xử lý `$ref` trong functionResponse tránh 400 INVALID_ARGUMENT.
   - Gemini không coi thuộc tính tên "properties" là schema node.
   - Gemini 4 xếp `functionResponse` ở cuối cùng và bỏ sampling params.
   - Cursor AgentService phục hồi session rỗng, giữ `strictProxy` trên h2, forward reasoning effort.
   - OpenCode cập nhật client fingerprint v2 và chuyển free tier sang `/inference/v1`.
   - Claude trả về message chuẩn khi client yêu cầu forced SSE JSON.
4. **Tính năng Dashboard & Quản lý**:
   - Model picker hỗ trợ tìm kiếm Regex / Phủ định (`-pattern`), chọn hàng loạt, lọc theo provider.
   - Lập lịch Auto-ping cố định theo giờ địa phương (Anchored schedule).
   - Kiểm soát truy cập API Key (Per-API-key access control: giới hạn key theo combo & model).
   - Hermes profile configuration & STT transcription qua 9router.
   - Netlify relay proxy pool.

### Cảnh Báo Ràng Buộc Bất Biến Của Fork (Merge Invariants):
Khi port/cherry-pick, **BẮT BUỘC TUÂN THỦ** các nguyên tắc sau để không làm hỏng fork:
- **Antigravity Invariant**: Giữ nguyên cap token 65535 khi có thinking, bộ đệm signed thought continuations (`thoughtSignatureStore`), và quy tắc alternating bridge turn trong `normalizeGeminiContents`. Các commit `625df74db`, `09f6d3956`, `eb3730170` phải được merge thủ công vào `open-sse/translator/formats/gemini.js`.
- **Kiro Invariant**: Commit Bedrock `a9d0ad269` tách EventStream ra khỏi `open-sse/executors/kiro.js`. Tuyệt đối không để làm mất cơ chế buffer `splitKiroThinkingText` và `thinkingTagPending` của Kiro.
- **SQLite / Database Invariant**: Fork dùng SQLite refactored (`src/lib/db/`). Commit `d8c585fb7` (Key Access Control) chạm vào schema và repo API keys, cần port chuẩn vào SQLite repos, không dùng code lowdb cũ.
- **Constants Modular Architecture**: `src/shared/constants/providers.js` của fork là barrel re-export. Bổ sung provider mới vào sub-module thay vì ghi đè barrel.
- **Provider Dashboard Split**: Provider detail view của fork được tách thành nhiều components. Merge giao diện connection/model vào đúng component tương ứng (`ProviderConnectionsCard`, `ProviderConnectionsToolbar`, v.v.).

---

## II. DANH MỤC PHÂN LOẠI CHI TIẾT TỪNG COMMIT

### 1. Nhà Cung Cấp & Tích Hợp Mới (New Providers & Integrations)
- **Đánh giá**: `KHUYẾN NGHỊ PORT CAO`
- **Lưu ý**: Mang lại các provider mới rất hữu ích (Bedrock, MiniMax Code, Nous Research, ElevenLabs STT). Lưu ý commit a9d0ad269 cần tách cẩn thận không ghi đè Kiro và barrel constants.

#### `d2f901775` | Wed Oct 7  | feat(systemone): support Cloudflare AI clef-flash endpoint
> Co-Authored-By: Claude Code <noreply@anthropic.com>

- **Số file thay đổi**: 2
- **Files**: `open-sse/handlers/systemoneCore.js`, `open-sse/providers/registry/cloudflare-ai.js`

#### `85bc33cea` | Wed Oct 7  | feat(providers): add MiniMax Code (mcode) credits provider
- **Số file thay đổi**: 23
- **Files**: `open-sse/executors/default.js`, `open-sse/executors/index.js`, `open-sse/executors/minimax-code.js`, `open-sse/providers/capabilities.js`, `open-sse/providers/registry/index.js`, `open-sse/providers/registry/minimax-code-global.js` và 17 files khác

#### `2f827bcf7` | Wed Oct 7  | feat(elevenlabs): add Scribe speech-to-text support (#4537)
- **Số file thay đổi**: 7
- **Files**: `open-sse/config/providerModels.js`, `open-sse/handlers/sttCore.js`, `open-sse/providers/registry/elevenlabs.js`, `skills/9router-stt/SKILL.md`, `.../media-providers/[kind]/[id]/components/SttExampleCard.js`, `tests/__baseline__/alias-baseline.json` và 1 files khác

#### `a9d0ad269` | Thu Oct 8  | feat(bedrock): add AWS Bedrock provider with AWS SSO credential support (#4157)
> Adds Amazon Bedrock (bedrock + bedrock-xai entries) with static-key and
> AWS SSO profile credential modes, a hand-rolled SigV4 signer on
> node:crypto, and the AWS EventStream decoder extracted from kiro.js into
> a shared util. Region and profile names are validated before use and
> signed headers/session tokens are redacted from logs and API responses.

- **Số file thay đổi**: 31
- **Files**: `next.config.mjs`, `open-sse/config/awsConstants.js`, `open-sse/executors/bedrock.js`, `open-sse/executors/index.js`, `open-sse/executors/kiro.js`, `open-sse/providers/registry/bedrock-xai.js` và 25 files khác

#### `90f89471c` | Tue Oct 13 | fix(nous): add API-key attribution tags (#4770)
- **Số file thay đổi**: 4
- **Files**: `CHANGELOG.md`, `open-sse/config/appConstants.js`, `open-sse/executors/default.js`, `tests/unit/nous-attribution.test.js`

#### `165f9b90a` | Thu Oct 15 | feat(providers): add Nous Research OAuth + free-tier provider
- **Số file thay đổi**: 24
- **Files**: `open-sse/providers/capabilities.js`, `open-sse/providers/registry/index.js`, `open-sse/providers/registry/nous.js`, `open-sse/providers/thinkingLevels.js`, `open-sse/services/nous.js`, `open-sse/services/tokenRefresh.js` và 18 files khác

---

### 2. Antigravity & Google Gemini / Vertex Protocol Updates
- **Đánh giá**: `BẮT BUỘC PORT (PORT CẨN THẬN THEO INVARIANT)`
- **Lưu ý**: Sửa lỗi 400 INVALID_ARGUMENT nguy hiểm của Gemini (schema $ref, properties param, Gemini 4 ordering) và bổ sung Claude 5.5, Gemini 4 Argon. Cần tích hợp giữ vững bridge turn của fork.

#### `625df74db` | Wed Oct 7  | fix(gemini): rename $ref keys in functionResponse payloads
> Gemini and Cloud Code treat a $ref key inside functionResponse.response as a pointer to functionResponse.parts and reject the request with 400 INVALID_ARGUMENT. Tool results carrying JSON Schema or OpenAPI documents (webfetch, read, MCP) triggered this. Sanitize the payload centrally in normalizeGeminiContents, which covers openai->gemini, the Claude->Antigravity envelope and the Antigravity executor.

- **Số file thay đổi**: 2
- **Files**: `open-sse/translator/formats/gemini.js`, `tests/unit/gemini-contents-normalization.test.js`

#### `a07ed95be` | Wed Oct 7  | feat(antigravity): add Claude Sonnet 5.5 and Opus 5.5 support
> - Add Sonnet/Opus 5.5 variants to Antigravity registry, CLI, MITM aliases, usage allowlist
> - Map variants to upstream IDs with reasoning effort suffixes
> - Add capabilities, pricing, and shared family quota routing

- **Số file thay đổi**: 14
- **Files**: `cli/src/cli/menus/providers.js`, `open-sse/executors/antigravity.js`, `open-sse/providers/capabilities.js`, `open-sse/providers/pricing.js`, `open-sse/providers/registry/antigravity.js`, `open-sse/services/usage/google.js` và 8 files khác

#### `6e4f82db3` | Wed Oct 7  | fix(translator): uniquify duplicate tool_call_ids for Gemini (#4532)
- **Số file thay đổi**: 2
- **Files**: `open-sse/translator/request/openai-to-gemini.js`, `tests/unit/gemini-duplicate-tool-call-ids.test.js`

#### `09f6d3956` | Thu Oct 8  | fix(gemini): do not treat properties map as schema node when tool param named properties (#4620)
> Fixes 400 error from Google Vertex/Gemini when an MCP tool contains a
> parameter literally named 'properties'. ensureObjectType recurses into
> values of properties maps instead of the map itself.

- **Số file thay đổi**: 1
- **Files**: `open-sse/translator/formats/gemini.js`

#### `24034f69c` | Thu Oct 8  | feat(antigravity): refresh model catalog and update MITM defaults to Gemini 3.8
> - remove deprecated gemini-3.5 and gemini-3-flash models
> - add gemini-3.1-pro-high mapping to gemini-pro-agent
> - update antigravity MITM default model to gemini-3.8-flash-medium
> - update model synonyms, pattern matching and unit tests
> 
> Co-Authored-By: Claude Code <noreply@anthropic.com>

- **Số file thay đổi**: 6
- **Files**: `open-sse/providers/registry/antigravity.js`, `open-sse/services/usage/google.js`, `src/mitm/config.js`, `src/shared/constants/cliTools.js`, `tests/unit/antigravity-mitm.test.js`, `tests/unit/antigravity-quota-gemini-3.6.test.js`

#### `cff2b1d97` | Sun Oct 11 | feat(antigravity): bump IDE version to 2.22.0
- **Số file thay đổi**: 7
- **Files**: `open-sse/providers/shared.js`, `src/mitm/antigravityIdeVersion.js`, `tests/__baseline__/providers-baseline.json`, `tests/unit/antigravity-ide-version.test.js`, `tests/unit/antigravity-retry-hook.test.js`, `tests/unit/antigravity-usage-headers.test.js` và 1 files khác

#### `9c1419100` | Wed Oct 14 | fix(vertex): honor API-key project/location for Gemini 4 Argon (#4821)
- **Số file thay đổi**: 3
- **Files**: `README.md`, `open-sse/executors/vertex.js`, `tests/unit/vertex-location.test.js`

#### `29fc880ec` | Wed Oct 14 | feat(gemini): add Gemini 4 Argon (gemini/vertex/antigravity)
> - Register gemini-4-argon on gemini + vertex and the gemini-4-argon-high
>   tier on antigravity (wire id per upstream catalog)
> - Capabilities pattern *gemini-4*: gemini-level thinking that cannot be
>   disabled, audio/video input, 1M context, 64K output
> - Thinking levels low/medium/high only — Argon rejects thinkingLevel
>   "minimal" and thinkingBudget with HTTP 400, so the gemini-level path now
>   clamps to the lowest supported level (Gemini 3 behavior unchanged)
> - Vertex OAuth/SA/ADC connections read defaultLocation from the registry
>   entry, defaulting Argon to "global" instead of the regional us-central1
>   (Argon serves only from global/us/eu)
> - Add getModelMeta() helper (suffix-aware registry entry lookup)
> 
> Co-Authored-By: Claude Code <noreply@anthropic.com>

- **Số file thay đổi**: 10
- **Files**: `open-sse/config/providerModels.js`, `open-sse/executors/vertex.js`, `open-sse/providers/capabilities.js`, `open-sse/providers/registry/antigravity.js`, `open-sse/providers/registry/gemini.js`, `open-sse/providers/registry/vertex.js` và 4 files khác

#### `eb3730170` | Thu Oct 15 | fix(gemini): drop sampling params and order functionResponse-last for Gemini 4 (#4802)
- **Số file thay đổi**: 4
- **Files**: `open-sse/executors/antigravity.js`, `open-sse/providers/capabilities.js`, `open-sse/translator/formats/gemini.js`, `open-sse/translator/request/openai-to-gemini.js`

---

### 3. Cursor & Codex Agent Protocol / Session Fixes
- **Đánh giá**: `BẮT BUỘC PORT`
- **Lưu ý**: Khắc phục lỗi AgentService trả về turn rỗng làm đứt session Cursor dài, forward reasoning effort, quota Cursor theo spend/request, và bỏ gpt-5.5 đã retired.

#### `e10da1603` | Wed Oct 7  | fix(usage): track exact Codex image token usage
- **Số file thay đổi**: 6
- **Files**: `open-sse/handlers/imageGenerationCore.js`, `open-sse/handlers/imageProviders/codex.js`, `src/sse/handlers/imageGeneration.js`, `tests/unit/codex-image-models.test.js`, `tests/unit/codex-image-usage-persistence.test.js`, `tests/unit/image-generation.test.js`

#### `cbd594aca` | Wed Oct 7  | fix(cursor): reject empty AgentService turns without successful stop
- **Số file thay đổi**: 2
- **Files**: `open-sse/executors/cursor.js`, `tests/unit/cursor-agent-exec-request.test.js`

#### `18ad1a89f` | Wed Oct 7  | fix(cursor): forward reasoning effort to AgentService Run
- **Số file thay đổi**: 3
- **Files**: `open-sse/executors/cursor.js`, `tests/unit/cursor-agent-exec-request.test.js`, `tests/unit/cursor-agent-proto.test.js`

#### `0dd4d6be2` | Wed Oct 7  | fix(codex): preserve explicit tool strict flags
- **Số file thay đổi**: 2
- **Files**: `open-sse/executors/codex.js`, `tests/unit/codex-tool-normalization.test.js`

#### `3ef4d8e31` | Sun Oct 11 | feat(usage): Cursor IDE quota via DashboardService (spend + request buckets) (#4689)
- **Số file thay đổi**: 5
- **Files**: `open-sse/providers/registry/cursor.js`, `open-sse/services/usage.js`, `open-sse/services/usage/cursor.js`, `.../dashboard/usage/components/ProviderLimits/utils.js`, `tests/unit/cursor-usage.test.js`

#### `e7f41c133` | Sun Oct 11 | fix(cursor): recover long sessions from empty AgentService turns (#4690)
- **Số file thay đổi**: 2
- **Files**: `open-sse/executors/cursor.js`, `tests/unit/cursor-agent-exec-request.test.js`

#### `f6c26d8ea` | Sun Oct 11 | feat(cursor): resolve Auto (Server Picks) to the account's default agent model (#4692)
- **Số file thay đổi**: 3
- **Files**: `open-sse/executors/cursor.js`, `open-sse/services/cursorModels.js`, `tests/unit/cursor-auto-model.test.js`

#### `f7708c9d7` | Sun Oct 11 | test(cursor): lock KV ack metadata echo with round-trip tests (#4694)
- **Số file thay đổi**: 2
- **Files**: `open-sse/executors/cursor.js`, `tests/unit/cursor-kv-metadata-roundtrip.test.js`

#### `cfd8c6184` | Sun Oct 11 | fix(cursor): hold strictProxy on the AgentService h2 path (#4696)
- **Số file thay đổi**: 4
- **Files**: `open-sse/executors/cursor.js`, `open-sse/handlers/chatCore.js`, `src/sse/services/auth.js`, `tests/unit/cursor-agent-strict-proxy.test.js`

#### `7878f53ba` | Thu Oct 15 | fix(codex): drop retired gpt-5.5 from registry, image and auto-ping
> gpt-5.5 is retired from Codex with ChatGPT sign-in (2026-10-14), so the
> backend rejects it with HTTP 400. Remove the registry entries and image
> variant, route image generation and quota auto-ping through gpt-5.6 models,
> and update the CLI preset default to gpt-6.1-sol.
> 
> Co-Authored-By: Claude Haiku 5.5 <noreply@anthropic.com>

- **Số file thay đổi**: 13
- **Files**: `open-sse/handlers/imageProviders/codex.js`, `open-sse/providers/registry/codex.js`, `src/app/(dashboard)/dashboard/providers/[id]/ConnectionRow.js`, `src/app/(dashboard)/dashboard/usage/components/ProviderLimits/index.js`, `src/shared/constants/cliTools.js`, `src/shared/constants/config.js` và 7 files khác

---

### 4. OpenCode & OpenCode Zen (Free Tier / Multi-turn / Fingerprint v2)
- **Đánh giá**: `KHUYẾN NGHỊ PORT CAO`
- **Lưu ý**: Đồng bộ fingerprint v2 cho OpenCode free tier, chuyển endpoint sang /inference/v1, fix multi-turn reasoning_content cho Zen.

#### `ef4679dfa` | Tue Oct 13 | fix(opencode): encode inverted timestamp in translated session IDs (#4780)
> Upstream OpenCode Zen verifies that the 12-hex prefix in `ses_<12hex><14base62>`
> decodes to a recent inverted timestamp `~(BigInt(Date.now()) * 4096n + counter)`.
> Synthesizing session IDs from SHA-256 digests in `translateSessionId` caused
> all non-OpenCode clients (curl, omp, pi, Claude Code, etc.) to receive
> HTTP 403 FreeTierError ('OpenCode\'s free tier can only be used from within OpenCode').
> 
> This commit:
> - Updates `translateSessionId` in both `opencode` and `opencode-zen` executors to
>   generate valid inverted-timestamp session IDs using `generateSessionId()`.
> - Adds an in-memory `Map` cache with TTL eviction to ensure session stability
>   and multi-turn conversational affinity across requests.
> - Adds unit tests verifying valid timestamp encoding and translation stability.
> 
> Fixes #4780, #4778, #4777, #4101, #4127, #4781.

- **Số file thay đổi**: 3
- **Files**: `open-sse/executors/opencode-zen.js`, `open-sse/executors/opencode.js`, `tests/unit/opencode-session.test.js`

#### `468aa7d9e` | Tue Oct 13 | fix(param-support): drop response_format for opencode-go deepseek models
> OpenCode Go's relay rejects response_format for its deepseek family upstream
> (HTTP 400) while serving it for every other model on the same relay, and the
> rejection body is a bare model echo ({"model":"deepseek-v4.1-flash"}) that
> names neither the field nor the reason, so callers cannot classify it.
> 
> Measured 2026-10-13 with one Go key: 8/8 json_schema -> 400, 4/4 json_object
> -> 400, 4/4 without the field -> 200; glm/kimi/mimo/minimax/qwen/grok/gpt on
> the same relay -> 200 with json_schema. json_object is rejected as well, so the
> field has to be dropped rather than downgraded.
> 
> Adds a model-scoped STRIP_RULES entry (the config-driven hook for params a
> provider/model rejects upstream) plus unit coverage for the deepseek family,
> non-deepseek OpenCode Go models, and other providers fronting deepseek ids.

- **Số file thay đổi**: 2
- **Files**: `open-sse/translator/concerns/paramSupport.js`, `tests/unit/param-support.test.js`

#### `4c58e7f31` | Sun Oct 11 | fix(capabilities): add missing OpenCode Free reasoning entries (space-bunny & co)
> An id present in none of MODEL_CAPABILITIES / PROVIDER_CAPABILITIES /
> PATTERN_CAPABILITIES falls through to DEFAULT_CAPABILITIES, which has
> reasoning: false. applyThinking() then takes the early return and runs
> stripAll(body), so the client's reasoning_effort is deleted before the
> request reaches the upstream — the same silent drop reported in #2690,
> with a different trigger: not an alias that matches no pattern, but an id
> that shipped after the tables were last touched.
> 
> Adds per-id entries for the OpenCode Free models that models.dev reports
> as reasoning-capable and that have no table entry: space-bunny-free,
> space-bunny, big-pickle, exo-free, fledge-alpha-free, longcat-2.0,
> longcat-2.0-free, longcat-2.5-preview-free, north-mini-code-free,
> ring-2.6-1t-free, x-preview-f-free.
> 
> Modalities and limits are taken verbatim from models.dev. Entries are
> per-id rather than a shared glob because the ids disagree on modalities
> (text-only vs vision vs video) and on context/output limits — a glob
> would overstate several of them.
> 
> thinkingFormat: "openai" matches the value resolveFormat() already falls
> back to for these ids, so the wire format is unchanged; declaring it
> makes getThinkingLevels() return the openai set, which is what clamps
> "max" to "xhigh".
> 
> Tests: regression coverage in tests/translator/thinking-unified.test.js
> (effort preserved, max clamped, control case with no entry still stripped)
> and data coverage in tests/unit/capabilities.test.js.
> 
> Refs #2690.

- **Số file thay đổi**: 3
- **Files**: `open-sse/providers/capabilities.js`, `tests/translator/thinking-unified.test.js`, `tests/unit/capabilities.test.js`

#### `59e9b5264` | Tue Oct 13 | fix(opencode-zen): use attested free-tier identity for -free models on keyed lane (#4784)
> - Detect free-tier models via isOpencodeFreeTierModel() (-free suffix)
> - Send Bearer public and x-opencode-request for free-tier models on keyed connections
> - Keep connection key untouched for paid models

- **Số file thay đổi**: 4
- **Files**: `open-sse/executors/opencode-zen.js`, `open-sse/providers/models/helpers.js`, `tests/unit/opencode-session.test.js`, `tests/unit/opencode-zen-free-tier.test.js`

#### `c86443689` | Tue Oct 13 | fix(opencode-go): route claude-haiku-5-5 to /messages with adaptive thinking (#4727)
> - Route claude-haiku-5-5 on OpenCode Go to /messages endpoint with targetFormat: "claude"
> - Emit claude-adaptive thinking format (adaptive type + output_config.effort)
> - Set contextWindow to 1M and maxOutput to 128k
> - Drop empty thinking blocks from Claude requests
> - Strip context_management field for non-Anthropic providers
> - Resolve combo seat aliases to provider id in dashboard and models API

- **Số file thay đổi**: 14
- **Files**: `open-sse/providers/capabilities.js`, `open-sse/providers/registry/opencode-go.js`, `open-sse/translator/formats/claude.js`, `src/app/api/models/route.js`, `src/shared/hooks/useModelCaps.js`, `tests/unit/capabilities.test.js` và 8 files khác

#### `e964e4826` | Thu Oct 15 | fix(opencode): inject reasoning_content placeholder for Zen multi-turn chats (#4805)
- **Số file thay đổi**: 1
- **Files**: `open-sse/providers/registry/opencode.js`

#### `5bdcd5e76` | Thu Oct 15 | fix(opencode): move free tier to /inference/v1 with the v2 client fingerprint (#4842)
- **Số file thay đổi**: 8
- **Files**: `open-sse/executors/opencode-zen.js`, `open-sse/executors/opencode.js`, `open-sse/utils/opencodeFingerprint.js`, `tests/unit/executor-const-guard.test.js`, `tests/unit/opencode-fingerprint.test.js`, `tests/unit/opencode-free-tool-choice.test.js` và 2 files khác

---

### 5. Model Catalog, Capabilities & Routing Enhancements
- **Đánh giá**: `KHUYẾN NGHỊ PORT CAO`
- **Lưu ý**: Cập nhật context GLM-5.3 lên 1M, Claude PDF input, Muse Responses routing, combo fallback khi trả về HTTP 200 nội dung rỗng.

#### `63de82b8e` | Wed Oct 7  | feat(codebuddy-cn): sync catalog with 2026-09-30 server config
- **Số file thay đổi**: 3
- **Files**: `open-sse/providers/capabilities.js`, `open-sse/providers/registry/codebuddy-cn.js`, `open-sse/providers/thinkingLevels.js`

#### `b00ba1aa4` | Wed Oct 7  | fix(muse): route Responses-only models to their declared transport + nest reasoning effort
- **Số file thay đổi**: 3
- **Files**: `open-sse/handlers/chatCore.js`, `open-sse/translator/concerns/thinkingUnified.js`, `tests/unit/muse-responses-wire.test.js`

#### `0f7f6e72a` | Wed Oct 7  | fix(capabilities): GLM-5.2/5.3 context is 1M, not the stale 200k pin (#4544)
- **Số file thay đổi**: 2
- **Files**: `open-sse/providers/capabilities.js`, `tests/unit/glm53-context-window.test.js`

#### `6a1573eba` | Thu Oct 8  | fix(combo): show compatible node models in picker without a connection (#4659)
- **Số file thay đổi**: 1
- **Files**: `src/shared/components/ModelSelectModal.js`

#### `c61ee37dd` | Thu Oct 8  | fix(capabilities): GLM-5.3 cannot disable thinking (#4656)
> Fixes #4409. z.ai docs state GLM-5.3 and GLM-5.3-FLASH no longer support
> disabling thinking (returns 400 code 1210 if thinking is disabled).
> Mark thinkingCanDisable: false for the GLM-5.3 line.

- **Số file thay đổi**: 2
- **Files**: `open-sse/providers/capabilities.js`, `tests/unit/glm53-thinking-cannot-disable.test.js`

#### `f5f880394` | Tue Oct 13 | fix(capabilities): advertise PDF input for current Claude models (#4761)
- **Số file thay đổi**: 1
- **Files**: `open-sse/providers/capabilities.js`

#### `8f4e38007` | Tue Oct 13 | fix(combo): fallback when model returns HTTP 200 with zero usable content (#4750)
- **Số file thay đổi**: 1
- **Files**: `open-sse/services/combo.js`

#### `a8f63f4d7` | Thu Oct 15 | fix(models): expose no-auth free providers in /v1/models and prune custom models on node deletion
> Register virtual connections for noAuth free providers in buildModelsList so their models (oc/*, edge-tts, ...) stay listed once other providers are connected (#3115), and check isDisabled by providerId alongside aliases. Also delete a compatible node customModels kv rows inside deleteProviderNode so deleted nodes stop surfacing models.

- **Số file thay đổi**: 2
- **Files**: `src/app/api/v1/models/route.js`, `src/lib/db/repos/nodesRepo.js`

---

### 6. API Key Access Control (Giới hạn quyền truy cập theo Key)
- **Đánh giá**: `CÂN NHẮC PORT (PORT CÓ ADAPTATION CHO SQLITE)`
- **Lưu ý**: Cho phép giới hạn từng API key chỉ được dùng một số model hoặc combo nhất định. Cần map schema migration vào SQLite repos của fork.

#### `d8c585fb7` | Wed Oct 7  | feat(keys): per-API-key access control: restrict a key to selected combos and models
- **Số file thay đổi**: 26
- **Files**: `src/app/(dashboard)/dashboard/endpoint/EndpointPageClient.js`, `.../dashboard/endpoint/components/KeyAccessControls.js`, `src/app/api/keys/[id]/route.js`, `src/app/api/models/test/ping.js`, `src/app/api/v1/models/[...model]/route.js`, `src/app/api/v1/models/route.js` và 20 files khác

---

### 7. Proxy Pools & Network Relay
- **Đánh giá**: `TÙY CHỌN (OPTIONAL)`
- **Lưu ý**: Thêm Netlify relay proxy pool cho người dùng muốn relay qua Netlify Functions.

#### `4fa46034a` | Wed Oct 7  | feat(proxy-pools): add Netlify relay proxy pool
> - Deploy serverless relay function via Netlify digest-deploy API
> - Wire netlify type through proxy pool validation, testing, and connection proxy config
> - Add dashboard deployment modal and badge

- **Số file thay đổi**: 8
- **Files**: `src/app/(dashboard)/dashboard/proxy-pools/page.js`, `src/app/api/proxy-pools/[id]/route.js`, `src/app/api/proxy-pools/[id]/test/route.js`, `src/app/api/proxy-pools/netlify-deploy/route.js`, `src/app/api/proxy-pools/route.js`, `src/lib/network/connectionProxy.js` và 2 files khác

---

### 8. Quota, Billing & Auto-Ping Scheduling
- **Đánh giá**: `KHUYẾN NGHỊ PORT`
- **Lưu ý**: Lập lịch auto-ping cố định theo mốc giờ địa phương (ví dụ 0h hàng ngày), Ollama cached tokens, Qoder promo quota.

#### `466272490` | Wed Oct 7  | fix(ollama): report prompt_eval_cached_count as cached_tokens in usage tracking
- **Số file thay đổi**: 5
- **Files**: `open-sse/handlers/chatCore/requestDetail.js`, `open-sse/translator/concerns/usage.js`, `open-sse/utils/usageTracking.js`, `tests/unit/extract-usage-cache-shapes.test.js`, `tests/unit/usage-concern.test.js`

#### `b2aaf83bb` | Tue Oct 13 | fix(qoder): surface add-on (free-credit promo) quota in the quota tracker (#4758)
- **Số file thay đổi**: 3
- **Files**: `open-sse/services/usage/misc.js`, `.../dashboard/usage/components/ProviderLimits/QuotaTable.js`, `.../dashboard/usage/components/ProviderLimits/utils.js`

#### `be51142b4` | Thu Oct 15 | feat(quota): anchored auto-ping schedule at fixed local times (#4848)
> - Add anchored ping schedule per connection at fixed local wall-clock slots
> - Calculate and preview daily slots with timezone and DST support
> - Fire scheduled slots independently or alongside reactive auto-ping
> - Add schedule modal to provider connection dashboard

- **Số file thay đổi**: 8
- **Files**: `.../dashboard/providers/[id]/AutoPingScheduleModal.js`, `src/app/(dashboard)/dashboard/providers/[id]/ConnectionRow.js`, `src/app/(dashboard)/dashboard/providers/[id]/page.js`, `src/shared/services/initializeApp.js`, `src/shared/services/quotaAutoPing.js`, `src/shared/services/quotaPingSchedule.js` và 2 files khác

#### `28d401596` | Thu Oct 15 | feat(quota): unify auto-ping mode selection and default to local timezone
> - Unify auto-ping mode selection into a single 3-way toggle (Off / On reset / Schedule)
> - Fix button alignment, icon sizing, and border visibility in schedule modal
> - Default schedule timezone to machine local timezone instead of hardcoded America/Sao_Paulo
> - Bring auto-ping schedule configuration and state indicators to /dashboard/quota
> 
> Co-Authored-By: Claude Code <noreply@anthropic.com>

- **Số file thay đổi**: 6
- **Files**: `.../dashboard/providers/[id]/AutoPingScheduleModal.js`, `src/app/(dashboard)/dashboard/providers/[id]/ConnectionRow.js`, `src/app/(dashboard)/dashboard/providers/[id]/page.js`, `.../dashboard/usage/components/ProviderLimits/index.js`, `src/shared/services/quotaPingSchedule.js`, `tests/unit/quota-ping-schedule.test.js`

#### `813a0121b` | Thu Oct 15 | fix(usage): token fallback for input_tokens rows and stable key masking in stats
> The 24h/today live-history branch read only tokens.prompt_tokens from the JSON blob, so rows recorded with input_tokens (embeddings, Gemini) counted as zero; fall back to input_tokens and the persisted promptTokens column like the other read paths. maskApiKey and the apiKeyMap lookup now trim so whitespace variants resolve and mask consistently; key name fallback shows the masked key (#3640, #2918). Grouping keys stay on the full API key.

- **Số file thay đổi**: 2
- **Files**: `src/lib/db/repos/usageRepo.js`, `src/shared/components/UsageStats.js`

---

### 9. CLI & Hermes Tools
- **Đánh giá**: `KHUYẾN NGHỊ PORT`
- **Lưu ý**: Hermes profiles, CLI connect lấy model từ server, Hermes STT transcription.

#### `b677bfce3` | Wed Oct 7  | fix(cli): store model IDs in TUI combos
> - Convert /api/models objects to full provider/model ID strings before saving
> - Reject malformed model entries when creating combos from interactive CLI

- **Số file thay đổi**: 3
- **Files**: `cli/src/cli/menus/combos.js`, `cli/src/cli/utils/comboModelId.js`, `tests/unit/tui-combo-model-id.test.js`

#### `8a90d3c9d` | Wed Oct 7  | fix(cli): take `connect` models from the server; add `show`, `--save`, Pi and Oh My Pi
- **Số file thay đổi**: 8
- **Files**: `cli/README.md`, `cli/cli.js`, `cli/src/cli/commands/connect.js`, `cli/src/cli/commands/connectTools.js`, `cli/src/cli/commands/show.js`, `package.json` và 2 files khác

#### `a9c9f6836` | Thu Oct 8  | feat(hermes): per-profile configuration across API, Dashboard and CLI (#4660)
> Support Hermes Agent configuration per profile across settings API,
> Dashboard card, and CLI menu. Includes discovery, bulk apply, scoped reset,
> model sentinel fix, and synced auxiliary roles.

- **Số file thay đổi**: 11
- **Files**: `CHANGELOG.md`, `cli/src/cli/api/client.js`, `cli/src/cli/menus/cliTools.js`, `.../dashboard/cli-tools/components/HermesToolCard.js`, `src/app/api/cli-tools/hermes-profiles/route.js`, `src/app/api/cli-tools/hermes-settings/hermesProfiles.js` và 5 files khác

#### `d6431f8b7` | Tue Oct 13 | feat(cli-tools): Hermes audio transcription via 9router (#4763)
- **Số file thay đổi**: 5
- **Files**: `CHANGELOG.md`, `.../dashboard/cli-tools/components/HermesToolCard.js`, `src/app/api/cli-tools/hermes-settings/hermesYaml.js`, `src/app/api/cli-tools/hermes-settings/route.js`, `tests/unit/hermes-yaml.test.js`

---

### 10. Dashboard, Web UI & UX Improvements
- **Đánh giá**: `KHUYẾN NGHỊ PORT`
- **Lưu ý**: Model picker regex/negation search và batch select cực kỳ tiện lợi; fix mobile layout và unclip popup qua portal.

#### `2d94d3ab8` | Thu Oct 8  | feat(dashboard): open 9Remote sidebar item directly to website
> Replace the promo modal with a direct link to https://9remote.cc,
> matching the 9English sidebar item behavior.
> 
> Co-Authored-By: Claude Code <noreply@anthropic.com>

- **Số file thay đổi**: 1
- **Files**: `src/shared/components/Sidebar.js`

#### `eea082157` | Thu Oct 8  | fix(dashboard): fix mobile layouts for endpoint, provider models and cli-tools
> - endpoint: align key row items to top and wrap long key text
> - header: hide parent breadcrumb and donate button on mobile to avoid overlapping
> - provider: make model chips full width on mobile and break long model names
> - cli-tools: place model input and select button on same row, inline checkboxes
> 
> Co-Authored-By: Claude Code <noreply@anthropic.com>

- **Số file thay đổi**: 4
- **Files**: `.../dashboard/cli-tools/components/ClaudeToolCard.js`, `src/app/(dashboard)/dashboard/endpoint/EndpointPageClient.js`, `src/app/(dashboard)/dashboard/providers/[id]/ModelRow.js`, `src/shared/components/Header.js`

#### `da1756a82` | Thu Oct 15 | feat(ui): model picker regex/negation search, batch select, provider filtering
> ModelSelectModal gains exclusion (!token / -token) and /regex/ search, Select/Deselect All over the filtered set, per-provider wildcard entries (allowProviderWildcard), enabledModels and deleted-compatible-node filtering, and a fresh /api/providers fetch on open. Shared query logic in modelSearchFilter.js; combo pages pass active connections only.

- **Số file thay đổi**: 10
- **Files**: `src/app/(dashboard)/dashboard/combos/page.js`, `.../(dashboard)/dashboard/media-providers/combo/[id]/page.js`, `src/shared/components/Button.js`, `src/shared/components/ComboFormModal.js`, `src/shared/components/ModelSelectModal.js`, `src/shared/utils/connectionStatus.js` và 4 files khác

#### `d95bb8ea2` | Thu Oct 15 | fix(dashboard): unclip proxy dropdown and tooltips via body portal
> The per-connection proxy dropdown and shared Tooltip rendered absolutely
> inside the connections list, which clips at max-h-[500px] overflow-y-auto.
> Render both through createPortal(document.body) with fixed viewport
> positioning (auto flip-up + max-height for the proxy dropdown) so ancestor
> overflow can no longer cut them off.
> 
> Co-Authored-By: Claude Code <noreply@anthropic.com>

- **Số file thay đổi**: 2
- **Files**: `src/app/(dashboard)/dashboard/providers/[id]/ConnectionRow.js`, `src/shared/components/Tooltip.js`

---

### 11. Translation & Transports Edge Fixes
- **Đánh giá**: `KHUYẾN NGHỊ PORT`
- **Lưu ý**: Kimi Responses routing, Copilot embeddings, Headroom false compression warning fix, Claude forced SSE JSON fix.

#### `3125ac2bd` | Wed Oct 7  | fix(kimi): route Responses clients to the Kimi Code /responses endpoint
- **Số file thay đổi**: 2
- **Files**: `open-sse/providers/registry/kimi.js`, `tests/unit/kimi-responses-transport.test.js`

#### `ee3234003` | Wed Oct 7  | fix(tts): accept server model and voice in self-hosted example
- **Số file thay đổi**: 2
- **Files**: `.../dashboard/media-providers/[kind]/[id]/components/TtsExampleCard.js`, `src/shared/constants/ttsProviders.js`

#### `1d4335d44` | Tue Oct 13 | fix(translator): return Claude messages for forced SSE JSON responses (#4789)
> Reuse the existing Claude message converter in both forced-stream JSON paths and cover text preservation, tool calls, and client format compatibility.

- **Số file thay đổi**: 4
- **Files**: `open-sse/handlers/chatCore/nonStreamingHandler.js`, `open-sse/handlers/chatCore/sseToJsonHandler.js`, `open-sse/translator/concerns/claudeMessage.js`, `tests/unit/claude-forced-sse-json.test.js`

#### `51a1827e2` | Wed Oct 14 | fix(github): route Copilot embeddings to api.githubcopilot.com (#4793)
- **Số file thay đổi**: 4
- **Files**: `open-sse/handlers/embeddingProviders/github.js`, `open-sse/handlers/embeddingProviders/index.js`, `open-sse/providers/registry/github.js`, `tests/unit/embeddingsCore.test.js`

#### `db81a8c9f` | Thu Oct 15 | fix(headroom): avoid false compression warnings when tools dominate body (#4855)
> - Avoid false phantom savings warnings when large tool schemas dominate outbound JSON
> - Require both messageBytes and bodyBytes to shrink <5% before warning
> - Preserve top-level system prompt savings detection for Claude
> - Add tests covering large tool schemas and message compression thresholds

- **Số file thay đổi**: 5
- **Files**: `CHANGELOG.md`, `open-sse/handlers/chatCore.js`, `open-sse/rtk/headroom.js`, `tests/unit/headroom-chat-core.test.js`, `tests/unit/headroom.test.js`

#### `fb30246ce` | Thu Oct 15 | fix(tests): isolate zed-native-auth DATA_DIR so it stops writing to the real DB
> The criterion-3 callback test saved a real "Account N" zed connection into
> ~/.9router on every full-suite run. Set DATA_DIR to a temp dir before the DB
> layer loads (dynamic imports + vi.resetModules, same pattern as
> zed-live-models.test.js) and clean it up in afterAll.
> 
> Co-Authored-By: Claude Code <noreply@anthropic.com>

- **Số file thay đổi**: 1
- **Files**: `tests/unit/zed-native-auth.test.js`

---

### 12. Commits Bỏ Qua (Skip / Reverted / Releases)
- **Đánh giá**: `BỎ QUA (DO NOT PORT)`
- **Lưu ý**: Gồm commit version bump (v0.5.99, v0.5.104), changelog, merge chore, và tính năng per-key token quota (2aa9307f5 bị hoàn tác bởi 6ed886857).

#### `ce4460ef7` | Thu Oct 8  | # v0.5.99 (2026-10-08)
> ## Features
> - **Antigravity**: refresh model catalog with Gemini 3.8 Flash (High/Medium/Low), Gemini 3.6 Flash, and Gemini 3.1 Pro High; remove deprecated 3.5/3-flash models; update MITM default to `gemini-3.8-flash-medium`
> - **Antigravity**: add Claude Sonnet 5.5 and Opus 5.5 support with reasoning effort variants, pricing, and family quota routing
> - **Bedrock**: add Amazon Bedrock (`bedrock` and `bedrock-xai`) provider with static keys, AWS SSO profiles, native SigV4 signer, and shared EventStream decoder (#4157)
> - **Hermes**: per-profile configuration across API, Dashboard card, and CLI menu with bulk apply, scoped reset, and auxiliary roles (#4660)
> - **API Keys**: per-API-key access control — restrict keys to allowed combos and models via interactive modal
> - **ElevenLabs**: add Scribe speech-to-text support (#4537)
> - **Proxy Pools**: add Netlify serverless relay proxy pool with digest-deploy API and dashboard management modal
> - **Providers**: add MiniMax Code (`mcode`) credits provider
> - **System One**: support Cloudflare AI `clef-flash` endpoint
> - **Codebuddy CN**: sync catalog with 2026-09-30 server config
> - **Dashboard**: open 9Remote sidebar item directly to website
> 
> ## Fixes
> - **Dashboard**: fix mobile layouts for API Keys card (alignment, code wrap), header breadcrumbs (overflow collision), model chips (full width, break-all), and Claude CLI settings
> - **Gemini**: do not treat properties map as schema node when tool parameter is named `properties` (#4620); rename `$ref` keys in `functionResponse` payloads
> - **Translator**: uniquify duplicate `tool_call_ids` for Gemini (#4532)
> - **Capabilities**: mark GLM-5.3 as unable to disable thinking (#4656); correct GLM-5.2/5.3 context window to 1M (#4544)
> - **Combos**: show compatible node models in picker without an active connection (#4659)
> - **CLI**: take `connect` models from server; add `show`, `--save`, Pi and Oh My Pi; store full model IDs in TUI combos
> - **Kimi**: route Responses clients to Kimi Code `/responses` endpoint
> - **Cursor**: forward reasoning effort to AgentService Run; reject empty turns without successful stop
> - **Codex**: preserve explicit tool strict flags; track exact image token usage
> - **Ollama**: report `prompt_eval_cached_count` as cached tokens in usage tracking
> - **Muse**: route Responses-only models to declared transport and nest reasoning effort
> - **TTS**: accept server model and voice in self-hosted example

- **Số file thay đổi**: 3
- **Files**: `CHANGELOG.md`, `cli/package.json`, `package.json`

#### `7e0043def` | Thu Oct 15 | Merge branch 'chore/codex-drop-gpt-5.5'
> Co-Authored-By: Claude Haiku 5.5 <noreply@anthropic.com>

- **Số file thay đổi**: 0
- **Files**: ``

#### `2aa9307f5` | Thu Oct 15 | feat(keys): per-key token quotas and pattern-based model access
> API keys gain tokenLimit/usedTokens (additive schema columns), enforced with 429 once exhausted and incremented from saveRequestUsage; the dashboard shows usage progress and can reset the counter. Model restrictions stay in keyAccess.js on resolved identities, now supporting wildcard entries (oc/*, *claude*), alias/id provider spellings, and deny entries (!opus / -haiku) with deny-only lists open-except-denied; an empty allow list still denies everything. The auth gate (checkApiKeyQuota) applies pause/quota to known keys regardless of requireApiKey while unknown keys keep passing in local mode.

- **Số file thay đổi**: 21
- **Files**: `src/app/(dashboard)/dashboard/endpoint/EndpointPageClient.js`, `src/app/api/keys/[id]/route.js`, `src/app/api/keys/route.js`, `src/lib/db/index.js`, `src/lib/db/repos/apiKeysRepo.js`, `src/lib/db/repos/usageRepo.js` và 15 files khác

#### `3c48d275a` | Thu Oct 15 | Features:
> Gemini: add Gemini 4 Argon (gemini/vertex, plus a high tier on Antigravity) — non-dismissible gemini-level thinking, 1M context, Vertex defaults to global location
> Usage: Cursor IDE quota via DashboardService (spend + request buckets) (#4689)
> Cursor: resolve Auto (Server Picks) to the account's default agent model (#4692)
> Quota: anchored auto-ping schedule at fixed local times with timezone/DST support and schedule modal (#4848); unify mode selection into a 3-way toggle, default timezone to local, bring schedule config to the quota page
> Providers: add Nous Research OAuth + free-tier provider
> UI: model picker regex/negation search, Select/Deselect All, provider filtering, per-provider wildcards
> API Keys: per-key token quotas (429 once exhausted, dashboard progress + reset) and pattern-based model access (oc/*, *claude*, !opus)
> Fixes:
> 
> Cursor: recover long sessions from empty AgentService turns (#4690); hold strictProxy on the AgentService h2 path (#4696)
> OpenCode: encode inverted timestamp in translated session IDs so non-OpenCode clients pass Zen free-tier checks (#4780); inject reasoning_content placeholder for Zen multi-turn chats (#4805); move free tier to /inference/v1 with the v2 client fingerprint (#4842)
> OpenCode Zen: use attested free-tier identity for -free models on keyed lane (#4784)
> OpenCode Go: route claude-haiku-5-5 to /messages with adaptive thinking (#4727); drop response_format for the deepseek family (relay rejects with a bare 400)
> Capabilities: add missing OpenCode Free reasoning entries (space-bunny & co) so reasoning_effort stops being silently stripped; advertise PDF input for current Claude models (#4761)
> Combos: fallback when a model returns HTTP 200 with zero usable content (#4750)
> Qoder: surface add-on (free-credit promo) quota in the quota tracker (#4758)
> Translator: return Claude messages for forced SSE JSON responses (#4789)
> Vertex: honor API-key project/location for Gemini 4 Argon (#4821)
> GitHub: route Copilot embeddings to api.githubcopilot.com (#4793)
> Codex: drop retired gpt-5.5 from registry, image, and auto-ping; CLI preset default to gpt-6.1-sol
> Gemini: drop sampling params and order functionResponse-last for Gemini 4 (#4802)
> Models: expose no-auth free providers in /v1/models; prune custom models on node deletion
> Usage: token fallback for input_tokens rows in 24h/today stats; stable key masking
> Dashboard: unclip proxy dropdown and tooltips via body portal

- **Số file thay đổi**: 3
- **Files**: `CHANGELOG.md`, `cli/package.json`, `package.json`

#### `6ed886857` | Thu Oct 15 | Revert "feat(keys): per-key token quotas and pattern-based model access"
> This reverts commit 2aa9307f5030b563bd2e5aa339847bba9d697533.

- **Số file thay đổi**: 21
- **Files**: `src/app/(dashboard)/dashboard/endpoint/EndpointPageClient.js`, `src/app/api/keys/[id]/route.js`, `src/app/api/keys/route.js`, `src/lib/db/index.js`, `src/lib/db/repos/apiKeysRepo.js`, `src/lib/db/repos/usageRepo.js` và 15 files khác

#### `87a74e1bd` | Thu Oct 15 | # v0.5.104 (2026-10-15)
> ## Features
> - **Gemini**: add Gemini 4 Argon (`gemini`/`vertex`, plus a `high` tier on Antigravity) — non-dismissible gemini-level thinking, 1M context, Vertex defaults to `global` location
> - **Usage**: Cursor IDE quota via DashboardService (spend + request buckets) (#4689)
> - **Cursor**: resolve Auto (Server Picks) to the account's default agent model (#4692)
> - **Quota**: anchored auto-ping schedule at fixed local times with timezone/DST support and schedule modal (#4848); unify mode selection into a 3-way toggle, default timezone to local, bring schedule config to the quota page
> - **Providers**: add Nous Research OAuth + free-tier provider
> - **UI**: model picker regex/negation search, Select/Deselect All, provider filtering, and per-provider wildcards
> 
> ## Fixes
> - **Nous**: add missing attribution tags to API-key requests through compatible Chat Completions connections, preserving caller tags and identities (#4745)
> - **Cursor**: recover long sessions from empty AgentService turns (#4690); hold strictProxy on the AgentService h2 path (#4696)
> - **OpenCode**: encode inverted timestamp in translated session IDs so non-OpenCode clients pass Zen free-tier checks (#4780); inject `reasoning_content` placeholder for Zen multi-turn chats (#4805); move free tier to `/inference/v1` with the v2 client fingerprint (#4842)
> - **OpenCode Zen**: use attested free-tier identity for `-free` models on keyed lane (#4784)
> - **OpenCode Go**: route `claude-haiku-5-5` to `/messages` with adaptive thinking (#4727); drop `response_format` for the deepseek family (relay rejects with a bare 400)
> - **Capabilities**: add missing OpenCode Free reasoning entries (space-bunny & co) so `reasoning_effort` stops being silently stripped; advertise PDF input for current Claude models (#4761)
> - **Combos**: fallback when a model returns HTTP 200 with zero usable content (#4750)
> - **Qoder**: surface add-on (free-credit promo) quota in the quota tracker (#4758)
> - **Translator**: return Claude messages for forced SSE JSON responses (#4789)
> - **Vertex**: honor API-key project/location for Gemini 4 Argon (#4821)
> - **GitHub**: route Copilot embeddings to `api.githubcopilot.com` (#4793)
> - **Codex**: drop retired gpt-5.5 from registry, image, and auto-ping; CLI preset default to `gpt-6.1-sol`
> - **Gemini**: drop sampling params and order functionResponse-last for Gemini 4 (#4802)
> - **Models**: expose no-auth free providers in `/v1/models`; prune custom models on node deletion
> - **Usage**: token fallback for `input_tokens` rows in 24h/today stats; stable key masking
> - **Dashboard**: unclip proxy dropdown and tooltips via body portal
> 
> Co-Authored-By: Claude Code <noreply@anthropic.com>

- **Số file thay đổi**: 1
- **Files**: `CHANGELOG.md`

---

## III. KẾ HOẠCH HÀNH ĐỘNG ĐỀ XUẤT (ACTION PLAN)

Để port an toàn và không gây lỗi hồi quy (regression), nên chia thành các giai đoạn:

### Giai đoạn 1: Bug Fixes & Protocol Stability (Ưu tiên số 1 - An toàn, rủi ro thấp)
- Port các fix cho Gemini: `625df74db` ($ref sanitize), `6e4f82db3` (uniquify tool IDs), `09f6d3956` (param properties fix).
- Port các fix cho Cursor: `cbd594aca`, `18ad1a89f`, `0dd4d6be2`, `e7f41c133`, `cfd8c6184`.
- Port các fix cho OpenCode & Kimi & Claude: `ef4679dfa`, `468aa7d9e`, `59e9b5264`, `c86443689`, `e964e4826`, `5bdcd5e76`, `3125ac2bd`, `1d4335d44`.
- Port fix combo & headroom: `8f4e38007`, `db81a8c9f`.

### Giai đoạn 2: Model Capabilities & Antigravity Updates (Ưu tiên số 2)
- Port Claude Sonnet 5.5 & Opus 5.5 cho Antigravity: `a07ed95be`.
- Port Gemini 4 Argon: `29fc880ec`, `9c1419100`, `eb3730170`.
- Cập nhật Antigravity catalog & bump version 2.22.0: `24034f69c`, `cff2b1d97`.
- Cập nhật GLM-5.3 context 1M & capabilities Claude PDF: `0f7f6e72a`, `c61ee37dd`, `f5f880394`.
- Dọn dẹp Codex gpt-5.5 đã retired: `7878f53ba`.

### Giai đoạn 3: UI, CLI & Tools Enhancements (Ưu tiên số 3)
- Model Picker regex search & batch select: `da1756a82`.
- Auto-ping schedule & timezone: `be51142b4`, `28d401596` (chú ý adapt vào dashboard split của fork).
- Hermes profile & STT transcription: `a9c9f6836`, `d6431f8b7`.
- CLI connect & show: `8a90d3c9d`, `b677bfce3`.
- Dashboard UX & Mobile fixes: `eea082157`, `2d94d3ab8`, `d95bb8ea2`.

### Giai đoạn 4: New Providers (Ưu tiên số 4 - Khối lượng lớn)
- MiniMax Code credits provider: `85bc33cea`.
- Nous Research provider: `165f9b90a`, `90f89471c`.
- ElevenLabs Scribe STT: `2f827bcf7`.
- Cloudflare AI clef-flash: `d2f901775`.
- Netlify relay pool: `4fa46034a`.
- AWS Bedrock provider: `a9d0ad269` (Đặc biệt thận trọng: tách EventStream mà không làm mất split thinking-tag buffering của Kiro, và cập nhật provider constants theo kiến trúc modular).

### Giai đoạn 5: API Key Access Control (Ưu tiên số 5 - Cần migration SQLite)
- Key Access Control: `d8c585fb7` (Tích hợp vào `src/lib/db/` SQLite repository).
