import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  AGGREGATE_CURSOR_VERSION,
  ANTIGRAVITY_ACCOUNTING_VERSION,
  CLAUDE_ACCOUNTING_VERSION,
  CODEX_ACCOUNTING_VERSION,
  CODEX_SNAPSHOT_STATE_VERSION,
  DEFAULT_LOCK_STALE_MS,
  KIMI_ACCOUNTING_VERSION,
  MAX_CODEX_LOGICAL_SESSIONS,
  MAX_CURSOR_FILES,
  MAX_MIGRATION_EXCLUSIONS,
  MAX_UNRESOLVED_EVENTS,
  SCHEMA_VERSION
} from "./constants.mjs";
import { ConnectorError } from "./errors.mjs";
import { payloadHash } from "./crypto.mjs";

const UNRESOLVED_EVENT_KEYS = new Set([
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
const AGGREGATE_PROVIDERS = ["codex", "claude", "gemini", "kimi"];

function isCanonicalUtcDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return false;
  const parsed = new Date(value + "T00:00:00.000Z");
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
const ROOT_ATOMIC_JSON_TEMP_PATTERN = /^\.(config\.json|state\.json|device-secrets\.json|pending-device-secrets\.json)\.([1-9]\d*)\.([a-f0-9]{12})\.tmp$/;
const SYNC_BATCH_DIRECTORY_PATTERN = /^[a-f0-9]{24}$/;
const SYNC_PAGE_ATOMIC_JSON_TEMP_PATTERN = /^\.(\d{6,})\.json\.([1-9]\d*)\.([a-f0-9]{12})\.tmp$/;
const MAX_HOME_CLEANUP_ENTRIES = 256;
const MAX_SYNC_BATCH_CLEANUP_ENTRIES = 256;
const MAX_SYNC_PAGE_CLEANUP_ENTRIES = 2_048;

async function boundedDirectoryEntries(directory, maximum) {
  let handle;
  try {
    handle = await fs.opendir(directory);
  } catch (error) {
    if (error?.code === "ENOENT") return { entries: [], truncated: false };
    throw error;
  }
  const entries = [];
  let truncated = false;
  try {
    for (let index = 0; index < maximum; index += 1) {
      const entry = await handle.read();
      if (!entry) return { entries, truncated };
      entries.push(entry);
    }
    truncated = Boolean(await handle.read());
    return { entries, truncated };
  } finally {
    await handle.close().catch(() => {});
  }
}

function processIsAlive(pid, processKill) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try {
    processKill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

async function assertCleanupLockOwner(paths, ownerToken, home) {
  const canonicalLock = path.join(home, "connector.lock");
  if (path.resolve(paths.lock) !== canonicalLock || typeof ownerToken !== "string" || ownerToken.length < 16) {
    throw new ConnectorError(
      "ATOMIC_TEMP_CLEANUP_UNSAFE",
      "Stale atomic-file cleanup requires the canonical connector overlap lock."
    );
  }
  let stat;
  let record;
  try {
    stat = await fs.lstat(canonicalLock);
    record = JSON.parse(await fs.readFile(canonicalLock, "utf8"));
  } catch (error) {
    throw new ConnectorError(
      "ATOMIC_TEMP_CLEANUP_UNSAFE",
      "The connector overlap-lock ownership proof is unavailable.",
      { cause: error }
    );
  }
  if (!stat.isFile()
    || record?.ownerToken !== ownerToken
    || record?.pid !== process.pid) {
    throw new ConnectorError(
      "ATOMIC_TEMP_CLEANUP_UNSAFE",
      "The connector overlap lock is not owned by this process."
    );
  }
}

function canonicalSyncPageIndex(value) {
  if (!/^\d+$/.test(value)) return null;
  const pageIndex = Number(value);
  if (!Number.isSafeInteger(pageIndex) || pageIndex < 1) return null;
  return String(pageIndex).padStart(6, "0") === value ? pageIndex : null;
}

async function removeStaleAtomicCandidate(filePath, canonicalPath, expectedDirectory, pid, options) {
  if (path.dirname(path.resolve(filePath)) !== expectedDirectory
    || path.dirname(path.resolve(canonicalPath)) !== expectedDirectory) return false;
  let canonicalObserved;
  try {
    canonicalObserved = await fs.lstat(canonicalPath);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  // A temp can be the only recoverable copy after a crash. Never reclaim it
  // unless the corresponding committed runtime JSON still exists as a file.
  if (!canonicalObserved.isFile()) return false;
  let observed;
  try {
    observed = await fs.lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  if (!observed.isFile()
    || options.now - observed.mtimeMs <= options.staleMs
    || processIsAlive(pid, options.processKill)) {
    return false;
  }
  let current;
  let canonicalCurrent;
  try {
    [current, canonicalCurrent] = await Promise.all([
      fs.lstat(filePath),
      fs.lstat(canonicalPath)
    ]);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  if (!current.isFile()
    || current.dev !== observed.dev
    || current.ino !== observed.ino
    || current.size !== observed.size
    || current.mtimeMs !== observed.mtimeMs
    || !canonicalCurrent.isFile()
    || canonicalCurrent.dev !== canonicalObserved.dev
    || canonicalCurrent.ino !== canonicalObserved.ino
    || canonicalCurrent.size !== canonicalObserved.size
    || canonicalCurrent.mtimeMs !== canonicalObserved.mtimeMs) {
    return false;
  }
  await fs.unlink(filePath);
  return true;
}

export async function cleanupStaleAtomicWriteTemps(paths, options = {}) {
  const home = path.resolve(paths.home);
  await assertCleanupLockOwner(paths, options.ownerToken, home);
  const cleanupOptions = {
    now: Number.isFinite(options.now) ? options.now : Date.now(),
    staleMs: Number.isFinite(options.staleMs) && options.staleMs >= DEFAULT_LOCK_STALE_MS
      ? options.staleMs
      : DEFAULT_LOCK_STALE_MS,
    processKill: options.processKill || process.kill
  };
  let examined = 0;
  let removed = 0;
  let truncated = false;

  const homeListing = await boundedDirectoryEntries(home, MAX_HOME_CLEANUP_ENTRIES);
  truncated ||= homeListing.truncated;
  for (const entry of homeListing.entries) {
    examined += 1;
    const match = ROOT_ATOMIC_JSON_TEMP_PATTERN.exec(entry.name);
    if (!match || !entry.isFile()) continue;
    const pid = Number(match[2]);
    if (!Number.isSafeInteger(pid)) continue;
    removed += Number(await removeStaleAtomicCandidate(
      path.join(home, entry.name),
      path.join(home, match[1]),
      home,
      pid,
      cleanupOptions
    ));
  }

  const syncRoot = path.resolve(home, "sync-pages");
  if (path.dirname(syncRoot) !== home) {
    throw new ConnectorError("ATOMIC_TEMP_CLEANUP_UNSAFE", "The sync-page directory escaped connector state.");
  }
  const batchListing = await boundedDirectoryEntries(syncRoot, MAX_SYNC_BATCH_CLEANUP_ENTRIES);
  truncated ||= batchListing.truncated;
  let remainingPageEntries = MAX_SYNC_PAGE_CLEANUP_ENTRIES;
  for (const batchEntry of batchListing.entries) {
    examined += 1;
    if (remainingPageEntries <= 0) {
      truncated = true;
      break;
    }
    if (!batchEntry.isDirectory() || !SYNC_BATCH_DIRECTORY_PATTERN.test(batchEntry.name)) continue;
    const batchDirectory = path.resolve(syncRoot, batchEntry.name);
    if (path.dirname(batchDirectory) !== syncRoot) continue;
    const batchStat = await fs.lstat(batchDirectory).catch(() => null);
    if (!batchStat?.isDirectory()) continue;
    const pageListing = await boundedDirectoryEntries(batchDirectory, remainingPageEntries);
    remainingPageEntries -= pageListing.entries.length;
    truncated ||= pageListing.truncated;
    for (const entry of pageListing.entries) {
      examined += 1;
      const match = SYNC_PAGE_ATOMIC_JSON_TEMP_PATTERN.exec(entry.name);
      if (!match || !entry.isFile() || canonicalSyncPageIndex(match[1]) === null) continue;
      const pid = Number(match[2]);
      if (!Number.isSafeInteger(pid)) continue;
      removed += Number(await removeStaleAtomicCandidate(
        path.join(batchDirectory, entry.name),
        path.join(batchDirectory, `${match[1]}.json`),
        batchDirectory,
        pid,
        cleanupOptions
      ));
    }
  }
  return { examined, removed, truncated };
}

function initialAggregateCursors() {
  return {
    version: AGGREGATE_CURSOR_VERSION,
    providers: Object.fromEntries(AGGREGATE_PROVIDERS.map((provider) => [provider, { through: null }]))
  };
}

function normalizedAggregateCursors(value) {
  if (value?.version !== AGGREGATE_CURSOR_VERSION || !value.providers || typeof value.providers !== "object") {
    return initialAggregateCursors();
  }
  return {
    version: AGGREGATE_CURSOR_VERSION,
    providers: Object.fromEntries(AGGREGATE_PROVIDERS.map((provider) => {
      const through = value.providers?.[provider]?.through;
      return [provider, {
        through: typeof through === "string" && Number.isFinite(Date.parse(through))
          ? new Date(through).toISOString()
          : null
      }];
    }))
  };
}

function initialCodexSnapshot() {
  return {
    version: CODEX_SNAPSHOT_STATE_VERSION,
    generationId: null,
    snapshotDigest: null,
    lifetimeTokens: null,
    dailyValues: {}
  };
}

export function normalizeCodexCheckpointSnapshot(value) {
  if (value?.version !== CODEX_SNAPSHOT_STATE_VERSION
    || !value.dailyValues
    || typeof value.dailyValues !== "object"
    || Array.isArray(value.dailyValues)) {
    return initialCodexSnapshot();
  }
  const entries = Object.entries(value.dailyValues);
  const empty = value.generationId === null
    && value.snapshotDigest === null
    && value.lifetimeTokens === null
    && entries.length === 0;
  if (empty) return initialCodexSnapshot();
  if (!/^[a-f0-9]{64}$/.test(value.generationId || "")
    || !/^[a-f0-9]{64}$/.test(value.snapshotDigest || "")
    || !TOKEN_COUNT_PATTERN.test(value.lifetimeTokens || "")
    || !entries.every(([usageDate, tokens]) => isCanonicalUtcDate(usageDate)
      && typeof tokens === "string"
      && TOKEN_COUNT_PATTERN.test(tokens))) {
    return initialCodexSnapshot();
  }
  const dailyValues = Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)));
  const expectedDigest = payloadHash({
    provider: "codex",
    sourceScope: "codex_subscription_account",
    lifetimeTokens: value.lifetimeTokens,
    dailyValues
  });
  if (value.snapshotDigest !== expectedDigest) return initialCodexSnapshot();
  return {
    version: CODEX_SNAPSHOT_STATE_VERSION,
    generationId: value.generationId,
    snapshotDigest: value.snapshotDigest,
    lifetimeTokens: value.lifetimeTokens,
    dailyValues
  };
}

function normalizedCodexSessions(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .filter(([alias, entry]) => /^[a-f0-9]{64}$/.test(alias)
      && Number.isSafeInteger(entry?.highWatermark)
      && entry.highWatermark >= 0)
    .sort((a, b) => (b[1]?.lastSeenAt || 0) - (a[1]?.lastSeenAt || 0))
    .slice(0, MAX_CODEX_LOGICAL_SESSIONS)
    .map(([alias, entry]) => [alias, {
      epoch: Number.isSafeInteger(entry.epoch) && entry.epoch >= 0 ? entry.epoch : 0,
      highWatermark: entry.highWatermark,
      lastSeenAt: Number.isFinite(entry.lastSeenAt) ? entry.lastSeenAt : 0
    }]));
}

function normalizedAntigravityFiles(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const valid = [];
  for (const [fileAlias, cursor] of Object.entries(value)) {
    if (!/^[a-f0-9]{64}$/.test(fileAlias)
      || cursor?.version !== 2
      || !/^[a-f0-9]{64}$/.test(cursor.conversationAlias || "")
      || !/^[a-f0-9]{64}$/.test(cursor.fileIdentity || "")
      || !/^[a-f0-9]{64}$/.test(cursor.schemaIdentity || "")
      || !Number.isSafeInteger(cursor.highWatermark)
      || cursor.highWatermark < -1
      || !Array.isArray(cursor.pending)
      || cursor.pending.length > 10_000) continue;
    const indexes = new Set();
    const pending = [];
    let pendingValid = true;
    for (const entry of cursor.pending) {
      if (!Number.isSafeInteger(entry?.index)
        || entry.index < 0
        || entry.index > cursor.highWatermark
        || !["open", "completed"].includes(entry?.status)
        || indexes.has(entry.index)) {
        pendingValid = false;
        break;
      }
      indexes.add(entry.index);
      pending.push({ index: entry.index, status: entry.status });
    }
    if (!pendingValid) continue;
    valid.push([fileAlias, {
      version: 2,
      conversationAlias: cursor.conversationAlias,
      fileIdentity: cursor.fileIdentity,
      schemaIdentity: cursor.schemaIdentity,
      highWatermark: cursor.highWatermark,
      pending: pending.sort((left, right) => left.index - right.index),
      lastSeenAt: Number.isFinite(cursor.lastSeenAt) ? cursor.lastSeenAt : 0
    }]);
  }
  return Object.fromEntries(valid
    .sort((left, right) => (right[1]?.lastSeenAt || 0) - (left[1]?.lastSeenAt || 0))
    .slice(0, MAX_CURSOR_FILES));
}

function normalizedUnresolvedEvent(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (!Object.keys(value).every((key) => UNRESOLVED_EVENT_KEYS.has(key))) return null;
  if (typeof value.eventId !== "string" || !/^[a-f0-9]{64}$/.test(value.eventId)) return null;
  if (typeof value.occurredAt !== "string"
    || value.occurredAt.length > 40
    || !Number.isFinite(Date.parse(value.occurredAt))) return null;
  if (!new Set(["codex", "claude", "kimi"]).has(value.provider)) return null;
  if (typeof value.sourceModelId !== "string" || !SOURCE_MODEL_PATTERN.test(value.sourceModelId)) return null;
  if (!["standard", "fast"].includes(value.serviceMode)) return null;
  if (!new Set(["codex", "claude_code", "kimi_code"]).has(value.surface)) return null;
  for (const key of ["inputTokens", "cachedInputTokens", "outputTokens"]) {
    if (typeof value[key] !== "string" || !TOKEN_COUNT_PATTERN.test(value[key])) return null;
  }
  if (value.reasoningTokens !== undefined
    && (typeof value.reasoningTokens !== "string" || !TOKEN_COUNT_PATTERN.test(value.reasoningTokens))) {
    return null;
  }
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => UNRESOLVED_EVENT_KEYS.has(key))
  );
}

