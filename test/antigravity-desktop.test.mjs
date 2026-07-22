import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHash, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  detectAntigravityDesktopVersion,
  discoverAntigravityDesktopDatabases,
  parseAntigravityDesktopDatabase
} from "../src/adapters/antigravity-desktop.mjs";
import { collectUsage, toWireEvent } from "../src/collector.mjs";
import { initialState } from "../src/state.mjs";

const localAliasKey = randomBytes(32).toString("base64");
const dedupNamespaceKey = randomBytes(32).toString("base64url");

function varint(value) {
  let remaining = BigInt(value);
  const parts = [];
  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining > 0n) byte |= 0x80;
    parts.push(byte);
  } while (remaining > 0n);
  return Buffer.from(parts);
}

function field(number, value) {
  return Buffer.concat([varint(number * 8), varint(value)]);
}

function bytes(number, value) {
  return Buffer.concat([varint(number * 8 + 2), varint(value.length), value]);
}

function timestamp(seconds, nanos = 0) {
  return Buffer.concat([field(1, seconds), field(2, nanos)]);
}

function modelUsage({ model = 1084, input = 0, output = 0, cacheWrite = 0, cacheRead = 0, apiProvider = 0, thinking = 0, response = null } = {}) {
  return Buffer.concat([
    field(1, model), field(2, input), field(3, output), field(4, cacheWrite),
    field(5, cacheRead), field(6, apiProvider), field(9, thinking),
    ...(response === null ? [] : [field(10, response)])
  ]);
}

function metadata(usage, seconds = 1_700_000_000, timestampField = 8) {
  return Buffer.concat([bytes(timestampField, timestamp(seconds)), bytes(9, modelUsage(usage))]);
}

