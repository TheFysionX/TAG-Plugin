import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DETECTION_STATE_VERSION, detectionWireReport, probeInstalledProviders } from "../src/providers/detect.mjs";
import { loadRuntime, saveRuntime } from "../src/state.mjs";
import { runtimePaths } from "../src/paths.mjs";
import { applyServerControls, refreshDetection } from "../src/operations.mjs";

const ALL_IDS = ["codex", "claude", "kimi", "gemini", "grok", "deepseek"];

async function tempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function rootsWithPresent(base, presentKeys) {
  const keys = ["codex", "claude", "kimi", "antigravityDesktop", "grok"];
  const roots = {};
  for (const key of keys) {
    roots[key] = path.join(base, key);
    if (presentKeys.includes(key)) {
      await fs.mkdir(roots[key], { recursive: true });
    }
  }
  return roots;
}

async function seed(home, configOverrides) {
  const paths = runtimePaths({ home });
  const runtime = await loadRuntime(paths);
  Object.assign(runtime.config, configOverrides);
  await saveRuntime(paths, runtime);
  return paths;
}

test("probe detects present provider directories content-free and marks absent ones", async (context) => {
  const base = await tempDir("tag-detect-");
  context.after(() => fs.rm(base, { recursive: true, force: true }));
  const roots = await rootsWithPresent(base, ["codex", "kimi"]);
  const detection = await probeInstalledProviders(roots, { now: 1_000 });
  assert.equal(detection.codex.detected, true);
  assert.equal(detection.codex.ready, true);
  assert.equal(detection.codex.reason, "detected");
  assert.equal(detection.kimi.detected, true);
  assert.equal(detection.claude.detected, false);
  assert.equal(detection.claude.reason, "absent");
  // DeepSeek has no local surface to probe.
  assert.equal(detection.deepseek.detected, false);
  assert.equal(detection.deepseek.reason, "no_local_surface");
  assert.equal(detection.codex.checkedAt, new Date(1_000).toISOString());
});

test("version-pinned provider is detected but not ready to auto-track", async (context) => {
  const base = await tempDir("tag-detect-pin-");
  context.after(() => fs.rm(base, { recursive: true, force: true }));
  const roots = await rootsWithPresent(base, ["antigravityDesktop"]);
  const detection = await probeInstalledProviders(roots, { now: 5 });
  assert.equal(detection.gemini.detected, true);
  assert.equal(detection.gemini.ready, false);
  assert.equal(detection.gemini.reason, "detected_pending_version");
  assert.equal(detection.gemini.versionPin, "2.3.1");
});

test("probe never throws when a root is undefined or unreadable", async () => {
  const detection = await probeInstalledProviders({}, { now: 1 });
  for (const id of ALL_IDS) {
    assert.ok(detection[id], `missing ${id}`);
    assert.equal(detection[id].detected, false);
    assert.equal(detection[id].ready, false);
  }
});

test("refresh-detection with auto-track enables a detected, authorized journal provider", async (context) => {
  const home = await tempDir("tag-refresh-");
  const base = await tempDir("tag-refresh-roots-");
  context.after(() => Promise.all([
    fs.rm(home, { recursive: true, force: true }),
    fs.rm(base, { recursive: true, force: true })
  ]));
  const roots = await rootsWithPresent(base, ["kimi"]);
  await seed(home, {
    allowedPlatforms: ["kimi", "codex"],
    supportedProviders: ["kimi", "codex"],
    autoTrack: true,
    transcriptFallbacks: { codex: false, claude: false, kimi: false }
  });
  const result = await refreshDetection({ home, roots, now: 2_000 });
  assert.equal(result.probed, true);
  assert.equal(result.autoTrack, true);
  assert.deepEqual(result.autoEnabledTracking, ["kimi"]);
  assert.equal(result.transcriptFallbacks.kimi, true);
  // Codex is authorized but not installed, so it is not auto-enabled.
  assert.equal(result.transcriptFallbacks.codex, false);
  assert.equal(result.detection.providers.kimi.detected, true);
  assert.equal(result.detection.lastRefreshedAt, new Date(2_000).toISOString());
  const reloaded = await loadRuntime(runtimePaths({ home }));
  assert.equal(reloaded.config.transcriptFallbacks.kimi, true);
  assert.equal(reloaded.state.detection.providers.kimi.detected, true);
});

