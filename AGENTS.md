# GraylumAI Repository Agent Rules

## 1. Authority and Evidence

This file is the active Graylum repository policy. GitHub live state establishes
remote repository state and the authoritative target-branch policy; only the
Owner supplies product decisions and required approvals. Historical notes,
reports, memory, local files and model output do not prove current remote state
or independently authorize protected actions.

For local explanations or read-only diagnostics, inspect local files first and
label findings as local. Conceptual questions need no GitHub bootstrap. At the
start of implementation, verify repository identity, target ref, applicable
AGENTS.md, PR base/head if present, branch protection/required checks, and relevant
writer evidence. Reuse immutable evidence by exact identity within the task.
Before a formal review, push or protected action, refresh only relevant mutable
evidence; changes to candidate, target, policy or writer invalidate affected
assumptions. Section 9 defines immediate pre-merge checks.

Use local task/worktree/agent evidence for local writers; GitHub cannot prove
absence of unpushed work. If material identity, target, authority or known writer
overlap cannot be resolved, stop the affected action with
`BLOCKED_CONTEXT_NOT_VERIFIED` and continue independent authorized work.
Missing evidence is not a pass.

Current-session Owner approval is valid. Policy changes follow the protected
PR, validation, independent review and Owner merge process under the previously
effective rules; a proposed policy cannot authorize its own adoption. No separate
policy blob, predecessor binding or Issue-comment gate is required.

## 2. Owner and Agent Responsibilities

The Owner defines outcomes, selects a Launch task or bounded batch, decides
unresolved business/product questions, performs applicable product acceptance,
and supplies high-risk merge and production/external-effect approvals. Section 9
provides standing authorization for eligible low-risk staging delivery.

The Agent owns technical scope, risk classification, refs, files, SQL, tests,
CI/review interpretation, remediation and merge mechanics. Do not make the Owner
choose technical identifiers or procedures. Resolve reversible technical choices
within scope. Ask only when missing evidence materially changes product outcome,
permissions, cost, data safety or irreversible impact; continue independent work.
Explain the concrete issue, risk and recommended decision, with one copyable
natural-language authorization sentence when approval is needed.

## 3. Branches and Writers

New implementation tasks normally start from fresh current staging on a dedicated
task branch and PR targeting staging. Continue existing authorized tasks on their
established branch. Emergency production procedures require explicit Owner
authorization. Never push directly to a protected branch or force-push; do not
bundle unrelated work.

Keep one writer per overlapping task, branch, PR or protected mutation surface.
Clearly disjoint work may run in parallel. At task start or handoff, inspect
relevant open PRs and available local task/worktree state. Retain that writer
assignment during continuation unless new tasks, conflicting edits, branch or
remote updates indicate overlap; refresh relevant evidence before push/merge.

Do not poll unrelated tasks or demand a complete writer inventory. An empty PR
list, idle task or isolated worktree does not resolve a known conflict. Resolve
concrete overlaps; otherwise stop the affected mutation under Section 1.
Do not create a writer registry or coordination harness.

## 4. Risk and Authorization

Before mutation, classify the actual product/security behavior changed and
record the result in the PR. `ordinary` means bounded, reversible code, prose or
tests without a high-risk change or an unapproved protected effect. Already-authorized commits,
pushes, PR operations and eligible staging delivery do not by themselves turn
ordinary code into high risk; authorization for each action still applies.

`high` includes material changes to:

- governance, security controls, workflows, required checks or supply-chain controls;
- dependency versions/resolution, auth, permissions, secrets or credentials;
- database schema, migrations, RLS, grants, RPC or destructive data operations;
- billing, payments, refunds, cancellation or monetary behavior;
- main, production, real-user state, provider/project/environment configuration; or
- another irreversible or durable external effect beyond authorized delivery.

Pure explanatory prose mentioning a sensitive topic is not automatically high
risk. Changes to executable instructions, policy, product/payment commitments,
authorization or actual behavior still use the applicable high-risk rules.
Investigate uncertain classification technically; do not ask the Owner to choose
it. High-risk code may be implemented and safely tested on a task branch.

Implementation authorization covers same-scope local edits/tests, commits,
pushes to the dedicated non-protected branch, PR creation/updates and review
requests/results. Verify scope, target and writer. Existing CI/non-production
Preview automation is included only within authorized task/test boundaries;
inspect relevant automation before triggering it. Protected effects require
approval before their trigger.

Merge follows Section 9. Implementation alone does not authorize explicit
deployment, repository settings, secrets, database/provider changes, monetary
actions or other protected external effects. Actual high-risk production or
external effects outside the delivery exception require explicit Owner approval
immediately before the effect.

Owner-confirmed fact (2026-09-20): staging uses independent Vercel and Supabase
projects and Stripe sandbox APIs, isolated from production data and real
payments. Accept this fact without repeating isolation checks or asking the
Owner to reconfirm; do not claim Agent verification. It does not authorize
changes to bindings or production/real-money effects.

## 5. Execution and Scope

