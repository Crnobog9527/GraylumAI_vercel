# F-Node C：Node 端旧执行路径删除（说明文件）

任务：CORE-PATH-V2 V2-12 批次 F 的 Node 一侧（`packages/api` 旧路径和 web 公共旧库）。基于 #1656（N1a：`realHost` / `paygPricing` /
`defaultModel` 搬出 `services/runtime`）。**合并要等 A、B 先合、第十二轮验收结束；web 一侧还有一步收尾见第 5 节。**

## 1. 删了什么

| 范围 | 内容 |
|---|---|
| 目录 | `services/runtime/**`（154 个文件，含全部旧执行器、准入、历史选择、恢复、PAYG 暂停续写、旧集成套件）、`services/bill2/**` |
| 评审团/对比旧 Node | `fusion/admission.ts`、`fusion/executor.ts`、`fusion/reviewPlan.ts`；`fusion/review.ts` 只留读取、事件、详情和采纳（去掉 estimate/start/continue/dispatch/rejudge/replayStart）；`fusion/reviewCore.ts` 去掉 `rejudge`/`judgeText`；`fusion/reviewLimits.ts` 去掉 `memberCaps`；`fusion/compareAdmission.ts` 去掉 `admitCompareGroup`、`replayCompareGroup`、`buildCompareColumns`、`overCompareBudget`（回合路径用 `turn/compareQuote.ts` 自己的计价，这几个只剩注释引用） |
| 路由 | `runtime.prepare / executeStream / resume / resumeStream / cancel`；`opc.prepareStep / mentorTurnStream / topicTurn`；`opc.saveWorkResult` 的 `executionId` 旧分支；`runtime.view` 收窄成只返回 `{sessionId, scope, legacy, mode}` |
| 服务 | `opc/service.ts` 的 `prepareStep`、`prepareTopicTurn`、`topicBind`、`resumeWaitingOrganizer` 参数；`report/service.ts` 的整个 `reportService`（旧报告启动/查询/状态），只留 `reportEnabled`、`reportError`、`reportCodes`；`opc/captureReplay.ts`、`opc/questions.ts`、`opc/stepOutput.ts`、`artifacts/reuse.ts` |
| web | `trpc/link-routing.ts`、`trpc/provider.tsx`、`app/api/trpc/[trpc]/route.ts`：现在没有任何流式 tRPC 过程，去掉 `STREAMED` 名单、`stream` 链路分支和 `timing.retain` |
| 配置 | `packages/api/package.json` 的 `automaticRecovery` 导出、`tsconfig.json` / `type-check-baseline.json` 里的旧集成文件、`apps/web/tsconfig.json` 的 runtime/bill2 include、`eslint-suppressions.json`（`--prune-suppressions`）、`scripts/code-size-baseline.json`（`--update`，只下调）、`packages/db/tests/v3/without-app.mjs`（CI 强制的 runtime 套件清单只留 turn 下四个文件，去掉已删文件、三条随旧套件的排除项和 `cdc` 套件）、`run-workbench.mjs`（去掉 `--cdc-b2-eval`、`--runtime-upgrade-only` 改为明确报错、去掉 erasureBrowser 引用） |

## 1b. 追加三项（总控 11-03，见 f-node-drop-check.md）

- `bill2PlatformAlerts.ts`：rpc 改为 `turn_platform_absorb_report(p_from,p_to)`（#1661），字段形状不变，告警保留。
- 删后台旧计费复核入口：`routers/billingReport.ts` 的 `meteringReviewSnapshot`/`reviewMetering`、`turn/settings/meteringReview.ts`、其路由测试和 `packages/db/tests/payg/metering-review.mjs`（含 `run-runtime.mjs` 的调用）。
- 删陈旧已扣费回合补偿：`turn/settings/staleChargedRounds.ts`（含测试和 package.json 导出）；定时段在 cron 里早已移除，没有调用方。
- `runtime_library_propagate`：`library/cleanup.ts` 不再调用，返回值去掉 `references`。
- `runtimeLocalEndpoint` 并入 `stagingEnvironment.ts`（环境以参数传入，避免新增直读 process.env 的文件）。
- **没做**：`turn/provider/service.ts` 的 `authoritativeBilling`（bill2_* 分支）。它现在只剩测试和 `billing.integration.ts` 在用，但 CI 的 `--bill2-core-only` 步骤（ci.yml、`test-ci-workflows.rb`、`without-app.mjs` 的 bill2 套件）还在跑它；删它必须同时去掉这个 CI 步骤，属于改 CI，要 Owner 同意。其余文件只引用它的类型（`frozenRun`）不受影响。

