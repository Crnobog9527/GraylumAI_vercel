# 稳定化待办（Stabilization Backlog）

## 执行策略
- 总原则：稳定优先。
- 顺序：`P0 -> P1 -> P2`。
- 每项都要有：负责人、验收标准、验证结果、回滚方案。

## P0（必须先做）

### P0-1 密钥安全与轮换
- 目标：处理 `.env.example` 中真实密钥样式值，并完成密钥轮换。
- 状态：
  - 代码仓库：`已完成`（`.env.example` 已替换为安全占位符）。
  - 外部系统轮换：`待执行`（Supabase/Anthropic/Vercel 环境变量）。
- 验收标准：
  - 仓库中不存在真实密钥样式值。
  - 新密钥已在平台生效，旧密钥已失效。
- 验证：
  - 本地扫描：`rg -n "sk-ant-|eyJhbGciOiJIUzI1Ni|sb_publishable_" .`
  - 线上功能：登录和 AI 调用正常。

## P1（高优先，已首批锁定）

### P1-0 历史 E2E 稳定化与管理后台运行态清理
- 目标：收口阶段 12 后遗留的管理后台、登录、聊天与 destructive 回归不稳定问题。
- 状态：`已完成`。
- 实施：
  - `/admin/settings` 首屏查询拆分为轻量 dashboard 与独立 cleanup stats，保存链路改为 `settings.updateSystemSettingsBulk` 批量 upsert。
  - 管理端套餐、提示词、公告、模型、用户与聊天侧边栏对话框补齐隐藏 `DialogDescription`，消除当前关键 E2E 命中的 Radix description 警告。
  - 管理端 CRUD mutation 在关闭弹窗或进入下一断言前等待列表 refetch，减少陈旧 UI 与后台状态竞态。
  - 订阅卡使用 `plan.id` 作为稳定身份，避免同级别多套餐时 React key 与 E2E selector 冲突。
  - 登录代理保留安全的 `redirect` 目标，修复已登录用户访问 `/login?redirect=...` 时被错误送回首页的问题。
- 验收标准：
  - `admin-config.spec.ts`、`admin-destructive.spec.ts`、`admin-ops.spec.ts`、`auth.spec.ts`、`chat.spec.ts` 在本地 Chromium 串行回归中通过。
  - `.auth` storage state 不作为交付差异保留。
- 验证：
  - `pnpm --dir apps/web test:e2e admin-config.spec.ts --project=chromium`：`10 passed / 2 skipped`
  - `ENABLE_PARITY_DESTRUCTIVE_E2E=true pnpm --dir apps/web test:e2e admin-destructive.spec.ts --project=chromium`：`12 passed`
  - `pnpm --dir apps/web test:e2e admin-ops.spec.ts --project=chromium`：`6 passed`
  - `pnpm --dir apps/web test:e2e auth.spec.ts --project=chromium`：`11 passed`
  - `pnpm --dir apps/web test:e2e chat.spec.ts --project=chromium`：`6 passed / 4 skipped`
- 备注：`admin-config` 中 smart routing / smart search preview runtime proof 与 `chat` live preview 用例仍按环境门控跳过；它们不是本轮本地稳定化失败项。

### P1-1 修复 admin 用户详情消息统计
- 目标：修复 `admin.getUserDetails` 统计逻辑错误。
- 状态：`已完成`。
- 实施：`packages/api/src/routers/admin.ts` 改为按用户 conversation IDs 统计 messages。
- 验收标准：后台显示消息总数与数据库一致。

### P1-2 明确单一聊天链路，避免误用旧链路
- 目标：只保留流式主链；旧入口不能被误当主链使用。
- 状态：`已完成`。
- 实施：
  - `packages/api/src/routers/chat.ts` 的 `chat.sendMessage` 已下线并返回 deprecated 错误。
  - 旧前端链路文件已加 `@deprecated` 标记。
- 验收标准：新需求不会再接入旧 Echo 路径。

### P1-3 修复 API 单测失败基线
- 目标：`pnpm --filter @repo/api test:run` 从 4 fail -> 0 fail。
- 状态：`已完成`。
- 当前结果：`228/228 passed`。
- 涉及修复：
  - `billing.ts` 对无 RPC client 的兼容回退。
  - `costCalculator.test.ts` 使用当前计费常量，修正过期断言。

