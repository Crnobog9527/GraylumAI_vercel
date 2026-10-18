# RESEARCH-TOOLS：monid 海外数据供应商评估（2026-10-18）

> 状态：**19 次实测完成；供应商选择建议，尚未接入产品**。
> 本 PR 为 ordinary 文档变更，不修改产品代码、数据库、密钥槽、价格表或 staging 配置。
> Owner 于 2026-10-18 决定将 monid 加入供应名单，并确认已邮件取得用于 SaaS 的条款许可。
> 许可是 Owner 提供的事实，本次未重新查阅邮件；中国平台继续使用 TikHub。

## 1. 建议结论

| 线路 | 推荐 | 判断依据与限制 |
| --- | --- | --- |
| X 资料、作品、关键词 | **后续接入优先改走 monid / AnyAPI**，固定本次 lynx 线路 | 六次均返回数据，资料精确格式粉丝、40 条作品及 40 条搜索的时间／播放互动完整；按公开 $0.001/次参考价，单次费用低 78%、55%、40%。不是同机直连速度胜出结论 |
| TikTok 资料 | **建议改走 monid / AnyAPI bison** | 2/2 取得粉丝整数，每次 $0.0004；相对 $0.001 参考价低 60%。整数格式不等于独立验证粉丝真实准确 |
| TikTok 关键词 | **建议改走 monid / AnyAPI bison 的普通检索（不要求 US 地区筛选）**；对标仍需资料调用 | 2/2 各 20 条，绝对时间和播放／赞／评／分享均齐，每次 $0.0006；40/40 缺作者粉丝，不能单次完成粉丝筛选 |
| TikTok 作品 | **继续 TikHub 主线，monid 留作候选** | flamingo 的 NASA 0 条（免费）、Duolingo 20 条；第三次换 quokka 可取 NASA 34 条，但粉丝全缺且两条上游的字段一致性不同。不适合立即统一切换 |
| 网页 markdown | **继续 Firecrawl 主线；monid / Context.dev 作为后续按次候选** | 两页均成功、每页 $0.002533；是否便宜取决于 Firecrawl 套餐。未做复杂 JS／反爬或两家同 URL 付费对照，不能宣称质量或速度更好 |
| Instagram | **建议用 monid 补充账号资料能力** | 1 次返回 NASA 资料及粉丝 104,381,644，$0.001；没有测试作品接口，不解锁完整对标 |
| YouTube | **维持现有受限能力，暂不替换／启用完整对标** | 1 次 30 视频、$0.0008，但只有浏览数，无赞评／粉丝；createdUtc 与相对日期精确回推吻合，不能作为原始绝对发布时间证据 |
| Facebook、LinkedIn | **建议用 monid 新增基础页面／公司资料查询** | 各 1 次返回资料与粉丝数，$0.0012／$0.0011；还没有作品、搜索或完整对标验证，Facebook 候选建议不自行取代原 Bright Data 计划 |

以上都是**实施建议**，不是已批准的切换或已上线能力。保留 TikHub 直连；不能把 monid 转售 TikHub 当独立容灾。

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
| Facebook、LinkedIn | 研究工具平台枚举没有这两个平台 | monid 目录可用也不能只改后台配置启用；Master Plan 另有 Bright Data 海外备用／Facebook 计划，未实施状态不能算现有接口 |

TikHub 的当前成本契约是每个成功调用 1 call × 发起时冻结的官方接口标价，响应不提供美元成本；
Firecrawl 使用供应商 usage × 配置单价。这里没有读取在线价格表，**不得把历史单价当成本次报价**。
具体参考 [RESEARCH-TOOLS 任务说明](../tasks/RESEARCH-TOOLS.md)。

## 3. 本次实测与价格比较

### 方法与预算

