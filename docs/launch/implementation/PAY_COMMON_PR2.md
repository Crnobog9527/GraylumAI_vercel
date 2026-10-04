# PAY-COMMON PR-2 implementation

Risk: high — payment identity, fulfillment, membership and database transaction boundaries.
This slice implements section 6 PR-2 of `docs/launch/tasks/PAY-COMMON.md`.

## Scope and delivery boundary

- Stripe checkout intent is persisted before dispatch, with a stable order-derived identity.
- Payment readers and writers switch together to `payment_provider_refs` authority;
  compatibility columns are derived in the same transaction.
- Callback, return, renewal, cancellation, receipt and grant paths preserve original channel
  and frozen purchase facts. Existing payment transactions and ledger remain authoritative.
- No new channel setting, Waffo, refund policy, Runtime or BILL2 consumer changes.
- Migration starts at 0168; 0167 belongs to PR #632. Recheck numbers and regenerate the
  built fingerprint against the actual merge order before delivery.
- Draft only. No remote database, remote migration, configuration, ready transition or merge.

## Recovery

Preserve orders, mappings, snapshots and grants; repair forward. Do not delete financial
facts or roll the application back to independent writes of legacy Stripe columns.
Unknown provider outcomes retain the original attempt and require reconciliation.

## Validation record

Implementation and validation are in progress. Local results belong to their exact candidate. The previous candidate failed CI because 0167 was missing;
PR #632 has now merged. Refresh staging, rebuild the fingerprint and run full CI before reporting a new result.
The PR Handoff records actual commands and results; fixture tests do not establish a real
Stripe sandbox end-to-end result. Existing Stripe regressions, new denial/replay/order tests,
local empty-database replay twice, types, lint, code size and required CI remain to run.

## Current implementation checkpoint (incomplete)

The current draft adds **only an unconnected foundation**:

- `pay_common_create_purchase` serializes an existing subject's checkout intent under the
  profile lock, requires an existing Stripe price mapping, freezes server-side product facts,
  and reuses the unresolved order. It makes no provider call.
- 0168 adds the missing server-maintained package version timestamp. A small admission RPC
  is necessary because existing direct order inserts cannot atomically freeze and reuse an
  unresolved intent. Orders remain the sole purchase authority; no new state table is added.
- Pure helpers validate exact USD cents, receipt amount/mode/currency, frozen credit totals
  and an order-derived provider key. No existing caller uses them yet.

**Do not deploy this as PR-2 completion or enable a partial mapping switch.** The following
work is still required together on this branch:

1. Connect checkout dispatch/recovery to durable orders; preserve the exact request envelope
   across retries and explicitly reconcile provider expiry/unknown outcomes.
2. Switch all payment readers/writers, including catalog administration, to authoritative
   provider refs with transactionally derived legacy columns. Resolve current catalog-price
   selection without discarding prior price mappings. Never invent external identities.
3. Extend the existing fulfillment RPCs for order/grant snapshots, immutable renewal contracts,
   original-channel receipts/cancellation, lifecycle ordering and closed-account handling.
4. Make membership facts explicitly channel-aware without changing Runtime consumers.
5. Add full callback replay/out-of-order/duplicate/concurrency/recovery coverage, then run the
   complete final candidate validation. Foundation tests do not prove these behaviors.

The admission function is not yet the complete membership eligibility check; connection must
preserve all existing allowed/denied semantics and recheck relevant facts inside the transaction.
Do not call it as a replacement for the existing eligibility service as currently written.


## 2026-10-05 中途审计修正与剩余清单

依据：PR #633 评论 5982770208。先修正 P2-1–4，再接业务路径；不叠在 #632 分支上。

- P2-1：免费用户仍可买积分包，按原价；已有会员按现行折扣。**“积分包只卖会员”移交 PAYWALL**，
  本 PR 不提前改变购买准入。其他原有退款/冲突/账号封闭拒绝仍须保持。
