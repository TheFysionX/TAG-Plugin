import fs from "node:fs/promises";
import path from "node:path";
import { hmacAlias } from "../crypto.mjs";
import { normalizeModel, normalizeTimestamp, safeNonNegativeInteger } from "./shared.mjs";

const MAX_SIGNAL_FILES = 20_000;

// Grok Build's retained signals are session summaries, not per-request token
// ledger records. They are useful evidence that the local client was used, but
// are intentionally NOT turned into leaderboard token events: doing so would
// misrepresent context occupancy as billable/raw token usage.
function signalSummary(value, options = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const contextTokensUsed = safeNonNegativeInteger(value.contextTokensUsed);
  const totalTokensBeforeCompaction = safeNonNegativeInteger(value.totalTokensBeforeCompaction);
  const rawModel = typeof value.primaryModelId === "string"
    ? value.primaryModelId
    : (Array.isArray(value.modelsUsed) && value.modelsUsed.length === 1 ? value.modelsUsed[0] : null);
  const primaryModelId = normalizeModel(rawModel);
  if (primaryModelId === "unknown" || (contextTokensUsed === 0 && totalTokensBeforeCompaction === 0)) return null;
  const localSessionAlias = options.localAliasKey && options.sessionPath
    ? hmacAlias(options.localAliasKey, "grok-build-session", options.sessionPath)
    : null;
  return {
    localSessionAlias,
    primaryModelId,
    // Keep the documented fields distinct. Their sum is a UI diagnostic only,
    // not a token-use event or an accounting claim.
    contextTokensUsed,
    totalTokensBeforeCompaction,
    summaryTokens: contextTokensUsed + totalTokensBeforeCompaction,
    turnCount: safeNonNegativeInteger(value.turnCount),
    observedAt: normalizeTimestamp(value.updatedAt ?? value.lastUpdatedAt ?? value.timestamp) ?? null,
    capability: "informational_session_summary_only"
  };
}

function summaryMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const model = normalizeModel(value.primaryModelId ?? value.modelId ?? value.model);
  const observedAt = normalizeTimestamp(value.updatedAt ?? value.lastUpdatedAt ?? value.timestamp ?? value.createdAt);
  return { primaryModelId: model === "unknown" ? null : model, observedAt };
}

export async function discoverGrokSignalFiles(root, options = {}) {
  const maximum = options.maximum || MAX_SIGNAL_FILES;
  const files = [];
  const pending = [root];
  let unavailable = false;
  while (pending.length > 0 && files.length <= maximum) {
    const directory = pending.pop();
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); }
    catch (error) {
      if (["ENOENT", "EACCES", "EPERM"].includes(error?.code)) { unavailable = true; continue; }
      throw error;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(candidate);
      else if (entry.isFile() && entry.name === "signals.json") files.push(candidate);
      if (files.length > maximum) break;
    }
  }
  files.sort((a, b) => a.localeCompare(b));
  return { files: files.slice(0, maximum), unavailable, truncated: files.length > maximum };
}

export async function parseGrokBuildSession(signalsPath, options = {}) {
  let signals;
  try { signals = JSON.parse(await fs.readFile(signalsPath, "utf8")); }
  catch (error) {
    return { status: error?.code === "ENOENT" ? "unavailable" : "malformed", reason: error?.code === "ENOENT" ? "not_found" : "invalid_signals", session: null };
  }
  const session = signalSummary(signals, { localAliasKey: options.localAliasKey, sessionPath: path.dirname(signalsPath) });
  if (!session) return { status: "unavailable", reason: "unsupported_signals_schema", session: null };
  const summaryPath = path.join(path.dirname(signalsPath), "summary.json");
  try {
    const metadata = summaryMetadata(JSON.parse(await fs.readFile(summaryPath, "utf8")));
    if (metadata?.primaryModelId) session.primaryModelId = metadata.primaryModelId;
    if (metadata?.observedAt) session.observedAt = metadata.observedAt;
  } catch {
    // summary.json is optional and is never needed to claim accounting data.
  }
  return { status: "available_prospective_partial", reason: "session_summary_not_token_ledger", session };
}
