import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { discoverJsonlFiles } from "../src/discovery.mjs";
import { payloadHash } from "../src/crypto.mjs";
import { runtimePaths } from "../src/paths.mjs";
import { initialConfig, initialState, loadRuntime, saveRuntime } from "../src/state.mjs";

async function temporaryDirectory(context, prefix) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test("JSONL discovery does not report truncation at the exact file limit", async (context) => {
  const root = await temporaryDirectory(context, "tag-plugin-discovery-limit-");
  const nested = path.join(root, "nested");
  await fs.mkdir(nested, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(root, "a.jsonl"), "", "utf8"),
    fs.writeFile(path.join(nested, "b.JSONL"), "", "utf8"),
    fs.writeFile(path.join(root, "ignored.txt"), "", "utf8")
  ]);

  const discovered = await discoverJsonlFiles(root, { maximum: 2 });

  assert.equal(discovered.unavailable, false);
  assert.equal(discovered.truncated, false);
  assert.deepEqual(discovered.files, [
    path.join(root, "a.jsonl"),
    path.join(nested, "b.JSONL")
  ].sort((left, right) => left.localeCompare(right)));
});

test("JSONL discovery reports truncation only after observing maximum plus one", async (context) => {
  const root = await temporaryDirectory(context, "tag-plugin-discovery-overflow-");
  await Promise.all(["a.jsonl", "b.jsonl", "c.jsonl"].map((name) =>
    fs.writeFile(path.join(root, name), "", "utf8")
  ));

  const discovered = await discoverJsonlFiles(root, { maximum: 2 });

  assert.equal(discovered.unavailable, false);
  assert.equal(discovered.truncated, true);
  assert.deepEqual(discovered.files, [
    path.join(root, "a.jsonl"),
    path.join(root, "b.jsonl")
  ]);
});

test("JSONL discovery marks a missing root unavailable without truncation", async (context) => {
  const parent = await temporaryDirectory(context, "tag-plugin-discovery-missing-");
  const discovered = await discoverJsonlFiles(path.join(parent, "does-not-exist"), { maximum: 2 });

  assert.deepEqual(discovered.files, []);
  assert.equal(discovered.unavailable, true);
  assert.equal(discovered.truncated, false);
});

test("loading preserves the bounded Antigravity v2 high-watermark cursor", async (context) => {
  const home = await temporaryDirectory(context, "tag-plugin-antigravity-cursor-v2-");
  const paths = runtimePaths({ home });
  const state = initialState();
  const fileAlias = "a".repeat(64);
  state.cursors.antigravity.files[fileAlias] = {
    version: 2,
    conversationAlias: "b".repeat(64),
    fileIdentity: "c".repeat(64),
    schemaIdentity: "d".repeat(64),
    highWatermark: 10_012,
    pending: [
      { index: 10_012, status: "completed" },
      { index: 7, status: "open" }
    ],
    lastSeenAt: 123
  };
  await saveRuntime(paths, { state, config: initialConfig() });

  const loaded = await loadRuntime(paths);

  assert.deepEqual(loaded.state.cursors.antigravity.files[fileAlias], {
    version: 2,
    conversationAlias: "b".repeat(64),
    fileIdentity: "c".repeat(64),
    schemaIdentity: "d".repeat(64),
    highWatermark: 10_012,
    pending: [
      { index: 7, status: "open" },
      { index: 10_012, status: "completed" }
    ],
    lastSeenAt: 123
  });
});

test("loading a legacy global aggregate cursor resets every provider watermark", async (context) => {
  const home = await temporaryDirectory(context, "tag-plugin-state-v1-");
  const paths = runtimePaths({ home });
  const state = initialState();
  state.cursors.aggregate = {
    version: 1,
    windowStart: "2026-06-15T00:00:00.000Z",
    through: "2026-07-19T12:00:00.000Z"
  };
  await saveRuntime(paths, { state, config: initialConfig() });

  const loaded = await loadRuntime(paths);

  assert.deepEqual(loaded.state.cursors.aggregate, {
    version: 3,
    providers: {
      codex: { through: null },
      claude: { through: null },
      gemini: { through: null },
      kimi: { through: null }
    }
  });
});

test("loading a v3 aggregate cursor preserves and normalizes provider watermarks independently", async (context) => {
  const home = await temporaryDirectory(context, "tag-plugin-state-v2-");
  const paths = runtimePaths({ home });
  const state = initialState();
  state.cursors.aggregate = {
    version: 3,
    providers: {
      codex: { through: "2026-07-19T01:02:03Z" },
      claude: { through: "2026-07-19T04:05:06-05:00" },
      kimi: { through: "2026-07-20T00:00:00.250Z" }
    }
  };
  await saveRuntime(paths, { state, config: initialConfig() });

  const loaded = await loadRuntime(paths);

  assert.deepEqual(loaded.state.cursors.aggregate, {
    version: 3,
    providers: {
      codex: { through: "2026-07-19T01:02:03.000Z" },
      claude: { through: "2026-07-19T09:05:06.000Z" },
      gemini: { through: null },
      kimi: { through: "2026-07-20T00:00:00.250Z" }
    }
  });
});