test("auto-track never enables an unauthorized provider even when detected", async (context) => {
  const home = await tempDir("tag-refresh-unauth-");
  const base = await tempDir("tag-refresh-unauth-roots-");
  context.after(() => Promise.all([
    fs.rm(home, { recursive: true, force: true }),
    fs.rm(base, { recursive: true, force: true })
  ]));
  const roots = await rootsWithPresent(base, ["kimi"]);
  await seed(home, {
    allowedPlatforms: [],
    supportedProviders: [],
    autoTrack: true,
    transcriptFallbacks: { codex: false, claude: false, kimi: false }
  });
  const result = await refreshDetection({ home, roots, now: 3_000 });
  assert.deepEqual(result.autoEnabledTracking, []);
  assert.equal(result.transcriptFallbacks.kimi, false);
  assert.equal(result.detection.providers.kimi.detected, true);
});

test("auto-track off records detection but starts no tracking", async (context) => {
  const home = await tempDir("tag-refresh-off-");
  const base = await tempDir("tag-refresh-off-roots-");
  context.after(() => Promise.all([
    fs.rm(home, { recursive: true, force: true }),
    fs.rm(base, { recursive: true, force: true })
  ]));
  const roots = await rootsWithPresent(base, ["kimi"]);
  await seed(home, {
    allowedPlatforms: ["kimi"],
    supportedProviders: ["kimi"],
    autoTrack: false,
    transcriptFallbacks: { codex: false, claude: false, kimi: false }
  });
  const result = await refreshDetection({ home, roots, now: 4_000 });
  assert.equal(result.autoTrack, false);
  assert.deepEqual(result.autoEnabledTracking, []);
  assert.equal(result.transcriptFallbacks.kimi, false);
  assert.equal(result.detection.providers.kimi.detected, true);
});

test("refresh-detection --enable-auto-track sets standing consent and persists it", async (context) => {
  const home = await tempDir("tag-refresh-toggle-");
  const base = await tempDir("tag-refresh-toggle-roots-");
  context.after(() => Promise.all([
    fs.rm(home, { recursive: true, force: true }),
    fs.rm(base, { recursive: true, force: true })
  ]));
  const roots = await rootsWithPresent(base, []);
  await seed(home, { autoTrack: false });
  const enabled = await refreshDetection({ home, roots, now: 10, setAutoTrack: true });
  assert.equal(enabled.autoTrack, true);
  assert.equal((await loadRuntime(runtimePaths({ home }))).config.autoTrack, true);
  const disabled = await refreshDetection({ home, roots, now: 20, setAutoTrack: false });
  assert.equal(disabled.autoTrack, false);
  assert.equal((await loadRuntime(runtimePaths({ home }))).config.autoTrack, false);
});

test("detectionWireReport projects a content-free presence list bounded to known providers", () => {
  const checkedAt = new Date(1_000).toISOString();
  const wire = detectionWireReport({
    version: DETECTION_STATE_VERSION,
    providers: {
      kimi: { detected: true, ready: true, reason: "detected", checkedAt },
      gemini: { detected: true, ready: false, reason: "detected_pending_version", versionPin: "2.3.1", checkedAt },
      deepseek: { detected: false, ready: false, reason: "no_local_surface", checkedAt },
      "not-a-provider": { detected: true, ready: true, reason: "detected", checkedAt }
    }
  });
  assert.deepEqual(wire.find((entry) => entry.providerId === "kimi"),
    { providerId: "kimi", detected: true, ready: true, reason: "detected" });
  // Never leaks versionPin, checkedAt, or any non-presence field.
  assert.ok(wire.every((entry) => !("checkedAt" in entry) && !("versionPin" in entry)));
  // Unknown provider ids are dropped.
  assert.ok(!wire.some((entry) => entry.providerId === "not-a-provider"));
});

test("refresh-detection toggles heartbeat detection reporting and persists it", async (context) => {
  const home = await tempDir("tag-report-");
  const base = await tempDir("tag-report-roots-");
  context.after(() => Promise.all([
    fs.rm(home, { recursive: true, force: true }),
    fs.rm(base, { recursive: true, force: true })
  ]));
  const roots = await rootsWithPresent(base, []);
  await seed(home, { reportDetection: false });
  const on = await refreshDetection({ home, roots, now: 10, setReportDetection: true });
  assert.equal(on.reportDetection, true);
  assert.equal((await loadRuntime(runtimePaths({ home }))).config.reportDetection, true);
  const off = await refreshDetection({ home, roots, now: 20, setReportDetection: false });
  assert.equal(off.reportDetection, false);
  assert.equal((await loadRuntime(runtimePaths({ home }))).config.reportDetection, false);
});

test("refresh-detection runs on a brand-new home that does not exist yet", async (context) => {
  const parent = await tempDir("tag-fresh-");
  const base = await tempDir("tag-fresh-roots-");
  context.after(() => Promise.all([
    fs.rm(parent, { recursive: true, force: true }),
    fs.rm(base, { recursive: true, force: true })
  ]));
  const home = path.join(parent, "never-created-home");
  const roots = await rootsWithPresent(base, ["kimi"]);
  const result = await refreshDetection({ home, roots, now: 1 });
  assert.equal(result.probed, true);
  assert.equal(result.detection.providers.kimi.detected, true);
  // The home and its state were created rather than crashing on the lock file.
  assert.equal((await loadRuntime(runtimePaths({ home }))).state.detection.providers.kimi.detected, true);
});

