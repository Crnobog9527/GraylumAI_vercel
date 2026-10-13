# PUBLISH-MONITOR 开工前实测记录：Post for Me（2026-10-13）

**结论（2026-10-13 最终）**：Post for Me 必须付费订阅才能拿到密钥，1 美元预算内做不了，先停下报告总控；
之后 Owner 按选项 A 自己订阅 1 个月 10 美元标准套餐并配置密钥，我做了只读真实调用（第 4 节），没有发布任何内容。
**花费：10 美元套餐月费（Owner 支付，测完当月取消）；实测调用没有额外费用。**
已实测：接口连通、错误格式、限流、授权链接、X 和 YouTube 读取；未实测：其余 7 个平台、授权失效、发布、读取是否计费和超额自动升级。
第 1–3 节是公开文档、条款和开源代码的核对；第 4 节是 Owner 订阅后的只读真实调用结果，没有实测的项目在第 4.4 节逐项标出。

## 1. 为什么停下

Post for Me 是开源的（[DayMoonDevelopment/post-for-me](https://github.com/DayMoonDevelopment/post-for-me)，
本次读取 commit `4549e8f5`，2026-10-11）。代码证据：

| 事实 | 证据（仓库内路径） |
| --- | --- |
| 生成 API 密钥前检查团队有没有 Stripe 上"生效中"的订阅，没有就返回 "You must have an active subscription to create an API key" | `dashboard/app/routes/_protected.$teamId.$projectId.keys/route.action.ts` |
| 不提供试用（代码注释 "we don't offer trials"） | `dashboard/app/routes/api.stripe.webhook/.server/subscription-lifecycle-tracking.ts` |
| 读作品数据（feeds）还要求密钥属于新版套餐，否则 401 "requires new_pricing plan" | `api/src/auth/auth.guard.ts` |
| 公开价格页只有一档：10 美元/月，含 1,000 次成功发布、作品数据和分析；没有免费档 | [价格页](https://www.postforme.dev/pricing)（2026-10-13 读取） |

所以最少要订 1 个月 10 美元才能拿到密钥，超过 Owner 批准的 1 美元。按任务要求停下，已发给总控请 Owner 决定。

## 2. 从开源代码核对到的能力（未实测，以代码为准，线上行为可能不同）

### 2.1 读作品数据

- 接口：`GET /v1/social-account-feeds/{social_account_id}?expand=metrics&limit=1..100&cursor=...`，鉴权 `Authorization: Bearer <key>`。
- **没有日期参数**，只能翻页往回读；每条作品带 `posted_at`，可以自己按日期筛"近 30 天发布的作品"。
- 指标是**读取时的累计值**（作品生命周期总数），不是每日数值；Post for Me **不保存历史快照**，也没有账号级粉丝数、每日趋势接口。
  "90 天趋势"只能由 Graylum 每天自己存快照，从用户连接那天开始积累，不能回补连接之前的每日变化。
  例外：Pinterest 同时返回 `90d` 和 `lifetime` 两组数；Facebook 按发布日起 90 天窗口取 insights，最多回看 2 年。
- 只能读**用户自己授权连接的账号**；没有读别人公开账号的接口。Gold 的"对标账号监控"不能靠 Post for Me，要用 TikHub（RESEARCH-TOOLS）。
- 用户授权时 `permissions` 里要包含 `feeds`，否则读不到作品数据（只读数据时只请求 `feeds`，发布权限另行授权）；接口本身不检查有没有 feeds 权限，缺权限时表现为数据缺失或空列表。

| 平台 | 每页最多 | 主要指标字段（代码里的名字） | 注意 |
| --- | --- | --- | --- |
| TikTok（普通连接） | 20 | `view_count, like_count, comment_count, share_count` | 只有基础 4 项 |
| TikTok Business | 20 | `video_views, likes, comments, shares, favorites, reach, average_time_watched, full_video_watched_rate, new_followers, profile_views` 等 | 是单独的平台值 `tiktok_business`，授权范围更大 |
| Instagram | 25 | `views, likes, comments, saved, shares, reach, total_interactions, follows, profile_visits` 等 | 只支持 Business/Creator；按 Reels/快拍/普通帖字段不同；部分指标最多延迟 48 小时 |
| Facebook | 请求指标时**最多 10 条/页** | `reach, media_views, reactions_*, video_views*, video_avg_time_watched, comments, shares` 等 | 只支持 Pages |
| X | 100 | `public_metrics`（impression/like/reply/retweet/quote/bookmark）、`organic_metrics`、`non_public_metrics` | 非公开指标受 X 授权限制 |
| Threads | 25 | `views, likes, replies, reposts, quotes, shares` | — |
| LinkedIn | LinkedIn 默认页大小 | `impressionCount, likeCount, commentCount, shareCount, clickCount, videoView` 等 | **只有公司主页有数据**，个人主页没有 |
| Pinterest | 25 | `impression, save, pin_click, outbound_click, video_views` 等，分 `90d` 和 `lifetime` | — |
| Bluesky | 50 | `likeCount, replyCount, repostCount, quoteCount` | **没有浏览量** |
| YouTube | 50 | `views, likes, comments, shares, estimatedMinutesWatched, averageViewDuration, subscribersGained/Lost` 等 | 用 YouTube Analytics，需要 `yt-analytics.readonly` |

### 2.2 失败表现（对复盘影响最大）

- 除 YouTube 外，各平台代码在供应商报错时**吞掉错误、返回空列表**（例如 `api/src/tiktok/tiktok.service.ts` 的 catch 返回 `posts: []`）。
  也就是说"没有作品"和"授权失效 / 平台出错"在接口上可能长得一样。Graylum 不能把空列表当成"这周没发内容"，要和上一次成功读取比较、标为"未取到"。
- YouTube 授权失败返回 401（提示重新连接），账号被封返回 403。
- 账号状态只按"有没有 token"算 connected/disconnected；用户在平台上撤销授权后，Post for Me **不会自动标成 disconnected**。
- Webhook 事件：`social.post.created/updated/deleted`、`social.post.result.created`、`social.account.created/updated`。
  签名方式是请求头 `Post-For-Me-Webhook-Secret` 里放共享密钥（**不是 HMAC 签名**），超时 1 秒，失败最多重试 8 次。

### 2.3 授权流程

- `POST /v1/social-accounts/auth-url`，参数 `platform`、`external_id`（可放 Graylum 用户编号的不透明映射）、`permissions`、
  `platform_data`（LinkedIn 个人/公司、Instagram 走 Instagram 或 Facebook 登录、X 的 OAuth1/2、Bluesky 用 handle + app password）。
- 用 Quickstart（Post for Me 自己的平台开发者应用）时：用户授权页显示的是 **Post for Me 的应用名**；不能自定义回跳地址，
  回调先到 Post for Me 的后台，再跳到项目设置的地址，带 `isSuccess`、`accountIds`、`error`。
  白标（用自己的平台开发者应用）才显示 Graylum，但要自己申请 9 个平台的开发者应用和审核。
- 断开（`POST /social-accounts/{id}/disconnect`）只清 token、保留历史；删除（`DELETE /social-accounts/{id}`）才删连接、未发的草稿和发布结果。

### 2.4 计费和限流

- 只有**成功发布**计数，每个目标平台算一次；失败不算。**读作品数据不计数、不另收费**（代码里没找到任何对 feeds 的计量）。
- 超出套餐条数**不会拦截请求**，而是在下一个计费周期**自动升级套餐**（代码 `trigger/process-usage-limits.ts`）：
  1k=$10、2.5k=$25、5k=$50、10k=$75、20k=$150、40k=$300、100k=$500、200k=$1000；80/90/95% 时发邮件提醒。
  这和价格页"不会自动加价"的说法**不一致**，要以书面答复或后台实际为准；在得到答复前，Graylum 必须自己限制每月发布总数。
- 请求限流：每个密钥每秒 5 次、每分钟 40 次（`dashboard/app/lib/.server/unkey.constants.ts`）；超限返回什么、有没有 `Retry-After` 代码里看不到，要实测。
- 上传的发布素材放在 Post for Me 的公开存储桶，超过 1 天且没有被排期帖子引用的文件每小时清理一次。

### 2.5 后台"Enable"按钮和 Redirect URL（开源代码，2026-10-13 补）

- Quickstart 项目（`is_system`）的平台设置页对每个平台显示"Enable"：点下去只是把 **Post for Me 自己的共享开发者应用**凭证复制到本项目
  （`dashboard/app/routes/_protected.$teamId.$projectId.setup.system.$provider._index/route.action.ts`，从 `system_social_provider_app_credentials` 复制）。
  **不需要填我们自己的 client ID/secret，也不需要我们向平台申请审核**；用户授权页显示 Post for Me 的应用。非 Quickstart 项目才显示"Get Started"，要填自己的应用凭证。
- 列表里的平台：facebook、instagram、instagram_w_facebook、youtube、x、x_oauth2、pinterest、linkedin、threads、tiktok、tiktok_business。
  Bluesky 不在列表里，因为它不用 OAuth（账号 handle + 应用专用密码），所以显示为已就绪。
- Redirect URL 留空时，授权完成后停在 Post for Me 后台自己的结果页；填了才跳回我们的地址（`dashboard/app/lib/.server/social-accounts/oauth-callback-response.ts`）。
  **测试阶段可以留空**；Graylum 实施 PR-2 接回调时再填 staging 地址。
- 后台有"Accounts → Connect"页面，可以直接连接测试账号并勾选 `feeds` 权限，不必通过 API 生成授权链接。

## 3. 条款核对（2026-10-13 读取公开页面，转述，不是法律意见）

| 问题 | 公开条款怎么写 | 结论 |
| --- | --- | --- |
| 能否用于给用户做分析、嵌入付费 SaaS | [服务条款](https://www.postforme.dev/terms)（2026-03-03 版）没有禁止，也没有明确许可；另有官方[多用户 SaaS 接入指南](https://www.postforme.dev/resources/multi-user-applications) | 没有明文禁止，按"需要书面确认"处理 |
| 转售 / 展示数据 | 没有单独条款；禁止超限、抓取、滥用 API、逆向；只能用其名称说明集成 | 不转售原始数据给第三方；只在本人账户里展示本人作品数据 |
| 计费口径 | "每条发往社媒平台的 post 计入账单"；价格可提前 30 天通知后调整 | 与代码一致（按成功发布计数） |
| 保留期 | 条款没写；[隐私政策](https://www.postforme.dev/privacy)写删除账户后项目数据和排期任务 30 天内清除，账单记录按法律保留；没写数据所在地区、没提 DPA | 接入 DATA-ERASURE 附录 C，删除以"申请 + 回执"记录，不承诺立即清除 |
| 平台规则 | 帖子受各社媒平台条款约束；平台删帖、限流、封号不负责 | 用户要遵守各平台规则；YouTube 等平台的数据使用规则要在实施时逐项核对 |
| 责任上限 / 可用性 | 赔偿上限为 100 美元或已付金额中较高者；不保证不间断 | 不对用户承诺发布一定成功或数据一定及时 |
| 适用法律 | 美国特拉华州 | — |

### 3.1 客服书面答复（Owner 此前询问，Post for Me 客服 Matt，2026-10，经总控转达）

| # | 答复 | 和代码是否一致 | 影响 |
| --- | --- | --- | --- |
| 1 | 单个文件最大 5GB，没有其他大小、时长、格式限制说明 | 代码未核对 | 各社媒平台自己的格式和时长限制仍然适用，发布前按平台校验 |
| 2 | 媒体在帖子成功发布后自动删除；发布失败可能暂时保留，帖子处理完成后最终都会删除 | 代码是每小时清理一次超过 1 天、且没被排期帖子引用的文件（`trigger/supabase-media-cleanup.ts`），大体一致 | 失败的媒体可能留存约 1 天或更久 |
| 3 | `media_url` 是公开地址，拿到链接的人都能看，必须公开供平台抓取；目前不能设置过期 | 一致（公开存储桶 `post-media`） | **隐私**：用户还没发布成功的素材在公开链接上会留存一段时间 |
| 4 | 目前没有删除媒体的 API（对方说可以考虑添加） | 一致（代码里没有删除媒体的接口） | **注销删除**：我们删不掉已上传的素材，只能等对方自动清理 |
| 5 | 目前存储媒体不另收费 | 一致（代码里没找到存储计费） | 计费只按成功发布 |
| 6 | 失败的帖子可以用同一 `media_url` 重试，但不保证媒体还在，最安全是重新上传 | — | 重试一律重新上传 |

## 4. 真实调用实测（2026-10-13，Owner 订阅标准套餐后，只读，不发布）

环境：Owner 的 Post for Me 项目（Quickstart），已 Enable：Instagram、Instagram (Facebook Login)、LinkedIn、Threads、TikTok、X OAuth 2.0、YouTube、Bluesky；
Redirect URL 留空。脚本 `postforme-probe.mjs`，北京时间 16:13–16:15。

### 4.1 不连账号的接口（PASS）

| 调用 | 结果 |
| --- | --- |
| `GET /v1/social-accounts`、`/social-posts`、`/social-post-results`、`/webhooks` | 全部 200，返回 `{data:[], meta:{total, offset, limit:50, next}}`；耗时 0.5–2.9 秒 |
| 错误密钥 | 401，`{meta:{requestId}, error:{code:"err:frontline:client:invalid_key", message}}`（网关返回，格式和业务接口不同） |
| 读一个不存在的账号的作品 | **500** `{"statusCode":500,"message":"Internal server error"}`，不是 404 —— 不能靠状态码区分"账号不存在"和"服务出错" |
| `limit=1000` | 400，`{message:["limit must not be greater than 100"], error:"Bad Request", statusCode:400}` |
| 普通响应头 | `x-ratelimit-limit: 5`、`x-ratelimit-remaining`、`x-ratelimit-reset`（Unix 秒） |

### 4.2 限流（PASS）

连续 45 次 `GET /social-accounts`（顺序发，加上前面 7 次）：第 38 次起返回 **429**，
`{meta:{requestId}, error:{code:"err:frontline:client:rate_limited", message}}`，带 `retry-after`（秒）和 `x-ratelimit-limit: 40`，
`x-ratelimit-reset` 落在整分钟。**每分钟 40 次、按整分钟窗口**得到实测确认；每秒 5 次的头存在，顺序请求没有触发。

### 4.3 生成授权链接（PASS）

`POST /v1/social-accounts/auth-url`（当时请求的是 `["posts","feeds"]`，链接没有被打开、没有授权；脚本此后改为只请求 `feeds`）：YouTube 返回 201，链接指向 `accounts.google.com`；X 返回 201，链接指向 `x.com`。
链接本身没有记录（属于一次性授权地址）。

### 4.4 连接账号后读作品数据（Owner 在后台自己连接，勾选 posts + feeds；北京时间 16:15–16:18）

报告里不写账号名和平台用户编号，用"Owner 的 X 测试账号""Owner 的 YouTube 测试账号"代称；原始输出只留在本机，不入库。

**Owner 的 X 测试账号（PASS，有发现）**

| 项目 | 结果 |
| --- | --- |
| 读取 | `expand=metrics&limit=100` 一次 200，95 条，约 3.9 秒；`limit=20` 翻页 5 页（20/20/20/20/15），游标正常，最后一页 `has_more=false` |
| 字段 | 每条都有 `caption, media, metrics, platform, platform_account_id, platform_post_id, platform_url, social_account_id` |
| **发布时间** | **95 条全部没有 `posted_at` 字段**（接口说明里有这个字段，但 X 线路实际不返回） |
| 时间范围 | 用 X 帖子编号自带的时间戳推算：最早 2026-09-04，最新 2026-10-03；近 30 天 72 条，近 90 天 95 条。95 条是否就是全部帖子、X 线路最多能往回读多少，这个账号太新，测不出上限 |
| 指标 | 95 条都有三组：`public_metrics`（retweet/reply/like/quote/impression/bookmark）、`organic_metrics`（impression/like/reply/retweet/url_link_clicks/user_profile_clicks）、`non_public_metrics`（impression/url_link_clicks/user_profile_clicks）；数值为 0 的字段照常返回 0，不是空 |
| 不带 `expand=metrics` | 200，没有 `metrics` 字段，约 1 秒（比带指标快） |
| 更新频率 | 每次调用实时向 X 读取（代码证据），本次没有隔天对比，没测到 X 自己的数据延迟 |

**Owner 的 YouTube 测试账号（部分 PASS，有发现）**

| 项目 | 结果 |
| --- | --- |
| "空频道" | 实际返回 **1 条视频**（发布于 2026-09-14，有 `posted_at`、`platform_url`、1 个媒体、`platform_data`），可能是 Owner 不记得的旧上传或非公开视频；没能测到"完全没有内容"时的返回 |
| 指标 | 只有 `views, likes, comments, dislikes` 四项，全是 0；代码里写的观看时长、新增订阅等 YouTube Analytics 字段**没有返回**（可能是新频道没有分析数据，需有数据的频道复测） |
| **间歇 500** | 第一次读取 200；紧接着连续 6 次（不同 `limit`、带不带指标）都返回 500 `Internal server error`；约 1 分钟后再读又是 200。账号状态一直是 connected。原因从外部看不到（代码里 YouTube 每次读取都会先刷新授权，非授权类错误统一变成 500） |

**未实测**：Instagram、Facebook、LinkedIn、Threads、TikTok、TikTok Business、Pinterest、Bluesky（Owner 没有这些平台的账号）；
授权失效时的真实返回；读作品数据是否真的不计费、超额是否真的自动升级（本次没有任何发布，只有代码证据）；发布（不在本次范围）。

## 5. 测试脚本用法

脚本 [`postforme-probe.mjs`](postforme-probe.mjs) 只调用读接口和"生成授权链接"（只请求读数据权限 `feeds`，不请求发布权限），代码里写死拒绝发布接口；不打印密钥、账号编号、作品文字和素材地址（按平台名找账号，编号只在脚本内部使用）。
`accounts` 给每个账号一个稳定的选择标记（平台 + 账号编号的不可逆短哈希，如 `x#3fa9c1d2`）和遮挡后的名字提示，`feed` 用这个标记指定账号，
增删账号不会让标记指向别的账号；
Bluesky 要用账号 handle 和应用专用密码连接，脚本不接收任何密码：由 Owner 在 Post for Me 后台 Accounts → Connect 自己连，连好后再用 `accounts` / `feed` 读取。
`auth-url` 的平台可以带连接方式：Instagram 必须写 `instagram:instagram` 或 `instagram:facebook`，LinkedIn 默认 `organization`。
`auth-url` 把一次性授权链接写进本机 `~/.graylum/tmp/`（仅本人可读，不进仓库、不打印），Owner 从那个文件打开链接。

```bash
node docs/launch/evidence/publish-monitor-20261013/postforme-probe.mjs accounts
```

```bash
node docs/launch/evidence/publish-monitor-20261013/postforme-probe.mjs auth-url tiktok
```

```bash
node docs/launch/evidence/publish-monitor-20261013/postforme-probe.mjs feed x#<accounts 输出的标记> 3
```

授权链接由 Owner 本人在浏览器里用自己的测试账号点开（需要登录平台，AI 不代登录）。每个平台记录：字段、最早一条作品日期、条数、耗时、错误。

## 6. 花费

| 项目 | 金额 |
| --- | --- |
| Post for Me | 10 美元标准套餐月费（Owner 自己订阅，测完当月取消）；实测调用本身没有产生额外费用（只读、没有发布） |
| 其他供应商 | 0 美元（没有调用 TikHub） |
