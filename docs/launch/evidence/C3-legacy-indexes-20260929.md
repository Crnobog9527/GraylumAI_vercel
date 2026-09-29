# C3 遗留调用关系与索引候选（2026-09-29）

基线：`6a370bc5198fe2cc779d3a83d898fd149bee2069`。仅仓库静态盘点；未连接任何数据库，
未执行数据库工具、DDL、远端核查或执行计划。本文件不建议现在删除对象，也不授权添加索引。

## 1. 盘点方法与结论边界

- 从迁移中的 `CREATE FUNCTION` 抽取 220 个不同函数名，再搜索 `apps/`、`packages/`、
  `scripts/`、`.github/` 的应用、SQL、测试、脚本和调度配置；复核下列候选的所有命中。
  `CREATE/ALTER/DROP/COMMENT/GRANT/REVOKE`、授权签名数组、目录检查、注释与文档不算业务调用。
- 迁移与 `schema.ts` 的表名并集为 91；搜索应用引用和 SQL 的 `FROM/JOIN/INSERT/UPDATE/DELETE`。
  无直接应用调用的表仍可能被 RPC 使用。`prompts` 正是这一情况。
- “未发现调用”只指这一提交中的静态代码。没有查询部署配置、数据库依赖目录、运行日志或
  仓库外客户端；动态拼接、旧版本服务及人工 SQL 的调用不能据此排除。函数重命名包装和
  后续覆盖使纯文字命中不是完整运行时调用图。本次没有把低命中率当成可删除证明。

## 2. 遗留函数与表

| 对象 | 静态结论 | 定义／依据 |
| --- | --- | --- |
| `get_user_credits` | 未发现应用、其他 SQL 函数、触发器、调度或测试的实际调用 | `packages/db/migrations/0001_ai_billing_tables.sql:204`；授权签名仅见 `packages/db/migrations/0050_sec1_privileged_rpc_execute_posture_closure.sql:78` |
| `cleanup_old_logs` | 未发现实际调用或仓库内调度；定义本身不证明每天清理 | `packages/db/migrations/0006_application_logs.sql:58`；授权签名 `packages/db/migrations/0050_sec1_privileged_rpc_execute_posture_closure.sql:72` |
| `get_log_stats` | 未发现实际调用 | `packages/db/migrations/0006_application_logs.sql:78`；授权签名 `packages/db/migrations/0050_sec1_privileged_rpc_execute_posture_closure.sql:76` |
| `get_error_summary` | 未发现实际调用 | `packages/db/migrations/0006_application_logs.sql:106`；授权签名 `packages/db/migrations/0050_sec1_privileged_rpc_execute_posture_closure.sql:75` |
| `soft_delete_ticket` | 未发现实际调用 | `packages/db/migrations/0004_recursive_summary_and_soft_delete.sql:204`；授权签名 `packages/db/migrations/0050_sec1_privileged_rpc_execute_posture_closure.sql:80` |
| `atomic_downgrade_canceled_subscription_profile` | 只发现 SQL 测试执行；没有应用、其他函数、触发器或调度调用 | 定义 `packages/db/migrations/0042_canceled_subscription_profile_downgrade.sql:14`；测试 `packages/db/tests/atomic_downgrade_canceled_subscription_profile.sql:48`、`:70`、`:99`、`:110` |
| `purge_deleted_records` | 只发现集成测试执行；没有应用或仓库调度调用 | 最新定义 `packages/db/migrations/0070_v3_separate_summary.sql:367`；测试 `packages/api/src/services/__tests__/workbench.integration.ts:3441`、`:3442`、`:3454`、`:3456`、`:3468` |
| `atomic_fulfill_membership_invoice` | 未发现当前应用实际调用；最新实现保留兼容签名并直接抛出退役错误；测试存在源码／授权姿态断言，不能算业务执行 | `packages/db/migrations/0053_refund_1b_consumed_amount_termination.sql:2990`、`:2995`、`:3017`；`packages/api/src/services/__tests__/refund1bConsumedAmount.test.ts:1940`；只读盘点目标 `scripts/check-staging-db-readiness.mjs:35` |
| `is_admin` | 历史迁移确实调用，不能用全仓库零命中描述；0032 替换旧策略并撤销客户端 EXECUTE 后，未发现新的业务调用。现存线上策略依赖 unknown | 定义 `packages/db/migrations/0028_restore_staging_helper_functions.sql:22`；历史策略 `packages/db/migrations/0002_enable_rls_all_tables.sql:45`、`packages/db/migrations/0018_rls_text_flags_and_job_runs.sql:53`；替换 `packages/db/migrations/0032_admin_policy_shape_reconciliation.sql:20`、`:33`、`:42`；脚本仅检查目录 `scripts/check-staging-db-readiness.mjs:363` |
| `prompts` 表 | 无应用直接查询候选，但仍有 SQL 函数依赖，**不属于无调用表**；后台名为 prompts 的页面实际查询 modules | `packages/db/schema.ts:204`；`purge_deleted_records` 删除它：`packages/db/migrations/0070_v3_separate_summary.sql:382`；`admin_delete_unused_model` 锁表及查询：`packages/db/migrations/0074_admin_model_delete.sql:36`、`:38`；应用 `packages/api/src/routers/admin.ts:1817`、`:1831` |

