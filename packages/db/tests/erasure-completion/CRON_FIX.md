# DATA-ERASURE daily cleanup repair (PR #774)

Risk: **high** (erasure/database and preservation of unresolved financial facts).
Scope: repair the daily executor failure, persist redacted RPC diagnostics, and make
unresolved financial review visible. No new table, RPC, queue, provider call, refund,
role grant, environment change, remote migration, or merge. Migration **0200** was
reassigned by the coordinator on 2026-10-10 so this repair can ship first.
The former 0203 allocation is superseded by the latest PR coordination comment.

## Root cause and evidence

The staging `authenticator` role loads `safeupdate` with `supautils`. The historical
`account_erasure_scrub_content(uuid)` executes `DELETE FROM pg_temp.erasure_scope;`.
`safeupdate` rejects that statement with SQLSTATE **21000**, `DELETE requires a WHERE clause`.
The processor discards the detailed RPC error, marks its database channel uncertain,
and refuses subsequent mutations; the request only retained generic error codes.
The empty executor token is consistent with the idle worker releasing its claim,
not proof that it never acquired one.

The original complete local suite passed because its direct PostgreSQL connection
had no `safeupdate` library. With the real extension loaded, the same migrated
function failed at that exact statement. Staging function definitions matched the
local scrub/work functions, and its API connection's preload configuration was
read in a READ ONLY transaction. The historical Vercel error body is unavailable;
this diagnosis is a reproduced failure plus matching staging configuration, not a
claim to have recovered the expired log.

All staging diagnosis used READ ONLY or explicit final ROLLBACK transactions.
No remote modifications were committed, no Auth/Storage removal was invoked, and
no production database or browser was used. A diagnostic attempt to LOAD the library
was denied by the managed platform; it was not bypassed. Local reproduction used
the real library instead. Direct admin SQL without the library did not reproduce it.

## Change and recovery

0200 replaces only the temporary scope reset with `TRUNCATE TABLE pg_temp.erasure_scope`.
This clears the connection-private working set, not a persistent user table. It
keeps safeupdate enabled, preserves the existing ownership predicates and grants,
and guards the function-source replacement against an unexpected predecessor.
Repeated migration application is a no-op after the exact replacement.

The processor now appends a fixed operation label and allowlisted protocol error
code to the existing `executor_error_codes`, for example
`ERASURE_RPC_SCRUB_CONTENT_21000`. Unknown values become `DATABASE_ERROR`; rejected
transport and timeouts retain an explicit unknown-outcome category. It never copies
error message/details/hint, SQL, request arguments, user content or credentials.
Existing uncertainty, I/O drain, original claim and Auth-once guards stay intact.
Old application code remains compatible because the existing field and RPC shapes
are unchanged. Returning to the old SQL reintroduces the failure; use forward repair.
No data restoration is needed for this migration itself: it changes functions only.
Do not treat reverting application code as restoration of subsequently erased data.

## BILLING_NO_PROVIDER_ID: automatic and manual outcomes

This code refers to a **model provider call**, not a payment subscription ID. The
staging read-only check found one `bill2.v1` call in `dispatched` state, with both
provider ID and selected cost missing; its PAYG metering flags were false. Its
review list/date were empty. Calling this a free account does not prove zero cost.

- Existing automatic recovery can finish when a call is proven undispatched and
  its original permission is revoked, or when trustworthy original provider
  evidence establishes cost/terminal outcome. It uses the original run/call and
  pre-deduction; never a new dispatch, replacement identity or duplicate refund.
- A dispatched call without ID/cost, contradictory evidence or unresolved payment
  facts remains `billing_pending`. 0200 gives even a fully scrubbed financial-pending
  subject `ERASURE_FINANCIAL_PENDING_REVIEW` and the existing 30-day review cadence.
  Daily retries preserve the original date. It is not an automatic write-off date.
- Independent content cleanup continues. Missing financial facts do not permit
  inventing zero cost, refunding automatically or marking Auth deletion/completion.

**Manual entry:** the coordinator opens the **staging** Supabase SQL editor/API,
reads the service-only existing request/run/call records, and checks the original
provider account's evidence. The following is a read-only investigation entry;
its internal identifiers must stay in the restricted investigation, not PR comments:

