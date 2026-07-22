import {
  ANTIGRAVITY_ACCOUNTING_VERSION,
  CLAUDE_ACCOUNTING_VERSION,
  CODEX_ACCOUNTING_VERSION,
  GROK_BUILD_ACCOUNTING_VERSION,
  KIMI_ACCOUNTING_VERSION,
  MAX_CLAUDE_SEEN_EVENTS,
  MAX_CODEX_LOGICAL_SESSIONS,
  MAX_CURSOR_FILES
} from "./constants.mjs";
import { accountScopedEventId, hmacAlias, payloadHash, sha256 } from "./crypto.mjs";
import { discoverJsonlFiles } from "./discovery.mjs";
import { codexRolloutSortKey, parseCodexRollout } from "./adapters/codex-rollout.mjs";
import { chooseClaudeSnapshot, parseClaudeProject } from "./adapters/claude-project.mjs";
import { readCodexAccountUsage } from "./adapters/codex-account-usage.mjs";
import path from "node:path";
import { parseKimiWire } from "./adapters/kimi-wire.mjs";
import { parseAntigravityStatuslineLog } from "./adapters/antigravity-statusline.mjs";
import {
  detectAntigravityDesktopVersion,
  discoverAntigravityDesktopDatabases,
  parseAntigravityDesktopDatabase
} from "./adapters/antigravity-desktop.mjs";
import { discoverGrokSignalFiles, parseGrokBuildSession } from "./adapters/grok-build-sessions.mjs";

const AGGREGATE_USAGE_FIELDS = ["input", "cachedInput", "cacheWriteInput", "output", "reasoningOutput"];
const WIRE_RAW_USAGE_FIELDS = ["inputTokens", "cachedInputTokens", "cacheWriteInputTokens", "outputTokens"];
const LOGICAL_AGGREGATE_IDENTITY_SCHEMA = Object.freeze({
  codex: "session-hour-aggregate-v4",
  claude: "session-hour-aggregate-v4",
  gemini: "session-hour-aggregate-v2",
  grok: "session-hour-aggregate-v1",
  kimi: "session-hour-aggregate-v3",
  deepseek: "session-hour-aggregate-v1"
});
const AGGREGATE_COLLECTOR_GENERATION = Object.freeze({ codex: 4, claude: 4, gemini: 2, grok: 1, kimi: 3, deepseek: 1 });
const HOST_PROVIDER_BY_SURFACE = Object.freeze({
  codex: "codex",
  claude_code: "claude",
  kimi_code: "kimi",
  antigravity: "gemini",
  grok_build: "grok"
});

function serviceProviderForEvent(event) {
  const inferred = HOST_PROVIDER_BY_SURFACE[event?.provenance?.surface];
  if (!inferred) return null;
  return event?.serviceProviderId === undefined || event.serviceProviderId === inferred
    ? inferred
    : null;
}

export function hasRawTokenUsage(event) {
  let total = 0n;
  for (const field of WIRE_RAW_USAGE_FIELDS) {
    const value = event?.[field] ?? "0";
    if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,15})$/.test(value)) return false;
    total += BigInt(value);
  }
  return total > 0n;
}

function modeLabel(event) {
  if (event?.mode?.classified === false) return "unclassified";
  return event?.mode?.fast ? "fast" : "standard";
}

