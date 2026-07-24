// Single source of truth for provider identity, local-detection, consent, and
// reporting metadata. Adding a new provider's DETECTION + CONSENT + REPORTING is
// a descriptor entry here — the probe, the config consent map, the state
// normalizer, and the status report all derive from this list instead of
// hardcoding provider names. Ingestion still supplies a parser/adapter wired in
// collector.mjs; this registry deliberately does not couple to that pipeline so
// a descriptor stays cheap to add.
//
// Field meaning:
//   id                 stable provider key used across config/state/wire.
//   serviceProviderId  authorized coding service that hosts the usage.
//   surface            wire surface label for events from this provider.
//   detectRootKey      key into providerRoots() whose directory presence proves
//                      the client is installed locally. null when the provider
//                      has no local surface (e.g. a pure API).
//   trackingClass      journal    -> reads a sensitive local journal (opt-in);
//                      metadata   -> reads only content-free local metadata;
//                      informational -> local diagnostics, never token accounting;
//                      api        -> no local surface, host/API evidence only.
//   sensitiveJournal   whether tracking opens content-bearing files.
//   requiresExplicitOptIn  tracking never starts without explicit consent.
//   versionPin         when set, the provider is only ready to auto-track after
//                      a pinned-version check passes at collection time.
//   verifiedVersion    client version the current adapter was validated against.
export const PROVIDER_DESCRIPTORS = Object.freeze([
  Object.freeze({
    id: "codex",
    serviceProviderId: "codex",
    displayName: "Codex",
    surface: "codex",
    detectRootKey: "codex",
    trackingClass: "journal",
    sensitiveJournal: true,
    requiresExplicitOptIn: true,
    versionPin: null
  }),
  Object.freeze({
    id: "claude",
    serviceProviderId: "claude",
    displayName: "Claude Code",
    surface: "claude_code",
    detectRootKey: "claude",
    trackingClass: "journal",
    sensitiveJournal: true,
    requiresExplicitOptIn: true,
    versionPin: null
  }),
  Object.freeze({
    id: "kimi",
    serviceProviderId: "kimi",
    displayName: "Kimi Code",
    surface: "kimi_code",
    detectRootKey: "kimi",
    trackingClass: "journal",
    sensitiveJournal: true,
    requiresExplicitOptIn: true,
    versionPin: null,
    verifiedVersion: "0.28"
  }),
  Object.freeze({
    id: "gemini",
    serviceProviderId: "gemini",
    displayName: "Antigravity (Gemini)",
    surface: "antigravity",
    detectRootKey: "antigravityDesktop",
    trackingClass: "metadata",
    sensitiveJournal: false,
    requiresExplicitOptIn: true,
    versionPin: "2.3.1",
    verifiedVersion: "2.3.1"
  }),
  Object.freeze({
    id: "grok",
    serviceProviderId: "grok",
    displayName: "Grok Build",
    surface: "grok_build",
    detectRootKey: "grok",
    trackingClass: "informational",
    sensitiveJournal: false,
    requiresExplicitOptIn: true,
    versionPin: null
  }),
  Object.freeze({
    id: "deepseek",
    serviceProviderId: "deepseek",
    displayName: "DeepSeek",
    surface: "deepseek_api",
    // No local coding app writes a DeepSeek journal; usage is only ever observed
    // as host/API evidence, so there is nothing to detect on disk.
    detectRootKey: null,
    trackingClass: "api",
    sensitiveJournal: false,
    requiresExplicitOptIn: true,
    versionPin: null
  })
]);

const DESCRIPTOR_BY_ID = new Map(PROVIDER_DESCRIPTORS.map((descriptor) => [descriptor.id, descriptor]));

export const PROVIDER_IDS = Object.freeze(PROVIDER_DESCRIPTORS.map((descriptor) => descriptor.id));

// Providers whose consent flag lives in config.transcriptFallbacks and predates
// this registry. They are always materialized in the consent map for backward
// compatibility; every other provider id stays an optional key.
export const ALWAYS_CONSENT_KEYS = Object.freeze(["codex", "claude", "kimi"]);

export function descriptorFor(id) {
  return DESCRIPTOR_BY_ID.get(id) || null;
}

export function isKnownProvider(id) {
  return DESCRIPTOR_BY_ID.has(id);
}

// Providers with a local presence signal — the only ones the content-free probe
// can recognize on disk.
export function detectableDescriptors() {
  return PROVIDER_DESCRIPTORS.filter((descriptor) => typeof descriptor.detectRootKey === "string");
}
