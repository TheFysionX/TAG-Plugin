import { execFile as nodeExecFile } from "node:child_process";

const AUTH_METHODS = new Set(["claude_ai", "api_key"]);
const API_PROVIDERS = new Set(["anthropic", "bedrock", "vertex"]);
const SUBSCRIPTION_TYPES = new Set(["free", "pro", "max", "team", "enterprise"]);

function classify(value, allowed) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase().replace(/[.\-\s]+/gu, "_");
  return allowed.has(normalized) ? normalized : null;
}

export function sanitizeClaudeAccountStatus(value) {
  if (!value || typeof value !== "object" || typeof value.loggedIn !== "boolean") return null;
  return {
    loggedIn: value.loggedIn,
    authMethod: classify(value.authMethod, AUTH_METHODS),
    apiProvider: classify(value.apiProvider, API_PROVIDERS),
    subscriptionType: classify(value.subscriptionType, SUBSCRIPTION_TYPES)
  };
}

export async function readClaudeAccountStatus(options = {}) {
  const execFileImpl = options.execFileImpl || nodeExecFile;
  const executable = options.executable || process.env.CLAUDE_BINARY || "claude";
  const timeoutMs = options.timeoutMs || 2_000;
  return new Promise((resolve) => {
    execFileImpl(executable, ["auth", "status", "--json"], {
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: 64 * 1024,
      encoding: "utf8"
    }, (error, stdout) => {
      if (error) {
        resolve({ status: "unavailable", reason: error.killed || error.code === "ETIMEDOUT" ? "timeout" : "command_failed" });
        return;
      }
      try {
        const status = sanitizeClaudeAccountStatus(JSON.parse(typeof stdout === "string" ? stdout : String(stdout || "")));
        resolve(status
          ? { status: "available", verification: "provider_backed_claude_auth_status", ...status }
          : { status: "unavailable", reason: "invalid_response" });
      } catch {
        resolve({ status: "unavailable", reason: "invalid_response" });
      }
    });
  });
}
