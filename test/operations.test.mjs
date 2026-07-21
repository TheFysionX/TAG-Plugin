import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verify } from "node:crypto";
import { createDeviceSecrets, sha256 } from "../src/crypto.mjs";
import {
  INITIAL_HISTORY_DAYS,
  MAX_SYNC_OUTBOX_EVENTS,
  SERVER_MAX_AUTO_SCORED_EVENT_TOKENS,
  SERVER_MAX_AUTO_SCORED_RETROACTIVE_DAYS
} from "../src/constants.mjs";
import { parseKimiWire } from "../src/adapters/kimi-wire.mjs";
import { discoverJsonlFiles } from "../src/discovery.mjs";
import {
  chunkSyncPayloads,
  pair,
  scheduledRun,
  sync,
  heartbeat,
  install,
  preview,
  status,
  uninstall
} from "../src/operations.mjs";
import { runtimePaths } from "../src/paths.mjs";
import { atomicWriteJson, initialConfig, initialState, loadRuntime, saveRuntime, saveSecrets } from "../src/state.mjs";

const fixtureDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const connectorRoot = path.resolve(fixtureDirectory, "..", "..");
const dedupNamespaceKey = Buffer.alloc(32, 9).toString("base64url");

test("initial history import stays inside the server retroactive scoring policy", () => {
  assert.equal(SERVER_MAX_AUTO_SCORED_RETROACTIVE_DAYS, 90);
  assert.equal(INITIAL_HISTORY_DAYS, SERVER_MAX_AUTO_SCORED_RETROACTIVE_DAYS - 1);
  assert.equal(SERVER_MAX_AUTO_SCORED_EVENT_TOKENS, 100_000_000);
});

async function setup() {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "tag-plugin-test-"));
  const home = path.join(temporary, "state");
  const roots = {
    codex: path.join(temporary, "codex"),
    claude: path.join(temporary, "claude"),
    claudeStats: path.join(temporary, "claude-stats-cache.json"),
    kimi: path.join(temporary, "kimi")
  };
  await Promise.all(Object.values(roots).slice(0, 3).map(async (root) => {
    if (root.endsWith(".json")) return;
    await fs.mkdir(root, { recursive: true });
  }));
  await fs.mkdir(roots.kimi, { recursive: true });
  await fs.copyFile(path.join(fixtureDirectory, "codex-rollout.jsonl"), path.join(roots.codex, "rollout.jsonl"));
  await fs.copyFile(path.join(fixtureDirectory, "claude-project.jsonl"), path.join(roots.claude, "project.jsonl"));
  const kimiNested = path.join(roots.kimi, "session", "agents", "main");
  await fs.mkdir(kimiNested, { recursive: true });
  await fs.copyFile(path.join(fixtureDirectory, "kimi-wire.jsonl"), path.join(kimiNested, "wire.jsonl"));
  return { temporary, home, roots, paths: runtimePaths({ home }) };
}

function jsonResponse(body) {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
}

function errorResponse(statusCode, code, message = "Rejected for test") {
  return {
    ok: false,
    status: statusCode,
    text: async () => JSON.stringify({ error: { code, message } })
  };
}

test("pair signs exchange, stores one device, and restricts approved fallbacks", async (context) => {
  const fixture = await setup();
  context.after(() => fs.rm(fixture.temporary, { recursive: true, force: true }));
  let captured;
  const fetchImpl = async (url, init) => {
    captured = { url, init };
    return jsonResponse({
      device: {
        id: "device_12345678",
        allowedPlatforms: ["codex", "kimi"],
        supportedProviders: ["codex"]
      },
      dedupNamespaceKey,
      signing: { nextSequence: 1, lastRequestDigest: "" }
    });
  };
  const result = await pair({
    home: fixture.home,
    platform: "linux",
    roots: fixture.roots,
    endpoint: "https://artificial-games.example",
    code: "ABCD-EFGH",
    enabledFallbacks: { codex: true, claude: true, kimi: true },
    fetchImpl,
    now: 1_750_000_000_000,
    nonce: "pair-request"
  });
  assert.equal(result.paired, true);
  assert.deepEqual(result.transcriptFallbacks, { codex: true, claude: false, kimi: true });
  assert.deepEqual(result.supportedProviders, ["codex"]);
  const body = JSON.parse(captured.init.body);
  assert.deepEqual(Object.keys(body), ["code", "connectorVersion", "deviceLabel", "publicKey"]);
  assert.equal(Buffer.from(body.publicKey, "base64url").length, 32);
  assert.equal(captured.init.headers["x-tokenboard-device-id"], undefined);
  assert.equal(captured.init.headers["x-tokenboard-sequence"], "0");
  const runtime = await loadRuntime(fixture.paths);
  assert.equal(runtime.state.deviceId, "device_12345678");
});

test("pair is idempotent for an existing device on the same endpoint", async (context) => {
  const fixture = await setup();
  context.after(() => fs.rm(fixture.temporary, { recursive: true, force: true }));
  let networkCalls = 0;
  const fetchImpl = async () => {
    networkCalls += 1;
    return jsonResponse({
      device: {
        id: "device_12345678",
        allowedPlatforms: ["codex", "claude"],
        supportedProviders: ["codex", "claude"]
      },
      dedupNamespaceKey,
      signing: { nextSequence: 1, lastRequestDigest: "" }
    });
  };
  await pair({
    home: fixture.home,
    platform: "linux",
    endpoint: "https://artificial-games.example",
    code: "ABCD-EFGH",
    enabledFallbacks: { codex: true, claude: true },
    fetchImpl
  });

  const retried = await pair({
    home: fixture.home,
    platform: "linux",
    endpoint: "https://artificial-games.example/",
    code: "JKLM-NPQR",
    fetchImpl: async () => {
      networkCalls += 1;
      throw new Error("an idempotent retry must not exchange another code");
    }
  });

  assert.equal(networkCalls, 1);
  assert.equal(retried.paired, true);
  assert.equal(retried.alreadyPaired, true);
  assert.equal(retried.deviceId, "device_12345678");
  assert.deepEqual(retried.allowedPlatforms, ["codex", "claude"]);
  assert.deepEqual(retried.transcriptFallbacks, { codex: true, claude: true, kimi: false });
  assert.equal(await fs.access(fixture.paths.pendingSecrets).then(() => true).catch(() => false), false);
});

test("pair reuse applies explicitly requested journals without exchanging another code", async (context) => {
  const fixture = await setup();
  context.after(() => fs.rm(fixture.temporary, { recursive: true, force: true }));
  let networkCalls = 0;
  await pair({
    home: fixture.home,
    platform: "linux",
    endpoint: "https://artificial-games.example",
    code: "ABCD-EFGH",
    fetchImpl: async () => {
      networkCalls += 1;
      return jsonResponse({
        device: {
          id: "device_12345678",
          allowedPlatforms: ["codex", "claude"],
          supportedProviders: ["codex", "claude"]
        },
        dedupNamespaceKey,
        signing: { nextSequence: 1, lastRequestDigest: "" }
      });
    }
  });

  const retried = await pair({
    home: fixture.home,
    platform: "linux",
    endpoint: "https://artificial-games.example",
    code: "JKLM-NPQR",
    enabledFallbacks: { codex: true, claude: true },
    fetchImpl: async () => {
      networkCalls += 1;
      throw new Error("an active pairing must not exchange another code");
    }
  });

  assert.equal(networkCalls, 1);
  assert.equal(retried.alreadyPaired, true);
  assert.deepEqual(retried.transcriptFallbacks, { codex: true, claude: true, kimi: false });
  const after = await loadRuntime(fixture.paths);
  assert.deepEqual(after.config.transcriptFallbacks, { codex: true, claude: true, kimi: false });
});

test("pair rejects an existing device when the supplied endpoint differs", async (context) => {
  const fixture = await setup();
  context.after(() => fs.rm(fixture.temporary, { recursive: true, force: true }));
  const runtime = await loadRuntime(fixture.paths);
  runtime.state.paired = true;
  runtime.state.deviceId = "device_12345678";
  runtime.config.endpoint = "https://artificial-games.example";
  runtime.config.allowedPlatforms = ["codex"];
  runtime.config.supportedProviders = ["codex"];
  const secrets = createDeviceSecrets();
  secrets.dedupNamespaceKey = dedupNamespaceKey;
  await saveSecrets(fixture.paths, secrets);
  await saveRuntime(fixture.paths, runtime);

  await assert.rejects(() => pair({
    home: fixture.home,
    platform: "linux",
    endpoint: "https://another-artificial-games.example",
    code: "ABCD-EFGH",
    fetchImpl: async () => { throw new Error("network must not run"); }
  }), (error) => error.code === "PAIR_ENDPOINT_MISMATCH");

  const after = await loadRuntime(fixture.paths);
  assert.equal(after.state.deviceId, "device_12345678");
  assert.equal(after.config.endpoint, "https://artificial-games.example");
});

test("pairing response loss resumes the persisted key, body, and request ID", async (context) => {
  const fixture = await setup();
  context.after(() => fs.rm(fixture.temporary, { recursive: true, force: true }));
  let firstRequest;
  await assert.rejects(() => pair({
    home: fixture.home,
    platform: "linux",
    endpoint: "https://artificial-games.example",
    code: "ABCD-EFGH",
    fetchImpl: async (url, init) => {
      firstRequest = { url, init };
      throw new Error("response lost after exchange");
    },
    maxAttempts: 1
  }), /could not be reached/);
  const afterLoss = await loadRuntime(fixture.paths);
  const persistedSecrets = JSON.parse(await fs.readFile(fixture.paths.pendingSecrets, "utf8"));
  const persistedStateText = await fs.readFile(fixture.paths.state, "utf8");
  assert.equal("body" in afterLoss.state.pendingPair, false);
  assert.doesNotMatch(persistedStateText, /ABCDEFGH|ABCD-EFGH/);
  assert.equal(persistedSecrets.pairingRequest.body.publicKey, persistedSecrets.publicKeyRawBase64Url);
  assert.equal(persistedSecrets.pairingRequest.body.code, "ABCDEFGH");
  assert.equal(await fs.access(fixture.paths.secrets).then(() => true).catch(() => false), false);
  assert.equal(
    afterLoss.state.pendingPair.requestId,
    firstRequest.init.headers["x-tokenboard-request-id"]
  );

  let resumedRequest;
  const recovered = await pair({
    home: fixture.home,
    platform: "linux",
    fetchImpl: async (url, init) => {
      resumedRequest = { url, init };
      return jsonResponse({
        device: {
          id: "device_12345678",
          allowedPlatforms: ["codex"],
          supportedProviders: ["codex"]
        },
        dedupNamespaceKey,
        signing: { nextSequence: 1, lastRequestDigest: "" }
      });
    }
  });
  assert.equal(recovered.paired, true);
  assert.equal(resumedRequest.url, firstRequest.url);
  assert.equal(resumedRequest.init.body, firstRequest.init.body);
  assert.equal(
    resumedRequest.init.headers["x-tokenboard-request-id"],
    firstRequest.init.headers["x-tokenboard-request-id"]
  );
  const afterRecovery = await loadRuntime(fixture.paths);
  assert.equal(afterRecovery.state.pendingPair, null);
  const recoveredSecrets = JSON.parse(await fs.readFile(fixture.paths.secrets, "utf8"));
  assert.equal(recoveredSecrets.dedupNamespaceKey, dedupNamespaceKey);
  assert.equal(await fs.access(fixture.paths.pendingSecrets).then(() => true).catch(() => false), false);
});

test("pairing recovers when config commits but the final state commit fails", async (context) => {
  const fixture = await setup();
  context.after(() => fs.rm(fixture.temporary, { recursive: true, force: true }));
  let firstRequest;
  let failStateOnce = true;
  const response = {
    device: {
      id: "device_12345678",
      allowedPlatforms: ["codex"],
      supportedProviders: ["codex"]
    },
    dedupNamespaceKey,
    signing: { nextSequence: 1, lastRequestDigest: "" }
  };
  await assert.rejects(() => pair({
    home: fixture.home,
    platform: "linux",
    endpoint: "https://artificial-games.example",
    code: "ABCD-EFGH",
    enabledFallbacks: { codex: true },
    atomicWriteJson: async (target, value, mode) => {
      if (target === fixture.paths.state && failStateOnce) {
        failStateOnce = false;
        throw new Error("simulated state commit failure");
      }
      return atomicWriteJson(target, value, mode);
    },
    fetchImpl: async (_url, init) => {
      firstRequest = init;
      return jsonResponse(response);
    }
  }), /simulated state commit failure/);
  const interrupted = await loadRuntime(fixture.paths);
  assert.equal(interrupted.config.endpoint, "https://artificial-games.example");
  assert.equal(interrupted.state.paired, false);
  assert.equal(interrupted.state.pendingPair !== null, true);
  assert.equal(await fs.access(fixture.paths.pendingSecrets).then(() => true), true);

  let replayRequest;
  const recovered = await pair({
    home: fixture.home,
    platform: "linux",
    fetchImpl: async (_url, init) => {
      replayRequest = init;
      return jsonResponse(response);
    }
  });
  assert.equal(recovered.paired, true);
  assert.equal(recovered.transcriptFallbacks.codex, true);
  assert.equal(replayRequest.body, firstRequest.body);
  assert.equal(
    replayRequest.headers["x-tokenboard-request-id"],
    firstRequest.headers["x-tokenboard-request-id"]
  );
  assert.equal((await loadRuntime(fixture.paths)).state.pendingPair, null);
  assert.equal(await fs.access(fixture.paths.pendingSecrets).then(() => true).catch(() => false), false);
});

