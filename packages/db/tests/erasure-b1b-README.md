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

0150 rejects source drift before rewriting either function; exact new definitions are also accepted
for idempotent reapplication. CREATE OR REPLACE retains owners/ACLs. The rollback contains both
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
REVOKE does not cancel calls already executing: the controller must keep the legacy entry disabled
and drain any pre-migration claim transactions before running scrubs. Existing requests retain
transition access and follow the in-flight eligibility rules below.
Terminal ordinary requests lose `writer_token` during erasure. Live requests still require and
preserve it; erased rows cannot refill it. It is a dispatch credential, not retained identity.

Runtime eligibility requires completed/cancelled executions and either no billing run or a closed,
settled/refunded run. Session/material content waits for every execution; child rows wait for their
execution; dependency edges wait for both ends. Ordinary requests require succeeded/failed; shared
conversation/message/snapshot content waits for ordinary and artifact requests. All eleven tables
return processed and skipped counts. Busy parent locks are skipped for PR-C retry; session locks
precede execution locks. No profile/BILL2 run/artifact project lock or definer temporary table is added.

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
  --after packages/db/tests/erasure-b1a-cases.sql,packages/db/tests/erasure-b1a-nonowner.sql,packages/db/tests/erasure-b1b-cases.sql,packages/db/tests/erasure-b1b-nonowner.sql,packages/db/tests/erasure-b1b-client.sql,packages/db/tests/erasure-b1b-definer.sql,packages/db/tests/erasure-constraint-audit.sql
node packages/db/tests/baseline/replay-with-new-migrations.mjs --local-only \
  --new 0150_erasure_content_channel_runtime_chat.sql \
  --before-after packages/db/tests/erasure-structure-fingerprint.sql \
  --after packages/db/tests/erasure-structure-fingerprint.sql,packages/db/tests/erasure-b1b-rollback.sql,packages/db/tests/erasure-structure-fingerprint.sql,packages/db/migrations/0150_erasure_content_channel_runtime_chat.sql,packages/db/tests/erasure-structure-fingerprint.sql
node packages/db/tests/run-db-baseline-replay.mjs --local-only --write-built
node packages/db/tests/run-erasure-b1b-locks.mjs --local-only
node packages/db/tests/v3/run-workbench.mjs --runtime-only --with-staging-schema --without-app --schema-from-files
```

For rollback refusal, use the wrapper with `--after` cases,refusal,rollback (the corresponding
`erasure-b1b-*.sql` paths). Require failure at rollback with `ERASURE_ROLLBACK_REFUSED`, not an
unrelated earlier failure. Structure fingerprints must match before=rollback and after=reapply.
The runner compares every migration's immediate second application object by object.
Do not refresh staging snapshots before application; the controller refreshes those afterwards.
The C12 runner reuses the file-built schema and committed B1b fixtures. One live connection holds
a Runtime session lock, then a conversation lock. A stdout barrier confirms acquisition before
a distinct service-role session scrubs under a 3-second statement timeout. It checks all 22 counts
while locked and again after release; every scrub assertion rolls back to preserve the same fixture.

## Verified results

- PASS: received staging source MD5s match actual local replay before either rewrite.
- PASS: file build 153 steps; 84 migrations repeat with identical catalog objects; built fingerprint updated.
- PASS: B1a C1–C8 regression and B1b C1–C11 (eleven-table counts/content/hash, idempotency,
  in-flight retry, replacements/refills/non-whitelist columns, both silent delete guards,
  fresh non-owner/client sessions, real definer writes and disabled legacy admission).
  Account-open/constraint audits: 0 rows.
- PASS: C9 fresh service-role claim call is denied with its permission error; real Runtime
  writes and existing ordinary dispatch/unknown/stop transitions still work, including stop for a
  closed account's in-flight request. C2/C4/C6/C10 clear terminal tokens, preserve live/in-flight
  values, require live tokens and reject refills. Both new regressions failed on the old migration.
- PASS: C11 non-NULL erasure-marker INSERTs fail uniformly for self, other open/closed and absent
  accounts before closure lookup; normal owner INSERT succeeds. The new test fails on the old guard.
- PASS: C12 holds actual Runtime/conversation parent locks in one connection; a distinct service-role
  connection skips them, returns all 22 expected counts, and scrubs successfully after release.
- PASS: audit probes detect NOT NULL, live-only CHECK, missing-argument guard and a new private
  column on the marker-only table. With validator EXECUTE revoked, fresh C8 fails specifically
  with `permission denied for function erasure_update_allowed`; this is the expected negative result.
- PASS: rollback/reapply fingerprint `6a504112eadbfba26d1962173071a11d` →
  `4afb151f0e649311ba14861ad345c0c9` (matches the independently recorded pre-0150 fingerprint) →
  `6a504112eadbfba26d1962173071a11d` → same after immediate repeat.
- PASS: with erased rows rollback fails specifically at its initial check with
  `ERASURE_ROLLBACK_REFUSED`; changed staging-source definition is refused before schema mutation.
- PASS: Runtime integration against repository-built schema: 100 passed; 5 explicitly skipped
  browser/application cases. Private canary absent from application logs. This is local evidence.
- PASS: frozen install; API 140 files / 3079 tests (3 skipped); both packages' lint/typecheck;
  API type baseline; safeguards 136; workflow contracts 7 runs / 301 assertions; code-size and ledger.

Remote final-candidate CI and controller/independent review are recorded by exact head in the PR.
Staging application/acceptance remain NOT_RUN by this writer. PR-E reserves 0151; after B1b merge,
its writer must regenerate its own built fingerprint on updated staging rather than merge JSON by hand.