## 2. 新增（为了让保留的路由不再依赖旧目录）

- `services/opc/runtimeStart.ts`：`runtime.start` 原来经 `runtimeAdmissionService().start`，这里只剩 `runtime_start` 一次 RPC，错误映射与原来一致（已归档、绑定拒绝、SQL 拒绝、其它按运维故障）。
- `services/opc/runtimeSessionScope.ts`：`runtime.view` 的新实现，调用 `runtime_session_scope(p_actor_id, p_session_id)`，返回 `{sessionId, scope, legacy}`。**这个数据库函数目前不存在**，见第 4 节。
- `services/turn/settings/localEndpoint.ts`：原 `runtimeLocalEndpoint()` 原样搬出。
- `services/fusion/derivedUuid.ts`：原 `admission.ts` 里的 `derivedUuid`（评审采纳还在用）。

## 3. 旧场景 → 新测试

不放宽任何检查；删掉的用例要么随旧代码走，要么有下面的等价测试。**标“无”的是没有等价测试的，已写在第 6 节。**

| 旧场景（文件） | 新测试 |
|---|---|
| `captureAdmission.test.ts`：确认门禁（继续/下一步/没问题/好的…不算确认）、冻结步骤有效性、步骤摘要冻结缺失字段、清单事件不带用户发言、答案卡选项成为用户原话 | 新 `turn/mentorHostTurn.test.ts`（同样的断言，走 `mentorState/mentorHost/mentorOrganizerInput/mentorSystem`）；格式错误的宿主事件另有 `turn/mentorInput.test.ts` |
| `captureAdmission.test.ts`：服务器决定焦点、开场归一、B2 回放/旧回放恢复任务、未知字段拒绝 | 焦点选择：`opc/captureContext.test.ts`（选必填缺口→未确认字段→最后字段）；回放身份由回合请求 id 决定，见 `turn/mentor.integration.ts`（数据库用例）。开场归一/旧回放恢复随旧准入删除，无新对应（回合路径没有“任务名”） |
| `captureAdmission.test.ts`：RT-3b 检查过的刷新授权（冻结进宿主上下文、不进回放身份、研究关闭时拒绝、step/plan 不许带） | `opc/researchRefresh.test.ts`（保留）；回合路径入口检查见 `turn/mentor.ts`。准入顺序类断言（“在任何工作之前拒绝”）随旧准入删除，无新对应 |
| `existingPositioningAdmission.test.ts`（4 项） | 新 `turn/mentorExistingPositioning.test.ts`（3 项：手动开场只冻结导入引导、普通开场不变、已有材料不重启导入引导）；“回放先于新开场”随旧准入删除 |
| `agentTurnPromptCapacity.test.ts`（六步方法最后一步的宿主容量） | 新 `turn/mentorHostTurn.test.ts` 末尾 8 项（宿主 ≤16000 字节、整理输入 ≤24000 字符，开场/非开场 × 四种状态）；旧的“指令 ≤8000 字符”是旧准入的上限，回合路径没有这个上限 |
| `organizerPrompt.test.ts`：整理输入冻结“已有目标”和跑题回答 | 同一用例改走 `mentorState/mentorHost/mentorOrganizerInput` |
| `captureCapacity.test.ts` 第一项（旧历史选择 `selectBlockHistory` 的容量对比 + 快照） | 无（旧历史选择只在旧路径）；第二项（整理输入上限）保留 |
| `fusion/review.test.ts`（73 处类型错误，旧流程 start/continue/dispatch） | 同一文件：保留共享决策逻辑的 24 项并新增 1 项（`fitsWhenSent`）（辩论轮、逐条回应、采纳 6 项、裁剪、部分评审团、无变化、revision_failed、REPORT-VISUAL、长度限制…），用文件内“仅测试用”驱动跑；删除的见下 |
| 〃 估价/固定价/acceptedCredits | `turn/jury.test.ts`：jury frozen price、jury estimate quotes |
| 〃 重试 start 返回已有评审 | `turn/jury.test.ts`：a repeat of the request finds its review |
| 〃 价格上涨/设置变化/席位超额 | `turn/jury.test.ts`：a price changed since the start、a switch turned off…、a seat above its frozen cap |
| 〃 已结束评审不再 claim | `turn/jury.test.ts`：an ended review… is not advanced |
| 〃 报告过大不许发 | 新增 `review.test.ts`：a report too large for one call does not fit（直接测 `fitsWhenSent`）。**开轮时调用它的接线（jury.ts 第 191 行）没有用例** |
| 〃 崩溃后重判已存回答、旧归档重判 | 无（`fusion_call_verdict` 只有旧 rejudge 用；回合路径在调用里就给出判定） |
| `fusion/compareAdmission.test.ts`：对比实时规则、报价覆盖 | 保留这两组；列定价/预算 → `turn/compareQuote.test.ts`；分组准入（`fusion_group_admit`）随旧对比删除 |
| `fusion/production.test.ts`：生产主机冻结评审团运行 | 面板模型按生产档案准入保留；“把每个运行冻结为生产 v2 运行”随 `admitFusionGroup` 删除，无新对应 |
| `fusion/executor.test.ts`、`fusion.integration.ts` | 无（旧评审团执行器；回合路径见 `turn/jury.test.ts`、`turn/compare.integration.ts`） |
| `report/service.test.ts`：旧报告启动/价格/一份/状态/最新 | `turn/report.test.ts`（价格不符、冻结价、完整/截断/缺标题、失败/中断、停止、一键暂停与调用上限、先读来源和基准门禁）、`turn/reportHttp.test.ts`（停止与读取最新）；开关与错误边界保留在 `report/service.test.ts` |
| `report.integration.ts`：REPORT-GEN 28 个真 SQL 场景 | 随旧报告执行删除；REPORT-MODEL 窗口/列权限用例保留。回合路径的报告 SQL 见 `packages/db/tests/turn-core/report-cases.mjs`、`report-final-cases.mjs` |
| `routers/nativeOutputRoutes.test.ts`、`runtimeResume.test.ts` | 无（旧流式过程和旧续写）；回合路径续写 `turn/resume.test.ts` |
| `routers/stagingAdmission.test.ts`：下游真实模型准入 6 项（prepareStep/runtime.prepare/resume） | 删；保留测试窗口/错误边界 21 项，`runtime.view` 改为读 `runtime_session_scope`，补 `captureResolve` 的有界拒绝与脱敏 500；新增 `opc/runtimeStart.test.ts` 5 项覆盖 `runtime.start` 与 `runtime.view` |
| `routers/legacyClose.test.ts` | 改：保留的过程必须在，旧执行过程（8 个）必须不在 |
| `catalogCache.integration.ts`：热的 free-chat/Skill 准入每次请求读一次目录 | 无（旧准入）；目录版本用例保留 |
| `capture.integration.ts`（约 40 个 SQL 用例）、`agentCorePlanB.integration.ts`（3）、`cdcB2Eval.integration.ts` | 无逐条对应：它们都靠旧 `runtime_executions` 行造数据。回合路径的采集见 `turn/mentor.integration.ts`、`packages/db/tests/turn-core`。**这是最大的一块未逐条核对的覆盖**，见第 6 节 |
| `runtime.integration.ts` 等 `services/runtime/*.integration.ts`（含 2074–2096 行附近和 `upgrade.integration.ts` 121/144 的旧执行器 HTTP 用例） | 随目录删除；新路径的断线与重启恢复由 turn-core 的 recovery 用例和 turn-recovery 套件覆盖 |
| `opc.integration.ts`：71 个顶层语句（用例和包着用例的循环） | 按“走旧执行器/旧表（`runtime_executions`、`bill2_*`）/旧方法（`planResult`、`saveResult`、`prepareStep`、`mentorTurnStream`、`videoExecutionCheck`…）”机械分类后删除（用 token 分类，非逐条人工核对；清单见附录）。剩下 60 个顶层用例是数据库/业务规则用例，文件从 11648 行缩到 4514 行 |
| `payg*`、`nativeOutput*` 等旧 PAYG 计价单测（`runtimePaygCall`） | 无（旧准入的计价；回合路径用 `turn/fusionQuote.ts`、`turn/quote.ts`）；图片计价 `turn/provider/imageInput.test.ts` 仍在 |
| `billingReconciliation` | 新增 2 项：结果里没有 `calls` 时按零处理；有就照旧校验并报警 |

