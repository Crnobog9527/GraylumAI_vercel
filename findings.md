# Findings & Decisions

## Requirements
- 完成 GraylumAI Phase 3 迁移（阶段九至十一）
- 阶段九：工单系统与系统设置迁移
- 阶段十：邀请推广与模型管理迁移
- 阶段十一：管理后台与最终优化

## Research Findings

### Supabase 认证机制
1. **客户端认证**：使用 `@supabase/ssr` 的 `createBrowserClient` 创建客户端，session 存储在 cookies
2. **服务端认证**：需要从 Authorization header 提取 JWT token，使用 `getUser(token)` 验证
3. **Service Role Key**：服务端操作建议使用 `SUPABASE_SERVICE_ROLE_KEY` 绕过 RLS

### tRPC 认证流程
1. 客户端在 `httpBatchLink` 的 `headers()` 中添加 `Authorization: Bearer ${token}`
2. 服务端在 `createTRPCContext` 中解析 header 并验证 token
3. `protectedProcedure` 检查 `ctx.user` 是否存在

### 数据库字段命名
- Supabase 数据库使用 **snake_case** 命名（如 `user_id`, `created_at`）
- 前端和 API 代码需要匹配数据库字段名

### Cookie 存储问题 (关键发现)
- **问题**：浏览器中完全没有 Supabase auth token cookie
- **原因**：
  1. 单例模式干扰了 `createBrowserClient` 的 cookie 存储机制
  2. 缺少 `persistSession: true` 和 `storageKey` 配置
- **解决方案**：
  1. 移除单例模式，每次调用 `createClient()` 都创建新实例
  2. 添加 `auth: { persistSession: true, storageKey: 'sb-auth-token' }` 配置
  3. middleware.ts 中的 `getUser()` 调用会刷新 session 并同步 cookie

### tRPC 请求未携带身份令牌 (最新发现)
- **问题**：401 错误因为 tRPC 请求没有携带 Supabase 的身份令牌
- **原因**：
  1. `useRef` 存储 token 有时机问题，首次请求时 token 可能还未初始化
  2. 后端只从 Authorization header 提取身份，没有 cookie 回退机制
- **解决方案**：
  1. 前端 `headers()` 使用 async/await 直接调用 `getSession()` 获取最新 token
  2. 后端 `createTRPCContext` 同时支持从 headers 和 cookies 提取用户身份
  3. API route 传递 cookies 给 tRPC context

## Technical Decisions
| Decision | Rationale |
|----------|-----------|
| 使用 Authorization header 认证 | 唯一认证方式，每次请求获取最新 token |
| `persistSession: true` | 确保 session 正确持久化到存储 |
| `storageKey: 'sb-auth-token'` | 明确指定存储 key |
| 使用 service role key | 服务端操作需要绕过 RLS |
| **不使用**单例模式的 Supabase 客户端 | 单例模式会干扰 cookie 存储机制 |
| 字段名使用 snake_case | 匹配 Supabase 数据库表结构 |
| api 包不依赖 @supabase/ssr | 避免 Vercel 构建时模块解析问题 |

## Issues Encountered
| Issue | Cause | Resolution | Status |
|-------|-------|------------|--------|
| 401 Unauthorized | tRPC 请求未携带认证头 | 在 provider.tsx 添加 Authorization header | ✅ 已修复 |
| 401 Unauthorized | 数据库字段名不匹配 (camelCase vs snake_case) | 更新所有 router 和前端页面使用 snake_case | ✅ 已修复 |
| 401 Unauthorized | 缺少 Supabase middleware | 添加 middleware.ts 刷新 session | ✅ 已修复 |
| 401 Unauthorized | Supabase 客户端每次创建新实例导致 session 丢失 | 使用单例模式 + useRef 保持客户端实例 | ✅ 已修复 |
| 401 Unauthorized | 服务端 getUser() 未正确接收 JWT token | 直接传递 token 给 getUser(token) | ❌ 无效 |
| 401 Unauthorized | 客户端 getSession() 返回 null | 改用 cookie-based 认证 | ❌ 无效 |
| ERR_PNPM_OUTDATED_LOCKFILE | 添加依赖后未更新 pnpm-lock.yaml | 运行 pnpm install 更新 lockfile | ✅ 已修复 |
| Cannot find module 'next/dist/...' | api 包导入 Next.js 内部类型但没有 next 依赖 | 使用通用 CookieStore 接口替代 | ✅ 已修复 |
| 401 Unauthorized | cookie-based 认证无效 | 恢复 Authorization header + service role key | ⏳ 待验证 |
| 401 Unauthorized | getSession() 时机问题 | 使用 useRef 存储 token + onAuthStateChange 更新 | ⏳ 待验证 |
| 无 Supabase cookie | 单例模式干扰 createBrowserClient 的 cookie 存储 | 移除单例模式，每次创建新客户端实例 | ⏳ 待验证 |
| tRPC 请求无身份令牌 | useRef 时机问题 + 后端无 cookie 回退 | async getSession() + 后端双重提取 (header + cookie) | ⏳ 待验证 |
| Can't resolve '@supabase/ssr' | api 包中 @supabase/ssr 在 Vercel 构建时无法解析 | 移除 cookie 回退，只使用 Authorization header | ✅ 已修复 |
| 500 Internal Server Error (tickets) | 外键引用 `profiles.id` 而非 `auth.users.id` | 在 protectedProcedure 中获取/创建 profile，使用 ctx.profileId | ✅ 已修复 |
| 500 Internal Server Error (invitations) | 外键引用 `profiles.id` 而非 `auth.users.id` | 使用 ctx.profileId 代替 ctx.user.id | ✅ 已修复 |

