import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sanitizeAntigravityStatusline } from "./adapters/antigravity-statusline.mjs";
import { ConnectorError } from "./errors.mjs";
import { atomicWriteJson } from "./state.mjs";

const MAX_STATUSLINE_STDIN_BYTES = 256 * 1024;

function quoteCommandArgument(value) {
  return `"${String(value).replaceAll("\\\"", "\\\\\"")}"`;
}

async function readJsonIfPresent(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function readStdinBounded(readable, maximum = MAX_STATUSLINE_STDIN_BYTES) {
  const chunks = [];
  let total = 0;
  for await (const chunk of readable) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > maximum) {
      throw new ConnectorError("ANTIGRAVITY_STATUSLINE_STDIN_TOO_LARGE", "Antigravity status-line input exceeds the 256 KiB privacy limit.");
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

async function appendSanitizedCapture(capturePath, wrapperStatePath, capture, state) {
  if (!capture || state.lastFingerprint === capture.snapshotFingerprint) return false;
  await fs.mkdir(path.dirname(capturePath), { recursive: true, mode: 0o700 });
  // One bounded write in append mode keeps each JSONL record intact; the raw
  // status-line buffer is never written to disk.
  const handle = await fs.open(capturePath, "a", 0o600);
  try {
    await handle.writeFile(JSON.stringify(capture) + "\n", "utf8");
  } finally {
    await handle.close();
  }
  await atomicWriteJson(wrapperStatePath, { ...state, lastFingerprint: capture.snapshotFingerprint });
  return true;
}

async function forwardPreviousCommand(command, input, options = {}) {
  if (typeof command !== "string" || command.length === 0) return 0;
  const child = (options.spawnImpl || spawn)(command, {
    shell: true,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"]
  });
  child.stdout.pipe(options.stdout || process.stdout);
  child.stderr.pipe(options.stderr || process.stderr);
  child.stdin.end(input);
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(Number.isInteger(code) ? code : (signal ? 1 : 0)));
  });
}

export async function runAntigravityStatuslineWrapper(options = {}) {
  const statePath = options.statePath;
  const capturePath = options.capturePath;
  const secretsPath = options.secretsPath;
  if (!statePath || !capturePath || !secretsPath) {
    throw new ConnectorError("ANTIGRAVITY_WRAPPER_ARGUMENTS_INVALID", "The Antigravity status-line wrapper is missing its private paths.");
  }
  const input = await readStdinBounded(options.stdin || process.stdin);
  const [state, secrets] = await Promise.all([readJsonIfPresent(statePath), readJsonIfPresent(secretsPath)]);
  if (!state || !secrets?.localAliasKey) {
    throw new ConnectorError("ANTIGRAVITY_WRAPPER_STATE_MISSING", "The Antigravity status-line wrapper private state is unavailable.");
  }
  let rawPayload = null;
  try { rawPayload = JSON.parse(input.toString("utf8")); } catch { /* previous command still receives identical input */ }
  const capture = sanitizeAntigravityStatusline(rawPayload, {
    localAliasKey: secrets.localAliasKey,
    now: options.now
  });
  await appendSanitizedCapture(capturePath, statePath, capture, state);
  return forwardPreviousCommand(state.previousStatusLine, input, options);
}

function defaultSettingsPath(roots) {
  return path.join(path.dirname(roots.antigravity), "settings.json");
}

function wrapperCommandFor(options) {
  return [
    quoteCommandArgument(options.nodeExecutable || process.execPath),
    quoteCommandArgument(options.wrapperPath),
    "--state", quoteCommandArgument(options.statePath),
    "--capture", quoteCommandArgument(options.capturePath),
    "--secrets", quoteCommandArgument(options.secretsPath)
  ].join(" ");
}

export async function installAntigravityStatusline(options) {
  const settingsPath = options.settingsPath || defaultSettingsPath(options.roots);
  const statePath = options.statePath || path.join(options.paths.home, "antigravity-statusline-state.json");
  const wrapperPath = options.wrapperPath;
  const capturePath = options.roots.antigravity;
  const existing = await readJsonIfPresent(settingsPath);
  const settings = existing === null ? {} : existing;
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    throw new ConnectorError("ANTIGRAVITY_SETTINGS_INVALID", "Antigravity settings.json must be an object before installing a status-line wrapper.");
  }
  const wrapperCommand = wrapperCommandFor({
    nodeExecutable: options.nodeExecutable,
    wrapperPath,
    statePath,
    capturePath,
    secretsPath: options.paths.secrets
  });
  const prior = await readJsonIfPresent(statePath);
  const privateState = prior && prior.wrapperCommand && settings.statusLine === prior.wrapperCommand
    ? { ...prior, settingsPath, wrapperCommand, capturePath, lastFingerprint: prior.lastFingerprint || null }
    : {
        version: 1,
        settingsPath,
        hadStatusLine: Object.hasOwn(settings, "statusLine"),
        ...(Object.hasOwn(settings, "statusLine") ? { previousStatusLine: structuredClone(settings.statusLine) } : {}),
        wrapperCommand,
        capturePath,
        lastFingerprint: null
      };
  await atomicWriteJson(statePath, privateState);
  try {
    await atomicWriteJson(settingsPath, { ...settings, statusLine: wrapperCommand });
  } catch (error) {
    await fs.rm(statePath, { force: true }).catch(() => {});
    throw error;
  }
  return { installed: true, settingsPath, statePath, capturePath };
}

export async function uninstallAntigravityStatusline(options) {
  const statePath = options.statePath || path.join(options.paths.home, "antigravity-statusline-state.json");
  const state = await readJsonIfPresent(statePath);
  if (!state) return { installed: false, restored: false, preservedUserChange: false };
  const settings = await readJsonIfPresent(state.settingsPath);
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    return { installed: true, restored: false, preservedUserChange: true, reason: "settings_unavailable" };
  }
  if (settings.statusLine !== state.wrapperCommand) {
    // The user owns this newer value. It is already safe to retire TAG's
    // private artifacts because no settings entry points at the wrapper.
    await fs.rm(state.capturePath || options.roots.antigravity, { force: true }).catch(() => {});
    await fs.rm(statePath, { force: true });
    return { installed: true, restored: false, preservedUserChange: true };
  }
  const restored = { ...settings };
  if (state.hadStatusLine) restored.statusLine = state.previousStatusLine;
  else delete restored.statusLine;
  await atomicWriteJson(state.settingsPath, restored);
  await fs.rm(state.capturePath || options.roots.antigravity, { force: true }).catch(() => {});
  await fs.rm(statePath, { force: true });
  return { installed: true, restored: true, preservedUserChange: false };
}

function parseWrapperArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) values[argv[index]] = argv[index + 1];
  return values;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const flags = parseWrapperArguments(process.argv.slice(2));
  runAntigravityStatuslineWrapper({
    statePath: flags["--state"], capturePath: flags["--capture"], secretsPath: flags["--secrets"]
  }).then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`${error.code || "ANTIGRAVITY_WRAPPER_FAILED"}\n`);
    process.exitCode = 1;
  });
}

export { MAX_STATUSLINE_STDIN_BYTES, readStdinBounded };
