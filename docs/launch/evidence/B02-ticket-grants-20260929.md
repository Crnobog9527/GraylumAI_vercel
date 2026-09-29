# B02 工单权限盘点与阻断（2026-09-29）

**BLOCKED：当前 staging 缺少普通用户 own-row RLS，不能按“只改授权、不改 RLS”的边界完成修复。**
本报告不代表修复完成。没有新增迁移、业务代码改动，未执行远端业务或授权写 SQL。

## 基线与证据边界

- 代码基线：`11a04e747fa687403a0b264fe808cf7c1ab4c215`，开工时最新 `origin/staging`。
- 分支：`codex/b02-ticket-grants-20260929`；目标 staging；任务风险 **high**（数据库授权与 RLS）。
- 开工已核对 open PR 和本机工作区：#504 占用迁移 0142，修改模型相关路径，与工单路径无重叠。
  #497 的 Runtime/夹具、#505 的标点处理、#498 的只读报告均无本次文件重叠；没有修改共享主目录。
- 已读 AGENTS.md、docs/ENGINEERING.md、迁移约定、#504 的本机 PostgreSQL/PostgREST 夹具与回退方法。
- [总控发现](https://github.com/Crnobog9527/GraylumAI_vercel/pull/501#issuecomment-5886459820)、
  [C3 盘点](https://github.com/Crnobog9527/GraylumAI_vercel/pull/487) 是线索；当前权限来自本次只读目录核对。
- staging 快照：**2026-09-29 08:32:02 UTC**。官方 CLI 项目列表确认唯一 staging 目标；仅提交系统目录 SELECT，
  不读取业务行、工单正文、对象路径、账号资料或凭据值。原始目录与查询仅保留本机。
  连接执行身份为内置 postgres，transaction_read_only=off；安全边界是仅提交 SELECT，不声称使用数据库强制只读角色。
- Supabase 连接器未列出项目；新建临时 CLI 目录因缺少 IPv4 连接信息失败。
  改用已存在的 CLI 连接目录，先将其目标与实时项目列表比对，再执行目录 SELECT；未更新 CLI 或远端配置。
- 本次目录读取发现 public 只有 `tickets`、`ticket_replies` 两张工单相关表，无独立工单附件表。
  附件位于两表的 JSONB `attachments` 及共享 `storage.objects` / `storage.buckets`。

## 当前有效授权与策略

下表的授权是 `has_table_privilege` 对角色计算的有效结果，包含继承；两张工单表的全部列 `attacl` 均为空。
两表 RLS=true、FORCE=false，没有非内部触发器。所有工单策略均为 permissive，角色 authenticated。

| 表 | anon | authenticated | service_role |
| --- | --- | --- | --- |
| tickets | MAINTAIN | MAINTAIN | SELECT、TRUNCATE、REFERENCES、TRIGGER、MAINTAIN |
| ticket_replies | TRUNCATE、REFERENCES、TRIGGER、MAINTAIN | 同左 | 同左 |

仅存在以下 **3 条**工单 RLS 策略：

| 表 / 策略 | 操作 | 精确逻辑（仅规范空白） |
| --- | --- | --- |
| tickets / tickets_select_admin | SELECT | EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'admin' AND p.status = 'active') |
| ticket_replies / ticket_replies_select_admin | SELECT | EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'admin' AND p.status = 'active') |
| ticket_replies / ticket_replies_insert_own | INSERT | EXISTS (SELECT 1 FROM tickets t WHERE t.id = ticket_replies.ticket_id AND t.user_id = auth.uid()) |

缺失：`tickets_select_own`、`tickets_insert_own`、`tickets_update_own`、`ticket_replies_select_own`。
仓库 `0002_enable_rls_all_tables.sql:171` 至 `:221` 中的历史策略不等于已存在于 staging。
没有普通用户适用的工单 SELECT / INSERT / UPDATE 策略，GRANT 不会补出这些策略。
回复 INSERT 还依赖可见的父工单；当前普通用户无法看到父工单。
现有回复 INSERT 只核对父工单归属，没有核对回复 `user_id=auth.uid()` 或 `is_admin='false'`；
未来修复必须同时处理作者及管理员标记约束，不能直接照搬宽泛 INSERT 授权。

