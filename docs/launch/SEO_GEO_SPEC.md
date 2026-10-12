# Graylum 全站 SEO / GEO 规范

> 版本：2026-10-12 第 1 版（规划窗口起草）。
> 适用：所有不需要登录就能看到的页面（首页、功能页、关键词页、博客、价格页、法律页、About）。登录后的 `/app` 和 `/admin` 一律不索引，不适用第 4–12 节。
> 以后每个新增或改动公开页的 PR 都必须按本文执行，并在 PR 描述里过第 13 节的检查单。
> 决定状态：第 2 节（单主机）、第 3 节（中文优先的语言路径、首页写法、繁体枢纽页核心词、第一批页面）和第 14 节（博客）都是 Owner 2026-10-12 已批准的决定。
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
| 其他主机 | `graylum.com`（裸域）、`app.graylum.com`、`http://` 一律**永久跳转（308，Next.js `permanent: true` 的默认值，保留请求方法和请求体；谷歌把 301 和 308 同等视为永久）**到 www。`app.graylum.com` 上**只有搬进 `/app` 的界面路由**加前缀（`app.graylum.com/` → `www.graylum.com/app`，`app.graylum.com/positioning` → `www.graylum.com/app/positioning`）；`/auth/*`、`/api/*`、`/admin/*`、`/_next/*` 和登录入口页（`/login` 等，见下一行）保持原路径只换主机（`app.graylum.com/auth/callback` → `www.graylum.com/auth/callback`），在途的登录链接和支付回调不能落到不存在的 `/app/auth`、`/app/api`。支付回调的 `POST` 不能依赖跳转：切换前先在 Waffo / Stripe 后台把 webhook 主机改成 www，跳转只是兜底，并用带请求体的 `POST` 实测跳转后方法和内容不变。裸域 `graylum.com/任意路径?参数` → `www.graylum.com/同一路径?同一参数`（保留路径和查询参数）：在 `next.config.ts` 用 `has: host = graylum.com` 实现，或在 Vercel 把裸域设成跳转到 www（正式环境设置属 AGENTS §1）；两者选一并实测。重定向长期保留 |
| 登录后页面 | 需要登录的界面全部在 `/app/...`，**包括现在根路径的已登录首页**（`src/app/page.tsx`，读个人资料、资料库和积分）——它搬到 `/app`，根路径 `/` 改成公开首页；`/admin/...` 保持；`/api/...`、`/auth/callback` 位置不变 |
| 登录入口页 | `/login`、`/register`、`/verify-email`、`/forgot-password`、`/reset-password` 留在根路径，**不进 `/app`**：未登录也能打开，邮件里的验证和找回链接才能用；它们 `noindex`。实现时同时测“未登录能打开登录页”和“未登录打不开 `/app/*`、被送到 `/login`”两种情况 |
| 索引范围 | `/app`、`/admin`、`/auth`、登录入口页、`/maintenance`、`/access-denied` 永远 `noindex`（响应头 + meta），不受 `SITE_INDEXING` 开关影响。`SITE_INDEXING` 不是 `public` 时（staging、预览、本地），**整个环境的所有响应都保留 `X-Robots-Tag: noindex, nofollow`**，再加 robots `Disallow: /`——只靠 Disallow 挡不住被外链指向的地址进结果。只有 `SITE_INDEXING=public` 的正式环境才放开公开页。**robots.txt 不 Disallow 这些 HTML 路径**：谷歌要读到 `noindex` 才能不收录，被 robots 挡住反而可能只收地址不收内容（Google 文档 block-indexing）。robots 只 Disallow `/api/`；`/_next/static`、`/_next/image` 是公开页渲染用的 JS / CSS / 图片，**必须允许抓取** |
| Cookie | 单主机后登录 Cookie 改为 host-only，不再用 `.graylum.com` 共享域。**不能只改作用域**：老浏览器里还留着 `.graylum.com` 上同名的旧 Cookie，和新的 host-only Cookie 并存时浏览器端可能先读到旧的，造成登录状态错乱或循环跳登录（`proxy.ts` 注释已记录这个现象）。切换时要把旧 Cookie 迁移或过期：在 www 上读到 `.graylum.com` 的本项目 Cookie 时，写入 host-only 新值并把旧的设为过期（扩展现有 `legacyParentCookieNames`，让它在正式主机上也生效）。实施时测：已登录的老用户切换后不掉线、不循环、退出后两份都清掉 |
| staging | `auth-staging.graylum.com` 本来就是单主机，套用同一套按路径的规则 |

