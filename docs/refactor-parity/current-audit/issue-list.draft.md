# 修复问题清单初稿

> 旧仓库：`graylumAi-backup@722dd2e0171474500e6a05d257d1a6550ac9cc43`
>
> 新站证据目录：`.audit-output/refactor-parity/20260307-212219/`

## 当前状态

- 当前 `pnpm audit:parity:extended` 在线上预览环境中已完整通过，首轮关键回归 `15/15`、第二轮扩展回归 `6/6` 均已通过。
- 旧的“本地地域限制导致聊天 403”结论已废弃，因为它不符合当前规定的验收方法。
- 本清单保留的内容改为“需要确认的结构差异”和“仍未覆盖的细颗粒度能力”，而不是线上阻塞 bug。

## [P2] 登录入口策略与旧版本不一致，需要明确是否接受偏离

- 影响范围：访客首次进入网站的路径、登录/注册入口、首页定义
- 复现步骤：
  1. 查看旧仓库 `src/App.jsx`、`src/Layout.jsx`、`src/lib/AuthContext.jsx`
  2. 运行 `pnpm audit:parity:extended`
  3. 对照新站当前公开路由 `/landing?domain=www` 和 `/login`
- 旧版本期望（来自旧仓库）：旧版本没有站内公开首页和本地登录页；访客访问受保护页面会进入 Base44 托管登录流程
- 新站实际：新站提供公开落地页和站内 `/login` 登录页，访客链路与旧版明显不同
- 证据：`docs/refactor-parity/current-audit/legacy-repo-baseline.draft.md`、`apps/web/tests/e2e/auth.spec.ts`、`.audit-output/refactor-parity/20260307-212219/logs/critical-e2e.log`
- 建议归属：前端 / 认证 / 产品决策

## [P2] 会话批量管理与深层边角能力仍缺少一致性证据

- 影响范围：批量导出、批量管理、删除等尚未覆盖的会话管理能力
- 复现步骤：
  1. 运行 `pnpm audit:parity:extended`
  2. 查看 `function-comparison-matrix.draft.md` 中所有“待判断 / 部分一致”项
  3. 对照旧仓库对应页面与新站线上预览，补充人工用例或新增 E2E
- 旧版本期望（来自旧仓库）：这些会话管理能力在旧版聊天界面中存在可见入口和操作流
- 新站实际：当前第二轮已覆盖重命名、导出、模型测试连接、积分调整，但批量导出、批量管理、删除等行为仍未自动化取证
- 证据：`docs/refactor-parity/current-audit/function-comparison-matrix.draft.md`、`.audit-output/refactor-parity/20260307-212219/00-command-results.md`
- 建议归属：测试 / 前端 / 后端
