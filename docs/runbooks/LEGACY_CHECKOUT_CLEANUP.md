# PAY-COMMON：9-22 遗留待付订单清理

风险：high（支付订单终态）。依据：[#679 主窗口审计](https://github.com/Crnobog9527/GraylumAI_vercel/pull/679#issuecomment-6011373921)。

## 范围和权限

**本任务 Owner 的明确限制（2026-10-06）：**

> staging 上的实际执行由主窗口在 Owner 批准后做。不访问远端数据库，不改配置，不合并。

这是本次委派的执行边界，不是新增通用审批规则，也不改变其他 staging 任务的默认权限。
按 AGENTS.md 第 2 节“Owner 的明确要求决定这次的目标和权限”，本执行窗口必须保留这个限制。
主窗口后续只能在 Owner 已批准的具体范围内执行；已有有效批准无需重复索取。
下文的批准标志用于表达这一次操作已处于该授权范围内，不能自行授予权限。

本次只交付工具、迁移与本地验证。不连接远端数据库、不改平台配置、不合并、不实际关单。
staging 的迁移应用、实际盘点和逐单执行，由主窗口取得 Owner 批准后进行。
正式环境的数据库只读盘点也必须先单独批准；关单和生产迁移需要另外的明确批准。
命令中的批准标志只表示执行者已取得相应批准，不能代替 Owner 授权。

盘点范围为 `payment_channel IS NULL` 的旧会员订单，创建时间早于
`2026-09-23T00:00:00Z`，状态为 pending，或已经被本工具关闭。
这个截止时间覆盖 9-22 遗留订单及更早同类订单，不能用于关闭 PAY-COMMON 新订单。
支持 `--order-id` 单独核对；即使传入较新订单，核验和 RPC 也拒绝关闭。
不删除行，不创建表，不补造订单渠道、付款事实或 provider 引用，不修改用户会员权益。

## 最小实现与事实来源

已有 `pay_common_close_checkout` 只支持带不可变 PAY-COMMON 合约及引用的新订单，
不能直接关闭渠道为空的旧订单；也不能调用当前 webhook 接口强行补造映射。
0179 在**同一个 RPC** 内增加显式 `legacy_expired` 分支，沿用 profile → order 锁序、
expired 终态和现有 `purchase_closed_at/reason/ref`。没有新表、新 RPC 或后台任务。
原调用的 `expired/never_created/not_prepared` 分支不变，权限仍仅 service_role 与数据库管理角色。
新分支不处理支付，只接受已核实的关闭请求；与原 RPC 一样，Stripe 核验由可信服务执行者负责。
直接调用 RPC 不能替代下面的核验工具。

Stripe 通过同一只读客户端取回的结账对象是外部付款事实来源；数据库是本地订单及关闭记录来源。
按 [Stripe Checkout Session 文档](https://docs.stripe.com/api/checkout/sessions/object) 核对：

- 结账 ID、test/live、用户引用、商品、价格、周期、金额和币种全部匹配。
  旧流程 metadata 没有 orderId，因此允许缺失；若存在则必须匹配。
- status=expired、payment_status=unpaid、有效到期时间已过。
- subscription、invoice、payment_intent、setup_intent **明确为 null**。
  字段缺失、任何关联对象、存在任何恢复结账配置或未知，都保持未决。
- 有 customer 时，完整的订阅（含所有状态）和发票列表必须均为空。
  这里故意保守：即使可能是无关的历史订阅或发票，也交人工核对，不自动判断无关。
- 本地无已履约、付款事实、关联订单、provider 引用或积分发放记录。
- 任何网络、权限、分页或身份异常，输出 unresolved，不执行 Stripe expire/cancel/refund 等写请求。

## 主窗口获批后的操作

在审查通过的版本上运行 `pnpm install --frozen-lockfile`。使用受控终端，禁止 shell tracing。
从现有安全凭证入口注入这三个专用环境变量；不要把具体值写入命令、仓库、PR 或聊天：

- `LEGACY_CLEANUP_DATABASE_URL`：主窗口核实的目标库连接；只读盘点优先使用只能读的连接。
- `LEGACY_CLEANUP_STRIPE_KEY`：目标模式的现有 Stripe restricted key，权限为只读。
- `LEGACY_CLEANUP_STRIPE_ACCOUNT`：主窗口核实的 Stripe 商户身份，工具读取当前商户并比对。

工具不加载 `.env`，不沿用应用默认数据库连接，不打印商户身份、用户身份、凭证或 Stripe 对象。
若现有凭证不满足只读权限要求，停止并交主窗口处理；本任务不授权创建或修改凭证。
主窗口负责将明确批准的数据库项目和 Stripe 商户／模式配对，不可凭结账 ID 前缀判断目标库。

**staging 只读核对**（test 模式）：

```bash
node scripts/legacy-checkout-cleanup.mjs --target staging --approved-read
```

**正式环境上线前只读盘点**（live 模式，必须先获正式环境读取批准）：

```bash
node scripts/legacy-checkout-cleanup.mjs --target production --approved-read
```

两者均使用 `BEGIN READ ONLY`；盘点不要求先应用 0179。最多读取 1000 笔，超限直接报盘点不完整，
不得将其当作全部通过。结果只含订单 ID、判定和固定原因码，仍应作为私有运维材料保存，公开 PR 只记录数量。
`eligible` 只是当次证据符合，不能充当稍后关单的持久授权。`unresolved` 要逐条交主窗口，不得改状态绕过。
退出码：0=完整且无未决；2=存在未决；1=全局失败或盘点不完整。

**受控关闭**：只有已获单笔关单批准、且主窗口已按获批流程应用 0179 后执行。
将获批的单笔订单 ID 放入终端变量 `LEGACY_ORDER_ID`，不要公开其值。

```bash
node scripts/legacy-checkout-cleanup.mjs --target staging --approved-read \
  --apply --approved-close --order-id "$LEGACY_ORDER_ID"
```

正式环境使用 `--target production`，必须先另行取得该单笔正式关单及迁移批准。
不支持批量关闭。工具在事务中先按既有顺序锁定 profile 和 order，再读取最新本地事实和 Stripe 证据，
随后调用现有关单 RPC。SQL 再次检查本地付款、关联记录和范围，成功只改变关闭字段和订单终态。
同一笔重复调用返回 already_closed；两次并发关闭只会发生一次状态迁移。

**执行后**：再次运行同目标、同订单的只读命令，确认 already_closed、付款状态仍 unpaid、订单行仍在。
随后主窗口继续 #679 的沙盒购买验收；本地测试不替代远端执行结果或产品验收。

## 迁移、兼容与恢复

0179 有现有函数正文 md5 前置守卫，同时接受迁移后的同一正文，支持重复应用；未知版本拒绝。
正常购买和现有关闭调用不依赖新分支；工具要求先迁移后写入，旧库调用该分支会拒绝。
使用仓库既有迁移应用流程，不从工具自动迁移，也不修改远端配置。

失败或超时后，不自动重试写入：先用新的只读连接核对实际订单和 Stripe 状态。
提交响应丢失时可能已关闭，不能把客户端报错等同于未提交。
订单和付款事实始终保留；已过期结账不能恢复付款，不应重开旧订单。新购买必须走正常准入和新结账。
发现付款证据矛盾时停止后续操作，由主窗口核对并按现有支付核账流程处理，禁止自动冲正或删行。
需要回退代码时可恢复迁移前的同签名函数正文和原 ACL，但不会回滚已核实的关闭事实；这也需要相应环境批准。

## 本地验证

所有数据均为合成夹具，Stripe 为模拟对象；数据库为固定镜像启动的一次性本地 PostgreSQL，结束后清理。

```bash
node --test scripts/tests/legacy-checkout.test.mjs
node --test scripts/tests/legacy-checkout.integration.mjs
node packages/db/tests/run-db-baseline-replay.mjs --local-only --write-built
node scripts/check-code-size.mjs
```

完整 CI 的脚本测试会运行单元测试；数据库端到端集成由上面的显式本地命令运行，不能混称 CI 已覆盖。
仓库全量迁移回放会逐项核对指纹及迁移重复性。结果和最终独立审查记录见 PR 交接。
