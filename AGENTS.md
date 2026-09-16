# Merge Invariants

## Grok CLI quota tracking

`open-sse/services/usage/grok-cli.js` intentionally uses the fork's verified three-request quota flow:

1. `GET /v1/billing?format=credits` for weekly/API usage and pay-as-you-go data.
2. `GET /v1/billing` for monthly credits.
3. `GET /v1/user?include=subscription` for plan identity.

Merge all three responses with `buildMergedGrokQuotas`. Do **not** replace this with upstream single-shape/single-billing parsing, conditional endpoint fetching, or a provider-specific quota format unless a captured Grok CLI payload and regression tests prove compatibility.

### SuperGrok vs free allotment (CLIProxyAPI-style UI)

- **SuperGrok / paid allotment**: emit percent bars only when the API returns finite fields:
  - Weekly limit ← `creditUsagePercent` (0 is valid)
  - Api usage ← `productUsage[].usagePercent` (finite only)
  - Monthly credits ← plain `monthlyLimit` / `used` when total > 0
- **Do not invent** Weekly `0/100 @ 100%` from bare `currentPeriod` without `creditUsagePercent` (free accounts look "full" incorrectly).
- **Free / no SuperGrok allotment** (live shape: credits has `currentPeriod` + zeros, no percent fields; plain `monthlyLimit=0`/`used=0`): set `noCreditAllotment` and still render **two empty bars** like CLIProxyAPI:
  - Weekly limit → `unknown: true` → UI label `Used --` + reset from `currentPeriod.end`
  - Monthly credits → `unknown: true`, `format: "currency"` → UI `$0.00 / $0.00` + billing period end
- Always surface **`payAsYouGo`** (`Enabled` / `Disabled` from `onDemandCap > 0`) for Grok-cli/xai cards; dashboard wires it through `use-provider-limits` + `provider-connection-card`.
- Free usage is a **rolling 24h** window at runtime (`subscription:free-usage-exhausted`); billing endpoints do not return free %.

Dashboard helpers: `formatQuotaUsageLabel` / `getRemainingPercentage` in
`src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js` and
`QuotaTable.js` must preserve `unknown` + `format` so free bars stay empty/neutral
(not red 0% or green 100%).

Before accepting upstream changes to this flow, run:

```bash
cd tests
npx vitest run unit/grokBilling.test.js unit/grok-cli-executor.test.js unit/grok-cli-models.test.js unit/provider-quota-visibility.test.js unit/quota-auto-ping.test.js
```

`tests/unit/grokBilling.test.js` protects the captured two-billing-shape merge, free-tier unknown bars (no fake 100%), and fail-open behavior.

## SQLite backup export

The local backup flow exports analytics as SQLite snapshots rather than the older
JSON/download-only shape. Preserve the database route, backup service, dashboard
profile flow, and compatibility exports together; do not restore the removed
`profileDownloadUtils.js` path or reduce a snapshot to a partial JSON export.

Before accepting upstream changes to backup/export behavior, run:

```bash
cd tests
npx vitest run unit/database-backup-route.test.js unit/db-sqlite-vs-lowdb.test.js
```

## Antigravity thinking, schema dereferencing, and tool continuations

Antigravity has local protocol and translation safeguards that must be kept as one behavior:

1. Keep ordinary `generationConfig.maxOutputTokens` capped at `16384`, but permit
   active medium/high or extended thinking to use up to `65535`. A universal
   `16384` final cap can exhaust provider thought output and expose incomplete
   self-talk at `max_tokens`.
2. Treat `part.thought === true` as reasoning. For Antigravity only, buffer
   otherwise-unmarked text until a signed tool-call boundary or terminal result
   establishes whether it is visible text; drop that pending text before a signed
   tool continuation, but preserve signed visible text and genuine final answers.
3. **JSON Schema dereferencing & type protection**: `cleanJSONSchemaForAntigravity` in
   `open-sse/translator/helpers/geminiHelper.js` and `open-sse/translator/formats/gemini.js`
   must dereference internal JSON Pointers (`#/properties/…`, `#/$defs/…`, `#/definitions/…`)
   before removing unsupported keywords, convert `prefixItems` to `items`, enforce explicit
   fallback types for untyped properties/items, and insert a `{ reason: { type: "string" } }`
   placeholder for empty object schemas. Unresolved `$ref` or missing `type` fields trigger
   immediate `400 INVALID_ARGUMENT` rejections from the Antigravity endpoint.
