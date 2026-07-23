import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";
import { ConnectorError } from "./errors.mjs";

const execFile = promisify(nodeExecFile);

function quoted(value) {
  return '"' + String(value).replaceAll('"', '\\"') + '"';
}

function vbsQuoted(value) {
  return '"' + String(value).replaceAll('"', '""') + '"';
}

function windowsHiddenRunnerContents(nodeExecutable, cliPath, home) {
  const command = [
    quoted(nodeExecutable),
    quoted(cliPath),
    "scheduled-run",
    "--home",
    quoted(home)
  ].join(" ");
  return [
    "Option Explicit",
    "Dim shell",
    'Set shell = CreateObject("WScript.Shell")',
    "WScript.Quit shell.Run(" + vbsQuoted(command) + ", 0, True)",
    ""
  ].join("\r\n");
}

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function defaultUserHome(env = process.env) {
  return env.USERPROFILE || env.HOME || os.homedir();
}

export function schedulerPlan(options = {}) {
  const platform = options.platform || process.platform;
  const nodeExecutable = path.resolve(options.nodeExecutable || process.execPath);
  const cliPath = path.resolve(options.cliPath || process.argv[1]);
  const home = path.resolve(options.home);
  const userHome = path.resolve(options.userHome || defaultUserHome(options.env));
  if (platform === "win32") {
    const systemRoot = options.systemRoot || options.env?.SystemRoot || process.env.SystemRoot || "C:\\Windows";
    const scriptHost = path.win32.join(systemRoot, "System32", "wscript.exe");
    const hiddenRunner = path.join(home, "tag-plugin-scheduled-run.vbs");
    return {
      platform: "windows",
      currentUserOnly: true,
      elevationRequired: false,
      cadence: "hourly",
      create: {
        executable: "schtasks.exe",
        hiddenRunner,
        hiddenRunnerContents: windowsHiddenRunnerContents(nodeExecutable, cliPath, home),
        arguments: [
          "/Create", "/SC", "HOURLY", "/MO", "1", "/TN", "TAG Plugin",
          "/TR", "'" + scriptHost + "' //B \\\"" + hiddenRunner + "\\\"",
          "/RL", "LIMITED",
          "/F"
        ]
      },
      remove: {
        executable: "schtasks.exe",
        arguments: ["/Delete", "/TN", "TAG Plugin", "/F"],
        files: [hiddenRunner]
      },
      files: [home, hiddenRunner]
    };
  }
  if (platform === "darwin") {
    const plist = path.join(userHome, "Library", "LaunchAgents", "com.theartificialgames.tag-plugin.plist");
    const plistContents = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0"><dict>',
      '<key>Label</key><string>com.theartificialgames.tag-plugin</string>',
      '<key>ProgramArguments</key><array>',
      '<string>' + xml(nodeExecutable) + '</string>',
      '<string>' + xml(cliPath) + '</string>',
      '<string>scheduled-run</string>',
      '<string>--home</string>',
      '<string>' + xml(home) + '</string>',
      '</array>',
      '<key>StartInterval</key><integer>3600</integer>',
      '<key>RunAtLoad</key><true/>',
      '</dict></plist>',
      ''
    ].join("\n");
    return {
      platform: "macos",
      currentUserOnly: true,
      elevationRequired: false,
      cadence: "hourly",
      create: {
        file: plist,
        contents: plistContents,
        command: { executable: "launchctl", arguments: ["bootstrap", "gui/" + (options.uid ?? process.getuid?.()), plist] }
      },
      remove: {
        command: { executable: "launchctl", arguments: ["bootout", "gui/" + (options.uid ?? process.getuid?.()), plist] },
        files: [plist]
      },
      files: [home, plist]
    };
  }
  const unitDirectory = path.join(options.xdgConfigHome || path.join(userHome, ".config"), "systemd", "user");
  const serviceFile = path.join(unitDirectory, "tag-plugin.service");
  const timerFile = path.join(unitDirectory, "tag-plugin.timer");
  const serviceContents = [
    "[Unit]",
    "Description=The Artificial Games usage plugin",
    "",
    "[Service]",
    "Type=oneshot",
    "ExecStart=" + quoted(nodeExecutable) + " " + quoted(cliPath) + " scheduled-run --home " + quoted(home),
    "NoNewPrivileges=true",
    "PrivateTmp=true",
    ""
  ].join("\n");
  const timerContents = [
    "[Unit]",
    "Description=Run TAG Plugin hourly",
    "",
    "[Timer]",
    "OnCalendar=hourly",
    "Persistent=true",
    "RandomizedDelaySec=5m",
    "",
    "[Install]",
    "WantedBy=timers.target",
    ""
  ].join("\n");
  return {
    platform: "linux",
    currentUserOnly: true,
    elevationRequired: false,
    cadence: "hourly",
    create: {
      serviceFile,
      serviceContents,
      timerFile,
      timerContents,
      commands: [
        { executable: "systemctl", arguments: ["--user", "daemon-reload"] },
        { executable: "systemctl", arguments: ["--user", "enable", "--now", "tag-plugin.timer"] }
      ]
    },
    remove: {
      commands: [
        { executable: "systemctl", arguments: ["--user", "disable", "--now", "tag-plugin.timer"] }
      ],
      files: [serviceFile, timerFile],
      finalCommand: { executable: "systemctl", arguments: ["--user", "daemon-reload"] }
    },
    files: [home, serviceFile, timerFile]
  };
}

