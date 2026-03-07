# 修复问题清单初稿

> 旧仓库：`graylumAi-backup@722dd2e0171474500e6a05d257d1a6550ac9cc43`
>
> 新站证据目录：`.audit-output/refactor-parity/20260307-210449/`

## 当前状态

- 当前 `pnpm audit:parity` 在线上预览环境中已完整通过，首轮核心回归包没有留下可稳定复现的 `P0/P1` 主流程故障。
- 旧的“本地地域限制导致聊天 403”结论已废弃，因为它不符合当前规定的验收方法。
- 本清单保留的内容改为“需要确认的结构差异”和“下一轮要补测的能力”，而不是线上阻塞 bug。

## [P2] 登录入口策略与旧版本不一致，需要明确是否接受偏离

- 影响范围：访客首次进入网站的路径、登录/注册入口、首页定义
- 复现步骤：
  1. 查看旧仓库 `src/App.jsx`、`src/Layout.jsx`、`src/lib/AuthContext.jsx`
  2. 运行 `pnpm audit:parity`
  3. 对照新站当前公开路由 `/landing?domain=www` 和 `/login`
- 旧版本期望（来自旧仓库）：旧版本没有站内公开首页和本地登录页；访客访问受保护页面会进入 Base44 托管登录流程
- 新站实际：新站提供公开落地页和站内 `/login` 登录页，访客链路与旧版明显不同
- 证据：`docs/refactor-parity/current-audit/legacy-repo-baseline.draft.md`、`apps/web/tests/e2e/auth.spec.ts`、`.audit-output/refactor-parity/20260307-210449/logs/critical-e2e.log`
- 建议归属：前端 / 认证 / 产品决策

## [P2] 后台深层管理能力仍缺少首轮一致性证据

- 影响范围：模型测试连接、用户积分调整、会话导出/重命名/批量管理
- 复现步骤：
  1. 运行 `pnpm audit:parity`
  2. 查看 `function-comparison-matrix.draft.md` 中所有“待判断 / 部分一致”项
  3. 对照旧仓库对应页面与新站线上预览，补充人工用例或新增 E2E
- 旧版本期望（来自旧仓库）：这些能力在旧版后台和聊天管理界面中存在可见入口和操作流
- 新站实际：当前首轮自动化只覆盖了主路径可打开与核心表格/输入壳层，尚未覆盖全部细颗粒度行为
- 证据：`docs/refactor-parity/current-audit/function-comparison-matrix.draft.md`、`.audit-output/refactor-parity/20260307-210449/00-command-results.md`
- 建议归属：测试 / 前端 / 后端
