# Agent Harness Threat Model

## Assets to protect

- Repository write authority, branch integrity, required checks, and merge gates.
- Trusted policy material, contracts, prompts, reports, and exact-commit evidence.
- GitHub, Vercel, Supabase, Stripe, model-provider, and database credentials.
- Staging and production data, user accounts, billing state, and deployment controls.
- Browser state, test artifacts, logs, and other evidence that may contain user or credential data.

## Threats and required controls

| Threat | Example | Required control |
| --- | --- | --- |
| Prompt injection | Pull-request content asks the runner or reviewer to ignore policy | Treat repository and event content as untrusted evidence; load policy from the exact trusted base |
| Policy self-approval | A pull request weakens the checker that evaluates the same change | Protected policy surface, trusted-base loading, fresh-context read-only review, and an Owner gate |
| Workflow supply-chain compromise | A mutable Action tag changes after review | Full immutable Action SHA pins and checksum verification for downloaded tools |
| Pull-request credential exposure | A PR job reads a repository secret or privileged environment | Secretless PR jobs, read-only permissions, no environment binding, and no external writes |
| Evidence substitution | A stale check or unrelated CodeQL run is presented as current-head proof | Exact base/head evidence and explicit statements about which event and commit each check covers |
| Failure masking | Audit, E2E, retry, or skipped results are interpreted as a pass | Direct exit-code propagation and fail-closed structured result validation |
| Secret exfiltration | Logs or browser artifacts contain credentials or session state | Redacted scans, no secret values, and no upload of browser reports, traces, video, screenshots, or storage state |
| Unauthorized production action | Automation changes production, billing, auth, or database state | Permanent forbidden actions and separate Owner authorization for every high-risk or production gate |

## Trust assumptions

- Pull-request head content is untrusted, including workflows, scripts, fixtures, documentation, logs, and generated output.
- Trusted policy material exists on `staging`, but the trusted policy orchestrator, protected policy-surface gate, and complete root of trust do not yet exist.
- Deterministic workflow policy is structural. It does not prove shell semantics, network isolation, business behavior, or workflow execution integrity.
- The transitional local Security E2E subset may skip live-auth tests and does not prove response-header enforcement or Trusted Staging E2E.

## Residual risk and scope separation

Security Response Headers, Secretless Preview Runtime, Trusted Staging E2E, Executable Golden Evals, model routing and calibration, credential rotation, Public Repository Governance, and trusted policy orchestration remain independent workstreams. Their absence must stay visible, but it does not authorize privileged credentials, external settings changes, or scope expansion inside Security Core.
