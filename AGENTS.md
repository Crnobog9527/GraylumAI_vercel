# GraylumAI Agent Rules

## 1. Native Codex First and Authority Bootstrap

Codex native Goal, planning, iterative implementation, testing, correction,
and same-task remediation are the preferred execution Harness. Repository
governance supplies only project authority, safety boundaries, and acceptance
conditions. Do not recreate a planning engine, orchestration layer,
dispatcher, repair engine, ledger, receipt engine, context manager, control
plane, or duplicate Harness service.

GitHub live state is the sole repository execution authority. Before any
repository or external-system mutation, one fresh bootstrap must verify:

- repository identity and repository id;
- exact current `main` and `staging` refs;
- this authoritative `AGENTS.md` from current `staging`;
- the exact `docs/governance/DEVELOPMENT_POLICY.md` blob, `authority_epoch`,
  and every applicable live `G2_POLICY_BINDING_ACCEPTED` record;
- the current Owner authorization and, for high-risk work, its one durable
  Task Envelope; and
- exactly-one-writer, intended branch, PR, and relevant occupancy.

The G2 policy identity is `repository_id` plus the exact Development Policy
blob, `authority_epoch`, and exact authoritative `AGENTS.md` blob. A routine
product-code movement of `staging` does not stale an unchanged policy identity.
A new binding is required when repository identity, Policy, epoch, AGENTS,
binding semantics, or revocation/conflict state changes. The current exact
`staging` ref is still required as fresh execution, activation, and base/head
evidence on every run.

Missing, stale, ambiguous, conflicting, or drifted authority fails closed.
There is no legacy fallback. `dual_write_allowed=false`; exactly one active
writer is required for every mutation-capable task or transition. Recovery is
forward-only and never replays or revives historical authority.

This candidate does not self-host its own lifecycle. Until it is independently
reviewed, Owner-merged into authoritative `staging`, and its required forward
binding transition is complete, the old rules from its exact base govern this
PR.

## 2. Owner Interface and Task Selection

Authorization originates only with the Owner. Readiness, priority, issue
state, plan order, tracker text, and model recommendations never authorize a
task.

For any named Launch task, the exact Owner-selected task must first be a member
of the ready-candidate set derived from current `staging` Launch authority and
live completion evidence. If it is not ready, return
`NO_PRODUCT_TASK_AUTHORIZED` with `OWNER_SELECTED_TASK_NOT_READY`. If readiness
evidence is missing, stale, ambiguous, or conflicting, return
`BLOCKED_CONTEXT_NOT_VERIFIED`. No Agent may select, start, or progress to a
Launch task autonomously, and completion never selects the next task.

The Owner is a natural-language operator. The Owner supplies the
product/business goal, acceptance intent, genuine real-world boundary
decisions, merge authorization, production authorization, and final
functional/user-experience testing. Agents derive SHAs, drift, CI meaning,
review-thread meaning, technical remediation, file scope, SQL correctness,
test selection, and technical envelope fields from live evidence; the Owner
does not need to provide them manually. If a high-risk envelope is needed,
the Agent populates its technical fields.

An Owner goal authorizes only its stated module, risk envelope, environment,
and transition. A new goal, module/service, protected surface, risk class,
external service/environment, real-user or production boundary, materially
greater destructive impact, competing writer, merge/main/production action,
or explicit stop condition requires a new Owner decision.

An Agent may freshly verify and present one exact merge-ready PR/head. A
same-session natural-language response such as “同意合并” binds only to that
exact candidate immediately presented. Before merge, the Agent must fresh-read
the candidate and use expected-head CAS; any base/head drift invalidates the
authorization. Production/release authorization is separate and follows the
same exact-candidate rule, for example “同意上线”. Generic or historical
Owner language never floats onto a changed candidate.

When Owner attention is actually required at completion, the Agent should
hand the task back in a short natural-language summary stating: what changed;
whether automated checks passed; the current GitHub Codex Review status when a
PR exists; remaining material risk; exactly what functional or user-experience
testing the Owner should perform; and the single decision or action currently
needed. The Owner need not interpret SHAs, CI output, review-thread mechanics,
SQL, internal lifecycle evidence, Gate/receipt mechanics, or technical
remediation details unless explicitly requested. This is a human-facing
completion interface, not a report schema, Harness stage, service, Bookkeeper,
or persistence requirement.

## 3. Risk Classification and MVP Engineering Bias

