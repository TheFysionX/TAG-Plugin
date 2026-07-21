import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { discoverJsonlFiles } from "../src/discovery.mjs";
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
    version: 2,
    providers: {
      codex: { through: null },
      claude: { through: null },
      kimi: { through: null }
    }
  });
});

test("loading a v2 aggregate cursor preserves and normalizes provider watermarks independently", async (context) => {
  const home = await temporaryDirectory(context, "tag-plugin-state-v2-");
  const paths = runtimePaths({ home });
  const state = initialState();
  state.cursors.aggregate = {
    version: 2,
    providers: {
      codex: { through: "2026-07-19T01:02:03Z" },
      claude: { through: "2026-07-19T04:05:06-05:00" },
      kimi: { through: "2026-07-20T00:00:00.250Z" }
    }
  };
  await saveRuntime(paths, { state, config: initialConfig() });

  const loaded = await loadRuntime(paths);

  assert.deepEqual(loaded.state.cursors.aggregate, {
    version: 2,
    providers: {
      codex: { through: "2026-07-19T01:02:03.000Z" },
      claude: { through: "2026-07-19T09:05:06.000Z" },
      kimi: { through: "2026-07-20T00:00:00.250Z" }
    }
  });
});

test("loading pre-v4 Codex accounting resets only Codex generation state", async (context) => {
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

  assert.deepEqual(loaded.state.cursors.codex, { accountingVersion: 4, files: {}, sessions: {} });
  assert.equal(loaded.state.cursors.aggregate.providers.codex.through, null);
  assert.equal(loaded.state.providerEvidenceHashes.codex, undefined);
  assert.equal(loaded.state.cursors.aggregate.providers.claude.through, "2026-07-19T02:00:00.000Z");
  assert.deepEqual(loaded.state.cursors.claude.seen.preserved, { hash: "b".repeat(64), lastSeenAt: 2 });
  assert.equal(loaded.state.providerEvidenceHashes.claude, "preserved-checkpoint");
});
