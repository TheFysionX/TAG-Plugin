import path from "node:path";
import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";
import { ConnectorError } from "./errors.mjs";

const execFile = promisify(nodeExecFile);

async function defaultRunner(executable, arguments_) {
  await execFile(executable, arguments_, { windowsHide: true });
}

function powershellLiteral(value) {
  return "'" + String(value).replaceAll("'", "''") + "'";
}

function aclScript(targetPath, identity, directory) {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$targetPath = " + powershellLiteral(targetPath),
    "$identity = " + powershellLiteral(identity),
    "$acl = Get-Acl -LiteralPath $targetPath",
    "$acl.SetAccessRuleProtection($true, $false)",
    "foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleSpecific($rule) }",
    directory
      ? "$grant = New-Object System.Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')"
      : "$grant = New-Object System.Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'Allow')",
    "$acl.SetAccessRule($grant)",
    "Set-Acl -LiteralPath $targetPath -AclObject $acl",
    "$check = Get-Acl -LiteralPath $targetPath",
    "$rules = @($check.Access)",
    "$expectedSid = (New-Object System.Security.Principal.NTAccount($identity)).Translate([System.Security.Principal.SecurityIdentifier]).Value",
    "$actualSid = if ($rules.Count -eq 1) { $rules[0].IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } else { '' }",
    "$full = [System.Security.AccessControl.FileSystemRights]::FullControl",
    directory
      ? "$inherit = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit"
      : "$inherit = [System.Security.AccessControl.InheritanceFlags]::None",
    "if (-not $check.AreAccessRulesProtected -or $rules.Count -ne 1 -or $actualSid -ne $expectedSid -or $rules[0].AccessControlType -ne 'Allow' -or (($rules[0].FileSystemRights -band $full) -ne $full) -or $rules[0].InheritanceFlags -ne $inherit) { throw 'Current-user-only ACL verification failed.' }"
  ].join("; ");
}

async function hardenWindowsPath(targetPath, options, directory) {
  const platform = options.platform || process.platform;
  if (platform !== "win32") return { applied: false, reason: "not_windows" };
  const env = options.env || process.env;
  const identity = options.windowsIdentity
    || (env.USERDOMAIN && env.USERNAME ? env.USERDOMAIN + "\\" + env.USERNAME : env.USERNAME);
  if (typeof identity !== "string" || !/^[\p{L}\p{N}_.@ -]+(?:\\[\p{L}\p{N}_.@ -]+)?$/u.test(identity)) {
    throw new ConnectorError(
      "WINDOWS_IDENTITY_UNAVAILABLE",
      "The connector could not resolve the current Windows identity for secret ACL hardening."
    );
  }
  const run = options.runCommand || defaultRunner;
  const executable = options.windowsPowerShellPath
    || path.win32.join(env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  try {
    await run(executable, [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      aclScript(targetPath, identity, directory)
    ]);
  } catch (error) {
    throw new ConnectorError(
      "WINDOWS_ACL_HARDENING_FAILED",
      "The connector refused to continue because its secret ACL could not be restricted to the current user.",
      { cause: error }
    );
  }
  return { applied: true, identity };
}

export async function hardenWindowsSecrets(secretPath, options = {}) {
  return hardenWindowsPath(secretPath, options, false);
}

export async function hardenWindowsConnectorHome(homePath, options = {}) {
  return hardenWindowsPath(homePath, options, true);
}
