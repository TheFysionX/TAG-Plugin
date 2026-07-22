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
| Duplicate journal scans | Account-scoped source IDs, lineage-aware Codex endpoints, stable provider-versioned session-hour logical IDs independent of source set, parser/accounting generation, collector provenance, canonical mapping, and raw/attributed classification; preserved cursors; Claude sent ledger; server revision semantics | An unchanged replay is idempotent; a corrected replay stays under the same logical ID and cannot mint separately scoreable usage. |
| Duplicate physical journals | In-memory source-ID set before hourly summing | Copied records with the same provider identity count once. |
| Reinstall with preserved state | Uninstall preserves cursors, the Claude sent ledger, and the server-issued per-account namespace | Later records remain append-only without cross-account linkability. |
| Oversized first history | Complete retained-history scan, stable hourly aggregation, private digest-manifest pages of at most 5,000 events, disjoint 3/2 request chunks, and bounded per-run catch-up | Raw history is not silently truncated to a scoring window; server/query/rate limits are respected without early cursor advancement. |
| Disabled, unavailable, or truncated provider source | Independent provider through-watermarks that advance only after complete discovery and collection | Healthy providers can progress without marking an incomplete provider's history as consumed. |
| Missing or corrupt catch-up page | Private bounded files, path/schema/allowlist/count checks, digest manifest, and final-page cursor commit | Lost or modified paged history fails closed before collection cursors advance. |
| False hourly volume anomaly | The stable aggregation key retains the original UTC hour | Daily usage is not collapsed into one artificial hour. |
| Hidden aggregate volume anomaly | Stable session-hour aggregates are not sharded | An implausibly large aggregate remains visible as one event to server anomaly and quarantine rules. |
| Missing or ambiguous event acknowledgement | Exact per-submitted-ID `submittedRevisionActive` or explicit canonical-observation duplicate proof; final cursor commit | Aggregate response counts, status labels, missing rows, and duplicate rows cannot silently advance source cursors. |
| Missing or ambiguous checkpoint acknowledgement | Exact per-checkpoint canonical-digest proof; additional active-generation proof for commit markers | A 2xx, stored-but-stale marker, missing delta, or duplicate response row cannot commit local snapshot state. |
| Invalid record in a rejected batch | Permanent 4xx classification and bounded batch bisection; isolated item remains blocked | Valid siblings can be identified without discarding the rejected item's source observation. |
| Authorization/chain rejection | Non-retryable pending failure visible in local status | A permanent control-plane failure is not hammered forever or silently discarded. |
| Two local operations overlap | Owner-token lock with periodic lease renewal, live-PID guard, atomic stale takeover, and ownership-checked release | One installation advances or changes state at a time, including during long catch-up. |
| Atomic replacement fails or a crash strands a large JSON temp | Bounded retry of one atomic rename primitive with no destination unlink fallback; ordinary failure cleanup plus exact-name, regular-file, dead-PID, age-gated reclamation while holding the canonical overlap lock and only when an unchanged committed counterpart exists; bounded non-recursive directories only | The prior committed JSON and any sole recovery temp survive failure, while transient Windows contention can recover, redundant old temps cannot accumulate indefinitely, and fresh, live, malformed, unrelated, or out-of-home files remain untouched. |
| Response loss or crash after server acceptance | Atomically persisted pending request with exact idempotent replay | The client can recover without inventing a new request on an old sequence. |
| Pairing response loss or split runtime commit | Hardened pending-secret journal, fixed request, config-first/state-last commit | A consumed code or one-file commit failure resumes with the same proof-of-possession key and approved configuration. |
| Pair code disclosed in an agent prompt | Conspicuous website and prompt disclosure before the generated install message | The user is told that the coding-agent provider receives and may retain the short-lived credential under its normal terms. |
| Journal replaced at the same path | Metadata identity, complete-line boundary, and full rolling digest over allowlisted usage fields | A changed scored record anywhere in the prior prefix resets parsing without hashing prompt/tool content. |
| Oversized or malformed JSONL content | One-MiB per-line buffer cap, discard-through-newline, persistent partial-coverage state, privacy-safe loss count, and independent forward watermark | One huge line cannot create unbounded parser memory or be mistaken for complete coverage, while later valid usage continues syncing. |
| Catch-up rate pressure | Disjoint 3/2 chunks, 550 ms pacing, 100-request interactive bound, 1,000-request scheduled bound, bounded `Retry-After`, heartbeat interleaving, pending-chain preservation | History drains below the device window; throttled work resumes without chain gaps while liveness continues. |
| Data exfiltration bug | Parser prefilter, outbound allowlist, strict backend schema, safe-log allowlist | Unapproved fields are kept out of normal payload/log paths. |
| Unknown model or speed | Atomic `raw_only`/`unknown`/`unknown` wire union, exact token components, the same logical event ID used by later attributed classification, no uploaded source-model token, exact event acknowledgement, and cursor commit only after `rawPreserved: true` | Unknown usage remains visible as Raw Tokens, can never generate Kleos, is not lost to queue overflow, and score quarantine for age or volume does not discard Raw. |
| Torn or reordered provider snapshot | Parent-linked Codex generations, changed-date deltas, final lifetime commit marker, durable pending outbox, and local generation state committed only after marker success | Partial daily updates cannot become the connector's committed provider snapshot; crash replay uses the same generation. |
| Reinstall or concurrent-device snapshot race | Signed pre-plan active-head hydration; explicit stale-parent response; checkpoint-only retirement while durable event pages continue | A new device does not blind-reset a modern lineage, sibling generations do not overwrite one another, and collected event usage survives the rebase. |
| Inflated journal totals | Provider-backed aggregate checkpoints and server anomaly rules | Some inconsistencies can be flagged. |
| Stale/offline connector | Signed heartbeat cadence | Gaps become visible. |
| Malicious or malformed update offer/archive | Exact official GitHub repository/tag/commit/asset/SHA-256 verification, bounded GitHub redirects, safe archive parser, package contract, immutable version directory, and atomic launcher pointer | A server response cannot supply arbitrary executable content; invalid updates leave the active release and committed heartbeat intact. |
| Update/install overlap | Separate owner-token update lock and immutable version targets | One updater changes the pointer at a time; an existing version can be reused only with the exact stored receipt. |
| Cumulative usage mismatch/reset | Codex per-file cumulative validation, persisted logical-session reset epoch, reset high-watermark, and `degraded` heartbeat | Duplicate snapshots are ignored, valid post-reset usage gets a distinct stable identity, and suspicious discontinuity remains visible. |
| False quota-reset exception | Persisted provider/surface/window boundary plus a signed reset observation only after that boundary advances | A percentage decrease alone cannot waive volume checks; a real observed window transition can be reviewed separately from journal accounting. |
| Provider-plan inflation | Capability-scoped plan observations: Codex app-server; current first-party Claude auth plus organization-bound provider process/account-bootstrap `rate_limit_tier`; Antigravity's version-pinned same-user loopback account-status RPC with a pinned local TLS certificate and bounded native tier evidence; or explicit DeepSeek API evidence | Antigravity SQLite usage, legacy `planInfo`, a stale cache from another account, hosted model name, conversation string, journal record, or local Grok summary cannot fabricate a retail entitlement. Antigravity Starter maps to Free; an unregistered paid tier remains unverified while its bounded normalized provider value is retained for later registration. |
| Antigravity status-line disruption | Separate explicit `antigravityStatuslineConsent`, saved prior command, bounded sanitizer, forwarding wrapper, ownership-aware restore | Desktop authorization alone cannot change `statusLine`; TAG changes it only after separate CLI-wrapper consent and restores it unless the user has since changed it. |
| Antigravity desktop schema drift or content exposure | Version-pinned 2.3.1 schema check, read-only query limited to `steps.idx`, `steps.status`, and `steps.metadata`, completed steps only, fail-closed parser | Unknown schemas produce no desktop events; prompt, transcript, payload, and render columns are never queried. Unknown model/mode usage is preserved raw-only. |
| Privilege escalation | Stable user-only scheduler, no elevation path, Windows pending/final secret ACL fail-closed | Pairing traffic and installation do not proceed with an unhardened Windows secret. |

