import fs from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONNECTOR_VERSION,
  HEARTBEAT_EVERY_INGEST_REQUESTS,
  INGEST_CHUNK_PACE_MS,
  MAX_INGEST_CHECKPOINTS,
  MAX_INGEST_EVENTS,
  MAX_UNRESOLVED_EVENTS,
  SCHEDULED_MAX_INGEST_REQUESTS
} from "./constants.mjs";
import { adapterStatus } from "./adapters/registry.mjs";
import { aggregatePreview, collectUsage, toWireEvent } from "./collector.mjs";
import { createDeviceSecrets, payloadHash, sha256 } from "./crypto.mjs";
import { discoverJsonlFiles } from "./discovery.mjs";
import { ConnectorError } from "./errors.mjs";
import { signedPost, validateEndpoint } from "./http.mjs";
import { withLock } from "./lock.mjs";
import { canonicalModelId } from "./model-registry.mjs";
import { providerRoots, runtimePaths } from "./paths.mjs";
import { safeLog } from "./safe-log.mjs";
import { applyScheduler, removeScheduler, schedulerPlan } from "./scheduler.mjs";
import { hardenWindowsConnectorHome, hardenWindowsSecrets } from "./windows-security.mjs";
import {
  atomicWriteJson,
  ensureRuntimeDirectory,
  loadPendingSecrets,
  loadRuntime,
  loadSecrets,
  removePendingSecrets,
  saveRuntime,
  saveSecrets,
  savePendingSecrets
} from "./state.mjs";

const PLATFORM_IDS = new Set(["codex", "claude", "gemini", "grok", "kimi"]);
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
    files: value.files || 0,
    events: value.events || 0,
    malformed: value.malformed || 0,
    duplicateSnapshots: value.duplicateSnapshots || 0,
    cumulativeResets: value.cumulativeResets || 0,
    cumulativeMismatches: value.cumulativeMismatches || 0,
    collector: value.collector || null
  }]));
}

function toUnresolvedEvent(event) {
  if (!event?.eventId
    || !event?.observedAt
    || typeof event?.sourceModelId !== "string"
    || !SOURCE_MODEL_PATTERN.test(event.sourceModelId)) return null;
  return {
    eventId: event.eventId,
    occurredAt: event.observedAt,
    provider: event.provider,
    sourceModelId: event.sourceModelId,
    serviceMode: event.mode.fast ? "fast" : "standard",
    inputTokens: String(event.usage.input + event.usage.cacheWriteInput),
    cachedInputTokens: String(event.usage.cachedInput),
    outputTokens: String(event.usage.output),
    ...(event.usage.reasoningOutput > 0
      ? { reasoningTokens: String(event.usage.reasoningOutput) }
      : {}),
    surface: event.provenance.surface
  };
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

function resolveUnresolvedEvent(event, resolveModel) {
  const modelId = resolveModel(event.provider, event.sourceModelId);
  if (!modelId) return null;
  const wireEvent = { ...event };
  delete wireEvent.sourceModelId;
  return { ...wireEvent, modelId };
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
    kimi: Boolean(value.kimi)
  };
}

function allowedFallbacks(requested, allowedPlatforms) {
  const allowed = new Set(allowedPlatforms || []);
  return Object.fromEntries(Object.entries(requested).map(([provider, enabled]) => [
    provider,
    Boolean(enabled && allowed.has(provider))
  ]));
}

function normalizePairCode(value) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toUpperCase().replace(/[-\s]/g, "");
  return /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/.test(normalized) ? normalized : null;
}

function checkpointForBucket(bucket) {
  const start = new Date(bucket.startDate + "T00:00:00.000Z");
  if (!Number.isFinite(start.getTime())) {
    return null;
  }
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1_000);
  const seed = {
    provider: "codex",
    source: "codex_app_server_account_usage",
    periodStart: start.toISOString(),
    periodEnd: end.toISOString(),
    totalTokens: String(bucket.tokens)
  };
  return {
    checkpointId: sha256(JSON.stringify(seed)),
    ...seed
  };
}

