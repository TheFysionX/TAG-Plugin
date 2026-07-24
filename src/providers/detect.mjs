import fs from "node:fs/promises";
import { PROVIDER_DESCRIPTORS } from "./registry.mjs";

const DETECTION_REASON_PATTERN = /^[a-z_]{1,40}$/;
// Ceiling matched to the server's per-heartbeat bound; well above provider count.
const MAX_DETECTION_WIRE_ITEMS = 16;

// Project a persisted detection snapshot into the exact content-free shape the
// heartbeat sends: one entry per known provider with presence booleans only.
// No paths, versions of the user's install, timestamps, or any file contents.
export function detectionWireReport(detection) {
  const providers = detection?.providers;
  if (!providers || typeof providers !== "object") return [];
  const wire = [];
  for (const descriptor of PROVIDER_DESCRIPTORS) {
    const probe = providers[descriptor.id];
    if (!probe) continue;
    wire.push({
      providerId: descriptor.id,
      detected: probe.detected === true,
      ready: probe.ready === true,
      ...(typeof probe.reason === "string" && DETECTION_REASON_PATTERN.test(probe.reason)
        ? { reason: probe.reason }
        : {})
    });
    if (wire.length >= MAX_DETECTION_WIRE_ITEMS) break;
  }
  return wire;
}

// Content-free presence check. It only asks whether a provider's local data
// directory exists; it never opens, reads, lists, or hashes any file inside it.
// "You have this client installed" is a boolean, not your prompts.
async function directoryPresent(directoryPath, stat) {
  if (typeof directoryPath !== "string" || directoryPath.length === 0) return false;
  try {
    const observed = await stat(directoryPath);
    return observed.isDirectory();
  } catch {
    // ENOENT, ENOTDIR, EACCES, and any other error all resolve to "not
    // detected". Detection must never throw into a scan or heartbeat.
    return false;
  }
}

export const DETECTION_STATE_VERSION = 1;

// Probe every supported provider for local presence. Returns a map keyed by
// provider id with a content-free result per provider. `detected` means the
// local surface exists; `ready` means the connector could begin tracking on
// detection alone (a version-pinned provider stays not-ready until its pinned
// version is confirmed at collection time).
export async function probeInstalledProviders(roots, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const checkedAt = new Date(now).toISOString();
  const stat = options.stat || fs.stat;
  const providers = {};
  for (const descriptor of PROVIDER_DESCRIPTORS) {
    if (typeof descriptor.detectRootKey !== "string") {
      providers[descriptor.id] = {
        detected: false,
        ready: false,
        reason: "no_local_surface",
        checkedAt
      };
      continue;
    }
    const present = await directoryPresent(roots?.[descriptor.detectRootKey], stat);
    providers[descriptor.id] = {
      detected: present,
      ready: present && !descriptor.versionPin,
      reason: present
        ? (descriptor.versionPin ? "detected_pending_version" : "detected")
        : "absent",
      ...(descriptor.versionPin ? { versionPin: descriptor.versionPin } : {}),
      checkedAt
    };
  }
  return providers;
}
