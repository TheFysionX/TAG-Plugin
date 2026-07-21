import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_LOCK_STALE_MS } from "../src/constants.mjs";
import { acquireLock } from "../src/lock.mjs";
import { runtimePaths } from "../src/paths.mjs";
import {
  atomicWriteJson,
  cleanupStaleAtomicWriteTemps,
  ensureRuntimeDirectory
} from "../src/state.mjs";

async function temporaryDirectory(context, prefix) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function exists(filePath) {
  return fs.lstat(filePath).then(() => true).catch((error) => {
    if (error?.code === "ENOENT") return false;
    throw error;
  });
}

async function writeAt(filePath, modifiedAt, contents = "temporary") {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents, "utf8");
  await fs.utimes(filePath, modifiedAt, modifiedAt);
}

test("locked cleanup removes only stale exact atomic JSON temps inside connector home", async (context) => {
  const parent = await temporaryDirectory(context, "tag-plugin-atomic-cleanup-");
  const home = path.join(parent, "connector-home");
  const outside = path.join(parent, "outside");
  const paths = runtimePaths({ home });
  await ensureRuntimeDirectory(paths);
  await fs.mkdir(outside, { recursive: true });

  const now = Date.now();
  const staleAt = new Date(now - DEFAULT_LOCK_STALE_MS - 5_000);
  const freshAt = new Date(now - 1_000);
  const staleRootFiles = [
    ".state.json.910001.abcdef123456.tmp",
    ".config.json.910002.abcdef123456.tmp",
    ".device-secrets.json.910003.abcdef123456.tmp"
  ].map((name) => path.join(home, name));
  const soleRecoveryCopy = path.join(home, ".pending-device-secrets.json.910004.abcdef123456.tmp");
  await Promise.all([
    ...staleRootFiles.map((filePath) => writeAt(filePath, staleAt)),
    writeAt(soleRecoveryCopy, staleAt),
    writeAt(paths.state, freshAt, "{}\n"),
    writeAt(paths.config, freshAt, "{}\n"),
    writeAt(paths.secrets, freshAt, "{}\n")
  ]);

  const fresh = path.join(home, ".state.json.910005.abcdef123456.tmp");
  const liveWriter = path.join(home, ".state.json.910006.abcdef123456.tmp");
  const malformed = path.join(home, ".state.json.910007.not-a-nonce.tmp");
  const unrelated = path.join(home, ".notes.json.910008.abcdef123456.tmp");
  const nonCanonicalPid = path.join(home, ".state.json.0910009.abcdef123456.tmp");
  const exactDirectory = path.join(home, ".state.json.910010.abcdef123456.tmp");
  await Promise.all([
    writeAt(fresh, freshAt),
    writeAt(liveWriter, staleAt),
    writeAt(malformed, staleAt),
    writeAt(unrelated, staleAt),
    writeAt(nonCanonicalPid, staleAt),
    fs.mkdir(exactDirectory)
  ]);

  const batch = path.join(home, "sync-pages", "a".repeat(24));
  const staleSyncPage = path.join(batch, ".000001.json.910011.abcdef123456.tmp");
  const freshSyncPage = path.join(batch, ".000002.json.910012.abcdef123456.tmp");
  const nonCanonicalSyncPage = path.join(batch, ".0000001.json.910013.abcdef123456.tmp");
  const soleSyncRecoveryCopy = path.join(batch, ".000003.json.910016.abcdef123456.tmp");
  const malformedBatchPage = path.join(home, "sync-pages", "not-a-batch", ".000001.json.910014.abcdef123456.tmp");
  await Promise.all([
    writeAt(path.join(batch, "000001.json"), freshAt, "{}\n"),
    writeAt(staleSyncPage, staleAt),
    writeAt(freshSyncPage, freshAt),
    writeAt(nonCanonicalSyncPage, staleAt),
    writeAt(soleSyncRecoveryCopy, staleAt),
    writeAt(malformedBatchPage, staleAt)
  ]);

  const outsideCandidate = path.join(outside, ".state.json.910015.abcdef123456.tmp");
  await writeAt(outsideCandidate, staleAt);
  const release = await acquireLock(paths.lock);
  let result;
  try {
    result = await cleanupStaleAtomicWriteTemps(
      { ...paths, state: outsideCandidate },
      {
        ownerToken: release.ownerToken,
        now,
        processKill(pid) {
          if (pid === 910006) return;
          const error = new Error("process not found");
          error.code = "ESRCH";
          throw error;
        }
      }
    );
  } finally {
    await release();
  }

  assert.equal(result.removed, 4);
  assert.equal(result.truncated, false);
  for (const filePath of [...staleRootFiles, staleSyncPage]) {
    assert.equal(await exists(filePath), false, `${filePath} should be removed`);
  }
  for (const filePath of [
    fresh,
    liveWriter,
    soleRecoveryCopy,
    malformed,
    unrelated,
    nonCanonicalPid,
    exactDirectory,
    freshSyncPage,
    nonCanonicalSyncPage,
    soleSyncRecoveryCopy,
    malformedBatchPage,
    outsideCandidate
  ]) {
    assert.equal(await exists(filePath), true, `${filePath} should be preserved`);
  }
});