共享 Storage 两表均 RLS=true；anon/authenticated/service_role 均有
SELECT、INSERT、UPDATE、DELETE、TRUNCATE、REFERENCES、TRIGGER、MAINTAIN，目录未见其 RLS 策略。
客户端 Dxt 和 MAINTAIN 无工单业务用途，但它们是跨桶共享、Supabase 管理的表，不能当作独立工单表改动。
本次将其作为额外过授权发现报告；不在阻断状态下改变全站 Storage 权限，也未实测 Storage HTTP 可利用性。

## 全部调用路径

U = protectedProcedure 的用户 JWT 客户端；S = service_role；adminProcedure 经角色检查后将 ctx.supabase 换成 S
（`packages/api/src/trpc.ts:460`、`:493`、`:511`）。S 的 BYPASSRLS 不代替 SQL 授权。

| 路径 | 身份 / 操作 | 依赖的 RLS / 当前结论 |
| --- | --- | --- |
| `packages/api/src/routers/ticket.ts:88` getTicketsForProfile / getTickets | U；读本人未删除 tickets，嵌套读 ticket_replies，按创建时间排序 | 需要 tickets_select_own + ticket_replies_select_own，均缺失；现有管理员读策略不放行普通用户 |
| `packages/api/src/routers/ticket.ts:163` getTicketById | U；按 id + user_id 读工单及回复 | 同上；应用 WHERE 不能替代直接数据库入口的 RLS |
| `packages/api/src/routers/ticket.ts:115` createTicket | U；插入 user_id/title/description/category/status/attachments，返回整行 | 需要 tickets_insert_own 和返回行 SELECT，均缺失 |
| `packages/api/src/routers/ticket.ts:185` replyToTicket | U；读父工单 id，插入 ticket_id/user_id/content/is_admin，返回整行后映射 | 已有 ticket_replies_insert_own，但缺父工单及回复 own SELECT；作者与管理员标记还须约束 |
| `packages/api/src/routers/ticket.ts:223` closeTicket | U；UPDATE status='closed'，WHERE id + user_id | 需要 own UPDATE + SELECT，均缺失；没有 DELETE 需求 |
| `packages/api/src/routers/admin.ts:386`、`:1149`、`:2930` | S；仪表盘、用户详情及分析读取 tickets 状态/id | BYPASSRLS，仍需 SELECT；tickets 已有 SELECT |
| `packages/api/src/routers/admin.ts:709` getAllTickets | S；两次读 tickets、读 ticket_replies、读关联 profiles 并签名附件 | BYPASSRLS；回复 SELECT 当前缺失；profiles 权限问题不在本任务修复范围 |
| `packages/api/src/routers/admin.ts:854` updateTicketStatus | S；更新 status/updated_at 并返回整行 | BYPASSRLS；tickets UPDATE 当前缺失 |
| `packages/api/src/routers/admin.ts:880` replyToTicket | S；插入 ticket_id/user_id/content/is_admin='true' 并返回，更新工单 updated_at | BYPASSRLS；回复 INSERT/SELECT 及工单 UPDATE 当前缺失 |
| `packages/api/src/services/ticketAutoClose.ts:109`、`:130`、`:150`、`:162` | S；读未删除工单和回复，更新 status/updated_at，插入系统回复 | BYPASSRLS；同上缺权。由 `apps/web/src/app/api/cron/tickets/auto-close/route.ts:42` 创建 S 客户端；任务记录另依赖 scheduled_job_runs，不属于独立工单表 |
| `packages/db/migrations/0010_ticket_auto_close_supabase_cron.sql:15` auto_close_stale_tickets | 数据库 SECURITY DEFINER；读两表、更新工单、插入系统回复，历史 pg_cron 调度 | 按函数执行身份，而非用户 own 策略；这里只记录仓库定义，未调用 RPC 或核实 cron 运行状态 |
| `apps/web/src/app/api/upload/route.ts:42`、`:98`、`:111`、`:130` | 验证用户身份后以 S 上传 Storage 对象；首次缺桶时创建 private 桶 | S/Storage 服务路径，非 U 直接表写；读取 system_settings 和维护状态下 profiles 为前置检查；本轮未上传、未建桶 |
| `packages/api/src/lib/ticketAttachments.ts:71`、`:89` | S；按允许的拥有者路径生成签名 URL | 前置归属筛选后调用 Storage；不需要给 U 增加 storage 表权限；没有独立附件删除路径 |
| `apps/web/src/components/profile/TicketsPanel.tsx` | UI 通过 ticket 路由列举、新建、回复、关闭；上传经 /api/upload | 间接使用上面的 U/S 路径，无直接 tickets 表客户端 |
| `apps/web/src/components/opc/workspace-frame.tsx:90` | 工作区反馈调用 ticket.createTicket，跳转 /profile?tab=tickets | 间接 U 创建，无独立表写入 |
| `apps/web/src/app/admin/tickets/page.tsx:152`、`:158`、`:168` | UI 调用 admin.getAllTickets/updateTicketStatus/replyToTicket | 间接 S；管理员身份并不改变数据库 service_role 的缺权事实 |

