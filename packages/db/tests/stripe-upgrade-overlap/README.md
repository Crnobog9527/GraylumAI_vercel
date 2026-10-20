# PAY-STRIPE-MP 升级重叠修复（high）

产品依据：`docs/launch/MASTER_PLAN.md` 第 50/51 项及记录 Q/U/AB；
`docs/launch/tasks/PAY-WAFFO.md` D6、§6。积分永不过期，Pro 已发积分保留，
Pro 年付剩余期继续发放；Gold 单独计费。升级退款恢复 Pro 原期限，不恢复续费。

问题：现行预扣把两个各自合法的已付款升级窗口当作无法解释的重复窗口。
保留来源账本、退款回收、拒付冻结、并发锁和不合法窗口的拒绝。

## 修复

迁移 `0322_pay_stripe_mp_upgrade_overlap.sql`（总控 2026-10-20 按先就绪顺序改号，#1208 改用 0323）只替换三个函数：

- `atomic_pre_deduct`：保留全部来源校验，仅允许已付款升级订单指向的 Pro/Gold 两窗口重叠。
  会员权威投影选出的 Gold 是当前主窗口，旧 Pro 积分仍由原有来源账本分配、消费和退回。
  第三份来源、无法解释的两窗口、非规范和待审账务继续拒绝。
- `bill2_payg_compensate`：按内部订阅 ID 找回原来源，保留旧 Stripe ID 兼容路径。
  修复真实 BILL2 失败补偿不能定位内部订阅的问题。
- `opc_start_b1`：有效内部付费权益以权威投影为准；Gold 退款后恢复到原 Pro 时，
  不再被最新退款订单的状态误判为免费。其他来源冲突及原有免费回退保留。

没有新表、队列、调度或会员第二真相；不编辑账号余额、订单、订阅、积分或既有迁移。
预扣/结算元数据接口、锁和退款/拒付保护沿用现有实现。

## 验证

```sh
node packages/db/tests/stripe-upgrade-overlap/run-local.mjs --local-only
node packages/db/tests/run-db-baseline-replay.mjs --local-only --write-built
ruby .github/scripts/test-ci-workflows.rb
```

独立回归入口已接入 CI 的计费集成检查，只启动本机固定镜像的 PostgreSQL，
不用远程 URL、凭证、付费模型或 Stripe 网络。

原版真实升级/履约 RPC 创建的两份订阅在第一次预扣处复现
`PRE_DEDUCT_AMBIGUOUS_CANONICAL_GRANT_WINDOWS: 2`。
修复后的套件覆盖月付和年付两组：Gold 主窗口、跨来源消费、失败退回、并发 BILL2
同请求只扣一次、实际结算后的失败补偿、Gold 6/Pro 3 档案门槛、旧订阅结束、
Gold 退款恢复 Pro、异常来源继续拒绝、旧期限已过后积分仍可用、Pro 年付续发只发一次。
历史夹具以正常约束插入，不修改冻结的订单字段，也不关闭触发器。

另外验证迁移中断整体撤回、重复执行结构不变、撤回函数不改财务数据、重放结构收敛。
完整文件建库另负责逐个迁移的历史位置重复执行和提交指纹验证。
档案测试执行真实 SQL 上限门槛，低于上限时到达注册校验；完整建档恢复留待 staging 合并后。

代码撤回方式：先保存上库前的三个函数定义，恢复定义即可；不撤回已发生的用户消费，
不删除/重写任何财务记录。若需再次修复，前向迁移；旧逻辑仍会拒绝合法升级重叠。

## staging 事实与交接

2026-10-20 只读核查，两个指定测试账号都存在已付款 Pro（期末取消）和 Gold 的积分窗口重叠。
当前 `pay_common_membership_facts` 对两者均返回 Gold，`subscriptions=[]`，因此“这两个账号
被 0314 的重复订阅检查降成免费”这一具体原因未复现。回归实际发现并修复的是
Gold 退款后 Pro 恢复时的档案上限错误。

user3、user5 在 `https://auth-staging.graylum.com/api/trpc/opc.list` 均返回 HTTP 200 和成功结果。
`RUNTIME_STAGING_TARGET_DENIED` 在这条读取链路只来自部署/域名/分支/项目/数据库环境绑定检查，
发生在账号读取之前；账号不在测试名单会返回另一个错误 `RUNTIME_STAGING_ACTOR_DENIED`。
因此不能归因于这两个账号的会员数据。原失败发生时的入口/部署证据未取得，不能确定是哪项绑定不符。
没有为未复现的问题放宽保护、改配置或额外部署。

Owner 转总控 2026-10-20 的最新边界：本分支仅本地和 CI 验证，不部署到
`graylumai-staging` 的 production；合并进入 staging 后再验。
`staging-recovery.sql` 为总控审阅后的合并后验证材料：调用预扣/重放/真实建档函数，
整笔事务最终 ROLLBACK，不留余额或档案改动，不发模型请求。
上库前后还应只读核对两个账号的余额和积分来源未被迁移改写。
这项及合并后浏览器验收当前均为 NOT_RUN，最终交接以 PR 描述与当前版本 CI/审查回执为准。
