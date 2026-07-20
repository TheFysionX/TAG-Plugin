import fs from "node:fs/promises";
import path from "node:path";
import { MAX_LOG_BYTES } from "./constants.mjs";

const ALLOWED_KEYS = new Set([
  "at",
  "action",
  "status",
  "code",
  "eventCount",
  "providerCount",
  "sequence"
]);

function sanitize(record) {
  const safe = {};
  for (const [key, value] of Object.entries(record)) {
    if (!ALLOWED_KEYS.has(key)) {
      continue;
    }
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) {
      safe[key] = value;
    }
  }
  safe.at = safe.at || new Date().toISOString();
  return safe;
}

async function rotateIfNeeded(logPath, maxBytes) {
  try {
    const stat = await fs.stat(logPath);
    if (stat.size < maxBytes) {
      return;
    }
    const rotated = logPath + ".1";
    await fs.rm(rotated, { force: true });
    await fs.rename(logPath, rotated);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

export async function safeLog(logPath, record, options = {}) {
  await fs.mkdir(path.dirname(logPath), { recursive: true, mode: 0o700 });
  await rotateIfNeeded(logPath, options.maxBytes || MAX_LOG_BYTES);
  await fs.appendFile(logPath, JSON.stringify(sanitize(record)) + "\n", { encoding: "utf8", mode: 0o600 });
}
