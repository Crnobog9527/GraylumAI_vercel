# CI shared checks

CI retains all ten required status names and runs full validation for every
change, including documentation. There is no documentation classifier or
scope dependency. The six compatibility result jobs remain and accept only
their worker's exact `success` result; failed, cancelled, skipped, missing,
or unexpected results fail. Workflow contract tests run in the existing unit
worker before dependency installation.

Lint and type checking run once. The root `test:api` delegates to the API
package's `vitest run`, using the same configuration and environment as the
focused API regression commands. It covers auth/OAuth, checkout/cancellation,
Skill runtime, yearly grants, refund race protections, and billing reconciliation.
Those duplicate CI invocations are removed; the named package commands remain
available for focused local use. No test files or assertions are removed.

The web pricing/subscription tests retain their existing browser-case exclusions.
The web billing cron route, proxy hostname tests, and migration/database safeguards
still run separately. A single secretless build feeds the unchanged local Security
E2E assertions. Weekly migration validation still uses the frozen exact-base
checker API and is tested against both healthy and tampered migrations.

Dependency audit, dependency review, tracked environment detection, trusted-base
workflow policy validation, and trusted Gitleaks scans retain existing coverage.
The weekly schedule is unchanged. No credentials or browser artifacts are uploaded
and no environment is deployed.

Compared with the previous separated workflows, consolidation saves three dependency
installations, one duplicate TypeScript command, one full API suite execution, and
one production-mode local build. Removing scope also eliminates one prerequisite
runner job. API deduplication removes six additional Vitest launches: 919 repeated
assertions across 13 unique files (773 unique cases), verified against an actual full
API run of 1,879 passing cases. Documentation now runs the same full checks as code;
it no longer receives a runtime skip. No elapsed-time savings have been benchmarked.

Local validation uses `ruby .github/scripts/test-ci-workflows.rb` and the unchanged
trusted workflow policy checker/regression tests. The workflow regression parses
YAML, preserves required names and web/safeguard commands, executes every result
shell against success/failure/cancelled/skipped/missing/invalid inputs, and executes
the actual scheduled migration shell with healthy and tampered Git fixtures.
