import {
  SLOW_REQUEST_THRESHOLD_MS,
  SLOW_REQUEST_WATCHDOG_MS,
  isSlowRequestLogsEnabled,
} from "../config/runtimeConfig.js";

// Check if running in Node.js environment (has fs module)
const isNode =
  typeof process !== "undefined" &&
  process.versions?.node &&
  typeof window === "undefined";

// Runtime override from Settings UI; null → fall back to ENABLE_REQUEST_LOGS env
let loggingEnabledOverride = null;

/** Apply Settings "Request Logs" toggle immediately (no restart). */
export function setRequestLogsEnabled(enabled) {
  loggingEnabledOverride = !!enabled;
  if (typeof process !== "undefined" && process.env) {
    process.env.ENABLE_REQUEST_LOGS = enabled ? "true" : "false";
  }
}

function isLoggingEnabled() {
  if (loggingEnabledOverride !== null) return loggingEnabledOverride;
  return (
    typeof process !== "undefined" && process.env?.ENABLE_REQUEST_LOGS === "true"
  );
}

let fs = null;
let path = null;
let LOGS_DIR = null;

// Lazy load Node.js modules (avoid top-level await)
async function ensureNodeModules() {
  if (!isNode || fs) return;
  try {
    fs = await import("fs");
    path = await import("path");
    LOGS_DIR = path.join(
      typeof process !== "undefined" && process.cwd ? process.cwd() : ".",
      "logs",
    );
  } catch {
    // Running in non-Node environment (Worker, Browser, etc.)
  }
}

// Format timestamp for folder name: 20251228_143045_123
function formatTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const y = date.getFullYear();
  const m = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const h = pad(date.getHours());
  const min = pad(date.getMinutes());
  const s = pad(date.getSeconds());
  const ms = String(date.getMilliseconds()).padStart(3, "0");
  return `${y}${m}${d}_${h}${min}${s}_${ms}`;
}

// Create log session folder: {sourceFormat}_{targetFormat}_{model}_{timestamp}
async function createLogSession(sourceFormat, targetFormat, model) {
  await ensureNodeModules();
  if (!fs || !LOGS_DIR) return null;

  try {
    if (!fs.existsSync(LOGS_DIR)) {
      fs.mkdirSync(LOGS_DIR, { recursive: true });
    }

    const timestamp = formatTimestamp();
    const safeModel = (model || "unknown").replace(/[/:]/g, "-");
    const folderName = `${sourceFormat}_${targetFormat}_${safeModel}_${timestamp}`;
    const sessionPath = path.join(LOGS_DIR, folderName);

    fs.mkdirSync(sessionPath, { recursive: true });

    return sessionPath;
  } catch (err) {
    console.log("[LOG] Failed to create log session:", err.message);
    return null;
  }
}

// Write JSON file
function writeJsonFile(sessionPath, filename, data) {
  if (!fs || !sessionPath) return;

  try {
    const filePath = path.join(sessionPath, filename);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  } catch (err) {
    console.log(`[LOG] Failed to write ${filename}:`, err.message);
  }
}

function createAsyncAppender(sessionPath) {
  let pending = Promise.resolve();

  const enqueue = (operation) => {
    pending = pending
      .then(operation)
      .catch(() => {
        // Request logging is diagnostic only and must never affect streaming.
      });
  };

  return {
    append(filename, chunk) {
      if (!fs || !sessionPath) return;
      const filePath = path.join(sessionPath, filename);
      enqueue(() => fs.promises.appendFile(filePath, chunk));
    },
    writeJson(filename, data) {
      if (!fs || !sessionPath) return;
      const filePath = path.join(sessionPath, filename);
      enqueue(() => fs.promises.writeFile(filePath, JSON.stringify(data, null, 2)));
    },
    flush() {
      return pending;
    },
  };
}

const REDACTED_VALUE = "[REDACTED]";
const SENSITIVE_KEY_PARTS = [
  "authorization",
  "x-api-key",
  "cookie",
  "token",
  "secret",
  "key",
  "password",
];

// Usage / generation limit fields contain "token" but are not credentials.
// Without this, maxOutputTokens / max_output_tokens become "[REDACTED]" in logs.
function isTokenQuotaOrLimitKey(lowerKey) {
  return (
    lowerKey === "max_tokens" ||
    lowerKey === "maxoutputtokens" ||
    /max[_-]?output[_-]?tokens?/.test(lowerKey) ||
    lowerKey.endsWith("_tokens") ||
    lowerKey.endsWith("tokencount") ||
    lowerKey.includes("token_count") ||
    lowerKey.includes("tokencount")
  );
}

