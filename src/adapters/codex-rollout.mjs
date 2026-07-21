import fs from "node:fs/promises";
import path from "node:path";
import {
  normalizeMode,
  normalizeModel,
  normalizeTimestamp,
  normalizeUsage,
  isCompleteLineBoundary,
  readCompleteJsonLines
} from "./shared.mjs";
import { accountScopedEventId, hmacAlias, payloadHash, sha256 } from "../crypto.mjs";
import { canonicalModelId } from "../model-registry.mjs";

function appliedThreadSettings(record) {
  if (record?.type === "turn_context") {
    const payload = record.payload || {};
    return {
      model: payload.model,
      serviceTier: payload.thread_settings?.service_tier ?? payload.service_tier,
      applied: true
    };
  }
  if (record?.type === "event_msg" && record?.payload?.type === "thread_settings_applied") {
    const settings = record.payload.thread_settings || {};
    return {
      model: settings.model ?? record.payload.model,
      serviceTier: settings.service_tier ?? record.payload.service_tier,
      applied: true
    };
  }
  return null;
}

function turnContext(record, current) {
  const settings = appliedThreadSettings(record);
  if (!settings) return current;
  return {
    model: normalizeModel(settings.model || current.model),
    serviceTier: settings.serviceTier ?? current.serviceTier ?? null,
    established: true
  };
}

function tokenUsageRecord(record) {
  if (record?.type !== "event_msg" || record?.payload?.type !== "token_count") {
    return null;
  }
  const info = record.payload.info || {};
  if (!info.last_token_usage) {
    return null;
  }
  return {
    last: info.last_token_usage,
    cumulativeTotal: Number.isSafeInteger(info.total_token_usage?.total_tokens)
      ? info.total_token_usage.total_tokens
      : null
  };
}

function taskStartedBoundary(record) {
  if (record?.type !== "event_msg" || record?.payload?.type !== "task_started") return null;
  const observedAtMs = Date.parse(record.timestamp || "");
  const rawStartedAt = record.payload.started_at;
  const startedAtMs = Number.isFinite(rawStartedAt)
    ? (rawStartedAt < 10_000_000_000 ? rawStartedAt * 1_000 : rawStartedAt)
    : Number.NaN;
  return {
    live: Number.isFinite(observedAtMs)
      && Number.isFinite(startedAtMs)
      && Math.abs(observedAtMs - startedAtMs) <= 2_000,
    observedAt: Number.isFinite(observedAtMs) ? new Date(observedAtMs).toISOString() : null,
    startedAt: Number.isFinite(startedAtMs) ? new Date(startedAtMs).toISOString() : null
  };
}

const USAGE_PREFIX_SEED = sha256("codex-allowlisted-usage-prefix-v1");

function usageAnchorDigest(record, usageRecord, context, sessionIdentityHash) {
  if (!usageRecord) return null;
  return payloadHash({
    observedAt: normalizeTimestamp(record.timestamp),
    cumulativeTotal: usageRecord.cumulativeTotal,
    usage: normalizeUsage(usageRecord.last, "codex"),
    sourceModelId: context.model,
    mode: normalizeMode({ provider: "codex", serviceTier: context.serviceTier }),
    sessionIdentityHash
  });
}

function advanceUsagePrefix(digest, anchorDigest) {
  return sha256(["codex-allowlisted-usage-prefix-v1", digest, anchorDigest].join("\0"));
}

function timestampOccurrenceKey(sessionIdentityHash, observedAt) {
  return sessionIdentityHash + "\0" + (observedAt || "invalid_timestamp");
}

function nextTimestampOrdinal(timestampCounts, sessionIdentityHash, observedAt) {
  const key = timestampOccurrenceKey(sessionIdentityHash, observedAt);
  const ordinal = (timestampCounts.get(key) || 0) + 1;
  timestampCounts.set(key, ordinal);
  return ordinal;
}

