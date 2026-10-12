# ANALYTICS 网站统计 · 实施方案（仅方案）

> 状态：方案，等 Owner 确认第 9 节的细节后才开工。本文件不写产品代码，不改任何平台设置，没有注册任何账号，没有读取密钥。
> 依据：Master Plan 第 2.1 节 2026-10-13“网站统计：Termly 同意弹窗、不自研统计、新增 ANALYTICS”决定；
> [SEO/GEO 规范](../SEO_GEO_SPEC.md) 第 9 节（渲染与性能）、第 11 节（对外操作规则）；
> [DATA-ERASURE 保留期和第三方清单](../../runbooks/DATA_ERASURE_RETENTION_CHECKLISTS.md)；收款现状见 #847 方案和 #856（银行卡订阅走 Stripe Managed Payments）。

## 0. 这次要做到什么、怎样算做完、不做什么

- **目标**：上线时能回答四个问题——人从哪里来（含 AI 推荐）、看了哪些公开页、多少人注册/完成定位/开始付款/付款成功、中国大陆来了多少人。
- **Owner 已定的边界（原话见 Master Plan 第 2.1 节）**：同意弹窗用 Termly、按 Termly 的规则来，不自研；不自研事件统计系统；中国大陆用户的统计用 Vercel Analytics；业务数字从现有数据库出报表；以后真不够用，先评估自托管现成开源工具（如 Umami）。
- **做完的标准**：第 7 节每个 PR 的验收都在 staging 上通过（GA4 实时报告看到事件、一次性密钥网址没有发出去、模拟欧盟访问时同意前不写统计 Cookie、付款成功只记一次、大陆网络下页面不被 Termly 卡住），公开页仍是静态渲染，Lighthouse 分数下降在第 5 节的限度内。
- **不做**：自研事件统计或埋点后台；Meta 像素和 Conversions API（第二步，Owner 投广告前再做）；隐私条款文字（Owner 用第三方工具生成，见第 8 节要写进去的点）；任何正式环境平台设置（逐项另批）。

以下第 1–7 节是**总控整理、本窗口细化的建议**，不是 Owner 已批准的细节；需要 Owner 拍板的列在第 9 节。

## 1. 现状（2026-10-13 核对代码）

| 项目 | 现状 |
| --- | --- |
| Vercel Speed Insights | 根布局 `apps/web/src/app/layout.tsx` 在 Vercel 生产模式部署里挂了 `<SpeedInsights />` |
| Vercel Web Analytics | `apps/web/package.json` 已装 `@vercel/analytics`，但**没有任何页面渲染 `<Analytics />`**，等于没开 |
| GA4、Termly、Meta | 代码里没有 |
| 首次来源（referrer、utm） | 数据库和代码都没有记录 |
| 带一次性密钥或个人信息的网址 | `/auth/callback?code=…`（登录/验证邮件回调）；`/reset-password`（密钥在 `#` 片段，页面已主动清掉）；`/verify-email?email=…`（**网址里带邮箱**）；`/login?redirect=…`、`/register` 可能带邀请码 |
| 付款成功 | `apps/web/src/app/api/stripe/webhook/route.ts` → `packages/api/src/services/stripeFulfillment.ts`；订单在 `payment_orders`，已有原子履约和 `fulfilled_at` |
| 账号资料 | `public.profiles`；注销时 `0191` 的清理把 email、nickname、last_ip 等置空，行保留 |

## 2. 各工具分工

| 工具 | 管什么 | 不管什么 |
| --- | --- | --- |
| **GA4** | 海外访客的公开页浏览、来源渠道（含“AI 推荐”）、四个关键事件、转化漏斗 | 中国大陆（实测上报地址被墙，见第 4 节）；应用页的页面浏览；任何个人信息 |
| **Vercel Web Analytics** | 全站访问总量对照（不用 Cookie）、中国大陆的访问量和主要来源 | 自定义事件（需 Vercel Pro，Owner 已决定上线前升级；升级前只看页面访问） |
| **数据库报表** | 注册数、定位完成数、付款笔数和金额（以这里为准）、按首次来源分组的注册和付费 | 访客浏览行为 |
| **Termly** | 同意弹窗、按地区的同意规则、Google Consent Mode v2 信号、统计/广告脚本按分类放行 | 统计本身 |
| **Meta 像素 + CAPI**（第二步） | 广告转化回传 | 第一步不做 |

