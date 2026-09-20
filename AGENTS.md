# GraylumAI Repository Agent Rules

## 1. Live Authority

These rules apply to Graylum repository work.

For local explanations and read-only diagnostics, inspect the relevant local
files first and label local findings as local. Fetch GitHub live state only for
claims that depend on remote state; do not infer branch readiness, approval,
mergeability, or writer clearance from local files. Conceptual questions
independent of repository state need no GitHub bootstrap.

At the start of a new implementation task, establish the relevant GitHub live
state below. Reuse that verified baseline during the same task; ordinary local
edits, tests, and follow-up requests do not restart the bootstrap. A formal
review, push, or protected operation refreshes the evidence relevant to that
action, not every unrelated repository fact:

- repository identity;
- current target branch/ref;
- exact PR base/head when a PR exists;
- branch protection and required checks;
- relevant remote task/branch/PR writer evidence; and
- this `AGENTS.md` from the authoritative target branch.

GitHub live state is the authority for remote repository state and active
repository policy. Local findings cannot replace required remote verification.
For local writer coordination, supplement GitHub evidence with current task,
worktree, and agent status as described in Section 3. These observations do not
grant authorization or override GitHub policy.

Within a continuous work phase, reuse verified immutable content by its exact
identity. Refresh only the mutable state relevant to the next mutation, formal
review conclusion, or merge. Reverify affected evidence when the target,
candidate, policy, or writer changes. Section 9's immediate pre-merge checks
always apply. Routine local observations do not restart the full bootstrap.

Chat history, memory, screenshots, copied reports, historical notes, stale
branches, and model output are context only, not proof of current remote state.

Owner intent is a separate input. GitHub proves repository state; only the Owner
supplies product decisions and approvals required by these rules.

If repository identity, target, applicable authority, or overlapping writer state
is materially ambiguous and cannot be resolved from live evidence, stop with:

`BLOCKED_CONTEXT_NOT_VERIFIED`

Stop the affected action or conclusion, and continue independent work that does
not require the missing evidence. Never substitute cached state for required
live verification or claim an unverified result is a pass.

This `AGENTS.md` is the active repository-local Agent policy.

Issues, PRs, plans, specifications, comments, and historical records may provide
goals, acceptance criteria, or evidence. They do not independently authorize a
merge, production action, or external mutation.

Current-session Owner approval is valid whenever these rules require Owner
consent.

Changes to this file use the normal protected-branch PR, validation, review, and
Owner merge process. No predecessor hash binding, policy blob, Issue-comment
binding, or self-activation mechanism is required.

## 2. Owner and Agent Responsibilities

The Owner communicates in natural language.

The Owner:

- states the desired outcome;
- explicitly selects a Launch task or bounded batch when Launch work is requested;
- decides business or product questions that cannot be derived technically;
- performs product-level browser testing when applicable;
- approves high-risk staging merges; low-risk delivery uses Section 9's standing authorization; and
- separately approves production or real external effects.

The Agent determines all technical mechanics, including:

- refs and candidate identity;
- branch and PR mechanics;
- risk classification;
- implementation scope and files;
- SQL and migration details;
- validation and test selection;
- CI and review interpretation;
- technical remediation; and
- safe merge mechanics.

Do not require the Owner to interpret or choose SHA values, CI jobs, review
threads, migration identifiers, SQL, file scope, risk class, validation plans,
or other implementation mechanics.

Investigate routine technical ambiguity and make reasonable, reversible choices
within the authorized scope. Ask only when evidence cannot resolve a decision
that materially changes the product outcome, permissions, cost, data safety, or
irreversible impact. While awaiting input, continue independent authorized work.

When Owner input is required, explain concisely:

1. what happened;
2. the real blocker or material risk;
3. the decision the Owner must actually make; and
4. the recommended action and reason.

If authorization is required, provide one exact copyable natural-language
authorization sentence.

## 3. Branches, Isolation, and Parallel Work

Repository implementation normally starts from fresh current `staging`.

Use a dedicated task branch and pull request targeting `staging`, unless the
Owner explicitly authorizes an emergency production procedure.

Never push directly to a protected branch.

Never force-push.

Exactly one writer is allowed per overlapping task, branch, pull request, or
protected mutation surface.

