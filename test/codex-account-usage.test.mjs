import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  readCodexAccountUsage,
  resolveCodexExecutable
} from "../src/adapters/codex-account-usage.mjs";

test("Codex app-server resolves the absolute Windows executable before spawning", async () => {
  const expected = String.raw`C:\Program Files\WindowsApps\OpenAI.Codex_1.0.0_x64\codex.exe`;
  const calls = [];
  const resolved = await resolveCodexExecutable({
    platform: "win32",
    resolveLocalExecutable: async () => null,
    execFileImpl: (executable, arguments_, options, callback) => {
      calls.push({ executable, arguments_, options });
      callback(null, `${expected}\r\n`, "");
    }
  });
  assert.equal(resolved, expected);
  assert.deepEqual(calls[0].arguments_, ["codex.exe"]);
  assert.equal(calls[0].options.windowsHide, true);
});

test("Codex app-server prefers the app-managed local binary on Windows", async () => {
  const expected = String.raw`C:\Users\test\AppData\Local\OpenAI\Codex\bin\release\codex.exe`;
  const resolved = await resolveCodexExecutable({
    platform: "win32",
    resolveLocalExecutable: async () => expected,
    execFileImpl: () => assert.fail("where.exe should not run when the app-managed binary exists")
  });
  assert.equal(resolved, expected);
});

test("Codex app-server adapter uses initialize then account/usage/read", async () => {
  const requests = [];
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.kill = () => {};
    let pending = "";
    child.stdin.on("data", (chunk) => {
      pending += chunk.toString("utf8");
      let newline;
      while ((newline = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        const request = JSON.parse(line);
        requests.push(request);
        if (request.id === 0) {
          queueMicrotask(() => child.stdout.write(JSON.stringify({ id: 0, result: {} }) + "\n"));
        }
        if (request.id === 1) {
          queueMicrotask(() => child.stdout.write(JSON.stringify({
            id: 1,
            result: {
              summary: { lifetimeTokens: 900, peakDailyTokens: 500, currentStreakDays: 2 },
              dailyUsageBuckets: [
                { startDate: "2026-02-31", tokens: 400 },
                { startDate: "2026-07-19", tokens: 500 }
              ]
            }
          }) + "\n"));
        }
      }
    });
    return child;
  };
  const result = await readCodexAccountUsage({ spawnImpl, timeoutMs: 500 });
  assert.equal(result.status, "available");
  assert.equal(result.summary.lifetimeTokens, 900);
  assert.deepEqual(result.dailyUsageBuckets, [{ startDate: "2026-07-19", tokens: 500 }]);
  assert.deepEqual(requests.map((request) => request.method), ["initialize", "initialized", "account/usage/read"]);
});
