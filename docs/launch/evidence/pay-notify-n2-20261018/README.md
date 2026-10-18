# PAY-NOTIFY PR-N2

目标：按 PAY-NOTIFY §4.3 实施银行卡年付、钱包年付/创始会员、恢复 Pro、创始身份结束提醒；拒付判赢只提供模板和调用函数，不接触发器。

风险 high；从 staging 9af05d213 开始。N1 已合并：#1031 / 9f1bd6f7d3939f198520e8168951d40ef331f9a1。
沿用 N1 的发送记录、Resend API、唯一键、未知结果转人工及管理员重发；不新增表/定时任务，不改结账/回调/续费/退款。
迁移暂用 0312，由总控最终确认和上库。本窗口不合并、不上远程库、不改平台配置、不读打印密钥、不碰正式环境或真钱。

## 决定项

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

已完成：N1 合并事实、现有实现与 Owner 决定核对。下一步：实现、测试、Codex 机器人审查、CI。
阻断：真实收信需 Owner 完成上述配置；迁移编号最终确认由总控负责。
验证：尚未运行本次实现测试。
