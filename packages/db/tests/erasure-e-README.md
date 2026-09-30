# DATA-ERASURE PR-E：开户赠送防刷

依据 `docs/launch/tasks/DATA-ERASURE.md` §8、§9 E3、实现拆分；E 在 PR-A 之后可与 B/C/D 并行。
风险 **high**：身份摘要、赠送积分、独立密钥、数据库迁移。只在本地隔离库验证，不连接远程数据库。
本任务保持 draft，CI 全绿交总控先审；总控审过才 ready / Codex 机器人审。Owner 批准后总控合并、配置、应用。

## 盘点（起点 staging `28af1e34f3947389f14d85401c0f33b91fca7a60`）

- `packages/api/src/trpc.ts:113–180`：100 积分开户赠送；`opening_grant:<userId>` 防重；调用
  `atomic_apply_credit_ledger_entry`。`:202–264` 恢复零余额新资料，`:346–390` 创建资料后赠送。
- `packages/db/migrations/0051_auth_opening_grant_profile_defaults.sql:11`：新资料默认 0，不靠 Auth 触发器赠送。
- `packages/db/migrations/0024_atomic_apply_credit_ledger_entry.sql:48–113`：锁 profile、防重、改余额和写账本同事务。
- `packages/api/src/services/accountErasure/service.ts:67–73`：限频、重验身份后调用注销确认。
- `packages/db/migrations/0147_account_erasure_close.sql:80–126`：锁 profile，检查续费/角色，封闭账号、写注销请求。
  PR-E 增加 service-only 包装函数，先写摘要，再在同一事务调用既有确认函数；撤掉旧函数的服务端直调权限。
  不重写旧函数正文，不改 PR-A 已有迁移。
- `packages/api/src/lib/auth.ts:3–39`：当前身份类型为邮箱和 Google；身份来自 Auth 验证结果，不能用昵称。
  邮箱按 Auth 的大小写及首尾空白规则处理，保留点号与加号。OAuth 用验证过的 issuer/subject。

## 最小必要变更（AGENTS §5）

现有 profiles 在注销后清身份；账本只按账号 ID 防重，且财务保留期限不同于 E3。
注销审计只存进度，不能混放身份匹配用途。三者均不能独立保证身份擦除后的相等匹配。
新增一张 `opening_grant_identity_digests`，只存用途、身份类型、密钥版本、HMAC、首次赠送时间、
规则取消即清除的到期条件；没有邮箱、issuer、subject、昵称、账号 FK 或内容。
注册校验与现有账务 RPC 同一事务，用有序事务锁防并发重复赠送；不新增钱包、调度器、队列或运行平台。
余额/流水仍以 profiles / credit_transactions 为权威；摘要表只证明该身份曾领过开户赠送。
新 RPC 只授予 service_role，赠送前拒绝封闭账号。新表 RLS、account_open_required 策略和现有注销审计接入。

## 密钥配置（总控向 Owner 请求，尚未执行）

变量名 `OPENING_GRANT_HMAC_KEYS`，仅服务端：JSON 格式
`{"active":"v2","keys":{"v1":"<base64-32-byte-key>","v2":"<base64-32-byte-key>"}}`。
版本为 1–32 字符的字母/数字/下划线/短横线；每个值为规范 Base64 编码的至少 32 字节独立密钥。
active 必须在 keys 内。新增版本时保留所有仍有摘要的旧版本及密钥，读时对全部版本生成匹配摘要。
版本值和已有版本对应的密钥不可复用或替换；旧版本不能在 E3 到期之前移除。
只在本机及 secretless CI 用明显的 test-only 常量，不生成、打印或提交真实值。
部署前总控需取得 Owner 对 staging 配置的明确批准；本 PR 不授权修改真实环境。
密钥遗失无法恢复旧摘要匹配；轮换必须保留旧密钥。摘要不是完全匿名或绝对不可逆。
开户赠送规则取消后，停止赠送并清除此用途摘要；没有自动猜测到期或后台画像。

## 并行范围与迁移编号

开工时 #537 仅有 B1b 准备文件，正式 0150/built-fingerprint 尚未提交，交接保留 0150。
本任务暂用 0151，合并前按最新 staging 重核；撞号由总控交回本 writer 改号并重跑 --write-built。
#536 治理文档、#533 UI、#497 Runtime 与本任务业务文件不重叠。
ENTITLEMENTS 当前只写独立方案；约束补齐当前只写 SELECT 预检，要求 built-fingerprint 不变。
`packages/db/tests/baseline/built-fingerprint.json` 是后续迁移共同产物，不能沿用其他候选的结果。
一旦对方开始改同一文件，暂停该文件写入并在 PR 记录，待总控确定顺序后重放生成。
不修改 #537 的 erasure-constraint-audit.sql 或准备材料。

## 验证与交接

待实现/验证：相同邮箱或 issuer+subject 的注销重注册拒绝赠送；不同身份赠送；并发只一次；
大小写/空白/别名边界；新表无原文；轮换旧版本仍匹配；新会话非 service_role 读写及 RPC 拒绝；
封闭账号拒绝赠送；摘要写失败不封闭；迁移连续两次；回退后完整结构比对/重新应用；
有防刷事实时回退拒绝，避免恢复可重复领取；frozen install/API/类型/lint/safeguards/迁移账本/CI。
同 PR 执行 `node packages/db/tests/run-db-baseline-replay.mjs --local-only --write-built` 更新指纹。
所有结果按 PASS/FAIL/BLOCKED/NOT_RUN 区分，尚未运行项不计通过。

Handoff：done = 规范、live staging/保护检查、writer/开放 PR 盘点及技术方案；
next = 实现、全套本地验证和 CI，再交总控；blockers = 尚无业务阻塞，部署需要 Owner 密钥配置批准。
当前功能、数据库验证、独立审查均 NOT_RUN；不得称 clean 或 staging 验收。
