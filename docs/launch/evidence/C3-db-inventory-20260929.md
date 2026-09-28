# C3 数据库盘点（2026-09-29）

风险分级：**普通**。仅新增盘点文档、脱敏本地结果和手动本机脚本；不改变产品、数据库、迁移、依赖、权限或 CI。

固定盘点基线：`6a370bc5198fe2cc779d3a83d898fd149bee2069`（开工时最新 `origin/staging`）。本文的所有 `file:line` 均相对此提交；以后 C2 改动文档行号不会改变本次证据含义。没有连接 staging / production 数据库，没有使用 Supabase 远程工具；线上对象、ACL、执行计划及运行调度均未核实。

## 结论与阅读入口

1. **纯迁移不能从空库建成结构**：实际本机重放在 `0001_ai_billing_tables.sql:13` 引用 `conversations` 时失败。全部 140 个 SQL 已纳入有序重放队列，第一处失败后停止，后续 139 个为 NOT_RUN，不能称“全部迁移已执行”。
2. **先推 schema 仍未形成可重建路径**：现行 `db:push` 拒绝本机地址；另行在本机验证底层锁定 Drizzle 后创建 32 张表，0001 因缺 `auth` schema 失败。再使用既有本地 fixture 的平台前缀后，0001 通过，0002 因 `ai_models.is_active` 的 text/boolean 比较失败。未修改或跳过失败的业务 SQL。
3. `schema.ts` 32 表、迁移 CREATE TABLE 75 个唯一表、交集 16、并集 **91**；16 个核心表没有迁移 CREATE，59 个迁移表不在 schema 镜像中。该数字只代表仓库声明，非线上表数。
4. 附件桶缺迁移定义，但上传代码有运行时建桶分支；遗留 `prompts` 仍被 SQL 函数使用；两个工单定时入口是同一业务的不同实现。不能把这些对象直接当作可删除对象。

配套证据：

- [用户数据逐表事实](C3-user-data-20260929.md)：外键、正文/账务、不可变/禁止删除触发器、存储路径。
- [遗留对象与索引候选](C3-legacy-indexes-20260929.md)：静态调用边、测试调用、重复调度、启发式索引候选。
- [逐迁移执行记录](C3-migration-execution-20260929.md)：仓库历史证据与 unknown；统计口径。
- [本机原始结果](C3-local-replay-20260929.json)：逐文件 PASS / FAIL / NOT_RUN 名单。
- [手动本机重放脚本](../../../packages/db/tests/c3-local-replay.mjs)：不接入 CI，不接受数据库 URL 或远端 Docker。

这与 `docs/launch/MASTER_PLAN.md:606` 的“由迁移文件建出结构”要求不闭合。本次只描述缺口，不编写 0000，不修改既有规范或 DATA-ERASURE 的任何决定。

## 1. 实际本机重放

命令：`node packages/db/tests/c3-local-replay.mjs --local-only`。

复用 `packages/db/tests/v3/images.mjs:6` 已锁摘要的 PostgreSQL 镜像；实际版本 17.11。脚本只允许 Unix Docker socket，自建随机名称容器、绑定 `127.0.0.1`、不继承连接变量、不读取 dotenv、不挂用户数据卷、不启动应用或供应商。结束时删除本任务三个容器及临时配置；结果 `cleanup.success=true`。依赖使用仓库锁文件离线安装，下载数 0。

| 实验 | 实际结果 | 首个失败及原因 | 尚未运行 |
| --- | --- | --- | --- |
| 空的普通 PostgreSQL → 全部迁移按文件名字典序 | FAIL，psql exit 3 | 0001 的 CREATE TABLE `token_stats`（:11–25）引用未创建的 `conversations`（:13）；statement 结束 :25 报 `relation "conversations" does not exist` | 其余 139 个 SQL |
| 原样 `pnpm db:push` → 迁移 | BLOCKED，exit 1 | `scripts/db-push-guard.mjs:25–36` 仅识别 Supabase 目标，拒绝本机 URL；未伪造目标或改 guard | 全部迁移；该路径未成功 push |
| 单独底层 Drizzle push → 迁移（普通空库） | push PASS（32 表），迁移 FAIL | 0001:94 的 `auth.uid()` 缺平台 `auth` schema | 其余 139 个 SQL |
| 既有 fixture 平台前缀 → 底层 Drizzle push → 迁移（另一新库） | push PASS；0001 PASS；0002 FAIL | 0002:145 `is_active = true`，而 `schema.ts:97` 是 text，报 `operator does not exist: text = boolean` | 其余 138 个 SQL |

