# 多模型并行：开源调研与拆分建议（FUSION-REVIEW / FUSION-COMPARE，2026-10-12）

> 状态：调研记录，不写产品代码，没有调用付费模型。第 4 节的拆分只是**建议**，Owner 和总控还没确认，不是正式规格；确认后由总控写进正式任务文档。
> Owner 的"自研"决定由 #848 写进 Master Plan 第 2.1 节；在它合并之前，Master Plan 第 4.3 节原来的写法（OpenRouter Fusion、实测不通过就不做自研）已经被这个决定取代。
> 起因：Owner 2026-10-12 决定评审团改为自研，并复用对比模式的多模型并行能力。Owner 原话：
> "同意评审团改为自研，复用对比模式的多模型并行能力，但是在这个做之前，要先调研一下 GitHub 上有没有成熟的开源项目的架构，
> 能直接实现的就不要自己造轮子，目前我发现的这种 AI 应用里面，有一家是已经实现了这个功能：flowith.io 。"
> 依据：[Master Plan 第 4 节](../MASTER_PLAN.md#fusion)、[FUSION 实施说明](../tasks/FUSION.md)、
> [BILL2 技术契约](../tasks/V3-BILL-2-provider-authoritative-billing.md)，以及 Fusion 实测结论（PR #852）。
> 本文的 GitHub 数据（stars、许可证、最近提交）于 2026-10-12 用 `gh api` 读取；关键源码文件都实际读过。

## 先说结论（给 Owner 的大白话）

1. **没有能直接装上就用的现成库。** 成熟的开源实现要么是 Python 写的，要么和它们自己的数据结构、界面框架绑在一起。
2. **最值得参考的是 big-AGI 的 "Beam" 功能。**
   - 它用 MIT 许可证，可以商用、可以闭源，技术栈和我们几乎一样（Next.js + tRPC 11 + TypeScript）。
   - 它是"同一个问题并行发给多个模型，每列各自流式显示，再选一种方式合并"，正是我们对比模式加评审模式要的东西。
   - 但它的调度全在浏览器里跑，而且没有"先冻结积分、再按实际费用结算"的计费。所以只能**照着它的设计写，个别小段可以拷过来改**（要保留它的版权声明），没法直接接进来。
3. **flowith 的做法**：
   - 画布上一问一答是一个节点，可以批量生成多份结果再挑。
   - **没有自动"合并评审"这一步**，要用户自己选几个节点再让模型汇总。
   - 怎么扣积分，公开资料里没写。
   - 它不开源。我们的评审模式（多模型出意见、汇总模型写修订稿、多轮直到没有关键意见）比它多走了一步。
4. **真正要自己写的是"钱"和"会话"这两块**，开源项目都没有，也不能借：
   - 我们现在的计费规定"一个运行单只能挂一个执行""上一次调用没结算，下一次就不能开始"，代码里明确禁止并行。
   - 要改成"一组模型一个运行单、各模型同时冻结、各自结算、某个模型结果不明时其他照常结算"。
   - 这是高风险改动，要带数据库迁移。
5. **建议拆成 7 个 PR**：先做两块共用底座（计费、附属会话），再做共用的并行执行，然后对比模式、评审模式各自的界面和流程。其中 3 个是高风险（带迁移或碰计费）。具体见第 4 节。

## 1. 开源项目对比

| 项目 | 许可证 | 能否闭源商用 | stars | 最近提交 | 技术栈 | 并行、流式、失败、费用 | 合并方式 | 对我们 |
|---|---|---|---|---|---|---|---|---|
| [enricoros/big-AGI](https://github.com/enricoros/big-AGI)（Beam） | MIT | ✅ | 7,142 | 2026-10-12 | Next.js 15 + tRPC 11 + React + zustand | 每列独立流式，各有停止按钮；状态分 空 / 生成中 / 成功 / 停止 / 出错；出错的不参与合并；每次生成都在客户端按价目表估算费用 | 四种：直接融合、先列清单让用户勾选再合并、按维度打分对比、自定义提示词 | **最接近。只借设计，个别小段拷来改** |
| [LibreChat](https://github.com/LibreChat-AI/LibreChat) | MIT | ✅ | 45,573 | 2026-10-06 | Node/Express + React | 主模型和附加模型并行；分列显示；每次调用都记账扣余额（事后扣，不是先冻结）；附加模型出错不影响主模型 | 无 | 借鉴"分列显示 + 每次调用单独记账" |
| [togethercomputer/MoA](https://github.com/togethercomputer/MoA) | Apache-2.0 | ✅ | 2,982 | 2025-01-07 | Python | 并行；只有汇总那一步流式；限流时退避重试；不统计费用 | 一个汇总模型批判性地合成答案，可以叠多层 | 借鉴汇总提示词（Open WebUI 也用这一份） |
| [karpathy/llm-council](https://github.com/karpathy/llm-council) | **没有许可证文件** | ❌ 不能拷代码 | 25,384 | 2025-11-22 | Python + React，走 OpenRouter | 并行；不流式；出错直接丢掉；不统计费用 | 先各自回答，再匿名互评排名，最后由主席模型汇总 | 只借思路：评审时隐藏模型身份、要求机器可解析的固定格式 |
| [Skytliang/Multi-Agents-Debate](https://github.com/Skytliang/Multi-Agents-Debate) | GPL-3.0 | ❌ | 616 | 2025-12-16 | Python | 串行 | 主持人每轮输出 JSON 判断"还要不要继续辩" | 只借思路：每轮判断是否提前停止 |
| [thunlp/ChatEval](https://github.com/thunlp/ChatEval) | Apache-2.0 | ✅ | 343 | 2024-10-19 | Python | 发言顺序可以是串行、并发或随机 | 多个裁判辩论后打分 | 已停更，仅参考 |
| [open-webui/open-webui](https://github.com/open-webui/open-webui) | Open WebUI License（要求保留品牌） | ⚠️ 不适合拷进我们的产品 | 154,485 | 2026-10-10 | Python + Svelte | 后端把一个请求分发给多个模型；分列显示 | "合并回答"，用的是 MoA 提示词 | 只看设计 |
| [lobehub/lobehub](https://github.com/lobehub/lobehub) | LobeHub Community License | ⚠️ 做衍生作品要另买商业授权 | 83,166 | 2026-10-12 | Next.js | 没找到并列对比功能（未核实） | — | 不用 |
| [chathub-dev/chathub](https://github.com/chathub-dev/chathub) | GPL-3.0 | ❌ | 10,659 | 2026-02-27 | 浏览器扩展 | 2/3/4/6 格并列布局 | 无 | 只看界面布局 |
| [lm-sys/FastChat](https://github.com/lm-sys/FastChat)（Arena） | Apache-2.0 | ✅ | 39,553 | 2025-06-02 | Python + Gradio | 固定两路，轮流推进（不是真并发） | 用户投票 | 仅参考"盲测" |
| [langchain.js](https://github.com/langchain-ai/langchainjs)（RunnableParallel） | MIT | ✅ | 18,257 | 2026-10-12 | TypeScript | 一路出错整体失败 | — | 不适合：我们要一路出错不影响别的路 |
| [vercel/ai](https://github.com/vercel/ai)、[OpenRouter TS SDK](https://github.com/OpenRouterTeam/typescript-sdk) | Apache-2.0 | ✅ | 27,271 / 263 | 2026-10-10 / 2026-10-11 | TypeScript | 没有专门的多模型并行工具 | — | 不为这个功能新增依赖；现有的 openai SDK 已经能调 OpenRouter |

关键源码（已读）：

**big-AGI**
- [beam.scatter.ts](https://github.com/enricoros/big-AGI/blob/main/src/modules/beam/scatter/beam.scatter.ts)：每列一个 AbortController，有状态机；列多时降低刷新频率。
- [beam.gather.inputs.ts](https://github.com/enricoros/big-AGI/blob/main/src/modules/beam/gather/beam.gather.inputs.ts)：只合并已经成功的列；也可以"现在就合并"，不等还没跑完的列。
- [beam.gather.factories.ts](https://github.com/enricoros/big-AGI/blob/main/src/modules/beam/gather/instructions/beam.gather.factories.ts)：四种合并方式。
- [aix.client.ts](https://github.com/enricoros/big-AGI/blob/main/src/modules/aix/client/aix.client.ts) 第 738–752 行：费用估算。

**LibreChat**
- [addedConvo.js](https://github.com/LibreChat-AI/LibreChat/blob/main/api/server/services/Endpoints/agents/addedConvo.js)
- [ParallelContent.tsx](https://github.com/LibreChat-AI/LibreChat/blob/main/client/src/components/Chat/Messages/Content/ParallelContent.tsx)
- [usage.ts](https://github.com/LibreChat-AI/LibreChat/blob/main/packages/api/src/agents/usage.ts)

**MoA**
- [moa.py](https://github.com/togethercomputer/MoA/blob/main/moa.py)

**llm-council**
- [backend/council.py](https://github.com/karpathy/llm-council/blob/master/backend/council.py)

## 2. flowith.io（只看了公开页面）

- **是否开源**：产品不开源。官方 GitHub 组织 `flowith-ai` 下只有一个 MIT 许可的命令行客户端 [canvas-cowork](https://github.com/flowith-ai/canvas-cowork)。
- **交互**：
  - 二维画布，一问一答是一个节点，可以分叉。
  - [官方文档](https://flowith.io/docs/en/canvas/landing/)里的 "Batch Generation / Execution Multiplier" 能一次并行生成多份结果，用来并排比较。
  - 图片、视频工具可以在同一画布上同时跑多个模型。
- **能不能一次勾选多个文本模型回答同一个问题**：官方文档没写，**未核实**。有第三方评测说可以并排比 Claude、GPT、Gemini，但这些文章带推广性质。
- **合并**：没有自动合并或评审。用户手动选中多个节点，用 "Quote First" 引用，或者把节点编组合并上下文，再自己写提示词让模型汇总（见 [节点交互文档](https://flowith.io/docs/en/canvas/node-interaction)）。
- **计费**：
  - [定价页](https://flowith.io/pricing/)（2026-10-12）按月卖积分。
  - Pro 19.9 美元，积分数页面前后写法不一致：一处 2 万，一处 2.2 万。
  - Ultimate 49.9 美元，5 万积分；Infinite 499.9 美元，50 万积分。
  - 有并发上限：Pro 50，Ultimate 100。
  - "多个输出各扣一次积分"还是别的算法，**没找到公开资料**。
- **对我们的启发**：
  - 对比模式的形态和它的批量生成接近。
  - 评审模式的"自动合并 + 多轮直到没有关键意见"是我们多出来的一步，可以作为差异点。

## 3. 能直接用、只能借鉴、必须自己写

### 3.1 能直接用：没有现成库，只有我们自己已有的部分

下面这些是仓库里已经有、可以直接复用的，文件位置以 staging 为准：

| 已有能力 | 位置 |
|---|---|
| 每次调用单独冻结、单独结算 | `bill2_calls.pre_deduct_id`、`reserved_credits`、`settled_at`（迁移 0162；冻结在 `0180_payg_threshold_auto.sql` 第 119–124 行） |
| 按余额封顶冻结；余额不足时停下等充值 | 0180 第 81–119 行 |
| 单次调用确认失败、结果未知时对账 | `bill2/service.ts` 里的 `recoverReceipts`，以及 `billing-reconcile` 定时任务 |
| 一个运行单的调用策略本来就能登记多个模型 | `bill2/service.ts` 第 28 行，最多 32 条 |
| 单次费用上界、按模型上下文窗口截断 | `runtime/paygRuntime.ts` 第 26–97 行 |
| 前端流式事件的读取函数，和具体执行无关，一列一个实例即可 | `positioning/[draftId]/mentor-turn.ts` 里的 `readAgentTurn` |
| 会员权限的预检（只用于提前给出提示，不是准入凭证），已写好但还没有任何地方调用 | `services/membershipEntitlements.ts` 第 85 行的 `assertFusionEntitlement`。源码第 31–33、83–84 行注释要求：创建事务里必须重新检查并冻结权限、模型白名单和额度 |
| 后台"对比最多几个模型" | `fusion_compare_max_models` 设置和 `FusionCompareSetting.tsx` |

### 3.2 只能借鉴的设计

| 设计 | 来源 | 用在哪 |
|---|---|---|
| 每列一个状态机（排队 / 生成中 / 成功 / 停止 / 出错）、独立停止、列多时降低刷新频率 | big-AGI | 对比模式的每一列 |
| "现在就用已完成的"：不等最慢的那个模型 | big-AGI | 对比模式；评审模式在汇总前等到超时 |
| 只合并成功的列，失败的列不进汇总，也不收费 | big-AGI、LibreChat | 评审模式汇总 |
| 汇总提示词："批判地合成，不照抄，原意见里可能有错" | MoA（Apache-2.0，可以直接改写使用） | 评审汇总模型提示词的起点；最终由评审 Skill 规定 |
| 评审时隐藏模型身份，意见用固定格式输出 | llm-council（只借思路） | 评审团意见清单，用 JSON schema 严格模式（#852 已实测可用） |
| 每轮由汇总方输出"还有没有关键意见"，没有就提前结束 | Multi-Agents-Debate（GPL，只借思路） | 评审多轮的停止条件 |
| 先列清单让用户勾选，再按选中的项合并 | big-AGI 的 Guided 模式 | 以后如果要让用户挑选采纳哪些意见，可以照做（不在上线范围） |

### 3.3 必须自己写的部分

开源项目里都没有，也必须和现有 BILL2 一致。下面按风险从高到低排。

1. **一组模型共用一个运行单，可以同时冻结、各自结算。**
   - 现状有三处明确禁止并行：
     - `runtime_executions.billing_run_id` 是唯一约束（`0106_runtime_sessions.sql` 第 15 行），一个运行单只能挂一个执行。
     - 领取调用时，如果同一运行单里还有没结算的调用就报 `BILL2_CALL_PENDING`（0180 第 63 行）。
     - 调用序号必须严格等于"上一个加一"（0180 第 67 行），而且由调用方自己传。
   - 要改成：
     - 运行单和执行之间用关联表，或者放开唯一约束；
     - 调用序号在数据库里原子分配；
     - "未结算不能领取"改成按每个模型通道分别判断。
2. **部分结算。**
   - 现在的结算（`bill2_payg_finalize`，0166 第 518–528 行）按调用顺序累加。遇到一个结果未知的调用就停下，后面所有调用都结不了。
   - Master Plan 第 4.4 节要求：某个模型结果未知时，只保留它的冻结额，其余模型先结算、先退回多余冻结额，整组仍然只取整一次。
   - 要换一种结算算法，并给运行单加上"部分成功 / 部分确认失败 / 部分待核对"的结局。
   - 同步修改 BILL2 契约中"Fusion 部分模型失败"那一行（FUSION.md 已要求）。
3. **附属会话。**
   - 现在一个会话同一时间只允许一个执行（`runtime_admit` 里报 `RUNTIME_SESSION_BUSY`），而且同一用户同一场景只能有一个会话（0106 第 9 行），没有子会话的概念。
   - 要新增挂在主会话下的附属会话：
     - 每个模型一个，各自有自己的"当前执行"；
     - 输入是从主会话冻结的同一份历史快照，并记下主会话当时的历史版本；
     - 再加一个"采用这个回答"的写回操作：不收费，可重复调用；主会话已有新内容时不直接追加，改为让用户引用到新消息里。
4. **并行执行器。** 并行由谁发起，定为**客户端同时发起 N 个执行**。服务端不在同一次请求里用 `Promise.allSettled` 统一跑。
   - 原因：现在一次 `runtime.executeStream` 请求承载一次完整执行（例如定位页面 `positioning/[draftId]/page.tsx` 第 87 行）。如果由服务端在一次请求里统一编排，N 个模型就要共用那次请求的 300 秒期限。
   - **一组准入**：服务端一次性完成整组准入，在同一个数据库事务里建一个运行单和 N 个执行（每个模型一个），做整组的权限、模型白名单、上下文窗口和限流检查。装不下或没权限的模型，在扣费前拒绝。
   - **每列一个请求**：前端每一列单独发一个流式请求，不合批，各执行各自的那一个执行。每个执行只做一次调用、不带工具，有自己的中止信号和截止时间。所以每列各有 300 秒，一列失败或超时不影响别的列。
   - **评审模式**：前端同时发起 N 个评审执行，再发起汇总执行。服务端在准入汇总执行时，按运行单状态检查评审团是否都已经结束（成功、确认失败或超时），所以先后顺序不靠前端保证。
5. **开关和配置**（后台"Fusion 设置"）：
   - 评审、对比两个总开关，默认关闭；
   - 对比"最少勾选数"（不低于 2，不超过最多模型数）、默认勾选组、可选模型列表；
   - 评审团模型、汇总模型、轮数上限、意见长度上限、单次最高预算；
   - **权限在数据库事务里重新检查。** `assertFusionEntitlement` 只能做提前提示：它只检查会员开关和对比模型数，不检查模型是否在管理员允许列表里，也不是准入凭证。真正的准入必须在创建运行单和执行的那个数据库事务里，重新读取并锁定四样东西，然后冻结到运行单上：
     - 会员等级和开关；
     - 管理员允许的模型列表；
     - 最少和最多勾选数；
     - 单次最高预算。
   - 这样，直接调接口提交没批准的模型会被拒绝；会员降级或管理员关掉开关时，即使和创建同时发生，也按事务里读到的新状态判断。
6. **账号注销接入。** 附属会话、备选回答、评审意见和修订稿要登记进注销清单（`0201_content_erasure.sql`）。

## 4. 共用一套并行能力的拆分建议（建议，待确认）

共 7 个 PR：

| # | PR | 任务 | 风险 | 内容 | 依赖 |
|---|---|---|---|---|---|
| 1 | 计费：一组一个运行单、并行冻结 | FUSION-REVIEW（底座，FUSION-COMPARE 共用） | 高，带迁移 | 运行单与多个执行的关联；调用序号原子分配；按通道判断未结算；部分结算算法和运行单的组合结局；BILL2 契约同步；集成测试覆盖 FUSION.md 必测项 2、6–9、12，以及必测项 3 中的底层部分（逐次冻结和单次上界计算，用合成调用测）；必测项 3 的完整评审链路由 #5 负责 | 无 |
| 2 | 附属会话和采用写回 | 同上 | 高，带迁移 | 附属会话表或字段、历史快照和版本、各自的"当前执行"、采用写回（幂等、不收费、主会话有新内容时拒绝直接追加）、登记进注销清单 | #1（两者都要改执行和会话的关系，以及 `runtime_admit` 准入函数，不能同时做） |
| 3 | 并行执行器 + 开关和配置 | 同上 | 高（碰计费调用路径） | 一组准入（同一个事务里建一个运行单和 N 个执行，重新检查并冻结权限、模型白名单、勾选数和预算）、每个执行单次调用、不带工具、各自截止时间（由客户端各发一个请求）、逐模型上下文检查、限流批量申请、两个总开关和后台配置项 | #1、#2 |
| 4 | 对比模式界面 | FUSION-COMPARE | 普通 | 模型勾选器（默认组、最少和最多数）、多列流式（手机上用标签切换）、每列停止、"采用此回答"、"某模型待核对，冻结 N 积分"提示 | #3 |
| 5 | 评审流程 | FUSION-REVIEW | 高（多轮计费上界） | 评审团并行出意见（JSON schema）→ 汇总模型写修订稿（全文 + 各步骤字段值，并检查章节是否齐全）→ 多轮直到没有关键意见或到达轮数上限；预扣上界按 FUSION.md 的自研方案计算；服务端按运行单状态检查"评审团都结束了才能汇总"；用一次完整评审的请求日志验收 FUSION.md 必测项 3（每一次读取都对应到估算里的一项）；修改评审 Skill 里"评审团可以联网"的写法 | #3、R14 宿主接口 |
| 6 | 评审界面和后台设置 | FUSION-REVIEW | 普通 | 报告页的评审入口、进度、意见和修订稿展示、采用修订；后台的评审团、汇总模型、轮数等设置界面 | #5 |
| 7 | 文档同步 | FUSION-REVIEW | 普通，仅文档 | 决定本身由 #848 记录。之后再把 Master Plan 第 4.3 节正文和 FUSION.md 改成自研方案、删掉 Fusion 方案；ENGINEERING.md 第 6 节已经是"自己并行"，不用改 | #848 合并后 |

先后顺序：

1. **第 7 项**：#848 合并后，同步第 4.3 节正文和 FUSION.md。
2. **#1 → #2**：先做计费底座，再做附属会话。两者都要改执行和会话的关系、`runtime_admit` 准入函数和相关迁移，必须一个做完再做另一个，不能同时开工。
3. **#3**：两块底座都合并后再做。
4. **#4 和 #5** 并行做：对比模式和评审流程分别接在 #3 上。
5. **#6**。

另外两点：
- **高风险项的验证**：#1、#2、#3、#5 都要在 staging 上用测试预算实测，包括正常、重复提交、并发、一个模型失败、一个模型结果不明这几种情况（AGENTS.md 第 4 节）。
- **复用的开源代码**：只来自 big-AGI（MIT）和 MoA（Apache-2.0），拷过来的片段要保留原版权声明。GPL、没有许可证和带品牌条款的项目，只看设计、不拷代码。

## 5. 没核实的点

- LibreChat 最多能同时比几个模型。
- LobeHub 有没有并列对比功能。
- flowith 能不能一次勾选多个文本模型，以及多个输出怎么扣积分。
- big-AGI Beam 的列数上限（配置写 24）在实际使用中的界面表现。
