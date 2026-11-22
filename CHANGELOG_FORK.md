# Fork changelog

## 2026-10-12 — Fix Antigravity 404/429 khi gọi Gemini 3.7 Flash và đồng bộ với Cursor BYOK

### Vấn đề

User gặp lỗi `[404]: { "error": { "code": 404, "message": "Requested entity was not found.", "status": "NOT_FOUND" } }` khi gọi `gemini-3.7-flash` qua provider Antigravity, trong khi plugin Antigravity bên Cursor BYOK vẫn gọi thành công.

### Root cause

1. **Model Tiering trên Google CloudCode PA API:** Google API hiện tại không còn chấp nhận model base không tier (`gemini-3.7-flash`) cũng như model alias `-tiered` (`gemini-3.7-flash-tiered`) mà trả về HTTP 404. API chỉ chấp nhận các tier tường minh: `gemini-3.7-flash-high`, `gemini-3.7-flash-medium`, `gemini-3.7-flash-low`.
2. **Sai lệch Model Aliases cũ:** Trong `open-sse/providers/antigravity-provider-metadata.js`, `ANTIGRAVITY_MODEL_ALIASES` trước đây tự ép `gemini-3.7-flash-high/medium/low` về `gemini-3.7-flash-tiered` (dẫn tới 404). Khi gọi `gemini-3.7-flash` trần, 9router thiếu alias nên gửi nguyên model id lên upstream (cũng bị 404).
3. **Thiếu mapping trong MITM:** `src/mitm/config.js` thiếu `gemini-3.7-flash` trong `MODEL_SYNONYMS.antigravity`, khiến request qua MITM bị regex fallback sang model khác.
4. **Thiếu header và credit type:** Payload chưa có `enabledCreditTypes: ["GOOGLE_ONE_AI"]`, thiếu header `Anthropic-Beta` cho các model Claude qua Antigravity, và thiếu failover URL khi gặp 404.

### Fix

- **File:** `open-sse/providers/antigravity-provider-metadata.js`
  - Map `gemini-3.7-flash` và `gemini-3.7-flash-thinking` -> `gemini-3.7-flash-high`.
  - Giữ nguyên các model tier `gemini-3.7-flash-high`, `-medium`, `-low` và `gemini-3.6-flash-high`, `-medium`, `-low` (bỏ alias sang `-tiered`).
  - Thêm alias Claude: `claude-3-7-sonnet` / `claude-3-5-sonnet` / `claude-3-5-haiku` -> `claude-sonnet-4-6`, `claude-3-7-opus` -> `claude-opus-4-6-thinking`.
  - Cập nhật `ANTIGRAVITY_STATIC_MODELS` tương ứng.
- **File:** `open-sse/executors/antigravity.js`
  - Thêm `enabledCreditTypes: ["GOOGLE_ONE_AI"]` vào payload `transformRequest`.
  - Thêm failover sang URL kế tiếp trong `ANTIGRAVITY_BASE_URLS` khi gặp HTTP 404.
  - Gắn header `Anthropic-Beta` khi gọi các model Claude qua Antigravity.
- **File:** `src/mitm/config.js`
  - Thêm `gemini-3.7-flash` và `gemini-3.6-flash` vào `MODEL_SYNONYMS.antigravity`.
- **Files:** `tests/unit/antigravity-executor.test.js`, `tests/unit/antigravity-provider-metadata.test.js`
  - Bổ sung unit tests cho `enabledCreditTypes`, `Anthropic-Beta`, failover khi 404 và alias metadata.

### Verification

- Vitest Antigravity suite (`antigravity-schema-ref`, `antigravity-executor`, `antigravity-stream-resume`, `bugs-antigravity`, `antigravity-provider-metadata`): **5 files passed**, **57 tests passed**.
- Live E2E test gọi trực tiếp Google CloudCode API qua `AntigravityExecutor` trả về **HTTP 200** với stream thoughtSignature hợp lệ cho `gemini-3.7-flash`, `gemini-3.7-flash-thinking`, `gemini-3.7-flash-high` và `claude-3-7-sonnet`.

---

## Sau sync upstream — Hoàn thiện regression và dashboard hydration

### Regression theo contract của fork

- **Antigravity:** test metadata, discovery và executor xác nhận thứ tự failover chat `daily-cloudcode-pa.googleapis.com` → `cloudcode-pa.googleapis.com`. Discovery/onboarding vẫn dùng PROD; chat bắt đầu ở daily để giảm 429 và chỉ chuyển PROD khi cần.
- **Codex remote image:** fixture regression dùng JPEG magic bytes hợp lệ. Điều này khớp cơ chế hardening của fork: chỉ inline base64 khi remote payload qua SSRF guard, giới hạn kích thước và xác thực image signature; payload không hợp lệ tiếp tục giữ URL gốc.
- **SAML:** chuyển test helper từ `node:test` sang Vitest để full suite nhận diện đúng test file.
- **CLI package:** `cli/scripts/build-cli.js` chỉ thực thi build khi được gọi trực tiếp; export helper copy/merge/validate artifacts để test được mà không vô tình chạy `next build` hay tranh chấp build lock.

### Dashboard console log

- **File:** `src/app/(dashboard)/dashboard/console-log/ConsoleLogClient.js`
  - Render đầu tiên luôn dùng view `feed` trên cả SSR và client.
  - Chỉ khôi phục view đã lưu trong `localStorage` sau hydration, tránh server render feed nhưng client render terminal/table ngay từ lượt đầu.

### Verification

