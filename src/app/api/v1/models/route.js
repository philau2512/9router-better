import {
  PROVIDER_MODELS,
  PROVIDER_ID_TO_ALIAS,
} from "@/shared/constants/models";
import {
  AI_PROVIDERS,
  getProviderAlias,
  isAnthropicCompatibleProvider,
  isOpenAICompatibleProvider,
} from "@/shared/constants/providers";
import {
  getProviderConnections,
  getCombos,
  getCustomModels,
  getModelAliases,
} from "@/lib/localDb";
import { getDisabledModels } from "@/lib/disabledModelsDb";
import { resolveKiroModels } from "open-sse/services/kiroModels.js";
import { resolveKimchiModels } from "open-sse/services/kimchiModels.js";

import { resolveQoderModels, routableQoderModels } from "open-sse/services/qoderModels.js";
import { resolveOpenCodeModels } from "open-sse/services/opencodeModels.js";
import { resolveCopilotModels } from "open-sse/services/copilotModels.js";
import { resolveClinepassModels, resolveClineModels } from "open-sse/services/clinepassModels.js";
import { resolveCodexModels } from "open-sse/services/codexModels.js";
import { resolveAntigravityModels } from "open-sse/services/antigravityModels.js";

import { resolveGrokCliModels } from "open-sse/services/grokCliModels.js";
import { resolveCursorModels } from "open-sse/services/cursorModels.js";
import { resolveZedModels } from "open-sse/shared/zedAuth.js";
import { updateProviderCredentials } from "@/sse/services/tokenRefresh";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { requireValidApiKey } from "@/sse/services/api-key-validation.js";
import {
  filterApiKeyAccessibleModels,
} from "@/sse/services/api-key-access.js";
import { getComboModels, getModelInfo } from "@/sse/services/model.js";
import { PROVIDERS } from "open-sse/config/providers.js";