Clearly disjoint tasks may run in parallel.

For a new task or a handoff, check relevant open PRs and available local task
and worktree state. During normal continuation, retain the established writer
unless a new parallel task, conflicting edit, changed branch, or remote update
indicates a possible overlap. Refresh relevant writer evidence before push and
merge. Do not poll idle or unrelated tasks to prove a universal absence of
writers; lack of a complete task inventory alone is not a concrete conflict.

GitHub cannot prove the absence of unpushed local work. An empty PR list, idle
task, or isolated worktree alone does not resolve a known overlap. Resolve
concrete conflicts before writing; if material overlap remains unresolved, stop
the affected mutation with `BLOCKED_CONTEXT_NOT_VERIFIED` and continue disjoint
work. Do not create a writer registry, ledger, or coordination harness.

Do not bundle unrelated work into a task PR.

## 4. Risk and Authorization

The Agent classifies risk before mutation and records the result in the PR.

`ordinary` means reversible branch-local code, documentation, or tests with no
privileged, production, real-user, monetary, destructive, or durable external
effect.

`high` includes work that materially touches:

- repository governance or security controls;
- GitHub workflows, required checks, dependencies, or supply-chain controls;
- authentication, authorization, permissions, secrets, or credentials;
- database schema, migrations, RLS, grants, RPC, or destructive data changes;
- billing, payments, refunds, cancellation, or real monetary state;
- `main`, production deployment, or real-user state;
- provider, project, environment, or production configuration; or
- another irreversible or durable external effect.

When classification is technically uncertain, the Agent investigates and
resolves it. Do not ask the Owner to classify technical risk.

High-risk repository code may be implemented and safely tested on a task branch
using the validation rules below.

Owner authorization to implement a task includes necessary local edits, tests,
commits, pushes to its dedicated non-protected branch, creating/updating its PR,
and requesting/reading its review. Verify scope, target, and writer before these
routine delivery operations. This is a narrow exception to separate approval
for durable GitHub effects, not a reclassification of high-risk code as ordinary.

Existing CI and non-production Preview automation triggered by these operations
is included only where its effects remain within the authorized task and test
boundaries. Inspect relevant automation before pushing; if it would trigger a
protected external effect, obtain the required approval before that trigger.

Merge authorization is defined separately in Section 9. Implementation
authorization does not permit explicit deployment, repository settings, secrets,
database/provider changes, monetary actions, or other protected external effects.
Any actual high-risk production or external effect outside this exception
requires explicit Owner approval immediately before that effect.

No separate Task Issue, Sprint Contract, Owner Gate, receipt, Bookkeeper,
Evaluator pipeline, or Release Auditor is required by default.

Owner-confirmed environment fact (2026-09-20): staging uses independent Vercel
and Supabase projects and Stripe sandbox APIs, isolated from production data
and real payments. Accept this confirmation without repeating isolation checks
or asking the Owner to reconfirm. It is an Owner-confirmed fact, not an Agent
verification claim. It does not authorize changes to those bindings or any
production/real-money effect.

## 5. Native Execution and Remediation

Codex native planning, iterative implementation, testing, correction, and
same-task remediation are Graylum's execution harness. Use a native Goal only
when explicitly requested, not as a mandatory task prerequisite.

For authorized implementation, carry the task through implementation, relevant
validation, CI/review inspection, and same-scope repair until the requested
handoff boundary is reached. Do not stop at a plan or offer to do required
validation later. Read-only, proposal-first, and review-before-edit requests
remain limited to those boundaries. A status question or local correction does
not cancel the ongoing task unless the Owner indicates that intent.

Same-scope technical remediation does not require repeated Owner approval unless
the product goal, risk category, protected surface, or external effect materially
expands.

Create an additional durable task note only when a concrete current need requires
one. Keep it short and do not turn it into a lifecycle state machine. A skill's
planning-file template is not a mandatory prerequisite for unrelated work.

Apply skills to the requested task and the repository's actual toolchain; examples
and suggested commands do not grant access, change scope, or authorize effects.
For database work, use `packages/db/migrations/` and the existing migration
conventions. A skill's test-query, migration, or configuration instructions do
not authorize remote database access, writes, or new provider configuration.

