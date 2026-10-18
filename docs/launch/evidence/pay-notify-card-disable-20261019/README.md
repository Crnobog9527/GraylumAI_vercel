# PAY-NOTIFY 卡类续费提醒停用验证（迁移 0311）

候选目标：#1160，base `staging`。总控确认 #1155（0310）已合并后，本分支以 merge 同步最新 staging（基线提交 `18be0466bee5c8a2f312681452a93a69fe218bbe`），将卡类停用 SQL 放入 `packages/db/migrations/0311_disable_card_renewal_notices.sql`，并更新测试引用。未 rebase、未强推。迁移回滚方式写在 SQL 文件头；不删除历史通知行或防重键。

为落实 Owner 2026-10-19 决定并关闭机器人首轮 P1，已在 `docs/launch/MASTER_PLAN.md` 第 2.1 节记录新决定及其取代的旧安排，并同步更新 PAY-NOTIFY 方案的卡类渠道表、范围、PR-N2 内容、验收和 N1 决定。

风险：**high**（迁移改变卡类提醒扫描及系统 claim）。不改结账、回调、续费、退款、平台设置；不读密钥；不触发真实邮件、真钱、正式环境或远程迁移。历史 `card_renewal_upcoming` 仍可列表查看和管理员重发；钱包年付、创始会员到期、恢复 Pro、创始身份结束及拒付判赢准备能力保持不变。

## 验证结果

- PASS：`pnpm --filter @repo/api exec vitest run src/services/notify/registry.test.ts src/services/notify/sender.test.ts src/routers/paymentNotices.test.ts`，3 个文件、34 项通过。
- PASS：`node packages/db/tests/payment-notices/reminders-local.mjs --local-only`，本地临时 PostgreSQL 从文件构建 314/314 步；13 组场景通过。覆盖 0311 重复应用后结构不变、card/card_cn 不再生成记录、旧扫描 ID 的系统 claim 被拒、历史卡类记录仍可见/管理员可重发、钱包/创始/恢复 Pro 提醒不变，以及并发幂等、退款/冻结、注销 prune 和禁止重入队、未知结果转人工、30 天清理。
- PASS：`node packages/db/tests/run-db-baseline-replay.mjs --local-only --write-built`，完整空库回放 314/314 步、245 次重复迁移、2630 个结构组；账户开放策略审计空、0148 收敛重放不变、回滚/恢复一致、容器清理 PASS；`built-fingerprint.json` 由该命令生成。
- PASS：迁移账本针对精确 staging base `18be0466bee5c8a2f312681452a93a69fe218bbe`；`node scripts/check-code-size.mjs`；`git diff --check`。
- 待验证：推送后的 GitHub 必需 CI 和 Codex 机器人当前版本审查；没有把历史 head 的 CI/审查当作当前版本结论。
- NOT_RUN：Stripe/Link 或 Stripe Billing 邮件实测、Resend/DNS 配置、真实邮件投递、远程迁移、正式环境、真钱、合并。

首次本地数据库场景运行发现测试在完整建库（已含停用迁移）后重放卡类 SQL，会把函数定义覆盖回旧版本并使结构断言失败；已将夹具改为重复应用正式迁移 `0311_disable_card_renewal_notices.sql`，并在完整场景重跑通过。为关闭机器人 P2 加入的 claim guard 已随数据库场景和完整空库回放重新验证。

## Handoff

- 已完成：merge 同步 staging（含 #1155/0310），迁移改号为 0311，更新数据库场景引用并刷新 built-fingerprint；本地验证通过。
- 下一步：提交并推送当前版本，更新 PR 说明和验证事实；请求 Codex 机器人复审当前版本，收取所有必需 CI 并处理同范围问题。
- 阻塞：等待推送后当前 head 的必需 CI 和机器人审查全部完成且未解决线程为 0。
- 保留限制：真实邮件投递、Resend/DNS 配置及完整上游沙盒验收未验证；真实邮件、远程迁移、真钱、正式环境和合并均未执行。