// Per-provider live model resolvers. Each receives a connection record and
// returns { models: [{ id, name? }, ...] } | null on failure.
// Adding a provider here makes /v1/models prefer the live catalog for it.
const LIVE_MODEL_RESOLVERS = {
  kiro: async (conn) => {
    const resolvedProxy = await resolveConnectionProxyConfig(
      conn.providerSpecificData || {},
    );
    const result = await resolveKiroModels(
      {
        accessToken: conn.accessToken,
        refreshToken: conn.refreshToken,
        expiresAt: conn.expiresAt || null,
        providerSpecificData: conn.providerSpecificData || {},
      },
      {
        log: console,
        proxyOptions: resolvedProxy,
        onCredentialsRefreshed: async (refreshed) => {
          if (refreshed?.accessToken) {
            await updateProviderCredentials(conn.id, {
              accessToken: refreshed.accessToken,
              refreshToken: refreshed.refreshToken || conn.refreshToken,
              expiresIn: refreshed.expiresIn,
            });
            conn.accessToken = refreshed.accessToken;
            if (refreshed.refreshToken)
              conn.refreshToken = refreshed.refreshToken;
          }
        },
      },
    );
    return result?.models?.length ? { models: result.models } : null;
  },
  qoder: async (conn) => {
    const result = await resolveQoderModels({
      accessToken: conn.accessToken,
      // PAT (pt-...) connections keep the token in apiKey; without it the live
      // catalog silently fails and /v1/models falls back to the static list.
      apiKey: conn.apiKey,
      refreshToken: conn.refreshToken,
      email: conn.email,
      displayName: conn.displayName,
      providerSpecificData: conn.providerSpecificData || {},
    });

    // Visible + hidden (enable:false) catalog keys — chat routes all of them.
    const models = routableQoderModels(result);
    if (!models.length) return null;
    return { models: models.map((m) => ({ id: m.id, name: m.name })) };
  },
  kimchi: async (conn) => {
    const result = await resolveKimchiModels(
      {
        accessToken: conn.accessToken,
        apiKey: conn.apiKey,
        providerSpecificData: conn.providerSpecificData || {},
      },
      { log: console },
    );
    return result?.models?.length ? { models: result.models } : null;
  },
  "grok-cli": async (conn) => {
    const proxyOptions = await resolveConnectionProxyConfig(
      conn.providerSpecificData || {},
    );
    const result = await resolveGrokCliModels(
      { ...conn, connectionId: conn.id },
      {
        log: console,
        proxyOptions,
        onCredentialsRefreshed: async (refreshed) => {
          await updateProviderCredentials(conn.id, {
            ...refreshed,
            existingProviderSpecificData: conn.providerSpecificData || {},
          });
        },
      },
    );
    return result?.models?.length ? { models: result.models } : null;
  },
  // noAuth provider — conn is synthetic, fetch live free-tier catalog instead
  opencode: async (_conn) => resolveOpenCodeModels(),
  // GitHub Copilot — fetch live model catalog from Copilot /models endpoint
  github: async (conn) => {
    const result = await resolveCopilotModels(
      {
        accessToken: conn.accessToken,
        refreshToken: conn.refreshToken,
        providerSpecificData: conn.providerSpecificData || {},
      },
      {
        log: console,
        onCredentialsRefreshed: async (refreshed) => {
          await updateProviderCredentials(conn.id, {
            copilotToken: refreshed.copilotToken,
            copilotTokenExpiresAt: refreshed.copilotTokenExpiresAt,
            existingProviderSpecificData: conn.providerSpecificData || {},
          });
        },
      },
    );
    return result?.models?.length ? { models: result.models } : null;
  },
  clinepass: async (conn) => {
    const result = await resolveClinepassModels({
      accessToken: conn.accessToken,
      apiKey: conn.apiKey,
    });
    return result?.models?.length ? { models: result.models } : null;
  },

  // Codex (OpenAI) — live catalog from chatgpt.com/backend-api/codex/models.
  // Falls back to static PROVIDER_MODELS["cx"] on any failure (resolver → null).
  codex: async (conn) => {
    const resolvedProxy = await resolveConnectionProxyConfig(
      conn.providerSpecificData || {},
    );
    const result = await resolveCodexModels(
      {
        accessToken: conn.accessToken,
        providerSpecificData: conn.providerSpecificData || {},
        connectionId: conn.id,
      },
      { log: console, proxyOptions: resolvedProxy },
    );
    return result?.models?.length ? { models: result.models } : null;
  },
  cline: async (conn) => {
    const result = await resolveClineModels({
      accessToken: conn.accessToken,
      apiKey: conn.apiKey,
    });
    return result?.models?.length ? { models: result.models } : null;
  },
  "grok-cli": async (conn) => {
    const proxyOptions = await resolveConnectionProxyConfig(
      conn.providerSpecificData || {},
    );
    const result = await resolveGrokCliModels(
      { ...conn, connectionId: conn.id },
      {
        log: console,
        proxyOptions,
      },
    );
    return result?.models?.length ? { models: result.models } : null;
  },
  // Antigravity — live catalog from cloudcode-pa fetchAvailableModels.
  // Falls back to static PROVIDER_MODELS["ag"] on any failure (resolver → null).
  antigravity: async (conn) => {
    const resolvedProxy = await resolveConnectionProxyConfig(
      conn.providerSpecificData || {},
    );
    const result = await resolveAntigravityModels(
      {
        accessToken: conn.accessToken,
        providerSpecificData: conn.providerSpecificData || {},
        connectionId: conn.id,
      },
      { log: console, proxyOptions: resolvedProxy },
    );
    return result?.models?.length ? { models: result.models } : null;
  },
  cursor: async (conn) => {
    const result = await resolveCursorModels({
      accessToken: conn.accessToken,
      providerSpecificData: conn.providerSpecificData || {},
    }, { log: console });
    return result?.models?.length ? { models: result.models } : null;
  },
  zed: async (conn) => {
    const result = await resolveZedModels({
      accessToken: conn.accessToken,
      providerSpecificData: conn.providerSpecificData || {},
    });
    if (!result?.models?.length) return null;
    return {
      models: result.models
        .filter((m) => !m.isDisabled)
        .map((m) => ({
          id: m.id,
          name: m.name,
          capabilities: m.supportsTools ? { tools: true } : undefined,
        })),
    };
  },
};

