"use client";

import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import PropTypes from "prop-types";
import { Badge, Toggle, Tooltip } from "@/shared/components";
import CooldownTimer from "./CooldownTimer";

function parseValidExpiresAt(value) {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function formatVietnameseExpiresAt(value) {
  const timestamp = parseValidExpiresAt(value);
  if (!timestamp) return null;

  const formatter = new Intl.DateTimeFormat("vi-VN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour12: false,
  });

  const parts = formatter.formatToParts(new Date(timestamp));
  const byType = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return `${byType.hour}:${byType.minute}:${byType.second} ${byType.day}-${byType.month}-${byType.year}`;
}

function formatRemainingExpiresAt(value) {
  const timestamp = parseValidExpiresAt(value);
  if (!timestamp) return null;

  const diffMs = timestamp - Date.now();
  if (diffMs <= 0) return "0m";

  const totalMinutes = Math.floor(diffMs / 60000);
  const totalHours = Math.floor(diffMs / 3600000);
  const totalDays = Math.floor(diffMs / 86400000);

  if (totalDays >= 1) {
    const remainingHours = Math.floor((diffMs % 86400000) / 3600000);
    return remainingHours > 0
      ? `${totalDays}d${remainingHours}h`
      : `${totalDays}d`;
  }
  if (totalHours >= 1) {
    const remainingMinutes = Math.floor((diffMs % 3600000) / 60000);
    return remainingMinutes > 0
      ? `${totalHours}h${remainingMinutes}m`
      : `${totalHours}h`;
  }
  return `${Math.max(1, totalMinutes)}m`;
}

