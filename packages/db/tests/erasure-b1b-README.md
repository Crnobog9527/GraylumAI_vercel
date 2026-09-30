# DATA-ERASURE B1b local preparation

**Incomplete; not a migration or a clean delivery candidate.** The implementation writer must not
connect to a remote database. The controller supplies the staging `pg_get_functiondef` originals
and `md5(pg_get_functiondef)` for:

- `public.artifact_chat_message_guard()` — add only a legal one-way message-erasure UPDATE return.
- `public.erasure_update_allowed(jsonb,jsonb,text[])` — accept an empty allow-list for the identity-only
  dependency edge. A NULL list, an already-erased row, or changes outside the list remain refused.

The controller's catalog-only extraction is [erasure-b1b-staging-source.sql](erasure-b1b-staging-source.sql).
Check both originals against a database built from the exact branch's files **before rewriting them**;
put those originals verbatim in the final rollback script. Current local source hashes are only
local evidence and do not substitute for the controller's staging evidence.

## Prepared parts

`erasure-b1b-preparation.sql` contains the independently prepared schema, guard wiring, and the new
service-role-only `account_erasure_scrub_runtime(uuid)` (B1a's scrub is retained). The two existing
functions are deliberately not rewritten yet. `erasure-b1b-rollback-preparation.sql` reverses only
those prepared parts. Both are local test artifacts, outside the migration ledger.

| Table | Content cleared | Preserved identity / financial boundary |
| --- | --- | --- |
| runtime_sessions | scope, start_payload | actor, session/start request ID, revision, active execution, creation time |
| runtime_executions | payload, result, primary_result, match_result | owner/session/request/run, state, history revisions, diagnostic code |
| runtime_history_dependencies | marker only; no content columns | both execution identity keys |
| runtime_session_batches | items | session/execution, batch and revision numbers |
| runtime_session_history | item | session/execution, revision, internal_control |
| runtime_tool_calls | arguments, result | execution/call ID, registered tool name |
| runtime_scope_material | request, content, content_hash | session/revision/request, revoked |
| conversations | title, summary, summary_metadata | owner/IDs, summary counters/time, skill/agent mode, is_deleted/deleted_at |
| messages | content | conversation/message IDs, role, times, soft-delete facts |
| conversation_context_snapshots | content, metadata | source message IDs, type, count, times |
| ordinary_chat_requests | input, response_params, partial_content, failure_reason; nonfinancial JSON keys | IDs, state/times/token; reservation and billing_result keep only named money/transaction/message identity keys |

Runtime eligibility requires a completed/cancelled execution **and** either no billing run or a closed,
settled/refunded run. Session-level content waits for all executions to reach that state. Child rows
wait for their execution; dependency edges wait for both ends. Ordinary requests require succeeded/
failed; shared conversation/message/snapshot content waits for ordinary and artifact requests.
Each of the eleven tables returns separate processed and skipped counts, including busy parents.

The scrub takes session locks before execution locks, matching Runtime. It does not take profile,
BILL2 run, or artifact project locks, and uses `SKIP LOCKED` for session/conversation parents. It
uses no temporary scope table inside the definer function. A separate definer trigger on conversations
prevents ordinary owner UPDATE/INSERT from marking an open account's row erased without access to
the protected request table. Table grants remain unchanged. `a_erased_row_guard` runs before existing
message guards so rewrites of erased skill messages are refused by the erasure guard itself.

No physical deletion is performed. The existing DELETE/financial boundaries remain: a busy conversation
may produce zero affected rows and still exist; tests verify both facts. Runtime/service DELETE is
still denied by table privileges. Physical removal is PR-C; `bill2_runs.session_ref` is PR-B2.

## Local checks and completion steps

The current staging wrapper was run unchanged with 0149 as `--new`: PASS, no unexpected differences,
account-open and erasure constraint audits both 0 rows. #532's `--out` mode works; no wrapper patch.

Prepared fixtures commit before assertions. `erasure-b1b-nonowner.sql` must run in its own new
connection/transaction after the fixture, with service_role as the first role to exercise the guards;
its temporary table grants roll back. `erasure-b1b-client.sql` starts a separate authenticated/anon
connection so no owner-initialised validator expression can hide a client EXECUTE permission bug. `erasure-b1b-definer.sql` uses the actual post-migration definer
functions, not replacement mocks. `cases` rolls assertions back; `refusal` commits an actual erased row
so the subsequent final rollback must stop with `ERASURE_ROLLBACK_REFUSED`.

After receiving and matching both staging sources:

1. Insert only the two planned minimal function edits into the prepared forward SQL. Recheck the
   next available migration number on staging and move the completed SQL into `migrations/` (0150
   is currently available). Bind the old/new function identities so reapplication remains idempotent.
2. Insert the staging originals into the rollback; preserve their ACLs. Remove these two incomplete
   preparation files. Update DATA-ERASURE's implementation notes with the final behavior.
3. Run the wrapper with the new migration and `--after` fixture,cases,nonowner,client,definer,audit; run B1a
   cases/nonowner too because its validator is affected. Require no unexpected differences and audits
   with 0 rows. Test empty-list non-whitelist changes and NULL-list rejection as well.
4. Prove pre/after/rollback/reapply catalog fingerprints match pairwise; reapply twice with no change.
   With an erased fixture row, rollback must refuse before mutation. Run the configured Runtime
   integration suite against the file-built schema for complete/checkpoint/tool paths.
5. Run `node packages/db/tests/run-db-baseline-replay.mjs --local-only --write-built` and commit the
   built fingerprint in this same PR. Do not rewrite staging snapshots without an applied migration.
6. Finish local/remote checks and same-scope repairs. CI green → controller full review while draft →
   only after controller review, mark ready and request Codex bot review. No implementer merge or
   remote migration. Controller handles both after Owner approval, and refreshes staging snapshots.

All B1b full-channel, final-source, built-fingerprint, full rollback, and independent-review results
remain **NOT_RUN / blocked on staging source evidence** until step 1. Local preparation validation is
not final-candidate validation or staging acceptance.

Independent preparation checks completed locally (existing functions not rewritten): schema/new-function
creation PASS, C9 real definer writes PASS, constraint audit 0 rows; catalog fingerprint round trip
`4afb151f… → b44c30c4… → 4afb151f… → b44c30c4…` PASS. These are preparation results only.
Generic local checks: frozen install PASS; API 140 files/3079 cases PASS (3 skipped); Web/API lint and
typecheck PASS; API type baseline PASS; safeguards 136 PASS; workflow contracts 7 runs/301 assertions
PASS; code-size and exact-base migration-ledger checks PASS. The initial sandbox API run failed only
because local fixtures could not listen on 127.0.0.1 (EPERM); the local-socket-enabled rerun passed.