async function fixtureDatabase(rows, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tag-antigravity-desktop-"));
  const conversations = path.join(root, "conversations");
  await fs.mkdir(conversations);
  const databasePath = path.join(conversations, "conversation.db");
  const database = new DatabaseSync(databasePath);
  database.exec(`CREATE TABLE steps (
    idx INTEGER PRIMARY KEY,
    status INTEGER,
    metadata BLOB,
    step_payload BLOB,
    render_info BLOB,
    private_prompt TEXT
  )`);
  const insert = database.prepare("INSERT INTO steps(idx, status, metadata, step_payload, render_info, private_prompt) VALUES (?, ?, ?, ?, ?, ?)");
  const payloadBytes = Number.isSafeInteger(options.payloadBytes) && options.payloadBytes >= 0
    ? options.payloadBytes
    : 1024 * 1024;
  database.exec("BEGIN TRANSACTION");
  try {
    for (const row of rows) {
      insert.run(row.idx, row.status, row.metadata, Buffer.alloc(payloadBytes, 0x51), Buffer.alloc(payloadBytes, 0x52), "SECRET_PROMPT_CANARY");
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  database.close();
  return { root, conversations, databasePath };
}

async function parse(databasePath, options = {}) {
  return parseAntigravityDesktopDatabase(databasePath, {
    localAliasKey,
    dedupNamespaceKey,
    desktopVersion: "2.3.1",
    ...options
  });
}

async function writeAsarWithPackage(filePath, packageJson, integrityMode = "valid") {
  const packageBuffer = Buffer.from(JSON.stringify(packageJson), "utf8");
  const header = {
    files: {
      "package.json": {
        size: packageBuffer.length,
        offset: "0",
        ...(integrityMode === "missing" ? {} : {
          integrity: {
            algorithm: integrityMode === "wrong_algorithm" ? "SHA1" : "SHA256",
            hash: integrityMode === "bad_hash"
              ? "0".repeat(64)
              : createHash("sha256").update(packageBuffer).digest("hex")
          }
        })
      }
    }
  };
  const headerBuffer = Buffer.from(JSON.stringify(header), "utf8");
  const headerPickleBytes = Math.ceil((8 + headerBuffer.length) / 4) * 4;
  const contentOffset = 8 + headerPickleBytes;
  const archive = Buffer.alloc(contentOffset + packageBuffer.length);
  archive.writeUInt32LE(4, 0);
  archive.writeUInt32LE(headerPickleBytes, 4);
  archive.writeUInt32LE(headerPickleBytes - 4, 8);
  archive.writeUInt32LE(headerBuffer.length, 12);
  headerBuffer.copy(archive, 16);
  packageBuffer.copy(archive, contentOffset);
  await fs.writeFile(filePath, archive);
}

test("desktop version detection reads only the integrity-checked app package and fails closed", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tag-antigravity-version-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const supported = path.join(root, "supported.asar");
  const unsupported = path.join(root, "unsupported.asar");
  const missingIntegrity = path.join(root, "missing-integrity.asar");
  const badDigest = path.join(root, "bad-digest.asar");
  await writeAsarWithPackage(supported, { name: "antigravity", productName: "Antigravity", version: "2.3.1" });
  await writeAsarWithPackage(unsupported, { name: "antigravity", productName: "Antigravity", version: "2.4.0" });
  await writeAsarWithPackage(missingIntegrity, { name: "antigravity", productName: "Antigravity", version: "2.3.1" }, "missing");
  await writeAsarWithPackage(badDigest, { name: "antigravity", productName: "Antigravity", version: "2.3.1" }, "bad_hash");
  assert.deepEqual(await detectAntigravityDesktopVersion({ appAsarPaths: [supported] }), { status: "supported", version: "2.3.1" });
  assert.deepEqual(await detectAntigravityDesktopVersion({ appAsarPaths: [unsupported] }), {
    status: "unsupported", version: "2.4.0", reason: "unsupported_desktop_version"
  });
  assert.deepEqual(await detectAntigravityDesktopVersion({ appAsarPaths: [path.join(root, "missing.asar")] }), {
    status: "unavailable", version: null, reason: "desktop_version_not_found"
  });
  assert.deepEqual(await detectAntigravityDesktopVersion({ appAsarPaths: [missingIntegrity, badDigest] }), {
    status: "unavailable", version: null, reason: "desktop_version_not_found"
  });
});

test("Antigravity desktop parser extracts only completed, allowlisted usage", async (context) => {
  const fixture = await fixtureDatabase([
    { idx: 1, status: 3, metadata: metadata({ input: 100, output: 47, cacheWrite: 10, cacheRead: 20, thinking: 7, response: 40 }) },
    { idx: 2, status: 2, metadata: metadata({ input: 999, output: 999 }) },
    { idx: 3, status: 3, metadata: Buffer.from([0xff]) },
    { idx: 4, status: 3, metadata: bytes(8, timestamp(1_700_000_000)) }
  ]);
  context.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const result = await parse(fixture.databasePath);
  assert.equal(result.status, "available_version_pinned");
  assert.equal(result.captures, 1);
  assert.equal(result.malformed, 1);
  assert.equal(result.events.length, 1);
  const event = result.events[0];
  assert.equal(event.sourceModelId, "gemini-3.5-flash-high");
  assert.equal(event.modelId, "gemini-3.5-flash");
  assert.equal(event.mode.fast, false);
  assert.equal(event.mode.classified, true);
  assert.deepEqual(event.usage, {
    input: 100, cachedInput: 20, cacheWriteInput: 10, output: 47, reasoningOutput: 7, total: 177
  });
  assert.equal(event.provenance.collector, "antigravity_desktop_sqlite_v1");
  assert.doesNotMatch(JSON.stringify(result), /SECRET_PROMPT_CANARY|conversation\.db|step_payload|render_info/i);
  const unverified = await parseAntigravityDesktopDatabase(fixture.databasePath, { localAliasKey, dedupNamespaceKey });
  assert.equal(unverified.reason, "desktop_version_not_verified");
});

test("desktop output already includes thinking and an inconsistent component split fails raw-only", async (context) => {
  const fixture = await fixtureDatabase([
    { idx: 11, status: 3, metadata: metadata({ input: 100, output: 20, thinking: 7, response: 5 }) }
  ]);
  context.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const result = await parse(fixture.databasePath);
  assert.equal(result.events.length, 1);
  assert.equal(result.malformed, 1);
  assert.equal(result.events[0].usage.output, 20);
  assert.equal(result.events[0].usage.reasoningOutput, 7);
  assert.equal(result.events[0].usage.total, 120);
  assert.equal(result.events[0].usage.componentConflict, true);
  const wire = toWireEvent(result.events[0]);
  assert.equal(wire.attribution, "raw_only");
  assert.equal(wire.inputTokens, "120");
  assert.equal(wire.outputTokens, "0");
});

test("unknown model enums stay raw-only and duplicate usage rows remain distinct", async (context) => {
  const fixture = await fixtureDatabase([
    { idx: 21, status: 3, metadata: metadata({ model: 1050, input: 12, output: 8 }) },
    { idx: 22, status: 3, metadata: metadata({ model: 1050, input: 12, output: 8 }) }
  ]);
  context.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const result = await parse(fixture.databasePath);
  assert.equal(result.events.length, 2);
  assert.notEqual(result.events[0].eventId, result.events[1].eventId);
  assert.equal(result.events[0].sourceModelId, "antigravity-model-enum-1050");
  assert.equal(result.events[0].modelId, null);
  assert.equal(result.events[0].mode.classified, false);
  assert.equal(result.events[0].usage.total, 20);
});

test("an initial cursor uses -1 so a legitimate idx zero completed row is collected", async (context) => {
  const fixture = await fixtureDatabase([
    { idx: 0, status: 3, metadata: metadata({ input: 9, output: 4 }) }
  ]);
  context.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const first = await parse(fixture.databasePath);
  assert.equal(first.events.length, 1);
  assert.equal(first.cursor.highWatermark, 0);
  const replay = await parse(fixture.databasePath, { cursor: first.cursor });
  assert.equal(replay.events.length, 0);
});

test("timestamp fallback, bounds, and cursor replay are deterministic without raw identifiers", async (context) => {
  const fixture = await fixtureDatabase([
    { idx: 41, status: 3, metadata: metadata({ model: 1035, input: 4, output: 5 }, 1_700_000_000, 7) },
    { idx: 42, status: 3, metadata: metadata({ input: 1, output: 1 }, 1_700_000_100) }
  ]);
  context.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const first = await parse(fixture.databasePath, { maximumEvents: 1 });
  assert.equal(first.events.length, 1);
  assert.equal(first.events[0].provider, "claude");
  assert.equal(first.events[0].observedAt, "2023-11-14T22:13:20.000Z");
  assert.equal(first.cursor.highWatermark, 42);
  assert.deepEqual(first.cursor.pending, [{ index: 42, status: "completed" }]);
  assert.equal(first.cursor.conversationAlias.includes("conversation.db"), false);
  assert.deepEqual(Object.keys(first.cursor).sort(), ["conversationAlias", "fileIdentity", "highWatermark", "pending", "schemaIdentity", "version"]);
  const resumed = await parse(fixture.databasePath, { cursor: first.cursor });
  assert.equal(resumed.events.length, 1);
  assert.equal(resumed.events[0].sourceModelId, "gemini-3.5-flash-high");
  const replaced = await parse(fixture.databasePath, {
    cursor: { ...resumed.cursor, fileIdentity: "f".repeat(64) }
  });
  assert.equal(replaced.events.length, 2);
  const bounded = await parse(fixture.databasePath, {
    minimumObservedAtInclusive: "2023-11-14T22:14:00.000Z"
  });
  assert.equal(bounded.events.length, 1);
  assert.equal(bounded.events[0].observedAt, "2023-11-14T22:15:00.000Z");
});

test("discovery is non-recursive and handles missing roots safely", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tag-antigravity-discovery-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "one.db"), "");
  await fs.mkdir(path.join(root, "nested"));
  await fs.writeFile(path.join(root, "nested", "hidden.db"), "");
  const found = await discoverAntigravityDesktopDatabases(root);
  assert.deepEqual(found.files.map((file) => path.basename(file)), ["one.db"]);
  const absent = await discoverAntigravityDesktopDatabases(path.join(root, "none"));
  assert.deepEqual(absent, { status: "unavailable", reason: "not_installed", truncated: false, files: [] });
  const unspecified = await discoverAntigravityDesktopDatabases(undefined);
  assert.deepEqual(unspecified, { status: "unavailable", reason: "not_installed", truncated: false, files: [] });
  await fs.writeFile(path.join(root, "two.db"), "");
  const exact = await discoverAntigravityDesktopDatabases(root, { maximumFiles: 2 });
  assert.equal(exact.truncated, false);
  await fs.writeFile(path.join(root, "three.db"), "");
  const bounded = await discoverAntigravityDesktopDatabases(root, { maximumFiles: 2 });
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.files.length, 2);
});

