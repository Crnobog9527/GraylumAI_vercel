# LEGACY-CLOSE 遗留清理：摸底结论与删除方案（仅方案）

> 2026-10-13，依据 staging `151d1197`（含 #898 删旧对话代码、#904 删旧 /workbench 生成和自研内容检查）只读摸底。
> 本文只给结论和证据，不删任何东西；删除按第 6 节拆成后续 PR，碰计费和数据的一律按 high 处理。
> 没有查询任何数据库（staging / 正式库的行数都未知），SQL 结论来自迁移文件；限制见第 7 节。

## 1. 一页结论（大白话）

- **旧的"预扣积分"TypeScript 代码可以整个删掉**：`services/billing.ts` 已经没有任何线上调用方，新的计费（BILL2 / 边用边扣）不用它。
- **但它底下的 SQL 有一半还在用，不能删**：新计费冻结和结算积分时，仍然调用 `atomic_pre_deduct`、`bill2_legacy_settle`、`bill2_legacy_refund`，研究计费还调用 `atomic_settle`、`atomic_refund`；`billing_history` 里的 `pre_deduct/settle/refund` 记录也还在写。只删只服务旧对话的那几个"结算外壳"。
- **后台设置里 4 个旧预扣参数可以删**（最小/最大预扣、安全系数、必须配置价格）；"积分/美元换算"和"加价倍数"两个还在用，保留。
- **安全检查里的两个输出检查函数可以删**；这个文件本身保留（输入检查和上传限流还在用）。
- **旧对话的表**：大部分还被注销流程、对账、后台统计或活着的 SQL 引用，**现在不能删**。确定可删的只有 4 张没人读写的表（需要迁移，并同时改注销函数）；另有几张表因为还挂在活着的 SQL 链上，标"待定"。

## 2. 旧预扣 TypeScript 代码

| 对象 | 线上调用方 | 结论 | 证据 |
|---|---|---|---|
| `packages/api/src/services/billing.ts` 整个文件（`BillingService` 及 `preDeduct/settle/refund/settleAbort/finalizeAISuccess/finalizeAIFailure/recordTokenStats/recordUsageLog`、`getModelPricing`、`getBillingRuntimeSettings`、`calculateTokenCost(WithPricing)`、`estimatePreDeductCredits`、`estimateRequestCost`、`ModelPricingUnavailableError`、`DEFAULT_BILLING_RUNTIME_SETTINGS` 及其接口） | 无 | **删** | 全仓除 `billing.ts` 自己和两个测试外没有引用；唯一入口是 `services/index.ts:16` 的整体导出，而导入这个入口的 3 个 cron 路由只取 `logger / startScheduledJobRun / TicketAutoCloseService`。`/api/ai/stream` 和 `routers/ai.ts` 已由 #898 删除。BILL2/PAYG/报告/工作台/定位用的是 `shared/nominalPricing`、`shared/modelPricing`、`billingUnit.ts`，不碰 `billing.ts`。`bill2/upgrade.integration.ts` 和 `runtime/upgrade.integration.ts` 从旧版本目录加载它，不受影响 |
| 测试 `services/__tests__/billing.test.ts`、`billing.security.test.ts` | 只测上面的文件 | **删**（随文件） | |
| `services/index.ts:16` 的 `export * from './billing'`、`packages/api/package.json:23` 的子路径导出 | 无使用者 | **删** | |
| `lib/logger.ts` 里的 `logger.billing.preDeduct/settle/refund/insufficient` | 只被 `billing.ts` 调用 | **删** | |
| `invitationRebate.applyInvitationRebateForSpend` | `bill2/service.ts:129,134` | **留** | 新计费在用 |
| `types/billing.ts` 的 `BILLING_CONSTANTS.CREDITS_PER_USD / TOKEN_PRICE_MULTIPLIER` | `billingUnit.ts`、`routers/admin.ts:2356-2357` | **留** | |
| `types/billing.ts` 的 `MIN_PRE_DEDUCT/MAX_PRE_DEDUCT/SAFETY_MARGIN`、预扣相关 zod schema 和 `IBillingService` 接口 | 看起来只服务 `billing.ts` | **待定** | 删除 PR 里逐个用类型检查确认 |
| `PRE_DEDUCT/ABORT_SETTLE` 等操作类型枚举 | 历史和新计费数据仍用这些类型 | **留** | |
| `eslint-suppressions.json:342`、`code-size-baseline.json:79` 里 `billing.ts` 的条目 | — | **删**（随文件，只减不增） | |

## 3. `billing_*` 后台设置