const parseOpenAIStyleModels = (data) => {
  if (Array.isArray(data)) return data;
  return data?.data || data?.models || data?.results || [];
};

// Matches provider IDs that are upstream/cross-instance connections (contain a UUID suffix)
const UPSTREAM_CONNECTION_RE = /[-_][0-9a-f]{8,}$/i;

// LLM kind sentinel — combos/models with no explicit kind default to LLM
const LLM_KIND = "llm";

// Map per-model `type` field (in PROVIDER_MODELS) to service kind.
// Models without `type` are treated as LLM.
const MODEL_TYPE_TO_KIND = {
  image: "image",
  tts: "tts",
  embedding: "embedding",
  stt: "stt",
  imageToText: "imageToText",
};

function modelKind(model) {
  if (!model?.type) return LLM_KIND;
  return MODEL_TYPE_TO_KIND[model.type] || LLM_KIND;
}

// For dynamic/unknown model IDs (compatible providers, alias map, custom models)
// fall back to provider-level kind matching when per-model type is unavailable.
function inferKindFromUnknownModelId(modelId) {
  const lower = String(modelId).toLowerCase();
  if (/embed/.test(lower)) return "embedding";
  if (/tts|speech|audio|voice/.test(lower)) return "tts";
  if (/image|imagen|dall-?e|flux|sdxl|sd-|stable-diffusion/.test(lower))
    return "image";
  return LLM_KIND;
}

