import test from "node:test";
import assert from "node:assert/strict";
import { readAntigravityPlanStatus } from "../src/adapters/antigravity-plan.mjs";

const TOKEN = "2a1b0c3d-9e9f-4c5e-adf9-e5881f4c250e";
const FINGERPRINT = "A1:".repeat(31) + "A1";

function server(overrides = {}) {
  return {
    name: "language_server.exe",
    executablePath: "C:\\Users\\Theo\\AppData\\Local\\Programs\\antigravity\\resources\\bin\\language_server.exe",
    sameUser: true,
    startedAt: "2026-07-22T10:00:00.000Z",
    commandLine: `C:\\Antigravity\\language_server.exe --standalone --override_ide_name antigravity --override_ide_version 2.3.1 --https_server_port 53775 --csrf_token ${TOKEN}`,
    listeners: [{ address: "127.0.0.1", port: 53775, state: "listen" }],
    ...overrides
  };
}

function response(value, statusCode = 200) {
  return { statusCode, body: JSON.stringify(value) };
}

async function detected(value, options = {}) {
  return readAntigravityPlanStatus({
    platform: "win32",
    now: "2026-07-22T12:00:00.000Z",
    listProcesses: async () => [server()],
    detectAntigravityDesktopVersion: async () => ({ status: "supported", version: "2.3.1" }),
    readTlsFingerprint: async () => FINGERPRINT,
    requestImpl: async () => response(value),
    ...options
  });
}

test("Antigravity uses the native effective tier and ignores a conflicting legacy Pro label", async () => {
  const result = await detected({ userStatus: { userTier: { id: "free-tier" }, planStatus: { planInfo: { planName: "Pro", email: "never-return@example.com" } } } });
  assert.deepEqual(result, {
    status: "available",
    verification: "provider_backed_antigravity_language_server",
    planObservation: {
      providerId: "gemini",
      serviceSurface: "antigravity",
      rawPlanCode: "free",
      evidenceType: "antigravity_local_effective_tier",
      observedAt: "2026-07-22T12:00:00.000Z"
    }
  });
});

test("unverified native paid tier IDs retain a bounded diagnostic code instead of inventing a retail SKU", async () => {
  assert.equal((await detected({ response: { paidTier: { id: "g1-pro-tier" }, currentTier: { id: "free-tier" } } })).planObservation.rawPlanCode, "unknown:g1_pro_tier");
  assert.equal((await detected({ response: { paidTier: { id: "g1-ultra-5x-tier" }, currentTier: { id: "free-tier" } } })).planObservation.rawPlanCode, "unknown:g1_ultra_5x_tier");
  assert.equal((await detected({ response: { paidTier: { id: "g1-ultra-20x-tier" }, currentTier: { id: "free-tier" } } })).planObservation.rawPlanCode, "unknown:g1_ultra_20x_tier");
});

test("the current machine's Starter response maps to Antigravity Free", async () => {
  const result = await detected({ userStatus: { userTier: { id: "free-tier" }, planStatus: { planInfo: { planName: "Starter" } } } });
  assert.equal(result.status, "available");
  assert.equal(result.planObservation.rawPlanCode, "free");
});

test("missing native tier evidence retains the previously reported plan", async () => {
  assert.deepEqual(await detected({ userStatus: { planStatus: { planInfo: { planName: "Pro" } } } }), {
    status: "unavailable",
    reason: "provider_plan_unavailable"
  });
});

test("an authenticated tier falls back to a normalized native display name only when its ID is absent", async () => {
  const result = await detected({ response: { paidTier: { name: "Google AI Ultra (20x)" }, currentTier: { id: "free-tier" } } });
  assert.equal(result.status, "available");
  assert.equal(result.planObservation.rawPlanCode, "unknown:google_ai_ultra_20x");
});

test("unknown native tier diagnostics are normalized and bounded", async () => {
  const result = await detected({ response: { paidTier: { id: `Provider Future Tier!!! ${"x".repeat(100)}`, name: "must-not-win" }, currentTier: { id: "free-tier" } } });
  const code = result.planObservation.rawPlanCode;
  assert.match(code, /^unknown:provider_future_tier_x+$/u);
  assert.equal(code.length, "unknown:".length + 64);
  assert.doesNotMatch(code, /must-not-win/u);
});

test("an authenticated but unrecognized native tier preserves its ID rather than another field", async () => {
  const result = await detected({ response: { paidTier: { id: "provider-future-tier", name: "Google Future" }, currentTier: { id: "free-tier" } } });
  assert.equal(result.status, "available");
  assert.equal(result.planObservation.rawPlanCode, "unknown:provider_future_tier");
});

test("GetUserStatus remains authoritative when GetLoadCodeAssist is unavailable", async () => {
  const requests = [];
  const result = await detected({}, {
    requestImpl: async (request) => {
      requests.push(request);
      if (request.url.endsWith("/GetLoadCodeAssist")) return response({}, 404);
      return response({ userStatus: { userTier: { id: "free-tier" } } });
    }
  });
  assert.equal(result.planObservation.rawPlanCode, "free");
  assert.deepEqual(requests.map((request) => request.url.split("/").at(-1)), ["GetUserStatus", "GetLoadCodeAssist"]);
});

