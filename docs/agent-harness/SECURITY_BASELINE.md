# Security Baseline

## Purpose

The Phase 0.5 Security Core establishes repository-side, secretless checks for pull requests. It does not authorize a merge, change external settings, create a trusted orchestrator, or grant access to production systems.

## Trusted policy provenance

Trusted policy material is present on `staging` and includes the Evaluator prompt, workflow policy checker and regression tests, secret-fixture generator, and Gitleaks configuration.

- Policy is loaded from the event's exact trusted base commit, never from the pull-request head.
- Missing, malformed, or unverifiable trusted policy fails closed.
- Candidate workflow checks use an explicit allowlist containing only `ci.yml`, `security.yml`, and `codeql.yml`.
- The deterministic checker validates structural policy. Checksum-verified actionlint remains responsible for GitHub Actions schema validation.
- A pull-request workflow cannot approve its own policy-surface changes. Independent fresh-context review and an Owner gate remain required.

Trusted policy material alone is not a trusted policy orchestrator, a protected policy-surface gate, or a complete root of trust. Those controls have not yet been established.

## Security Core controls

- Pull-request jobs are secretless and use explicit least-privilege read permissions.
- Third-party Actions use immutable full commit SHAs.
- Checkout credential persistence is disabled.
- Every job has an explicit timeout and a literal GitHub-hosted runner.
- Dependency Audit fails directly on high or critical findings.
- Dependency Review runs only for pull requests.
- Workflow Policy Check runs trusted regression tests before checking the three candidate workflows.
- Secret Scan proves trusted synthetic fixtures are rejected before scanning the replacement commit range; reports are redacted and are not uploaded.
- Tracked `.env` variants are rejected, including local, staging, preview, production, and development-local forms.
- CodeQL JavaScript/TypeScript is limited to trusted push and schedule events. It is not evidence that a pull-request head was scanned by CodeQL.

## Transitional Security E2E evidence

`Security E2E Tests` preserves the transitional required status context while using a local, non-credential runtime. It uploads no Playwright HTML report, trace, video, screenshot, storage state, or other browser artifact.

The JSON result validator rejects zero execution, failures, timeouts, interruptions, unknown outcomes, flaky outcomes, and retry-recovered failures. Explicit live-auth skips are temporarily allowed. A passing transitional check therefore proves only that the executed local subset was stable; it is not Trusted Staging E2E and is not complete security coverage.

## Independent workstreams

The following remain separate contracts and must not be folded into Security Core:

1. Security Response Headers.
2. Secretless Preview Runtime.
3. Trusted Staging E2E.
4. Executable Golden Evals.
5. Model routing and calibration.
6. Credential verification and rotation.
7. Public Repository Governance.
8. Trusted policy orchestration and protected policy-surface enforcement.

Phase 0.6, Phase 1, staging auto-merge, main merge, production deployment, and production release all require separate authorization.
