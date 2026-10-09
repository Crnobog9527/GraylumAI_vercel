# DATA-ERASURE PR-C executor

`/api/cron/account-erasure` runs the existing processor with the existing cron
authentication and service client, every five minutes. The billing route remains
at 04:00 UTC. Sharing its 60-second invocation would either run conflicting DB
work against the transaction barrier or reduce the existing financial recovery
budget. This separate path reuses Vercel cron; it is not a new scheduler.
Each invocation processes at most 20 subjects within 45 seconds, using fresh RPC
transactions. `transactions_pending`, unknown uploads/history, partial failures,
unresolved financial evidence and remaining rows report pending, never completed.
Only the existing financial recovery path queries providers; this executor never
prepares or dispatches a model call, creates a refund, or cancels a subscription.

Migration 0197 is required before this application code. It reuses `profiles` for
an attachment-history completeness bit and `account_erasure_requests` for a claim,
attempt time, sanitized errors and a verified-page checkpoint (row ID/ordinal only). Existing rows/references alone cannot prove lost
attachment history, and the old host latch cannot exclude another server instance;
these are the smallest missing capabilities. No queue, scheduler system, balance,
manifest table or alternative authority is introduced.

New profile insertion after the migration starts tracked history. Any subsequent
removal/change of raw attachment references invalidates that proof unless their
Storage absence was already verified. Verified subject cleanup preserves the
other uploader's history too; an integration case then erases that uploader. Existing profiles remain unproven; the
migration does not infer completeness from empty tables, creation timestamps,
0196 being present or time elapsed. Unproven history still permits unrelated body
cleanup, but does not permit Storage/Auth completion. Original ticket/reply rows
remain the attachment authority. Exclusive administrator attachments can be
removed after checking their uploader's outstanding intents as well; shared or
unknown references remain pending. Attachment-free system replies need no uploader.
The deployed upload path must be the existing intent-based implementation from
0190/#741; old outstanding external uploads cannot be certified by this migration.

The durable claim has **no expiry or automatic takeover**. It prevents a second
worker from deleting concurrently while the first may still have external I/O.
When actual I/O has settled, only the original subject/request/token can release
it. After a request timeout the invocation waits within its remaining budget for
actual I/O to settle before releasing the original claim. A crash or unresolved underlying I/O leaves the claim with its original
identity for manual observation/recovery. A lost claim response first reads the
existing request by its original token; a confirmed committed claim resumes under
that token. An absent/failed observation remains unknown and never starts another
claim or invents evidence that an in-flight transaction stopped. Do not clear it on a timer. Read the
original Auth/object states and prove the old worker cannot continue before any
approved release. Unknown Auth deletion retains the existing once-only intent;
subsequent passes only read the original identity and do not send another delete.
The executor's diagnostic columns do not overwrite financial/Auth diagnostics.

A five-minute cadence reserves retry opportunities before the 24-hour objective;
20 subjects/45 seconds bounds each invocation (at most 5,760 attempts/day).
The known staging Hobby plan cannot deploy this cadence. **Deployment is blocked
until the separately approved environment supports it**; do not silently replace
it with a daily schedule or claim the time objective passed. No plan upgrade or
remote scheduling/configuration was performed. The existing production plan calls
for Pro, but actual availability still needs deployment verification. Backlog,
large subjects, unresolved financial/manual cases and legacy upload/history proof
still require operational acceptance; the product deadline is unchanged.

The former full-table manifest read is retained only for injected legacy tests.
The executor now uses service-only subject keyset pages and candidate-path
classification against indexed current references. Existing SDK queries cannot
express this union and cross-subject proof as one bounded response; two narrow
read-only erasure RPCs plus an original-claim checkpoint are the smallest missing
capability, with tickets/replies
remaining authoritative. Verified manifest pages persist their row/ordinal cursor,
so more than 200 references make progress across invocations without retaining
filenames in progress columns. A 251-attachment fixture proves this continuation. Production checkpoints each
verified object and allows an eight-second Storage pass while each request remains
bounded to two seconds; cumulative normal network latency therefore makes progress
instead of repeatedly losing a 50-object page. The processor enforces the same
separate pass budget and its overall deadline.
A 5,001-row unrelated ticket and reply fixture cannot
block a small subject or get deleted by its cleanup. No staging account has been closed and no remote DB was accessed.
No progress capability is issued, read or exposed; the retired query page stays out
of scope. Retained financial rows and the inaccessible original profile ID remain
subject to the existing three-year rule; expiry cleanup is not added here.

## Local validation and migration recovery

```sh
node packages/db/tests/erasure-completion/run-local.mjs --local-only
node packages/db/tests/run-db-baseline-replay.mjs --local-only --write-built
```

The first command builds the full schema in disposable local PG17 and composes the
actual executor/host/processor with real service-role SQL and the pinned SDK over
synthetic HTTP only. It covers completion, duplicate execution, a held transaction
and later retry, slow I/O draining, multi-pass attachment completion, a lost Storage response, unknown history with independent cleanup,
Auth uncertainty, concurrent claims, incorrect tokens, denied anon/authenticated
roles, retained money, and snapshots before messages. `--development` skips the
historical repeat checks and is never final evidence.

Before application, capture the target read-only structure with the repository's
`fingerprint.sql` and compare it to the **0196** build. After application compare
it to this PR's committed **0197** `built-fingerprint.json`. The build validates
0197 twice in its historical position. This task does not capture or apply remote
state; that belongs to the separately approved migration window. Do not modify the
parallel staging snapshot refresh or mark 0197 as remotely present.

Recovery is forward-only once history/claim/deletion facts exist: disable the
application caller, retain all claim/proof/financial facts, inspect external
outcomes using the original identities, then apply a reviewed forward correction.
Reverting application code stops future invocations; it does not restore deleted
Auth identities, objects or body data. Do not drop proof columns, reset unknown
history to true, expire a live claim, or restore a purge that loses references.

0196 built SHA-256: `06b95b0bb78bc9345e9d531519fe43ab9516c5db78deab1f66cfced48aa5bce8`.
0197 final built SHA-256: `b9459fdfef450cb49b138c02cd30d2d2a6291d31b84f5f62a2adfe9960df4247`.
The exact final local delta is 30 added catalog entries and one changed
function `account_erasure_local_cleanup(uuid,boolean)`; no catalog entries were
removed. The additions include subject-scoped attachment RPCs and two GIN indexes.
Final canonical replay and completion runner each passed 200/200 build steps,
131 historical repeat checks and container cleanup. These are local fingerprints,
not fresh remote snapshots.
