# Privacy contract

## Coding-agent prompt boundary

The install prompt is handled by Codex, Claude Code, or the coding-agent provider before TAG Plugin runs. Anything placed in that prompt may be transmitted to and retained by that provider under its normal product terms. A true one-message install includes the short-lived The Artificial Games pairing code, so that code is exposed to the chosen coding-agent provider. The safer recommended flow keeps the code out of model context and has the user enter it directly in a local terminal after review. This disclosure is separate from the plugin's outbound-data contract below.

## Data read locally

The preferred source is content-free, provider-backed usage data. Today that is available for Codex through the official `codex app-server` `account/usage/read` RPC. It returns lifetime/daily aggregates but no model or fast-mode breakdown. The connector does not read Codex auth files; the official subprocess may use its existing signed-in session and controls any provider refresh it performs.

Model-level fallbacks are disabled until the user explicitly opts in:

- Codex rollout journals: only `turn_context` model/service tier and `event_msg` `token_count.info.last_token_usage` records.
- Claude Code project journals: only terminal assistant rows with a non-empty `message.stop_reason`, then message ID, timestamp, model, provider-specific `message.usage.speed`, and `message.usage` counters. Partial streaming rows are withheld; terminal duplicates collapse to the final/maximum usage snapshot. This is a version-observed fallback, not a provider stability guarantee.
- Kimi Code v0.28 wire journals: only `usage.record` model, time, usage counters, and usage scope.

On first connection, journal processing covers all retained history that can be discovered and parsed within the bounded file and line safety limits. The server applies scoring eligibility separately; the connector does not discard Raw Tokens merely because they are old. Usage is deduplicated by account-scoped source ID and reduced locally into stable provider/source-session/UTC-hour/raw-model/raw-mode/surface aggregates before upload; prompt, response, tool, command, filename, and repository content never participates in that aggregation. The canonical model sent for scoring is not part of aggregate identity. Codex, Claude, and Kimi each keep an independent settled-through watermark. Disabled, unavailable, truncated, or event-limited providers retain their prior watermarks. Malformed or oversized records produce explicit partial coverage and a privacy-safe loss count; the connector may advance past that completed scan range so new valid records continue syncing, but it does not claim the historical repair is complete. Later runs normally process only newly settled hours. A changed partial replay of a finalized session-hour reuses its stable event ID rather than uploading a separately scoreable aggregate.

An onboarding provider allowlist controls which local adapters may run. A separate server `supportedProviders` list controls which parsed events may upload, so locally recognized Kimi usage is not sent or scored before the backend supports it.

These files can contain prompts, responses, tool results, commands, and repository paths. The process technically opens an opted-in journal. It prefilters unrelated lines where practical and immediately discards every field outside the allowlist. It never uploads, persists, hashes, or logs prompt/response/tool content, commands, or repository names. Raw provider paths never upload, persist, or enter logs. The connector does HMAC each raw journal path with an installation-only key and persists that keyed alias locally as the cursor-map key; the raw path cannot be recovered from the alias without the local key and a candidate path.

## Data stored locally

- Connector endpoint and provider allowlist.
- Explicit journal-fallback choices.
- Ed25519 private/public device key, the server-issued account deduplication namespace key, and a separate random local alias key in `device-secrets.json`.
- Monotonic request sequence and prior accepted request digest.
- Until pairing completes or is explicitly replaced: the short-lived pairing code, public key, endpoint, device label, connector version, approved fallback choices, fixed exchange request ID, and unpaired private key in the restricted `pending-device-secrets.json`. Ordinary `state.json` stores only nonsecret pending status, request ID, and any permanent error. An existing active `device-secrets.json` is not replaced until the exchange response is validated and its final ACL is verified.
- At most one active content-free signed request body and fixed request ID. Catch-up keeps one active page of at most 5,000 hourly aggregate events in `state.json`; additional content-free pages are private files under `sync-pages/<batch-id>/`. State keeps only their event counts and integrity digests until they become active. Missing, oversized, malformed, or digest-mismatched pages fail closed, and the batch directory is removed after the final page commits.
- No new unresolved-model queue. Usage without complete model and speed evidence enters the same bounded, crash-safe sync outbox immediately as a raw-only event. A one-time v5 stable-ID rescan and the retired bounded queue are retained only long enough to repair older installations; source-model tokens remain local and are removed before upload.
- Independent Codex, Claude, and Kimi aggregate-through watermarks; keyed HMAC file aliases; byte cursors; file-metadata identities; and rolling digests made only from allowlisted usage/model/mode fields to detect journal replacement. Prompt/response/tool content never enters those digests. Claude additionally keeps at most 250,000 content-free sent-event ledger entries so unchanged snapshots are not aggregated again.
- The last committed Codex provider-snapshot generation ID, full snapshot digest, lifetime total, and date-to-token map. These are content-free usage counters; an in-flight generation stays in the existing crash-safe outbox and does not replace committed snapshot state before its marker succeeds.
- Last sync/heartbeat times, content-free adapter health counts, and persistent provider-level partial-coverage counts when unreadable records prevent a complete repair claim.
- A bounded allowlisted operational log.