2026-10-18 北京时间约 19:31–19:34，使用 Owner 指定 monid 账户。
免费 discover/inspect 确认实际 schema 后，固定 AnyAPI route，只执行明确 PER_CALL 的分支；
没有采用顶层最低价直接猜价格（例如 LinkedIn 顶层 amount=0，但 quokka 实际 $0.0011）。
网页调用固定 Context.dev 的单页 markdown，正文优先、不含图片、maxAgeMs=0、上游超时 30 秒，不 crawl。
每次先记预算预留 $0.02（19 次累计预留 $0.38），费用未知时不释放；没有重复 POST 或自动付费重试。
TikTok 第三次是基于 flamingo not_found 的**明确换上游诊断**，不是无依据重试。

**19 次 run 的最终 cost 合计 $0.015106，钱包最终下降 $0.015106，最终 held=$0；低于 $1 上限。**
其中 18 次返回数据，1 次 HTTP/上游 200 但 found=false、cost=$0。
末次完成后第一次余额读取落后最后一笔 $0.0008；随后只读余额已追平，没有重新发起业务请求。
每次最终成本来自 `GET /v1/runs/:runId` 的 `cost.value` USD，未把初始 billing 的 calculated/actual/reported 三字段混作扣款。

[逐次脱敏回执及字段样本](monid-supplier-evaluation-20261018.receipts.json) 随本报告提交。
完整响应与测试脚本仅保留本机 `~/.graylum/monid-evaluation-20261018/`；未提交密钥、余额绝对值、个人简介或头像签名链接。
公开 JSON 只保留明确选定的机构／品牌测试输入、数值／时间／布尔字段及结构；响应中的用户／帖子 ID、账号名、显示名、内容标题均已删除。另保留 monid runId、请求、测量口径、cost 和响应摘要哈希用于核对。
哈希用于绑定保留的响应，不能单独证明供应商结果真实；原始 UTF-8 字节大小在读响应时直接测得。

### 实际接口、输入与固定上游

| 样本前缀 | provider / endpoint | 固定 route／输入 |
| --- | --- | --- |
| tt-profile | anyapi `/tiktok.profile` | bison；nasa、duolingo |
| tt-posts | anyapi `/tiktok.profile_videos` | 前两次 flamingo：nasa、duolingo；第三次 quokka：nasa |
| tt-search | anyapi `/tiktok.search_keyword` | bison；space exploration、language learning；默认 relevance/不限发布日期 |
| x-profile | anyapi `/twitter.profile` | lynx；NASA、duolingo |
| x-posts | anyapi `/twitter.user_tweets` | lynx；NASA、duolingo；limit=20 |
| x-search | anyapi `/twitter.search` | lynx；space exploration、language learning；limit=20 |
| instagram | anyapi `/instagram.profile` | pangolin；nasa |
| youtube | anyapi `/youtube.channel_videos` | badger；@NASA，sort=latest |
| facebook | anyapi `/facebook.profile` | giraffe；facebook.com/NASA |
| linkedin | anyapi `/linkedin.company` | quokka；linkedin.com/company/nasa |
| web | context.dev `/web/scrape/markdown` | example.com、www.python.org/about/ |

### 每次费用、耗时、响应大小

耗时依次为“初始请求 / 客户端拿到最终结果 / 供应商 reported completedAt−createdAt”，单位 ms。
社媒初始请求全部是 202；网页两次为同步 200。客户端耗时包含每轮 4 秒主动轮询等待，
不能拿它当纯供应商处理时间。除 Facebook 2 次 GET，其余各 1 次 GET；不做业务重发。
字节数是“初始 POST 响应 / 最终 GET 响应”，包括 monid JSON 封装，不是压缩传输大小。

