# V2-12 批次 F：留下又碰旧对象的函数分类（A/B/C）

日期：2026-11-03。基线：#1662（`09a34f3f9`，旧 BILL2 provider 层已删）的重算清单 + 严格检查（`F_STRICT=1`）。
分类依据：函数源码（`catalog.json`）、Node 调用点、守卫实际点名。**只出分类，不写迁移。**

## 先更正一个生成参数
生成器必须带 `--keep-table runtime_test_windows`（总控 11-03 决定：留）。此前重新生成 F 草稿时漏了，草稿把它也删了；已改正（见本分支的草稿文件）。
带上之后，守卫真实点名从 11 个降到 **7 个**（`report_model_window`、`research_test_window_sync_prices`、`account_erasure_local_remaining`、`account_erasure_prune_business` 只因为提到 `runtime_test_windows` 被点名，现在不再点名）。

## 图例
- **A**：只读写 F 之后保留的表 → 移进 KEEP，不改代码。
- **B**：碰要删的表，新表里有对应数据 → 前置改写成读新表，函数名不变，Node 不改。
- **C**：新表里没有对应数据，或语义有疑问 → 交给总控定，不猜。
- **D（补充）**：调用方本身是要删的旧 Node，Node 删掉后函数就没人调用 → 直接进删除名单（需要先确认调用方确实在删除范围内）。

## 一、守卫点名的 7 个（带保留 runtime_test_windows 之后）
| 函数 | 碰到什么 | 调用方 | 类 | 说明 |
|---|---|---|---|---|
| `fusion_compare_context` | `runtime_executions`、`runtime_session_history`、`runtime_history_dependencies`、`runtime_library_references`、`bill2_runs`；调 `runtime_history_availability`、`runtime_session_context` | 旧对比流 `fusion/compare*.ts` | **C** | 新路径对比走 `turn/compare.ts`；这个函数给旧对比拼上下文。要确认 `fusion/compare*.ts` 是否整个在 C 路删除范围。若是，则 D |
| `fusion_group_claim` | `bill2_runs/calls`、`fusion_billing_groups(+steps)`、调 `bill2_claim` | `fusion/executor.ts` | **D** | 旧评审团执行器的分步认领；新路径是 `fusion_turn_*`。随 `fusion/executor.ts` 删 |
| `fusion_review_archive_reconcile` | `bill2_runs/calls`、`fusion_billing_groups`、`fusion_review_fees`、调 `bill2_cancel/finalize`、`fusion_review_fee_settle` | OPC 归档流程 | **B** | 归档业务时对账评审团旧费用。新路径按 `turns` 看（`opc_business_archive` 已有回合忙检查）。改写成只做“评审状态收尾”，不再碰费用表 |
| `fusion_review_claim` | `fusion_billing_groups`、`fusion_review_fees` | `fusion/reviewCore.ts` | **D/C** | 旧评审团认领。若 `reviewCore.ts` 仍是新评审入口（`turn/jury.ts → reviewCore`）则要 B：改成只写 `fusion_reviews` 状态；需要先确认 |
| `fusion_review_close` | `bill2_runs`、调 `bill2_cancel/finalize`、`fusion_review_fee_settle_internal` | `fusion/reviewRecord.ts` | **B** | 评审收尾：保留状态更新，去掉旧费用结算（新费用在 `turn_close`） |
| `fusion_review_start` | `bill2_runs/calls`、调 `fusion_call_in_flight`、`fusion_review_fee_hold` | `fusion/reviewPlan.ts` | **C** | 旧评审开始时预占费用。新路径预占在 `turn_open`。语义上要改成不预占，但评审开始的幂等/请求 id 约束是否还要，需要总控确认 |
| `opc_capture_apply` | `runtime_executions`、调 `runtime_history_available` | OPC 采集（`opc/service.ts`） | **D** | 以旧执行 id 为入口的采集落库；新采集走 turn 结果（`opc_work_result` 同批，已在“随旧工作台用例一起去”清单）。随调用方删 |