## 4. 需要主窗口/数据库一侧配合（不在 C 的范围）

1. **`runtime_session_scope(p_actor_id uuid, p_session_id uuid)`**：`runtime_sessions` 对 service_role 是 REVOKE 的，F 草稿又会 DROP `runtime_view` / `runtime_view_with_work_items`。`runtime.view` 需要一个只返回 `{sessionId, scope, legacy}` 的小函数，沿用拒绝码 `CONTENT_ERASED`、`RUNTIME_SCOPE_DENIED`；`legacy` = 该会话没有任何回合但有旧 execution。**这个函数落地之前，`runtime.view` 在 staging 上读不到（Node 已按这个名字调用）。**
2. **`fusion_call_output_read` 不能删**：现役评审团回合（`turn/jury.ts` → `reviewCore.decide/opinionsOf/passedRevision` → `outputOf`）和评审回看页（`detail`/`events` 的 `savedOutputs`）都在调它，它已经先读 `fusion_turn_outputs`。F 草稿的守卫点名它，要改成保留（可改写成只读 `fusion_turn_outputs`），否则新路径评审团会坏。`fusion_call_verdict` 只剩旧 rejudge 用，Node 调用已删。`fusion_call_output_save`、`fusion_compare_context`、`fusion_group_admit`、`fusion_review_claim/close/start`（`reviewRecord.ts` 里的 `claim`/`start`/`close`）的 Node 调用方：前几个随旧文件删净；`reviewRecord.ts` 里还保留着 `start/claim/advance/close` 的方法体但已无人调用（jury 只用 `read/replay`），F 的 Node 部分可以再删。
3. `reviewRecord.ts` 里无人调用的方法、`opc/capture.ts` 的 `captureCompleted`（只给旧执行器用）：本 PR 没动，F 迁移前再清。

