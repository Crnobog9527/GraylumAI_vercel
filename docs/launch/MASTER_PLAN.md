# Graylum Master Plan v12 — 产品全貌、现状与施工顺序

> 整理日期：2026-09-27，依据 staging `d2b42e7258876af318cf6814cd94edc161854c4e` 的代码和 GitHub 实时状态。
> 进度同步：2026-09-29，依据 staging `1cf461c1`（含 #510）和 GitHub 实时状态更新第 0、1、2.1、7、8、10 节的进度和 Owner 新决定（见第 7.0 节）；产品规则和验收标准除第 2.1 节新增决定外不变。
> 进度同步：2026-09-30，依据 staging `91a90e39`（含 #536、#541）和 GitHub 实时状态更新第 0、2、3.2、7、8.5、9.2、10、11 节：进度、在途 PR、Owner 已做的决定（第 2.1 节第 22–25 项）和新任务行；不新增产品决定。
> 进度同步：2026-10-01，依据 staging `0470e7a7` 和 GitHub 实时状态，在 [#545](https://github.com/Crnobog9527/GraylumAI_vercel/pull/545) 基础上增量同步计费、内容审核、上线约束和任务进度；仅记录 Owner 已做的决定。
> 进度同步：2026-10-01（PLAN-SYNC-1001B），依据 staging `da4aa6be5084e329d40fb6bb6b760965c91f16e5`，同步 #559 后的 Owner 决定、计费口径、依赖和交付状态；来源及原话见第 2.1 节，合并提交见第 7.0 节。
> 进度同步：2026-10-02（PLAN-SYNC-1002），依据 staging `9cb6cb84cf096de70c4a5b3337db2f5b04406c22`，同步 #566 之后的 Owner 决定（第 2.1 节第 13、24、35–37 项）、#497 冻结 head、PROMPT-CACHE 立项和交付状态；来源及原话见第 2.1 节，合并提交见第 7.0 节。
> 进度同步：2026-10-03（MASTER-PLAN-SYNC），依据 staging `1563a44d66d88faf7a9f69cd080e14b843382c16`（#613）和 GitHub 实时状态，同步 #570 之后到 #613 的合并、迁移 0155–0160 的 staging 应用记录、2026-10-02—03 的 Owner 决定（第 2.1 节第 38–49 项）和施工顺序；还在审或待写的方案标为"方向已定、方案待审/待写"。只记录已有的决定，不改变产品规则的含义。
> 进度同步：2026-10-04（MASTER-PLAN-SYNC-1004），依据 staging `76fee31bd8b4d33c6f59074b2c3b3716efed650c`（#624），只同步 #618 合并后总控评论记录的 Owner 定价和付费墙决定（第 2.1 节第 51 项）及受影响的取代表、第 4 节、第 7.1、7.5、7.6 节任务行和第 10 节；不更新其他进度。
> 进度改为自动生成（2026-10-05，PLAN-PROGRESS-AUTO）：本文从此不再手写进度，任务状态由 `scripts/plan-progress.mjs` 根据第 7.1 节任务表和 GitHub PR 生成（第 7.0 节）；上面各轮"进度同步"只作历史记录。
> 本文是**唯一的当前产品规划**，取代 [v11](Graylum_Master_Plan_v11.md) 的施工顺序和状态描述。v11 及更早文档中仍然有效的详细要求，由第 9 节逐项列明继续适用。
> 本文不授予任何执行权限。仓库操作、风险分级、审查和合并只按 [AGENTS.md](../../AGENTS.md)；具体功能要等 Owner 选定批次后才开工（第 7.4 节）。

## 阅读导航

- [0. 一页总览](#overview)
- [1. 现状](#status)
- [2. 本版的新决定和被取代的旧规则](#changes)
- [3. Agent 对话与定位分析（新交互）](#agent)（第三方搜索和对标研究见 [3.7](#research)）
- [4. Fusion 多模型](#fusion)
- [5. 个人资料库与语料库](#library)
- [6. Skill 的数据基础与未来"自我进化"](#learning)
- [7. 施工顺序](#construction)
- [8. 技术债：核实结果与清理顺序](#debt)
- [9. 继续有效的规则与验收出口](#rules)
- [10. Owner 决定事项](#decisions)
- [11. 文档地图](#documents)

<a id="overview"></a>
## 0. 一页总览

**Graylum 是什么**：给一人公司和社媒新手用的增长教练 Agent。主线是：业务定位 → 按周选题 → 写具体内容（文章 / 视频口播稿，视频再配分镜和剪辑建议）→ 用户发布 → 数据回流和复盘 → 调整下一轮。

**现在到哪了**：以 `node scripts/plan-progress.mjs --ref origin/staging` 生成的进度为准（第 7.0 节）；本文不再手写进度。

最初的问题（2026-09-27）：计费、Runtime、持久会话、定位草稿、周选题和资料库查看编辑的代码都已合并（#419、#421、#422 以及之后 10 个修复 #434–#443）。但 Owner 实际体验后认为定位对话"没有 Agent 感、笨重、慢"。原因已经查清：实现把 Skill 的步骤写成了逐题确认的表单；导师模型默认按最高档思考，导致很久不出字。

**接下来按这个顺序做**：

1. **马上**：合并已经修好的"导师不出字"问题（PR #446）；关掉一个没人用但仍可调用的旧付费接口，删掉会扣积分的临时脚本；把计费和恢复的集成测试放进 CI。
2. **核心体验重做，分几次给你试**：先用真实模型验证"现在的模型能不能驱动提问卡"，做一个你能亲手试的样片；再做完整定位流程；最后推广到自由对话和其他 Skill。
3. **上线基础**：正式环境能真实调用模型（含止损和 BILL-PAYG 逐次冻结、按名义费用结算）、后台配置模型思考强度、第三方搜索和对标研究（基于真实数据）、会员权限、限流修复、账号注销和数据删除。不再做封闭内测，按 D1 范围完成后直接公开上线售卖（2026-10-03，第 2.1 节第 50 项）。
4. **差异化功能**：Fusion 多模型（定稿报告评审、多模型对比），个人资料库和语料库（学习用户文风），输入框的引用和附件。
5. **收费和上线**：Waffo 支付、下线旧对话链路、完整验收、发布。
6. **上线后**：飞书等连接器、社媒数据同步、Skill 的后续学习机制、资料库检索和图片音频。

**不重复建设**：计费（BILL2）、Runtime、持久会话、Skill 版本、成果版本都已存在，新功能在它们上面加最小的工具和界面，不新建第二套钱包、执行链、资料库或记忆系统。

### 术语

| 词 | 意思 |
| --- | --- |
| 运行单 | 一次收费操作的账单，记录这次操作里所有模型调用的成本 |
| 积分冻结 / 预扣 | BILL-PAYG 的新规则：每次模型调用前冻结估算上限与可用余额的较小值，结算扣取本次收费基准与冻结额的较小值、退回多余冻结；单次超出由平台承担（第 2.1 节第 26–27 项）。收费基准是按标价计算的名义费用（第 41 项）。任务尚待实施 |
| 执行 | 模型处理一条消息的一次完整过程 |
| 附属会话 | 挂在主对话下面的隐藏对话，用来跑后台整理或多模型，不打扰主对话 |
| 冻结 | 把当时的输入原样存下来，以后不再改 |
| 重放 | 出故障后用存下来的原输入恢复结果，不重新收费 |
| writer | 当前负责修改某个任务的那个 AI 会话 |
| fail-closed | 保护机制自己出故障时，选择拒绝请求而不是放行 |

<a id="status"></a>
## 1. 现状（2026-09-27 核实，2026-10-03 更新）

> 本节是 2026-10-03 的快照，保留作背景，之后不再更新；当前进度以第 7.0 节的生成结果为准。

| 类别 | 状态 |
| --- | --- |
| 历史基础交付（钱路安全、认证、年付、退款、Stripe 支付、CI、Skill 包加载等，见 [plan-core](plan-core.md) 任务表） | 已交付，继续作为基础；它们的验收仍计入最终验收 |
| 统一计费 BILL2（#419）、Runtime 与持久会话（#421） | 已合并。真实调用目前**只在 staging 测试窗口**开放（最多 8 个白名单用户），正式环境的报价和开放机制还没有。美元统一成本与按模型倍数（BILL-UNIT #565）、OpenRouter 价格快照与准入价格检查（MODEL-PRICING-SYNC）、提示缓存（#591）已合并；边用边扣（BILL-PAYG）方案已定稿，PR-A（#617）在途 |
| 定位草稿、周选题、工作会话、资料库查看和编辑（#422，2026-09-26 合并）及修复 #434–#443 | 已合并。**Owner 产品验收未通过**，由第 3 节新交互重做 |
| 治理规则工具中立化（#444）、工程规范和代码大小检查（#447） | 已合并 |
| PR #446：导师调用关闭默认的最高档思考 | 已合并（2026-09-28）。之后由 MODEL-REASONING 改为后台配置（#480、#494、#495），代码里不再写死模型 |
| 新交互（AGENT-CORE）的服务端基础 AC-0 至 AC1-3、界面 U1/U2、新格式启用 AC1-4 | 已合并（AC-0 至 U2 为 2026-09-28—29；AC1-4 #497 为 2026-10-02，0155 已应用，staging 验收完成，见第 7.0 节）。AC1-5 未开始；右侧整理改为"跟着对话走"（#588 方向 B），B1 #593 已合并 |
| 旧聊天 `/chat` | 入口和发送接口已关闭（#507，2026-09-29）；旧代码留给 LEGACY-CLOSE 删除 |
| 限流和一键暂停（RATE-LIMIT） | 已接线（#594，2026-10-03），B 段 staging 冒烟 PASS；内容审核只留默认放行的检查点 |
| 输入框 A/B/C、Waffo 支付、连接器、社媒同步、Fusion、旧链路代码删除、完整验收、发布 | 未开始（支付公共层 PAY-COMMON 的方案 #608 已合并，PR-1 #612 在途） |

已确认的产品问题（2026-09-27；处理进度：导师模型已换并关闭思考、准备和执行已合并成一个流式请求、旧入口已关闭；JSON 输出和整理挡住输入框的问题由 AC1-4 和 AC-2 解决）：定位流程逐题确认、每题至少两次操作；导师输出被包成 JSON；整理模型和导师排在同一次执行里，输入框要等两者都结束；导师模型 `qwen/qwen3.8-27b` 默认最高档思考，真实测试中 120 秒没有正文；自由对话有新旧两套（`/runtime` 新引擎、`/chat` 旧引擎），个人中心历史、后台、技能广场的模块详情和旧工作台仍链接到 `/chat`。

<a id="changes"></a><a id="conflicts"></a>
## 2. 本版的新决定和被取代的旧规则

### 2.1 Owner 的新决定（2026-09-27 起，2026-10-07 更新）

**2026-10-07：RUNTIME-PROD 正式准入生命周期**

据[出处更正记录](https://github.com/Crnobog9527/GraylumAI_vercel/pull/701#issuecomment-6022130115)，Owner 实际原话为：

- 2026-10-06（OpenRouter 上限）：
  > 所有花费的上限源头都是我的 OpenRouter API，我做了限制，所以你这个测试窗口、准入名单的这些限制其实完全没有任何必要。
- 2026-10-06（到期日与上限）：
  > 同意把测试窗口和准入名单的到期日延到 2027 年底，花费和次数上限放开，以 OpenRouter 的限制为准。
- 2026-10-06（门槛自动化，[#686](https://github.com/Crnobog9527/GraylumAI_vercel/pull/686)，按更正记录摘录，省略号保留）：
  > 我觉得不要手动……这个门槛必须做成自动化适配的机制。

m=6 来自 2026-10-03 本节第 50 项定价决定及其
[确认记录](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5969267583)，
不属于上述三段原话。

2026-10-07 Owner 原话（[决定记录](https://github.com/Crnobog9527/GraylumAI_vercel/pull/701#issuecomment-6023526735)）：

> 同意正式环境的模型准入不设固定到期日，只在换模型、换线路或实时计量检查异常时重新采样；联网搜索的每家第三方供应商（TikHub、Parallel、Firecrawl 等）各自在其平台设置硬上限（预付余额或平台限额），未设置前不开放对应的搜索调用。

本决定明确正式环境的准入生命周期，取代此前将其记为主窗口归纳、尚待产品决定的表述；
上方 10-06 关于 OpenRouter 和 2027 年底的原话保留为测试窗口背景，不作为正式准入的固定期限。
这是已确认的产品要求；文档合并本身不修改现有行为，正式配置及开放仍按上线批准包执行。

正式准入不沿用 staging 测试窗口和 PAYG profile 的固定 expiresAt 作为开放资格到期规则；
仅在换模型、换线路或实时计量检查异常时重新采样，取代将本节 BILL-PAYG r8 测试有效期、`paygHostPolicy.ts`/`paygPolicy.ts`
及 `bill2_payg_validate_quote` 的 expiresAt 契约直接沿用到正式资格的设想；
这些现有 staging 实现仍须在后续实施中保持兼容，本文本同步本身不修改其行为。
staging 测试窗口的到期日与预算、价格快照的新鲜度要求、每 call 执行/恢复时限均不改变。
无到期不扩大既有证据覆盖范围；未覆盖的用途、格式、思考或容量仍不放行。
经 OpenRouter 的正式模型流量采用 OpenRouter 每日限额；第三方搜索供应商（TikHub、Parallel、Firecrawl、
Bright Data 等）各自在其平台设置硬上限（预付余额或平台限额），未设置前对应搜索调用保持关闭。
各供应商具体金额列入上线批准包，不新增平台内部预算计数器；不再把 OpenRouter 限额视为站外费用的保护。
本项只记录已确认的产品决定，不授权实现、生产访问、配置写入、部署或合并。实施边界见
[RUNTIME-PROD 方案](RUNTIME_PROD_PLAN.md)。

- **2026-10-06 BILL-PAYG r9（仅准备）**：主窗口技术决定原话：“Sonnet low 的输出语义改用同一线路的证据来证明，不再要求 low 自己触顶。”[出处](https://github.com/Crnobog9527/GraylumAI_vercel/pull/665#issuecomment-6010007610)。仅Sonnet/anthropic/low采用 `outputSemanticsEvidence: same-route-none`、testedOutputLimit=2048，引用none直接触顶证据，low自身触顶数如实为0；取代对此设置要求两条自身触顶的旧限制，不改其他模型的证据要求或输出/费用硬限。r8第3条费用$0.0076005已确认、原UNKNOWN不计合格。r9只准备12条路由补测；已入账$6.537562065、累计上界<$25，三条Sonnet长样本沿用$0.60例外。

- **2026-10-06 BILL-PAYG r8（仅准备）**：依据[主窗口技术决定](https://github.com/Crnobog9527/GraylumAI_vercel/pull/665#issuecomment-6002163766)，允许 Luna purposes=[organizer, attached_organizer] 与三个已测格式交叉组合，Sonnet/Gemini按相同原则处理；统一有效期为 `2026-10-13T00:00:00Z`，覆盖测试窗口 `2026-10-09T15:59:59Z`。取代r7建议的24小时有效期及用途/格式必须逐对配置的建议限制，不改变真实输出证据要求。r8只准备、不发送；已入账$6.470137565，累计上界<$25。单条上限未因此放宽。

1. **对话交互**：Agent 按 Skill 主导引导；用提问卡提问；步骤完成后 Agent 提示并自动推进；右侧由独立整理模型按 Skill 格式整理，最终生成定位分析报告；体验要快、要流式；步骤和问题不能在宿主代码里写死（第 3 节）。
2. **Fusion**：定稿后由管理员指定的多个模型加载评审 Skill 评审报告，再给出修订后的最终版（2026-09-30 修订：报告 v1 出来后由用户选择是否开启；评审不联网，只用前面已收集的资料；用专用 workspace 里禁用联网的 OpenRouter Fusion，实测不通过评审模式保持关闭上线，不做自研；评审和对比两种模式各有后台总开关，见第 4 节和 D12）；自由对话和其他 Skill 中，用户可以手动开启并自己选择模型并行对比；按会员等级开放，由管理员配置（第 4 节）。
3. **资料库**：成为真正的个人资料库，支持上传自己的文档（第一版 `.txt`、`.md`、`.docx`，见 D6），暂不存图片、音频、视频但留好接口；设"语料库"学习用户文风并用于写作；控制存储和向量成本，不把资料长期放进 OpenAI Vector Store（第 5 节）。
4. **Skill 自我进化**：上线前不必做完，但要找到可行路径并打好数据基础（第 6 节）。
5. **技术债**：重新核实 ChatGPT 的清单，并排出清理顺序（第 8 节）。
6. **D1–D7 按推荐确认**：上线范围、Fusion 计费、对比模型上限、会员默认权限和资料库额度、数据使用同意、文件类型、删除文档时保留用户已有的回答和成果（第 10 节）。
7. **评估后的补充决定**（Fable 5.1 评估之后，第 10 节 D6、D8–D12）：资料库第一版只支持 `.txt`、`.md`、`.docx`；上线基础完成后先做封闭内测；自由对话默认不自动整理；文字表达的明确同意等同于点击确认；后台可以读取并按模型自定义思考强度；Fusion 只用 Graylum 自己开发的，评审和对比两种模式都保留（D12 已于 2026-09-30 修订：评审模式不联网，用专用 workspace 里的 OpenRouter Fusion，实测不通过评审模式保持关闭上线；对比模式仍自己开发）。
8. **正式环境没有真实用户**（Owner 2026-09-27 确认的事实，不是 Agent 核实的结论）：正式环境（`main` 对应的生产项目）没有任何真实用户数据。发布因此不需要保护旧数据，按第 9.3 节执行。
9. **条款由 Owner 另行生成**：隐私条款、服务条款、数据使用政策以及页面上的相关提示文字，由 Owner 用第三方专业软件生成。本规划和各实施说明只规定产品行为和技术保证（例如服务端强制不用于训练、删除和同意的功能），不规定条款文字；规划审查和实施审查都不审计条款文字。
10. **第三方搜索和对标研究**（D13–D15）：接入第三方普通搜索和社媒数据 API，统一接口层；供应商已按 RESEARCH-0 的结果确定（2026-09-28 修订 D13）：社媒数据 TikHub，网页搜索 Parallel，网页抓取 Firecrawl；搜索费用由用户承担；对标分析只基于真实取到的数据（第 3.7 节）。
11. **收费公式**（D16，2026-10-01 修订，原话与来源见第 32–34 项）：所有成本先统一为美元；应收积分 `C = ceil(q × Σ(U_i × m_i))`，其中 `U_i` 是每次调用的美元成本，`q=100`，`m_i` 是本次模型或供应商线路的有效倍数，未单独配置时用默认 `m=6`（2026-10-01 定为 3，2026-10-03 由第 50 项改为 6）。一次收费操作最终只向上取整一次；q 和有效倍数在后台配置并冻结，修改不重算已冻结的执行。实际向用户扣取还受第 26 项余额封顶约束。第三方自家积分、人民币或美元计价均先换成美元，不直接当成 Graylum 积分；旧“固定保底积分直接扣除、不再乘倍数”被取代，由 BILL-UNIT 统一成本口径。TikHub 仍按官方标价计成本，阶梯折扣归平台（D14）。
12. **支付渠道**（D17）：新销售默认走 Waffo，Stripe 作为备用渠道保留。备用是**手动切换**：管理员在后台把"新购买使用的渠道"从 Waffo 改为 Stripe，不做自动切换。同一笔订单不跨渠道重试，付款结果未知时不换渠道再扣。已经通过某个渠道成交的订单，续费、退款和凭证始终走原渠道。


**2026-09-28—2026-10-02 新增及修订的 Owner 决定**（原话和依据见各 PR 评论）：

13. **上线主力模型（当前计划的后台配置）**（Owner 2026-10-01 修订；2026-10-03 按第 50 项澄清）：模型按用途在后台配置（导师、自由对话默认、各 Skill 各自配置），以后台设置为准，方案不规定具体用哪个模型。Owner 当前计划的后台配置是对话和报告用 Claude、Gemini，整理用 GPT-6 Luna，这只是计划值，不作限制；放弃 deepseek-v4.1-flash，staging 也不再使用，取代本条旧模型选择。思考强度同样在后台配置，不写死。Owner 原话（[主力模型](https://github.com/Crnobog9527/GraylumAI_vercel/pull/553#issuecomment-5925575062)、[放弃 deepseek](https://github.com/Crnobog9527/GraylumAI_vercel/pull/553#issuecomment-5925598947)）：

    > 修正一下，网站正式运营上线以后的主力模型肯定是 Claude 和 gemini，整理模型是 GPT-6 Luna。

    > deepseek-v4.1-flash 放弃，staging 都不用了。

    STG-MENTOR-MODEL（[#561](https://github.com/Crnobog9527/GraylumAI_vercel/pull/561)）在 #497 冻结 head 后，于 staging 实测 Gemini 3.8 Flash 和 Claude Sonnet 5.5；方案不代表已实测通过或已切换配置。

    #561 的实测预算 Owner 已批准（2026-10-02，[总控记录](https://github.com/Crnobog9527/GraylumAI_vercel/pull/561#issuecomment-5935911029)）。Owner 原话：

    > 同意 #561 按冻结方案实测：Gemini 最多 46 次/$2.77，Sonnet 最多 46 次/$7.39，Luna 最多 12 次/$0.08，总计最多 104 次/$10.24；单次上限分别 $0.10、$0.27、$0.006；本机累计上限 840 次/$25.24；真实发送入口经总控审过后才开始，不重试、不补样本，结果不明就停；缓存实验另报。

    批准范围（总控记录，不是 Owner 原话）：只覆盖冻结产品 `f9afd0db`、#561 准备记录（head `63c2c522`）里的 104 条请求，以及[总控审阅](https://github.com/Crnobog9527/GraylumAI_vercel/pull/561#issuecomment-5935886740)确定的边界——GPT-6 Luna 整理模型不思考、输出 2048（这是被测的目标配置）；主评测 80 条用单轮夹具，24 条端到端走产品全路径，两类证据分开报告，不能拿主评测结论声称产品全路径通过。**已批准、尚未执行**：真实发送入口的最小改动须推送并经总控审过，之前不发任何真实请求；不改 staging 配置、不改 #497、不合并。缓存实验延后到 PROMPT-CACHE 之后（第 35 项）。

    **后续（2026-10-02）**：导师模型已定为 Claude Sonnet 5.5，#561 已按 Owner 决定关闭、不合并（第 38 项）。

14. **删除规则 E1–E11 已决定**（[DATA-ERASURE 实施说明](tasks/DATA-ERASURE.md)第 9 节，#474）：二次确认后立即注销，没有冷静期；账务记录保留到交易年度结束后 3 年；注销前提示剩余积分作废，付费默认不退款，Owner 可逐笔批准手动退款；日志和备份最多 30 天；非 ZDR 线路可以启用；不设回收站。
15. **旧聊天完全关闭**（#507）：staging 和正式环境都没有真实用户、上线前清空数据，所以不再提供旧对话只读查看入口，旧链接直接跳到 `/positioning`。
16. **新交互的开场也调用整理模型**（AC1-4）：导师开场给出的建议，由整理模型作为"待核对"填进右侧，体验和旧方式一致；每次开场多一次整理调用。
17. **接受一项旧链路影响**（#480）：整理模型选了旧名单之外的模型时，旧成果生成和 agentSlice 会报"整理模型未配置"，不会用错模型或多扣费；这些旧链路随 LEGACY-CLOSE 删除。
18. **数据库结构只由迁移文件决定**（C3 方案 B，#510）：`db:push` 退役，`schema.ts` 只作类型参考；新增 DB-BASELINE 任务补齐基线并做空库建库验证，必须在 V3-M3 / REL-1 之前完成（第 7.1 节、第 9.3 节）。
19. **内容审核暂缓，只先留接口**（Owner 2026-10-01 新决定，[总控记录](https://github.com/Crnobog9527/GraylumAI_vercel/pull/566#issuecomment-5930126786)）。Owner 原话：

    > 内容审核这个功能暂时不用考虑。但可以先留一个接口。

    总控据此安排（不是 Owner 原话）：MODERATION 不再是封闭内测前提，取代原 #510 及 [#559 简化版安排](https://github.com/Crnobog9527/GraylumAI_vercel/pull/559#issuecomment-5918953004)中“封闭内测前输入/输出检查、拦截不收费、记日志”的要求。何时正式实现，公开上线前再请 Owner 决定；此前不接 OpenAI Moderation，不需要 OpenAI 密钥，也不核实价格。旧自研内容检查仍随 LEGACY-CLOSE 删除。

    **MODERATION-HOOK** 随 RATE-LIMIT 接线，由同一写入方在 #497 和 #550 之后实施，不加进 #497：新导师引擎在发送模型之前和完整回复之后各留一个检查点，默认直接放行，用测试证明现有行为不变。不新建表、不调用外部服务、不加配置。接口返回值预留“拦截”，本轮不实现拦截后的不收费、终止状态和日志处理；以后正式实现时补齐，并保证“被拦截”有独立终止状态，不被改写成 `pending`。风险 high（Runtime 调用路径）。

20. **提问卡改为辅助工具**（Owner 2026-09-29，#497 方案）：不是每轮都出卡；只在"要做选择、用户意思不明确"时出卡，方案类卡片推荐其中一项并在正文说明理由，中性的范围或分类卡片不推荐；信息不够时默认在正文里追问，不替用户编造经历、优势、效果或数字；用户说不清时导师可以在正文里举例，但要标明"这是猜测、由你决定"以及为什么要猜，猜测不做成卡片；导师开场不出卡；卡片去掉"我不确定"按钮，末尾固定加"其他"入口；正文和卡片必须一致。第 3.2 节第 2 条随之更新。
21. **是否联网由系统判断**（Owner 2026-09-30，#530）：自由对话的联网不受用户设置限制；以后做一个联网路由，由系统判断这一轮要不要搜索，发生搜索时在对话里展示；后台总开关保留。Fusion 评审不联网，只用前面已收集的资料（第 4 节）。隐私条款以后按定下来的机制再写（第 2.1 节第 9 项）。第 3.7 节和 RESEARCH-TOOLS 随之更新。
22. **带步骤 Skill 的报告改为由模型写**（Owner 2026-09-30，[#497 评论](https://github.com/Crnobog9527/GraylumAI_vercel/pull/497#issuecomment-5909789612)；范围由 [#545 评论](https://github.com/Crnobog9527/GraylumAI_vercel/pull/545#issuecomment-5912946236) 明确为"所有带步骤的 Skill，报告都改由模型写、都收积分"）：所有带步骤的 Skill（3 / 6 / 8 步）在所有步骤确认后，都由模型根据全部信息写完整报告，取代原来"不调用模型、从确认快照确定性汇编"的做法；报告结构由各自 Skill 的报告模板规定（定位 Skill 目前为 13 个部分、正文最多 12000 字）。无步骤的 Skill 不涉及报告，不受影响。实现由 REPORT-GEN 负责（第 7.1 节）；第 3.2 节第 6 条、AGENT-CORE 的 AC-3 随之更新。
23. **导师预算和报告生成立项**（Owner 2026-09-30，同一条评论）：MENTOR-BUDGET 让导师每一轮的输入和输出预算按用途（交互对话、整理、报告）在后台配置，放宽我们代码里的单次模型调用超时和每次请求的时间预算，staging 上限受 Vercel Hobby 单次 300 秒约束，正式运营升级 Pro（2026-10-01，第 28 项），并评估提示缓存；REPORT-GEN 先实测模型写完整报告，超时就分章节或改后台生成。两者都按高风险，A 先 B 后；MENTOR-BUDGET 可以先于 #497 修改重叠的文件，#497 恢复时再同步。
24. **人机验证改为 hCaptcha 隐形模式**（Owner 2026-09-30，#541 已合并）：登录、注册、重发验证邮件、修改密码不再要求用户勾选，由 hCaptcha 在后台判断，只在它认为可疑时出题；**注销弹窗例外**，仍然显示可见的复选框，每次注销都要验证。免费版隐形模式多久出一次题，官方没有写明，要在 staging 实测。另外，Owner 手动测试发现"邮箱未验证的账号登录"这条路径有问题，修复 #543 已合并，后续验证落地页修复 #552 已合并（2026-10-01）。

    **保持 hCaptcha**（Owner 2026-10-01，[总控记录](https://github.com/Crnobog9527/GraylumAI_vercel/pull/569#issuecomment-5936003121)）。Owner 问过能否改用 Vercel 自带的防机器人功能或 Cloudflare Turnstile，听取总控说明后的原话：

    > 保持 hCaptcha 不变

    总控记录（不是 Owner 原话）：Owner 之后自行在 hCaptcha 后台调低了出题档位（原来是 Always Challenge），这是服务商配置，没有改代码；以后不再提议更换人机验证服务商，除非 Owner 主动提出，或者实测发现大陆用户过不了 hCaptcha。
25. **模型写报告收积分，不做运行前预告**（Owner 2026-09-30，[#545 评论](https://github.com/Crnobog9527/GraylumAI_vercel/pull/545#issuecomment-5912684833)）：模型写完整报告收积分，扣费逻辑和正常对话一样，冻结和结算方式已由 2026-10-01 的第 26–27 项取代，收费公式仍遵循 D16；不做运行前预告，也不向用户提示"最多扣多少积分"。评审团模式仍然保留运行前预告（第 4.4 节不变）。这条收费规则适用于所有带步骤的 Skill 的报告（[#545 评论](https://github.com/Crnobog9527/GraylumAI_vercel/pull/545#issuecomment-5912946236)）。

26. **边用边扣采用余额封顶冻结**（Owner 2026-10-01 修订，[来源](https://github.com/Crnobog9527/GraylumAI_vercel/pull/553#issuecomment-5927708649)）。最初的 Owner 原话（2026-10-01，[来源](https://github.com/Crnobog9527/GraylumAI_vercel/pull/547#issuecomment-5915435152)）：

    > 积分改为边用边扣：每次模型调用前只冻结这一次的实际上限，调用后按真实费用结算；余额不足时任务暂停在两步之间，充值后从断点继续；不允许余额变成负数。REPORT-GEN 和第④项按这个模式重新出方案。

    以下后续原话取代上述原话中余额不够冻结这一次完整上限就暂停的口径，其余保证保留：

    > 同意边用边扣采用余额封顶冻结：冻结额取估算上限和当前余额的较小值，实际扣取真实费用和冻结额的较小值，超出部分由平台承担；余额低于一轮正常费用时提示充值。

    每次调用的冻结额 `H_i = min(估算上限对应的积分, 当前可用余额)`；可用余额扣除同一钱包其他正在进行的冻结，在既有钱包锁内计算。实际扣取 `min(真实费用对应的积分, H_i)`，超出 H_i 由平台承担、不补扣；余额不允许为负。可用余额低于启动门槛 **L**（后台按精确模型/用途配置典型名义美元费用，每次 claim 用冻结 q 和本 call 的 m_i 自动计算）才暂停新调用并提示充值，充值后从断点继续、不重复收费；门槛不影响已冻结调用。L=max(1,ceil(typicalUsd×q×m_i))，按 2026-10-06 决定自动适配各调用倍数，不再手动维护积分门槛。不采用按余额缩短回复的方案。

    BILL-PAYG（#553）复用 BILL2，覆盖对话、整理和报告；未知结果保留冻结并按原身份核对，不盲重发。收费按第 11、32–34 项美元成本和逐调用倍数累计，最终只向上取整一次。报告不做运行前费用预告，Fusion 评审预告保留；Fusion 多模型上界定义前不放行。

    原写入顺序见[总控记录](https://github.com/Crnobog9527/GraylumAI_vercel/pull/553#issuecomment-5916263924)，已由本节（第 2.1 节）下述新顺序取代。

    本轮顺序：**#497 → DATA-ERASURE B2a（#550）→ BILL-UNIT（#565）→ BILL-PAYG（#553）→ REPORT-GEN（#547）**，由 Codex 顺序实施；方案在途不等于实施、真实调用或配置变更授权。

    **2026-10-02—03 更新**：#497、#550、#565 已合并；收费基准改为按标价计算的名义费用（上文"真实费用"指本次收费基准，见第 41 项）；当前顺序见第 41、42 项和第 7.2 节。

27. **超出冻结额由平台承担；区分余额封顶和估算异常**（2026-10-01 修订，[余额封顶来源](https://github.com/Crnobog9527/GraylumAI_vercel/pull/553#issuecomment-5927708649)、[模型准入更正](https://github.com/Crnobog9527/GraylumAI_vercel/pull/553#issuecomment-5925575062)、[首版清单](https://github.com/Crnobog9527/GraylumAI_vercel/pull/553#issuecomment-5925598947)）。Owner 原话（2026-10-01，[来源](https://github.com/Crnobog9527/GraylumAI_vercel/pull/553#issuecomment-5916401852)）：

    > 同意：单次调用超出冻结额的费用由平台承担，不向用户补扣。

    在此保证上接续余额封顶修订：超出 H_i 但未超估算上界是正常余额封顶，不进入 `budget_conflict`、不因此停止 run；只有真实成本超出估算上界本身才按异常停止新调用并执行移出收费配置的监控规则。真实供应商成本和平台承担金额全部留存，按模型、用途汇总对账，复用现有记录。

    **总控决定**（2026-10-01，[来源](https://github.com/Crnobog9527/GraylumAI_vercel/pull/553#issuecomment-5925575062)）：收费准入允许“公开分词器证明”或“实测验证 + 监控”任一路径；首版 Claude、Gemini、GPT-6 Luna 走后者，不再要求只有公开分词器数学证明才能收费。实测样本和预算先写方案并获批准；输入、思考、缓存写入和固定费用均须计入上界，联网插件保持关闭。此处不以新规划宣称准入实测已完成。

28. **输出 8192 与正式运营 Pro**（Owner 2026-10-01，[来源](https://github.com/Crnobog9527/GraylumAI_vercel/pull/497#issuecomment-5925811760)）。Owner 原话：

    > 同意把导师交互和报告的单次输出上限从 3584 调到 8192，相应调高单次回复的接收上限；由 #497 的写入方 Codex 实施。 Vercel正式运营的时候我会升级为pro套餐，不用担心。

    导师交互和报告单次输出上限 3584 → 8192，单次回复接收上限同步提高到 139264 bytes；整理用途不变。#564 已合并，staging 的 `runtime_purpose_budgets` 已调至 8192（[总控执行记录](https://github.com/Crnobog9527/GraylumAI_vercel/pull/564#issuecomment-5927680806)）。Hobby 单次 300 秒只约束 staging；正式运营升级 Vercel Pro，实际升级仍是上线前事项，不表示本次修改运行时长或套餐。

29. **邀请奖励三条规则**（Owner 2026-10-01，[来源](https://github.com/Crnobog9527/GraylumAI_vercel/pull/560#issuecomment-5918969524)）。Owner 原话：

    > 同意邀请奖励三条规则：只发给首次获得开户赠送的新账号且每个账号只绑定一次；这次不开启消费返利；接受无法识别完全不同身份的同一个人。

    INVITE-ABUSE #560 已实现，迁移 0154 已应用到 staging；不把不同身份无法识别的接受扩大为其他防刷豁免。

30. **限流初始值与暂停开关**（Owner 2026-10-01，[来源](https://github.com/Crnobog9527/GraylumAI_vercel/pull/562#issuecomment-5926483312)）。Owner 原话：

    > staging 配置好了Upstash Redis，  正式环境还没有，可以要上线前再配置。 同意频率限制初始值：新对话每分钟 10 次、每天 200 次；模型调用每分钟 30 次、每天 600 次；加一键暂停开关。

    新对话 10 次/分钟、200 次/天；模型调用 30 次/分钟、600 次/天；另加一键暂停新调用开关。#562 仅准备切片合并，限流和暂停开关**尚未接线生效**；接线在 #497 和 #550 之后，必须在内测开始前完成。staging Upstash 已配好（Owner 确认）；正式环境上线前再配置，并核对容量与代码所需变量名，不读取密钥值。

31. **长对话原则与查询工具归属**（2026-10-01，[总控决定来源](https://github.com/Crnobog9527/GraylumAI_vercel/pull/497#issuecomment-5926388706)）：保留原始对话记录；每一轮带当前草稿或状态，以及查询工具；不对整段对话做摘要压缩。

    上述原则是总控依据 Owner 2026-10-01 在总控窗口的讨论定下的技术原则，记录见上述链接；没有可引用的 Owner 原话。定位导师的查询工具推迟到 AC-2 / LIB-DOCS，#497 每轮完整带上当前状态、容量不足时拒绝；独立整理角色仍可读取受 inputBytes 限制的 Session 历史，超限裁掉最早部分；“零历史”只适用于定位附属整理器。这些例外不等于对原始记录做摘要替换。

32. **美元统一成本与 q=100**（Owner 2026-10-01，[来源](https://github.com/Crnobog9527/GraylumAI_vercel/pull/553#issuecomment-5927256926)）。Owner 原话：

    > 调整一下账本引擎计算成本的比例， 以后 1 美元就是等于 100 积分。  我们所有的成本，特别是第三方服务，无论他们是用积分还是直接用美金来计算，到我们这里换算时，全部都要以美元统一单位来计算。

    BILL-UNIT #565 统一所有模型及第三方服务的美元成本，再换成 Graylum 积分；不能把第三方积分直接当本平台积分，也不能用固定积分附加费代替美元成本。q=100 是已定产品值，staging 配置须等 BILL-UNIT 交付并取得 Owner 批准后调整。

33. **默认加价倍数 m=3**（历史记录：2026-10-03 已由第 50 项改为默认 m=6）（Owner 2026-10-01，[BILL-UNIT 来源](https://github.com/Crnobog9527/GraylumAI_vercel/pull/565#issuecomment-5927709134)、[BILL-PAYG 来源](https://github.com/Crnobog9527/GraylumAI_vercel/pull/553#issuecomment-5927708649)）。Owner 原话：

    > 1. 加价倍数：3 倍。

    默认值由 BILL-UNIT 落实；已冻结执行沿用旧倍数。与 q=100 一起更新 staging 配置仍需 Owner 批准。

34. **按模型配置加价倍数**（Owner 2026-10-01，[来源](https://github.com/Crnobog9527/GraylumAI_vercel/pull/565#issuecomment-5928229374)）。Owner 原话：

    > 我们能不能增加一个新的功能：加价倍数不要统一覆盖所有的模型，而是每个不同的模型，我都能在后台定制不同的加价倍数。

    纳入 BILL-UNIT #565：后台为每个模型设置倍数，未设置时使用全站默认值（2026-10-01 为 3，2026-10-03 由第 50 项改为 6）；来源中的总控设计也覆盖第三方供应商/线路倍数。复用现有配置与报价，每次调用冻结有效倍数 m_i；应收 `C = ceil(q × Σ(U_i × m_i))`，最后只进位一次，实际扣费仍按第 26 项封顶。后台修改仅影响新操作，不重算旧冻结值；配置读取失败或非法时拒绝新收费，不当作“未设置”静默回落。BILL-PAYG 原 writer 同步累计差额与封顶公式，BILL-UNIT 不跨写。

35. **提示缓存是上线必做功能**（Owner 2026-10-01，[总控记录](https://github.com/Crnobog9527/GraylumAI_vercel/pull/561#issuecomment-5935197856)）。Owner 原话：

    > 561 我要纠正一下，我们是必须要把这个缓存的功能加上的。 不然成本太高了，用户消耗积分的速度也会很快。 那 OpenRouter 现在剩余的预算是肯定够的，不要去卡这个上限。

    总控据此安排（不是 Owner 原话）：

    - 新建任务 **PROMPT-CACHE**：产品请求要能带上缓存标记——放开 adapter 白名单，在请求组装里给稳定的前缀（系统指令、Skill 资源等）加 `cache_control`；费用上界要计入缓存写入的溢价，实际扣费按 OpenRouter 返回的真实费用（已包含缓存折扣）。具体方案由 Runtime 线的 writer 出，总控审。
    - 顺序：排在 #497 合并之后、BILL-PAYG 定稿之前实施，因为 BILL-PAYG 的逐次上界公式要包含缓存写入。写入方，以及与 #550、BILL-UNIT 的具体先后，等总控同步进度后再确定。#497 冻结 head `f9afd0db` 不因此变动。
    - #561 本轮主评测和端到端不带缓存标记。缓存实验**延后，不是取消**：PROMPT-CACHE 合入 staging 后，在真实产品路径上测 Sonnet、Gemini 的缓存命中率和实际费用，作为 PROMPT-CACHE 的验收证据；次数和金额到时候另报 Owner。
    - 测试密钥剩余额度不再作为执行前提；账本的逐次预留、单次上限和本轮累计上限照旧，真实花费仍须 Owner 在执行前批准具体次数和金额。

    本项是立项和顺序安排，方案尚未提交，不代表已实施或已授权真实调用。

    **后续（2026-10-02—03）**：方案 #572、实施 #591 已合并，2026-10-02 在 v3 测试窗口完成付费验收（PASS，八轮合计省 30.8%，见第 7.1 节 PROMPT-CACHE 行）；"实际扣费按 OpenRouter 返回的真实费用"由第 41 项的名义费用收费取代（真实费用仍原样记账、用于对账）。对话历史也加缓存的 PROMPT-CACHE-HISTORY 见第 43 项。

36. **关联 Google 的账号也能在个人中心改密码**（Owner 2026-10-01，[#569](https://github.com/Crnobog9527/GraylumAI_vercel/pull/569) PR 描述）。Owner 原话：

    > Google 账号允许在个人中心改密码

    #569 已合并（`9cb6cb84`）：有邮箱的账号都显示"修改密码"，仍然先带人机验证、用当前密码重新验证身份，验证失败不修改；一直用 Google 登录、没设过密码的账号，从对话框里的链接通过邮件设置密码（复用 FORGOT-PASSWORD 流程）。不改 API、不改数据库。staging 交互验收通过（[总控结论](https://github.com/Crnobog9527/GraylumAI_vercel/pull/569#issuecomment-5935890997)）；结论来自 Owner 逐组确认，可选的"首次设置密码"一步没有执行，不在通过范围内。正式环境上线另行批准。

37. **staging 只保留 auth-staging 入口**（Owner 2026-10-01，[总控记录](https://github.com/Crnobog9527/GraylumAI_vercel/pull/567#issuecomment-5932205661)）。Owner 原话：

    > https://graylumai-staging.vercel.app 这个域名我已经从 Vercel 里面删除了，Supabase 的邮件回调接口这些都删了。以后 staging 访问就走https://auth-staging.graylum.com

    总控只读核对（不是 Owner 原话）：`https://graylumai-staging.vercel.app/` 当时返回 404。以后 staging 的验证和交接只用 `https://auth-staging.graylum.com`。

    Owner 已把 staging 的 `NEXT_PUBLIC_APP_URL` 改为 `https://auth-staging.graylum.com` 并重新部署；总控只读核对了线上代码里的值，没有读 Vercel 环境变量的原值（[总控记录](https://github.com/Crnobog9527/GraylumAI_vercel/pull/567#issuecomment-5936590630)）。

    后续事项（[总控记录](https://github.com/Crnobog9527/GraylumAI_vercel/pull/567#issuecomment-5936590630)，总控安排，不是 Owner 原话）：

    - **STAGING-HOST-CLEANUP**（普通风险）：清理代码、测试、脚本和文档里残留的 `graylumai-staging.vercel.app` 引用。本任务在 staging `9cb6cb84` 上只读搜索，有 18 个跟踪文件含这个域名，其中包括 `packages/api/src/services/runtime/stagingEnvironment.ts` 的 staging 环境名单；这一处影响测试窗口的环境判断，实施时由写入方按第 7.1 节规则核实风险，需要时单独拆成高风险 PR。
    - **待 Owner 确认**：Stripe / Waffo 沙箱的回调地址和 Supabase 的 Site URL 是否已不再指向旧域名，由 Owner 自行检查（服务商配置，Agent 不改）。

    **后续（2026-10-01—03）**：#571（测试、脚本默认值和部署文档）、#605（文档入口）已合并；剩余引用和外部配置核对见第 7.1 节 STAGING-HOST-CLEANUP 行。

**2026-10-02—03 新增的 Owner 决定**（原话来自各 PR 评论里的总控记录；"总控安排"不是 Owner 原话）：

38. **导师模型当前计划在后台选 Claude Sonnet 5.5，关闭 #561**（Owner 2026-10-02，[#582 总控记录](https://github.com/Crnobog9527/GraylumAI_vercel/pull/582#issuecomment-5951254629)、[#561 收尾记录](https://github.com/Crnobog9527/GraylumAI_vercel/pull/561#issuecomment-5952666940)）。Owner 原话：

    > 导师模型定为 Sonnet；#582 按现状合并；出卡分寸问题并入方向 B 的 B2 一起解决

    > 关闭 #561

    #582 盲评中 Sonnet、Gemini 都没达到出卡门槛；出卡分寸问题并入右侧整理方向 B 的 B2（第 48 项）。#561 不合并关闭，分支保留，不再发真实调用。Sonnet 5.5 是 Owner 当前打算在后台给导师用途选的值，不是规则；模型按用途以后台设置为准（第 13、50 项）。第 13 项里对话和报告的当前计划配置不受影响。

39. **staging 计费换算和测试窗口**（Owner 2026-10-02，[#565 总控记录](https://github.com/Crnobog9527/GraylumAI_vercel/pull/565#issuecomment-5947049975)、[#591 总控记录](https://github.com/Crnobog9527/GraylumAI_vercel/pull/591#issuecomment-5955697020)）。Owner 原话：

    > 同意合并 #565（head 8c511174），同意把 0157 应用到 staging，同意把 staging 后台改成 1 美元=100 积分、全站加价倍数 3，并新建 v2 测试窗口：模型 Claude Sonnet 5.5、Gemini 3.8 Flash、GPT-6 Luna，预算 10 美元、300 次，10 月 9 日到期，测试账号不变

    > 同意新建 v3 测试窗口：Sonnet、Luna、Gemini 、gpt 6.1 sol按最新价格快照推导报价……上限 20 美元 / 400 次，10 月 9 日到期，测试账号 cfb600ed；同意由 Codex 把 staging 的 V3_RUNTIME_STAGING_WINDOW_ID 换成新窗口并重新部署

    （第二段原话中的省略号是总控记录原文。）q=100、m=3 的 staging 配置已按此批准修改；开户赠送、邀请奖励、套餐和积分包的积分数值仍待 Owner 复核（第 7.6 节）。

40. **正式环境价格全自动；模型价格自动读取的 D1–D7 按推荐**（Owner 2026-10-02，[#581 合并记录](https://github.com/Crnobog9527/GraylumAI_vercel/pull/581#issuecomment-5951733074)、[#578 PR 描述](https://github.com/Crnobog9527/GraylumAI_vercel/pull/578)，后者是总控转达、经[独立审查](https://github.com/Crnobog9527/GraylumAI_vercel/pull/578#issuecomment-5947568128)核对）。Owner 原话：

    > 同意按建议：正式环境价格全自动、不需要重新批准；合并 #581（head c54c757c）

    > #578 的 D1–D7 全部按推荐

    总控记录（不是 Owner 原话）：正式环境每次调用前用最新价格快照自动推导冻结上限和 `max_price`，供应商涨价时按新价冻结，不需要 Owner 重新批准，也不停止调用；"窗口冻结价低于推导值就拒绝"只适用于 staging 测试窗口，锁住的是 Owner 批准的测试预算。这条取代 MODEL-PRICING-SYNC 方案第 3.6 节中正式环境"涨价后重新批准报价"的设想。供 RUNTIME-PROD ① 设计使用。

41. **BILL-PAYG 第七版定稿：名义费用收费及其余规则**（Owner 2026-10-02—03，[#553](https://github.com/Crnobog9527/GraylumAI_vercel/pull/553)；[定稿记录](https://github.com/Crnobog9527/GraylumAI_vercel/pull/553#issuecomment-5958061928)）。Owner 原话，按时间：

    > #590 合并后开工边用边扣（#553），由 Codex 实施

    （[5952671504](https://github.com/Crnobog9527/GraylumAI_vercel/pull/553#issuecomment-5952671504)）

    > #553 Q1 选 A，Q2 首版不自动更新

    （[5954715142](https://github.com/Crnobog9527/GraylumAI_vercel/pull/553#issuecomment-5954715142)）

    > #553 按分类表一次改完，C 类写进实施说明的必做必测项；另外加价格变动提醒（涨超 20% 或异常变化）和平台承担提醒，只提醒不拦截

    （[5955232832](https://github.com/Crnobog9527/GraylumAI_vercel/pull/553#issuecomment-5955232832)）

    > 向用户按名义费用收费（缓存和折扣都不让给用户，选 A），并进 #553 边用边扣实施

    （[5957160656](https://github.com/Crnobog9527/GraylumAI_vercel/pull/553#issuecomment-5957160656)）

    > #553 缺 token 时直接根据供应商返回的总花费乘以倍数不就等于用户花了多少美金吗？然后用这个用户花的美金数换算成积分不就可以了？ 分时价选 c

    （[5957737094](https://github.com/Crnobog9527/GraylumAI_vercel/pull/553#issuecomment-5957737094)）

    总控记录的含义（不是 Owner 原话）：
    - **名义费用**：向用户扣的积分按价格快照里的标价计算（全部输入 token 含缓存读写按正常输入价，输出含思考按正常输出价，加每次请求的标价费用），再乘有效倍数 m 和 q、累计后只向上取整一次；缓存节省和供应商临时折扣不让给用户。OpenRouter 返回的实际费用 `usage.cost` 仍原样记账、用于对账。第 26 项的余额封顶、L 门槛、平台承担超额和第 32–34 项的美元统一口径不变，只是"实际扣取"的基准改为名义费用。
    - **缺 token 兜底**：供应商返回了总花费 c、但 token 数缺失算不出名义费用时，按 `min(c, U)` 作为收费基准（记为 `actual_fallback`）；c 也缺失时按费用未知处理（保留冻结）。已结算的不因之后补到 token 数而静默重算或补扣。
    - **分时价**：名义费用里的分时价一律取该线路所有时段里最贵的价格，并在面向用户的计费说明里写清楚（条款文字由 Owner 处理，第 9 项）。
    - **Q1 = A**：整理在等积分时用户直接发新消息，先补做上一轮等着的整理（单独收这次整理的费用），再处理新消息；余额仍低于整理门槛时新消息一起等待并提示充值。**Q2（2026-10-06 取代）**：按精确模型＋用途配置典型名义美元费用，领取时按冻结 q 与本 call 的 m_i 自动计算 L，详见下方 PAYG-THRESHOLD-AUTO 决定。
    - **管理员提醒**：价格快照里冻结单价上涨超过 20% 或异常变化时提醒；某模型一天内平台承担金额超过管理员设定值时提醒。只提醒、不拦截。
    - 定稿版本：#553 描述第七版（SHA-256 `e431af20…`，[独立复核 5958005853](https://github.com/Crnobog9527/GraylumAI_vercel/pull/553#issuecomment-5958005853)）。开工条件：#594 合并，且 #598 的实施（#611）合并之后（第 42 项）；PR-B 在 PROMPT-CACHE-HISTORY H1（#610）合并后开工（第 43 项，已满足）。#611 已合并，PR-A（#617）在途。方案定稿不等于实施、合并或配置变更授权。

42. **注销在途收尾先于边用边扣实施**（Owner 2026-10-03，[#598 总控记录](https://github.com/Crnobog9527/GraylumAI_vercel/pull/598#issuecomment-5957866853)）。Owner 原话：

    > 同意 #598 限流合并后由 Codex 实施，排在边用边扣之前

    总控安排（不是 Owner 原话）：顺序是 #598 实施（#611，迁移 0160）→ BILL-PAYG 实施；右侧整理 B1（#593）可以和 #598 并行，迁移编号和 `executionStream.ts` 由后合并的一方同步（B1 已先合并，0159）。#598 独立审查的 P1（`bill2_erasure_closed` 要同时认 run 级和 call 级预扣、PAYG 等待积分遇到已注销账号要能收尾）按 Owner「#598 按分类表一次改完，C 类写进 #598 和 #553 的必做必测项」写入双方必做必测项（[5955935438](https://github.com/Crnobog9527/GraylumAI_vercel/pull/598#issuecomment-5955935438)）。方案 #598 已合并（`e0cddcf7`），实施 #611 已合并（`afbc42f6`，0160 已应用）。

43. **对话历史也加缓存（PROMPT-CACHE-HISTORY）第 8.3 节三项按推荐**（Owner 2026-10-03，[#601 总控记录](https://github.com/Crnobog9527/GraylumAI_vercel/pull/601#issuecomment-5965739174)）。Owner 原话：

    > PROMPT-CACHE-HISTORY 按方案推荐：先做 H1 机制、由 B2 激活；这次不做 1 小时缓存，按触发条件复评；付费实测先复用 B2 评测和 B2+F1 验证的预算。

    总控安排（不是 Owner 原话）：H1 先写 `execute.ts`，PAYG PR-B 在 H1 合并后开工；本次决定不包括额外付费预算。H1 已由 #610 合并（`7ebef331`），默认不激活；方案 #601 已合并（`9446ce16`）。

44. **对话原生体验：全站统一流式、统一输出上限、自动续写**（Owner 2026-10-03，[#547 总控记录](https://github.com/Crnobog9527/GraylumAI_vercel/pull/547#issuecomment-5965354780)）。**方向已定、方案待审（[#604](https://github.com/Crnobog9527/GraylumAI_vercel/pull/604)）。** Owner 原话：

    > 同意开方案任务"对话原生体验"：全站对话统一流式输出、统一一个输出上限（报告也用这个上限，D1 并入），写到上限或快超时时自动续写、用户无感；不按技能区分。

    总控记录的影响（不是 Owner 原话）：REPORT-GEN #547 的 D1（报告单独设 report=24576）不再单独批准，报告的单次输出上限改用本方案定下的全站统一上限；#547 原来"截断不算成功、不自动续写"将由统一的自动续写机制取代，等 #604 定稿后 #547 再做小同步。#604 方案第一版提出单次上限保持已批准的 8192、每次回答最多自动续写 3 次，这一项**尚待 Owner 决定**（#604 PR 描述第 9 节），本文不作为已定写入。

    **后续决定（2026-10-05 同步）：** Owner 2026-10-03 在 #604 上定了单次上限，并把自动续写移到第二版：

    > 同意 #604 的 F1 按审查建议：正式环境 Pro 提高全站统一单次上限（32768 为首个候选，实施时核对费用和时间后定值），续写作为写满时的兜底；staging 保持 8192；首版如实说明中途超时不能无感续写。（[#604 总控记录](https://github.com/Crnobog9527/GraylumAI_vercel/pull/604#issuecomment-5969177321)）

    > 同意 #604 首版先不做自动续写：全站统一边写边显示，正式环境单次上限提高到 32768，写满时干净收尾并提示已截断；自动续写（最多 3 次）放到上线后的第二版。（[#604 总控记录](https://github.com/Crnobog9527/GraylumAI_vercel/pull/604#issuecomment-5970578413)）

    所以本项标题里的"自动续写"不在首版：首版写满时干净收尾并提示已截断，自动续写在上线后的第二版做。实施细节以 [CHAT_NATIVE_OUTPUT_PLAN.md](CHAT_NATIVE_OUTPUT_PLAN.md) 为准。

45. **内容创作改为对话驱动**（Owner 2026-10-03，[#604 总控记录](https://github.com/Crnobog9527/GraylumAI_vercel/pull/604#issuecomment-5966287500)）。**方向已定、方案待写。** Owner 原话：

    > 同意开方案任务"内容创作改为对话驱动"：定位之后的选题和创作改为自由对话加轻引导，按意图加载平台技能；一个窗口只做一个选题，选题窗口可以随时回来继续；在选题窗口里聊其他选题时，模型提醒不要混用并提供新开窗口的入口，用户坚持也照常回答，但右侧只整理本窗口的选题；自由对话要整理成纪要式记录，但不是每轮都整理，右侧侧边栏可以增加一个「整理纪要」按钮，用户自由对话多轮以后，如果 agent 判断这个窗口里的对话有价值，则提醒用户手动点击右侧【整理纪要】按钮梳理信息，不点击的话不会自动整理信息……用户在聊天框里发送了"帮我整理一下聊天纪要"，也可以触发这个整理功能。是否保存到资料库由用户决定；排在 #604 之后，和 #588 一起设计。

    （原话中的省略号是总控记录原文。）总控安排（不是 Owner 原话）：任务名 CONTENT-CONVERSATION-DRIVEN，等 #604 审查定稿后开规划窗口编写，和 #588 方向 B 合并设计。它将取代视频线"口播稿 → 分镜 → 剪辑建议"的固定按钮流程，以及 2026-09-27"自由对话不自动整理"的旧决定（D9，改为用户手动触发纪要整理），见第 2.2 节。**方案定稿和实施之前，现有流程照常维护。**

46. **钱路线等并行批次**（Owner 2026-10-03，[#594 总控记录](https://github.com/Crnobog9527/GraylumAI_vercel/pull/594#issuecomment-5965897528)）。Owner 原话：

    > 同意并行开工：钱路线（会员权益剩余部分 → PAY-COMMON）交给 Codex，后台小修补由 Claude 做，旧域名清理和 DEBT-QUICK 交给 Codex。

    总控安排（不是 Owner 原话）：ENTITLEMENTS 剩余部分是 PR-2（后台会员权限界面），由 Claude 窗口单独开 high PR（已合并 #609）；后台小修补另开 ordinary PR（已合并 #606）；PAY-COMMON 先出方案（已合并 #608），通过后由同一个 writer 实施；STAGING-HOST-CLEANUP 和 DEBT-QUICK 按 ordinary 拆 PR（已合并 #605、#607），高风险部分单独拆出。

47. **PAY-COMMON 退款衔接 P1**（Owner 2026-10-03，[#608 总控记录](https://github.com/Crnobog9527/GraylumAI_vercel/pull/608#issuecomment-5966610084)）。Owner 原话：

    > 同意 PAY-COMMON 按上述 P1 衔接：付款成功默认不退款，页面提示以我用第三方工具生成的条款最终文字为准；人工例外逐笔批准，订阅部分或全额退款都会终止该订阅以后的年付积分发放，并收回当期没用完的订阅积分；保留原渠道退款核对，不影响其他积分来源；积分包人工退款例外本期只记录待处理、不能执行，执行能力另行设计；不新增自助或自动现金退款。

    （2026-10-05 起"默认不退款"已由第 51 项退款规则取代，[记录 Y](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5982111397)。）这条落实删除规则 E5"付费默认不退款、Owner 逐笔批准手动退款"与退款的衔接（第 10 节原"待确认"一行据此改为已定）。方案 #608 已合并（`6546f27d`），实施由同一个 Codex writer 从 PR-1（#612）开始，每个实施 PR 的合并另需 Owner 批准。

48. **右侧信息跟着对话走（方向 B）第 8 节五项按推荐**（Owner 2026-10-02，[#588 合并记录](https://github.com/Crnobog9527/GraylumAI_vercel/pull/588#issuecomment-5952470481)、[#588 PR 描述](https://github.com/Crnobog9527/GraylumAI_vercel/pull/588)）。Owner 原话：

    > #588 第 8 节五项全部按推荐

    #588 描述记载 Owner 2026-10-02 选定方向 B：右侧信息和整理器不再按固定题目顺序，由导师和用户实际聊到的内容创建和填写，最后把 Skill 要求的信息收齐。这和第 3 节已锁定的体验一致，不改变第 3.2、3.3 节的产品规则。B1（#593，迁移 0159）已合并；B2 待做，#582 的出卡分寸问题并入 B2（第 38 项），并负责激活 PROMPT-CACHE-HISTORY H1（第 43 项）。

    **2026-10-06 B2 阶段验收补充**（[决定记录](https://github.com/Crnobog9527/GraylumAI_vercel/pull/675#issuecomment-6013300627)）：
    采用第二轮 `bbed64ab` 的提示词和宿主逻辑，仅保留后续 CI 修复；撤回第三轮行为改动，不再付费评测。
    本阶段无依据事实门槛由 0/70 改为 ≤4/70，写回正确由 ≥27/30 改为 ≥25/30，其余门槛不变。
    第二轮实测分别为4/70、25/30，其余达标；采用第二轮实测作为本阶段质量证据。
    继续代码审查和前端开发；上线后用真实数据跟踪写回质量，整理模型试验另立任务，不再通过叠加提示词试验。
    该决定只取代 B2 小评测的上述两项门槛，不代表完成 B2+F1 staging 验证、批准配置修改或合并。

49. **封闭内测在正式环境；限流按每条新消息计**（Owner 2026-10-02，[#573 总控记录](https://github.com/Crnobog9527/GraylumAI_vercel/pull/573#issuecomment-5938730128)）。总控出了两道选择题，记录的 Owner 选择：

    > 每发一条消息算一次

    > 正式环境

    总控记录的含义（不是 Owner 原话）：第 30 项"新对话每分钟 10 次、每天 200 次"按用户每发一轮消息计一次，后台文案写"每轮消息"或"新消息"。5–10 位受邀用户的封闭内测（D8）在**正式环境**进行，所以正式环境的 Upstash Redis、Vercel Pro 等正式环境配置都是封闭内测前提；staging 的 Upstash 已配好，不影响 staging 上的开发和验收。服务层的环境前缀由 RUNTIME-PROD 区分。

50. **定价、付费墙和上线方式**（Owner 2026-10-03，在定价方案审查会话中逐条确认，记录见本 PR 描述）。Owner 原话，按时间：

    > 1.先按 120 计算吧。 2.免费用户也统一用 claude sonnet 5.5 3.不对外承诺约多少次定位。 就写积分 + 会员权益

    > 不按 90% 算了， 太夸张了。

    > 我之前设定的积分是不过期的， 只有会员等级会过期。

    > 就算用户这个时候积分足够，他要想生成报告，必须要付费会员才能继续。

    > 免费用户能拿走的：已确认的整理好的前置信息，不固定只有 6 步，后面有可能会改步骤，可以看，可以导出。免费拿到的东西不收回。 …… 积分包确实只能给会员购买。 取消封闭内测环节， 直接上线售卖。 我自己使用体验一下积分消耗的速度就可以定。 首发目标用户定为"想打造个人品牌，利用社交媒体变现的人。"其他的按你建议的来

    > 退款扣除积分的规则是我口误了，现有的这个规则才是对的。

    （第五段的省略号省去了 Owner 随后更正为口误的退款说法，见第六段。）"其他的按你建议的来"所指的建议已在同一会话列给 Owner，记录如下（不是 Owner 原话）；Owner 随后在总控窗口逐项确认，并把最小积分包定为 9.9 美元，GitHub 出处是 [#618 总控记录](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5969267583)：

    - **加价倍数**：全站默认 m 由 3 改为 6；按模型/线路单独配置（第 34 项）、调用时冻结、只进位一次的规则不变。staging 和正式环境的实际修改仍须执行前另获 Owner 批准（第 39 项的做法）。
    - **订阅和积分包的积分比例**：订阅每 1 美元售价给的积分 Pro 120、Gold 130；积分包每 1 美元 100 积分，最小积分包 9.9 美元。积分包只有会员能买。积分永不过期，只有会员等级会过期；退款仍按 v11 §9.3（只处理被退款那一期订阅未用的积分，保护开户、签到、积分包等其他来源）。
    - **价格页**：只写积分和会员权益，不承诺次数或份数，也不写"约等于多少次定位"。模型按用途在后台配置（导师、自由对话默认、各 Skill 各自配置），以后台设置为准，方案不规定具体用哪个模型。这里定下的只有一条：会员档位不影响用哪个模型，免费用户和付费会员在同一用途下用同一个后台配置的模型，不按档位降级。Owner 原话里的"Sonnet 5.5"记为当前打算给导师用途选的后台值，不是规则（第 13、38 项）。
    - **报告付费墙**：带步骤 Skill 生成报告必须是付费会员，同时照常扣积分（第 22、25 项的其余规则不变）。免费用户可以做完报告前的全部步骤；已确认、已整理的前置信息可以看、可以导出，不绑定步骤数，不收回。会员到期后，已生成的报告仍可看、可导出，只是不能生成新报告。会员检查在服务端的报告入口和调用准入两处执行，页面只负责提示。
    - **其他付费提示**：免费积分在报告前用完时只提供开通会员；会员余额不足按 BILL-PAYG 在两步之间暂停、充值后继续；Pro 用户一个月买 2 次以上积分包时提示 Gold 更划算（2026-10-04 已取消：无论买多少次积分包都不提示升级会员，第 51 项）。
    - **数值怎么定**：（开户赠送和月价的公式已由第 51 项取代：注册赠送 500 积分，见记录 S；Pro $29、Gold $69，见记录 F。下面保留原文作历史。）开户赠送 = Owner 用当前后台配置的导师模型（目前计划 Sonnet 5.5）亲自走完报告前全部步骤的账本消耗 × 1.2，按 m=6 换算（目前写死在 0151 的 100 积分要走迁移修改）；Pro 月价 = Pro 的用量目标（"一份报告 + 4 周日常选题和写作"的实测消耗）÷ 120；Gold 用单独的、比 Pro 更大的实测用量目标，月价 = 该目标 ÷ 130；约束：Gold 月价必须高于 Pro。具体用量和价格由 Owner 实测后定。邀请奖励 50/30 按 m=6 复核。（2026-10-04 月价公式已由第 51 项的实际售价取代：Pro $29、Gold $69；开户赠送已由第 51 项改为注册赠送 500 积分，记录 S。）
    - **上线方式**：取消封闭内测（D8）。上线基础完成后不再先做内测，按 D1 范围完成后直接公开上线售卖；原先写作"封闭内测前""内测前提"的事项改为公开上线前完成（第 2.2 节）。上线和生产相关动作仍按第 10 节另行批准。
    - **首发目标用户**：想打造个人品牌、利用社交媒体变现的人。宣传不提内容追踪和数据复盘（社媒同步在上线后，D1）。
    - **支付渠道能力和已接受的边界**（Owner 2026-10-03 在总控窗口决定并核实，[总控记录](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5969904509)）。Owner 原话：

        > 同意：积分包只卖会员，旧计划里"只用支付宝的用户靠买积分包付费"的兜底作废；在 WAFFO 里核实过了，不支持支付宝，银行卡支持订阅， 微信支持单笔消费（比如积分包，但不支持订阅）。

      Waffo 能力：银行卡支持订阅（含按年扣款）；微信只支持单笔（例如积分包），不支持订阅；不支持支付宝。
    - **上线收款渠道和一次性会员**（Owner 2026-10-03 在总控窗口决定，[总控记录](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5970044974)）。Owner 原话：

        > 同意上线只用 Waffo：银行卡订阅照常；增加用微信一次性购买 1 个月或 1 年会员、不自动续费；不接 Stripe 支付宝。

      含义：上线只用 Waffo 收款；Stripe 不作为上线收款渠道，PAY-COMMON 的手动渠道开关只作备用（背景：Stripe 直收不代处理各国报税）。新增微信一次性会员：单笔付款，期限 1 个月或 1 年，不自动续费，到期再买；一次性会员同样算付费会员（可以生成报告、可以买积分包）；积分发放按对应周期的订阅规则（1 年期按 v11 §9.3 分 12 个月发放）；退款按 v11 §9.3 只处理这一期的积分。已接受的边界：只用支付宝的用户付不了款（取代上一条记录的"没有可用银行卡的用户开通不了会员"）。
    - **订阅周期**（Owner 2026-10-03，在定价审查会话中决定，同见[总控记录](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5970044974)）。Owner 原话：

        > 可以，只做月付和 年付， 营销优惠等要上线了再说。

      订阅只做月付和年付，不做季度；Owner 核实 Waffo 支持按年付款。年付沿用 12 个月分期发放（v11 §9.3）；年付折扣和其他营销优惠上线时再定。（2026-10-04 已由第 51 项定价：年付 Pro $279、Gold $621，Gold 新用户首月 $49，创始会员。）
    - **模型配置、输入框模型位置和 Fusion 对比**（Owner 2026-10-03 在总控窗口决定，[模型配置记录](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5970207924)、[补充说明记录](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5970264949)）。Owner 原话：

        > 同意：模型按用途在后台配置，规划不写死具体模型；只规定不按会员档位区分模型，免费用户和会员在同一用途下用同一个模型。前端暂时不给用户提供自己切换模型的选择。

        > 我说的暂时不让用户自己切换模型你理解错了，我是指聊天框的UI-MODEL 暂时不要让用户切换模型，ui 也 不用移除，直接显示 auto 就行。 FUSION-COMPARE 还是按原计划做， 但是考虑到有的用户不懂这些模型的能力，所以这个功能每次点开都有一个默认的勾选。那默认勾选哪些模型一起跑呢？这是由管理员后台定的。 那高级用户呢，他也可以自己去取消这些勾选，然后自己去搭配。 后台也要增加一个参数，可以让我调整：每次用户使用 fusion 功能，最少要勾选几个模型。

      含义：UI-MODEL 留在上线范围，输入框的模型位置保留，只显示 Auto，用户暂时不能切换，实际模型按用途由后台配置决定。FUSION-COMPARE 按原计划留在上线范围：每次打开对比，默认勾选管理员在后台设定的一组模型；用户可以取消勾选、自己搭配，范围仍受管理员允许列表和会员权限限制；后台新增参数"每次 Fusion 对比最少要勾选几个模型"，由 Owner 调整，前端和服务端都按它校验，取值范围是 2 ≤ 最少勾选数 ≤ D3 的当前最多模型数（对比至少要两个模型，后台可调但不能低于 2）。
    - **实施分工**（第 7.1 节；每条只由一个任务负责）：
        - **PAYWALL**：报告付费墙；免费用户的报告前信息导出；积分包只卖会员；订阅和积分包的积分比例与最小积分包；按"数值怎么定"重设开户赠送、邀请奖励、套餐和积分包数值；价格页只写积分和会员权益；其他付费提示（免费积分用完只提供开通会员；Pro 升 Gold 提示已于 2026-10-04 取消，第 51 项）。
        - **PAY-COMMON → PAY-WAFFO**：上线只用 Waffo、Stripe 手动开关只作备用；Waffo 渠道能力；微信一次性会员；订阅只做月付和年付。
        - **UI-MODEL**：输入框模型位置只显示 Auto、用户不能切换；模型按用途由后台配置、不按会员档位区分。
        - **FUSION-COMPARE**：对比默认勾选、用户可改、最少勾选数参数。
        - **不对应开发任务**：默认 m=6 是后台配置修改，执行前另获 Owner 批准（第 39 项的做法）；会员余额不足时的暂停和继续沿用 BILL-PAYG；积分不过期和退款规则沿用现有规则；取消封闭内测体现在第 7.2、7.4 节的排期里，发布仍走 V3-M3 → REL-1；首发目标用户用于宣传和落地页文案。

51. **定价、付费墙细则和定位档案数量**（Owner 2026-10-04；#618 合并后由总控记在 #618 评论里，每条都附原话，下文按"记录 X"引用）。多数决定是 Owner 在定价策略审阅窗口做的、由该窗口转述原话，记录 J、M、N、O 是 Owner 在总控窗口的原话；记录 P 是总控对 Owner 更正的整理，评论里没有附原话；记录 Q 是定价窗口逐字转述的原话，记录 R 是 Owner 在总控窗口的确认；记录 S、T 是定价窗口逐字转述的原话；记录 U 是 Owner 在总控窗口的原话；记录 V、W 是定价窗口逐字转述的原话；记录 X、Z、AA、AB、AC、AD 是 Owner 在总控窗口的原话；记录 Y 是定价窗口逐字转述的原话。同一事项前后不一致时以较晚的记录为准，下面逐条注明被取代的写法。付费墙设计的唯一依据是仓库里的 [`docs/launch/design/paywall/`](design/paywall/README.md)：Owner 定稿的 v25（artifact `MW9Ja3xTfLNbzraTudi2X7` 第 36 版，版本号 `1791131430-4177`，[记录 Y](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5982111397)；此前 v24 依据 [记录 V](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5981192614)；此前 v23 依据 [记录 T](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5980843167)；2026-10-04 导出的 HTML 和 9 个场景的桌面、手机截图，各截图来自哪个版本见 README），README 记有场景清单、Owner 的文案规则和仍待定的事项；artifact 只是来源，实施以仓库里的导出为准。**设计稿与本项冲突时以本项为准**（例如创始名额只在 Waffo 权威确认会话关闭或过期后才释放；未上线的功能直接隐藏、不标"即将上线"），已知冲突列在 README 的"与规划冲突时以规划为准"一节。原 PAYWALL-DESIGN 定稿 `QLdBcaYMUSRQHa1YPQa2VQ` 只留作历史，不再作为实施依据（记录 M）。本项只改规划；staging 和正式环境的价格、套餐、积分包、会员权限和 Waffo 产品配置，实际修改前仍须 Owner 另行批准。

    记录出处（均为 [#618](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618) 的总控评论，按时间）：
    [B 门槛原则](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5971895597)、
    [C 美元显示和不提示升级](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5972054913)、
    [D Fusion 只给 Gold](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5972065193)、
    [E 年付、创始会员、改名](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5972167876)、
    [F 实际售价](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5972366406)、
    [G Pro 年付取整和首月优惠](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5972469380)、
    [H 首月改为 $49](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5972485899)、
    [I 首月资格和 Waffo 做法](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5972512183)、
    [J 付费墙剩余问题](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5972539553)、
    [K 定位档案数量](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5972689626)、
    [L 工作室版和专家咨询](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5972732100)、
    [M 设计稿唯一来源](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5972835435)、
    [N 对比文案定稿](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5972956845)、
    [O 创始价取整](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5976467607)、
    [P 创始价更正和报告改名](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5979988044)、
    [Q v21 定稿中的其余决定](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5980762284)、
    [R 创始会员徽章和专家授权](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5980780017)、
    [S 积分包三档和注册赠送](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5980831854)、
    [T 积分包会员价抹掉分位](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5980843167)、
    [U Pro 升 Gold 的计费周期](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5980903324)、
    [V 创始会员续费、退出和微信渠道](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5981192614)、
    [W 付款前勾选同意条款和付款证据](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5981381009)、
    [X 拒付冻结和续费提醒提前到上线前](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5981808905)、
    [Y 退款规则参照 Higgsfield](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5982111397)、
    [Z 积分包被拒付的处理](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5982115736)、
    [AA 退款细则确认](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5982129081)、
    [AB 升级退款后恢复 Pro 的含义](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5982435235)、
    [AC 会员拒付冻结已到账积分、功能缩减退款不收回积分](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5982525998)、
    [AD 拒付时停止订阅自动续费](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5982615688)。
    合并记录（[A](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5970619921)）另记 Owner 确认积分有效期维持原规则：积分永不过期，只有会员等级会过期。

    Owner 原话（摘录，完整原话见各记录）：

    > pro 定位 29 美金/月， gold 定为69 美金/月。 这是实际售价。（记录 F）

    > Pro 年付 做到 原价 8 折， gold 年付优惠做到原价 7.5 折。（记录 F）

    > Pro 年付取整成 $279.（记录 G）

    > gold 月付首月 7 折，按 49一个月算，刚才我说错了。（记录 H）

    > 只给第一次买 Gold 的账号。（记录 I）

    > 创始会员第一年也 6 折。（记录 F）

    > 我们的这个货币单位都以美金来显示。我们的年付和月付上，一定要展现出年付比单独月付定 12 个月能省多少钱。 用户无论单独买多少次积分包，系统都不要提醒他升级会员，这是他们的自由。（记录 C）

    > gold 会员才能用的 fusion 功能一定要突出， 免费和、pro 会员是不能用这个功能的。  一定要把这个功能的优势写出来。（记录 D）

    > 档案数量：免费 1 个、Pro 3个、Gold 6个。 其他的都同意。（记录 K）

    > 1.同意 2.同意 3.专家我亲自做 4.不能，但可以用 stripe 或者线下收单的方式收款。（记录 L）

    > 创始会员的价格取整为 372 美金。（记录 O，总控窗口原话；$372 已由记录 P 作废，见下方"创始会员"）

    > 同意对比文案用"雇佣一位社交媒体顾问：$2,000–10,000/月（来源：HawkSEM）"对比"雇佣 Graylum AI 社交媒体策略师：$29/月起"。但这 8 个界面的 ui 太土了，有种小广告的感觉。你先更新同步规划，先别着急安排任务去执行代码。等我明天把预览版调好了再去实施（记录 N）

    > Pro会员买积分包可以打9.5折。Gold会员买积分包的话打 9 折。（记录 Q）

    > 中途升级不退差价，因为我们这个订阅本质上其实就是在卖积分……如果他升级成 Gold 的会员，无论花了多少钱，往他的账上再打 8970 积分，然后再升级成 Gold 的权益就可以了。（记录 Q）

    > 后端是没有这个同意开关的。 暂时所有用户的数据只能由他导出来，然后给我们才能看。（记录 Q）

    > 积分包就按你的建议设三档。然后注册先定送 500 积分。（记录 S）

    > 积分包折扣以后的价格，四舍五入向下归零。9.41 就收 9.4，8.91 就收 8.9。好吧，最后那一分钱就不要了。（记录 T）

    > 同意：升级 Gold 后，下次扣费日从升级当天重新算，原 Pro 订阅停止续费、不退差价；Pro 年付用户升级时，没发完的 Pro 年付积分继续按月发完，Gold 从升级当天起单独计费。（记录 U）

    > 名额不放回去，宽限期 7 天，按你的建议改. 规则也要加进去。（记录 V）

    > 只要创始会员的名额没有卖完，哪怕是通过微信渠道一次性购买年付的，也享受同样的折扣，并且能进创始会员群。但是，第二年也是同样的，如果不续费的话，那就取消权益就好了。（记录 V）

    > 只有前 50 个黄金会员年付的才算创始会员，后边的都不算了，也不进社群了。 无论是什么支付渠道。（记录 V）

    > 为了防止以后正式开始拓展美国英语母语用户时，有人恶意退款……比如说在购买的时候，是不是明确地把退款条款直接写在确认框里？然后用户确定签署了哪些协议，我们也是会留有记录的。这样在遇到拒付、需要申诉的时候，我们能提供材料。（记录 W）

    > 同意两项都提前到上线前：收到 Waffo 拒付通知后先冻结会员权益和积分发放（可撤回），其余拒付处理留到上线后；银行卡年付续费前提醒和微信创始会员到期提醒共用一套，上线前做。（记录 X）

    > 我们的退款规则和他的一致就行。（记录 Y；"他的"指 Higgsfield 服务条款 2026-07-26 版第 9.3、10.4、16.4 条）

    > 所有的巨富都不允许自动接受，我人工处理。（记录 Y；语音转写，指"拒付"）

    > 同意 A：积分包被拒付时，上线前就冻结这个包里没用完的积分（可撤回），判输扣回、判赢解冻，不动其他来源的积分。（记录 Z）

    > 同意两项推荐：从这次付款起账户没有任何积分消耗才算"没用过"；付费墙卡片不写 7 天退款，只写在常见问题和条款里。（记录 AA）

    > 同意恢复 Pro 按推荐：恢复到原 Pro 已付期限的原到期日为止，不延长不缩短；原 Pro 订阅保持停止续费、不自动恢复扣费，到期前提醒用户自己重新订阅；年付 Pro 没发完的按月积分继续发到原到期日。（记录 AB）

    > 同意两项推荐：会员被拒付时同样冻结这份付款已发放、还没用完的积分（可撤回），判输扣回、判赢解冻，不动其他来源；功能缩减按剩余时间退款时，已发放的积分不收回。（记录 AC）

    > 同意拒付时停止续费：收到拒付通知时同时取消这份订阅的自动续费；判赢后不自动恢复扣费，提醒用户自己重新订阅；判输订阅终止。（记录 AD）

    整理（总控记录和唯一来源设计稿的含义，不是 Owner 原话）：

    - **月付**（记录 F）：Pro $29/月、Gold $69/月，这是实际售价。每月积分 = 售价 × 每美元积分：Pro 3,480（×120）、Gold 8,970（×130）。取代第 50 项"数值怎么定"中"月价 = 实测用量 ÷ 每美元积分"的算法。
    - **年付**（记录 F、G、J）：原价按月付 × 12（$348 / $828）；Pro 8 折取整为 $279/年（省 $69），Gold 7.5 折 $621/年（省 $207）。年付每月发放的积分和月付相同，分 12 个月按月发放；"每 1 美元 120 / 130 积分"只指月付，年付卡片不写每美元积分数。年付标签（记录 P、[记录 V](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5981192614)）：创始名额还没卖完时，不论用什么方式付款都写"最高省 40%"；卖完后写"最高省 25%"。取代记录 E 的"年付 = 10 个月价格"和第 50 项"年付折扣上线时再定"。
    - **只用美元显示**（记录 C）：所有价格统一用美元显示，包括微信一次性会员，不另写人民币。年付在价格页和弹窗里必须写明比按月付 12 个月省多少美元。
    - **Gold 新用户首月 $49**（记录 G、H、I）：只给任何渠道都从没买过 Gold 的账号（年付、创始会员也算买过），由服务端判断，银行卡订阅和微信一次性都适用，不靠手动改价；第二个月起 $69。Pro 没有首月优惠。首月优惠不和年付、创始会员叠加。取代记录 G 的 8 折 $55.20。
    - **创始会员**（记录 E、F、J、P、[记录 V](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5981192614)）：Gold 按月付 12 个月的价格 $828 打 6 折，取整为 **$496/年**，第一年就是这个价（记录 P，取代记录 O 的 $372 和此前的 $372.60）。续费：连续续费不中断，每年按续费时 Gold 按月付 12 个月价格的 6 折收费，不写死 $496，因为以后套餐可能变化（记录 P）；前 50 位 Gold 年付会员就是创始会员，银行卡和微信都算，价格都是 $496，都占名额；名额卖完后，用任何方式付款都不再算创始会员（记录 V）。页面显示真实剩余名额。创始身份跟随连续续费：取消自动续费后，权益保留到当期结束；到期没有续费的（银行卡扣款失败有 7 天宽限期），6 折续费资格、创始会员社群、展示墙和徽章一并结束，之后再订阅按当时价格，不恢复创始身份；失去身份的前创始会员不能再按创始价购买，即使名额还没卖完；他已用掉的名额不放回、仍计入 50 个，他之后再买不按创始价，所以也不会占用新名额（名额按历史售出数计，不按当前有效会员数计）。创始价由服务端按账号资格和全局剩余名额判断，前端只显示服务端返回的价格。用微信一次性购买的，到期前或到期后 7 天内再按创始价买一年就能保留身份，不买则权益结束。例外情况退款的，立即结束创始身份（记录 V）。名额由服务端计数：结账开始时先占名额；名额预留按结账会话幂等记录；只有在 Waffo 权威确认该会话已关闭或已过期后才回收名额（关闭页面或本地超时都不算会话结束，[PAY-COMMON 实施说明](tasks/PAY-COMMON.md)第 7 节"幂等"行）；预留有效期内到达的成功付款一律兑现；回收之后才到达的成功付款不自动兑现创始价、不超卖，按 PAY-COMMON 冲突回执的口径进入人工复核；名额计数检查和预留在同一个加锁（或 serializable）的数据库操作里完成，同一买家已有有效预留时复用、不另占名额，验收包括"最后一个名额被多个会话并发抢占时只成功一个"；**已售出的名额在任何情况下都不放回**，包括退款、取消、续费失败（记录 V）；验收要确认这些情况都不会让名额放回，并且并发时不超过 50 个。"没付成功就释放"（记录 I）的释放时机按本条实现。上线时单独建一个订阅产品，卖完后下架，换回 Gold 年付原价产品。
    - **微信一次性会员价格**（记录 J、[记录 V](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5981192614)）：和银行卡同价：1 个月 Pro $29 / Gold $69（第一次买 Gold 为 $49），1 年 Pro $279 / Gold $621；不自动续费。创始名额没卖完时，微信买 Gold 1 年同样按创始价 $496 成为创始会员（记录 V）。
    - **不做的营销手法**（记录 E、F）：付费墙上不宣传"7 天退款保证"（退款规则见下方"退款规则"，记录 Y）；不做"抬高原价再打折"，不做会重置的倒计时；紧迫感只来自真实名额，以及年付划掉月付 × 12 的真实价格。如果做倒计时，只能对应一个真实、固定的截止时间。
    - **续费说明和弹窗**（记录 E、G；唯一来源设计稿）：每个付款按钮旁写首期价、之后的续费价和周期、怎么取消。付费墙的各个触发场景都用弹窗（价格页是独立页面）；弹窗默认选中月付。
    - **积分包**（记录 B、C、J；第 50 项其余规则不变）：只卖给会员，每 1 美元 100 积分，最小 $9.90。无论买多少次积分包，系统都不提示升级会员，取消第 50 项"Pro 一个月买 2 次以上积分包时提示 Gold"。会员买积分包打折（[记录 Q](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5980762284)）：Pro 会员 9.5 折、Gold 会员 9 折；取代"Gold 积分包折扣比例等算完成本再定"（9 折在记录 B 提示的约 23% 上限之内）。
    - **积分包三档和注册赠送**（[记录 S](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5980831854)、[记录 T](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5980843167)；先定，Owner 在开发完、实测积分消耗后再决定要不要调整加价倍数、积分包和注册赠送；定价窗口提过的调整办法 Owner 都还没有定，不作为决定）：

        | 档位 | 原价 | 积分 | Pro 会员（9.5 折） | Gold 会员（9 折） |
        | --- | --- | --- | --- | --- |
        | 小 | $9.90 | 990 | $9.40 | $8.90 |
        | 中 | $29.90 | 2,990 | $28.40 | $26.90 |
        | 大 | $99.90 | 9,990 + 赠送 1,000 = 10,990 | $94.90 | $89.90 |

        积分按原价每 1 美元 100 积分；会员折扣打在价格上，会员价 = 原价 × 折扣，向下取整到 $0.10（记录 T；取代记录 S 的"四舍五入到分"，记录 S 表中的 $9.41 / $8.91 等价格已由记录 T 取代）；只有大档有赠送。每一档的积分单价都比订阅贵（最便宜的 Gold 买大档约 $8.18/千积分，Gold 订阅约 $7.69/千积分），毛利约 72%–77%，是定价窗口的估算。
        注册赠送 500 积分（记录 S），取代"数量待定"和第 50 项"开户赠送 = Owner 实测后按公式定"；staging 迁移 0151 现在写死的是 100，改成 500 要走单独的数据库迁移（high），合并前需要 Owner 批准。
    - **客服响应时效**（[记录 Q](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5980762284)）：免费 48 小时内、Pro 24 小时内、Gold 工作时间内 2 小时内回复。
    - **Gold 优先内测**（[记录 Q](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5980762284)）：Gold 会员优先体验内测中的新功能。
    - **多平台发布和数据监控提前到上线前**（[记录 Q](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5980762284)）：上线前接入 Post for Me（海外 9 个平台，第 52 项），上线多平台发布和数据监控，并按会员档位区分：Pro 有一键发布和自己作品近 30 天的数据；Gold 另加对标账号监控、90 天趋势、每周自动复盘；两档都按积分计费、不限条数。**这改变了 D1 的上线范围**（第 10 节 D1），由新任务 PUBLISH-MONITOR 负责（第 7.1 节）。
    - **创始会员权益**（[记录 Q](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5980762284)、[记录 R](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5980780017)）：终身 6 折续费（写结果，括号里解释"连续续费不中断"），不写死金额；加入会员社群，在社群里直接和创始人沟通；每半个月一次社群内部直播，做会员案例拆解；创始会员墙可以展示会员自己的社交媒体账号卡片或产品，形成双向导流（展示前须有"愿意公开"的选项，见设计稿 README）；保留创始会员徽章（记录 R）；不承诺"功能需求优先开发"。创始人寄语暂时不定。
    - **余额不足**（记录 J）：沿用 BILL-PAYG 在两步之间暂停；充值成功后由用户手动点"继续"才恢复；不显示还差多少积分。
    - **多模型专家评审团**（记录 D、E、J）：Fusion 对外改名"多模型专家评审团"，产品内部仍叫 Fusion。评审和对比两种模式都只给 Gold，免费和 Pro 都不能用，取代 D4 里"Pro：评审和对比两种模式都能用"。对外只标"Gold 专属"，不用"只有 Gold 能用"的说法；宣传和付费墙要突出它的优势。价格页、方案卡和弹窗里的"报告评审"按评审模式的后台实际开关自动显示或隐藏（D12：实测不通过就关闭上线），"多模型对比"同样跟随对比开关。ENTITLEMENTS 的默认值（`allow_fusion_review`、`allow_fusion_compare`）在实施时相应调整，实际修改配置前单独批准。
    - **报告对外名称**（记录 P）：报告对外改叫"运营策略报告"，取代"定位报告"。只改对外名称和界面文案，不改代码标识符。
    - **只显示已上线的功能**（记录 J）：价格页、方案卡和弹窗的功能行跟随后台开关自动显示或隐藏；资料库上传上线前不显示资料库容量。
    - **Pro 中途升 Gold**（[记录 Q](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5980762284)，取代记录 J"差价交给 Waffo 支付任务定"）：不退差价（订阅本质上是更便宜的积分，Pro 当期积分已经到账、照样能用）；升级后往账上再发 8,970 积分，并立即升级为 Gold 权益。付款按 Gold 的价格（第一次买 Gold 享首月 $49，设计稿 v21 起）。计费周期（[记录 U](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5980903324)，已由 Owner 决定）：升级后下次扣费日从升级当天重新算，Gold 从升级当天起单独计费；原 Pro 订阅停止续费、不退差价；Pro 年付用户升级时，没发完的 Pro 年付积分继续按月发完。以上规则都已由 Owner 定，PAY-WAFFO 按它实施，处理了 #626 第 6 轮 P1"升级价格要在实施前锁定"。
    - **模型**：不变。模型按用途在后台配置，不按会员档位区分，输入框模型位置只显示 Auto（第 50 项）。
    - **定位档案数量**（记录 B、K）：免费 1 个、Pro 3 个、Gold 6 个；取代记录 B 的"会员不限、只留系统防滥用上限"。一个档案对应一个品牌，即现有的 `opc_businesses`；同一品牌下的定位版本、历史和报告不另算。每个档案在每个平台最多挂 1 个账号，平台数不限；实施时在 `opc_accounts` 现有的 `UNIQUE(actor_id, platform, account_key)` 之外，加"每个业务每个平台 1 个"的约束，新建档案时可以先不挂账号，挂上后锁定在这个档案。只计正在用的档案，删除后释放名额；现在没有业务级的删除或归档功能，由 PAYWALL 补上"删除或归档定位档案并释放名额"（删除遵守 DATA-ERASURE 的保留规则；技术建议用归档：归档后只读、可导出、不占名额，具体由 PAYWALL 方案定）。服务端在新建业务时检查（现在 `opc.start` 每次都新建业务，没有任何上限）；数量检查和插入 `opc_businesses` 要在同一个按用户加锁的数据库事务里完成（现有 `opc_start_b1` 插入不按用户串行，只先查数量会被并发请求同时越过），属于高风险迁移。会员到期或降级后，超出额度的档案改为只读（可看、可导出），由用户自己选哪几个继续可用。接受"在同一档案里反复改写"这个残余漏洞，不做内容检测。
    - **工作室版**（记录 K、L）：方向同意。上线时价格页只放"联系我们"入口，由 Owner 手动接单，超出额度的客户在后台单独调高上限；团队功能上线后再开发。方向是：10 个品牌起、5 位成员起，可以按需增加席位（[记录 Q](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5980762284)，取代"20 个档案起"）；团队共享积分池，按成员和客户统计用量；按客户隔离资料库、文风和报告；报告可换成工作室品牌导出；客户不用注册就能看的只读分享链接；含多模型专家评审团；优先支持；按量计价，单价更低。不定公开价格，按 B 端用户的用量灵活报价（[记录 Q](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5980762284)；记录 L 的 $199/月、每美元 140 积分作废）。
    - **真人专家诊断**（记录 K、L、[记录 Q](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5980762284)、[记录 R](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5980780017)）：专家由 Owner 本人担任，线上远程会议。只接待已经有数据基础的用户，卡片写"预约咨询，免费询价"；内部起步价每小时 $300，会员不打折。上线时只做预约入口，放在报告末尾、价格页和工作室版联系入口；用户填写需求和联系方式，提交后通知 Owner，由 Owner 线下跟进。**不做"同意专家查看报告"的授权开关**：后端没有这个开关，用户的资料只能由用户自己导出后发给我们（记录 Q）；"用户授权专家直接查看"上线时不做，以后有需要再立项（记录 R）。咨询费不走 Waffo、不进产品结账流程，用 Stripe 或线下收款；用 Stripe 直接收款时 Graylum 是卖方，咨询收入的税务和发票由 Owner 自己处理。用户填写的联系方式按个人数据处理，纳入注销和数据保留规则，属于 high。
    - **对比文案定稿**（记录 N）："雇佣一位社交媒体顾问：$2,000–10,000/月（来源：HawkSEM, 2026-07-27）"对比"雇佣 Graylum AI 社交媒体策略师：$29/月起"。出处是 HawkSEM《Social Media Consultants: What They Do, Costs + How to Hire One》（2026-07-27），原文指按月聘请做策略的顾问（不负责日常发帖）。这是营销公司的价格指南，不是调查数据。取代记录 E、F、J 里的所有对比文案草稿。
    - **付费墙视觉**（记录 N）：Owner 认为原来 8 个界面的视觉风格要改；Owner 已调整并定稿（v25，2026-10-04 入库），记录 N 的前提已满足；代码实施仍须 Owner 选定批次。
    - **Waffo 实施做法**（记录 I，定价窗口的建议，PAY-WAFFO 实施时核实）：Waffo 后台没有优惠券功能，按价格分别建 Waffo 产品：Gold 月付新用户（首期 $49、之后 $69）、Gold 月付正价 $69、微信一次性 1 个月 Gold 新用户 $49 和正价 $69、Gold 创始会员年付（首年 $496，续费按续费时 Gold 月付 12 个月价格的 6 折，不写死，记录 P），其余按原计划。Waffo 订阅文档写明支持"前 N 期特价、之后自动恢复原价"，具体配置位置和创始会员的长期折扣价能否设置，在 PAY-WAFFO 中核实（Owner 在后台找或问 Waffo）。由服务端选择产品，前端只显示服务端返回的价格；为防止注销后重新注册或并发结账重复领 $49：0151 的身份摘要（`opening_grant_identity_digests`，`purpose` 只允许 `opening_grant`）只记录开户赠送的判定，不能用来判断是否买过 Gold，不直接复用；PAY-WAFFO 扩展同一套身份摘要机制，新增 Gold 专属的权威事实（例如 `purpose=gold_first_purchase`），具备原子的预留和认领语义，属于 high 迁移。首月优惠的预留同样按结账会话幂等记录；只有 Waffo 权威确认该会话已关闭或已过期才释放（[PAY-COMMON 实施说明](tasks/PAY-COMMON.md)第 7 节"幂等"行）；预留有效期内到达的成功付款兑现 $49；释放之后才到达的成功付款不自动给首月价，按 PAY-COMMON 冲突回执的口径进入人工复核；同一用户在预留有效期内重新打开结账，复用同一预留，不因为自己放弃结账而失去资格。在 Waffo 后台建产品由 Owner 自己操作，实际配置前需要单独批准。
    - **定价窗口的毛利估算**（记录 F，按积分全部用完估算，仅供参考）：月付约 74%，Pro 年付约 71%，Gold 年付约 67%，创始会员按 $496 估算约 60%（[记录 Q](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5980762284)：定价窗口按积分全部用完、6 倍加价、Waffo 手续费 3.9% + $0.50 估算，不是 Owner 给的数字；取代按已作废的 $372.60 估算的约 48%）。
    - **待观察**（记录 B）：限流（每天 200 条新消息、600 次调用，所有档位一样）可能卡住重度付费用户；上线后看数据，再考虑是否按档位放宽。现在不改。
    - **退款规则**（[记录 Y](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5982111397)；取代"默认不退款、Owner 逐笔批准人工例外"，即 DATA-ERASURE E5 和 PAY-COMMON 已定 E5 中的这部分）：参照 Higgsfield 服务条款。
        - **2026-10-07 执行方式补充**（[确认记录](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-6020710288)）：原话为“退款人工审批”“退款申请入口需要通过工单申请，不要直接放在账单每笔订单旁边”“退款扣 6% 的手续费”。据此：仅通过现有客服工单申请、管理员人工审批后沿原渠道执行；不做用户自助或自动现金退款，不在账单页或订单旁新增入口；符合条件且法律允许时固定扣 6%。取代本项旧版“最多扣 6%”中未确定的实际费率，以及 PAY-COMMON §5 的三项待确认。资格条件不变；对外条款另行提供。
        - 首次购买会员（月付、年付、创始会员、微信一次性）、积分包、Pro 升 Gold：购买后 7 天内，并且这次买到的积分没有用过，可以申请退款；法律允许时固定扣 6% 手续费（2026-10-07 补充决定）。Pro 升 Gold 退的是这笔 Gold 付款：扣回 8,970 积分，恢复 Pro。恢复 Pro 的含义（[记录 AB](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5982435235)）：恢复到原 Pro 已付期限的原到期日为止，不延长也不缩短；原 Pro 订阅保持停止续费、不自动恢复扣费，到期前提醒用户自己重新订阅；年付 Pro 没发完的按月积分继续发到原到期日。退款时原到期日已经过了的，没有可恢复的 Pro 期限。
        - 不退：自动续费的各期、超过 7 天、这次的积分已经用过。取消订阅用到当期结束，不按比例退款。
        - 平台大幅缩减付费功能，或没有正当理由终止用户账号：按剩余时间退款；没有正当理由终止账号的，还要退没用完的已购积分。按剩余时间退款以后，这份会员到此结束，以后的积分不再发放，是创始会员的结束创始身份、名额不放回（记录 V）；功能缩减按剩余时间退款时，已经发放的积分不收回（[记录 AC](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5982525998)）。用户违规被终止账号（可以包括恶意拒付）：不退款，积分作废，不许换号重新注册。
        - 积分永不过期的规则不变。服务条款和退款政策的原文由 Owner 准备，不在规划范围内。
        - 年付在 7 天内只发了第一个月的积分，退款时扣回第一个月；创始会员退款后立即结束创始身份，名额不放回（第 51 项"创始会员"）。
        - "这次的积分没用过"的标准：从这次付款开始，账户没有任何积分消耗，不按积分来源分别记账（[记录 AA](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5982129081)）。7 天退款规则只写在常见问题和服务条款里，付费墙卡片不写（[记录 AA](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5982129081)，与设计稿 v25 一致）。
    - **付款前勾选同意条款和付款证据**（[记录 W](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5981381009)；Owner 同意定价窗口整理的方案）：
        - **A. 上线前完成（high）**：① 付款前有一个确认勾选框，默认不勾，不勾就不能付款，文案"我已阅读并同意《服务条款》和《退款政策》"，两份文件都带链接；付款按钮旁写清价格、扣款周期、是否自动续费、怎么取消，再加一句简短的退款说明；订阅、积分包和微信一次性付款都要有。② 每次用户主动结账或授权扣款时，保存一条只能追加、不能修改的同意记录（银行卡自动续费没有结账页面、没有当时的 IP 和浏览器，续费账单关联到原来那条同意记录；微信每次都是用户主动付款，每次都有记录；这是实施上的澄清，不改变 Owner 本意）：用户、时间、条款和退款政策的版本号（旧版原文要能查到）、IP 和浏览器信息、购买的商品、金额、付款方式、Waffo 订单号。③ 付款时额外记录 IP 和设备信息，作为反驳"盗刷"类拒付的材料。勾选框和前端展示归 PAYWALL，同意记录和订单绑定归 PAY-WAFFO。新建同意记录表之前，先按 AGENTS.md 第 5 节说明现有付款记录为什么不够用、权威来源是哪一个。IP 和设备属于个人数据，纳入 [DATA-ERASURE](tasks/DATA-ERASURE.md) 的保留和清理规则：现行 DATA-ERASURE 不把 IP/UA 放进财务保留，所以这些证据的保留期限由 PAY-WAFFO 方案提出（参考卡组织的拒付窗口再加余量），Owner 批准后同步修订 DATA-ERASURE，**修订完成之前不开始收集 IP 和设备证据**（写法同"Gold 购买记录的保留期限"）；隐私政策、服务条款和退款政策的文字由 Owner 准备，不在范围内，产品只负责展示链接、让用户勾选、记录版本号。设计稿 v25 原型没有这个勾选框，开发按本条做。
        - **B. 拒付和提醒**（记录 W 的 B 部分，按 [记录 X](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5981808905) 调整分工）：
            - **上线前，归 PAY-WAFFO**：④ 银行卡年付续费前提醒和微信创始会员到期提醒共用一套机制；⑤ 接收并记录 Waffo 的拒付和争议事件，不能忽略（对齐 [PAY-COMMON 实施说明](tasks/PAY-COMMON.md) 已定的 E5；前提是 Owner 先向 Waffo 核实拒付通知的方式），收到拒付通知后按被拒付的订单先冻结，可以撤回：订阅冻结这份订阅的付费权益、暂停以后的积分发放，并同时取消这份订阅的自动续费（银行卡月付和年付；[记录 AD](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5982615688)），拒付期间不会再扣款；微信一次性会员冻结这一期的会员权益，1 年期的还要暂停以后按月发放的积分（对齐记录 X"冻结会员权益和积分发放"）；订阅和微信一次性会员还要冻结这份付款已发放、还没用完的积分，不动其他来源（[记录 AC](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5982525998)）；积分包冻结这个包里没用完的积分，不动其他来源的积分（[记录 Z](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5982115736)）。
            - **上线后，归 CHARGEBACK（不阻塞上线）**：⑥ 最终判定输了，按商品分别处理：订阅按退款规则处理这一期，扣掉还没用完的积分、终止这份订阅以后的积分发放，是创始会员的立即结束创始身份（名额不放回）；微信一次性会员结束这一期，1 年期的终止以后按月发放的积分、扣掉这一期还没用完的积分（是创始会员的同样结束创始身份）；订阅和微信一次性会员被冻结的已发积分判输扣回、判赢解冻，不动其他来源（[记录 AC](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5982525998)）；积分包扣回这个包里没用完的积分、判赢解冻，不动其他来源的积分（[记录 Z](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5982115736)）；所有拒付都不自动接受，由 Owner 人工处理（[记录 Y](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5982111397)）；赢了就解除冻结、恢复，按幂等处理（拒付期间被暂停的按月积分，判赢后按原发放日逐期补发，幂等，不改变原会员期限和发放日期，不延到原到期日之后）；订阅判赢后不自动恢复扣费，提醒用户自己重新订阅；判输时订阅终止（[记录 AD](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5982615688)）；具体由 CHARGEBACK 方案提出、Owner 批准；⑦ 一键导出申诉材料；⑧ 对同一个人反复拒付加以限制；⑨ 信用卡账单上的商户名要让用户一眼认得出（由 Waffo 控制）。
    - **仍待定**（唯一来源设计稿、记录 V 和 [记录 Q](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5980762284)）：创始人寄语；创始会员退出社群的流程（记录 V 实施注意，还没有设计）；Owner 向 Waffo 核实（记录 W）：拒付时会不会通知我们、要交什么材料和期限、拒付手续费由谁承担、账单上显示的商户名、Waffo 结账页是否已有自己的条款勾选（避免重复或冲突）。注册赠送和积分包档位已由 [记录 S](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5980831854) 先定，实际写入配置仍须 Owner 批准。其余待定事项见[设计稿 README](design/paywall/README.md)。邀请奖励 50/30 按 m=6 复核（第 50 项）不变。
    - **实施分工**（第 7.1 节；每条只由一个任务负责）：
        - **PAYWALL**：本项的价格展示和弹窗规则（美元显示、年付省多少、续费说明、默认月付、首月和创始会员的展示、真实剩余名额、只显示已上线功能、评审行跟随开关、对比文案、不提示升级、充值后手动继续、积分包会员折扣、客服时效和 Gold 优先内测的展示）；定位档案上限（会员权益加"定位档案上限"字段、服务端新建业务检查、每个业务每个平台 1 个账号的约束、降级后只读）；Fusion 默认权限按 Gold 专属调整；工作室版"联系我们"入口。设计依据 v25 已入库；代码实施须 Owner 选定批次。
        - **PAY-WAFFO**（PAY-COMMON 之后）：按价格分建 Waffo 产品；首月资格和创始名额的服务端判断与计数；微信一次性与银行卡同价；Pro 升 Gold 按记录 Q 实施（不退差价、补发 8,970 积分、立即升级权益）；"前 N 期特价"和创始长期折扣的 Waffo 能力核实。
        - **EXPERT-CONSULT**（新增）：专家诊断预约入口和联系方式的个人数据处理（不做授权查看）。
        - **PUBLISH-MONITOR**（新增，记录 Q）：多平台发布和数据监控，Pro/Gold 分档。
        - **CHARGEBACK**（新增，记录 W、X，上线后）：拒付判输后的处理、申诉材料导出、限制反复拒付、账单商户名。（续费和到期提醒、拒付事件接收和可撤回冻结归 PAY-WAFFO，上线前。）
        - **不对应开发任务**：价格和产品的实际配置（staging、正式环境、Waffo 后台）执行前另获批准；限流待观察；工作室版团队功能在上线后另立任务。

    - **方案必须先解决的事项**（Owner 2026-10-04 批准合并 #626 时接受，[总控记录](https://github.com/Crnobog9527/GraylumAI_vercel/pull/626#issuecomment-5976838440)；相关实施 PR 在解决前不得合并）：
        1. Gold 首购身份摘要（`gold_first_purchase`）在账号注销后的保留期限和清理契约：现行 DATA-ERASURE 规则只允许保留开户赠送的 HMAC 事实且有到期时间，财务记录保留 3 年（[DATA-ERASURE 实施说明](tasks/DATA-ERASURE.md)）。PAY-WAFFO 方案要定义这条事实的保留和到期，并同步修改 DATA-ERASURE 的清理契约。**Gold 购买记录的保留期限由 Owner 在方案阶段确认。**
        2. ~~创始会员名额只在合约确认取消后才放回~~：**已由 [记录 V](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5981192614) 取代**，已售出的名额在任何情况下都不放回。验收改为确认退款、取消、续费失败都不会让名额放回，并且并发时不会超过 50 个。
        3. 工作室版"由 Owner 手动接单并调高单个客户的档案上限"，需要按客户单独覆盖上限（有上限范围）和后台入口；或者在工作室任务交付这个能力之前，"联系我们"只收集意向，不承诺额度。由 PAYWALL 方案确定。

52. **第三方数据备用渠道和海外发布平台**（Owner 2026-10-04 在定价策略审阅窗口决定，由该窗口转述；[#626 总控记录](https://github.com/Crnobog9527/GraylumAI_vercel/pull/626#issuecomment-5978108420)）。Owner 原话：

    > Bright Data 我注册了个使用账户感觉挺强的。 可以作为第三方搜索 api 备用渠道， 特别是海外平台。 facebook 就用Bright Data 抓取。

    整理（总控记录的含义，不是 Owner 原话）：

    - **Bright Data**：作为第三方数据的备用渠道，主要覆盖海外平台，取代第 3.7 节和 D13 中"每类一家、没有备用"的说法。Facebook 公开数据由 Bright Data 抓取（TikHub 不覆盖 Facebook）。
    - **接入要求**：计费按 D14 的用量口径；接入前先做一次小额实测（预算需另行批准）；密钥由 Owner 自己配置，不经过任何窗口；读完并核对 Bright Data 的条款原文。付费墙或常见问题中"Facebook 也能查公开数据"的说法，以接入后的实测结果为准，未实测前不对外承诺。
    - **背景**（定价窗口核实，不是 Owner 原话）：2024-01-23 Meta v. Bright Data 一案，Bright Data 胜诉（未登录抓取公开数据并出售不违反 Meta 条款）；Bright Data 的 Facebook 抓取每月 5,000 条免费，之后约 $0.75/千条起（定价窗口当时的说法，未核实；Bright Data 产品页目前标价可能更高，以接入前核对的实际价格为准）。
    - **海外平台以 Post for Me 支持的 9 个为准**（定价窗口记录，Owner 已定；评论里没有附 Owner 原话）：TikTok、Instagram、YouTube、Facebook、X、Threads、LinkedIn、Pinterest、Bluesky，用于发布和查看用户自己授权账号的作品数据；Reddit 的公开数据只有 TikHub 能查（定价窗口当时的说法；Reddit 不在 [RESEARCH-TOOLS](tasks/RESEARCH-TOOLS.md) 已验证的平台清单里，实测并加入清单之前按"取不到数据"处理，不对外承诺）。这会影响"多平台发布和数据监控"，由 PUBLISH-MONITOR 负责（第 2.1 节第 51 项、第 7.1 节，[记录 Q](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5980762284)）。
    - **实施分工**：Bright Data 接入归 RESEARCH-TOOLS（增加备用线路）；本项只改规划，实测预算、密钥配置和条款核对各自另行批准。

53. **服务商额度不足（402）且多次查不到费用时按没有费用处理**（Owner 2026-10-04，[#627 总控记录](https://github.com/Crnobog9527/GraylumAI_vercel/pull/627#issuecomment-5980132609)）。Owner 原话：

    > 同意：服务商明确回复额度不足、没有生成内容和用量、多次查询都查不到费用记录时，当作没有费用，释放这一次调用的冻结；万一服务商实际收费，由 Graylum 承担。

    整理（总控记录的含义，不是 Owner 原话）：只释放被拒绝的这一次调用的冻结；只要有一次查询查到费用或终态记录，就按原规则处理（非零费用照扣）；查询失败、超时不算"查不到"。实施见 #627 及其后续修复。

54. **REPORT-GEN 按 #547 第八版实施；#547、#553 两个方案 PR 关闭**（Owner 2026-10-04 定稿，2026-10-05 同意关闭）。

    Owner 2026-10-04 原话（[#547 总控记录](https://github.com/Crnobog9527/GraylumAI_vercel/pull/547#issuecomment-5971932591)）：

    > 同意 #547 报告生成方案按当前版本定稿（描述 SHA-256 55f02f21），PR 保持开着作为实施依据；开发按方案的前置顺序开工。

    2026-10-05 仓库规则精简（AGENTS.md 第 6 节：方案不再以 PR 形式保留）后，Owner 同意 Claude 的建议："把里面已经定下的结论写进 MASTER_PLAN，然后关掉这两个 PR，剩下没定的问题在聊天里跟你过一遍"，Owner 原话："两个方案 PR 按你的建议处理"。

    整理（不是 Owner 原话）：

    - **#547（REPORT-GEN）**：实施依据是 #547 描述第八版，原文已逐字节存进 [REPORT_GEN_PLAN.md](REPORT_GEN_PLAN.md)（SHA-256 `55f02f21d392f7a60674fc0b4daed81a6c54e0d4da5938347914b0255235f0fa`），以仓库文件为准，不依赖已关闭的 PR。其中三处已被取代：报告单独的输出上限 24576（D1，被第 44 项取代）、截断后自动续写（首版不做，第 44 项后续决定）、默认加价倍数 3（第 50 项改为 6）。开工前提：BILL-PAYG 默认切到 v2、#604 的 C0+C1 已合并、PAYWALL 的服务端会员检查已交付。
    - **#553（BILL-PAYG）**：后端已由 #617、#631、#632 及后续修复实施（见 [BILL_PAYG_RUNTIME_B1.md](BILL_PAYG_RUNTIME_B1.md)、[B2](BILL_PAYG_RUNTIME_B2.md)）；#553 里的 Owner 决定已在第 13、26、27、32、33、41、42 项。剩余工作（默认切到 v2、管理员提醒页面、模型准入实测）实施时参考 [BILL_PAYG_PLAN.md](BILL_PAYG_PLAN.md)（#553 描述原文存档，仅供参考，不是定稿）的对应小节。
    - **还没定、开工时在聊天里问 Owner 的事**：BILL-PAYG 的模型准入实测预算、典型名义费用样本及配置（启动门槛公式已由 2026-10-06 决定自动适配倍数）、平台每天承担费用的提醒线、正式环境要不要设亏损上限、对外计费说明；REPORT-GEN 的 staging 实测模型和预算（D2）、staging 是否临时调高 8192（D3）、报告写满被截断时怎么收费。正式环境单次上限已定为 32768（第 44 项后续决定），实施时只做费用和耗时的技术核对；核对发现不可行时再问 Owner。

**2026-10-05：保留出卡前分析**

Owner 原话：「同意 A：出卡前导师写的分析保留并保存，卡片里的话接在后面。」
依据：[#659 决定](https://github.com/Crnobog9527/GraylumAI_vercel/pull/659#issuecomment-5990797484)。
新回合的正文保存助手分析和卡片 `message`，精确重复只保留一次；实时连续增长，刷新及下一轮历史与保存正文一致。
旧回合保持原样。这取代 CHAT_NATIVE_OUTPUT_PLAN.md §2.3 中“出卡前的助手文字在出卡时被替换”的旧规则。

55. **BILL-PAYG profile 单次消息上限提高到 128**（Owner 2026-10-05，
    [#662 决定记录](https://github.com/Crnobog9527/GraylumAI_vercel/pull/662#issuecomment-5994766922)）。Owner 原话：

    > 采样时把单次消息条数上限提高到 128，对话历史恢复到和现在差不多。

    取代 profile 的 `maxMessages=32` 限制；真实采样加入 64、96、128 条短消息和长消息及缓存场景，
    用原生用量证明逐条消息模板开销仍在 K+M=8192 的余量内。历史最多保留与 v1 相近的 100 条，
    仍受 `maxBytes=196608` 和工具轮次预留约束；不能用离线预演代替真实证明。
    采样计划与执行器先交主窗口审阅，通知后才可使用已批准的 OpenRouter 测试余额；不充值。

**2026-10-06：PAYG-THRESHOLD-AUTO 启动门槛自动适配倍数**

来源：Owner 本次 PAYG-THRESHOLD-AUTO 任务授权。原话：

> 启动门槛不再手动维护，必须随倍数自动适配；不同 skill 指定的模型倍数不同，门槛要按各自倍数计算。

取代第 41 项及 BILL_PAYG_PLAN 的 Q2“首版不随价格自动更新、管理员手动调整”。
`billing_payg_start_thresholds` 按精确模型＋用途保存典型名义费用 `typicalUsd`（美元十进制字符串）；
每次领取按 run 冻结 q、本 call 冻结 m_i 计算 `L=max(1,ceil(typicalUsd×q×m_i))`，保存实际 L 和配置版本。
保留旧整数格式供迁移切换，不改 G/H、余额封顶、已冻结调用或结算。
本任务只交付 draft→CI/Security→ready 和独立审查；迁移及 staging 配置切换由主窗口批准后执行，不访问远端数据库、不合并。

**2026-10-06：BILL-PAYG profile 采样累计限额降为 $25**

Owner 原话：「把 #665 采样的累计总限额从 48 美元降到 25 美元」。
依据：[#665 决定记录](https://github.com/Crnobog9527/GraylumAI_vercel/pull/665#issuecomment-5998517105)。
从第三批起取代原 $48 限额；累计上界为前两批已入账 $2.5964977 加新批次上界，必须小于 $25，单条上限不变。
第二批第 49 条经 Owner 核实服务商后台总额后按 $0 入账，原 UNKNOWN 回执保持不变，
依据：[费用核实](https://github.com/Crnobog9527/GraylumAI_vercel/pull/665#issuecomment-5998488867)。
第三批先准备和复核，收到主窗口通知前不得发送真实请求；不补跑、不充值、不删除旧锁。

**2026-10-05：REPORT-GEN 后端默认关闭开工，合并报告前服务端会员检查**

Owner 原话（本次实施授权）：

> 同意现在开工一键报告后端（默认关闭）、并从付费墙拆出"报告前服务端会员检查"一起做；依赖升级 PR 先交 Codex 只读评估。

本项取代第 54 项中把 BILL-PAYG 默认切到 v2 和 PAYWALL 会员检查交付作为后端开工前提的安排：
REPORT-GEN 后端现在开工，标明“未完成、默认关闭”，报告入口与调用准入两处服务端会员检查一并实施。
会员来源、报告生成收费和会员到期后旧报告可看可导出的决定不变；输出沿用全站统一上限，首版不自动续写。
真实 staging 实测仍等 BILL-PAYG 在 staging 开启；D2 模型与额度、D3 是否临时调高 8192、写满截断时收费，
由主窗口在实测前询问 Owner。本次不授权真实模型调用、远端数据库访问、应用迁移、环境配置或合并。
依赖升级另作只读评估，不纳入本实现。

**2026-10-06：BILL-PAYG 小输出硬限实测（主窗口技术决定）**

依据：[#665 第三批审计](https://github.com/Crnobog9527/GraylumAI_vercel/pull/665#issuecomment-5999267254)。
后续每模型每种思考设置至少两条小 max_tokens 输出压力，要求 length 且原生 completion（含 reasoning）精确等于上限。
取代“所有输出压力必须写到 8192”的采样标准；已有 8192 触顶保留为观测。host profile 如实填写所证明的较小 outputLimit，
不外推放行更大请求。r4 为 Luna 剩余样本和 Sonnet 新输出压力，r5 为 Gemini 剩余样本；两批单独授权，
Gemini 等原 google-vertex/global 线路恢复，不换线路。累计限额仍 $25，当前已入账 $4.8101395；本轮只准备。

**2026-10-06：BILL-PAYG 输出语义与用途上限分开（主窗口技术决定）**

依据：[#665 r4 复核及执行授权](https://github.com/Crnobog9527/GraylumAI_vercel/pull/665#issuecomment-5999661106)。
小 max_tokens 样本证明严格截断且 completion 包含 reasoning；每种设置至少两条成立后，profile 的 outputLimit 可用
PURPOSE_OUTPUT_CAP（8192）。证据分别记录 testedOutputLimit 与允许的 outputLimit，不把小上限触顶冒称 8192 实测。
取代上一条“profile 只能填写较小 outputLimit、不放行更大请求”的限制；输入、缓存、费用和思考设置覆盖要求不变。
本轮只授权 r4，r5 不得执行；任何停止不补跑，配置建议只写 PR，由主窗口决定应用。累计预算仍 $25。

**2026-10-06：BILL-PAYG 输出压力判定调整（主窗口技术决定）**

依据：[#665 r5b 审计](https://github.com/Crnobog9527/GraylumAI_vercel/pull/665#issuecomment-6000858032)。
主窗口原文：“通过标准改为：finish_reason=length，并且 completion（含 reasoning）≤ O，并且 ≥ 0.9 × O”；
“OUTPUT_CAP_NOT_REACHED 改为记录后继续，不再停批”。取代上述小上限必须精确等于 O 和未触顶即停批的采样要求。
超过 O、费用未知、越界、拒绝、线路/目录不可用、身份/hash失败仍停；未达标样本不成为合格 profile 证据，不补跑。
r5b首条508/512、length作为合格证据保留，原始停批记录不改写；其余95条原请求准备r6，当前已入账$4.991984715。
累计限额仍$25；本轮只准备，主窗口复核通知前不发送任何真实请求。

**2026-10-06：BILL-PAYG Gemini采样改用AI Studio（Owner决定）**

依据：[Owner原话](https://github.com/Crnobog9527/GraylumAI_vercel/pull/665#issuecomment-6001418763)：
“665切换为Google AI Studio 的线路测试， Gemini 的 Vertex 线路太不稳定。”
取代此前Gemini固定google-vertex/global采样的决定，改为完整tag google-ai-studio，不加/flex或/priority。
Vertex首条不能移作AI Studio证据，完整76条重新准备；r6不执行，Luna整理16和Sonnet输出4原请求保留为r7。
已入账$4.991984715，累计仍不得达$25；本轮只准备不执行，未来实际路由配置由主窗口另行处理。

**2026-10-06：BILL-PAYG r4费用确认与r5b准备**

依据：[Owner后台核实](https://github.com/Crnobog9527/GraylumAI_vercel/pull/665#issuecomment-6000132517)。
r4第77条未收费，按$0入账；r4已入账$0.179168465，前四批累计$4.989307965，原始UNKNOWN回执不改写。
本次Owner要求原r5作废，改为r5b的Gemini76条、Sonnet新ID输出4条，并补齐Luna整理用途/格式缺口。
取代此前r5独立执行安排，累计限额仍$25；只准备，主窗口复核通知前不得发送真实请求。

**2026-10-06：报告前端开工；写满截断照常收费并提示；D2、D3 定案**

Owner 原话（[#667 记录](https://github.com/Crnobog9527/GraylumAI_vercel/pull/667#issuecomment-6000458917)）：

> 开工一键报告页面（Claude）和依赖升级第一批 Next/React（Codex）；报告截断照常按实际收费并提示，staging 用 Claude 实测 3 份报告、额度 2 美元，staging 不调高 8192

整理（不是 Owner 原话）：

- 写满被截断（`length_limit`）的报告按实际用量照常收费，和 #667 后端现有做法一致，不改收费代码；
  页面在正文外明确提示报告已截断。截断的报告不是候选，不能定稿。
- D2：staging 用 Claude（Sonnet 5.5）实测 3 份报告，供应商费用合计不超过 2 美元，从已批准的 OpenRouter 测试余额里出。
- D3：staging 不调高全站统一单次上限 8192。
- 本项取代第 54 项和上一项里"D2、D3、写满截断怎么收费由主窗口在实测前询问 Owner"的待定安排。
  报告前端仍跟随服务端开关 `runtime_report_generation`；开关和 BILL-PAYG 在 staging 的开启由主窗口执行。

**2026-10-06：CDC-WRITEBACK-V2 分阶段写回优化**

Owner 原话（本次任务授权）：

> 同意开工 CDC 写回优化：整理继续用 GPT-6 Luna，按扩评测→字段说明→清理提示词→建议可见与撤回的顺序逐步改、逐步测，总预算 5 美元。

保持现有 openai 线路和思考设置；导师样本使用现有 Sonnet 5.5 配置生成一次并冻结。
本项新增优化任务，不取代既有模型选择。四阶段共用 5 美元测试上限，逐次检查结算与预留，
不重试、不补样、不充值。每阶段独立测量、锁分后揭盲，完成后等待主窗口审计。
执行窗口不合并、不访问远端数据库、不改远端配置；迁移仅在本机一次性数据库验证。
验收与阶段证据见 [CDC-WRITEBACK-V2](CONVERSATION_CAPTURE_WRITEBACK_V2.md)。

**2026-10-07：CDC-WRITEBACK-V2 已有条件与投入限制分界**

Owner 在本任务对话中确认：“确认该划分。补充一条：‘不会××、做不到××’这类缺少的能力属于限制，
归‘能投入的时间、精力、预算和限制’；已经拥有的设备、技能、经历、作品、账号才归‘手上已有的条件’。
计划要花钱买的设备算预算，归投入资源。”

据此，assets 保存已拥有的条件；resources 保存投入、预算及限制，包含能力缺口和计划购买设备的花费。
取代定位 Skill 设计材料对设备／技能交叉归类的不明确口径；不新增字段，不改 elicitation，
不把计划购买当成已拥有，也不把缺少能力写成已有技能。字段说明草案见
[阶段②草案](CONVERSATION_CAPTURE_WRITEBACK_V2_FIELDS.md)。

**2026-10-07：定位页清单与导师联动**

Owner 原话（本任务授权，记录于 [后端 PR #702](https://github.com/Crnobog9527/GraylumAI_vercel/pull/702)）：

> 同意：导师每轮能看到右侧已填内容；右侧改完后显示"让导师接着聊"，由用户点击才触发；保存流程提速。

导师每轮读取右侧当前草稿或已确认值，保留来源、性质和保护标记，基于已有内容追问缺口，
不重复索取已填信息、不擅自改写已确认内容。手填内容按用户提供的信息处理，保留其中的不确定性。
保存本身不触发模型调用；用户明确点击后才通过普通发送的准入、计费和 requestId 重试链路通知导师。
整理不得把宿主通知当作用户原话写入字段；导师本轮对建议字段提出的具体建议仍遵守既有保护与采纳规则。
取代原宿主上下文“只给状态、不给字段值”的实现限制，并明确保存后继续对话必须由用户点击，
不新增自动调用；不改变已锁定的字段归属、确认和计费规则。前后端分工及接口见
[定位清单联动](OPC_MENTOR_CHECKLIST.md)。

**2026-10-07：整步确认关卡**

Owner 原话（[决定与后端范围](https://github.com/Crnobog9527/GraylumAI_vercel/pull/702#issuecomment-6021647105)）：

> 同意确认关卡按"聊天里一张确认卡、一步只点一次"设计：只标出 AI 整理和建议的内容让用户看一眼；用户说"继续"或"没问题"时导师重新给出确认卡，不自动确认、不进入下一步；右侧清单照常可改。

取代本流程中以聊天文字同意代替整步确认、以及在右侧逐项确认的旧交互。
必填齐全但未确认时，导师只简短总结本步并请用户点击聊天确认卡，不开始下一步分析或方案。
用户主动提供后续信息仍由整理器记录，方向 B 不变；模型和整理器均不得确认。
确认沿用带可见快照及前置版本校验的整步接口。后端信号约定见
[定位清单联动](OPC_MENTOR_CHECKLIST.md#整步确认信号)。

### 2.2 被本版取代的旧规则

| 旧规则 | 出处 | 本版处理 |
| --- | --- | --- |
| 封闭内测：上线基础完成后先邀请 5–10 人内测，只用赠送积分、不开放付费；以及写作"封闭内测前""内测前提"的安排 | 第 10 节 D8；第 2.1 节第 7、19、30、49 项；第 7.2、7.4、7.6 节 | 由第 2.1 节第 50 项取代：取消封闭内测，按 D1 范围完成后直接公开上线售卖。原写"封闭内测前"的事项（正式环境 Upstash、Vercel Pro 等）改读为"公开上线前"；第 49 项"限流按每条新消息计"不变 |
| 只持银联单币卡、只用支付宝的用户买不了会员时，可以用支付宝买积分包的兜底；以及只为这条兜底设的支付宝验收（积分包支付宝一笔、生产 canary 的支付宝一笔、live 支付宝方式核对） | [v10.1](Graylum_Master_Plan_v10.1.md) D11 及其边界说明（第 81、567 行）、PAY-1 第 1 条（第 278 行）、G5（第 385 行）、G8（第 388 行）、上线核对第 13 项（第 413 行） | 由第 2.1 节第 50 项取代（[总控记录](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5969904509)）：积分包只卖给会员，兜底作废，这些支付宝验收不再是上线要求。Owner 核实 Waffo 不支持支付宝；银行卡支持订阅；微信只支持单笔，用于积分包和一次性会员（[总控记录](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5970044974)）。已接受的边界：只用支付宝的用户付不了款 |
| 新销售默认走 Waffo，Stripe 作为备用渠道保留，管理员可手动把新购买切到 Stripe | 第 2.1 节第 12 项；D17 | 由第 2.1 节第 50 项取代（[总控记录](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5970044974)）：上线只用 Waffo 收款，Stripe 不作为上线收款渠道；PAY-COMMON 的手动渠道开关保留，只作备用。同一订单不跨渠道重试、已成交订单按原渠道处理等其余规则不变 |
| 对比模式"对比最少 2 个模型"固定为常量；对比模式只写"用户自己勾选"，没有默认勾选组合 | [ENTITLEMENTS 实施说明](tasks/ENTITLEMENTS.md)第 221 行 P4；[FUSION 实施说明](tasks/FUSION.md)对比模式说明；本文第 4.1 节旧写法 | 由第 2.1 节第 50 项取代（[补充说明记录](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5970264949)）：最少勾选数改为后台参数，由 Owner 调整，前端和服务端都按它校验；每次打开默认勾选管理员设定的一组模型，用户可以改。D3 的最多模型数不变。FUSION.md 和 ENTITLEMENTS.md 由 FUSION-COMPARE 实施 PR 同步，本 PR 不改 |
| 全站默认加价倍数 m=3 | 第 2.1 节第 11、33、34 项；D16 | 由第 2.1 节第 50 项取代为默认 m=6；按模型/线路配置、冻结和只进位一次的规则不变；实际修改配置须执行前另获 Owner 批准 |
| D4 "Pro：评审和对比两种模式都能用" | 第 10 节 D4；[ENTITLEMENTS 实施说明](tasks/ENTITLEMENTS.md) 的默认值 | 由第 2.1 节第 51 项取代（[记录 D](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5972065193)）：两种模式只给 Gold，免费和 Pro 都不能用；对外名称"多模型专家评审团"，标"Gold 专属"（[记录 E](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5972167876)）。`allow_fusion_review`、`allow_fusion_compare` 默认值随 PAYWALL 实施调整，实际修改配置前单独批准；ENTITLEMENTS.md 由该实施 PR 同步，本 PR 不改 |
| 月价 = 实测用量 ÷ 每美元积分；年付折扣和营销优惠上线时再定；年付 = 10 个月价格 | 第 2.1 节第 50 项"数值怎么定""订阅周期"；[记录 E](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5972167876) | 由第 2.1 节第 51 项取代（[记录 F](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5972366406)、[记录 G](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5972469380)）：Pro $29/月、Gold $69/月，每月 3,480 / 8,970 积分；年付 Pro $279、Gold $621，每月积分同月付；开户赠送后来由第 51 项定为注册赠送 500 积分（记录 S） |
| Pro 一个月买 2 次以上积分包时提示 Gold 更划算 | 第 2.1 节第 50 项"其他付费提示""实施分工"；第 7.1 节 PAYWALL 行 | 由第 2.1 节第 51 项取代（[记录 C](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5972054913)）：无论买多少次积分包，系统都不提示升级会员 |
| 会员不限定位档案数，只留系统防滥用上限 | [记录 B](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5971895597)；PAYWALL-DESIGN 旧定稿文案 | 由第 2.1 节第 51 项取代（[记录 K](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5972689626)）：免费 1、Pro 3、Gold 6；降级后超出额度的档案只读 |
| Gold 新用户首月 8 折 $55.20；对比文案的各版草稿（MarketerHire、Sprout Social、"请人做社交媒体运营"） | [记录 E](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5972167876)、[记录 F](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5972366406)、[记录 G](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5972469380)、[记录 J](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5972539553) | 由第 2.1 节第 51 项取代：首月 $49（[记录 H](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5972485899)）；对比文案以 HawkSEM 版定稿（[记录 N](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5972956845)） |
| PAYWALL-DESIGN 定稿 artifact `QLdBcaYMUSRQHa1YPQa2VQ` 作为付费墙设计依据 | 设计窗口定稿 | 由第 2.1 节第 51 项取代（[记录 M](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5972835435)）：唯一依据是仓库里导出的 v25（[`docs/launch/design/paywall/`](design/paywall/README.md)，来源 artifact `MW9Ja3xTfLNbzraTudi2X7`），旧定稿留作历史 |
| 创始会员 $372/年（以及 $372.60），第一年和续费都按这个价 | 第 2.1 节第 51 项旧写法；[记录 O](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5976467607) | 由第 2.1 节第 51 项取代（[记录 P](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5979988044)）：首年 $496（$828 的 6 折取整）；续费按续费时 Gold 月付 12 个月价格的 6 折，不写死；年付标签"最高省 40% / 25%"按名额切换（[记录 V](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5981192614) 去掉了付款方式条件） |
| 报告对外叫"定位报告" | 第 2.1 节第 51 项、第 7.1 节 EXPERT-CONSULT 行旧写法 | 由第 2.1 节第 51 项取代（[记录 P](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5979988044)）：对外名称"运营策略报告"；代码标识符不改 |
| 第三方数据每类只有一家、没有备用线路 | 第 3.7 节；D13；[RESEARCH-TOOLS 实施说明](tasks/RESEARCH-TOOLS.md) | 由第 2.1 节第 52 项取代：Bright Data 作为备用渠道（主要海外平台），Facebook 公开数据由 Bright Data 抓取；接入前实测和条款核对 |
| 工作室版 20 个档案起、可加购；$199/月、每美元 140 积分的示例价 | 第 2.1 节第 51 项旧写法；[记录 L](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5972732100) | 由第 2.1 节第 51 项取代（[记录 Q](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5980762284)）：10 个品牌起、5 位成员起，可以按需增加席位；不定公开价格，按用量报价 |
| 专家咨询勾选"同意专家查看我的报告"（只授权给这一位专家，可撤回） | 第 2.1 节第 51 项、第 7.1 节 EXPERT-CONSULT 行旧写法；[记录 L](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5972732100) | 由第 2.1 节第 51 项取代（[记录 Q](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5980762284)、[记录 R](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5980780017)）：不做授权开关，资料由用户自己导出后发来；授权查看功能上线时不做 |
| 创始会员毛利约 48%（按 $372.60）；以及"由总控转述"的约 60% | 第 2.1 节第 51 项旧写法 | 由第 2.1 节第 51 项取代：按 $496 估算约 60%，出处为 [记录 Q](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5980762284)（定价窗口估算，不是 Owner 给的数字） |
| Gold 积分包折扣比例等算完成本再定 | 第 2.1 节第 51 项旧写法；第 10 节"定价占位值" | 由第 2.1 节第 51 项取代（[记录 Q](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5980762284)）：Pro 会员 9.5 折、Gold 会员 9 折 |
| 开户赠送 = Owner 实测后按公式定；积分包 $9.90 以外的档位待定；积分包会员价四舍五入到分 | 第 2.1 节第 50 项"数值怎么定"；第 51 项旧写法；记录 S | 由第 2.1 节第 51 项取代（[记录 S](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5980831854)、[记录 T](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5980843167)）：注册赠送 500 积分；积分包三档 $9.90 / $29.90 / $99.90；会员价向下取整到 $0.10；均为先定，实测后可能调整 |
| 创始会员只限银行卡订阅、微信一次性不参加；年付标签"最高省 40%"只在银行卡付款时显示 | 第 2.1 节第 51 项旧写法；记录 E、F、J、P | 由第 2.1 节第 51 项取代（[记录 V](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5981192614)）：前 50 位 Gold 年付会员，银行卡和微信都算；名额没卖完时不论付款方式都写"最高省 40%" |
| 全额退款放回创始名额（记录 J）；以及本 PR 曾统一的"全额退款并且 Waffo 确认创始订阅已取消后才放回"、#626 方案前置事项第 2 条的放回条件 | 第 2.1 节第 51 项、第 7.1 节 PAY-WAFFO 行旧写法；[记录 J](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5972539553) | 由第 2.1 节第 51 项取代（[记录 V](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5981192614)）：已售出的名额在任何情况下都不放回；例外退款立即结束创始身份 |
| 订阅和积分包付款成功后默认不退款，Owner 逐笔批准人工例外；不提供 7 天退款 | [DATA-ERASURE 实施说明](tasks/DATA-ERASURE.md) E5（#474）；[PAY-COMMON 实施说明](tasks/PAY-COMMON.md) 已定 E5 和 P1；第 2.1 节第 47 项、第 51 项旧写法 | 由第 2.1 节第 51 项取代（[记录 Y](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5982111397)）：首购、积分包、Pro 升 Gold 在 7 天内且从这次付款起整个账户没有任何积分消耗可以退（记录 AA），按 2026-10-07 补充决定，法律允许时固定扣 6% 手续费、按币种最小单位向下取整；法律禁止时不扣费，适用性未知先核对；续费期、超过 7 天、积分已用过不退；取消用到当期结束。支付商已经发生的退款或争议事件仍不能忽略 |
| 记录 W 的 B 部分整体作为上线后任务 CHARGEBACK：年付到期提醒、拒付发起时的冻结都在上线后 | 第 2.1 节第 51 项、第 7.1 节 CHARGEBACK 行旧写法；[记录 W](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5981381009) | 由第 2.1 节第 51 项取代（[记录 X](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5981808905)）：银行卡年付续费前提醒和微信创始会员到期提醒共用一套、拒付事件接收和可撤回冻结，都归 PAY-WAFFO 上线前完成；判输处理、申诉材料导出、限制反复拒付、账单商户名仍归上线后的 CHARGEBACK |
| Pro 升 Gold 差价交给 PAY-WAFFO 方案提出、Owner 批准 | 第 2.1 节第 51 项旧写法；[记录 J](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5972539553)；第 10 节待定表 | 由第 2.1 节第 51 项取代（[记录 Q](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5980762284)）：不退差价，补发 8,970 积分并立即升级为 Gold 权益；计费周期按[记录 U](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5980903324)（扣费日从升级当天重新算，原 Pro 停止续费） |
| D1：社媒同步等放到上线后（多平台发布和数据监控不在上线范围） | 第 10 节 D1 | 由第 2.1 节第 51 项变更（[记录 Q](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5980762284)）：多平台发布和数据监控提前到上线前（PUBLISH-MONITOR），其余后续阶段不变 |
| "不影响没有 Fusion 权限的用户走普通定位到报告；升级提示不能成为定位流程的必经步骤" | [ENTITLEMENTS 实施说明](tasks/ENTITLEMENTS.md)第 180 行 | 由第 2.1 节第 50 项取代：生成报告必须是付费会员；免费用户可做完报告前的全部步骤，已确认的前置信息可看、可导出、不收回。Fusion 权限部分不变 |
| RUNTIME-PROD ④ 的统一预扣估算、报告固定上界预扣过渡方案 | 本文原第 7.1 节；#547 原方案 | 由第 2.1 节第 26–27、32–34 项取代：BILL-PAYG 余额封顶冻结，余额低于按模型/用途配置的 L 才暂停；超额由平台承担。D16 改按美元成本与逐调用倍数累计，预告边界不变 |
| 每 run 一次预留、run 与 pre_deduct 一一对应；平台承担超额需人工授权 | [BILL2 技术契约](tasks/V3-BILL-2-provider-authoritative-billing.md)第 43–53、81–89 行中的这两组条款 | 由第 2.1 节第 26–27 项取代：每次供应商调用按余额封顶冻结、封顶结算；超出冻结额自动由平台承担、不补扣、不需逐笔批准；只有超出估算上界本身才进入 `budget_conflict`、停止新调用，正常余额封顶不触发异常；保存真实成本及平台承担金额。其余不冲突条款继续有效，不将上述行号区间整体废止（[总控修订记录](https://github.com/Crnobog9527/GraylumAI_vercel/pull/559#issuecomment-5925648847)） |
| Fusion 按 RUNTIME-PROD 统一预扣估算规则冻结积分 | 本文原第 4.4 节第 2 条 | 已按 BILL-PAYG 逐次冻结规则取代：运行前总预估仅展示，每次供应商调用冻结该次估算上界与可用余额的较小值；Fusion 多模型单次上界由 FUSION-REVIEW 定义，定义前不放行。保留运行前预告和三种结局的收费规则（[总控修订记录](https://github.com/Crnobog9527/GraylumAI_vercel/pull/559#issuecomment-5925344654)） |
| 层级题号 1.1/1.2、只展示已到达的问题、逐题确认 | v11 §4.4；架构规格 §3.3 的逐字段状态 | 由第 3 节取代：每一步确认一次，笔记只分"草稿 / 已确认" |
| 多模型智囊团只给 Gold 用户，模型组合只由管理员配置，用户只能开关 | v10.2 §5–§6；架构规格 §7.1、§10；v11 §6.2 | 由第 4 节取代：分评审和对比两种模式；对比模式用户可在管理员允许的范围内自选模型；各等级权限由管理员配置。2026-10-04 起上线默认又改为只给 Gold（第 2.1 节第 51 项，[记录 D](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5972065193)），权限仍由后台配置 |
| 资料库不新增文件上传 / RAG / 网盘 | v11 §5.2；架构规格 §4.4 | 由第 5 节取代：支持上传 `.txt`、`.md`、`.docx`；仍然不做 RAG、向量库或网盘同步（第一版） |
| 输入框支持图片选择、图片附件和多模态处理 | v11 §6.3 UI-C | 本版不做：UI-C 只支持 D6 列出的文档类型；图片和多模态放到上线后的资料库扩展 |
| v11 第 11–12 节的施工顺序、批次和状态 | v11 §11–12 | 由第 7 节取代；任务编号保留（第 7.5 节有对照） |
| `V3-GOLD` 排在飞书之后 | v11 §11 | 改名 `FUSION`，不依赖飞书 |
| "保留 Stripe 是兼容能力，不是 Waffo 失败时自动启用直收；未来直收或另一 MoR 启用另获相应批准" | v11 §9.2 | 由第 2.1 节第 12 项（D17）取代：Stripe 是已批准的备用渠道，由管理员在后台手动切换新购买使用的渠道；仍然不做自动切换。原因：Owner 确认正式环境没有真实用户（第 2.1 节第 8 项），不存在需要兼容的历史订单。v11 §9.2 其余要求（历史订单按原渠道处理、未知付款不跨渠道重试、不把一家的 ID 填进另一家字段等）继续有效 |
| 正式报告从确认快照确定性汇编，不调用模型、不花积分 | v11 §6.1；[V3 标准 Skill 规格](tasks/V3-standard-skills.md)中的"确定性报告"；本文第 3.2 节第 6 条原文 | 由第 2.1 节第 22 项取代：所有带步骤的 Skill 都由模型根据全部信息写完整报告、收积分，结构由各自 Skill 的模板规定（Owner 2026-09-30 原话："所有带步骤的 Skill，报告都改由模型写、都收积分"，[#545 评论](https://github.com/Crnobog9527/GraylumAI_vercel/pull/545#issuecomment-5912946236)）；V3 标准 Skill 规格本身在实现 REPORT-GEN 时再同步；用户手动修改和"定稿"的规则不变 |
| 用户明确禁止联网时不得搜索 | v10.2 §5；v11 §6.2；架构规格 §7.3 | 由第 2.1 节第 21 项取代：是否联网由联网路由按需要判断，不受用户设置限制；发生搜索时在对话里展示；后台总开关保留（Owner 2026-09-30） |
| 对标账号研究暂不实施；真实研究入口保持关闭（2026-09-14 Owner 决定） | v11 §8 | 由第 3.7 节取代：对标研究在上线前实施（RESEARCH-TOOLS）；"不许无限监控或规避平台限制"继续有效 |
| 研究调用使用独立的 agentkey-credit 报价和计费 | BILL2 技术契约第 1 节（`research/store.ts`、迁移 0071） | 由第 3.7 节取代：各家计价换算成美元成本，登记在 BILL2 运行单上 |
| 只按确切金额结算、缺少成本挂起；或缺少金额/用量就直接扣保底积分 | BILL2 技术契约第 3.1 节；本文旧第 11 项、D14、D16 | 2026-10-01 由第 32–34 项取代：官方用量、自家点数和按次官方标价均先换美元，再按有效倍数累计；固定保底积分不再作为绕过美元成本的收费路径。BILL-UNIT 落实单位与倍数，RESEARCH-TOOLS 同步线路定价；缺少可用美元计价依据时不得凭旧保底积分规则收费 |
| 发布时"不能假设现网无用户"，以及为此要求的"schema 与旧 runtime 向后兼容""兼容回退" | v11 §13.3 | 由第 9.3 节取代：Owner 已确认正式环境没有真实用户（第 2.1 节第 8 项） |
| 为保护现网数据而设的发布要求：迁移必须向后兼容旧代码（只扩不缩、"旧代码 × 新库"测试）、按"先库后代码"分步切换、旧数据迁移、针对旧数据的回滚 | v10.1 §9、§10 | 由第 9.3 节取代；v10.1 §9、§10 中其余要求（密钥和配置逐项核对、Stripe 正式配置核对、定时任务、验证码开关顺序、冒烟、同日对账、立即关站条件等）继续有效 |
| 实际扣费按供应商返回的真实费用（`usage.cost`），缓存节省和供应商折扣反映在用户扣费里 | 本文第 26 项"实际扣取真实费用"、第 35 项"实际扣费按 OpenRouter 返回的真实费用"；#553、#547 第七版之前的写法 | 由第 2.1 节第 41 项取代（2026-10-03）：按标价计算的名义费用收费，缓存和折扣不让给用户；缺 token 时按 `min(c, U)` 兜底；分时价取最高时段。真实费用照常记账对账；余额封顶、L 门槛、平台承担超额不变 |
| 正式环境供应商涨价后要重新批准报价；D3"只有涨价后重新批准报价需要 Owner 批准"对正式环境的适用 | MODEL-PRICING-SYNC 方案（`docs/launch/MODEL_PRICING_SYNC_PLAN.md`）第 3.6 节、D3 | 由第 2.1 节第 40 项取代（2026-10-02）：正式环境价格全自动，涨价按新价冻结、不需重新批准；锁价只用于 staging 测试窗口。方案文件本身未改 |
| 报告单独设输出上限（#547 D1，report=24576）；输出被截断不算成功、不自动续写 | REPORT-GEN #547 方案 | 方向由第 2.1 节第 44 项取代（2026-10-03）：全站统一输出上限，D1 不再单独批准。首版不自动续写、写满时提示已截断，自动续写在第二版（第 44 项后续决定）；#547 按第 54 项处理 |
| 自由对话默认不自动整理、用户打开右侧面板或点"整理一下"才运行（D9）；视频线"口播稿 → 分镜 → 剪辑建议"的固定按钮流程 | 本文第 3.4 节、D9；v11 §5 视频链路 | 方向由第 2.1 节第 45 项取代（2026-10-03）：选题和创作改为对话驱动，自由对话由用户手动触发"整理纪要"。**方案待写**（CONTENT-CONVERSATION-DRIVEN，排在 #604 之后，和 #588 方向 B 合并设计）；方案定稿和实施之前，现有流程和 D9 的现行行为照常 |

**边用边扣冲突条款清查（2026-10-01）**：按[总控要求](https://github.com/Crnobog9527/GraylumAI_vercel/pull/559#issuecomment-5926136494)搜索整个 `docs/**`（含 `docs/launch/**`、测试记录和归档），以下作为取代表的补充。文件路径均相对仓库根目录，行号固定于本轮清查基准 `8122e21a6b6fd876b7f4303846de31c647a54c79`，不是随本文增行移动的行号。

以下冲突条款统一按第 2.1 节第 26–27、32–34 项解释（2026-10-01 更新）：冻结额取估算上限与可用余额较小值，实际扣取本次收费基准与冻结额较小值（收费基准为按标价计算的名义费用，2026-10-03 第 41 项；真实费用照常记账对账）；可用余额低于按模型/用途配置的 L 才暂停，充值后断点继续，余额不得为负。正常余额封顶不触发 budget_conflict，只有超过估算上界本身才异常停新调用；平台承担超额、不补扣，保留对账。所有成本先换美元，q=100、默认 m=6（2026-10-03 第 50 项，此前为 3），逐调用冻结有效倍数后累计只进位一次。未知结果保留本次冻结额，原身份恢复、不重发、不盲退款。不废止无冲突的安全约束，不宣称新计费已实现。

| 被取代或须限定适用范围的条款 | 文件与基准行号 | 负责同步的实施任务及保留边界 |
| --- | --- | --- |
| q=1000 测试口径、m 约 3 倍未定、所有模型统一倍数 | 本文旧第 11 项、D16、第 7.6 节；#553 原方案算例 | **BILL-UNIT #565**：2026-10-01 已定 q=100、默认 m=3（2026-10-03 默认改为 6，第 50 项），按模型/线路配置有效倍数；旧冻结执行保留原值；配置调整另获 Owner 批准（第 32–34 项） |
| 第三方点数直接当 Graylum 积分、固定保底积分不乘倍数 | 本文旧第 11 项、第 3.7 节、D14/D16；RESEARCH-TOOLS 的相应计价说明 | **BILL-UNIT / RESEARCH-TOOLS**：所有成本先换美元，按逐调用倍数累计后只进位一次；保留官方标价与用量证据，不伪造缺失成本（第 32–34 项） |
| 不够冻结完整上界即暂停；任何超冻结额均停止 run | 本文旧第 26–27 项、第 4.4 节与 BILL-PAYG 原方案 | **BILL-PAYG #553**：余额封顶冻结与结算；余额低于 L 才暂停；正常封顶和估算上界异常分开，后者才触发异常停新调用（第 26–27 项） |
| run 唯一 pre_deduct、run/pre_deduct 一对一、prepareRun 一次预留、每 run 一次原子预留 | `docs/launch/tasks/V3-BILL-2-provider-authoritative-billing.md`：43、47、53、83 | **BILL-PAYG** 同步契约的数据关联、准入和逐次冻结；保留请求幂等、权限、预算上限与不得负余额，不按调用数提前冻结整单费用 |
| 平台承担单次超额需人工授权、不增设自动亏损政策 | `docs/launch/tasks/V3-BILL-2-provider-authoritative-billing.md`：89；137 中人工核销授权不得再用于阻塞本类已确定超额 | **BILL-PAYG** 同步；本类超额执行第 27 项。137 中未知结果的人工补偿、退款和无证据核销授权边界仍有效，不把 unknown 当成已确定超额 |
| prepare 预留 R 后等整单终结才收费的流水示例、run/pre_deduct 唯一关系及整单一次结算验收 | `docs/launch/tasks/V3-BILL-2-provider-authoritative-billing.md`：99–102、112–118、127–128、163 | **BILL-PAYG** 同步逐次冻结/结算、累计取整和相应验收；保留原子性、唯一消费、来源恢复、锁序、终态互斥和不可重复记账，不以逐次结算提前终结尚未封闭的 run |
| 整组只预扣一次、按全部轮数上限冻结；要求整组预扣覆盖所有轮次的验收 | `docs/launch/tasks/FUSION.md`：21–23、35、60、65–66；15、17、25–35 中按该整组预扣解释的估算用语 | **FUSION-REVIEW** 同步规格及验收，FUSION-COMPARE 复用；总预估仅展示，每次供应商调用按余额封顶冻结，Fusion 多模型单次上界由 FUSION-REVIEW 定义、定义前不放行。保留一个运行单、汇总取整、各调用状态和部分结算，不把 Fusion 内部模型拆成重复收费 |
| 选中报价最大 upperUsd × maxCalls 预扣，实际发送内容估算留给 RUNTIME-PROD ④ | `docs/launch/tasks/MENTOR-BUDGET.md`：94–95 | **BILL-PAYG** 承接 ④ 并同步当前适用说明；保留原交付记录、call claim、调用时限和实际成本证据，不因该历史交付继续整单预扣 |
| 整理和 Fusion 不能多次预扣；整理尚未派发即在消息运行单中预留，之后退多余预扣 | `docs/launch/tasks/AGENT-CORE.md`：57、61–62、70 | **BILL-PAYG** 同步计费边界，**AGENT-CORE / AC-2** 同步整理实施与验收：每次实际调用前冻结；保留同一消息/整组运行单、整理次数限制、冲突不重复派发及累计取整，不把调用次数槽位当成提前冻结资金 |
| 每一步按“次数上限 × 该查询类型最高单价”预扣 | `docs/launch/tasks/RESEARCH-TOOLS.md`：52 | **RESEARCH-TOOLS** 在 BILL-PAYG 钱路上同步为逐次调用冻结；保留调用次数限制、D14 官方标价与用量换算美元、确认失败平台承担和未知恢复；旧保底积分直扣规则由 BILL-UNIT 取代，不用步数上限提前冻结整步费用 |
| 运行单只有汇总预留字段、最终 RPC 才统一计算预扣差额，未表达逐次冻结与结算 | `docs/launch/tasks/V3-OPC-growth-agent-architecture.md`：468–482、513–526 | **BILL-PAYG** 同步架构说明；保留作用域、Session、精确成本、一个运行单最终累计取整、事务和未知恢复。旧“最终结算”不能阻止每次调用后结算 |
| 多调用只做一次最终原子结算的概述 | `docs/launch/plan-core.md`：84 | **BILL-PAYG** 同步概述；保留唯一余额/流水、持久调用身份和收据，不解释为必须等整单结束才扣费 |
| 调用前预扣一次，多个调用汇总后只结算一次的项目地图 | `docs/PROJECT_MAP_FOR_OWNER.md`：37 | **BILL-PAYG** 同步为逐次冻结/结算；保留运行单汇总和最终只取整一次 |
| actual > reserved 作为用户新增消费追加扣减，及依赖该规则的超用验收/旧修订说明 | `docs/launch/Graylum_Master_Plan_v10.1.md`：101、239、248、251、365、498、520、543、623、650、656 | **BILL-PAYG** 同步有效规格的取代提示和新验收；新调用超额由平台承担，不从用户当期或其他来源补扣。历史数值案例不回写成新模式证据，少用返还、锁序、退款来源保护继续有效 |
| 旧 BILL2 测试契约的一 run 一预扣、整单终结结算和对应 Runtime/整理验证 | `docs/testing/v3-bill2-authoritative-billing.md`：21–23、27、38–40；`docs/testing/v3-runtime.md`：38；`docs/testing/v3-opc-workbench.md`：67 | **BILL-PAYG** 在实施时补新契约验证与版本适用说明；保留这些历史测试结果，不拿旧版本一次预扣的 PASS 作为 PAYG 验收 |
| 归档示例在实耗高于预扣时补扣差额 | `docs/archive/2026-01/movetonew/GraylumAI_分阶段重构执行计划.md`：420–434 | **BILL-PAYG** 负责在实施交接中明确旧示例不适用于新调用；归档原文保留，不恢复为实施契约 |

RUNTIME-PROD ④ 和 REPORT-GEN 在本基准没有独立同名任务文件；仓库内入口是本文原第 134、498 行，已明确取代统一预扣及报告固定上界方案，分别由 **BILL-PAYG**、**REPORT-GEN** 同步实施方案。本文原第 289–290 行的 Fusion 估算用语同样只按第 4.4 节的本次上界/总预估展示解释，由 **FUSION-REVIEW** 同步，不能重新启用整组冻结。

搜索命中的一般“预扣/预留”并不全部冲突：`docs/ARCHITECTURE.md` 第 117–126、158 行及 `docs/ADMIN_SETTINGS_EFFECT_MATRIX.md` 第 36–41、68–79 行描述旧聊天实现，由 **BILL-PAYG** 在实施文档中标明适用版本，不作为新模式规则；v10.2 第 116–139 行、v11 第 303–311 行及 DATA-ERASURE 中原身份/未知恢复和人工退款授权仍有效。输出 token 预留、测试预算、迁移槽位、生产操作授权、历史 SQL/字段名也不属于整单冻结或超额补扣承诺；本次不改历史证据或扩大授权。

除上表外，v11 和更早文档中不冲突的要求继续有效（第 9 节）。

<a id="agent"></a>
## 3. Agent 对话与定位分析（新交互）

### 3.1 原则：Agent 当司机，应用当仪表盘

- **Skill 决定"怎么做"**：有哪些步骤、每步要了解什么、怎么提问、什么时候追问、什么时候算完成、最后的报告长什么样，全部来自 Agent 加载的 Skill。
- **Agent 决定"现在做什么"**：按 Skill 的方法主动引导、提问、追问，判断一步是否完成，提示用户进入下一步。
- **应用只做仪表盘和保险箱**：显示进度和整理结果，保存数据和版本，检查权限，记账，断线恢复。页面和数据库不写死某个 Skill 的步骤、问题、题号或下一步按钮。

这与 v11 第 3.4 节、架构规格第 0.4 节（Owner 2026-09-22 批准）一致。之前的实现偏离了这个原则，本节纠正。

### 3.2 用户看到的体验

1. 进入"定位分析"，Agent 先开口，边生成边显示；开场只用文字提问，不出提问卡，之后只在第 2.1 节第 20 项允许的情况下出卡。
2. **提问卡**由 Agent 调用"提问"工具生成，是辅助工具，不是每轮都出（第 2.1 节第 20 项）：一个问题、几个选项，方案类卡片标出"推荐"项，末尾固定一个"其他"入口（点击后到输入框自己补充）。信息不够时 Agent 在正文里追问，不出卡；导师开场不出卡。用户点选项或直接打字都可以，卡片不锁住输入框。每次只问一个主要问题。
3. 用户随时可以自由聊天。Agent 回应后会自然地把话题带回当前步骤还缺的信息。
4. Agent 判断这一步的信息已经足够时（依据 Skill 声明的完成条件），发一张**本步小结卡**："没问题，进入下一步 / 我要补充修改"。用户确认的这一刻，就是这一步的**用户确认版本**，也是整个流程里唯一需要点确认的地方。确认后 Agent 自动开始下一步。
   - 用户用文字表达明确同意（例如"没问题，下一步"）和点击效果相同；含糊的回答（"嗯""差不多吧"）不算确认，Agent 再问一次。
   - 模型没有用提问卡、直接用文字提问时，按普通回复显示，流程照常。Agent 迟迟不提示完成时，用户可以点"这一步先到这里"，让 Agent 生成本步小结卡。
   - 已确认的步骤可以随时回头修改：修改后该步回到"草稿"并重新确认，依赖它的后续步骤标为"需要复核"，内容保留，由 Agent 逐步带用户复核。
5. 右侧**数据沉淀区**：
   - 顶部是进度条，步骤名来自 Skill；
   - 下面是按 Skill 模板实时整理的笔记，每轮回复后几秒内更新，标明"草稿 / 已确认"；
   - 用户可以直接修改；手动改过的内容，整理模型不能覆盖。
6. 所有步骤确认后，由模型根据全部信息（各步已确认的内容和对话中收集的资料）写完整的**定位分析报告**，结构由 Skill 的报告模板规定（当前定位 Skill 为 13 个部分、正文最多 12000 字），显示在右侧（第 2.1 节第 22 项，取代原来的确定性汇编；由 REPORT-GEN 实现）。报告生成收积分，扣费逻辑和正常对话一样，不做运行前预告（第 2.1 节第 25 项）。用户可以直接修改：修改记为报告的手动版本，不改动各步的确认内容，页面标明"报告已手动修改"。点"定稿"后成为正式版本。
7. 报告 v1 出来后，Agent 询问用户是否开启**多模型评审**（评审团）把报告打磨得更专业（第 4 节；按会员权限开放，默认免费会员不能用；先告知预计积分）。评审稿和原稿并排对比，用户采用后才成为新的正式版本。之后接第一周选题（v11 第 5 节规则不变）。
8. 选择"我已有定位"的用户进入同一个工作区：Agent 先请用户粘贴或描述已有定位，整理进各步笔记，再逐步核对确认，不从头重新提问。

### 3.3 必须保证的结果

- 长对话按第 31 项保留原始记录、每轮携带当前草稿/状态和查询能力，不做整段摘要压缩；定位查询工具待 AC-2 / LIB-DOCS，不作为 #497 已交付能力。
- 页面和数据库不写死某个 Skill 的步骤和问题；整理结果仍按 Skill 声明的信息字段保存，下游（周选题、内容、资料库、Agent 读资料）读取定位的方式不变。确认的单位是一步，保存的单位仍是字段。
- 评审修订稿被采用时，列出它和各步已确认字段的差异；用户确认后同步更新字段并生成新的确认版本；不确认时修订稿只作为报告文本保存，页面标明"选题和写作仍使用原定位"。
- 整理不会让确认按钮永远卡住：整理失败、超时或被放弃时，用户可以重试（先告知预计积分，失败不收费）或按当前笔记确认。
- 回复速度由后台为每个模型配置的思考强度控制（MODEL-REASONING）；PR #446 是在那之前的止血。
- 每条消息一个计费运行单，整理模型的调用记在同一个运行单里，在账单明细里单独列出。
- 新交互先做可行性验证（AC-0）：用真实模型实测首字时间和提问工具的成功率，不达标先换模型或调整方案。

实现机制、未定案的设计选择和实施时的必测项见 [AGENT-CORE 实施说明](tasks/AGENT-CORE.md)。其中"后台整理的并发机制"在规划审查中被连续多轮提出高优先级问题，已冻结，改在实施方案阶段重新选型。

### 3.4 适用范围

同一个工作区、同一套提问卡和右侧整理，用于定位分析、其他 Skill（例如写口播稿）和自由对话，区别只在于加载哪个 Skill、用哪个整理模板。带步骤的 Skill 每轮自动整理；自由对话默认不自动整理，用户打开右侧面板或点"整理一下"时才运行，运行前显示预计积分（D9）。新工作区接管自由对话后，个人中心、后台、技能广场模块详情和旧工作台里指向旧 `/chat` 的链接改指新工作区，为下线旧链路做准备。周选题、内容交付、视频链路的规则沿用 v11 第 5 节。（2026-10-03：自由对话整理方式和定位之后的选题、创作流程，方向已由第 2.1 节第 45 项改为对话驱动，方案待写；实施前本段照常适用。）

### 3.5 验收（在 staging 用真实模型实测）

- 新手从进入到定稿完整走通，全程不需要逐题点确认，每一步只确认一次；
- 连续发送 20 次，至少 18 次在 3 秒内出现第一个字（需要先读参考文件的轮次单独记录，不计入）；整理结果至少 18 次在回复结束后 10 秒内出现；
- 用户在第一步顺口说出的后面步骤的信息，会被整理进对应栏目，Agent 之后不再重复问；
- 跑题时 Agent 简短回应后拉回；用户说"不确定"或说不清时，Agent 在正文里给分析和举例，并同时说明"这是猜测、由你决定"以及为什么需要猜（目前信息还不够做专业判断），猜测不做成卡片，也不会被当成答案；
- 刷新、断网、重新登录后，对话、提问卡、笔记和确认状态都能恢复；计费没有重复；
- 另选一个 Skill 或自由对话，右侧整理同样工作，格式跟随模板。

### 3.6 PR #446 的处理结论（"writer 交接"会话的工作）

- **它修的是什么**：导师模型 `qwen/qwen3.8-27b` 的请求里没带推理设置，OpenRouter 对它默认按最高档思考（`xhigh`），真实测试里 120 秒全在"思考"，正文一个字都没出。PR #446 增加"模型 → 请求策略"映射，给这个模型的导师对话关闭思考，并把设置冻结进请求字节，重放和计费保持一致。
- **是不是旧框架**：只有触发范围是旧的（只对"定位导师"生效）。根因在 Runtime 层，新交互照样用同一个 Runtime 和同一类模型，不修的话重做界面也一样慢。旧的成果生成链路（`services/artifacts/generation.ts`）早就在按模型关闭或降低思考，说明这是本项目一贯需要的能力。
- **结论：保留，单独合并，不并进大改版。** 它改动小（+174/-15），测试齐全，Codex 审查无问题。并进大改版会拖慢一个明确的性能修复，还会让高风险的请求字节改动混进大 PR，更难审。新交互只需把触发条件从"导师"扩大为"所有交互式 Agent 调用"，是小改动。
- **合并前还要做**：
  1. 接手这个 PR（原会话已停，按 AGENTS 第 3 节做 writer 交接）；
  2. 基于最新 staging 更新：已实测它和新的代码大小检查冲突（`reasoningPolicy.ts` 有 1 行、`runner.ts` 多出 1 行超过 160 字符），需要折行；
  3. 重跑测试，Codex 重新审查新提交；
  4. Owner 回复"同意合并"（高风险：改变发给供应商的请求字节）；
  5. 合并后需要 Owner 另外授权一次 staging 真实调用，确认 DeepInfra 确实按设置关闭了思考、首字延迟达标。
- **之后**：由 MODEL-REASONING 的后台配置取代 #446 里写死的"模型 → 思考强度"对照表（#446 的档位列表也缺少 `max`）。

<a id="research"></a>
### 3.7 第三方搜索和对标研究

Owner 2026-09-27 决定（D13–D15）：Agent 自带的联网搜索不够用，接入第三方搜索 API，分**普通搜索**和**社交媒体数据**两类，同时支持中国和海外的社交平台。搜索对接做成统一接口层，方便更换供应商。实现机制和必测项见 [实施说明](tasks/RESEARCH-TOOLS.md)。

**供应商（Owner 2026-09-28 根据 RESEARCH-0 的结果确定，修订 D13）**：

| 用途 | 供应商 | 以后申请的企业定制授权（等网站用户使用量大了再申请） |
| --- | --- | --- |
| 社交媒体数据（中国和海外平台） | TikHub | 允许用于面向用户的商业产品、允许把结果展示和保存给用户；需要时购买更高的每秒请求数 |
| 网页搜索 | Parallel | 允许把结果保存在该用户自己的对话记录和资料库里（公开条款禁止把一个用户的结果缓存后给其他用户，这一条现在就要遵守） |
| 网页抓取 | Firecrawl | 商用授权，以及允许把抓取结果展示给用户、保存在用户的资料库里（公开条款写着"未经明确授权不得用于商业目的"，也没有写能否提供给最终用户） |

- **准入要求**（Owner 2026-09-28）：供应商条款必须写明允许商用、允许二次分发给用户使用，并且能提高并发。上表三家的公开条款都没有完全写明第一条（Firecrawl 的公开条款还写着"未经明确授权不得用于商业目的"）。**Owner 2026-09-28 决定：暂不申请，等网站用户使用量大了，再由 Owner 向供应商申请企业定制授权；在此之前按各家公开条款使用。这是 Owner 知情后接受的风险。** 以后增加或更换供应商，也按这两条准入。
- **不采用**：monid（中间商，公开条款只允许内部使用且禁止系统性取数）、TinyFish（许可只限内部业务用途）、AIsa（中国平台数据是转售 TikHub）、SocialCrawl（价格高，并发不能提高）、Tavily（Owner 决定不用，网页搜索改用 Parallel）、AgentKey（价格高）。
- **2026-10-04 更新（第 2.1 节第 52 项）**：Owner 定 Bright Data 作为备用渠道，主要覆盖海外平台，Facebook 公开数据由它抓取；接入前先小额实测（预算另批）、核对条款原文，密钥由 Owner 自己配置。接入前下面这条仍然适用。
- **每类目前只有一家，没有备用线路**：确认失败时如实告诉用户取不到数据，并请用户粘贴链接或跳过（D15），不切换到别家。规则表的"首选 / 备用"结构保留，以后增加供应商时使用。
- 测试结论、各接口的可用情况和成本字段见 [实施说明](tasks/RESEARCH-TOOLS.md) 的"RESEARCH-0 结论"。

**必须保证的结果（RESEARCH-TOOLS）**

- Agent 只决定查什么，宿主按规则表决定用哪家。规则表按"平台 + 查询类型"配置首选和备用，管理员在后台可改。
- 后台维护"已验证可用的平台"清单；清单外的平台如实告知暂不支持。
- 统一返回格式；供应商没给的字段标为"未提供"，不填零。
- 各家计价先统一换算成美元成本，接入 BILL2，按第 11、32–34 项 `ceil(q × Σ(U_i × m_i))` 计算应收，实际扣费遵守第 26 项封顶。官方用量或自家点数按“用量 × 冻结的美元单价”换算；按次且公开单价的线路按“1 次 × 冻结官方单价”换算。TikHub 按官方标价计成本，阶梯折扣归平台。2026-10-01 新决定取代旧保底积分直接扣除规则；既无金额/用量又无可用美元单价依据时，不沿用固定积分附加费冒充成本，由 BILL-UNIT / RESEARCH-TOOLS 补齐计价依据后开放。
- **确认失败**（确认没发出，或供应商明确返回失败）时，如实告诉用户取不到数据（D15），**不调用第二家供应商**；失败那次如果供应商仍收费，成本由平台承担。只有以后经 Owner 批准增加了备用线路，才在确认失败时自动换备用。首选已发出但超时、断线等**结果未知**时不换、不重发，按 BILL2 的结果未知流程处理。
- 取数结果连同来源、取数时间存为证据，进入资料库，可以刷新，并接入账号注销。
- 自由对话和带步骤的 Skill 都能用；是否联网由联网路由按需要判断（Owner 2026-09-30 决定，第 2.1 节第 21 项）；发生搜索时在对话里向用户展示。

**搜索费用（D14）**：由用户承担，计入用户积分；供应商费用统一先换美元，旧保底积分直扣规则由第 32–34 项取代。搜索前不显示预计消耗，因为调用次数事先无法准确估算。保留三项兜底：每一步有调用次数上限；用户在消费记录里能看到每次搜索的实际扣费；搜索发生时在对话里展示。服务条款和价格页写明"联网搜索和数据查询会消耗积分"（条款文字由 Owner 按第 2.1 节第 9 项生成）。可用余额低于该模型/用途的启动门槛 L 时明确提示充值，不静默失败。

**对标研究流程（定位相关的必须保证的结果，D15）**

- 对标分析必须基于真实取到的数据，禁止编造。
- 用户已有对标链接：直接取该账号资料和最近 20–30 条作品数据。
- 用户没有对标：Agent 生成 3–5 个关键词并请用户确认；按关键词搜近期作品，从作品反推作者；由代码筛选并分为头部参考、同量级可模仿、近期起号快三类，剔除 30 天未更新的账号；展示 8–12 个候选让用户挑 3–5 个；再对选中的账号取数。
- 播放中位数、互动率、更新频率等指标由代码计算，模型只负责解读。
- 对标表格里的数字栏目只能由取数结果填入，模型没有写入权限。
- 取不到数据时必须明说，并请用户粘贴链接或跳过；不允许给示例账号。
- RESEARCH-TOOLS 完成前，对标这一步按"取不到数据就明说"处理。

<a id="fusion"></a>
## 4. Fusion 多模型

v10.2 的"Gold 多模型智囊团"（任务 `V3-GOLD`）由本节取代，任务改名 `FUSION`（`V3-GOLD` 作为旧别名保留）。对外名称 2026-10-04 改为"多模型专家评审团"，上线默认只给 Gold（第 2.1 节第 51 项）；产品内部和任务名仍叫 Fusion。v10.2 第 6 节的五条底线继续有效：各模型拿到同一份 Skill 和资料；外部写操作不随模型数量重复执行；全部真实成本入账；部分失败如实展示；真实小额对账通过前不开放生产收费。

### 4.1 两种用法

| | 评审模式 | 对比模式 |
| --- | --- | --- |
| 什么时候用 | 后台总开关打开时：定位分析报告 v1 出来后，由用户选择是否开启（以后也可以用于其他成果） | 后台总开关打开时：自由对话或使用任何 Skill 时，用户在输入框手动打开 |
| 用哪些模型 | **管理员指定** 3–8 个评审模型和负责汇总修订的模型，用户不能选 | 每次打开**默认勾选**管理员在后台设定的一组模型；用户可以取消勾选、自己搭配，范围是管理员允许的模型列表；最少勾选数由后台参数决定（不低于 2），最多不超过 D3（第 2.1 节第 50 项） |
| 模型加载什么 | 全部使用同一份**评审提示词**（来自管理员上传的评审 Skill，由宿主固定写进请求内容）和同一份冻结快照（报告和前面对话里已收集的资料）；不联网 | 全部加载用户当前使用的 Skill（没有 Skill 时就是同一份提示词）和同样的资料 |
| 用户得到什么 | 各模型的修改意见清单（位置、问题、建议），加一份多轮评审达成共识（或到后台设定的轮数上限）后的最终版报告和简短修改说明（评审模型不写修订稿，每一轮的修订稿只由汇总模型写一份）；和原稿并排对比，用户采用后才成为新的正式版本 | 各模型的结果并排显示，用户对比后选一个继续，其余保留可查看 |
| 谁能用 | 管理员按会员等级设置；上线默认只给 Gold，免费和 Pro 不能用（第 2.1 节第 51 项） | 同左，两种模式分别设置 |

每次运行前告知**预计最多消耗多少积分**，用户同意后才开始。没有权限的会员看到升级提示，不会因此卡住、完成不了定位。

### 4.2 必须保证的结果

- 评审模式不联网（Owner 2026-09-30 决定）：需要的网上资料都在前面的对话里由 Agent 调用搜索工具收集好，交给评审的是已经收集完资料的上下文，这样扣费也不会变复杂。
- 评审模式用 OpenRouter 的 Fusion 服务端工具，放在专用 workspace 里并禁用联网工具；实测不通过，评审模式保持关闭上线，不做自研（第 4.3 节）。对比模式由 Graylum 自己并行调用。
- **后台总开关**（Owner 2026-09-30 决定）：评审模式和对比模式各有一个总开关，各自独立。
  - 开关关闭时，页面不显示对应入口；服务端在创建执行时拒绝新请求，直接调用接口也一样被拒，检查的位置和会员权限检查相同。开关比会员权限优先：关闭时哪个会员等级都不能用。
  - 已经开始的运行按创建时冻结的设置照常完成并结算。
  - 评审模式关闭时，定位分析以报告 v1 结束，不显示评审入口，也不显示报错。
  - 默认关闭：评审模式要等开工前实测通过、验收后才由管理员打开；对比模式验收后打开。
- 各模型拿到同一份 Skill、同一份资料和同一个请求；对比模式第一版不开放任何工具，需要的资料由宿主事先读好。
- 对比模式的每列独立显示、独立流式；手机上用标签切换各模型的结果。
- 用户选中的对比结果才接回主对话；主对话在此期间已有新内容时，不打乱对话顺序，改为让用户把选中的回答引用到新消息里。
- 评审修订稿按第 3.3 节的规则同步到定位字段，采用后才生效。
- 评审输出形式：评审模型只输出修改意见清单（位置、问题、建议），不重写全文；每份意见的长度上限由后台设置，随运行单冻结；评审模型和分析模型不写修订稿；每一轮的修订稿只由汇总模型（外层模型或汇总模型）写一份。这个上限对应 Fusion 的 `max_completion_tokens` 或同等参数，由宿主显式设定；按官方文档，这个参数是每一次内部评审团和分析模型调用的最大输出，包含思考 token，所以它同时作用于分析模型，预扣估算里的"分析模型回答长度上限"在首选方案下取同一个值。
- Skill 加资料放不进某个模型的上下文时，在扣费前拒绝该模型并说明原因。评审模式另外：准入时按每一步最坏情况的合计上下文检查，口径和预扣估算一致（每次读取的输入上限 + 回答长度上限）：覆盖评审团、分析模型、外层请求的两次读取和汇总修订。装不下就先按规则调低上限，仍装不下就在预扣前拒绝，并告诉用户原因。

整组 Fusion 是一次收费操作，只有一个计费运行单、只取整一次（保留 BILL2 契约）。实现机制和必测项见 [FUSION 实施说明](tasks/FUSION.md)。

### 4.3 评审模式：专用 workspace 里的 OpenRouter Fusion，实测不通过就保持关闭（Owner 2026-09-30 决定）

**方案：OpenRouter Fusion，放在专用 workspace 里，禁用联网**
- 给评审单独开一个 OpenRouter workspace，配单独的密钥，在该 workspace 的 Server Tools 设置里禁用 `web_search` 和 `web_fetch`。这个 workspace 只给评审用；普通对话的联网走 TikHub / Parallel / Firecrawl（第 3.7 节），不受影响。
- 建 workspace 和密钥属于供应商配置变更，由总控请 Owner 批准，Owner 亲自操作，Agent 不接触密钥。
- Graylum 的 Agent 调用 Fusion 服务端工具（`openrouter:fusion`）：评审团模型（`analysis_models`，3–8 个）和分析模型由管理员在后台指定；评审提示词由评审 Skill 规定、宿主固定写进请求内容，不依赖系统提示是否会传给评审团模型；`max_tool_calls` 设成最小值 1。
- Fusion 每次调用只评一轮（官方文档：同一次请求里第二次调用会被拒绝）。多轮评审、合并修改清单、判断是否达成共识、轮数上限和最终修订稿，都由 Graylum 自己控制。

**开工前必须实测**（真实调用的额度要 Owner 批准）：
1. 禁用联网是否生效。官方文档（2026-09-30 读取）写明评审团和分析模型固定开启 `web_search` 和 `web_fetch`，`max_tool_calls` 范围是 1–16、不能设 0；workspace 的 Server Tools 页面只写了搜索引擎列表、允许和屏蔽的域名、锁定和默认两种模式，没写能不能把整个工具设为禁用；Fusion 内部调用是否遵守 workspace 设置、禁用后是照常评审还是报错，文档也都没写。**通过条件**：评审团和分析模型都没有发生搜索和抓取（用量里 `web_search_requests` 为 0，也没有抓取记录），整次调用正常返回，评审质量可用。
2. 官方文档没有写系统提示是否传给评审团模型，也没写评审团和分析模型拿到的是完整对话还是外层模型写的工具调用参数。评审提示词写进请求内容，实测每个模型是否都按它评审；并实测评审团和分析模型是否拿到完整报告原文（而不是外层模型改写或缩写后的内容），拿不到就算实测不通过，评审模式保持关闭。
3. 计费：确认响应里有没有每个模型的成本，还是只有一个总成本。只有总成本时，按 BILL2 技术契约的 Fusion 覆盖组规则（契约第 71 行）用官方总成本一次结算，不自行拆分（这里指成本记账；向用户的收费基准按 BILL-PAYG 名义费用规则，细则随 FUSION-REVIEW 方案定）。
4. 数据：确认 `data_collection: deny` 等数据设置是否作用到评审团和分析模型（第 7 节 RUNTIME-PROD ⑦）。
5. 现有适配器拒绝 `openrouter/` 开头的元模型，并要求返回的模型等于请求的模型；服务端工具不是元模型，实施时核对这两条检查和工具调用的兼容性。

**实测不通过：评审模式保持关闭上线，不做自研**
评审模式的后台总开关保持关闭，定位分析以报告 v1 结束。以后要不要自研，再由 Owner 决定。原来设计的自研方案作为参考留在 [FUSION 实施说明](tasks/FUSION.md)，不在上线范围。

对比模式由 Graylum 自己做：对比要每个模型各自流式显示、由用户自选模型，Fusion 多出来的分析步骤对对比没有用。

### 4.4 计费（对用户的保证）

- 运行前显示一个总预估（"最多消耗 X 积分"），结束后显示一个总扣费和每个模型的成本明细。评审模式如果 OpenRouter 只返回整次 Fusion 调用的总成本，就只显示每轮的总成本，不自行拆分到各模型。总预估只用于展示，不代表一次性冻结。
- 积分冻结按 BILL-PAYG（第 2.1 节第 26–27 项）逐次进行：每次供应商调用前按估算上界与可用余额较小值冻结，结算扣取本次收费基准与冻结额较小值；可用余额低于 L 时停在两次调用之间，充值后继续，超额由平台承担。收费基准按 BILL-PAYG 名义费用规则（第 2.1 节第 41 项），Fusion 的具体收费细则随 FUSION-REVIEW 方案定。Fusion 一次调用里包含多个模型时，这一次的上界由 FUSION-REVIEW 定义，定义之前 Fusion 不放行（[总控修订记录](https://github.com/Crnobog9527/GraylumAI_vercel/pull/559#issuecomment-5925344654)）。
- 每个模型的调用有三种结局（D2）：
  - **成功返回**：计入应收成本。
  - **确认失败**（供应商明确报错，且能证明没有交付可用结果）：不向用户收费；供应商仍然收费时，这笔成本照常入账，由平台承担。
  - **结果未知**（超时、断线、查不到回执）：不当作失败，这个模型对应的冻结额继续保留，核对出结果后再处理；其余模型不受影响，先结算并退回多余冻结额；页面显示"某模型的结果待核对，暂时冻结 N 积分"。
- 对比模式：只有"成功返回"的调用计入应收成本，按上面三种结局逐个模型判断。
- 评审模式（OpenRouter Fusion）：每一次 Fusion 调用作为一个整体结算，不按内部各模型判断（OpenRouter 可能只返回整次调用的总成本，按 BILL2 技术契约第 71 行的 Fusion 覆盖组规则处理）：整体成功，计入应收（收费基准按 BILL-PAYG 名义费用规则，第 2.1 节第 41 项；Fusion 的具体收费细则随 FUSION-REVIEW 方案定）；整体确认失败，不向用户收费，供应商仍然收费时由平台承担；结果未知，保留这一次调用的冻结额，核实后再处理。（仅在 Owner 决定自研时适用：评审模式改用自研方案时，和对比模式一样按上面三种结局逐个模型判断。）评审意见和修订稿记在同一次收费操作里，修订稿失败时只收评审意见的费用。
- 实施时同步修改 BILL2 技术契约里"Fusion 部分模型失败"一行，并写明"全部真实成本入账"指全部记录在案，不等于全部向用户收费。
- 管理员可以给 Fusion 设单次最高预算。

### 4.5 后台配置

| 配置 | 放在哪里 |
| --- | --- |
| 对比模式可选的模型列表、单次最多几个模型 | 新增"Fusion 设置"（后台设置页的一组或独立页面），模型从现有模型目录里选 |
| 评审模式的评审团模型、分析模型（OpenRouter 的 `model` 参数）、汇总模型、评审 Skill | 同上；所选模型随运行单冻结，不使用外层模型的默认值。评审 Skill 通过现有 Skill 上传发布，再在这里选定（仿照首页分析模块的设置方式） |
| 哪些会员等级能用哪种模式 | 后台设置页"会员权限"标签，给会员计划增加开关（第 7 节 ENTITLEMENTS）。服务端在创建执行时检查（仿照现有导出权限的检查方式），不能只在前端隐藏 |
| 评审轮数上限 | Fusion 设置；随运行单冻结 |
| 每份评审意见的长度上限 | Fusion 设置；随运行单冻结（对应 Fusion 的 `max_completion_tokens` 或同等参数，同时限制分析模型，包含思考 token） |
| 评审模式总开关、对比模式总开关 | Fusion 设置（沿用现有系统设置，不新建表）；默认关闭，规则见第 4.2 节 |
| 单次最高预算 | Fusion 设置 |

### 4.6 前置依赖

- 正式环境可以真实调用模型（RUNTIME-PROD）；
- 新对话工作区（第 3 节）；对比模式的多模型勾选器由 FUSION-COMPARE 自己提供，不依赖也不重建通用模型选择器；UI-MODEL 只在输入框里提供 Auto 占位（第 2.1 节第 50 项）；
- 会员权限配置（ENTITLEMENTS）；
- 真实小额对账通过后，才对外收费。

<a id="library"></a>
## 5. 个人资料库与语料库（我的文风）

### 5.1 现状（2026-09-27 核实）

- 资料库现在只能查看和编辑已采用的选题、稿件和定位版本，**不能上传文件**，删除只是隐藏。
- 唯一的上传接口只服务工单图片（jpeg/png/gif/webp，5 MB，私有存储桶 `ticket-attachments`），没有文件登记表。头像上传的前端在等接口返回 `url`，接口实际只返回 `path`，头像上传很可能是坏的（第 8 节）。
- 输入框的"添加资料"只在浏览器里读取 64 KB 以内的纯文本文件，把文字贴进消息，不保存文件。
- 没有 Word 文字提取，没有向量或全文检索，没有按套餐的存储额度。
- **没有账号注销，也无法真正删除用户数据**：定位、内容、执行等记录为了账务和版本安全不可修改，也没有级联删除（第 8 节）。
- 已确认偏好（`agent_confirmed_preferences`：用户确认、带版本、可停用，单条上限 1000 字符）已经存在，但只接在 agentSlice 链路上（它在下线清单里），新 Runtime 没有读取。

### 5.2 对 ChatGPT "Voice Memory" 方案的复评

| 该方案的主张 | 结论 |
| --- | --- |
| 一个资料库，同一份资料有不同用途（文风样本 / 事实参考） | **保留**。不另建第二个资料库 |
| 文风画像 + 少量本人原文样例，不每次读全部文库 | **保留**，这是核心 |
| 事实和文风分开：旧文章只学"怎么写"，不当作事实依据 | **保留**，在给模型的上下文里分开标注即可 |
| 每次生成冻结所用画像版本，重放时不重新检索 | **保留**；用下面的简化做法后自然成立 |
| 删除要传播到画像 | **保留**，简化为"来源变了就停用旧画像" |
| 第一版不依赖 Google Drive，不为 File Search 改 Runtime | **保留** |
| 需要向量检索、可替换的检索服务抽象层、"代表样本索引" | **删掉**。学文风不需要按主题检索：样例在生成画像时就选好、存进画像里，每次写作带同样几段，成本固定，重放一致 |
| 全局文风 + 各平台文风分层 | **简化**：第一版只有一份画像，里面可以写"在 X 上更短、更直接"这类平台差异，不做分层结构 |
| 从初稿到终稿的修改差异自动学习 | **推迟**。第一版让用户直接编辑和确认画像；修改差异的数据先记录下来（第 6 节），以后再用 |
| 盲测 A/B | **改为上线前的内部质量检查**：挑几位真实用户，同一题材对比开 / 关文风的稿子，看是否更像本人、修改量是否下降。不做成产品功能 |

### 5.3 第一版做什么

**资料库新增"我的文档"，其中一类是"语料库（我写的）"**

- **上传**：第一版支持 `.txt`、`.md`、`.docx`，单个文件不超过 10 MB（D6）；PDF 等其他格式上线后再加。浏览器直接上传到私有存储，不经过网站服务器中转。提取文字有上限，超出时如实提示；提取出的文字计入额度。
- **类型字段**：文件记录带"类型"（文档 / 图片 / 音频 / 视频），现在只放行文档，以后 Agent 生成的图片、音频也登记到同一个资料库。
- **标记用途**：上传时选"我本人写的（可用于学习文风）"或"参考资料"。只有本人写的才进语料库，参考资料不会被当成文风来源。
- **删除**：用户可以真正删除自己上传的文件。删除时清除文档和系统从它派生的数据（分段、目录、文风画像、执行快照），这些内容不能再通过重放或晚到的结果泄露；已显示在对话里的回答和用户保存的成果不自动删除，用户可以单独删除；账号注销时全部清除（D7）。
- **额度**：按会员等级只限制总存储空间（免费 50 MB、Pro 500 MB、Gold 2 GB，后台可改，见 D4），不限制文件数量。另设一个系统级的文件数量保护上限，只用于防滥用，设得足够高，不作为会员权益展示，具体数值实施时确定。会员降级、到期或退款后，已有文件超过新额度时不自动删除，可以查看、下载和删除，不能再上传；文风画像继续可用。

**文风画像**

1. 用户在语料库里点"学习我的文风"（或 Agent 提议、用户同意），系统先告知预计积分。
2. 整理模型读取语料（总量有上限，超出时优先使用用户标记为"最像我"的篇目），生成一份文风画像：语气、句子长短、开头方式、观点强弱、常用表达、不喜欢的表达、各平台差异，并附 2–3 段最能代表本人的原文片段。
3. 用户查看、修改、确认后生效。画像带版本，支持真正删除；生成期间语料有变化时，新画像不生效，标为"需要更新"。保存位置由实施时选择（见实施说明），不另建记忆系统。
4. 写作类 Skill（后台为 Skill 勾选"使用用户文风"）执行时，如果用户开着"使用我的文风"，带上当前画像版本（约 2–3 千 token 以内）；重放使用原版本，新请求使用新版本；删除来源后不能通过重放读到已删除的内容。
5. 语料有增删时，旧画像标记为"需要更新"，由用户决定何时重新生成，不自动花积分。

**大文档怎么读**：引用或附件不会把全文一次塞进请求，Agent 先看目录，再分段读取，每次和每轮都有上限。

实现机制和必测项见 [LIB-DOCS 与 VOICE 实施说明](tasks/LIBRARY-VOICE.md)。

**检索（以后再做）**：第一版 Agent 通过用户的明确引用（输入框 @ 引用，UI-B）和上面的分段读取使用资料库文档，不做自动检索。文档多到需要检索时，先用 Postgres 自带的全文检索，再视需要在同一个 Supabase 数据库里加 pgvector，都不引入第二家存储供应商。

### 5.4 成本核算（2026-09-27 官方价格）

下表是**超出免费或套餐包含额度之后**，每多存 1 GB 的边际价格，不是前 1 GB 的实际账单：

| 方案 | 价格 | 超出包含额度后，每多 1 GB 一个月 |
| --- | --- | --- |
| Supabase Storage（Pro 含 100 GB） | 超出部分 $0.0213 / GB / 月 | 约 $0.02 |
| Supabase 数据库磁盘（Pro 含 8 GB） | 超出部分 $0.125 / GB / 月 | 约 $0.13 |
| OpenAI Vector Store（File Search） | $0.10 / GB / 天（1 GB 免费），检索调用另收 $2.50 / 千次 | 约 $3.00，另加检索费 |
| OpenAI 向量化（text-embedding-3-small） | $0.02 / 百万 token | 一次性，很便宜 |

来源：supabase.com/pricing、developers.openai.com/api/docs/pricing。

- 存原文和提取出的文字几乎不花钱：一个用户上传 50 篇、每篇 3000 字，总共不到 1 MB。
- 小规模时，Supabase Pro 已包含 100 GB 存储和 8 GB 数据库，存文档的额外费用基本为 0；OpenAI Vector Store 只有 1 GB 免费。
- 用户多了、超出包含额度以后，OpenAI Vector Store 每多 1 GB 的月费是 Supabase Storage 的 100 多倍，还按检索次数收费，并把数据锁在一家供应商。**不采用。**
- 真正的成本在模型调用：生成文风画像（每个用户偶尔一次）；写作时多带约 2–3 千 token 的文风说明。这两项都走现有 BILL2，按 BILL-PAYG 名义费用规则计费（第 2.1 节第 41 项）。

### 5.5 需要重点验证的敏感部分

新数据表和存储桶策略（数据库迁移）、Word 文字提取库（新增依赖，解析不可信文件）、Runtime 读取文风画像（涉及上下文与计费）。这些 PR 按 AGENTS.md 第 4 节验证、审查后由 AI 合入 staging；上正式环境按第 1 节请 Owner 批准。

<a id="learning"></a>
## 6. Skill 的数据基础与未来"自我进化"

### 6.1 评估结论

- **"用平台表现数据自动训练 Skill"在当前规模下不可靠，不做。** 一条内容的播放、涨粉受账号基础、热点、封面、发布时间、制作质量、平台推荐等大量因素影响；用户也常常不按建议执行，发布前还会再改内容。用户少的时候样本极小，只会学到噪声和"幸存者偏差"。定位这种抽象、周期长的策略，几乎不可能从结果归因回 Skill。
- **真正可靠、第一天就能用的是"过程信号"**：用户在 Graylum 里对 AI 输出的直接反应。这些信号和 Skill 输出在同一次会话里直接对应，不需要归因：
  - 采用或不采用哪条建议，提问卡选了哪个选项；
  - AI 原稿和用户最终保存稿之间改了多少、改了什么；
  - 用户要求重写、放弃、点"没用"，以及给出的理由。
- **Skill 由人来改进，数据只负责把问题找出来。** 管理员定期查看"被大改、被放弃、被差评"的真实案例，修改 Skill，用固定的测试案例检查新版本，然后发布。这条路径复用现有的不可变版本发布和"老草稿固定用旧版本"机制，风险低。
- **归因引擎、各种"置信度"打分、自动生成候选 Skill**：没有足够数据支撑，属于过度工程。推迟到真有大量已发布内容和平台数据之后再评估，很可能根本不值得做。
- **实现难度**：打基础（6.3 的第一行）是小到中等的工作量，大部分记录已经存在；全自动进化难度很高，科学上也站不住，不作为目标。

### 6.2 现在已经记录了什么

| 已有记录 | 位置 |
| --- | --- |
| Skill 的不可变版本、包哈希和文件 | `skill_revisions`、`skill_packages`（迁移 0062、0064） |
| 每次模型执行冻结的完整上下文（Skill 身份、模型、实际指令、输入）、结果、供应商原始响应和每次调用的成本 | `runtime_executions`、`bill2_runs`、`bill2_calls`、`bill2_receipts`（0105、0106） |
| 定位：执行 → 候选 → 确认 → 正式版本 | `opc_result_links`、`artifact_confirmations`、`artifact_versions`（0066、0107） |
| 内容：执行 → 内容版本；AI 原稿和手动修改都是不可变版本链，能算出改了多少 | `opc_content_versions`（0117、0123、0128） |
| 已发布标记（用户自报的状态、日期、版本号） | `opc_publication_ui`（0124） |

### 6.3 要补的缺口

| 阶段 | 要做的事 |
| --- | --- |
| **上线前必须做**（随 AGENT-CORE 和 DATA-ERASURE） | ① 选题采用记录关联到提出这些选题的执行（现在断了），保存"AI 原提议 vs 用户采用的文字"；② 整理出的信息保留来源（用户原话还是 AI 提议）和对应执行；③ 给缺少时间戳的记录补上创建时间；④ 记录"重写 / 放弃"事件（"有用 / 没用"按钮等封闭内测后再加）；⑤ 用户数据使用同意（由 AC-5 实现勾选、撤回、按同意状态过滤、进入案例视图前在服务端去除身份信息和验收）：允许 Graylum 团队查看去除身份信息后的使用记录，用来人工改进产品；默认不参与，用户主动勾选才参与。现在不会用来训练模型，也不会自动修改 Skill。以后改进机制设计出来、用途发生变化时，必须重新征求用户同意；用户撤回同意后，尚未用于改进的记录从案例视图中移除；⑥ 用户数据删除办法（第 8 节 DATA-ERASURE） |
| 有真实用户后（LEARN-1） | 管理员"问题案例"视图（按 Skill 版本汇总采用率、修改量、差评理由）；从真实案例整理固定测试集，新 Skill 版本发布前先跑测试集对比 |
| 有社媒数据后（LEARN-2，依赖 SOCIAL-SYNC） | 发布记录关联到具体内容版本和平台作品链接，定期记录指标；只对标题、封面这类能在平台上做 A/B 的变量做因果比较 |
| 可能不值得做 | 自动改写 Skill、定位层面的结果归因、跨用户"全局自动学习"、每条案例的多种置信度打分 |

**个人层面的"越用越懂你"不用等全局学习**：文风画像（第 5 节）和用户确认过的偏好只用这个用户自己的数据，改善他自己的结果，现在就可以做。跨用户的改进只使用用户同意、去除身份信息、来源可追溯的数据，而且只进入管理员的人工改进流程，不自动修改生产中的 Skill。

<a id="construction"></a>
## 7. 施工顺序

### 7.0 进度

本文不再手写进度。每个任务现在处于哪个阶段、对应哪些 PR，以只读脚本 `scripts/plan-progress.mjs` 的生成结果为准：

```bash
node scripts/plan-progress.mjs --ref origin/staging
```

脚本读取第 7.1 节任务表和第 7.7 节历史 PR 对照，再用 `gh` 只读取 GitHub 上的 PR，在终端输出 Markdown 表，并在系统临时目录生成 JSON 和一个静态页面（不写进仓库）。规则：

- **任务名**：第 7.1 节"任务"列里的大写名字就是规范任务名（例如 `BILL-PAYG`、`PAY-COMMON`）。一格里写了多个名字的，`→` 表示后者依赖前者，`、` 表示并列；括号里的中文只是说明。
- **PR 标题必须带任务名**，原样大写写在标题里，或写成约定式标题的范围，例如 `feat(BILL-PAYG): PR-B2 等待整理（high）`、`docs(PAYWALL): 付费墙实施方案（high，仅方案）`。一个 PR 涉及多个任务时都写上，或在正文单独一行写 `任务：A、B`。只做方案的 PR 在标题里写"仅方案"，例如 `（high，仅方案）`。规划本身的同步 PR 用 `docs(plan)`，不算任何任务。
- **阶段怎么推导**：标注列写了"完成"的是**已完成**；写了"关闭：原因"的是**已关闭**（不计入完成比例）；写了"阻塞：原因"的是**被阻塞**；否则有在途或已合并的实施 PR 的是**实施中**，只有方案 PR（标题含"仅方案"，或 `docs` 类型且含"方案"，或第 7.7 节标了"方案"）的是**方案中**；还没有 PR、依赖列里的任务没完成（或依赖的 PR 没合并）的自动算**被阻塞**，其余是**未开始**。
- **标注列只记三种事**：任务验收完成时写一次"完成"（不含的部分写在冒号后面，例如"完成：不含正式环境配置"）；任务放弃时写"关闭：原因"；被 Owner 决定或外部事项卡住时写"阻塞：原因"，事项解除时删掉。一格里有多个任务时可以写"任务名：完成"只标其中一个。其余进度（在途、已合并、部分完成）一律不写进本文。
- **计划外工作**：v12 整理日期之后合并进 staging、标题和正文都没有对上任务名的 PR，脚本单独列出。

方案在途或定稿都不等于功能生效、合并或配置变更授权。迁移在 staging 上的应用记录、产品验收结论和 Owner 批准仍以各 PR 上的总控记录为准；脚本只看 PR，不连接数据库，不代表产品验收通过。2026-10-05 之前各轮手写的进度表保留在本文的 Git 历史里（最后一版见 staging `470cef9a`）。

**已知问题和风险**（2026-10-03 记录，随对应任务的方案更新，不是进度）：
- deepseek 的旧 JSON 问题保留为历史证据；导师用途当前计划选 Sonnet（第 38 项，后台配置），#582 盲评中 Sonnet、Gemini 都没达到出卡门槛，出卡分寸问题由右侧整理 B2 处理。
- 首字时间：服务端从点击到首字约 3.4 秒，亚洲浏览器另加约 3 秒网络；3 秒目标（第 3.5 节）未达到，还需要从美国位置实测。
- 模型写完整报告（12000 字）受 staging Hobby 函数最长 300 秒、冻结载荷 262144 字节、单次回复接收 139264 字节（#564）等限制；统一输出上限和自动续写由 CHAT-NATIVE-OUTPUT（#604）解决，REPORT-GEN 排在其续写 C2 之后。方案中的容量估算不代表真实模型验证已通过。
- 提示缓存（#591）只缓存固定前缀；用户停顿超过 5 分钟后缓存过期，下一轮会再付一次写入费（#591 审计 5956865557）。对话历史缓存由 PROMPT-CACHE-HISTORY 处理（第 43 项），1 小时缓存这次不做。
- 正式环境价格全自动（第 40 项）时，平台没有事先固定的美元损失上限（#553 第 2 节已写明这一风险，单次仍受 `max_price` 和单次上界约束）。
- 计划外完成的安全和清理工作见第 8.5 节。
- 0159 及以后迁移的 staging 结构指纹快照刷新尚未做（最后一次刷新是 #592，对应 0158），由总控统一安排一个 PR，归 DB-BASELINE。

### 7.1 阶段和任务

"风险"一列标出任务是否涉及依赖、权限、数据库、计费、金额、CI 等敏感部分（**高**）或不涉及（**普通**），用来提醒按 AGENTS.md 第 4 节做对应的验证。staging 上的合并都由 AI 验证、审查后完成，不再按风险级别请 Owner 批准；上正式环境和放宽检查按 AGENTS.md 第 1 节由 Owner 批准（2026-10-05 规则精简）。实施中碰到敏感部分时，尽量拆成单独的 PR，方便审查。

"规模"和"预计 PR 数"是实施前的粗略估计，用来判断大概要做多少事、你要批准多少次，实施方案里会细化。每个任务开工前必读的章节列在对应的实施说明里。

"任务"列是规范任务名，PR 标题按第 7.0 节的格式带上它；"标注"列只写"完成""关闭：原因"或"阻塞：原因"，其余进度由脚本生成（第 7.0 节）。

| 阶段 | 任务 | 内容 | 依赖 | 风险 | 规模 / 预计 PR | 标注 |
| --- | --- | --- | --- | --- | --- | --- |
| **0 马上** | P0-1 | 完成 PR #446（第 3.6 节） | — | 高 | 小 / 1 | 完成：不含 N1a 出口标准（导师出字速度在 staging 实测达标，第 7.4 节），该标准尚未达到 |
| | P0-2 | 关闭无人使用但仍可调用的旧付费接口 `ai.sendMessage`；删除会扣积分的临时脚本 `run_diag.ts`（扣后退回但不检查退回是否成功）和 `test_rpc.ts`（扣了不退） | — | 高 | 小 / 1 | 完成：不含 N1a 出口标准（导师出字速度在 staging 实测达标，第 7.4 节），该标准尚未达到 |
| | P0-3 | 本规划（v12）审查合并 | — | 高 | 小 / 1 | 完成 |
| | P0-4 | 修复 #443 遗留的过期测试（它还在等已删除的"业务名称"弹窗） | — | 普通 | 小 / 1 | 完成：不含 N1a 出口标准（导师出字速度在 staging 实测达标，第 7.4 节），该标准尚未达到 |
| | CI-TRUST-1 | 集成测试进 CI（计费、恢复等关键路径） | — | 高 | 中 / 1–2 | 完成：不含 N1a 出口标准（导师出字速度在 staging 实测达标，第 7.4 节），该标准尚未达到 |
| **1 核心体验重做** | AGENT-CORE | AC-0 可行性验证；AC-1 提问卡和纯文本流式；AC-2 后台整理、Skill 模板、右侧数据沉淀区；AC-3 每步确认、模型根据全部信息写完整报告（第 2.1 节第 22 项；分工：REPORT-GEN 负责报告生成能力，AC-3 负责每步确认、定稿，并把报告接进流程）、定稿、承接第一周选题；AC-4 通用工作区和旧入口改指；AC-5 数据基础补缺，包括 D5 数据使用同意（勾选、撤回、按同意状态过滤记录）。见 [实施说明](tasks/AGENT-CORE.md) | P0-1；AC-2 另外依赖 CI-TRUST-1 和 DATA-ERASURE 的删除规则设计；AC-3 的报告部分依赖 REPORT-GEN | 高 | 大 / 12–16 | — |
| | AGENT-CORE-UI | 从 AGENT-CORE 拆出的纯前端部分：提问卡和本步小结卡的显示、流式文字显示、右侧面板和进度条的布局、旧入口链接改指。只改前端，沿用现有接口；需要改接口、工具、数据库或计费的部分一律留在 AGENT-CORE | 与对应的 AGENT-CORE 子任务配合 | 普通 | 中 / 3–4 | — |
| | MENTOR-BUDGET | Owner 2026-09-30 立项（第 2.1 节第 23 项）：导师每一轮的输入和输出预算按用途（交互对话、整理、报告）在后台配置，准入时冻结，不再写死在代码里；放宽我们代码里的单次模型调用超时和每次请求的时间预算（staging 上限受 Vercel Hobby 单次 300 秒约束，正式运营升级 Pro（2026-10-01，第 28 项））；评估提示缓存（已由第 35 项定为上线必做 PROMPT-CACHE）。实施：服务端 [#542](https://github.com/Crnobog9527/GraylumAI_vercel/pull/542)、后台页 [#551](https://github.com/Crnobog9527/GraylumAI_vercel/pull/551)、输出容量 #564；交付参数为交互/报告 8192、单次接收 139264 bytes；报告入口由 REPORT-GEN 启用 | —（Owner 批准先于 #497） | 高 | 中 / 1–2 | 完成 |
| | REPORT-GEN | Owner 2026-09-30 立项：所有步骤确认后，由模型根据全部信息写完整报告，结构由各自 Skill 的模板规定（第 2.1 节第 22 项）。先实现定位 Skill（当前 13 个部分、正文最多 12000 字），报告生成能力按通用方式设计，其他带步骤的 Skill 复用同一套能力；无步骤的 Skill 不受影响。收费按第 2.1 节第 25 项：扣费逻辑和正常对话一样，不做运行前预告。方案见 [#547](https://github.com/Crnobog9527/GraylumAI_vercel/pull/547)（第七版，按 BILL-PAYG 第七版重写）：建立在 BILL-PAYG 上，一次调用一冻结、一结算；可用余额低于 L 时停在调用之间，充值后继续。原 D1（报告单独输出上限 24576）和"截断不自动续写"已由第 44 项的全站统一上限和自动续写取代，按 CHAT-NATIVE-OUTPUT（#604）的定稿小同步。FUSION-REVIEW 评审的就是这份报告 | MENTOR-BUDGET、BILL-PAYG、CHAT-NATIVE-OUTPUT 续写 C2；顺序为 BILL-PAYG PR-A → PR-B → C2 → 本任务 | 高 | 待实施方案细化 | — |
| | STG-MENTOR-MODEL | 2026-10-01，[方案 #561](https://github.com/Crnobog9527/GraylumAI_vercel/pull/561)：staging 实测 Gemini 3.8 Flash、Claude Sonnet 5.5。**已关闭（2026-10-02，Owner 决定，第 38 项）**：导师模型定为 Sonnet（依据 #582 盲评），#561 不合并关闭，分支保留，不再发真实调用。以后要做导师模型评测，从最新 staging 另开任务 | — | 高 | — | 关闭：Owner 2026-10-02 决定导师模型定为 Sonnet，#561 不合并（第 38 项） |
| | MENTOR-PROMPT-V2 | 2026-10-02：#497 验收中发现整理器照抄用户原话、写错字段。整理器输入加入已有值和导师回复（#584），宿主出卡规则与双模型重测（#582）。由 #584、#582 实施；出卡分寸问题并入 CONVERSATION-DRIVEN-CAPTURE B2（第 38 项） | #497 | 高 | 小 / 2 | 完成 |
| | CONVERSATION-DRIVEN-CAPTURE | 右侧信息跟着对话走（方向 B，第 48 项；[方案 #588](https://github.com/Crnobog9527/GraylumAI_vercel/pull/588)）：整理不再按固定题目顺序，由实际聊到的内容填写，最后收齐 Skill 要求的信息。分两步：B1 数据库与写入（#593，迁移 0159）；B2 同时处理 #582 的出卡分寸问题、激活 PROMPT-CACHE-HISTORY H1 | #497（AC1-4）；B2 在 B1 之后 | 高 | 中 / 2（B1、B2） | — |
| | CHAT-NATIVE-OUTPUT | 方向（Owner 2026-10-03，第 44 项；[方案 #604](https://github.com/Crnobog9527/GraylumAI_vercel/pull/604)）：全站对话统一流式、统一输出上限（报告也用）、写到上限或快超时自动续写、用户无感，不按 Skill 区分。#604 第一版拆为 C0（前端统一走流式）、C1（统一上限）、C2（自动续写，复用 PAYG PR-B 的等待和继续）。方案 #604 的首版范围以 Owner 决定为准（不做自动续写，正式环境单次上限 32768、staging 8192）。**实施前必须先解决**（[#604 总控记录](https://github.com/Crnobog9527/GraylumAI_vercel/pull/604#issuecomment-5971006438)，解决前相关实施 PR 不得合并）：C0 ① 可以出卡片的导师回合（非开场回合）目前完全缓冲，C0 要定义这类回合怎样流式输出权威文本并加入 C0 测试；② 调用进行中重连拿不到当前快照，C0 增量传输要持久化或共享当前投影，或者把承诺缩小为只重放终态并写明中间状态怎样显示；C2 ③ 结果已提交、还没送达时点停止，C2 要定义终态结果的交接规则并仍遵守 stopAt | C0/C1 在 #594 之后；C2 在 BILL-PAYG PR-B 之后（REPORT-GEN 排在 C2 之后） | 高 | 待实施方案细化 | — |
| | CONTENT-CONVERSATION-DRIVEN | 方向（Owner 2026-10-03，第 45 项）：定位之后的选题和创作改为自由对话加轻引导、按意图加载平台技能；一窗口一选题（提醒式）；自由对话由用户手动"整理纪要"；是否存进资料库由用户决定。将取代视频线固定按钮流程和 D9"自由对话不自动整理"（第 2.2 节）；方案定稿和实施前现有流程照常。方案见 #621。**实施前必须先解决**（[#621 总控记录](https://github.com/Crnobog9527/GraylumAI_vercel/pull/621#issuecomment-5971687700)，解决前相关实施 PR 不得合并）：① P1-A 必须把已保存的正文从常驻材料投影（`runtime_scope_material`）中移出，或停止注入这个投影，然后才能依赖按需注入；② 暴露"保存正文/简报"按钮之前，定义并迁移 `opc_content_versions.kind` 和 `opc_guard_content_kind` 缺少的类型，并同步 API schema；③ 提议是否已消耗按最新一次已准入的对话执行判断，不论这次执行成功、失败或停止，可用性只在展示提议时检查 | 排在 #604 定稿之后，和 CONVERSATION-DRIVEN-CAPTURE（#588 方向 B）合并设计 | 待方案定 | 待实施方案细化 | — |
| | RESEARCH-0 | 由 #457、#465、#466 实施（2026-09-28）。第三方搜索供应商对比测试：同一组查询测每一家，记录平台覆盖、新鲜度、字段完整度、速度、单次成本、失败率、是否返回每次调用的官方成本；Owner 据此确定了供应商（第 3.7 节、D13，结论见 [实施说明](tasks/RESEARCH-TOOLS.md)） | —（可与 AC-0 同期） | 高（真实付费调用） | 小 / 0–1 | 完成 |
| | CI-TRUST | 其余部分：ESLint 覆盖 TS/TSX；网站单测统一入口；API 独立类型检查；删除 `@repo/ui` 空壳和未接入的 ESLint 配置包；依赖升级机器人改发到 staging 并清理指向 `main` 的旧升级 PR（第 8.4 节第 1–3 项）。由 #511、#512、#523 实施 | — | 高 | 中 / 3–4 | 完成 |
| | DEBT-QUICK | 第 8.3 节第 2 项的快速清理（只含普通改动）；关闭已解决和已废弃的问题单（第 8.4 节第 4–5 项）。由 #482、#483、#558、#607（诊断结论修正、删除旧 `services/promptCache.ts`）、#634（删除 `costCalculator.ts`、`streamHandler.ts`）实施；第 8.4 节第 4–5 项的问题单已核对为关闭状态 | — | 普通 | 小 | 完成 |
| **2 上线基础** | RUNTIME-PROD | 正式环境真实调用模型：① 模型报价的审批和开放机制；② BILL-UNIT 落实 q=100、默认倍数（2026-10-03 起为 m=6，第 50 项；BILL-UNIT 交付时为 3）与按模型/线路倍数，美元统一成本、调用时冻结（第 11、32–34 项、D16）；③ 后台界面；④ 由 BILL-PAYG 实现逐次冻结与实际结算（第 2.1 节第 26–27 项），可用余额低于按模型/用途配置的 L 时在两步之间暂停、充值续接、余额不为负，超出本次冻结额由平台承担；收费模型准入及超额对账见同两项；普通调用和 Fusion 共用基础机制，Fusion 多模型上界定义前不放行，评审运行前预告保持不变；⑤ 止损：每个用户每日上限、全站每日成本上限和告警、供应商余额告警、一键停止新调用的开关；⑥ 理清 `provider` 字段语义；⑦ 数据不用于训练由服务端强制：正式环境所有模型调用都发送 OpenRouter 的 `data_collection: deny`，只批准支持该设置的供应商线路，准入时拒绝不满足的线路；是否额外要求零数据保留（`zdr`）在实施时核对供应商能力后决定（DATA-ERASURE E10 已决定非 ZDR 线路可以启用；第 ⑦ 项本身是否保留待 Owner 确认，见第 10 节"待确认事项"）。验收包括一次有上限的真实小额对账。分工：② 由 BILL-UNIT 交付；① 的价格读取与准入检查由 MODEL-PRICING-SYNC 交付，正式环境按第 40 项价格全自动；④ 由 BILL-PAYG 交付（收费基准为名义费用，第 41 项）；⑤ 中"一键停止新调用的开关"由 RATE-LIMIT 交付，其余止损项在本任务做 | ④ 按 BILL-PAYG 行提前实施；其余项依赖 AGENT-CORE 稳定 | 高 | 大 / 4–6 | — |
| | BILL-UNIT | （[#565](https://github.com/Crnobog9527/GraylumAI_vercel/pull/565)，迁移 0157）：所有成本统一美元，q=100、交付时默认 m=3（2026-10-03 默认改为 6，第 50 项；修改配置须另获 Owner 批准）；后台按模型设置倍数，未设用默认值；逐调用冻结有效倍数后合计只进位一次（第 32–34 项）。staging 已按 Owner 批准改为 q=100、m=3（第 39 项）。套餐价格和每月积分已由第 51 项定下；开户赠送 500 积分和积分包三档已先定（第 51 项，记录 S、T），邀请奖励按 m=6 复核 | #497、#550 | 高 | 中 / 1 | 完成 |
| | PROMPT-CACHE | **上线必做**（Owner 2026-10-01，第 35 项）。方案 #572、实施 #591（冻结前缀与请求缓存）。付费验收 PASS（2026-10-02，v3 测试窗口，八轮 Sonnet 导师对话：缓存标记被 OpenRouter 和 Anthropic 接受，命中轮比不用缓存省 35–56%，八轮合计省 30.8%；执行记录 [5956489014](https://github.com/Crnobog9527/GraylumAI_vercel/pull/591#issuecomment-5956489014)、[5956779675](https://github.com/Crnobog9527/GraylumAI_vercel/pull/591#issuecomment-5956779675)，总控审计 [5956577683](https://github.com/Crnobog9527/GraylumAI_vercel/pull/591#issuecomment-5956577683)、[5956865557](https://github.com/Crnobog9527/GraylumAI_vercel/pull/591#issuecomment-5956865557)）。逐轮扣费当时因财务页问题 BLOCKED，之后由总控在数据库里只读逐轮核对：每个运行单只有一笔消费，等于 ceil(实际费用 × 100 × 3)（[#565 总控审计](https://github.com/Crnobog9527/GraylumAI_vercel/pull/565#issuecomment-5957431423)）。用户收费按名义费用（第 41 项），缓存节省不让给用户 | #497 | 高（Runtime 调用路径和费用上界） | 中 / 2 | 完成 |
| | PROMPT-CACHE-HISTORY | 对话历史也加缓存（Owner 2026-10-03，第 43 项；方案 #601）：H1 机制 #610（默认不激活），由 CONVERSATION-DRIVEN-CAPTURE B2 激活；这次不做 1 小时缓存；付费实测复用 B2 评测和 B2+F1 验证的预算 | #594；激活随 CONVERSATION-DRIVEN-CAPTURE B2 | 高 | 小 / 1（激活随 B2） | — |
| | MODEL-PRICING-SYNC | 模型价格从 OpenRouter 自动读取（第 40 项）。方案 #578（D1–D7 按推荐）、价格快照与后台只读显示 #580、准入价格检查与自动重读 #581、C1+C2 联合候选 #597（#596 关闭）。正式环境价格全自动；staging 测试窗口继续锁价 | BILL-UNIT | 高 | 中 / 4 | 完成 |
| | RUNTIME-VIEW-PERF | 长会话权限检查优化。（#586，迁移 0158）。以后替换 `runtime_admit`、`runtime_view`、`runtime_session_items` 的迁移，源 MD5 要以 0158 之后的值为准 | #497 | 高 | 小 / 1 | 完成 |
| | BILL-PAYG | 2026-10-01（第 26–27 项），[方案 #553](https://github.com/Crnobog9527/GraylumAI_vercel/pull/553) **第七版定稿**（2026-10-02，第 41 项）：余额封顶冻结和结算，收费基准为按标价计算的名义费用（缺 token 时按 `min(c, U)` 兜底、分时价取最高）；低于按模型/用途配置的 L 才暂停并提示充值，保留断点、不得负余额、不重复收费；正常余额封顶由平台承担，只有超出估算上界才异常停新调用；L 首版不随价格自动更新；价格变动和平台承担只提醒、不拦截。复用 BILL2 和 BILL-UNIT 的逐调用倍数，最终只进位一次。由 Codex 按 PR-A → PR-B 实施 | #611（#598 实施）；PR-B 在 #610（PROMPT-CACHE-HISTORY H1）之后（之后接 CHAT-NATIVE-OUTPUT C2 → REPORT-GEN） | 高 | 大（PR-A → PR-B 分段） | 完成：不含约 100 条历史的长对话验收（Owner 2026-10-06 同意，上线后用真实数据跟踪） |
| | DB-BASELINE | 按 Owner 2026-09-29 选择的 C3 方案 B（第 9.3 节）：① 先修完 S1（#498）查出的 staging 权限漂移；引入 `0000` 前，先完成与现有追加式迁移账本、检查器及 CI 的兼容过渡，涉及的治理变更单独按受保护流程先行交付，不得在新增基线的同一 PR 中修改检查器来放行自身；② 从 staging 导出只有结构的建库脚本作为核对来源，整理成只补缺失前置对象的 `0000` 基线，补上 16 张核心表及缺失的相关函数、触发器、扩展、存储桶、授权；已有迁移负责创建的 75 张表及其对象仍由原文件创建，不把完整 staging 结构直接放进 `0000`；③ 用空库按顺序跑完全部迁移，并跑完整测试；④ 退役 `db:push`，更新 `docs/ENGINEERING.md` 和 `docs/runbooks/STAGING_REPRODUCIBILITY.md`，这部分属于治理变更，按受保护流程走。必须在 V3-M3 / REL-1 之前完成。每次结构变更后的 staging 指纹刷新 PR 也归在本任务 | S1 的权限修复 | 高 | 待实施方案细化 | — |
| | MODERATION | **暂缓**（Owner 2026-10-01，第 19 项）：不再是封闭内测前提；正式功能何时实现，公开上线前再请 Owner 决定。此前不接 OpenAI Moderation、不需密钥、不核实价格。MODERATION-HOOK 的输入/输出检查点随 RATE-LIMIT 接线（#594），默认放行；拦截后的不收费、独立终止状态与日志以后正式实现时补齐 | 正式功能待 Owner 决定 | 高 | 待定 | 阻塞：Owner 2026-10-01 决定暂缓（第 19 项），公开上线前再请 Owner 决定 |
| | MODEL-REASONING | ① 添加或编辑模型时，从 OpenRouter 公开模型目录读取该模型支持的思考档位、默认档位、能否关闭，保存快照并可"重新读取"；② 管理员按模型和用途（交互对话、整理、评审、写作）选择思考强度，选项只来自该模型支持的档位，外加"关闭"（允许时）和"用供应商默认"；③ 保存前检查所选供应商线路支持这个参数；④ 准入时把所选档位冻结进执行记录，重放用原值；⑤ 档位和回复长度上限联动校验；⑥ "试一次"按钮，用固定短问题真实调用一次，显示首字时间和是否有正文，费用由平台承担。取代 PR #446 里写死的对照表。**按 Owner 2026-09-28 决定，MODEL-REASONING 提前到 N1b，在 AC1-4 之前完成**（Owner 要求模型在后台随时切换、不绑在代码里）。由 #480、#494、#495 实施 | P0-1（和 RUNTIME-PROD 由同一个 writer 完成，同一个后台模型页） | 高 | 中 / 2–3 | 完成 |
| | ENTITLEMENTS | 会员权限配置：Fusion 两种模式的开关和上限、资料库总存储空间；服务端检查（系统级文件数量保护上限不属于会员权益，不在这里配置）。PR-1 #540（迁移 0153）、PR-2 后台会员权限与 Fusion 数量设置界面 #609（Owner 2026-10-03 批准合并）；合并后的 staging 冒烟由总控另行安排。2026-10-04 起 Fusion 默认只给 Gold、新增定位档案上限（第 51 项），由 PAYWALL 实施，本任务不重开 | —（和 PAY-COMMON 由同一条钱路线先后完成） | 高 | 中 / 2 | 完成 |
| | RESEARCH-TOOLS | 第三方搜索统一接口层和对标研究（第 3.7 节，见 [实施说明](tasks/RESEARCH-TOOLS.md)）：规则表和已验证平台清单、统一返回格式、美元成本接入 BILL2、确认失败时如实告知取不到数据（以后经批准增加备用线路后才换备用；2026-10-04 Owner 定 Bright Data 为备用渠道、Facebook 由它抓取，接入前实测和条款核对，第 52 项）、证据进资料库并接入账号注销、打开真实模型的搜索开关、对标流程的代码计算和表格写入限制。在封闭内测之前完成 | RESEARCH-0、AC-1、RUNTIME-PROD、DATA-ERASURE | 高 | 大 / 3–5 | — |
| | RATE-LIMIT | 方案 #573、准备切片 #562、后端 #590 与前端 #594 联合候选（#590 并入 #594）；一轮只在第一次新调用前检查、按冻结的最多调用数一次性预扣；同一写入方留 MODERATION-HOOK 两个检查点，默认放行。初始新对话 10/分钟、200/天，模型调用 30/分钟、600/天（第 30 项）。B 段 staging 冒烟全部 PASS（8 次真实调用，0.22676 美元）。初始值按每条新消息计（第 49 项）。正式环境 Upstash 在封闭内测前配置并核对容量 | #497、#550 | 高 | 中 / 3（正式环境 Upstash 见第 7.6 节） | 完成：不含正式环境 Upstash 配置和容量核对（第 7.6 节，公开上线前做） |
| | INVITE-ABUSE | （#560，迁移 0154）：首次正金额开户赠送的新账号才获邀请奖励、每账号仅绑定一次；不开消费返利；接受不同身份同一人无法识别（第 29 项） | #538 开户赠送资格 | 高 | 小 / 1 | 完成 |
| | SEC-RATELIMIT | 限流 fail-closed、Redis 超时放行、诊断计费探针。（#488，本机预览 #492） | — | 高 | 小 / 1–2 | 完成 |
| | FORGOT-PASSWORD | 忘记密码（Owner 2026-09-30 提出）：用户通过邮件验证重置密码；发送重置邮件时复用 #541 的隐形 hCaptcha；重置链接落到站内设置新密码的页面；**已注销或被封禁的账号不能靠重置密码恢复登录**，允许和拒绝两条路径都要测。Owner 2026-10-01 选定（[总控记录](https://github.com/Crnobog9527/GraylumAI_vercel/pull/566#issuecomment-5930333333)），由 #567、#568 实施，staging 交互验收完成（[总控结论](https://github.com/Crnobog9527/GraylumAI_vercel/pull/568#issuecomment-5935583047)）；最后三组是 Owner 整组确认，没有逐项截图和部署 SHA 的同期记录。**追加**：关联 Google 的账号也能在个人中心改密码（第 36 项），由 #569 实施，staging 交互验收通过（[总控结论](https://github.com/Crnobog9527/GraylumAI_vercel/pull/569#issuecomment-5935890997)）。正式环境上线另行批准 | #543、#548、#552 | 高（认证和登录恢复） | 小 / 3 | 完成 |
| | STAGING-HOST-CLEANUP | 2026-10-01（第 37 项）：清理残留的 `graylumai-staging.vercel.app` 引用。#571（测试、脚本默认值、示例配置、部署文档）、#605（文档入口）处理了大部分。剩余部分（staging `1563a44d` 核对）：6 个跟踪文件含旧域名：`stagingEnvironment.ts` 的 staging 环境名单（删掉会改变测试窗口准入，属于高风险，要另开 high PR）及其测试 `stagingEnvironment.test.ts`、`stagingAdmission.test.ts`、`runtime.integration.ts`、`run-workbench.mjs`，以及本文中的 Owner 原话和历史记录（保留）。Stripe / Waffo 沙箱回调、Supabase Site URL 和邮件回调由 Owner 自行检查，待 Owner 确认 | — | 普通；`stagingEnvironment.ts` 部分为高 | 小（剩余 1 个 high PR） | — |
| | DATA-ERASURE | 账号注销与数据删除，以及 D7 承诺的单条删除（对话回答、会话、已保存成果），都在公开上线前完成并列入验收。**设计先行**：在 AC-2 新建任何表之前先写出删除规则，实现在公开上线前完成（设计 #474，E1–E11 已决定，见第 2.1 节第 14 项）。见 [实施说明](tasks/DATA-ERASURE.md)。之后任何新增保存用户私有内容的任务，都要把新数据接入注销流程并列入验收。**实施拆分**：PR-A、PR-B1a、PR-B1b、PR-E、B2a，注销期间在途执行与账务收尾（方案 #598、实施 #611，是 BILL-PAYG 实施的前置条件，第 42 项），之后 B2b → PR-C（删除 Auth 账号）；#538 第 ③ 步等 PR-C 完成；正式库建库约束见第 9.3 节 | —（设计部分先于 AC-2） | 高 | 大 / 3–5 | — |
| | COST-REPORT | 后台成本报表的金额、估算和查询修正（原清单 06）。（#513） | — | 高 | 小 / 1 | 完成 |
| | PII-REGEX | 接手 PR #333（邮箱类个人信息匹配的性能加固，改的是安全过滤规则）：基于最新 staging 更新后重新审查，按 AGENTS.md 第 4 节验证、审查后合入 staging（第 8.4 节第 6 项）。由 #500 在最新 staging 上重新实现，#333 关闭 | — | 高 | 小 / 1 | 完成 |
| **3 差异化功能** | FUSION-REVIEW | 定稿报告多模型评审（第 4 节，见 [实施说明](tasks/FUSION.md)）；结果接入账号注销。对外名称"多模型专家评审团"，上线默认只给 Gold（第 51 项） | AC-3、REPORT-GEN、RUNTIME-PROD、ENTITLEMENTS、DATA-ERASURE | 高 | 大 / 3–4 | — |
| | LIB-DOCS | 资料库上传、"我的文档 / 语料库"、真正删除、按会员等级的总存储空间和系统级文件数量保护上限（见 [实施说明](tasks/LIBRARY-VOICE.md)）；接入账号注销；设计上传权限时一并整理共享 Storage 的授权（第 8.5 节）。第一步是 LIB-1 依赖及安全夹具（#549）；与 AC-2 设计定位导师查询工具（第 31 项） | ENTITLEMENTS、DATA-ERASURE | 高 | 大 / 3–4 | — |
| | VOICE | 文风画像生成、确认和写作注入；接入账号注销 | LIB-DOCS、AGENT-CORE、DATA-ERASURE、RUNTIME-PROD（资料内容发给模型前，"不用于训练"已由服务端强制） | 高 | 中 / 2–3 | — |
| | UI-A | 输入框编辑内核（沿用 v11 §6.3，属于 `V3-OPC-UI`，不新建任务名）。需要编辑器依赖时（例如 Tiptap，先核实版本、许可和构建），第一个 PR 只引入这个依赖，按 AGENTS.md 第 4 节验证、审查后合入 staging；之后的 PR 只改前端并沿用现有请求接口 | AGENT-CORE | 高 | 中 / 3–4 | — |
| | UI-MODEL | 输入框里的模型位置（Owner 2026-10-03，第 50 项）：保留位置，只显示 Auto，用户暂时不能切换；实际模型按用途由后台配置决定，不按会员档位区分 | UI-A、ENTITLEMENTS | 高 | 小 / 1–2 | — |
| | FUSION-COMPARE | 输入框里的多模型对比；结果接入账号注销。每次打开默认勾选管理员在后台设定的一组模型；用户可以取消勾选、自己搭配，范围受管理员允许列表和会员权限限制；后台新增参数"每次对比最少要勾选几个模型"，由 Owner 调整，前端和服务端都按它校验，取值范围是 2 ≤ 最少勾选数 ≤ D3 的当前最多模型数，后台可调但不能低于 2（Owner 2026-10-03，第 50 项）。同步 [FUSION 实施说明](tasks/FUSION.md) 的对比模式描述。上线默认只给 Gold（第 51 项） | UI-A、FUSION-REVIEW、DATA-ERASURE（多模型勾选器属于本任务，不依赖 UI-MODEL） | 高 | 中 / 2–3 | — |
| | UI-B | 输入框 @ 引用资料库内容：把用户私有资料读进模型上下文，涉及权限和上下文 | UI-A、LIB-DOCS、RUNTIME-PROD | 高 | 中 / 2 | — |
| | UI-C | 输入框附件 = 上传进资料库再引用（不另建一套上传，只支持 D6 的文档类型） | UI-A、LIB-DOCS、RUNTIME-PROD | 高 | 中 / 2 | — |
| | UI-FINISH | 导航、响应式、旧链接迁移、界面全验收（沿用 v11） | UI-B、UI-C | 普通 | 中 / 2–3 | — |
| **4 收费和上线** | PAY-COMMON → PAY-WAFFO | 沿用 v11 §9 和第 11 节定义；上线只用 Waffo 收款（Owner 2026-10-03，第 50 项）：银行卡订阅只做月付和年付（不做季度）；微信只支持单笔，用于积分包和一次性会员；不支持支付宝，只用支付宝的用户付不了款；Stripe 不作为上线收款渠道，下面的手动渠道开关只作备用。一次性会员要做：微信单笔购买 1 个月或 1 年会员，期限到期自动失效、不自动续费、到期再买；成为会员后可以买积分包；1 年期积分按 12 个月分期发放；退款按 v11 §9.3 只处理这一期的积分。按 D17，PAY-COMMON 提供后台"新购买使用的渠道"设置（Waffo / Stripe，手动切换），订单记录成交渠道，续费、退款和凭证按原渠道处理。**PAY-COMMON 方案**（[#608](https://github.com/Crnobog9527/GraylumAI_vercel/pull/608)；退款衔接 P1 已由 Owner 决定，第 47 项），由同一个 Codex writer 从 PR-1（[#612](https://github.com/Crnobog9527/GraylumAI_vercel/pull/612)）开始实施，每个实施 PR 合并另需 Owner 批准。**PAY-WAFFO 补充（2026-10-04，第 51 项）**：价格 Pro $29/月、$279/年，Gold $69/月、$621/年，微信一次性与银行卡同价；Waffo 没有优惠券，按价格分别建产品（Gold 月付新用户首期 $49 之后 $69、Gold 月付正价、微信 1 个月 Gold 新用户 $49 和正价 $69、Gold 创始会员年付首年 $496、续费按续费时 Gold 月付 12 个月价格的 6 折且不写死，记录 P）；服务端判断首月资格（任何渠道从没买过 Gold，年付和创始会员也算买过；扩展 0151 的身份摘要机制，新增 Gold 专属的权威事实，例如 `purpose=gold_first_purchase`，带原子预留和认领，防注销重注册和并发结账重复领取，high 迁移；不直接复用开户赠送的判定；首月优惠的预留同样按结账会话幂等记录；只有 Waffo 权威确认该会话已关闭或已过期才释放（[PAY-COMMON 实施说明](tasks/PAY-COMMON.md)第 7 节"幂等"行）；预留有效期内到达的成功付款兑现 $49；释放之后才到达的成功付款不自动给首月价，按 PAY-COMMON 冲突回执的口径进入人工复核；同一用户在预留有效期内重新打开结账，复用同一预留，不因为自己放弃结账而失去资格）并选择产品，前端只显示服务端返回的价格；创始会员 50 个名额由服务端计数（结账开始占名额；名额预留按结账会话幂等记录；只有在 Waffo 权威确认该会话已关闭或已过期后才回收名额（关闭页面或本地超时都不算会话结束，[PAY-COMMON 实施说明](tasks/PAY-COMMON.md)第 7 节"幂等"行）；预留有效期内到达的成功付款一律兑现；回收之后才到达的成功付款不自动兑现创始价、不超卖，按 PAY-COMMON 冲突回执的口径进入人工复核；名额计数检查和预留在同一个加锁（或 serializable）的数据库操作里完成，同一买家已有有效预留时复用、不另占名额，验收包括"最后一个名额被多个会话并发抢占时只成功一个"；已售出的名额在任何情况下都不放回，包括退款、取消、续费失败，验收确认这些情况都不放回、并发不超过 50 个；银行卡和微信都算创始会员，[记录 V](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5981192614)），满额后下架换回正价产品；Pro 中途升 Gold **已由 Owner 定（[记录 Q](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5980762284)）**：不退差价，按 Gold 价格付款（第一次买 Gold 享首月 $49），补发 8,970 积分并立即升级为 Gold 权益，按此实施（处理 #626 第 6 轮 P1"升级价格要在实施前锁定"）；升级后的计费周期也**已由 Owner 定（[记录 U](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5980903324)）**：下次扣费日从升级当天重新算，Gold 从升级当天起单独计费，原 Pro 订阅停止续费、不退差价，Pro 年付没发完的积分继续按月发完；核实 Waffo"前 N 期特价"的配置位置和创始会员长期折扣价能否设置。在 Waffo 后台建产品由 Owner 操作，实际配置前单独批准。**方案必须先解决**（[#626 总控记录](https://github.com/Crnobog9527/GraylumAI_vercel/pull/626#issuecomment-5976838440)，解决前实施 PR 不得合并）：① Gold 首购身份摘要在注销后的保留期限和清理契约，同步修改 DATA-ERASURE，**Gold 购买记录的保留期限由 Owner 在方案阶段确认**；② 名额放回条件已由 [记录 V](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5981192614) 取代：名额不放回，验收确认退款、取消、续费失败都不放回、并发不超过 50 个；③ 微信老创始会员的创始价续买资格判断（名额卖完后仍对有效期或宽限期内的老创始会员开放 $496，属于计费改动）；失去身份的前创始会员不能再按创始价购买，即使名额还没卖完；他已用掉的名额不放回、仍计入 50 个，他之后再买不按创始价，所以也不会占用新名额（名额按历史售出数计，不按当前有效会员数计）；创始价按账号资格加全局剩余名额由服务端判断；④ 银行卡年付续费前提醒和微信创始会员到期提醒共用一套机制，由系统自己发，上线前完成（[记录 X](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5981808905)）；⑥ 付款同意记录：每次用户主动结账或授权扣款时一条只追加的记录（用户、时间、条款和退款政策版本号、当时的 IP 和浏览器信息、商品、金额、付款方式、Waffo 订单号），与订单绑定，银行卡自动续费账单关联到原来那条记录；IP 和设备证据的保留期限由本方案提出（参考卡组织拒付窗口加余量），Owner 批准后同步修订 DATA-ERASURE，**修订完成之前不开始收集**；⑦ 上线前接收并记录 Waffo 的拒付和争议事件，不能忽略（对齐 [PAY-COMMON 实施说明](tasks/PAY-COMMON.md) 已定的 E5），前提是 Owner 先向 Waffo 核实拒付通知的方式；收到拒付通知后按被拒付的订单先冻结，可以撤回：订阅冻结这份订阅的付费权益、暂停以后的积分发放，并同时取消这份订阅的自动续费（银行卡月付和年付；[记录 AD](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5982615688)），拒付期间不会再扣款；微信一次性会员冻结这一期的会员权益，1 年期的还要暂停以后按月发放的积分（对齐记录 X"冻结会员权益和积分发放"）；订阅和微信一次性会员还要冻结这份付款已发放、还没用完的积分，不动其他来源（[记录 AC](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5982525998)）；积分包冻结这个包里没用完的积分，不动其他来源的积分（[记录 Z](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5982115736)），上线前完成（[记录 X](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5981808905)；判输后的处理归 CHARGEBACK）；⑧ 退款规则按 [记录 Y](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5982111397) 实施，判定、手续费、执行路径和测试矩阵见 [PAY-COMMON 实施说明](tasks/PAY-COMMON.md) PR-4，申请方式、人工审批和固定手续费已由 2026-10-07 补充决定确认；⑨ 所有拒付都不自动接受，由 Owner 人工处理（[记录 Y](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5982111397)）；已经被拒付的订单禁止再手动退款，避免退两次钱；⑩ 待核实：工单分类和退款申请入口是否对得上；订阅管理页是否还跳转到 Stripe（上线只用 Waffo）；新建表前按 AGENTS.md 第 5 节说明理由（[记录 W](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5981381009)，上线前，high）；⑤ 宽限期判断（银行卡扣款失败 7 天，微信到期后 7 天内续买），到期未续或例外退款时结束创始身份（第 51 项，[记录 V](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5981192614)） | ENTITLEMENTS 之后，同一条钱路线；与 Runtime 主线并行（第 46 项）；Pro 升 Gold 规则已由 Owner 定（[记录 Q](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5980762284)） | 高 | 大 / 7–10 | — |
| | PAYWALL | 第 2.1 节第 50 项的付费墙和积分产品：会员检查只在服务端的报告生成入口和报告调用准入两处；免费用户可以开始带步骤的 Skill，并做完报告前的全部步骤。入口路由（不是付费限制）：带步骤的 Skill 只从自己的入口开始，新对话入口和以后的按意图选 Skill 不加载带步骤的 Skill，参照旧入口的 409；报告模板和写作规则只在报告用途加载，不放进 SKILL.md 和前置步骤资源；积分包只允许会员购买；订阅会员和微信一次性会员都算付费会员（报告门槛和积分包购买一致对待）；开户赠送改为 500 积分（[记录 S](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5980831854)，迁移修改 0151 的固定 100，high，合并前 Owner 批准）；记录付费墙曝光；按第 50、51 项设定套餐和积分包数值；价格页只写积分和会员权益；（原"Pro 一个月买 2 次以上积分包时提示 Gold"已于 2026-10-04 取消，第 51 项）；会员到期后已生成的报告仍可看、可导出；免费用户的报告前信息导出（已确认、已整理的内容，可以看、可以导出，不收回，不检查会员）——现有导出只在"确认正式定位"发布之后才能用，导出的是由已确认步骤拼成的确定性报告（`workbench.export`，未发布时返回 NOT_PUBLISHED），不覆盖部分步骤已确认的情况；REPORT-GEN 改由模型写报告之后，这条导出路径也不能再代表免费可得的内容。所以要新增一个不依赖报告、不检查会员的前置信息导出，并在 REPORT-GEN 之后保留。**2026-10-04 补充（第 51 项）**：设计以仓库里导出的 v25 为唯一依据（[`docs/launch/design/paywall/`](design/paywall/README.md)，2026-10-04 入库；文案规则和待定事项见其 README）；报告对外叫"运营策略报告"；年付标签"最高省 40% / 25%"只按创始名额是否卖完切换（记录 V）；只用美元显示，年付写明比月付 × 12 省多少；付款按钮旁写首期价、续费价、周期和取消方式；付费墙用弹窗、默认选中月付；Gold 新用户首月 $49 和创始会员按服务端返回的价格和真实剩余名额展示；不做假原价、会重置的倒计时和 7 天退款保证；买积分包不提示升级会员；余额不足充值后由用户点"继续"、不显示还差多少积分；只显示已上线的功能，"报告评审"跟随 D12 开关；多模型专家评审团标"Gold 专属"并突出优势，Fusion 默认权限改为只给 Gold（实际修改配置前单独批准）；对比文案用 HawkSEM 定稿版；定位档案上限（免费 1 / Pro 3 / Gold 6；会员权益加"定位档案上限"字段，高风险迁移；服务端在新建业务时检查，数量检查和插入在同一个按用户加锁的数据库事务里完成（高风险迁移），验收包括同一用户用不同请求 id 并发新建时不超过上限；每个业务每个平台 1 个账号的约束；降级后超出额度的档案只读、由用户选哪几个继续可用；新增删除或归档定位档案并释放名额的功能，删除遵守 DATA-ERASURE 的保留规则，建议用归档（只读、可导出、不占名额），验收包括删除或归档后能再新建）；价格页放工作室版"联系我们"入口；付款前的条款同意勾选框（默认不勾，不勾不能付款，链接《服务条款》《退款政策》，按钮旁写价格、周期、是否自动续费、怎么取消和简短退款说明，订阅、积分包、微信一次性都要有；[记录 W](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5981381009)，上线前，设计稿 v25 没有，按第 51 项做）。积分包会员折扣 Pro 9.5 折、Gold 9 折，客服时效免费 48 / Pro 24 / Gold 工作时间内 2 小时，Gold 优先内测（[记录 Q](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5980762284)）；积分包三档和会员价按第 51 项的表（[记录 S](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5980831854)、[记录 T](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5980843167)），注册赠送 500 积分；创始人寄语仍待定。设计定稿 v25 于 2026-10-04 入库（[记录 N](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5972956845) 的前提）；代码实施须 Owner 选定批次。**方案必须先解决**（[#626 总控记录](https://github.com/Crnobog9527/GraylumAI_vercel/pull/626#issuecomment-5976838440)，解决前实施 PR 不得合并）：工作室版按客户单独覆盖档案上限（有上限范围）和后台入口，或者"联系我们"只收集意向、不承诺额度（第 51 项第 3 条） | REPORT-GEN、BILL-PAYG、PAY-COMMON、PAY-WAFFO（服务端选出的首月价、首月资格和创始名额计数由它提供）、ENTITLEMENTS；付费墙设计定稿 v25（`docs/launch/design/paywall/`） | 高 | 中 / 2–3 | — |
| | EXPERT-CONSULT | 真人专家诊断的预约入口（第 2.1 节第 51 项，[记录 L](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5972732100)、[记录 Q](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5980762284)、[记录 R](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5980780017)）：放在报告末尾、价格页和工作室版联系入口；只面向已有数据基础的账号，卡片写"预约咨询，免费询价"，不写价格；用户填写需求和联系方式，提交后通知 Owner，由 Owner 线下跟进。不做"同意专家查看报告"的授权开关，资料由用户自己导出后发来；授权查看功能上线时不做。咨询费不进产品结账流程（Stripe 或线下收款，税务由 Owner 处理）。联系方式按个人数据处理，接入账号注销和数据保留规则 | PAYWALL（入口位置）、DATA-ERASURE | 高 | 小 / 1–2 | — |
| | PUBLISH-MONITOR | 方向（Owner 2026-10-04，第 2.1 节第 51、52 项，[记录 Q](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5980762284)）：上线前接入 Post for Me，提供多平台发布和数据监控，海外 9 个平台（TikTok、Instagram、YouTube、Facebook、X、Threads、LinkedIn、Pinterest、Bluesky），用户授权自己的账号。Pro：一键发布 + 自己作品近 30 天数据；Gold：另加对标账号监控、90 天趋势、每周自动复盘；两档都按积分计费、不限条数。**D1 范围变更**：这两项原不在上线范围（第 10 节 D1）。Post for Me 实测和条款核对通过之前，相关功能和说法不上线 | RESEARCH-TOOLS；Post for Me 实测和条款核对（第 52 项）；其余依赖由方案定 | 高 | 待实施方案细化 | — |
| | LEGACY-CLOSE | 关入口由 #507 提前实施（2026-09-29）：`/chat` 临时跳转 `/positioning`，`/api/ai/stream` 对新请求返回 410，8 处入口改指或禁用；本任务剩余工作是删除旧代码（`/chat` 页面与组件、`/api/ai/stream`、`modelRouter`、`contextManager`、`agentSlice`、旧 `workbench` 接口等；自研内容检查 `contentModerator.ts`、`aiOutputFilter.ts`、`streamingOutput.ts`，以及它们在 `agentSlice` 和旧 `workbench` 生成里的调用，不单独开任务）和功能对照检查记录。旧检查文件随 LEGACY-CLOSE 删除；删除前核实必要的凭证保护和用户数据隔离不受影响，不要求迁移旧的通用 PII 正则过滤。按 Owner 2026-09-29 决定不再提供旧对话只读查看入口（staging 和正式环境都没有真实用户，上线前清空数据），旧链接直接跳到 `/positioning`；旧对话不迁移、不删除 | AC-4 接管自由对话；入口改指（#507）；UI-MODEL、UI-B、UI-C、UI-FINISH 交付；并完成一次功能对照检查（旧 `/chat` 的模型选择、引用、附件和常用操作在新工作区都有对应，或明确记录为不再提供） | 高 | 中 / 3–4 | — |
| | V3-M3 → REL-1 | 完整验收和发布（第 9.3 节；正式环境没有真实用户，按新建环境发布，不做旧数据兼容和迁移） | 以上全部 | 高；生产另行批准 | 大 | V3-M3：阻塞：等第 0–4 阶段的 D1 范围全部完成（依赖"以上全部"） |
| **5 上线后** | INTEGRATION-BASE → V3-FEISHU、SOCIAL-SYNC | 沿用 v11 §8（C1 套餐式自动追踪已确认） | REL-1 上线 | 高 | 大 | — |
| | CHARGEBACK | 方向（Owner 2026-10-04，第 2.1 节第 51 项，[记录 W](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5981381009)、[记录 X](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5981808905)；**上线后任务，不阻塞上线**）：拒付最终判定输了，按商品分别处理：订阅按退款规则处理这一期（扣掉还没用完的积分、终止这份订阅以后的积分发放，是创始会员的立即结束创始身份，名额不放回）；微信一次性会员结束这一期，1 年期的终止以后按月发放的积分、扣掉这一期还没用完的积分（是创始会员的同样结束创始身份）；订阅和微信一次性会员被冻结的已发积分判输扣回、判赢解冻，不动其他来源（[记录 AC](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5982525998)）；积分包扣回这个包里没用完的积分、判赢解冻，不动其他来源的积分（[记录 Z](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5982115736)）；所有拒付都不自动接受，由 Owner 人工处理（[记录 Y](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5982111397)）；赢了就解除 PAY-WAFFO 的冻结、恢复，按幂等处理（拒付期间被暂停的按月积分，判赢后按原发放日逐期补发，幂等，不改变原会员期限和发放日期，不延到原到期日之后）；订阅判赢后不自动恢复扣费，提醒用户自己重新订阅；判输时订阅终止（[记录 AD](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5982615688)），具体由 CHARGEBACK 方案提出、Owner 批准；一键导出申诉材料（用 PAY-WAFFO ⑥ 的同意记录和付款证据）；限制同一人反复拒付；信用卡账单商户名（由 Waffo 控制）。续费和到期提醒、拒付事件接收和可撤回冻结归 PAY-WAFFO，上线前完成。开工前 Owner 先向 Waffo 核实拒付通知、材料和期限、手续费、账单商户名 | PAY-WAFFO（含同意记录、拒付事件接收和冻结）；Waffo 核实结果 | 高 | 待实施方案细化 | — |
| | LEARN-1、LEARN-2 | 第 6.3 节：读取用户数据、依赖数据使用同意 | 有真实用户 / SOCIAL-SYNC | 高 | 中 | — |
| | LIB-EXT（资料库扩展） | PDF 等其他格式、全文检索或 pgvector、图片和音频、Google Drive / Notion 导入 | LIB-DOCS | 高 | 大 | — |

### 7.2 依赖简图

```text
P0-1、CI-TRUST-1 ─→ AGENT-CORE（AC-0 → AC-1 → AC-2、AC-3 → AC-5 → AC-4）
DATA-ERASURE 删除规则设计 ─→ AC-2
AGENT-CORE 稳定 ─→ RUNTIME-PROD 其余项（④ 的 BILL-PAYG 按下方主线提前；MODEL-REASONING、BILL-UNIT、MODEL-PRICING-SYNC 先行）
RESEARCH-0 + AC-1 + RUNTIME-PROD + DATA-ERASURE ─→ RESEARCH-TOOLS（原先接封闭内测，已取消，第 50 项）
REPORT-GEN + BILL-PAYG + PAY-COMMON → PAY-WAFFO + ENTITLEMENTS + 付费墙设计定稿 v25 ─→ PAYWALL（第 7.4 节 N3 批次，排在 PAY-WAFFO 之后）
PAYWALL + DATA-ERASURE ─→ EXPERT-CONSULT（第 7.4 节 N3 批次）
RESEARCH-TOOLS + Post for Me 实测和条款核对 ─→ PUBLISH-MONITOR（第 7.4 节 N3 批次）
PAY-WAFFO（含付款同意记录）+ Waffo 核实结果 ─→ CHARGEBACK（上线后）
D1 范围全部完成（第 0–4 阶段：上线基础含 RESEARCH-TOOLS；FUSION-REVIEW、LIB-DOCS、VOICE、UI-A—UI-FINISH、FUSION-COMPARE；PAY-COMMON → PAY-WAFFO、PAYWALL、EXPERT-CONSULT、PUBLISH-MONITOR、LEGACY-CLOSE）─→ V3-M3 ─→ REL-1 ─→ 公开上线售卖（生产另行批准）
公开上线前 ─→ Owner 决定 MODERATION 正式实现时间（暂缓；默认放行的检查点随 #594 接线）
S1 权限修复 ─→ DB-BASELINE ─→ V3-M3 ─→ REL-1
Runtime 主线：
  #611 注销在途收尾 ─→ BILL-PAYG PR-A ─→ BILL-PAYG PR-B ─→ CHAT-NATIVE-OUTPUT 续写 C2 ─→ REPORT-GEN
  BILL-PAYG PR-B 的前置：PROMPT-CACHE-HISTORY H1 先写 execute.ts（#610）
  CHAT-NATIVE-OUTPUT：C0/C1 在 #594 之后，C2 在 PAYG PR-B 之后
钱路线（与主线并行，第 46 项）：ENTITLEMENTS ─→ PAY-COMMON ─→ PAY-WAFFO
右侧整理：CONVERSATION-DRIVEN-CAPTURE B1 ─→ B2（处理出卡分寸、激活 PROMPT-CACHE-HISTORY H1）
#604 定稿 ─→ CONTENT-CONVERSATION-DRIVEN（与 #588 方向 B 合并设计）
MENTOR-BUDGET + BILL-PAYG + CHAT-NATIVE-OUTPUT C2 ─→ REPORT-GEN ─→ FUSION-REVIEW
PROMPT-CACHE（#591）─→ 缓存付费验收
DATA-ERASURE B2a（#550）+ #611 ─→ B2b ─→ PR-C（删除 Auth 账号）─→ #538 第 ③ 步
REPORT-GEN ─→ AC-3（报告部分）
RUNTIME-PROD + ENTITLEMENTS + DATA-ERASURE ─→ FUSION-REVIEW
ENTITLEMENTS + DATA-ERASURE ─→ LIB-DOCS ─→ VOICE（另需 RUNTIME-PROD）
AGENT-CORE ─→ UI-A ─→ UI-MODEL（只显示 Auto）；UI-A ─→ FUSION-COMPARE（多模型勾选器自带，不依赖 UI-MODEL）
LIB-DOCS + UI-A + RUNTIME-PROD ─→ UI-B、UI-C ─→ UI-FINISH
#543 + #548 + #552 ─→ FORGOT-PASSWORD（#567、#568）─→ Google 账号个人中心改密码（#569）
STAGING-HOST-CLEANUP 的 stagingEnvironment.ts 名单及相关测试（另开 high PR）
AC-4 + UI-MODEL + UI-B + UI-C + UI-FINISH + 功能对照检查 ─→ LEGACY-CLOSE ─→ V3-M3 ─→ REL-1
```

<a id="parallel"></a>
### 7.3 可以并行的线

| 线 | 内容 | 写入面 |
| --- | --- | --- |
| Runtime 线（一个 writer） | P0-1 → AGENT-CORE → RUNTIME-PROD + MODEL-REASONING → FUSION；主线 BILL-PAYG PR-A → PR-B → CHAT-NATIVE-OUTPUT C2 → REPORT-GEN。#611 和 BILL-PAYG 实施由 Codex 写（第 41、42 项）；其后各任务的写入方由总控按任务指派 | Runtime、BILL2 接入、定位和工作区页面 |
| 检查线 | CI-TRUST、DEBT-QUICK | CI 配置、ESLint、测试入口、死代码；和 Runtime 线不改同一个文件 |
| 资料线 | LIB-DOCS → VOICE（在 ENTITLEMENTS 之后） | 新数据表、存储、资料库页面；VOICE 接入 Runtime 时和 Runtime 线协调 |
| 右侧整理线 | CONVERSATION-DRIVEN-CAPTURE B2；之后与 CONTENT-CONVERSATION-DRIVEN 合并设计 | OPC 整理、右侧面板；B1（#593，0159）和 #611（0160）的迁移编号和 `executionStream.ts` 由后合并的 #611 同步（第 42 项） |
| 钱路线（一个 writer） | ENTITLEMENTS → PAY-COMMON（Codex）→ PAY-WAFFO；与 Runtime 主线并行（第 46 项） | 会员计划、支付、订单、权益 |

同一个文件、同一张表、同一个共享配置只能由一条线修改；共享部分先由一方交付，另一方再使用（AGENTS 第 3 节）。

### 7.4 建议的授权批次

| 批次 | 范围 | 停在哪里 |
| --- | --- | --- |
| N1a 止血和保护 | P0-1、P0-2、P0-4、CI-TRUST-1 | 导师出字速度在 staging 实测达标；计费和恢复测试进入 CI |
| N1b 体验样片 | AC-0、AC-1 及其对应的 AGENT-CORE-UI 部分；RESEARCH-0（和 AC-0 同期）；MODEL-REASONING（按 Owner 2026-09-28 决定提前，在 AC1-4 之前完成） | Owner 在 staging 用真实模型走完定位第一步，决定继续、调整还是换模型；右侧整理这一阶段沿用旧做法 |
| N1c 完整定位流程 | DATA-ERASURE 删除规则设计、AC-2（含 CONVERSATION-DRIVEN-CAPTURE B1/B2）、AC-3、AC-5 及其对应的 AGENT-CORE-UI 部分（本步小结卡、右侧面板和进度条）；CHAT-NATIVE-OUTPUT、REPORT-GEN（暂列，待 Owner 选定批次） | Owner 从进入到定稿完整走通并验收 |
| N1d 推广 | AC-4 及其对应的 AGENT-CORE-UI 部分；CONTENT-CONVERSATION-DRIVEN（暂列，待 Owner 选定批次）；DEBT-QUICK、CI-TRUST 其余部分 | 自由对话和其他 Skill 用上新工作区；检查线的任务并行，不阻塞前面的验收 |
| N2 上线基础 | RUNTIME-PROD（含 BILL-UNIT、BILL-PAYG）、PROMPT-CACHE、PROMPT-CACHE-HISTORY、RATE-LIMIT 接线（含默认放行的 MODERATION-HOOK）、DB-BASELINE、RESEARCH-TOOLS、ENTITLEMENTS、SEC-RATELIMIT、PII-REGEX、DATA-ERASURE 实现、COST-REPORT、PAY-COMMON。钱路线已由 Owner 批准并行开工（第 46 项） | 上线基础完成。原定此后先做 5–10 人封闭内测（D8），2026-10-03 已取消（第 2.1 节第 50 项），按 D1 范围完成后直接公开上线售卖 |
| N3 差异化功能 | 先 FUSION-REVIEW、LIB-DOCS、VOICE；再 UI-A、UI-MODEL、FUSION-COMPARE、UI-B、UI-C、UI-FINISH；PAY-WAFFO（含微信一次性会员）；PAYWALL（依赖 REPORT-GEN、BILL-PAYG、PAY-COMMON、PAY-WAFFO、ENTITLEMENTS 和已入库的付费墙设计定稿 v25，须在 REL-1 之前完成）；EXPERT-CONSULT（依赖 PAYWALL、DATA-ERASURE，须在 REL-1 之前完成）；PUBLISH-MONITOR（依赖 RESEARCH-TOOLS 和 Post for Me 实测、条款核对，须在 REL-1 之前完成，D1 范围变更） | 差异化功能完成（对比模式对钱路核心改动最大，放在后面） |
| N4 收口 | LEGACY-CLOSE、V3-M3；公开上线前请 Owner 决定 MODERATION 正式实现时间 | 完整验收；REL-1 和生产另行批准 |

每批由 Owner 选定后开工，批次内由 Agent 自主排序、测试、修复，完成后停下，不自动开始下一批（AGENTS.md 第 2 节）。

### 7.5 任务编号对照

- 保留：`R0-A`、`GOV-1`、`R0-B`、`STG-FIX`、`SEC-1`、`AUTH-1`、`YEAR-1`、`REFUND-1B`、`BILL-1`、`SKILL-1A`、`SKILL-1B`、`PAY-1`、`CI-1`、`V3.1-LOAD`、`V3-PACKAGE-RESEARCH`、`V3-ARTIFACTS`、`V3-BILL-2`、`V3-RUNTIME`（历史基础交付），以及 `PAY-COMMON`、`PAY-WAFFO`、`INTEGRATION-BASE`、`V3-FEISHU`、`SOCIAL-SYNC`、`V3-LEGACY-CLOSE`（简称 LEGACY-CLOSE）、`V3-M3`、`REL-1`。
- `V3-WORKBENCH` 的 SCOPE / AGENT / ENTRY / CONTENT：代码已随 #422 合并；未完成的 VERIFY 和 Owner 体验验收并入 AGENT-CORE。
- `V3-OPC-UI` 的 A / B / C / FINISH：改称 UI-A / UI-B / UI-C / UI-FINISH，UI-C 改为复用 LIB-DOCS。
- `V3-GOLD`：改名 FUSION，拆成 FUSION-REVIEW 和 FUSION-COMPARE。
- 新增：AGENT-CORE（含 AC-0）、AGENT-CORE-UI（从 AGENT-CORE 拆出的纯前端部分）、CI-TRUST（含 CI-TRUST-1）、DEBT-QUICK、COST-REPORT、MODEL-REASONING、UI-MODEL（从原 UI-A 拆出的输入框模型位置，上线只显示 Auto）、RUNTIME-PROD、ENTITLEMENTS、SEC-RATELIMIT、PII-REGEX（接手 PR #333）、RESEARCH-0、RESEARCH-TOOLS、DATA-ERASURE、LIB-DOCS、VOICE、LEARN-1、LEARN-2；2026-09-30 新增 MENTOR-BUDGET、REPORT-GEN、FORGOT-PASSWORD；2026-10-01 新增 BILL-PAYG（承接 RUNTIME-PROD ④）、BILL-UNIT（#565，含按模型倍数）、RATE-LIMIT、STG-MENTOR-MODEL（#561）、INVITE-ABUSE；2026-10-01—02 新增 PROMPT-CACHE（上线必做，第 35 项）、STAGING-HOST-CLEANUP（第 37 项）；2026-10-02—03 新增 MODEL-PRICING-SYNC（第 40 项）、MENTOR-PROMPT-V2、RUNTIME-VIEW-PERF、CONVERSATION-DRIVEN-CAPTURE（第 48 项）、PROMPT-CACHE-HISTORY（第 43 项）、CHAT-NATIVE-OUTPUT（第 44 项）、CONTENT-CONVERSATION-DRIVEN（第 45 项）；STG-MENTOR-MODEL 已关闭（第 38 项）；2026-10-03 新增 PAYWALL（第 50 项）；2026-10-04 新增 EXPERT-CONSULT（第 51 项）、PUBLISH-MONITOR、CHARGEBACK；2026-10-05 起"资料库扩展"的规范任务名为 LIB-EXT。
- 迁移编号在实际实施时分配，本文不预占。

### 7.6 Owner 需要提前启动的事项

这些事有外部等待时间，建议现在就开始，不要等到开发做完：

| 事项 | 为什么要早 |
| --- | --- |
| Waffo 商户开通 | 商户审核、费率和结算条件要对方确认，PAY-WAFFO 依赖它 |
| 隐私条款、服务条款和数据使用政策 | 由 Owner 用第三方专业软件生成；规划只规定产品行为，不规定条款文字 |
| Stripe 直接收款的税务责任 | Stripe 是备用渠道（D17）；2026-10-03 定为上线不用 Stripe 收款（第 50 项）。Stripe 直接收款时 Graylum 是卖家，这和通过 Waffo（MoR）销售不同；税务责任要在第一次切换到 Stripe 之前确认 |
| 第三方搜索服务 | TikHub、Parallel、Firecrawl 已注册并在 RESEARCH-0 中实测。等网站用户使用量大了，再由 Owner 向三家申请企业定制授权（第 3.7 节表格）；需要时向 TikHub 购买更高的每秒请求数；定稿隐私条款时一并咨询抓取类数据的合规问题 |
| 定价配置与积分产品复核（2026-10-01，2026-10-03 更新） | q=100 已决定；默认 m 2026-10-03 改为 6（第 50 项），staging 现为 m=3（第 39 项），改配置须另获批准。订阅和积分包比例已定（第 50 项）；2026-10-04 实际售价已定（Pro $29、Gold $69、年付 $279 / $621、Gold 新用户首月 $49、创始会员首年 $496/年、续费不写死，第 51 项）；套餐价格和每月积分已定（Pro 3,480、Gold 8,970），需要单独批准的只是实际写入配置；开户赠送 500 积分和积分包三档已先定（第 51 项，记录 S、T；积分包会员折扣 Pro 9.5 折、Gold 9 折），实测后可能调整；邀请奖励 50/30 按 m=6 复核；产品数值不因 q/m 变化自动改；面向用户的计费说明要按名义费用和"有分时价的线路按最高时段标价计费"写（第 41 项，条款文字由 Owner 处理） |
| 正式环境 Upstash（2026-10-01） | staging 已配置；正式环境在公开上线前配置（封闭内测已取消，第 50 项），核对容量、变量名和故障拒绝路径（第 30 项） |
| Vercel Pro（2026-10-01） | Owner 已承诺正式运营升级；上线前完成套餐与运行时预算核对，Hobby 300 秒仅约束 staging（第 28 项） |
| staging 服务商回调地址（2026-10-01） | 旧域名已删除（第 37 项）；Stripe / Waffo 沙箱回调地址、Supabase Site URL 和邮件 Redirect URLs 是否已不再指向旧域名，待 Owner 自行检查确认（#605 列出了待核对位置，没有读取外部配置） |
| 正式站临时重定向（2026-10-03） | 待 Owner 在 Vercel 正式项目后台把 `www.graylum.com` 临时 307 到 `app.graylum.com`，操作后总控线上复核；新落地页上线时先撤回这条重定向，再去掉代码里的 noindex（第 8.5 节，[#614 总控记录](https://github.com/Crnobog9527/GraylumAI_vercel/pull/614#issuecomment-5968241886)） |
| 客服邮箱 | 上线发布条件之一（v11 §13.3） |

### 7.7 历史 PR 对照

2026-10-05 之前合并或打开的 PR，有些标题里没有规范任务名。下表把它们一次性归到任务（核对到 staging `470cef9a`），供脚本使用；之后的 PR 按第 7.0 节在标题里写任务名，不再往本表追加。标"（方案）"的是只含方案的 PR。

| 任务 | PR |
| --- | --- |
| P0-1 | #446 |
| P0-3 | #448 |
| DEBT-QUICK | #482、#483 |
| INVITE-ABUSE | #560 |
| AGENT-CORE | #454、#456、#467、#468、#469、#470、#472、#473、#475、#477、#479、#481、#497 |
| AGENT-CORE-UI | #619、#620、#623、#624、#628 |
| MENTOR-BUDGET | #564 |
| STG-MENTOR-MODEL | #561（方案） |
| CONVERSATION-DRIVEN-CAPTURE | #588（方案） |
| CI-TRUST | #511、#512 |
| BILL-UNIT | #565 |
| MODEL-PRICING-SYNC | #580、#581 |
| BILL-PAYG | #625、#627、#629 |
| DB-BASELINE | #539、#556、#563、#575、#577、#579、#592 |
| MODERATION | #573（方案）、#594 |
| MODEL-REASONING | #495 |
| RATE-LIMIT | #590 |
| SEC-RATELIMIT | #492 |
| FORGOT-PASSWORD | #567、#568、#569 |
| STAGING-HOST-CLEANUP | #571 |
| DATA-ERASURE | #474（方案）、#550 |
| COST-REPORT | #513 |
| PII-REGEX | #333、#500 |
| LIB-DOCS | #549 |
| LEGACY-CLOSE | #507、#515 |

<a id="debt"></a>
## 8. 技术债：核实结果与清理顺序

2026-09-27 对 ChatGPT 清单（基于旧提交 `84a4b542`）逐条核对了当前代码（`d2b42e72`）。21 条的描述基本属实，但有两类判断需要修正：

- **严重程度**：限流包装问题（原 01）和 Redis 超时放行是同一类故障。入口层 IP 限流用的是同一个 Redis，Redis 不可用时也会失效，不能算兜底。两者合并为上线前必须修复的 P1，在 SEC-RATELIMIT 里处理。
- **"旧链路"的范围**：`/api/ai/stream`、`modelRouter`、`contextManager` 仍是 `/chat` 普通对话正在用的引擎，个人中心历史、后台、技能广场的模块详情和旧工作台都还会把用户带到 `/chat`。真正无人调用的只有 `routers/ai.ts` 和 `streamHandler.ts`。

清单还漏掉了几个更重要的问题，见 8.1。

### 8.1 清单外的重要发现

| 问题 | 为什么重要 | 级别 |
| --- | --- | --- |
| 旧接口 `ai.sendMessage` 没有任何页面在用，但任何登录用户都能直接调用，会预扣积分并真实调用 OpenRouter | 多余的付费攻击面 | **P1**，关闭 |
| `packages/api/run_diag.ts`、`test_rpc.ts` 两个临时脚本会真实扣积分（`run_diag.ts` 扣后退回但不检查退回是否成功；`test_rpc.ts` 从第一个用户扣 1 积分且不退还） | 误运行就动真钱 | **P1**，删除 |
| 无法注销账号，也无法真正删除用户数据：业务和执行记录为了账务安全不可修改、没有级联删除，上传文件也从不清理 | 隐私法规和用户信任；v10.2 已要求支持用户删除 | **P1**，公开上线前必须 |
| 正式环境还不能真实调用模型：新 Runtime 只能在 staging 测试窗口里、给最多 8 个白名单用户真实调用，正式报价、积分兑换比例和开放机制都没有 | 上线的硬前提 | **P1**，上线前必须（RUNTIME-PROD） |
| Redis 超时（默认 5 秒）时限流直接放行，所有入口都受影响，包括 `/api/ai/stream` | 故障时限流形同虚设 | **P1**（与原 01 合并） |
| 诊断里的计费探针会动管理员的真实积分，而且不管结果如何都显示通过 | 诊断不可信 | P2 |
| 16 个集成测试文件（约 2 万行，覆盖计费、恢复等关键路径）从未在 CI 里运行 | 最关键的保护不在 CI 里 | P2 |
| 头像上传：据[总控审阅](https://github.com/Crnobog9527/GraylumAI_vercel/pull/559#issuecomment-5918953558)，上传写入私有桶 `ticket-attachments`，接口拒绝 `avatarUrl`，用户没有更新权限，每次尝试会留下孤儿文件 | 用户可见的 bug，涉及存储、接口和权限 | P2；保留按钮，以后单独按高风险立项（第 8.5 节） |

### 8.2 原清单 21 条的结论

| # | 内容 | 核实结果 | 级别 | 处理方式 |
| --- | --- | --- | --- | --- |
| 01 | 限流包装吞掉 fail-closed 拒绝 | 属实；影响工作台和旧切片路径，新 Runtime 不经过它 | **P1** | SEC-RATELIMIT，与 Redis 超时一起修 |
| 02 | 诊断结果和实际安全机制不一致 | 属实 | P2 | 诊断报告修正放 DEBT-QUICK；计费探针放 SEC-RATELIMIT |
| 03 | ESLint 没检查 TS/TSX | 属实（只检查 4 个 `.mjs` 文件） | P2 | CI-TRUST（需要新增依赖） |
| 04 | 网站单测入口分散 | 属实：CI 只跑 26 个网站单测中的 4 个，根目录 `pnpm test` 很可能无效 | P2 | CI-TRUST |
| 05 | 模型配置失败被硬编码默认模型掩盖 | 属实，发生在 `/chat` | P2 | 随 LEGACY-CLOSE 解决；如果下线推迟再单独修 |
| 06 | 成本报表金额和查询问题 | 属实，例如美元均价被取整成 0 | P2 | COST-REPORT（改变金额展示，属于高风险） |
| 07 | 临时诊断脚本 | 属实，而且更危险（见 8.1） | **P1** | P0-2 |
| 08–11 | 旧 costCalculator、StreamHandler、useStreamResponse、promptCache | 属实，都没有生产调用 | P3 | DEBT-QUICK 删除（`runtime/promptCache.ts` 是现行代码，保留） |
| 12 | `@repo/ui` 空壳包 | 属实 | P3 | 删除会改动工作区依赖和锁文件，属于高风险，放进 CI-TRUST（它本来就要删除未接入的 `eslint-config-custom` 依赖） |
| 13 | 多代 AI 路由并存 | 属实 | P2 | `ai` 路由在 P0-2 关闭；其余在 LEGACY-CLOSE 统一下线 |
| 14 | 定位页 2860 行 | 属实 | — | **不重构**，由 AGENT-CORE 整体替换 |
| 15 | 后台和账务大文件 | 属实，已被代码大小检查冻结 | P3 | 改到时顺手拆出只读部分；账务文件不为了拆而拆 |
| 16 | OPC 集成测试单文件约 65 万字节 | 属实，而且不在 CI 里运行 | P2 | 先在 CI-TRUST-1 进 CI；AGENT-CORE 完成后按流程拆分 |
| 17 | API 类型检查依赖网站工程 | 属实：118 个 API 测试文件中有 85 个从未被类型检查 | P2 | CI-TRUST |
| 18 | `provider` 字段一词多义 | 属实，影响面比清单说的更广 | P2 | 随 RUNTIME-PROD 一起理清 |
| 19 | 数据库真假值混用字符串和布尔 | 属实 | P3 | 改到时用统一的解析函数；类型迁移另做 |
| 20 | 本地设计样例页 | 属实，生产环境已返回 404 | P3 | AGENT-CORE 完成后删除 |
| 21 | 网站 README 是模板、旧资料混杂 | 属实 | P3 | 本规划已归档 `movetonew/` 和根目录旧报告，并替换网站 README |

另有 11 个没有任何引用的业务组件（约 1,535 行）和 15 个没用到的基础界面组件（约 1,266 行），删除前逐个确认，和死代码一起在 DEBT-QUICK 处理。

### 8.3 清理顺序

1. **立即（P0-2，高风险）**：关闭 `ai.sendMessage` 接口；删除两个会扣积分的临时脚本。
2. **快速清理（DEBT-QUICK，普通）**：诊断报告修正、死代码和无引用组件删除。头像上传保留按钮，以后单独按高风险立项（第 8.5 节），不纳入普通快速清理。只包含普通改动：凡是动到依赖或锁文件、鉴权权限、存储策略、计费、金额展示或 CI 的部分，一律移到对应的高风险任务（成本报表修正单独为 COST-REPORT），不走 staging 自动交付授权。
3. **CI 可信度（CI-TRUST-1 先行，其余随后，高风险）**：ESLint 覆盖 TS/TSX、网站单测统一入口、API 独立类型检查、集成测试进 CI，以及删除 `@repo/ui` 空壳包和未接入的 `eslint-config-custom`（都改依赖和锁文件）。**在 AGENT-CORE 改 Runtime 之前或同时完成**，让计费和恢复的关键测试先保护起来。
4. **安全修复（SEC-RATELIMIT，高风险，上线前必须）**：限流 fail-closed、Redis 超时、诊断计费探针。
5. **随主线处理**：`provider` 语义随 RUNTIME-PROD；定位页随 AGENT-CORE 替换；`/chat` 的入口和发送接口已由 #507 提前关闭；旧代码在 AC-4 接管自由对话之后由 LEGACY-CLOSE 统一删除；集成测试大文件在 AGENT-CORE 完成后拆分。
6. **公开上线前必须**：DATA-ERASURE。

原则：不为清理做一轮全站重构；已应用的迁移、原请求 ID、收据、预留和恢复兼容，不能当"旧文件"删除；每一项都要有能证明行为不变的测试。

### 8.4 GitHub 遗留项清理（Fable 2026-09-27 逐项核实）

下列操作只写进规划；**等对应批次被 Owner 选定后再执行**，本规划合并本身不关闭任何 PR 或问题单，也不改配置。（2026-10-03 核对：第 4–5 项列出的问题单都已是关闭状态，#607 也核对过，不需要再关闭；唯一仍开着的问题单 #478 属于 OPC 集成测试，不在本清单。）

放进 CI-TRUST（高风险，改的是依赖更新配置）：

1. 修改 `.github/dependabot.yml`，为每个更新项指定 `target-branch: staging`。原因：依赖升级机器人没有指定目标分支，一直往 `main` 发 PR，而 `main` 落后 staging 448 个提交（2026-09-27）。
2. 关闭指向 `main` 的 12 个依赖升级 PR，不直接合并：#420、#411、#410、#385、#384、#383、#381、#332、#325、#323、#194、#193。其中 #410、#411 已过期，staging 的 Next 已是 16.3.3。
3. 配置生效后，对机器人重新发到 staging 的升级逐个评估；vitest 5 和 `@vercel/speed-insights` 2 是大版本升级，单独处理。

放进 DEBT-QUICK（普通，只是 GitHub 操作，不改代码）：

4. 关闭已解决的问题单并写明依据：#361、#285（fast-uri 已锁定 3.1.6，依赖审计通过）；#276（`settings.ts` 和前端已判断金额大于零）。
5. 关闭已废弃的治理和控制面问题单：#359、#354、#348、#336、#320、#319、#317、#314、#287、#278、#277、#270、#268、#267、#263，以及 #413。关闭说明统一写"已被现行 AGENTS.md 和 Master Plan v12 取代"。

新增小任务 PII-REGEX（高风险，改的是安全过滤规则）：

6. 接手 PR #333，基于最新 staging 更新后重新审查，按 AGENTS.md 第 4 节验证、审查后合入 staging。

### 8.5 计划外完成的安全和清理（2026-09-28—10-03）

> 本表记录到 2026-10-03；之后的计划外工作由 `scripts/plan-progress.mjs` 自动列出（第 7.0 节）。

这些工作不在第 7 节的批次里，由 Owner 另行安排，都已合并：

| 类别 | 内容 | PR |
| --- | --- | --- |
| 数据库盘点 | 数据库基线和用户数据盘点（16 个核心表只在 `schema.ts` 里、不在迁移里）；staging 数据库权限普查 | #487、#498 |
| 数据库权限 | 邀请记录和邀请码的列权限、服务端权限（迁移 0140、0141）；普通用户不能读模型密钥（0142）；工单恢复本人访问和最小权限，并收回多余授权（0143）。0140–0143 都已应用到 staging；0143 的迁移账本已补登 | #484、#489、#493、#496、#504、#506 |
| 代码扫描 | 内容审核的回溯漏洞、跳转和报告输入加固、横幅链接校验、定位页标点规则；需要修复的 CodeQL 警报已全部修复，11 条误报经 Owner 批准标记 | #500、#501、#503、#505 |
| 其他安全 | 响应头和爬虫访问；依赖 fast-uri 漏洞 | #499、#491 |
| 清理 | 退役"按会员等级定时删除对话"和首页公告区，只保留全站横幅 | #485 |
| 数据库权限（S1-FIX，2026-09-29—30） | 恢复个人资料、公告和后台用户的最小权限（0144）；恢复定时任务记账、模块计数和诊断读取（0145）；收回客户端的非 DML 和维护权限，诊断结果改由服务端读写（0146） | #514、#519、#521 |
| 人机验证（2026-09-30） | 验证框放进注销和修改密码弹窗，封禁账号登录报错中文化；hCaptcha 图片挑战窗内的交互不再关闭弹窗；登录、注册、重发邮件、修改密码改用隐形 hCaptcha，注销保留可见复选框（第 2.1 节第 24 项） | #529、#533、#541 |
| 清理（C5，2026-09-30） | 删除绕过账务函数的旧加减积分接口；删除没有调用方的后台接口，操作日志写入失败时告知后台 | #525、#527 |
| 依赖安全（2026-09-30） | 升级 staging 上仍受影响的依赖安全警报；brace-expansion override 升级；Next.js 16.3.6 安全修复 | #524、#534、[#555](https://github.com/Crnobog9527/GraylumAI_vercel/pull/555) |
| 网页和后台修复（2026-09-29—30） | 错误页和 404、中文 `lang`、读取失败不冒充默认值、设置链接；后台统计卡片金额简写、公告时间按本地时间显示和保存、公告结束时间可清空；本地限流测试就绪超时竞态 | #522、#517、#518、#520、#516 |
| 认证与 Runtime 修复（2026-09-30—10-01） | 未验证邮箱登录分支和过期验证链接落地修复；staging 目标检查接受项目两个域名，修复调用被拒绝 | [#543](https://github.com/Crnobog9527/GraylumAI_vercel/pull/543)、[#554](https://github.com/Crnobog9527/GraylumAI_vercel/pull/554) |
| Runtime 修复（2026-10-01） | Gemini 在同一个 index 上先流出思考文字、再流出思考签名时，流解析不再判为无效流（#561 实测中发现的产品缺陷） | [#574](https://github.com/Crnobog9527/GraylumAI_vercel/pull/574) |
| 定位页修复（2026-10-02—03，ordinary） | 推荐理由显示在推荐选项正下方；滚动条移到中间面板右边缘；刷新后保持阅读位置；刷新后自动接上并无感恢复；冻结视频材料变化时返回明确的 412 拒绝 | #583、#587、#589、#595、#613 |
| 后台修复（2026-10-02—03，ordinary） | 财务统计兼容签到和未知流水类型；财务页显示签到赠送和未知流水/状态；财务近 1 天、校验提示、编辑弹窗读取、个人中心重试 | #599、#600、#606 |
| 正式站紧急 noindex（2026-10-03） | 正式站 `www.graylum.com`（由 `main` 部署）在落地页重新设计前不被搜索引擎和 AI 爬虫收录，首页删除未经证实的「10K+ / 300% / 1M+」数字和「7 天退款保障」。Owner 先在 SEO/GEO 窗口批准紧急修复，又在总控窗口确认，原话：「同意合并紧急修复 PR #xxx 到 main 并部署正式环境：全站 noindex，删除首页 10K+/300%/1M+ 数字和 7 天退款文字。」（原话里的 #xxx 就是原文；总控当时说明，正式部署前仍要按具体 PR 号和 head 再确认一次。）**staging**：#615 已合并（`e39f1dc5`），全站响应头加 `X-Robots-Tag: noindex, nofollow`，staging 和预览环境也不被收录。**正式站**：#614（对 `main` 的修复）因为 `main` 的必需检查 Dependency Audit 失败而关闭、没有合并。失败原因是 `main` 2026-08-16 的锁文件被新公布的漏洞命中，和这个修复无关；`main` 的保护对管理员同样生效，不绕过，也不为此把依赖升级搬到 `main`。替代做法是在 Vercel 正式项目后台把 `www.graylum.com` 临时 307 重定向到 `app.graylum.com`（维护页），**待 Owner 在 Vercel 后台操作**，操作后由总控做线上复核。同样的代码改动随下次 staging→main 常规上线带进 `main`。**新落地页上线时**：先撤回 Vercel 的 www→app 重定向，再去掉代码里的 noindex，否则整站不会被收录 | [#614 总控记录](https://github.com/Crnobog9527/GraylumAI_vercel/pull/614#issuecomment-5968241886)、[#615 合并记录](https://github.com/Crnobog9527/GraylumAI_vercel/pull/615#issuecomment-5968246657) |
| 测试维护（2026-10-02） | 本机 OPC 集成用例跟上 v5 导师回合；本机浏览器集成夹具；每个迁移后的 staging 指纹刷新 | #576、#585、#575、#577、#579、#592 |

**后续事项**：
1. **共享 Storage 的授权**（`storage.objects`、`storage.buckets`）：是 Supabase 的默认授权，RLS 已开且没有策略；REST 不暴露 storage schema，匿名用户列不出任何对象（2026-09-29 只读核查，见 #506 评论）。在 LIB-DOCS 或 UI-C 设计上传权限时一并整理，最晚在上线前的安全检查中和正式环境核对一起做。如果以后把 storage 加入 REST 暴露范围或新建公开桶，要先重新评估。
2. **正式环境的数据库权限**：staging 上发现的问题（模型密钥列、工单、邀请、Storage）在正式环境是否同样存在，上线准备阶段经 Owner 批准后只读核对；按第 2.1 节第 18 项，正式库由迁移文件建出，这些权限要先进入迁移和 DB-BASELINE 的基线，由空库建库验证覆盖。
3. 诊断页的"智能路由""实时关键词"两项期望值和 #406 之后的规则不一致，只服务旧 `/chat`，随 LEGACY-CLOSE 删除。
4. 部分网页组件测试（例如模型思考设置的草稿和对话框测试）只在本机运行，纳入 CI-TRUST。
5. 定位集成测试基线问题（#478，包括过时的"定位摘要"定位方式）；MR-1 之后本机有 3 个后台用例需要补模型思考配置的测试数据。
6. 积压的依赖升级 PR 按第 8.4 节统一评估。
7. **头像上传修复**：Owner 2026-10-01 原话：“b 留着以后修”（[总控记录](https://github.com/Crnobog9527/GraylumAI_vercel/pull/559#issuecomment-5918953558)）。保留按钮，以后单独立项；高风险（存储、接口、权限），需处理私有桶上传、`avatarUrl` 被拒、用户无更新权限及孤儿文件问题。本次只记待办，不实施修复。

<a id="rules"></a>
## 9. 继续有效的规则与验收出口

### 9.1 继续有效的 v11 章节

规划正文只写产品规则和必须保证的结果；实现机制、必测项和开工前必读章节在第 11 节列出的实施说明里。以下 [v11](Graylum_Master_Plan_v11.md) 章节原样继续适用，除非第 2.2 节列为被取代：

| v11 章节 | 内容 |
| --- | --- |
| §3.2–3.3 | 自动、提问、明确采用、直接操作的区别；自然语言和卡片执行同一个业务动作；操作与会话一致、防重复 |
| §4.1–4.3 | 新手和已有定位两个入口、信息完整与深度的区别、业务 / 平台 / 账号关系 |
| §5 | 周选题、资料库组织、交付深度和视频链路（其中"不新增上传"一句由本文第 5 节取代） |
| §6.1–6.2 | Skill 基座、上下文与模型职责（其中智囊团模型只由管理员配置一句由第 4 节取代） |
| §6.3–6.4 | 输入框 UI-A / UI-B / UI-C 的原始要求（UI-C 改为复用 LIB-DOCS，其中图片选择、图片附件和多模态处理不在本版范围，按 D6 只支持文档，图片在上线后随资料库扩展再做）、发现与展示 |
| §7 | 后台"编辑 → 保存 → 读回 → 服务端实际使用 → 页面体现"的完整接线要求 |
| §8 | 连接器、社媒发布与采集、C1 套餐式自动追踪、调度与配额、复盘证据标准 |
| §9 | BILL2 和旧钱路核心约束、Waffo MoR、商业和验收规则 |
| §10 | 历史、安全与兼容 |

<a id="billing"></a><a id="compatibility"></a>
### 9.2 仍然有效的技术规格

- [BILL2 技术契约](tasks/V3-BILL-2-provider-authoritative-billing.md)：除第 2.2 节明确取代的预留、结算及超额处理条款外，其余继续有效，包括精确成本、锁序、原子结算、唯一钱路、原请求与未知恢复。契约文件本身由 **BILL-PAYG 实施 PR 同步修改**（[#553 实施交接](https://github.com/Crnobog9527/GraylumAI_vercel/pull/553#issuecomment-5925672087)），本次规划同步不修改该契约文件。
- [V3 标准 Skill 规格](tasks/V3-standard-skills.md)：私有包、固定版本、3 / 6 / 8 步和无步骤 Skill、隔离与恢复（其中"确定性报告"由第 2.1 节第 22 项取代：所有带步骤的 Skill 都改为模型根据全部信息写完整报告、收积分，依据 Owner 2026-09-30 原话"所有带步骤的 Skill，报告都改由模型写、都收积分"，[#545 评论](https://github.com/Crnobog9527/GraylumAI_vercel/pull/545#issuecomment-5912946236)）。
- [OPC 详细架构](tasks/V3-OPC-growth-agent-architecture.md)：业务归属、版本、会话、权限、账务和恢复契约；与本文第 2.2 节冲突的部分以本文为准。
- [FUSION 实施说明](tasks/FUSION.md)：除第 2.2 节列出的整组预扣、估算及对应验收条款外，其余继续有效；规格文件由 **FUSION-REVIEW 实施 PR 同步修改**，FUSION-COMPARE 复用新计费口径。一个运行单、汇总取整和其他不冲突约束保留。
- 第 2.2 节清查表中的其余计费说明，按表内责任任务同步；本次仅修改 MASTER_PLAN.md，不修改被引用的契约、规格或历史验证文件。
- [Master Plan v10.1](Graylum_Master_Plan_v10.1.md)：钱路、认证、安全、年付、退款、cron、完整验收和发布 / 回退要求（其中为保护现网数据而设的部分由第 9.3 节取代，见第 2.2 节）。
- [v10.2 修订](Graylum_Master_Plan_v10.2_OPC_Growth_Agent_Amendment.md)：OPC 产品依据，冲突部分以本文为准。

<a id="acceptance"></a>
### 9.3 验收出口

- v11 §13 的完整验收矩阵继续适用（认证权限、钱路年付退款、BILL2 / Runtime、Skill 与成果、编辑器与资料、后台、支付、集成与社媒、多模型、运维与历史），外加本文第 3.5 节（新交互）、第 4 节（Fusion 的五条底线和计费规则）、第 5 节（上传、删除传播、额度、文风画像冻结与重放）和 DATA-ERASURE（注销与删除）。
- 证据层次：隔离测试验证行为、权限、并发和账务恢复；真实模型质量、真实延迟、供应商协议和真实成本需要各自的 staging 实测证据；没有实测的项目标记为 NOT_RUN，不能当作通过。
- REL-1 发布仍需满足 v11 §13.3 的发布条件（"不能假设现网无用户"以及与旧 runtime 向后兼容、兼容回退的要求除外，见下一条），并另行取得生产批准。
- **正式环境没有真实用户（第 2.1 节第 8 项，Owner 确认的事实）**：取代 v11 §13.3 "不能假设现网无用户"，以及 v10.1 §9、§10 中为保护现网数据而设的要求，包括新旧代码兼容、分步切换、旧数据迁移和针对旧数据的回滚。发布前如果发现正式环境已有真实用户数据，这一条失效，停止发布并请 Owner 重新决定。
- **正式库的建法**：Owner 2026-09-29 已选择 [C3 数据库盘点](evidence/C3-db-inventory-20260929.md)第 5 节的方案 B：数据库结构只由迁移文件决定，`db:push` 退役，`schema.ts` 只作类型参考；由 DB-BASELINE 补齐基线和建库验证。由迁移文件建出结构，再导入配置类数据（例如套餐、模型报价、已发布的 Skill 和模块配置）；不复制 staging 的测试账号、对话、订单、流水、支付沙盒编号和测试窗口。
- **#538 第二轮历史账号 P1 的上线约束**（Owner 2026-10-01，[总控记录](https://github.com/Crnobog9527/GraylumAI_vercel/pull/538#issuecomment-5916532310)）。Owner 原话：

  > 接受 #538 机器人第二轮的 P1：正式库由迁移全新建立、不迁移 staging 测试数据，没有存量领取赠送的账号；staging 测试账号的缺口写进 README，不做回填。

  这项接受仅在正式库由迁移全新建立、不迁移已有用户数据的前提下成立，不是回填问题已修复。**如果以后改为迁移已有用户数据，本次接受失效，必须先补回填再上线**；不能将此接受用于其他防刷缺口。staging 的旧测试账号不做回填，缺口与验收边界已记录在 [PR-E README](../../packages/db/tests/erasure-e-README.md)。
- **仍然保留**：正式环境密钥和配置逐项确认；上线当天有上限的真实小额支付、退款、模型调用和同日对账；AGENTS.md 第 1 节要求的上线前 Owner 明确批准。

<a id="decisions"></a>
## 10. Owner 决定事项

Owner 于 2026-09-27 确认 D1–D17（D6 在 Fable 评估后改为不含 PDF；D13 于 2026-09-28 按 RESEARCH-0 结果修订；D2、D12 于 2026-09-30 修订，同日决定自由对话是否联网由系统判断、不受用户设置限制，见第 2.1 节第 21 项；2026-09-30 的其他决定见第 2.1 节第 22–25 项；2026-10-01 的内容审核暂缓且先留接口、边用边扣和超出冻结额由平台承担见第 2.1 节第 19、26–27 项，模型、8192、邀请、限流、长对话与 q/m 决定见第 13、26–34 项，正式库建库约束见第 9.3 节；2026-10-01—02 的 #561 实测预算批准、保持 hCaptcha、提示缓存必做、Google 账号改密码和 staging 只保留 auth-staging 入口见第 13、24、35–37 项；2026-10-02—03 的导师模型、staging 计费配置、正式环境价格全自动、边用边扣定稿、注销在途收尾顺序、历史缓存、对话原生体验、内容创作对话驱动、钱路线并行、PAY-COMMON 退款衔接、右侧整理方向 B 和封闭内测环境见第 38–49 项）。会员权限和额度是后台可改的默认值，以后调整不需要改规划。

| 编号 | 问题 | 已确认的决定 |
| --- | --- | --- |
| D1 | 上线范围 | 上线包含阶段 0–4（核心体验、上线基础、Fusion、资料库和文风、Waffo 支付）；连接器、社媒同步、Skill 学习的后续阶段、资料库检索和图片音频放到上线后。**2026-10-04 变更**（第 2.1 节第 51 项，[记录 Q](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5980762284)）：多平台发布和数据监控（PUBLISH-MONITOR）提前到上线前，按 Pro/Gold 分档；其余后续阶段不变 |
| D2 | Fusion 计费规则 | 按第 4.4 节：对比模式只对成功返回的模型收费，确认失败不向用户收费，结果未知先保留该模型的预扣；评审模式（2026-09-30 修订，OpenRouter Fusion）每次 Fusion 调用作为一个整体结算：整体成功按官方总成本收费，整体确认失败不向用户收费（供应商仍收费时由平台承担），结果未知冻结这一次调用的预扣、核实后再处理；（仅在 Owner 决定自研时适用：自研方案和对比模式一样逐个模型结算）；评审意见和修订稿记在同一次收费操作里，修订稿失败时只收评审意见的费用。（2026-10-03 注：向用户收费的基准已由第 2.1 节第 41 项改为 BILL-PAYG 名义费用；这里"按官方总成本收费"在 Fusion 上怎么套用，细则随 FUSION-REVIEW 方案定） |
| D3 | 对比模式最多几个模型 | 4 个（后台可调，系统上限 8 个） |
| D4 | 各会员等级的默认权限和资料库额度 | 免费：不能用 Fusion，资料库总空间 50 MB；Pro：不能用 Fusion（2026-10-04 修订，第 2.1 节第 51 项；原为"评审和对比两种模式都能用"），500 MB；Gold：评审和对比两种模式都能用，2 GB。资料库只限制总空间，不限制文件数量；另有一个系统级文件数量保护上限，只防滥用、不作为权益展示。定位档案数：免费 1、Pro 3、Gold 6（2026-10-04，第 2.1 节第 51 项）。后台随时可改 |
| D5 | 用户数据使用同意 | 允许 Graylum 团队查看去除身份信息后的使用记录，用来人工改进产品；默认不参与，用户主动勾选才参与。现在不会用来训练模型，也不会自动修改 Skill。以后改进机制设计出来、用途发生变化时，必须重新征求用户同意。文风画像和个人偏好只服务用户本人，不需要额外同意 |
| D6 | 资料库支持的文件 | 第一版支持 `.txt`、`.md`、`.docx`，单个文件不超过 10 MB；PDF 等其他格式上线后再加 |
| D7 | 删除资料库文档时，已完成的对话回答和已保存成果是否一起清除 | 不自动清除（它们是用户自己的内容，可单独删除），只清除文档和系统派生数据；账号注销时全部清除 |
| D8 | 封闭内测 | **2026-10-03 取消**（第 2.1 节第 50 项）：不做封闭内测，按 D1 范围完成后直接公开上线售卖。原决定：上线基础（N2）完成后先邀请 5–10 位真实用户封闭内测 |
| D9 | 自由对话是否自动整理 | 默认不自动整理；带步骤的 Skill 每轮自动整理。（2026-10-03：方向已由第 2.1 节第 45 项改为用户手动触发"整理纪要"，方案待写；实施前现行行为不变） |
| D10 | 文字确认 | 用户用文字表达的明确同意等同于点击确认，含糊回答不算 |
| D11 | 模型思考强度 | 后台读取每个模型支持的思考档位，管理员按模型和用途自定义（MODEL-REASONING） |
| D12 | Fusion 的来源 | **2026-09-30 修订**：评审模式不联网，只用前面已收集的资料；用 OpenRouter 的 Fusion 服务端工具，放在专用 workspace 里禁用联网工具，实测不通过评审模式保持关闭上线、不做自研（以后是否自研由 Owner 再定）；评审和对比两种模式各有后台总开关，默认关闭；多轮评审和达成共识的流程由 Graylum 控制；对比模式由 Graylum 自己并行调用；两种模式都保留（取代 2026-09-27 的"只用 Graylum 自己开发的 Fusion"，第 4.3 节） |
| D13 | 第三方搜索 | 接入第三方普通搜索和社媒数据 API，同时支持中国和海外平台；统一接口层，方便更换。**2026-09-28 按 RESEARCH-0 结果修订**：社媒数据只用 TikHub，网页搜索用 Parallel，网页抓取用 Firecrawl（取代原先的"多家社媒数据供应商同时启用"和候选名单）；供应商条款必须写明允许商用、允许二次分发给用户使用，并且能提高并发；三家的公开条款都没有完全写明第一条，Owner 决定等网站用户使用量大了再申请企业定制授权，在此之前按公开条款使用（第 3.7 节）。**2026-10-04 补充**：Bright Data 作为备用渠道（主要海外平台），Facebook 由它抓取，取代"每类一家、没有备用"（第 2.1 节第 52 项） |
| D14 | 搜索费用 | 用户承担，所有计价先换成美元；官方用量、自家点数按冻结单价换算，按次线路按官方单价；TikHub 官方标价计成本、阶梯折扣归平台。2026-10-01 取代固定保底积分直扣，按第 32–34 项与 D16 统一计算；搜索前不预告，限制次数、展示每次扣费，低于 L 时提示充值 |
| D15 | 对标研究 | 只基于真实取到的数据，禁止编造；指标由代码计算，表格数字只能由取数结果填入；取不到数据就明说，不给示例账号（第 3.7 节） |
| D16 | 收费公式（2026-10-01 修订） | 应收 `C = ceil(q × Σ(U_i × m_i))`；所有成本先换美元，q=100、默认 m=3（2026-10-03 改为默认 m=6，第 2.1 节第 50 项），模型/线路未设置倍数才用默认值；调用冻结有效倍数，旧执行不重算，最终只进位一次；实际扣费按余额封顶（第 26、32–34 项），固定保底积分直扣已被取代 |
| D17 | 支付渠道 | 新销售默认走 Waffo，Stripe 作为备用渠道保留；备用是管理员在后台手动切换"新购买使用的渠道"，不做自动切换；同一笔订单不跨渠道重试，付款结果未知时不换渠道再扣；已成交订单的续费、退款和凭证始终走原渠道（2026-10-03：上线只用 Waffo 收款，Stripe 不作为上线收款渠道，手动开关只作备用，第 2.1 节第 50 项） |

**2026-09-28—30 的新决定**记在第 2.1 节第 13–25 项；2026-10-01—03 的记在第 26–50 项；2026-10-04 的定价和付费墙细则记在第 51 项。

**待 Owner 确认或批准执行的事项**（q=100、默认 m=6（第 50 项）、正式运营升级 Pro 已定，不重复请求产品定案）：

| 事项 | 现状 | 何时需要定案 |
| --- | --- | --- |
| MODERATION 正式实现时间 | Owner 2026-10-01 决定暂缓，只留接口；MODERATION-HOOK 随 RATE-LIMIT 接线默认放行，不作为已实现内容审核（第 19 项及[总控记录](https://github.com/Crnobog9527/GraylumAI_vercel/pull/566#issuecomment-5930126786)） | 公开上线前再请 Owner 决定；不阻塞封闭内测 |
| 正式环境是否强制"数据不用于训练"（RUNTIME-PROD 第 ⑦ 项、第 2.1 节第 9 项的举例、VOICE 的前置条件） | Owner 2026-09-28 表示，除非违反 GDPR 等法律，请求不需要强制 `data_collection: deny`；合法性尚未核实，规划里仍是"强制" | RUNTIME-PROD 开工前 |
| 删除规则 E5"付费默认不退款、Owner 逐笔批准手动退款"（2026-10-05 已由第 51 项退款规则取代，[记录 Y](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5982111397)）与现有退款代码和 v11 退款规则（REFUND-1B 等）的衔接 | **已定**（Owner 2026-10-03，第 2.1 节第 47 项）：PAY-COMMON 方案 #608 第 8 节 P1；退款功能按 PAY-COMMON 实施调整；2026-10-05 起退款规则按第 51 项（记录 Y、AA），积分包退款的执行能力已纳入 [PAY-COMMON 实施说明](tasks/PAY-COMMON.md) PR-4 | 已定；实施随 PAY-COMMON PR-4 |
| staging 服务商回调地址（2026-10-01） | 旧域名已删除（第 37 项）；Stripe / Waffo 沙箱回调和 Supabase Site URL 待 Owner 自行检查确认 | 支付或邮件回调相关的 staging 验证前（建议） |
| 上线前配置与产品数值复核（2026-10-01，2026-10-03 更新） | 正式环境 Upstash 上线前配置，Vercel Pro 已决定升级但仍待执行；staging 的 q=100/m=3 已按 Owner 批准修改（第 39 项）；套餐价格和每月积分已定（Pro $29 / 3,480、Gold $69 / 8,970，年付 $279 / $621，第 51 项），积分包比例已定（第 50 项），需要单独批准的只是实际写入配置；积分包会员折扣已定（Pro 9.5 折、Gold 9 折，第 51 项）；开户赠送 500 积分和积分包三档已先定（第 51 项，实测后可能调整），邀请奖励 50/30 按 m=6 复核 | 具体执行前批准；上线前完成（第 7.6 节） |
| 对话原生体验的续写次数（2026-10-03） | #604 方案第一版推荐每次回答最多自动续写 3 次、单次上限保持 8192；方案还在审查 | #604 审查干净后由总控交 Owner |
| 付费墙视觉风格（2026-10-04） | Owner 认为原来 8 个界面的视觉要改，已自行调整并定稿（[记录 N](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5972956845)）；Owner 定稿的 v25 已于 2026-10-04 导出入库（[`docs/launch/design/paywall/`](design/paywall/README.md)，第 51 项） | 已定稿入库；README 列出的待定事项在 PAYWALL 实施时逐项定 |
| 定价占位值（2026-10-04） | 注册赠送 500 积分、积分包三档和会员价已先定（第 51 项，[记录 S](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5980831854)、[记录 T](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5980843167)），实测后可能调整；只剩创始人寄语待定 | 寄语由 Owner 定；赠送和积分包的配置写入（含 0151 的 high 迁移）执行前批准 |
| Pro 中途升 Gold 的收费规则（2026-10-04） | **已定**（[记录 U](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5980903324)、[记录 Q](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5980762284)）：不退差价，补发 8,970 积分并立即升级为 Gold 权益（第 51 项） | 已定（含计费周期，[记录 U](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5980903324)）；PAY-WAFFO 按此实施 |
| 工作室版价格和权益（2026-10-04） | 上线只放"联系我们"；10 个品牌起、5 位成员起，可以按需增加席位；不定公开价格，按用量报价（[记录 Q](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5980762284)）；团队功能的具体权益未定 | 开发团队功能时 |
| 限流是否按档位放宽（待观察，2026-10-04） | 每天 200 条新消息、600 次调用，所有档位一样；可能卡住重度付费用户（[记录 B](https://github.com/Crnobog9527/GraylumAI_vercel/pull/618#issuecomment-5971895597)） | 上线后看数据再定，现在不改 |

<a id="documents"></a><a id="cutover"></a><a id="sources"></a>
## 11. 文档地图

| 文档 | 用途 |
| --- | --- |
| [START_HERE](START_HERE.md) | 入口导航 |
| 本文 | 唯一的当前规划：产品、现状、顺序、技术债、待决事项 |
| [AGENTS.md](../../AGENTS.md) | 仓库规则：权限、风险、审查、合并 |
| [docs/ENGINEERING.md](../ENGINEERING.md) | 工程规范：技术栈、代码组织、大小限制、测试命令 |
| [v11](Graylum_Master_Plan_v11.md)、[v10.2](Graylum_Master_Plan_v10.2_OPC_Growth_Agent_Amendment.md)、[v10.1](Graylum_Master_Plan_v10.1.md) | 历史版本；仍有效的部分见第 9 节 |
| [AGENT-CORE](tasks/AGENT-CORE.md)、[FUSION](tasks/FUSION.md)、[LIB-DOCS 与 VOICE](tasks/LIBRARY-VOICE.md)、[DATA-ERASURE](tasks/DATA-ERASURE.md)、[RESEARCH-TOOLS](tasks/RESEARCH-TOOLS.md) 实施说明 | 实现机制、未定案的设计选择、开工前必读章节和必测项（含规划审查中 Codex 和 Fable 提出的全部意见） |
| [plan-core](plan-core.md)、[OPC 实施映射](tasks/V3-OPC-implementation.md) | 历史任务表和映射，保留原任务编号和技术验收 |
| `tasks/` 下其他规格 | 技术附录，见第 9.2 节 |
| 2026-10-01—03 合并的实施方案（[PROMPT-CACHE](PROMPT_CACHE_PLAN.md)、[PROMPT-CACHE-HISTORY](PROMPT_CACHE_HISTORY_PLAN.md)、[RATE-LIMIT 接线](RATE_LIMIT_WIRING_PLAN.md)、[MODEL-PRICING-SYNC](MODEL_PRICING_SYNC_PLAN.md)、[右侧整理方向 B](CONVERSATION_CAPTURE_PLAN.md)、[注销在途收尾](../plans/DATA-ERASURE-INFLIGHT-RECOVERY.md)、[PAY-COMMON](tasks/PAY-COMMON.md)） | 各任务的实施依据；与本文冲突时以本文第 2 节的 Owner 决定为准 |
| [docs/archive/](../archive/README.md) | 已归档的 2026 年 1 月旧计划、旧设计和旧开发规范 |

本版依据：Owner 的决定（第 2.1、10 节；D13 的 2026-09-28 修订依据 RESEARCH-0 的 #457、#465、#466）；Fable 5.1 的独立评估（PR #448 评论）；2026-09-27 对 staging `d2b42e72` 的代码核实；GitHub 上 PR #422、#434–#447 的实时状态；OpenRouter、Supabase、OpenAI 官方文档和价格页面（2026-09-27 读取）。2026-09-29 进度同步依据：staging `1cf461c1` 和 GitHub 上 #446—#510 的实时状态，以及各 PR 评论中记录的 Owner 原话。2026-09-30 进度同步依据：staging `91a90e39` 的 git log（#511—#536、#541）、在途 PR #497、#537—#540、#542、#543 的实时状态，以及 #497、#541、#542、#543 中记录的 Owner 原话。

2026-10-01 增量同步依据：staging `0470e7a7`、GitHub PR 实时状态，以及第 2.1、7.0、9.3 节所链接的总控记录；#545 已写入的报告范围、收费 / 预告决定和 AC-3 分工继续保留，计费模式按第 26–27 项更新。

2026-10-01 PLAN-SYNC-1001B 依据：staging `da4aa6be` 的合并日志、第 2.1 节逐条链接的来源评论。第 31 项是总控依据 Owner 2026-10-01 在总控窗口的讨论定下的技术原则，记录见[链接](https://github.com/Crnobog9527/GraylumAI_vercel/pull/497#issuecomment-5926388706)；没有可引用的 Owner 原话。

2026-10-03 MASTER-PLAN-SYNC 依据：staging `1563a44d` 的合并日志（#570—#615）、`gh pr list --state open` 实时结果、各 PR 上的总控合并和迁移应用记录，以及第 2.1 节第 38–48 项逐条链接的 Owner 原话。Owner 原话均来自总控在 PR 评论里的记录（总控窗口本身不在 GitHub 上）；本次没有连接数据库或外部服务。