test("pairing fails closed when the server omits the account dedup namespace", async (context) => {
  const fixture = await setup();
  context.after(() => fs.rm(fixture.temporary, { recursive: true, force: true }));
  await assert.rejects(() => pair({
    home: fixture.home,
    platform: "linux",
    endpoint: "https://artificial-games.example",
    code: "ABCD-EFGH",
    fetchImpl: async () => jsonResponse({
      device: {
        id: "device_12345678",
        allowedPlatforms: ["codex"],
        supportedProviders: ["codex"]
      },
      signing: { nextSequence: 1, lastRequestDigest: "" }
    })
  }), (error) => error.code === "MISSING_DEDUP_NAMESPACE");
  const runtime = await loadRuntime(fixture.paths);
  assert.equal(runtime.state.paired, false);
  assert.equal(runtime.state.pendingPair.permanentFailure.code, "MISSING_DEDUP_NAMESPACE");
  await assert.rejects(() => pair({
    home: fixture.home,
    platform: "linux",
    fetchImpl: async () => { throw new Error("permanently rejected pairing must not retry"); }
  }), (error) => error.code === "PAIR_PERMANENTLY_REJECTED" && error.status === null);
});

test("Windows pairing sends no request when pending-key ACL hardening fails", async (context) => {
  const fixture = await setup();
  context.after(() => fs.rm(fixture.temporary, { recursive: true, force: true }));
  let networkCalls = 0;
  const aclCalls = [];
  await assert.rejects(() => pair({
    home: fixture.home,
    platform: "win32",
    windowsIdentity: "TEST\\connector-user",
    endpoint: "https://artificial-games.example",
    code: "ABCD-EFGH",
    runCommand: async (executable, args) => {
      aclCalls.push([executable, ...args]);
      if (aclCalls.length === 2) throw new Error("ACL denied");
    },
    fetchImpl: async () => {
      networkCalls += 1;
      throw new Error("network must not run");
    }
  }), (error) => error.code === "WINDOWS_ACL_HARDENING_FAILED");
  assert.equal(aclCalls.length, 2);
  assert.match(aclCalls[0][0], /powershell\.exe$/i);
  assert.match(aclCalls[0].join(" "), /ContainerInherit, ObjectInherit/);
  assert.match(aclCalls[1].join(" "), /pending-device-secrets\.json/);
  assert.match(aclCalls[1].join(" "), /TEST\\connector-user/);
  assert.equal(networkCalls, 0);
  assert.equal(await fs.access(fixture.paths.pendingSecrets).then(() => true).catch(() => false), false);
  assert.equal((await loadRuntime(fixture.paths)).state.pendingPair, null);
});

test("Windows pairing creates no credential or request when connector-home ACL hardening fails", async (context) => {
  const fixture = await setup();
  context.after(() => fs.rm(fixture.temporary, { recursive: true, force: true }));
  let networkCalls = 0;
  await assert.rejects(() => pair({
    home: fixture.home,
    platform: "win32",
    windowsIdentity: "TEST\\connector-user",
    endpoint: "https://artificial-games.example",
    code: "ABCD-EFGH",
    runCommand: async () => { throw new Error("directory ACL denied"); },
    fetchImpl: async () => {
      networkCalls += 1;
      throw new Error("network must not run");
    }
  }), (error) => error.code === "WINDOWS_ACL_HARDENING_FAILED");
  assert.equal(networkCalls, 0);
  assert.equal(await fs.access(fixture.paths.pendingSecrets).then(() => true).catch(() => false), false);
});

test("Windows pairing verifies pending and final key ACLs and recovers a final-ACL failure", async (context) => {
  const fixture = await setup();
  context.after(() => fs.rm(fixture.temporary, { recursive: true, force: true }));
  let aclCalls = 0;
  let networkCalls = 0;
  let firstRequest;
  const response = {
    device: {
      id: "device_12345678",
      allowedPlatforms: ["codex"],
      supportedProviders: ["codex"]
    },
    dedupNamespaceKey,
    signing: { nextSequence: 1, lastRequestDigest: "" }
  };
  await assert.rejects(() => pair({
    home: fixture.home,
    platform: "win32",
    windowsIdentity: "TEST\\connector-user",
    endpoint: "https://artificial-games.example",
    code: "ABCD-EFGH",
    runCommand: async () => {
      aclCalls += 1;
      if (aclCalls === 4) throw new Error("final ACL denied");
    },
    fetchImpl: async (_url, init) => {
      networkCalls += 1;
      firstRequest = init;
      return jsonResponse(response);
    }
  }), (error) => error.code === "WINDOWS_ACL_HARDENING_FAILED");
  assert.equal(aclCalls, 4);
  assert.equal(networkCalls, 1);
  assert.equal(await fs.access(fixture.paths.secrets).then(() => true).catch(() => false), false);
  assert.equal(await fs.access(fixture.paths.pendingSecrets).then(() => true), true);
  assert.equal((await loadRuntime(fixture.paths)).state.pendingPair !== null, true);

  let replayRequest;
  const recovered = await pair({
    home: fixture.home,
    platform: "win32",
    windowsIdentity: "TEST\\connector-user",
    runCommand: async () => {},
    fetchImpl: async (_url, init) => {
      networkCalls += 1;
      replayRequest = init;
      return jsonResponse(response);
    }
  });
  assert.equal(recovered.paired, true);
  assert.equal(replayRequest.body, firstRequest.body);
  assert.equal(
    replayRequest.headers["x-tokenboard-request-id"],
    firstRequest.headers["x-tokenboard-request-id"]
  );
  assert.equal(await fs.access(fixture.paths.secrets).then(() => true), true);
  assert.equal(await fs.access(fixture.paths.pendingSecrets).then(() => true).catch(() => false), false);
});

test("a legacy pairing safely replaces its device without discarding the active key before success", async (context) => {
  const fixture = await setup();
  context.after(() => fs.rm(fixture.temporary, { recursive: true, force: true }));
  const state = initialState();
  state.paired = true;
  state.deviceId = "device_12345678";
  const config = initialConfig();
  config.endpoint = "https://artificial-games.example";
  config.dedupNamespaceKey = dedupNamespaceKey;
  const legacySecrets = createDeviceSecrets();
  await saveSecrets(fixture.paths, legacySecrets);
  await saveRuntime(fixture.paths, { state, config });
  await assert.rejects(() => sync({
    home: fixture.home,
    roots: fixture.roots,
    officialEvidence: false,
    fetchImpl: async () => { throw new Error("network must not run"); }
  }), (error) => error.code === "MISSING_DEDUP_NAMESPACE");
  const reloaded = await loadRuntime(fixture.paths);
  assert.equal("dedupNamespaceKey" in reloaded.config, false);

  let replacementPublicKey;
  const replacement = await pair({
    home: fixture.home,
    platform: "linux",
    endpoint: "https://artificial-games.example",
    code: "JKLM-NPQR",
    replacePendingPair: true,
    fetchImpl: async (_url, init) => {
      replacementPublicKey = JSON.parse(init.body).publicKey;
      const stillActive = JSON.parse(await fs.readFile(fixture.paths.secrets, "utf8"));
      assert.equal(stillActive.publicKeyRawBase64Url, legacySecrets.publicKeyRawBase64Url);
      assert.notEqual(replacementPublicKey, legacySecrets.publicKeyRawBase64Url);
      return jsonResponse({
        device: {
          id: "device_replacement_1234",
          allowedPlatforms: ["codex"],
          supportedProviders: ["codex"]
        },
        dedupNamespaceKey,
        signing: { nextSequence: 1, lastRequestDigest: "" }
      });
    }
  });
  assert.equal(replacement.paired, true);
  const activeReplacement = JSON.parse(await fs.readFile(fixture.paths.secrets, "utf8"));
  assert.equal(activeReplacement.publicKeyRawBase64Url, replacementPublicKey);
  assert.equal(activeReplacement.dedupNamespaceKey, dedupNamespaceKey);
  assert.equal(await fs.access(fixture.paths.pendingSecrets).then(() => true).catch(() => false), false);
});

test("sync sends only strict allowlisted wire events and advances the request chain", async (context) => {
  const fixture = await setup();
  context.after(() => fs.rm(fixture.temporary, { recursive: true, force: true }));
  const secrets = createDeviceSecrets();
  secrets.dedupNamespaceKey = dedupNamespaceKey;
  const state = initialState();
  state.paired = true;
  state.deviceId = "device_12345678";
  const config = initialConfig();
  config.endpoint = "https://artificial-games.example";
  config.allowedPlatforms = ["codex", "claude", "kimi"];
  config.supportedProviders = ["codex", "claude", "kimi"];
  config.transcriptFallbacks = { codex: true, claude: true, kimi: true };
  await saveSecrets(fixture.paths, secrets);
  await saveRuntime(fixture.paths, { state, config });

  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return jsonResponse({
      request: { id: "request-1", sequence: 1, digest: "digest_1234567890abcdef" },
      accepted: 3,
      duplicates: 0,
      rejected: 0
    });
  };
  const result = await sync({
    home: fixture.home,
    roots: fixture.roots,
    officialEvidence: false,
    fetchImpl,
    now: 1_750_000_000_000,
    nonce: "sync-request"
  });
  assert.equal(result.sent, 3);
  assert.equal(result.withheld, 1);
  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(Object.keys(body), ["events", "previousRequestDigest"]);
  assert.equal(body.previousRequestDigest, "");
  assert.equal(body.events.length, 3);
  const allowedEventKeys = new Set([
    "eventId", "occurredAt", "provider", "modelId", "serviceMode",
    "inputTokens", "cachedInputTokens", "outputTokens", "reasoningTokens", "surface"
  ]);
  for (const event of body.events) {
    assert.equal(Object.keys(event).every((key) => allowedEventKeys.has(key)), true);
    assert.equal(typeof event.inputTokens, "string");
    assert.equal(typeof event.cachedInputTokens, "string");
    assert.equal(typeof event.outputTokens, "string");
  }
  assert.doesNotMatch(JSON.stringify(body), /SECRET_|private|repository|source\.ts|kimi\.py/i);
  const signatureValid = verify(
    null,
    Buffer.from([
      "TOKENBOARD-V1",
      "POST",
      "/api/connectors/v1/ingest",
      "device_12345678",
      calls[0].init.headers["x-tokenboard-timestamp"],
      calls[0].init.headers["x-tokenboard-request-id"],
      "1",
      calls[0].init.headers["x-tokenboard-signature"] ? (await import("../src/crypto.mjs")).sha256Base64Url(calls[0].init.body) : ""
    ].join("\n")),
    secrets.publicKeyPem,
    Buffer.from(calls[0].init.headers["x-tokenboard-signature"], "base64url")
  );
  assert.equal(signatureValid, true);
  const updated = await loadRuntime(fixture.paths);
  assert.equal(updated.state.nextSequence, 2);
  assert.equal(updated.state.previousRequestDigest, "digest_1234567890abcdef");

  const second = await sync({
    home: fixture.home,
    roots: fixture.roots,
    officialEvidence: false,
    fetchImpl: async () => { throw new Error("network should not run with no changes"); },
    now: 1_750_000_100_000
  });
  assert.equal(second.sent, 0);
});

