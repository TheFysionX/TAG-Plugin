import { normalizeMode, normalizeModel, normalizeTimestamp, normalizeUsage, readCompleteJsonLines, totalForComparison } from "./shared.mjs";
import { accountScopedEventId } from "../crypto.mjs";
import { canonicalModelId } from "../model-registry.mjs";

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
  const speed = record.message.speed || record.speed || null;
  const sourceModelId = normalizeModel(record.message.model);
  return {
    eventId: accountScopedEventId(options.dedupNamespaceKey, "claude", messageId),
    provider: "claude",
    modelId: canonicalModelId("claude", sourceModelId),
    sourceModelId,
    observedAt: normalizeTimestamp(record.timestamp),
    mode: normalizeMode({ serviceTier, speed }),
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
    const candidate = assistantSnapshot(record, options, line);
    if (!candidate) {
      continue;
    }
    byEventId.set(candidate.eventId, chooseClaudeSnapshot(byEventId.get(candidate.eventId), candidate));
  }
  const events = [...byEventId.values()].map((candidate) => {
    const event = { ...candidate };
    delete event._lineOrder;
    return event;
  });
  return { events, malformed };
}
