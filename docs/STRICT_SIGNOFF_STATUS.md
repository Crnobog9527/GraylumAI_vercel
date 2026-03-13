# 全站严格签核状态总表

Last updated: 2026-03-12

## Summary

按“严格签核”口径，当前结论已经收敛到一个明确状态：

- 非支付主链路已经完成严格签核所需的主要验证
- 后台验收、关键设置生效、Vercel 运行时证据、本地安全/RLS 收尾和本地性能最终签核都已有对应证据
- 当前明确未完成的大项只剩支付闭环
- 少量注释、样式命名和文档层面的历史技术债仍存在，但不再构成功能签核阻塞

## 严格签核矩阵

| 领域 | 严格签核状态 | 当前判断 |
| --- | --- | --- |
| 前端主功能 | `已基本通过` | 登录、聊天、用户中心、后台主流程、功能广场、关键设置生效、Vercel preview 上的 AI runtime proof 已有证据，不能算当前主要阻塞 |
| 后端主功能 | `已基本通过` | 用户路由、后台路由、邀请、签到、工单、计费主链路、diagnostics 主链路都有自动化或运行时证据 |
| 后台全量验收 | `通过` | [`ADMIN_ACCEPTANCE_MATRIX.md`](./ADMIN_ACCEPTANCE_MATRIX.md) 当前全页为 `verified` |
| 高价值设置真实性 | `通过` | [`ADMIN_SETTINGS_EFFECT_MATRIX.md`](./ADMIN_SETTINGS_EFFECT_MATRIX.md) 的非支付项已是 `verified` 或 `retired-reference` |
| 假功能 / 假提示 / 空入口 | `基本通过` | 非支付主链路里大头已经清掉；仍保留的明显未完成交互基本都被收束到支付门禁 |
| 功能关联真实性 | `基本通过` | 后台改值到前台/运行时生效的主要链路已验证；AI runtime 的 preview-only effect proof 也已补齐 |
| 硬编码排查 | `基本通过` | 用户可见文案、运行时 fallback 和默认跳转已不再依赖品牌硬编码；剩余主要是注释、样式命名和少量文档中的历史品牌字样 |
| 数据库 RLS | `基本通过` | 核心表 RLS、tRPC 用户态 client、非 tRPC 的 `ai/stream` 用户态路径，以及 Supabase Security Advisor 对应的 repo-backed 数据库问题都已处理；剩余主要是平台手工设置与持续审计要求 |
| 安全漏洞扫描/审计 | `基本通过` | 关键问题已修，关键回归已补，Supabase Security Advisor 的代码/数据库问题已清空；剩余主要是免费套餐下的 `Leaked Password Protection` accepted risk 与未来 drift 审计要求 |
| 网站性能优化 | `通过` | [`PHASE4_LOCAL_PERFORMANCE_BASELINE.md`](./PHASE4_LOCAL_PERFORMANCE_BASELINE.md) 已记录 landing/public、marketplace、profile、chat、admin 高价值页面的最终本地验证与签核证据 |
| Vercel 运行时最终证据 | `通过` | 真实流式、`route_upgraded`、abort、diagnostics runtime proof、smart routing/search decision effect proof 都已在 preview 闭环 |
| 支付闭环 | `基本通过` | Stripe 测试环境密钥、`price_xxx`、checkout 成功/取消/失败、webhook 签名校验、重放幂等、积分到账和会员到账都已在本地 `test mode` 验证；部署环境 preview 已验证登录、webhook 路由可达，且点击购买会真实跳转到 Stripe Checkout |

## 当前仍阻止“全站严格签核完成”的项目

### 1. Stripe 正式发布前仍有最后发布动作

Stripe 代码、测试密钥、价格和本地 `test mode` 验收已经完成，但正式发布前仍有两类发布动作：

- 在 Vercel preview / production 配齐 Stripe 环境变量后，完成部署环境购买 smoke
- 正式生产配置与支付发布检查

## 当前发布操作状态

- 非支付功能严格签核：已完成
- 上线前发布资产：已补齐
  - [`RELEASE_PREP_CHECKLIST.md`](./RELEASE_PREP_CHECKLIST.md)
  - [`runbooks/PRE_RELEASE_REHEARSAL.md`](./runbooks/PRE_RELEASE_REHEARSAL.md)
  - [`runbooks/PRODUCTION_RELEASE.md`](./runbooks/PRODUCTION_RELEASE.md)
  - [`STRIPE_ENABLEMENT_CHECKLIST.md`](./STRIPE_ENABLEMENT_CHECKLIST.md)
- 当前唯一明确未完成的大功能：Stripe 最终发布动作

## 非阻塞后续项

### 1. 安全与 RLS 的持续审计要求仍存在

[`PHASE4_SECURITY_RLS_AUDIT.md`](./PHASE4_SECURITY_RLS_AUDIT.md) 里保留的是持续治理要求，而不是当前阻塞：

- 后续新增的非 tRPC 普通用户路径仍要继续遵守“优先 `supabaseAuth`、特权操作才走 `supabaseAdmin`”的规则，避免未来回退
- 如果后续需要更严格的附件控制，可进一步收紧签名 URL 生命周期或改成专门下载路由
- Supabase Auth 的 `Leaked Password Protection` 在免费套餐下仍属于平台限制下的 accepted risk
- 若 Security Advisor 再次报告 repo 中不存在的数据库对象，应继续按“线上数据库漂移”单独审计和清理；当前已通过 [`0016_live_db_drift_security_cleanup.sql`](../packages/db/migrations/0016_live_db_drift_security_cleanup.sql) 清掉首批漂移项

### 2. 残余技术债仍未完全归零

运行时代码里的品牌 fallback、客服邮箱 fallback 和旧域名默认值已经集中收口；但仓库里仍保留少量注释、样式命名和历史文档中的品牌字样，这些不再构成功能签核阻塞，只算低风险技术债。

## 最终严格结论

在严格签核口径下，当前最准确的结论是：

- 非支付主功能、后台验收、关键设置生效、Vercel 运行时证据、本地安全/RLS 收尾和本地性能签核已经通过
- Stripe 本地 `test mode` 验收也已经基本通过
- 当前仍未完成并阻止“全站严格签核完成”的只剩支付的最终发布动作

## 证据来源

- [`ADMIN_ACCEPTANCE_MATRIX.md`](./ADMIN_ACCEPTANCE_MATRIX.md)
- [`ADMIN_SETTINGS_EFFECT_MATRIX.md`](./ADMIN_SETTINGS_EFFECT_MATRIX.md)
- [`PHASE4_SECURITY_RLS_AUDIT.md`](./PHASE4_SECURITY_RLS_AUDIT.md)
- [`PHASE4_LOCAL_PERFORMANCE_BASELINE.md`](./PHASE4_LOCAL_PERFORMANCE_BASELINE.md)
- [`refactor-parity/current-audit/function-comparison-matrix.draft.md`](./refactor-parity/current-audit/function-comparison-matrix.draft.md)
- [`refactor-parity/current-audit/issue-list.draft.md`](./refactor-parity/current-audit/issue-list.draft.md)

## Assumptions

- 本结论按“严格签核”口径，不按“工程上主链路已完成”口径。
- “已通过”要求有自动化或部署环境证据，不接受仅凭代码存在或本地感觉可用。
- “未完全通过”不等于主链路不可用，而是表示仍有明确 follow-up、accepted risk、或未完成的全站级证明。
