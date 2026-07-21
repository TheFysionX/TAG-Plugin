import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseKimiWire } from "../src/adapters/kimi-wire.mjs";
import { collectUsage } from "../src/collector.mjs";
import { sha256 } from "../src/crypto.mjs";

const localAliasKey = Buffer.alloc(32, 7).toString("base64");
const firstDedupNamespaceKey = Buffer.alloc(32, 9).toString("base64url");
const secondDedupNamespaceKey = Buffer.alloc(32, 10).toString("base64url");

function freshState() {
  return {
    cursors: {
      codex: { files: {} },
      claude: { seen: {} },
      kimi: { files: {} },
      aggregate: {
        version: 2,
        providers: {
          codex: { through: null },
          claude: { through: null },
          kimi: { through: null }
        }
      }
    }
  };
}

function usageRecord(recordId, time, multiplier) {
  return {
    type: "usage.record",
    recordId,
    time,
    model: "kimi-code/kimi-for-coding-highspeed",
    usage: {
      inputOther: 10 * multiplier,
      inputCacheRead: 2 * multiplier,
      inputCacheCreation: 3 * multiplier,
      output: 5 * multiplier
    },
    usageScope: "turn"
  };
}

test("aggregate v3 identity is stable across partial replay and resolver drift but isolated by account", async (context) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "tag-plugin-aggregate-v3-id-test-"));
  context.after(() => fs.rm(temporary, { recursive: true, force: true }));

  const roots = {
    codex: path.join(temporary, "codex"),
    claude: path.join(temporary, "claude"),
    kimi: path.join(temporary, "kimi")
  };
  const journalDirectory = path.join(roots.kimi, "session-alpha", "agents", "main");
  const journalPath = path.join(journalDirectory, "wire.jsonl");
  await fs.mkdir(journalDirectory, { recursive: true });

  const sourceA = usageRecord("source-a", "2026-07-19T10:05:00.000Z", 1);
  const sourceB = usageRecord("source-b", "2026-07-19T10:10:00.000Z", 2);
  const sourceC = usageRecord("source-c", "2026-07-19T10:20:00.000Z", 3);
  const range = {
    kimi: {
      start: "2026-07-19T10:00:00.000Z",
      end: "2026-07-19T11:00:00.000Z"
    }
  };

  async function collect(records, {
    dedupNamespaceKey = firstDedupNamespaceKey,
    resolvedModel = "kimi-k2.7-code"
  } = {}) {
    await fs.writeFile(journalPath, records.map(JSON.stringify).join("\n") + "\n", "utf8");
    return collectUsage({
      roots,
      state: freshState(),
      secrets: { localAliasKey },
      dedupNamespaceKey,
      enabledFallbacks: { codex: false, claude: false, kimi: true },
      officialEvidence: false,
      aggregateRanges: range,
      canonicalModelId: () => resolvedModel,
      now: Date.parse("2026-07-19T12:00:00.000Z")
    });
  }

  const baseline = await collect([sourceA, sourceB]);
  const partialReplay = await collect([sourceA, sourceB, sourceC]);
  const resolverDrift = await collect([sourceA, sourceB], {
    resolvedModel: "kimi-k2.7-code-next"
  });
  const otherAccount = await collect([sourceA, sourceB], {
    dedupNamespaceKey: secondDedupNamespaceKey
  });

  assert.equal(baseline.events.length, 1);
  assert.equal(partialReplay.events.length, 1);
  assert.equal(resolverDrift.events.length, 1);
  assert.equal(otherAccount.events.length, 1);

  const [baselineAggregate] = baseline.events;
  const [partialReplayAggregate] = partialReplay.events;
  const [resolverDriftAggregate] = resolverDrift.events;
  const [otherAccountAggregate] = otherAccount.events;

  assert.equal(baselineAggregate.provenance.collector, "session_hour_usage_aggregate_v3");
  assert.equal(baselineAggregate.usage.total, 60);
  assert.equal(partialReplayAggregate.usage.total, 120);
  assert.equal(partialReplayAggregate.eventId, baselineAggregate.eventId);

  assert.equal(resolverDriftAggregate.modelId, "kimi-k2.7-code-next");
  assert.equal(resolverDriftAggregate.usage.total, baselineAggregate.usage.total);
  assert.equal(resolverDriftAggregate.eventId, baselineAggregate.eventId);

  assert.notEqual(otherAccountAggregate.eventId, baselineAggregate.eventId);

  await fs.writeFile(journalPath, [sourceA, sourceB].map(JSON.stringify).join("\n") + "\n", "utf8");
  const stableJournalIdentity = sha256("kimi-session-agent\0session-alpha\0main");
  const parsed = await parseKimiWire(journalPath, {
    stableJournalIdentity,
    dedupNamespaceKey: firstDedupNamespaceKey
  });
  assert.equal(parsed.events.length, 2);
  assert.ok(parsed.events.every((event) => event.aggregationScope === stableJournalIdentity));
  assert.ok(parsed.events.every((event) => (
    event.aggregationModeToken === sha256("kimi-raw-mode\0highspeed")
  )));
});
