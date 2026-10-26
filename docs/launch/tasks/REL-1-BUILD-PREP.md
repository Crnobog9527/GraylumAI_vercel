# REL-1 建库准备材料（2026-10-26，冻结 11-10 前预备）

> **这份文件不授权任何操作。** 它是 [REL-1](REL-1.md) 第 3.2–3.7 节和第 5 节的预备底稿：
> 第 1 部分给 B8"种子配置全量核对"一张 staging 对照表，第 2 部分是 Q2"批准包"的草稿，第 3 部分是上线后第一天的告警值守表。
> 建库、部署、正式配置每一步仍要 Owner 当次批准（[AGENTS.md](../../../AGENTS.md) 第 1 节）。
>
> **怎么查的**：2026-10-26 用 supabase CLI 只读查 staging（只 link 了 staging），只取键名、JSON 类型、对象的字段名、
> 行数和少量不含身份信息的公开取值（价格、开关）；**没有碰正式环境**，没有抄任何密钥、账号、邮箱、项目编号或沙盒编号。
> 代码依据是 `origin/staging` f3ac911e（迁移到 0394）。staging 数据会变，建库日 B8 要按当天的 staging 重查一遍，本表只是底稿。

## 1. B8 种子配置对照底稿

### 1.1 怎么读这张表

- **归属**：这个键在 REL-1 第 3.3 节哪一步（B3 配置类数据、B4 准入档案、B5 付款、B6 限流、B7 功能配置、B11 后台填写），或"REL-1 没提到"。
- **空库建库后**：从文件建库后这个键是不是已经有了——"迁移写入"表示某个迁移在空库里插了缺省值；"缺省走代码"表示表里没有这一行时代码用写死的缺省；"必须写"表示没有它功能不能用。
- **上线值从哪来**：Owner 已定的决定（[Master Plan](../MASTER_PLAN.md) 第 2.1 节）或 REL-1 的条目；staging 测试专用的值写"staging 专用，正式不复制"。
- **结论**：REL-1 没提到的键，逐个写"正式要设 / 不需要 / 待总控定"和理由。

### 1.2 `system_settings`（staging 共 85 个键）

**A. REL-1 已覆盖的键**

| 键 | 类型（staging） | 归属 | 空库建库后 | 上线值从哪来 / 备注 |
| --- | --- | --- | --- | --- |
| `billing_credits_per_usd` | 字符串 | B3 | 必须写 | q=100（Owner 2026-10-01，BILL-UNIT）。staging 也是 100 |
| `billing_token_price_multiplier` | 字符串 | B3 | 必须写 | **m=6**（Owner 2026-10-01）。**staging 是 3（测试专用），正式不复制** |
| `runtime_purpose_budgets` | 字符串（内含 JSON：`report`、`organize`、`interactive`、`version`） | B3 | 必须写 | 按 B3 照 staging 结构写；数值以冻结版本的设计为准 |
| `runtime_payg_staging` | 对象（`enabled`、`profiles` 6 条、`version`、`windowId`） | 对应 B4 | 正式不用 | **staging 专用，正式不复制**；正式写 `runtime_payg_production`（见 1.2 D） |
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
| `publish_monitor_review_enabled`、`_review_model_id`、`_review_max_usd` | 布尔 / null / 字符串 | B7 | 迁移写入 false / null / "0" | 正式 true、正式库的模型 uuid、`"0.30"`。**staging 是关着的**（复盘只验过关闭态） |
| `publish_monitor_publish_platforms` | 数组（staging 空） | B7 | 缺省空 | 正式按第 7 节 E1 的 9 个平台 |
| `publish_monitor_publish_quota` | 对象（`limit`、`periodAnchor`） | B7 | 没有缺省（不填就不能发布） | 正式按 Post for Me 正式项目的套餐条数和续期时间；**staging 的值对应 staging 项目，正式不复制** |
| `publish_monitor_publish_price` | 对象 `{usdPerTarget}` | REL-1 没写（B7 相关） | 迁移写入 0.01 美元/目标 | 不需要另写：换算跟全站 q、m 走（Owner 2026-10-25，0392） |
| `primary_model_id` | 字符串（uuid） | B7 | 必须写 | 正式库 Sonnet 5.5 的 uuid（staging 指向 Sonnet 5.5），且在 B4 档案里 |
| `v3_summary_model_id` | 字符串（uuid） | B4 提到 | 必须写 | 正式库 GPT-6 Luna 的 uuid（staging 同） |
| `support_email` | 字符串 | B11 | 缺省走代码 | Owner 填。**注意：这个值会显示在公开页面上**（见第 4 部分问题 3） |

