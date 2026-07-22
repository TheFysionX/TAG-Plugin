#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FOREGROUND_MAX_INGEST_REQUESTS } from "./constants.mjs";
import { publicError } from "./errors.mjs";
import {
  doctor,
  heartbeat,
  install,
  pair,
  pause,
  preview,
  resume,
  scheduledRun,
  status,
  sync,
  uninstall
} from "./operations.mjs";

function parseArguments(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index];
    if (!item.startsWith("--")) {
      throw new Error("Unexpected positional argument.");
    }
    const name = item.slice(2);
    const next = rest[index + 1];
    if (!next || next.startsWith("--")) {
      flags[name] = true;
    } else {
      flags[name] = next;
      index += 1;
    }
  }
  return { command, flags };
}

function parseProviderList(value) {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("--allow-journal-fallbacks requires a comma-separated provider list.");
  const result = {};
  for (const provider of value.split(",").map((item) => item.trim().toLowerCase())) {
    if (["codex", "claude", "kimi", "gemini", "grok", "deepseek"].includes(provider)) {
      result[provider] = true;
    }
  }
  return result;
}

function help() {
  return {
    usage: "tag-plugin <command> [options]",
    commands: {
      preview: "Show the exact aggregate usage fields that would be sent; no upload or state changes.",
      pair: "Pair explicitly: pair --endpoint https://... --code SHORT_CODE. The optional Antigravity CLI status-line wrapper additionally requires --enable-antigravity-statusline; resume with pair alone or intentionally replace with --replace-pending-pair.",
      sync: "Collect and explicitly send new allowlisted usage records.",
      heartbeat: "Explicitly send one signed health heartbeat.",
      status: "Show local status; no network.",
      doctor: "Run privacy-safe local checks; no network.",
      install: "Preview by default; apply only with install --confirm-install.",
      pause: "Pause scheduled collection locally.",
      resume: "Resume scheduled collection locally.",
      uninstall: "Preview by default; remove the scheduler and all TAG Plugin versioned program copies only with uninstall --confirm-uninstall. Local state is preserved."
    }
  };
}

async function main() {
  const { command, flags } = parseArguments(process.argv.slice(2));
  const cliPath = fileURLToPath(import.meta.url);
  const common = {
    home: typeof flags.home === "string" ? path.resolve(flags.home) : undefined,
    dryRun: Boolean(flags["dry-run"]),
    confirmInstall: Boolean(flags["confirm-install"]),
    confirmUninstall: Boolean(flags["confirm-uninstall"]),
    aggregateHistory: true,
    cliPath
  };
  let result;
  switch (command) {
    case "preview":
      result = await preview(common);
      break;
    case "pair":
      result = await pair({
        ...common,
        endpoint: flags.endpoint,
        code: flags.code,
        deviceLabel: flags["device-label"],
        enabledFallbacks: parseProviderList(flags["allow-journal-fallbacks"]),
        antigravityStatuslineConsent: flags["enable-antigravity-statusline"] === true ? true : undefined,
        replacePendingPair: Boolean(flags["replace-pending-pair"])
      });
      break;
    case "sync":
      result = await sync({
        ...common,
        maxIngestRequests: FOREGROUND_MAX_INGEST_REQUESTS
      });
      break;
    case "heartbeat":
      result = await heartbeat(common);
      break;
    case "scheduled-run":
      result = await scheduledRun(common);
      break;
    case "status":
      result = await status(common);
      break;
    case "doctor":
      result = await doctor(common);
      break;
    case "install":
      result = await install(common);
      break;
    case "pause":
      result = await pause(common);
      break;
    case "resume":
      result = await resume(common);
      break;
    case "uninstall":
      result = await uninstall(common);
      break;
    case "help":
    case "--help":
    case "-h":
    case undefined:
      result = help();
      break;
    default:
      throw new Error("Unknown command.");
  }
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

main().catch((error) => {
  process.stderr.write(JSON.stringify(publicError(error), null, 2) + "\n");
  process.exitCode = 1;
});
