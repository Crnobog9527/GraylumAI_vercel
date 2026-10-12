# Graylum 全站 SEO / GEO 规范

> 版本：2026-10-12 第 1 版（规划窗口起草）。
> 适用：所有不需要登录就能看到的页面（首页、功能页、关键词页、博客、价格页、法律页、About）。登录后的 `/app` 和 `/admin` 一律不索引，不适用第 4–12 节。
> 以后每个新增或改动公开页的 PR 都必须按本文执行，并在 PR 描述里过第 13 节的检查单。
> 决定状态：第 2 节（单主机）、第 3 节（中文优先的语言路径）和第 14 节（博客）是 Owner 2026-10-12 已批准的决定；首页核心词等 Owner 导出中文搜索量后再定（第 3.3 节）。
> 缩写第一次出现时的解释：DR = 域名权重（Ahrefs 口径，0–100）；KD = 关键词难度（哥飞版，0–100，越低越好）；GSC = Google Search Console；SERP = 谷歌搜索结果第一页；ISR = Next.js 的增量静态再生成。

## 1. 原则

1. 一个站只做一个主机，举全站之力推首页核心词；内页各做一个词，全部回链首页（哥飞《精品工具页面 SEO运营》2025-10-29；《从网站站内优化到部署上线再到推广运营》2024-08-13）。
2. 一页一词：一个页面只围绕一个搜索需求；同一需求的不同说法放同一页，不同需求绝不合并（哥飞 2024-08-29 群聊）。
3. 页面按"直接给结果"做，不按"写篇文章"做：首屏给结论，页面可交互或至少直达产品对应功能。
4. 搜索引擎和 AI 搜索（ChatGPT、Perplexity、Google AI Overviews、Bing Copilot）用同一套页面；GEO 没有独立捷径，先把页面做到能排名、能被原样引用。
5. 文案只写已上线的能力，未上线的按 Master Plan 第 2.1 节第 51 项隐藏，不写"即将上线"；落地页的能力清单由 Owner 勾选后定。

## 2. 主机与域名（已批准）

Owner 2026-10-12 决定：应用合并到 `www.graylum.com` 单主机，登录后页面放 `/app` 前缀，上线前完成。

| 规则 | 内容 |
| --- | --- |
| 正式主机 | 只有 `https://www.graylum.com` |
| 其他主机 | `graylum.com`、`app.graylum.com`、`http://` 一律 301 到 www。`app.graylum.com` 上**只有搬进 `/app` 的界面路由**加前缀（`app.graylum.com/positioning` → `www.graylum.com/app/positioning`）；`/auth/*`、`/api/*`、`/admin/*`、`/_next/*` 保持原路径只换主机（`app.graylum.com/auth/callback` → `www.graylum.com/auth/callback`），在途的登录链接和支付回调不能落到不存在的 `/app/auth`、`/app/api`。重定向长期保留 |
| 登录后页面 | 全部在 `/app/...`；`/admin/...` 保持；`/api/...`、`/auth/callback` 位置不变 |
| 索引范围 | `/app`、`/admin`、`/api`、`/auth` 永远 `noindex`（响应头 + robots Disallow），不受 `SITE_INDEXING` 开关影响；开关只控制公开页 |
| Cookie | 单主机后登录 Cookie 改为 host-only，不再用 `.graylum.com` 共享域 |
| staging | `auth-staging.graylum.com` 本来就是单主机，套用同一套按路径的规则 |

迁移的技术清单见第 14 节；开发由总控另派，本文不含代码改动。

## 3. 语言与路径（已批准：中文优先）

Owner 2026-10-12 在"A 中文优先 / B 英文优先"中选 A（原话「选 A。」）：网站默认中文，简体在根路径，繁体 `/zh-tw`，英文 `/en` 等产品有英文界面后再上；第一批内容先做简体和繁体（繁体竞争松，先出排名）；首页核心词等 Owner 用 Google Ads 规划师导出中文搜索量后再定；英文关键词研究保留为附录 A，作为后备。

### 3.1 路径规则

| 项目 | 规则 |
| --- | --- |
| 根路径 `/` | 简体中文首页 |
| 简体中文页 | 根路径下，不加前缀（`/xiaohongshu-qihao`） |
| 繁体中文页 | `/zh-tw/...` |
| 英文页 | `/en/...`，有英文界面后再做；在此之前不建 `/en` 目录，也不写指向它的 hreflang |
| 日语（将来） | `/ja/...` |
| `x-default` | 指向根路径（简体） |
| `<html lang>` | 根路径 `zh-Hans`；`/zh-tw` 下 `zh-Hant`；`/en` 下 `en` |
| `openGraph.locale` | `zh_CN` / `zh_TW` / `en_US` |
| sitemap | 一个 `sitemap.xml`，按语言分组，每条带 `alternates` |