export function initialState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    paused: false,
    paired: false,
    deviceId: null,
    nextSequence: 1,
    previousRequestDigest: "",
    pendingRequest: null,
    // These are privacy-minimal observation identities, never raw provider
    // responses. They are advanced only after the signed heartbeat echoes the
    // exact submitted observations back to us.
    heartbeatObservationSnapshots: { version: 1, plans: {}, resetWindows: {} },
    pendingPair: null,
    syncOutbox: null,
    quarantinedEventIds: [],
    migrationExcludedEvents: [],
    unresolvedEvents: [],
    unresolvedOverflow: { totalDropped: 0, lastOverflowAt: null },
    rawOnlyBackfill: { version: 1, pendingProviders: [], partialCoverage: {}, completedAt: null },
    providerEvidenceHashes: {},
    codexCheckpointSnapshot: initialCodexSnapshot(),
    cursors: {
      codex: { accountingVersion: CODEX_ACCOUNTING_VERSION, files: {}, sessions: {} },
      claude: { accountingVersion: CLAUDE_ACCOUNTING_VERSION, seen: {} },
      kimi: { accountingVersion: KIMI_ACCOUNTING_VERSION, files: {} },
      antigravity: { accountingVersion: ANTIGRAVITY_ACCOUNTING_VERSION, files: {} },
      aggregate: initialAggregateCursors()
    },
    lastSyncAt: null,
    lastHeartbeatAt: null,
    lastScan: null
  };
}

