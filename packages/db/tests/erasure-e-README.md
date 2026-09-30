# DATA-ERASURE PR-E：开户赠送防刷

依据 `docs/launch/tasks/DATA-ERASURE.md` §8、§9 E3、实现拆分；E 在 PR-A 之后可与 B/C/D 并行。
风险 **high**：身份摘要、赠送积分、独立密钥、数据库迁移。只在本地隔离库验证，不连接远程数据库。
本任务保持 draft，CI 全绿交总控先审；总控审过才 ready / Codex 机器人审。部署须逐步取得 Owner 批准，按下文的密钥配置、迁移/审计、合并部署顺序执行。

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
新增一张 `opening_grant_identity_digests`，只存用途、身份类型、密钥版本、HMAC、首次赠送月份（UTC 月初，数据库 CHECK 拒绝更细精度）、
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
envValidator 能识别配置错误；当前应用没有启动校验调用链，不因此拒绝启动。
实际建档赠送和注销确认读取密钥并拒绝错误配置，其他已有账号操作不因该校验停止。
active 必须在 keys 内。新增版本时保留所有仍有摘要的旧版本及密钥，读时对全部版本生成匹配摘要。
版本值和已有版本对应的密钥不可复用或替换；旧版本不能在 E3 到期之前移除。
只在本机及 secretless CI 用明显的 test-only 常量，不生成、打印或提交真实值。
部署前总控需取得 Owner 对 staging 配置的明确批准；本 PR 不授权修改真实环境。
密钥遗失无法恢复旧摘要匹配；轮换必须保留旧密钥。摘要不是完全匿名或绝对不可逆。
数据库会拒绝缺少已留存版本的请求；同一版本错误换成另一密钥无法从摘要自动发现，
总控配置时必须保留原版本和值。已在 Vercel 的环境拒绝明显的 test-only 测试密钥。
开户赠送规则取消后，停止赠送并清除此用途摘要；没有自动猜测到期或后台画像。

## 同步基线、迁移编号与 0150 兼容性

