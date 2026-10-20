# PAYWALL 定位档案归档后端交接

Owner 2026-10-20：“档案归档释放名额现在就补”。迁移 **0324**，Owner 已转达总控预留。
风险 high；本次只补定位档案归档后端，主任务其他切片不因此算完成。

## 范围与验收

归档本人 `opc_businesses` 后只读、可查看和导出已有报告与确认资料，不占免费 1 / Pro 3 / Gold 6 的名额。
归档和新建上限检查复用 `profiles` 用户行锁，计数仅包含未擦除且未归档档案。
同一档案关联的定位草稿、选题对话、账号策略、工作项、报告和 Fusion 的写入与付费入口都在数据库拒绝。
已准备但尚未派发的旧调用不能在归档后继续派发；已派发且尚未结算时归档返回忙碌，原调用收尾后重试。
不提供取消归档；不做前端，不改价格或权益，不处理到期降级时选择保留哪些档案的另一切片。
复用现有业务、草稿、账号、Runtime/BILL2 关系，不新增表、队列、任务或另一份会员状态。

## 给 Claude 的前端接口

1. `opc.businesses()`：返回本人未擦除档案数组，包含归档和使用中的档案。
   - `businessId: UUID`、`name: string`、`archivedAt: string | null`、`isArchived: boolean`。
   - `currentSourceVersionId: UUID | null`、`createdAt: string`。
   - `drafts: {draftId, projectId, roundId, sessionId}[]`：本人未删除的关联定位草稿，供既有读取接口使用。
   - 时间为数据库输出的 ISO 时间字符串；归档状态以服务端为准。
2. `opc.archiveBusiness({businessId: UUID})`：mutation，actor 来自登录会话，不接受 actor 或取消归档字段。
   - 返回 `{businessId, name, archivedAt, isArchived: true}`。
   - 幂等重试返回原归档时间，不重复改版本。成功后刷新档案列表，立即可以新建档案。
3. `opc.read({draftId})`：继续读取原定位档案及 `information`、`snapshot`、已发布 `report`。
   - `opc.positionHistory({draftId})`：既有定位历史。
   - 归档状态从 `opc.businesses` 与其 `drafts` 映射，不能把归档当作对话删除。
4. `runtime.reportLatest({sessionId, projectId, roundId})`：寻找原已生成报告。
   - `runtime.reportStatus({executionId})`：原报告状态/正文；
   - `runtime.reportDocument({executionId})`：原文档正文、手工保存内容、结构化报告及最终确认状态。
   - 上述均为既有只读接口；前端继续以返回的正文/确认资料导出，不重新生成、不扣积分。
   - 原有擦除、内容删除、权限及来源校验继续有效；归档不会恢复已删除的内容。

稳定拒绝：`OPC_BUSINESS_ARCHIVED`（FORBIDDEN，归档只读）、`OPC_BUSINESS_DENIED`
（FORBIDDEN，非本人/不存在/已擦除）、`OPC_BUSINESS_BUSY`（CONFLICT，正在修改或有已派发调用未结算，稍后重试）。
未归档的新建上限仍返回 `OPC_PROFILE_LIMIT`。没有取消归档接口。

## 迁移兼容与恢复

- 0324 只追加 nullable `archived_at`、活跃档案索引和 RPC/校验，不重写既有内容、来源或财务数据。
- 数据库先于应用：旧版六参数新建 RPC、原读取接口仍可用，旧版写入口同样受归档校验约束。
- 后端应用需在 0324 应用后发布，否则新接口会明确报库结构尚未就绪。
- 完整事务中断应全部撤回；0324 连续执行两次结构/ACL 不变，重跑保留归档时间、原内容和版本。
- 应用回退可回到旧版，但保留数据库 0324 和已归档状态/服务端保护；禁止清空归档列或恢复旧计数函数。
  已释放的名额可能已被使用，清空列会重新占位，恢复旧写权限还会破坏只读承诺。
- 数据库问题采用保留归档状态的向前修复；本次不提供会丢失归档事实的 down SQL。
- 总控应用前后依 ENGINEERING 采集只读结构指纹；本任务只提交 built-fingerprint，不自行上远程库。

## 验证与交接

已完成：阅读规则、规划、#1163/0314、#1209/0322；0324、前端接口、数据库回归与 API 测试。
本地隔离数据库已验证：归档/重试、新建释放名额、用户锁并发、本人允许/他人拒绝、旧请求拒绝、
已派发调用结算后归档、未派发调用归档后拒绝、账务收尾、报告和资料读取，以及账号/工作项只读。
下一步：最终完整迁移回放、CI/安全检查、独立审查及必要修复，全部对应最终版本。
当前尚未完成最终门槛，不能合并。CI 结果与独立审查完成后更新。
不部署本分支到 graylumai-staging 的 production，不合并、不上远程数据库、不调用真实付费模型。

## 发现的问题

无本轮范围外新增问题。已保留 #1209/0322 的付费会员权威回落逻辑。
