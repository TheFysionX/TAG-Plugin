import { accountScopedEventId, hmacAlias, payloadHash } from "../crypto.mjs";
import { canonicalModelId, providerForModelId } from "../model-registry.mjs";
import { normalizeMode, normalizeTimestamp, normalizeUsage, readCompleteJsonLines, safeNonNegativeInteger } from "./shared.mjs";

// The Antigravity status-line protocol contains far more than TAG needs (for
// example e-mail address, cwd, workspace, and a raw conversation id).  This
// module is deliberately the one-way privacy boundary: callers may pass the
// complete status-line object in, but no disallowed field can leave it.
const CAPTURE_KIND = "tag.antigravity.statusline.v1";

function boundedString(value, maximum = 120) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maximum ? normalized : null;
}

function planTier(value) {
  const normalized = boundedString(value, 40)?.toLowerCase();
  return normalized && /^[a-z0-9][a-z0-9_-]*$/u.test(normalized) ? normalized : null;
}

function quotaResets(quota) {
  if (!quota || typeof quota !== "object" || Array.isArray(quota)) return [];
  const resets = [];
  for (const [key, bucket] of Object.entries(quota)) {
    const resetAt = normalizeTimestamp(bucket?.reset_time ?? bucket?.resetAt);
    if (!resetAt) continue;
    const label = boundedString(key, 40)?.toLowerCase();
    if (!label || !/^[a-z0-9][a-z0-9_-]*$/u.test(label)) continue;
    resets.push({ bucket: label, resetsAt: resetAt });
  }
  return resets.sort((a, b) => a.bucket.localeCompare(b.bucket)).slice(0, 8);
}

function allowlistedUsage(payload) {
  const usage = payload?.context_window?.current_usage ?? payload?.current_usage ?? payload?.usage;
  if (!usage || typeof usage !== "object") return null;
  const normalized = normalizeUsage({
    input_tokens: usage.input_tokens ?? usage.inputTokens,
    cache_read_input_tokens: usage.cache_read_input_tokens ?? usage.cacheReadTokens,
    cache_creation_input_tokens: usage.cache_creation_input_tokens ?? usage.cacheCreationTokens,
    output_tokens: usage.output_tokens ?? usage.outputTokens
  }, "antigravity");
  const total = normalized.input + normalized.cachedInput + normalized.cacheWriteInput + normalized.output;
  return total > 0 ? { ...normalized, total } : null;
}

/**
 * Produces the only record that the planned status-line wrapper is allowed to
 * append locally. `conversation_id` is converted to a local HMAC alias and is
 * never included in the returned record. The wrapper must compare
 * `snapshotFingerprint` and append only a changed completed-usage snapshot.
 */
export function sanitizeAntigravityStatusline(payload, options = {}) {
  if (!payload || typeof payload !== "object" || !options.localAliasKey) return null;
  const rawConversationId = boundedString(payload.conversation_id, 240);
  const sourceModelId = boundedString(payload?.model?.id ?? payload.model_id);
  const usage = allowlistedUsage(payload);
  if (!rawConversationId || !sourceModelId || !usage) return null;
  const observedAt = normalizeTimestamp(options.observedAt) || new Date(options.now ?? Date.now()).toISOString();
  const executionMode = planTier(payload.execution_mode);
  const record = {
    kind: CAPTURE_KIND,
    observedAt,
    sessionAlias: hmacAlias(options.localAliasKey, "antigravity-conversation", rawConversationId),
    sourceModelId,
    planTier: planTier(payload.plan_tier),
    executionMode,
    quotaResets: quotaResets(payload.quota),
    usage
  };
  return {
    ...record,
    // This fingerprint has no raw conversation identifier or message content.
    snapshotFingerprint: payloadHash({
      sessionAlias: record.sessionAlias,
      sourceModelId: record.sourceModelId,
      executionMode: record.executionMode,
      usage: record.usage
    })
  };
}

