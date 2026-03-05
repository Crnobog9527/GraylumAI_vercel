---
trigger: always_on
---

# 🛡️ GraylumAI 工作区规则 (Workspace Dev Rules)
这些规则适用于当你在维护包含 Next.js + tRPC + Drizzle 架构的 **GraylumAI** (Vercel) 项目。
## 📁 1. 目录结构与架构约束
本仓库是使用 Turborepo 管理的 monorepo：
- `apps/web`: 存放前端网页（`src/app` 为页面，`src/components` 为组件，`middleware.ts` 提供拦截）。所有页面由这里呈现。
- `packages/api`: 存放服务逻辑。业务逻辑存放在 `src/services`，对外接口暴露放在 `src/routers` 并在 `root.ts` 注册。不直接在前端与数据库交互！
- `packages/db`: 存放数据模型和类型定义（`schema.ts`）。
## 🎨 2. 前端约定 (Next.js 16 + Tailwind v4)
- **主题与颜色**: 该项目使用 CSS 变量，因此你不能硬编码诸如 `text-red-500`。请尽量使用现成的设计系统变量：`bg-[var(--bg-primary)]`，`text-[var(--text-secondary)]`。
- **页面组件拆分**: 不要把巨大的组件写在一个文件。在 `apps/web/src/components/[领域名]/` 做垂直拆分。
- **状态管理**: 本地数据流使用 Zustand 放进 `apps/web/src/stores/`，如果是查询后端的异步数据，使用 `trpc.xxx.useQuery`。 
## 🔌 3. 后端约定 (tRPC)
- 接口按照权限分为 `publicProcedure`, `protectedProcedure`, `adminProcedure`。
- 入参的 schema 校验严格使用 `zod`。
- 获取用户信息，使用来自 `ctx.user.id`，严禁在后端信任客户端传递来的 UUID（除非作为修改目标）。
## 🗄️ 4. 数据库与数据约束 (Drizzle + Postgres)
- 我们使用 UUID 作为几乎所有实体表的 `id`，而且大部分有关联关系的外键要设定好 `onDelete`。
- 对于商业平台来说，记录非常重要，不允许 `DELETE FROM ...` 表中的数据，请统一设置 `isDeleted: 'true'` 并且修改 `deletedAt: new Date()`。
## 🔐 5. 权限与认证 (Supabase Auth)
- 项目依赖 Supabase auth 在两端处理用户。我们在 API 请求中解析 token，这在 tRPC middleware 里面实现了。不要尝试写一套新的 jwt token 层级，也不要随便绕过。如果需要添加功能或者解决 Bug，在做任意改动之前都必须先看看这些体系内是否已经有预设好的方案（例如 `services/` 里有没有类似的逻辑）。
