import { MAX_CLAUDE_SEEN_EVENTS, MAX_CURSOR_FILES } from "./constants.mjs";
import { hmacAlias, payloadHash, sha256 } from "./crypto.mjs";
import { discoverJsonlFiles } from "./discovery.mjs";
import { parseCodexRollout } from "./adapters/codex-rollout.mjs";
import { chooseClaudeSnapshot, parseClaudeProject } from "./adapters/claude-project.mjs";
import { readCodexAccountUsage } from "./adapters/codex-account-usage.mjs";
import path from "node:path";
import { parseKimiWire } from "./adapters/kimi-wire.mjs";

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
  const nextCursors = structuredClone(state.cursors || { codex: { files: {} }, claude: { seen: {} }, kimi: { files: {} } });
  nextCursors.codex = nextCursors.codex || { files: {} };
  nextCursors.codex.files = nextCursors.codex.files || {};
  nextCursors.claude = nextCursors.claude || { seen: {} };
  nextCursors.claude.seen = nextCursors.claude.seen || {};
  nextCursors.kimi = nextCursors.kimi || { files: {} };
  nextCursors.kimi.files = nextCursors.kimi.files || {};
  const result = {
    events: [],
    providerEvidence: {},
    nextCursors,
    stats: {
      codex: { files: 0, events: 0, malformed: 0, duplicateSnapshots: 0, cumulativeResets: 0, cumulativeMismatches: 0, unavailable: false, collector: "local_log_fallback" },
      claude: { files: 0, events: 0, malformed: 0, unavailable: false, collector: "local_log_fallback" },
      gemini: { status: "pending_verified_adapter" },
      kimi: { files: 0, events: 0, malformed: 0, unavailable: false, collector: "kimi_v0_28_wire_usage_record_fallback" },
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
  const codexDiscovery = enabledFallbacks.codex
    ? await discoverJsonlFiles(roots.codex)
    : { files: [], unavailable: false, truncated: false };
  result.stats.codex.files = codexDiscovery.files.length;
  result.stats.codex.unavailable = codexDiscovery.unavailable;
  if (!enabledFallbacks.codex) {
    result.stats.codex.status = "opt_in_required";
  }
  for (const filePath of codexDiscovery.files) {
    const fileAlias = hmacAlias(secrets.localAliasKey, "codex-file", filePath);
    const parsed = await parseCodexRollout(filePath, {
      aliasKey: secrets.localAliasKey,
      fileAlias,
      cursor: nextCursors.codex.files[fileAlias],
      dedupNamespaceKey,
      canonicalModelId: options.canonicalModelId,
      now
    });
    nextCursors.codex.files[fileAlias] = parsed.cursor;
    result.events.push(...parsed.events);
    result.stats.codex.events += parsed.events.length;
    result.stats.codex.malformed += parsed.malformed;
    result.stats.codex.duplicateSnapshots += parsed.duplicateSnapshots;
    result.stats.codex.cumulativeResets += parsed.cumulativeResets;
    result.stats.codex.cumulativeMismatches += parsed.cumulativeMismatches;
  }
  nextCursors.codex.files = newestEntries(nextCursors.codex.files, MAX_CURSOR_FILES, "lastSeenAt");

  const claudeDiscovery = enabledFallbacks.claude
    ? await discoverJsonlFiles(roots.claude)
    : { files: [], unavailable: false, truncated: false };
  result.stats.claude.files = claudeDiscovery.files.length;
  result.stats.claude.unavailable = claudeDiscovery.unavailable;
  if (!enabledFallbacks.claude) {
    result.stats.claude.status = "opt_in_required";
  }
  const claudeByEventId = new Map();
  for (const filePath of claudeDiscovery.files) {
    const fileAlias = hmacAlias(secrets.localAliasKey, "claude-file", filePath);
    const parsed = await parseClaudeProject(filePath, {
      aliasKey: secrets.localAliasKey,
      fileAlias,
      dedupNamespaceKey
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
  const priorSeen = nextCursors.claude.seen;
  const changedClaudeEvents = allClaudeEvents.filter((event) => priorSeen[event.eventId]?.hash !== payloadHash(event));
  nextCursors.claude.seen = boundedSeen(allClaudeEvents, priorSeen);
  result.events.push(...changedClaudeEvents);
  result.stats.claude.events = changedClaudeEvents.length;

  const kimiDiscovery = enabledFallbacks.kimi
    ? await discoverJsonlFiles(roots.kimi)
    : { files: [], unavailable: false, truncated: false };
  const kimiWireFiles = kimiDiscovery.files.filter((filePath) => path.basename(filePath).toLowerCase() === "wire.jsonl");
  result.stats.kimi.files = kimiWireFiles.length;
  result.stats.kimi.unavailable = kimiDiscovery.unavailable;
  if (!enabledFallbacks.kimi) {
    result.stats.kimi.status = "opt_in_required";
  }
  for (const filePath of kimiWireFiles) {
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
      now
    });
    nextCursors.kimi.files[fileAlias] = parsed.cursor;
    result.events.push(...parsed.events);
    result.stats.kimi.events += parsed.events.length;
    result.stats.kimi.malformed += parsed.malformed;
  }
  nextCursors.kimi.files = newestEntries(nextCursors.kimi.files, MAX_CURSOR_FILES, "lastSeenAt");

  result.events.sort((a, b) => {
    const timeOrder = (a.observedAt || "").localeCompare(b.observedAt || "");
    return timeOrder || a.eventId.localeCompare(b.eventId);
  });
  return result;
}

export function toWireEvent(event) {
  if (!event.modelId || !event.observedAt) {
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
    const key = [event.provider, event.modelId || "unscored", event.mode.fast ? "fast" : "standard"].join("|");
    const current = groups.get(key) || {
      provider: event.provider,
      model: event.modelId,
      sourceModelId: event.sourceModelId,
      scored: Boolean(event.modelId),
      mode: event.mode.fast ? "fast" : "standard",
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
