# REL-1 上线手册和上线前清单（目标 2026-10-31）

> 2026-10-17 整理，依据 staging `9f1bd6f7` 和当天 GitHub 上的 PR 状态；同日按 Owner 三项决定（第 6 节）改写。
> **这份文件不授权任何操作。** 合并到 `main`、读写正式库、改正式平台设置、新增或更换密钥、真钱操作，
> 都要按 [AGENTS.md](../../../AGENTS.md) 第 1 节在动手前由 Owner 在当前对话里明确同意；同意只对当时说清楚的那一个版本有效。

## 0. 这次要做到什么、怎样算做完、不做什么

- **要做到**：Owner 要求应用 2026-10-31 前正式上线（总控-8 转达）。本文把散在
  [Master Plan](../MASTER_PLAN.md) 第 7.1 节 V3-M3 → REL-1 行、第 2.1 节、第 7.6 节、第 9.3 节和各任务文档里的
  "上线前 / 上线时"事项收成一张清单，排出到 10-31 的倒排时间表，列出所有需要 Owner 亲自操作或批准的点。
- **怎样算做完**：清单每一项都写了是什么、为什么、谁做、依赖哪个 PR、怎么验证，并给出仓库里的出处；
  仓库里找不到出处的标 **待核实**，不编。
- **不做什么**：不执行任何正式环境操作，不读正式库（`fhmshnqjjnnlvplojktv`），不碰正式 Vercel；
  不改产品决定；不替代 [RUNTIME_PROD_PLAN](../RUNTIME_PROD_PLAN.md) 第 7.3 节的上线顺序和第 8 节的批准包，本文按它们展开。

"谁做"一栏的三种写法：

| 写法 | 意思 |
| --- | --- |
| **Owner 操作** | 只能由 Owner 本人在平台后台或外部账号上点（付费、密钥、条款、对外发信等） |
| **总控（需批准）** | 总控执行，但每一次正式环境的读、写、合并都要 Owner 当次批准 |
| **执行窗口** | AI 在 staging 上自己做完（开 PR、测试、复审），按 AGENTS 第 3、4 节合并到 staging |

旧文档的关系：[RELEASE_PREP_CHECKLIST](../../RELEASE_PREP_CHECKLIST.md) 和
[PRODUCTION_RELEASE](../../runbooks/PRODUCTION_RELEASE.md) 写于旧 Stripe Checkout 和旧聊天时期，
其中的环境变量核对、Auth 回调、Sentry、发布后记录仍可参考；和本文冲突的以本文和 Master Plan 为准。
例如 RELEASE_PREP_CHECKLIST 第 54 行"撤掉 `next.config.ts` 里的 noindex 响应头"已不需要改代码：
现在 `next.config.ts` 第 63–66 行按 `SITE_INDEXING` 生成响应头，设成 `public` 后构建出来就不再带 noindex。

## 1. 现在离上线还差什么（2026-10-17）

### 1.1 还没完成的上线前置任务

V3-M3 → REL-1 的依赖是"以上全部"（Master Plan 第 7.1 节第 2375 行、第 7.2 节第 2413 行）。
按 `node scripts/plan-progress.mjs --ref origin/staging` 的结果，下面这些还没标完成：

| 情况 | 任务 | 在途 PR |
| --- | --- | --- |
| 被阻塞，没开工 | VOICE | — |
| 实施中，有在途 PR | RUNTIME-PROD、REPORT-GEN、REPORT-VISUAL、CONTENT-CONVERSATION-DRIVEN、RUNTIME-FAILURE-RECONCILE、RESEARCH-TOOLS、ADMIN-SECRETS、LIB-DOCS、EXPERT-CONSULT、FUSION-REVIEW、FUSION-COMPARE、PUBLISH-MONITOR、PAYWALL、PAY-STRIPE-MP、PAY-FOUNDER、PAY-DISPUTE-GUARD、ANALYTICS、PUBLIC-SITE | #1073、#1102、#1106/#1108、#1036、#1061、#1062、#1041、#1022/#1042/#1050/#1051、#1060、#1098、#1099（方案 #1059）、#1075/#1081、#1097、#1101/#1104/#1111、#1110、#1069、#1076/#1077、#992/#1088/#1090/#1091 |
| 实施中，没有在途 PR（剩余工作待核实） | AGENT-CORE、AGENT-CORE-UI、CONVERSATION-DRIVEN-CAPTURE、CHAT-NATIVE-OUTPUT、PROMPT-CACHE-HISTORY、DB-BASELINE（已核实实质完成，待标完成）、STAGING-HOST-CLEANUP、DATA-ERASURE、UI-A、UI-MODEL、UI-B、UI-C、UI-FINISH、PAY-COMMON、POSITIONING-GATE、MODEL-IDENTITY-GUARD、PAY-NOTIFY、PAY-EVIDENCE、LEGACY-CLOSE、SKILL-I18N-HOOK | — |
| 已定，不阻塞 | MODERATION（Owner 2026-10-17 定上线时继续暂缓、上线后再定，Master Plan 第 2.1 节） | — |

（2026-10-18 按 `node scripts/plan-progress.mjs --ref origin/staging` 重列；#1027 SKILL-I18N-HOOK、#1030 LEGACY-CLOSE、#1032/#1033 PUBLISH-MONITOR、#1038 PAY-DISPUTE-GUARD D0 已合并，不再在途。）

"实施中、没有在途 PR"的任务，有的可能其实已经做完、只是没在第 7.1 节标"完成"。
冻结前由总控逐个对照验收记录，做完的标"完成"，没做完的列进第 3 节的缺口清单。

**最高优先（上线 P1）：正式环境还不能真实调用模型。** 新 Runtime 只在 staging 测试窗口里能真实调用；
计费入口 `bill2_prepare` 只接受 `isolated` 和 `staging_test` 两种模式（`packages/db/migrations/0162_bill_payg.sql` 第 518 行，
沿用 `0108_runtime_staging_window.sql` 第 185 行），正式环境的报价、准入和开放机制都还没有。
归 RUNTIME-PROD，由 RUNTIME-PROD 执行窗口实现，**10-25 冻结前必须合并并在 staging 验证**（清单 R1）。
出处：第 71 行、第 2545 行（P1，上线前必须）、第 1335 行（正式环境每次调用前按最新价格自动冻结的总控记录）、第 2328 行（RUNTIME-PROD 任务行）。

另外两项没有对应任务行、但上线前必须做：
- **单主机 `/app` 路由搬迁**：Master Plan 第 934 行定为上线前完成，第 748 行排在"冻结窗口最后做"。
  staging 的 `apps/web/src/app/` 下目前还没有 `/app` 前缀的目录，归 PUBLIC-SITE，**还没开 PR**。
- **vercel.json 定时任务改频率**：见清单 A2，**还没开 PR**。

### 1.2 staging 迁移队列 0271–0288（Owner 2026-10-17 已一次批准，冻结前合并并应用；编号为暂定，最终号由总控在合并时按“谁先准备好谁拿号”逐个给，不按下表编号顺序）

| 暂定号（2026-10-17 旧分配，已不唯一） | PR | 任务 |
| --- | --- | --- |
| 0271 | #1030（已合并） | LEGACY-CLOSE PR-C 删除 3 张旧对话表 |
| 0272 | #1032 | PUBLISH-MONITOR PR-3a 每日刷新和快照 |
| 0273 | #1027 | SKILL-I18N-HOOK |
| 0274 | #1033 | PUBLISH-MONITOR PR-5 一键发布 |
| 0275 | #1038 | PAY-DISPUTE-GUARD PR-D0 |
| 0276 | #1036 | CONTENT-CONVERSATION-DRIVEN A2 |
| 0277 | #1041 | ADMIN-SECRETS OR-1 |
| 0278 | #1042 | LIB-2d 单图计费前提 |
| 0279 | #1022 | LIB-4b Agent 读资料库 |
| 0280 | #1050 | LIB-2d 保存浏览器识别结果 |
| 0281 | #1060 | EXPERT-CONSULT |
| 0282 | #1061 | RUNTIME-FAILURE-RECONCILE |
| 0283 | #1062 | RESEARCH-TOOLS 研究子调用余额不足暂停 |
| 0284–0288 | 见第 7 节 | 2026-10-18 起编号改为“谁先准备好谁拿号”。0271–0275 已合并并应用到 staging，号已定；0276–0283 已有重复（#1041/#1036 同为 0276；合集 #1116 把 #1022、#1060、#1062 等改为暂定 0277–0282，与上表 #1042/#1050 等冲突），**不要照本表的号建文件**，每个 PR 合并时由总控给唯一号并同步本表 |

编号以总控的账本为准；账本要求连续，前一个没合，后面的不能先应用。
Owner 2026-10-17 一次批准了 0271–0288 在 staging 的应用（总控转达），不再逐个请批；0288 之后的新迁移仍由总控分配编号。
正式库不逐个应用这些迁移，而是在新项目里从空库一次建库（清单 B1）。

### 1.3 范围和日期（Owner 2026-10-17 已定）

剩 14 天，VOICE、UI-C 还没开工，FUSION-COMPARE 只有方案，PUBLISH-MONITOR 还有多个 PR。
Owner 2026-10-17 选 A（原话见第 6 节）：**日期不变，10-25 冻结**；冻结时还没验收的功能关掉开关，
落地页和价格页隐藏对应说法；**10-24 由总控把缺口清单交 Owner 一次批**。哪些功能不上，以那份清单的批复为准，本文不预先认定。

## 2. 上线前清单

每一项的"出处"都是仓库里的文件和行号，**行号以 staging `9f1bd6f7` 为准**（本 PR 在 Master Plan 第 2.1 节开头加了一条决定，合并后 Master Plan 的行号会往后移；
查原文请看 `https://github.com/Crnobog9527/GraylumAI_vercel/blob/9f1bd6f7/docs/launch/MASTER_PLAN.md`）。只写"第 N 行"的指 Master Plan。

### 2.0 新建正式 Supabase 项目要配置的全部项目（Owner 2026-10-17 选新建）

新项目建好后，下面每一项都要配一遍。"Owner 操作"的项涉及付费、密钥或外部账号，AI 不经手；
"总控（需批准）"的项由总控在 Owner 当次批准后执行，执行后读回核对。密钥一律不进仓库、PR 和聊天。