function codexCheckpoints(providerEvidence) {
  if (providerEvidence?.codex?.status !== "available" || !Array.isArray(providerEvidence.codex.dailyUsageBuckets)) {
    return [];
  }
  return providerEvidence.codex.dailyUsageBuckets.map(checkpointForBucket).filter(Boolean);
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

function commitCompletedOutbox(runtime) {
  const outbox = runtime.state.syncOutbox;
  if (!outbox || outbox.index < outbox.chunks.length) return;
  runtime.state.cursors = outbox.commit.nextCursors;
  if (outbox.commit.checkpointHash) {
    runtime.state.providerEvidenceHashes.codex = outbox.commit.checkpointHash;
  }
  runtime.state.unresolvedEvents = Array.isArray(outbox.commit.nextUnresolvedEvents)
    ? outbox.commit.nextUnresolvedEvents
    : runtime.state.unresolvedEvents;
  runtime.state.unresolvedOverflow = outbox.commit.unresolvedOverflow
    || runtime.state.unresolvedOverflow;
  runtime.state.lastSyncAt = outbox.commit.scannedAt;
  runtime.state.lastScan = {
    at: outbox.commit.scannedAt,
    adapters: outbox.commit.scanSummary,
    withheld: outbox.commit.withheld,
    rejected: outbox.rejected,
    quarantined: outbox.quarantinedEventIds.length,
    unknownModels: outbox.commit.unknownModels,
    unresolvedQueued: runtime.state.unresolvedEvents.length,
    unresolvedOverflow: runtime.state.unresolvedOverflow.totalDropped
  };
  runtime.state.quarantinedEventIds = [
    ...runtime.state.quarantinedEventIds,
    ...outbox.quarantinedEventIds
  ].slice(-2_000);
  runtime.state.syncOutbox = null;
}

function finalizePending(runtime, response) {
  const pending = runtime.state.pendingRequest;
  if (!pending) {
    throw new ConnectorError("MISSING_PENDING_REQUEST", "The local request journal is missing its pending request.");
  }
  if (pending.sequence !== runtime.state.nextSequence) {
    throw new ConnectorError("PENDING_SEQUENCE_MISMATCH", "The pending request does not match the local request sequence.");
  }
  applyAcceptedRequest(runtime.state, response);
  if (pending.kind === "sync") {
    const outbox = runtime.state.syncOutbox;
    if (!outbox || outbox.index >= outbox.chunks.length) {
      throw new ConnectorError("MISSING_SYNC_OUTBOX", "The pending sync request has no matching local outbox.");
    }
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
    outbox.quarantinedEventIds.push(...rejectedIds);
    outbox.index += 1;
    commitCompletedOutbox(runtime);
  } else if (pending.kind === "heartbeat") {
    runtime.state.lastHeartbeatAt = pending.commit.observedAt;
  }
  runtime.state.pendingRequest = null;
  return pending;
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
  const committed = finalizePending(runtime, response);
  await saveRuntime(paths, runtime);
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
  const adapterHealth = Object.values(runtime.state.lastScan?.adapters || {});
  const degraded = adapterHealth.some((adapter) =>
    adapter.status === "unavailable"
    || (adapter.malformed || 0) > 0
    || (adapter.cumulativeMismatches || 0) > 0
    || (adapter.cumulativeResets || 0) > 0
  ) || runtime.state.unresolvedEvents.length > 0
    || runtime.state.unresolvedOverflow.totalDropped > 0;
  const body = {
    observedAt,
    status: runtime.state.paused ? "paused" : (degraded ? "degraded" : "healthy"),
    connectorVersion: CONNECTOR_VERSION,
    previousRequestDigest: runtime.state.previousRequestDigest
  };
  runtime.state.pendingRequest = pendingRequest(
    "heartbeat",
    "/api/connectors/v1/heartbeat",
    sequence,
    body,
    { observedAt }
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
  finalizePending(runtime, response);
  await saveRuntime(paths, runtime);
  await safeLog(paths.log, { action: "heartbeat", status: "success", sequence });
  return {
    sent: true,
    sequence,
    nextExpectedAt: response?.heartbeat?.nextExpectedAt || null,
    continuityState: response?.device?.continuityState || null
  };
}

export function chunkSyncPayloads(events, checkpoints) {
  const chunks = [];
  for (let index = 0; index < events.length; index += MAX_INGEST_EVENTS) {
    chunks.push({
      events: events.slice(index, index + MAX_INGEST_EVENTS),
      checkpoints: []
    });
  }
  for (let index = 0; index < checkpoints.length; index += MAX_INGEST_CHECKPOINTS) {
    chunks.push({
      events: [],
      checkpoints: checkpoints.slice(index, index + MAX_INGEST_CHECKPOINTS)
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
  runtime.state.pendingRequest = null;
  if (split) {
    outbox.chunks.splice(outbox.index, 1, ...split);
  } else {
    outbox.rejected += chunk.events.length + chunk.checkpoints.length;
    outbox.quarantinedEventIds.push(...chunk.events.map((event) => event.eventId));
    outbox.index += 1;
    commitCompletedOutbox(runtime);
  }
  await saveRuntime(paths, runtime);
  return true;
}

async function processSyncOutbox(runtime, secrets, paths, options) {
  const initial = runtime.state.syncOutbox;
  if (!initial) {
    return null;
  }
  const initialIndex = initial.index;
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
    const chunk = outbox.chunks[outbox.index];
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
    finalizePending(runtime, response);
    await saveRuntime(paths, runtime);
    await afterIngestRequest();
  }
  const completedChunks = initial.chunks.slice(initialIndex, initial.index);
  const sent = completedChunks.reduce((total, chunk) => total + chunk.events.length, 0);
  const checkpoints = completedChunks.reduce((total, chunk) => total + chunk.checkpoints.length, 0);
  const catchingUp = Boolean(runtime.state.syncOutbox);
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
    quarantined: initial.quarantinedEventIds.length,
    chunks: initial.chunks.length,
    unresolvedQueued: Array.isArray(initial.commit.nextUnresolvedEvents)
      ? initial.commit.nextUnresolvedEvents.length
      : runtime.state.unresolvedEvents.length,
    unresolvedOverflow: initial.commit.unresolvedOverflow?.totalDropped
      ?? runtime.state.unresolvedOverflow.totalDropped,
    chunksProcessed: initial.index - initialIndex,
    ingestRequests,
    interleavedHeartbeats,
    catchingUp,
    remainingChunks: Math.max(0, initial.chunks.length - initial.index),
    nextSequence: runtime.state.nextSequence,
    adapters: initial.commit.scanSummary
  };
}

export async function preview(options = {}) {
  const { paths, roots } = runtimeOptions(options);
  const { state, config } = await loadRuntime(paths);
  const existingSecrets = await loadSecrets(paths);
  const secrets = existingSecrets || createDeviceSecrets();
  const enabledFallbacks = requestedFallbacks(options.enabledFallbacks || config.transcriptFallbacks);
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
      codex: (config.allowedPlatforms || []).includes("codex")
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
      { provider: "gemini", source: "planned official telemetry adapter", enabled: false },
      { provider: "grok", source: "planned official telemetry adapter", enabled: false }
    ],
    networkPerformed: false
  };
}

export async function pair(options = {}) {
  const { paths } = runtimeOptions(options);
  await ensureRuntimeDirectory(paths);
  return withLock(paths.lock, async () => {
    await hardenWindowsConnectorHome(paths.home, options);
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
      runtime.state.pendingRequest = null;
      runtime.state.syncOutbox = null;
      await saveRuntime(paths, runtime);
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
      if (runtime.state.paired && !options.replacePendingPair) {
        throw new ConnectorError(
          "ALREADY_PAIRED",
          "This connector already has an active device. Use --replace-pending-pair with a fresh code only when intentionally replacing it."
        );
      }
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
        approvedFallbacks: requestedFallbacks(options.enabledFallbacks)
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
      transcriptFallbacks: runtime.config.transcriptFallbacks
    };
  });
}

