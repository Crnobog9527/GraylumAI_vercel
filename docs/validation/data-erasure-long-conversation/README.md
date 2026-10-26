# DATA-ERASURE：定位长对话删除诊断与超时拒绝

## 范围与结果

按任务单的“能删除，或给出明确、可操作原因”分支修复：数据库明确返回语句取消（SQLSTATE 57014）时，整次 RPC 已回滚，返回 `PRECONDITION_FAILED / CONTENT_ERASURE_TIMEOUT`。现有删除错误适配显示“删除处理超过时间限制，本次没有删除。请稍后重试；如果仍然失败，请联系支持。”列表恢复，停止不确定结果的自动重试。

网络断开、丢失响应、无法解析结果仍是未知结果：保留原来的幂等确认机制，不能误报未删。没有数据库变更，没有增大 8 秒限制，没有新表、队列或后台任务，没有写 staging。

## 根因证据与边界

- Owner 转总控的 READ ONLY 查询：该会话 26 次执行均已结束，账务运行均已结清，无 held 报告费、无评审、无活动执行。范围计算 26 次执行 / 1 会话 / 0 项目耗时约 0.69 秒；项目有 1 个报告版本。
- staging 的 authenticator 设置 `statement_timeout=8s`、`lock_timeout=8s`，历史失败请求约 9 秒返回 503，与数据库超时吻合。
- 原服务将所有未知数据库错误（包括明确取消）统一包装成 503；客户端将 503 当作结果未知并自动重试。这条错误分类和恢复路径已用先红后绿用例复现并修正。
- Vercel 故障时段周边接口有日志，删除接口无日志。原 timing 只在进入 Runtime/定位专用阶段后输出；account 只走 prelude，因此“无 timing”不能证明未进入 account 接口，也不能证明是 Redis。
- 原故障没有保留 SQLSTATE，不能证明那四次 503 一定是 57014，或宣称已消除 staging 性能根因。新的开始日志、host timing、代理拒绝和 tRPC 错误日志将区分实际路径。未得到数据支持前不改 Redis 配置，也不提高超时。
- 已配置的数据库查询入口缺少该项目的只读权限；staging SQL 均由总控执行并转来结果，没有更换凭证。

## 可观测性

- 标记入口：`conversation_erasure_started`，仅记录操作名与会话标识；结束时输出既有请求耗时。
- 数据库不可用：`content_erasure_unavailable`，原因码区分 `DATABASE_TIMEOUT`、`DATABASE_LOCKED`、`DATABASE_CONNECTION`、`DATABASE_REJECTED`、`DATABASE_ERROR`、`DATABASE_UNCONFIGURED`、`INVALID_RESPONSE`、`TRANSPORT_FAILURE`。
- 进入处理器前被限流拒绝：`proxy_service_unavailable / RATE_LIMIT_BACKEND_UNAVAILABLE`。
- tRPC 的每个 SERVICE_UNAVAILABLE：`trpc_service_unavailable`；维护拒绝也明确记录。日志不含原始错误、私文、URL、密钥或 Cookie。

## 验证

- 原实现：诊断回归 6 失败 / 1 通过；确认回滚仍被包装为 503 的回归 1 失败 / 6 通过；代理/路由诊断 2 失败 / 3 通过。
- 修复后：API 相关 32 项通过；API 全量 615 文件、9186 项通过（4 文件 / 20 项按既有前提跳过）。
- Web 代理、维护、tRPC、错误分类等相关 96 项通过；补充删除控制器超时恢复测试后，错误适配/控制器 25 项通过。
- API/Web 类型检查、API lint、Web 修改文件 ESLint、代码大小和函数补丁检查通过。
- 本地数据库使用全仓文件建库、真实 PAYG 准入与结算、26 次历史执行、52 次合成调用、52 条历史及已发布报告；真实语句取消验证回滚，随后以同一 8 秒限制验证删除（本机 619ms）、幂等、账务不变和越权拒绝。合成调用不接供应商。

## Validation handoff（总控合并部署后）

入口：`https://auth-staging.graylum.com`。运行 `node ~/.graylum/staging-login user2`，用生成的 storageState 打开浏览器；过期就重跑；不读取、不记录凭证。

1. 由总控确认可以进行本次真实删除，打开任务单已选定的 Temari 定位档案；记余额，核对至少 20 条用户消息和报告。
2. 左侧更多操作 → 删除对话 → 确认；记录 UTC、接口状态和耗时。
3. 成功时：刷新后该对话不在列表，原链接不能再读取对话内容；余额不变。保留既有已确认资料/报告的产品边界。
4. 如果数据库超时：显示明确“本次没有删除”提示，列表恢复，不自动持续重发。总控按开始日志、数据库原因码和耗时定位；若是代理拒绝，核对实际 Redis 连接失败类型，再决定设置项。当前没有证据支持更改某个 Redis 设置。
5. 若为传输未知：不假报成功或失败，仍按原请求幂等确认；总控查实际标记。不要盲目重复删除。

通过标准：成功删除或明确可操作拒绝；不得继续只显示“正在重试”而没有原因。staging 实际删除、浏览器复验和任何性能优化均未运行；没有付费调用预算。
