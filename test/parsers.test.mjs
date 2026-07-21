import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseCodexRollout } from "../src/adapters/codex-rollout.mjs";
import { parseClaudeProject } from "../src/adapters/claude-project.mjs";
import { parseKimiWire } from "../src/adapters/kimi-wire.mjs";
import { MAX_JOURNAL_LINE_BYTES, normalizeMode } from "../src/adapters/shared.mjs";
import { canonicalModelId as resolveCanonicalModel } from "../src/model-registry.mjs";
import { collectUsage, toWireEvent } from "../src/collector.mjs";

const fixtureDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const aliasKey = Buffer.alloc(32, 7).toString("base64");
const dedupNamespaceKey = Buffer.alloc(32, 9).toString("base64url");

function serialized(value) {
  return JSON.stringify(value);
}

test("Codex fallback extracts only allowlisted final-turn usage", async () => {
  const parsed = await parseCodexRollout(path.join(fixtureDirectory, "codex-rollout.jsonl"), {
    aliasKey,
    fileAlias: "codex-fixture",
    dedupNamespaceKey,
    now: 123
  });
  assert.equal(parsed.events.length, 1);
  const [event] = parsed.events;
  assert.equal(event.modelId, "gpt-5.6-sol");
  assert.equal(event.mode.fast, true);
  assert.deepEqual(event.usage, {
    input: 60,
    cachedInput: 40,
    cacheWriteInput: 5,
    output: 30,
    reasoningOutput: 8,
    total: 135
  });
  assert.equal(parsed.malformed, 0);
  assert.equal(parsed.duplicateSnapshots, 1);
  assert.equal(parsed.cumulativeMismatches, 0);
  assert.doesNotMatch(serialized(parsed), /SECRET_|private|repository/i);
});

test("Codex treats both fast and priority service tiers as classified Fast", async (context) => {
  assert.deepEqual(normalizeMode({ provider: "codex", serviceTier: " FAST " }), {
    serviceTier: "fast",
    speed: null,
    fast: true,
    classified: true
  });
  assert.deepEqual(normalizeMode({ provider: "codex", serviceTier: "priority" }), {
    serviceTier: "priority",
    speed: null,
    fast: true,
    classified: true
  });
  assert.deepEqual(normalizeMode({ provider: "codex", serviceTier: "standard" }), {
    serviceTier: "standard",
    speed: null,
    fast: false,
    classified: true
  });
  assert.equal(normalizeMode({ provider: "codex", serviceTier: "unknown-tier" }).classified, false);

  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "tag-plugin-codex-fast-tier-test-"));
  context.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const activePath = path.join(temporary, "rollout-00000000-0000-4000-8000-0000000000f1.jsonl");
  await fs.writeFile(activePath, [
    {
      timestamp: "2026-07-19T10:00:00.000Z",
      type: "session_meta",
      payload: { id: "00000000-0000-4000-8000-0000000000f1" }
    },
    {
      timestamp: "2026-07-19T10:00:01.000Z",
      type: "event_msg",
      payload: {
        type: "thread_settings_applied",
        thread_settings: { model: "gpt-5.6-sol", service_tier: "fast" }
      }
    },
    {
      timestamp: "2026-07-19T10:00:02.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: { total_tokens: 15 },
          last_token_usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }
        }
      }
    },
    {
      timestamp: "2026-07-19T10:01:01.000Z",
      type: "event_msg",
      payload: {
        type: "thread_settings_applied",
        thread_settings: { model: "gpt-5.6-sol", service_tier: "priority" }
      }
    },
    {
      timestamp: "2026-07-19T10:01:02.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: { total_tokens: 30 },
          last_token_usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }
        }
      }
    }
  ].map(JSON.stringify).join("\n") + "\n", "utf8");

  const parsed = await parseCodexRollout(activePath, { dedupNamespaceKey });
  assert.deepEqual(parsed.events.map((event) => event.mode.serviceTier), ["fast", "priority"]);
  assert.ok(parsed.events.every((event) => event.mode.fast && event.mode.classified));
  assert.deepEqual(parsed.events.map((event) => toWireEvent(event)?.serviceMode), ["fast", "fast"]);
  assert.equal(parsed.unclassifiedModes, 0);
});