| 样本 | 实际 USD | 初始 / 端到端 / 服务端 ms | 初始 / 最终 bytes | 条数 | 业务结果 |
| --- | --- | --- | --- | --- | --- |
| tt-profile-1 | 0.000400 | 1200 / 5840 / 2196 | 1409 / 2513 | 单资料/页面 | 数据返回 |
| tt-profile-2 | 0.000400 | 1201 / 5779 / 1940 | 1409 / 2458 | 单资料/页面 | 数据返回 |
| tt-posts-1 | 0.000000 | 1210 / 5801 / 4157 | 1258 / 1652 | 0 | 无数据（not_found） |
| tt-posts-2 | 0.000600 | 1362 / 6095 / 2966 | 1258 / 35673 | 20 | 数据返回 |
| tt-search-1 | 0.000600 | 1239 / 6281 / 2238 | 1324 / 45461 | 20 | 数据返回 |
| tt-search-2 | 0.000600 | 1351 / 6072 / 2318 | 1324 / 39915 | 20 | 数据返回 |
| x-profile-1 | 0.000220 | 1054 / 5626 / 2023 | 1082 / 1929 | 单资料/页面 | 数据返回 |
| x-profile-2 | 0.000220 | 1072 / 5655 / 1999 | 1082 / 1910 | 单资料/页面 | 数据返回 |
| x-posts-1 | 0.000450 | 1015 / 5770 / 2261 | 931 / 16120 | 20 | 数据返回 |
| x-posts-2 | 0.000450 | 1073 / 5667 / 2526 | 931 / 13260 | 20 | 数据返回 |
| x-search-1 | 0.000600 | 1066 / 5811 / 2615 | 1122 / 21570 | 20 | 数据返回 |
| x-search-2 | 0.000600 | 973 / 5713 / 2838 | 1122 / 19820 | 20 | 数据返回 |
| instagram-1 | 0.001000 | 950 / 5529 / 2035 | 1181 / 2832 | 单资料/页面 | 数据返回 |
| youtube-1 | 0.000800 | 941 / 5532 / 3235 | 849 / 9550 | 30 | 数据返回 |
| facebook-1 | 0.001200 | 1018 / 9926 / 4957 | 728 / 2524 | 单资料/页面 | 数据返回 |
| linkedin-1 | 0.001100 | 983 / 5565 / 2898 | 1069 / 4305 | 单资料/页面 | 数据返回 |
| web-1 | 0.002533 | 3413 / 3987 / 2356 | 3290 / 3524 | 单资料/页面 | 数据返回 |
| web-2 | 0.002533 | 4015 / 4604 / 2987 | 8875 / 9119 | 单资料/页面 | 数据返回 |
| tt-posts-3 | 0.000800 | 1181 / 6124 / 3398 | 1258 / 61039 | 34 | 数据返回 |

本轮最大完整响应 61,039 bytes，小于基线 2 MiB 限制；不代表其他账号或关键词也满足。
网页正文分别 1,342 和 4,187 bytes，标题为 Example Domain、Welcome to Python.org，均为非空可读正文。
两页没有原始发布时间元数据，记为缺失，不生成日期。没有付费测试其他网页线路。

### 字段完整性与实际语义

| 类别 | 粉丝数 | 发布时间绝对值 | 播放／互动 |
| --- | --- | --- | --- |
| TikTok 资料 | 两账号均为整数；2,101,385、18,265,387 | 资料里的 createdUtc 是账号创建时间，**不适用**于作品发布时间 | likes 是账号总获赞，不能当单篇互动 |
| TikTok 作品 flamingo | 成功 20/20 含 authorFollowers | 成功 20/20 含 Unix 秒 createdUtc | 成功 20/20 含 views/likes/comments/shares；NASA 无数据不可算字段通过 |
| TikTok 作品 quokka | 34/34 authorFollowers=null，需另取资料 | 34/34 含 Unix 秒 | 34/34 播放／赞／评／分享齐全；34 条超过 Graylum 单次 30 条上限，需要截断 |
| TikTok 搜索 | 40/40 authorFollowers=null | 40/40 含 Unix 秒 | 40/40 播放／赞／评／分享齐全 |
| X 资料 | 两账号整数 92,323,065、1,048,999 | 账号创建时间，作品日期不适用 | 作品互动不适用 |
| X 作品 | 40/40 不带粉丝，按现有 profile+posts 两次取数即可 | 40/40 Unix 秒 | 40/40 views/likes/replies/retweets 齐全 |
| X 搜索 | 40/40 含 authorFollowers | 40/40 Unix 秒 | 40/40 viewCount/likeCount/replyCount/retweetCount 齐全 |
| Instagram 资料 | 104,381,644，整数格式 | 作品日期不适用 | 没测作品，不能写成播放／互动通过 |
| YouTube 视频 | 无频道粉丝 | 30/30 数字 createdUtc，但不能认定原始精确日期 | 30/30 views；likes/comments 缺失，浏览数字精度也未独立核验 |
| Facebook 页面 | 28,000,000，整数格式但可能来自缩写／取整，精度未核验 | 页面 createdUtc 不能当作品日期 | likes=28,746,800 是页面获赞，作品播放互动未测 |
| LinkedIn 公司 | followerCount=7,140,962，整数格式 | 本接口无作品日期，记不适用 | 无作品互动，未测 |

