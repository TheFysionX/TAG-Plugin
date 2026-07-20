# Privacy contract

## Coding-agent prompt boundary

The install prompt is handled by Codex, Claude Code, or the coding-agent provider before TAG Plugin runs. Anything placed in that prompt may be transmitted to and retained by that provider under its normal product terms. A true one-message install includes the short-lived The Artificial Games pairing code, so that code is exposed to the chosen coding-agent provider. The safer recommended flow keeps the code out of model context and has the user enter it directly in a local terminal after review. This disclosure is separate from the plugin's outbound-data contract below.

## Data read locally

The preferred source is content-free, provider-backed usage data. Today that is available for Codex through the official `codex app-server` `account/usage/read` RPC. It returns lifetime/daily aggregates but no model or fast-mode breakdown. The connector does not read Codex auth files; the official subprocess may use its existing signed-in session and controls any provider refresh it performs.

Model-level fallbacks are disabled until the user explicitly opts in:

- Codex rollout journals: only `turn_context` model/service tier and `event_msg` `token_count.info.last_token_usage` records.
- Claude Code project journals: only terminal assistant rows with a non-empty `message.stop_reason`, then message ID, timestamp, model, speed/service tier, and `message.usage` counters. Partial streaming rows are withheld; terminal duplicates collapse to the final/maximum usage snapshot. This is a version-observed fallback, not a provider stability guarantee.
- Kimi Code v0.28 wire journals: only `usage.record` model, time, usage counters, and usage scope.

An onboarding provider allowlist controls which local adapters may run. A separate server `supportedProviders` list controls which parsed events may upload, so locally recognized Kimi usage is not sent or scored before the backend supports it.

These files can contain prompts, responses, tool results, commands, and repository paths. The process technically opens an opted-in journal. It prefilters unrelated lines where practical and immediately discards every field outside the allowlist. It never uploads, persists, hashes, or logs prompt/response/tool content, commands, or repository names. Raw provider paths never upload, persist, or enter logs. The connector does HMAC each raw journal path with an installation-only key and persists that keyed alias locally as the cursor-map key; the raw path cannot be recovered from the alias without the local key and a candidate path.

## Data stored locally

- Connector endpoint and provider allowlist.
- Explicit journal-fallback choices.
- Ed25519 private/public device key, the server-issued account deduplication namespace key, and a separate random local alias key in `device-secrets.json`.
- Monotonic request sequence and prior accepted request digest.
- Until pairing completes or is explicitly replaced: the short-lived pairing code, public key, endpoint, device label, connector version, approved fallback choices, fixed exchange request ID, and unpaired private key in the restricted `pending-device-secrets.json`. Ordinary `state.json` stores only nonsecret pending status, request ID, and any permanent error. An existing active `device-secrets.json` is not replaced until the exchange response is validated and its final ACL is verified.
- At most one active content-free signed request body and fixed request ID, plus a bounded chunk outbox, for crash-safe idempotent replay.
- At most 2,000 unresolved-model records containing only event ID, occurrence time, provider, strict source-model token, standard/fast mode, decimal usage counters, and coding surface. The state also keeps cumulative overflow count/time; no prompt, message, tool, command, path, or repository field is eligible for this queue.
- Keyed HMAC file aliases, byte cursors, file-metadata identities, and rolling digests made only from allowlisted usage/model/mode fields to detect journal replacement; prompt/response/tool content never enters those digests.
- Last sync/heartbeat times and content-free adapter health counts.
- A bounded allowlisted operational log.

Secret files and state directories use user-only permissions on POSIX systems. On Windows, pairing first disables inheritance on the connector directory and grants inheritable access only to the resolved current user, so the pending credential is never created under a broadly inherited ACL. It then verifies one explicit current-user full-control rule on `pending-device-secrets.json` before sending the code and on `device-secrets.json` before committing the device. A confirmed install re-verifies the final secret ACL and fails closed before release copying or scheduler creation.

## Data sent

Pairing sends only the short-lived code, raw Ed25519 public key, user-visible device label, and connector version.

Usage events contain only:

- deterministic account-scoped HMAC event ID;
- occurrence time;
- provider and canonical model ID;
- standard/fast service mode;
- decimal input, cached-input, output, and optional reasoning counters;
- coding surface identifier.

Codex provider-backed daily checkpoints contain only provider, source, UTC period, total tokens, and deterministic checkpoint ID. They are used for reconciliation and are not scored as model usage.

Heartbeats contain only observed time, `healthy`/`degraded`/`paused`, connector version, and the prior request digest. A nonempty/overflowed unresolved-model queue is one reason for local `degraded` status; queue contents and counts are not sent in the heartbeat.

No prompt, response, filename, file path, repository, command, email, password, refresh token, browser data, provider credential, or API key is sent.

## Network destinations

Only the configured HTTPS origin for The Artificial Games is accepted. HTTP is allowed solely for explicit localhost development. Redirects and signed query strings are rejected. Response bodies are streamed through a one-megabyte cap. Network failures, timeouts, HTTP 429, and HTTP 5xx responses receive at most three attempts; exponential jitter is used unless a bounded standard `Retry-After` value is present. Other 4xx responses are not automatically retried. Provider journal adapters perform no provider network request. The Codex aggregate adapter starts the locally installed official app-server and never reads auth files itself.
