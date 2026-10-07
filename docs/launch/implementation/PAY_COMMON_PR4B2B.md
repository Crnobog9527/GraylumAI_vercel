# PAY-COMMON PR-4B2b：普通月付首购退款

当前为任务分支实现，**未合并、未启用、未应用远端迁移**。只限原 Stripe test 渠道的普通 Pro/Gold 月付首购；
年付、创始、升级、例外、Waffo 与工单 UI 不在本片。它不是完整 4B 或 PR-4 的完成声明。

批准与范围：[本片方案](https://github.com/Crnobog9527/GraylumAI_vercel/issues/716#issuecomment-6040670420)。
Owner 批准任务分支实现、本机合成验证、CI 和独立审查；明确禁止合并启用、远端迁移、实际 Stripe、
退款或取消订阅、配置与付费调用。

## 依赖与单一写入

总控明确交接后，#734 同一分支继承未合并的删除栈 #732，固定版本
`a759425b88bd2bb1f1ac652bc8139725a05e01eb`；0187–0192 冻结不改。
任务组合基线为 staging `7f791ffc99fadf6b15cc651123a2b756fc4f7ae2`。
不得把这个组合分支当成删除栈的合并批准。

本片只追加 0193–0195，以及必要的支付接线和金融删除证明；不改非金融删除、上传、进度、Auth/Storage 适配器。
删除线后来获准新增的 `authAdapter.ts` / `storageTransport.ts` 与本片无文件交集。

## 复用与最小新增

- 复用 #722 的完整本地/原渠道历史读取、4A 消费及金额规则；原只读预览保持 `executable=false`。
- 原 `payment_orders.refund_approval` 是审批与请求身份唯一权威；不建表、队列、账本或调度器。
- 原 `credit_transactions` 记录一次保留/一次失败恢复；原 `subscription_credit_grants` 和订阅字段仍权威于来源与权益。
- 0193 提供本地校验、版本绑定、审批和原子 claim；0194 提供阶段记录、现金结果与恢复；0195 提供共享保护和金融删除证明。
  分文件只为区分事务职责，三份按序应用，不是三个独立可启用的产品阶段。
- `monthlyRefundService` 连接薄管理员路由、纯步骤判定和窄 RPC；`monthlyRefundProvider` 只读原渠道事实。
  `monthlyRefundWebhook` 与既有退款入口分派原意图，避免误走积分包或再次来源回收。

## 核心合同

申请时间取同主体 billing 工单的原创建时间，原付款后 UTC 168 小时含边界。任意来源消费、在途预扣、
未知账务、续费/重购、年付、错币种/商户/模式、发放不可信均不能自动执行。原成交金额按最小货币单位计算；
6% 向下取整，法律不允许收费时为零。客户端不能提交退款金额、现金证据或“没有消费”布尔值。

审批同时绑定规范化条款的 SHA-256 和数据库金融证据指纹。不同有效管理员可以核对同一已批准意图，
原批准人和批准身份不变。新 claim 必须重新读取原渠道并在 profile → order → subscription → grants 锁顺序内复核。

claim 在同一事务中：

1. 从原余额保留全部原来源积分，记一条 `refund_clawback`；不动其他来源。
2. 将原来源 grant 置为不可消费、订阅置为 paused、会员投影置为 free。
3. 保存原 intent、金额、原请求键和 `review_required`；此时没有写“退款已成功”或不可逆终止信号。

共享触发器阻止其他生命周期/发放路径重新打开该来源，也阻止 held 期间新增会员购买和改回会员投影。
实际 invoice 发放仍走原事务 RPC，不另建发放系统。

渠道顺序为原订阅停止续费 → 原 Charge 退款 → 现金成功后立即取消原订阅。
每一步都先持久化 started，再次读取原渠道、经数据库 CAS 后才允许外部请求。
POST 使用原 intent 下分阶段固定键，保守重试窗口为原 claim 后 20 小时；DELETE 只凭原订阅当前状态核对，
不假称幂等键能保护 DELETE。取消参数固定 `invoice_now=false`、`prorate=false`。

停止续费的归属由原 Stripe event 的请求幂等键、订阅身份及 metadata 共同证明；metadata 单独不构成证明。
同秒冲突、查找不完整、其他未付账单、待计费项目、schedule、pending update、计量价格或未知现金身份均待核对。
外部读与数据库事务之间不宣称存在跨系统原子性；异常保留原身份，下一次先查询。

现金成功与权益终止分开记录。取消未知时现金成功事实仍保留，不能再次退款或恢复积分。
确认失败后，只在原订阅/期限及续费状态可安全恢复时一次释放保留；不能新建订阅或延长已付期限。
终态冲突和已知原现金上的额外/不匹配退款，持久化人工核对标记，不抹掉先前现金事实。

## 删除与恢复

新 claim 拒绝封闭主体。封闭前已批准、尚未 claim 的意图在证据不足时保留原批准并阻塞删除完成；
**不声称它已自动获得退款执行资格**，不重开工单伪造申请时间。

已 claim 且已确认停止续费的账户可以封闭。晚到现金结果仍记录在原意图；现金成功后可由有效管理员继续
终止原订阅，不能恢复账户、登录或会员。封闭后的现金失败恢复若不能安全恢复原生命周期，继续人工核对。

删除清理不改原审批 hash、条款、原现金/来源身份、claimedAt 或阶段键。金融证明仅接受严格已知的终态审批形状；
未知字段或子对象、未知渠道结果、未完结阶段继续阻塞完成/Auth 删除。原拒绝记录与其他旧审批形状仍按既有保守
人工核对合同处理，不因本片实现被当作零消费或可以直接删除。

已有任何审批事实时拒绝结构回滚；保留原记录并向前修复。仅本机无事实空库验证移除三份迁移并精确重放。
撤代码不能撤销外部现金，也不能换一个新身份重新执行。

## 验证与恢复入口

```bash
node packages/db/tests/monthly-refund/run-local.mjs --local-only
node packages/db/tests/run-db-baseline-replay.mjs --local-only --write-built
node packages/db/tests/erasure-completion/run-local.mjs --local-only
pnpm --filter @repo/api test:run
pnpm --filter @repo/api typecheck
node scripts/check-code-size.mjs
```

本机 runner 使用固定摘要 PG17、Unix Docker、一次性容器和合成身份，不接受远端 URL。
服务组合测试执行实际 TypeScript reader/adapter 和实际 SQL；仅 Stripe transport 是合成替身。
重复与并发由真实多连接验证；不能把 pure planner 或 mock 成功当作数据库/实际 Stripe 证据。

本机 Docker 对带 tag+digest 的名称解析失败，但同一固定 digest 已存在；本次仅在临时 CLI 包装中移除冗余 tag，
摘要未变，未改项目镜像或 CI 配置。临时包装和日志保存在任务证据目录，正式 runner 的校验未放宽。

## 可恢复交接（2026-10-08）

- 已实现：管理员报价/批准/拒绝/执行/状态、三份追加迁移、原渠道 reader、webhook 分派与组合测试。
- 本机 PASS：全量 API 293 文件、5659 测试；2 文件/12 项既有跳过。API 类型与全量 ESLint 通过。
- 数据库 PASS：198/198 建库、129 次历史位置重复、空事实回滚/精确重放、双连接竞争与封闭交叉、
  实际 TypeScript + SQL 合成渠道恢复、删除完成组合回归；指纹已重新生成，一次性容器均清理成功。
- 现金结果冲突由服务入口与 SQL 阶段事务共同阻断，正常渠道重读不能清除已记录冲突。
  覆盖结果写入失败后的晚到 webhook、缺失退款标记的分派、原账单重放/新续费入账保护、全额退款。
- 下一步：最终远端必需检查、完整独立审查及同范围修复。最终审查未完成前，不标记交付完成。
- 未运行：实际 Stripe、实际退款/取消、远端数据库/迁移、staging 浏览器、生产、永久删除、合并启用。
- 旧准备段的 CI/审查不代表本次完整实现。既有事实保留并向前恢复；不允许清理原意图或重新制造退款身份。

Stripe 边界依据：[取消订阅](https://docs.stripe.com/api/subscriptions/cancel)与
[幂等请求](https://docs.stripe.com/api/idempotent_requests)。只查官方文档，没有访问 Stripe 账户 API。