| # | 配什么 | 谁做 | 怎么验证 | 出处 |
| --- | --- | --- | --- | --- |
| N1 | 新建 Supabase 项目：所在组织和套餐（备份窗口见 A7）、区域、**PostgreSQL 17**；数据库密码由 Owner 设置，放 `~/.graylum/secrets/`，不发在聊天里 | Owner 操作（付费）。区域：**已核实**：staging 在 `us-west-2`（Supabase 项目读回，2026-10-18）；建议正式项目同选 `us-west-2`，目标用户主要在美国，新项目区域建好后不能改，Owner 选定 | 项目设置页读回 PG 版本 17 | STAGING_REPRODUCIBILITY 第 228–229 行 |
| N2 | 项目设置 `rls_auto_enable` / `ensure_rls` 事件触发器的取值和 staging 一致 | 总控（需批准）核对；需要改时 Owner 在后台点 | 读回设置 | STAGING_REPRODUCIBILITY 第 233–235 行 |
| N3 | 扩展：确认平台自带 `supabase_vault`；确认项目允许迁移 0010 建 `pg_cron`、0148 再删掉 | 总控（需批准只读） | 扩展列表读回；不允许时停下请 Owner 定，不跳过迁移 | ADMIN-SECRETS 第 38 行；STAGING_REPRODUCIBILITY 第 243–246 行 |
| N4 | 从空库建库（B1）并导入配置（B2）。存储桶（资料库私有桶、工单附件等）由 `0000` 基线和迁移建出来，不手动建 | 总控（需批准） | 指纹比对通过；B6 存储桶核对 | 第 2337 行（基线补存储桶）；STAGING_REPRODUCIBILITY 第 223–255 行 |
| N5 | Auth 基本设置：Site URL 是主机根 `https://www.graylum.com`（**不是** `/app`）；Redirect URLs 允许 `https://www.graylum.com/**`，不加 app 域；登录回调处理仍是根路径的 `/auth/callback`，`verify-email`、找回密码等登录入口页也留在根路径；邮件模板不改；邮箱确认开启 | 总控（需批准）按 staging 的设置列出清单，Owner 在后台点或批准总控点 | 新邮箱注册、确认、找回密码都回到 www | 第 934 行；SEO_GEO_SPEC 第 24–26、223 行；PRODUCTION_RELEASE 第二节 |
| N6 | Google 登录：在 Google Cloud 的 OAuth 客户端里加上新项目的回调地址（`https://<新项目编号>.supabase.co/auth/v1/callback`），把客户端编号和密钥填进新项目 | Owner 操作（凭证） | 用 Google 账号真实登录一次，只发一次注册赠送 | **仍需 Owner**：OAuth 客户端在 Google Cloud 后台，仓库和 staging 数据库里都查不到；需要 Owner 在 Google Cloud 控制台确认现有客户端编号，并在“已授权的重定向 URI”里加新项目回调；Google 登录相关的产品规则见第 1294 行 |
| N7 | 邮件 SMTP：新项目里配 Resend SMTP（发件人 `no-reply@graylum.com`），SMTP 密码是 Resend 的密钥 | Owner 操作（凭证） | 注册确认邮件真实送达 | [v10.1](../Graylum_Master_Plan_v10.1.md) 第 305 行；第 604 行（N5 发件地址） |
| N8 | 人机验证：新项目开启 hCaptcha（填 hCaptcha 的密钥）；Vercel 正式环境的 `NEXT_PUBLIC_HCAPTCHA_SITEKEY` 用同一个站点 | Owner 操作（凭证） | 登录、注册、注销弹窗都出现验证 | `.env.example`；DATA_ERASURE_RETENTION_CHECKLISTS 第 52 行 |
| N9 | 邮件模板、密码强度等其余 Auth 设置和 staging 对齐 | 总控（需批准）列出差异，Owner 在后台点 | 逐项读回 | **总控任务（不需 Owner 批准）**：仓库里没有 `supabase/config.toml`，Auth 设置（邮件模板、密码强度、Site URL 等）只存在 Supabase 后台，select 读不到；由总控用管理接口只读导出 staging 的 Auth 配置（只读 staging，不涉及凭证和设置修改），整理成与新项目对照的清单；只有把设置应用到新正式项目时才需 Owner |
| N10 | 把新项目的 `NEXT_PUBLIC_SUPABASE_URL`、`NEXT_PUBLIC_SUPABASE_ANON_KEY`、`SUPABASE_SERVICE_ROLE_KEY`、`DATABASE_URL` 填进 Vercel 正式项目 `graylum-ai-vercel-v1`；`EXPECTED_SUPABASE_PROJECT_REF` 改成新项目编号，`EXPECTED_APP_HOST` 改成 `www.graylum.com` | Owner 操作（新凭证） | 变量名存在（不读值）；部署后应用连的是新项目 | `.env.example` |
| N11 | Vercel 正式环境其余变量：`NEXT_PUBLIC_APP_URL`、`NEXT_PUBLIC_AUTH_APP_URL`、`NEXT_PUBLIC_SITE_NAME`、`NEXT_PUBLIC_APP_NAME`、`NEXT_PUBLIC_SUPPORT_EMAIL`、`APP_ENV` / `NEXT_PUBLIC_APP_ENV`、`CRON_SECRET`（**新增凭证，Owner 设置**；没有它正式环境所有定时任务都返回 503，A2 的前提）、`OPENING_GRANT_HMAC_KEYS`、`API_SIGNATURE_SECRET` / `REQUIRE_API_SIGNATURE`、Sentry 几个变量、Upstash 两个（A5）、Stripe 三个和 `STRIPE_CARD_RECONCILIATION_MODE`（D7）、`SITE_INDEXING`（E3）、功能开关（F 组）。**不设**：任何 `V3_RUNTIME_STAGING_*`（含 `V3_RUNTIME_STAGING_ENABLED`）；运行时相关变量见 R5、`WAFFO_TEST_*`、`LANDING_PREVIEW_FEATURES`、`E2E_*` | 新密钥类由 Owner 操作；非密钥的值由总控（需批准）设置 | 变量名清单读回，和本行对照 | `.env.example`；`apps/web/src/lib/landing/landing-flags.ts` 第 12–13 行；RELEASE_PREP_CHECKLIST 第 55 行 |
| N12 | Vault：确认装好并应用了 0259（B3）；6 把业务密钥和 Resend 由 Owner 在新站后台填（C1、C3） | Owner 操作；总控只读核对 | 后台槽位都显示"后台已填写" | ADMIN-SECRETS 第 8 节 |
| N13 | 各平台回调地址改到新环境：Stripe 回调（D4）、Post for Me Webhook（C8）都指向 `https://www.graylum.com/api/...` | Owner 操作 | 平台后台投递成功 | MIGRATION-PLAN 第五节第 4 项；ADMIN-SECRETS 第 8 节第 2 项 |
| N14 | 管理员账号：在新项目里注册 Owner 的管理员账号并授予管理员角色（staging 的测试账号不复制） | Owner 注册；授权由总控（需批准）执行 | 管理员能进后台，普通账号被拒 | 第 9.3 节第 2677 行（不复制测试账号） |
| N15 | 备份：确认每日备份和 PITR 的保留期（A7），必要时开 PITR | Owner 操作（付费） | 后台读回 | DATA_ERASURE_BACKUP_RESTORE_REPLAY 第 34–36 行 |

### R. 最高优先：正式环境的模型调用

| # | 做什么 | 为什么 | 谁做 | 依赖 | 怎么验证 | 出处 |
| --- | --- | --- | --- | --- | --- | --- |
| R1 | 正式环境的模型调用通路：`bill2_prepare` 等计费入口接受正式模式；正式环境按最新价格快照自动推导冻结上限和 `max_price`（涨价按新价冻结，不需要重新批准、不停止调用）；正式准入的审批和开放机制；止损（每用户每日上限、全站每日成本上限和告警、供应商余额告警，一键停止开关已由 RATE-LIMIT 交付）；`provider` 字段语义理清 | 不做这一项，上线后用户发消息模型根本不会回答 | **RUNTIME-PROD 执行窗口**（PR #1073，迁移 0292，high） | AGENT-CORE 稳定；BILL-PAYG（已交付的逐次冻结）；MODEL-PRICING-SYNC（价格读取） | **10-25 冻结前合并并在 staging 验证**：正式模式的计费、冻结、结算、拒绝、重复提交、并发和失败路径在隔离测试里通过；staging 测试窗口的现有路径不变；上线当天 H4 小额冒烟再验一次 | 第 71、1335、2328、2545 行；[RUNTIME_PROD_PLAN](../RUNTIME_PROD_PLAN.md) 第 7.3、8 节；`packages/db/migrations/0162_bill_payg.sql` 第 518 行 |
| R2 | 正式库标记：新建正式库按迁移建库（含 0292）之后、开放模型调用之前，用库所有者执行 `INSERT INTO system_settings(key,value) VALUES('runtime_environment','"production"'::jsonb) ON CONFLICT(key) DO UPDATE SET value=excluded.value;`，读回 `SELECT public.runtime_production_database();` 为 true（该函数不对 service_role 开放；后台设置页不能写这个键）。正式库里不能有启用的测试窗口，否则正式调用自动关闭。**绝不在 staging 库写这个标记** | 代码靠它认出"这是正式库"，才走正式模式 | 总控（需批准） | R1 合并；B1 | 读回为 true；正式库测试窗口为 0 条启用 | RUNTIME-PROD 窗口转交（PR #1073） |
| R3 | 计费配置行：`billing_credits_per_usd`=100、`billing_token_price_multiplier`=6 必须作为真实设置行写入（正式模式不接受代码默认值） | q=100、m=6 是 Owner 已定数值 | 总控（需批准每一组数值） | R1；B1 | 读回两行 | 同上；第 1450 行 |
| R4 | 正式准入档案：`system_settings.runtime_payg_production` = `{version:1, enabled, policyVersion, profiles:[…]}`，结构同 staging 的 `runtime_payg_staging`，但没有 windowId 和到期日（取代 H3 里"准入记录"的写法）；应急关闭写 `{"enabled":false}` | 哪些模型和线路能被正式调用 | 总控（需批准） | R1；R3 | 读回档案；关闭后新调用被拒 | 同上 |
| R5 | Vercel 正式项目环境变量（非密钥）：`V3_RUNTIME_PRODUCTION_PROJECT_ID`（正式项目 ID）、`V3_RUNTIME_PRODUCTION_DATABASE_HOST`（新正式 Supabase 主机）、`V3_RUNTIME_PRODUCTION_ENABLED=true`（**随 10-29 的部署一起设成 true**，此时 `stopNewCalls` 仍是开的，新调用照样被拒；环境变量只对新部署生效，冒烟当天只靠临时关 `stopNewCalls`，不再改变量、不再重新部署）；**正式项目不能设任何 `V3_RUNTIME_STAGING_*`**（设了代码拒绝）；正式域名代码里只认 `app.graylum.com` 和 `www.graylum.com` | 项目和库绑定，防止误连 | 总控（需批准） | R1；N1 | 变量名清单读回；`stopNewCalls` 开着时模型调用被拒 | 同上 |
| R6 | 首版正式环境的评审团和研究工具还不可用，由后续两个 PR 在冻结前补上（总控已排）；补不上就按 10-24 缺口清单处理 | 避免对外说有但实际没有 | RUNTIME-PROD 窗口 | R1 | 缺口清单里列明 | 同上 |
| R7 | **正式环境付款入口的代码闸门**：`packages/api/src/services/payments/methodCheckoutGate.ts` 现在把银行卡下单写死成只在 staging 部署上开放（第 25–31 行），微信和支付宝一律关闭（`WALLET_CHECKOUT_READY = false`）；正式环境靠配置打不开。需要一个 PR：为正式部署加上和 R5 同样的"项目、数据库主机"绑定的放行条件，银行卡和钱包分别放行；**默认仍关闭**，真正打开仍要 Owner 批准。

**拆分（总控 2026-10-17）**：#1093 只做入口闸门；B1（#1101，迁移 0296）已在 `methodRouting.ts`、`methodPurchase.ts`、`stripeMethodCheckout.ts` 去掉 Waffo 以外的 live 硬拒，`0222` 的检查由 0296 的 `pay_method_mode_allowed` 取代；退款路径依赖 **B2（#1104，覆盖积分包、月付首单、订阅退款和外部退款回调）+ B3（R7 窗口的 PR-B3，一次性钱包会员订单退款，冻结前合并）**。R7 窗口会逐条核对下面列出的行号，有遗漏在 B3 一起修。

