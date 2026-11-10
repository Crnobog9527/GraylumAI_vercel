# REL-1 建库日顺序清单与准备材料（2026-11-03 更新，11-15 上线）

> **这份文件不授权任何操作。** 第 1 部分是建库日从头到尾的**一张顺序清单**，第 2 部分是 B8"种子配置全量核对"的对照底稿，
> 第 3 部分是上线后第一天的告警值守表，第 4 部分是发现的问题。
> 标 **★ 批准** 的步骤，动手前要 Owner 在当前对话里对**这一步、这些数字**说同意（[AGENTS.md](../../../AGENTS.md) 第 1 节）；
> 标 **★ Owner 做** 的是 Owner 亲手在各家后台操作；可复制的批准句在 [REL-1](REL-1.md) 第 6 节。
> 一次同意只管一步，"同意建库""同意上线"不能代替后面任何一步。正式环境的执行一律由总控做，执行窗口和 Codex 不碰。
>
> **依据**：`origin/staging` 878b09f36（2026-11-05 同步：迁移目录里 0501–0507 都在，staging 的迁移记录也到 0507；0505 是 V2-12 批次 F 已上库，0506 是会员专享 Skill 的 `required_member_level`（#1739），0507 是刷新后保留步骤列表（#1752，2026-11-04 晚上库）；#1762 的导师步骤迁移 2026-11-06 已改名为 `0508_mentor_turn_steps_history.sql`（内容不变；它 11-05 已以占位名上 staging，staging 迁移记录名同步改为 0508，Owner 11-06 批准这次改名）；0495、0498 仍是两个空号，不补）、
> [REL-1](REL-1.md)（2026-11-02 刷新）、[Master Plan](../MASTER_PLAN.md) 第 2.1 节到 2026-11-05。
> 第 2 部分的 staging 取值是 2026-10-26 只读查的底稿；建库日 B8 按当天的 staging 重查。**本文件没有访问正式环境，也没有读写 staging。**
>
> **2026-11-05 更新**（Owner 当日决定见 Master Plan 第 2.1 节，#1758、#1763）：①**不再做功能冻结**，上线日仍是 11-15；下文的“冻结版本”一律读作“**建库日选定的那个版本**”（第 10 步选定，之后合进去的改动按受影响范围重核）；②正式环境止损配置已定：日限 300 美元、p＝8、uFast＝3、uBig＝5、decisionUpperUsd＝0.002（见第 17 步）；③迁移清单更新到 0507（见第 11 步）；④运营教练复盘 Skill 已发到 v4（见第 14、30e1 步）；⑤100 人复测按 11-04 口径算通过（总顺序第 ① 步已记录）。
>
> 2026-11-03 起和旧版不同的地方：上线日 11-15；正式站**不做真钱付款冒烟**（Owner 11-03：staging 付款链路全部测通即可）；
> 备份恢复演练 E2 改为在 staging 原地恢复（Owner 11-03）；运营教练复盘上线时必须打开（Owner 11-02）；
> 复盘每份成本上限 1 美元（Owner 10-27）；主路径重做后多出 `core_path_v2` 等设置和 `TURN_DATABASE_HOST` 变量。

## 1. 建库日顺序清单

按编号顺序做，**每一步读回确认后再做下一步**；读回不一致就停下报告，不往下做。"详见"指 [REL-1](REL-1.md) 的编号。

### 1.1 建库日之前（不依赖选定版本，越早越好）

| # | 谁 | 做什么 | 怎么确认 | 详见 |
| --- | --- | --- | --- | --- |
| 1 | ★ Owner 做 | **Supabase 正式项目 Auth**：SMTP 接 Resend（发件 `Graylum <mail@graylum.com>`，Owner 2026-11-07 定）；Google OAuth 客户端加新项目回调；hCaptcha 密钥；Site URL＝`https://www.graylum.com`，Redirect URLs 允许 `https://www.graylum.com/**`；邮箱确认开；邮件模板和密码强度照总控给的 staging 对照清单；**手机号登录（PHONE-OTP）**：打开 Phone，SMS OTP 有效期 300 秒、6 位，**不配测试号码**，Send SMS Hook 指向 `https://www.graylum.com/api/auth/sms-hook` 并生成正式专用密钥（填进第 24 步的 `SEND_SMS_HOOK_SECRET`），短信总上限调到每小时约 100 条（步骤见 PHONE-OTP 的 PR） | 冒烟 K1 真实走一遍 | P1 |
| 2 | ★ Owner 做 | **Stripe 正式 webhook**：端点 `https://www.graylum.com/api/stripe/webhook`，事件选"所有事件"；重试第 1、3、5 天后取消（Stripe 后台没有第 6 天选项，2026-11-07 实际设为第 1、3、5 天）；账单描述、条款链接；Stripe Tax 门槛监控；门户关"切换套餐"；开通 WeChat Pay、Alipay | 端点详情读回 | P2 |
| 3 | ★ Owner 做 | **Stripe 正式商品目录**：受限密钥 → `scripts/stripe-mp-live-catalog.mjs plan` → `apply` → 再 `plan` 全部 exists → `sql`、`sql-packs` 输出**只交总控审核、不进仓库** → 删受限密钥 | 第二次 `plan` 没有 MISMATCH | 3.6 S1–S5 |
| 4 | ★ Owner 做 | **Post for Me 正式项目**：正式**独占**项目（不和 staging 共用）；Webhook 指向 `https://www.graylum.com/api/postforme/webhook`（账号变化、发布结果事件）；在项目里 **Enable 全部 9 个平台**（10-13 实测时 Facebook、Pinterest 没开，没开的平台拿不到授权链接）；记下套餐条数和续期时间（第 15 步要填） | 项目里只有正式账号；9 个平台都是 Enabled | P3 |
| 5 | ★ Owner 做 | **花费上限**：OpenRouter 正式密钥每日美元上限、不自动充值；BYOK 按 Owner 11-07 新要求启用，计费和上限口径照 BILL-BYOK（#1815）；TikHub、Parallel、Firecrawl 各自硬上限 | 各家后台读回 | P4 |
| 6 | ★ Owner 做 | 拿到正式 hCaptcha sitekey（Termly 网站编号不再需要：ANALYTICS-CONSENT 起不加载 Termly 同意脚本）；生成正式专用的 `OPENING_GRANT_HMAC_KEYS`、`CRON_SECRET`（不复用 staging） | 第 24、25 步变量名清单里有 | P5 |
| 7 | ★ Owner 做 | Vercel 正式项目打开 Web Analytics 和 Speed Insights（问题 15，第一次正式部署之前，否则统计脚本 404）；日志和备份保留期 ≤30 天：正式 Sentry、Vercel、Resend、`Graylum_main` 每日备份和 PITR | 各后台读回 | P6 |
| 8 | ★ 批准 | **正式库连接池数字**（E4）：Owner 定 PostgREST 连接池大小。它决定第 17 步的 `poolSize`／`p` 和日限，**必须先于设置每日花费上限和 `core_path_v2`**。建库日 Owner 操作（需 Owner 生成的 Supabase 管理令牌，放本机密钥文件，不进仓库、日志或 PR） | 读回 | E4、3.0a |
| 8a | ★ Owner 做 | **Waffo 后台打开拒付邮件通知** `notifyChargeback`（没打开时拒付只靠我们这边的对账发现）。建库日 Owner 亲手操作，做完告诉总控 | Owner 回复"Waffo 后台的拒付邮件通知已打开" | E5 |
| 9 | ★ 批准 → 总控 | 正式只读核验（P9）：Vercel 项目仍暂停、Pro、sfo1；`Graylum_main` 是 Pro、PostgreSQL 17、有 `supabase_vault`；三地区一致（Supabase us-west-1、Vercel sfo1、Upstash us-west-1）；Vercel 正式变量**只读名字** | 每项 PASS／NOT_RUN 写进批准包 | P9、Q4 |
| 10 | ★ 批准 | **选定版本和批准包**（Q3；2026-11-05 起不做功能冻结，这里的版本指建库日选定的那个提交）：该版本的 CI、独立审查、核心 12 项验收、100 人复测都对应同一个版本 | 总控记 Owner 原话 | Q1–Q3 |

### 1.2 建库（只写数据库，站点保持暂停；需要后台的操作在第 1.4 节 30a–30f，后台要等站点部署之后才有）