function isSensitiveKey(key) {
  const lowerKey = String(key).toLowerCase();
  if (isTokenQuotaOrLimitKey(lowerKey)) return false;
  return SENSITIVE_KEY_PARTS.some((part) => lowerKey.includes(part));
}

function redactValue(value) {
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (value && typeof value === "object") {
    if (typeof value.entries === "function") {
      return redactValue(Object.fromEntries(value.entries()));
    }

    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [
        key,
        isSensitiveKey(key) ? REDACTED_VALUE : redactValue(nestedValue),
      ]),
    );
  }
  return value;
}

function redactUrl(value) {
  if (typeof value !== "string") return value;
  try {
    const parsed = new URL(value);
    for (const key of [...parsed.searchParams.keys()]) {
      if (isSensitiveKey(key)) parsed.searchParams.set(key, REDACTED_VALUE);
    }
    return parsed.toString();
  } catch {
    return value;
  }
}

function redactRequestBody(body) {
  return redactValue(body);
}

function redactRequestUrl(url) {
  return redactUrl(url);
}

// Mask sensitive data in headers while preserving field names for debugging.
function maskSensitiveHeaders(headers) {
  if (!headers) return {};
  const normalizedHeaders =
    typeof headers.entries === "function"
      ? Object.fromEntries(headers.entries())
      : headers;
  return redactValue(normalizedHeaders);
}

// No-op logger when logging is disabled
function createNoOpLogger() {
  return {
    sessionPath: null,
    logClientRawRequest() {},
    logRawRequest() {},
    logOpenAIRequest() {},
    logTargetRequest() {},
    logProviderResponse() {},
    appendProviderChunk() {},
    appendOpenAIChunk() {},
    logConvertedResponse() {},
    appendConvertedChunk() {},
    logError() {},
    flush() {
      return Promise.resolve();
    },
    finalize() {
      return Promise.resolve();
    },
  };
}

const MAX_BUFFERED_CHUNKS_SIZE = 128 * 1024; // 128KB cap per stream
const MAX_LOGGER_TTL_MS = 10 * 60 * 1000; // 10 minutes safety TTL for orphaned requests

/**
 * Creates an in-memory buffered logger that only flushes to disk
 * if the request duration exceeds SLOW_REQUEST_THRESHOLD_MS (e.g. 30s)
 * or if an error / abort occurs.
 */
