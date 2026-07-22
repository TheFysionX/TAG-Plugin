import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { accountScopedEventId, hmacAlias } from "../crypto.mjs";
import { canonicalModelId, providerForModelId } from "../model-registry.mjs";
import { normalizeMode, normalizeUsage } from "./shared.mjs";

const DESKTOP_COLLECTOR = "antigravity_desktop_sqlite_v1";
const MAX_PENDING_STEPS = 10_000;
const MAX_ASAR_HEADER_BYTES = 4 * 1024 * 1024;
const MAX_ASAR_PACKAGE_BYTES = 64 * 1024;
export const SUPPORTED_ANTIGRAVITY_DESKTOP_VERSIONS = new Set(["2.3.1"]);

// These identifiers are deliberately a small, version-pinned allowlist.  The
// database carries other model metadata, but TAG must not infer a model from
// arbitrary protobuf fields or inspect message-bearing tables.
export const ANTIGRAVITY_DESKTOP_MODELS = new Map([
  // "Flash" and the high/medium/low suffixes are model/reasoning variants,
  // not evidence that the user selected a separately billed fast service mode.
  [1264, { sourceModelId: "gemini-3.6-flash-high", canonicalModelId: "gemini-3.6-flash", provider: "gemini", speed: "standard" }],
  [1265, { sourceModelId: "gemini-3.6-flash-medium", canonicalModelId: "gemini-3.6-flash", provider: "gemini", speed: "standard" }],
  [1266, { sourceModelId: "gemini-3.6-flash-low", canonicalModelId: "gemini-3.6-flash", provider: "gemini", speed: "standard" }],
  [1084, { sourceModelId: "gemini-3.5-flash-high", canonicalModelId: "gemini-3.5-flash", provider: "gemini", speed: "standard" }],
  [1020, { sourceModelId: "gemini-3.5-flash-medium", canonicalModelId: "gemini-3.5-flash", provider: "gemini", speed: "standard" }],
  [1187, { sourceModelId: "gemini-3.5-flash-low", canonicalModelId: "gemini-3.5-flash", provider: "gemini", speed: "standard" }],
  [1016, { sourceModelId: "gemini-3.1-pro-high", canonicalModelId: "gemini-3.1-pro-preview", provider: "gemini", speed: "standard" }],
  [1036, { sourceModelId: "gemini-3.1-pro-low", canonicalModelId: "gemini-3.1-pro-preview", provider: "gemini", speed: "standard" }],
  [1035, { sourceModelId: "claude-sonnet-4.6-thinking", canonicalModelId: "claude-sonnet-4.6", provider: "claude", speed: "standard" }],
  [1026, { sourceModelId: "claude-opus-4.6-thinking", canonicalModelId: "claude-opus-4.6", provider: "claude", speed: "standard" }]
]);

function safeInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function watermarkInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= -1 ? value : null;
}

function readVarint(bytes, offset) {
  let value = 0n;
  let shift = 0n;
  for (let index = offset; index < bytes.length && index < offset + 10; index += 1) {
    const byte = bytes[index];
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return value <= BigInt(Number.MAX_SAFE_INTEGER)
        ? { value: Number(value), next: index + 1 }
        : null;
    }
    shift += 7n;
  }
  return null;
}

function protobufFields(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value || []);
  const fields = [];
  let offset = 0;
  while (offset < bytes.length) {
    const tag = readVarint(bytes, offset);
    if (!tag || tag.value === 0) return null;
    offset = tag.next;
    const field = Math.floor(tag.value / 8);
    const wireType = tag.value % 8;
    if (field < 1) return null;
    if (wireType === 0) {
      const encoded = readVarint(bytes, offset);
      if (!encoded) return null;
      fields.push({ field, wireType, value: encoded.value });
      offset = encoded.next;
      continue;
    }
    if (wireType === 1) {
      if (offset + 8 > bytes.length) return null;
      fields.push({ field, wireType, value: bytes.subarray(offset, offset + 8) });
      offset += 8;
      continue;
    }
    if (wireType === 2) {
      const length = readVarint(bytes, offset);
      if (!length || length.value > bytes.length - length.next) return null;
      const end = length.next + length.value;
      fields.push({ field, wireType, value: bytes.subarray(length.next, end) });
      offset = end;
      continue;
    }
    if (wireType === 5) {
      if (offset + 4 > bytes.length) return null;
      fields.push({ field, wireType, value: bytes.subarray(offset, offset + 4) });
      offset += 4;
      continue;
    }
    // Groups are unsupported by the pinned schema. Failing closed avoids
    // accidentally parsing nested retry metadata as top-level usage.
    return null;
  }
  return fields;
}

