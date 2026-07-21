import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { publicError } from "../src/errors.mjs";
import { hardenWindowsSecrets } from "../src/windows-security.mjs";

test("Windows ACL hardening reports an already-valid ACL without applying it again", async () => {
  const commands = [];
  const result = await hardenWindowsSecrets("C:\\private\\device-secrets.json", {
    platform: "win32",
    windowsIdentity: "TEST\\connector-user",
    runCommand: async (executable, arguments_) => {
      commands.push([executable, ...arguments_]);
      return { stdout: "TAG_ACL_ALREADY_HARDENED", stderr: "" };
    }
  });
  assert.equal(commands.length, 1);
  assert.equal(result.applied, false);
  assert.equal(result.reason, "already_hardened");
  assert.match(commands[0].at(-1), /if \(Test-TagAcl/);
  assert.match(commands[0].at(-1), /Set-Acl/);
});

test("Windows ACL failures expose only a safe diagnostic category and stage", async () => {
  const privatePath = "C:\\private\\device-secrets-super-secret.json";
  let caught;
  try {
    await hardenWindowsSecrets(privatePath, {
      platform: "win32",
      windowsIdentity: "TEST\\connector-user",
      runCommand: async () => {
        const error = new Error(`failure involving ${privatePath}`);
        error.stderr = "TAG_ACL_STAGE=verify";
        throw error;
      }
    });
  } catch (error) {
    caught = error;
  }
  assert.equal(caught?.code, "WINDOWS_ACL_HARDENING_FAILED");
  assert.deepEqual(caught?.diagnostic, { category: "windows_acl", stage: "verify" });
  const serialized = JSON.stringify(publicError(caught));
  assert.doesNotMatch(serialized, /device-secrets-super-secret|C:\\\\private/i);
  assert.deepEqual(publicError(caught).diagnostic, { category: "windows_acl", stage: "verify" });
});

test("hardening the same real Windows temp secret twice is idempotent", {
  skip: process.platform === "win32" ? false : "Windows-only ACL integration test"
}, async (context) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "tag-plugin-acl-test-"));
  context.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const secretPath = path.join(temporary, "device-secrets.json");
  await fs.writeFile(secretPath, "{}\n", { encoding: "utf8", mode: 0o600 });

  const first = await hardenWindowsSecrets(secretPath);
  const second = await hardenWindowsSecrets(secretPath);

  assert.equal([true, false].includes(first.applied), true);
  assert.equal(second.applied, false);
  assert.equal(second.reason, "already_hardened");
});
