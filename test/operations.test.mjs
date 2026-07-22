import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verify } from "node:crypto";
import { createDeviceSecrets, payloadHash, sha256 } from "../src/crypto.mjs";
import {
  JOURNAL_HISTORY_START,
  MAX_SYNC_OUTBOX_EVENTS,
  SERVER_MAX_AUTO_SCORED_EVENT_TOKENS,
  SERVER_MAX_AUTO_SCORED_RETROACTIVE_DAYS
} from "../src/constants.mjs";
import { parseKimiWire } from "../src/adapters/kimi-wire.mjs";
import { MAX_JOURNAL_LINE_BYTES } from "../src/adapters/shared.mjs";
import { discoverJsonlFiles } from "../src/discovery.mjs";
import { acquireLock } from "../src/lock.mjs";
import {
  chunkSyncPayloads,
  doctor,
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

test("journal collection is independent from the server retroactive scoring policy", () => {
  assert.equal(SERVER_MAX_AUTO_SCORED_RETROACTIVE_DAYS, 90);
  assert.equal(JOURNAL_HISTORY_START, "1970-01-01T00:00:00.000Z");
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

function acceptedEventResult(event) {
  return {
    eventId: event.eventId,
    status: "accepted",
    scoringState: "accepted",
    submittedRevisionActive: true,
    ...(event.attribution === "raw_only"
      ? { rawEligible: true, rawPreserved: true }
      : {})
  };
}

function acceptedCheckpointResults(checkpoints, options = {}) {
  return (checkpoints || []).map((checkpoint) => ({
    checkpointId: checkpoint.checkpointId,
    status: options.status || "accepted",
    submittedCheckpointCanonical: true,
    ...(checkpoint.snapshotRole === "commit"
      ? { submittedGenerationActive: options.submittedGenerationActive !== false }
      : {})
  }));
}

function codexSnapshotHeartbeat(digest, codex = null, options = {}) {
  const responseSnapshot = codex === null
    ? null
    : options.compact === true
      ? {
          status: "current",
          generationId: codex.generationId,
          snapshotDigest: codex.snapshotDigest
        }
      : {
          status: "snapshot",
          generationId: codex.generationId,
          snapshotDigest: codex.snapshotDigest,
          lifetimeTokens: codex.lifetimeTokens,
          dailyValues: codex.dailyValues
        };
  return jsonResponse({
    request: { digest },
    heartbeat: { nextExpectedAt: "2026-07-21T01:00:00.000Z" },
    providerSnapshots: { codex: responseSnapshot }
  });
}

function codexSnapshotRecord(generationId, lifetimeTokens, dailyValues) {
  const canonicalDailyValues = Object.fromEntries(
    Object.entries(dailyValues).sort(([left], [right]) => left.localeCompare(right))
  );
  return {
    generationId,
    snapshotDigest: payloadHash({
      provider: "codex",
      sourceScope: "codex_subscription_account",
      lifetimeTokens: String(lifetimeTokens),
      dailyValues: canonicalDailyValues
    }),
    lifetimeTokens: String(lifetimeTokens),
    dailyValues: canonicalDailyValues
  };
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

test("pair preserves a server-authorized DeepSeek platform", async (context) => {
  const fixture = await setup();
  context.after(() => fs.rm(fixture.temporary, { recursive: true, force: true }));
  const result = await pair({
    home: fixture.home,
    platform: "linux",
    endpoint: "https://artificial-games.example",
    code: "ABCD-EFGH",
    enabledFallbacks: { deepseek: true },
    fetchImpl: async () => jsonResponse({
      device: {
        id: "device_deepseek_1234",
        allowedPlatforms: ["deepseek"],
        supportedProviders: ["deepseek"]
      },
      dedupNamespaceKey,
      signing: { nextSequence: 1, lastRequestDigest: "" }
    })
  });
  assert.deepEqual(result.allowedPlatforms, ["deepseek"]);
  assert.deepEqual(result.supportedProviders, ["deepseek"]);
  assert.equal(result.transcriptFallbacks.deepseek, true);
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
    fetchImpl
  });

  assert.equal(networkCalls, 2);
  assert.equal(retried.paired, true);
  assert.equal(retried.alreadyPaired, true);
  assert.equal(retried.authorizationRefreshed, true);
  assert.equal(retried.deviceId, "device_12345678");
  assert.deepEqual(retried.allowedPlatforms, ["codex", "claude"]);
  assert.deepEqual(retried.transcriptFallbacks, { codex: true, claude: true, kimi: false });
  assert.equal(await fs.access(fixture.paths.pendingSecrets).then(() => true).catch(() => false), false);
});

test("pair reuse exchanges the new code and refreshes server-authorized platforms", async (context) => {
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
          allowedPlatforms: ["codex"],
          supportedProviders: ["codex", "claude"]
        },
        dedupNamespaceKey,
        signing: { nextSequence: 1, lastRequestDigest: "" }
      });
    }
  });
  const activeRuntime = await loadRuntime(fixture.paths);
  activeRuntime.state.nextSequence = 3380;
  activeRuntime.state.previousRequestDigest = "a".repeat(43);
  await saveRuntime(fixture.paths, activeRuntime);

  const retried = await pair({
    home: fixture.home,
    platform: "linux",
    endpoint: "https://artificial-games.example",
    code: "JKLM-NPQR",
    enabledFallbacks: { codex: true, claude: true },
    fetchImpl: async () => {
      networkCalls += 1;
      return jsonResponse({
        device: {
          id: "device_12345678",
          allowedPlatforms: ["codex", "claude"],
          supportedProviders: ["codex", "claude"]
        },
        dedupNamespaceKey,
        signing: { nextSequence: 3380, lastRequestDigest: "a".repeat(43) }
      });
    }
  });

  assert.equal(networkCalls, 2);
  assert.equal(retried.alreadyPaired, true);
  assert.equal(retried.authorizationRefreshed, true);
  assert.deepEqual(retried.allowedPlatforms, ["codex", "claude"]);
  assert.deepEqual(retried.transcriptFallbacks, { codex: true, claude: true, kimi: false });
  const after = await loadRuntime(fixture.paths);
  assert.equal(after.state.nextSequence, 3380);
  assert.equal(after.state.previousRequestDigest, "a".repeat(43));
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
    const request = JSON.parse(init.body);
    return jsonResponse({
      request: { id: `request-${calls.length}`, sequence: calls.length, digest: `digest_${calls.length}_1234567890abcdef` },
      accepted: request.events.length,
      duplicates: 0,
      rejected: 0,
      events: request.events.map(acceptedEventResult)
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
  assert.equal(result.sent, 4);
  assert.equal(result.withheld, 0);
  assert.equal(calls.length, 2);
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(Object.keys(body), ["events", "previousRequestDigest"]);
  assert.equal(body.previousRequestDigest, "");
  const sentEvents = calls.flatMap((call) => JSON.parse(call.init.body).events);
  assert.equal(sentEvents.length, 4);
  const allowedEventKeys = new Set([
    "eventId", "occurredAt", "provider", "serviceProviderId", "modelId", "serviceMode",
    "inputTokens", "cachedInputTokens", "cacheWriteInputTokens", "outputTokens", "reasoningTokens", "surface",
    "attribution"
  ]);
  for (const event of sentEvents) {
    assert.equal(Object.keys(event).every((key) => allowedEventKeys.has(key)), true);
    assert.equal(typeof event.inputTokens, "string");
    assert.equal(typeof event.cachedInputTokens, "string");
    assert.equal(typeof event.cacheWriteInputTokens, "string");
    assert.equal(typeof event.outputTokens, "string");
  }
  const rawOnly = sentEvents.find((event) => event.attribution === "raw_only");
  assert.deepEqual({
    attribution: rawOnly.attribution,
    modelId: rawOnly.modelId,
    serviceMode: rawOnly.serviceMode
  }, {
    attribution: "raw_only",
    modelId: "unknown",
    serviceMode: "unknown"
  });
  assert.equal(Object.hasOwn(rawOnly, "sourceModelId"), false);
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
  assert.equal(updated.state.nextSequence, 3);
  assert.equal(updated.state.previousRequestDigest, "digest_2_1234567890abcdef");

  const second = await sync({
    home: fixture.home,
    roots: fixture.roots,
    officialEvidence: false,
    fetchImpl: async () => { throw new Error("network should not run with no changes"); },
    now: 1_750_000_100_000
  });
  assert.equal(second.sent, 0);
});

test("Codex consent uploads a hosted DeepSeek model with separate vendor and service attribution", async (context) => {
  const fixture = await setup();
  context.after(() => fs.rm(fixture.temporary, { recursive: true, force: true }));
  const secrets = createDeviceSecrets();
  secrets.dedupNamespaceKey = dedupNamespaceKey;
  const state = initialState();
  state.paired = true;
  state.deviceId = "device_hosted_deepseek";
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
    officialEvidence: false,
    canonicalModelId: () => "deepseek-v4-pro",
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      uploaded.push(...body.events);
      return jsonResponse({
        request: { digest: "digest_hosted_deepseek_1234567890" },
        accepted: body.events.length,
        duplicates: 0,
        rejected: 0,
        events: body.events.map(acceptedEventResult)
      });
    }
  });
  assert.equal(result.sent, 1);
  assert.equal(result.withheld, 0);
  assert.equal(uploaded[0].provider, "deepseek");
  assert.equal(uploaded[0].serviceProviderId, "codex");
  assert.equal(uploaded[0].surface, "codex");
});