test("Codex lifetime authority is the first checkpoint in the first ingest request", async (context) => {
  const fixture = await setup();
  context.after(() => fs.rm(fixture.temporary, { recursive: true, force: true }));
  const secrets = createDeviceSecrets();
  secrets.dedupNamespaceKey = dedupNamespaceKey;
  const state = initialState();
  state.paired = true;
  state.deviceId = "device_lifetime_checkpoint";
  const config = initialConfig();
  config.endpoint = "https://artificial-games.example";
  config.allowedPlatforms = ["codex"];
  config.supportedProviders = ["codex"];
  config.transcriptFallbacks = { codex: false, claude: false, kimi: false };
  await saveSecrets(fixture.paths, secrets);
  await saveRuntime(fixture.paths, { state, config });
  const bodies = [];
  const evidence = {
    status: "available",
    summary: { lifetimeTokens: 17_772_403_863 },
    dailyUsageBuckets: [
      { startDate: "2026-07-18", tokens: 100 },
      { startDate: "2026-07-19", tokens: 200 },
      { startDate: "2026-07-20", tokens: 300 }
    ]
  };
  const result = await sync({
    home: fixture.home,
    roots: fixture.roots,
    readCodexAccountUsage: async () => evidence,
    chunkPaceMs: 0,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      return jsonResponse({
        request: { digest: `digest_lifetime_checkpoint_${bodies.length}_1234567890` },
        accepted: 0,
        duplicates: 0,
        rejected: 0
      });
    }
  });
  assert.equal(result.sent, 0);
  assert.equal(result.checkpoints, 4);
  assert.equal(bodies.length, 2);
  assert.equal(bodies.every((body) => body.events.length === 0), true);
  assert.deepEqual(bodies[0].checkpoints[0], {
    checkpointId: bodies[0].checkpoints[0].checkpointId,
    provider: "codex",
    source: "codex_app_server_account_usage_lifetime",
    periodStart: "2026-07-20T00:00:00.000Z",
    periodEnd: "2026-07-21T00:00:00.000Z",
    totalTokens: "17772403863"
  });
  assert.equal(bodies[0].checkpoints[1].source, "codex_app_server_account_usage");
  assert.deepEqual(
    bodies.flatMap((body) => body.checkpoints).map((checkpoint) => checkpoint.source),
    [
      "codex_app_server_account_usage_lifetime",
      "codex_app_server_account_usage",
      "codex_app_server_account_usage",
      "codex_app_server_account_usage"
    ]
  );
});

test("a lost response retries the exact persisted request ID and body", async (context) => {
  const fixture = await setup();
  context.after(() => fs.rm(fixture.temporary, { recursive: true, force: true }));
  const secrets = createDeviceSecrets();
  secrets.dedupNamespaceKey = dedupNamespaceKey;
  const state = initialState();
  state.paired = true;
  state.deviceId = "device_12345678";
  const config = initialConfig();
  config.endpoint = "https://artificial-games.example";
  config.allowedPlatforms = ["codex"];
  config.supportedProviders = ["codex"];
  config.transcriptFallbacks = { codex: true, claude: false, kimi: false };
  await saveSecrets(fixture.paths, secrets);
  await saveRuntime(fixture.paths, { state, config });

  let firstRequest;
  await assert.rejects(() => sync({
    home: fixture.home,
    roots: fixture.roots,
    officialEvidence: false,
    fetchImpl: async (url, init) => {
      firstRequest = { url, init };
      throw new Error("simulated response loss after server acceptance");
    },
    now: 1_750_000_000_000,
    maxAttempts: 1
  }), /could not be reached/);
  const afterLoss = await loadRuntime(fixture.paths);
  assert.equal(afterLoss.state.pendingRequest.sequence, 1);

  let retryRequest;
  const recovered = await sync({
    home: fixture.home,
    roots: fixture.roots,
    officialEvidence: false,
    fetchImpl: async (url, init) => {
      retryRequest = { url, init };
      return jsonResponse({
        request: { digest: "digest_replayed_123456" },
        accepted: 1,
        duplicates: 0,
        rejected: 0
      });
    },
    now: 1_750_000_100_000
  });
  assert.equal(recovered.recovered, true);
  assert.equal(retryRequest.init.body, firstRequest.init.body);
  assert.equal(
    retryRequest.init.headers["x-tokenboard-request-id"],
    firstRequest.init.headers["x-tokenboard-request-id"]
  );
  assert.equal(retryRequest.init.headers["x-tokenboard-sequence"], "1");
  const afterRecovery = await loadRuntime(fixture.paths);
  assert.equal(afterRecovery.state.pendingRequest, null);
  assert.equal(afterRecovery.state.nextSequence, 2);
  assert.equal(afterRecovery.state.previousRequestDigest, "digest_replayed_123456");
});

test("sync chunks first-history uploads to backend limits and commits after the final chunk", async (context) => {
  const fixture = await setup();
  context.after(() => fs.rm(fixture.temporary, { recursive: true, force: true }));
  const wirePath = path.join(fixture.roots.kimi, "session", "agents", "main", "wire.jsonl");
  const lines = Array.from({ length: 8 }, (_unused, index) => JSON.stringify({
    type: "usage.record",
    time: new Date(Date.parse("2026-07-19T12:00:00.000Z") + index * 1_000).toISOString(),
    model: "kimi-code/kimi-for-coding-highspeed",
    usage: { inputOther: 10 + index, inputCacheRead: 2, inputCacheCreation: 1, output: 5 },
    usageScope: "turn"
  })).join("\n") + "\n";
  await fs.writeFile(wirePath, lines, "utf8");
  const secrets = createDeviceSecrets();
  secrets.dedupNamespaceKey = dedupNamespaceKey;
  const state = initialState();
  state.paired = true;
  state.deviceId = "device_12345678";
  const config = initialConfig();
  config.endpoint = "https://artificial-games.example";
  config.allowedPlatforms = ["kimi"];
  config.supportedProviders = ["kimi"];
  config.transcriptFallbacks = { codex: false, claude: false, kimi: true };
  await saveSecrets(fixture.paths, secrets);
  await saveRuntime(fixture.paths, { state, config });
  const batches = [];
  const result = await sync({
    home: fixture.home,
    roots: fixture.roots,
    officialEvidence: false,
    chunkPaceMs: 0,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      batches.push(body);
      const number = batches.length;
      return jsonResponse({
        request: { digest: "digest_chunk_" + number + "_1234567890" },
        accepted: body.events.length,
        duplicates: 0,
        rejected: 0,
        events: body.events.map((event) => ({ eventId: event.eventId, status: "accepted" }))
      });
    }
  });
  assert.equal(result.chunks, 3);
  assert.deepEqual(batches.map((body) => body.events.length), [3, 3, 2]);
  assert.equal(batches.every((body) => body.events.length <= 3), true);
  const updated = await loadRuntime(fixture.paths);
  assert.equal(updated.state.syncOutbox, null);
  assert.equal(updated.state.pendingRequest, null);
  assert.equal(updated.state.nextSequence, 4);
  assert.ok(Object.values(updated.state.cursors.kimi.files)[0].offset > 0);
});

test("sync pages first history into a bounded outbox and resumes without losing events", async (context) => {
  const fixture = await setup();
  context.after(() => fs.rm(fixture.temporary, { recursive: true, force: true }));
  const wirePath = path.join(fixture.roots.kimi, "session", "agents", "main", "wire.jsonl");
  const lines = Array.from({ length: 8 }, (_unused, index) => JSON.stringify({
    type: "usage.record",
    time: new Date(Date.parse("2026-07-19T12:00:00.000Z") + index * 1_000).toISOString(),
    model: "kimi-code/kimi-for-coding-highspeed",
    usage: { inputOther: 10 + index, inputCacheRead: 2, inputCacheCreation: 1, output: 5 },
    usageScope: "turn"
  })).join("\n") + "\n";
  await fs.writeFile(wirePath, lines, "utf8");
  const secrets = createDeviceSecrets();
  secrets.dedupNamespaceKey = dedupNamespaceKey;
  const state = initialState();
  state.paired = true;
  state.deviceId = "device_12345678";
  const config = initialConfig();
  config.endpoint = "https://artificial-games.example";
  config.allowedPlatforms = ["kimi"];
  config.supportedProviders = ["kimi"];
  config.transcriptFallbacks = { codex: false, claude: false, kimi: true };
  await saveSecrets(fixture.paths, secrets);
  await saveRuntime(fixture.paths, { state, config });
  const uploadedIds = [];
  let digest = 0;
  const runPage = () => sync({
    home: fixture.home,
    roots: fixture.roots,
    officialEvidence: false,
    maximumEventsPerProvider: 4,
    chunkPaceMs: 0,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      uploadedIds.push(...body.events.map((event) => event.eventId));
      digest += 1;
      return jsonResponse({
        request: { digest: `digest_page_${digest}_1234567890` },
        accepted: body.events.length,
        duplicates: 0,
        rejected: 0,
        events: body.events.map((event) => ({ eventId: event.eventId, status: "accepted" }))
      });
    }
  });

  const first = await runPage();
  assert.equal(first.sent, 4);
  assert.equal(first.catchingUp, true);
  assert.equal((await loadRuntime(fixture.paths)).state.syncOutbox, null);
  const second = await runPage();
  assert.equal(second.sent, 4);
  assert.equal(second.catchingUp, false);
  const third = await runPage();
  assert.equal(third.sent, 0);
  assert.equal(new Set(uploadedIds).size, 8);
  assert.equal(uploadedIds.length, 8);
  assert.equal(
    Object.values((await loadRuntime(fixture.paths)).state.cursors.kimi.files)[0].offset,
    (await fs.stat(wirePath)).size
  );
});

test("aggregate sync emits stable hourly model totals inside the scored history window", async (context) => {
  const fixture = await setup();
  context.after(() => fs.rm(fixture.temporary, { recursive: true, force: true }));
  const wirePath = path.join(fixture.roots.kimi, "session", "agents", "main", "wire.jsonl");
  const lines = Array.from({ length: 6 }, (_unused, index) => JSON.stringify({
    type: "usage.record",
    time: new Date(Date.parse("2026-07-19T12:00:00.000Z") + index * 1_000).toISOString(),
    model: "kimi-code/kimi-for-coding-highspeed",
    usage: { inputOther: 10 + index, inputCacheRead: 2, inputCacheCreation: 1, output: 5 },
    usageScope: "turn"
  })).join("\n") + "\n";
  await fs.writeFile(wirePath, lines, "utf8");
  const secrets = createDeviceSecrets();
  secrets.dedupNamespaceKey = dedupNamespaceKey;
  const configuredState = () => {
    const state = initialState();
    state.paired = true;
    state.deviceId = "device_12345678";
    state.cursors.aggregate = {
      version: 2,
      providers: {
        codex: { through: null },
        claude: { through: null },
        kimi: { through: "2026-07-19T00:00:00.000Z" }
      }
    };
    return state;
  };
  const config = initialConfig();
  config.endpoint = "https://artificial-games.example";
  config.allowedPlatforms = ["kimi"];
  config.supportedProviders = ["kimi"];
  config.transcriptFallbacks = { codex: false, claude: false, kimi: true };
  const run = async (home, paths) => {
    await saveSecrets(paths, secrets);
    await saveRuntime(paths, { state: configuredState(), config });
    const uploaded = [];
    const result = await sync({
      home,
      roots: fixture.roots,
      aggregateHistory: true,
      now: Date.parse("2026-07-20T12:00:00.000Z"),
      officialEvidence: false,
      chunkPaceMs: 0,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(init.body);
        uploaded.push(...body.events);
        return jsonResponse({
          request: { digest: "digest_aggregate_1234567890" },
          accepted: body.events.length,
          duplicates: 0,
          rejected: 0,
          events: body.events.map((event) => ({ eventId: event.eventId, status: "accepted" }))
        });
      }
    });
    return { result, uploaded };
  };

  const first = await run(fixture.home, fixture.paths);
  await fs.writeFile(
    wirePath,
    lines.trimEnd().split("\n").reverse().join("\n") + "\n",
    "utf8"
  );
  const secondHome = path.join(fixture.temporary, "second-state");
  const second = await run(secondHome, runtimePaths({ home: secondHome }));
  assert.equal(first.uploaded.length, 1);
  assert.deepEqual(first.uploaded, second.uploaded);
  assert.equal(first.uploaded[0].occurredAt, "2026-07-19T12:30:00.000Z");
  assert.equal(first.uploaded[0].inputTokens, "81");
  assert.equal(first.uploaded[0].cachedInputTokens, "12");
  assert.equal(first.uploaded[0].outputTokens, "30");
  assert.equal(first.result.catchingUp, false);
});