## 5. web 一侧还没做完的收尾（等 A、B 合并后）

- `apps/web/src/lib/payg-wait.ts`、`use-payg-resume.ts` 现在还被 A 的 `positioning/[draftId]/**`（`page.tsx`、`mentor-turn.ts`、`use-live-reply` 一带）和 B 的 `runtime/**` 引用，**这个 PR 没删**。A、B 合并后在这个分支上 rebase，先 `git grep` 确认无人使用的导出再删，`usePaygResume`（调用已删的 `runtime.resume`）整体去掉。
- 本分支的 `apps/web` 的 `tsc` 现在有 18 处错误，全部在 A/B 的文件里：`positioning/[draftId]/page.tsx`（`executeStream`、`executions`、`activeExecution`、`RecoveryHistory`）、`use-live-reply.ts`（`cancel`、`executeStream`）、`runtime/page.tsx`（`workItemId` 现在要按 `scope.kind === 'work_item'` 收窄后取），`lib/use-payg-resume.ts`（`resume`）。A、B 把这些去掉后应归零。
- `runtime.view` 新形状（B 要对）：`{ sessionId: string, scope: { kind: 'positioning_draft' } | { kind: 'work_item', projectId, workItemId }, legacy: boolean, mode: string }`。旧会话（没有回合）`legacy: true`，页面应显示“这个对话是旧版本产生的，已不再支持查看”。

## 6. 发现的问题（不在本任务范围，未处理）

- **模型身份输出替换（MODEL-IDENTITY-GUARD 第 3 层）没有接在回合路径上**：`modelIdentity/outputGuard.ts` 和 `runtimeGuard.ts`（含各自测试）现在没有任何非测试引用，之前只有旧执行器在用。我**没删**，留着等 Owner/总控决定是否接进回合路径；删旧执行器之后，线上模型自述“我是 Claude/GPT…”这一层保护实际上就没有了（如果回合路径在别处已有等价处理，请告诉我，我再删）。
- **CDC 评测工具链依赖旧执行器**：`scripts/cdc-writeback-v2/seed.ts` 用 `prepareStep` 和 `runtime_executions`，`scripts/cdc-b2-eval`、`packages/api/src/scripts/cdcB2Fixture.ts`、`ac0Probe/*` 同源。它们是被文件哈希钉住的付费评测工具，我只删了会编译失败的 `cdcB2Eval.integration.ts`，其余没动，F 之后跑不起来，是否退役由 Owner 定。
- `fusion/reviewRecord.ts` 的 `start/claim/advance/close`、`opc/capture.ts` 的 `captureCompleted`、`modelIdentity/*`、`artifacts/modelPolicy.ts`、`skills/localSource.ts`、`models/publicColumns.ts`、`research/sorsaContract.ts`、`notify/index.ts`：导入图上只剩测试引用（有的原本就是），没动。
- 没有等价测试的旧场景（第 3 节标“无”）：评审团开轮预检的接线、崩溃后重判（回合路径靠调用内判定）、旧准入的“在任何工作之前拒绝”顺序类断言、旧 SQL capture 约 40 个用例的逐条对应。

