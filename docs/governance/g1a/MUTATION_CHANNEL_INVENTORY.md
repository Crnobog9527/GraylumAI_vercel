# G1A Mutation Channel Inventory

```yaml
phase: G1A
material_type: NON_EXECUTABLE_DESIGN_AND_TEST_MATERIAL
live_enforcement_active: false
legacy_authority_disabled: false
replacement_policy_activated: false
g2_policy_binding_accepted: false
repository_id: 1133708061
repository: Crnobog9527/GraylumAI_vercel
task_issue: 282
task_state_version: 3
issue_definition_revision: BOUNDED_CORRECTION_2
main_exact_sha: a9f26d7dd4fa8fdaf716d90008ec12030379f368
staging_exact_sha: 69beaf0b82717b0809f6a6f72c29fca0abe0b8d0
merge_base_exact_sha: a9f26d7dd4fa8fdaf716d90008ec12030379f368
```

## Evidence boundary

This is a design-time inventory captured from the receipt-bound `staging` tree and GitHub read-only metadata. A path/blob entry proves that a source is observable at the stated ref; it does not prove that the source is executable, authoritative, reachable in production, or currently enforced. Runtime, provider, database, environment-variable, credential, and permission facts not observable from the repository or approved GitHub metadata are `NOT_OBSERVABLE`.

No secret value was read, copied, hashed, or emitted. Provider rows name repository references and metadata surfaces only.

## Source classes and current status

