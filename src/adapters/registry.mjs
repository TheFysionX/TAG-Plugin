import { SUPPORTED_ADAPTERS } from "../constants.mjs";

export function adapterStatus() {
  return {
    codex: {
      ...SUPPORTED_ADAPTERS.codex,
      preference: [
        "provider_backed_app_server_usage_when_verified",
        "codex_rollout_jsonl_fallback"
      ],
      active: "codex_rollout_jsonl_fallback"
    },
    claude: {
      ...SUPPORTED_ADAPTERS.claude,
      preference: ["provider_backed_usage_when_available", "claude_project_jsonl_fallback"],
      active: "claude_project_jsonl_fallback"
    },
    gemini: {
      ...SUPPORTED_ADAPTERS.gemini,
      preference: ["official_otel_usage_when_schema_verified"],
      active: null
    },
    kimi: {
      ...SUPPORTED_ADAPTERS.kimi,
      preference: ["content_free_provider_usage_when_available", "kimi_v0_28_wire_usage_record_fallback"],
      active: "kimi_v0_28_wire_usage_record_fallback",
      requiresExplicitOptIn: true
    },
    grok: {
      ...SUPPORTED_ADAPTERS.grok,
      preference: ["provider_backed_usage_when_available"],
      active: null
    }
  };
}
