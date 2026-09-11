import { getModelsByProviderId } from "open-sse/config/providerModels.js";

/**
 * Format ISO date string to countdown format (inspired by vscode-antigravity-cockpit)
 * @param {string|Date} date - ISO date string or Date object
 * @returns {string} Formatted countdown (e.g., "2d 5h 30m", "4h 40m", "15m") or "-"
 */
export function formatResetTime(date) {
  if (!date) return "-";

  try {
    const resetDate = typeof date === "string" ? new Date(date) : date;
    const now = new Date();
    const diffMs = resetDate - now;

    if (diffMs <= 0) return "-";

    const totalMinutes = Math.ceil(diffMs / (1000 * 60));

    // < 60 minutes: show only minutes
    if (totalMinutes < 60) {
      return `${totalMinutes}m`;
    }

    const totalHours = Math.floor(totalMinutes / 60);
    const remainingMinutes = totalMinutes % 60;

    // < 24 hours: show hours and minutes
    if (totalHours < 24) {
      return `${totalHours}h ${remainingMinutes}m`;
    }

    // >= 24 hours: show days, hours, and minutes
    const days = Math.floor(totalHours / 24);
    const remainingHours = totalHours % 24;
    return `${days}d ${remainingHours}h ${remainingMinutes}m`;
  } catch (error) {
    return "-";
  }
}

/**
 * Get Tailwind color class based on percentage
 * @param {number} percentage - Remaining percentage (0-100)
 * @returns {string} Color name: "green" | "yellow" | "red"
 */
export function getStatusColor(percentage) {
  if (percentage > 70) return "green";
  if (percentage >= 30) return "yellow";
  return "red"; // 0-29% including 0% (out of quota) - show red
}

/**
 * Get status emoji based on percentage
 * @param {number} percentage - Remaining percentage (0-100)
 * @returns {string} Emoji: "🟢" | "🟡" | "🔴"
 */
export function getStatusEmoji(percentage) {
  if (percentage > 70) return "🟢";
  if (percentage >= 30) return "🟡";
  return "🔴"; // 0-29% including 0% (out of quota) - show red
}

/**
 * Calculate remaining percentage
 * @param {number} used - Used amount
 * @param {number} total - Total amount
 * @returns {number} Remaining percentage (0-100)
 */
export function calculatePercentage(used, total) {
  if (!total || total === 0) return 0;
  if (!used || used < 0) return 100;
  if (used >= total) return 0;

  return Math.round(((total - used) / total) * 100);
}

/**
 * Get remaining percentage from a normalized quota row
 * @param {Object} quota - Normalized quota object
 * @returns {number} Remaining percentage (0-100)
 */
export function getRemainingPercentage(quota) {
  // Free / unknown allotment: empty bar (CLIProxyAPI "Used --"), not 100% full.
  if (quota?.unknown === true) return 0;

  if (quota?.remaining !== undefined) {
    return Math.max(0, Math.round(quota.remaining));
  }

  if (quota?.remainingPercentage !== undefined) {
    return Math.round(quota.remainingPercentage);
  }

  return calculatePercentage(quota?.used, quota?.total);
}

/** Format used/total for quota rows (CLIProxyAPI free: Used -- / $0.00). */
export function formatQuotaUsageLabel(quota) {
  if (quota?.unknown === true) {
    if (quota.format === "currency") {
      return "$0.00 / $0.00";
    }
    return "Used --";
  }
  const used = Number(quota?.used) || 0;
  const total = Number(quota?.total) || 0;
  if (quota?.format === "currency") {
    const fmt = (n) =>
      `$${n.toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}`;
    return `${fmt(used)} / ${fmt(total)}`;
  }
  return `${used.toLocaleString()} / ${total > 0 ? total.toLocaleString() : "∞"}`;
}

export function getQuotaVisibilityKey(quota) {
  if (!quota || typeof quota !== "object") return "";
  return String(quota.modelKey || quota.name || "").trim();
}

/**
 * Trim hidden quota keys to only those matching currently valid quotas.
 * Stale or obsolete model keys are dropped.
 */
