# GPT-5.6 Model Policy

## Stable run record

Every Planner, Generator, Evaluator, and Release Auditor run must record its `model`, `reasoning_effort`, `prompt_version`, and `policy_version`. A report without these fields is incomplete evidence.

## Role isolation

- Generator and Evaluator always use fresh, independent contexts.
- Evaluator must not reuse Generator reasoning, hidden rationale, or a previous response as evidence.
- Release Auditor remains read-only and independently verifies exact SHA, scope, checks, and policy gates.
- Subagents are reserved for bounded read-heavy review. They do not write code in parallel.

## Initial calibration

- GPT-5.6 Sol with `high` reasoning effort is the initial Evaluator candidate.
- `xhigh` or `max` reasoning effort is allowed only after Golden Eval evidence shows it is necessary for a named failure mode.
- Terra is for low-risk classification and batch summaries, never for a final high-risk or production decision.
- A model upgrade never inherits authority. It must rerun Golden Evals and receive an explicit policy-version update.

## Prompt and policy split

Prompts stay minimal and role-specific. Deterministic policy owns branch rules, prohibited actions, scope validation, secret boundaries, exact-SHA checks, and evidence requirements. Model output is never a fact source: it must be supported by exact Git SHA, GitHub checks, test output, and policy-gate evidence.