- Full Vitest suite: **207 files passed**, **2079 tests passed**.
- `git diff --check` passed.

---

## 2026-08-06 — Fix Kiro `REQUEST_BODY_INVALID` với Claude CLI → Kiro/auto

### Vấn đề

User gặp lỗi `REQUEST_BODY_INVALID` khi chat từ Claude CLI với model `kiro/auto`. Error xảy ra tương tự bug đã fix ngày 2026-08-05 nhưng ở translator route khác.

### Root cause

Translator `claude-to-kiro.js` (direct route, không pivot qua OpenAI) vẫn serialize `systemPrompt` vào top-level payload. Kiro server từ chối schema này với `REQUEST_BODY_INVALID`.

### Fix

- **File:** `open-sse/translator/request/claude-to-kiro.js`
  - Không serialize `systemPrompt` vào outgoing payload (dùng `Object.defineProperty` với `enumerable: false`).
  - Giữ `systemPrompt` dưới dạng metadata cho session replay compatibility.
  - System prompt đã được prepend vào replayed conversation content.

### Verification

- Node test: `systemPrompt` không xuất hiện trong `Object.keys()` và `JSON.stringify()` nhưng vẫn accessible qua property access.
- Regression: 43/43 OpenAI-to-Kiro tests passed (pattern tương tự).

---

## 2026-08-05 — Fix Kiro `REQUEST_BODY_INVALID` với thinking/agentic models

### Vấn đề

User `elza36890922` gặp lỗi `REQUEST_BODY_INVALID` khi dùng `kiro-combo → kiro/claude-sonnet-4.5-thinking` qua OpenAI Responses format với 10 messages, 22 tools và `max_output_tokens: 65536`.

### Root cause

Translator `openai-to-kiro.js` tự động thêm top-level field `systemPrompt` vào payload Kiro cho thinking/agentic variants. Kiro server từ chối schema này và trả về `REQUEST_BODY_INVALID`.

### Fix

- **File:** `open-sse/translator/request/openai-to-kiro.js`
  - Không serialize `systemPrompt` vào outgoing payload (dùng `Object.defineProperty` với `enumerable: false`).
  - Giữ `systemPrompt` dưới dạng metadata cho session replay compatibility.
  - System prompt đã được prepend vào replayed conversation content, không cần gửi riêng field này lên provider wire.

- **File:** `tests/unit/openai-to-kiro.test.js`
  - Thêm assertion xác nhận `systemPrompt` không xuất hiện trong `Object.keys()` và `JSON.stringify()`.
  - Verify thinking mode tags vẫn xuất hiện trong conversation content.

### Verification

- Local dev `localhost:20127`: cả `kr/claude-sonnet-4.5-agentic` và `kr/claude-sonnet-4.5-thinking` đều trả `200 OK`.
- Regression tests: 79/79 Kiro canonical translator tests passed.
- Production server `localhost:20128` với real API key cũng hoạt động bình thường.

---

## 2026-08-04 — Merge upstream into `sync-upstream`

### Upstream integration

- Đồng bộ registry, model catalog, executor và OAuth provider modules; bổ sung các provider/flow mới gồm CodeBuddy Intl, Devin CLI, Trae, Windsurf và Zed.
- Tách OAuth provider implementations theo module, cập nhật callback/proxy UI và server routing; giữ tương thích các refresh export cũ.
- Cập nhật provider usage, fetch, embeddings, search, tunnel PID ownership, dashboard quota rendering và provider assets/i18n.
- Cập nhật Antigravity daily chat transport, model metadata và signed tool continuation; discovery/onboarding vẫn dùng PROD endpoint.
- Cập nhật Kiro model/routing/session architecture, canonical conversation replay, endpoint-aware headers/profile ARN và bounded retry behavior.

### Fork behavior preserved and repaired

- **Grok CLI quota:** giữ đủ ba request `billing?format=credits`, `billing` và `user?include=subscription`; merge quota giữ free-tier unknown bars, monthly currency format và pay-as-you-go. Khi credits billing fail-open, `onDemandCap` từ plain billing vẫn quyết định đúng trạng thái pay-as-you-go.
- **SQLite backup:** giữ backup analytics dưới dạng SQLite snapshot và các route/service compatibility liên quan.
- **Antigravity thinking:** giữ cap 16,384 cho request thường, tối đa 65,535 cho thinking phù hợp; giữ buffering `part.thought` và signed tool continuation.
- **Kiro thinking stream:** giữ xử lý tag `<thinking>` bị chia frame, phát `reasoning_content`, không phát content rỗng và flush phần tag còn lại khi EOF.
- **Kiro contracts:** giữ agentic prompt, fingerprint/detection, endpoint/API-key routing, profile ARN, suffix/override model và canonical history/session replay.
- **Codex:** giữ proactive token auto-refresh trước hạn 2 ngày.
- **Dashboard:** Round Robin hiển thị số account đang enabled theo `isActive !== false`; quota UI giữ unknown/currency rows ở trạng thái trung tính.
- **Token refresh:** khôi phục public re-export `refreshKimiToken` từ module đang sở hữu implementation.

### Validation

- Alias contract: 164 aliases unchanged.
- Provider contract: 96 providers unchanged.
- OAuth URL contract: 14 providers unchanged.
- Aggregate regression baseline: 0 unapproved failures.
- Focused fork contract, SQLite snapshot, Responses output index và Kiro stream suites đều pass.

> `CHANGELOG_FORK.md` là ghi chú local/untracked của fork và không thuộc merge commit.