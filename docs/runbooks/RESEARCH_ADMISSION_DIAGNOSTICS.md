# 研究工具准入拒绝排查

研究工具在模型请求前检查配置、测试窗口、价格与容量。返回空时，服务端等待写入现有的
`application_logs`（`message=research_admission_rejected`），同时输出同名结构化平台日志。
数据库日志不可用时，平台日志带 `persisted=false`；原拒绝不会变成付费降级。
日志只含请求/会话标识、配置版本、固定原因枚举、计数和平台/供应商/查询种类枚举，
不含用户输入、关键词、账号链接、提示词、凭证、价格配置原文或异常原文。日志沿用现有权限与注销清理。

已发布字段契约中的 `benchmark_findings` 标识需要对标研究的步骤，不按步骤编号、标题或用户文本猜测。
该步骤的非 opening、非小结导师请求必须获得完整对标工具集；没有获得时，在 `runtime_admit` 前拒绝，
不创建执行、不冻结积分、不发模型或供应商请求。界面沿用既有准入拒绝提示和输入恢复流程，用户可稍后重试。
其他步骤仍可正常对话；开场与小结保持原行为。已有请求回放优先读取原执行，不重新准入或扣费。

只读查询示例（替换请求标识，不重放请求）：

```sql
select created_at, request_id, context
from public.application_logs
where message = 'research_admission_rejected'
  and request_id = '<request UUID>'
order by created_at;
```

`reason` 给出最先阻断的全局门槛：`CONFIG_DISABLED`、`CONFIG_MISSING`、`CONFIG_UNAVAILABLE`、
`BILLING_PROFILE_UNAVAILABLE`、`MESSAGE_LIMIT`、`CALL_LIMIT`、`TOOL_LIMIT`、
`PRICE_CONFIG_UNAVAILABLE`、`THRESHOLD_CONFIG_UNAVAILABLE`、`CONTEXT_CAPACITY`。
`NO_ELIGIBLE_TOOLS` 或 `REQUIRED_TOOLS_UNAVAILABLE` 还带 `routes`，逐项说明供应商关闭、平台未核验、
窗口策略缺失、价格不可用、窗口价格不一致、报价早于任务截止失效、倍数超过窗口、启动门槛缺失或重复。
`missingBenchmarkRoutes` 表明哪些平台和查询种类尚未准入。修复对应原因，不放宽准入规则。

本变更不修改数据库结构；无需迁移。部署后在 user6 原新轮次仅复验一次，并核对日志、页面、
是否新增执行/费用及供应商累计预算；测试不能通过修改线上配置来人为制造拒绝。