function timestampFromBytes(value) {
  const fields = protobufFields(value);
  if (!fields) return null;
  const seconds = fields.find((entry) => entry.field === 1 && entry.wireType === 0)?.value;
  const nanos = fields.find((entry) => entry.field === 2 && entry.wireType === 0)?.value ?? 0;
  if (!Number.isSafeInteger(seconds) || !Number.isSafeInteger(nanos) || nanos < 0 || nanos >= 1_000_000_000) return null;
  const milliseconds = seconds * 1_000 + Math.floor(nanos / 1_000_000);
  if (!Number.isSafeInteger(milliseconds) || Math.abs(milliseconds) > 8_640_000_000_000_000) return null;
  return new Date(milliseconds).toISOString();
}

function decodeModelUsage(value) {
  const fields = protobufFields(value);
  if (!fields) return null;
  const number = (field) => fields.find((entry) => entry.field === field && entry.wireType === 0)?.value ?? 0;
  const optionalNumber = (field) => fields.find((entry) => entry.field === field && entry.wireType === 0)?.value ?? null;
  const modelEnum = number(1);
  const input = number(2);
  const output = number(3);
  const cacheWrite = number(4);
  const cacheRead = number(5);
  const apiProvider = number(6);
  const thinking = number(9);
  const response = optionalNumber(10);
  if ([modelEnum, input, output, cacheWrite, cacheRead, apiProvider, thinking, ...(response === null ? [] : [response])]
    .some((item) => !Number.isSafeInteger(item) || item < 0)) return null;
  return { modelEnum, input, output, cacheWrite, cacheRead, apiProvider, thinking, response };
}

export function decodeAntigravityDesktopMetadata(value) {
  const fields = protobufFields(value);
  if (!fields) return null;
  let observedAt = null;
  for (const fieldNumber of [8, 7, 6, 1]) {
    const candidate = fields.find((entry) => entry.field === fieldNumber && entry.wireType === 2);
    observedAt = candidate ? timestampFromBytes(candidate.value) : null;
    if (observedAt) break;
  }
  const usageField = fields.find((entry) => entry.field === 9 && entry.wireType === 2);
  const usage = usageField ? decodeModelUsage(usageField.value) : null;
  // Completed non-model steps legitimately have no field 9. They are not
  // malformed usage and must be ignored without degrading scan coverage.
  return { observedAt, usage };
}

function modelDetails(modelEnum, resolveModel) {
  const mapped = ANTIGRAVITY_DESKTOP_MODELS.get(modelEnum);
  if (!mapped) {
    return {
      sourceModelId: `antigravity-model-enum-${modelEnum}`,
      modelId: null,
      provider: "gemini",
      mode: { serviceTier: null, speed: null, fast: false, classified: false }
    };
  }
  // A local enum mapping proves the displayed model family, but it does not
  // authorize scoring by itself. Only the current frozen model registry may
  // return a canonical model id; otherwise the exact counters remain raw-only.
  const modelId = resolveModel(mapped.provider, mapped.canonicalModelId);
  const provider = providerForModelId(modelId) || mapped.provider;
  return {
    sourceModelId: mapped.sourceModelId,
    modelId,
    provider,
    mode: normalizeMode({ provider, speed: mapped.speed })
  };
}