test("aggregate history above 5,000 records is durably paged instead of rejected", async (context) => {
  const fixture = await setup();
  context.after(() => fs.rm(fixture.temporary, { recursive: true, force: true }));
  const wirePath = path.join(fixture.roots.kimi, "session", "agents", "main", "wire.jsonl");
  const lines = Array.from({ length: MAX_SYNC_OUTBOX_EVENTS + 1 }, (_unused, index) => JSON.stringify({
    type: "usage.record",
    time: "2026-07-19T12:00:01.000Z",
    model: `future-model-${index}`,
    usage: { inputOther: 10, inputCacheRead: 2, inputCacheCreation: 1, output: 5 },
    usageScope: "turn"
  })).join("\n") + "\n";
  await fs.writeFile(wirePath, lines, "utf8");
  const secrets = createDeviceSecrets();
  secrets.dedupNamespaceKey = dedupNamespaceKey;
  const state = initialState();
  state.paired = true;
  state.deviceId = "device_paged_history";
  const config = initialConfig();
  config.endpoint = "https://artificial-games.example";
  config.allowedPlatforms = ["kimi"];
  config.supportedProviders = ["kimi"];
  config.transcriptFallbacks = { codex: false, claude: false, kimi: true };
  await saveSecrets(fixture.paths, secrets);
  await saveRuntime(fixture.paths, { state, config });

  const result = await sync({
    home: fixture.home,
    roots: fixture.roots,
    aggregateHistory: true,
    now: Date.parse("2026-07-20T12:00:00.000Z"),
    officialEvidence: false,
    maxIngestRequests: 0,
    canonicalModelId: () => "kimi-k2.7-code",
    fetchImpl: async () => { throw new Error("a zero-request run must not use the network"); }
  });

  assert.equal(result.sent, 0);
  assert.equal(result.catchingUp, true);
  const updated = await loadRuntime(fixture.paths);
  const outbox = updated.state.syncOutbox;
  assert.equal(outbox.version, 4);
  assert.equal(outbox.totalEvents, MAX_SYNC_OUTBOX_EVENTS + 1);
  assert.equal(outbox.pageCount, 2);
  assert.equal(outbox.pages[0].eventCount, MAX_SYNC_OUTBOX_EVENTS);
  assert.equal(outbox.pages[1].eventCount, 1);
  assert.equal(outbox.chunks.flatMap((chunk) => chunk.events).length, MAX_SYNC_OUTBOX_EVENTS);
  assert.equal(updated.state.cursors.aggregate.providers.kimi.through, null);
  const deferredPage = path.join(
    fixture.paths.syncPages,
    outbox.batchId,
    "000001.json"
  );
  const deferred = JSON.parse(await fs.readFile(deferredPage, "utf8"));
  assert.equal(deferred.events.length, 1);
});

test("paged aggregate outbox resumes newest-first and commits cursors only after its final page", async (context) => {
  const fixture = await setup();
  context.after(() => fs.rm(fixture.temporary, { recursive: true, force: true }));
  const wirePath = path.join(fixture.roots.kimi, "session", "agents", "main", "wire.jsonl");
  const lines = Array.from({ length: 5 }, (_unused, index) => JSON.stringify({
    type: "usage.record",
    time: `2026-07-19T${String(8 + index).padStart(2, "0")}:00:01.000Z`,
    model: "kimi-code/kimi-for-coding",
    usage: { inputOther: 10 + index, inputCacheRead: 2, inputCacheCreation: 1, output: 5 },
    usageScope: "turn"
  })).join("\n") + "\n";
  await fs.writeFile(wirePath, lines, "utf8");
  const secrets = createDeviceSecrets();
  secrets.dedupNamespaceKey = dedupNamespaceKey;
  const state = initialState();
  state.paired = true;
  state.deviceId = "device_paged_resume";
  const config = initialConfig();
  config.endpoint = "https://artificial-games.example";
  config.allowedPlatforms = ["kimi"];
  config.supportedProviders = ["kimi"];
  config.transcriptFallbacks = { codex: false, claude: false, kimi: true };
  await saveSecrets(fixture.paths, secrets);
  await saveRuntime(fixture.paths, { state, config });
  const uploaded = [];
  let digest = 0;
  const runOnePage = () => sync({
    home: fixture.home,
    roots: fixture.roots,
    aggregateHistory: true,
    maximumSyncPageEvents: 2,
    maxIngestRequests: 1,
    now: Date.parse("2026-07-20T12:00:00.000Z"),
    officialEvidence: false,
    chunkPaceMs: 0,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      uploaded.push(...body.events);
      digest += 1;
      return jsonResponse({
        request: { digest: `digest_paged_resume_${digest}_1234567890` },
        accepted: body.events.length,
        duplicates: 0,
        rejected: 0,
        events: body.events.map((event) => ({ eventId: event.eventId, status: "accepted" }))
      });
    }
  });

  const first = await runOnePage();
  assert.equal(first.sent, 2);
  const afterFirst = await loadRuntime(fixture.paths);
  const batchId = afterFirst.state.syncOutbox.batchId;
  assert.equal(afterFirst.state.syncOutbox.pageIndex, 1);
  assert.equal(afterFirst.state.cursors.aggregate.providers.kimi.through, null);
  assert.equal(await fs.access(path.join(fixture.paths.syncPages, batchId)).then(() => true), true);
  assert.equal((await status({ home: fixture.home })).pendingChunks, 2);

  const second = await runOnePage();
  assert.equal(second.sent, 2);
  const afterSecond = await loadRuntime(fixture.paths);
  assert.equal(afterSecond.state.syncOutbox.pageIndex, 2);
  assert.equal(afterSecond.state.cursors.aggregate.providers.kimi.through, null);

  const third = await runOnePage();
  assert.equal(third.sent, 1);
  assert.equal(third.catchingUp, false);
  const completed = await loadRuntime(fixture.paths);
  assert.equal(completed.state.syncOutbox, null);
  assert.equal(completed.state.cursors.aggregate.providers.kimi.through, "2026-07-20T11:00:00.000Z");
  assert.equal(await fs.access(path.join(fixture.paths.syncPages, batchId)).then(() => true).catch(() => false), false);
  assert.equal(uploaded.length, 5);
  assert.equal(new Set(uploaded.map((event) => event.eventId)).size, 5);
  assert.deepEqual(
    uploaded.map((event) => event.occurredAt),
    [...uploaded.map((event) => event.occurredAt)].sort().reverse()
  );
});

test("a missing deferred sync page fails closed without advancing aggregate cursors", async (context) => {
  const fixture = await setup();
  context.after(() => fs.rm(fixture.temporary, { recursive: true, force: true }));
  const wirePath = path.join(fixture.roots.kimi, "session", "agents", "main", "wire.jsonl");
  await fs.writeFile(wirePath, Array.from({ length: 5 }, (_unused, index) => JSON.stringify({
    type: "usage.record",
    time: `2026-07-19T${String(8 + index).padStart(2, "0")}:00:01.000Z`,
    model: "kimi-code/kimi-for-coding",
    usage: { inputOther: 10 + index, inputCacheRead: 2, inputCacheCreation: 1, output: 5 },
    usageScope: "turn"
  })).join("\n") + "\n", "utf8");
  const secrets = createDeviceSecrets();
  secrets.dedupNamespaceKey = dedupNamespaceKey;
  const state = initialState();
  state.paired = true;
  state.deviceId = "device_corrupt_page";
  const config = initialConfig();
  config.endpoint = "https://artificial-games.example";
  config.allowedPlatforms = ["kimi"];
  config.supportedProviders = ["kimi"];
  config.transcriptFallbacks = { codex: false, claude: false, kimi: true };
  await saveSecrets(fixture.paths, secrets);
  await saveRuntime(fixture.paths, { state, config });
  let digest = 0;
  const run = () => sync({
    home: fixture.home,
    roots: fixture.roots,
    aggregateHistory: true,
    maximumSyncPageEvents: 2,
    maxIngestRequests: 1,
    now: Date.parse("2026-07-20T12:00:00.000Z"),
    officialEvidence: false,
    chunkPaceMs: 0,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      digest += 1;
      return jsonResponse({
        request: { digest: `digest_corrupt_page_${digest}_1234567890` },
        accepted: body.events.length,
        duplicates: 0,
        rejected: 0,
        events: body.events.map((event) => ({ eventId: event.eventId, status: "accepted" }))
      });
    }
  });
  await run();
  const pending = await loadRuntime(fixture.paths);
  const missingPage = path.join(
    fixture.paths.syncPages,
    pending.state.syncOutbox.batchId,
    "000002.json"
  );
  await fs.rm(missingPage);
  await assert.rejects(run, (error) => error.code === "SYNC_BATCH_CORRUPT");
  const failed = await loadRuntime(fixture.paths);
  assert.equal(failed.state.cursors.aggregate.providers.kimi.through, null);
  assert.notEqual(failed.state.syncOutbox, null);
});

test("a split runtime save failure never leaves state pointing at deleted sync pages", async (context) => {
  const fixture = await setup();
  context.after(() => fs.rm(fixture.temporary, { recursive: true, force: true }));
  const wirePath = path.join(fixture.roots.kimi, "session", "agents", "main", "wire.jsonl");
  await fs.writeFile(wirePath, Array.from({ length: 5 }, (_unused, index) => JSON.stringify({
    type: "usage.record",
    time: `2026-07-19T${String(8 + index).padStart(2, "0")}:00:01.000Z`,
    model: "kimi-code/kimi-for-coding",
    usage: { inputOther: 10 + index, inputCacheRead: 2, inputCacheCreation: 1, output: 5 },
    usageScope: "turn"
  })).join("\n") + "\n", "utf8");
  const secrets = createDeviceSecrets();
  secrets.dedupNamespaceKey = dedupNamespaceKey;
  const state = initialState();
  state.paired = true;
  state.deviceId = "device_split_save";
  const config = initialConfig();
  config.endpoint = "https://artificial-games.example";
  config.allowedPlatforms = ["kimi"];
  config.supportedProviders = ["kimi"];
  config.transcriptFallbacks = { codex: false, claude: false, kimi: true };
  await saveSecrets(fixture.paths, secrets);
  await saveRuntime(fixture.paths, { state, config });
  const writeOrder = [];

  await assert.rejects(() => sync({
    home: fixture.home,
    roots: fixture.roots,
    aggregateHistory: true,
    maximumSyncPageEvents: 2,
    maxIngestRequests: 0,
    now: Date.parse("2026-07-20T12:00:00.000Z"),
    officialEvidence: false,
    atomicWriteJson: async (filePath, value, mode) => {
      writeOrder.push(filePath);
      if (filePath === fixture.paths.state) {
        throw new Error("simulated state commit failure");
      }
      return atomicWriteJson(filePath, value, mode);
    },
    fetchImpl: async () => { throw new Error("a zero-request run must not use the network"); }
  }), /simulated state commit failure/);

  assert.deepEqual(writeOrder, [fixture.paths.config, fixture.paths.state]);
  const persisted = await loadRuntime(fixture.paths);
  assert.equal(persisted.state.syncOutbox, null);
  assert.equal(persisted.state.cursors.aggregate.providers.kimi.through, null);
  const leftoverBatches = await fs.readdir(fixture.paths.syncPages).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  assert.deepEqual(leftoverBatches, []);

  const retry = await sync({
    home: fixture.home,
    roots: fixture.roots,
    aggregateHistory: true,
    maximumSyncPageEvents: 2,
    maxIngestRequests: 0,
    now: Date.parse("2026-07-20T12:00:00.000Z"),
    officialEvidence: false,
    fetchImpl: async () => { throw new Error("a zero-request run must not use the network"); }
  });
  assert.equal(retry.catchingUp, true);
  assert.equal((await loadRuntime(fixture.paths)).state.syncOutbox.pageCount, 3);
});

