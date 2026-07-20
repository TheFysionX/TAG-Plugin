import { randomBytes } from "node:crypto";
import { canonicalize } from "./canonical-json.mjs";
import { sha256Base64Url, signBytes } from "./crypto.mjs";
import { ConnectorError } from "./errors.mjs";

const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_RETRY_AFTER_MS = 120_000;

function retryAfterMilliseconds(response) {
  const value = response.headers?.get?.("retry-after");
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const trimmed = value.trim();
  let milliseconds;
  if (/^\d+$/.test(trimmed)) {
    milliseconds = Number(trimmed) * 1_000;
  } else {
    const date = Date.parse(trimmed);
    milliseconds = Number.isFinite(date) ? Math.max(0, date - Date.now()) : NaN;
  }
  return Number.isFinite(milliseconds)
    ? Math.min(MAX_RETRY_AFTER_MS, Math.max(0, Math.floor(milliseconds)))
    : null;
}

export function validateEndpoint(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ConnectorError("INVALID_ENDPOINT", "The Artificial Games endpoint is not a valid URL.");
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new ConnectorError("INSECURE_ENDPOINT", "The endpoint must use HTTPS, except for an explicit loopback development server.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ConnectorError("INVALID_ENDPOINT", "The endpoint may not contain credentials, query parameters, or a fragment.");
  }
  if (url.pathname !== "/") {
    throw new ConnectorError("INVALID_ENDPOINT", "The endpoint must be an origin without an additional path.");
  }
  return url.origin;
}

async function readBoundedResponse(response) {
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
      throw new ConnectorError("RESPONSE_TOO_LARGE", "The Artificial Games server returned an unexpectedly large response.", {
        status: response.status ?? null,
        retryable: false
      });
    }
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      try {
        await reader.cancel();
      } catch {
        // The size violation is authoritative even if a hostile/broken stream refuses cancellation.
      }
      throw new ConnectorError("RESPONSE_TOO_LARGE", "The Artificial Games server returned an unexpectedly large response.", {
        status: response.status ?? null,
        retryable: false
      });
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function parseResponse(response) {
  const text = await readBoundedResponse(response);
  let body = {};
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      const status = Number.isInteger(response.status) ? response.status : null;
      throw new ConnectorError("INVALID_SERVER_RESPONSE", "The Artificial Games server returned invalid JSON.", {
        status,
        retryable: status === 429 || (status !== null && status >= 500),
        retryAfterMs: status === 429 ? retryAfterMilliseconds(response) : null
      });
    }
  }
  if (!response.ok) {
    const nested = body?.error && typeof body.error === "object" ? body.error : null;
    const status = Number.isInteger(response.status) ? response.status : null;
    const retryable = status === 429 || (status !== null && status >= 500);
    throw new ConnectorError(
      typeof nested?.code === "string"
        ? nested.code
        : (typeof body.code === "string" ? body.code : "SERVER_REJECTED_REQUEST"),
      typeof nested?.message === "string"
        ? nested.message.slice(0, 240)
        : (typeof body.message === "string" ? body.message.slice(0, 240) : "The Artificial Games server rejected the request."),
      {
        status,
        retryable,
        retryAfterMs: status === 429 ? retryAfterMilliseconds(response) : null
      }
    );
  }
  return body;
}

async function fetchAndParseWithTimeout(fetchImpl, url, init, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  let timer;
  const operation = (async () => parseResponse(await fetchImpl(url, {
    ...init,
    signal: controller.signal
  })))();
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new ConnectorError("NETWORK_TIMEOUT", "The Artificial Games request timed out.", { retryable: true }));
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation, deadline]);
  } catch (error) {
    if (error instanceof ConnectorError) {
      throw error;
    }
    if (timedOut || error?.name === "AbortError") {
      throw new ConnectorError("NETWORK_TIMEOUT", "The Artificial Games request timed out.", { retryable: true });
    }
    throw new ConnectorError("NETWORK_UNAVAILABLE", "The Artificial Games endpoint could not be reached.", {
      cause: error,
      retryable: true
    });
  } finally {
    clearTimeout(timer);
  }
}

async function requestWithRetry(makeRequest, options = {}) {
  const maximum = Math.max(1, Math.min(5, options.maxAttempts ?? 3));
  const sleep = options.sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const random = options.random || Math.random;
  let lastError;
  for (let attempt = 0; attempt < maximum; attempt += 1) {
    try {
      return await makeRequest();
    } catch (error) {
      lastError = error;
      if (!(error instanceof ConnectorError) || !error.retryable || attempt + 1 >= maximum) {
        throw error;
      }
      const base = Math.min(2_000, 200 * (2 ** attempt));
      const backoff = base + Math.floor(random() * Math.max(1, Math.floor(base / 2)));
      await sleep(error.retryAfterMs ?? backoff);
    }
  }
  throw lastError;
}

export async function postJson(url, body, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  return requestWithRetry(() => fetchAndParseWithTimeout(fetchImpl, url, {
    method: "POST",
    redirect: "error",
    headers: { "content-type": "application/json" },
    body: canonicalize(body)
  }, options.timeoutMs || 15_000), options);
}

export function signedRequestParts({ method, url, body, deviceId, sequence, privateKeyPem, now, nonce }) {
  const target = new URL(url);
  if (target.search) {
    throw new ConnectorError("SIGNED_QUERY_FORBIDDEN", "Signed The Artificial Games routes may not contain a query string.");
  }
  const timestamp = String(Math.floor((now ?? Date.now()) / 1000));
  const requestId = nonce || randomBytes(18).toString("base64url");
  const canonicalBody = canonicalize(body);
  const bodySha256 = sha256Base64Url(canonicalBody);
  const canonicalRequest = [
    "TOKENBOARD-V1",
    method.toUpperCase(),
    target.pathname,
    deviceId || "",
    timestamp,
    requestId,
    String(sequence),
    bodySha256
  ].join("\n");
  const headers = {
    "content-type": "application/json",
    "x-tokenboard-timestamp": timestamp,
    "x-tokenboard-request-id": requestId,
    "x-tokenboard-sequence": String(sequence),
    "x-tokenboard-signature": signBytes(privateKeyPem, canonicalRequest)
  };
  if (deviceId) {
    headers["x-tokenboard-device-id"] = deviceId;
  }
  return {
    canonicalBody,
    canonicalRequest,
    bodySha256,
    headers
  };
}

export async function signedPost(url, body, auth, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const parts = signedRequestParts({
    method: "POST",
    url,
    body,
    deviceId: auth.deviceId,
    sequence: auth.sequence,
    privateKeyPem: auth.privateKeyPem,
    now: options.now,
    nonce: options.nonce
  });
  return requestWithRetry(() => fetchAndParseWithTimeout(fetchImpl, url, {
    method: "POST",
    redirect: "error",
    headers: parts.headers,
    body: parts.canonicalBody
  }, options.timeoutMs || 15_000), options);
}
