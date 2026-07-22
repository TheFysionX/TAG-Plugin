import fs from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLAUDE_ACCOUNTING_VERSION,
  CODEX_ACCOUNTING_VERSION,
  CODEX_SNAPSHOT_STATE_VERSION,
  CONNECTOR_VERSION,
  GENESIS_HASH,
  HEARTBEAT_EVERY_INGEST_REQUESTS,
  HEARTBEAT_OBSERVATION_STATE_VERSION,
  HISTORY_SETTLE_MINUTES,
  INGEST_CHUNK_PACE_MS,
  JOURNAL_HISTORY_START,
  MAX_INGEST_CHECKPOINTS,
  MAX_INGEST_EVENTS,
  MAX_MIGRATION_EXCLUSIONS,
  MAX_RAW_PLAN_CODE_LENGTH,
  MAX_SYNC_OUTBOX_EVENTS,
  MAX_UNRESOLVED_EVENTS,
  RAW_PLAN_CODE_PATTERN,
  SCHEDULED_MAX_INGEST_REQUESTS
} from "./constants.mjs";
import { adapterStatus } from "./adapters/registry.mjs";
import { readClaudeAccountStatus } from "./adapters/claude-account-status.mjs";
import { readAntigravityPlanStatus } from "./adapters/antigravity-plan.mjs";
import { aggregatePreview, collectUsage, hasRawTokenUsage, toWireEvent } from "./collector.mjs";
import { createDeviceSecrets, hmacAlias, payloadHash, sha256 } from "./crypto.mjs";
import { discoverJsonlFiles } from "./discovery.mjs";
import { ConnectorError } from "./errors.mjs";
import { signedPost, validateEndpoint } from "./http.mjs";
import { withLock } from "./lock.mjs";
import { canonicalModelId } from "./model-registry.mjs";
import { providerRoots, runtimePaths } from "./paths.mjs";
import { safeLog } from "./safe-log.mjs";
import { applyScheduler, removeScheduler, schedulerPlan } from "./scheduler.mjs";
import { hardenWindowsConnectorHome, hardenWindowsSecrets } from "./windows-security.mjs";
import { installAntigravityStatusline, uninstallAntigravityStatusline } from "./antigravity-wrapper.mjs";
import {
  activateRelease,
  fetchAndInstallUpdate,
  installStableLauncher,
  readUpdateState,
  updateOfferDigest,
  validateUpdateOffer,
  writeUpdateState
} from "./update.mjs";
import {
  atomicWriteJson,
  cleanupStaleAtomicWriteTemps,
  ensureRuntimeDirectory,
  loadPendingSecrets,
  loadRuntime,
  loadSecrets,
  normalizeCodexCheckpointSnapshot,
  removePendingSecrets,
  saveRuntime,
  saveSecrets,
  savePendingSecrets
} from "./state.mjs";

const PLATFORM_IDS = new Set(["codex", "claude", "deepseek", "gemini", "grok", "kimi"]);
const MODEL_PROVIDER_IDS = new Set(["codex", "claude", "deepseek", "gemini", "grok", "kimi"]);
const SERVICE_PROVIDER_BY_SURFACE = Object.freeze({
  codex: "codex",
  claude_code: "claude",
  kimi_code: "kimi",
  antigravity: "gemini"
});
const UNRESOLVED_EVENT_KEYS = Object.freeze([
  "eventId",
  "occurredAt",
  "provider",
  "sourceModelId",
  "serviceMode",
  "inputTokens",
  "cachedInputTokens",
  "outputTokens",
  "reasoningTokens",
  "surface"
]);
const SOURCE_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,119}$/;
const TOKEN_COUNT_PATTERN = /^\d{1,30}$/;
const SYNC_BATCH_ID_PATTERN = /^[a-f0-9]{24}$/;
const MAX_SYNC_PAGE_BYTES = 64 * 1024 * 1024;
const SYNC_EVENT_KEYS = new Set([
  "eventId", "occurredAt", "provider", "serviceProviderId", "modelId", "serviceMode",
  "inputTokens", "cachedInputTokens", "cacheWriteInputTokens", "outputTokens", "reasoningTokens", "surface",
  "attribution"
]);
const SYNC_SURFACES = new Set(Object.keys(SERVICE_PROVIDER_BY_SURFACE));
const BISECTABLE_SYNC_CODES = new Set([
  "BODY_TOO_LARGE",
  "INVALID_EVENTS",
  "INVALID_CHECKPOINTS",
  "INVALID_EVENT",
  "INVALID_EVENT_ID",
  "INVALID_MODEL",
  "MODEL_NOT_SUPPORTED",
  "MODEL_PROVIDER_MISMATCH",
  "INVALID_SERVICE_MODE",
  "MODEL_MODE_NOT_SUPPORTED",
  "INVALID_SURFACE",
  "INVALID_TOKEN_COUNT",
  "INVALID_TIMESTAMP",
  "PRIVACY_FIELD_REJECTED",
  "PROVIDER_NOT_SUPPORTED",
  "INVALID_CHECKPOINT",
  "INVALID_CHECKPOINT_ID",
  "INVALID_CHECKPOINT_PERIOD",
  "CHECKPOINT_SOURCE_NOT_SUPPORTED",
  "MIXED_INGEST_NOT_ALLOWED"
]);

function isDedupNamespaceKey(value) {
  return typeof value === "string"
    && /^[A-Za-z0-9_-]{43}$/.test(value)
    && Buffer.from(value, "base64url").length === 32;
}

function serviceProviderForEvent(event) {
  const inferred = SERVICE_PROVIDER_BY_SURFACE[event?.surface ?? event?.provenance?.surface];
  if (!inferred) return null;
  return event?.serviceProviderId === undefined || event.serviceProviderId === inferred
    ? inferred
    : null;
}

function runtimeOptions(options = {}) {
  const paths = options.paths || runtimePaths({ home: options.home, env: options.env, platform: options.platform });
  const roots = options.roots || providerRoots(options.env);
  return { paths, roots };
}

function assertPaired(state, config, secrets) {
  if (state.pendingPair) {
    throw new ConnectorError(
      "PAIRING_IN_PROGRESS",
      "A pairing or device replacement is pending. Resume pair before syncing or installing."
    );
  }
  if (!state.paired || !state.deviceId || !config.endpoint || !secrets?.privateKeyPem) {
    throw new ConnectorError("NOT_PAIRED", "This connector is not paired. Run pair with a short-lived code first.");
  }
  if (!isDedupNamespaceKey(secrets.dedupNamespaceKey)) {
    throw new ConnectorError(
      "MISSING_DEDUP_NAMESPACE",
      "This pairing predates account-scoped deduplication. Re-pair the connector before syncing."
    );
  }
}

function safeScanSummary(stats) {
  return Object.fromEntries(Object.entries(stats).map(([provider, value]) => [provider, {
    status: value.status || (value.unavailable ? "unavailable" : "available"),
    coverage: value.coverage || "unknown",
    files: value.files || 0,
    events: value.events || 0,
    malformed: value.malformed || 0,
    parseLosses: value.parseLosses || 0,
    duplicateSnapshots: value.duplicateSnapshots || 0,
    cumulativeResets: value.cumulativeResets || 0,
    cumulativeMismatches: value.cumulativeMismatches || 0,
    inheritedSnapshots: value.inheritedSnapshots || 0,
    ambiguousLineage: value.ambiguousLineage || 0,
    unclassifiedModes: value.unclassifiedModes || 0,
    pending: Boolean(value.pending),
    truncated: Boolean(value.truncated),
    collector: value.collector || null
  }]));
}

function oversizedReleasedV1Outbox(state) {
  return state.syncOutbox
    && state.syncOutbox.version === 1
    && Number.isSafeInteger(state.syncOutbox.totalEvents)
    && state.syncOutbox.totalEvents > MAX_SYNC_OUTBOX_EVENTS;
}

function staleAggregateV3Outbox(state) {
  return state.syncOutbox?.version === 3;
}

function floorUtcHour(milliseconds) {
  return Math.floor(milliseconds / (60 * 60 * 1_000)) * 60 * 60 * 1_000;
}

function aggregateHistoryWindow(now) {
  const settledThroughMs = floorUtcHour(now - HISTORY_SETTLE_MINUTES * 60 * 1_000);
  return {
    windowStart: JOURNAL_HISTORY_START,
    settledThrough: new Date(settledThroughMs).toISOString()
  };
}

function aggregateHistoryRanges(now, state, enabledFallbacks) {
  const window = aggregateHistoryWindow(now);
  const windowStartMs = Date.parse(window.windowStart);
  const settledThroughMs = Date.parse(window.settledThrough);
  return Object.fromEntries(Object.entries(enabledFallbacks)
    .filter(([, enabled]) => enabled)
    .map(([provider]) => {
      const priorThroughMs = Date.parse(state?.cursors?.aggregate?.providers?.[provider]?.through || "");
      const committedThroughMs = Number.isFinite(priorThroughMs)
        ? Math.max(windowStartMs, priorThroughMs)
        : windowStartMs;
      const throughMs = Math.max(settledThroughMs, committedThroughMs);
      return [provider, {
        start: new Date(committedThroughMs).toISOString(),
        end: new Date(throughMs).toISOString(),
        windowStart: window.windowStart
      }];
    }));
}

function migrateOversizedReleasedV1Outbox(runtime, historyRange) {
  const outbox = runtime.state.syncOutbox;
  const existing = runtime.state.migrationExcludedEvents || [];
  const windowStartMs = Date.parse(historyRange.windowStart);
  const byEventId = new Map(
    existing
      .filter((event) => Date.parse(event.occurredAt) >= windowStartMs)
      .map((event) => [event.eventId, event])
  );
  // Public v0.1.1 version-1 outboxes contain raw account-scoped source IDs.
  // Preserve already accepted raw IDs as exclusions, then recollect only the
  // unprocessed sources into v3 aggregates. Version-2 draft aggregate outboxes
  // are deliberately not migrated and instead drain under their original IDs.
  for (const chunk of outbox.chunks.slice(0, outbox.index)) {
    for (const event of chunk.events || []) {
      if (typeof event.eventId !== "string"
        || !/^[a-f0-9]{64}$/.test(event.eventId)
        || typeof event.occurredAt !== "string"
        || Date.parse(event.occurredAt) < windowStartMs) {
        continue;
      }
      byEventId.set(event.eventId, {
        eventId: event.eventId,
        occurredAt: new Date(event.occurredAt).toISOString()
      });
      if (byEventId.size > MAX_MIGRATION_EXCLUSIONS) {
        throw new ConnectorError(
          "OVERSIZED_OUTBOX_MIGRATION_LIMIT",
          "The released v1 outbox has too many already-processed events to migrate safely."
        );
      }
    }
  }
  runtime.state.migrationExcludedEvents = [...byEventId.values()];
  runtime.state.syncOutbox = null;
}

function resetCodexAccountingGeneration(state) {
  state.cursors.codex = { accountingVersion: CODEX_ACCOUNTING_VERSION, files: {}, sessions: {} };
  if (state.cursors.aggregate?.providers?.codex) {
    state.cursors.aggregate.providers.codex.through = null;
  }
  delete state.providerEvidenceHashes.codex;
}

function resetClaudeAccountingGeneration(state) {
  state.cursors.claude = { accountingVersion: CLAUDE_ACCOUNTING_VERSION, seen: {} };
  if (state.cursors.aggregate?.providers?.claude) {
    state.cursors.aggregate.providers.claude.through = null;
  }
  delete state.providerEvidenceHashes.claude;
}

function resetCorrectedAccountingGenerations(state) {
  resetCodexAccountingGeneration(state);
  resetClaudeAccountingGeneration(state);
}

async function discardStaleAggregateV3Outbox(runtime, paths) {
  const outbox = runtime.state.syncOutbox;
  const migration = {
    batchId: SYNC_BATCH_ID_PATTERN.test(outbox?.batchId || "") ? outbox.batchId : null,
    remainingChunks: remainingSyncChunks(outbox),
    remainingEvents: Math.max(0, (outbox?.totalEvents || 0) - (outbox?.processedEvents || 0)),
    remainingCheckpoints: Math.max(0, (outbox?.totalCheckpoints || 0) - (outbox?.processedCheckpoints || 0))
  };
  // The request chain is independent from the local collection outbox. With no
  // pending request, removing only the stale v3 work preserves pairing,
  // sequence, prior digest, and committed Kimi cursors. Corrected Codex and
  // Claude generations are reset deliberately so completed v3 work is
  // recollected without allowing its cursors to suppress the v4 replay.
  runtime.state.syncOutbox = null;
  resetCorrectedAccountingGenerations(runtime.state);
  await saveRuntime(paths, runtime);
  if (migration.batchId) await cleanupSyncBatch(paths, migration.batchId);
  return migration;
}

function isNormalizedUnresolvedEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) return false;
  if (!Object.keys(event).every((key) => UNRESOLVED_EVENT_KEYS.includes(key))) return false;
  if (typeof event.eventId !== "string" || !/^[a-f0-9]{64}$/.test(event.eventId)) return false;
  if (typeof event.occurredAt !== "string"
    || event.occurredAt.length > 40
    || !Number.isFinite(Date.parse(event.occurredAt))) return false;
  if (!new Set(["codex", "claude", "kimi"]).has(event.provider)) return false;
  if (typeof event.sourceModelId !== "string" || !SOURCE_MODEL_PATTERN.test(event.sourceModelId)) return false;
  if (!["standard", "fast"].includes(event.serviceMode)) return false;
  if (!new Set(["codex", "claude_code", "kimi_code"]).has(event.surface)) return false;
  for (const key of ["inputTokens", "cachedInputTokens", "outputTokens"]) {
    if (typeof event[key] !== "string" || !TOKEN_COUNT_PATTERN.test(event[key])) return false;
  }
  return event.reasoningTokens === undefined
    || (typeof event.reasoningTokens === "string" && TOKEN_COUNT_PATTERN.test(event.reasoningTokens));
}

function legacyUnresolvedToRawOnlyWireEvent(event) {
  if (!isNormalizedUnresolvedEvent(event)) return null;
  const serviceProviderId = serviceProviderForEvent(event);
  if (!serviceProviderId) return null;
  const rawOnly = {
    eventId: event.eventId,
    occurredAt: event.occurredAt,
    provider: event.provider,
    serviceProviderId,
    attribution: "raw_only",
    modelId: "unknown",
    serviceMode: "unknown",
    inputTokens: event.inputTokens,
    cachedInputTokens: event.cachedInputTokens,
    // Retired queue records predate the canonical cache-write field. Their old
    // inputTokens value already contains cache creation, so zero preserves the
    // exact raw total without inventing an unrecoverable component split.
    cacheWriteInputTokens: "0",
    outputTokens: event.outputTokens,
    ...(event.reasoningTokens !== undefined ? { reasoningTokens: event.reasoningTokens } : {}),
    surface: event.surface
  };
  return hasRawTokenUsage(rawOnly) ? rawOnly : null;
}

function forceRawOnlyWireEvent(event) {
  return {
    ...event,
    attribution: "raw_only",
    modelId: "unknown",
    serviceMode: "unknown"
  };
}

export function boundedUnresolvedQueue(existing, additions, maximum = MAX_UNRESOLVED_EVENTS) {
  const limit = Number.isSafeInteger(maximum) && maximum >= 0
    ? Math.min(maximum, MAX_UNRESOLVED_EVENTS)
    : MAX_UNRESOLVED_EVENTS;
  const byEventId = new Map();
  for (const event of [...(existing || []), ...(additions || [])]) {
    if (!isNormalizedUnresolvedEvent(event)) continue;
    const allowlisted = Object.fromEntries(
      UNRESOLVED_EVENT_KEYS
        .filter((key) => event[key] !== undefined)
        .map((key) => [key, event[key]])
    );
    byEventId.set(event.eventId, allowlisted);
  }
  const all = [...byEventId.values()];
  return {
    events: all.slice(0, limit),
    dropped: Math.max(0, all.length - limit)
  };
}

