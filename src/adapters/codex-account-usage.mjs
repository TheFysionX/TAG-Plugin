import { execFile as nodeExecFile, spawn as nodeSpawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { CONNECTOR_VERSION } from "../constants.mjs";

const MAX_STDOUT_BYTES = 1024 * 1024;

function safeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function sanitizeUsageResult(value) {
  const summary = value?.summary || {};
  const buckets = Array.isArray(value?.dailyUsageBuckets)
    ? value.dailyUsageBuckets.flatMap((bucket) => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(bucket?.startDate || "")) {
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
    const timer = setTimeout(() => finish({ status: "unavailable", reason: "timeout" }), timeoutMs);

    child.once("error", () => finish({ status: "unavailable", reason: "not_installed" }));
    child.once("exit", () => finish({ status: "unavailable", reason: "exited" }));
    child.stdin.on("error", () => finish({ status: "unavailable", reason: "stdin_error" }));
    child.stdout.on("error", () => finish({ status: "unavailable", reason: "stdout_error" }));
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
        } else if (message.id === 1 && message.result) {
          finish({
            status: "available",
            verification: "provider_backed_codex_account_usage",
            ...sanitizeUsageResult(message.result)
          });
        } else if (message.id === 1 && message.error) {
          finish({ status: "unavailable", reason: "rpc_rejected" });
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