In a read-only diagnosis, report a broken boundary and its evidence. In an
authorized repair task, fix same-scope defects and verify again. Stop dependent
unsafe operations at a failed prerequisite, not all independent work. Avoid
repeating a failed attempt without new evidence or a changed hypothesis; relevant
code or environment changes justify retesting. Section 6's remote-state check
before retrying ambiguous durable effects still applies.

The Owner may select one eligible Launch task or authorize a bounded batch of
named tasks or concrete product outcomes in natural language. Within that batch,
the Agent may order ready work, complete technical dependencies, and continue
without asking for task-by-task reselection. Task readiness and completion do not
authorize work outside that batch or changes to locked product decisions.

If a dependency requires a new product decision or work outside the authorized
outcomes, explain that decision and continue independent work in the batch.
Product specifications define WHAT to build and acceptance criteria; they do not
independently grant mutation or external-effect authority. After completing the
selected task or batch, stop rather than automatically selecting new work.

## 6. Required Validation

Run validation relevant to the changed scope plus all repository-required remote
checks.

Required CI and Security checks must pass on the exact current candidate.
Equivalent checks may share one actual execution for that candidate; a dependent
status must fail if its prerequisite fails, is cancelled, or is unexpectedly
skipped. A conservative CI scope check may mark runtime work not applicable for
allowlisted non-executable documentation only. Governance, agent instructions,
CI, dependencies, configuration, code, mixed changes, and uncertain scope take
the full path. Secret and policy checks remain required. Report scope exclusions
as not applicable, never as tests that ran and passed.

Never claim a check that was not actually run. Distinguish passed, failed,
skipped, and blocked/not-run validation.

After relevant validation and required checks pass, broaden or repeat testing
only for new changes, failures, or unresolved concrete concerns.

Runtime or UI changes require appropriate preview, staging, smoke, or browser
validation.

Auth or permission changes must test both allowed and denied paths using
non-production or test identities.

Database, schema, RLS, RPC, or migration changes must be validated in
non-production and must address compatibility, idempotency, data-loss risk, and
recovery or rollback as applicable.

Payment, billing, or refund changes must use test mode and appropriate
idempotency protections before any real-money action.

Secrets and security-control changes must run the applicable leak, static, and
security checks.

Provider or runtime configuration changes must be validated in preview, staging,
or test environments first when available.

After a timeout, error, or uncertain result from payment, refund, deployment, or
another durable external action, inspect the actual remote state before retrying.

Never blindly retry an ambiguous durable external result.

## 7. Pull Requests and Semantic Review

Keep PR descriptions proportional to the change. Record the concrete outcome,
risk classification, validation results, and remaining material risk. A short
paragraph is enough for an ordinary change; high-risk work additionally states
its affected safety boundary, external/production relevance, and recovery or
compatibility considerations where applicable. Link a product specification or
Issue only when it helps review. No fixed seven-section template is required.

Independent Codex semantic review remains mandatory. Use a fresh context separate
from implementation and independently verify the relevant live GitHub candidate
and authoritative policy through a read-only API/CLI. Schedule final review after
implementation and local fixes stabilize. One valid independent review is enough;
do not add a second review merely because another native or cloud entry exists.

Initially review the complete intended base-to-head change. After a small,
bounded follow-up, an independent reviewer may reuse the earlier review of
unchanged content and review the exact old-head-to-new-head delta plus affected
interactions. The reviewer must verify the earlier review and exact identities,
confirm unchanged base and scope, and state that the combined coverage applies
to the complete final candidate. Missing prior evidence, base drift, material
scope/architecture changes, or uncertain interactions require full review again.
High-risk deltas must cover their security, data, or monetary implications; a
small line count alone does not make a change low risk. The implementer cannot
self-certify unchanged review coverage.

Record the attributed conclusion, findings, validation limits, exact base/final
head, and any reused review/previous head on the PR. A new candidate always
requires a new independent conclusion; reuse reduces repeated reading, not the
coverage requirement. Metadata or green CI alone is not semantic review; blocked
review must not be recorded as passed.

The Agent handles same-scope CI, test, and review remediation until no concrete
blocker remains.