| # | 谁 | 做什么 | 怎么确认 | 详见 |
| --- | --- | --- | --- | --- |
| 11 | ★ 批准 → 总控 | **从迁移文件建库**：平台前置 → `packages/db/baseline`（0000）→ 全部迁移到冻结版本的最后一个号（含 V2-12 批次 F（0505 已于 2026-11-04 晚上 staging；原写的 0495 作废，0495、0498 两个空号不补）；2026-11-05 目录里最后一个有号的是 0507：0497–0504 是作品复盘、复盘结算标签、对话截图诊断存储和拒绝不再被 PostgREST 重跑的改动，0506 是会员专享 Skill 的等级列（#1739），0507 是刷新后保留步骤列表（#1752），**都不需要额外配置**；#1762 的导师步骤迁移已改名为 `0508_mentor_turn_steps_history.sql`（2026-11-06），之后的新迁移从 0509 起，回放时按目录里实际有的文件逐个来，并重核号码是否连续、没有 9999 之类的占位名漏进正式库；每个文件整段交服务端执行，不用 `psql -f`。**走逐个迁移回放**：Master Plan 第 2.1 节 2026-10-25 BASELINE-SQUASH 只规定"起点建库、逐个迁移建库、staging 指纹三方逐对象一致才用干净起点，不一致就退回旧方式"，所以直接按顺序回放全部迁移就满足那条决定，不需要先做干净起点；若冻结前干净起点已做好且三方一致，才可改用 | 只读抓指纹，和 `built-fingerprint`、`expected-differences.json` 比对，没有解释不了的差异 | B1 |
| 12 | ★ 批准 → 总控 | **正式库标记**：`runtime_environment="production"`（绝不在 staging 写） | `runtime_production_database()` 为 true；测试窗口为 0 | B2 |
| 13 | ★ 批准 → 总控 | **模型导入**：Sonnet 5.5、Gemini 3.8 Flash、GPT-6.1 Sol、Opus 5.5、Gemini 4 Argon、GPT-6 Luna 共 6 个（Qwen 不导入，见第 4 部分问题 8）；用 SQL 写 `ai_models` 行（不含密钥，staging 种子也是这样导入的；若实际只能经后台导入，则第 13–15 步整体挪到第 30b 步之后）；价格不从 staging 抄、连接测试记录也不抄（"读取价格"要用后台，挪到第 30c 步）；Sol、Opus 加低思考档；输出上限 32768 | 后台模型页读回；记下 6 个正式 uuid | B3、B7 |
| 14 | ★ 批准 → 总控 | **Skill 导入**：从私密仓库 `graylum-skills` 导入定位、写作、评审团评审（内部）、运营教练复盘的 Skill 和模块，**全部保持未发布**；评审团内部 Skill 记下 uuid（第 15 步要填）。运营教练复盘包（Skill 名 `review-coach`）要导入**冻结时的最新版本**（2026-11-05 已发到 **v4**，staging 上这一版的发布版本号（revision）是 `167035dd-f1f3-4327-a904-5f1574d19b43`，包哈希以 `ec8b8762` 开头（完整值以总控记录和后台读回为准）；**仓库里的 `file-hashes.json` 目前还是 v3 的内容（2026-11-05 查，`SKILL.md` 哈希 687d623f…），v4 的逐文件哈希还没进仓库——建库日前要先补上，否则“逐文件哈希必须等于该清单”这条核对没有依据**；v3 比早先多了 `SKILL.md` 里请用户发截图的几行，v4 的差异以私密仓库为准；清单内容：`SKILL.md` 正文就是教练方法、`workflow.yaml`、`handbook/douyin.yaml`、`handbook/tiktok.yaml`；原文只在私密仓库，公开仓库只有 `docs/skill-candidates/review-coach-handbook/file-hashes.json` 的哈希清单），导入后逐文件哈希必须等于该清单；这一步只导入，发布和写环境变量在第 30e、30e1 步 | 后台 Skill 版本读回，状态都是未发布 | B3 |
| 15 | ★ 批准 → 总控 | **非密钥配置种子**：复制 [production_non_secret_baseline.sql](../../../packages/db/seeds/production_non_secret_baseline.sql) 到本机私密副本（不进仓库），填 7 个占位：冻结版本的 `runtime_purpose_budgets` 和 `billing_payg_start_thresholds`、`fusion_settings` 里的正式模型和 Skill uuid 与评审预算、`primary_model_id`、`v3_summary_model_id`、`publish_monitor_review_model_id`、第 4 步 Post for Me 的条数和续期时间；整个文件作为一条 SQL 交服务端执行。还有一个占位没填、标记不对、模型 uuid 不对、价格和已有付款映射冲突，都会整段失败、一行不写。写入 21 个设置（含 9 个发布平台、运营教练复盘开、复盘上限 1 美元）、3 档套餐、3 个积分包；可以重复执行 | 第 2 部分逐项读回 | B3、B7 |
| 16 | — | （已挪到第 30e 步：发布 Skill 要用后台，站点要先部署） | — | B3a |
| 17 | ★ 批准 → 总控 | **主路径设置**（B12，种子里故意不写）：按"第 8 步连接池 → `core_path_v2.stopLoss` 的 `poolSize`＝`p` → 日限 `limitUsd`"的顺序写 `core_path_v2`（含 `uFastUsd`、`uBigUsd`、`decisionUpperUsd`），再写准入档案：`runtime_payg`（主路径回合报价读它）**和** `runtime_payg_production`（今天的准入配置仍读它，staging 对应的是 `runtime_payg_staging`；V2-12 #1645 合并后旧键才不再有人读，到时按当天代码重核）两份（6 个模型、9 个用途，评审第三位 Gemini 4 Argon；**两份里对话模型 Claude Sonnet 5.5 的档案都必须带 `"imageInput": {"maxDataUrlBytes": 819223, "maxEdge": 2048}`**，否则自由对话附图（#1702）在正式站会提示"当前模型不支持看图"），`runtime_rw_v2` 写 `{"catalogCache":true}`。**冻结版本按 V2-12 批次 F 已上库的形状准备**（总控 2026-11-04 晚定，只备这一种）：F 会删 `core_path_v2.enabled`、`runtime_rw_v2` 和 `runtime_payg_production`，建库日以冻结当天 staging 的读回值和代码为准，不再写旧键。**正式环境取值（Owner 2026-11-05 已定，Master Plan 第 2.1 节，#1763；写入时仍要 Owner 当次批准）**：`stopLoss.limitUsd`＝300、`stopLoss.p`＝8、`stopLoss.poolSize`＝8（PostgREST 连接池也设 8，先于这一步设好）、`stopLoss.uFastUsd`＝3、`stopLoss.uBigUsd`＝5、`decisionUpperUsd`＝0.002；预留带 B＝(8−1)×3+5＝26 美元，300 ≥ 10×26＝260 满足要求；`limitUsd` 在 `stopLoss` 对象里，写到顶层会让整份配置解析失败；**这些值不在非密钥种子里**（种子故意不写 `core_path_v2`，见第 15 步），只在这一步写。**不写 `core_path_v2` 时所有对话回合都被拒（`TURN_CORE_DISABLED`）** | `poolSize`＝`p` ≥ 实际连接池；日限 ≥ 10×B（B＝(p−1)×uFastUsd＋uBigUsd） | B4、B12、3.0a |
| 18 | ★ 批准 → 总控 | **付款配置**：`payment_terms_version`＝`{"version":"<已发布版本>"}`；第 3 步审核过的 Stripe 绑定 SQL 写进 `payment_provider_refs`（每个套餐／积分包／方式／周期恰好一条当前 live 映射）；`launch_baseline_at`；钱包 `annualVerified=true`；**四条付款路由保持关** | 逐个读回；会员页 `termsVersion` 不为空 | B5 |
| 19 | ★ 批准 → 总控 | **限流**：`runtime_rate_limits` 初始值，`stopNewCalls`＝开（10-24 的数字在主路径重做后是否适用，按当天 staging 读回对照） | 读回 | B6 |
| 20 | ★ 批准 → 总控 | **种子之外的功能配置（只写库的部分）**：写作 Skill 的 `modules.uses_user_voice`；`model_identity_guard` 不写（缺省开）。`research_tools_config` 的 `hardCapAttested` 要正式管理员在后台勾，挪到第 30d 步；`publish_monitor_publish_listed` 在一键发布验收通过后才开；`publish_monitor_orphan_sweep_delete` 在第 4 步独占项目确认后才开 | B8 差异表 | B7 |
| 21 | — | （全量核对 B8／B9 已挪到第 30f 步：要等后台配置做完再核对） | — | B8、B9 |
| 22 | — | （管理员注册已挪到第 30a 步：新库的管理员要站点部署之后才能注册） | — | B10 |
| 23 | — | （密钥槽、客服邮箱、止损金额已挪到第 30b 步：都是后台操作，要站点部署之后） | — | B11、P4 |

### 1.3 部署前：Vercel 正式变量（只对之后的新部署生效）