**B. REL-1 第 3.3 节没提到、staging 有的键（逐个定性）**

| 键 | 类型 | 代码里谁读 | 空库建库后 | 结论 | 理由 |
| --- | --- | --- | --- | --- | --- |
| `runtime_report_generation` | 对象 `{enabled}` | 报告准入 `report_admission_check`：不等于 `{"enabled":true}` 就拒绝 `REPORT_DISABLED` | **没有**（没有迁移写入） | **正式要设** `{"enabled":true}` | 不设，定位报告（核心 1）在正式站全部被拒。staging 是 true |
| `v3_summary_max_tokens` | 字符串 | 整理器输出上限（128–4096） | 缺省走代码 2048 | **待总控定** | staging 是 4096，缺省 2048；文风生成和整理都用整理器，正式按 staging 验过的 4096 写更稳，但没有 Owner 决定记录 |
| `site_name` | 字符串 | 登录页、维护页、后台侧栏、公开页 | 缺省走代码 | **不需要**（或写正式站名） | staging 的值带"Staging"字样，**正式不复制**；不写时用代码里的站名 |
| `maintenance_mode` | 字符串 | 入口和上传路由 | 缺省走代码（不维护） | 不需要 | staging 是 false，和缺省一样；需要时才打开 |
| `max_input_characters` | 字符串 | 公开设置（给前端） | 缺省走代码 | 待总控定 | staging 是 10000；没找到 Owner 决定，建议照 staging |
| `home_show_onboarding`、`home_show_featured_modules`、`home_analysis_module_id` | 字符串 | 首页 | 缺省走代码（显示） | 不需要（`home_analysis_module_id` 待总控定） | 前两项 staging 和缺省一样；`home_analysis_module_id` 指向 staging 的模块 uuid，正式要么不写，要么写正式库定位模块的 uuid |
| `fusion_compare_max_models` | 数字 | 对比上限 | 迁移写入 4 | 不需要 | 和 staging 一样 |
| `report_fixed_price_credits` | 数字 | 报告固定价 | 迁移写入 500 | 不需要 | 和 Owner 决定的 500 积分固定价一致 |
| `runtime_capacity_marker_since` | 字符串 | 卡住回合自动关闭 | 函数第一次调用时写入 | 不需要 | 自动生成 |
| `founder_community_entry` | 对象（`url`、`note`、`updatedAt`、`updatedBy`） | 创始会员社群入口 | 没有 | 待总控定 | 内容由 Owner 定（社群链接），staging 的值是测试内容，正式不复制；不写时入口不显示 |
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

**D. 正式库专有、staging 没有的键**

| 键 | 归属 | 备注 |
| --- | --- | --- |
| `runtime_environment` = `"production"` | B2 | 正式库标记，**绝不在 staging 写** |
| `runtime_payg_production` | B4 | 结构同 staging 的 `runtime_payg_staging` 去掉 `windowId` 和到期日。staging 的 6 条档案用途合计正好 9 个（`skill`、`report`、`ordinary`、`skill_matching`、`fusion_review`、`fusion_compare`、`fusion_summary`、`organizer`、`attached_organizer`），和 B4"档案用途上限 9"一致；6 个模型：Gemini 3.8 Flash、Sonnet 5.5、GPT-6 Luna（整理）、GPT-6.1 Sol、Opus 5.5（汇总+对比）、Gemini 4 Argon（评审） |

### 1.3 套餐 `membership_plans`（staging 3 行）

