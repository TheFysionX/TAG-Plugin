# Threat model and anti-cheat boundary

## Protected assets

- Prompt, response, tool, command, filename, and repository content in local journals.
- Device private key, account dedup namespace key, and local alias key.
- Correct attribution of provider/model/mode/token counters.
- Leaderboard integrity and weekly frozen score cards.

## Controls in this connector

| Threat | Control | What it proves |
| --- | --- | --- |
| Network replay | Unique request ID, timestamp window, monotonic sequence | The same signed request is detectable. |
| Batch deletion/reordering after submission | Previous-request digest chain | A later client cannot silently rewrite the server's accepted chain. |
| Duplicate journal scans | Account-scoped source IDs, lineage-aware Codex endpoints, stable provider-versioned session-hour IDs independent of source set/canonical mapping, preserved cursors, Claude sent ledger, and server idempotency | An unchanged replay is idempotent; a partial or expanded replay cannot mint a separately scoreable ID. |
| Duplicate physical journals | In-memory source-ID set before hourly summing | Copied records with the same provider identity count once. |
| Reinstall with preserved state | Uninstall preserves cursors, the Claude sent ledger, and the server-issued per-account namespace | Later records remain append-only without cross-account linkability. |
| Oversized first history | 89-day scored window, stable hourly aggregation, private digest-manifest pages of at most 5,000 events, disjoint 3/2 request chunks, and bounded catch-up | Guaranteed-quarantine history is skipped and server/query/rate limits are respected without early cursor advancement. |
| Disabled, unavailable, or truncated provider source | Independent provider through-watermarks that advance only after complete discovery and collection | Healthy providers can progress without marking an incomplete provider's history as consumed. |
| Missing or corrupt catch-up page | Private bounded files, path/schema/allowlist/count checks, digest manifest, and final-page cursor commit | Lost or modified paged history fails closed before collection cursors advance. |
| False hourly volume anomaly | The stable aggregation key retains the original UTC hour | Daily usage is not collapsed into one artificial hour. |
| Hidden aggregate volume anomaly | Stable session-hour aggregates are not sharded | An implausibly large aggregate remains visible as one event to server anomaly and quarantine rules. |
| Permanent event-ID conflict | Hashed rejected ID quarantine after validated 2xx; final cursor commit | One conflicting record cannot block all later usage forever. |
| Invalid record in a rejected batch | Permanent 4xx classification, batch bisection, isolated quarantine | One invalid record does not create infinite retries or discard valid siblings. |
| Authorization/chain rejection | Non-retryable pending failure visible in local status | A permanent control-plane failure is not hammered forever or silently discarded. |
| Two local operations overlap | Owner-token lock with periodic lease renewal, live-PID guard, atomic stale takeover, and ownership-checked release | One installation advances or changes state at a time, including during long catch-up. |
| Response loss or crash after server acceptance | Atomically persisted pending request with exact idempotent replay | The client can recover without inventing a new request on an old sequence. |
| Pairing response loss or split runtime commit | Hardened pending-secret journal, fixed request, config-first/state-last commit | A consumed code or one-file commit failure resumes with the same proof-of-possession key and approved configuration. |
| Pair code disclosed in an agent prompt | Conspicuous website and prompt disclosure before the generated install message | The user is told that the coding-agent provider receives and may retain the short-lived credential under its normal terms. |
| Journal replaced at the same path | Metadata identity, complete-line boundary, and full rolling digest over allowlisted usage fields | A changed scored record anywhere in the prior prefix resets parsing without hashing prompt/tool content. |
| Oversized JSONL content | One-MiB per-line buffer cap with discard-through-newline and malformed health count | One huge tool/response line cannot create unbounded parser memory. |
| Catch-up rate pressure | Disjoint 3/2 chunks, 550 ms pacing, 100-request interactive bound, 1,000-request scheduled bound, bounded `Retry-After`, heartbeat interleaving, pending-chain preservation | History drains below the device window; throttled work resumes without chain gaps while liveness continues. |
| Data exfiltration bug | Parser prefilter, outbound allowlist, strict backend schema, safe-log allowlist | Unapproved fields are kept out of normal payload/log paths. |
| Unknown or spoofed model | Canonical registry plus strict source-model token grammar; capped content-free unresolved queue with visible overflow | Unknown usage is not mislabeled or scored, and it does not block later known records. |
| Inflated journal totals | Provider-backed aggregate checkpoints and server anomaly rules | Some inconsistencies can be flagged. |
| Stale/offline connector | Signed heartbeat cadence | Gaps become visible. |
| Cumulative usage mismatch/reset | Codex per-file cumulative validation and `degraded` heartbeat | Duplicate snapshots are ignored and suspicious discontinuity is visible. |
| Privilege escalation | Stable user-only scheduler, no elevation path, Windows pending/final secret ACL fail-closed | Pairing traffic and installation do not proceed with an unhardened Windows secret. |

## What it cannot prove

An open-source connector running under a user's account cannot prove that the user did not modify the executable, forge local journal fixtures, suppress events before first submission, run multiple accounts, or manipulate the machine clock within allowed tolerances. Agent review improves transparency but is not remote attestation.

Deleting local state and then rescanning a session-hour after its journal gained or lost records can change the aggregate totals, but not its stable provider-versioned event ID. The server therefore sees a conflicting body under the existing ID and the connector rejects or quarantines it rather than creating extra scored usage. This prevents a partial-overlap replay from double-scoring; it does not reconstruct lost continuity. Uninstall intentionally preserves state; device revocation and state loss should still be treated as a new trust epoch rather than assumed equivalent to an append-safe reinstall.

Consequently:

- Journal-derived events must remain `connector-reported`, never "provider verified."
- Provider-backed checkpoints should be stored separately and used for reconciliation, not assigned fake model detail.
- Server anomaly rules should check impossible token rates, model/provider mismatches, duplicate source windows, request-chain gaps, heartbeat gaps, checkpoint divergence, and abrupt retroactive volume.
- Weekly score freezes should retain connector version, rate-card version, provenance, continuity state, and anomaly status.
- Public product language should distinguish provider-backed evidence from connector-reported evidence.

This raises the cost of casual cheating and makes contradictions reviewable. It is not a claim of cheat-proof measurement.
