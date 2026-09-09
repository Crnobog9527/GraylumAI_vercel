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

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `NEXT_PUBLIC_APP_URL`
- `NEXT_PUBLIC_SITE_NAME`
- `NEXT_PUBLIC_SUPPORT_EMAIL`
- `NEXT_PUBLIC_SENTRY_DSN`
- `OPENROUTER_API_KEY`（Claude 与 OpenAI-compatible 模型统一入口）

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