共同规则：
- 不按浏览器语言自动跳转（爬虫会被跳走）；可在页顶放语言提示条。
- 不用 `?lang=` 参数，不用子域名做语言。
- 每个有对应语言版本的页都写全 `hreflang`：`zh-Hans`、`zh-Hant`（+ 将来的 `en`）+ `x-default`；只在确实有翻译版时写，不能指向不存在的页。
- 简体和繁体不是互译：词、平台（小红书 / 抖音 vs IG / Threads）、第一页对手都不同，各按各的 SERP 写。简体面向美国、新加坡、马来西亚的大陆背景华人（Google `gl=us`、`hl=zh-CN` 口径）；繁体面向台湾、香港（`gl=tw`）。
- 英文页上线时同样不是中文页的翻译，按附录 A 的英文词另做。

### 3.2 第一批公开页

第一批只做简体和繁体，候选见附录 B：简体 6 页、繁体 7 页，最终取舍和先后顺序在 Owner 导出规划师搜索量后定（剔除月搜 < 50 的，按"量 × 盘面弱度"排序）。在此之前实施任务可以先做与词无关的地基（单主机、元数据组件、sitemap、robots、JSON-LD、About）。

### 3.3 首页核心词

待定。候选来自规划师数据到达后的中文词（方向：定位类"自媒体定位 / 账号定位"、类目类"AI 社媒教练"、平台类"小红书起号"），按哥飞"一个站只做一个核心词"的原则选一个能代表整站的词，所有内页回链它。英文首页词（`social media coach`，附录 A）只在 `/en` 上线时用于英文首页。

## 4. 地址（URL）规则

1. slug 只用小写字母、数字、连字符，就是目标词本身，例如 `/zh-tw/ig-jingying`、`/en/find-your-niche`。不加日期、分类前缀、`.html`、尾斜杠。
2. 中文页的 slug 用拼音或英文（`/xiaohongshu-qihao`、`/zh-tw/ig-jingying`），不用汉字（分享时会变成百分号编码）。
3. 地址定了不改；必须改时 301 并更新 sitemap 和内链，不留重定向链。
4. 同一内容只有一个地址：根路径直接渲染首页，不再保留 `/landing` 作为第二地址（`/landing` 301 到 `/`）。
5. 分页、筛选、排序参数一律 `noindex` 或 canonical 回主地址；`utm_*` 参数不进 canonical。
6. 404 返回真实 404 状态码，不软 404。

## 5. 元数据（统一由 `generateMetadata` 生成，不允许页面自己拼）

| 字段 | 规则 |
| --- | --- |
| `title` | 核心词放最前；英文 ≤ 60 字符，中文 ≤ 30 个汉字；格式 `核心词 – 一句话承诺 \| Graylum`；首页 `Graylum – <核心词>...` |
| `description` | 含核心词 + 用户得到什么 + 行动引导；英文 120–155 字符，中文 60–80 字 |
| `alternates.canonical` | 绝对地址，自己指向自己 |
| `alternates.languages` | 见第 3.1 节 hreflang 规则 |
| `openGraph` | `title`、`description`、`url`、`siteName: Graylum`、`type: website`（博客 `article`）、`locale`（`zh_CN` / `zh_TW` / `en_US`）、一张 1200×630 图 |
| `twitter` | `card: summary_large_image` |
| `robots` | 公开页 `index, follow`；`/app /admin /api /auth` `noindex, nofollow`，响应头和 meta 双保险 |
| `keywords` | **不写**（哥飞《从 TDK 到 TDH》2024-04-06）；现有代码里的删除 |
| `<html lang>` | 按页面语言 `zh-Hans` / `zh-Hant` / `en`，不写死 |

OG 图：全站一张默认图 + 关键词页可用模板生成（标题 + 品牌），文件放 `public/og/`。

## 6. 标题层级（TDH 的 H）

- 每页只有一个 H1，和 title 的核心词同词（可更口语），放首屏。
- H2 放用户真实会问的子问题（素材来自 SERP 的 People also ask 和相关搜索），3–6 个；H3 放长尾和步骤。
- 骨架：H1 → H2 → p → H3 → p → H3 → p → H2 → p（哥飞 2024-08-13）。
- 首页用 H2/H3 列出各内页的词，并链过去。
- 不用 H 标签做样式；导航、页脚、卡片标题不用 H。

## 7. 页面内容

