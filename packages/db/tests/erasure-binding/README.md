# DATA-ERASURE terminal Runtime binding

`node packages/db/tests/erasure-binding/run-local.mjs --local-only`

Only a local Docker Unix socket and disposable PostgreSQL 17 are accepted. No database URL,
remote environment, Auth account, Storage object, provider or paid call is used. The physical
DELETE statements in cases.mjs affect synthetic local Runtime rows only.

0187 adds two original UUIDs to the existing financial run and one partial unique index.
The session/execution tables cannot remain the source of binding evidence after PR-C removes
those business rows; retaining just their original identifiers is the smallest missing capability.
The original run/call/receipt/ledger stays authoritative; no parallel financial state is introduced.

The service RPC requires real erasure, closed settled/refunded money, no conflict, erased
Runtime session/execution/run/call content and projected receipts. Unknown/manual-review rows
remain pending. It locks session then execution then run/calls/receipts/profile, matching Runtime
recovery. A busy session/execution returns an explicit retry result without waiting in reverse order.

The existing restrictive session FK stays in place: it is safer to explicitly detach through the
checked operation than to let arbitrary parent deletes silently unlink a financial run. Original
UUIDs cannot be refilled, removed or rebound. No caller or scheduler is added in this slice.

Tests cover v1/v2 settled/refunded paths, roles/cross-subject denial, content and billing pending,
idempotency, real two-connection contention, exact empty rollback/reapply, source drift rejection,
and forward-fix-only after detachment. Once synthetic business rows are removed, receipt hashing
still uses the original payload hash, and financial recovery returns only the original terminal
result without repeating settlement. Money and ledger remain unchanged.

Remote platform deletion and complete PR-C behavior are NOT_RUN. This slice does not prove
public financial metadata scrubbing, untrusted receipt resolution, Storage/Auth erasure or the
24-hour end-to-end deletion promise. Public metadata work and PR-C follow as separate candidates.
