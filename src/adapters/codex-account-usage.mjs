import { execFile as nodeExecFile, spawn as nodeSpawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { CONNECTOR_VERSION } from "../constants.mjs";

const MAX_STDOUT_BYTES = 1024 * 1024;
// This mirrors the current PlanType enum emitted by Codex app-server.  Keep
// the native code intact: the server assigns a conservative catalog entry
// rather than guessing a commercial SKU from a similarly named family.
const PLAN_TYPES = new Set([
  "free", "go", "plus", "pro", "prolite", "team",
  "self_serve_business_usage_based", "enterprise_cbp_usage_based",
  "enterprise", "edu", "unknown"
]);
const MAX_RATE_LIMIT_WINDOW_MINUTES = 10_080;
const MIN_RESET_AT_MS = Date.UTC(2000, 0, 1);
const MAX_RESET_AT_MS = Date.UTC(2100, 0, 1);

function safeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function isCanonicalUtcDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return false;
  const parsed = new Date(value + "T00:00:00.000Z");
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function sanitizeUsageResult(value) {
  const summary = value?.summary || {};
  const buckets = Array.isArray(value?.dailyUsageBuckets)
    ? value.dailyUsageBuckets.flatMap((bucket) => {
        if (!isCanonicalUtcDate(bucket?.startDate)) {
          return [];
        }
        const tokens = safeInteger(bucket.tokens);
        return tokens === null ? [] : [{ startDate: bucket.startDate, tokens }];
      })
    : null;
  return {
    summary: {
      lifetimeTokens: safeInteger(summary.lifetimeTokens),
      peakDailyTokens: safeInteger(summary.peakDailyTokens),
      longestRunningTurnSec: safeInteger(summary.longestRunningTurnSec),
      currentStreakDays: safeInteger(summary.currentStreakDays),
      longestStreakDays: safeInteger(summary.longestStreakDays)
    },
    dailyUsageBuckets: buckets
  };
}

function canonicalPlanType(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return PLAN_TYPES.has(normalized) ? normalized : null;
}

function canonicalResetAt(value) {
  const numeric = typeof value === "number" && Number.isFinite(value) ? value : null;
  if (numeric === null) return null;
  const milliseconds = numeric < 10_000_000_000 ? numeric * 1_000 : numeric;
  if (!Number.isSafeInteger(milliseconds) || milliseconds < MIN_RESET_AT_MS || milliseconds > MAX_RESET_AT_MS) {
    return null;
  }
  return new Date(milliseconds).toISOString();
}

function sanitizeRateLimitWindow(value) {
  const usedPercent = typeof value?.usedPercent === "number" && Number.isFinite(value.usedPercent)
    && value.usedPercent >= 0 && value.usedPercent <= 100
    ? Math.round(value.usedPercent * 100) / 100
    : null;
  const windowMinutes = safeInteger(value?.windowDurationMins);
  const resetAt = canonicalResetAt(value?.resetsAt);
  if (usedPercent === null && windowMinutes === null && resetAt === null) return null;
  return {
    usedPercent,
    windowMinutes: windowMinutes !== null && windowMinutes <= MAX_RATE_LIMIT_WINDOW_MINUTES ? windowMinutes : null,
    resetAt
  };
}

function sanitizeAccountResult(value) {
  const account = value?.account && typeof value.account === "object" ? value.account : value;
  const rawSurface = typeof account?.type === "string" ? account.type.trim().toLowerCase() : "";
  if (rawSurface !== "chatgpt") return null;
  return {
    authSurface: "chatgpt",
    planType: canonicalPlanType(account.planType)
  };
}

function sanitizeRateLimitsResult(value) {
  const rateLimits = value?.rateLimits && typeof value.rateLimits === "object" ? value.rateLimits : value;
  if (!rateLimits || typeof rateLimits !== "object") return null;
  const primary = sanitizeRateLimitWindow(rateLimits.primary);
  const secondary = sanitizeRateLimitWindow(rateLimits.secondary);
  const credits = rateLimits.credits && typeof rateLimits.credits === "object"
    ? {
        hasCredits: typeof rateLimits.credits.hasCredits === "boolean" ? rateLimits.credits.hasCredits : null,
        unlimited: typeof rateLimits.credits.unlimited === "boolean" ? rateLimits.credits.unlimited : null
      }
    : null;
  const sanitizedCredits = credits && (credits.hasCredits !== null || credits.unlimited !== null) ? credits : null;
  if (!primary && !secondary && !sanitizedCredits) return null;
  return { primary, secondary, credits: sanitizedCredits };
}

function executeForStdout(executable, arguments_, options = {}) {
  const execFileImpl = options.execFileImpl || nodeExecFile;
  return new Promise((resolve, reject) => {
    execFileImpl(executable, arguments_, {
      windowsHide: true,
      timeout: options.timeoutMs || 2_000,
      encoding: "utf8"
    }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(typeof stdout === "string" ? stdout : String(stdout || ""));
    });
  });
}

