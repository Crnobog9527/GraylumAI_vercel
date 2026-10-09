# DATA-ERASURE PR-C executor

`/api/cron/account-erasure` runs the existing processor with the existing cron
authentication and service client, daily at 05:00 UTC for staging Hobby. The billing route remains
at 04:00 UTC. Sharing its 60-second invocation would either run conflicting DB
work against the transaction barrier or reduce the existing financial recovery
budget. This separate path reuses Vercel cron; it is not a new scheduler.
Each invocation processes ready subjects until its 45-second work budget is nearly exhausted,
without a fixed 20-subject cap,
plus bounded reconciliation reads within the route's 60-second limit, using fresh
RPC transactions. `transactions_pending`, unknown uploads/history, partial failures,
unresolved financial evidence and remaining rows report pending, never completed.
Only the existing financial recovery path queries providers; this executor never
prepares or dispatches a model call, creates a refund, or cancels a subscription.

Migration 0197 is required before this application code. It reuses `profiles` for
an attachment-history completeness bit and `account_erasure_requests` for a claim,
attempt time, sanitized errors and bounded scan positions. Manifest positions are
row IDs/ordinals; the prefix position retains its last object key and opaque provider continuation until the
scan finishes, then clears it. These service-only request fields are never public. Existing rows/references alone cannot prove lost
attachment history, and the old host latch cannot exclude another server instance;
these are the smallest missing capabilities. No queue, scheduler system, balance,
manifest table or alternative authority is introduced.

New profile insertion after the migration starts tracked history. Raw attachment references cannot be removed
unless their Storage absence was already verified. Ordinary pre-closure expiration
clears bodies on the existing schedule but retains the original attachment mapping;
it does not create an unrecoverable history gap. Appending references remains allowed. Verified subject cleanup preserves the
other uploader's history too; an integration case then erases that uploader. Existing profiles remain unproven; the
migration does not infer completeness from empty tables, creation timestamps,
0196 being present or time elapsed. Unproven history still permits unrelated body
cleanup, but does not permit Storage/Auth completion. Original ticket/reply rows
remain the attachment authority. Exclusive administrator attachments can be
removed after checking their uploader's outstanding intents as well; shared or
unknown references remain pending. Attachment-free system replies need no uploader.
Reply authorship is an erasure subject even on another account's ticket. The
scoped manifest, shared/exclusive classification, upload proof and reference
write guard use that same ownership rule; the parent owner's body/history survives.
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
The request also retains the original Auth intent owner token and an undispatched
flag. Only the matching idle worker can attest it never invoked Auth and reopen
dispatch of that same intent (without changing its start time). A preflight read
failure or lost DB intent response can thus recover; any attempted Auth deletion
keeps dispatch closed. These fields are facts on the existing request, not a new
queue or replacement intent. Crashed/unsettled workers still require observation.
The executor's diagnostic columns do not overwrite financial/Auth diagnostics.
An uncertain idle-claim release reads the original request first; only a still-owned
claim can retry the same CAS release, while an already released claim is not resent.

