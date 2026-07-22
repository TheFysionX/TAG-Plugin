import { execFile as nodeExecFile } from "node:child_process";

const AUTH_METHODS = new Set(["claude_ai", "api_key"]);
const API_PROVIDERS = new Set(["anthropic", "bedrock", "vertex"]);
const SUBSCRIPTION_TYPES = new Set(["free", "pro", "max", "team", "enterprise"]);
const WINDOWS_CLAUDE_SHIMS = new Set(["claude", "claude.cmd"]);
const WINDOWS_CLAUDE_STATUS_COMMAND = "claude.cmd auth status --json";

function classify(value, allowed) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase().replace(/[.\-\s]+/gu, "_");
  return allowed.has(normalized) ? normalized : null;
}

function classifyApiProvider(value) {
  // Claude Code's first-party signed-in status is camel-cased. Keep this
  // exact allowlist entry separate so lookalike/custom provider values remain
  // unclassified.
  if (value === "firstParty") return "first_party";
  return classify(value, API_PROVIDERS);
}

export function sanitizeClaudeAccountStatus(value) {
  if (!value || typeof value !== "object" || typeof value.loggedIn !== "boolean") return null;
  return {
    loggedIn: value.loggedIn,
    authMethod: classify(value.authMethod, AUTH_METHODS),
    apiProvider: classifyApiProvider(value.apiProvider),
    subscriptionType: classify(value.subscriptionType, SUBSCRIPTION_TYPES)
  };
}

function buildClaudeInvocation(options) {
  const executable = options.executable || process.env.CLAUDE_BINARY || "claude";
  if ((options.platform || process.platform) !== "win32") {
    return { executable, arguments_: ["auth", "status", "--json"] };
  }

  // npm exposes Claude Code as a .cmd shim on Windows. node:child_process
  // cannot execute that shim through execFile directly, so invoke cmd.exe with
  // a completely static command. Do not interpolate CLAUDE_BINARY into the
  // shell command: only the standard shim names are accepted.
  if (typeof executable !== "string" || !WINDOWS_CLAUDE_SHIMS.has(executable.trim().toLowerCase())) {
    return null;
  }
  return {
    executable: options.comSpec || process.env.ComSpec || "cmd.exe",
    arguments_: ["/d", "/c", WINDOWS_CLAUDE_STATUS_COMMAND]
  };
}

export async function readClaudeAccountStatus(options = {}) {
  const execFileImpl = options.execFileImpl || nodeExecFile;
  const timeoutMs = options.timeoutMs || 2_000;
  const invocation = buildClaudeInvocation(options);
  if (!invocation) {
    return { status: "unavailable", reason: "unsafe_executable" };
  }
  return new Promise((resolve) => {
    execFileImpl(invocation.executable, invocation.arguments_, {
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