export async function sync(options = {}) {
  const { paths, roots } = runtimeOptions(options);
  await ensureRuntimeDirectory(paths);
  return withLock(paths.lock, async () => {
    const runtime = await loadRuntime(paths);
    const secrets = await loadSecrets(paths);
    assertPaired(runtime.state, runtime.config, secrets);
    if (runtime.state.pendingRequest?.kind === "heartbeat") {
      assertPendingCanReplay(runtime);
      await replayPending(runtime, secrets, paths, options);
    }
    if (runtime.state.pendingRequest?.kind === "sync" && !runtime.state.syncOutbox) {
      throw new ConnectorError("MISSING_SYNC_OUTBOX", "A pending sync request has no matching local outbox.");
    }
    if (runtime.state.syncOutbox) {
      return {
        recovered: true,
        ...await processSyncOutbox(runtime, secrets, paths, options)
      };
    }
    if (runtime.state.paused) {
      return { skipped: true, reason: "paused" };
    }
    const configuredFallbacks = allowedFallbacks(
      runtime.config.transcriptFallbacks,
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
        codex: allowedProviderSet.has("codex")
      },
      dedupNamespaceKey: secrets.dedupNamespaceKey
    });
    const scannedAt = new Date(options.now ?? Date.now()).toISOString();
    const eligibleEvents = collection.events.filter((event) =>
      allowedProviderSet.has(event.provider) && supportedProviderSet.has(event.provider)
    );
    const currentWireEvents = eligibleEvents.map(toWireEvent).filter(Boolean);
    const currentUnresolved = [];
    for (const event of eligibleEvents.filter((candidate) => !candidate.modelId)) {
      const normalized = toUnresolvedEvent(event);
      if (normalized) {
        currentUnresolved.push(normalized);
      } else if (collection.stats[event.provider]) {
        collection.stats[event.provider].malformed += 1;
      }
    }
    const scanSummary = safeScanSummary(collection.stats);
    const retainedUnresolved = [];
    const resolvedQueuedEvents = [];
    for (const event of runtime.state.unresolvedEvents || []) {
      const providerStillEligible = allowedProviderSet.has(event.provider)
        && supportedProviderSet.has(event.provider);
      const resolved = providerStillEligible
        ? resolveUnresolvedEvent(event, resolveModel)
        : null;
      if (resolved) {
        resolvedQueuedEvents.push(resolved);
      } else {
        retainedUnresolved.push(event);
      }
    }
    const unresolvedQueue = boundedUnresolvedQueue(
      retainedUnresolved,
      currentUnresolved,
      options.unresolvedQueueCap
    );
    const priorOverflow = runtime.state.unresolvedOverflow || { totalDropped: 0, lastOverflowAt: null };
    const unresolvedOverflow = {
      totalDropped: priorOverflow.totalDropped + unresolvedQueue.dropped,
      lastOverflowAt: unresolvedQueue.dropped > 0 ? scannedAt : priorOverflow.lastOverflowAt
    };
    const eventsById = new Map();
    for (const event of [...resolvedQueuedEvents, ...currentWireEvents]) {
      eventsById.set(event.eventId, event);
    }
    const events = [...eventsById.values()].sort((a, b) =>
      a.occurredAt.localeCompare(b.occurredAt) || a.eventId.localeCompare(b.eventId)
    );
    const withheld = collection.events.length - currentWireEvents.length;
    const unknownModels = [...new Map(
      unresolvedQueue.events.map((event) => [event.provider + "\0" + event.sourceModelId, {
        provider: event.provider,
        sourceModelId: event.sourceModelId
      }])
    ).values()];
    const checkpoints = allowedProviderSet.has("codex") && supportedProviderSet.has("codex")
      ? codexCheckpoints(collection.providerEvidence)
      : [];
    const checkpointHash = checkpoints.length > 0 ? payloadHash(checkpoints) : null;
    const checkpointsChanged = Boolean(checkpointHash && runtime.state.providerEvidenceHashes.codex !== checkpointHash);
    const checkpointsToSend = checkpointsChanged ? checkpoints : [];

    if (events.length === 0 && checkpointsToSend.length === 0) {
      runtime.state.cursors = collection.nextCursors;
      runtime.state.unresolvedEvents = unresolvedQueue.events;
      runtime.state.unresolvedOverflow = unresolvedOverflow;
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
        adapters: scanSummary
      };
    }

    runtime.state.syncOutbox = {
      version: 1,
      index: 0,
      chunks: chunkSyncPayloads(events, checkpointsToSend),
      totalEvents: events.length,
      totalCheckpoints: checkpointsToSend.length,
      accepted: 0,
      duplicates: 0,
      rejected: 0,
      quarantinedEventIds: [],
      commit: {
        nextCursors: collection.nextCursors,
        checkpointHash,
        scannedAt,
        scanSummary,
        withheld,
        unknownModels,
        nextUnresolvedEvents: unresolvedQueue.events,
        unresolvedOverflow
      }
    };
    await saveRuntime(paths, runtime);
    return processSyncOutbox(runtime, secrets, paths, options);
  });
}

