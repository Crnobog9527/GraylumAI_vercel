# 部署指南

## 环境概览

| 环境 | 分支 | URL | 用途 |
|------|------|-----|------|
| **Production** | `main` | https://app.graylum.ai | 生产环境 |
| **Staging** | `develop` | https://staging.graylum.ai | 测试环境 |
| **Preview** | PR 分支 | 自动生成 | PR 预览 |

---

## GitHub Secrets 配置

在 GitHub 仓库设置中配置以下 Secrets：

```
Settings → Secrets and variables → Actions → New repository secret
```

### 必需的 Secrets

| Secret 名称 | 说明 | 获取方式 |
|-------------|------|----------|
| `VERCEL_TOKEN` | Vercel API Token | Vercel Dashboard → Settings → Tokens |
| `VERCEL_ORG_ID` | Vercel Organization ID | `.vercel/project.json` 或 Dashboard |
| `VERCEL_PROJECT_ID` | Vercel Project ID | `.vercel/project.json` 或 Dashboard |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase URL | Supabase Dashboard → Settings → API |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase Anon Key | Supabase Dashboard → Settings → API |

### 可选的 Secrets

| Secret 名称 | 说明 |
|-------------|------|
| `SENTRY_AUTH_TOKEN` | Sentry 上传 Source Maps |
| `SENTRY_ORG` | Sentry Organization |
| `SENTRY_PROJECT` | Sentry Project |

---

## 部署流程

### 1. 部署到 Staging

```bash
# 1. 确保在 develop 分支
git checkout develop

# 2. 合并功能分支
git merge feature/your-feature

# 3. 推送触发自动部署
git push origin develop

# 4. 检查 GitHub Actions 状态
# https://github.com/your-org/GraylumAI_vercel/actions
```

### 2. 部署到 Production

```bash
# 1. 确保 staging 测试通过
# 访问 https://staging.graylum.ai 验证

# 2. 创建 PR: develop → main
gh pr create --base main --head develop --title "Release: v1.x.x"

# 3. 等待所有 CI 检查通过

# 4. 合并 PR (需要审批)

# 5. 自动部署到生产
# 监控 GitHub Actions 状态
```

---

## 部署检查清单

### Staging 部署前

- [ ] 本地测试通过 (`pnpm test:api`)
- [ ] 本地构建成功 (`pnpm build`)
- [ ] 代码已提交并推送
- [ ] PR 已合并到 develop

### Production 部署前

- [ ] Staging 环境测试通过
- [ ] 所有关键功能手动验证
- [ ] 数据库迁移已执行 (如有)
- [ ] 团队成员已知晓部署计划
- [ ] PR 已创建: develop → main
- [ ] CI 检查全部通过

### 部署后验证

- [ ] 网站可访问
- [ ] 登录功能正常
- [ ] AI 对话功能正常
- [ ] 积分系统正常
- [ ] 管理后台可访问
- [ ] Sentry 无新增错误
- [ ] 监控仪表板数据正常

---

## 回滚流程

### 方法 1: Vercel 回滚 (推荐)

```bash
# 1. 访问 Vercel Dashboard
# https://vercel.com/your-org/graylum-ai/deployments

# 2. 找到上一个稳定版本的部署

# 3. 点击 "..." → "Promote to Production"

# 4. 确认回滚
```

### 方法 2: Git 回滚

```bash
# 1. 查看提交历史
git log --oneline -10

# 2. 回滚到指定版本
git revert HEAD  # 回滚最近一次提交
# 或
git revert <commit-hash>  # 回滚指定提交

# 3. 推送触发重新部署
git push origin main
```

### 方法 3: 紧急回滚脚本

```bash
#!/bin/bash
# scripts/emergency-rollback.sh

# 获取上一个部署
PREVIOUS_DEPLOYMENT=$(vercel ls --prod | head -2 | tail -1 | awk '{print $1}')

# 回滚
vercel promote $PREVIOUS_DEPLOYMENT --yes

echo "Rolled back to: $PREVIOUS_DEPLOYMENT"
```

---

## 环境变量管理

### Vercel 环境变量

```bash
# 查看当前环境变量
vercel env ls

# 添加环境变量
vercel env add VARIABLE_NAME production

# 删除环境变量
vercel env rm VARIABLE_NAME production
```

### 环境区分

在代码中区分环境：

```typescript
// 获取当前环境
const environment = process.env.VERCEL_ENV || 'development';
// 可能的值: 'production' | 'preview' | 'development'

// 条件配置
const config = {
  apiUrl: environment === 'production'
    ? 'https://api.graylum.ai'
    : 'https://staging-api.graylum.ai',
};
```

---

## 常见问题

### Q: 部署失败怎么办？

1. 检查 GitHub Actions 日志
2. 检查 Vercel 部署日志
3. 确认环境变量正确配置
4. 确认 Secrets 未过期

### Q: 如何查看部署状态？

- GitHub Actions: `https://github.com/your-org/repo/actions`
- Vercel Dashboard: `https://vercel.com/your-org/project`

### Q: 如何手动触发部署？

```bash
# 方法 1: 空提交
git commit --allow-empty -m "chore: trigger deploy"
git push

# 方法 2: Vercel CLI
vercel --prod
```

---

## 联系方式

部署问题请联系：
- GitHub Issues: https://github.com/your-org/GraylumAI_vercel/issues
- 技术负责人: [your-email]