test("Codex lineage suppresses resumed, forked, and re-timestamped inherited usage", async (context) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "tag-plugin-codex-lineage-test-"));
  context.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const fixture = JSON.parse(await fs.readFile(
    path.join(fixtureDirectory, "codex-lineage-copies.json"),
    "utf8"
  ));
  const paths = {};
  for (const [name, records] of Object.entries(fixture)) {
    paths[name] = path.join(temporary, `rollout-${name}.jsonl`);
    await fs.writeFile(paths[name], records.map(JSON.stringify).join("\n") + "\n", "utf8");
  }
  const logicalSessions = {};
  const parsed = {};
  for (const name of ["original", "resumed", "forked", "rewritten"]) {
    parsed[name] = await parseCodexRollout(paths[name], {
      aliasKey,
      dedupNamespaceKey,
      logicalSessions,
      now: 123
    });
  }

  assert.deepEqual(
    ["original", "resumed", "forked", "rewritten"].map((name) => parsed[name].events.length),
    [2, 1, 1, 0]
  );
  assert.equal(
    Object.values(parsed).flatMap((result) => result.events)
      .reduce((total, event) => total + event.usage.total, 0),
    220
  );
  assert.equal(parsed.original.events[0].aggregationScope, parsed.original.events[1].aggregationScope);
  assert.equal(parsed.original.events[0].aggregationScope, parsed.resumed.events[0].aggregationScope);
  assert.notEqual(parsed.original.events[0].aggregationScope, parsed.forked.events[0].aggregationScope);
  assert.equal(parsed.resumed.events[0].mode.fast, true);
  assert.equal(parsed.forked.events[0].mode.fast, false);
  assert.equal(parsed.forked.events[0].mode.classified, true);
  assert.equal(parsed.resumed.inheritedSnapshots, 2);
  assert.equal(parsed.forked.inheritedSnapshots, 1);
  assert.equal(parsed.rewritten.inheritedSnapshots, 2);

  const originalAlone = await parseCodexRollout(paths.original, { aliasKey, dedupNamespaceKey });
  const rewrittenAlone = await parseCodexRollout(paths.rewritten, { aliasKey, dedupNamespaceKey });
  assert.deepEqual(
    rewrittenAlone.events.map((event) => event.eventId),
    originalAlone.events.map((event) => event.eventId)
  );

  const restoredSessions = {};
  const initiallyCommitted = await parseCodexRollout(paths.original, {
    aliasKey,
    dedupNamespaceKey,
    logicalSessions: restoredSessions,
    now: 100
  });
  delete restoredSessions[initiallyCommitted.cursor.logicalSessionAlias];
  const unchanged = await parseCodexRollout(paths.original, {
    aliasKey,
    dedupNamespaceKey,
    logicalSessions: restoredSessions,
    cursor: initiallyCommitted.cursor,
    now: 200
  });
  assert.equal(unchanged.events.length, 0);
  assert.equal(
    restoredSessions[initiallyCommitted.cursor.logicalSessionAlias].highWatermark,
    150
  );

  const collectInOrder = (files) => collectUsage({
    roots: { codex: temporary, claude: path.join(temporary, "none-claude"), kimi: path.join(temporary, "none-kimi") },
    state: {
      cursors: {
        codex: { accountingVersion: 4, files: {}, sessions: {} },
        claude: { seen: {} },
        kimi: { files: {} }
      }
    },
    secrets: { localAliasKey: aliasKey },
    dedupNamespaceKey,
    enabledFallbacks: { codex: true, claude: false, kimi: false },
    officialEvidence: false,
    discoverJsonlFiles: async () => ({ files, unavailable: false, truncated: false }),
    now: 123
  });
  const forward = await collectInOrder(Object.values(paths));
  const reversed = await collectInOrder(Object.values(paths).reverse());
  assert.equal(forward.events.reduce((total, event) => total + event.usage.total, 0), 220);
  assert.deepEqual(
    reversed.events.map((event) => event.eventId),
    forward.events.map((event) => event.eventId)
  );
});