## What it cannot prove

An open-source connector running under a user's account cannot prove that the user did not modify the executable, forge local journal fixtures, suppress events before first submission, run multiple accounts, or manipulate the machine clock within allowed tolerances. Agent review improves transparency but is not remote attestation.

Deleting local state and then rescanning a session-hour after its journal gained or lost records can change the aggregate totals, but not its stable provider-versioned logical event ID. The server therefore sees a new payload revision under the existing ID rather than extra logical usage. The connector advances only after the backend explicitly confirms that submitted revision is active (or its exact observation is canonical elsewhere). This prevents a partial-overlap replay from double-scoring; it does not reconstruct lost continuity. Uninstall intentionally preserves state; device revocation and state loss should still be treated as a new trust epoch rather than assumed equivalent to an append-safe reinstall.

Consequently:

- Journal-derived events must remain `connector-reported`, never "provider verified."
- Provider-backed checkpoints should be stored separately and used for reconciliation, not assigned fake model detail.
- Server anomaly rules should check impossible token rates, model/provider mismatches, duplicate source windows, request-chain gaps, heartbeat gaps, checkpoint divergence, and abrupt retroactive volume.
- Weekly score freezes should retain connector version, rate-card version, provenance, continuity state, and anomaly status.
- Public product language should distinguish provider-backed evidence from connector-reported evidence.

This raises the cost of casual cheating and makes contradictions reviewable. It is not a claim of cheat-proof measurement.