export function initialConfig() {
  return {
    schemaVersion: SCHEMA_VERSION,
    endpoint: null,
    allowedPlatforms: [],
    supportedProviders: [],
    // Desktop collection is read-only. This separate consent is required
    // before TAG may modify Antigravity CLI settings for the optional
    // statusLine fallback.
    antigravityStatuslineConsent: false,
    transcriptFallbacks: {
      codex: false,
      claude: false,
      kimi: false
    }
  };
}

async function readJson(filePath, fallback) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return { ...fallback(), ...JSON.parse(text) };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return fallback();
    }
    throw error;
  }
}

export async function loadRuntime(paths) {
  const [state, config] = await Promise.all([
    readJson(paths.state, initialState),
    readJson(paths.config, initialConfig)
  ]);
  state.cursors = state.cursors || initialState().cursors;
  const requiresRawOnlyBackfill = state.cursors.codex?.accountingVersion !== CODEX_ACCOUNTING_VERSION
    || state.cursors.claude?.accountingVersion !== CLAUDE_ACCOUNTING_VERSION
    || state.cursors.kimi?.accountingVersion !== KIMI_ACCOUNTING_VERSION
    || state.cursors.antigravity?.accountingVersion !== ANTIGRAVITY_ACCOUNTING_VERSION
    || state.cursors.aggregate?.version !== AGGREGATE_CURSOR_VERSION;
  state.providerEvidenceHashes = state.providerEvidenceHashes || {};
  state.codexCheckpointSnapshot = normalizeCodexCheckpointSnapshot(state.codexCheckpointSnapshot);
  state.cursors.codex = state.cursors.codex || { accountingVersion: CODEX_ACCOUNTING_VERSION, files: {}, sessions: {} };
  state.cursors.codex.files = state.cursors.codex.files
    && typeof state.cursors.codex.files === "object"
    && !Array.isArray(state.cursors.codex.files)
    ? state.cursors.codex.files
    : {};
  state.cursors.codex.sessions = normalizedCodexSessions(state.cursors.codex.sessions);
  state.cursors.claude = state.cursors.claude || { seen: {} };
  state.cursors.kimi = state.cursors.kimi || { accountingVersion: KIMI_ACCOUNTING_VERSION, files: {} };
  state.cursors.antigravity = state.cursors.antigravity || { accountingVersion: ANTIGRAVITY_ACCOUNTING_VERSION, files: {} };
  state.cursors.aggregate = normalizedAggregateCursors(state.cursors.aggregate);
  if (state.cursors.codex.accountingVersion !== CODEX_ACCOUNTING_VERSION) {
    // v5 performs one stable-ID rescan so usage withheld by the retired
    // unresolved-model/mode queue is uploaded as raw-only instead of lost.
    state.cursors.codex = { accountingVersion: CODEX_ACCOUNTING_VERSION, files: {}, sessions: {} };
    state.cursors.aggregate.providers.codex.through = null;
    delete state.providerEvidenceHashes.codex;
  } else {
    state.cursors.codex.accountingVersion = CODEX_ACCOUNTING_VERSION;
  }
  if (state.cursors.claude.accountingVersion !== CLAUDE_ACCOUNTING_VERSION) {
    state.cursors.claude = { accountingVersion: CLAUDE_ACCOUNTING_VERSION, seen: {} };
    state.cursors.aggregate.providers.claude.through = null;
    delete state.providerEvidenceHashes.claude;
  } else {
    state.cursors.claude.accountingVersion = CLAUDE_ACCOUNTING_VERSION;
    state.cursors.claude.seen = state.cursors.claude.seen
      && typeof state.cursors.claude.seen === "object"
      && !Array.isArray(state.cursors.claude.seen)
      ? state.cursors.claude.seen
      : {};
  }
  if (state.cursors.kimi.accountingVersion !== KIMI_ACCOUNTING_VERSION) {
    state.cursors.kimi = { accountingVersion: KIMI_ACCOUNTING_VERSION, files: {} };
    state.cursors.aggregate.providers.kimi.through = null;
  } else {
    state.cursors.kimi.accountingVersion = KIMI_ACCOUNTING_VERSION;
    state.cursors.kimi.files = state.cursors.kimi.files
      && typeof state.cursors.kimi.files === "object"
      && !Array.isArray(state.cursors.kimi.files)
      ? state.cursors.kimi.files
      : {};
  }
  if (state.cursors.antigravity.accountingVersion !== ANTIGRAVITY_ACCOUNTING_VERSION) {
    state.cursors.antigravity = { accountingVersion: ANTIGRAVITY_ACCOUNTING_VERSION, files: {} };
    state.cursors.aggregate.providers.gemini.through = null;
  } else {
    state.cursors.antigravity.accountingVersion = ANTIGRAVITY_ACCOUNTING_VERSION;
    state.cursors.antigravity.files = normalizedAntigravityFiles(state.cursors.antigravity.files);
  }
  const configuredFallbacks = config.transcriptFallbacks || {};
  config.antigravityStatuslineConsent = config.antigravityStatuslineConsent === true;
  config.transcriptFallbacks = {
    codex: Boolean(configuredFallbacks.codex),
    claude: Boolean(configuredFallbacks.claude),
    kimi: Boolean(configuredFallbacks.kimi),
    ...(Object.hasOwn(configuredFallbacks, "gemini") ? { gemini: Boolean(configuredFallbacks.gemini) } : {}),
    ...(Object.hasOwn(configuredFallbacks, "grok") ? { grok: Boolean(configuredFallbacks.grok) } : {}),
    // DeepSeek has no local journal root. This flag is only a consent marker
    // for separately discovered host/API evidence.
    ...(Object.hasOwn(configuredFallbacks, "deepseek") ? { deepseek: Boolean(configuredFallbacks.deepseek) } : {})
  };
  const snapshots = state.heartbeatObservationSnapshots;
  state.heartbeatObservationSnapshots = {
    version: 1,
    plans: snapshots?.plans && typeof snapshots.plans === "object" && !Array.isArray(snapshots.plans)
      ? Object.fromEntries(Object.entries(snapshots.plans)
          .filter(([key, value]) => /^[a-z]+:[a-z_]+$/.test(key)
            && typeof value?.rawPlanCode === "string"
            && /^[a-z0-9]+(?:[_-][a-z0-9]+)*$/.test(value.rawPlanCode))
          .map(([key, value]) => [key, {
            rawPlanCode: value.rawPlanCode,
            ...(typeof value.accountAlias === "string" && /^[a-f0-9]{64}$/.test(value.accountAlias)
              ? { accountAlias: value.accountAlias }
              : {})
          }]))
      : {},
    resetWindows: snapshots?.resetWindows && typeof snapshots.resetWindows === "object" && !Array.isArray(snapshots.resetWindows)
      ? Object.fromEntries(Object.entries(snapshots.resetWindows)
          .filter(([key, value]) => /^[a-z]+:[a-z_]+:[a-z]+$/.test(key)
            && typeof value?.resetAt === "string"
            && Number.isFinite(Date.parse(value.resetAt)))
          .map(([key, value]) => [key, {
            resetAt: new Date(value.resetAt).toISOString(),
            ...(typeof value.usedPercent === "number"
              && Number.isFinite(value.usedPercent)
              && value.usedPercent >= 0
              && value.usedPercent <= 100
              ? { usedPercent: value.usedPercent }
              : {})
          }]))
      : {}
  };
  config.allowedPlatforms = Array.isArray(config.allowedPlatforms) ? config.allowedPlatforms : [];
  config.supportedProviders = Array.isArray(config.supportedProviders) ? config.supportedProviders : [];
  const priorBackfillProviders = Array.isArray(state.rawOnlyBackfill?.pendingProviders)
    ? state.rawOnlyBackfill.pendingProviders.filter((provider) => AGGREGATE_PROVIDERS.includes(provider))
    : [];
  const priorPartialCoverage = state.rawOnlyBackfill?.partialCoverage
    && typeof state.rawOnlyBackfill.partialCoverage === "object"
    && !Array.isArray(state.rawOnlyBackfill.partialCoverage)
    ? Object.fromEntries(Object.entries(state.rawOnlyBackfill.partialCoverage)
        .filter(([provider, value]) => AGGREGATE_PROVIDERS.includes(provider)
          && Number.isSafeInteger(value?.parseLosses)
          && value.parseLosses > 0)
        .map(([provider, value]) => [provider, {
          parseLosses: value.parseLosses,
          lastObservedAt: typeof value.lastObservedAt === "string"
            && Number.isFinite(Date.parse(value.lastObservedAt))
            ? new Date(value.lastObservedAt).toISOString()
            : null
        }]))
    : {};
  const migrationProviders = requiresRawOnlyBackfill
    ? AGGREGATE_PROVIDERS.filter((provider) => config.transcriptFallbacks[provider])
    : [];
  const queuedProviders = (Array.isArray(state.unresolvedEvents) ? state.unresolvedEvents : [])
    .map((event) => event?.provider)
    .filter((provider) => AGGREGATE_PROVIDERS.includes(provider));
  const legacyOverflowProviders = requiresRawOnlyBackfill
    && Number.isSafeInteger(state.unresolvedOverflow?.totalDropped)
    && state.unresolvedOverflow.totalDropped > 0
    ? AGGREGATE_PROVIDERS.filter((provider) =>
        config.allowedPlatforms.includes(provider)
        && config.supportedProviders.includes(provider)
      )
    : [];
  state.rawOnlyBackfill = {
    version: 1,
    pendingProviders: [...new Set([
      ...priorBackfillProviders,
      ...Object.keys(priorPartialCoverage),
      ...migrationProviders,
      ...queuedProviders,
      ...legacyOverflowProviders
    ])],
    partialCoverage: priorPartialCoverage,
    completedAt: typeof state.rawOnlyBackfill?.completedAt === "string"
      && Number.isFinite(Date.parse(state.rawOnlyBackfill.completedAt))
      ? new Date(state.rawOnlyBackfill.completedAt).toISOString()
      : null
  };
  // Pre-release builds briefly stored this account-scoped secret in config.json.
  // Never trust or migrate it from that lower-assurance location; a re-pair is explicit and safe.
  delete config.dedupNamespaceKey;
  if (!Number.isSafeInteger(state.nextSequence) || state.nextSequence < 1) {
    state.nextSequence = 1;
  }
  if (typeof state.previousRequestDigest !== "string") {
    state.previousRequestDigest = "";
  }
  state.quarantinedEventIds = Array.isArray(state.quarantinedEventIds) ? state.quarantinedEventIds : [];
  state.migrationExcludedEvents = (Array.isArray(state.migrationExcludedEvents)
    ? state.migrationExcludedEvents
    : [])
    .filter((event) => event
      && typeof event.eventId === "string"
      && /^[a-f0-9]{64}$/.test(event.eventId)
      && typeof event.occurredAt === "string"
      && Number.isFinite(Date.parse(event.occurredAt)))
    .slice(-MAX_MIGRATION_EXCLUSIONS)
    .map((event) => ({ eventId: event.eventId, occurredAt: new Date(event.occurredAt).toISOString() }));
  const validUnresolvedEvents = (Array.isArray(state.unresolvedEvents) ? state.unresolvedEvents : [])
    .map(normalizedUnresolvedEvent)
    .filter(Boolean);
  const loadOverflow = Math.max(0, validUnresolvedEvents.length - MAX_UNRESOLVED_EVENTS);
  state.unresolvedEvents = validUnresolvedEvents.slice(0, MAX_UNRESOLVED_EVENTS);
  state.unresolvedOverflow = {
    totalDropped: Number.isSafeInteger(state.unresolvedOverflow?.totalDropped)
      && state.unresolvedOverflow.totalDropped >= 0
      ? state.unresolvedOverflow.totalDropped + loadOverflow
      : loadOverflow,
    lastOverflowAt: typeof state.unresolvedOverflow?.lastOverflowAt === "string"
      ? state.unresolvedOverflow.lastOverflowAt
      : null
  };
  return { state, config };
}