test("Codex fallback pages a large journal without changing event identity or totals", async (context) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "tag-plugin-codex-page-test-"));
  context.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const activePath = path.join(temporary, "rollout-00000000-0000-4000-8000-000000000001.jsonl");
  const records = [
    { type: "session_meta", payload: { id: "00000000-0000-4000-8000-000000000001" } },
    { type: "turn_context", payload: { model: "gpt-5.6-sol" } },
    ...Array.from({ length: 5 }, (_unused, index) => ({
      timestamp: new Date(Date.parse("2026-07-19T10:00:00.000Z") + index * 1_000).toISOString(),
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: { total_tokens: (index + 1) * 15 },
          last_token_usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }
        }
      }
    }))
  ];
  await fs.writeFile(activePath, records.map(JSON.stringify).join("\n") + "\n", "utf8");

  const full = await parseCodexRollout(activePath, { dedupNamespaceKey });
  let cursor;
  const paged = [];
  for (let page = 0; page < 3; page += 1) {
    const parsed = await parseCodexRollout(activePath, {
      dedupNamespaceKey,
      cursor,
      maximumEvents: 2
    });
    paged.push(...parsed.events);
    cursor = parsed.cursor;
  }
  const complete = await parseCodexRollout(activePath, {
    dedupNamespaceKey,
    cursor,
    maximumEvents: 2
  });

  assert.deepEqual(paged, full.events);
  assert.equal(cursor.offset, (await fs.stat(activePath)).size);
  assert.equal(complete.events.length, 0);
  assert.equal(complete.reachedEventLimit, false);
});

test("Codex time boundary leaves a complete cursor before deferred usage", async (context) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "tag-plugin-codex-time-page-test-"));
  context.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const activePath = path.join(temporary, "rollout-00000000-0000-4000-8000-000000000001.jsonl");
  const usage = (timestamp, cumulativeTotal) => ({
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: { total_tokens: cumulativeTotal },
        last_token_usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }
      }
    }
  });
  await fs.writeFile(activePath, [
    { type: "session_meta", payload: { id: "00000000-0000-4000-8000-000000000001" } },
    { type: "turn_context", payload: { model: "gpt-5.6-sol" } },
    usage("2026-07-19T10:00:00.000Z", 15),
    usage("2026-07-19T11:00:00.000Z", 30)
  ].map(JSON.stringify).join("\n") + "\n", "utf8");
  const first = await parseCodexRollout(activePath, {
    dedupNamespaceKey,
    maximumObservedAtExclusive: "2026-07-19T11:00:00.000Z"
  });
  const second = await parseCodexRollout(activePath, {
    dedupNamespaceKey,
    cursor: first.cursor,
    maximumObservedAtExclusive: "2026-07-19T12:00:00.000Z"
  });
  const full = await parseCodexRollout(activePath, { dedupNamespaceKey });

  assert.equal(first.reachedTimeBoundary, true);
  assert.equal(first.events.length, 1);
  assert.equal(second.events.length, 1);
  assert.deepEqual([...first.events, ...second.events], full.events);
  assert.equal(second.cursor.offset, (await fs.stat(activePath)).size);
});

test("Claude fallback deduplicates message snapshots using the maximum/final usage", async () => {
  const parsed = await parseClaudeProject(path.join(fixtureDirectory, "claude-project.jsonl"), {
    aliasKey,
    fileAlias: "claude-fixture",
    dedupNamespaceKey
  });
  assert.equal(parsed.events.length, 2);
  const known = parsed.events.find((event) => event.modelId === "claude-sonnet-5");
  const unknown = parsed.events.find((event) => event.modelId === null);
  assert.equal(known.usage.output, 25);
  assert.equal(known.usage.total, 42);
  assert.equal(known.mode.fast, true);
  assert.equal(unknown.sourceModelId, "claude-unregistered-99");
  assert.doesNotMatch(serialized(parsed), /SECRET_|private|source\.ts/i);
});

test("Claude classifies speed only from message usage evidence", async (context) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "tag-plugin-claude-speed-test-"));
  context.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const activePath = path.join(temporary, "claude-speed.jsonl");
  await fs.writeFile(activePath, [
    {
      type: "assistant",
      timestamp: "2026-07-19T11:00:00.000Z",
      speed: "fast",
      message: {
        id: "msg_standard_speed",
        model: "claude-sonnet-5-20260701",
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5, service_tier: "priority", speed: "standard" }
      }
    },
    {
      type: "assistant",
      timestamp: "2026-07-19T11:01:00.000Z",
      message: {
        id: "msg_missing_speed",
        model: "claude-sonnet-5-20260701",
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5, service_tier: "priority" }
      }
    }
  ].map(JSON.stringify).join("\n") + "\n", "utf8");
  const parsed = await parseClaudeProject(activePath, { dedupNamespaceKey });
  const standard = parsed.events.find((event) => event.mode.speed === "standard");
  const unclassified = parsed.events.find((event) => event.mode.speed === null);
  assert.equal(standard.mode.fast, false);
  assert.equal(standard.mode.classified, true);
  assert.equal(unclassified.mode.fast, false);
  assert.equal(unclassified.mode.classified, false);
  assert.equal(toWireEvent(standard)?.serviceMode, "standard");
  assert.equal(toWireEvent(unclassified), null);
});

