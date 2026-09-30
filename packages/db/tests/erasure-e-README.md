# DATA-ERASURE PR-E：开户赠送防刷

依据 `docs/launch/tasks/DATA-ERASURE.md` §8、§9 E3、实现拆分；E 在 PR-A 之后可与 B/C/D 并行。
风险 **high**：身份摘要、赠送积分、独立密钥、数据库迁移。只在本地隔离库验证，不连接远程数据库。
本任务保持 draft，CI 全绿交总控先审；总控审过才 ready / Codex 机器人审。Owner 批准后总控合并、配置、应用。

## 盘点（起点 staging `28af1e34f3947389f14d85401c0f33b91fca7a60`）

- `packages/api/src/trpc.ts:113–180`：100 积分开户赠送；`opening_grant:<userId>` 防重；调用
  `atomic_apply_credit_ledger_entry`。`:202–264` 恢复零余额新资料，`:346–390` 创建资料后赠送。
- `packages/db/migrations/0051_auth_opening_grant_profile_defaults.sql:11`：新资料默认 0，不靠 Auth 触发器赠送。
- 管理界面虽显示 `new_user_credits` 配置，现有开户路径实际固定为 100；本任务保持原赠送额度。
- `packages/db/migrations/0028_restore_staging_helper_functions.sql:419–524`：当前有效账务函数，
  锁 profile、防重、改余额和写账本同事务；0024 为其早期版本。
- `packages/api/src/services/accountErasure/service.ts:67–73`：限频、重验身份后调用注销确认。
- `packages/db/migrations/0147_account_erasure_close.sql:80–126`：锁 profile，检查续费/角色，封闭账号、写注销请求。
  PR-E 增加 service-only 包装函数，先写摘要，再在同一事务调用既有确认函数；撤掉旧函数的服务端直调权限。
  不重写旧函数正文，不改 PR-A 已有迁移。
