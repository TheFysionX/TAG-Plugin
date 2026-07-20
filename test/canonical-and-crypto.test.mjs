import test from "node:test";
import assert from "node:assert/strict";
import { verify } from "node:crypto";
import { canonicalize } from "../src/canonical-json.mjs";
import { createDeviceSecrets } from "../src/crypto.mjs";
import { signedRequestParts } from "../src/http.mjs";

test("canonical JSON sorts object keys recursively", () => {
  assert.equal(
    canonicalize({ z: 1, a: { d: 4, b: 2 }, list: [{ y: 2, x: 1 }] }),
    '{"a":{"b":2,"d":4},"list":[{"x":1,"y":2}],"z":1}'
  );
});

test("legacy v1 wire signing is deterministic and verifiable", () => {
  const secrets = createDeviceSecrets();
  assert.equal(Buffer.from(secrets.publicKeyRawBase64Url, "base64url").length, 32);
  const parts = signedRequestParts({
    method: "POST",
    url: "https://artificial-games.example/api/connectors/v1/ingest",
    body: { previousRequestDigest: "", events: [] },
    deviceId: "device_12345678",
    sequence: 7,
    privateKeyPem: secrets.privateKeyPem,
    now: 1_750_000_000_000,
    nonce: "fixed-request-id"
  });
  assert.equal(parts.headers["x-tokenboard-timestamp"], "1750000000");
  assert.equal(parts.headers["x-tokenboard-request-id"], "fixed-request-id");
  assert.equal(parts.headers["x-tokenboard-sequence"], "7");
  assert.match(parts.canonicalRequest, /^TOKENBOARD-V1\nPOST\n\/api\/connectors\/v1\/ingest\n/);
  assert.equal(
    verify(
      null,
      Buffer.from(parts.canonicalRequest),
      secrets.publicKeyPem,
      Buffer.from(parts.headers["x-tokenboard-signature"], "base64url")
    ),
    true
  );
});

test("signed requests reject query strings", () => {
  const secrets = createDeviceSecrets();
  assert.throws(() => signedRequestParts({
    method: "POST",
    url: "https://artificial-games.example/api/connectors/v1/ingest?debug=1",
    body: {},
    deviceId: "device_12345678",
    sequence: 1,
    privateKeyPem: secrets.privateKeyPem
  }), /query string/);
});
