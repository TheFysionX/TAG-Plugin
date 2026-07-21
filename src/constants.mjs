export const CONNECTOR_VERSION = "0.1.1";
export const SCHEMA_VERSION = 1;
export const GENESIS_HASH = "0".repeat(64);
export const MAX_LOG_BYTES = 256 * 1024;
export const MAX_CURSOR_FILES = 5_000;
export const MAX_CLAUDE_SEEN_EVENTS = 20_000;
export const MAX_UNRESOLVED_EVENTS = 2_000;
export const MAX_INGEST_EVENTS = 3;
export const MAX_INGEST_CHECKPOINTS = 2;
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
