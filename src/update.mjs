import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { ConnectorError } from "./errors.mjs";
import { atomicWriteJson } from "./state.mjs";

const OFFICIAL_REPOSITORY = "https://github.com/TheFysionX/TAG-Plugin";
const GITHUB_API_ROOT = "https://api.github.com/repos/TheFysionX/TAG-Plugin";
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const MAX_API_BYTES = 1024 * 1024;
const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 64 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 4_000;
const MAX_REDIRECTS = 4;
const RELEASE_KEYS = ["asset", "commit", "repository", "runtimeStateSchema", "sha256", "tag", "updaterProtocol", "version"];
const ALLOWED_PACKAGE_ROOTS = new Set([
  ".github", "scripts", "src", "test", "package.json", "README.md", "RELEASING.md", "INSTALL.md",
  "PRIVACY.md", "SECURITY.md", "THREAT_MODEL.md", "ONE_PROMPT_INSTALL.md", "install-manifest.json", "LICENSE"
]);
const REQUIRED_FILES = [
  "package.json", "install-manifest.json", "src/cli.mjs", "src/constants.mjs", "src/launcher.mjs",
  "scripts/validate-release-contract.mjs", "README.md", "INSTALL.md", "PRIVACY.md", "SECURITY.md", "THREAT_MODEL.md"
];

function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

export function compareVersions(left, right) {
  const leftMatch = VERSION_PATTERN.exec(left || "");
  const rightMatch = VERSION_PATTERN.exec(right || "");
  if (!leftMatch || !rightMatch) return null;
  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(leftMatch[index]) - Number(rightMatch[index]);
    if (difference !== 0) return difference > 0 ? 1 : -1;
  }
  return 0;
}

export function validateUpdateOffer(value, currentVersion) {
  if (!value || value.available !== true || !exactKeys(value, ["available", "release"])) return null;
  const release = value.release;
  if (!exactKeys(release, RELEASE_KEYS)
    || release.repository !== OFFICIAL_REPOSITORY
    || !VERSION_PATTERN.test(release.version || "")
    || release.tag !== `v${release.version}`
    || release.asset !== `tag-plugin-${release.version}.tgz`
    || !/^[0-9a-f]{40}$/u.test(release.commit || "")
    || !/^[0-9a-f]{64}$/u.test(release.sha256 || "")
    || release.updaterProtocol !== 1
    || release.runtimeStateSchema !== 1
    || compareVersions(release.version, currentVersion) !== 1) {
    return null;
  }
  return Object.freeze({ ...release });
}

async function boundedBytes(response, maximum, code) {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > maximum) {
    throw new ConnectorError(code, "The verified update response exceeded its size limit.");
  }
  if (!response.body?.getReader) {
    const value = Buffer.from(await response.arrayBuffer());
    if (value.length > maximum) throw new ConnectorError(code, "The verified update response exceeded its size limit.");
    return value;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximum) {
      try { await reader.cancel(); } catch { /* the size failure remains authoritative */ }
      throw new ConnectorError(code, "The verified update response exceeded its size limit.");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

function githubHeaders() {
  return {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "TAG-Plugin-Updater"
  };
}

async function githubJson(fetchImpl, url) {
  let response;
  try {
    response = await fetchImpl(url, { headers: githubHeaders(), redirect: "error" });
  } catch (error) {
    throw new ConnectorError("UPDATE_GITHUB_UNAVAILABLE", "GitHub release verification is temporarily unavailable.", {
      cause: error,
      retryable: true
    });
  }
  if (!response.ok) {
    throw new ConnectorError("UPDATE_GITHUB_REJECTED", "GitHub did not return the pinned release metadata.", {
      status: response.status,
      retryable: response.status === 429 || response.status >= 500
    });
  }
  const bytes = await boundedBytes(response, MAX_API_BYTES, "UPDATE_METADATA_TOO_LARGE");
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new ConnectorError("UPDATE_METADATA_INVALID", "GitHub returned invalid release metadata.");
  }
}

function assertApiObjectUrl(value, kind) {
  let url;
  try { url = new URL(value); } catch { throw new ConnectorError("UPDATE_TAG_INVALID", "The release tag did not resolve safely."); }
  if (url.protocol !== "https:" || url.hostname !== "api.github.com" || url.username || url.password
    || url.search || url.hash || !url.pathname.startsWith(`/repos/TheFysionX/TAG-Plugin/git/${kind}/`)) {
    throw new ConnectorError("UPDATE_TAG_INVALID", "The release tag did not resolve safely.");
  }
  return url.toString();
}

