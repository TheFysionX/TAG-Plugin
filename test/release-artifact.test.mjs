import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFile = promisify(nodeExecFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("the exact packed artifact contains and can run its synthetic test suite", { timeout: 60_000 }, async (context) => {
  if (process.env.TAG_PLUGIN_PACK_ARTIFACT_CHILD === "1") {
    context.skip("already running inside the packed-artifact verification child");
    return;
  }
  assert.ok(process.env.npm_execpath, "npm_execpath is required to verify the npm artifact");
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "tag-plugin-pack-artifact-test-"));
  context.after(() => fs.rm(temporary, { recursive: true, force: true }));
  await execFile(process.execPath, [process.env.npm_execpath, "pack", "--pack-destination", temporary], {
    cwd: root,
    maxBuffer: 4 * 1024 * 1024
  });
  const archiveName = (await fs.readdir(temporary)).find((entry) => entry.endsWith(".tgz"));
  assert.ok(archiveName, "npm pack did not create a release archive");
  const packageJson = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  assert.equal(archiveName, `the-artificial-games-tag-plugin-${packageJson.version}.tgz`);
  const releaseArchiveName = `tag-plugin-${packageJson.version}.tgz`;
  await fs.rename(path.join(temporary, archiveName), path.join(temporary, releaseArchiveName));
  const extractDirectory = path.join(temporary, "extract");
  await fs.mkdir(extractDirectory);
  await execFile("tar", ["-xzf", path.join(temporary, releaseArchiveName), "-C", extractDirectory], {
    maxBuffer: 4 * 1024 * 1024
  });
  const packageDirectory = path.join(extractDirectory, "package");
  await fs.access(path.join(packageDirectory, "test", "fixtures", "codex-rollout.jsonl"));
  await fs.access(path.join(packageDirectory, ".github", "workflows", "release.yml"));
  await fs.access(path.join(packageDirectory, "src", "launcher.mjs"));
  await fs.access(path.join(packageDirectory, "src", "update.mjs"));
  await execFile(process.execPath, [process.env.npm_execpath, "test", "--prefix", packageDirectory], {
    cwd: packageDirectory,
    env: { ...process.env, TAG_PLUGIN_PACK_ARTIFACT_CHILD: "1" },
    maxBuffer: 16 * 1024 * 1024
  });
});
