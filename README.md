# TAG Plugin

TAG Plugin is a small, inspectable Node.js program that turns usage records already present on a user's coding machine into privacy-minimal events for The Artificial Games. One installation covers every provider selected during The Artificial Games onboarding; it is not installed once per provider or once per coding agent.

Official builds are published only as versioned, checksummed, attested GitHub release assets. A source checkout is a development copy; install only an exact release artifact after verifying its tag, commit, SHA-256, and GitHub attestation as described in [INSTALL.md](./INSTALL.md).

## What is supported

| Provider | Preferred source | Model-level source | Current status |
| --- | --- | --- | --- |
| Codex | Official `codex app-server` `account/usage/read` aggregate | Rollout JSONL `token_count` records | Official aggregate is a provider-backed checkpoint. The website setup authorizes journal model detail for connected providers. |
| Claude Code | A future documented aggregate API | Project JSONL terminal assistant usage snapshots | The website setup authorizes journal model detail for connected providers. Partial rows without `message.stop_reason` are withheld. An undocumented `stats-cache.json` is detected but never used to invent model detail. |
| Kimi Code | A future content-free aggregate API | v0.28 `wire.jsonl` `usage.record` records | Version-pinned journal support is authorized by the website setup. The current backend advertises Kimi and accepts its registered models/modes. |
| Gemini / Antigravity | Official telemetry where it fits the user's product tier | None yet | Planned. Gemini CLI OTel is not universal consumer/Antigravity history. |
| Grok Build | Official telemetry | None yet | Planned. |

The Codex, Claude, and Kimi journals can contain sensitive text. The connector opens only the journals authorized by the website installation prompt, prefilters unrelated lines, extracts an allowlisted usage subset, and never uploads, stores, hashes, or logs prompt/response/tool content. Raw journal paths never upload or enter logs. A keyed alias derived from each path is persisted locally so byte cursors can resume without retaining the raw path. Codex/Kimi resumes verify file metadata plus a rolling digest made only from previously allowlisted usage/model/mode fields; prompt and tool text never enter that digest. Unknown model tokens must match a strict identifier grammar and enter a capped 2,000-record local queue containing only normalized usage fields. Known records behind them continue normally; queue size and overflow are visible in status and make heartbeat health degraded.

## Commands

```text
node src/cli.mjs preview
node src/cli.mjs pair --endpoint https://YOUR_ARTIFICIAL_GAMES_HOST --code ABCD-EFGH
node src/cli.mjs sync
node src/cli.mjs heartbeat
node src/cli.mjs status
node src/cli.mjs doctor
node src/cli.mjs install --dry-run
node src/cli.mjs install --confirm-install
node src/cli.mjs pause
node src/cli.mjs resume
node src/cli.mjs uninstall --dry-run
node src/cli.mjs uninstall --confirm-uninstall
```

`preview` makes no upload to The Artificial Games, but it can invoke the official local Codex app-server to obtain provider-backed account usage; that subprocess controls whether it refreshes its own data. `status`, `doctor`, `pause`, `resume`, and dry runs make no network requests. `pair`, `sync`, and `heartbeat` are the only plugin commands that send data to The Artificial Games. Scheduler mutation requires the exact `--confirm-install` or `--confirm-uninstall` flag.

Journal adapters remain off unless pairing both authorizes that provider and includes an explicit flag such as:

```text
--allow-journal-fallbacks codex,claude,kimi
```

## Security model

- A fresh Ed25519 keypair and fixed exchange request are persisted before pairing traffic. A lost response resumes the same key and request instead of consuming a code with an unrecoverable key.
- Every request signs the exact request body, route, timestamp, request ID, and monotonic sequence.
- Every authenticated body carries the prior accepted request digest. Replays, gaps, rollback, and divergent chains are server-detectable.
- Event IDs use a server-issued account-scoped HMAC namespace and content-independent source identity. Claude uses its message ID, Codex uses stable session plus timestamp occurrence ordinal, and Kimi uses a provider record ID when present or stable journal plus timestamp occurrence ordinal. Token/model/mode values stay out of identity, so a corrected payload keeps its ID and becomes a detectable conflict instead of extra score.
- Local file aliases use a separate installation-only HMAC key. Raw paths never enter an outbound body, state file, or safe log.
- Event and checkpoint requests are disjoint and capped at three events or two checkpoints. Catch-up requests are paced 550 ms apart and honor bounded HTTP `Retry-After`; scheduled runs process at most 1,000 ingest requests, interleave a signed heartbeat every 50 ingest requests, and send a final heartbeat even when backlog remains. Permanent invalid same-type chunks are bisected and isolated records are quarantined.
- Installation copies the verified release into a stable current-user version directory. The hourly scheduler targets that copy with an explicit connector home, runs one sync and one signed heartbeat, and uses no elevation or system account.
- Every state-changing command holds an owner-token lock whose filesystem lease renews every one quarter of the stale window. Stale takeover is atomic, refuses to replace a live owner PID, and release removes only its own lock.
- Windows pairing first restricts the connector directory so a new credential inherits user-only access, then verifies the pending secret before network traffic and the final secret before commit; installation re-verifies the current-user ACL before scheduling. POSIX secret files use mode `0600`.
- Logs are allowlisted and rotate at 256 KiB with one retained backup.

This is tamper evidence, not proof of honest usage. A user who controls an open-source client controls its inputs. Provider-backed checkpoints and future provider APIs create stronger cross-checks; connector-reported journal events must remain labeled as connector-reported.

See [INSTALL.md](./INSTALL.md), [PRIVACY.md](./PRIVACY.md), [SECURITY.md](./SECURITY.md), and [THREAT_MODEL.md](./THREAT_MODEL.md).

## Local verification

Requires Node.js 22 or newer and no third-party packages:

```text
npm test
npm run check
npm run pack:dry-run
```
