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
| 500 Internal Server Error (tickets) | 外键引用 `profiles.id` 而非 `auth.users.id` | 在 protectedProcedure 中获取 profile，使用 ctx.profileId | ⏳ 待验证 |
| 500 Internal Server Error (invitations) | 外键引用 `profiles.id` 而非 `auth.users.id` | 使用 ctx.profileId 代替 ctx.user.id | ⏳ 待验证 |
| 500 全局错误 (所有页面) | 自动创建 profile 失败 (profiles 表有额外必填字段) | 移除自动创建逻辑，只查询 profile | ✅ 已修复 |
| 500 全局错误 (最终修复) | profiles 表需要添加 email 字段 + 所有 router 统一使用 profileId | 自动创建 profile(id+email) + 统一所有 router 使用 ctx.profileId | ✅ 已修复 |
| Drizzle db:push 删除 email 列 | 数据库手动添加 email 列后，Drizzle schema 未同步更新 | 在 schema.ts 中添加 email 字段定义 | ✅ 已修复 |

## 500 错误全局分析 (2026-01-14)

### 第一次分析（tickets/invitations 页面 500 错误）

**现象**：
- ✅ 登录页面：正常工作
- ✅ 模型页面 (`/models`)：正常工作
- ❌ 工单页面 (`/tickets`)：500 Internal Server Error
- ❌ 邀请码页面 (`/invitations`)：500 Internal Server Error

**原因**：外键引用 `profiles.id` 而非 `auth.users.id`

**解决方案**：使用 `ctx.profileId` 代替 `ctx.user.id`

### 第二次问题（全局 500 错误）⚠️

**现象**：
- ❌ 所有页面都报 500 Internal Server Error
- ❌ chat.getConversations, model.updateModelConfig, ticket.*, invitation.* 全部失败

**原因**：在 protectedProcedure 中尝试自动创建 profile 失败
```typescript
// 问题代码：profiles 表可能有其他必填字段，导致插入失败
const { data: newProfile, error: createError } = await ctx.supabase
  .from('profiles')
  .insert({
    id: ctx.user.id,
    email: ctx.user.email,  // 可能缺少其他必填字段
  })
```

**修复方案**：移除自动创建逻辑，只查询 profile
```typescript
// 修复后：不创建，只查询
const { data: profile } = await ctx.supabase
  .from('profiles')
  .select('id')
  .eq('id', ctx.user.id)
  .single();

if (profile) {
  profileId = profile.id;
}
// 如果没有 profile，直接使用 ctx.user.id
```

### 修改的文件
- `packages/api/src/trpc.ts` - 移除自动创建 profile 逻辑
- `packages/api/src/routers/ticket.ts` - 使用 ctx.profileId
- `packages/api/src/routers/invitation.ts` - 使用 ctx.profileId

### 第三次分析（综合全局分析）✅ 已解决

**现象**：
- ✅ 登录页面：正常工作
- ✅ 模型页面 (`/models`)：正常工作（使用 publicProcedure）
- ❌ 工单页面 (`/tickets`)：500 Internal Server Error
- ❌ 邀请码页面 (`/invitations`)：500 Internal Server Error
- ✅ Profile 自动创建：据报告成功

**全局对比分析**：

| 页面 | API 端点 | Procedure 类型 | 使用 ctx.profileId | 状态 |
|------|---------|---------------|-------------------|------|
| Models | `getAvailableModels` | **publicProcedure** | ❌ 不使用 | ✅ 正常 |
| Tickets | `getTickets` | protectedProcedure | ✅ 查询过滤 | ❌ 500 |
| Invitations | `getInvitationHistory` | protectedProcedure | ❌ 不过滤 | ❌ 500 |

**根本原因**：
1. `profiles` 表结构：`id, credits, created_at, nickname, avatar_url` - **缺少 email 字段**
2. `protectedProcedure` 自动创建 profile 时尝试插入 `email` 字段
3. INSERT 失败（列不存在），错误只是 `console.error` 记录
4. `profileId` 保持为 `ctx.user.id`（auth.users.id）
5. 后续操作涉及 FK 约束（引用 profiles.id）时失败

**为什么 Models 页面能工作**：
- `getAvailableModels` 使用 `publicProcedure`，完全不经过 `protectedProcedure` 中间件
- 不需要认证，不涉及 profile 创建/查询逻辑