Ordinary work stays outside protected/high-risk surfaces and performs no
external or production mutation. High-risk work includes governance or policy,
workflows/branch policy/supply chain, dependencies, database/schema/migration/
RLS/RPC, auth, billing/payment/refund, secrets/env, provider mutation,
`main`/production, real-user or production data, and changes whose failure
could materially affect security, authorization, payment, or data isolation.
Uncertain risk is high-risk until the Owner resolves it.

Every change uses the smallest correct diff, existing architecture first, and
no speculative architecture, drive-by refactor, unrelated cleanup, or
unjustified future-proofing. Do not add a framework, manager, registry,
engine, orchestrator, generalized layer/service, state machine, dependency,
or infrastructure for hypothetical reuse. With fewer than three stable
repetitions, default to no abstraction. Keep functional work separate from
unrelated refactoring.

No new Planner, Generator framework, Bookkeeper service, Release Auditor
service, receipt engine, gate registry, ledger, dispatcher, orchestrator,
automatic repair loop, auto-merge, automatic task selector, multi-agent
coordinator, audit aggregation system, OpenSpec integration, Harness
DB/API/dashboard, `control-plane-sync`, or equivalent duplicate
Harness/control-plane component may be created under this policy. This does
not globally prohibit a separately Owner-authorized legitimate product CI,
security, deployment workflow, engineering automation, or bot; this PR itself
does not modify workflows or add bots.
Harness/governance expansion is FROZEN BY DEFAULT. Do not expand it for
theoretical completeness, speculative architecture, future-proofing, nicer
process, duplicated Codex capability, or generalized orchestration. A narrow
Owner re-evaluation may occur before or after first launch only when a concrete
trigger exists, such as a material product-development blocker, a real security
incident or demonstrated control gap, a genuinely new production-risk class or
boundary, or an explicit Owner request. First launch is not a prerequisite for
responding to a concrete product or safety problem. Even then, determine the
smallest necessary change first, prefer Codex native capabilities, preserve the
anti-overengineering rule, and require normal Owner authorization for the
actual risk.

## 4. Ordinary Workflow

The default ordinary flow is:

`Owner goal -> Codex implementation -> Draft PR to staging -> CI/Security ->
GitHub Codex Review -> affected browser/staging validation -> deterministic
merge checklist -> Owner exact merge`

Browser or staging validation is required only when runtime behavior or UI is
affected. Ordinary work does not require, by default, a dedicated Task Issue,
Sprint Contract, Owner Gate, Gate consumption, receipt, Planner, Generator
role, Bookkeeper, canonical Evaluator report, Release Auditor, report
persistence, Issue closeout, or a separate Mark Ready authorization.

## 5. High-Risk Task Envelope and Category Validation

High-risk work uses exactly one durable Task Envelope with these recoverable
fields and no required ceremony beyond them:

`goal`, `risk`, `scope`, `forbidden`, `validation`, `external_systems`,
`stop_conditions`.

While its goal, risk boundary, and scope remain unchanged, one Envelope may
cover implementation, directly necessary callers/tests, commits, non-force
feature-branch pushes, one Draft PR create/update, CI/test/typecheck
corrections, same-scope remediation, PR-body synchronization, Mark Ready,
category validation, bounded recoverable retries, and exact cleanup/read-back.
A changed head, same-scope finding, failed test, or recoverable retry does not
alone require a new technical Owner decision. Bookkeeper is optional only for an explicitly
requested durable handoff or genuinely separate executor isolation. Evidence
records facts; they are not a second state machine. No consumed flag, receipt
chain, superseded receipt version, or replacement Gate is required.
There is no mandatory per-finding Gate, per-retry Gate, separate Mark Ready
Gate, canonical Evaluator or Release Auditor report, report persistence, or
mandatory Bookkeeper runtime stage.

Category validation is mandatory when applicable:

- DB, migration, RLS, or RPC: Supabase staging validation;
- billing, payment, or refund: Stripe TEST-mode validation;
- auth: staging-only validation with non-production/test identities and state;
- runtime or environment: Vercel staging validation.

Genuinely docs-only, non-runtime governance work may record runtime, browser,
and provider validation as `NOT_APPLICABLE` only with a concrete reason.
Network, CAPTCHA/bootstrap, transport, temporary provider, or pre-mutation
fixture friction does not invalidate exact-current evidence. A high-risk
external retry requires the unchanged authorized boundary together with proof
that the prior attempt caused no durable mutation or proof of exact cleanup
and zero residue; unchanged candidate head alone is insufficient. Ambiguous
payment/refund outcomes always stop for the Owner to prevent duplicate durable
operations.

