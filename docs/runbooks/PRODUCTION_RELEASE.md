# 正式生产发布 Runbook

## 目标

把当前已在 preview 和本地 `test mode` 验证通过的状态，安全推进到正式生产发布。

本 runbook 只覆盖最后一段：

1. 生产环境 Stripe 配置核对
2. 正式部署
3. 发布后 smoke
4. 回滚触发条件

## 前置条件

以下条件必须全部成立：

- 非支付严格签核已完成
- Stripe 本地 `test mode` 验收已完成
- preview Stripe smoke 已通过
- 后台活动积分包和会员计划已经填写正确的 `price_xxx`

## 一、生产环境变量核对

发布前必须在 Vercel Production 环境确认：

- `NEXT_PUBLIC_APP_URL`
- `NEXT_PUBLIC_SITE_NAME`
- `NEXT_PUBLIC_SUPPORT_EMAIL`
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `STRIPE_SECRET_KEY`
- `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`
- `STRIPE_WEBHOOK_SECRET`

额外核对：

- `NEXT_PUBLIC_APP_URL` 不能是 `localhost`
- Stripe key 模式必须与本次发布意图一致
- 若要正式收款，应使用 `pk_live_...` / `sk_live_...`
- 若要先做生产软发布但仍保持测试模式，必须在发布记录里显式注明

## 二、生产外部配置核对

发布前必须确认：

- Supabase Auth redirect URLs 已包含正式域名
- `verify-email` 回跳地址指向正式域名
- Stripe webhook endpoint 指向正式域名：
  - `https://<production-domain>/api/stripe/webhook`
- Stripe Dashboard 中 webhook signing secret 与 Vercel 生产环境一致
- 生产用 `price_xxx` 与后台套餐一一对应

## 三、正式部署

执行原则：

- 固定本次发布 commit / deployment
- 部署时保持监控和日志窗口打开
- 不在正式部署窗口内混入额外功能修改

推荐执行顺序：

1. 冻结本次发布 commit
2. 确认 Vercel Production 环境变量已保存
3. 触发正式部署
4. 等待 deployment `Ready`

## 四、发布后 smoke

### A. 公开与认证

- 首页可访问
- `/login` 可访问
- 普通用户可登录
- 管理员可登录后台

### B. 核心功能

- 聊天页可进入
- 用户中心订阅页可打开
- 后台 packages/settings/diagnostics 可打开

### C. 支付链路

至少验证：

- 积分包购买按钮可跳转到 Stripe Checkout
- 会员购买按钮可跳转到 Stripe Checkout
- 非法签名请求命中 `/api/stripe/webhook` 时返回 `400`

若本次生产环境已启用 live 模式：

- 第一笔真实支付必须由明确授权人员执行
- 支付后核对：
  - `payment_orders`
  - `credit_transactions`
  - `user_subscriptions`
  - 用户侧积分或会员权益展示

### D. 运行观测

- Vercel 函数日志无新增高频错误
- Stripe webhook delivery 成功
- Sentry 无新增 P0/P1

## 五、回滚触发条件

出现以下任一情况，应立即回滚到上一版稳定 deployment：

- 登录不可用
- 聊天主链路不可用
- 后台不可进入
- 支付 checkout 无法创建
- webhook 大面积失败
- 真实支付后权益或积分不到账

## 六、发布完成标准

满足以下条件才算正式发布完成：

- 正式 deployment 已 Ready
- 发布后 smoke 全部通过
- Stripe checkout 可达
- webhook 路由可达
- 如已执行真实支付，到账与状态一致
- 无未关闭 P0/P1

## 七、发布后记录

发布完成后，至少记录：

- production deployment URL / ID
- 本次使用的 Stripe 模式（test / live）
- smoke 结果
- 是否执行真实支付
- 若执行真实支付，对应订单和到账结果