function observedBounds(options) {
  const minimumRaw = options.minimumObservedAtInclusive ?? options.minimumObservedAt ?? options.minObservedAt;
  const maximumRaw = options.maximumObservedAtExclusive ?? options.maximumObservedAt ?? options.maxObservedAt;
  const minimum = typeof minimumRaw === "string" && Number.isFinite(Date.parse(minimumRaw)) ? Date.parse(minimumRaw) : Number.NEGATIVE_INFINITY;
  const maximum = typeof maximumRaw === "string" && Number.isFinite(Date.parse(maximumRaw)) ? Date.parse(maximumRaw) : Number.POSITIVE_INFINITY;
  return { minimum, maximum };
}

function cursorPending(cursor) {
  if (!Array.isArray(cursor?.pending)) return new Map();
  const pending = new Map();
  for (const entry of cursor.pending) {
    const index = safeInteger(entry?.index);
    if (index === null || !["open", "completed"].includes(entry?.status)) continue;
    pending.set(index, entry.status);
    if (pending.size > MAX_PENDING_STEPS) return new Map();
  }
  return pending;
}

function cursorState(cursor, fileIdentity, schemaIdentity) {
  if (cursor?.version !== 2
    || cursor.fileIdentity !== fileIdentity
    || cursor.schemaIdentity !== schemaIdentity) {
    return { highWatermark: -1, pending: new Map(), reset: true };
  }
  const highWatermark = watermarkInteger(cursor.highWatermark);
  if (highWatermark === null) return { highWatermark: -1, pending: new Map(), reset: true };
  return { highWatermark, pending: cursorPending(cursor), reset: false };
}

function fingerprintStepsSchema(localAliasKey, schema) {
  const structure = schema.map((column) => ({
    cid: safeInteger(column?.cid),
    name: typeof column?.name === "string" ? column.name : null,
    type: typeof column?.type === "string" ? column.type : null,
    notnull: safeInteger(column?.notnull),
    pk: safeInteger(column?.pk)
  }));
  return hmacAlias(localAliasKey, "antigravity-desktop-steps-schema", JSON.stringify(structure));
}

function defaultAppAsarCandidates(options = {}) {
  if (Array.isArray(options.appAsarPaths)) return options.appAsarPaths.slice(0, 8);
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const userHome = options.userHome || homedir();
  if (platform === "win32") {
    return [
      env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Programs", "antigravity", "resources", "app.asar"),
      env.ProgramFiles && path.join(env.ProgramFiles, "Antigravity", "resources", "app.asar"),
      env["ProgramFiles(x86)"] && path.join(env["ProgramFiles(x86)"], "Antigravity", "resources", "app.asar")
    ].filter(Boolean);
  }
  if (platform === "darwin") {
    return [
      "/Applications/Antigravity.app/Contents/Resources/app.asar",
      path.join(userHome, "Applications", "Antigravity.app", "Contents", "Resources", "app.asar")
    ];
  }
  return [
    "/opt/Antigravity/resources/app.asar",
    "/opt/antigravity/resources/app.asar",
    "/usr/lib/antigravity/resources/app.asar",
    path.join(userHome, ".local", "share", "antigravity", "resources", "app.asar")
  ];
}

