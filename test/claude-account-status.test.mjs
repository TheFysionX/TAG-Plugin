import test from "node:test";
import assert from "node:assert/strict";
import { readClaudeAccountStatus } from "../src/adapters/claude-account-status.mjs";

const noExactPlanEvidence = async () => ({ status: "unavailable", reason: "test" });
const ORG_ID = "01234567-89ab-4cde-8f01-23456789abcd";

test("Claude auth status retains only classified plan status", async () => {
  const result = await readClaudeAccountStatus({
    readPlanEvidence: noExactPlanEvidence,
    executable: "claude-test",
    platform: "linux",
    execFileImpl: (executable, arguments_, options, callback) => {
      assert.equal(executable, "claude-test");
      assert.deepEqual(arguments_, ["auth", "status", "--json"]);
      assert.equal(options.windowsHide, true);
      callback(null, JSON.stringify({
        loggedIn: true,
        authMethod: "claude.ai",
        apiProvider: "anthropic",
        subscriptionType: "max",
        email: "private@example.test",
        orgId: ORG_ID,
        organizationName: "Private organization",
        accessToken: "secret"
      }), "");
    }
  });
  assert.deepEqual(result, {
    status: "available",
    verification: "provider_backed_claude_auth_status",
    loggedIn: true,
    authMethod: "claude_ai",
    apiProvider: "anthropic",
    subscriptionType: "max"
  });
});

test("Claude auth status accepts only the official firstParty signed-in provider value", async () => {
  const result = await readClaudeAccountStatus({
    readPlanEvidence: noExactPlanEvidence,
    platform: "linux",
    execFileImpl: (_executable, _arguments, _options, callback) => callback(null, JSON.stringify({
      loggedIn: true,
      authMethod: "claude.ai",
      apiProvider: "firstParty",
      subscriptionType: "pro",
      orgId: ORG_ID
    }), "")
  });
  assert.deepEqual(result, {
    status: "available",
    verification: "provider_backed_claude_auth_status",
    loggedIn: true,
    authMethod: "claude_ai",
    apiProvider: "first_party",
    subscriptionType: "pro"
  });

  const lookalike = await readClaudeAccountStatus({
    readPlanEvidence: noExactPlanEvidence,
    platform: "linux",
    execFileImpl: (_executable, _arguments, _options, callback) => callback(null, JSON.stringify({
      loggedIn: true,
      authMethod: "claude.ai",
      apiProvider: "first-party",
      subscriptionType: "pro",
      orgId: ORG_ID
    }), "")
  });
  assert.equal(lookalike.apiProvider, null);
});

test("Claude auth status rejects unclassified fields and command failures safely", async () => {
  const sanitized = await readClaudeAccountStatus({
    readPlanEvidence: noExactPlanEvidence,
    platform: "linux",
    execFileImpl: (_executable, _arguments, _options, callback) => callback(null, JSON.stringify({
      loggedIn: false,
      authMethod: "session-cookie",
      apiProvider: "internal-route",
      subscriptionType: "partner-secret"
    }), "")
  });
  assert.deepEqual(sanitized, {
    status: "available",
    verification: "provider_backed_claude_auth_status",
    loggedIn: false,
    authMethod: null,
    apiProvider: null,
    subscriptionType: null
  });
  const timeout = await readClaudeAccountStatus({
    readPlanEvidence: noExactPlanEvidence,
    platform: "linux",
    execFileImpl: (_executable, _arguments, _options, callback) => callback({ killed: true }, "", "")
  });
  assert.deepEqual(timeout, { status: "unavailable", reason: "timeout" });
});

test("Claude cache evidence cannot fabricate a login after auth status fails", async () => {
  let planRead = false;
  const result = await readClaudeAccountStatus({
    platform: "linux",
    execFileImpl: (_executable, _arguments, _options, callback) => callback(new Error("logged out"), "", ""),
    readPlanEvidence: async () => {
      planRead = true;
      return { status: "available", rawPlanCode: "max-20x" };
    }
  });
  assert.deepEqual(result, { status: "unavailable", reason: "command_failed" });
  assert.equal(planRead, false);
});

