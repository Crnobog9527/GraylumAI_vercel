# V3-BILL-2 unified billing service
该脚本已于 2026-09-29 删除（已失效）

Implementation of [the merged BILL-2 specification](../launch/tasks/V3-BILL-2-provider-authoritative-billing.md). This is a server service and an additive migration, with no public route or new screen. Current public chat, workbench, research, Stripe and account lifecycle entrypoints retain their existing contracts.

## Prerequisite and scope

The earlier BILL-1 recovery document records the old test baseline. In the same Owner-authorized task, the Staging reset and subsequent necessary BILL-1 acceptance were completed before BILL-2 implementation: staging `98d3ec454cd4445d4b6598a0745ac8ce63b8f89a`, deployment `dpl_GXgT2jZWoyoeSZGge8bw6hW8CSvh`; two profiles/two opening rows total 200 credits, zero balance discrepancies, existing reconciliation cron completed, unauthenticated request rejected. Baseline timestamp was not changed to obtain a pass. Owner personally confirmed the admin's 100 credits. The independent reviewer confirmed this bounded prerequisite. Supporting task artifacts are in `bill1-clean-baseline-validation/BILL-1-ACCEPTANCE.md`, `live-baseline.json` and `staging-runtime-logs.json` in the Owner's local Codex task directory. These are the prior verified execution evidence, not a claim of a new remote database inspection in BILL-2.

Historical unknown 50 credits and annual test data were discarded under the earlier reset authorization; their cause/cost was not established or reported as recovered. BILL-2 does not repair old bills or declare the complete V3-M3 payment/provider acceptance finished.

Risk: **high** (billing, database schema, function permissions). Migration 0105 is reserved from the verified staging base; no historical migration is edited. No remote migration, configuration change, merge, explicit deployment, real provider call or payment is part of this delivery.

## Versioned server interface

Import `authoritativeBilling` from `@repo/api/services/bill2`. The host supplies a service-role RPC client, an `actor()` resolving a currently verified authenticated identity, and an explicit adapter. The browser must never supply frozen prices, official receipts, a service key or an arbitrary actor. No environment or provider fallback is loaded by this service.

Contract `bill2.v1` exposes `createDraft`, `prepareRun`, `claimCall`, `dispatchOnce`, `recordReceipt`, `closeRun`, `finalizeRun`, `requestCancel`, `readRun`, `readPrivateInput`, `recoverRun`, and prepared-only token rotation. Optional `revokeDraft` closes execution permission. `recordReceipt` and pending transport observations are strictly server-private; a future browser route must not expose their arguments or responses.

