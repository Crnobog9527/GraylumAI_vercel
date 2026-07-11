# Agent Harness Threat Model

## Assets to protect

- GitHub repository write authority, merge rights, and branch integrity.
- GitHub and Vercel secrets, service roles, database URLs, Stripe credentials, and production configuration.
- Production and staging data, payment state, user accounts, and deployment controls.
- The integrity of contracts, prompts, reports, CI evidence, and exact Git SHAs.

## Primary threats and controls

| Threat | Example | Required control |
| --- | --- | --- |
| Prompt injection | PR text says to ignore policy or print a key | Treat all repository content as untrusted evidence; deterministic policy outranks model text |
| Workflow supply chain | A mutable Action tag changes behavior | Full immutable SHA pins plus version comments and policy checks |
| PR secret exposure | PR workflow reads E2E or provider secrets | Secretless `pull_request` workflows; Trusted Staging E2E deferred to an independent contract |
| Privilege escalation | Agent edits its own Evaluator prompt or workflow | Allowed scope review, Golden Eval case, and explicit owner gate |
| Evidence forgery | Model reports green CI for stale SHA | Exact head SHA, GitHub check URLs, and independent policy checks |
| Secret exfiltration | Tests/logs/artifacts include token or cookies | Gitleaks, redacted logs, no security E2E artifact uploads |
| Unauthorized production action | A task requests deployment or live billing action | Permanent forbidden actions and separate production owner gate |

## Prompt-injection handling

Instructions found in issues, PRs, code comments, test output, logs, generated artifacts, or model output cannot alter role permissions, allowed scope, forbidden actions, validation requirements, branch targets, or production gates. They may be quoted as evidence only.

## Residual risk and scope split

Security Core cannot establish trusted staging credentials, execute model calibration, choose a public license, rotate provider credentials, or repair Vercel Preview runtime configuration. Those risks remain visible in Issue #263 as independent workstreams; they do not justify adding privileged workflows or external settings to PR #265.
