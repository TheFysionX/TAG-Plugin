import path from "node:path";
import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";
import { ConnectorError } from "./errors.mjs";

const execFile = promisify(nodeExecFile);

async function defaultRunner(executable, arguments_) {
  return execFile(executable, arguments_, { windowsHide: true });
}

function powershellLiteral(value) {
  return "'" + String(value).replaceAll("'", "''") + "'";
}

function aclScript(targetPath, identity, directory) {
  const expectedInheritance = directory
    ? "[System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit"
    : "[System.Security.AccessControl.InheritanceFlags]::None";
  return [
    "$ErrorActionPreference = 'Stop'",
    "$targetPath = " + powershellLiteral(targetPath),
    "$identity = " + powershellLiteral(identity),
    "function Test-TagAcl { param([string]$TargetPath, [string]$Identity)",
    "$check = Get-Acl -LiteralPath $TargetPath",
    "$rules = @($check.Access)",
    "if ($rules.Count -ne 1) { return $false }",
    "$expectedSid = (New-Object System.Security.Principal.NTAccount($Identity)).Translate([System.Security.Principal.SecurityIdentifier]).Value",
    "$actualSid = $rules[0].IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value",
    "$ownerSid = $check.GetOwner([System.Security.Principal.SecurityIdentifier]).Value",
    "$full = [System.Security.AccessControl.FileSystemRights]::FullControl",
    "$inherit = " + expectedInheritance,
    "return [bool]($check.AreAccessRulesProtected -and $ownerSid -eq $expectedSid -and $actualSid -eq $expectedSid -and -not $rules[0].IsInherited -and $rules[0].AccessControlType -eq 'Allow' -and (($rules[0].FileSystemRights -band $full) -eq $full) -and $rules[0].InheritanceFlags -eq $inherit -and $rules[0].PropagationFlags -eq [System.Security.AccessControl.PropagationFlags]::None) }",
    "$stage = 'inspect'",
    "try {",
    "if (Test-TagAcl -TargetPath $targetPath -Identity $identity) { [Console]::Out.Write('TAG_ACL_ALREADY_HARDENED'); exit 0 }",
    "$stage = 'apply'",
    "$acl = Get-Acl -LiteralPath $targetPath",
    "$acl.SetAccessRuleProtection($true, $false)",
    "foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleSpecific($rule) }",
    directory
      ? "$grant = New-Object System.Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')"
      : "$grant = New-Object System.Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'Allow')",
    "$acl.SetOwner((New-Object System.Security.Principal.NTAccount($identity)))",
    "$acl.SetAccessRule($grant)",
    "Set-Acl -LiteralPath $targetPath -AclObject $acl",
    "$stage = 'verify'",
    "if (-not (Test-TagAcl -TargetPath $targetPath -Identity $identity)) { throw 'Current-user-only ACL verification failed.' }",
    "[Console]::Out.Write('TAG_ACL_HARDENED')",
    "} catch { [Console]::Error.Write('TAG_ACL_STAGE=' + $stage); exit 17 }"
  ].join("; ");
}

function aclFailureStage(error) {
  const marker = typeof error?.stderr === "string"
    ? error.stderr.match(/TAG_ACL_STAGE=(inspect|apply|verify)(?:\s|$)/)
    : null;
  return marker?.[1] || "launch";
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
  let result;
  try {
    result = await run(executable, [
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
      { diagnostic: { category: "windows_acl", stage: aclFailureStage(error) } }
    );
  }
  const alreadyHardened = typeof result?.stdout === "string"
    && result.stdout.includes("TAG_ACL_ALREADY_HARDENED");
  return alreadyHardened
    ? { applied: false, reason: "already_hardened", identity }
    : { applied: true, identity };
}

export async function hardenWindowsSecrets(secretPath, options = {}) {
  return hardenWindowsPath(secretPath, options, false);
}

export async function hardenWindowsConnectorHome(homePath, options = {}) {
  return hardenWindowsPath(homePath, options, true);
}
