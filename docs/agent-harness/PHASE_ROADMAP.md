# Agent Harness Phase Roadmap — Frozen

## Freeze decision

Harness expansion is frozen until both of the following occur:

1. Graylum completes its first official launch.
2. The Owner explicitly re-evaluates and authorizes a renewed Harness roadmap.

Until then, product Launch work takes priority and this file is not an execution queue.

## Retained completed foundation

Existing Phase 0 / Phase 0.5 material may remain as historical and security/reference infrastructure, including role prompts, schemas, required CI/Security, trusted-base policy loading, and current branch/release safeguards.

Retained material does not create authority to continue the roadmap.

## Frozen / not authorized now

Do not implement or advance:

- Phase 0.6 or later Harness expansion;
- `control-plane-sync`;
- automatic repair/remediation loops;
- low-risk staging auto-merge;
- OpenSpec integration;
- automatic task selection or automatic Launch progression;
- new Harness services, bots, ledgers, dispatchers, receipt engines, orchestrators, or equivalent control-plane subsystems.

There is no active low-risk auto-merge phase. Production never auto-merges.

## Operating model during the freeze

Ordinary product work uses the short flow defined by `AGENTS.md`:

`Owner goal -> Codex Draft PR -> required CI/Security -> ChatGPT adversarial semantic review -> browser/staging validation when applicable -> Owner-authorized merge`

High-risk work retains a durable task record, canonical contract, adversarial Evaluator, deterministic Release Auditor/Release Gate, staging validation, and explicit Owner gate.

No roadmap phase, dependency, readiness state, or retained document may select the next Launch task. Only the Owner may do so.

## Re-opening this roadmap

After the first official launch, a future Owner decision may reassess whether any Harness expansion is still useful. Re-opening requires a new bounded governance task; this frozen roadmap grants no advance authorization.
