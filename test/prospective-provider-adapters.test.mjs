import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sanitizeAntigravityStatusline, parseAntigravityStatuslineLog } from "../src/adapters/antigravity-statusline.mjs";
import { discoverGrokSignalFiles, parseGrokBuildSession } from "../src/adapters/grok-build-sessions.mjs";

const aliasKey = Buffer.alloc(32, 4).toString("base64");
const dedupNamespaceKey = Buffer.alloc(32, 8).toString("base64url");

test("Antigravity status-line capture strips identity, paths, and message-bearing fields", async (context) => {
  const rawConversationId = "conversation-secret-123";
  const capture = sanitizeAntigravityStatusline({
    conversation_id: rawConversationId,
    email: "person@example.com",
    cwd: "C:\\Users\\person\\private-repo",
    workspace: { name: "private-repo", path: "C:\\private" },
    messages: [{ content: "never export this prompt" }],
    model: { id: "gemini-3-pro" },
    plan_tier: "Ultra",
    execution_mode: "fast",
    context_window: {
      current_usage: { input_tokens: 120, cache_read_input_tokens: 20, output_tokens: 30 }
    },
    quota: { weekly: { reset_time: "2026-07-28T00:00:00.000Z", remaining_fraction: 0.2 } }
  }, { localAliasKey: aliasKey, observedAt: "2026-07-21T10:00:00.000Z" });
  assert.ok(capture);
  assert.equal(capture.planTier, "ultra");
  assert.equal(capture.executionMode, "fast");
  assert.deepEqual(capture.usage, { input: 120, cachedInput: 20, cacheWriteInput: 0, output: 30, reasoningOutput: 0, total: 170 });
  const serialized = JSON.stringify(capture);
  assert.doesNotMatch(serialized, /person@example\.com|private-repo|conversation-secret|never export|C:\\Users/i);

  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "tag-antigravity-capture-"));
  context.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const capturePath = path.join(temporary, "tag-plugin-statusline.jsonl");
  await fs.writeFile(capturePath, JSON.stringify(capture) + "\n", "utf8");
  const parsed = await parseAntigravityStatuslineLog(capturePath, { dedupNamespaceKey });
  assert.equal(parsed.status, "available_prospective");
  assert.equal(parsed.events.length, 1);
  assert.equal(parsed.events[0].provider, "gemini");
  assert.equal(parsed.events[0].serviceProviderId, "gemini");
  assert.equal(parsed.events[0].provenance.surface, "antigravity");
  assert.equal(parsed.events[0].mode.fast, true);
  assert.equal(parsed.planObservations[0].rawPlanCode, "ultra");
  assert.equal(parsed.resetObservations[0].resetAtAfter, "2026-07-28T00:00:00.000Z");
  assert.doesNotMatch(JSON.stringify(parsed), /person@example\.com|private-repo|conversation-secret|never export/i);
});

test("Antigravity rejects raw status-line payloads and zero-token captures", async (context) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "tag-antigravity-reject-"));
  context.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const capturePath = path.join(temporary, "capture.jsonl");
  await fs.writeFile(capturePath, [
    JSON.stringify({ conversation_id: "raw-id", email: "must-not-be-read@example.com", model: { id: "gemini" } }),
    JSON.stringify({ kind: "tag.antigravity.statusline.v1", observedAt: "2026-07-21T10:00:00Z", sessionAlias: "a".repeat(64), sourceModelId: "gemini", usage: { input: 0 } })
  ].join("\n") + "\n", "utf8");
  const parsed = await parseAntigravityStatuslineLog(capturePath, { dedupNamespaceKey });
  assert.equal(parsed.events.length, 0);
  assert.equal(parsed.malformed, 2);
  assert.doesNotMatch(JSON.stringify(parsed), /must-not-be-read|raw-id/i);
});

test("Grok Build signals are local session diagnostics, never accounting events", async (context) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "tag-grok-signals-"));
  context.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const sessionPath = path.join(temporary, "encoded-private-cwd", "session-private-id");
  await fs.mkdir(sessionPath, { recursive: true });
  const signalsPath = path.join(sessionPath, "signals.json");
  await fs.writeFile(signalsPath, JSON.stringify({
    turnCount: 3,
    contextTokensUsed: 2968,
    contextWindowTokens: 512000,
    totalTokensBeforeCompaction: 4500,
    modelsUsed: ["grok-build"],
    primaryModelId: "grok-build",
    email: "must-not-escape@example.com",
    cwd: "C:\\secret"
  }), "utf8");
  await fs.writeFile(path.join(sessionPath, "summary.json"), JSON.stringify({
    modelId: "grok-build-fast",
    timestamp: "2026-07-21T10:00:00Z",
    transcript: "do not export"
  }), "utf8");
  const discovered = await discoverGrokSignalFiles(temporary);
  assert.deepEqual(discovered.files, [signalsPath]);
  const parsed = await parseGrokBuildSession(signalsPath, { localAliasKey: aliasKey });
  assert.equal(parsed.status, "available_prospective_partial");
  assert.equal(parsed.reason, "session_summary_not_token_ledger");
  assert.equal(parsed.session.primaryModelId, "grok-build-fast");
  assert.equal(parsed.session.summaryTokens, 7468);
  assert.doesNotMatch(JSON.stringify(parsed), /must-not-escape|secret|private-id|do not export/i);
});