test("Kimi v0.28 fallback prefilters usage.record and maps HighSpeed to fast", async () => {
  const parsed = await parseKimiWire(path.join(fixtureDirectory, "kimi-wire.jsonl"), {
    aliasKey,
    fileAlias: "kimi-fixture",
    stableJournalIdentity: "stable-kimi-session-agent",
    dedupNamespaceKey,
    now: 123
  });
  assert.equal(parsed.events.length, 1);
  assert.equal(parsed.events[0].modelId, "kimi-k2.7-code");
  assert.equal(parsed.events[0].mode.fast, true);
  assert.equal(parsed.events[0].usage.total, 42);
  assert.doesNotMatch(serialized(parsed), /SECRET_|private|kimi\.py/i);
});

test("Kimi fallback pages a large journal without changing event identity or totals", async (context) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "tag-plugin-kimi-page-test-"));
  context.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const activePath = path.join(temporary, "wire.jsonl");
  const records = Array.from({ length: 5 }, (_unused, index) => ({
    type: "usage.record",
    time: new Date(Date.parse("2026-07-19T12:00:00.000Z") + index * 1_000).toISOString(),
    model: "kimi-code/kimi-for-coding-highspeed",
    usage: { inputOther: 10 + index, inputCacheRead: 2, inputCacheCreation: 1, output: 5 },
    usageScope: "turn"
  }));
  await fs.writeFile(activePath, records.map(JSON.stringify).join("\n") + "\n", "utf8");
  const options = {
    stableJournalIdentity: "stable-kimi-session-agent",
    dedupNamespaceKey
  };
  const full = await parseKimiWire(activePath, options);
  let cursor;
  const paged = [];
  for (let page = 0; page < 3; page += 1) {
    const parsed = await parseKimiWire(activePath, {
      ...options,
      cursor,
      maximumEvents: 2
    });
    paged.push(...parsed.events);
    cursor = parsed.cursor;
  }
  const complete = await parseKimiWire(activePath, {
    ...options,
    cursor,
    maximumEvents: 2
  });

  assert.deepEqual(paged, full.events);
  assert.equal(cursor.offset, (await fs.stat(activePath)).size);
  assert.equal(complete.events.length, 0);
  assert.equal(complete.reachedEventLimit, false);
});

test("uploaded event IDs are stable across fresh local alias keys", async () => {
  const codexPath = path.join(fixtureDirectory, "codex-rollout.jsonl");
  const claudePath = path.join(fixtureDirectory, "claude-project.jsonl");
  const kimiPath = path.join(fixtureDirectory, "kimi-wire.jsonl");
  const firstKey = Buffer.alloc(32, 1).toString("base64");
  const secondKey = Buffer.alloc(32, 2).toString("base64");
  const firstCodex = await parseCodexRollout(codexPath, { aliasKey: firstKey, fileAlias: "first", dedupNamespaceKey });
  const secondCodex = await parseCodexRollout(codexPath, { aliasKey: secondKey, fileAlias: "second", dedupNamespaceKey });
  const firstClaude = await parseClaudeProject(claudePath, { aliasKey: firstKey, fileAlias: "first", dedupNamespaceKey });
  const secondClaude = await parseClaudeProject(claudePath, { aliasKey: secondKey, fileAlias: "second", dedupNamespaceKey });
  const firstKimi = await parseKimiWire(kimiPath, {
    aliasKey: firstKey,
    fileAlias: "first",
    stableJournalIdentity: "stable-kimi-session-agent",
    dedupNamespaceKey
  });
  const secondKimi = await parseKimiWire(kimiPath, {
    aliasKey: secondKey,
    fileAlias: "second",
    stableJournalIdentity: "stable-kimi-session-agent",
    dedupNamespaceKey
  });
  assert.deepEqual(firstCodex.events.map((event) => event.eventId), secondCodex.events.map((event) => event.eventId));
  assert.deepEqual(firstClaude.events.map((event) => event.eventId), secondClaude.events.map((event) => event.eventId));
  assert.deepEqual(firstKimi.events.map((event) => event.eventId), secondKimi.events.map((event) => event.eventId));
});