4. **Strict alternating role normalization**: `normalizeGeminiContents` must never merge
   a `functionResponse` turn with a follow-up plain text `user` turn in the same message.
   When consecutive same-role turns cannot be merged, insert a synthetic bridge turn
   (`{ role: "model", parts: [{ text: "..." }] }`) to maintain strict alternating
   `user -> model -> user` turns and avoid `400 INVALID_ARGUMENT`.

Do not replace this with signature-only filtering: a `thoughtSignature` without
`thought: true` can accompany visible text and is required for tool continuity.
Keep the non-streaming, resumed-stream, and Gemini-to-OpenAI paths aligned.

Before accepting upstream changes to this flow, run:

```bash
cd tests
npx vitest run unit/antigravity-schema-ref.test.js unit/antigravity-executor.test.js unit/antigravity-stream-resume.test.js translator/bugs-antigravity.test.js
```

## OpenAI Responses output indexes

Both Responses conversion paths must allocate one stable, unique `output_index`
per output item across a response: reasoning, every assistant message, and every
function call. Do not derive indexes independently from the upstream choice index
or tool index; that creates duplicate indexes when a response contains reasoning,
text, and tools.

Keep `open-sse/transformer/responsesTransformer.js` and
`open-sse/translator/response/openai-responses.js` behaviorally synchronized.

Before accepting upstream changes to this flow, run:

```bash
cd tests
npx vitest run unit/responses-output-indexes.test.js translator/bugs-antigravity.test.js
```

## Dashboard provider round-robin label

The provider connections toolbar displays the configured round-robin count as the
actual number of enabled accounts. Preserve the local count rendering when syncing
upstream dashboard changes; do not replace it with an unrelated aggregate or omit
it from the provider toolbar.

## Kiro thinking stream (split tags → reasoning_content)

Live Kiro EventStream often emits thinking as text tags inside
`assistantResponseEvent`, with the open tag **split across frames**
(`"<thinking"` then `">…"`). A whole-token strip of `"<thinking>"` only will
leak tags into `delta.content` and never produce client-visible reasoning.

`open-sse/executors/kiro.js` must keep this fork behavior as one unit:

1. Carry partial open/close tag prefixes across frames (`splitKiroThinkingText` +
   `thinkingTagPending`).
2. Surface the thinking body as OpenAI `delta.reasoning_content` (also keep
   native `reasoningContentEvent` → `reasoning_content`).
3. Emit visible `content` only when non-empty after strip (no empty-content flood
   while thinking).
4. Flush any leftover tag carry on clean stream EOF.

Do **not** restore “strip tags and discard body” or match only the full
`"<thinking>"` token without a partial-tag buffer. Downstream Responses /
Claude paths already map `reasoning_content` → reasoning summary / thinking
blocks; losing the intermediate field breaks all client formats.

Before accepting upstream changes to this flow, run:

```bash
cd tests
npx vitest run unit/kiro-thinking-strip.test.js unit/kiro-buffer-boundary.test.js unit/kiro-fused-objecthandoff.test.js
```

`tests/unit/kiro-thinking-strip.test.js` protects the live split-tag shape and
re-emit as `reasoning_content`. Optional live check (needs local server + API
key):

```bash
RUN_REAL=1 REAL_BASE_URL=http://localhost:20127/v1 REAL_API_KEY=sk-... \
  npx vitest run --config tests/vitest.config.js tests/translator/real/kiro-thinking-stream.live.test.js
```

## Fork structure and upstream merge map

This fork deliberately decomposes several upstream monolithic dashboard and
service areas. When bringing in upstream work, port a behavior through the
existing local boundaries instead of replacing a page, hook, or card wholesale.
Read the affected local contract and its tests before resolving a conflict.

### Provider dashboard: split detail-page composition

The provider detail view is intentionally split across:

- `src/app/(dashboard)/dashboard/providers/[id]/page.js` — route-level state and
  orchestration.
- `src/app/(dashboard)/dashboard/providers/[id]/hooks/` — connection mutations,
  filters, strategy persistence, and provider-specific actions.
- `src/app/(dashboard)/dashboard/providers/[id]/components/ProviderConnectionsCard.js`
  — composition boundary.
- `components/ProviderConnectionsToolbar.js`, `ProviderConnectionsSummary.js`,
  and `ProviderConnectionsList.js` — isolated UI sections.

Keep the enabled-account count passed as `enabledConnectionsCount`; it is the
round-robin count shown by the toolbar. Do not replace these files with an
upstream monolithic provider page or the older shared
`dashboard/providers/components/ConnectionsCard.js` implementation. Port only
the required behavior into the split hook/component that owns it.