| # | 谁 | 做什么 | 怎么确认 | 详见 |
| --- | --- | --- | --- | --- |
| 24 | ★ Owner 做 | **密钥类变量**（只列名字）：`NEXT_PUBLIC_SUPABASE_URL`、`NEXT_PUBLIC_SUPABASE_ANON_KEY`、`SUPABASE_SERVICE_ROLE_KEY`、`DATABASE_URL`；`STRIPE_SECRET_KEY`、`STRIPE_WEBHOOK_SECRET`（第 2 步新端点的）、`NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`；`OPENING_GRANT_HMAC_KEYS`、`CRON_SECRET`；手机号登录（PHONE-OTP）的 `SEND_SMS_HOOK_SECRET`（第 1 步正式 Hook 的密钥）和阿里云 RAM 子账号的 `ALIYUN_SMS_ACCESS_KEY_ID`、`ALIYUN_SMS_ACCESS_KEY_SECRET`、`ALIYUN_SMS_SIGN_NAME`、`ALIYUN_SMS_TEMPLATE_CODE`；`UPSTASH_REDIS_REST_URL`、`UPSTASH_REDIS_REST_TOKEN`（正式 Redis）；`SENTRY_AUTH_TOKEN`；Waffo 正式四件（`WAFFO_MERCHANT_ID` 等，S-8 审核通过后才有）；飞书告警两件 `FEISHU_ALERT_WEBHOOK_URL`、`FEISHU_ALERT_SECRET`（ALERT-FEISHU，地址里带机器人令牌，也算密钥；**Owner 2026-11-07 已在正式 Vercel 项目 `graylum-ai-vercel-v1` 填好，只勾 Production**，建库日不用再填，只在变量名清单里核对两个名字都在；值在下一次正式部署时生效） | 变量名清单读回（不读值） | V1 |
| 25 | ★ 批准 → 总控 | **非密钥变量**：`NEXT_PUBLIC_APP_URL`、`NEXT_PUBLIC_AUTH_APP_URL`＝`https://www.graylum.com`；`APP_ENV`、`NEXT_PUBLIC_APP_ENV`；**`TURN_DATABASE_HOST`＝正式 Supabase 的主机名**（主路径新增：**缺了会让 `/api/turn` 全部 503**（`TURN_DATABASE_MISMATCH`），冒烟第 31 步第一项先查它）；`V3_RUNTIME_PRODUCTION_PROJECT_ID`、`V3_RUNTIME_PRODUCTION_DATABASE_HOST`、`V3_RUNTIME_PRODUCTION_ENABLED=true`（今天代码仍读，V2-12 后重核）；`STRIPE_CARD_RECONCILIATION_MODE=live`；`PAY_PRODUCTION_CARD_CHECKOUT_ENABLED=true`、`PAY_PRODUCTION_WALLET_CHECKOUT_ENABLED=true`；`NEXT_PUBLIC_HCAPTCHA_SITEKEY`；`SMS_PROVIDER=aliyun`（PHONE-OTP；正式站设 `fake` 会被拒绝，手机号登录不可用）；`NEXT_PUBLIC_SENTRY_DSN`（缺了所有告警静默）、`SENTRY_ENVIRONMENT`、`SENTRY_ORG`、`SENTRY_PROJECT`；`PAYMENT_NOTICE_FROM=Graylum <mail@graylum.com>`（Owner 2026-11-07 定）；`NEXT_PUBLIC_COMPOSER_REFERENCES=on`；资料库 `NEXT_PUBLIC_LIBRARY_DOCX_EXTRACTION`、`NEXT_PUBLIC_LIBRARY_PDF_EXTRACTION`、`NEXT_PUBLIC_LIBRARY_SCAN_RECOGNITION`（照 staging）；`LANDING_PROMO_OFFERS=on`（落地页显示 Gold 首月 $49 和创始价；**先做第 25a 步**，见第 4 部分问题 20）。**`PUBLISH_MONITOR_HANDBOOK_PACKAGE` 这时不设**（它要写运营教练复盘包发布后的 Skill、版本和包哈希，见第 30e1 步）；**`SITE_INDEXING` 这时不设**；**`NEXT_PUBLIC_TERMLY_WEBSITE_UUID` 不设**（ANALYTICS-CONSENT 起代码不读它，同意条按 Vercel 标出的访客国家自己判断，不需要任何变量） | 变量名清单和本行对照 | V2 |
| 25a | ★ 批准 → 总控（staging 验收先行） | 打开 `LANDING_PROMO_OFFERS` 之前，先在 staging 把落地页开、关两种状态各验一遍（#987 的 A/B 验收：关时只显示标准价；开时显示首月和创始价，名额为 0 或读取失败时创始块整块隐藏，JSON-LD 不含创始价）；通过后才在正式变量里设 `on`，属于正式环境设置，Owner 当次批准 | #987 上 A/B 两份验收记录 | — |
| 26 | 总控只读 | **不能设**：任何 `V3_RUNTIME_STAGING_*`、`WAFFO_TEST_*`、`E2E_*`、`LOADTEST_*`、`LANDING_PREVIEW_FEATURES`、`ANTHROPIC_API_KEY`、`OPENROUTER_API_KEY`、`PAYMENT_NOTICE_TEST_RECIPIENTS`；`EXPECTED_APP_HOST` 也不加（只有本机检查脚本读） | 名字清单里没有 | V3 |
| 27 | 总控只读 | **定时任务**（`apps/web/vercel.json`，Vercel Pro，全部要 `CRON_SECRET`，没有就 503）：每分钟 `runtime-recovery`；每 5 分钟 `account-erasure`、`library-cleanup`；每 10 分钟 `fusion-recovery`、`social-monitor`；每天 02:00 `tickets/auto-close`、03:00 `release-subscription-credits`、03:30 `ticket-attachments-cleanup`、04:00 `billing-reconcile`、10:00 `diagnostics`（UTC） | 第一次部署后 Vercel Cron 页列出 10 个；冒烟日看到调用记录不是 503 | A2 |
| 28 | ★ 批准 → 总控 | **合并到 `main`**（合并即正式部署）：建库日选定的版本从 staging 合并到 `main`；`main` 上 Dependency Audit 通过、不新增豁免；部署时站点保持暂停、`stopNewCalls` 开 | CI 全绿；部署连的是新库 | M1 |

### 1.4 冒烟日（部署访问保护开着，只有受控身份能进）

| # | 谁 | 做什么 | 怎么确认 | 详见 |
| --- | --- | --- | --- | --- |
| 29 | ★ Owner 做（站点恢复，单独一次批准） | Vercel 取消暂停，部署访问保护保持开 | 未登录公众被挡住 | S-1 |
| 30 | ★ Owner 做 | 域名：先撤 www→app 的 307，再把 `graylum.com` 改回 308→www；生成冒烟专用的回调绕过口令，只加在 Stripe 和 Post for Me 回调上；验证通过后放 `app.graylum.com`→www 的 308 | 没有链式跳转；Stripe 测试事件成功、错误签名 400 | S-2–S-4 |
| 30a | ★ Owner 注册 → ★ 批准 → 总控 | **管理员**：站点已部署并恢复（第 28、29 步），在受保护访问下 Owner 在新库注册自己的管理员账号，总控授予管理员角色 | 管理员能进后台、普通账号被拒 | B10 |
| 30b | ★ Owner 做 | **后台密钥槽**：`openrouter`、`postforme`、`postforme_webhook`（至少 16 位，末 4 位和 Post for Me 一致）、`tikhub`、`parallel`、`firecrawl`、`resend`；`support_email` 填**可以公开**的客服邮箱（会显示在公开页面）；后台"成本止损"页填每用户每日、全站每日、告警线、供应商余额提醒线（空着就一封告警都不发） | 槽位显示"已填写"；止损页读回 | B11、P4 |
| 30c | ★ 批准 → 总控 | **读取价格**：`openrouter` 槽已填后，在后台模型页给第 13 步导入的 6 个模型点"读取价格"；读回价格行；`billing_payg_start_thresholds` 的冻结值与读到的价格核对 | 后台模型页价格读回 | B3 |
| 30d | ★ Owner 做（正式管理员） | `research_tools_config` 三家 `enabled`，`hardCapAttested` 由**正式管理员**在后台重新勾（第 5 步设好各家上限之后）；TikHub 价格手工刷新留到冒烟 K12 | 后台研究工具页读回 | B7 |
| 30e | ★ 批准（Owner 看样例） | **首批创作 Skill 正式发布**：Owner 看过样例后对具体 Skill 和版本单独确认，才在正式库发布；运营教练复盘 Skill（`review-coach`，冻结时清单里的最新版本）同样要 Owner 定稿：它的 `SKILL.md` 正文就是教练方法，对话加载和每周复盘读同一份，所以不发布或发布错了，教练复盘都不能用。确认前保持未发布；它只会列给有作品窗口的会员（Pro/Gold），免费账号看不到 | Owner 原话；后台版本读回 | B3a |
| 30e1 | ★ 批准 → 总控 + ★ Owner 做 | **运营教练复盘包接线**（30e 发布之后）：读回正式库里 `review-coach` 已发布版本（应是 v4 内容，对照第 14 步）的 Skill uuid、版本 uuid 和包哈希（`packageHash` 是正式库发布记录里的包哈希，要从后台／发布记录读，它不等于 `file-hashes.json` 里任何一个文件哈希，也不要求相等；内容核对是第 14 步导入时逐文件对清单，不是这一步），Owner 在 Vercel 正式环境设 `PUBLISH_MONITOR_HANDBOOK_PACKAGE`＝`{"skillId":"…","revisionId":"…","packageHash":"…"}`（三项都是正式库的值，不是 staging 的；这个 JSON 不算密钥，但不进仓库和 PR），再**重新部署**（环境变量只对新部署生效）。**没设、格式错、或指向没发布／已撤回的版本时，带品牌的每周复盘直接等待（不开账、不扣费、过一会儿再试，日志有固定码 `coach_method_unavailable`）；对话里的复盘不依赖这个变量，只要 Skill 已发布（第 30e 步）就能用**；抖音／TikTok 手册读不到时，那两个平台只按用户自己的数据诊断 | 重新部署之后：日志没有 `coach_method_unavailable`；冒烟 K7 的真实复盘能生成 | 本次新增（`coach/handbooks.ts`、`coach/method.ts`） |
| 30f | 总控（★ 批准只读新库） | **全量核对**（B8）和安全核对（B9）：按第 2 部分逐项和当天 staging 对照，每个差异补上或写明不需要；Vault、两个资料库桶私有、存储表没有策略 | 差异表没有未处理项 | B8、B9 |
| 31 | 总控 | **先查 `TURN_DATABASE_HOST`**：受控身份打开一次对话，`/api/turn` 不是 503 `TURN_DATABASE_MISMATCH`（缺了或和实际库不一致时**全部对话 503**）；再发一条消息，返回"新调用暂停"（不是 5xx） | 没有 `TURN_DATABASE_MISMATCH`；限流连上 Redis | S-5 |
| 32 | ★ 批准（模型调用开放，单独一次批准） | 冒烟窗口内临时关 `stopNewCalls`，结束后立刻重新打开 | 读回 | S-6 |
| 33 | ★ 批准（金额、次数、总预算） → 总控 | **冒烟**：K1 注册／开户 500／找回密码／Google 登录；K2 一次成功、一次拒绝、一次重复、回执对账；K3 定位第 1 步加一次对标；K4 @ 文档、写作 Skill、对话内研究；K5 文风；K6 Gold 评审团和对比各一次；K7 作品复盘页、运营教练复盘真实生成一次（第 30e1 步之后）、对话里说“帮我复盘”能读到已保存的复盘包（免费账号读不到）、在对话里用 + 发一张截图能读出数字（一条最多 4 张，图片不落库）、名单外平台被拒；K10 后台手动跑一次成本告警检查；K11 每日对账；K12 TikHub 价格手工刷新一次；K13 首字速度 20 次（不挡上线）。**不做 K8 真钱付款和 K9**（Owner 11-03：staging 付款链路全部测通即可，正式站不测） | 每项记录贴上线 PR | 4.1 |
| 34 | ★ 批准（每次） | 一键发布：X、YouTube 各真实发布一次（Owner 在场授权账号） | 帖子在平台上可见，扣费 6 积分／平台 | 核心 10 ③ |
| 35 | ★ 批准 | 打开四条付款路由（`card`、`card_cn`、`wechat_pay`、`alipay`），逐个读回；只开，不在正式站付真钱 | 结账页能建单（不付款） | S-6 |
| 36 | 总控 + ★ Owner | **生产 Sentry 测试告警**：确认第 25 步的 `NEXT_PUBLIC_SENTRY_DSN` 已生效且 `SENTRY_ENVIRONMENT` 能分开正式和 staging；在 Sentry 正式项目对每条通知规则点"发送测试通知"，并手动触发一次"Runtime 成本与余额告警"检查（K10），确认 Owner 的邮箱／手机真的收到一条；**同一次检查会往 Graylum 飞书群发一条测试告警**（ALERT-FEISHU，第 24 步的两个飞书变量），Owner 确认群里收到、链接能打开正式后台。部署访问保护还开着时做。**Sentry 给 Owner 的邮件这时先不关**：正式站飞书群收到这条测试消息、再收到过一两条真实告警之后，由 Owner 自己去关 | Owner 回复收到（邮件和飞书各一条）；结果记在上线 PR | 第 3.2 节 |