### P1-4 聊天主链端到端冒烟
- 目标：验证登录->发消息->流式回复->积分变化->会话落库。
- 状态：`已完成`。
- 实施：
  - `apps/web/tests/e2e/support/creditFixtures.ts` 已补齐只读验证 helper，可按 `requestId` / `conversationId` / 用户邮箱读取 `ai_usage_logs`、`conversations`、`messages`、`token_stats`、`credit_transactions` 与当前积分。
  - `apps/web/tests/e2e/chat.spec.ts` 已新增“聊天主链闭环” live smoke，用同一条证据链串起 `/api/ai/stream -> requestId -> ai_usage_logs -> conversation/messages/token_stats -> credits delta / credit_transactions`。
  - `apps/web/tests/e2e/support/runtimeConstraints.ts` 已修正空 `PLAYWRIGHT_BASE_URL` 的判定，避免未显式指定 preview URL 时误把本地 `localhost` 运行当成远端验证。
  - `apps/web/tests/e2e/chat.spec.ts` 的预充值步骤已优先走 service-role fixture，避免因 preview 管理后台异常阻断聊天主链验收。
  - `apps/web/src/proxy.ts`、`apps/web/src/app/api/trpc/[trpc]/route.ts`、`apps/web/src/lib/rateLimit.ts` 与 `packages/api/src/services/redisRateLimiter.ts` 已把 fail-closed 条件收口为“仅真正 production deployment 生效”，避免 Vercel preview 因 `NODE_ENV=production` 被误判并打出初始化 `503`。
- 验收标准：5 步全部通过并有截图/日志证据。
- 当前验证：
  - 本地静态检查：`pnpm --dir apps/web exec tsc --noEmit`
  - 用例已纳入预发布编排：`pnpm --dir apps/web exec playwright test tests/e2e/chat.spec.ts --list`
  - 2026-03-30 锁定 preview 首次实跑：
    - 命令：`PLAYWRIGHT_BASE_URL='https://graylum-ai-vercel-v1-ee9tpol9k-simons-projects-bfe3e99f.vercel.app' pnpm --dir apps/web exec playwright test tests/e2e/chat.spec.ts --project=chromium --grep "persist chat runtime evidence"`
    - 结果：失败。`/api/trpc/settings.getSystemSettings`、`credits.getBalance`、`model.getActiveModels` 等初始化请求在该 preview 上批量返回 `503`，聊天页显示 `0 积分 已用完`，发送按钮保持 disabled，闭环 smoke 无法进入 `/api/ai/stream`。
    - 证据：`apps/web/test-results/artifacts/chat-AI-Chat-should-persis-f9733-its-for-a-live-preview-send-chromium/`
    - 辅助日志：`vercel logs https://graylum-ai-vercel-v1-ee9tpol9k-simons-projects-bfe3e99f.vercel.app --since 15m --status-code 503 --no-follow --json`
  - 根因核查：
    - preview 与本地指向同一 Supabase 项目，且 `maintenance_mode=false`
    - 真正阻塞来自 preview 上 rate-limit / maintenance fail-closed 守门逻辑误把 `NODE_ENV=production` 的 preview 当成 production
  - 2026-03-30 修复后锁定 preview 二次验收：
    - 定向 smoke：`PLAYWRIGHT_BASE_URL='https://graylum-ai-vercel-v1-7wmlf92aa-simons-projects-bfe3e99f.vercel.app' pnpm --dir apps/web exec playwright test tests/e2e/chat.spec.ts --project=chromium --grep "persist chat runtime evidence"`
    - 结果：通过
  - 2026-03-30 预发布验收包：
    - 命令：`pnpm release:preflight:preview -- --preview-url 'https://graylum-ai-vercel-v1-7wmlf92aa-simons-projects-bfe3e99f.vercel.app' --bypass-cookie <placeholder> --skip-local-build`
    - 结果：`preview-chat: passed`
    - 证据目录：`.release-output/preflight/20260330-020359/`
    - 关键日志：`.release-output/preflight/20260330-020359/logs/preview-chat.log`
  - 2026-03-30 代理修正后的二次预发布验收包：
    - 命令：`pnpm release:preflight:preview -- --preview-url 'https://graylum-ai-vercel-v1-rlirdsdsi-simons-projects-bfe3e99f.vercel.app' --bypass-cookie <placeholder> --skip-local-build`
    - 结果：`preview-auth`、`preview-chat`、`preview-admin`、`preview-admin-ops`、`preview-security` 全部通过
    - 证据目录：`.release-output/preflight/20260330-021726/`
  - 2026-03-30 全量 preview 预发布验收包：
    - 命令：`pnpm release:preflight:preview -- --preview-url 'https://graylum-ai-vercel-v1-ra0wk8t1e-simons-projects-bfe3e99f.vercel.app' --bypass-cookie <placeholder> --skip-local-build`
    - 结果：`preview-auth`、`preview-chat`、`preview-admin`、`preview-admin-config`、`preview-admin-ops`、`preview-security`、`preview-user-extended`、`preview-user-supplemental` 全部通过
    - 证据目录：`.release-output/preflight/20260330-031226/`
  - 备注：
    - 先前 preview 中收敛出的 `preview-admin-config`、`preview-user-extended`、`preview-user-supplemental` 已在最新全量 preflight 中闭环，不再保留为当前阻塞项。

