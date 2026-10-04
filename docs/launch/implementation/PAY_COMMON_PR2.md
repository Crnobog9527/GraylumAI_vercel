# PAY-COMMON PR-2 implementation

Risk: high — payment identity, fulfillment, membership and database transaction boundaries.
This slice implements section 6 PR-2 of `docs/launch/tasks/PAY-COMMON.md`.

## Scope and delivery boundary

- Stripe checkout intent is persisted before dispatch, with a stable order-derived identity.
- Payment readers and writers switch together to `payment_provider_refs` authority;
  compatibility columns are derived in the same transaction.
- Callback, return, renewal, cancellation, receipt and grant paths preserve original channel
  and frozen purchase facts. Existing payment transactions and ledger remain authoritative.
- No new channel setting, Waffo, refund policy, Runtime or BILL2 consumer changes.
- Migration starts at 0168; 0167 belongs to PR #632. Recheck numbers and regenerate the
  built fingerprint against the actual merge order before delivery.
- Draft only. No remote database, remote migration, configuration, ready transition or merge.

## Recovery

Preserve orders, mappings, snapshots and grants; repair forward. Do not delete financial
facts or roll the application back to independent writes of legacy Stripe columns.
Unknown provider outcomes retain the original attempt and require reconciliation.

## Validation record

Implementation and validation are in progress. No implementation checks have passed yet.
The PR Handoff records actual commands and results; fixture tests do not establish a real
Stripe sandbox end-to-end result. Existing Stripe regressions, new denial/replay/order tests,
local empty-database replay twice, types, lint, code size and required CI remain to run.

## Current implementation checkpoint (incomplete)

The current draft adds **only an unconnected foundation**:

- `pay_common_create_purchase` serializes an existing subject's checkout intent under the
  profile lock, requires an existing Stripe price mapping, freezes server-side product facts,
  and reuses the unresolved order. It makes no provider call.
- 0168 adds the missing server-maintained package version timestamp. A small admission RPC
  is necessary because existing direct order inserts cannot atomically freeze and reuse an
  unresolved intent. Orders remain the sole purchase authority; no new state table is added.
- Pure helpers validate exact USD cents, receipt amount/mode/currency, frozen credit totals
  and an order-derived provider key. No existing caller uses them yet.

**Do not deploy this as PR-2 completion or enable a partial mapping switch.** The following
work is still required together on this branch:

1. Connect checkout dispatch/recovery to durable orders; preserve the exact request envelope
   across retries and explicitly reconcile provider expiry/unknown outcomes.
2. Switch all payment readers/writers, including catalog administration, to authoritative
   provider refs with transactionally derived legacy columns. Resolve current catalog-price
   selection without discarding prior price mappings. Never invent external identities.
3. Extend the existing fulfillment RPCs for order/grant snapshots, immutable renewal contracts,
   original-channel receipts/cancellation, lifecycle ordering and closed-account handling.
4. Make membership facts explicitly channel-aware without changing Runtime consumers.
5. Add full callback replay/out-of-order/duplicate/concurrency/recovery coverage, then run the
   complete final candidate validation. Foundation tests do not prove these behaviors.

The admission function is not yet the complete membership eligibility check; connection must
preserve all existing allowed/denied semantics and recheck relevant facts inside the transaction.
Do not call it as a replacement for the existing eligibility service as currently written.