test("Claude auth status uses the standard npm cmd shim on Windows", async () => {
  const result = await readClaudeAccountStatus({
    readPlanEvidence: noExactPlanEvidence,
    platform: "win32",
    executable: "claude",
    comSpec: "C:\\Windows\\System32\\cmd.exe",
    execFileImpl: (executable, arguments_, options, callback) => {
      assert.equal(executable, "C:\\Windows\\System32\\cmd.exe");
      assert.deepEqual(arguments_, ["/d", "/c", "claude.cmd auth status --json"]);
      assert.equal(options.windowsHide, true);
      callback(null, JSON.stringify({
        loggedIn: true,
        authMethod: "claude.ai",
        apiProvider: "firstParty",
        subscriptionType: "max",
        orgId: ORG_ID
      }), "");
    }
  });
  assert.equal(result.status, "available");
  assert.equal(result.subscriptionType, "max");
});

test("Claude auth status fails closed for unsafe Windows executable overrides", async () => {
  let invoked = false;
  const result = await readClaudeAccountStatus({
    readPlanEvidence: noExactPlanEvidence,
    platform: "win32",
    executable: "claude.cmd & whoami",
    execFileImpl: () => {
      invoked = true;
    }
  });
  assert.deepEqual(result, { status: "unavailable", reason: "unsafe_executable" });
  assert.equal(invoked, false);
});

test("exact Claude Max 20x evidence overrides a coarse Pro auth status", async () => {
  const result = await readClaudeAccountStatus({
    platform: "linux",
    execFileImpl: (_executable, _arguments, _options, callback) => callback(null, JSON.stringify({
      loggedIn: true,
      authMethod: "claude.ai",
      apiProvider: "firstParty",
      subscriptionType: "pro",
      orgId: ORG_ID
    }), ""),
    readPlanEvidence: async (options) => {
      assert.equal(options.expectedOrgId, ORG_ID);
      return {
        status: "available",
        verification: "provider_backed_claude_desktop_account_cache",
        subscriptionType: "max",
        rateLimitTier: "default_claude_max_20x",
        rawPlanCode: "max-20x",
        cacheUpdatedAt: "2026-07-20T07:02:21.683Z"
      };
    }
  });
  assert.deepEqual(result, {
    status: "available",
    verification: "provider_backed_claude_desktop_account_cache",
    loggedIn: true,
    authMethod: "claude_ai",
    apiProvider: "first_party",
    subscriptionType: "max",
    rateLimitTier: "default_claude_max_20x",
    rawPlanCode: "max-20x",
    cacheUpdatedAt: "2026-07-20T07:02:21.683Z"
  });
});

test("same-account negative cache evidence confirms a real non-Max plan", async () => {
  const result = await readClaudeAccountStatus({
    includeLocalAccountIdentity: true,
    platform: "linux",
    execFileImpl: (_executable, _arguments, _options, callback) => callback(null, JSON.stringify({
      loggedIn: true,
      authMethod: "claude.ai",
      apiProvider: "firstParty",
      subscriptionType: "pro",
      orgId: ORG_ID
    }), ""),
    readPlanEvidence: async () => ({
      status: "available",
      verification: "provider_backed_claude_desktop_account_cache",
      maxEntitled: false,
      rawPlanCode: null,
      cacheUpdatedAt: "2026-07-22T07:02:21.683Z"
    })
  });
  assert.deepEqual(result, {
    status: "available",
    verification: "provider_backed_claude_desktop_account_cache",
    loggedIn: true,
    authMethod: "claude_ai",
    apiProvider: "first_party",
    subscriptionType: "pro",
    rawPlanCode: "pro",
    cacheUpdatedAt: "2026-07-22T07:02:21.683Z",
    organizationId: ORG_ID
  });
});