function createBufferedLogger(sourceFormat, targetFormat, model) {
  const timestamp = formatTimestamp();
  const safeModel = (model || "unknown").replace(/[/:]/g, "-");
  let clientRaw = null;
  let rawSource = null;
  let openAIReq = null;
  let targetReq = null;
  let providerRes = null;
  let errorObj = null;
  let convertedRes = null;

  let providerChunks = [];
  let openAIChunks = [];
  let convertedChunks = [];

  let watchdogTimer = null;
  let autoTtlTimer = null;
  let watchdogPendingPath = null;
  let isFinalized = false;

  const thresholdMs =
    parseInt(process.env.SLOW_REQUEST_THRESHOLD_MS, 10) ||
    SLOW_REQUEST_THRESHOLD_MS;
  const watchdogMs =
    parseInt(process.env.SLOW_REQUEST_WATCHDOG_MS, 10) ||
    SLOW_REQUEST_WATCHDOG_MS;

  // Safety TTL to prevent any memory retention if finalize() is never called
  if (isNode) {
    autoTtlTimer = setTimeout(() => {
      if (!isFinalized) {
        isFinalized = true;
        if (watchdogTimer) clearTimeout(watchdogTimer);
        if (watchdogPendingPath && fs && fs.existsSync(watchdogPendingPath)) {
          try {
            fs.rmSync(watchdogPendingPath, { recursive: true, force: true });
          } catch {}
        }
        clientRaw = null;
        rawSource = null;
        openAIReq = null;
        targetReq = null;
        providerRes = null;
        errorObj = null;
        convertedRes = null;
        providerChunks = [];
        openAIChunks = [];
        convertedChunks = [];
      }
    }, MAX_LOGGER_TTL_MS);
    if (autoTtlTimer?.unref) autoTtlTimer.unref();
  }

  // Active watchdog: if the request is still pending after watchdogMs, dump initial request to disk
  if (isNode && watchdogMs > 0) {
    watchdogTimer = setTimeout(async () => {
      if (isFinalized) return;
      try {
        await ensureNodeModules();
        if (!fs || !LOGS_DIR) return;
        const slowDir = path.join(LOGS_DIR, "slow-requests");
        if (!fs.existsSync(slowDir)) {
          fs.mkdirSync(slowDir, { recursive: true });
        }
        const pendingFolder = `pending_${timestamp}_${sourceFormat}_${targetFormat}_${safeModel}`;
        watchdogPendingPath = path.join(slowDir, pendingFolder);
        if (!fs.existsSync(watchdogPendingPath)) {
          fs.mkdirSync(watchdogPendingPath, { recursive: true });
        }
        if (clientRaw) writeJsonFile(watchdogPendingPath, "1_req_client.json", clientRaw);
        if (rawSource) writeJsonFile(watchdogPendingPath, "2_req_source.json", rawSource);
        if (openAIReq) writeJsonFile(watchdogPendingPath, "3_req_openai.json", openAIReq);
        if (targetReq) writeJsonFile(watchdogPendingPath, "4_req_target.json", targetReq);
        writeJsonFile(watchdogPendingPath, "status.json", {
          status: "pending_watchdog",
          elapsedMs: watchdogMs,
          timestamp: new Date().toISOString(),
        });
      } catch (err) {
        console.log("[LOG] Slow request watchdog error:", err.message);
      }
    }, watchdogMs);
    // Unref so the timer does not prevent process exit
    if (watchdogTimer?.unref) watchdogTimer.unref();
  }

  const appendCapped = (arr, sizeRef, chunk) => {
    if (typeof chunk !== "string") chunk = String(chunk || "");
    if (sizeRef.size < MAX_BUFFERED_CHUNKS_SIZE) {
      arr.push(chunk);
      sizeRef.size += chunk.length;
    }
  };

  const providerSizeRef = { size: 0 };
  const openAISizeRef = { size: 0 };
  const convertedSizeRef = { size: 0 };

  return {
    get sessionPath() {
      return watchdogPendingPath;
    },

    logClientRawRequest(endpoint, body, headers = {}) {
      clientRaw = {
        timestamp: new Date().toISOString(),
        endpoint: redactRequestUrl(endpoint),
        headers: maskSensitiveHeaders(headers),
        body: redactRequestBody(body),
      };
    },

    logRawRequest(body, headers = {}) {
      rawSource = {
        timestamp: new Date().toISOString(),
        headers: maskSensitiveHeaders(headers),
        body: redactRequestBody(body),
      };
    },

    logOpenAIRequest(body) {
      openAIReq = {
        timestamp: new Date().toISOString(),
        body: redactRequestBody(body),
      };
    },

    logTargetRequest(url, headers, body) {
      targetReq = {
        timestamp: new Date().toISOString(),
        url: redactRequestUrl(url),
        headers: maskSensitiveHeaders(headers),
        body: redactRequestBody(body),
      };
    },

    logProviderResponse(status, statusText, headers, body) {
      providerRes = {
        timestamp: new Date().toISOString(),
        status,
        statusText,
        headers: headers
          ? typeof headers.entries === "function"
            ? Object.fromEntries(headers.entries())
            : headers
          : {},
        body,
      };
    },

    appendProviderChunk(chunk) {
      appendCapped(providerChunks, providerSizeRef, chunk);
    },

    appendOpenAIChunk(chunk) {
      appendCapped(openAIChunks, openAISizeRef, chunk);
    },

    logConvertedResponse(body) {
      convertedRes = {
        timestamp: new Date().toISOString(),
        body,
      };
    },

    appendConvertedChunk(chunk) {
      appendCapped(convertedChunks, convertedSizeRef, chunk);
    },

    logError(error, requestBody = null) {
      errorObj = {
        timestamp: new Date().toISOString(),
        error: error?.message || String(error),
        stack: error?.stack,
        requestBody: redactRequestBody(requestBody),
      };
    },

    flush() {
      return Promise.resolve();
    },

    async finalize({ durationMs = 0, status = "success", error = null, ttft = null, usage = null } = {}) {
      if (isFinalized) return;
      isFinalized = true;

      if (watchdogTimer) {
        clearTimeout(watchdogTimer);
        watchdogTimer = null;
      }
      if (autoTtlTimer) {
        clearTimeout(autoTtlTimer);
        autoTtlTimer = null;
      }

      const isSlow = durationMs >= thresholdMs;
      const isError =
        (status && status !== "success" && status !== 200 && status !== "200 OK") ||
        Boolean(error) ||
        Boolean(errorObj);

      if (isSlow || isError) {
        try {
          await ensureNodeModules();
          if (!fs || !LOGS_DIR) return;

          const slowDir = path.join(LOGS_DIR, "slow-requests");
          if (!fs.existsSync(slowDir)) {
            fs.mkdirSync(slowDir, { recursive: true });
          }

          const sec = Math.round((durationMs || 0) / 1000);
          const statusTag = isError ? "ERROR" : "OK";
          const finalFolder = `${sec}s_${statusTag}_${sourceFormat}_${targetFormat}_${safeModel}_${timestamp}`;
          const finalPath = path.join(slowDir, finalFolder);

          const targetDir = watchdogPendingPath && fs.existsSync(watchdogPendingPath)
            ? watchdogPendingPath
            : finalPath;

          if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
          }

          if (clientRaw) writeJsonFile(targetDir, "1_req_client.json", clientRaw);
          if (rawSource) writeJsonFile(targetDir, "2_req_source.json", rawSource);
          if (openAIReq) writeJsonFile(targetDir, "3_req_openai.json", openAIReq);
          if (targetReq) writeJsonFile(targetDir, "4_req_target.json", targetReq);

          if (providerRes) {
            writeJsonFile(targetDir, "5_res_provider.json", providerRes);
          } else if (providerChunks.length > 0) {
            fs.writeFileSync(path.join(targetDir, "5_res_provider.txt"), providerChunks.join(""));
          }

          if (openAIChunks.length > 0) {
            fs.writeFileSync(path.join(targetDir, "6_res_openai.txt"), openAIChunks.join(""));
          }

          if (convertedRes) {
            writeJsonFile(targetDir, "7_res_client.json", convertedRes);
          } else if (convertedChunks.length > 0) {
            fs.writeFileSync(path.join(targetDir, "7_res_client.txt"), convertedChunks.join(""));
          }

          if (error || errorObj) {
            const errPayload = {
              timestamp: new Date().toISOString(),
              error: error?.message || errorObj?.error || String(error || ""),
              stack: error?.stack || errorObj?.stack,
              requestBody: errorObj?.requestBody,
            };
            writeJsonFile(targetDir, "6_error.json", errPayload);
          }

          writeJsonFile(targetDir, "metadata.json", {
            durationMs,
            seconds: sec,
            ttft,
            status,
            sourceFormat,
            targetFormat,
            model,
            usage,
            timestamp: new Date().toISOString(),
          });

          // Rename watchdog pending path if it was used
          if (targetDir === watchdogPendingPath && targetDir !== finalPath) {
            try {
              if (fs.existsSync(path.join(targetDir, "status.json"))) {
                fs.unlinkSync(path.join(targetDir, "status.json"));
              }
              fs.renameSync(watchdogPendingPath, finalPath);
            } catch {
              // Ignore rename collision
            }
          }
        } catch (err) {
          console.log("[LOG] Failed to save slow request log:", err.message);
        }
      } else {
        // Fast and successful request: clean up watchdog pending folder if it was written
        if (watchdogPendingPath && fs && fs.existsSync(watchdogPendingPath)) {
          try {
            fs.rmSync(watchdogPendingPath, { recursive: true, force: true });
          } catch {
            // Ignore cleanup error
          }
        }
      }

      // Clear memory references
      clientRaw = null;
      rawSource = null;
      openAIReq = null;
      targetReq = null;
      providerRes = null;
      errorObj = null;
      convertedRes = null;
      providerChunks = [];
      openAIChunks = [];
      convertedChunks = [];
    },
  };
}