function createHourlyAggregator(options) {
  const ranges = Object.fromEntries(Object.entries(options.ranges || {}).map(([provider, range]) => [
    provider,
    { startMs: Date.parse(range.start), endMs: Date.parse(range.end) }
  ]));
  const excludedEventIds = options.excludedEventIds || new Set();
  const groups = new Map();
  const passthrough = [];
  const seenSourceEventIds = new Set();
  let excluded = 0;
  let duplicateSources = 0;
  let beforeWindow = 0;
  let afterWindow = 0;

  const add = (event) => {
    if (excludedEventIds.has(event.eventId)) {
      excluded += 1;
      return;
    }
    const serviceProviderId = serviceProviderForEvent(event);
    const range = serviceProviderId ? ranges[serviceProviderId] : null;
    if (!range) return;
    const observedAtMs = Date.parse(event.observedAt || "");
    if (!Number.isFinite(observedAtMs)) {
      passthrough.push(event);
      return;
    }
    if (observedAtMs < range.startMs) {
      beforeWindow += 1;
      return;
    }
    if (observedAtMs >= range.endMs) {
      afterWindow += 1;
      return;
    }
    if (seenSourceEventIds.has(event.eventId)) {
      duplicateSources += 1;
      return;
    }
    seenSourceEventIds.add(event.eventId);
    // Preserve provider/component disagreements as individual raw-only
    // observations. Grouping would erase the disagreement and could make the
    // model components scoreable again.
    if (event.usage?.componentConflict === true) {
      passthrough.push(event);
      return;
    }
    if (!event.modelId && !event.sourceModelId) {
      passthrough.push(event);
      return;
    }
    const hourStartMs = Math.floor(observedAtMs / (60 * 60 * 1_000)) * 60 * 60 * 1_000;
    const surface = event.provenance.surface;
    const aggregationScope = event.aggregationScope
      || sha256("per-source-aggregate-scope\0" + event.eventId);
    const rawModelToken = event.sourceModelId || "unknown";
    const rawModeToken = event.aggregationModeToken
      || sha256("normalized-mode-fallback\0" + modeLabel(event));
    // The wire collector version is provenance, not logical identity. Keep the
    // released v3 Kimi and v4 Codex/Claude identity domains stable while parser,
    // accounting, canonical-model, and raw/attributed projections evolve.
    const logicalIdentitySchema = LOGICAL_AGGREGATE_IDENTITY_SCHEMA[event.provider];
    const aggregateVersion = AGGREGATE_COLLECTOR_GENERATION[event.provider];
    const key = payloadHash({
      schema: logicalIdentitySchema,
      hour: new Date(hourStartMs).toISOString(),
      provider: event.provider,
      aggregationScope,
      rawModelToken,
      rawModeToken,
      surface
    });
    const group = groups.get(key) || {
      hourStartMs,
      provider: event.provider,
      serviceProviderId,
      modelId: event.modelId,
      sourceModelId: rawModelToken,
      mode: modeLabel(event),
      aggregateVersion,
      surface,
      usage: Object.fromEntries(AGGREGATE_USAGE_FIELDS.map((field) => [field, 0n]))
    };
    for (const field of AGGREGATE_USAGE_FIELDS) {
      group.usage[field] += BigInt(event.usage[field] || 0);
    }
    groups.set(key, group);
  };

  const finish = () => {
    const events = [...passthrough];
    for (const [key, group] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const usage = Object.fromEntries(AGGREGATE_USAGE_FIELDS.map((field) => [
        field,
        Number(group.usage[field])
      ]));
      usage.total = usage.input + usage.cachedInput + usage.cacheWriteInput + usage.output;
      events.push({
        eventId: accountScopedEventId(options.dedupNamespaceKey, group.provider, key),
        provider: group.provider,
        serviceProviderId: group.serviceProviderId,
        modelId: group.modelId,
        sourceModelId: group.sourceModelId,
        observedAt: new Date(group.hourStartMs + 30 * 60 * 1_000).toISOString(),
        mode: {
          fast: group.mode === "fast",
          classified: group.mode !== "unclassified",
          serviceTier: null,
          speed: null
        },
        usage,
        provenance: {
          collector: `session_hour_usage_aggregate_v${group.aggregateVersion}`,
          verification: "connector_attested",
          surface: group.surface
        }
      });
    }
    return {
      events,
      groups: groups.size,
      excluded,
      duplicateSources,
      beforeWindow,
      afterWindow
    };
  };

  return { add, finish };
}

function newestEntries(object, maximum, scoreKey) {
  const entries = Object.entries(object);
  if (entries.length <= maximum) {
    return object;
  }
  entries.sort((a, b) => (b[1]?.[scoreKey] || 0) - (a[1]?.[scoreKey] || 0));
  return Object.fromEntries(entries.slice(0, maximum));
}

function boundedSeen(events, previousSeen) {
  const next = {};
  for (const event of events.slice(-MAX_CLAUDE_SEEN_EVENTS)) {
    next[event.eventId] = {
      hash: payloadHash(event),
      lastSeenAt: Date.now()
    };
  }
  if (events.length < MAX_CLAUDE_SEEN_EVENTS) {
    for (const [eventId, entry] of Object.entries(previousSeen || {})) {
      if (!(eventId in next)) {
        next[eventId] = entry;
      }
    }
  }
  return newestEntries(next, MAX_CLAUDE_SEEN_EVENTS, "lastSeenAt");
}

function finalizeProviderCoverage(result, provider) {
  const scan = result.providerScans[provider];
  const stats = result.stats[provider];
  if (!scan || !stats) return;
  const parseLosses = Number.isSafeInteger(stats.malformed) ? stats.malformed : 0;
  scan.parseLosses = parseLosses;
  scan.progressComplete = Boolean(scan.discoveryComplete && !stats.pending);
  scan.complete = Boolean(scan.progressComplete && parseLosses === 0 && !scan.forcePartial);
  scan.coverage = !scan.enabled
    ? "disabled"
    : (scan.complete ? "complete" : "partial");
  if (scan.forcePartial && scan.progressComplete && parseLosses === 0) {
    scan.reason = scan.forcePartialReason || "prospective_only";
  } else if (scan.discoveryComplete && stats.pending) {
    scan.reason = "event_limit";
  } else if (scan.progressComplete && parseLosses > 0) {
    scan.reason = "parse_loss";
    stats.status = "partial";
  }
  stats.coverage = scan.coverage;
  stats.parseLosses = parseLosses;
}

