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

The Codex, Claude, and Kimi journals can contain sensitive text. The connector opens only the journals authorized by the website installation prompt, prefilters unrelated lines, extracts an allowlisted usage subset, and never uploads, stores, hashes, or logs prompt/response/tool content. Raw journal paths never upload or enter logs. A keyed alias derived from each path is persisted locally so byte cursors can resume without retaining the raw path. Codex/Kimi resumes verify file metadata plus a rolling digest made only from previously allowlisted usage/model/mode fields; prompt and tool text never enter that digest. If either model or speed cannot be attributed, the usage uploads immediately with the atomic `attribution: raw_only`, `modelId: unknown`, `serviceMode: unknown` sentinel. It remains visible as Raw Tokens but is structurally ineligible for Kleos. The raw source-model token never uploads.

The first journal import covers all retained history that can be discovered and parsed safely; the server independently decides which observations are eligible for weekly Kleos. Eligible raw records are deduplicated by account-scoped source ID, then reduced into stable aggregates keyed by provider, source session, UTC hour, raw source-model token, raw mode token, and coding surface. Uncached input, cache-read input, and cache-write input remain separate canonical counters. Parser/accounting generation, collector provenance, and canonical model classification are not part of logical aggregate identity. A corrected canonical observation therefore keeps the same event ID and arrives as a payload revision instead of minting separately scoreable usage; raw-only and attributed projections likewise share the logical ID. Stable session-hour aggregates are not sharded, so server anomaly and quarantine rules see their full volume. Each enabled provider advances its own settled-through watermark after discovery and bounded parsing reach the range boundary; a disabled, unavailable, truncated, or event-limited provider retains its prior watermark. Malformed or oversized records are irreversible parse losses in this release: coverage remains explicitly `partial` with a privacy-safe count and the repair/backfill remains pending, while the watermark may still advance so later valid usage is not pinned behind an old unreadable line. Raw history is described as retained history, never as a guaranteed complete provider lifetime ledger.

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
- Raw source identities are account-scoped HMACs: Claude uses its message ID, Codex uses the first owner session plus lineage epoch and cumulative endpoint, and Kimi uses a provider record ID when present or stable journal plus timestamp occurrence ordinal. They deduplicate raw records locally. Codex and Claude logical aggregates retain the released v4 identity domain and Kimi retains v3. Aggregate identity binds provider, stable source-session scope, UTC hour, raw source-model token, raw mode token, and coding surface independently of source-ID set, parser/accounting generation, collector provenance, canonical model mapping, and raw-versus-attributed classification. Neither raw source IDs nor the identity inputs upload as separate fields; changed canonical observation fields are request-digested as a revision under the same event ID.
- Local file aliases use a separate installation-only HMAC key. Raw paths never enter an outbound body, state file, or safe log.
- Event and checkpoint requests are disjoint and capped at three events or two checkpoints. Before every eligible Codex checkpoint plan, a signed heartbeat hydrates the account's active snapshot head so reinstalls and multiple devices extend the current parent rather than guessing. Codex provider evidence uses a parent-linked snapshot generation: only changed daily values are tagged `daily_delta`, followed by one lifetime `commit` marker containing the generation ID, parent generation ID, canonical full-snapshot digest, and delta count. The connector persists its submitted generation, digest, lifetime value, and daily-value map only after the backend explicitly confirms every checkpoint's exact digest and confirms that the submitted commit generation is active. An identical snapshot sends nothing; a correction with the same lifetime sends only its changed dates and marker; returning from A to B to A creates a new child generation even though A's snapshot digest repeats. Every Codex checkpoint carries `sourceScope: codex_subscription_account`. If another device wins a parent race, the connector hydrates that active head, retires only the stale checkpoint generation, and keeps draining the same durable event pages before committing their source cursors; checkpoint evidence is replanned from the hydrated parent on the next sync. Event catch-up is ordered newest hour first and divided into private pages of at most 5,000 events. The active page is embedded in `state.json`; future content-free pages live under `sync-pages/<batch-id>/` and every page is bound to the state's event-count and digest manifest. A missing, oversized, malformed, or digest-mismatched page fails closed. No collection cursors or provider watermarks commit until the final page completes, after which the private batch directory is removed. Requests are paced 550 ms apart and honor bounded HTTP `Retry-After`; an interactive sync processes at most 100 ingest requests, while scheduled runs process at most 1,000, interleave a signed heartbeat every 50 requests, and send a final heartbeat even when backlog remains. Permanent invalid same-type chunks are bisected, but an isolated item remains blocked rather than advancing its cursor without proof. Every submitted event requires exactly one matching response with `submittedRevisionActive: true`, or `submittedObservationCanonical: true` when the backend proves an exact content duplicate is canonical under another logical event. A raw-only event additionally requires `rawPreserved: true`; aggregate counts and status labels alone never authorize cursor commit.
- An upgraded v0.1.6 install has no local checkpoint generation. An already-persisted signed legacy outbox drains unchanged and its checkpoints remain audit evidence without activating the new projection. The signed hydration response explicitly reports no modern active snapshot before the first fresh v0.1.7 snapshot uses the all-zero genesis parent and sends every currently observed daily value. The backend accepts that takeover only once when the active generation is explicitly legacy; a reinstall with a modern active generation hydrates it instead. Normal parent equality is mandatory thereafter. The connector neither discards pending signed work nor treats the retired v0.1.6 checkpoint hash as a generation ID.
- Installation copies the verified release into a stable current-user version directory. The hourly scheduler targets that copy with an explicit connector home, runs one sync and one signed heartbeat, and uses no elevation or system account.
- Every state-changing command holds an owner-token lock whose filesystem lease renews every one quarter of the stale window. Stale takeover is atomic, refuses to replace a live owner PID, and release removes only its own lock.
- Runtime JSON uses exclusive-create temporary files followed by one atomic rename. If Windows transiently refuses replacement with `EEXIST` or `EPERM`, the connector retries that same atomic primitive five times with bounded delay; exhaustion fails closed without unlinking the prior committed JSON and removes only its new temp. A later state-changing startup can reclaim a crash-stranded temp only after the 15-minute lease window, while it owns the canonical overlap lock, when the filename exactly names a known runtime JSON target, the encoded writer PID is no longer live, and the unchanged committed counterpart still exists as a regular file. A temp that is the sole recovery copy is preserved. Cleanup scans only connector-home root and direct exact `sync-pages/<batch-id>` children with fixed entry limits; it does not glob or recurse.
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
