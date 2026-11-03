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

## 三、汇总
- **A（保留）**：`runtime_test_policy`、`runtime_production_access`（含两个小助手 `runtime_production_database`、`bill2_actor` 进 KEEP）；另有 4 个只因 `runtime_test_windows` 被点名的，带保留参数后自然消失。
- **B（前置改写，函数名不变，Node 不改）**：`runtime_session_results_list_turns`、`runtime_session_result_save_turn`、`runtime_session_result_edit`、`runtime_session_result_versions`（四个共用一个助手改写）、`runtime_execution_visibility`、`runtime_positioning_gate`、`runtime_test_actor_access`、`fusion_review_archive_reconcile`、`fusion_review_close`。
- **D（调用方在删除范围内，函数随之删除，先确认调用方）**：`fusion_group_claim`、`opc_capture_apply`、`runtime_session_result_save`、`runtime_production_recovery_policy`、`runtime_test_recovery_policy`、`report_fee_settle_due`。
- **C（要总控定）**：`runtime_tool`、`runtime_mentor_history`、`runtime_session_items`、`runtime_library_visible`、`runtime_library_read`、`runtime_cancel`、`runtime_execution`、`fusion_review_fee_settle`、`fusion_compare_context`、`fusion_review_claim`、`fusion_review_start`。
  - 共同的问题是同一个：`turn/` 目录里有几个文件（`agent/mentorHistory.ts`、`agent/session.ts`、`research/libraryReadTool.ts`、`research/sourceRuntimeTool.ts`、`admission/positioningFallback.ts`、`agent/contentSource.ts`）仍在用“旧执行 id”调这些函数，但它们的导入方既有要删的 `services/runtime/*`，也有现役的 `turn/agent/runtimeContext.ts`、`turn/admission/libraryAdmission.ts`、`publishMonitor/reviews.ts`。**需要先判断这些适配文件在新路径里是否还有调用路径**；如果只是被旧 `runtime/*` 使用，则整组变 D，C 类清零。