### 1.5 公开开放（冒烟和对账无误、核心 12 项 PASS、备份恢复演练已通过之后）

| # | 谁 | 做什么 | 怎么确认 | 详见 |
| --- | --- | --- | --- | --- |
| 37 | 总控 | 开放前核对：核心项"（正式）"部分已过；资料库清理积压演练、备份恢复演练（Owner 11-03：在 staging 原地恢复）有 PASS 记录；正式库没有测试数据（见第 4 部分问题 18：迁移 0005 自带的诊断账户，Owner 11-04 选 A：开放前删掉）；告警值守表有人接 | 记录交 Owner | O-1 |
| 38 | ★ 批准 → 总控 | **`SITE_INDEXING=public` 并重新部署**（构建时读，不重新部署不生效） | `/robots.txt` 放行搜索爬虫、拒绝训练爬虫；首页和公开页响应头没有 `X-Robots-Tag: noindex`，`/app`、登录页仍有；**canonical 检查**：首页和任意一个公开页的 `<link rel="canonical">`、`og:url` 都是 `https://www.graylum.com/...`（代码里写死 `SITE_ORIGIN`），不出现 `app.graylum.com` 或 vercel.app；`/sitemap.xml` 只有 www 地址 | O-2 |
| 39 | ★ Owner 做 | 撤掉部署访问保护；作废回调绕过口令并从回调地址上去掉 | 公众能打开首页；Stripe 回调仍成功 | O-3 |
| 40 | ★ 批准 → 总控 | 关 `stopNewCalls`，其他限流保持初始值 | 一个公开测试身份完成一次对话 | O-4 |
| 41 | ★ Owner 做 | Google Search Console、Bing 提交站点和 sitemap；删 Vercel 正式里的过渡期旧变量 | 后台显示已验证 | O-5、V4 |
| 41a | ★ Owner 做 + 总控 | **E2E 测试账号和凭证清理**（`docs/RELEASE_PREP_CHECKLIST.md`）：在 Vercel 正式环境移除 `E2E_*` 凭证（`E2E_TEST_PASSWORD`、`E2E_ADMIN_PASSWORD` 等，名字清单里不应再出现）；正式库里若有 E2E 测试账号（包括迁移 0005 自带的诊断账户，第 4 部分问题 18），由总控列出后删除（Owner 2026-11-04 选 A：开放前删掉 0005 自带的诊断账户；删除是写正式库，建库日当次仍取得批准） | 变量名清单没有 `E2E_*`；账号清单读回 | V4 |
| 42 | 总控 | 记录正式部署地址、Stripe 模式、冒烟结果；Waffo 正式审核和映射（S-8）可以在上线后 | 贴上线 PR | O-6、S-8 |

**三道刹车**（随时可用，见 REL-1 第 4.2 节）：模型出问题 → 打开 `stopNewCalls`（或 `runtime_payg` 写 `{"enabled":false}`）；付款出问题 → 关对应付款路由；整站出问题 → Owner 在 Vercel 重新暂停或开部署访问保护。

> 旧版第 2 部分"批准包草稿"已删除：可复制的批准句以 [REL-1](REL-1.md) 第 6 节为准，步骤顺序以本文件第 1 部分为准。

## 2. B8 种子配置对照底稿（staging 取值是 2026-10-26 底稿；11-03 按代码补了主路径和复盘的键）

### 2.1 怎么读这张表

- **归属**：这个键在 REL-1 第 3.3 节哪一步（B3 配置类数据、B4 准入档案、B5 付款、B6 限流、B7 功能配置、B11 后台填写），或"REL-1 没提到"。
- **空库建库后**：从文件建库后这个键是不是已经有了——"迁移写入"表示某个迁移在空库里插了缺省值；"缺省走代码"表示表里没有这一行时代码用写死的缺省；"必须写"表示没有它功能不能用。
- **上线值从哪来**：Owner 已定的决定（[Master Plan](../MASTER_PLAN.md) 第 2.1 节）或 REL-1 的条目；staging 测试专用的值写"staging 专用，正式不复制"。
- **结论**：REL-1 没提到的键，逐个写"正式要设 / 不需要 / 待总控定"和理由。

### 2.2 `system_settings`（staging 共 85 个键）

**A. REL-1 已覆盖的键**

| 键 | 类型（staging） | 归属 | 空库建库后 | 上线值从哪来 / 备注 |
| --- | --- | --- | --- | --- |
| `billing_credits_per_usd` | 字符串 | B3 | 必须写 | q=100（Owner 2026-10-01，BILL-UNIT）。staging 也是 100 |
| `billing_token_price_multiplier` | 字符串 | B3 | 必须写 | **m=6**（Owner 2026-10-01）。**staging 是 3（测试专用），正式不复制** |
| `runtime_purpose_budgets` | 字符串（内含 JSON：`report`、`organize`、`interactive`、`version`） | B3 | 必须写 | 按 B3 照 staging 结构写；数值以冻结版本的设计为准 |
| `runtime_payg_staging` | 对象（`enabled`、`profiles` 6 条、`version`、`windowId`） | 对应 B4 | 正式不用 | **staging 专用，正式不复制**；正式写 `runtime_payg_production`（见 2.2 D） |
| `payment_terms_version` | 对象 `{version}` | B5 | 必须写 | 正式写已发布的条款版本；**staging 的值是测试版本号，正式不复制** |
| `payment_method_routes` | 对象（`card`、`card_cn`、`wechat_pay`、`alipay`、`newPurchaseChannel`、`version`） | B5 / S-6 | 缺省走代码（新购买渠道缺省 stripe） | 建库日四条路由**关**，钱包 `annualVerified=true`；冒烟日 S-6 才打开。staging 四条全开，正式不复制 |
| `payment_new_purchase_channel` | 对象 | B5（旧键） | 不需要 | 只剩后台旧面板读取，写不写不影响用户（REL-1 B5 已写明） |
| `launch_baseline_at` | 字符串 | B5 | 必须写 | 建库后、第一笔真钱前写当时时间。staging 的值是 staging 的起点，正式不复制 |
| `runtime_rate_limits` | 对象（`admissionPerMinute`、`admissionPer24Hours`、`callsPerMinute`、`callsPer24Hours`、`stopNewCalls`、`version`） | B6 | 第一次改时由函数补齐缺省 | 正式：消息 10/分钟、200/天，调用 30/分钟、600/天，`stopNewCalls`=开。**staging 调用上限是压测用的 120/3000、`stopNewCalls` 关，正式不复制** |
| `runtime_stop_loss` | 对象（`userDailyUsd`、`siteDailyUsd`、`siteAlertUsd`、`providerBalanceAlertUsd`、`notificationChannel`、`revision`、`version`） | P4（建库后后台填） | 金额为空 | Owner 自己在后台"成本止损"页填金额。**staging 五个金额和通知渠道全是空的**（所以 staging 从没发过止损告警，见第 3 部分） |
| `fusion_settings` | 对象（`compare`、`review`、`version`） | B7 | 必须写 | 对比：允许 Sonnet/Gemini Flash/Sol/Opus、默认三个、`minModels`=2、`answerOutputTokens`=8192、`maxBudgetUsd`=5（用户付费上限，Owner 2026-10-26；staging 已是这个结构，允许 4 个、最少 2 个）。评审团：第三位评审用 **Gemini 4 Argon**（Owner 2026-10-25）。所有模型 uuid 换正式库的 |
| `chat_research_tools_enabled` | 布尔 | B7 | 必须写 | 正式 true（核心 11） |
| `research_tools_config` | 对象（`vendors` 三家、`verifiedPlatforms`、`benchmarkPlatforms`、`limits`、`routes`、`recentGrowth`、`revision` 等） | B7 | 必须写 | 三家 `enabled` 且 `hardCapAttested`（P4 设好硬上限后才勾）。**`hardCapAttested` 里记的是 staging 管理员和时间，正式不复制**，由正式管理员重新勾 |
| `billing_provider_prices` | 字符串 | B7 | 迁移只建写入函数 | 正式：K12 手工刷新一次 TikHub 价格，之后靠每日刷新；不从 staging 复制（价格有 7 天有效期） |
| `billing_payg_start_thresholds` | 对象（`thresholds`、`version`） | B7 | 必须写 | 照 staging 结构；数值以冻结版本设计为准 |
| `library_agent_read_enabled`、`chat_library_retrieval_enabled`、`library_scan_recognition_enabled` | 布尔 | B7 | 必须写 | 正式 true（核心 4） |
| `library_upload_enabled` | 布尔 | B7 | 迁移写入 false | 正式改 true |
| `chat_my_posts_enabled` | 布尔 | B7 | 迁移写入 false | 正式 JSON 布尔 `true`（总控 2026-10-26 定：随作品复盘上线开放，Master Plan 2.1 Owner 10-26 决定）。staging 10-26 已改为 `true` 供验收 |
| `publish_monitor_enabled` | 布尔 | B7 | 缺省关 | 正式 JSON 布尔 `true` |
| `publish_monitor_review_enabled`、`_review_model_id`、`_review_max_usd` | 布尔 / null / 字符串 | B7 | 迁移写入 false / null / "0" | 正式 true、正式库的模型 uuid、`"1"`（每份复盘平台成本上限 1 美元，Owner 2026-10-27，取代 0.30）。`_review_model_id` 为空时跟随 `primary_model_id`；种子要求建库日填正式 uuid。10-26 时 staging 是关着的、上限 0.30 |
| `publish_monitor_coach_enabled` | 布尔 | B7（REL-1 没单列） | 缺省关（0457） | 正式 JSON 布尔 `true`：运营教练复盘走 0457 的新领取路径（Owner 2026-10-27 上线前做完、2026-11-02 复盘必须开）。关着时周复盘走旧提示词。2026-11-04 起它还决定对话里能不能读运营复盘（`coach_review`，只有 Pro/Gold 有作品窗口的账号）；对话里的复盘只需教练复盘 Skill 已发布（第 30e 步）；每周复盘还要接好 `PUBLISH_MONITOR_HANDBOOK_PACKAGE`（第 30e1 步），否则读不到方法 |
| `publish_monitor_publish_platforms` | 数组（staging 10-26 空，11-03 已是 9 个） | B7 | 缺省空 | 正式按 REL-1 第 7 节 E1 的 9 个平台（tiktok、instagram、youtube、facebook、x、threads、linkedin、pinterest、bluesky） |
| `publish_monitor_publish_quota` | 对象（`limit`、`periodAnchor`） | B7 | 没有缺省（不填就不能发布） | 正式按 Post for Me 正式项目的套餐条数和续期时间；**staging 的值对应 staging 项目，正式不复制** |
| `publish_monitor_publish_price` | 对象 `{usdPerTarget}` | REL-1 没写（B7 相关） | 迁移写入 0.01 美元/目标 | 不需要另写：换算跟全站 q、m 走（Owner 2026-10-25，0392） |
| `primary_model_id` | 字符串（uuid） | B7 | 必须写 | 正式库 Sonnet 5.5 的 uuid（staging 指向 Sonnet 5.5），且在 B4 档案里 |
| `v3_summary_model_id` | 字符串（uuid） | B4 提到 | 必须写 | 正式库 GPT-6 Luna 的 uuid（staging 同） |
| `support_email` | 字符串 | B11 | 缺省走代码 | Owner 填。**注意：这个值会显示在公开页面上**（见第 4 部分问题 3） |

