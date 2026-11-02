# CORE-PATH-V2 V2-12 删除清单（盘点数据）

状态：草稿，只读盘点，不含迁移、不含代码改动。配套方案见 `CORE-PATH-V2-DELETE.md`。
基线：`origin/staging` `17607a9cf`（迁移 0475 之后，含 0476 的 #1627 尚未算入）。第三次重算（F 批次前）：#1558、#1561、C2、V2-7b、日限补预占都已合并。**本文是脚本生成的**，动手前和每个批次前必须再重算（方法见方案第 7 节）。

## A. 待删的表（19 张，其中 1 张带 ⚠ 要保留）

第 5.3 节的 18 张加 `runtime_session_names`（并入 `sessions.title`）。本机从文件建库实测：全部为空表，行数 0。其中 `runtime_scope_material` 带 ⚠：新路径还在用，不能按“删除”处理（方案 0.5）。

| 表 | 指向它的外键（来自保留的表） | 其上的触发器 |
|---|---|---|
| `runtime_executions` | `opc_result_links_execution_id_fkey`、`opc_content_versions_execution_id_fkey`、`opc_data_events_execution_id_fkey`、`research_plans_execution_id_fkey`、`research_selection_cards_execution_id_fkey`、`research_discoveries_execution_id_fkey`、`research_account_fetches_execution_id_fkey`、`research_account_fetches_last_success_execution_id_fkey`、`research_refresh_grants_used_execution_id_fkey`、`research_refresh_grants_source_execution_id_fkey`、`research_benchmarks_execution_id_fkey`、`research_benchmark_shortfalls_execution_id_fkey` | report_fee_terminal_settlement、opc_video_runtime_binding_guard、a_erased_row_guard、content_erasure_marker_guard、content_erasure_execution_guard、content_erasure_parent_guard、runtime_library_references_freeze、publish_monitor_review_admit_guard、publish_monitor_review_result_guard、runtime_voice_references_freeze |
| `runtime_session_history` | — | a_erased_row_guard、content_erasure_parent_guard |
| `runtime_history_dependencies` | — | a_erased_row_guard、content_erasure_parent_guard |
| `runtime_tool_calls` | — | a_erased_row_guard、content_erasure_parent_guard、runtime_workspace_tool_guard、runtime_mentor_history_guard、a_runtime_library_tool_guard、runtime_workspace_benchmark_guard、runtime_workspace_posts_guard |
| `runtime_session_batches` | — | a_erased_row_guard、content_erasure_parent_guard |
| `runtime_session_results` | — | runtime_session_results_owner_guard |
| `runtime_scope_material` ⚠ **新路径仍读写：定位/选题/work_item 的素材快照。不在 F 批次删，见方案 0.5** | `opc_turns_session_id_material_revision_fkey`、`opc_video_material_bindings_session_id_material_revision_fkey` | a_erased_row_guard、content_erasure_parent_guard |
| `runtime_library_references` | — | — |
| `runtime_voice_references` | — | — |
| `runtime_test_windows` | — | — |
| `runtime_session_names` | — | runtime_session_names_owner_guard |
| `bill2_runs` | `token_stats_bill2_run_id_fkey`、`ai_usage_logs_bill2_run_id_fkey`、`credit_transactions_bill2_run_id_fkey`、`fusion_call_outputs_run_ref` | runtime_test_budget_guard、bill2_run_erasure_guard、runtime_binding_guard、content_erasure_marker_guard、fusion_billing_run_guard |
| `bill2_calls` | `credit_transactions_bill2_call_id_fkey`、`token_stats_bill2_call_id_fkey`、`ai_usage_logs_bill2_call_id_fkey`、`fusion_call_outputs_call_ref`、`research_operations_bill2_call_id_fkey` | runtime_a_test_dispatch_guard、runtime_matching_call_guard、bill2_payg_review_call_changed、bill2_call_erasure_guard、runtime_stop_loss_call_guard、fusion_billing_call_guard、bill2_calls_kind_guard、publish_monitor_review_call_guard、bill2_payg_zz_block_lock |
| `bill2_receipts` | — | bill2_evidence_immutable、bill2_payg_review_receipt_added |
| `bill2_provider_ids` | — | — |
| `fusion_billing_groups` | `fusion_call_outputs_group_ref`、`fusion_compares_group_ref` | fusion_group_fee_guard |
| `fusion_billing_group_steps` | — | — |
| `report_fees` | — | — |
| `fusion_review_fees` | — | — |

## B. 指向待删表的外键、列与约束

保留的表里共 **25** 条外键指向待删表，必须在 DROP 前先去掉（DROP TABLE 会因此失败）。待删表之间互相指向的 16 条随表一起消失。