async function verifyTag(fetchImpl, release) {
  let object = (await githubJson(fetchImpl, `${GITHUB_API_ROOT}/git/ref/tags/${release.tag}`))?.object;
  for (let depth = 0; depth < 3; depth += 1) {
    if (object?.type === "commit") {
      if (object.sha !== release.commit) throw new ConnectorError("UPDATE_COMMIT_MISMATCH", "The release tag does not match the pinned commit.");
      return;
    }
    if (object?.type !== "tag" || !/^[0-9a-f]{40}$/u.test(object.sha || "")) {
      throw new ConnectorError("UPDATE_TAG_INVALID", "The release tag did not resolve to a commit.");
    }
    const tag = await githubJson(fetchImpl, assertApiObjectUrl(object.url, "tags"));
    object = tag?.object;
  }
  throw new ConnectorError("UPDATE_TAG_INVALID", "The release tag chain was unexpectedly deep.");
}

async function verifiedAssetUrl(fetchImpl, release) {
  const metadata = await githubJson(fetchImpl, `${GITHUB_API_ROOT}/releases/tags/${release.tag}`);
  if (metadata?.tag_name !== release.tag || metadata?.draft !== false || metadata?.prerelease !== false) {
    throw new ConnectorError("UPDATE_RELEASE_INVALID", "The pinned GitHub release is not published and stable.");
  }
  const matches = Array.isArray(metadata.assets)
    ? metadata.assets.filter((asset) => asset?.name === release.asset)
    : [];
  if (matches.length !== 1) throw new ConnectorError("UPDATE_ASSET_INVALID", "The pinned release asset is missing or ambiguous.");
  const expected = `${OFFICIAL_REPOSITORY}/releases/download/${release.tag}/${release.asset}`;
  if (matches[0].browser_download_url !== expected) {
    throw new ConnectorError("UPDATE_ASSET_INVALID", "The release asset URL did not match the official repository.");
  }
  return expected;
}

function allowedDownloadUrl(value, first) {
  let url;
  try { url = new URL(value); } catch { throw new ConnectorError("UPDATE_REDIRECT_REJECTED", "The update download redirected outside GitHub."); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new ConnectorError("UPDATE_REDIRECT_REJECTED", "The update download redirected outside GitHub.");
  }
  if (first) {
    if (url.hostname !== "github.com" || url.search) throw new ConnectorError("UPDATE_REDIRECT_REJECTED", "The update download did not start at GitHub.");
  } else if (!new Set(["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"]).has(url.hostname)) {
    throw new ConnectorError("UPDATE_REDIRECT_REJECTED", "The update download redirected outside GitHub.");
  }
  return url;
}

async function downloadAsset(fetchImpl, initialUrl) {
  let current = allowedDownloadUrl(initialUrl, true);
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    let response;
    try {
      response = await fetchImpl(current, {
        headers: { accept: "application/octet-stream", "user-agent": "TAG-Plugin-Updater" },
        redirect: "manual"
      });
    } catch (error) {
      throw new ConnectorError("UPDATE_DOWNLOAD_UNAVAILABLE", "The pinned release asset could not be downloaded.", {
        cause: error,
        retryable: true
      });
    }
    if (response.status >= 300 && response.status < 400) {
      if (redirect === MAX_REDIRECTS) throw new ConnectorError("UPDATE_REDIRECT_REJECTED", "The update download redirected too many times.");
      const location = response.headers.get("location");
      current = allowedDownloadUrl(new URL(location || "", current), false);
      continue;
    }
    if (!response.ok) {
      throw new ConnectorError("UPDATE_DOWNLOAD_REJECTED", "GitHub did not return the pinned release asset.", {
        status: response.status,
        retryable: response.status === 429 || response.status >= 500
      });
    }
    return boundedBytes(response, MAX_ARCHIVE_BYTES, "UPDATE_ARCHIVE_TOO_LARGE");
  }
  throw new ConnectorError("UPDATE_REDIRECT_REJECTED", "The update download redirected too many times.");
}

function parseOctal(header, start, length, label) {
  const value = header.subarray(start, start + length).toString("ascii").replace(/\0.*$/u, "").trim();
  if (!/^[0-7]+$/u.test(value)) throw new ConnectorError("UPDATE_ARCHIVE_INVALID", `The update archive has an invalid ${label}.`);
  return Number.parseInt(value, 8);
}

function tarName(header) {
  const text = (start, length) => header.subarray(start, start + length).toString("utf8").replace(/\0.*$/u, "");
  const name = text(0, 100);
  const prefix = text(345, 155);
  return prefix ? `${prefix}/${name}` : name;
}