test("aggregate through watermarks advance independently and preserve deferred provider history", async (context) => {
  const fixture = await setup();
  context.after(() => fs.rm(fixture.temporary, { recursive: true, force: true }));
  const secrets = createDeviceSecrets();
  secrets.dedupNamespaceKey = dedupNamespaceKey;
  const state = initialState();
  state.paired = true;
  state.deviceId = "device_provider_watermarks";
  const config = initialConfig();
  config.endpoint = "https://artificial-games.example";
  config.allowedPlatforms = ["claude", "kimi"];
  config.supportedProviders = ["claude", "kimi"];
  config.transcriptFallbacks = { codex: false, claude: false, kimi: true };
  await saveSecrets(fixture.paths, secrets);
  await saveRuntime(fixture.paths, { state, config });
  const uploaded = [];
  let digest = 0;
  const run = (now, extra = {}) => sync({
    home: fixture.home,
    roots: fixture.roots,
    aggregateHistory: true,
    now: Date.parse(now),
    officialEvidence: false,
    chunkPaceMs: 0,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      uploaded.push(...body.events);
      digest += 1;
      return jsonResponse({
        request: { digest: `digest_provider_watermark_${digest}_1234567890` },
        accepted: body.events.length,
        duplicates: 0,
        rejected: 0,
        events: body.events.map((event) => ({ eventId: event.eventId, status: "accepted" }))
      });
    },
    ...extra
  });

  await run("2026-07-20T12:00:00.000Z");
  let runtime = await loadRuntime(fixture.paths);
  assert.equal(runtime.state.cursors.aggregate.providers.kimi.through, "2026-07-20T11:00:00.000Z");
  assert.equal(runtime.state.cursors.aggregate.providers.claude.through, null);

  runtime.config.transcriptFallbacks.claude = true;
  await saveRuntime(fixture.paths, runtime);
  await run("2026-07-20T12:00:00.000Z");
  runtime = await loadRuntime(fixture.paths);
  assert.equal(runtime.state.cursors.aggregate.providers.claude.through, "2026-07-20T11:00:00.000Z");

  const claudePath = path.join(fixture.roots.claude, "project.jsonl");
  await fs.appendFile(claudePath, JSON.stringify({
    type: "assistant",
    timestamp: "2026-07-20T12:00:01.000Z",
    message: {
      id: "msg_deferred_provider",
      model: "claude-sonnet-5-20260701",
      stop_reason: "end_turn",
      content: "PRIVATE_DEFERRED_CONTENT",
      usage: { input_tokens: 21, cache_read_input_tokens: 4, output_tokens: 9, speed: "standard" }
    }
  }) + "\n", "utf8");
  const providerDiscovery = (status) => async (root) => {
    if (root === fixture.roots.claude) {
      return {
        files: status === "complete" ? [claudePath] : [],
        unavailable: status === "unavailable",
        truncated: status === "truncated"
      };
    }
    return discoverJsonlFiles(root);
  };

  const unavailable = await run("2026-07-20T14:20:00.000Z", {
    discoverJsonlFiles: providerDiscovery("unavailable")
  });
  assert.equal(unavailable.catchingUp, true);
  runtime = await loadRuntime(fixture.paths);
  assert.equal(runtime.state.cursors.aggregate.providers.claude.through, "2026-07-20T11:00:00.000Z");
  assert.equal(runtime.state.cursors.aggregate.providers.kimi.through, "2026-07-20T14:00:00.000Z");

  const truncated = await run("2026-07-20T15:20:00.000Z", {
    discoverJsonlFiles: providerDiscovery("truncated")
  });
  assert.equal(truncated.catchingUp, true);
  runtime = await loadRuntime(fixture.paths);
  assert.equal(runtime.state.cursors.aggregate.providers.claude.through, "2026-07-20T11:00:00.000Z");
  assert.equal(runtime.state.cursors.aggregate.providers.kimi.through, "2026-07-20T15:00:00.000Z");

  const beforeDeferredCapture = uploaded.length;
  await run("2026-07-20T16:20:00.000Z", {
    discoverJsonlFiles: providerDiscovery("complete")
  });
  runtime = await loadRuntime(fixture.paths);
  assert.equal(runtime.state.cursors.aggregate.providers.claude.through, "2026-07-20T16:00:00.000Z");
  assert.equal(runtime.state.cursors.aggregate.providers.kimi.through, "2026-07-20T16:00:00.000Z");
  assert.equal(uploaded.slice(beforeDeferredCapture).some((event) =>
    event.provider === "claude" && event.occurredAt === "2026-07-20T12:30:00.000Z"
  ), true);

  await run("2026-07-20T13:00:00.000Z", {
    discoverJsonlFiles: providerDiscovery("complete")
  });
  runtime = await loadRuntime(fixture.paths);
  assert.equal(runtime.state.cursors.aggregate.providers.claude.through, "2026-07-20T16:00:00.000Z");
  assert.equal(runtime.state.cursors.aggregate.providers.kimi.through, "2026-07-20T16:00:00.000Z");
});

test("hourly aggregation counts duplicate physical Codex journals only once", async (context) => {
  const fixture = await setup();
  context.after(() => fs.rm(fixture.temporary, { recursive: true, force: true }));
  await fs.copyFile(
    path.join(fixture.roots.codex, "rollout.jsonl"),
    path.join(fixture.roots.codex, "duplicate-rollout.jsonl")
  );
  const secrets = createDeviceSecrets();
  secrets.dedupNamespaceKey = dedupNamespaceKey;
  const state = initialState();
  state.paired = true;
  state.deviceId = "device_duplicate_journal";
  const config = initialConfig();
  config.endpoint = "https://artificial-games.example";
  config.allowedPlatforms = ["codex"];
  config.supportedProviders = ["codex"];
  config.transcriptFallbacks = { codex: true, claude: false, kimi: false };
  await saveSecrets(fixture.paths, secrets);
  await saveRuntime(fixture.paths, { state, config });
  const uploaded = [];
  const result = await sync({
    home: fixture.home,
    roots: fixture.roots,
    aggregateHistory: true,
    now: Date.parse("2026-07-20T12:00:00.000Z"),
    officialEvidence: false,
    chunkPaceMs: 0,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      uploaded.push(...body.events);
      return jsonResponse({
        request: { digest: "digest_duplicate_journal_1234567890" },
        accepted: body.events.length,
        duplicates: 0,
        rejected: 0,
        events: body.events.map((event) => ({ eventId: event.eventId, status: "accepted" }))
      });
    }
  });

  assert.equal(result.sent, 1);
  assert.equal(uploaded.length, 1);
  assert.equal(uploaded[0].inputTokens, "65");
  assert.equal(uploaded[0].cachedInputTokens, "40");
  assert.equal(uploaded[0].outputTokens, "30");
});

test("aggregation preserves oversized source usage for backend quarantine", async (context) => {
  const fixture = await setup();
  context.after(() => fs.rm(fixture.temporary, { recursive: true, force: true }));
  const wirePath = path.join(fixture.roots.kimi, "session", "agents", "main", "wire.jsonl");
  await fs.writeFile(wirePath, JSON.stringify({
    type: "usage.record",
    time: "2026-07-19T12:05:00.000Z",
    model: "kimi-code/kimi-for-coding",
    usage: { inputOther: 120_000_000, inputCacheRead: 2, inputCacheCreation: 1, output: 5 },
    usageScope: "turn"
  }) + "\n", "utf8");
  const secrets = createDeviceSecrets();
  secrets.dedupNamespaceKey = dedupNamespaceKey;
  const state = initialState();
  state.paired = true;
  state.deviceId = "device_source_anomaly";
  const config = initialConfig();
  config.endpoint = "https://artificial-games.example";
  config.allowedPlatforms = ["kimi"];
  config.supportedProviders = ["kimi"];
  config.transcriptFallbacks = { codex: false, claude: false, kimi: true };
  await saveSecrets(fixture.paths, secrets);
  await saveRuntime(fixture.paths, { state, config });
  const uploaded = [];
  const result = await sync({
    home: fixture.home,
    roots: fixture.roots,
    aggregateHistory: true,
    now: Date.parse("2026-07-20T12:00:00.000Z"),
    officialEvidence: false,
    chunkPaceMs: 0,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      uploaded.push(...body.events);
      return jsonResponse({
        request: { digest: "digest_source_anomaly_1234567890" },
        accepted: body.events.length,
        duplicates: 0,
        rejected: 0,
        events: body.events.map((event) => ({ eventId: event.eventId, status: "accepted" }))
      });
    }
  });

  assert.equal(result.sent, 1);
  assert.equal(uploaded.length, 1);
  assert.equal(uploaded[0].occurredAt, "2026-07-19T12:30:00.000Z");
  assert.equal(uploaded[0].inputTokens, "120000001");
  assert.equal(uploaded[0].cachedInputTokens, "2");
  assert.equal(uploaded[0].outputTokens, "5");
});

test("initial aggregate import skips guaranteed-quarantine history and preserves source hours", async (context) => {
  const fixture = await setup();
  context.after(() => fs.rm(fixture.temporary, { recursive: true, force: true }));
  const wirePath = path.join(fixture.roots.kimi, "session", "agents", "main", "wire.jsonl");
  const record = (time, input) => JSON.stringify({
    type: "usage.record",
    time,
    model: "kimi-code/kimi-for-coding",
    usage: { inputOther: input, inputCacheRead: 2, inputCacheCreation: 1, output: 5 },
    usageScope: "turn"
  });
  await fs.writeFile(wirePath, [
    record("2026-03-01T12:05:00.000Z", 100),
    record("2026-07-19T12:05:00.000Z", 10),
    record("2026-07-19T13:05:00.000Z", 20)
  ].join("\n") + "\n", "utf8");
  const secrets = createDeviceSecrets();
  secrets.dedupNamespaceKey = dedupNamespaceKey;
  const state = initialState();
  state.paired = true;
  state.deviceId = "device_history_window";
  const config = initialConfig();
  config.endpoint = "https://artificial-games.example";
  config.allowedPlatforms = ["kimi"];
  config.supportedProviders = ["kimi"];
  config.transcriptFallbacks = { codex: false, claude: false, kimi: true };
  await saveSecrets(fixture.paths, secrets);
  await saveRuntime(fixture.paths, { state, config });
  const uploaded = [];
  const run = () => sync({
    home: fixture.home,
    roots: fixture.roots,
    aggregateHistory: true,
    now: Date.parse("2026-07-20T12:00:00.000Z"),
    officialEvidence: false,
    chunkPaceMs: 0,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      uploaded.push(...body.events);
      return jsonResponse({
        request: { digest: "digest_history_window_1234567890" },
        accepted: body.events.length,
        duplicates: 0,
        rejected: 0,
        events: body.events.map((event) => ({ eventId: event.eventId, status: "accepted" }))
      });
    }
  });

  assert.equal((await run()).sent, 2);
  assert.deepEqual(
    uploaded.map((event) => event.occurredAt.slice(0, 13)),
    ["2026-07-19T13", "2026-07-19T12"]
  );
  assert.deepEqual(uploaded.map((event) => event.inputTokens), ["21", "11"]);
  assert.equal((await run()).sent, 0);
  assert.equal(uploaded.length, 2);
});

test("aggregate sync finalizes settled hours and advances to newly settled usage", async (context) => {
  const fixture = await setup();
  context.after(() => fs.rm(fixture.temporary, { recursive: true, force: true }));
  const wirePath = path.join(fixture.roots.kimi, "session", "agents", "main", "wire.jsonl");
  const record = (hour, second, input) => JSON.stringify({
    type: "usage.record",
    time: `2026-07-20T${String(hour).padStart(2, "0")}:00:${String(second).padStart(2, "0")}.000Z`,
    model: "kimi-code/kimi-for-coding-highspeed",
    usage: { inputOther: input, inputCacheRead: 2, inputCacheCreation: 1, output: 5 },
    usageScope: "turn"
  });
  await fs.writeFile(wirePath, record(10, 1, 10) + "\n", "utf8");
  const secrets = createDeviceSecrets();
  secrets.dedupNamespaceKey = dedupNamespaceKey;
  const state = initialState();
  state.paired = true;
  state.deviceId = "device_12345678";
  const config = initialConfig();
  config.endpoint = "https://artificial-games.example";
  config.allowedPlatforms = ["kimi"];
  config.supportedProviders = ["kimi"];
  config.transcriptFallbacks = { codex: false, claude: false, kimi: true };
  await saveSecrets(fixture.paths, secrets);
  await saveRuntime(fixture.paths, { state, config });
  let digest = 0;
  const uploaded = [];
  const run = (now) => sync({
    home: fixture.home,
    roots: fixture.roots,
    aggregateHistory: true,
    now: Date.parse(now),
    officialEvidence: false,
    chunkPaceMs: 0,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      uploaded.push(...body.events);
      digest += 1;
      return jsonResponse({
        request: { digest: `digest_append_${digest}_1234567890` },
        accepted: body.events.length,
        duplicates: 0,
        rejected: 0,
        events: body.events.map((event) => ({ eventId: event.eventId, status: "accepted" }))
      });
    }
  });

  assert.equal((await run("2026-07-20T12:00:00.000Z")).sent, 1);
  await fs.appendFile(
    wirePath,
    record(10, 2, 20) + "\n" + record(11, 2, 30) + "\n",
    "utf8"
  );
  assert.equal((await run("2026-07-20T12:20:00.000Z")).sent, 1);
  assert.equal(uploaded.length, 2);
  assert.notEqual(uploaded[0].eventId, uploaded[1].eventId);
  assert.deepEqual(uploaded.map((event) => event.inputTokens), ["11", "31"]);
  assert.deepEqual(uploaded.map((event) => event.cachedInputTokens), ["2", "2"]);
  assert.deepEqual(uploaded.map((event) => event.outputTokens), ["5", "5"]);
});

