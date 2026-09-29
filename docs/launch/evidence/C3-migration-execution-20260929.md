# C3 迁移执行记录与表覆盖复核（2026-09-29）

基线：`origin/staging` 提交 `6a370bc5198fe2cc779d3a83d898fd149bee2069`。
本次只读取仓库；未连接 staging、production 或任何远程数据库，未调用 Supabase
远程工具。覆盖 `packages/db/migrations/` 全部 140 个 SQL 文件（0001–0139，
0018 有两个不同文件，分别列出）。

## 证据口径

- `历史执行报告`：仓库文档明确记载该文件在指定环境执行成功。
  只是对历史报告的归档，**不是本次远端核验，也不证明当前对象与文件一致**。
- `unknown`：未找到足够的逐文件、逐环境执行报告，不等于没有执行过。
- Git 合并、文件存在、摘要、迁移编号账本、测试夹具、Docker 重放、对象存在或
  行为 smoke 均不能单独证明远端执行过该迁移。
- 本表不把旧文档的 `verified` 升级为本次验证结果，未重新打开其中引用的远端报告。

本次搜索仓库 Markdown 中 migration/迁移、applied/已应用、执行结果、
staging/production 相关记录，并读取以下命中。本地重放另见主盘点，不能填入环境列。

| 代号 | file:line | 可支持的历史事实及限制 |
| --- | --- | --- |
| E38 | [RAW_SQL_MIGRATION_LEDGER.md:163](../../runbooks/RAW_SQL_MIGRATION_LEDGER.md#L163) | 163–167 行明确转述 0038 production 执行及时间；staging 缺证。 |
| E39 | [RAW_SQL_MIGRATION_LEDGER.md:252](../../runbooks/RAW_SQL_MIGRATION_LEDGER.md#L252) | 252–256 行明确转述 0039 staging、production 执行；staging 时间缺失。 |
| E44 | [BILLING_ENGINE_EXECUTION_LOG.md:912](../../billing/BILLING_ENGINE_EXECUTION_LOG.md#L912) | 912–915 行明确文件、staging only、执行成功，不只根据历史条目编号推断。 |
| E45 | [BILLING_ENGINE_EXECUTION_LOG.md:1184](../../billing/BILLING_ENGINE_EXECUTION_LOG.md#L1184) | 1184–1187 行明确文件、staging only、执行成功。 |
| E48 | [STG-FIX-STRUCTURE-COMPARISON.md:328](STG-FIX-STRUCTURE-COMPARISON.md#L328) | 328–336 行首次 0048 staging 成功；114–120 行记第二次成功。 |
| E49 | [STG-FIX-STRUCTURE-COMPARISON.md:104](STG-FIX-STRUCTURE-COMPARISON.md#L104) | 104–121 行 C4 staging 执行，0049 一次、0048 累计两次成功，覆盖旧 NOT_EXECUTED。 |

以下线索也已读取，但不能升级为逐文件、逐环境确认：

- [Graylum_Master_Plan_v10.1.md:111](../Graylum_Master_Plan_v10.1.md#L111)
  称生产迁移账本完整应用到 0047，0027–0034 加固曾应用。这是区间级历史概括，
  未附每个文件的执行结果，不据此把 0001–0047 每行改为已执行。
- [Graylum_Master_Plan_v10.1.md:340](../Graylum_Master_Plan_v10.1.md#L340)
  称两个 0018 均已应用，但未区分环境，仍分别列为 `unknown`。
- [RAW_SQL_MIGRATION_LEDGER.md:66](../../runbooks/RAW_SQL_MIGRATION_LEDGER.md#L66)
  明确 0037 staging 直接执行和 production 执行缺证，行为验证不替代执行记录。
- [RAW_SQL_MIGRATION_LEDGER.md:37](../../runbooks/RAW_SQL_MIGRATION_LEDGER.md#L37)
  对 0040 仅保留 Owner 历史提供的线索，并明确仓库可见执行报告未找到，仍为 `unknown`。
- [PHASE4_SECURITY_RLS_AUDIT.md:20](../../PHASE4_SECURITY_RLS_AUDIT.md#L20)
  称 0015 已用于 hosted Supabase，但该段未明确 staging 或 production。
- [STG-FIX-STRUCTURE-COMPARISON.md:322](STG-FIX-STRUCTURE-COMPARISON.md#L322)
  是 production 只读结构比较，326 行明确没有 production mutation，不证明生产执行过 0048/0049。

## 每个迁移的历史环境记录

文件均位于 `packages/db/migrations/`。证据代号指向上表 file:line；`—` 表示未发现
该行足够的逐文件执行报告，上述区间级历史线索仍适用。

| 迁移文件 | staging | production | 证据 |
| --- | --- | --- | --- |
| `0001_ai_billing_tables.sql` | unknown | unknown | — |
| `0002_enable_rls_all_tables.sql` | unknown | unknown | — |
| `0003_atomic_billing_rpc.sql` | unknown | unknown | — |
| `0004_recursive_summary_and_soft_delete.sql` | unknown | unknown | — |
| `0005_diagnostics.sql` | unknown | unknown | — |
| `0006_application_logs.sql` | unknown | unknown | — |
| `0007_performance_indexes.sql` | unknown | unknown | — |
| `0008_modules_schema_update.sql` | unknown | unknown | — |
| `0009_context_length_limit.sql` | unknown | unknown | — |
| `0010_ticket_auto_close_supabase_cron.sql` | unknown | unknown | — |
| `0011_public_maintenance_mode.sql` | unknown | unknown | — |
| `0012_stripe_payments.sql` | unknown | unknown | — |
| `0013_checkin_rewards.sql` | unknown | unknown | — |
| `0014_ai_runtime_closure.sql` | unknown | unknown | — |
| `0015_security_advisor_hardening.sql` | unknown | unknown | — |
| `0016_live_db_drift_security_cleanup.sql` | unknown | unknown | — |
| `0017_scheduled_job_runs.sql` | unknown | unknown | — |
| `0018_payment_fulfillment_atomicity.sql` | unknown | unknown | — |
| `0018_rls_text_flags_and_job_runs.sql` | unknown | unknown | — |
| `0019_public_route_rls_hardening.sql` | unknown | unknown | — |
| `0020_admin_query_indexes.sql` | unknown | unknown | — |
| `0021_supabase_security_advisor_cleanup.sql` | unknown | unknown | — |
| `0022_openrouter_claude_provider_default.sql` | unknown | unknown | — |
| `0023_ai_settle_pricing_metadata.sql` | unknown | unknown | — |
| `0024_atomic_apply_credit_ledger_entry.sql` | unknown | unknown | — |
| `0025_atomic_claim_invitation_code.sql` | unknown | unknown | — |
| `0026_atomic_apply_invitation_rebate.sql` | unknown | unknown | — |
| `0027_balance_write_surface_lockdown.sql` | unknown | unknown | — |
| `0028_restore_staging_helper_functions.sql` | unknown | unknown | — |
| `0029_client_role_non_dml_grant_hardening.sql` | unknown | unknown | — |
| `0030_privileged_rpc_execute_posture.sql` | unknown | unknown | — |
| `0031_validate_invitation_code_posture.sql` | unknown | unknown | — |
| `0032_admin_policy_shape_reconciliation.sql` | unknown | unknown | — |
| `0033_package_config_admin_write_posture.sql` | unknown | unknown | — |
| `0034_staging_checkout_runtime_grants.sql` | unknown | unknown | — |
| `0035_fix_payment_fulfillment_rpc_ambiguity.sql` | unknown | unknown | — |
| `0036_public_module_display_fields.sql` | unknown | unknown | — |
| `0037_preserve_subscription_status_on_invoice_fulfillment.sql` | unknown | unknown | — |
| `0038_normalize_module_boolean_flags.sql` | unknown | 历史执行报告 | E38 |
| `0039_normalize_module_policy_shape.sql` | 历史执行报告 | 历史执行报告 | E39 |
| `0040_reconcile_module_public_grants.sql` | unknown | unknown | — |
| `0041_stripe_refund_reconciliation.sql` | unknown | unknown | — |
| `0042_canceled_subscription_profile_downgrade.sql` | unknown | unknown | — |
| `0043_payment_order_status_machine.sql` | unknown | unknown | — |
| `0044_credit_transactions_v2_semantics.sql` | 历史执行报告 | unknown | E44 |
| `0045_subscription_credit_grants.sql` | 历史执行报告 | unknown | E45 |
| `0046_profile_bootstrap_service_role_grants.sql` | unknown | unknown | — |
| `0047_subscription_fulfillment_service_role_grants.sql` | unknown | unknown | — |
| `0048_restore_staging_baseline_objects.sql` | 历史执行报告 | unknown | E48 |
| `0049_reconcile_stg_fix_target_grants.sql` | 历史执行报告 | unknown | E49 |
| `0050_sec1_privileged_rpc_execute_posture_closure.sql` | unknown | unknown | — |
| `0051_auth_opening_grant_profile_defaults.sql` | unknown | unknown | — |
| `0052_year1_annual_calendar_period_keys.sql` | unknown | unknown | — |
| `0053_refund_1b_consumed_amount_termination.sql` | unknown | unknown | — |
| `0054_refund_1b_profiles_column_contract_repair.sql` | unknown | unknown | — |
| `0055_refund_1b_invoice_rpc_credits_granted_ambiguity_repair.sql` | unknown | unknown | — |
| `0056_refund_1b_service_role_select_contract_repair.sql` | unknown | unknown | — |
| `0057_refund_1b_actual_refund_accounting_repair.sql` | unknown | unknown | — |
| `0058_refund_1b_canonical_metadata_merge_repair.sql` | unknown | unknown | — |
| `0059_refund_1b_failure_period_metadata_repair.sql` | unknown | unknown | — |
| `0060_refund_1b_post_merge_forward_repair.sql` | unknown | unknown | — |
| `0061_refund_1b_expired_quarantine_repair.sql` | unknown | unknown | — |
| `0062_skill_1a_db_publish_contract.sql` | unknown | unknown | — |
| `0063_bill_1_reconciliation_select_contract.sql` | unknown | unknown | — |
| `0064_v3_private_skill_packages.sql` | unknown | unknown | — |
| `0065_v3_research_operations.sql` | unknown | unknown | — |
| `0066_v3_artifact_transactions.sql` | unknown | unknown | — |
| `0067_v3_workbench_queries.sql` | unknown | unknown | — |
| `0068_v3_workbench_generation.sql` | unknown | unknown | — |
| `0069_v3_chat_skill.sql` | unknown | unknown | — |
| `0070_v3_separate_summary.sql` | unknown | unknown | — |
| `0071_v3_research_billing.sql` | unknown | unknown | — |
| `0072_v3_admin_skill_modules.sql` | unknown | unknown | — |
| `0073_admin_management_write_grants.sql` | unknown | unknown | — |
| `0074_admin_model_delete.sql` | unknown | unknown | — |
| `0075_admin_settings_and_home_entry.sql` | unknown | unknown | — |
| `0076_admin_settings_writer_profile_read.sql` | unknown | unknown | — |
| `0077_workbench_provider_rejection.sql` | unknown | unknown | — |
| `0078_ordinary_chat_requests.sql` | unknown | unknown | — |
| `0079_ai_consumption_read_contract.sql` | unknown | unknown | — |
| `0080_account_artifact_reuse.sql` | unknown | unknown | — |
| `0081_agent_slice_preferences.sql` | unknown | unknown | — |
| `0082_agent_slice_artifact_links.sql` | unknown | unknown | — |
| `0083_agent_slice_execution_identity.sql` | unknown | unknown | — |
| `0084_agent_slice_call_accounting.sql` | unknown | unknown | — |
| `0085_agent_slice_summary_identity.sql` | unknown | unknown | — |
| `0086_agent_slice_results.sql` | unknown | unknown | — |
| `0087_agent_slice_execution_context.sql` | unknown | unknown | — |
| `0088_agent_slice_selected_source.sql` | unknown | unknown | — |
| `0089_agent_slice_admission_replay.sql` | unknown | unknown | — |
| `0090_agent_slice_conversation.sql` | unknown | unknown | — |
| `0091_agent_slice_entry.sql` | unknown | unknown | — |
| `0092_agent_slice_continue_work.sql` | unknown | unknown | — |
| `0093_agent_slice_sources.sql` | unknown | unknown | — |
| `0094_agent_slice_discussion_context.sql` | unknown | unknown | — |
| `0095_agent_slice_final_commit.sql` | unknown | unknown | — |
| `0096_agent_slice_bounded_unavailable.sql` | unknown | unknown | — |
| `0097_agent_slice_prepared_recovery.sql` | unknown | unknown | — |
| `0098_agent_slice_revision_isolation.sql` | unknown | unknown | — |
| `0099_agent_slice_rejected_result_usage.sql` | unknown | unknown | — |
| `0100_artifact_reference_revision_isolation.sql` | unknown | unknown | — |
| `0101_agent_slice_legacy_generation_boundary.sql` | unknown | unknown | — |
| `0102_agent_slice_revision_handoff.sql` | unknown | unknown | — |
| `0103_bill_1_reservation_read_contract.sql` | unknown | unknown | — |
| `0104_workbench_provider_observations.sql` | unknown | unknown | — |
| `0105_v3_bill2_authoritative_runs.sql` | unknown | unknown | — |
| `0106_runtime_sessions.sql` | unknown | unknown | — |
| `0107_opc_workbench.sql` | unknown | unknown | — |
| `0108_runtime_staging_window.sql` | unknown | unknown | — |
| `0109_opc_mentor_opening.sql` | unknown | unknown | — |
| `0110_opc_turn_round_ownership.sql` | unknown | unknown | — |
| `0111_opc_historical_reach.sql` | unknown | unknown | — |
| `0112_opc_plan_request_state.sql` | unknown | unknown | — |
| `0113_opc_topic_workspace.sql` | unknown | unknown | — |
| `0114_opc_topic_consent.sql` | unknown | unknown | — |
| `0115_opc_historical_plan_result.sql` | unknown | unknown | — |
| `0116_opc_mentor_projection_basis.sql` | unknown | unknown | — |
| `0117_opc_core_experience.sql` | unknown | unknown | — |
| `0118_opc_b1_acceptance.sql` | unknown | unknown | — |
| `0119_opc_video_admission.sql` | unknown | unknown | — |
| `0120_opc_entry_projection.sql` | unknown | unknown | — |
| `0121_opc_storyboard_dependency.sql` | unknown | unknown | — |
| `0122_opc_content_type.sql` | unknown | unknown | — |
| `0123_opc_manual_content.sql` | unknown | unknown | — |
| `0124_opc_workspace_ui.sql` | unknown | unknown | — |
| `0125_opc_account_strategy.sql` | unknown | unknown | — |
| `0126_opc_account_strategy_schema.sql` | unknown | unknown | — |
| `0127_opc_work_name_sync.sql` | unknown | unknown | — |
| `0128_opc_script_ancestry.sql` | unknown | unknown | — |
| `0129_opc_library_read_once.sql` | unknown | unknown | — |
| `0130_runtime_conversations.sql` | unknown | unknown | — |
| `0131_runtime_workspace_sources.sql` | unknown | unknown | — |
| `0132_opc_video_execution_ancestry.sql` | unknown | unknown | — |
| `0133_opc_confirmed_information_history.sql` | unknown | unknown | — |
| `0134_opc_account_strategy_inheritance.sql` | unknown | unknown | — |
| `0135_opc_account_edit_confirmation.sql` | unknown | unknown | — |
| `0136_runtime_truncation_diagnostic.sql` | unknown | unknown | — |
| `0137_bill2_unstarted_dispatch.sql` | unknown | unknown | — |
| `0138_runtime_stopped_pending.sql` | unknown | unknown | — |
| `0139_opc_business_context.sql` | unknown | unknown | — |

结果：staging 有逐文件历史执行报告的 5 个文件，另外 135 个 `unknown`；
production 有逐文件历史执行报告的 2 个文件，另外 138 个 `unknown`。
这些数量不表示当前远端缺了多少迁移，两环境本次远端核验均为 `NOT_RUN`。

## schema.ts 覆盖数量：本地静态复核

本地静态脚本实际输出：`schema=32 migration_created=75 overlap=16 union=91`。
`schema.ts` 覆盖 91 个仓库声明表名中的 32 个；59 个仅由迁移建表，16 个只在
`schema.ts` 声明而没有迁移 `CREATE TABLE`。这不是远端表数量。

算法：提取 schema 中全部 `pgTable` 表名（含跨行）；移除迁移块注释和行注释，
提取 `CREATE TABLE [IF NOT EXISTS]` 名称并去掉 `public.` 前缀，按对象名取唯一
集合。重复恢复建表不重复计数。未发现迁移 DROP TABLE 或表重命名改变该计数。
这是针对此基线写法的文本盘点，不是通用 SQL 解析器。

以下命令在仓库根目录运行，仅本地读文件，不连接数据库、不写文件：

```sh
python3 - <<'PY'
from pathlib import Path
import re
root = Path('packages/db')
schema = set(re.findall(r"pgTable\(\s*['\"]([^'\"]+)", (root / 'schema.ts').read_text()))
created = set()
for path in sorted((root / 'migrations').glob('*.sql')):
    sql = re.sub(r'/\*.*?\*/|--[^\n]*', '', path.read_text(), flags=re.S)
    pattern = r'\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?((?:\w+\.)?\w+)'
    for match in re.finditer(pattern, sql, flags=re.I):
        created.add(match.group(1).removeprefix('public.'))
print('schema=', len(schema), 'migration_created=', len(created),
      'overlap=', len(schema & created), 'union=', len(schema | created))
print('schema_only=', sorted(schema - created))
print('migration_only=', sorted(created - schema))
PY
```

16 个 schema-only 表及声明位置如下；only 只比较迁移建表定义，不表示迁移、代码或
测试没有引用它们。所有线上结构均未核实。

| 表名 | schema.ts 声明位置 |
| --- | --- |
| `profiles` | [packages/db/schema.ts:6](../../../packages/db/schema.ts#L6) |
| `conversations` | [packages/db/schema.ts:22](../../../packages/db/schema.ts#L22) |
| `messages` | [packages/db/schema.ts:39](../../../packages/db/schema.ts#L39) |
| `credit_transactions` | [packages/db/schema.ts:49](../../../packages/db/schema.ts#L49) |
| `ai_models` | [packages/db/schema.ts:76](../../../packages/db/schema.ts#L76) |
| `system_settings` | [packages/db/schema.ts:103](../../../packages/db/schema.ts#L103) |
| `tickets` | [packages/db/schema.ts:110](../../../packages/db/schema.ts#L110) |
| `ticket_replies` | [packages/db/schema.ts:125](../../../packages/db/schema.ts#L125) |
| `credit_packages` | [packages/db/schema.ts:137](../../../packages/db/schema.ts#L137) |
| `invitations` | [packages/db/schema.ts:150](../../../packages/db/schema.ts#L150) |
| `user_activity_logs` | [packages/db/schema.ts:158](../../../packages/db/schema.ts#L158) |
| `announcements` | [packages/db/schema.ts:181](../../../packages/db/schema.ts#L181) |
| `prompts` | [packages/db/schema.ts:204](../../../packages/db/schema.ts#L204) |
| `invitation_records` | [packages/db/schema.ts:231](../../../packages/db/schema.ts#L231) |
| `membership_plans` | [packages/db/schema.ts:270](../../../packages/db/schema.ts#L270) |
| `modules` | [packages/db/schema.ts:520](../../../packages/db/schema.ts#L520) |