表级扫描没有另行确认“应用、其他函数、触发器、定时任务全都不引用”的表。
例如 `skill_revision_revocations` 虽无常规页面直接查询，仍被 SQL 使用
（`packages/db/migrations/0064_v3_private_skill_packages.sql:169`、`:195`）；
`opc_topic_openings` 也被 RPC 使用（`packages/db/migrations/0114_opc_topic_consent.sql:30`、`:46`）。
因此这里不以“应用未直接查询”扩大遗留删除候选。

## 3. 双调度定义与缺失 RPC

| 项目 | 仓库事实 | 证据 |
| --- | --- | --- |
| pg_cron 工单自动关闭 | 迁移定义 `ticket-auto-close-hourly`，每小时调用 `public.auto_close_stale_tickets(48)`；同一迁移先撤销同名旧 job，再注册，不等于撤销 Vercel 任务 | `packages/db/migrations/0010_ticket_auto_close_supabase_cron.sql:119`、`:124`、`:126`、`:127` |
| Vercel 工单自动关闭 | `/api/cron/tickets/auto-close` 每日 `0 2 * * *`；路由运行 `TicketAutoCloseService.run()`，直接读写 tickets/replies，并非调用上述同名 RPC | `apps/web/vercel.json:26`、`:27`；`apps/web/src/app/api/cron/tickets/auto-close/route.ts:52`、`:53`；`packages/api/src/services/ticketAutoClose.ts:131`、`:168` |
| 判定 | 两条仓库调度定义覆盖同一工单自动关闭业务；是否在 staging／正式环境同时启用均为 unknown；没有查询 `cron.job` 或 Vercel 实际状态 | 上述两组配置；未运行远端核查 |
| `increment_module_usage` | 应用调用 RPC，但 0001–0139 迁移中没有 CREATE FUNCTION 定义；不代表线上一定不存在，也不能推断当前调用成功 | `packages/api/src/routers/modules.ts:217`；静态检索 `rg -n increment_module_usage packages/db/migrations` 无命中 |

## 4. 外键索引候选（启发式，未看执行计划）

按迁移声明和 `schema.ts` 声明检查本表外键列，考虑普通索引、主键、UNIQUE 的最左列，
并核对后续 DROP／替换。外键不会自动为引用方建索引。本表主键索引覆盖其首列外键时不重复列出。
复合索引中第二列不算单独覆盖；`WHERE fk IS NOT NULL` 能覆盖非空外键值；其他部分索引
不等同全体外键行覆盖。下表是待评估候选，不是“应全部新增”的建议。

