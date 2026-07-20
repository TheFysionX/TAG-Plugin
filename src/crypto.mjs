import {
  createHash,
  createHmac,
  generateKeyPairSync,
  randomBytes,
  sign as nodeSign,
  verify as nodeVerify
} from "node:crypto";
import { canonicalize } from "./canonical-json.mjs";

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function sha256Base64Url(value) {
  return createHash("sha256").update(value).digest("base64url");
}

export function hmacAlias(secretBase64, namespace, value) {
  return createHmac("sha256", Buffer.from(secretBase64, "base64"))
    .update(namespace)
    .update("\0")
    .update(value)
    .digest("hex");
}

export function createDeviceSecrets() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicJwk = publicKey.export({ format: "jwk" });
  return {
    algorithm: "Ed25519",
    publicKeyRawBase64Url: publicJwk.x,
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
    localAliasKey: randomBytes(32).toString("base64")
  };
}

export function signCanonical(privateKeyPem, value) {
  return nodeSign(null, Buffer.from(canonicalize(value)), privateKeyPem).toString("base64");
}

export function signBytes(privateKeyPem, value) {
  return nodeSign(null, Buffer.from(value), privateKeyPem).toString("base64url");
}

export function verifyCanonical(publicKeyPem, value, signatureBase64) {
  return nodeVerify(null, Buffer.from(canonicalize(value)), publicKeyPem, Buffer.from(signatureBase64, "base64"));
}

export function accountScopedEventId(namespaceKeyBase64Url, provider, providerRecordIdentity) {
  const key = Buffer.from(namespaceKeyBase64Url, "base64url");
  if (key.length !== 32) {
    throw new TypeError("The account dedup namespace key must contain exactly 32 bytes.");
  }
  return createHmac("sha256", key)
    .update("tokenboard-event-v1")
    .update("\0")
    .update(provider)
    .update("\0")
    .update(providerRecordIdentity)
    .digest("hex");
}

export function payloadHash(value) {
  return sha256(canonicalize(value));
}
