import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verify } from "node:crypto";
import { createDeviceSecrets } from "../src/crypto.mjs";
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
  assert.deepEqual(chunks.map((chunk) => chunk.events.length), [3, 3, 2, 0, 0, 0]);
  assert.deepEqual(chunks.map((chunk) => chunk.checkpoints.length), [0, 0, 0, 2, 2, 1]);
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
  assert.match(commands[1].join(" "), /versions[\\/]0\.1\.1[\\/]src[\\/]cli\.mjs/);
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
  const installedPath = path.join(fixture.home, "versions", "0.1.1");
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
