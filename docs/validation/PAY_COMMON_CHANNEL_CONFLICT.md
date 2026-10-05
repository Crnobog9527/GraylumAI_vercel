# PAY-COMMON：支付渠道版本冲突修复

风险：high（后台支付渠道设置）。依据 #661 最后两条重验评论及 #668 合并后的缺陷。

目标：旧版本保存立即返回 CONFLICT/409 并显示原冲突提示；任何其他失败、超时或未知结果
结束保存中，提示先重新读取，且重新读取可用。保留版本保护、批量原子性、渠道与新购买的互斥。

范围：触发器冲突错误码、服务端映射、渠道卡片等待与恢复，以及对应回归测试。
不访问远端数据库、不改平台配置、不合并；完整 CI 后转 ready，处理独立审查并交主窗口。

## 调查

- 0173 触发器使用 SQLSTATE 40001 表达不可重试的业务版本冲突。
- 锁定版本的 Supabase 客户端仅对幂等请求重试；POST upsert 不自动重试。
- 应用的 Runtime budget transport 没有写入重试；tRPC mutation 默认无重试。
- Upstash analytics 通过 pending 后台 promise 记录，错误被捕获；中间件不等待 pending。
  因此该警告本身不证明它导致了冲突请求超时。
- [Supabase 官方故障说明](https://supabase.com/docs/guides/troubleshooting/high-cpu-and-infinite-transaction-retries-when-using-custom-error-codes-in-rpc-functions-77326b)：
  PostgREST 14 会重试人为抛出的 40001；业务冲突应使用 PT409。
- 待用本机 PostgreSQL + PostgREST 复现；远端版本、锁等待及逐请求因果链未核实。

## Handoff

已完成：只读排查与范围确认。下一步：本机复现、最小修复、测试、完整 CI 与独立审查。
验证：尚未运行修复验证。staging 第 4 步待主窗口按最终交接重验。
