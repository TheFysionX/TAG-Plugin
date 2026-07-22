import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { serialize } from "node:v8";
import {
  decompressRawSnappy,
  extractClaudePlanFromDesktopCache,
  extractClaudePlanFromStructuredClone,
  readClaudePlanEvidence
} from "../src/adapters/claude-plan-evidence.mjs";

const ORG_ID = "01234567-89ab-4cde-8f01-23456789abcd";

function varint(value) {
  const output = [];
  let remaining = value;
  do {
    let byte = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
    if (remaining > 0) byte |= 0x80;
    output.push(byte);
  } while (remaining > 0);
  return Buffer.from(output);
}

function literalSnappy(value) {
  const length = value.length;
  let literalHeader;
  if (length <= 60) literalHeader = Buffer.from([(length - 1) << 2]);
  else if (length <= 256) literalHeader = Buffer.from([60 << 2, length - 1]);
  else literalHeader = Buffer.from([61 << 2, (length - 1) & 0xff, (length - 1) >>> 8]);
  return Buffer.concat([varint(length), literalHeader, value]);
}

function structuredCloneFixture(value) {
  const structuredClone = Buffer.concat([
    Buffer.from([0xff, 0x15, 0xfe, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    serialize(value)
  ]);
  return structuredClone;
}

function claudeDesktopFixture(
  tier = "default_claude_max_20x",
  organizationId = ORG_ID,
  capabilities = ["claude_max"]
) {
  const structuredClone = structuredCloneFixture({
    clientState: {
      queries: [{
        state: {
          data: {
            account: {
              memberships: [{
                organization: {
                  uuid: organizationId,
                  capabilities,
                  rate_limit_tier: tier,
                  billing_type: "stripe_subscription"
                }
              }]
            }
          }
        }
      }]
    }
  });
  return Buffer.concat([Buffer.from([0xff, 0x11, 0x02]), literalSnappy(structuredClone)]);
}

test("raw Snappy decoder handles overlapping backreferences", () => {
  const encoded = Buffer.from([9, 8, 0x61, 0x62, 0x63, 0x16, 3, 0]);
  assert.equal(decompressRawSnappy(encoded).toString("utf8"), "abcabcabc");
});

test("Claude Desktop cache extracts the account rate-limit tier", () => {
  assert.deepEqual(extractClaudePlanFromDesktopCache(claudeDesktopFixture(), { expectedOrgId: ORG_ID }), {
    rawPlanCode: "max-20x",
    rateLimitTier: "default_claude_max_20x"
  });
  assert.deepEqual(extractClaudePlanFromDesktopCache(claudeDesktopFixture("default_claude_max_5x"), { expectedOrgId: ORG_ID }), {
    rawPlanCode: "max-5x",
    rateLimitTier: "default_claude_max_5x"
  });
});

test("conversation text cannot masquerade as Claude account plan evidence", () => {
  const textOnly = structuredCloneFixture({
    clientState: {
      queries: [{ state: { data: { conversation: {
        message: `clientState queries account memberships organization ${ORG_ID} claude_max rate_limit_tier default_claude_max_20x billing_type stripe_subscription`
      } } } }]
    }
  });
  assert.equal(extractClaudePlanFromStructuredClone(textOnly, { expectedOrgId: ORG_ID }), null);

  const wrongOrganization = claudeDesktopFixture("default_claude_max_20x", "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
  assert.equal(extractClaudePlanFromDesktopCache(wrongOrganization, { expectedOrgId: ORG_ID }), null);
});

test("a same-account membership without the Max capability is explicit negative evidence", () => {
  assert.deepEqual(
    extractClaudePlanFromDesktopCache(claudeDesktopFixture(null, ORG_ID, []), { expectedOrgId: ORG_ID }),
    { rawPlanCode: null, maxEntitled: false }
  );
});

test("Claude plan evidence prefers an exact provider process entitlement", async () => {
  const result = await readClaudePlanEvidence({
    env: {
      CLAUDE_CODE_SUBSCRIPTION_TYPE: "max",
      CLAUDE_CODE_RATE_LIMIT_TIER: "default_claude_max_20x",
      CLAUDE_CODE_ORGANIZATION_UUID: ORG_ID
    },
    expectedOrgId: ORG_ID,
    desktopCacheRoots: []
  });
  assert.deepEqual(result, {
    status: "available",
    verification: "provider_backed_claude_process_entitlement",
    subscriptionType: "max",
    rateLimitTier: "default_claude_max_20x",
    rawPlanCode: "max-20x"
  });
});

test("Claude plan evidence reads only a recent bounded Desktop cache file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tag-claude-plan-"));
  try {
    const nested = path.join(root, "1", "2d");
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(nested, "2d32"), claudeDesktopFixture());
    const result = await readClaudePlanEvidence({ env: {}, expectedOrgId: ORG_ID, desktopCacheRoots: [root], now: Date.now() });
    assert.equal(result.status, "available");
    assert.equal(result.rawPlanCode, "max-20x");
    assert.equal(result.rateLimitTier, "default_claude_max_20x");
    assert.equal(result.verification, "provider_backed_claude_desktop_account_cache");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude plan evidence searches past 64 newer cache files within its cumulative byte budget", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tag-claude-plan-many-"));
  try {
    const newest = new Date();
    for (let index = 0; index < 80; index += 1) {
      const file = path.join(root, `cache-${String(index).padStart(3, "0")}`);
      await writeFile(file, Buffer.from([0xff, 0x11, 0x02, 0]));
      await utimes(file, newest, newest);
    }
    const exact = path.join(root, "zz-account");
    await writeFile(exact, claudeDesktopFixture());
    const older = new Date(Date.now() - 60_000);
    await utimes(exact, older, older);
    const result = await readClaudePlanEvidence({ env: {}, expectedOrgId: ORG_ID, desktopCacheRoots: [root], now: Date.now() });
    assert.equal(result.status, "available");
    assert.equal(result.rawPlanCode, "max-20x");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("malformed structured-clone padding is rejected without heuristic scanning", () => {
  const malformed = Buffer.alloc(1024 * 1024, 0);
  assert.equal(extractClaudePlanFromStructuredClone(malformed, { expectedOrgId: ORG_ID }), null);
});