1. 首屏 100 字内给结论或结果（搜"什么时候发什么"的人第一屏就要看到可用的清单）。
2. 每个关键词页有一个与该词对应的交互元素或产品直达入口：免登录的轻量试用**暂缓**（Owner 2026-10-12），在此之前用"到产品对应功能"的按钮，并写清点进去会得到什么。
3. 正文长度对标 SERP 第一页中位数，不堆字；覆盖 3–6 个真实疑问（H2）。
4. 每页至少一段 2–3 句、能被 AI 原样引用的定义或结论（第 12 节）。
5. 写明更新日期、作者或团队并链到 About 页（E‑E‑A‑T）。
6. 产品差异化（主动提问、引导表达、给下一步）写在正文里，不塞进关键词。
7. 不写没有的功能；不写"约多少次"等计费承诺（第 2.1 节第 50 项）。
8. 写页前先看一次当天 SERP；盘面结论超过 1 个月要重测。

## 8. 内链

- 关键词页：链回首页（锚文本含首页核心词）、链 2–3 个同主题页、链 1 个产品功能入口。
- 首页：链到全部一级关键词页，按模块分组（定位 / 选题 / 平台 / 个人品牌）。
- 博客文章 → 关键词页或产品页单向引流。
- 锚文本用描述性词，不写"点这里"；无死链（建议 CI 加链接检查）。
- 页脚统一：语言切换、法律页、联系方式、官方社交账号。

## 9. 渲染与性能

- 公开页禁止 `force-dynamic`；用静态生成或 ISR（`revalidate` ≥ 3600）。价格等要查库的数据用 ISR 或客户端挂载后取，SEO 文字不依赖它。
- 所有 SEO 文字服务端渲染；交互组件可以是客户端组件。
- Core Web Vitals 目标：LCP < 2.5 s、INP < 200 ms、CLS < 0.1（Vercel Speed Insights）。
- 图片用 `next/image` 并写 `alt`；字体自托管（MiSans 已是）；首页首屏不加载大 JS。
- 不用按 UA 跳转；不用无限滚动承载 SEO 内容。

## 10. 结构化数据（JSON-LD，统一组件输出，内容必须和页面可见内容一致）

| 页面 | 类型 |
| --- | --- |
| 全站 | `Organization`（名称、logo、`sameAs` 官方社媒账号、`contactPoint`）+ `WebSite` |
| 首页 / 产品页 | `SoftwareApplication`（`applicationCategory: BusinessApplication`，`offers` 写免费起步） |
| 关键词页 | `WebPage` + `BreadcrumbList` + `FAQPage`（只放页面上真实出现的问答） |
| 博客 | `BlogPosting`（作者、日期、图） |
| 不做 | `HowTo`（谷歌 2023-09 起不再展示）；自评 `Review` / `AggregateRating`（违规） |

## 11. robots、sitemap、AI 爬虫

robots.txt 由 `app/robots.ts` 生成，上线（`SITE_INDEXING=public`）后的内容：

- 放行（搜索和 AI 问答类）：`Googlebot`、`Bingbot`、`OAI-SearchBot`、`ChatGPT-User`、`Claude-SearchBot`、`Claude-User`、`PerplexityBot`、`Perplexity-User`、`DuckAssistBot`、`Applebot`、`*`。
- 拒绝（模型训练类，Owner 2026-10-03 决定）：`GPTBot`、`ClaudeBot`、`anthropic-ai`、`CCBot`、`Google-Extended`、`Applebot-Extended`、`Bytespider`、`Meta-ExternalAgent`、`Amazonbot`、`cohere-ai`、`Diffbot`、`omgili`。
- 所有 UA：`Disallow: /app/`、`/admin/`、`/api/`、`/auth/`。
- 末尾：`Sitemap: https://www.graylum.com/sitemap.xml`。
- 说明：拒绝 `GPTBot` 不影响 ChatGPT 搜索引用（那是 `OAI-SearchBot`）；拒绝 `Google-Extended` 不影响谷歌搜索和 AI Overviews（那用 Googlebot）。
- `SITE_INDEXING` 不是 `public` 时仍然整站 `Disallow: /`（staging 和预览永不索引）。

sitemap：`app/sitemap.ts` 生成，分语言、含 `lastModified`、只含可索引的公开页、不含重定向地址；上线当天提交 GSC 和 Bing Webmaster。

`llms.txt`：可选，放站点一句话简介和主要页面列表；不作为指标（社群里的"AI 流量暴涨"案例未经哥飞本人验证，Google 公开表示未使用该文件）。

## 12. GEO（被 AI 搜索引用）

AI 搜索引用的来源主要是：① 谷歌/必应里本来就排得上的页面；② 高权威第三方页面里对品牌的描述。所以：

