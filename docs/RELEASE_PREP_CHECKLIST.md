# 上线前发布清单（Stripe 最后接入）

## 目标

这份清单用于把当前状态从“非支付功能已完成严格签核”推进到“可正式进入 Stripe 接入与生产发布”。

执行顺序固定：

1. 先完成非支付发布准备
2. 跑完整预发布演练
3. 关闭演练中的最后非支付问题
4. 最后接入 Stripe
5. 再做正式生产发布

## 当前 accepted risk

- Supabase 免费套餐无法启用 `Leaked Password Protection`
- 该项保留为平台级 accepted risk，不阻塞非支付发布准备

## 一、生产前非支付发布准备

### 环境变量

必须核对：

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `NEXT_PUBLIC_APP_URL`
- `NEXT_PUBLIC_SITE_NAME`
- `NEXT_PUBLIC_SUPPORT_EMAIL`
- `NEXT_PUBLIC_SENTRY_DSN`
- AI provider keys

需要预留但暂不启用：

- `STRIPE_SECRET_KEY`
- `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`
- `STRIPE_WEBHOOK_SECRET`

### 外部配置

必须核对：

- Supabase Auth redirect URLs
- `verify-email` 回跳地址
- Vercel preview / production base URL
- Deployment Protection bypass 流程
- Sentry 项目、DSN、告警入口

### 本地基线

必须通过：

```bash
pnpm --dir apps/web exec tsc --noEmit
pnpm build
```

## 二、预发布演练

统一使用锁定的 preview / staging URL，不允许测试过程中切换部署版本。

推荐入口：

```bash
pnpm release:preflight -- --with-preview --preview-url <preview-url> --bypass-cookie <cookie>
```

如果要纳入隔离 destructive 演练：

```bash
pnpm release:preflight:destructive -- --preview-url <preview-url> --bypass-cookie <cookie>
```

### 预发布环境必跑

- `auth.spec.ts`
- `chat.spec.ts`
- `admin.spec.ts`
- `admin-config.spec.ts`
- `admin-ops.spec.ts`
- `security.spec.ts`
- `user-extended.spec.ts`
- `user-supplemental.spec.ts`

### 人工确认

- 登录 / 退出
- 聊天发送 / 中断
- `route_upgraded`
- diagnostics runtime proof
- 后台修改设置后前台生效
- 工单附件授权访问
- 维护模式与管理员旁路

## 三、演练问题收口

只允许修复：

- 登录、聊天、后台、用户中心阻塞问题
- 回调、redirect、cookie、deployment protection、Auth 回跳错误
- 监控缺口或生产域名配置错误

不允许在这一轮继续扩功能。

## 四、Stripe 最后接入

进入条件：

- 非支付预发布演练全部通过
- 无未关闭的 P0/P1

最小必做项：

- 配置 `STRIPE_SECRET_KEY`
- 配置 `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`
- 配置 `STRIPE_WEBHOOK_SECRET`
- 为积分包 / 会员计划填写真实 `price_xxx`
- 验收 checkout 成功 / 取消 / 失败 / webhook 幂等 / 权益到账

## 五、正式生产发布

生产前最后核对：

- 生产域名
- `NEXT_PUBLIC_APP_URL`
- Supabase redirect URL
- Stripe webhook URL
- Sentry 告警入口
- 回滚路径
- 生产 smoke test

发布后确认：

- 首页 / 登录 / 聊天可访问
- 后台正常
- 支付链路正常
- Webhook 到账与状态一致

正式执行时，按这份 runbook 操作：

- [`runbooks/PRODUCTION_RELEASE.md`](./runbooks/PRODUCTION_RELEASE.md)
