import { open, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deserialize } from "node:v8";

const MAX_COMPRESSED_BYTES = 8 * 1024 * 1024;
const MAX_DECOMPRESSED_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_CACHE_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_DISCOVERED_FILES = 4_096;
const MAX_CACHE_FILES_TO_INSPECT = 512;
const MAX_TOTAL_COMPRESSED_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_DECOMPRESSED_BYTES = 64 * 1024 * 1024;
const MAX_DISCOVERED_DIRECTORIES = 512;
const MAX_CACHE_DEPTH = 4;
const BLINK_ENVELOPE_BYTES = 15;
const CLAUDE_RATE_LIMIT_TIERS = new Map([
  ["default_claude_max_5x", "max-5x"],
  ["default_claude_max_20x", "max-20x"]
]);
const CLAUDE_MAX_BILLING_TYPES = new Set(["stripe_subscription"]);

function readVarint(buffer, start, maxBytes = 5) {
  let value = 0;
  let shift = 0;
  let offset = start;
  while (offset < buffer.length && offset - start < maxBytes) {
    const byte = buffer[offset];
    value += (byte & 0x7f) * (2 ** shift);
    offset += 1;
    if ((byte & 0x80) === 0) return { value, next: offset };
    shift += 7;
  }
  return null;
}

function readUnsignedLittleEndian(buffer, start, byteCount) {
  if (start + byteCount > buffer.length) return null;
  let value = 0;
  for (let index = 0; index < byteCount; index += 1) {
    value += buffer[start + index] * (2 ** (index * 8));
  }
  return value;
}

// Chromium stores large IndexedDB values as raw Snappy blocks. This implements
// the four element types from the public Snappy format and rejects malformed or
// oversized input before allocating output memory.
export function decompressRawSnappy(input, options = {}) {
  const maxOutputBytes = options.maxOutputBytes || MAX_DECOMPRESSED_BYTES;
  const lengthHeader = readVarint(input, 0, 5);
  if (!lengthHeader || lengthHeader.value < 1 || lengthHeader.value > maxOutputBytes) {
    throw new Error("invalid_snappy_length");
  }
  const output = Buffer.allocUnsafe(lengthHeader.value);
  let inputOffset = lengthHeader.next;
  let outputOffset = 0;

  while (inputOffset < input.length) {
    const typeByte = input[inputOffset];
    inputOffset += 1;
    const elementType = typeByte & 0x03;

    if (elementType === 0) {
      const encodedLength = typeByte >>> 2;
      let literalLength;
      if (encodedLength < 60) {
        literalLength = encodedLength + 1;
      } else {
        const byteCount = encodedLength - 59;
        const lengthMinusOne = readUnsignedLittleEndian(input, inputOffset, byteCount);
        if (lengthMinusOne === null) throw new Error("truncated_snappy_literal_length");
        inputOffset += byteCount;
        literalLength = lengthMinusOne + 1;
      }
      if (inputOffset + literalLength > input.length || outputOffset + literalLength > output.length) {
        throw new Error("invalid_snappy_literal");
      }
      input.copy(output, outputOffset, inputOffset, inputOffset + literalLength);
      inputOffset += literalLength;
      outputOffset += literalLength;
      continue;
    }

    let copyLength;
    let copyOffset;
    if (elementType === 1) {
      if (inputOffset >= input.length) throw new Error("truncated_snappy_copy");
      copyLength = ((typeByte >>> 2) & 0x07) + 4;
      copyOffset = ((typeByte & 0xe0) << 3) | input[inputOffset];
      inputOffset += 1;
    } else if (elementType === 2) {
      copyLength = (typeByte >>> 2) + 1;
      copyOffset = readUnsignedLittleEndian(input, inputOffset, 2);
      inputOffset += 2;
    } else {
      copyLength = (typeByte >>> 2) + 1;
      copyOffset = readUnsignedLittleEndian(input, inputOffset, 4);
      inputOffset += 4;
    }
    if (!Number.isSafeInteger(copyOffset) || copyOffset <= 0 || copyOffset > outputOffset
      || inputOffset > input.length || outputOffset + copyLength > output.length) {
      throw new Error("invalid_snappy_copy");
    }
    for (let index = 0; index < copyLength; index += 1) {
      output[outputOffset + index] = output[outputOffset + index - copyOffset];
    }
    outputOffset += copyLength;
  }

  if (outputOffset !== output.length) throw new Error("snappy_length_mismatch");
  return output;
}

function normalizedOrganizationId(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return /^[a-z0-9][a-z0-9_-]{7,127}$/iu.test(normalized) ? normalized : null;
}

function deserializeBlinkStructuredClone(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length <= BLINK_ENVELOPE_BYTES
    || buffer[0] !== 0xff || buffer[1] !== 0x15 || buffer[2] !== 0xfe
    || buffer.subarray(3, BLINK_ENVELOPE_BYTES).some((byte) => byte !== 0)
    || buffer[BLINK_ENVELOPE_BYTES] !== 0xff) return null;
  try {
    return deserialize(buffer.subarray(BLINK_ENVELOPE_BYTES));
  } catch {
    return null;
  }
}

