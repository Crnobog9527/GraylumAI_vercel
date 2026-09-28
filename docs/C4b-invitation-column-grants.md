# C4b 邀请记录列权限

风险分级：高。新增迁移收回 invitation_records 的整表/敏感列 SELECT，并收窄 RLS。
不改路由、前端、表结构、数据、其他表权限、依赖或 CI，不改 service_role 授权。
本轮未查询或应用任何远程数据库。代码合并不等于迁移已应用。

## 实现与读取边界

#484 已合并到 staging，合并提交 `d31bb7a51e511463dd3f6d38a0de0ed0088b938c`。
该基线的两个用户接口明确选取 `id, created_at, invitee_email, inviter_reward, status`，
筛选仍使用 inviter_id，排序仍使用 created_at。本任务没有修改它们。

迁移 `0140_invitation_records_column_grants.sql`：

- 撤销 PUBLIC、anon、authenticated 对本表的整表 SELECT，以及全部现有列级 SELECT。
  表级 REVOKE 不会清除已存在的列级授权；从 pg_attribute 取列，避免漏掉新增内部列。
  撤销 PUBLIC 是为了关闭其对客户端角色的继承授权，不改变其他对象的权限。
- 只向 authenticated 授予上述五个显示字段和 WHERE 所需的 inviter_id。
- invitation_records_select_own 改为 authenticated 且仅 auth.uid() = inviter_id。
- 移除 0032 的 invitation_records_select_admin，避免 permissive 策略仍允许
  管理员的用户凭证读取其他行。adminProcedure 使用 service_role，后台能力仍保留。
- DROP POLICY IF EXISTS 后重建，权限操作可重复执行，整体处于事务中。

复用现有 PostgreSQL 列权限和 RLS 即可满足当前需求，没有新增数据库、视图、RPC 或状态系统。
网站唯一用户面板调用位于 PersonalInfoCard；两个用户接口都以邀请人身份筛选。
未发现以被邀请人身份读取 invitation_records 的用户功能，因此收窄到仅邀请人。
invitee_email 继续向邀请人展示，属于 Owner 明确保留的既有界面字段；对方用户 ID 不开放。

## 完整列清单

全部 15 列来自 packages/db/schema.ts 的 invitationRecords 声明，交叉检索全部后续迁移，
并在本机 fixture 的 pg_attribute 中逐列比对。后续迁移未增加本表列。
CREATE TABLE 缺失是历史基线缺口；没有将 schema 镜像或本机目录冒充远程结构证据。
匿名角色全部收回；下表允许仅作用于当前邀请人自己的行。

| 列 | authenticated 处理 | 理由 |
| --- | --- | --- |
| id | 允许 | 列表记录标识 |
| invite_code | 收回 | 面板从 invitations 取得邀请码，不需要记录表此列 |
| inviter_id | 允许 | 两个接口的 WHERE 筛选需要；只允许自己的邀请行 |
| inviter_email | 收回 | 界面不需要，避免披露邀请人身份信息 |
| invitee_id | 收回 | 界面不需要对方用户标识 |
| invitee_email | 允许 | 现有面板及 #484 保留的显示字段 |
| status | 允许 | 状态显示与面板汇总 |
| risk_level | 收回 | 内部风控 |
| block_reason | 收回 | 内部风控原因 |
| inviter_reward | 允许 | 奖励显示与汇总 |
| invitee_reward | 收回 | 用户面板不需要该记录级字段 |
| ip_address | 收回 | 敏感网络信息 |
| user_agent | 收回 | 敏感客户端信息 |
| created_at | 允许 | 时间显示和排序 |
| rewarded_at | 收回 | 用户面板未使用 |

## 本机验证与局限

命令：`node packages/db/tests/run-invitation-column-grants.mjs --local-only`。
复用仓库锁摘要的 PostgreSQL 17、Supabase GoTrue、PostgREST 镜像、既有平台 fixture 前缀、
schema 镜像和相关迁移，使用真实密码登录获取的 JWT 调用真实 protected/admin procedure。
接口通过原 createTRPCContext、认证和权限中间件以及真实数据库客户端运行，不是查询替身。
没有启动 Next 网站或执行浏览器验收，不代表完整 Supabase 平台/全量迁移建库通过。
测试身份、密码和记录在本机随机生成；无远端凭证，不向公共 PR 写入样本或原始日志。
运行器只接受本机 Unix Docker socket，端口绑定 loopback，子进程环境使用允许清单。