- P2-2：`payment_provider_refs.is_current` 只标记当前目录价格；同渠道、商户、模式、商品、周期
  用部分唯一索引保证至多一个。旧映射保留供原订单使用；0 行报 `PAY_COMMON_PRICE_MAPPING_MISSING`，
  多行报 `PAY_COMMON_PRICE_MAPPING_AMBIGUOUS`，不泄漏 P0002/P0003。
  订单冻结 `price_ref_id`；派发前 Stripe price 的身份、模式、币种、标价、计价方式和周期必须与快照一致。
  会员折扣比较的是原标价与冻结折扣，不能拿优惠后实付去校验原 price。
- P2-3：关闭方为 Stripe 适配层，处理 `checkout.session.expired` 或原单恢复查询时，必须重新读取
  原映射会话并确认 expired/unpaid、原主体/订单/商户/模式及金额；查询失败、页面取消和本地超时不关闭。
  关闭事实放在受保护的订单列，由专用 RPC 写原因与原会话引用；直接 metadata 更新不能解除原意图。
  已付款/已履约/退款终态拒绝过期覆盖；过期重复关闭幂等，之后新购买获得新订单/请求身份。
- P2-4：`purchase-admission.sql` 接入 pay-common 运行器，并加入 CI 原有空库检查的 `--after` 列表；
  CI 合约测试同时锁定这一入口。0161 的历史测试在它的真实历史位置运行，再执行后续迁移。
- P3：两种商品版本时间统一由数据库维护；priceRefId 从 metadata 移到冻结外键。
  未映射且未履约的旧订单拒绝新购买并报 `PAY_COMMON_LEGACY_ORDER_UNRESOLVED`，不猜关联或丢账。
  迁移已增加精确源结构和重放结构的漂移预检；履约 profile→order 锁序随最终函数接线完成，尚未验证。

完整 PR-2 尚须实现并验证以下事项，基础 helper 或 SQL fixture 不代表它们已经接通：

- [ ] Webhook 验签后权威查询，核对主体、商户/模式、对象类型、商品、金额、币种、周期。
- [ ] 冲突证据与付款金额事实按身份锁内追加/去重，128 条边界明确拒绝；手续费/净额未知保留 unknown。
- [ ] 返回页不作为付款证明；返回页与 webhook 并发只履约一次。
- [ ] 同发票的 invoice.paid/payment_succeeded 去重；迟到 pending/failed 不覆盖终态。
- [ ] 所有目录、下单、回调、续费、取消和凭证读写接到映射；旧列只作同事务派生。
- [ ] Pro→Gold 的 changeSubscriptionPlan、待生效改计划订单也使用新身份/映射与冻结购买事实。
- [ ] 首次/续费使用冻结合同；年付 cron 按原渠道、内部订阅及 grant_snapshot 发放，webhook/cron 同期一次。
- [ ] 派发前调用价格校验；expired 回调与恢复查询调用受保护关闭入口，覆盖真实路由允许/拒绝。
- [ ] profile→order→subscription/grant 锁序、并发双击/履约/退款/注销及崩溃恢复验证。
- [ ] Stripe sandbox 端到端证明；本地 fixture 不冒充供应商测试交易。
- [ ] #632 合并后同步 staging、保持正确迁移编号、重新生成 built-fingerprint，运行全部 required CI/Security。

缺 0167 导致账本检查失败是已知前置阻塞，不复制 #632 的迁移、不降检查、不据本地结果宣称 CI 通过。

### 本轮本地验证记录（P2 修正阶段）

- PASS：API typecheck、lint；新增证据/金额测试 39 项；代码规模检查。
- PASS：本机临时 PostgreSQL 空库完整建库，170 步、101 次迁移重放；购买准入 SQL 全部通过。
- FAIL：同步 staging 前 CI 工作流合约测试 9 项中 1 项因缺 0167 失败；不是支付断言失败。
- NOT_RUN：实际业务接线后的全量 Stripe 回归、真实 Stripe 沙箱端到端、最终候选 CI/Security。
- #632 已合并，缺 0167 为旧候选的已知失败；同步 staging 后重新验证，不把旧失败直接改写为通过。
