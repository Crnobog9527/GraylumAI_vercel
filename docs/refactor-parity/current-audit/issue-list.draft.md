# 修复问题清单初稿

> 旧仓库：`graylumAi-backup@722dd2e0171474500e6a05d257d1a6550ac9cc43`
>
> 新站证据目录：`.audit-output/refactor-parity/20260307-212219/`
>
> 2026-03-07 补充定向验证：
> `parity-extended 6/6`、`user-extended 7/7`、`admin-config 6/6`、`admin-ops 6/6`、`user-supplemental 6/6`
>
> 2026-03-08 危险操作补充验证：
> `admin-destructive 12/12`

## 当前状态

- 当前 `pnpm audit:parity:extended` 在线上预览环境中已完整通过，首轮关键回归 `15/15`、第二轮扩展回归 `6/6` 均已通过。
- 第三轮新增线上定向回归已通过：用户扩展 `7/7`、管理员配置 `6/6`、管理员业务 `6/6`。
- 第三轮用户补充回归已在最新线上预览环境中复测通过，结果为 `6/6`。
- 2026-03-09 已在最新预览 `https://graylum-ai-vercel-v1-4natgwj9o-simons-projects-bfe3e99f.vercel.app` 上补齐管理员工单处理闭环定向验证，结果 `1/1` 通过。
- 2026-03-08 对最新预览 `https://graylum-ai-vercel-v1-cnpxb452f-simons-projects-bfe3e99f.vercel.app` 的直连复测结果为：`critical 18/18`、`parity-extended 6/6`、`user-extended 7/7`。
- 2026-03-09 对最新预览 `https://graylum-ai-vercel-v1-d7i5kvk9w-simons-projects-bfe3e99f.vercel.app` 的危险操作回归结果为：`admin-destructive 12/12`。
- 旧的“本地地域限制导致聊天 403”结论已废弃，因为它不符合当前规定的验收方法。
- 当前没有新的线上主路径阻塞 bug，但新发现了一个旧版能力回归缺口：工单 `48` 小时自动关闭逻辑在新仓库中缺失。

## 已修复记录：0 积分发送前拦截

- 影响范围：聊天发送前拦截、低余额/空余额用户体验、无效 402 请求
- 复现步骤：
  1. 用管理员把 E2E 用户积分调整到 `0`
  2. 用该用户打开 `/chat`
  3. 确认页头已经显示 `0 积分 / 已用完`
  4. 输入任意消息并点击 `发送`
- 旧版本期望（来自旧仓库）：积分体系存在发送前提示/限制逻辑，空余额时应先阻止用户继续发送
- 修复前实际：会直接命中 `/api/ai/stream`，随后返回 `402` 和 `Streaming error: 积分不足`
- 修复后实际：最新预览 `https://graylum-ai-vercel-v1-4bnf8wxv9-simons-projects-bfe3e99f.vercel.app` 已验证在发送前弹出充值拦截弹窗，且 `user-supplemental` 全部通过
- 证据：`pnpm --dir apps/web test:e2e:user-supplemental` 直连最新 Vercel Preview 结果 `6/6`
- 建议归属：前端 / 测试

## 已确认规则

- `graylum.com` 和 `www.graylum.com` 都应进入新版本公开落地页。
- 用户登录后使用 `app.graylum.com` 进入应用后台。
- 未登录用户如果直接访问 `app.graylum.com` 下的后台页面，应被重定向到登录/注册页。
- 这属于已确认产品规则，不再作为“需修复差异”跟踪。

## [P1] 旧版工单“管理员首次回复后 48 小时无用户回复自动关闭”逻辑在新仓库中缺失

- 影响范围：工单生命周期、客服 SLA、工单列表堆积、用户超时提醒
- 复现步骤：
  1. 查看旧仓库 `.audit-output/legacy-repos/graylumAi-backup/functions/autoCloseTickets.ts`
  2. 确认旧版会在后台首次回复后开始计时，若 48 小时内用户没有再回复，则自动关闭工单并写入系统消息
  3. 在新仓库搜索 `packages/api`、`apps/web/src/app/api/cron`、`scripts` 中与 ticket auto-close 对应的逻辑
  4. 结果仅找到手动 `closeTicket`、管理员 `updateTicketStatus/replyToTicket` 和诊断 cron，没有找到等价定时任务或后台服务
- 旧版本期望（来自旧仓库）：`autoCloseTickets` 定时任务会自动关闭超时工单，并追加“因超过 48 小时无用户回复已自动关闭”的系统消息
- 新站实际：当前仅支持用户或管理员手动关闭工单，没有发现自动关闭实现，因而这条旧版规则目前无法生效
- 证据：`.audit-output/legacy-repos/graylumAi-backup/functions/autoCloseTickets.ts`、`packages/api/src/routers/ticket.ts`、`packages/api/src/routers/admin.ts`、`apps/web/src/app/api/cron/diagnostics/route.ts`
- 建议归属：后端 / 定时任务

## [P2] 危险操作套件已可在线执行，但仍按设计保持独立闸门，不纳入日常回归

- 影响范围：聊天批量删除、历史清理、后台不可逆删除、批量发布/下线、清理任务
- 复现步骤：
  1. 执行 `pnpm audit:parity:destructive`
  2. 使用专门的测试账号和测试对象
  3. 对每个动作执行“创建/定位 -> 执行 -> 验证 -> 回滚/清理”
- 旧版本期望（来自旧仓库）：旧版后台和聊天存在这类危险能力入口
- 新站实际：当前已提供独立 `admin-destructive` 套件入口；在显式设置 `ENABLE_PARITY_DESTRUCTIVE_E2E=true` 时，已完成 `admin/settings` 对话历史清理、`admin/diagnostics` 旧记录清理、模型停用/恢复回滚、横幅公告发布/下线/恢复/删除回滚、积分包发布/下架/恢复/删除回滚、会员计划禁用/恢复回滚、用户角色权限回滚、用户状态权限回滚，以及系统提示词运行时联动回滚的线上取证，但仍不会默认并入日常回归
- 证据：`apps/web/tests/e2e/admin-destructive.spec.ts`、`docs/REFACTOR_PARITY_AUDIT_WORKFLOW.md`
- 建议归属：测试 / 前端 / 后端 / 运营
