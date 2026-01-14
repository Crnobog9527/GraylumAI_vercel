# Task Plan: GraylumAI Phase 3 迁移

## Goal
完成 GraylumAI 项目从阶段九到阶段十一的所有迁移工作，包括工单系统、系统设置、邀请推广、AI模型管理和管理后台。

## Current Phase
阶段十一待开始 - 管理后台与最终优化

## Phases

### 阶段九：工单与系统设置迁移 ✅ 已完成
- [x] 任务 9.1：迁移工单系统 API (创建 ticketRouter)
- [x] 任务 9.2：迁移系统设置 API (创建 settingsRouter)
- [x] 任务 9.3：创建工单页面 (tickets/page.tsx)
- [x] 任务 9.4：提交第九阶段成果
- **Status:** ✅ 已完成并验证通过
- **验证结果:** tickets 页面正常访问，数据可写入数据库

### 阶段十：邀请推广与模型管理迁移 ✅ 已完成
- [x] 任务 10.1：迁移 AI 模型管理 API (创建 modelRouter)
- [x] 任务 10.2：迁移邀请推广 API (创建 invitationRouter)
- [x] 任务 10.3：创建 AI 模型管理页面 (models/page.tsx)
- [x] 任务 10.4：创建邀请码管理页面 (invitations/page.tsx)
- [x] 任务 10.5：提交第十阶段成果
- **Status:** ✅ 已完成并验证通过
- **验证结果:** models 和 invitations 页面正常访问，数据可写入数据库

### 阶段十一：管理后台与最终优化 ⏳ 待开始
- [ ] 任务 11.1：实现管理员角色权限控制 (adminProcedure)
- [ ] 任务 11.2：应用管理员权限到相关 API
- [ ] 任务 11.3：创建管理后台仪表盘 (admin/page.tsx)
- [ ] 任务 11.4：创建获取统计数据的 API (getStatistics)
- [ ] 任务 11.5：最终代码提交与部署准备 → 等待 Vercel 验证
- **Status:** pending

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
| 401 Unauthorized | 客户端 getSession() 返回 null，header 认证失效 | 改用 cookie-based 认证，服务端用 createServerClient 读取 cookies | 无效 |
| ERR_PNPM_OUTDATED_LOCKFILE | 添加依赖后未更新 pnpm-lock.yaml | 运行 pnpm install 更新 lockfile | 已修复 |
| Cannot find module 'next/dist/...' | api 包导入 Next.js 内部类型但没有 next 依赖 | 使用通用 CookieStore 接口替代 | 已修复 |
| 401 Unauthorized | cookie-based 认证无效，需要 Authorization header + service role key | 恢复 Authorization header，使用 getUser(token) 验证，使用 service role key | 已修复 |
| 401 Unauthorized | getSession() 时机问题，headers() 调用时 session 可能未初始化 | async getSession() 直接在 headers() 中调用 + persistSession 配置 | 已修复 |
| Can't resolve '@supabase/ssr' | api 包中 @supabase/ssr 在 Vercel 构建时无法解析 | 移除 cookie 回退，只使用 Authorization header | 已修复 |
| 500 Internal Server Error (tickets) | 外键引用 `profiles.id` 而非 `auth.users.id`，INSERT 时外键约束失败 | 在 protectedProcedure 中获取 profile，使用 ctx.profileId | 已修复 |
| 500 Internal Server Error (invitations) | 外键引用 `profiles.id` 而非 `auth.users.id`，INSERT 时外键约束失败 | 使用 ctx.profileId 代替 ctx.user.id | 已修复 |
| 500 全局错误 (所有页面) | protectedProcedure 自动创建 profile 失败，profiles 表有额外必填字段 | 移除自动创建逻辑，只查询 profile | 已修复 |
| 500 (profiles 缺少 email) | profiles 表缺少 email 字段导致 profile 创建失败 | 在 Supabase 添加 email 列 + 更新 Drizzle schema | 已修复 |
| Drizzle db:push 删除 email 列 | 数据库手动添加 email 列后，Drizzle schema 未同步更新 | 在 schema.ts 中添加 email 字段定义 | 已修复 |
