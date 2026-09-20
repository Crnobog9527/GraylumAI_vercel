# CI scope and shared checks

CI retains all ten required status names. Lint and type checking run once;
API tests run once (the root `test:api` command is the identical API `test:run`
command previously repeated in Security). All named regression suites remain.
A single secretless build feeds the unchanged local Security E2E assertions.
The two related required contexts depend on the same actual execution result.

The six required result jobs always run and fail on missing scope evidence,
failed/cancelled work, or unexpected skipped work. Documentation success means
scope validation actually ran; it does not claim runtime tests ran.

The documentation-only allowlist is four exact prose files: `README.md`,
`docs/ARCHITECTURE.md`, `docs/PROJECT_MAP_FOR_OWNER.md`, and this document.
All other paths, including Launch/governance, AGENTS, skills, configuration,
dependencies, and the scope utility itself require full validation. Only regular
non-executable files qualify; both sides of renames and file modes are checked.
Diffs use exact event commits and complete NUL-separated Git output. PRs use
merge-base, but a diverged/behind base still forces full integration validation.
Missing, malformed, ambiguous, empty or unrecognized event evidence runs full CI.
The checkout must match the push head or PR head/exact integration tree.

Dependency audit, dependency review, tracked environment detection, trusted-base
workflow policy validation, and trusted Gitleaks scans retain existing coverage.
The existing weekly runtime checks move to CI on the same weekly schedule.
No credentials or browser artifacts are uploaded and no environment is deployed.

Expected full-run savings: three dependency installations, one duplicate
TypeScript command, one API suite run, and one production-mode local build.
There are additional lightweight scope/result runner startups; elapsed-time
savings depend on runner scheduling and the critical path, and are not benchmarked.
Documentation runs additionally omit the three runtime worker jobs, while the
security scans and audit remain. A docs-only optimization is intentionally narrow;
this workflow change itself must pass full CI.

Local verification: `ruby .github/scripts/test-ci-scope.rb`,
`ruby .github/scripts/test-ci-workflows.rb`, and the unchanged trusted workflow
policy checker/regression tests. Git-backed fixtures test branch divergence,
missing commits, malformed events, renames, unusual paths, and file types.
The workflow regression parses YAML and executes every required result shell
against the complete success/failure/cancelled/skipped input matrix.
