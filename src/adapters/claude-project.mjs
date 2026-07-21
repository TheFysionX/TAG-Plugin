import { normalizeMode, normalizeModel, normalizeTimestamp, normalizeUsage, readCompleteJsonLines, totalForComparison } from "./shared.mjs";
import { accountScopedEventId, sha256 } from "../crypto.mjs";
import { canonicalModelId } from "../model-registry.mjs";
import path from "node:path";

function assistantSnapshot(record, options, line) {
  if (record?.type !== "assistant" || !record?.message?.usage) {
    return null;
  }
  if (typeof record.message.stop_reason !== "string" || record.message.stop_reason.trim().length === 0) {
    return null;
  }
  const messageId = typeof record.message.id === "string" && record.message.id.length >= 8
    ? record.message.id
    : null;
  if (!messageId) {
    return null;
  }
  const serviceTier = record.message.usage.service_tier || record.message.service_tier || record.service_tier || null;
  // Claude's service_tier is a routing/billing field, not the inference-speed
  // control. usage.speed is authoritative; older journal placements remain
  // compatibility fallbacks when the nested value is absent.
  const speed = record.message.usage.speed ?? record.message.speed ?? record.speed ?? null;
  const sourceModelId = normalizeModel(record.message.model);
  const resolveModel = options.canonicalModelId || canonicalModelId;
  return {
    eventId: accountScopedEventId(options.dedupNamespaceKey, "claude", messageId),
    provider: "claude",
    modelId: resolveModel("claude", sourceModelId),
    sourceModelId,
    aggregationScope: options.stableJournalIdentity,
    aggregationModeToken: sha256([
      "claude-raw-mode",
      serviceTier || "default",
      speed || "default"
    ].join("\0")),
    observedAt: normalizeTimestamp(record.timestamp),
    mode: normalizeMode({ provider: "claude", serviceTier, speed }),
    usage: normalizeUsage(record.message.usage, "claude"),
    provenance: {
      collector: "claude_project_jsonl_fallback",
      verification: "connector_attested",
      surface: "claude_code"
    },
    _lineOrder: line.startOffset
  };
}

export function chooseClaudeSnapshot(current, candidate) {
  if (!current) {
    return candidate;
  }
  const currentTotal = totalForComparison(current);
  const candidateTotal = totalForComparison(candidate);
  if (candidateTotal > currentTotal || (candidateTotal === currentTotal && candidate._lineOrder >= current._lineOrder)) {
    return candidate;
  }
  return current;
}

export async function parseClaudeProject(filePath, options) {
  const filenameIdentity = path.basename(filePath).match(/[0-9a-f]{8}-[0-9a-f-]{27,}/i)?.[0]
    || path.basename(filePath);
  const stableJournalIdentity = options.stableJournalIdentity
    || sha256("claude-session-file\0" + filenameIdentity);
  const byEventId = new Map();
  let malformed = 0;
  for await (const line of readCompleteJsonLines(filePath, 0)) {
    if (line.oversized) {
      malformed += 1;
      continue;
    }
    if (line.text.trim().length === 0) {
      continue;
    }
    if (!/"type"\s*:\s*"assistant"/.test(line.text) || !/"usage"\s*:/.test(line.text)) {
      continue;
    }
    let record;
    try {
      record = JSON.parse(line.text);
    } catch {
      malformed += 1;
      continue;
    }
    const candidate = assistantSnapshot(record, { ...options, stableJournalIdentity }, line);
    if (!candidate) {
      continue;
    }
    byEventId.set(candidate.eventId, chooseClaudeSnapshot(byEventId.get(candidate.eventId), candidate));
  }
  const minimumObservedAtInclusive = typeof options.minimumObservedAtInclusive === "string"
    ? Date.parse(options.minimumObservedAtInclusive)
    : Number.NEGATIVE_INFINITY;
  const maximumObservedAtExclusive = typeof options.maximumObservedAtExclusive === "string"
    ? Date.parse(options.maximumObservedAtExclusive)
    : Number.POSITIVE_INFINITY;
  const events = [...byEventId.values()].filter((candidate) => {
    const observedAtMs = Date.parse(candidate.observedAt || "");
    return !Number.isFinite(observedAtMs)
      || (observedAtMs >= minimumObservedAtInclusive && observedAtMs < maximumObservedAtExclusive);
  }).map((candidate) => {
    const event = { ...candidate };
    delete event._lineOrder;
    return event;
  });
  return { events, malformed };
}