迁移没有完整基线，且未查询实际 `pg_index`。下表“未发现”仅指仓库声明；手工索引、平台
索引、实际执行失败或漂移均 unknown。SQL 文本提取用于缩小检查面，不是完整 PostgreSQL 解析器。

### 4.1 指向 profiles 的迁移外键

| 表／列 | 引用定义 | 已有覆盖说明 |
| --- | --- | --- |
| `artifact_projects.actor_id` | `packages/db/migrations/0066_v3_artifact_transactions.sql:5` | 仅部分索引：`artifact_social_account`, `artifact_document_project`；只覆盖 legacy，见 `packages/db/migrations/0080_account_artifact_reuse.sql:8`、`:10` |
| `bill2_drafts.actor_id` | `packages/db/migrations/0105_v3_bill2_authoritative_runs.sql:5` | 未发现以该列为首列的完整索引／PK／UNIQUE |
| `diagnostic_results.run_by` | `packages/db/migrations/0048_restore_staging_baseline_objects.sql:234` | 未发现以该列为首列的完整索引／PK／UNIQUE |
| `opc_account_strategy_drafts.actor_id` | `packages/db/migrations/0125_opc_account_strategy.sql:10` | 未发现以该列为首列的完整索引／PK／UNIQUE |
| `opc_topic_draft_versions.actor_id` | `packages/db/migrations/0117_opc_core_experience.sql:47` | 未发现以该列为首列的完整索引／PK／UNIQUE |
| `opc_topic_workspaces.actor_id` | `packages/db/migrations/0113_opc_topic_workspace.sql:22` | 未发现以该列为首列的完整索引／PK／UNIQUE |
| `research_plans.actor_id` | `packages/db/migrations/0065_v3_research_operations.sql:4` | 未发现以该列为首列的完整索引／PK／UNIQUE |
| `skill_packages.actor_id` | `packages/db/migrations/0064_v3_private_skill_packages.sql:13` | 未发现以该列为首列的完整索引／PK／UNIQUE |
| `skill_revision_revocations.revoked_by` | `packages/db/migrations/0064_v3_private_skill_packages.sql:29` | 未发现以该列为首列的完整索引／PK／UNIQUE |
| `skill_revisions.published_by` | `packages/db/migrations/0062_skill_1a_db_publish_contract.sql:68` | 未发现以该列为首列的完整索引／PK／UNIQUE |
| `skills.archived_by` | `packages/db/migrations/0062_skill_1a_db_publish_contract.sql:23` | 未发现以该列为首列的完整索引／PK／UNIQUE |
| `skills.created_by` | `packages/db/migrations/0062_skill_1a_db_publish_contract.sql:20` | 未发现以该列为首列的完整索引／PK／UNIQUE |
| `skills.published_by` | `packages/db/migrations/0062_skill_1a_db_publish_contract.sql:22` | 未发现以该列为首列的完整索引／PK／UNIQUE |
| `skills.updated_by` | `packages/db/migrations/0062_skill_1a_db_publish_contract.sql:21` | 未发现以该列为首列的完整索引／PK／UNIQUE |

### 4.2 只在 schema.ts 声明的核心表外键候选

这些外键本身是否在线上存在也未核实；表的后续 ALTER／索引迁移不能证明其初始 FK 已部署。

| 表／列 | 指向 | 声明位置 |
| --- | --- | --- |
| `ticket_replies.user_id` | profiles | `packages/db/schema.ts:128` |
| `invitations.used_by` | profiles | `packages/db/schema.ts:153` |
| `announcements.created_by` | profiles | `packages/db/schema.ts:199` |
| `prompts.created_by` | profiles | `packages/db/schema.ts:224` |
| `invitation_records.invitee_id` | profiles | `packages/db/schema.ts:236`；现有 `(invite_code, invitee_id)` 首列不覆盖，`packages/db/migrations/0025_atomic_claim_invitation_code.sql:24` |
| `conversations.model_id` | ai_models | `packages/db/schema.ts:26` |
| `ticket_replies.ticket_id` | tickets | `packages/db/schema.ts:127` |
| `prompts.model_id` | ai_models | `packages/db/schema.ts:212` |