## 二、严格检查点名的 21 个（Node 仍调用、会被 F 删）
| 函数 | 调用方（现役生产代码） | 碰到什么 | 类 | 说明 |
|---|---|---|---|---|
| `runtime_session_results_list_turns` | `opc/sessionResults.ts` | 保留表 `runtime_session_results` + 视图助手 `runtime_session_result_turn_view` | **B** | 助手链最后调 `runtime_history_available`（旧）。改写 `runtime_session_result_view`：`sourceAvailable` 只看 `source_turn_id`/消息；函数名不变 |
| `runtime_session_result_save_turn` | 同上 | 同上 | **B** | 同上 |
| `runtime_session_result_edit` | 同上 | 同上 | **B** | 同上 |
| `runtime_session_result_versions` | 同上 | 同上 | **B** | 同上 |
| `runtime_session_result_save` | 同上 | `runtime_executions`（旧执行 id 入口） | **D** | 以旧执行为来源的保存；新保存是 `save_turn`。Node 删这个分支 |
| `runtime_execution_visibility` | `accountErasure/content.ts` | `content_erasure_visible` + 两个“来源已删”助手（读 `runtime_voice/library_references`） | **B** | 旧表没了，只剩 `content_erasure_visible`：改写成 `PERFORM content_erasure_visible(...); RETURN 'visible'`，Node 不改（V2-9 另可把这个调用也删掉） |
| `runtime_positioning_gate` | `turn/admission/positioningGate.ts`（现役：`chat.ts`、`compare.ts`） | `opc_has_confirmed_positioning` + 数 `runtime_executions` 24 小时内被定位拒绝的次数 | **B** | `refusals24h` 改成数 `turns` 里同类拒绝。`turn_open` 已返回同一个数（turn-core 有用例），表达式可直接复用 |
| `runtime_test_actor_access` | `turn/settings/stagingPolicy.ts` | 保留表 `runtime_test_windows` + `bill2_runs`（有过测试窗口运行的人也放行） | **B** | 去掉 `bill2_runs` 那一支，改看 `turns` 是否有该人的测试窗口回合（若 `turns` 没存窗口 id 则变 C） |
| `runtime_production_access` | `turn/settings/productionPolicy.ts` | 调 `runtime_production_database()`、`bill2_actor()`（都不碰旧表） | **A** | 这两个小助手只读系统设置和 profiles，移进 KEEP；`runtime_production_access` 本身不碰旧表 |
| `runtime_test_policy` | `turn/settings/stagingPolicy.ts` | 只读保留表 `runtime_test_windows` | **A** | 保留 |
| `runtime_production_recovery_policy` | 同上（给旧恢复流程） | `runtime_executions`、`bill2_runs`（读原始 run 的冻结价格/调用策略） | **D** | 调用方是 `runtime/automaticRecovery.ts`（旧恢复）。新恢复用 `turn_calls` 里冻结的值 |
| `runtime_test_recovery_policy` | 同上 | 同上 | **D** | 同上 |
| `runtime_tool` | `turn/agent/mentorHistory.ts`、`turn/research/libraryReadTool.ts`、`turn/research/sourceRuntimeTool.ts` | `runtime_executions`、`runtime_tool_calls`、`bill2_runs` | **C** | 这三个文件在 `turn/` 目录，但被旧 `runtime/executionTools.ts` 和 `turn/agent/runtimeContext.ts`、`turn/admission/libraryAdmission.ts` 同时导入，是以“旧执行 id + 工具调用去重”为中心的适配层。新路径的工具去重在 `turn_calls`。要先确认 `runtimeContext.ts`/`libraryAdmission.ts` 里这条调用链是否还是现役 |
| `runtime_mentor_history` | `turn/agent/mentorHistory.ts` | `runtime_executions`、调 `runtime_mentor_messages` | **C** | 同上：以旧执行 id 查导师历史；新路径是 `session_messages` + `turn_mentor_context` |
| `runtime_session_items` | `turn/agent/session.ts`（被 `publishMonitor/reviews.ts`、`turn/agent/workspacePosts.ts` 使用） | `runtime_session_history`、`runtime_history_dependencies`、`bill2_runs/calls`、调 `runtime_read_verified` | **C** | 现役使用者之一是 `publishMonitor/reviews.ts`（发布监测复盘）。新路径等价读 `session_messages`；需要确认复盘是否已改读 `session_messages` |
| `runtime_library_visible` | `turn/research/libraryReadTool.ts` | `runtime_executions`、`runtime_library_references` | **C** | 旧“库引用”可见性。新路径库读取的可见性在 `turn/admission/libraryAdmission.ts` 里冻结，函数侧还要不要，需要确认 |
| `runtime_library_read` | 同上 | `runtime_executions`、`runtime_tool_calls`、`runtime_library_references` | **C** | 同上 |
| `runtime_cancel` | `turn/admission/positioningFallback.ts`（被 `chat.ts`、`compare.ts` 间接用） | `runtime_executions`、`bill2_runs`、调 `bill2_cancel/finalize` | **C** | 兜底：定位拒绝时取消一次旧执行。新路径定位拒绝发生在 `turn_open` 之前、不产生旧执行。该分支应变为死代码，需要确认后在 `positioningFallback.ts` 里删掉 |
| `runtime_execution` | `positioningFallback.ts`、`agent/contentSource.ts` | 旧执行状态机（28 KB） | **C/D** | 同上，两处都是对旧执行的 `fail_platform/interrupt/checkpoint_source` 动作。要确认 `contentSource.ts` 的 `checkpoint_source` 在新路径是否仍被触发 |
| `fusion_review_fee_settle` | `fusion/reviewRecord.ts` | `fusion_review_fees` | **C** | 旧评审团费用结算。新费用在 `turn_close`。要确认 `reviewRecord.ts` 的这次调用是否还在现役评审路径 |
| `report_fee_settle_due` | `report/fees.ts`（定时任务） | `report_fees`、`bill2_runs/calls`、`runtime_executions` | **D** | 旧报告费用到期结算任务。新报告按回合结算。随 `report/fees.ts` 与它的定时任务入口删 |

