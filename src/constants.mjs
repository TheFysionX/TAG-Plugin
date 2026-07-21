export const CONNECTOR_VERSION = "0.1.2";
export const SCHEMA_VERSION = 1;
export const GENESIS_HASH = "0".repeat(64);
export const MAX_LOG_BYTES = 256 * 1024;
export const MAX_CURSOR_FILES = 5_000;
export const MAX_CLAUDE_SEEN_EVENTS = 250_000;
export const MAX_UNRESOLVED_EVENTS = 2_000;
export const MAX_INGEST_EVENTS = 3;
export const MAX_INGEST_CHECKPOINTS = 2;
export const HISTORY_SETTLE_MINUTES = 15;
// The ingest service quarantines events older than 90 days. Keep the connector's
// initial import one full day inside that boundary so clock skew cannot turn a
// useful first sync into guaranteed quarantine work.
export const SERVER_MAX_AUTO_SCORED_RETROACTIVE_DAYS = 90;
export const INITIAL_HISTORY_DAYS = SERVER_MAX_AUTO_SCORED_RETROACTIVE_DAYS - 1;
export const SERVER_MAX_AUTO_SCORED_EVENT_TOKENS = 100_000_000;
export const MAX_SYNC_OUTBOX_EVENTS = 5_000;
export const MAX_MIGRATION_EXCLUSIONS = 20_000;
export const FOREGROUND_MAX_INGEST_REQUESTS = 100;
export const INGEST_CHUNK_PACE_MS = 550;
export const SCHEDULED_MAX_INGEST_REQUESTS = 1_000;
export const HEARTBEAT_EVERY_INGEST_REQUESTS = 50;
export const DEFAULT_LOCK_STALE_MS = 15 * 60 * 1_000;

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
    status: "pending_verified_adapter",
    evidence: null
  },
  kimi: {
    status: "supported",
    evidence: "Kimi Code v0.28 wire usage.record journal entries"
  },
  grok: {
    status: "pending_verified_adapter",
    evidence: null
  }
});