function requestedFallbacks(value = {}) {
  return {
    codex: Boolean(value.codex),
    claude: Boolean(value.claude),
    kimi: Boolean(value.kimi),
    ...(Object.hasOwn(value, "gemini") ? { gemini: Boolean(value.gemini) } : {}),
    ...(Object.hasOwn(value, "grok") ? { grok: Boolean(value.grok) } : {}),
    // There is intentionally no DeepSeek journal root. This flag can enable
    // only separately proven host/API evidence.
    ...(Object.hasOwn(value, "deepseek") ? { deepseek: Boolean(value.deepseek) } : {})
  };
}

function allowedFallbacks(requested, allowedPlatforms) {
  const allowed = new Set(allowedPlatforms || []);
  return Object.fromEntries(Object.entries(requested).map(([provider, enabled]) => [
    provider,
    Boolean(enabled && allowed.has(provider))
  ]));
}

function consentedFallbacks(config, requested) {
  const fallbacks = requestedFallbacks(requested);
  if (config?.antigravityStatuslineConsent !== true) fallbacks.gemini = false;
  return fallbacks;
}

function stagedRawOnlyBackfill(state, providerScans, nextUnresolvedEvents, scannedAt) {
  const pending = new Set(state.rawOnlyBackfill?.pendingProviders || []);
  const hadPendingProviders = pending.size > 0;
  const partialCoverage = structuredClone(state.rawOnlyBackfill?.partialCoverage || {});
  for (const [provider, scan] of Object.entries(providerScans || {})) {
    const fullRetainedHistoryScan = scan?.range?.start === JOURNAL_HISTORY_START;
    if (scan?.progressComplete === true && Number(scan.parseLosses) > 0) {
      pending.add(provider);
      partialCoverage[provider] = {
        parseLosses: Math.max(
          Number(partialCoverage[provider]?.parseLosses) || 0,
          Number(scan.parseLosses) || 0
        ),
        lastObservedAt: scannedAt
      };
    } else if (fullRetainedHistoryScan && scan?.complete === true) {
      pending.delete(provider);
      delete partialCoverage[provider];
    }
  }
  for (const event of nextUnresolvedEvents) pending.add(event.provider);
  const pendingProviders = [...pending].sort();
  return {
    version: 1,
    pendingProviders,
    partialCoverage,
    completedAt: pendingProviders.length === 0 && Object.keys(partialCoverage).length === 0
      ? (state.rawOnlyBackfill?.completedAt || (hadPendingProviders ? scannedAt : null))
      : null
  };
}

function normalizePairCode(value) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toUpperCase().replace(/[-\s]/g, "");
  return /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/.test(normalized) ? normalized : null;
}

function checkpointPeriod(bucket) {
  const start = new Date(bucket.startDate + "T00:00:00.000Z");
  if (!Number.isFinite(start.getTime()) || start.toISOString().slice(0, 10) !== bucket.startDate) {
    return null;
  }
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1_000);
  return {
    usageDate: bucket.startDate,
    periodStart: start.toISOString(),
    periodEnd: end.toISOString(),
    totalTokens: String(bucket.tokens)
  };
}

function dailyCodexCheckpoint(period, generation) {
  const seed = {
    provider: "codex",
    source: "codex_app_server_account_usage",
    sourceScope: "codex_subscription_account",
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
    totalTokens: period.totalTokens,
    snapshotGenerationId: generation.generationId,
    parentGenerationId: generation.parentGenerationId,
    snapshotRole: "daily_delta"
  };
  return {
    checkpointId: sha256(JSON.stringify(seed)),
    ...seed
  };
}

function lifetimeCodexCheckpoint(codexEvidence, latestPeriod, generation, deltaCount) {
  const lifetimeTokens = codexEvidence?.summary?.lifetimeTokens;
  if (!Number.isSafeInteger(lifetimeTokens) || lifetimeTokens < 0 || !latestPeriod) {
    return null;
  }
  // The source names the cumulative semantics. The period is the observation
  // day (not the lifetime coverage span), keeping the wire contract's bounded
  // checkpoint-period invariant while allowing latest-observation selection.
  const seed = {
    provider: "codex",
    source: "codex_app_server_account_usage_lifetime",
    sourceScope: "codex_subscription_account",
    periodStart: latestPeriod.periodStart,
    periodEnd: latestPeriod.periodEnd,
    totalTokens: String(lifetimeTokens),
    snapshotGenerationId: generation.generationId,
    parentGenerationId: generation.parentGenerationId,
    snapshotRole: "commit",
    snapshotDigest: generation.snapshotDigest,
    deltaCount
  };
  return {
    checkpointId: sha256(JSON.stringify(seed)),
    ...seed
  };
}

function codexCheckpointPlan(providerEvidence, committedSnapshot) {
  if (providerEvidence?.codex?.status !== "available" || !Array.isArray(providerEvidence.codex.dailyUsageBuckets)) {
    return { checkpoints: [], nextSnapshot: null };
  }
  const observedPeriods = [...new Map(providerEvidence.codex.dailyUsageBuckets
    .map(checkpointPeriod)
    .filter(Boolean)
    .map((period) => [period.usageDate, period])).values()]
    .sort((left, right) => left.periodStart.localeCompare(right.periodStart));
  const lifetimeTokens = providerEvidence.codex.summary?.lifetimeTokens;
  if (observedPeriods.length === 0 || !Number.isSafeInteger(lifetimeTokens) || lifetimeTokens < 0) {
    return { checkpoints: [], nextSnapshot: null };
  }
  const previousDaily = committedSnapshot?.dailyValues || {};
  const dailyValues = {
    ...previousDaily,
    ...Object.fromEntries(observedPeriods.map((period) => [period.usageDate, period.totalTokens]))
  };
  const canonicalDailyValues = Object.fromEntries(
    Object.entries(dailyValues).sort(([left], [right]) => left.localeCompare(right))
  );
  const snapshotDigest = payloadHash({
    provider: "codex",
    sourceScope: "codex_subscription_account",
    lifetimeTokens: String(lifetimeTokens),
    dailyValues: canonicalDailyValues
  });
  if (committedSnapshot?.snapshotDigest === snapshotDigest) {
    return { checkpoints: [], nextSnapshot: null };
  }
  const parentGenerationId = committedSnapshot?.generationId || GENESIS_HASH;
  const generationId = sha256(parentGenerationId + "\0" + snapshotDigest);
  const generation = { generationId, parentGenerationId, snapshotDigest };
  const changedPeriods = observedPeriods
    .filter((period) => previousDaily[period.usageDate] !== period.totalTokens)
    .sort((left, right) => left.periodStart.localeCompare(right.periodStart));
  const dailyCheckpoints = changedPeriods.map((period) => dailyCodexCheckpoint(period, generation));
  const latestPeriod = [...observedPeriods]
    .sort((left, right) => right.periodStart.localeCompare(left.periodStart))[0];
  const lifetimeCheckpoint = lifetimeCodexCheckpoint(
    providerEvidence.codex,
    latestPeriod,
    generation,
    dailyCheckpoints.length
  );
  if (!lifetimeCheckpoint) return { checkpoints: [], nextSnapshot: null };
  return {
    // The final lifetime authority is the generation commit marker. Local
    // snapshot state is staged with the outbox and cannot commit before it.
    checkpoints: [...dailyCheckpoints, lifetimeCheckpoint],
    nextSnapshot: {
      version: CODEX_SNAPSHOT_STATE_VERSION,
      generationId,
      snapshotDigest,
      lifetimeTokens: String(lifetimeTokens),
      dailyValues: canonicalDailyValues
    }
  };
}

function acceptedRequestDigest(response) {
  const digest = response?.request?.digest;
  if (typeof digest !== "string" || digest.length < 16 || digest.length > 256) {
    throw new ConnectorError("INVALID_SERVER_RESPONSE", "The server did not return a valid request-chain digest.");
  }
  return digest;
}

function applyAcceptedRequest(state, response) {
  state.previousRequestDigest = acceptedRequestDigest(response);
  state.nextSequence += 1;
}

function remoteCodexCheckpointSnapshot(response, localSnapshot) {
  const providerSnapshots = response?.providerSnapshots;
  if (!providerSnapshots
    || typeof providerSnapshots !== "object"
    || Array.isArray(providerSnapshots)
    || !Object.hasOwn(providerSnapshots, "codex")) {
    throw new ConnectorError(
      "INVALID_SERVER_SNAPSHOT_STATUS",
      "The server did not return an authoritative Codex checkpoint snapshot status."
    );
  }
  if (providerSnapshots.codex === null) {
    return normalizeCodexCheckpointSnapshot(null);
  }
  const value = providerSnapshots.codex;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConnectorError(
      "INVALID_SERVER_SNAPSHOT_STATUS",
      "The server returned an invalid Codex checkpoint snapshot status."
    );
  }
  if (value.status === "current") {
    if (localSnapshot?.generationId === null
      || value.generationId !== localSnapshot?.generationId
      || value.snapshotDigest !== localSnapshot?.snapshotDigest) {
      throw new ConnectorError(
        "INVALID_SERVER_SNAPSHOT_STATUS",
        "The server returned a compact Codex snapshot acknowledgement that does not match local state."
      );
    }
    return localSnapshot;
  }
  if (value.status !== undefined && value.status !== "snapshot") {
    throw new ConnectorError(
      "INVALID_SERVER_SNAPSHOT_STATUS",
      "The server returned an unknown Codex checkpoint snapshot status."
    );
  }
  const normalized = normalizeCodexCheckpointSnapshot({
    version: CODEX_SNAPSHOT_STATE_VERSION,
    generationId: value.generationId,
    snapshotDigest: value.snapshotDigest,
    lifetimeTokens: value.lifetimeTokens,
    dailyValues: value.dailyValues
  });
  if (normalized.generationId === null) {
    throw new ConnectorError(
      "INVALID_SERVER_SNAPSHOT_STATUS",
      "The server returned a Codex checkpoint snapshot that failed integrity validation."
    );
  }
  return normalized;
}

function eventResponseFailure(chunk, response) {
  if (chunk.events.length === 0) return null;
  const results = new Map();
  for (const result of Array.isArray(response.events) ? response.events : []) {
    if (typeof result?.eventId !== "string") continue;
    const matches = results.get(result.eventId) || [];
    matches.push(result);
    results.set(result.eventId, matches);
  }
  let unacknowledged = 0;
  let rawOnlyUnpreserved = 0;
  for (const event of chunk.events) {
    const matches = results.get(event.eventId) || [];
    const result = matches.length === 1 ? matches[0] : null;
    // The backend must explicitly attest either that this submitted logical
    // event's exact revision is active, or that its exact observation is the
    // canonical content duplicate under another logical event. Status/count
    // fields alone never authorize a source-cursor commit.
    if (result?.submittedRevisionActive !== true
      && result?.submittedObservationCanonical !== true) {
      unacknowledged += 1;
    }
    if (event.attribution === "raw_only" && result?.rawPreserved !== true) {
      rawOnlyUnpreserved += 1;
    }
  }
  if (unacknowledged > 0) {
    return { code: "EVENT_ACKNOWLEDGEMENT_REJECTED", eventCount: unacknowledged };
  }
  if (rawOnlyUnpreserved > 0) {
    return { code: "RAW_ONLY_CONTRACT_REJECTED", eventCount: rawOnlyUnpreserved };
  }
  return null;
}

function checkpointResponseFailure(chunk, response) {
  if (chunk.checkpoints.length === 0) return null;
  const results = new Map();
  for (const result of Array.isArray(response.checkpoints) ? response.checkpoints : []) {
    if (typeof result?.checkpointId !== "string") continue;
    const matches = results.get(result.checkpointId) || [];
    matches.push(result);
    results.set(result.checkpointId, matches);
  }
  let unacknowledged = 0;
  let inactiveCommits = 0;
  let staleParentCommits = 0;
  for (const checkpoint of chunk.checkpoints) {
    const matches = results.get(checkpoint.checkpointId) || [];
    const result = matches.length === 1 ? matches[0] : null;
    // A 2xx response is only request-chain acceptance. Cursor/snapshot state
    // can advance solely after the backend proves the exact submitted
    // checkpoint digest is canonical. Duplicate response rows are ambiguous
    // and therefore fail closed just like a missing row.
    if (result?.submittedCheckpointCanonical !== true) {
      unacknowledged += 1;
      continue;
    }
    // Daily deltas are immutable staged evidence. A commit marker additionally
    // has to be the currently active generation after this request. An exact
    // but stale/superseded duplicate must never commit local generation state.
    if (checkpoint.snapshotRole === "commit"
      && result?.submittedGenerationActive !== true) {
      inactiveCommits += 1;
      if (result?.activationReason === "stale_parent") staleParentCommits += 1;
    }
  }
  if (unacknowledged > 0) {
    return { code: "CHECKPOINT_ACKNOWLEDGEMENT_REJECTED", itemCount: unacknowledged };
  }
  if (inactiveCommits > 0) {
    return {
      code: "CHECKPOINT_GENERATION_NOT_ACTIVE",
      itemCount: inactiveCommits,
      recoverableStaleParent: staleParentCommits === inactiveCommits
    };
  }
  return null;
}

function isWireEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) return false;
  if (!Object.keys(event).every((key) => SYNC_EVENT_KEYS.has(key))) return false;
  if (typeof event.eventId !== "string" || !/^[a-f0-9]{64}$/.test(event.eventId)) return false;
  if (typeof event.occurredAt !== "string" || !Number.isFinite(Date.parse(event.occurredAt))) return false;
  if (!MODEL_PROVIDER_IDS.has(event.provider)) return false;
  if (!serviceProviderForEvent(event)) return false;
  const rawOnly = event.attribution === "raw_only";
  if (event.attribution !== undefined && !rawOnly) return false;
  if (rawOnly) {
    if (event.modelId !== "unknown" || event.serviceMode !== "unknown") return false;
  } else {
    if (typeof event.modelId !== "string"
      || event.modelId.length < 1
      || event.modelId.length > 80
      || event.modelId === "unknown") return false;
    if (!['standard', 'fast'].includes(event.serviceMode)) return false;
  }
  if (!SYNC_SURFACES.has(event.surface)) return false;
  for (const key of ["inputTokens", "cachedInputTokens", "outputTokens"]) {
    if (typeof event[key] !== "string" || !TOKEN_COUNT_PATTERN.test(event[key])) return false;
  }
  if (event.cacheWriteInputTokens !== undefined
    && (typeof event.cacheWriteInputTokens !== "string"
      || !TOKEN_COUNT_PATTERN.test(event.cacheWriteInputTokens))) return false;
  return !Object.hasOwn(event, "reasoningTokens")
    || (typeof event.reasoningTokens === "string" && TOKEN_COUNT_PATTERN.test(event.reasoningTokens));
}

function syncPagePath(paths, batchId, pageIndex) {
  if (!SYNC_BATCH_ID_PATTERN.test(batchId) || !Number.isSafeInteger(pageIndex) || pageIndex < 1) {
    throw new ConnectorError("SYNC_BATCH_CORRUPT", "The local sync page reference is invalid.");
  }
  const root = path.resolve(paths.syncPages);
  const batchDirectory = path.resolve(root, batchId);
  if (path.dirname(batchDirectory) !== root) {
    throw new ConnectorError("SYNC_BATCH_CORRUPT", "The local sync page reference escaped its state directory.");
  }
  return path.join(batchDirectory, `${String(pageIndex).padStart(6, "0")}.json`);
}