The temporary daily schedule follows the approved 2026-10-10 staging decision
recorded in [the PR](https://github.com/Crnobog9527/GraylumAI_vercel/pull/748#issuecomment-6085271741).
05:00 UTC avoids the existing 02:00, 03:00, 04:00 and 10:00 schedules. It meets the
Hobby once-daily frequency restriction; actual deployment is not performed here.
Daily operation does **not** establish the 24-hour deletion objective: backlog,
large subjects, retries and manual recovery can span multiple days. Staging's
24-hour acceptance is deferred by that decision, not recorded as passed.

The function still has a 60-second limit. New claims stop with five seconds left
in the 45-second work budget; each subject gets at most ten seconds of work,
with actual-I/O draining bounded to three seconds before that budget ends.
The remaining function time covers original-token finish observation/CAS and
pending-count reads. SQL chooses least-recently-attempted requests; its five-minute
cooldown prevents a failed subject from spinning in the same invocation and has
expired by the next daily run. Persisted manifest/prefix checkpoints survive the
daily gap. Pending work continues next time; unknown in-flight I/O still requires
the protected recovery below. A simulated 60-subject test consumes 40 one-second
subjects in the first invocation and the remaining 20 the next day. This verifies
budget/continuation behavior, not a production throughput guarantee.

**Before launch (REL-1): upgrade Vercel to Pro, change this cron back to every five
minutes (`*/5 * * * *`), verify deployment and actual invocation, and validate
"online content cleared within 24 hours" with backlog/retry cases.** Coordinate
that launch check with the runtime-recovery minute-level cron. No plan upgrade,
remote scheduling configuration or production acceptance was performed here.

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
block a small subject or get deleted by its cleanup. Storage prefix enumeration
also exposes bounded sorted pages before exhausting the whole prefix, so 5,001
objects can make progress. Prefix progress and unresolved state also persist;
125 retained prefix objects cannot starve later exclusive objects or manifest work.
Each invocation reserves half its page budget for the manifest. Production resumes the original opaque listV2 continuation with name ordering, including across deletion;
the provider uses a key boundary, so retained pages are not downloaded again. No cursor is invented or decoded.
Exact-object absence reads remain complete bounded inventories. Shared/unknown manifest entries retain a durable review bit while the scan proceeds
to later exclusive objects. At scan end an unresolved manifest restarts from the
beginning on a later pass; its cursor cannot turn missing absence proof into
completion. Shared objects/references remain for review, while bounded
ticket/reply body scrubbing proceeds independently and rejects body refill. No staging account has been closed and no remote DB was accessed.
No progress capability is issued, read or exposed; the retired query page stays out
of scope. Retained financial rows and the inaccessible original profile ID remain
subject to the existing three-year rule; expiry cleanup is not added here.

## Abandoned-worker recovery (protected operator action)

The cron never takes over an expired claim. After a crash or I/O beyond the route
budget, use `packages/api/scripts/erasure-recovery.mjs` only in an approved recovery
window. First independently verify that the original invocation has stopped and
**all** its original DB/Storage/Auth operations have settled. Inspect invocation
logs and original external identities; elapsed time, a lost response, or an Auth
identity still being present is not settlement proof. If evidence is missing, stop.

Keep the reviewed evidence outside the public repository. The receipt file has
`profileId`, `requestId`, `token` and an `evidence` object with `workerStopped: true`,
`ioSettled: true`, `workerEvidenceHash` and `ioEvidenceHash` (SHA-256 references to
that reviewed evidence), plus `authNeverDispatched` (normally false; true requires
explicit trace proof that no Auth deletion was invoked). These are privileged
operator attestations, not machine-verifiable proof created by writing JSON.
The protected action's approval must cover releasing this original claim.

With the already-authorized target service environment, run:

```sh
node packages/api/scripts/erasure-recovery.mjs --apply-reviewed-recovery /protected/reviewed-receipt.json
```

The command validates the receipt, reads the original request and Auth identity,
and invokes a service-only RPC that rechecks the transaction barrier and original
request/token. It records the evidence hashes before releasing the claim. It never
deletes an Auth user/object itself, changes financial identity, or clears an
unknown Auth dispatch on a timeout. A repeated receipt observes the stored result;
an uncertain response is read back, never blindly retried. It outputs only a
sanitized status. `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` must be supplied by
the approved execution environment; this task did not read them or run the command
against any remote system. Local synthetic tests cover invalid/stale receipts,
an active transaction, successful recovery, duplicate recovery and denied roles.

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
0197 final built SHA-256: `30cf92518feea26f531c7fff06f179c0c40fe6d88132f6a5e1c6d549cec9b3e9`.
The exact final local delta is 39 added catalog entries and four changed
functions `account_erasure_local_cleanup(uuid,boolean)`, `account_erasure_ticket_guard()`,
`account_erasure_auth_begin(uuid,uuid)` and `purge_deleted_records(integer)`; no catalog entries were
removed. The additions include subject-scoped attachment RPCs and two GIN indexes.
Final canonical replay and completion runner each passed 200/200 build steps,
131 historical repeat checks and container cleanup. These are local fingerprints,
not fresh remote snapshots.
