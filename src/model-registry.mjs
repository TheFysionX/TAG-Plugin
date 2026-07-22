const MODEL_PROVIDERS = new Map(Object.entries({
  "gpt-5.6-sol": "codex",
  "gpt-5.6-terra": "codex",
  "gpt-5.6-luna": "codex",
  "gpt-5.5": "codex",
  "gpt-5.4": "codex",
  "gpt-5.4-mini": "codex",
  "gpt-5.3-codex": "codex",
  "gpt-5.2": "codex",
  "claude-fable-5": "claude",
  "claude-opus-4.8": "claude",
  "claude-opus-4.7": "claude",
  "claude-opus-4.6": "claude",
  "claude-sonnet-5": "claude",
  "claude-sonnet-4.6": "claude",
  "claude-sonnet-4.5": "claude",
  "claude-haiku-4.5": "claude",
  "gemini-3.5-flash": "gemini",
  "gemini-3.1-pro-preview": "gemini",
  "gemini-3.1-flash-lite": "gemini",
  "gemini-3-flash-preview": "gemini",
  "gemini-2.5-pro": "gemini",
  "gemini-2.5-flash": "gemini",
  "gemini-2.5-flash-lite": "gemini",
  "grok-4.5": "grok",
  "grok-build-0.1": "grok",
  "grok-4.3": "grok",
  "grok-4.20-reasoning": "grok",
  "grok-4.20-non-reasoning": "grok",
  "grok-4.20-multi-agent": "grok",
  "kimi-k3": "kimi",
  "kimi-k2.7-code": "kimi",
  "kimi-k2.6": "kimi",
  "kimi-k2.5": "kimi",
  "deepseek-v4-flash": "deepseek",
  "deepseek-v4-pro": "deepseek"
}));

const KNOWN_MODELS = new Set(MODEL_PROVIDERS.keys());

const CLAUDE_ALIASES = [
  [/^claude-sonnet-5(?:[-@]\d{8})?$/, "claude-sonnet-5"],
  [/^claude-fable-5(?:[-@]\d{8})?$/, "claude-fable-5"],
  [/^claude-opus-4[-.]8(?:[-@]\d{8})?$/, "claude-opus-4.8"],
  [/^claude-opus-4[-.]7(?:[-@]\d{8})?$/, "claude-opus-4.7"],
  [/^claude-opus-4[-.]6(?:[-@]\d{8})?$/, "claude-opus-4.6"],
  [/^claude-sonnet-4[-.]6(?:[-@]\d{8})?$/, "claude-sonnet-4.6"],
  [/^claude-sonnet-4[-.]5(?:[-@]\d{8})?$/, "claude-sonnet-4.5"],
  [/^claude-haiku-4[-.]5(?:[-@]\d{8})?$/, "claude-haiku-4.5"]
];

export function canonicalModelId(provider, sourceModelId) {
  const normalized = typeof sourceModelId === "string" ? sourceModelId.trim().toLowerCase() : "";
  if (KNOWN_MODELS.has(normalized)) {
    return normalized;
  }
  if (provider === "claude") {
    for (const [pattern, canonical] of CLAUDE_ALIASES) {
      if (pattern.test(normalized)) {
        return canonical;
      }
    }
  }
  if (provider === "kimi") {
    if (normalized === "kimi-code/kimi-for-coding-highspeed" || normalized === "kimi-code/kimi-for-coding") {
      return "kimi-k2.7-code";
    }
  }
  return null;
}

export function providerForModelId(modelId) {
  return MODEL_PROVIDERS.get(modelId) || null;
}

export function isKnownModel(modelId) {
  return KNOWN_MODELS.has(modelId);
}