最后一行只复用 `packages/db/tests/v3/bootstrap.sql:1–13`（到 `CREATE TABLE public.profiles` 之前）：模拟角色、schema、auth.uid；不是 Supabase 平台验证，也不是合法生产基线。底层 Drizzle 实验的临时配置只引用原 schema 与本机临时 URL，不加载原配置的 dotenv；不等价于原样 `db:push` 成功。源配置见 `packages/db/drizzle.config.ts:1–12`，原命令见 `package.json:35` / `scripts/db-push-guard.mjs:76–87`。

未直接把 `run-workbench --with-staging-schema` 的成功视为全迁移成功：它先建 fixture 业务表，选择特定迁移并重复执行，还补 fixture DDL（`packages/db/tests/v3/run-workbench.mjs:232–295`）；该参数包含 0108 等结构（:351），不是从 0001 连续重放全部 SQL 的入口。新脚本只补缺少的“全序重放、首错停止、两种路径对照”能力，复用镜像和平台前缀，没有新数据库架构或共享权威。

## 2. 缺失基线表与列

下列 16 表都在 `schema.ts` 声明，但 140 个迁移没有对应 CREATE TABLE。后续存在 ADD COLUMN / ALTER / 索引 / RLS 并不补回建表。表级依赖证据：

| 表 | schema.ts 声明行 | 迁移引用（完整路径前缀 `packages/db/migrations/`） |
| --- | --- | --- |
| profiles | 6 | `0001_ai_billing_tables.sql:14`（FK）、:180（credits CHECK） |
| conversations | 22 | `0001_ai_billing_tables.sql:13`（FK） |
| messages | 39 | `0001_ai_billing_tables.sql:15`（FK） |
| credit_transactions | 49 | `0001_ai_billing_tables.sql:31`（FK） |
| ai_models | 76 | `0002_enable_rls_all_tables.sql:14`、:145（is_active） |
| system_settings | 103 | `0002_enable_rls_all_tables.sql:15` |
| tickets | 110 | `0002_enable_rls_all_tables.sql:16`、:173（user_id） |
| ticket_replies | 125 | `0002_enable_rls_all_tables.sql:17`、:200（ticket_id） |
| credit_packages | 137 | `0002_enable_rls_all_tables.sql:18` |
| invitations | 150 | `0002_enable_rls_all_tables.sql:19`、:243（created_by） |
| user_activity_logs | 158 | `0002_enable_rls_all_tables.sql:20`、:262（user_id） |
| announcements | 181 | `0002_enable_rls_all_tables.sql:21` |
| prompts | 204 | `0002_enable_rls_all_tables.sql:22` |
| invitation_records | 231 | `0002_enable_rls_all_tables.sql:23`、:310（inviter_id / invitee_id） |
| membership_plans | 270 | `0002_enable_rls_all_tables.sql:24` |
| modules | 520 | `0002_enable_rls_all_tables.sql:25` |

[逐列基线候选](C3-baseline-columns-20260929.md) 给出每个 schema 声明列的行号及迁移是否补 ADD COLUMN；它是基线范围核对表，不表示所有列都应照抄当前类型到 0000。仅在 schema 的列标记“无迁移列定义”；已有 ADD 的列标明来源。未纳入 schema 的迁移新增列仍由各自迁移拥有，不能误算为缺失。

顺序矛盾还包括：0002 使用 boolean 标志，0004 对 text 镜像使用 boolean 比较（`0004_recursive_summary_and_soft_delete.sql:90`），0018 才修复 text 策略（`0018_rls_text_flags_and_job_runs.sql:1`）。因此“把今天的 schema 原样转成 0000”并未被本机实验证明可行；所有后续迁移未跑部分仍须以后完整验收。

## 3. 函数、触发器、扩展、桶与授权缺口

