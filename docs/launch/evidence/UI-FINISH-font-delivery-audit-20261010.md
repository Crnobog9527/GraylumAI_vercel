# UI-FINISH：字体商用交付核对（2026-10-10）

**大白话结论：线上已知的 168 个 MiSans 字体文件和仓库完全一致，署名、许可 PDF 也确实能从 staging 读到。许可允许免版税使用及出售使用字体创作的作品，官方 FAQ 另明确支持商用和嵌入；但不能因此说“全站字体交付全部通过”。完整部署产物清单未取得，hCaptcha 内部字体未核验。本文只记录原文与技术事实，不作最终法律结论，不改代码，不合并。**

## 1. 本次证据范围

- 授权：#716 中 2026-10-10 的字体商用只读核对；本任务明确要求提交 docs PR 并在审查后停止。
- 最终资源复核：2026-10-10 02:20–02:22（Asia/Shanghai）。域名：`auth-staging.graylum.com`。
- Vercel 项目：`prj_N9BO48YSAYBQ5Nrvzd3WA9wrQEpC`；READY 部署：`dpl_64TZ3rJuS7dLRGXomppg1xH7rKWf`。
- 最终部署源码与观察时 staging：`4c66637ae638733d99bf5c13d01992bbb5eb335a`；下文源码均指此版本。
- 初次观察的旧部署在期间被后台报告模型界面更新替换；字体路径、依赖及政策无变化。本记录对新部署重新完成资源核对，最终复核前后别名一致。API 中的 `target=production` 是独立 staging 项目的部署槽，不是正式站授权。
- 全程未启动浏览器；未登录业务账号、访问数据库、读取密钥、改平台配置或触发部署。公开 HTTP GET 不执行网页脚本。

## 2. 实际部署资源

| 核对 | 结果及范围 |
| --- | --- |
| Vercel 文件树 | **BLOCKED**：`GET /v6/deployments/{id}/files` 返回 404 `File tree not found`；补上已确认的团队范围仍为相同结果，停止该入口。该 API 按官方说明提供部署**源码树**，也不能直接充当完整构建输出清单。[接口说明][files-api] |
| 168 个 WOFF2 | **PASS**：按 [manifest][manifest] 的每个 `file` GET 同源 `/fonts/misans/{file}`；168/168 HTTP 200，实际字节与该源码版本文件完全相等，长度及 SHA-256 同时匹配 manifest。合计 **5,789,224 bytes**，字重 400/500/600。 |
| CSS 与清单闭合 | **PASS**：仓库 168 个 WOFF2、manifest 168 条、部署 CSS 168 条 `@font-face` 的文件集合相等；CSS 全部使用同目录 `./<hash>.woff2`，无外部字体 URL。 |
| 其他交付文件 | **PASS**：CSS、manifest、NOTICE、PDF 均为 HTTP 200，逐字节匹配仓库；连同字体共 **172/172**。摘要见下表。 |
| 编译后入口 | **PASS（局部）**：`/landing`、`/login` HTTP 200；两页引用的 18 个不同静态产物（17 JS、1 CSS）均已读取。JS `35_9cg2-6k1y9.js` 含加载同源 MiSans CSS 的代码；全局 CSS 含 MiSans 字体栈，未含额外 `@font-face`。 |
| 页面声明 | **PASS（HTTP 内容）**：`/landing` 的 HTML 包含“本网站使用 MiSans 字体，版权归小米所有。”及 `/fonts/misans/LICENSE.pdf` 链接，对应 [LandingFooter.tsx:103–107][footer]。不代表浏览器可见性已验收。 |
| 全量排除其他部署字体 | **未证实**：上述是已知资源及两页引用产物核对，不能枚举未知静态文件、所有懒加载包或第三方动态响应。初次固定部署域名探测直接 GET 返回 302，未登录或绕过保护；资源比对使用已确认绑定的公开 staging 别名。 |

全部摘要为 SHA-256；文件路径均在 `/fonts/misans/`：

