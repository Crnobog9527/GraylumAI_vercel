# 全站严格签核状态总表

Last updated: 2026-03-30

## Summary

按“严格签核”口径，当前结论已经收敛到一个明确状态：

- 非支付主链路已经完成严格签核所需的主要验证
- 后台验收、关键设置生效、Vercel 运行时证据、本地安全/RLS 收尾和本地性能最终签核都已有对应证据
- Stripe preview / production 发布动作、生产 webhook 可达性、生产 checkout smoke，以及第一笔真实 live 支付验收已经完成
- 运行时代码日志治理已经收口，`apps/web/src` 与 `packages/api/src` 的剩余例外只保留在日志封装入口
- 聊天主链新的 requestId 级闭环 smoke 已写入 `chat.spec.ts`，并已在 2026-03-30 的锁定 preview preflight 中通过
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
| 支付闭环 | `通过` | Stripe 本地 `test mode` 验收、preview smoke、production webhook 可达性、production checkout smoke，以及 2026-03-22 的第一笔真实 live 支付验收均已完成；`payment_orders`、`credit_transactions` 与用户积分到账结果一致 |

## 当前仍阻止“全站严格签核完成”的项目

当前无新的功能级阻塞项。

按本次严格签核口径，阻塞“全站严格签核完成”的 Stripe 最终发布动作已经闭环。

## 当前发布操作状态

- 非支付功能严格签核：已完成
- 上线前发布资产：已补齐
  - [`RELEASE_PREP_CHECKLIST.md`](./RELEASE_PREP_CHECKLIST.md)
  - [`runbooks/PRE_RELEASE_REHEARSAL.md`](./runbooks/PRE_RELEASE_REHEARSAL.md)
  - [`runbooks/PRODUCTION_RELEASE.md`](./runbooks/PRODUCTION_RELEASE.md)
  - [`STRIPE_ENABLEMENT_CHECKLIST.md`](./STRIPE_ENABLEMENT_CHECKLIST.md)
- Stripe 最终发布动作：已完成
- 2026-03-22 真实 live 支付验收：已完成

## 非阻塞后续项

### 1. 安全与 RLS 的持续审计要求仍存在

[`PHASE4_SECURITY_RLS_AUDIT.md`](./PHASE4_SECURITY_RLS_AUDIT.md) 里保留的是持续治理要求，而不是当前阻塞：

- 后续新增的非 tRPC 普通用户路径仍要继续遵守“优先 `supabaseAuth`、特权操作才走 `supabaseAdmin`”的规则，避免未来回退
- 如果后续需要更严格的附件控制，可进一步收紧签名 URL 生命周期或改成专门下载路由
- Supabase Auth 的 `Leaked Password Protection` 在免费套餐下仍属于平台限制下的 accepted risk
- 若 Security Advisor 再次报告 repo 中不存在的数据库对象，应继续按“线上数据库漂移”单独审计和清理；当前已通过 [`0016_live_db_drift_security_cleanup.sql`](../packages/db/migrations/0016_live_db_drift_security_cleanup.sql) 清掉首批漂移项

### 2. 残余技术债仍未完全归零

运行时代码里的品牌 fallback、客服邮箱 fallback 和旧域名默认值已经集中收口；运行时代码日志治理也已完成；2026-03-30 旧非流式聊天链路（`useAIChat`、旧 `ChatInterface` 与 `components/ai` 目录）也已从仓库移除。当前剩余主要是少量注释、样式命名和历史文档中的品牌字样，这些不再构成功能签核阻塞，只算低风险技术债。

### 3. 锁定 preview 的全量 preflight 已经全绿

`apps/web/tests/e2e/chat.spec.ts` 已新增基于 `requestId` 的聊天主链闭环验证，能够把 `/api/ai/stream` 成功响应、`ai_usage_logs`、`conversations/messages`、`token_stats` 与 `credit_transactions` 串成一条证据链。2026-03-30 首次锁定 preview 实跑时，初始化 `/api/trpc` 请求被批量打成 `503`；根因确认是 preview deployment 上的 fail-closed 守门逻辑误把 `NODE_ENV=production` 的 Vercel preview 当成 production。修复 `proxy.ts`、`api/trpc/[trpc]/route.ts` 以及 rate limit helper 后，新的 preview `https://graylum-ai-vercel-v1-7wmlf92aa-simons-projects-bfe3e99f.vercel.app` 已通过定向 smoke，并在 `.release-output/preflight/20260330-020359/` 中留下 `preview-chat: passed` 的预发布证据。随后针对 `*.vercel.app` preview host 继续补齐 app-domain 认证分支，并将 admin runtime proof 用例切换为与 `chat.spec.ts` 一致的稳态输入策略后，二次 preview preflight `.release-output/preflight/20260330-021726/` 已把 `preview-auth`、`preview-chat`、`preview-admin`、`preview-admin-ops`、`preview-security` 一并转绿。

在此基础上，继续修复 preview host 认证、公开站点设置读取、模块公开查询、账单记录回退和 E2E 稳态输入后，锁定 preview `https://graylum-ai-vercel-v1-ra0wk8t1e-simons-projects-bfe3e99f.vercel.app` 的全量预发布验收 `.release-output/preflight/20260330-031226/` 已显示：

- `preview-auth: passed`
- `preview-chat: passed`
- `preview-admin: passed`
- `preview-admin-config: passed`
- `preview-admin-ops: passed`
- `preview-security: passed`
- `preview-user-extended: passed`
- `preview-user-supplemental: passed`

这意味着先前 preview 中残留的 `preview-admin-config`、`preview-user-extended`、`preview-user-supplemental` 已全部闭环，不再保留为当前阻塞项。

## 最终严格结论

在严格签核口径下，当前最准确的结论是：

- 非支付主功能、后台验收、关键设置生效、Vercel 运行时证据、本地安全/RLS 收尾和本地性能签核已经通过
- Stripe 本地 `test mode`、preview、production smoke 与真实 live 支付验收均已通过
- 当前已无明确阻止“全站严格签核完成”的功能级阻塞项

## 2026-03-22 生产支付验收结果

- 真实 Checkout Session：`cs_live_...`
- 订单：已遮罩
- 订单状态：`status=completed`，`payment_status=paid`
- 完成时间：`2026-03-22T04:12:55.398Z`
- 用户：已遮罩
- 支付前积分：`2796`
- 支付后积分：`3296`
- 积分交易：新增 `purchase +500`，描述为 `Stripe 购买积分包: 测试`
- 备注：本次 `amount_total=95` 与 `credit_packages.price=100` 的差异来自生产 `pro.package_discount=95`，属于会员折扣生效，不属于 Stripe Price 配置漂移

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