- Scope is exactly `{kind:'positioning_draft',draftId}` or `{kind:'work_item',projectId,workItemId}`. Drafts have durable owners. Work items reuse `artifact_projects.work_kind='script'` with the actual `source_project_id` parent; no placeholder parent, round-as-item or balance copy is created. Social sources must satisfy the existing reference permission check. Future account adoption adds source references; it must not transfer or duplicate these immutable run identities.
- A run freezes the complete input and source hash, operation, applicable Skill revision, exchange-rule versions, decimal exchange rate/multiplier/FX rules, approved credit/cost budget, maximum pre-deduction, total deadline, call count and an allowed call-policy array. Each allowed entry names the catalog model UUID, provider/model/account namespace, protocol, maximum input/output capacity, cost upper bound and retry/tool/lookup capability. Caller requests must fit a frozen entry. Multiple explicitly allowed models can share one budget.
- Decimal inputs have at most 12 integer and 12 fractional digits, are nonnegative plain decimal strings, and never pass through JavaScript floating-point money arithmetic. Exponents, negatives, nonfinite values, malformed/duplicate JSON keys and excess precision are rejected. PostgreSQL NUMERIC retains the full FX/product precision; integer credits are `ceil(sum(final USD costs) * creditsPerUsd * multiplier)` once, capped by admission and the existing INTEGER range.
- One run creates exactly one original pre-deduction. One call sequence creates a durable identity and a single-use prepared dispatch capability. Replaying claim returns the existing identity without a token. A prepared process can explicitly rotate that token against the exact frozen payload. The service consumes local possession before awaiting the dispatch transaction, and sends HTTP only after an affirmative response. A lost commit response therefore retains an uncertain dispatch without sending or retrying. This does not promise supplier exactly-once delivery.
- Adapter `fixture-cost-v1` accepts request-total receipts and nonbillable included detail observations. Fusion-like parent totals include their child details; details are never added a second time. Separately observed included details require stable parent-scoped detail IDs; distinct final children are summed and checked against the parent total in either arrival order. Repeated child observations are deduplicated, final child contradictions block settlement, and inline versus separate detail sets are never summed together. Independent paid calls have separate identities and total receipts. Missing IDs/costs remain null; only an explicit final zero is zero. A provider/account/generation identity cannot cover two calls/runs.
- HTTP transport observations are separate from authoritative protocol receipts. Non-2xx responses and interrupted/oversized/binary bodies retain private bounded bytes (base64 for exact reconstruction), a retained-byte hash, HTTP status and completeness; only a complete unambiguous JSON ID is retained for lookup. Their cost is always null and finality false regardless of diagnostic fields. A transport observation neither proves delivery failure nor invalidates an already accepted cost; identity contradictions still block automation. The adapter keeps its five-second/64-KiB limits and never retries.
- Exact same receipt observations replay; equivalent decimal forms do not conflict. A previously missing cost can be supplemented. Contradictory final cost/model/currency/identity or over-budget costs retain immutable observations and block automatic charge. Malformed protocol bodies retain their hash/body and identified provider ID as rejected evidence. Late evidence never changes a terminal charge.
- `closeRun` seals the call set and records private outcome evidence before financial finalization. A confirmed no-delivery failure restores the user according to the original source protection even if the platform's cost remains pending. Unknown delivery is not failure. Cancel after dispatch awaits official incurred costs; cancel before any dispatch releases only what the original source allows. Cancellation never opens a new call.
- `readRun` exposes only status, amount, identity and bounded recovery summaries, with no raw input, result, receipt or capability. Private input/result recovery rechecks ownership and execution permission. Financial finalization/evidence recovery can finish after revocation without re-enabling execution or private content access.
- `recoverRun` uses only captured provider IDs and an explicitly supported lookup protocol: at most three claims per call until 24 hours after the frozen run deadline, with no account enumeration or redispatch. Missing evidence keeps the hold. An adapter response followed by a DB outage returns `pendingReceipt` to the trusted server host for controlled retention and `recordReceipt` replay; this is not a browser recovery token. If that evidence is lost, the service cannot reconstruct it or assume zero.
- If the existing invitation rebate is enabled by a trusted host, supply the existing Supabase client as `rebateClient`; the original idempotent helper uses the original pre-deduction ID and actual final spend. Reserves/releases/refunds do not count as spending or generate rebates.

First-batch `mode='isolated'` and `session_ref IS NULL` are enforced. The only provided transport accepts loopback HTTP and refuses real provider endpoints. Formal Session binding, real provider adapters/protocol verification, public Runtime wiring, business UI and Fusion orchestration belong to subsequent explicitly selected tasks. Their absence is deliberate; the current service cannot be presented as an enabled commercial Agent.

## Money and compatibility

The original `profiles.credits`, `billing_history`, `credit_transactions`, grant source counters, `token_stats` and `ai_usage_logs` remain authoritative. New tables hold run/call/evidence state, not a second balance. New tables have RLS and no direct anon/authenticated/service-role grants; only the explicit trusted RPC allowlist executes. Private compatibility primitives are not executable by service role.

The reserve transaction writes `-R` as a non-spend adjustment. Final settlement calls the preserved source-aware primitive for charge `C` and actual balance restoration `D`; it then writes non-spend release `D+C` and spend `-C`. Refund writes actual `D` only. If original subscription shares are reversed or terminated, intercepted restoration is retained in metadata and never resurrected. New ledger rows receive distinct, increasing timestamps under the existing profile lock, so old timestamp-only pagination cannot skip the paired release/spend rows; historical rows are not rewritten. Every committed balance delta matches the same existing ledger, and spending is counted once. Only ledger snapshot columns widen to BIGINT so the intermediate release-then-spend amount can exceed INT while the actual profile balance and final charge remain valid INTEGER values; historical values and number-mode reads are preserved. The existing reconciliation deliberately still flags genuinely unresolved reservations; a coherent hold is not a completed business operation.

Six legacy terminal entrypoints keep their exact signatures/defaults and reject new pre-deduction IDs before touching money: `atomic_settle`, `atomic_refund`, `atomic_abort_settle`, `atomic_finalize_ai_success`, `atomic_finalize_ai_failure`, `atomic_finalize_ai_abort`. Old in-flight requests continue using their original paths. New finalization locks run, calls/receipts, profile and original grant and atomically writes terminal history, release/spend, canonical usage and run state. Unique indexes forbid multiple terminal projections. Usage absent from supplier evidence remains unknown, not fabricated zero.