async function fetchCompatibleModelIds(connection) {
  if (!connection?.apiKey) return [];

  const baseUrl =
    typeof connection?.providerSpecificData?.baseUrl === "string"
      ? connection.providerSpecificData.baseUrl.trim().replace(/\/$/, "")
      : "";

  if (!baseUrl) return [];

  let url = `${baseUrl}/models`;
  const headers = {
    "Content-Type": "application/json",
  };

  if (isOpenAICompatibleProvider(connection.provider)) {
    headers.Authorization = `Bearer ${connection.apiKey}`;
  } else if (isAnthropicCompatibleProvider(connection.provider)) {
    if (url.endsWith("/messages/models")) {
      url = url.slice(0, -9);
    } else if (url.endsWith("/messages")) {
      url = `${url.slice(0, -9)}/models`;
    }
    headers["x-api-key"] = connection.apiKey;
    headers["anthropic-version"] = "2023-06-01";
    headers.Authorization = `Bearer ${connection.apiKey}`;
  } else {
    return [];
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(url, {
      method: "GET",
      headers,
      cache: "no-store",
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!response.ok) return [];

    const data = await response.json();
    const rawModels = parseOpenAIStyleModels(data);

    return Array.from(
      new Set(
        rawModels
          .map((model) => model?.id || model?.name || model?.model)
          .filter(
            (modelId) => typeof modelId === "string" && modelId.trim() !== "",
          ),
      ),
    );
  } catch {
    return [];
  }
}

// Provider matches kindFilter when its serviceKinds intersect the requested kinds.
// LLM is the default kind for providers missing serviceKinds.
function providerMatchesKinds(providerId, kindFilter) {
  const provider = AI_PROVIDERS[providerId];
  const kinds =
    Array.isArray(provider?.serviceKinds) && provider.serviceKinds.length > 0
      ? provider.serviceKinds
      : [LLM_KIND];
  return kindFilter.some((k) => kinds.includes(k));
}

// Combo matches kindFilter when its `kind` field is in the list.
// Combos with no kind are treated as LLM.
function comboMatchesKinds(combo, kindFilter) {
  const kind = combo?.kind || LLM_KIND;
  return kindFilter.includes(kind);
}

/**
 * Build OpenAI-format models list filtered by service kinds.
 * @param {string[]} kindFilter - List of service kinds to include (e.g. ["llm"], ["webSearch","webFetch"]).
 */
export async function buildModelsList(kindFilter) {
  let connections = [];
  try {
    connections = await getProviderConnections();
    connections = connections.filter((c) => c.isActive !== false);
  } catch (e) {
    console.log("Could not fetch providers, returning all models");
  }

  let combos = [];
  try {
    combos = await getCombos();
  } catch (e) {
    console.log("Could not fetch combos");
  }

  let customModels = [];
  try {
    customModels = await getCustomModels();
  } catch (e) {
    console.log("Could not fetch custom models");
  }

  let modelAliases = {};
  try {
    modelAliases = await getModelAliases();
  } catch (e) {
    console.log("Could not fetch model aliases");
  }

  let disabledByAlias = {};
  try {
    disabledByAlias = await getDisabledModels();
  } catch (e) {
    console.log("Could not fetch disabled models");
  }
  const isDisabled = (alias, modelId) =>
    Array.isArray(disabledByAlias[alias]) &&
    disabledByAlias[alias].includes(modelId);

  const activeConnectionByProvider = new Map();
  for (const conn of connections) {
    if (!activeConnectionByProvider.has(conn.provider)) {
      activeConnectionByProvider.set(conn.provider, conn);
    }
  }

  // Inject synthetic connection records for noAuth providers that have static
  // models but no stored DB connection (they never go through an auth flow so
  // they never appear in getProviderConnections). Real DB connections always
  // take precedence — we only inject when the provider is absent from the map.
  for (const [providerId, providerConfig] of Object.entries(PROVIDERS)) {
    if (!providerConfig.noAuth) continue;
    if (activeConnectionByProvider.has(providerId)) continue;
    const alias = PROVIDER_ID_TO_ALIAS[providerId] || providerId;
    const staticModels = PROVIDER_MODELS[alias] || [];
    if (staticModels.length === 0) continue;
    activeConnectionByProvider.set(providerId, {
      provider: providerId,
      isActive: true,
      accessToken: null,
      apiKey: null,
      providerSpecificData: {},
    });
  }

  const models = [];

  // Combos first (filtered by kind). Web combos expose `kind` so AI knows search vs fetch.
  for (const combo of combos) {
    if (!comboMatchesKinds(combo, kindFilter)) continue;
    const entry = {
      id: combo.name,
      object: "model",
      owned_by: "combo",
    };
    if (combo.kind === "webSearch" || combo.kind === "webFetch") {
      entry.kind = combo.kind;
    }
    models.push(entry);
  }

  if (connections.length === 0) {
    // DB unavailable -> return static models, filtered by per-model kind
    const aliasToProviderId = Object.fromEntries(
      Object.entries(PROVIDER_ID_TO_ALIAS).map(([id, alias]) => [alias, id]),
    );
    for (const [alias, providerModels] of Object.entries(PROVIDER_MODELS)) {
      const providerId = aliasToProviderId[alias] || alias;
      if (!providerMatchesKinds(providerId, kindFilter)) continue;
      for (const model of providerModels) {
        if (!kindFilter.includes(modelKind(model))) continue;
        if (isDisabled(alias, model.id)) continue;
        models.push({
          id: `${alias}/${model.id}`,
          object: "model",
          owned_by: alias,
        });
      }
    }

    for (const customModel of customModels) {
      if (!customModel?.id || (customModel.type && customModel.type !== "llm"))
        continue;
      // Custom models without active connection are LLM-only by current schema
      if (!kindFilter.includes(LLM_KIND)) continue;
      const providerAlias = customModel.providerAlias;
      if (!providerAlias) continue;

      const modelId = String(customModel.id).trim();
      if (!modelId) continue;

      models.push({
        id: `${providerAlias}/${modelId}`,
        object: "model",
        owned_by: providerAlias,
      });
    }
  } else {
    for (const [providerId, conn] of activeConnectionByProvider.entries()) {
      if (!providerMatchesKinds(providerId, kindFilter)) continue;

      const staticAlias = PROVIDER_ID_TO_ALIAS[providerId] || providerId;
      const outputAlias = (
        conn?.providerSpecificData?.prefix ||
        getProviderAlias(providerId) ||
        staticAlias
      ).trim();
      const providerModels = PROVIDER_MODELS[staticAlias] || [];
      const enabledModels = conn?.providerSpecificData?.enabledModels;
      const hasExplicitEnabledModels =
        Array.isArray(enabledModels) && enabledModels.length > 0;
      const isCompatibleProvider =
        isOpenAICompatibleProvider(providerId) ||
        isAnthropicCompatibleProvider(providerId);

      // Build kind lookup for static models so we can filter even when only IDs are exposed
      const staticModelKindById = new Map(
        providerModels.map((m) => [m.id, modelKind(m)]),
      );

      let rawModelIds = hasExplicitEnabledModels
        ? Array.from(
            new Set(
              enabledModels.filter(
                (modelId) =>
                  typeof modelId === "string" && modelId.trim() !== "",
              ),
            ),
          )
        : providerModels.map((model) => model.id);

      if (
        isCompatibleProvider &&
        rawModelIds.length === 0 &&
        !UPSTREAM_CONNECTION_RE.test(providerId)
      ) {
        rawModelIds = await fetchCompatibleModelIds(conn);
      }

      // Config-driven live catalog override (e.g. Kiro returns dynamic
      // -thinking/-agentic variants per account). On failure, fall back to
      // whatever rawModelIds already holds.
      const liveResolver = LIVE_MODEL_RESOLVERS[providerId];
      if (liveResolver && !hasExplicitEnabledModels) {
        try {
          const live = await liveResolver(conn);
          if (live?.models?.length) {
            rawModelIds = live.models.map((m) => m.id);
          }
        } catch (err) {
          console.log(
            `Live model fetch failed for ${providerId}: ${err?.message || err}`,
          );
        }
      }

      const modelIds = rawModelIds
        .map((modelId) => {
          if (modelId.startsWith(`${outputAlias}/`)) {
            return modelId.slice(outputAlias.length + 1);
          }
          if (modelId.startsWith(`${staticAlias}/`)) {
            return modelId.slice(staticAlias.length + 1);
          }
          if (modelId.startsWith(`${providerId}/`)) {
            return modelId.slice(providerId.length + 1);
          }
          return modelId;
        })
        .filter(
          (modelId) => typeof modelId === "string" && modelId.trim() !== "",
        );

      const customModelIds = customModels
        .filter((m) => {
          if (!m?.id || (m.type && m.type !== "llm")) return false;
          const alias = m.providerAlias;
          return (
            alias === staticAlias ||
            alias === outputAlias ||
            alias === providerId
          );
        })
        .map((m) => String(m.id).trim())
        .filter((modelId) => modelId !== "");

      const aliasModelIds = Object.values(modelAliases || {})
        .filter((fullModel) => {
          if (typeof fullModel !== "string" || !fullModel.includes("/"))
            return false;
          return (
            fullModel.startsWith(`${outputAlias}/`) ||
            fullModel.startsWith(`${staticAlias}/`) ||
            fullModel.startsWith(`${providerId}/`)
          );
        })
        .map((fullModel) => {
          if (fullModel.startsWith(`${outputAlias}/`)) {
            return fullModel.slice(outputAlias.length + 1);
          }
          if (fullModel.startsWith(`${staticAlias}/`)) {
            return fullModel.slice(staticAlias.length + 1);
          }
          if (fullModel.startsWith(`${providerId}/`)) {
            return fullModel.slice(providerId.length + 1);
          }
          return fullModel;
        })
        .filter(
          (modelId) => typeof modelId === "string" && modelId.trim() !== "",
        );

      const mergedModelIds = Array.from(
        new Set([...modelIds, ...customModelIds, ...aliasModelIds]),
      );

      for (const modelId of mergedModelIds) {
        // Resolve kind: prefer static metadata, otherwise infer from ID heuristics
        const kind =
          staticModelKindById.get(modelId) ||
          inferKindFromUnknownModelId(modelId);
        if (!kindFilter.includes(kind)) continue;
        if (
          isDisabled(outputAlias, modelId) ||
          isDisabled(staticAlias, modelId)
        )
          continue;

        models.push({
          id: `${outputAlias}/${modelId}`,
          object: "model",
          owned_by: outputAlias,
        });
      }

      // Merge sub-config models (TTS / embedding) that live on AI_PROVIDERS, not PROVIDER_MODELS
      const providerInfo = AI_PROVIDERS[providerId];
      const subConfigModels = [];
      if (
        kindFilter.includes("tts") &&
        Array.isArray(providerInfo?.ttsConfig?.models)
      ) {
        for (const m of providerInfo.ttsConfig.models) {
          if (m?.id) subConfigModels.push(m.id);
        }
      }
      if (
        kindFilter.includes("embedding") &&
        Array.isArray(providerInfo?.embeddingConfig?.models)
      ) {
        for (const m of providerInfo.embeddingConfig.models) {
          if (m?.id) subConfigModels.push(m.id);
        }
      }
      for (const subId of subConfigModels) {
        if (isDisabled(outputAlias, subId) || isDisabled(staticAlias, subId))
          continue;
        models.push({
          id: `${outputAlias}/${subId}`,
          object: "model",
          owned_by: outputAlias,
        });
      }

      // Web search/fetch — provider IS the model, expose as {alias}/search and/or {alias}/fetch with explicit kind
      if (kindFilter.includes("webSearch") && providerInfo?.searchConfig) {
        models.push({
          id: `${outputAlias}/search`,
          object: "model",
          kind: "webSearch",
          owned_by: outputAlias,
        });
      }
      if (kindFilter.includes("webFetch") && providerInfo?.fetchConfig) {
        models.push({
          id: `${outputAlias}/fetch`,
          object: "model",
          kind: "webFetch",
          owned_by: outputAlias,
        });
      }
    }
  }

  const dedupedModels = [];
  const seenModelIds = new Set();
  for (const model of models) {
    if (!model?.id || seenModelIds.has(model.id)) continue;
    seenModelIds.add(model.id);
    dedupedModels.push(model);
  }

  return dedupedModels;
}

export async function filterModelsForApiKey(request, models) {
  const auth = await requireValidApiKey(request);
  if (!auth.ok) {
    return { error: auth, data: null };
  }

  const data = await filterApiKeyAccessibleModels(
    auth.keyInfo,
    models,
    async (entry) => {
      const comboModels = await getComboModels(entry.id);
      const modelIds = comboModels || [entry.id];
      const targets = await Promise.all(modelIds.map((modelId) => getModelInfo(modelId)));
      return targets.filter((target) => target.provider);
    },
  );

  return { error: null, data };
}

/**
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

/**
 * GET /v1/models - OpenAI compatible models list (LLM/chat models only by default).
 * For other capabilities use /v1/models/{kind} (image, tts, stt, embedding, image-to-text, web).
 */
export async function GET(request) {
  try {
    const models = await buildModelsList([LLM_KIND]);
    const { error, data } = await filterModelsForApiKey(request, models);
    if (error) {
      return Response.json(
        { error: { message: error.message, type: "authentication_error", code: error.code } },
        { status: error.status, headers: { "Access-Control-Allow-Origin": "*" } },
      );
    }
    return Response.json(
      { object: "list", data },
      {
        headers: { "Access-Control-Allow-Origin": "*" },
      },
    );
  } catch (error) {
    console.log("Error fetching models:", error);
    return Response.json(
      { error: { message: error.message, type: "server_error" } },
      { status: 500 },
    );
  }
}