export async function heartbeat(options = {}) {
  const { paths } = runtimeOptions(options);
  await ensureRuntimeDirectory(paths);
  return withLock(paths.lock, async () => {
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
        continuityState: recovered.response?.device?.continuityState || null
      };
    }
    return sendHeartbeatRequest(runtime, secrets, paths, options);
  });
}

export async function scheduledRun(options = {}) {
  const syncResult = await sync({
    ...options,
    maxIngestRequests: options.maxIngestRequests ?? SCHEDULED_MAX_INGEST_REQUESTS,
    heartbeatEveryIngestRequests: options.heartbeatEveryIngestRequests
      ?? HEARTBEAT_EVERY_INGEST_REQUESTS
  });
  const heartbeatResult = await heartbeat(options);
  return { sync: syncResult, heartbeat: heartbeatResult };
}

export async function status(options = {}) {
  const { paths } = runtimeOptions(options);
  const { state, config } = await loadRuntime(paths);
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
      ? Math.max(0, state.syncOutbox.chunks.length - state.syncOutbox.index)
      : 0,
    unresolvedQueued: Array.isArray(state.unresolvedEvents) ? state.unresolvedEvents.length : 0,
    unresolvedOverflow: state.unresolvedOverflow || { totalDropped: 0, lastOverflowAt: null },
    quarantinedEventCount: quarantinedEventIds.size,
    nextSequence: state.nextSequence,
    lastSyncAt: state.lastSyncAt,
    lastHeartbeatAt: state.lastHeartbeatAt,
    lastScan: state.lastScan,
    allowedPlatforms: config.allowedPlatforms || [],
    supportedProviders: config.supportedProviders || [],
    transcriptFallbacks: config.transcriptFallbacks,
    adapters: adapterStatus()
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
      gemini: { status: "planned_official_telemetry_not_universal" },
      grok: { status: "planned_official_telemetry" }
    },
    networkProbePerformed: false
  };
}

