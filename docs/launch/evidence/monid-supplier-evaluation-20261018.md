# RESEARCH-TOOLS：monid 海外数据供应商评估（2026-10-18）

> 状态：**准备完成，实测 BLOCKED（缺少 monid 凭证），尚无最终切换建议**。
> 本 PR 为 ordinary 文档变更，不修改产品代码、数据库、价格表或 staging 配置。
> Owner 于 2026-10-18 决定将 monid 加入供应名单，并确认已邮件取得用于 SaaS 的条款许可。
> 上述许可为 Owner 提供的事实，本次不复核邮件，不将其扩大解释为所有平台数据的无限使用权。
> 范围：海外／非中国平台的账号数据与网页抓取；中国平台继续使用 TikHub。

## 1. 当前结论与证据边界

- **目前继续使用现有线路**。没有本次真实返回及费用回执，不能宣称 monid 更便宜、字段更全或更稳定。
- 优先评估补齐 Instagram、YouTube、Facebook、LinkedIn 的能力，再按逐接口证据决定是否替换 TikTok、X 或 Firecrawl。
- monid 目录同时包含 TikHub 转售和 Apify 等其他上游。转售 TikHub 只能统一付款／入口，不能算新增独立数据来源。
- 此报告准备阶段不调用现有 TikHub／Firecrawl 付费接口，不占用后续 monid 对比预算。
- 本轮预算上限 **$1.00**；截至准备提交，付费请求 **0 次，实际花费 $0**。
- monid 凭证未在已知的本机研究凭证文件或当前进程环境中找到；不尝试创建密钥、充值或借用其他账户。

## 2. 当前线路（源码核对，不等于 staging 配置验收）

基线：`staging` `1c3f3ee17c1b923481666d7516fd283e4b0b5360`。
代码证据：[TikHub 适配器](../../../packages/api/src/services/research/vendors/tikhub.ts)、
[Firecrawl 适配器](../../../packages/api/src/services/research/vendors/firecrawl.ts)、
[线路校验](../../../packages/api/src/services/research/vendors/config.ts)。
本节接口路径均按基线源码摘录。

| 用途 | 当前供应商及路径 | 关键边界 |
| --- | --- | --- |
| TikTok 资料 | TikHub `/api/v1/tiktok/app/v3/handler_user_profile` | `unique_id` 账号参数 |
| TikTok 作品 | TikHub `/api/v1/tiktok/app/v3/fetch_user_post_videos` | `unique_id`、`max_cursor=0`、`count≤30` |
| TikTok 关键词 | TikHub `/api/v1/tiktok/app/v3/fetch_video_search_result` | `keyword`、`count≤30`、`region=US` |
| X 资料 | TikHub `/api/v1/twitter/web/fetch_user_profile` | `screen_name` |
| X 作品 | TikHub `/api/v1/twitter/web/fetch_user_post_tweet` | `screen_name` |
| X 关键词 | TikHub `/api/v1/twitter/web/fetch_search_timeline` | `keyword`、`search_type=Latest` |
| 网页抓取 | Firecrawl `POST /v1/scrape` | markdown、仅正文、单页、`parsePDF=false`、`proxy=basic`；正文给模型最多 20,000 字节 |
| Instagram | TikHub 资料 v1、作品 v3 已有适配器 | 有代码不等于有合格的对标线路；基线中未列入可用对标平台 |
| YouTube | TikHub 搜索、频道资料、频道视频、视频详情 | 频道视频相对时间不可当绝对发布时间；精确粉丝数／绝对日期需要视频详情 |
| Facebook、LinkedIn | 研究工具平台枚举没有这两个平台 | monid 目录可用也不能只改后台配置启用 |

TikHub 的当前成本契约是每个成功调用 1 call × 发起时冻结的官方接口标价，响应不提供美元成本；
Firecrawl 使用供应商 usage × 配置单价。这里没有读取在线价格表，**不得把历史单价当成本次报价**。
具体参考 [RESEARCH-TOOLS 任务说明](../tasks/RESEARCH-TOOLS.md)。

## 3. monid 候选与待测计划

