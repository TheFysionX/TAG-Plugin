import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { acquireLock } from "../src/lock.mjs";
import { pause } from "../src/operations.mjs";
import { connectorHome, providerRoots, runtimePaths } from "../src/paths.mjs";
import { safeLog } from "../src/safe-log.mjs";
import { applyScheduler, removeScheduler, schedulerPlan } from "../src/scheduler.mjs";

test("Windows scheduler plan is branded, hourly, current-user-only, and has no elevation flags", () => {
  assert.equal(
    connectorHome({ LOCALAPPDATA: "C:/Local" }, "win32"),
    path.join("C:/Local", "The Artificial Games", "TAG Plugin")
  );
  assert.equal(
    connectorHome({ TAG_PLUGIN_HOME: "C:/tag-state", TOKENBOARD_CONNECTOR_HOME: "C:/legacy-state" }, "win32"),
    path.resolve("C:/tag-state")
  );
  assert.equal(
    connectorHome({ TOKENBOARD_CONNECTOR_HOME: "C:/legacy-state" }, "win32"),
    path.resolve("C:/legacy-state")
  );
  const roots = providerRoots({
    USERPROFILE: "C:/Users/test",
    TAG_PLUGIN_CODEX_ROOT: "C:/tag-codex",
    TOKENBOARD_CLAUDE_ROOT: "C:/legacy-claude",
    TAG_PLUGIN_KIMI_ROOT: "C:/tag-kimi"
  });
  assert.equal(roots.codex, path.resolve("C:/tag-codex"));
  assert.equal(roots.claude, path.resolve("C:/legacy-claude"));
  assert.equal(roots.kimi, path.resolve("C:/tag-kimi"));
  const plan = schedulerPlan({
    platform: "win32",
    home: "C:/Users/test/AppData/Local/The Artificial Games/TAG Plugin",
    nodeExecutable: "C:/Program Files/nodejs/node.exe",
    cliPath: "C:/Users/test/tag-plugin/src/cli.mjs",
    userHome: "C:/Users/test"
  });
  assert.equal(plan.currentUserOnly, true);
  assert.equal(plan.elevationRequired, false);
  assert.equal(plan.cadence, "hourly");
  assert.match(plan.create.arguments.join(" "), /\/RL LIMITED/);
  assert.match(plan.create.arguments.join(" "), /\/TN TAG Plugin/);
  assert.match(plan.create.arguments.join(" "), /scheduled-run --home/);
  assert.doesNotMatch(plan.create.arguments.join(" "), /SYSTEM|HIGHEST|\/RU/i);
});

test("repeated Windows uninstall ignores only the known missing-task outcome", async () => {
  const plan = schedulerPlan({
    platform: "win32",
    home: "C:/Users/test/AppData/Local/The Artificial Games/TAG Plugin",
    nodeExecutable: "C:/node/node.exe",
    cliPath: "C:/tag-plugin/src/cli.mjs",
    userHome: "C:/Users/test"
  });
  await removeScheduler(plan, {
    runCommand: async () => {
      const error = new Error("ERROR: The system cannot find the file specified.");
      error.stderr = "ERROR: The system cannot find the file specified.";
      throw error;
    }
  });
  await assert.rejects(() => removeScheduler(plan, {
    runCommand: async () => { throw new Error("Access is denied"); }
  }), /Access is denied/);
});

test("macOS reinstall bootouts an existing user job before atomic replacement", async (context) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "tag-plugin-macos-scheduler-test-"));
  context.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const commands = [];
  const plan = schedulerPlan({
    platform: "darwin",
    home: path.join(temporary, "state"),
    userHome: temporary,
    uid: 501,
    nodeExecutable: "/usr/local/bin/node",
    cliPath: path.join(temporary, "connector", "src", "cli.mjs")
  });
  await applyScheduler(plan, {
    runCommand: async (executable, args) => {
      commands.push([executable, ...args]);
      if (args[0] === "bootout") {
        const error = new Error("Could not find service");
        error.stderr = "Could not find service";
        throw error;
      }
    }
  });
  assert.equal(commands[0][1], "bootout");
  assert.equal(commands[1][1], "bootstrap");
  assert.match(plan.create.file, /com\.theartificialgames\.tag-plugin\.plist$/);
  assert.match(await fs.readFile(plan.create.file, "utf8"), /com\.theartificialgames\.tag-plugin/);
  assert.match(await fs.readFile(plan.create.file, "utf8"), /scheduled-run/);
  assert.match(await fs.readFile(plan.create.file, "utf8"), /<string>--home<\/string>/);
});

test("Linux scheduler apply/remove is injectable and only writes under the supplied user home", async (context) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "tag-plugin-scheduler-test-"));
  context.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const commands = [];
  const plan = schedulerPlan({
    platform: "linux",
    home: path.join(temporary, "state"),
    userHome: temporary,
    nodeExecutable: "/usr/bin/node",
    cliPath: path.join(temporary, "connector", "src", "cli.mjs")
  });
  const runCommand = async (executable, args) => commands.push([executable, ...args]);
  await applyScheduler(plan, { runCommand });
  const service = await fs.readFile(plan.create.serviceFile, "utf8");
  assert.match(plan.create.serviceFile, /tag-plugin\.service$/);
  assert.match(plan.create.timerFile, /tag-plugin\.timer$/);
  assert.match(service, /scheduled-run.*--home/);
  assert.equal(await fs.readFile(plan.create.timerFile, "utf8").then(() => true), true);
  assert.equal(commands.every((command) => command[1] === "--user"), true);
  await removeScheduler(plan, { runCommand });
  assert.equal(await fs.access(plan.create.serviceFile).then(() => true).catch(() => false), false);
  assert.equal(await fs.access(plan.create.timerFile).then(() => true).catch(() => false), false);
});