test("account namespaces prevent cross-account event-ID correlation", async () => {
  const codexPath = path.join(fixtureDirectory, "codex-rollout.jsonl");
  const first = await parseCodexRollout(codexPath, {
    dedupNamespaceKey: Buffer.alloc(32, 3).toString("base64url")
  });
  const second = await parseCodexRollout(codexPath, {
    dedupNamespaceKey: Buffer.alloc(32, 4).toString("base64url")
  });
  assert.notDeepEqual(
    first.events.map((event) => event.eventId),
    second.events.map((event) => event.eventId)
  );
});

test("legacy byte cursors without file identity safely rescan once", async () => {
  const codexPath = path.join(fixtureDirectory, "codex-rollout.jsonl");
  const kimiPath = path.join(fixtureDirectory, "kimi-wire.jsonl");
  const codex = await parseCodexRollout(codexPath, {
    dedupNamespaceKey,
    cursor: { offset: (await fs.stat(codexPath)).size }
  });
  const kimi = await parseKimiWire(kimiPath, {
    dedupNamespaceKey,
    stableJournalIdentity: "stable-kimi-session-agent",
    cursor: { offset: (await fs.stat(kimiPath)).size }
  });
  assert.equal(codex.events.length, 1);
  assert.equal(kimi.events.length, 1);
  assert.equal(typeof codex.cursor.fileIdentity, "string");
  assert.equal(typeof kimi.cursor.fileIdentity, "string");
});

test("Codex cursor resets when a larger journal replaces the file at the same path", async (context) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "tag-plugin-codex-replace-test-"));
  context.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const activePath = path.join(temporary, "rollout.jsonl");
  const replacementPath = path.join(temporary, "replacement.jsonl");
  const original = await fs.readFile(path.join(fixtureDirectory, "codex-rollout.jsonl"), "utf8");
  await fs.writeFile(activePath, original, "utf8");
  const first = await parseCodexRollout(activePath, { dedupNamespaceKey });
  await fs.writeFile(replacementPath, original + "\n".repeat(512), "utf8");
  await fs.rm(activePath);
  await fs.rename(replacementPath, activePath);
  const second = await parseCodexRollout(activePath, {
    dedupNamespaceKey,
    cursor: first.cursor
  });
  assert.notEqual(second.cursor.fileIdentity, first.cursor.fileIdentity);
  assert.equal(second.events.length, 1);
});

test("Kimi cursor resets when a larger journal replaces the file at the same path", async (context) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "tag-plugin-kimi-replace-test-"));
  context.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const activePath = path.join(temporary, "wire.jsonl");
  const replacementPath = path.join(temporary, "replacement.jsonl");
  const original = await fs.readFile(path.join(fixtureDirectory, "kimi-wire.jsonl"), "utf8");
  await fs.writeFile(activePath, original, "utf8");
  const options = {
    stableJournalIdentity: "stable-kimi-session-agent",
    dedupNamespaceKey
  };
  const first = await parseKimiWire(activePath, options);
  const changed = original.replace("2026-07-19T12:00:01.000Z", "2026-07-19T12:00:02.000Z")
    + "\n".repeat(512);
  await fs.writeFile(replacementPath, changed, "utf8");
  await fs.rm(activePath);
  await fs.rename(replacementPath, activePath);
  const second = await parseKimiWire(activePath, { ...options, cursor: first.cursor });
  assert.notEqual(second.cursor.fileIdentity, first.cursor.fileIdentity);
  assert.equal(second.events.length, 1);
  assert.notEqual(second.events[0].eventId, first.events[0].eventId);
});

test("Codex cursor resets after an in-place larger rewrite preserves file metadata identity", async (context) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "tag-plugin-codex-rewrite-test-"));
  context.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const activePath = path.join(temporary, "rollout.jsonl");
  const original = await fs.readFile(path.join(fixtureDirectory, "codex-rollout.jsonl"), "utf8");
  await fs.writeFile(activePath, original, "utf8");
  const first = await parseCodexRollout(activePath, { dedupNamespaceKey });
  const changed = original
    .replaceAll("1000135", "2000270")
    .replaceAll('"total_tokens":135', '"total_tokens":270')
    + "\n".repeat(512);
  await fs.writeFile(activePath, changed, "utf8");
  const second = await parseCodexRollout(activePath, {
    dedupNamespaceKey,
    cursor: first.cursor
  });
  assert.equal(second.cursor.fileIdentity, first.cursor.fileIdentity);
  assert.equal(second.events.length, 1);
  assert.equal(second.events[0].usage.total, 270);
  assert.notEqual(second.events[0].eventId, first.events[0].eventId);
  assert.notEqual(second.cursor.usagePrefixDigest, first.cursor.usagePrefixDigest);
});