async function readAsarPackage(filePath) {
  const handle = await fs.open(filePath, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 16) return null;
    const prefix = Buffer.alloc(16);
    const prefixRead = await handle.read(prefix, 0, prefix.length, 0);
    if (prefixRead.bytesRead !== prefix.length) return null;
    const headerPickleBytes = prefix.readUInt32LE(4);
    const headerJsonBytes = prefix.readUInt32LE(12);
    if (headerPickleBytes < 8 || headerPickleBytes > MAX_ASAR_HEADER_BYTES
      || headerJsonBytes < 2 || headerJsonBytes > headerPickleBytes - 8) return null;
    const headerBuffer = Buffer.alloc(headerJsonBytes);
    const headerRead = await handle.read(headerBuffer, 0, headerBuffer.length, 16);
    if (headerRead.bytesRead !== headerBuffer.length) return null;
    let header;
    try { header = JSON.parse(headerBuffer.toString("utf8")); } catch { return null; }
    const entry = header?.files?.["package.json"];
    const packageBytes = Number(entry?.size);
    const packageOffset = Number(entry?.offset);
    if (!Number.isSafeInteger(packageBytes) || packageBytes < 2 || packageBytes > MAX_ASAR_PACKAGE_BYTES
      || !Number.isSafeInteger(packageOffset) || packageOffset < 0 || entry?.unpacked === true) return null;
    const absoluteOffset = 8 + headerPickleBytes + packageOffset;
    if (!Number.isSafeInteger(absoluteOffset) || absoluteOffset + packageBytes > stat.size) return null;
    const packageBuffer = Buffer.alloc(packageBytes);
    const packageRead = await handle.read(packageBuffer, 0, packageBuffer.length, absoluteOffset);
    if (packageRead.bytesRead !== packageBuffer.length) return null;
    // A pinned desktop version is trustworthy only when its ASAR entry is
    // itself integrity-protected. Missing, alternate, or malformed metadata
    // is not a best-effort condition: fail closed before reading package.json.
    const integrity = entry?.integrity;
    if (integrity?.algorithm !== "SHA256"
      || typeof integrity.hash !== "string"
      || !/^[a-f0-9]{64}$/u.test(integrity.hash)) return null;
    const digest = createHash("sha256").update(packageBuffer).digest("hex");
    if (digest !== integrity.hash) return null;
    let packageJson;
    try { packageJson = JSON.parse(packageBuffer.toString("utf8")); } catch { return null; }
    return packageJson?.name === "antigravity"
      && packageJson?.productName === "Antigravity"
      && typeof packageJson.version === "string"
      ? packageJson
      : null;
  } finally {
    await handle.close();
  }
}

export async function detectAntigravityDesktopVersion(options = {}) {
  let unsupportedVersion = null;
  for (const candidate of defaultAppAsarCandidates(options)) {
    try {
      const packageJson = await readAsarPackage(candidate);
      if (!packageJson) continue;
      if (SUPPORTED_ANTIGRAVITY_DESKTOP_VERSIONS.has(packageJson.version)) {
        return { status: "supported", version: packageJson.version };
      }
      unsupportedVersion ||= packageJson.version;
    } catch (error) {
      if (!["ENOENT", "EACCES", "EPERM"].includes(error?.code)) continue;
    }
  }
  return unsupportedVersion
    ? { status: "unsupported", version: unsupportedVersion, reason: "unsupported_desktop_version" }
    : { status: "unavailable", version: null, reason: "desktop_version_not_found" };
}

async function databaseConstructor(options) {
  if (typeof options.DatabaseSync === "function") return options.DatabaseSync;
  const sqlite = await import("node:sqlite");
  return sqlite.DatabaseSync;
}

function inaccessibleResult(error) {
  return {
    status: "unavailable",
    reason: error?.code === "ENOENT" ? "not_installed" : "not_readable",
    events: [], captures: 0, malformed: 0, cursor: { version: 2, pending: [] }
  };
}

/** Returns only immediate conversation databases; it never traverses workspace content. */
export async function discoverAntigravityDesktopDatabases(root, options = {}) {
  const maximum = Number.isSafeInteger(options.maximumFiles) && options.maximumFiles >= 0
    ? options.maximumFiles
    : 5_000;
  if (typeof root !== "string" || root.length === 0) {
    return { status: "unavailable", reason: "not_installed", truncated: false, files: [] };
  }
  let directory;
  try {
    directory = await fs.opendir(root);
    const files = [];
    let truncated = false;
    for await (const entry of directory) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".db")) continue;
      if (files.length >= maximum) {
        truncated = true;
        break;
      }
      files.push(path.join(root, entry.name));
    }
    return {
      status: "available",
      reason: null,
      truncated,
      files: files.sort((left, right) => left.localeCompare(right))
    };
  } catch (error) {
    if (["ENOENT", "EACCES", "EPERM"].includes(error?.code)) {
      return { status: "unavailable", reason: error.code === "ENOENT" ? "not_installed" : "not_readable", truncated: false, files: [] };
    }
    throw error;
  } finally {
    await directory?.close().catch(() => {});
  }
}