迁移的技术清单见第 14 节；开发由总控另派，本文不含代码改动。

## 3. 语言与路径（已批准：中文优先）

**目标市场只有三类**（Owner 2026-10-12 原话：「香港放弃不做。集中做简体+台湾繁体+英文，就这 3 个群体。」）：简体中文（海外大陆背景华人，谷歌 `gl=us`、`hl=zh-CN` 口径）、台湾繁体中文（`gl=tw`）、英文（美国）。香港不做目标市场，繁体页一律用台湾用语。

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
| `<html lang>` | 根路径 `zh-Hans`；`/zh-tw` 下 `zh-Hant-TW`；`/en` 下 `en` |
| `openGraph.locale` | `zh_CN` / `zh_TW` / `en_US` |
| sitemap | 一个 `sitemap.xml`，按语言分组，每条带 `alternates` |

共同规则：
- 不按浏览器语言自动跳转（爬虫会被跳走）；可在页顶放语言提示条。
- 不用 `?lang=` 参数，不用子域名做语言。
- 每个有对应语言版本的页都写全 `hreflang`：`zh-Hans`、`zh-TW`（台湾繁体，只面向台湾）（+ 将来的 `en`）+ `x-default`；只在确实有翻译版时写，不能指向不存在的页。
- 简体和繁体不是互译：词、平台（小红书 / 抖音 vs IG / Threads）、第一页对手都不同，各按各的 SERP 写。简体面向海外大陆背景华人（Google `gl=us`、`hl=zh-CN` 口径）；繁体只面向台湾（`gl=tw`），用台湾用语。
- 英文页上线时同样不是中文页的翻译，按附录 A 的英文词另做。

### 3.2 第一批公开页（已批准）

Owner 2026-10-12 先批准过 11 页的版本（原话：「同意：根路径简体，首页 H1 用"AI 自媒体教练"；/zh-tw 核心词自媒體；第一批繁体 7 页 + 简体 4 页按附录 B」）。同日 Owner 用 Google Ads 关键字规划师导出了三地中文搜索量，交叉核对后改为 7 页，Owner 原话：「按这份清单改规范」；随后 Owner 决定放弃香港，最终为下面 6 页。取代 11 页和 7 页版本。

中文第一批 6 页，全部是台湾繁体（地址、目标词和依据见附录 B）。原清单里的香港 1 页（`/zh-tw/kol`）按 Owner 同日"香港放弃不做"的决定去掉：
- 台湾 6 页：`/zh-tw/`（枢纽页，自媒體）、`/zh-tw/zimeiti-jingying`（如何經營自媒體 + 自媒體經營 + 經營自媒體）、`/zh-tw/shequn-xingxiao`（社群行銷）、`/zh-tw/shequn-jingying`（社群經營）、`/zh-tw/ig-jingying`（IG 經營 + 如何經營 IG）、`/zh-tw/zimeiti-kecheng`（自媒體課程，转化页）。
- 简体 0 页：根路径只做首页；简体获客靠 YouTube / 小红书，见附录 C。
- 英文按附录 A 的第 1 批 8 页，等 `/en` 上线。

地基（单主机、元数据组件、sitemap、robots、JSON-LD、About）与页面并行，先做地基。

### 3.3 首页与繁体枢纽页（已批准）