async function defaultRunner(executable, args) {
  await execFile(executable, args, { windowsHide: true });
}

function knownMissingError(platform, error) {
  const text = [error?.message, error?.stderr, error?.stdout].filter(Boolean).join("\n");
  if (platform === "windows") {
    return /cannot find the file specified|task.*does not exist/i.test(text);
  }
  if (platform === "macos") {
    return /could not find service|no such process|service.*not found/i.test(text);
  }
  if (platform === "linux") {
    return /unit .* does not exist|unit .* not loaded|not found/i.test(text);
  }
  return false;
}

async function runAllowingKnownMissing(platform, run, executable, args) {
  try {
    await run(executable, args);
  } catch (error) {
    if (!knownMissingError(platform, error)) {
      throw error;
    }
  }
}

async function atomicSchedulerWrite(fileSystem, filePath, contents) {
  const temporary = filePath + ".tmp-" + process.pid + "-" + Math.random().toString(16).slice(2);
  await fileSystem.writeFile(temporary, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await fileSystem.rename(temporary, filePath);
}

function assertUserPlan(plan) {
  if (!plan.currentUserOnly || plan.elevationRequired) {
    throw new ConnectorError("UNSAFE_SCHEDULER_PLAN", "Refusing to apply a scheduler plan outside the current user account.");
  }
}

export async function applyScheduler(plan, options = {}) {
  assertUserPlan(plan);
  const run = options.runCommand || defaultRunner;
  const fileSystem = options.fileSystem || fs;
  if (plan.platform === "windows") {
    await fileSystem.mkdir(path.dirname(plan.create.hiddenRunner), { recursive: true, mode: 0o700 });
    await atomicSchedulerWrite(fileSystem, plan.create.hiddenRunner, plan.create.hiddenRunnerContents);
    await run(plan.create.executable, plan.create.arguments);
  } else if (plan.platform === "macos") {
    await fileSystem.mkdir(path.dirname(plan.create.file), { recursive: true, mode: 0o700 });
    await runAllowingKnownMissing(
      "macos",
      run,
      plan.remove.command.executable,
      plan.remove.command.arguments
    );
    await atomicSchedulerWrite(fileSystem, plan.create.file, plan.create.contents);
    await run(plan.create.command.executable, plan.create.command.arguments);
  } else if (plan.platform === "linux") {
    await fileSystem.mkdir(path.dirname(plan.create.serviceFile), { recursive: true, mode: 0o700 });
    await atomicSchedulerWrite(fileSystem, plan.create.serviceFile, plan.create.serviceContents);
    await atomicSchedulerWrite(fileSystem, plan.create.timerFile, plan.create.timerContents);
    for (const command of plan.create.commands) {
      await run(command.executable, command.arguments);
    }
  } else {
    throw new ConnectorError("UNSUPPORTED_PLATFORM", "This operating system does not have a scheduler installer yet.");
  }
  return { installed: true, currentUserOnly: true, platform: plan.platform };
}

export async function removeScheduler(plan, options = {}) {
  assertUserPlan(plan);
  const run = options.runCommand || defaultRunner;
  const fileSystem = options.fileSystem || fs;
  if (plan.platform === "windows") {
    await runAllowingKnownMissing("windows", run, plan.remove.executable, plan.remove.arguments);
    for (const file of plan.remove.files) {
      await fileSystem.rm(file, { force: true });
    }
  } else if (plan.platform === "macos") {
    await runAllowingKnownMissing("macos", run, plan.remove.command.executable, plan.remove.command.arguments);
    for (const file of plan.remove.files) {
      await fileSystem.rm(file, { force: true });
    }
  } else if (plan.platform === "linux") {
    for (const command of plan.remove.commands) {
      await runAllowingKnownMissing("linux", run, command.executable, command.arguments);
    }
    for (const file of plan.remove.files) {
      await fileSystem.rm(file, { force: true });
    }
    await run(plan.remove.finalCommand.executable, plan.remove.finalCommand.arguments);
  } else {
    throw new ConnectorError("UNSUPPORTED_PLATFORM", "This operating system does not have a scheduler uninstaller yet.");
  }
  return { installed: false, currentUserOnly: true, platform: plan.platform };
}