/**
 * Create a new log session and return logger functions
 * @param {string} sourceFormat - Source format from client (claude, openai, etc.)
 * @param {string} targetFormat - Target format to provider (antigravity, gemini-cli, etc.)
 * @param {string} model - Model name
 * @returns {Promise<object>} Promise that resolves to logger object with methods to log each stage
 */
export async function createRequestLogger(sourceFormat, targetFormat, model) {
  // If verbose request logs enabled via settings/env, use direct disk streaming logger
  if (isLoggingEnabled()) {
    const sessionPath = await createLogSession(sourceFormat, targetFormat, model);
    const appendChunk = createAsyncAppender(sessionPath);

    return {
      get sessionPath() {
        return sessionPath;
      },

      // 1. Log client raw request (before any conversion)
      logClientRawRequest(endpoint, body, headers = {}) {
        appendChunk.writeJson("1_req_client.json", {
          timestamp: new Date().toISOString(),
          endpoint: redactRequestUrl(endpoint),
          headers: maskSensitiveHeaders(headers),
          body: redactRequestBody(body),
        });
      },

      // 2. Log raw request from client (after initial conversion like responsesApi)
      logRawRequest(body, headers = {}) {
        appendChunk.writeJson("2_req_source.json", {
          timestamp: new Date().toISOString(),
          headers: maskSensitiveHeaders(headers),
          body: redactRequestBody(body),
        });
      },

      // 3. Log OpenAI intermediate format (source → openai)
      logOpenAIRequest(body) {
        appendChunk.writeJson("3_req_openai.json", {
          timestamp: new Date().toISOString(),
          body: redactRequestBody(body),
        });
      },

      // 4. Log target format request (openai → target)
      logTargetRequest(url, headers, body) {
        appendChunk.writeJson("4_req_target.json", {
          timestamp: new Date().toISOString(),
          url: redactRequestUrl(url),
          headers: maskSensitiveHeaders(headers),
          body: redactRequestBody(body),
        });
      },

      // 5. Log provider response (for non-streaming or error)
      logProviderResponse(status, statusText, headers, body) {
        appendChunk.writeJson("5_res_provider.json", {
          timestamp: new Date().toISOString(),
          status,
          statusText,
          headers: headers
            ? typeof headers.entries === "function"
              ? Object.fromEntries(headers.entries())
              : headers
            : {},
          body,
        });
      },

      // 5. Append streaming chunk to provider response
      appendProviderChunk(chunk) {
        appendChunk.append("5_res_provider.txt", chunk);
      },

      // 6. Append OpenAI intermediate chunks (target → openai)
      appendOpenAIChunk(chunk) {
        appendChunk.append("6_res_openai.txt", chunk);
      },

      // 7. Log converted response to client (for non-streaming)
      logConvertedResponse(body) {
        appendChunk.writeJson("7_res_client.json", {
          timestamp: new Date().toISOString(),
          body,
        });
      },

      // 7. Append streaming chunk to converted response
      appendConvertedChunk(chunk) {
        appendChunk.append("7_res_client.txt", chunk);
      },

      // 6. Log error
      logError(error, requestBody = null) {
        appendChunk.writeJson("6_error.json", {
          timestamp: new Date().toISOString(),
          error: error?.message || String(error),
          stack: error?.stack,
          requestBody: redactRequestBody(requestBody),
        });
      },

      flush() {
        return appendChunk.flush();
      },

      async finalize({ durationMs = 0, status = "success", error = null, ttft = null, usage = null } = {}) {
        const sec = Math.round((durationMs || 0) / 1000);
        appendChunk.writeJson("metadata.json", {
          durationMs,
          seconds: sec,
          ttft,
          status,
          sourceFormat,
          targetFormat,
          model,
          usage,
          timestamp: new Date().toISOString(),
        });
        return appendChunk.flush();
      },
    };
  }

  // If slow request logging is enabled, return memory-buffered logger
  if (isSlowRequestLogsEnabled()) {
    return createBufferedLogger(sourceFormat, targetFormat, model);
  }

  // Otherwise return no-op logger
  return createNoOpLogger();
}

// Legacy functions for backward compatibility
export function logRequest() {}
export function logResponse() {}
export function logError(provider, { error, url, model, requestBody }) {
  if (!fs || !LOGS_DIR) return;

  try {
    if (!fs.existsSync(LOGS_DIR)) {
      fs.mkdirSync(LOGS_DIR, { recursive: true });
    }

    const date = new Date().toISOString().split("T")[0];
    const logPath = path.join(LOGS_DIR, `${provider}-${date}.log`);

    const logEntry = {
      timestamp: new Date().toISOString(),
      type: "error",
      provider,
      model,
      url: redactRequestUrl(url),
      error: error?.message || String(error),
      stack: error?.stack,
      requestBody: redactRequestBody(requestBody),
    };

    fs.appendFileSync(logPath, JSON.stringify(logEntry) + "\n");
  } catch (err) {
    console.log("[LOG] Failed to write error log:", err.message);
  }
}
