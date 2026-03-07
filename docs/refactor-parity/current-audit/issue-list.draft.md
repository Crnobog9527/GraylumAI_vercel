# 修复问题清单初稿

> 旧仓库：`graylumAi-backup@722dd2e0171474500e6a05d257d1a6550ac9cc43`
>
> 新站证据目录：`.audit-output/refactor-parity/20260307-195659/`

## [P0] 聊天主流程无法完成，流式回复被模型区域限制阻断

- 影响范围：已登录用户聊天发送链路 `/chat`
- 复现步骤：
  1. 运行 `pnpm audit:parity`
  2. 使用普通用户登录态打开 `/chat`
  3. 输入任意消息并点击 `发送`
- 旧版本期望（来自旧仓库）：用户在聊天页输入问题后，应能发送消息并收到模型回复
- 新站实际：浏览器控制台记录 `Streaming error: OpenAI-compatible API error: 403 - This model is not available in your region.`，导致发送链路未完成
- 证据：`.audit-output/refactor-parity/20260307-195659/evidence/playwright/test-results/artifacts/chat-AI-Chat-should-send-message-and-receive-stream-response-chromium/attachments/issue-report-md-fc5c0b7a689260654302e402bdae7ef6713965f7.md`
- 建议归属：后端 / 模型配置 / 区域策略

## [P1] 公开落地页存在 hydration mismatch

- 影响范围：公开访客入口 `/landing?domain=www`
- 复现步骤：
  1. 运行 `pnpm audit:parity`
  2. 打开 `critical-e2e` 日志或 Playwright 报告
  3. 访问 `/landing?domain=www`
- 旧版本期望（来自旧仓库）：旧版本没有公开落地页；访客入口不应出现阻塞性 hydration/runtime 问题，未登录用户会直接进入认证流程
- 新站实际：公开页虽然能看到 `登录` 和 `免费开始`，但控制台报出 React hydration mismatch，导致关键 E2E 判为失败
- 证据：`.audit-output/refactor-parity/20260307-195659/evidence/playwright/test-results/artifacts/auth-Authentication-should-display-landing-page-in-www-mode-chromium/attachments/issue-report-md-8480d9139b35c330e82fd35f8e6867d2afd2ce09.md`
- 建议归属：前端

## [P2] 流式中断测试把预期的请求终止误判为阻塞错误

- 影响范围：聊天停止按钮的自动化验收结果
- 复现步骤：
  1. 运行 `pnpm audit:parity`
  2. 使用普通用户登录态进入 `/chat`
  3. 发起长回复并点击 `停止`
- 旧版本期望（来自旧仓库）：聊天支持中断长回复，核心判定应基于是否出现停止控制和 `[已中断]` 标记
- 新站实际：自动化监控器把 `/api/ai/stream` 的 `net::ERR_ABORTED` 记为 P1，导致用例失败；从步骤看，业务上更像“成功中断后被监控误伤”
- 证据：`.audit-output/refactor-parity/20260307-195659/evidence/playwright/test-results/artifacts/chat-AI-Chat-should-expose-37dcc--during-long-running-stream-chromium/attachments/issue-report-md-2bd11c76d8eeeaa8ee70c90777c547c43bd81e68.md`
- 建议归属：测试 / E2E 监控规则

## [P2] 登录入口策略与旧版本不一致，需要明确是否接受偏离

- 影响范围：访客首次进入网站的路径、登录/注册入口、首页定义
- 复现步骤：
  1. 查看旧仓库 `src/App.jsx`、`src/Layout.jsx`、`src/lib/AuthContext.jsx`
  2. 对照新站当前公开路由 `/landing?domain=www` 和 `/login`
- 旧版本期望（来自旧仓库）：旧版本没有站内公开首页和本地登录页；访客访问受保护页面会进入 Base44 托管登录流程
- 新站实际：新站提供公开落地页和站内 `/login` 登录页，访客链路与旧版明显不同
- 证据：`docs/refactor-parity/current-audit/legacy-repo-baseline.draft.md`、`apps/web/tests/e2e/auth.spec.ts`、`.audit-output/refactor-parity/20260307-195659/logs/critical-e2e.log`
- 建议归属：前端 / 认证 / 产品决策