// The active rate card is frozen each Sunday. It deliberately contains no
  // Gemini 3.6 rates, so publishing it as attributed would fabricate R-token
// attributed would fabricate R-token value. Keep their measured raw usage,
// but make the wire contract unambiguously raw-only until a future card adds
// those entries.
function freezeUnsupportedGeminiRateCard(event) {
  if (event?.serviceProviderId !== "gemini" || event?.provenance?.surface !== "antigravity") return event;
  const source = typeof event.sourceModelId === "string" ? event.sourceModelId : "";
  const unsupported = source.startsWith("gemini-3.6-");
  if (!unsupported) return event;
  return {
    ...event,
    modelId: null,
    mode: { serviceTier: null, speed: null, fast: false, classified: false },
    provenance: { ...event.provenance, rateCard: "raw_only_unscored" }
  };
}

export async function collectUsage(options) {
  const { roots, state, secrets } = options;
  const now = options.now ?? Date.now();
  const dedupNamespaceKey = options.dedupNamespaceKey;
  const maximumEventsPerProvider = Number.isSafeInteger(options.maximumEventsPerProvider)
    && options.maximumEventsPerProvider >= 0
    ? options.maximumEventsPerProvider
    : Number.POSITIVE_INFINITY;
  const aggregateRanges = options.aggregateRanges || null;
  const aggregator = aggregateRanges
    ? createHourlyAggregator({
        ranges: aggregateRanges,
        dedupNamespaceKey,
        excludedEventIds: new Set(options.excludedEventIds || [])
      })
    : null;
  const nextCursors = structuredClone(state.cursors || {
    codex: { accountingVersion: CODEX_ACCOUNTING_VERSION, files: {}, sessions: {} },
    claude: { accountingVersion: CLAUDE_ACCOUNTING_VERSION, seen: {} },
    kimi: { accountingVersion: KIMI_ACCOUNTING_VERSION, files: {} },
    antigravity: { accountingVersion: ANTIGRAVITY_ACCOUNTING_VERSION, files: {} },
    grok: { accountingVersion: GROK_BUILD_ACCOUNTING_VERSION, sessions: {} }
  });
  nextCursors.codex = nextCursors.codex || { accountingVersion: CODEX_ACCOUNTING_VERSION, files: {}, sessions: {} };
  nextCursors.codex.accountingVersion = CODEX_ACCOUNTING_VERSION;
  nextCursors.codex.files = nextCursors.codex.files || {};
  nextCursors.codex.sessions = nextCursors.codex.sessions || {};
  nextCursors.claude = nextCursors.claude || { accountingVersion: CLAUDE_ACCOUNTING_VERSION, seen: {} };
  nextCursors.claude.accountingVersion = CLAUDE_ACCOUNTING_VERSION;
  nextCursors.claude.seen = nextCursors.claude.seen || {};
  nextCursors.kimi = nextCursors.kimi || { accountingVersion: KIMI_ACCOUNTING_VERSION, files: {} };
  nextCursors.kimi.accountingVersion = KIMI_ACCOUNTING_VERSION;
  nextCursors.kimi.files = nextCursors.kimi.files || {};
  nextCursors.antigravity = nextCursors.antigravity || { accountingVersion: ANTIGRAVITY_ACCOUNTING_VERSION };
  nextCursors.antigravity.accountingVersion = ANTIGRAVITY_ACCOUNTING_VERSION;
  nextCursors.antigravity.files = nextCursors.antigravity.files || {};
  nextCursors.grok = nextCursors.grok || { accountingVersion: GROK_BUILD_ACCOUNTING_VERSION, sessions: {} };
  nextCursors.grok.accountingVersion = GROK_BUILD_ACCOUNTING_VERSION;
  nextCursors.grok.sessions = nextCursors.grok.sessions || {};
  const result = {
    events: [],
    providerEvidence: {},
    providerObservations: [],
    resetObservations: [],
    providerScans: {},
    nextCursors,
    stats: {
      codex: { files: 0, events: 0, pending: false, malformed: 0, duplicateSnapshots: 0, cumulativeResets: 0, cumulativeMismatches: 0, inheritedSnapshots: 0, ambiguousLineage: 0, unclassifiedModes: 0, unavailable: false, collector: "local_log_fallback" },
      claude: { files: 0, events: 0, pending: false, malformed: 0, unavailable: false, collector: "local_log_fallback" },
      gemini: { files: 0, events: 0, pending: false, malformed: 0, unavailable: false, collector: "antigravity_desktop_sqlite_v1", historicalCompleteness: "retained_completed_metadata_only" },
      kimi: { files: 0, events: 0, pending: false, malformed: 0, unavailable: false, collector: "kimi_v0_28_wire_usage_record_fallback" },
      grok: { status: "opt_in_required", collector: "grok_build_local_session_summary", historicalCompleteness: "none", accounting: "informational_only" }
    }
  };

  const codexOfficialEnabled = options.officialEvidence === true
    || (options.officialEvidence !== false && options.enabledProviders?.codex === true);
  if (codexOfficialEnabled) {
    const readOfficialUsage = options.readCodexAccountUsage || readCodexAccountUsage;
    result.providerEvidence.codex = await readOfficialUsage(options.codexAccountUsageOptions);
  } else {
    result.providerEvidence.codex = { status: "not_queried" };
  }

  const enabledFallbacks = options.enabledFallbacks || { codex: false, claude: false, kimi: false, gemini: false, grok: false };
  const discover = options.discoverJsonlFiles || discoverJsonlFiles;
  const codexDiscovery = enabledFallbacks.codex
    ? await discover(roots.codex)
    : { files: [], unavailable: false, truncated: false };
  result.stats.codex.files = codexDiscovery.files.length;
  result.stats.codex.unavailable = codexDiscovery.unavailable;
  result.stats.codex.truncated = codexDiscovery.truncated;
  result.providerScans.codex = {
    enabled: Boolean(enabledFallbacks.codex),
    discoveryComplete: Boolean(enabledFallbacks.codex && !codexDiscovery.unavailable && !codexDiscovery.truncated),
    complete: Boolean(enabledFallbacks.codex && !codexDiscovery.unavailable && !codexDiscovery.truncated),
    reason: !enabledFallbacks.codex
      ? "disabled"
      : (codexDiscovery.unavailable ? "unavailable" : (codexDiscovery.truncated ? "truncated" : "complete")),
    range: aggregateRanges?.codex || null
  };
  if (!enabledFallbacks.codex) {
    result.stats.codex.status = "opt_in_required";
  } else if (codexDiscovery.unavailable || codexDiscovery.truncated) {
    result.stats.codex.status = codexDiscovery.unavailable ? "unavailable" : "truncated";
    result.stats.codex.pending = true;
  }
  const codexFiles = result.providerScans.codex.complete
    ? (await Promise.all(codexDiscovery.files.map(async (filePath) => ({
        filePath,
        sortKey: await codexRolloutSortKey(filePath)
      }))))
        .sort((a, b) => a.sortKey.localeCompare(b.sortKey) || a.filePath.localeCompare(b.filePath))
        .map((entry) => entry.filePath)
    : [];
  const codexRange = aggregateRanges?.codex || null;
  let remainingCodexEvents = maximumEventsPerProvider;
  for (const filePath of codexFiles) {
    if (!aggregator && remainingCodexEvents <= 0) {
      result.stats.codex.pending = true;
      break;
    }
    const fileAlias = hmacAlias(secrets.localAliasKey, "codex-file", filePath);
    const parsed = await parseCodexRollout(filePath, {
      aliasKey: secrets.localAliasKey,
      fileAlias,
      cursor: nextCursors.codex.files[fileAlias],
      logicalSessions: nextCursors.codex.sessions,
      dedupNamespaceKey,
      canonicalModelId: options.canonicalModelId,
      maximumEvents: aggregator ? undefined : remainingCodexEvents,
      minimumObservedAtInclusive: codexRange?.start,
      maximumObservedAtExclusive: codexRange?.end,
      onEvent: aggregator?.add,
      now
    });
    nextCursors.codex.files[fileAlias] = parsed.cursor;
    if (!aggregator) result.events.push(...parsed.events);
    result.stats.codex.events += parsed.eventCount ?? parsed.events.length;
    result.stats.codex.malformed += parsed.malformed;
    result.stats.codex.duplicateSnapshots += parsed.duplicateSnapshots;
    result.stats.codex.cumulativeResets += parsed.cumulativeResets;
    result.stats.codex.cumulativeMismatches += parsed.cumulativeMismatches;
    result.stats.codex.inheritedSnapshots += parsed.inheritedSnapshots || 0;
    result.stats.codex.ambiguousLineage += parsed.ambiguousLineage || 0;
    result.stats.codex.unclassifiedModes += parsed.unclassifiedModes || 0;
    remainingCodexEvents -= parsed.eventCount ?? parsed.events.length;
    if (!aggregator && parsed.reachedEventLimit) {
      result.stats.codex.pending = true;
      break;
    }
  }
  nextCursors.codex.files = newestEntries(nextCursors.codex.files, MAX_CURSOR_FILES, "lastSeenAt");
  nextCursors.codex.sessions = newestEntries(
    nextCursors.codex.sessions,
    MAX_CODEX_LOGICAL_SESSIONS,
    "lastSeenAt"
  );

  const claudeDiscovery = enabledFallbacks.claude
    ? await discover(roots.claude)
    : { files: [], unavailable: false, truncated: false };
  result.stats.claude.files = claudeDiscovery.files.length;
  result.stats.claude.unavailable = claudeDiscovery.unavailable;
  result.stats.claude.truncated = claudeDiscovery.truncated;
  result.providerScans.claude = {
    enabled: Boolean(enabledFallbacks.claude),
    discoveryComplete: Boolean(enabledFallbacks.claude && !claudeDiscovery.unavailable && !claudeDiscovery.truncated),
    complete: Boolean(enabledFallbacks.claude && !claudeDiscovery.unavailable && !claudeDiscovery.truncated),
    reason: !enabledFallbacks.claude
      ? "disabled"
      : (claudeDiscovery.unavailable ? "unavailable" : (claudeDiscovery.truncated ? "truncated" : "complete")),
    range: aggregateRanges?.claude || null
  };
  if (!enabledFallbacks.claude) {
    result.stats.claude.status = "opt_in_required";
  } else if (claudeDiscovery.unavailable || claudeDiscovery.truncated) {
    result.stats.claude.status = claudeDiscovery.unavailable ? "unavailable" : "truncated";
    result.stats.claude.pending = true;
  }
  const claudeFiles = result.providerScans.claude.complete ? claudeDiscovery.files : [];
  const claudeRange = aggregateRanges?.claude || null;
  const claudeByEventId = new Map();
  for (const filePath of claudeFiles) {
    const fileAlias = hmacAlias(secrets.localAliasKey, "claude-file", filePath);
    const parsed = await parseClaudeProject(filePath, {
      aliasKey: secrets.localAliasKey,
      fileAlias,
      dedupNamespaceKey,
      minimumObservedAtInclusive: claudeRange?.start,
      maximumObservedAtExclusive: claudeRange?.end
    });
    result.stats.claude.malformed += parsed.malformed;
    for (const event of parsed.events) {
      claudeByEventId.set(event.eventId, chooseClaudeSnapshot(claudeByEventId.get(event.eventId), event));
    }
  }
  const allClaudeEvents = [...claudeByEventId.values()].map((candidate) => {
    const event = { ...candidate };
    delete event._lineOrder;
    return event;
  });
  if (aggregator) {
    const priorSeen = nextCursors.claude.seen;
    const newClaudeEvents = allClaudeEvents.filter((event) => !priorSeen[event.eventId]);
    const readyClaudeEvents = newClaudeEvents;
    for (const event of readyClaudeEvents) aggregator.add(event);
    nextCursors.claude.seen = boundedSeen(readyClaudeEvents, priorSeen);
    result.stats.claude.events = readyClaudeEvents.length;
    result.stats.claude.pending = result.stats.claude.pending
      || readyClaudeEvents.length < newClaudeEvents.length;
  } else {
    const priorSeen = nextCursors.claude.seen;
    const changedClaudeEvents = allClaudeEvents.filter((event) => priorSeen[event.eventId]?.hash !== payloadHash(event));
    const selectedClaudeEvents = changedClaudeEvents.slice(0, maximumEventsPerProvider);
    nextCursors.claude.seen = boundedSeen(selectedClaudeEvents, priorSeen);
    result.events.push(...selectedClaudeEvents);
    result.stats.claude.events = selectedClaudeEvents.length;
    result.stats.claude.pending = result.stats.claude.pending
      || selectedClaudeEvents.length < changedClaudeEvents.length;
  }

  const kimiDiscovery = enabledFallbacks.kimi
    ? await discover(roots.kimi)
    : { files: [], unavailable: false, truncated: false };
  const kimiWireFiles = kimiDiscovery.files.filter((filePath) => path.basename(filePath).toLowerCase() === "wire.jsonl");
  result.stats.kimi.files = kimiWireFiles.length;
  result.stats.kimi.unavailable = kimiDiscovery.unavailable;
  result.stats.kimi.truncated = kimiDiscovery.truncated;
  result.providerScans.kimi = {
    enabled: Boolean(enabledFallbacks.kimi),
    discoveryComplete: Boolean(enabledFallbacks.kimi && !kimiDiscovery.unavailable && !kimiDiscovery.truncated),
    complete: Boolean(enabledFallbacks.kimi && !kimiDiscovery.unavailable && !kimiDiscovery.truncated),
    reason: !enabledFallbacks.kimi
      ? "disabled"
      : (kimiDiscovery.unavailable ? "unavailable" : (kimiDiscovery.truncated ? "truncated" : "complete")),
    range: aggregateRanges?.kimi || null
  };
  if (!enabledFallbacks.kimi) {
    result.stats.kimi.status = "opt_in_required";
  } else if (kimiDiscovery.unavailable || kimiDiscovery.truncated) {
    result.stats.kimi.status = kimiDiscovery.unavailable ? "unavailable" : "truncated";
    result.stats.kimi.pending = true;
  }
  const completeKimiFiles = result.providerScans.kimi.complete ? kimiWireFiles : [];
  const kimiRange = aggregateRanges?.kimi || null;
  let remainingKimiEvents = maximumEventsPerProvider;
  for (const filePath of completeKimiFiles) {
    if (!aggregator && remainingKimiEvents <= 0) {
      result.stats.kimi.pending = true;
      break;
    }
    const fileAlias = hmacAlias(secrets.localAliasKey, "kimi-file", filePath);
    const parsed = await parseKimiWire(filePath, {
      aliasKey: secrets.localAliasKey,
      fileAlias,
      stableJournalIdentity: (() => {
        const parts = filePath.split(path.sep);
        const agentsIndex = parts.lastIndexOf("agents");
        const sessionId = agentsIndex > 0 ? parts[agentsIndex - 1] : "unknown-session";
        const agentId = agentsIndex >= 0 && agentsIndex + 1 < parts.length ? parts[agentsIndex + 1] : "unknown-agent";
        return sha256("kimi-session-agent\0" + sessionId + "\0" + agentId);
      })(),
      dedupNamespaceKey,
      cursor: nextCursors.kimi.files[fileAlias],
      canonicalModelId: options.canonicalModelId,
      maximumEvents: aggregator ? undefined : remainingKimiEvents,
      minimumObservedAtInclusive: kimiRange?.start,
      maximumObservedAtExclusive: kimiRange?.end,
      onEvent: aggregator?.add,
      now
    });
    nextCursors.kimi.files[fileAlias] = parsed.cursor;
    if (!aggregator) result.events.push(...parsed.events);
    result.stats.kimi.events += parsed.eventCount ?? parsed.events.length;
    result.stats.kimi.malformed += parsed.malformed;
    remainingKimiEvents -= parsed.eventCount ?? parsed.events.length;
    if (!aggregator && parsed.reachedEventLimit) {
      result.stats.kimi.pending = true;
      break;
    }
  }
  nextCursors.kimi.files = newestEntries(nextCursors.kimi.files, MAX_CURSOR_FILES, "lastSeenAt");

  // Antigravity desktop exposes completed usage metadata in per-conversation
  // SQLite files. Its adapter reads only `steps(idx,status,metadata)`, never
  // prompt/response payloads. The old sanitized CLI status-line capture stays
  // supported as a separate prospective source.
  // Desktop collection is read-only and follows the account's Gemini/Antigravity
  // authorization. The optional CLI status-line source stays separately opt-in
  // and must not gate desktop collection.
  const antigravityDesktopEnabled = options.enabledProviders?.gemini === true;
  const antigravityStatuslineEnabled = enabledFallbacks.gemini === true || enabledFallbacks.antigravity === true;
  const antigravityEnabled = antigravityDesktopEnabled || antigravityStatuslineEnabled;
  const detectAntigravityVersion = options.detectAntigravityDesktopVersion || detectAntigravityDesktopVersion;
  const antigravityDesktopVersion = antigravityDesktopEnabled
    ? await detectAntigravityVersion(options.antigravityDesktopVersionOptions)
    : { status: "unavailable", version: null, reason: "disabled" };
  const findAntigravityDesktopDatabases = options.discoverAntigravityDesktopDatabases || discoverAntigravityDesktopDatabases;
  const antigravityDesktopDiscovery = antigravityDesktopEnabled
    && antigravityDesktopVersion.status === "supported"
    && typeof roots.antigravityDesktop === "string"
    ? await findAntigravityDesktopDatabases(roots.antigravityDesktop)
    : { status: "unavailable", reason: antigravityDesktopVersion.reason || "desktop_root_unavailable", truncated: false, files: [] };
  // The database discovery itself is bounded at MAX_CURSOR_FILES. At the
  // boundary, preserve correctness by declaring coverage partial rather than
  // claiming there cannot be another conversation file.
  const antigravityDesktopTruncated = Boolean(antigravityDesktopDiscovery.truncated);
  const antigravityDesktopUnavailable = antigravityDesktopDiscovery.status === "unavailable";
  result.providerScans.gemini = {
    enabled: antigravityEnabled,
    discoveryComplete: false,
    complete: false,
    reason: !antigravityEnabled
      ? "disabled"
      : (antigravityDesktopUnavailable ? "unavailable" : (antigravityDesktopTruncated ? "truncated" : "prospective_only")),
    range: aggregateRanges?.gemini || null,
    historicalCompleteness: "retained_completed_metadata_only"
  };
  if (antigravityEnabled) {
    const desktopRange = aggregateRanges?.gemini || null;
    const parseAntigravityDesktop = options.parseAntigravityDesktopDatabase || parseAntigravityDesktopDatabase;
    let remainingAntigravityEvents = maximumEventsPerProvider;
    let desktopCaptures = 0;
    let desktopParseUnavailable = false;
    for (const filePath of antigravityDesktopDiscovery.files) {
      if (!aggregator && remainingAntigravityEvents <= 0) {
        result.stats.gemini.pending = true;
        break;
      }
      const fileAlias = hmacAlias(secrets.localAliasKey, "antigravity-desktop-file", filePath);
      const capacity = remainingAntigravityEvents;
      const parsed = await parseAntigravityDesktop(filePath, {
        localAliasKey: secrets.localAliasKey,
        dedupNamespaceKey,
        canonicalModelId: options.canonicalModelId,
        desktopVersion: antigravityDesktopVersion.version,
        cursor: nextCursors.antigravity.files[fileAlias],
        maximumEvents: aggregator ? undefined : remainingAntigravityEvents,
        minimumObservedAtInclusive: desktopRange?.start,
        maximumObservedAtExclusive: desktopRange?.end
      });
      desktopParseUnavailable ||= parsed.status !== "available_version_pinned";
      nextCursors.antigravity.files[fileAlias] = { ...parsed.cursor, lastSeenAt: now };
      const events = parsed.events.map(freezeUnsupportedGeminiRateCard);
      if (aggregator) events.forEach((event) => aggregator.add(event));
      else result.events.push(...events);
      result.stats.gemini.files += 1;
      result.stats.gemini.events += events.length;
      result.stats.gemini.malformed += parsed.malformed || 0;
      desktopCaptures += parsed.captures || 0;
      remainingAntigravityEvents -= events.length;
      if (parsed.partial === true || parsed.status === "partial") result.stats.gemini.pending = true;
      if (!aggregator && events.length >= capacity && parsed.captures > events.length) {
        result.stats.gemini.pending = true;
        break;
      }
    }
    const statusline = antigravityStatuslineEnabled
      ? await parseAntigravityStatuslineLog(roots.antigravity, {
        dedupNamespaceKey,
        canonicalModelId: options.canonicalModelId
      })
      : { status: "unavailable", reason: "statusline_not_consented", events: [], planObservations: [], resetObservations: [], captures: 0, malformed: 0 };
    const allStatuslineEvents = statusline.events.map(freezeUnsupportedGeminiRateCard);
    const statuslineEvents = aggregator ? allStatuslineEvents : allStatuslineEvents.slice(0, remainingAntigravityEvents);
    if (aggregator) statuslineEvents.forEach((event) => aggregator.add(event));
    else result.events.push(...statuslineEvents);
    if (!aggregator && statuslineEvents.length < allStatuslineEvents.length) result.stats.gemini.pending = true;
    result.providerObservations.push(...statusline.planObservations);
    result.resetObservations.push(...statusline.resetObservations);
    const desktopSourceComplete = antigravityDesktopDiscovery.status === "available"
      && !antigravityDesktopTruncated
      && !desktopParseUnavailable;
    const statuslineSourceComplete = statusline.status === "available_prospective";
    result.providerScans.gemini.discoveryComplete = desktopSourceComplete || statuslineSourceComplete;
    result.providerScans.gemini.reason = result.providerScans.gemini.discoveryComplete
      ? "complete"
      : (antigravityDesktopTruncated
          ? "truncated"
          : (desktopParseUnavailable ? "unsupported_or_unreadable_schema" : (antigravityDesktopDiscovery.reason || statusline.reason)));
    result.stats.gemini = {
      ...result.stats.gemini,
      status: desktopSourceComplete
        ? "available_version_pinned"
        : (statuslineEvents.length > 0 ? "available_prospective" : statusline.status),
      reason: desktopSourceComplete || statuslineEvents.length > 0
        ? null
        : (antigravityDesktopDiscovery.reason || statusline.reason),
      captures: desktopCaptures + (statusline.captures || 0),
      events: result.stats.gemini.events + statuslineEvents.length,
      malformed: result.stats.gemini.malformed + (statusline.malformed || 0),
      collector: "antigravity_desktop_sqlite_v1",
      desktopVersion: antigravityDesktopVersion.version,
      historicalCompleteness: desktopSourceComplete ? "retained_completed_metadata_only" : "prospective_only"
    };
    nextCursors.antigravity.files = newestEntries(nextCursors.antigravity.files, MAX_CURSOR_FILES, "lastSeenAt");
  }

  // Grok Build's signals are intentionally surfaced only as a local usage
  // capability. They are context/session summaries, so no event can enter the
  // raw-token or scoring ledger from this source.
  const grokEnabled = enabledFallbacks.grok === true;
  const findGrokSignals = options.discoverGrokSignalFiles || discoverGrokSignalFiles;
  const grokDiscovery = grokEnabled
    ? await findGrokSignals(roots.grok)
    : { files: [], unavailable: false, truncated: false };
  result.providerScans.grok = {
    enabled: grokEnabled,
    discoveryComplete: Boolean(grokEnabled && !grokDiscovery.unavailable && !grokDiscovery.truncated),
    complete: false,
    reason: !grokEnabled ? "disabled" : (grokDiscovery.unavailable ? "unavailable" : (grokDiscovery.truncated ? "truncated" : "informational_session_summary_only")),
    historicalCompleteness: "none"
  };
  if (grokEnabled) {
    const sessions = [];
    let malformed = 0;
    for (const signalsPath of grokDiscovery.files) {
      const parsed = await parseGrokBuildSession(signalsPath, { localAliasKey: secrets.localAliasKey });
      if (parsed.status === "available_prospective_partial") sessions.push(parsed.session);
      else if (parsed.status === "malformed") malformed += 1;
    }
    result.providerEvidence.grok = {
      status: sessions.length > 0 ? "available_prospective_partial" : "unavailable",
      reason: sessions.length > 0 ? "session_summary_not_token_ledger" : "no_supported_grok_build_session_signals",
      sessions
    };
    result.stats.grok = {
      status: sessions.length > 0 ? "available_prospective_partial" : (grokDiscovery.unavailable ? "unavailable" : "no_supported_session_signals"),
      files: grokDiscovery.files.length,
      malformed,
      sessions: sessions.length,
      collector: "grok_build_local_session_summary",
      historicalCompleteness: "none",
      accounting: "informational_only"
    };
  }

  for (const provider of ["codex", "claude", "gemini", "kimi"]) {
    finalizeProviderCoverage(result, provider);
  }

  if (aggregator) {
    const aggregation = aggregator.finish();
    result.events = result.events.concat(aggregation.events);
    result.aggregation = {
      ranges: aggregateRanges,
      groups: aggregation.groups,
      excluded: aggregation.excluded,
      duplicateSources: aggregation.duplicateSources,
      beforeWindow: aggregation.beforeWindow,
      afterWindow: aggregation.afterWindow
    };
  }

  result.events.sort((a, b) => {
    const timeOrder = (a.observedAt || "").localeCompare(b.observedAt || "");
    return timeOrder || a.eventId.localeCompare(b.eventId);
  });
  return result;
}