**解决方案**：
在 Supabase 数据库中添加 email 字段：
```sql
ALTER TABLE profiles ADD COLUMN email TEXT;
```

**验证状态**：✅ 用户已在数据库添加 email 字段

## Drizzle Schema 同步问题 ⚠️ 重要经验

### 问题描述
运行 `pnpm db:push` 时，drizzle-kit 警告要删除 `email` 列：
```
Warning: Found data-loss statements:
· You're about to delete email column in profiles table with 1 items
THIS ACTION WILL CAUSE DATA LOSS AND CANNOT BE REVERTED
```

### 根本原因
- 用户在 Supabase 控制台手动添加了 `email` 列
- 但 Drizzle schema 文件 (`packages/db/schema.ts`) 中没有对应字段
- `db:push` 试图让数据库与 schema 文件同步，所以想删除"多余"的列

### 解决方案
在 `packages/db/schema.ts` 中添加 email 字段：
```typescript
export const profiles = pgTable('profiles', {
  id: uuid('id').primaryKey(),
  email: text('email'), // 添加此字段
  nickname: text('nickname'),
  // ...
});
```

### 教训与检查清单 ⚠️
**修改数据库结构时必须同步更新两处：**
1. ✅ Supabase 数据库（手动或 SQL）
2. ✅ Drizzle schema 文件 (`packages/db/schema.ts`)

**未来检查清单：**
- [ ] 添加新列 → 更新 schema.ts
- [ ] 删除列 → 更新 schema.ts
- [ ] 修改列类型 → 更新 schema.ts
- [ ] 添加外键 → 更新 schema.ts 的 references()
- [ ] 运行 db:push 前检查警告信息

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

## 管理员页面访问控制不一致问题 ⚠️ 重要经验

### 问题描述
普通用户可以访问 `/models` 和 `/invitations` 页面，但无法提交操作。
期望行为应该是像 `/admin` 页面一样，完全禁止普通用户访问。

### 验证结果（修复前）
| 页面 | 管理员访问 | 普通用户访问 | 普通用户操作 |
|------|-----------|-------------|-------------|
| `/admin` | ✅ 正常 | ❌ 显示 Access Denied | N/A |
| `/models` | ✅ 正常 | ✅ 可访问 ❌ | ❌ 无法提交 |
| `/invitations` | ✅ 正常 | ✅ 可访问 ❌ | ❌ 无法提交 |

### 验证结果（修复后）✅
| 页面 | 管理员访问 | 普通用户访问 |
|------|-----------|-------------|
| `/admin` | ✅ 正常 | ❌ 显示 Access Denied |
| `/models` | ✅ 正常 | ❌ 显示 Access Denied |
| `/invitations` | ✅ 正常 | ❌ 显示 Access Denied |

### 全局对比分析

**后端 API 权限配置：**
| 页面 | API | 权限类型 | 状态 |
|------|-----|---------|------|
| admin | getStatistics | adminProcedure | ✅ 正确 |
| models | getAvailableModels | adminProcedure | ✅ 已修复 |
| models | updateModelConfig | adminProcedure | ✅ 正确 |
| invitations | generateInvitationCode | adminProcedure | ✅ 正确 |
| invitations | getInvitationHistory | adminProcedure | ✅ 正确 |
| invitations | validateInvitationCode | publicProcedure | ✅ 正确(注册用) |

**前端页面权限处理：**
| 页面 | error 处理 | 访问控制 | 状态 |
|------|-----------|---------|------|
| admin/page.tsx | ✅ 检查 error，显示 Access Denied | ✅ 有 | ✅ 正确 |
| models/page.tsx | ✅ 检查 error，显示 Access Denied | ✅ 有 | ✅ 已修复 |
| invitations/page.tsx | ✅ 检查 error，显示 Access Denied | ✅ 有 | ✅ 已修复 |

### 根本原因
1. **后端问题**：`model.getAvailableModels` 使用了 `publicProcedure` 而非 `adminProcedure`
2. **前端问题**：`models/page.tsx` 和 `invitations/page.tsx` 没有检查 API 错误并显示访问拒绝信息

### 修复方案

**第一步：修复后端 API 权限（model.ts）**
```typescript
// 修改前
getAvailableModels: publicProcedure.query(...)

// 修改后
getAvailableModels: adminProcedure.query(...)
```