## 7. 验证

- `packages/api`：`tsc` 0 错；`eslint` 全包 0 错（抑制清单只减不增）；`vitest run` 全量 543 个文件 / 8024 个用例通过；`node scripts/check-code-size.mjs` 通过。
- `apps/web`：`trpc`、`api/trpc` 相关 3 个文件 13 个用例通过；`tsc` 的 18 处错误如上，都在 A/B 范围。
- 没跑：数据库集成套件（`--runtime-only --with-staging-schema --without-app`）需要本机库，CI 的集成作业在草稿阶段跳过；浏览器验收交 Codex（见 PR 的 Validation handoff，等 A/B 合并后再发）。

## 附录：`opc.integration.ts` 被删的旧路径用例（行号是改前文件）

- 原第 494 行：it.each [3, 6, 8, 4])(
- 原第 650 行：it("OPC: real SDK HTTP result becomes a candidate on original draft; restart/replay does not resend or append
- 原第 784 行：it("OPC: browser manual positioning publishes, defers topic generation and recovers after re-login", async ()
- 原第 1003 行：it("OPC: browser releases a legacy plan request after a definite invalid completed response", async () => {
- 原第 1036 行：it("OPC: work item uses shared Runtime and saves non-workflow Skill artifact once; source revocation denies re
- 原第 1379 行：it("OPC: plan generation uses the original SDK session and returns a separate bounded plan candidate", async (
- 原第 1488 行：it.skipIf !process.env.V3_REAL_SKILL_INPUT)(
- 原第 1772 行：it("OPC: browser-shaped Runtime material cannot impersonate a host-bound step or plan turn", async () => {
- 原第 1851 行：it("OPC: configured dependencies deny premature generation and old confirmations replay after information chan
- 原第 1929 行：it("OPC: one mentor conversation persists across steps, refresh and original Session recovery", async () => {
- 原第 2265 行：it("OPC: browser confirms the autosaved form as the step result without a duplicate model pass and recovers on
- 原第 2465 行：it.runIf process.env.V3_LOCAL_STAGING_HOST === "true")(
- 原第 2530 行：it.runIf process.env.V3_LOCAL_STAGING_HOST === "true")(
- 原第 2782 行：it("OPC: question-by-question confirmation keeps mentor, receipt recovery and hidden fields aligned", async ()
- 原第 2943 行：it('OPC: CAPACITY tool continuation measures each complete SDK request and cap behavior',async()=>{
- 原第 3035 行：it('OPC: CAPACITY interrupted request retains frozen manuscript after a new save and denies foreign actor',asy
- 原第 3201 行：it("OPC: the Agent opens the current question once per entry and plans without user-authored topic rows", asyn
- 原第 3375 行：it("OPC: a confirmed positioning produces an editable first-week plan candidate without user-authored rows", a
- 原第 3494 行：it("OPC: a revised round opens the same question under its own identity without reusing or duplicating the ori
- 原第 3678 行：it("OPC: a revision makes the page open the current question again in the new round without duplicating the or
- 原第 3804 行：it("OPC: a published revision's per-field elicitation reaches the read schema and the mentor directive", async
- 原第 4375 行：it("OPC: Stage C2 a lost reply keeps one plan identity across refresh and re-login", async () => {
- 原第 4804 行：it("OPC: clicking a review row opens that reached question without advancing progression or spending", async (
- 原第 4949 行：it("OPC: a legally reached question keeps its explicit confirm and mentor send while review stays display-only
- 原第 5147 行：it("OPC: an immutable information snapshot reconstructs the reached frontier when the next question never open
- 原第 5502 行：it("OPC: a second published revision drives new drafts while an existing draft stays pinned", async () => {
- 原第 6034 行：it("OPC: two real tabs retain review, resolve edits and recover one reply after real logout", async () => {
- 原第 6527 行：it("OPC: the retained-request state read denies another actor's draft and reports this actor's own verdict", a
- 原第 6848 行：it("OPC: the topic workspace binds one confirmed source and one turn identity, and fails closed without a topi
- 原第 7161 行：it("OPC: a second topic generation takes a new constraint and request id, and a lost reply recovers B behind c
- 原第 7568 行：it("OPC: workspace presentation changes preserve ownership, replay and version boundaries", async()=>{
- 原第 7795 行：it("OPC: legacy account revisions repair only untouched answers and retain source revocation",async()=>{
- 原第 8457 行：it("OPC: manual video revisions preserve execution ancestry, ownership and exact replay", async () => {
- 原第 8512 行：it("OPC: final script asks before derivatives, supports a partial choice, and marks prior results old after re
- 原第 8616 行：it("OPC: completed video generation permits the next dialogue and a new script final", async () => {
- 原第 8667 行：it("OPC: definite pre-admission failure revokes its claim and permits an explicit retry", async () => {
- 原第 8717 行：it("OPC: video claim material stays exclusive and a rejected claim can be retried", async () => {
- 原第 8762 行：it("OPC: upgraded legacy partial result blocks a duplicate dispatch and remains recoverable", async () => {
- 原第 8856 行：it("OPC: video package dispatch refuses a different frozen material before admission", async () => {
- 原第 8910 行：it.each [[2, "same"], [2, "draft"], [2, "published"], [3, "published"]] as const)("OPC: old v%i executed lost
- 原第 9019 行：it("OPC: two topic pages explicitly consent concurrently and execute one first turn", async () => {
- 原第 9161 行：it("OPC: mentor lost reply still projects once from its unchanged frozen information basis", async () => {
- 原第 9361 行：it.skipIf process.env.V3_CAPACITY_CAPTURE !== 'true')('OPC: CAPACITY version counts use only current manuscrip
- 原第 9447 行：it.skipIf process.env.V3_CAPACITY_CAPTURE !== 'true')('OPC: CAPACITY chat history projects superseded scope bo
- 原第 9483 行：it('OPC: rejected cross-business adoption recovers its original request and permits adoption after a conversat
- 原第 9532 行：it('OPC: typed content uses a right panel, deep links and one proactive continuation across tabs',async()=>{
- 原第 9819 行：it('OPC: free start sends attachments without selecting account or direction and survives refresh once', async
- 原第 9844 行：it('OPC: free runtime reads owned context only on model tool request and rechecks source revocation',async()=>
- 原第 10014 行：it.each [65,67])('OPC: boundary browser continues legitimate v%s video source history',async(targetVersion)=>{
- 原第 10122 行：it.skipIf !process.env.V3_LEGACY_ROOT)('OPC: U3 cross-code receipt recovery preserves old and filtered request
- 原第 10195 行：it.each ['cancelled','cost_pending'])('OPC: video truncation keeps accurate diagnosis and recovery envelope (%
- 原第 10226 行：it.each ['true','omitted','false'] as const)('OPC: stopped pending cost unlocks the original browser only for
- 原第 10278 行：it("OPC: mentor freezes actor-bound business identity and existing material without rewriting retained request
- 原第 10311 行：it("OPC: unnamed entry requires no business modal and never imports another business as mentor context", async
- 原第 10328 行：it("OPC: business source context is frozen to the matching business and fails closed on source revocation", as
- 原第 10408 行：it("OPC: account mentor inherits only its account steps and never another account business profile", async ()
- 原第 10435 行：it("OPC: homepage guide starts one unnamed mentor task and replays its exact intent after refresh",async()=>{
- 原第 10476 行：it.each ['five','legacy','free'] as const)('OPC: ANSWER_SOURCE frozen card, canonical option and replay (%s)',
- 原第 10510 行：it.each ['session','question','stale','no-card','pending','index'] as const)('OPC: ANSWER_SOURCE refuses %s be
- 原第 10531 行：it.each ['card','input','index','owner','race','step','round','free-input','no-source','answered-again','reque
- 原第 10599 行：it.each ['runtime_admit(uuid,uuid,uuid,jsonb,jsonb)','runtime_view(uuid,uuid)'])(
- 原第 10763 行：it("OPC: RATE-LIMIT browser gate notices keep the original request, never auto-retry and charge nothing", asyn
- 原第 11004 行：it("OPC: RATE-LIMIT /runtime call-gate stop display and video package admission hold", async () => {
- 原第 11132 行：it("OPC: RATE-LIMIT start-page send refused by any 503 is never re-sent automatically", async () => {
- 原第 848 行：for (const sample of [
- 原第 1185 行：async function admitLegacyPlan(
- 原第 1398 行：it("OPC: Stage C3 a recovered candidate stays display-only and never becomes a plan, account or work item", as
- 原第 1484 行：it("OPC: the legacy /plan link recovers only an admitted request and never admits or charges", async () => {
- 原第 1526 行：it("OPC: Stage C7 a stale round candidate neither suppresses nor impersonates the current round", async () =>
- 原第 2224 行：it("OPC: a local record without consent is checked on the server and only recovered by an explicit continue",
- 原第 4456 行：for (const sample of [