- `packages/api/src/lib/auth.ts:3–39`：当前身份类型为邮箱和 Google；身份来自 Auth 验证结果，不能用昵称。
  Auth 将邮箱转为小写，拒绝原始首尾空白；摘要另外 trim 输入空白，保留点号与加号。
  本地运行实际 Auth 版本的规则见 [mail.go](https://github.com/supabase/auth/blob/v2.190.0/internal/api/mail.go)。
  OAuth 用 Auth 验证过的 subject；Google 用固定 provider 对应 issuer，忽略昵称/user_metadata。

## 最小必要变更（AGENTS §5）

现有 profiles 在注销后清身份；账本只按账号 ID 防重，且财务保留期限不同于 E3。
注销审计只存进度，不能混放身份匹配用途。三者均不能独立保证身份擦除后的相等匹配。
新增一张 `opening_grant_identity_digests`，只存用途、身份类型、密钥版本、HMAC、首次赠送时间、
规则取消即清除的到期条件；没有邮箱、issuer、subject、昵称、账号 FK 或内容。
注册校验与现有账务 RPC 同一事务，用有序事务锁防并发重复赠送；不新增钱包、调度器、队列或运行平台。
余额/流水仍以 profiles / credit_transactions 为权威；摘要表只证明该身份曾领过开户赠送。
新 RPC 只授予 service_role，赠送前拒绝封闭账号。新表 RLS、account_open_required 策略和现有注销审计接入。
摘要匹配导致不赠送时，在既有账本写金额 0 的防重决定；不改变余额，防止零余额资料后来
换邮箱或遇到响应丢失时被旧恢复流程补发。首次赠送事实只来自正金额原流水或已有摘要事实。

旧确认入口调用盘点：生产只有 `services/accountErasure/service.ts`，已改为带摘要的包装函数；
`service.test.ts`、`accountErasure.integration.ts` 同步改调用。E 权限测试以新 SQL 会话证明
service_role 直接调用旧入口被拒绝。`baseline/credit-guard-paths.sql` 的 service_role 调用
也改为优先使用带摘要入口，仅在旧基线不存在 E 函数时保留原路径。
`run-account-erasure-close.mjs` 已在当前 E 存在时
转到完整基线 runner；其旧 0147-only 夹具/ACL 核验只保留作历史分支诊断。
`account-erasure-close-rollback.sql` 是历史结构回退，E 回退脚本只在无摘要事实时恢复旧权限。

## 密钥配置（总控向 Owner 请求，尚未执行）

变量名 `OPENING_GRANT_HMAC_KEYS`，仅服务端：JSON 格式
`{"active":"v2","keys":{"v1":"<base64-32-byte-key>","v2":"<base64-32-byte-key>"}}`。
版本为 1–32 字符的字母/数字/下划线/短横线；1–8 个版本，每个值为规范 Base64 编码的
32–64 字节独立密钥，不与 Auth、支付或其他签名密钥复用。
active 必须在 keys 内。新增版本时保留所有仍有摘要的旧版本及密钥，读时对全部版本生成匹配摘要。
版本值和已有版本对应的密钥不可复用或替换；旧版本不能在 E3 到期之前移除。
只在本机及 secretless CI 用明显的 test-only 常量，不生成、打印或提交真实值。
部署前总控需取得 Owner 对 staging 配置的明确批准；本 PR 不授权修改真实环境。
密钥遗失无法恢复旧摘要匹配；轮换必须保留旧密钥。摘要不是完全匿名或绝对不可逆。
数据库会拒绝缺少已留存版本的请求；同一版本错误换成另一密钥无法从摘要自动发现，
总控配置时必须保留原版本和值。已在 Vercel 的环境拒绝明显的 test-only 测试密钥。
开户赠送规则取消后，停止赠送并清除此用途摘要；没有自动猜测到期或后台画像。

## 并行范围与迁移编号

当前 #537 head `1b67501392513c743884c6e44f669875d791a31c` 已包含 0150，并写入
`built-fingerprint.json` 与 `DATA-ERASURE.md`。这两个文件暂停写入，PR 已记录实际重叠。
本任务暂用 0151；当前 base 只有 0149，因此 migration ledger 报缺 0150。
总控已在 [PR 留言](https://github.com/Crnobog9527/GraylumAI_vercel/pull/538#issuecomment-5907196539)
明确顺序 #537 → #538 → #539；其他实现/测试可继续，两个共享文件等 #537 合并后的通知再写。
收到通知后更新分支，
按合并时 staging 核对编号，并在同一 PR 重跑 --local-only --write-built。不能放虚构迁移补空号。
总控已明确 `scripts/code-size-baseline.json` 按条目并行写入：#538 只删除 `trpc.ts`
已不必要的 501 行条目（当前 496 行），不改其他条目，也不运行整体 `--update`。
若后合并时冲突，只保留各 PR 各自条目的改动。
#540 ENTITLEMENTS 与 #539 约束预检当前无业务文件重叠；不修改 #537 的擦除通道/审计文件。

## 验证与交接

本地候选验证（从上述 staging 完整文件构建的可销毁容器）：

- PASS：frozen install；完整 API 141 个文件，3098 通过、3 个既有用例跳过；API/Web lint 与类型检查。
- PASS：`node packages/db/tests/run-erasure-e.mjs --local-only`：5 项 PR-A 回归、8 项 E 集成测试。
  覆盖邮箱/Google 同主体重注册、独立身份、大小写/空白/别名、无原文、旧版本轮换、忘旧版本拒绝、
  新会话角色读写/RPC 拒绝、并发只一次、封闭拒绝、赠送/注销摘要故障事务回滚和 PR-A 前置拒绝；
  缺密钥/错误格式分别验证启动拒绝，以及实际开户拒绝赠送、无流水/摘要、无日志回显。
  Google 使用本机 Auth 身份夹具，不代表外部 Google 登录验收；限频依赖在夹具中明确 mock。
- PASS：迁移连续两次、完整 catalog 回退/重应用一致、两类注销审计 0 问题；
  有摘要时回退拒绝，防止恢复重复领取。回退必须和旧 API 同步，不能丢弃线上防刷事实。
- PASS：API 类型排除基线 35 个旧文件仍需排除。
- PASS：定点删除 trpc 条目后，代码大小检查覆盖 449 个源码文件通过；其余基线条目逐项一致。
  完整基线重放 153 步、84 个重复迁移、1169 个 catalog 分组，account-open 审计 0 问题；
  收敛迁移重应用不变、回退再恢复通过；`--after baseline/credit-guard-paths.sql` 的 8 条
  钱包/封闭/服务角色路径均通过。当前仅 `--out` 独立证据，不算更新 built-fingerprint。
- FAIL / BLOCKED：safeguards / migration ledger 缺 0150。
  原因是上述明确的并行 writer / 顺序依赖，未通过就是未通过。
- FAIL：已提交实现候选的 Ruby CI 合约 7 项、296 断言、1 失败，也因缺 0150。
  准备稿 HEAD 的 7 项/301 断言曾通过，不能沿用为实现候选通过证据。
- BLOCKED：同 PR 的 `--write-built` 与新表附录登记等待共享文件写入协调，尚未执行。
- NOT_RUN：总控审、最终候选远程 CI 全绿、独立语义审查、浏览器/staging 验收、真实密钥配置、应用迁移。

总控 staging 只读事实：执行 `erasure-e-staging-source.sql`，只贴聚合结果。
如 PR-E 前已有领过赠送的封闭账号，必须在 PR-C 删除 Auth 身份前补存其摘要；
身份已删除则历史摘要无法逆向补出，需报告总控，不能假称已覆盖。当前未取得远程事实。
应用后只读权限检查为 `erasure-e-audit.sql`；期望 0 行，仅代表权限检查，不代表完整验收。
到期清除和备份恢复按 §8/E3：规则取消才删除此用途事实；恢复服务前先恢复防刷事实。

Handoff：done = HMAC/环境校验、原子赠送与封闭、回退/审计及本地证明；
next = 等 #537 合并通知 → 更新分支/编号/指纹/附录 → 相关验证及 CI 全绿
→ 总控先审 → ready/Codex 机器人 → Owner 批准后总控合并/配置/应用；
blockers = 指纹/附录等 #537 合并通知、缺 0150、历史封闭账号事实未取得。
当前保持 draft，不是 clean；本 writer 不合并、不配置真实环境、不应用远程迁移。