async function readSyncPage(paths, outbox, pageIndex) {
  const manifest = outbox.pages?.[pageIndex];
  if (!manifest || manifest.pageIndex !== pageIndex) {
    throw new ConnectorError("SYNC_BATCH_CORRUPT", "The next local sync page is missing from the manifest.");
  }
  const filePath = syncPagePath(paths, outbox.batchId, pageIndex);
  let text;
  try {
    const stat = await fs.stat(filePath);
    if (stat.size > MAX_SYNC_PAGE_BYTES) {
      throw new ConnectorError("SYNC_BATCH_CORRUPT", "A local sync page exceeds the safe size limit.");
    }
    text = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error instanceof ConnectorError) throw error;
    throw new ConnectorError("SYNC_BATCH_CORRUPT", "A required local sync page is unavailable.");
  }
  let page;
  try {
    page = JSON.parse(text);
  } catch {
    throw new ConnectorError("SYNC_BATCH_CORRUPT", "A required local sync page is not valid JSON.");
  }
  if (page?.version !== 1
    || page.batchId !== outbox.batchId
    || page.pageIndex !== pageIndex
    || !Array.isArray(page.events)
    || page.events.length !== manifest.eventCount
    || page.events.length > outbox.pageSize
    || !page.events.every(isWireEvent)
    || payloadHash(page) !== manifest.digest) {
    throw new ConnectorError("SYNC_BATCH_CORRUPT", "A required local sync page failed integrity validation.");
  }
  return page;
}

async function cleanupSyncBatch(paths, batchId) {
  if (!SYNC_BATCH_ID_PATTERN.test(batchId)) return;
  const root = path.resolve(paths.syncPages);
  const target = path.resolve(root, batchId);
  if (path.dirname(target) !== root) return;
  await fs.rm(target, { recursive: true, force: true });
}

function syncPageSize(options) {
  return Number.isSafeInteger(options.maximumSyncPageEvents)
    && options.maximumSyncPageEvents > 0
    ? Math.min(options.maximumSyncPageEvents, MAX_SYNC_OUTBOX_EVENTS)
    : MAX_SYNC_OUTBOX_EVENTS;
}

function syncPagePayload(batchId, pageIndex, events) {
  return { version: 1, batchId, pageIndex, events };
}

function activePageEvents(outbox) {
  return Array.isArray(outbox.chunks)
    ? outbox.chunks.flatMap((chunk) => Array.isArray(chunk?.events) ? chunk.events : [])
    : [];
}

function isPagedSyncOutbox(outbox) {
  return outbox?.version === 3 || outbox?.version === 4;
}

function assertActiveSyncPage(outbox) {
  if (!isPagedSyncOutbox(outbox)) return;
  const manifest = outbox.pages?.[outbox.pageIndex];
  const events = activePageEvents(outbox);
  const page = syncPagePayload(outbox.batchId, outbox.pageIndex, events);
  const manifestEvents = Array.isArray(outbox.pages)
    ? outbox.pages.reduce((total, entry) => total + (entry?.eventCount || 0), 0)
    : -1;
  if (!SYNC_BATCH_ID_PATTERN.test(outbox.batchId)
    || !Number.isSafeInteger(outbox.pageIndex)
    || outbox.pageIndex < 0
    || !Number.isSafeInteger(outbox.pageCount)
    || !Array.isArray(outbox.pages)
    || outbox.pageCount !== outbox.pages?.length
    || outbox.pageCount < 1
    || outbox.pageIndex >= outbox.pageCount
    || !Number.isSafeInteger(outbox.pageSize)
    || outbox.pageSize < 1
    || outbox.pageSize > MAX_SYNC_OUTBOX_EVENTS
    || !Number.isSafeInteger(outbox.totalEvents)
    || outbox.totalEvents < 0
    || manifestEvents !== outbox.totalEvents
    || !outbox.pages.every((entry, index) => entry?.pageIndex === index
      && Number.isSafeInteger(entry.eventCount)
      && entry.eventCount >= 0
      && entry.eventCount <= outbox.pageSize
      && (index === outbox.pages.length - 1 || entry.eventCount === outbox.pageSize)
      && typeof entry.digest === "string"
      && /^[a-f0-9]{64}$/.test(entry.digest))
    || !Number.isSafeInteger(outbox.index)
    || outbox.index < 0
    || outbox.index > outbox.chunks.length
    || !Array.isArray(outbox.chunks)
    || !outbox.chunks.every((chunk) => Array.isArray(chunk.events)
      && Array.isArray(chunk.checkpoints)
      && chunk.events.every(isWireEvent))
    || !manifest
    || manifest.pageIndex !== outbox.pageIndex
    || manifest.eventCount !== events.length
    || events.length > outbox.pageSize
    || payloadHash(page) !== manifest.digest) {
    throw new ConnectorError("SYNC_BATCH_CORRUPT", "The active local sync page failed integrity validation.");
  }
}

function futureSyncChunks(outbox) {
  if (!isPagedSyncOutbox(outbox) || !Array.isArray(outbox.pages)) return 0;
  return outbox.pages
    .slice(outbox.pageIndex + 1)
    .reduce((total, page) => total + Math.ceil(page.eventCount / MAX_INGEST_EVENTS), 0);
}

function remainingSyncChunks(outbox) {
  if (!outbox) return 0;
  const active = Array.isArray(outbox.chunks) && Number.isSafeInteger(outbox.index)
    ? Math.max(0, outbox.chunks.length - outbox.index)
    : 0;
  return active + futureSyncChunks(outbox);
}

async function createPagedSyncOutbox(paths, events, checkpoints, commit, options) {
  const pageSize = syncPageSize(options);
  const batchId = randomBytes(12).toString("hex");
  const pageCount = Math.max(1, Math.ceil(events.length / pageSize));
  const pages = [];
  const pageEvents = [];
  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    const selected = events.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize);
    const page = syncPagePayload(batchId, pageIndex, selected);
    pages.push({
      pageIndex,
      eventCount: selected.length,
      digest: payloadHash(page)
    });
    pageEvents.push(selected);
  }
  // Future pages are durable before state.json can point at this batch. Page 0
  // remains embedded in state.json so an interrupted first request is replayable.
  try {
    for (let pageIndex = 1; pageIndex < pageCount; pageIndex += 1) {
      await atomicWriteJson(
        syncPagePath(paths, batchId, pageIndex),
        syncPagePayload(batchId, pageIndex, pageEvents[pageIndex]),
        0o600
      );
    }
  } catch (error) {
    await cleanupSyncBatch(paths, batchId);
    throw error;
  }
  const chunks = chunkSyncPayloads(pageEvents[0], checkpoints);
  return {
    version: 4,
    batchId,
    pageIndex: 0,
    pageCount,
    pageSize,
    pages,
    index: 0,
    chunks,
    totalChunks: pages.reduce(
      (total, page) => total + Math.ceil(page.eventCount / MAX_INGEST_EVENTS),
      Math.ceil(checkpoints.length / MAX_INGEST_CHECKPOINTS)
    ),
    totalEvents: events.length,
    totalCheckpoints: checkpoints.length,
    pageEventCount: pageEvents[0].length,
    processedEvents: 0,
    processedCheckpoints: 0,
    processedChunks: 0,
    accepted: 0,
    duplicates: 0,
    rejected: 0,
    quarantinedCount: 0,
    quarantinedEventIds: [],
    commit
  };
}

async function saveFinalizedRuntime(paths, runtime, cleanupBatchId) {
  await saveRuntime(paths, runtime);
  if (cleanupBatchId) {
    await cleanupSyncBatch(paths, cleanupBatchId);
  }
}

async function advanceCompletedOutbox(runtime, paths) {
  const outbox = runtime.state.syncOutbox;
  if (!outbox || outbox.index < outbox.chunks.length) return null;
  if (isPagedSyncOutbox(outbox) && outbox.pageIndex + 1 < outbox.pageCount) {
    const nextPageIndex = outbox.pageIndex + 1;
    const page = await readSyncPage(paths, outbox, nextPageIndex);
    outbox.pageIndex = nextPageIndex;
    outbox.index = 0;
    outbox.chunks = chunkSyncPayloads(page.events, []);
    outbox.pageEventCount = page.events.length;
    assertActiveSyncPage(outbox);
    return null;
  }
  const cleanupBatchId = isPagedSyncOutbox(outbox) ? outbox.batchId : null;
  runtime.state.cursors = outbox.commit.nextCursors;
  if (outbox.commit.codexCheckpointSnapshot) {
    runtime.state.codexCheckpointSnapshot = outbox.commit.codexCheckpointSnapshot;
    // Retire the v0.1.6 all-checkpoint hash only after the first coherent
    // generation commits. It cannot safely stand in for generation state.
    delete runtime.state.providerEvidenceHashes.codex;
  }
  runtime.state.unresolvedEvents = Array.isArray(outbox.commit.nextUnresolvedEvents)
    ? outbox.commit.nextUnresolvedEvents
    : runtime.state.unresolvedEvents;
  runtime.state.rawOnlyBackfill = outbox.commit.nextRawOnlyBackfill
    || runtime.state.rawOnlyBackfill;
  runtime.state.unresolvedOverflow = outbox.commit.unresolvedOverflow
    || runtime.state.unresolvedOverflow;
  runtime.state.lastSyncAt = outbox.commit.scannedAt;
  runtime.state.lastScan = {
    at: outbox.commit.scannedAt,
    adapters: outbox.commit.scanSummary,
    withheld: outbox.commit.withheld,
    rejected: outbox.rejected,
    quarantined: outbox.quarantinedCount || outbox.quarantinedEventIds.length,
    unknownModels: outbox.commit.unknownModels,
    unresolvedQueued: runtime.state.unresolvedEvents.length,
    unresolvedOverflow: runtime.state.unresolvedOverflow.totalDropped
  };
  runtime.state.quarantinedEventIds = [
    ...runtime.state.quarantinedEventIds,
    ...outbox.quarantinedEventIds
  ].slice(-2_000);
  runtime.state.syncOutbox = null;
  return cleanupBatchId;
}

async function finalizePending(runtime, response, paths) {
  const pending = runtime.state.pendingRequest;
  if (!pending) {
    throw new ConnectorError("MISSING_PENDING_REQUEST", "The local request journal is missing its pending request.");
  }
  if (pending.sequence !== runtime.state.nextSequence) {
    throw new ConnectorError("PENDING_SEQUENCE_MISMATCH", "The pending request does not match the local request sequence.");
  }
  if (pending.kind === "heartbeat" && !heartbeatObservationsAcknowledged(pending.body, response)) {
    throw new ConnectorError(
      "HEARTBEAT_OBSERVATION_UNACKNOWLEDGED",
      "The server did not acknowledge every submitted heartbeat observation; local observation state remains uncommitted.",
      { retryable: false }
    );
  }
  const hydratedCodexSnapshot = pending.kind === "heartbeat" && pending.commit?.hydrateCodexSnapshot === true
    ? remoteCodexCheckpointSnapshot(response, runtime.state.codexCheckpointSnapshot)
    : null;
  let syncOutbox = null;
  let activeChunk = null;
  let responseFailure = null;
  let staleParentSnapshot = null;
  if (pending.kind === "sync") {
    syncOutbox = runtime.state.syncOutbox;
    if (!syncOutbox || syncOutbox.index >= syncOutbox.chunks.length) {
      throw new ConnectorError("MISSING_SYNC_OUTBOX", "The pending sync request has no matching local outbox.");
    }
    activeChunk = syncOutbox.chunks[syncOutbox.index];
    responseFailure = eventResponseFailure(activeChunk, response)
      || checkpointResponseFailure(activeChunk, response);
    if (responseFailure?.recoverableStaleParent) {
      staleParentSnapshot = remoteCodexCheckpointSnapshot(response, runtime.state.codexCheckpointSnapshot);
      if (staleParentSnapshot.generationId === null) {
        throw new ConnectorError(
          "INVALID_SERVER_SNAPSHOT_STATUS",
          "A stale-parent response did not include the active Codex generation."
        );
      }
    }
  }
  applyAcceptedRequest(runtime.state, response);
  if (pending.kind === "sync") {
    const outbox = syncOutbox;
    const rejected = Number.isSafeInteger(response.rejected) ? response.rejected : 0;
    const rejectedIds = Array.isArray(response.events)
      ? response.events
          .filter((event) => !["accepted", "duplicate"].includes(event?.status))
          .map((event) => event?.eventId)
          .filter((eventId) => typeof eventId === "string" && /^[a-f0-9]{64}$/.test(eventId))
      : [];
    outbox.accepted += Number.isSafeInteger(response.accepted) ? response.accepted : 0;
    outbox.duplicates += Number.isSafeInteger(response.duplicates) ? response.duplicates : 0;
    outbox.rejected += rejected;
    if (responseFailure) {
      if (responseFailure.recoverableStaleParent) {
        // The backend accepted this signed request but another device won the
        // lineage race. Hydrate the winner and retire only this checkpoint
        // generation. The same durable outbox and page files continue draining
        // all already-collected events before their source cursors commit.
        // Account evidence is queried independently on the next sync, where a
        // fresh generation will extend this hydrated parent.
        outbox.generationRebased = true;
        outbox.commit.codexCheckpointSnapshot = null;
        runtime.state.codexCheckpointSnapshot = staleParentSnapshot;
        delete runtime.state.providerEvidenceHashes.codex;
        outbox.processedCheckpoints = (outbox.processedCheckpoints || 0) + activeChunk.checkpoints.length;
        outbox.processedChunks = (outbox.processedChunks || 0) + 1;
        outbox.index += 1;
        const cleanupBatchId = await advanceCompletedOutbox(runtime, paths);
        runtime.state.pendingRequest = null;
        return { pending, cleanupBatchId, blocked: false, generationRebased: true };
      }
      // The signed request sequence was accepted, but the backend did not prove
      // that every submitted observation is canonical. Preserve the entire
      // active chunk and all staged cursors rather than silently losing usage.
      outbox.permanentFailure = {
        code: responseFailure.code,
        status: null,
        ...(responseFailure.eventCount === undefined
          ? { itemCount: responseFailure.itemCount }
          : { eventCount: responseFailure.eventCount })
      };
      runtime.state.pendingRequest = null;
      return { pending, cleanupBatchId: null, blocked: true };
    }
    outbox.quarantinedEventIds = [...outbox.quarantinedEventIds, ...rejectedIds].slice(-2_000);
    outbox.quarantinedCount = (outbox.quarantinedCount || 0) + rejectedIds.length;
    outbox.processedEvents = (outbox.processedEvents || 0) + outbox.chunks[outbox.index].events.length;
    outbox.processedCheckpoints = (outbox.processedCheckpoints || 0) + outbox.chunks[outbox.index].checkpoints.length;
    outbox.processedChunks = (outbox.processedChunks || 0) + 1;
    outbox.index += 1;
    const cleanupBatchId = await advanceCompletedOutbox(runtime, paths);
    runtime.state.pendingRequest = null;
    return { pending, cleanupBatchId };
  } else if (pending.kind === "heartbeat") {
    runtime.state.lastHeartbeatAt = pending.commit.observedAt;
    if (pending.commit?.observationSnapshots) {
      runtime.state.heartbeatObservationSnapshots = pending.commit.observationSnapshots;
    }
    if (pending.commit?.hydrateCodexSnapshot === true) {
      runtime.state.codexCheckpointSnapshot = hydratedCodexSnapshot;
      if (hydratedCodexSnapshot.generationId !== null) {
        delete runtime.state.providerEvidenceHashes.codex;
      }
    }
  }
  runtime.state.pendingRequest = null;
  return { pending, cleanupBatchId: null };
}

