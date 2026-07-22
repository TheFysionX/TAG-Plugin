import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { createDeviceSecrets } from "../src/crypto.mjs";
import { heartbeat, sync } from "../src/operations.mjs";
import { runtimePaths } from "../src/paths.mjs";
import { initialConfig, initialState, loadRuntime, saveRuntime, saveSecrets } from "../src/state.mjs";
import { installAntigravityStatusline, readStdinBounded, uninstallAntigravityStatusline } from "../src/antigravity-wrapper.mjs";

const dedupNamespaceKey = Buffer.alloc(32, 13).toString("base64url");

async function fixture() {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "tag-heartbeat-observation-"));
  const home = path.join(temporary, "state");
  const roots = Object.fromEntries(["codex", "claude", "kimi", "antigravity", "grok"].map((name) => [name, path.join(temporary, name)]));
  roots.claudeStats = path.join(temporary, "claude-stats.json");
  await Promise.all([roots.codex, roots.claude, roots.kimi, roots.grok].map((directory) => fs.mkdir(directory, { recursive: true })));
  return { temporary, home, roots, paths: runtimePaths({ home }) };
}

async function pairedRuntime(value, providers) {
  const secrets = createDeviceSecrets();
  secrets.dedupNamespaceKey = dedupNamespaceKey;
  const state = initialState();
  state.paired = true;
  state.deviceId = "device_observation_123";
  const config = initialConfig();
  config.endpoint = "https://tag.example";
  config.allowedPlatforms = providers;
  config.supportedProviders = providers;
  config.transcriptFallbacks = Object.fromEntries(["codex", "claude", "kimi", "gemini", "grok", "deepseek"].map((provider) => [provider, false]));
  await saveSecrets(value.paths, secrets);
  await saveRuntime(value.paths, { state, config });
}

function response(body, observations = { plans: [], resets: [] }) {
  return { ok: true, status: 200, text: async () => JSON.stringify({
    request: { digest: "digest_observation_123456" },
    heartbeat: { nextExpectedAt: "2026-07-22T00:00:00.000Z" },
    device: { continuityState: "continuous" },
    observations,
    ...body
  }) };
}

test("Claude subscription observations require first-party claude.ai auth", async (context) => {
  const value = await fixture();
  context.after(() => fs.rm(value.temporary, { recursive: true, force: true }));
  await pairedRuntime(value, ["claude"]);
  let sent;
  await heartbeat({
    home: value.home, roots: value.roots,
    readClaudeAccountStatus: async () => ({ status: "available", loggedIn: true, authMethod: "api_key", apiProvider: "anthropic", subscriptionType: "max" }),
    fetchImpl: async (_url, init) => { sent = JSON.parse(init.body); return response({}); }
  });
  assert.equal(sent.providerObservations, undefined);

  await heartbeat({
    home: value.home, roots: value.roots,
    readClaudeAccountStatus: async () => ({ status: "available", loggedIn: true, authMethod: "claude_ai", apiProvider: "anthropic", subscriptionType: "max" }),
    fetchImpl: async (_url, init) => {
      sent = JSON.parse(init.body);
      return response({}, { plans: sent.providerObservations.map(({ providerId, surface, observedAt }) => ({ providerId, surface, observedAt })), resets: [] });
    }
  });
  assert.deepEqual(sent.providerObservations, [{ providerId: "claude", surface: "claude_code", rawPlanCode: "max", observedAt: sent.providerObservations[0].observedAt }]);
});

test("a hosted DeepSeek model never fabricates a DeepSeek API plan", async (context) => {
  const value = await fixture();
  context.after(() => fs.rm(value.temporary, { recursive: true, force: true }));
  await pairedRuntime(value, ["deepseek"]);
  let sent;
  await heartbeat({
    home: value.home,
    roots: value.roots,
    observationCollection: {
      events: [{
        provider: "deepseek",
        modelId: "deepseek-v4-pro",
        usage: { input: 100, total: 100 },
        provenance: { surface: "claude_code" },
      }],
      providerEvidence: {},
      providerObservations: [],
      resetObservations: [],
    },
    fetchImpl: async (_url, init) => {
      sent = JSON.parse(init.body);
      return response({});
    },
  });
  assert.equal(sent.providerObservations, undefined);
});

test("heartbeat observation bodies replay byte-identically and commit only after exact acknowledgement", async (context) => {
  const value = await fixture();
  context.after(() => fs.rm(value.temporary, { recursive: true, force: true }));
  await pairedRuntime(value, ["claude"]);
  let firstBody;
  await assert.rejects(() => heartbeat({
    home: value.home, roots: value.roots,
    readClaudeAccountStatus: async () => ({ status: "available", loggedIn: true, authMethod: "claude_ai", apiProvider: "anthropic", subscriptionType: "pro" }),
    fetchImpl: async (_url, init) => { firstBody = init.body; throw new Error("offline"); }
  }));
  const pending = await loadRuntime(value.paths);
  assert.ok(pending.state.pendingRequest.body.providerObservations);
  let replayed;
  await heartbeat({
    home: value.home, roots: value.roots,
    fetchImpl: async (_url, init) => {
      replayed = init.body;
      const body = JSON.parse(init.body);
      return response({}, { plans: body.providerObservations.map(({ providerId, surface, observedAt }) => ({ providerId, surface, observedAt })), resets: [] });
    }
  });
  assert.equal(replayed, firstBody);
  const committed = await loadRuntime(value.paths);
  assert.equal(committed.state.pendingRequest, null);
  assert.equal(committed.state.heartbeatObservationSnapshots.plans["claude:claude_code"].rawPlanCode, "pro");
});

