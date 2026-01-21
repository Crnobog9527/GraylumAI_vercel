# Findings & Decisions

## Tech Stack Versions (Updated: 2026-01-21)

| Category | Package | Version |
|----------|---------|---------|
| **Framework** | Next.js | 16.1.4 |
| | React | 19.2.3 |
| | TypeScript | 5.9.3 |
| **Styling** | Tailwind CSS | 4.1.18 |
| **State & Data** | @tanstack/react-query | 5.90.19 |
| | @trpc/* | 11.8.1 |
| **Database** | @supabase/supabase-js | 2.90.1 |
| | drizzle-orm | 0.45.1 |
| | postgres | 3.4.8 |
| **Validation** | zod | 4.3.5 |
| **UI** | lucide-react | 0.562.0 |
| | @radix-ui/* | 1.1.x - 2.2.x |
| **Build** | turbo | 2.7.5 |
| | pnpm | 10.27.0 |

---

## Phase 10 安全与合规审计发现 (2026-01-21)

### 审计总览

| 类别 | 评分 | 状态 |
|------|------|------|
| 计费安全 | 3.5/5 | ⚠️ 需改进 |
| 前端功能 | 3.0/5 | ⚠️ 需改进 |
| API 安全 | 4.0/5 | ✅ 良好 |
| 数据隐私 | 2.5/5 | 🔴 需修复 |
| AI 优化 | 3.0/5 | ⚠️ 需改进 |
| 可观测性 | 2.5/5 | 🔴 需修复 |
| **总体评分** | **3.1/5** | ⚠️ 部分达标 |

### 🔴 严重问题 (P0)

#### 1. 费率配置未对齐
- **位置**: `packages/api/src/types/billing.ts:283-305`, `packages/api/src/services/costCalculator.ts:68-114`
- **问题**: 计费系统使用硬编码 `MODEL_PRICING` 常量，完全忽略数据库 `ai_models.token_rate` 字段
- **影响**: 管理后台修改费率无效，需要修改代码重新部署
- **建议**: 创建 `getModelPricing(modelId)` 函数，从数据库实时读取费率

#### 2. Header 积分硬编码
- **位置**: `apps/web/src/components/layout/AppHeader.tsx:38`
- **代码**: `const [credits] = useState(100); // TODO: Get from user context`
- **影响**: 全站所有页面积分显示为硬编码的 100，与实际积分不同步
- **建议**: 调用 `trpc.credits.getBalance.useQuery()` 获取实时积分

#### 3. RLS 策略缺失
- **位置**: `packages/db/migrations/`
- **问题**: 18 个表中仅 3 个启用 RLS (token_stats, billing_history, ai_usage_logs)
- **缺失表**: profiles, conversations, messages, creditTransactions, tickets, ticketReplies, userActivityLogs, prompts, invitationRecords, systemSettings, aiModels 等 15 个
- **影响**: 用户可能越权访问他人数据
- **建议**: 为所有用户数据表添加 `USING (auth.uid() = user_id)` RLS 策略

#### 4. 流式中断未正确实现
- **位置**: `apps/web/src/hooks/useAIChat.ts`, `packages/api/src/routers/ai.ts`
- **问题**:
  - useAIChat 使用 tRPC mutation 而非流式接口
  - abortControllerRef 定义但未被正确使用
  - 中断后无积分结算机制
- **影响**: 用户点击中断后，后端继续计算并扣全额积分
- **建议**: 实现真正的 SSE 流式 API，中断时计算已消耗 tokens 进行部分结算

#### 5. 请求幂等性缺失
- **位置**: `packages/api/src/routers/ai.ts:295-339`
- **问题**: AI 路由的 preDeduct/settle 调用缺少 idempotencyKey
- **影响**: 网络重试可能导致重复扣费
- **建议**: 生成唯一 requestId，添加幂等性检查

#### 6. 事务原子性不足
- **位置**: `packages/api/src/services/billing.ts`
- **问题**:
  - 使用 Supabase REST API，无法使用 PostgreSQL 事务
  - preDeduct/settle/refund 三步操作非原子性
  - 记录插入与余额更新分离
- **影响**: 并发情况下可能数据不一致
- **建议**: 使用 Supabase RPC 函数实现原子操作（参考 credits-atomic.ts）

### 🟡 中等问题 (P1)

#### 7. 请求签名/时间戳未实现
- **位置**: `packages/api/src/middleware/securityChecks.ts`
- **问题**: 无 API 请求签名验证，无时间戳校验
- **影响**: 无法防止重放攻击
- **建议**: 实现 HMAC-SHA256 签名 + 30秒时间戳校验

#### 8. 上下文压缩阈值配置不一致
- **位置**: `packages/api/src/services/contextManager.ts:25`
- **问题**:
  - 当前阈值 80000/150000 = 53.3%，非要求的 60%
  - contextManager 稳定区域 5 轮，promptCacheBuilder 稳定区域 3 轮
- **建议**: 统一配置为 90000 (60%) 和 3 轮

#### 9. 递归摘要算法未实现
- **位置**: `packages/api/src/services/contextManager.ts:263-281`
- **问题**: 仅实现单层摘要，无递归压缩机制
- **建议**: 实现多层摘要链式压缩

#### 10. 智能路由关键词不完整
- **位置**: `packages/api/src/services/modelRouter.ts:48-67`
- **问题**: 缺少实时数据关键词（新闻、天气、股票、实时、最新等）
- **影响**: 无法识别需要 Web Search 的查询
- **建议**: 添加 `REALTIME_DATA_KEYWORDS` 正则匹配

#### 11. settle() 缺少成本验证
- **位置**: `packages/api/src/services/billing.ts:229-326`
- **问题**: 接收 actualCredits 参数但未验证与 usage 对应
- **建议**: 添加 `calculateTokenCost(modelId, usage)` 验证

#### 12. 日志信息不完整
- **位置**: `packages/api/src/routers/ai.ts:353-360`
- **问题**: ai_usage_logs 记录缺少 request_id、ip_address、user_agent
- **建议**: 从请求上下文提取并传递完整日志信息

#### 13. 路由系统 window.location 使用
- **位置**:
  - `apps/web/src/app/login/page.tsx:22`
  - `apps/web/src/components/home/SixStepsGuide.tsx:60`
- **问题**: 使用 window.location.href 替代 Next.js useRouter
- **建议**: 改用 `router.push()`

### ✅ 已达标项目

| # | 检查项 | 评分 | 位置 |
|---|--------|------|------|
| 1 | 后端积分计算 | 5/5 | billing.ts - calculateTokenCost() |
| 2 | 三段式计费 | 5/5 | billing.ts - preDeduct/settle/refund |
| 3 | tRPC 权限保护 | 5/5 | ai.ts - 全部使用 protectedProcedure |
| 4 | 速率限制 | 5/5 | securityChecks.ts - 60次/分钟 |
| 5 | 消费熔断 | 5/5 | securityChecks.ts - 10000/小时 |
| 6 | 内容审核 | 5/5 | contentModerator.ts - 双向审查 |
| 7 | Prompt 注入防御 | 5/5 | contentModerator.ts - 9种模式检测 |
| 8 | Sidebar 对话切换 | 5/5 | ChatSidebar.tsx + useChatStore |
| 9 | Prompt Caching | 5/5 | promptCacheBuilder.ts - cache_control |
| 10 | 环境安全 | 4/5 | 无通配符 CORS，.env 正确忽略 |
| 11 | CHECK 约束 | 5/5 | profiles.credits >= 0 |

### 技术决策更新

| 决策 | 理由 |
|------|------|
| 费率应从数据库读取 | 硬编码无法通过管理后台配置 |
| 使用 RPC 函数实现原子计费 | REST API 无法保证事务原子性 |
| 所有用户数据表需 RLS | 防止越权访问 |
| 流式 API 需支持中断结算 | 避免用户被扣全额但未完成生成 |
| 请求需唯一 ID | 支持幂等性和链路追踪 |

---

## 组件实现状态评估 (2026-01-21)

### 评估结论

经过对 task_plan.md 与实际代码库的对比分析，发现 **~85% 的标记待完成组件实际已存在**。

### 组件统计

| 分类 | 总数 | 完成状态 | 备注 |
|------|------|----------|------|
| 布局组件 | 2 | ✅ 100% | GlobalBanner + 多个 Sidebar |
| 聊天组件 | 8 | ✅ 100% | ModelSelector, ChatDebugPanel 等 |
| 用户资料组件 | 5 | ✅ 80% | 核心完成，AvatarCropper 低优先级 |
| Shadcn/ui 组件 | 39 | ✅ 100% | 全部组件已存在 |
| 管理后台组件 | 9 | ✅ 100% | 8000+ 行内联实现 |
| 通用组件 | 4 | ✅ 75% | CreditDisplay 等低优先级 |

### 决策

1. **无需继续开发** - 大部分组件已实现
2. **内联优于提取** - 管理后台组件内联实现，单次使用无需提取
3. **文档需同步** - task_plan.md 组件状态标记已更新
4. **低优先级组件** - AvatarCropper、CreditsDialog、CreditDisplay、InviteDialog 可按需开发

---

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

## UI 复刻工作流程 ⚠️ 重要经验 (2026-01-20)

### 正确的工作流程

```
1. 页面优先原则
   └── 先复刻 **页面布局**（整体结构）
   └── 在复刻页面时 **按需创建组件**
   └── 组件随页面一起验证

2. 组件创建时机
   └── 当页面需要某个组件时再创建
   └── 创建后立即集成到页面
   └── 验证组件在页面中的效果
```

### 避免的错误做法

| 错误做法 | 问题 |
|----------|------|
| ❌ 先批量创建组件 | 组件可能不符合实际需求 |
| ❌ 组件创建后不集成 | 无法验证组件效果 |
| ❌ 脱离页面上下文开发 | 样式可能与整体不协调 |

### 推荐流程示例

**复刻管理后台页面时：**
```
1. 读取旧项目 AdminDashboard.jsx
2. 分析页面结构：AdminSidebar + 主内容区
3. 创建/更新 AdminSidebar 组件
4. 创建/更新 StatsCard 组件
5. 重写 admin/page.tsx，集成组件
6. 验证整体效果
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

---

## 数据库表结构 (2026-01-20 更新)

### 核心表
| 表名 | 字段 | 用途 |
|------|------|------|
| `profiles` | id, email, nickname, avatar_url, role, credits, created_at | 用户资料 |
| `conversations` | id, user_id, title, model_id, created_at | 对话 |
| `messages` | id, conversation_id, role, content, created_at | 消息 |
| `credit_transactions` | id, user_id, amount, type, description, created_at | 积分交易 |

### 配置表
| 表名 | 字段 | 用途 |
|------|------|------|
| `ai_models` | id, name, provider, endpoint, config, created_at | AI 模型配置 |
| `system_settings` | key, value | 系统设置 (JSONB) |

### 业务表
| 表名 | 字段 | 用途 |
|------|------|------|
| `tickets` | id, user_id, title, status, created_at | 工单 |
| `ticket_replies` | id, ticket_id, user_id, content, created_at | 工单回复 |
| `credit_packages` | id, name, price, credits_amount, active, created_at | 积分包 |
| `invitations` | code, created_by, used_by, status, created_at | 邀请码 |
| `announcements` | id, title, content, type, priority, active, start_date, end_date, created_by, created_at, updated_at | 公告 |
| `prompts` | id, name, description, content, category, is_system, active, sort_order, created_by, created_at, updated_at | 提示词模块 |

### 新增表详情 (2026-01-20)

**announcements (公告表)**
```sql
CREATE TABLE announcements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  type TEXT DEFAULT 'info' NOT NULL,  -- 'info', 'warning', 'success', 'error'
  priority INTEGER DEFAULT 0 NOT NULL,
  active TEXT DEFAULT 'true' NOT NULL,
  start_date TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  end_date TIMESTAMP WITH TIME ZONE,
  created_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
);
```

**prompts (提示词表)**
```sql
CREATE TABLE prompts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  content TEXT NOT NULL,
  category TEXT DEFAULT 'general' NOT NULL,  -- 'general', 'assistant', 'creative', 'coding', 'translation', 'analysis'
  is_system TEXT DEFAULT 'false' NOT NULL,
  active TEXT DEFAULT 'true' NOT NULL,
  sort_order INTEGER DEFAULT 0 NOT NULL,
  created_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
);
```

---

---

## 管理后台功能差异分析 (2026-01-20)

### 代码量对比

| 页面 | 旧项目 (行数) | 新项目 (行数) | 差异 | 状态 |
|------|---------------|---------------|------|------|
| Dashboard | 210 | 215 | +5 | ✅ 基本一致 |
| Announcements | 1117 | 567 | **-550** | ⚠️ 功能缺失 |
| Models | 740 | 383 | **-357** | ⚠️ 功能缺失 |
| Packages | 767 | 411 | **-356** | ⚠️ 功能缺失 |
| Invitations | 352 | 191 | **-161** | ⚠️ 功能缺失 |
| Settings | 366 | 218 | **-148** | ⚠️ 功能缺失 |
| Finance | 360 | 378 | +18 | ✅ 基本一致 |
| Performance | 57 | 366 | +309 | ✅ 已增强 |
| Prompts | 590 | 561 | -29 | ✅ 基本一致 |
| Tickets | 493 | 383 | -110 | ⚠️ 功能缺失 |
| Transactions | 286 | 303 | +17 | ✅ 基本一致 |
| Users | 302 | 294 | -8 | ✅ 基本一致 |
| **总计** | **5784** | **4270** | **-1514** | - |

### 关键功能缺失详情

#### 1. 公告管理 (AdminAnnouncements)
**缺失功能：**
- 精选模块管理 (FeaturedModule)
- 首页指引配置 (HomepageGuide)
- 横幅样式选项 (6种样式)
- 图标选择器 (lucide 图标集)
- 模块链接配置 (link_module_id, link_url)
- 卡片样式配置 (card_style)
- 徽章配置 (badge_type, badge_text)

#### 2. 模型管理 (AdminModels)
**缺失功能：**
- Token 成本分层定价 (≤200K vs >200K)
- Web 搜索成本配置
- 模型测试功能
- 完整 CRUD 操作 (目前仅配置更新)
- 最大 Token 限制配置
- 输入限制配置

#### 3. 积分包管理 (AdminPackages)
**缺失功能：**
- **会员套餐系统完全缺失**
  - 会员等级 (free, pro, gold)
  - 月付/年付定价
  - 会员专属积分赠送
  - 会员购买折扣
  - 会员特权列表
- 人气标签 (is_popular)
- 额外赠送积分 (bonus_credits)
- 排序管理

#### 4. 邀请码管理 (AdminInvitations)
**缺失功能：**
- 邀请记录追踪 (inviter → invitee)
- 邀请人/被邀请人邮箱
- 奖励金额统计 (inviter_reward)
- 风险评估系统 (risk_level, block_reason)
- 7天趋势图表
- 风险分布图表
- 状态过滤和搜索

#### 5. 系统设置 (AdminSettings)
**缺失功能 (64项 → 6项)：**

| 分类 | 缺失设置项 |
|------|-----------|
| 计费设置 | token 成本、首购奖励、价格等 (5项) |
| 功能开关 | 智能路由、智能搜索、免费层级等 (6项) |
| 限制设置 | 最大消息数、输入字符限制等 (3项) |
| 签到奖励 | 5天周期奖励、月度奖励等 (6项) |
| 推荐系统 | 奖励、返利、绑定、限制等 (10项) |
| 其他 | 支持邮箱、维护模式等 |

### 架构差异

| 方面 | 旧项目 (Base44) | 新项目 (Next.js/tRPC) |
|------|-----------------|----------------------|
| API | REST via base44.entities | tRPC procedures |
| 权限检查 | 组件内检查 | tRPC resolver 中检查 |
| 数据操作 | 完整 CRUD | 部分 CRUD |
| 状态管理 | React Query + state | tRPC useQuery hooks |
| 图表库 | Recharts | 未使用 |
| 国际化 | LanguageProvider | 硬编码中文 |

### 还原优先级

| 优先级 | 模块 | 原因 |
|--------|------|------|
| P0 | Settings - 计费/功能开关 | 影响核心业务逻辑 |
| P0 | Packages - 会员系统 | 影响盈利模式 |
| P1 | Models - 完整 CRUD | 影响 AI 调用配置 |
| P1 | Invitations - 记录追踪 | 影响用户增长分析 |
| P2 | Announcements - 精选模块 | 影响首页展示 |
| P2 | Settings - 签到/推荐 | 增长运营功能 |

---

## Resources
- [Supabase SSR Auth Guide](https://supabase.com/docs/guides/auth/server-side)
- [tRPC React Query Setup](https://trpc.io/docs/client/react)
- [Next.js App Router](https://nextjs.org/docs/app)
- **UI 复刻规则**: `movetonew/UIfix_rule.md`
- **旧项目备份**: `/home/user/graylumAi-backup-ref/`

## Environment Variables Required
```
NEXT_PUBLIC_SUPABASE_URL=<your-supabase-url>
NEXT_PUBLIC_SUPABASE_ANON_KEY=<your-anon-key>
SUPABASE_SERVICE_ROLE_KEY=<your-service-role-key>  # Important for server-side auth
```
