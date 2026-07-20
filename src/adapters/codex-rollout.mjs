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
import { accountScopedEventId, payloadHash, sha256 } from "../crypto.mjs";
import { canonicalModelId } from "../model-registry.mjs";

function turnContext(record, current) {
  if (record?.type !== "turn_context") {
    return current;
  }
  const payload = record.payload || {};
  return {
    model: normalizeModel(payload.model || current.model),
    serviceTier: payload.thread_settings?.service_tier || payload.service_tier || current.serviceTier || null
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

const USAGE_PREFIX_SEED = sha256("codex-allowlisted-usage-prefix-v1");

function usageAnchorDigest(record, usageRecord, context, sessionIdentityHash) {
  if (!usageRecord) return null;
  return payloadHash({
    observedAt: normalizeTimestamp(record.timestamp),
    cumulativeTotal: usageRecord.cumulativeTotal,
    usage: normalizeUsage(usageRecord.last, "codex"),
    sourceModelId: context.model,
    mode: normalizeMode({ serviceTier: context.serviceTier }),
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
  let context = { model: "unknown", serviceTier: null };
  let sessionIdentityHash = sha256("codex-session-filename\0" + filenameIdentity);
  for await (const line of readCompleteJsonLines(filePath, 0, endOffset)) {
    if (line.oversized || line.text.trim().length === 0) continue;
    if (!/"type"\s*:\s*"session_meta"/.test(line.text)
      && !/"type"\s*:\s*"turn_context"/.test(line.text)
      && !/"type"\s*:\s*"token_count"/.test(line.text)) {
      continue;
    }
    let record;
    try {
      record = JSON.parse(line.text);
    } catch {
      continue;
    }
    if (record?.type === "session_meta" && typeof record?.payload?.id === "string" && record.payload.id.length >= 8) {
      sessionIdentityHash = sha256("codex-session\0" + record.payload.id);
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

export async function parseCodexRollout(filePath, options) {
  const resolveModel = options.canonicalModelId || canonicalModelId;
  const stat = await fs.stat(filePath);
  const savedCursor = options.cursor || {};
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
  let prefixMismatch = false;
  let verifiedPrefix = null;
  if (!replaced
    && !legacyCursor
    && validOffset
    && savedCursor.offset > 0) {
    if (!(await isCompleteLineBoundary(filePath, savedCursor.offset))
      || savedCursor.usagePrefixVersion !== 1
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
    ? { model: "unknown", serviceTier: null }
    : {
        model: normalizeModel(savedCursor.model),
        serviceTier: savedCursor.serviceTier || null
      };
  let committedOffset = startOffset;
  let malformed = 0;
  let duplicateSnapshots = 0;
  let cumulativeResets = 0;
  let cumulativeMismatches = 0;
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
  const events = [];

  for await (const line of readCompleteJsonLines(filePath, startOffset)) {
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
    if (record?.type === "session_meta" && typeof record?.payload?.id === "string" && record.payload.id.length >= 8) {
      sessionIdentityHash = sha256("codex-session\0" + record.payload.id);
      continue;
    }
    context = turnContext(record, context);
    const usageRecord = tokenUsageRecord(record);
    if (!usageRecord) {
      continue;
    }
    const observedAt = normalizeTimestamp(record.timestamp);
    const occurrenceOrdinal = (timestampCounts.get(
      timestampOccurrenceKey(sessionIdentityHash, observedAt)
    ) || 0) + 1;
    const anchorDigest = usageAnchorDigest(record, usageRecord, context, sessionIdentityHash);
    const snapshotHash = payloadHash(normalizeUsage(usageRecord.last, "codex"));
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
    const stableRecordIdentity = [
      sessionIdentityHash,
      observedAt || "invalid_timestamp",
      String(occurrenceOrdinal)
    ].join("\0");
    const mode = normalizeMode({ serviceTier: context.serviceTier });
    const modelId = resolveModel("codex", context.model);
    const event = {
      eventId: accountScopedEventId(options.dedupNamespaceKey, "codex", stableRecordIdentity),
      provider: "codex",
      modelId,
      sourceModelId: context.model,
      observedAt,
      mode,
      usage: normalizeUsage(usageRecord.last, "codex"),
      provenance: {
        collector: "codex_rollout_jsonl_fallback",
        verification: "connector_attested",
        surface: "codex"
      }
    };
    nextTimestampOrdinal(timestampCounts, sessionIdentityHash, observedAt);
    usagePrefixDigest = advanceUsagePrefix(usagePrefixDigest, anchorDigest);
    usagePrefixCount += 1;
    if (cumulativeReset) cumulativeResets += 1;
    if (cumulativeMismatch) cumulativeMismatches += 1;
    lastCumulativeTotal = usageRecord.cumulativeTotal;
    lastSnapshotHash = snapshotHash;
    events.push(event);
  }

  return {
    events,
    malformed,
    duplicateSnapshots,
    cumulativeResets,
    cumulativeMismatches,
    cursor: {
      fileIdentity,
      offset: committedOffset,
      model: context.model,
      serviceTier: context.serviceTier,
      lastCumulativeTotal,
      lastSnapshotHash,
      sessionIdentityHash,
      usagePrefixVersion: 1,
      usagePrefixDigest,
      usagePrefixCount,
      lastSeenAt: options.now ?? Date.now()
    }
  };
}