test("high-watermark cursor advances beyond ten thousand rows and later steps emit exactly once", async (context) => {
  const initialRows = Array.from({ length: 10_005 }, (_, offset) => ({
    idx: offset + 1,
    status: 3,
    metadata: metadata({ input: 1, output: 1 })
  }));
  const fixture = await fixtureDatabase(initialRows, { payloadBytes: 0 });
  context.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const fragmented = await parse(fixture.databasePath, { maximumEvents: 0 });
  assert.equal(fragmented.status, "partial");
  assert.equal(fragmented.reason, "pending_cap");
  assert.equal(fragmented.cursor.pending.length, 10_000);
  assert.equal(fragmented.cursor.highWatermark, 10_000);
  const first = await parse(fixture.databasePath);
  assert.equal(first.events.length, 10_005);
  assert.equal(first.cursor.highWatermark, 10_005);
  assert.deepEqual(first.cursor.pending, []);
  const database = new DatabaseSync(fixture.databasePath);
  database.prepare("INSERT INTO steps(idx, status, metadata, step_payload, render_info, private_prompt) VALUES (?, ?, ?, ?, ?, ?)")
    .run(10_006, 3, metadata({ input: 3, output: 2 }), Buffer.alloc(0), Buffer.alloc(0), "SECRET_PROMPT_CANARY");
  database.close();
  const second = await parse(fixture.databasePath, { cursor: first.cursor });
  assert.equal(second.events.length, 1);
  assert.equal(second.cursor.highWatermark, 10_006);
  const third = await parse(fixture.databasePath, { cursor: second.cursor });
  assert.equal(third.events.length, 0);
  assert.equal(third.cursor.highWatermark, 10_006);
});

