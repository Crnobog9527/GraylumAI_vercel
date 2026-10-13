# PUBLISH-MONITOR 开工前实测记录：Post for Me（2026-10-13）

**结论：1 美元预算内无法做真实调用，实测已停下并报告总控，没有注册、没有付费。实际花费 0 美元。**
本记录只有公开文档、公开条款和开源代码的核对结果。所有真实调用项目都是 **NOT_RUN**，不能当作实测通过。

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
- 用户授权时要请求 `permissions: ["posts", "feeds"]`，否则读不到作品数据；接口本身不检查有没有 feeds 权限，缺权限时表现为数据缺失或空列表。

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

## 4. 还没验证（需要密钥后实测）

| 项目 | 状态 |
| --- | --- |
| 9 个平台的授权流程能否走通、授权页显示什么 | NOT_RUN |
| 每个平台实际返回的字段、空值和延迟 | NOT_RUN |
| 一个账号能往回读多少条 / 多久（有没有 30 天、90 天的实际上限） | NOT_RUN |
| 授权失效时的真实返回（空列表还是报错） | NOT_RUN |
| 429 的返回格式和 `Retry-After` | NOT_RUN |
| 读作品数据是否真的不计费；超额是否真的自动升级 | NOT_RUN（只有代码证据） |
| 发布（任何社媒账号） | 不在本次范围，发布属于对外发布，需 Owner 当次批准 |

## 5. 拿到密钥后怎么测（脚本已备好，未运行）

脚本 [`postforme-probe.mjs`](postforme-probe.mjs) 只调用读接口和"生成授权链接"，代码里写死拒绝发布接口；不打印密钥、不输出作品文字和素材地址。

```bash
node docs/launch/evidence/publish-monitor-20261013/postforme-probe.mjs accounts
```

```bash
node docs/launch/evidence/publish-monitor-20261013/postforme-probe.mjs auth-url tiktok
```

```bash
node docs/launch/evidence/publish-monitor-20261013/postforme-probe.mjs feed <social_account_id> 3
```

授权链接由 Owner 本人在浏览器里用自己的测试账号点开（需要登录平台，AI 不代登录）。每个平台记录：字段、最早一条作品日期、条数、耗时、错误。

## 6. 花费

| 项目 | 金额 |
| --- | --- |
| Post for Me | 0 美元（未注册、未订阅） |
| 其他供应商 | 0 美元（没有调用 TikHub） |