test("conflicting primary and corroborating tiers are ambiguous and do not overwrite prior evidence", async () => {
  const result = await detected({}, {
    requestImpl: async (request) => request.url.endsWith("/GetUserStatus")
      ? response({ userStatus: { userTier: { id: "free-tier" } } })
      : response({ response: { paidTier: { id: "g1-pro-tier" } } })
  });
  assert.deepEqual(result, { status: "unavailable", reason: "ambiguous_provider_tier" });
});

test("a signed-out local server never falls back to stale process data", async () => {
  const stale = server({ startedAt: "2026-07-22T09:00:00.000Z", listeners: [{ address: "127.0.0.1", port: 53001, state: "listen" }] });
  const current = server({ startedAt: "2026-07-22T11:00:00.000Z", listeners: [{ address: "127.0.0.1", port: 53775, state: "listen" }] });
  const result = await readAntigravityPlanStatus({
    platform: "win32", listProcesses: async () => [stale, current],
    detectAntigravityDesktopVersion: async () => ({ status: "supported", version: "2.3.1" }),
    readTlsFingerprint: async () => FINGERPRINT,
    requestImpl: async () => response({ userStatus: { signedIn: false } })
  });
  assert.deepEqual(result, { status: "signed_out" });
});

test("malformed and non-200 local replies are non-sensitive unavailable results", async () => {
  const detector = async () => ({ status: "supported", version: "2.3.1" });
  const fingerprint = async () => FINGERPRINT;
  const malformed = await readAntigravityPlanStatus({ platform: "win32", listProcesses: async () => [server()], detectAntigravityDesktopVersion: detector, readTlsFingerprint: fingerprint, requestImpl: async () => ({ statusCode: 200, body: "not-json" }) });
  const forbidden = await readAntigravityPlanStatus({ platform: "win32", listProcesses: async () => [server()], detectAntigravityDesktopVersion: detector, readTlsFingerprint: fingerprint, requestImpl: async () => response({}, 403) });
  assert.deepEqual(malformed, { status: "unavailable", reason: "invalid_response" });
  assert.deepEqual(forbidden, { status: "unavailable", reason: "invalid_response" });
});

test("non-loopback, non-current-user, and non-pinned-executable servers are rejected before a request", async () => {
  for (const candidate of [
    server({ listeners: [{ address: "10.0.0.5", port: 53775, state: "listen" }] }),
    server({ sameUser: false }),
    server({ executablePath: "C:\\Temp\\language_server.exe" }),
    server({ commandLine: `C:\\Antigravity\\language_server.exe --override_ide_name antigravity --override_ide_version 2.4.0 --https_server_port 53775 --csrf_token ${TOKEN}` })
  ]) {
    let called = false;
    const result = await readAntigravityPlanStatus({ platform: "win32", listProcesses: async () => [candidate], detectAntigravityDesktopVersion: async () => ({ status: "supported", version: "2.3.1" }), requestImpl: async () => { called = true; return response({}); } });
    assert.deepEqual(result, { status: "unavailable", reason: "local_language_server_not_found" });
    assert.equal(called, false);
  }
});

test("timeouts are bounded and never disclose the CSRF token or local endpoint", async () => {
  const result = await readAntigravityPlanStatus({
    platform: "win32", listProcesses: async () => [server()],
    detectAntigravityDesktopVersion: async () => ({ status: "supported", version: "2.3.1" }),
    readTlsFingerprint: async () => FINGERPRINT,
    requestImpl: async () => { const error = new Error("timeout"); error.code = "ETIMEDOUT"; throw error; }
  });
  assert.deepEqual(result, { status: "unavailable", reason: "timeout" });
  assert.doesNotMatch(JSON.stringify(result), new RegExp(TOKEN, "u"));
  assert.doesNotMatch(JSON.stringify(result), /53775/u);
});

test("only the newest viable process is queried before stale candidates", async () => {
  const stale = server({ startedAt: "2026-07-22T09:00:00.000Z", listeners: [{ address: "127.0.0.1", port: 53001, state: "listen" }] });
  const current = server({ startedAt: "2026-07-22T11:00:00.000Z", listeners: [{ address: "127.0.0.1", port: 53775, state: "listen" }] });
  const requests = [];
  const result = await readAntigravityPlanStatus({
    platform: "win32", listProcesses: async () => [stale, current],
    detectAntigravityDesktopVersion: async () => ({ status: "supported", version: "2.3.1" }),
    readTlsFingerprint: async () => FINGERPRINT,
    requestImpl: async (request) => {
      requests.push(request);
      return request.url.endsWith("/GetUserStatus")
        ? response({ userStatus: { userTier: { id: "free-tier" } } })
        : response({ response: { paidTier: { id: "free-tier" } } });
    }
  });
  assert.equal(result.planObservation.rawPlanCode, "free");
  assert.equal(requests.length, 2);
  assert.match(requests[0].url, /:53775\//u);
  assert.equal(requests[0].certificateFingerprint256, FINGERPRINT);
});