- 简体首页 `/`：
  - Title（给搜索引擎）：`Graylum – AI 自媒体工具：定位、选题、写内容的 AI 自媒体陪跑教练`，一次覆盖"自媒体 / AI 自媒体 / 自媒体 AI 工具"三种真实写法。
  - H1（给用户）：`你的 AI 自媒体陪跑教练`（Owner 2026-10-12 选定）。
  - "自媒体"（美国规划师 100–1K/月，难度 59.7，维基和百度百科占前两位）只作长期词自然出现在 Title 和首屏，不指望早期排名。
- 繁体枢纽页 `/zh-tw/`：按"第二个首页"做，核心词 **自媒體**（规划师：台湾 1K–10K），页内回答"自媒體是什麼"（台湾 1K–10K）。Title 带"自媒體"和"AI 自媒體"；H1 `你的 AI 自媒體陪跑教練`。所有繁体内页用"自媒體"做锚文本回链它。"自媒體經營"一族归 `/zh-tw/zimeiti-jingying`，枢纽页不抢这个词，避免两页争同一个词。全部用台湾用语（社群、小編、短影音、IG 經營），不用香港说法（社交媒體、KOL、數碼營銷）。
- 用词依据（2026-10-12 实测）：
  - "AI 自媒体教练 / 自媒体教练 / 自媒體教練"在简体、台湾都没有搜索量，自动补全只有一个人名——"教练"在中文里不是搜索词，只作差异化说法放在 H1。
  - "AI 自媒体 / AI 自媒體"Semrush 未收录，但简体和台湾的自动补全都有长尾（课程、工具、创业系统、事务所），是正在冒头的词，放 Title。
  - "社交媒体策略 / 策略师 / 社媒策略 / 社群策略 / 社交媒體策略"在简体、台湾都没有搜索量、自动补全为空，是英文 social media strategy 的直译，**中文页不用**。品牌定位句"AI 社媒策略师"只用于英文版和品牌介绍。
  - "陪跑"见附录 B：规划师在美国简体里"自媒体陪跑 / 陪跑教练"不到 10 次，台湾"自媒體陪跑 / 陪跑教練 / 陪跑課程"10–100 次；它是华人创作者圈卖真人服务的说法（价格从几万到 20 万台币），只作 H1 和文案用词，不作搜索目标。
- 英文首页词（`social media coach`，附录 A）只在 `/en` 上线时用于英文首页。
- 中文市场的流量预期和获客分工见附录 C：YouTube 中文频道是主引擎，SEO 页是承接层。

## 4. 地址（URL）规则

