# Copy-ready agent install prompts

Replace every angle-bracket placeholder before giving a prompt to Codex, Claude Code, or another coding agent. Use a published release tag, its full 40-character commit SHA, and the archive's separately displayed SHA-256. Native approval dialogs may still appear; the agent must not bypass them.

**Credential disclosure:** a coding-agent prompt may be sent to and retained by that provider under its normal product terms. If `<PAIR_CODE>` is placed in the prompt, the provider receives that short-lived credential. The recommended flow below keeps the code out of model context by having the user enter it directly in a local terminal after review. The true one-message option is retained for convenience, but explicitly accepts this tradeoff.

## Recommended: inspect, preview, then ask once

```text
Install the open-source TAG Plugin release <RELEASE_TAG> from https://github.com/TheFysionX/TAG-Plugin. The release tag must resolve exactly to commit <FULL_40_CHARACTER_COMMIT_SHA>, and the expected release archive SHA-256 is <ARCHIVE_SHA256>.

Safety requirements:
1. Download the release `.tgz` and `SHA256SUMS` normally (a browser or `gh release download` is fine); do not use curl|shell, PowerShell download-and-execute, eval, a moving branch, or an unpinned package.
2. Verify the tag target is the full commit above. Compute the archive SHA-256 and require an exact match to <ARCHIVE_SHA256>, then require that same digest to match its `SHA256SUMS` entry, and require `gh attestation verify` to validate the archive for this repository. Extract only that verified archive into a temporary review directory.
3. In the extracted package, read README.md, install-manifest.json, PRIVACY.md, SECURITY.md, THREAT_MODEL.md, and package.json. Confirm it has zero third-party dependencies.
4. Run npm test from the extracted attested release artifact. Its packaged test fixtures are synthetic. Do not continue if a test fails, the test directory is absent, or the files differ from the manifest.
5. Never request or read provider credentials, API keys, browser cookies, auth files, my unrelated source repositories, or environment secrets. You, the installer agent, must not inspect, print, retain, hash, log, or upload prompt/response/tool content. An explicitly approved journal adapter may open only its listed journal and extract only the documented allowlisted usage subset. Do not elevate to administrator/root.
6. Show me the exact files it will create, stable versioned install destination, provider surfaces it will read, fields it will send, HTTPS origin, scheduler command including its explicit --home argument, cadence, permissions, checksum, and uninstall command. On Windows, confirm the device-secret ACL will be restricted to my current identity before scheduling.
7. Run only: node src/cli.mjs preview and node src/cli.mjs install --dry-run. Do not pair, send traffic, or install yet.
8. Stop and ask for my explicit approval after showing that review.

If I approve, show me the exact pair command for The Artificial Games endpoint <ARTIFICIAL_GAMES_HTTPS_ORIGIN> with a literal `<PAIR_CODE>` placeholder and only these explicitly approved journal fallbacks: <COMMA_SEPARATED_CODEX_CLAUDE_KIMI_OR_EMPTY>, then stop so I can enter the short-lived code and run that command directly in my terminal. After I confirm pairing completed, rerun preview, install the current-user hourly scheduler with --confirm-install, and send one immediate heartbeat to establish continuity. Confirm it copied the verified release into the manifest's stable current-user version directory. Never install a system service or replace another product's status line/hook.
```

## Pre-authorized: one message, exact bounded scope

```text
I explicitly authorize one current-user installation of the open-source TAG Plugin release <RELEASE_TAG> from https://github.com/TheFysionX/TAG-Plugin. Its tag must resolve exactly to commit <FULL_40_CHARACTER_COMMIT_SHA>, and the expected release archive SHA-256 is <ARCHIVE_SHA256>. Pair it to The Artificial Games endpoint <ARTIFICIAL_GAMES_HTTPS_ORIGIN> with short-lived code <PAIR_CODE>. Approved journal fallbacks are exactly: <COMMA_SEPARATED_CODEX_CLAUDE_KIMI_OR_NONE>. I understand this coding-agent provider may receive and retain this prompt and short-lived code under its normal product terms.

You may complete the install in this message only if every condition below passes:
- Download the release `.tgz` and `SHA256SUMS` normally (a browser or `gh release download` is fine). Verify the tag target is the full commit above. Compute the archive SHA-256 and require an exact match to <ARCHIVE_SHA256>, require that same digest to match `SHA256SUMS`, and require `gh attestation verify` to validate that archive for this repository. Extract only the verified archive into a temporary review directory. Never use curl|shell, download-and-execute, eval, a moving branch, or an unpinned package.
- Read README.md, install-manifest.json, PRIVACY.md, SECURITY.md, THREAT_MODEL.md, and package.json; confirm there are zero third-party dependencies; run npm test successfully from the extracted attested release artifact using its packaged synthetic fixtures.
- Confirm the only local reads, writes, outbound fields, stable versioned destination, scheduler command (including explicit --home), and permissions match install-manifest.json. On Windows, confirm the current-user device-secret ACL. Print that concise verification before acting.
- Never request/read provider credentials, API keys, browser cookies, auth files, my unrelated source repositories, or environment secrets. You, the installer agent, must not inspect, print, retain, hash, log, or upload prompt/response/tool content. An explicitly approved journal adapter may open only its listed journal and extract only the documented allowlisted usage subset. Never elevate to administrator/root and never install a system-wide service.
- Run preview, pair exactly one TAG Plugin installation for all backend-authorized providers, run preview again, show the current-user scheduler dry run, then run install --confirm-install. If the pairing response is lost, resume the persisted pending pair; do not invent a new key or consume another code.
- Do not enable a journal fallback not listed above. Do not replace an existing status line, hook, extension, or provider configuration.
- After installation, send one immediate heartbeat, then show status, the scheduler entry, pause/resume commands, and uninstall --dry-run output. Do not delete local state.

If any check differs, the tag target differs, a checksum/attestation is unavailable, tests fail, the endpoint redirects to another origin, or an unexpected permission/file/network destination appears, stop without installing or pairing and explain the mismatch. Native security approval prompts are allowed and must remain visible to me. Remove only the temporary review/download directory after success; do not remove TAG Plugin state or the stable versioned installation.
```
