# S1 staging 数据库权限普查（2026-09-29）

风险：**普通（ordinary）**。本次仅新增报告；不改数据库、权限、代码或配置。

静态基线：`f3b7d6d08bfbe5d9f120e8e89a5432bb8b462522`。

## 紧急发现（普查进行中）

**B-01：登录用户具备读取模型密钥列的数据库权限，严重。**

2026-09-29 07:01 UTC 左右的 staging 系统目录显示：authenticated 具备 public schema USAGE、
ai_models 表 SELECT，以及 api_key 列 SELECT；RLS 已开启，但
`authenticated_active_ai_models_select` 对 authenticated 允许 `is_active = 'true'::text` 的行。
因此普通登录用户的数据库读取路径没有排除启用模型的 api_key 列。前端投影不能代替数据库列授权。

本次**没有读取 api_key 或任何业务数据的值**，未检查行数、实际密钥是否存在、是否被读取过，
未做 HTTP/登录运行时实测，不能声称已确认真实泄露事件。建议另立紧急权限修复任务，收回整表读取并显式列授权，
同时核对依赖 select('*') 的调用，避免修复泄露后造成正常功能失败；轮换决策需另行授权。

只读查询通过官方 CLI 对实时核实的 staging 目标执行。身份为 postgres，
`transaction_read_only=off`；按 Owner 明确例外仍只提交 SELECT。
已取得 public 范围 91 个关系、54 条策略、244 个函数的目录快照，原文仅存本机。

## Handoff

普查进行中。B-01 已提前报告，A/B/C 完整清单、逐表和代码对照、验证记录将在同一文件补齐。
保持 draft；总控通过后才 ready 和请求 Codex 审查；仅 Owner 在本会话发送“允许合并”后可合并。
