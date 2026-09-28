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
| `RATE_LIMIT_FAIL_CLOSED` | 控制 Redis 不可用时的返回结果；Web helper / proxy 支持拒绝请求，但 API `checkRateLimitAsync` 的内存回退会绕过该失败结果，详见下文 |
| `NEXT_PUBLIC_HCAPTCHA_SITEKEY` | 前端 hCaptcha sitekey；`apps/web/src/lib/authCaptcha.ts` |
| `NEXT_PUBLIC_SITE_NAME`、`NEXT_PUBLIC_SUPPORT_EMAIL` | 站点显示与支持入口；`apps/web/src/lib/site-config.ts` |
| `NEXT_PUBLIC_APP_NAME` | OpenRouter 请求标题的回退名称；`packages/api/src/services/providerUtils.ts` |
| `NEXT_PUBLIC_SENTRY_DSN` | Sentry 错误上报；`apps/web/sentry.server.config.ts` 等 |
| `SENTRY_ENVIRONMENT`、`APP_ENV`、`NEXT_PUBLIC_APP_ENV` | Sentry 环境标签依次回退；`apps/web/sentry.server.config.ts`、`sentry.edge.config.ts`、`src/instrumentation-client.ts` |
| `LOG_LEVEL` | 服务端日志级别；`packages/api/src/lib/logger.ts` |
| `OPENROUTER_API_KEY` | 当前模型提供商密钥入口；`packages/api/src/services/providerUtils.ts` |
| `V3_RUNTIME_STAGING_ENABLED` | Runtime staging 入口开关之一；`packages/api/src/services/runtime/stagingEnvironment.ts`。设为 `true` 仍须通过项目、数据库和窗口校验；不代表生产配置或调用授权 |

限流实现没有读取 `KV_*`。Redis 缺失或不可用时，必须按调用路径判断：

- Web helper（`apps/web/src/lib/rateLimit.ts:150` 起）及 proxy（`apps/web/src/proxy.ts:264` 起）在 `RATE_LIMIT_FAIL_CLOSED=true` 时返回失败/拒绝；否则放行，不提供内存限流。
- API Redis helper（`packages/api/src/services/redisRateLimiter.ts:166` 起）按该变量返回成功或失败，但两者的 `limit` 均为 0。
- API `checkRateLimitAsync`（`packages/api/src/middleware/securityChecks.ts:147`–`:153`）先检查 `limit=0` 并回退到 `getRateLimiter()`，之后才检查 Redis 的成功状态。因此即使设置 `RATE_LIMIT_FAIL_CLOSED=true`，这些 API 路径仍可能使用进程内存限流；多个实例不共享限额。不能把这个变量描述为全站保证拒绝请求的开关。

本次只准确记录现状，不修改限流实现；后续限流行为变更须同步更新本表与 `.env.example`。

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