## 3. 建议的具体做法

### 3.1 GA4

- **公开页**：记页面浏览。**应用页**（登录后的对话、定位、资料库、个人中心、后台，以及 `/auth/*`、`/login`、`/register`、`/verify-email`、`/reset-password`、`/forgot-password`）**不记页面浏览**，只记关键事件。用公开页白名单判断（复用 `apps/web/src/lib/seo` 的公开页列表），新页面默认不记。
- **关键事件**（GA4 推荐事件名优先）：

  | 事件 | 触发点 | 参数（只放这些） |
  | --- | --- | --- |
  | `sign_up` | 注册成功（邮箱验证完成或 Google 首次登录）| `method`：email / google |
  | `positioning_complete` | 用户确认定位最后一步 | 无 |
  | `begin_checkout` | 创建 Stripe 结账会话成功后、跳转前 | `currency`、`value`、`items[].item_id`（套餐代码，不放订单号） |
  | `purchase` | **服务器**在 Stripe webhook 履约成功后用 Measurement Protocol 上报 | `transaction_id`=我方订单编号、`currency`、`value`、`items[].item_id` |

- **付款成功只记一次**：只在这次 webhook 调用**真正把订单从未履约改为已履约**的那个分支里上报（重放、重复 webhook 走“已履约”分支，不再上报）；`transaction_id` 用 `payment_orders.id`，GA4 自己也按同一用户同一交易号去重（只对网页数据流有效）。上报失败只记日志、不重试、不影响履约——统计少一笔不动钱，金额以数据库报表为准。**不新建表**。
- **服务器上报怎么对上访客**：结账前浏览器把 GA 的 `client_id`（`_ga` Cookie 里的随机编号）和当前会话编号 `session_id`（`_ga_<衡量 ID>` Cookie 里）随创建结账请求带上，`purchase` 上报时一起带上，这样付款能归到发起结账那次访问的来源和渠道（Google 要求带 `session_id`，且在会话开始后 24 小时内发送；超过 24 小时才付款成功的，来源可能显示为“未分配”，金额仍以数据库为准）；**只有访客同意了统计才会有这个值**。没有 `client_id` 的订单不上报 GA（不编造编号，避免违背同意规则）。
- **这两个编号存哪里、多久删**：**不放进 Stripe metadata**，也不放进会被持久化的结账请求（现有链路会把整份请求存进 `payment_orders.checkout_request`、并把 metadata 复制到 Stripe 的订阅或付款记录，这些按账务期限保留，注销也不删）。改为在 `payment_orders` 新增两个可空列 `ga_client_id`、`ga_session_id`，只写在我们库里、不发给 Stripe：`purchase` 上报后（成功或失败）立即置空；没付款的订单由现有每日清理任务在 72 小时后置空；注销清理也置空。迁移和 PR-3 的首次来源迁移合在一起。
- **不发个人信息**：不发邮箱、昵称、用户编号、订单正文；不开 GA4 的 User-ID 和“用户提供的数据”；不开 Google 信号（Google Signals）。
- **动态路径去编号**：应用里带实例编号的路径（例如 `/positioning/[draftId]`、对话、资料库文档、分享页）不能把编号发出去。关键事件的 `page_location` 一律改成**路由模板**（如 `/positioning/[draftId]`），不发真实路径；Vercel Analytics 的 `beforeSend` 对非公开页同样把网址换成路由模板，或直接丢弃这些页面的访问记录（二选一在 PR-2 定，以不发编号为准）。
- **网址去参数**：所有上报都手动设置 `page_location` 和 `page_referrer`，去掉 `#` 片段和查询参数（`page_location` 保留 `utm_*`）。`page_referrer` **保留协议、域名和路径**（GA4 靠它的域名判断来源，“AI 推荐”渠道也靠它），只去掉查询参数和片段；站内页面之间跳转时的 referrer 同样只留协议、域名和路径，所以 `?code=`、`?email=` 不会带出去；应用页本来就不记页面浏览，双保险。
- **自定义渠道“AI 推荐”**：在 GA4 后台建自定义渠道组（Owner 操作或当次批准后由 AI 操作），来源正则匹配 `chatgpt.com|chat.openai.com|perplexity.ai|claude.ai|gemini.google.com|copilot.microsoft.com|chat.deepseek.com|kimi.moonshot.cn|kimi.com|doubao.com|yuanbao.tencent.com|grok.com|meta.ai`，排在“自然搜索”“引荐”前面。名单写在仓库里（`docs/` 一份），以后增减按名单改。
- **staging 和正式用不同的 GA4 媒体资源**（两个衡量 ID），staging 数据不混进正式报表。

