import { execFile as nodeExecFile } from "node:child_process";
import { readClaudePlanEvidence } from "./claude-plan-evidence.mjs";

const AUTH_METHODS = new Set(["claude_ai", "api_key"]);
const API_PROVIDERS = new Set(["anthropic", "bedrock", "vertex"]);
const SUBSCRIPTION_TYPES = new Set(["free", "pro", "max", "team", "enterprise"]);
const WINDOWS_CLAUDE_SHIMS = new Set(["claude", "claude.cmd"]);
const WINDOWS_CLAUDE_STATUS_COMMAND = "claude.cmd auth status --json";
const EXACT_NON_MAX_SUBSCRIPTIONS = new Set(["free", "pro", "team", "enterprise"]);

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

function classifyOrganizationId(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return /^[a-z0-9][a-z0-9_-]{7,127}$/iu.test(normalized) ? normalized : null;
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
  const commandResult = await new Promise((resolve) => {
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
        const parsed = JSON.parse(typeof stdout === "string" ? stdout : String(stdout || ""));
        const status = sanitizeClaudeAccountStatus(parsed);
        resolve(status
          ? {
              status: "available",
              verification: "provider_backed_claude_auth_status",
              ...status,
              organizationId: classifyOrganizationId(parsed.orgId)
            }
          : { status: "unavailable", reason: "invalid_response" });
      } catch {
        resolve({ status: "unavailable", reason: "invalid_response" });
      }
    });
  });
  const publicCommandResult = commandResult.status === "available"
    ? {
        status: commandResult.status,
        verification: commandResult.verification,
        loggedIn: commandResult.loggedIn,
        authMethod: commandResult.authMethod,
        apiProvider: commandResult.apiProvider,
        subscriptionType: commandResult.subscriptionType
      }
    : commandResult;
  const withLocalAccountIdentity = (value) => options.includeLocalAccountIdentity && commandResult.organizationId
    ? { ...value, organizationId: commandResult.organizationId }
    : value;
  const currentFirstPartyAccount = commandResult.status === "available"
    && commandResult.loggedIn === true
    && commandResult.authMethod === "claude_ai"
    && (commandResult.apiProvider === "first_party" || commandResult.apiProvider === "anthropic")
    && commandResult.organizationId;
  if (!currentFirstPartyAccount) return withLocalAccountIdentity(publicCommandResult);
  const readPlan = options.readPlanEvidence || readClaudePlanEvidence;
  const planEvidence = await readPlan({
    ...(options.planEvidenceOptions || {}),
    env: options.planEvidenceOptions?.env ?? options.env,
    platform: options.planEvidenceOptions?.platform ?? options.platform,
    expectedOrgId: commandResult.organizationId
  });
  if (planEvidence?.status === "available") {
    if (planEvidence.maxEntitled === false) {
      if (!EXACT_NON_MAX_SUBSCRIPTIONS.has(commandResult.subscriptionType)) {
        return withLocalAccountIdentity(publicCommandResult);
      }
      return withLocalAccountIdentity({
        ...publicCommandResult,
        verification: planEvidence.verification,
        rawPlanCode: commandResult.subscriptionType,
        cacheUpdatedAt: planEvidence.cacheUpdatedAt
      });
    }
    return withLocalAccountIdentity({
      status: "available",
      verification: planEvidence.verification,
      loggedIn: commandResult.loggedIn,
      authMethod: commandResult.authMethod,
      apiProvider: commandResult.apiProvider,
      subscriptionType: planEvidence.subscriptionType,
      rateLimitTier: planEvidence.rateLimitTier,
      rawPlanCode: planEvidence.rawPlanCode,
      cacheUpdatedAt: planEvidence.cacheUpdatedAt
    });
  }
  return withLocalAccountIdentity(publicCommandResult);
}