1. slug 只用小写字母、数字、连字符，就是目标词本身，例如 `/zh-tw/ig-jingying`、`/en/find-your-niche`。不加日期、分类前缀、`.html`、尾斜杠。
2. 中文页的 slug 用拼音或英文（`/xiaohongshu-qihao`、`/zh-tw/ig-jingying`），不用汉字（分享时会变成百分号编码）。
3. 地址定了不改；必须改时用永久跳转（308）并更新 sitemap 和内链，不留重定向链。
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
| `robots` | 公开页 `index, follow`；`/app`、`/admin`、`/auth`、登录入口页 `noindex, nofollow`，响应头和 meta 都写，并且**不在 robots.txt 里 Disallow**（见第 11 节） |
| `keywords` | **不写**（哥飞《从 TDK 到 TDH》2024-04-06）；现有代码里的删除 |
| `<html lang>` | 按页面语言 `zh-Hans` / `zh-Hant-TW` / `en`，不写死 |

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
- 上面放行的搜索类爬虫和 `*`：只 `Disallow: /api/`；上面拒绝的训练类爬虫保持 `Disallow: /`，不受这一条影响。`/_next/static`、`/_next/image` 不能挡——谷歌要用它们渲染公开页（Google robots.txt 指南：不要屏蔽影响页面理解的资源）。`/app`、`/admin`、`/auth`、登录入口页**不写 Disallow**，靠 `noindex` 头和 meta 挡索引——谷歌只有抓到页面才能读到 `noindex`。
- 末尾：`Sitemap: https://www.graylum.com/sitemap.xml`。
- 说明：拒绝 `GPTBot` 不影响 ChatGPT 搜索引用（那是 `OAI-SearchBot`）；拒绝 `Google-Extended` 不影响谷歌搜索和 AI Overviews（那用 Googlebot）。
- `SITE_INDEXING` 不是 `public` 时仍然整站 `Disallow: /`，**同时所有响应保留 `X-Robots-Tag: noindex, nofollow`**（staging 和预览永不索引；被外链指向时也不进结果）。

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
- [ ] 进入 sitemap；robots 允许；`/app`、`/admin`、`/auth`、登录入口页仍返回 `noindex`
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
| `apps/web/src/proxy.ts` | 去掉按主机名分流；改成按路径：`/app/*`、`/admin/*` 需登录，其余公开；登录入口页和 `/auth/callback` 留在根路径且公开；根路径直接渲染首页 | 登录和权限，high |
| `apps/web/src/lib/site-config.ts` | `PUBLIC_SITE_HOSTS / SHARED_COOKIE_HOSTS / DEFAULT_AUTH_APP_URL / normalizeAppOrigin` 简化为单主机；Cookie 改 host-only，并按第 2 节迁移 / 过期 `.graylum.com` 旧 Cookie（`legacyParentCookieNames` 在正式主机上也生效）；`buildAuthHref` **不加前缀**（登录、注册、验证邮箱、找回密码都留在根路径）；`buildAppHref` 只给搬进 `/app` 的应用路由加前缀，公开地址不加；现在退出登录后跳 `/landing` 的调用方（`AppHeader`、`ProfileSidebar`、`workspace-frame`）改成跳 `/` | 登录态，high |
| `apps/web/src/lib/public-paths.ts` | 公开为默认，`/app` `/admin` 需登录 | 权限 |
| 旧应用路径跳转 | www 和 staging 主机上，旧的应用路径 `/positioning`、`/runtime`、`/profile`、`/library`、`/marketplace`、`/workbench`（含子路径）308 到 `/app/` 下同一路径，保留参数；登录回调里的 `next` / `redirect` 目标经 `sanitizeRedirectTarget` 时把这些旧路径换成 `/app/...`，默认目标从 `/profile` 改成 `/app/profile`；`next=/` 登录后去 `/app`（`/` 现在是公开首页）。实测：切换前发出的验证邮件 / OAuth 链接在切换后点开，落到 `/app` 下正确页面 | 登录态，high |
| 路由目录 | 根路径已登录首页 `src/app/page.tsx`（及同目录的 `home.module.css`、`home-steps`）移到 `src/app/app/page.tsx`；`positioning / runtime / profile / library / marketplace / workbench` 移到 `src/app/app/`；`login / register / verify-email / forgot-password / reset-password / auth / admin / api` 不动；全仓约 45 处内链、21 个文件改前缀（不含测试） | 面广 |
| `next.config.ts` | `redirects()` 加 `has: host = app.graylum.com` 的 `permanent: true`（308，保留 POST 方法和请求体）：界面路由加 `/app` 前缀，`app.graylum.com/` 到 `/app`，`/auth` `/api` `/admin` `/_next` 和登录入口页只换主机不加前缀（第 2 节）；加 `has: host = graylum.com` 到 www 的 308（保留路径和参数），或改用 Vercel 设置（见第 2 节）；`X-Robots-Tag noindex`：`SITE_INDEXING` 不是 `public` 时**整个环境保留**；是 `public` 时只对 `/app` `/admin` `/auth`、登录入口页、`/maintenance`、`/access-denied`，这些路径不进 robots Disallow。测试覆盖：裸域跳转保留路径和参数；非 public 环境任意路径都带 noindex；public 环境下上述路径带 noindex、公开页不带 | ordinary |
| 环境变量 | `NEXT_PUBLIC_APP_URL`、`NEXT_PUBLIC_AUTH_APP_URL` = `https://www.graylum.com` | 正式环境改值属 AGENTS §1 |
| 支付回调 | `waffoCheckout.ts`、`stripeCheckoutIntent.ts` 的 successUrl 从请求 origin 拼，自动跟随；Waffo / Stripe 后台 webhook 主机**先**改成 www（路径不变），再切域名；用带请求体的 POST 实测 app 域跳转后方法和内容不变 | 正式环境属 §1；staging 由 AI 改 |
| Supabase Auth | Site URL 改 www；Redirect URLs 加 `https://www.graylum.com/**`、删 app 域；邮件模板不改；Google OAuth 不改 | 正式环境属 §1；staging 由 AI 改 |
| Vercel | 两个域名已在同一项目；撤掉 Owner 手动加的 `www → app` 临时 307（第 8.5 节、#614） | 正式环境属 §1 |
| 测试 | `proxy-hostname / proxy-auth / proxy-auth-landing / proxy-pricing / site-config / authLanding.gotrue` 6 个单测和 `production-stripe-smoke.spec.ts` | ordinary |