test("sync migrates an oversized released-v1 raw outbox without replaying accepted source IDs", async (context) => {
  const fixture = await setup();
  context.after(() => fs.rm(fixture.temporary, { recursive: true, force: true }));
  const secrets = createDeviceSecrets();
  secrets.dedupNamespaceKey = dedupNamespaceKey;
  const state = initialState();
  state.paired = true;
  state.deviceId = "device_12345678";
  state.cursors.aggregate = {
    version: 1,
    windowStart: "2026-06-15T00:00:00.000Z",
    through: "2026-07-19T00:00:00.000Z"
  };
  const wirePath = path.join(fixture.roots.kimi, "session", "agents", "main", "wire.jsonl");
  const [rawEvent] = (await parseKimiWire(wirePath, {
    dedupNamespaceKey,
    stableJournalIdentity: sha256("kimi-session-agent\0session\0main")
  })).events;
  state.syncOutbox = {
    version: 1,
    index: 1,
    chunks: [{
      events: [{
        eventId: rawEvent.eventId,
        occurredAt: rawEvent.observedAt,
        provider: "kimi",
        modelId: "kimi-k2.7-code",
        serviceMode: "standard",
        inputTokens: "10",
        cachedInputTokens: "2",
        outputTokens: "5",
        surface: "kimi_code"
      }],
      checkpoints: []
    }],
    totalEvents: MAX_SYNC_OUTBOX_EVENTS + 1,
    totalCheckpoints: 0,
    accepted: 0,
    duplicates: 0,
    rejected: 0,
    quarantinedEventIds: [],
    commit: {
      nextCursors: initialState().cursors,
      checkpointHash: null,
      scannedAt: "2026-07-19T12:00:00.000Z",
      scanSummary: {},
      withheld: 0,
      unknownModels: [],
      nextUnresolvedEvents: [],
      unresolvedOverflow: { totalDropped: 0, lastOverflowAt: null }
    }
  };
  const config = initialConfig();
  config.endpoint = "https://artificial-games.example";
  config.allowedPlatforms = ["kimi"];
  config.supportedProviders = ["kimi"];
  config.transcriptFallbacks = { codex: false, claude: false, kimi: true };
  await saveSecrets(fixture.paths, secrets);
  await saveRuntime(fixture.paths, { state, config });
  const uploadedIds = [];
  const result = await sync({
    home: fixture.home,
    roots: fixture.roots,
    aggregateHistory: true,
    now: Date.parse("2026-07-20T12:00:00.000Z"),
    officialEvidence: false,
    chunkPaceMs: 0,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      uploadedIds.push(...body.events.map((event) => event.eventId));
      return jsonResponse({
        request: { digest: "digest_requeued_1234567890" },
        accepted: body.events.length,
        duplicates: 0,
        rejected: 0,
        events: body.events.map((event) => ({ eventId: event.eventId, status: "accepted" }))
      });
    }
  });
  assert.equal(result.sent, 0);
  assert.deepEqual(uploadedIds, []);
  const completed = await loadRuntime(fixture.paths);
  assert.equal(completed.state.syncOutbox, null);
  assert.equal(completed.state.migrationExcludedEvents[0].eventId, rawEvent.eventId);
  assert.match(await fs.readFile(fixture.paths.log, "utf8"), /requeued_released_v1_outbox/);
});

test("sync discards only stale v3 remaining work while preserving the request chain", async (context) => {
  const fixture = await setup();
  context.after(() => fs.rm(fixture.temporary, { recursive: true, force: true }));
  const secrets = createDeviceSecrets();
  secrets.dedupNamespaceKey = dedupNamespaceKey;
  const state = initialState();
  state.paired = true;
  state.deviceId = "device_v3_migration";
  state.nextSequence = 17;
  state.previousRequestDigest = "digest_before_v3_migration_123456";
  state.cursors.codex.files.committed_marker = { lastSeenAt: 1 };
  state.cursors.kimi.files.preserved_marker = { lastSeenAt: 2 };
  const batchId = "a".repeat(24);
  state.syncOutbox = {
    version: 3,
    batchId,
    index: 1,
    chunks: [
      { events: [{ eventId: "b".repeat(64) }], checkpoints: [] },
      { events: [{ eventId: "c".repeat(64) }], checkpoints: [] }
    ],
    totalEvents: 2,
    totalCheckpoints: 0,
    processedEvents: 1,
    processedCheckpoints: 0
  };
  const config = initialConfig();
  config.endpoint = "https://artificial-games.example";
  await fs.mkdir(path.join(fixture.paths.syncPages, batchId), { recursive: true });
  await fs.writeFile(path.join(fixture.paths.syncPages, batchId, "000001.json"), "{}\n", "utf8");
  await saveSecrets(fixture.paths, secrets);
  await saveRuntime(fixture.paths, { state, config });

  const result = await sync({
    home: fixture.home,
    roots: fixture.roots,
    aggregateHistory: true,
    officialEvidence: false,
    fetchImpl: async () => { throw new Error("discarding idle v3 work must not use the network"); }
  });
  assert.equal(result.sent, 0);
  const updated = await loadRuntime(fixture.paths);
  assert.equal(updated.state.syncOutbox, null);
  assert.equal(updated.state.paired, true);
  assert.equal(updated.state.deviceId, "device_v3_migration");
  assert.equal(updated.state.nextSequence, 17);
  assert.equal(updated.state.previousRequestDigest, "digest_before_v3_migration_123456");
  assert.deepEqual(updated.state.cursors.codex.files, {});
  assert.deepEqual(updated.state.cursors.codex.sessions, {});
  assert.deepEqual(updated.state.cursors.kimi.files.preserved_marker, { lastSeenAt: 2 });
  assert.equal(
    await fs.access(path.join(fixture.paths.syncPages, batchId)).then(() => true).catch(() => false),
    false
  );
  assert.match(await fs.readFile(fixture.paths.log, "utf8"), /discarded_stale_v3_outbox/);
});

test("sync replays one exact pending v3 request before retiring the old generation", async (context) => {
  const fixture = await setup();
  context.after(() => fs.rm(fixture.temporary, { recursive: true, force: true }));
  const secrets = createDeviceSecrets();
  secrets.dedupNamespaceKey = dedupNamespaceKey;
  const state = initialState();
  state.paired = true;
  state.deviceId = "device_pending_v3_migration";
  const config = initialConfig();
  config.endpoint = "https://artificial-games.example";
  config.allowedPlatforms = ["kimi"];
  config.supportedProviders = ["kimi"];
  config.transcriptFallbacks = { codex: false, claude: false, kimi: true };
  await saveSecrets(fixture.paths, secrets);
  await saveRuntime(fixture.paths, { state, config });

  let firstRequest;
  await assert.rejects(() => sync({
    home: fixture.home,
    roots: fixture.roots,
    officialEvidence: false,
    maxAttempts: 1,
    chunkPaceMs: 0,
    fetchImpl: async (_url, init) => {
      firstRequest = init;
      throw new Error("simulated lost v3 response");
    }
  }), /could not be reached/);
  const stranded = await loadRuntime(fixture.paths);
  stranded.state.syncOutbox.version = 3;
  await saveRuntime(fixture.paths, stranded);

  const retries = [];
  const recovered = await sync({
    home: fixture.home,
    roots: fixture.roots,
    officialEvidence: false,
    chunkPaceMs: 0,
    fetchImpl: async (_url, init) => {
      retries.push(init);
      const body = JSON.parse(init.body);
      return jsonResponse({
        request: { digest: "digest_pending_v3_replay_1234567890" },
        accepted: body.events.length,
        duplicates: 0,
        rejected: 0,
        events: body.events.map((event) => ({ eventId: event.eventId, status: "accepted" }))
      });
    }
  });
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.retiredStaleV3, true);
  assert.equal(retries.length, 1);
  assert.equal(retries[0].body, firstRequest.body);
  assert.equal(retries[0].headers["x-tokenboard-request-id"], firstRequest.headers["x-tokenboard-request-id"]);
  const updated = await loadRuntime(fixture.paths);
  assert.equal(updated.state.pendingRequest, null);
  assert.equal(updated.state.syncOutbox, null);
  assert.equal(updated.state.nextSequence, 2);
  assert.equal(updated.state.previousRequestDigest, "digest_pending_v3_replay_1234567890");
  assert.deepEqual(updated.state.cursors.codex, { accountingVersion: 4, files: {}, sessions: {} });
  assert.match(await fs.readFile(fixture.paths.log, "utf8"), /replayed_pending_then_retired_v3_outbox/);
});

test("sync drains an unreleased version-2 aggregate outbox under its original IDs", async (context) => {
  const fixture = await setup();
  context.after(() => fs.rm(fixture.temporary, { recursive: true, force: true }));
  const secrets = createDeviceSecrets();
  secrets.dedupNamespaceKey = dedupNamespaceKey;
  const state = initialState();
  state.paired = true;
  state.deviceId = "device_version_2_drain";
  const acceptedLegacyId = sha256("accepted-version-2-hourly-aggregate");
  const remainingLegacyId = sha256("remaining-version-2-hourly-aggregate");
  const legacyEvent = (eventId, hour) => ({
    eventId,
    occurredAt: `2026-07-19T${hour}:30:00.000Z`,
    provider: "kimi",
    modelId: "kimi-k2.7-code",
    serviceMode: "standard",
    inputTokens: "10",
    cachedInputTokens: "2",
    outputTokens: "5",
    surface: "kimi_code"
  });
  const committedCursors = initialState().cursors;
  committedCursors.aggregate.providers.kimi.through = "2026-07-20T11:00:00.000Z";
  state.syncOutbox = {
    version: 2,
    index: 1,
    chunks: [
      { events: [legacyEvent(acceptedLegacyId, "10")], checkpoints: [] },
      { events: [legacyEvent(remainingLegacyId, "11")], checkpoints: [] }
    ],
    totalEvents: MAX_SYNC_OUTBOX_EVENTS + 1,
    totalCheckpoints: 0,
    accepted: 1,
    duplicates: 0,
    rejected: 0,
    quarantinedEventIds: [],
    commit: {
      nextCursors: committedCursors,
      checkpointHash: null,
      scannedAt: "2026-07-19T12:00:00.000Z",
      scanSummary: {},
      withheld: 0,
      unknownModels: [],
      nextUnresolvedEvents: [],
      unresolvedOverflow: { totalDropped: 0, lastOverflowAt: null }
    }
  };
  const config = initialConfig();
  config.endpoint = "https://artificial-games.example";
  await saveSecrets(fixture.paths, secrets);
  await saveRuntime(fixture.paths, { state, config });
  const uploadedIds = [];
  const result = await sync({
    home: fixture.home,
    roots: fixture.roots,
    aggregateHistory: true,
    chunkPaceMs: 0,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      uploadedIds.push(...body.events.map((event) => event.eventId));
      return jsonResponse({
        request: { digest: "digest_version_2_drain_1234567890" },
        accepted: body.events.length,
        duplicates: 0,
        rejected: 0,
        events: body.events.map((event) => ({ eventId: event.eventId, status: "accepted" }))
      });
    }
  });
  assert.equal(result.sent, 1);
  assert.deepEqual(uploadedIds, [remainingLegacyId]);
  const completed = await loadRuntime(fixture.paths);
  assert.equal(completed.state.syncOutbox, null);
  assert.equal(completed.state.cursors.aggregate.providers.kimi.through, "2026-07-20T11:00:00.000Z");
});

test("sync queues unknown usage without blocking later known usage and resolves it after a registry update", async (context) => {
  const fixture = await setup();
  context.after(() => fs.rm(fixture.temporary, { recursive: true, force: true }));
  const wirePath = path.join(fixture.roots.kimi, "session", "agents", "main", "wire.jsonl");
  await fs.writeFile(wirePath, [
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
  ].map(JSON.stringify).join("\n") + "\n", "utf8");
  const secrets = createDeviceSecrets();
  secrets.dedupNamespaceKey = dedupNamespaceKey;
  const state = initialState();
  state.paired = true;
  state.deviceId = "device_12345678";
  const config = initialConfig();
  config.endpoint = "https://artificial-games.example";
  config.allowedPlatforms = ["kimi"];
  config.supportedProviders = ["kimi"];
  config.transcriptFallbacks = { codex: false, claude: false, kimi: true };
  await saveSecrets(fixture.paths, secrets);
  await saveRuntime(fixture.paths, { state, config });
  const first = await sync({
    home: fixture.home,
    roots: fixture.roots,
    officialEvidence: false,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      assert.equal(body.events.length, 1);
      assert.equal(body.events[0].modelId, "kimi-k2.7-code");
      return jsonResponse({
        request: { digest: "digest_known_behind_unknown_123456" },
        accepted: 1,
        duplicates: 0,
        rejected: 0,
        events: [{ eventId: body.events[0].eventId, status: "accepted" }]
      });
    }
  });
  assert.equal(first.sent, 1);
  assert.equal(first.withheld, 1);
  assert.equal(first.unresolvedQueued, 1);
  const afterUnknown = await loadRuntime(fixture.paths);
  assert.equal(Object.values(afterUnknown.state.cursors.kimi.files)[0].offset, (await fs.stat(wirePath)).size);
  assert.equal(afterUnknown.state.unresolvedEvents.length, 1);
  assert.deepEqual(Object.keys(afterUnknown.state.unresolvedEvents[0]).sort(), [
    "cachedInputTokens",
    "eventId",
    "inputTokens",
    "occurredAt",
    "outputTokens",
    "provider",
    "serviceMode",
    "sourceModelId",
    "surface"
  ]);
  let uploaded;
  const second = await sync({
    home: fixture.home,
    roots: fixture.roots,
    officialEvidence: false,
    canonicalModelId: (_provider, sourceModelId) => sourceModelId === "kimi-future-code"
      ? "kimi-k2.7-code"
      : null,
    fetchImpl: async (_url, init) => {
      uploaded = JSON.parse(init.body);
      return jsonResponse({
        request: { digest: "digest_model_registry_update_123456" },
        accepted: 1,
        duplicates: 0,
        rejected: 0,
        events: [{ eventId: JSON.parse(init.body).events[0].eventId, status: "accepted" }]
      });
    }
  });
  assert.equal(second.sent, 1);
  assert.equal(uploaded.events[0].modelId, "kimi-k2.7-code");
  const recovered = await loadRuntime(fixture.paths);
  assert.equal(Object.values(recovered.state.cursors.kimi.files)[0].offset, (await fs.stat(wirePath)).size);
  assert.equal(recovered.state.unresolvedEvents.length, 0);
  assert.equal(second.unresolvedQueued, 0);
});