| 保留的表 | 外键约束 → 待删表 | 建议 |
|---|---|---|
| `opc_turns` | `opc_turns_session_id_material_revision_fkey` → `runtime_scope_material` | 去掉外键；`execution_id`/素材版本列随定位/选题/work_item 改接处理 |
| `token_stats` | `token_stats_bill2_run_id_fkey` → `bill2_runs`<br>`token_stats_bill2_call_id_fkey` → `bill2_calls` | 去掉外键；`bill2_run_id`/`bill2_call_id` 列无新路径读者时一并删列（要先核对 token_stats 两条约束与两个 `credit_transactions_bill2_*` 索引） |
| `ai_usage_logs` | `ai_usage_logs_bill2_run_id_fkey` → `bill2_runs`<br>`ai_usage_logs_bill2_call_id_fkey` → `bill2_calls` | 去掉外键；`bill2_run_id`/`bill2_call_id` 列无新路径读者时一并删列（要先核对 token_stats 两条约束与两个 `credit_transactions_bill2_*` 索引） |
| `credit_transactions` | `credit_transactions_bill2_run_id_fkey` → `bill2_runs`<br>`credit_transactions_bill2_call_id_fkey` → `bill2_calls` | 去掉外键；`bill2_run_id`/`bill2_call_id` 列无新路径读者时一并删列（要先核对 token_stats 两条约束与两个 `credit_transactions_bill2_*` 索引） |
| `opc_result_links` | `opc_result_links_execution_id_fkey` → `runtime_executions` | 去掉外键；`execution_id`/素材版本列随定位/选题/work_item 改接处理 |
| `opc_content_versions` | `opc_content_versions_execution_id_fkey` → `runtime_executions` | 去掉外键；`execution_id`/素材版本列随定位/选题/work_item 改接处理 |
| `opc_video_material_bindings` | `opc_video_material_bindings_session_id_material_revision_fkey` → `runtime_scope_material` | 去掉外键；`execution_id`/素材版本列随定位/选题/work_item 改接处理 |
| `opc_data_events` | `opc_data_events_execution_id_fkey` → `runtime_executions` | 去掉外键；`execution_id`/素材版本列随定位/选题/work_item 改接处理 |
| `fusion_call_outputs` | `fusion_call_outputs_call_ref` → `bill2_calls`<br>`fusion_call_outputs_run_ref` → `bill2_runs`<br>`fusion_call_outputs_group_ref` → `fusion_billing_groups` | 去掉外键；`group_ref`/`run_ref`/`call_ref` 列随评审团/对比改接 `turns` 时处理 |
| `research_operations` | `research_operations_bill2_call_id_fkey` → `bill2_calls` | 去掉外键；`execution_id` 列改为可空的无约束历史列或删列（研究产物表要保留） |
| `research_plans` | `research_plans_execution_id_fkey` → `runtime_executions` | 去掉外键；`execution_id` 列改为可空的无约束历史列或删列（研究产物表要保留） |
| `research_selection_cards` | `research_selection_cards_execution_id_fkey` → `runtime_executions` | 去掉外键；`execution_id` 列改为可空的无约束历史列或删列（研究产物表要保留） |
| `research_discoveries` | `research_discoveries_execution_id_fkey` → `runtime_executions` | 去掉外键；`execution_id` 列改为可空的无约束历史列或删列（研究产物表要保留） |
| `research_account_fetches` | `research_account_fetches_execution_id_fkey` → `runtime_executions`<br>`research_account_fetches_last_success_execution_id_fkey` → `runtime_executions` | 去掉外键；`execution_id` 列改为可空的无约束历史列或删列（研究产物表要保留） |
| `research_refresh_grants` | `research_refresh_grants_used_execution_id_fkey` → `runtime_executions`<br>`research_refresh_grants_source_execution_id_fkey` → `runtime_executions` | 去掉外键；`execution_id` 列改为可空的无约束历史列或删列（研究产物表要保留） |
| `research_benchmarks` | `research_benchmarks_execution_id_fkey` → `runtime_executions` | 去掉外键；`execution_id` 列改为可空的无约束历史列或删列（研究产物表要保留） |
| `fusion_compares` | `fusion_compares_group_ref` → `fusion_billing_groups` | 去掉外键；`group_ref`/`run_ref`/`call_ref` 列随评审团/对比改接 `turns` 时处理 |
| `research_benchmark_shortfalls` | `research_benchmark_shortfalls_execution_id_fkey` → `runtime_executions` | 去掉外键；`execution_id` 列改为可空的无约束历史列或删列（研究产物表要保留） |

其他带旧字样的列（没有外键，但读者要先改）：`ai_usage_logs.bill2_run_id`、`ai_usage_logs.bill2_call_id`、`credit_transactions.bill2_run_id`、`credit_transactions.bill2_call_id`、`research_operations.bill2_call_id`、`token_stats.bill2_run_id`、`token_stats.bill2_call_id`、`library_recognition_units.bill2_request_id`、`social_review_runs.runtime_request_id`、`social_review_runs.runtime_execution_id`、`social_review_runs.bill2_run_id`、`social_review_runs.runtime_session_id`、`social_review_runs.prior_bill2_run_ids`、`social_publish_jobs.bill2_run_id`。

保留的表上引用 `bill2_*` 的检查约束：`token_stats.token_stats_legacy_usage_required`、`token_stats.token_stats_execution_scope`、`social_review_runs.social_review_runs_coach_check`。

保留的表上、由待删函数驱动的触发器（DROP 函数前必须先 DROP 触发器，否则 DROP 失败）：`credit_transactions.runtime_stop_loss_settlement_lock->runtime_stop_loss_settled`、`credit_transactions.runtime_stop_loss_settled->runtime_stop_loss_settled`、`system_settings.runtime_stop_loss_settings_guard->runtime_stop_loss_settings_guard`。待删表上的 44 个触发器随表消失。

## C. 计划删除的函数（201 个）

按第 5.3 节的命名规则圈出：`runtime_*`（除 `runtime_start`）、`bill2_*`、`fusion_billing*`、`report_fee*`、`fusion_review_fee*`，另含 `report_stop`、`report_admission_check`。
带 ※ 的是**现在仍有现役 Node 代码调用**（含旧 tRPC、cron、注销、复盘、声音）：这些在调用方改完之前不能删。

**bill2_***（74）：`bill2_actor`、`bill2_admin_call_report`、`bill2_call_erasure_guard`、`bill2_calls_kind_guard`、`bill2_cancel`※、`bill2_claim`※、`bill2_close`※、`bill2_create_draft`※、`bill2_decimal`、`bill2_dispatch`※、`bill2_erasure_call_payload`、`bill2_erasure_closed`、`bill2_erasure_fields`、`bill2_erasure_receipt_projection`、`bill2_erasure_run_payload`、`bill2_erasure_view`、`bill2_evidence_immutable`、`bill2_execution_allowed`、`bill2_finalize`※、`bill2_financial_projection`、`bill2_legacy_abort_settle`、`bill2_legacy_finalize_abort`、`bill2_legacy_finalize_failure`、`bill2_legacy_finalize_success`、`bill2_legacy_refund`※、`bill2_legacy_settle`※、`bill2_outcome_projection`、`bill2_payg_absorb_report`※、`bill2_payg_admin_settle_call`、`bill2_payg_block_lock`、`bill2_payg_call_stuck`、`bill2_payg_claim`、`bill2_payg_compensate`、`bill2_payg_finalize`、`bill2_payg_financial_binding`、`bill2_payg_image`、`bill2_payg_lock_models`、`bill2_payg_metering_hash`、`bill2_payg_metering_review_snapshot`※、`bill2_payg_nominal`、`bill2_payg_prices`、`bill2_payg_review_invalidate_call`、`bill2_payg_review_invalidate_receipt`、`bill2_payg_review_metering`※、`bill2_payg_stuck_calls`、`bill2_payg_tool_settlement`、`bill2_payg_validate_quote`、`bill2_payg_validate_tool_quote`、`bill2_payg_zero_source`、`bill2_pending_calls`※、`bill2_prepare`※、`bill2_private_input`※、`bill2_public`、`bill2_read`※、`bill2_receipt_raw_due`、`bill2_receipt_raw_scrub`、`bill2_receipts_scrub_raw`、`bill2_record`※、`bill2_record_tool`、`bill2_recovery_claim`※、`bill2_revoke_draft`※、`bill2_revoke_unstarted_dispatch`※、`bill2_run_erasure_guard`、`bill2_scope_allowed`、`bill2_scope_allowed_before_library`、`bill2_scope_allowed_before_memo`、`bill2_scope_allowed_before_opc`、`bill2_scope_allowed_before_topic`、`bill2_tool_cost`、`bill2_tool_cost_reconcile`、`bill2_tool_model_id`、`bill2_tool_pending_guard`、`bill2_unit_multiplier`、`bill2_usage_total`

