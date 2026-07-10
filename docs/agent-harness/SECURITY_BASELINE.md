# Security Baseline

## Phase 0.5 baseline (2026-07-10)

This is a metadata-only audit. No secret values were read, copied, or written.

### GitHub controls

- `main` and `staging` currently report `protected: false`; no classic branch-protection rules were returned.
- Detailed rulesets and branch-protection settings are not readable through the current private-repository plan API. Force-push, deletion, strict-up-to-date, conversation-resolution, and bypass-actor settings must be owner-verified in GitHub settings.
- Merge commit, squash, and rebase are all enabled; auto-merge is disabled.
- Default workflow token permission is read-only, but repository-wide SHA pinning is not required and all Actions are allowed.
- GitHub environment records have no protection rules.

### GitHub Actions secrets and usage

Repository secret names observed: `E2E_ADMIN_EMAIL`, `E2E_ADMIN_PASSWORD`, `E2E_TEST_EMAIL`, `E2E_TEST_PASSWORD`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, and `NEXT_PUBLIC_SUPABASE_URL`.

Before Phase 0.5, `Security E2E Tests` exposed the E2E credentials to `pull_request`. Phase 0.5 removes these references from PR-triggered workflows. Trusted staging E2E expects separately scoped `STAGING_E2E_*` synthetic-account secrets; it does not receive Stripe, database, service-role, or production secrets.

### Vercel Preview exposure requiring owner remediation

Both Vercel projects, `graylum-ai-vercel-v1` and `graylumai-staging`, currently scope `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL`, and `OPENROUTER_API_KEY` to Preview. The production project also scopes `POSTGRES_URL`, `POSTGRES_URL_NON_POOLING`, and `CRON_SECRET` to Preview.

This is a `BLOCKED` external configuration risk. Preview must not receive live Stripe, production Supabase, service-role, database, provider, or cron credentials. No Phase 1 work may rely on Preview as a trusted runner until the owner remediates this in Vercel settings.

### Code scanning

GitHub CodeQL/code scanning is currently disabled for this private repository. This PR does not add a CodeQL workflow that would fail result ingestion. Alternative baseline controls are pinned workflow policy checks, dependency review, `pnpm audit`, and gitleaks. After the owner enables CodeQL/code scanning, add a SHA-pinned JavaScript/TypeScript workflow in a separate PR and verify alert ingestion.

Dependency Review also requires Dependency Graph plus GitHub Advanced Security on this private repository. Its workflow definition is present but guarded by the owner-managed `DEPENDENCY_REVIEW_ENABLED` repository variable, so unsupported repositories remain green without pretending the review ran.
