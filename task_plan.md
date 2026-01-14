# Task Plan: GraylumAI Phase 3 迁移

## Goal
完成 GraylumAI 项目从阶段九到阶段十一的所有迁移工作，包括工单系统、系统设置、邀请推广、AI模型管理和管理后台。

## Current Phase
Bug 修复 - 401 认证错误

## Phases

### 阶段九：工单与系统设置迁移
- [x] 任务 9.1：迁移工单系统 API (创建 ticketRouter)
- [x] 任务 9.2：迁移系统设置 API (创建 settingsRouter)
- [x] 任务 9.3：创建工单页面 (tickets/page.tsx)
- [x] 任务 9.4：提交第九阶段成果 → 等待 Vercel 验证
- **Status:** completed (代码已完成，但存在 401 错误需要修复)

### 阶段十：邀请推广与模型管理迁移
- [x] 任务 10.1：迁移 AI 模型管理 API (创建 modelRouter)
- [x] 任务 10.2：迁移邀请推广 API (创建 invitationRouter)
- [x] 任务 10.3：创建 AI 模型管理页面 (models/page.tsx)
- [x] 任务 10.4：创建邀请码管理页面 (invitations/page.tsx)
- [x] 任务 10.5：提交第十阶段成果 → 等待 Vercel 验证
- **Status:** completed (代码已完成，但存在 401 错误需要修复)

### 阶段十一：管理后台与最终优化
- [ ] 任务 11.1：实现管理员角色权限控制 (adminProcedure)
- [ ] 任务 11.2：应用管理员权限到相关 API
- [ ] 任务 11.3：创建管理后台仪表盘 (admin/page.tsx)
- [ ] 任务 11.4：创建获取统计数据的 API (getStatistics)
- [ ] 任务 11.5：最终代码提交与部署准备 → 等待 Vercel 验证
- **Status:** pending (等待 401 错误修复后继续)

## 执行流程

每个阶段完成后：
1. 提交代码并推送到 `claude/install-plugin-wACm3` 分支
2. 等待用户确认 Vercel 部署是否有报错
3. 如有报错，优先解决报错
4. 用户确认无误后，继续下一阶段

## Decisions Made
| Decision | Rationale |
|----------|-----------|
| 按阶段分步执行 | 便于 Vercel 验证每步的正确性 |
| 每次推送后等待确认 | 确保部署无误再继续 |
| 使用 snake_case 字段名 | 匹配 Supabase 数据库表结构 |
| 使用单例模式的 Supabase 客户端 | 确保 session 正确获取 |

## Errors Encountered
| Error | Cause | Resolution | Status |
|-------|-------|------------|--------|
| 401 Unauthorized | tRPC 请求未携带认证头 | 修改 provider.tsx 添加 authorization header | 已修复 |
| 401 Unauthorized | 数据库字段名不匹配 (camelCase vs snake_case) | 更新所有 router 和前端页面使用 snake_case | 已修复 |
| 401 Unauthorized | 缺少 Supabase middleware | 添加 middleware.ts 刷新 session | 已修复 |
| 401 Unauthorized | Supabase 客户端每次创建新实例导致 session 丢失 | 使用单例模式 + useRef 保持客户端实例 | 已修复 |
| 401 Unauthorized | 服务端 getUser() 未正确接收 JWT token | 直接传递 token 给 getUser(token) | 无效 |
| 401 Unauthorized | 客户端 getSession() 返回 null，header 认证失效 | 改用 cookie-based 认证，服务端用 createServerClient 读取 cookies | 待验证 |
| ERR_PNPM_OUTDATED_LOCKFILE | 添加依赖后未更新 pnpm-lock.yaml | 运行 pnpm install 更新 lockfile | 已修复 |
| Cannot find module 'next/dist/...' | api 包导入 Next.js 内部类型但没有 next 依赖 | 使用通用 CookieStore 接口替代 | 已修复 |