建议拆两个 PR：① proxy / site-config / 路由前缀（high）；② robots / noindex / redirect / sitemap（ordinary）。

---

## 附录 A · 英文关键词数据（后备，`/en` 上线时用；2026-10-12 核实）

口径：搜索量以 Google Ads 规划师美国口径（2025-09～2026-08 月均）为准，Semrush（美国库，2026-10-12）作交叉核对；KD = 哥飞版难度（10-11/12 计算），Semrush KD 另列。两种难度不是同一口径，不比大小。

**英文首页核心词**（`/en` 首页用）：`social media coach`——规划师 320，Semrush 390；哥飞 KD 49.9，Semrush KD 29；第 4 名 thesocialmediacoach.com.au 是 DR 20 首页。备选 `ai social media manager`（720 / 880，哥飞 47.1，Semrush 27，盘面是排程工具首页）。`social media strategy for beginners` 两边都只有 10–20，不用。

**英文第 1 批（8 页，地址在 `/en` 下；`/en` 上线前这些地址不存在，不写进 sitemap 或 hreflang）**

| 地址 | 目标词（合并的同义表达） | 规划师 / Semrush | 哥飞 KD / Semrush KD | 盘面最弱占位 | 功能 |
| --- | --- | --- | --- | --- | --- |
| `/en/what-to-post-on-instagram` | what to post on instagram（+ what should i post on instagram） | 880 / 480 | 26.9 / 22 | 第 3 名 DR 8 | 选题 |
| `/en/what-to-post` | what to post（+ what to post on social media） | 170（近半年涨到 390）/ 70 | 18.7 / 3 | 第 2 名 DR 8 | 选题总页 |
| `/en/how-to-become-a-content-creator` | how to become a content creator with no experience（远期升级 how to become a content creator 2,400–2,900） | 260 / 210 | 15 / 29 | 第 3 名 DR 1 | 定位 |
| `/en/social-media-strategy-for-small-business` | social media strategy for small business | 110 / 210 | 16.5 / 46 | 第 8 名 DR 8 | 定位；Semrush 认为更难，盯盘面 |
| `/en/how-to-grow-on-instagram` | how to grow on instagram + how to grow followers on instagram organically | 590 + 880 / 720 + 12.1K（Semrush 虚高，以规划师为准） | 27.7 / 33、21 | 第 1 名 reddit 帖 | 策略 |
| `/en/find-your-niche` | find your niche + finding your niche + how to find your niche | 320 + 170 + 260 / 390 + 140 + 590 | 32–37.9 / 35–43 | 第 4 名 DR 17 | 定位 |
| `/en/content-pillar-examples` | content pillar examples | 320 / 170 | 28.1 / 27 | 第 7 名 DR 33 | 选题 |
| `/en/personal-brand-coach` | personal brand coach + personal branding coach | 110 + 140 / 110 + 210 | 27.6、34.5 / 3、10 | 第 2 名 DR 2 | 转化页 |

