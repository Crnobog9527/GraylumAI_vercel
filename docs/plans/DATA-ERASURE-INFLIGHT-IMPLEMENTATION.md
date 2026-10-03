# DATA-ERASURE 在途收尾实施记录

风险：high。开工 staging `2259e8953bbfc60371ce891e0e847f6b5624c72d`。
依据：[#598](https://github.com/Crnobog9527/GraylumAI_vercel/pull/598) 定稿 `001d8b4450cf8760f3a455f23d663c190ae76780`；
[实施授权](https://github.com/Crnobog9527/GraylumAI_vercel/pull/598#issuecomment-5957866853)。

仅本机一次性环境验证；不应用远程迁移、不调用真实模型、不改外部配置。
保持 draft，CI 后交总控独立审查。迁移暂用 0160，合并前重新核对编号。
不改 execute.ts；executionStream.ts 与 #593 由后合并方同步，保留正常捕获并阻止注销后的捕获。
H1 的 execute.ts/context.ts 由其 writer 负责。PAYG v2 注销谓词归 PR-A，waiting_credits 归 PR-B。

## 必做补充

- 注销谓词同步覆盖 read、close、record、financial_recovery、revoke_unstarted_dispatch 五处。
  v2 未发出 call 撤权释放纳入 PAYG PR-A 联调验收，本次不引入 v2 合同。
- 实际费用未知不当零；actual_fallback 是实际费用已知、tokens 缺失的结算口径，不能标未知；
  v1 名义费用不适用。名义计价仍由 PAYG 实现。

## 方案对应与最小实现

| 定稿章节 | 实施与证据 |
| --- | --- |
| §3.1 窄财务能力 | BILL2 仅在 SQL 成功派发后捕获原 actor/run；业务 prepare/claim/dispatch/private_input 仍验证 Auth。宿主以同一原执行收尾；退出/密码撤销须明确 Auth 拒绝才调用原 runtime_cancel |
| §3.1 SQL | 0160 仅 read/revoke 增 disabled/banned 原绑定窄分支；bill2_actor 不变，其余财务函数不新增 active/派发门槛。read 返回绑定 executionId；receipt_saved 用原 payload_hash 识别投影前回执 |
| §3.2 证据 | 官方响应头/合法首帧可靠 ID 启动一次最小财务观测；不等待数据库才转发帧；最终阶段等待有原生取消界限的写入；后续身份冲突保持冲突且不查询/结算 |
| §3.3 收尾 | 注销事务提交后另做最多 5 秒纯数据库收尾；晚回执宿主独立 finish；SQL 仅在 active_execution 仍指向原执行时清除，包括注销后 cost_pending |
| §3.4 批次 | 现有 billing-reconcile 增 55 秒有界批次；先关闭一页再在锁外查询，保留原两项审计。稳定 run 分页，注销阶段时间轮转；不可推进项不重复领但始终进入未决数/最老时间/原因 |
| §3.5 未知 | 不补造费用或退款，不重新派发，不延长查询期限。原 BILL2 run 可仍显示 dispatched 且 closed=true；execution=cost_pending，实际费用为空，不能将关单当结清 |
| §3.7、4 报表 | BILL2 模型/用途/日期/总计未知为 null，并显示已知部分；关闭不当结清。v1 weighted cost 与 PAYG nominal 分开，后者不适用；actual c 已知且 tokens 缺失不被误判未知 |

AGENTS §5：复用原 run/call/receipt/预扣、cancel/finalize/recovery_claim、注销进度与现有 cron。
新增唯一 service-only 枚举函数只是读取原权威，不加表、列、队列、调度器或新记账系统。
不修改 execute.ts。SQL 恢复不经过 TS 邀请返利，保持不补发返利；不改变三年保留起算规则。

## 必测项与验证边界

| 方案必测组 | 本次覆盖/交接 |
| --- | --- |
| Auth 时序与允许/拒绝 | runtimeActor 的 getUser 途中拒绝；正常/退出/密码撤销/禁用/封禁/注销回执；新业务、跨绑定、未派发伪回执拒绝；SQL anon/authenticated 直接调用拒绝 |
| 八函数原有行为、未发出释放 | SQL disabled/banned 分别回归八财务函数、prepared 取消、可靠未发送撤权、p_inspect 幂等；不把零回执当撤权证明 |
| 无回访/宿主丢失 | 新批次接管：缺 ID 只关闭并报告；有早期 ID 仅 GET 补费；一次消费/释放，无第二次 POST |
| ID/流式/模糊回包 | 首字在慢写完成前发出，帧继续流动；失败和原生取消不留悬空写；先精确 hash 回读，确认缺失才补记；身份冲突拒绝查询和结算 |
| 状态/并发/金额 | prepared、unknown、known、终态账/非终态执行、原指针及新指针；两连接注销/回执、三连接回执/重复恢复；精确金额、退款后晚费用平台承担、一次结算 |
| 查询/预算/公平性 | v1 原 deadline+24h、最多三次；无 ID/不支持/冲突不猜查，原凭据绑定；55 秒批次中 45 秒慢查询至多一次、余量不足零次；失败隔离、稳定分页、未决年龄/原因 |
| 内容/擦除/回退 | 旧 B2a 全部用例复用，原 hash 与投影分开、正文 canary/B1b 屏障；本机浏览器晚回执无后续内容；无数据回退全 catalog 相同，新事实保守拒绝回退 |
| 门禁/返利 | 财务恢复构造器显式 denyNewCalls，无业务 claim；SQL 恢复沿原 finalize 无邀请返利；现有门禁集成继续跑 |
| 报表 | BILL2 卡片与 JSON 的模型、用途、日期、汇总、已知零/未知/不适用；本机 Chromium 禁外网渲染。仓库没有 BILL2 CSV 导出入口。旧 token_stats 历史统计不冒称本次覆盖 |
| v2、waiting_credits | 当前无 v2 合同，NOT_RUN，按 Owner 分工归 #553 PR-A/PR-B；双合同及零 call、已结算前缀、错绑和 call 截止期是启用 v2 前共同验收条件 |
| #593 捕获 | 开工时尚未合并，NOT_RUN 联调；后合并方保留正常 completed 捕获、注销/pending/cost_pending 不捕获并补并发验证 |
| 遗留现场/三年保留 | 未访问远程库，原证据运行单未动。未来部署前总控再次只读快照，同一机制处理；原 v2 测试窗口预算不释放。保留字段/时间权威不变，未来到期物理处置不在本次 |

### 本机实际验证

- PASS：文件建库 162 步、93 次迁移重放、5 个原定义 MD5、防漂移原子拒绝、catalog 幂等、无数据回退/重放、出现财务新事实后拒绝回退、account-open 审计；一次性容器清理通过。
- PASS：`node packages/db/tests/erasure-inflight/run-local.mjs --local-only`，包含旧 B2a 和新增 SQL 允许/拒绝/多连接并发。
- PASS：`node packages/db/tests/run-db-baseline-replay.mjs --local-only --write-built`，built-fingerprint 已更新。
- PASS：BILL2 without-app 文件建库集成 83 项，零跳过。
- PASS：本机浏览器专项 `--runtime-only --with-staging-schema --schema-from-files --case-pattern=^ERASURE_BROWSER:` 1 项；333 项因明确专项筛选未运行，不能算通过；不改变 CI 排除清单。
- PASS：Web 财务卡片 3 项（含本机浏览器）、cron 6 项；API 新增接线和边界单测。
- PASS：API 全套 4084 项、12 项既有跳过；新增跨执行绑定专项 6 项；Runtime without-app 172 项通过，5 项既有浏览器/app用例跳过（本次注销浏览器专项另跑）。API/Web 类型、lint、代码大小通过。
- FAIL：`pnpm test:ci:safeguards` 129 项通过、3 项迁移连续性用例失败；0160 前缺少仍在 #593 的 0159。未修改检查或添加占位迁移。CI 全绿及“可以审查”交付受此依赖阻断。
- 推送前 staging 已推进到 dd1deaaa（#605/#607/#606）；无 SQL/权限规则变化，源 MD5 不变。#606 财务卡片重叠由本次同步后验证。
- NOT_RUN：真实模型、任何远程数据库/迁移、staging/production、PAYG v2、独立审查。独立审查由总控安排。

## 迁移与回退

0160 是暂定编号（0159 由 #593 占用）。基准为开工 staging 的最新文件建库定义，
开头 MD5 同时允许原定义或本迁移定义；任意其他漂移整体拒绝。合并前按最新 staging 核对编号和源定义。
只替换五个原函数和增加一个枚举函数及其 service-only 授权，无表/列变更。

回退材料：`packages/db/tests/erasure-inflight/rollback.sql`，已在一次性库验证。
先停止新增宿主/cron 接线、排空在途；仅保守检查通过且无本次新事实时回旧定义。
已存在 billing_pending 或注销 cost_pending 指针释放等新事实则拒绝结构回退，优先前向修复。
保持账号封闭和财务证据，不反转终态、不恢复正文/token，不释放未知费用预留。
暂停期间继续报告未决积压；此脚本不是远程执行授权。

## 后续同步责任

- PAYG PR-A：原 0156 五处注销谓词（含 revoke），加本次枚举入口的新调用点和 disabled/banned 的 v1 绑定分支。
  必测注销 v2 从未发出 call 的撤权释放、v1/v2 全套绑定/查询期限；PR-B 负责等待积分遇注销。
  名义收费归 #553，报表须区分 nominal / actual_fallback / cost_pending；v1 nominal 不适用。
- #593：executionStream.ts、runtime.integration.ts、测试 runner 与 built fingerprint 重叠，后合并方同步。
- #606：Bill2ModelReportCard.tsx 重叠，后合并方保留未知/已知小计/v1 不适用语义。
- H1 现在为 #610；本次不改 execute.ts/context.ts；共享影响由后合并方回归。

推送前刷新：staging 仍为 `2259e895`；#593 仍 OPEN，head 更新为 `146540098e6aaa410256d1a945aa50358a980a92`；
#610 head `8349f760613c9328a8f4741e86adec17b46e2edd`，当前 diff 仅 H1 handoff 文档，但保留已知后续写入边界；
#608 更新 `ece59f90452aed45286518abc021dd30f9903d65`，仍只 PAY-COMMON 文档，无本次重叠。

## 开工 open PR 完整文件快照

### #609 — `6e1d435517df165482d06bfb3c9823e3986443d5`

- `apps/web/src/app/admin/settings/membership.browser.test.tsx`
- `apps/web/src/app/admin/settings/page.tsx`
- `apps/web/src/components/admin/AdminGuard.test.tsx`
- `apps/web/src/components/admin/FusionCompareSetting.tsx`
- `apps/web/src/components/admin/MembershipPlanPermissions.tsx`
- `apps/web/src/components/admin/membershipEntitlementDraft.test.ts`
- `apps/web/src/components/admin/membershipEntitlementDraft.ts`
- `scripts/code-size-baseline.json`

### #608 — `d69883fab1f08f4ff55b2e4c0662528f23a7800e`

- `docs/launch/tasks/PAY-COMMON.md`

### #607 — `a1f808434c2433897cace32e2eed155a012bd3f1`

- `docs/PROJECT_MAP_FOR_OWNER.md`
- `packages/api/src/services/__tests__/promptCache.test.ts`
- `packages/api/src/services/diagnostics.ts`
- `packages/api/src/services/diagnosticsCoverage.test.ts`
- `packages/api/src/services/promptCache.ts`

### #606 — `dff1bf0748c586c628aa5f6699f7fa340285ae47`

- `apps/web/src/app/admin/models/page.test.tsx`
- `apps/web/src/app/profile/page.test.tsx`
- `apps/web/src/app/profile/page.tsx`
- `apps/web/src/components/admin/Bill2ModelReportCard.tsx`
- `apps/web/src/components/admin/ModelEditPriceSection.test.tsx`
- `apps/web/src/components/admin/ModelEditPriceSection.tsx`
- `apps/web/src/components/admin/ModelMultiplierPanel.tsx`
- `apps/web/src/components/admin/ModelReasoningDialog.tsx`
- `apps/web/src/components/admin/ProviderPricesEditor.tsx`
- `apps/web/src/components/admin/adminSmallFixes.browser.test.tsx`
- `apps/web/src/components/admin/modelReportPricing.ts`
- `apps/web/src/components/admin/useModelCatalogRefresh.ts`
- `apps/web/src/components/profile/CreditRecordsCard.tsx`
- `apps/web/src/components/profile/PersonalInfoCard.tsx`
- `apps/web/src/components/profile/SubscriptionCard.tsx`
- `apps/web/src/components/profile/SummaryRetry.test.tsx`
- `apps/web/src/components/profile/SummaryRetry.tsx`
- `apps/web/src/components/profile/creditsSummaryQuery.test.ts`
- `apps/web/src/components/profile/creditsSummaryQuery.ts`
- `apps/web/src/lib/safe-error-message.test.ts`
- `apps/web/src/lib/safe-error-message.ts`

### #605 — `2166f0ef3602fa21c3e988b44944e4efb1b03de3`

- `docs/DEPLOYMENT.md`
- `docs/STRIPE_ENABLEMENT_CHECKLIST.md`
- `docs/billing/BILLING_ENGINE_EXECUTION_LOG.md`
- `docs/launch/AGENT_TURN_ENABLE_PLAN.md`
- `docs/runbooks/ADMIN_OPERATIONS.md`
- `docs/runbooks/STAGING_REPRODUCIBILITY.md`

### #604 — `dbdc55b60ea1b3acf8e4854a9459cd05ce5b97f4`

- `docs/launch/CHAT_NATIVE_OUTPUT_PLAN.md`

### #603 — `6a0974bac436981fe89ba90de6cd254c520aa2ff`

- `packages/api/eslint-suppressions.json`
- `packages/api/src/services/__tests__/fixtures/schemaSnapshot.ts`
- `packages/api/src/services/opc/opc.integration.ts`
- `packages/db/tests/v3/run-workbench.mjs`

### #602 — `86185a47ab7a05097865a2b7ec2ba001abbdcb6b`

- `packages/api/src/services/opc/opc.integration.ts`

### #601 — `4c0c52a78b5a838313b1b3735fe945d09944aeae`

- `docs/launch/PROMPT_CACHE_HISTORY_PLAN.md`

### #598 — `001d8b4450cf8760f3a455f23d663c190ae76780`

- `docs/plans/DATA-ERASURE-INFLIGHT-RECOVERY.md`

### #593 — `fd210532e83c3299067ce2064bff4d2879a1f48b`

- `docs/launch/rollback/CONVERSATION_CAPTURE_B1.sql`
- `packages/api/src/routers/opc.ts`
- `packages/api/src/routers/stagingAdmission.test.ts`
- `packages/api/src/services/opc/agentTurnPromptCapacity.test.ts`
- `packages/api/src/services/opc/capture.integration.ts`
- `packages/api/src/services/opc/capture.test.ts`
- `packages/api/src/services/opc/capture.ts`
- `packages/api/src/services/opc/information.ts`
- `packages/api/src/services/opc/organizerPrompt.test.ts`
- `packages/api/src/services/opc/service.ts`
- `packages/api/src/services/runtime/executionStream.ts`
- `packages/api/src/services/runtime/runtime.integration.ts`
- `packages/api/src/services/runtime/timing.test.ts`
- `packages/api/src/services/runtime/timing.ts`
- `packages/db/migrations/0159_opc_capture.sql`
- `packages/db/tests/baseline/built-fingerprint.json`
- `packages/db/tests/v3/run-workbench.mjs`
- `packages/db/tests/v3/without-app.mjs`
- `scripts/code-size-baseline.json`
- `scripts/tests/integration-without-app.test.mjs`

### #553 — `135d4c197a630e613ea692c0fe9742079e295869`

- 无文件差异（方案见 PR 描述）。

### #547 — `8fb950af3a95e1d40f3053f1b76c1bbea7486bcd`

- 无文件差异（方案见 PR 描述）。