test("Kimi cursor resets after an in-place larger rewrite preserves file metadata identity", async (context) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "tag-plugin-kimi-rewrite-test-"));
  context.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const activePath = path.join(temporary, "wire.jsonl");
  const original = await fs.readFile(path.join(fixtureDirectory, "kimi-wire.jsonl"), "utf8");
  await fs.writeFile(activePath, original, "utf8");
  const options = {
    stableJournalIdentity: "stable-kimi-session-agent",
    dedupNamespaceKey
  };
  const first = await parseKimiWire(activePath, options);
  const changed = original.replace('"output":20', '"output":220') + "\n".repeat(512);
  await fs.writeFile(activePath, changed, "utf8");
  const second = await parseKimiWire(activePath, { ...options, cursor: first.cursor });
  assert.equal(second.cursor.fileIdentity, first.cursor.fileIdentity);
  assert.equal(second.events.length, 1);
  assert.equal(second.events[0].usage.total, 242);
  assert.equal(second.events[0].eventId, first.events[0].eventId);
  assert.notEqual(second.cursor.usagePrefixDigest, first.cursor.usagePrefixDigest);
});

test("Kimi event IDs survive same-path replacement and non-usage header insertion", async (context) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "tag-plugin-kimi-id-stability-test-"));
  context.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const activePath = path.join(temporary, "wire.jsonl");
  const original = await fs.readFile(path.join(fixtureDirectory, "kimi-wire.jsonl"), "utf8");
  const options = {
    stableJournalIdentity: "stable-kimi-session-agent",
    dedupNamespaceKey
  };
  await fs.writeFile(activePath, original, "utf8");
  const first = await parseKimiWire(activePath, options);
  const insertedHeader = JSON.stringify({ type: "trace", time: "2026-07-19T11:59:59.000Z", payload: "ignored" });
  await fs.writeFile(activePath, `${insertedHeader}\n${original}${"\n".repeat(512)}`, "utf8");
  const second = await parseKimiWire(activePath, { ...options, cursor: first.cursor });
  assert.equal(second.cursor.fileIdentity, first.cursor.fileIdentity);
  assert.equal(second.events.length, 1);
  assert.equal(second.events[0].eventId, first.events[0].eventId);
});

test("Kimi IDs distinguish separate usage occurrences at the same timestamp", async (context) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "tag-plugin-kimi-same-time-test-"));
  context.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const activePath = path.join(temporary, "wire.jsonl");
  const base = {
    type: "usage.record",
    time: "2026-07-19T12:00:01.000Z",
    model: "kimi-code/kimi-for-coding-highspeed",
    usageScope: "turn"
  };
  await fs.writeFile(activePath, [
    JSON.stringify({ ...base, usage: { inputOther: 12, inputCacheRead: 7, inputCacheCreation: 3, output: 20 } }),
    JSON.stringify({ ...base, usage: { inputOther: 12, inputCacheRead: 7, inputCacheCreation: 3, output: 21 } }),
    JSON.stringify({ ...base, usage: { inputOther: 12, inputCacheRead: 7, inputCacheCreation: 3, output: 20 } })
  ].join("\n") + "\n", "utf8");
  const parsed = await parseKimiWire(activePath, {
    stableJournalIdentity: "stable-kimi-session-agent",
    dedupNamespaceKey
  });
  assert.notEqual(parsed.events[0].eventId, parsed.events[1].eventId);
  assert.notEqual(parsed.events[0].eventId, parsed.events[2].eventId);
  assert.notEqual(parsed.events[1].eventId, parsed.events[2].eventId);
});