function safeArchivePath(name, type) {
  if (!name || name.length > 300 || name.includes("\\") || /[\u0000-\u001f\u007f\ufffd]/u.test(name)
    || name.startsWith("/") || /^[A-Za-z]:/u.test(name)) {
    throw new ConnectorError("UPDATE_ARCHIVE_PATH_REJECTED", "The update archive contains an unsafe path.");
  }
  const trimmed = type === "5" ? name.replace(/\/+$/u, "") : name;
  const parts = trimmed.split("/");
  if (parts.some((part) => !part || part === "." || part === "..") || parts[0] !== "package" || parts.length < 2) {
    throw new ConnectorError("UPDATE_ARCHIVE_PATH_REJECTED", "The update archive contains an unsafe path.");
  }
  if (!ALLOWED_PACKAGE_ROOTS.has(parts[1])) {
    throw new ConnectorError("UPDATE_ARCHIVE_CONTENT_REJECTED", "The update archive contains an unexpected package entry.");
  }
  return parts.join(path.sep);
}

export async function extractVerifiedArchive(archive, destination, options = {}) {
  let expanded;
  try {
    expanded = gunzipSync(archive, { maxOutputLength: MAX_EXPANDED_BYTES });
  } catch (error) {
    throw new ConnectorError("UPDATE_ARCHIVE_INVALID", "The update archive could not be safely expanded.", { cause: error });
  }
  const fileSystem = options.fileSystem || fs;
  const seen = new Set();
  let offset = 0;
  let count = 0;
  let totalFiles = 0;
  while (offset + 512 <= expanded.length) {
    const header = expanded.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (!expanded.subarray(offset).every((byte) => byte === 0)) {
        throw new ConnectorError("UPDATE_ARCHIVE_INVALID", "The update archive has trailing data.");
      }
      break;
    }
    const expectedChecksum = parseOctal(header, 148, 8, "checksum");
    const checksumHeader = Buffer.from(header);
    checksumHeader.fill(0x20, 148, 156);
    const actualChecksum = checksumHeader.reduce((sum, byte) => sum + byte, 0);
    if (actualChecksum !== expectedChecksum) throw new ConnectorError("UPDATE_ARCHIVE_INVALID", "The update archive checksum is invalid.");
    const type = String.fromCharCode(header[156] || 0);
    if (!new Set(["\0", "0", "5"]).has(type)) {
      throw new ConnectorError("UPDATE_ARCHIVE_TYPE_REJECTED", "The update archive contains a link or unsupported entry.");
    }
    const relative = safeArchivePath(tarName(header), type);
    const collisionKey = process.platform === "win32" ? relative.toLowerCase() : relative;
    if (seen.has(collisionKey)) throw new ConnectorError("UPDATE_ARCHIVE_DUPLICATE", "The update archive contains a duplicate path.");
    seen.add(collisionKey);
    const size = parseOctal(header, 124, 12, "size");
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_EXPANDED_BYTES) {
      throw new ConnectorError("UPDATE_ARCHIVE_TOO_LARGE", "The update archive entry exceeded its size limit.");
    }
    if (type === "5" && size !== 0) throw new ConnectorError("UPDATE_ARCHIVE_INVALID", "The update archive directory has file data.");
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > expanded.length) throw new ConnectorError("UPDATE_ARCHIVE_INVALID", "The update archive was truncated.");
    const target = path.resolve(destination, relative);
    const safeRelative = path.relative(path.resolve(destination), target);
    if (!safeRelative || safeRelative.startsWith("..") || path.isAbsolute(safeRelative)) {
      throw new ConnectorError("UPDATE_ARCHIVE_PATH_REJECTED", "The update archive contains an unsafe path.");
    }
    if (type === "5") {
      await fileSystem.mkdir(target, { recursive: true, mode: 0o700 });
    } else {
      totalFiles += size;
      if (totalFiles > MAX_EXPANDED_BYTES) throw new ConnectorError("UPDATE_ARCHIVE_TOO_LARGE", "The update archive exceeded its expanded size limit.");
      await fileSystem.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await fileSystem.writeFile(target, expanded.subarray(dataStart, dataEnd), { flag: "wx", mode: 0o600 });
    }
    count += 1;
    if (count > MAX_ARCHIVE_ENTRIES) throw new ConnectorError("UPDATE_ARCHIVE_TOO_MANY_FILES", "The update archive contains too many entries.");
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  if (count === 0) throw new ConnectorError("UPDATE_ARCHIVE_INVALID", "The update archive is empty.");
  return { entries: count, expandedBytes: totalFiles };
}