**B. REL-1 第 3.3 节没提到、staging 有的键（逐个定性）**

| 键 | 类型 | 代码里谁读 | 空库建库后 | 结论 | 理由 |
| --- | --- | --- | --- | --- | --- |
| `runtime_report_generation` | 对象 `{enabled}` | 报告准入 `report_admission_check`：不等于 `{"enabled":true}` 就拒绝 `REPORT_DISABLED` | **没有**（没有迁移写入） | **正式要设** `{"enabled":true}` | 不设，定位报告（核心 1）在正式站全部被拒。staging 是 true |
| `v3_summary_max_tokens` | 字符串 | 整理器输出上限（128–4096） | 缺省走代码 2048 | **待总控定** | staging 是 4096，缺省 2048；文风生成和整理都用整理器，**总控定（2026-11-04 晚，不算 Owner 决定）：正式写 4096** |
| `site_name` | 字符串 | 登录页、维护页、后台侧栏、公开页 | 缺省走代码 | **不需要**（或写正式站名） | staging 的值带"Staging"字样，**正式不复制**；不写时用代码里的站名 |
| `maintenance_mode` | 字符串 | 入口和上传路由 | 缺省走代码（不维护） | 不需要 | staging 是 false，和缺省一样；需要时才打开 |
| `max_input_characters` | 字符串 | 公开设置（给前端） | 缺省走代码 | 待总控定 | staging 是 10000；**总控定（2026-11-04 晚，不算 Owner 决定）：正式写 10000** |
| `home_show_onboarding`、`home_show_featured_modules`、`home_analysis_module_id` | 字符串 | 首页 | 缺省走代码（显示） | 不需要（`home_analysis_module_id` 待总控定） | 前两项 staging 和缺省一样；`home_analysis_module_id` 指向 staging 的模块 uuid，正式要么不写，要么写正式库定位模块的 uuid |
| `fusion_compare_max_models` | 数字 | 对比上限 | 迁移写入 4 | 不需要 | 和 staging 一样 |
| `report_fixed_price_credits` | 数字 | 报告固定价 | 迁移写入 500 | 不需要 | 和 Owner 决定的 500 积分固定价一致 |
| `runtime_capacity_marker_since` | 字符串 | 卡住回合自动关闭 | 函数第一次调用时写入 | 不需要 | 自动生成 |
| `founder_community_entry` | 对象（`url`、`note`、`updatedAt`、`updatedBy`） | 创始会员社群入口 | 没有 | 总控定：等 Owner 给链接再写 | 内容由 Owner 定（社群链接），staging 的值是测试内容，正式不复制；不写时入口不显示 |
| `checkin_day1`–`checkin_day5`、`checkin_monthly_bonus` | 字符串 | **每日签到**（个人中心有入口，`claim_daily_checkin` 加积分） | 缺省走代码（5/10/15/20/25，月奖 50） | **待总控定（需要 Owner 一句话）** | 不写也会按缺省发签到积分；Master Plan 只把签到列为积分来源之一，没有找到"上线开签到、给多少"的 Owner 决定（见第 4 部分问题 2） |
| `new_user_credits` | 字符串 | 只在后台统计页显示 | 缺省显示 500 | 不需要 | 开户赠送写死 500（不读这个键）；staging 的 100 是旧值，正式不复制 |
| `search_surcharge_credits` | 字符串 | 只在后台统计页显示和校验 | 缺省走代码 | 不需要 | 不影响扣费 |
| `first_purchase_bonus_percent` | 字符串 | 只在后台设置页 | 没有 | 不需要 | 应用里没有首购加赠的扣费/发放路径 |
| `assistant_model_id` | 字符串（uuid） | 只有旧迁移 0074 和测试 | 没有 | 不需要 | 旧键 |
| `v3_workbench_ai` | 布尔 | 只有旧迁移 0068–0085 | 没有 | 不需要（总控建库日抽查一次） | 旧工作台开关；当前代码不读 |
| `chat_billing_hint`、`chat_prompt_text`、`chat_welcome_message`、`chat_show_model_selector`、`enable_free_tier`、`free_tier_messages`、`enable_long_text_warning`、`long_text_warning_threshold`、`enable_prompt_cache`、`enable_smart_routing`、`smart_routing_min_confidence`、`enable_smart_search_decision`、`search_decision_min_confidence`、`input_credits_per_1k`、`output_credits_per_1k`、`web_search_credits`、`show_token_usage_stats`、`max_messages_per_conversation`、`billing_min_pre_deduct`、`billing_max_pre_deduct`、`billing_safety_margin`、`billing_require_model_pricing` | 字符串 | 当前代码都不读（只在 staging 种子文件和早期迁移的权限策略里出现） | 没有 | 不需要 | 旧计费、旧对话的遗留键；LEGACY-CLOSE 已定 |
| `invite_*`（10 个） | 字符串 | 只有数据库邀请函数（0154 自带缺省） | 没有 | 不需要 | 应用里没有邀请入口 |

**C. staging 没有、正式库也不用写的键**（代码里读，表里没有时有安全缺省）

| 键 | 缺省 | 结论 |
| --- | --- | --- |
| `model_identity_guard` | 表里没有 = **开**（0216） | REL-1 B7 写"开"：建库后读回 `model_identity_guard_config()` 为 enabled 即可，不用写 |
| `publish_monitor_orphan_sweep_delete` | 没有 = 只记录不删 | 按 B7：P3 独占项目确认后才打开 |
| `publish_monitor_publish_listed` | 没有 = 一键发布不出现在付费墙、价格页 | 按 B7：一键发布验收通过后由总控打开。**staging 也没打开**，正式打开前要在 staging 先看一次付费墙和价格页 |
| `publish_monitor_benchmark_limit` | 5 | 不需要（REL-1 没提到；对标监测账号上限，没有 Owner 另定的数） |
| `publish_monitor_daily_page_cap` | 10 | 不需要（REL-1 没提到；作品数据每日翻页上限） |
| `billing_platform_absorb_alert`、`billing_platform_absorb_ack` | 没有 = 后台"平台承担"提醒关闭 | **待总控定**：这是只在后台账务页显示的平台承担超额提醒（不发邮件、不进 Sentry）。staging 也没配；上线第一周观察平台承担时可以配一个阈值 |
| `waffo_test_abuse_thresholds` | 5 | 不需要（Waffo 测试用） |