**fusion_*（计费）**（6）：`fusion_billing_guard`、`fusion_review_fee_hold`、`fusion_review_fee_settle`※、`fusion_review_fee_settle_due`、`fusion_review_fee_settle_internal`、`fusion_review_fee_view`

**report_***（8）：`report_admission_check`、`report_fee_hold`、`report_fee_settle`※、`report_fee_settle_due`※、`report_fee_settle_internal`、`report_fee_terminal_settlement`、`report_fee_view`、`report_stop`※

**runtime_***（113）：`runtime_admission_replay`※、`runtime_admit`、`runtime_admit_commit`、`runtime_admit_precheck`、`runtime_admit_source_check`、`runtime_billing_allowed`、`runtime_binding_guard`、`runtime_cancel`※、`runtime_cancel_with_code`、`runtime_capacity_marker_arm`※、`runtime_capacity_marker_since`※、`runtime_check_memo_close`、`runtime_check_memo_get`、`runtime_check_memo_open`、`runtime_check_memo_put`、`runtime_context_allowed`、`runtime_context_allowed_before_workspace`、`runtime_direct_billing_allowed`、`runtime_direct_billing_allowed_before_opc`、`runtime_direct_billing_allowed_before_topic`、`runtime_execution`※、`runtime_execution_visibility`※、`runtime_financial_recovery`※、`runtime_history_availability`、`runtime_history_availability_before_memo`、`runtime_history_available`、`runtime_history_available_before_memo`、`runtime_interrupt_capacity`、`runtime_interrupted_recovery`、`runtime_library_propagate`※、`runtime_library_read`※、`runtime_library_references_freeze`、`runtime_library_sources_gone`、`runtime_library_tool_guard`、`runtime_library_visible`※、`runtime_load_skill_allowed`、`runtime_load_skill_entry`、`runtime_load_skill_result_valid`、`runtime_matching_call_guard`、`runtime_material`⚠、`runtime_material_allowed`⚠、`runtime_material_allowed_before_b1`⚠、`runtime_mentor_history`※、`runtime_mentor_history_draft`、`runtime_mentor_history_guard`、`runtime_mentor_messages`、`runtime_pending_financial_batch`※、`runtime_positioning_gate`※、`runtime_production_access`※、`runtime_production_allowed`、`runtime_production_database`、`runtime_production_enabled`、`runtime_production_recovery_policy`※、`runtime_rate_limits_patch`、`runtime_read_verified`、`runtime_receipt_saved`※、`runtime_response`、`runtime_rw_flag`、`runtime_session_context`※、`runtime_session_items`※、`runtime_session_names_owner_guard`、`runtime_session_result_delete`※、`runtime_session_result_edit`※、`runtime_session_result_save`※、`runtime_session_result_save_turn`※、`runtime_session_result_title`、`runtime_session_result_turn_view`、`runtime_session_result_versions`※、`runtime_session_result_view`、`runtime_session_results_list`、`runtime_session_results_list_turns`※、`runtime_session_results_owner_guard`、`runtime_session_results_session`、`runtime_set_stop_new_calls`※、`runtime_source`※、`runtime_source_checkpoint`、`runtime_stale_charged_rounds`※、`runtime_stale_round_compensate`※、`runtime_stop_loss_alert`※、`runtime_stop_loss_assert`、`runtime_stop_loss_call_guard`、`runtime_stop_loss_config`、`runtime_stop_loss_observe`※、`runtime_stop_loss_settings_guard`、`runtime_stop_loss_settled`、`runtime_stop_loss_usage`※、`runtime_test_actor_access`※、`runtime_test_budget_guard`、`runtime_test_dispatch_guard`、`runtime_test_policy`※、`runtime_test_recovery_policy`※、`runtime_test_window_allowed`、`runtime_tool`※、`runtime_update_rate_limits`※、`runtime_update_stop_loss`※、`runtime_view`※、`runtime_view_with_work_items`、`runtime_voice_references_freeze`、`runtime_voice_source_gone`、`runtime_voice_sources_gone`、`runtime_work_items`、`runtime_work_projection`⚠、`runtime_work_projection_before_opc`⚠、`runtime_workspace_benchmark_guard`、`runtime_workspace_post_window`※、`runtime_workspace_posts_guard`、`runtime_workspace_posts_history_erased`、`runtime_workspace_posts_history_visible`、`runtime_workspace_posts_receipt_ready`、`runtime_workspace_posts_visible`※、`runtime_workspace_session`※、`runtime_workspace_source`※、`runtime_workspace_tool_guard`

带 ⚠ 的是**新路径仍在用、按命名规则圈进来但不能删**的函数：`runtime_material`（素材快照的写入口，opc_library_edit、opc_handoff、opc_step_material、opc_topic_bind、opc_video_material_prepare、opc_work_ui_change 直接调用）；`runtime_work_projection`（runtime_material 调用，turn_mentor_context 注释引用）；`runtime_work_projection_before_opc`（同上的旧版本）；`runtime_material_allowed`（素材读取判定）；`runtime_material_allowed_before_b1`（同上的旧版本）。它们要改写掉对 `bill2_actor`、`bill2_scope_allowed`、`runtime_executions` 的引用后保留（方案 0.5）。

### C.1 现役 Node 仍在调用的待删函数