**下面是复审时列出的全部范围**（行号以复审时为准，部分已被 B1 处理），所有"只认测试模式"的检查都要换成审查过的正式绑定：`methodRouting.ts` 第 47 行、`methodPurchase.ts` 第 28 行、`stripeMethodCheckout.ts` 第 53 行、迁移 `0222_pay_stripe_mp_checkout.sql` 第 31–32 行都拒绝 `paymentMode='live'`（正式 Stripe 密钥就是 live）；**退款路径也只认测试**：`packageRefund.ts` 第 40–41、61–66 行、`subscriptionRefundPreview.ts` 第 27–28、51–53、81、117–118 行、`monthlyRefundService.ts` 第 40–41、164 行都要求测试模式或 `livemode === false`，不改的话正式订单无法在应用里报价和退款（D9 要真付再退）。钱包会员是一次性 Checkout 付款（没有 Stripe 订阅和发票历史），而上面三个退款服务要求订阅发票历史、`packageRefund` 只收积分包订单，**一次性钱包会员订单的退款路径目前没有**——需要新增并测试（微信、支付宝各自的整笔和部分退款、积分收回；B3），D9 的六个钱包付款/退款用例依赖 B2+B3（由 B3 负责）。钱包年付还要 `annualVerified` 标记（见 D8a）。隔离测试必须覆盖 live 路径的下单、发放、退款，且 staging 行为不变、未绑定的部署仍被拒 | 不做这一项，D7 和 D9 在正式环境都会被拒，上线后一单都收不了 | **R7 窗口**（入口闸门 PR #1093 已合并；live 模式检查和退款路径**不在** #1093，已核实分在 B1 #1101、B2 #1104、B3 #1111，均未合并，见第 7 节 R7） | R5（正式部署识别方式）；PAY-STRIPE-MP 已合并部分。**正式环境变量（#1093）**：银行卡 `PAY_PRODUCTION_CARD_CHECKOUT_ENABLED`、钱包（微信、支付宝）`PAY_PRODUCTION_WALLET_CHECKOUT_ENABLED`，必须恰好等于 `true`，不设就是关；只对新部署生效，所以**随 10-29 部署前设好**；另需 `V3_RUNTIME_PRODUCTION_PROJECT_ID` / `_DATABASE_HOST` 绑定对上、`main` 分支、域名只认 `app.graylum.com` / `www.graylum.com`、不能有任何 `V3_RUNTIME_STAGING_*`；后台 `payment_method_routes` 开关仍是第二道闸，10-30 才用它打开 | **10-25 冻结前合并并在 staging 验证**（正式放行条件在隔离测试里通过、staging 行为不变、未绑定的部署仍然被拒）；冻结后才发现就得改冻结版本重走回归 | `methodCheckoutGate.ts` 第 14–16、25–31 行；上面列出的各文件行号；MIGRATION-PLAN 第五节第 7 项 |

### A. 平台和基础设施

| # | 做什么 | 为什么 | 谁做 | 依赖 | 怎么验证 | 出处 |
| --- | --- | --- | --- | --- | --- | --- |
| A1 | 升级 Vercel Pro | 正式运营要用；Hobby 单次函数 300 秒、定时任务每天一次，不够 A2 用 | Owner 操作（付费） | — | Vercel 账单页显示 Pro；正式项目的函数时长上限读回 | Master Plan 第 1237 行、第 7.6 节第 2491 行 |
| A2 | 改 `apps/web/vercel.json` 定时任务频率：新增 `/api/cron/runtime-recovery`（分钟级）；`account-erasure` 和 `library-cleanup` 每 5 分钟（Master Plan 要求注销兜底至少每小时一次，LIB_DOCS_PLAN 要求两者一起改成每 5 分钟，取更严的 5 分钟）；`social-monitor` 每 10 分钟 | 删除后 24 小时内清完（T_online）；超时回合自动收口退回；资料库清理；作品数据刷新容量 | 执行窗口开 PR | A1；Vercel 正式环境已有 `CRON_SECRET`（N11，`apps/web/src/lib/cron-auth.ts` 没有它就拒绝全部定时请求）；`runtime-recovery` 路由已在 staging，但 `vercel.json` 里还没有这一条 | **24 小时删除承诺的积压演练（上线前门槛）**：在 Pro 频率（每 5 分钟）下做一次资料库清理积压测试，覆盖并发删除、存储删除失败重试、晚到的签名对象和告警阈值，结果记录在 PR 上；只看 HTTP 200 不能证明 24 小时内清完（LIB_DOCS_PLAN 第 147 行）。其余：会写运行记录的任务（`social-monitor`、`tickets/auto-close` 等）看 `scheduled_job_runs` 有成功记录；`runtime-recovery`、`account-erasure` 和 `library-cleanup` 目前不写这张表，看 Vercel 定时任务调用记录和函数日志里的 HTTP 200（不是 401/503） | 第 2335、2375、2491 行；[LIB_DOCS_PLAN](../LIB_DOCS_PLAN.md) 第 144 行；[PUBLISH-MONITOR](PUBLISH-MONITOR.md) 第 338 行；[FUSION-REVIEW](FUSION-REVIEW.md) 第 44 行 |
| A2a | **已核实**：两个项目在同一个团队 Grayscale Luminary LLC（只有 Owner 一个成员），升级 Pro 会同时覆盖两者；Owner 2026-10-18 在总控对话中确认：staging 是 Vercel 免费版，不支持分钟级定时任务，Owner 会在正式上线前升级 Pro，之后再启用 `runtime-recovery` 分钟级定时任务（上线前 Owner 操作项，见 A1） | `vercel.json` 两个项目共用；如果 staging 仍是 Hobby，分钟级定时任务可能让 staging 部署失败 | 总控只读核对 | A1 | 看两个项目所属团队和套餐 | Vercel 只读团队和项目列表（2026-10-18） |
| A3 | 恢复正式站（取消暂停） | 正式 Vercel 项目 `graylum-ai-vercel-v1` 目前是暂停状态（**已核实**：三个正式域名仍返回 503 `DEPLOYMENT_PAUSED`（2026-10-18 实测）；项目更新时间 2026-10-05 14:57 UTC 与暂停日相符；原因是 `main` 的 Next 有严重漏洞，Owner 当日决定“正式站按方案 1 暂停”，出处为总控备忘，仓库里仍没有书面记录） | Owner 操作（MCP 没有这个权限） | 维护态准备完成（第 4 节第 4 步） | 访问正式域名不再是暂停页；新调用仍是关闭状态 | [RUNTIME_PROD_PLAN](../RUNTIME_PROD_PLAN.md) 第 7.3 节第 3、5 步、第 8 节 Vercel 行 |
| A4 | 处理 `main` 的 Next 安全漏洞 | `main` 停在 2026-08 的依赖，必需检查 Dependency Audit 失败；正式站公开可达 | 总控（需批准合并 `main`） | 冻结版本 | staging → `main` 的合并 PR 上 Dependency Audit 和全部必需检查通过，不新增豁免 | 第 2628 行；RUNTIME_PROD_PLAN 第 7.3 节第 1 步 |
| A5 | 正式环境 Upstash Redis（`UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`） | 限流是 fail-closed：没配好，所有新消息都会被拒；删除清单也存在这里 | Owner 操作（新增凭证） | — | Vercel 正式环境变量名存在（不读值）；限流冒烟通过；命令额度够用 | 第 1249–1251 行、第 7.6 节第 2490 行；[RATE_LIMIT_WIRING_PLAN](../RATE_LIMIT_WIRING_PLAN.md) 第 276–282 行；[DATA_ERASURE_BACKUP_RESTORE_REPLAY](../../runbooks/DATA_ERASURE_BACKUP_RESTORE_REPLAY.md) 第 12–14 行 |
| A6 | 限流初始值和一键暂停：消息 10/分钟、200/天，调用 30/分钟、600/天；`stopNewCalls` 先设为开（停止新调用） | 第 30 项已定；上线当天先关住新调用，冒烟后再开 | 总控（需批准） | A5、B1 | 读回 `system_settings.runtime_rate_limits` | 第 1251 行；RUNTIME_PROD_PLAN 第 5.1 节、第 8 节"限流与开关"行 |
| A7 | 核对新正式 Supabase 项目的套餐、每日备份和 PITR 保留期 | 删除清单在 Redis 里保留 35 天；备份保留期超过 30 天时要先把 35 天调大，否则恢复备份会让已删内容复活 | 总控（需批准只读） | B1 | 套餐和备份窗口记录在 PR 交接里 | DATA_ERASURE_BACKUP_RESTORE_REPLAY 第 34–36 行 |
| A8 | 用虚构账号演练一次"恢复备份 → 重放删除 → 开放" | 这套流程还没真实演练过 | 执行窗口 + 总控。**在一个单独的隔离演练项目里做**（用同一套迁移建库、虚构账号、还原备份后重放删除），**不接 Vercel、定时任务、付款回调**；不碰新正式项目，所以不会弄脏它，也不会让正式进程碰到被还原的库（该文档第 49–52 行的要求） | A7（备份窗口以演练项目的套餐为准；**已核实/仍需 Owner**：staging 所在 Supabase 组织是 free 套餐（读回）；按 Supabase 公开套餐说明免费套餐没有每日备份和 PITR，本次未在线复核说明页，因此演练项目需要 Pro，需 Owner 批准付费） | **公开开放（10-31）的前提**：演练通过，记录重放后已删内容不再出现；演练没通过不开放 | DATA_ERASURE_BACKUP_RESTORE_REPLAY 第 3–4 行 |
| A9 | Sentry 正式项目、告警通知渠道；diagnostics 定时任务 | 上线后要能第一时间看到错误和余额告警 | 总控（需批准） | — | 发一次合成告警能收到；告警里没有用户内容 | RUNTIME_PROD_PLAN 第 8 节"监控告警"行；RELEASE_PREP_CHECKLIST 第 53、136 行 |

### B. 正式数据库