const OBSERVATION_PROVIDER_SURFACES = Object.freeze({
  codex: new Set(["codex"]),
  claude: new Set(["claude_code"]),
  kimi: new Set(["kimi_code"]),
  gemini: new Set(["gemini_cli", "antigravity"]),
  grok: new Set(["grok", "grok_build"]),
  deepseek: new Set(["deepseek_api", "cli"])
});
const RESET_WINDOW_KEYS = new Set(["primary", "secondary", "session", "daily", "weekly", "api"]);
const RESET_BOUNDARY_GRACE_MS = 5 * 60 * 1_000;
// Provider percentages are rounded to two decimals. Require a 30-point fall
// before treating an unchanged reset window as a manual quota reset; this is
// intentionally far above refresh jitter or ordinary rounding noise.
const MANUAL_RESET_MIN_PERCENTAGE_POINT_DROP = 30;

function normalizedObservationTime(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function isObservationSurface(providerId, surface) {
  return OBSERVATION_PROVIDER_SURFACES[providerId]?.has(surface) === true;
}

function normalizePlanObservation(value) {
  const providerId = value?.providerId;
  const surface = value?.surface ?? value?.serviceSurface;
  const rawPlanCode = typeof value?.rawPlanCode === "string" ? value.rawPlanCode.trim().toLowerCase() : null;
  const observedAt = normalizedObservationTime(value?.observedAt);
  if (!isObservationSurface(providerId, surface)
    || !rawPlanCode || rawPlanCode.length > MAX_RAW_PLAN_CODE_LENGTH
    || !RAW_PLAN_CODE_PATTERN.test(rawPlanCode)
    || !observedAt) return null;
  return { providerId, surface, rawPlanCode, observedAt };
}

function normalizeResetCandidate(value) {
  const providerId = value?.providerId;
  const surface = value?.surface ?? value?.serviceSurface;
  const windowKey = value?.windowKey;
  const observedAt = normalizedObservationTime(value?.observedAt);
  const resetAt = normalizedObservationTime(value?.resetAt ?? value?.resetAtAfter);
  if (!isObservationSurface(providerId, surface) || !RESET_WINDOW_KEYS.has(windowKey)
    || !observedAt || !resetAt) return null;
  const usedPercent = typeof value?.usedPercent === "number"
    && Number.isFinite(value.usedPercent)
    && value.usedPercent >= 0
    && value.usedPercent <= 100
    ? value.usedPercent
    : null;
  return { providerId, surface, windowKey, observedAt, resetAt, usedPercent };
}

function observationProviderEnabled(runtime, providerId) {
  const allowed = new Set(runtime.config.allowedPlatforms || []);
  const supported = runtime.config.supportedProviders || [];
  return allowed.has(providerId) && (supported.length === 0 || supported.includes(providerId));
}

function deepseekUsageEvidencePresent(value) {
  if (value?.status !== "available" && value?.actualUsage !== true && value?.usageObserved !== true) return false;
  if (value?.actualUsage === true || value?.usageObserved === true) return true;
  if (Number.isFinite(value?.usage?.total) && value.usage.total > 0) return true;
  return false;
}

async function collectHeartbeatObservationInputs(runtime, secrets, roots, options) {
  if (options.observationCollection) return options.observationCollection;
  const enabledFallbacks = allowedFallbacks(
    consentedFallbacks(runtime.config, runtime.config.transcriptFallbacks),
    runtime.config.allowedPlatforms
  );
  return collectUsage({
    roots,
    state: runtime.state,
    secrets,
    now: options.now,
    officialEvidence: options.officialEvidence,
    readCodexAccountUsage: options.readCodexAccountUsage,
    codexAccountUsageOptions: options.codexAccountUsageOptions,
    enabledFallbacks,
    enabledProviders: {
      codex: observationProviderEnabled(runtime, "codex"),
      gemini: observationProviderEnabled(runtime, "gemini")
    },
    dedupNamespaceKey: secrets.dedupNamespaceKey,
    discoverJsonlFiles: options.discoverJsonlFiles,
    discoverGrokSignalFiles: options.discoverGrokSignalFiles
  });
}

async function heartbeatObservationPlan(runtime, secrets, roots, options) {
  const collection = await collectHeartbeatObservationInputs(runtime, secrets, roots, options);
  const candidates = [...(collection.providerObservations || [])].map(normalizePlanObservation).filter(Boolean);
  const resetCandidates = [...(collection.resetObservations || [])].map(normalizeResetCandidate).filter(Boolean);
  const codex = collection.providerEvidence?.codex;
  const observedAt = new Date(options.now ?? Date.now()).toISOString();
  const priorPlanSnapshots = runtime.state.heartbeatObservationSnapshots?.plans || {};
  if (observationProviderEnabled(runtime, "codex") && codex?.status === "available") {
    const planType = codex.account?.authSurface === "chatgpt" ? codex.account.planType : null;
    if (planType) candidates.push({ providerId: "codex", surface: "codex", rawPlanCode: planType, observedAt });
    for (const windowKey of ["primary", "secondary"]) {
      const window = codex.rateLimits?.[windowKey];
      // usedPercent is retained only in the local snapshot for reset detection;
      // it is never copied into the heartbeat wire payload.
      if (window?.resetAt) resetCandidates.push({
        providerId: "codex",
        surface: "codex",
        windowKey,
        observedAt,
        resetAt: window.resetAt,
        usedPercent: window.usedPercent
      });
    }
  }
  if (observationProviderEnabled(runtime, "claude")) {
    const readStatus = options.readClaudeAccountStatus || readClaudeAccountStatus;
    const claude = await readStatus({
      ...(options.claudeAccountStatusOptions || {}),
      includeLocalAccountIdentity: true
    });
    const priorClaude = priorPlanSnapshots["claude:claude_code"];
    const accountAlias = typeof claude?.organizationId === "string" && secrets.localAliasKey
      ? hmacAlias(secrets.localAliasKey, "claude-account", claude.organizationId)
      : null;
    // API-key/BYOK and non-first-party routes are intentionally incapable of
    // producing a subscription claim. Claude Code currently reports its
    // signed-in service as `firstParty`; older releases used `anthropic`.
    if (claude?.status === "available" && claude.loggedIn === true
      && claude.authMethod === "claude_ai"
      && (claude.apiProvider === "first_party" || claude.apiProvider === "anthropic")
      && claude.rawPlanCode) {
      candidates.push({
        providerId: "claude",
        surface: "claude_code",
        // Claude's public auth status can collapse Max 20x into the coarse word
        // `pro`. Only an account-bound exact code is durable enough to alter
        // the server entitlement; a temporary cache miss therefore cannot
        // demote a previously observed exact Max plan.
        rawPlanCode: claude.rawPlanCode,
        observedAt,
        ...(accountAlias ? { accountAlias } : {})
      });
    } else if (claude?.status === "available" && claude.loggedIn === false) {
      // A successful current auth-status response that says logged out is an
      // explicit revocation. Unknown closes the old plan without inventing a
      // replacement subscription.
      candidates.push({ providerId: "claude", surface: "claude_code", rawPlanCode: "unknown", observedAt });
    } else if (claude?.status === "available" && claude.loggedIn === true
      && (claude.authMethod === "api_key" || claude.apiProvider === "bedrock" || claude.apiProvider === "vertex")) {
      // A successful BYOK or third-party route is authoritative evidence that
      // this Claude Code session is not using a claude.ai subscription.
      candidates.push({ providerId: "claude", surface: "claude_code", rawPlanCode: "unknown", observedAt });
    } else if (priorClaude && accountAlias
      && priorClaude.accountAlias !== accountAlias) {
      // The current authenticated Claude organization changed but exact plan
      // evidence for the new account is not ready yet. A legacy snapshot with
      // no alias is deliberately treated as unbound. Revoke the old account's
      // entitlement immediately and retain only a local HMAC account alias.
      candidates.push({
        providerId: "claude",
        surface: "claude_code",
        rawPlanCode: "unknown",
        observedAt,
        accountAlias
      });
    }
  }
  if (observationProviderEnabled(runtime, "gemini")) {
    const readStatus = options.readAntigravityPlanStatus || readAntigravityPlanStatus;
    const antigravity = await readStatus({
      ...(options.antigravityPlanStatusOptions || {}),
      now: options.now
    });
    const planObservation = antigravity?.status === "available"
      ? antigravity.planObservation
      : null;
    if (planObservation?.providerId === "gemini"
      && (planObservation.serviceSurface === "antigravity" || planObservation.surface === "antigravity")
      && planObservation.rawPlanCode) {
      candidates.push({
        providerId: "gemini",
        surface: "antigravity",
        rawPlanCode: planObservation.rawPlanCode,
        observedAt
      });
    } else if (antigravity?.status === "signed_out") {
      // A current authenticated local response explicitly reporting logout
      // revokes any prior Antigravity quota-family claim. Ordinary process or
      // RPC unavailability still leaves the last valid observation untouched.
      candidates.push({ providerId: "gemini", surface: "antigravity", rawPlanCode: "unknown", observedAt });
    }
    // A missing/starting/stopped local server is deliberately not a logout.
    // The last successful provider-backed plan remains active until a later
    // authenticated status response supplies an exact plan or explicit
    // `unknown` code.
  }
  const deepseekEvidence = options.deepseekEvidence ?? collection.providerEvidence?.deepseek;
  if (observationProviderEnabled(runtime, "deepseek")
    && deepseekUsageEvidencePresent(deepseekEvidence)) {
    candidates.push({ providerId: "deepseek", surface: "deepseek_api", rawPlanCode: "api_payg", observedAt });
  }
  const snapshots = structuredClone(runtime.state.heartbeatObservationSnapshots || {
    version: HEARTBEAT_OBSERVATION_STATE_VERSION,
    plans: {},
    resetWindows: {}
  });
  snapshots.version = HEARTBEAT_OBSERVATION_STATE_VERSION;
  snapshots.plans ||= {};
  snapshots.resetWindows ||= {};
  const plansBySurface = new Map();
  for (const candidate of candidates) {
    if (observationProviderEnabled(runtime, candidate.providerId)) plansBySurface.set(`${candidate.providerId}:${candidate.surface}`, candidate);
  }
  const providerObservations = [];
  const changedPlans = [];
  for (const [key, candidate] of [...plansBySurface.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (snapshots.plans[key]?.rawPlanCode !== candidate.rawPlanCode
      || (candidate.accountAlias && snapshots.plans[key]?.accountAlias !== candidate.accountAlias)) {
      changedPlans.push([key, candidate]);
    }
  }
  for (const [key, candidate] of changedPlans.slice(0, 4)) {
    const { accountAlias: localAccountAlias, ...wireCandidate } = candidate;
    providerObservations.push(wireCandidate);
    snapshots.plans[key] = {
      rawPlanCode: candidate.rawPlanCode,
      ...(localAccountAlias ? { accountAlias: localAccountAlias } : {})
    };
  }
  const resetsByWindow = new Map();
  for (const candidate of resetCandidates) {
    if (observationProviderEnabled(runtime, candidate.providerId)) resetsByWindow.set(`${candidate.providerId}:${candidate.surface}:${candidate.windowKey}`, candidate);
  }
  const resetObservations = [];
  const actualResets = [];
  const baselineResetSnapshots = [];
  for (const [key, candidate] of [...resetsByWindow.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const prior = snapshots.resetWindows[key];
    const priorMs = Date.parse(prior?.resetAt || "");
    const nextMs = Date.parse(candidate.resetAt);
    const priorUsedPercent = typeof prior?.usedPercent === "number" && Number.isFinite(prior.usedPercent)
      ? prior.usedPercent
      : null;
    const sameWindowManualReset = Number.isFinite(priorMs)
      && nextMs === priorMs
      && nextMs > Date.parse(candidate.observedAt)
      && priorUsedPercent !== null
      && candidate.usedPercent !== null
      && priorUsedPercent - candidate.usedPercent >= MANUAL_RESET_MIN_PERCENTAGE_POINT_DROP;
    // A new future reset time means a scheduled quota window rolled only when
    // we have reached (or are close enough to) the previous boundary. A
    // same-window percentage drop is handled separately only at the strict
    // manual-reset threshold above.
    if (Number.isFinite(priorMs) && nextMs > priorMs
      && Date.parse(candidate.observedAt) >= priorMs - RESET_BOUNDARY_GRACE_MS) {
      // The event is the boundary that just elapsed, not the provider's next
      // future reset. Keep both so the server receives the causal boundary
      // while local detection advances to the next scheduled window.
      actualResets.push([key, { ...candidate, resetAt: prior.resetAt }, candidate.resetAt]);
    } else if (sameWindowManualReset) {
      // The provider still reports the same valid window boundary, but the
      // locally retained usage fell too far to be rounding noise. The current
      // observation time is the only defensible effective reset boundary.
      actualResets.push([key, { ...candidate, resetAt: candidate.observedAt }, candidate.resetAt]);
    } else {
      baselineResetSnapshots.push([key, candidate]);
    }
  }
  // A reset that did not fit in this heartbeat remains pending on the next
  // collection; never mark it sent merely because it exceeded the server cap.
  for (const [key, candidate, nextResetAt] of actualResets.slice(0, 4)) {
    resetObservations.push({
      providerId: candidate.providerId,
      surface: candidate.surface,
      windowKey: candidate.windowKey,
      observedAt: candidate.observedAt,
      resetAt: candidate.resetAt
    });
    snapshots.resetWindows[key] = {
      resetAt: nextResetAt,
      ...(candidate.usedPercent !== null ? { usedPercent: candidate.usedPercent } : {})
    };
  }
  for (const [key, candidate] of baselineResetSnapshots) {
    snapshots.resetWindows[key] = {
      resetAt: candidate.resetAt,
      ...(candidate.usedPercent !== null ? { usedPercent: candidate.usedPercent } : {})
    };
  }
  return {
    providerObservations,
    resetObservations,
    snapshots
  };
}

function heartbeatObservationsAcknowledged(body, response) {
  const expectedPlans = body.providerObservations || [];
  const expectedResets = body.resetObservations || [];
  if (expectedPlans.length === 0 && expectedResets.length === 0) return true;
  const plans = response?.observations?.plans;
  const resets = response?.observations?.resets;
  if (!Array.isArray(plans) || !Array.isArray(resets)) return false;
  const planKey = (item) => `${item?.providerId}:${item?.surface}:${item?.observedAt}`;
  const resetKey = (item) => `${item?.providerId}:${item?.surface}:${item?.windowKey}:${item?.observedAt}`;
  return expectedPlans.length === plans.length && expectedResets.length === resets.length
    && expectedPlans.every((item) => plans.some((ack) => planKey(ack) === planKey(item)))
    && expectedResets.every((item) => resets.some((ack) => resetKey(ack) === resetKey(item)));
}

async function replayPending(runtime, secrets, paths, options) {
  const pending = runtime.state.pendingRequest;
  if (!pending) {
    return null;
  }
  if (pending.body?.previousRequestDigest !== runtime.state.previousRequestDigest) {
    throw new ConnectorError("PENDING_CHAIN_MISMATCH", "The pending request does not match the local request chain.");
  }
  let response;
  try {
    response = await signedPost(runtime.config.endpoint + pending.route, pending.body, {
      deviceId: runtime.state.deviceId,
      sequence: pending.sequence,
      privateKeyPem: secrets.privateKeyPem
    }, { ...options, nonce: pending.requestId });
  } catch (error) {
    await markPendingPermanentFailure(runtime, paths, error);
    throw error;
  }
  let finalized;
  try {
    finalized = await finalizePending(runtime, response, paths);
  } catch (error) {
    await markPendingPermanentFailure(runtime, paths, error);
    throw error;
  }
  const committed = finalized.pending;
  await saveFinalizedRuntime(paths, runtime, finalized.cleanupBatchId);
  if (finalized.blocked) {
    const failureCode = runtime.state.syncOutbox?.permanentFailure?.code
      || "EVENT_ACKNOWLEDGEMENT_REJECTED";
    throw new ConnectorError(
      failureCode,
      "The server did not acknowledge every submitted usage revision; its source cursor remains uncommitted.",
      { retryable: false }
    );
  }
  await safeLog(paths.log, {
    action: committed.kind,
    status: "recovered",
    eventCount: committed.kind === "sync" ? committed.body.events.length : 0,
    sequence: committed.sequence
  });
  return { pending: committed, response };
}

function pendingRequest(kind, route, sequence, body, commit = null) {
  return {
    kind,
    route,
    sequence,
    requestId: randomBytes(18).toString("base64url"),
    body,
    commit
  };
}

function assertPendingCanReplay(runtime) {
  const failure = runtime.state.pendingRequest?.permanentFailure;
  if (!failure) return;
  throw new ConnectorError(
    "PENDING_PERMANENT_FAILURE",
    "A permanent server rejection is blocking this pending request.",
    { status: failure.status, retryable: false }
  );
}

function assertSyncOutboxCanProceed(outbox) {
  const failure = outbox?.permanentFailure;
  if (!failure) return;
  throw new ConnectorError(
    failure.code || "SYNC_OUTBOX_PERMANENT_FAILURE",
    "A permanent server rejection is blocking this sync outbox without committing its source cursors.",
    { status: failure.status, retryable: false }
  );
}

async function markPendingPermanentFailure(runtime, paths, error) {
  if (!(error instanceof ConnectorError) || error.retryable || !runtime.state.pendingRequest) return;
  runtime.state.pendingRequest.permanentFailure = {
    code: error.code,
    status: error.status
  };
  await saveRuntime(paths, runtime);
}

async function sendHeartbeatRequest(runtime, secrets, paths, options) {
  if (runtime.state.pendingRequest) {
    throw new ConnectorError(
      "PENDING_REQUEST_CONFLICT",
      "A request must finish before a new heartbeat can advance the signed request chain."
    );
  }
  const observedAt = new Date(options.now ?? Date.now()).toISOString();
  const sequence = runtime.state.nextSequence;
  const observationPlan = await heartbeatObservationPlan(
    runtime,
    secrets,
    options.roots || providerRoots(options.env),
    options
  );
  const stagedCommit = runtime.state.syncOutbox?.commit;
  const adapterHealth = Object.values(stagedCommit?.scanSummary || runtime.state.lastScan?.adapters || {});
  const effectiveBackfill = stagedCommit?.nextRawOnlyBackfill || runtime.state.rawOnlyBackfill;
  const degraded = adapterHealth.some((adapter) =>
    adapter.status === "unavailable"
    || adapter.status === "truncated"
    || (adapter.malformed || 0) > 0
    || (adapter.cumulativeMismatches || 0) > 0
    || (adapter.cumulativeResets || 0) > 0
  ) || runtime.state.unresolvedEvents.length > 0
    || runtime.state.unresolvedOverflow.totalDropped > 0
    || (effectiveBackfill?.pendingProviders?.length || 0) > 0
    || Boolean(runtime.state.syncOutbox?.permanentFailure);
  const body = {
    observedAt,
    status: runtime.state.paused ? "paused" : (degraded ? "degraded" : "healthy"),
    connectorVersion: CONNECTOR_VERSION,
    previousRequestDigest: runtime.state.previousRequestDigest,
    ...(observationPlan.providerObservations.length > 0
      ? { providerObservations: observationPlan.providerObservations }
      : {}),
    ...(observationPlan.resetObservations.length > 0
      ? { resetObservations: observationPlan.resetObservations }
      : {}),
    ...((options.hydrateCodexSnapshot === true
      || ((runtime.config.allowedPlatforms || []).includes("codex")
        && (runtime.config.supportedProviders || []).includes("codex")))
      ? {
          providerSnapshotHeads: {
            codex: runtime.state.codexCheckpointSnapshot.generationId === null
              ? null
              : {
                  generationId: runtime.state.codexCheckpointSnapshot.generationId,
                  snapshotDigest: runtime.state.codexCheckpointSnapshot.snapshotDigest
                }
          }
        }
      : {})
  };
  runtime.state.pendingRequest = pendingRequest(
    "heartbeat",
    "/api/connectors/v1/heartbeat",
    sequence,
    body,
    {
      observedAt,
      observationSnapshots: observationPlan.snapshots,
      ...(options.hydrateCodexSnapshot === true ? { hydrateCodexSnapshot: true } : {})
    }
  );
  await saveRuntime(paths, runtime);
  let response;
  try {
    response = await signedPost(runtime.config.endpoint + "/api/connectors/v1/heartbeat", body, {
      deviceId: runtime.state.deviceId,
      sequence,
      privateKeyPem: secrets.privateKeyPem
    }, { ...options, nonce: runtime.state.pendingRequest.requestId });
  } catch (error) {
    await markPendingPermanentFailure(runtime, paths, error);
    throw error;
  }
  try {
    await finalizePending(runtime, response, paths);
  } catch (error) {
    await markPendingPermanentFailure(runtime, paths, error);
    throw error;
  }
  await saveRuntime(paths, runtime);
  await safeLog(paths.log, { action: "heartbeat", status: "success", sequence });
  return {
    sent: true,
    sequence,
    nextExpectedAt: response?.heartbeat?.nextExpectedAt || null,
    continuityState: response?.device?.continuityState || null,
    updateOffer: response?.update || null,
    ...(options.hydrateCodexSnapshot === true
      ? { codexSnapshotHydrated: true }
      : {})
  };
}

export function chunkSyncPayloads(events, checkpoints) {
  const chunks = [];
  for (let index = 0; index < checkpoints.length; index += MAX_INGEST_CHECKPOINTS) {
    chunks.push({
      events: [],
      checkpoints: checkpoints.slice(index, index + MAX_INGEST_CHECKPOINTS)
    });
  }
  for (let index = 0; index < events.length; index += MAX_INGEST_EVENTS) {
    chunks.push({
      events: events.slice(index, index + MAX_INGEST_EVENTS),
      checkpoints: []
    });
  }
  return chunks;
}

function bisectChunk(chunk) {
  if (chunk.events.length > 0 && chunk.checkpoints.length > 0) {
    return [
      { events: chunk.events, checkpoints: [] },
      { events: [], checkpoints: chunk.checkpoints }
    ];
  }
  if (chunk.events.length > 1) {
    const middle = Math.ceil(chunk.events.length / 2);
    return [
      { events: chunk.events.slice(0, middle), checkpoints: [] },
      { events: chunk.events.slice(middle), checkpoints: chunk.checkpoints }
    ];
  }
  if (chunk.checkpoints.length > 1) {
    const middle = Math.ceil(chunk.checkpoints.length / 2);
    return [
      { events: chunk.events, checkpoints: chunk.checkpoints.slice(0, middle) },
      { events: [], checkpoints: chunk.checkpoints.slice(middle) }
    ];
  }
  return null;
}

async function paceNextIngestChunk(options) {
  const milliseconds = options.chunkPaceMs ?? INGEST_CHUNK_PACE_MS;
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return;
  const sleep = options.paceSleep
    || ((delay) => new Promise((resolve) => setTimeout(resolve, delay)));
  await sleep(milliseconds);
}

async function handlePermanentSyncError(runtime, paths, error) {
  const pending = runtime.state.pendingRequest;
  const outbox = runtime.state.syncOutbox;
  if (!pending || pending.kind !== "sync" || !outbox) return false;
  const bisectable = [400, 413, 422].includes(error.status)
    && BISECTABLE_SYNC_CODES.has(error.code);
  if (!bisectable) {
    pending.permanentFailure = { code: error.code, status: error.status };
    await saveRuntime(paths, runtime);
    return false;
  }
  const chunk = outbox.chunks[outbox.index];
  const split = bisectChunk(chunk);
  if (!split) {
    // An isolated item rejected before an exact backend acknowledgement cannot
    // be skipped. Advancing the cursor would turn a payload/contract defect
    // into silent data loss (including for attributed usage and checkpoints).
    pending.permanentFailure = {
      code: chunk.events.some((event) => event.attribution === "raw_only")
        ? "RAW_ONLY_CONTRACT_REJECTED"
        : "SYNC_ITEM_UNACKNOWLEDGED",
      status: error.status
    };
    await saveRuntime(paths, runtime);
    return false;
  }
  runtime.state.pendingRequest = null;
  outbox.chunks.splice(outbox.index, 1, ...split);
  outbox.totalChunks = (outbox.totalChunks || outbox.chunks.length - 1) + 1;
  await saveRuntime(paths, runtime);
  return true;
}

async function processSyncOutbox(runtime, secrets, paths, options) {
  const initial = runtime.state.syncOutbox;
  if (!initial) {
    return null;
  }
  assertActiveSyncPage(initial);
  assertSyncOutboxCanProceed(initial);
  if (!runtime.state.pendingRequest && initial.index >= initial.chunks.length) {
    const cleanupBatchId = await advanceCompletedOutbox(runtime, paths);
    await saveFinalizedRuntime(paths, runtime, cleanupBatchId);
    if (runtime.state.syncOutbox) assertActiveSyncPage(runtime.state.syncOutbox);
  }
  const initialProcessedEvents = initial.processedEvents || 0;
  const initialProcessedCheckpoints = initial.processedCheckpoints || 0;
  const initialProcessedChunks = initial.processedChunks || 0;
  const maxIngestRequests = Number.isSafeInteger(options.maxIngestRequests)
    && options.maxIngestRequests >= 0
    ? options.maxIngestRequests
    : Number.POSITIVE_INFINITY;
  const heartbeatEvery = Number.isSafeInteger(options.heartbeatEveryIngestRequests)
    && options.heartbeatEveryIngestRequests > 0
    ? options.heartbeatEveryIngestRequests
    : 0;
  let ingestRequests = 0;
  let ingestRequestsSinceHeartbeat = 0;
  let interleavedHeartbeats = 0;

  const afterIngestRequest = async () => {
    if (!runtime.state.syncOutbox || ingestRequests >= maxIngestRequests) return;
    await paceNextIngestChunk(options);
    if (heartbeatEvery > 0 && ingestRequestsSinceHeartbeat >= heartbeatEvery) {
      await sendHeartbeatRequest(runtime, secrets, paths, options);
      interleavedHeartbeats += 1;
      ingestRequestsSinceHeartbeat = 0;
      if (runtime.state.syncOutbox && ingestRequests < maxIngestRequests) {
        await paceNextIngestChunk(options);
      }
    }
  };

  while (runtime.state.syncOutbox && ingestRequests < maxIngestRequests) {
    assertSyncOutboxCanProceed(runtime.state.syncOutbox);
    if (runtime.state.pendingRequest) {
      if (runtime.state.pendingRequest.kind !== "sync") {
        throw new ConnectorError("PENDING_REQUEST_CONFLICT", "A non-sync request is pending before the sync outbox.");
      }
      assertPendingCanReplay(runtime);
      ingestRequests += 1;
      ingestRequestsSinceHeartbeat += 1;
      try {
        await replayPending(runtime, secrets, paths, options);
      } catch (error) {
        if (error instanceof ConnectorError && !error.retryable) {
          const handled = await handlePermanentSyncError(runtime, paths, error);
          if (handled) {
            await afterIngestRequest();
            continue;
          }
        }
        throw error;
      }
      await afterIngestRequest();
      continue;
    }
    const outbox = runtime.state.syncOutbox;
    assertActiveSyncPage(outbox);
    const chunk = outbox.chunks[outbox.index];
    if (!chunk) {
      throw new ConnectorError("SYNC_BATCH_CORRUPT", "The active local sync page has no matching request chunk.");
    }
    const sequence = runtime.state.nextSequence;
    const body = {
      events: chunk.events,
      ...(chunk.checkpoints.length > 0 ? { checkpoints: chunk.checkpoints } : {}),
      previousRequestDigest: runtime.state.previousRequestDigest
    };
    runtime.state.pendingRequest = pendingRequest(
      "sync",
      "/api/connectors/v1/ingest",
      sequence,
      body
    );
    await saveRuntime(paths, runtime);
    ingestRequests += 1;
    ingestRequestsSinceHeartbeat += 1;
    let response;
    try {
      response = await signedPost(runtime.config.endpoint + "/api/connectors/v1/ingest", body, {
        deviceId: runtime.state.deviceId,
        sequence,
        privateKeyPem: secrets.privateKeyPem
      }, { ...options, nonce: runtime.state.pendingRequest.requestId });
    } catch (error) {
      if (error instanceof ConnectorError && !error.retryable) {
        const handled = await handlePermanentSyncError(runtime, paths, error);
        if (handled) {
          await afterIngestRequest();
          continue;
        }
      }
      throw error;
    }
    let finalized;
    try {
      finalized = await finalizePending(runtime, response, paths);
    } catch (error) {
      await markPendingPermanentFailure(runtime, paths, error);
      throw error;
    }
    await saveFinalizedRuntime(paths, runtime, finalized.cleanupBatchId);
    if (finalized.blocked) {
      assertSyncOutboxCanProceed(runtime.state.syncOutbox);
    }
    await afterIngestRequest();
  }
  const sent = (initial.processedEvents || 0) - initialProcessedEvents;
  const checkpoints = (initial.processedCheckpoints || 0) - initialProcessedCheckpoints;
  const chunksProcessed = (initial.processedChunks || 0) - initialProcessedChunks;
  const generationRebased = initial.generationRebased === true;
  const catchingUp = generationRebased
    || Boolean(runtime.state.syncOutbox)
    || Boolean(initial.commit.collectionPending);
  await safeLog(paths.log, {
    action: "sync",
    status: catchingUp ? "catching_up" : (initial.rejected > 0 ? "partial" : "success"),
    eventCount: sent,
    sequence: runtime.state.nextSequence - 1
  });
  return {
    sent,
    checkpoints,
    withheld: initial.commit.withheld,
    accepted: initial.accepted,
    duplicates: initial.duplicates,
    rejected: initial.rejected,
    quarantined: initial.quarantinedCount || initial.quarantinedEventIds.length,
    chunks: initial.totalChunks || initial.chunks.length,
    unresolvedQueued: Array.isArray(initial.commit.nextUnresolvedEvents)
      ? initial.commit.nextUnresolvedEvents.length
      : runtime.state.unresolvedEvents.length,
    unresolvedOverflow: initial.commit.unresolvedOverflow?.totalDropped
      ?? runtime.state.unresolvedOverflow.totalDropped,
    chunksProcessed,
    ingestRequests,
    interleavedHeartbeats,
    generationRebased,
    catchingUp,
    remainingChunks: remainingSyncChunks(runtime.state.syncOutbox),
    nextSequence: runtime.state.nextSequence,
    adapters: initial.commit.scanSummary
  };
}

export async function preview(options = {}) {
  const { paths, roots } = runtimeOptions(options);
  const { state, config } = await loadRuntime(paths);
  const existingSecrets = await loadSecrets(paths);
  const secrets = existingSecrets || createDeviceSecrets();
  const enabledFallbacks = consentedFallbacks(
    config,
    options.enabledFallbacks || config.transcriptFallbacks
  );
  const collection = await collectUsage({
    roots,
    state,
    secrets,
    now: options.now,
    officialEvidence: options.officialEvidence,
    readCodexAccountUsage: options.readCodexAccountUsage,
    codexAccountUsageOptions: options.codexAccountUsageOptions,
    enabledFallbacks,
    enabledProviders: {
      codex: (config.allowedPlatforms || []).includes("codex"),
      gemini: (config.allowedPlatforms || []).includes("gemini")
    },
    dedupNamespaceKey: existingSecrets?.dedupNamespaceKey
      || Buffer.from(secrets.localAliasKey, "base64").toString("base64url")
  });
  return {
    ...aggregatePreview(collection),
    localReadSurfaces: [
      { provider: "codex", source: "codex app-server account/usage/read", contentFree: true, enabled: options.officialEvidence !== false },
      { provider: "codex", source: "~/.codex/sessions/**/*.jsonl", sensitiveJournal: true, enabled: enabledFallbacks.codex },
      { provider: "claude", source: "~/.claude/projects/**/*.jsonl", sensitiveJournal: true, enabled: enabledFallbacks.claude },
      { provider: "kimi", source: "~/.kimi-code/sessions/**/agents/*/wire.jsonl", sensitiveJournal: true, enabled: enabledFallbacks.kimi },
      { provider: "gemini", source: "Antigravity desktop 2.3.1 completed-step SQLite metadata", sensitiveJournal: false, enabled: (config.allowedPlatforms || []).includes("gemini") },
      { provider: "gemini", source: "Antigravity CLI sanitized statusLine fallback", sensitiveJournal: false, enabled: config.antigravityStatuslineConsent === true && enabledFallbacks.gemini === true },
      { provider: "grok", source: "Grok Build local session summary", sensitiveJournal: false, enabled: enabledFallbacks.grok === true }
    ],
    networkPerformed: false
  };
}

export async function pair(options = {}) {
  const { paths } = runtimeOptions(options);
  await ensureRuntimeDirectory(paths);
  return withLock(paths.lock, async (lease) => {
    await hardenWindowsConnectorHome(paths.home, options);
    await cleanupStaleAtomicWriteTemps(paths, { ownerToken: lease.ownerToken });
    const runtime = await loadRuntime(paths);
    if (runtime.state.pendingRequest || runtime.state.syncOutbox) {
      const explicitlyRepairingPermanentFailure = Boolean(
        options.replacePendingPair
        && runtime.state.pendingRequest?.permanentFailure
      );
      if (!explicitlyRepairingPermanentFailure) {
        throw new ConnectorError("PAIR_WHILE_SYNC_PENDING", "Finish or resolve the pending authenticated request before pairing again.");
      }
      // Cursors were never committed, so dropping this rejected outbox is lossless: it will be recollected after re-pair.
      const abandonedBatchId = isPagedSyncOutbox(runtime.state.syncOutbox)
        ? runtime.state.syncOutbox.batchId
        : null;
      runtime.state.pendingRequest = null;
      runtime.state.syncOutbox = null;
      await saveRuntime(paths, runtime);
      if (abandonedBatchId) await cleanupSyncBatch(paths, abandonedBatchId);
    }
    if (runtime.state.paired && !runtime.state.pendingPair && !options.replacePendingPair) {
      const configuredEndpoint = validateEndpoint(runtime.config.endpoint);
      if (options.endpoint && validateEndpoint(options.endpoint) !== configuredEndpoint) {
        throw new ConnectorError(
          "PAIR_ENDPOINT_MISMATCH",
          "This connector is already paired to a different The Artificial Games endpoint."
        );
      }
      const activeSecrets = await loadSecrets(paths);
      assertPaired(runtime.state, runtime.config, activeSecrets);
      await hardenWindowsSecrets(paths.secrets, options);
      const refreshCode = options.code === undefined ? null : normalizePairCode(options.code);
      if (options.code !== undefined && !refreshCode) {
        throw new ConnectorError("INVALID_PAIR_CODE", "Pairing requires the eight-character code shown by The Artificial Games.");
      }
      if (refreshCode) {
        const deviceLabel = typeof options.deviceLabel === "string" ? options.deviceLabel.trim() : "TAG Plugin";
        if (!/^[A-Za-z0-9 ._-]{1,40}$/.test(deviceLabel)) {
          throw new ConnectorError("INVALID_DEVICE_LABEL", "The device label must be 1-40 simple characters.");
        }
        const response = await signedPost(configuredEndpoint + "/api/connectors/v1/exchange", {
          code: refreshCode,
          publicKey: activeSecrets.publicKeyRawBase64Url,
          deviceLabel,
          connectorVersion: CONNECTOR_VERSION
        }, {
          deviceId: "",
          sequence: 0,
          privateKeyPem: activeSecrets.privateKeyPem
        }, { ...options, nonce: randomBytes(18).toString("base64url") });
        const refreshedDeviceId = response?.device?.id;
        if (refreshedDeviceId !== runtime.state.deviceId) {
          throw new ConnectorError(
            "PAIR_DEVICE_CHANGED",
            "The authorization refresh did not return the currently paired device."
          );
        }
        const allowedPlatforms = (response.allowedPlatforms || response.device?.allowedPlatforms || [])
          .filter((platform) => PLATFORM_IDS.has(platform));
        const supportedProviders = (response.supportedProviders || response.device?.supportedProviders || [])
          .filter((provider) => PLATFORM_IDS.has(provider));
        if (allowedPlatforms.length === 0 || supportedProviders.length === 0) {
          throw new ConnectorError("INVALID_SERVER_RESPONSE", "The authorization refresh returned no supported platforms.");
        }
        if (response.dedupNamespaceKey !== activeSecrets.dedupNamespaceKey) {
          throw new ConnectorError(
            "ACCOUNT_NAMESPACE_CHANGED",
            "The account deduplication namespace changed during authorization refresh."
          );
        }
        if (response?.signing?.nextSequence !== runtime.state.nextSequence
          || response?.signing?.lastRequestDigest !== runtime.state.previousRequestDigest) {
          throw new ConnectorError(
            "REQUEST_CHAIN_DIVERGED",
            "The server and local request chain differ; authorization was not applied locally."
          );
        }
        runtime.config.allowedPlatforms = allowedPlatforms;
        runtime.config.supportedProviders = supportedProviders;
        if (options.antigravityStatuslineConsent !== undefined) {
          runtime.config.antigravityStatuslineConsent = options.antigravityStatuslineConsent === true
            && allowedPlatforms.includes("gemini");
        }
        runtime.config.transcriptFallbacks = allowedFallbacks(
          requestedFallbacks(options.enabledFallbacks ?? runtime.config.transcriptFallbacks),
          allowedPlatforms
        );
        await saveRuntime(paths, runtime);
        await safeLog(paths.log, { action: "pair", status: "authorization_refreshed" });
        return {
          paired: true,
          alreadyPaired: true,
          authorizationRefreshed: true,
          deviceId: runtime.state.deviceId,
          allowedPlatforms,
          supportedProviders,
          transcriptFallbacks: runtime.config.transcriptFallbacks,
          antigravityStatuslineConsent: runtime.config.antigravityStatuslineConsent
        };
      }
      if (options.enabledFallbacks !== undefined) {
        runtime.config.transcriptFallbacks = allowedFallbacks(
          requestedFallbacks(options.enabledFallbacks),
          runtime.config.allowedPlatforms
        );
        await saveRuntime(paths, runtime);
      }
      if (options.antigravityStatuslineConsent !== undefined) {
        runtime.config.antigravityStatuslineConsent = options.antigravityStatuslineConsent === true
          && runtime.config.allowedPlatforms.includes("gemini");
        await saveRuntime(paths, runtime);
      }
      return {
        paired: true,
        alreadyPaired: true,
        deviceId: runtime.state.deviceId,
        allowedPlatforms: runtime.config.allowedPlatforms,
        supportedProviders: runtime.config.supportedProviders,
        transcriptFallbacks: runtime.config.transcriptFallbacks,
        antigravityStatuslineConsent: runtime.config.antigravityStatuslineConsent
      };
    }
    let secrets = await loadPendingSecrets(paths);
    let pendingState = runtime.state.pendingPair;
    if (pendingState?.permanentFailure && !options.replacePendingPair) {
      throw new ConnectorError(
        "PAIR_PERMANENTLY_REJECTED",
        "The pending pairing was permanently rejected. Use a fresh code with --replace-pending-pair.",
        { status: pendingState.permanentFailure.status, retryable: false }
      );
    }
    if (options.replacePendingPair) {
      pendingState = null;
      secrets = null;
      runtime.state.pendingPair = null;
      await removePendingSecrets(paths);
    }
    let pending = pendingState && secrets?.pairingRequest
      ? secrets.pairingRequest
      : null;
    let createdPendingSecrets = false;
    if (!pendingState) {
      const code = normalizePairCode(options.code);
      if (!code) {
        throw new ConnectorError("INVALID_PAIR_CODE", "Pairing requires the eight-character code shown by The Artificial Games.");
      }
      if (!options.endpoint) {
        throw new ConnectorError("MISSING_ENDPOINT", "Pairing requires the HTTPS endpoint for The Artificial Games.");
      }
      const endpoint = validateEndpoint(options.endpoint);
      const deviceLabel = typeof options.deviceLabel === "string" ? options.deviceLabel.trim() : "TAG Plugin";
      if (!/^[A-Za-z0-9 ._-]{1,40}$/.test(deviceLabel)) {
        throw new ConnectorError("INVALID_DEVICE_LABEL", "The device label must be 1-40 simple characters.");
      }
      secrets = createDeviceSecrets();
      pending = {
        endpoint,
        requestId: randomBytes(18).toString("base64url"),
        body: {
          code,
          publicKey: secrets.publicKeyRawBase64Url,
          deviceLabel,
          connectorVersion: CONNECTOR_VERSION
        },
        approvedFallbacks: requestedFallbacks(options.enabledFallbacks),
        antigravityStatuslineConsent: options.antigravityStatuslineConsent === true
      };
      secrets.pairingRequest = pending;
      runtime.state.pendingPair = {
        requestId: pending.requestId,
        permanentFailure: null
      };
      await savePendingSecrets(paths, secrets);
      createdPendingSecrets = true;
    } else {
      if (!pending
        || pendingState.requestId !== pending.requestId
        || !secrets?.privateKeyPem
        || pending.body?.publicKey !== secrets.publicKeyRawBase64Url) {
        throw new ConnectorError("PAIR_KEY_MISMATCH", "The persisted pairing request no longer matches the local device key.");
      }
      if (options.endpoint && validateEndpoint(options.endpoint) !== pending.endpoint) {
        throw new ConnectorError("PAIR_RESUME_MISMATCH", "The supplied endpoint differs from the pending pairing request.");
      }
      if (options.code && normalizePairCode(options.code) !== pending.body.code) {
        throw new ConnectorError("PAIR_RESUME_MISMATCH", "The supplied code differs from the pending pairing request.");
      }
    }
    try {
      await hardenWindowsSecrets(paths.pendingSecrets, options);
    } catch (error) {
      if (createdPendingSecrets) {
        runtime.state.pendingPair = null;
        await removePendingSecrets(paths);
      }
      throw error;
    }
    if (createdPendingSecrets) {
      await saveRuntime(paths, runtime);
    }
    let response;
    try {
      response = await signedPost(pending.endpoint + "/api/connectors/v1/exchange", pending.body, {
        deviceId: "",
        sequence: 0,
        privateKeyPem: secrets.privateKeyPem
      }, { ...options, nonce: pending.requestId });
    } catch (error) {
      if (error instanceof ConnectorError && !error.retryable) {
        runtime.state.pendingPair.permanentFailure = {
          code: error.code,
          status: error.status
        };
        await saveRuntime(paths, runtime);
      }
      throw error;
    }
    const deviceId = response?.device?.id;
    if (typeof deviceId !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(deviceId)) {
      throw new ConnectorError("INVALID_SERVER_RESPONSE", "The pairing response did not contain a valid device identifier.");
    }
    const allowedPlatforms = (response.allowedPlatforms || response.device?.allowedPlatforms || [])
      .filter((platform) => PLATFORM_IDS.has(platform));
    const supportedProviders = (response.supportedProviders || response.device?.supportedProviders || [])
      .filter((provider) => PLATFORM_IDS.has(provider));
    const dedupNamespaceKey = response.dedupNamespaceKey;
    if (!isDedupNamespaceKey(dedupNamespaceKey)) {
      runtime.state.pendingPair.permanentFailure = {
        code: "MISSING_DEDUP_NAMESPACE",
        status: null
      };
      await saveRuntime(paths, runtime);
      throw new ConnectorError(
        "MISSING_DEDUP_NAMESPACE",
        "The pairing response is missing the required 32-byte account dedup namespace key."
      );
    }
    runtime.state.paired = true;
    runtime.state.deviceId = deviceId;
    runtime.state.nextSequence = Number.isSafeInteger(response?.signing?.nextSequence) && response.signing.nextSequence >= 1
      ? response.signing.nextSequence
      : 1;
    runtime.state.previousRequestDigest = typeof response?.signing?.lastRequestDigest === "string"
      ? response.signing.lastRequestDigest
      : "";
    runtime.state.pendingPair = null;
    runtime.config.endpoint = pending.endpoint;
    runtime.config.allowedPlatforms = allowedPlatforms;
    runtime.config.supportedProviders = supportedProviders;
    runtime.config.antigravityStatuslineConsent = pending.antigravityStatuslineConsent === true
      && allowedPlatforms.includes("gemini");
    const pendingRecoverySecrets = { ...secrets, dedupNamespaceKey };
    const activeSecrets = { ...pendingRecoverySecrets };
    delete activeSecrets.pairingRequest;
    delete runtime.config.dedupNamespaceKey;
    runtime.config.transcriptFallbacks = allowedFallbacks(
      requestedFallbacks(pending.approvedFallbacks),
      allowedPlatforms
    );
    await savePendingSecrets(paths, pendingRecoverySecrets);
    await hardenWindowsSecrets(paths.pendingSecrets, options);
    await saveSecrets(paths, activeSecrets);
    try {
      await hardenWindowsSecrets(paths.secrets, options);
    } catch (error) {
      // The hardened pending copy remains the crash-recovery source; never leave an unverified final copy.
      await fs.rm(paths.secrets, { force: true });
      throw error;
    }
    const writeRuntimeFile = options.atomicWriteJson || atomicWriteJson;
    // Config commits first and state (which clears pendingPair) commits last. If either
    // write fails, the hardened pending request can replay the idempotent exchange.
    await writeRuntimeFile(paths.config, runtime.config);
    await writeRuntimeFile(paths.state, runtime.state);
    await removePendingSecrets(paths);
    await safeLog(paths.log, { action: "pair", status: "success" });
    return {
      paired: true,
      deviceId,
      allowedPlatforms,
      supportedProviders,
      transcriptFallbacks: runtime.config.transcriptFallbacks,
      antigravityStatuslineConsent: runtime.config.antigravityStatuslineConsent
    };
  });
}

export async function sync(options = {}) {
  const { paths, roots } = runtimeOptions(options);
  await ensureRuntimeDirectory(paths);
  return withLock(paths.lock, async (lease) => {
    await cleanupStaleAtomicWriteTemps(paths, { ownerToken: lease.ownerToken });
    const runtime = await loadRuntime(paths);
    const secrets = await loadSecrets(paths);
    assertPaired(runtime.state, runtime.config, secrets);
    const aggregateHistory = options.aggregateHistory === true;
    const historyWindow = aggregateHistory
      ? aggregateHistoryWindow(options.now ?? Date.now())
      : null;
    if (runtime.state.pendingRequest?.kind === "heartbeat") {
      assertPendingCanReplay(runtime);
      await replayPending(runtime, secrets, paths, options);
    }
    if (runtime.state.pendingRequest?.kind === "sync" && !runtime.state.syncOutbox) {
      throw new ConnectorError("MISSING_SYNC_OUTBOX", "A pending sync request has no matching local outbox.");
    }
    if (staleAggregateV3Outbox(runtime.state) && runtime.state.pendingRequest?.kind === "sync") {
      const recovered = await processSyncOutbox(runtime, secrets, paths, {
        ...options,
        roots,
        maxIngestRequests: 1
      });
      let discarded = null;
      if (!runtime.state.pendingRequest && staleAggregateV3Outbox(runtime.state)) {
        discarded = await discardStaleAggregateV3Outbox(runtime, paths);
      } else if (!runtime.state.pendingRequest && !runtime.state.syncOutbox) {
        // The exact pending request was the final v3 chunk and finalized its old
        // commit. Force both corrected generations to rescan on the next run;
        // the legacy commit may otherwise restore pre-v4 Claude cursors.
        resetCorrectedAccountingGenerations(runtime.state);
        await saveRuntime(paths, runtime);
      }
      await safeLog(paths.log, {
        action: "sync",
        status: "replayed_pending_then_retired_v3_outbox",
        eventCount: discarded?.remainingEvents || 0,
        sequence: runtime.state.nextSequence
      });
      return {
        recovered: true,
        retiredStaleV3: true,
        ...recovered,
        remainingChunks: remainingSyncChunks(runtime.state.syncOutbox),
        nextSequence: runtime.state.nextSequence
      };
    }
    if (staleAggregateV3Outbox(runtime.state) && !runtime.state.pendingRequest) {
      const discarded = await discardStaleAggregateV3Outbox(runtime, paths);
      await safeLog(paths.log, {
        action: "sync",
        status: "discarded_stale_v3_outbox",
        eventCount: discarded.remainingEvents,
        sequence: runtime.state.nextSequence
      });
    }
    if (aggregateHistory && oversizedReleasedV1Outbox(runtime.state) && !runtime.state.pendingRequest) {
      const abandonedEvents = runtime.state.syncOutbox.totalEvents;
      migrateOversizedReleasedV1Outbox(runtime, historyWindow);
      await saveRuntime(paths, runtime);
      await safeLog(paths.log, {
        action: "sync",
        status: "requeued_released_v1_outbox",
        eventCount: abandonedEvents,
        sequence: runtime.state.nextSequence
      });
    }
    if (runtime.state.syncOutbox) {
      return {
        recovered: true,
        ...await processSyncOutbox(runtime, secrets, paths, { ...options, roots })
      };
    }
    if (runtime.state.paused) {
      return { skipped: true, reason: "paused" };
    }
    const configuredFallbacks = allowedFallbacks(
      consentedFallbacks(runtime.config, runtime.config.transcriptFallbacks),
      runtime.config.allowedPlatforms
    );
    const allowedProviderSet = new Set(runtime.config.allowedPlatforms || []);
    const supportedProviderSet = new Set(runtime.config.supportedProviders || []);
    const resolveModel = options.canonicalModelId || canonicalModelId;
    const enabledFallbacks = Object.fromEntries(
      Object.entries(configuredFallbacks).map(([provider, enabled]) => [
        provider,
        Boolean(enabled && supportedProviderSet.has(provider))
      ])
    );
    const historyRanges = aggregateHistory
      ? aggregateHistoryRanges(options.now ?? Date.now(), runtime.state, enabledFallbacks)
      : null;
    const collection = await collectUsage({
      roots,
      state: runtime.state,
      secrets,
      now: options.now,
      officialEvidence: options.officialEvidence,
      readCodexAccountUsage: options.readCodexAccountUsage,
      codexAccountUsageOptions: options.codexAccountUsageOptions,
      canonicalModelId: resolveModel,
      enabledFallbacks,
      enabledProviders: {
        codex: allowedProviderSet.has("codex"),
        gemini: allowedProviderSet.has("gemini")
      },
      dedupNamespaceKey: secrets.dedupNamespaceKey,
      maximumEventsPerProvider: options.maximumEventsPerProvider,
      aggregateRanges: historyRanges,
      discoverJsonlFiles: options.discoverJsonlFiles,
      excludedEventIds: runtime.state.migrationExcludedEvents.map((event) => event.eventId)
    });
    // Reset evidence changes how the server evaluates subsequent immutable
    // usage. When a fresh observation exists, its signed heartbeat must land
    // before we construct or drain this newly collected outbox. Existing
    // outboxes are handled above and deliberately retain their original order.
    const pendingObservationPlan = await heartbeatObservationPlan(runtime, secrets, roots, {
      ...options,
      roots,
      observationCollection: collection
    });
    if (pendingObservationPlan.providerObservations.length > 0
      || pendingObservationPlan.resetObservations.length > 0
      || JSON.stringify(pendingObservationPlan.snapshots) !== JSON.stringify(runtime.state.heartbeatObservationSnapshots)) {
      await sendHeartbeatRequest(runtime, secrets, paths, {
        ...options,
        roots,
        observationCollection: collection
      });
    }
    if (historyRanges) {
      for (const [provider, range] of Object.entries(historyRanges)) {
        if (collection.providerScans?.[provider]?.progressComplete) {
          collection.nextCursors.aggregate.providers[provider].through = range.end;
        }
      }
    }
    const scannedAt = new Date(options.now ?? Date.now()).toISOString();
    const eligibleEvents = collection.events.filter((event) => {
      const serviceProviderId = serviceProviderForEvent(event);
      return serviceProviderId !== null
        && allowedProviderSet.has(serviceProviderId)
        && supportedProviderSet.has(serviceProviderId);
    });
    const currentWireEvents = eligibleEvents.map(toWireEvent).filter(Boolean);
    const scanSummary = safeScanSummary(collection.stats);
    const collectionPending = Object.values(collection.stats).some((adapter) => adapter.pending === true);
    const retainedUnresolved = [];
    const legacyRawOnlyEvents = [];
    for (const event of runtime.state.unresolvedEvents || []) {
      const serviceProviderId = serviceProviderForEvent(event);
      const providerStillEligible = serviceProviderId !== null
        && allowedProviderSet.has(serviceProviderId)
        && supportedProviderSet.has(serviceProviderId);
      const rawOnly = providerStillEligible
        ? legacyUnresolvedToRawOnlyWireEvent(event)
        : null;
      if (rawOnly) {
        legacyRawOnlyEvents.push(rawOnly);
      } else {
        retainedUnresolved.push(event);
      }
    }
    const unresolvedQueue = boundedUnresolvedQueue(
      retainedUnresolved,
      [],
      options.unresolvedQueueCap
    );
    const nextRawOnlyBackfill = stagedRawOnlyBackfill(
      runtime.state,
      collection.providerScans,
      unresolvedQueue.events,
      scannedAt
    );
    const priorOverflow = runtime.state.unresolvedOverflow || { totalDropped: 0, lastOverflowAt: null };
    const backfillComplete = nextRawOnlyBackfill.pendingProviders.length === 0
      && unresolvedQueue.events.length === 0
      && (priorOverflow.totalDropped === 0 || nextRawOnlyBackfill.completedAt !== null);
    const unresolvedOverflow = backfillComplete
      ? { totalDropped: 0, lastOverflowAt: null }
      : {
          totalDropped: priorOverflow.totalDropped + unresolvedQueue.dropped,
          lastOverflowAt: unresolvedQueue.dropped > 0 ? scannedAt : priorOverflow.lastOverflowAt
        };
    const eventsById = new Map();
    for (const event of currentWireEvents) eventsById.set(event.eventId, event);
    // Once usage was observed without complete attribution it remains raw-only,
    // even if a later registry recognizes its source token. When the v5 repair
    // scan finds the same stable ID, prefer its exact cache-write split over the
    // retired queue's necessarily folded legacy counters.
    for (const event of legacyRawOnlyEvents) {
      const rescanned = eventsById.get(event.eventId);
      eventsById.set(event.eventId, rescanned ? forceRawOnlyWireEvent(rescanned) : event);
    }
    const events = [...eventsById.values()].sort((a, b) => {
      const timeOrder = a.occurredAt.localeCompare(b.occurredAt);
      return (aggregateHistory ? -timeOrder : timeOrder) || a.eventId.localeCompare(b.eventId);
    });
    const withheld = collection.events.length - currentWireEvents.length;
    const unknownModels = [];
    const codexCheckpointEligible = allowedProviderSet.has("codex")
      && supportedProviderSet.has("codex")
      && collection.providerEvidence?.codex?.status === "available"
      && Array.isArray(collection.providerEvidence.codex.dailyUsageBuckets);
    if (codexCheckpointEligible) {
      // Checkpoint generations form one account lineage shared by every paired
      // device. Hydrate the signed server head immediately before planning so
      // a second device or a reinstalled connector extends the active parent
      // instead of producing a blind GENESIS or sibling generation.
      await sendHeartbeatRequest(runtime, secrets, paths, {
        ...options,
        roots,
        observationCollection: collection,
        hydrateCodexSnapshot: true
      });
    }
    const checkpointPlan = allowedProviderSet.has("codex") && supportedProviderSet.has("codex")
      ? codexCheckpointPlan(collection.providerEvidence, runtime.state.codexCheckpointSnapshot)
      : { checkpoints: [], nextSnapshot: null };
    const checkpointsToSend = checkpointPlan.checkpoints;

    if (events.length === 0 && checkpointsToSend.length === 0) {
      runtime.state.cursors = collection.nextCursors;
      runtime.state.unresolvedEvents = unresolvedQueue.events;
      runtime.state.unresolvedOverflow = unresolvedOverflow;
      runtime.state.rawOnlyBackfill = nextRawOnlyBackfill;
      runtime.state.lastScan = {
        at: scannedAt,
        adapters: scanSummary,
        withheld,
        unknownModels,
        unresolvedQueued: unresolvedQueue.events.length,
        unresolvedOverflow: unresolvedOverflow.totalDropped
      };
      await saveRuntime(paths, runtime);
      await safeLog(paths.log, {
        action: "sync",
        status: "no_changes",
        eventCount: 0,
        sequence: runtime.state.nextSequence
      });
      return {
        sent: 0,
        withheld,
        unresolvedQueued: unresolvedQueue.events.length,
        unresolvedOverflow: unresolvedOverflow.totalDropped,
        nextSequence: runtime.state.nextSequence,
        catchingUp: collectionPending,
        adapters: scanSummary
      };
    }

    const createdOutbox = await createPagedSyncOutbox(
      paths,
      events,
      checkpointsToSend,
      {
        nextCursors: collection.nextCursors,
        codexCheckpointSnapshot: checkpointPlan.nextSnapshot,
        scannedAt,
        scanSummary,
        withheld,
        unknownModels,
        collectionPending,
        nextUnresolvedEvents: unresolvedQueue.events,
        unresolvedOverflow,
        nextRawOnlyBackfill
      },
      options
    );
    runtime.state.syncOutbox = createdOutbox;
    try {
      await saveRuntime(paths, runtime, { atomicWriteJson: options.atomicWriteJson });
    } catch (error) {
      await cleanupSyncBatch(paths, createdOutbox.batchId);
      throw error;
    }
    return processSyncOutbox(runtime, secrets, paths, { ...options, roots });
  });
}

async function applyAutomaticUpdate(value, options = {}) {
  const { paths, roots } = runtimeOptions(options);
  const release = validateUpdateOffer(value, CONNECTOR_VERSION);
  if (!release) {
    if (value?.available === true) {
      await safeLog(paths.log, { action: "update", status: "rejected", code: "UPDATE_OFFER_INVALID" });
      return { checked: true, status: "rejected", code: "UPDATE_OFFER_INVALID" };
    }
    return {
      checked: true,
      status: "current",
      installed: false,
      latestVersion: typeof value?.latestVersion === "string" ? value.latestVersion : null
    };
  }
  const digest = updateOfferDigest(release);
  await ensureRuntimeDirectory(paths);
  try {
    return await withLock(paths.lock, async () => withLock(paths.updateLock, async () => {
      const prior = await readUpdateState(paths);
      if (prior.permanentFailure === true && prior.lastOfferDigest === digest) {
        return {
          checked: true,
          status: "blocked",
          installed: false,
          version: release.version,
          code: prior.safeErrorCode || "UPDATE_PREVIOUSLY_REJECTED"
        };
      }
      try {
        const launcherStat = await fs.lstat(paths.launcher);
        if (!launcherStat.isFile() || launcherStat.isSymbolicLink()) {
          throw new ConnectorError("UPDATE_LAUNCHER_INVALID", "The stable TAG Plugin launcher is unavailable.");
        }
        const runtime = await loadRuntime(paths);
        const installed = await fetchAndInstallUpdate(paths, release, options);
        await activateRelease(paths, release, installed.receipt);
        let antigravity = { installed: false, reason: "statusline_not_consented" };
        if ((runtime.config.allowedPlatforms || []).includes("gemini")
          && runtime.config.antigravityStatuslineConsent === true) {
          try {
            antigravity = await installAntigravityStatusline({
              paths,
              roots,
              wrapperPath: path.join(installed.destination, "src", "antigravity-wrapper.mjs"),
              settingsPath: options.antigravitySettingsPath,
              nodeExecutable: options.nodeExecutable
            });
          } catch {
            antigravity = { installed: false, reason: "wrapper_refresh_failed" };
          }
        }
        await writeUpdateState(paths, {
          installedVersion: release.version,
          lastOfferDigest: digest,
          lastCheckedAt: new Date().toISOString(),
          lastResult: installed.reused ? "verified_existing" : "installed",
          safeErrorCode: null,
          permanentFailure: false
        });
        await safeLog(paths.log, {
          action: "update",
          status: installed.reused ? "verified_existing" : "installed"
        });
        return {
          checked: true,
          status: installed.reused ? "verified_existing" : "installed",
          installed: true,
          version: release.version,
          antigravity
        };
      } catch (error) {
        const code = error instanceof ConnectorError ? error.code : "UPDATE_UNEXPECTED_FAILURE";
        const permanentFailure = !(error instanceof ConnectorError) || !error.retryable;
        try {
          await writeUpdateState(paths, {
            installedVersion: prior.installedVersion || CONNECTOR_VERSION,
            lastOfferDigest: digest,
            lastCheckedAt: new Date().toISOString(),
            lastResult: "failed",
            safeErrorCode: code,
            permanentFailure
          });
        } catch {
          // Update telemetry must never turn an already-committed heartbeat into a failure.
        }
        await safeLog(paths.log, { action: "update", status: "failed", code });
        return { checked: true, status: "failed", installed: false, version: release.version, code };
      }
    }));
  } catch (error) {
    const code = error instanceof ConnectorError ? error.code : "UPDATE_UNEXPECTED_FAILURE";
    await safeLog(paths.log, { action: "update", status: "deferred", code }).catch(() => {});
    return { checked: true, status: "deferred", installed: false, version: release.version, code };
  }
}

async function heartbeatCore(options = {}) {
  const { paths, roots } = runtimeOptions(options);
  await ensureRuntimeDirectory(paths);
  return withLock(paths.lock, async (lease) => {
    await cleanupStaleAtomicWriteTemps(paths, { ownerToken: lease.ownerToken });
    const runtime = await loadRuntime(paths);
    const secrets = await loadSecrets(paths);
    assertPaired(runtime.state, runtime.config, secrets);
    assertPendingCanReplay(runtime);
    const recovered = await replayPending(runtime, secrets, paths, options);
    if (recovered?.pending.kind === "heartbeat") {
      return {
        recovered: true,
        sent: true,
        sequence: recovered.pending.sequence,
        nextExpectedAt: recovered.response?.heartbeat?.nextExpectedAt || null,
        continuityState: recovered.response?.device?.continuityState || null,
        updateOffer: recovered.response?.update || null
      };
    }
    return sendHeartbeatRequest(runtime, secrets, paths, { ...options, roots });
  });
}

export async function heartbeat(options = {}) {
  const result = await heartbeatCore(options);
  if (options.skipAutomaticUpdate === true) return result;
  const update = await applyAutomaticUpdate(result.updateOffer, options);
  return { ...result, update };
}

export async function scheduledRun(options = {}) {
  let syncResult;
  try {
    syncResult = await sync({
      ...options,
      maxIngestRequests: options.maxIngestRequests ?? SCHEDULED_MAX_INGEST_REQUESTS,
      heartbeatEveryIngestRequests: options.heartbeatEveryIngestRequests
        ?? HEARTBEAT_EVERY_INGEST_REQUESTS
    });
  } catch (error) {
    if (!(error instanceof ConnectorError) || error.code !== "RAW_ONLY_CONTRACT_REJECTED") throw error;
    // This response already advanced the signed request chain, so liveness can
    // continue while the lossless Raw outbox remains visibly blocked. A 4xx
    // pending request cannot take this path because its sequence is unresolved.
    syncResult = {
      sent: 0,
      blocked: true,
      code: error.code,
      catchingUp: true
    };
  }
  const heartbeatResult = await heartbeat(options);
  return { sync: syncResult, heartbeat: heartbeatResult };
}

export async function status(options = {}) {
  const { paths } = runtimeOptions(options);
  const [{ state, config }, updateState] = await Promise.all([
    loadRuntime(paths),
    readUpdateState(paths)
  ]);
  const quarantinedEventIds = new Set([
    ...(Array.isArray(state.quarantinedEventIds) ? state.quarantinedEventIds : []),
    ...(Array.isArray(state.syncOutbox?.quarantinedEventIds)
      ? state.syncOutbox.quarantinedEventIds
      : [])
  ]);
  return {
    version: CONNECTOR_VERSION,
    paired: Boolean(state.paired),
    paused: Boolean(state.paused),
    deviceId: state.deviceId,
    endpointConfigured: Boolean(config.endpoint),
    pendingPair: Boolean(state.pendingPair),
    pendingPairPermanentFailure: state.pendingPair?.permanentFailure || null,
    pendingRequest: state.pendingRequest
      ? {
          kind: state.pendingRequest.kind,
          sequence: state.pendingRequest.sequence,
          permanentFailure: state.pendingRequest.permanentFailure || null
        }
      : null,
    pendingChunks: state.syncOutbox
      ? remainingSyncChunks(state.syncOutbox)
      : 0,
    syncOutboxPermanentFailure: state.syncOutbox?.permanentFailure || null,
    unresolvedQueued: Array.isArray(state.unresolvedEvents) ? state.unresolvedEvents.length : 0,
    unresolvedOverflow: state.unresolvedOverflow || { totalDropped: 0, lastOverflowAt: null },
    rawOnlyBackfill: state.syncOutbox?.commit?.nextRawOnlyBackfill || state.rawOnlyBackfill
      || { version: 1, pendingProviders: [], partialCoverage: {}, completedAt: null },
    quarantinedEventCount: quarantinedEventIds.size,
    nextSequence: state.nextSequence,
    lastSyncAt: state.lastSyncAt,
    lastHeartbeatAt: state.lastHeartbeatAt,
    lastScan: state.lastScan,
    allowedPlatforms: config.allowedPlatforms || [],
    supportedProviders: config.supportedProviders || [],
    transcriptFallbacks: config.transcriptFallbacks,
    adapters: adapterStatus(),
    updates: {
      installedVersion: updateState.installedVersion,
      lastCheckedAt: updateState.lastCheckedAt,
      lastResult: updateState.lastResult,
      safeErrorCode: updateState.safeErrorCode
    }
  };
}

export async function doctor(options = {}) {
  const { paths, roots } = runtimeOptions(options);
  const connectorStatus = await status({ ...options, paths });
  const [codex, claude, kimi, claudeStats] = await Promise.all([
    discoverJsonlFiles(roots.codex),
    discoverJsonlFiles(roots.claude),
    discoverJsonlFiles(roots.kimi),
    fs.access(roots.claudeStats).then(() => true).catch(() => false)
  ]);
  let runtimeDirectory = "available";
  try {
    await fs.access(paths.home);
  } catch (error) {
    runtimeDirectory = error?.code === "ENOENT" ? "not_created" : "unavailable";
  }
  return {
    node: {
      version: process.versions.node,
      supported: Number(process.versions.node.split(".")[0]) >= 22
    },
    runtimeDirectory,
    pairing: connectorStatus.paired ? "paired" : "not_paired",
    paused: connectorStatus.paused,
    sources: {
      codex: {
        officialAccountUsage: "queried_only_during_preview_or_sync",
        fallbackJsonlFiles: codex.files.length,
        fallbackEnabled: connectorStatus.transcriptFallbacks.codex,
        accessible: !codex.unavailable
      },
      claude: {
        experimentalStatsCachePresent: claudeStats,
        statsCacheModelDetailUsed: false,
        fallbackJsonlFiles: claude.files.length,
        fallbackEnabled: connectorStatus.transcriptFallbacks.claude,
        accessible: !claude.unavailable
      },
      kimi: {
        verifiedVersion: "0.28",
        fallbackWireFiles: kimi.files.filter((file) => file.toLowerCase().endsWith("wire.jsonl")).length,
        fallbackEnabled: connectorStatus.transcriptFallbacks.kimi,
        accessible: !kimi.unavailable
      },
      gemini: {
        status: "antigravity_desktop_sqlite_v1",
        desktopEnabled: (connectorStatus.allowedPlatforms || []).includes("gemini"),
        statuslineFallbackEnabled: connectorStatus.antigravityStatuslineConsent === true
          && connectorStatus.transcriptFallbacks.gemini === true,
        settingsMutationAuthorized: connectorStatus.antigravityStatuslineConsent === true
      },
      grok: {
        status: "local_session_summary_only",
        fallbackEnabled: connectorStatus.transcriptFallbacks.grok === true
      },
      deepseek: { status: "hosted_model_attribution_or_explicit_api_evidence_only" }
    },
    networkProbePerformed: false
  };
}

async function setPaused(paused, options = {}) {
  const { paths } = runtimeOptions(options);
  await ensureRuntimeDirectory(paths);
  return withLock(paths.lock, async (lease) => {
    await cleanupStaleAtomicWriteTemps(paths, { ownerToken: lease.ownerToken });
    const runtime = await loadRuntime(paths);
    runtime.state.paused = paused;
    await saveRuntime(paths, runtime);
    await safeLog(paths.log, { action: paused ? "pause" : "resume", status: "success" });
    return { paused };
  });
}

export function pause(options) {
  return setPaused(true, options);
}

export function resume(options) {
  return setPaused(false, options);
}

export function installDryRun(options = {}) {
  const { paths } = runtimeOptions(options);
  const runningCliPath = options.cliPath || fileURLToPath(new URL("./cli.mjs", import.meta.url));
  const releaseRoot = path.resolve(options.releaseRoot || path.join(path.dirname(runningCliPath), ".."));
  const installDirectory = path.join(paths.home, "versions", CONNECTOR_VERSION);
  return {
    executed: false,
    releaseCopy: {
      source: releaseRoot,
      destination: installDirectory,
      version: CONNECTOR_VERSION
    },
    plan: schedulerPlan({
      platform: options.platform,
      nodeExecutable: options.nodeExecutable,
      cliPath: paths.launcher,
      home: paths.home,
      env: options.env,
      userHome: options.userHome,
      xdgConfigHome: options.xdgConfigHome,
      uid: options.uid
    })
  };
}

export function uninstallDryRun(options = {}) {
  const { paths } = runtimeOptions(options);
  const installDirectory = path.join(paths.home, "versions", CONNECTOR_VERSION);
  const plan = schedulerPlan({
    platform: options.platform,
    nodeExecutable: options.nodeExecutable,
    cliPath: paths.launcher,
    home: paths.home,
    env: options.env,
    userHome: options.userHome,
    xdgConfigHome: options.xdgConfigHome,
    uid: options.uid
  });
  return {
    executed: false,
    removesScheduler: plan.remove,
    removesInstalledRelease: installDirectory,
    removesInstalledReleases: path.join(paths.home, "versions"),
    removesLocalState: false,
    localStateRequiresSeparateExplicitApproval: true
  };
}

const RELEASE_COPY_ENTRIES = [
  ".github",
  "scripts",
  "src",
  "test",
  "package.json",
  "README.md",
  "RELEASING.md",
  "INSTALL.md",
  "PRIVACY.md",
  "SECURITY.md",
  "THREAT_MODEL.md",
  "ONE_PROMPT_INSTALL.md",
  "install-manifest.json",
  "LICENSE"
];

function assertInstallTarget(home, target) {
  const relative = path.relative(path.resolve(home), path.resolve(target));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new ConnectorError("UNSAFE_INSTALL_TARGET", "The versioned install directory is outside connector state.");
  }
}

async function copyVerifiedRelease(source, destination) {
  assertInstallTarget(path.dirname(path.dirname(destination)), destination);
  const packageJson = JSON.parse(await fs.readFile(path.join(source, "package.json"), "utf8"));
  if (packageJson.version !== CONNECTOR_VERSION) {
    throw new ConnectorError("RELEASE_VERSION_MISMATCH", "The verified source version does not match the connector version.");
  }
  const parent = path.dirname(destination);
  const staging = path.join(parent, ".staging-" + CONNECTOR_VERSION + "-" + randomBytes(6).toString("hex"));
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  await fs.mkdir(staging, { recursive: false, mode: 0o700 });
  try {
    for (const entry of RELEASE_COPY_ENTRIES) {
      await fs.cp(path.join(source, entry), path.join(staging, entry), {
        recursive: true,
        errorOnExist: true,
        force: false
      });
    }
    const destinationStat = await fs.lstat(destination).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
    if (destinationStat) {
      if (!destinationStat.isDirectory() || destinationStat.isSymbolicLink()) {
        throw new ConnectorError("VERSION_IDENTITY_CONFLICT", "The installed TAG Plugin version has another identity.");
      }
      const releaseTreeIdentity = async (root) => {
        const identity = [];
        const visit = async (relative) => {
          const absolute = path.join(root, relative);
          const stat = await fs.lstat(absolute);
          if (stat.isSymbolicLink()) {
            throw new ConnectorError("VERSION_IDENTITY_CONFLICT", "The installed TAG Plugin version contains a symbolic link.");
          }
          if (stat.isDirectory()) {
            identity.push([relative.split(path.sep).join("/"), "directory"]);
            const children = (await fs.readdir(absolute)).sort((left, right) => left.localeCompare(right));
            for (const child of children) await visit(path.join(relative, child));
            return;
          }
          if (!stat.isFile()) {
            throw new ConnectorError("VERSION_IDENTITY_CONFLICT", "The installed TAG Plugin version contains an unsupported entry.");
          }
          identity.push([relative.split(path.sep).join("/"), sha256(await fs.readFile(absolute))]);
        };
        for (const entry of RELEASE_COPY_ENTRIES) await visit(entry);
        return sha256(JSON.stringify(identity));
      };
      const [stagedIdentity, installedIdentity] = await Promise.all([
        releaseTreeIdentity(staging),
        releaseTreeIdentity(destination)
      ]);
      if (stagedIdentity !== installedIdentity) {
        throw new ConnectorError("VERSION_IDENTITY_CONFLICT", "The installed TAG Plugin version has another identity.");
      }
      await fs.rm(staging, { recursive: true, force: true });
      return destination;
    }
    await fs.rename(staging, destination);
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true });
    throw error;
  }
  await fs.rm(staging, { recursive: true, force: true });
  return destination;
}

