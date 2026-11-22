/**
 * Parse and group console log lines into structured request transactions.
 */

export function parseLogLine(rawLine) {
  if (!rawLine || typeof rawLine !== "string") {
    return { raw: rawLine, text: "", timestamp: "", level: "info" };
  }

  // 1. Extract Timestamp: [HH:MM:SS]
  let timestamp = "";
  let text = rawLine;
  const timeMatch = rawLine.match(/^\[(\d{2}:\d{2}:\d{2})\]\s*(.*)$/);
  if (timeMatch) {
    timestamp = timeMatch[1];
    text = timeMatch[2];
  }

  // 2. Extract Request ID & Connection ID:
  // Can be [reqId:connId], reqId:connId, [reqId], or session color dot tag (e.g. 🔴, 🟢, 🔵, 🟣, 🟡, 🟠, ⚪, 🟤)
  let reqId = null;
  let connId = null;
  let dotTag = null;

  const dotMatch = text.match(/^([🟢🔵🟣🟡🟠🔴⚪🟤])\s*(.*)$/u);
  if (dotMatch) {
    dotTag = dotMatch[1];
    text = dotMatch[2];
  }

  const idMatch = text.match(/^(?:\[([a-z0-9]{6})(?::([a-z0-9]{6}))?\]|([a-z0-9]{6})(?::([a-z0-9]{6}))?)\s*(.*)$/i);
  if (idMatch) {
    reqId = idMatch[1] || idMatch[3];
    connId = idMatch[2] || idMatch[4] || null;
    text = idMatch[5];
  }

  // 3. Detect Level & Category
  let level = "info";
  if (text.includes("❌") || text.includes("💥") || text.includes("[ERROR]") || text.includes("ERROR")) {
    level = "error";
  } else if (text.includes("⚠️") || text.includes("[WARN]") || text.includes("WARN")) {
    level = "warn";
  } else if (text.includes("🌊") || text.includes("[STREAM]")) {
    level = "stream";
  } else if (text.includes("📊") || text.includes("📈") || text.includes("[USAGE]")) {
    level = "usage";
  } else if (text.includes("📥") || text.includes("▶ POST") || text.includes("POST ") || text.includes("GET ")) {
    level = "request";
  } else if (text.includes("🤯") || text.includes("[TTFT]")) {
    level = "ttft";
  }

  // 4. Extract Key Metadata
  const metadata = {};

  // Endpoint & Messages, Tools, Effort
  const epMatch = text.match(/(POST|GET)\s+(\/[^\s|]+)(?:\s+\|\s+([^\s|]+))?/i);
  if (epMatch) {
    metadata.method = epMatch[1];
    metadata.endpoint = epMatch[2];
    metadata.combo = epMatch[3] || null;
  }

  const msgMatch = text.match(/\b(\d+)\s*(?:msgs?|MSG)\b/i);
  if (msgMatch) {
    metadata.msgs = Number(msgMatch[1]);
  }

  const toolMatch = text.match(/\b(\d+)\s*(?:tools?|TOOL)\b/i);
  if (toolMatch) {
    metadata.tools = Number(toolMatch[1]);
  }

  const effortMatch = text.match(/\b(?:effort=|THINK:|think=)([a-z0-9_:-]+)/i);
  if (effortMatch) {
    metadata.effort = effortMatch[1];
  }

  // Model Routing:
  // 1. Target Routing: cx/gpt-5.6-luna → codex/gpt-5.6-luna or → gpt-5.6-terra
  const routeMatch = text.match(/→\s+([a-z0-9._-]+\/[a-z0-9._-]+|[a-z0-9._-]+)/i);
  if (routeMatch && !/^\d+$/.test(routeMatch[1])) {
    metadata.targetModel = routeMatch[1];
  }

  // 2. Explicit model param with word boundary: model=gpt-5.6-terra (MUST NOT match authmodel=1)
  const modelParamMatch = text.match(/\bmodel=([a-z0-9._/-]+)/i);
  if (modelParamMatch && !/^\d+$/.test(modelParamMatch[1])) {
    metadata.model = modelParamMatch[1];
  }

  // 3. Stream or TTFT model name: [STREAM] CODEX | gpt-5.6-luna | 4429ms
  const streamModelMatch = text.match(
    /\[(?:STREAM|TTFT|USAGE)\]\s+[a-z0-9_-]+\s*\|\s*([a-z0-9._/-]+)/i,
  );
  if (
    streamModelMatch &&
    !/^\d+$/.test(streamModelMatch[1]) &&
    !streamModelMatch[1].startsWith("in=")
  ) {
    metadata.model = streamModelMatch[1];
  }

  // Account Email or Conn ID:
  // 1. Explicit email in Auth log: Using codex account: foo@gmail.com or ACC:foo@gmail.com
  const emailMatch = text.match(
    /(?:Using\s+\S+\s+account:\s*|ACC:)([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/i,
  );
  if (emailMatch) {
    metadata.userEmail = emailMatch[1];
  }

  // 2. Generic account or hash from [USAGE]: account=dceed7f8... or account=foo@bar.com
  const accMatch = text.match(
    /(?:Using\s+\S+\s+account:\s*|ACC:|account=)([a-z0-9._%+-]+(?:@[a-z0-9.-]+\.[a-z]{2,})?|[a-z0-9.]{6,})/i,
  );
  if (accMatch) {
    metadata.account = accMatch[1];
  }

  // Tokens Usage: in=43858 | out=157 | cache_read=42496 (96.89%)
  const usageMatch = text.match(
    /in=(\d+)(?:\s+\|\s+out=(\d+))?(?:.*?cache_read=(\d+)\s*\(([\d.]+)%\))?/i,
  );
  if (usageMatch) {
    let tokensIn = Number(usageMatch[1]);
    const tokensOut = usageMatch[2] ? Number(usageMatch[2]) : null;
    const cacheRead = usageMatch[3] ? Number(usageMatch[3]) : null;
    let cachePct = usageMatch[4] ? Number(usageMatch[4]) : null;

    // Defense-in-depth: if legacy/exclusive log reported tokensIn excluding cacheRead (cachePct > 100% or tokensIn < cacheRead),
    // fold cacheRead into tokensIn and recompute cachePct so table view displays correctly.
    if (cacheRead != null && (cachePct > 100 || tokensIn < cacheRead)) {
      tokensIn += cacheRead;
      cachePct = Number(((cacheRead / tokensIn) * 100).toFixed(2));
    }

    metadata.tokensIn = tokensIn;
    if (tokensOut != null) metadata.tokensOut = tokensOut;
    if (cacheRead != null) metadata.cacheRead = cacheRead;
    if (cachePct != null) metadata.cachePct = cachePct;
  }

  // TTFT & Duration: total=4432 | ttft=1431 | 4429ms | complete | disconnect: ResponseAborted
  const ttftMatch = text.match(/total=(\d+)\s+\|\s+ttft=(\d+)/i);
  if (ttftMatch) {
    metadata.duration = Number(ttftMatch[1]);
    metadata.ttft = Number(ttftMatch[2]);
  }
  const streamMatch = text.match(/\|\s*(\d+)ms\s*\|\s*(.*)$/i);
  if (streamMatch) {
    metadata.duration = Number(streamMatch[1]);
    const streamStatus = streamMatch[2].trim();
    if (/complete/i.test(streamStatus)) {
      metadata.completed = true;
    } else if (
      /disconnect|abort|client_closed|closed|failed|stall|error/i.test(
        streamStatus,
      )
    ) {
      metadata.disconnected = true;
      const reasonMatch = streamStatus.match(
        /(?:disconnect:\s*|reason:\s*)([^\s|]+)/i,
      );
      metadata.disconnectReason = reasonMatch ? reasonMatch[1] : streamStatus;
    }
  } else if (
    /disconnect:|ResponseAborted|ClientAbort|client_closed/i.test(text)
  ) {
    metadata.disconnected = true;
    const reasonMatch = text.match(/(?:disconnect:\s*)([^\s|]+)/i);
    if (reasonMatch) metadata.disconnectReason = reasonMatch[1];
  }

  return {
    raw: rawLine,
    timestamp,
    reqId,
    connId,
    level,
    text,
    metadata,
  };
}

function cleanModelName(rawModel) {
  if (!rawModel || /^\d+$/.test(rawModel)) return null;
  const uuidPrefixMatch = rawModel.match(
    /^[a-z0-9-]+-compatible-[a-z0-9]+-[a-f0-9-]{10,}\/(.+)$/i,
  );
  if (uuidPrefixMatch) {
    return uuidPrefixMatch[1];
  }
  if (rawModel.includes("/")) {
    const parts = rawModel.split("/");
    if (parts[0].length > 20) return parts[1];
  }
  return rawModel;
}

/**
 * Group raw log lines into structured Request Groups.
 */
export function groupLogLines(rawLines) {
  const groups = new Map();
  const systemLines = [];
  let lastReqId = null;

  for (let i = 0; i < rawLines.length; i++) {
    const rawLine = rawLines[i];
    const parsed = parseLogLine(rawLine);

    // If line has no reqId, check if it belongs to the previous active request (e.g. stream chunk or usage log immediately after)
    let targetReqId = parsed.reqId;
    if (!targetReqId) {
      if (
        lastReqId &&
        (parsed.level === "stream" ||
          parsed.level === "usage" ||
          parsed.text.includes("▶ POST") ||
          parsed.text.includes("DBG:"))
      ) {
        targetReqId = lastReqId;
      }
    }

    if (targetReqId) {
      lastReqId = targetReqId;
      let group = groups.get(targetReqId);
      if (!group) {
        group = {
          id: targetReqId,
          connId: parsed.connId || null,
          startTime: parsed.timestamp || "",
          endTime: parsed.timestamp || "",
          endpoint: "/v1/chat/completions",
          method: "POST",
          combo: null,
          model: null,
          provider: null,
          account: null,
          msgs: null,
          tools: null,
          effort: null,
          status: "pending",
          statusCode: 200,
          duration: null,
          ttft: null,
          tokensIn: null,
          tokensOut: null,
          cacheRead: null,
          cachePct: null,
          hasError: false,
          errorMessage: null,
          lines: [],
        };
        groups.set(targetReqId, group);
      }

      group.lines.push(parsed);
      group.endTime = parsed.timestamp || group.endTime;
      if (parsed.connId && !group.connId) group.connId = parsed.connId;

      // Merge metadata
      const m = parsed.metadata;
      if (m.endpoint) group.endpoint = m.endpoint;
      if (m.method) group.method = m.method;
      if (m.combo) {
        group.combo = m.combo;
        if (!group.account || group.account.endsWith("...")) {
          group.account = m.combo;
        }
      }

      if (m.msgs != null) {
        if (group.msgs == null || (group.msgs === 0 && m.msgs > 0)) {
          group.msgs = m.msgs;
        }
      }
      if (m.tools != null) {
        if (group.tools == null || (group.tools === 0 && m.tools > 0)) {
          group.tools = m.tools;
        }
      }
      if (m.effort != null) {
        group.effort = m.effort;
      }

      // Format model: targetModel takes highest precedence
      if (m.targetModel) {
        const cleaned = cleanModelName(m.targetModel);
        if (cleaned) group.model = cleaned;
      } else if (!group.model && m.model) {
        const cleaned = cleanModelName(m.model);
        if (cleaned) group.model = cleaned;
      }

      // Account name priority: Email > Combo/Profile Name > Raw Conn ID Hash
      if (m.userEmail) {
        group.account = m.userEmail;
      } else if (
        !group.account ||
        group.account.endsWith("...") ||
        /^[a-f0-9]{8}/i.test(group.account)
      ) {
        if (group.combo) {
          group.account = group.combo;
        } else if (m.account) {
          group.account = m.account;
        }
      }
      if (m.tokensIn != null) group.tokensIn = m.tokensIn;
      if (m.tokensOut != null) group.tokensOut = m.tokensOut;
      if (m.cacheRead != null) group.cacheRead = m.cacheRead;
      if (m.cachePct != null) group.cachePct = m.cachePct;
      if (m.duration != null) group.duration = m.duration;
      if (m.ttft != null) group.ttft = m.ttft;

      if (parsed.level === "error") {
        group.hasError = true;
        group.status = "error";
        group.statusCode = 500;
        group.errorMessage = parsed.text;
      } else if (
        parsed.metadata.disconnected ||
        (parsed.level === "stream" &&
          (/disconnect|aborted|responseaborted|clientabort|client_closed/i.test(
            parsed.text,
          )))
      ) {
        if (!group.hasError && group.status !== "error") {
          group.status = "aborted";
          group.statusCode = 499;
          group.isAborted = true;
          if (parsed.metadata.disconnectReason) {
            group.disconnectReason = parsed.metadata.disconnectReason;
          }
        }
      } else if (parsed.level === "stream" && parsed.text.includes("complete")) {
        if (!group.hasError && group.status !== "error" && !group.isAborted) {
          group.status = "success";
        }
      } else if (parsed.level === "ttft" || parsed.level === "usage") {
        if (!group.hasError && group.status !== "error" && !group.isAborted) {
          group.status = "success";
        }
      }
    } else {
      systemLines.push(parsed);
    }
  }

  // Convert map to array sorted by latest activity
  const groupList = Array.from(groups.values()).reverse();
  return {
    groups: groupList,
    systemLines,
    totalRequests: groupList.length,
  };
}