### 3.2 首次来源写进账号资料（需要迁移）

- **记什么**：首次落地时的 `utm_source/medium/campaign/content/term`、referrer 的**域名**（不存完整网址）、落地路径（不带查询参数）、首次访问时间。每个值限长、只收白名单字段，服务端再校验一遍。
- **怎么带到注册**：首次落地时浏览器暂存（同意统计后才写本地存储；未同意的地区或拒绝的访客，只用注册那一刻页面本身的 referrer/utm，拿不到就记“未知”）；注册时随注册请求提交，服务端写入。
- **存哪里**：`public.profiles` 新增一列 `signup_attribution jsonb`（可空）。**理由**：一人一份、只写一次，现有资料表就够，不新建表；第 5 节“优先复用现有数据”。迁移只加可空列，新旧代码兼容，可重复执行。
- **注销和保留期**：注销清理（`account_erasure_local_cleanup` 及注销执行器里置空个人字段的那一步）同时把这一列置空；身份保护触发器同步放行。保留期 = 账号存续期间，注销即清。报表只用聚合数字。
- **报表**：后台现有统计页加“按首次来源的注册数 / 付费数”（复用现有统计接口，不新建报表系统）。

### 3.3 Vercel Web Analytics

- 在根布局加 `<Analytics />`，和现有 Speed Insights 一样只在 Vercel 生产模式部署渲染。`<Analytics />` 是动态注入脚本，Termly 的手动分类属性拦不住它：如果 O5 把它归为“统计”类，就用一个小的客户端组件等 Termly 返回“统计已同意”后才挂载（读取 Termly 提供的同意状态和变更事件，不自己判断地区）。它不用 Cookie，在 Termly 里登记为“统计”类还是“必要”类由 Owner 在 Termly 后台按 Termly 的分类规则定（第 9 节 O5）。
- 用 `beforeSend` 去掉网址里的查询参数（保留 `utm_*`），一次性密钥和邮箱不会进 Vercel。
- 脚本从本站 `/_vercel/insights/script.js` 加载。第 4 节只测了大陆能从 `vercel.com` 下载同款脚本（20/20），**没有测我们自己的域名和数据上报**；PR-2 验收要用大陆真实网络访问 preview 页面，确认报表里收到这次访问。
- 自定义事件（Pro 才有）：升级 Pro 后再加 `sign_up` 等同名事件，供大陆对照；升级前只看访问量和来源。

### 3.4 Termly