test("reset evidence advances only at the scheduled boundary and precedes a new usage outbox", async (context) => {
  const value = await fixture();
  context.after(() => fs.rm(value.temporary, { recursive: true, force: true }));
  await pairedRuntime(value, ["codex", "kimi"]);
  const runtime = await loadRuntime(value.paths);
  runtime.state.heartbeatObservationSnapshots.resetWindows["codex:codex:primary"] = { resetAt: "2026-07-21T12:00:00.000Z" };
  runtime.config.transcriptFallbacks.kimi = true;
  await saveRuntime(value.paths, runtime);
  const wire = path.join(value.roots.kimi, "session", "agents", "main", "wire.jsonl");
  await fs.mkdir(path.dirname(wire), { recursive: true });
  await fs.writeFile(wire, JSON.stringify({ type: "usage.record", time: "2026-07-21T12:01:00.000Z", model: "kimi-code/kimi-for-coding-highspeed", usage: { inputOther: 12, output: 3 }, usageScope: "turn" }) + "\n");
  const routes = [];
  await sync({
    home: value.home, roots: value.roots, aggregateHistory: false, now: Date.parse("2026-07-21T12:01:00.000Z"),
    readCodexAccountUsage: async () => ({ status: "available", rateLimits: { primary: { usedPercent: 1, windowMinutes: 300, resetAt: "2026-07-21T17:00:00.000Z" } } }),
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body); routes.push([url, body]);
      if (url.endsWith("/heartbeat")) return response({}, {
        plans: (body.providerObservations || []).map(({ providerId, surface, observedAt }) => ({ providerId, surface, observedAt })),
        resets: (body.resetObservations || []).map(({ providerId, surface, windowKey, observedAt }) => ({ providerId, surface, windowKey, observedAt }))
      });
      return { ok: true, status: 200, text: async () => JSON.stringify({ request: { digest: "digest_ingest_123456" }, accepted: body.events.length, duplicates: 0, rejected: 0, events: body.events.map((event) => ({ eventId: event.eventId, status: "accepted", scoringState: "accepted", submittedRevisionActive: true })) }) };
    }
  });
  assert.equal(routes[0][0].endsWith("/heartbeat"), true);
  assert.equal(routes[0][1].resetObservations.length, 1);
  assert.equal(routes[0][1].resetObservations[0].resetAt, "2026-07-21T12:00:00.000Z");
  assert.equal(routes[1][0].endsWith("/ingest"), true);
  const resetState = await loadRuntime(value.paths);
  assert.equal(resetState.state.heartbeatObservationSnapshots.resetWindows["codex:codex:primary"].resetAt,
    "2026-07-21T17:00:00.000Z");

  const after = resetState;
  after.state.heartbeatObservationSnapshots.resetWindows["codex:codex:primary"] = { resetAt: "2026-07-21T17:00:00.000Z" };
  await saveRuntime(value.paths, after);
  let body;
  await heartbeat({
    home: value.home, roots: value.roots, now: Date.parse("2026-07-21T13:00:00.000Z"),
    readCodexAccountUsage: async () => ({ status: "available", rateLimits: { primary: { usedPercent: 0, windowMinutes: 300, resetAt: "2026-07-21T17:00:00.000Z" } } }),
    fetchImpl: async (_url, init) => { body = JSON.parse(init.body); return response({}); }
  });
  assert.equal(body.resetObservations, undefined);
});

