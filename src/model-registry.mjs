const KNOWN_MODELS = new Set([
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex",
  "gpt-5.2",
  "claude-fable-5",
  "claude-opus-4.8",
  "claude-opus-4.7",
  "claude-opus-4.6",
  "claude-sonnet-5",
  "claude-sonnet-4.6",
  "claude-sonnet-4.5",
  "claude-haiku-4.5",
  "kimi-k2.7-code"
]);

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

export function isKnownModel(modelId) {
  return KNOWN_MODELS.has(modelId);
}