| 函数 | 现役调用方 |
|---|---|
| `bill2_cancel` | `services/accountErasure/processor.ts`、`services/turn/provider/service.ts` |
| `bill2_claim` | `services/turn/provider/service.ts` |
| `bill2_close` | `services/publishMonitor/billedReadLegacy.ts`、`services/turn/provider/service.ts` |
| `bill2_create_draft` | `services/fusion/admission.ts`、`services/fusion/compareAdmission.ts`、`services/turn/provider/service.ts` |
| `bill2_dispatch` | `services/turn/provider/service.ts` |
| `bill2_finalize` | `services/accountErasure/processor.ts`、`services/publishMonitor/billedReadLegacy.ts`、`services/turn/provider/service.ts` |
| `bill2_payg_absorb_report` | `services/bill2PlatformAlerts.ts` |
| `bill2_payg_metering_review_snapshot` | `services/turn/settings/meteringReview.ts` |
| `bill2_payg_review_metering` | `services/turn/settings/meteringReview.ts` |
| `bill2_pending_calls` | `services/turn/provider/service.ts` |
| `bill2_prepare` | `services/turn/provider/service.ts` |
| `bill2_private_input` | `services/turn/provider/service.ts` |
| `bill2_read` | `services/accountErasure/processor.ts`、`services/publishMonitor/billedReadLegacy.ts`、`services/turn/provider/readRetry.ts`、`services/turn/provider/service.ts` |
| `bill2_record` | `services/turn/provider/service.ts` |
| `bill2_recovery_claim` | `services/turn/provider/service.ts` |
| `bill2_revoke_draft` | `services/turn/provider/service.ts` |
| `bill2_revoke_unstarted_dispatch` | `services/turn/provider/service.ts` |
| `fusion_review_fee_settle` | `services/fusion/reviewRecord.ts` |
| `report_fee_settle` | `services/report/service.ts` |
| `report_fee_settle_due` | `services/report/fees.ts` |
| `report_stop` | `routers/runtime.ts` |
| `runtime_admission_replay` | `services/opc/captureReplay.ts`、`services/opc/service.ts`、`services/report/service.ts` |
| `runtime_cancel` | `services/publishMonitor/reviews.ts`、`services/turn/admission/positioningFallback.ts` |
| `runtime_capacity_marker_arm` | `services/turn/settings/staleChargedRounds.ts` |
| `runtime_capacity_marker_since` | `services/turn/settings/staleChargedRounds.ts` |
| `runtime_execution` | `services/opc/captureReplay.ts`、`services/opc/stepOutput.ts`、`services/report/service.ts`、`services/turn/admission/positioningFallback.ts`、`services/turn/agent/contentSource.ts` |
| `runtime_execution_visibility` | `services/accountErasure/content.ts` |
| `runtime_financial_recovery` | `services/accountErasure/processor.ts` |
| `runtime_library_propagate` | `services/library/cleanup.ts` |
| `runtime_library_read` | `services/turn/research/libraryReadTool.ts` |
| `runtime_library_visible` | `services/turn/research/libraryReadTool.ts` |
| `runtime_mentor_history` | `services/turn/agent/mentorHistory.ts` |
| `runtime_positioning_gate` | `services/turn/admission/positioningGate.ts` |
| `runtime_production_access` | `services/turn/settings/productionPolicy.ts` |
| `runtime_production_recovery_policy` | `services/turn/settings/stagingPolicy.ts` |
| `runtime_receipt_saved` | `services/turn/provider/readRetry.ts`、`services/turn/provider/service.ts` |
| `runtime_session_context` | `services/opc/service.ts` |
| `runtime_session_items` | `services/turn/agent/session.ts` |
| `runtime_session_result_delete` | `services/opc/sessionResults.ts` |
| `runtime_session_result_edit` | `services/opc/sessionResults.ts` |
| `runtime_session_result_save` | `services/opc/sessionResults.ts` |
| `runtime_session_result_save_turn` | `services/opc/sessionResults.ts` |
| `runtime_session_result_versions` | `services/opc/sessionResults.ts` |
| `runtime_session_results_list_turns` | `services/opc/sessionResults.ts` |
| `runtime_set_stop_new_calls` | `routers/runtimeSettingsTestHarness.ts`、`services/turn/settings/rateLimitSettings.ts` |
| `runtime_source` | `services/turn/research/sourceRuntimeTool.ts` |
| `runtime_stale_charged_rounds` | `services/turn/settings/staleChargedRounds.ts` |
| `runtime_stale_round_compensate` | `services/turn/settings/staleChargedRounds.ts` |
| `runtime_stop_loss_alert` | `services/turn/settings/stopLossMonitor.ts` |
| `runtime_stop_loss_observe` | `services/turn/settings/stopLossMonitor.ts` |
| `runtime_stop_loss_usage` | `services/turn/settings/stopLossSettings.ts` |
| `runtime_test_actor_access` | `services/turn/settings/stagingPolicy.ts` |
| `runtime_test_policy` | `services/turn/settings/stagingPolicy.ts` |
| `runtime_test_recovery_policy` | `services/turn/settings/stagingPolicy.ts` |
| `runtime_tool` | `services/turn/agent/mentorHistory.ts`、`services/turn/research/libraryReadTool.ts`、`services/turn/research/sourceRuntimeTool.ts`、`services/turn/skills/loadSkillTool.ts`、`services/turn/skills/skillFileExecution.ts` |
| `runtime_update_rate_limits` | `routers/runtimeSettingsTestHarness.ts`、`services/turn/settings/rateLimitSettings.ts` |
| `runtime_update_stop_loss` | `routers/runtimeSettingsTestHarness.ts`、`services/turn/settings/stopLossSettings.ts` |
| `runtime_view` | `services/opc/captureReplay.ts`、`services/opc/service.ts` |
| `runtime_workspace_post_window` | `services/turn/agent/workspacePosts.ts` |
| `runtime_workspace_posts_visible` | `services/turn/research/sourceRuntimeTool.ts` |
| `runtime_workspace_session` | `services/turn/agent/workspacePosts.ts` |
| `runtime_workspace_source` | `services/fusion/compareLoad.ts`、`services/turn/research/sourceRuntimeTool.ts` |

另有运行手册 `docs/runbooks/BILL2_V1_PENDING_READONLY.sql` 引用 10 个待删函数，删除时随手册一起改。

## D. 没列入删除、但引用了待删对象的函数（188 个）

这些函数要么改写、要么随调用方一起删，否则 DROP 后调用即报错。其中 25 个现在已无入口（不被现役 Node、触发器或其他保留函数调用）。
处理码：**D** 现已无入口，随迁移直接删；**H** 只用 `bill2_actor`/`bill2_scope_allowed`/`bill2_decimal` 这几个通用小函数（`bill2_actor` 只查 `profiles`），保留或改名这三个小函数即可，调用方不用动；**W** 引用的是 `runtime_*` 旧表或旧函数，要改写（整段 `CREATE OR REPLACE`）；**B** 引用 BILL2 计费表/函数，随计费消费者一起改写或删除。

合计：D 25、H 46、W 61、B 56。

### D.定位、选题、work_item（opc）（71）

