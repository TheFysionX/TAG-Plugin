#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

function connectorHome(env = process.env, platform = process.platform) {
  const configured = env.TAG_PLUGIN_HOME || env.TOKENBOARD_CONNECTOR_HOME;
  if (configured) return path.resolve(configured);
  if (platform === "win32") {
    return path.join(env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "The Artificial Games", "TAG Plugin");
  }
  if (platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "The Artificial Games", "TAG Plugin");
  }
  return path.join(env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "the-artificial-games", "tag-plugin");
}

function homeFromArguments(argv) {
  const index = argv.indexOf("--home");
  if (index === -1) return connectorHome();
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error("The TAG Plugin launcher requires a value after --home.");
  return path.resolve(value);
}

async function releaseTarget(home, release) {
  if (!release || typeof release !== "object" || !VERSION_PATTERN.test(release.version || "")) return null;
  const versionsRoot = path.resolve(home, "versions");
  const releaseRoot = path.resolve(versionsRoot, release.version);
  const relative = path.relative(versionsRoot, releaseRoot);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  const cli = path.join(releaseRoot, "src", "cli.mjs");
  try {
    const [rootStat, cliStat, realRoot, realCli] = await Promise.all([
      fs.lstat(releaseRoot),
      fs.lstat(cli),
      fs.realpath(releaseRoot),
      fs.realpath(cli)
    ]);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !cliStat.isFile() || cliStat.isSymbolicLink()) return null;
    const realRelative = path.relative(await fs.realpath(versionsRoot), realRoot);
    if (!realRelative || realRelative.startsWith("..") || path.isAbsolute(realRelative)) return null;
    const cliRelative = path.relative(realRoot, realCli);
    if (!cliRelative || cliRelative.startsWith("..") || path.isAbsolute(cliRelative)) return null;
    return cli;
  } catch {
    return null;
  }
}

async function main() {
  const forwarded = process.argv.slice(2);
  const home = homeFromArguments(forwarded);
  const pointerText = await fs.readFile(path.join(home, "active-release.json"), "utf8");
  if (Buffer.byteLength(pointerText, "utf8") > 32 * 1024) throw new Error("The TAG Plugin release pointer is invalid.");
  const pointer = JSON.parse(pointerText);
  if (pointer?.schemaVersion !== 1) throw new Error("The TAG Plugin release pointer is incompatible.");
  const target = await releaseTarget(home, pointer.current) || await releaseTarget(home, pointer.previous);
  if (!target) throw new Error("No structurally valid TAG Plugin release is available.");
  const child = spawn(process.execPath, [target, ...forwarded], {
    stdio: "inherit",
    windowsHide: true
  });
  child.once("error", (error) => {
    process.stderr.write(`TAG Plugin launcher failed: ${error?.code || "SPAWN_FAILED"}\n`);
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    process.exitCode = Number.isInteger(code) ? code : (signal ? 1 : 0);
  });
}

main().catch((error) => {
  process.stderr.write(`TAG Plugin launcher failed: ${error?.code || "INVALID_ACTIVE_RELEASE"}\n`);
  process.exitCode = 1;
});