1. 先做好搜索排名，再谈 GEO。
2. 全站统一一句话定义（出现在首页、About、`Organization.description`、所有第三方目录简介）。中文版由落地页文案任务定稿后固定；英文版（`/en` 上线时用）：`Graylum is an AI social media coach that helps beginners find their positioning, decide what to post each week, and write the content.`
3. 每页首屏结论段写成"问题 → 直接答案 → 可核对的要点"，用数字、步骤、清单。
4. 引用可靠来源（平台官方帮助页、公开报告）并标出处。
5. About 页写清公司（Grayscale Luminary LLC，怀俄明州）、创始人、联系方式；法律页齐全（条款文字由 Owner 用第三方软件生成）。
6. 第三方提及由 Owner 配合：AI 工具目录、Product Hunt、Reddit / Quora / Threads / 小红书上的真实讨论、创始人社媒账号；简介统一用第 2 条的句子。
7. 每月用 5 个固定问题问 ChatGPT / Perplexity / Google AI 模式，记录是否出现 Graylum。
8. 中文定位句不用"海外华人自媒体"这类说法（美国谷歌里该词的第一页全是时政评论频道）。

## 13. 公开页 PR 检查单（每个 PR 描述里逐项打勾）

- [ ] title / description / canonical / hreflang / OG 图齐全；`keywords` 已删
- [ ] 只有一个 H1；H2 覆盖真实疑问
- [ ] 首屏给结论；有产品入口
- [ ] JSON-LD 通过 Google 富媒体测试
- [ ] 不是 `force-dynamic`；Lighthouse 移动端性能 ≥ 90
- [ ] 内链 ≥ 3 条，无死链
- [ ] 进入 sitemap；robots 允许；`/app` 等路径仍被拒绝
- [ ] 真实浏览器按 AGENTS.md 第 4 节验证过

## 14. 博客（已批准）

Owner 2026-10-12 决定：博客用仓库内文章实现，不接外部系统。

- 文章是仓库里的 Markdown/MDX 文件，路径 `/blog/<slug>`（简体）、`/zh-tw/blog/<slug>`（繁体），由同一个 Next.js 应用静态生成。
- 每篇文章遵守第 4–10 节（`BlogPosting`、一个 H1、canonical、OG 图）。
- 文章的任务是给关键词页和产品页引流，不是自己承接核心词。
- 不加 CMS、数据库表或新服务（AGENTS.md 第 5 节）。

## 15. 单主机迁移的技术清单（给实施任务，不在本 PR 做）

| 位置 | 改动 | 风险 |
| --- | --- | --- |
| `apps/web/src/proxy.ts` | 去掉按主机名分流；改成按路径：`/app/*`、`/admin/*` 需登录，其余公开；根路径直接渲染首页 | 登录和权限，high |
| `apps/web/src/lib/site-config.ts` | `PUBLIC_SITE_HOSTS / SHARED_COOKIE_HOSTS / DEFAULT_AUTH_APP_URL / normalizeAppOrigin` 简化为单主机；Cookie 改 host-only；`buildAuthHref / buildAppHref` 加 `/app` | 登录态 |
| `apps/web/src/lib/public-paths.ts` | 公开为默认，`/app` `/admin` 需登录 | 权限 |
| 路由目录 | `positioning / runtime / profile / library / marketplace / workbench / login / register / verify-email / forgot-password / reset-password` 移到 `src/app/app/`；全仓约 45 处内链、21 个文件改前缀（不含测试） | 面广 |
| `next.config.ts` | `redirects()` 加 `has: host = app.graylum.com` 的 301：界面路由加 `/app` 前缀，`/auth` `/api` `/admin` `/_next` 只换主机不加前缀（第 2 节）；`X-Robots-Tag noindex` 改为只对 `/app` `/admin` `/api` `/auth` | ordinary |
| 环境变量 | `NEXT_PUBLIC_APP_URL`、`NEXT_PUBLIC_AUTH_APP_URL` = `https://www.graylum.com` | 正式环境改值属 AGENTS §1 |
| 支付回调 | `waffoCheckout.ts`、`stripeCheckoutIntent.ts` 的 successUrl 从请求 origin 拼，自动跟随；Waffo / Stripe 后台 webhook 主机要改（路径不变） | 正式环境属 §1；staging 由 AI 改 |
| Supabase Auth | Site URL 改 www；Redirect URLs 加 `https://www.graylum.com/**`、删 app 域；邮件模板不改；Google OAuth 不改 | 正式环境属 §1；staging 由 AI 改 |
| Vercel | 两个域名已在同一项目；撤掉 Owner 手动加的 `www → app` 临时 307（第 8.5 节、#614） | 正式环境属 §1 |
| 测试 | `proxy-hostname / proxy-auth / proxy-auth-landing / proxy-pricing / site-config / authLanding.gotrue` 6 个单测和 `production-stripe-smoke.spec.ts` | ordinary |