| 函数 | 码 | 引用的待删表 | 引用的待删函数 | 现役 Node 调用 |
|---|---|---|---|---|
| `opc_result_link_available` | W |  | `runtime_history_available` | — |
| `opc_source_allowed` | W |  | `runtime_check_memo_get`、`runtime_check_memo_put` | — |
| `opc_business_context` | W |  | `runtime_check_memo_get`、`runtime_check_memo_put` | — |
| `opc_work_results` | W | `runtime_executions` | `bill2_actor`、`bill2_scope_allowed` | `service.ts` |
| `opc_work_result_turn` | H |  | `bill2_actor` | `service.ts` |
| `opc_start` | H |  | `bill2_actor`、`bill2_scope_allowed` | — |
| `opc_handoff` | W |  | `bill2_actor`、`runtime_material` | `handoff-envelope.ts` |
| `opc_data_turn` | H |  | `bill2_actor`、`bill2_scope_allowed` | — |
| `opc_data_source_turn` | W | `runtime_executions` |  | — |
| `opc_work_result` | W | `runtime_executions` | `bill2_actor`、`runtime_history_available` | `service.ts` |
| `opc_revise_before_account_strategy` | H |  | `bill2_actor`、`bill2_scope_allowed` | — |
| `opc_work_verify` | W | `runtime_scope_material` |  | `db.ts` |
| `opc_content_from_turn` | H |  | `bill2_actor` | `turnContent.ts` |
| `opc_video_turn_check` | W | `runtime_scope_material`、`runtime_executions` | `bill2_actor`、`runtime_history_available` | — |
| `opc_video_results_from_turn` | H |  | `bill2_actor` | `turnContent.ts` |
| `opc_work_check` | W | `runtime_scope_material` |  | `db.ts` |
| `opc_query_before_mentor_basis` | W | `runtime_executions` | `bill2_actor`、`bill2_scope_allowed` | — |
| `opc_topic_read_before_opening` | H |  | `bill2_actor` | — |
| `opc_plan_request_state` | B | `runtime_executions`、`runtime_scope_material`、`bill2_runs` | `bill2_actor`、`bill2_scope_allowed` | `service.ts` |
| `opc_topic_bind` | W | `runtime_scope_material` | `bill2_actor`、`runtime_material` | `service.ts` |
| `opc_topic_read` | W | `runtime_executions` |  | `service.ts` |
| `opc_content_allowed` | W |  | `runtime_history_available` | — |
| `opc_topic_material` | W | `runtime_scope_material` | `bill2_actor` | `service.ts` |
| `opc_query_before_entry_projection` | W | `runtime_executions` |  | — |
| `opc_video_material_prepare` | W | `runtime_scope_material` | `bill2_actor`、`runtime_material` | `service.ts` |
| `opc_video_runtime_binding_guard` ‹触发器 1› | W | `runtime_scope_material`、`runtime_executions` |  | — |
| `opc_video_results_from_execution` | W | `runtime_executions` | `bill2_actor`、`runtime_history_available` | `service.ts` |
| `opc_handoff_b1` | H |  | `bill2_actor` | `service.ts` |
| `opc_topic_draft_save` | H |  | `bill2_actor` | — |
| `opc_account_strategy_begin` | H |  | `bill2_actor` | `service.ts` |
| `opc_content_from_execution` | W | `runtime_executions` | `bill2_actor`、`runtime_history_available` | `service.ts` |
| `opc_video_package_from_execution` | W | `runtime_executions` | `bill2_actor`、`runtime_history_available` | `service.ts` |
| `opc_topic_original` | W | `runtime_executions` |  | — |
| `opc_adopt_topics` | H |  | `bill2_actor` | — |
| `opc_account_ui_change` | H |  | `bill2_actor` | `service.ts` |
| `opc_revise` | H |  | `bill2_actor` | `service.ts` |
| `opc_work_ui_change` | W | `runtime_scope_material` | `bill2_actor`、`runtime_material` | `service.ts` |
| `opc_library_before_workspace_ui` | H |  | `bill2_actor` | — |
| `opc_content_manual_save` | H |  | `bill2_actor` | `turnContent.ts` |
| `opc_position_history` | H |  | `bill2_actor`、`bill2_scope_allowed` | `service.ts` |
| `opc_account_strategy_history` | H |  | `bill2_actor` | `service.ts` |
| `opc_account_strategy_save` | H |  | `bill2_actor` | — |
| `opc_account_strategy_schema` | H |  | `bill2_actor` | `service.ts` |
| `opc_account_strategy_save_checked` | H |  | `bill2_actor` | `service.ts` |
| `opc_free_conversations` | W | `runtime_executions`、`runtime_session_names` | `runtime_check_memo_open`、`bill2_actor`、`bill2_scope_allowed`+2 | `opc.ts` |
| `opc_video_execution_check` | W | `runtime_executions`、`runtime_scope_material` | `bill2_actor`、`runtime_history_available` | `service.ts` |
| `opc_query` | W | `runtime_executions` | `runtime_history_availability` | `runtime.ts`、`readonlyDraft.ts` 等3 |
| `opc_account_refresh_confirmations` | H |  | `bill2_actor`、`bill2_scope_allowed` | — |
| `opc_capture_apply` | W | `runtime_executions` | `bill2_actor`、`bill2_scope_allowed`、`runtime_history_availability`+1 | `capture.ts` |
| `opc_capture_resolve` | W | `runtime_executions` | `bill2_actor`、`bill2_scope_allowed`、`runtime_history_available` | `service.ts` |
| `opc_data_execution` | W | `runtime_executions` | `bill2_actor`、`runtime_history_available`、`bill2_scope_allowed` | — |
| `opc_information` | H |  | `bill2_actor`、`bill2_scope_allowed` | `CONVERSATION_CAPTURE_B1.sql`、`service.ts` |
| `opc_adopt_topics_with_source` | W | `runtime_executions` | `bill2_actor`、`runtime_history_available` | `dataFoundation.ts` |
| `opc_content_reaction` | W | `runtime_executions` |  | `dataFoundation.ts` |
| `opc_conversation_rename` | W | `runtime_session_names` | `bill2_actor` | `conversationName.ts` |
| `opc_brief_adoption` | W | `runtime_executions` |  | `dataFoundation.ts` |
| `opc_historical_reach` | H |  | `bill2_actor`、`bill2_scope_allowed` | — |
| `opc_topic_draft_read` | H |  | `bill2_actor` | `service.ts` |
| `opc_plan_result` | W | `runtime_executions` | `bill2_actor`、`runtime_history_available` | `service.ts` |
| `opc_content_source_current` | H |  | `bill2_actor`、`bill2_scope_allowed` | `contentSource.ts` |
| `opc_library_edit` | W | `runtime_scope_material` | `bill2_actor`、`runtime_material` | `service.ts` |
| `opc_start_b1` | H |  | `bill2_actor` | `start.ts` |
| `opc_target_business` | B | `bill2_runs`、`fusion_billing_groups`、`runtime_executions` |  | — |
| `opc_businesses_list` | H |  | `bill2_actor` | `businessArchive.ts` |
| `opc_save_result` | W | `runtime_executions` | `bill2_actor`、`runtime_history_available` | `service.ts` |
| `opc_save_plan` | H |  | `bill2_actor` | `service.ts` |
| `opc_step_material` | B | `runtime_scope_material`、`runtime_executions`、`bill2_runs` | `bill2_actor`、`runtime_material` | `service.ts` |
| `opc_topic_consent` | W | `runtime_scope_material` | `bill2_actor`、`runtime_material` | `service.ts` |
| `opc_publication_ui_change` | H |  | `bill2_actor` | `service.ts` |
| `opc_business_archive` | B | `bill2_runs`、`bill2_calls` | `bill2_actor` | `businessArchive.ts` |
| `opc_review_archive_guard` ‹触发器 1› | B | `fusion_review_fees`、`bill2_runs`、`fusion_billing_groups`、`bill2_calls` |  | — |