test("an explicitly consented Antigravity capture reaches the sync outbox", async (context) => {
  const fixture = await setup();
  context.after(() => fs.rm(fixture.temporary, { recursive: true, force: true }));
  fixture.roots.antigravity = path.join(fixture.temporary, "tag-plugin-statusline.jsonl");
  await fs.writeFile(fixture.roots.antigravity, JSON.stringify({
    kind: "tag.antigravity.statusline.v1",
    observedAt: "2026-07-21T10:00:00.000Z",
    sessionAlias: "a".repeat(64),
    sourceModelId: "gemini-3-pro",
    executionMode: "fast",
    quotaResets: [],
    usage: { input: 12, cachedInput: 3, cacheWriteInput: 0, output: 5 }
  }) + "\n", "utf8");
  const secrets = createDeviceSecrets();
  secrets.dedupNamespaceKey = dedupNamespaceKey;
  const state = initialState();
  state.paired = true;
  state.deviceId = "device_antigravity";
  const config = initialConfig();
  config.endpoint = "https://artificial-games.example";
  config.allowedPlatforms = ["gemini"];
  config.supportedProviders = ["gemini"];
  config.transcriptFallbacks = { codex: false, claude: false, kimi: false, gemini: true };
  await saveSecrets(fixture.paths, secrets);
  await saveRuntime(fixture.paths, { state, config });
  const uploaded = [];
  const result = await sync({
    home: fixture.home,
    roots: fixture.roots,
    officialEvidence: false,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      uploaded.push(...body.events);
      return jsonResponse({
        request: { digest: "digest_antigravity_1234567890" },
        accepted: body.events.length,
        duplicates: 0,
        rejected: 0,
        events: body.events.map(acceptedEventResult)
      });
    }
  });
  assert.equal(result.sent, 1);
  assert.equal(uploaded[0].provider, "gemini");
  assert.equal(uploaded[0].serviceProviderId, "gemini");
  assert.equal(uploaded[0].surface, "antigravity");
});

test("persisted outboxes reject invalid service-provider and surface combinations", async (context) => {
  for (const mutation of [
    { serviceProviderId: "claude" },
    { surface: "unsupported_surface" }
  ]) {
    const fixture = await setup();
    context.after(() => fs.rm(fixture.temporary, { recursive: true, force: true }));
    const secrets = createDeviceSecrets();
    secrets.dedupNamespaceKey = dedupNamespaceKey;
    const state = initialState();
    state.paired = true;
    state.deviceId = "device_invalid_host_surface";
    const config = initialConfig();
    config.endpoint = "https://artificial-games.example";
    config.allowedPlatforms = ["codex"];
    config.supportedProviders = ["codex"];
    config.transcriptFallbacks = { codex: true, claude: false, kimi: false };
    await saveSecrets(fixture.paths, secrets);
    await saveRuntime(fixture.paths, { state, config });
    await sync({
      home: fixture.home,
      roots: fixture.roots,
      officialEvidence: false,
      maxIngestRequests: 0,
      fetchImpl: async () => { throw new Error("zero-request staging must not use the network"); }
    });
    const staged = await loadRuntime(fixture.paths);
    const event = staged.state.syncOutbox.chunks[0].events[0];
    Object.assign(event, mutation);
    const outbox = staged.state.syncOutbox;
    const events = outbox.chunks.flatMap((chunk) => chunk.events);
    outbox.pages[0].digest = payloadHash({
      version: 1,
      batchId: outbox.batchId,
      pageIndex: 0,
      events
    });
    await saveRuntime(fixture.paths, staged);
    await assert.rejects(() => sync({
      home: fixture.home,
      roots: fixture.roots,
      officialEvidence: false,
      fetchImpl: async () => { throw new Error("invalid outbox must fail before network"); }
    }), (error) => error.code === "SYNC_BATCH_CORRUPT");
  }
});

test("Codex checkpoints carry account scope and use lifetime authority as the final commit marker", async (context) => {
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
    fetchImpl: async (url, init) => {
      if (url.endsWith("/heartbeat")) {
        return codexSnapshotHeartbeat("digest_lifetime_hydration_1234567890");
      }
      const body = JSON.parse(init.body);
      bodies.push(body);
      return jsonResponse({
        request: { digest: `digest_lifetime_checkpoint_${bodies.length}_1234567890` },
        accepted: 0,
        duplicates: 0,
        rejected: 0,
        checkpoints: acceptedCheckpointResults(body.checkpoints)
      });
    }
  });
  assert.equal(result.sent, 0);
  assert.equal(result.checkpoints, 4);
  assert.equal(bodies.length, 2);
  assert.equal(bodies.every((body) => body.events.length === 0), true);
  const checkpoints = bodies.flatMap((body) => body.checkpoints);
  assert.equal(checkpoints.every((checkpoint) => checkpoint.sourceScope === "codex_subscription_account"), true);
  assert.notEqual(checkpoints[0].checkpointId, sha256(JSON.stringify({
    provider: "codex",
    source: "codex_app_server_account_usage",
    periodStart: "2026-07-18T00:00:00.000Z",
    periodEnd: "2026-07-19T00:00:00.000Z",
    totalTokens: "100"
  })));
  assert.deepEqual(checkpoints.at(-1), {
    checkpointId: checkpoints.at(-1).checkpointId,
    provider: "codex",
    source: "codex_app_server_account_usage_lifetime",
    sourceScope: "codex_subscription_account",
    periodStart: "2026-07-20T00:00:00.000Z",
    periodEnd: "2026-07-21T00:00:00.000Z",
    totalTokens: "17772403863",
    snapshotGenerationId: checkpoints.at(-1).snapshotGenerationId,
    parentGenerationId: "0".repeat(64),
    snapshotRole: "commit",
    snapshotDigest: checkpoints.at(-1).snapshotDigest,
    deltaCount: 3
  });
  assert.equal(checkpoints[0].source, "codex_app_server_account_usage");
  assert.deepEqual(
    checkpoints.map((checkpoint) => checkpoint.source),
    [
      "codex_app_server_account_usage",
      "codex_app_server_account_usage",
      "codex_app_server_account_usage",
      "codex_app_server_account_usage_lifetime"
    ]
  );
});

test("Codex v0.1.6 bootstrap and snapshot generations send only daily deltas and distinguish A to B to A", async (context) => {
  const fixture = await setup();
  context.after(() => fs.rm(fixture.temporary, { recursive: true, force: true }));
  const secrets = createDeviceSecrets();
  secrets.dedupNamespaceKey = dedupNamespaceKey;
  const state = initialState();
  state.paired = true;
  state.deviceId = "device_snapshot_generations";
  state.providerEvidenceHashes.codex = "legacy_v0_1_6_checkpoint_hash";
  const config = initialConfig();
  config.endpoint = "https://artificial-games.example";
  config.allowedPlatforms = ["codex"];
  config.supportedProviders = ["codex"];
  config.transcriptFallbacks = { codex: false, claude: false, kimi: false };
  await saveSecrets(fixture.paths, secrets);
  await saveRuntime(fixture.paths, { state, config });

  let requestCounter = 0;
  let hydrationCounter = 0;
  const run = async (dailyUsageBuckets, { rejectNetwork = false } = {}) => {
    const checkpoints = [];
    const result = await sync({
      home: fixture.home,
      roots: fixture.roots,
      readCodexAccountUsage: async () => ({
        status: "available",
        summary: { lifetimeTokens: 1_000 },
        dailyUsageBuckets
      }),
      chunkPaceMs: 0,
      fetchImpl: async (url, init) => {
        if (url.endsWith("/heartbeat")) {
          hydrationCounter += 1;
          const snapshot = (await loadRuntime(fixture.paths)).state.codexCheckpointSnapshot;
          const heartbeatBody = JSON.parse(init.body);
          assert.deepEqual(heartbeatBody.providerSnapshotHeads.codex, snapshot.generationId === null
            ? null
            : {
                generationId: snapshot.generationId,
                snapshotDigest: snapshot.snapshotDigest
              });
          return codexSnapshotHeartbeat(
            `digest_snapshot_hydration_${hydrationCounter}_1234567890`,
            snapshot.generationId === null ? null : snapshot,
            { compact: snapshot.generationId !== null }
          );
        }
        if (rejectNetwork) throw new Error("an identical snapshot must not upload");
        requestCounter += 1;
        const body = JSON.parse(init.body);
        checkpoints.push(...(body.checkpoints || []));
        return jsonResponse({
          request: { digest: `digest_snapshot_generation_${requestCounter}_1234567890` },
          accepted: 0,
          duplicates: 0,
          rejected: 0,
          checkpoints: acceptedCheckpointResults(body.checkpoints)
        });
      }
    });
    return { result, checkpoints };
  };

  const snapshotA = [
    { startDate: "2026-07-18", tokens: 100 },
    { startDate: "2026-07-19", tokens: 200 }
  ];
  const snapshotB = [
    { startDate: "2026-07-18", tokens: 110 },
    { startDate: "2026-07-19", tokens: 200 }
  ];
  const first = await run(snapshotA);
  const firstCommit = first.checkpoints.at(-1);
  assert.equal(first.checkpoints.filter((checkpoint) => checkpoint.snapshotRole === "daily_delta").length, 2);
  assert.equal(firstCommit.deltaCount, 2);
  assert.equal(firstCommit.parentGenerationId, "0".repeat(64));
  assert.equal((await loadRuntime(fixture.paths)).state.providerEvidenceHashes.codex, undefined);

  const unchanged = await run(snapshotA, { rejectNetwork: true });
  assert.equal(unchanged.result.sent, 0);
  assert.deepEqual(unchanged.checkpoints, []);

  const second = await run(snapshotB);
  const secondDeltas = second.checkpoints.filter((checkpoint) => checkpoint.snapshotRole === "daily_delta");
  const secondCommit = second.checkpoints.at(-1);
  assert.equal(secondDeltas.length, 1);
  assert.equal(secondDeltas[0].periodStart, "2026-07-18T00:00:00.000Z");
  assert.equal(secondDeltas[0].totalTokens, "110");
  assert.equal(secondCommit.totalTokens, firstCommit.totalTokens);
  assert.equal(secondCommit.deltaCount, 1);
  assert.equal(secondCommit.parentGenerationId, firstCommit.snapshotGenerationId);
  assert.deepEqual((await loadRuntime(fixture.paths)).state.codexCheckpointSnapshot.dailyValues, {
    "2026-07-18": "110",
    "2026-07-19": "200"
  });

  const third = await run(snapshotA);
  const thirdCommit = third.checkpoints.at(-1);
  assert.equal(thirdCommit.snapshotDigest, firstCommit.snapshotDigest);
  assert.notEqual(thirdCommit.snapshotGenerationId, firstCommit.snapshotGenerationId);
  assert.equal(thirdCommit.parentGenerationId, secondCommit.snapshotGenerationId);
  const committed = (await loadRuntime(fixture.paths)).state.codexCheckpointSnapshot;
  assert.equal(committed.generationId, thirdCommit.snapshotGenerationId);
  assert.deepEqual(committed.dailyValues, {
    "2026-07-18": "100",
    "2026-07-19": "200"
  });
});