| 类别 / 对象 | 仓库事实与引用 | 0000 / 平台前提清单中的归属 |
| --- | --- | --- |
| `auth.uid()`、`auth` schema | 0001:94 即调用；业务迁移无创建；本地 fixture `packages/db/tests/v3/bootstrap.sql:9–13` 只是替身 | 平台先决条件；不能把测试 auth.uid 当成生产实现 |
| `deduct_credits_atomic(uuid,integer,text,text,text,text)` | `packages/db/migrations/0016_live_db_drift_security_cleanup.sql:19–29` 仅“存在时 ALTER”；0050:73、:83–87 同样有存在性保护；无 CREATE | 遗留对象定义缺证，不是当前必然重放失败；以后需确认是否需要纳入，不能猜函数体 |
| `update_updated_at_column()` | `packages/db/migrations/0016_live_db_drift_security_cleanup.sql:34–44` 仅条件 ALTER，无 CREATE；没有迁移声明哪个 trigger 绑定它 | 函数和绑定触发器均缺完整来源；不凭函数名声称每表均有自动更新时间 |
| `rls_auto_enable()` / `ensure_rls` | `packages/db/migrations/0050_sec1_privileged_rpc_execute_posture_closure.sql:6` 仅注释排除；`docs/launch/evidence/SEC-1-RPC-CLASSIFICATION.md:55–57`、:73–74 只记录基础设施边界 | 无函数体、事件触发器 CREATE 或绑定；`ensure_rls` 的准确对象形态/定义 unknown，不能简单断言它是应用函数 |
| 应用触发器 | 例如 `packages/db/migrations/0027_balance_write_surface_lockdown.sql:55`、0062:214/220 及后续 V3 有实际 CREATE；详见用户数据附表 | 已有定义不计入缺失；未发现“执行触发器引用缺失应用函数”的明确新增缺口。Auth 注册/更新时间/事件触发器在线绑定均 unknown |
| `pg_cron` / `cron.schedule` / `cron.unschedule` | `packages/db/migrations/0010_ticket_auto_close_supabase_cron.sql:9` **已有 CREATE EXTENSION**，:121、:124 使用函数 | 不属于缺少迁移 CREATE；扩展二进制/预加载/权限是平台前提。锁定普通 Postgres 镜像不是 Supabase，未执行到0010，不宣称验证通过 |
| `gen_random_uuid()` | `packages/db/migrations/0001_ai_billing_tables.sql:12`；本机 PG17 已可使用（Drizzle32表建立成功） | PG17 内建函数，不因为没 CREATE pgcrypto 就记成缺失；迁移未发现必须补 pgcrypto/uuid-ossp 的明确引用 |
| `ticket-attachments` | `apps/web/src/app/api/upload/route.ts:110` 有 private 建桶分支；迁移无 `storage.buckets` 插入及 Storage policy | 桶及策略的可重建声明缺口；不是“全仓库无定义”。路径/权限事实见用户数据附表 |
| `storage.buckets` / `storage.objects` | 迁移无平台表定义；上述 Storage SDK 路径依赖平台服务 | Supabase Storage 平台前提，不能把平台表当业务表复制进0000 |
| `anon` / `authenticated` / `service_role` | 迁移引用如 `packages/db/migrations/0029_client_role_non_dml_grant_hardening.sql:16`、0031:36–38；全部迁移无 CREATE ROLE；本地 fixture:3–8 有模拟角色及 schema USAGE | 平台角色/成员关系/schema USAGE 初始姿态未由迁移重建；已有后续 GRANT/REVOKE 不表示缺少全部授权 |
| 核心表初始 ACL / 默认 ACL | 0002 的 CREATE POLICY 不是 GRANT。0029:16–18 仅回收非DML；0073:5 仅授 ai_models 写权限；没有明确初始 ai_models authenticated SELECT 定义 | 基线授权来源缺口；不能默认公网或 authenticated 应有整表 SELECT；列级核查见§6 |
| `profiles.id` → Auth 身份关联 | `packages/db/schema.ts:7` 只有注释，没有 `.references`，业务迁移无 auth.users FK 定义 | 外键及 Auth 关联触发器的线上形态 unknown，不推测 CASCADE |
| `increment_module_usage` | 代码调用而全部迁移无 CREATE，见遗留对象附表 | 缺实现来源；未来需判断保留调用还是补定义，本轮不改调用或编函数体 |

这里“无定义”的负向证据范围是此基线所有 `packages/db/migrations/*.sql`，使用大小写不敏感 CREATE / ALTER / RENAME 搜索，区分注释、条件存在检查与真实调用。函数经 ALTER RENAME 得到的旧入口（例如 `bill2_legacy_*`）不是遗漏 CREATE；应用内置函数、PostgreSQL catalog 及平台对象也不混入缺失业务函数。

### 未来 0000 基线需包含 / 明确的对象范围（仅清单）

- 16 个缺建表对象及其初始列、精确类型、NULL/default、主键、唯一约束和用户/对象外键；列单和 FK 事实分别见两份附表。依赖次序首先须满足0001的 conversations/profiles/messages/credit_transactions。
- 基线表的初始索引与 RLS/ACL 前提，对照后续显式增删语句避免重复或扩权；现存迁移已定义的75表及其对象继续由原文件创建。
- Auth schema/functions/roles、Storage 服务和 pg_cron 可用性写成平台前提，不复制 fixture 作为平台实现；如果保留附件上传契约，需要能重建私有桶、路径及授权事实。
- 遗留函数/事件触发器只列出上述缺来源身份；是否仍必要、真实定义是什么尚缺证据，不能把它们自动写入0000。
- 初始列类型必须能通过0002/0004和全部后续变更；当前32表镜像本机已出现矛盾，不能跳过失败就声称基线完整。
- 0000 后完整顺序执行140文件、角色允许/拒绝路径及最终对象指纹，均属未来实现验证；本任务没有实现、授权或运行这些修复。

