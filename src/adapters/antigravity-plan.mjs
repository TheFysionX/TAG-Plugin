import { execFile as nodeExecFile } from "node:child_process";
import https from "node:https";
import tls from "node:tls";
import { detectAntigravityDesktopVersion } from "./antigravity-desktop.mjs";

const MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 2_000;
const USER_STATUS_PATH = "/exa.language_server_pb.LanguageServerService/GetUserStatus";

// `userStatus.planStatus.planInfo` is Antigravity's retail-plan authority.
// userTier is a separate quota-family field and must never reclassify a retail
// subscription. Keep this list literal and conservative: unknown provider
// names are recorded as unknown rather than guessed from their wording.
const RETAIL_PLAN_NAMES = new Map([
  ["free", "free"],
  ["ai free", "free"],
  ["google ai free", "free"],
  ["starter", "free"],
  ["plus", "plus"],
  ["ai plus", "plus"],
  ["google ai plus", "plus"],
  ["pro", "pro"],
  ["ai pro", "pro"],
  ["google ai pro", "pro"],
  ["ultra", "ultra"],
  ["ai ultra", "ultra"],
  ["google ai ultra", "ultra"],
  ["ultra 5x", "ultra-5x"],
  ["ai ultra 5x", "ultra-5x"],
  ["google ai ultra 5x", "ultra-5x"],
  ["ultra 20x", "ultra-20x"],
  ["ai ultra 20x", "ultra-20x"],
  ["google ai ultra 20x", "ultra-20x"]
]);

function normalizedCode(value) {
  if (typeof value !== "string" || value.length > 80) return null;
  const normalized = value.trim().toLowerCase().replace(/[.\-\s]+/gu, "_");
  return /^[a-z0-9_]+$/u.test(normalized) ? normalized : null;
}

function planFromStatus(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const userStatus = value.userStatus && typeof value.userStatus === "object" && !Array.isArray(value.userStatus)
    ? value.userStatus
    : value;
  if (userStatus.signedIn === false || userStatus.authenticated === false
    || normalizedCode(userStatus.authState) === "signed_out") {
    return { kind: "signed_out" };
  }
  const planInfo = userStatus.planStatus?.planInfo;
  const planName = typeof planInfo?.planName === "string" && planInfo.planName.length <= 120
    ? planInfo.planName.trim().toLowerCase().replace(/\s+/gu, " ")
    : null;
  // An absent planInfo can happen during local-server startup and must retain
  // the previously reported plan rather than overwrite it with a guess.
  if (!planName) return { kind: "unavailable" };
  return { kind: "available", rawPlanCode: RETAIL_PLAN_NAMES.get(planName) || "unknown" };
}

function positivePort(value) {
  const number = typeof value === "number" ? value : Number.parseInt(String(value || ""), 10);
  return Number.isInteger(number) && number >= 1 && number <= 65_535 ? number : null;
}

function loopbackAddress(value) {
  return typeof value === "string" && ["127.0.0.1", "::1", "localhost"].includes(value.trim().toLowerCase());
}

function commandArgument(commandLine, name) {
  if (typeof commandLine !== "string" || commandLine.length > 32 * 1024) return null;
  // Antigravity's server uses space-separated flags. Do not accept a quoted
  // value; a token is deliberately constrained and never returned to callers.
  const match = new RegExp(`(?:^|\\s)--${name}\\s+([^\\s"']+)`, "iu").exec(commandLine);
  return match ? match[1] : null;
}

