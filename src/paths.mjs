import os from "node:os";
import path from "node:path";

export function connectorHome(env = process.env, platform = process.platform) {
  const configuredHome = env.TAG_PLUGIN_HOME || env.TOKENBOARD_CONNECTOR_HOME;
  if (configuredHome) {
    return path.resolve(configuredHome);
  }
  if (platform === "win32") {
    return path.join(env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "The Artificial Games", "TAG Plugin");
  }
  if (platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "The Artificial Games", "TAG Plugin");
  }
  return path.join(env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "the-artificial-games", "tag-plugin");
}

export function runtimePaths(options = {}) {
  const home = options.home || connectorHome(options.env, options.platform);
  return {
    home,
    config: path.join(home, "config.json"),
    state: path.join(home, "state.json"),
    secrets: path.join(home, "device-secrets.json"),
    pendingSecrets: path.join(home, "pending-device-secrets.json"),
    syncPages: path.join(home, "sync-pages"),
    log: path.join(home, "connector.log.jsonl"),
    lock: path.join(home, "connector.lock")
  };
}

export function providerRoots(env = process.env) {
  const userHome = env.USERPROFILE || env.HOME || os.homedir();
  const codexHome = env.CODEX_HOME || path.join(userHome, ".codex");
  const claudeHome = env.CLAUDE_CONFIG_DIR || path.join(userHome, ".claude");
  const kimiHome = env.KIMI_CODE_HOME || path.join(userHome, ".kimi-code");
  return {
    codex: path.resolve(env.TAG_PLUGIN_CODEX_ROOT || env.TOKENBOARD_CODEX_ROOT || path.join(codexHome, "sessions")),
    claude: path.resolve(env.TAG_PLUGIN_CLAUDE_ROOT || env.TOKENBOARD_CLAUDE_ROOT || path.join(claudeHome, "projects")),
    claudeStats: path.resolve(path.join(claudeHome, "stats-cache.json")),
    kimi: path.resolve(env.TAG_PLUGIN_KIMI_ROOT || env.TOKENBOARD_KIMI_ROOT || path.join(kimiHome, "sessions"))
  };
}