test("a persisted v0.1.6 checkpoint outbox drains before the genesis generation", async (context) => {
  const fixture = await setup();
  context.after(() => fs.rm(fixture.temporary, { recursive: true, force: true }));
  const secrets = createDeviceSecrets();
  secrets.dedupNamespaceKey = dedupNamespaceKey;
  const state = initialState();
  state.paired = true;
  state.deviceId = "device_legacy_checkpoint_outbox";
  state.providerEvidenceHashes.codex = "legacy_checkpoint_hash";
  const batchId = "a".repeat(24);
  const emptyPage = { version: 1, batchId, pageIndex: 0, events: [] };
  state.syncOutbox = {
    version: 4,
    batchId,
    pageIndex: 0,
    pageCount: 1,
    pageSize: 5_000,
    pages: [{ pageIndex: 0, eventCount: 0, digest: payloadHash(emptyPage) }],
    index: 0,
    chunks: [{
      events: [],
      checkpoints: [{
        checkpointId: "legacy-checkpoint-id-0001",
        provider: "codex",
        source: "codex_app_server_account_usage_lifetime",
        sourceScope: "codex_subscription_account",
        periodStart: "2026-07-19T00:00:00.000Z",
        periodEnd: "2026-07-20T00:00:00.000Z",
        totalTokens: "900"
      }]
    }],
    totalChunks: 1,
    totalEvents: 0,
    totalCheckpoints: 1,
    pageEventCount: 0,
    processedEvents: 0,
    processedCheckpoints: 0,
    processedChunks: 0,
    accepted: 0,
    duplicates: 0,
    rejected: 0,
    quarantinedCount: 0,
    quarantinedEventIds: [],
    commit: {
      nextCursors: structuredClone(state.cursors),
      checkpointHash: "legacy_checkpoint_hash",
      scannedAt: "2026-07-20T00:00:00.000Z",
      scanSummary: {},
      withheld: 0,
      unknownModels: [],
      collectionPending: false,
      nextUnresolvedEvents: [],
      unresolvedOverflow: { totalDropped: 0, lastOverflowAt: null },
      nextRawOnlyBackfill: state.rawOnlyBackfill
    }
  };
  const config = initialConfig();
  config.endpoint = "https://artificial-games.example";
  config.allowedPlatforms = ["codex"];
  config.supportedProviders = ["codex"];
  await saveSecrets(fixture.paths, secrets);
  await saveRuntime(fixture.paths, { state, config });

  let legacyBody;
  await sync({
    home: fixture.home,
    roots: fixture.roots,
    readCodexAccountUsage: async () => { throw new Error("legacy outbox must drain before recollection"); },
    fetchImpl: async (_url, init) => {
      legacyBody = JSON.parse(init.body);
      return jsonResponse({
        request: { digest: "digest_legacy_checkpoint_outbox_1234567890" },
        accepted: 0,
        duplicates: 0,
        rejected: 0,
        checkpoints: acceptedCheckpointResults(legacyBody.checkpoints)
      });
    }
  });
  assert.equal(legacyBody.checkpoints[0].snapshotRole, undefined);
  const afterLegacy = await loadRuntime(fixture.paths);
  assert.equal(afterLegacy.state.codexCheckpointSnapshot.generationId, null);
  assert.equal(afterLegacy.state.providerEvidenceHashes.codex, "legacy_checkpoint_hash");

  let firstGeneration;
  await sync({
    home: fixture.home,
    roots: fixture.roots,
    readCodexAccountUsage: async () => ({
      status: "available",
      summary: { lifetimeTokens: 1_000 },
      dailyUsageBuckets: [{ startDate: "2026-07-19", tokens: 100 }]
    }),
    fetchImpl: async (url, init) => {
      if (url.endsWith("/heartbeat")) {
        return codexSnapshotHeartbeat("digest_legacy_hydration_1234567890");
      }
      const body = JSON.parse(init.body);
      firstGeneration = body.checkpoints.at(-1);
      return jsonResponse({
        request: { digest: "digest_genesis_after_legacy_1234567890" },
        accepted: 0,
        duplicates: 0,
        rejected: 0,
        checkpoints: acceptedCheckpointResults(body.checkpoints)
      });
    }
  });
  assert.equal(firstGeneration.snapshotRole, "commit");
  assert.equal(firstGeneration.parentGenerationId, "0".repeat(64));
  assert.equal((await loadRuntime(fixture.paths)).state.providerEvidenceHashes.codex, undefined);
});

test("a reinstalled connector hydrates the active generation before planning its first snapshot", async (context) => {
  const fixture = await setup();
  context.after(() => fs.rm(fixture.temporary, { recursive: true, force: true }));
  const secrets = createDeviceSecrets();
  secrets.dedupNamespaceKey = dedupNamespaceKey;
  const state = initialState();
  state.paired = true;
  state.deviceId = "device_reinstalled_snapshot";
  const config = initialConfig();
  config.endpoint = "https://artificial-games.example";
  config.allowedPlatforms = ["codex"];
  config.supportedProviders = ["codex"];
  await saveSecrets(fixture.paths, secrets);
  await saveRuntime(fixture.paths, { state, config });

  const active = codexSnapshotRecord("b".repeat(64), 1_400, {
    "2026-07-18": "100",
    "2026-07-19": "200"
  });
  const submitted = [];
  let requestCounter = 0;
  await sync({
    home: fixture.home,
    roots: fixture.roots,
    readCodexAccountUsage: async () => ({
      status: "available",
      summary: { lifetimeTokens: 1_500 },
      dailyUsageBuckets: [
        { startDate: "2026-07-18", tokens: 100 },
        { startDate: "2026-07-19", tokens: 250 }
      ]
    }),
    chunkPaceMs: 0,
    fetchImpl: async (url, init) => {
      requestCounter += 1;
      if (url.endsWith("/heartbeat")) {
        assert.equal(JSON.parse(init.body).providerSnapshotHeads.codex, null);
        return codexSnapshotHeartbeat(`digest_reinstall_hydration_${requestCounter}_1234567890`, active);
      }
      const body = JSON.parse(init.body);
      submitted.push(...body.checkpoints);
      return jsonResponse({
        request: { digest: `digest_reinstall_ingest_${requestCounter}_1234567890` },
        accepted: 0,
        duplicates: 0,
        rejected: 0,
        checkpoints: acceptedCheckpointResults(body.checkpoints)
      });
    }
  });
  const deltas = submitted.filter((checkpoint) => checkpoint.snapshotRole === "daily_delta");
  const marker = submitted.find((checkpoint) => checkpoint.snapshotRole === "commit");
  assert.deepEqual(deltas.map((checkpoint) => [checkpoint.periodStart, checkpoint.totalTokens]), [
    ["2026-07-19T00:00:00.000Z", "250"]
  ]);
  assert.equal(marker.parentGenerationId, active.generationId);
  assert.notEqual(marker.parentGenerationId, "0".repeat(64));
  const committed = (await loadRuntime(fixture.paths)).state.codexCheckpointSnapshot;
  assert.equal(committed.generationId, marker.snapshotGenerationId);
  assert.deepEqual(committed.dailyValues, {
    "2026-07-18": "100",
    "2026-07-19": "250"
  });
});

test("snapshot planning fails closed when signed hydration omits authoritative status", async (context) => {
  const fixture = await setup();
  context.after(() => fs.rm(fixture.temporary, { recursive: true, force: true }));
  const secrets = createDeviceSecrets();
  secrets.dedupNamespaceKey = dedupNamespaceKey;
  const state = initialState();
  state.paired = true;
  state.deviceId = "device_missing_snapshot_status";
  const config = initialConfig();
  config.endpoint = "https://artificial-games.example";
  config.allowedPlatforms = ["codex"];
  config.supportedProviders = ["codex"];
  await saveSecrets(fixture.paths, secrets);
  await saveRuntime(fixture.paths, { state, config });

  await assert.rejects(() => sync({
    home: fixture.home,
    roots: fixture.roots,
    readCodexAccountUsage: async () => ({
      status: "available",
      summary: { lifetimeTokens: 1_000 },
      dailyUsageBuckets: [{ startDate: "2026-07-19", tokens: 100 }]
    }),
    fetchImpl: async (url) => {
      assert.equal(url.endsWith("/heartbeat"), true);
      return jsonResponse({
        request: { digest: "digest_missing_snapshot_status_1234567890" },
        heartbeat: { nextExpectedAt: "2026-07-21T01:00:00.000Z" }
      });
    }
  }), (error) => error.code === "INVALID_SERVER_SNAPSHOT_STATUS");
  const blocked = await loadRuntime(fixture.paths);
  assert.equal(blocked.state.nextSequence, 1);
  assert.equal(blocked.state.previousRequestDigest, "");
  assert.equal(blocked.state.syncOutbox, null);
  assert.equal(blocked.state.pendingRequest.kind, "heartbeat");
  assert.equal(blocked.state.pendingRequest.permanentFailure.code, "INVALID_SERVER_SNAPSHOT_STATUS");
});

