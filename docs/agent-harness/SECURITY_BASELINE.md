# Security Baseline

## Phase 0.5 Security Core baseline (2026-07-12)

This baseline covers repository code, pull-request workflows, deterministic policy, secret scanning policy, and calibration documentation. It contains metadata only. No secret value was read, copied, logged, or written.

### Public repository controls

- Repository visibility is public.
- `main` and `staging` require pull requests, strict up-to-date checks, and conversation resolution; force pushes, deletion, and administrator bypass are disabled.
- PR workflows are secretless and read-only. Third-party Actions are pinned to immutable commit SHAs, checkout persistence is disabled, jobs have timeouts, and stale PR runs are cancelled.
- Dependency Review runs on pull requests without an owner-managed skip switch.
- CodeQL JavaScript/TypeScript is defined only for trusted pushes and schedules because PR workflows are prohibited from write permissions.

External GitHub or Vercel settings are recorded in Issue #263, but they are not Security Core code-exit criteria for PR #265.

### Trusted policy provenance

The workflow policy checker, Gitleaks configuration, and future Evaluator policy must be loaded from the pull request's exact trusted base SHA. PR-head policy must never approve the same PR that supplied it. Missing, unverifiable, or drifted trusted policy returns `REQUEST_CHANGES`; there is no fallback to PR head.

The current `staging` base predates the checker and `.gitleaks.toml`. PR #265 therefore cannot use its own copies as merge approval evidence. A separately reviewed trusted-policy bootstrap is required before these controls can become an approving required check.

### Security Core controls

- Workflow policy uses a structured YAML parser rather than line-oriented matching.
- Policy regression coverage includes at least 15 bypass attempts across permissions, checkout credentials, PR secrets, `pull_request_target`, step and job-level `uses`, Docker digests, unsafe flags, and auto-merge commands.
- Gitleaks extends the default rules without blanket allowlists for docs or tests.
- Generated docs/test fixtures prove credential-shaped content is rejected without committing reusable secret values.
- `security.spec.ts` contains no `|| true`, soft assertion, empty assertion loop, or test whose success permits both the security control and its absence.
- GPT-5.6 documentation is a Calibration Baseline only; it does not claim an executed calibration or authority grant.

### Independent follow-up workstreams

The following are explicitly outside PR #265 Security Core exit criteria:

1. **Trusted Staging E2E**: protected Environment, synthetic credentials, staging URL allowlist, fail-closed auth/skip behavior, and artifact hygiene.
2. **Executable Golden Evals**: executable cases bound to exact model, prompt, policy, and expected decision versions.
3. **Public Repository Governance**: owner licensing decision, LICENSE/NOTICE, SECURITY.md, CONTRIBUTING.md, README authorization language, and public disclosure rules.

### PR #265 exit gate

PR #265 remains draft and `REQUEST_CHANGES` until the reduced Security Core scope has a new exact head, complete CI/Security evidence, deterministic local validation, and an independent current-head review. External Preview runtime, provider rotation, and Trusted Staging E2E are tracked separately and do not expand PR #265's scope or authority.

Phase 1, staging auto-merge, production merge, and production release remain unauthorized.
