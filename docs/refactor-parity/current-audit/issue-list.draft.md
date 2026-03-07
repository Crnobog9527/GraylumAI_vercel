# 修复问题清单初稿

> 旧仓库：`graylumAi-backup@722dd2e0171474500e6a05d257d1a6550ac9cc43`
>
> 新站证据目录：`.audit-output/refactor-parity/20260307-212219/`
>
> 2026-03-07 补充定向验证：
> `parity-extended 6/6`、`user-extended 6/6`、`admin-config 6/6`、`admin-ops 5/5`

## 当前状态

- 当前 `pnpm audit:parity:extended` 在线上预览环境中已完整通过，首轮关键回归 `15/15`、第二轮扩展回归 `6/6` 均已通过。
- 第三轮新增线上定向回归已通过：用户扩展 `6/6`、管理员配置 `6/6`、管理员业务 `5/5`。
- 旧的“本地地域限制导致聊天 403”结论已废弃，因为它不符合当前规定的验收方法。
- 当前没有新的线上阻塞 bug 留在清单中；本清单保留的内容改为“仍未覆盖的细颗粒度能力”和“刻意隔离的危险操作”。

## 已确认规则

- `graylum.com` 和 `www.graylum.com` 都应进入新版本公开落地页。
- 用户登录后使用 `app.graylum.com` 进入应用后台。
- 未登录用户如果直接访问 `app.graylum.com` 下的后台页面，应被重定向到登录/注册页。
- 这属于已确认产品规则，不再作为“需修复差异”跟踪。

## [P2] 聊天异常失败态与账户边角能力仍缺少一致性证据

- 影响范围：聊天失败态、余额不足提示、刷新恢复、账户安全、注册重定向、Marketplace
- 复现步骤：
  1. 运行 `pnpm audit:parity:round1`
  2. 查看 `function-comparison-matrix.draft.md` 中所有“待判断 / 部分一致”项
  3. 对照旧仓库对应页面与新站线上预览，补充人工用例或新增 E2E
- 旧版本期望（来自旧仓库）：聊天和账户体系应具备异常反馈、恢复、入口跳转和辅助页面能力
- 新站实际：当前已覆盖删除、导出可用性、模型切换、资料页高价值标签和工单闭环，但聊天失败态、账户安全、注册回流、Marketplace 仍未自动化取证
- 证据：`docs/refactor-parity/current-audit/function-comparison-matrix.draft.md`
- 建议归属：测试 / 前端 / 后端

## [P2] 危险操作套件已建好入口，但按设计保持独立闸门，不纳入日常回归

- 影响范围：聊天批量删除、历史清理、后台不可逆删除、批量发布/下线、清理任务
- 复现步骤：
  1. 执行 `pnpm audit:parity:destructive`
  2. 使用专门的测试账号和测试对象
  3. 对每个动作执行“创建/定位 -> 执行 -> 验证 -> 回滚/清理”
- 旧版本期望（来自旧仓库）：旧版后台和聊天存在这类危险能力入口
- 新站实际：当前已提供独立 `admin-destructive` 套件入口，但默认只做闸门校验，不自动执行真实破坏性动作
- 证据：`apps/web/tests/e2e/admin-destructive.spec.ts`、`docs/REFACTOR_PARITY_AUDIT_WORKFLOW.md`
- 建议归属：测试 / 前端 / 后端 / 运营