| source class | exact path | exact blob SHA at `staging` | caller / consumer | claimed authority and state writer | target mutation | provider / bypass surface | evidence ceiling | current live status | proposed post-G2 disposition |
|---|---|---|---|---|---|---|---|---|---|
| instruction | `AGENTS.md` | `4f2b314a1862abf61eea06c4b8cc841d5fd87769` | agent process, PR author | release policy and guardrails; no executable writer identified | branch, PR, merge, deploy decisions | GitHub permissions are metadata only | text and blob only | present; enforcement is `NOT_OBSERVABLE` | retained policy material; consumed only through future RMG binding |
| legacy rule | `.agents/rules/task-json-workflow-rules.md` | `299cbbae1325ccd46b4c60ce7fca50543ec5d804` | agent context | `task.json` is described as planning source; tracker writes are prescribed | task status, progress, findings, commits | local filesystem and git | text and blob only | present; legacy authority not disabled | derived historical input; rejected as executable authority |
| legacy workflow | `.agents/workflows/do-next.md` | `38858a31dc4a1761ff2ddc4d443a7fa51fdba0b6` | agent context | selects next task and prescribes edits | task selection and file writes | `./init.sh`, local tools, browser | text and blob only | present; no live freeze | derived-only reference |
| legacy workflow | `.agents/workflows/git-commit.md` | `15eb0f21fbdd3c9477d69acd73f9ba3d34f5f2da` | agent context | prescribes `git add`/commit/push after user confirmation | commit and push | git remote permissions | text and blob only | present; no guard connection established | historical workflow reference |
| legacy workflow | `.agents/workflows/db-migrate.md` | `486fe60bb2c037b9b62e68c8d46ab7d5762c4fbd` | agent context | prescribes database push or migration generation | schema and database mutation | Drizzle/Supabase | text and blob only; no DB execution | present; no migration performed by G1A | rejected as authority; future external mutations need RMG |
| tracker | `task.json` | `16a646de84dfe59564a35ef9e1fe3279d7facfdc` | legacy workflow and agents | task status fields (`passes`, `blocked`, `updated_at`) | task state and selected file set | local filesystem | JSON file, not live writer telemetry | present; not modified | archived/derived input only |
| tracker | `progress.md` | `bdcab1b45e1d6ae75a8e0dea29d84dd519795648` | legacy workflow and agents | execution log and validation notes | progress claims | local filesystem | Markdown text only | present; not modified | historical evidence, never authorization |
| tracker | `findings.md` | `32427edc8994d50198f324c3da5f7e12756da3a1` | legacy workflow and agents | research and risk record | evidence claims and follow-up | local filesystem | Markdown text only | present; not modified | historical evidence, never authorization |
| archive tracker | `task_plan.md` | `66670f570e29d533a8c10f1545a34d0d96548c59` | legacy agents | archived plan | task ordering | local filesystem | Markdown text only | present; explicitly archival | archival reference only |
| bootstrap script | `init.sh` | `f7165e69077bef8038f475e263aba6e2737525f4` | local shell | checks environment and task files; includes dependency install path | local setup and possible dependency installation | `.env*`, pnpm, local server | executable bit and text are observable; side effects are not run | executable file present; not run | non-authoritative setup reference |
| legacy workflow document | `Manus正确工作流程.md` | `8cdd36b32466f2788935e8a766224c79d6865236` | human/agent context | prose workflow authority claim | unspecified repo/external actions | provider references are prose | text only | present; claim is not independently verified | historical reference |
| legacy workflow document | `manus工作流使用说明.md` | `279830310c0e740955ee15a53b688e52273080e4` | human/agent context | prose workflow authority claim | unspecified repo/external actions | provider references are prose | text only | present; claim is not independently verified | historical reference |
| GitHub prompt | `.github/codex/prompts/planner.md` | `9b2b81e5080a7764549c4f36a4f319d66a077c33` | GitHub/Codex workflow context | planner contract and issue prose | issue/task planning | GitHub issue surface | text and blob only | present; no workflow binding proven | derived planning material |
| GitHub prompt | `.github/codex/prompts/generator.md` | `1f70831e8872e0b9fe602e4fbae79bf017e075ec` | generator context | implementation scope | code/test writes | branch and PR permissions | text and blob only | present; no guard proven | future generator input, never receipt |
| GitHub prompt | `.github/codex/prompts/evaluator.md` | `a11247e4e43e4a82aa8bc8b346ae9355ca73750b` | evaluator context | review conclusion | review/status claims | checks and PR comments | text and blob only | present; independentness is NOT_OBSERVABLE | evidence input only |
| GitHub prompt | `.github/codex/prompts/release-auditor.md` | `d86e4f3ed834c4363ab29127e23ce43b452eaabb` | release-auditor context | release readiness claim | merge/deploy recommendation | checks, Vercel metadata | text and blob only | present; no merge authority inferred | evidence input only |
| template | `.github/ISSUE_TEMPLATE/agent-task.yml` | `0f9952e165ec3d412826fe03a5171a0cea54948c` | GitHub issue creation UI | task fields and issue prose | issue creation/state claims | GitHub Issues API | template text only | present; no receipt semantics | non-authoritative input |
| template | `.github/pull_request_template.md` | `6746d01b5d6f9beb73661ebcd97b95ac854583c2` | GitHub PR UI | PR checklist/prose | PR state and review claims | GitHub PR API | template text only | present; Draft/base must be live-verified | non-authoritative input |
| policy script | `.github/scripts/check-workflow-policy.rb` | `d6377e902953a24e30321b311eea3fa08ca4da18` | CI or local caller | workflow policy check | check result | GitHub Actions | script text only; execution not performed | present; enforcement not established | future evidence adapter only |
| test script | `.github/scripts/test-workflow-policy.rb` | `55a9e322660f611076000b0df59d5e51893059dc` | CI or local caller | policy test evidence | check result | GitHub Actions | script text only | present; no live writer | future fixture adapter only |
| workflow | `.github/workflows/ci.yml` | `d6263e8722f64ec53946214a0ca2d655551b28c1` | GitHub Actions | CI checks | status/check-run mutation | GitHub Actions token | workflow text and metadata only | present; requiredness/branch protection NOT_OBSERVABLE here | future RMG-gated check |
| workflow | `.github/workflows/security.yml` | `99c8e32eb8acdae0b5e76f1d7a836bdc07b2b678` | GitHub Actions | security checks | status/check-run mutation | GitHub Actions token | workflow text and metadata only | present; no ruleset proof | future RMG-gated check |
| workflow | `.github/workflows/codeql.yml` | `9fda35079e2cf63d31a1c5d591dfc2fd5e0c62f6` | GitHub Actions | CodeQL check | status/check-run mutation | GitHub Actions token | workflow text and metadata only | present; no merge authority | future evidence adapter |
| product API | `apps/web/src/app/api/trpc/[trpc]/route.ts` | `94d971aee4054445315d544d3adee7c48e8fc5c8` | Next.js request handler | service-role or session Supabase client | application data writes through routers | Vercel runtime, Supabase | source text only; deployed state NOT_OBSERVABLE | present in source; live route not exercised | future mutation entry point, guard-before-mutation |
| product API | `apps/web/src/app/api/stripe/webhook/route.ts` | `31b027acb0ff339fb503692ec97c917e47e94caa` | Stripe webhook handler | fulfillment/reconciliation services | payment orders, subscriptions, credits | Stripe webhook and Supabase | source text only; provider state NOT_OBSERVABLE | present in source; not invoked | external mutation entry point, future RMG binding |
| product API | `apps/web/src/app/api/cron/diagnostics/route.ts` | `e1468bf43a360328f4b13870704d88af551b8e5e` | Vercel Cron route | diagnostics writes/reads as implemented | operational data/log state | Vercel Cron, Supabase | source text only; schedule NOT_OBSERVABLE | present in source; not invoked | scheduled writer requires explicit future binding |
| billing service | `packages/api/src/services/billing.ts` | `4e4312302b624aede040fdb619d0db32c0dede89` | API routers | billing service | credit ledger/payment-related DB mutations | Supabase RPC/client | source text only; DB state NOT_OBSERVABLE | present; no G1A call | future guarded writer |
| entitlement service | `packages/api/src/services/membershipEligibility.ts` | `264a394de531906378b26a464d40293108d0e213` | membership routers | eligibility decision | checkout/subscription mutation decision | Supabase reads and Stripe callers | source text only | present; not an authority receipt | future preflight evidence |
| Stripe client | `packages/api/src/services/stripe.ts` | `5bfc716160bc0a799e60b98dfef0fbb04543013f` | billing/webhook services | provider client | Stripe object reads/writes | Stripe mode/credential metadata | names and code only; no credential value read | present; not invoked | provider identity binding required |
| fulfillment | `packages/api/src/services/stripeFulfillment.ts` | `6b8fd1ce50ef318fd33cb2d417be7450ee482534` | webhook and billing paths | payment/subscription fulfillment | external/payment and DB state | Stripe + Supabase | source only | present; not invoked | future provider-gated writer |
| database schema | `packages/db/schema.ts` | `901c0390de6c51c26c49da004cd7d66369b8fbbb` | Drizzle and tests | schema declaration | database schema generation | Supabase/Postgres | source only; live schema NOT_OBSERVABLE | present; no schema mutation | future migration input |
| migration | `packages/db/migrations/0028_restore_staging_helper_functions.sql` | `342118895f52b61e4e046cef3a17d602d894807a` | migration runner/operator | SQL state writer | database functions/policies | Supabase/Postgres | SQL text only; execution NOT_OBSERVABLE | present; not run | legacy migration input; future RMG gate |
| deployment metadata | `apps/web/vercel.json` | `66de27d77c663cc848af31cba41d28ddb4f369dd` | Vercel build/runtime | deployment config | deployment/runtime behavior | Vercel | repo file only; project settings NOT_OBSERVABLE | present; no deploy run | future deployment evidence only |
| environment reference | `.env.example` | `fb471ea4b4b7eef31dacf7d0be2292373ab4194f` | local setup and validators | variable names/default guidance | runtime provider selection | Vercel/Supabase/Stripe/database | names only; values expressly not read | present; no secret value | metadata reference only |