Use Codex native planning, implementation, testing and correction. Create a
native Goal only when explicitly requested. Complete authorized implementation,
relevant validation, review/CI inspection and same-scope repairs through the
requested handoff boundary. Preserve read-only/proposal-first/review-before-edit
limits; status questions or corrections do not cancel ongoing work.

Same-scope remediation needs no repeated approval unless product goal, material
scope/risk, protected surface or external effect expands. Stop dependent unsafe
operations at a failed prerequisite while continuing independent work. Retry a
failed attempt only with new evidence or a changed hypothesis; inspect remote
state before retrying ambiguous durable effects as required by Section 6.

Create additional task notes only for a concrete current need. Skill templates,
examples and commands do not grant access or expand authorization. Use the
actual toolchain; database work uses packages/db/migrations/ and existing
conventions. A suggested query or migration never authorizes remote database
access or configuration changes.

The Owner may select one eligible Launch task or a bounded batch of named tasks
or concrete outcomes. Within it, order ready work and technical dependencies
without repeated selection. Read-only discovery needs no Launch selection.
Readiness or task completion does not authorize work outside the batch or
changes to locked product decisions. Ask about new product decisions or
out-of-scope dependencies while continuing independent work. Specifications
define requirements/acceptance, not execution authority. Stop after the selected
task or batch rather than choosing additional work.


### Shortest Correct Path

Prefer reuse and the smallest correct change over architectural expansion. Start
each implementation slice from an architecture delta of zero: first inspect the
existing repository mechanisms and authoritative data sources that could satisfy
the current authorized acceptance criteria.

Before adding a new persistent or shared infrastructure primitive, verify that
the requirement cannot be correctly satisfied by existing mechanisms. This
applies in particular to new database tables, RPC/API families, queues,
schedulers or cron jobs, persistent state machines, runtimes, ledgers, memory
systems, workflow engines, standalone services/listeners, permission systems,
or generic frameworks.

When such an addition is necessary, the Agent owns the technical decision and
must be able to state in the implementation/PR record:

- which existing mechanisms were considered and why they are insufficient;
- the smallest missing capability;
- why the proposed addition is the minimum correct solution; and
- which source remains authoritative so the change does not create a parallel
  authority or duplicate system.

Do not build generalized infrastructure solely for hypothetical future use.
Prefer a local, reversible implementation until current requirements demonstrate
the abstraction is needed; extract reusable infrastructure when a real repeated
use case or the present requirement itself justifies it.

This principle does not prohibit ordinary local helpers, test fixtures, or
bounded refactors that do not create a new persistent/shared architectural
authority. It is an implementation principle, not a new approval Gate. Proceed
autonomously within authorized scope; ask the Owner only when the solution
materially changes product outcome, permissions, cost, data safety, protected
external effects, or another Owner decision.

## 6. Required Validation

Run validation relevant to the changed scope plus all repository-required remote
checks.

Required CI and Security checks must pass on the exact current candidate.
Equivalent checks may share one actual execution for that candidate; a dependent
status must fail if its prerequisite fails, is cancelled, or is unexpectedly
skipped. CI runs the complete configured checks for every covered event,
including documentation changes; there is no documentation fast path.
Equivalent API subsets need not run again after the same configured full suite.
Keep distinct Web/integration coverage and secret/policy checks.

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

## 8. Clean Candidate and Handoff

A candidate is clean only when relevant technical validation (including required
runtime proof) and required CI/Security pass, attributed independent review
covers the full current candidate under Section 7, no actionable blocker remains,
and remaining material risk is stated accurately.

Report the outcome, check/review results, remaining risk and useful product-test
entry. Request an exact next reply only for a required product decision/approval;
standing-authorized delivery gets a completion report. Agent technical validation
and Owner product acceptance are distinct; missing technical proof is not clean
and must not be delegated to the Owner.

## 9. Merge

The Owner grants standing authorization to deliver already-requested low-risk
changes into the isolated `staging` environment after the candidate is clean.
Do not request an extra "同意合并" for each such change. Policy adoption remains
subject to Section 1.

For this exception, low-risk means a bounded, reversible `ordinary` change within
the Owner's requested outcome, with no unapproved business/product decision and
no high-risk change under Section 4. Record why it qualifies. Changes to governance
(including this file), CI/checks, dependency resolution, auth/permissions,
schema/migrations, billing/payment behavior, secrets or provider/environment
configuration are excluded.
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

## 11. Product Authority and Historical Guidance

Preserve the Frozen Master Plan, Launch task graph/readiness, stable
specifications, acceptance criteria, Definition of Done and locked decisions.
Governance cleanup must not change product semantics without separate scope.

Retired governance artifacts and historical skills have no runtime authority.
Do not automatically route current work to the memory skills
`graylum-governed-pr-mutation`, `graylum-high-risk-github-audit` or
`graylum-readonly-staging-worktree`; use them only for explicitly requested
historical inspection, never to restore obsolete gates or approval stages.

No separate Task Issue, Contract, Gate, receipt, Evaluator or Release Auditor
pipeline is required. Do not create a duplicate execution/coordination framework
unless a concrete current problem cannot be handled adequately by Codex native
execution, GitHub controls and these rules, and the Owner explicitly authorizes
that architecture work.