- **地区规则**（在 Termly 后台配置，Owner 操作）：欧盟/欧洲经济区/英国/瑞士 = 同意前不放行统计和广告；美国 = 默认放行、页脚和弹窗提供“不要出售或分享我的个人信息”入口，并尊重浏览器的 GPC 信号；其他地区按 Termly 默认。**Termly 是否自动识别 GPC 公开资料里没查到，开账号后要在后台确认**（第 9 节 O4）。
- **Google Consent Mode v2**：在 Termly 后台打开；页面在加载 GA 之前先写一段默认值（欧洲地区 `analytics_storage`、`ad_storage`、`ad_user_data`、`ad_personalization` 默认 denied），Termly 拿到同意后更新。
- **脚本怎么加载**：见第 4 节结论，推荐用 Termly 官方的**手动分类拦截**（`type="text/plain" data-categories="analytics"` 等），Termly 脚本异步加载；不选“自动拦截放在 head 最前面同步加载”。这是 Termly 文档里的正式做法之一，不是自研，但和“自动拦截”的默认推荐不同，需要 Owner 选（第 9 节 O1）。
- 应用内登录后的页面也加载同一个 Termly（弹窗只在首次出现），用户可在页脚“Cookie 设置”改选择。

### 3.5 不让公开页变成动态渲染（SEO 规范第 9 节）

- 统计和 Termly 脚本全部是写死在布局里的静态标签或客户端组件，**不读 Cookie、请求头、地区**来决定渲染内容，公开页继续静态生成/ISR。
- 不按地区在服务端决定是否输出脚本（会让页面变动态）；地区差异交给 Termly 自己判断。
- 每个实施 PR 都跑一次 `next build` 输出，确认公开页仍标为静态（○ 或 ●），并在 PR 里贴对比。

## 4. 风险实测：Termly 和统计地址在中国大陆的可达性

**方法**：Globalping 公开探测网络（只读、匿名、不注册账号），从中国大陆 20 个节点（电信 AS4134×5、联通 AS4837×5、移动 AS9808×4、腾讯云 AS45090×3、阿里云 AS37963×3）发 HTTPS GET；另测 16 包 ping。时间 **2026-10-12 18:55 UTC（北京时间 10-13 凌晨 2:55，非晚高峰）**。原始数据（不含任何密钥或个人信息）在 [evidence/analytics-termly-cn-20261013/](../evidence/analytics-termly-cn-20261013/)。

| 目标 | 成功 | 总耗时中位数 / 90 分位 / 最大（毫秒） | 说明 |
| --- | --- | --- | --- |
| `app.termly.io/embed.min.js` 第 1 轮 | 19/20 | 628 / 1303 / 5812 | 1 个节点 DNS 超时；1 个节点 DNS 用了 5.2 秒 |
| 同上 第 2 轮 | 20/20 | 615 / 870 / 983 | |
| `app.termly.io/resource-blocker/<假编号>` | 20/20 | 696 / 2653 / 5233 | 用假网站编号，返回 410，只测连通 |
| `termly.io` 首页 | 20/20 | 806 / 1521 / 2277 | |
| `us.consent.api.termly.io`（同意记录上报） | 20/20 | 849 / 975 / 1052 | |
| `www.googletagmanager.com/gtag/js` | 18/20 | 189 / 450 / 5129 | 2 个节点 TCP 超时 |
| **`region1.google-analytics.com/g/collect`（GA4 默认上报地址）** | **0/20** | — | **全部 TCP 超时：大陆基本收不到 GA4 数据** |
| `www.google-analytics.com/g/collect` | 15/20 | 132 / 197 / 900 | |
| `vercel.com/_vercel/insights/script.js`（Vercel Analytics 同款路径） | 20/20 | 278 / 461 / 496 | |
| ping `app.termly.io` | 20/20 | 往返 150–220 毫秒，19 个节点 0 丢包 | 1 个节点 12.5% 丢包 |

**读法和局限**：

- Termly 走 Cloudflare 海外节点，目前**没被墙**，但每次都要跨境，单次往返约 0.2 秒。
- Globalping 只下载响应的前约 10KB。`embed.min.js` 实际压缩后约 **163KB**（解压 435KB，本机测得）。按往返 0.2 秒、无丢包估算，完整下载还要再加约 4 个往返，**大陆首次访问约 1.2–2 秒**；晚高峰跨境拥堵时可能更久，个别节点 DNS 会卡 5 秒。数据中心节点比家庭宽带乐观。
- 如果按 Termly 自动拦截的要求**放在 head 最前面同步加载**，这段时间页面完全空白，会直接吃掉大陆用户 LCP 2.5 秒目标的大半，DNS 卡住时首屏会超过 5 秒。海外用户走 Cloudflare 近端节点，影响小得多（本机经香港约 0.2 秒）。
- 尝试用 itdog 测完整下载时间，遇到人机验证，按规则没有绕过；完整下载时间在第 7 节 PR-1 的 staging 验收里用真实大陆网络补测（含晚高峰一次）。