test("cleanup fails closed without the canonical lock ownership proof", async (context) => {
  const home = await temporaryDirectory(context, "tag-plugin-atomic-no-lock-");
  const paths = runtimePaths({ home });
  await ensureRuntimeDirectory(paths);
  const candidate = path.join(home, ".state.json.920001.abcdef123456.tmp");
  const staleAt = new Date(Date.now() - DEFAULT_LOCK_STALE_MS - 5_000);
  await writeAt(candidate, staleAt);

  await assert.rejects(
    () => cleanupStaleAtomicWriteTemps(paths, { ownerToken: "not-the-real-owner" }),
    (error) => error?.code === "ATOMIC_TEMP_CLEANUP_UNSAFE"
  );
  assert.equal(await exists(candidate), true);
});

test("atomic JSON write removes its temporary file after an ordinary write failure", async (context) => {
  const home = await temporaryDirectory(context, "tag-plugin-atomic-failure-");
  const occupiedDirectory = path.join(home, "state.json");
  await fs.mkdir(occupiedDirectory, { recursive: true });

  await assert.rejects(() => atomicWriteJson(occupiedDirectory, { value: "large" }));
  const leftovers = (await fs.readdir(home)).filter((name) => /^\.state\.json\..+\.tmp$/.test(name));
  assert.deepEqual(leftovers, []);
  assert.equal((await fs.lstat(occupiedDirectory)).isDirectory(), true);
});

test("simulated Windows replacement failure preserves canonical JSON and removes only its temp", async (context) => {
  const home = await temporaryDirectory(context, "tag-plugin-atomic-windows-failure-");
  const canonical = path.join(home, "state.json");
  const prior = "{\"committed\":true}\n";
  await fs.writeFile(canonical, prior, "utf8");
  let renameCalls = 0;

  await assert.rejects(
    () => atomicWriteJson(canonical, { committed: false }, 0o600, {
      platform: "win32",
      sleep: async () => {},
      async rename(temporary, destination) {
        renameCalls += 1;
        assert.equal(destination, canonical);
        assert.match(await fs.readFile(temporary, "utf8"), /\"committed\": false/);
        const error = new Error("destination is busy");
        error.code = "EPERM";
        throw error;
      }
    }),
    (error) => error?.code === "EPERM"
  );

  assert.equal(renameCalls, 5);
  assert.equal(await fs.readFile(canonical, "utf8"), prior);
  const leftovers = (await fs.readdir(home)).filter((name) => /^\.state\.json\..+\.tmp$/.test(name));
  assert.deepEqual(leftovers, []);
});
