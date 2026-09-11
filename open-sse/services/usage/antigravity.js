/**
 * Antigravity Usage - Fetch quota from Google Cloud Code API
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { CLIENT_METADATA, parseResetTime } from "./utils.js";
import { normalizeCloudCodeProjectId } from "./shared.js";
import {
  ANTIGRAVITY_USAGE_ENDPOINT_SETS,
  ANTIGRAVITY_USAGE_MODEL_IDS,
} from "../../providers/antigravity-provider-metadata.js";
import { ANTIGRAVITY_IDE_USER_AGENT } from "../../providers/shared.js";

const REQUEST_TIMEOUT_MS = 10000;

function getTierLabel(tier) {
  if (!tier || typeof tier !== "object") return null;
  return tier.name || tier.id || tier.slug || tier.quotaTier || null;
}

function extractValidationInfo(info) {
  if (!Array.isArray(info?.ineligibleTiers)) return null;
  const validationTier = info.ineligibleTiers.find(
    (tier) =>
      tier?.validationUrl ||
      tier?.reasonCode === "VALIDATION_REQUIRED" ||
      tier?.validationErrorMessage,
  );
  if (!validationTier) return null;
  return {
    reasonCode: validationTier.reasonCode || "VALIDATION_REQUIRED",
    message:
      validationTier.validationErrorMessage ||
      validationTier.reasonMessage ||
      "Verify your account to continue.",
    url: validationTier.validationUrl || null,
    urlText: validationTier.validationUrlLinkText || "Verify your account",
    learnMoreUrl: validationTier.validationLearnMoreUrl || null,
  };
}

function extractSubscriptionTier(info) {
  const paidTier = getTierLabel(info?.paidTier);
  if (paidTier) return paidTier;

  const ineligible = Array.isArray(info?.ineligibleTiers)
    && info.ineligibleTiers.length > 0;
  if (!ineligible) {
    const currentTier = getTierLabel(info?.currentTier);
    if (currentTier) return currentTier;
  }

  const defaultTier = Array.isArray(info?.allowedTiers)
    ? info.allowedTiers.find((tier) => tier?.isDefault === true)
    : null;
  const fallbackTier = getTierLabel(defaultTier);
  return fallbackTier ? `${fallbackTier} (Restricted)` : null;
}

function requestOptions(accessToken, body) {
  return {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": ANTIGRAVITY_IDE_USER_AGENT,
      "Content-Type": "application/json",
      "X-Client-Name": "antigravity",
      "X-Client-Version": "1.107.0",
      "x-request-source": "local",
    },
    body: JSON.stringify(body),
  };
}

async function fetchJsonWithTimeout(url, options, proxyOptions) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await proxyAwareFetch(
      url,
      { ...options, signal: controller.signal },
      proxyOptions,
    );
  } finally {
    clearTimeout(timeoutId);
  }
}

async function getAntigravitySubscriptionInfo(accessToken, proxyOptions = null) {
  for (const url of ANTIGRAVITY_USAGE_ENDPOINT_SETS.loadProject) {
    try {
      const response = await fetchJsonWithTimeout(
        url,
        requestOptions(accessToken, { metadata: CLIENT_METADATA, mode: 1 }),
        proxyOptions,
      );
      if (response.ok) return await response.json();
      if (response.status === 401) return null;
    } catch (error) {
      console.error("[Antigravity Subscription] Error:", error.message);
    }
  }
  return null;
}

async function fetchQuota(accessToken, projectId, proxyOptions) {
  const payload = projectId ? { project: projectId } : {};

  for (const url of ANTIGRAVITY_USAGE_ENDPOINT_SETS.quota) {
    let currentPayload = payload;
    let retriedWithoutProject = false;

    while (true) {
      try {
        const response = await fetchJsonWithTimeout(
          url,
          requestOptions(accessToken, currentPayload),
          proxyOptions,
        );

        if (response.status === 403 && currentPayload.project && !retriedWithoutProject) {
          currentPayload = {};
          retriedWithoutProject = true;
          continue;
        }
        if (response.ok) return { response, url };
        if (response.status === 401) return { response, url };
        if (response.status === 403) return { response, url };
        if (response.status !== 429 && !response.status.toString().startsWith("5")) {
          return { response, url };
        }
        break;
      } catch (error) {
        console.error("[Antigravity Quota] Error:", error.message);
        break;
      }
    }
  }

  return null;
}

async function fetchQuotaSummary(accessToken, projectId, proxyOptions) {
  const payload = projectId ? { project: projectId } : {};
  for (const url of ANTIGRAVITY_USAGE_ENDPOINT_SETS.quotaSummary) {
    try {
      const response = await fetchJsonWithTimeout(
        url,
        requestOptions(accessToken, payload),
        proxyOptions,
      );
      if (!response.ok) {
        if (response.status >= 400 && response.status < 500 && response.status !== 429) return null;
        continue;
      }
      const data = await response.json();
      if (!Array.isArray(data?.groups)) return null;
      return data.groups.map((group) => ({
        displayName: group.displayName || "",
        description: group.description,
        buckets: Array.isArray(group.buckets)
          ? group.buckets.map((bucket) => ({
              bucketId: bucket.bucketId || "",
              window: bucket.window || "",
              remainingFraction: Number.isFinite(Number(bucket.remainingFraction))
                ? Number(bucket.remainingFraction)
                : 0,
              resetAt: parseResetTime(bucket.resetTime),
              displayName: bucket.displayName,
              description: bucket.description,
            }))
          : [],
      }));
    } catch (error) {
      console.error("[Antigravity Quota Summary] Error:", error.message);
    }
  }
  return null;
}

export async function getAntigravityUsage(
  accessToken,
  providerSpecificData = {},
  proxyOptions = null,
) {
  try {
    const cachedProjectId = normalizeCloudCodeProjectId(providerSpecificData?.projectId);
    const subscriptionInfo = cachedProjectId
      ? null
      : await getAntigravitySubscriptionInfo(accessToken, proxyOptions);
    const projectId = cachedProjectId
      || normalizeCloudCodeProjectId(subscriptionInfo?.cloudaicompanionProject);
    const quotaResult = await fetchQuota(accessToken, projectId, proxyOptions);

    if (!quotaResult) {
      return { message: "Antigravity quota API unavailable. Chat may still work." };
    }
    if (quotaResult.response.status === 401) {
      return {
        message: "Antigravity quota API authentication expired. Chat may still work.",
        quotas: {},
      };
    }
    if (quotaResult.response.status === 403) {
      return {
        message: "Antigravity quota API access forbidden. Chat may still work.",
        quotas: {},
      };
    }
    if (!quotaResult.response.ok) {
      throw new Error(`Antigravity API error: ${quotaResult.response.status}`);
    }

    const data = await quotaResult.response.json();
    const quotas = {};
    for (const [modelKey, info] of Object.entries(data.models || {})) {
      if (!info?.quotaInfo || info.isInternal || !ANTIGRAVITY_USAGE_MODEL_IDS.has(modelKey)) continue;
      const remainingFraction = Number(info.quotaInfo.remainingFraction) || 0;
      const total = 1000;
      const remaining = Math.round(total * remainingFraction);
      quotas[modelKey] = {
        used: total - remaining,
        total,
        resetAt: parseResetTime(info.quotaInfo.resetTime),
        remainingPercentage: remainingFraction * 100,
        unlimited: false,
        displayName: info.displayName || modelKey,
      };
    }

    return {
      plan: extractSubscriptionTier(subscriptionInfo) || "Unknown",
      subscriptionInfo: subscriptionInfo || { cloudaicompanionProject: projectId },
      quotas,
      quotaGroups: await fetchQuotaSummary(accessToken, projectId, proxyOptions),
      validation: extractValidationInfo(subscriptionInfo),
    };
  } catch (error) {
    console.error("[Antigravity Usage] Error:", error.message, error.cause);
    return { message: `Antigravity error: ${error.message}` };
  }
}

export { extractSubscriptionTier, extractValidationInfo };
