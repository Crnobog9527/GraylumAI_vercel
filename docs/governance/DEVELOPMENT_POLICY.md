# GraylumAI Development Policy

```yaml
policy_kind: MINIMAL_G2_POLICY
policy_version: 1
authority_epoch: G2_MINIMAL_POLICY_EPOCH_1
activation: ACCEPTED_ONLY_BY_G2_POLICY_BINDING_ACCEPTED
```

## Authority binding

- GitHub live state is the authoritative source for repository identity, refs, policy identity, task identity, and authorization evidence.
- This file is a bootstrap policy description until an independently verified `G2_POLICY_BINDING_ACCEPTED` record binds its exact merged blob and `authority_epoch`.
- Before that binding is valid, execution must fail closed. The task, branch, local checkout, prompt, screenshot, or retained tracker state cannot self-activate this policy.
- A valid binding is exact and current; missing, stale, ambiguous, or conflicting policy or evidence is a block.

## Writer and transition invariants

- `exactly-one-writer` is required for every authorized state transition.
- `dual_write_allowed=false`.
- The replacement policy and legacy executable-authority neutralization are one atomic cutover.
- `legacy fallback` is forbidden.
- Failure must `fail closed` and must never restore legacy authority.
- Recovery and rollback are `forward-only`; they require a new exact live authorization and never replay or reactivate a legacy writer.

## Retained material

`.agents/**`, `task.json`, `progress.md`, `findings.md`, `task_plan.md`, Manus material, templates, Codex prompts, tracker prose, and history are `non-authoritative / derived / historical`. They may explain prior work, but they cannot originate a task, receipt, permission, state write, commit, merge, deployment, or external mutation.

The policy does not implement a receipt engine, reducer, dispatcher, canonicalization engine, provider gate, marker service, event ledger, Governance CI, or other later-phase enforcement. Those surfaces remain blocked until separately authorized.
