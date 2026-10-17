# DATA-ERASURE 核对清单：日志与备份 30 天、第三方删除流程

> 只是清单。没有向任何外部服务发删除请求，没有改任何平台设置，没有读正式项目。
> 依据：[DATA-ERASURE.md](../launch/tasks/DATA-ERASURE.md) E7（日志最多 30 天、备份最多 30 天，实施时逐个副本确认，超出由 Owner 决定）、
> 附录 B、附录 C；公开资料 **2026-10-12 读取**，附录 C 的来源编号 [S1]–[S11] 沿用。
> staging 事实都是只读查询得到的（Supabase CLI 只读查询、Vercel 项目变量**只看名字**），正式环境一律写"未核实"。

每一行的"状态"只用三种：**已核实**（有本次查询或配置证据）、**未核实**（需要有权限的人去看）、**缺口**（已经确定达不到 E7，或者没有清理机制）。
供应商的公开说明只证明供应商的通用做法，不证明本项目已经按这个配置。

## 清单一：日志和备份最多保留 30 天（E7）

| # | 副本 | 本项目现状 | 平台公开说明 | 状态和缺口 | 谁来处理 |
| --- | --- | --- | --- | --- | --- |
| L1 | Supabase 数据库备份（每日备份） | staging：`supabase backups list` 返回空列表，PITR 未开（2026-10-12）。正式：未核实 | 每日备份：Pro/Team/Enterprise 可访问 7/14/30 天；数据库备份不含 Storage 文件 [S8] | staging 已核实（没有可恢复的每日备份）。正式环境的套餐和备份窗口未核实。Pro 的 7 天在 30 天以内；Enterprise 的 30 天正好到上限 | 正式库建好后由总控只读核对套餐，Owner 决定套餐 |
| L2 | Supabase PITR | staging 未开。正式未核实 | 可选 7/14/28 天 [S8] | 正式环境如果开，选 28 天以内的档位才满足 E7 | 同上 |
| L3 | Supabase 平台日志（API、Auth、Postgres 日志） | 未核实套餐 | 可查询窗口：Free/Pro/Team/Enterprise 为 1/7/28/90 天 [S8] | Enterprise 的 90 天超过 E7，用 Enterprise 前要请 Owner 决定。访问窗口不等于平台内部所有副本的销毁时间 | Owner 定套餐时一并确认 |
| L4 | 数据库里的日志表 | staging 只读计数（2026-10-12）：`application_logs` 0 行；`user_activity_logs` 22 行，最早 09-26；`diagnostic_results` 390 行，最早 **09-14**；`ai_usage_logs` 309 行，最早 09-26；`scheduled_job_runs`（定时任务执行记录，含错误和任意 `summary`）15 行，最早 09-30 | — | **缺口**：0148 删掉了 `cleanup_old_logs` 以后，没有任何通用的日志定期清理；staging 上 pg_cron、pg_net 都没装。`diagnostic_results` 已经存了 28 天，再过两天就超过 30 天。`scheduled_job_runs`（0017，只追加、没有任何删除路径）也没有到期清理。**已由 #867（迁移 0226）补上**：`application_logs`、`diagnostic_results`、`scheduled_job_runs` 每天删除超过 29 天的行。`user_activity_logs`（管理员审计，含积分调整和 PAYG 计量复核证据）**不算日志**：Owner 2026-10-12 原话："同意管理员审计记录（user_activity_logs）按账务记录保留 3 年，不按 30 天日志清理。" 到期清理随账务 3 年到期清理一起做（上线后）。`ai_usage_logs` 属于账务，注销时清正文、按 3 年账务保留，不算日志 | #867 |
| L5 | Supabase Storage 文件的备份 | 未核实 | 数据库备份不含 Storage 文件 [S8]；Storage 自身是否另有备份，公开资料未写 | 未核实。需要问 Supabase 或看套餐说明 | 上线前核对 |
| L6 | Vercel 运行日志（函数 stdout/stderr） | staging 为 Hobby（EXECUTOR.md 记录）。正式未核实。Log Drains：staging 团队查询返回 404，没有看到已配置的转存 | Hobby 1 小时、Pro 1 天、Enterprise 3 天；Observability Plus 30 天 [S7] | Hobby/Pro 都在 30 天以内。买 Observability Plus 正好 30 天。**以后加 Log Drains 会把日志转到第三方，必须先补那一家的保留期** | 升级 Pro 时确认没有开超过 30 天的附加项 |
| L7 | Vercel 构建日志 | 每次部署都有 | 构建日志随部署长期保存（Vercel 社区和文档的说法） | **Owner 2026-10-12 已定：不含用户数据，不在承诺范围**（构建时不读用户数据） | — |
| L8 | Vercel Analytics | ANALYTICS PR-2 起代码里挂了 `<Analytics />`：只在 Vercel 生产模式部署、配置了 Termly、并且 Termly 判定可以统计时才加载（`NEXT_PUBLIC_VERCEL_ANALYTICS_CATEGORY=essential` 时不等同意）；上报前网址换成路由模板、只留登记过的 utm，登录验证页不上报。项目里是否打开 Web Analytics 未核实（Owner 平台设置） | 默认聚合，session hash 24 小时 [S11] | 自定义事件里不能放用户正文 | 前端改动时注意 |
| L8b | Vercel Speed Insights | ANALYTICS PR-2 起和 L8 一样按 Termly 同意门控，上报的网址换成路由模板、去掉参数，登录验证页不上报（以前在生产模式部署里无条件上报真实网址） | 保留期未查到 | 未核实：项目里是否已启用、保留多久 | 上线前核对 |
| L9 | Sentry 错误事件、性能追踪、会话回放 | staging 项目设了 `NEXT_PUBLIC_SENTRY_DSN`、`SENTRY_ORG/PROJECT`，staging 在上报。#865 起三处（浏览器、服务端、Edge）都在上报前脱敏，会话回放已关闭；#888 起改为白名单：事件只保留列出的字段（错误码、按路由模板处理的网址、代码位置、环境和版本、模型名和用量），其余字段和自由文本一律丢掉。`SENTRY_OTLP_TRACES_URL` 变量代码里没有引用，用途待总控核实 | 错误事件：Developer 30 天，Team 和 Business 90 天，按上报时的套餐计算 [Sentry 文档]；部分备份最多 90 天 [S11] | 保留期：**Owner 2026-10-12 已定：第三方例外，写入隐私条款**。内容：已核实（单元测试覆盖各类泄露情形）；staging 真实事件待 Owner 在 Sentry 抽查 | Owner 抽查 staging 事件；OTLP 变量由总控核实用途 |
| L10 | Upstash Redis（限流） | staging 变量里有 `UPSTASH_REDIS_REST_URL/TOKEN` 和 `REDIS_URL`。限流键里带用户编号，比如 `account-erasure:<用户编号>`。`apps/web/src/lib/rateLimit.ts` 和 `packages/api/src/services/redisRateLimiter.ts` 的限流器都开了 `analytics: true` | 限流计数键按窗口过期；但 `@upstash/ratelimit` 2.0.8 的 analytics 会把传入的标识（含用户编号）写进统计桶，库里写死保留 `90d`。Upstash 控制台审计日志记录的是账号操作，免费库 7 天、按量 30 天、Pro 1 年 | **缺口**：analytics 统计里的用户编号保留 90 天，超过 E7，注销也不会删它。需要关掉 analytics，或者改成不带用户编号的标识，或者在 30 天内清掉 | 新开代码任务（见缺口汇总第 6 条） |
| L11 | 邮件（Resend，作为 Supabase Auth 的 SMTP，Tokyo 区） | 用于验证码和找回密码邮件 | Resend 定价页：各套餐"数据保留 30 天"（2026-10-12 读取） | 在 30 天以内。已经发到用户邮箱的邮件我们删不掉 | — |
| L12 | 手动导出、本机下载的备份 | 规则禁止 AI 下载正式备份 | — | 有人手动导出过的话必须登记并在 30 天内删除；目前没有登记表 | 总控在运行手册里加一行"导出要登记" |