**第 2 批（`/en` 上线后 6–12 周）**：how to grow on tiktok（390 / 590，哥飞 36.9，Semrush 38）；what to post on tiktok（480 / 320，39 / 24）；what to post on facebook（140 / 210，32.3 / 30）；how to monetize social media（170 / 170，36.8 / 33）；instagram growth strategy（720 波动大 / 210，23.8 / 22）；instagram post ideas（1,300 / 1,600，哥飞 47.8 / Semrush 26，Semrush 认为容易，从第 3 批提上来）。

**第 3 批（DR ≥ 25 后）**：personal brand strategy（210 / 170，Semrush KD 50）；how to get followers on instagram（4,400 / 3,600，Semrush KD 55）；social media content strategy（390 / 1.3K，Semrush KD 62）；how to build a personal brand（590 / 2.9K，43）；personal brand examples（1,300 / 1.0K，33）；what to post on linkedin（320 / 720，37）、linkedin content strategy（210 / 390，42）；ai social media manager（720 / 880）；instagram caption generator（2,900 / 6.6K，46，做成工具页）；social media audit（880 / 2.4K，45；另有 audit template 1.3K / 35）；content strategy（3,600，57）。

**不做**：social media content plan（720 / 1.0K，Semrush KD 64）；instagram captions 67.5；best time to post on instagram 61.1；hook generator 59.1；social media post ideas 55；personal brand statement 50.3；brand voice 67.8；social media strategy template 61.3；brand positioning 61.3；positioning statement 58.5；niche marketing 57.5；content pillars 57.1；content strategy template（意图跑偏）；niche finder 全族（YouTube 数据工具词）；social media scheduler / planner 类目词。

## 附录 B · 中文关键词数据与第一批依据（2026-10-12）

**数据来源和读法**：
- **主数据：Google Ads 关键字规划师**（Owner 2026-10-12 导出，2025-09～2026-08 月均）。免费账号只给区间：CSV 里的 50 = 10–100，500 = 100–1K，5000 = 1K–10K，空白 = 不到 10。
- 哥飞版 KD：难度，只说明竞争，不说明有人搜。
- 谷歌下拉提示：谷歌只提示有一定搜索量的词，作为"有人搜"的独立信号。
- 谷歌第一页：用来判断意图（搜的人是不是想自己做自媒体）。
- Semrush 中文估算只作参考：它的中文库按分词存（"自 媒體 經營"有数、"自媒體經營"没有），和规划师常有出入。
- 谷歌趋势**不用**于这批中文词：它们热度低到接近谷歌统计下限，5 年对比里几乎每周都是 0，小数是取整噪音。
- 入选规则：规划师 ≥ 100–1K，或"规划师 10–100 + 下拉提示 + 第一页有专门页"；且意图对、难度可接受。上线后用 GSC 真实数据决定加码或停止（第 8 周规则见附录 C）。

**用语**：台湾说"自媒體 / 社群 / 小編 / 短影音 / IG 經營"；美国华人说"社交媒体 / 自媒体 / 运营"。两套词不能互译。（香港说"社交媒體 / KOL / 數碼營銷"，香港已按 Owner 2026-10-12 决定放弃，不做目标市场。）

**市场总量（这批词规划师区间代表值合计）**：台湾约 28,400 / 月；美国简体约 2,150 / 月（30 个词只有 2 个过 100）。

### 台湾（gl=tw，中文繁体）