**D. 正式库专有、staging 没有的键**（`runtime_payg_production` 今天仍被准入配置读取，要和 2.2 E 的 `runtime_payg` 一起写；V2-12 合并后旧键才取消）

| 键 | 归属 | 备注 |
| --- | --- | --- |
| `runtime_environment` = `"production"` | B2 | 正式库标记，**绝不在 staging 写** |
| `runtime_payg_production` | B4 | 结构同 staging 的 `runtime_payg_staging` 去掉 `windowId` 和到期日。staging 的 6 条档案用途合计正好 9 个（`skill`、`report`、`ordinary`、`skill_matching`、`fusion_review`、`fusion_compare`、`fusion_summary`、`organizer`、`attached_organizer`），和 B4"档案用途上限 9"一致；6 个模型：Gemini 3.8 Flash、Sonnet 5.5、GPT-6 Luna（整理）、GPT-6.1 Sol、Opus 5.5（汇总+对比）、Gemini 4 Argon（评审） |

**E. 主路径重做（CORE-PATH-V2）后新增的键**（种子文件**故意不写**，建库日第 1 部分第 17 步单独写）

| 键 | 结构（今天代码） | 谁读 | 空库建库后 | 结论 |
| --- | --- | --- | --- | --- |
| `core_path_v2` | 对象 `{enabled, stopLoss:{limitUsd,p,poolSize,uFastUsd,uBigUsd}, decisionUpperUsd}`，严格校验（多一个字段也算无效） | 每个对话、导师、对比、评审团回合开轮前（`services/turn/chat.ts` `readCoreConfig`） | 没有 | **必须写**，否则所有回合 `TURN_CORE_DISABLED`。日限和连接池是 Owner 的数字；V2-12（#1645）会删 `enabled`，形状以合并后的代码为准 |
| `runtime_payg`（以及今天仍被准入配置读取的 `runtime_payg_production`，两份内容一致；staging 上对应 `runtime_payg_staging` 和 `runtime_payg`，总控 11-04 已在两份的 Sonnet 5.5 档案加了 imageInput） | 准入档案：线路、用途、请求格式、思考档位、容量、`enabled`；没有窗口编号和到期日；对话模型（Sonnet 5.5）的档案带 `imageInput: {maxDataUrlBytes: 819223, maxEdge: 2048}`（自由对话附图 #1702，缺了就不能附图） | 报价（`services/turn/quote.ts`、`fusionQuote.ts`） | 没有 | **必须写**（B4）。取代 `runtime_payg_production`，V2-12 后旧键不再有人读 |
| `runtime_rw_v2` | 对象，今天只看 `catalogCache`（`admitSplit` 只管旧准入） | 目录缓存 `services/turn/settings/catalogCache.ts`、`runtime_rw_flag` | 没有 = 缓存关 | 写 `{"catalogCache":true}`（100 人复测按开着的状态跑）；V2-12 会删这个开关，合并后重核 |

### 2.3 套餐 `membership_plans`（staging 3 行）

| 档 | 月付 / 年付（美分） | 月积分 / 年积分 | 积分包折扣 | 评审团 / 对比 | 发布 / 对标监测 / 每周复盘 | 定位档案上限 | 资料库空间 | 自有数据窗口 / 历史保留（天） |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Free | 0 / 0 | 0 / 0 | 100（不打折） | 否 / 否 | 否 / 否 / 否 | 1 | 50 MB | 0 / 7 |
| Pro | 2900 / 27900 | 3480 / 41760 | 95 | 否 / 否 | 是 / 否 / 否 | 3 | 500 MB | 30 / 30 |
| Gold | 6900 / 62100 | 8970 / 107640 | 90 | 是 / 是 | 是 / 是 / 是 | 6 | 2 GB | 90 / 90 |

和 REL-1 B3（Pro $29 / 3,480、Gold $69 / 8,970，年付 $279 / $621，免费每月 0）一致。
**空库建库后没有这三行**（迁移只改列、不插行），要由 B3 写入；Owner 2026-10-25 定了"会员价格后台改只读，改价走迁移"，
由 [正式种子文件](../../../packages/db/seeds/production_non_secret_baseline.sql) 写入（第 1 部分第 15 步，见第 4 部分问题 4）。Owner 2026-11-03 定的 Pro 2 GB、Gold 10 GB 存储随图片生成版本走，种子仍写 500 MB / 2 GB（见第 4 部分问题 19）。
Stripe 价格编号列只来自 `payment_provider_refs`，staging 的编号是沙盒的，正式不复制。

### 2.4 积分包 `credit_packages`（staging 7 行）

| 名称 | 价格（美分） | 积分 | 赠送 | 在售 | 正式 |
| --- | --- | --- | --- | --- | --- |
| 积分包 小 | 990 | 990 | 0 | 是 | 导入 |
| 积分包 中 | 2990 | 2990 | 0 | 是 | 导入 |
| 积分包 大 | 9990 | 9990 | 1000 | 是 | 导入 |
| Staging 100 / Starter / Plus / Max（4 行） | — | — | — | 否 | **staging 专用，正式不导入** |

每 1 美元 100 积分、最小 9.9 美元，和 Master Plan 第 2.1 节一致。积分包按会员档定价靠 `payment_provider_refs`（Pro、Gold 各 3 个）。

### 2.5 模型和线路 `ai_models`（staging 7 行，全部启用）

| 名称 | 供应商模型 | 被谁用（staging） | 正式 |
| --- | --- | --- | --- |
| claude-sonnet-5.5 | anthropic/claude-sonnet-5.5 | `primary_model_id`、对比默认、评审、档案 | 导入 |
| Gemini 3.8 Flash | google/gemini-3.8-flash | 对比默认、档案 | 导入 |
| gpt-6.1-sol | openai/gpt-6.1-sol | 对比默认、评审 | 导入；B7 加低思考档 |
| claude-opus-5.5 | anthropic/claude-opus-5.5 | 对比可选、评审汇总 | 导入；B7 加低思考档 |
| Gemini 4 Argon | google/gemini-4-argon | 评审第三位（Owner 2026-10-25） | 导入 |
| gpt-6-luna | openai/gpt-6-luna | `v3_summary_model_id`（整理、文风） | 导入 |
| Qwen3.8 Max（名称前有空格） | qwen/qwen3.8-max-0902 | **没有任何设置和档案引用** | **待总控定**：建议不导入或导入为停用；staging 名称开头多一个空格 |

价格按 B3：导入后在后台点"读取价格"，不从 staging 复制；`config` 里的 `connection_status`、`last_error*`、`last_tested` 是 staging 的连接测试记录，不复制。

### 2.6 Skill 和模块（staging 4 个已发布 Skill、4 个模块）

| 模块 | 在用 | 使用用户文风 | 与社媒相关 | Skill 版本（staging） |
| --- | --- | --- | --- | --- |
| 社媒账号定位与商业规划 | 是 | 否 | 否 | 已发布 v18 |
| 视频口播稿（测试版） | 是 | 是 | 是 | 已发布 v6 |
| 图文与文章（测试版） | 是 | 是 | 是 | 已发布 v6 |
| 报告评审（内部，评审团专用） | 否（内部） | 否 | 否 | 已发布 v2 |

- **REL-1 B7 列了 4 个写作 Skill 勾"使用用户文风"**（`short-video-script`、`post-and-article`、`video-storyboard`、`video-editing-guide`），
  但 staging 只发布了前两个；分镜和剪辑建议从没在 staging 发布过（发布前提 #1036 已在 10-17 合并）。见第 4 部分问题 5。
- 两个写作模块标题带"（测试版）"，正式发布用什么标题随 B3a Owner 看样例时一起定。
- Skill 原文在私密仓库 `graylum-skills`，正式导入后按 B3a 保持未发布，Owner 单独确认后才发布。

### 2.7 付款映射 `payment_provider_refs`（staging 全部是 `mode=test`）

staging 当前有效（`is_current`）的价格类映射，按渠道各 18 条：

| 用途 | 档 | 周期 | Stripe | Waffo |
| --- | --- | --- | --- | --- |
| 订阅（银行卡） | 标准 Pro/Gold | 月 / 年 | 2 + 2 | 2 + 2 |
| 订阅 | 创始 | 年 | 1 | 1 |
| 订阅首月优惠 | Gold 首月 | 月 | 1（coupon） | 1（price） |
| 一次性会员（钱包） | 标准 Pro/Gold | 月 / 年 | 2 + 2 | 2 + 2 |
| 一次性会员 | 创始 | 年 | 1 | 1 |
| 一次性会员 | Gold 首月 | 月 | 1 | 1 |
| 积分包 | Pro / Gold 各 3 | 一次性 | 6 | 6 |

另有已失效的历史行（订单、结账、退款、订阅记录）都是 staging 测试数据，**正式一条都不复制**。
正式库按第 3.6 节 S4 的 SQL 写 `mode=live`、`channel=stripe`，B5 读回时对照这张表"每个套餐/积分包/方式/周期恰好一条当前映射"；Waffo 正式映射在 S-8 才写（12 个一次性商品）。

### 2.8 后台密钥槽 `platform_secrets`（只看槽位名）

staging 7 个槽位都已填：`openrouter`、`postforme`、`postforme_webhook`、`tikhub`、`parallel`、`firecrawl`、`resend`，和 REL-1 B11 列的一致。正式由 Owner 自己填，不从 staging 复制。

## 3. 上线后第一天告警值守（REL-1 第 5 节补充草稿）

### 3.1 为什么要这张表

