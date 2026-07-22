# Install and remove

## Before installation

1. Use only the official TAG Plugin release asset from `TheFysionX/TAG-Plugin`; verify its tag resolves to the expected full 40-character commit.
2. Compare the `.tgz` to the out-of-band expected SHA-256, then to `SHA256SUMS`, and verify its GitHub build-provenance attestation before extraction.
3. Read `install-manifest.json`, `PRIVACY.md`, and `SECURITY.md`.
4. Confirm Node.js 22 or newer is already installed.
5. Run `npm test` and `node src/cli.mjs doctor`.

The confirmed installation also consents to later **stable TAG Plugin updates**. After every successfully committed signed heartbeat, the installed launcher may accept only a newer offer for the exact official GitHub repository, version tag, full commit, asset name, and SHA-256. It independently rechecks those GitHub release facts, safely validates the package contract, installs it as a new immutable version directory, and atomically switches the local launcher pointer. It does not run a mutable branch or an arbitrary server-provided command. A failed update leaves the already committed heartbeat, active release, pairing, state, and pending outbox intact.

Existing `v0.1.9` installations do not contain this updater. They need one explicit, normal install of the first updater-capable release; subsequent compatible stable releases use the hourly heartbeat path above.

Do not use `curl ... | sh`, PowerShell download-and-execute commands, administrator/root elevation, browser-cookie extraction, or provider API/auth credentials. The connector reuses the installed Codex command only through its official app-server RPC; it does not read Codex authentication files.

## Pair one connector

The Artificial Games onboarding returns a short-lived eight-character code and an allowlist of selected providers. Pairing is the first network operation:

```text
node src/cli.mjs pair --endpoint https://YOUR_ARTIFICIAL_GAMES_HOST --code ABCD-EFGH
```

When a The Artificial Games setup prompt lists `Required journals`, that line is the user's explicit approval for those local usage sources. Pass exactly those provider IDs and no others:

```text
node src/cli.mjs pair --endpoint https://YOUR_ARTIFICIAL_GAMES_HOST --code ABCD-EFGH --allow-journal-fallbacks codex,claude,kimi
```

The backend allowlist wins. Asking for a provider that onboarding did not allow does not enable it. Re-running this command against an existing pairing at the exact same endpoint reuses that device and applies the explicitly listed journals without consuming another pairing code. A different endpoint is rejected.

Codex plan and quota-window observations come from its official local app-server. Claude uses first-party account status and, when present, selects the exact allowlisted `rate_limit_tier` from a bounded set of recent Claude Desktop account-bootstrap cache values so Max 5x and Max 20x are not collapsed into a stale/coarse family. Exact cache evidence is accepted only after the current Claude login succeeds and the organization ID matches the cached account membership. Those provider cache values can also contain other account/conversation fields; TAG examines only the entitlement object shape and does not retain, hash, log, or upload other fields. It never opens Claude credentials or cookies. These are content-free heartbeat metadata, not model usage. If Gemini/Antigravity is allowed, TAG uses its version-pinned desktop 2.3.1 adapter only when the local SQLite schema matches; it reads completed-step metadata columns only and never changes Antigravity settings. On heartbeat, it makes two bounded requests to the active same-user Antigravity loopback account service, compares `GetUserStatus.userTier` with `GetLoadCodeAssist.paidTier`, and retains only a bounded normalized native effective-quota code. Antigravity Starter maps to Free. An unregistered paid tier is sent as `unknown:<normalized-native-tier>` and stays unverified until that provider value is registered. Legacy `planInfo`, `teamsTier`, `pro`, `currentTier`, and `allowedTiers` fields never classify a plan. The local CSRF token, endpoint, account fields, and full responses are discarded. The CLI status-line fallback requires separate explicit `--enable-antigravity-statusline` consent before it saves or forwards an existing `statusLine`; it records only a sanitized prospective capture and restores it on uninstall unless the user later changes the setting. Grok Build summaries are diagnostic only and never produce token events. DeepSeek API plan evidence is accepted only when explicit API evidence is available; a hosted DeepSeek model does not imply it.

Before the exchange request is sent, the plugin persists the new Ed25519 key, pairing body (including the short-lived code), approved fallbacks, and fixed request ID only in `pending-device-secrets.json`; ordinary state keeps nonsecret pending status. Windows restricts the plugin directory before creating that credential, then explicitly verifies the pending file's current-user-only ACL before traffic. If the network response is lost, rerun `node src/cli.mjs pair` with the same plugin home; it resumes the exact pending exchange without needing another code. Final config commits before state clears the pending marker, so a one-file write failure also resumes safely. If The Artificial Games permanently rejects pairing—or a permanent authenticated request shows that the device must be replaced—obtain a fresh code and explicitly use `--replace-pending-pair` with the new endpoint and code. An uncommitted rejected sync outbox is then safely recollected because its cursors were never advanced. The existing active device is not replaced until the new response and final secret ACL are validated.

## Inspect before scheduling

```text
node src/cli.mjs preview
node src/cli.mjs status
node src/cli.mjs install --dry-run
```

The dry run shows the exact release-copy destination, current-user scheduler action, explicit connector home, and files. It does not execute anything.

## Install the hourly scheduler

Only after reviewing the dry run:

```text
node src/cli.mjs install --confirm-install
node src/cli.mjs sync
node src/cli.mjs heartbeat
```

- Windows: creates one hourly Task Scheduler task for the current user.
- macOS: creates one user LaunchAgent.
- Linux: creates one `systemd --user` service and timer.

The confirmed install first acquires the connector overlap lock, reclaims only stale exact runtime-JSON atomic temps that pass the lock/age/dead-PID safety checks, copies the already verified release into `<connector-home>/versions/<connector-version>`, writes the stable `launcher.mjs` and atomic `active-release.json` pointer, and makes the scheduler target that launcher. Later verified updates use a separate update lock/state and do not overwrite an existing version directory. Every scheduler command includes `--home <connector-home>`, including when a custom home was supplied. On Windows, a local non-interactive PowerShell ACL operation disables inheritance, replaces all access rules with one full-control grant for the resolved current user, and verifies the resulting SID/rule before continuing; installation stops before copying or scheduling if that operation fails.

The immediate sync uploads the available allowlisted usage records, and the heartbeat establishes continuity without waiting for the first hourly trigger. No platform path uses an administrator, root, SYSTEM account, highest-run-level flag, or system-wide service directory.

## Pause or remove

```text
node src/cli.mjs pause
node src/cli.mjs resume
node src/cli.mjs uninstall --dry-run
node src/cli.mjs uninstall --confirm-uninstall
```

Uninstall removes the scheduler registration, stable launcher/pointer, and all TAG Plugin versioned release copies. If TAG still owns an installed Antigravity wrapper, it restores the saved prior `statusLine`; a newer user-owned value is preserved. It deliberately preserves normal local state, update state, pending recovery journals, and the device key so an accidental uninstall can be recovered. Revoke the device from your account with The Artificial Games before deleting preserved state. There is no implicit local-state deletion command.