| 页面 | 目标词 | 规划师 | 哥飞 KD | 依据 / 盘面 | 批次 |
| --- | --- | --- | --- | --- | --- |
| `/zh-tw/`（枢纽页） | 自媒體；页内回答 自媒體是什麼 | 1K–10K；1K–10K | 30.8；20.7 | 第一页有 DR 2 的站 | **第一批，本市场唯一必做** |
| `/zh-tw/zimeiti-jingying` | 如何經營自媒體 + 自媒體經營 + 經營自媒體 | 各 100–1K（如何經營近 3 个月 +900%） | 6.1–20.4 | 同一需求合一页；第一页有 DR 2 的站 | 第一批 |
| `/zh-tw/shequn-xingxiao` | 社群行銷 | 1K–10K（同比 +900%） | 15.6 | 第 1 名 DR 20，前十有 DR 2–3 | 第一批 |
| `/zh-tw/shequn-jingying` | 社群經營 | 100–1K | 7.1 | 第一页十几个专门页，有 DR 2 | 第一批 |
| `/zh-tw/ig-jingying` | IG 經營 + 如何經營 IG（技巧、課程放页内） | 各 100–1K | 9.6 | 第 1 名 DR 10，第 3 名 DR 2；下拉有 起步 / 教學 / 技巧 / 賺錢 | 第一批 |
| `/zh-tw/zimeiti-kecheng` | 自媒體課程（转化页：AI 陪跑 vs 上课；陪跑 / 陪跑教練 / 陪跑課程放页内） | 100–1K（陪跑一族 10–100） | 9.6 | 搜的人准备付钱学；第一页有 DR 3 | 第一批 |
| `/zh-tw/duanyingyin-xingxiao` | 短影音行銷 | 100–1K | 17.4 | 第 3 名 DR 5 | 第二批 |
| `/zh-tw/duanyingyin-jiaoben` | 短影音腳本 | 100–1K | 开工前补查 | 和产品"写口播稿"对口 | 第二批 |
| `/zh-tw/geren-pinpai` | 個人品牌 | 100–1K | 29.7 | 第 5 名 DR 4 | 第二批 |
| `/zh-tw/zimeiti-shouru` | 自媒體收入（變現、賺錢放页内） | 100–1K（變現、賺錢 10–100） | 18.5（變現） | — | 第二批 |
| `/zh-tw/ai-shequn-xingxiao` | AI 社群行銷 | 100–1K | 30.6 | 第一页多是政府课程，最弱 DR 32 | 第二批 |

不做：自媒體顧問、陪跑顧問、自媒體怎麼開始（规划师都不到 10）；社群小編（100–1K 但是求职意图）；網紅行銷（100–1K 但是品牌方找网红）；自媒體行銷（100–1K 但近 3 个月 -90%）；自媒體平台、自媒體教學（10–100，意图不对）。Threads 經營、自媒體定位、YouTube 經營、小紅書經營、AI 自媒體（各 10–100）等 GSC 出现相关查询再考虑。

### 美国（gl=us，中文简体）

| 词 | 规划师 | 哥飞 KD | 判断 |
| --- | --- | --- | --- |
| 自媒体 | 100–1K | 59.7 | 维基、百度百科占前两位；只作首页文案 |
| 社交媒体 | 100–1K | — | 意图未知，不做 |
| 小红书运营、小红书起号、小红书文案生成器、自媒体怎么做 / 选题 / 变现 / 运营 / 是什么、TikTok / YouTube / Instagram 运营、个人 IP、个人品牌、海外自媒体 | 各 10–100 | 小红书运营 5、自媒体怎么做 11.9 | 不做 SEO 页 |
| 自媒体定位、自媒体陪跑、陪跑教练、自媒体怎么开始 | 不到 10 | 自媒体定位 20.2 | 不做 |

**简体结论**：第一批不做内页，根路径只做首页。`/xiaohongshu-yunying`（小红书运营，难度 5）和"小红书运营 Skill"页（2026 年新出现的下拉词，第一页全是 GitHub 技能包）留作后备，等有 YouTube / 小红书社交流量时当落地页用，不当 SEO 页。

## 附录 C · 排期与评估指标（预期区间，不是承诺）