| 档 | 月付 / 年付（美分） | 月积分 / 年积分 | 积分包折扣 | 评审团 / 对比 | 发布 / 对标监测 / 每周复盘 | 定位档案上限 | 资料库空间 | 自有数据窗口 / 历史保留（天） |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Free | 0 / 0 | 0 / 0 | 100（不打折） | 否 / 否 | 否 / 否 / 否 | 1 | 50 MB | 0 / 7 |
| Pro | 2900 / 27900 | 3480 / 41760 | 95 | 否 / 否 | 是 / 否 / 否 | 3 | 500 MB | 30 / 30 |
| Gold | 6900 / 62100 | 8970 / 107640 | 90 | 是 / 是 | 是 / 是 / 是 | 6 | 2 GB | 90 / 90 |

和 REL-1 B3（Pro $29 / 3,480、Gold $69 / 8,970，年付 $279 / $621，免费每月 0）一致。
**空库建库后没有这三行**（迁移只改列、不插行），要由 B3 写入；Owner 2026-10-25 定了"会员价格后台改只读，改价走迁移"，
所以 B3 用什么写入（照 [staging 种子文件](../../../packages/db/seeds/staging_non_secret_baseline.sql) 的结构另出一份正式 SQL，还是后台目录保存）需要总控在批准包里写明（见第 4 部分问题 4）。
Stripe 价格编号列只来自 `payment_provider_refs`，staging 的编号是沙盒的，正式不复制。

### 1.4 积分包 `credit_packages`（staging 7 行）

| 名称 | 价格（美分） | 积分 | 赠送 | 在售 | 正式 |
| --- | --- | --- | --- | --- | --- |
| 积分包 小 | 990 | 990 | 0 | 是 | 导入 |
| 积分包 中 | 2990 | 2990 | 0 | 是 | 导入 |
| 积分包 大 | 9990 | 9990 | 1000 | 是 | 导入 |
| Staging 100 / Starter / Plus / Max（4 行） | — | — | — | 否 | **staging 专用，正式不导入** |

每 1 美元 100 积分、最小 9.9 美元，和 Master Plan 第 2.1 节一致。积分包按会员档定价靠 `payment_provider_refs`（Pro、Gold 各 3 个）。

### 1.5 模型和线路 `ai_models`（staging 7 行，全部启用）

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

### 1.6 Skill 和模块（staging 4 个已发布 Skill、4 个模块）

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

### 1.7 付款映射 `payment_provider_refs`（staging 全部是 `mode=test`）

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

### 1.8 后台密钥槽 `platform_secrets`（只看槽位名）

staging 7 个槽位都已填：`openrouter`、`postforme`、`postforme_webhook`、`tikhub`、`parallel`、`firecrawl`、`resend`，和 REL-1 B11 列的一致。正式由 Owner 自己填，不从 staging 复制。

## 2. 3.2 批准包草稿（Q2）

按 REL-1 第 3.3–3.7 节的顺序。`<…>` 由总控在冻结版本选定后填实再发；**没填实的句子不能当授权**；每句只对当时写清楚的版本、项目、金额有效。
三条硬规矩照 REL-1 第 3 节开头：不能单独部署 `main`；Vercel 变量先换新库再合并 `main`；站点恢复、模型调用开放、真钱付款三件事分三次批准。