async function jsonFile(filePath, maximum = 256 * 1024) {
  const text = await fs.readFile(filePath, "utf8");
  if (Buffer.byteLength(text, "utf8") > maximum) throw new ConnectorError("UPDATE_CONTRACT_INVALID", "The update package contract is too large.");
  try { return JSON.parse(text); } catch { throw new ConnectorError("UPDATE_CONTRACT_INVALID", "The update package contract is invalid."); }
}

async function validateExtractedRelease(packageRoot, release) {
  for (const required of REQUIRED_FILES) {
    const stat = await fs.lstat(path.join(packageRoot, required)).catch(() => null);
    if (!stat || !stat.isFile() || stat.isSymbolicLink()) {
      throw new ConnectorError("UPDATE_CONTRACT_INVALID", "The update package is missing a required regular file.");
    }
  }
  const [packageJson, manifest, constants] = await Promise.all([
    jsonFile(path.join(packageRoot, "package.json")),
    jsonFile(path.join(packageRoot, "install-manifest.json")),
    fs.readFile(path.join(packageRoot, "src", "constants.mjs"), "utf8")
  ]);
  if (packageJson.name !== "@the-artificial-games/tag-plugin" || packageJson.version !== release.version
    || (packageJson.dependencies && Object.keys(packageJson.dependencies).length > 0)
    || manifest?.product?.repository !== OFFICIAL_REPOSITORY
    || manifest?.product?.package !== "@the-artificial-games/tag-plugin"
    || manifest.connectorVersion !== release.version
    || manifest?.releaseArtifact?.archiveName !== release.asset
    || manifest?.updates?.updaterProtocol !== 1
    || manifest?.updates?.runtimeStateSchema !== 1
    || !Array.isArray(manifest?.runtime?.thirdPartyDependencies)
    || manifest.runtime.thirdPartyDependencies.length !== 0
    || !new RegExp(`export const CONNECTOR_VERSION = ["']${release.version.replaceAll(".", "\\.")}["'];`).test(constants)) {
    throw new ConnectorError("UPDATE_CONTRACT_INVALID", "The update package does not match the pinned release contract.");
  }
}

function releaseIdentityFor(release) {
  return {
    schemaVersion: 1,
    repository: release.repository,
    version: release.version,
    tag: release.tag,
    commit: release.commit,
    asset: release.asset,
    sha256: release.sha256,
    updaterProtocol: release.updaterProtocol,
    runtimeStateSchema: release.runtimeStateSchema
  };
}

async function installedFileManifest(packageRoot, options = {}) {
  const allowReceipt = options.allowReceipt === true;
  const entries = await fs.readdir(packageRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!ALLOWED_PACKAGE_ROOTS.has(entry.name) && !(allowReceipt && entry.name === "release-receipt.json")) {
      throw new ConnectorError("VERSION_IDENTITY_CONFLICT", "The installed update contains an unexpected entry.");
    }
  }
  const files = {};
  async function visit(relative) {
    const absolute = path.join(packageRoot, relative);
    const stat = await fs.lstat(absolute);
    if (stat.isSymbolicLink()) {
      throw new ConnectorError("VERSION_IDENTITY_CONFLICT", "The installed update contains a symbolic link.");
    }
    if (stat.isDirectory()) {
      const children = (await fs.readdir(absolute)).sort((left, right) => left.localeCompare(right));
      for (const child of children) await visit(path.join(relative, child));
      return;
    }
    if (!stat.isFile()) {
      throw new ConnectorError("VERSION_IDENTITY_CONFLICT", "The installed update contains an unsupported entry.");
    }
    const normalized = relative.split(path.sep).join("/");
    files[normalized] = createHash("sha256").update(await fs.readFile(absolute)).digest("hex");
  }
  for (const entry of [...ALLOWED_PACKAGE_ROOTS].sort((left, right) => left.localeCompare(right))) {
    const stat = await fs.lstat(path.join(packageRoot, entry)).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
    if (stat) await visit(entry);
  }
  return files;
}

function receiptFor(release, files) {
  return { ...releaseIdentityFor(release), files };
}

