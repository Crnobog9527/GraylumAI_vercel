# 修复问题清单初稿

> 旧仓库：`graylumAi-backup@722dd2e0171474500e6a05d257d1a6550ac9cc43`
>
> 新站证据目录：`.audit-output/refactor-parity/20260307-192641/`

## [P1] 公开落地页存在 hydration mismatch

- 影响范围：公开访客入口 `/landing?domain=www`
- 复现步骤：
  1. 运行 `pnpm audit:parity`
  2. 打开 `critical-e2e` 日志或 Playwright 报告
  3. 访问 `/landing?domain=www`
- 旧版本期望（来自旧仓库）：旧版本没有公开落地页；访客入口不应出现阻塞性 hydration/runtime 问题，未登录用户会直接进入认证流程
- 新站实际：公开页虽然能看到 `登录` 和 `免费开始`，但控制台报出 React hydration mismatch，导致关键 E2E 判为失败
- 证据：`.audit-output/refactor-parity/20260307-192641/logs/critical-e2e.log`、`.audit-output/refactor-parity/20260307-192641/evidence/playwright/playwright-report/index.html`
- 建议归属：前端

## [P1] 缺少 E2E 测试账号，导致登录后首页、聊天、后台无法完成一致性取证

- 影响范围：`/`、`/profile`、`/chat`、`/admin`、`/admin/models`、`/admin/diagnostics`、`/admin/users`
- 复现步骤：
  1. 在未配置 `E2E_TEST_EMAIL`、`E2E_TEST_PASSWORD`、`E2E_ADMIN_EMAIL`、`E2E_ADMIN_PASSWORD` 的情况下运行 `pnpm audit:parity`
  2. 查看 `00-command-results.md` 和 `critical-e2e.log`
- 旧版本期望（来自旧仓库）：旧版本明确存在登录后首页、资料页、聊天页、后台首页、模型管理、用户管理等核心流程，首轮验收应覆盖这些入口
- 新站实际：相关 Playwright 用例全部被跳过，本轮只拿到了公开登录页和公开落地页证据
- 证据：`.audit-output/refactor-parity/20260307-192641/00-command-results.md`、`.audit-output/refactor-parity/20260307-192641/logs/critical-e2e.log`
- 建议归属：配置

## [P2] 登录入口策略与旧版本不一致，需要明确是否接受偏离

- 影响范围：访客首次进入网站的路径、登录/注册入口、首页定义
- 复现步骤：
  1. 查看旧仓库 `src/App.jsx`、`src/Layout.jsx`、`src/lib/AuthContext.jsx`
  2. 对照新站当前公开路由 `/landing?domain=www` 和 `/login`
- 旧版本期望（来自旧仓库）：旧版本没有站内公开首页和本地登录页；访客访问受保护页面会进入 Base44 托管登录流程
- 新站实际：新站提供公开落地页和站内 `/login` 登录页，访客链路与旧版明显不同
- 证据：`docs/refactor-parity/current-audit/legacy-repo-baseline.draft.md`、`apps/web/tests/e2e/auth.spec.ts`、`.audit-output/refactor-parity/20260307-192641/logs/critical-e2e.log`
- 建议归属：前端 / 认证 / 产品决策
