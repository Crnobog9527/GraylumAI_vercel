# 部署指南

## 发布依据

执行边界以 [AGENTS.md](../AGENTS.md) 为准；产品任务从 [Launch 入口](launch/START_HERE.md) 查阅。历史发布检查表提供测试场景，不代表当前版本已签核或获得生产授权。

- [发布检查表](RELEASE_PREP_CHECKLIST.md)
- [预发布演练](runbooks/PRE_RELEASE_REHEARSAL.md)
- [Stripe 验收](STRIPE_ENABLEMENT_CHECKLIST.md)
- [后台设置与模块删除运维](runbooks/ADMIN_OPERATIONS.md)

## 环境概览

| 环境 | 作用 | 说明 |
|------|------|------|
| `Preview / Staging` | 预发布演练 | 锁定单个部署版本，不允许中途切换 |
| `Production` | 正式上线 | 完成本次候选适用的验收并取得独立生产授权后发布 |

独立 Vercel 项目 `graylumai-staging` 使用 Vercel 的 `Production` 环境服务 staging 分支，域名为 `graylumai-staging.vercel.app`。平台环境标签不等于主站生产；操作前同时核对项目、分支和域名。

## 关键环境变量

### 非支付发布准备

值和注释占位见 [`.env.example`](../.env.example)。新增示例不代表已配置目标环境，
也不授权修改密钥、外部配置或开启真实调用。仅报告变量是否存在，不公开值。

| 变量 | 当前用途与读取位置 |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL`、`NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase 客户端连接；`apps/web/src/lib/supabase.ts` |
| `SUPABASE_SERVICE_ROLE_KEY` | 服务端 Supabase 客户端；`packages/api/src/trpc.ts` |
| `NEXT_PUBLIC_APP_URL`、`NEXT_PUBLIC_AUTH_APP_URL` | 站点与认证回跳地址；`apps/web/src/lib/site-config.ts` |
| `UPSTASH_REDIS_REST_URL`、`UPSTASH_REDIS_REST_TOKEN` | Redis 分布式限流；`packages/api/src/services/redisRateLimiter.ts`、`apps/web/src/proxy.ts` |
| `RATE_LIMIT_FAIL_CLOSED` | 已退役，不再控制行为；设为 false 或不配置均不能关闭故障拒绝 |
| `NEXT_PUBLIC_HCAPTCHA_SITEKEY` | 前端 hCaptcha sitekey；`apps/web/src/lib/authCaptcha.ts` |
| `NEXT_PUBLIC_SITE_NAME`、`NEXT_PUBLIC_SUPPORT_EMAIL` | 站点显示与支持入口；`apps/web/src/lib/site-config.ts` |
| `NEXT_PUBLIC_APP_NAME` | OpenRouter 请求标题的回退名称；`packages/api/src/services/providerUtils.ts` |
| `NEXT_PUBLIC_SENTRY_DSN` | Sentry 错误上报；`apps/web/sentry.server.config.ts` 等 |
| `SENTRY_ENVIRONMENT`、`APP_ENV`、`NEXT_PUBLIC_APP_ENV` | Sentry 环境标签依次回退；`apps/web/sentry.server.config.ts`、`sentry.edge.config.ts`、`src/instrumentation-client.ts` |
| `LOG_LEVEL` | 服务端日志级别；`packages/api/src/lib/logger.ts` |
| `OPENROUTER_API_KEY` | 当前模型提供商密钥入口；`packages/api/src/services/providerUtils.ts` |
| `V3_RUNTIME_STAGING_ENABLED` | Runtime staging 入口开关之一；`packages/api/src/services/runtime/stagingEnvironment.ts`。设为 `true` 仍须通过项目、数据库和窗口校验；不代表生产配置或调用授权 |

限流实现没有读取 `KV_*`。`UPSTASH_REDIS_REST_URL` 和 `UPSTASH_REDIS_REST_TOKEN` 必须配对配置：

