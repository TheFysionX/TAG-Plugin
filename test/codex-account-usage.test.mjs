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

test("Codex app-server adapter collects allowlisted current-plan metadata", async () => {
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
        if (request.id === 2) {
          queueMicrotask(() => child.stdout.write(JSON.stringify({
            id: 2,
            result: {
              account: {
                type: "chatgpt",
                planType: "pro",
                email: "private@example.test",
                accountId: "acct_private"
              }
            }
          }) + "\n"));
        }
        if (request.id === 3) {
          queueMicrotask(() => child.stdout.write(JSON.stringify({
            id: 3,
            result: {
              rateLimits: {
                primary: { usedPercent: 44.444, windowDurationMins: 300, resetsAt: 1_784_121_400 },
                secondary: { usedPercent: 101, windowDurationMins: 99_999, resetsAt: 0 },
                credits: { hasCredits: true, unlimited: false, balance: "99", creditId: "opaque-credit-id" }
              }
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
  assert.deepEqual(result.account, { authSurface: "chatgpt", planType: "pro" });
  assert.deepEqual(result.rateLimits, {
    primary: { usedPercent: 44.44, windowMinutes: 300, resetAt: "2026-07-15T13:16:40.000Z" },
    secondary: { usedPercent: null, windowMinutes: null, resetAt: null },
    credits: { hasCredits: true, unlimited: false }
  });
  assert.equal(JSON.stringify(result).includes("private@example.test"), false);
  assert.equal(JSON.stringify(result).includes("opaque-credit-id"), false);
  assert.deepEqual(requests.map((request) => request.method), [
    "initialize", "initialized", "account/usage/read", "account/read", "account/rateLimits/read"
  ]);
  assert.deepEqual(requests[3].params, { refreshToken: false });
});

test("Codex app-server adapter retains every current native PlanType", async () => {
  const planTypes = [
    "free", "go", "plus", "pro", "prolite", "team",
    "self_serve_business_usage_based", "enterprise_cbp_usage_based",
    "enterprise", "edu", "unknown"
  ];
  for (const planType of planTypes) {
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
          const request = JSON.parse(pending.slice(0, newline));
          pending = pending.slice(newline + 1);
          if (request.id === 0) queueMicrotask(() => child.stdout.write('{"id":0,"result":{}}\n'));
          if (request.id === 1) queueMicrotask(() => child.stdout.write('{"id":1,"result":{"summary":{"lifetimeTokens":1}}}\n'));
          if (request.id === 2) queueMicrotask(() => child.stdout.write(JSON.stringify({ id: 2, result: { account: { type: "chatgpt", planType } } }) + "\n"));
          if (request.id === 3) queueMicrotask(() => child.stdout.write('{"id":3,"error":{"message":"unsupported"}}\n'));
        }
      });
      return child;
    };
    const result = await readCodexAccountUsage({ spawnImpl, timeoutMs: 500 });
    assert.deepEqual(result.account, { authSurface: "chatgpt", planType });
  }
});

test("Codex usage remains available when newer account methods are rejected", async () => {
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
        const request = JSON.parse(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        if (request.id === 0) queueMicrotask(() => child.stdout.write('{"id":0,"result":{}}\n'));
        if (request.id === 1) queueMicrotask(() => child.stdout.write('{"id":1,"result":{"summary":{"lifetimeTokens":12}}}\n'));
        if (request.id === 2 || request.id === 3) queueMicrotask(() => child.stdout.write(JSON.stringify({ id: request.id, error: { message: "unsupported" } }) + "\n"));
      }
    });
    return child;
  };
  const result = await readCodexAccountUsage({ spawnImpl, timeoutMs: 500 });
  assert.equal(result.status, "available");
  assert.equal(result.summary.lifetimeTokens, 12);
  assert.equal(result.account, null);
  assert.equal(result.rateLimits, null);
});

test("Codex usage survives a timeout from absent newer methods", async () => {
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
        const request = JSON.parse(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        if (request.id === 0) queueMicrotask(() => child.stdout.write('{"id":0,"result":{}}\n'));
        if (request.id === 1) queueMicrotask(() => child.stdout.write('{"id":1,"result":{"summary":{"lifetimeTokens":7}}}\n'));
      }
    });
    return child;
  };
  const result = await readCodexAccountUsage({ spawnImpl, timeoutMs: 40 });
  assert.equal(result.status, "available");
  assert.equal(result.summary.lifetimeTokens, 7);
  assert.equal(result.account, null);
  assert.equal(result.rateLimits, null);
});