export async function parseAntigravityDesktopDatabase(filePath, options = {}) {
  if (!SUPPORTED_ANTIGRAVITY_DESKTOP_VERSIONS.has(options.desktopVersion)) {
    return { status: "unavailable", reason: options.desktopVersion ? "unsupported_desktop_version" : "desktop_version_not_verified", events: [], captures: 0, malformed: 0, cursor: { version: 2, pending: [] } };
  }
  if (typeof options.localAliasKey !== "string" || options.localAliasKey.length === 0) {
    return { status: "unavailable", reason: "missing_local_alias_key", events: [], captures: 0, malformed: 0, cursor: { version: 2, pending: [] } };
  }
  if (typeof options.dedupNamespaceKey !== "string" || options.dedupNamespaceKey.length === 0) {
    return { status: "unavailable", reason: "missing_dedup_namespace_key", events: [], captures: 0, malformed: 0, cursor: { version: 2, pending: [] } };
  }
  let DatabaseSync;
  let database;
  try {
    const fileStat = await fs.stat(filePath, { bigint: true });
    if (!fileStat.isFile()) return inaccessibleResult({ code: "ENOENT" });
    if (typeof fileStat.dev !== "bigint"
      || typeof fileStat.ino !== "bigint"
      || typeof fileStat.birthtimeNs !== "bigint") {
      return { status: "unavailable", reason: "file_identity_unavailable", events: [], captures: 0, malformed: 0, cursor: { version: 2, pending: [] } };
    }
    const fileIdentity = hmacAlias(options.localAliasKey, "antigravity-desktop-file-instance", [
      path.resolve(filePath), String(fileStat.dev), String(fileStat.ino), String(fileStat.birthtimeNs)
    ].join("\0"));
    DatabaseSync = await databaseConstructor(options);
    database = new DatabaseSync(filePath, { readOnly: true });
    const schema = database.prepare("PRAGMA table_info(steps)").all();
    const names = new Set(schema.map((column) => column?.name));
    if (!["idx", "status", "metadata"].every((name) => names.has(name))) {
      database.close();
      return { status: "unavailable", reason: "unsupported_steps_schema", events: [], captures: 0, malformed: 0, cursor: { version: 2, pending: [] } };
    }
    const schemaIdentity = fingerprintStepsSchema(options.localAliasKey, schema);
    // This is intentionally the only data query. Do not widen it: adjacent
    // columns can contain prompts, responses, tool outputs, or render data.
    const rows = database.prepare("SELECT idx, status, metadata FROM steps ORDER BY idx ASC").all();
    database.close();
    database = null;
    const alias = hmacAlias(options.localAliasKey, "antigravity-desktop-conversation", path.resolve(filePath));
    const resolveModel = options.canonicalModelId || canonicalModelId;
    let { highWatermark, pending, reset } = cursorState(options.cursor, fileIdentity, schemaIdentity);
    const highestObservedIndex = rows.reduce((highest, row) => {
      const index = safeInteger(row?.idx);
      return index === null ? highest : Math.max(highest, index);
    }, -1);
    const observedIndexes = new Set(rows.map((row) => safeInteger(row?.idx)).filter((index) => index !== null));
    // A lower high-watermark cannot be trusted after a rewrite/truncation even
    // if filesystem metadata happened to survive. Rescan from a clean cursor.
    if (!reset && (highestObservedIndex < highWatermark
      || [...pending.keys()].some((index) => !observedIndexes.has(index)))) {
      highWatermark = -1;
      pending = new Map();
      reset = true;
    }
    const events = [];
    let captures = 0;
    let malformed = 0;
    let pendingTruncated = false;
    const maximumEvents = Number.isSafeInteger(options.maximumEvents) && options.maximumEvents >= 0
      ? options.maximumEvents
      : Number.POSITIVE_INFINITY;
    const { minimum, maximum } = observedBounds(options);
    for (const row of rows) {
      const index = safeInteger(row?.idx);
      if (index === null) { malformed += 1; continue; }
      const pendingStatus = pending.get(index);
      if (index <= highWatermark && pendingStatus === undefined) continue;
      if (row?.status !== 3) {
        if (pendingStatus === undefined && pending.size >= MAX_PENDING_STEPS) {
          pendingTruncated = true;
          break;
        }
        pending.set(index, "open");
        if (index > highWatermark) highWatermark = index;
        continue;
      }
      if (!(row.metadata instanceof Uint8Array || Buffer.isBuffer(row.metadata))) {
        malformed += 1;
        pending.delete(index);
        if (index > highWatermark) highWatermark = index;
        continue;
      }
      const decoded = decodeAntigravityDesktopMetadata(row.metadata);
      if (!decoded) {
        malformed += 1;
        pending.delete(index);
        if (index > highWatermark) highWatermark = index;
        continue;
      }
      if (!decoded.usage) {
        pending.delete(index);
        if (index > highWatermark) highWatermark = index;
        continue;
      }
      if (!decoded.observedAt) {
        malformed += 1;
        pending.delete(index);
        if (index > highWatermark) highWatermark = index;
        continue;
      }
      captures += 1;
      const observedAtMs = Date.parse(decoded.observedAt);
      const deferred = events.length >= maximumEvents
        || (Number.isFinite(observedAtMs) && (observedAtMs < minimum || observedAtMs >= maximum));
      if (deferred) {
        if (pendingStatus === undefined && pending.size >= MAX_PENDING_STEPS) {
          pendingTruncated = true;
          break;
        }
        pending.set(index, "completed");
        if (index > highWatermark) highWatermark = index;
        continue;
      }
      const details = modelDetails(decoded.usage.modelEnum, resolveModel);
      const usage = normalizeUsage({
        input_tokens: decoded.usage.input,
        cache_read_input_tokens: decoded.usage.cacheRead,
        cache_creation_input_tokens: decoded.usage.cacheWrite,
        // In desktop 2.3.1, output_tokens already equals visible response plus
        // thinking output. Keep thinking as a diagnostic subset; never add it
        // to the raw total a second time.
        output_tokens: decoded.usage.output,
        reasoning_output_tokens: decoded.usage.thinking
      }, details.provider);
      const outputInvariantConflict = decoded.usage.response !== null
        && decoded.usage.output !== decoded.usage.thinking + decoded.usage.response;
      const safeUsage = outputInvariantConflict
        ? { ...usage, reportedTotal: usage.total, componentConflict: true }
        : usage;
      if (outputInvariantConflict) malformed += 1;
      events.push({
        eventId: accountScopedEventId(options.dedupNamespaceKey, "gemini", `antigravity-desktop-sqlite\0${alias}\0${index}`),
        provider: details.provider,
        serviceProviderId: "gemini",
        modelId: details.modelId,
        sourceModelId: details.sourceModelId,
        aggregationScope: alias,
        observedAt: decoded.observedAt,
        mode: details.mode,
        usage: safeUsage,
        provenance: {
          collector: DESKTOP_COLLECTOR,
          verification: "connector_attested_version_pinned",
          surface: "antigravity"
        }
      });
      pending.delete(index);
      if (index > highWatermark) highWatermark = index;
    }
    const cursor = {
      version: 2,
      conversationAlias: alias,
      fileIdentity,
      schemaIdentity,
      highWatermark,
      pending: [...pending.entries()]
        .sort(([left], [right]) => left - right)
        .map(([index, status]) => ({ index, status }))
    };
    return {
      status: pendingTruncated ? "partial" : "available_version_pinned",
      reason: pendingTruncated ? "pending_cap" : (captures > 0 ? null : "no_completed_usage"),
      events,
      captures,
      malformed,
      partial: pendingTruncated,
      cursorReset: reset,
      cursor
    };
  } catch (error) {
    try { database?.close(); } catch { /* already closed */ }
    if (["ENOENT", "EACCES", "EPERM", "SQLITE_CANTOPEN"].includes(error?.code)) return inaccessibleResult(error);
    throw error;
  }
}

export { DESKTOP_COLLECTOR as ANTIGRAVITY_DESKTOP_COLLECTOR };