Rollback is **code rollback without a down migration**, using the old application ref plus the required two-line finance-reader compatibility patch below. Bare old commits reject new unknown cache usage and are not supported rollback artifacts. Stop wiring new admission at the host, retain 0105 tables/functions and private evidence, allow old callers for old requests, and later resume original run recovery with the same versioned service. Do not drop tables, delete pending rows, reset balances, restore public execution of private primitives, or replace the six wrappers with pre-0105 function bodies. Future source-allocation migrations must preserve this disjoint identity check. No rollback may infer a supplier outcome from a timeout.

## Validation

The original 103-pass BILL2/AI run did not prove all legacy callers on 0105. The follow-up separates schema selection from test selection and adds exact old-runtime archives and actual process switching on one database.

Reproducible isolated command: `node packages/db/tests/v3/run-workbench.mjs --bill2-only`. It copies only indexed repository files to a disposable directory, installs cached dependencies without remote environment files, starts PostgreSQL 17/Auth/PostgREST and a local application/provider fixture, applies full 0105 twice and exercises real RPC/SQL. The injected network guard refuses non-loopback fetch. Source tree digest, environment versions, test output and concurrency backend PIDs are recorded in the printed local evidence directory. All business balances and supplier responses are synthetic; SQL, permissions, constraints, transactions, HTTP and concurrency are real.

The combined suite retains original workbench AI regression tests and adds BILL-2 scope/auth, money/coverage, all old terminal guards, immutable observations, budget, unknown/recovery, two-backend lock barriers, six-write fault injection and subscription source tests. Other workbench categories are explicitly skipped by this scoped command, not reported as passed. Unit/API tests, TypeScript, lint, migration safeguards and required remote CI/Security are separate checks. Exact candidate validation and independent complete base-to-head review are recorded on the implementation PR.

**C layer: NOT_RUN.** No real OpenRouter, Fusion, Stripe payment/refund or supplier-account reconciliation is claimed. Those remain prerequisites for enabling the applicable real adapters later, under separately bounded authorization. This PR does not select V3-RUNTIME or authorize applying 0105 remotely.


Follow-up compatibility commands (all local-only):

- `node packages/db/tests/v3/run-workbench.mjs --bill2-compat-only --with-bill2-schema`: AI/research, money-relevant guided chat/summary, ordinary UI/usage and SDK slice reply/summary/cancel/recovery.
- `node packages/db/tests/v3/run-chat-reliability.mjs --with-bill2-schema`: complete ordinary HTTP recovery suite with narrow billing ACL.
- `node packages/db/tests/v3/run-consumption-protection.mjs --with-bill2-schema`: consumption and permission regressions.
- Add `--legacy-ref=98d3ec454cd4445d4b6598a0745ac8ce63b8f89a` to the first command to run the archived old staging app and services, with its exact lockfile; only test files and documented loopback transport instrumentation come from the candidate.
- `node packages/db/tests/v3/run-workbench.mjs --bill2-upgrade-only --with-bill2-schema --legacy-ref=<exact SHA>`: start archived old code before 0105, create old in-flight pre-deductions through its actual BillingService, apply 0105 twice without recreating DB, finish old requests, start candidate, create new unresolved records, stop that process and boot old code, exercise old requests/readers, assert unchanged new identities/evidence, prove the unpatched finance-reader limitation, restart the explicitly patched rollback bundle and verify mixed finance/history, then return to candidate and recover once. Both the old staging SHA above and main `ecf4c6a347038f9352477a98d4171a8ef00c85de` are tested separately. Main has no SDK slice/durable ordinary request APIs; these are not claimed as main features.

The broad archived old-staging suite retains original application code except local model/search transport substitutions. The upgrade/rollback test first proves the untouched old finance reader rejects the mixed ledger, then adds the already-valid `consumption` and `adjustment` transaction types to its enum and restarts; HTTP 500 remains because `cached_tokens=NULL` is still rejected. It then applies the second and final reader change to that archived runtime and restarts it: `cached_tokens: z.number().finite(),` becomes `cached_tokens: z.number().finite().nullable(),` in `packages/api/src/routers/admin.ts`. The runner records the complete `legacy-reader-compat.patch` and its SHA-256. This is the supported old-ref-plus-patch rollback bundle, not proof that an unmodified old commit is fully compatible. The current candidate includes both decoder changes. The canonical usage row retains official cost and unknown counters, and the finance overview counts the new spend once. Its old catalog-model list does not attribute `bill2.aggregate` costs to an individual model; that list is not a complete supplier-cost report. This endpoint does not aggregate or return cache counters, and the database NULL is preserved. Both normal-user denial and administrator access are tested over actual Auth/HTTP/PostgREST. No fake zero or hidden usage row closes the compatibility gap. In particular, old finalizers reject duplicate direct terminal requests; the test checks that their rejection preserves state rather than inventing an idempotent return contract. Compatibility evidence records the same database OID and old/new pre-deduction/run/call IDs throughout version changes. This is distinct from merely reinstantiating the candidate service.