**结论和替代做法**（Owner 选，第 9 节 O1）：

| 选项 | 做法 | 好处 | 代价 |
| --- | --- | --- | --- |
| **A（推荐）** | Termly 异步加载 + Termly 官方**手动分类拦截**：GA、以后的 Meta 等脚本写成 `type="text/plain" data-categories="…"`，Termly 加载完、按同意结果放行；GA 前先写 Consent Mode 默认值 | 页面不等 Termly，大陆和海外首屏都不受影响；仍是 Termly 的规则和机制 | 新加第三方脚本要记得手动标分类（PR 检查单加一条）；Termly 没加载完前统计晚几百毫秒开始 |
| B | 按 Termly 默认：自动拦截脚本放 head 最前面同步加载 | 不用逐个标脚本 | 大陆用户首屏多等约 1–2 秒、偶尔 5 秒以上；Lighthouse 会报“阻塞渲染的资源” |
| C | 中国大陆不加载 Termly：边缘中间件按国家把大陆访客改写到一份不含 Termly 和 GA 的静态页面副本 | 大陆最快 | 每个公开页多一份静态副本，路由更复杂；大陆访客没有同意弹窗，是否符合中国《个人信息保护法》要 Owner 自己确认；改动最大 |

GA4 在大陆收不到数据，和 Owner“大陆用 Vercel Analytics”的决定一致；不需要为大陆另做 GA 代理（自建转发等于自研，不做）。

## 5. Lighthouse 和性能影响评估

- 方案 A：新增的都是异步或 `afterInteractive` 脚本，预计 LCP、CLS 基本不变；gtag.js（本机测得压缩后约 150KB、解压约 440KB）的主线程解析会让 TBT/INP 轻微上升。**验收限度**：首页和一个台湾繁体页在 staging 上 Lighthouse 移动端性能分下降不超过 5 分，LCP < 2.5 秒、CLS < 0.1 仍达标；超出就把 GA 改为页面空闲后加载。
- 方案 B：每个页面多一个阻塞渲染的跨境脚本，按第 4 节估算大陆 LCP 增加 1–2 秒，不满足 SEO 规范第 9 节的目标时只能退回 A。
- 每个实施 PR 在描述里贴改动前后的 Lighthouse（移动端）分数和 `next build` 静态页标记。

## 6. 第三方数据接收方：补进 DATA-ERASURE 第三方清单的待办

清单文件正被 #867、#869 修改，为避免同一文件冲突，本 PR 不改它；由 ANALYTICS 第一个实施 PR 在那两个合并后补进下列各行（列同现有表格）。

| 接收方 | 收到什么 | 保留期（开工时按官方资料核对） | 删除渠道 | 我们这边 |
| --- | --- | --- | --- | --- |
| Google（GA4） | 随机 client_id、页面路径（应用页只发路由模板）、来源、设备和大致地区、四个关键事件、订单号和金额（无个人信息） | GA4 后台可设 2 或 14 个月，建议设 2 个月（第 9 节 O6） | GA4 后台“用户删除”按 client_id 删除；或调短保留期 | 只在 `payment_orders` 临时存 GA 编号用于付款上报，上报后、72 小时后或注销时置空，不进 Stripe、不进账务保留的结账请求；注销后该用户的 client_id 我们本来就没有，不能按用户删，如实写进隐私条款 |
| Termly | 访客的同意记录（同意编号、时间、选择、IP 和浏览器信息） | 按 Termly 政策，开账号后核对 | Termly 后台和支持渠道 | 同意记录是合规证据，按 Termly 规则保留 |
| Vercel（Web Analytics） | 页面路径（已去参数）、来源、国家、设备；不用 Cookie | 访客识别哈希 24 小时；报表窗口按套餐（Pro 12 个月） | 等待过期 | 不放个人信息，不需要按用户删除 |
| Meta（第二步） | 像素事件、CAPI 转化（哈希后的联系信息另需 Owner 定） | 第二步开工时核对 | — | 第二步方案再补 |

