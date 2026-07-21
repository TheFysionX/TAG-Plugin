import fs from "node:fs/promises";
import path from "node:path";

const MAX_DISCOVERED_FILES = 20_000;

export async function discoverJsonlFiles(root, options = {}) {
  const maximum = options.maximum || MAX_DISCOVERED_FILES;
  const discoveryLimit = maximum + 1;
  const files = [];
  const pending = [root];
  let unavailable = false;

  while (pending.length > 0 && files.length < discoveryLimit) {
    const directory = pending.pop();
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "EACCES" || error?.code === "EPERM") {
        unavailable = true;
        continue;
      }
      throw error;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        continue;
      }
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(candidate);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".jsonl")) {
        files.push(candidate);
        if (files.length >= discoveryLimit) {
          break;
        }
      }
    }
  }
  files.sort((a, b) => a.localeCompare(b));
  const truncated = files.length > maximum;
  return { files: files.slice(0, maximum), unavailable, truncated };
}
