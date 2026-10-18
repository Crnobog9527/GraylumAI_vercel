# PAY-NOTIFY 卡类续费提醒停用验证（迁移 0313）

候选目标：#1160，base `staging`。本次只把已通过付款提醒场景验证的卡类停用 SQL 从测试夹具迁入正式追加迁移 `packages/db/migrations/0313_disable_card_renewal_notices.sql`，并更新测试引用。迁移回滚说明位于 SQL 文件头；不删除历史通知行或防重键。

为落实 Owner 2026-10-19 决定并关闭机器人首轮 P1，已在 `docs/launch/MASTER_PLAN.md` 第 2.1 节记录新决定及其取代的旧安排，并同步更新 PAY-NOTIFY 方案的卡类渠道表、范围、PR-N2 内容、验收和 N1 决定。

机器人第二轮发现 P2：迁移前旧 cron 可能已持有卡类 ID、迁移后才 claim。0313 现在拒绝无管理员身份的旧卡类系统 claim，同时保留显式管理员重发；数据库回归先模拟该旧 ID，再验证系统 claim 跳过、管理员 claim 仍发送。新 head 仍需机器人复审确认。

## 验证结果

- PASS：`pnpm --filter @repo/api exec vitest run src/services/notify/registry.test.ts src/services/notify/sender.test.ts src/routers/paymentNotices.test.ts`，3 个文件、34 项通过。
- PASS：`node packages/db/tests/payment-notices/reminders-local.mjs --local-only`，本地临时 PostgreSQL 从文件构建 313/313 步；13 组场景通过。覆盖 0313 重复应用后结构不变、card/card_cn 不再生成记录、旧扫描 ID 的系统 claim 被拒、历史卡类记录仍可见/管理员可重发、钱包/创始/恢复 Pro 提醒不变，以及并发幂等、退款/冻结、注销 prune 和禁止重入队、未知结果转人工、30 天清理。
- PASS：`node packages/db/tests/run-db-baseline-replay.mjs --local-only --write-built`，完整空库回放 313/313 步、244 次历史重复迁移、2630 个结构组；账户开放策略审计空、0148 收敛重放不变、回滚/恢复一致、容器清理 PASS；`built-fingerprint.json` 由该命令生成。
- PASS：`node scripts/check-code-size.mjs`；`git diff --check`。
- BLOCKED：`scripts/check-migration-ledger.mjs` 针对 PR base `373e91d0efff54ce067ca48082863e2d889590fc` 报缺少 0310、0311、0312；GitHub CI 的 migration ledger 和 required-check contract 因此失败。staging 目前最高号为 0309，0310/#1148、0311/#1155 仍开放，0312 不在 staging。0313 完整链空库回放通过，但账本 CI 需待前序迁移进入 staging 后同步并复验。
- NOT_RUN：Stripe/Link 或 Stripe Billing 邮件实测、Resend/DNS 配置、真实邮件投递、远程迁移、正式环境、真钱、合并。

首次本地数据库场景运行发现测试在完整建库（已含 0313）后重放 0309，会把函数定义覆盖回旧版本并使结构断言失败；已把夹具修正为重复应用 0313，并在完整场景重跑通过。为关闭机器人 P2 加入的 claim guard 已随数据库场景和完整回放重新验证。

本地临时数据库已由测试命令清理；数据库名额归还在验证完成后记录。当前版本 CI、独立机器人复审与未解决审查线程以 PR #1160 最新 Handoff 为准。
