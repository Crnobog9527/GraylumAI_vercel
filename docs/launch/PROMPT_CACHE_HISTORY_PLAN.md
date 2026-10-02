# PROMPT-CACHE-HISTORY：对话历史也加缓存（只是方案，不改产品代码）

- 任务来源：Owner 2026-10-03 原话（总控转记）："对话历史也加缓存。"
- 前置：[PROMPT-CACHE 方案 #572](PROMPT_CACHE_PLAN.md)（第 1.3 节写明第一版为什么不缓存历史，第 7 节把它列为 B 阶段）；
  第一版实现 #591 已合并（`9600f2bc`）。
- 风险：**high**（Runtime 发往供应商的请求字节、adapter 白名单、历史裁剪规则、冻结上下文、导师看到的请求结构）。
- 读的代码：staging `801e682e`（含 #591、#595、#597、#599），只读。本轮没有发真实模型请求，没有访问数据库，没有改配置。
  只读查阅了 Anthropic 官方缓存文档（2026-10-03）和 #591 的两条付费验收记录
  （[前五轮](https://github.com/Crnobog9527/GraylumAI_vercel/pull/591#issuecomment-5956577683)、
  [第 6–8 轮](https://github.com/Crnobog9527/GraylumAI_vercel/pull/591#issuecomment-5956865557)）。
- 实施时必须按当时的最新 staging 重新核对行号（#590 RATE-LIMIT 接线和 #593 B1 都还在途，见第 5 节）。

## 0. 结论

1. **能做，而且省得多。** 按 #591 实测的 token 数推算：同样 8 轮，Sonnet 主对话费用比第一版再省约 16%–22%，
   比完全不缓存省约 42%–46%（第一版是 31%）；对话越长越明显，第 8 轮单轮比第一版省约 48%–56%。
   每轮费用随轮数增长的速度降到原来的约十分之一（第 3.3 节）。
2. **核心改动是把"每轮会变的步骤状态"挪到历史后面**：放进当前这一轮的 user 消息（一个由宿主生成的 `hostTurnContext` 字段），
   system 只留不变的规则。不用"历史后面再插一条 system 消息"，因为 OpenRouter 转给 Anthropic 时可能把所有 system
   合并到最前面，我们看不到，也测不出来（第 2.2 节）。
3. **第二个缓存断点放在"当前 user 消息之前最后一条纯文本历史消息"上**（user，或不带工具调用的 assistant）。
   每轮读上一轮写的部分，只新写上一轮新增的那段（约 2200 token）。全程只用 2 个断点（上限 4 个）。
   不用顶层自动缓存：它会把断点放在当前 user 消息上，而这条消息下一轮会被改写成 Superseded 占位，永远读不到（第 2.3 节）。
4. **历史裁剪改成"按块跳"**：超限时不再每轮删最早一轮，而是按固定的 session 修订号分块（每块 16 个历史条目）整块删，
   之后若干轮的开头保持不变。只在超限时才删，不超限和现在一样全留（第 2.4 节）。
5. **Superseded 占位本身不用改**：它只取决于那条旧消息自己的修订号和哈希，一旦变成占位就一直是同样的字节。
   新增：旧消息里的 `hostTurnContext` 也在变成历史时去掉（第 2.5 节）。
6. **计费上限不用改**（只用 5 分钟缓存时）：#581 冻结的输入单价已经是 max(普通输入价, 5 分钟写入价)。实际扣费仍只用
   `usage.cost`。如果以后启用 1 小时缓存，上限推导必须加上 `input_cache_write_1h`，那是另一个 high 改动（第 3 节）。
7. **冻结字段升到 `prompt-cache-v2`**；v1 和没有缓存字段的旧执行原样重放，字节和 requestHash 不变（第 4 节）。
8. **和 B2 的关系（推荐）**：拆成两步，同一个写入方（Codex）先后做：
   **H1 机制 PR**（Runtime 侧，宿主不提供 `hostTurnContext` 时完全不生效，请求字节不变）先做；
   **B2 重写提示词时直接按新结构写**，由 B2 一并激活，B2 已批准的小评测同时覆盖质量和缓存效果，不用评测两次（第 5 节）。
9. Gemini、Luna 整理、匹配调用不加标记（第 6 节）。
10. 需要 Owner 定的事三项，见第 8.3 节；都附推荐。

## 1. 现状核对（staging `801e682e`）

### 1.1 一次导师请求的实际字节顺序

Anthropic 的拼接顺序是 工具 → system → messages，缓存命中要求从头开始完全相同。

| 顺序 | 内容 | 来源 | 跨轮是否稳定 |
| --- | --- | --- | --- |
| 工具 | 开场轮 `[]`，其他轮 `[ask_question]` | `runtime/admission.ts:213` | 开场轮和之后的轮不同；之后的轮之间稳定 |
| system ① | Skill 正文 `loaded.forModel()`，#591 实测 10331 字符 | `admission.ts:124` | 同一步骤内稳定，换步骤会变（resources 不同） |
| system ② | `"\n"` + `HOST_RULES` 第一个占位符所在行之前的固定部分 `AGENT_TURN_STABLE_PREFIX`（现为 4996 字符；#572 写的 4898 已因 #582 改变） | `opc/agentTurnPrompt.ts:88`、`opc/service.ts:247`、`admission.ts:168` | 稳定。①+② = 15328 字符，就是 #591 冻结的 `systemPrefixChars` |
| system ③ | 5 行占位符：当前步骤、步骤材料（每个字段的状态）、当前问题、字段角色、可用步骤和字段 | `agentTurnPrompt.ts:68-72`、`122-128` | **每轮可能变** |
| system ④ | `HOST_RULES` 剩余固定部分（1147 字符）；开场轮另加 `OPENING_RULE`（552 字符）；再加 `"\n"` + `QUESTION_CONTRACT_INSTRUCTIONS` | `agentTurnPrompt.ts:74-85`、`128-129`，`admission.ts:172` | 固定，但排在 ③ 后面；开场轮多一段 |
| 历史 | 以前各轮的 user / assistant / 提问工具调用和结果。旧的 scopeMaterial 换成 Superseded 占位；assistant 的 reasoning 被去掉 | `runtime/context.ts:66-87`、`openRouterHistory.ts:39-67` | 排在 ③ 后面；超限时裁剪（第 1.2 节） |
| 当前 user | `JSON.stringify({scopeMaterial, userRequest, dataNotice})`，scopeMaterial 是完整的当前材料 | `context.ts:54-56`、`execute.ts:273` | 每轮变 |

转换和检查链路（和 #572 第 1.1 节一致，只是位置更新）：

- SDK 把 instructions 作为 `messages[0]`（`role:'system'`，字符串）放在最前面。
- `execute.ts:129` 调用 `providerRequest.ts:openRouterRequestBody`，这是请求变成发送字节的唯一位置。它在
  `normalizeOpenRouterHistory` 之后调用 `applyPromptCache`（`providerRequest.ts:68-70`），把 system 在冻结的
  `systemPrefixChars` 处切成两块，第一块带 `cache_control:{type:'ephemeral'}`（`promptCache.ts:41-52`）。
  之后才做容量检查（`execute.ts:131`）、`requestHash`、`runtime_response` 重放查询和发送。
- adapter（`bill2/openRouterAdapter.ts:23-26`、`152-154`）只放行一种形状：`anthropic/` 模型、冻结报价带
  `cacheWriteUsdPerMillion`、`messages[0]` 是 system、content 是"带标记的文本块 + 可选的普通文本块"。其他任何位置的
  `cache_control` 都会被普通消息检查拒绝（`BILL2_PROVIDER_REQUEST_DENIED`，在读凭据和发送之前）。
- 冻结：`freezePromptCache`（`promptCache.ts:22-38`）只对真实报价、skill 角色、`anthropic/` 模型、有写入价的执行写
  `prompt-cache-v1`；`admission.ts:169-171` 调用，`admission.ts:206` 写进上下文并进入 `sourceHash`。
- 容量：标记的固定开销 `PROMPT_CACHE_OVERHEAD_BYTES` = 88 字节（两块的 JSON 减去原字符串的 JSON），
  在 admission（`admission.ts:189-190`）和执行（`execute.ts:239-241`）都加到 `toolBytes` 上。

### 1.2 让历史前缀每轮变化的原因

| # | 原因 | 位置 | 影响 |
| --- | --- | --- | --- |
| a | 动态的 ③ 排在历史前面 | `agentTurnPrompt.ts:68-72` | ③ 一变，后面的历史全部读不到 |
| b | 按字节裁剪：超过输入预算时从最早一轮开始逐轮删 | `context.ts:6-42`（会话历史选择，余量 1024）、`92-135`（每次调用前，余量 128） | 到上限之后每轮都删一轮，开头每轮都变 |
| c | 按条数裁剪：只留最近 `historyItems` 条（SQL 先取最近 `historyItems+128` 条，0158 第 184-194 行；TS 再切到 `historyItems` 条，`context.ts:32`） | 同上 | 条数到上限之后，开头每轮都变 |
| d | 开场轮不带工具，之后的轮带提问工具 | `admission.ts:213` | 工具排在最前，开场轮写的缓存下一轮一定读不到 |
| e | 用户要求对比旧版本时，所有历史保留完整旧材料 | `execute.ts:242`、`context.ts:61-64` | 这一轮的历史字节和平时不同 |
| f | 换步骤时 Skill resources 不同 | `admission.ts:122-124` | system 变，整段重新写 |

不会让前缀变化、但要说明的：

- **Superseded 占位**（`context.ts:68-87`）：旧消息被换成 `{sessionId, revision, hash, contentOmitted}`，这些值都来自那条旧消息自己。
  因为当前材料的修订号只增不减，一条旧消息一旦被换成占位，以后每轮都是同样的字节。被改写的只有"上一轮的当前消息"
  （它在上一轮是完整材料，这一轮变成占位）。所以断点不能放在当前消息上，要放在它之前（第 2.3 节）。
  唯一的例外是同一修订号但哈希不同（`context.ts:82`，保留原文），出现时只会让一轮读不到，不会出错。
- **reasoning**：`normalizeOpenRouterHistory` 每轮都去掉 assistant 的 reasoning，历史字节每轮一致。Anthropic 文档说
  "API 丢弃了发过去但不能保留的 thinking 块"会让后面的缓存失效；我们从不发回 thinking 块，所以不受这条影响。
  管理员改导师的思考强度会让历史缓存整体失效一次（官方说明 effort 和 thinking 参数变化会使消息缓存失效），这是预期行为。
- **跨轮可读的范围**：Anthropic 每个断点最多往前查 20 个位置。一轮新增 2–4 条消息，远小于 20。

### 1.3 #591 实测（Sonnet 5.5，`anthropic` 线路，8 轮，同一步骤）

| 轮次 | 输入 token | 写入 | 读取 | 输出 | 实际费用 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 开场 | 13220 | 11504 | 0 | 483 | 0.037022 |
| 2 | 15721 | 0 | 12201 | 801 | 0.017490 |
| 3 | 18064 | 0 | 12201 | 577 | 0.019936 |
| 4 | 20345 | 0 | 12201 | 529 | 0.024018 |
| 5 | 22518 | 0 | 12201 | 457 | 0.027644 |
| 6（隔约 13 分钟） | 24709 | 12201 | 0 | 887 | 0.064389 |
| 7 | 26835 | 0 | 12201 | 517 | 0.036878 |
| 8 | 28994 | 0 | 12201 | 557 | 0.041596 |

- 输入每轮平均增长约 **2212 token**（(28994−15721)/6），这部分现在全按普通输入价付。
- 开场轮写入 11504、第 2 轮读到 12201，差的约 700 token 正好是提问工具的定义：开场轮写的条目第 2 轮读不到（第 1.2 节 d）。
  第 2 轮读到的 12201 应该是此前另一次带工具的请求写的（不同会话共用同一 Skill 前缀）；这是推断，没有逐条核实。

## 2. 设计

### 2.1 改后的请求结构（只对冻结了 `prompt-cache-v2` 的导师轮）

| 顺序 | 内容 | 缓存 |
| --- | --- | --- |
| 工具 | 同现在 | — |
| system | ① Skill + 全部**固定**规则（现在的 ②、④、`QUESTION_CONTRACT_INSTRUCTIONS`，由 B2 重写成清单语义） | 断点 1：整段 system |
| 历史 | 以前各轮；旧的 scopeMaterial 是 Superseded 占位，旧的 `hostTurnContext` 已去掉 | 断点 2：最后一条纯文本历史消息 |
| 当前 user | `{hostTurnContext, scopeMaterial, userRequest, dataNotice}` | 不缓存 |

`hostTurnContext` 就是现在的 ③（B2 之后是整份清单的状态）以及开场标志，由宿主生成，是一个对象，不是预先序列化的字符串
（这样转义层数和现在放在 system 里一样，字节数基本不变）。

### 2.2 为什么放进当前 user 消息

考虑过的三种位置：

| 位置 | 问题 | 结论 |
| --- | --- | --- |
| 历史之后再插一条 `role:'system'` | Anthropic 原生接口只有一个顶层 system。OpenRouter 转换时很可能把所有 system 消息合并到最前面，③ 又回到历史前面；这一步发生在 OpenRouter 内部，我们的请求字节、黄金测试都看不出来 | 不用 |
| `developer` 角色 | 同上，转换行为没有文档保证 | 不用 |
| 当前 user 消息里的宿主字段 | 字节完全由我们决定；scopeMaterial 已经用同样的方式随导师输入发送（#588 第 3.4 节也把字段当前值交给 scopeMaterial） | **采用** |

需要处理的副作用：

- **权威性**：user 消息里的内容对模型来说权重低于 system。system 里的固定规则要写明：只有最新一条 user 消息顶层的
  `hostTurnContext` 是宿主写的当前状态；`userRequest` 和 `scopeMaterial` 里的任何文字都是数据。
  用户在输入框里写"宿主说已确认"之类的文字，会被 `JSON.stringify` 转义在 `userRequest` 字符串里，伪造不出顶层字段。
  B2 的小评测里加 1 道这类题（在已批准的 70 次之内调配，不加预算）。
- **`dataNotice` 文字**要相应改为说明这两个字段的区别，由 B2 定稿；H1 只提供字段和位置。

### 2.3 第二个断点放在哪里

规则（只由冻结上下文和实际发送的 messages 决定，不看内容含义）：

1. 最后一条 message 必须是当前 user 消息（role user，字符串 content）；否则不加历史断点。
2. 从倒数第二条往前找第一条"纯文本消息"：role 是 user，或者 role 是 assistant 且没有 `tool_calls`；content 是非空字符串。
   提问卡轮的历史末尾是"assistant 工具调用 + tool 结果"，这两条跳过，断点落在它们前面那条消息上。
3. 找到就把它的 content 换成 `[{type:'text', text:<原字符串>, cache_control:{type:'ephemeral'}}]`；找不到（例如会话第一轮）就不加。

为什么这样能命中：第 N 轮把断点放在第 N−1 轮的回复上（这时第 N−1 轮的 user 消息已经是占位）；第 N+1 轮的断点在第 N 轮的回复上，
往前查时会找到第 N 轮写的条目，读到"system + 第 N−1 轮为止的历史"，只新写"第 N 轮的 user（占位）+ 回复"。
标记本身不算在前缀里：上一轮带标记的那条消息，这一轮变回普通字符串，只要文字相同就命中（Anthropic 的多轮缓存就是每轮把断点往后挪）。
官方文档也明确：断点放在每轮都变的块上，"每次都付写入费、永远读不到"——所以不能放在当前 user 消息上，也不用顶层自动缓存。

其他约束：

- **最小长度**：Anthropic 要求断点之前的整段前缀达到最小长度（Sonnet 5.5、Opus 5.5 为 512 token；Sonnet 5 等为 1024）。
  断点 2 之前已经包含约 1.2 万 token 的 system，一定满足。
- **断点数**：只用 2 个（上限 4 个）。不加第 3 个：一轮只新增几条消息，往前查 20 个位置足够。
- **在一次执行里**：导师轮遇到提问工具就结束，只有一次模型调用。万一有第二次调用，同一条规则重新找位置，结果仍然确定。

不加历史断点、只保留 system 断点的轮次（在准入时冻结为 `historyMarker:false`）：

- **开场轮**：工具和后续轮不同，写了也读不到，只会多付 25%（第 1.2 节 d）。
- **历史对比轮**（`requestsHistoricalComparison` 为真）：历史是完整旧材料，下一轮读不到。下一轮恢复占位后，
  仍能读到再上一轮写的条目（在 5 分钟内、往前 20 个位置之内）。

### 2.4 历史裁剪改为按块跳

目标：只有超限才删；一旦要删，删到一个固定的位置，之后若干轮都从这里开始。

规则（只对 v2 执行；v1 和旧执行完全不变）：

1. 历史全部放得下（条数 ≤ `historyItems`，字节 ≤ 预算）：全留，和现在一样。
2. 放不下：只允许在"轮的开头"（user 消息，且不切断工具调用和结果，沿用现在的 `safeCut` 规则）切；并且这条消息的
   **session 修订号**要 ≥ k × Q。取满足条数和字节限制的最小 k。Q = 16（冻结在 v2 字段里，以后要改就升版本）。
3. 修订号是 session 里每条历史的绝对编号（`runtime_session_history.revision`，`PostgresSession` 已经读到，
   `session.ts:41-44`），不随窗口滑动而变。所以只要剩下的部分还放得下，切点就不动；放不下时一次跳过一整块。
4. 条数窗口：SQL 已经多给了 128 条余量（0158 第 184-194 行），Q = 16 远小于 128，按块切的位置一定在 SQL 给的范围之内，
   **不用改 SQL**。
5. 重放：执行冻结的是第一次选中的历史（`freezeHistoryItems`，SQL 的 `selected_history`）。重放时拿到的就是这组，
   它本身放得下，按第 1 条全留，结果不变。
6. `selectRuntimeCallInput`（每次调用前）对 v2 使用同一规则。导师轮第一次调用时它的余量（128）比会话选择（1024）宽，不会再切。

代价和取舍：

- 每跳一次，剩下的历史要整段重写一次（多付约 2.3 × 历史 token × 输入价的百万分之一），之后又能连续命中。
- 每次跳会比现在多删最多约 16 条历史（大约 3–8 轮最早的对话）。导师需要的字段当前值在每轮的 scopeMaterial 里，
  不依赖最早的聊天记录；Skill 的规则也在 system 里。这是可以接受的取舍，列在第 8.3 节供 Owner 知悉。
- 什么时候会开始裁剪取决于 staging 的 `runtime_purpose_budgets.interactive`（输入上限最多 90000 字节、条数最多 1000；
  没配置时旧值是 64000 字节、100 条）。本方案没有读 staging 配置。按 #591 第 8 轮约 2.9 万 token 推测，
  长对话在十几轮内就可能碰到字节上限，所以这一项是必需的，不是可选优化。实测时记录每轮请求字节（第 7.2 节）。

另一种更简单的做法是"只要这一轮发生了裁剪就不加历史断点"。它不用改裁剪规则，但长对话一到上限就退回第一版的省法，
而长对话恰恰是历史最大、最值得缓存的时候。所以不采用，只在按块切找不到合法位置（例如历史格式异常）时作为兜底：
回到现有裁剪规则并且这一轮不加历史断点。

### 2.5 Superseded 占位和旧的 `hostTurnContext`

- Superseded 占位：规则不变（理由见第 1.2 节）。
- 旧的 `hostTurnContext`：在历史投影时（和 Superseded 同一处，`projectSupersededScopeItem` 的 v2 分支）直接去掉这个键。
  这是只取决于那条消息自身的确定性变换，变成历史之后每轮字节一样；同时避免过时的步骤状态混进历史、占用容量。
  原始记录不改，只改发给模型的投影（和现在的占位做法一致）。
- 历史对比轮保留完整旧材料的规则不变，但同样去掉旧的 `hostTurnContext`（它是宿主状态，不是用户要对比的材料）。

### 2.6 冻结字段 `prompt-cache-v2`

`promptCache.ts` 的 schema 改为按 `version` 区分的联合类型：

```ts
// v1：原样保留，旧执行和非导师 Skill 轮继续使用
{version:'prompt-cache-v1'; systemPrefixChars; systemPrefixSha256}
// v2：新导师轮
{version:'prompt-cache-v2'; systemPrefixChars; systemPrefixSha256; historyMarker:boolean; historyCutRevisions:16}
```

另在执行上下文 schema（`execute.ts:33` 附近）加可选的 `hostTurnContext`（strict 对象，大小有上限），随 `sourceHash` 冻结。

admission 只在以下条件**同时满足**时冻结 v2：v1 的全部条件（真实报价、skill 角色、`anthropic/`、报价有写入价）；
导师轮（`mentorStream`）；宿主提供了 `hostTurnContext`；`stableAdditionalInstructions` 等于完整的 `additionalInstructions`
（也就是 system 里没有动态部分）。v2 的前缀是**加上 `QUESTION_CONTRACT_INSTRUCTIONS` 之后的整段 system**，
所以冻结要移到 `admission.ts:172` 之后计算。`historyMarker` = 不是开场轮，并且不是历史对比轮。

不满足时退回现在的 v1 或不冻结，行为和今天一样。宿主（`opc/service.ts`）不提供 `hostTurnContext` 时，H1 合并后
任何请求的字节都不变——这就是第 5 节"先做机制、由 B2 激活"的依据。

### 2.7 发送前的转换（`providerRequest.ts`）

在 `normalizeOpenRouterHistory` 之后、现有 `applyPromptCache` 的位置：

- v1：完全不变。
- v2：先按 v1 的方式校验并标记 system（前缀等于整段时只有一块）；`historyMarker` 为真时再按第 2.3 节加第二个标记。
  任何校验失败抛 `RUNTIME_PROVIDER_BINDING_DENIED`，在 claim 之前失败，不产生费用。
- 当前 user 消息的组装在 `runtimeScopeInput`（`context.ts:54-56`）：v2 时多一个 `hostTurnContext` 键，键的顺序固定写进黄金测试。

### 2.8 adapter 的严格扩展（`openRouterAdapter.ts`）

在现有唯一例外之外，**只再多接受一种形状**，其余检查不变：

- 只适用于 `identity.model` 以 `anthropic/` 开头、冻结报价有 `cacheWriteUsdPerMillion`、并且是提问工具格式的请求（`agentTurn` 为真）；
- 必须同时有 index 0 的 system 标记（不允许只有历史标记）；
- 历史标记最多一个，所在消息：index > 0、不是最后一条；role 是 user 或 assistant；键只有 `role/content`（不能带 `tool_calls`）；
  content 恰好是一个文本块，键只有 `type/text/cache_control`，`text` 非空，`cache_control` 严格等于 `{"type":"ephemeral"}`；
- 位置也要独立复核：最后一条是 role user、字符串 content；标记消息和最后一条之间只能是"assistant 工具调用 / tool 结果"；
- 整个请求最多 2 个 `cache_control`。

继续拒绝：顶层 `cache_control`；`ttl`（包括 `"1h"`）；工具定义、tool 消息、带工具调用的 assistant 消息上的标记；
非 `anthropic/` 模型带任何标记；3 个及以上标记；没有写入价时带标记。

### 2.9 容量

| 开销 | 字节 | 说明 |
| --- | ---: | --- |
| system 两块（现有） | 88 | `PROMPT_CACHE_OVERHEAD_BYTES`；v2 下 system 通常只有一块，88 仍是上界 |
| 历史标记（新增） | 62 | `[{"type":"text","text":…,"cache_control":{"type":"ephemeral"}}]` 比原字符串多出的部分；整条消息不切开，转义不变 |
| v2 合计 | 150 | 新常量按实际 JSON 计算（和 88 一样不手写），v2 时在 admission 和执行两处加进 `toolBytes` |
| 如果以后用 1 小时 | 99 + 73 = 172 | 只供参考，本方案不启用 |

`hostTurnContext` 从 system 挪到当前 user 消息，它的字节已经在两处容量计算的 `messages` 里实测，不用另加常量；
admission 的预检（`admission.ts:191-192`）要改为用带 `hostTurnContext` 的同一个 `runtimeScopeInput`。
必测：贴着上限的请求在 v2 下仍能发出；按块切之后加标记仍不超限。

## 3. 计费

### 3.1 上限不用改（5 分钟缓存）

- `openRouterBound` 的输入单价已经取 `max(promptUsdPerMillion, cacheWriteUsdPerMillion)`（`openRouterPolicy.ts:36-37`）；
  #581 的 `deriveFrozenPrices`（`shared/modelPriceBound.ts:67-97`）冻结的 `promptUsdPerMillion` 本身就是各档
  max(普通输入价, 5 分钟写入价)。上限按整个 context 计，和写入的是 system 还是历史无关，所以**历史标记不需要改上限**。
- PAYG（#553）把上限收紧到逐次 T 之后，同一定义仍然成立：每个输入 token 最多按 5 分钟写入价收。
- `max_price` 路由约束不包含缓存价格，保持不变；结算时 `cost > upper_usd` 记冲突的规则不变。

### 3.2 实际扣费

只用 OpenRouter 返回的 `usage.cost`，不按 token 数自己算，不用 `cache_discount`。#591 验收已确认 `usage.cost`
包含读取折扣和写入溢价、扣费不重复加减。积分 = `ceil(实际费用 × q × m)` 的规则不变，缓存省下的直接变成用户少扣的积分。

### 3.3 测算（按 #591 实测 token 数）

单价（美元/百万 token）：输入 2、5 分钟写入 2.5、读取 0.2、输出 10。记号：P = 固定前缀 12201；Hₙ = 第 n 轮的历史；
Δ = 每轮新增历史（实测约 2212）；T = 当前 user 消息加 ③（不能缓存）。T 无法从回执拆出，按 1000 / 1500 / 3000 三种假设算，
Hₙ = 输入 − P − T。

每轮（同一步骤、5 分钟内）：

| | 读取 | 写入 | 普通价 |
| --- | --- | --- | --- |
| 第一版（现在） | P | 0 | Hₙ + T |
| 改后 | P + Hₙ₋₁ | Δ（上一轮新增的 user 占位 + 回复） | T |
| 改后，过期或换步骤后的第一轮 | 0 | P + Hₙ | T |

单轮费用随轮数的增长：第一版每多一轮约多 2 × Δ ≈ 0.0044 美元；改后约多 0.2 × Δ ≈ 0.00044 美元，大约是十分之一。

**8 轮重算**（Sonnet 主对话合计；第 6 轮按实际情况视为过期，system 和历史都重写）：

| T 假设 | 不缓存 | 第一版（实测） | 改后（推算） | 改后比第一版 | 改后比不缓存 | 第 8 轮单轮比第一版 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1000 | 0.3889 | 0.2690 | 0.2101 | −21.9% | −46.0% | −56.4% |
| 1500 | 0.3889 | 0.2690 | 0.2141 | −20.4% | −44.9% | −54.2% |
| 3000 | 0.3889 | 0.2690 | 0.2261 | −15.9% | −41.9% | −47.7% |

**更长的对话**（推算：T = 1500、每轮输出 600、Δ = 2212，**假设没有触发裁剪**，第 2–20 轮合计）：

| 情况 | 不缓存 | 第一版 | 改后 | 改后比第一版 |
| --- | ---: | ---: | ---: | ---: |
| 一直在 5 分钟内 | 1.475 | 1.058 | 0.398 | −62% |
| 每 4 轮停顿一次超过 5 分钟 | 1.475 | 1.170 | 0.714 | −39% |

这些是情景推算，不是实测；第 7.2 节的实测会给出真实数字。改后的开场轮和第一版完全一样。

### 3.4 过期重写的代价

- 一轮过期，比命中多付约 2.3 ×（P + Hₙ）× 百万分之一美元。历史 1 万 token 时约 0.051 美元（按 q=100、m=3 约 15 积分），
  比第一版过期时多付的 0.028 美元大，而且历史越长越贵。
- 和"完全不缓存"相比，过期那一轮只多 25%（2.5 对 2）。只要不是每轮都过期，整体仍然省。
- 换步骤后的第一轮、按块裁剪跳一次，代价和过期相同。

### 3.5 1 小时缓存：建议先不做，等数据

- 1 小时写入 4 美元/百万 token（5 分钟是 2.5），读取同样 0.2。好处是用户停顿 5–60 分钟时不用重写。
- 粗略的平衡点：设"停顿 5–60 分钟后才发出的轮次"占比为 p，每轮新增 Δ、总可缓存长度 X。1 小时每轮多付约 1.5 × Δ，
  5 分钟每次过期多付约 2.3 × (X − Δ)。所以 p 大约超过 1.5Δ / (2.3X) 时 1 小时更划算：X = 2 万 token 时约 7%，
  X = 3.5 万时约 4%。按 #591 第 1–8 轮的推算，1 小时只比 5 分钟再省约 3%–4%（那组只有一次停顿）。
- 要做的话不是只改一个参数：`deriveFrozenPrices` 的输入价要加上 `input_cache_write_1h`（`modelPricing.ts:20` 已经认识这个字段，
  但推导没有用它），adapter 要放开 `ttl:"1h"`，冻结字段要带 TTL，上限会随之变大。也可以只给 system 用 1 小时、历史用 5 分钟
  （官方要求长 TTL 的断点排在短 TTL 前面，这个顺序正好满足），让不同用户共用的 Skill 前缀更少重写。
- **建议**：这次只做 5 分钟。B2 小评测和 B2+F1 staging 验证会产生真实的回合间隔数据（回执里有每次调用的开始时间），
  如果停顿 5–60 分钟的轮次占 10% 以上，再单独开一个小的 high PR 做 1 小时（或只给 system 用 1 小时）。由 Owner 定（第 8.3 节）。

## 4. 兼容、重放、恢复和回退

- **旧执行**（没有 `promptCache`，或 v1）：进入现有分支，请求字节和 `requestHash` 与改动前逐字节相同；裁剪仍用现有规则。
  黄金测试覆盖每一种 `PROVIDER_REQUEST_FORMATS`，基线是实施分支改动之前的代码（不写死 SHA），并沿用 #591 的
  `promptCacheGolden.json`。
- **v2 执行**：重放时从同一份冻结上下文（`hostTurnContext`、v2 字段、instructions）和冻结的历史成员重新算出相同的
  投影、相同的切点（第 2.4 节第 5 条）、相同的标记位置，`requestHash` 一致，查到原来的响应。
- **恢复（#595 刷新后自动接上）**：恢复走同一个 requestId 的重放，不重新准入，不受影响。`legacyInput` 回退路径只给没有
  `inputSelection` 的旧执行用，v2 执行不会走到（`execute.ts:303`）。
- **新旧混合的会话**：同一会话里前几轮是 v1、之后是 v2，历史里的旧 user 消息没有 `hostTurnContext`，投影照常；
  第一次 v2 轮会整段写入一次，之后正常命中。
- **回退**：最快是 B2 侧停止提供 `hostTurnContext`（或 admission 不再冻结 v2），新请求就回到 v1；需要发版，不需要改数据库。
  `providerRequest`、adapter、投影和裁剪对 v2 的支持必须保留，保证已冻结的 v2 执行还能重放和结算。
  也可以像第一版一样，用不带写入价的报价让新准入什么标记都不加（更换测试窗口或报价是 staging 数据变更，需要 Owner 批准）。
- 不涉及数据库迁移、新表、新配置项。

## 5. 和 B2 的关系、顺序和写入方

### 5.1 三种顺序的比较

| 做法 | 好处 | 问题 |
| --- | --- | --- |
| 先做本任务（连同挪动现在的 ③），再做 B2 | 早一点省钱 | 要先给"即将被 B2 替换的提示词"做一次质量评测，B2 再评一次；而且和在途的 B1（#593 改 `opc/service.ts`）抢同一个文件 |
| B2 之后单独做 | B2 不受影响 | B2 的小评测（70 次导师、9 美元上限）评的是 ③ 在 system 里的结构；挪到 user 消息后出卡分寸可能变化，要再评一次 |
| 全部并进 B2 | 一次评测 | B2 本来就很大（提示词、v2 标记、焦点 task、准入规则）；#588 第 7 节写明 B2 不改 `admission.ts`，而本任务必须改 |
| **推荐：拆成 H1 机制 + B2 激活** | 机制独立审查、独立测试；提示词结构只变一次、只评一次 | H1 合并后到 B2 合并前，机制不生效（这是有意的，见下） |

### 5.2 推荐做法

1. **H1（本任务的实施 PR，high，Codex）**：只改 Runtime 侧——`promptCache.ts`（v2 schema 和标记）、`providerRequest.ts`、
   `context.ts`（`runtimeScopeInput`、v2 投影、按块裁剪）、`execute.ts`（上下文 schema、`toolBytes`、修订号传给裁剪）、
   `session.ts`（只读暴露修订号）、`admission.ts`（冻结 v2、预检）、`bill2/openRouterAdapter.ts`（第 2.8 节），加测试。
   **不改 `opc/service.ts` 和 `agentTurnPrompt.ts`**，所以宿主不提供 `hostTurnContext` 时，所有请求字节和今天一样
   （黄金测试证明）。
   这不是为假想的将来做的通用设施：它的唯一使用方 B2 已经立项、排在 B1 之后。
2. **B2（#588 第 7 节，Codex）**：重写导师提示词时直接按第 2.1 节的结构写——固定规则全部放进 system，清单状态和开场标志放进
   `hostTurnContext`，`stableAdditionalInstructions` 等于完整的 `additionalInstructions`；这样 B2 一合并就激活 v2。
   B2 的完整请求快照测试（#588 第 3.6 节）同时就是 v2 的结构快照。B2 仍然不改 `admission.ts`。
3. B2 已批准的小评测（#588 第 8 节第 3 项）会走真实的 Sonnet 请求，顺带记录每次调用的 `cached_tokens`、`cache_write_tokens`，
   用来第一次确认 OpenRouter 接受历史标记（第 7.2 节）。

### 5.3 顺序和共享文件

- H1 必须等 **#590（RATE-LIMIT 接线）合并**之后从最新 staging 开工：#590 改了 `admission.ts`、`execute.ts`、
  `promptCache.integration.ts`、`promptCacheAdmission.test.ts`。H1 和 **#593（B1）** 的文件不重叠
  （#593 改 `opc/` 下的文件和 `runtime/executionStream.ts`、`timing.ts`、`runtime.integration.ts`）；如果实施时发现都要改
  `runtime.integration.ts`，新用例放新文件。
- 顺序：#590 合并 → H1（可以和 B1 并行）→ B1 合并 → B2（激活）→ F1。H1 必须在 B2 之前合并。
- 写入方：**H1 和 B2 都由 Codex 做**（按当前分工，Runtime 和 B2 都归 Codex；同一个写入方先后做，避免两边同时改请求结构）。
  本方案由 Claude 写，独立审查由总控安排。

## 6. 不受影响的部分

| 调用 | 处理 | 理由 |
| --- | --- | --- |
| Gemini（导师或普通对话） | 不加标记，不改 | Owner 已定导师用 Sonnet 5.5；Gemini 靠默认的隐式缓存，前缀稳定后它也会自动多命中，不需要我们做任何事 |
| GPT-6 Luna 整理（attached organizer） | 不改 | 不读会话历史（`historyItems:0`），输入每轮都是新的；OpenAI 自动缓存已经读到约 1100 token 的固定指令（#591 记录），金额很小 |
| 匹配调用 | 不改 | 没有历史 |
| 普通 Skill 轮（非导师）、普通对话 | 不改，继续 v1 或不冻结 | 没有 `hostTurnContext`，system 里仍有动态内容；以后有需要再单独评估 |
| 开场轮 | 结构跟着 B2 改，但只有 system 标记 | 第 2.3 节 |

## 7. 测试

### 7.1 进 CI 的测试（H1 和 B2 各自负责自己的部分）

1. **黄金字节**：没有 v2 时，所有格式的请求字节和 `requestHash` 与改动前相同（含 v1 导师轮、开场轮、普通 Skill、整理、匹配）。
2. **v2 请求快照**：普通轮、提问卡回答轮、开场轮、历史对比轮各一份完整请求——system 只有一块并带标记；历史标记的位置
   符合第 2.3 节；开场轮和历史对比轮没有历史标记；`hostTurnContext` 只出现在最后一条 user 消息里。
3. **多轮前缀稳定**：用夹具连续跑 6 轮以上（中间改变字段状态、换问题、回答一张卡），断言第 n+1 轮发送字节中，
   "第 n 轮标记位置之前"的部分和第 n 轮逐字节相同（去掉标记后比较）。换步骤那一轮断言 system 变了、并且不报错。
4. **按块裁剪**：刚好放得下时全留；超过一点时切到 16 的倍数位置；之后几轮切点不动；条数上限和字节上限分别触发；
   切点不切断工具调用和结果；对冻结的结果再跑一次结果不变（重放幂等）；历史格式异常时退回现有规则且不加历史标记。
5. **投影**：Superseded 占位和去掉旧 `hostTurnContext` 的结果，只取决于那条消息本身；同一修订号不同哈希的旧消息保留原文。
6. **容量贴边**：v2 请求正好贴着输入上限仍能发出；150 字节开销在 admission 和执行两处都计入；按块切之后再加标记不超限。
7. **adapter**：唯一允许的新形状通过；以下全部 `BILL2_PROVIDER_REQUEST_DENIED`，并且在读凭据和发送之前失败（transport 0 次）：
   非 `anthropic/` 模型带历史标记、没有 system 标记只有历史标记、标记在 tool 消息或带工具调用的 assistant 上、标记在最后一条
   消息上、两个历史标记、带 `ttl`、顶层标记、标记块带多余键、没有写入价、非提问工具格式的请求。
8. **准入**：只有满足第 2.6 节全部条件才冻结 v2；`historyMarker` 对开场轮和历史对比轮为假；`systemPrefixChars` 等于整段 system；
   宿主不提供 `hostTurnContext` 时冻结结果和今天相同。
9. **重放和恢复**：v2 执行中断后重放，`requestHash` 一致、不重复 claim；v1 执行原样重放；同一会话 v1→v2 过渡。
10. 现有 Runtime 和 BILL2 集成测试（`--runtime-only`、`--bill2-core-only`）在 CI 通过；新的集成用例放新文件。

### 7.2 付费实测（需要 Owner 批准，H1 合并后、B2 激活后才有意义）

推荐**先复用已批准的预算**，不另花钱：

- **B2 小评测**（已批准：70 次导师 + 30 次整理，硬上限 9 美元）：其中 10 个多字段场景每个 3 轮，正好有连续轮次。
  记录每次调用的 `prompt_tokens`、`cached_tokens`、`cache_write_tokens`、`usage.cost`、请求字节、和上一次的间隔。
  第一个带历史标记的请求同时确认 OpenRouter 接受它；如果被拒绝或返回 404，立即停止并报告，不重试。
- **B2+F1 的 staging 交互验证**（已批准：250 积分、80 次导师回合）：完整三步走查本来就包含换步骤和较长的对话。
  缓存数据由总控从回执只读分析，不增加调用。建议在交接里加一条"中途停顿 6–8 分钟后再继续一轮"，不增加次数上限。

如果上面两份数据不够（例如没有触发过期，或对话没长到裁剪），再做一次**专门实测**：

| 项目 | 内容 |
| --- | --- |
| 路径 | staging 定位导师页面，测试身份，Sonnet 5.5，由 Codex 做交互验证 |
| 场景 | 会话 A：同一步骤连续 10 轮（间隔都在 5 分钟内），然后停顿 6–8 分钟，再 2 轮；会话 B：6 轮，中间跨一次换步骤 |
| 次数 | 最多 20 次导师回合（每轮附带的整理调用另计，最多 20 次） |
| 积分上限 | 累计不超过 **200 积分**（按 q=100、m=3 约合 0.67 美元实际费用；#591 的 8 轮用了 87 积分） |
| 停止规则 | 第一次失败即停，不重试、不补样；结果不明就停 |
| 测试窗口 | 沿用当时的 staging 测试窗口；如果需要新建或调整窗口，属于 staging 数据变更，另行批准 |

### 7.3 通过标准

1. 带标记的请求被拒绝 0 次，回执冲突 0 次，所有调用 `usage.cost ≤ upperUsd`；
2. 同一步骤、非开场、距上一次请求开始不超过 5 分钟的轮次中，至少 90% 满足
   `cached_tokens ≥ 0.9 ×（上一轮的 cached_tokens + 上一轮的 cache_write_tokens）`，也就是上一轮读过和写过的这一轮都读到了；
3. 这些命中轮的 `cache_write_tokens` 不超过上一轮新增历史的 1.5 倍（只新写新增的那一段）；
4. 全部轮次（包括开场、过期、换步骤）的 Sonnet 合计 `usage.cost` 低于按同样 token 数推算的第一版费用；
5. 回复质量由 B2 小评测的门槛判断（出卡分寸、编造、格式等），不另设缓存专用的质量门槛。

第 1–3 条不通过属于技术问题，修复后重测（重新申请预算）；第 4 条不通过时不在正式环境启用 v2，把分项数据报给 Owner。

## 8. 风险分级、风险和需要 Owner 决定的事

### 8.1 风险分级

**high**：改变发往供应商的请求结构和字节、adapter 白名单、历史裁剪规则、冻结上下文；导师看到的提示词结构随之改变。
计费上限和扣费口径不变，不涉及数据库结构。H1 和 B2 都需要 Owner 批准合并。

### 8.2 风险和处理

| 风险 | 处理 |
| --- | --- |
| OpenRouter 不接受 user/assistant 消息上的 `cache_control`（Anthropic 官方支持） | 第一次真实请求就能发现，发现即停；adapter 只放行一种形状 |
| 状态挪到 user 消息后模型更不听话，或被用户文字干扰 | system 固定规则写明字段的权威性；B2 小评测覆盖，加一道伪装宿主的题 |
| 实际命中不如推算（断点位置、往前 20 个位置、思考强度变化） | 多轮前缀稳定测试 + 实测第 2、3 条标准 |
| 按块裁剪多删最早的对话 | 每次最多多删约 16 条；字段当前值在 scopeMaterial；见第 8.3 节第 3 项 |
| 过期重写随历史变长而变贵 | 第 3.4 节；用实测的停顿比例决定是否做 1 小时 |
| 重放字节不一致 | 只由冻结字段和冻结历史决定；重放测试；校验失败在 claim 前报错，不产生费用 |
| 隐私 | 缓存里现在会有用户的对话内容。Anthropic 按 workspace 隔离（经 OpenRouter 时是 OpenRouter 在该线路上的账号），只有前缀一字不差才命中，命中也看不到内容；5 分钟过期。对外条款文字不在本方案范围 |
| 和在途 PR 冲突 | 第 5.3 节的顺序；实施时以当时 `gh pr list` 为准 |

### 8.3 需要 Owner 决定的事

1. **顺序和拆分**：推荐 **H1 机制先做（Codex，等 #590 合并后开工，可和 B1 并行），B2 重写提示词时激活**，只做一次质量评测。
   其他选项：并进 B2 一次做完；B2 之后再单独做（要多评测一次）。
2. **1 小时缓存**：推荐**这次不做**，用 B2 评测和 staging 验证的真实停顿数据决定；停顿 5–60 分钟的轮次占 10% 以上时，
   再单独做（可以只给 system 用 1 小时）。
3. **付费实测**：推荐**复用 B2 小评测和 B2+F1 验证的已批准预算**，只在交接里加一次 6–8 分钟停顿，不增加次数和积分上限；
   数据不够时，再按第 7.2 节申请"最多 20 次导师回合、不超过 200 积分"的专门实测。

另外请 Owner 知悉（技术取舍，已按推荐处理，不需要回复）：长对话超过输入上限时，按块裁剪会比现在多删一些最早的聊天
（每次最多约 16 条历史，大约 3–8 轮）。

建议批准原话（可以直接复制）：
"PROMPT-CACHE-HISTORY 按方案推荐：先做 H1 机制、由 B2 激活；这次不做 1 小时缓存；付费实测先复用 B2 评测和 B2+F1 验证的预算。"

## 9. 为什么是最小正确改动（AGENTS 第 5 节）

- 考虑过的现有机制：#591 的冻结前缀和标记、`openRouterRequestBody` 唯一转换点、adapter 白名单、Superseded 投影、
  历史选择和冻结（`selected_history`）、session 修订号、`openRouterBound` 上限、`usage.cost` 结算。
  缺的只有四点：动态状态的位置、第二个标记的规则、裁剪的稳定切点、adapter 接受这个标记。
- 不新建表、迁移、RPC、服务、队列、配置项或框架；SQL 的条数窗口已经有 128 条余量，不用改。
- 权威来源不变：报价以冻结的 `providerLimits` 为准；实际费用以 OpenRouter 回执为准；是否加标记、标记在哪、历史切在哪，
  都只由冻结上下文和冻结的历史决定。
- 不用顶层自动缓存、不在历史之后插 system 消息：前者每轮都写读不到，后者的行为我们无法验证（第 2.2、2.3 节）。
