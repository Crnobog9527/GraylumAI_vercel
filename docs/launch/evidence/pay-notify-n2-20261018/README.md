# PAY-NOTIFY PR-N2

目标：按 PAY-NOTIFY §4.3 实施银行卡年付、钱包年付/创始会员、恢复 Pro、创始身份结束提醒；拒付判赢只提供模板和调用函数，不接触发器。

风险 high；从 staging 9af05d213 开始。N1 已合并：#1031 / 9f1bd6f7d3939f198520e8168951d40ef331f9a1。
沿用 N1 的发送记录、Resend API、唯一键、未知结果转人工及管理员重发；不新增表/定时任务，不改结账/回调/续费/退款。
迁移暂用 0312，由总控最终确认和上库。本窗口不合并、不上远程库、不改平台配置、不读打印密钥、不碰正式环境或真钱。

## 按推荐处理的决定项

Master Plan 2.1 已记录 2026-10-13 Owner 将 N1–N6 按推荐确认：自己发银行卡提醒、Resend 免费档、按 4.3 时点（含普通钱包年付）、中英双语、回复转客服、保留 30 天。
发件人沿用 Graylum AI <no-reply@graylum.com>（上线前 Owner 确认）；本次回复默认 support@graylum.com。
没有新增待 Owner 选择的决定项；上述是已有决定的落实。

## Owner 平台配置（不在本 PR 执行）

1. 注册/确认 Resend 免费账号，分别设置正式域名和 staging 测试子域名（如 notify-staging.graylum.com）。
2. 按 Resend 控制台指示在 DNS 填 SPF/DKIM，等域名验证通过；确认最终发件地址。
3. Owner 自己在 Graylum 后台「第三方密钥」的 resend 槽位填对应环境的密钥；不使用 Vercel 密钥后备。
4. staging/Preview 配 PAYMENT_NOTICE_TEST_RECIPIENTS（逗号分隔，仅测试邮箱），PAYMENT_NOTICE_FROM 使用验证过的测试子域名地址；回复默认 support@graylum.com。
5. 包含迁移和代码的 staging 上，用测试邮箱验证收信及回复地址；Stripe 测试时钟/钱包沙盒端到端验收另记录。

未配置时保留待发、不发信。当前不核查密钥内容；技术验证使用本机数据库及模拟 Resend，不代表实际投递成功。

## Handoff

已完成：N2 扫描、六类双语模板、现有 cron 接线、发送前业务复核、30 天清理及本机验证。下一步：最终 CI、Codex 机器人审查、由总控确认编号/上库/合并。
阻断：真实收信需 Owner 完成上述配置；迁移编号最终确认由总控负责。
验证：本机付款提醒单元 45 项、cron 7 项、API/Web lint 与类型检查通过；数据库 11 组场景通过；最新 staging 上的最终空库回放通过，built-fingerprint 已由命令生成。

## 实现与兼容

- 每日 03:00 的 `release-subscription-credits` 并行跑提醒，不新增 cron；本批留 10 秒给原任务和响应，未开始的保留下次处理。
- 发送前（包括管理员重发、未知结果短重试）在 claim 中复核实时订单、续费、退款、拒付冻结和注销；参数变化也不会套用旧正文。
- 邮件包含明确 UTC 日期；创始身份结束在结束后的首次每日扫描处理（滚动 24 小时，避免 cron 后才结束而永久漏发）。
- 沿用 N1 表、唯一键、管理员权限和状态机；迁移头写有回滚，撤回发送器不删已发/未知结果记录。
- 0312 把发送记录加入已有日志清理：每日删超过 29 天的记录，使正常每日执行时不超过 30 天；注销仍立即走已有 prune。
- 新增两个内部只读函数和一个扫描 RPC 是最小缺口：现有 N1 只有单条入队/发送，不能发现业务到期。订单/订阅、`pay_founder_status`、`pay_common_membership_facts` 保持权威；无新表、状态来源或调度器。

## 数据依赖与验收限制