test("loading preserves only a complete canonical Codex checkpoint generation snapshot", async (context) => {
  const home = await temporaryDirectory(context, "tag-plugin-codex-snapshot-state-");
  const paths = runtimePaths({ home });
  const state = initialState();
  const dailyValues = {
    "2026-07-18": "100",
    "2026-07-19": "200"
  };
  const snapshotDigest = payloadHash({
    provider: "codex",
    sourceScope: "codex_subscription_account",
    lifetimeTokens: "1234",
    dailyValues
  });
  state.codexCheckpointSnapshot = {
    version: 1,
    generationId: "a".repeat(64),
    snapshotDigest,
    lifetimeTokens: "1234",
    dailyValues
  };
  await saveRuntime(paths, { state, config: initialConfig() });

  const loaded = await loadRuntime(paths);

  assert.deepEqual(loaded.state.codexCheckpointSnapshot, {
    version: 1,
    generationId: "a".repeat(64),
    snapshotDigest,
    lifetimeTokens: "1234",
    dailyValues: {
      "2026-07-18": "100",
      "2026-07-19": "200"
    }
  });
});

test("loading discards a torn Codex checkpoint snapshot instead of inventing lineage", async (context) => {
  const home = await temporaryDirectory(context, "tag-plugin-codex-snapshot-torn-");
  const paths = runtimePaths({ home });
  const state = initialState();
  state.codexCheckpointSnapshot = {
    version: 1,
    generationId: "a".repeat(64),
    snapshotDigest: "b".repeat(64),
    lifetimeTokens: "1234",
    dailyValues: { "2026-07-19": "200" }
  };
  await saveRuntime(paths, { state, config: initialConfig() });

  const loaded = await loadRuntime(paths);

  assert.deepEqual(loaded.state.codexCheckpointSnapshot, {
    version: 1,
    generationId: null,
    snapshotDigest: null,
    lifetimeTokens: null,
    dailyValues: {}
  });
});

test("loading pre-v5 Codex accounting resets only Codex generation state", async (context) => {
  const home = await temporaryDirectory(context, "tag-plugin-codex-accounting-v4-");
  const paths = runtimePaths({ home });
  const state = initialState();
  delete state.cursors.codex.accountingVersion;
  state.cursors.codex.files.old_file = { offset: 123 };
  state.cursors.codex.sessions = { ["a".repeat(64)]: { highWatermark: 999, lastSeenAt: 1 } };
  state.cursors.claude.seen.preserved = { hash: "b".repeat(64), lastSeenAt: 2 };
  state.cursors.aggregate.providers.codex.through = "2026-07-19T01:00:00.000Z";
  state.cursors.aggregate.providers.claude.through = "2026-07-19T02:00:00.000Z";
  state.providerEvidenceHashes = { codex: "old-checkpoint", claude: "preserved-checkpoint" };
  await saveRuntime(paths, { state, config: initialConfig() });

  const loaded = await loadRuntime(paths);

  assert.deepEqual(loaded.state.cursors.codex, { accountingVersion: 5, files: {}, sessions: {} });
  assert.equal(loaded.state.cursors.aggregate.providers.codex.through, null);
  assert.equal(loaded.state.providerEvidenceHashes.codex, undefined);
  assert.equal(loaded.state.cursors.aggregate.providers.claude.through, "2026-07-19T02:00:00.000Z");
  assert.deepEqual(loaded.state.cursors.claude.seen.preserved, { hash: "b".repeat(64), lastSeenAt: 2 });
  assert.equal(loaded.state.providerEvidenceHashes.claude, "preserved-checkpoint");
});