| # | 做什么 | 为什么 | 谁做 | 依赖 | 怎么验证 | 出处 |
| --- | --- | --- | --- | --- | --- | --- |
| B0 | 旧正式项目 `fhmshnqjjnnlvplojktv` 不动：不清空、不删除、不迁数据；上线稳定后是否暂停或删除，另请 Owner 决定 | Owner 2026-10-17 选新建项目；正式环境没有真实用户，旧库里没有要迁移的数据 | — | — | 新正式环境的 Vercel 变量里不再出现旧项目的地址和项目编号 | 第 6 节第 2 项；第 9.3 节第 2676 行；第 1156 行 |
| B1 | 正式库从空库建库：平台前置 → `packages/db/baseline` → 全部迁移（同名 bridge 紧挨在迁移前）；用 PostgreSQL 17；**每个文件整段交给服务端执行，不用 `psql -f`**；先确认目标项目允许 0010 建 `pg_cron`、0148 再删掉 | DB-BASELINE 方案 B（Owner 2026-09-29）：结构只由迁移文件决定 | 总控（需批准），建在第 2.0 节的新正式项目里 | 0271–0283 及之后所有迁移已合并；DB-BASELINE：**已核实**基线 `0000_core_prerequisites.sql`、空库建库 CI（#528/#532/#535）、`db:push` 退役（ENGINEERING.md）均已在 staging，剩下只是总控把任务标“完成” | 建完后只读抓指纹，用 `--local-only --staging <快照>` 和 `built-fingerprint`、`expected-differences.json` 比对，没有解释不了的差异 | [STAGING_REPRODUCIBILITY](../../runbooks/STAGING_REPRODUCIBILITY.md) 第 223–255 行；第 9.3 节第 2677 行；第 1185 行 |
| B1a | 确认 Supabase 项目设置 `rls_auto_enable` / `ensure_rls` 事件触发器的取值 | 这两项属于项目设置，不在仓库迁移里，不能从本机重放成功推断 | 总控（需批准只读） | B1 | 读回项目设置 | STAGING_REPRODUCIBILITY 第 233–235 行 |
| B2 | 导入配置类数据：套餐（Pro $29 / 3,480、Gold $69 / 8,970，年付 $279 / $621，免费套餐每月 0、每年 0）、积分包和会员折扣、q=100、m=6、模型和线路、`runtime_purpose_budgets`、已发布的 Skill 和模块配置；不复制 staging 的测试账号、对话、订单、流水、沙盒编号和测试窗口 | 正式库只要结构和配置；价格写入要另批 | 总控（需批准每一组数值） | B1 | 逐项读回；模型行导入后在后台点"读取价格"，不从 staging 复制价格 | 第 9.3 节第 2677 行；第 289、1450、2720 行；[MODEL_PRICING_SYNC_PLAN](../MODEL_PRICING_SYNC_PLAN.md) 第 394 行；[AGENT_CORE_R15](../implementation/AGENT_CORE_R15.md) 第 24–27 行 |
| B2a | **完整的 Stripe 目录并绑定到新库（步骤见第 2.5 节）**：在 Stripe 正式模式建好**全部**价格——银行卡订阅（Pro/Gold 月付年付、创始年付、Gold 首月优惠券，见 D2）、**微信/支付宝的一次性会员价格**（Pro 月/年、Gold 月/年、创始 Gold 年，再加 Gold 首 30 天 49 美元 `Wallet-Gold-30Day-First`，共六个会员产品、七个价格；首次购买 Gold 的钱包结账用的是单独的 `gold_first30` 映射）、**六个会员档积分包价格**（S/M/L × Pro/Gold）——再把每个价格绑定写进新库 `payment_provider_refs`（live 模式、用途 `price_usage`、周期、方案、档位，每组恰好一条当前映射）。少一条，对应的结账会报 `PAY_WAFFO_PRICE_MAPPING_MISSING` | 新库是空的，目录绑定不会自己出现；缺了钱包 D9 和积分包都无法售卖 | Owner 在 Stripe 建价格（D2）；绑定写入由总控（需批准） | B1、D2 | 读回 `payment_provider_refs`：每个套餐/积分包/方式/周期恰好一条当前 live 映射；逐个对账 | `0222_pay_stripe_mp_checkout.sql` 第 206–212 行；[PAY-WAFFO](PAY-WAFFO.md) 第 4 节（第 106–135 行） |
| B2b | 已发布的付款条款版本：写入 `system_settings.payment_terms_version`，**值是对象** `{"version":"<已发布的版本>"}`（不是单独的字符串；代码读 `value.version`），版本和结账请求里的一致。没有它，所有结账都被拒 | 空库没有这条 | 总控（需批准）；版本号随 Owner 的条款定稿 | B1、D10 | 读回对象形状；会员页读出的 `termsVersion` 不为空 | `methodMembership.ts` 第 69–90 行；`methodPayments.ts` 第 54–56 行 |
| B2c | 新购买渠道：写入 `system_settings.payment_new_purchase_channel`，**值是带版本的对象** `{"channel":"stripe","version":1}`（迁移 0173 的守卫只接受含 `channel` 和单调递增 `version` 的对象，直接写字符串会被拒；也可以走后台提供的保存流程）。没有它默认是 Waffo，会员页和积分包页都不显示可结账 | 空库默认值是 Waffo | 总控（需批准） | B1 | 读回对象形状；套餐和积分包接口报告可结账 | `readPaymentChannel`；`settings.getMembershipPlans` / `getCreditPackages` |
| B2d | 对账起点：写入 `system_settings.launch_baseline_at`。没有它每日对账返回 BLOCKED/MISSING，公开开放前的对账验证过不了 | 空库没有起点 | 总控（需批准）；时间取 B1 建库完成之后、第一笔真钱付款之前 | B1 | 读回；10-30 对账不再是 BLOCKED | `packages/api/src/services/billingReconciliation.ts`（`readLaunchBaselineAt`） |
| B2e | **种子配置全量核对**：以上几条都是"新库少了一条设置就整条流程不通"。建库后由总控只读列出 staging 的全部 `system_settings` 键、套餐、积分包、模型、Skill 发布状态和 `payment_provider_refs` 行，逐项对照新库，每个差异要么补上、要么写明为什么不需要；差异表（键名、staging 有无、新库有无、处理）附在 10-29 的执行记录里 | 防止再有漏掉的设置（B2a–B2d 就是这样被复审查出来的） | 总控（需批准只读 staging 的键名和新库） | B1、B2 | 差异表里没有未处理项 | 本节 B2a–B2d；STAGING_REPRODUCIBILITY"Required Non-Secret Staging Seed Categories"一节 |
| B3 | 只读核对正式库已装 Supabase Vault，且已应用 0259 | 后台第三方密钥存在 Vault；没装时函数直接报错，不会退成明文 | 总控（需批准只读） | B1 | `supabase_vault` 扩展存在；0259 在账本里 | [ADMIN-SECRETS](ADMIN-SECRETS.md) 第 8 节第 1 项；第 2375 行 |
| B4 | ADMIN-SECRETS 的 OR-2 已应用：正式库 `ai_models` 没有 `api_key` 列 | 不再有明文密钥列 | 执行窗口（OR-2 PR，**还没开**）；正式库随 B1 建出来 | #1041（OR-1，0277）合并后 | 只读查列不存在 | ADMIN-SECRETS 第 8 节第 3 项、第 10 节 OR-2 |
| B5 | 只读核对没有"付款方式为空、未关闭、未付款"的旧路径待付款订单 | 有的话会挡住这些账号用新路径下单 | 总控（需批准只读） | B1 | 查询结果为 0（新建库正常就是 0） | 第 2375 行（#961）；[LEGACY_CHECKOUT_CLEANUP](../../runbooks/LEGACY_CHECKOUT_CLEANUP.md) 第 69–74 行 |
| B6 | 核对 Storage：两个资料库桶都是私有，`storage.objects` / `storage.buckets` 上没有策略，匿名和普通登录角色没有新增授权；工单附件上传和签名读取一起回归 | 上传文件不能被别人读到 | 总控（需批准只读） | B1 | SQL 只读核对 + 正式冒烟上传一次 | [LIB_DOCS_PLAN](../LIB_DOCS_PLAN.md) 第 300–303 行；第 2632 行 |

### C. 密钥和第三方供应商

| # | 做什么 | 为什么 | 谁做 | 依赖 | 怎么验证 | 出处 |
| --- | --- | --- | --- | --- | --- | --- |
| C1 | 在正式站后台"第三方密钥"页填 6 个槽位：OpenRouter、Post for Me API 密钥、Post for Me Webhook 共享密钥、TikHub、Parallel、Firecrawl | 业务密钥只放后台，AI 不经手 | Owner 操作 | B3；ADMIN-SECRETS 的 PFM、RT、OR-1 接线都已合并（#1041 在途） | 6 个槽位都显示"后台已填写"（只看状态和末 4 位）；Owner 对照 Post for Me 那边的 Webhook 共享密钥末 4 位一致 | ADMIN-SECRETS 第 8 节第 2 项；第 182、2375 行 |
| C2 | 结束过渡期：Vercel 正式环境里删除 6 个旧环境变量（5 个后备变量和残留的 `OPENROUTER_API_KEY`） | 只留一个来源，避免读错 | Owner 操作 | T-END PR 合并；C1 | 删除后发布、Webhook、三家搜索和模型调用都正常 | ADMIN-SECRETS 第 8 节第 4 项、第 10 节 T-END |
| C3 | Resend：正式发信域名的 DNS（SPF/DKIM）现在做；生成密钥可以现在做，但**填进后台 `resend` 槽位要等 B1 新库（含 0270）和管理员账号 N14 就绪之后**（10-29）；确认发件人 `Graylum AI <no-reply@graylum.com>` | 续费提醒、到期提醒等付款邮件要能发出去 | Owner 操作（新增凭证） | PAY-NOTIFY PR-N1（#1031，已合并） | 后台槽位显示已填写；正式冒烟发一封到测试邮箱 | [PAY-NOTIFY](PAY-NOTIFY.md) 第 47–55 行；第 604 行（N5 上线前确认地址） |
| C3a | 新正式项目的 Auth 设置（逐项见第 2.0 节 N5–N9） | 新项目里这些都是空的，要重新配 | Owner 操作（凭证）/ 总控核对 | N1、E1 | 用新邮箱真实走一次注册、确认邮件、Google 登录、找回密码 | 第 934 行；PRODUCTION_RELEASE 第二节；SMTP 用 Resend 的历史记录见 [v10.1](../Graylum_Master_Plan_v10.1.md) 第 305 行 |
| C4 | OpenRouter 账号和各 workspace 的隐私设置里关闭"允许用于训练" | Owner 2026-10-12 选 A：账号层面关，代码不强制 | Owner 操作；总控上线前核对 | — | Owner 截图或口头确认，记在上线 PR | 第 719、2375 行 |
| C5 | OpenRouter 正式运行凭据：专用一把、每日美元上限、不自动充值、首版禁用 BYOK | 平台没有固定的亏损上限，靠供应商侧硬上限兜底 | Owner 操作（金额由 Owner 定） | C1 | 凭据设置页读回；核对 BYOK 关闭 | RUNTIME_PROD_PLAN 第 5.1 节第 234–239 行、第 8 节 OpenRouter 行 |
| C6 | Owner 向 Parallel 取得"Search API 零保留、不训练"的书面确认 | 第 2.1 节 RESEARCH-TOOLS 9.1 选 A；确认前隐私条款按"可能用于训练"写 | Owner 操作（对外发信） | — | 书面回复存档；隐私条款相应措辞 | 第 497、2375 行 |
| C7 | TikHub、Parallel、Firecrawl 各自在平台上设好硬上限（预付余额或平台限额） | 没设硬上限前不开放对应搜索；后台打开供应商时必须勾选"已设硬上限" | Owner 操作（金额由 Owner 定） | — | 各家后台读回；RT-2b 审计记录里有勾选人和时间 | 第 1127 行；[RESEARCH_TOOLS_PLAN](../implementation/RESEARCH_TOOLS_PLAN.md) 第 371、447 行 |
| C8 | Post for Me：订阅一个**正式环境独占**的项目；打开孤儿清扫删除开关 `publish_monitor_orphan_sweep_delete` 前确认独占 | 默认只记录不删除；共用项目时可能误删 staging 或手动测试的账号 | Owner 操作（订阅，每月至少 10 美元）；开关由总控（需批准） | PUBLISH-MONITOR 各 PR | 正式项目里只有正式环境的账号；开关读回 | 第 2375 行；PUBLISH-MONITOR 第 164–166 行、第 11 节第 7 项 |
| C9 | 订阅前向 Post for Me 官方邮箱书面问两件事：条款是否允许嵌入付费 SaaS；超量自动升级和价格页说法不一致 | 条款没写明 | Owner 当次同意后发送 | — | 回复存档 | PUBLISH-MONITOR 第 452–453 行 |
| C10 | 统计：GA4 正式媒体资源、Termly 网站编号、Vercel Web Analytics 打开；GA4 上报密钥放 `~/.graylum/secrets/`，往 Vercel 加变量当次批准 | 上线时能回答"人从哪里来、多少人付款" | Owner 操作 | ANALYTICS 各 PR | 正式站能看到页面访问；同意弹窗出现 | [ANALYTICS](ANALYTICS.md) 第 8 节 |
| C11 | 删除或重置 E2E 测试账号，正式环境变量里去掉不再需要的 E2E 凭证 | 测试凭证不留在正式环境 | Owner 操作 | — | Vercel 正式环境没有 `E2E_*` 变量 | RELEASE_PREP_CHECKLIST 第 55 行 |
| C12 | Firecrawl 是否开通零保留 | 上线前要定，不阻塞代码 | Owner 决定 | — | 决定记进 Master Plan 第 2.1 节 | RESEARCH_TOOLS_PLAN 第 447 行 |

