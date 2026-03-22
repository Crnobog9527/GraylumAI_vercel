# Stripe 启用清单

## 进入条件

只有在非支付预发布演练通过后，才允许开始本清单。

## 必需环境变量

- `STRIPE_SECRET_KEY`
- `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `NEXT_PUBLIC_APP_URL`

在开始实际启用前，先运行：

```bash
pnpm stripe:readiness
```

## 后台配置

必须为以下对象填写真实 `price_xxx`：

- 积分包
- 会员计划

## 回调与地址

必须核对：

- Checkout success URL
- Checkout cancel URL
- Stripe webhook endpoint
- 生产域名与 preview 域名的分离

## Stripe 验收

必须通过：

- checkout 成功
- checkout 取消
- 支付失败
- webhook 签名校验
- webhook 重放幂等
- 会员权益到账
- 积分包到账
- 后台订单/订阅状态一致

### 当前验证状态（2026-03-22）

本地 `test mode` 已完成并验证：

- checkout 成功
- checkout 取消
- 支付失败
- webhook 签名校验（非法签名返回 `400`）
- webhook 重放幂等（重复回放 `checkout.session.completed` 和 `invoice.payment_succeeded` 不重复发积分或会员权益）
- 会员权益到账
- 积分包到账
- 后台订单/订阅状态一致

部署环境 preview 已完成以下 smoke：

- `/login` 在关闭 `Vercel Authentication` 后可正常返回 `200`
- `/api/stripe/webhook` 在 preview 上可达，非法签名返回 `400`
- 购买积分包时会创建真实 checkout session，并跳转到 Stripe Checkout

生产环境已完成以下验收：

- `https://www.graylum.com/login` 可正常访问
- `https://www.graylum.com/api/stripe/webhook` 可达，非法签名返回 `400`
- 积分包购买按钮可创建真实 checkout session，并跳转到 Stripe Checkout
- 会员购买按钮可创建真实 checkout session，并跳转到 Stripe Checkout
- 第一笔真实 live 支付验收已完成，`payment_orders`、`credit_transactions` 与用户积分到账一致

当前剩余阻塞：

- 无功能级阻塞；剩余仅为发布后持续观测与文档维护

正式执行时，按这份 runbook 操作：

- [`runbooks/PRODUCTION_RELEASE.md`](./runbooks/PRODUCTION_RELEASE.md)

### 本次真实 live 支付记录

- Checkout Session：`cs_live_a1sjgMfsnWUiwrAVx6PC0yDI6qTJJLx6jbE1CiEkRl5n6Z7LsTaek1A5ST`
- 用户：`simonni@grayscalegroup.cn`
- 订单：`1774081a-8423-432c-ab4f-b1bc49242fd2`
- `payment_orders`：`status=completed`，`payment_status=paid`
- `credit_transactions`：新增 `purchase +500`
- 用户积分：`2796 -> 3296`
- 订单金额：`95` cents
- 说明：本次金额低于积分包基础价 `100` cents，原因是生产 `pro.package_discount=95` 生效

## 发布前最后确认

- Stripe 仍处于正确模式（test / live）
- 生产环境使用的不是测试 key
- 价格 ID 与后台套餐一一对应
- 退款 / 失败态不会造成脏账
- Vercel preview / production 已配置：
  - `STRIPE_SECRET_KEY`
  - `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`
  - `STRIPE_WEBHOOK_SECRET`
  - `NEXT_PUBLIC_APP_URL`