export function trimHiddenQuotaKeys(hidden = [], quotas = []) {
  if (!Array.isArray(hidden) || hidden.length === 0) return [];
  const validKeys = new Set(quotas.map(getQuotaVisibilityKey).filter(Boolean));
  return [...new Set(hidden.map((k) => String(k).trim()).filter((k) => validKeys.has(k)))];
}

function getProviderHiddenQuotaSet(provider, quotaVisibility, quotas = []) {
  const hidden = quotaVisibility?.[provider]?.hidden;
  if (!Array.isArray(hidden) || hidden.length === 0) return new Set();
  const trimmed = quotas.length > 0 ? trimHiddenQuotaKeys(hidden, quotas) : hidden;
  return new Set(trimmed.map(String));
}

export function filterQuotasByVisibility(provider, quotas = [], quotaVisibility = {}) {
  if (!Array.isArray(quotas) || quotas.length === 0) return [];
  const hidden = getProviderHiddenQuotaSet(provider, quotaVisibility, quotas);
  if (hidden.size === 0) return quotas;
  return quotas.filter((quota) => !hidden.has(getQuotaVisibilityKey(quota)));
}

export function getHiddenQuotaRows(provider, quotas = [], quotaVisibility = {}) {
  if (!Array.isArray(quotas) || quotas.length === 0) return [];
  const hidden = getProviderHiddenQuotaSet(provider, quotaVisibility, quotas);
  if (hidden.size === 0) return [];
  return quotas.filter((quota) => hidden.has(getQuotaVisibilityKey(quota)));
}

/**
 * Parse provider-specific quota structures into normalized array
 * @param {string} provider - Provider name (github, antigravity, codex, kiro, claude)
 * @param {Object} data - Raw quota data from provider
 * @returns {Array<Object>} Normalized quota objects with { name, used, total, resetAt }
 */