test("pause uses the same operation lock as sync and heartbeat", async (context) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "tag-plugin-pause-lock-test-"));
  context.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const paths = runtimePaths({ home: temporary });
  const release = await acquireLock(paths.lock);
  await assert.rejects(() => pause({ home: temporary }), /already running/);
  await release();
  assert.deepEqual(await pause({ home: temporary }), { paused: true });
});

test("overlap lock rejects a concurrent operation", async (context) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "tag-plugin-lock-test-"));
  context.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const lockPath = path.join(temporary, "connector.lock");
  const release = await acquireLock(lockPath);
  await assert.rejects(() => acquireLock(lockPath), /already running/);
  await release();
});

test("an active lease refreshed after more than fifteen minutes cannot be stolen", async (context) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "tag-plugin-lock-lease-test-"));
  context.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const lockPath = path.join(temporary, "connector.lock");
  let now = Date.parse("2026-07-19T12:00:00.000Z");
  const release = await acquireLock(lockPath, {
    staleMs: 15 * 60 * 1_000,
    refreshIntervalMs: 0,
    now: () => now
  });
  now += 16 * 60 * 1_000;
  await release.refresh();
  await assert.rejects(() => acquireLock(lockPath, {
    staleMs: 15 * 60 * 1_000,
    refreshIntervalMs: 0,
    now: () => now
  }), /already running/);
  const lock = JSON.parse(await fs.readFile(lockPath, "utf8"));
  assert.equal(lock.ownerToken, release.ownerToken);
  await release();
});

test("an expired mtime cannot be stolen while its owner PID is still alive", async (context) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "tag-plugin-lock-live-pid-test-"));
  context.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const lockPath = path.join(temporary, "connector.lock");
  const now = Date.now();
  await fs.writeFile(lockPath, JSON.stringify({
    pid: process.pid,
    ownerToken: "delayed-live-owner",
    createdAt: now - 20 * 60 * 1_000,
    leaseUpdatedAt: now - 20 * 60 * 1_000
  }) + "\n", "utf8");
  const expired = new Date(now - 20 * 60 * 1_000);
  await fs.utimes(lockPath, expired, expired);
  await assert.rejects(() => acquireLock(lockPath, {
    staleMs: 15 * 60 * 1_000,
    refreshIntervalMs: 0,
    now
  }), /live connector process/);
  assert.equal(
    JSON.parse(await fs.readFile(lockPath, "utf8")).ownerToken,
    "delayed-live-owner"
  );
});

test("an old owner cannot delete a replacement lock during release", async (context) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "tag-plugin-lock-owner-test-"));
  context.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const lockPath = path.join(temporary, "connector.lock");
  const oldPath = path.join(temporary, "old-owner.lock");
  const oldRelease = await acquireLock(lockPath, { refreshIntervalMs: 0 });
  await fs.rename(lockPath, oldPath);
  const replacement = {
    pid: process.pid,
    ownerToken: "replacement-owner-token",
    createdAt: Date.now(),
    leaseUpdatedAt: Date.now()
  };
  await fs.writeFile(lockPath, JSON.stringify(replacement) + "\n", { flag: "wx" });
  await oldRelease();
  assert.equal(
    JSON.parse(await fs.readFile(lockPath, "utf8")).ownerToken,
    replacement.ownerToken
  );
});

test("concurrent stale takeovers produce exactly one new owner", async (context) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "tag-plugin-lock-takeover-test-"));
  context.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const lockPath = path.join(temporary, "connector.lock");
  const now = Date.now();
  await fs.writeFile(lockPath, JSON.stringify({
    pid: 2_147_483_647,
    ownerToken: "stale-owner",
    createdAt: now - 60_000,
    leaseUpdatedAt: now - 60_000
  }) + "\n", "utf8");
  const staleDate = new Date(now - 60_000);
  await fs.utimes(lockPath, staleDate, staleDate);
  const results = await Promise.allSettled([
    acquireLock(lockPath, { staleMs: 1_000, refreshIntervalMs: 0, now }),
    acquireLock(lockPath, { staleMs: 1_000, refreshIntervalMs: 0, now })
  ]);
  const winners = results.filter((result) => result.status === "fulfilled");
  const losers = results.filter((result) => result.status === "rejected");
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 1);
  assert.equal(losers[0].reason.code, "SYNC_ALREADY_RUNNING");
  await winners[0].value();
});

test("bounded safe log drops unknown fields and rotates", async (context) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "tag-plugin-log-test-"));
  context.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const logPath = path.join(temporary, "connector.log.jsonl");
  await safeLog(logPath, {
    action: "sync",
    status: "success",
    eventCount: 2,
    secretPrompt: "DO_NOT_LOG_THIS",
    sourcePath: "C:/private/repo"
  }, { maxBytes: 1 });
  await safeLog(logPath, { action: "sync", status: "success" }, { maxBytes: 1 });
  const current = await fs.readFile(logPath, "utf8");
  const rotated = await fs.readFile(logPath + ".1", "utf8");
  assert.doesNotMatch(current + rotated, /DO_NOT_LOG|private|repo/);
});