AnyAPI TikTok 搜索本次 inspect schema 没有 region 参数，现有 TikHub 请求固定 region=US；本轮没有证明区域筛选等价。需要保留 US 限定的用途继续 TikHub，不能静默改变地域口径。X 搜索 inspect 的 queryType 默认 Latest，与现有请求一致。

TikTok Duolingo 首条 isPinned=true，时间 1749564234（2025 年），不能把置顶当最近一次发布。
X 作品接口包含 replies，必须按产品口径区分回复与原创；本轮未独立核对所有转推／原作者语义，不把返回条数直接当原创数量。
Duolingo profile 与 posts 的粉丝分别 18,265,387、18,266,569，说明不同端点／上游快照可能不一致；本次不以任何一项断言真实粉丝准确。

YouTube 首条 `publishedTime="3 days ago"`、`createdUtc=1792063937`；
其余 4 条 `1 month ago` 均为同一秒 `1789731137`。
这些分别是基准秒 `1792323137` 减 3 天、30 天；第二条 2 周前也与减 14 天完全吻合。
**据此推断**标准化时间由相对文本回推；未取得真实源发布时间，不满足精确绝对日期验收。
不能因字段类型是整数就启用 30 天活跃规则。此限制只针对本次 badger 线路，不泛化为 monid 全部 YouTube 接口。

### 与现有供应商的价格、能力比较

本次未执行 TikHub/Firecrawl 的配对业务请求，因此**无同时段速度、可用率、响应大小的两家排名**。
TikHub 官方价格目录读取未取得可解析 JSON；不绕过认证、不换用已登录网页，未取得账号专属价格。
本次也没有读取 staging 价格配置或 Firecrawl 账户套餐，不能把公开价替代当前冻结计费配置。

