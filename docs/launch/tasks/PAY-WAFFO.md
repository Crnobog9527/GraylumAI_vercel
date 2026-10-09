# PAY-WAFFO 实施方案

状态：方案草稿；风险 high；仅文档，不授权实施、建产品、配置、交易或合并。
日期：2026-10-09。核对基线：staging `41534c4ae7e650678bf1d4d7b3d73c6ae24c72a6`。

## 1. 目标与边界

按 MASTER_PLAN §2.1 第 50、51 项及 §7.1 PAY-COMMON → PAY-WAFFO，
在现有支付公共层接入 Waffo，上线新销售只用 Waffo；Stripe 保留原订单处理及手动备用。
本方案不改实现、迁移、价格配置或 MASTER_PLAN，不调用支付商接口，不读取凭据。

本轮授权见 [#716 批次记录](https://github.com/Crnobog9527/GraylumAI_vercel/issues/716#issuecomment-6081497410)。
原话摘录：“开工 ①②③④。”
该记录把②明确列为“PAY-WAFFO 实施方案（Codex，先出方案）”；本会话明确要求 docs PR、
转为可审查、读取机器人结论并修复 P0/P1，然后停下等主窗口审计。

## 2. 初步核验

复用 payment_orders、payment_provider_refs、user_subscriptions、subscription_credit_grants、
既有退款审批和来源账本；不另建支付平台或第二套会员账本。
当前 channelSettings.ts 仍对 Waffo 拒绝下单，已有退款执行受 Stripe test 约束，
公共类型存在 Waffo 不代表已具备 Waffo 收款能力。

官方文档已发现需解决的外部能力差异，最终方案逐项给出依据和处置：
微信月累计限额与年付产品冲突；首月优惠的按月语义尚未验证；
存量创始订阅动态续费价格尚未验证；退款 API 的 14 天限制；
拒付公开文档描述邮件通知，不能臆造拒付 webhook。