export async function install(options = {}) {
  const previewResult = installDryRun(options);
  if (!options.confirmInstall) {
    return previewResult;
  }
  const { paths, roots } = runtimeOptions(options);
  await ensureRuntimeDirectory(paths);
  return withLock(paths.lock, async (lease) => {
    await cleanupStaleAtomicWriteTemps(paths, { ownerToken: lease.ownerToken });
    const runtime = await loadRuntime(paths);
    const secrets = await loadSecrets(paths);
    assertPaired(runtime.state, runtime.config, secrets);
    // No state journal references this file once pairing has committed; remove a crash-left duplicate.
    await removePendingSecrets(paths);
    await hardenWindowsSecrets(paths.secrets, options);
    await copyVerifiedRelease(
      previewResult.releaseCopy.source,
      previewResult.releaseCopy.destination
    );
    const launcher = await installStableLauncher(
      paths,
      path.join(previewResult.releaseCopy.destination, "src", "launcher.mjs")
    );
    const activeRelease = await activateRelease(paths, { version: CONNECTOR_VERSION });
    const result = await applyScheduler(previewResult.plan, options);
    const antigravity = (runtime.config.allowedPlatforms || []).includes("gemini")
      && runtime.config.antigravityStatuslineConsent === true
      ? await installAntigravityStatusline({
          paths,
          roots,
          wrapperPath: path.join(previewResult.releaseCopy.destination, "src", "antigravity-wrapper.mjs"),
          settingsPath: options.antigravitySettingsPath,
          nodeExecutable: options.nodeExecutable
        })
      : { installed: false, reason: "statusline_not_consented" };
    return {
      executed: true,
      ...result,
      installedRelease: previewResult.releaseCopy.destination,
      launcher,
      activeRelease,
      antigravity,
      plan: previewResult.plan
    };
  });
}

