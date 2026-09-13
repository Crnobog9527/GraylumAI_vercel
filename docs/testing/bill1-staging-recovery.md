# BILL-1 Staging evidence and recovery plan

This is a bounded repair and operational handoff, not a scheduler, new billing
contract, or authorization to change remote state. V3-BILL-2 is not started.

## Verified baseline and remaining blockers

Read-only observations on 2026-09-13, against staging
`fd25db9b45e5fb8155ef11cc64f1bac686d7e9ad` and the READY deployment carrying that
commit. Supabase project identity was independently resolved as GraylumAI Staging.
The three diagnostic SELECT columns from 0103 are available. Existing deployment
logs confirm the completed reconciliation fails for three real findings, not an
ACL error. No reconciliation endpoint or release Cron was invoked by this task.

Identifiers are intentionally omitted from this public document. Account A is the
single unresolved 50-credit workbench reservation identified by reconciliation;
account B is the active annual subscription with the first two grants quarantined.
Use the private Staging records to bind exact actor/project/request/grant/invoice
IDs immediately before any future authorized operation. Never use these aliases
as mutation predicates.

| Item | Current evidence | What is not established |
| --- | --- | --- |
| A: unknown generation | Created 2026-09-09 16:47:52 UTC; 50 credits reserved; result, charge, usage projection and terminal billing row absent. Internal generation request ID and pre-deduct request ID differ; join by pre_deduct_id. | Provider outcome, generation ID, actual cost and deliverable. Missing rows prove none of these. |
| A: balance | Single-statement read: balance 6891, 13 ledger entries totaling 6841; 7000 additions and 159 consumption. Reservation records 7093 → 7043; earliest historical reservation starts from 5600 after the first 5500 addition. | Opening credit provenance and complete balance mutation history. `6841 + 100 - 50 = 6891` is a hypothesis, not permission to insert 100 or adjust 50. |
| B: annual identity | Direct Stripe test-mode GET: active yearly subscription; paid invoice USD 299.00; invoice line and subscription item agree on 2026-07-05 15:07:17 UTC → 2027-07-05 15:07:17 UTC. | Payment evidence does not prove credit consumption or permission to release funds. Invoice envelope period_end equals period_start; use line/item service period, not the envelope. |
| B: grants | Period 1 and 2 each granted 5834, both review_required. Period 1 has a zero-length interval and a historical ledger key different from its normalized grant key. Period 2 ends September 5. Third period is due and absent. | Complete lifetime allocation to each grant; stored consumed_amount=0 is quarantined and untrusted. |
| B: consumption | Ledger/profile both 11767: opening 100 + two grants 11668 - one settled spend 1. August 15 spend predates the August 25 actual second grant; its billing metadata has no grant binding. | Neither date nor account arithmetic determines which grant funded that spend. No full-lifetime canonical writer provenance was found in the inspected schema. No zero-consumption claim. |

External evidence limits:

- Vercel's query for the September 9 invocation returned
  `ExceedsBillingLimitError`. This is inaccessible history, not an empty log.