test("collection uses HMAC file cursors, aggregates desktop usage, and holds only unsupported rate-card models raw-only", async (context) => {
  const fixture = await fixtureDatabase([
    { idx: 81, status: 3, metadata: metadata({ model: 1084, input: 50, output: 10 }, 1_700_000_000) },
    { idx: 82, status: 3, metadata: metadata({ model: 1264, input: 10, output: 5 }, 1_700_000_000) }
  ]);
  context.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const collection = await collectUsage({
    roots: {
      codex: path.join(fixture.root, "codex"),
      claude: path.join(fixture.root, "claude"),
      kimi: path.join(fixture.root, "kimi"),
      antigravity: path.join(fixture.root, "missing-statusline.jsonl"),
      antigravityDesktop: fixture.conversations,
      grok: path.join(fixture.root, "grok")
    },
    state: initialState(),
    secrets: { localAliasKey },
    dedupNamespaceKey,
    enabledFallbacks: { gemini: true },
    enabledProviders: { gemini: true },
    detectAntigravityDesktopVersion: async () => ({ status: "supported", version: "2.3.1" }),
    aggregateRanges: {
      gemini: { start: "2023-11-14T00:00:00.000Z", end: "2023-11-15T00:00:00.000Z" }
    }
  });
  assert.equal(collection.stats.gemini.status, "available_version_pinned");
  assert.equal(collection.providerScans.gemini.coverage, "complete");
  assert.equal(collection.providerScans.gemini.historicalCompleteness, "retained_completed_metadata_only");
  assert.equal(collection.events.length, 2);
  const gemini35 = collection.events.find((event) => event.sourceModelId === "gemini-3.5-flash-high");
  const gemini36 = collection.events.find((event) => event.sourceModelId === "gemini-3.6-flash-high");
  assert.equal(gemini35.modelId, "gemini-3.5-flash");
  assert.equal(gemini35.mode.fast, false);
  assert.equal(gemini35.mode.classified, true);
  assert.equal(toWireEvent(gemini35).attribution, undefined);
  assert.equal(gemini36.modelId, null);
  assert.equal(gemini36.mode.classified, false);
  assert.equal(toWireEvent(gemini36).attribution, "raw_only");
  const [fileAlias, cursor] = Object.entries(collection.nextCursors.antigravity.files)[0];
  assert.match(fileAlias, /^[a-f0-9]{64}$/);
  assert.match(cursor.conversationAlias, /^[a-f0-9]{64}$/);
  assert.match(cursor.fileIdentity, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(collection.nextCursors.antigravity.files), /conversation\.db/);
});