test("a crash before the Codex snapshot marker replays one generation and commits only after success", async (context) => {
  const fixture = await setup();
  context.after(() => fs.rm(fixture.temporary, { recursive: true, force: true }));
  const secrets = createDeviceSecrets();
  secrets.dedupNamespaceKey = dedupNamespaceKey;
  const state = initialState();
  state.paired = true;
  state.deviceId = "device_snapshot_crash";
  const config = initialConfig();
  config.endpoint = "https://artificial-games.example";
  config.allowedPlatforms = ["codex"];
  config.supportedProviders = ["codex"];
  config.transcriptFallbacks = { codex: false, claude: false, kimi: false };
  await saveSecrets(fixture.paths, secrets);
  await saveRuntime(fixture.paths, { state, config });
  const evidence = {
    status: "available",
    summary: { lifetimeTokens: 1_234 },
    dailyUsageBuckets: [
      { startDate: "2026-07-17", tokens: 100 },
      { startDate: "2026-07-18", tokens: 200 },
      { startDate: "2026-07-19", tokens: 300 }
    ]
  };
  let calls = 0;
  let markerRequest;
  await assert.rejects(() => sync({
    home: fixture.home,
    roots: fixture.roots,
    readCodexAccountUsage: async () => evidence,
    chunkPaceMs: 0,
    maxAttempts: 1,
    fetchImpl: async (url, init) => {
      if (url.endsWith("/heartbeat")) {
        return codexSnapshotHeartbeat("digest_snapshot_crash_hydration_1234567890");
      }
      calls += 1;
      if (calls === 1) {
        return jsonResponse({
          request: { digest: "digest_snapshot_daily_1234567890" },
          accepted: 0,
          duplicates: 0,
          rejected: 0,
          checkpoints: acceptedCheckpointResults(JSON.parse(init.body).checkpoints)
        });
      }
      markerRequest = { body: init.body, requestId: init.headers["x-tokenboard-request-id"] };
      throw new Error("simulated crash before marker receipt");
    }
  }), /could not be reached/);
  const interrupted = await loadRuntime(fixture.paths);
  assert.equal(interrupted.state.codexCheckpointSnapshot.generationId, null);
  const pendingCheckpoints = interrupted.state.pendingRequest.body.checkpoints;
  const pendingCommit = pendingCheckpoints.find((checkpoint) => checkpoint.snapshotRole === "commit");
  assert.ok(pendingCommit);
  assert.equal(pendingCheckpoints.every((checkpoint) => (
    checkpoint.snapshotGenerationId === pendingCommit.snapshotGenerationId
  )), true);

  let replayed;
  await sync({
    home: fixture.home,
    roots: fixture.roots,
    readCodexAccountUsage: async () => { throw new Error("persisted outbox must replay without recollection"); },
    chunkPaceMs: 0,
    fetchImpl: async (_url, init) => {
      replayed = { body: init.body, requestId: init.headers["x-tokenboard-request-id"] };
      return jsonResponse({
        request: { digest: "digest_snapshot_marker_1234567890" },
        accepted: 0,
        duplicates: 0,
        rejected: 0,
        checkpoints: acceptedCheckpointResults(JSON.parse(init.body).checkpoints, { status: "duplicate" })
      });
    }
  });
  assert.deepEqual(replayed, markerRequest);
  const completed = await loadRuntime(fixture.paths);
  assert.equal(completed.state.codexCheckpointSnapshot.generationId, pendingCommit.snapshotGenerationId);
  assert.equal(completed.state.codexCheckpointSnapshot.snapshotDigest, pendingCommit.snapshotDigest);
});

test("a missing daily-delta acknowledgement blocks the generation and preserves local snapshot state", async (context) => {
  const fixture = await setup();
  context.after(() => fs.rm(fixture.temporary, { recursive: true, force: true }));
  const secrets = createDeviceSecrets();
  secrets.dedupNamespaceKey = dedupNamespaceKey;
  const state = initialState();
  state.paired = true;
  state.deviceId = "device_snapshot_missing_delta_ack";
  const config = initialConfig();
  config.endpoint = "https://artificial-games.example";
  config.allowedPlatforms = ["codex"];
  config.supportedProviders = ["codex"];
  await saveSecrets(fixture.paths, secrets);
  await saveRuntime(fixture.paths, { state, config });

  let calls = 0;
  await assert.rejects(() => sync({
    home: fixture.home,
    roots: fixture.roots,
    readCodexAccountUsage: async () => ({
      status: "available",
      summary: { lifetimeTokens: 1_234 },
      dailyUsageBuckets: [
        { startDate: "2026-07-18", tokens: 100 },
        { startDate: "2026-07-19", tokens: 200 }
      ]
    }),
    chunkPaceMs: 0,
    fetchImpl: async (url, init) => {
      if (url.endsWith("/heartbeat")) {
        return codexSnapshotHeartbeat("digest_missing_delta_hydration_1234567890");
      }
      calls += 1;
      const body = JSON.parse(init.body);
      assert.equal(body.checkpoints.length, 2);
      return jsonResponse({
        request: { digest: "digest_missing_daily_ack_1234567890" },
        accepted: 0,
        duplicates: 0,
        rejected: 0,
        // Deliberately acknowledge only one of the two submitted deltas.
        checkpoints: acceptedCheckpointResults(body.checkpoints.slice(0, 1))
      });
    }
  }), (error) => error.code === "CHECKPOINT_ACKNOWLEDGEMENT_REJECTED");
  assert.equal(calls, 1);
  const blocked = await loadRuntime(fixture.paths);
  assert.equal(blocked.state.codexCheckpointSnapshot.generationId, null);
  assert.equal(blocked.state.syncOutbox.index, 0);
  assert.equal(blocked.state.syncOutbox.permanentFailure.code, "CHECKPOINT_ACKNOWLEDGEMENT_REJECTED");
  assert.equal(blocked.state.syncOutbox.permanentFailure.itemCount, 1);
});

test("an inactive commit for a non-stale structural failure remains permanently blocked", async (context) => {
  const fixture = await setup();
  context.after(() => fs.rm(fixture.temporary, { recursive: true, force: true }));
  const secrets = createDeviceSecrets();
  secrets.dedupNamespaceKey = dedupNamespaceKey;
  const state = initialState();
  state.paired = true;
  state.deviceId = "device_snapshot_bad_commit";
  const config = initialConfig();
  config.endpoint = "https://artificial-games.example";
  config.allowedPlatforms = ["codex"];
  config.supportedProviders = ["codex"];
  await saveSecrets(fixture.paths, secrets);
  await saveRuntime(fixture.paths, { state, config });

  await assert.rejects(() => sync({
    home: fixture.home,
    roots: fixture.roots,
    readCodexAccountUsage: async () => ({
      status: "available",
      summary: { lifetimeTokens: 1_234 },
      dailyUsageBuckets: [{ startDate: "2026-07-19", tokens: 200 }]
    }),
    chunkPaceMs: 0,
    fetchImpl: async (url, init) => {
      if (url.endsWith("/heartbeat")) {
        return codexSnapshotHeartbeat("digest_bad_commit_hydration_1234567890");
      }
      const body = JSON.parse(init.body);
      const results = acceptedCheckpointResults(body.checkpoints, { submittedGenerationActive: false })
        .map((entry) => Object.hasOwn(entry, "submittedGenerationActive")
          ? { ...entry, activationReason: "digest_mismatch" }
          : entry);
      return jsonResponse({
        request: { digest: "digest_bad_commit_ingest_1234567890" },
        accepted: 0,
        duplicates: 0,
        rejected: 0,
        checkpoints: results,
        providerSnapshots: { codex: null }
      });
    }
  }), (error) => error.code === "CHECKPOINT_GENERATION_NOT_ACTIVE");
  const blocked = await loadRuntime(fixture.paths);
  assert.equal(blocked.state.codexCheckpointSnapshot.generationId, null);
  assert.equal(blocked.state.syncOutbox.permanentFailure.code, "CHECKPOINT_GENERATION_NOT_ACTIVE");
});