建议拆两个 PR：① proxy / site-config / 路由前缀（high）；② robots / noindex / redirect / sitemap（ordinary）。

---

## 附录 A · 英文关键词数据（后备，`/en` 上线时用；2026-10-12 核实；搜索量 = Google Ads 规划师美国口径 2025-09～2026-08 月均；KD = 哥飞版，10-11/12 计算）

**英文首页核心词候选**（`/en` 首页用）：`social media coach` 320 / KD 49.9（第 4 名 thesocialmediacoach.com.au 是 DR 20 首页，体验分 0）；`ai social media manager` 720 / 47.1（socialbee、ocoya 首页占位，意图偏"替我发帖"）；`ai social media coach` 未收录；`social media strategy for beginners` 10（不用）。

**英文第 1 批（8 页，地址在 `/en` 下；`/en` 上线前这些地址不存在，不写进 sitemap 或 hreflang）**

| 地址 | 目标词（合并的同义表达） | 月搜 | KD | 盘面最弱占位 | 功能 |
| --- | --- | --- | --- | --- | --- |
| `/en/what-to-post-on-instagram` | what to post on instagram（+ what should i post on instagram 170） | 880 | 26.9（品牌词口径） | 第 3 名 DR 8 | 选题 |
| `/en/what-to-post` | what to post（+ what to post on social media 70） | 170，近半年涨到 390 | 18.7 | 第 2 名 DR 8 | 选题总页 |
| `/en/how-to-become-a-content-creator` | how to become a content creator with no experience（远期升级 how to become a content creator 2900 / 45.8） | 260 | 15 | 第 3 名 DR 1、第 10 名 DR 2 | 定位 |
| `/en/social-media-strategy-for-small-business` | social media strategy for small business | 110 | 16.5 | 第 8 名 DR 8；出价 $3.4–19 | 定位 |
| `/en/how-to-grow-on-instagram` | how to grow on instagram | 590 | 27.7 | 第 1 名 reddit 帖；第 7 名 DR 27 | 策略 |
| `/en/find-your-niche` | find your niche + finding your niche + how to find your niche | 320+170+260 | 35.9 / 32 / 37.9 | 第 4 名 DR 17 | 定位 |
| `/en/content-pillar-examples` | content pillar examples | 320 | 28.1 | 第 7 名 DR 33 | 选题 |
| `/en/personal-brand-coach` | personal brand coach + personal branding coach | 110+140 | 27.6 / 34.5 | 第 2 名 DR 2 | 转化页 |

**第 2 批（上线后 6–12 周）**：personal brand strategy（+ personal branding strategy）210+110 / 31.2；how to grow on tiktok 390 / 36.9（品牌词口径）；what to post on tiktok 480 / 39；what to post on facebook 140 / 32.3；how to get followers on instagram 4400 / 37.3；how to monetize social media 170 / 36.8；instagram growth strategy 720（波动大）/ 23.8；social media content strategy 390 / 41.4。

**第 3 批（DR ≥ 25 后）**：instagram post ideas 1300 / 47.8；social media content plan 720 / 44.1；how to build a personal brand 590 / 47.5；personal brand examples 1300 / 48；linkedin content strategy 210 / 40.7、what to post on linkedin 320 / 41.9；ai social media manager 720 / 47.1；instagram caption generator 2900 / 46（免费工具页）；social media audit 880 / 56.1（半年后）；content strategy 3600 / 57。

**不做**：instagram captions 67.5；best time to post on instagram 61.1；hook generator 59.1；social media post ideas 55；personal brand statement 50.3；brand voice 67.8；social media strategy template 61.3；brand positioning 61.3；positioning statement 58.5；niche marketing 57.5；content pillars 57.1；content strategy template（意图跑偏）；niche finder 全族（YouTube 数据工具词）；social media scheduler / planner 类目词。

## 附录 B · 中文盘面与搜索量（第一批候选；搜索量 = Semrush 2026-10-12 查询，KD 为 Semrush 口径；DR 为 2026-10-11 实测）

**三地用语先分清（2026-10-12 用谷歌自动补全和 Semrush 核对）**：台湾说"自媒體 / 社群 / 小編 / 短影音 / 網紅 / IG 經營"；香港说"社交媒體 / KOL / 數碼營銷 / 網上推廣 / IG"；美国华人说"社交媒体 / 自媒体 / 运营"。三套词各自成族，不能互译。Owner 2026-10-12 补充：海外华人创作者的主要平台是 YouTube、TikTok、Instagram，简体页的平台词按这三家写。

