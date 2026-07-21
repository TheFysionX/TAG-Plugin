# Publishing a connector release

The connector must live in its own **public** GitHub repository with the contents of this directory at the repository root. Public visibility is required for GitHub artifact attestations on Free, Pro, and Team plans; private attestation requires GitHub Enterprise Cloud.

## One-time repository setup

1. Enable **Settings > Releases > Enable release immutability** before publishing the first release. This setting applies only to future releases.
2. Enable private vulnerability reporting so the route described in `SECURITY.md` is available.
3. Keep GitHub Actions enabled and leave the workflow's default token permissions restricted. The release job declares only the permissions it needs.
4. Do not add secrets, Cloudflare credentials, pairing codes, production endpoints, or user journals to this repository.

## Release procedure

1. Set the same stable semantic version in `package.json`, `src/constants.mjs`, and `install-manifest.json`. A release version must not end in `-local`.
2. Run:

   ```text
   npm run check
   npm run pack:dry-run
   node scripts/validate-release-contract.mjs v0.1.1
   ```

3. Commit the exact reviewed source and push the commit to `main`.
4. Create and push the exact tag `v<package-version>` at that commit. Never move or reuse a release tag.
5. Let `.github/workflows/release.yml` build and test the package. The workflow creates a draft release, attaches the tested `.tgz` and `SHA256SUMS`, creates build-provenance attestation for the `.tgz`, and only then publishes the release. With repository release immutability enabled, GitHub locks the published tag and assets and creates its separate release attestation.
6. Download the published asset and verify it independently:

   ```text
   gh release download v0.1.1 -R TheFysionX/TAG-Plugin
   gh attestation verify tag-plugin-0.1.1.tgz -R TheFysionX/TAG-Plugin
   ```

   Also compute the archive SHA-256 and require it to match `SHA256SUMS`.
7. Configure the deployment for The Artificial Games from the published release, never from a local build:

   ```text
   CONNECTOR_REPOSITORY_URL=https://github.com/TheFysionX/TAG-Plugin
   CONNECTOR_RELEASE_TAG=v0.1.1
   CONNECTOR_RELEASE_COMMIT=<full 40-character tag commit SHA>
   CONNECTOR_RELEASE_ASSET=tag-plugin-0.1.1.tgz
   CONNECTOR_RELEASE_SHA256=<64-character SHA-256 from SHA256SUMS>
   ```

8. Generate one-message pairing prompts only after the deployed site reports that exact release configuration as ready.

If the workflow fails after creating its draft, inspect or delete only the unpublished draft and rerun from the same unchanged tag. Never replace an asset on a published release; increment the connector version and publish a new release instead.