export function parseQuotaData(provider, data) {
  if (!data || typeof data !== "object") return [];

  const normalizedQuotas = [];

  try {
    switch (provider.toLowerCase()) {
      case "github":
        if (data.quotas) {
          Object.entries(data.quotas).forEach(([name, quota]) => {
            normalizedQuotas.push({
              name,
              used: quota.used || 0,
              total: quota.total || 0,
              resetAt: quota.resetAt || null,
            });
          });
        }
        break;

      case "antigravity":
        if (data.quotas) {
          const entries = Object.entries(data.quotas);
          const weeklyKeys = new Set(["gemini_weekly", "claude_gpt_weekly"]);
          const geminiModels = entries.filter(([k]) => k.startsWith("gemini-") && !k.includes("image"));
          const claudeModels = entries.filter(([k]) => k.startsWith("claude-"));
          const imageModels = entries.filter(([k]) => k.includes("image"));
          const weeklyModels = entries.filter(([k]) => weeklyKeys.has(k));
          const otherModels = entries.filter(([k]) => !k.startsWith("gemini-") && !k.startsWith("claude-") && !k.includes("image") && !weeklyKeys.has(k));

          if (geminiModels.length > 0) {
            const rep = geminiModels.reduce((min, cur) =>
              (cur[1].remainingPercentage ?? 100) < (min[1].remainingPercentage ?? 100) ? cur : min
            )[1];
            normalizedQuotas.push({
              name: "Gemini (Flash / Pro)",
              modelKey: "gemini",
              used: rep.used || 0,
              total: rep.total || 0,
              resetAt: rep.resetAt || null,
              remainingPercentage: rep.remainingPercentage,
            });
          }

          if (claudeModels.length > 0) {
            const rep = claudeModels.reduce((min, cur) =>
              (cur[1].remainingPercentage ?? 100) < (min[1].remainingPercentage ?? 100) ? cur : min
            )[1];
            normalizedQuotas.push({
              name: "Claude (Sonnet / Opus)",
              modelKey: "claude",
              used: rep.used || 0,
              total: rep.total || 0,
              resetAt: rep.resetAt || null,
              remainingPercentage: rep.remainingPercentage,
            });
          }

          weeklyModels.forEach(([modelKey, quota]) => {
            normalizedQuotas.push({
              name: quota.displayName || modelKey,
              modelKey,
              used: quota.used || 0,
              total: quota.total || 0,
              resetAt: quota.resetAt || null,
              remainingPercentage: quota.remainingPercentage,
            });
          });

          imageModels.forEach(([modelKey, quota]) => {
            normalizedQuotas.push({
              name: quota.displayName || modelKey,
              modelKey,
              used: quota.used || 0,
              total: quota.total || 0,
              resetAt: quota.resetAt || null,
              remainingPercentage: quota.remainingPercentage,
            });
          });

          otherModels.forEach(([modelKey, quota]) => {
            normalizedQuotas.push({
              name: quota.displayName || modelKey,
              modelKey,
              used: quota.used || 0,
              total: quota.total || 0,
              resetAt: quota.resetAt || null,
              remainingPercentage: quota.remainingPercentage,
            });
          });
        }
        break;

      case "codex":
        if (data.quotas) {
          Object.entries(data.quotas).forEach(([quotaType, quota]) => {
            let displayName = quotaType;
            if (quotaType === "spark_session") displayName = "Spark (5h)";
            else if (quotaType === "spark_weekly") displayName = "Spark (Weekly)";
            else if (quotaType === "session") displayName = "5h";
            else if (quotaType === "weekly") displayName = "Weekly";
            else if (quotaType === "review_session") displayName = "Review (5h)";
            else if (quotaType === "review_weekly") displayName = "Review (Weekly)";

            normalizedQuotas.push({
              name: displayName,
              quotaType,
              used: quota.used || 0,
              total: quota.total || 0,
              remaining: quota.remaining,
              resetAt: quota.resetAt || null,
            });
          });
        }
        break;

      case "kiro":
        if (data.quotas) {
          Object.entries(data.quotas).forEach(([quotaType, quota]) => {
            normalizedQuotas.push({
              name: quotaType,
              used: quota.used || 0,
              total: quota.total || 0,
              resetAt: quota.resetAt || null,
            });
          });
        }
        break;

      case "grok-cli":
      case "gcli":
      case "xai":
        // Grok billing rows come keyed by label (Monthly credits / Weekly
        // limit / On-demand / Prepaid). Preserve remainingPercentage + unlimited
        // + unknown/format so free CLIProxyAPI-style "Used --" / "$0.00/$0.00"
        // rows render instead of a fake 100% or 0% bar.
        if (data.quotas) {
          Object.entries(data.quotas).forEach(([name, quota]) => {
            normalizedQuotas.push({
              name,
              used: quota.used || 0,
              total: quota.total || 0,
              resetAt: quota.resetAt || null,
              remainingPercentage: quota.remainingPercentage,
              unlimited: quota.unlimited,
              unknown: quota.unknown === true,
              format: quota.format || null,
            });
          });
        }
        break;

      case "claude":
        if (data.message) {
          // Handle error message case
          normalizedQuotas.push({
            name: "error",
            used: 0,
            total: 0,
            resetAt: null,
            message: data.message,
          });
        } else if (data.quotas) {
          Object.entries(data.quotas).forEach(([name, quota]) => {
            normalizedQuotas.push({
              name,
              used: quota.used || 0,
              total: quota.total || 0,
              remaining: quota.remaining !== undefined ? quota.remaining : Math.max(0, (quota.total || 100) - (quota.used || 0)),
              remainingPercentage: quota.remainingPercentage !== undefined ? quota.remainingPercentage : calculatePercentage(quota.used, quota.total),
              resetAt: quota.resetAt || null,
            });
          });
        }
        break;

      case "vercel-ai-gateway":
        // Vercel returns currency credit balance, not request quotas.
        // The 'Remaining (USD)' row needs explicit remainingPercentage because
        // its used/total values would otherwise compute the wrong direction
        // (e.g. used=95.5 / total=100 → 4% instead of 96%).
        if (data.quotas) {
          Object.entries(data.quotas).forEach(([name, quota]) => {
            normalizedQuotas.push({
              name,
              used: quota.used || 0,
              total: quota.total || 0,
              resetAt: quota.resetAt || null,
              remainingPercentage: quota.remainingPercentage,
            });
          });
        }
        break;

      case "codebuddy-cn":
        // CodeBuddy CN mixes recurring refill packs ("Monthly"/"Weekly"/...)
        // with one-shot bonus packs ("Bonus Pack N"). Forward `recurring`
        // so the UI can show "Expires in" for bonus packs (whose resetAt is
        // a hard expiry, not a refresh) instead of "Reset in".
        if (data.quotas) {
          Object.entries(data.quotas).forEach(([name, quota]) => {
            normalizedQuotas.push({
              name,
              used: quota.used || 0,
              total: quota.total || 0,
              resetAt: quota.resetAt || null,
              recurring: quota.recurring !== false,
            });
          });
        }
        break;

      case "kimi":
      case "deepseek":
        // Credit balance — remainingPercentage only (no absolute remaining).
        if (data.quotas) {
          Object.entries(data.quotas).forEach(([name, quota]) => {
            normalizedQuotas.push({
              name,
              used: quota.used || 0,
              total: quota.total || 0,
              resetAt: quota.resetAt || null,
              remainingPercentage: quota.remainingPercentage,
            });
          });
        }
        break;

      case "groq":
        if (data.quotas) {
          Object.entries(data.quotas).forEach(([name, quota]) => {
            normalizedQuotas.push({
              name,
              used: quota.used || 0,
              total: quota.total || 0,
              resetAt: quota.resetAt || null,
            });
          });
        }
        break;
      case "ollama":
        if (data.quotas) {
          Object.entries(data.quotas).forEach(([name, quota]) => {
            normalizedQuotas.push({
              name,
              used: quota.used || 0,
              total: quota.total || 0,
              resetAt: quota.resetAt || null,
              remainingPercentage: quota.remainingPercentage,
            });
          });
        }
        break;

      case "zed":
        // Edit predictions + optional hosted model_requests; unlimited uses remainingPercentage.
        if (data.quotas) {
          Object.entries(data.quotas).forEach(([name, quota]) => {
            normalizedQuotas.push({
              name,
              used: quota.used || 0,
              total: quota.total || 0,
              resetAt: quota.resetAt || null,
              remainingPercentage: quota.remainingPercentage,
              unlimited: quota.unlimited,
            });
          });
        }
        break;

      default:
        // Generic fallback for unknown providers
        if (data.quotas) {
          Object.entries(data.quotas).forEach(([name, quota]) => {
            normalizedQuotas.push({
              name,
              used: quota.used || 0,
              total: quota.total || 0,
              resetAt: quota.resetAt || null,
            });
          });
        }
    }
  } catch (error) {
    console.error(`Error parsing quota data for ${provider}:`, error);
    return [];
  }

  if (provider?.toLowerCase() === "claude") {
    const CLAUDE_QUOTA_ORDER = {
      "session (5h)": 0,
      "weekly (7d)": 1,
      "weekly fable (7d)": 2,
      "weekly opus (7d)": 3,
      "weekly sonnet (7d)": 4,
    };
    normalizedQuotas.sort((a, b) => (CLAUDE_QUOTA_ORDER[a.name] ?? 99) - (CLAUDE_QUOTA_ORDER[b.name] ?? 99));
    return normalizedQuotas;
  }

  // Sort quotas according to PROVIDER_MODELS order
  const modelOrder = getModelsByProviderId(provider);
  if (modelOrder.length > 0) {
    const orderMap = new Map(modelOrder.map((m, i) => [m.id, i]));

    normalizedQuotas.sort((a, b) => {
      // Use modelKey for antigravity (mapped to family anchor), otherwise use name
      let keyA = a.modelKey || a.name;
      let keyB = b.modelKey || b.name;
      if (keyA === "gemini") keyA = "gemini-3.8-flash-high";
      if (keyA === "claude") keyA = "claude-sonnet-4-6";
      if (keyB === "gemini") keyB = "gemini-3.8-flash-high";
      if (keyB === "claude") keyB = "claude-sonnet-4-6";
      const orderA = orderMap.get(keyA) ?? 999;
      const orderB = orderMap.get(keyB) ?? 999;
      return orderA - orderB;
    });
  }

  return normalizedQuotas;
}