### D.评审团与对比（44）

| 函数 | 码 | 引用的待删表 | 引用的待删函数 | 现役 Node 调用 |
|---|---|---|---|---|
| `fusion_review_end_paused` | D | `bill2_runs`、`bill2_calls` |  | — |
| `fusion_compare_dispatch_release` | D | `bill2_calls`、`bill2_runs` | `bill2_actor` | — |
| `fusion_review_pause_idle` | D | `bill2_runs`、`bill2_calls` |  | — |
| `fusion_review_breaker_usage` | B | `fusion_review_fees`、`bill2_calls`、`bill2_runs`、`fusion_billing_groups` |  | — |
| `fusion_review_turn_source` | B | `bill2_calls`、`bill2_runs` |  | `fusionCalls.ts` |
| `fusion_group_claim` | B | `fusion_billing_groups`、`fusion_billing_group_steps`、`bill2_calls`、`bill2_runs` | `bill2_claim`、`bill2_unit_multiplier` | `service.ts` |
| `fusion_review_start` | B | `bill2_calls`、`bill2_runs` | `bill2_actor`、`fusion_review_fee_hold` | `reviewRecord.ts` |
| `fusion_review_view` | B | `bill2_runs`、`bill2_calls` | `fusion_review_fee_view` | — |
| `fusion_group_create` | B | `fusion_billing_groups` | `bill2_actor` | — |
| `fusion_group_admit` | B | `fusion_billing_groups`、`bill2_runs`、`runtime_executions` | `bill2_actor`、`bill2_decimal`、`bill2_prepare` | `admission.ts`、`compareAdmission.ts` |
| `fusion_call_output_read` | B | `fusion_billing_groups`、`bill2_runs`、`bill2_calls` | `bill2_actor` | `executor.ts`、`review.ts` 等3 |
| `fusion_call_output_save` | B | `bill2_calls`、`bill2_runs`、`fusion_billing_groups` | `bill2_actor`、`bill2_erasure_closed` | `executor.ts` |
| `fusion_call_verdict` | B | `bill2_calls`、`bill2_runs` | `bill2_erasure_closed` | `executor.ts`、`reviewCore.ts` |
| `fusion_pending_financial_batch` | D | `bill2_runs`、`bill2_calls` |  | — |
| `fusion_review_read` | H |  | `bill2_actor` | `reviewRecord.ts` |
| `fusion_review_claim` | B | `fusion_billing_groups`、`fusion_review_fees` | `bill2_actor` | `reviewRecord.ts` |
| `fusion_review_advance` | B |  | `bill2_actor`、`fusion_review_fee_settle_internal` | `reviewRecord.ts` |
| `fusion_review_close` | B | `bill2_runs` | `bill2_actor`、`fusion_review_fee_settle_internal`、`bill2_cancel`+1 | `reviewRecord.ts` |
| `fusion_review_source` | H |  | `bill2_actor` | `fusionSettings.ts`、`reviewCore.ts` |
| `fusion_review_preview` | H |  | `bill2_actor` | `reviewPlan.ts`、`jury.ts` |
| `fusion_review_admin_read` | B | `bill2_runs`、`bill2_calls` |  | `fusionSettings.ts`、`reviewEvidenceFlow.ts` |
| `fusion_review_admin_list` | B | `bill2_runs`、`bill2_calls`、`fusion_review_fees` | `fusion_review_fee_view` | `fusionSettings.ts` |
| `fusion_review_unjudged` | D | `bill2_runs`、`bill2_calls` |  | — |
| `fusion_review_adoption_record` | H |  | `bill2_actor` | `reviewRecord.ts` |
| `fusion_review_mine` | H |  | `bill2_actor` | `fusionReview.ts` |
| `fusion_review_mark_seen` | H |  | `bill2_actor` | `fusionReview.ts` |
| `fusion_compare_active` | B | `bill2_runs`、`bill2_calls` |  | — |
| `fusion_compare_begin` | D | `runtime_executions`、`bill2_runs` | `bill2_actor`、`runtime_workspace_tool_guard` | — |
| `fusion_compare_read` | D | `bill2_runs`、`bill2_calls` | `bill2_actor`、`bill2_public` | — |
| `fusion_compare_claim` | D | `bill2_runs` | `bill2_actor` | — |
| `fusion_compare_stop` | D | `bill2_runs`、`fusion_billing_group_steps` | `bill2_actor`、`bill2_cancel`、`bill2_finalize` | — |
| `fusion_group_fee_guard` ‹触发器 1› | B | `bill2_runs`、`bill2_calls` |  | — |
| `fusion_compare_adopt` | D | `bill2_runs`、`runtime_executions`、`bill2_calls`、`runtime_session_batches`+1 | `bill2_actor`、`runtime_context_allowed`、`bill2_prepare`+2 | — |
| `fusion_compare_stop_archived` | D |  | `bill2_actor` | — |
| `fusion_compare_material_token` | W |  | `runtime_session_context` | — |
| `fusion_compare_material_guard` | W |  | `runtime_session_context`、`runtime_material_allowed` | — |
| `fusion_compare_context` | B | `runtime_session_history`、`runtime_history_dependencies`、`runtime_library_references`、`runtime_executions`+1 | `bill2_actor`、`runtime_session_context`、`runtime_history_availability` | `compareLoad.ts` |
| `fusion_compare_end` | D |  | `bill2_actor` | — |
| `fusion_compare_gate` | D |  | `bill2_actor` | — |
| `fusion_group_attach` | B | `bill2_runs`、`fusion_billing_groups`、`bill2_calls` |  | — |
| `fusion_review_archive_reconcile` | B | `fusion_review_fees`、`bill2_runs`、`fusion_billing_groups`、`bill2_calls` | `bill2_actor`、`bill2_cancel`、`bill2_finalize`+1 | — |
| `fusion_compare_unjudged` | D | `bill2_runs`、`bill2_calls` |  | — |
| `fusion_compare_dispatch_claim` | D | `bill2_calls`、`bill2_runs` | `bill2_actor` | — |
| `fusion_compare_list` | D |  | `bill2_actor` | — |

