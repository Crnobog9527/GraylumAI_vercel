# Skill/search consumption protection

The shared AI consumption guard now always requires a complete, valid read.
Skill generation and controlled workbench search pass the authenticated user's
client, which has the existing own-row billing-history policy. The privileged
client retains its existing RPC and billing duties. Its narrow SELECT contract
from 0063 does not permit filtering `billing_history.user_id`; grants are unchanged.

Query errors, missing rows/counts, capped results, non-integer/unsafe amounts,
positive settlement amounts, and unsafe totals reject new execution. Positive
settlements cannot cancel out real spending. The original hourly/daily limits,
settled-history calculation, search intent/price, subscription rules and billing
RPCs remain unchanged. Ordinary HTTP admission uses the same guard as before.
The pre-call wrapper now uses that same strict guard, including its authenticated
legacy AI caller; there is no second spending policy.

Existing generation and research identities are looked up before new-consumption
admission. Completed results and saved receipts pending settlement recover using
the original actor/request and original billing flow. They do not reconnect or
redispatch, reserve twice, or require a new balance/consumption allowance. Live
identity/access checks remain in the existing RPCs. A prepared request still
needs new-execution admission, since it can dispatch a new provider call.

## Reproduction and verification

Run with Node 24, pnpm and Docker:

```sh
node packages/db/tests/v3/run-consumption-protection.mjs --baseline
node packages/db/tests/v3/run-consumption-protection.mjs
node packages/db/tests/v3/run-consumption-protection.mjs --regression
node packages/db/tests/v3/run-chat-reliability.mjs
```

The adapter reuses the repository's disposable workbench runner. It copies no
credentials, constructs local PostgreSQL/GoTrue/PostgREST/Next HTTP, imports the
canonical own-row policy, applies narrow service SELECT grants, and caps REST
responses at 1000 rows. Local HTTP model and MCP search substitutes count actual
requests. Non-loopback fetch is blocked in the isolated application/test process.
Malformed result/count cases are explicitly injected in the disposable HTTP
proxy because the SQL integer/non-null schema prevents those corrupt rows.
Permission failures and truncation use actual SQL grants and PostgREST behavior.
Only the disposable copy has provider substitutions or fault controls. The
consumption suite is explicitly enabled by this adapter; the original shared
runner does not run tests requiring these specialized fixtures.

`--baseline` replaces three runtime files in that copy with their immutable
staging versions at `0a422ef228207e48c93959b3cede65953c149900`, containing merged
#402/#403/#404. Both hourly-denial cases fail as expected: generation returns 200
with one model call and one pre-deduction; search returns 200 with one paid fetch
and one pre-deduction. An earlier test attempt sent a bearer token to the
cookie-authenticated tRPC route and stopped at 401; it is not reproduction proof.
The corrected tests use actual GoTrue sessions serialized through the app's SSR
cookie client.

The repaired 28-case suite passes. It covers hourly/day limits, unreadable and
malformed consumption, actual 1001-row truncation, a complete 1000-row own read,
foreign rows (including 1001 high-spend records), balance denial, and successful
model/search execution. Every initial rejection asserts zero model HTTP calls,
zero MCP HTTP calls, and zero new SQL pre-deductions. Successful execution and
exact replay assert one provider call and one pre-deduction/settlement. Reply and
summary are separately admitted and each executes/reserves once. Real settlement
rollback leaves durable results that recover under zero balance, exceeded limits,
and revoked consumption-read permissions; foreign actors remain denied.

`--regression` selects existing AI and relevant CHAT integration/browser cases,
including #402 refusal/failed refund recovery, prepared retries, rates, stop and
search billing semantics, reply/summary UI recovery, configured Skill steps and
ordinary/free/document chat. The ordinary-chat runner separately exercises #403
admission and #404 request/recovery behavior. These run results, remote required
checks and independent exact-candidate review are recorded on the PR; a command
listed here is not by itself a passed check.

## Limits and delivery boundary

Limits still use settled-history snapshots, not an atomic concurrent-spending
budget. If the database caps a valid history response below the matching count,
new execution temporarily returns unavailable; partial totals are never accepted.
This bounded fix does not add pagination, aggregation RPCs or change thresholds.
An unavailable read is fail-closed for new execution and does not block original
result recovery. Existing uncertain-dispatch/stop/refund semantics remain.

No migration, remote search enablement, remote configuration, provider call,
refund, deployment or production operation is included. The task branch disables
its automatic Vercel deployment in the existing branch map. Real-provider and
deployed-environment acceptance are not local synthetic verification. Merge into
staging needs separate Owner approval.