## 生成前明确拒绝（0164）

仅接收 OpenRouter 完整 HTTP 402 JSON：数字 `error.code=402`，明确
`metadata.limit_source` 为 `openrouter_key_limit`、`openrouter_credits` 或
`openrouter_in_flight_budget`。允许顶层可选 `user_id` 和 metadata 可选 `provider_name`
（仅字符串或 null），其他字段白名单不变；仍需无 usage、cost、输出或已有矛盾回执。
依据：[官方错误语义](https://openrouter.ai/docs/api_reference/errors-and-debugging)、
[额度拒绝来源](https://openrouter.ai/docs/api_reference/limits)。HTTP 200 内嵌错误、
SSE 错误、超时、断线、5xx 与不完整证据仍走原有核实流程，不能视作免费。

无生成 ID：服务端完整响应 → 请求及响应哈希绑定的 `provider_rejection` →
既有 `bill2_record` 验证并保存调用拒绝标志 → 原有取消及 v1/v2 结算。
有生成 ID：严格证明先保存为脱敏 `provider_rejection_pending`，关闭后续调用但保留冻结；
再由原有恢复入口领取并查询，三个不同领取均取得完整 HTTP 404 JSON，才标记本调用拒绝。
这是 [Owner 的业务决定](https://github.com/Crnobog9527/GraylumAI_vercel/pull/627#issuecomment-5980132609)，
不代表服务商保证零费用；若后到实际费用，保留矛盾回执，由平台承担，不重扣用户。

复用原有 3 次总尝试预算和有效期（v1：run deadline + 24h；v2：call 创建 + 24h）。
原领取函数没有间隔保护，0164 在同一函数内仅为严格 402 候选补上数据库时间控制的
5 分钟最小领取间隔；首查可立即进行，第三次判定最早为派发后 10 分钟加响应和落库耗时。
GET 超时仍为 45 秒。没有新调度器或队列；普通恢复仍需既有入口触发，10 分钟不是自动退款时限。
失败、超时、5xx、非终态费用、终态无费用及任何非有效 404 不增加 404 数，仍消耗原尝试额度。
任何费用或终态记录继续走原规则；三次预算耗尽却不足三个有效 404 时，继续待核实。
[生成查询接口](https://openrouter.ai/docs/api/api-reference/generations/get-request-&-usage-metadata-for-a-generation)
的单次 404 不是已确认无计费，不能将缺失成本补成零。

保留 dispatched_at；不伪造生成 ID，不使用整单 confirmed_failure 补偿此前消费。
v1 原整笔预冻结算保留未知兄弟调用的冻结；v2 释放本次调用的预扣。重复/并发回执不重复释放。
Runtime 复用取消同步执行与会话状态；财务 unknown 仍对应执行 cost_pending。
新候选及查询回执仅保留财务投影、原证据哈希、领取序号、累计有效 404 数、数据库领取及
观察时间、HTTP 状态。领取与回执在数据库绑定，不保存错误原文、密钥、私人身份或查询链接。

迁移仅追加文件，核对四个来源函数和自身目标指纹：`bill2_record`、`bill2_recovery_claim`、
v1/v2 finalizer；在已有 call 上增加拒绝标志及最后领取时间，无新表、RPC 或权限。
本地文件建库 runner 连续应用两次。BILL2 core 覆盖 v1/v2 三次 404、最小间隔、费用优先、
失败不计数、已消费/未知前缀、并发领取和回执幂等、删除后的脱敏投影。
Runtime 覆盖真实 adapter/执行器/本地数据库与合成 402、404、费用、终态缺成本、超时、5xx。
全部使用合成值，不代表远端迁移或真实服务商验收。

回滚需另追加迁移恢复来源函数，保留拒绝事实、回执及已完成账目，不重扣已释放积分。
历史冻结需另行逐调用核对并授权处理；本迁移不回填历史，不把此前人工查询计入恢复次数。