**从备份恢复以后怎么办（E7、§8）**：恢复只能先恢复到隔离环境，开放读写之前，要把注销和单条删除重新执行一遍。
但旧备份里的 `account_erasure_requests` 只包含备份那一刻已有的请求；**备份之后才确认的注销不在里面**，只重放恢复出来的表，会把这些账号的旧内容放出来。
所以必须有一份**存在数据库以外**、持续更新的最小删除清单，恢复时导入并重放；拿不到这份清单就不能开放服务。清单不放内容，但要够重放：账号注销记请求编号、账号编号、确认时间；单条删除（对话、成果、资料库文档等）还要记删除类型和目标编号（`content_erasure_confirm` 和资料库删除都要靠它们定位）。每条记录要保留到它之前的所有备份都过期为止。
**进展**：库外删除清单已由迁移 0227 补上（存 Upstash Redis，只记类型、目标编号、账号编号、确认时间，35 天过期），恢复步骤见 [从备份恢复后重放删除](DATA_ERASURE_BACKUP_RESTORE_REPLAY.md)。注销请求编号不记，重放时用新的请求编号。整个恢复流程也**还没有演练过**（T15/T16），staging 没有每日备份，暂时演练不了。

## 清单二：第三方删除流程

规则（附录 C）：**先停止新的发送 → 保留对账需要的编号 → 删掉我们自己的副本 → 通过官方渠道申请删除 → 记录结果**。
删掉 Graylum 这边的记录，不等于删掉了对方的数据。注销一个用户，不会删掉 Graylum 在供应商那里的账号。
**本清单不授权发送任何删除请求**；真正对外发送属于 AGENTS.md 第 1 节"向外部账号发送内容"，要 Owner 同意。

