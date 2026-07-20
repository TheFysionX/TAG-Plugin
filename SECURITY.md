# Security

## Request authentication

Pairing generates an Ed25519 keypair locally. Before network I/O, the connector persists the unpaired key and fixed exchange request body/request ID in `pending-device-secrets.json`, separate from any active device. On Windows it first replaces the connector-directory ACL with one inheritable current-user grant, then creates and explicitly verifies the pending file's user-only ACL before the code is sent. If the exchange response is lost after the short-lived code is consumed, the next `pair` resumes the same proof-of-possession request. The validated result writes config first and state last while retaining the pending recovery file, so either runtime-file write can be retried safely. During an intentional device replacement, the active key is not committed until the exchange succeeds and its final ACL is verified. The private key never leaves the machine. Requests sign this exact form:

The already-deployed v1 backend retains the legacy `TOKENBOARD-V1` signing prefix and `x-tokenboard-*` header names solely as wire-protocol compatibility identifiers. They are not current product branding. Changing them requires a coordinated backend migration; changing only the public plugin would break pairing and sync.

```text
TOKENBOARD-V1
METHOD
/exact/path
device-id-or-empty
unix-seconds
request-id
sequence
base64url-sha256-of-exact-body
```

Authenticated responses return a request digest. The connector places it in the next request body and increments its sequence only after an accepted HTTP response. The backend can detect duplicate request IDs, stale timestamps, replayed sequences, gaps, rollback, and divergent digest chains.

Before transmission, the connector atomically stores a content-free pending request with its fixed request ID, sequence, canonical body, and HMAC-only cursor commit. If a response is lost or the process crashes before saving the receipt, the next run replays exactly that request. The backend returns the original idempotent result only when request ID, sequence, route, and body digest all match.

Initial history is persisted as a content-free outbox. Every ingest request contains either at most three events or at most two checkpoints, never both. Chunks are paced 550 ms apart to remain below the normal device request window. The exact active chunk is crash-replayed and final cursors commit only after every chunk receives a valid response. An hourly scheduled run processes at most 1,000 ingest requests, inserts a signed heartbeat after each 50 ingest requests, and sends a final heartbeat even when a persisted backlog remains. Heartbeat and ingest share one monotonic sequence/digest chain, so neither can skip an unresolved pending request. Network failures, timeouts, HTTP 429, and HTTP 5xx responses use at most three attempts with exponential jitter or a bounded standard `Retry-After`. Permanent 4xx payload rejections are never blindly replayed forever: eligible invalid same-type chunks are bisected, an isolated invalid event is quarantined, and authorization/chain failures remain visibly blocked for explicit repair.

Uploaded event IDs are HMAC-SHA-256 derivations under a stable, server-issued per-account namespace and content-independent provider identities. Claude uses its message ID. Codex uses session identity plus normalized timestamp and the occurrence ordinal among eligible token-count records at that timestamp. Kimi prefers a bounded provider record ID when present and otherwise uses session/agent identity plus normalized timestamp occurrence ordinal. Token counts, model, and service mode remain only in the separately signed payload and rolling content digest; changing them does not mint a new event ID. Records without a valid timestamp are withheld from upload. Raw provider identities and the namespace key never upload in usage events. The separate random installation HMAC remains limited to local path aliases and cursors, so reinstalling or journal reformatting does not inflate history with new event IDs and identical records are not linkable across The Artificial Games accounts.

Codex and Kimi byte cursors persist a metadata journal identity, a complete-line boundary, and a rolling prefix digest over only allowlisted usage/model/mode fields. Before resuming, the parser rescans the bounded prior prefix and compares that safe digest. A changed allowlisted record anywhere before the cursor, an invalid boundary, or different file identity resets parsing to byte zero. Prompt, response, command, and tool content is neither stored nor hashed. Individual journal lines are capped at one MiB; an oversized line is discarded through its newline, counted malformed, and does not grow memory without bound. Unknown models are not allowed to block later known records: a strict model-token grammar gates a local queue capped at 2,000 normalized, content-free records. Registry updates drain resolvable entries; status exposes queue size and cumulative overflow, and any queued/overflowed state degrades heartbeat health.

All state-changing commands use one local lock with a random owner token. Its open file handle renews the filesystem lease every quarter of the 15-minute stale window. A stale contender atomically renames and revalidates the observed lease, refuses takeover while the recorded local PID is alive, and creates the replacement with exclusive-create semantics. Release checks both owner token and file identity, so a delayed old owner cannot delete a replacement lock.

## Supply chain

- Install the GitHub release asset whose tag resolves to the expected full pinned commit, never a moving branch.
- Compare the archive to the out-of-band expected SHA-256, then to its `SHA256SUMS` entry, and verify the GitHub artifact attestation.
- The package has no runtime or development dependencies. It includes the synthetic test suite and synthetic JSONL fixtures so `npm test` runs against the exact attested release artifact; no real user journal is packaged.
- `private: true` prevents accidental npm publication; official releases should be downloadable GitHub archives.
- Every third-party GitHub Action is pinned to a verified full commit SHA with its release version documented in a comment.
- Before packing, the release workflow rejects `-local`, requires the tag to equal `v` plus `package.json.version`, and requires package, runtime constant, and install-manifest versions to match. It then tests the source, creates a tarball, extracts and tests that exact package, publishes a checksum, and produces build provenance. It does not claim reproducible/deterministic archives until clean-build digest equality is separately proven.
- A confirmed install copies the verified release into a stable current-user version directory; the scheduler targets that copy and carries an explicit connector-home argument.
- Never execute a remote script through a shell pipe.

## Local privilege

TAG Plugin needs only current-user read access to explicitly approved provider usage surfaces, write access to its own state directory, and outbound HTTPS to the configured origin for The Artificial Games. It does not need root/administrator rights, accessibility permissions, browser access, full-disk access, user source-repository access, or provider credentials. POSIX private files use mode `0600`; Windows pairing restricts the plugin directory before credential creation, verifies current-user-only ACLs on both pending and final secret files, and confirmed install re-verifies the final ACL before scheduler creation.

## Reporting a vulnerability

Use this repository's private vulnerability-reporting form under **Security → Advisories**. Repository maintainers must enable private vulnerability reporting before the first public release. Do not include real prompts, credentials, journal files, or private keys in a report; replace them with minimal synthetic reproductions.