| # | 步骤 | 谁做 | 做什么（一句话） | 可以直接复制的批准句 |
| --- | --- | --- | --- | --- |
| 1 | Q3 | ★ Owner 批准 | 同意冻结版本和本批准包（含 Q4 三地区读回值） | 同意 REL-1 冻结版本 `<版本>` 和批准包 `<链接>`，三地区读回值 `<us-west-1 / sfo1 / us-west-1>` 一致。 |
| 2 | B1 | ★ Owner 批准 → 总控 | 在 `Graylum_main` 从空库建库；按 BASELINE-SQUASH 用干净起点（三方逐对象一致才用，否则退回逐个迁移建库），只读抓指纹比对 | 同意总控在 `Graylum_main` 按 `<干净起点 / 逐个迁移>` 从空库建库到 `<最后一个迁移号>`，建完只读比对指纹。 |
| 3 | B2 | ★ Owner 批准 → 总控 | 写正式库标记并读回，确认测试窗口为 0 | 同意总控在 `Graylum_main` 写入正式库标记并读回。 |
| 4 | B3 | ★ Owner 批准 → 总控 | 写套餐 3 行、积分包 3 个、q=100、m=6、模型 6 个（按第 1 部分）、`runtime_purpose_budgets`、输出上限；不复制任何测试数据 | 同意总控在 `Graylum_main` 导入已核对的配置：套餐（Pro $29 / 3,480、Gold $69 / 8,970、年付 $279 / $621、免费每月 0）、积分包小中大、q=100、m=6、模型 `<列表>`。 |
| 5 | B3a | ★ Owner 确认 | 看过首批创作 Skill 样例后单独确认发布；确认前只导入不发布 | 我看过首批创作 Skill `<Skill 列表>` 的样例，同意在正式环境发布这些版本 `<版本>`。 |
| 6 | B4 | ★ Owner 批准 → 总控 | 写正式准入档案 `runtime_payg_production`（6 个模型、9 个用途，评审第三位 Gemini 4 Argon） | 同意总控写入正式准入档案 `<档案摘要哈希>`。 |
| 7 | B5 | ★ Owner 批准 → 总控 | 写条款版本、Stripe 目录绑定、对账起点、钱包年付标记；四条付款路由保持关 | 同意总控写入付款条款版本 `<版本>`、Stripe 目录绑定 `<S4 审核过的 SQL 哈希>`、对账起点 `<时间>`、钱包年付标记，付款路由保持关闭。 |
| 8 | B6 | ★ Owner 批准 → 总控 | 限流初始值、`stopNewCalls` 开 | 同意总控设置正式限流：消息 10/分钟、200/天，调用 30/分钟、600/天，停止新调用保持开启。 |
| 9 | B7 | ★ Owner 批准 → 总控 | 功能配置（含本文件 1.2 B 里定为"正式要设"的 `runtime_report_generation`） | 同意总控按批准包 `<链接>` 第 B7 节写入功能配置（对比、评审团、研究工具、资料库、作品复盘、一键发布、主力模型、写作 Skill 文风、报告开关）。 |
| 10 | B8 | 总控（需批准读新库） | 对照本文件第 1 部分做全量核对，差异表附在执行记录 | 同意总控只读查询 `Graylum_main` 的配置表，和 staging 逐项对照，不输出密钥。 |
| 11 | B9 | 总控（需批准只读） | Vault、0259、旧路径订单、两个资料库桶私有、存储表没有策略 | （和第 10 行合并为一句即可） |
| 12 | B10 | ★ Owner 注册；Owner 批准 → 总控 | Owner 注册管理员账号，总控授予管理员角色 | 同意总控给 `<管理员账号>` 授予正式后台管理员角色。 |
| 13 | B11 | ★ Owner 操作 | 填 7 个密钥槽和客服邮箱（注意客服邮箱会公开显示） | （Owner 自己做，做完告诉总控）"7 个密钥槽和客服邮箱已填好，Post for Me 末 4 位已对上。" |
| 14 | V1 | ★ Owner 操作 | 换新库变量、Stripe 三件和新 webhook 密钥、`OPENING_GRANT_HMAC_KEYS`、`CRON_SECRET` | （Owner 自己做）"Vercel 正式变量里的新凭证已换好。" |
| 15 | V2 | ★ Owner 批准 → 总控 | 设非密钥变量（`SITE_INDEXING` 这时不设 public） | 同意总控设置 Vercel 正式环境的非密钥变量 `<变量清单>`。 |
| 16 | V3 | 总控只读核对 | 不能设的变量都不在 | 同意总控只读读出 Vercel 正式环境的变量名清单（不读值）。 |
| 17 | V4 | ★ Owner 操作 | 删过渡期旧变量和 E2E 凭证（B11 槽位都填好之后） | （Owner 自己做）"过渡期旧变量和 E2E 凭证已删。" |
| 18 | M1 | ★ Owner 批准 → 总控 | 冻结版本从 staging 合并到 `main`（合并即部署；站点保持暂停、新调用保持关） | 同意把 staging `<版本>` 合并到 `main` 并部署正式环境，部署时站点保持暂停、新调用保持关闭。 |
| 19 | S-1 | ★ Owner 操作（站点恢复，第一次单独批准） | 取消暂停，部署访问保护保持开 | 同意恢复正式站 `graylum-ai-vercel-v1` 的访问，部署访问保护保持开启，新调用仍关闭。 |
| 20 | S-2–S-4 | ★ Owner 操作 | 撤 www→app 307、`graylum.com` 308 到 www；生成回调绕过口令；验证后放 app→www 308 | 我来撤掉 www 到 app 的临时跳转，生成冒烟专用的回调绕过口令，验证通过后放 app 到 www 的 308。 |
| 21 | S-5 | 总控 | 受控身份发一条消息，看到"新调用暂停" | （不需要批准，属冒烟日已批范围） |
| 22 | S-6 | ★ Owner 批准 → 总控（模型调用开放，第二次单独批准） | 冒烟窗口内临时关 `stopNewCalls`、打开四条付款路由，结束后重新打开 `stopNewCalls` | 同意冒烟窗口 `<开始–结束时间>` 内临时关闭停止新调用、打开四条付款路由，冒烟结束后重新打开停止新调用。 |
| 23 | S-7 / K2 | ★ Owner 批准 | 小额模型冒烟 | 同意正式小额冒烟：用 `<测试身份>` 调用 `<模型和次数>`，总预算不超过 `<金额>` 美元。 |
| 24 | S-7 / K8 | ★ Owner 批准（真钱，第三次单独批准） | 真钱付款再退款 | 同意上线当天真实付款再退款：银行卡 `<金额和笔数>`，微信和支付宝年付 279 / 496 / 621 美元各一笔，退款后核对到账和收回。 |
| 25 | 核心 10 ③ | ★ Owner 批准（每次） | X、YouTube 各真实发布一次 | 同意 X 和 YouTube 各真实发布验收一次 `<账号和内容>`。 |
| 26 | S-8 | ★ Owner 操作 | Waffo 正式审核、12 个商品、正式密钥；总控写映射，渠道保持 stripe | 同意总控写入 Waffo 正式映射 `<12 条摘要>`，新购买渠道保持 Stripe。 |
| 27 | 第 3.6 节 S1–S5 | ★ Owner 操作（建库日之前） | 受限密钥 → `plan` → `apply` → `sql`/`sql-packs` 交总控审核 → 删受限密钥 | （Owner 自己做）"Stripe 正式目录已建好，再跑一次 plan 全部 exists，SQL 已交总控，受限密钥已删。" |
| 28 | O-1 | 总控 | 开放前核对表（含资料库清理积压演练、备份恢复演练、正式库没有测试数据、告警值守表已有人接，见第 3 部分） | （不需要批准，结果交 Owner） |
| 29 | O-2–O-4 | ★ Owner 批准 → 总控 + ★ Owner 操作 | 设 `SITE_INDEXING=public` 并重新部署；撤部署访问保护、作废绕过口令；关 `stopNewCalls` | 同意对账无误后公开开放：关闭"停止新调用"、撤掉部署访问保护，设置 `SITE_INDEXING=public` 并重新部署，核对 robots 和响应头后让搜索引擎收录。 |
| 30 | E2 | ★ Owner 批准 | 备份恢复演练费用 | 同意用单独的隔离演练项目在公开开放前演练一次备份恢复和删除重放，费用 `<金额>`。 |
| 31 | E4 | ★ Owner 批准 | 正式库 PostgREST 连接池 | 同意把正式库的 PostgREST 连接池设成 `<数字>`。 |

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