The Owner operating workflow may additionally request one fresh independent
ChatGPT web audit immediately before merge.

That ChatGPT audit is not repository runtime authority, a Gate, a persisted
canonical report, or a separate lifecycle stage.

## 8. Candidate Clean and Owner Handoff

A candidate is clean when:

- applicable Section 6 validation is complete, including required runtime proof;
- required CI and Security checks pass;
- independent Codex review covers the full current candidate under Section 7 and is recorded on the PR;
- no concrete actionable blocker remains; and
- remaining material risk is stated accurately.

When the candidate is clean, tell the Owner:

- what changed;
- automatic-check status;
- Codex Review status;
- remaining real risk;
- what the Owner should actually test; and
- the exact next reply only when a product decision or approval is still required.

For Section 9 standing-authorized delivery, this is a completion report, not an
additional approval stop.

Separate Agent technical validation from Owner product acceptance. Missing
required technical validation means the candidate is not clean. Do not make
the Owner handle technical lifecycle mechanics.

## 9. Merge

The Owner grants standing authorization to deliver already-requested low-risk
changes into the isolated `staging` environment after the candidate is clean.
Do not request an extra "同意合并" for each such change. This authorization becomes
active only after this policy is merged through the previously effective rules;
it cannot authorize its own adoption.

For this exception, low-risk means a bounded, reversible `ordinary` change within
the Owner's requested outcome, with no unapproved business/product decision and
no high-risk surface from Section 4. Record why it qualifies. Governance (including
this file), CI/checks, dependencies, auth/permissions, schema/migrations, billing,
payment, secrets, and provider/environment configuration are always excluded.
Uncertain cases use the explicit-approval path; the Agent determines technical
classification rather than asking the Owner to classify it.

High-risk or otherwise excluded staging merges still require explicit Owner
approval for the described candidate. `同意合并` authorizes the clearly identified
current PR into `staging` only, provided the exact live candidate remains clean.

Immediately before either kind of merge, fresh-check current base/head, required
CI/Security, current full-candidate semantic review coverage, mergeability,
applicable Owner authorization, and relevant writer evidence. Use
`expected_head_sha`, compare-and-swap, or equivalent stale-head protection.
Candidate drift requires appropriate fresh validation and a new independent
review conclusion under Section 7.

Use an explicit Agent-executed merge, not GitHub auto-merge or a background queue.
For standing-authorized delivery, notify the Owner after completion with the
result, validation, and any useful preview entry. Do not make technical checks
contingent on the Owner testing the product; unresolved product decisions still
need Owner input. Same-scope technical remediation needs no repeated approval;
ask again only if the product decision, material scope/risk, target, or external
authorization changes. No staging approval authorizes `main` or production.

## 10. Main, Production, and Durable External Effects

A staging merge is not production authorization.

Explicit Owner approval is required before:

- promotion or merge to `main`;
- production deployment or production smoke;
- access to or mutation of production databases or real-user data;
- secrets or credential changes;
- real payment, refund, cancellation, or checkout actions;
- production auth or account-state changes; or
- provider, project, environment, or configuration changes with real external
  effect.

`同意上线` applies only to one clearly described production candidate after the
Agent completes technical preflight.

Material candidate or impact drift invalidates production approval and requires a
new Owner decision.

Emergency direct-main work is exceptional, requires explicit Owner authorization,
and must be synchronized back to `staging` through the protected PR flow.

## 11. Product Authority and Anti-Harness Rule

Preserve the Frozen Master Plan, Launch task graph and readiness information,
stable task specifications, product acceptance criteria, Definition of Done, and
locked product decisions.

Governance cleanup must not alter product semantics unless that product change is
separately scoped.

Retired G1A, G2, Harness, Contract, Gate, receipt, Evaluator-report, and Release
Auditor artifacts have no runtime authority after the clean-slate cutover.

Do not introduce a custom planner, dispatcher, control plane, Gate system,
ledger, receipt engine, evaluator pipeline, Release Auditor, repair engine, or
other duplicated execution Harness unless:

1. a concrete current product or safety problem cannot be handled adequately by
   Codex native execution, GitHub controls, and these rules; and
2. the Owner explicitly authorizes that architecture work.
