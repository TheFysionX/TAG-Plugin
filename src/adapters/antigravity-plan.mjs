import { execFile as nodeExecFile } from "node:child_process";
import https from "node:https";
import tls from "node:tls";
import { detectAntigravityDesktopVersion } from "./antigravity-desktop.mjs";

const MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 2_000;
const LOAD_CODE_ASSIST_PATH = "/exa.language_server_pb.LanguageServerService/GetLoadCodeAssist";
const USER_STATUS_PATH = "/exa.language_server_pb.LanguageServerService/GetUserStatus";

// Antigravity's native account response keeps the effective tier separate from
// legacy Codeium capability fields such as planStatus.planInfo.planName. The
// only live-verified native family in this adapter is its minimum Starter quota;
// Google deliberately shares it between Free and AI Plus. Future native IDs are
// unverified until a real provider response is added as a fixture.
const NATIVE_TIER_IDS = new Map([
  ["free_tier", "starter"]
]);

function normalizedCode(value) {
  if (typeof value !== "string" || value.length > 80) return null;
  const normalized = value.trim().toLowerCase().replace(/[.\-\s]+/gu, "_");
  return /^[a-z0-9_]+$/u.test(normalized) ? normalized : null;
}

function tierId(value) {
  if (typeof value === "string") return normalizedCode(value);
  return normalizedCode(value?.id);
}

function responseEnvelope(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value.response && typeof value.response === "object" && !Array.isArray(value.response)
    ? value.response
    : value;
}

function userStatusFrom(value) {
  const envelope = responseEnvelope(value);
  if (!envelope) return null;
  const userStatus = value.userStatus && typeof value.userStatus === "object" && !Array.isArray(value.userStatus)
    ? value.userStatus
    : envelope.userStatus && typeof envelope.userStatus === "object" && !Array.isArray(envelope.userStatus)
      ? envelope.userStatus
      : envelope;
  return userStatus;
}

function signedOut(value) {
  const userStatus = userStatusFrom(value);
  if (!userStatus) return false;
  if (userStatus.signedIn === false || userStatus.authenticated === false
    || normalizedCode(userStatus.authState) === "signed_out") {
    return true;
  }
  return false;
}

function planFromResponses(userStatusResponse, loadCodeAssistResponse) {
  if (signedOut(userStatusResponse) || signedOut(loadCodeAssistResponse)) return { kind: "signed_out" };
  const userStatus = userStatusFrom(userStatusResponse);
  const loadResponse = responseEnvelope(loadCodeAssistResponse);
  // userTier is the primary live effective-quota authority. paidTier is useful
  // only as corroboration; currentTier, allowedTiers, planInfo, teamsTier, and
  // the legacy `pro` boolean are not retail subscription evidence.
  const primaryTier = tierId(userStatus?.userTier);
  const corroboratingTier = tierId(loadResponse?.paidTier);
  if (primaryTier && corroboratingTier && primaryTier !== corroboratingTier) {
    return { kind: "ambiguous" };
  }
  const providerTier = primaryTier || corroboratingTier;
  if (!providerTier) return { kind: "unavailable" };
  return { kind: "available", rawPlanCode: NATIVE_TIER_IDS.get(providerTier) || "unknown" };
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

function defaultRequest({ url, headers, body = "{}", timeoutMs, maxResponseBytes, certificateFingerprint256 }) {
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
    request.end(body);
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
      let certificateFingerprint256;
      try {
        certificateFingerprint256 = await readTlsFingerprint({ port, timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS });
        if (typeof certificateFingerprint256 !== "string" || !/^[A-F0-9:]{95}$/iu.test(certificateFingerprint256)) {
          lastReason = "local_status_unavailable";
          continue;
        }
      } catch (error) {
        lastReason = error?.code === "ETIMEDOUT" || error?.message === "timeout" ? "timeout" : "local_status_unavailable";
        continue;
      }
      const replies = {};
      for (const endpoint of [
        { key: "userStatus", path: USER_STATUS_PATH, body: "{}" },
        { key: "loadCodeAssist", path: LOAD_CODE_ASSIST_PATH, body: "{\"forceRefresh\":false}" }
      ]) {
        try {
          const response = await requestImpl({
            url: `https://127.0.0.1:${port}${endpoint.path}`,
            method: "POST",
            headers: {
              "content-type": "application/json",
              accept: "application/json",
              "x-codeium-csrf-token": candidate.csrfToken
            },
            body: endpoint.body,
            timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
            maxResponseBytes: MAX_RESPONSE_BYTES,
            certificateFingerprint256: certificateFingerprint256.toUpperCase()
          });
          const parsed = parsedResponse(response);
          if (!parsed) lastReason = "invalid_response";
          else replies[endpoint.key] = parsed;
        } catch (error) {
          lastReason = error?.code === "ETIMEDOUT" || error?.message === "timeout" ? "timeout" : "local_status_unavailable";
        }
      }
      const status = planFromResponses(replies.userStatus, replies.loadCodeAssist);
      if (status.kind === "signed_out") return { status: "signed_out" };
      if (status.kind === "ambiguous") return { status: "unavailable", reason: "ambiguous_provider_tier" };
      if (status.kind === "unavailable") {
        if (replies.userStatus || replies.loadCodeAssist) lastReason = "provider_plan_unavailable";
        continue;
      }
      return {
        status: "available",
        verification: "provider_backed_antigravity_language_server",
        planObservation: {
          providerId: "gemini",
          serviceSurface: "antigravity",
          rawPlanCode: status.rawPlanCode,
          evidenceType: "antigravity_local_effective_tier",
          observedAt: new Date(options.now ?? Date.now()).toISOString()
        }
      };
    }
  }
  return { status: "unavailable", reason: lastReason };
}

export {
  LOAD_CODE_ASSIST_PATH as ANTIGRAVITY_LOAD_CODE_ASSIST_PATH,
  USER_STATUS_PATH as ANTIGRAVITY_USER_STATUS_PATH
};