test("unresolved queue cap is explicit in state and status", async (context) => {
  const fixture = await setup();
  context.after(() => fs.rm(fixture.temporary, { recursive: true, force: true }));
  const wirePath = path.join(fixture.roots.kimi, "session", "agents", "main", "wire.jsonl");
  const lines = Array.from({ length: 3 }, (_unused, index) => JSON.stringify({
    type: "usage.record",
    time: new Date(Date.parse("2026-07-19T12:00:00.000Z") + index * 1_000).toISOString(),
    model: `kimi-future-${index}`,
    usage: { inputOther: 10 + index, inputCacheRead: 2, inputCacheCreation: 1, output: 5 },
    usageScope: "turn"
  }));
  lines.push(JSON.stringify({
    type: "usage.record",
    time: "2026-07-19T12:00:04.000Z",
    model: "SECRET PROMPT CONTENT",
    usage: { inputOther: 99, inputCacheRead: 2, inputCacheCreation: 1, output: 5 },
    usageScope: "turn"
  }));
  await fs.writeFile(wirePath, lines.join("\n") + "\n", "utf8");
  const secrets = createDeviceSecrets();
  secrets.dedupNamespaceKey = dedupNamespaceKey;
  const state = initialState();
  state.paired = true;
  state.deviceId = "device_12345678";
  const config = initialConfig();
  config.endpoint = "https://artificial-games.example";
  config.allowedPlatforms = ["kimi"];
  config.supportedProviders = ["kimi"];
  config.transcriptFallbacks = { codex: false, claude: false, kimi: true };
  await saveSecrets(fixture.paths, secrets);
  await saveRuntime(fixture.paths, { state, config });
  const result = await sync({
    home: fixture.home,
    roots: fixture.roots,
    officialEvidence: false,
    unresolvedQueueCap: 2,
    canonicalModelId: () => null,
    fetchImpl: async () => { throw new Error("unresolved usage must stay local"); }
  });
  assert.equal(result.sent, 0);
  assert.equal(result.withheld, 4);
  assert.equal(result.unresolvedQueued, 2);
  assert.equal(result.unresolvedOverflow, 1);
  const connectorStatus = await status({ home: fixture.home });
  assert.equal(connectorStatus.unresolvedQueued, 2);
  assert.equal(connectorStatus.unresolvedOverflow.totalDropped, 1);
  assert.equal(typeof connectorStatus.unresolvedOverflow.lastOverflowAt, "string");
  assert.equal(connectorStatus.lastScan.adapters.kimi.malformed, 1);
  assert.doesNotMatch(JSON.stringify(await loadRuntime(fixture.paths)), /SECRET PROMPT CONTENT/);
});

test("permanent event conflicts are quarantined without pinning cursors forever", async (context) => {
  const fixture = await setup();
  context.after(() => fs.rm(fixture.temporary, { recursive: true, force: true }));
  const secrets = createDeviceSecrets();
  secrets.dedupNamespaceKey = dedupNamespaceKey;
  const state = initialState();
  state.paired = true;
  state.deviceId = "device_12345678";
  const config = initialConfig();
  config.endpoint = "https://artificial-games.example";
  config.allowedPlatforms = ["codex"];
  config.supportedProviders = ["codex"];
  config.transcriptFallbacks = { codex: true, claude: false, kimi: false };
  await saveSecrets(fixture.paths, secrets);
  await saveRuntime(fixture.paths, { state, config });
  let conflictedId;
  const first = await sync({
    home: fixture.home,
    roots: fixture.roots,
    officialEvidence: false,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      conflictedId = body.events[0].eventId;
      return jsonResponse({
        request: { digest: "digest_conflict_1234567890" },
        accepted: 0,
        duplicates: 0,
        rejected: 1,
        events: [{ eventId: conflictedId, status: "conflict" }]
      });
    }
  });
  assert.equal(first.rejected, 1);
  assert.equal(first.quarantined, 1);
  const afterConflict = await loadRuntime(fixture.paths);
  assert.deepEqual(afterConflict.state.quarantinedEventIds, [conflictedId]);
  assert.equal(afterConflict.state.syncOutbox, null);
  const second = await sync({
    home: fixture.home,
    roots: fixture.roots,
    officialEvidence: false,
    fetchImpl: async () => { throw new Error("conflicted cursor should already be committed"); }
  });
  assert.equal(second.sent, 0);
});

test("a permanently invalid same-type batch is bisected and only the bad event is quarantined", async (context) => {
  const fixture = await setup();
  context.after(() => fs.rm(fixture.temporary, { recursive: true, force: true }));
  const wirePath = path.join(fixture.roots.kimi, "session", "agents", "main", "wire.jsonl");
  const lines = Array.from({ length: 3 }, (_unused, index) => JSON.stringify({
    type: "usage.record",
    time: new Date(Date.parse("2026-07-19T12:00:00.000Z") + index * 1_000).toISOString(),
    model: "kimi-code/kimi-for-coding-highspeed",
    usage: { inputOther: 10 + index, inputCacheRead: 2, inputCacheCreation: 1, output: 5 },
    usageScope: "turn"
  })).join("\n") + "\n";
  await fs.writeFile(wirePath, lines, "utf8");
  const secrets = createDeviceSecrets();
  secrets.dedupNamespaceKey = dedupNamespaceKey;
  const state = initialState();
  state.paired = true;
  state.deviceId = "device_12345678";
  const config = initialConfig();
  config.endpoint = "https://artificial-games.example";
  config.allowedPlatforms = ["kimi"];
  config.supportedProviders = ["kimi"];
  config.transcriptFallbacks = { codex: false, claude: false, kimi: true };
  await saveSecrets(fixture.paths, secrets);
  await saveRuntime(fixture.paths, { state, config });

  let badEventId;
  let acceptedRequests = 0;
  const batches = [];
  const result = await sync({
    home: fixture.home,
    roots: fixture.roots,
    officialEvidence: false,
    chunkPaceMs: 0,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      batches.push(body.events.map((event) => event.eventId));
      badEventId ||= body.events[1].eventId;
      if (body.events.some((event) => event.eventId === badEventId)) {
        return errorResponse(422, "MODEL_NOT_SUPPORTED");
      }
      acceptedRequests += 1;
      return jsonResponse({
        request: { digest: `digest_bisect_${acceptedRequests}_1234567890` },
        accepted: body.events.length,
        duplicates: 0,
        rejected: 0,
        events: body.events.map((event) => ({ eventId: event.eventId, status: "accepted" }))
      });
    }
  });
  assert.equal(result.sent, 3);
  assert.equal(result.accepted, 2);
  assert.equal(result.rejected, 1);
  assert.equal(result.quarantined, 1);
  assert.equal(batches.some((batch) => batch.length > 1), true);
  assert.equal(batches.some((batch) => batch.length === 1 && batch[0] === badEventId), true);
  const updated = await loadRuntime(fixture.paths);
  assert.deepEqual(updated.state.quarantinedEventIds, [badEventId]);
  assert.equal(updated.state.pendingRequest, null);
  assert.equal(updated.state.syncOutbox, null);
  assert.equal(updated.state.nextSequence, 3);
});

test("a non-retryable authorization failure is journaled once and not retried forever", async (context) => {
  const fixture = await setup();
  context.after(() => fs.rm(fixture.temporary, { recursive: true, force: true }));
  const secrets = createDeviceSecrets();
  secrets.dedupNamespaceKey = dedupNamespaceKey;
  const state = initialState();
  state.paired = true;
  state.deviceId = "device_12345678";
  const config = initialConfig();
  config.endpoint = "https://artificial-games.example";
  config.allowedPlatforms = ["codex"];
  config.supportedProviders = ["codex"];
  config.transcriptFallbacks = { codex: true, claude: false, kimi: false };
  await saveSecrets(fixture.paths, secrets);
  await saveRuntime(fixture.paths, { state, config });
  let calls = 0;
  await assert.rejects(() => sync({
    home: fixture.home,
    roots: fixture.roots,
    officialEvidence: false,
    fetchImpl: async () => {
      calls += 1;
      return errorResponse(401, "DEVICE_NOT_ACTIVE");
    }
  }), (error) => error.code === "DEVICE_NOT_ACTIVE" && error.status === 401 && !error.retryable);
  assert.equal(calls, 1);
  const afterRejection = await loadRuntime(fixture.paths);
  assert.deepEqual(afterRejection.state.pendingRequest.permanentFailure, {
    code: "DEVICE_NOT_ACTIVE",
    status: 401
  });
  await assert.rejects(() => sync({
    home: fixture.home,
    roots: fixture.roots,
    officialEvidence: false,
    fetchImpl: async () => {
      calls += 1;
      throw new Error("must not retry");
    }
  }), (error) => error.code === "PENDING_PERMANENT_FAILURE");
  assert.equal(calls, 1);

  const repaired = await pair({
    home: fixture.home,
    platform: "linux",
    endpoint: "https://artificial-games.example",
    code: "JKLM-NPQR",
    replacePendingPair: true,
    enabledFallbacks: { codex: true },
    fetchImpl: async () => jsonResponse({
      device: {
        id: "device_repaired_1234",
        allowedPlatforms: ["codex"],
        supportedProviders: ["codex"]
      },
      dedupNamespaceKey,
      signing: { nextSequence: 1, lastRequestDigest: "" }
    })
  });
  assert.equal(repaired.paired, true);
  let recollected = 0;
  const afterRepair = await sync({
    home: fixture.home,
    roots: fixture.roots,
    officialEvidence: false,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      recollected += body.events.length;
      return jsonResponse({
        request: { digest: "digest_after_repair_123456" },
        accepted: body.events.length,
        duplicates: 0,
        rejected: 0
      });
    }
  });
  assert.equal(afterRepair.sent, 1);
  assert.equal(recollected, 1);
});

test("sync payload chunker enforces disjoint event and checkpoint caps", () => {
  const events = Array.from({ length: 8 }, (_unused, index) => ({ eventId: String(index) }));
  const checkpoints = Array.from({ length: 5 }, (_unused, index) => ({ checkpointId: String(index) }));
  const chunks = chunkSyncPayloads(events, checkpoints);
  assert.equal(chunks.length, 6);
  assert.equal(chunks.every((chunk) => chunk.events.length <= 3), true);
  assert.equal(chunks.every((chunk) => chunk.checkpoints.length <= 2), true);
  assert.equal(chunks.every((chunk) => (chunk.events.length > 0) !== (chunk.checkpoints.length > 0)), true);
  assert.deepEqual(chunks.map((chunk) => chunk.events.length), [0, 0, 0, 3, 3, 2]);
  assert.deepEqual(chunks.map((chunk) => chunk.checkpoints.length), [2, 2, 1, 0, 0, 0]);
  assert.deepEqual(chunkSyncPayloads([], []), []);
});