function languageServerCandidate(process) {
  if (!process || typeof process !== "object" || process.sameUser !== true) return null;
  const name = String(process.name || "").toLowerCase();
  const executablePath = typeof process.executablePath === "string" ? process.executablePath.replace(/\//gu, "\\") : "";
  const commandLine = typeof process.commandLine === "string" ? process.commandLine : "";
  if (!/^(language_server|language_server\.exe)$/u.test(name)
    || !/\\antigravity\\resources\\bin\\language_server\.exe$/iu.test(executablePath)
    || commandArgument(commandLine, "override_ide_version") !== "2.3.1"
    || !/(?:^|\s)--override_ide_name\s+antigravity(?:\s|$)/iu.test(commandLine)) return null;
  const csrfToken = commandArgument(commandLine, "csrf_token");
  if (!csrfToken || !/^[a-z0-9._-]{16,256}$/iu.test(csrfToken)) return null;
  const advertisedPort = positivePort(commandArgument(commandLine, "https_server_port"));
  const listeners = Array.isArray(process.listeners) ? process.listeners : [];
  const loopbackPorts = listeners
    .filter((listener) => listener && loopbackAddress(listener.address) && listener.state === "listen")
    .map((listener) => positivePort(listener.port))
    .filter((port) => port !== null);
  const ports = [...new Set(advertisedPort ? loopbackPorts.filter((port) => port === advertisedPort) : loopbackPorts)];
  if (ports.length === 0) return null;
  const startedAt = Number.isFinite(Date.parse(process.startedAt)) ? Date.parse(process.startedAt) : 0;
  return { ports, csrfToken, startedAt };
}

function parseProcessListing(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    return Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
  } catch {
    return [];
  }
}

async function defaultListProcesses(options = {}) {
  const execFileImpl = options.execFileImpl || nodeExecFile;
  const script = [
    "$current=[Security.Principal.WindowsIdentity]::GetCurrent().Name",
    "Get-CimInstance Win32_Process | ForEach-Object {",
    "if ($_.Name -notmatch '^language_server(\\.exe)?$') { return }",
    "$owner=Invoke-CimMethod -InputObject $_ -MethodName GetOwner -ErrorAction SilentlyContinue",
    "if (!$owner -or (\"$($owner.Domain)\\$($owner.User)\" -ne $current)) { return }",
    "$listeners=Get-NetTCPConnection -OwningProcess $_.ProcessId -State Listen -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{address=$_.LocalAddress;port=$_.LocalPort;state='listen'} }",
    "[pscustomobject]@{name=$_.Name;executablePath=$_.ExecutablePath;commandLine=$_.CommandLine;sameUser=$true;startedAt=$_.CreationDate;listeners=@($listeners)}",
    "} | ConvertTo-Json -Compress"
  ].join("; ");
  return await new Promise((resolve) => {
    execFileImpl(options.powerShell || "powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true,
      timeout: options.processTimeoutMs || DEFAULT_TIMEOUT_MS,
      maxBuffer: 256 * 1024,
      encoding: "utf8"
    }, (error, stdout) => resolve(error ? [] : parseProcessListing(String(stdout || ""))));
  });
}

function defaultTlsFingerprint({ port, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: "127.0.0.1", port, rejectUnauthorized: false, servername: "localhost" });
    const timer = setTimeout(() => socket.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })), timeoutMs);
    socket.once("secureConnect", () => {
      clearTimeout(timer);
      const fingerprint = socket.getPeerCertificate()?.fingerprint256;
      socket.end();
      if (typeof fingerprint === "string" && /^[A-F0-9:]{95}$/iu.test(fingerprint)) resolve(fingerprint.toUpperCase());
      else reject(new Error("certificate_unavailable"));
    });
    socket.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
}