2026-10-25 staging 的注销积压 `ERASURE_BACKLOG`（fatal）每 5 分钟报一次，一直没人接。原因不在代码：告警只是发进 Sentry，
**发给谁、多久提醒一次、谁去处理**都没定。正式站上线第一天之前，下面每一行都要有人接、有时限。

### 3.2 告警能发出来的前提（缺一个就"静默失败"）

| 前提 | 缺了会怎样 | 在 REL-1 哪一步 |
| --- | --- | --- |
| Vercel 正式变量 `NEXT_PUBLIC_SENTRY_DSN`（服务端、edge、浏览器都读它） | **所有 Sentry 告警都发不出去**，启动检查只记一条 warning，不算失败 | V2 只写了"Sentry 几个变量"，要点名 |
| Sentry 里正式和 staging 分得开（`SENTRY_ENVIRONMENT` / 单独项目） | staging 的告警混进正式的通知，或规则按环境过滤后漏掉正式 | 没写，需要总控在 P9 只读核对时记下 |
| Sentry **通知规则**：下表每个告警码"每次出现都通知"或"持续出现时每小时再提醒"，通知到 Owner 的邮箱/手机 | 只有"新 issue 才通知"时，同一个码第二次、第三次出现都不再通知（10-25 就是这样）；第二个拒付也算同一个 issue | 文档里只记过一条规则 `PUBLISH_MONITOR_CLEANUP_STUCK`（第 3.0 节），其余都没有 |
| 后台"成本止损"填了金额，`resend` 槽、`support_email` 已填，且部署是 `main` + 正式域名 | 止损邮件一封都不发（只在 Sentry 里留一条"没配置"） | P4、B11 |
| `CRON_SECRET` | 所有定时任务返回 503，没有任何告警 | P5、V1 |
| `STRIPE_CARD_RECONCILIATION_MODE=live` | 每日卡单对账整段跳过，不告警 | V2 |

上线前做一次**合成告警演练**（在冒烟日，部署访问保护还开着时）：手动触发一次"Runtime 成本与余额告警"检查（K10 已有），
并在 Sentry 后台对每条规则点"发送测试通知"，确认 Owner 真的收到。结果记在上线 PR。

### 3.3 告警值守表

"谁看"：上线第一周 Sentry 通知和止损邮件都发到 Owner；Owner 收到后转给总控，总控查原因、给处理建议。
ALERT-FEISHU 起，下表的付款、退款、拒付、止损、积压告警和网站报错激增，同时用中文发到 Graylum 飞书群（只配正式环境）；飞书在正式站验证过后，Owner 关掉 Sentry 邮件，以飞书为准。
**总控读正式 Sentry、Vercel 日志和正式库都属于"读正式数据"，要 Owner 当次同意**（AGENTS 第 1 节），
所以第一周建议 Owner 一次性批准"只读、只为处理下表告警"的范围（可复制句见 3.4）。处理动作里凡是写正式库、改正式配置、退款的，仍要逐次批准。

"多久内处理"按影响分三档：**30 分钟**（钱、用户付了钱没到账、隐私承诺快到期）、**4 小时**（功能停摆但不丢钱）、**当天**（需要人工对单、不影响用户）。

| # | 告警（Sentry 消息或邮件标题） | 级别 · 发到哪 | 什么时候响 | 会多频繁 | 多久内处理 | 第一步做什么 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `ERASURE_BACKLOG` | 超过 12 小时 error，超过 20 小时 **fatal** · Sentry | 有注销确认后超过 12 小时还没清完（隐私承诺 24 小时） | 每 5 分钟一次，直到清完 | **fatal 30 分钟**；error 4 小时 | 看卡在哪一步、`account-erasure` 定时任务是否 500。**后台没有注销请求页面**，要只读正式库 |
| 2 | `LIBRARY_CLEANUP_BACKLOG` | 待删 ≥3000、最老一条超过约 9 小时、连续 6 次失败 → error；有删除超过 24 小时或待删 ≥5000 → **fatal** · Sentry | 资料库删除积压（阈值来自 #1420 演练） | 每 5 分钟 | **fatal 30 分钟**；error 4 小时 | 先看是不是存储故障（连续失败），再看积压增速 |
| 3 | 止损邮件"Graylum 止损告警" | 邮件 → `support_email`；后台"成本止损"页同时显示 | 全站当日花费到告警线 / 到上限（到上限时同时拒绝新调用）、单用户到上限、供应商余额低于提醒线、24 小时没在后台记余额（"未知"）、监控读不到设置 | 每天每条阈值一次；余额只在每天 10:00 UTC 查一次 | **30 分钟** | 后台"成本止损"看是哪条；必要时打开"停止新调用"；"未知"就去后台补记余额 |
| 4 | `API_BILLING_RUNTIME_STOP_LOSS_NOTICE_NOT_CONFIGURED` / `_FAILED` | error · Sentry | 止损邮件发不出去（没填邮箱、`resend` 槽、不是正式部署、Resend 失败） | 失败时可能每分钟一次 | **30 分钟** | 补 `resend` 槽或 `support_email`；在补好之前止损告警只能靠看后台 |
| 5 | `PAY_DISPUTE_*`（拒付开立、冻结、退款单被拒付、对不上订单、关闭等） | error · Sentry | Stripe 回调或每日对账发现拒付 | 每个拒付每类一次 | **30 分钟**（看举证截止日） | Stripe 后台看拒付和**举证截止日**（Sentry 里被脱敏，看不到） |
| 6 | `PAY_COMMON_PAYMENT_EVIDENCE_CONFLICT` | error · Sentry | 付款已确认但开通被拒 | 每个回调一次，Stripe 重试会重复 | **30 分钟** | 可能是"付了钱没给东西"：对照 Stripe 事件和订单，按第 5 节损失线规则先停后报 |
| 7 | `PUBLISH_MONITOR_QUOTA_FULL`（fatal）/ `_NEAR`（warning） | Sentry | Post for Me 已用条数 ≥ 套餐上限 / ≥80% | 每 10 分钟 | FULL **30 分钟**；NEAR 当天 | 满额后新发布暂停：问 Owner 要不要升套餐（升套餐要花钱，Owner 批） |
| 8 | `PUBLISH_MONITOR_CLEANUP_STUCK` | error · Sentry（已有规则） | Post for Me 清理试了 50 次还有剩 | 每 10 分钟 | 当天 | 后台作品复盘"清理 → 外部待处理" |
| 9 | `PAY_STRIPE_MP_RECONCILIATION_REVIEW_REQUIRED` | error · Sentry | 每日 04:00 UTC 卡单对账有没修好的项 | 每天，问题不消就天天报 | 当天 | Stripe 后台对单 |
| 10 | `PAY_COMMON_ANNUAL_RELEASE_REVIEW_REQUIRED`、`PAY_NOTIFY_REVIEW_REQUIRED` | error · Sentry | 每日 03:00 UTC 年付积分释放异常 / 付款提醒要人工处理 | 每天 | 当天 | 后台付款提醒页用同一幂等键重发（24 小时内） |
| 11 | `API_SYSTEM_CRON_JOB` | error · Sentry | 每日对账任一子项失败（账务不一致、卡住的扣费轮次、成本未知、评审团、文风、报告费、**TikHub 价格刷新失败或 1 天内到期**、收据清理等） | 每天 | 当天；账务不一致 **30 分钟** | 多个定时任务共用这个码，要看正式 Vercel 日志里是哪一项 |
| 12 | `API_BILLING_RESEARCH_PRICE_REFRESH` | error · Sentry | TikHub 价格刷新失败或 1 天内到期（到期后研究工具自动停） | 每天 | 4 小时 | 后台刷新价格（K12） |
| 13 | `API_API_RUNTIME_*RECOVERY*_FAILED` | error · Sentry | 每分钟的自动结算/退款恢复有一条失败 | 最多每分钟一次 | **30 分钟**（可能该退没退） | 查未结算的调用 |
| 14 | `API_SECURITY_*RATE_LIMIT*_UNAVAILABLE_DENYING_REQUEST` | error · Sentry | Redis 不可用，按设计拒绝用户请求 | **每个请求一次**，会刷屏 | **30 分钟**（全站不能用） | 查 Upstash 状态 |
| 15 | `ENV_VALIDATION_FAILED` | error · Sentry | 新实例启动时必填变量缺失 | 每个新实例一次 | 4 小时 | 按变量名补 Vercel 变量（重新部署才生效） |
| 16 | 其他 `API_*` error、页面未捕获异常 | error · Sentry | 用户请求路径上的数据库、密钥、供应商失败等 | 每次 | 突增时 4 小时；零星的当天看 | 看 Sentry 堆栈和次数 |

**不会自己响、要人去看的**：注销、资料库清理、评审团恢复、分钟恢复这几个定时任务**整体失败返回 500 时不发 Sentry**；
积压查询本身失败只写日志；Stripe 回调的一般失败只写日志；后台"平台承担"提醒只在页面上显示。
所以第一周每天固定看一次：Vercel 定时任务调用记录（有没有连续 500/503）、后台"成本止损"、后台"平台承担"、Sentry 当天新 issue。

### 3.4 第一周要 Owner 先定的两句话（**已定，Owner 2026-11-04，Master Plan 第 2.1 节**）

告警邮箱是 Owner 指定的告警邮箱（不入库，地址只在总控本机清单和共享笔记里）。下面两句是当时的草稿，Owner 的原话以 Master Plan 第 2.1 节为准；规则按第 3.3 节建，第一周按公开开放当天起算。