test("Kimi advances past an unknown model so later known usage is not blocked", async (context) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "tag-plugin-kimi-model-replay-test-"));
  context.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const activePath = path.join(temporary, "wire.jsonl");
  const lines = [
    { type: "trace", time: "2026-07-19T12:00:00.000Z", payload: "ignored" },
    {
      type: "usage.record",
      time: "2026-07-19T12:00:01.000Z",
      model: "kimi-future-code",
      usage: { inputOther: 12, inputCacheRead: 7, inputCacheCreation: 3, output: 20 },
      usageScope: "turn"
    },
    {
      type: "usage.record",
      time: "2026-07-19T12:00:02.000Z",
      model: "kimi-code/kimi-for-coding-highspeed",
      usage: { inputOther: 14, inputCacheRead: 7, inputCacheCreation: 3, output: 20 },
      usageScope: "turn"
    }
  ].map(JSON.stringify).join("\n") + "\n";
  await fs.writeFile(activePath, lines, "utf8");
  const options = { stableJournalIdentity: "stable-kimi-session-agent", dedupNamespaceKey };
  const first = await parseKimiWire(activePath, options);
  assert.equal(first.events.length, 2);
  assert.equal(first.events[0].modelId, null);
  assert.equal(first.events[1].modelId, "kimi-k2.7-code");
  assert.equal(first.cursor.offset, (await fs.stat(activePath)).size);
  const second = await parseKimiWire(activePath, {
    ...options,
    cursor: first.cursor,
    canonicalModelId: (provider, sourceModelId) => sourceModelId === "kimi-future-code"
      ? "kimi-k2.7-code"
      : resolveCanonicalModel(provider, sourceModelId)
  });
  assert.equal(second.events.length, 0);
  assert.equal(second.cursor.offset, (await fs.stat(activePath)).size);
});

test("Codex advances past an unknown model for the local unresolved queue", async (context) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "tag-plugin-codex-model-replay-test-"));
  context.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const activePath = path.join(temporary, "rollout-00000000-0000-4000-8000-000000000001.jsonl");
  const lines = [
    { type: "session_meta", payload: { id: "00000000-0000-4000-8000-000000000001" } },
    { type: "turn_context", payload: { model: "gpt-future-codex" } },
    {
      timestamp: "2026-07-19T10:00:02.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: { total_tokens: 15 },
          last_token_usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }
        }
      }
    }
  ].map(JSON.stringify).join("\n") + "\n";
  await fs.writeFile(activePath, lines, "utf8");
  const first = await parseCodexRollout(activePath, { dedupNamespaceKey });
  assert.equal(first.events.length, 1);
  assert.equal(first.events[0].modelId, null);
  assert.equal(first.cursor.offset, (await fs.stat(activePath)).size);
  const second = await parseCodexRollout(activePath, {
    dedupNamespaceKey,
    cursor: first.cursor,
    canonicalModelId: (_provider, sourceModelId) => sourceModelId === "gpt-future-codex"
      ? "gpt-5.6-sol"
      : null
  });
  assert.equal(second.events.length, 0);
  assert.equal(second.cursor.offset, (await fs.stat(activePath)).size);
});

test("Codex fails closed when cumulative lineage evidence is absent", async (context) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "tag-plugin-codex-id-stability-test-"));
  context.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const activePath = path.join(temporary, "rollout-00000000-0000-4000-8000-000000000001.jsonl");
  const session = JSON.stringify({ type: "session_meta", payload: { id: "00000000-0000-4000-8000-000000000001" } });
  const contextLine = JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.6-sol" } });
  const usage = JSON.stringify({
    timestamp: "2026-07-19T10:00:02.000Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: { last_token_usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } }
    }
  });
  const original = `${session}\n${contextLine}\n${usage}\n`;
  await fs.writeFile(activePath, original, "utf8");
  const first = await parseCodexRollout(activePath, { dedupNamespaceKey });
  await fs.writeFile(activePath, `${JSON.stringify({ type: "trace", ignored: true })}\n${original}${"\n".repeat(512)}`, "utf8");
  const second = await parseCodexRollout(activePath, { dedupNamespaceKey, cursor: first.cursor });
  assert.equal(second.cursor.fileIdentity, first.cursor.fileIdentity);
  assert.equal(first.events.length, 0);
  assert.equal(first.ambiguousLineage, 1);
  assert.equal(second.events.length, 0);
  assert.equal(second.ambiguousLineage, 1);
});

test("Codex IDs distinguish separate eligible token records at the same timestamp", async (context) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "tag-plugin-codex-same-time-test-"));
  context.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const activePath = path.join(temporary, "rollout-00000000-0000-4000-8000-000000000001.jsonl");
  const usageRecord = (cumulativeTotal, input, output) => ({
    timestamp: "2026-07-19T10:00:02.000Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: { total_tokens: cumulativeTotal },
        last_token_usage: {
          input_tokens: input,
          output_tokens: output,
          total_tokens: input + output
        }
      }
    }
  });
  await fs.writeFile(activePath, [
    { type: "session_meta", payload: { id: "00000000-0000-4000-8000-000000000001" } },
    { type: "turn_context", payload: { model: "gpt-5.6-sol" } },
    usageRecord(15, 10, 5),
    usageRecord(31, 10, 6)
  ].map(JSON.stringify).join("\n") + "\n", "utf8");
  const parsed = await parseCodexRollout(activePath, { dedupNamespaceKey });
  assert.equal(parsed.events.length, 2);
  assert.notEqual(parsed.events[0].eventId, parsed.events[1].eventId);
});

