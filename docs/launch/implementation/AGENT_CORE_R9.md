# AGENT-CORE R9 数据基础

范围依据：`AGENT_CORE_CLOSEOUT.md` R9 及 #771 总控派发。风险：high（数据结构、来源与删除边界）。

## 验收范围

- 选题采用关联生成执行，同时保存 AI 原提议和用户采用的文字。
- 逐类核对整理信息的来源、执行、创建时间，补齐可验证的缺口，不伪造历史来源。
- 记录重写和放弃事件；新增内容数据纳入注销和单条删除。
- 复用现有 OPC、Runtime、动作记录和删除机制，不建立平行数据权威。

## 执行边界

- 仅后端；不使用浏览器，不做付费模型调用，不合并，不应用远程迁移。
- 迁移编号先在 PR 评论申请，由总控分配；不得自行编号。
- 公共注销接线在 #778 合并后做；不改 #778、#781 或导师回合、报告定稿窗口的文件。
- 必须重叠的文件先在 PR 说明，等待总控排顺序。
- R9 完整审查通过后才开始独立的 R10 PR。

## 当前交接

完成：按总控分配新增 `0207_agent_core_data_foundation.sql`；来源与时间补缺、选题原提议/采用文字、
显式重写/放弃事件，以及 D7/注销清理与剩余证明均已有本地实现。#778 已合并并同步至本分支。
下一步：#784 R1 → #785 R16 合并后才修改 opc/service.ts，将现有选题接口切换到来源绑定 RPC 并接入事件接口。
阻塞：服务文件等待 #785；完整迁移链等待 0204（#781）、0205（#784）、0206（#783），不自行改号或跳过台账检查。
R9 尚未完成，R10 未开始。既有准备提交的 CI/机器人通过不覆盖这次数据库改动。
验证：新模块 9/9；本地数据测试已覆盖新旧选题来源、用户/AI 两类整理来源、并发、删除和注销。
最终回放/回归统计及新提交的 CI/机器人结果在 PR 交接更新；未运行的服务路由端到端验证不记为通过。

## 来源核对（当前 staging，本地文件与空库验证）

| 记录类型 | 已有链路 | 缺口 / R9 处理 |
| --- | --- | --- |
| 选题草稿 | `opc_topic_draft_versions` 保存用户提交的 body、正式定位来源及时间 | `opcTopicDraft` 有 executionId，但 service.ts 未传入；SQL 无执行绑定。新增严格验证执行归属和可读性的 RPC，AI 原提议只从该执行读取 |
| 已采用选题 | `opc_plans` → `opc_items`，保存采用文字和正式定位来源 | 不含生成执行与 AI 原提议；逐项绑定来源，旧客户端只有唯一可证明来源时才接受，不按“最近一次执行”猜测 |
| 自动整理字段 | 0182 的 `fieldMeta` 包含 source、basis、executionId、fp | `basis` 区分用户原话和 AI 提议；保留现有字段保护，不改变确认语义 |
| 待处理建议 | `fieldMeta.suggestion` 包含执行、basis、值、序列时间 | 接受后 0159 的 resolve 将 meta 重建成 source=user，丢失原始执行与 basis；补原始来源及接受动作，两者不能混为一谈 |
| 已撤回建议 | 0199 保留 withdrawnSuggestion、原执行和撤回执行 | 已有来源，继续保留；dismiss 后仍需可追溯动作，不将系统撤回错误计为用户“放弃” |
| 手动整理字段 | 0182 `opc_information` 合并旧 meta 后改 source=user | 会残留旧 basis/executionId；需明确当前来源为用户编辑，并将旧来源只作为原始来源保存 |
| 步骤候选/确认/正式定位 | `opc_result_links` 连接执行、候选、证据；确认和正式版本已有时间 | 复用现有关系，不改 R5 的定稿权威；删除后的来源不可恢复 |
| 写作内容及衍生版本 | `opc_content_versions` 有 execution_id/source_content_id/created_at | 已有链路；手动版本通过 source_content_id 溯源，不把手稿标成 AI 原稿 |
| 冻结上下文和确认快照 | Runtime 冻结 work/steps；确认历史保存 information | 字段补缺需检查读取投影和快照；不得只改当前字段而丢失历史来源 |

### 创建时间的本地空库盘点

执行 `run-db-baseline-replay.mjs --local-only --query ...`：205/205 建库步骤通过，136 次历史位置重复执行，
指纹无差异，临时容器清理通过。最初核对发现以下 26 张相关表没有独立 `created_at` 列；0207 已为它们追加创建时间列及新记录默认值。

