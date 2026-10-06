# PAY-COMMON 未付款结账重报价

风险 high：改变结账金额与未付款尝试的退役条件。关联 #676、#679。

## 实现与兼容

0177 更新现有 `pay_common_create_purchase`，仍由 profile → order 锁和原有订单控制并发。
它重新计算当前商品快照、会员等级、积分包折扣比例与价格映射，把这些输入的版本化摘要
保存在已有不可变的 `purchase_payload_hash` 中。没有新增表、字段、RPC、账本或队列。
RPC 仅在返回值 metadata 中给出 `requoteRequired`，不会把这个决定写成可变的权威状态。
旧的订单、价格快照、摘要和付款事实不改写。

相同依据继续复用；依据变化则通过原有关闭流程退役旧尝试，再重新 admission。
开着的结账在作废之前核对付款意图及其全部可读取扣款记录，作废之后再次读取终态。
成功扣款、可捕获金额、处理中、读取失败、身份不一致和不完整证据均阻止替换。
并发中的失败点击可以重试，后续复用同一个有效的新结账。

历史订单摘要没有完整价格依据，保守地进行一次安全退役。没有准备请求的旧订单走已有
`not_prepared` 保护性关闭；请求已冻结但无法确认是否创建过结账的尝试，继续沿用现有
恢复扫描和过期宽限，不会因为本次重报价而跳过证据要求。

上线顺序：先 SQL、后服务端。新服务端连接旧 RPC 时因缺少报价核对结果而拒绝创建，
不会静默复用旧价格。旧服务端可读取新 RPC，但不具备重报价能力，因此二者都完成后
才算修复生效。恢复采用保留订单和映射的前向修复；只撤回服务端会恢复旧复用行为，
不能当作已满足重报价验收。本文不授权任何远端迁移或部署。

## 本地验证

只使用一次性本机 Docker PostgreSQL 与内存中的 Stripe test-mode 响应，不调用 Stripe。

```sh
pnpm --filter @repo/api exec vitest run src/services/payments/stripeCheckoutPersistence.test.ts src/services/payments/stripePurchaseEvidence.test.ts
pnpm --filter @repo/api exec vitest run --config vitest.integration.config.ts src/services/payments/stripeRequote.integration.ts src/services/payments/stripeDeclinedPurchase.integration.ts
node packages/db/tests/run-db-baseline-replay.mjs --local-only --write-built --after packages/db/tests/pay-common/purchase-admission.sql,packages/db/tests/pay-common/checkout-persistence.sql
```

`purchase-admission.sql` 也由现有 CI 的数据库回放执行。完整命令结果见 PR 交接；
迁移编号从 staging 的 0176 连续到本任务的 0177，不建立占位迁移或放宽检查。

## Validation handoff

本任务不合并、不连接远端数据库、不应用远端迁移、不修改配置。
主窗口在 Owner 批准后先把 0177 应用到 staging，再完成审计和合并；本任务不执行这些操作。
服务端交付后，在 staging 执行以下 Stripe 测试模式验收：

1. 免费身份打开积分包结账，记下金额，不付款。
2. 升级为会员，再点击同一个积分包。
3. 应打开新的结账页，金额与会员卡片的新价格一致；原结账已失效。
4. 再点同一积分包，应复用新的结账，不再重复创建。
5. 会员订阅的商品价格或映射变化，也应遵守相同的安全换新规则。

真实 staging 浏览器/Stripe 沙盒验收在本任务范围内未运行，本地模拟通过不能替代该结果。