test("loading pre-v5 Claude accounting resets only Claude generation state", async (context) => {
  const home = await temporaryDirectory(context, "tag-plugin-claude-accounting-v4-");
  const paths = runtimePaths({ home });
  const state = initialState();
  delete state.cursors.claude.accountingVersion;
  state.cursors.claude.seen.legacy = { hash: "a".repeat(64), lastSeenAt: 1 };
  state.cursors.codex.files.preserved = { offset: 123, lastSeenAt: 2 };
  state.cursors.kimi.files.preserved = { offset: 456, lastSeenAt: 3 };
  state.cursors.aggregate.providers.codex.through = "2026-07-19T01:00:00.000Z";
  state.cursors.aggregate.providers.claude.through = "2026-07-19T02:00:00.000Z";
  state.cursors.aggregate.providers.kimi.through = "2026-07-19T03:00:00.000Z";
  state.providerEvidenceHashes = {
    codex: "preserved-codex-checkpoint",
    claude: "legacy-claude-checkpoint",
    kimi: "preserved-kimi-checkpoint"
  };
  await saveRuntime(paths, { state, config: initialConfig() });

  const loaded = await loadRuntime(paths);

  assert.deepEqual(loaded.state.cursors.claude, { accountingVersion: 5, seen: {} });
  assert.equal(loaded.state.cursors.aggregate.providers.claude.through, null);
  assert.equal(loaded.state.providerEvidenceHashes.claude, undefined);
  assert.deepEqual(loaded.state.cursors.codex.files.preserved, { offset: 123, lastSeenAt: 2 });
  assert.deepEqual(loaded.state.cursors.kimi.files.preserved, { offset: 456, lastSeenAt: 3 });
  assert.equal(loaded.state.cursors.aggregate.providers.codex.through, "2026-07-19T01:00:00.000Z");
  assert.equal(loaded.state.cursors.aggregate.providers.kimi.through, "2026-07-19T03:00:00.000Z");
  assert.equal(loaded.state.providerEvidenceHashes.codex, "preserved-codex-checkpoint");
  assert.equal(loaded.state.providerEvidenceHashes.kimi, "preserved-kimi-checkpoint");
});

test("v5 marks enabled legacy providers for one lossless raw-only backfill", async (context) => {
  const home = await temporaryDirectory(context, "tag-plugin-raw-only-backfill-");
  const paths = runtimePaths({ home });
  const state = initialState();
  state.cursors.codex = { accountingVersion: 4, files: { old: { offset: 1 } }, sessions: {} };
  state.cursors.claude = { accountingVersion: 4, seen: { old: { hash: "a".repeat(64), lastSeenAt: 1 } } };
  state.cursors.kimi = { files: { old: { offset: 1 } } };
  state.cursors.aggregate = {
    version: 2,
    providers: {
      codex: { through: "2026-07-20T01:00:00.000Z" },
      claude: { through: "2026-07-20T01:00:00.000Z" },
      kimi: { through: "2026-07-20T01:00:00.000Z" }
    }
  };
  state.nextSequence = 41;
  state.previousRequestDigest = "preserved_request_chain_digest";
  state.providerEvidenceHashes.codex = "legacy_mutable_checkpoint_snapshot";
  const config = initialConfig();
  config.transcriptFallbacks = { codex: true, claude: true, kimi: true };
  await saveRuntime(paths, { state, config });

  const loaded = await loadRuntime(paths);

  assert.deepEqual(loaded.state.cursors.codex, { accountingVersion: 5, files: {}, sessions: {} });
  assert.deepEqual(loaded.state.cursors.claude, { accountingVersion: 5, seen: {} });
  assert.deepEqual(loaded.state.cursors.kimi, { accountingVersion: 2, files: {} });
  assert.deepEqual(loaded.state.cursors.aggregate.providers, {
    codex: { through: null },
    claude: { through: null },
    gemini: { through: null },
    kimi: { through: null }
  });
  assert.deepEqual(loaded.state.rawOnlyBackfill.pendingProviders, ["codex", "claude", "kimi"]);
  assert.equal(loaded.state.providerEvidenceHashes.codex, undefined);
  assert.equal(loaded.state.nextSequence, 41);
  assert.equal(loaded.state.previousRequestDigest, "preserved_request_chain_digest");
});

test("legacy queue overflow remains pending until its eligible provider is actually rescanned", async (context) => {
  const home = await temporaryDirectory(context, "tag-plugin-overflow-backfill-");
  const paths = runtimePaths({ home });
  const state = initialState();
  state.cursors.kimi = { files: { legacy: { offset: 1 } } };
  state.unresolvedOverflow = {
    totalDropped: 17,
    lastOverflowAt: "2026-07-19T12:00:00.000Z"
  };
  const config = initialConfig();
  config.allowedPlatforms = ["kimi"];
  config.supportedProviders = ["kimi"];
  config.transcriptFallbacks = { codex: false, claude: false, kimi: false };
  await saveRuntime(paths, { state, config });

  const loaded = await loadRuntime(paths);

  assert.deepEqual(loaded.state.rawOnlyBackfill.pendingProviders, ["kimi"]);
  assert.equal(loaded.state.rawOnlyBackfill.completedAt, null);
  assert.equal(loaded.state.unresolvedOverflow.totalDropped, 17);
});