## 4. 迁移执行记录的解释

逐文件、分 staging / production 的记录见附表。`unknown` 不是“未执行”；提交/合并、checksum ledger、本机fixture和文档计划都不是远端执行成功证据。有环境明确的仓库历史执行陈述保留原来源并标记历史报告，不能升级为2026-09-29实时库状态。无远端核验。

## 5. schema.ts 与 db:push 定位，待 Owner 决定

`docs/ENGINEERING.md:19`、:92–94 指定迁移为结构来源；现行 runbook 的 schema push → SQL 顺序见 `docs/runbooks/STAGING_REPRODUCIBILITY.md:65–70`。前者与后者存在可重建性缺口，本次不修改这两份文件。

schema 覆盖32/91，缺少59张迁移表（V3/Runtime/BILL2/OPC等）。Drizzle push 是目标结构同步，未在 schema 声明的已有表会成为删除差异候选；若对已有V3库使用，**可能生成删表语句/提示**。本轮没有在完整V3库执行push或确认删除，该风险是由声明覆盖与底层工具差异算法得出的静态结论，不能写成“已观察到线上删除”。原 guard 只核验目标/确认，并不验证 schema 完整性（`scripts/db-push-guard.mjs:64–87`）。

| Owner 选项（尚未决定/实施） | 定位与影响 |
| --- | --- |
| A：定为“核心表镜像” | 明确schema只描述32张核心/部分表，迁移保持结构权威；需以后限定push可作用的场景，不能用此镜像同步完整V3库。仅改称呼无法修复空库重放。 |
| B：退役 db:push | 日常/正式结构统一迁移；schema如果保留只作镜像/类型参考。需后续补完整基线及本地建库路径后移除push入口，减少两套结构来源冲突。 |

建议以后选择 B，与 Master Plan §9.3 一致；本次不替 Owner 决定、不改命令，不要求为完成盘点先选择。两选项都不能免除基线缺口和全序重放验收。

## 6. ai_models.api_key 只读核查（NOT_RUN）

仓库声明：`packages/db/schema.ts:81`；客户端模型读取策略：`packages/db/migrations/0018_rls_text_flags_and_job_runs.sql` 与 `0032_admin_policy_shape_reconciliation.sql`。RLS 限制行，不等于隐藏某列。仅凭公开代码无法断定线上 authenticated 能否读取 api_key。

下面整段是**仅供另行授权后执行**的只读查询；本轮未在本地或远端执行。它不读取任何 key 值，仅检查角色、对象及权限；缺角色/表/列时输出NULL而不是当作安全。

```sql
BEGIN READ ONLY;
WITH target AS (
  SELECT c.oid AS table_oid, a.attnum
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.oid
  WHERE n.nspname = 'public' AND c.relname = 'ai_models'
    AND a.attname = 'api_key' AND a.attnum > 0 AND NOT a.attisdropped
), subject AS (
  SELECT oid AS role_oid FROM pg_roles WHERE rolname = 'authenticated'
)
SELECT EXISTS (SELECT 1 FROM target) AS column_exists,
       EXISTS (SELECT 1 FROM subject) AS role_exists,
       (SELECT has_schema_privilege(role_oid, 'public', 'USAGE')
          FROM subject) AS schema_usage,
       (SELECT has_column_privilege(role_oid, table_oid, attnum, 'SELECT')
          FROM subject CROSS JOIN target) AS can_select_api_key,
       (SELECT relrowsecurity FROM pg_class
          WHERE oid = (SELECT table_oid FROM target)) AS rls_enabled;
ROLLBACK;
```

`has_column_privilege=true` 包含整表授权/角色继承所带来的列访问能力；实际能看见哪些行仍受RLS、角色成员关系和会话身份约束。false也不能证明不存在服务端接口泄露。后续如获授权，另查当时策略/授权链；本次不输出密钥或连接信息、不执行SQL。

## 7. 交付边界

本机重放已实际执行，结果见§1；用户数据、遗留和索引均是静态事实/候选，未看执行计划。不得把文档完成等同基线修复、DATA-ERASURE实现或正式发布就绪。

PR保持draft、目标staging。CI全绿后停在总控审查；总控通过后才ready并请求独立机器人审查。合并仍需Owner在本会话亲手发送“允许合并”，最终使用squash与head匹配保护。本次未申请或执行合并。