[TikHub 官方 TikTok 页面](https://tikhub.io/tiktok-api) 与
[X 页面](https://tikhub.io/twitter-api) 公布起价 $0.001/次。
以此**参考价**对照，monid TikTok profile=$0.0004、posts=$0.0006/0.0008、search=$0.0006；
X profile=$0.00022、posts=$0.00045、search=$0.0006。相对降幅只用于采购建议，不代表本账户实际节省已核实。
两家的资料+作品组合都需要按缺失粉丝情况另取资料；monid 的标准化 JSON 更易解析，但不证明内容更准确。

[Firecrawl 官方现价](https://www.firecrawl.dev/pricing)：单页 basic scrape=1 credit；
Hobby 年付展示 $16/5,000 credits，折合 $0.0032/页；Standard 年付展示 $83/100,000，折合 $0.00083/页。
这是套餐满额使用的摊销值，不是本账户的实际账单或固定边际价；未用完额度时意义不同。
monid Context.dev $0.002533/页比 Hobby 这个摊销值低约 20.8%，却约为 Standard 的 3.05 倍。
所以不建议统一替换 Firecrawl；按次消费、无需订阅可以作为小流量候选理由，复杂网页能力仍 NOT_RUN。

## 4. 后续接入需要修改的位置（建议，未实施）

复用现有研究工具／BILL2／Vault，不新建供应商框架、调度服务或第二套账本。

| 位置 | 最小必要改动 |
| --- | --- |
| 供应商适配器 | `research/vendors/` 增加 monid；固定 provider+endpoint，转换现有字段白名单。支持同步／异步回执、真实上游状态、成本缺失和未知结果；不得让模型自由选购目录接口 |
| Runtime 分派与限制 | `research/runtime/subcall.ts`、`toolContext.ts` 目前写死 TikHub/Parallel/Firecrawl；增加 monid 分派、限流及超时处理，保留单写入／不重复付费语义 |
| `platform_secrets` | `platformSecrets/slots.ts` 和数据库表约束／读取与管理 RPC 增加 monid 槽，通过现有 Vault 读取；不把本机测试密钥写入源码或价格表 |
| `research_tools_config` | `vendors/types.ts`、`vendors/config.ts`、`toolsSettings.ts`、管理界面及配置 RPC 的供应商白名单增加 monid；逐用途钉住已验证线路，保留中国平台 TikHub |
| 新平台 | Facebook、LinkedIn 还需平台枚举、账号链接／ID 校验、数据归一化、工具输入和存储校验；单接口成功不代表可以启用完整对标能力 |
| 价格表 | 复用 `billing_provider_prices`，按 monid + 上游 + endpoint + 固定 route 分支区分证据和有效期；保留 monid 加价与 Graylum 倍率的区别，不能沿用 TikHub 直连价格 |
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

## 5. 风险与尚未验证

- **单一依赖**：一个 monid 账户／钱包／网关故障会影响多个平台；保留现有供应商，不自动全量切换。
- **上游与加价**：AnyAPI 动物名不公开证明真实数据源彼此独立；monid 同时转售 TikHub。固定 route，按接口复核最终 cost；不能把目录最低 amount 当所有分支价格。
- **账务**：本轮只选按次接口，未验证按结果＋固定费、失败退款、超时扣款或长期费率。最终成本回执、钱包余额存在短暂更新时差；产品不能靠单次余额判断一笔费用。
- **数据精度**：整数格式不等于原始精确数值；YouTube 时间回推、Facebook 粉丝取整可能性、跨端点快照差异均需保留来源／缺失标记。
- **样本限制**：核心每用途 2–3 次、其他平台各 1 次。没有长期 SLA、复杂反爬、分页、20–30 条完整对标、所有作者／转发语义及所有字段准确性验证；没有其他 AnyAPI 上游自动回退测试。
- **Runtime 兼容**：当前 HTTP 默认 60 秒、响应上限 2 MiB；本次小响应通过不代表可以取消上限。PR #1143 仍 OPEN，不能当作已有 8 MiB 能力。
- **现有线路对照限制**：直连配对测速／字段实测 NOT_RUN；本报告不声称 monid 比现有供应商更快或更可靠。所有切换建议以明确通过本次样本和价格优势为基础，实际接入另做回归。
- **条款**：SaaS 条款按 Owner 已确认；本次没有新增对外承诺或扩大到中国平台，没有测试私有账号数据。

## 6. 验证与交接

实测完成：19 次业务 run，18 次有数据、1 次 not_found；monid 成本和最终钱包下降核对 PASS，预算 PASS。
报告与附带 JSON：19 个唯一 runId、18 次非空返回、美元求和／钱包核对、相对链接及已知密钥／token／签名链接扫描 PASS；git diff --check PASS。CI 和机器人结论记录于 PR。
不将准备稿 CI 的通过沿用为本次最终版本通过。
本 PR 交付报告、脱敏回执及 Master Plan 中 Owner 已确认决定的同步；下一步由总控评估供应商接入任务，按第 1 节优先级推进。没有修改 staging，没有实施供应商切换。
