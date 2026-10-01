# Invitation abuse local validation

Scope: PR #560, one invitation decision per account, positive exact opening-grant
eligibility, transactional reward/month/IP limits, service privilege check, and
checked integer conversion in the existing rebate replay. No new digest purpose,
identity store, runtime rebate activation, historical cleanup, or reward backfill.

Run from a credential-free worktree with the pinned local Docker images already
present:

```sh
node packages/db/tests/run-invite-abuse.mjs --local-only
node packages/db/tests/run-db-baseline-replay.mjs --local-only --write-built
pnpm --filter @repo/api exec vitest run --maxWorkers=1
pnpm --filter @repo/api typecheck
pnpm --filter @repo/api lint
node scripts/check-code-size.mjs
pnpm test:ci:safeguards
```

The invitation runner refuses CI, env files and non-local Docker endpoints; it
uses disposable PostgreSQL 17, Auth and PostgREST containers bound to loopback.
The integration test also refuses non-local database/HTTP endpoints. Only
synthetic users and balances are created. All three containers and their network
are removed in finally. No remote database, external identity provider, paid
request or product configuration is involved.

## Executed evidence (2026-10-01)

- Before the appended migration: real SQL reproduces two rewards for one
  account across codes without an opening decision, plus the old bigint replay
  datatype mismatch. The new API privilege regression also failed on old code.
- After the migration: 13 invitation integration tests cover exact positive,
  zero/negative/missing decisions, misleading key prefix, zero current balance,
  historical terminal records, same-code replay and account-once behavior.
- Real independent SQL sessions observe lock waits before commit. Coverage:
  same account/different codes, same code/different accounts, inviter last daily
  allowance and monthly slot, cross-inviter same-IP hour/day slots, rebate/claim
  competition for the same cap, and concurrent rebate replay.
- More than 1,000 historical records and existing rebates count toward limits;
  partial allowance preserves the invitee award. Beijing previous-day/month
  boundary, zero limits, high-risk auto-reject off, setting parsing, and no IP
  are covered. Time is sampled after acquiring locks, and new records explicitly
  use that time; the tests do not manipulate the real system clock at midnight.
- Ledger failure rolls back both rewards, the record and code state. Integer
  boundary replays return exact values; out-of-range synthetic bigint fails
  without a new ledger entry. Unprivileged RPC access and closed parties fail.
- Real local Auth and protectedProcedure establish opening before invitation;
  same-email and synthetic Google-subject re-registration receive opening +0
  and invitation 0/0. This does not prove a remote self-service deletion flow or
  a real Google login. Original erasure (5) and opening/digest (13) tests pass.
- Full file build, consecutive migration executions, catalog-exact function/index
  rollback and reapplication, and both erasure permission audits pass. Built
  fingerprint changes only the two invitation function bodies and one partial
  index; 0151 and existing ACL fingerprints are unchanged.
- Full API suite: 146 files, 3,179 passed, 3 existing skips. API lint/typecheck
  and code-size pass. The local integration suite is separate from normal CI.
- Migration ledger / safeguards remain blocked by the absent 0153 migration
  reserved by pending #540 (125 safeguards pass; 3 fail on the same gap). Keep
  0154 until that dependency is resolved; do not add a placeholder or weaken the
  checker. Synchronize staging, numbering and the built fingerprint before
  final candidate validation. Check the PR Handoff for newer CI/review results.

## Compatibility and later staging acceptance

The old RPC signature and service-only permissions remain. The SQL independently
computes eligibility/amount/risk even for old callers. The new API sends
`server_decides`; old SQL rejects that value, so deploying API first fails closed
until the separately approved migration. No endpoint falls back to old awards.

Only a separately authorized operator may inspect/apply on staging. Before that,
collect aggregate-only config/function/permission/type and historical decision
counts. Do not expose identities, digests, keys or user balances. Do not backfill
missing opening decisions. After an authorized coordinated deployment, use new
isolated test accounts to verify the invitation panel and credit history:
first 50/30 under defaults, account repeat 0/0, +0/missing decision rejection,
partial caps, concurrent last slots and denied access. Consume no paid service.
Keep the full self-service re-registration acceptance blocked until Auth deletion
is actually available; local deletion is not staging product acceptance.

Catalog rollback is a disposable-test compatibility proof, not a production
instruction: restoring old function bodies would restore the abuse path. Prefer
forward repair or an explicitly authorized temporary reward pause. Never delete
existing decisions, reclaim balances or expand HMAC retention as recovery.