| 阶段 | 时间 | 做什么 | 完成标志 |
| --- | --- | --- | --- |
| 0 地基 | 上线前 2–4 周 | 单主机迁移；语言路径 + hreflang；统一元数据 / JSON-LD / sitemap / robots；公开页去 force-dynamic；简体首页 + 台湾繁体第一批 6 页；About；OG 图；GSC / Bing 验证 | 全部页面过第 13 节检查单 |
| 1 收录 | 上线第 1–4 周 | 撤 noindex 和临时 307；提交 sitemap；GSC 每天请求编入索引 ≤ 10 个；AI 目录站 10–20 个；创始人社媒上线帖 | `site:www.graylum.com` 能搜到全部公开页 |
| 2 铺内页 | 第 5–12 周 | 中文第 2 批页面；博客每周 1 篇；按"有曝光无点击"改 title；首批外链 20–40 个引用域 | KD < 30 的词进前 30；DR 10–15 |
| 3 见排名 | 第 4–6 个月 | 复测盘面；补内容和内链；第二批中文页；AI 引用月检；视英文界面进度决定 `/en` | 3–5 个词进前 10；500–2000 访问/月；DR 15–25 |
| 4 扩张 | 第 7–12 个月 | 中文大词和工具页；`/en` 第一批（附录 A）；按注册转化调整 | 10 个以上词进前 10；2000–8000 访问/月 |

依据：哥飞 2023-12-29 群聊"用 6 个月的时间把排名做上去"；社群帖（袁锐钦 2026-04-05）"前 3 个月大部分悄无声息，第 4 个月才有流量"。

**中文市场的流量上限（按附录 B 的规划师区间算，2026-10-12）**：台湾第一批 6 页的目标词每月合计在数千到一万多次之间（区间数据，只能到量级），做到前三名也只分到 20–30%，第 4–6 个月乐观估计每月几百到一千多次访问；美国简体这批词合计约 2,000 次，所以第一批不做简体内页。上表第 3、4 阶段的访问数在 `/en` 上线前要按这个口径下调。**结论：中文市场不能纯靠 SEO 获客**——华人创作者学运营、找工具的入口是 YouTube、小红书、微信群、Threads，不是谷歌中文。中文获客以 Owner 的 YouTube 中文频道为主引擎（小红书、Threads 同步），SEO 页作为承接层：视频和帖子里的链接落到对应的关键词页，页面负责把人送进产品；频道带来的外链、品牌搜索和第三方提及同时服务 SEO 和 GEO（第 12 节）。英文（`/en`）才是搜索量大的那一边（附录 A 第一批合计约 4,000/月），等英文界面上线后启动。

**每页的验证规则**：第 2–4 周确认收录（`site:` 能搜到）；第 8 周看 GSC 里这一页的展示和点击——展示为 0 判定没人搜、停止投入；有展示且平均排名在 20 名以内就加码（补内容、加内链、在 YouTube 视频里放链接）；有点击就看注册转化。转化页（自媒體課程）主要看点击到注册的比例。枢纽页在 GSC 里实际带来展示的查询词，是下一批的选词来源。

每月看 6 个数：已收录页数（GSC 索引）；曝光 / 点击 / 平均排名（GSC 效果）；目标词排名（GSC 查询 + 每月 SERP 复测）；DR（Ahrefs 免费检查器）；AI 引用（5 个固定问题）；自然流量注册数（后台加来源标记）。

## 附录 D · 待定与存疑

- 已定：目标市场三类（简体、台湾繁体、英文，香港放弃）；A（中文优先）、首页写法、繁体枢纽页核心词、中文第一批 6 页（第 3、3.2、3.3 节，取代 11 页和 7 页版本）。
- 公开页免登录试用：暂缓（Owner 2026-10-12）。
- 中文搜索量以 Google Ads 规划师区间为准（附录 B），Semrush 只作参考；短影音腳本的难度开工前补查。
- 2026-10-12 另有一份网页版哥飞 Agent（DeepSeek）生成的"中文词机会表"，用谷歌趋势小数做裁决；经规划师核对多处不成立（例如"如何經營自媒體"实为 100–1K 且在涨，"自媒體顧問 / 陪跑顧問 / 简体自媒体定位"实为不到 10），本文不采用其裁决。
- 日语只预留路径。
- 对哥飞资料库的存疑：llms.txt 效果（第 11 节）；HowTo 结构化数据已过时（第 10 节）；"301 不用 308"不作为规则（谷歌两者都当永久跳转；本文反而要求 308，因为它保留 POST）。
