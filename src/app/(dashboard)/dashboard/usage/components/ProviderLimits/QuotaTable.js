"use client";

import { useEffect, useMemo, useState } from "react";
import {
  formatResetTime,
  formatQuotaUsageLabel,
  getRemainingPercentage,
} from "./utils";

const PAGE_SIZE = 10;

function formatResetTimeDisplay(resetTime) {
  if (!resetTime) return null;
  const date = new Date(resetTime);
  if (!Number.isFinite(date.getTime())) return null;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const day =
    date >= today && date < tomorrow
      ? "Today"
      : date >= tomorrow && date < new Date(tomorrow.getTime() + 86400000)
        ? "Tomorrow"
        : date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${day}, ${date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true })}`;
}

function getColorClasses(remaining, unknown) {
  if (unknown) {
    return {
      text: "text-text-muted",
      bg: "bg-transparent",
      bgLight: "bg-black/10 dark:bg-white/10",
      emoji: "○",
    };
  }
  if (remaining > 70)
    return {
      text: "text-green-600 dark:text-green-400",
      bg: "bg-green-500",
      bgLight: "bg-green-500/10",
      emoji: "🟢",
    };
  if (remaining >= 30)
    return {
      text: "text-yellow-600 dark:text-yellow-400",
      bg: "bg-yellow-500",
      bgLight: "bg-yellow-500/10",
      emoji: "🟡",
    };
  return {
    text: "text-red-600 dark:text-red-400",
    bg: "bg-red-500",
    bgLight: "bg-red-500/10",
    emoji: "🔴",
  };
}

function sortQuotas(quotas, sortMode) {
  if (sortMode === "remaining-asc")
    return [...quotas].sort(
      (a, b) => a.remaining - b.remaining || a.name.localeCompare(b.name),
    );
  if (sortMode === "remaining-desc")
    return [...quotas].sort(
      (a, b) => b.remaining - a.remaining || a.name.localeCompare(b.name),
    );
  return quotas;
}

export default function QuotaTable({
  quotas = [],
  compact = false,
  sortMode = "default",
  showSortLabel = false,
  onHideQuota = null,
}) {
  const [page, setPage] = useState(1);
  const normalizedQuotas = useMemo(
    () =>
      quotas.map((quota, index) => ({
        ...quota,
        index,
        remaining: getRemainingPercentage(quota),
      })),
    [quotas],
  );
  const sortedQuotas = useMemo(
    () => sortQuotas(normalizedQuotas, sortMode),
    [normalizedQuotas, sortMode],
  );
  const totalPages = Math.max(1, Math.ceil(sortedQuotas.length / PAGE_SIZE));

  const [prevFilter, setPrevFilter] = useState({ sortMode, quotas });
  if (prevFilter.sortMode !== sortMode || prevFilter.quotas !== quotas) {
    setPrevFilter({ sortMode, quotas });
    setPage(1);
  }

  if (!quotas.length) return null;

  const currentPage = Math.min(page, totalPages);
  const currentRows = sortedQuotas.slice(
    (currentPage - 1) * PAGE_SIZE,
    currentPage * PAGE_SIZE,
  );
  const pageStart = (currentPage - 1) * PAGE_SIZE + 1;
  const pageEnd = Math.min(currentPage * PAGE_SIZE, sortedQuotas.length);
  const cellPad = compact ? "px-1.5 py-1" : "px-3 py-2";
  const textSize = compact ? "text-[11px]" : "text-sm";
  const resetSize = compact ? "text-[11px]" : "text-sm";
  const resetSecondary = compact ? "text-[10px] leading-tight" : "text-xs";
  const hasHideAction = typeof onHideQuota === "function";

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[10px] text-text-muted">
          {sortedQuotas.length} quota{sortedQuotas.length !== 1 ? "s" : ""}
        </div>
        {showSortLabel && (
          <div className="rounded-md border border-black/10 bg-black/[0.02] px-2 py-1 text-[10px] text-text-muted dark:border-white/10 dark:bg-white/[0.03]">
            Sorted by account remaining
          </div>
        )}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full table-fixed text-left">
          <tbody>
            {currentRows.map((quota) => {
              const unknown = quota.unknown === true;
              const colors = getColorClasses(quota.colorPercentage ?? quota.remaining, unknown);
              const countdown = formatResetTime(quota.resetAt);
              const resetDisplay = quota.emptyMessage || formatResetTimeDisplay(quota.resetAt);
              const usageLabel = formatQuotaUsageLabel(quota);
              return (
                <tr
                  key={`${quota.name}-${quota.index}`}
                  className="border-b border-black/5 transition-colors hover:bg-black/[0.02] dark:border-white/5 dark:hover:bg-white/[0.02]"
                >
                  <td className={`${cellPad} w-[30%]`}>
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span className="shrink-0 text-[10px]">
                        {colors.emoji}
                      </span>
                      <span
                        className={`${textSize} truncate font-medium text-text-primary`}
                      >
                        {quota.name}
                      </span>
                    </div>
                  </td>
                  <td className={`${cellPad} w-[45%]`}>
                    <div className={compact ? "space-y-1" : "space-y-1.5"}>
                      <div
                        className={`${compact ? "h-1" : "h-1.5"} overflow-hidden rounded-full border ${colors.bgLight} ${unknown || quota.remaining === 0 ? "border-black/10 dark:border-white/10" : "border-transparent"}`}
                      >
                        <div
                          className={`h-full transition-all duration-300 ${colors.bg}`}
                          style={{
                            width: unknown
                              ? "0%"
                              : `${Math.min(quota.remaining, 100)}%`,
                          }}
                        />
                      </div>
                      <div
                        className={`flex items-center justify-between ${compact ? "text-[10px]" : "text-xs"}`}
                      >
                        <span className="text-text-muted">{usageLabel}</span>
                        {!unknown && (
                          <span className={`font-medium ${colors.text}`}>
                            {quota.remaining}%
                          </span>
                        )}
                      </div>
                    </div>
                  </td>
                  <td
                    className={`${cellPad} ${hasHideAction ? "w-[20%]" : "w-[25%]"}`}
                  >
                    {countdown !== "-" || resetDisplay ? (
                      compact ? (
                        <div
                          className={`${resetSize} truncate font-medium text-text-primary`}
                          title={resetDisplay || ""}
                        >
                          {countdown !== "-" ? `in ${countdown}` : resetDisplay}
                        </div>
                      ) : (
                        <div className="space-y-0.5">
                          {countdown !== "-" && (
                            <div
                              className={`${resetSize} font-medium text-text-primary`}
                            >
                              in {countdown}
                            </div>
                          )}
                          {resetDisplay && (
                            <div
                              className={`${resetSecondary} text-text-muted`}
                            >
                              {resetDisplay}
                            </div>
                          )}
                        </div>
                      )
                    ) : (
                      <div className={`${resetSize} italic text-text-muted`}>
                        N/A
                      </div>
                    )}
                  </td>
                  {hasHideAction && (
                    <td className={`${cellPad} w-[5%] text-right`}>
                      <button
                        type="button"
                        onClick={() => onHideQuota(quota)}
                        className="inline-flex h-6 w-6 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-black/5 hover:text-text-primary dark:hover:bg-white/5"
                        title="Hide this quota row"
                        aria-label={`Hide quota ${quota.name}`}
                      >
                        <span className="material-symbols-outlined text-[15px]">
                          visibility_off
                        </span>
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {totalPages > 1 && (
        <div className="rounded-md border border-black/10 bg-black/[0.02] px-2 py-1.5 dark:border-white/10 dark:bg-white/[0.03]">
          <div className="flex items-center justify-between gap-2 text-[10px] text-text-muted">
            <span>
              Showing {pageStart}-{pageEnd} of {sortedQuotas.length}
            </span>
            <span>
              Page {page} / {totalPages}
            </span>
          </div>
          <div className="mt-1.5 flex justify-end gap-1">
            <button
              type="button"
              onClick={() => setPage((current) => Math.max(1, current - 1))}
              disabled={page === 1}
              className="flex h-6 items-center rounded-md border border-black/10 px-2 text-[10px] text-text-primary disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/10"
            >
              Prev
            </button>
            <button
              type="button"
              onClick={() =>
                setPage((current) => Math.min(totalPages, current + 1))
              }
              disabled={page === totalPages}
              className="flex h-6 items-center rounded-md border border-black/10 px-2 text-[10px] text-text-primary disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/10"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