已按[总控通知](https://github.com/Crnobog9527/GraylumAI_vercel/pull/538#issuecomment-5913886441)
同步 staging `6ba5611e9d302aedd7b2b6a8b11ff5b6ab5ce73f`，其中包含 #537 的 0150。
0150 已应用是总控提供的事实，本任务未连接远程库核验。E 保持 **0151**；
已重新执行 `--local-only --write-built`，并补齐 DATA-ERASURE 的实施说明与新表附录。
后续若合并前编号改变，必须改号并重新生成指纹，不能以虚构迁移补空号。

0151 保留 0150 的屏障、父对象 guard、`erased_at` 单向规则和 `ordinary_chat_claim` 撤权。
摘要写入与账号封闭原子提交；C 的正文擦除必须另开事务。相同事务调用两个擦除入口均返回
`transactions_pending`，不会提前擦除。E 不在持有 profile / 摘要锁时调用擦除，
不改变 0150 的父对象锁序，也不增加与正文表的外键或清理顺序依赖。
新增集成用例验证提交后两条擦除路径成功、正文清空、摘要保留、父对象不能新增正文、
已擦除行不能填回、旧 claim 权限仍撤销；实际删除 Auth 后，同邮箱注册仍不发赠送。
完整 catalog 指纹相对新 base 只增加 E 对象和修改旧确认函数的执行权限，0150 对象不变。

`scripts/code-size-baseline.json` 按总控指定的条目并行写入：#538 只删除 `trpc.ts`
已不必要的 501 行条目（当前 496 行），不改其他条目，也不运行整体 `--update`。
同步保留 staging 的其他条目变化。#540 ENTITLEMENTS 与 #539 约束预检无业务文件重叠；
本 PR 不修改 0150 或 B1b 的实现、审计文件。

## 验证与交接

本轮 P2 修复本地验证（从上述 staging 完整文件构建的可销毁容器；最终 CI 以 PR head 为准）：

- PASS：`node packages/db/tests/run-erasure-e.mjs --local-only`：5 项 PR-A 回归、10 项 E 集成测试。
  覆盖邮箱/Google 同主体重注册、独立身份、大小写/空白/别名、无原文、旧版本轮换、忘旧版本拒绝、
  新会话角色读写/RPC 拒绝、并发只一次、封闭拒绝、赠送/注销摘要故障事务回滚和 PR-A 前置拒绝；
  缺密钥/错误格式验证显式调用校验函数失败，以及实际开户拒绝赠送、无流水/摘要、无日志回显。
  `validateEnvOnStartup` 没有生产调用方，函数测试不证明应用拒绝启动；实际失败范围是建档赠送和注销确认。
  另覆盖上述 0150 事务屏障与擦除兼容性。Google 使用本机 Auth 身份夹具，
  不代表外部 Google 登录验收；限频依赖在夹具中明确 mock。
- PASS：迁移连续两次、完整 catalog 回退/重应用一致、两类注销审计 0 问题；
  有摘要时回退拒绝，防止恢复重复领取。回退必须和旧 API 同步，不能丢弃线上防刷事实。
- PASS：`node packages/db/tests/run-db-baseline-replay.mjs --local-only --write-built`，
  154 步、85 个重复迁移、1187 个 catalog 分组，指纹已写入；account-open 审计 0 问题，
  收敛迁移重应用不变、回退再恢复通过，本机容器清理通过。
- PASS：API lint/typecheck、环境校验单测 30 项；远程完整检查结果见 PR 当前 head。
- PASS：safeguards 128 项；Ruby CI 合约 7 项、302 断言；代码大小检查 454 个源码文件。
- 前一候选 cdc201a2：完整 API 串行执行，145 个文件、3136 通过、3 个既有用例跳过。
  初次并发全量及单文件复跑曾出现既有 MCP 夹具 200ms 连接超时；串行执行通过，
  未改动该夹具或放宽断言。最终远程 CI 结果以 PR 当前 head 的验证记录为准。
- PASS：CI 原有 `credit-guard-paths.sql` 扩为 11 条检查：新增首次发放、注销后同身份拒绝（单笔 +0），
  以及真实双会话并发仅发一笔。用本机 dblink 会话观测第二请求等待摘要锁后才提交第一请求，
  断言余额总和 100、正金额流水一笔和拒绝决定一笔；不是顺序重复调用。扩展仅用于可销毁测试库，
  在结构指纹检查之后安装并清理，未增加业务迁移或修改 CI workflow。
- 总控已审 cdc201a2，无 P0/P1，要求本轮修四项 P2；新候选复核及独立审查待进行。
  NOT_RUN：浏览器/staging 验收、真实密钥配置、远程应用迁移。

## staging 防刷验收边界（Owner 已接受）

依据[Owner 接受记录](https://github.com/Crnobog9527/GraylumAI_vercel/pull/538#issuecomment-5916532310)
及[总控审计](https://github.com/Crnobog9527/GraylumAI_vercel/pull/538#issuecomment-5916484782)：
0151 之前已领开户赠送的 staging 账号不在防刷覆盖范围内；做防刷验收时，
只用 0151 应用且配套新 API 部署完成之后新注册的测试账号。
正式库由迁移文件全新建立，只导入配置类数据，不迁移 staging 测试数据，没有存量已赠账号，
因此不受此历史缺口影响；这是 Owner 确认的上线前提，不是本任务远程核实的结论。
若以后改为迁移已有用户数据，本次 P1 接受失效，必须回到回填方案。
本 PR 不实施 17:27 的回填方案，不加补存入口函数或脚本；下文历史封闭补存仅保留作参考，本次不执行。
部署空档 P2 按 C 类处理：应用 0151 后尽快合并部署配套 API，空档期间不做防刷测试。

## 历史封闭账号补存（执行前另取 Owner 批准，本任务未执行）

部署前由总控执行 `erasure-e-staging-source.sql`，只回报聚合数字。按总控审查要求：
Owner 先配置真实密钥 → 总控取得批准后读聚合事实、应用 0151、运行 `erasure-e-audit.sql`
（期望 0 行）→ 立即合并部署配套代码。每一步均需 Owner 批准，本 PR 的实现授权不替代它。
只有新代码没有迁移会令建档/注销失败；只有迁移没有新代码会令旧注销入口失败，须缩短空窗。

若 E 之前存在已领赠送的封闭账号，在 C 删除 Auth 身份前完成以下补存：

1. 总控在获批的受控服务端维护会话执行，暂停这些账号的 C 身份清理，直至逐项验证通过。
   只选 `account_erasure_requests` 已存在且 `credit_transactions` 有正金额
   `opening_grant:<profile_id>` 的账号；读取该行的 `profile_id` 和**原 request_id**。
   操作清单留在受限会话内，不将账号、身份、摘要或密钥导出到公开日志/PR。
2. 使用部署同版本的 `loadOpeningGrantDigests(admin, profileId)`，通过 Auth admin 获取并核对用户 ID，
   复用既有规范化和 HMAC 实现及全部保留版本；不从用户输入、已擦除 profiles.email 或日志猜身份。
   缺 Auth、subject、密钥版本或其他身份校验失败时停止该项，不为它生成替代摘要，不继续删除身份；
   只报告失败数量和固定错误类别，交总控处理无法恢复的历史缺口。
3. 使用同一服务端 service_role 调用现有包装 RPC：

   ```ts
   const digests = await loadOpeningGrantDigests(admin, profileId);
   const { data, error } = await admin.rpc('account_erasure_confirm_with_digests', {
     p_profile_id: profileId, p_request_id: originalRequestId, p_digests: digests,
   });
   ```

   这是维护补存，不调用需用户重新登录的 `confirmAccountErasure` HTTP/service 流程，
   不解除账号封闭，不重复撤销 Auth，也不触发 C 擦除。RPC 在 profile 锁内先补事实，再返回原注销记录。
   `p_allow_grant=false`，只从正金额既有流水/已有摘要取事实，不新增赠送或 0 值决定；月份统一为 UTC 月初。
4. 要求无 error、`created=false`、返回原 requestId；在受限会话按全部预期 kind/version/digest
   相等查询，确认记录齐全、到期条件正确，再比对原注销行、余额和开户流水笔数均未改变。
   只输出成功/缺失/失败数量。超时或结果不明先查上述事实，不盲目重复其他注销副作用；
   必须重放时使用同一身份摘要和原 request_id。摘要主键 `ON CONFLICT DO NOTHING`，
   原确认函数返回已存在请求，因此重复补存不改首次月份、进度、余额或流水。
5. 全部选中项核对完成后，才允许 C 删除它们的 Auth 身份；清理后的摘要按 E3 保留。
   原身份已经丢失的记录不能逆向补出，不得把它们计作完成。

本机集成用例覆盖已封闭账号补存两次、原请求/余额/账本/摘要不变，以及删除 Auth 后重注册不赠送。
目前未取得远程历史聚合结果，也未执行任何补存。到期清除和备份恢复按 §8/E3：
规则取消才删除此用途事实；恢复服务前先恢复防刷事实。权限审计不代表完整功能验收。

### 已知限制（总控 P3，当前不扩范围）

- 点号和加号别名不合并，沿用 §8 已接受的身份规则；keyring 的 active 字段目前只做校验。
- 被拒账号记英文 +0 决定；后续请求仍可能走 recover 查询并记录 warn；版本检查每次扫描摘要表。
- 邀请奖励重复领取不属于 E3，本 PR 不处理，由总控另立任务。

Handoff：done = HMAC/环境校验、原子赠送与封闭、回退/审计、本地证明、
同步 0150/0151 编号、重生成指纹和任务文档；
next = 修复候选 CI 全绿 → 总控复核 → ready / 独立审查 → 依上述批准顺序配置、迁移和合并；
blockers = 历史封闭账号聚合事实未取得、真实 staging 密钥尚未由 Owner 配置。
当前保持 draft，独立审查尚未完成，不是 clean；本 writer 不合并、不配置真实环境、不应用远程迁移。
