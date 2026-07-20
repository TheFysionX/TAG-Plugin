import { ConnectorError } from "./errors.mjs";

function normalize(value, seen) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new ConnectorError("NON_CANONICAL_NUMBER", "Signed payloads may only contain finite numbers.");
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      throw new ConnectorError("CYCLIC_PAYLOAD", "Signed payloads may not contain cycles.");
    }
    seen.add(value);
    const result = value.map((item) => {
      if (item === undefined || typeof item === "function" || typeof item === "symbol") {
        return null;
      }
      return normalize(item, seen);
    });
    seen.delete(value);
    return result;
  }
  if (typeof value === "object") {
    if (seen.has(value)) {
      throw new ConnectorError("CYCLIC_PAYLOAD", "Signed payloads may not contain cycles.");
    }
    seen.add(value);
    const result = {};
    for (const key of Object.keys(value).sort()) {
      const item = value[key];
      if (item === undefined || typeof item === "function" || typeof item === "symbol") {
        continue;
      }
      result[key] = normalize(item, seen);
    }
    seen.delete(value);
    return result;
  }
  throw new ConnectorError("UNSUPPORTED_PAYLOAD_VALUE", "Signed payloads contain an unsupported value.");
}

export function canonicalize(value) {
  return JSON.stringify(normalize(value, new Set()));
}
