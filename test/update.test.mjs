import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { runtimePaths } from "../src/paths.mjs";
import { activateRelease, extractVerifiedArchive, fetchAndInstallUpdate, validateUpdateOffer } from "../src/update.mjs";

const REPOSITORY = "https://github.com/TheFysionX/TAG-Plugin";
const COMMIT = "a".repeat(40);

function tarHeader(name, contents = Buffer.alloc(0), type = "0") {
  const header = Buffer.alloc(512);
  const write = (offset, length, value) => header.write(String(value), offset, length, "utf8");
  const octal = (offset, length, value) => write(offset, length, `${Number(value).toString(8).padStart(length - 1, "0")}\0`);
  write(0, 100, name);
  octal(100, 8, 0o600);
  octal(108, 8, 0);
  octal(116, 8, 0);
  octal(124, 12, contents.length);
  octal(136, 12, 0);
  header.fill(0x20, 148, 156);
  write(156, 1, type);
  write(257, 6, "ustar\0");
  write(263, 2, "00");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  write(148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return header;
}

function tarGzip(entries) {
  const blocks = [];
  for (const entry of entries) {
    const contents = Buffer.from(entry.contents || "", "utf8");
    blocks.push(tarHeader(entry.name, contents, entry.type || "0"), contents);
    const padding = (512 - (contents.length % 512)) % 512;
    if (padding) blocks.push(Buffer.alloc(padding));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

function releaseFor(version, archive) {
  return {
    repository: REPOSITORY,
    version,
    tag: `v${version}`,
    commit: COMMIT,
    asset: `tag-plugin-${version}.tgz`,
    sha256: createHash("sha256").update(archive).digest("hex"),
    updaterProtocol: 1,
    runtimeStateSchema: 1
  };
}

function validArchive(version) {
  const manifest = {
    connectorVersion: version,
    product: { repository: REPOSITORY, package: "@the-artificial-games/tag-plugin" },
    releaseArtifact: { archiveName: `tag-plugin-${version}.tgz` },
    updates: { updaterProtocol: 1, runtimeStateSchema: 1 },
    runtime: { thirdPartyDependencies: [] }
  };
  const required = {
    "package/package.json": JSON.stringify({ name: "@the-artificial-games/tag-plugin", version }),
    "package/install-manifest.json": JSON.stringify(manifest),
    "package/src/cli.mjs": "export {};\n",
    "package/src/constants.mjs": `export const CONNECTOR_VERSION = \"${version}\";\n`,
    "package/src/launcher.mjs": "export {};\n",
    "package/scripts/validate-release-contract.mjs": "export {};\n",
    "package/README.md": "# TAG Plugin\n",
    "package/INSTALL.md": "# Install\n",
    "package/PRIVACY.md": "# Privacy\n",
    "package/SECURITY.md": "# Security\n",
    "package/THREAT_MODEL.md": "# Threat model\n"
  };
  return tarGzip(Object.entries(required).map(([name, contents]) => ({ name, contents })));
}

function mockedGithub(release, archive, options = {}) {
  const assetUrl = `${REPOSITORY}/releases/download/${release.tag}/${release.asset}`;
  const hostedAsset = "https://release-assets.githubusercontent.com/tag-plugin-test";
  return async (input) => {
    const url = String(input);
    if (url.endsWith(`/git/ref/tags/${release.tag}`)) {
      return Response.json({ object: { type: "commit", sha: options.tagCommit || release.commit } });
    }
    if (url.endsWith(`/releases/tags/${release.tag}`)) {
      return Response.json({
        tag_name: release.tag,
        draft: options.draft === true,
        prerelease: options.prerelease === true,
        assets: [{ name: release.asset, browser_download_url: options.assetUrl || assetUrl }]
      });
    }
    if (url === assetUrl) return new Response(null, { status: 302, headers: { location: options.redirect || hostedAsset } });
    if (url === hostedAsset) return new Response(options.archive || archive, { status: 200 });
    throw new Error(`Unexpected URL: ${url}`);
  };
}

async function temporaryPaths(context) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "tag-plugin-update-test-"));
  context.after(() => fs.rm(home, { recursive: true, force: true }));
  return runtimePaths({ home });
}

test("update offers accept only a strictly newer exact pinned release contract", () => {
  const archive = validArchive("0.2.0");
  const release = releaseFor("0.2.0", archive);
  const valid = { available: true, release };
  assert.deepEqual(validateUpdateOffer(valid, "0.1.9"), release);
  assert.equal(validateUpdateOffer(valid, "0.2.0"), null);
  assert.equal(validateUpdateOffer(valid, "0.3.0"), null);
  assert.equal(validateUpdateOffer({ ...valid, ignored: true }, "0.1.9"), null);
  assert.equal(validateUpdateOffer({ available: true, release: { ...release, repository: "https://github.com/other/repo" } }, "0.1.9"), null);
  assert.equal(validateUpdateOffer({ available: true, release: { ...release, sha256: "B".repeat(64) } }, "0.1.9"), null);
  assert.equal(validateUpdateOffer({ available: true, release: { ...release, updaterProtocol: 2 } }, "0.1.9"), null);
});