| 设置键 | 线上读取方 | 结论 |
|---|---|---|
| `billing_min_pre_deduct`、`billing_max_pre_deduct`、`billing_safety_margin`、`billing_require_model_pricing` | 只有 `billing.ts`（无线上调用） | **删**：admin 设置页 `apps/web/src/app/admin/settings/page.tsx` 的字段和分组、`packages/db/seeds/staging_non_secret_baseline.sql` 的种子行。保存走通用接口，不用改路由。数据库里已有的这几行可以留着不管（没人读） |
| `billing_credits_per_usd`、`billing_token_price_multiplier` | `billingUnit.ts:19-20`、`routers/admin.ts`、`routers/settings.ts` 校验 | **留** |
| `billing_payg_start_thresholds`、`billing_platform_absorb_alert/ack` | BILL2 | **留**（不是预扣） |
| 0188 注销白名单里的 `minPreDeduct/maxPreDeduct/safetyMargin/requireModelPricing` | 历史账本记录的元数据仍有这些字段 | **留** |

## 4. 安全检查 `middleware/securityChecks.ts`

| 导出 | 线上调用方 | 结论 |
|---|---|---|
| `checkOutputSecurity` | 无（只有 `securityChecks.test.ts` 在测） | **删**，连同它独用的 `SENSITIVE_OUTPUT_PATTERNS / maskSensitiveValue / sanitizeSensitiveMatch`、默认导出里的键、测试里的 "Output Security Tests" 段 |
| `sanitizeOutputSecurity` | 无（测试也不用） | **删** |
| `checkInputSecurity` | `services/artifacts/chat.ts:197` | **留** |
| `checkRateLimitAsync` | 资料库上传 `library/service.ts`、`library/extractedUpload.ts` | **留** |
| `preAICallSecurityChecks`、`getUserBalance`、`checkUserStatus`、`checkConsumptionCircuitBreaker`、`assertAIConsumptionAllowed` | 只在模块内部互相调用 + 测试 | **待定**：整条"调用 AI 前检查"链看起来已无线上调用方，但它包含熔断（消费保护）逻辑，删除前要确认新计费已有同等保护（停损、限流），属于计费保护，单独评估 |
| `generateSignature`、`verifyTimestamp`、`verifyRequestSignature`、`checkRequestSignature`、同步版 `checkRateLimit`、对 `getRateLimiter/checkRedisRateLimit*` 的转出 | 无 | **待定**：不在本次范围，记入后续 |
| `aiOutputFilter.ts`、`contentModerator.ts`、`streamingOutput.ts` | — | 已不存在（#904 / #898 已删） |

## 5. 只服务旧对话的表和 SQL

### 5.1 SQL 函数

| 函数 | 现在谁在调用 | 结论 | 需要迁移 |
|---|---|---|---|
| `atomic_pre_deduct` | `bill2_prepare`、`bill2_payg_claim`（新计费冻结积分） | **留** | — |
| `bill2_legacy_settle`、`bill2_legacy_refund` | `bill2_finalize`、`bill2_payg_finalize` | **留** | — |
| `atomic_settle`、`atomic_refund`（外壳） | `research_user_charge`（0071，研究计费，`research/store.ts:49` 在用） | **留**（注意：只看 TS 会误判为可删） | — |
| `atomic_finalize_ai_success/_failure/_abort`、`atomic_abort_settle`（外壳，最新在 0162） | 当前代码里只有 `billing.ts`（无线上调用）和没人调用的 `ordinary_chat_transition`；但它们是旧代码预扣的**唯一结算路径**，`bill2/upgrade.integration.ts` 专门验证"旧代码 + 新结构"下用它们结清旧预扣 | **有条件删**（见下方"兼容窗口"） | 是 |
| `bill2_legacy_finalize_success/_failure/_abort`、`bill2_legacy_abort_settle` | 只被上面 4 个外壳调用 | **有条件删**（同上） | 是 |
| `ordinary_chat_claim`、`ordinary_chat_transition` | 无 | **删** | 是 |
| `ordinary_chat_delete_guard`（对话删除触发器） | 触发器仍挂在 `conversations` 上 | **随 `ordinary_chat_requests` 表一起删** | 是 |
| `agent_slice_*` 中已无调用方的一批（`admit / admission_replay / begin / open / call / record_final / result / conversation / context / selected_source / link / link_read / continue_work / sources / targets / freeze_discussion / stamp_dispatch / preferences_valid / assert_legacy_generation`，及重命名留下的 `*_before_*` 副本）、`agent_preference` | 无 | **有条件删**：其中 `agent_slice_call` / `_record_final` / `_result` 是切片预扣的结算路径（0085），按下方「结算路径门槛」 | 是 |
| `agent_slice_evidence_allowed`、`artifact_evidence_allowed_before_slice` | 活着：`opc_source_allowed`、`runtime_workspace_tool_guard` → `artifact_evidence_allowed` 链 | **留**（要删得先改这条链，见 5.2） | — |
| 旧工作台：`artifact_generation`（及 `_before_slice_boundary`）、`artifact_observe_generation`、`artifact_reject_generation`、`artifact_generation_inputs_current`、`artifact_create_work`（及 `_before_slice_revision`）、`artifact_reference_choices` | 无线上调用（TS 调用方已由 #904 删除；`reuse.ts` 只被集成测试引用） | **有条件删**：`artifact_generation`、`artifact_reject_generation` 是旧工作台预扣的结算/退款路径（0068/0077/0101），按下方「结算路径门槛」 | 是 |
| `artifact_generation_public`、`artifact_generation_basis` | `artifact_query`（活着） | **留** | — |
| `artifact_chat`、`artifact_chat_binding` | `chat.getConversations` → 技能对话统计（个人中心用量卡片） | **留**（写入已死，读取还活着） | — |
| `soft_delete_conversation`（0147） | 只有集成测试 | **删** | 是 |
| `purge_deleted_records`（0196/0197） | 没有调用方（pg_cron 已在 0148 移除） | **待定**：它是数据保留任务，不是旧对话专用，需单独决定 |

