# B02 工单权限与本人访问规则修复（2026-09-29）

**已实现 0143：恢复用户本人工单读、建、回复、关闭，补齐后台最小权限并回收客户端危险授权。**
本机正反向 SQL/PostgREST 与真实路由/服务验证通过；尚未应用 staging，不能声称线上已恢复。
Owner 在本会话批准按[总控建议](https://github.com/Crnobog9527/GraylumAI_vercel/pull/506#issuecomment-5886851995)
扩展 RLS 与最小权限范围，替代最初“只改 GRANT”的实现边界。合并和 staging 应用仍需分别批准。

## 基线与证据边界

- 代码基线：`11a04e747fa687403a0b264fe808cf7c1ab4c215`，开工时最新 `origin/staging`。
- 实现继续前已合入 staging `0643175960f4f7b2360ab5749a2caaebf69c646d`（含 #504/0142、#505）；政策与工单基线未变。
- 分支：`codex/b02-ticket-grants-20260929`；目标 staging；任务风险 **high**（数据库授权与 RLS）。
- 开工已核对 open PR 和本机工作区：#504 占用迁移 0142，修改模型相关路径，与工单路径无重叠。
  #497 的 Runtime/夹具、#505 的标点处理、#498 的只读报告均无本次文件重叠；没有修改共享主目录。
- 已读 AGENTS.md、docs/ENGINEERING.md、迁移约定、#504 的本机 PostgreSQL/PostgREST 夹具与回退方法。
- [总控发现](https://github.com/Crnobog9527/GraylumAI_vercel/pull/501#issuecomment-5886459820)、
  [C3 盘点](https://github.com/Crnobog9527/GraylumAI_vercel/pull/487) 是线索；当前权限来自本次只读目录核对。
- staging 快照：**2026-09-29 08:32:02 UTC**，继续实现前于 **08:51:37 UTC** 只读复核完全一致。官方 CLI 项目列表确认唯一 staging 目标；仅提交系统目录 SELECT，
  不读取业务行、工单正文、对象路径、账号资料或凭据值。原始目录与查询仅保留本机。
  连接执行身份为内置 postgres，transaction_read_only=off；安全边界是仅提交 SELECT，不声称使用数据库强制只读角色。
- Supabase 连接器未列出项目；新建临时 CLI 目录因缺少 IPv4 连接信息失败。
  改用已存在的 CLI 连接目录，先将其目标与实时项目列表比对，再执行目录 SELECT；未更新 CLI 或远端配置。
- 本次目录读取发现 public 只有 `tickets`、`ticket_replies` 两张工单相关表，无独立工单附件表。
  附件位于两表的 JSONB `attachments` 及共享 `storage.objects` / `storage.buckets`。

## 应用前权限与策略快照

下表的授权是 `has_table_privilege` 对角色计算的有效结果，包含继承；两张工单表的全部列 `attacl` 均为空。
两表 RLS=true、FORCE=false，没有非内部触发器。所有工单策略均为 permissive，角色 authenticated。

| 表 | anon | authenticated | service_role |
| --- | --- | --- | --- |
| tickets | MAINTAIN | MAINTAIN | SELECT、TRUNCATE、REFERENCES、TRIGGER、MAINTAIN |
| ticket_replies | TRUNCATE、REFERENCES、TRIGGER、MAINTAIN | 同左 | 同左 |

应用前仅存在以下 **3 条**工单 RLS 策略：

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
0143 已同时约束作者与管理员标记，并限制可插入列。

共享 Storage 两表均 RLS=true；anon/authenticated/service_role 均有
SELECT、INSERT、UPDATE、DELETE、TRUNCATE、REFERENCES、TRIGGER、MAINTAIN，目录未见其 RLS 策略。
客户端 Dxt 和 MAINTAIN 无工单业务用途，但它们是跨桶共享、Supabase 管理的表，不能当作独立工单表改动。
本次将其作为额外过授权发现报告；按总控及 Owner 确认的边界，不修改共享 Storage 权限，也未实测其 HTTP 可利用性。

## 全部调用路径（固定开工代码基线；缺权描述为修复前）

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

## 最小实现与最终边界

没有新增表、函数、RPC、触发器或框架。复用现有 JWT 客户端、adminProcedure、两张工单表和 RLS。
`packages/db/schema.ts:110`、`:125` 与目录列/类型/默认值相符；C3 的核心表缺失建表迁移问题未处理，
本次不是全量空库重放。0143 只追加在已合并的 0142 后，不修改历史迁移或 schema.ts。

`packages/db/migrations/0143_ticket_grants_and_own_rls.sql` 在一个事务中完成：

| 对象 | 最终客户端能力 / 规则 |
| --- | --- |
| tickets SELECT | authenticated 仅 id/user_id/title/description/category/priority/attachments/status/is_deleted/created_at/updated_at；本人且未删除 |
| tickets INSERT | 仅 user_id/title/description/category/attachments；WITH CHECK 本人、未删除、初始 status=open；状态走已有默认值 |
| tickets UPDATE | 仅 status；USING 本人且未删除，WITH CHECK 本人且未删除且 status=closed；不能重开或改他人/标题/作者/删除标记 |
| ticket_replies SELECT | 仅 id/ticket_id/user_id/content/is_admin/attachments/created_at；回复未删除且父工单属于本人、未删除；可以读客服回复 |
| ticket_replies INSERT | 仅 ticket_id/user_id/content；WITH CHECK 父工单本人且未删除、作者本人、is_admin=false、回复未删除；管理员标记走已有默认值 |
| anon / PUBLIC | 两工单表无任何授权；同步清除历史列级 SELECT/INSERT/UPDATE/REFERENCES，避免表级撤权后残留旁路 |
| authenticated 非业务权限 | 撤掉两表 TRUNCATE/REFERENCES/TRIGGER/MAINTAIN；不授 DELETE、不授内部时间戳/删除标记写入 |
| service_role | 新增 replies 表 SELECT、INSERT(ticket_id,user_id,content,is_admin)，tickets UPDATE(status,updated_at)；其他既有授权不变 |

- 删除历史管理员 authenticated SELECT/ALL 策略：后台已有 adminProcedure → service_role 路径，
  无需用户 JWT 直接越过本人行边界。最终只有五条 own 策略。
- 遇到未知工单策略或任一表未开 RLS，整笔迁移报错退出，不保留可能通过 OR 放行的未知策略。
  已知历史策略名被替换；重复应用收敛到同一策略/授权状态，不改变数据或表结构。
- `packages/api/src/routers/ticket.ts` 将两处嵌套 `*` 和两处插入后 `select()` 改成显式列；
  插入不再请求写 status/is_admin。关闭操作读取匹配 id，零行返回 NOT_FOUND，避免越权/不存在时误报成功。
- soft-deleted 工单与回复对用户不可见；未新增“关闭后不能回复”的产品限制，保留原有行为。
- Storage、profiles、scheduled_job_runs、账务、依赖、前端 UI、生产配置均未修改。
  管理员关联资料查询及 cron 任务记账的既有权限缺口不因工单迁移自动消失，需要按各自任务处理。

## 本机验证

入口：`node packages/db/tests/run-ticket-grants.mjs --local-only`。
复用原 B02 诊断夹具并扩展，固定本机镜像、Unix Docker socket、随机容器、127.0.0.1 REST；不加载 dotenv 或远端连接。
`ticket-grants-blocker-fixture.sql` 保留应用前真实工单列/默认值/ACL/三条策略；auth/profiles 为合成辅助表，
外键来自 schema.ts；所有测试账号及工单内容均为合成，未读取 staging 业务行。

- PASS：迁移前 SQL/HTTP 42501、基线 TRUNCATE 越过 RLS（事务回滚）、只加 GRANT 仍被 RLS 阻断。
- PASS：0143 后本人列表/嵌套回复/创建/回复/关闭成功；他人不可见、改他人零行且原值不变；匿名读/建/改/删全部拒绝。
- PASS：拒绝伪造作者、管理员回复、任意初始状态/优先级/时间戳、删除标记、重开工单、改回复正文；两表 TRUNCATE 拒绝。
- PASS：已删除回复/已删除父工单下的回复不可见，已删除工单不能新增回复或关闭。
- PASS：service_role 读回复、客服/系统回复写入、工单状态与更新时间更新；非必要标题/回复正文更新仍拒绝。
- PASS：迁移重复执行一致；未知策略触发事务回滚；历史 PUBLIC/anon/authenticated 列 ACL 清除。
- PASS：精确回退恢复原表/列 ACL 和原三条策略，RLS/数据保留；权限数组比较按语义排序，不依赖 ACL 项排列顺序。
- PASS：`packages/api/src/routers/ticketGrants.integration.ts` **2 项**，真实 Supabase 客户端 → 本机 PostgREST → PostgreSQL，
  执行实际用户路由、admin.getAllTickets/replyToTicket/updateTicketStatus、TicketAutoCloseService。
  用户关闭他人工单返回 NOT_FOUND，用户不能调用管理员路由，匿名 tRPC 拒绝，附件路径冒用拒绝。
  profiles 的本机辅助授权仅用于隔离工单测试；不能推断完整 staging 后台的其他依赖已修复。
- PASS：`pnpm test:api` **132 文件 / 2988 通过 / 3 既有跳过**，包含新增写入列与零行关闭回归。
- PASS：`pnpm --filter web typecheck`、`pnpm --filter web lint`、代码大小检查。
  lint 仍只有仓库现有的 web mjs 覆盖，不声称覆盖全部业务 TS/TSX。
- PENDING：最终候选必需 CI/Security，后续准确结果写入 PR Handoff。
- NOT_RUN：远端迁移、staging 登录账号/浏览器验收、Storage 上传签名全链路、完整 cron 调度、生产访问、独立机器人审查、合并。

## 精确回退与应用顺序

回退文件：[ticket-grants-rollback.sql](../../../packages/db/tests/ticket-grants-rollback.sql)。
它只适用于上面的 staging 应用前目录：清除新增客户端表/列权限、恢复 m/Dxtm，撤去 service_role 的本次新增能力，
删除新增 own 策略并恢复原三条策略；不删除迁移生效后创建的工单，也不恢复其他环境的未知历史权限。
**回退会重新引入客户端危险权限与工单不可用状态**，只作受控恢复手段，远端执行需要单独批准。
应用前必须保存当时的 ACL/策略并核对与本基线一致；有漂移先重新评估，不能盲用该回退。

先部署本 PR 的显式列/默认值兼容代码，再在 Owner 单独批准后应用 0143。
旧代码的通配符读取、显式写 status/is_admin 与列级最小授权不兼容；不允许只应用 SQL 而留旧代码。
部署兼容代码到尚未迁移的 staging 不会自行修复既有 42501。

## Handoff 与合并后计划

- Done：0143、精确回退、最小路由改动、全部调用盘点、本机 SQL/REST 及真实路由/服务正反向验证。
- Next：最终 CI/Security 通过后保持 draft 交总控重新审查；此前的阻断报告审查不等于本次实现审查。
- Blockers：无已知本机工单修复阻断；最终 CI 待完成，独立审查/合并/staging 应用均未获准或未执行。
- Remaining risk：工单相关表原始建表迁移仍缺失；不覆盖 profiles、任务记账、Storage 的独立缺权；未做远端运行时验收。
- 总控通过后才 ready 并评论 `@codex review`；P0/P1 或新 P2 先报告，不直接修改。
- 只有 Owner 说“允许合并#506”后才重新核对 head/CI/审查/讨论/合并性，以 squash + match-head-commit 合并。
- 合并后：另行批准 staging 迁移 → 确认兼容代码已部署 → 保存/核对应用前目录 → 应用 0143 → 读回权限与策略 →
  Codex 用 staging 测试账号验证 /profile?tab=tickets 的列表、新建、回复、关闭及 /admin/tickets 的回复/状态变更，
  同时验证他人/匿名/管理员标记拒绝。有其他依赖失败按实际结果报告，不记为全链路通过。
- 正式环境仍未授权；上线准备阶段另获批准后先只读核对生产目录。