## 7. 拆分和每个 PR 的验收

**第一步（随公开站上线）**，同一条线内按顺序做；排在 8 条线排期的 ⑥ 官网线、PUBLIC-SITE 第一段之后，因为都要改根布局（`apps/web/src/app/layout.tsx`）。

| PR | 内容 | 风险 | staging 验收 |
| --- | --- | --- | --- |
| PR-1 Termly + Consent Mode | 按 O1 选定的方式加载 Termly；Consent Mode 默认值；页脚“Cookie 设置”入口；PR 检查单加“新第三方脚本要标 Termly 分类” | 普通 | 用浏览器开发者工具模拟欧盟访问（Termly 的地区预览或欧洲出口网络）：同意前没有 `_ga` 等统计 Cookie、没有发往 google-analytics 的请求；点同意后才出现；模拟美国访问能看到“不要出售或分享”入口；大陆网络下首屏不等 Termly（含一次晚高峰实测完整下载时间）；公开页仍是静态 |
| PR-2 GA4 + Vercel Analytics | gtag 按分类加载；公开页页面浏览、网址去参数；`sign_up`、`positioning_complete`、`begin_checkout` 三个浏览器事件；`<Analytics />` 和 `beforeSend` 去参数 | 普通 | GA4 实时报告看到页面浏览和三个事件；打开带 `?code=`、`?email=` 的地址和带编号的动态应用路径（如某个定位草稿页）后，网络面板里发往 GA 和 Vercel 的请求都不含这些参数和编号（只出现路由模板或不发）；应用页没有 `page_view`；从 chatgpt.com 等来源（不带 utm）点进来的访问在 GA4 里归到“AI 推荐”渠道；如果 O5 归为“统计”：模拟欧盟访问时，拒绝或尚未选择前网络面板里没有任何 `/_vercel/insights/*` 请求，同意后才出现；用中国大陆真实网络访问一次包含本改动的 preview 页面，确认该项目的 Vercel Web Analytics 报表里出现这次访问（不只是脚本能下载）；Lighthouse 下降在第 5 节限度内 |
| PR-3 首次来源 + 付款上报 | 迁移：`profiles.signup_attribution` 加列、`payment_orders.ga_client_id/ga_session_id` 加列，都接入注销清理，GA 编号接入每日清理；注册时写入；结账带 client_id 进 Stripe metadata；webhook 履约成功分支用 Measurement Protocol 上报 `purchase`；后台统计页按来源分组 | 高（数据库、注销、计费链路） | 迁移按 ENGINEERING 要求验证（兼容、可重复执行、指纹）；带 utm 和 AI 来源的注册在资料里写对、超长和非白名单字段被丢弃；注销后这些列为空；Stripe 结账请求、`checkout_request` 和 Stripe 订阅/付款记录里查不到 GA 编号；上报后和 72 小时后 GA 编号被置空；Stripe 测试模式付款一次，GA4 实时报告只出现一笔 `purchase`，且归到发起结账那次访问的来源；重放同一 webhook 不再出现；集成测试里**并发**投递同一事件两次、以及同一订单的 `checkout.session.completed` 和 `invoice.paid` 同时到达，断言履约和 `purchase` 上报都恰好一次（上报只挂在原子履约返回“本次新履约”的那一个调用上）；没同意统计的访客付款不上报且履约正常；上报失败不影响履约 |
| 后台配置（不是代码） | GA4“AI 推荐”自定义渠道组、数据保留期、关闭 Google 信号；Termly 地区规则、Consent Mode 开关、GPC | — | Owner 操作，或在当次对话批准后由 AI 按清单操作；正式环境逐项另批 |