**结算路径门槛（审查 P1，适用于所有"某类预扣唯一结算/退款路径"的函数和表）**：删除前必须只读确认该类预扣全部已结清（settle）或退款（refund），否则留到下一轮或先迁移到等价的恢复路径。涉及三类：
- 旧代码预扣：见下方"兼容窗口"；
- 切片预扣：`agent_slice_calls` 中状态为 `prepared / dispatched / unknown / responded`（未到终态）的行数为 0，且它们的 `pre_deduct_id` 在 `billing_history` 里都有对应的 `settle` 或 `refund`；
- 旧工作台预扣：`artifact_generations` 中状态为 `prepared / dispatched / responded / unknown`（未到终态 `succeeded / refunded`）的行数为 0，且其 `pre_deduct_id` 都已结清或退款。
任一类不满足，对应的函数（和 `agent_slice_calls` 表）从 PR-B / PR-C 移到"待定"。

**兼容窗口（审查 P1）**：上面 8 个旧结算函数是旧部署发起的预扣唯一能结清的路径。只有同时满足以下条件才删，否则留到下一轮：
1. 所有环境都不再运行旧版本代码（旧对话入口 #898 已删，部署已全部切到新代码）；
2. 只读确认没有未结清的旧预扣：`billing_history` 里 `operation_type='pre_deduct'`、不属于任何 `bill2_runs`、也没有对应 `settle/refund` 的记录为 0（staging 和正式库分别查；正式库只读查询也要按 AGENTS.md 第 1 节先批准）；
3. `bill2/upgrade.integration.ts`（旧代码→新结构的兼容验证，不在 CI 必需检查里，只在 `--bill2-upgrade-only` 下运行）随之退役或改为验证"无未结旧预扣"，并在 PR 里说明理由，不能悄悄删。
任一条件不满足，就把这 8 个函数从 PR-B 移到"待定"。

额外要改：`scripts/check-staging-db-readiness.mjs` 的必需函数清单里有 `atomic_finalize_ai_*`、`atomic_abort_settle`；0162 对 `atomic_pre_deduct` 和全部 `bill2_legacy_*` 有源码 md5 固定检查、0204 按名字重写这 7 个函数——删除迁移必须排在 0204 之后，且不能让历史迁移重放失败。

### 5.2 表