```sql
BEGIN READ ONLY;
SELECT a.request_id, a.stage, a.last_error_code, a.review_codes, a.next_review_at,
       r.id AS run_id, r.contract_version, r.state AS run_state,
       c.id AS call_id, c.state AS call_state,
       c.provider_id IS NOT NULL AS has_provider_id,
       c.selected_cost_usd IS NOT NULL AS has_cost
FROM public.account_erasure_requests a
JOIN public.bill2_runs r ON r.actor_id = a.profile_id
JOIN public.bill2_calls c ON c.run_id = r.id
WHERE a.stage = 'billing_pending'
  AND c.dispatched_at IS NOT NULL AND c.selected_cost_usd IS NULL;
ROLLBACK;
```

There is no general-purpose BILL2 v1 unknown-cost write-off UI/RPC established by
this repair. The existing `billingReport.reviewMetering` is for PAYG metering review,
not this v1 case; `erasure-recovery.mjs` only reconciles a stopped executor's claim,
not monetary facts. If original evidence cannot resolve it, the coordinator must
present the concrete amount/uncertainty and a bounded settlement/write-off proposal
to the Owner. This PR supplies visibility and preserves facts; it does not authorize
that protected action or pretend the unknown call has been settled.

## Reproduce with actual safeupdate (local only)

Use the existing pinned PostgreSQL 17 image in `tests/v3/images.mjs`. Build
[pg-safeupdate](https://github.com/eradman/pg-safeupdate) source commit
`37dbc9c4acf5e2504adf2b218e9c6b41751022f3` in a disposable container with its server
headers. The `safeupdate.c` SHA-256 used here is
`1351fc18b9a1e2dcc72185d349c178244458b5d9eb30007609c3d599b38aeb38`.
No repository dependency/image pin or remote configuration is changed.

```sh
# safeupdate.so must be built for the runner's pinned PostgreSQL image/architecture.
ERASURE_SAFEUPDATE_LIBRARY=/absolute/local/path/safeupdate.so \
  node packages/db/tests/erasure-completion/run-local.mjs --local-only
node packages/db/tests/run-db-baseline-replay.mjs --local-only --write-built
pnpm --filter @repo/api exec vitest run src/services/accountErasure
```

The optional library is copied only into the disposable container. The executor
service connection loads it, proves a WHERE-less probe is rejected with 21000,
then tests the real scrub function and production executor. The ordinary mode
without this option must not be reported as proof of safeupdate coverage.

## Handoff

- Done: local root-cause reproduction, minimal 0200 fix, durable diagnostic code,
  unknown-finance review/date regression.
- Validation: full API 5832 PASS / 12 SKIPPED; erasure unit suite 184 PASS;
  actual-safeupdate complete local integration PASS; migration replay 203/203,
  134 historical repeats, unchanged reapply; only the two expected function
  fingerprints changed. API type/lint/size and CI workflow 9 tests / 341 assertions PASS.
  The earlier ledger failure from the superseded 0203 allocation is historical.
  Renumbering validation and final remote checks/review are tracked on the PR.
- Order: this repair uses 0200; #766 now uses 0201 and #764 uses 0202.
  The production baseline has no reserved number and takes the next available number
  when needed. Never add placeholder migrations to bypass the contiguous ledger check.
  Current #766 does not directly replace either of the two functions changed here;
  it shares `built-fingerprint.json` and changes related erasure guard interactions.
  The later merger must integrate the earlier merged version and rebuild the full
  fingerprint through the standard runner. No manual fingerprint edits.
- Next: complete exact final-version checks and review, then coordinator obtains
  required Owner approval. This task does not merge or apply 0200 remotely.
- After approved migration and deployment, the next daily run should no longer fail
  at the temp reset. The fresh test subject with complete history and no unresolved
  finance should remove its ticket/object, delete Auth last, and reach `completed`.
  Older subjects with unproven attachment history remain pending until evidence is
  resolved; the unknown-cost subject remains reviewable `billing_pending`. Do not
  expect or require all four to be forced complete. Verify actual outcomes read-only
  after that run; before deployment this expectation is **NOT_RUN**.
