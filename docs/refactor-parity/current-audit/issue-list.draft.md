# 修复问题清单初稿

> 旧仓库：`graylumAi-backup@722dd2e0171474500e6a05d257d1a6550ac9cc43`
>
> 新站证据目录：`.audit-output/refactor-parity/20260307-212219/`

## 当前状态

- 当前 `pnpm audit:parity:extended` 在线上预览环境中已完整通过，首轮关键回归 `15/15`、第二轮扩展回归 `6/6` 均已通过。
- 旧的“本地地域限制导致聊天 403”结论已废弃，因为它不符合当前规定的验收方法。
- 本清单保留的内容改为“需要确认的结构差异”和“仍未覆盖的细颗粒度能力”，而不是线上阻塞 bug。

## 已确认规则

- `graylum.com` 和 `www.graylum.com` 都应进入新版本公开落地页。
- 用户登录后使用 `app.graylum.com` 进入应用后台。
- 未登录用户如果直接访问 `app.graylum.com` 下的后台页面，应被重定向到登录/注册页。
- 这属于已确认产品规则，不再作为“需修复差异”跟踪。

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
