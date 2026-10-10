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

完成：独立 worktree、逐类来源/删除核对、空库时间列盘点；新增未接线的请求/服务模块与测试。
下一步：总控分配编号和共享文件顺序后实施 SQL、接入接口及数据库行为验证；#778 合并后完成注销接线。
阻塞：编号未分配；opc/service.ts 等共享文件顺序未定；#778 尚未合并。R9 未完成，R10 未开始。
验证：新模块 9/9 单测、定向 ESLint、API 类型检查、代码大小及 diff 检查通过；现有数据库回放 205/205，重复 136 次。
上述空库通过只证明现有基线，不证明尚未实现的 R9 SQL。API 全量、远端 CI 与机器人审查结果在 PR 更新。

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
指纹无差异，临时容器清理通过。以下 26 张相关表没有独立 `created_at` 列；这是目录核对，不代表全部需要新增列。

- 业务记录/动作：artifact_requests、opc_drafts、opc_turns、opc_handoffs、opc_item_edits、opc_result_links。
- 已有父记录时间的关联：artifact_accounts、artifact_chats、artifact_work_references、opc_accounts、opc_items、
  opc_draft_businesses、opc_account_strategy_drafts、opc_account_strategy_request_bases、runtime_history_dependencies、
  runtime_session_batches、runtime_session_history、runtime_scope_material、runtime_tool_calls。
- 配置/当前状态：artifact_chat_summaries、artifact_evidence_restrictions、artifact_reference_configs、artifact_workflows、
  opc_account_ui、opc_publication_ui、opc_work_ui。

逐表应按业务用途补时间或显式复用已存在的父记录时间。历史时间没有可靠证据时保留未知，不能把迁移时间冒充创建时间。
`artifact_requests` 的时间会影响动作排序；新增列必须兼容现有大量无列名 INSERT，验证所有存量调用。

### 删除核对与待接线

0201 为当前已合并的单条删除迁移（历史记录中的 0200 已过时）。
选题草稿清理已扫描 request/body 引用，计划清理按正式定位版本，尚不能证明未来新增的原提议快照会被覆盖。
任何新增事件、原提议副本都必须接入 `content_erasure_scope/confirm` 与注销的清理、剩余证明、晚到写入保护。
仅做 FK 或隐藏读取不算清除。公共注销接线依赖 #778；不修改现有历史迁移。

### 已准备但未启用的模块

`services/opc/dataFoundation.ts` 提供选题草稿执行绑定、逐项采用来源、显式 rewrite/abandon 请求映射。
调用者复用现有已认证 RPC；不接受客户端 actorId 或 AI 原提议正文。空来源需由 SQL 严格判定，不能由客户端自报。
当前未注册到路由，三个目标 RPC 尚未创建；这是可测试的接线准备，不是可使用接口，不交给前端上线。
重写和放弃只记录明确动作，不用关键词从聊天推断意图；该接口不触发付费模型调用。