| 文件 | bytes | SHA-256 |
| --- | ---: | --- |
| `manifest.json` | 272270 | `7eb52cde05e2302c3ede6c5d8d7004b94e59c4075d0c5465da91dcd8f5fe82a5` |
| `misans-4bf5d8a22f58eaab.css` | 244940 | `4bf5d8a22f58eaab6fa0f4ab1e6a1542d27e2cc8e94517c1ac4925ae8cddc5f6` |
| `NOTICE.txt` | 432 | `2e8cea073a64727bb77ff9602e73f096dff1cd9345c89bd6716a2682e5ffd9cd` |
| `LICENSE.pdf` | 79535 | `4a93a27cd2bd81b3b5ecfd0a853144a876fa26938a93a68443c67d74172fcb86` |

复核方法：冻结上述源码，读取 manifest 的每个 `file/bytes/sha256`，GET 同源文件并比较完整响应字节；校验 CSS 引用集合与磁盘集合相等。按文件名排序拼接 UTF-8 的 `file + 空格 + bytes + 空格 + sha256 + LF`，168 项汇总摘要为 `0ffb969d7f13e40816404f2d076dc61e791ea5f71557d0ba622640a040557fbe`。此摘要固定清单，不代替每项线上请求结果。新部署复核中一个字体请求遇 TLS EOF，保留失败后改用串行 curl HTTP/1.1 定点读取并确认一致；编译资源读取同样改用串行 HTTP/1.1 后 18 项全部成功。

## 3. 仓库授权文件逐条核对

来源：[完整 LICENSE.pdf][license]（4 页）、[NOTICE.txt:1–6][notice]。下表的“原文要点”仅来自该 PDF；FAQ 单独列在表后，不能冒充协议条款。

