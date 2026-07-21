import fs from "node:fs/promises";
import { canonicalModelId } from "../model-registry.mjs";
import { accountScopedEventId, payloadHash, sha256 } from "../crypto.mjs";
import {
  normalizeMode,
  normalizeTimestamp,
  normalizeUsage,
  isCompleteLineBoundary,
  readCompleteJsonLines
} from "./shared.mjs";

function getUsageRecord(record) {
  if (record?.type !== "usage.record" || !record?.usage) {
    return null;
  }
  return record;
}

const USAGE_PREFIX_SEED = sha256("kimi-allowlisted-usage-prefix-v1");

function usageContentDigest(usageRecord, stableJournalIdentity) {
  if (!usageRecord) return null;
  const sourceModelId = typeof usageRecord.model === "string" ? usageRecord.model.slice(0, 120) : "unknown";
  const fast = sourceModelId.toLowerCase().includes("highspeed");
  return payloadHash({
    sourceModelId,
    observedAt: normalizeTimestamp(usageRecord.time || usageRecord.timestamp),
    mode: normalizeMode({ speed: fast ? "fast" : "standard" }),
    usage: normalizeUsage({
      input_tokens: usageRecord.usage.inputOther,
      cache_read_input_tokens: usageRecord.usage.inputCacheRead,
      cache_creation_input_tokens: usageRecord.usage.inputCacheCreation,
      output_tokens: usageRecord.usage.output
    }, "kimi"),
    stableJournalIdentity
  });
}

function advanceUsagePrefix(digest, anchorDigest) {
  return sha256(["kimi-allowlisted-usage-prefix-v1", digest, anchorDigest].join("\0"));
}

function providerRecordIdentity(usageRecord) {
  for (const key of ["recordId", "usageId", "id"]) {
    const value = usageRecord?.[key];
    if (typeof value === "string" && value.length > 0 && value.length <= 200) {
      return `${key}:${value}`;
    }
  }
  return null;
}

function nextTimestampOrdinal(timestampCounts, observedAt) {
  const timestampKey = observedAt || "invalid_timestamp";
  const ordinal = (timestampCounts.get(timestampKey) || 0) + 1;
  timestampCounts.set(timestampKey, ordinal);
  return ordinal;
}

async function scanUsagePrefix(filePath, endOffset, stableJournalIdentity) {
  let digest = USAGE_PREFIX_SEED;
  let count = 0;
  const timestampCounts = new Map();
  for await (const line of readCompleteJsonLines(filePath, 0, endOffset)) {
    if (line.oversized || !/"type"\s*:\s*"usage\.record"/.test(line.text)) continue;
    let record;
    try {
      record = JSON.parse(line.text);
    } catch {
      continue;
    }
    const usageRecord = getUsageRecord(record);
    if (!usageRecord) continue;
    nextTimestampOrdinal(
      timestampCounts,
      normalizeTimestamp(usageRecord.time || usageRecord.timestamp)
    );
    digest = advanceUsagePrefix(
      digest,
      usageContentDigest(usageRecord, stableJournalIdentity)
    );
    count += 1;
  }
  return { digest, count, timestampCounts };
}