- 「上线第一周，Sentry 告警和止损邮件发到 `<Owner 的邮箱/手机>`，规则按 REL-1-BUILD-PREP 第 3.3 节设成持续出现时每小时再提醒。」
- 「上线第一周，同意总控为处理第 3.3 节的告警只读查看正式 Sentry、Vercel 日志和正式库（不输出密钥和用户正文）；任何写入、改配置、退款仍逐次问我。」

## 4. 发现的问题（不在本 PR 里改，交总控处理）

同时写在 PR 描述"发现的问题"一节。

1. **`runtime_report_generation` 漏了**：正式库必须写 `{"enabled":true}`，否则定位报告全部 `REPORT_DISABLED`（核心 1）。空库没有任何迁移写它。建议补进 REL-1 B7。
2. ~~**每日签到会在正式站自动发积分**~~ 已定（10-26 删除签到入口，#1443）：（缺省每天 5–25、每月满勤加 50），个人中心有入口；没找到 Owner 关于上线开不开签到、给多少的决定。需要 Owner 一句话。
3. **`support_email` 会公开显示**：REL-1 B11 说它和页面显示的客服邮箱"是两回事"，但代码里关于我们、无障碍、博客、维护页、登录页都读这个值。填一个只收告警的私人邮箱会被公开。建议 B11 改写，邮箱由 Owner 选。
4. **套餐和积分包怎么写入正式库没说清**：空库没有这几行；Owner 10-25 定了"会员价格后台改只读、改价走迁移"。B3 要写明用哪份 SQL（建议照 staging 种子文件结构另出正式版，总控审核）。
   已定：用 [production_non_secret_baseline.sql](../../../packages/db/seeds/production_non_secret_baseline.sql) 写入 B3/B7 非密钥配置；建库日替换占位、Owner 批准后由总控执行。
5. **4 个写作 Skill 只有 2 个在 staging 发布过**：分镜、剪辑建议从没在 staging 发布和验收，B7 却要在正式勾"使用用户文风"。**已定（Owner 2026-11-04：“分镜、剪辑建议这两个写作 Skill 上线要带。”）：上线要带**；所以先在 staging 发布并验收（最小方案：导入、各跑一轮、对照开关“我的文风”看字幕和口播原句是否带文风、未确认定位被拦截且不扣积分），验收通过后再在建库日第 30e 步由 Owner 看样例单独确认正式版本。
6. **`chat_my_posts_enabled`**：~~staging 是关的，REL-1 B7 列了但没写取值。~~ 已定（10-26）：正式 `true`，见第 1 部分。
7. **`v3_summary_max_tokens`**：staging 4096、缺省 2048，正式取哪个没有记录。
8. **`Qwen3.8 Max`** 在 staging 启用但没有任何引用，名字前多一个空格；正式建议不导入。
9. ~~**REL-1 日期过期**~~ 已由 #1638 刷新；Owner 11-03 定上线日 11-15；11-05 Owner 决定不做功能冻结（11-10 冻结日作废），上线日不变。
10. ~~**B1 没写干净起点建库**~~ 已核对原文（11-03）：BASELINE-SQUASH 的干净起点只在三方逐对象一致时才用，不一致退回旧方式；所以逐个迁移回放满足决定，清单第 11 步已写明走回放。
11. **V2 没点名 `NEXT_PUBLIC_SENTRY_DSN`**，而缺了它所有告警静默；也没有合成告警演练和 Sentry 通知规则这一步（第 3.2 节）。
12. **staging 的止损金额全是空的**：止损告警在 staging 从没真正发过一封，正式第一次发信就是上线后。建议冒烟日 K10 用一个很低的告警线真实触发一次再改回。
13. **REL-1 第 3.6 节说钱包"六个会员产品、七个价格"**，staging 当前有效的一次性会员价格是 6 条（标准月/年各 2、创始 1、Gold 首月 1）。以 S4 脚本输出为准，B5 读回时核对。
14. **`publish_monitor_publish_listed` staging 也没打开**：一键发布在付费墙和价格页的展示从没在 staging 看过，正式打开前要先在 staging 看一次。
15. **Vercel 网站统计和速度统计要在正式项目打开**（10-26 第十一批发现）：代码已接 `@vercel/analytics` 和 `@vercel/speed-insights`，但项目没在 Vercel 后台开 Web Analytics 时 `/_vercel/insights/script.js` 返回 404、控制台报错，统计不上报（Owner 10-13 决定用 Vercel Web Analytics 看总量和中国大陆）。staging 10-26 已由 Owner 开启 Web Analytics（Speed Insights 早已开）。正式：Owner 在正式项目的 Analytics、Speed Insights 两页点开启，之后的第一次部署才生效；冒烟日确认两个脚本都返回 200。
16. **钱包到期提醒的真实发信没在 staging 验过**（PAY-NOTIFY，10-26）：提醒只发到账户本人登录邮箱，且必须在 `PAYMENT_NOTICE_TEST_RECIPIENTS` 名单里；只有每天 03:00 UTC 的定时任务发信；staging 没有 7 天内到期的微信/支付宝年付单。10-26 只核对现有一条 founder_ended 提醒的去向。上线前演练：用一个登录邮箱在名单里的测试账号、一张 7 天内到期的钱包年付单，等定时任务发出并读回 `payment_notices`（state=sent）。
17. **一键发布的平台名单 staging 是空的**（`publish_monitor_publish_platforms`）：只有名单里的平台在页面上开放发布。Owner 在场授权 X/YouTube 那次验收前，总控先在 staging 写 `["x","youtube"]`；正式按第 7 节 E1 的平台写。
18. **历史迁移 0005 会在空库里建诊断测试账户**：逐个迁移建库会把它带进正式库。种子不新增、不改账户（测试比较执行前后账户完全一致）。**已定（Owner 2026-11-04“诊断账户选 A”）：开放前删掉**，由总控在第 37、41a 步列出并删除。
19. ~~**存储容量**~~ 已定（总控 11-03）：上线保持 Pro 500 MB / Gold 2 GB；IMAGE-GEN 第 13.1 节批的 Pro 2 GB / Gold 10 GB 随图片版本（约 11-25）作为那个版本的配置变更一起改。种子已加注释。
20. ~~**`LANDING_PROMO_OFFERS`**~~ 已定（总控 11-03，见上线撤回清单）：上线时设 `on`；前提是先在 staging 做 #987 的开/关 A/B 验收（第 1 部分第 25a 步），正式设置要 Owner 批准。
21. ~~**"七个平台"和名单里的 9 个**~~ 已定（总控 11-03）：以 Master Plan 10-24 E1 为准，9 个平台都开放；正式发帖只验证 X 和 YouTube。
22. **`TURN_DATABASE_HOST` 是主路径新增的必填变量**，REL-1 第 3.4 节 V2 没有点名；没设或和实际连接的库不一致时，`/api/turn` 全部 503。已写进第 1 部分第 25 步，REL-1 V2 也该补上。
23. ~~**REL-1 第 3.3 节 B7 的作品复盘一行没提 `publish_monitor_coach_enabled`**~~ 已在后续同步 PR 里补上（种子本来就写 `true`）。
24. ~~REL-1 的 K8、K9（真钱付款）和 E2（隔离项目演练）已被 Owner 11-03 决定取代~~ 已在同一 PR 里改正 REL-1 正文（上线日 11-15、K8/K9 取消、E2 改在 staging、E4/E5 标建库日 Owner 操作）。
25. **后台操作的先后**（机器人 #1465 审查提出）：后台页面（读取价格、管理员、密钥槽、止损金额、研究工具上限确认、Skill 发布）要等站点指向新库部署之后才有，所以只写数据库的步骤（11–20）在前，后台操作集中在第 30a–30f 步，期间新调用和付款路由保持关。REL-1 第 3.3 节 B3、B10、B11 的原顺序有同样的先后问题，本 PR 不改 REL-1 该节，以本清单为准。
26. **运营教练复盘包要在正式库发布后再接线**（2026-11-04 同步）：环境变量 `PUBLISH_MONITOR_HANDBOOK_PACKAGE` 要的 Skill uuid、版本 uuid、包哈希，只有第 30e 步发布之后才有，所以排在第 30e1 步并要重新部署一次；冒烟 K7 的教练复盘排在它之后。
27. 近期新增的迁移 0497–0507（0505–0507 见第 11 步）、对话附图配置（`imageInput`，第 17 步已有）、`publish_monitor_coach_enabled`（种子已有）不需要新的种子项；唯一新增的建库日配置是上面的 `PUBLISH_MONITOR_HANDBOOK_PACKAGE`。
28. **正式变量名可以先机器核对**（2026-11-04 晚新增）：`node scripts/check-prod-env-names.mjs --phase build|smoke|public <变量名清单文件>`。清单文件只放变量名（Owner 或总控从 Vercel 后台抄名字，不抄值，值不会被读也不会被打印）；`build` 对应第 24–26 步（缺必填、出现 staging／测试专用变量或 `E2E_*`、提前设了 `SITE_INDEXING` 或 `PUBLISH_MONITOR_HANDBOOK_PACKAGE` 都失败），`smoke` 要求第 30e1 步的变量已设，`public` 还要求 `SITE_INDEXING` 已设（第 38 步）。**只核对名字、不看取值**（`=on`、`=live` 这类要另外读回）；Waffo 正式四件要等 S-8 审核后才有，脚本不查；`LANDING_PROMO_OFFERS` 缺失只给警告。脚本里的名单有测试盯着：任何一个名字在代码里没人读了，CI 就红。
29. **旧的 `docs/runbooks/PRODUCTION_RELEASE.md` 已过期**（里面写"后台套餐填 `price_xxx`""第一笔真实支付"），和 Owner 11-03 的"正式站不做真钱付款"冲突。本 PR 在它开头加了指向本清单的说明，不改它的其余内容。