test("a two-device sibling race retires the stale generation and hydrates the active parent", async (context) => {
  const fixture = await setup();
  context.after(() => fs.rm(fixture.temporary, { recursive: true, force: true }));
  const secrets = createDeviceSecrets();
  secrets.dedupNamespaceKey = dedupNamespaceKey;
  const state = initialState();
  state.paired = true;
  state.deviceId = "device_snapshot_stale_parent";
  const config = initialConfig();
  config.endpoint = "https://artificial-games.example";
  config.allowedPlatforms = ["codex", "claude", "kimi"];
  config.supportedProviders = ["codex", "claude", "kimi"];
  config.transcriptFallbacks = { codex: true, claude: true, kimi: true };
  await saveSecrets(fixture.paths, secrets);
  await saveRuntime(fixture.paths, { state, config });

  let checkpointCalls = 0;
  let requestCounter = 0;
  const uploadedEventIds = [];
  const winner = codexSnapshotRecord("a".repeat(64), 1_500, {
    "2026-07-18": "150",
    "2026-07-19": "250"
  });
  const result = await sync({
    home: fixture.home,
    roots: fixture.roots,
    readCodexAccountUsage: async () => ({
      status: "available",
      summary: { lifetimeTokens: 1_234 },
      dailyUsageBuckets: [
        { startDate: "2026-07-18", tokens: 100 },
        { startDate: "2026-07-19", tokens: 200 }
      ]
    }),
    chunkPaceMs: 0,
    maxIngestRequests: 2,
    maximumSyncPageEvents: 1,
    fetchImpl: async (url, init) => {
      if (url.endsWith("/heartbeat")) {
        return codexSnapshotHeartbeat("digest_stale_parent_hydration_1234567890");
      }
      requestCounter += 1;
      const body = JSON.parse(init.body);
      if (!body.checkpoints) {
        uploadedEventIds.push(...body.events.map((event) => event.eventId));
        return jsonResponse({
          request: { digest: `digest_race_event_${requestCounter}_1234567890` },
          accepted: body.events.length,
          duplicates: 0,
          rejected: 0,
          events: body.events.map(acceptedEventResult)
        });
      }
      checkpointCalls += 1;
      const marker = body.checkpoints.find((checkpoint) => checkpoint.snapshotRole === "commit");
      const checkpointResults = marker
        ? acceptedCheckpointResults(body.checkpoints, { submittedGenerationActive: false })
            .map((entry) => ({ ...entry, activationReason: "stale_parent" }))
        : acceptedCheckpointResults(body.checkpoints);
      return jsonResponse({
        request: { digest: `digest_stale_parent_${requestCounter}_1234567890` },
        accepted: 0,
        duplicates: 0,
        rejected: 0,
        checkpoints: checkpointResults,
        ...(marker ? { providerSnapshots: { codex: winner } } : {})
      });
    }
  });
  assert.equal(checkpointCalls, 2);
  assert.deepEqual(uploadedEventIds, []);
  assert.equal(result.generationRebased, true);
  assert.equal(result.catchingUp, true);
  const staged = await loadRuntime(fixture.paths);
  assert.ok(staged.state.syncOutbox);
  assert.equal(staged.state.syncOutbox.commit.codexCheckpointSnapshot, null);
  assert.equal(staged.state.syncOutbox.totalEvents > 0, true);
  assert.equal(staged.state.syncOutbox.pages.length > 1, true);
  assert.deepEqual(staged.state.codexCheckpointSnapshot, {
    version: 1,
    ...winner
  });

  await sync({
    home: fixture.home,
    roots: fixture.roots,
    readCodexAccountUsage: async () => { throw new Error("the durable event outbox must drain before recollection"); },
    chunkPaceMs: 0,
    fetchImpl: async (_url, init) => {
      requestCounter += 1;
      const body = JSON.parse(init.body);
      assert.equal(body.checkpoints, undefined);
      uploadedEventIds.push(...body.events.map((event) => event.eventId));
      return jsonResponse({
        request: { digest: `digest_race_recovery_event_${requestCounter}_1234567890` },
        accepted: body.events.length,
        duplicates: 0,
        rejected: 0,
        events: body.events.map(acceptedEventResult)
      });
    }
  });
  assert.equal(uploadedEventIds.length, staged.state.syncOutbox.totalEvents);
  assert.equal(new Set(uploadedEventIds).size, uploadedEventIds.length);
  const completed = await loadRuntime(fixture.paths);
  assert.equal(completed.state.syncOutbox, null);
  assert.notEqual(completed.state.lastSyncAt, null);
  assert.deepEqual(completed.state.codexCheckpointSnapshot, {
    version: 1,
    ...winner
  });
});

test("an exact duplicate commit marker advances only when the submitted generation is active", async (context) => {
  const fixture = await setup();
  context.after(() => fs.rm(fixture.temporary, { recursive: true, force: true }));
  const secrets = createDeviceSecrets();
  secrets.dedupNamespaceKey = dedupNamespaceKey;
  const state = initialState();
  state.paired = true;
  state.deviceId = "device_snapshot_active_duplicate";
  const config = initialConfig();
  config.endpoint = "https://artificial-games.example";
  config.allowedPlatforms = ["codex"];
  config.supportedProviders = ["codex"];
  await saveSecrets(fixture.paths, secrets);
  await saveRuntime(fixture.paths, { state, config });

  let submittedGenerationId;
  await sync({
    home: fixture.home,
    roots: fixture.roots,
    readCodexAccountUsage: async () => ({
      status: "available",
      summary: { lifetimeTokens: 1_234 },
      dailyUsageBuckets: [
        { startDate: "2026-07-18", tokens: 100 },
        { startDate: "2026-07-19", tokens: 200 }
      ]
    }),
    chunkPaceMs: 0,
    fetchImpl: async (url, init) => {
      if (url.endsWith("/heartbeat")) {
        return codexSnapshotHeartbeat("digest_active_duplicate_hydration_1234567890");
      }
      const body = JSON.parse(init.body);
      const marker = body.checkpoints.find((checkpoint) => checkpoint.snapshotRole === "commit");
      if (marker) submittedGenerationId = marker.snapshotGenerationId;
      return jsonResponse({
        request: { digest: `digest_active_duplicate_${marker ? "marker" : "daily"}_1234567890` },
        accepted: 0,
        duplicates: marker ? 1 : 0,
        rejected: 0,
        checkpoints: acceptedCheckpointResults(body.checkpoints, {
          status: marker ? "duplicate" : "accepted"
        })
      });
    }
  });
  assert.equal((await loadRuntime(fixture.paths)).state.codexCheckpointSnapshot.generationId, submittedGenerationId);
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
        rejected: 0,
        events: JSON.parse(init.body).events.map(acceptedEventResult)
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
        events: body.events.map(acceptedEventResult)
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
        events: body.events.map(acceptedEventResult)
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

test("aggregate sync emits stable hourly model totals from retained history", async (context) => {
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
        events: body.events.map(acceptedEventResult)
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
  assert.equal(first.uploaded[0].inputTokens, "75");
  assert.equal(first.uploaded[0].cachedInputTokens, "12");
  assert.equal(first.uploaded[0].cacheWriteInputTokens, "6");
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
        events: body.events.map(acceptedEventResult)
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
        events: body.events.map(acceptedEventResult)
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
        events: body.events.map(acceptedEventResult)
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

test("pre-v5 Claude accounting replays Fast and raw-only history exactly once", async (context) => {
  const fixture = await setup();
  context.after(() => fs.rm(fixture.temporary, { recursive: true, force: true }));
  const secrets = createDeviceSecrets();
  secrets.dedupNamespaceKey = dedupNamespaceKey;
  const state = initialState();
  state.paired = true;
  state.deviceId = "device_claude_v4_replay";
  delete state.cursors.claude.accountingVersion;
  state.cursors.claude.seen.legacy_standard_projection = {
    hash: "f".repeat(64),
    lastSeenAt: 1
  };
  state.cursors.aggregate.providers.claude.through = "2026-07-20T11:00:00.000Z";
  state.providerEvidenceHashes.claude = "legacy-claude-evidence";
  const config = initialConfig();
  config.endpoint = "https://artificial-games.example";
  config.allowedPlatforms = ["claude"];
  config.supportedProviders = ["claude"];
  config.transcriptFallbacks = { codex: false, claude: true, kimi: false };
  await saveSecrets(fixture.paths, secrets);
  await saveRuntime(fixture.paths, { state, config });

  const uploaded = [];
  let digest = 0;
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
      digest += 1;
      return jsonResponse({
        request: { digest: `digest_claude_v4_replay_${digest}_1234567890` },
        accepted: body.events.length,
        duplicates: 0,
        rejected: 0,
        events: body.events.map(acceptedEventResult)
      });
    }
  });

  assert.equal((await run()).sent, 2);
  assert.equal(uploaded.length, 2);
  const fastEvent = uploaded.find((event) => event.serviceMode === "fast");
  assert.deepEqual({
    provider: fastEvent.provider,
    occurredAt: fastEvent.occurredAt,
    serviceMode: fastEvent.serviceMode,
    inputTokens: fastEvent.inputTokens,
    cachedInputTokens: fastEvent.cachedInputTokens,
    cacheWriteInputTokens: fastEvent.cacheWriteInputTokens,
    outputTokens: fastEvent.outputTokens
  }, {
    provider: "claude",
    occurredAt: "2026-07-19T11:30:00.000Z",
    serviceMode: "fast",
    inputTokens: "10",
    cachedInputTokens: "5",
    cacheWriteInputTokens: "2",
    outputTokens: "25"
  });
  assert.equal(uploaded.some((event) => event.attribution === "raw_only"
    && event.modelId === "unknown"
    && event.serviceMode === "unknown"), true);
  assert.equal((await run()).sent, 0);
  assert.equal(uploaded.length, 2);

  const updated = await loadRuntime(fixture.paths);
  assert.equal(updated.state.cursors.claude.accountingVersion, 5);
  assert.equal(updated.state.cursors.aggregate.providers.claude.through, "2026-07-20T11:00:00.000Z");
  assert.equal(updated.state.providerEvidenceHashes.claude, undefined);
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
        events: body.events.map(acceptedEventResult)
      });
    }
  });

  assert.equal(result.sent, 1);
  assert.equal(uploaded.length, 1);
  assert.equal(uploaded[0].inputTokens, "60");
  assert.equal(uploaded[0].cachedInputTokens, "40");
  assert.equal(uploaded[0].cacheWriteInputTokens, "5");
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
        events: body.events.map(acceptedEventResult)
      });
    }
  });

  assert.equal(result.sent, 1);
  assert.equal(uploaded.length, 1);
  assert.equal(uploaded[0].occurredAt, "2026-07-19T12:30:00.000Z");
  assert.equal(uploaded[0].inputTokens, "120000000");
  assert.equal(uploaded[0].cachedInputTokens, "2");
  assert.equal(uploaded[0].cacheWriteInputTokens, "1");
  assert.equal(uploaded[0].outputTokens, "5");
});

test("initial Kimi aggregate import includes all retained history beyond the scoring horizon", async (context) => {
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
        events: body.events.map(acceptedEventResult)
      });
    }
  });

  assert.equal((await run()).sent, 3);
  assert.deepEqual(
    uploaded.map((event) => event.occurredAt.slice(0, 13)),
    ["2026-07-19T13", "2026-07-19T12", "2026-03-01T12"]
  );
  assert.deepEqual(uploaded.map((event) => event.inputTokens), ["20", "10", "100"]);
  assert.deepEqual(uploaded.map((event) => event.cacheWriteInputTokens), ["1", "1", "1"]);
  assert.equal((await run()).sent, 0);
  assert.equal(uploaded.length, 3);
});