### Usage dashboard: local quota component stack

Quota UI is split under
`src/app/(dashboard)/dashboard/usage/components/ProviderLimits/`:

- `index.js` renders the page composition only.
- `hooks/local/use-provider-limits.js` owns fetch, refresh, filters, pagination,
  and mutations.
- `components/local/provider-connection-card.js` renders a connection.
- `QuotaTable.js` and `utils.js` render quota states and preserve `unknown` /
  `format` metadata.

Do not import an upstream dashboard usage page as a replacement. Merge quota
fields end-to-end: usage service -> limits hook -> connection card ->
`QuotaTable`. In particular, retain Grok free-tier neutral bars and
`payAsYouGo` described above.

### SQLite database and backup boundaries

The fork's SQLite implementation is layered as follows:

- `src/lib/localDb.js` and other legacy `src/lib/*Db.js` modules are compatibility
  shims; keep their public exports stable.
- `src/lib/db/` owns SQLite drivers, migrations, repositories, and snapshot
  implementation. `src/lib/db/backup.js` validates and imports/exports full
  snapshots.
- `src/app/api/settings/database/route.js` is the authenticated streaming
  snapshot download/upload route.
- `src/app/(dashboard)/dashboard/profile/hooks/useProfileSettings.js` and
  `components/ProfileLocalBackupCard.js` own the dashboard flow.

Never replace this stack with upstream JSON-only export helpers. Preserve the
SQLite file content type, streamed response cleanup, import limits, validation,
and the compatibility shims together.

### Provider protocol seams

Keep provider-specific behavior at its existing seam:

- **Grok CLI:** `open-sse/services/usage/grok-cli.js` owns its three-request
  quota merge. Dashboard formatting belongs in the ProviderLimits stack, not in
  the executor.
- **Antigravity:** `open-sse/executors/antigravity.js` contains output-token and
  signed-thought continuation safeguards; its supporting persisted signatures
  are in `open-sse/services/thoughtSignatureStore.js`. Schema dereferencing & type
  enforcement live in `open-sse/translator/helpers/geminiHelper.js` / `formats/gemini.js`.
  Response translation must stay aligned with `open-sse/translator/response/gemini-to-openai.js`.
- **Kiro:** `open-sse/executors/kiro.js` owns binary EventStream decoding and
  split thinking-tag buffering. Do not move this behavior into a generic text
  translator.
- **Qoder:** resolve PAT, OAuth refresh, and credential normalization only via
  `resolveQoderCredentials()` in `open-sse/services/qoderModels.js`. Executors
  and usage services must not recreate local PAT/job-token flows.
- **OpenAI Responses:** keep the unique output-index allocator synchronized in
  `open-sse/transformer/responsesTransformer.js` and
  `open-sse/translator/response/openai-responses.js`.

For translator updates, retain the pipeline `source -> openai -> target` and
`target -> openai -> source`; prefer an already-registered direct route for
fragile formats rather than adding logic to an unrelated executor.

### Security and model API contracts

- `src/shared/utils/ssrfGuard.js` owns URL validation, DNS checks, and safe
  redirect handling. Call `fetchPublic()` for code that fetches a user-controlled
  URL; do not use native auto-follow redirects after validating only the first
  URL.
- `src/sse/handlers/fetch.js` validates user-provided web-fetch targets before
  provider dispatch. `open-sse/handlers/fetch/index.js` sends requests to trusted
  configured provider endpoints and must keep timeout/header behavior separate
  from target validation.
- `src/app/api/v1/models/route.js` owns `buildModelsList()` and
  `filterModelsForApiKey()`. Both `models/[kind]/route.js` and the catch-all
  `models/[...model]/route.js` must apply API-key filtering before exposing a
  list or single model. The catch-all route exists because provider-prefixed IDs
  contain `/`; retain capability-list behavior for its single-segment kinds.

### Merge procedure for fork-owned areas

1. Identify the local owner from this map before accepting an upstream hunk.
2. Compare behavior and tests, then port the smallest compatible change into
   the local split module.
3. Keep API response shapes, compatibility shims, and cross-layer metadata
   intact; do not use comments or dead JSX to disable upstream code.
4. Add or update a focused regression test for each local invariant touched.
5. Run the invariant command in the relevant section plus `git diff --check`.
6. Before committing, run `npm ci --dry-run --ignore-scripts` whenever
   `package.json` changes, and run `npm run build` when App Router routes,
   dashboard composition, or Docker runtime behavior changes.