## 500 错误全局分析 (2024-01-14) - 已修复

### 现象
- ✅ 登录页面：正常工作，无控制台错误
- ✅ 模型页面 (`/models`)：正常工作，可以读写 `ai_models` 表
- ❌ 工单页面 (`/tickets`)：500 Internal Server Error
- ❌ 邀请码页面 (`/invitations`)：500 Internal Server Error

### 根本原因分析（已更正）

**初始假设（错误）**：表不存在

**实际原因**：外键约束不匹配

| 表 | 字段 | 数据库外键引用 | 代码使用的值 |
|---|------|---------------|-------------|
| tickets | `user_id` | `public.profiles.id` | `ctx.user.id` (auth.users.id) |
| ticket_replies | `user_id` | `public.profiles.id` | `ctx.user.id` (auth.users.id) |
| invitations | `created_by` | `public.profiles.id` | `ctx.user.id` (auth.users.id) |

**核心问题**：数据库表的外键引用 `profiles.id`，而代码使用的是 `auth.users.id`。当用户在 `profiles` 表中没有对应记录时，INSERT 操作会因外键约束失败而返回 500 错误。

### 解决方案

在 `protectedProcedure` 中间件中自动获取或创建用户的 profile：

```typescript
// packages/api/src/trpc.ts
export const protectedProcedure = t.procedure.use(async ({ ctx, next }) => {
  // ... auth check ...

  // Get or create user profile
  const { data: profile } = await ctx.supabase
    .from('profiles')
    .select('id')
    .eq('id', ctx.user.id)
    .single();

  if (!profile) {
    // Create profile if not exists
    const { data: newProfile } = await ctx.supabase
      .from('profiles')
      .insert({ id: ctx.user.id, email: ctx.user.email })
      .select('id')
      .single();
    profileId = newProfile.id;
  }

  return next({ ctx: { ...ctx, profileId } });
});
```

然后在 routers 中使用 `ctx.profileId` 代替 `ctx.user.id`：

```typescript
// Before (错误)
.insert({ user_id: ctx.user.id, ... })

// After (正确)
.insert({ user_id: ctx.profileId, ... })
```

### 修改的文件
- `packages/api/src/trpc.ts` - 添加 profile 获取/创建逻辑
- `packages/api/src/routers/ticket.ts` - 使用 ctx.profileId
- `packages/api/src/routers/invitation.ts` - 使用 ctx.profileId

## Key Files Modified

### 认证相关
| File | Changes |
|------|---------|
| apps/web/src/trpc/provider.tsx | async headers() 直接调用 getSession() 获取 token |
| apps/web/src/lib/supabase.ts | 添加 persistSession + storageKey 配置 |
| apps/web/src/app/api/trpc/[trpc]/route.ts | 简化为只传递 headers |
| apps/web/middleware.ts | Supabase session 刷新中间件 (getUser 同步 cookie) |
| packages/api/src/trpc.ts | 只从 Authorization header 提取 token |

### 迁移相关
| File | Changes |
|------|---------|
| packages/api/src/routers/ticket.ts | 工单系统 API |
| packages/api/src/routers/settings.ts | 系统设置 API |
| packages/api/src/routers/model.ts | AI 模型管理 API |
| packages/api/src/routers/invitation.ts | 邀请码管理 API |
| apps/web/src/app/tickets/page.tsx | 工单页面 |
| apps/web/src/app/models/page.tsx | 模型管理页面 |
| apps/web/src/app/invitations/page.tsx | 邀请码页面 |

## Resources
- [Supabase SSR Auth Guide](https://supabase.com/docs/guides/auth/server-side)
- [tRPC React Query Setup](https://trpc.io/docs/client/react)
- [Next.js App Router](https://nextjs.org/docs/app)

## Environment Variables Required
```
NEXT_PUBLIC_SUPABASE_URL=<your-supabase-url>
NEXT_PUBLIC_SUPABASE_ANON_KEY=<your-anon-key>
SUPABASE_SERVICE_ROLE_KEY=<your-service-role-key>  # Important for server-side auth
```