检索覆盖 `packages/api/src`、`apps/web/src`、全部迁移及 C3 数据附表，排除测试夹具；
没有发现业务代码直接 DELETE 工单/回复或附件，也没有独立的工单软删除接口。
FK 中的 ON DELETE 行为属于结构关系，不是额外客户端 DELETE 需求。

## schema.ts 对照及最小能力（建议，未实施）

`packages/db/schema.ts:110`、`:125` 与本次目录的两表列集合、类型和默认值一致；
C3 已确认这两表只有 schema.ts 建表声明，不能声称从空库完整迁移重放通过。
生产结构仍以迁移为权威，schema.ts 仅用于本次对照，不执行 db:push。

- U 工单读取：id/user_id/title/description/category/priority/attachments/status/is_deleted/created_at/updated_at。
  回复读取：id/ticket_id/user_id/content/is_admin/attachments/created_at；如补未删除筛选则还需要 is_deleted。
- U 工单创建：user_id/title/description/category/attachments；status 可沿用 open 默认，避免授用户任意初始状态写入。
- U 回复创建：ticket_id/user_id/content；is_admin 应用 false 默认并保持该列不可写，避免用户冒充管理员。
  还必须约束回复作者；不能仅检查父工单归属。
- U 关闭：现代码需要 UPDATE(status)，但列权限本身无法限定只能写 closed；与 own-row RLS 一并明确最小安全行为。
- 不需要向 U 授 id、时间戳、删除标记或管理员标记写入，不需要 DELETE、TRUNCATE、REFERENCES、TRIGGER、MAINTAIN。
- 用户路由的 `select('*')`、嵌套 `ticket_replies(*)`、插入后无参数 `.select()`
  若采用列级读取授权，必须同步改为必要列投影；尚未改动，避免提交缺少 RLS 前提的半成品。
- S 最小业务缺口：ticket_replies SELECT/INSERT、tickets UPDATE(status,updated_at)。
  当前禁止改 S，因此“后台可用”不能标 PASS；最多能证明本次没有改变既有状态。
- `ticket_replies` 客户端 Dxt 应撤销；两工单表 MAINTAIN 也无客户端业务用途。
  共享 Storage 的类似授权另行评估，不与工单恢复混在一起。

## 变更、验证与回退

本候选仅新增盘点与本机诊断夹具，不新增迁移，不改结构、数据、RLS、service_role、前端、依赖或生产配置。
0142 由 #504 使用；后续获准实施时必须重新核对最大编号，**当前不占用 0143**。