test("a raw-only event beyond 90 days commits when the server confirms Raw preservation", async (context) => {
  const fixture = await setup();
  context.after(() => fs.rm(fixture.temporary, { recursive: true, force: true }));
  const wirePath = path.join(fixture.roots.kimi, "session", "agents", "main", "wire.jsonl");
  await fs.writeFile(wirePath, JSON.stringify({
    type: "usage.record",
    time: "2026-03-01T12:00:01.000Z",
    model: "future-unregistered-model",
    usage: { inputOther: 12, inputCacheRead: 7, inputCacheCreation: 3, output: 20 },
    usageScope: "turn"
  }) + "\n", "utf8");
  const secrets = createDeviceSecrets();
  secrets.dedupNamespaceKey = dedupNamespaceKey;
  const state = initialState();
  state.paired = true;
  state.deviceId = "device_old_raw_only";
  const config = initialConfig();
  config.endpoint = "https://artificial-games.example";
  config.allowedPlatforms = ["kimi"];
  config.supportedProviders = ["kimi"];
  config.transcriptFallbacks = { codex: false, claude: false, kimi: true };
  await saveSecrets(fixture.paths, secrets);
  await saveRuntime(fixture.paths, { state, config });

  let uploaded;
  const first = await sync({
    home: fixture.home,
    roots: fixture.roots,
    aggregateHistory: true,
    now: Date.parse("2026-07-20T12:00:00.000Z"),
    officialEvidence: false,
    chunkPaceMs: 0,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      uploaded = body.events[0];
      return jsonResponse({
        request: { digest: "digest_old_raw_only_1234567890" },
        accepted: 0,
        quarantined: 1,
        duplicates: 0,
        rejected: 0,
        events: [{
          eventId: uploaded.eventId,
          status: "quarantined",
          scoringState: "quarantined",
          scoringReasons: ["retroactive_window"],
          rawEligible: true,
          rawPreserved: true,
          submittedRevisionActive: true
        }]
      });
    }
  });

  assert.equal(first.sent, 1);
  assert.equal(uploaded.attribution, "raw_only");
  assert.equal(uploaded.occurredAt, "2026-03-01T12:30:00.000Z");
  const committed = await loadRuntime(fixture.paths);
  assert.equal(committed.state.syncOutbox, null);
  assert.equal(committed.state.cursors.aggregate.providers.kimi.through, "2026-07-20T11:00:00.000Z");
  const second = await sync({
    home: fixture.home,
    roots: fixture.roots,
    aggregateHistory: true,
    now: Date.parse("2026-07-20T12:00:00.000Z"),
    officialEvidence: false,
    fetchImpl: async () => { throw new Error("preserved old Raw usage must not resend"); }
  });
  assert.equal(second.sent, 0);
});

test("initial Claude aggregate import includes retained usage beyond 90 days", async (context) => {
  const fixture = await setup();
  context.after(() => fs.rm(fixture.temporary, { recursive: true, force: true }));
  const claudePath = path.join(fixture.roots.claude, "project.jsonl");
  const record = (id, timestamp, input) => JSON.stringify({
    type: "assistant",
    timestamp,
    message: {
      id,
      model: "claude-sonnet-5-20260701",
      stop_reason: "end_turn",
      usage: {
        input_tokens: input,
        cache_creation_input_tokens: 2,
        cache_read_input_tokens: 3,
        output_tokens: 5,
        speed: "fast"
      }
    }
  });
  await fs.writeFile(claudePath, [
    record("msg_retained_old", "2026-03-01T12:05:00.000Z", 100),
    record("msg_retained_recent", "2026-07-19T12:05:00.000Z", 10)
  ].join("\n") + "\n", "utf8");
  const secrets = createDeviceSecrets();
  secrets.dedupNamespaceKey = dedupNamespaceKey;
  const state = initialState();
  state.paired = true;
  state.deviceId = "device_claude_retained_history";
  const config = initialConfig();
  config.endpoint = "https://artificial-games.example";
  config.allowedPlatforms = ["claude"];
  config.supportedProviders = ["claude"];
  config.transcriptFallbacks = { codex: false, claude: true, kimi: false };
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
        request: { digest: "digest_claude_retained_history_1234567890" },
        accepted: body.events.length,
        duplicates: 0,
        rejected: 0,
        events: body.events.map(acceptedEventResult)
      });
    }
  });

  assert.equal(result.sent, 2);
  assert.deepEqual(uploaded.map((event) => event.occurredAt.slice(0, 10)), ["2026-07-19", "2026-03-01"]);
  assert.deepEqual(uploaded.map((event) => event.inputTokens), ["10", "100"]);
  assert.deepEqual(uploaded.map((event) => event.cacheWriteInputTokens), ["2", "2"]);
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
        events: body.events.map(acceptedEventResult)
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
  assert.deepEqual(uploaded.map((event) => event.inputTokens), ["10", "30"]);
  assert.deepEqual(uploaded.map((event) => event.cachedInputTokens), ["2", "2"]);
  assert.deepEqual(uploaded.map((event) => event.cacheWriteInputTokens), ["1", "1"]);
  assert.deepEqual(uploaded.map((event) => event.outputTokens), ["5", "5"]);
});

test("parse loss stays visibly partial while later settled usage continues advancing", async (context) => {
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
    "x".repeat(MAX_JOURNAL_LINE_BYTES + 1),
    record("2026-07-19T12:05:00.000Z", 10)
  ].join("\n") + "\n", "utf8");
  const secrets = createDeviceSecrets();
  secrets.dedupNamespaceKey = dedupNamespaceKey;
  const state = initialState();
  state.paired = true;
  state.deviceId = "device_partial_coverage";
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
        request: { digest: `digest_partial_coverage_${digest}_1234567890` },
        accepted: body.events.length,
        duplicates: 0,
        rejected: 0,
        events: body.events.map(acceptedEventResult)
      });
    }
  });

  const first = await run("2026-07-20T12:00:00.000Z");
  assert.equal(first.sent, 1);
  assert.equal(first.adapters.kimi.coverage, "partial");
  assert.equal(first.adapters.kimi.parseLosses, 1);
  let runtime = await loadRuntime(fixture.paths);
  assert.equal(runtime.state.cursors.aggregate.providers.kimi.through, "2026-07-20T11:00:00.000Z");
  assert.deepEqual(runtime.state.rawOnlyBackfill.pendingProviders, ["kimi"]);
  assert.deepEqual(runtime.state.rawOnlyBackfill.partialCoverage.kimi, {
    parseLosses: 1,
    lastObservedAt: "2026-07-20T12:00:00.000Z"
  });

  await fs.appendFile(wirePath, record("2026-07-20T11:05:00.000Z", 20) + "\n", "utf8");
  const second = await run("2026-07-20T13:00:00.000Z");
  assert.equal(second.sent, 1);
  assert.deepEqual(uploaded.map((event) => event.inputTokens), ["10", "20"]);
  runtime = await loadRuntime(fixture.paths);
  assert.equal(runtime.state.cursors.aggregate.providers.kimi.through, "2026-07-20T12:00:00.000Z");
  assert.deepEqual(runtime.state.rawOnlyBackfill.pendingProviders, ["kimi"]);
  assert.equal(runtime.state.rawOnlyBackfill.partialCoverage.kimi.parseLosses, 1);
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
        events: body.events.map(acceptedEventResult)
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
  state.cursors.claude.seen.committed_marker = { hash: "d".repeat(64), lastSeenAt: 2 };
  state.cursors.aggregate.providers.claude.through = "2026-07-19T02:00:00.000Z";
  state.providerEvidenceHashes.claude = "legacy-claude-evidence";
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
  assert.deepEqual(updated.state.cursors.claude, { accountingVersion: 5, seen: {} });
  assert.equal(updated.state.cursors.aggregate.providers.claude.through, null);
  assert.equal(updated.state.providerEvidenceHashes.claude, undefined);
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
  stranded.state.syncOutbox.commit.nextCursors.claude = {
    seen: { legacy_commit: { hash: "e".repeat(64), lastSeenAt: 3 } }
  };
  stranded.state.syncOutbox.commit.nextCursors.aggregate.providers.claude.through = "2026-07-19T03:00:00.000Z";
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
        events: body.events.map(acceptedEventResult)
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
  assert.deepEqual(updated.state.cursors.codex, { accountingVersion: 5, files: {}, sessions: {} });
  assert.deepEqual(updated.state.cursors.claude, { accountingVersion: 5, seen: {} });
  assert.equal(updated.state.cursors.aggregate.providers.claude.through, null);
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
        events: body.events.map(acceptedEventResult)
      });
    }
  });
  assert.equal(result.sent, 1);
  assert.deepEqual(uploadedIds, [remainingLegacyId]);
  const completed = await loadRuntime(fixture.paths);
  assert.equal(completed.state.syncOutbox, null);
  assert.equal(completed.state.cursors.aggregate.providers.kimi.through, "2026-07-20T11:00:00.000Z");
});

