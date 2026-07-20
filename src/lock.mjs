import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { randomBytes } from "node:crypto";
import { DEFAULT_LOCK_STALE_MS } from "./constants.mjs";
import { ConnectorError } from "./errors.mjs";

function clock(options) {
  if (typeof options.now === "function") return options.now;
  if (Number.isFinite(options.now)) return () => options.now;
  return Date.now;
}

async function inspectLock(lockPath) {
  try {
    const [stat, text] = await Promise.all([
      fs.stat(lockPath),
      fs.readFile(lockPath, "utf8")
    ]);
    let record = null;
    try {
      record = JSON.parse(text);
    } catch {
      // A malformed lock can still be reclaimed after its filesystem lease expires.
    }
    return { stat, record };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function removeCanonicalIfOwned(lockPath, ownerToken, heldStat) {
  const current = await inspectLock(lockPath).catch(() => null);
  const ownsPath = current?.record?.ownerToken === ownerToken
    && heldStat
    && current.stat.dev === heldStat.dev
    && current.stat.ino === heldStat.ino;
  if (ownsPath) await fs.rm(lockPath, { force: true });
}

function sameObservedLease(observed, moved) {
  if (!observed || !moved) return false;
  const observedToken = observed.record?.ownerToken;
  const movedToken = moved.record?.ownerToken;
  return observedToken === movedToken
    && observed.stat.size === moved.stat.size
    && Math.abs(observed.stat.mtimeMs - moved.stat.mtimeMs) < 1;
}

function processIsAlive(pid, processKill = process.kill) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    processKill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    // EPERM means the process exists but this user cannot signal it. Unknown
    // probe failures also fail closed rather than stealing a possibly live lock.
    return true;
  }
}

async function restoreMovedLease(quarantinePath, lockPath) {
  try {
    await fs.link(quarantinePath, lockPath);
    await fs.rm(quarantinePath, { force: true }).catch(() => {});
    return;
  } catch (error) {
    if (error?.code === "EEXIST") {
      await fs.rm(quarantinePath, { force: true }).catch(() => {});
      return;
    }
    if (error?.code === "ENOENT") return;
  }
  try {
    await fs.copyFile(quarantinePath, lockPath, fsConstants.COPYFILE_EXCL);
    await fs.rm(quarantinePath, { force: true });
  } catch (error) {
    if (error?.code !== "EEXIST" && error?.code !== "ENOENT") throw error;
    await fs.rm(quarantinePath, { force: true }).catch(() => {});
  }
}

export async function acquireLock(lockPath, options = {}) {
  const staleMs = options.staleMs ?? DEFAULT_LOCK_STALE_MS;
  const nowMs = clock(options);
  const ownerToken = options.ownerToken || randomBytes(24).toString("base64url");
  const tryCreate = async () => {
    const handle = await fs.open(lockPath, "wx", 0o600);
    const createdAt = nowMs();
    try {
      await handle.writeFile(JSON.stringify({
        pid: process.pid,
        ownerToken,
        createdAt,
        leaseUpdatedAt: createdAt
      }) + "\n", "utf8");
      await handle.sync();
      const timestamp = new Date(createdAt);
      await handle.utimes(timestamp, timestamp);
      return handle;
    } catch (error) {
      const heldStat = await handle.stat().catch(() => null);
      await handle.close().catch(() => {});
      await removeCanonicalIfOwned(lockPath, ownerToken, heldStat).catch(() => {});
      throw error;
    }
  };

  let handle = null;
  for (let attempt = 0; attempt < 8 && !handle; attempt += 1) {
    try {
      handle = await tryCreate();
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }

    try {
      const observed = await inspectLock(lockPath);
      if (!observed) continue;
      if (nowMs() - observed.stat.mtimeMs <= staleMs) {
        throw new ConnectorError("SYNC_ALREADY_RUNNING", "Another connector operation is already running.");
      }
      if (processIsAlive(observed.record?.pid, options.processKill)) {
        throw new ConnectorError(
          "SYNC_ALREADY_RUNNING",
          "Another live connector process still owns the expired lease."
        );
      }

      const quarantinePath = `${lockPath}.stale.${ownerToken}.${randomBytes(6).toString("hex")}`;
      try {
        await fs.rename(lockPath, quarantinePath);
      } catch (error) {
        if (["ENOENT", "EEXIST", "EPERM", "EACCES"].includes(error?.code)) {
          const current = await inspectLock(lockPath);
          if (current && nowMs() - current.stat.mtimeMs <= staleMs) {
            throw new ConnectorError(
              "SYNC_ALREADY_RUNNING",
              "Another connector operation won the stale-lock takeover race."
            );
          }
          continue;
        }
        throw error;
      }
      const moved = await inspectLock(quarantinePath);
      if (!sameObservedLease(observed, moved)) {
        await restoreMovedLease(quarantinePath, lockPath);
        throw new ConnectorError(
          "SYNC_ALREADY_RUNNING",
          "Another connector operation is already running and renewed its lease."
        );
      }
      try {
        handle = await tryCreate();
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      } finally {
        await fs.rm(quarantinePath, { force: true }).catch(() => {});
      }
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      throw new ConnectorError(
        "LOCK_UNAVAILABLE",
        "The connector could not acquire its local overlap lock.",
        { cause: error }
      );
    }
  }

  if (!handle) {
    throw new ConnectorError("SYNC_ALREADY_RUNNING", "Another connector operation acquired the local lock.");
  }

  const refreshIntervalMs = options.refreshIntervalMs
    ?? Math.max(1, Math.floor(staleMs / 4));
  const setIntervalFn = options.setIntervalFn || setInterval;
  const clearIntervalFn = options.clearIntervalFn || clearInterval;
  let refreshChain = Promise.resolve();
  let refreshError = null;
  let released = false;
  const refresh = async () => {
    if (released) return;
    const timestamp = new Date(nowMs());
    await handle.utimes(timestamp, timestamp);
  };
  const timer = refreshIntervalMs > 0
    ? setIntervalFn(() => {
        refreshChain = refreshChain
          .then(refresh)
          .catch((error) => { refreshError = error; });
        return refreshChain;
      }, refreshIntervalMs)
    : null;
  timer?.unref?.();

  const release = async () => {
    if (released) return;
    released = true;
    if (timer) clearIntervalFn(timer);
    await refreshChain;
    const heldStat = await handle.stat().catch(() => null);
    await handle.close();
    await removeCanonicalIfOwned(lockPath, ownerToken, heldStat);
    if (refreshError && options.throwOnRefreshError) throw refreshError;
  };
  release.ownerToken = ownerToken;
  release.refresh = refresh;
  return release;
}

export async function withLock(lockPath, task, options) {
  const release = await acquireLock(lockPath, options);
  try {
    return await task({ ownerToken: release.ownerToken, refresh: release.refresh });
  } finally {
    await release();
  }
}