### D. 收款（Stripe）

| # | 做什么 | 为什么 | 谁做 | 依赖 | 怎么验证 | 出处 |
| --- | --- | --- | --- | --- | --- | --- |
| D1 | 正式模式开通 Stripe Managed Payments，提交资格信息，接受条款 | 银行卡订阅走 MP；平台审核可能要几天，**要尽早开始** | Owner 操作 | — | Stripe 后台显示 MP 已开通 | [MIGRATION-PLAN](../evidence/stripe-managed-payments-20261012/MIGRATION-PLAN.md) 第五节第 1 项 |
| D2 | 正式模式建产品和价格：Pro / Gold 月付和年付、创始年付、Gold 首月优惠券，**以及微信/支付宝的一次性会员价格和六个会员档积分包价格（见 B2a）**；税务编码 `txcd_10105001`，价格不含税 | 价格和 Master Plan 第 51 项一致 | Owner 操作（或批准 AI 按脚本建） | D1 | 价格 ID 和后台套餐一一对应 | MIGRATION-PLAN 第五节第 2 项 |
| D3 | "收入恢复 → 重试"改为第 1、3、6 天重试，失败后取消订阅 | 配合 24 小时宽限和创始会员 7 天规则 | Owner 操作 | D1 | 后台设置读回 | MIGRATION-PLAN 第五节第 3 项 |
| D4 | 正式回调地址订阅回调处理用到的全部事件：`checkout.session.completed`、`checkout.session.expired`、`checkout.session.async_payment_succeeded`、`checkout.session.async_payment_failed`、`invoice.paid`、`invoice.payment_succeeded`、`invoice.payment_failed`、`customer.subscription.created/updated/deleted`、`charge.refunded`、`refund.created`、`refund.updated`、`refund.failed`、`charge.refund.updated`、`charge.dispute.*`（以 `apps/web/src/app/api/stripe/webhook/route.ts` 第 34–55 行为准，少一个就可能付了钱不开通或退款对不上账）；新建回调地址会产生新的回调密钥（新增凭证） | 续费、退款、拒付事件都要收到 | Owner 操作 | **在 E1 的 308 生效之前**把回调主机改成 `www.graylum.com`（路径不变），回调不能依赖跳转 | Stripe 后台订阅的事件和代码里处理的事件逐个对上；直接发到 www 的投递成功、错误签名返回 400；之后才放 E1 的 308，再用带请求体的 POST 实测旧域名跳转后方法和内容不变 | MIGRATION-PLAN 第五节第 4 项；SEO_GEO_SPEC 第 24、222 行；PRODUCTION_RELEASE 第二节 |
| D4a | 冒烟期间（10-30）站点还在 Vercel 部署访问保护后面，第三方回调也会被挡。由 Owner 在 Vercel 生成一个专用的保护绕过口令（新增凭证），只加在 Stripe 和 Post for Me 的回调地址上（`x-vercel-protection-bypass` 参数）；公开开放、撤掉访问保护后，从回调地址上去掉并作废这个口令。Vercel 定时任务在保护下能否照常触发，**仍需实测**（见出处列）| 否则真钱付款成功了，但开通和退款的回调被 Vercel 拒掉 | Owner 操作（凭证） | D4、C8；在打开 D7 之前 | 访问保护开着时，Stripe 后台测试投递和一次真实付款的回调都成功；开放后口令已作废 | Vercel 部署访问保护绕过说明（外部文档）；本仓库只有预览测试用的绕过处理（`scripts/ensure-preview-ready.mjs`、`apps/web/tests/e2e/support/deploymentProtection.ts`）。**已核实**：官方文档确认第三方回调可把 `x-vercel-protection-bypass` 作为查询参数加在回调地址上（Stripe 例）；**仍需 Owner**：定时任务在保护下能否触发，文档没明说，冒烟前用 Vercel 定时任务调用记录实测 |
| D5 | 账单描述、客服邮箱、结账页的条款和隐私链接；开通 Stripe Tax 门槛监控 | MP 不负责税务的国家照常卖，接近门槛时提醒（Owner 2026-10-12 选 A） | Owner 操作 | D1 | Stripe Tax 页显示监控已开 | 第 720、2375 行；MIGRATION-PLAN 第 2.4 节、第五节第 5 项 |
| D6 | 正式环境 Stripe 客户门户关闭"切换套餐" | 升级要走"新开 Gold 结账 + Pro 期末停"，门户里直接换套餐会绕过 | Owner 操作 | — | 门户设置读回 | 第 2375 行 |
| D7 | `STRIPE_CARD_RECONCILIATION_MODE=live` **在 10-29 部署之前就设好**（银行卡下单此时仍关着；环境变量只对新部署生效，不能留到 10-30 才设），放开银行卡处理只认测试模式的限制，**已经确认是代码闸门（R7），不是配置**，必须在冻结前合并；10-30 只用后台开关 `payment_method_routes.card.enabled` / `card_cn.enabled` 打开银行卡下单本身 | 默认关闭；三件事一起开 | 总控（需批准；放开测试模式限制是改配置还是改代码，**待核实**） | D1–D6；PAY-STRIPE-MP 全部 PR；#961 | 每日对账在正式环境跑出成功记录 | 第 2375 行；MIGRATION-PLAN 第五节第 7 项 |
| D8 | 微信、支付宝启售前的税务核实：**Owner 2026-10-17 已完成并同意打开钱包年付**（原话：「钱包税务核实已完成，同意打开钱包年付」，总控转达，Master Plan 第 2.1 节 #1110）；价格口径和结账金额验证仍记在 PAY-STRIPE-MP 验收 PR | 不能因为用户在中国就假设免税 | 已完成（Owner） | — | 结果记录在 PAY-STRIPE-MP 验收 PR | 第 7.6 节"Stripe 钱包启售前核实"行 |
| D8a | 钱包年付的验证标记：写入并读回 `payment_method_routes` 里微信、支付宝各自的 `annualVerified=true`（`methodRouting.ts` 第 53–54 行和 `0222` 第 87–90 行：没有这个标记，钱包年付订单一律被拒） | D9 要真付 279 / 496 / 621 美元的钱包年付 | 总控（正式库建好后写入，随上线一起批准，不再等税务核实；staging 已把两个标记改为 true，钱包入口 `enabled` 仍为 false） | R7 | 读回两个标记；D9 年付订单能建单 | `methodRouting.ts`；`0222_pay_stripe_mp_checkout.sql` |
| D9 | 上线当天有上限的真实小额支付、退款和同日对账；279 / 496 / 621 美元钱包年付各真付一次再退款 | 第 9.3 节保留的上线条件 | Owner 批准金额、笔数和恢复安排；第一笔真钱由 Owner 或其指定的人付 | D1–D8、D8a；**R7（银行卡、钱包两个代码闸门、live 模式检查和退款路径都已放行）** | `payment_orders`、`credit_transactions`、订阅和积分到账一致，退款后收回 | 第 2683、1863 行；[PAY-WAFFO](PAY-WAFFO.md) 第 297 行 |
| D10 | 服务条款、隐私政策、退款政策、可接受使用政策的正文 | 付款前的勾选框链接这两份文件；`/refund` 没有正文前未登录访问是 404 | Owner 操作（第三方工具生成，不在 AI 范围） | — | 4 个页面未登录都能打开 | 第 93、1631 行；第 7.6 节"隐私条款"行 |
| D11 | 客服邮箱 | v11 第 13.3 节的发布条件之一 | Owner 操作 | — | 页面和 Stripe 上的客服邮箱一致、能收信 | 第 7.6 节第 2494 行 |

### E. 域名和搜索收录

| # | 做什么 | 为什么 | 谁做 | 依赖 | 怎么验证 | 出处 |
| --- | --- | --- | --- | --- | --- | --- |
| E1 | 应用并入 `www.graylum.com`，登录后页面放 `/app`；`graylum.com` 和 `app.graylum.com` **308**（保留请求方法和请求体，切换期间还在发往旧主机的 Stripe 回调 POST 不丢）到 www；**必须先做完 E2，并把 Stripe 和 Post for Me 的回调主机先改成 www（D4、N13）**，再让这两条 308 生效，否则两条反向跳转会无限循环 | Owner 2026-10-12 定为上线前完成 | 代码：执行窗口（**还没开 PR**，冻结窗口最后做）；Vercel 域名、Supabase Site URL 和回调、Stripe 回调、环境变量：Owner 逐项批准 | PUBLIC-SITE；E2；D4、N13（回调主机先改成 www） | 三个域名都落到 www，状态码是 308；登录回跳、Stripe 回跳正确 | 第 748、934 行；[SEO_GEO_SPEC](../SEO_GEO_SPEC.md) 第 19、24、220、225 行 |
| E2 | 如果当时在 Vercel 设过 `www.graylum.com` → `app.graylum.com` 的临时 307，**在 E1 的反向跳转生效之前**先撤回 | 和 E1 方向相反，同时存在会无限循环；不撤回整站也不会被收录 | Owner 操作 | 取得正式环境设置批准 | 实测访问 www 不再跳到 app，之后才放 E1 的 308 | 第 2493、2628 行；SEO_GEO_SPEC 第 224–225 行。**已核实**：设过。Vercel 只读读回（2026-10-18）：`www.graylum.com` 与 `graylum.com` 现在都是 307 → `app.graylum.com`（改于 2026-10-03）。撤回顺序：先把 `www` 改回直接服务（去掉到 app 的重定向），再把 `graylum.com` 改回 308 → www，避免出现 graylum.com → www → app 的链式重定向（Vercel 不允许）；操作仍归 Owner |
| E3 | 正式环境设置 `SITE_INDEXING=public` 后**重新部署**（这个值在构建时读，不重新部署响应头不变） | `/robots.txt` 才会放行搜索爬虫、拒绝训练爬虫；noindex 响应头也随之只留在登录后页面 | 总控（需批准环境变量） | E2、E1；落地页能力核对（H1）通过 | 重新部署完成后核对 `/robots.txt` 内容；首页响应头没有 `X-Robots-Tag: noindex` | RELEASE_PREP_CHECKLIST 第 54 行；`apps/web/next.config.ts` 第 63–66 行；`apps/web/src/lib/landing/landing-flags.ts` 第 12–13 行 |
| E4 | Google Search Console、Bing 提交站点和 sitemap | SEO 第 0 阶段地基 | Owner 操作（对外账号） | E3 | 后台显示已验证 | SEO_GEO_SPEC 第 306 行 |

