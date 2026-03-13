# 部署指南

## 当前发布顺序

1. 先完成非支付发布准备
2. 在锁定的 Vercel preview / staging 环境做完整预发布演练
3. 关闭演练中发现的最后非支付问题
4. 最后接入并验收 Stripe
5. 再做正式生产发布

相关文档：

- [RELEASE_PREP_CHECKLIST.md](/Volumes/灰度映画/灰度映画/美国怀俄明州-Grayscale%20Luminary%20LLC/Graylum_AI/GraylumAI_vercel/docs/RELEASE_PREP_CHECKLIST.md)
- [PRE_RELEASE_REHEARSAL.md](/Volumes/灰度映画/灰度映画/美国怀俄明州-Grayscale%20Luminary%20LLC/Graylum_AI/GraylumAI_vercel/docs/runbooks/PRE_RELEASE_REHEARSAL.md)
- [STRIPE_ENABLEMENT_CHECKLIST.md](/Volumes/灰度映画/灰度映画/美国怀俄明州-Grayscale%20Luminary%20LLC/Graylum_AI/GraylumAI_vercel/docs/STRIPE_ENABLEMENT_CHECKLIST.md)

## 环境概览

| 环境 | 作用 | 说明 |
|------|------|------|
| `Preview / Staging` | 预发布演练 | 锁定单个部署版本，不允许中途切换 |
| `Production` | 正式上线 | 只在 preview 演练通过且 Stripe 验收通过后发布 |

## 关键环境变量

### 非支付发布准备

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `NEXT_PUBLIC_APP_URL`
- `NEXT_PUBLIC_SITE_NAME`
- `NEXT_PUBLIC_SUPPORT_EMAIL`
- `NEXT_PUBLIC_SENTRY_DSN`
- AI provider keys

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

### Vercel Dashboard（推荐）

1. 打开 `Deployments`
2. 找到上一个稳定版本
3. `Promote to Production`

### Git 回滚

```bash
git revert HEAD
git push origin main
```

## accepted risk

- Supabase 免费套餐无法启用 `Leaked Password Protection`
- 当前将其记录为平台级 accepted risk，不阻塞非支付上线准备