## 三、C 类的判定结果（2026-11-03，函数级可达性，基线 #1662 `09a34f3f9`）
方法：先做文件级静态导入图（根 = `apps/web/src/app` 的 route/page/layout/actions + middleware，不含测试）。**文件级几乎全能走到**（例如 `turn/chat.ts → agent/contentSource.ts → agent/runtimeContext.ts → agent/mentorHistory.ts`），太粗，不能据此判断。所以再做函数级：对每个真正发 RPC 的导出函数，查生产代码（排除测试）里有没有调用方。结果：

| 发 RPC 的 Node 函数 | 生产调用方 | 调的 SQL 函数 | 判定 |
|---|---|---|---|
| `executionMentorHistoryTool`（`turn/agent/mentorHistory.ts`） | 0 | `runtime_tool`、`runtime_mentor_history` | **D** |
| `PostgresSession`（`turn/agent/session.ts`；`publishMonitor/reviews.ts` 只导入类型 `SessionRpc`） | 0 | `runtime_session_items` | **D** |
| `readLibrary`（`turn/research/libraryReadTool.ts`），唯一调用方是 `sourceRuntimeTool()`，而 `sourceRuntimeTool()` 本身 0 个调用方（`libraryAdmission.ts` 只用同文件的 `sourceToolBytes`） | 0 | `runtime_tool`、`runtime_library_visible`、`runtime_library_read` | **D** |
| `endPositioningRefusal`（`turn/admission/positioningFallback.ts`） | 0 | `runtime_cancel`、`runtime_execution` | **D** |
| `checkpointContentSource` / `injectContentSource` / `admitContentSource`（`turn/agent/contentSource.ts`） | 0 | `runtime_execution` | **D** |
| `contentVisibilityFence`（`accountErasure/content.ts`） | 0 | `runtime_execution_visibility` | **D** |
| `loadCompareChoice`（`fusion/compareLoad.ts`；现役的是同文件的 `loadCompareTurnParts`，不调 SQL 旧函数） | 0 | `fusion_compare_context` | **D** |
| `captureCompleted`（`opc/capture.ts`；现役的是 `capturePending`，传 `p_execution_id: null`） | 0 | `opc_capture_apply`（执行 id 分支） | 函数 **B**：只保留 `p_draft_id` 分支；Node 删 `captureCompleted` |
| `reviewRecord(...).claim / advance / close / start`（`fusion/reviewRecord.ts`）：`turn/jury.ts` 与 `fusion/review.ts` 只用 `read`、`replay`、`recordAdoption`、`settleFee` | 0（这四个方法） | `fusion_review_claim`、`fusion_review_advance`、`fusion_review_close`、`fusion_review_start`（新建分支） | claim/advance/close **D**；`fusion_review_start` 只剩 `replay`（已知请求 id 返回现有评审）**B** |
| `reviewRecord(...).settleFee`（`fusion/review.ts:83`，现役） | 1 | `fusion_review_fee_settle` | **B**：新费用在 `turn_close`，改写成无费用行时返回 NULL（Node 已写 `?? view.fee`） |
| `sessionResultsService`（`opc/sessionResults.ts`，tRPC `opc.sessionResults*`，前端 `components/opc/session-results.tsx`） | 7 | `runtime_session_results_list_turns`、`_save_turn`、`_edit`、`_versions`、`_save` | list_turns/save_turn/edit/versions **B**（改写共用助手 `runtime_session_result_view`，去掉对 `runtime_history_available` 的调用，函数名不变）；`save`（旧执行入口）**D + 要动 Node 与前端** |
| `loadStagingRecoveryPolicy`（`turn/settings/stagingPolicy.ts`） | 0 | `runtime_production_recovery_policy`、`runtime_test_recovery_policy` | **D** |
| `assertStagingReadAccess`（`routers/opc.ts`、`routers/runtime.ts`，现役） | 6 | `runtime_test_actor_access` | **B**（去掉 `bill2_runs` 那一支） |
| `assertProductionAccess` / `loadStagingPolicy` | 现役 | `runtime_production_access`、`runtime_test_policy` | **A** |
| `settleDueReportFees`（`report/fees.ts`；`api/cron/billing-reconcile/route.ts:44` 现役） | 1 | `report_fee_settle_due` | **D + 要动 Node**：删这个调用 |
| `runtime_positioning_gate`（`turn/admission/positioningGate.ts`，`turn/chat.ts`、`compare.ts` 现役） | 现役 | `runtime_positioning_gate` | **B**：`refusals24h` 改数 `turns`（`turn_open` 已有同一表达式） |

