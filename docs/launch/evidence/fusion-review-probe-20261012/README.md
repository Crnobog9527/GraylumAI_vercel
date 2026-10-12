# FUSION-REVIEW 开工前实测（2026-10-12）

> 状态：实测记录，仅文档和脚本，不是产品代码。已包含 Owner 建好评审专用 workspace 之后的补测（第 1.1 节）。
> 依据：[Master Plan 第 4.3 节](../../MASTER_PLAN.md#fusion)（开工前必须实测的五项）、[FUSION 实施说明](../../tasks/FUSION.md)、
> Owner 2026-09-30 决定（评审不联网；首选 OpenRouter Fusion 并禁联网，先实测）。
> 测试账号：现有 OpenRouter 测试密钥（staging 测试预算），以及 Owner 新建的评审专用 workspace 的密钥。本任务上限 2 美元，**实际花费约 0.63 美元（旧测试密钥 0.62、专用 workspace 0.01）**。
> 后台设置由 Owner 本人操作，我没有改 OpenRouter 后台，也没有碰正式环境。

## 先说结论（给 Owner 的大白话）

1. **Fusion 没法在不联网的情况下工作，按 Master Plan 第 4.3 节算"实测不通过"。**
   - 在原来的账号里，我在请求层面试了四种办法：
     - 把内部步数上限设成最小值 1
     - 提示词写"不要联网"
     - 请求里加数据设置 `deny`
     - 把搜索域名限制成不存在的域名

     四种都关不掉，评审团每次照样联网，返回 5–6 个网页引用。
   - Owner 新建了评审专用 workspace，在 Tools 页面把 Web Search 和 Web Fetch 关掉，Fusion 保持开启。补测结果：3/3 次评审团的每个模型都被拒绝（403，"web_search 被本 workspace 的策略禁止"），整次 Fusion 失败（`all_panels_failed`）。
   - 原因：Fusion 给每个评审模型的请求固定带着联网工具，联网一关，评审团就一个也跑不起来。
   - 这种情况下，普通对话接口仍然返回"成功"：外层模型自己写了一份评审冒充，费用只有约 0.003 美元。
2. **就算不看联网，Fusion 还有三个硬伤：**
   - 看不到评审团各自联网了几次。用量里只有"调用了 1 次 Fusion"，没有每个模型的搜索次数，所以 Master Plan 要求的"`web_search_requests` 为 0"没法直接证明。
   - 只有整次的总费用，拆不到每个模型。
   - 普通对话接口（Chat Completions）看不到 Fusion 的原始结果。评审团配置错了时，外层模型会悄悄自己写一份评审，接口照样返回成功。要改用 Responses 接口，才能看到每个模型的回答和失败原因。
3. **能用的部分：**
   - 评审团拿到的是完整报告：原文最后一段的暗号，15/15 次都被照抄出来。
   - 系统提示也能传到评审团模型。
   - 强模型评审团（Opus、GPT、Gemini Pro）一次只要 56 秒、约 0.14 美元，三个模型都按格式输出。
4. **"全文 + 各步骤字段值"一次输出（R14 要的格式）可以稳定拿到：**
   - 汇总模型用 JSON schema 严格模式或分隔符格式，14/14 次结构完整、字段齐全。
   - 但 Sonnet 有 3/4 次删掉了原文的"结语"段，需要宿主在拿到结果后检查章节是否齐全。
5. **我的建议：评审改为自研（Graylum 自己并行调多个模型），复用 FUSION-COMPARE 本来就要做的多模型并行能力。**
   - Master Plan 第 4.3 节写的是"实测不通过就保持关闭，以后是否自研由 Owner 再定"，所以改走自研需要 Owner 点头。
   - 按第 4.3 节原文，在 Owner 决定之前，评审模式保持关闭，定位分析以报告 v1 结束。
   - 请 Owner 二选一：
     - A（推荐）：「同意评审团改为自研，复用对比模式的多模型并行能力。」
     - B：「评审模式先关着上线，以后再定。」

## 1. 测了什么、结果如何

所有原始记录在 `runs/`（已清除账号标识）。报告是合成样例 `sample-report.md`，不含真实用户数据。
除"默认评审团"一项外，都用便宜模型：评审团 Claude Haiku 5.5、DeepSeek V3.2、Qwen 3.8 Flash；分析模型和外层模型都是 Haiku 5.5。

| # | Master Plan 4.3 要求 | 测法 | 结果 |
|---|---|---|---|
| 1 | 禁用联网是否生效 | ① 基线：`max_tool_calls: 1` + 提示词禁止联网（`runs/baseline-1.json`）② 请求加 `provider.data_collection: deny`（`deny-1.json`）③ 请求里同时声明 `openrouter:web_search`，`allowed_domains` 设成不存在的域名（`web_blocked_domain-1.json`） | **不通过**。现有 workspace：三次分别返回 6、5、5 个网页引用，说明内部发生了搜索；用量只有 `server_tool_use_details.tool_calls_requested: 1`，没有内部搜索次数。专用 workspace 关掉联网工具后：评审团全部 403，Fusion 整体失败（见第 1.1 节） |
| 2 | 评审团是否拿到完整原文、是否按评审提示词评审 | 原文最后一段放暗号，要求每个模型照抄；系统提示里放"看得到就多加一条"的检查句 | **通过**。暗号 15/15 被照抄；系统提示检查句在 Haiku、DeepSeek 上生效。注意：评审团收到的是外层模型写的工具调用参数，接口里看不到这段参数，只能用暗号间接证明 |
| 3 | 费用是每个模型分开还是只有总数 | 看返回的 `usage` 和 `/generation` | **只有总数**。`usage.cost` 是整次费用（含评审团和分析模型），`cost_details.upstream_inference_cost` 只是外层模型那一部分。`/generation` 查询外层请求时费用为 0，没有内部各模型的明细 |
| 4 | `data_collection: deny` 是否作用到评审团 | 请求带 `deny` 能正常返回 | **无法证明**。请求被接受，但接口不回传内部调用走了哪家供应商，也不回传数据政策 |
| 5 | 适配器兼容性（拒绝 `openrouter/` 元模型、要求返回模型等于请求模型） | 看返回的 `model` 字段 | Fusion 是工具不是元模型，外层返回的 `model` 等于请求的模型（`anthropic/claude-haiku-5.5`），这两条检查不冲突。另外：外层用 Sonnet 5.5 时 Responses 接口返回 400（`responses-default_panel-sonnet-outer-400.json`），外层模型要逐个实测 |

### 1.1 专用 workspace 补测（Owner 在 Tools 页面关掉 Web Search 和 Web Fetch）

| 记录 | 接口 | 结果 |
|---|---|---|
| `runs/responses-ok-ws1.json` | Responses | 11 秒返回。Fusion 输出项 `failure_reason: all_panels_failed`，`failed_models` 里 3 个模型的错误都是 403：`Tool 'openrouter:web_search' is blocked by this workspace's server tool policy`。外层模型如实说明评审团失败 |
| `runs/baseline-ws1.json` | Chat Completions 流式 | 20 秒返回 HTTP 200，0 个网页引用，没有 "Panel responses"。内容是外层模型自己写的意见清单，调用方看不出 Fusion 失败 |
| `runs/ask_search-ws1.json` | Chat Completions，明确要求评审团联网并附来源 | 同上：21 秒、0 个引用、Fusion 失败、外层模型自己写 |
| `runs/summarize-schema-haiku-ws1.json` | 汇总调用（不带工具） | 2/2 结构完整；汇总调用不受联网开关影响 |

结论：

- 联网确实关得掉，但关掉后 Fusion 的评审团不能运行。所以"Fusion + 不联网"这个组合不存在。
- 文档写的是"评审团和分析模型固定开启联网"，这次实测证实：关不掉，只能整体拒绝。
- 除非 OpenRouter 以后提供"Fusion 内部不带联网工具"的选项，否则 Fusion 不能满足 D12。

## 2. 格式稳定性、耗时、费用、失败表现

### 输出格式

| 项目 | 结果 |
|---|---|
| Fusion 原始结果（Responses 接口的 `openrouter:fusion` 输出项） | 4/4 次都有 `responses`（每个模型一段）和 `analysis`（consensus / contradictions / partial_coverage / unique_insights / blind_spots 五栏），和官方文档一致 |
| 评审团各模型的 JSON 意见清单能否直接解析 | 便宜模型 7/12：DeepSeek 4/4、Haiku 2/4、Qwen Flash 0/4（多出代码框外文字或字段写坏）。强模型 3/3（Opus、GPT、Gemini Pro） |
| Chat Completions 接口 | 拿不到工具原始结果，只有外层模型写的文字（标题是 "Panel responses / Analysis"，结构由外层模型自己决定，不能当作稳定格式） |

结论：要用 Fusion，就只能用 Responses 接口；评审团模型选强模型，宿主对每份意见做宽松解析，解析失败就当作这个模型没有给出可用意见。

### 耗时

| 场景 | 耗时 |
|---|---|
| 强模型评审团（Responses） | 56 秒 |
| 便宜评审团（Responses，4 次） | 163–204 秒 |
| 便宜评审团（Chat Completions 流式，3 次） | 257–394 秒，期间只有 `: OPENROUTER PROCESSING` 心跳，最后几秒才一次性吐出结果 |
| Chat Completions 非流式 | 300 秒还没返回，客户端中止（`baseline-nonstream-timeout.json`），已收费约 0.017 美元 |

便宜评审团反而更慢，原因没查清；可能是它们联网搜索和抓取的步骤更多（引用都出现在便宜评审团的结果里），也可能是这几家供应商本身慢。

测试从本机经代理发出，到美国服务器的时间会略短，但模型和联网耗时占大头。

### 费用（`usage.cost`，单次评审一轮）

| 场景 | 费用 |
|---|---|
| 便宜评审团 | 0.015–0.044 美元 |
| 强模型默认评审团（Opus、GPT、Gemini Pro，分析模型 Sonnet 5.5） | 0.138 美元 |

样例报告只有约 1000 字。正式报告上限 12000 字，加上 Skill 和资料，每个模型的输入会大约翻 10 倍。按强模型粗估，一轮评审约 0.5–1 美元；这只是推算，没实测。

### 失败表现

| 场景 | 表现 |
|---|---|
| 评审团里有不存在的模型 | 不是"部分失败"，而是整次 Fusion 报 `failure_reason: invalid_model`，约 18 秒返回 |
| 评审团全部不存在 | 同上 |
| 上面两种情况在 Chat Completions 接口下 | HTTP 200，外层模型自己写了一份评审，**调用方看不出 Fusion 失败了** |
| 客户端 20 秒中止（Responses，`responses-client_timeout-1.json`） | 没拿到结果，也没拿到请求编号，仍收费约 0.003 美元。说明已经跑掉的部分照样收费，结果却无法事后对账 |

## 3. "全文 + 各步骤字段值"格式（AGENT-CORE R14，总控补充要求）

汇总模型单独调用（不带工具），输入原报告和合并后的评审意见，要求同时输出修订后全文和 6 个步骤、共 11 个字段的建议值。
步骤和字段是合成的，见 `summarize.mjs`。

| 模型 | 方式 | 结构完整（全文 + 每步 + 每字段） | 其他 |
|---|---|---|---|
| Claude Haiku 5.5 | JSON schema 严格模式 | 5/5 | 每次约 23 秒、0.003 美元 |
| Claude Haiku 5.5 | 分隔符 `<<<REPORT>>>` / `<<<FIELDS>>>` + JSON | 5/5 | 每次约 26 秒 |
| Claude Sonnet 5.5 | JSON schema 严格模式 | 2/2 | 1/2 删掉了原文"结语"段 |
| Claude Sonnet 5.5 | 分隔符 | 2/2 | 2/2 删掉了"结语"段 |

结论：

- 可以稳定拿到，推荐 JSON schema 严格模式。
- 宿主要检查两件事：模板章节是否都在；每个步骤的字段是否齐全。缺了就当作这次修订失败，不能静默接受。
- 全文和字段值大部分内容是重复的，输出 token 大约是只出全文的 1.5–2 倍。按 12000 字的报告估算，汇总这一步的回答长度上限要按"全文 + 字段"一起设定，并纳入 BILL-PAYG 的单次上界。

## 4. 推荐：Fusion 还是自研

**推荐自研，复用 FUSION-COMPARE 的多模型并行能力。** 补测之后，Fusion 已经不是备选：一关联网它就跑不起来。理由：

1. **"不联网"能证明。** 自研时每个评审调用都由宿主发出，不带任何工具，从请求本身就能证明不联网。Fusion 的评审团固定带联网工具，在专用 workspace 里关掉联网后它直接失败（第 1.1 节）。
2. **计费符合 D2 原规则。** 自研时每个模型单独结算：成功收费、确认失败不收、结果未知只冻结这一个模型。Fusion 只有整次总费用，Master Plan 只好为它另写一套整体结算规则。
3. **失败看得见。** Fusion 配错一个模型就整次失败；Chat Completions 下失败还会被外层模型掩盖；客户端超时会收费却没有编号可以对账。
4. **多出来的工作量不大。** FUSION-COMPARE 本来就要做"多个模型并行、一个运行单、部分结算"。评审自研只是在这个基础上加一个汇总调用和轮数控制。
5. **Fusion 的优点**是一次请求完成，自带结构化分析，强模型评审团 56 秒。这些自研也能做到：并行调用加一次汇总，耗时取决于最慢的那个模型。

如果 Owner 愿意放宽 D12、允许评审联网，Fusion 才能用。最低条件：

- 改用 Responses 接口；
- 只用强模型评审团；
- 接受"联网次数和单个模型费用看不到"和"超时后不能对账"这两个限制。

这属于推翻已有的产品决定，要 Owner 明确同意。

## 5. 顺带发现的问题（不在本任务范围，记下来交总控）

1. **已发布的定位 Skill 和"评审不联网"的决定冲突。** staging 上已发布的定位 Skill 第 12 版里，`references/review-rubric.md` 写着评审团可以联网核对，和 D12"评审不联网"相反。评审功能开工前要改这份 Skill。
2. **ENGINEERING.md 和 Master Plan 第 4.3 节说法相反。** `docs/ENGINEERING.md` 第 6 节写"多模型由 Graylum 自己并行调用、不使用 `openrouter/` 元模型"，与第 4.3 节"首选 OpenRouter Fusion"相反。FUSION.md 已注明：采用 Fusion 时才改 ENGINEERING.md（改规则文件要 Owner 批准）。如果最后选自研，两边就一致了，只需同步 Master Plan 第 4.3 节。
3. **外层模型用 Sonnet 5.5 调 Fusion（Responses 接口）返回 400。** 采用 Fusion 时，外层模型要逐个实测。

## 6. 怎么复跑

```bash
cd docs/launch/evidence/fusion-review-probe-20261012
NODE_USE_ENV_PROXY=1 node responses.mjs ok 5            # Responses 接口一次评审
NODE_USE_ENV_PROXY=1 node probe.mjs baseline 2          # Chat Completions 流式
NODE_USE_ENV_PROXY=1 node summarize.mjs schema anthropic/claude-haiku-5.5 3
node sanitize.mjs                                       # 提交前清除账号标识
```

换成评审专用 workspace 的密钥：在命令前加 `PROBE_KEY_FILE=fusion-review.env PROBE_KEY_VAR=OPENROUTER_API_KEY`。`probe.mjs ask_search` 会明确要求评审团联网，用来检验关闭是否生效。

在中国大陆的网络下，Anthropic 模型会被地区限制拦住，所以要设 `NODE_USE_ENV_PROXY=1`，让 Node 走本机代理。
