"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import { USAGE_SUPPORTED_PROVIDERS } from "@/shared/constants/providers";
import { parseQuotaData, calculatePercentage } from "../../utils";
import {
  CONNECTIONS_PAGE_SIZE,
  getSafePagination,
  getSafeTotals,
  getPaginationPageValue,
  getProviderOptions,
  getQuotaCache,
  QUOTA_CACHE_KEY,
  filterQuotaStateByConnections,
  setQuotaCache,
  buildLoadingState,
  reconcileConnectionsPage,
  sortVisibleConnections,
  DEPLETED_QUOTA_THRESHOLD,
  REFRESH_INTERVAL_MS,
  AUTO_REFRESH_STORAGE_KEY,
} from "../../components/local/helpers";

export function useProviderLimits() {
  const { copied, copy } = useCopyToClipboard();
  const [connections, setConnections] = useState([]);
  const [quotaData, setQuotaData] = useState({});
  const [loading, setLoading] = useState({});
  const [errors, setErrors] = useState({});
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [hasHydratedAutoRefresh, setHasHydratedAutoRefresh] = useState(false);
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [countdown, setCountdown] = useState(60);
  const [connectionsLoading, setConnectionsLoading] = useState(true);
  const [deletingId, setDeletingId] = useState(null);
  const [togglingId, setTogglingId] = useState(null);
  const [resettingLimitId, setResettingLimitId] = useState(null);
  const [autoPingSavingId, setAutoPingSavingId] = useState(null);
  const [resetConfirmState, setResetConfirmState] = useState(null);
  const [autoPingMaps, setAutoPingMaps] = useState({
    claude: {},
    codex: {},
  });
  const [resetCreditsState, setResetCreditsState] = useState(null);
  const [showEditModal, setShowEditModal] = useState(false);
  const [selectedConnection, setSelectedConnection] = useState(null);
  const [proxyPools, setProxyPools] = useState([]);
  const [providerFilter, setProviderFilter] = useState("all");
  const [providerOptions, setProviderOptions] = useState([]);
  const [accountFilter, setAccountFilter] = useState("all");
  const [searchInput, setSearchInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [quotaSortMode, setQuotaSortMode] = useState("default");
  const [expiringFirst, setExpiringFirst] = useState(false);
  const [providerMenuOpen, setProviderMenuOpen] = useState(false);
  const [bulkToggling, setBulkToggling] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(CONNECTIONS_PAGE_SIZE);
  const [customPageSizeInput, setCustomPageSizeInput] = useState(
    String(CONNECTIONS_PAGE_SIZE),
  );
  const [pagination, setPagination] = useState({
    page: 1,
    pageSize: CONNECTIONS_PAGE_SIZE,
    total: 0,
    totalPages: 1,
  });
  const [totals, setTotals] = useState({
    eligibleConnections: 0,
    providerFilteredConnections: 0,
    filteredConnections: 0,
  });

  const intervalRef = useRef(null);
  const countdownRef = useRef(null);

  // Debounce search so typing does not refetch on every keystroke.
  useEffect(() => {
    const timer = setTimeout(() => {
      const nextQuery = searchInput.trim();
      setSearchQuery((prev) => {
        if (prev === nextQuery) return prev;
        setPage(1);
        return nextQuery;
      });
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const fetchConnections = useCallback(
    async (targetPage = page) => {
      try {
        const params = new URLSearchParams({
          page: String(targetPage),
          pageSize: String(pageSize),
          accountStatus: accountFilter,
          sort: "priority",
        });

        if (providerFilter !== "all") {
          params.set("provider", providerFilter);
        }
        if (searchQuery) {
          params.set("search", searchQuery);
        }

        const response = await fetch(
          `/api/providers/client?${params.toString()}`,
        );
        if (!response.ok) throw new Error("Failed to fetch connections");

        const data = await response.json();
        const connectionList = data.connections || [];
        const nextPagination = getSafePagination(data.pagination, pageSize);
        const nextTotals = getSafeTotals(data.totals, connectionList.length);

        setConnections(connectionList);
        setProviderOptions(getProviderOptions(data.providerOptions));
        setPagination(nextPagination);
        setTotals(nextTotals);
        setPage(getPaginationPageValue(data.pagination, targetPage));
        return connectionList;
      } catch (error) {
        console.error("Error fetching connections:", error);
        setConnections([]);
        setProviderOptions([]);
        setPagination({ page: 1, pageSize, total: 0, totalPages: 1 });
        setTotals({
          eligibleConnections: 0,
          providerFilteredConnections: 0,
          filteredConnections: 0,
        });
        return [];
      }
    },
    [accountFilter, page, pageSize, providerFilter, searchQuery],
  );

  // Fetch quota for a specific connection
  const fetchQuota = useCallback(async (connectionId, provider) => {
    setLoading((prev) => ({ ...prev, [connectionId]: true }));
    setErrors((prev) => ({ ...prev, [connectionId]: null }));

    try {
      console.log(
        `[ProviderLimits] Fetching quota for ${provider} (${connectionId})`,
      );
      const response = await fetch(`/api/usage/${connectionId}`);

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const errorMsg = errorData.error || response.statusText;

        if (response.status === 404) {
          console.warn(
            `[ProviderLimits] Connection not found for ${provider}, skipping`,
          );
          return;
        }

        if (response.status === 401) {
          console.warn(
            `[ProviderLimits] Auth error for ${provider}:`,
            errorMsg,
          );
          const quotaEntry = {
            quotas: [],
            message: errorMsg,
          };
          setQuotaData((prev) => ({
            ...prev,
            [connectionId]: quotaEntry,
          }));
          setQuotaCache(connectionId, quotaEntry);
          return;
        }

        throw new Error(`HTTP ${response.status}: ${errorMsg}`);
      }

      const data = await response.json();
      console.log(`[ProviderLimits] Got quota for ${provider}:`, data);

      const parsedQuotas = parseQuotaData(provider, data);

      const quotaEntry = {
        quotas: parsedQuotas,
        quotaGroups: Array.isArray(data.quotaGroups) ? data.quotaGroups : null,
        plan: data.plan || null,
        message: data.message || null,
        // Grok CLI: Enabled/Disabled from onDemandCap (CLIProxyAPI-style row)
        payAsYouGo: data.payAsYouGo || null,
        validation: data.validation || null,
        raw: data,
      };

      setQuotaData((prev) => ({
        ...prev,
        [connectionId]: quotaEntry,
      }));
      setQuotaCache(connectionId, quotaEntry);
    } catch (error) {
      console.error(
        `[ProviderLimits] Error fetching quota for ${provider} (${connectionId}):`,
        error,
      );
      setErrors((prev) => ({
        ...prev,
        [connectionId]: error.message || "Failed to fetch quota",
      }));
    } finally {
      setLoading((prev) => ({ ...prev, [connectionId]: false }));
    }
  }, []);

  const refreshProvider = useCallback(
    async (connectionId, provider) => {
      await fetchQuota(connectionId, provider);
      setLastUpdated(new Date());
    },
    [fetchQuota],
  );

  const handleDeleteConnection = useCallback(
    async (id) => {
      if (!confirm("Delete this connection?")) return;
      setDeletingId(id);
      try {
        const res = await fetch(`/api/providers/${id}`, { method: "DELETE" });
        if (res.ok) {
          setQuotaData((prev) => {
            const next = { ...prev };
            delete next[id];
            return next;
          });
          setLoading((prev) => {
            const next = { ...prev };
            delete next[id];
            return next;
          });
          setErrors((prev) => {
            const next = { ...prev };
            delete next[id];
            return next;
          });

          if (typeof window !== "undefined") {
            try {
              const cache = getQuotaCache();
              if (cache[id]) {
                delete cache[id];
                window.localStorage.setItem(
                  QUOTA_CACHE_KEY || "quotaCacheData",
                  JSON.stringify(cache),
                );
              }
            } catch (e) {
              console.error("Error deleting cache entry:", e);
            }
          }

          await reconcileConnectionsPage(fetchConnections, page);
        }
      } catch (error) {
        console.error("Error deleting connection:", error);
      } finally {
        setDeletingId(null);
      }
    },
    [fetchConnections, page],
  );

  const handleResetCodexLimit = useCallback(
    async (connection) => {
      if (!connection || resettingLimitId) return;

      setResettingLimitId(connection.id);
      setErrors((prev) => ({ ...prev, [connection.id]: null }));
      try {
        const response = await fetch(
          `/api/usage/${connection.id}/codex-reset-credits`,
          { method: "POST" },
        );
        const result = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(
            result.message || result.error || result.code || "Failed to reset Codex limit",
          );
        }

        await refreshProvider(connection.id, connection.provider);
      } catch (error) {
        setErrors((prev) => ({
          ...prev,
          [connection.id]: error.message || "Failed to reset Codex limit",
        }));
      } finally {
        setResettingLimitId(null);
      }
    },
    [refreshProvider, resettingLimitId],
  );

  const handleViewCodexResetCredits = useCallback(async (connection) => {
    setResetCreditsState({
      connection,
      loading: true,
      error: null,
      data: null,
    });
    try {
      const response = await fetch(
        `/api/usage/${connection.id}/codex-reset-credits`,
        { cache: "no-store" },
      );
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(
          result.error ||
            result.message ||
            "Failed to load Codex reset credits",
        );
      }
      const credits = Array.isArray(result.credits) ? [...result.credits] : [];
      credits.sort((a, b) => {
        const aTime = a.expiresAt
          ? new Date(a.expiresAt).getTime()
          : Number.POSITIVE_INFINITY;
        const bTime = b.expiresAt
          ? new Date(b.expiresAt).getTime()
          : Number.POSITIVE_INFINITY;
        return aTime - bTime;
      });
      setResetCreditsState({
        connection,
        loading: false,
        error: null,
        data: { ...result, credits },
      });
    } catch (error) {
      setResetCreditsState({
        connection,
        loading: false,
        error: error.message || "Failed to load Codex reset credits",
        data: null,
      });
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/settings", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((settings) => {
        if (cancelled || !settings) return;
        setAutoPingMaps({
          claude: settings.claudeAutoPing?.connections || {},
          codex: settings.codexAutoPing?.connections || {},
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const toggleAutoPing = useCallback(async (connection) => {
    const provider = connection?.provider;
    if (
      (provider !== "claude" && provider !== "codex") ||
      connection?.authType !== "oauth" ||
      autoPingSavingId
    ) {
      return;
    }

    const settingsKey = provider === "claude" ? "claudeAutoPing" : "codexAutoPing";
    const previousState = autoPingMaps;
    setAutoPingSavingId(connection.id);
    try {
      const settingsResponse = await fetch("/api/settings", {
        cache: "no-store",
      });
      if (!settingsResponse.ok) {
        throw new Error("Failed to load auto-ping setting");
      }

      const settings = await settingsResponse.json();
      const currentMap = settings[settingsKey]?.connections || {};
      const nextMap = {
        ...currentMap,
        [connection.id]: !currentMap[connection.id],
      };
      const nextState = {
        ...previousState,
        [provider]: nextMap,
      };

      setAutoPingMaps(nextState);
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          [settingsKey]: {
            ...(settings[settingsKey] || {}),
            connections: nextMap,
          },
        }),
      });
      if (!response.ok) throw new Error("Failed to save auto-ping setting");
    } catch (error) {
      setAutoPingMaps(previousState);
      setErrors((prev) => ({
        ...prev,
        [connection.id]: error.message || "Failed to save auto-ping setting",
      }));
    } finally {
      setAutoPingSavingId(null);
    }
  }, [autoPingMaps, autoPingSavingId]);

  const handleToggleConnectionActive = useCallback(
    async (id, isActive) => {
      setTogglingId(id);
      try {
        const res = await fetch(`/api/providers/${id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ isActive }),
        });
        if (res.ok) {
          setQuotaData((prev) => {
            const next = { ...prev };
            return next;
          });
          await reconcileConnectionsPage(fetchConnections, page);
        }
      } catch (error) {
        console.error("Error updating connection status:", error);
      } finally {
        setTogglingId(null);
      }
    },
    [fetchConnections, page],
  );

  const handleUpdateConnection = useCallback(
    async (formData) => {
      if (!selectedConnection?.id) return;
      const connectionId = selectedConnection.id;
      const provider = selectedConnection.provider;
      try {
        const res = await fetch(`/api/providers/${connectionId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(formData),
        });
        if (res.ok) {
          await fetchConnections();
          setShowEditModal(false);
          setSelectedConnection(null);
          if (USAGE_SUPPORTED_PROVIDERS.includes(provider)) {
            await fetchQuota(connectionId, provider);
          }
        }
      } catch (error) {
        console.error("Error saving connection:", error);
      }
    },
    [selectedConnection, fetchConnections, fetchQuota],
  );

  useEffect(() => {
    let cancelled = false;
    fetch("/api/proxy-pools?isActive=true", { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled && data?.proxyPools) {
          setProxyPools(data.proxyPools);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshAll = useCallback(async () => {
    if (refreshingAll) return;

    setRefreshingAll(true);
    setCountdown(60);

    try {
      const visibleConnections = await fetchConnections(page);

      setLoading(buildLoadingState(visibleConnections));
      setErrors((prev) =>
        filterQuotaStateByConnections(prev, visibleConnections),
      );
      setQuotaData((prev) =>
        filterQuotaStateByConnections(prev, visibleConnections),
      );

      await Promise.all(
        visibleConnections.map((conn) => fetchQuota(conn.id, conn.provider)),
      );

      setLastUpdated(new Date());
    } catch (error) {
      console.error("Error refreshing all providers:", error);
    } finally {
      setRefreshingAll(false);
    }
  }, [refreshingAll, fetchConnections, fetchQuota, page]);

  useEffect(() => {
    const initializeData = async () => {
      setConnectionsLoading(true);
      const visibleConnections = await fetchConnections(page);
      setConnectionsLoading(false);

      const cache = getQuotaCache();
      const nextLoading = {};
      const cachedQuotas = {};
      const connectionsToFetch = [];
      let latestCachedAt = null;

      visibleConnections.forEach((conn) => {
        const cachedEntry = cache[conn.id];
        if (cachedEntry) {
          nextLoading[conn.id] = false;
          cachedQuotas[conn.id] = {
            quotas: cachedEntry.quotas,
            quotaGroups: cachedEntry.quotaGroups || null,
            plan: cachedEntry.plan,
            message: cachedEntry.message,
            payAsYouGo: cachedEntry.payAsYouGo || null,
            validation: cachedEntry.validation || null,
            raw: cachedEntry.raw,
          };
          if (cachedEntry.cachedAt) {
            const cachedTime = new Date(cachedEntry.cachedAt);
            if (!latestCachedAt || cachedTime > latestCachedAt) {
              latestCachedAt = cachedTime;
            }
          }
        } else {
          nextLoading[conn.id] = true;
          connectionsToFetch.push(conn);
        }
      });

      setLoading(nextLoading);
      setErrors((prev) => {
        const nextErrors = filterQuotaStateByConnections(
          prev,
          visibleConnections,
        );
        visibleConnections.forEach((conn) => {
          if (cache[conn.id]) {
            nextErrors[conn.id] = null;
          }
        });
        return nextErrors;
      });
      setQuotaData((prev) => ({
        ...filterQuotaStateByConnections(prev, visibleConnections),
        ...cachedQuotas,
      }));

      if (latestCachedAt) {
        setLastUpdated(latestCachedAt);
      }

      if (connectionsToFetch.length > 0) {
        await Promise.all(
          connectionsToFetch.map((conn) => fetchQuota(conn.id, conn.provider)),
        );
        setLastUpdated(new Date());
      }
    };

    initializeData();
  }, [fetchConnections, fetchQuota, page]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(AUTO_REFRESH_STORAGE_KEY);
    setAutoRefresh(stored === null ? true : stored === "true");
    setHasHydratedAutoRefresh(true);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || !hasHydratedAutoRefresh) return;
    window.localStorage.setItem(AUTO_REFRESH_STORAGE_KEY, String(autoRefresh));
  }, [autoRefresh, hasHydratedAutoRefresh]);

  useEffect(() => {
    if (!hasHydratedAutoRefresh || !autoRefresh) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      if (countdownRef.current) {
        clearInterval(countdownRef.current);
        countdownRef.current = null;
      }
      return;
    }

    intervalRef.current = setInterval(() => {
      refreshAll();
    }, REFRESH_INTERVAL_MS);

    countdownRef.current = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) return 60;
        return prev - 1;
      });
    }, 1000);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (countdownRef.current) clearInterval(countdownRef.current);
    };
  }, [autoRefresh, refreshAll, hasHydratedAutoRefresh]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden) {
        if (intervalRef.current) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
        }
        if (countdownRef.current) {
          clearInterval(countdownRef.current);
          countdownRef.current = null;
        }
      } else if (autoRefresh && hasHydratedAutoRefresh) {
        intervalRef.current = setInterval(refreshAll, REFRESH_INTERVAL_MS);
        countdownRef.current = setInterval(() => {
          setCountdown((prev) => (prev <= 1 ? 60 : prev - 1));
        }, 1000);
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [autoRefresh, refreshAll, hasHydratedAutoRefresh]);

  const sortedConnections = useMemo(
    () =>
      sortVisibleConnections(
        connections,
        quotaData,
        expiringFirst,
        providerFilter,
        quotaSortMode,
      ),
    [connections, quotaData, expiringFirst, providerFilter, quotaSortMode],
  );

  const isConnectionDepleted = useCallback(
    (conn) => {
      const quotas = quotaData[conn.id]?.quotas;
      if (!quotas?.length) return false;
      return quotas.some((q) => {
        if (!q.total || q.total <= 0) return false;
        return calculatePercentage(q.used, q.total) <= DEPLETED_QUOTA_THRESHOLD;
      });
    },
    [quotaData],
  );

  const bulkSetActive = useCallback(
    async (targetIds, isActive) => {
      if (!targetIds.length || bulkToggling) return;
      setBulkToggling(true);
      try {
        await Promise.all(
          targetIds.map((id) =>
            fetch(`/api/providers/${id}`, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ isActive }),
            }),
          ),
        );
        await reconcileConnectionsPage(fetchConnections, page);
      } catch (error) {
        console.error("Error bulk toggling connections:", error);
      } finally {
        setBulkToggling(false);
      }
    },
    [bulkToggling, fetchConnections, page],
  );

  const handleDisableDepleted = useCallback(() => {
    const ids = sortedConnections
      .filter((c) => (c.isActive ?? true) && isConnectionDepleted(c))
      .map((c) => c.id);
    bulkSetActive(ids, false);
  }, [sortedConnections, isConnectionDepleted, bulkSetActive]);

  const handleEnableAvailable = useCallback(() => {
    const ids = sortedConnections
      .filter((c) => !(c.isActive ?? true) && !isConnectionDepleted(c))
      .map((c) => c.id);
    bulkSetActive(ids, true);
  }, [sortedConnections, isConnectionDepleted, bulkSetActive]);

  return {
    copied,
    copy,
    connections,
    quotaData,
    loading,
    errors,
    autoRefresh,
    setAutoRefresh,
    lastUpdated,
    refreshingAll,
    countdown,
    connectionsLoading,
    deletingId,
    togglingId,
    resettingLimitId,
    autoPingSavingId,
    resetConfirmState,
    setResetConfirmState,
    autoPingMaps,
    toggleAutoPing,
    resetCreditsState,
    setResetCreditsState,
    showEditModal,
    setShowEditModal,
    selectedConnection,
    setSelectedConnection,
    proxyPools,
    providerFilter,
    setProviderFilter,
    providerOptions,
    accountFilter,
    setAccountFilter,
    searchInput,
    setSearchInput,
    searchQuery,
    quotaSortMode,
    setQuotaSortMode,
    expiringFirst,
    setExpiringFirst,
    providerMenuOpen,
    setProviderMenuOpen,
    bulkToggling,
    page,
    setPage,
    pageSize,
    setPageSize,
    customPageSizeInput,
    setCustomPageSizeInput,
    pagination,
    totals,
    refreshAll,
    refreshProvider,
    handleDeleteConnection,
    handleResetCodexLimit,
    handleViewCodexResetCredits,
    handleToggleConnectionActive,
    handleUpdateConnection,
    handleDisableDepleted,
    handleEnableAvailable,
    sortedConnections,
    isConnectionDepleted,
  };
}
