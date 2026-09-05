# GraylumAI 项目地图（给不写代码的负责人）

本文是架构导航，具体接口和状态需核对当前代码与 live evidence。历史验证
记录不代表当前候选通过；执行规则见当前 `AGENTS.md`，任务发现见
[Launch 入口](launch/START_HERE.md)。

## 1) 这个项目到底是什么
- 项目类型：`pnpm + turbo` Monorepo。
- 前端应用：`apps/web`（Next.js 16 + React 19）。
- 后端接口：`packages/api`（tRPC + Supabase）。
- 数据层：Supabase Postgres（RLS + SQL migrations）。
- AI 主功能：聊天流式回复、积分计费、模型管理、管理后台、诊断系统。

核心链路：
`浏览器页面` -> `apps/web/src/app/api/trpc/[trpc]/route.ts`（tRPC）/ `apps/web/src/app/api/ai/stream/route.ts`（流式 AI） -> `packages/api/src/root.ts` -> `packages/api/src/routers/*.ts` -> Supabase

## 2) 你最关心的业务模块
### A. 用户端
- 首页：`/` -> `apps/web/src/app/page.tsx`
- 聊天页：`/chat` -> `apps/web/src/app/chat/page.tsx`
- 个人中心：`/profile` -> `apps/web/src/app/profile/page.tsx`
- 功能广场：`/marketplace` -> `apps/web/src/app/marketplace/page.tsx`
- 登录页：`/login` -> `apps/web/src/app/login/page.tsx`

### B. 管理端
- 管理入口：`/admin` -> `apps/web/src/app/admin/page.tsx`
- 用户、模型、成本、诊断、公告、工单等都在 `apps/web/src/app/admin/*`
- 权限保护：`apps/web/src/components/admin/AdminGuard.tsx`

### C. API 层
- tRPC 入口：`apps/web/src/app/api/trpc/[trpc]/route.ts`
- 流式 AI 入口：`apps/web/src/app/api/ai/stream/route.ts`
- 定时诊断：`apps/web/src/app/api/cron/diagnostics/route.ts`

## 3) 聊天系统主链路（必须记住）
当前唯一主链路：
- 页面：`apps/web/src/app/chat/page.tsx`
- Hook：`apps/web/src/hooks/useStreamingChat.ts`
- API：`apps/web/src/app/api/ai/stream/route.ts`

这个链路负责：
- 流式输出（SSE）
- 预扣/结算/退费（`atomic_pre_deduct`, `atomic_settle`, `atomic_refund`）
- 对话与消息落库
- Token 统计与积分更新

## 4) 已移除的旧链路（不要恢复）
以下旧非流式路径已经从前端仓库移除，后端旧入口也已下线：
- `apps/web/src/hooks/useAIChat.ts`
- `apps/web/src/components/ai/*`
- `apps/web/src/components/chat/ChatInterface.tsx`
- `packages/api/src/routers/chat.ts` 的 `chat.sendMessage`（已改为直接报错，防误用）

## 5) 数据库核心表（按业务看）
- 用户与权限：`profiles`
- 对话与消息：`conversations`, `messages`
- 计费与积分：`billing_history`, `token_stats`, `credit_transactions`
- AI 模型配置：`ai_models`
- 配置项：`system_settings`, `membership_plans`, `credit_packages`
- 工单系统：`tickets`, `ticket_replies`
- 运营内容：`announcements`, `prompts`, `modules`
- 观测与诊断：`application_logs`, `diagnostic_results`, `ai_usage_logs`

迁移文件在：`packages/db/migrations/*.sql`

## 6) 代码变更影响面速查
- 改聊天回复逻辑：优先看
  - `apps/web/src/app/api/ai/stream/route.ts`
  - `apps/web/src/hooks/useStreamingChat.ts`
  - `apps/web/src/app/chat/page.tsx`
- 改积分规则：
  - `packages/api/src/services/billing.ts`
  - `packages/api/src/services/costCalculator.ts`
  - `packages/db/migrations/0003_atomic_billing_rpc.sql`
- 改管理员统计：
  - `packages/api/src/routers/admin.ts`
  - `apps/web/src/app/admin/*`

## 7) Agent 可按任务选择的开发命令
- API 单测基线：`pnpm --filter @repo/api test:run`
- 全仓构建：`pnpm build`
- 本地开发：`pnpm dev`

## 8) 历史稳定化记录（不是当前验证结果）
- `.env.example` 改为安全占位符，移除真实密钥样式值。
- 修复 `admin.getUserDetails` 消息统计逻辑（按用户对话 ID 统计消息）。
- 下线旧 `chat.sendMessage` Echo 入口，避免误接旧链路。
- API 测试从 4 个失败修复为 0 个失败（228/228 通过）。

## 9) 如何提出任务

说明期望的用户行为、当前问题和验收结果即可。Agent 自行定位页面、接口、
文件范围和验证方式，不要求 Owner 选择技术命令或使用固定模板。

## 10) 发布资料

以下材料可用于定位历史证据与技术要求，不能替代当前候选的验证、授权或
完成判断；当前执行流程以 `AGENTS.md` 为准：

- `docs/STRICT_SIGNOFF_STATUS.md`
- `docs/RELEASE_PREP_CHECKLIST.md`
- `docs/runbooks/PRE_RELEASE_REHEARSAL.md`
- `docs/STRIPE_ENABLEMENT_CHECKLIST.md`
