import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("package and install manifest remain dependency-free", async () => {
  const packageJson = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  const manifest = JSON.parse(await fs.readFile(path.join(root, "install-manifest.json"), "utf8"));
  assert.equal(packageJson.name, "@the-artificial-games/tag-plugin");
  assert.deepEqual(packageJson.bin, { "tag-plugin": "./src/cli.mjs" });
  assert.equal(packageJson.author, "The Artificial Games");
  assert.equal(packageJson.repository.url, "git+https://github.com/TheFysionX/TAG-Plugin.git");
  assert.equal(packageJson.homepage, "https://github.com/TheFysionX/TAG-Plugin#readme");
  assert.deepEqual(packageJson.dependencies || {}, {});
  assert.deepEqual(packageJson.devDependencies || {}, {});
  assert.equal(packageJson.files.includes("test"), true);
  assert.equal(packageJson.files.includes("scripts"), true);
  assert.equal(packageJson.files.includes("RELEASING.md"), true);
  assert.equal(packageJson.files.includes(".github/workflows/release.yml"), true);
  assert.equal(manifest.releaseArtifact.includesSyntheticTestSuite, true);
  assert.equal(manifest.product.name, "TAG Plugin");
  assert.equal(manifest.product.publisher, "The Artificial Games");
  assert.equal(manifest.product.repository, "https://github.com/TheFysionX/TAG-Plugin");
  assert.equal(manifest.releaseArtifact.archiveName, "tag-plugin-0.1.15.tgz");
  assert.match(manifest.releaseArtifact.releaseContract, /@the-artificial-games\/tag-plugin/);
  assert.equal(manifest.releaseArtifact.testCommand, "npm test");
  assert.deepEqual(
    (await fs.readdir(path.join(root, "test", "fixtures"))).sort(),
    ["claude-project.jsonl", "codex-lineage-copies.json", "codex-rollout.jsonl", "kimi-wire.jsonl"]
  );
  assert.deepEqual(manifest.runtime.thirdPartyDependencies, []);
  assert.equal(manifest.updates.updaterProtocol, 1);
  assert.equal(manifest.updates.runtimeStateSchema, 1);
  assert.match(manifest.updates.activation, /immutable versions.*atomic active-release\.json/is);
  assert.match(manifest.updates.failurePolicy, /never rolls back or invalidates.*heartbeat/is);
  assert.equal(manifest.scheduler.elevation, false);
  assert.match(manifest.scheduler.command, /launcher\.mjs scheduled-run --home/);
  assert.match(manifest.localState.syncRecovery, /3 events or 2 checkpoints/);
  assert.match(manifest.localState.syncRecovery, /1000 ingest requests.*heartbeat every 50/i);
  assert.match(manifest.localState.syncRecovery, /daily_delta.*commit marker.*generation.*digest.*delta count/i);
  assert.match(manifest.localState.unresolvedModels, /raw-only.*without a local queue/i);
  assert.match(manifest.network.rawOnlyCommit, /rawPreserved true.*source cursor/i);
  assert.match(manifest.network.eventCommitAcknowledgement, /submittedRevisionActive true.*submittedObservationCanonical true.*fails closed/i);
  assert.match(manifest.localState.eventIdentity, /content-independent source identity/i);
  assert.match(manifest.localState.operationLock, /owner token.*lease renewed.*live-PID/i);
  assert.match(manifest.localState.atomicWriteRecovery, /EEXIST or EPERM.*five times.*without unlinking.*15-minute.*overlap lock.*committed counterpart.*sole recovery copy.*non-recursive.*bounded/i);
  assert.match(manifest.scheduler.postInstall, /immediate allowlisted usage sync and signed heartbeat/i);
  assert.deepEqual(manifest.scheduler.identifiers, {
    windowsTask: "TAG Plugin",
    macOSLaunchAgent: "com.theartificialgames.tag-plugin",
    linuxTimer: "tag-plugin.timer"
  });
  assert.match(manifest.localState.cursorReplacementDetection, /rolling prefix digest.*allowlisted/i);
  assert.match(manifest.localState.claudePlanEvidence, /512 candidate files.*8 MiB.*14 days.*64 MiB.*declared-decompressed.*32 MiB.*fails closed/i);
  const claudeDesktopRead = manifest.localReads.find((entry) => entry.surface === "Claude Desktop account-bootstrap IndexedDB cache");
  assert.equal(claudeDesktopRead?.sensitiveLocalStore, true);
  assert.equal(claudeDesktopRead?.outboundContentFree, true);
  assert.match(manifest.permissions.windowsSecretAcl, /before pairing traffic.*before pairing commit/i);
  assert.equal(manifest.releaseArtifact.installedEntries.includes("RELEASING.md"), true);
  const onePrompt = await fs.readFile(path.join(root, "ONE_PROMPT_INSTALL.md"), "utf8");
  assert.match(onePrompt, /<ARCHIVE_SHA256>/);
  assert.match(onePrompt, /https:\/\/github\.com\/TheFysionX\/TAG-Plugin/);
  assert.match(onePrompt, /<ARTIFICIAL_GAMES_HTTPS_ORIGIN>/);
  assert.match(onePrompt, /provider may receive and retain/i);
  const security = await fs.readFile(path.join(root, "SECURITY.md"), "utf8");
  assert.doesNotMatch(security, /100 events|32 checkpoints|eligible mixed batches/i);
  assert.doesNotMatch(security, /heartbeat follows completed catch-up|heartbeat is deliberately deferred/i);
  assert.match(security, /first owner session identity plus lineage epoch and cumulative endpoint/i);
  assert.match(security, /raw-only/i);
  assert.match(security, /v0\.1\.6-to-v0\.1\.7 bridge.*all-zero genesis parent/i);
  const threatModel = await fs.readFile(path.join(root, "THREAT_MODEL.md"), "utf8");
  assert.match(threatModel, /provider receives and may retain the short-lived credential/i);
  assert.match(threatModel, /connector-reported evidence/i);
  assert.doesNotMatch(threatModel, /connector-attested|recommended direct-terminal/i);
});

test("every GitHub Action reference is pinned to a full commit SHA", async () => {
  const workflow = await fs.readFile(path.join(root, ".github", "workflows", "release.yml"), "utf8");
  const references = [...workflow.matchAll(/uses:\s*[^@\s]+@([^\s]+)/g)].map((match) => match[1]);
  assert.ok(references.length > 0);
  assert.equal(references.every((reference) => /^[a-f0-9]{40}$/.test(reference)), true);
  assert.doesNotMatch(workflow, /softprops|Build deterministic/i);
});