`invitations.created_by` 和 `user_activity_logs.admin_id` 已有索引，未列候选：
`packages/db/migrations/0007_performance_indexes.sql:209`、`:152`。

### 4.3 其他迁移外键候选

同一表的不同列仍各自独立评估；下列均未发现以该外键列（组）开头的完整覆盖。

| 表 | 外键列 → 引用表及位置 |
| --- | --- |
| `agent_slice_executions` | `model_id` → `ai_models`（`packages/db/migrations/0083_agent_slice_execution_identity.sql:13`）；`pair_id` → `agent_slice_pairs`（`packages/db/migrations/0083_agent_slice_execution_identity.sql:12`）；`project_id` → `artifact_projects`（`packages/db/migrations/0083_agent_slice_execution_identity.sql:8`）；`project_id,request_id` → `artifact_requests`（`packages/db/migrations/0083_agent_slice_execution_identity.sql:21`）；`revision_id` → `skill_packages`（`packages/db/migrations/0083_agent_slice_execution_identity.sql:11`）；`round_id` → `artifact_rounds`（`packages/db/migrations/0083_agent_slice_execution_identity.sql:9`）；`summary_model_id` → `ai_models`（`packages/db/migrations/0085_agent_slice_summary_identity.sql:5`） |
| `agent_slice_links` | `pair_id` → `agent_slice_pairs`（`packages/db/migrations/0082_agent_slice_artifact_links.sql:19`）；`source_version_id` → `artifact_versions`（`packages/db/migrations/0082_agent_slice_artifact_links.sql:17`） |
| `agent_slice_pairs` | `script_workflow` → `artifact_workflows`（`packages/db/migrations/0082_agent_slice_artifact_links.sql:6`）；`title_workflow` → `artifact_workflows`（`packages/db/migrations/0082_agent_slice_artifact_links.sql:7`） |
| `ai_usage_logs` | `conversation_id` → `conversations`（`packages/db/migrations/0001_ai_billing_tables.sql:43`） |
| `artifact_accounts` | `module_id` → `modules`（`packages/db/migrations/0067_v3_workbench_queries.sql:11`）；`skill_id` → `skills`（`packages/db/migrations/0067_v3_workbench_queries.sql:12`） |
| `artifact_candidates` | `round_id` → `artifact_rounds`（`packages/db/migrations/0066_v3_artifact_transactions.sql:34`） |
| `artifact_chat_turns` | `conversation_id` → `artifact_chats`（`packages/db/migrations/0069_v3_chat_skill.sql:27`） |
| `artifact_chats` | `project_id` → `artifact_projects`（`packages/db/migrations/0069_v3_chat_skill.sql:8`） |
| `artifact_confirmations` | `round_id` → `artifact_rounds`（`packages/db/migrations/0066_v3_artifact_transactions.sql:30`） |
| `artifact_evidence` | `project_id` → `artifact_projects`（`packages/db/migrations/0066_v3_artifact_transactions.sql:21`）；`supersedes` → `artifact_evidence`（`packages/db/migrations/0066_v3_artifact_transactions.sql:22`） |
| `artifact_generations` | `candidate_id` → `artifact_candidates`（`packages/db/migrations/0068_v3_workbench_generation.sql:13`） |
| `artifact_projects` | `module_id` → `modules`（`packages/db/migrations/0066_v3_artifact_transactions.sql:6`）；`skill_id` → `skills`（`packages/db/migrations/0066_v3_artifact_transactions.sql:6`）；`source_project_id` → `artifact_projects`（`packages/db/migrations/0080_account_artifact_reuse.sql:5`） |
| `artifact_reference_configs` | `source_workflow` → `artifact_workflows`（`packages/db/migrations/0080_account_artifact_reuse.sql:13`）；`target_workflow` → `artifact_workflows`（`packages/db/migrations/0080_account_artifact_reuse.sql:14`） |
| `artifact_requests` | `round_id` → `artifact_rounds`（`packages/db/migrations/0066_v3_artifact_transactions.sql:44`） |
| `artifact_rounds` | `project_id` → `artifact_projects`（`packages/db/migrations/0066_v3_artifact_transactions.sql:13`）；只有部分索引 `artifact_active_draft`（`packages/db/migrations/0066_v3_artifact_transactions.sql:19`）；`revision_id` → `skill_packages`（`packages/db/migrations/0066_v3_artifact_transactions.sql:14`） |
| `artifact_work_references` | `config_id` → `artifact_reference_configs`（`packages/db/migrations/0080_account_artifact_reuse.sql:25`）；`project_id` → `artifact_projects`（`packages/db/migrations/0080_account_artifact_reuse.sql:22`）；`source_version_id` → `artifact_versions`（`packages/db/migrations/0080_account_artifact_reuse.sql:24`） |
| `artifact_workflows` | `module_id` → `modules`（`packages/db/migrations/0067_v3_workbench_queries.sql:6`）；`revision_id` → `skill_packages`（`packages/db/migrations/0067_v3_workbench_queries.sql:7`）；`skill_id` → `skills`（`packages/db/migrations/0067_v3_workbench_queries.sql:6`） |
| `bill2_provider_ids` | `call_id` → `bill2_calls`（`packages/db/migrations/0105_v3_bill2_authoritative_runs.sql:34`） |
| `bill2_runs` | `session_ref` → `runtime_sessions`（`packages/db/migrations/0106_runtime_sessions.sql:52`） |
| `billing_history` | `transaction_id` → `credit_transactions`（`packages/db/migrations/0001_ai_billing_tables.sql:31`） |
| `conversation_context_snapshots` | `source_message_end_id` → `messages`（`packages/db/migrations/0014_ai_runtime_closure.sql:31`）；`source_message_start_id` → `messages`（`packages/db/migrations/0014_ai_runtime_closure.sql:30`） |
| `conversations` | `module_id` → `modules`（`packages/db/migrations/0069_v3_chat_skill.sql:5`） |
| `modules` | `link_module_id` → `modules`（`packages/db/migrations/0073_admin_management_write_grants.sql:11`） |
| `opc_account_strategy_drafts` | `account_project_id` → `opc_accounts`（`packages/db/migrations/0125_opc_account_strategy.sql:8`）；只有部分索引 `opc_account_strategy_current_one`（`packages/db/migrations/0125_opc_account_strategy.sql:26`）；`base_source_version_id` → `artifact_versions`（`packages/db/migrations/0125_opc_account_strategy.sql:12`）；`root_source_version_id` → `artifact_versions`（`packages/db/migrations/0125_opc_account_strategy.sql:11`） |
| `opc_account_ui` | `account_project_id` → `opc_accounts`（`packages/db/migrations/0124_opc_workspace_ui.sql:23`） |
| `opc_accounts` | `business_id` → `opc_businesses`（`packages/db/migrations/0117_opc_core_experience.sql:16`）；`source_version_id` → `artifact_versions`（`packages/db/migrations/0107_opc_workbench.sql:35`） |
| `opc_businesses` | `current_source_version_id` → `artifact_versions`（`packages/db/migrations/0117_opc_core_experience.sql:10`） |
| `opc_content_versions` | `execution_id` → `runtime_executions`（`packages/db/migrations/0117_opc_core_experience.sql:71`）；`source_content_id` → `opc_content_versions`（`packages/db/migrations/0117_opc_core_experience.sql:70`） |
| `opc_draft_businesses` | `business_id` → `opc_businesses`（`packages/db/migrations/0117_opc_core_experience.sql:20`） |
| `opc_drafts` | `registration` → `artifact_workflows`（`packages/db/migrations/0107_opc_workbench.sql:10`） |
| `opc_handoffs` | `draft_id` → `opc_drafts`（`packages/db/migrations/0107_opc_workbench.sql:45`） |
| `opc_items` | `source_version_id` → `artifact_versions`（`packages/db/migrations/0107_opc_workbench.sql:41`） |
| `opc_plans` | `source_version_id` → `artifact_versions`（`packages/db/migrations/0107_opc_workbench.sql:28`） |
| `opc_publication_ui` | `work_item_id` → `opc_items`（`packages/db/migrations/0124_opc_workspace_ui.sql:65`） |
| `opc_result_links` | `round_id` → `artifact_rounds`（`packages/db/migrations/0107_opc_workbench.sql:225`） |
| `opc_topic_draft_versions` | `source_version_id` → `artifact_versions`（`packages/db/migrations/0117_opc_core_experience.sql:48`） |
| `opc_topic_workspaces` | `source_version_id` → `artifact_versions`（`packages/db/migrations/0113_opc_topic_workspace.sql:23`） |
| `opc_turns` | `draft_id` → `opc_drafts`（`packages/db/migrations/0107_opc_workbench.sql:14`）；`round_id` → `artifact_rounds`（`packages/db/migrations/0107_opc_workbench.sql:16`） |
| `opc_video_material_bindings` | `session_id,material_revision` → `runtime_scope_material`（`packages/db/migrations/0117_opc_core_experience.sql:85`）；`source_script_id` → `opc_content_versions`（`packages/db/migrations/0117_opc_core_experience.sql:83`）；`work_item_id` → `opc_items`（`packages/db/migrations/0117_opc_core_experience.sql:83`） |
| `opc_work_ui` | `work_item_id` → `opc_items`（`packages/db/migrations/0124_opc_workspace_ui.sql:8`） |
| `ordinary_chat_requests` | `conversation_id` → `conversations`（`packages/db/migrations/0078_ordinary_chat_requests.sql:9`） |
| `runtime_executions` | `session_id` → `runtime_sessions`（`packages/db/migrations/0106_runtime_sessions.sql:14`） |
| `runtime_history_dependencies` | `dependency_id` → `runtime_executions`（`packages/db/migrations/0106_runtime_sessions.sql:27`） |
| `runtime_session_batches` | `session_id` → `runtime_sessions`（`packages/db/migrations/0106_runtime_sessions.sql:31`） |
| `runtime_session_history` | `execution_id` → `runtime_executions`（`packages/db/migrations/0106_runtime_sessions.sql:39`） |
| `subscription_credit_grants` | `credit_transaction_id` → `credit_transactions`（`packages/db/migrations/0045_subscription_credit_grants.sql:29`）；`membership_plan_id` → `membership_plans`（`packages/db/migrations/0045_subscription_credit_grants.sql:16`） |
| `token_stats` | `message_id` → `messages`（`packages/db/migrations/0001_ai_billing_tables.sql:15`） |
| `user_subscriptions` | `membership_plan_id` → `membership_plans`（`packages/db/migrations/0012_stripe_payments.sql:36`） |