### F. 正式环境功能开关

这些开关在 staging 和正式环境各自独立；`NEXT_PUBLIC_*` 是构建时读的，改了要重新部署。

| # | 做什么 | 为什么 | 谁做 | 依赖 | 怎么验证 | 出处 |
| --- | --- | --- | --- | --- | --- | --- |
| F1 | 打开资料库 @ 引用：前端 `NEXT_PUBLIC_COMPOSER_REFERENCES=on`；服务端 `library_agent_read_enabled` | Owner 2026-10-17 确认上线前打开 | 总控（需批准） | #1022（0279）合并；staging 浏览器验收通过（验收前保持关闭） | 正式冒烟：@ 一份文档，回答里用到了它 | LIB_DOCS_PLAN 第 374 行。**已核实**：Owner 10-17 原话已由 #1071（2026-10-17 合并）写进 Master Plan 第 145–149 行（第 2.1 节）；`library_agent_read_enabled` 在 #1022 里，#1022 现在包含在迁移合集 #1116 中（暂定 0277），均未合并 |
| F2 | 打开资料库上传：`library_upload_enabled`，以及 `NEXT_PUBLIC_LIBRARY_DOCX_EXTRACTION`、`NEXT_PUBLIC_LIBRARY_PDF_EXTRACTION` | Owner 2026-10-10：上传先默认关闭，等 Agent 能读文档后一起打开 | 总控（需批准） | LIB-2a/LIB-3 验收、注销接线完整、`.docx`/`.pdf` 各自验收；和 F1 一起开 | 上传、删除、注销后文件被清掉 | 第 1043–1046 行；LIB_DOCS_PLAN 第 7 节"对用户打开上传"行 |
| F3 | 打开扫描件识别：`NEXT_PUBLIC_LIBRARY_SCAN_RECOGNITION`、`library_scan_recognition_enabled`（**已核实**：`library_recognition_enabled` 不是开关，是 #1050 迁移里读 `library_scan_recognition_enabled` 的数据库函数，不用另开；#1050 未合并） | Owner 2026-10-17 选浏览器 PaddleOCR | 总控（需批准） | #1048、#1050、#1051；打开前补测真实 Word 文件和中端电脑速度 | 补测记录；正式冒烟识别一页 | 第 106–114 行；LIB_DOCS_PLAN 第 7 节"对用户打开扫描件识别"行 |
| F4 | RESEARCH-TOOLS 后台：总开关和每家供应商开关、已验证平台、调用上限、价格配置 | 对标研究是出报告的前提（不提供跳过） | 总控（需批准） | C1、C7；RT-8 把这些写进上线清单（**RT-8 还没做**） | 后台读回；正式冒烟一次对标 | 第 718 行；RESEARCH_TOOLS_PLAN RT-2b、RT-8 行 |
| F5 | `publish_monitor_enabled` 和 F 档位功能行 | 发布和数据复盘是上线范围 | 总控（需批准） | PUBLISH-MONITOR 验收；C8 | 价格页和付费墙的功能行跟着开关显示 | 第 1606、1611 行 |
| F6 | 模型身份保护开关 `model_identity_guard` 打开，品牌话术由 Owner 确认 | 用户在任何地方看不到真实模型名 | 总控（需批准）；话术 Owner 确认 | MODEL-IDENTITY-GUARD | 正式冒烟问"你是什么模型" | 第 849、2366 行 |
| F7 | 评审团默认权限只给 Gold；评审模型 Sonnet 5.5 / GPT-6.1 Sol / Gemini 3.8 Flash，汇总 Opus 5.5 | 第 51 项和 2026-10-17 决定 | 总控（实际改配置前单独批准） | FUSION-REVIEW | 后台读回 | 第 95–104、2361 行 |
| F8 | 落地页能力开关：`landing-flags.ts` 里每个 `show: true` 的能力，对应任务都已验收；没验收的在一个审查过的 PR 里改成 `show: false`；样例报告真实生成前保持 `false` | 落地页按全部功能已上线来写，上线前逐条核对 | 执行窗口（改开关 PR）；总控核对 | 第 3 节冻结结果 | 逐条对照验收记录 | `landing-flags.ts` 第 5–30 行；第 217、542、559、583、588 行 |
| F9 | 输出上限：正式环境单次上限 32768 | 第 #604 决定 | 总控（需批准） | B2 | 读回配置 | 第 1387–1389 行；[REPORT_GEN_PLAN](../REPORT_GEN_PLAN.md) 第 156 行 |
| F10 | 个人中心的数据使用同意卡片已隐藏 | 2026-10-12 决定开关上线先隐藏 | 执行窗口核对（AGENT-CORE R10） | — | 正式冒烟看不到这张卡片 | 第 732 行 |
| F11 | Skill 正式版：首批创作 Skill 发到正式环境前，Owner 看过样例并单独确认 | 第 2.1 节 2026-10-17 决定 | Owner 确认；总控发布 | CONTENT-CONVERSATION-DRIVEN | 正式后台 Skill 版本读回 | 第 156–168 行 |

### G. 数据保留和合规

| # | 做什么 | 为什么 | 谁做 | 依赖 | 怎么验证 | 出处 |
| --- | --- | --- | --- | --- | --- | --- |
| G1 | 核对 DATA-ERASURE 上线前补齐的四项都已合并并在正式环境生效：日志表定期清理（#867，0226）、Upstash 限流统计清理（#866）、库外删除清单（#869，0227）、Sentry 上报前脱敏（#865、#888） | Owner 2026-10-12 同意上线前补 | 总控核对 | B1、A5 | 各 PR 已合并；正式冒烟后 Sentry 事件里没有正文 | 第 675 行；[DATA_ERASURE_RETENTION_CHECKLISTS](../../runbooks/DATA_ERASURE_RETENTION_CHECKLISTS.md) 第 72–78 行 |
| G2 | 注销时 `user_activity_logs` 改为保留并去掉可识别内容 | 和账务记录同样处理 | 执行窗口（**已核实：已做**——迁移 0226（#867）把注销清理改为保留并去掉内容，加 `content_erased_at`；staging 读回该列存在、16 个函数引用，迁移已应用） | — | 注销测试 | 第 682 行 |
| G3 | MODERATION 正式实现时间：**已定**，上线时继续暂缓，只保留默认放行的检查点，上线后再定 | Owner 2026-10-17 选 A | — | — | 已写进 Master Plan 第 2.1 节 | 第 6 节第 3 项；第 1190、2414、2716 行 |
| G4 | 隐私条款写明：Parallel 训练措辞（C6 确认前）、Post for Me 公开链接短暂留存、统计工具和收集的数据、第三方保留例外 | 产品行为要和条款一致 | Owner 操作（条款文字不在 AI 范围） | C6、C10 | Owner 确认 | 第 497、670 行；PUBLISH-MONITOR 第 11 节第 9 项；ANALYTICS 第 8 节第 6 项 |

### H. 验收和冒烟

| # | 做什么 | 为什么 | 谁做 | 依赖 | 怎么验证 | 出处 |
| --- | --- | --- | --- | --- | --- | --- |
| H1 | 落地页、价格页、付费墙上的每条能力说法逐条对照验收结果；"复盘数据"只在 PUBLISH-MONITOR 验收通过后展示；国内平台数据说法和实际能力一致 | 不对外承诺做不到的功能 | 总控核对；文案改动由执行窗口开 PR | 第 3 节冻结 | 逐条记录 | 第 217、542、559、583、588 行；PUBLISH-MONITOR 第 427 行 |
| H2 | staging 全量回归：v11 第 13 节验收矩阵 + 第 3.5、4、5 节 + DATA-ERASURE；没实测的标 NOT_RUN，不能算通过 | 第 9.3 节验收出口 | 执行窗口（自动化）+ Codex（浏览器，同一测试账号一次一个） | 冻结版本已部署 staging | 回归记录贴在冻结版本的 PR 上 | 第 2673–2674 行 |
| H3 | 正式准入：初始模型和线路（Owner 当前计划：对话和报告用 Claude、Gemini，整理用 GPT-6 Luna，以后台配置为准）、各用途的 typicalUsd | 正式环境不设到期日，换模型或线路才重测 | 总控（需批准）；准入档案见 R4（取代旧的"准入记录"写法） | B2、C5、R4 | 读回 `runtime_payg_production` | 第 1127、1165–1167 行；RUNTIME_PROD_PLAN 第 8 节"正式准入"行 |
| H4 | 有上限的正式小额冒烟：一次成功、一次已确认拒绝、一次重复操作、回执对账 | 第 9.3 节保留条件 | 总控（需批准身份、调用数和美元总预算） | 第 4 节第 5 步 | 官方成本、名义费用、实际扣款、平台承担一致；重复请求没有新派发 | RUNTIME_PROD_PLAN 第 7.3 节第 6–7 步 |
| H6 | PAY-DISPUTE-GUARD 赢了之后的撤回冻结上线前是管理员手动；管理员会操作 | 量小、人工处理 | Owner 知悉 | PAY-DISPUTE-GUARD | 后台有"撤回冻结"入口 | [PAY-DISPUTE-GUARD](PAY-DISPUTE-GUARD.md) 第 102、238 行 |

### 2.5 正式 Stripe 商品目录（Owner 亲自操作；#1113 已合并，脚本 `scripts/stripe-mp-live-catalog.mjs`）

放在正式库建好（B1）之后、开收钱（D7、D9）之前。这一节就是 B2a 的操作步骤；脚本在 Stripe 正式账号里建商品、价格和首月优惠券（建对象不扣任何人的钱），并打印要在正式库执行的绑定 SQL。

| # | 谁 | 做什么 | 怎么验证 |
| --- | --- | --- | --- |
| S1 | **Owner 亲自操作** | 在 Stripe 正式后台创建一把**受限密钥**（`rk_live_…`），只开 Products、Prices、Coupons 读写和 Balance/Account 读；放在本机环境变量里，**不发给任何人，不进仓库、PR、聊天** | 密钥权限页读回 |
| S2 | Owner | `STRIPE_LIVE_SECRET_KEY=… MP_EXPECT_ACCOUNT=acct_… node scripts/stripe-mp-live-catalog.mjs plan`，看清缺什么（只读） | 输出里账号是预期的正式账号，缺失项清楚 |
| S3 | Owner | 同样的变量运行 `apply` 创建缺少的对象（只建缺的，不改已有的），再跑一次 `plan` | 全部显示 exists、没有 MISMATCH |
| S4 | Owner 运行；输出交总控审核；**Owner 批准后总控在正式库执行** | 运行 `sql`（会员价格和首月优惠券）和 `sql-packs`（积分包）打印绑定 SQL，**输出只交总控审核，不提交到仓库** | 在正式库执行后读回 `payment_provider_refs`（B2a） |
| S5 | **Owner 亲自操作** | 用完立刻删除这把受限密钥 | Stripe 后台密钥列表里没有它 |

依赖：B1（正式库已按迁移建好）、B2、R7 的 B1/B2/B3 已合并。脚本只认 live 密钥（`sk_live_` / `rk_live_`），拿到非 live 密钥会直接停下、不发任何请求。

## 3. 倒排时间表（今天 2026-10-17 → 上线 2026-10-31）

日期是目标，不是授权；每个"需批准"的点到时仍要 Owner 当次同意。

### 3.0 优先级两档（Owner 2026-10-19 决定，原话见 Master Plan 第 2.1 节）