恢复 Pro 扫描不假造恢复标记：要求已退款的升级订单指向原 Pro、原续费已停止、当前权威会员投影确为原 Pro，并读取原到期日。
当前 staging 的 MP 第 4 步已合并部分（#949、#951、#953）未提供完整升级退款→恢复 Pro 的实收流程；本 PR 用本机事实夹具覆盖扫描/发送，未宣称完整上游流程通过。
当前 `pay_founder_order_frozen` 仍是 F1 预留钩子；本次通过本机替身验证冻结拦截，真实冻结依赖并行 PAY-DISPUTE-GUARD D1（#1152）。
④ 没有接任何 webhook/cron：只有 CHARGEBACK 未来明确调用发送函数，才会入队和发信；定时扫描明确排除该类型。

参考：2026-10-18 已复核 [Resend 价格页](https://resend.com/pricing)（免费档日限 100 封、3 域名），
[幂等键说明](https://resend.com/docs/dashboard/emails/idempotency-keys)仍为 24 小时；不自动升级付费套餐。


## 验证记录

- PASS：`pnpm --filter @repo/api exec vitest run src/services/notify`，45 项（含重复、未知结果同键重试/转人工、重试间邮箱变化、测试白名单、六类模板）。
- PASS：`pnpm --filter web exec vitest run src/app/api/cron/release-subscription-credits/route.test.ts`，7 项（含未授权拒绝、提醒失败告警、不阻断积分释放、积分失败时仍等待邮件任务收尾）。
- PASS：`node packages/db/tests/payment-notices/reminders-local.mjs --local-only`，11 组场景，详见 `database-results.json`。测试库独立且清理完成；测试金融事实不代表真实付款。
- PASS：API/Web 的 lint、typecheck；代码大小检查。
- 说明：一次本机全量 API 测试与同步 staging 重叠，不能当作最终版本证据（7632 通过、4 失败、16 跳过）；其中同步影响的 2 组已经在稳定文件下重跑，11 项通过。最终全量以本 PR 当前版本 CI 为准。
- NOT_RUN：真实邮件投递、Resend/DNS 配置状态、Stripe 测试时钟/Link 事件、钱包沙盒付款、真实升级退款恢复 Pro、真实拒付冻结；无配置/远程上库授权，不伪造前置条件。
- NOT_RUN：④上线后 CHARGEBACK 触发（明确不接）；生产、真钱、远程迁移、合并。

## 四项核对（待最终回执更新）

1. 当前版本：待最终推送后记录。
2. CI：待当前版本全部完成，迁移号 0312 等总控最终确认。
3. Codex 机器人：待当前版本完整回执，无 P0/P1 才能算通过。
4. 未解决审查线程：待 GitHub 实查。

Validation handoff：总控应用迁移并合并部署后，在 `/admin/payment-notices` 查看异常记录；配好测试发信后按 PAY-NOTIFY §7 在沙盒验收收信、管理员同键重发（24 小时内）和实际拒付/恢复 Pro 上游链路。上述远程验收尚未通过，不能以本机夹具替代。


迁移编号阻断：本次按 Owner 要求保留暂定 0312，当前 staging 到 0306，`checkMigrationLedger` 实查缺 0307–0311。总控按最终合并顺序确认编号后，需要同步 staging、改号（如需）、重生成指纹并重新取得当前版本 CI/审查；不能把账本失败算通过。

最终空库命令 PASS：`node packages/db/tests/run-db-baseline-replay.mjs --local-only --write-built`；历史位置双跑和全链结构比对通过，容器已清理。数据库名额已释放。


机器人首轮：审查覆盖 `9de0ae80e87c7e2ea52d8af3632bf774af08aa76`，无 P0/P1，一条 P2：积分释放失败不应提前返回而截断邮件。
已按建议改为 `Promise.allSettled`，保留积分释放原顺序；两条新增测试在修复前失败（5 通过/2 失败），修复后 7 项通过，Web lint/typecheck 通过。下一轮复审针对该修复及其影响。
首轮 CI：全量 API/Web 单元与回归、lint/类型和独立安全检查通过；迁移账本/CI 合约因缺号失败，Security Unit Tests 如实随前置失败，未豁免。