export function toWireEvent(event) {
  if (!event?.eventId || !event?.provider || !event?.observedAt || !event?.usage || !event?.provenance?.surface) {
    return null;
  }
  const serviceProviderId = serviceProviderForEvent(event);
  if (!serviceProviderId) return null;
  const componentConflict = event.usage.componentConflict === true;
  const usage = componentConflict
    ? {
        // Raw-only rows have no model/category semantics. Put the authoritative
        // provider total in one wire counter solely so the lossless raw ledger
        // can retain it without inventing a proportional component split.
        inputTokens: String(event.usage.reportedTotal || 0),
        cachedInputTokens: "0",
        cacheWriteInputTokens: "0",
        outputTokens: "0"
      }
    : {
        inputTokens: String(event.usage.input || 0),
        cachedInputTokens: String(event.usage.cachedInput || 0),
        cacheWriteInputTokens: String(event.usage.cacheWriteInput || 0),
        outputTokens: String(event.usage.output || 0),
    ...(event.usage.reasoningOutput > 0 ? { reasoningTokens: String(event.usage.reasoningOutput) } : {})
      };
  const common = {
    eventId: event.eventId,
    occurredAt: event.observedAt,
    provider: event.provider,
    serviceProviderId,
    ...usage,
    surface: event.provenance.surface
  };
  if (componentConflict || !event.modelId || event.modelId === "unknown" || event.mode?.classified !== true) {
    const rawOnly = {
      ...common,
      attribution: "raw_only",
      modelId: "unknown",
      serviceMode: "unknown"
    };
    return hasRawTokenUsage(rawOnly) ? rawOnly : null;
  }
  const attributed = {
    ...common,
    modelId: event.modelId,
    serviceMode: event.mode?.fast ? "fast" : "standard"
  };
  return hasRawTokenUsage(attributed) ? attributed : null;
}

export function aggregatePreview(collection) {
  const groups = new Map();
  for (const event of collection.events) {
    const mode = modeLabel(event);
    const serviceProviderId = serviceProviderForEvent(event);
    const key = [event.provider, serviceProviderId || "unknown-host", event.modelId || "unscored", mode].join("|");
    const current = groups.get(key) || {
      provider: event.provider,
      serviceProviderId,
      model: event.modelId,
      sourceModelId: event.sourceModelId,
      scored: Boolean(event.modelId),
      mode,
      records: 0,
      rawUsage: {
        input: 0,
        cachedInput: 0,
        cacheWriteInput: 0,
        output: 0,
        reasoningOutput: 0,
        total: 0
      }
    };
    current.records += 1;
    for (const field of Object.keys(current.rawUsage)) {
      current.rawUsage[field] += event.usage[field] || 0;
    }
    groups.set(key, current);
  }
  return {
    records: collection.events.length,
    groups: [...groups.values()].sort((a, b) => b.rawUsage.total - a.rawUsage.total),
    adapters: collection.stats,
    providerEvidence: collection.providerEvidence
  };
}