Secret files and state directories use user-only permissions on POSIX systems. On Windows, pairing first disables inheritance on the connector directory and grants inheritable access only to the resolved current user, so the pending credential is never created under a broadly inherited ACL. It then verifies one explicit current-user full-control rule on `pending-device-secrets.json` before sending the code and on `device-secrets.json` before committing the device. A confirmed install re-verifies the final secret ACL and fails closed before release copying or scheduler creation.

## Data sent

Pairing sends only the short-lived code, raw Ed25519 public key, user-visible device label, and connector version.

Usage events contain only hourly aggregate records made from eligible journal usage:

- deterministic account-scoped HMAC event ID;
- a deterministic occurrence time within the original UTC hour;
- provider and either a canonical model plus standard/fast mode, or the atomic `raw_only`/`unknown`/`unknown` sentinel;
- decimal uncached-input, cached-input, cache-write-input, output, and optional reasoning counters;
- coding surface identifier.

Each aggregate ID is a deterministic account-scoped HMAC over provider, stable source-session scope, UTC hour, raw source-model token, raw mode token, and coding surface. Codex and Claude retain the released v4 logical identity domain and Kimi retains v3. Parser/accounting generation, collector provenance, canonical model mapping, totals, and raw-versus-attributed classification do not participate in that identity. Neither locally deduplicated source IDs nor raw identity inputs are uploaded as separate fields. A changed canonical usage observation is request-digested as a revision under the same event ID, so a correction cannot mint separately scoreable usage. Stable session-hour aggregates are not split: if one crosses the server's automatic single-event volume boundary, it remains whole for anomaly and quarantine handling.

Codex provider-backed checkpoints contain only provider, source, source scope (`codex_subscription_account`), UTC observation period, total tokens, deterministic checkpoint ID, and content-free snapshot lineage metadata. Only changed daily values are sent as `daily_delta` records. A final lifetime `commit` marker carries the generation ID, parent generation ID, canonical digest of the merged daily/lifetime snapshot, and delta count. A signed heartbeat response returns the account's current content-free snapshot head before planning, allowing reinstall and multi-device recovery. The connector persists its submitted generation only after exact checkpoint acknowledgement and active-generation proof; a stale-parent response may instead hydrate the already-committed remote head while retaining all durable event pages. These counters are used for reconciliation and are not scored as model usage.

Heartbeat requests contain only observed time, `healthy`/`degraded`/`paused`, connector version, the prior request digest, and—when Codex is connected—an optional content-free local generation ID plus snapshot digest (or explicit null). On an exact match the server returns only a compact current acknowledgement; on mismatch or reinstall it can return the content-free Codex generation ID, snapshot digest, lifetime total, and date-to-token map already held for the same connected account. An incomplete legacy raw-only backfill is one reason for local `degraded` status; its provider names and counts are not sent in the heartbeat.

No prompt, response, filename, file path, repository, command, email, password, refresh token, browser data, provider credential, or API key is sent.

## Network destinations

Only the configured HTTPS origin for The Artificial Games is accepted. HTTP is allowed solely for explicit localhost development. Redirects and signed query strings are rejected. Response bodies are streamed through a one-megabyte cap. Network failures, timeouts, HTTP 429, and HTTP 5xx responses receive at most three attempts; exponential jitter is used unless a bounded standard `Retry-After` value is present. Other 4xx responses are not automatically retried. Provider journal adapters perform no provider network request. The Codex aggregate adapter starts the locally installed official app-server and never reads auth files itself.