### 3.4 第一周要 Owner 先定的两句话（草稿）

- 「上线第一周，Sentry 告警和止损邮件发到 `<Owner 的邮箱/手机>`，规则按 REL-1-BUILD-PREP 第 3.3 节设成持续出现时每小时再提醒。」
- 「上线第一周，同意总控为处理第 3.3 节的告警只读查看正式 Sentry、Vercel 日志和正式库（不输出密钥和用户正文）；任何写入、改配置、退款仍逐次问我。」

## 4. 发现的问题（不在本 PR 里改，交总控处理）

同时写在 PR 描述"发现的问题"一节。

1. **`runtime_report_generation` 漏了**：正式库必须写 `{"enabled":true}`，否则定位报告全部 `REPORT_DISABLED`（核心 1）。空库没有任何迁移写它。建议补进 REL-1 B7。
2. **每日签到会在正式站自动发积分**（缺省每天 5–25、每月满勤加 50），个人中心有入口；没找到 Owner 关于上线开不开签到、给多少的决定。需要 Owner 一句话。
3. **`support_email` 会公开显示**：REL-1 B11 说它和页面显示的客服邮箱"是两回事"，但代码里关于我们、无障碍、博客、维护页、登录页都读这个值。填一个只收告警的私人邮箱会被公开。建议 B11 改写，邮箱由 Owner 选。
4. **套餐和积分包怎么写入正式库没说清**：空库没有这几行；Owner 10-25 定了"会员价格后台改只读、改价走迁移"。B3 要写明用哪份 SQL（建议照 staging 种子文件结构另出正式版，总控审核）。
   已定：用 [production_non_secret_baseline.sql](../../../packages/db/seeds/production_non_secret_baseline.sql) 写入 B3/B7 非密钥配置；建库日替换占位、Owner 批准后由总控执行。