## 四、最终分类
**A（保留，不改）**：`runtime_test_policy`、`runtime_production_access`（含小助手 `runtime_production_database`、`bill2_actor` 进 KEEP）。

**B（前置改写，函数名不变，Node 不改）**：
`runtime_session_results_list_turns`、`runtime_session_result_save_turn`、`runtime_session_result_edit`、`runtime_session_result_versions`（连同助手 `runtime_session_result_view`）、`runtime_positioning_gate`、`runtime_test_actor_access`、`opc_capture_apply`（去掉执行 id 分支）、`fusion_review_start`（只保留按请求 id 回放）、`fusion_review_fee_settle`（无费用行返回 NULL）、`fusion_review_close`→**改归 D**（见下）、`fusion_review_archive_reconcile`。

**D（随 F 删除，调用方已无生产代码调用）**：
`runtime_tool`、`runtime_mentor_history`、`runtime_session_items`、`runtime_library_visible`、`runtime_library_read`、`runtime_cancel`、`runtime_execution`、`runtime_execution_visibility`、`fusion_compare_context`、`fusion_review_claim`、`fusion_review_advance`、`fusion_review_close`、`fusion_group_claim`、`runtime_production_recovery_policy`、`runtime_test_recovery_policy`、`runtime_session_result_save`、`report_fee_settle_due`、`opc_work_result`（已在原清单）。

