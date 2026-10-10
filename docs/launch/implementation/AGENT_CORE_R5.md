# AGENT-CORE R5：报告定稿后端

风险：high（报告持久化、正式定位版本、来源及删除边界）。范围按 AGENT_CORE_CLOSEOUT.md R5、
#771 派发；迁移 0206 由总控在 #783 的 issuecomment-6098712206 分配。

## 结果与边界

保存报告手动版本并记录手改标记；服务端拒绝截断、停止、缺段或过期来源报告定稿。
定稿原子生成现有正式定位版本，返回第一周选题承接信息。手改正文不修改各步确认字段，
选题和写作仍使用原确认字段，修订稿字段同步属于 R14。

仅后端；不改前端、不使用浏览器、不调用付费模型、不合并、不执行远程迁移。
报告编辑和定稿按钮由 Claude 前端接入。定稿本身不发起选题模型调用。

## 最小实现

- `artifact_requests` 保存不可变 `report_edit` 请求及手动正文，版本号由数据库在项目锁内分配。
- `artifact_versions.report.generatedReport` 保存正式全文、手改标记、执行及正文校验值；
  原 `sections` 保留确认字段，沿用现有正式版本、业务当前定位和选题机制。
  现有导出识别正式全文并继续转义不可信 Markdown；历史报告仍按旧格式导出。
- `artifact_evidence` 和 `opc_result_links` 关联原报告执行。复用 #766 的来源检查、
  单条删除和注销擦除；没有新表，也不修改公共注销函数。
- 已发布报告的来源校验使用不可变确认快照及原字段的来源权限，避免来源关联回查自身。
- 所有新 RPC 仅服务角色可调用，调用者身份由已验证登录提取；私有 helper 不开放调用。

## 前端接口

路由统一在现有 Runtime 的认证及 staging 读取边界内，不加载新模型或生成准入。

| tRPC | 请求 | 结果 |
| --- | --- | --- |
| `runtime.reportDocument` | `{ executionId }` | 当前手动或原报告版本及状态 |
| `runtime.reportSave` | `{ executionId, requestId, expectedRevision, body }` | 保存后的当前版本，`manuallyEdited=true` |
| `runtime.reportFinalize` | `{ executionId, requestId, expectedRevision, expectedBodyHash }` | 正式版本及 `next` |

`expectedRevision` 从读取结果取值，原报告为 0；`expectedBodyHash` 必须使用服务器返回值。
请求正文上限为 12000 个 Unicode 字符，数据库仍以该报告冻结的 Skill 上限为准。
相同请求编号及相同参数可重试；同编号改参数拒绝。发生冲突时重新读取，不能自动覆盖用户输入。
已定稿不接受后续编辑或第二次发布；原定稿请求重试返回同一正式版本。

响应：`executionId, revision, body, bodyHash, manuallyEdited, completeness, candidate,
finalized, versionId, version, next`。正文属于不可信内容，前端沿用已有安全 Markdown 渲染。

`next={kind:'first_week_topics',draftId,sourceVersionId}` 时，前端进入现有选题承接：
沿用 `opc.topicConsent` 的明确确认及现有首轮生成流程，不以读取或定稿操作代替用户同意。
没有 OPC 草稿的通用报告返回 `next=null`。

## 稳定错误码

| 错误码 | 处理 |
| --- | --- |
| `REPORT_AUTH_REQUIRED` | 登录未验证，重新登录 |
| `REPORT_EXECUTION_REQUIRED` | 不是可识别的本人报告执行，重新选择报告 |
| `REPORT_SOURCE_CONFLICT` | 来源、确认快照或发布方法已变化，重新读取并处理来源 |
| `REPORT_CONFIRMATION_REQUIRED` | 原字段尚未有效确认 |
| `REPORT_NOT_COMPLETE` | 原报告截断/停止/未完成，或当前正文不满足冻结模板；禁止定稿 |
| `REPORT_BODY_INVALID` | 正文为空、超限或请求参数不合法 |
| `REPORT_VERSION_CONFLICT` | 另一标签页已编辑，或正文校验不匹配；重新读取 |
| `REPORT_REQUEST_CONFLICT` | 请求编号被用于不同参数或操作；不自动重试为新意图 |
| `REPORT_ALREADY_FINALIZED` | 该轮已定稿或关闭；读取正式版本 |
| `CONTENT_ERASED` | 内容已删除，不恢复或重放旧正文 |
| `REPORT_UNAVAILABLE` | 其他内部错误，仅返回安全通用错误码 |

输入格式不合法由 tRPC/Zod 返回 BAD_REQUEST。上述错误码作为 tRPC message 返回；内部数据库细节不外传。

## 删除、兼容与恢复

删除成果时，现有擦除覆盖全部手改请求与正式正文。删除原报告回复时，独立正式报告保留可读，
但来源失效，不能再被用于新选题；手改请求中的正文副本会擦除。注销同样擦除这些既有表中的正文。
财务流水和真实调用事实沿用既有保留规则，不新造消费或退款。

旧的未配置 reportGeneration 的发布流程保持原行为；配置了报告生成的流程不能从旧 publish
入口绕过报告完整性检查。后端先交付、前端后接入期间，旧按钮可能收到拒绝，不代表新报告按钮已完成。
迁移可重复执行。保留的正式版本及请求不回写旧内容；回退应用代码不会清除新正文或恢复已删除内容。
如果需撤回数据库函数，须从当时的 staging 定义准备恢复迁移并复核来源保护，不反向执行删除或改历史迁移。

## 交接

- 已完成：后端服务、请求校验、Runtime 接线、0206 迁移及固定样本数据库验证代码。
- 下一步：机器人审查与同范围修复；待 0203–0205 合并后同步并重建最终指纹和 CI。最新交接以 PR 描述及评论为准。
- 阻塞：前序迁移尚未在 staging，不能跳号、复制前序文件或称迁移链通过。
- 实际验证：最终报告及成果回归 111/111 通过；API 类型检查、全包 ESLint 通过。
  主体实现全 API 单元测试 5907 通过、13 跳过；其后的导出与错误码调整另由上述 111 条覆盖。
  本地数据库 206/206 建库、137 个历史位置重复执行、0206 重复结构一致；
  定稿/选题绑定/并发/越权/删除/注销全部通过；本地指纹已生成、收敛复放及回滚恢复检查通过。
  指纹仅对应当前分支含 0206、暂缺 0203–0205 的结构，不能当作最终连续迁移链验证。
  远端 CI 和机器人审查见 PR，尚不声明清洁或验收完成。
- 未运行：浏览器、真实模型、远程迁移、合并、产品验收；模型调用 0，费用 0 美元。
