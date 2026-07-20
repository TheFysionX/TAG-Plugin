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
| Duplicate journal scans | Account-scoped provider-identity HMAC event IDs and server idempotency | Re-reading one source record does not create extra usage. |
| Reinstall and full-history rescan | Server-issued per-account event-ID namespace independent of the installation alias key | The same provider record keeps the same uploaded ID across clean installs without being cross-account linkable. |
| Oversized first history | Content-free disjoint chunks capped at 3 events or 2 checkpoints, paced 550 ms apart; 1,000-ingest scheduled-run bound; heartbeat every 50 ingests plus final heartbeat | Server/query/rate limits are respected without early cursor advancement or starving liveness. |
| Permanent event-ID conflict | Hashed rejected ID quarantine after validated 2xx; final cursor commit | One conflicting record cannot block all later usage forever. |
| Invalid record in a rejected batch | Permanent 4xx classification, batch bisection, isolated quarantine | One invalid record does not create infinite retries or discard valid siblings. |
| Authorization/chain rejection | Non-retryable pending failure visible in local status | A permanent control-plane failure is not hammered forever or silently discarded. |
| Two local operations overlap | Owner-token lock with periodic lease renewal, live-PID guard, atomic stale takeover, and ownership-checked release | One installation advances or changes state at a time, including during long catch-up. |
| Response loss or crash after server acceptance | Atomically persisted pending request with exact idempotent replay | The client can recover without inventing a new request on an old sequence. |
| Pairing response loss or split runtime commit | Hardened pending-secret journal, fixed request, config-first/state-last commit | A consumed code or one-file commit failure resumes with the same proof-of-possession key and approved configuration. |
| Pair code disclosed in an agent prompt | Conspicuous website and prompt disclosure before the generated install message | The user is told that the coding-agent provider receives and may retain the short-lived credential under its normal terms. |
| Journal replaced at the same path | Metadata identity, complete-line boundary, and full rolling digest over allowlisted usage fields | A changed scored record anywhere in the prior prefix resets parsing without hashing prompt/tool content. |
| Oversized JSONL content | One-MiB per-line buffer cap with discard-through-newline and malformed health count | One huge tool/response line cannot create unbounded parser memory. |
| Catch-up rate pressure | Disjoint 3/2 chunks, 550 ms pacing, bounded `Retry-After`, bounded scheduled work, heartbeat interleaving, pending-chain preservation | History drains below the device window; throttled work resumes without chain gaps while liveness continues. |
| Data exfiltration bug | Parser prefilter, outbound allowlist, strict backend schema, safe-log allowlist | Unapproved fields are kept out of normal payload/log paths. |
| Unknown or spoofed model | Canonical registry plus strict source-model token grammar; capped content-free unresolved queue with visible overflow | Unknown usage is not mislabeled or scored, and it does not block later known records. |
| Inflated journal totals | Provider-backed aggregate checkpoints and server anomaly rules | Some inconsistencies can be flagged. |
| Stale/offline connector | Signed heartbeat cadence | Gaps become visible. |
| Cumulative usage mismatch/reset | Codex per-file cumulative validation and `degraded` heartbeat | Duplicate snapshots are ignored and suspicious discontinuity is visible. |
| Privilege escalation | Stable user-only scheduler, no elevation path, Windows pending/final secret ACL fail-closed | Pairing traffic and installation do not proceed with an unhardened Windows secret. |

## What it cannot prove

An open-source connector running under a user's account cannot prove that the user did not modify the executable, forge local journal fixtures, suppress events before first submission, run multiple accounts, or manipulate the machine clock within allowed tolerances. Agent review improves transparency but is not remote attestation.

Consequently:

- Journal-derived events must remain `connector-reported`, never "provider verified."
- Provider-backed checkpoints should be stored separately and used for reconciliation, not assigned fake model detail.
- Server anomaly rules should check impossible token rates, model/provider mismatches, duplicate source windows, request-chain gaps, heartbeat gaps, checkpoint divergence, and abrupt retroactive volume.
- Weekly score freezes should retain connector version, rate-card version, provenance, continuity state, and anomaly status.
- Public product language should distinguish provider-backed evidence from connector-reported evidence.

This raises the cost of casual cheating and makes contradictions reviewable. It is not a claim of cheat-proof measurement.
