import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateReleaseContract } from "../scripts/validate-release-contract.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("release contract requires exact matching production versions and tag", () => {
  assert.deepEqual(validateReleaseContract({
    packageName: "@the-artificial-games/tag-plugin",
    packageVersion: "1.2.3",
    connectorVersion: "1.2.3",
    manifestVersion: "1.2.3",
    manifestArchiveName: "tag-plugin-1.2.3.tgz",
    tag: "v1.2.3"
  }), {
    version: "1.2.3",
    tag: "v1.2.3",
    packageName: "@the-artificial-games/tag-plugin",
    archiveName: "tag-plugin-1.2.3.tgz"
  });
  assert.throws(() => validateReleaseContract({
    packageName: "@the-artificial-games/tag-plugin",
    packageVersion: "1.2.3-local",
    connectorVersion: "1.2.3-local",
    manifestVersion: "1.2.3-local",
    manifestArchiveName: "tag-plugin-1.2.3-local.tgz",
    tag: "v1.2.3-local"
  }), /-local/);
  assert.throws(() => validateReleaseContract({
    packageName: "@the-artificial-games/tag-plugin",
    packageVersion: "1.2.3",
    connectorVersion: "1.2.3",
    manifestVersion: "1.2.3",
    manifestArchiveName: "tag-plugin-1.2.3.tgz",
    tag: "v9.9.9"
  }), /exactly equal/);
  assert.throws(() => validateReleaseContract({
    packageName: "@the-artificial-games/tag-plugin",
    packageVersion: "1.2.3",
    connectorVersion: "1.2.4",
    manifestVersion: "1.2.3",
    manifestArchiveName: "tag-plugin-1.2.3.tgz",
    tag: "v1.2.3"
  }), /versions must match/);
  assert.throws(() => validateReleaseContract({
    packageName: "@tokenboard/connector",
    packageVersion: "1.2.3",
    connectorVersion: "1.2.3",
    manifestVersion: "1.2.3",
    manifestArchiveName: "tag-plugin-1.2.3.tgz",
    tag: "v1.2.3"
  }), /package\.json name/);
  assert.throws(() => validateReleaseContract({
    packageName: "@the-artificial-games/tag-plugin",
    packageVersion: "1.2.3",
    connectorVersion: "1.2.3",
    manifestVersion: "1.2.3",
    manifestArchiveName: "tokenboard-connector-1.2.3.tgz",
    tag: "v1.2.3"
  }), /archive/);
});

test("release workflow validates the contract before npm pack", async () => {
  const workflow = await fs.readFile(path.join(root, ".github", "workflows", "release.yml"), "utf8");
  const guard = workflow.indexOf('node scripts/validate-release-contract.mjs "$GITHUB_REF_NAME"');
  const pack = workflow.indexOf("npm pack");
  const draft = workflow.indexOf('gh release create "${GITHUB_REF_NAME}"');
  const upload = workflow.indexOf('gh release upload "${GITHUB_REF_NAME}"');
  const publish = workflow.indexOf('gh release edit "${GITHUB_REF_NAME}" --draft=false');
  assert.ok(guard >= 0);
  assert.ok(pack > guard);
  assert.ok(draft > pack);
  assert.ok(upload > draft);
  assert.ok(publish > upload);
  assert.match(workflow, /gh release create[\s\S]*--draft --verify-tag/);
  assert.match(workflow, /RELEASE_ARCHIVE="tag-plugin-\$\(node -p/);
  assert.match(workflow, /subject-path: tag-plugin-\*\.tgz/);
  assert.match(workflow, /gh release upload[\s\S]*tag-plugin-\*\.tgz SHA256SUMS/);
});
