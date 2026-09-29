# S1 staging 数据库权限普查（2026-09-29）

## 结论摘要

**最急的是模型密钥列：普通登录角色具有读取 `ai_models.api_key` 的权限，RLS 也允许读取启用模型的行。应另立紧急修复任务。** 本轮没有读取密钥值、业务数据或行数，也没有证明实际泄露事件、密钥是否非空或是否仍有效。

此外，个人资料保存、公告、工单、后台用户管理等有明确的代码与权限不匹配；部分错误被代码转为空列表或默认值，用户可能只觉得功能没有生效。另有六表的客户端 TRUNCATE 等过授权、27 表的客户端 MAINTAIN 权限，建议另行收紧；本轮未验证网页可利用性。

本报告按相同用户影响合并计数：**A 类 15 项、B 类 3 项、C 类 4 项**。A 包含条件性路径，逐项标明；不等于已在网站重现 15 个故障。C 类及已修复/预期限制见后文。发现严重性与本次变更风险分开：**本 PR 风险为普通（ordinary）**，仅新增本报告，没有改库、改代码、改权限或配置。所有修法仅为建议。

- 固定代码与迁移基线：`f3b7d6d08bfbe5d9f120e8e89a5432bb8b462522`，开工时最新 `origin/staging`。所有 `file:line` 均相对此提交。
- 写报告期间 staging 前进到 `44f54bde981bf67bb634f2e8e37c8dc456bc4148`（#485）。AGENTS.md/ENGINEERING.md 未变；本文保持开工固定基线与快照时间，不混用新旧行号。#485 已退役旧会话清理，A-09 的会话清理部分属于基线历史路径，不能据此恢复该功能；工单/作业其他路径的缺权仍记录。未重复查询业务数据或宣称后续版本全部实测。
- 主目录快照：2026-09-29 **07:01:17 UTC**（北京时间 15:01:17）；MAINTAIN 为随后独立 SELECT 补查，非跨查询一致性事务。
- 范围：staging 的 public，**91 张表、0 个视图/物化视图、54 条 RLS 策略、244 个普通函数，其中 184 个 SECURITY DEFINER**。这些是目录对象数，不是业务行数。
- 全部 91 表 RLS=true、FORCE RLS=false；这些开关不能代替有效授权、策略内容和函数身份检查。
- 已阅读本基线 AGENTS.md、docs/ENGINEERING.md、C3-db-inventory-20260929.md 与 C3-user-data-20260929.md。C3 的静态发现及 PR #489/#493 历史诊断仅作线索，本报告实际权限取自本次目录。
- [PR #498](https://github.com/Crnobog9527/GraylumAI_vercel/pull/498) 在全面盘点结束前已提前写入 B-01 并告知 Owner。没有实施修复。

## 判断口径

`U`=protectedProcedure 用户客户端 authenticated；`P`=publicProcedure 的公开客户端 anon；`S`=service_role（含 adminProcedure 的 ctx.supabase）；`B`=浏览器客户端，登录时 authenticated、未登录时 anon。PG 的 authenticated 不等于产品管理员，管理员也是该角色配合 profiles.role 判断。

`R/I/U/D`=SELECT/INSERT/UPDATE/DELETE；`-`=没有该表级权限，**不排除列级授权或受控 RPC**。列没有 DELETE 权限，DELETE 只查表级；列逐项检查 SELECT/INSERT/UPDATE。过滤、排序、关联与返回列也须有相应读取权限。

客户端解析依据：`packages/api/src/trpc.ts:54`、`:68`、`:94`、`:479`、`:511`；公开 helper 位于 `packages/api/src/routers/settings.ts:119`、`packages/api/src/routers/modules.ts:86`。`apps/web/src/lib/supabase.ts:4` 创建浏览器客户端。诊断特例 `packages/api/src/routers/diagnostics.ts:158` 显式传用户客户端，不能因为在后台就当成 service role。

SQL 有效列权限包含整表授权与角色继承。RLS 的 permissive 策略作 OR，restrictive 策略作 AND；没有适用策略时拒绝。service_role 在本次目录中 BYPASSRLS=true，但仍需 SQL 授权。依据 [PostgreSQL 17 RLS](https://www.postgresql.org/docs/17/ddl-rowsecurity.html) 与 [权限检查函数](https://www.postgresql.org/docs/17/functions-info.html)，本轮未实际执行角色下的业务操作。

## A 类：功能与授权不匹配

以下“会遇到”是目录 + 固定代码的推断，均未做网站实测。对运行条件、缺数据或旧入口不作额外假设。

| 编号 / 严重性 | 对象、角色与实际权限 | 代码用法（file:line） | 已登录用户在网站上会遇到什么 | 建议（只建议） |
| --- | --- | --- | --- | --- |
| A-01 中 | profiles，U 只有 SELECT；昵称/头像/邮箱的列 UPDATE 均 false；无 UPDATE policy | `packages/api/src/routers/user.ts:68`；`packages/api/src/trpc.ts:315` | 保存昵称/头像失败；自动同步昵称/邮箱可能静默失败 | 仅恢复必要资料列 UPDATE 和 own-row USING/WITH CHECK；保留角色、余额等禁写。0027:17 明确曾授资料列更新，本次不存在 |
| A-02 中 | announcements，P/U 无任何 SELECT；S 仅 R，无 I/U/D | `packages/api/src/routers/settings.ts:194`、`:234`；`packages/api/src/routers/admin.ts:1690`、`:1759`、`:1781` | 首页/横幅公告返回空或 null；管理员无法发布、修改、删除 | 按现有公开 active policy 授必要读取列；管理写入给 S 最小权限 |
| A-03 高 | tickets：U 无 R/I/U，且无普通用户 own 读/写策略；ticket_replies：U 无 R/I、缺 own SELECT；S 对回复无 R/I，对工单无 U | `packages/api/src/routers/ticket.ts:94`、`:135`、`:166`、`:200`、`:227`；`packages/api/src/routers/admin.ts:786`、`:861`、`:887` | 无法查看、提交、回复、关闭工单；客服后台也无法看回复或处理，支持链路受阻 | 同时恢复最小授权及 own-row 策略，后台操作由 S；不能只加 GRANT，不能放开全部工单 |
| A-04 高 | profiles：S 只读九列、UPDATE 仅 membership_level；avatar_url/last_login_at/last_ip 等不可读，role/status 不可改 | `packages/api/src/routers/admin.ts:584`、`:1119`、`:680`、`:1237`、`:1333` | 管理员用户列表/详情失败，停用账号等风控动作受阻；会员更新虽有列 U，但返回 `*` 仍失败 | 明确管理字段投影；必要管理读写用受控路径及最小授权，不回退成整表任意写 |
| A-05 中 | credit_transactions：S 只读列集合，source_id/source_refund_id/bill2_run_id 等不可读，整表 R=false | `packages/api/src/routers/admin.ts:924`（`select('*')`） | 后台交易流水页失败，用户积分争议难以排查 | 改为必要字段投影；确需追踪字段再定向授权，保留原子账务写入 |
| A-06 高（条件性额度风险） | ai_usage_logs：U 无 SELECT 且无任何 RLS 策略 | `packages/api/src/routers/user.ts:119`；`apps/web/src/app/api/ai/stream/route.ts:142`、`:761` | 使用偏好统计为空/不完整。旧聊天若启用免费额度，读取计数失败会返回 0，可能错误允许免费使用；本轮未读实际开关/额度，不证明已发生免费滥用 | 服务端按本人安全读取或恢复最小 own SELECT；额度读失败应安全拒绝，避免仅把错误转为 0 |
| A-07 中 | conversation_context_snapshots：U 无 R/I/U；虽有 own SELECT 和 admin ALL policy，普通用户无写策略 | `packages/api/src/services/contextSnapshots.ts:26`；`apps/web/src/app/api/ai/stream/route.ts:1153`、`:1171` | 旧聊天进入摘要/压缩快照分支时保存失败，后续上下文诊断缺材料；不代表整段聊天必然失败 | 由现有受控 S/RPC 持久化并验证会话归属，或补最小 own-row 授权/策略 |
| A-08 中 | invitation_records：S 只有 R、无任何 U；当前个人六列读取正常 | `packages/api/src/routers/invitation.ts:507` | 管理员不能改变邀请审核/风控状态，异常邀请难以人工处理 | 针对后台所需状态/风控列授 U 或走受控 RPC；涉及奖励状态的语义需另行校验 |
| A-09 中 | scheduled_job_runs：S 无 I/U；conversations/messages：S 无 U；ticket_replies：S 无 R/I，tickets：S 无 U | `packages/api/src/services/scheduledJobRuns.ts:22`、`:47`；`packages/api/src/services/conversationCleanup.ts:160`、`:171`；`packages/api/src/services/ticketAutoClose.ts:130`、`:150`、`:162` | 相关定时/后台清理先在任务启动记账处失败；如果越过该阶段，清理写入也受阻。用户旧会话/工单不会按这些代码完成清理 | 按现存任务的已批准业务范围补最小 S 授权；清理退役需求属其他任务，不能在此恢复产品功能 |
| A-10 中 | user_activity_logs：S 无 R/I | `packages/api/src/routers/admin.ts:691`、`:1083`、`:1154`、`:1248`、`:1373`、`:1401` | 管理员活动历史读取失败；主动作成功的路径可能静默丢失操作审计，用户争议难追踪 | S 最小 R/I，或复用已有事务 RPC 记录；审计失败不能靠重做积分动作补救 |
| A-11 低 | increment_module_usage 函数不存在；modules：U 对 usage_count 无 UPDATE | `packages/api/src/routers/modules.ts:217`、`:231` | 点击模块后界面可能仍正常，但热度/次数不增长；RPC 失败后 fallback 也失败却返回 success | 修复受控增量 RPC 或删除失效统计路径；不要开放用户任意改计数列 |
| A-12 中 | 缺 diagnostic_latest_results 视图及三个诊断 RPC；管理员用户客户端对 ai_usage_logs/快照无 R，对 billing_history id/metadata 等无 R | `packages/api/src/services/diagnostics.ts:1115`、`:1134`、`:1153`、`:216`、`:261`、`:282`；`packages/api/src/routers/diagnostics.ts:413` | 管理员看到空诊断、默认汇总或清理失败；普通用户的故障更难定位 | 查询改为现存数据源/受控 RPC；核实缺失对象是否应保留，不盲目补旧视图 |
| A-13 中（显示条件性不一致） | system_settings：U 有 R，但签到配置键不在公开白名单；普通用户 RLS 不放行 | `packages/api/src/routers/checkin.ts:48`、`:85`、`:144` | 签到页显示默认奖励；若后台实际配置不同，就与 SECURITY DEFINER 签到函数采用的配置不一致。本轮未读配置，不能称当前数值已不一致 | 复用受控服务端配置读取或仅放行确需公开的签到键，保持金额逻辑不变 |
| A-14 低（条件性补写失败） | billing_history：S 能读 id/metadata，但无 UPDATE(metadata) | `packages/api/src/services/billing.ts:554`、`:578`、`:1387` | 已有结算缺少 pricing 时，尽力补写失败并记录警告；用户后续账单解释可能缺细节，不能推断主扣费失败 | 将必要补写纳入已有原子路径，或取消不再需要的补写；不整体放开账本写权限 |
| A-15 中（旧入口） | profiles.updated_at 不存在，S 无 credits UPDATE；credit_transactions S 无 INSERT | `packages/api/src/routers/credits.ts:212`、`:237`、`:256`、`:318`、`:339`、`:357` | 若调用旧后台加减积分入口将失败；现行 `admin.adjustUserCredits` 走受控原子 RPC，不能据此说所有后台调积分都坏 | 退役/改接现有原子入口，禁止恢复非原子余额写入；具体入口引用见代码对照 |

A 不等于全部属于“迁移没有写过的漂移”：例如账务直接写受限是有意硬化，问题是遗留代码还需要该能力。建议先改代码复用受控 RPC，不用一揽子 GRANT ALL。

## B 类：过度授权与可能暴露

| 编号 / 严重性 | 对象、角色与实际权限/RLS | 代码证据与用户影响 | 建议（只建议） |
| --- | --- | --- | --- |
| B-01 严重 | ai_models.api_key：authenticated schema USAGE=true、整表 SELECT=true、该列 SELECT=true；anon 该列=false；RLS=true、FORCE=false；authenticated_active_ai_models_select 允许 `is_active='true'::text`，无相关 restrictive policy | `packages/api/src/routers/model.ts:224` 的安全投影只保护该接口；`packages/api/src/routers/ai.ts:286`、`:333` → `packages/api/src/services/modelRouter.ts:303`、`:334` 仍以用户客户端 `select('*')`。登录用户不必在页面看到密钥，就已具备直接读取启用模型密钥列的数据库权限；实际 HTTP 可达性、非空密钥和已发生泄露未测 | 收回用户整表 R 后按安全列 allowlist 授权；服务端凭据读取保留 S；同步改所有用户 `*` 查询以免正常选模型/估算失败。若确认有效密钥曾暴露，再由独立授权决定轮换与调查 |
| B-02 高（数据库层） | application_logs、diagnostic_results、scheduled_job_runs、subscription_credit_grants、ticket_replies、user_activity_logs：anon/authenticated 均 TRUNCATE、REFERENCES、TRIGGER=true；TRUNCATE 不受 RLS 保护 | `packages/api/src/lib/logger.ts:103`、`packages/api/src/services/diagnostics.ts:1216`、`packages/api/src/services/scheduledJobRuns.ts:22`、`packages/api/src/services/subscriptionCreditGrants.ts:2220`、`packages/api/src/routers/ticket.ts:200`、`packages/api/src/routers/admin.ts:1401` 均不需要客户端非 DML 权限。若角色能经 SQL 执行入口使用这些能力，用户可能丢失工单回复/账务依据/审计；未找到或验证网页直接 TRUNCATE 入口 | 分别撤销客户端 Dxt，核查新表默认权限来源；保留实际需要的 RLS 下 DML。不可把已存在 RLS 当作防 TRUNCATE 的证明 |
| B-03 中（维护面） | anon/authenticated 对 27 表 MAINTAIN=true，完整表名见有效维护权限清单；27 表包含六张 B-02 表 | 同上相关功能调用均无客户端维护需求；用户页面无正常用途。潜在影响为数据库维护操作/资源占用，不等于可读密钥或可删任意行；REST 可触发入口未证实 | 撤销客户端 MAINTAIN 并审查默认授权；保留必要运维身份，不将 MAINTAIN 与 SELECT 混淆 |

**ai_models.api_key 单独结论：authenticated 有读取该列的 SQL 权限；启用模型行的 RLS 会放行普通 authenticated，不要求管理员身份。** 这是目录级权限缺口，不是以读取真实 key 验证的泄露事件。停用行对普通用户受 active 条件限制；管理员策略另可放行管理员可见行。本次绝未查询该列值。

其他敏感表：invitation_records 的 IP/风控/用户代理列对 U 均不可读；profiles、payment_orders、user_subscriptions、credit_transactions 的普通用户读取受 own-row 策略限制；这些表可能有自有行中的敏感 JSON，未读业务值，不能据列名声称内容完全安全。application_logs 的 own-row 日志读取是现有策略，日志内容未查，不能直接判为他人隐私泄露。未发现本快照中的普通用户全库任意私有正文读取策略；这不是应用接口、Auth、Storage 或生产环境的全面安全结论。

## C 类：不一致但当前未增加功能/泄露影响

C 类共 **4 项**，只在本次代码路径和角色属性下称暂时无额外影响；不作全环境保证。B 类默认授权风险不归入 C。

| 编号 / 风险 | 对象、角色、实际状态 | 迁移与代码证据 | 影响及建议 |
| --- | --- | --- | --- |
| C-01 低 | conversations，U 当前 own SELECT/INSERT/UPDATE 已存在；缺 0004 另建的同类 ownership 策略 | `packages/db/migrations/0004_recursive_summary_and_soft_delete.sql:88`、`:93`、`:98`；`packages/db/migrations/0002_enable_rls_all_tables.sql:52`、`:57`、`:62`；`packages/api/src/routers/chat.ts:81` | 0004 的额外 permissive policy 原本不能收窄既有 OR 路径；其缺失未新增跨用户访问。以后规范迁移意图，不重复添加策略 |
| C-02 低 | token_stats 缺 service_role_all_token_stats；S 当前 BYPASSRLS=true、表 SELECT=true、写权限另受 ACL 限制 | `packages/db/migrations/0001_ai_billing_tables.sql:103`；`packages/api/src/routers/costs.ts:367` | 缺该策略不额外阻挡 S 已获准操作；无需为此开放客户端权限。它不解释 INSERT 缺权，也不证明日志写入成功 |
| C-03 低 | conversations/messages 缺旧 own DELETE policy；U DELETE=false；现行用户删除走函数 | `packages/db/migrations/0002_enable_rls_all_tables.sql:68`、`:104`；`packages/api/src/routers/chat.ts:364`、`:400` | 带身份与归属检查的 soft_delete_conversation 仍允许 U 执行；不能报成用户当前不能删会话。建议记录退役直删意图、保留受控 RPC |
| C-04 低 | rls_auto_enable 是 SECURITY DEFINER event_trigger，anon/authenticated EXECUTE=true；仓库无 CREATE 来源 | `packages/db/migrations/0050_sec1_privileged_rpc_execute_posture_closure.sql:6` 明确排除该平台函数；API/Web 生产代码未见直接调用 | event_trigger 不能当普通业务 RPC 直接执行；来源/绑定未由本轮证明，不把它报成可用的匿名改库接口。以后记录平台前提，暂不修改 |

### 已对齐或有意限制

- invitation_records：与 `packages/db/migrations/0140_invitation_records_column_grants.sql:26`、`:30` 对齐；U 仅六列读取、inviter-only；个人面板 `packages/api/src/routers/invitation.ts:523`、`:579` 与 `packages/api/src/services/invitationSummary.ts:5` 使用这些列。anon 无任何列读取。历史 IP/风控暴露已不属于本次现状 B；S 后台 UPDATE 缺权另见 A-08。
- invitations：S SELECT/INSERT=true，与 `packages/db/migrations/0141_invitations_service_role_insert.sql:1` 对齐；面板 `packages/api/src/routers/invitation.ts:541`、`:557` 已使用 S 且限定 created_by。不能重复引用旧面板故障。
- profiles、credit_transactions、billing_history、subscription_credit_grants 有意按列给 S 权限；不能因表级 R=false 就说全部读取失败。依据 `packages/db/migrations/0047_subscription_fulfillment_service_role_grants.sql`、`0063_bill_1_reconciliation_select_contract.sql:63`。本次 A 仅针对实际查询超出 allowlist 的路径。
- BILL2、Runtime、OPC、artifact 等表经 S 调 SECURITY DEFINER 访问；大部分直接表授权为空符合架构。代码和 RPC 对照见附表，未执行任何函数。
- BillingService 主路径先调原子 RPC；普通聊天代理又转入 ordinary_chat_transition（`apps/web/src/lib/ordinary-chat-request.ts:26`）。旧非原子 fallback 对 profiles/billing_history/messages/token_stats/ai_usage_logs 的直接写入不获授权，是安全硬化兼容限制；不能为了让 fallback 成功而恢复广泛写权限。A-14 只指主路径亦可触发的条件性 metadata 补写。

## 查询身份、方法与本地证据

Owner 2026-09-29 授权仅查询 staging 权限。本次官方 Supabase 连接器出现传输错误，改用已安装官方 CLI 的 `projects list` 读取项目元数据，核实既有 linked 目标确为 staging 后，使用 `db query --linked --file ... --output json`。本机默认应用配置指向正式环境，**没有用它连接数据库**；没有登录浏览器或使用浏览器令牌。

目录连接身份为数据库内置 `postgres`，current_user=session_user；PostgreSQL **17.6**。`transaction_read_only=off`、`default_transaction_read_only=off`，所以**不能称强制只读连接**。按 Owner 的明确例外，只提交 SELECT；没有 SET ROLE、BEGIN、DDL、DML、业务 RPC、迁移应用或业务表查询。原始目录、查询文件、时间和 SHA256 校验材料仅保留本机，不上传仓库/PR。报告中的数据库角色名为标准角色，不是个人账号。

主快照为一条 `SELECT jsonb_build_object(...)`，各子查询只访问：

- pg_class + pg_namespace：public 的 r/p/v/m/f 关系、relacl、relrowsecurity、relforcerowsecurity、reloptions；视图使用 pg_get_viewdef，实际无视图。
- pg_attribute：全部有效用户列、attacl；每列每角色检查 SELECT/INSERT/UPDATE，没有查询列值。
- pg_policies：全部 policyname、cmd、roles、permissive、qual、with_check。
- pg_roles + pg_auth_members：三个角色的继承、BYPASSRLS、public USAGE/CREATE；三个角色本次没有直接成员关系记录。有效 has_* 计算仍包含 PUBLIC/继承规则。
- pg_proc：所有 public 普通函数的签名、owner、ACL、SECURITY DEFINER、proconfig 及三个角色 EXECUTE；仅对客户端可执行的四个 definer 读取目录内定义，不执行函数。
- pg_default_acl：public 及全局默认 ACL，未查询或修改平台配置。
- has_schema_privilege / has_table_privilege / has_column_privilege / has_function_privilege：有效权限。另以 SELECT 补查 PG17 MAINTAIN。

C3 §6 的目标检查被包含在主快照：通过 catalog 先确定 ai_models 和 api_key 存在，再对该列 attnum 调用 has_column_privilege。没有执行 `SELECT api_key FROM ai_models`，也没有执行对业务表的计数或存在性查询。

可复核查询的最小形式（只访问目录；这里只是方法说明）：

```sql
SELECT r.rolname, c.relname, a.attname,
       has_table_privilege(r.oid, c.oid, 'SELECT') AS table_select,
       has_column_privilege(r.oid, c.oid, a.attnum, 'SELECT') AS column_select,
       c.relrowsecurity, c.relforcerowsecurity, c.relacl, a.attacl
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_attribute a ON a.attrelid = c.oid
CROSS JOIN pg_roles r
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
  AND a.attnum > 0 AND NOT a.attisdropped
  AND r.rolname IN ('anon', 'authenticated', 'service_role');
```

静态扫描覆盖 packages/api/src、apps/web/src 的生产 TS/TSX，排除测试；搜索 `.from`、`.rpc`、`rpcFn.call` 和 RPC helper 的字符串参数，跟踪调用端注入身份，检查 `select('*')`、嵌套关系和 fallback。没有通过函数名猜测授权成功；逐表和 RPC 附表均以目录对照。迁移核查覆盖本基线全部 SQL 的 GRANT/REVOKE、CREATE/DROP POLICY 和相关函数最终定义；没有重放，也没有读取远端迁移账本，因此不推定是哪次执行或谁造成漂移。

## 逐表权限摘要

全部表 owner 为 postgres、RLS 开启、FORCE RLS 关闭；下表仍逐表列出开关。表名无 public 前缀均指 public。ACL 编号按完整授权字符串去重，原文字符串见紧接的字典；这是一份脱敏目录摘要，不含原始快照 JSON。

| 表 | anon 表级 RIUD | authenticated 表级 RIUD | service_role 表级 RIUD | RLS/FORCE | relacl | attacl非空列数 |
| --- | --- | --- | --- | --- | --- | --- |
| agent_confirmed_preferences | - | - | - | 是/否 | ACL-01 | 0 |
| agent_preference_requests | - | - | - | 是/否 | ACL-01 | 0 |
| agent_slice_calls | - | - | - | 是/否 | ACL-01 | 0 |
| agent_slice_executions | - | - | - | 是/否 | ACL-01 | 0 |
| agent_slice_links | - | - | - | 是/否 | ACL-01 | 0 |
| agent_slice_pairs | - | - | - | 是/否 | ACL-01 | 0 |
| ai_models | - | R | RIU | 是/否 | ACL-02 | 0 |
| ai_usage_logs | - | - | R | 是/否 | ACL-03 | 0 |
| announcements | - | - | R | 是/否 | ACL-03 | 0 |
| application_logs | RIUD | RIUD | RIUD | 是/否 | ACL-04 | 0 |
| artifact_accounts | - | - | - | 是/否 | ACL-01 | 0 |
| artifact_candidates | - | - | - | 是/否 | ACL-01 | 0 |
| artifact_chat_summaries | - | - | - | 是/否 | ACL-01 | 0 |
| artifact_chat_turns | - | - | - | 是/否 | ACL-01 | 0 |
| artifact_chats | - | - | - | 是/否 | ACL-01 | 0 |
| artifact_confirmations | - | - | - | 是/否 | ACL-01 | 0 |
| artifact_evidence | - | - | - | 是/否 | ACL-01 | 0 |
| artifact_evidence_restrictions | - | - | - | 是/否 | ACL-01 | 0 |
| artifact_generations | - | - | - | 是/否 | ACL-01 | 0 |
| artifact_projects | - | - | - | 是/否 | ACL-01 | 0 |
| artifact_reference_configs | - | - | - | 是/否 | ACL-01 | 0 |
| artifact_requests | - | - | - | 是/否 | ACL-01 | 0 |
| artifact_rounds | - | - | - | 是/否 | ACL-01 | 0 |
| artifact_versions | - | - | - | 是/否 | ACL-01 | 0 |
| artifact_work_references | - | - | - | 是/否 | ACL-01 | 0 |
| artifact_workflows | - | - | - | 是/否 | ACL-01 | 0 |
| bill2_calls | - | - | - | 是/否 | ACL-01 | 0 |
| bill2_drafts | - | - | - | 是/否 | ACL-01 | 0 |
| bill2_provider_ids | - | - | - | 是/否 | ACL-01 | 0 |
| bill2_receipts | - | - | - | 是/否 | ACL-01 | 0 |
| bill2_runs | - | - | - | 是/否 | ACL-01 | 0 |
| billing_history | - | - | - | 是/否 | ACL-05 | 6 |
| conversation_context_snapshots | - | - | - | 是/否 | ACL-05 | 0 |
| conversations | - | RIU | R | 是/否 | ACL-06 | 0 |
| credit_packages | R | R | RIUD | 是/否 | ACL-07 | 0 |
| credit_transactions | - | R | - | 是/否 | ACL-08 | 18 |
| diagnostic_results | RIUD | RIUD | RIUD | 是/否 | ACL-04 | 0 |
| invitation_records | - | - | R | 是/否 | ACL-03 | 6 |
| invitations | - | - | RI | 是/否 | ACL-09 | 0 |
| membership_plans | R | R | RIUD | 是/否 | ACL-07 | 0 |
| messages | - | R | R | 是/否 | ACL-10 | 0 |
| modules | - | - | RIUD | 是/否 | ACL-11 | 23 |
| opc_account_strategy_drafts | - | - | - | 是/否 | ACL-01 | 0 |
| opc_account_strategy_request_bases | - | - | - | 是/否 | ACL-01 | 0 |
| opc_account_ui | - | - | - | 是/否 | ACL-01 | 0 |
| opc_accounts | - | - | - | 是/否 | ACL-01 | 0 |
| opc_businesses | - | - | - | 是/否 | ACL-01 | 0 |
| opc_content_versions | - | - | - | 是/否 | ACL-01 | 0 |
| opc_draft_businesses | - | - | - | 是/否 | ACL-01 | 0 |
| opc_drafts | - | - | - | 是/否 | ACL-01 | 0 |
| opc_handoffs | - | - | - | 是/否 | ACL-01 | 0 |
| opc_item_edits | - | - | - | 是/否 | ACL-01 | 0 |
| opc_items | - | - | - | 是/否 | ACL-01 | 0 |
| opc_library_requests | - | - | - | 是/否 | ACL-01 | 0 |
| opc_plans | - | - | - | 是/否 | ACL-01 | 0 |
| opc_publication_ui | - | - | - | 是/否 | ACL-01 | 0 |
| opc_result_links | - | - | - | 是/否 | ACL-01 | 0 |
| opc_topic_draft_versions | - | - | - | 是/否 | ACL-01 | 0 |
| opc_topic_openings | - | - | - | 是/否 | ACL-01 | 0 |
| opc_topic_workspaces | - | - | - | 是/否 | ACL-01 | 0 |
| opc_turns | - | - | - | 是/否 | ACL-01 | 0 |
| opc_video_material_bindings | - | - | - | 是/否 | ACL-01 | 0 |
| opc_work_ui | - | - | - | 是/否 | ACL-01 | 0 |
| ordinary_chat_requests | - | - | R | 是/否 | ACL-12 | 0 |
| payment_orders | - | R | RIU | 是/否 | ACL-13 | 0 |
| profiles | - | R | D | 是/否 | ACL-14 | 9 |
| prompts | - | - | R | 是/否 | ACL-03 | 0 |
| research_operations | - | - | - | 是/否 | ACL-01 | 0 |
| research_plans | - | - | - | 是/否 | ACL-01 | 0 |
| runtime_executions | - | - | - | 是/否 | ACL-01 | 0 |
| runtime_history_dependencies | - | - | - | 是/否 | ACL-01 | 0 |
| runtime_scope_material | - | - | - | 是/否 | ACL-01 | 0 |
| runtime_session_batches | - | - | - | 是/否 | ACL-01 | 0 |
| runtime_session_history | - | - | - | 是/否 | ACL-01 | 0 |
| runtime_sessions | - | - | - | 是/否 | ACL-01 | 0 |
| runtime_test_windows | - | - | - | 是/否 | ACL-01 | 0 |
| runtime_tool_calls | - | - | - | 是/否 | ACL-01 | 0 |
| scheduled_job_runs | - | - | R | 是/否 | ACL-15 | 0 |
| skill_package_files | - | - | R | 是/否 | ACL-12 | 0 |
| skill_packages | - | - | R | 是/否 | ACL-12 | 0 |
| skill_revision_revocations | - | - | R | 是/否 | ACL-12 | 0 |
| skill_revisions | - | - | R | 是/否 | ACL-12 | 0 |
| skills | - | - | RI | 是/否 | ACL-16 | 11 |
| subscription_credit_grants | - | - | - | 是/否 | ACL-17 | 22 |
| system_settings | R | R | RIU | 是/否 | ACL-18 | 0 |
| ticket_replies | - | - | - | 是/否 | ACL-19 | 0 |
| tickets | - | - | R | 是/否 | ACL-03 | 0 |
| token_stats | - | R | R | 是/否 | ACL-10 | 0 |
| user_activity_logs | - | - | - | 是/否 | ACL-19 | 0 |
| user_checkins | - | R | - | 是/否 | ACL-20 | 0 |
| user_subscriptions | - | R | RIU | 是/否 | ACL-13 | 0 |

### relacl 字典

ACL 字母：r=SELECT、a=INSERT、w=UPDATE、d=DELETE、D=TRUNCATE、x=REFERENCES、t=TRIGGER、m=MAINTAIN；`角色=权限/授予者`。X 为函数 EXECUTE；序列 U 为 USAGE。不要把 D 与 d 混淆。

- ACL-01：`postgres=arwdDxtm/postgres`
- ACL-02：`postgres=arwdDxtm/postgres; anon=m/postgres; authenticated=rm/postgres; service_role=arwDxtm/postgres`
- ACL-03：`postgres=arwdDxtm/postgres; anon=m/postgres; authenticated=m/postgres; service_role=rDxtm/postgres`
- ACL-04：`postgres=arwdDxtm/postgres; anon=arwdDxtm/postgres; authenticated=arwdDxtm/postgres; service_role=arwdDxtm/postgres`
- ACL-05：`postgres=arwdDxtm/postgres; anon=m/postgres; authenticated=m/postgres; service_role=Dxtm/postgres`
- ACL-06：`postgres=arwdDxtm/postgres; anon=m/postgres; authenticated=arwm/postgres; service_role=rDxtm/postgres`
- ACL-07：`postgres=arwdDxtm/postgres; anon=rm/postgres; authenticated=rm/postgres; service_role=arwdDxtm/postgres`
- ACL-08：`postgres=arwdDxtm/postgres; anon=m/postgres; authenticated=rm/postgres`
- ACL-09：`postgres=arwdDxtm/postgres; anon=m/postgres; authenticated=m/postgres; service_role=arDxtm/postgres`
- ACL-10：`postgres=arwdDxtm/postgres; anon=m/postgres; authenticated=rm/postgres; service_role=rDxtm/postgres`
- ACL-11：`postgres=arwdDxtm/postgres; anon=m/postgres; authenticated=m/postgres; service_role=arwdDxtm/postgres`
- ACL-12：`postgres=arwdDxtm/postgres; service_role=r/postgres`
- ACL-13：`postgres=arwdDxtm/postgres; anon=m/postgres; authenticated=rm/postgres; service_role=arwm/postgres`
- ACL-14：`postgres=arwdDxtm/postgres; anon=m/postgres; authenticated=rm/postgres; service_role=d/postgres`
- ACL-15：`postgres=arwdDxtm/postgres; anon=Dxtm/postgres; authenticated=Dxtm/postgres; service_role=rDxtm/postgres`
- ACL-16：`postgres=arwdDxtm/postgres; service_role=ar/postgres`
- ACL-17：`postgres=arwdDxtm/postgres; anon=Dxtm/postgres; authenticated=Dxtm/postgres`
- ACL-18：`postgres=arwdDxtm/postgres; anon=rm/postgres; authenticated=rm/postgres; service_role=arwDxtm/postgres`
- ACL-19：`postgres=arwdDxtm/postgres; anon=Dxtm/postgres; authenticated=Dxtm/postgres; service_role=Dxtm/postgres`
- ACL-20：`postgres=arwdDxtm/postgres; anon=m/postgres; authenticated=rm/postgres; service_role=Dxtm/postgres`

### attacl 与有效列权限

全部有效列均以 has_column_privilege 对三角色检查 R/I/U。未列出的表，所有列的 R/I/U 与该角色表级 R/I/U 相同、attacl=NULL。列出的表也不将 NULL attacl 当拒绝：有效权限仍含表授权。下表明确全部列授权例外，未获表权限且未列出的列操作为 false。

| 表 | 列 | attacl |
| --- | --- | --- |
| billing_history | id | `service_role=r/postgres` |
| billing_history | user_id | `authenticated=r/postgres; service_role=r/postgres` |
| billing_history | operation_type | `service_role=r/postgres; authenticated=r/postgres` |
| billing_history | amount | `service_role=r/postgres; authenticated=r/postgres` |
| billing_history | metadata | `service_role=r/postgres` |
| billing_history | created_at | `service_role=r/postgres; authenticated=r/postgres` |
| credit_transactions | id | `service_role=r/postgres` |
| credit_transactions | user_id | `service_role=r/postgres` |
| credit_transactions | amount | `service_role=r/postgres` |
| credit_transactions | type | `service_role=r/postgres` |
| credit_transactions | description | `service_role=r/postgres` |
| credit_transactions | idempotency_key | `service_role=r/postgres` |
| credit_transactions | balance_before | `service_role=r/postgres` |
| credit_transactions | balance_after | `service_role=r/postgres` |
| credit_transactions | created_at | `service_role=r/postgres` |
| credit_transactions | ledger_type | `service_role=rw/postgres` |
| credit_transactions | reason_code | `service_role=rw/postgres` |
| credit_transactions | counts_as_spend | `service_role=rw/postgres` |
| credit_transactions | source_type | `service_role=rw/postgres` |
| credit_transactions | source_id | `service_role=w/postgres` |
| credit_transactions | source_order_id | `service_role=rw/postgres` |
| credit_transactions | source_refund_id | `service_role=w/postgres` |
| credit_transactions | grant_period_key | `service_role=rw/postgres` |
| credit_transactions | metadata | `service_role=rw/postgres` |
| invitation_records | id | `authenticated=r/postgres` |
| invitation_records | inviter_id | `authenticated=r/postgres` |
| invitation_records | invitee_email | `authenticated=r/postgres` |
| invitation_records | status | `authenticated=r/postgres` |
| invitation_records | inviter_reward | `authenticated=r/postgres` |
| invitation_records | created_at | `authenticated=r/postgres` |
| modules | id | `anon=r/postgres; authenticated=r/postgres` |
| modules | title | `anon=r/postgres; authenticated=r/postgres` |
| modules | description | `anon=r/postgres; authenticated=r/postgres` |
| modules | full_description | `anon=r/postgres; authenticated=r/postgres` |
| modules | icon | `anon=r/postgres; authenticated=r/postgres` |
| modules | category | `anon=r/postgres; authenticated=r/postgres` |
| modules | platform | `anon=r/postgres; authenticated=r/postgres` |
| modules | features | `anon=r/postgres; authenticated=r/postgres` |
| modules | examples | `anon=r/postgres; authenticated=r/postgres` |
| modules | preparation_questions | `anon=r/postgres; authenticated=r/postgres` |
| modules | usage_count | `anon=r/postgres; authenticated=r/postgres` |
| modules | credits_multiplier | `anon=r/postgres; authenticated=r/postgres` |
| modules | sort_order | `anon=r/postgres; authenticated=r/postgres` |
| modules | is_featured | `anon=r/postgres; authenticated=r/postgres` |
| modules | active | `anon=r/postgres; authenticated=r/postgres` |
| modules | created_at | `anon=r/postgres; authenticated=r/postgres` |
| modules | updated_at | `anon=r/postgres; authenticated=r/postgres` |
| modules | image_url | `anon=r/postgres; authenticated=r/postgres` |
| modules | badge_type | `anon=r/postgres; authenticated=r/postgres` |
| modules | badge_text | `anon=r/postgres; authenticated=r/postgres` |
| modules | credits_display | `anon=r/postgres; authenticated=r/postgres` |
| modules | link_url | `anon=r/postgres; authenticated=r/postgres` |
| modules | link_module_id | `anon=r/postgres; authenticated=r/postgres` |
| profiles | id | `service_role=ar/postgres` |
| profiles | email | `service_role=ar/postgres` |
| profiles | nickname | `service_role=ar/postgres` |
| profiles | role | `service_role=ar/postgres` |
| profiles | status | `service_role=ar/postgres` |
| profiles | membership_level | `service_role=arw/postgres` |
| profiles | credits | `service_role=ar/postgres` |
| profiles | is_deleted | `service_role=r/postgres` |
| profiles | created_at | `service_role=r/postgres` |
| skills | id | `anon=r/postgres; authenticated=r/postgres` |
| skills | skill_key | `anon=r/postgres; authenticated=r/postgres` |
| skills | draft_content | `service_role=w/postgres` |
| skills | status | `service_role=w/postgres; anon=r/postgres; authenticated=r/postgres` |
| skills | published_version | `anon=r/postgres; authenticated=r/postgres` |
| skills | updated_by | `service_role=w/postgres` |
| skills | archived_by | `service_role=w/postgres` |
| skills | audit_metadata | `service_role=w/postgres` |
| skills | published_at | `anon=r/postgres; authenticated=r/postgres` |
| skills | archived_at | `service_role=w/postgres` |
| skills | content_kind | `anon=r/postgres; authenticated=r/postgres` |
| subscription_credit_grants | id | `service_role=r/postgres` |
| subscription_credit_grants | user_id | `service_role=ar/postgres` |
| subscription_credit_grants | membership_plan_id | `service_role=ar/postgres` |
| subscription_credit_grants | stripe_subscription_id | `service_role=ar/postgres` |
| subscription_credit_grants | stripe_invoice_id | `service_role=ar/postgres` |
| subscription_credit_grants | billing_cycle | `service_role=ar/postgres` |
| subscription_credit_grants | grant_type | `service_role=ar/postgres` |
| subscription_credit_grants | grant_period_key | `service_role=ar/postgres` |
| subscription_credit_grants | period_start | `service_role=ar/postgres` |
| subscription_credit_grants | period_end | `service_role=ar/postgres` |
| subscription_credit_grants | period_index | `service_role=ar/postgres` |
| subscription_credit_grants | total_periods | `service_role=ar/postgres` |
| subscription_credit_grants | credits_granted | `service_role=ar/postgres` |
| subscription_credit_grants | status | `service_role=arw/postgres` |
| subscription_credit_grants | idempotency_key | `service_role=ar/postgres` |
| subscription_credit_grants | credit_transaction_id | `service_role=ar/postgres` |
| subscription_credit_grants | metadata | `service_role=arw/postgres` |
| subscription_credit_grants | created_at | `service_role=r/postgres` |
| subscription_credit_grants | updated_at | `service_role=rw/postgres` |
| subscription_credit_grants | consumed_amount | `service_role=r/postgres` |
| subscription_credit_grants | accounting_state | `service_role=r/postgres` |
| subscription_credit_grants | accounting_review_reason | `service_role=r/postgres` |

| 表 | 角色 | 有效列 SELECT | 有效列 INSERT | 有效列 UPDATE |
| --- | --- | --- | --- | --- |
| billing_history | anon | - | - | - |
| billing_history | authenticated | user_id、operation_type、amount、created_at | - | - |
| billing_history | service_role | id、user_id、operation_type、amount、metadata、created_at | - | - |
| credit_transactions | anon | - | - | - |
| credit_transactions | authenticated | 全部列 | - | - |
| credit_transactions | service_role | id、user_id、amount、type、description、idempotency_key、balance_before、balance_after、created_at、ledger_type、reason_code、counts_as_spend、source_type、source_order_id、grant_period_key、metadata | - | ledger_type、reason_code、counts_as_spend、source_type、source_id、source_order_id、source_refund_id、grant_period_key、metadata |
| invitation_records | anon | - | - | - |
| invitation_records | authenticated | id、inviter_id、invitee_email、status、inviter_reward、created_at | - | - |
| invitation_records | service_role | 全部列 | - | - |
| modules | anon | id、title、description、full_description、icon、category、platform、features、examples、preparation_questions、usage_count、credits_multiplier、sort_order、is_featured、active、created_at、updated_at、image_url、badge_type、badge_text、credits_display、link_url、link_module_id | - | - |
| modules | authenticated | id、title、description、full_description、icon、category、platform、features、examples、preparation_questions、usage_count、credits_multiplier、sort_order、is_featured、active、created_at、updated_at、image_url、badge_type、badge_text、credits_display、link_url、link_module_id | - | - |
| modules | service_role | 全部列 | 全部列 | 全部列 |
| profiles | anon | - | - | - |
| profiles | authenticated | 全部列 | - | - |
| profiles | service_role | id、email、nickname、role、status、membership_level、credits、is_deleted、created_at | id、email、nickname、role、status、membership_level、credits | membership_level |
| skills | anon | id、skill_key、status、published_version、published_at、content_kind | - | - |
| skills | authenticated | id、skill_key、status、published_version、published_at、content_kind | - | - |
| skills | service_role | 全部列 | 全部列 | draft_content、status、updated_by、archived_by、audit_metadata、archived_at |
| subscription_credit_grants | anon | - | - | - |
| subscription_credit_grants | authenticated | - | - | - |
| subscription_credit_grants | service_role | 全部列 | user_id、membership_plan_id、stripe_subscription_id、stripe_invoice_id、billing_cycle、grant_type、grant_period_key、period_start、period_end、period_index、total_periods、credits_granted、status、idempotency_key、credit_transaction_id、metadata | status、metadata、updated_at |

### 有效维护权限与默认授权

- anon，MAINTAIN=true（27 表）：ai_models、ai_usage_logs、announcements、application_logs、billing_history、conversation_context_snapshots、conversations、credit_packages、credit_transactions、diagnostic_results、invitation_records、invitations、membership_plans、messages、modules、payment_orders、profiles、prompts、scheduled_job_runs、subscription_credit_grants、system_settings、ticket_replies、tickets、token_stats、user_activity_logs、user_checkins、user_subscriptions。
- authenticated，MAINTAIN=true（27 表）：ai_models、ai_usage_logs、announcements、application_logs、billing_history、conversation_context_snapshots、conversations、credit_packages、credit_transactions、diagnostic_results、invitation_records、invitations、membership_plans、messages、modules、payment_orders、profiles、prompts、scheduled_job_runs、subscription_credit_grants、system_settings、ticket_replies、tickets、token_stats、user_activity_logs、user_checkins、user_subscriptions。
- service_role，MAINTAIN=true（24 表）：ai_models、ai_usage_logs、announcements、application_logs、billing_history、conversation_context_snapshots、conversations、credit_packages、diagnostic_results、invitation_records、invitations、membership_plans、messages、modules、payment_orders、prompts、scheduled_job_runs、system_settings、ticket_replies、tickets、token_stats、user_activity_logs、user_checkins、user_subscriptions。

B-02 六表的 anon/authenticated Dxt 均由 has_table_privilege=true 确认；其余表三个非DML项对这两个角色均 false。

默认 ACL 不回溯已建对象，也依赖对象创建者；不能等同所有新函数的完整有效权限。迁移中仅 `packages/db/migrations/0049_reconcile_stg_fix_target_grants.sql:5` 注释提及默认权限不调整，未见重建这些默认值的实现。默认表权限含客户端 Dxtm/全权限，故属于 B-02/B-03 的复发风险，不能称无害。

| 创建者 | 对象类型 | 默认ACL |
| --- | --- | --- |
| supabase_admin | S | `postgres=rwU/supabase_admin; anon=rwU/supabase_admin; authenticated=rwU/supabase_admin; service_role=rwU/supabase_admin` |
| supabase_admin | r | `postgres=arwdDxtm/supabase_admin; anon=arwdDxtm/supabase_admin; authenticated=arwdDxtm/supabase_admin; service_role=arwdDxtm/supabase_admin` |
| supabase_admin | f | `postgres=X/supabase_admin; anon=X/supabase_admin; authenticated=X/supabase_admin; service_role=X/supabase_admin` |
| postgres | r | `postgres=arwdDxtm/postgres; anon=Dxtm/postgres; authenticated=Dxtm/postgres; service_role=Dxtm/postgres` |
| postgres | S | `postgres=rwU/postgres; anon=w/postgres; authenticated=w/postgres; service_role=w/postgres` |
| postgres | f | `postgres=X/postgres` |

## 全部 RLS 策略摘要

共有54条；未出现在此表的 public 表没有策略。条件按目录空白规范化，NULL 表示该命令无显式表达式，不等于 `true`；UPDATE/ALL 的 WITH CHECK 缺省时可继承 USING，不能一概判为任意写入。

| 表 | 策略 | 命令 | 角色 | 组合 | USING | WITH CHECK |
| --- | --- | --- | --- | --- | --- | --- |
| ai_models | ai_models_select_admin | SELECT | authenticated | PERMISSIVE | E01 | NULL |
| ai_models | authenticated_active_ai_models_select | SELECT | authenticated | PERMISSIVE | E02 | NULL |
| announcements | announcements_select_active_public | SELECT | anon,authenticated | PERMISSIVE | E03 | NULL |
| announcements | announcements_select_admin | SELECT | authenticated | PERMISSIVE | E01 | NULL |
| application_logs | Admin can view all logs | SELECT | public | PERMISSIVE | E04 | NULL |
| application_logs | Users can view own logs | SELECT | public | PERMISSIVE | E05 | NULL |
| billing_history | ai_consumption_select_own | SELECT | authenticated | PERMISSIVE | E06 | NULL |
| billing_history | ai_consumption_select_own_boundary | SELECT | authenticated | RESTRICTIVE | E06 | NULL |
| conversation_context_snapshots | context_snapshots_admin_all | ALL | authenticated | PERMISSIVE | E01 | E01 |
| conversation_context_snapshots | context_snapshots_select_own_or_admin | SELECT | authenticated | PERMISSIVE | E07 | NULL |
| conversations | conversations_admin_select | SELECT | authenticated | PERMISSIVE | E01 | NULL |
| conversations | conversations_insert_own | INSERT | authenticated | PERMISSIVE | NULL | E08 |
| conversations | conversations_select_own | SELECT | authenticated | PERMISSIVE | E08 | NULL |
| conversations | conversations_update_own | UPDATE | authenticated | PERMISSIVE | E08 | E08 |
| credit_packages | credit_packages_admin_delete | DELETE | authenticated | PERMISSIVE | E01 | NULL |
| credit_packages | credit_packages_admin_insert | INSERT | authenticated | PERMISSIVE | NULL | E01 |
| credit_packages | credit_packages_admin_update | UPDATE | authenticated | PERMISSIVE | E01 | E01 |
| credit_packages | credit_packages_select_active_public | SELECT | anon,authenticated | PERMISSIVE | E09 | NULL |
| credit_packages | credit_packages_select_admin | SELECT | authenticated | PERMISSIVE | E01 | NULL |
| credit_transactions | credit_transactions_select_admin | SELECT | authenticated | PERMISSIVE | E01 | NULL |
| credit_transactions | credit_transactions_select_own | SELECT | authenticated | PERMISSIVE | E08 | NULL |
| diagnostic_results | Admins can insert diagnostic results | INSERT | public | PERMISSIVE | NULL | E04 |
| diagnostic_results | Admins can view all diagnostic results | SELECT | public | PERMISSIVE | E04 | NULL |
| invitation_records | invitation_records_select_own | SELECT | authenticated | PERMISSIVE | E10 | NULL |
| invitations | invitations_select_admin | SELECT | authenticated | PERMISSIVE | E01 | NULL |
| membership_plans | membership_plans_admin_delete | DELETE | authenticated | PERMISSIVE | E01 | NULL |
| membership_plans | membership_plans_admin_insert | INSERT | authenticated | PERMISSIVE | NULL | E01 |
| membership_plans | membership_plans_admin_update | UPDATE | authenticated | PERMISSIVE | E01 | E01 |
| membership_plans | membership_plans_select_active_public | SELECT | anon,authenticated | PERMISSIVE | E02 | NULL |
| membership_plans | membership_plans_select_admin | SELECT | authenticated | PERMISSIVE | E01 | NULL |
| messages | messages_admin_select | SELECT | authenticated | PERMISSIVE | E01 | NULL |
| messages | messages_select_own | SELECT | authenticated | PERMISSIVE | E11 | NULL |
| modules | modules_select_active_public | SELECT | anon,authenticated | PERMISSIVE | E12 | NULL |
| modules | modules_select_admin | SELECT | authenticated | PERMISSIVE | E01 | NULL |
| payment_orders | users_own_payment_orders_select | SELECT | authenticated | PERMISSIVE | E08 | NULL |
| profiles | profiles_select_own | SELECT | authenticated | PERMISSIVE | E13 | NULL |
| prompts | prompts_select_active_public | SELECT | anon,authenticated | PERMISSIVE | E14 | NULL |
| prompts | prompts_select_admin | SELECT | authenticated | PERMISSIVE | E01 | NULL |
| scheduled_job_runs | scheduled_job_runs_admin_all | ALL | authenticated | PERMISSIVE | E01 | E01 |
| skills | skills_published_select | SELECT | anon,authenticated | PERMISSIVE | E15 | NULL |
| subscription_credit_grants | admin_all_subscription_credit_grants | ALL | public | PERMISSIVE | E04 | E04 |
| subscription_credit_grants | users_own_subscription_credit_grants_select | SELECT | public | PERMISSIVE | E08 | NULL |
| system_settings | system_settings_select_admin | SELECT | authenticated | PERMISSIVE | E01 | NULL |
| system_settings | system_settings_select_home_analysis | SELECT | anon,authenticated | PERMISSIVE | E16 | NULL |
| system_settings | system_settings_select_public_user_facing | SELECT | anon,authenticated | PERMISSIVE | E17 | NULL |
| ticket_replies | ticket_replies_insert_own | INSERT | authenticated | PERMISSIVE | NULL | E18 |
| ticket_replies | ticket_replies_select_admin | SELECT | authenticated | PERMISSIVE | E01 | NULL |
| tickets | tickets_select_admin | SELECT | authenticated | PERMISSIVE | E01 | NULL |
| token_stats | users_own_token_stats_select | SELECT | authenticated | PERMISSIVE | E08 | NULL |
| user_activity_logs | user_activity_logs_select_admin | SELECT | authenticated | PERMISSIVE | E01 | NULL |
| user_checkins | admin_all_user_checkins | ALL | public | PERMISSIVE | E04 | NULL |
| user_checkins | users_own_user_checkins_insert | INSERT | public | PERMISSIVE | NULL | E08 |
| user_checkins | users_own_user_checkins_select | SELECT | public | PERMISSIVE | E08 | NULL |
| user_subscriptions | users_own_user_subscriptions_select | SELECT | authenticated | PERMISSIVE | E08 | NULL |

条件字典（仅列名、SQL 条件和配置键，不包含业务值）：

- E01：`(EXISTS ( SELECT 1 FROM profiles p WHERE ((p.id = auth.uid()) AND (p.role = 'admin'::text) AND (p.status = 'active'::text))))`
- E02：`(is_active = 'true'::text)`
- E03：`((active = 'true'::text) AND (is_deleted = 'false'::text) AND ((start_date IS NULL) OR (start_date <= now())) AND ((end_date IS NULL) OR (end_date >= now())))`
- E04：`(EXISTS ( SELECT 1 FROM profiles WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text))))`
- E05：`(user_id = auth.uid())`
- E06：`(user_id = ( SELECT auth.uid() AS uid))`
- E07：`((EXISTS ( SELECT 1 FROM conversations c WHERE ((c.id = conversation_context_snapshots.conversation_id) AND (c.user_id = auth.uid())))) OR (EXISTS ( SELECT 1 FROM profiles p WHERE ((p.id = auth.uid()) AND (p.role = 'admin'::text) AND (p.status = 'active'::text)))))`
- E08：`(auth.uid() = user_id)`
- E09：`(active = 'true'::text)`
- E10：`(auth.uid() = inviter_id)`
- E11：`(EXISTS ( SELECT 1 FROM conversations c WHERE ((c.id = messages.conversation_id) AND (c.user_id = auth.uid()))))`
- E12：`(active IS TRUE)`
- E13：`(auth.uid() = id)`
- E14：`((active = 'true'::text) AND (is_deleted = 'false'::text))`
- E15：`((status = 'published'::text) AND (published_version > 0) AND (published_content IS NOT NULL) AND (published_content_hash IS NOT NULL))`
- E16：`(key = 'home_analysis_module_id'::text)`
- E17：`(key = ANY (ARRAY['site_name'::text, 'support_email'::text, 'maintenance_mode'::text, 'home_show_onboarding'::text, 'home_show_featured_modules'::text, 'chat_show_model_selector'::text, 'max_input_characters'::text, 'enable_free_tier'::text, 'free_tier_messages'::text, 'enable_long_text_warning'::text, 'long_text_warning_threshold'::text, 'show_token_usage_stats'::text, 'chat_prompt_text'::text, 'chat_welcome_message'::text, 'chat_billing_hint'::text, 'input_credits_per_1k'::text, 'output_credits_per_1k'::text]))`
- E18：`(EXISTS ( SELECT 1 FROM tickets t WHERE ((t.id = ticket_replies.ticket_id) AND (t.user_id = auth.uid()))))`

## 视图与 SECURITY DEFINER

当前 public 没有 view/materialized view，所以 security_invoker 检查结果为**无对象、非遗漏**。代码引用 diagnostic_latest_results 但目录不存在，归入 A-12；不能对不存在的视图报告已安全。

四个客户端可执行 SECURITY DEFINER 如下，其余180个对 anon/authenticated 的 EXECUTE 均 false；有授权不等于函数体允许越权。未执行任何函数。

| 函数 | anon EXECUTE | authenticated EXECUTE | owner / search_path | 定义检查与分类 |
| --- | --- | --- | --- | --- |
| claim_daily_checkin(p_user_id uuid) | False | True | postgres / search_path=public, pg_temp | 非空 auth.uid 必须与 p_user_id 一致；普通有效 JWT 身份不能签到他人。空 uid 分支不能在未证明认证入口可达时当成已证漏洞。0050:99、:103 的预期。 |
| rls_auto_enable() | True | True | postgres / search_path=pg_catalog | event_trigger 返回类型，不能作为普通 RPC 调用；平台来源缺口 C-04，未查事件绑定。 |
| soft_delete_conversation(p_conversation_id uuid, p_user_id uuid) | False | True | postgres / search_path=public, pg_temp | 拒绝空 uid/身份不一致，再检查会话归属。0050:113 的预期，用户删除路径可用授权。 |
| validate_invitation_code(input_code text) | True | True | postgres / search_path=public, pg_temp | 仅返回 active 邀请码是否存在的 boolean；0031:35 与 0050:106 有意公开，不暴露记录内容。 |

## 代码用法对照

直接调用：28 张实际表 + 1 个缺失视图。以下为代表位置，不是完整调用次数统计；RPC 间接表在后一表逐张覆盖。App/Web 的 Auth、Storage API 不属于 public 业务表查询，本轮未查其目录或数据。

| 表或视图 | 实际客户端/操作 | 代表调用（仓库相对路径） |
|---|---|---|
| ai_models | U R 安全字段及部分 helper `*`；S R/I/U，删除通过 RPC | packages/api/src/routers/model.ts:224,307,407,439；packages/api/src/routers/ai.ts:286,333 → packages/api/src/services/modelRouter.ts:303,334；管理员用户诊断 packages/api/src/routers/diagnostics.ts:117 读取 api_key |
| ai_usage_logs | U R 本人使用情况；S R/I | packages/api/src/routers/user.ts:119；packages/api/src/routers/costs.ts:577；packages/api/src/services/billing.ts:1583；apps/web/src/app/api/ai/stream/route.ts:761 调用户读取计数 helper |
| announcements | P R；S R/I/U/D | packages/api/src/routers/settings.ts:194,234；packages/api/src/routers/admin.ts:1619,1690,1759,1781 |
| application_logs | 注入客户端 I；未找到生产 logger.init 调用，不应认定活跃写入 | packages/api/src/lib/logger.ts:85,103 |
| billing_history | S R/I/U（BillingService、reconciliation）；U R（security checks、管理员身份诊断） | packages/api/src/services/billing.ts:554,578,845；packages/api/src/middleware/securityChecks.ts:184；packages/api/src/services/diagnostics.ts:261 |
| conversation_context_snapshots | U I+U upsert；诊断用户 R | packages/api/src/services/contextSnapshots.ts:26；apps/web/src/app/api/ai/stream/route.ts:1153,1171；packages/api/src/services/diagnostics.ts:282 |
| conversations | U R/I/U；删除通过用户 RPC；S R/U 清理与管理 | packages/api/src/routers/chat.ts:81,334,350,364；packages/api/src/services/contextManager.ts:118,462,490；packages/api/src/routers/admin.ts:403 |
| credit_packages | P R；U R checkout；S R/I/U/D | packages/api/src/routers/settings.ts:342；packages/api/src/routers/payments.ts:1498；packages/api/src/routers/admin.ts:1522,1570,1592 |
| credit_transactions | U R；S R/I，原子账务 RPC | packages/api/src/routers/credits.ts:394,478；packages/api/src/routers/admin.ts:924,1066；packages/api/src/routers/credits.ts:256,357 |
| diagnostic_latest_results | 管理员用户客户端 U R | packages/api/src/services/diagnostics.ts:1115（构造见 routers/diagnostics.ts:159） |
| diagnostic_results | 管理员用户客户端 U R/I；清理 S RPC | packages/api/src/routers/diagnostics.ts:52,382,413；packages/api/src/services/diagnostics.ts:1216,1228 |
| invitation_records | U R 六个授权字段（含过滤 inviter_id）；S R/U；写入通过原子邀请 RPC | packages/api/src/routers/invitation.ts:523,579,507,209；packages/api/src/services/invitationSummary.ts:5 |
| invitations | S R/I；P 只调验证 RPC；当前个人面板不再依赖 U 直接访问 invitations | packages/api/src/routers/invitation.ts:125,154,191,541,557 |
| membership_plans | P R；U R；S R/I/U/D | packages/api/src/routers/settings.ts:392；packages/api/src/routers/chat.ts:149；packages/api/src/routers/payments.ts:1269；packages/api/src/routers/admin.ts:2696,2770,2792 |
| messages | U R；B R；S R；未被调用旧 helper I、ContextManager D 不应认定活跃功能 | packages/api/src/routers/chat.ts:107,172,432；apps/web/src/hooks/useStreamingChat.ts:243；packages/api/src/routers/admin.ts:1182；packages/api/src/routers/ai.ts:63,80 是旧 saveMessages helper，sendMessage 已关闭于 :230 |
| modules | P R 公开列；U R 安全入口、RPC 计数失败时 U UPDATE usage_count fallback；S R/I/U/D | packages/api/src/routers/modules.ts:111,168,195,217,224,231；packages/api/src/services/skills/databaseSource.ts:12,45；packages/api/src/routers/admin.ts:1968,2052,2187 |
| ordinary_chat_requests | S R；生命周期通过 S RPC | apps/web/src/lib/ordinary-chat-request.ts:47,54,18 |
| payment_orders | U R 本人账单和资格检查；S R/I/U checkout、webhook、recovery | packages/api/src/routers/payments.ts:2030,1651,1806,1972；packages/api/src/services/membershipEligibility.ts:489；packages/api/src/services/stripeFulfillment.ts |
| profiles | U R、UPDATE nickname/avatar_url/email；S R/I/D bootstrap、U role/status/credits/membership 管理及账务 | packages/api/src/trpc.ts:276,315,349,200；packages/api/src/routers/user.ts:19,68；packages/api/src/routers/admin.ts:680,1237,1333 |
| scheduled_job_runs | S R/I/U（admin/cron 调用注入 service） | packages/api/src/services/scheduledJobRuns.ts:22,47,66；packages/api/src/routers/admin.ts 调用；apps/web/src/app/api/cron/tickets/auto-close/route.ts:52 |
| skills | S R/I/U；公开模块正文经服务端读取后受控使用 | packages/api/src/routers/skills.ts:65,79,87,102；packages/api/src/services/skillRuntime.ts:39；apps/web/src/app/api/ai/stream/route.ts:480 传 service_role |
| subscription_credit_grants | S R/I；reconciliation 动态读 | packages/api/src/services/subscriptionCreditGrants.ts:1652,2105,2220；packages/api/src/services/billingReconciliation.ts:1704 |
| system_settings | P R 白名单；U R 签到/估算/诊断；S R/upsert | packages/api/src/routers/settings.ts:264,303,320；packages/api/src/routers/checkin.ts:48,85；packages/api/src/routers/ai.ts:294；packages/api/src/services/invitationRuntime.ts:149 |
| ticket_replies | U R（tickets 嵌套关系）/I；S R/I | packages/api/src/routers/ticket.ts:94,166,200；packages/api/src/routers/admin.ts:786,887；packages/api/src/services/ticketAutoClose.ts:130,162 |
| tickets | U R/I/U；S R/U | packages/api/src/routers/ticket.ts:94,135,166,227；packages/api/src/routers/admin.ts:721,861；packages/api/src/services/ticketAutoClose.ts:109,150 |
| token_stats | U R；S R/I | packages/api/src/routers/chat.ts:112,455；packages/api/src/routers/ai.ts:402；packages/api/src/routers/costs.ts:367；packages/api/src/services/billing.ts:1544 |
| user_activity_logs | S R/I；无普通用户活跃直接调用 | packages/api/src/routers/admin.ts:691,1083,1154,1401 |
| user_checkins | U R、用户 RPC 签到 | packages/api/src/routers/checkin.ts:90,96,102,144 |
| user_subscriptions | U R 资格/订阅检查 helper；S R/I/U | packages/api/src/services/membershipEligibility.ts:481（routers/payments.ts:846,1290 用户传参）；packages/api/src/services/subscriptionCreditGrants.ts:2544,2601,2637；packages/api/src/routers/admin.ts:1300,1349 |


### 间接访问的63表

S 调用受控 RPC，SQL 操作在函数身份下执行，不要求 S 自身持有这些表的相同 DML。代表映射使用本基线迁移定义；不证明数据库函数体与迁移逐字一致，也不是传递调用图的完全验证。每表 SQL 操作仅覆盖选定代表函数，后续触发器/其他分支不作推断。

| 表 | 客户端 / 代表SQL操作 | 代表RPC及代码位置 | 迁移SQL证据 |
| --- | --- | --- | --- |
| agent_confirmed_preferences | S / R,I,U | `agent_preference`：packages/api/src/services/agentSlice/preferences.ts:15 | packages/db/migrations/0081_agent_slice_preferences.sql:49；packages/db/migrations/0081_agent_slice_preferences.sql:32；packages/db/migrations/0081_agent_slice_preferences.sql:42；packages/db/migrations/0081_agent_slice_preferences.sql:46；packages/db/migrations/0081_agent_slice_preferences.sql:51；packages/db/migrations/0083_agent_slice_execution_identity.sql:33 |
| agent_preference_requests | S / R,I | `agent_preference`：packages/api/src/services/agentSlice/preferences.ts:15 | packages/db/migrations/0081_agent_slice_preferences.sql:52；packages/db/migrations/0081_agent_slice_preferences.sql:37 |
| agent_slice_calls | S / R,U | `agent_slice_call`：packages/api/src/services/agentSlice/recovery.ts:16；`agent_slice_record_final`：packages/api/src/services/agentSlice/accounting.ts:80 | packages/db/migrations/0097_agent_slice_prepared_recovery.sql:18；packages/db/migrations/0099_agent_slice_rejected_result_usage.sql:19；packages/db/migrations/0099_agent_slice_rejected_result_usage.sql:11；packages/db/migrations/0099_agent_slice_rejected_result_usage.sql:37 |
| agent_slice_executions | S / R | `agent_slice_admission_replay`：packages/api/src/services/agentSlice/admission.ts:19；`agent_slice_context`：packages/api/src/services/agentSlice/context.ts:22 | packages/db/migrations/0089_agent_slice_admission_replay.sql:9；packages/db/migrations/0094_agent_slice_discussion_context.sql:43；packages/db/migrations/0094_agent_slice_discussion_context.sql:45；packages/db/migrations/0098_agent_slice_revision_isolation.sql:11 |
| agent_slice_links | S / R,I | `agent_slice_assert_legacy_generation`：packages/api/src/services/artifacts/generation.ts:177；`agent_slice_link`：packages/api/src/services/agentSlice/links.ts:20 | packages/db/migrations/0101_agent_slice_legacy_generation_boundary.sql:11；packages/db/migrations/0082_agent_slice_artifact_links.sql:115；packages/db/migrations/0082_agent_slice_artifact_links.sql:79；packages/db/migrations/0082_agent_slice_artifact_links.sql:134 |
| agent_slice_pairs | S / R | `agent_slice_continue_work`：packages/api/src/services/agentSlice/continueWork.ts:10；`agent_slice_link`：packages/api/src/services/agentSlice/links.ts:20 | packages/db/migrations/0092_agent_slice_continue_work.sql:10；packages/db/migrations/0082_agent_slice_artifact_links.sql:88；packages/db/migrations/0082_agent_slice_artifact_links.sql:139 |
| artifact_accounts | S / R | `agent_preference`：packages/api/src/services/agentSlice/preferences.ts:15；`agent_slice_sources`：packages/api/src/services/agentSlice/entry.ts:12 | packages/db/migrations/0081_agent_slice_preferences.sql:29；packages/db/migrations/0098_agent_slice_revision_isolation.sql:84；packages/db/migrations/0070_v3_separate_summary.sql:355 |
| artifact_candidates | S / R | `agent_slice_context`：packages/api/src/services/agentSlice/context.ts:22；`agent_slice_link`：packages/api/src/services/agentSlice/links.ts:20 | packages/db/migrations/0094_agent_slice_discussion_context.sql:47；packages/db/migrations/0082_agent_slice_artifact_links.sql:85；packages/db/migrations/0070_v3_separate_summary.sql:274 |
| artifact_chat_summaries | S / R,I | `artifact_chat`：packages/api/src/services/artifacts/chat.ts:66 | packages/db/migrations/0070_v3_separate_summary.sql:222；packages/db/migrations/0070_v3_separate_summary.sql:208；packages/db/migrations/0070_v3_separate_summary.sql:218；packages/db/migrations/0070_v3_separate_summary.sql:272；packages/db/migrations/0070_v3_separate_summary.sql:300 |
| artifact_chat_turns | S / R,I | `artifact_chat`：packages/api/src/services/artifacts/chat.ts:66 | packages/db/migrations/0070_v3_separate_summary.sql:256；packages/db/migrations/0070_v3_separate_summary.sql:174；packages/db/migrations/0070_v3_separate_summary.sql:208；packages/db/migrations/0070_v3_separate_summary.sql:216；packages/db/migrations/0070_v3_separate_summary.sql:232；packages/db/migrations/0070_v3_separate_summary.sql:239；packages/db/migrations/0070_v3_separate_summary.sql:244；packages/db/migrations/0070_v3_separate_summary.sql:253；packages/db/migrations/0070_v3_separate_summary.sql:262；packages/db/migrations/0070_v3_separate_summary.sql:271；packages/db/migrations/0070_v3_separate_summary.sql:293；packages/db/migrations/0069_v3_chat_skill.sql:35 |
| artifact_chats | S / R,I,U | `artifact_chat`：packages/api/src/services/artifacts/chat.ts:66 | packages/db/migrations/0070_v3_separate_summary.sql:200；packages/db/migrations/0070_v3_separate_summary.sql:228；packages/db/migrations/0070_v3_separate_summary.sql:257；packages/db/migrations/0070_v3_separate_summary.sql:176；packages/db/migrations/0070_v3_separate_summary.sql:187；packages/db/migrations/0070_v3_separate_summary.sql:197；packages/db/migrations/0069_v3_chat_skill.sql:44；packages/db/migrations/0070_v3_separate_summary.sql:292 |
| artifact_confirmations | S / R | 间接，见迁移 | packages/db/migrations/0135_opc_account_edit_confirmation.sql:31 |
| artifact_evidence | S / R,I | `agent_slice_link`：packages/api/src/services/agentSlice/links.ts:20；`opc_account_strategy_begin`：packages/api/src/services/opc/service.ts:503 | packages/db/migrations/0082_agent_slice_artifact_links.sql:112；packages/db/migrations/0082_agent_slice_artifact_links.sql:111；packages/db/migrations/0134_opc_account_strategy_inheritance.sql:65；packages/db/migrations/0107_opc_workbench.sql:257 |
| artifact_evidence_restrictions | S / I | `agent_slice_link`：packages/api/src/services/agentSlice/links.ts:20；`opc_account_strategy_begin`：packages/api/src/services/opc/service.ts:503 | packages/db/migrations/0082_agent_slice_artifact_links.sql:114；packages/db/migrations/0134_opc_account_strategy_inheritance.sql:66；packages/db/migrations/0107_opc_workbench.sql:258 |
| artifact_generations | S / R | `agent_slice_link`：packages/api/src/services/agentSlice/links.ts:20；`artifact_chat`：packages/api/src/services/artifacts/chat.ts:66 | packages/db/migrations/0082_agent_slice_artifact_links.sql:84；packages/db/migrations/0070_v3_separate_summary.sql:174；packages/db/migrations/0070_v3_separate_summary.sql:175；packages/db/migrations/0070_v3_separate_summary.sql:208；packages/db/migrations/0070_v3_separate_summary.sql:217；packages/db/migrations/0070_v3_separate_summary.sql:221；packages/db/migrations/0070_v3_separate_summary.sql:245；packages/db/migrations/0070_v3_separate_summary.sql:253；packages/db/migrations/0070_v3_separate_summary.sql:271；packages/db/migrations/0070_v3_separate_summary.sql:273；packages/db/migrations/0070_v3_separate_summary.sql:280；packages/db/migrations/0101_agent_slice_legacy_generation_boundary.sql:25；packages/db/migrations/0101_agent_slice_legacy_generation_boundary.sql:26 |
| artifact_projects | S / R | `agent_slice_assert_legacy_generation`：packages/api/src/services/artifacts/generation.ts:177；`agent_slice_continue_work`：packages/api/src/services/agentSlice/continueWork.ts:10 | packages/db/migrations/0101_agent_slice_legacy_generation_boundary.sql:8；packages/db/migrations/0092_agent_slice_continue_work.sql:12；packages/db/migrations/0092_agent_slice_continue_work.sql:24；packages/db/migrations/0098_agent_slice_revision_isolation.sql:17 |
| artifact_reference_configs | S / R | `agent_slice_continue_work`：packages/api/src/services/agentSlice/continueWork.ts:10；`agent_slice_sources`：packages/api/src/services/agentSlice/entry.ts:12 | packages/db/migrations/0092_agent_slice_continue_work.sql:27；packages/db/migrations/0098_agent_slice_revision_isolation.sql:80；packages/db/migrations/0098_agent_slice_revision_isolation.sql:85；packages/db/migrations/0100_artifact_reference_revision_isolation.sql:12 |
| artifact_requests | S / R | `agent_slice_context`：packages/api/src/services/agentSlice/context.ts:22；`agent_slice_conversation`：packages/api/src/services/agentSlice/conversation.ts:14 | packages/db/migrations/0094_agent_slice_discussion_context.sql:50；packages/db/migrations/0098_agent_slice_revision_isolation.sql:31；packages/db/migrations/0082_agent_slice_artifact_links.sql:86 |
| artifact_rounds | S / R | `agent_slice_assert_legacy_generation`：packages/api/src/services/artifacts/generation.ts:177；`agent_slice_continue_work`：packages/api/src/services/agentSlice/continueWork.ts:10 | packages/db/migrations/0101_agent_slice_legacy_generation_boundary.sql:8；packages/db/migrations/0092_agent_slice_continue_work.sql:28；packages/db/migrations/0098_agent_slice_revision_isolation.sql:34 |
| artifact_versions | S / R | `agent_slice_continue_work`：packages/api/src/services/agentSlice/continueWork.ts:10；`agent_slice_link`：packages/api/src/services/agentSlice/links.ts:20 | packages/db/migrations/0092_agent_slice_continue_work.sql:11；packages/db/migrations/0092_agent_slice_continue_work.sql:22；packages/db/migrations/0082_agent_slice_artifact_links.sql:90；packages/db/migrations/0082_agent_slice_artifact_links.sql:136 |
| artifact_work_references | S / R | `agent_slice_continue_work`：packages/api/src/services/agentSlice/continueWork.ts:10；`agent_slice_targets`：packages/api/src/services/agentSlice/entry.ts:12 | packages/db/migrations/0092_agent_slice_continue_work.sql:20；packages/db/migrations/0098_agent_slice_revision_isolation.sql:54；packages/db/migrations/0080_account_artifact_reuse.sql:179 |
| artifact_workflows | S / R,I,U | `admin_publish_skill_module`：packages/api/src/services/skills/modulePublication.ts:79；`admin_read_skill_module`：packages/api/src/routers/skills.ts:49 | packages/db/migrations/0072_v3_admin_skill_modules.sql:127；packages/db/migrations/0072_v3_admin_skill_modules.sql:126；packages/db/migrations/0072_v3_admin_skill_modules.sql:99；packages/db/migrations/0072_v3_admin_skill_modules.sql:117；packages/db/migrations/0072_v3_admin_skill_modules.sql:125；packages/db/migrations/0072_v3_admin_skill_modules.sql:146；packages/db/migrations/0072_v3_admin_skill_modules.sql:147；packages/db/migrations/0092_agent_slice_continue_work.sql:27 |
| bill2_calls | S / R,I,U | `bill2_cancel`：packages/api/src/services/bill2/service.ts:160；`bill2_claim`：packages/api/src/services/bill2/service.ts:108 | packages/db/migrations/0105_v3_bill2_authoritative_runs.sql:320；packages/db/migrations/0108_runtime_staging_window.sql:234；packages/db/migrations/0108_runtime_staging_window.sql:223；packages/db/migrations/0108_runtime_staging_window.sql:226；packages/db/migrations/0105_v3_bill2_authoritative_runs.sql:310 |
| bill2_drafts | S / R,I,U | `bill2_create_draft`：packages/api/src/services/bill2/service.ts:98；`bill2_revoke_draft`：packages/api/src/services/bill2/service.ts:99 | packages/db/migrations/0105_v3_bill2_authoritative_runs.sql:116；packages/db/migrations/0105_v3_bill2_authoritative_runs.sql:118；packages/db/migrations/0107_opc_workbench.sql:76 |
| bill2_provider_ids | S / R,I | `bill2_record`：packages/api/src/services/bill2/service.ts:66；`bill2_revoke_unstarted_dispatch`：packages/api/src/services/bill2/service.ts:139 | packages/db/migrations/0105_v3_bill2_authoritative_runs.sql:229；packages/db/migrations/0105_v3_bill2_authoritative_runs.sql:230；packages/db/migrations/0137_bill2_unstarted_dispatch.sql:33 |
| bill2_receipts | S / R,I | `bill2_finalize`：packages/api/src/services/bill2/service.ts:69；`bill2_record`：packages/api/src/services/bill2/service.ts:66 | packages/db/migrations/0105_v3_bill2_authoritative_runs.sql:465；packages/db/migrations/0105_v3_bill2_authoritative_runs.sql:238；packages/db/migrations/0105_v3_bill2_authoritative_runs.sql:286；packages/db/migrations/0105_v3_bill2_authoritative_runs.sql:226；packages/db/migrations/0105_v3_bill2_authoritative_runs.sql:258；packages/db/migrations/0105_v3_bill2_authoritative_runs.sql:267；packages/db/migrations/0105_v3_bill2_authoritative_runs.sql:272；packages/db/migrations/0105_v3_bill2_authoritative_runs.sql:276；packages/db/migrations/0105_v3_bill2_authoritative_runs.sql:283；packages/db/migrations/0137_bill2_unstarted_dispatch.sql:32 |
| bill2_runs | S / R | `atomic_abort_settle`：packages/api/src/services/billing.ts:1217；`atomic_finalize_ai_failure`：packages/api/src/services/billing.ts:1479 | packages/db/migrations/0105_v3_bill2_authoritative_runs.sql:344；packages/db/migrations/0105_v3_bill2_authoritative_runs.sql:402；packages/db/migrations/0105_v3_bill2_authoritative_runs.sql:377 |
| opc_account_strategy_drafts | S / R,U | `artifact_publish_current`：packages/api/src/services/artifacts/workbench.ts:225；`artifact_query`：packages/api/src/services/research/workbenchSearch.ts:41 | packages/db/migrations/0135_opc_account_edit_confirmation.sql:117；packages/db/migrations/0134_opc_account_strategy_inheritance.sql:258；packages/db/migrations/0135_opc_account_edit_confirmation.sql:104；packages/db/migrations/0135_opc_account_edit_confirmation.sql:69；packages/db/migrations/0135_opc_account_edit_confirmation.sql:70；packages/db/migrations/0135_opc_account_edit_confirmation.sql:80；packages/db/migrations/0135_opc_account_edit_confirmation.sql:91 |
| opc_account_strategy_request_bases | S / R,I | `opc_account_strategy_save_checked`：packages/api/src/services/opc/service.ts:506 | packages/db/migrations/0126_opc_account_strategy_schema.sql:119；packages/db/migrations/0126_opc_account_strategy_schema.sql:68 |
| opc_account_ui | S / R,I,U | `opc_account_ui_change`：packages/api/src/services/opc/service.ts:494；`runtime_workspace_source`：packages/api/src/services/runtime/execute.ts:183 | packages/db/migrations/0124_opc_workspace_ui.sql:53；packages/db/migrations/0124_opc_workspace_ui.sql:49；packages/db/migrations/0124_opc_workspace_ui.sql:46；packages/db/migrations/0131_runtime_workspace_sources.sql:22；packages/db/migrations/0131_runtime_workspace_sources.sql:25 |
| opc_accounts | S / R,U | `artifact_publish_current`：packages/api/src/services/artifacts/workbench.ts:225；`artifact_transition`：packages/api/src/services/artifacts/store.ts:39 | packages/db/migrations/0135_opc_account_edit_confirmation.sql:117；packages/db/migrations/0135_opc_account_edit_confirmation.sql:103；packages/db/migrations/0135_opc_account_edit_confirmation.sql:70；packages/db/migrations/0135_opc_account_edit_confirmation.sql:89；packages/db/migrations/0134_opc_account_strategy_inheritance.sql:16 |
| opc_businesses | S / R,U | `artifact_transition`：packages/api/src/services/artifacts/store.ts:39；`opc_library_edit`：packages/api/src/services/opc/service.ts:510 | packages/db/migrations/0135_opc_account_edit_confirmation.sql:102；packages/db/migrations/0135_opc_account_edit_confirmation.sql:95；packages/db/migrations/0123_opc_manual_content.sql:112；packages/db/migrations/0134_opc_account_strategy_inheritance.sql:212 |
| opc_content_versions | S / R,I | `opc_content_from_execution`：packages/api/src/services/opc/service.ts:520；`opc_content_manual_save`：packages/api/src/services/opc/service.ts:532 | packages/db/migrations/0122_opc_content_type.sql:143；packages/db/migrations/0122_opc_content_type.sql:135；packages/db/migrations/0122_opc_content_type.sql:140；packages/db/migrations/0122_opc_content_type.sql:142；packages/db/migrations/0128_opc_script_ancestry.sql:83；packages/db/migrations/0128_opc_script_ancestry.sql:49；packages/db/migrations/0128_opc_script_ancestry.sql:59；packages/db/migrations/0128_opc_script_ancestry.sql:63；packages/db/migrations/0128_opc_script_ancestry.sql:74；packages/db/migrations/0128_opc_script_ancestry.sql:78；packages/db/migrations/0124_opc_workspace_ui.sql:137 |
| opc_draft_businesses | S / R,I | `opc_account_strategy_begin`：packages/api/src/services/opc/service.ts:503；`opc_adopt_topics`：packages/api/src/services/opc/service.ts:471 | packages/db/migrations/0134_opc_account_strategy_inheritance.sql:54；packages/db/migrations/0118_opc_b1_acceptance.sql:45；packages/db/migrations/0117_opc_core_experience.sql:194 |
| opc_drafts | S / R | `artifact_publish_current`：packages/api/src/services/artifacts/workbench.ts:225；`artifact_query`：packages/api/src/services/research/workbenchSearch.ts:41 | packages/db/migrations/0135_opc_account_edit_confirmation.sql:117；packages/db/migrations/0134_opc_account_strategy_inheritance.sql:258；packages/db/migrations/0135_opc_account_edit_confirmation.sql:69；packages/db/migrations/0135_opc_account_edit_confirmation.sql:70；packages/db/migrations/0135_opc_account_edit_confirmation.sql:81 |
| opc_handoffs | S / R,I | 间接，见迁移 | packages/db/migrations/0107_opc_workbench.sql:184；packages/db/migrations/0107_opc_workbench.sql:146 |
| opc_item_edits | S / R,I,U | `opc_library_edit`：packages/api/src/services/opc/service.ts:510；`opc_work_ui_change`：packages/api/src/services/opc/service.ts:490 | packages/db/migrations/0123_opc_manual_content.sql:127；packages/db/migrations/0123_opc_manual_content.sql:123；packages/db/migrations/0123_opc_manual_content.sql:128；packages/db/migrations/0127_opc_work_name_sync.sql:53；packages/db/migrations/0127_opc_work_name_sync.sql:51；packages/db/migrations/0127_opc_work_name_sync.sql:49；packages/db/migrations/0131_runtime_workspace_sources.sql:25；packages/db/migrations/0131_runtime_workspace_sources.sql:37 |
| opc_items | S / R | `artifact_query`：packages/api/src/services/research/workbenchSearch.ts:41；`opc_adopt_topics`：packages/api/src/services/opc/service.ts:471 | packages/db/migrations/0134_opc_account_strategy_inheritance.sql:265；packages/db/migrations/0118_opc_b1_acceptance.sql:49；packages/db/migrations/0122_opc_content_type.sql:129 |
| opc_library_requests | S / R,I | `opc_account_strategy_save_checked`：packages/api/src/services/opc/service.ts:506；`opc_account_ui_change`：packages/api/src/services/opc/service.ts:494 | packages/db/migrations/0126_opc_account_strategy_schema.sql:65；packages/db/migrations/0124_opc_workspace_ui.sql:57；packages/db/migrations/0124_opc_workspace_ui.sql:41；packages/db/migrations/0123_opc_manual_content.sql:135；packages/db/migrations/0123_opc_manual_content.sql:108 |
| opc_plans | S / R,I | `opc_adopt_topics`：packages/api/src/services/opc/service.ts:471；`opc_save_plan`：packages/api/src/services/opc/service.ts:589 | packages/db/migrations/0118_opc_b1_acceptance.sql:44；packages/db/migrations/0118_opc_b1_acceptance.sql:50；packages/db/migrations/0122_opc_content_type.sql:39；packages/db/migrations/0122_opc_content_type.sql:24；packages/db/migrations/0122_opc_content_type.sql:29；packages/db/migrations/0107_opc_workbench.sql:151；packages/db/migrations/0107_opc_workbench.sql:154 |
| opc_publication_ui | S / R,I,U | `opc_publication_ui_change`：packages/api/src/services/opc/service.ts:498 | packages/db/migrations/0124_opc_workspace_ui.sql:147；packages/db/migrations/0124_opc_workspace_ui.sql:149；packages/db/migrations/0124_opc_workspace_ui.sql:142；packages/db/migrations/0124_opc_workspace_ui.sql:89 |
| opc_result_links | S / R,I | `artifact_save_candidate`：packages/api/src/services/artifacts/workbench.ts:226；`opc_save_result`：packages/api/src/services/opc/service.ts:290 | packages/db/migrations/0107_opc_workbench.sql:314；packages/db/migrations/0107_opc_workbench.sql:262；packages/db/migrations/0107_opc_workbench.sql:254；packages/db/migrations/0107_opc_workbench.sql:347 |
| opc_topic_draft_versions | S / R,I | `opc_topic_draft_read`：packages/api/src/services/opc/service.ts:468；`opc_topic_draft_save`：packages/api/src/services/opc/service.ts:460 | packages/db/migrations/0117_opc_core_experience.sql:181；packages/db/migrations/0122_opc_content_type.sql:67；packages/db/migrations/0122_opc_content_type.sql:52；packages/db/migrations/0122_opc_content_type.sql:55 |
| opc_topic_openings | S / R,I | `opc_topic_consent`：packages/api/src/services/opc/service.ts:369；`opc_topic_read`：packages/api/src/services/opc/service.ts:361 | packages/db/migrations/0114_opc_topic_consent.sql:30；packages/db/migrations/0114_opc_topic_consent.sql:46 |
| opc_topic_workspaces | S / R,I | `opc_free_conversations`：packages/api/src/routers/opc.ts:158；`opc_topic_bind`：packages/api/src/services/opc/service.ts:373 | packages/db/migrations/0130_runtime_conversations.sql:16；packages/db/migrations/0113_opc_topic_workspace.sql:113；packages/db/migrations/0113_opc_topic_workspace.sql:86；packages/db/migrations/0113_opc_topic_workspace.sql:116；packages/db/migrations/0114_opc_topic_consent.sql:23；packages/db/migrations/0114_opc_topic_consent.sql:29 |
| opc_turns | S / R | `opc_plan_request_state`：packages/api/src/services/opc/service.ts:351；`opc_plan_result`：packages/api/src/services/opc/service.ts:298 | packages/db/migrations/0112_opc_plan_request_state.sql:22；packages/db/migrations/0115_opc_historical_plan_result.sql:11；packages/db/migrations/0115_opc_historical_plan_result.sql:14；packages/db/migrations/0107_opc_workbench.sql:246 |
| opc_video_material_bindings | S / R,I | `opc_video_execution_check`：packages/api/src/services/opc/service.ts:569；`opc_video_material_prepare`：packages/api/src/services/opc/service.ts:577 | packages/db/migrations/0132_opc_video_execution_ancestry.sql:21；packages/db/migrations/0122_opc_content_type.sql:261；packages/db/migrations/0122_opc_content_type.sql:164；packages/db/migrations/0122_opc_content_type.sql:189；packages/db/migrations/0122_opc_content_type.sql:219；packages/db/migrations/0119_opc_video_admission.sql:122 |
| opc_work_ui | S / R,I,U | `opc_work_ui_change`：packages/api/src/services/opc/service.ts:490 | packages/db/migrations/0127_opc_work_name_sync.sql:39；packages/db/migrations/0127_opc_work_name_sync.sql:41；packages/db/migrations/0127_opc_work_name_sync.sql:33；packages/db/migrations/0127_opc_work_name_sync.sql:7 |
| prompts | S / R,D | `admin_delete_unused_model`：packages/api/src/routers/model.ts:439 | packages/db/migrations/0074_admin_model_delete.sql:38；packages/db/migrations/0070_v3_separate_summary.sql:382 |
| research_operations | S / R | `research_billing_summary`：packages/api/src/services/billingReconciliation.ts:1821；`research_cancel`：packages/api/src/services/research/store.ts:56 | packages/db/migrations/0071_v3_research_billing.sql:62；packages/db/migrations/0071_v3_research_billing.sql:74；packages/db/migrations/0071_v3_research_billing.sql:89 |
| research_plans | S / R,I,U | `research_lookup`：packages/api/src/services/research/workbenchSearch.ts:64；`research_transition`：packages/api/src/services/research/store.ts:28 | packages/db/migrations/0071_v3_research_billing.sql:84；packages/db/migrations/0066_v3_artifact_transactions.sql:349；packages/db/migrations/0066_v3_artifact_transactions.sql:387；packages/db/migrations/0066_v3_artifact_transactions.sql:398；packages/db/migrations/0066_v3_artifact_transactions.sql:411；packages/db/migrations/0066_v3_artifact_transactions.sql:352；packages/db/migrations/0071_v3_research_billing.sql:14 |
| runtime_executions | S / R | `artifact_save_candidate`：packages/api/src/services/artifacts/workbench.ts:226；`opc_content_from_execution`：packages/api/src/services/opc/service.ts:520 | packages/db/migrations/0107_opc_workbench.sql:314；packages/db/migrations/0122_opc_content_type.sql:131；packages/db/migrations/0130_runtime_conversations.sql:19；packages/db/migrations/0130_runtime_conversations.sql:24 |
| runtime_history_dependencies | S / R,I | `runtime_session_items`：packages/api/src/services/runtime/session.ts:23 | packages/db/migrations/0106_runtime_sessions.sql:288；packages/db/migrations/0106_runtime_sessions.sql:603；packages/db/migrations/0106_runtime_sessions.sql:604 |
| runtime_scope_material | S / R | `opc_content_from_execution`：packages/api/src/services/opc/service.ts:520；`opc_content_manual_save`：packages/api/src/services/opc/service.ts:532 | packages/db/migrations/0122_opc_content_type.sql:146；packages/db/migrations/0128_opc_script_ancestry.sql:88；packages/db/migrations/0123_opc_manual_content.sql:131 |
| runtime_session_batches | S / R,I | `runtime_execution`：packages/api/src/services/runtime/view.ts:16；`runtime_session_items`：packages/api/src/services/runtime/session.ts:23 | packages/db/migrations/0106_runtime_sessions.sql:425；packages/db/migrations/0106_runtime_sessions.sql:445；packages/db/migrations/0106_runtime_sessions.sql:459；packages/db/migrations/0106_runtime_sessions.sql:302；packages/db/migrations/0106_runtime_sessions.sql:295；packages/db/migrations/0106_runtime_sessions.sql:300 |
| runtime_session_history | S / R,I | `runtime_admit`：packages/api/src/services/runtime/admission.ts:181；`runtime_session_items`：packages/api/src/services/runtime/session.ts:23 | packages/db/migrations/0138_runtime_stopped_pending.sql:44；packages/db/migrations/0106_runtime_sessions.sql:303；packages/db/migrations/0106_runtime_sessions.sql:272；packages/db/migrations/0106_runtime_sessions.sql:284；packages/db/migrations/0106_runtime_sessions.sql:289 |
| runtime_sessions | S / R | `opc_content_from_execution`：packages/api/src/services/opc/service.ts:520；`opc_content_manual_save`：packages/api/src/services/opc/service.ts:532 | packages/db/migrations/0122_opc_content_type.sql:130；packages/db/migrations/0128_opc_script_ancestry.sql:46；packages/db/migrations/0130_runtime_conversations.sql:12 |
| runtime_test_windows | S / R | `runtime_financial_recovery`：packages/api/src/services/runtime/execute.ts:59；`runtime_test_actor_access`：packages/api/src/services/runtime/stagingPolicy.ts:40 | packages/db/migrations/0108_runtime_staging_window.sql:288；packages/db/migrations/0108_runtime_staging_window.sql:256；packages/db/migrations/0108_runtime_staging_window.sql:84 |
| runtime_tool_calls | S / R,I,U | `runtime_execution`：packages/api/src/services/runtime/view.ts:16；`runtime_tool`：packages/api/src/services/runtime/execute.ts:179 | packages/db/migrations/0106_runtime_sessions.sql:430；packages/db/migrations/0106_runtime_sessions.sql:451；packages/db/migrations/0106_runtime_sessions.sql:366；packages/db/migrations/0106_runtime_sessions.sql:358；packages/db/migrations/0106_runtime_sessions.sql:351；packages/db/migrations/0106_runtime_sessions.sql:364；packages/db/migrations/0131_runtime_workspace_sources.sql:55 |
| skill_package_files | S / R,I | `admin_read_skill_module`：packages/api/src/routers/skills.ts:49；`atomic_publish_skill_package`：packages/api/src/services/skills/publication.ts:19 | packages/db/migrations/0072_v3_admin_skill_modules.sql:152；packages/db/migrations/0072_v3_admin_skill_modules.sql:70；packages/db/migrations/0072_v3_admin_skill_modules.sql:25；packages/db/migrations/0064_v3_private_skill_packages.sql:173 |
| skill_packages | S / R,I | `admin_read_skill_module`：packages/api/src/routers/skills.ts:49；`atomic_publish_skill_package`：packages/api/src/services/skills/publication.ts:19 | packages/db/migrations/0072_v3_admin_skill_modules.sql:149；packages/db/migrations/0072_v3_admin_skill_modules.sql:69；packages/db/migrations/0072_v3_admin_skill_modules.sql:19；packages/db/migrations/0064_v3_private_skill_packages.sql:165 |
| skill_revision_revocations | S / R,I | `is_text_skill_executable`：packages/api/src/services/skillRuntime.ts:52；`read_skill_package`：packages/api/src/services/skills/databaseSource.ts:58 | packages/db/migrations/0064_v3_private_skill_packages.sql:195；packages/db/migrations/0064_v3_private_skill_packages.sql:169；packages/db/migrations/0106_runtime_sessions.sql:584 |
| skill_revisions | S / R,I | `atomic_publish_skill`：packages/api/src/routers/skills.ts:94；`atomic_publish_skill_package`：packages/api/src/services/skills/publication.ts:19 | packages/db/migrations/0062_skill_1a_db_publish_contract.sql:333；packages/db/migrations/0072_v3_admin_skill_modules.sql:67；packages/db/migrations/0108_runtime_staging_window.sql:189 |

### RPC调用与有效 EXECUTE

133 个代码引用名（包括字符串 helper、rpcFn.call）；按同名全部签名检查。opc_video_material_prepare 特别核对：代码七个业务参数加 helper 的 p_actor_id 使用8参签名（`packages/api/src/services/opc/service.ts:84`、`:577`），旧4参收权不影响该调用。表内 `是` 表示该调用角色对同名目录函数均可执行，`缺失` 表示 public 无该名称。只校验 EXECUTE 与签名目录，不证明参数兼容、函数内条件、实际请求成功。U 的 soft_delete_conversation 对 S 无 EXECUTE 是预期收权，不是故障。

| RPC | 客户端 | 当前EXECUTE | 代码证据 |
| --- | --- | --- | --- |
| admin_delete_unused_model | service_role | 是 | `packages/api/src/routers/model.ts:439` |
| admin_publish_skill_module | service_role | 是 | `packages/api/src/services/skills/modulePublication.ts:79` |
| admin_read_skill_module | service_role | 是 | `packages/api/src/routers/skills.ts:49` |
| agent_preference | service_role | 是 | `packages/api/src/services/agentSlice/preferences.ts:15` |
| agent_slice_admission_replay | service_role | 是 | `packages/api/src/services/agentSlice/admission.ts:19` |
| agent_slice_admit | service_role | 是 | `packages/api/src/services/agentSlice/admission.ts:44` |
| agent_slice_assert_legacy_generation | service_role | 是 | `packages/api/src/services/artifacts/generation.ts:177` |
| agent_slice_call | service_role | 是 | `packages/api/src/services/agentSlice/recovery.ts:16`; `packages/api/src/services/agentSlice/recovery.ts:21`; `packages/api/src/services/agentSlice/accounting.ts:29` |
| agent_slice_context | service_role | 是 | `packages/api/src/services/agentSlice/context.ts:22` |
| agent_slice_continue_work | service_role | 是 | `packages/api/src/services/agentSlice/continueWork.ts:10` |
| agent_slice_conversation | service_role | 是 | `packages/api/src/services/agentSlice/conversation.ts:14` |
| agent_slice_link | service_role | 是 | `packages/api/src/services/agentSlice/links.ts:20` |
| agent_slice_link_read | service_role | 是 | `packages/api/src/services/agentSlice/links.ts:18` |
| agent_slice_open | service_role | 是 | `packages/api/src/services/agentSlice/entry.ts:12`; `packages/api/src/services/agentSlice/entry.ts:19` |
| agent_slice_record_final | service_role | 是 | `packages/api/src/services/agentSlice/accounting.ts:80` |
| agent_slice_result | service_role | 是 | `packages/api/src/services/agentSlice/results.ts:25`; `packages/api/src/services/agentSlice/accounting.ts:84` |
| agent_slice_selected_source | service_role | 是 | `packages/api/src/services/agentSlice/artifactReader.ts:25` |
| agent_slice_sources | service_role | 是 | `packages/api/src/services/agentSlice/entry.ts:12`; `packages/api/src/services/agentSlice/entry.ts:19` |
| agent_slice_targets | service_role | 是 | `packages/api/src/services/agentSlice/entry.ts:12`; `packages/api/src/services/agentSlice/entry.ts:19` |
| artifact_chat | service_role | 是 | `packages/api/src/services/artifacts/chat.ts:66`; `packages/api/src/services/artifacts/generation.ts:251`; `packages/api/src/services/artifacts/generation.ts:255`; `packages/api/src/services/artifacts/generation.ts:340` |
| artifact_create_work | service_role | 是 | `packages/api/src/services/artifacts/reuse.ts:29` |
| artifact_generation | service_role | 是 | `packages/api/src/services/artifacts/generation.ts:169` |
| artifact_module_catalog | service_role | 是 | `packages/api/src/services/artifacts/workbench.ts:105` |
| artifact_observe_generation | service_role | 是 | `packages/api/src/services/artifacts/generation.ts:367` |
| artifact_publish_current | service_role | 是 | `packages/api/src/services/artifacts/workbench.ts:225` |
| artifact_query | service_role | 是 | `packages/api/src/services/research/workbenchSearch.ts:41`; `packages/api/src/services/research/workbenchSearch.ts:49`; `packages/api/src/services/artifacts/workbench.ts:88`; `packages/api/src/services/artifacts/generation.ts:185`; `packages/api/src/services/artifacts/generation.ts:220`; `packages/api/src/services/opc/service.ts:118`; `packages/api/src/services/opc/service.ts:327`; `packages/api/src/services/opc/service.ts:392`; `packages/api/src/services/agentSlice/admission.ts:21` |
| artifact_reference_choices | service_role | 是 | `packages/api/src/services/artifacts/reuse.ts:36` |
| artifact_reject_generation | service_role | 是 | `packages/api/src/services/artifacts/generation.ts:387` |
| artifact_save_candidate | service_role | 是 | `packages/api/src/services/artifacts/workbench.ts:226` |
| artifact_transition | service_role | 是 | `packages/api/src/services/artifacts/store.ts:39` |
| artifact_work_source | service_role | 是 | `packages/api/src/services/artifacts/reuse.ts:33`; `packages/api/src/services/artifacts/generation.ts:239` |
| atomic_abort_settle | service_role | 是 | `packages/api/src/services/billing.ts:1217` |
| atomic_apply_credit_ledger_entry | service_role | 是 | `packages/api/src/trpc.ts:171`; `packages/api/src/routers/admin.ts:1066`; `packages/api/src/services/subscriptionCreditGrants.ts:2127` |
| atomic_apply_invitation_rebate | service_role | 是 | `packages/api/src/services/invitationRebate.ts:89` |
| atomic_claim_invitation_code | service_role | 是 | `packages/api/src/routers/invitation.ts:209`; `packages/api/src/routers/invitation.ts:316` |
| atomic_finalize_ai_failure | service_role | 是 | `packages/api/src/services/billing.ts:1479` |
| atomic_finalize_ai_success | service_role | 是 | `packages/api/src/services/billing.ts:1362`; `apps/web/src/lib/ordinary-chat-request.ts:28` |
| atomic_fulfill_credit_package | service_role | 是 | `packages/api/src/services/stripeFulfillment.ts:2218` |
| atomic_grant_annual_subscription_credits | service_role | 是 | `packages/api/src/services/subscriptionCreditGrants.ts:2270` |
| atomic_grant_subscription_invoice_credits | service_role | 是 | `packages/api/src/services/subscriptionCreditGrants.ts:2345` |
| atomic_pre_deduct | service_role | 是 | `packages/api/src/services/billing.ts:752` |
| atomic_publish_skill | service_role | 是 | `packages/api/src/routers/skills.ts:94` |
| atomic_publish_skill_package | service_role | 是 | `packages/api/src/services/skills/publication.ts:19` |
| atomic_reconcile_stripe_refund | service_role | 是 | `packages/api/src/services/stripeFulfillment.ts:2285` |
| atomic_refund | service_role | 是 | `packages/api/src/services/billing.ts:1059` |
| atomic_refund_termination_clawback_fresh | service_role | 是 | `packages/api/src/services/subscriptionCreditGrants.ts:1792` |
| atomic_settle | service_role | 是 | `packages/api/src/services/billing.ts:907` |
| bill2_cancel | service_role | 是 | `packages/api/src/services/bill2/service.ts:160` |
| bill2_claim | service_role | 是 | `packages/api/src/services/bill2/service.ts:108` |
| bill2_close | service_role | 是 | `packages/api/src/services/bill2/service.ts:159` |
| bill2_create_draft | service_role | 是 | `packages/api/src/services/bill2/service.ts:98` |
| bill2_dispatch | service_role | 是 | `packages/api/src/services/bill2/service.ts:114`; `packages/api/src/services/bill2/service.ts:129` |
| bill2_finalize | service_role | 是 | `packages/api/src/services/bill2/service.ts:69` |
| bill2_pending_calls | service_role | 是 | `packages/api/src/services/bill2/service.ts:83` |
| bill2_prepare | service_role | 是 | `packages/api/src/services/bill2/service.ts:104` |
| bill2_private_input | service_role | 是 | `packages/api/src/services/bill2/service.ts:100` |
| bill2_read | service_role | 是 | `packages/api/src/services/bill2/service.ts:65` |
| bill2_record | service_role | 是 | `packages/api/src/services/bill2/service.ts:66` |
| bill2_recovery_claim | service_role | 是 | `packages/api/src/services/bill2/service.ts:86` |
| bill2_revoke_draft | service_role | 是 | `packages/api/src/services/bill2/service.ts:99` |
| bill2_revoke_unstarted_dispatch | service_role | 是 | `packages/api/src/services/bill2/service.ts:139`; `packages/api/src/services/bill2/service.ts:142`; `packages/api/src/services/bill2/service.ts:145`; `packages/api/src/services/bill2/service.ts:146` |
| claim_daily_checkin | authenticated | 是 | `packages/api/src/routers/checkin.ts:144` |
| cleanup_old_diagnostic_results | service_role | 缺失 | `packages/api/src/routers/diagnostics.ts:413` |
| get_diagnostic_summary | service_role | 缺失 | `packages/api/src/services/diagnostics.ts:1153` |
| get_test_history | service_role | 缺失 | `packages/api/src/services/diagnostics.ts:1134` |
| increment_module_usage | authenticated | 缺失 | `packages/api/src/routers/modules.ts:217` |
| is_text_skill_executable | service_role | 是 | `packages/api/src/services/skillRuntime.ts:52` |
| opc_account_strategy_begin | service_role | 是 | `packages/api/src/services/opc/service.ts:503` |
| opc_account_strategy_history | service_role | 是 | `packages/api/src/services/opc/service.ts:501` |
| opc_account_strategy_save_checked | service_role | 是 | `packages/api/src/services/opc/service.ts:506` |
| opc_account_strategy_schema | service_role | 是 | `packages/api/src/services/opc/service.ts:502` |
| opc_account_ui_change | service_role | 是 | `packages/api/src/services/opc/service.ts:494` |
| opc_adopt_topics | service_role | 是 | `packages/api/src/services/opc/service.ts:471` |
| opc_content_from_execution | service_role | 是 | `packages/api/src/services/opc/service.ts:520` |
| opc_content_manual_save | service_role | 是 | `packages/api/src/services/opc/service.ts:532` |
| opc_free_conversations | service_role | 是 | `packages/api/src/routers/opc.ts:158` |
| opc_handoff_b1 | service_role | 是 | `packages/api/src/services/opc/service.ts:599` |
| opc_information | service_role | 是 | `packages/api/src/services/opc/service.ts:96` |
| opc_library | service_role | 是 | `packages/api/src/services/opc/service.ts:486` |
| opc_library_edit | service_role | 是 | `packages/api/src/services/opc/service.ts:510` |
| opc_plan_request_state | service_role | 是 | `packages/api/src/services/opc/service.ts:351` |
| opc_plan_result | service_role | 是 | `packages/api/src/services/opc/service.ts:298` |
| opc_position_history | service_role | 是 | `packages/api/src/services/opc/service.ts:500` |
| opc_publication_ui_change | service_role | 是 | `packages/api/src/services/opc/service.ts:498` |
| opc_query | service_role | 是 | `packages/api/src/routers/runtime.ts:55`; `packages/api/src/services/opc/service.ts:106`; `packages/api/src/services/opc/service.ts:343`; `packages/api/src/services/opc/service.ts:388`; `packages/api/src/services/opc/service.ts:447` |
| opc_revise | service_role | 是 | `packages/api/src/services/opc/service.ts:315` |
| opc_save_plan | service_role | 是 | `packages/api/src/services/opc/service.ts:589` |
| opc_save_result | service_role | 是 | `packages/api/src/services/opc/service.ts:290` |
| opc_start_b1 | service_role | 是 | `packages/api/src/services/opc/service.ts:450` |
| opc_step_material | service_role | 是 | `packages/api/src/services/opc/service.ts:178`; `packages/api/src/services/opc/service.ts:256` |
| opc_topic_bind | service_role | 是 | `packages/api/src/services/opc/service.ts:373` |
| opc_topic_consent | service_role | 是 | `packages/api/src/services/opc/service.ts:369` |
| opc_topic_draft_read | service_role | 是 | `packages/api/src/services/opc/service.ts:468` |
| opc_topic_draft_save | service_role | 是 | `packages/api/src/services/opc/service.ts:460` |
| opc_topic_material | service_role | 是 | `packages/api/src/services/opc/service.ts:402` |
| opc_topic_read | service_role | 是 | `packages/api/src/services/opc/service.ts:361`; `packages/api/src/services/opc/service.ts:389` |
| opc_video_execution_check | service_role | 是 | `packages/api/src/services/opc/service.ts:569` |
| opc_video_material_prepare | service_role | 当前8参签名是；旧4参签名否（预期） | `packages/api/src/services/opc/service.ts:577` |
| opc_video_package_from_execution | service_role | 是 | `packages/api/src/services/opc/service.ts:545` |
| opc_video_results_from_execution | service_role | 是 | `packages/api/src/services/opc/service.ts:556` |
| opc_work_result | service_role | 是 | `packages/api/src/services/opc/service.ts:321` |
| opc_work_results | service_role | 是 | `packages/api/src/services/opc/service.ts:323` |
| opc_work_ui_change | service_role | 是 | `packages/api/src/services/opc/service.ts:490` |
| ordinary_chat_claim | service_role | 是 | `apps/web/src/lib/ordinary-chat-request.ts:54` |
| ordinary_chat_transition | service_role | 是 | `apps/web/src/lib/ordinary-chat-request.ts:18` |
| read_skill_package | service_role | 是 | `packages/api/src/services/skills/databaseSource.ts:58` |
| research_billing_summary | service_role | 是 | `packages/api/src/services/billingReconciliation.ts:1821` |
| research_cancel | service_role | 是 | `packages/api/src/services/research/store.ts:56` |
| research_lookup | service_role | 是 | `packages/api/src/services/research/workbenchSearch.ts:64`; `packages/api/src/services/research/workbenchSearch.ts:82` |
| research_transition | service_role | 是 | `packages/api/src/services/research/store.ts:28` |
| research_user_charge | service_role | 是 | `packages/api/src/services/research/store.ts:47` |
| revoke_skill_revision | service_role | 是 | `packages/api/src/routers/skills.ts:59` |
| runtime_admission_replay | service_role | 是 | `packages/api/src/services/opc/service.ts:169`; `packages/api/src/services/opc/service.ts:422`; `packages/api/src/services/runtime/admission.ts:72`; `packages/api/src/services/runtime/admission.ts:186` |
| runtime_admit | service_role | 是 | `packages/api/src/services/runtime/admission.ts:181` |
| runtime_cancel | service_role | 是 | `packages/api/src/routers/runtime.ts:88`; `packages/api/src/services/runtime/executionStream.ts:56`; `packages/api/src/services/runtime/execute.ts:55`; `packages/api/src/services/runtime/execute.ts:290`; `packages/api/src/services/runtime/execute.ts:298` |
| runtime_execution | service_role | 是 | `packages/api/src/services/runtime/view.ts:16`; `packages/api/src/services/runtime/execute.ts:67`; `packages/api/src/services/runtime/execute.ts:79`; `packages/api/src/services/runtime/execute.ts:162`; `packages/api/src/services/runtime/execute.ts:256`; `packages/api/src/services/runtime/execute.ts:264`; `packages/api/src/services/runtime/execute.ts:280`; `packages/api/src/services/runtime/execute.ts:305`; `packages/api/src/services/runtime/execute.ts:307` |
| runtime_financial_recovery | service_role | 是 | `packages/api/src/services/runtime/execute.ts:59`; `packages/api/src/services/runtime/execute.ts:61`; `packages/api/src/services/runtime/execute.ts:71` |
| runtime_material | service_role | 是 | `packages/api/src/services/runtime/admission.ts:64`; `packages/api/src/services/runtime/admission.ts:65` |
| runtime_receipt_saved | service_role | 是 | `packages/api/src/services/runtime/execute.ts:131` |
| runtime_response | service_role | 是 | `packages/api/src/services/runtime/execute.ts:50`; `packages/api/src/services/runtime/execute.ts:109`; `packages/api/src/services/runtime/execute.ts:137` |
| runtime_session_context | service_role | 是 | `packages/api/src/services/runtime/admission.ts:70` |
| runtime_session_items | service_role | 是 | `packages/api/src/services/runtime/session.ts:23` |
| runtime_source | service_role | 是 | `packages/api/src/services/runtime/admission.ts:75`; `packages/api/src/services/runtime/execute.ts:188` |
| runtime_start | service_role | 是 | `packages/api/src/services/runtime/admission.ts:63` |
| runtime_test_actor_access | service_role | 是 | `packages/api/src/services/runtime/stagingPolicy.ts:40` |
| runtime_test_policy | service_role | 是 | `packages/api/src/services/runtime/stagingPolicy.ts:16` |
| runtime_test_recovery_policy | service_role | 是 | `packages/api/src/services/runtime/stagingPolicy.ts:47` |
| runtime_tool | service_role | 是 | `packages/api/src/services/runtime/execute.ts:179`; `packages/api/src/services/runtime/execute.ts:184`; `packages/api/src/services/runtime/execute.ts:190`; `packages/api/src/services/runtime/execute.ts:199` |
| runtime_view | service_role | 是 | `packages/api/src/routers/runtime.ts:99`; `packages/api/src/services/runtime/view.ts:5`; `packages/api/src/services/runtime/view.ts:24` |
| runtime_workspace_session | service_role | 是 | `packages/api/src/services/runtime/admission.ts:133` |
| runtime_workspace_source | service_role | 是 | `packages/api/src/services/runtime/execute.ts:183` |
| soft_delete_conversation | authenticated | 是 | `packages/api/src/routers/chat.ts:364`; `packages/api/src/routers/chat.ts:400` |
| validate_invitation_code | anon | 是 | `packages/api/src/routers/invitation.ts:125` |

## 验证记录与交付边界

- **PASS**：staging 目标核实；仅 SELECT 目录快照；91表与全部有效列的角色权限检查、54策略、public函数有效执行权限、视图检查及MAINTAIN补查。
- **PASS（静态）**：代码角色/操作与迁移对照；28张直接表、63张代表RPC间接表覆盖91张目录表；另记录1个缺失视图、4个缺失RPC。
- **PASS（本地文档检查）**：唯一文件范围、脱敏扫描、目录行数/列授权完整性、引用路径/行号存在性、diff检查、代码大小检查。具体运行回执保留本地；不将这些检查当成独立语义审查。
- **远端CI/Security**：最新候选的实际状态与运行链接见 PR Handoff；报告提交不预先宣称 CI 已通过。
- **NOT_RUN**：业务数据值/业务行数读取；登录或匿名 HTTP 实测；角色切换测试；函数执行；完整迁移重放；Auth/Storage/非public schema审计；生产连接或查询；任何数据库写入/修复；独立语义审查及Owner产品验收。
- 无法由目录证明实际非空密钥、真实泄露事件、所有动态代码分支、所有函数体与迁移一致、触发器/FK/配置对写入的最终影响。列级/行级允许仅说明该层放行，不保证端到端成功；明确拒绝则可证明相应代码路径存在权限阻断。

## Handoff

交付仅此新增报告，A15/B3/C4；优先另立 B-01 密钥列修复，之后按产品使用范围处理个人资料、工单、公告和后台风控缺权，并规划非DML/维护面收权。修复不得在此PR顺带实施。

CI全绿后保持draft，交给总控审查；总控通过后才ready并评论 `@codex review`。只有Owner在本会话亲手发送“允许合并”后，才重新核对head、CI和审查并以squash/match-head-commit合入staging。没有main或生产授权。总控从[PR #498](https://github.com/Crnobog9527/GraylumAI_vercel/pull/498)读取最新状态。