test("verified GitHub tag/release/asset flow installs an immutable release and reuses its exact receipt", async (context) => {
  const paths = await temporaryPaths(context);
  const archive = validArchive("0.2.0");
  const release = releaseFor("0.2.0", archive);
  const options = { updateFetchImpl: mockedGithub(release, archive) };
  const first = await fetchAndInstallUpdate(paths, release, options);
  assert.equal(first.installed, true);
  assert.equal(first.reused, false);
  assert.equal(await fs.readFile(path.join(first.destination, "src", "cli.mjs"), "utf8"), "export {};\n");
  const receipt = JSON.parse(await fs.readFile(path.join(first.destination, "release-receipt.json"), "utf8"));
  assert.equal(receipt.commit, COMMIT);
  assert.equal(receipt.sha256, release.sha256);
  const second = await fetchAndInstallUpdate(paths, release, options);
  assert.equal(second.installed, false);
  assert.equal(second.reused, true);
  await fs.writeFile(path.join(first.destination, "src", "cli.mjs"), "export const tampered = true;\n", "utf8");
  await assert.rejects(
    () => fetchAndInstallUpdate(paths, release, options),
    (error) => error?.code === "VERSION_IDENTITY_CONFLICT"
  );
  await fs.writeFile(path.join(first.destination, "src", "cli.mjs"), "export {};\n", "utf8");
  await fs.writeFile(path.join(first.destination, "release-receipt.json"), "{}\n", "utf8");
  await assert.rejects(
    () => fetchAndInstallUpdate(paths, release, options),
    (error) => error?.code === "VERSION_IDENTITY_CONFLICT"
  );
});

test("activation fails closed on a corrupt existing pointer", async (context) => {
  const paths = await temporaryPaths(context);
  await fs.mkdir(paths.home, { recursive: true });
  await fs.writeFile(paths.activeRelease, "{not-json\n", "utf8");
  await assert.rejects(
    () => activateRelease(paths, { version: "0.2.0" }),
    (error) => error?.code === "ACTIVE_RELEASE_INVALID"
  );
  assert.equal(await fs.readFile(paths.activeRelease, "utf8"), "{not-json\n");
});

test("rejects SHA mismatch, tag mismatch, and draft release before installing", async (context) => {
  const paths = await temporaryPaths(context);
  const archive = validArchive("0.2.0");
  const release = releaseFor("0.2.0", archive);
  await assert.rejects(
    () => fetchAndInstallUpdate(paths, { ...release, sha256: "0".repeat(64) }, { updateFetchImpl: mockedGithub({ ...release, sha256: "0".repeat(64) }, archive) }),
    (error) => error?.code === "UPDATE_SHA256_MISMATCH"
  );
  await assert.rejects(
    () => fetchAndInstallUpdate(paths, release, { updateFetchImpl: mockedGithub(release, archive, { tagCommit: "b".repeat(40) }) }),
    (error) => error?.code === "UPDATE_COMMIT_MISMATCH"
  );
  await assert.rejects(
    () => fetchAndInstallUpdate(paths, release, { updateFetchImpl: mockedGithub(release, archive, { draft: true }) }),
    (error) => error?.code === "UPDATE_RELEASE_INVALID"
  );
  assert.deepEqual(await fs.readdir(paths.home).catch(() => []), []);
});

test("safe archive extractor rejects traversal paths, link types, and duplicate files", async (context) => {
  const paths = await temporaryPaths(context);
  const cases = [
    {
      code: "UPDATE_ARCHIVE_PATH_REJECTED",
      archive: tarGzip([{ name: "package/../../escape.txt", contents: "no" }])
    },
    {
      code: "UPDATE_ARCHIVE_TYPE_REJECTED",
      archive: tarGzip([{ name: "package/src/cli.mjs", contents: "", type: "2" }])
    },
    {
      code: "UPDATE_ARCHIVE_DUPLICATE",
      archive: tarGzip([
        { name: "package/src/cli.mjs", contents: "one" },
        { name: "package/src/cli.mjs", contents: "two" }
      ])
    }
  ];
  for (const [index, fixture] of cases.entries()) {
    const destination = path.join(paths.home, `archive-${index}`);
    await fs.mkdir(destination, { recursive: true });
    await assert.rejects(
      () => extractVerifiedArchive(fixture.archive, destination),
      (error) => error?.code === fixture.code
    );
  }
});