| 表 | 谁还在读写 | 结论 | 需要迁移 / 连带改动 |
|---|---|---|---|
| `ordinary_chat_requests` | 无代码读写；注销流程 5 个函数引用（`account_erasure_body_remaining/_financial_proof/_prune_business/_scrub_runtime`、`erasure_business_owner`） | **删** | 迁移：删表、3 个函数、`conversations` 上的触发器；同时改上面 5 个注销函数、`accountErasure/processorContracts.ts`、注销数据库测试、指纹。删前在 staging 只读确认没有未结的旧预扣（`pre_deduct_id` 仍冻结） |
| `conversation_context_snapshots` | 只有注销函数和 `content_erasure_confirm` | **删** | 迁移：删表；改注销函数、`schema.ts`、`processorContracts.ts`、测试、指纹 |
| `agent_confirmed_preferences`、`agent_preference_requests` | 只有 `account_erasure_scrub_content` | **删** | 迁移：删表和 2 个函数；改 `scrub_content`、`processorContracts.ts`、指纹 |
| `agent_slice_calls` | 只被已死的 slice 函数和 `account_erasure_financial_proof` 引用 | **有条件删**（随 slice 函数，按「结算路径门槛」） | 迁移；改 `financial_proof`（它是财务证据函数，按 high 审） |
| `agent_slice_executions` | 活着：`artifact_save_candidate_before_opc`（经 `artifact_save_candidate` 被工作台执行调用）把它当守卫检查；注销函数多处 | **待定** | 先改写那条活着的守卫，再删 |
| `agent_slice_links`、`agent_slice_pairs` | 活着：`artifact_evidence_allowed` 链（`opc_source_allowed`、`runtime_workspace_tool_guard`） | **留（暂时）** | 先从链上去掉 slice 分支才能删 |
| `artifact_chats`、`artifact_chat_turns`、`artifact_chat_summaries` | 写入已死；`chat.getConversations` 的统计在读 | **待定** | 先去掉个人中心的技能对话统计，再删表和 conversations/messages 上的 3 个守卫触发器 |
| `artifact_generations` | 活着：`artifact_query` 嵌入它；`token_stats`、`ai_usage_logs` 有外键指向它 | **留** | — |
| `conversations`、`messages` | 活着：个人中心用量、后台统计/财务/性能、`admin_delete_unused_model`；`token_stats`、`ai_usage_logs` 有外键和检查约束 | **留**（只读历史）| — |
| `token_stats`、`ai_usage_logs`、`billing_history`、`credit_transactions` | 新计费在写，对账/后台/注销在读 | **留** | — |
| `prompts` | 没有代码读写，但 `admin_delete_unused_model` 会检查 | **待定**：不是明确的旧对话专用 | |
| `research_*`、`runtime_*` | 活着 | **留**（不是旧对象） | |

## 6. 删除 PR 怎么拆（方案合并后按顺序开）

1. **PR-A（high，无迁移）**：删 `services/billing.ts` 和两个测试、整体导出、`package.json` 子路径、`logger.billing.*`、相关 ESLint/大小基线条目；删 4 个旧预扣设置（后台页面 + staging 种子）；删 `checkOutputSecurity` / `sanitizeOutputSecurity` 及独用辅助函数和测试。`types/billing.ts` 里只服务旧预扣的类型在这个 PR 里逐个确认后删。
2. **PR-B（high，迁移 0240）**：删第 5.1 节标"删"的 SQL 函数（`ordinary_chat_claim/transition`、`agent_preference`、`soft_delete_conversation` 等无结算职责的死函数）；标"有条件删"的（8 个旧结算函数、切片结算函数、旧工作台生成/退款函数）只在对应门槛满足时才一起删，否则留下；同步改 `check-staging-db-readiness.mjs`；确认 0162 的 md5 固定检查和 0204 重写不受影响；空库建库 + 重放 + 指纹。
3. **PR-C（high，迁移，编号再申请）**：删第 5.2 节标"删"的 4 张表（`ordinary_chat_requests`、`conversation_context_snapshots`、`agent_confirmed_preferences`、`agent_preference_requests`）和 `agent_slice_calls`，同时改所有引用它们的注销函数（含财务证据函数）、`processorContracts.ts`、`schema.ts` 和注销数据库测试。上 staging 前先只读确认这些表的行数，以及"结算路径门槛"里的切片预扣全部到终态并已结清/退款；staging 的旧测试数据随删表丢弃（正式环境上线前清空，按第 1 节规则单独批准）。
4. **待定项**（`agent_slice_executions/links/pairs`、`artifact_chat*`、`prompts`、`purge_deleted_records`、`preAICallSecurityChecks` 一整条链、签名函数）：记入后续，每项需要先改一条活着的链或做产品/保护层面的确认，不在本轮删除。

## 7. 没验证的 / 限制

- 没有查询 staging 或正式库：行数、是否有未结旧预扣都未知（PR-C 前要只读确认）。
- SQL 调用关系来自迁移文件解析。以下函数是用 `EXECUTE overlay(pg_get_functiondef…)` 原地改写的，解析看不到最终函数体，删除 PR 里要逐个人工核对：`artifact_chat`（0201）、`account_erasure_scrub_content`（0150/0200）、`account_erasure_financial_proof`（0195）、`account_erasure_local_cleanup`（0192/0197/0200）、`purge_deleted_records`（0197）、`content_erasure_scope`（0218）、`opc_free_conversations`（0201）。
- 每个删除 PR 都会再用空库建库、类型检查和全仓搜索复核一遍，不只依赖本文。

## 8. 发现的问题（不在本次范围）

- `docs/ENGINEERING.md` 第 6 节仍提到已删的旧文件（`routers/ai.ts`、`app/api/ai/stream`、`services/modelRouter.ts`、`services/contextManager.ts`）。改它属于规则文件变更，由总控统一请 Owner 批。
- `securityChecks.ts` 的熔断检查 `checkConsumptionCircuitBreaker` 读 `billing_history`，但已无线上调用方——新计费是否已有等价的消费熔断，需要在评估第 4 节待定项时确认。