async function scanUsagePrefix(filePath, endOffset, filenameIdentity) {
  let digest = USAGE_PREFIX_SEED;
  let count = 0;
  const timestampCounts = new Map();
  let context = { model: "unknown", serviceTier: null, established: false };
  let sessionIdentityHash = sha256("codex-session-filename\0" + filenameIdentity);
  let sessionMetaSeen = false;
  let liveBoundaryEstablished = false;
  for await (const line of readCompleteJsonLines(filePath, 0, endOffset)) {
    if (line.oversized || line.text.trim().length === 0) continue;
    if (!/"type"\s*:\s*"session_meta"/.test(line.text)
      && !/"type"\s*:\s*"turn_context"/.test(line.text)
      && !/"type"\s*:\s*"thread_settings_applied"/.test(line.text)
      && !/"type"\s*:\s*"task_started"/.test(line.text)
      && !/"type"\s*:\s*"token_count"/.test(line.text)) {
      continue;
    }
    let record;
    try {
      record = JSON.parse(line.text);
    } catch {
      continue;
    }
    const sessionId = record?.type === "session_meta"
      ? (record?.payload?.id || record?.payload?.session_id)
      : null;
    if (!sessionMetaSeen && typeof sessionId === "string" && sessionId.length >= 8) {
      sessionIdentityHash = sha256("codex-session\0" + sessionId);
      sessionMetaSeen = true;
      continue;
    }
    const boundary = taskStartedBoundary(record);
    if (boundary) {
      digest = advanceUsagePrefix(digest, payloadHash({ type: "task_started", ...boundary }));
      count += 1;
      if (boundary.live && !liveBoundaryEstablished) {
        liveBoundaryEstablished = true;
      }
      continue;
    }
    context = turnContext(record, context);
    const usageRecord = tokenUsageRecord(record);
    if (!usageRecord) continue;
    nextTimestampOrdinal(
      timestampCounts,
      sessionIdentityHash,
      normalizeTimestamp(record.timestamp)
    );
    digest = advanceUsagePrefix(
      digest,
      usageAnchorDigest(record, usageRecord, context, sessionIdentityHash)
    );
    count += 1;
  }
  return { digest, count, timestampCounts };
}

function logicalSessionAlias(aliasKey, sessionId, filenameIdentity) {
  const identity = sessionId || ("filename:" + filenameIdentity);
  return aliasKey
    ? hmacAlias(aliasKey, "codex-logical-session", identity)
    : sha256("codex-logical-session\0" + identity);
}

function safeHighWatermark(entry) {
  return Number.isSafeInteger(entry?.highWatermark) && entry.highWatermark >= 0
    ? entry.highWatermark
    : null;
}

function safeEpoch(entry) {
  return Number.isSafeInteger(entry?.epoch) && entry.epoch >= 0 ? entry.epoch : 0;
}

function updateLogicalSession(logicalSessions, alias, highWatermark, now) {
  if (!alias) return;
  const current = logicalSessions[alias] || {};
  logicalSessions[alias] = {
    epoch: safeEpoch(current),
    highWatermark: Math.max(safeHighWatermark(current) || 0, highWatermark || 0),
    lastSeenAt: now
  };
}

export async function codexRolloutSortKey(filePath) {
  for await (const line of readCompleteJsonLines(filePath, 0)) {
    if (line.oversized || line.text.trim().length === 0) continue;
    if (!/"type"\s*:\s*"session_meta"/.test(line.text)) continue;
    let record;
    try {
      record = JSON.parse(line.text);
    } catch {
      continue;
    }
    const sessionId = record?.payload?.id || record?.payload?.session_id;
    if (record?.type !== "session_meta" || typeof sessionId !== "string" || sessionId.length < 8) continue;
    return [
      normalizeTimestamp(record.timestamp || record.payload.timestamp) || "9999-12-31T23:59:59.999Z",
      sha256("codex-session\0" + sessionId),
      path.basename(filePath)
    ].join("\0");
  }
  return ["9999-12-31T23:59:59.999Z", sha256(filePath), path.basename(filePath)].join("\0");
}