- 所有环境（本机、测试、Preview、staging、生产）的 API/Web/IP 限流均默认 fail-closed：缺配置、Redis 报错或超过 500ms 截止时，返回 503、繁忙提示与 `retryAfter=60`；HTTP 入口同时返回 `Retry-After`。超限返回 429 和窗口重试时间。
- 不再有 Redis 故障后的进程内存回退；`RATE_LIMIT_FAIL_CLOSED` 已失效，不能用它放行请求。Redis 故障期间用户请求会被拒绝，这是规划选定的取舍。
- `apps/web/next.config.ts` 在 Vercel 构建阶段复用 `envValidator.ts` 的 Redis 字段规则；缺任一项或格式无效即抛错停止构建，日志只列字段名。`turbo.json` 将 Redis 和 Vercel 环境标识传入构建并纳入缓存键，避免变量变化后复用旧的成功构建。
- 构建前校验不联网，不证明 Redis 凭据有效或网络可达。发布前还应确认变量属于实际部署环境，并另行安排获准的健康准入验证；不能用离线测试替代真实环境证据。
- 本机及不带 Vercel 部署标识的 secretless CI 可以离线构建；这不是请求放行开关。运行时没有 Redis 仍拒绝请求，离线单元测试须显式模拟 Redis，本机真实使用须配置独立开发 Redis。

### 保留但未生效的示例变量

| 变量 | 状态与依据 |
| --- | --- |
| `RATE_LIMIT_AI_MAX_REQUESTS`、`RATE_LIMIT_AI_STREAM_MAX_REQUESTS` | 目前代码没有读取或没有生效：仅在 `envValidator.ts` 声明；`redisRateLimiter.ts` 使用固定限额 |
| `CIRCUIT_BREAKER_HOURLY_LIMIT`、`CIRCUIT_BREAKER_DAILY_LIMIT` | 目前代码没有读取或没有生效：仅在 `envValidator.ts` 声明；`middleware/securityChecks.ts` 使用固定阈值 |
| `REQUIRE_API_SIGNATURE`、`API_SIGNATURE_SECRET` | 辅助函数读取，但 `checkRequestSignature` 未接入生产请求路径；仅配置变量不会启用签名校验 |

### Stripe 阶段

- `STRIPE_SECRET_KEY`
- `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`
- `STRIPE_WEBHOOK_SECRET`

### 外部配置

- Supabase Auth redirect URLs
- `verify-email` 回跳地址
- Vercel preview / production base URL
- Deployment Protection bypass cookie
- Stripe Checkout return URLs
- Stripe webhook endpoint

> Anthropic 官方 API 已退役。Preview / Production 不应再配置 `ANTHROPIC_API_KEY`；如历史环境仍存在旧 key，先核对依赖，再按 AGENTS.md 取得凭据变更授权后撤销。

## 推荐命令

### 本地发布前基线

```bash
pnpm release:preflight
```

### Preview / staging 预发布演练

```bash
pnpm release:preflight:preview -- --preview-url <preview-url> --bypass-cookie <cookie>
```

### 隔离 destructive 演练

```bash
pnpm release:preflight:destructive -- --preview-url <preview-url> --bypass-cookie <cookie>
```

## 回滚

先核对故障部署与拟恢复版本。Vercel 的部署提升/回滚属于外部变更，须按 [AGENTS.md](../AGENTS.md) 取得对应环境和操作的授权；生产操作不能沿用 staging 合并批准。

代码回滚在独立任务分支生成 revert 提交，通过 PR、验证和审查后由 Owner 批准合并。不得直接推送 `staging` 或 `main`。部署回滚不自动撤销数据库迁移；数据库恢复需单独评估兼容性、数据影响及授权。

## 历史风险记录

- Supabase 免费套餐无法启用 `Leaked Password Protection`
- 上述免费套餐限制是历史记录；发布前核对目标项目现状和本次适用的风险接受结论