test("scheduled catch-up interleaves heartbeat through more than 360 events", async (context) => {
  const fixture = await setup();
  context.after(() => fs.rm(fixture.temporary, { recursive: true, force: true }));
  const wirePath = path.join(fixture.roots.kimi, "session", "agents", "main", "wire.jsonl");
  const lines = Array.from({ length: 361 }, (_unused, index) => JSON.stringify({
    type: "usage.record",
    time: new Date(Date.parse("2026-07-19T12:00:00.000Z") + index * 1_000).toISOString(),
    model: "kimi-code/kimi-for-coding-highspeed",
    usage: { inputOther: 10 + index, inputCacheRead: 2, inputCacheCreation: 1, output: 5 },
    usageScope: "turn"
  })).join("\n") + "\n";
  await fs.writeFile(wirePath, lines, "utf8");
  const secrets = createDeviceSecrets();
  secrets.dedupNamespaceKey = dedupNamespaceKey;
  const state = initialState();
  state.paired = true;
  state.deviceId = "device_12345678";
  const config = initialConfig();
  config.endpoint = "https://artificial-games.example";
  config.allowedPlatforms = ["kimi"];
  config.supportedProviders = ["kimi"];
  config.transcriptFallbacks = { codex: false, claude: false, kimi: true };
  await saveSecrets(fixture.paths, secrets);
  await saveRuntime(fixture.paths, { state, config });
  const paceDelays = [];
  let ingestRequests = 0;
  let heartbeatRequests = 0;
  const result = await scheduledRun({
    home: fixture.home,
    roots: fixture.roots,
    officialEvidence: false,
    paceSleep: async (milliseconds) => paceDelays.push(milliseconds),
    fetchImpl: async (url, init) => {
      if (url.endsWith("/ingest")) {
        ingestRequests += 1;
        const body = JSON.parse(init.body);
        return jsonResponse({
          request: { digest: `digest_catchup_${ingestRequests}_1234567890` },
          accepted: body.events.length,
          duplicates: 0,
          rejected: 0,
          events: body.events.map((event) => ({ eventId: event.eventId, status: "accepted" }))
        });
      }
      heartbeatRequests += 1;
      return jsonResponse({
        request: { digest: "digest_catchup_heartbeat_1234567890" },
        heartbeat: { nextExpectedAt: "2026-07-19T14:00:00.000Z" },
        device: { continuityState: "continuous" }
      });
    }
  });
  assert.equal(ingestRequests, 121);
  assert.equal(heartbeatRequests, 3);
  assert.equal(paceDelays.length, 122);
  assert.equal(paceDelays.every((delay) => delay === 550), true);
  assert.equal(result.sync.sent, 361);
  assert.equal(result.sync.interleavedHeartbeats, 2);
  assert.equal(result.sync.catchingUp, false);
  assert.equal(result.heartbeat.sent, true);
});

test("a pre-existing very large outbox is bounded while heartbeats keep the same request chain live", async (context) => {
  const fixture = await setup();
  context.after(() => fs.rm(fixture.temporary, { recursive: true, force: true }));
  const secrets = createDeviceSecrets();
  secrets.dedupNamespaceKey = dedupNamespaceKey;
  const state = initialState();
  state.paired = true;
  state.deviceId = "device_12345678";
  const config = initialConfig();
  config.endpoint = "https://artificial-games.example";
  const chunks = Array.from({ length: 1_002 }, (_unused, index) => ({
    events: [{
      eventId: index.toString(16).padStart(64, "0"),
      occurredAt: new Date(Date.parse("2026-07-01T00:00:00.000Z") + index * 1_000).toISOString(),
      provider: "kimi",
      modelId: "kimi-k2.7-code",
      serviceMode: "standard",
      inputTokens: "10",
      cachedInputTokens: "2",
      outputTokens: "5",
      surface: "kimi_code"
    }],
    checkpoints: []
  }));
  state.syncOutbox = {
    version: 1,
    index: 0,
    chunks,
    totalEvents: chunks.length,
    totalCheckpoints: 0,
    accepted: 0,
    duplicates: 0,
    rejected: 0,
    quarantinedEventIds: [],
    commit: {
      nextCursors: { codex: { files: { committed_only_at_end: {} } }, claude: { seen: {} }, kimi: { files: {} } },
      checkpointHash: null,
      scannedAt: "2026-07-19T12:00:00.000Z",
      scanSummary: {},
      withheld: 0,
      unknownModels: [],
      nextUnresolvedEvents: [],
      unresolvedOverflow: { totalDropped: 0, lastOverflowAt: null }
    }
  };
  await saveSecrets(fixture.paths, secrets);
  await saveRuntime(fixture.paths, { state, config });
  const requestTypes = [];
  const sequences = [];
  const paceDelays = [];
  let digestCounter = 0;
  const result = await scheduledRun({
    home: fixture.home,
    paceSleep: async (milliseconds) => paceDelays.push(milliseconds),
    fetchImpl: async (url, init) => {
      const isHeartbeat = url.endsWith("/heartbeat");
      requestTypes.push(isHeartbeat ? "heartbeat" : "ingest");
      sequences.push(Number(init.headers["x-tokenboard-sequence"]));
      digestCounter += 1;
      if (isHeartbeat) {
        return jsonResponse({
          request: { digest: `digest_large_heartbeat_${digestCounter}_1234567890` },
          heartbeat: { nextExpectedAt: "2026-07-19T14:00:00.000Z" },
          device: { continuityState: "continuous" }
        });
      }
      const body = JSON.parse(init.body);
      return jsonResponse({
        request: { digest: `digest_large_ingest_${digestCounter}_1234567890` },
        accepted: body.events.length,
        duplicates: 0,
        rejected: 0,
        events: body.events.map((event) => ({ eventId: event.eventId, status: "accepted" }))
      });
    }
  });
  assert.equal(result.sync.ingestRequests, 1_000);
  assert.equal(result.sync.sent, 1_000);
  assert.equal(result.sync.catchingUp, true);
  assert.equal(result.sync.remainingChunks, 2);
  assert.equal(result.sync.interleavedHeartbeats, 19);
  assert.equal(requestTypes.filter((type) => type === "heartbeat").length, 20);
  assert.equal(requestTypes[50], "heartbeat");
  assert.equal(requestTypes.at(-1), "heartbeat");
  assert.deepEqual(sequences, Array.from({ length: sequences.length }, (_unused, index) => index + 1));
  assert.equal(paceDelays.length, 1_018);
  assert.equal(paceDelays.every((delay) => delay === 550), true);
  const updated = await loadRuntime(fixture.paths);
  assert.equal(updated.state.syncOutbox.index, 1_000);
  assert.equal(updated.state.pendingRequest, null);
  assert.deepEqual(updated.state.cursors.codex.files, {});
});

test("heartbeat uses the same monotonic request chain", async (context) => {
  const fixture = await setup();
  context.after(() => fs.rm(fixture.temporary, { recursive: true, force: true }));
  const secrets = createDeviceSecrets();
  secrets.dedupNamespaceKey = dedupNamespaceKey;
  const state = initialState();
  state.paired = true;
  state.deviceId = "device_12345678";
  state.nextSequence = 4;
  state.previousRequestDigest = "digest_previous_123456";
  const config = initialConfig();
  config.endpoint = "https://artificial-games.example";
  await saveSecrets(fixture.paths, secrets);
  await saveRuntime(fixture.paths, { state, config });
  let body;
  const result = await heartbeat({
    home: fixture.home,
    fetchImpl: async (_url, init) => {
      body = JSON.parse(init.body);
      return jsonResponse({
        request: { digest: "digest_next_1234567890" },
        heartbeat: { nextExpectedAt: "2026-07-19T13:00:00.000Z" },
        device: { continuityState: "continuous" }
      });
    },
    now: Date.parse("2026-07-19T12:00:00.000Z"),
    nonce: "heartbeat-request"
  });
  assert.deepEqual(Object.keys(body), ["connectorVersion", "observedAt", "previousRequestDigest", "status"]);
  assert.equal(result.sequence, 4);
  const updated = await loadRuntime(fixture.paths);
  assert.equal(updated.state.nextSequence, 5);
  assert.equal(updated.state.previousRequestDigest, "digest_next_1234567890");
});

test("preview is local-only and journal reads require pairing authorization", async (context) => {
  const fixture = await setup();
  context.after(() => fs.rm(fixture.temporary, { recursive: true, force: true }));
  const result = await preview({
    home: fixture.home,
    roots: fixture.roots,
    officialEvidence: false
  });
  assert.equal(result.records, 0);
  assert.equal(result.adapters.codex.status, "opt_in_required");
  assert.equal(result.networkPerformed, false);
});

test("scheduler mutation is preview-only until the exact confirmation flag", async (context) => {
  const fixture = await setup();
  context.after(() => fs.rm(fixture.temporary, { recursive: true, force: true }));
  const commands = [];
  const options = {
    home: fixture.home,
    platform: "win32",
    nodeExecutable: "C:/node/node.exe",
    cliPath: "C:/tag-plugin/src/cli.mjs",
    releaseRoot: connectorRoot,
    windowsIdentity: "TEST\\connector-user",
    runCommand: async (executable, args) => commands.push([executable, ...args])
  };
  const dryRun = await install(options);
  assert.equal(dryRun.executed, false);
  assert.equal(commands.length, 0);

  const runtime = await loadRuntime(fixture.paths);
  runtime.state.paired = true;
  runtime.state.deviceId = "device_12345678";
  runtime.config.endpoint = "https://artificial-games.example";
  const installSecrets = createDeviceSecrets();
  installSecrets.dedupNamespaceKey = dedupNamespaceKey;
  await saveSecrets(fixture.paths, installSecrets);
  await saveRuntime(fixture.paths, runtime);
  await fs.writeFile(fixture.paths.pendingSecrets, "{}\n", "utf8");
  const installed = await install({ ...options, confirmInstall: true });
  assert.equal(installed.executed, true);
  assert.equal(commands.length, 2);
  assert.match(commands[0][0], /powershell\.exe$/i);
  assert.match(commands[0].join(" "), /SetAccessRuleProtection/);
  assert.match(commands[0].join(" "), /Current-user-only ACL verification failed/);
  assert.equal(commands[1][0], "schtasks.exe");
  assert.match(commands[1].join(" "), /versions[\\/]0\.1\.3[\\/]src[\\/]cli\.mjs/);
  assert.match(commands[1].join(" "), /scheduled-run --home/);
  assert.equal(await fs.access(path.join(installed.installedRelease, "package.json")).then(() => true), true);
  assert.equal(await fs.access(path.join(installed.installedRelease, "RELEASING.md")).then(() => true), true);
  assert.equal(await fs.access(path.join(installed.installedRelease, "test", "operations.test.mjs")).then(() => true), true);
  assert.equal(await fs.access(path.join(installed.installedRelease, ".github", "workflows", "release.yml")).then(() => true), true);
  assert.equal(await fs.access(fixture.paths.pendingSecrets).then(() => true).catch(() => false), false);
  const removed = await uninstall({ ...options, confirmUninstall: true });
  assert.equal(removed.executed, true);
  assert.equal(commands.length, 3);
  assert.equal(await fs.access(installed.installedRelease).then(() => true).catch(() => false), false);
});

test("Windows installation fails closed before copying or scheduling when ACL hardening fails", async (context) => {
  const fixture = await setup();
  context.after(() => fs.rm(fixture.temporary, { recursive: true, force: true }));
  const runtime = await loadRuntime(fixture.paths);
  runtime.state.paired = true;
  runtime.state.deviceId = "device_12345678";
  runtime.config.endpoint = "https://artificial-games.example";
  const installSecrets = createDeviceSecrets();
  installSecrets.dedupNamespaceKey = dedupNamespaceKey;
  await saveSecrets(fixture.paths, installSecrets);
  await saveRuntime(fixture.paths, runtime);
  const commands = [];
  await assert.rejects(() => install({
    home: fixture.home,
    platform: "win32",
    releaseRoot: connectorRoot,
    windowsIdentity: "TEST\\connector-user",
    confirmInstall: true,
    runCommand: async (executable, args) => {
      commands.push([executable, ...args]);
      throw new Error("ACL denied");
    }
  }), (error) => error.code === "WINDOWS_ACL_HARDENING_FAILED");
  assert.equal(commands.length, 1);
  assert.match(commands[0][0], /powershell\.exe$/i);
  const installedPath = path.join(fixture.home, "versions", "0.1.3");
  assert.equal(await fs.access(installedPath).then(() => true).catch(() => false), false);
});

test("status exposes pending chunks and quarantine without revealing payloads", async (context) => {
  const fixture = await setup();
  context.after(() => fs.rm(fixture.temporary, { recursive: true, force: true }));
  const runtime = await loadRuntime(fixture.paths);
  runtime.state.quarantinedEventIds = ["a".repeat(64)];
  runtime.state.pendingRequest = {
    kind: "sync",
    sequence: 4,
    requestId: "private-request-id",
    body: { events: [{ secret: "must-not-appear" }] },
    permanentFailure: { code: "DEVICE_NOT_ACTIVE", status: 401 }
  };
  runtime.state.syncOutbox = {
    index: 1,
    chunks: [{}, {}, {}],
    quarantinedEventIds: ["b".repeat(64)]
  };
  await saveRuntime(fixture.paths, runtime);
  const result = await status({ home: fixture.home });
  assert.equal(result.pendingChunks, 2);
  assert.equal(result.quarantinedEventCount, 2);
  assert.deepEqual(result.pendingRequest, {
    kind: "sync",
    sequence: 4,
    permanentFailure: { code: "DEVICE_NOT_ACTIVE", status: 401 }
  });
  assert.doesNotMatch(JSON.stringify(result), /private-request-id|must-not-appear/);
});