[官方 API](https://docs.monid.ai/api/overview.html) 的流程为 discover → inspect → run；
异步响应需保留 runId，再读取该 run 的最终结果。COMPLETED 还需核对 providerResponse.httpStatus 和非空业务数据，不能只看 HTTP 200。
[官方 run 说明](https://docs.monid.ai/api/run.html)、[运行记录](https://docs.monid.ai/api/runs.html)。

以下仅是官方公开资料中的**候选**，并非本次调用结果，实际接口、参数和价格必须以本账号 inspect 为准。

| 范围 | 优先检查候选 | 本轮样本／次数 | 状态 |
| --- | --- | --- | --- |
| TikTok 资料／作品／搜索 | monid 的 TikHub 同路径；另比较 Apify `/apidojo/tiktok-profile-scraper` 的作品／作者字段 | 公开品牌账号、固定英文关键词；每个用途 2–3 次 | NOT_RUN |
| X 资料／作品／搜索 | monid 的 TikHub 同路径；discover 比较其他上游 | 公开机构账号、固定英文关键词；每个用途 2–3 次 | NOT_RUN |
| 网页 markdown | discover 定位 `/web/scrape/markdown` 的真实 provider | 两个公开单页；2–3 次，不 crawl | NOT_RUN |
| Instagram | 资料接口；必要时 Apify `/apify/instagram-post-scraper` | 1 个接口 1 次，限制结果数 | NOT_RUN |
| YouTube | Apify `/streamers/youtube-scraper` | 1 个接口 1 次，限制结果数 | NOT_RUN |
| Facebook | discover 公开页面／资料接口 | 1 个接口 1 次，限制结果数 | NOT_RUN |
| LinkedIn | discover 公司资料接口优先，避免扩大到员工个人资料抓取 | 1 个接口 1 次，限制结果数 | NOT_RUN |

候选来源：[monid 官方社媒指南](https://monid.ai/blog/guides/best-social-media-scraping-api-2026)、
[网页服务说明](https://monid.ai/blog/guides/web-scraping-services-should-you-hire-it-out)。
公开页面价格和历史目录仅用于选样，不计作实测价格。

### 逐次必须记录的指标

每次保留：输入摘要、provider/endpoint、runId、HTTP 与业务状态、monid 返回的最终 cost、
初始请求耗时、取回最终结果的端到端耗时、轮询次数、返回条数，以及原始响应 UTF-8 字节数。
异步初始确认大小与最终结果大小分别记录，不把小型 202 确认当完整结果。

字段逐项检查：精确粉丝数、绝对发布时间（Unix 秒／毫秒或带时区日期）、播放／浏览、点赞、评论、分享／转发。
资料接口的作品字段记“不适用”，平台不提供的指标记“缺失”，不能补 0；缩写粉丝和相对日期不算精确值。
作品应核对真实作者、转发／合作作品、置顶和排序，避免用第一条直接推断最近活跃时间。

| 样本 | 实际 USD | 初始／端到端 ms | 初始／最终 bytes | 粉丝／绝对时间／播放互动 | 结果 |
| --- | --- | --- | --- | --- | --- |
| 本轮所有样本 | 未调用 | 未测 | 未测 | 未检查 | BLOCKED：缺少 monid 凭证 |

### 预算控制

先免费 discover/inspect 取得本账号单价、固定费、按条计费和可限制结果数的参数，再确定逐次最大预算。
总预留（含已发出但费用未确认的请求）不得超过 $1；不使用无限结果或无限 crawl。
每次优先保留最终 `cost`，同步 `billing` 的不同字段分别记录，不自行把最大值解释成实际扣款；
最终运行记录和前后余额共同核对。账户并发消费会影响余额差，无法归因时必须单独说明。
超时或扣费不明先查同一 run，禁止盲目重新发起。不能约束最高费用的候选标 BLOCKED，不冒预算风险。

## 4. 后续接入需要修改的位置（建议，未实施）

复用现有研究工具／BILL2／Vault，不新建供应商框架、调度服务或第二套账本。

| 位置 | 最小必要改动 |
| --- | --- |
| 供应商适配器 | `research/vendors/` 增加 monid；固定 provider+endpoint，转换现有字段白名单。支持同步／异步回执、真实上游状态、成本缺失和未知结果；不得让模型自由选购目录接口 |
| Runtime 分派与限制 | `research/runtime/subcall.ts`、`toolContext.ts` 目前写死 TikHub/Parallel/Firecrawl；增加 monid 分派、限流及超时处理，保留单写入／不重复付费语义 |
| `platform_secrets` | `platformSecrets/slots.ts` 和数据库表约束／读取与管理 RPC 增加 monid 槽，通过现有 Vault 读取；不把本机测试密钥写入源码或价格表 |
| `research_tools_config` | `vendors/types.ts`、`vendors/config.ts`、`toolsSettings.ts`、管理界面及配置 RPC 的供应商白名单增加 monid；逐用途钉住已验证线路，保留中国平台 TikHub |
| 新平台 | Facebook、LinkedIn 还需平台枚举、账号链接／ID 校验、数据归一化、工具输入和存储校验；单接口成功不代表可以启用完整对标能力 |
| 价格表 | 复用 `billing_provider_prices`，按 monid + 上游 + endpoint 区分证据和有效期；保留 monid 加价与 Graylum 倍率的区别，不能沿用 TikHub 直连价格 |
| 计费兼容 | `0255_research_tool_billing.sql` 等现有函数只允许三家；需新增迁移更新相关白名单。当前 units 固定上限为 1；按结果数＋固定费必须先解决预算冻结和回执结算映射，不能直接套用单次价格 |
| 验证 | 单独接入任务做密钥拒绝路径、配置校验、实际价格、重复／超时／异步恢复、字段缺失、响应大小与账务测试，再做 staging 行为验证 |

接入本身涉及密钥槽、数据库及计费边界，需单独实施 PR；本 ordinary 报告不授权或执行它们。

源码索引（相对本文件）：

- [供应商类型](../../../packages/api/src/services/research/vendors/types.ts)
- [线路配置](../../../packages/api/src/services/research/vendors/config.ts)
- [Runtime 分派](../../../packages/api/src/services/research/runtime/subcall.ts)
- [密钥槽](../../../packages/api/src/services/platformSecrets/slots.ts)
- [供应商价格](../../../packages/api/src/services/billingProviderPrices.ts)
- [配置 SQL](../../../packages/db/migrations/0254_research_tools_config.sql)
- [计费 SQL](../../../packages/db/migrations/0255_research_tool_billing.sql)
- [密钥 SQL](../../../packages/db/migrations/0259_platform_secrets.sql)

## 5. 风险与最终判断条件

1. **单一依赖**：统一 monid 钱包／网关会让多个平台同时受余额、限流和故障影响；继续保留现有直连能力。
2. **同一上游**：monid→TikHub 与 TikHub 直连不是互相独立的灾备；报价、支持和付款层增加一环。
3. **加价与单位**：按调用、按结果、固定费叠加差异很大；比较 Graylum 常用 20–30 作品场景，不能只比较 2 条小样本的总价。
4. **字段和语义**：精确粉丝、绝对时间、真实作者是对标刚需；缺失时不能开启对应对标资格。
5. **大小和耗时**：基线适配器响应上限 2 MiB；并行 PR #1143 正在评估 8 MiB，未当作已合并能力。
   monid 封装可能改变大小，异步耗时影响现有 Runtime 的超时和 32-call 预算，需要明确轮询是否算额外执行／费用。
6. **条款与平台变化**：SaaS 许可按 Owner 已确认事实处理；平台来源、保留／删除、可见字段及供应商价格仍可能变化。
7. **证据限制**：本轮尚无真实返回，任何供应商切换结论、可用率、速度排名、实际成本和字段通过率均 NOT_RUN。
   即使各 2–3 次成功，也只支持小样本技术判断，不代表长期 SLA 或全平台覆盖。

## 6. 交接

已完成：规则与当前线路核对、候选资料、接入改动点和预算／证据口径。
下一步：取得 Owner 指定账户的本机凭证，inspect 后在 $1 内执行逐次实测，补充原始回执摘要及最终线路建议。
阻塞：monid 密钥的本机位置待 Owner 提供；没有发起 monid 付费请求。
验证：文档链接、差异及凭证泄漏检查待提交前执行；CI 与机器人审查以 PR 最新记录为准，不预先记 PASS。
