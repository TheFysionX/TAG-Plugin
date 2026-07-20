import { spawn as nodeSpawn } from "node:child_process";

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

export async function readCodexAccountUsage(options = {}) {
  const spawnImpl = options.spawnImpl || nodeSpawn;
  const executable = options.executable || process.env.CODEX_BINARY || "codex";
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
          version: "0.1.0"
        }
      }
    }) + "\n");
  });
}
