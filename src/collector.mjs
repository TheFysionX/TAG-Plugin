import { MAX_CLAUDE_SEEN_EVENTS, MAX_CODEX_LOGICAL_SESSIONS, MAX_CURSOR_FILES } from "./constants.mjs";
import { accountScopedEventId, hmacAlias, payloadHash, sha256 } from "./crypto.mjs";
import { discoverJsonlFiles } from "./discovery.mjs";
import { codexRolloutSortKey, parseCodexRollout } from "./adapters/codex-rollout.mjs";
import { chooseClaudeSnapshot, parseClaudeProject } from "./adapters/claude-project.mjs";
import { readCodexAccountUsage } from "./adapters/codex-account-usage.mjs";
import path from "node:path";
import { parseKimiWire } from "./adapters/kimi-wire.mjs";

const AGGREGATE_USAGE_FIELDS = ["input", "cachedInput", "cacheWriteInput", "output", "reasoningOutput"];

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
    const range = ranges[event.provider];
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
    const aggregateVersion = event.provider === "kimi" ? 3 : 4;
    const key = payloadHash({
      schema: `session-hour-aggregate-v${aggregateVersion}`,
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
  const nextCursors = structuredClone(state.cursors || { codex: { accountingVersion: 4, files: {}, sessions: {} }, claude: { accountingVersion: 4, seen: {} }, kimi: { files: {} } });
  nextCursors.codex = nextCursors.codex || { accountingVersion: 4, files: {}, sessions: {} };
  nextCursors.codex.accountingVersion = 4;
  nextCursors.codex.files = nextCursors.codex.files || {};
  nextCursors.codex.sessions = nextCursors.codex.sessions || {};
  nextCursors.claude = nextCursors.claude || { accountingVersion: 4, seen: {} };
  nextCursors.claude.accountingVersion = 4;
  nextCursors.claude.seen = nextCursors.claude.seen || {};
  nextCursors.kimi = nextCursors.kimi || { files: {} };
  nextCursors.kimi.files = nextCursors.kimi.files || {};
  const result = {
    events: [],
    providerEvidence: {},
    providerScans: {},
    nextCursors,
    stats: {
      codex: { files: 0, events: 0, pending: false, malformed: 0, duplicateSnapshots: 0, cumulativeResets: 0, cumulativeMismatches: 0, inheritedSnapshots: 0, ambiguousLineage: 0, unclassifiedModes: 0, unavailable: false, collector: "local_log_fallback" },
      claude: { files: 0, events: 0, pending: false, malformed: 0, unavailable: false, collector: "local_log_fallback" },
      gemini: { status: "pending_verified_adapter" },
      kimi: { files: 0, events: 0, pending: false, malformed: 0, unavailable: false, collector: "kimi_v0_28_wire_usage_record_fallback" },
      grok: { status: "pending_verified_adapter" }
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

  const enabledFallbacks = options.enabledFallbacks || { codex: false, claude: false };
  const discover = options.discoverJsonlFiles || discoverJsonlFiles;
  const codexDiscovery = enabledFallbacks.codex
    ? await discover(roots.codex)
    : { files: [], unavailable: false, truncated: false };
  result.stats.codex.files = codexDiscovery.files.length;
  result.stats.codex.unavailable = codexDiscovery.unavailable;
  result.stats.codex.truncated = codexDiscovery.truncated;
  result.providerScans.codex = {
    enabled: Boolean(enabledFallbacks.codex),
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
  if (!event.modelId || !event.observedAt || event.mode?.classified === false) {
    return null;
  }
  return {
    eventId: event.eventId,
    occurredAt: event.observedAt,
    provider: event.provider,
    modelId: event.modelId,
    serviceMode: event.mode.fast ? "fast" : "standard",
    inputTokens: String(event.usage.input + event.usage.cacheWriteInput),
    cachedInputTokens: String(event.usage.cachedInput),
    outputTokens: String(event.usage.output),
    ...(event.usage.reasoningOutput > 0 ? { reasoningTokens: String(event.usage.reasoningOutput) } : {}),
    surface: event.provenance.surface
  };
}

export function aggregatePreview(collection) {
  const groups = new Map();
  for (const event of collection.events) {
    const mode = modeLabel(event);
    const key = [event.provider, event.modelId || "unscored", mode].join("|");
    const current = groups.get(key) || {
      provider: event.provider,
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
