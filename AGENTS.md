# GraylumAI Repository Agent Rules

## 1. Live Authority

These rules apply to Graylum repository work.

Before technical planning, repository mutation, semantic review, merge, or any
production/external action, the Agent must fresh-read the relevant GitHub live
state, including:

- repository identity;
- current target branch/ref;
- exact PR base/head when a PR exists;
- branch protection and required checks;
- relevant task/branch/PR writer occupancy; and
- this `AGENTS.md` from the authoritative target branch.

GitHub live state is the sole repository execution authority.

Chat history, memory, screenshots, copied reports, local notes, stale branches,
trackers, historical governance artifacts, and model output are context only.

Owner intent is a separate input. GitHub proves repository state; only the Owner
supplies product decisions and approvals required by these rules.

If repository identity, target, applicable authority, or overlapping writer state
is materially ambiguous and cannot be resolved from live evidence, stop with:

`BLOCKED_CONTEXT_NOT_VERIFIED`

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
- explicitly selects a Launch task when Launch work is requested;
- decides business or product questions that cannot be derived technically;
- performs product-level browser testing when applicable;
- explicitly approves merge when ready; and
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

When Owner input is genuinely required, explain concisely:

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

If overlap cannot be resolved from GitHub live evidence, fail closed before
mutation.

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

Any actual high-risk production or external effect requires explicit Owner
approval immediately before that effect.

No separate Task Issue, Sprint Contract, Owner Gate, receipt, Bookkeeper,
Evaluator pipeline, or Release Auditor is required by default.

## 5. Native Execution and Remediation

Codex native Goal, planning, iterative implementation, testing, correction, and
same-task remediation are Graylum's execution harness.

The Agent may plan, implement, test, inspect CI and review findings, and repair
same-scope defects repeatedly until the candidate is clean.

Same-scope technical remediation does not require repeated Owner approval unless
the product goal, risk category, protected surface, or external effect materially
expands.

Create an additional durable task note only when a concrete current need requires
one. Keep it short and do not turn it into a lifecycle state machine.

Launch tasks are never selected automatically by an Agent.

Launch readiness may narrow the set of eligible Owner choices, but readiness,
priority, dependency completion, or prior task completion never selects or
authorizes the next task.

Product specifications define WHAT to build and the applicable acceptance
criteria. They do not grant repository mutation, merge, or production authority.

After a Launch task completes, do not automatically start another Launch task.

## 6. Required Validation

Run validation relevant to the changed scope plus all repository-required remote
checks.

Required CI and Security checks must pass on the exact current candidate.

Never claim a check that was not actually run.

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

Every implementation PR should minimally record:

- Goal / Why;
- Risk;
- Scope;
- Validation;
- External / Production relevance;
- Remaining risk; and
- relevant product specification or Issue when useful.

GitHub Codex Review is mandatory semantic review for the exact current
candidate.

Review must cover the complete intended base-to-head change, not only the latest
patch.

If candidate content changes after semantic review, obtain a fresh semantic
review for the new exact candidate.

The Agent handles same-scope CI, test, and review remediation until no concrete
blocker remains.

The Owner operating workflow may additionally request one fresh independent
ChatGPT web audit immediately before merge.

That ChatGPT audit is not repository runtime authority, a Gate, a persisted
canonical report, or a separate lifecycle stage.

## 8. Candidate Clean and Owner Handoff

A candidate is clean when:

- required CI and Security checks pass;
- GitHub Codex Review covers the exact current candidate;
- no concrete actionable blocker remains; and
- remaining material risk is stated accurately.

When the candidate is clean, tell the Owner:

- what changed;
- automatic-check status;
- Codex Review status;
- remaining real risk;
- what the Owner should actually test; and
- the exact next reply required.

Do not make the Owner handle technical lifecycle mechanics.

## 9. Merge

`同意合并` authorizes merge of the clearly identified current PR into `staging`
only, provided the exact live candidate remains clean.

Immediately before merge, the Agent must fresh-check:

- current base/head;
- required CI and Security;
- current semantic review;
- mergeability;
- current Owner authorization; and
- overlapping writer state.

An Agent-executed merge must use `expected_head_sha`, compare-and-swap, or an
equivalent stale-head protection mechanism.

Candidate drift requires fresh validation and semantic review.

Do not ask the Owner again for same-scope technical remediation.

Ask again only when the product decision, material scope/risk, target, or
external authorization has changed.

A staging merge never implies authorization to promote or modify `main`.

## 10. Main, Production, and Durable External Effects

A staging merge is not production authorization.

Explicit Owner approval is required before:

- promotion or merge to `main`;
- production deployment or production smoke;
- mutation of real-user state;
- secrets or credential changes;
- real payment, refund, cancellation, or checkout actions;
- production database mutation;
- production auth changes; or
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