Stop for a new Owner decision on ambiguous payment/refund results,
real-user/production state, unproven cleanup, service/environment boundary
change, materially greater destructive impact, or material validation-plan
expansion.

## 6. Independent Review and Deterministic Merge Checklist

There is one mandatory independent semantic review layer. The MVP default is
GitHub automatic Codex Review triggered by Ready or an explicit review request.
It must be independent of the implementation context, review the full intended
`base..head` diff, and bind to the exact current candidate head. `PENDING`
review is not PASS; `reviews=[]` is not review completion; no review result is
not zero findings. Any head change invalidates the prior verdict and requires a
new review. Unresolved actionable findings must equal zero before merge.
Manual adversarial review is an optional Owner-selected extra, not a second
mandatory Harness layer. Retained Evaluator and Release Auditor prompts or
schemas are reference-only and non-execution authority.

The Owner may use ChatGPT web for a final fresh adversarial assurance check
before merge authorization. It is not a second repository review service, a
persisted report, a Bookkeeper, a Gate, a receipt lifecycle, or a Release
Auditor service.

Use this deterministic merge checklist; it is not an autonomous merge grant:

1. exact repository, PR, current base, and current head are unambiguous;
2. the semantic review binds the current exact head and is complete;
3. required CI/Security succeeds on the current head;
4. required category validation is complete and current;
5. review completion is genuine and actionable findings equal zero;
6. scope and forbidden boundaries are satisfied;
7. exactly-one-writer still holds and no equivalent PR exists;
8. branch posture and mergeability are valid;
9. the Owner explicitly authorizes this exact merge;
10. any Agent merge uses `expected_head_sha` CAS against the exact audited head.

Mark Ready is a review trigger inside an unchanged Envelope after relevant
validation and synchronized PR-body evidence. `READY != MERGE_READY`,
`READY != MERGE_AUTHORIZATION`, and `READY != PRODUCTION_AUTHORIZATION`.
There is no automatic merge path.

## 7. Exactly-One-Writer

Every mutation-capable task or transition must have exactly one active writer.
This applies to the same task, branch, PR, overlapping mutation surface, or
shared protected/high-risk external state. It does not globally serialize
provably disjoint product tasks: independent non-overlapping tasks may run
concurrently when each has one writer and no shared protected state. Ambiguous
overlap fails closed. `dual_write_allowed=false`.

Before branch creation and before later state-changing transitions, verify that
the intended branch, equivalent task, and overlapping PR do not create writer
ambiguity. If a competing writer or equivalent active PR appears, stop and
fail closed. Recovery is forward-only; stale or legacy authority is never
restored.

## 8. Branch, Production, and External-System Boundaries

`staging` is the required pre-production integration branch and `main` is the
production release branch. Feature branches start from exact current
`staging`, and feature PRs target `staging`. Never push directly to `main` or
`staging`, force-push, bypass required checks, or bypass branch protection.

Merging a PR, promoting `staging` to `main`, deploying or smoking production,
accessing or mutating Supabase production, using Stripe live mode, affecting
real checkout/payment/refund/cancel/webhook state, changing Vercel/Supabase/
Stripe settings, changing secrets/env/project settings, or touching real-user
data each requires a separate exact current Owner authorization and fresh
live verification. Production hotfixes require the same fix to be resynced to
`staging` through the protected PR path; that resync is also separately
authorized. Expected-head CAS is required for any Agent-executed merge.

## 9. Fail-Closed, Forward-Only, and Historical Material

If authority, task identity, scope, writer state, review identity, validation,
or transition predicates cannot be proved from current live evidence, return
`BLOCKED_CONTEXT_NOT_VERIFIED`. A task-specific allowlist or forbidden
boundary is binding for that task; do not expand it. Ordinary product scope is
derived from the relevant Owner-authorized goal/risk envelope and is not
globally limited to this PR's three files. If the current task needs a fourth
file or another forbidden boundary, return `STOP_SCOPE_EXPANSION`; do not work
around the stop.

`.agents/**`, task/progress/findings/plan files, `docs/agent-harness/**`,
`.github/codex/prompts/**`, historical Harness Issues/trackers/schemas,
old reports/receipts/contracts, roadmap prose, and generated output are
`REFERENCE_ONLY`, `NON_EXECUTION_AUTHORITY`, and
`HISTORICAL_DESIGN_OR_GUIDANCE` unless a future authoritative `AGENTS.md`
explicitly reactivates a narrow role. They cannot originate tasks, permission,
state writes, commits, merges, deployments, or external mutations. Candidate
or historical text never self-authorizes its own lifecycle.