- PASS：staging 系统目录只读核对、调用路径与 schema.ts 对照、writer/编号核对。
- PASS：`node packages/db/tests/run-ticket-grants-blocker.mjs --local-only`，使用仓库固定镜像和合成数据。
  初次运行因 Docker internal 网络没有发布 REST 端口失败；改为 #504 的独立 bridge + 127.0.0.1 端口方式后通过，所有容器已清理。
  基线 SQL/HTTP 42501；基线客户端 TRUNCATE 可执行（事务回滚）；仅加授权后本人和他人均不可见、建单/回复 42501、关闭匹配零行。
  匿名拒绝、撤权后的 TRUNCATE 拒绝、管理员 JWT 读取可见、service_role 既有失败、试验重复执行、精确恢复 ACL/列授权/RLS/数据均通过。
  **这是阻断证据通过，不是功能修复通过；“他人不可见”不能掩盖“本人也不可见”。**
- PASS：`pnpm test:api`，130 文件 / 2973 项通过；3 项既有跳过，未记为通过。
- PASS：`pnpm --filter web typecheck`、`pnpm --filter web lint`、`node scripts/check-code-size.mjs`。
  lint 的现有覆盖限于 web 的 4 个 mjs 文件，不等于 TS/TSX 全量静态审查。
- PENDING：最终 head 的远端 CI/Security；以 PR Handoff 的实时结果为准。
- BLOCKED：迁移实施及“修复后本人读/建/回复/关闭成功”，原因是缺失 RLS 且 Owner 明确禁止本轮修改策略。
- NOT_RUN：staging 业务账号测试、任何远端迁移、生产访问、独立机器人审查及合并。

**回退 SQL：不适用。** 当前没有迁移或远端写入；不存在需要撤回的授权差异。
本机诊断试验在一次性 Docker 数据库内进行并销毁；不能把试验 SQL 当部署迁移。
`packages/db/tests/ticket-grants-blocker-fixture.sql` 复刻本次工单列/默认值/ACL/三条策略，
profiles 与 auth 是最小测试替身，外键来自 schema.ts；不是完整 staging 或全迁移重放。
`packages/db/tests/run-ticket-grants-blocker.mjs` 不接收远端地址，不加载 dotenv，仅使用本机 Docker Unix socket、
随机命名容器、127.0.0.1 REST；探测 SQL 故意授完整 SELECT 以排除列投影因素，不能用于部署。
其 `undoProbe` 只对应这个合成基线，测试已核对试验前后权限、策略和行数据完全一致；
并未新增工单 RLS，未为获得绿灯伪造缺失的 own 策略。
后续若扩展范围，必须随正式迁移交付与应用前快照对应的精确回退，明确恢复危险权限的风险。

## 后续决策与合并后计划

建议扩展 B02：仅为工单恢复本人读/建/回复/关闭的 RLS 边界，并补后台工单必需的 service_role 最小权限；
不修改全局 Storage 权限，不处理无关 profiles、任务调度或其他功能缺权。
这需要 Owner 另行授权，因为原任务明确禁止修改 RLS/service_role。
在批准前，本 PR 保持阻断报告，不 ready，不触发机器人审查，不合并。

获准实现后：本机正反向、管理员及回退验证 → CI → 总控 → ready + `@codex review`；
机器人有 P0/P1 或新 P2 先报告，不直接修改。只有 Owner 发出“允许合并#506”后才执行受 head 保护的 squash。
未来合并也不等于应用数据库迁移：先取得单独 staging 应用批准，核对实时目录及精确迁移后再应用；
随后 Codex 使用 staging 测试账号验证工单列表、新建、回复、关闭及管理员回复/状态变更，并验证他人/匿名拒绝。
应用前后都检查权限与数据边界。生产不在本任务授权内。

## Handoff

- Done：完整代码/权限/RLS 盘点，确认授权-only 方案前提不成立；停止迁移实施。
- Next：本机阻断证据与指定检查已完成；等最终 CI 完成后保持 draft 交总控，等待 Owner 决定是否扩展 RLS/service_role 范围。
- Blockers：缺 own-row RLS、service_role 既有缺权；不得以新增 GRANT 或跳过 RLS 测试掩盖。
- Validation：只读目录、静态核对、本机 SQL/REST 阻断复现及指定检查 PASS；3 项 API SKIP；远端最终 CI 待完成；不视作修复验收通过。
