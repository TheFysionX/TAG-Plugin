export const CONNECTOR_VERSION = "0.1.20";
export const SCHEMA_VERSION = 1;
export const CODEX_ACCOUNTING_VERSION = 5;
export const CLAUDE_ACCOUNTING_VERSION = 5;
export const KIMI_ACCOUNTING_VERSION = 2;
export const ANTIGRAVITY_ACCOUNTING_VERSION = 2;
export const GROK_BUILD_ACCOUNTING_VERSION = 1;
export const AGGREGATE_CURSOR_VERSION = 3;
export const CODEX_SNAPSHOT_STATE_VERSION = 1;
// v2 replays Codex `pro`/`prolite` once because those native PlanType values
// now resolve to exact Pro 20x/5x entitlements instead of legacy placeholders.
export const HEARTBEAT_OBSERVATION_STATE_VERSION = 2;
export const GENESIS_HASH = "0".repeat(64);
export const MAX_LOG_BYTES = 256 * 1024;
export const MAX_CURSOR_FILES = 5_000;
export const MAX_CODEX_LOGICAL_SESSIONS = 50_000;
export const MAX_CLAUDE_SEEN_EVENTS = 250_000;
export const MAX_UNRESOLVED_EVENTS = 2_000;
export const MAX_INGEST_EVENTS = 3;
export const MAX_INGEST_CHECKPOINTS = 2;
export const HISTORY_SETTLE_MINUTES = 15;
// Collection is intentionally independent from the server's scoring horizon.
// Coding-agent journals postdate Unix epoch, so this safely means all retained
// discoverable history without pretending a bounded score window is lifetime.
export const JOURNAL_HISTORY_START = "1970-01-01T00:00:00.000Z";
export const SERVER_MAX_AUTO_SCORED_RETROACTIVE_DAYS = 90;
export const SERVER_MAX_AUTO_SCORED_EVENT_TOKENS = 100_000_000;
export const MAX_SYNC_OUTBOX_EVENTS = 5_000;
export const MAX_MIGRATION_EXCLUSIONS = 20_000;
export const FOREGROUND_MAX_INGEST_REQUESTS = 100;
export const INGEST_CHUNK_PACE_MS = 550;
export const SCHEDULED_MAX_INGEST_REQUESTS = 1_000;
export const HEARTBEAT_EVERY_INGEST_REQUESTS = 50;
export const DEFAULT_LOCK_STALE_MS = 15 * 60 * 1_000;
// Known plan codes remain compact provider slugs. An authenticated provider
// value that is not mapped yet is retained as `unknown:<normalized-value>` so
// the server can add the mapping without collecting any surrounding account
// response. The diagnostic suffix is bounded by the adapter; this wire bound
// is deliberately a little larger than that suffix plus the prefix.
export const MAX_RAW_PLAN_CODE_LENGTH = 80;
export const RAW_PLAN_CODE_PATTERN = /^(?:[a-z0-9]+(?:[_-][a-z0-9]+)*|unknown:[a-z0-9]+(?:[_-][a-z0-9]+)*)$/u;

export const SUPPORTED_ADAPTERS = Object.freeze({
  codex: {
    status: "supported",
    evidence: "Codex rollout JSONL token_count events"
  },
  claude: {
    status: "supported",
    evidence: "Claude Code project JSONL assistant usage records"
  },
  gemini: {
    status: "supported_version_pinned",
    evidence: "Antigravity Desktop 2.3.1 completed-step metadata with retained local-history scanning, plus an optional CLI sanitized status-line fallback"
  },
  kimi: {
    status: "supported",
    evidence: "Kimi Code v0.28 wire usage.record journal entries"
  },
  grok: {
    status: "prospective_partial",
    evidence: "Grok Build local session summaries only; no consumer Grok or billable-token reconstruction"
  }
});