function defaultRequest({ url, headers, timeoutMs, maxResponseBytes, certificateFingerprint256 }) {
  return new Promise((resolve, reject) => {
    const agent = new https.Agent({ keepAlive: false, maxSockets: 1 });
    agent.createConnection = (connectionOptions, callback) => {
      let settled = false;
      const socket = tls.connect({ ...connectionOptions, rejectUnauthorized: false });
      const finish = (error) => {
        if (settled) return;
        settled = true;
        if (error) {
          socket.destroy(error);
          callback(error);
          return;
        }
        callback(null, socket);
      };
      socket.once("secureConnect", () => {
        const actualFingerprint = socket.getPeerCertificate()?.fingerprint256?.toUpperCase();
        finish(actualFingerprint === certificateFingerprint256
          ? null
          : new Error("certificate_mismatch"));
      });
      socket.once("error", finish);
      // Returning no socket prevents https.Agent from releasing it to the
      // request until the secureConnect fingerprint check above succeeds.
      return undefined;
    };
    const request = https.request(url, {
      method: "POST",
      headers,
      timeout: timeoutMs,
      agent
    }, (response) => {
      const chunks = [];
      let total = 0;
      response.on("data", (chunk) => {
        total += chunk.length;
        if (total > maxResponseBytes) {
          request.destroy(new Error("response_too_large"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolve({ statusCode: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.once("timeout", () => request.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));
    request.once("error", reject);
    request.once("close", () => agent.destroy());
    request.end("{}");
  });
}

function parsedResponse(response) {
  if (!response || typeof response !== "object" || response.statusCode !== 200) return null;
  const body = typeof response.body === "string" ? response.body : Buffer.isBuffer(response.body) ? response.body.toString("utf8") : null;
  if (!body || Buffer.byteLength(body, "utf8") > MAX_RESPONSE_BYTES) return null;
  try {
    const parsed = JSON.parse(body);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Reads the provider's local, authenticated Antigravity account status. Its
 * process token and loopback endpoint are transient request inputs only: the
 * return value intentionally contains no process details, URLs, headers, or
 * account identity.
 */
export async function readAntigravityPlanStatus(options = {}) {
  if ((options.platform || process.platform) !== "win32") return { status: "unavailable", reason: "unsupported_platform" };
  const detectDesktop = options.detectAntigravityDesktopVersion || detectAntigravityDesktopVersion;
  let desktop;
  try {
    desktop = await detectDesktop(options.antigravityDesktopVersionOptions);
  } catch {
    return { status: "unavailable", reason: "desktop_version_unavailable" };
  }
  if (desktop?.status !== "supported" || desktop.version !== "2.3.1") {
    return { status: "unavailable", reason: "unsupported_antigravity_desktop" };
  }
  const listProcesses = options.listProcesses || (() => defaultListProcesses(options));
  let processes;
  try {
    processes = await listProcesses();
  } catch {
    return { status: "unavailable", reason: "process_listing_failed" };
  }
  const candidates = (Array.isArray(processes) ? processes : [])
    .map(languageServerCandidate)
    .filter(Boolean)
    .sort((left, right) => right.startedAt - left.startedAt)
    .slice(0, 4);
  if (candidates.length === 0) return { status: "unavailable", reason: "local_language_server_not_found" };

  const requestImpl = options.requestImpl || defaultRequest;
  const readTlsFingerprint = options.readTlsFingerprint || defaultTlsFingerprint;
  let lastReason = "local_status_unavailable";
  for (const candidate of candidates) {
    for (const port of candidate.ports) {
      try {
        const certificateFingerprint256 = await readTlsFingerprint({ port, timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS });
        if (typeof certificateFingerprint256 !== "string" || !/^[A-F0-9:]{95}$/iu.test(certificateFingerprint256)) {
          lastReason = "local_status_unavailable";
          continue;
        }
        const response = await requestImpl({
          url: `https://127.0.0.1:${port}${USER_STATUS_PATH}`,
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            "x-codeium-csrf-token": candidate.csrfToken
          },
          body: "{}",
          timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
          maxResponseBytes: MAX_RESPONSE_BYTES,
          certificateFingerprint256: certificateFingerprint256.toUpperCase()
        });
        const status = planFromStatus(parsedResponse(response));
        if (!status) { lastReason = "invalid_response"; continue; }
        if (status.kind === "signed_out") return { status: "unavailable", reason: "signed_out" };
        if (status.kind === "unavailable") return { status: "unavailable", reason: "provider_plan_unavailable" };
        return {
          status: "available",
          verification: "provider_backed_antigravity_language_server",
          planObservation: {
            providerId: "gemini",
            serviceSurface: "antigravity",
            rawPlanCode: status.rawPlanCode,
            evidenceType: "antigravity_local_user_status",
            observedAt: new Date(options.now ?? Date.now()).toISOString()
          }
        };
      } catch (error) {
        lastReason = error?.code === "ETIMEDOUT" || error?.message === "timeout" ? "timeout" : "local_status_unavailable";
      }
    }
  }
  return { status: "unavailable", reason: lastReason };
}

export { USER_STATUS_PATH as ANTIGRAVITY_USER_STATUS_PATH };