| 问题 | 原文要点与出处 | 目前证据与限制 |
| --- | --- | --- |
| 是否允许商用 | 第 2 页第 2 节：不可转让、非独占、免版税、可撤销、全球版权许可；第 2(3) 项明确可分发或出售使用字体创作的宣传素材、logo、App 等作品。 | 条款包含有偿作品用途；不是无条件售卖、再许可字体本身的授权。当前作为网站界面字体使用。 |
| 是否允许网页嵌入 | 第 1 页第 1.3 节将下载、复制等列为“使用”；第 2 页第 2 节授予使用许可，但 PDF **没有逐字写出网页、WOFF2 或 `@font-face`**。 | 不把推断写成明示网页条款；嵌入用途另有官方 FAQ 说明，见下。 |
| 是否要求署名 | 第 2 页第 2(1) 项：“您应在软件中特别注明使用了 MiSans 字体。” | 落地页代码、HTTP HTML 均已有该声明；条款没有要求每个登录后页面都显示。实际可见性 NOT_RUN。 |
| 是否保留声明 | 第 2 页第 2(4) 项：任何字体副本中保留版权声明和本协议。 | 仓库及线上同目录均有完整 PDF、NOTICE；NOTICE 写明小米版权。并列文件是否充分满足“任何副本”的法律要求不由本记录定论。 |
| 修改限制 | 第 2 页第 2(2) 项：不得改编或二次开发字体或单独组件。 | 本次线上字体与仓库原字节相等，未改字体。清单记载官方分包来源；此前官方 168/168 比对是 [#716 历史记录][prior]，本次未重新下载官方全部字体，不能把本次部署比对说成新的上游原样证明。 |
| 分发限制 | 第 2 页第 2(3) 项：禁止单独租赁、再许可、给予、出借、进一步分发、重新分发或售卖字体及组件；使用字体创作的其他作品不受此项限制。 | 当前通过网站同源资源交付，公开仓库也包含字体；没有据此新增字体包分发功能。公开仓库及可单独下载的 WOFF2 如何适用本项，列为需要 Owner 或律师确认。 |
| 其他条件 | 第 2(5) 项禁止违法用途；第 3 页第 5 节允许违约时终止许可；第 4 页第 7.1 节称本协议取代此前相关陈述、宣传或许可。 | 本记录不核定所有使用场景，也不作永久、不可撤销或完整法律合规承诺。 |

**补充官方说明（本次 HTTP 文档读取）：**[小米 FAQ][faq] 的“MiSans Global 需要付费吗？”说明可在任何平台、商业项目免费商用；“是否可以用作嵌入式字体？”回答可以，仍须在软件中注明 MiSans。FAQ 支持商用及嵌入用途，但没有消除上述分发及保留声明条件；如需法律签字，须确认它对当前 MiSans 官方分包及具体网页交付方式的适用。

## 4. 其他字体来源

扫描该版本全站 `apps/web/src`、`public`、依赖声明与锁文件，区分字体下载、系统回退和图形图标。源码入口为 [layout.tsx][layout]、[misans-font.tsx:7–20][loader]、[globals.css:41–42][globals]。

| 来源 | 发现及授权情况 |
| --- | --- |
| MiSans | 唯一已确认下载的本站字体家族；授权见上节。manifest/NOTICE 的小米 URL 是来源记录，当前加载器只请求同源 CSS，并不请求官方字体服务。 |
| 中文/界面系统回退 | PingFang SC、Hiragino Sans GB、系统 UI（`-apple-system`、`BlinkMacSystemFont`）、Segoe UI、Microsoft YaHei、sans-serif：只声明名称，无本站字体文件或下载入口。本次不分发它们，不核定用户设备自身字体许可。 |
| 等宽系统回退 | JetBrains Mono、Fira Code、SF Mono、Consolas、Liberation Mono、Menlo、monospace：同样只声明名称；未打包对应字体，不将名称出现当作字体授权或实际命中证据。 |
| Google Fonts / Geist / Adobe / Fontsource / 图标字体 | 源码与锁文件未发现相应字体引入，全部受跟踪的 168 个字体文件都属于 MiSans；两页已读取产物未发现 Google/Adobe/小米外部字体服务请求地址。不是完整部署排除证明。 |
| Lucide 图标 | `lucide-react@1.16.0` 使用 SVG，不是图标字体。本机同版本包无字体文件或字体 CSS；其 `LICENSE` 为 ISC，列出的 Feather 派生图标另附 MIT。两者要求保留相应版权和许可。只记录软件许可，不代替整站软件声明交付审计。 |
| Radix / shadcn、Recharts、Sonner、Tailwind | 核对锁定版本的 26 个直接 Radix UI 包，以及 `recharts@3.7.0`、`sonner@2.0.7`、`tailwindcss@4.3.0`：本机同版本包无 WOFF/TTF/OTF/EOT 或 CSS `@font-face`，LICENSE 为 MIT（Sonner 为 `LICENSE.md`）。shadcn 是仓库内组件代码，未发现附带字体。MIT 允许使用和分发但要求保留声明；没有发现额外字体许可对象。 |
| hCaptcha | [authCaptcha.ts:1][captcha]、[dialogCaptcha.ts:16–29][dialog-captcha] 动态加载外部脚本并创建控件/iframe。**内部字体名称、文件及授权 UNKNOWN**；没有运行验证挑战、没有获取控件运行时资源，不能宣称全站没有第三方字体。 |
| 搜索建议 iframe、监测脚本 | [search-status.tsx:10][search-frame] 的内联 CSP 为 `default-src 'none'`，未开放字体；根 layout 引入 SpeedInsights。未发现本站字体声明，不将第三方未来动态响应纳入“无字体”保证。 |

组件包检查是本机已安装包与锁文件的**版本一致**核对，不是部署包完整性证明；尝试读取 npm 包时遇 TLS EOF，未重复请求，改用现存同版本本地材料。扫描共 30 个 UI/样式包（包含 Lucide），不声称递归审完全部依赖。全站 CSP 的 `font-src 'self'` 在 [next.config.ts:14–31][config] 中是 **Report-Only**，不能拿它证明第三方字体已被阻止。

## 5. 缺口、建议与交接

1. **技术证据未闭合**：完整 READY 构建输出清单未取得；当前可证明 168 个已知线上字体及声明匹配，不能证明没有未知字体产物。建议后续取得该部署完整构建输出再补排除核对，不能用重建另一份本地产物冒充这一部署。
2. **需要 Owner 或律师确认**：PDF 第 2(3)(4) 项对公开仓库、网页同源字体文件分发及并列 NOTICE/PDF 的适用；官方 FAQ 对当前分包/网页方式的说明是否足够。建议保留已有署名与许可，不在未确认前改字体或新增独立分发承诺。
3. **第三方边界**：hCaptcha 内部字体未知。需要供应商字体/许可说明或另行获准的运行时证据，不能签成已逐一核验。
4. **验证**：172 项 HTTP 字节核对、CSS/manifest/磁盘集合核对、18 个公开构建资源读取及本地代码大小检查 PASS；完整输出枚举 BLOCKED；浏览器计算样式/实际字形、登录后及第三方控件运行时 NOT_RUN（本任务禁止浏览器）。CI 与独立审查的最终状态记录在本 PR，不能由本记录预先宣布通过。
5. **交接**：只新增本文，风险 ordinary（事实记录，不改变规则、产品承诺或运行行为）。将 PR 转为可审查，读取独立结论、修正文档中的 P0/P1 后停止；不合并、不部署、不把字体核对扩大为 UI-FINISH 整体完成。

[manifest]: https://github.com/Crnobog9527/GraylumAI_vercel/blob/4c66637ae638733d99bf5c13d01992bbb5eb335a/apps/web/public/fonts/misans/manifest.json
[license]: https://github.com/Crnobog9527/GraylumAI_vercel/blob/4c66637ae638733d99bf5c13d01992bbb5eb335a/apps/web/public/fonts/misans/LICENSE.pdf
[notice]: https://github.com/Crnobog9527/GraylumAI_vercel/blob/4c66637ae638733d99bf5c13d01992bbb5eb335a/apps/web/public/fonts/misans/NOTICE.txt
[footer]: https://github.com/Crnobog9527/GraylumAI_vercel/blob/4c66637ae638733d99bf5c13d01992bbb5eb335a/apps/web/src/components/landing/LandingFooter.tsx#L103-L107
[layout]: https://github.com/Crnobog9527/GraylumAI_vercel/blob/4c66637ae638733d99bf5c13d01992bbb5eb335a/apps/web/src/app/layout.tsx
[loader]: https://github.com/Crnobog9527/GraylumAI_vercel/blob/4c66637ae638733d99bf5c13d01992bbb5eb335a/apps/web/src/components/misans-font.tsx#L7-L20
[globals]: https://github.com/Crnobog9527/GraylumAI_vercel/blob/4c66637ae638733d99bf5c13d01992bbb5eb335a/apps/web/src/app/globals.css#L41-L42
[captcha]: https://github.com/Crnobog9527/GraylumAI_vercel/blob/4c66637ae638733d99bf5c13d01992bbb5eb335a/apps/web/src/lib/authCaptcha.ts#L1
[dialog-captcha]: https://github.com/Crnobog9527/GraylumAI_vercel/blob/4c66637ae638733d99bf5c13d01992bbb5eb335a/apps/web/src/lib/dialogCaptcha.ts#L16-L29
[search-frame]: https://github.com/Crnobog9527/GraylumAI_vercel/blob/4c66637ae638733d99bf5c13d01992bbb5eb335a/apps/web/src/app/chat/search-status.tsx#L10
[config]: https://github.com/Crnobog9527/GraylumAI_vercel/blob/4c66637ae638733d99bf5c13d01992bbb5eb335a/apps/web/next.config.ts#L14-L31
[prior]: https://github.com/Crnobog9527/GraylumAI_vercel/issues/716#issuecomment-6039781633
[faq]: https://hyperos.mi.com/font/zh/faq/
[files-api]: https://github.com/vercel/sdk/blob/main/docs/sdks/deployments/README.md#listdeploymentfiles