- The Owner's authenticated Chrome OpenRouter Logs page was read through native
  accessibility after the independent automation browser was found signed out.
  The UI interval September 9 00:00 through September 11 23:59 (local time)
  displayed 16 dated rows. Adjacent Staging calls at September 10 00:43/00:44
  were visible, but no record could be reliably bound to the unknown operation
  at September 10 00:47:52. This is a UI observation, **not** proof of complete
  supplier history, no dispatch or zero cost. No nearby call was assigned to it.
  The documented [generation query](https://openrouter.ai/docs/api/api-reference/generations/get-generation)
  requires a provider generation ID, which the original record lacks. Do not
  substitute a local UUID or approximate time/model match. Supplier-side
  correlation/retained original response evidence remains necessary; merely
  logging into the supplier dashboard has not closed this gap.
- Stripe connector initially required reauthentication; exact subscription and
  invoice were successfully read using the existing Staging **test** credential.
  Credentials and invoice/user identifiers were not copied into this PR.

## Repair delivered by this candidate

The existing nonstream workbench transport discarded provider identity even when
it received a complete JSON error or rejected a partial result. It now records
bounded header/body observations before result validation, via a private RPC
bound to actor, project, round, request and dispatch token. Two immutable phases
retain conflicting header/body IDs for investigation. Same-phase replay is a
no-op; a different value is rejected. The public generation projection is unchanged.

Observation fields contain only HTTP status, a constrained generation ID, finish
reason and nullable numeric usage/cost diagnostics. They do not contain prompts,
output, arbitrary provider metadata or keys. Reported cost is diagnostic data,
not an authoritative charge, and is never used by this change to settle/refund.
The server does not retry the model. A failed observation write logs a bounded
warning and leaves the existing receipt/recovery path available. An ID-bearing
429 is kept unknown instead of being treated as proven pre-generation refusal.

0104 is additive and repeatable. It creates no evidence for historical calls and
changes no existing row, grant, balance or state. Remote application is NOT_RUN.
This candidate improves future evidence retention; it does not solve the three
historical operational blockers by itself.

## Concrete protected-operation plan

No data-recovery operation below is ready to execute from current evidence.
Merge approval is separate from migration or business recovery authorization.

1. **Deploy the evidence repair:** after exact-candidate merge approval, apply
   only 0104 to Staging with separate authorization, then verify private EXECUTE,
   denied client/table reads, old RPC compatibility and the deployed commit.
   Monetary impact: **0 credits, USD 0**. Do not trigger a real model call just to
   populate it. A failed/uncertain migration must be read back before retry;
   replay is idempotent. Application rollback retains the column and evidence.
2. **Recover A's provider outcome:** obtain supplier records reliably bound to
   the original request/account and, if recoverable, its original result. With a
   proven usable original result, replay the existing bound receipt/finalizer
   only after reviewing the exact payload and charge. Preserve the original
   pre-deduct and terminal uniqueness constraint. With an unknown outcome, make
   **no** balance/terminal change and do not resend. Current reserved exposure is
   **50 credits**; actual supplier USD and valid final user charge are **unknown**.
   A discretionary compensation/write-off would be a separate Owner product
   decision, recorded as such, never fabricated as provider failure.
3. **Reconstruct A's opening history:** require a contemporaneous snapshot or
   trustworthy original bootstrap/mutation evidence and a complete subsequent
   chain. If a missing opening entry of 100 is proven, a reviewed non-spend
   historical ledger insertion would change ledger by **+100**, wallet by **0**;
   it must not call the normal grant RPC (which would add credits again). This is
   conditional, not an approved correction. Do not insert a 50 adjustment to
   erase the residual. Any historical entry needs a unique actor/source key,
   exact preconditions, atomic validation and provenance. Compare ledger and
   wallet with the original legacy pending reservation separately.
4. **Recover B's annual grants:** prove full-lifetime grant allocation before
   modifying consumed_amount/accounting_state. Validate the Stripe line/item
   interval, first-window end (August 5), original ledger link and historical
   keys together; preserve old identity/provenance and do not simply rewrite
   an idempotency key. Both quarantined grants total **11668 credits**. Do not
   assign the one observed spend to a grant by date, consume all old credits,
   assume zero, or unlock only the most recent grant. Only after exact per-grant
   proof may a separately reviewed, atomic, compare-and-swap recovery transition
   trusted state and identity together. Missing proof remains a blocker.
5. **Release B's due period:** only after step 4 and independent review, use the
   existing targeted annual releaser's canonical period identity. As of this
   snapshot period 3 is **5834 credits**; no other due period is authorized.
   At execution time re-evaluate current date, paid/cancellation/refund/termination
   state and existing grants. Lock in the existing profile→grant order; retain
   the unique period/idempotency checks. Do not invoke an unscoped release Cron.
   Any expiration/reclamation effect must be computed from proven consumption
   and shown separately; current net wallet impact is therefore **not yet known**.

For every business recovery: capture a read-consistent before-image and exact
expected fields, use one transaction with stale-state assertions and unique
source keys, then inspect committed state before any retry. Verify one terminal
per hold, one ledger effect, unchanged unrelated accounts/grants and full
reconciliation. Test the exact proposed statements in disposable PostgreSQL with
those before-images and failure injection first. Rollback before commit is
transactional; after commit preserve financial history and use a separately
reviewed compensating entry if needed, never delete or overwrite evidence.
Because proof is incomplete, this PR intentionally supplies no executable
historical trust transition or balance correction with guessed values.

## Reproducible validation

- `pnpm --filter @repo/api exec vitest run src/services/__tests__/workbenchGeneration.test.ts`
- `pnpm test:ci:billing-cron`
- `pnpm --filter web typecheck`
- In an empty, network-disabled PostgreSQL 17 container, run
  `psql -v ON_ERROR_STOP=1 -f packages/db/tests/workbench_provider_observations.sql`.
  This runs the actual migration twice and exercises authenticated denial,
  owner/round/token mismatch, replay/conflict and unchanged business state.
- `node packages/db/tests/v3/run-workbench.mjs --ai-only` uses disposable SQL,
  Auth/PostgREST, a local HTTP app and synthetic transport. It applies actual
  0104 twice and tests the service callback → RPC → retained unknown evidence,
  no public exposure, original balance hold and no redispatch, plus existing
  generation/finalizer/browser regressions. It does not prove supplier behavior.

CI and independent full-candidate review results belong on the PR at their exact
head, not as a claim of BILL-1 operational PASS in this document.
