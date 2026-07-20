import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { readCodexAccountUsage } from "../src/adapters/codex-account-usage.mjs";

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
              dailyUsageBuckets: [{ startDate: "2026-07-19", tokens: 500 }]
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
  assert.deepEqual(requests.map((request) => request.method), ["initialize", "initialized", "account/usage/read"]);
});