**C（交给总控）：无。** 原来的 11 个全部有结论。

## 五、要动 Node 的文件清单（给总控拆分用）
这些函数在 Node 里已经没有生产调用方，只是还留着死代码；删掉它们才能让 `F_STRICT` 的 NODE-STILL-CALLS 归零。分成两类：

**只删死代码（不改行为，C 路在 #1662 里或随后删）**
- `packages/api/src/services/turn/agent/mentorHistory.ts`：删 `executionMentorHistoryTool`（其余导出保留）
- `packages/api/src/services/turn/agent/session.ts`：删类 `PostgresSession`（保留接口 `SessionRpc`，`publishMonitor/reviews.ts` 导入的是它）
- `packages/api/src/services/turn/research/sourceRuntimeTool.ts`：删 `sourceRuntimeTool()`（保留 `sourceToolBytes`）
- `packages/api/src/services/turn/research/libraryReadTool.ts`：删 `readLibrary`（保留 `libraryQuery` 与两个 GUIDE 常量，若仍有人用）
- `packages/api/src/services/turn/admission/positioningFallback.ts`：删 `endPositioningRefusal`
- `packages/api/src/services/turn/agent/contentSource.ts`：删 `checkpointContentSource`、`injectContentSource`、`admitContentSource`（保留类型和 `withInjectedSource` 等被现役使用的导出，删前再查一次）
- `packages/api/src/services/accountErasure/content.ts`：删 `contentVisibilityFence`
- `packages/api/src/services/fusion/compareLoad.ts`：删 `loadCompareChoice`
- `packages/api/src/services/fusion/reviewRecord.ts`：删 `start`、`claim`、`advance`、`close` 四个方法（保留 `replay`、`read`、`recordAdoption`、`settleFee`）
- `packages/api/src/services/opc/capture.ts`：删 `captureCompleted`
- `packages/api/src/services/turn/settings/stagingPolicy.ts`：删 `loadStagingRecoveryPolicy`

**要改行为（有现役调用方，需要小心）**
- `packages/api/src/services/report/fees.ts` + `apps/web/src/app/api/cron/billing-reconcile/route.ts`：删 `settleDueReportFees` 及其调用（日对账里的报告费结算，旧表没了）。
- `packages/api/src/services/opc/sessionResults.ts` + `packages/api/src/routers/opc.ts`（`sessionResultSave`）+ `apps/web/src/components/opc/session-results.tsx`：删“以旧执行 id 保存结果”的 `save` 分支，保留 `save_turn`。前端要确认还有没有按钮走旧保存。
- 后续（不属 NODE-STILL-CALLS，但同批要查）：`billing_reconcile_day` 的 Node 读取端（`calls` 键缺失要容忍，已在 C 路任务单里）。

## 六、说明
- 表中“D”的 SQL 函数，在删掉上面的 Node 死代码之后，会从 `reach` 里变成不可达，生成器自动把它们放进删除名单；守卫剩下的 7 个里，`fusion_compare_context`、`fusion_group_claim`、`fusion_review_claim`、`opc_capture_apply`（B 改写后不再碰旧表）、`fusion_review_archive_reconcile`（B）、`fusion_review_close`、`fusion_review_start`（B）都按上面处理。
- B 类改写要补测试：每个函数一条（调用返回同形状、不读旧表）；`runtime_positioning_gate` 对照 `turn_open` 的 24 小时拒绝计数；`fusion_review_start` 回放用例；`runtime_session_result_*` 用现有的 `session-results` 套件。