export async function uninstall(options = {}) {
  const previewResult = uninstallDryRun(options);
  if (!options.confirmUninstall) {
    return previewResult;
  }
  const { paths, roots } = runtimeOptions(options);
  await ensureRuntimeDirectory(paths);
  return withLock(paths.lock, async (lease) => {
    await cleanupStaleAtomicWriteTemps(paths, { ownerToken: lease.ownerToken });
    const plan = schedulerPlan({
      platform: options.platform,
      nodeExecutable: options.nodeExecutable,
      cliPath: paths.launcher,
      home: paths.home,
      env: options.env,
      userHome: options.userHome,
      xdgConfigHome: options.xdgConfigHome,
      uid: options.uid
    });
    const antigravity = await uninstallAntigravityStatusline({
      paths,
      roots,
      statePath: options.antigravityStatuslineStatePath
    });
    const result = await removeScheduler(plan, options);
    const installedReleases = path.join(paths.home, "versions");
    assertInstallTarget(paths.home, installedReleases);
    await fs.rm(installedReleases, { recursive: true, force: true });
    await fs.rm(paths.launcher, { force: true });
    await fs.rm(paths.activeRelease, { force: true });
    return {
      executed: true,
      ...result,
      installedReleaseRemoved: true,
      antigravity,
      localStateRemoved: false,
      localStatePreservedForRecovery: true
    };
  });
}