export async function loadSecrets(paths) {
  return readJson(paths.secrets, () => null);
}

export async function loadPendingSecrets(paths) {
  return readJson(paths.pendingSecrets, () => null);
}

export async function ensureRuntimeDirectory(paths) {
  await fs.mkdir(paths.home, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    await fs.chmod(paths.home, 0o700);
  }
}

async function atomicRenameWithBoundedWindowsRetry(temporary, filePath, options) {
  const maximum = options.platform === "win32" ? 5 : 1;
  for (let attempt = 1; attempt <= maximum; attempt += 1) {
    try {
      await options.rename(temporary, filePath);
      return;
    } catch (error) {
      const retryableWindowsReplacement = options.platform === "win32"
        && (error?.code === "EEXIST" || error?.code === "EPERM");
      if (!retryableWindowsReplacement || attempt === maximum) throw error;
      await options.sleep(10 * attempt);
    }
  }
}

export async function atomicWriteJson(filePath, value, mode = 0o600, options = {}) {
  const platform = options.platform || process.platform;
  const rename = options.rename || fs.rename;
  const sleep = options.sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(filePath), "." + path.basename(filePath) + "." + process.pid + "." + randomBytes(6).toString("hex") + ".tmp");
  try {
    await fs.writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", mode, flag: "wx" });
    if (platform !== "win32") {
      await fs.chmod(temporary, mode);
    }
    // Node's rename is the atomic replacement primitive. Windows contention is
    // retried without unlinking the destination; exhaustion fails closed and
    // preserves the last committed file.
    await atomicRenameWithBoundedWindowsRetry(temporary, filePath, { platform, rename, sleep });
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  if (platform !== "win32") {
    await fs.chmod(filePath, mode);
  }
}

export async function saveRuntime(paths, { state, config }, options = {}) {
  await ensureRuntimeDirectory(paths);
  const writeJson = options.atomicWriteJson || atomicWriteJson;
  // Config commits first and state commits last. A state file can therefore
  // never durably reference data whose paired config write failed in parallel.
  await writeJson(paths.config, config);
  await writeJson(paths.state, state);
}

export async function saveSecrets(paths, secrets) {
  await ensureRuntimeDirectory(paths);
  await atomicWriteJson(paths.secrets, secrets, 0o600);
}

export async function savePendingSecrets(paths, secrets) {
  await ensureRuntimeDirectory(paths);
  await atomicWriteJson(paths.pendingSecrets, secrets, 0o600);
}

export async function removePendingSecrets(paths) {
  await fs.rm(paths.pendingSecrets, { force: true });
}
