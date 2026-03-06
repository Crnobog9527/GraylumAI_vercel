# 对话链路审计映射

## 页面与入口

| 页面/入口 | 路径 | 当前职责 |
| --- | --- | --- |
| Chat UI | `apps/web/src/app/chat/page.tsx` | 用户聊天入口，读取系统设置中的模型选择器、输入上限、计费提示 |
| Streaming Hook | `apps/web/src/hooks/useStreamingChat.ts` | 调用 `/api/ai/stream` 并处理 SSE |
| Streaming API | `apps/web/src/app/api/ai/stream/route.ts` | 真实聊天运行时，负责选模、提示词、缓存、计费和日志 |
| Admin Settings | `apps/web/src/app/admin/settings/page.tsx` | 维护智能路由、智能搜索判断、API 缓存等系统设置 |
| Admin Models | `apps/web/src/app/admin/models/page.tsx` | 管理模型配置与连接测试 |
| Admin Prompts | `apps/web/src/app/admin/prompts/page.tsx` | 管理系统提示词与用户模板 |
| Admin Finance | `apps/web/src/app/admin/finance/page.tsx` | 展示财务统计、API 请求统计、模型渠道统计 |
| Admin Performance | `apps/web/src/app/admin/performance/page.tsx` | 展示性能、缓存、成本、模型使用情况 |
| Admin Diagnostics | `apps/web/src/app/admin/diagnostics/page.tsx` | 运行运行时诊断并查看健康状态 |

## 共享运行时服务

| 服务 | 路径 | 当前职责 |
| --- | --- | --- |
| Runtime Settings | `packages/api/src/services/chatRuntime.ts` | 统一解析系统设置、提示词选择、系统提示词和用户模板 |
| Model Router | `packages/api/src/services/modelRouter.ts` | 智能路由、简单/复杂任务分类、联网判断 |
| Prompt Cache | `packages/api/src/services/promptCacheBuilder.ts` | 为 Anthropic 请求构造缓存点 |
| Billing | `packages/api/src/services/billing.ts` | 预扣、结算、退费、Token 统计、AI 使用日志 |
| Provider Utils | `packages/api/src/services/providerUtils.ts` | Anthropic / OpenAI-compatible 分支判定与错误解析 |
| Diagnostics | `packages/api/src/services/diagnostics.ts` | P0/P1 运行时诊断测试 |

## 数据表与运行时落库

| 表 | 用途 | 主要写入来源 |
| --- | --- | --- |
| `conversations` | 对话主记录、绑定模型 | `/api/ai/stream` |
| `messages` | 用户与助手消息 | `/api/ai/stream` |
| `token_stats` | Token、缓存、成本、积分 | `BillingService.recordTokenStats` |
| `billing_history` | 预扣、结算、退费历史 | `atomic_*` RPC / `BillingService` |
| `ai_usage_logs` | 请求状态、延迟、诊断元数据 | `BillingService.recordUsageLog` |
| `prompts` | 系统提示词与用户模板 | Admin Prompts |
| `system_settings` | 智能路由/搜索/缓存等开关 | Admin Settings |
| `ai_models` | provider、endpoint、api key、定价 | Admin Models |

## 当前本地验证事实

- `pnpm --filter @repo/api test:run` 已通过，`228/228`。
- `.env.local` 仅确认 `NEXT_PUBLIC_SUPABASE_URL`、`NEXT_PUBLIC_SUPABASE_ANON_KEY`、`ANTHROPIC_API_KEY` 存在。
- `.env.local` 仍缺少 `SUPABASE_SERVICE_ROLE_KEY`、`E2E_TEST_EMAIL`、`E2E_TEST_PASSWORD`、`E2E_ADMIN_EMAIL`、`E2E_ADMIN_PASSWORD`。
- 因缺少上述凭据，真实联机闭环验证和 Playwright 关键流审计尚未执行。

## 关键测试映射

| 目标 | 现有覆盖 | 当前状态 |
| --- | --- | --- |
| API 服务单测 | `packages/api/src/services/__tests__/*` | 已执行通过 |
| 聊天关键流 | `apps/web/tests/e2e/chat.spec.ts` | 需要 E2E 用户账号 |
| 管理后台关键流 | `apps/web/tests/e2e/admin.spec.ts` | 需要 E2E 管理员账号 |
| 安全与访问控制 | `apps/web/tests/e2e/security.spec.ts` | 需要本地环境与登录态 |
| 运行时诊断 | `packages/api/src/services/diagnostics.ts` + Admin Diagnostics | 现已改为读取统一运行时配置 |