async function setPaused(paused, options = {}) {
  const { paths } = runtimeOptions(options);
  await ensureRuntimeDirectory(paths);
  return withLock(paths.lock, async () => {
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
  const installedCliPath = path.join(installDirectory, "src", "cli.mjs");
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
      cliPath: installedCliPath,
      home: paths.home,
      env: options.env
    })
  };
}

export function uninstallDryRun(options = {}) {
  const { paths } = runtimeOptions(options);
  const installDirectory = path.join(paths.home, "versions", CONNECTOR_VERSION);
  const plan = schedulerPlan({
    platform: options.platform,
    nodeExecutable: options.nodeExecutable,
    cliPath: path.join(installDirectory, "src", "cli.mjs"),
    home: paths.home,
    env: options.env
  });
  return {
    executed: false,
    removesScheduler: plan.remove,
    removesInstalledRelease: installDirectory,
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
  const backup = destination + ".previous";
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
    await fs.rm(backup, { recursive: true, force: true });
    const destinationExists = await fs.access(destination).then(() => true).catch(() => false);
    if (destinationExists) await fs.rename(destination, backup);
    try {
      await fs.rename(staging, destination);
    } catch (error) {
      if (destinationExists) await fs.rename(backup, destination);
      throw error;
    }
    await fs.rm(backup, { recursive: true, force: true });
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true });
    throw error;
  }
  return destination;
}

export async function install(options = {}) {
  const previewResult = installDryRun(options);
  if (!options.confirmInstall) {
    return previewResult;
  }
  const { paths } = runtimeOptions(options);
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
  const result = await applyScheduler(previewResult.plan, options);
  return {
    executed: true,
    ...result,
    installedRelease: previewResult.releaseCopy.destination,
    plan: previewResult.plan
  };
}

export async function uninstall(options = {}) {
  const previewResult = uninstallDryRun(options);
  if (!options.confirmUninstall) {
    return previewResult;
  }
  const { paths } = runtimeOptions(options);
  const plan = schedulerPlan({
    platform: options.platform,
    nodeExecutable: options.nodeExecutable,
    cliPath: path.join(paths.home, "versions", CONNECTOR_VERSION, "src", "cli.mjs"),
    home: paths.home,
    env: options.env
  });
  const result = await removeScheduler(plan, options);
  const installedRelease = path.join(paths.home, "versions", CONNECTOR_VERSION);
  assertInstallTarget(paths.home, installedRelease);
  await fs.rm(installedRelease, { recursive: true, force: true });
  return {
    executed: true,
    ...result,
    installedReleaseRemoved: true,
    localStateRemoved: false,
    localStatePreservedForRecovery: true
  };
}