**P0 核心路径，必须 10-31 上线：**

- 注册。
- 定位三步加报告：第 2 步对标（#1156）加 Skill v16 发布和验收；报告收费 REPORT-GEN 验收；REPORT-VISUAL 验收。
- 自由对话加资料库：#1149 补审修复；#1157 分步状态。
- 会员付费：Stripe MP 卡订阅、创始会员、拒付（#1152、#1155）、续费提醒（#1153）、退款。
- 正式环境搭建：Vercel Pro 加 runtime-recovery 分钟级定时任务的 A2 小 PR；正式 Supabase；RUNTIME-PROD 的 R2–R5 配置；6 个密钥槽；Stripe live 目录；Resend 和 DNS；域名。
- 注销 24 小时清理定时任务。
- 落地页、/pricing、条款页。

**P1 仍按月底排，但给 P0 让路：** 多模型对比（#1136、#1148）、评审团、发布监控/复盘（#1144）的开关打开、对话驱动创作。P1 不自动降级：冻结时没验收的功能，沿用 Owner 2026-10-17 已定规则（第 6 节第 1 项），哪些关开关由 10-24 缺口清单经 Owner 逐项批复；关入口时落地页和价格页对应文案的修改也须经 Owner 批准（见 [缺口清单底稿](REL-1-GAPS-2026-10-24.md) 第 2 节前提）。

**执行规则：** 迁移号仍按"谁先准备好谁拿号"，但 P0 的 PR 审查和合并优先；P1 的 PR 不能挡 P0。

**10-21 检查点：** 这一天要同时满足三件事：① 定位第 2 步走通并出报告；② 付款测试模式全流程通过；③ 正式环境开始搭建。

下面按日期的原表仍有效；表里属于 P0 的项优先，属于 P1 的项让路。

| 日期 | 要完成的事 | 谁 |
| --- | --- | --- |
| **10-17（今天）起立刻开始** | 外部有等待时间的事：D1 Stripe MP 开通、D2–D6 Stripe 后台设置、A1 Vercel Pro、A5 正式 Upstash、C3 Resend 域名、C6 Parallel 书面确认、C8/C9 Post for Me 订阅和询问、C10 统计账号、D10 条款正文、D11 客服邮箱；**N1 新建正式 Supabase 项目**（越早越好，N2–N15 的配置都依赖它） | Owner |
| **10-17 → 10-24（最高优先）** | R1 RUNTIME-PROD 正式环境模型调用；R7 正式环境付款入口代码闸门（同样赶在冻结前）：方案对齐 → 实施 → 复审 → 合并 → staging 验证，**10-24 前完成**，赶不上 10-25 冻结就不能上线 | RUNTIME-PROD 执行窗口；总控分配迁移编号 |
| 10-17 → 10-22 | 合并第 1.2 节的迁移队列（Owner 已一次批准；号由总控合并时逐个给，不按旧表号），每个合并后应用 staging、重建指纹；同时推进 1.1 节剩余任务；开 A2（定时任务）和 OR-2、T-END 的 PR | 执行窗口；总控应用迁移 |
| 10-20 → 10-24 | 新正式项目的不依赖冻结版本的设置：N2、N3 核对，N5–N9 Auth 设置，N15 备份；总控整理 staging 的 Auth 设置清单（N9）给 Owner 对照 | Owner 操作；总控（需批准） |
| 10-22 → 10-24 | E1 `/app` 单主机搬迁的代码（冻结窗口最后做；正式环境切换时按 E2 → E1 的顺序：先撤 307、实测，再放 308）；F8 落地页开关 PR；10-24 总控把"冻结时还没验收的功能"缺口清单交 Owner 一次批 | 执行窗口；总控；Owner |
| **10-25 冻结** | staging 冻结一个版本：之后只修上线阻塞问题（登录、对话、付款、回调、监控），不加功能 | 总控 |
| 10-25 → 10-27 | H2 staging 全量回归：自动化全部跑一遍；Codex 浏览器验收按清单一次一个；修复只走阻塞问题 | 执行窗口；Codex |
| 10-27 | 准备批准包（RUNTIME_PROD_PLAN 第 7.3 节第 2 步）：正式项目、版本、迁移、配置值、各家上限金额、冒烟预算 | 总控 |
| 10-28 | 正式只读核验（第 4 节第 3 步）：新项目的 N1–N3、A7、Vault；旧 Vercel 项目的暂停状态和绑定 | 总控（需批准只读） |
| 10-27 → 10-29 | A8 备份恢复和删除重放演练，在单独的隔离演练项目里做（不接 Vercel 和付款回调），通过是 10-31 公开开放的前提 | 执行窗口；总控（需批准） |
| 10-29 | 维护态准备（第 4 节第 4 步）：在新项目里 B1 建库、B2 配置、**B2a 绑定完整的 Stripe 目录（Owner 先按第 2.5 节 S1–S5 在 Stripe 正式账号建好目录并交 SQL 给总控）、B2b 付款条款版本、B2c 新购买渠道、B2d 对账起点、B2e 种子配置全量核对**、**R2 写入正式库标记并读回、R3 计费配置行、R4 准入档案**、A6 停止新调用；`V3_RUNTIME_PRODUCTION_ENABLED=true` 和 `STRIPE_CARD_RECONCILIATION_MODE=live`、`PAY_PRODUCTION_CARD_CHECKOUT_ENABLED=true`、`PAY_PRODUCTION_WALLET_CHECKOUT_ENABLED=true` 都在这次部署前设好（R5、R7、D7；变量只对新部署生效，后台 `payment_method_routes` 开关此时仍关）；N10–N11 把 Vercel 正式变量换成新项目（**必须在合并 `main` 之前**，否则部署出来连的是旧库）；N14 管理员账号；之后 A4 staging → `main` 合并并部署（站点仍暂停），再由 Owner 在新站后台填密钥（C1、C3、N12） | 总控（需批准）；Owner 操作；执行窗口 |
| 10-30 | 恢复站点、公众访问仍由部署访问保护挡住（第 5 步）；**冒烟窗口内**由总控（需批准）把 `stopNewCalls` 临时关掉，让受控身份能产生一次成功调用，冒烟结束后立刻重新打开（`newWorkGate.ts` 开着时对所有人都拒绝新调用，没有按身份放行）；**先配好 D4a 回调绕过并验证投递，再用后台开关打开 `card`、`card_cn`、`wechat_pay`、`alipay` 四条路由并逐个读回（对账变量和两个代码闸门开关已在 10-29 部署里生效）**（只有受控身份能进站），再做 H4 正式小额冒烟和 D9 真钱付款退款；同日对账 | 总控（需批准）；Owner |
| **10-31** | 对账无误后公开开放（第 7 步）：关掉 `stopNewCalls`、撤掉部署访问保护、E3 `SITE_INDEXING=public` 并重新部署、核对 robots 和响应头；上线后观察成本、错误和未结算项 | 总控（需批准）；Owner |

缓冲：10-30 冒烟失败或对账不一致时，保持新调用关闭、站点维持当时状态，修复后重新批准，不硬上。

## 4. 上线当天的操作顺序

按 [RUNTIME_PROD_PLAN](../RUNTIME_PROD_PLAN.md) 第 7.3 节，每一步都是一个停止点：

1. **无正式副作用的准备**：冻结版本的 CI、独立审查、staging 回归全部对应同一个版本；`main` 的依赖审计修复已在这个版本里（A4）。
2. **批准包**：列出正式项目、域名、数据库目标、版本、迁移、配置值、各家硬上限金额、冒烟预算；没读过的正式事实标 NOT_RUN。
3. **正式只读核验（需批准）**：站点暂停状态、Vercel/Supabase 绑定、数据库版本和结构、配置是否存在、供应商限额；不输出密钥。
4. **维护态准备（需批准）**：站点保持暂停、新调用保持关闭；建库（B1）、导入配置（B2）、凭据和限额（C1–C7）、监控（A9）；所有值读回核对。
   合并到 `main` 可能自动触发正式部署，**合并前就要拿到批准**。
5. **恢复访问（需批准）**：确认新调用仍关闭，再取消暂停（A3）。冒烟期间用部署访问保护限制公众访问。
6. **小额正式冒烟（需批准）**：批准里写明"冒烟窗口内临时关闭 `stopNewCalls`、冒烟结束后重新打开"，窗口内靠部署访问保护限制谁能进站；先给 Stripe 和 Post for Me 回调配好访问保护绕过（D4a）并验证投递，再在部署访问保护下打开 D7 银行卡下单，然后做 H4 + D9（银行卡和钱包的四条路由都要先打开并读回）。
7. **对账后公开开放（需批准）**：确认 A8 演练已通过、钱包一次性会员的退款路径（R7）已验证；核对成本、扣款、平台承担、冻结释放、重复请求没有新派发、告警和停止开关可用；再按批准范围开放。
   站点恢复、模型调用开放和真钱付款是三件事，不能合成一次隐含授权。
8. **出问题时**：立即用 `stopNewCalls` 停新调用，保留账务恢复；先查实际状态再决定重试；没解决的账务或安全问题不扩大开放。
   回滚触发条件参考 PRODUCTION_RELEASE 第五节（登录不可用、对话主流程不可用、后台进不去、结账建不了、回调大面积失败、付了钱没到账）。

上线后记录：正式部署地址和编号、Stripe 模式、冒烟结果、真钱付款和退款结果（PRODUCTION_RELEASE 第七节）。

## 5. 需要 Owner 亲自操作或批准的点（一行一句，可以直接复制）

金额、版本号、日期用 `<…>` 标出的，到时由总控填实后再发给 Owner；没填实的句子不能当授权。

**现在就可以开始的 Owner 操作**
- 同意升级 Vercel Pro（正式运营用），费用按 Vercel 当时标价。
- 我来开通正式环境的 Upstash Redis，把 URL 和令牌填进 Vercel 正式环境变量。
- 我来在 Stripe 正式模式开通 Managed Payments、建 Pro/Gold 月付年付、创始年付和首月优惠券，并设好重试规则、回调事件、账单描述和客服邮箱。
- 我来在 Stripe 正式环境开通 Stripe Tax 门槛监控，并在客户门户里关闭"切换套餐"。
- 我来在 OpenRouter 账号和每个 workspace 的隐私设置里关闭"允许用于训练"。
- 同意向 Parallel 发邮件索取"Search API 零保留、不训练"的书面确认。
- 同意向 Post for Me 官方邮箱询问"能否嵌入付费 SaaS"和"超量自动升级"两件事，并为正式环境单独订阅一个独占项目。
- 我来注册 Resend、给 graylum.com 加发信 DNS 记录（现在做）；Resend 密钥等 10-29 新库建好、管理员账号就绪后再填进后台的 Resend 槽位并验证。
- 我来给 TikHub、Parallel、Firecrawl 各自设好硬上限：TikHub `<金额>`、Parallel `<金额>`、Firecrawl `<金额>`。
- 我来准备服务条款、隐私政策、退款政策和可接受使用政策的正文，以及客服邮箱。
- 我来在 Stripe 正式后台创建只开 Products、Prices、Coupons 读写和 Balance/Account 读的受限密钥，放在本机环境变量里，按第 2.5 节运行 `plan`、`apply`、`sql`、`sql-packs`，把 SQL 交给总控审核，用完删除这把密钥。
- 我来新建 Supabase 正式项目（PostgreSQL 17，区域 `<区域>`），数据库密码存进 `~/.graylum/secrets/`。
- 我来在新正式项目里配好 Google 登录（Google Cloud 加新回调地址）、Resend SMTP 和 hCaptcha。
- 我来把新正式项目的 Supabase 地址和密钥填进 Vercel 正式项目，并把 `EXPECTED_SUPABASE_PROJECT_REF` 改成新项目编号。
- 我来在 Vercel 正式环境新建 `CRON_SECRET`（定时任务的口令）。
- 我来在开启域名跳转之前，把 Stripe 和 Post for Me 的回调地址主机改成 `www.graylum.com`。