export default function ConnectionRow({
  index,
  connection,
  proxyPools,
  isOAuth,
  isFirst,
  isLast,
  onMoveUp,
  onMoveDown,
  onToggleActive,
  onUpdateProxy,
  onEdit,
  onDelete,
  oneByOneStatus = null,
  manualRefreshStatus = null,
  disablePriorityControls = false,
  isSelected = false,
  onSelectChange = null,
  onWarmup = null,
  warmupStatus = null,
  onViewJson = null,
  autoPing = null,
}) {
  const [showProxyDropdown, setShowProxyDropdown] = useState(false);
  const [updatingProxy, setUpdatingProxy] = useState(false);
  const [showWarmupDropdown, setShowWarmupDropdown] = useState(false);
  const proxyDropdownRef = useRef(null);
  const proxyBtnRef = useRef(null);
  const [proxyDropdownStyle, setProxyDropdownStyle] = useState(null);
  const warmupDropdownRef = useRef(null);

  const proxyPoolMap = new Map(
    (proxyPools || []).map((pool) => [pool.id, pool]),
  );
  const boundProxyPoolId = connection.providerSpecificData?.proxyPoolId || null;
  const boundProxyPool = boundProxyPoolId
    ? proxyPoolMap.get(boundProxyPoolId)
    : null;
  const hasLegacyProxy =
    connection.providerSpecificData?.connectionProxyEnabled === true &&
    !!connection.providerSpecificData?.connectionProxyUrl;
  const hasAnyProxy = !!boundProxyPoolId || hasLegacyProxy;
  const proxyDisplayText = boundProxyPool
    ? `Pool: ${boundProxyPool.name}`
    : boundProxyPoolId
      ? `Pool: ${boundProxyPoolId} (inactive/missing)`
      : hasLegacyProxy
        ? `Legacy: ${connection.providerSpecificData?.connectionProxyUrl}`
        : "";

  let maskedProxyUrl = "";
  if (
    boundProxyPool?.proxyUrl ||
    connection.providerSpecificData?.connectionProxyUrl
  ) {
    const rawProxyUrl =
      boundProxyPool?.proxyUrl ||
      connection.providerSpecificData?.connectionProxyUrl;
    try {
      const parsed = new URL(rawProxyUrl);
      maskedProxyUrl = `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}`;
    } catch {
      maskedProxyUrl = rawProxyUrl;
    }
  }

  const noProxyText =
    boundProxyPool?.noProxy ||
    connection.providerSpecificData?.connectionNoProxy ||
    "";
  const autoPingTooltip = (() => {
    if (!autoPing) return "";
    const activeModes = [];
    if (autoPing.reactiveOn) activeModes.push("On reset");
    if (autoPing.scheduleOn) activeModes.push(`Scheduled (${autoPing.scheduleSummary || "active"})`);
    if (activeModes.length > 0) {
      return `Auto-ping active: ${activeModes.join(" + ")}. Click to configure.`;
    }
    return autoPing.provider === "codex"
      ? "Auto-starts the next 5h Codex window after reset or on schedule. Click to configure."
      : "Auto-starts a new window on quota reset or fixed schedule. Click to configure.";
  })();

  let proxyBadgeVariant = "default";
  if (boundProxyPool?.isActive === true) {
    proxyBadgeVariant = "success";
  } else if (boundProxyPoolId || hasLegacyProxy) {
    proxyBadgeVariant = "error";
  }

  // Render via portal + fixed positioning so ancestor overflow (scrollable
  // connections list) can't clip the dropdown
  const toggleProxyDropdown = () => {
    if (showProxyDropdown) {
      setShowProxyDropdown(false);
      return;
    }
    const rect = proxyBtnRef.current?.getBoundingClientRect();
    if (!rect) {
      setShowProxyDropdown(true);
      return;
    }
    const estimatedHeight = ((proxyPools?.length || 0) + 1) * 34 + 8;
    const spaceBelow = window.innerHeight - rect.bottom;
    const flipUp = spaceBelow < estimatedHeight && rect.top > spaceBelow;
    setProxyDropdownStyle({
      position: "fixed",
      right: window.innerWidth - rect.right,
      ...(flipUp
        ? { bottom: window.innerHeight - rect.top + 4, maxHeight: Math.max(rect.top - 8, 120) }
        : { top: rect.bottom + 4, maxHeight: Math.max(spaceBelow - 8, 120) }),
    });
    setShowProxyDropdown(true);
  };

  // Close dropdown when clicking outside, scrolling, or resizing
  useEffect(() => {
    if (!showProxyDropdown) return;
    const handleClick = (e) => {
      if (
        proxyDropdownRef.current?.contains(e.target) ||
        proxyBtnRef.current?.contains(e.target)
      ) return;
      setShowProxyDropdown(false);
    };
    const close = () => setShowProxyDropdown(false);
    document.addEventListener("mousedown", handleClick);
    window.addEventListener("resize", close);
    document.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      window.removeEventListener("resize", close);
      document.removeEventListener("scroll", close, true);
    };
  }, [showProxyDropdown]);

  // Close warmup dropdown when clicking outside
  useEffect(() => {
    if (!showWarmupDropdown) return;
    const handler = (e) => {
      if (
        warmupDropdownRef.current &&
        !warmupDropdownRef.current.contains(e.target)
      ) {
        setShowWarmupDropdown(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showWarmupDropdown]);

  const handleSelectProxy = async (poolId) => {
    setUpdatingProxy(true);
    try {
      await onUpdateProxy(poolId === "__none__" ? null : poolId);
    } finally {
      setUpdatingProxy(false);
      setShowProxyDropdown(false);
    }
  };

  const rowAuthType = connection.authType || (isOAuth ? "oauth" : "apikey");
  const isOAuthConnection = rowAuthType === "oauth";
  const isCookieConnection = rowAuthType === "cookie";
  const authIcon = isCookieConnection
    ? "cookie"
    : isOAuthConnection
      ? "lock"
      : "key";
  const authLabel = isOAuthConnection
    ? "OAuth"
    : isCookieConnection
      ? "Cookie"
      : "API Key";
  const codexPlan =
    connection.provider === "codex" &&
    typeof connection.providerSpecificData?.chatgptPlanType === "string"
      ? connection.providerSpecificData.chatgptPlanType.trim()
      : "";
  const isEmail = (v) =>
    typeof v === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
  const displayName =
    connection.name?.trim() ||
    connection.email?.trim() ||
    connection.displayName?.trim() ||
    (isOAuthConnection
      ? "OAuth Account"
      : isCookieConnection
        ? "Cookie Account"
        : "API Key");
  const secondaryDisplayName =
    connection.name?.trim() &&
    connection.email?.trim() &&
    connection.name.trim() !== connection.email.trim()
      ? connection.email.trim()
      : connection.name?.trim() &&
          connection.displayName?.trim() &&
          connection.name.trim() !== connection.displayName.trim()
        ? connection.displayName.trim()
        : null;
  const formattedExpiresAt = formatVietnameseExpiresAt(connection.expiresAt);
  const remainingExpiresAt = formatRemainingExpiresAt(connection.expiresAt);

  // Use useState + useEffect for impure Date.now() to avoid calling during render
  const [isCooldown, setIsCooldown] = useState(false);

  // Get earliest model lock timestamp (useEffect handles the Date.now() comparison)
  const modelLockUntil =
    Object.entries(connection)
      .filter(([k]) => k.startsWith("modelLock_"))
      .map(([, v]) => v)
      .filter((v) => !!v)
      .sort()[0] || null;

  useEffect(() => {
    const checkCooldown = () => {
      const until =
        Object.entries(connection)
          .filter(([k]) => k.startsWith("modelLock_"))
          .map(([, v]) => v)
          .filter((v) => v && new Date(v).getTime() > Date.now())
          .sort()[0] || null;
      setIsCooldown(!!until);
    };

    checkCooldown();
    const interval = modelLockUntil ? setInterval(checkCooldown, 1000) : null;
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [modelLockUntil]); // eslint-disable-line react-hooks/exhaustive-deps

  // Determine effective status (override unavailable if cooldown expired, or fallback unknown/disabled to active when account is ON)
  const effectiveStatus =
    connection.testStatus === "unavailable" && !isCooldown
      ? "active"
      : (!connection.testStatus ||
          connection.testStatus === "unknown" ||
          connection.testStatus === "disabled") &&
        connection.isActive !== false
        ? "active"
        : connection.testStatus;

  const isCodexReauthRequired =
    connection.provider === "codex" &&
    (connection.testStatus === "401" ||
      [
        "401",
        "refresh_token_expired",
        "refresh_token_reused",
        "refresh_token_invalidated",
        "invalid_grant",
      ].includes(connection.errorCode));
  const displayedStatus = isCodexReauthRequired ? "401" : effectiveStatus;

  const getStatusVariant = () => {
    if (isCodexReauthRequired) return "error";
    if (connection.isActive === false) return "default";
    if (displayedStatus === "active" || displayedStatus === "success")
      return "success";
    if (
      displayedStatus === "401" ||
      displayedStatus === "error" ||
      displayedStatus === "expired" ||
      displayedStatus === "unavailable"
    )
      return "error";
    return "default";
  };

  const getOneByOneVariant = () => {
    if (!oneByOneStatus) return "default";
    if (oneByOneStatus.state === "success") return "success";
    if (oneByOneStatus.state === "failed") return "error";
    if (oneByOneStatus.state === "testing") return "primary";
    return "default";
  };

  const getOneByOneLabel = () => {
    if (!oneByOneStatus) return null;
    if (oneByOneStatus.state === "queued") return "queued";
    if (oneByOneStatus.state === "testing") return "testing";
    if (oneByOneStatus.state === "success") return "success";
    if (oneByOneStatus.state === "failed")
      return oneByOneStatus.error
        ? `failed: ${oneByOneStatus.error}`
        : "failed";
    return null;
  };

  const getManualRefreshVariant = () => {
    if (!manualRefreshStatus) return "default";
    if (manualRefreshStatus.state === "success") return "success";
    if (manualRefreshStatus.state === "failed") return "error";
    if (manualRefreshStatus.state === "refreshing") return "primary";
    return "default";
  };

  const getManualRefreshLabel = () => {
    if (!manualRefreshStatus) return null;
    if (manualRefreshStatus.state === "refreshing") return "refreshing";
    if (manualRefreshStatus.state === "success") return "refreshed";
    if (manualRefreshStatus.state === "failed")
      return manualRefreshStatus.error
        ? `refresh failed: ${manualRefreshStatus.error}`
        : "refresh failed";
    return null;
  };

  const isRefreshed = manualRefreshStatus?.state === "success";

  return (
    <div
      className={`group flex min-w-0 flex-col gap-3 rounded-lg p-2 transition-all duration-500 sm:flex-row sm:items-center sm:justify-between ${isRefreshed ? "bg-green-500/10 dark:bg-green-500/5 ring-1 ring-green-500/30" : "hover:bg-black/[0.02] dark:hover:bg-white/[0.02]"} ${connection.isActive === false ? "opacity-60" : ""}`}
    >
      <div className="flex min-w-0 flex-1 items-start gap-2 sm:items-center sm:gap-3">
        {/* Row Number (STT) */}
        {index !== undefined && (
          <span
            className="shrink-0 text-xs font-mono font-semibold text-text-muted/60 min-w-[20px] text-center"
            title={`Row #${index + 1}`}
          >
            {index + 1}
          </span>
        )}
        {/* Priority arrows */}
        <div className="flex shrink-0 flex-col">
          <label className="mb-1 flex items-center justify-center">
            <input
              type="checkbox"
              checked={isSelected}
              onClick={(e) => {
                onSelectChange?.(e.target.checked, e.shiftKey);
              }}
              onChange={() => {}}
              className="rounded border-border"
              title="Select this account for batch actions"
            />
          </label>
          <button
            onClick={onMoveUp}
            disabled={disablePriorityControls || isFirst}
            className={`p-0.5 rounded ${disablePriorityControls || isFirst ? "text-text-muted/30 cursor-not-allowed" : "hover:bg-sidebar text-text-muted hover:text-primary"}`}
          >
            <span className="material-symbols-outlined text-sm">
              keyboard_arrow_up
            </span>
          </button>
          <button
            onClick={onMoveDown}
            disabled={disablePriorityControls || isLast}
            className={`p-0.5 rounded ${disablePriorityControls || isLast ? "text-text-muted/30 cursor-not-allowed" : "hover:bg-sidebar text-text-muted hover:text-primary"}`}
          >
            <span className="material-symbols-outlined text-sm">
              keyboard_arrow_down
            </span>
          </button>
        </div>
        <span className="material-symbols-outlined shrink-0 text-base text-text-muted">
          {authIcon}
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium truncate">{displayName}</p>
          {secondaryDisplayName && (
            <p className="text-xs text-text-muted truncate">
              {secondaryDisplayName}
            </p>
          )}
          {formattedExpiresAt && (
            <div className="mt-1 text-xs text-text-muted">
              Expire at: {formattedExpiresAt}
              {remainingExpiresAt ? ` (${remainingExpiresAt})` : ""}
            </div>
          )}
          {/* Row 1 — Status badges (static connection properties) */}
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5">
            <Badge variant={getStatusVariant()} size="sm" dot>
              {connection.isActive === false
                ? "disabled"
                : displayedStatus || "Unknown"}
            </Badge>
            <Badge variant="default" size="sm">
              {authLabel}
            </Badge>
            {codexPlan && (
              <Badge variant="primary" size="sm" className="capitalize">
                {codexPlan}
              </Badge>
            )}
            {hasAnyProxy && (
              <Badge variant={proxyBadgeVariant} size="sm">
                Proxy
              </Badge>
            )}
            {connection.providerSpecificData?.autoRefreshEnabled === true && (
              <Badge variant="default" size="sm">
                auto refresh
              </Badge>
            )}
            {/* Priority — float to the right of status row */}
            <span className="ml-auto text-xs text-text-muted">
              #{connection.priority}
              {connection.globalPriority && (
                <span className="ml-1.5">
                  Auto: {connection.globalPriority}
                </span>
              )}
            </span>
          </div>

          {/* Row 2 — Events badges (transient/dynamic states) */}
          {(connection.warmedUp === true ||
            warmupStatus?.state === "refreshing" ||
            warmupStatus?.state === "failed" ||
            isCooldown ||
            getOneByOneLabel() ||
            getManualRefreshLabel()) && (
            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5">
              {connection.warmedUp === true && (
                <Badge
                  variant="success"
                  size="sm"
                  title={
                    connection.warmedUpAt
                      ? `Warmed up at: ${formatVietnameseExpiresAt(connection.warmedUpAt)}`
                      : "Warmed up"
                  }
                >
                  Warmed
                </Badge>
              )}
              {warmupStatus?.state === "refreshing" && (
                <Badge variant="primary" size="sm">
                  Warming...
                </Badge>
              )}
              {warmupStatus?.state === "failed" && (
                <Badge variant="error" size="sm" title={warmupStatus.error}>
                  Warmup failed
                </Badge>
              )}
              {isCooldown && connection.isActive !== false && (
                <CooldownTimer until={modelLockUntil} />
              )}
              {getOneByOneLabel() && (
                <Badge variant={getOneByOneVariant()} size="sm">
                  {oneByOneStatus?.state === "failed"
                    ? "failed"
                    : getOneByOneLabel()}
                </Badge>
              )}
              {getManualRefreshLabel() && (
                <Badge variant={getManualRefreshVariant()} size="sm">
                  {manualRefreshStatus?.state === "failed"
                    ? "refresh failed"
                    : getManualRefreshLabel()}
                </Badge>
              )}
            </div>
          )}

          {/* Row 3 — Error details (conditional, visually distinct) */}
          {connection.lastError ||
          (oneByOneStatus?.state === "failed" && oneByOneStatus?.error) ||
          (manualRefreshStatus?.state === "failed" &&
            manualRefreshStatus?.error) ? (
            <div className="mt-1 flex flex-col gap-0.5 border-l-2 border-red-500/60 pl-2">
              {connection.lastError && (
                <span className="break-words text-xs text-red-500">
                  {connection.lastError}
                </span>
              )}
              {oneByOneStatus?.state === "failed" && oneByOneStatus?.error && (
                <span
                  className="break-words text-xs text-red-500"
                  title={oneByOneStatus.error}
                >
                  {oneByOneStatus.error}
                </span>
              )}
              {manualRefreshStatus?.state === "failed" &&
                manualRefreshStatus?.error && (
                  <span
                    className="break-words text-xs text-red-500"
                    title={manualRefreshStatus.error}
                  >
                    {manualRefreshStatus.error}
                  </span>
                )}
            </div>
          ) : null}
          {hasAnyProxy && (
            <div className="mt-1 flex items-center gap-2 flex-wrap">
              <span
                className="max-w-full truncate text-[11px] text-text-muted sm:max-w-[420px]"
                title={proxyDisplayText}
              >
                {proxyDisplayText}
              </span>
              {maskedProxyUrl && (
                <code className="max-w-full truncate rounded bg-black/5 px-1 py-0.5 font-mono text-[10px] text-text-muted dark:bg-white/5 sm:max-w-[260px]">
                  {maskedProxyUrl}
                </code>
              )}
              {noProxyText && (
                <span
                  className="max-w-full truncate text-[11px] text-text-muted sm:max-w-[320px]"
                  title={noProxyText}
                >
                  no_proxy: {noProxyText}
                </span>
              )}
            </div>
          )}
        </div>
      </div>
      <div className="flex w-full items-center justify-between gap-2 sm:w-auto sm:justify-end">
        <div className="grid flex-1 grid-cols-3 gap-1 sm:flex sm:flex-none">
          {/* Proxy button with inline dropdown */}
          {(proxyPools || []).length > 0 && (
            <div>
              <button
                ref={proxyBtnRef}
                onClick={toggleProxyDropdown}
                className={`flex w-full flex-col items-center rounded px-2 py-1 transition-colors hover:bg-black/5 dark:hover:bg-white/5 ${hasAnyProxy ? "text-primary" : "text-text-muted hover:text-primary"}`}
                disabled={updatingProxy}
              >
                <span className="material-symbols-outlined text-[18px]">
                  {updatingProxy ? "progress_activity" : "lan"}
                </span>
                <span className="text-[10px] leading-tight">Proxy</span>
              </button>
              {showProxyDropdown && createPortal(
                <div
                  ref={proxyDropdownRef}
                  style={proxyDropdownStyle}
                  className="z-50 max-w-[78vw] min-w-[160px] overflow-y-auto rounded-lg border border-border bg-bg py-1 shadow-lg"
                >
                  <button
                    onClick={() => handleSelectProxy("__none__")}
                    className={`w-full text-left px-3 py-1.5 text-sm hover:bg-black/5 dark:hover:bg-white/5 ${!boundProxyPoolId ? "text-primary font-medium" : "text-text-main"}`}
                  >
                    None
                  </button>
                  {(proxyPools || []).map((pool) => (
                    <button
                      key={pool.id}
                      onClick={() => handleSelectProxy(pool.id)}
                      className={`w-full text-left px-3 py-1.5 text-sm hover:bg-black/5 dark:hover:bg-white/5 ${boundProxyPoolId === pool.id ? "text-primary font-medium" : "text-text-main"}`}
                    >
                      {pool.name}
                    </button>
                  ))}
                </div>,
                document.body
              )}
            </div>
          )}
          {autoPing && (
            <Tooltip text={autoPingTooltip}>
              <button
                type="button"
                onClick={() => (autoPing.onConfigure ? autoPing.onConfigure() : autoPing.onToggle?.(!autoPing.on))}
                disabled={autoPing.saving}
                className={`flex w-full flex-col items-center rounded px-2 py-1 transition-colors hover:bg-black/5 dark:hover:bg-white/5 ${autoPing.saving ? "cursor-not-allowed text-text-muted/30" : (autoPing.isActive ?? autoPing.on) ? "text-primary" : "text-text-muted hover:text-primary"}`}
              >
                <span className="material-symbols-outlined text-[18px]">
                  {autoPing.saving ? "progress_activity" : "bolt"}
                </span>
                <span className="text-[10px] leading-tight">Auto-ping</span>
              </button>
            </Tooltip>
          )}
          <div ref={warmupDropdownRef} className="relative">
            <button
              onClick={() => {
                if (warmupStatus?.state !== "refreshing") {
                  setShowWarmupDropdown((prev) => !prev);
                }
              }}
              disabled={warmupStatus?.state === "refreshing"}
              className={`flex flex-col items-center rounded px-2 py-1 ${warmupStatus?.state === "refreshing" ? "text-text-muted/30 cursor-not-allowed" : "text-orange-500 hover:bg-orange-500/10 hover:text-orange-600"}`}
              title="Warmup account"
            >
              <span className="material-symbols-outlined text-[18px]">
                {warmupStatus?.state === "refreshing"
                  ? "progress_activity"
                  : "local_fire_department"}
              </span>
              <span className="text-[10px] leading-tight">Warmup</span>
            </button>
            {showWarmupDropdown && (
              <div className="absolute right-0 top-full z-50 mt-1 min-w-[160px] rounded-lg border border-border bg-bg py-1 shadow-lg">
                <button
                  onClick={() => {
                    onWarmup({ intensity: "light" });
                    setShowWarmupDropdown(false);
                  }}
                  className="w-full text-left px-3 py-1.5 text-xs hover:bg-black/5 dark:hover:bg-white/5 text-text-main flex items-center gap-1.5"
                >
                  <span className="material-symbols-outlined text-[14px] text-green-500">
                    bolt
                  </span>
                  Light (1 token)
                </button>
                <button
                  onClick={() => {
                    onWarmup({ intensity: "medium" });
                    setShowWarmupDropdown(false);
                  }}
                  className="w-full text-left px-3 py-1.5 text-xs hover:bg-black/5 dark:hover:bg-white/5 text-text-main flex items-center gap-1.5"
                >
                  <span className="material-symbols-outlined text-[14px] text-orange-500">
                    local_fire_department
                  </span>
                  Medium (~500 tokens)
                </button>
                <button
                  onClick={() => {
                    if (
                      confirm(
                        "WARNING: Heavy warmup will consume ~2,000 tokens of your actual quota and may cost money. Proceed?",
                      )
                    ) {
                      onWarmup({ intensity: "heavy" });
                    }
                    setShowWarmupDropdown(false);
                  }}
                  className="w-full text-left px-3 py-1.5 text-xs hover:bg-black/5 dark:hover:bg-white/5 text-text-main flex items-center gap-1.5"
                >
                  <span className="material-symbols-outlined text-[14px] text-red-500">
                    warning
                  </span>
                  Heavy (~2,000 tokens)
                </button>
              </div>
            )}
          </div>
          {onViewJson && (
            <button
              onClick={onViewJson}
              className="flex flex-col items-center rounded px-2 py-1 text-text-muted hover:bg-black/5 hover:text-primary dark:hover:bg-white/5"
              title="Export raw JSON"
            >
              <span className="material-symbols-outlined text-[18px]">
                terminal
              </span>
              <span className="text-[10px] leading-tight">Export</span>
            </button>
          )}
          <Link
            href={`/dashboard/usage?tab=overview&connectionId=${encodeURIComponent(connection.id)}`}
            className="flex flex-col items-center rounded px-2 py-1 text-text-muted hover:bg-black/5 hover:text-primary dark:hover:bg-white/5"
            title="View Usage & Analytics"
            aria-label="View Usage & Analytics"
            target="_blank"
            rel="noopener noreferrer"
          >
            <span className="material-symbols-outlined text-[18px]">
              analytics
            </span>
            <span className="text-[10px] leading-tight">Usage</span>
          </Link>
          <button
            onClick={onEdit}
            className="flex flex-col items-center rounded px-2 py-1 text-text-muted hover:bg-black/5 hover:text-primary dark:hover:bg-white/5"
          >
            <span className="material-symbols-outlined text-[18px]">edit</span>
            <span className="text-[10px] leading-tight">Edit</span>
          </button>
          <button
            onClick={onDelete}
            className="flex flex-col items-center rounded px-2 py-1 text-red-500 hover:bg-red-500/10"
          >
            <span className="material-symbols-outlined text-[18px]">
              delete
            </span>
            <span className="text-[10px] leading-tight">Delete</span>
          </button>
        </div>
        <Toggle
          size="sm"
          checked={connection.isActive ?? true}
          onChange={onToggleActive}
          title={
            (connection.isActive ?? true)
              ? "Disable connection"
              : "Enable connection"
          }
        />
      </div>
    </div>
  );
}

ConnectionRow.propTypes = {
  index: PropTypes.number,
  connection: PropTypes.shape({
    id: PropTypes.string,
    name: PropTypes.string,
    email: PropTypes.string,
    displayName: PropTypes.string,
    provider: PropTypes.string,
    providerSpecificData: PropTypes.shape({
      chatgptPlanType: PropTypes.string,
    }),
    modelLockUntil: PropTypes.string,
    testStatus: PropTypes.string,
    isActive: PropTypes.bool,
    lastError: PropTypes.string,
    priority: PropTypes.number,
    globalPriority: PropTypes.number,
  }).isRequired,
  proxyPools: PropTypes.arrayOf(
    PropTypes.shape({
      id: PropTypes.string,
      name: PropTypes.string,
      proxyUrl: PropTypes.string,
      noProxy: PropTypes.string,
      isActive: PropTypes.bool,
    }),
  ),
  isOAuth: PropTypes.bool.isRequired,
  isFirst: PropTypes.bool.isRequired,
  isLast: PropTypes.bool.isRequired,
  onMoveUp: PropTypes.func.isRequired,
  onMoveDown: PropTypes.func.isRequired,
  onToggleActive: PropTypes.func.isRequired,
  onUpdateProxy: PropTypes.func,
  onEdit: PropTypes.func.isRequired,
  onDelete: PropTypes.func.isRequired,
  oneByOneStatus: PropTypes.shape({
    state: PropTypes.string,
    error: PropTypes.string,
  }),
  manualRefreshStatus: PropTypes.shape({
    state: PropTypes.string,
    error: PropTypes.string,
  }),
  disablePriorityControls: PropTypes.bool,
  isSelected: PropTypes.bool,
  onSelectChange: PropTypes.func,
  onWarmup: PropTypes.func,
  warmupStatus: PropTypes.shape({
    state: PropTypes.string,
    error: PropTypes.string,
  }),
  onViewJson: PropTypes.func,
  autoPing: PropTypes.shape({
    isActive: PropTypes.bool,
    on: PropTypes.bool,
    provider: PropTypes.string,
    reactiveOn: PropTypes.bool,
    scheduleOn: PropTypes.bool,
    scheduleSummary: PropTypes.string,
    onConfigure: PropTypes.func,
    onToggle: PropTypes.func,
    saving: PropTypes.bool,
  }),
};