export async function parseKimiWire(filePath, options) {
  const resolveModel = options.canonicalModelId || canonicalModelId;
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
    "kimi-journal-file-v2",
    String(stat.dev),
    String(stat.ino),
    // Preserve the sub-millisecond creation time so a rapid same-path file
    // replacement cannot reuse the previous journal identity on Windows.
    String(stat.birthtimeMs)
  ].join("\0"));
  const replaced = typeof savedCursor.fileIdentity === "string"
    && savedCursor.fileIdentity !== fileIdentity;
  const legacyCursor = Number.isSafeInteger(savedCursor.offset)
    && typeof savedCursor.fileIdentity !== "string";
  const validOffset = Number.isSafeInteger(savedCursor.offset)
    && savedCursor.offset >= 0
    && savedCursor.offset <= stat.size;
  const unchangedCompleteFile = !replaced
    && !legacyCursor
    && validOffset
    && savedCursor.offset === stat.size
    && savedCursor.observedSize === stat.size
    && savedCursor.observedMtimeMs === stat.mtimeMs;
  if (unchangedCompleteFile) {
    return {
      events: [],
      malformed: 0,
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
      || savedCursor.usagePrefixVersion !== 1
      || typeof savedCursor.usagePrefixDigest !== "string"
      || !Number.isSafeInteger(savedCursor.usagePrefixCount)
      || savedCursor.usagePrefixCount < 0) {
      prefixMismatch = true;
    } else {
      verifiedPrefix = await scanUsagePrefix(filePath, savedCursor.offset, options.stableJournalIdentity);
      prefixMismatch = verifiedPrefix.digest !== savedCursor.usagePrefixDigest
        || verifiedPrefix.count !== savedCursor.usagePrefixCount;
    }
  }
  const startOffset = !replaced
    && !legacyCursor
    && validOffset
    && !prefixMismatch
    ? savedCursor.offset
    : 0;
  let committedOffset = startOffset;
  let malformed = 0;
  let usagePrefixDigest = startOffset === 0 ? USAGE_PREFIX_SEED : savedCursor.usagePrefixDigest;
  let usagePrefixCount = startOffset === 0 ? 0 : savedCursor.usagePrefixCount;
  const timestampCounts = startOffset > 0
    ? (verifiedPrefix?.timestampCounts || new Map())
    : new Map();
  const events = [];
  let emittedEvents = 0;
  let reachedTimeBoundary = false;

  for await (const line of readCompleteJsonLines(filePath, startOffset, stat.size)) {
    committedOffset = line.endOffset;
    if (line.oversized) {
      malformed += 1;
      continue;
    }
    if (!/"type"\s*:\s*"usage\.record"/.test(line.text)) {
      continue;
    }
    let record;
    try {
      record = JSON.parse(line.text);
    } catch {
      malformed += 1;
      continue;
    }
    const usageRecord = getUsageRecord(record);
    if (!usageRecord) {
      continue;
    }
    const sourceModelId = typeof usageRecord.model === "string" ? usageRecord.model.slice(0, 120) : "unknown";
    const fast = sourceModelId.toLowerCase().includes("highspeed");
    const observedAt = normalizeTimestamp(usageRecord.time || usageRecord.timestamp);
    if (observedAt && Date.parse(observedAt) >= maximumObservedAtExclusive) {
      committedOffset = line.startOffset;
      reachedTimeBoundary = true;
      break;
    }
    if (observedAt && Date.parse(observedAt) < minimumObservedAtInclusive) {
      nextTimestampOrdinal(timestampCounts, observedAt);
      usagePrefixDigest = advanceUsagePrefix(
        usagePrefixDigest,
        usageContentDigest(usageRecord, options.stableJournalIdentity)
      );
      usagePrefixCount += 1;
      continue;
    }
    const contentDigest = usageContentDigest(usageRecord, options.stableJournalIdentity);
    const modelId = resolveModel("kimi", sourceModelId);
    const providerIdentity = providerRecordIdentity(usageRecord);
    const occurrenceOrdinal = providerIdentity
      ? null
      : (timestampCounts.get(observedAt || "invalid_timestamp") || 0) + 1;
    const stableRecordIdentity = [
      options.stableJournalIdentity,
      providerIdentity ? "provider_record" : "timestamp_ordinal",
      providerIdentity || observedAt || "invalid_timestamp",
      providerIdentity ? "" : String(occurrenceOrdinal)
    ].join("\0");
    const event = {
      eventId: accountScopedEventId(options.dedupNamespaceKey, "kimi", stableRecordIdentity),
      provider: "kimi",
      modelId,
      sourceModelId,
      aggregationScope: options.stableJournalIdentity,
      aggregationModeToken: sha256("kimi-raw-mode\0" + (fast ? "highspeed" : "standard")),
      observedAt,
      mode: normalizeMode({ speed: fast ? "fast" : "standard" }),
      usage: normalizeUsage({
        input_tokens: usageRecord.usage.inputOther,
        cache_read_input_tokens: usageRecord.usage.inputCacheRead,
        cache_creation_input_tokens: usageRecord.usage.inputCacheCreation,
        output_tokens: usageRecord.usage.output
      }, "kimi"),
      provenance: {
        collector: "kimi_v0_28_wire_usage_record_fallback",
        verification: "connector_attested",
        surface: "kimi_code"
      }
    };
    nextTimestampOrdinal(timestampCounts, observedAt);
    usagePrefixDigest = advanceUsagePrefix(
      usagePrefixDigest,
      contentDigest
    );
    usagePrefixCount += 1;
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
    eventCount: emittedEvents,
    reachedEventLimit: emittedEvents >= maximumEvents && committedOffset < stat.size,
    reachedTimeBoundary,
    cursor: {
      fileIdentity,
      offset: committedOffset,
      usagePrefixVersion: 1,
      usagePrefixDigest,
      usagePrefixCount,
      observedSize: stat.size,
      observedMtimeMs: stat.mtimeMs,
      lastSeenAt: options.now ?? Date.now()
    }
  };
}