**搜索量与难度（Semrush 月搜 2026-10-12；"哥飞 KD"= 哥飞版难度，对中文词可用，2026-10-12 实测；Semrush KD 另列）**

| 市场 | 词 | 月搜 | 哥飞 KD | Semrush KD | 盘面最弱占位 |
| --- | --- | --- | --- | --- | --- |
| 台湾 | 自媒體 | 2,400 | — | 22 | — |
| 台湾 | 自媒體是什麼 | 1,000 | 20.7 | 23 | 第 7 名 DR 2 |
| 台湾 | 自媒體課程 | 590 | — | 10 | — |
| 台湾 | 自媒體經營 | 480 | 20.4 | 15 | 第 10 名 DR 2 |
| 台湾 | 如何經營自媒體 / 經營自媒體 | 140 / 110 | **6.6** | 9 / 8 | 第 9 名 DR 12 |
| 台湾 | 短影音 / 短影音行銷 / 短影音趨勢 | 2,900 / 390 / 210 | 17.4（行銷） | 29 / 10 / 20 | 第 3 名 DR 5 |
| 台湾 | IG 經營 / 如何經營 IG / 經營 IG | 260 / 140 / 110 | **9.6** | 20 / 20 / 15 | 第 1 名 DR 10、第 3 名 DR 2 |
| 台湾 | 個人品牌 / 個人品牌經營 | 260 / 40 | 29.7 | 35 / 9 | 第 5 名 DR 4 |
| 台湾 | Threads 經營 | Semrush 无数据（自动补全有 技巧/策略/課程/怎麼經營） | 32.6 | — | 第 7 名 DR 8 |
| 台湾 | 社群小編 / 小編工作內容 | 260 / 210 | — | 21 / 22 | — |
| 台湾 | 網紅行銷 | 320 | — | 22 | —（"網紅"本身 5,400 但一半是八卦，不用） |
| 台湾 | 社群經營、自媒體定位 | Semrush 无数据（谷歌第一页有十几个专营站） | 定位：盘面见下表 | — | — |
| 香港 | 社交媒體 / 社交媒體營銷 / 社交媒體營銷課程 | 1,000 / 20 / 110 | 31.1（營銷） | 36 / — / 9 | 第 4 名 DR 18 |
| 香港 | KOL / KOL marketing / 香港 KOL / 如何成為 KOL | 4,400 / 390 / 320 / 90 | 28.1（如何成為） | 28 / 14 / 12 / 12 | 第 7 名 DR 0 |
| 香港 | 數碼營銷 / 數碼營銷課程 | 480 / 140 | 36.3 | 15 / 10 | 第 1 名 DR 36 |
| 香港 | 自媒體 / 自媒體定義 | 590 / 110 | — | 22 / 21 | — |
| 香港 | 網上推廣 / IG 推廣有用嗎 | 110 / 30 | — | 13 / 7 | — |
| 美国 | 社交媒体 | 1,000 | — | 41 | — |
| 美国 | 自媒体 | 590 | 59.7 | 18 | 第 7 名 DR 54 首页（维基、百度百科占前两位） |
| 美国 | 小红书运营 | 210 | — | 5 | — |
| 美国 | TikTok 运营 | 50（出价 $12.69） | 43.8 | 11 | 第 4 名 DR 0 |
| 美国 | youtube 中文 | 590 | — | 53 | 导航词，不用 |
| 美国 | youtube 中文频道怎么做 | — | 57.4（4 席是 YouTube 自己） | — | 不用 |
| 美国 | 自媒体怎么做 / 运营 / 赚钱、小红书起号 / 引流 / 推广、代运营、海外推广、Instagram 运营、YouTube 运营 | 各 10–30 或无数据 | — | — | — |
| 新加坡 | 自媒体 | 140 | — | 20 | — |