### D.注销与内容删除（27）

| 函数 | 码 | 引用的待删表 | 引用的待删函数 | 现役 Node 调用 |
|---|---|---|---|---|
| `account_erasure_scrub_runtime` | B | `runtime_executions`、`bill2_runs`、`runtime_history_dependencies`、`runtime_session_batches`+3 |  | `processor.ts` |
| `account_erasure_note_error` | B | `bill2_runs`、`runtime_executions` |  | `financialRecovery.ts`、`service.ts` |
| `account_erasure_preview` | B | `bill2_runs` |  | `service.ts` |
| `account_erasure_scrub_content` | B | `runtime_session_names`、`fusion_review_fees`、`runtime_session_results`、`report_fees` | `fusion_review_fee_settle_internal`、`report_fee_settle_internal` | `processor.ts` |
| `account_erasure_financial_batch` | B | `bill2_calls`、`bill2_runs`、`runtime_executions` | `bill2_erasure_closed` | `financialRecovery.ts` |
| `account_erasure_scrub_receipts` | B | `bill2_runs`、`bill2_calls`、`bill2_receipts` | `bill2_erasure_receipt_projection` | `processor.ts` |
| `account_erasure_scrub_run` | B | `bill2_runs`、`bill2_calls`、`bill2_receipts` | `bill2_erasure_run_payload`、`bill2_outcome_projection` | `processor.ts` |
| `account_erasure_scrub_calls` | B | `bill2_runs`、`bill2_calls`、`bill2_receipts` | `bill2_payg_lock_models`、`bill2_erasure_call_payload` | `processor.ts` |
| `account_erasure_detach_runtime` | B | `bill2_runs`、`runtime_executions`、`bill2_calls`、`bill2_receipts` | `bill2_erasure_closed` | `processor.ts` |
| `account_erasure_local_remaining` | W | `runtime_test_windows` |  | — |
| `account_erasure_work_batch` | B | `bill2_runs`、`bill2_calls`、`bill2_receipts` |  | `host.ts`、`processor.ts` |
| `account_erasure_prune_business` | B | `runtime_test_windows`、`runtime_voice_references`、`runtime_library_references`、`runtime_history_dependencies`+6 |  | — |
| `content_erasure_confirm` | B | `runtime_executions`、`bill2_runs`、`runtime_history_dependencies`、`report_fees`+8 | `bill2_actor`、`report_fee_settle_internal`、`runtime_financial_recovery`+3 | `content.ts` |
| `content_erasure_preview` | H |  | `bill2_actor` | `content.ts` |
| `content_erasure_visible` | D | `runtime_executions` | `bill2_actor` | — |
| `content_erasure_financial_allowed` | B | `bill2_runs` | `bill2_erasure_closed`、`bill2_payg_financial_binding` | — |
| `content_erasure_runtime_check` | W | `runtime_executions` |  | — |
| `content_erasure_scope` | W | `runtime_executions`、`runtime_tool_calls`、`runtime_scope_material`、`runtime_history_dependencies` |  | — |
| `content_erasure_ledger_owned` | B | `bill2_runs` |  | — |
| `content_erasure_saved_readable` | W | `runtime_executions` | `runtime_history_available` | — |
| `content_erasure_parent_guard` ‹触发器 21› | W | `runtime_executions`、`runtime_scope_material`、`runtime_session_history`、`runtime_session_batches`+2 |  | — |
| `content_erasure_artifact_readable` | W | `runtime_executions` | `bill2_actor` | — |
| `content_erasure_capture_steps` | W | `runtime_executions` |  | — |
| `content_erasure_mark_session` | B | `runtime_executions`、`fusion_billing_groups`、`runtime_scope_material` | `bill2_actor` | `content.ts` |
| `erasure_business_owner` | W | `runtime_voice_references`、`runtime_library_references`、`runtime_executions`、`runtime_tool_calls`+4 |  | — |
| `account_erasure_financial_proof` | B | `bill2_runs`、`bill2_calls`、`bill2_receipts`、`fusion_review_fees`+1 |  | — |
| `account_erasure_body_remaining` | W | `runtime_session_results`、`runtime_session_names`、`runtime_executions`、`runtime_scope_material`+4 |  | — |

### D.其他（12）

| 函数 | 码 | 引用的待删表 | 引用的待删函数 | 现役 Node 调用 |
|---|---|---|---|---|
| `turn_open` | W | `runtime_executions` |  | `db.ts` |
| `turn_mentor_context` | W | `runtime_executions` |  | — |
| `turn_stop` | B | `report_fees` |  | `db.ts` |
| `mentor_source_check` | H |  | `bill2_scope_allowed` | `mentor.ts`、`plan.ts` |
| `session_view_allowed` | H |  | `bill2_scope_allowed` | `view.ts` |
| `workspace_turn_read` | W | `runtime_executions` |  | `workspace.ts` |
| `turn_plan_context` | W | `runtime_executions` |  | — |
| `plan_turn_read` | H |  | `bill2_scope_allowed` | `planHttp.ts` |
| `artifact_save_candidate` | W | `runtime_executions` |  | `workbench.ts` |
| `topic_turn_source` | W | `runtime_scope_material`、`runtime_executions` |  | `topic.ts` |
| `artifact_evidence_allowed` | W |  | `runtime_check_memo_get`、`runtime_check_memo_put` | — |
| `runtime_start` | B |  | `bill2_actor`、`bill2_scope_allowed`、`bill2_create_draft` | — |

### D.研究（9）

| 函数 | 码 | 引用的待删表 | 引用的待删函数 | 现役 Node 调用 |
|---|---|---|---|---|
| `research_runtime_call_charge` | D | `bill2_calls`、`bill2_runs`、`runtime_executions` | `bill2_unit_multiplier` | — |
| `research_operation_settled` | B | `bill2_calls` |  | — |
| `research_session_owned` | H |  | `bill2_actor` | — |
| `research_user_message` | D | `runtime_executions` |  | — |
| `research_runtime_link` | D | `bill2_calls`、`bill2_runs`、`runtime_executions` |  | — |
| `research_user_evidence` | W | `runtime_session_names` | `bill2_actor` | `userApi.ts` |
| `research_user_tool_charges` | H |  | `bill2_actor` | `userApi.ts` |
| `research_chat_benchmark_accounts` | W |  | `runtime_workspace_source` | `chatToolDeps.ts` |
| `research_test_window_sync_prices` | B | `runtime_test_windows` | `bill2_tool_cost` | `priceRefresh.ts` |