## GitHub mutation surfaces

GitHub Issues, issue comments, PRs, branches/refs, commits, checks, workflows, permissions and repository settings are externally observable mutation surfaces. The current evidence confirms repository metadata and the receipt-bound refs, but does not prove a ruleset, branch protection, required check, GitHub App, bot, or external writer is active. `admin`, `maintain`, `push`, or workflow-token capability is a bypass surface, not equivalent to an Owner receipt.

The live objects read for this G1A window were repository `1133708061`, Issues `#277/#278/#282/#270/#263/#267/#268`, open PRs, refs `main`/`staging`, comment identities, and exact tree contents. Provider dashboards, Vercel deployments, Supabase state, Stripe state, database state, environment values, and secret values remain `NOT_OBSERVABLE` under this inventory.

## Disposition and limits

- Current live authority is deliberately separated from `proposed_post_g2_disposition`; no disable, neutralization, archive, policy activation, or writer change occurs in G1A.
- The inventory is evidence for the future G2 cutover and does not itself freeze a channel.
- `exactly-one-writer` and `dual_write_allowed=false` are normative future requirements, not current live facts.
- Any source not represented by an exact path/blob or direct GitHub identity is `UNVERIFIED` or `NOT_OBSERVABLE`; prose cannot raise the evidence ceiling.