| 供应商 | 发给它的用户数据 | 对方保留期（公开说明） | 删除渠道 | 我们这边怎么删 | 记录方式 |
| --- | --- | --- | --- | --- | --- |
| OpenRouter | 提示词、回答（经它转发给模型供应商） | 默认不记录提示词和回答，但保留用量、延迟等元数据；每个模型线路的政策不同 [S1] | 账号设置里的数据政策；联系 OpenRouter 支持 | 注销清除提示词和回答，账务只留调用编号和费用（已实现） | 每次调用已记供应商编号；对外删除请求按下方模板记录 |
| 各模型供应商（经 OpenRouter） | 同上 | 各线路自己的保留期，不训练不等于不保存 [S1] | 一般只能经 OpenRouter 申请；直接联系各家需要单独核实 | 同上 | **缺口**：RUNTIME-PROD 要求每个启用线路记官方政策链接、读取日期、保留期和联系渠道，目前还没有这张表 |
| Google（直连 Gemini） | 旧对话链路（`apps/web/src/app/api/ai/stream/route.ts`）在模型的供应商设为 `google` 时，会绕过 OpenRouter，把完整对话和系统提示直接发给 `generativelanguage.googleapis.com` | 未核实（取决于用的是哪种 Google API 条款） | 未核实 | 同 OpenRouter：注销清除我们这边的提示词和回答 | **缺口**：这条直连线路不在 OpenRouter 的政策范围里。**在 LEGACY-CLOSE 删掉这条链路之前，不得在后台启用 `google` 直连供应商**（总控 2026-10-12）；链路下线后这一行可以删掉 |
| TikHub | 查询词、链接 | API 使用日志 12 个月；账号终止后资料 90 天；支付记录 7 年 [S2] | 隐私政策里的联系邮箱 | 注销时删掉查询、链接和返回的证据（研究证据接入注销是 RESEARCH-TOOLS 的验收项） | 12 个月超过 E7，但这是对方保存 Graylum 账号的调用日志，我们只能申请；申请结果记录下来 |
| Parallel | 搜索的问题和目标 | Search 产品标明零保留、不训练；账号、IP、客服资料另按业务需要保留，没有固定天数 [S3] | 隐私政策联系渠道 | 同上 | 核实我们用的线路是否适用零保留 |
| Firecrawl | 抓取的网址和结果 | 个人信息一般保留到书面删除请求为止；零保留只在企业版 [S4] | 书面删除请求 | 删掉抓取的网址、结果、截图和缓存 | 普通接口不能当成自动清除 |
| Waffo（收款，商户方） | 付款时用户自己填的资料、交易记录 | 按用途和争议期限保留，期限后再加两个月；部分备份最多 90 天；可以申请提前删除，有例外 [S5] | 隐私政策联系渠道 | 订阅和退款先在原渠道处理完，再删我们这边不必要的客户字段；只留交易、收据、退款的最少字段 | 对方作为收款商户保留的部分我们删不掉，如实记录 |
| Stripe（含 MP 和大陆卡） | 付款资料、交易记录 | 可以申请删除个人资料，但监管要求的支付记录会继续保留 [S6] | Stripe Privacy Portal | 同上；不为注销去删商户账号 | 同上 |
| Resend | 收件邮箱、邮件内容（验证码、通知） | 数据保留 30 天（定价页） | Resend 支持；控制台可查单封邮件 | 注销后不再给该地址发邮件；我们这边不存邮件正文 | 30 天以内自然过期，一般不用单独申请 |
| Sentry | 错误码、按路由模板处理的网址、代码位置、环境和版本（白名单，见 L9） | 30 或 90 天（看套餐） | Sentry 控制台可以删除单个问题和事件；也可以联系支持 | 上报前白名单脱敏已完成（#865、#888，见 L9），事件里不含能定位到个人的内容，所以注销时不需要逐条删 Sentry 事件；万一发现漏网事件，再按左列渠道删除。保留期按 Owner 决定作为第三方例外写入隐私条款 | 若要删除个别事件，记录事件编号（不记内容） |
| hCaptcha（人机验证，登录、注册和注销弹窗都会用） | 用户浏览器直接把 IP、浏览器信息和验证数据发给 hCaptcha，不经过我们的服务器 | 隐私政策：IP、浏览器等技术数据尽快丢弃，但最多可保留到 cookie 过期后一年；发现滥用时更久。终端用户的请求要找网站方（我们），hCaptcha 不直接处理（2026-10-12 读取 [hCaptcha Privacy](https://www.hcaptcha.com/privacy)） | 网站方发邮件到 hCaptcha 支持邮箱申请删除，45 天内答复 | 我们这边不保存 hCaptcha 的验证数据；令牌由 Supabase Auth 校验一次 | 对方最长保留一年，超过 E7：**Owner 2026-10-12 已定：第三方例外，写入隐私条款**（原话："保留期选 A：第三方例外写进隐私条款；同意上线前补日志清理、限流统计清理、库外删除清单和 Sentry 脱敏。"）；不按用户逐个申请删除 |
| Upstash | 限流键（含用户编号）、计数 | 键按我们设的过期时间失效 | 我们自己删除键，或等待过期 | 注销后键会按窗口过期；如有不过期的键要补删除 | 不需要对外申请 |
| Google（GA4，ANALYTICS） | 浏览器在访客同意统计后直接发给 Google：随机 `client_id`（Cookie 里的假名编号）、页面路由模板（不含编号和参数）、来源域名、登记过的 utm、设备和大致地区、`sign_up`/`positioning_complete`/`begin_checkout` 事件；Google 另外处理 IP、设备和大致位置。`client_id` 和 IP 属于假名或技术个人数据。不发邮箱、用户编号、订单号 | GA4 后台保留期按 ANALYTICS O6 设 2 个月（Owner 操作，未核实） | GA 管理接口可按 `client_id` 删除，但按 O10 选 B 我们不保留账号和 `client_id` 的对应关系 | 注销不需要也无法按账号删 GA 数据，靠 2 个月保留期到期；按 O10 写入隐私条款。付款成功 `purchase` 由服务器发（迁移 0286）：结账时浏览器给的 GA 编号只存在 `analytics_checkout_ids`（不进结账请求和 Stripe），付款上报时取出即删、只在结账有效的 45 分钟内可用、未取的每日删除、撤回统计同意时删除、注销时随账号删除；撤回时间记在 `analytics_consent_withdrawals`，注销时一并删除；交易号是一次性随机值，不是订单号 | 不需要逐个申请 |
| Termly（同意弹窗） | 访客的同意记录（同意编号、时间、选择、IP 和浏览器信息），由浏览器直接发给 Termly | 按 Termly 政策，开账号后核对（未核实） | Termly 后台和支持渠道 | 同意记录是合规证据，按 Termly 规则保留 | 不按用户申请删除 |
| Vercel（Web Analytics、Speed Insights，见 L8、L8b） | 页面路由模板（已去参数）、来源、国家、设备、性能指标；不用 Cookie | 访客识别哈希 24 小时；报表窗口按套餐 | 等待过期 | 不放个人信息，不需要按用户删除 | 不需要申请 |
| Vercel | 运行日志（可能含请求网址和错误） | 1 小时到 3 天，看套餐 [S7] | 等待过期；没有逐条删除 | 日志里不写用户正文、邮箱、完整网址 | 自然过期，不需要申请 |
| Supabase | 数据库、Storage 文件、Auth 账号、平台日志、备份 | 见清单一 L1–L5 | 我们自己用服务端接口删除；备份等过期 | 注销执行器已删除数据库内容、存储对象和 Auth 账号（staging 10-11 那条已核实） | 执行器在 `account_erasure_requests` 记录时间 |

**对外删除请求的记录模板**（存在内部记录里，不写进公开仓库或 PR，因为会带账号信息）：

```text
注销请求编号（request_id）/ 单条删除编号：
供应商：
我们这边能对上的编号（调用编号、订单编号，不写正文）：
申请时间和渠道：
对方回复（时间、内容要点、承诺的期限）：
结果：已确认删除 / 部分保留（写对方给的理由和期限）/ 待对方处理
```

没有收到对方确认的，只能写"待第三方处理"，不能写成完成。

## 发现的缺口汇总（需要另外立项或请 Owner 决定）

1. **日志表没有定期清理**（L4，Owner 已同意上线前补）：由 #867（迁移 0226）处理 `application_logs`、`diagnostic_results`、`scheduled_job_runs`。`user_activity_logs` 按 Owner 决定作为账务审计保留 3 年，随账务到期清理一起做（上线后）。
   注意 cron 每天只跑一次：如果按"超过 30 天就删"写，刚跑完那一刻写入的行最多会留将近 31 天。删除线要设在 29 天（留出一天的运行间隔），或者提高运行频率。
2. **Sentry**（L9）：上报前脱敏已由 #865 补上，后续 PR 改为白名单；90 天保留期 Owner 已定为第三方例外，写入隐私条款。`SENTRY_OTLP_TRACES_URL` 的用途待核实。
3. **模型线路政策表**还没有（清单二）；旧对话链路的 Google 直连不在 OpenRouter 范围里，LEGACY-CLOSE 删除这条链路之前不得在后台启用。
4. **正式环境**的 Supabase 套餐、备份、PITR、日志窗口都未核实（L1–L3），等正式库建好后只读核对。
5. **从备份恢复后重放删除**（库外删除清单 Owner 已同意上线前补）：缺一份存在数据库以外的最小删除清单（否则备份之后才注销的账号、才删除的对话和文档会被恢复出来；单条删除要记删除类型和目标编号），整个流程也没有演练（T15/T16）。清单本身已由迁移 0227 补上（见[重放运行手册](DATA_ERASURE_BACKUP_RESTORE_REPLAY.md)），演练和正式环境备份窗口核对仍未做。
6. **Upstash 限流 analytics**（L10，Owner 已同意上线前补）：统计里的用户编号保留 90 天，注销不删。要关掉 analytics、改用不带用户编号的标识，或者 30 天内清掉。
7. **hCaptcha** 技术数据最长保留一年：Owner 已定为第三方例外，写入隐私条款。
8. **Vercel 构建日志**（L7）：Owner 已定不含用户数据、不在承诺范围；**Speed Insights**（L8b）未核实。

## 公开资料补充（2026-10-12 读取）

- Sentry：[Data Retention Periods](https://docs.sentry.io/security-legal-pii/security/data-retention-periods)（错误事件 Developer 30 天、Team 和 Business 90 天，按上报时的套餐）。
- Resend：[Pricing](https://resend.com/pricing)（各套餐"Data retention 30 days"）。
- Vercel：[Hobby plan](https://vercel.com/docs/plans/hobby)、[Runtime Logs](https://vercel.com/docs/logs/runtime)（运行日志 Hobby 1 小时、Pro 1 天、Enterprise 3 天）。
- Upstash：[Audit Logs](https://upstash.com/docs/common/account/auditlogs)（控制台审计日志保留期）。
- 其他来源见 DATA-ERASURE.md 附录 C 的 [S1]–[S11]。
