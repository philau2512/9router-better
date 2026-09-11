"use client";

import { useState, useMemo, useEffect, useCallback } from "react";
import PropTypes from "prop-types";
import Modal from "./Modal";
import ProviderIcon from "./ProviderIcon";
import CapacityBadges from "./CapacityBadges";
import { getModelsByProviderId, getModelKind } from "@/shared/constants/models";
import { useModelCaps } from "@/shared/hooks/useModelCaps";
import {
  OAUTH_PROVIDERS,
  APIKEY_PROVIDERS,
  FREE_PROVIDERS,
  FREE_TIER_PROVIDERS,
  AI_PROVIDERS,
  isOpenAICompatibleProvider,
  isAnthropicCompatibleProvider,
  getProviderAlias,
} from "@/shared/constants/providers";
import {
  applyLiveCatalogToChips,
  parseProviderModelsPayload,
  pickFirstActiveConnectionByProvider,
} from "@/shared/utils/liveModelsForSelectModal";
import { filterActiveProvidersForModelSelect } from "@/shared/utils/modelSelectActiveProviders";

// Provider order: OAuth first, then Free Tier, then API Key (matches dashboard/providers)
const PROVIDER_ORDER = [
  ...Object.keys(OAUTH_PROVIDERS),
  ...Object.keys(FREE_PROVIDERS),
  ...Object.keys(FREE_TIER_PROVIDERS),
  ...Object.keys(APIKEY_PROVIDERS),
];

// Providers that need no auth — always show in model selector
const NO_AUTH_PROVIDER_IDS = Object.keys(FREE_PROVIDERS).filter(
  (id) => FREE_PROVIDERS[id].noAuth,
);