test("Codex IDs survive replacement that changes only a non-usage header", async (context) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "tag-plugin-codex-header-replace-test-"));
  context.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const activePath = path.join(temporary, "rollout-00000000-0000-4000-8000-000000000001.jsonl");
  const replacementPath = path.join(temporary, "replacement.jsonl");
  const original = await fs.readFile(path.join(fixtureDirectory, "codex-rollout.jsonl"), "utf8");
  await fs.writeFile(activePath, `${JSON.stringify({ type: "trace", label: "before" })}\n${original}`, "utf8");
  const first = await parseCodexRollout(activePath, { dedupNamespaceKey });
  await fs.writeFile(
    replacementPath,
    `${JSON.stringify({ type: "trace", label: "after" })}\n${original}${"\n".repeat(512)}`,
    "utf8"
  );
  await fs.rm(activePath);
  await fs.rename(replacementPath, activePath);
  const second = await parseCodexRollout(activePath, { dedupNamespaceKey, cursor: first.cursor });
  assert.notEqual(second.cursor.fileIdentity, first.cursor.fileIdentity);
  assert.deepEqual(
    second.events.map((event) => event.eventId),
    first.events.map((event) => event.eventId)
  );
});

test("Kimi prefix verification catches an earlier in-place rewrite when the last usage record is unchanged", async (context) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "tag-plugin-kimi-prefix-rewrite-test-"));
  context.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const activePath = path.join(temporary, "wire.jsonl");
  const firstLine = JSON.stringify({
    type: "usage.record",
    time: "2026-07-19T12:00:01.000Z",
    model: "kimi-code/kimi-for-coding-highspeed",
    usage: { inputOther: 12, inputCacheRead: 7, inputCacheCreation: 3, output: 20 },
    usageScope: "turn"
  });
  const secondLine = JSON.stringify({
    type: "usage.record",
    time: "2026-07-19T12:00:02.000Z",
    model: "kimi-code/kimi-for-coding-highspeed",
    usage: { inputOther: 14, inputCacheRead: 7, inputCacheCreation: 3, output: 20 },
    usageScope: "turn"
  });
  await fs.writeFile(activePath, `${firstLine}\n${secondLine}\n`, "utf8");
  const options = {
    stableJournalIdentity: "stable-kimi-session-agent",
    dedupNamespaceKey
  };
  const first = await parseKimiWire(activePath, options);
  const changedFirstLine = firstLine.replace('"output":20', '"output":21');
  assert.equal(changedFirstLine.length, firstLine.length);
  await fs.writeFile(activePath, `${changedFirstLine}\n${secondLine}\n${"\n".repeat(512)}`, "utf8");
  const second = await parseKimiWire(activePath, { ...options, cursor: first.cursor });
  assert.equal(second.cursor.fileIdentity, first.cursor.fileIdentity);
  assert.equal(second.events.length, 2);
  assert.equal(second.events[0].usage.output, 21);
  assert.notEqual(second.cursor.usagePrefixDigest, first.cursor.usagePrefixDigest);
});

test("journal readers discard an oversized line and continue at the next newline", async (context) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "tag-plugin-journal-line-cap-test-"));
  context.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const activePath = path.join(temporary, "wire.jsonl");
  const usageLine = JSON.stringify({
    type: "usage.record",
    time: "2026-07-19T12:00:01.000Z",
    model: "kimi-code/kimi-for-coding-highspeed",
    usage: { inputOther: 12, inputCacheRead: 7, inputCacheCreation: 3, output: 20 },
    usageScope: "turn"
  });
  await fs.writeFile(activePath, `${"x".repeat(MAX_JOURNAL_LINE_BYTES + 1)}\n${usageLine}\n`, "utf8");
  const parsed = await parseKimiWire(activePath, {
    stableJournalIdentity: "stable-kimi-session-agent",
    dedupNamespaceKey
  });
  assert.equal(parsed.malformed, 1);
  assert.equal(parsed.events.length, 1);
  assert.equal(parsed.cursor.offset, (await fs.stat(activePath)).size);
});