test("applyServerControls applies bounded website consent switches from the heartbeat response", () => {
  const runtime = {
    config: {
      supportedProviders: ["codex", "claude", "kimi", "gemini", "grok", "deepseek"],
      allowedPlatforms: ["codex"],
      autoTrack: false,
      reportDetection: false,
      transcriptFallbacks: { codex: true, claude: false, kimi: false }
    }
  };
  const changed = applyServerControls(runtime, {
    controls: {
      configured: true,
      autoTrack: true,
      reportDetection: true,
      trackedProviders: ["claude", "gemini", "not-a-provider"],
      journalProviders: ["claude", "not-a-provider"]
    }
  });
  assert.equal(changed, true);
  assert.equal(runtime.config.autoTrack, true);
  assert.equal(runtime.config.reportDetection, true);
  // Unknown ids dropped; allowed set mirrors the website's tracked set.
  assert.deepEqual(runtime.config.allowedPlatforms, ["claude", "gemini"]);
  // Journal reads: ON needs explicit website journal consent, OFF needs untrack.
  assert.deepEqual(runtime.config.transcriptFallbacks, { codex: false, claude: true, kimi: false });
});

test("applyServerControls never widens journal consent beyond explicit website choices", () => {
  const runtime = {
    config: {
      supportedProviders: ["codex", "claude", "kimi", "gemini", "grok", "deepseek"],
      allowedPlatforms: ["codex", "claude"],
      autoTrack: true,
      reportDetection: true,
      transcriptFallbacks: { codex: true, claude: false, kimi: false }
    }
  };
  // A legacy account: tracked providers exist (signup selections) but the
  // member never used the website switches (configured false, no journal list).
  const changed = applyServerControls(runtime, {
    controls: {
      configured: false,
      autoTrack: false,
      reportDetection: false,
      trackedProviders: ["codex", "claude"],
      journalProviders: []
    }
  });
  // Local pair-time journal consent (codex) is preserved, claude stays off,
  // and the locally chosen autoTrack/reportDetection are not stomped by the
  // unconfigured defaults.
  assert.equal(changed, false);
  assert.deepEqual(runtime.config.transcriptFallbacks, { codex: true, claude: false, kimi: false });
  assert.equal(runtime.config.autoTrack, true);
  assert.equal(runtime.config.reportDetection, true);
});

test("applyServerControls ignores absent or malformed controls and reports no change", () => {
  const config = {
    supportedProviders: ["codex"],
    allowedPlatforms: ["codex"],
    autoTrack: true,
    reportDetection: false,
    transcriptFallbacks: { codex: true, claude: false, kimi: false }
  };
  const runtime = { config: structuredClone(config) };
  assert.equal(applyServerControls(runtime, {}), false);
  assert.equal(applyServerControls(runtime, { controls: null }), false);
  assert.equal(applyServerControls(runtime, { controls: [] }), false);
  assert.equal(applyServerControls(runtime, { controls: { autoTrack: "yes", trackedProviders: "codex" } }), false);
  assert.deepEqual(runtime.config, config);
  // The Antigravity status-line consent can never be enabled from the server.
  const withGemini = { config: { ...structuredClone(config), antigravityStatuslineConsent: false } };
  applyServerControls(withGemini, { controls: { trackedProviders: ["gemini"] } });
  assert.equal(withGemini.config.antigravityStatuslineConsent, false);
  assert.equal(withGemini.config.transcriptFallbacks.gemini, undefined);
});

test("loadRuntime backfills detection and auto-track for a config that predates them", async (context) => {
  const home = await tempDir("tag-compat-");
  context.after(() => fs.rm(home, { recursive: true, force: true }));
  const paths = runtimePaths({ home });
  await fs.mkdir(home, { recursive: true });
  await fs.writeFile(paths.config, JSON.stringify({
    schemaVersion: 1,
    endpoint: "https://example.invalid",
    allowedPlatforms: ["codex"],
    supportedProviders: ["codex"],
    transcriptFallbacks: { codex: true, claude: false, kimi: false }
  }));
  const { state, config } = await loadRuntime(paths);
  assert.equal(config.autoTrack, false);
  assert.deepEqual(state.detection, { version: DETECTION_STATE_VERSION, providers: {}, lastRefreshedAt: null });
  // Legacy consent is preserved untouched.
  assert.equal(config.transcriptFallbacks.codex, true);
});