**第二步（Owner 投广告前）**：META——Meta 像素按 Termly“广告”分类加载、CAPI 由服务器在同一个“真正履约”分支上报，按事件编号和浏览器端去重。开工前另出方案。

PR-1、PR-2 只改前端、不动钱，但会改页面脚本、Cookie 弹窗和统计交互，所以按 AGENTS 第 4 节第 3、5 条，**先在包含最终改动的 preview 上用真实浏览器验收通过，再合并**（验收交 Codex，按交互验证分工；改了代码要对新版本重新确认）；PR-3 含迁移和计费链路上的改动，按高风险验证后在 staging 自己合并（AGENTS 第 3、4 节）。上正式环境、往 Vercel 加环境变量走第 1 节逐项批准。

## 8. Owner 要做的事

1. **开账号**：Google Analytics（建 staging、正式两个 GA4 媒体资源，各一个网页数据流）；Termly（选能用地区规则、Consent Mode v2 和同意记录的套餐，套餐费用 Owner 定）。Vercel Web Analytics 在 Vercel 项目里打开（这是平台设置，当次批准）。
2. **给 AI 公开编号**：两个 GA4 衡量 ID（`G-` 开头，公开，会出现在网页源码里）、Termly 网站编号（公开）。可以直接在对话里发。
3. **密钥**：GA4 Measurement Protocol 的 API secret（staging、正式各一个）放进 `~/.graylum/secrets/`，不要发在对话或 PR 里；AI 只用于在 Vercel 里配置环境变量，**每次往 Vercel 加变量都要当次批准**（staging 一次、正式一次）。
4. **后台设置**：第 7 节“后台配置”一行，Owner 自己点，或批准 AI 按清单操作。
5. **隐私条款**（Owner 用第三方工具生成时写明）：使用 GA4、Vercel Analytics、Termly（以后 Meta）；收集哪些数据（不含个人信息）、用途、保留期（GA4 按 O6）；首次来源存在账号资料里、注销即删；欧洲先同意、美国可拒绝出售/分享并尊重 GPC；GA 数据无法按用户逐个删除。

## 9. 需要 Owner 确认的细节

| 编号 | 问题 | 推荐 |
| --- | --- | --- |
| O1 | Termly 怎么加载（第 4 节 A/B/C） | **A**：异步加载 + Termly 官方手动分类拦截。理由：实测大陆完整下载约 1–2 秒、偶尔 5 秒，同步放 head 最前会让大陆首屏空白 |
| O2 | 应用页只记四个关键事件、不记页面浏览；付款成功只算首次付款，续费不算 `purchase`（续费看数据库报表） | 同意 |
| O3 | 没有同意统计的访客付款时不向 GA 上报（金额以数据库为准） | 同意 |
| O4 | 美国访客：默认放行统计，提供“不要出售或分享”入口并尊重 GPC；若 Termly 不支持自动识别 GPC，是否接受只提供手动入口 | 先在 Termly 后台确认；不支持时再问 |
| O5 | Vercel Web Analytics（不用 Cookie）在 Termly 里归“必要”还是“统计” | 按 Termly 分类工具的结果定；若归“统计”，欧洲访客同意前不加载 |
| O6 | GA4 数据保留期 2 个月还是 14 个月 | 2 个月（报表的汇总数字不受影响，只限制细分探索；和“我们自己最多 30 天”口径更接近） |
| O7 | “AI 推荐”渠道的来源名单（第 3.1 节） | 按名单上线，以后按实际来源增补 |
| O8 | 首次来源只存 referrer 域名、utm 和落地路径，不存完整网址和 IP | 同意 |

## 10. 发现的问题（不在本任务范围，报告总控）

- `/verify-email?email=…` 把邮箱放在网址里。本方案已保证统计不会带出去，但网址里放邮箱本身也会进浏览器历史和服务器日志，建议另开小任务评估改成不放邮箱。