test("a large same-window Codex percentage drop produces a private, retry-safe manual reset observation", async (context) => {
  const value = await fixture();
  context.after(() => fs.rm(value.temporary, { recursive: true, force: true }));
  await pairedRuntime(value, ["codex"]);
  const runtime = await loadRuntime(value.paths);
  runtime.state.heartbeatObservationSnapshots.resetWindows["codex:codex:primary"] = {
    resetAt: "2026-07-21T17:00:00.000Z",
    usedPercent: 82
  };
  await saveRuntime(value.paths, runtime);
  const now = Date.parse("2026-07-21T13:00:00.000Z");
  const usage = async () => ({
    status: "available",
    rateLimits: { primary: { usedPercent: 42, windowMinutes: 300, resetAt: "2026-07-21T17:00:00.000Z" } }
  });
  let firstBody;
  await assert.rejects(() => heartbeat({
    home: value.home, roots: value.roots, now, readCodexAccountUsage: usage,
    fetchImpl: async (_url, init) => { firstBody = init.body; throw new Error("offline"); }
  }));
  const firstPayload = JSON.parse(firstBody);
  assert.deepEqual(firstPayload.resetObservations, [{
    providerId: "codex",
    surface: "codex",
    windowKey: "primary",
    observedAt: "2026-07-21T13:00:00.000Z",
    resetAt: "2026-07-21T13:00:00.000Z"
  }]);
  assert.equal(firstBody.includes("usedPercent"), false);
  const pending = await loadRuntime(value.paths);
  assert.equal(pending.state.heartbeatObservationSnapshots.resetWindows["codex:codex:primary"].usedPercent, 82);

  let replayed;
  await heartbeat({
    home: value.home, roots: value.roots, now, readCodexAccountUsage: usage,
    fetchImpl: async (_url, init) => {
      replayed = init.body;
      const body = JSON.parse(init.body);
      return response({}, {
        plans: [],
        resets: body.resetObservations.map(({ providerId, surface, windowKey, observedAt }) => ({ providerId, surface, windowKey, observedAt }))
      });
    }
  });
  assert.equal(replayed, firstBody);
  const committed = await loadRuntime(value.paths);
  assert.equal(committed.state.pendingRequest, null);
  assert.deepEqual(committed.state.heartbeatObservationSnapshots.resetWindows["codex:codex:primary"], {
    resetAt: "2026-07-21T17:00:00.000Z",
    usedPercent: 42
  });
});

test("Codex reset snapshots ignore first samples and percentage drops below the manual-reset threshold", async (context) => {
  const value = await fixture();
  context.after(() => fs.rm(value.temporary, { recursive: true, force: true }));
  await pairedRuntime(value, ["codex"]);
  const resetAt = "2026-07-21T17:00:00.000Z";
  let first;
  await heartbeat({
    home: value.home, roots: value.roots, now: Date.parse("2026-07-21T13:00:00.000Z"),
    readCodexAccountUsage: async () => ({ status: "available", rateLimits: { primary: { usedPercent: 80, windowMinutes: 300, resetAt } } }),
    fetchImpl: async (_url, init) => { first = JSON.parse(init.body); return response({}); }
  });
  assert.equal(first.resetObservations, undefined);
  let noise;
  await heartbeat({
    home: value.home, roots: value.roots, now: Date.parse("2026-07-21T13:05:00.000Z"),
    readCodexAccountUsage: async () => ({ status: "available", rateLimits: { primary: { usedPercent: 59, windowMinutes: 300, resetAt } } }),
    fetchImpl: async (_url, init) => { noise = JSON.parse(init.body); return response({}); }
  });
  assert.equal(noise.resetObservations, undefined);
  const committed = await loadRuntime(value.paths);
  assert.deepEqual(committed.state.heartbeatObservationSnapshots.resetWindows["codex:codex:primary"], { resetAt, usedPercent: 59 });
});

test("Antigravity statusLine restoration preserves user ownership and bounds stdin", async (context) => {
  const value = await fixture();
  context.after(() => fs.rm(value.temporary, { recursive: true, force: true }));
  await fs.mkdir(path.dirname(value.roots.antigravity), { recursive: true });
  await fs.mkdir(value.paths.home, { recursive: true });
  const settingsPath = path.join(path.dirname(value.roots.antigravity), "settings.json");
  await fs.writeFile(settingsPath, JSON.stringify({ theme: "night", statusLine: "existing --status" }));
  await fs.writeFile(value.paths.secrets, JSON.stringify({ localAliasKey: Buffer.alloc(32, 1).toString("base64") }));
  const installed = await installAntigravityStatusline({ paths: value.paths, roots: value.roots, settingsPath, wrapperPath: "C:/tag/wrapper.mjs", nodeExecutable: "node" });
  assert.equal(JSON.parse(await fs.readFile(settingsPath, "utf8")).statusLine.includes("wrapper.mjs"), true);
  const restored = await uninstallAntigravityStatusline({ paths: value.paths, roots: value.roots });
  assert.equal(restored.restored, true);
  assert.equal(JSON.parse(await fs.readFile(settingsPath, "utf8")).statusLine, "existing --status");

  await installAntigravityStatusline({ paths: value.paths, roots: value.roots, settingsPath, wrapperPath: "C:/tag/wrapper.mjs", nodeExecutable: "node" });
  await fs.writeFile(settingsPath, JSON.stringify({ theme: "night", statusLine: "user command" }));
  const preserved = await uninstallAntigravityStatusline({ paths: value.paths, roots: value.roots });
  assert.equal(preserved.preservedUserChange, true);
  assert.equal(JSON.parse(await fs.readFile(settingsPath, "utf8")).statusLine, "user command");
  await assert.rejects(() => readStdinBounded(Readable.from([Buffer.alloc(256 * 1024 + 1)])), (error) => error.code === "ANTIGRAVITY_STATUSLINE_STDIN_TOO_LARGE");
  assert.equal(installed.installed, true);
});
