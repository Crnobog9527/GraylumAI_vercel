# Ordinary chat request reliability

This bounded repair starts at admission-protected staging
`cba14c40499d3f770f7a91b14e211b130278f6c6` (#403). Risk: **high** (request
persistence, authorization, and existing billing RPC integration). It does not
change search routing/prices, Skill execution, subscription rules, or governance.

## Behavior

- The browser stores the input and UUID before sending. A database claim binds
  that UUID to its actor, original conversation, text, model selection, and module.
  Concurrent/repeated delivery cannot acquire a second dispatch capability.
- Completed delivery replays the stored answer, message IDs, and billing result.
  Recovery checks current authentication, account, conversation, and module access;
  it does not require a second spending allowance to read an already-paid result.
- A metered response is durably saved before settlement. Settlement recovery uses
  the original atomic billing functions and can be replayed after rollback without
  another provider call. There is no second balance or alternate pricing path.
- Browser disconnect/stop means stop waiting. The original invocation continues
  saving late results when the process remains alive. Uncertain provider output
  retains its reservation and filtered partial content; it cannot automatically
  dispatch, switch models, refund, or generate under a fresh UUID.
- A proven pre-dispatch failure or strict unmetered provider 429 rejection releases
  the original reservation once. Only confirmed failed requests offer a separate,
  explicit new generation. Unconfirmed delivery offers the same UUID again.

## Local proof

Run from the repository root with Docker and the installed workspace dependencies:

```sh
node packages/db/tests/v3/run-chat-reliability.mjs --baseline
node packages/db/tests/v3/run-chat-reliability.mjs
node packages/db/tests/v3/run-chat-reliability.mjs --regression
pnpm --filter web typecheck
pnpm --filter web lint
```

The adapter derives a disposable copy of the existing SQL/Auth/HTTP/browser
runner; it does not edit #402's shared runner/tests. It copies no environment
credentials, uses local GoTrue/PostgREST/PostgreSQL and a counted HTTP provider
fixture, and denies non-loopback model/network calls. The database uses the
repository's own-row billing policies and narrow service column grants (including
the absence of `billing_history.user_id` from service SELECT). It applies 0078
twice. The baseline option substitutes the four immutable original runtime files
in the disposable copy and omits 0078.

Observed before the repair: both sequential and concurrent replay dispatched the
provider **twice**, while each UUID had one pre-deduction and one settlement.
Observed after: each scenario dispatched **once**, reserved once, settled once,
and saved one user/assistant pair and one token-stat record.

The repaired suite has 35 real integration/browser cases covering lost responses,
refresh before the initial response, restored input, manual new-generation retry,
unknown/truncated output, four ambiguous refusal variants, late/aged execution,
stop/completion races, forced atomic settlement rollback with concurrent recovery,
identity mismatch, revoked access, actual balance changes, free chat, document
chat, retention, denied direct RPC/table access (including null capabilities),
and #403's allowed/denied admission paths. Review regression cases also cover
multi-turn history with latest-request recovery, a deterministic two-tab storage
write interleaving, and unsupported native transport rejection before spending.
It reads actual provider counters,
billing rows, messages, token stats, balances, and browser output.

The integrated Skill SQL/Auth/HTTP/browser selection covers multi-turn, homepage
entry, 3/4/6/8 configured steps, refused reply/summary recovery and late initial
reads; unrelated cases are explicitly skipped. The original six-case selection
passed before #402 integration; the expanded results are recorded on the PR.
The focused handler/provider-usage/billing/security suites passed 225 tests.
The broad API suite initially had 1,661 passes and two unrelated failures under
concurrent local load (PII timing and connection availability); the unchanged
two suites passed all 51 tests when run alone. This is not recorded as a full
local-suite pass. Remote required checks and independent exact-candidate review
are recorded separately on the PR.

Each local run prints its evidence directory and source tree digest. It retains
application logs, a browser screenshot, and observed request identities/states,
then removes its own disposable source and containers. Evidence is synthetic
local execution, not a paid-provider or deployed-environment result.

## Dependencies, activation, and limits

0078 is additive. The migration ledger dependency is resolved by integrating
staging `0002307b6892537597fd6c6b840a990eabb53af8`, which contains merged #402
and its 0077. No migration was copied or renumbered. The local adapter reuses
the shared runner's canonical billing-history policy and applies 0078 twice
after 0077. Combined runtime validation and exact-candidate review are required
on this integrated candidate. No remote application of either migration is
claimed by a Git merge.

No remote database, deployment, real provider, production, or configuration
mutation is part of this repair. This branch opts out of automatic Vercel builds.
Future authorized activation must apply the additive migration before enabling
the new runtime. Existing billing signatures remain compatible. Retain the new
request rows/functions on a code rollback; dropping them loses recovery evidence.
Old runtime code does not provide the new at-most-once guarantee.

Process termination or prolonged database/provider loss after dispatch can leave
an unknown request and reserved credits. No provider-side idempotency or lookup
guarantee is assumed. The UI preserves that uncertainty, input, and any durably
saved result rather than inventing a refund or automatically charging again.
Terminal bodies follow conversation retention; unresolved requests defer physical
deletion, and retained usage/billing identities prevent purged UUID reuse.

Browser recovery uses per-account local storage. Clearing it removes automatic
discovery of pending request IDs; server records and saved conversation messages
remain. Product acceptance and any future staging/production database or rollout
operations require their separate authorized workflow.

Browser records use independent request keys, so one tab's late write cannot
replace another request's discovery record. Stored snapshots omit answer bodies;
older completed discovery records can be removed while every failed or unresolved
input is retained. Refresh merges the recovered request with the existing history
query without changing its pagination. Known unsupported generation transports
fail before token-provider access or reservation, rather than becoming an unknown
billable execution.

Pre-merge cloud-review remediation additionally covers exact string-coded
`rate_limit_exceeded` HTTP 429 refusals, including metered/output-bearing and
HTTP 200 counterexamples. Preflight pricing, balance and key failures use the
existing atomic finalizer once, preserving failure metadata without duplicate
usage rows. An authenticated recovery 404 suspends polling while preserving the
input and original request identity for explicit delivery; it does not prove
that an earlier delayed POST can never be accepted.