| 验证 | 结果 |
| --- | --- |
| 修复前邀请人读取敏感列、被邀请人读取邀请人身份字段 | PASS：真实登录客户端复现旧漏洞 |
| 两个用户接口与全部五个显示字段、现有汇总；无邀请码时创建分支 | PASS |
| 九个被收回列分别直接 SELECT、用于过滤 | PASS：均返回数据库 42501，无数据 |
| select=*；被邀请人、无关用户、管理员用户凭证跨行；匿名读取 | PASS：全列被拒、跨行无记录、匿名无数据 |
| RLS 引用未授 SELECT 的 invitee_id | PASS：事务内临时策略能筛选；显式 WHERE 同列被拒，事务回滚还原 |
| 后台管理员接口、普通用户不得调用后台接口 | PASS：service_role 返回全部 15 列，普通用户 FORBIDDEN |
| claimInvitationCode 并发重试及奖励账本 | PASS：一次 claimed、一次 already_claimed，双边奖励各一次 |
| 重复执行迁移、反向 SQL、再次应用 | PASS：权限/策略恢复，数据摘要不变，再应用后漏洞关闭 |
| service_role 及其他表/列 ACL | PASS：迁移前后不变 |
| 既有列级和 PUBLIC 授权、额外内部列授权残留 | PASS：均被清除 |
| 邀请专项 Vitest 合计 | PASS：18/18，无跳过 |
| 现有 atomic_claim_invitation_code.sql | PASS：迁移前后均通过 |
| 现有 atomic_apply_invitation_rebate.sql | FAIL：迁移前后同样失败，见下方范围外发现 |
| pnpm test:api（本机） | PASS：114 文件、2459 项通过；3 项跳过 |
| 代码大小、差异空白、迁移 ledger | 结果记录在 PR 当前 head 的验证段落 |
| 既有 BILL2 集成（本机） | PASS：78 项 |
| 既有 Runtime 集成（本机） | PASS：97 项；5 项按现有 without-app 规则排除 |
| 从全部迁移重建完整数据库 | BLOCKED：空库实际执行 0001 首先失败，后续未运行 |
| 远程数据库、真实用户数据、浏览器及生产 | NOT_RUN |

运行器保留非零退出码：专项 18/18 成功不掩盖完整重放阻断和现有返利 SQL 失败。
上述通过仅适用于声明的本机 fixture。现有 CI 不自动执行新增手动邀请专项入口，
CI 的 BILL2/Runtime 迁移子集通过也不能覆盖本任务或替代全量重建。

## 范围外发现（未修改）

1. 全量重放：在空 PostgreSQL 中执行 0001 即报 conversations 不存在。
   C3 已记录 schema 镜像与历史迁移的基线/类型矛盾。本轮不新增 0000、不改其他表。
   此前调用原样 C3 重放脚本还遇到容器初始化期间的本地版本探针失败，未算数据库重放通过；
   本任务运行器改用 TCP 查询确认就绪后，才取得上述实际 0001 失败证据。
2. 既有返利 SQL：在 schema 镜像加相关迁移的 fixture 中，0026 的幂等重放分支要求
   integer 返回值，但 credit_transactions.balance_before/after 为 bigint，
   报 `Returned type bigint does not match expected type integer in column 5`。
   应用 C4b 前、后均复现；没有改返利函数或测试断言来消除失败。
   这是本地组合的兼容性发现，未查远程数据库，不能断言线上同样出错。

## 后续应用与回退

只在另获 staging 数据库应用授权后，由执行任务核对目标、候选 SHA、迁移顺序、
完整列清单、全部相关策略、角色继承及迁移前表/列 ACL 快照，再事务化应用新迁移。
若出现未知策略、继承路径、额外授权或缺少基线证据，先停止诊断，不默认应用。
推送时迁移编号取最新 staging 下一个；合并前若有冲突则重新编号并验证新候选。

应用后检查 anon 无列读取、authenticated 恰好六列、RLS 仅邀请人自己的行，
并用获准测试身份重跑直接数据接口拒绝矩阵、两个用户接口、后台和奖励流程。
service_role 和其他表权限需与应用前快照一致。CI、合并或部署不是应用成功证据。

反向 SQL 位于 `packages/db/tests/invitation-column-grants-rollback.sql`，已对声明的
初始 anon/authenticated 整表 SELECT、无 PUBLIC/额外列授权的本机基线完成恢复比对。
它不是通用 ACL 快照恢复器；远程执行前必须依据实际迁移前快照校正授权和策略。
回退会重新开放原有泄露风险。不要对未知 ACL 直接执行测试用反向 SQL。

## Handoff

Done：#484 依赖解除；新增列权限迁移、真实本机邀请专项测试、回退 SQL，完成上述回归。
Next：保持 draft，待当前候选 CI 全绿后交总控；总控通过后才 ready 并触发独立审查。
Blockers：完整迁移重建仍缺基线；本地既有返利 SQL 在迁移前后同样失败。
Validation：专项允许/拒绝、API、奖励和回退证据已取得；不得声称所有要求均通过或候选 clean。
Boundary：未合并、未应用远程迁移。合并仍需 Owner 回复“同意合并”并在本会话亲手发送
“允许合并”，以及最终候选检查和独立审查通过；staging 迁移应用另外授权。