### P1-5 收敛公开 tRPC 路由的 RLS 绕过模式
- 目标：去掉公开路由“检测到 service role 就改走管理员客户端”的模式，避免应用层绕过数据库边界。
- 状态：`已完成`。
- 已确认范围：
  - `packages/api/src/routers/settings.ts`
  - `packages/api/src/routers/modules.ts`
  - `packages/api/src/routers/invitation.ts#validateInvitationCode`
- 实施：
  - `settings/modules` 的公开读路径已固定使用 `ctx.supabasePublic ?? ctx.supabase`
  - `validateInvitationCode` 已固定调用 `validateInvitationCodeExists(ctx.supabasePublic, input.code)`
- 验收标准：
  - 公开接口默认仅依赖匿名/公开客户端或最小权限 RPC。
  - service role 是否存在，不再改变公开接口的权限边界。
  - 增加回归测试覆盖公开读路径。
- 验证：
  - `pnpm --filter @repo/api exec vitest run src/routers/settings.test.ts src/routers/modules.test.ts src/routers/invitation.test.ts`

## P2（可排期）

### P2-1 旧链路清理计划
- 目标：彻底移除未使用旧组件/Hook，减少维护噪音。
- 状态：`已完成`。
- 实施：
  - 已删除旧非流式 Hook：`apps/web/src/hooks/useAIChat.ts`
  - 已删除旧非流式聊天 UI：`apps/web/src/components/ai/*`、`apps/web/src/components/chat/ChatInterface.tsx`
  - 当前仓库只保留主链：`apps/web/src/app/chat/page.tsx` + `apps/web/src/hooks/useStreamingChat.ts` + `/api/ai/stream`
- 验收标准：
  - 旧聊天链路源码不再存在，后续无法误接回旧入口。
  - 全仓不存在 `useAIChat`、旧 `ChatInterface`、`components/ai` 的运行时代码引用。
- 验证：
  - 引用扫描：`rg -n "useAIChat|components/ai/|components/chat/ChatInterface|trpc\\.chat\\.sendMessage|ai\\.sendMessage\\.useMutation" apps/web/src packages/api/src`
  - 类型检查：`pnpm --dir apps/web exec tsc --noEmit`

### P2-2 CI 严格化
- 目标：去掉 CI 中 `|| true`，让失败真正阻断。
- 状态：`已完成`。
- 实施：
  - CI / Security workflow 已去掉关键检查中的 `|| true`。
  - GitHub Actions 默认权限已降到只读，`checkout` 已关闭持久凭据。
- 验收标准：
  - lint / typecheck / test 失败会真实阻断流水线。

### P2-3 负责人可视化周报
- 目标：每周输出稳定性报告（测试通过率、错误率、成本趋势、未闭环风险）。

### P2-4 运行时代码日志治理收口
- 目标：将 `apps/web/src` 与 `packages/api/src` 中散落的运行时 `console.error/warn/info` 收口到结构化日志或 dev-only 日志封装。
- 状态：`已完成`。
- 已完成范围：
  - API 路由与服务：统一到 `packages/api/src/lib/logger.ts`
  - Web 服务端入口：统一到 `apps/web/src/lib/server-log.ts`
  - Web 前端调试日志：统一到 `apps/web/src/lib/client-log.ts`
  - 历史脚本/工具例外：已收口到 `stdout/stderr` helper
- 验收标准：
  - `apps/web/src` 与 `packages/api/src` 不再存在业务代码层面的裸 `console.error/warn/info`
  - 剩余例外仅限日志封装文件本身、测试支撑文件与文档片段
- 验证：
  - 盘点文档：[`LOGGING_EXCEPTION_REVIEW.md`](./LOGGING_EXCEPTION_REVIEW.md)
  - 扫描命令：`rg -n "console\\.(error|warn|info)\\(" apps/web/src packages/api/src`
  - 回归：`pnpm --filter web exec tsc --noEmit`、`pnpm test:api`

## 本周建议执行清单（按顺序）
1. 完成 P0-1 外部密钥轮换并验证。
2. 如需更高发布把关，补跑隔离环境 destructive preflight。
3. 输出本周稳定性周报，收口 accepted risk 与外部待执行项。