复合 FK 的有限覆盖另外说明：`opc_turns(session_id, material_revision)` 已有
`UNIQUE(session_id, request_id)` 的首列覆盖（`packages/db/migrations/0107_opc_workbench.sql:17`、`:18`），
没有把该复合 FK 算作完全无前缀索引；是否需要覆盖第二列需实际执行计划。
`opc_video_material_bindings(session_id, material_revision)` 的主键则是 `(actor_id, request_id)`，
不覆盖该 FK，仍列入候选（`packages/db/migrations/0117_opc_core_experience.sql:85`）。`opc_accounts.business_id` 则只处于
`(actor_id, business_id)` 第二列（`packages/db/migrations/0117_opc_core_experience.sql:42`），仍在候选中。

### 4.4 重复／冗余索引候选

完全相同键声明与前缀重叠分开看。前缀重叠仍可能因体积、写入成本、排序、谓词、扫描频率
有保留价值；本次未看执行计划、大小或使用统计，不据此删除。

| 表 | 候选／覆盖关系 | 证据 |
| --- | --- | --- |
| application_logs | `idx_application_logs_created_at` 与 `idx_application_logs_created` 都是 `(created_at DESC)`，精确重复声明候选 | `packages/db/migrations/0048_restore_staging_baseline_objects.sql:323`、`:337` |
| application_logs | `idx_application_logs_user_id(user_id)` 被 `idx_application_logs_user_created(user_id, created_at DESC)` 前缀覆盖 | `packages/db/migrations/0048_restore_staging_baseline_objects.sql:321`、`:331` |
| application_logs | `idx_application_logs_level(level)` 被 `idx_application_logs_level_created(level, created_at DESC)` 前缀覆盖 | `packages/db/migrations/0048_restore_staging_baseline_objects.sql:327`、`:333` |
| token_stats | `idx_token_stats_user_id` 与 `idx_token_stats_user_created` 前缀重叠 | `packages/db/migrations/0007_performance_indexes.sql:51`、`:55` |
| billing_history | `idx_billing_history_user_id` 与 user_created／user_operation 前缀重叠 | `packages/db/migrations/0007_performance_indexes.sql:71`、`:75`；`packages/db/migrations/0001_ai_billing_tables.sql:70` |
| ai_usage_logs | `idx_ai_usage_logs_user_id` 与 user_created／user_status 前缀重叠 | `packages/db/migrations/0007_performance_indexes.sql:87`、`:91`；`packages/db/migrations/0001_ai_billing_tables.sql:76` |
| messages | `idx_messages_conversation_id` 与 conversation_created 前缀重叠 | `packages/db/migrations/0007_performance_indexes.sql:31`、`:35` |
| credit_transactions | `idx_credit_transactions_user_id` 与 user_created／user_type_created_at／user_ledger_created 前缀重叠 | `packages/db/migrations/0007_performance_indexes.sql:108`、`:112`；`packages/db/migrations/0020_admin_query_indexes.sql:38`；`packages/db/migrations/0044_credit_transactions_v2_semantics.sql:172` |
| tickets | status 与 status_created_at；priority 与 priority_created_at 前缀重叠 | `packages/db/migrations/0007_performance_indexes.sql:128`、`:132`；`packages/db/migrations/0020_admin_query_indexes.sql:22`、`:28` |
| user_activity_logs | `idx_user_activity_logs_user_id` 与 user_created 前缀重叠 | `packages/db/migrations/0007_performance_indexes.sql:148`、`:157` |
| invitation_records | `idx_invitation_records_status` 与 status_created_at 前缀重叠 | `packages/db/migrations/0007_performance_indexes.sql:221`；`packages/db/migrations/0020_admin_query_indexes.sql:72` |

避免重复误报：0001 与 0007 中同名 `CREATE INDEX IF NOT EXISTS` 不是两份索引；
0048 再声明既有同名日志索引也不是额外一份。0080 对 artifact 两个唯一索引先 DROP 再以
新谓词创建，只取最后定义（`packages/db/migrations/0080_account_artifact_reuse.sql:7`、`:9`）；
0085 删除旧 `(execution_id, sequence)` 唯一约束并建带 phase 的新索引，不把旧约束算作现存
（`packages/db/migrations/0085_agent_slice_summary_identity.sql:9`、`:10`）。

## 5. 本次验证

- PASS：只读静态扫描与重点命中人工复核，覆盖迁移 0001–0139、schema 声明、应用 RPC、
  SQL 内部引用、触发器及仓库内定时任务定义。
- NOT_RUN：数据库 catalog／执行计划／使用统计、线上函数与索引、真实调度状态。
- 本子盘点未启动 Docker、未连接数据库；C3 迁移重放结果由同批主报告单独记录。