export function extractClaudePlanFromStructuredClone(buffer, options = {}) {
  const expectedOrgId = normalizedOrganizationId(options.expectedOrgId);
  if (!expectedOrgId) return null;
  const root = deserializeBlinkStructuredClone(buffer);
  const queries = root?.clientState?.queries;
  if (!Array.isArray(queries) || queries.length > 128) return null;
  const matched = [];
  for (const query of queries) {
    const memberships = query?.state?.data?.account?.memberships;
    if (!Array.isArray(memberships) || memberships.length > 64) continue;
    for (const membership of memberships) {
      const organization = membership?.organization;
      if (!organization || organization.uuid !== expectedOrgId
        || !Array.isArray(organization.capabilities)
        || organization.capabilities.length > 128
        || !Object.hasOwn(organization, "rate_limit_tier")
        || !Object.hasOwn(organization, "billing_type")) continue;
      const maxEntitled = organization.capabilities.includes("claude_max");
      if (maxEntitled && (!CLAUDE_MAX_BILLING_TYPES.has(organization.billing_type)
        || !CLAUDE_RATE_LIMIT_TIERS.has(organization.rate_limit_tier))) continue;
      matched.push({ maxEntitled, rateLimitTier: maxEntitled ? organization.rate_limit_tier : null });
    }
  }
  if (matched.length === 0 || matched.some((entry) => entry.maxEntitled !== matched[0].maxEntitled
    || entry.rateLimitTier !== matched[0].rateLimitTier)) return null;
  if (!matched[0].maxEntitled) return { rawPlanCode: null, maxEntitled: false };
  const rateLimitTier = matched[0].rateLimitTier;
  return { rawPlanCode: CLAUDE_RATE_LIMIT_TIERS.get(rateLimitTier), rateLimitTier };
}

export function extractClaudePlanFromDesktopCache(buffer, options = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4
    || buffer[0] !== 0xff || buffer[1] !== 0x11 || buffer[2] !== 0x02) {
    return null;
  }
  let structuredClone;
  try {
    structuredClone = decompressRawSnappy(buffer.subarray(3));
  } catch {
    return null;
  }
  return extractClaudePlanFromStructuredClone(structuredClone, options);
}

function desktopCacheDecompressedLength(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4
    || buffer[0] !== 0xff || buffer[1] !== 0x11 || buffer[2] !== 0x02) return null;
  return readVarint(buffer, 3, 5)?.value ?? null;
}

function envPlanEvidence(env, expectedOrgId) {
  const subscriptionType = String(env?.CLAUDE_CODE_SUBSCRIPTION_TYPE || "").trim().toLowerCase();
  const rateLimitTier = String(env?.CLAUDE_CODE_RATE_LIMIT_TIER || "").trim().toLowerCase();
  const environmentOrgId = normalizedOrganizationId(env?.CLAUDE_CODE_ORGANIZATION_UUID);
  const rawPlanCode = subscriptionType === "max" && environmentOrgId === expectedOrgId
    ? CLAUDE_RATE_LIMIT_TIERS.get(rateLimitTier)
    : null;
  return rawPlanCode ? {
    status: "available",
    verification: "provider_backed_claude_process_entitlement",
    subscriptionType: "max",
    rateLimitTier,
    rawPlanCode
  } : null;
}

async function directoryExists(directory) {
  try {
    return (await stat(directory)).isDirectory();
  } catch {
    return false;
  }
}

async function defaultDesktopCacheRoots(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const home = options.home || env.USERPROFILE || env.HOME || os.homedir();
  const roots = [];
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    const appData = env.APPDATA || path.join(home, "AppData", "Roaming");
    roots.push(path.join(appData, "Claude", "IndexedDB", "https_claude.ai_0.indexeddb.blob"));
    roots.push(path.join(localAppData, "Claude", "IndexedDB", "https_claude.ai_0.indexeddb.blob"));
    const packages = path.join(localAppData, "Packages");
    try {
      for (const entry of await readdir(packages, { withFileTypes: true })) {
        if (entry.isDirectory() && /^Claude_/iu.test(entry.name)) {
          roots.push(path.join(packages, entry.name, "LocalCache", "Roaming", "Claude", "IndexedDB", "https_claude.ai_0.indexeddb.blob"));
        }
      }
    } catch {
      // Claude Desktop may not be installed through MSIX.
    }
  } else if (platform === "darwin") {
    roots.push(path.join(home, "Library", "Application Support", "Claude", "IndexedDB", "https_claude.ai_0.indexeddb.blob"));
  } else {
    roots.push(path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "Claude", "IndexedDB", "https_claude.ai_0.indexeddb.blob"));
  }
  const existing = [];
  for (const root of roots) {
    if (await directoryExists(root)) existing.push(root);
  }
  return existing;
}

