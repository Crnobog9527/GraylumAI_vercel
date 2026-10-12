# Stripe Managed Payments 测试模式验证（2026-10-12）

状态：进行中。等 Owner 放测试密钥并在测试模式开启 Managed Payments 后运行脚本。

- 脚本：[`mp-probe.mjs`](mp-probe.mjs)（只读 `~/.graylum/secrets/stripe-test.env`，必须是 `sk_test_`，不打印密钥）
- 证据：`01-setup.json`、`02-inspect-*.json`、`03-ops-*.json`（已脱敏：账户号、邮箱、姓名、地址、链接、卡尾号都去掉）
- 结论：完成后写在本文件