- 业务记录/动作：artifact_requests、opc_drafts、opc_turns、opc_handoffs、opc_item_edits、opc_result_links。
- 已有父记录时间的关联：artifact_accounts、artifact_chats、artifact_work_references、opc_accounts、opc_items、
  opc_draft_businesses、opc_account_strategy_drafts、opc_account_strategy_request_bases、runtime_history_dependencies、
  runtime_session_batches、runtime_session_history、runtime_scope_material、runtime_tool_calls。
- 配置/当前状态：artifact_chat_summaries、artifact_evidence_restrictions、artifact_reference_configs、artifact_workflows、
  opc_account_ui、opc_publication_ui、opc_work_ui。

原有记录无可靠创建时间时保留 NULL，新记录自动记创建时刻；已有父记录时间仍可单独展示，不把它冒充子记录时间。
本地测试在迁移前种入旧记录，确认迁移后没有被填成迁移时刻。
`artifact_requests` 的时间会影响动作排序；新增列必须兼容现有大量无列名 INSERT，验证所有存量调用。

### 删除核对与待接线

0201 为当前已合并的单条删除迁移（历史记录中的 0200 已过时）。
0207 将新来源/动作记录纳入 D7 预览哈希和物理清理；新增动作会使旧预览过期。
删除执行同时清除它的原提议、采用对照副本和选题草稿副本，用户独立保存的成果沿用 D7 保留规则。
注销复用 `account_erasure_scrub_content`，清理全部来源/动作记录，并扩展 body/business 剩余证明。
写入持有用户/会话锁并检查现有删除和权限边界，禁止删除后的重试恢复数据；不修改历史迁移。
手改后的字段仍是用户自己的成果：来源失效时清掉来源标识并注明不可用，保留手改文字。

### 已准备但未启用的模块

`services/opc/dataFoundation.ts` 提供选题草稿执行绑定、逐项采用来源、显式 rewrite/abandon 请求映射。
调用者复用现有已认证 RPC；不接受客户端 actorId 或 AI 原提议正文。空来源需由 SQL 严格判定，不能由客户端自报。
三个 RPC 已在 0207 定义，但尚未接入服务和路由，也未应用到远端；目前不是前端可使用接口。
重写和放弃只记录明确动作，不用关键词从聊天推断意图；该接口不触发付费模型调用。

## 数据权威与恢复

现有 Runtime 执行是 AI 原文权威，OPC 计划/作品版本是用户保存结果权威。
现有 artifact_requests 只覆盖项目动作，无法承载普通 Runtime 回答的重写/放弃，且选题版本缺少逐项执行关系。
因此只增加一张 `opc_data_events` 来源/动作表，记录采用当时的对照及明确动作，不替换计划、版本或财务记录。
服务端从真实、可读且归属正确的执行提取原提议；旧客户端仅按已持久化的执行请求关系兼容，不按时间猜测。

回退应用代码不会丢弃新表/列；不执行 DROP，不撤销删除覆盖。若新入口有问题，先停用新入口，
保留已有来源记录、时间和删除补丁，再前向修复。历史创建时间未知保持未知，不批量伪造或回填。

预定 RPC：`opc_topic_draft_from_execution`、`opc_adopt_topics_with_source`、`opc_content_reaction`。
明确错误：`OPC_TOPIC_SOURCE_INVALID`、`OPC_TOPIC_SOURCE_REQUIRED`、`OPC_DATA_SOURCE_DENIED`、
`OPC_DATA_EVENT_INVALID`、`OPC_REQUEST_CONFLICT`。最终 tRPC 名称与路由测试在 #785 合并后接线时确认。

## 当前数据库切片验证（2026-10-11）

- `node packages/db/tests/agent-core-r9/run-local.mjs --local-only`：207/207 建库步骤，138 次历史位置重复执行，
  32 组 R9 与复用 D7 行为检查通过，容器清理通过。
- `node packages/db/tests/run-db-baseline-replay.mjs --local-only --write-built`：207/207、重复 138 次，回放/恢复通过。
- API 适配模块 9/9 单测，API 类型检查、代码大小与 diff 检查通过。
- 迁移台账检查确实返回缺少 0204、0205、0206；这是已排队的依赖，未规避或重编号。
  当前空库测试证明已有文件加 0207 的行为，不能替代前序迁移合并后的完整链验证。
- 未运行：R9 新路由接线后的接口集成、远端迁移或浏览器；最终 CI/独立审查尚待当前提交结果。