**上线前要批准的事**
- 同意 REL-1 冻结版本 `<版本>`，从 10-25 起只修上线阻塞问题。
- 同意总控只读核验正式环境：Vercel 项目 `graylum-ai-vercel-v1` 的暂停状态和绑定、新 Supabase 正式项目 `<项目编号>` 的版本、扩展、项目设置和备份设置；不输出密钥。
- 同意总控按 staging 的设置清单，在新正式项目里设置 Site URL 和回跳地址（`https://www.graylum.com`）以及其余 Auth 设置。
- 同意总控在新正式项目 `<项目编号>` 写入付款条款版本 `{"version":"<版本>"}`、新购买渠道 `{"channel":"stripe","version":1}`、对账起点 `<时间>`，把 Stripe 正式目录的全部价格绑定写进 `payment_provider_refs` 并读回，再做一次 staging 对照的种子配置核对。
- 同意总控在新正式项目 `<项目编号>` 按迁移文件从空库建库，写入正式库标记 `runtime_environment="production"` 并读回确认，并导入已核对的配置（套餐、积分包、q=100、m=6、模型和线路、免费套餐每月 0 积分）。
- 同意正式环境打开资料库 @ 引用（`NEXT_PUBLIC_COMPOSER_REFERENCES`、`library_agent_read_enabled`）和资料库上传。
- 同意正式环境的 OpenRouter 每日上限设为 `<金额>` 美元、禁用 BYOK、不自动充值。
- 同意正式环境限流初始值：新消息每分钟 10 次、每天 200 次，模型调用每分钟 30 次、每天 600 次，上线时先停止新调用。
- 同意总控设置 Vercel 正式环境的非密钥变量（`<变量清单>`），并在新正式项目里给 `<管理员邮箱>` 授予管理员角色。
- 同意把 staging `<版本>` 合并到 `main` 并部署正式环境，部署时站点保持暂停、新调用保持关闭。

**上线当天要批准的事**
- 同意恢复正式站 `graylum-ai-vercel-v1` 的访问，新调用仍保持关闭。
- 我来在 Vercel 生成冒烟期间专用的访问保护绕过口令，只加在 Stripe 和 Post for Me 的回调地址上，正式开放后作废。
- 同意总控用后台开关打开 `card`、`card_cn`、`wechat_pay`、`alipay` 四条付款路由（冒烟期间，站点仍在部署访问保护后）并逐个读回。
- 同意总控在正式库建好后写入微信、支付宝的 `annualVerified=true` 并读回（Owner 已确认钱包税务核实完成）。
- 同意冒烟窗口内临时关闭 `stopNewCalls`（站点仍在部署访问保护后），冒烟结束后重新打开。
- 同意在 10-29 部署前设置 `V3_RUNTIME_PRODUCTION_ENABLED=true`、`STRIPE_CARD_RECONCILIATION_MODE=live`、`PAY_PRODUCTION_CARD_CHECKOUT_ENABLED=true` 和 `PAY_PRODUCTION_WALLET_CHECKOUT_ENABLED=true`（此时 `stopNewCalls` 开着、银行卡下单关着）。
- 同意在部署访问保护下用后台开关打开正式银行卡和微信、支付宝下单（代码闸门 R7 已合并并随 10-29 部署生效，公众仍进不来）。
- 同意正式小额冒烟：用 `<测试身份>` 调用 `<模型和次数>`，总预算不超过 `<金额>` 美元。
- 同意上线当天真实付款再退款：银行卡 `<金额和笔数>`，微信和支付宝年付 279 / 496 / 621 美元各一笔，退款后核对到账和收回。
- 同意对账无误后公开开放：关闭"停止新调用"、撤掉部署访问保护，设置 `SITE_INDEXING=public` 并重新部署，核对 robots 和响应头后让搜索引擎收录。
- 我来在正式站后台填好 6 把第三方密钥，并对照 Post for Me Webhook 共享密钥的末 4 位。
- 我来删除 Vercel 正式环境里 6 个过渡期旧变量和不再需要的 E2E 测试凭证。

## 6. Owner 决定（1–3 项 2026-10-17 已定）

| # | 问题 | 选项 | 推荐 | 可复制 |
| --- | --- | --- | --- | --- |
| 1 | 10-31 和上线范围冲突（第 1.3 节） | A：日期不变，10-25 冻结；B：范围不变，日期往后推 | **已定 A** | Owner 原话（2026-10-17，总控-8 对话）：「同意 REL-1 选 A：10-31 按时上线，10-25 冻结，没验收的功能关开关、对外说法隐藏，10-24 由总控把缺口清单给我一次批。」 |
| 2 | 正式库建在哪 | A：新建 Supabase 正式项目；B：清空现有正式项目后重建 | **已定 A** | Owner 原话（同上）：「同意正式库选 A：新建 Supabase 正式项目，从空库按迁移建库。」 |
| 3 | MODERATION 正式实现时间 | A：上线时继续暂缓；B：上线前接 OpenAI Moderation | **已定 A** | Owner 原话（同上）：「同意 MODERATION 上线时继续暂缓，上线后再定。」 |
| 4 | 备份恢复演练在哪做（A8）：staging 没有每日备份和 PITR | A：单独的隔离演练项目，上线前做；B：上线后再演练 | A（演练项目与正式项目隔离） | 同意用一个单独的隔离演练项目演练一次备份恢复和删除重放（不接 Vercel 和付款回调）；如需付费备份，费用 `<金额>`。 |
| 5 | Firecrawl 零保留是否开通（C12） | 由 Owner 看 Firecrawl 套餐后定 | — | — |

1–3 项已写进 Master Plan 第 2.1 节（2026-10-17 条目），同日 Owner 还一次批准了 staging 迁移 0271–0288（总控转达）。

## 7. 待核实汇总（2026-10-18 核实结果）

出处：Vercel 只读接口、staging Supabase 只读查询、`gh`、本仓库 origin/staging（a35b48ea）。没有读写正式数据库，没有改任何平台设置。

| 项 | 结论 |
| --- | --- |
| A2a | 已核实：两项目同团队，升级 Pro 同时覆盖两者；Owner 2026-10-18 确认 staging 是免费版、不支持分钟级定时任务，上线前由 Owner 升级 Pro，之后再启用 `runtime-recovery` 分钟级任务。 |
| A3 | 已核实：正式站仍暂停，三个域名返回 503 DEPLOYMENT_PAUSED（实测）；项目 2026-10-05 14:57 UTC 更新；原因是 `main` 的 Next 严重漏洞（Owner 当日决定，总控备忘）。恢复由 Owner 执行。 |
| B1 | 已核实：DB-BASELINE 实质完成——基线文件、空库建库 CI（#528、#532、#535）、`db:push` 退役、指纹刷新（#539 等七个 PR 全部合并）；plan-progress 仍显示“实施中”，由总控标完成。 |
| A8 | 已核实：staging 的 Supabase 组织是 free 套餐；免费套餐无每日备份/PITR（按公开套餐说明，未在线复核），演练项目需 Pro。仍需 Owner 批准付费演练项目及金额。 |
| N1 | 建议：正式项目区域选 `us-west-2`（staging 同区，目标用户主要在美国），PG 17（staging 为 17.6）；套餐 Pro 以上才有备份。区域和付费由 Owner 定。 |
| R7 | 等 B1/B2/B3 合并后核对（#1101、#1104、#1111 均未合并）。当前 staging 上仍拒绝 live 的行：`methodRouting.ts:47`、`methodPurchase.ts:28`、`stripeMethodCheckout.ts:55`（`scope.mode`）、`0222_pay_stripe_mp_checkout.sql:139`；退款：`packageRefund.ts:61,66`、`subscriptionRefundPreview.ts:81,130,136,141`、`monthlyRefundService.ts:41`。D8a：`annualVerified` 由总控在正式库建好后写入（Owner 10-17 已确认税务核实完成）；staging 已读回两个标记为 true，钱包 `enabled` 仍为 false。 |
| E2 | 已核实：设过。`www` 与 `graylum.com` 现在都是 307 → app（2026-10-03 设置），`app.graylum.com` 直接服务。撤回由 Owner 做，先 `www` 改回直接服务，再把 `graylum.com` 改回 308 → www。 |
| F1 | 已核实：Owner 10-17 原话已由 #1071 写进 Master Plan 第 2.1 节；`library_agent_read_enabled` 在 #1022（现随合集 #1116，暂定 0277），未合并。 |
| F3 | 已核实：`library_recognition_enabled` 是数据库函数不是开关，只需开 `library_scan_recognition_enabled` 与前端环境变量。 |
| G2 | 已核实：已做（0226 / #867），staging 已应用。 |
| N6 | 仍需 Owner：Google Cloud OAuth 客户端设置仓库和数据库都没有，需 Owner 在控制台确认并加回调。 |
| N9 | 总控任务：Auth 设置只在 Supabase 后台，select 读不到；由总控用管理接口只读导出 staging 配置并整理对照清单（不需 Owner 批准），应用到新正式项目时才需 Owner。 |
| D4a | 已核实：回调可用 `x-vercel-protection-bypass` 查询参数（官方文档）。仍需实测：保护下定时任务能否触发，文档没写。口令由 Owner 生成。 |
| 第 1.1 节 24 项 | 部分核实：已按 plan-progress 更新第 1.1 节；DB-BASELINE 实质完成。其余逐项对照验收记录不在本次只读范围，仍由总控冻结前核对。 |
| 0284–0288 | 迁移编号改为“谁先准备好谁拿号”。当前占号或原占号的 PR：0284=#1099（FUSION-COMPARE PR-1）；0285=无 PR；0286=#1076、0287=#1077（已编入合集 #1116，分别暂定 0280、0281）；0288=#1075（PUBLISH-MONITOR PR-4a，未完成）。另有原号：0289=#1069、0290=#1081、0291=#1083（合集内暂定 0282）、0292=#1073、0293=#1086、0294=#1098、0295=#1094，0296–0302 见 R7 与 REPORT-VISUAL 等 PR。staging 已应用到 0275；0276 暂时 #1036 和 #1041 同号待总控定。 |

**仍需 Owner 的项：** A1 上线前升级 Pro（已承诺）、A8 批准付费演练项目、N1 区域与套餐、N6 Google OAuth、D4a 绕过口令与定时任务实测、A3/E2 的 Vercel 操作。

## 交接

- 做完了：本文初稿（只写文档，没有执行任何正式环境操作）。
- 2026-10-17 已按 Owner 三项决定改写：范围按冻结日处理、正式库改为新建项目（第 2.0 节）、MODERATION 暂缓；迁移队列改为 0271–0288。
- 2026-10-18：第 7 节待核实项已逐项核实（只读），结论写回；仍需 Owner 的项列在第 7 节末。
- 下一步：10-24 总控出缺口清单；R7 等 B1/B2/B3 合并后再核对一次行号。