**第二步：修复前端页面（models/page.tsx, invitations/page.tsx）**
添加与 admin/page.tsx 相同的 error 处理逻辑：
```typescript
if (error) {
  return (
    <div className="container mx-auto p-4">
      <h1>...</h1>
      <Card className="bg-red-50 border-red-200">
        <CardContent className="pt-6">
          <p className="text-red-600">
            {error.message === 'You do not have permission...'
              ? 'Access Denied: You need admin privileges...'
              : `Error: ${error.message}`}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
```

### 教训与检查清单 ⚠️
**实现管理员功能时的完整检查：**
- [ ] 后端：所有管理员 API 使用 `adminProcedure`
- [ ] 前端：页面检查 API error 并显示访问拒绝信息
- [ ] 测试：分别用管理员和普通用户测试页面访问

**权限控制层次结构：**
```
publicProcedure     → 任何人可访问（公开数据、注册验证等）
protectedProcedure  → 已登录用户可访问
adminProcedure      → 仅管理员可访问（继承 protectedProcedure）
```

---

## UI 像素级复刻规则 ⚠️ 必须严格遵守

> **规则文档**: `movetonew/UIfix_rule.md`

### 核心原则
1. **只改视觉，不改逻辑** - 不修改组件的 props、状态管理、事件处理
2. **100% 复制样式** - className、CSS 变量、Tailwind 配置完全照搬
3. **保持结构一致** - HTML 嵌套层级必须相同
4. **优先级**: 核心页面 > 次要页面 > 边缘功能

### ❌ 禁止修改
- 组件的 TypeScript 接口（props 类型）
- 状态管理逻辑（useState, useEffect）
- 事件处理函数内部逻辑
- tRPC 调用和数据获取
- 路由配置

### ✅ 只修改
- `className` 属性
- HTML 元素嵌套结构（仅限为了匹配样式）
- CSS 文件内容
- Tailwind 配置
- 内联 `style` 属性（如果必要）

### 🎯 质量标准
- 并排对比新旧项目，肉眼无法分辨差异
- 使用浏览器测量工具，间距误差 < 2px
- 颜色值完全匹配（使用开发者工具取色）
- 字体大小和粗细完全一致
- 响应式断点行为一致

### 旧项目关键文件
| 文件 | 内容 |
|------|------|
| `src/theme.css` (376行) | CSS 变量定义 |
| `src/components.css` (1224行) | 组件样式 |
| `tailwind.config.js` | Tailwind 配置 |
| `src/components/` | 所有组件 |

### 组件优先级
**P0 - 聊天系统**
```
src/components/chat/
├── ChatSidebar.jsx     ✅ 已完成
├── ChatHeader.jsx      ⬜ 待复刻
├── MessageBubble.jsx   ✅ 已完成
├── ChatInput.jsx       ✅ 已完成
└── ModelSelector.jsx   ⬜ 待复刻
```

**P1 - 布局组件**
```
src/components/layout/
├── AppHeader.jsx       ✅ 已完成
└── GlobalBanner.jsx    ⬜ 待复刻
```

### 复刻流程（标准模板）
1. 用户提供：旧项目页面截图 + 对应文件路径
2. 分析旧项目代码（HTML 结构、className、CSS 类）
3. 复制完整的 JSX 结构和 className
4. 处理自定义 CSS 类（确保已在 globals.css 中）
5. 验证：浏览器并排对比 + 开发者工具测量

### 输出格式
```markdown
## ✅ [页面/组件名称] 复刻完成

**复刻文件**:
- 旧: src/pages/Chat.jsx
- 新: apps/web/src/app/(app)/chat/page.tsx

**涉及组件**: [列表]
**关键修改**: [列表]
**验证结果**: [检查清单]
```

---

## Resources
- [Supabase SSR Auth Guide](https://supabase.com/docs/guides/auth/server-side)
- [tRPC React Query Setup](https://trpc.io/docs/client/react)
- [Next.js App Router](https://nextjs.org/docs/app)
- **UI 复刻规则**: `movetonew/UIfix_rule.md`

## Environment Variables Required
```
NEXT_PUBLIC_SUPABASE_URL=<your-supabase-url>
NEXT_PUBLIC_SUPABASE_ANON_KEY=<your-anon-key>
SUPABASE_SERVICE_ROLE_KEY=<your-service-role-key>  # Important for server-side auth
```