**长尾（谷歌自动补全 2026-10-12，只列有行动意义的）**：
- 美国简体："小红书运营 skill / agent / 工具 / 教程 / 手册 / 助手"、"小红书文案 skill / 生成器 / 提示词 / 检测"、"社媒运营 skill"、"小红书引流到微信 / 引流话术"、"小红书推广价格"、"自媒体怎么做 / 怎么开始 / 怎么变现"、"tiktok运营教程 / 技巧"、"instagram 运营技巧 / 教程 / 代运营"、"华人在美国做什么生意"。其中 **"小红书运营 skill"一族是 2026 年新出现的词**（第一页全是 GitHub 技能包、知乎教程、explainx.ai），搜索量工具还没收录；Graylum 本身就是带 Skill 的 AI 社媒教练，这一族要单独做页（见下）。
- 台湾繁体："ig 經營 起步 / 課程推薦 / 教學 / 技巧 / 策略 / 賺錢"、"threads 經營 技巧 / 策略 / 課程 / 怎麼經營"、"自媒體 怎麼做 / 怎麼賺錢 / 經營課程 / 變現方式"、"ai 社群 行銷 / 貼文 / 小編 / 經營"、"youtube 經營 初期 / 教學 / 策略"、"短影音 腳本 / 製作 / 課程"、"個人品牌 經營 / 成功案例"。
- 香港繁体："kol 如何賺錢 / 如何報價 / 如何成為 / 如何做"、"ig 經營 起步 / 課程 / 技巧"、"ig 推廣 費用 / 有用嗎 / 教學"、"數碼營銷 策略 / ai 數碼營銷"、"開 ig 店"。

**读法**：
1. 繁体（台湾）是中文里唯一有像样搜索量的市场："自媒體"一族每月约 5,000 次，短影音一族 3,500 次，难度 6–30；香港 KOL / 社交媒體 / 數碼營銷 三族各几百到几千，难度 28–36。
2. 简体在谷歌（美国、新加坡）只有"社交媒体""自媒体""小红书运营"过 100，平台词（YouTube / TikTok / Instagram + 运营）几乎没有中文搜索量。美国华人商家找代运营、学 TikTok 获客，主要在微信群、小红书、抖音里问，或者用英文搜；谷歌中文不是他们的主入口。简体页因此只做核心词 + "skill"词族，其余简体获客靠小红书 / 微信内容本身。
3. Semrush 没有数据的词（社群經營、Threads 經營、自媒體定位）不等于没人搜，谷歌第一页有专营站、自动补全有长尾；用哥飞 KD 和盘面判断。

**据此对第 3.2 节的建议（不是决定，待 Owner 确认）**：
- 繁体第一批 7 页：台湾 5（`/zh-tw/zimeiti-jingying` 自媒體經營+如何經營自媒體；`/zh-tw/ig-jingying` IG 經營；`/zh-tw/duanyingyin-xingxiao` 短影音行銷；`/zh-tw/geren-pinpai` 個人品牌；`/zh-tw/threads-jingying` Threads 經營）+ 香港 2（`/zh-tw/shejiao-meiti-yingxiao` 社交媒體營銷；`/zh-tw/ruhe-chengwei-kol` 如何成為 KOL）。香港页和台湾页同在 `/zh-tw`，hreflang 都是 zh-Hant，各写各的词。
- 简体第一批 4 页：`/shejiao-meiti` 社交媒体、`/zimeiti` 自媒体（难度 59.7，当长期词，首屏讲"海外华人怎么做自媒体"）、`/xiaohongshu-yunying` 小红书运营、`/xiaohongshu-yunying-skill` 小红书运营 Skill（承接 skill / agent / 工具 一族，页面本身给出可用的 Skill）。
- 首页核心词候选：繁体"自媒體"是量最大的中文词，但根路径是简体（Owner 选 A）；简体里没有一个词同时满足"有量 + 难度低"。建议首页不押单个搜索词，用品牌 + 类目句（"AI 社媒教练"）做 H1，让流量靠内页；或 Owner 重新考虑根路径语言。这是产品决定，待 Owner 定。

**简体候选（gl=us；根路径）**

| 地址（建议） | 目标词 | 盘面 | 判断 |
| --- | --- | --- | --- |
| `/xiaohongshu-qihao` | 小红书起号 / 小红书新手怎么做 | reditorapp.com DR 20 排第 1、3；yanghao.app DR 2.6；jingpinwen DR 0.8 | 可做 |
| `/xiaohongshu-wenan-shengchengqi` | 小红书文案生成器 | Kimi、ai.xiaohongshu.live DR 28、reditorapp DR 20、qingsongsha DR 10 | 可做，工具页 |
| `/zimeiti-zenme-zuo` | 自媒体怎么做 | YouTube 课程、woshipm DR 75、知乎、posty.tw DR 2.1 | 可做；"自媒体"热度在回落 |
| `/zimeiti-xuanti` | 自媒体选题 | woshipm、B 站、飞书、知乎、Notion 模板 | 可做 |
| `/geren-ip-dazao` | 个人IP打造 | rogerwustudio DR 0.6 排第 1、36kr、kolr DR 46 | 可做 |
| `/geren-pinpai` | 个人品牌怎么打造 | woshipm、Shopify 中文、Reddit、sarawithyou DR 3.6 | 中等；相关搜索偏"自创品牌" |
| 不单独做 | 自媒体定位 | 第一页被解析成"媒体 + 定位"，结果混乱 | 并入其他页的 H2 |

