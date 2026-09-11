"use client";

import Link from "next/link";
import ProviderIcon from "@/shared/components/ProviderIcon";
import Badge from "@/shared/components/Badge";
import Card from "@/shared/components/Card";
import Toggle from "@/shared/components/Toggle";
import Tooltip from "@/shared/components/Tooltip";
import QuotaTable from "../../QuotaTable";
import AntigravityQuotaGroups from "./antigravity-quota-groups";
import { useState } from "react";
import {
  getConnectionLabel,
  getCodexResetCreditCount,
  kiroMethodLabel,
  kiroRegion,
} from "./helpers";

export default function ProviderConnectionCard({
  conn,
  quota,
  isLoading,
  error,
  deletingId,
  togglingId,
  copied,
  copy,
  handleViewCodexResetCredits,
  onRequestCodexReset,
  resettingLimitId,
  autoPingSaving,
  autoPingEnabled,
  onToggleAutoPing,
  refreshProvider,
  setSelectedConnection,
  setShowEditModal,
  handleDeleteConnection,
  handleToggleConnectionActive,
  quotaSortMode,
}) {
  const [viewMode, setViewMode] = useState("groups"); // 'groups' | 'models'
  const isInactive = conn.isActive === false;
  const isAntigravity = conn.provider === "antigravity";
  const hasQuotaGroups =
    isAntigravity &&
    Array.isArray(quota?.quotaGroups) &&
    quota.quotaGroups.length > 0;
  const plan = typeof quota?.plan === "string" ? quota.plan.trim() : "";
  const codexPlan =
    conn.provider === "codex" && plan && plan.toLowerCase() !== "unknown"
      ? plan
      : "";
  // Grok CLI / xAI OAuth: show plan + pay-as-you-go like CLIProxyAPI / grok-pager
  const isGrokQuotaProvider = ["grok-cli", "gcli", "xai"].includes(
    conn.provider,
  );
  const grokPlan =
    isGrokQuotaProvider && plan && plan.toLowerCase() !== "unknown"
      ? plan
      : "";
  const payAsYouGo =
    typeof quota?.payAsYouGo === "string" ? quota.payAsYouGo.trim() : "";
  const showPayAsYouGo = isGrokQuotaProvider && !!payAsYouGo;
  const isResettingLimit = resettingLimitId === conn.id;
  const rowBusy =
    deletingId === conn.id || togglingId === conn.id || isResettingLimit;
  const resetCreditCount = getCodexResetCreditCount(quota);

  return (
    <Card
      padding="none"
      className={`min-w-0 ${isInactive ? "opacity-60" : ""}`}
    >
      <div className="px-3 py-2 border-b border-black/10 dark:border-white/10">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-8 h-8 shrink-0 rounded-md flex items-center justify-center overflow-hidden">
              <ProviderIcon
                src={`/providers/${conn.provider}.png`}
                alt={conn.provider}
                size={32}
                className="object-contain"
                fallbackText={
                  conn.provider?.slice(0, 2).toUpperCase() || "PR"
                }
              />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 min-w-0">
                <h3 className="text-sm font-semibold text-text-primary capitalize truncate">
                  {conn.provider}
                </h3>
                {codexPlan && (
                  <Badge variant="primary" size="sm" className="capitalize">
                    {codexPlan}
                  </Badge>
                )}
                {grokPlan && (
                  <Badge variant="primary" size="sm" className="capitalize">
                    {grokPlan}
                  </Badge>
                )}
                {conn.priority !== undefined &&
                  conn.priority !== null && (
                    <span
                      className="shrink-0 rounded bg-black/5 px-1.5 py-0.5 text-[10px] font-medium text-text-muted dark:bg-white/5"
                      title={`Priority: ${conn.priority}`}
                    >
                      #{conn.priority}
                    </span>
                  )}
              </div>
              {getConnectionLabel(conn) ? (
                <p className="text-xs text-text-muted truncate">
                  {getConnectionLabel(conn)}
                </p>
              ) : null}
              {conn.provider === "kiro" && (
                <div className="mt-1 flex flex-wrap items-center gap-1">
                  <span className="rounded-full bg-brand-500/10 px-2 py-0.5 text-[10px] font-semibold text-brand-600 dark:text-brand-300">
                    {kiroMethodLabel(conn)}
                  </span>
                  {kiroRegion(conn) && (
                    <span className="rounded-full bg-blue-500/10 px-2 py-0.5 text-[10px] font-semibold text-blue-600 dark:text-blue-400">
                      {kiroRegion(conn)}
                    </span>
                  )}
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                      isInactive
                        ? "bg-surface-2 text-text-muted"
                        : conn.testStatus === "active" || conn.testStatus === "success"
                          ? "bg-green-500/10 text-green-600 dark:text-green-400"
                          : conn.testStatus === "error" || conn.testStatus === "expired" || conn.testStatus === "unavailable"
                            ? "bg-red-500/10 text-red-600 dark:text-red-400"
                            : "bg-surface-2 text-text-muted"
                    }`}
                  >
                    {isInactive ? "disabled" : conn.testStatus || "unknown"}
                  </span>
                  {conn.providerSpecificData?.profileArn && (
                    <button
                      type="button"
                      onClick={() => copy(conn.providerSpecificData.profileArn, conn.id)}
                      title={conn.providerSpecificData.profileArn}
                      className="inline-flex max-w-full items-center gap-1 rounded-full border border-border-subtle px-2 py-0.5 text-[10px] text-text-muted transition-colors hover:text-primary"
                    >
                      <span className="material-symbols-outlined text-[12px]">
                        {copied === conn.id ? "check" : "content_copy"}
                      </span>
                      <code className="truncate font-mono">
                        {conn.providerSpecificData.profileArn}
                      </code>
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            {conn.provider === "codex" && (
              <>
                <Tooltip
                  text={
                    resetCreditCount > 0
                      ? `Use one Codex reset credit. Available: ${resetCreditCount}`
                      : "No Codex reset credits available"
                  }
                >
                  <button
                    type="button"
                    onClick={() => onRequestCodexReset(conn, resetCreditCount)}
                    disabled={resetCreditCount <= 0 || isLoading || rowBusy || isResettingLimit}
                    aria-label={`Use one Codex reset credit. ${resetCreditCount} available.`}
                    className="flex h-8 min-w-10 items-center justify-center gap-1 rounded-lg border border-primary/30 bg-primary/5 px-2 text-[11px] font-medium tabular-nums text-primary transition-colors hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <span className={`material-symbols-outlined text-[15px] ${isResettingLimit ? "animate-spin" : ""}`}>
                      {isResettingLimit ? "progress_activity" : "restart_alt"}
                    </span>
                    <span>{resetCreditCount}</span>
                  </button>
                </Tooltip>
                <Tooltip text="View Codex reset credit expiry">
                  <button
                    type="button"
                    onClick={() => handleViewCodexResetCredits(conn)}
                    disabled={isLoading || rowBusy || isResettingLimit}
                    aria-label="View Codex reset credit expiry"
                    className="flex h-8 w-8 items-center justify-center rounded-lg border border-black/10 text-text-muted transition-colors hover:bg-black/5 hover:text-primary disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/10 dark:hover:bg-white/5"
                  >
                    <span className="material-symbols-outlined text-[17px]">
                      schedule
                    </span>
                  </button>
                </Tooltip>
              </>
            )}
            {(conn.provider === "claude" || conn.provider === "codex") &&
              conn.authType === "oauth" && (
              <Tooltip text={autoPingEnabled ? "Disable quota auto-ping" : "Enable quota auto-ping after reset"}>
                <button
                  type="button"
                  onClick={() => onToggleAutoPing(conn)}
                  disabled={isLoading || rowBusy || isResettingLimit || autoPingSaving}
                  aria-label="Toggle quota auto-ping"
                  className={`flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-black/5 dark:hover:bg-white/5 ${autoPingEnabled ? "text-primary" : "text-text-muted"}`}
                >
                  <span className={`material-symbols-outlined text-[18px] ${autoPingSaving ? "animate-spin" : ""}`}>
                    {autoPingSaving ? "progress_activity" : "bolt"}
                  </span>
                </button>
              </Tooltip>
            )}
            <div className="flex items-center gap-0.5">
              <button
                type="button"
                onClick={() =>
                  setViewMode((prev) => (prev === "groups" ? "models" : "groups"))
                }
                disabled={isLoading || rowBusy}
                aria-label={
                  viewMode === "groups"
                    ? "Switch to model quota list"
                    : "Switch to grouped summary"
                }
                className="flex h-8 w-8 items-center justify-center rounded-lg text-text-muted hover:bg-black/5 hover:text-primary dark:hover:bg-white/5 transition-colors disabled:opacity-50"
                title={
                  viewMode === "groups"
                    ? "View per-model quotas"
                    : "View grouped summary (Weekly & 5h)"
                }
              >
                <span className="material-symbols-outlined text-[18px]">
                  {viewMode === "groups" ? "table_rows" : "donut_large"}
                </span>
              </button>
              <Link
                href={`/dashboard/usage?tab=overview&connectionId=${encodeURIComponent(conn.id)}`}
                aria-label="View Usage & Analytics"
                className="flex h-8 w-8 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-black/5 hover:text-primary dark:hover:bg-white/5"
                title="View Usage & Analytics"
                target="_blank"
                rel="noopener noreferrer"
              >
                <span className="material-symbols-outlined text-[18px]">
                  analytics
                </span>
              </Link>
              <button
                type="button"
                onClick={() => refreshProvider(conn.id, conn.provider)}
                disabled={isLoading || rowBusy}
                aria-label="Refresh quota"
                className="flex h-8 w-8 items-center justify-center rounded-lg text-text-muted hover:bg-black/5 hover:text-primary dark:hover:bg-white/5 transition-colors disabled:opacity-50"
                title="Refresh quota"
              >
                <span
                  className={`material-symbols-outlined text-[18px] ${isLoading ? "animate-spin" : ""}`}
                >
                  refresh
                </span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setSelectedConnection(conn);
                  setShowEditModal(true);
                }}
                disabled={rowBusy}
                aria-label="Edit connection"
                className="flex h-8 w-8 items-center justify-center rounded-lg text-text-muted hover:bg-black/5 hover:text-primary dark:hover:bg-white/5 transition-colors disabled:opacity-50"
                title="Edit connection"
              >
                <span className="material-symbols-outlined text-[18px]">
                  edit
                </span>
              </button>
              <button
                type="button"
                onClick={() => handleDeleteConnection(conn.id)}
                disabled={rowBusy}
                aria-label="Delete connection"
                className="flex h-8 w-8 items-center justify-center rounded-lg text-red-500 hover:bg-red-500/10 transition-colors disabled:opacity-50"
                title="Delete connection"
              >
                <span
                  className={`material-symbols-outlined text-[18px] ${deletingId === conn.id ? "animate-pulse" : ""}`}
                >
                  delete
                </span>
              </button>
              <div
                className="flex h-8 items-center justify-center pl-1"
                title={
                  (conn.isActive ?? true)
                    ? "Disable connection"
                    : "Enable connection"
                }
              >
                <Toggle
                  size="sm"
                  checked={conn.isActive ?? true}
                  disabled={rowBusy}
                  onChange={(nextActive) =>
                    handleToggleConnectionActive(conn.id, nextActive)
                  }
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="px-2 py-1.5">
        {isLoading ? (
          <div className="text-center py-5 text-text-muted">
            <span className="material-symbols-outlined text-[28px] animate-spin">
              progress_activity
            </span>
          </div>
        ) : error ? (
          <div className="text-center py-5">
            <span className="material-symbols-outlined text-[28px] text-red-500">
              error
            </span>
            <p className="mt-1.5 text-xs text-text-muted">{error}</p>
          </div>
        ) : quota?.message ? (
          <div className="space-y-2 py-3 px-1">
            <p className="text-xs text-text-muted text-center">{quota.message}</p>
            {showPayAsYouGo && (
              <div className="flex items-center justify-center gap-1.5 text-[11px]">
                <span className="text-text-muted">Pay as you go</span>
                <Badge
                  variant={
                    payAsYouGo.toLowerCase() === "enabled"
                      ? "success"
                      : "default"
                  }
                  size="sm"
                >
                  {payAsYouGo}
                </Badge>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-1.5">
            {hasQuotaGroups && viewMode === "groups" ? (
              <AntigravityQuotaGroups quotaGroups={quota.quotaGroups} />
            ) : (
              <QuotaTable
                quotas={quota?.quotas}
                compact
                sortMode="default"
                showSortLabel={
                  conn.provider === "codex" && quotaSortMode !== "default"
                }
              />
            )}
            {showPayAsYouGo && (
              <div className="flex items-center justify-between gap-2 px-1.5 py-1 text-[11px]">
                <span className="text-text-muted">Pay as you go</span>
                <Badge
                  variant={
                    payAsYouGo.toLowerCase() === "enabled"
                      ? "success"
                      : "default"
                  }
                  size="sm"
                >
                  {payAsYouGo}
                </Badge>
              </div>
            )}
          </div>
        )}
      </div>

      {quota?.validation && (
        <div className="px-3 pb-2.5">
          <div className="p-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-xs text-amber-700 dark:text-amber-300 flex items-start gap-1.5 break-words">
            <span className="material-symbols-outlined text-[15px] shrink-0 mt-0.5 text-amber-600 dark:text-amber-400">
              warning
            </span>
            <div className="min-w-0 flex-1">
              <span className="font-semibold block">
                {quota.validation.message || "Verify your account to continue."}
              </span>
              {quota.validation.url && (
                <div className="mt-1 flex flex-wrap items-center gap-3">
                  <a
                    href={quota.validation.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 font-semibold text-amber-800 hover:text-amber-950 dark:text-amber-200 dark:hover:text-white underline underline-offset-2"
                  >
                    <span>{quota.validation.urlText || "Verify your account"}</span>
                    <span className="material-symbols-outlined text-[13px]">
                      open_in_new
                    </span>
                  </a>
                  {quota.validation.learnMoreUrl && (
                    <a
                      href={quota.validation.learnMoreUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-text-muted hover:text-text-primary text-[11px] underline"
                    >
                      Learn more
                    </a>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {conn.lastError && (
        <div className="px-3 pb-2.5">
          <div className="p-2 rounded-lg bg-red-500/5 border border-red-500/10 text-xs text-red-600 dark:text-red-400 flex items-start gap-1.5 break-words">
            <span className="material-symbols-outlined text-[14px] shrink-0 mt-0.5">
              error
            </span>
            <div className="min-w-0">
              <span className="font-semibold">Last Error: </span>
              {conn.lastError}
              {conn.lastErrorAt && (
                <span className="text-[10px] text-text-muted dark:text-text-muted/80 block mt-0.5">
                  {new Date(conn.lastErrorAt).toLocaleString()}
                </span>
              )}
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
