# C4b 邀请记录列权限：阻断交接

当前状态：BLOCKED，尚未实现迁移。此文档是本任务可从 GitHub 恢复的准备材料，不是已验证方案。

## 已核对的候选与依赖

- 起始 staging：`8a340686c9a19b6cf19a1197e983ad99e978e471`。
- 分支：`codex/c4b-invitation-column-grants-20260929`。
- #484 当前仍为 open draft，head `b3c2c85a60994ef57e88d4cbf73d598dac555399`。
- staging 的 `packages/api/src/routers/invitation.ts:523` 和 `:575` 仍使用 `select('*')`。
  撤销整表读取权限会破坏两个用户接口。Owner 明确要求遇到路由依赖先停下、记录在 PR，
  等 #484 合并后再处理；因此没有修改路由，也没有提前编写或应用迁移。
- 当前最大迁移编号为 0139；恢复时重新 fetch，在推送时取最新编号的下一个，合并前再次检查。

## 列清单和拟议权限

以下是 `packages/db/schema.ts:231–250` 的全部 15 列，并与全部后续迁移中对此表的引用交叉核对。
迁移中未找到该表的 CREATE TABLE 或新增列语句。schema 是重建线索，不替代迁移或真实数据库目录。
本轮没有读取任何远程数据库，因此不声称已验证远程列清单或 ACL。

匿名角色拟全部收回；下表“允许”仅指 authenticated 通过 RLS 可见的邀请人自己的行。
现有产品明确向邀请人展示 invitee_email；本任务保留该字段，不额外开放被邀请人身份标识。

| 列 | authenticated 拟处理 | 理由 |
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

## 最小改动选择与兼容性

复用现有列级 GRANT/REVOKE 和 RLS，不增加表、视图、RPC 或共享基础设施。
网站调用点在 `apps/web/src/components/profile/PersonalInfoCard.tsx`；用户接口均按 inviter_id 查询。
对 packages 和网站源码的检索未发现以被邀请人身份读取记录的用户路径。
因此推荐仅保留邀请人自己的行，撤销 anon/authenticated 的整表 SELECT，
清理已有列级 SELECT 后只向 authenticated 授予上述 6 列；不得改变 service_role 权限。

`0002_enable_rls_all_tables.sql` 的 invitation_records_select_own 当前包含 inviter_id 或 invitee_id。
`0032_admin_policy_shape_reconciliation.sql` 另建 invitation_records_select_admin，
允许 active 管理员身份的 authenticated 用户读其他人的行。
为了满足“用户级客户端仅自己的行”，后续迁移还需处理这条 permissive 策略，
不能仅修改 select_own 后就声称所有其他用户均不可读。
后台 adminProcedure 在 `packages/api/src/trpc.ts` 把 supabase 替换为 supabaseAdmin；
claimInvitationCode 也显式使用 supabaseAdmin。以上是静态路径证据，运行时不受影响仍须实测。

RLS 表达式引用未授权列是否需要列权限：NOT_RUN，禁止以推断代替本地数据库实验。
实验应在本机隔离数据库中临时构造引用未授权列的策略，记录允许/拒绝结果后恢复最终策略。

## 验证阻断与恢复后执行

- PASS（静态核查）：最新 staging 规则、工程规范、列清单线索、用户与管理员调用路径。
- BLOCKED：两个真实登录用户接口的兼容性，等待 #484 合并，不能改路由或用替身结果宣称通过。
- BLOCKED：仅由全部现存迁移从空库重建缺少历史基线，0001 已引用预存在表，0002 直接对本表启用 RLS。
  现有 `packages/db/tests/v3/run-workbench.mjs` 使用 bootstrap 和显式选择的迁移，不是全量重建证明。
  后续先确认可审计的本地基线重建方式；不得查询远程数据库补齐，也不修改历史迁移或其他表权限。
- NOT_RUN：本机登录凭证、用户接口、敏感列直读、select=*、被邀请人、无关用户、匿名拒绝路径。
- NOT_RUN：service role 后台全列查询、领取邀请码及奖励流程。
- NOT_RUN：重复执行迁移、反向 SQL 恢复、迁移前后权限与数据一致性。
- NOT_RUN：独立语义审查；待实现验证完成并经总控审查通过后再 ready 和触发机器人。

恢复后的回归命令包括 `pnpm test:api`、`node scripts/check-code-size.mjs`，以及
`node packages/db/tests/v3/run-workbench.mjs --bill2-core-only --without-app` 和
`node packages/db/tests/v3/run-workbench.mjs --runtime-only --with-staging-schema --without-app`。
还需执行本任务实际权限/API 测试和现有 invitation SQL 测试；已有集成脚本通过不能替代邀请权限覆盖。
虚构测试身份、凭证和样本仅保留本地，不进入公共 PR 或提交。

## 后续应用与回退边界

风险分级：高。拟议改动改变数据库列权限和 RLS；当前提交仅保存调查与阻断交接。
不删除数据、不改表结构、不改其他表权限；远程应用与合并是两个独立授权事项。

本轮不查询或应用任何远程数据库。后续仅在独立授权后，由执行任务先核对候选、目标、
迁移顺序及当前 ACL/策略快照，再通过现有迁移机制事务化应用已验证的新迁移。
应用后核对列级授权、RLS、service role 权限，使用获准测试身份执行允许与拒绝矩阵，
并核对用户面板、后台和奖励流程。任何前置检查失败即停止。

反向 SQL 必须在最终迁移确定后与本机迁移前 ACL/策略快照比对验证。
PR 描述给出拟议反向 SQL，但尚未测试，不是可直接执行的远程恢复指令。
恢复整表授权会重新开放本任务拟修复的泄露风险，必须与代码版本及执行授权一起判断。

## Handoff

Done：fresh-read、专用分支、列与读取路径调查；未修改任何运行时代码或迁移。
Next：等 #484 合并，刷新 staging 与编号，完成本地基线核实，再实现迁移、验证及同范围修复。
Blockers：#484 未合并；全量迁移重建缺少历史基线；本任务所有数据库运行时验收未运行。
Validation：本提交的静态检查及 CI 结果以 PR 最新描述为准，不代表迁移或产品验收通过。
Boundary：保留 draft。达到实现及 CI 条件后再交总控审查；总控通过前不 ready、不触发机器人。
合并须 Owner 回复“同意合并”并在本会话亲手发送“允许合并”，且最终候选检查与审查均通过。
没有远程迁移、main 或生产授权。
