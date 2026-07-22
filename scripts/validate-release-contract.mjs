import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONNECTOR_VERSION } from "../src/constants.mjs";

const RELEASE_PACKAGE_NAME = "@the-artificial-games/tag-plugin";

export function validateReleaseContract({
  packageName,
  packageVersion,
  connectorVersion,
  manifestVersion,
  manifestArchiveName,
  updaterProtocol,
  runtimeStateSchema,
  tag
}) {
  if (packageName !== RELEASE_PACKAGE_NAME) {
    throw new Error(`package.json name must exactly equal ${RELEASE_PACKAGE_NAME}.`);
  }
  if (typeof packageVersion !== "string" || packageVersion.length === 0) {
    throw new Error("package.json must contain a non-empty version.");
  }
  if (packageVersion.endsWith("-local")) {
    throw new Error("Release publishing is disabled for a -local package version.");
  }
  if (connectorVersion !== packageVersion || manifestVersion !== packageVersion) {
    throw new Error("package.json, CONNECTOR_VERSION, and install-manifest.json versions must match.");
  }
  const expectedTag = `v${packageVersion}`;
  const expectedArchiveName = `tag-plugin-${packageVersion}.tgz`;
  if (tag !== expectedTag) {
    throw new Error(`Release tag ${tag || "<missing>"} must exactly equal ${expectedTag}.`);
  }
  if (manifestArchiveName !== expectedArchiveName) {
    throw new Error(`Release archive must exactly equal ${expectedArchiveName}.`);
  }
  if (updaterProtocol !== 1 || runtimeStateSchema !== 1) {
    throw new Error("Release auto-update compatibility must remain updater protocol 1 and runtime state schema 1.");
  }
  return {
    version: packageVersion,
    tag: expectedTag,
    packageName: RELEASE_PACKAGE_NAME,
    archiveName: expectedArchiveName
  };
}

async function main() {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const [packageJson, manifest] = await Promise.all([
    fs.readFile(path.join(root, "package.json"), "utf8").then(JSON.parse),
    fs.readFile(path.join(root, "install-manifest.json"), "utf8").then(JSON.parse)
  ]);
  const result = validateReleaseContract({
    packageName: packageJson.name,
    packageVersion: packageJson.version,
    connectorVersion: CONNECTOR_VERSION,
    manifestVersion: manifest.connectorVersion,
    manifestArchiveName: manifest.releaseArtifact?.archiveName,
    updaterProtocol: manifest.updates?.updaterProtocol,
    runtimeStateSchema: manifest.updates?.runtimeStateSchema,
    tag: process.argv[2] || process.env.GITHUB_REF_NAME
  });
  process.stdout.write(`Validated release ${result.tag}.\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`Release contract failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
