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