5. **4 个写作 Skill 只有 2 个在 staging 发布过**：分镜、剪辑建议从没在 staging 发布和验收，B7 却要在正式勾"使用用户文风"。要么先在 staging 发布验收，要么 Owner 确认这两个上线时不发。
6. **`chat_my_posts_enabled`**：~~staging 是关的，REL-1 B7 列了但没写取值。~~ 已定（10-26）：正式 `true`，见第 1 部分。
7. **`v3_summary_max_tokens`**：staging 4096、缺省 2048，正式取哪个没有记录。
8. **`Qwen3.8 Max`** 在 staging 启用但没有任何引用，名字前多一个空格；正式建议不导入。
9. **REL-1 日期过期**：第 1.1 节还写"目标 11-06"，第 2 节标题和正文还是"冻结 10-28"；Owner 10-26 已改为 11-10 冻结、11-15 上线。
10. **B1 没写干净起点建库**（BASELINE-SQUASH，Owner 10-25）：三方一致才用干净起点，否则退回逐个迁移。
11. **V2 没点名 `NEXT_PUBLIC_SENTRY_DSN`**，而缺了它所有告警静默；也没有合成告警演练和 Sentry 通知规则这一步（第 3.2 节）。
12. **staging 的止损金额全是空的**：止损告警在 staging 从没真正发过一封，正式第一次发信就是上线后。建议冒烟日 K10 用一个很低的告警线真实触发一次再改回。
13. **REL-1 第 3.6 节说钱包"六个会员产品、七个价格"**，staging 当前有效的一次性会员价格是 6 条（标准月/年各 2、创始 1、Gold 首月 1）。以 S4 脚本输出为准，B5 读回时核对。
14. **`publish_monitor_publish_listed` staging 也没打开**：一键发布在付费墙和价格页的展示从没在 staging 看过，正式打开前要先在 staging 看一次。
15. **Vercel 网站统计和速度统计要在正式项目打开**（10-26 第十一批发现）：代码已接 `@vercel/analytics` 和 `@vercel/speed-insights`，但项目没在 Vercel 后台开 Web Analytics 时 `/_vercel/insights/script.js` 返回 404、控制台报错，统计不上报（Owner 10-13 决定用 Vercel Web Analytics 看总量和中国大陆）。staging 10-26 已由 Owner 开启 Web Analytics（Speed Insights 早已开）。正式：Owner 在正式项目的 Analytics、Speed Insights 两页点开启，之后的第一次部署才生效；冒烟日确认两个脚本都返回 200。
16. **钱包到期提醒的真实发信没在 staging 验过**（PAY-NOTIFY，10-26）：提醒只发到账户本人登录邮箱，且必须在 `PAYMENT_NOTICE_TEST_RECIPIENTS` 名单里；只有每天 03:00 UTC 的定时任务发信；staging 没有 7 天内到期的微信/支付宝年付单。10-26 只核对现有一条 founder_ended 提醒的去向。上线前演练：用一个登录邮箱在名单里的测试账号、一张 7 天内到期的钱包年付单，等定时任务发出并读回 `payment_notices`（state=sent）。
17. **一键发布的平台名单 staging 是空的**（`publish_monitor_publish_platforms`）：只有名单里的平台在页面上开放发布。Owner 在场授权 X/YouTube 那次验收前，总控先在 staging 写 `["x","youtube"]`；正式按第 7 节 E1 的平台写。
