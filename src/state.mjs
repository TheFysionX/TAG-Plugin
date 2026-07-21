import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { MAX_MIGRATION_EXCLUSIONS, MAX_UNRESOLVED_EVENTS, SCHEMA_VERSION } from "./constants.mjs";

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
const AGGREGATE_PROVIDERS = ["codex", "claude", "kimi"];

function initialAggregateCursors() {
  return {
    version: 2,
    providers: Object.fromEntries(AGGREGATE_PROVIDERS.map((provider) => [provider, { through: null }]))
  };
}

function normalizedAggregateCursors(value) {
  if (value?.version !== 2 || !value.providers || typeof value.providers !== "object") {
    return initialAggregateCursors();
  }
  return {
    version: 2,
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
    pendingPair: null,
    syncOutbox: null,
    quarantinedEventIds: [],
    migrationExcludedEvents: [],
    unresolvedEvents: [],
    unresolvedOverflow: { totalDropped: 0, lastOverflowAt: null },
    providerEvidenceHashes: {},
    cursors: {
      codex: { files: {} },
      claude: { seen: {} },
      kimi: { files: {} },
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
  state.providerEvidenceHashes = state.providerEvidenceHashes || {};
  state.cursors.codex = state.cursors.codex || { files: {} };
  state.cursors.claude = state.cursors.claude || { seen: {} };
  state.cursors.kimi = state.cursors.kimi || { files: {} };
  state.cursors.aggregate = normalizedAggregateCursors(state.cursors.aggregate);
  config.transcriptFallbacks = {
    codex: Boolean(config.transcriptFallbacks?.codex),
    claude: Boolean(config.transcriptFallbacks?.claude),
    kimi: Boolean(config.transcriptFallbacks?.kimi)
  };
  config.allowedPlatforms = Array.isArray(config.allowedPlatforms) ? config.allowedPlatforms : [];
  config.supportedProviders = Array.isArray(config.supportedProviders) ? config.supportedProviders : [];
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

export async function atomicWriteJson(filePath, value, mode = 0o600) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(filePath), "." + path.basename(filePath) + "." + process.pid + "." + randomBytes(6).toString("hex") + ".tmp");
  await fs.writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", mode, flag: "wx" });
  if (process.platform !== "win32") {
    await fs.chmod(temporary, mode);
  }
  try {
    await fs.rename(temporary, filePath);
  } catch (error) {
    if (process.platform !== "win32" || (error?.code !== "EEXIST" && error?.code !== "EPERM")) {
      throw error;
    }
    await fs.rm(filePath, { force: true });
    await fs.rename(temporary, filePath);
  }
  if (process.platform !== "win32") {
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