async function discoverCacheFiles(root, state, depth = 0) {
  if (depth > MAX_CACHE_DEPTH || state.files.length >= MAX_DISCOVERED_FILES
    || state.directories >= MAX_DISCOVERED_DIRECTORIES) return;
  state.directories += 1;
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (state.files.length >= MAX_DISCOVERED_FILES
      || state.directories >= MAX_DISCOVERED_DIRECTORIES) return;
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) await discoverCacheFiles(target, state, depth + 1);
    else if (entry.isFile()) state.files.push(target);
  }
}

async function readBoundedFile(file, maximumBytes) {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.allocUnsafe(maximumBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return {
      buffer: offset > maximumBytes ? null : buffer.subarray(0, offset),
      bytesRead: offset,
      metadata: await handle.stat()
    };
  } finally {
    await handle.close();
  }
}

export async function readClaudePlanEvidence(options = {}) {
  const expectedOrgId = normalizedOrganizationId(options.expectedOrgId);
  if (!expectedOrgId) return { status: "unavailable", reason: "current_account_identity_unavailable" };
  const direct = envPlanEvidence(options.env || process.env, expectedOrgId);
  if (direct) return direct;

  const nowMs = Number(options.now ?? Date.now());
  const maxAgeMs = options.maxAgeMs || DEFAULT_MAX_CACHE_AGE_MS;
  const roots = options.desktopCacheRoots || await defaultDesktopCacheRoots(options);
  const discovery = { files: [], directories: 0 };
  for (const root of roots) await discoverCacheFiles(root, discovery);
  const metadataCandidates = [];
  for (const file of discovery.files) {
    try {
      const metadata = await stat(file);
      if (!metadata.isFile() || metadata.size < 4 || metadata.size > MAX_COMPRESSED_BYTES
        || nowMs - metadata.mtimeMs > maxAgeMs || metadata.mtimeMs > nowMs + 5 * 60 * 1000) continue;
      metadataCandidates.push({ file, observedAtMs: metadata.mtimeMs, size: metadata.size });
    } catch {
      // Locked and removed cache entries are ignored independently.
    }
  }
  metadataCandidates.sort((left, right) => right.observedAtMs - left.observedAtMs);
  const candidates = [];
  let inspectedBytes = 0;
  let decompressedBytes = 0;
  for (const candidate of metadataCandidates.slice(0, MAX_CACHE_FILES_TO_INSPECT)) {
    const remainingCompressedBytes = MAX_TOTAL_COMPRESSED_BYTES - inspectedBytes;
    if (remainingCompressedBytes < 4) break;
    if (candidate.size > remainingCompressedBytes) continue;
    try {
      const { buffer, bytesRead, metadata } = await readBoundedFile(
        candidate.file,
        Math.min(MAX_COMPRESSED_BYTES, remainingCompressedBytes)
      );
      inspectedBytes += bytesRead;
      if (!buffer || inspectedBytes > MAX_TOTAL_COMPRESSED_BYTES) break;
      if (!metadata.isFile() || metadata.size < 4 || metadata.size > MAX_COMPRESSED_BYTES
        || nowMs - metadata.mtimeMs > maxAgeMs || metadata.mtimeMs > nowMs + 5 * 60 * 1000) continue;
      const outputBytes = desktopCacheDecompressedLength(buffer);
      if (!Number.isSafeInteger(outputBytes) || outputBytes < 1 || outputBytes > MAX_DECOMPRESSED_BYTES
        || decompressedBytes + outputBytes > MAX_TOTAL_DECOMPRESSED_BYTES) continue;
      decompressedBytes += outputBytes;
      const plan = extractClaudePlanFromDesktopCache(buffer, { expectedOrgId });
      if (plan) candidates.push({ ...plan, observedAtMs: metadata.mtimeMs });
    } catch {
      // Locked, partial, and obsolete cache entries are ignored independently.
    }
  }
  candidates.sort((left, right) => right.observedAtMs - left.observedAtMs);
  if (candidates.length === 0) return { status: "unavailable", reason: "exact_plan_evidence_not_found" };
  const newest = candidates[0];
  const conflicting = candidates.find((candidate) => (candidate.rawPlanCode !== newest.rawPlanCode
    || candidate.maxEntitled !== newest.maxEntitled)
    && newest.observedAtMs - candidate.observedAtMs < 60 * 1000);
  if (conflicting) return { status: "unavailable", reason: "ambiguous_exact_plan_evidence" };
  return {
    status: "available",
    verification: "provider_backed_claude_desktop_account_cache",
    ...(newest.maxEntitled === false ? {} : { subscriptionType: "max" }),
    rateLimitTier: newest.rateLimitTier,
    rawPlanCode: newest.rawPlanCode,
    ...(newest.maxEntitled === false ? { maxEntitled: false } : {}),
    cacheUpdatedAt: new Date(newest.observedAtMs).toISOString()
  };
}
