# DATA-ERASURE B1b local verification and handoff

0150 extends 0149's one-way erasure channel to Runtime and legacy conversations. Only a closed
account recorded in `account_erasure_requests` can call the service-only
`account_erasure_scrub_runtime(uuid)`. The implementation writer never connects to a remote DB.
The PR remains draft until the controller reviews the complete candidate; only afterwards may it
be marked ready and the Codex bot requested. The controller handles merge/application after Owner approval.

## Source evidence and safety boundary

The controller supplied staging originals and server MD5s in
[PR #537](https://github.com/Crnobog9527/GraylumAI_vercel/pull/537#issuecomment-5905941158).
Both matched the actual migration-before replay database after receipt:

| Existing function | Staging and local server MD5 | Minimal change |
| --- | --- | --- |
| `artifact_chat_message_guard()` | `b562bbc4c69d1be9f73e22511aadb1fa` | Only a validator-approved message-erasure UPDATE returns early |
| `erasure_update_allowed(jsonb,jsonb,text[])` | `c020123940c8b3772b008f8cde8f38c6` | Explicit singleton `marker-only` rule; NULL/empty/mixed lists still refuse |
| `account_erasure_scrub_content(uuid)` | `3029c14ab84580323acba88565786281` | Early transaction barrier, original body otherwise unchanged |

0150 rejects source drift before rewriting any of these functions; exact new definitions are also accepted
for idempotent reapplication. CREATE OR REPLACE retains owners/ACLs. The rollback contains all three
staging originals and refuses before any mutation if any B1b table has an erased row.
Before rollback, stop all scrub callers and let their in-flight transactions finish. Its erased-row
check takes no table lock, so it is not safe to run concurrently with scrubs. Keep callers stopped
through rollback completion; the script cannot restore already erased content.

| Table | Content cleared | Preserved identity / financial boundary |
| --- | --- | --- |
| runtime_sessions | scope, start_payload | actor, session/start request ID, revision, active execution, time |
| runtime_executions | payload, result, primary_result, match_result | actor/session/request/run, state, history revisions, diagnostic code |
| runtime_history_dependencies | marker only; no content columns | both execution identity keys |
| runtime_session_batches | items | session/execution, batch and revision numbers |
| runtime_session_history | item | session/execution, revision, internal_control |
| runtime_tool_calls | arguments, result | execution/call ID, registered tool name |
| runtime_scope_material | request, content, content_hash | session/revision/request, revoked |
| conversations | title, summary, summary_metadata | IDs, summary counters/time, skill/agent mode, is_deleted/deleted_at |
| messages | content | conversation/message IDs, role, times, soft-delete facts |
| conversation_context_snapshots | content, metadata | source message IDs, type, count, times |
| ordinary_chat_requests | input, response_params, partial_content, failure_reason, writer_token; nonfinancial JSON keys | IDs, state/times/token; only named financial/transaction/message keys remain in reservation/billing_result |

Following the controller's [P1/P2 decision](https://github.com/Crnobog9527/GraylumAI_vercel/pull/537#issuecomment-5908426698),
0150 revokes service_role EXECUTE on `ordinary_chat_claim(uuid,uuid,jsonb,uuid)`; rollback restores
its original grant. Its function body and `ordinary_chat_transition` are unchanged. The legacy
HTTP entry is already disabled; this closes new service-role admission at the database boundary.
REVOKE does not cancel calls already executing: the controller must keep the legacy entry disabled.
Both scrubs now require the transaction barrier below to drain earlier writers. Existing requests retain
transition access and follow the in-flight eligibility rules below.
Terminal ordinary requests lose `writer_token` during erasure. Live requests still require and
preserve it; erased rows cannot refill it. It is a dispatch credential, not retained identity.

Runtime eligibility requires completed/cancelled executions and either no billing run or a closed,
settled/refunded run. Session/material content waits for every execution; child rows wait for their
execution; dependency edges wait for both ends. Ordinary requests require succeeded/failed; shared
conversation/message/snapshot content waits for ordinary and artifact requests. On barrier success, all eleven tables
return processed and skipped counts. Busy parent locks are skipped for PR-C retry; session locks
precede execution locks. No profile/BILL2 run/artifact project lock is added to the Runtime scrub. The B1a scrub retains its existing temporary scope table.

Conversations retain client UPDATE permission: a definer trigger checks closure without widening
client table grants. Every INSERT with non-NULL `erased_at` is rejected before any closure lookup,
so its error cannot reveal another account's closure status before RLS. Normal owner INSERTs pass.
`a_erased_row_guard` executes before the existing skill-message guard and freezes
all erased rows, including late complete/checkpoint/tool results whose old values are NULL.
No physical DELETE is added; tests verify existing busy-conversation DELETE refusals by row existence.
`bill2_runs` (including `session_ref`) stays unchanged. B2 supplies restricted settlement; C retries
and removes shells after B2. D must harden read/replay paths before enabling single-item erasure.
An erased snapshot rejects FK-driven UPDATEs too: deleting an individual source message invokes
ON DELETE SET NULL on `source_message_start_id/end_id` and fails. C/D must remove snapshots before
individual messages, or delete the whole conversation. This corrects the broad "DELETE stays
possible" comment in immutable migration 0149; 0150 carries the clarification without changing 0149.
B2/C must also move interrupted/cost_pending executions to completed/cancelled after run settlement;
a terminal run alone does not make the execution or its session eligible for scrubbing.

## Transaction barrier and no-active writers

The controller approved the final contract in
[the Runtime P1 decision](https://github.com/Crnobog9527/GraylumAI_vercel/pull/537#issuecomment-5911038432),
with the [NULL-state worker correction](https://github.com/Crnobog9527/GraylumAI_vercel/pull/537#issuecomment-5912107334).
Both scrub functions first verify the erasure request, then call the internal-only
`account_erasure_barrier()`. There is no new table, queue, scheduler or admission lock.
The only missing capability was draining transactions which had already passed an active check;
existing row guards cannot see their uncommitted inserts. The existing erasure request remains
the closure authority. `runtime_start`, other admission helpers and financial functions are unchanged.

The barrier only allows READ COMMITTED (`ACCOUNT_ERASURE_ISOLATION_DENIED` otherwise). It records
`clock_timestamp()` after closure verification, checks its definer's `pg_read_all_stats` privilege
and activity tracking, clears the statistics snapshot, checks other backends in the current database
or with NULL datid, then checks prepared transactions in the current database. The internal six-argument IMMUTABLE SQL predicate
`account_erasure_activity_safe(backend_type,state,xact_start,backend_xid,backend_xmin,cutoff)`
has no statistics or clock reads. Client rules remain unchanged: a visible `idle` backend with NULL
`xact_start` passes. A named non-client worker with NULL state is only a candidate when
`xact_start`, `backend_xid` and `backend_xmin` are all NULL. Candidate PIDs come from that same
database-filtered scan. The barrier separately reads `pg_locks`; any granted `virtualxid`
`ExclusiveLock` on a candidate
causes retry. Two NULL transaction IDs alone do not prove the transaction ended. No worker-name
exemption is added. Invisible types, disabled and other unrecognized states fail closed. Other ongoing
transactions at/before the cutoff block. Clearing the snapshot matters even when a long caller
transaction inspected statistics earlier. The barrier cutoff is the call, not BEGIN. A separate conservative check returns retry when
the request confirmation is at/after the caller transaction start: confirm and scrub must not be
combined in one transaction (including subtransactions). A transaction predating a concurrently
committed confirmation also retries in a fresh transaction. Service callers cannot backdate the
confirmation timestamp. This timestamp check is not used as proof that another transaction committed. Prepared transactions are checked last to cover sessions
which leave activity through PREPARE.

Excluded exact types: archiver, autovacuum launcher/worker, background writer, checkpointer,
logical replication launcher, walwriter, and pg_cron launcher. These are maintenance/scheduling
processes, not arbitrary content-SQL job executors. pg_cron jobs run in separate client/job workers.
pg_net, pg_cron job workers, parallel/logical replication workers and unknown types remain checked.
pg_net performs queue/response DML and can hold a transaction while waiting for HTTP; long workers
can delay cleanup. The barrier never cancels them or claims cleanup completed.

When blocked, either scrub returns exactly `{"retry":true,"reason":"transactions_pending"}` before
any content mutation (including B1a temporary scope setup). This is not a skipped-row count and must
not be treated as successful/empty cleanup. PR-C must retry in a later transaction; success retains
the existing table/count response. No private backend details are exposed. A lack of statistics
visibility also returns retry rather than proceeding.

Messages and context snapshots additionally reject new rows under an erased conversation through
`erasure_conversation_child_guard`. INSERT takes parent FOR SHARE, conflicting with scrub's parent
FOR UPDATE, then checks the current erasure marker. New rows cannot supply a non-NULL marker.
Changed conversation references are checked too; ordinary content UPDATEs use the existing row guard.
This closes the no-active legacy success/abort INSERT route without rewriting money functions.
Snapshots retain their existing service-role DML denial; permission and trigger rejection are tested
separately. Closed-account requests still in flight keep their token and writable conversation,
are counted as skipped, and can complete before the next scrub.

**B2/C mandatory sequencing test:** direct legacy finalizers need not have an ordinary request.
If such a finalizer targets an already erased conversation, the parent guard aborts its entire atomic
transaction, leaving its pre-deduction pending. B2/C must reconcile/finish eligible legacy financial
work before erasing its conversation, and prove failure leaves no partial financial changes. Neither
silently dropping the message INSERT nor treating this path as automatically skipped is valid.
The legacy HTTP entry and claim admission are closed, so no new legacy requests should originate.
B1b does not implement the restricted financial recovery path.

## Reproduction (local Docker only)

After #532, `--out` exports without comparing built fingerprints; the preparatory 0149 check passed.
The full 0150 check exposed a separate overlay issue: copying a whole group hash hid unchanged
file-only objects (the snapshot-type CHECK). The wrapper now compares every object in changed groups
with correctly hashed object definitions, retaining the existing staging snapshot/expected differences.
Fixtures seed under replica only, commit, then assert in a new transaction with real guards/FKs.
Each subsequent `--after` file runs in a fresh connection: C8 exercises service_role first, C11
exercises authenticated/anon, and C9 calls actual post-migration definer functions without mocks. C9 now seeds an existing
ordinary request directly before switching role, asserts claim permission denial in that fresh
session, and verifies existing transitions. No production RPC is replaced or re-granted in tests.

```sh
node packages/db/tests/baseline/replay-with-new-migrations.mjs --local-only \
  --new 0150_erasure_content_channel_runtime_chat.sql \
  --after packages/db/tests/erasure-b1a-cases.sql,packages/db/tests/erasure-b1a-nonowner.sql,packages/db/tests/erasure-b1b-cases.sql,packages/db/tests/erasure-b1b-nonowner.sql,packages/db/tests/erasure-b1b-client.sql,packages/db/tests/erasure-b1b-definer.sql,packages/db/tests/erasure-b1b-parent.sql,packages/db/tests/erasure-constraint-audit.sql
node packages/db/tests/baseline/replay-with-new-migrations.mjs --local-only \
  --new 0150_erasure_content_channel_runtime_chat.sql \
  --before-after packages/db/tests/erasure-structure-fingerprint.sql \
  --after packages/db/tests/erasure-structure-fingerprint.sql,packages/db/tests/erasure-b1b-rollback.sql,packages/db/tests/erasure-structure-fingerprint.sql,packages/db/migrations/0150_erasure_content_channel_runtime_chat.sql,packages/db/tests/erasure-structure-fingerprint.sql
node packages/db/tests/run-db-baseline-replay.mjs --local-only --write-built
node packages/db/tests/run-erasure-b1b-locks.mjs --local-only
node packages/db/tests/run-erasure-b1b-barrier.mjs --local-only
node packages/db/tests/v3/run-workbench.mjs --runtime-only --with-staging-schema --without-app --schema-from-files
```

For rollback refusal, use the wrapper with `--after` cases,refusal,rollback (the corresponding
`erasure-b1b-*.sql` paths). Require failure at rollback with `ERASURE_ROLLBACK_REFUSED`, not an
unrelated earlier failure. Structure fingerprints must match before=rollback and after=reapply.
The runner compares every migration's immediate second application object by object.
Do not refresh staging snapshots before application; the controller refreshes those afterwards.
The C12 runner reuses the file-built schema and committed B1b fixtures. One live connection holds
a Runtime session lock, then a conversation lock. A stdout barrier confirms acquisition before
a distinct service-role session scrubs under a 3-second statement timeout. It checks retry with no count keys
while locked and all 22 counts after release; every scrub assertion rolls back to preserve the same fixture.

## Mandatory staging read-only preflight before application

The controller, not the implementation writer, runs this before applying 0150. The controller's
[two-sample preliminary observation](https://github.com/Crnobog9527/GraylumAI_vercel/pull/537#issuecomment-5912107334)
found no virtual-XID lock on the idle pg_net worker; it does not replace this exact-candidate check.

1. Use the exact reviewed head's 0150 predicate and barrier. In `BEGIN READ ONLY ISOLATION LEVEL
   READ COMMITTED` ... `ROLLBACK`, inline the pure predicate expression; do not install functions,
   invoke either scrub, or apply any migration for this test.
2. Check the intended definer's statistics visibility and activity tracking, record a call-time
   `clock_timestamp()` cutoff, and clear the statistics snapshot. Apply the exact eight existing
   maintenance/launcher exclusions; do not exclude pg_net or SQL workers by name. Keep activity
   only where datid is the current database OID or NULL; capture candidate PIDs from the same rows.
3. Evaluate activity rows with the six-argument predicate and retain the NULL-state candidate PIDs
   in the same connection. In a subsequent query, check those exact PIDs' granted `virtualxid`
   `ExclusiveLock` entries. Finally check prepared transactions in the current database.
4. Report only backend types, states, NULL/non-NULL indicator flags and blocker counts. Do not
   collect query text, account/project identifiers, credentials, or publish PIDs/connection details.
   Require zero blocking items, or only explained temporary transactions that disappear on a
   fresh read-only sample. A permanent worker blocker or unknown result is a failed prerequisite;
   do not cancel transactions, weaken the predicate, or treat retry as success.
5. Record the head and preflight outcome in the PR. This check is not migration-application
   authorization; the controller still follows Owner approval and before/after fingerprint steps.

## NULL-state worker regression

`run-erasure-b1b-barrier.mjs --local-only` also runs the 45-row pure-predicate/ACL matrix and a real
C background worker from `erasure-b1b-worker.c`, compiled only in its disposable local container
(`apk add gcc musl-dev` needs package-network access; no host dependency or lockfile is changed).
The worker reads a real fixture profile's active status, releases statement/catalog snapshots,
then pauses before writing preference/Runtime content. With tracking on and off, xid/xmin are NULL
while the transaction still holds its virtual-XID lock; tracking off also leaves xact_start NULL,
so this case proves the outer lock check matters. Both scrubs must retry. After commit, the same
worker stays alive and idle: no virtual-XID lock, both scrubs pass and clear both content channels.
This is a real PostgreSQL background-worker test, not a pg_net/pg_cron extension integration test.
Existing client and five real admission-entry late-write tests still run unchanged.

## Database-scope regression

Following the [current-database P2 decision](https://github.com/Crnobog9527/GraylumAI_vercel/pull/537#issuecomment-5912851543),
the activity decision and candidate PIDs share one filtered scan: current database OID or NULL
`datid`. Other databases' client transactions cannot block this database's erasure. NULL-datid
workers keep the prior conservative handling, then the same virtual-XID and prepared checks run.
The six-argument pure function, scrub bodies, admission and financial functions are unchanged.

`erasure-b1b-database-scope.mjs` runs inside the existing local barrier suite. It holds a real old
transaction in a second database while both scrubs succeed and clear Runtime content, then proves
an old transaction in the current database still makes both retry. The other database transaction
stays open throughout. Constructed database-less rows run through the actual extracted scan SQL:
the named worker remains a candidate, the invisible backend type remains unsafe. This last check
is a scan contract, not a live database-less worker integration test. Real connected-worker,
client, prepared and late-write regressions still run in the same suite.

Local PASS for this scope increment: the pre-fix two-database case reproduced the erroneous retry;
the fixed barrier suite has 31 PASS groups. File build: 153 steps and 84 immediate repeats.
B1a/B1b overlay regression and audits pass with no unexpected differences. Structure round-trip:
`4afb151f0e649311ba14861ad345c0c9` → `1681aaa519f95c5304f5a4528b4f8c80` → original → new.
The built fingerprint changes only the barrier function definition.

## Verified local results for the earlier transaction/worker increments

- PASS: original scrub_content MD5 `3029c14ab84580323acba88565786281`; new definition
  `8e265cafaa36ba3735ea75897d210c0c`, with the barrier and separate-confirmation-transaction check.
- PASS: 153 file-build steps; 84 immediate repeat migrations; final built fingerprint updated.
  Staging-snapshot overlay has no unexpected differences; account-open and content audits return 0 rows.
- PASS: B1a C1–C8 and B1b C1–C11 regression, plus C12 transaction retry/22 counters after release.
  Fresh service/authenticated/anon sessions retain allowed/denied behavior; NULL complete/checkpoint
  and tool result refill, replacement, non-whitelist changes and protected deletion still fail.
- PASS: five real entry representatives (runtime_start, artifact_chat, agent_preference,
  research_transition, opc_account_ui_change): normal admission, deterministic late write after
  active check, unchanged data on retry, erase after late commit, and new admission denied after close.
  Existing advisory locks or disposable test INSERT triggers pause the writer; production functions
  are not replaced and foreign keys remain enabled. This is representative coverage, not every RPC.
- PASS: both scrubs distinguish transaction-free idle from idle-in-transaction; disabled/hidden
  statistics and insufficient statistics privilege fail closed. REPEATABLE READ is refused;
  a real prepared transaction blocks until resolved. Old transaction/cached statistics use the new
  call cutoff; direct and successful-subtransaction confirmations cannot be scrubbed before commit.
- PASS: 45 constructed activity rows and private helper ACL/IMMUTABLE contract; real NULL-state
  background transactions with tracking on/off block both scrubs, while the same worker after
  commit passes and both late preference/Runtime content channels clear.
- PASS: exact eight maintenance/launcher exclusions as a catalog safety contract. The local image
  has no real pg_net or pg_cron job worker; their live integration is NOT_RUN, not implied by this check.
- PASS: real legacy success/abort refuse an erased parent and roll back all attempted financial
  changes; normal finalizers succeed. An existing closed-account ordinary request finishes while
  skipped, then loses content/token on retry. Snapshot ACL denial is separate from trigger denial.
- PASS: both parent-lock orders for real legacy finalizer and snapshot INSERT: writer-first causes
  scrub retry then erasure; scrub-first makes INSERT wait, then reject without creating content.
- PASS: structure round-trip `4afb151f0e649311ba14861ad345c0c9` (pre-0150) →
  `fa4ada3b765c459a2e03ce8332231597` → original → new; immediate repeat unchanged.
- PASS (expected refusal): erased rows reject rollback before any structure change; a changed
  scrub_content definition rejects migration before schema/ACL mutation. Local containers cleaned.
- Prior PASS at `8d05f5d5`: Runtime integration 100 tests, with 5 browser/application cases explicitly
  skipped; private log canary absent. This suite is also required by final-head CI.
- PASS for this delta: API 140 files / 3079 tests, 3 skipped. The first sandboxed attempt could not
  bind its local HTTP fixtures (EPERM); a full rerun with local listening allowed passed without
  test changes. Frozen install, both package
  lint/typecheck, API type baseline, safeguards 136, workflow contracts 7 runs / 301 assertions.

Remote final-candidate CI and controller/independent review are recorded by exact head in the PR.
Staging application/acceptance remain NOT_RUN by this writer. PR-E reserves 0151; after B1b merge,
its writer must regenerate its own built fingerprint on updated staging rather than merge JSON by hand.