### D.报告（8）

| 函数 | 码 | 引用的待删表 | 引用的待删函数 | 现役 Node 调用 |
|---|---|---|---|---|
| `turn_report_admit` | B | `report_fees`、`runtime_executions` |  | — |
| `report_membership_check` | H |  | `bill2_actor` | `creditPackageMembership.ts`、`service.ts` 等3 |
| `report_source` | H |  | `bill2_actor`、`bill2_scope_allowed` | `preflight.ts`、`service.ts` 等3 |
| `report_model_window` | W | `runtime_test_windows` | `bill2_actor` | `settingsAdmin.ts`、`modelSettings.ts` |
| `report_final_snapshot` | W | `runtime_executions` |  | — |
| `report_document_source` | H |  | `bill2_actor` | — |
| `report_source_for_read` | H |  | `bill2_actor`、`bill2_scope_allowed` | — |
| `report_revision` | H |  | `bill2_actor`、`bill2_scope_allowed` | `revisionSync.ts` |

### D.复盘与社媒监测（8）

| 函数 | 码 | 引用的待删表 | 引用的待删函数 | 现役 Node 调用 |
|---|---|---|---|---|
| `publish_monitor_billed_recovery` | B | `bill2_calls` |  | `billedRead.ts`、`billedReadLegacy.ts` |
| `publish_monitor_tool_only_run` | B |  | `bill2_tool_model_id` | — |
| `publish_monitor_billed_run` | B | `bill2_runs` |  | `billedRead.ts` |
| `publish_monitor_review_supplement` | W |  | `runtime_workspace_post_window` | `reviewData.ts` |
| `publish_monitor_review_step` | B | `runtime_executions`、`bill2_runs` |  | `reviewAdmission.ts`、`reviews.ts` |
| `publish_monitor_review_admit_guard` ‹触发器 1› | B | `bill2_runs` |  | — |
| `publish_monitor_review_result_guard` ‹触发器 1› | W | `runtime_tool_calls` | `runtime_workspace_posts_visible` | — |
| `publish_monitor_reviews` | B | `runtime_tool_calls`、`runtime_executions`、`bill2_runs` | `runtime_workspace_posts_visible` | `reviewOutput.ts` |

### D.账本（7）

| 函数 | 码 | 引用的待删表 | 引用的待删函数 | 现役 Node 调用 |
|---|---|---|---|---|
| `billing_reconcile_day` | B | `bill2_calls` |  | `dailyBillingTotals.ts` |
| `atomic_abort_settle` | D | `bill2_runs`、`bill2_calls` | `bill2_legacy_abort_settle` | — |
| `atomic_finalize_ai_success` | D | `bill2_runs`、`bill2_calls` | `bill2_legacy_finalize_success` | — |
| `atomic_settle` | B | `bill2_runs`、`bill2_calls` | `bill2_legacy_settle` | — |
| `atomic_refund` | B | `bill2_runs`、`bill2_calls` | `bill2_legacy_refund` | — |
| `atomic_finalize_ai_abort` | D | `bill2_runs`、`bill2_calls` | `bill2_legacy_finalize_abort` | — |
| `atomic_finalize_ai_failure` | D | `bill2_runs`、`bill2_calls` | `bill2_legacy_finalize_failure` | — |

### D.声音（2）

| 函数 | 码 | 引用的待删表 | 引用的待删函数 | 现役 Node 调用 |
|---|---|---|---|---|
| `voice_run_recovery` | B | `bill2_runs` |  | — |
| `voice_billing_scrub` | D | `bill2_runs` |  | — |

## E. Node 代码：`services/runtime/`（0+44 个文件）与 `services/bill2/`

两个目录共 45 个非测试文件、117 个测试文件。按“从新路径和平台代码出发能否走到”分三类（不穿过旧消费者）：

### E.1 新路径或平台代码仍在用，必须先搬出（0 个）

第 5.3 节写的“整体删除”不成立：这些文件被 `services/turn/`、`/api/turn/*` 路由、cron、`trpc.ts`、管理后台设置等现役代码导入。**纯搬迁**（只改路径，不改行为）后才能删目录。

| 文件 | 导入方 |
|---|---|

### E.2 只有旧消费者在用，随消费者一起删（45 个）

`bill2/toolSubcall.ts`、`runtime/actor.ts`、`runtime/admission.ts`、`runtime/admissionPayg.ts`、`runtime/admissionRepair.ts`、`runtime/admitSplit.ts`、`runtime/automaticRecovery.ts`、`runtime/callGate.ts`、`runtime/claimNotice.ts`、`runtime/defaultModel.ts`、`runtime/execute.ts`、`runtime/executeContextChecks.ts`、`runtime/executionStream.ts`、`runtime/executionTools.ts`、`runtime/executorOutcome.ts`、`runtime/executorRpc.ts`、`runtime/historyRecovery.ts`、`runtime/historySelection.ts`、`runtime/inflightFinancial.ts`、`runtime/interruptedRecovery.ts`、`runtime/libraryVisibility.ts`、`runtime/moderation.ts`、`runtime/nativeOutput.ts`、`runtime/nativeSession.ts`、`runtime/nativeView.ts`、`runtime/organizerLost.ts`、`runtime/organizerSelection.ts`、`runtime/ownerLostRecovery.ts`、`runtime/paygOwner.ts`、`runtime/paygPricing.ts`、`runtime/paygResume.ts`、`runtime/paygRuntime.ts`、`runtime/paygWaitRecord.ts`、`runtime/realHost.ts`、`runtime/researchExecution.ts`、`runtime/researchStore.ts`、`runtime/skillCatalogAdmission.ts`、`runtime/sourceWorkProgress.ts`、`runtime/stagingTransport.ts`、`runtime/stoppedCompletion.ts`、`runtime/stoppedResult.ts`、`runtime/terminalAgentReply.ts`、`runtime/view.ts`、`runtime/waitingOrganizer.ts`、`runtime/workItems.ts`

### E.3 已无导入（0 个）



### E.4 测试

117 个测试文件在 `services/runtime/`、`services/bill2/` 下；第 6.2 节要求“场景已迁移的才能删”。清单见 `CORE-PATH-V2-DELETE.md` 第 5 节的核对办法。