async function findLocalCodexExecutable(options = {}) {
  const localAppData = options.localAppData || process.env.LOCALAPPDATA;
  if (!localAppData) return null;
  const binaryRoot = path.join(localAppData, "OpenAI", "Codex", "bin");
  try {
    const entries = await fs.readdir(binaryRoot, { withFileTypes: true });
    const candidates = [path.join(binaryRoot, "codex.exe")];
    for (const entry of entries) {
      if (entry.isDirectory()) candidates.push(path.join(binaryRoot, entry.name, "codex.exe"));
    }
    const existing = (await Promise.all(candidates.map(async (candidate) => {
      try {
        const stat = await fs.stat(candidate);
        return stat.isFile() ? { candidate, modifiedAt: stat.mtimeMs } : null;
      } catch {
        return null;
      }
    }))).filter(Boolean);
    existing.sort((left, right) => right.modifiedAt - left.modifiedAt);
    return existing[0]?.candidate || null;
  } catch {
    return null;
  }
}

export async function resolveCodexExecutable(options = {}) {
  const explicit = options.executable || process.env.CODEX_BINARY;
  if (explicit) return explicit;
  const platform = options.platform || process.platform;
  if (platform !== "win32") return "codex";

  const localExecutable = await (options.resolveLocalExecutable || findLocalCodexExecutable)(options);
  if (localExecutable) return localExecutable;

  try {
    const stdout = await executeForStdout("where.exe", ["codex.exe"], options);
    const resolved = stdout
      .split(/\r?\n/u)
      .map((line) => line.trim().replace(/^"|"$/gu, ""))
      .find((candidate) => path.win32.isAbsolute(candidate) && /\.exe$/iu.test(candidate));
    if (resolved) return resolved;
  } catch {
    // Fall back to normal PATH resolution below.
  }
  return "codex.exe";
}

export async function readCodexAccountUsage(options = {}) {
  const spawnImpl = options.spawnImpl || nodeSpawn;
  const executable = options.spawnImpl && !options.resolveExecutable
    ? (options.executable || process.env.CODEX_BINARY || "codex")
    : await (options.resolveExecutable || resolveCodexExecutable)(options);
  const timeoutMs = options.timeoutMs || 6_000;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(executable, ["app-server", "--stdio"], {
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
        env: process.env
      });
    } catch {
      resolve({ status: "unavailable", reason: "spawn_failed" });
      return;
    }

    let settled = false;
    let pending = "";
    let bytes = 0;
    let usage = null;
    let account = null;
    let rateLimits = null;
    const completed = new Set();
    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        // Process is already gone.
      }
      resolve(result);
    };
    const finishBestAvailable = (fallbackReason) => {
      if (usage) {
        finish({
          status: "available",
          verification: "provider_backed_codex_account_usage",
          ...usage,
          account,
          rateLimits
        });
        return;
      }
      finish({ status: "unavailable", reason: fallbackReason });
    };
    const maybeFinish = () => {
      if (usage && completed.has(1) && completed.has(2) && completed.has(3)) finishBestAvailable("rpc_rejected");
    };
    const timer = setTimeout(() => finishBestAvailable("timeout"), timeoutMs);

    child.once("error", () => finishBestAvailable("not_installed"));
    child.once("exit", () => finishBestAvailable("exited"));
    child.stdin.on("error", () => finishBestAvailable("stdin_error"));
    child.stdout.on("error", () => finishBestAvailable("stdout_error"));
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_STDOUT_BYTES) {
        finish({ status: "unavailable", reason: "oversized_response" });
        return;
      }
      pending += chunk.toString("utf8");
      let newline;
      while ((newline = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        if (!line) {
          continue;
        }
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === 0 && message.result) {
          child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
          child.stdin.write(JSON.stringify({ method: "account/usage/read", id: 1 }) + "\n");
          child.stdin.write(JSON.stringify({ method: "account/read", id: 2, params: { refreshToken: false } }) + "\n");
          child.stdin.write(JSON.stringify({ method: "account/rateLimits/read", id: 3 }) + "\n");
        } else if (message.id === 1) {
          completed.add(1);
          if (message.result) usage = sanitizeUsageResult(message.result);
          maybeFinish();
        } else if (message.id === 2) {
          completed.add(2);
          if (message.result) account = sanitizeAccountResult(message.result);
          maybeFinish();
        } else if (message.id === 3) {
          completed.add(3);
          if (message.result) rateLimits = sanitizeRateLimitsResult(message.result);
          maybeFinish();
        }
      }
    });

    child.stdin.write(JSON.stringify({
      method: "initialize",
      id: 0,
      params: {
        clientInfo: {
          name: "tag-plugin",
          title: "TAG Plugin",
          version: CONNECTOR_VERSION
        }
      }
    }) + "\n");
  });
}
