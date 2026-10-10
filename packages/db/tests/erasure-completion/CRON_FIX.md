修复 DATA-ERASURE 每日执行器在 staging 全部失败的问题。验收：本机重放数据库定位具体 RPC/SQL 错误，补回归测试；现有请求记录保存脱敏的 RPC 名和错误类别；说明 BILLING_NO_PROVIDER_ID 的正确收尾边界。

风险 high：涉及注销、数据库与账务保护。只在独立 worktree 修改代码及本机合成库验证；staging 仅只读或最终 ROLLBACK 的诊断事务，不提交改动，不删除数据，不访问正式环境。本任务不应用迁移、不合并。需要迁移时先由总控分配编号。

## Handoff
- 已核对 staging、PR #748 与现有规则；起点 a49a1cf7cc24ac71eaddb90d219b9429c224b627。
- 原有完整注销集成本机测试通过，尚未覆盖 staging authenticator 的 safeupdate 保护；正在构造回归。
- staging 只读查询确认 BILLING_NO_PROVIDER_ID 指一笔已 dispatch 的模型调用缺少 provider_id 和成本，不是支付订阅 ID。
- 下一步：完成复现、修复、回归与独立审查；不得将当前状态记为已修复。
- 迁移编号及与 #766 共用数据库指纹文件的写入协调待总控确认。