test("sync uploads unknown usage immediately as raw-only and never resends it after a registry update", async (context) => {
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
  const uploaded = [];
  const first = await sync({
    home: fixture.home,
    roots: fixture.roots,
    officialEvidence: false,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      uploaded.push(...body.events);
      return jsonResponse({
        request: { digest: "digest_known_behind_unknown_123456" },
        accepted: body.events.length,
        duplicates: 0,
        rejected: 0,
        events: body.events.map(acceptedEventResult)
      });
    }
  });
  assert.equal(first.sent, 2);
  assert.equal(first.withheld, 0);
  assert.equal(first.unresolvedQueued, 0);
  const unknown = uploaded.find((event) => event.attribution === "raw_only");
  assert.deepEqual({
    attribution: unknown.attribution,
    modelId: unknown.modelId,
    serviceMode: unknown.serviceMode,
    inputTokens: unknown.inputTokens,
    cachedInputTokens: unknown.cachedInputTokens,
    cacheWriteInputTokens: unknown.cacheWriteInputTokens,
    outputTokens: unknown.outputTokens
  }, {
    attribution: "raw_only",
    modelId: "unknown",
    serviceMode: "unknown",
    inputTokens: "12",
    cachedInputTokens: "7",
    cacheWriteInputTokens: "3",
    outputTokens: "20"
  });
  assert.equal(Object.hasOwn(unknown, "sourceModelId"), false);
  const afterUnknown = await loadRuntime(fixture.paths);
  assert.equal(Object.values(afterUnknown.state.cursors.kimi.files)[0].offset, (await fs.stat(wirePath)).size);
  assert.equal(afterUnknown.state.unresolvedEvents.length, 0);
  const second = await sync({
    home: fixture.home,
    roots: fixture.roots,
    officialEvidence: false,
    canonicalModelId: (_provider, sourceModelId) => sourceModelId === "kimi-future-code"
      ? "kimi-k2.7-code"
      : null,
    fetchImpl: async () => { throw new Error("a later registry mapping must not resend consumed source usage"); }
  });
  assert.equal(second.sent, 0);
  const recovered = await loadRuntime(fixture.paths);
  assert.equal(Object.values(recovered.state.cursors.kimi.files)[0].offset, (await fs.stat(wirePath)).size);
  assert.equal(recovered.state.unresolvedEvents.length, 0);
  assert.equal(second.unresolvedQueued, 0);
});

test("raw-only usage drains through bounded pages without a lossy unresolved queue", async (context) => {
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
  const uploaded = [];
  let requests = 0;
  const result = await sync({
    home: fixture.home,
    roots: fixture.roots,
    officialEvidence: false,
    canonicalModelId: () => null,
    chunkPaceMs: 0,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      uploaded.push(...body.events);
      requests += 1;
      return jsonResponse({
        request: { digest: `digest_raw_only_page_${requests}_1234567890` },
        accepted: body.events.length,
        duplicates: 0,
        rejected: 0,
        events: body.events.map(acceptedEventResult)
      });
    }
  });
  assert.equal(result.sent, 4);
  assert.equal(result.withheld, 0);
  assert.equal(result.unresolvedQueued, 0);
  assert.equal(result.unresolvedOverflow, 0);
  assert.equal(uploaded.every((event) => event.attribution === "raw_only"
    && event.modelId === "unknown"
    && event.serviceMode === "unknown"), true);
  assert.equal(new Set(uploaded.map((event) => event.eventId)).size, 4);
  assert.doesNotMatch(JSON.stringify(uploaded), /SECRET PROMPT CONTENT/);
  const connectorStatus = await status({ home: fixture.home });
  assert.equal(connectorStatus.unresolvedQueued, 0);
  assert.equal(connectorStatus.unresolvedOverflow.totalDropped, 0);
  assert.deepEqual(connectorStatus.rawOnlyBackfill.pendingProviders, []);
  assert.doesNotMatch(JSON.stringify(await loadRuntime(fixture.paths)), /SECRET PROMPT CONTENT/);
});

test("the retired unresolved queue migrates once to raw-only without exposing or later resending its source model", async (context) => {
  const fixture = await setup();
  context.after(() => fs.rm(fixture.temporary, { recursive: true, force: true }));
  const secrets = createDeviceSecrets();
  secrets.dedupNamespaceKey = dedupNamespaceKey;
  const state = initialState();
  state.paired = true;
  state.deviceId = "device_legacy_unresolved";
  state.unresolvedEvents = [{
    eventId: "e".repeat(64),
    occurredAt: "2026-07-19T12:00:00.000Z",
    provider: "kimi",
    sourceModelId: "future-private-model-token",
    serviceMode: "fast",
    inputTokens: "11",
    cachedInputTokens: "7",
    outputTokens: "13",
    reasoningTokens: "5",
    surface: "kimi_code"
  }];
  const config = initialConfig();
  config.endpoint = "https://artificial-games.example";
  config.allowedPlatforms = ["kimi"];
  config.supportedProviders = ["kimi"];
  config.transcriptFallbacks = { codex: false, claude: false, kimi: false };
  await saveSecrets(fixture.paths, secrets);
  await saveRuntime(fixture.paths, { state, config });

  let uploaded;
  const first = await sync({
    home: fixture.home,
    roots: fixture.roots,
    officialEvidence: false,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      uploaded = body.events[0];
      return jsonResponse({
        request: { digest: "digest_legacy_raw_only_1234567890" },
        accepted: 1,
        duplicates: 0,
        rejected: 0,
        events: [{
          eventId: uploaded.eventId,
          status: "accepted",
          scoringState: "accepted",
          rawEligible: true,
          rawPreserved: true,
          submittedRevisionActive: true
        }]
      });
    }
  });

  assert.equal(first.sent, 1);
  assert.deepEqual(uploaded, {
    eventId: "e".repeat(64),
    occurredAt: "2026-07-19T12:00:00.000Z",
    provider: "kimi",
    serviceProviderId: "kimi",
    attribution: "raw_only",
    modelId: "unknown",
    serviceMode: "unknown",
    inputTokens: "11",
    cachedInputTokens: "7",
    cacheWriteInputTokens: "0",
    outputTokens: "13",
    reasoningTokens: "5",
    surface: "kimi_code"
  });
  assert.doesNotMatch(JSON.stringify(uploaded), /future-private-model-token/);
  assert.equal((await loadRuntime(fixture.paths)).state.unresolvedEvents.length, 0);

  const second = await sync({
    home: fixture.home,
    roots: fixture.roots,
    officialEvidence: false,
    canonicalModelId: () => "kimi-k2.7-code",
    fetchImpl: async () => { throw new Error("a migrated raw-only record must not be sent twice"); }
  });
  assert.equal(second.sent, 0);
});

test("an isolated raw-only contract rejection fails closed without committing its source cursor", async (context) => {
  const fixture = await setup();
  context.after(() => fs.rm(fixture.temporary, { recursive: true, force: true }));
  const wirePath = path.join(fixture.roots.kimi, "session", "agents", "main", "wire.jsonl");
  await fs.writeFile(wirePath, JSON.stringify({
    type: "usage.record",
    time: "2026-07-19T12:00:01.000Z",
    model: "future-model",
    usage: { inputOther: 12, inputCacheRead: 7, inputCacheCreation: 3, output: 20 },
    usageScope: "turn"
  }) + "\n", "utf8");
  const secrets = createDeviceSecrets();
  secrets.dedupNamespaceKey = dedupNamespaceKey;
  const state = initialState();
  state.paired = true;
  state.deviceId = "device_raw_only_rejection";
  const config = initialConfig();
  config.endpoint = "https://artificial-games.example";
  config.allowedPlatforms = ["kimi"];
  config.supportedProviders = ["kimi"];
  config.transcriptFallbacks = { codex: false, claude: false, kimi: true };
  await saveSecrets(fixture.paths, secrets);
  await saveRuntime(fixture.paths, { state, config });

  await assert.rejects(() => sync({
    home: fixture.home,
    roots: fixture.roots,
    officialEvidence: false,
    canonicalModelId: () => null,
    maxAttempts: 1,
    fetchImpl: async () => errorResponse(422, "MODEL_NOT_SUPPORTED")
  }), (error) => error.code === "MODEL_NOT_SUPPORTED");

  const blocked = await loadRuntime(fixture.paths);
  assert.equal(blocked.state.pendingRequest.permanentFailure.code, "RAW_ONLY_CONTRACT_REJECTED");
  assert.notEqual(blocked.state.syncOutbox, null);
  assert.deepEqual(blocked.state.cursors.kimi.files, {});
});

test("a partial-success response cannot quarantine raw-only usage or commit its source cursor", async (context) => {
  const fixture = await setup();
  context.after(() => fs.rm(fixture.temporary, { recursive: true, force: true }));
  const wirePath = path.join(fixture.roots.kimi, "session", "agents", "main", "wire.jsonl");
  await fs.writeFile(wirePath, JSON.stringify({
    type: "usage.record",
    time: "2026-07-19T12:00:01.000Z",
    model: "future-model",
    usage: { inputOther: 12, inputCacheRead: 7, inputCacheCreation: 3, output: 20 },
    usageScope: "turn"
  }) + "\n", "utf8");
  const secrets = createDeviceSecrets();
  secrets.dedupNamespaceKey = dedupNamespaceKey;
  const state = initialState();
  state.paired = true;
  state.deviceId = "device_raw_only_partial_rejection";
  const config = initialConfig();
  config.endpoint = "https://artificial-games.example";
  config.allowedPlatforms = ["kimi"];
  config.supportedProviders = ["kimi"];
  config.transcriptFallbacks = { codex: false, claude: false, kimi: true };
  await saveSecrets(fixture.paths, secrets);
  await saveRuntime(fixture.paths, { state, config });

  let rejectedId;
  await assert.rejects(() => sync({
    home: fixture.home,
    roots: fixture.roots,
    officialEvidence: false,
    canonicalModelId: () => null,
    chunkPaceMs: 0,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      rejectedId = body.events[0].eventId;
      return jsonResponse({
        request: { digest: "digest_raw_only_partial_1234567890" },
        accepted: 0,
        duplicates: 0,
        rejected: 1,
        events: [{
          eventId: rejectedId,
          status: "rejected",
          submittedRevisionActive: true
        }]
      });
    }
  }), (error) => error.code === "RAW_ONLY_CONTRACT_REJECTED");

  const blocked = await loadRuntime(fixture.paths);
  assert.equal(blocked.state.pendingRequest, null);
  assert.deepEqual(blocked.state.syncOutbox.permanentFailure, {
    code: "RAW_ONLY_CONTRACT_REJECTED",
    status: null,
    eventCount: 1
  });
  assert.deepEqual(blocked.state.syncOutbox.quarantinedEventIds, []);
  assert.deepEqual(blocked.state.cursors.kimi.files, {});
  assert.equal(blocked.state.nextSequence, 2);
  assert.equal((await status({ home: fixture.home })).syncOutboxPermanentFailure.code, "RAW_ONLY_CONTRACT_REJECTED");

  await assert.rejects(() => sync({
    home: fixture.home,
    roots: fixture.roots,
    officialEvidence: false,
    fetchImpl: async () => { throw new Error("a blocked raw-only outbox must not issue another request"); }
  }), (error) => error.code === "RAW_ONLY_CONTRACT_REJECTED");

  let heartbeatBody;
  const scheduled = await scheduledRun({
    home: fixture.home,
    roots: fixture.roots,
    officialEvidence: false,
    fetchImpl: async (url, init) => {
      assert.equal(url.endsWith("/heartbeat"), true);
      heartbeatBody = JSON.parse(init.body);
      return jsonResponse({
        request: { digest: "digest_blocked_raw_heartbeat_1234567890" },
        heartbeat: { nextExpectedAt: "2026-07-19T14:00:00.000Z" },
        device: { continuityState: "continuous" }
      });
    }
  });
  assert.equal(scheduled.sync.blocked, true);
  assert.equal(scheduled.heartbeat.sent, true);
  assert.equal(heartbeatBody.status, "degraded");
});