function capturedRecord(value) {
  if (!value || typeof value !== "object" || value.kind !== CAPTURE_KIND) return null;
  const observedAt = normalizeTimestamp(value.observedAt);
  const sessionAlias = boundedString(value.sessionAlias, 128);
  const sourceModelId = boundedString(value.sourceModelId);
  if (!observedAt || !sessionAlias || !/^[a-f0-9]{64}$/u.test(sessionAlias) || !sourceModelId) return null;
  const usage = value.usage;
  if (!usage || typeof usage !== "object") return null;
  const input = safeNonNegativeInteger(usage.input);
  const cachedInput = safeNonNegativeInteger(usage.cachedInput);
  const cacheWriteInput = safeNonNegativeInteger(usage.cacheWriteInput);
  const output = safeNonNegativeInteger(usage.output);
  if (input + cachedInput + cacheWriteInput + output <= 0) return null;
  return {
    observedAt,
    sessionAlias,
    sourceModelId,
    planTier: planTier(value.planTier),
    executionMode: planTier(value.executionMode),
    quotaResets: quotaResets(Object.fromEntries((Array.isArray(value.quotaResets) ? value.quotaResets : []).map((entry) => [entry?.bucket, { resetAt: entry?.resetsAt }]))),
    usage: { input, cachedInput, cacheWriteInput, output, reasoningOutput: 0, total: input + cachedInput + cacheWriteInput + output },
    snapshotFingerprint: boundedString(value.snapshotFingerprint, 128)
  };
}

export async function parseAntigravityStatuslineLog(filePath, options = {}) {
  const resolveModel = options.canonicalModelId || canonicalModelId;
  const events = [];
  const planObservations = [];
  const resetObservations = [];
  let malformed = 0;
  let captures = 0;
  const seen = new Set();
  try {
    for await (const line of readCompleteJsonLines(filePath)) {
      if (line.oversized || !line.text) {
        malformed += 1;
        continue;
      }
      let parsed;
      try { parsed = JSON.parse(line.text); } catch { malformed += 1; continue; }
      const record = capturedRecord(parsed);
      if (!record) { malformed += 1; continue; }
      captures += 1;
      const identity = record.snapshotFingerprint || payloadHash({
        sessionAlias: record.sessionAlias,
        observedAt: record.observedAt,
        sourceModelId: record.sourceModelId,
        usage: record.usage
      });
      if (seen.has(identity)) continue;
      seen.add(identity);
      const modelId = resolveModel("gemini", record.sourceModelId);
      const provider = providerForModelId(modelId) || "gemini";
      events.push({
        eventId: accountScopedEventId(options.dedupNamespaceKey, "gemini", `antigravity-statusline\0${identity}`),
        provider,
        serviceProviderId: "gemini",
        modelId,
        sourceModelId: record.sourceModelId,
        observedAt: record.observedAt,
        mode: normalizeMode({ provider: "gemini", speed: record.executionMode === "fast" ? "fast" : "standard" }),
        usage: record.usage,
        provenance: {
          collector: "antigravity_statusline_v1_prospective",
          verification: "connector_attested_prospective",
          surface: "antigravity"
        }
      });
      if (record.planTier) planObservations.push({ providerId: "gemini", serviceSurface: "antigravity", rawPlanCode: record.planTier, observedAt: record.observedAt, evidenceType: "antigravity_statusline" });
      for (const quota of record.quotaResets) resetObservations.push({ providerId: "gemini", serviceSurface: "antigravity", observedAt: record.observedAt, evidenceType: "antigravity_statusline_quota", windowKey: quota.bucket, resetAtAfter: quota.resetsAt });
    }
  } catch (error) {
    if (!['ENOENT', 'EACCES', 'EPERM'].includes(error?.code)) throw error;
    return { status: "unavailable", reason: error.code === "ENOENT" ? "not_installed" : "not_readable", events: [], planObservations: [], resetObservations: [], captures: 0, malformed: 0 };
  }
  return { status: captures > 0 ? "available_prospective" : "unavailable", reason: captures > 0 ? null : "no_sanitized_statusline_capture", events, planObservations, resetObservations, captures, malformed };
}

export { CAPTURE_KIND as ANTIGRAVITY_STATUSLINE_CAPTURE_KIND };
