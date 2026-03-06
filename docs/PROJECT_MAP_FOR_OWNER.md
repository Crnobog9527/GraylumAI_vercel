# GraylumAI 项目地图（给不写代码的负责人）

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

## 4) 已标记的旧链路（不要再用）
以下属于旧非流式路径，已标记 deprecated，且后端旧入口已下线：
- `apps/web/src/hooks/useAIChat.ts`
- `apps/web/src/components/ai/ChatInterface.tsx`
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

## 7) 负责人必用验证命令
- API 单测基线：`pnpm --filter @repo/api test:run`
- 全仓构建：`pnpm build`
- 本地开发：`pnpm dev`

## 8) 当前已完成稳定化动作（本轮）
- `.env.example` 改为安全占位符，移除真实密钥样式值。
- 修复 `admin.getUserDetails` 消息统计逻辑（按用户对话 ID 统计消息）。
- 下线旧 `chat.sendMessage` Echo 入口，避免误接旧链路。
- API 测试从 4 个失败修复为 0 个失败（228/228 通过）。

## 9) 你每次找 agent 前要做的 10 秒动作
- 先判断任务属于：`聊天主链` / `管理后台` / `计费` / `数据库`。
- 明确你要改的“页面或接口”与“验收句子”。
- 按 `docs/AGENT_COMMAND_PLAYBOOK.md` 模板发指令。