test("a response without exact revision acknowledgement fails closed", async (context) => {
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
  await assert.rejects(() => sync({
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
  }), (error) => error.code === "EVENT_ACKNOWLEDGEMENT_REJECTED");
  const afterConflict = await loadRuntime(fixture.paths);
  assert.deepEqual(afterConflict.state.quarantinedEventIds, []);
  assert.equal(afterConflict.state.syncOutbox.permanentFailure.code, "EVENT_ACKNOWLEDGEMENT_REJECTED");
  assert.deepEqual(afterConflict.state.cursors.codex.files, {});
  await assert.rejects(() => sync({
    home: fixture.home,
    roots: fixture.roots,
    officialEvidence: false,
    fetchImpl: async () => { throw new Error("blocked outbox must not retry"); }
  }), (error) => error.code === "EVENT_ACKNOWLEDGEMENT_REJECTED");
});

test("an exact canonical-observation duplicate acknowledgement commits the submitted cursor", async (context) => {
  const fixture = await setup();
  context.after(() => fs.rm(fixture.temporary, { recursive: true, force: true }));
  const secrets = createDeviceSecrets();
  secrets.dedupNamespaceKey = dedupNamespaceKey;
  const state = initialState();
  state.paired = true;
  state.deviceId = "device_canonical_observation_duplicate";
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
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      return jsonResponse({
        request: { digest: "digest_canonical_observation_1234567890" },
        accepted: 0,
        duplicates: body.events.length,
        rejected: 0,
        events: body.events.map((event) => ({
          eventId: event.eventId,
          status: "duplicate",
          submittedRevisionActive: false,
          submittedObservationCanonical: true
        }))
      });
    }
  });
  assert.equal(result.sent, 1);
  const committed = await loadRuntime(fixture.paths);
  assert.ok(Object.values(committed.state.cursors.kimi.files)[0].offset > 0);
  assert.equal(committed.state.syncOutbox, null);
});

test("a permanently invalid same-type batch is bisected and the isolated item blocks cursor commit", async (context) => {
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
  await assert.rejects(() => sync({
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
        events: body.events.map(acceptedEventResult)
      });
    }
  }), (error) => error.code === "MODEL_NOT_SUPPORTED");
  assert.equal(batches.some((batch) => batch.length > 1), true);
  assert.equal(batches.some((batch) => batch.length === 1 && batch[0] === badEventId), true);
  const updated = await loadRuntime(fixture.paths);
  assert.deepEqual(updated.state.quarantinedEventIds, []);
  assert.equal(updated.state.pendingRequest.permanentFailure.code, "SYNC_ITEM_UNACKNOWLEDGED");
  assert.notEqual(updated.state.syncOutbox, null);
  assert.deepEqual(updated.state.cursors.kimi.files, {});
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
        rejected: 0,
        events: body.events.map(acceptedEventResult)
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
        events: body.events.map(acceptedEventResult)
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
        events: body.events.map(acceptedEventResult)
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

test("a failed automatic update cannot roll back a committed heartbeat", async (context) => {
  const fixture = await setup();
  context.after(() => fs.rm(fixture.temporary, { recursive: true, force: true }));
  const secrets = createDeviceSecrets();
  secrets.dedupNamespaceKey = dedupNamespaceKey;
  const state = initialState();
  state.paired = true;
  state.deviceId = "device_12345678";
  state.nextSequence = 9;
  state.previousRequestDigest = "digest_previous_update_test";
  const config = initialConfig();
  config.endpoint = "https://artificial-games.example";
  await saveSecrets(fixture.paths, secrets);
  await saveRuntime(fixture.paths, { state, config });
  await fs.copyFile(path.join(connectorRoot, "src", "launcher.mjs"), fixture.paths.launcher);
  const update = {
    available: true,
    release: {
      repository: "https://github.com/TheFysionX/TAG-Plugin",
      version: "0.2.0",
      tag: "v0.2.0",
      commit: "a".repeat(40),
      asset: "tag-plugin-0.2.0.tgz",
      sha256: "b".repeat(64),
      updaterProtocol: 1,
      runtimeStateSchema: 1
    }
  };
  const result = await heartbeat({
    home: fixture.home,
    fetchImpl: async () => jsonResponse({
      request: { digest: "digest_committed_before_update" },
      heartbeat: { nextExpectedAt: "2026-07-19T13:00:00.000Z" },
      device: { continuityState: "continuous" },
      update
    }),
    updateFetchImpl: async () => { throw new Error("GitHub unavailable for test"); },
    now: Date.parse("2026-07-19T12:00:00.000Z"),
    nonce: "heartbeat-update-failure"
  });
  assert.equal(result.sent, true);
  assert.equal(result.update.status, "failed");
  assert.equal(result.update.code, "UPDATE_GITHUB_UNAVAILABLE");
  const updated = await loadRuntime(fixture.paths);
  assert.equal(updated.state.nextSequence, 10);
  assert.equal(updated.state.previousRequestDigest, "digest_committed_before_update");
  assert.equal(updated.state.pendingRequest, null);
  assert.equal(await fs.access(fixture.paths.activeRelease).then(() => true).catch(() => false), false);
  const updateState = JSON.parse(await fs.readFile(fixture.paths.updateState, "utf8"));
  assert.equal(updateState.lastResult, "failed");
  assert.equal(updateState.permanentFailure, false);
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
  assert.equal(result.localReadSurfaces.find((surface) => surface.provider === "gemini").source,
    "Antigravity sanitized statusLine capture");
  assert.equal(result.networkPerformed, false);
  const diagnostics = await doctor({ home: fixture.home, roots: fixture.roots });
  assert.equal(diagnostics.sources.gemini.status, "antigravity_sanitized_statusline_capture");
  assert.equal(diagnostics.sources.grok.status, "local_session_summary_only");
  assert.equal(diagnostics.sources.deepseek.status, "hosted_model_attribution_or_explicit_api_evidence_only");
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
  assert.match(commands[1].join(" "), /[\\/]launcher\.mjs/);
  assert.match(commands[1].join(" "), /scheduled-run --home/);
  assert.equal(await fs.access(fixture.paths.launcher).then(() => true), true);
  assert.equal(await fs.access(fixture.paths.activeRelease).then(() => true), true);
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

test("confirmed install reuses only an identical immutable version directory", async (context) => {
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
  const options = {
    home: fixture.home,
    platform: "linux",
    releaseRoot: connectorRoot,
    userHome: fixture.temporary,
    xdgConfigHome: path.join(fixture.temporary, "config"),
    confirmInstall: true,
    runCommand: async () => {}
  };
  const first = await install(options);
  const second = await install(options);
  assert.equal(first.installedRelease, second.installedRelease);
  await fs.writeFile(path.join(first.installedRelease, "README.md"), "tampered\n", "utf8");
  await assert.rejects(
    () => install(options),
    (error) => error?.code === "VERSION_IDENTITY_CONFLICT"
  );
  await uninstall({ ...options, confirmUninstall: true });
  assert.equal(await fs.access(path.join(fixture.home, "versions")).then(() => true).catch(() => false), false);
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
  const installedPath = path.join(fixture.home, "versions", "0.1.11");
  assert.equal(await fs.access(installedPath).then(() => true).catch(() => false), false);
});

test("confirmed install and uninstall refuse to overlap another connector operation", async (context) => {
  const fixture = await setup();
  context.after(() => fs.rm(fixture.temporary, { recursive: true, force: true }));
  const commands = [];
  const options = {
    home: fixture.home,
    platform: "win32",
    releaseRoot: connectorRoot,
    confirmInstall: true,
    confirmUninstall: true,
    runCommand: async (executable, args) => commands.push([executable, ...args])
  };
  await fs.mkdir(fixture.home, { recursive: true });
  const release = await acquireLock(fixture.paths.lock);
  try {
    await assert.rejects(
      () => install(options),
      (error) => error?.code === "SYNC_ALREADY_RUNNING"
    );
    await assert.rejects(
      () => uninstall(options),
      (error) => error?.code === "SYNC_ALREADY_RUNNING"
    );
  } finally {
    await release();
  }

  assert.deepEqual(commands, []);
  assert.equal(
    await fs.access(path.join(fixture.home, "versions", "0.1.11")).then(() => true).catch(() => false),
    false
  );
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
