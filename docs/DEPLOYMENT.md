# 部署指南

> 部署由 **Vercel Git Integration** 自动处理，推送代码即自动部署。

## 环境概览

| 环境 | 触发条件 | URL |
|------|----------|-----|
| **Production** | 推送到 `main` | 你的 Vercel 域名 |
| **Preview** | 任何 PR 或其他分支 | 自动生成 |

---

## Vercel 环境变量配置

在 Vercel Dashboard 配置（不是 GitHub Secrets）：

```
Vercel Dashboard → Project → Settings → Environment Variables
```

### 必需变量

| 变量名 | 说明 |
|--------|------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase 项目 URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase 匿名 Key |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase 服务端 Key |
| `ANTHROPIC_API_KEY` | Claude API Key |

### 可选变量

| 变量名 | 说明 |
|--------|------|
| `NEXT_PUBLIC_SENTRY_DSN` | Sentry 错误监控 |
| `DATABASE_URL` | 直连数据库（Drizzle 迁移用） |

---

## 部署流程

### 日常开发

```bash
# 1. 创建功能分支
git checkout -b feature/xxx

# 2. 开发并提交
git commit -m "feat: xxx"

# 3. 推送并创建 PR
git push origin feature/xxx
# Vercel 自动创建 Preview 部署

# 4. PR 合并到 main 后自动部署到生产
```

### 发布检查清单

部署前确认：
- [ ] 本地测试通过
- [ ] PR 的 CI 检查通过
- [ ] Preview 环境功能验证

部署后验证：
- [ ] 网站可访问
- [ ] 登录/AI 对话正常
- [ ] 管理后台可访问

---

## 回滚

### 方法 1: Vercel Dashboard（推荐）

1. 打开 Vercel Dashboard → Deployments
2. 找到上一个稳定版本
3. 点击 `...` → `Promote to Production`

### 方法 2: Git Revert

```bash
git revert HEAD
git push origin main
# 自动触发重新部署
```

---

## 常见问题

**Q: 部署失败？**
→ 检查 Vercel Dashboard 的构建日志

**Q: 环境变量不生效？**
→ 确认在 Vercel Dashboard 配置，不是 GitHub Secrets

**Q: 如何手动触发部署？**
→ Vercel Dashboard → Deployments → Redeploy
