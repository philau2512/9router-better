"use client";

import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { getStatusVariant as getConnectionStatusVariant } from "@/shared/utils/connectionStatus";
import PropTypes from "prop-types";
import { Badge, Toggle, Tooltip } from "@/shared/components";
import CooldownTimer from "./CooldownTimer";

export default function ConnectionRow({ connection, proxyPools, isOAuth, isFirst, isLast, onMoveUp, onMoveDown, onToggleActive, onUpdateProxy, onEdit, onDelete, oneByOneStatus = null, autoPing = null }) {
  const [showProxyDropdown, setShowProxyDropdown] = useState(false);
  const [updatingProxy, setUpdatingProxy] = useState(false);
  const proxyDropdownRef = useRef(null);
  const proxyBtnRef = useRef(null);
  const [proxyDropdownStyle, setProxyDropdownStyle] = useState(null);

  const proxyPoolMap = new Map((proxyPools || []).map((pool) => [pool.id, pool]));
  const boundProxyPoolId = connection.providerSpecificData?.proxyPoolId || null;
  const boundProxyPool = boundProxyPoolId ? proxyPoolMap.get(boundProxyPoolId) : null;
  const hasLegacyProxy = connection.providerSpecificData?.connectionProxyEnabled === true && !!connection.providerSpecificData?.connectionProxyUrl;
  const hasAnyProxy = !!boundProxyPoolId || hasLegacyProxy;
  const proxyDisplayText = boundProxyPool
    ? `Pool: ${boundProxyPool.name}`
    : boundProxyPoolId
      ? `Pool: ${boundProxyPoolId} (inactive/missing)`
      : hasLegacyProxy
        ? `Legacy: ${connection.providerSpecificData?.connectionProxyUrl}`
        : "";
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

  let maskedProxyUrl = "";
  if (boundProxyPool?.proxyUrl || connection.providerSpecificData?.connectionProxyUrl) {
    const rawProxyUrl = boundProxyPool?.proxyUrl || connection.providerSpecificData?.connectionProxyUrl;
    try {
      const parsed = new URL(rawProxyUrl);
      maskedProxyUrl = `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}`;
    } catch {
      maskedProxyUrl = rawProxyUrl;
    }
  }

  const noProxyText = boundProxyPool?.noProxy || connection.providerSpecificData?.connectionNoProxy || "";

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

  const handleSelectProxy = async (poolId) => {
    setUpdatingProxy(true);
    try {
      await onUpdateProxy(poolId === "__none__" ? null : poolId);
    } finally {
      setUpdatingProxy(false);
      setShowProxyDropdown(false);
    }
  };

  const statusVariant = getConnectionStatusVariant(connection.isActive, connection.testStatus);
  const statusLabel = connection.isActive === false
    ? "Disabled"
    : connection.testStatus === "active" || connection.testStatus === "success"
      ? "Active"
      : connection.testStatus === "error"
        ? "Error"
        : connection.testStatus === "expired"
          ? "Expired"
          : connection.testStatus === "unavailable"
            ? "Unavailable"
            : "Unknown";

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-3.5 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-3 min-w-0">
        <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-1">
          <button
            onClick={onMoveUp}
            disabled={isFirst}
            className="flex h-5 w-5 items-center justify-center rounded text-text-muted hover:bg-black/5 hover:text-text-main disabled:opacity-30 disabled:hover:bg-transparent dark:hover:bg-white/5"
            title="Move up"
          >
            <span className="material-symbols-outlined text-[16px]">expand_less</span>
          </button>
          <button
            onClick={onMoveDown}
            disabled={isLast}
            className="flex h-5 w-5 items-center justify-center rounded text-text-muted hover:bg-black/5 hover:text-text-main disabled:opacity-30 disabled:hover:bg-transparent dark:hover:bg-white/5"
            title="Move down"
          >
            <span className="material-symbols-outlined text-[16px]">expand_more</span>
          </button>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-text-main truncate">{connection.name}</span>
            <Badge variant={statusVariant}>{statusLabel}</Badge>
            {oneByOneStatus?.state === "testing" && (
              <span className="inline-flex items-center gap-1 text-[11px] text-primary">
                <span className="material-symbols-outlined animate-spin text-[13px]">progress_activity</span>
                <span>Testing...</span>
              </span>
            )}
            {oneByOneStatus?.state === "success" && (
              <span className="inline-flex items-center gap-1 text-[11px] text-green-500">
                <span className="material-symbols-outlined text-[13px]">check_circle</span>
                <span>OK</span>
              </span>
            )}
            {oneByOneStatus?.state === "error" && (
              <span className="inline-flex items-center gap-1 text-[11px] text-red-500" title={oneByOneStatus.error}>
                <span className="material-symbols-outlined text-[13px]">error</span>
                <span className="truncate max-w-[200px]">{oneByOneStatus.error || "Failed"}</span>
              </span>
            )}
            {connection.modelLockUntil && (
              <CooldownTimer until={connection.modelLockUntil} />
            )}
            {connection.providerSpecificData?.chatgptPlanType && (
              <Badge variant="default">{connection.providerSpecificData.chatgptPlanType}</Badge>
            )}
            {hasAnyProxy && (
              <Badge
                variant={proxyBadgeVariant}
                title={maskedProxyUrl ? `${proxyDisplayText} (${maskedProxyUrl})${noProxyText ? ` | Bypass: ${noProxyText}` : ""}` : proxyDisplayText}
              >
                <span className="material-symbols-outlined mr-0.5 text-[11px]">lan</span>
                {proxyDisplayText}
              </Badge>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1 text-xs text-text-muted">
            {connection.displayName && connection.displayName !== connection.name && (
              <span>{connection.displayName}</span>
            )}
            {connection.email && (
              <span>{connection.email}</span>
            )}
            <span className="font-mono text-[10px]">P{connection.priority ?? 0}</span>
            {connection.globalPriority !== undefined && connection.globalPriority !== 0 && (
              <span className="font-mono text-[10px] text-primary">GP{connection.globalPriority}</span>
            )}
          </div>
          {connection.lastError && (
            <p className="mt-1 text-xs text-red-400 truncate max-w-md" title={connection.lastError}>
              {connection.lastError}
            </p>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 sm:justify-end">
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
                onClick={autoPing.onConfigure}
                className={`flex w-full flex-col items-center rounded px-2 py-1 transition-colors hover:bg-black/5 dark:hover:bg-white/5 ${autoPing.isActive ? "text-primary" : "text-text-muted hover:text-primary"}`}
              >
                <span className="material-symbols-outlined text-[18px]">bolt</span>
                <span className="text-[10px] leading-tight">Auto-ping</span>
              </button>
            </Tooltip>
          )}
          <button onClick={onEdit} className="flex flex-col items-center rounded px-2 py-1 text-text-muted hover:bg-black/5 hover:text-primary dark:hover:bg-white/5">
            <span className="material-symbols-outlined text-[18px]">edit</span>
            <span className="text-[10px] leading-tight">Edit</span>
          </button>
          <button onClick={onDelete} className="flex flex-col items-center rounded px-2 py-1 text-red-500 hover:bg-red-500/10">
            <span className="material-symbols-outlined text-[18px]">delete</span>
            <span className="text-[10px] leading-tight">Delete</span>
          </button>
        </div>
        <Toggle
          size="sm"
          checked={connection.isActive ?? true}
          onChange={onToggleActive}
          title={(connection.isActive ?? true) ? "Disable connection" : "Enable connection"}
        />
      </div>
    </div>
  );
}

ConnectionRow.propTypes = {
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
  proxyPools: PropTypes.arrayOf(PropTypes.shape({
    id: PropTypes.string,
    name: PropTypes.string,
    proxyUrl: PropTypes.string,
    noProxy: PropTypes.string,
    isActive: PropTypes.bool,
  })),
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
  autoPing: PropTypes.shape({
    isActive: PropTypes.bool,
    provider: PropTypes.string,
    reactiveOn: PropTypes.bool,
    scheduleOn: PropTypes.bool,
    scheduleSummary: PropTypes.string,
    onConfigure: PropTypes.func,
  }),
};