// Helper to clean up verbose model titles and extract structured badges
function parseModelDisplay(rawName, modelId, providerId) {
  if (!rawName) {
    return {
      title: modelId || "",
      credit: null,
      isThinking: false,
      isAgentic: false,
      isReview: false,
      isHigh: false,
    };
  }
  let name = rawName;

  // Strip provider name prefix if redundant (e.g. "Kiro Claude..." -> "Claude...")
  if (providerId === "kiro" && name.toLowerCase().startsWith("kiro ")) {
    name = name.slice(5).trim();
  }

  // Extract credit rate e.g. "(1.3x credit)" or "(0.4x credit)"
  let credit = null;
  const creditMatch = name.match(/\(([0-9.]+)x\s*credit\)/i);
  if (creditMatch) {
    credit = `${creditMatch[1]}x`;
    name = name.replace(creditMatch[0], "").trim();
  }

  // Check and extract capabilities / attributes
  const isThinking = /thinking/i.test(name) || /thinking/i.test(modelId || "") || /reason/i.test(modelId || "");
  const isAgentic = /agentic/i.test(name) || /agentic/i.test(modelId || "") || /agent/i.test(modelId || "");
  const isReview = /review/i.test(name) || /review/i.test(modelId || "");
  const isHigh = /high/i.test(name) || /high/i.test(modelId || "");

  // Clean verbose capability parentheses
  name = name
    .replace(/\(\s*thinking\s*\+\s*agentic\s*\)/gi, "")
    .replace(/\(\s*thinking\s*\)/gi, "")
    .replace(/\(\s*agentic\s*\)/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  return {
    title: name || modelId,
    credit,
    isThinking,
    isAgentic,
    isReview,
    isHigh,
  };
}

// Providers with per-account live catalogs via /api/providers/[id]/models.
// Static registry stays as fallback when live fetch fails or is empty.
const LIVE_CATALOG_PROVIDERS = ["cursor", "cline", "clinepass"];

// Fetch a provider's account-scoped catalog for every active connection and merge
// the results. Entries collapse by model id on purpose: two connections of the
// same provider produce the same picker value (`alias/id`), so keeping the first
// avoids duplicate rows. There is no per-connection metadata to preserve beyond
// {id,name}. Empty array means "nothing live" so callers keep the static fallback.
function useLiveProviderModels(isOpen, connectionIds, label) {
  const [models, setModels] = useState([]);
  const idsKey = (connectionIds ?? []).join("|");

  useEffect(() => {
    const ids = idsKey ? idsKey.split("|") : [];
    if (!isOpen || ids.length === 0) {
      return undefined;
    }

    let cancelled = false;
    Promise.all(ids.map(async (connectionId) => {
      const response = await fetch(`/api/providers/${connectionId}/models`, { cache: "no-store" });
      if (!response.ok) return [];
      const data = await response.json();
      return Array.isArray(data.models) ? data.models : [];
    }))
      .then((modelLists) => {
        if (cancelled) return;
        const seen = new Set();
        setModels(modelLists.flat().filter((model) => {
          if (!model?.id || seen.has(model.id)) return false;
          seen.add(model.id);
          return true;
        }));
      })
      .catch((error) => {
        // Do not hide the static fallback when the account catalog is unavailable.
        console.warn(`Unable to load ${label} models for selector:`, error);
        if (!cancelled) setModels([]);
      });

    return () => { cancelled = true; };
  }, [isOpen, idsKey, label]);

  return models;
}

export default function ModelSelectModal({
  isOpen,
  onClose,
  onSelect,
  onDeselect,
  selectedModel,
  activeProviders = [],
  title = "Select Model",
  modelAliases = {},
  kindFilter = null,
  capFilter = null,
  addedModelValues = [],
  closeOnSelect = true,
}) {
  // Drop disabled / delisted (e.g. iflow) / inactive custom connections before grouping.
  const filteredActiveProviders = useMemo(
    () =>
      filterActiveProvidersForModelSelect(activeProviders, { kindFilter }),
    [activeProviders, kindFilter],
  );
  const [searchQuery, setSearchQuery] = useState("");
  const [activeFilter, setActiveFilter] = useState("all");
  const [combos, setCombos] = useState([]);
  const [providerNodes, setProviderNodes] = useState([]);
  const [customModels, setCustomModels] = useState([]);
  const [disabledModels, setDisabledModels] = useState({});

  // null = live not settled yet (show static); object after settle (fail-open empty {})
  const [liveModelsByProviderId, setLiveModelsByProviderId] = useState(null);
  const [liveModelsLoading, setLiveModelsLoading] = useState(false);
  // vision/reasoning badges (eye/brain) for each model chip
  const { getCaps } = useModelCaps();

  // Cursor and Cline expose the usable catalog per account, so the static catalog is
  // kept only as a fallback: it goes stale quickly and entitlements differ per account.
  // Single map driven by LIVE_CATALOG_PROVIDERS so the constant cannot drift
  // from the memos below; per-provider arrays stay referentially stable unless
  // activeProviders itself changes.
  const liveConnectionIdsByProvider = useMemo(() => {
    const map = Object.fromEntries(LIVE_CATALOG_PROVIDERS.map((id) => [id, []]));
    for (const p of activeProviders) {
      if (p?.id && Object.prototype.hasOwnProperty.call(map, p.provider)) map[p.provider].push(p.id);
    }
    return map;
  }, [activeProviders]);
  const cursorConnectionIds = liveConnectionIdsByProvider.cursor;
  const clineConnectionIds = liveConnectionIdsByProvider.cline;
  const clinepassConnectionIds = liveConnectionIdsByProvider.clinepass;

  const cursorModels = useLiveProviderModels(isOpen, cursorConnectionIds, "Cursor");
  const clineModels = useLiveProviderModels(isOpen, clineConnectionIds, "Cline");
  const clinepassModels = useLiveProviderModels(isOpen, clinepassConnectionIds, "ClinePass");


  const fetchCombos = useCallback(async () => {
    try {
      const res = await fetch("/api/combos");
      if (!res.ok) throw new Error(`Failed to fetch combos: ${res.status}`);
      const data = await res.json();
      setCombos(data.combos || []);
    } catch (error) {
      console.error("Error fetching combos:", error);
      setCombos([]);
    }
  }, []);

  const fetchProviderNodes = useCallback(async () => {
    try {
      const res = await fetch("/api/provider-nodes");
      if (!res.ok)
        throw new Error(`Failed to fetch provider nodes: ${res.status}`);
      const data = await res.json();
      setProviderNodes(data.nodes || []);
    } catch (error) {
      console.error("Error fetching provider nodes:", error);
      setProviderNodes([]);
    }
  }, []);

  const fetchCustomModels = useCallback(async () => {
    try {
      const res = await fetch("/api/models/custom");
      if (!res.ok)
        throw new Error(`Failed to fetch custom models: ${res.status}`);
      const data = await res.json();
      setCustomModels(data.models || []);
    } catch (error) {
      console.error("Error fetching custom models:", error);
      setCustomModels([]);
    }
  }, []);

  const fetchDisabledModels = useCallback(async () => {
    try {
      const res = await fetch("/api/models/disabled");
      if (!res.ok)
        throw new Error(`Failed to fetch disabled models: ${res.status}`);
      const data = await res.json();
      setDisabledModels(data.disabled || {});
    } catch (error) {
      console.error("Error fetching disabled models:", error);
      setDisabledModels({});
    }
  }, []);

  // Live catalog per provider (first active connection wins). Fail-open → {}.
  const fetchLiveModels = useCallback(
    async (signal) => {
      const selectable = filterActiveProvidersForModelSelect(activeProviders);
      const byProvider = pickFirstActiveConnectionByProvider(selectable);
      if (byProvider.size === 0) {
        if (!signal?.aborted) {
          setLiveModelsByProviderId({});
          setLiveModelsLoading(false);
        }
        return;
      }

      setLiveModelsLoading(true);
      try {
        const entries = await Promise.all(
          [...byProvider.entries()].map(async ([providerId, conn]) => {
            try {
              const res = await fetch(`/api/providers/${conn.id}/models`, {
                cache: "no-store",
                signal,
              });
              if (!res.ok) return [providerId, []];
              const data = await res.json().catch(() => ({}));
              return [providerId, parseProviderModelsPayload(data)];
            } catch (err) {
              if (err?.name === "AbortError") return [providerId, null];
              return [providerId, []];
            }
          }),
        );

        if (signal?.aborted) return;

        const next = {};
        for (const [providerId, models] of entries) {
          if (Array.isArray(models) && models.length > 0) {
            next[providerId] = models;
          }
        }
        setLiveModelsByProviderId(next);
      } finally {
        if (!signal?.aborted) setLiveModelsLoading(false);
      }
    },
    [activeProviders],
  );

  const fetchOpenData = useCallback(() => {
    void fetchCombos();
    void fetchProviderNodes();
    void fetchCustomModels();
    void fetchDisabledModels();
  }, [fetchCombos, fetchProviderNodes, fetchCustomModels, fetchDisabledModels]);

  useEffect(() => {
    if (!isOpen) return undefined;
    const ac = new AbortController();
    let ignore = false;
    (async () => {
      await fetchLiveModels(ac.signal);
      fetchOpenData();
    })();

    return () => {
      ignore = true;
      ac.abort();
    };
  }, [isOpen, fetchOpenData, fetchLiveModels]);

  const allProviders = useMemo(
    () => ({
      ...OAUTH_PROVIDERS,
      ...FREE_PROVIDERS,
      ...FREE_TIER_PROVIDERS,
      ...APIKEY_PROVIDERS,
    }),
    [],
  );

  // Group models by provider with priority order
  const groupedModels = useMemo(() => {
    const groups = {};

    // Kinds where the provider IS the model (no per-model selection needed)
    const PROVIDER_AS_MODEL_KINDS = new Set(["webSearch", "webFetch"]);
    // Kinds that map via getModelKind (kind || type)
    const TYPED_KINDS = new Set([
      "image",
      "tts",
      "stt",
      "embedding",
      "imageToText",
    ]);
    // For these kinds, providers without hardcoded models can still be picked (provider-as-model fallback)
    const ALLOW_PROVIDER_FALLBACK_KINDS = new Set(["tts", "image", "webFetch"]);

    // Filter a models[] array by kindFilter (keep only matching kind)
    const filterByKind = (models) => {
      // No kindFilter means the LLM selector. Keep custom models visible because
      // they may expose typed capabilities while still being selectable as chat models.
      if (!kindFilter)
        return models.filter(
          (m) =>
            m.isPlaceholder ||
            m.isCustom ||
            !getModelKind(m) ||
            getModelKind(m) === "llm",
        );
      if (!TYPED_KINDS.has(kindFilter)) return models;
      return models.filter(
        (m) => m.isPlaceholder || getModelKind(m) === kindFilter,
      );
    };

    // Get all active provider IDs from connections (filtered by kindFilter if set)
    const activeConnectionIds = filteredActiveProviders.map((p) => p.provider);

    // No-auth providers: filter by kindFilter as well
    const noAuthIds = kindFilter
      ? NO_AUTH_PROVIDER_IDS.filter((id) =>
          (AI_PROVIDERS[id]?.serviceKinds || ["llm"]).includes(kindFilter),
        )
      : NO_AUTH_PROVIDER_IDS;

    // Only show connected providers (including both standard and custom)
    const providerIdsToShow = new Set([
      ...activeConnectionIds, // Only connected providers
      ...noAuthIds, // No-auth providers (kind-filtered)
    ]);

    // Sort by PROVIDER_ORDER
    const sortedProviderIds = [...providerIdsToShow].sort((a, b) => {
      const indexA = PROVIDER_ORDER.indexOf(a);
      const indexB = PROVIDER_ORDER.indexOf(b);
      return (indexA === -1 ? 999 : indexA) - (indexB === -1 ? 999 : indexB);
    });

    sortedProviderIds.forEach((providerId) => {
      const alias = getProviderAlias(providerId);
      const providerInfo = allProviders[providerId] || {
        name: providerId,
        color: "#666",
      };
      const isCustomProvider =
        isOpenAICompatibleProvider(providerId) ||
        isAnthropicCompatibleProvider(providerId);

      // For provider-as-model kinds (webSearch/webFetch): emit a single entry where value === providerId
      if (kindFilter && PROVIDER_AS_MODEL_KINDS.has(kindFilter)) {
        groups[providerId] = {
          name: providerInfo.name,
          alias,
          color: providerInfo.color,
          models: [
            { id: providerId, name: providerInfo.name, value: providerId },
          ],
        };
        return;
      }

      if (providerInfo.passthroughModels) {
        const aliasModels = Object.entries(modelAliases)
          .filter(([, fullModel]) => fullModel.startsWith(`${alias}/`))
          .map(([aliasName, fullModel]) => ({
            id: fullModel.replace(`${alias}/`, ""),
            name: aliasName,
            value: fullModel,
          }));

        // For typed kinds, only include hardcoded typed models (aliases are typically LLM-only and lack type info)
        let combined = aliasModels;
        if (kindFilter && TYPED_KINDS.has(kindFilter)) {
          combined = getModelsByProviderId(providerId)
            .filter((m) => getModelKind(m) === kindFilter)
            .map((m) => ({
              id: m.id,
              name: m.name,
              value: `${alias}/${m.id}`,
              kind: getModelKind(m),
            }));
          // Fallback: provider-as-model when no hardcoded models match (tts/image/webFetch only)
          if (
            combined.length === 0 &&
            ALLOW_PROVIDER_FALLBACK_KINDS.has(kindFilter)
          ) {
            const supports = (providerInfo.serviceKinds || ["llm"]).includes(
              kindFilter,
            );
            if (supports)
              combined = [
                { id: providerId, name: providerInfo.name, value: alias },
              ];
          }
        } else if (!kindFilter) {
          // LLM context: merge hardcoded LLM models
          const hardcodedModels = getModelsByProviderId(providerId)
            .filter((m) => !getModelKind(m) || getModelKind(m) === "llm")
            .map((m) => ({
              id: m.id,
              name: m.name,
              value: `${alias}/${m.id}`,
              kind: getModelKind(m),
            }));
          const hardcodedIds = new Set(hardcodedModels.map((m) => m.id));
          const filteredAliases = aliasModels.filter(
            (m) => !hardcodedIds.has(m.id),
          );
          combined = [...hardcodedModels, ...filteredAliases];
        }

        // Live catalog (union for passthrough providers when fetch settled)
        if (!kindFilter && liveModelsByProviderId) {
          combined = applyLiveCatalogToChips({
            providerId,
            valuePrefix: alias,
            staticChips: combined,
            liveModels: liveModelsByProviderId[providerId] || null,
          });
        }

        if (combined.length > 0) {
          // Check for custom name from providerNodes (for compatible providers)
          const matchedNode = providerNodes.find(
            (node) => node.id === providerId,
          );
          const displayName = matchedNode?.name || providerInfo.name;

          groups[providerId] = {
            name: displayName,
            alias: alias,
            color: providerInfo.color,
            models: combined,
          };
        }
      } else if (isCustomProvider) {
        // Custom (openai/anthropic-compatible) providers are LLM-only — skip for typed media kinds
        if (kindFilter && TYPED_KINDS.has(kindFilter)) return;
        // Find connection object to get prefix synchronously without waiting for providerNodes fetch
        const connection = activeProviders.find(
          (p) => p.provider === providerId,
        );
        const matchedNode = providerNodes.find(
          (node) => node.id === providerId,
        );
        const displayName =
          connection?.name || matchedNode?.name || providerInfo.name;
        const nodePrefix =
          connection?.providerSpecificData?.prefix ||
          matchedNode?.prefix ||
          providerId;

        // Aliases are stored using the raw providerId as key (e.g. "openai-compatible-chat-<uuid>/glm-4.7"),
        // so we must filter by providerId, not by the display prefix.
        const nodeModels = Object.entries(modelAliases)
          .filter(([, fullModel]) => fullModel.startsWith(`${providerId}/`))
          .map(([aliasName, fullModel]) => ({
            id: fullModel.replace(`${providerId}/`, ""),
            name: aliasName,
            value: `${nodePrefix}/${fullModel.replace(`${providerId}/`, "")}`,
          }));

        // Merge custom models registered via /api/models/custom for this provider
        // providerAlias in DB uses the raw providerId, not the display prefix
        const registeredCustom = customModels
          .filter((m) => m.providerAlias === providerId)
          .map((m) => ({
            id: m.id,
            name: m.name || m.id,
            value: `${nodePrefix}/${m.id}`,
            isCustom: true,
          }));
        const seen = new Set(nodeModels.map((m) => m.value));
        const mergedModels = [
          ...nodeModels,
          ...registeredCustom.filter((m) => !seen.has(m.value)),
        ];

        // Always show compatible providers that are connected, even with no aliases.
        // When no aliases exist, show a placeholder so users know it's available.
        let modelsToShow =
          mergedModels.length > 0
            ? mergedModels
            : [
                {
                  id: `__placeholder__${providerId}`,
                  name: `${nodePrefix}/model-id`,
                  value: `${nodePrefix}/model-id`,
                  isPlaceholder: true,
                },
              ];

        // Live OpenAI/Anthropic-compatible catalog: union discovered model ids
        if (liveModelsByProviderId) {
          const liveMerged = applyLiveCatalogToChips({
            providerId,
            valuePrefix: nodePrefix,
            staticChips: mergedModels,
            liveModels: liveModelsByProviderId[providerId] || null,
          });
          if (liveMerged.length > 0) {
            modelsToShow = liveMerged;
          }
        }

        groups[providerId] = {
          name: displayName,
          alias: nodePrefix,
          color: providerInfo.color,
          models: modelsToShow,
          isCustom: true,
          hasModels: modelsToShow.some((m) => !m.isPlaceholder),
        };
      } else {
        const liveModels = providerId === "cursor" ? cursorModels : providerId === "cline" ? clineModels : providerId === "clinepass" ? clinepassModels : [];
        const hardcodedModels = liveModels.length > 0
          ? liveModels
          : getModelsByProviderId(providerId);
        const hardcodedIds = new Set(hardcodedModels.map((m) => m.id));

        // Custom models: if no hardcoded models (e.g. openrouter), show all aliases for this provider
        // Otherwise only show aliases where aliasName === modelId ("Add Model" button pattern)
        const hasHardcoded = hardcodedModels.length > 0;
        const customAliasModels = Object.entries(modelAliases)
          .filter(
            ([aliasName, fullModel]) =>
              fullModel.startsWith(`${alias}/`) &&
              (hasHardcoded
                ? aliasName === fullModel.replace(`${alias}/`, "")
                : true) &&
              !hardcodedIds.has(fullModel.replace(`${alias}/`, "")),
          )
          .map(([aliasName, fullModel]) => {
            const modelId = fullModel.replace(`${alias}/`, "");
            return {
              id: modelId,
              name: aliasName,
              value: fullModel,
              isCustom: true,
            };
          });

        // Custom models registered via /api/models/custom (provider "Add Model" button)
        const customAliasIds = new Set(customAliasModels.map((m) => m.id));
        const customRegisteredModels = customModels
          .filter(
            (m) =>
              m.providerAlias === alias &&
              !hardcodedIds.has(m.id) &&
              !customAliasIds.has(m.id),
          )
          .map((m) => ({
            id: m.id,
            name: m.name || m.id,
            value: `${alias}/${m.id}`,
            isCustom: true,
          }));

        const merged = [
          ...hardcodedModels.map((m) => ({
            id: m.id,
            name: m.name,
            value: `${alias}/${m.id}`,
            kind: getModelKind(m),
          })),
          ...customAliasModels,
          ...customRegisteredModels,
        ];
        // Dedupe by value (alias may equal hardcoded id, causing React key collision)
        const seen = new Set();
        let allModels = filterByKind(
          merged.filter((m) => {
            if (seen.has(m.value)) return false;
            seen.add(m.value);
            return true;
          }),
        );

        // Live catalog: kiro = live-only when live non-empty; others = union.
        // While liveModelsByProviderId is null (in flight), keep static (no empty flash).
        if (liveModelsByProviderId) {
          allModels = filterByKind(
            applyLiveCatalogToChips({
              providerId,
              valuePrefix: alias,
              staticChips: allModels,
              liveModels: liveModelsByProviderId[providerId] || null,
            }),
          );
        }

        // Provider-as-model fallback: providers that support the kind but have no hardcoded models
        // can still be picked (value = providerAlias). Skips embedding (always needs model).
        if (
          allModels.length === 0 &&
          kindFilter &&
          ALLOW_PROVIDER_FALLBACK_KINDS.has(kindFilter)
        ) {
          const supports = (providerInfo.serviceKinds || ["llm"]).includes(
            kindFilter,
          );
          if (supports) {
            allModels = [
              { id: providerId, name: providerInfo.name, value: alias },
            ];
          }
        }

        if (allModels.length > 0) {
          groups[providerId] = {
            name: providerInfo.name,
            alias: alias,
            color: providerInfo.color,
            models: allModels,
          };
        }
      }
    });

    // Filter out disabled models per provider (disabled keyed by storage alias OR providerId)
    Object.entries(groups).forEach(([providerId, group]) => {
      const aliasKey = getProviderAlias(providerId);
      const disabledIds = new Set([
        ...(disabledModels[aliasKey] || []),
        ...(disabledModels[providerId] || []),
      ]);
      if (disabledIds.size === 0) return;
      group.models = group.models.filter((m) => !disabledIds.has(m.id));
      if (group.models.length === 0) delete groups[providerId];
    });

    return groups;
  }, [
    filteredActiveProviders,
    modelAliases,
    allProviders,
    providerNodes,
    customModels,
    disabledModels,
    kindFilter,
    activeProviders,
    liveModelsByProviderId,
    cursorModels,
    clineModels,
    clinepassModels,
  ]);

  // Filter combos by search query (and hide combos when kindFilter is set — combos are LLM-only by design)
  const filteredCombos = useMemo(() => {
    if (kindFilter || capFilter) return [];
    if (!searchQuery.trim()) return combos;
    const query = searchQuery.toLowerCase();
    return combos.filter((c) => c.name.toLowerCase().includes(query));
  }, [combos, searchQuery, kindFilter, capFilter]);

  // Sort models alphabetically, with added models floated to top
  const sortModels = useCallback(
    (models) => {
      const added = models
        .filter((m) => addedModelValues.includes(m.value))
        .sort((a, b) => a.name.localeCompare(b.name));
      const rest = models
        .filter((m) => !addedModelValues.includes(m.value))
        .sort((a, b) => a.name.localeCompare(b.name));
      return [...added, ...rest];
    },
    [addedModelValues],
  );

  // Normalize for search: "openrouter_gpt_4" / "gpt-4" → comparable tokens
  const normalizeSearchText = useCallback((text) => {
    return String(text || "")
      .toLowerCase()
      .replace(/[/_.:-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }, []);

  const modelMatchesQuery = useCallback(
    (model, query, normalizedQuery) => {
      if (!query) return true;
      const name = String(model?.name || "").toLowerCase();
      const id = String(model?.id || "").toLowerCase();
      const value = String(model?.value || "").toLowerCase();
      // Exact substring on raw fields (covers live-fetched ids / full alias paths)
      if (
        name.includes(query) ||
        id.includes(query) ||
        value.includes(query)
      ) {
        return true;
      }
      // Soft match: ignore _ - / separators so "gpt 4" hits openrouter_gpt_4_o
      const soft = normalizeSearchText(
        [model?.name, model?.id, model?.value].filter(Boolean).join(" "),
      );
      return soft.includes(normalizedQuery);
    },
    [normalizeSearchText],
  );

  // Filter models by search query (static + live chips share the same fields)
  const filteredGroups = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const normalizedQuery = normalizeSearchText(query);

    const filtered = {};
    Object.entries(groupedModels).forEach(([providerId, group]) => {
      let models = group.models;
      // Filter by input-modality capability (vision/pdf/audioInput/videoInput).
      if (capFilter) {
        models = models.filter((m) => getCaps(m.value)?.[capFilter] === true);
        if (models.length === 0) return;
      }

      // Quick category filters
      if (activeFilter === "thinking") {
        models = models.filter((m) => {
          const caps = getCaps(m.value);
          return (
            caps?.reasoning === true ||
            /thinking/i.test(m.name || "") ||
            /thinking/i.test(m.id || "") ||
            /reason/i.test(m.id || "")
          );
        });
      } else if (activeFilter === "agentic") {
        models = models.filter(
          (m) =>
            /agentic/i.test(m.name || "") ||
            /agentic/i.test(m.id || "") ||
            /agent/i.test(m.id || ""),
        );
      } else if (activeFilter === "vision") {
        models = models.filter((m) => getCaps(m.value)?.vision === true);
      } else if (activeFilter === "custom") {
        models = models.filter((m) => m.isCustom);
      }

      if (models.length === 0) return;

      if (query) {
        const providerNameMatches =
          group.name.toLowerCase().includes(query) ||
          normalizeSearchText(group.name).includes(normalizedQuery);
        const aliasMatches =
          String(group.alias || "")
            .toLowerCase()
            .includes(query) ||
          normalizeSearchText(group.alias).includes(normalizedQuery);

        const matched = models.filter((m) =>
          modelMatchesQuery(m, query, normalizedQuery),
        );

        if (matched.length > 0) {
          models = matched;
        } else if (providerNameMatches || aliasMatches) {
          // Provider name hit → keep full list so users can browse large live catalogs
          models = group.models;
        } else {
          return;
        }
      }
      filtered[providerId] = {
        ...group,
        models: sortModels(models),
      };
    });

    return filtered;
  }, [
    groupedModels,
    searchQuery,
    sortModels,
    normalizeSearchText,
    modelMatchesQuery,
    capFilter,
    activeFilter,
    getCaps,
  ]);

  const handleSelect = (model) => {
    const value = model?.value || model?.name || model;
    const isAdded = addedModelValues.includes(value);

    if (isAdded && onDeselect) {
      onDeselect(model);
    } else {
      onSelect(model);
    }

    if (closeOnSelect) {
      onClose();
      setSearchQuery("");
    }
  };

  const handleModalClose = useCallback(() => {
    onClose();
    setSearchQuery("");
    setActiveFilter("all");
  }, [onClose]);

  const scrollToProvider = (id) => {
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleModalClose}
      title={title}
      size="full"
      className="p-4! max-h-[94vh]"
      footer={null}
    >
      {/* Info bar */}
      <div className="flex items-center gap-2 mb-3 px-2.5 py-2 bg-primary/8 border border-primary/20 rounded-lg text-xs text-text-muted">
        <span
          className="material-symbols-outlined text-primary shrink-0 text-[14px]"
        >
          info
        </span>
        <span>
          Click to add, click again to remove. Changes are saved automatically.
        </span>
      </div>

      {/* Pinned Selected Models Bar */}
      {addedModelValues.length > 0 && (
        <div className="mb-3 p-2 bg-surface border border-primary/30 rounded-xl">
          <div className="flex items-center justify-between mb-1.5 px-1">
            <div className="flex items-center gap-1.5">
              <span className="material-symbols-outlined text-primary text-[15px]">
                check_circle
              </span>
              <span className="text-xs font-semibold text-text-main">
                Selected in Combo ({addedModelValues.length})
              </span>
            </div>
            {onDeselect && addedModelValues.length > 1 && (
              <button
                type="button"
                onClick={() => {
                  addedModelValues.forEach((val) => {
                    onDeselect({ value: val, name: val, id: val });
                  });
                }}
                className="text-[11px] text-text-muted hover:text-red-400 transition-colors cursor-pointer"
              >
                Clear all
              </button>
            )}
          </div>
          <div className="flex flex-wrap gap-1.5 max-h-[85px] overflow-y-auto custom-scrollbar p-0.5">
            {addedModelValues.map((val) => {
              const parsed = parseModelDisplay(val, val, "");
              return (
                <span
                  key={val}
                  className="inline-flex items-center gap-1.5 pl-2 pr-1.5 py-0.5 rounded-lg text-xs bg-primary/15 text-primary border border-primary/30 font-medium"
                >
                  <span className="truncate max-w-[220px]">{parsed.title}</span>
                  {onDeselect && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeselect({ value: val, name: val, id: val });
                      }}
                      className="w-4 h-4 rounded-full flex items-center justify-center hover:bg-primary/25 transition-colors cursor-pointer"
                    >
                      <span className="material-symbols-outlined text-[13px] leading-none">
                        close
                      </span>
                    </button>
                  )}
                </span>
              );
            })}
          </div>
        </div>
      )}

      {/* Search Bar */}
      <div className="mb-2">
        <div className="relative">
          <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-text-muted text-[18px]">
            search
          </span>
          <input
            type="text"
            placeholder="Search models, ids, or providers…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            autoFocus
            className="w-full pl-10 pr-3 py-2 bg-surface border border-border rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-primary/50"
          />
        </div>
      </div>

      {/* Quick Filter Tabs */}
      <div className="flex items-center gap-1.5 overflow-x-auto custom-scrollbar pb-1 mb-2.5 text-xs">
        {[
          { id: "all", label: "All Models" },
          { id: "thinking", label: "🧠 Thinking" },
          { id: "agentic", label: "⚡ Agentic" },
          { id: "vision", label: "👁️ Vision" },
          { id: "custom", label: "🏷️ Custom" },
        ].map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => setActiveFilter(f.id)}
            className={`
              px-2.5 py-1 rounded-lg text-[11px] font-medium transition-colors shrink-0 cursor-pointer border
              ${
                activeFilter === f.id
                  ? "bg-primary text-white border-primary shadow-xs"
                  : "bg-surface border-border text-text-muted hover:text-text-main hover:border-primary/40"
              }
            `}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Provider Quick Jump Anchor Bar */}
      <div className="flex items-center gap-1.5 overflow-x-auto custom-scrollbar pb-1.5 mb-3 border-b border-border/50 text-xs">
        <span className="text-[10px] uppercase font-bold tracking-wider text-text-muted shrink-0 mr-0.5">
          Jump to:
        </span>
        {filteredCombos.length > 0 && (
          <button
            type="button"
            onClick={() => scrollToProvider("provider-section-combos")}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-surface border border-border text-text-muted hover:text-primary hover:border-primary/40 shrink-0 transition-colors text-[11px] cursor-pointer"
          >
            <span className="material-symbols-outlined text-primary text-[12px]">
              layers
            </span>
            Combos ({filteredCombos.length})
          </button>
        )}
        {Object.entries(filteredGroups).map(([pid, group]) => (
          <button
            key={pid}
            type="button"
            onClick={() => scrollToProvider(`provider-section-${pid}`)}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-surface border border-border text-text-muted hover:text-primary hover:border-primary/40 shrink-0 transition-colors text-[11px] cursor-pointer"
          >
            <ProviderIcon
              src={`/providers/${pid}.png`}
              alt={group.name}
              size={12}
              fallbackText={(group.name || pid).slice(0, 2).toUpperCase()}
              fallbackColor={group.color}
            />
            <span className="truncate max-w-[100px]">{group.name}</span>
            <span className="text-[10px] opacity-70">({group.models.length})</span>
          </button>
        ))}
      </div>

      {/* Models grouped by provider */}
      <div className="max-h-[min(56vh,580px)] overflow-y-auto space-y-4 pr-1 custom-scrollbar">
        {/* Combos section - always first */}
        {filteredCombos.length > 0 && (
          <div id="provider-section-combos">
            <div className="flex items-center gap-1.5 mb-1.5 sticky top-0 bg-surface/95 backdrop-blur-xs py-1 z-10">
              <span className="material-symbols-outlined text-primary text-[14px]">
                layers
              </span>
              <span className="text-xs font-semibold text-primary">Combos</span>
              <span className="text-[10px] text-text-muted">
                ({filteredCombos.length})
              </span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {filteredCombos.map((combo) => {
                const isSelected = selectedModel === combo.name;
                const isAdded = addedModelValues.includes(combo.name);
                return (
                  <button
                    key={combo.id}
                    onClick={() =>
                      handleSelect({
                        id: combo.name,
                        name: combo.name,
                        value: combo.name,
                      })
                    }
                    className={`
                      px-2.5 py-1.5 rounded-xl text-xs font-medium transition-all border cursor-pointer flex items-center gap-1.5
                      ${
                        isSelected
                          ? "bg-primary text-white border-primary"
                          : isAdded
                            ? "bg-primary/15 border-primary text-primary font-bold ring-1 ring-primary/40 hover:bg-primary/20"
                            : "bg-surface border-border text-text-main hover:border-primary/50 hover:bg-primary/5"
                      }
                    `}
                  >
                    {isAdded && (
                      <span
                        className="material-symbols-outlined leading-none text-primary"
                        style={{ fontSize: "12px" }}
                      >
                        check_circle
                      </span>
                    )}
                    {combo.name}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Provider models */}
        {Object.entries(filteredGroups).map(([providerId, group]) => (
          <div key={providerId} id={`provider-section-${providerId}`}>
            {/* Provider header */}
            <div className="flex items-center gap-1.5 mb-2 sticky top-0 bg-surface/95 backdrop-blur-xs py-1 z-10">
              <ProviderIcon
                src={`/providers/${providerId}.png`}
                alt={group.name}
                size={14}
                fallbackText={(group.name || providerId)
                  .slice(0, 2)
                  .toUpperCase()}
                fallbackColor={group.color}
              />
              <span className="text-xs font-semibold text-primary">
                {group.name}
              </span>
              <span className="text-[10px] text-text-muted">
                ({group.models.length})
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
              {group.models.map((model) => {
                const isSelected = selectedModel === model.value;
                const isPlaceholder = model.isPlaceholder;
                const isAdded = addedModelValues.includes(model.value);
                const display = parseModelDisplay(model.name, model.id, providerId);
                const caps = getCaps(model.value);

                return (
                  <button
                    key={model.value}
                    onClick={() => handleSelect(model)}
                    title={
                      isPlaceholder
                        ? "Select to pre-fill, then edit model ID in the input"
                        : model.value
                    }
                    className={`
                      p-2.5 rounded-xl text-xs transition-all border text-left flex items-start gap-2 cursor-pointer relative overflow-hidden group
                      ${
                        isPlaceholder
                          ? "border-dashed border-border text-text-muted hover:border-primary/50 hover:text-primary bg-surface italic"
                          : isSelected
                            ? "bg-primary text-white border-primary shadow-sm"
                            : isAdded
                              ? "bg-primary/10 border-primary text-text-main ring-1 ring-primary/40 hover:bg-primary/15"
                              : "bg-surface border-border text-text-main hover:border-primary/50 hover:bg-primary/5"
                      }
                    `}
                  >
                    {isAdded && !isPlaceholder && (
                      <span
                        className="material-symbols-outlined text-primary leading-none mt-0.5 shrink-0 text-[15px]"
                      >
                        check_circle
                      </span>
                    )}
                    <div className="flex flex-col min-w-0 flex-1">
                      {/* Top row: Title + Badges */}
                      <div className="flex items-start justify-between gap-1.5 min-w-0">
                        <span
                          className={`font-semibold text-[12px] leading-tight truncate ${
                            isAdded ? "text-primary font-bold" : "text-text-main"
                          }`}
                        >
                          {isPlaceholder ? (
                            <span className="flex items-center gap-1">
                              <span className="material-symbols-outlined text-[11px]">
                                edit
                              </span>
                              {model.name}
                            </span>
                          ) : (
                            display.title
                          )}
                        </span>
                        <div className="flex items-center gap-1 shrink-0">
                          {display.credit && (
                            <span className="text-[9px] px-1 py-0.2 rounded font-mono font-bold bg-amber-500/15 text-amber-400 border border-amber-500/30 leading-none">
                              {display.credit}
                            </span>
                          )}
                          <CapacityBadges
                            caps={caps}
                            size={11}
                            colorOverride={
                              isSelected ? "text-white/80" : undefined
                            }
                          />
                        </div>
                      </div>

                      {/* Bottom row: Model ID & Extra Tags */}
                      {!isPlaceholder && (
                        <div className="flex items-center gap-1 mt-1 text-[10px] text-text-muted font-mono leading-none">
                          <span className="truncate">{model.id}</span>
                          {display.isThinking && !caps?.reasoning && (
                            <span className="text-[8px] px-1 py-0.2 rounded font-sans bg-purple-500/15 text-purple-400 border border-purple-500/25 shrink-0">
                              🧠 Thinking
                            </span>
                          )}
                          {display.isAgentic && (
                            <span className="text-[8px] px-1 py-0.2 rounded font-sans bg-blue-500/15 text-blue-400 border border-blue-500/25 shrink-0">
                              ⚡ Agentic
                            </span>
                          )}
                          {model.isCustom && (
                            <span className="text-[8px] px-1 py-0.2 rounded font-sans uppercase font-bold bg-white/10 text-text-muted shrink-0">
                              custom
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        ))}

        {Object.keys(filteredGroups).length === 0 &&
          filteredCombos.length === 0 && (
            <div className="text-center py-6 text-text-muted">
              <span className="material-symbols-outlined text-2xl mb-1 block">
                search_off
              </span>
              <p className="text-xs">No models found for this filter</p>
            </div>
          )}
      </div>
    </Modal>
  );
}

ModelSelectModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  onSelect: PropTypes.func.isRequired,
  onDeselect: PropTypes.func,
  selectedModel: PropTypes.string,
  activeProviders: PropTypes.arrayOf(
    PropTypes.shape({
      provider: PropTypes.string.isRequired,
    }),
  ),
  title: PropTypes.string,
  modelAliases: PropTypes.object,
  kindFilter: PropTypes.string,
  addedModelValues: PropTypes.arrayOf(PropTypes.string),
  closeOnSelect: PropTypes.bool,
};
