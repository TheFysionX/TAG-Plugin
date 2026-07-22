import test from "node:test";
import assert from "node:assert/strict";
import { readClaudeAccountStatus } from "../src/adapters/claude-account-status.mjs";

test("Claude auth status retains only classified plan status", async () => {
  const result = await readClaudeAccountStatus({
    executable: "claude-test",
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
        organizationId: "org_private",
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
    execFileImpl: (_executable, _arguments, _options, callback) => callback(null, JSON.stringify({
      loggedIn: true,
      authMethod: "claude.ai",
      apiProvider: "firstParty",
      subscriptionType: "pro"
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
    execFileImpl: (_executable, _arguments, _options, callback) => callback(null, JSON.stringify({
      loggedIn: true,
      authMethod: "claude.ai",
      apiProvider: "first-party",
      subscriptionType: "pro"
    }), "")
  });
  assert.equal(lookalike.apiProvider, null);
});

test("Claude auth status rejects unclassified fields and command failures safely", async () => {
  const sanitized = await readClaudeAccountStatus({
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
    execFileImpl: (_executable, _arguments, _options, callback) => callback({ killed: true }, "", "")
  });
  assert.deepEqual(timeout, { status: "unavailable", reason: "timeout" });
});