function sameReceipt(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function fetchAndInstallUpdate(paths, release, options = {}) {
  const fetchImpl = options.updateFetchImpl || options.fetchImpl || globalThis.fetch;
  await verifyTag(fetchImpl, release);
  const assetUrl = await verifiedAssetUrl(fetchImpl, release);
  const archive = await downloadAsset(fetchImpl, assetUrl);
  const digest = createHash("sha256").update(archive).digest("hex");
  if (digest !== release.sha256) throw new ConnectorError("UPDATE_SHA256_MISMATCH", "The release archive did not match the pinned SHA-256.");
  const versionsRoot = path.join(paths.home, "versions");
  const stagingRoot = path.join(versionsRoot, `.update-${release.version}-${process.pid}-${randomBytes(6).toString("hex")}`);
  const packageRoot = path.join(stagingRoot, "package");
  const destination = path.join(versionsRoot, release.version);
  await fs.mkdir(versionsRoot, { recursive: true, mode: 0o700 });
  await fs.mkdir(stagingRoot, { recursive: false, mode: 0o700 });
  try {
    await extractVerifiedArchive(archive, stagingRoot, options);
    await validateExtractedRelease(packageRoot, release);
    const receipt = receiptFor(release, await installedFileManifest(packageRoot));
    await fs.writeFile(path.join(packageRoot, "release-receipt.json"), JSON.stringify(receipt, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx"
    });
    const existing = await fs.lstat(destination).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
    if (existing) {
      if (!existing.isDirectory() || existing.isSymbolicLink()) {
        throw new ConnectorError("VERSION_IDENTITY_CONFLICT", "The target update version already exists with another identity.");
      }
      const existingReceipt = await jsonFile(path.join(destination, "release-receipt.json")).catch(() => null);
      await validateExtractedRelease(destination, release).catch(() => {
        throw new ConnectorError("VERSION_IDENTITY_CONFLICT", "The target update version already exists with another identity.");
      });
      const verifiedExistingReceipt = receiptFor(release, await installedFileManifest(destination, { allowReceipt: true }));
      if (!sameReceipt(existingReceipt, receipt) || !sameReceipt(existingReceipt, verifiedExistingReceipt)) {
        throw new ConnectorError("VERSION_IDENTITY_CONFLICT", "The target update version already exists with another identity.");
      }
      return { installed: false, reused: true, destination, receipt };
    }
    await fs.rename(packageRoot, destination);
    return { installed: true, reused: false, destination, receipt };
  } finally {
    await fs.rm(stagingRoot, { recursive: true, force: true });
  }
}

export async function installStableLauncher(paths, launcherSource) {
  const contents = await fs.readFile(launcherSource);
  if (contents.length === 0 || contents.length > 128 * 1024) {
    throw new ConnectorError("LAUNCHER_INVALID", "The verified TAG Plugin launcher is invalid.");
  }
  const existing = await fs.readFile(paths.launcher).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (existing) {
    if (!existing.equals(contents)) throw new ConnectorError("LAUNCHER_IDENTITY_CONFLICT", "The stable TAG Plugin launcher has an unexpected identity.");
    return { installed: false };
  }
  const temporary = `${paths.launcher}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  await fs.writeFile(temporary, contents, { mode: 0o600, flag: "wx" });
  try {
    await fs.rename(temporary, paths.launcher);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
  return { installed: true };
}

export async function activateRelease(paths, release, receipt = null) {
  const prior = await jsonFile(paths.activeRelease, 32 * 1024).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw new ConnectorError("ACTIVE_RELEASE_INVALID", "The active TAG Plugin release pointer is invalid.", { cause: error });
  });
  const validEntry = (entry) => entry && typeof entry === "object" && !Array.isArray(entry)
    && VERSION_PATTERN.test(entry.version || "")
    && (entry.receipt === undefined || (entry.receipt && typeof entry.receipt === "object" && !Array.isArray(entry.receipt)
      && entry.receipt.version === entry.version));
  if (prior && (prior.schemaVersion !== 1 || !validEntry(prior.current)
    || (prior.previous !== null && prior.previous !== undefined && !validEntry(prior.previous)))) {
    throw new ConnectorError("ACTIVE_RELEASE_INVALID", "The active TAG Plugin release pointer is invalid.");
  }
  const current = { version: release.version, ...(receipt ? { receipt } : {}) };
  const previous = prior?.schemaVersion === 1 && prior.current?.version !== release.version
    ? prior.current
    : (prior?.previous ?? null);
  await atomicWriteJson(paths.activeRelease, {
    schemaVersion: 1,
    current,
    previous,
    updatedAt: new Date().toISOString()
  });
  return { current, previous };
}

export async function readUpdateState(paths) {
  return jsonFile(paths.updateState, 64 * 1024).catch((error) => error?.code === "ENOENT" ? {
    schemaVersion: 1,
    installedVersion: null,
    lastOfferDigest: null,
    lastCheckedAt: null,
    lastResult: null,
    safeErrorCode: null,
    permanentFailure: false
  } : Promise.reject(error));
}

export async function writeUpdateState(paths, value) {
  await atomicWriteJson(paths.updateState, { schemaVersion: 1, ...value });
}

export function updateOfferDigest(release) {
  return createHash("sha256").update(JSON.stringify(releaseIdentityFor(release))).digest("hex");
}
