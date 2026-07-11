# Security Baseline

## Phase 0.5 public-repository baseline (2026-07-11)

This record contains metadata only. No secret value was read, copied, logged, or written.

### GitHub controls

- Repository visibility is public.
- `main` and `staging` require pull requests, strict up-to-date status checks, and conversation resolution.
- Direct pushes are blocked by the pull-request requirement. Force pushes and branch deletion are disabled, and administrators cannot bypass the protection.
- Required checks use stable, unique CI and Security job names. No human approval count is required because the owner is not the code reviewer.
- Secret scanning, push protection, dependency graph, Dependabot alerts/security updates, and private vulnerability reporting are enabled.
- Dependency Review runs on pull requests without a skip variable.
- CodeQL JavaScript/TypeScript is defined for trusted pushes to `main` and `staging` plus a scheduled scan. It is not a PR workflow because PR workflows may not receive write permissions.

### Trusted policy bootstrap

PR policy evaluation must load the workflow checker and `.gitleaks.toml` from the pull request's exact base SHA. It must never execute either policy from PR head. The current `staging` base predates these files, so the gate intentionally fails closed until an independently reviewed trusted-policy bootstrap is merged and PR #265 is updated onto that base.

The same rule applies to future Evaluator prompts and deterministic policy: exact trusted base only, with missing or unverifiable policy reported as `BLOCKED`.

### GitHub Actions credentials

PR-triggered workflows are secretless and read-only. Trusted staging E2E is bound to the protected `staging-e2e` Environment, uses only staging synthetic-account credentials, and is disabled unless `TRUSTED_STAGING_E2E_ENABLED=true` is set by an authorized owner.

When enabled, trusted staging E2E requires the allowlisted staging URL, both synthetic roles, and staging public Supabase runtime configuration. Missing inputs, wrong URL, zero executed tests, or skipped critical tests fail the job. No browser report, trace, screenshot, video, storage state, token, cookie, or user-data artifact is uploaded.

### Vercel Preview isolation

Ordinary Preview scope no longer includes Stripe secret/webhook credentials, Supabase service-role credentials, database/admin URLs, cron credentials, privileged provider keys, or production Supabase runtime variables in either audited Vercel project. Production credentials remain Production-only; staging-specific variables must remain branch-specific or in the protected GitHub Environment.

### Exposure and rotation status

The public-history audit found credential-shaped records in historical examples/tests and two open provider-key secret-scanning alert types. Locations and commit SHAs are recorded in Issue #263 without values. Provider-side rotation or invalidation confirmation remains required before Phase 0.5 can exit.

### Phase 0.5 exit gate

Phase 1 remains unauthorized until rotation disposition, trusted-policy bootstrap, exact-head CI/Security/Dependency Review/secret scan, trusted CodeQL evidence, and independent current-head review are complete. PR #265 remains draft and cannot authorize merge, Phase 1, staging auto-merge, or production.