**繁体候选（gl=tw；`/zh-tw`）**

| 地址（建议） | 目标词 | 盘面 | 判断 |
| --- | --- | --- | --- |
| `/zh-tw/ig-jingying` | IG 經營 / IG 經營教學 | ig-hero.com DR 9 排第 1；henrywen DR 21；portaly DR 76；2fish DR 12 | 可做 |
| `/zh-tw/zimeiti-zenme-kaishi` | 自媒體怎麼開始 | 換日線；soler DR 24；eleanorfilm DR 18；storyofdream DR 6 | 可做 |
| `/zh-tw/zimeiti-dingwei` | 自媒體定位 | 2017 年老文第 1；posty DR 2.1；lessismore DR 14；dir-beck DR 3；design-lab DR 1.3 | 极易 |
| `/zh-tw/geren-pinpai-jingying` | 個人品牌怎麼經營 | sarawithyou DR 3.6 排第 1；chouamy DR 19；shacho DR 2.1；henrywen DR 21 | 可做 |
| `/zh-tw/shequn-jingying` | 社群經營教學 | vgvasia DR 20；shacho DR 2.1；kufu DR 2.9；posty DR 2.1 | 极易；趋势里最冷 |
| `/zh-tw/threads-jingying` | Threads 經營 | lw-marketing DR 52；domyweb DR 17；2fish DR 12；shiningmktg DR 8 | 可做；英文 threads strategy 只有 10/月，中文独有 |
| `/zh-tw/zimeiti-bianxian` | 自媒體變現 | inawang DR 35；henrywen DR 21；eleanorfilm DR 18；2fish DR 12 | 可做，偏后期 |

谷歌趋势相对热度（不是量）：美国简体 自媒体 ≫ 小红书运营（0.42×）> 个人品牌（0.28×）> 个人IP（0.19×）；台湾繁体 自媒體 ≫ 個人品牌 > 內容行銷 > 社群行銷 > 社群經營。

## 附录 C · 排期与评估指标（预期区间，不是承诺）

| 阶段 | 时间 | 做什么 | 完成标志 |
| --- | --- | --- | --- |
| 0 地基 | 上线前 2–4 周 | 单主机迁移；语言路径 + hreflang；统一元数据 / JSON-LD / sitemap / robots；公开页去 force-dynamic；中文首页 + 简体、繁体第一批页面；About；OG 图；GSC / Bing 验证 | 全部页面过第 13 节检查单 |
| 1 收录 | 上线第 1–4 周 | 撤 noindex 和临时 307；提交 sitemap；GSC 每天请求编入索引 ≤ 10 个；AI 目录站 10–20 个；创始人社媒上线帖 | `site:www.graylum.com` 能搜到全部公开页 |
| 2 铺内页 | 第 5–12 周 | 中文第 2 批页面；博客每周 1 篇；按"有曝光无点击"改 title；首批外链 20–40 个引用域 | KD < 30 的词进前 30；DR 10–15 |
| 3 见排名 | 第 4–6 个月 | 复测盘面；补内容和内链；第二批中文页；AI 引用月检；视英文界面进度决定 `/en` | 3–5 个词进前 10；500–2000 访问/月；DR 15–25 |
| 4 扩张 | 第 7–12 个月 | 中文大词和工具页；`/en` 第一批（附录 A）；按注册转化调整 | 10 个以上词进前 10；2000–8000 访问/月 |

依据：哥飞 2023-12-29 群聊"用 6 个月的时间把排名做上去"；社群帖（袁锐钦 2026-04-05）"前 3 个月大部分悄无声息，第 4 个月才有流量"。

每月看 6 个数：已收录页数（GSC 索引）；曝光 / 点击 / 平均排名（GSC 效果）；目标词排名（GSC 查询 + 每月 SERP 复测）；DR（Ahrefs 免费检查器）；AI 引用（5 个固定问题）；自然流量注册数（后台加来源标记）。

## 附录 D · 待定与存疑

- 已定 A（中文优先）；待定：首页核心词和第一批页面的取舍（等规划师中文搜索量）。
- 公开页免登录试用：暂缓（Owner 2026-10-12）。
- 中文搜索量已用 Semrush 补上（附录 B）；Semrush 无数据的词只有盘面判断。首页核心词和第一批取舍仍待 Owner 按附录 B 的结论确认。
- 香港繁体词汇未查；日语只预留路径。
- 对哥飞资料库的存疑：llms.txt 效果（第 11 节）；HowTo 结构化数据已过时（第 10 节）；"301 不用 308"不作为规则（谷歌两者都当永久跳转）。
