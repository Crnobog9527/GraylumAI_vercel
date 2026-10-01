# INVITE-ABUSE 方案入口

完整方案、Owner 三条规则及审阅记录维护在 PR #560 描述中；收窄方案已获准实施。

- 调研基线：`0470e7a7519ec6b37dcd54566ad459e605782ab9`（origin/staging，含 #538）。
- 风险：high，涉及邀请积分发放及 service-only RPC。
- 复用 0151 的正金额开户账本决定，限制每账号一次绑定，额度/月次数/IP 在发奖事务中判定；不扩展摘要用途。
- 本批不开启消费返利；不合并、不应用远程迁移、不连接远程数据库。本地验证见 `packages/db/tests/invite-abuse/README.md`。