export async function parseCodexRollout(filePath, options) {
  const resolveModel = options.canonicalModelId || canonicalModelId;
  const hasExternalLogicalSessions = options.logicalSessions
    && typeof options.logicalSessions === "object"
    && !Array.isArray(options.logicalSessions);
  const logicalSessions = hasExternalLogicalSessions ? options.logicalSessions : {};
  const scanNow = options.now ?? Date.now();
  const stat = await fs.stat(filePath);
  const savedCursor = options.cursor || {};
  const maximumEvents = Number.isSafeInteger(options.maximumEvents) && options.maximumEvents >= 0
    ? options.maximumEvents
    : Number.POSITIVE_INFINITY;
  const minimumObservedAtInclusive = typeof options.minimumObservedAtInclusive === "string"
    ? Date.parse(options.minimumObservedAtInclusive)
    : Number.NEGATIVE_INFINITY;
  const maximumObservedAtExclusive = typeof options.maximumObservedAtExclusive === "string"
    ? Date.parse(options.maximumObservedAtExclusive)
    : Number.POSITIVE_INFINITY;
  const emitEvent = typeof options.onEvent === "function"
    ? options.onEvent
    : null;
  const fileIdentity = sha256([
    "codex-journal-file-v1",
    String(stat.dev),
    String(stat.ino),
    String(Math.trunc(stat.birthtimeMs))
  ].join("\0"));
  const replaced = typeof savedCursor.fileIdentity === "string"
    && savedCursor.fileIdentity !== fileIdentity;
  const legacyCursor = Number.isSafeInteger(savedCursor.offset)
    && typeof savedCursor.fileIdentity !== "string";
  const filenameIdentity = path.basename(filePath).match(/[0-9a-f]{8}-[0-9a-f-]{27,}/i)?.[0] || path.basename(filePath);
  const validOffset = Number.isSafeInteger(savedCursor.offset)
    && savedCursor.offset >= 0
    && savedCursor.offset <= stat.size;
  const unchangedCompleteFile = !replaced
    && !legacyCursor
    && validOffset
    && savedCursor.usagePrefixVersion === 2
    && savedCursor.offset === stat.size
    && savedCursor.observedSize === stat.size
    && savedCursor.observedMtimeMs === stat.mtimeMs;
  if (unchangedCompleteFile) {
    if (hasExternalLogicalSessions
      && typeof savedCursor.logicalSessionAlias === "string"
      && Number.isSafeInteger(savedCursor.logicalHighWatermark)
      && savedCursor.logicalHighWatermark >= 0) {
      updateLogicalSession(
        logicalSessions,
        savedCursor.logicalSessionAlias,
        savedCursor.logicalHighWatermark,
        scanNow
      );
    }
    return {
      events: [],
      malformed: 0,
      duplicateSnapshots: 0,
      cumulativeResets: 0,
      cumulativeMismatches: 0,
      inheritedSnapshots: 0,
      ambiguousLineage: 0,
      unclassifiedModes: 0,
      eventCount: 0,
      reachedEventLimit: false,
      reachedTimeBoundary: false,
      cursor: {
        ...savedCursor,
        lastSeenAt: options.now ?? Date.now()
      }
    };
  }
  let prefixMismatch = false;
  let verifiedPrefix = null;
  if (!replaced
    && !legacyCursor
    && validOffset
    && savedCursor.offset > 0) {
    if (!(await isCompleteLineBoundary(filePath, savedCursor.offset))
      || savedCursor.usagePrefixVersion !== 2
      || typeof savedCursor.usagePrefixDigest !== "string"
      || !Number.isSafeInteger(savedCursor.usagePrefixCount)
      || savedCursor.usagePrefixCount < 0) {
      prefixMismatch = true;
    } else {
      verifiedPrefix = await scanUsagePrefix(filePath, savedCursor.offset, filenameIdentity);
      prefixMismatch = verifiedPrefix.digest !== savedCursor.usagePrefixDigest
        || verifiedPrefix.count !== savedCursor.usagePrefixCount;
    }
  }
  const reset = replaced
    || legacyCursor
    || !validOffset
    || prefixMismatch;
  const startOffset = reset ? 0 : savedCursor.offset;
  let context = reset
    ? { model: "unknown", serviceTier: null, established: false }
    : {
        model: normalizeModel(savedCursor.model),
        serviceTier: savedCursor.serviceTier || null,
        established: savedCursor.contextEstablished === true
      };
  let committedOffset = startOffset;
  let malformed = 0;
  let duplicateSnapshots = 0;
  let cumulativeResets = 0;
  let cumulativeMismatches = 0;
  let inheritedSnapshots = 0;
  let ambiguousLineage = 0;
  let unclassifiedModes = 0;
  let lastCumulativeTotal = reset ? null : (savedCursor.lastCumulativeTotal ?? null);
  let lastSnapshotHash = reset ? null : (savedCursor.lastSnapshotHash ?? null);
  let usagePrefixDigest = reset ? USAGE_PREFIX_SEED : savedCursor.usagePrefixDigest;
  let usagePrefixCount = reset ? 0 : savedCursor.usagePrefixCount;
  const timestampCounts = reset
    ? new Map()
    : (verifiedPrefix?.timestampCounts || new Map());
  let sessionIdentityHash = reset
    ? sha256("codex-session-filename\0" + filenameIdentity)
    : (savedCursor.sessionIdentityHash || sha256("codex-session-filename\0" + filenameIdentity));
  let sessionMetaSeen = reset ? false : savedCursor.sessionMetaSeen === true;
  let requiresLiveBoundary = reset ? false : savedCursor.requiresLiveBoundary === true;
  let liveBoundaryEstablished = reset ? false : savedCursor.liveBoundaryEstablished === true;
  let preludeMax = reset
    ? 0
    : (Number.isSafeInteger(savedCursor.preludeMax) && savedCursor.preludeMax >= 0
      ? savedCursor.preludeMax
      : 0);
  let sessionAlias = reset
    ? logicalSessionAlias(options.aliasKey, null, filenameIdentity)
    : (savedCursor.logicalSessionAlias || logicalSessionAlias(options.aliasKey, null, filenameIdentity));
  if (!reset && !hasExternalLogicalSessions && safeHighWatermark(logicalSessions[sessionAlias]) === null) {
    updateLogicalSession(logicalSessions, sessionAlias, savedCursor.logicalHighWatermark, scanNow);
  }
  const events = [];
  let emittedEvents = 0;
  let reachedTimeBoundary = false;

  for await (const line of readCompleteJsonLines(filePath, startOffset, stat.size)) {
    committedOffset = line.endOffset;
    if (line.oversized) {
      malformed += 1;
      continue;
    }
    if (line.text.trim().length === 0) {
      continue;
    }
    if (!/"type"\s*:\s*"session_meta"/.test(line.text)
      && !/"type"\s*:\s*"turn_context"/.test(line.text)
      && !/"type"\s*:\s*"thread_settings_applied"/.test(line.text)
      && !/"type"\s*:\s*"task_started"/.test(line.text)
      && !/"type"\s*:\s*"token_count"/.test(line.text)) {
      continue;
    }
    let record;
    try {
      record = JSON.parse(line.text);
    } catch {
      malformed += 1;
      continue;
    }
    const recordSessionId = record?.type === "session_meta"
      ? (record?.payload?.id || record?.payload?.session_id)
      : null;
    if (!sessionMetaSeen && typeof recordSessionId === "string" && recordSessionId.length >= 8) {
      sessionIdentityHash = sha256("codex-session\0" + recordSessionId);
      sessionAlias = logicalSessionAlias(options.aliasKey, recordSessionId, filenameIdentity);
      sessionMetaSeen = true;
      const parentIdentity = record.payload.forked_from_id
        || record.payload.parent_thread_id
        || (typeof record.payload.id === "string"
          && typeof record.payload.session_id === "string"
          && record.payload.session_id !== record.payload.id
          ? record.payload.session_id
          : null);
      requiresLiveBoundary = typeof parentIdentity === "string" && parentIdentity.length >= 8;
      continue;
    }
    if (record?.type === "session_meta") {
      if (!liveBoundaryEstablished) requiresLiveBoundary = true;
      continue;
    }
    const boundary = taskStartedBoundary(record);
    if (boundary) {
      requiresLiveBoundary = true;
      if (boundary.live) {
        const firstLiveBoundary = !liveBoundaryEstablished;
        if (firstLiveBoundary) {
          const existingHighWatermark = safeHighWatermark(logicalSessions[sessionAlias]) || 0;
          updateLogicalSession(
            logicalSessions,
            sessionAlias,
            Math.max(existingHighWatermark, preludeMax),
            scanNow
          );
        }
        liveBoundaryEstablished = true;
      }
      usagePrefixDigest = advanceUsagePrefix(
        usagePrefixDigest,
        payloadHash({ type: "task_started", ...boundary })
      );
      usagePrefixCount += 1;
      continue;
    }
    context = turnContext(record, context);
    const usageRecord = tokenUsageRecord(record);
    if (!usageRecord) {
      continue;
    }
    const observedAt = normalizeTimestamp(record.timestamp);
    if (observedAt && Date.parse(observedAt) >= maximumObservedAtExclusive) {
      committedOffset = line.startOffset;
      reachedTimeBoundary = true;
      break;
    }
    const anchorDigest = usageAnchorDigest(record, usageRecord, context, sessionIdentityHash);
    const normalizedUsage = normalizeUsage(usageRecord.last, "codex");
    if (!liveBoundaryEstablished && usageRecord.cumulativeTotal !== null) {
      preludeMax = Math.max(preludeMax, usageRecord.cumulativeTotal);
    }
    const snapshotHash = payloadHash(normalizedUsage);
    let duplicate = false;
    let cumulativeReset = false;
    let cumulativeMismatch = false;
    if (usageRecord.cumulativeTotal !== null && lastCumulativeTotal !== null) {
      if (usageRecord.cumulativeTotal === lastCumulativeTotal) {
        duplicate = true;
      } else if (usageRecord.cumulativeTotal < lastCumulativeTotal) {
        cumulativeReset = true;
      } else {
        const delta = usageRecord.cumulativeTotal - lastCumulativeTotal;
        const lastTotal = Number.isSafeInteger(usageRecord.last.total_tokens)
          ? usageRecord.last.total_tokens
          : null;
        if (lastTotal !== null && delta !== lastTotal) {
          cumulativeMismatch = true;
        }
      }
    } else if (usageRecord.cumulativeTotal === null && snapshotHash === lastSnapshotHash) {
      duplicate = true;
    }
    if (duplicate) {
      nextTimestampOrdinal(timestampCounts, sessionIdentityHash, observedAt);
      usagePrefixDigest = advanceUsagePrefix(usagePrefixDigest, anchorDigest);
      usagePrefixCount += 1;
      duplicateSnapshots += 1;
      lastSnapshotHash = snapshotHash;
      continue;
    }
    const commitSnapshot = () => {
      nextTimestampOrdinal(timestampCounts, sessionIdentityHash, observedAt);
      usagePrefixDigest = advanceUsagePrefix(usagePrefixDigest, anchorDigest);
      usagePrefixCount += 1;
      if (cumulativeReset) cumulativeResets += 1;
      if (cumulativeMismatch) cumulativeMismatches += 1;
      lastCumulativeTotal = usageRecord.cumulativeTotal;
      lastSnapshotHash = snapshotHash;
    };
    if (!context.established || (requiresLiveBoundary && !liveBoundaryEstablished)) {
      inheritedSnapshots += 1;
      commitSnapshot();
      continue;
    }
    let shouldEmit = true;
    if (usageRecord.cumulativeTotal === null) {
      // Without a cumulative endpoint, a copied/re-timestamped snapshot cannot
      // be distinguished from new usage. Keep it local and visible in stats.
      shouldEmit = false;
      ambiguousLineage += 1;
    } else {
      const cumulativeTotal = usageRecord.cumulativeTotal;
      const highWatermark = safeHighWatermark(logicalSessions[sessionAlias]);
      const inferredBaseline = cumulativeTotal >= normalizedUsage.total
        ? cumulativeTotal - normalizedUsage.total
        : null;
      if (highWatermark === null) {
        if (inferredBaseline === null) {
          shouldEmit = false;
          ambiguousLineage += 1;
        } else {
          if (inferredBaseline > 0) inheritedSnapshots += 1;
          updateLogicalSession(logicalSessions, sessionAlias, cumulativeTotal, scanNow);
        }
      } else if (cumulativeTotal <= highWatermark) {
        shouldEmit = false;
        inheritedSnapshots += 1;
        updateLogicalSession(logicalSessions, sessionAlias, highWatermark, scanNow);
      } else if (inferredBaseline !== null && highWatermark <= inferredBaseline) {
        if (highWatermark < inferredBaseline) inheritedSnapshots += 1;
        updateLogicalSession(logicalSessions, sessionAlias, cumulativeTotal, scanNow);
      } else {
        // A prior high-watermark cuts through the reported last-turn usage.
        // Partial allocation would invent provider/category totals, so advance
        // past the ambiguity without uploading it.
        shouldEmit = false;
        ambiguousLineage += 1;
        updateLogicalSession(logicalSessions, sessionAlias, cumulativeTotal, scanNow);
      }
    }
    if (observedAt && Date.parse(observedAt) < minimumObservedAtInclusive) {
      commitSnapshot();
      continue;
    }
    if (!shouldEmit) {
      commitSnapshot();
      continue;
    }
    const stableRecordIdentity = [
      sessionIdentityHash,
      "cumulative-v2",
      String(safeEpoch(logicalSessions[sessionAlias])),
      String(usageRecord.cumulativeTotal)
    ].join("\0");
    const mode = normalizeMode({ provider: "codex", serviceTier: context.serviceTier });
    if (!mode.classified) unclassifiedModes += 1;
    const modelId = resolveModel("codex", context.model);
    const event = {
      eventId: accountScopedEventId(options.dedupNamespaceKey, "codex", stableRecordIdentity),
      provider: "codex",
      modelId,
      sourceModelId: context.model,
      aggregationScope: sessionIdentityHash,
      aggregationModeToken: sha256("codex-raw-mode\0" + (context.serviceTier || "unclassified")),
      observedAt,
      mode,
      usage: normalizedUsage,
      provenance: {
        collector: "codex_rollout_jsonl_fallback",
        verification: "connector_attested",
        surface: "codex"
      }
    };
    commitSnapshot();
    if (emitEvent) {
      emitEvent(event);
    } else {
      events.push(event);
    }
    emittedEvents += 1;
    if (emittedEvents >= maximumEvents) {
      break;
    }
  }

  return {
    events,
    malformed,
    duplicateSnapshots,
    cumulativeResets,
    cumulativeMismatches,
    inheritedSnapshots,
    ambiguousLineage,
    unclassifiedModes,
    eventCount: emittedEvents,
    reachedEventLimit: emittedEvents >= maximumEvents && committedOffset < stat.size,
    reachedTimeBoundary,
    cursor: {
      fileIdentity,
      offset: committedOffset,
      model: context.model,
      serviceTier: context.serviceTier,
      contextEstablished: context.established,
      requiresLiveBoundary,
      liveBoundaryEstablished,
      preludeMax,
      lastCumulativeTotal,
      lastSnapshotHash,
      sessionIdentityHash,
      sessionMetaSeen,
      logicalSessionAlias: sessionAlias,
      logicalHighWatermark: safeHighWatermark(logicalSessions[sessionAlias]),
      usagePrefixVersion: 2,
      usagePrefixDigest,
      usagePrefixCount,
      observedSize: stat.size,
      observedMtimeMs: stat.mtimeMs,
      lastSeenAt: options.now ?? Date.now()
    }
  };
}
