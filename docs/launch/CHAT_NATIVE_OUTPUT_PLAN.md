# CHAT-NATIVE-OUTPUT：对话原生体验方案（仅方案，high）

- 状态：第一版，待独立审查。只写方案，不改代码、SQL、配置。
- 依据：Owner 2026-10-03 在总控窗口的决定（总控记录在 #547 评论 5965354780）：
  全站对话统一流式输出；统一一个输出上限（报告也用，原 D1 并入）；写到上限或快超时时自动续写、用户无感；不按 Skill 区分。
- 代码基准：staging `34017395`。在途 PR 的事实按各 PR 当前描述读取：#553 第七版（head `135d4c19`，空提交）、
  #547 第七版（head `8fb950af`，空提交）、#601 第五版（`4c0c52a7`）、#593 B1（`fd210532`）、#598（`001d8b44`）、
  #594 联合候选（`3693d5a5`，含 #590）。行号均指 staging `34017395`，"#594 中"表示只在在途候选里存在。
- 风险：**high**（Runtime 执行流程、BILL2/PAYG 计费接线、Provider 请求形状、冻结上下文）。

## 0. 结论摘要

1. **流式**：服务端已经只有一个执行器（`executeOriginalExecution`），流式和非流式只差两件事：前端调哪个入口，准入时冻结哪种请求格式。
   收拢方法是让 runtime 页、选题页、plan 生成都改用现有 `runtime.executeStream`，并让新准入冻结流式格式。不新建传输或第二套执行器。
2. **统一上限**：每次模型调用的输出上限 O = min(全站上限, 模型能力, 报价上限, 上下文剩余)。
   全站上限沿用 Owner 已批准、现在代码里就有的 **8192**（`PURPOSE_OUTPUT_CAP`），不再分 interactive/report。
   "一篇回答"的长度不再由单次上限决定，而由"最多续写几段"决定。这是本方案唯一需要 Owner 定的数（第 9 节）。
3. **自动续写**：一次回答 = 同一个 execution 里的若干段调用。
   - 触发：上一段因输出上限停止（`finish_reason=length` 且有正文）。
   - 构造：每段的请求 = 原请求 + assistant（已写全文）+ 固定的宿主"继续"指令。不用 assistant 预填。
   - 时长：同一次 HTTP 时间不够写一整段时，不开新段，交给下一次 HTTP 接着写。前端自动发起，用户无感。
   - 复用：落点、继续入口、余额暂停都复用 PAYG PR-B 要建的 `waiting_resume` / `waiting_credits` 和断点机制，**不新增表、队列或状态机**。
4. **计费**：每段就是一次 PAYG v2 调用，按 #553 第七版冻结、过启动门槛 L、按名义费用结算。余额不足时停在两段之间，充值后从原处接着写。
   单次上限不变，所以单次 U、单次冻结、响应字节上限都不变。平台承担的风险也不会按段数放大（第 4.3 节）。
5. **顺序**：
   - C0 流式收拢、C1 统一上限：可以在 #594 合并后做。
   - C2 自动续写：必须在 PAYG PR-B 合并后做，因为它依赖 v2 逐次冻结和继续入口。
   - REPORT-GEN 的 R-B 排在 C2 之后。
   - 本方案不改 #547，只列出需要同步的地方（第 7 节）。

## 1. 现状（staging `34017395`，只读核对）

### 1.1 入口：哪些已经流式，哪些还没有

三个 tRPC 入口都进入同一个函数 `executeOriginalExecution`（`packages/api/src/services/runtime/executionStream.ts:31-69`），
再进入 `runtimeExecutor().execute`（`runtime/execute.ts:71`）。

| 入口 | 流式 | 前端调用方 |
|---|---|---|
| `opc.mentorTurnStream`（`routers/opc.ts:77-108`） | 是 | 定位页导师对话（`apps/web/src/app/positioning/[draftId]/page.tsx:193`） |
| `runtime.executeStream`（`routers/runtime.ts:92-97`） | 入口是流式；有没有文字流取决于冻结格式 | 定位页恢复（:940、:970）、plan 生成（:1405）、"继续"（:1947） |
| `runtime.execute`（`routers/runtime.ts:91`） | **否** | runtime 页：自由/Skill 对话 `send()`（`app/runtime/page.tsx:122,133`）、视频包 `runVideo()`（:181）、恢复（:200）、工作引导（:224-231）；选题页（`positioning/[draftId]/topics/page.tsx:152`，选题对话 :326-328、恢复 :400） |

- **传输**：tRPC v11 async-generator mutation，走 `httpBatchStreamLink`（`apps/web/src/trpc/provider.tsx:99-104`，只对上面两个流式 path 生效）。
  服务端路由是 `app/api/trpc/[trpc]/route.ts`，`maxDuration=300`。
- **事件**：`admitted → (phase|text)* → card? → result`（`shared/agentTurn.ts:139-160`）。
  每个 text 事件带"目前为止的全文"，节流到 100ms 一次（`executionStream.ts:77-111`）。
  客户端断开不会中断服务端执行。
- **是否真有文字流由准入冻结的格式决定**（`admission.ts:204`）：
  - 只有导师轮冻结 `agent-turn-v5-stream`；
  - 整理器冻结 `serial-tools-v6-reasoning`；
  - 其余（runtime 页、选题、plan）冻结 `serial-tools-v2`，是非流式请求。
  - 所以 plan 虽然走 `executeStream`，用户也看不到逐字输出。
  - runtime 页和选题页只靠 `runtime.view` 每 5 秒轮询拿结果（`runtime/page.tsx:59`，`topics/page.tsx:146-149`）。
- **Runtime 以外的模型调用**：
  - `workbench.generate`（`services/artifacts/generation.ts:97-135`，非流式，45 秒，要求 `finish_reason` 为 `stop`）。`/workbench` 页面仍可访问。
  - `agentSlice.executePhase`：只被 `/chat` 使用，而 `/chat` 已 307 跳到 `/positioning`（`next.config.ts:40`）。
  - 管理员试跑 `modelReasoning.tryOnce`。
  - 旧 `/api/ai/stream` 已停用（`LEGACY_CHAT_DISABLED=true`）。
  - 这些都不走 Runtime/BILL2，不属于本方案的"对话"（见 2.1 的范围说明）。

### 1.2 输出上限

- `PURPOSE_OUTPUT_CAP = 8192`（`bill2/responseCapacity.ts:2`）。响应字节上限由它推出：`OPENROUTER_RESPONSE_BYTE_LIMIT = 2×8192×8+8192 = 139264`（:5）。
  #547 §4 记录帧上限 `openRouterStream.ts` 为 `2×CAP+64`。
- `runtime/purposeBudgets.ts`：
  - 后台配置键 `system_settings.runtime_purpose_budgets`，按 interactive / organize / report 分别存 `inputBytes`、`historyItems`。
  - interactive 和 report 还各有 `maxOutputTokens ≤ 8192`；organize 的输出另用 `v3_summary_max_tokens`（128–4096，默认 2048）。
  - `frozenPurposeBudget` 只冻结 `{purpose, inputBytes, historyItems}`，**不含输出**。
  - `FROZEN_OUTPUT_CAP=128000` 只用于读旧数据。
  - 后台表单：`components/admin/MentorBudgetSettings.tsx`、`mentorBudgetDraft.ts`。
- **单次 max_tokens**：`outputCapacity`（`admission.ts:68-70`）= min(报价 `outputLimit`（真实）或配置值, `ai_models.max_tokens`, 整理器上限, 配置值或 20000)。
  - 结果冻结为 `context.maxOutputTokens`，由 runner 作为 SDK `maxTokens` 发出（`runner.ts:171`）。
  - adapter 强制 `max_tokens ≤ outputLimit`（`bill2/openRouterAdapter.ts:140-141`）。
- **模型能力（#597）**：管理员显式刷新时，catalog 的 `maxCompletionTokens`/`contextLength` 写回 `ai_models.max_tokens`/`input_limit`
  （`shared/modelCapacityView.ts:7-31`）。准入要求 `max_tokens ≥ 报价 outputLimit`（`admission.ts:57-64`）。

### 1.3 截断

- 服务端只把两种情况当截断，抛 `RUNTIME_OUTPUT_TRUNCATED`（`runner.ts:54-79`，流式 :115、非流式 :142-147）：
  - `finish_reason=length` 且**正文为空**、没有工具调用；
  - 新格式下 `length` 并带工具调用。
- 抛出后 `execute.ts:365-375` 执行 `runtime_cancel`，返回 `unavailable:'output_truncated'`。
- **缺口**：`finish_reason=length` 但**有正文**时被当作成功完成（`terminalAgentReply.ts:6,24-25` 也放行）。用户拿到的是一篇半截回答，没有任何提示。
  这正是续写要接管的位置。
- `OPC_CONTENT_OUTPUT_TRUNCATED` 是前端合成的字符串（`app/runtime/page.tsx:183`）。文案"已达到长度上限……不会自动重试"出现在 :68、:188。
  导师页的对应文案在 `agent-turn-display.ts:68-70`、`mentor-turn.ts:188-194`。
- "不自动重试"的出处：`shared/agentTurn.ts:125-129`、`docs/launch/AGENT_TURN_ENABLE_PLAN.md:197,420,499`；
  `FrozenCall.automaticRetry:false`（`bill2/service.ts:35`）；SDK `maxRetries:0`。本方案取代的是"截断后不续写"。
  **"不盲目重试结果不明的调用"不变**：续写是一次新的、已知前文的调用，不是重发。
- 另一种截断：v5 正文超过 `AGENT_TURN_MESSAGE_LIMIT=20000` 字符时被截短（`runtime/agentTurnResult.ts:10-12`）。这是显示长度限制，与模型无关。

### 1.4 时长

- staging 是 Hobby：函数 300 秒。`budget.ts` 规定 `RUNTIME_WORK_MS=265_000`、`RUNTIME_PERSISTENCE_MS=285_000`、`MIN_MODEL_DISPATCH_MS=60_000`。
- 单次供应商调用 `OPENROUTER_RESPONSE_TIMEOUT_MS=240_000`（`bill2/openRouterPolicy.ts:5`）。adapter 取 min(240 秒, 剩余时间)。
- 没有流空闲超时。剩余不足 60 秒时不派发新调用（`budget.ts:22-26`）。
- 正式运营已定用 Pro（Fluid 最长 800 秒）。#547 §4 已指出：升级套餐不会自动改掉代码里的 240/265/285 秒。

### 1.5 一个 execution 里的多次调用

- 已经支持：`limits.maxCalls ≤ 32`；每次调用用 `(runId, sequence, requestHash)` 先 claim 再 dispatch，回执按 sequence 落库。
- 重放时 SDK 重新执行，但每一步只读已存回执（`execute.ts:126-184`）。
- 现在的限制：
  - `live` 只在 `prepared→running` 那一次 begin 成立（`0106_runtime_sessions.sql:407-410`）。之后再来的 HTTP 只能重放，不能派发新调用。
  - `maxCalls` 和 v1 预扣在准入时就冻结了。
  - 流式 `partial` 在每次 exchange 开头清零（`execute.ts:286`），所以实时文字只显示当前这次调用。
- PAYG PR-B 会加上 `waiting_resume` / `waiting_credits`、断点（checkpoint/游标/epoch）和继续入口：
  原 execution + expectedCursor + epoch 的 CAS，只给未派发的下一次调用（#553 §4–§5）。

## 2. 全站统一流式（C0）

### 2.1 范围

- "对话"指：经过 Runtime 执行器、把模型正文显示给用户的所有回答。包括导师、选题、runtime 页的自由/Skill 对话、视频包、工作引导、plan、以后的报告。
- 新增 Skill 只要走 Runtime，就自动适用，不需要任何配置。
- 宿主内部的结构化调用不显示给用户，**不属于对话输出**，保持现状：附属整理器、匹配、搜索规划、只产出工具调用的轮次。
  这是按"输出给谁看"划分，不是按 Skill 划分。
- `workbench.generate` 不走 Runtime/BILL2，是独立的旧生成链路。由 LEGACY-CLOSE 决定去留；如果保留，迁到 Runtime 后自动适用本方案。
  本方案不为它另建流式。`/chat` 和 agentSlice 已经跳转停用，不处理。

### 2.2 做法

1. **前端**：runtime 页和选题页的 `runtime.execute` 改用 `runtime.executeStream`，复用定位页的 `readAgentTurn`/`LiveReply` 渲染和 #595 的恢复信封与轮询。
   `runtime.execute` 保留给旧客户端和重放，新页面不再调用。
2. **准入**：新准入的对话调用一律冻结流式格式。
   - 导师已经是 `agent-turn-v5-stream`。
   - runtime 页、选题、plan 冻结已有的 `serial-tools-v4-stream` 一类流式格式。具体选哪一个由实施 PR 按工具协议核对。
     只有现有流式格式都无法表达这些入口的工具约束时，才新增一个带版本号的流式格式，并且只是 `providerRequestFormat` 的一个新值。
   - 旧 execution 按冻结格式重放，字节不变。
3. **结果读取不变**：结构化结果（视频包分镜、选题卡片等）照旧在完成后由服务端解析和保存。流式只影响"边写边显示"。
4. **计费不变**：流式回执解析（`openRouterStream.ts`）已经在导师路径上线。流式和非流式的账单证据等价，这一点由 C0 的集成测试证明。

## 3. 统一输出上限（C1）

### 3.1 取值原则

每一次对话调用的输出上限：

```
O = min( 全站上限 CHAT_OUTPUT_CAP,
         ai_models.max_tokens（#597 同步的模型能力，管理员可下调）,
         报价 outputLimit（真实调用）,
         上下文剩余 contextTokens − T )
```

- `CHAT_OUTPUT_CAP` = 现有 `PURPOSE_OUTPUT_CAP` = **8192**，不提高。理由：
  1. 这是 Owner 在 PAYG 里已经批准的数（#553 Owner 决定 5）；
  2. 有了续写，回答长度不再受单次上限限制；
  3. 单次上限不变，所以单次 U、冻结额、`139264` 字节响应上限、帧上限、`bill2_calls`/回执容量都不用动，#547 §6 那整套按 O 重算的 R(O)/F(O) 也不再需要；
  4. 在 Hobby 的 240 秒内，8192 一段更有把握写完（第 3.3 节）。
- **思考 token**：OpenRouter 的 `max_tokens` 已经包含 reasoning（#553 §2）。思考多的模型，一段可见正文会少一些，由续写补上。
- 模型自身能力低于 8192 时自动取小值，续写会补足。以后换模型或新增 Skill 都不用配置。

### 3.2 旧的按用途设计如何收敛

- `runtime_purpose_budgets` 里 interactive 和 report 的 `maxOutputTokens` 不再参与新准入。
  - 后台表单改成只读显示"全站单次输出上限 8192"。
  - schema 升 version 2：去掉这两个输出字段，保留各用途的 `inputBytes`/`historyItems`。输入预算是"给模型看多少材料"，不是输出上限，不在 Owner 这次决定的范围内。
  - version 1 只读兼容。
- `frozenPurposeBudget` 本来就不含输出，不改。新准入在冻结上下文里照旧记录 `maxOutputTokens`（= 上面的 O），重放使用冻结值。
- `admission.ts` 的 `outputCapacity`：
  - 去掉"配置值"和"20000"这两项；
  - fixture 默认值 1000 只在本机测试路径保留；
  - 真实调用的报价 `outputLimit` 由报价流程保证不高于全站上限。
- 整理器（`v3_summary_max_tokens`）属于宿主内部结构化输出，不在"对话输出"范围内，保持现状。
  总控以后如果要把它也并成一个值，单独做一个小改动，不影响本方案。
- #547 R-A 原计划的"按用途返回上限、report-full 24576 profile"整体取消（第 7 节）。

### 3.3 和时长的关系

- 一段 8192 token 在 240 秒内写完，要求平均速度不低于约 35 token/秒。
- 首版主力模型（Claude Sonnet 5.5、Gemini 3.8 Flash、GPT-6 Luna）在 staging 实测中能否稳定做到，C2 必测会记录每段实际用时。这里不预设结论。
- 如果某个模型达不到，技术处理是把这个模型的 `ai_models.max_tokens` 调低（这是模型能力字段，不是按 Skill 配置），续写自动补足。不需要 Owner 决定。

## 4. 自动续写（C2）

### 4.1 概念

- 一次用户回答仍然是**一张 run、一个 execution**（PAYG：run = 逻辑操作，HTTP = 一次执行机会，call = 一次供应商请求）。
- 每一**段**是这个 execution 里的一次调用，有自己的 sequence、请求 hash、claim、回执和 PAYG v2 冻结与结算。
- 全文 = 各段正文按 sequence 顺序拼接。各段正文的**唯一权威来源是已落库的回执**（`runtime_response` 按 sequence 存的 rawBody）。
  不另存一份"拼好的全文"作为第二来源；最终 body 由 `complete` 时的拼接结果写入，和现在一样。

### 4.2 触发条件

在**文字回答阶段**（最终给用户看的正文这一次调用）结束时，满足以下全部条件才续写：

1. `finish_reason=length`；
2. 本段可见正文非空且有实际进展（去掉空白后 ≥ 1 个字符）；
3. 本段没有被截断的工具调用；
4. 已写段数 < 冻结的 `maxSegments`（第 9 节）；
5. 下一段请求放得进上下文（`T + O_min ≤ contextTokens`）；
6. 没有未知费用的调用（PAYG：出现未知 call 后不扩大外部调用）；
7. 没有取消请求，账号仍然有效。

不续写的情况：

- **正文为空的 length**：多半是思考把额度用完了。继续写也很可能重复花钱，所以保持现有的 `RUNTIME_OUTPUT_TRUNCATED` 失败路径。
- **截断的工具调用**：结构化参数不能拼接，保持现有失败路径。
- 条件 4 或 5 不满足：**正常完成**，已写全文作为回答保存，末尾加一行宿主提示"已达到单次回答的最长长度"。
  不报错、不丢内容。这种情况预计很少，触发时记日志，但**不建统计系统，也不把它当前置条件**。
- 条件 6、7 不满足：分别走 PAYG 的 `cost_pending` 和取消/注销路径（第 4.6 节）。

"快超时"不需要另设触发条件。它在调用边界上处理：

- 每一段开始前，如果本次 HTTP 剩余的工作时间 < `SEGMENT_DISPATCH_MS`，就**不在本次开新段**，按 PAYG 的 `waiting_resume` 落点，交给下一次 HTTP。
- `SEGMENT_DISPATCH_MS` = 单次供应商超时，即 240 秒；以后按实测每段最长用时加余量下调。
- 这一条同时取代现在只看 60 秒的 `MIN_MODEL_DISPATCH_MS`，用于对话正文调用。原来剩 61 秒也会开一次可能写 240 秒的调用，结果必然超时。
- Hobby（300 秒）下，结果是"每次 HTTP 最多写一段"；Pro 调大函数时长后，一次 HTTP 可以连写多段。代码不需要区分。
- **首版不在一段写到一半时主动中止供应商流。** 中止后供应商仍可能计费，回执会变成"结果不明"，在 BILL2 里属于高风险的新证据形态。
  如果实测表明某模型的一段经常接近 240 秒，先按 3.3 调低该模型的 `max_tokens`。
  只有调低也不够时，才另立方案做"中途收尾"，届时需要新的独立审查。

### 4.3 续写请求怎么构造

Claude 新模型不支持 assistant 预填（结尾是 assistant 的请求会被拒，或不被当作续写）。所以每段续写都是**新一轮**：

```
[ system（与第 1 段逐字节相同，含 #591 缓存标记）,
  历史（与第 1 段冻结的成员完全相同）,
  当前 user 消息（与第 1 段相同，含 #601 的 hostTurnContext）,
  assistant: 已写全文（第 1..k 段正文按顺序拼接，不含思考、不含工具调用）,
  user: CONTINUE_V1 ]
```

- `CONTINUE_V1` 是宿主固定指令，带版本号，放在共享常量里，进入冻结上下文和 `sourceHash`。大意是：
  - 上一条回答因长度中断，请从中断处直接接着写；
  - 不重复已写内容，不加开场白、过渡语或总结；
  - 如果停在未闭合的代码块、表格或列表里，就在里面接着写。
  - 它不是 Skill 指令，所有 Skill 共用。
- 工具定义与第 1 段相同（请求形状和缓存前缀稳定）。续写段如果改为调用工具（例如导师在结尾出提问卡），按现有工具流程处理；工具调用本身被截断时不续写。
- 请求由已落库的回执确定性地重建，所以重放时 hash 相同，只读回执，不会重发。
- **容量**：
  - 续写段的 B = 原请求字节 + 已写全文字节 + 指令字节。
  - 检查对象是模型上下文（`T + O ≤ contextTokens`），不是用途的 `inputBytes`。`inputBytes` 限制的是用户材料，模型自己写出的正文不受它约束。
  - #601 §2.4 第 8 条（逐调用过滤不再往后切）在续写段同样适用：放不下时不切历史，按 4.2 条件 5 正常完成。
- 拼接：
  - 段与段直接拼接。
  - 唯一的宿主处理：如果新段开头逐字重复了上一段结尾 ≥ 16 个字符，只去掉重复的那部分。
  - 除此之外不改写模型正文。
- 结构化回复（视频包分镜、选题卡片等）照样在拼好的全文上走原有的解析校验。校验失败走原来的"格式未通过"路径。
  不为某个 Skill 写特殊规则。

### 4.4 一次回答的流程

```
准入（冻结 maxSegments、CONTINUE_V1 版本、O）
→ 段 1：claim → dispatch → 流式输出 → 回执落库 → 结算
→ length 且满足 4.2？
   ├─ 否 → complete（全文 = 各段拼接）
   └─ 是 → 时间够一整段？
            ├─ 是 → 余额 ≥ L？
            │        ├─ 是 → 段 k+1（同一次 HTTP）
            │        └─ 否 → 落点 waiting_credits
            └─ 否 → 落点 waiting_resume → 前端自动发起继续 → 新一次 HTTP
```

- **落点**：结算第 k 段和写入"下一段可继续"的断点在同一次原子操作里完成（复用 PAYG §5 的规则）。
  断点只放引用：下一段序号、已写段的 sequence 列表、epoch。正文从回执读，不复制进断点，所以不碰断点 65536 字节的合计上限。
- **前端自动继续**：
  - `executeStream` 的 result 是 `waiting_resume` 时，前端立刻用原 executionId 调继续入口，不显示按钮或提示。
  - 新流的第一个 text 事件就是"已写全文"，然后接着出新字。用户看到的是同一个气泡继续往下写，中间可能有一两秒停顿，光标/打字动画保持。
- **服务端实时文字**：`execute.ts` 的 `partial` 改为"前 k 段全文 + 当前段"。text 事件仍然发全文，前端渲染逻辑不用改。

### 4.5 刷新、断线、多标签页

- **断线**：服务端不受影响，当前段照常写完、落库、结算。
  - 如果本次 HTTP 还有时间，并且是在同一次 HTTP 内连写，后续段也照常写。
  - 如果下一段需要新的 HTTP，就停在 `waiting_resume`，等客户端回来继续。
  - 不建定时器或后台 worker（与 PAYG "继续必须来自用户在原任务上的请求" 一致）。
- **刷新**：复用 #595。
  - 恢复信封在终态前不释放；`waiting_resume` 不是终态。
  - 页面回来后，`useAutoStepRecovery` 对这个 execution 调 `executeStream`。
  - 状态是 `waiting_resume` 时直接走继续入口；状态是 running（另一次 HTTP 还在写）时，按现有逻辑返回 pending 并继续轮询。
  - 刷新时正在写的那一段，在它完成前看不到新增文字（沿用 #547 §7 "只读已持久化的完整调用结果"）。已完成的段立刻可见。
  - runtime 页和选题页在 C0 接入同一套恢复。
- **两个标签页**：继续入口是 epoch CAS，只有一个能领到下一段；另一个只读，显示同一篇。
- **重放**：每段都有 sequence、hash 和回执。重复的继续请求只读回执，不重复派发、不重复扣费（PAYG 的幂等规则）。

### 4.6 取消、余额不足、注销、未知费用

- **用户停止**（对标原生"停止生成"）：
  - 正在写的那一段不中断供应商请求（现状：runner 不转发 signal）。这一段写完后照常落库、结算，但不再开新段。
  - 回答以"已写全文 + 已停止"保存，不丢内容。
  - 停在 `waiting_*` 时取消：直接收尾，已写全文保留。
  - 这一点改变了现在"取消 = 没有正文"的语义，只适用于新冻结了 `maxSegments` 的 execution。旧 execution 保持原样。
- **余额不足**（Owner 已定"暂停在两步之间、充值后继续"）：
  - 下一段在锁内检查 A < L 时，落点 `waiting_credits`，前端在已写全文下方显示"余额不足，充值后接着写"和继续按钮。
  - 这里需要用户点击：充值本身不授予生成权（PAYG）。
  - 继续后从第 k+1 段接着写，已写全文不变。
- **注销**：`waiting_*` 和进行中的执行按 #598 和 PAYG 的注销收尾处理。注销后继续入口拒绝，同一次 HTTP 内的下一段在 claim 时被拒。已结算的段保留账务。
- **未知费用**：某段结果不明（超时、回执缺失）时：
  - 不开新段（PAYG）。
  - 如果这一段的正文没有落库，回答以前 k−1 段全文加"内容和费用核对中"的状态显示，执行进入 `cost_pending`。
  - 不重发这一段，不估算补扣。

### 4.7 持久状态（AGENTS 第 5 节说明）

- 考虑过的现有机制：Runtime execution/回执（每段正文的权威来源）、PAYG 的 v2 call、`waiting_*` 状态和断点（落点与继续）、#595 的恢复信封与轮询（前端接续）。
- 这些已经覆盖续写需要的全部能力。**不新增表、RPC 家族、队列、定时器或状态机。**
- 只在现有 JSONB 里加：
  - **冻结上下文**加一个小字段：`continuation:{version:'continue-v1', maxSegments, instruction:'CONTINUE_V1'}`，随 `sourceHash` 冻结。旧 execution 没有这个字段，按"不续写"处理，字节不变。
  - **PAYG 断点**加：续写所需的引用（下一段序号、已写段 sequence 列表）。
- 唯一可能碰 SQL 的地方：`checkpoint_primary` / `complete` 对 body 有一致性约束（`0106:436-466`）。如果它要求 body 等于单次调用的结果，就需要放宽为"等于各段回执拼接"。
  这个改动随 PAYG 的同一张迁移或一张小追加迁移做，由 C2 实施时核对确定。

## 5. 计费（以 #553 第七版为准）

### 5.1 每段一次 PAYG v2 调用

每一段都是一次独立调用：

- 按本段最终请求重新计量 B、T、U、G；
- 余额封顶冻结 H = min(G, A)；
- 段前检查启动门槛 L；
- 按名义费用 n 结算，在 run 内累计进位（W/N/Δ）。
- 没有任何"一次回答"级的预扣。

### 5.2 用户承担和平台承担

- **用户为续写多付的钱**：主要是每段都要重新发送一遍输入（B 随已写全文增长），再加各段输出。
  - 按名义费用收费，缓存不抵扣（Owner 决定 12）。
  - 最坏情况下，一次回答的费用约为 `maxSegments` 次单次调用上界的总和，而且后面的段因为带着已写全文，输入更长。
  - 准确的积分算例要在 PAYG 定价函数实施后，按当时的价格快照算出，写进 C2 的 PR。这里不给可能过时的数字。
- **平台承担风险不会按段数放大**：
  - 余额封顶的损失只发生在 H < G 的那一段。这一段结算后余额接近 0，必然低于 L，下一段不会开始，而是进入 `waiting_credits`。
  - 所以一次回答在每次充值之间最多有一段被余额封顶。单次风险和今天"一次调用"相同。
  - 估算超界（`e_bound`）按 PAYG 规则：该模型退出收费准入，单段损失上限仍是这一段的 U − H。
- **L 怎么调**：
  - L 按"精确模型 + 用途"配置，取典型名义费用 P50（PAYG Q2：首版不自动更新）。
  - 续写段是写满上限的长段，名义费用高于典型值。但如上所述，余额封顶对每段只发生一次，所以**不需要为续写单设 L，也不需要新的用途键**。
  - 如果实施时总控认为续写段需要更高的门槛，可以复用 PAYG 现有的按用途键，加一个技术用途值，不需要 Owner 决定。

### 5.3 v1 计费路径

- C2 只在 PAYG v2 默认路径下启用续写。
- v1（run 级预扣 = maxCalls × 单次上界）在准入时就要为全部可能的段预扣，冻结会放大到原来的数倍，不适合。
- 所以 PAYG 默认切到 v2 之前，新准入冻结 `maxSegments=1`（等于不续写，但 C1 的统一上限仍生效）。

## 6. 和提示缓存的关系（#591 已合并，#601 方案）

- 续写段和第 1 段在同一个 execution 内，相隔几秒到几分钟，远在 5 分钟 TTL 内。
- **system 前缀**（#591 断点 1）：逐字节相同，命中缓存读取。Gemini、Luna 的隐式/自动缓存也会命中相同前缀。
- **历史前缀**（#601 断点 2）：续写段的历史成员与第 1 段冻结的完全相同，断点**保持在第 1 段的位置**（当前 user 之前的最后一条纯文本历史），因此"system + 历史"也命中读取。
  - 按 #601 §2.3 的通用规则，断点会后移到 assistant 已写全文上，触发一次 1.25 倍写入，而且下一轮当前 user 会被改成 Superseded 占位，这次写入无法跨轮复用。
  - 本方案规定续写段**沿用第 1 段的断点位置，不后移**。
- **adapter 白名单**：#601 §2.8 要求"标记和最后一条 user 之间只能是配对的工具调用/结果"，续写尾部 `[当前 user, assistant 已写全文, user CONTINUE_V1]` 不符合。
  - C2 在 adapter 增加**一种**严格形状：只在冻结了 `continue-v1` 时允许。
  - 尾部恰好是这三条：assistant 单个纯文本块、无工具调用；最后一条 user 等于冻结的指令。
  - 标记总数和位置规则不变。
  - H1 不需要为此改动。
- **不缓存的部分**：当前 user 消息和已写全文按普通输入计价，每段都重新发送。
  - 这只影响平台实际成本，不影响用户收费（名义费用）。
  - 如果实测表明长回答的续写成本明显偏高，再评估把断点放到已写全文上，属于技术决定。
- **报告**：#547 §2.3 以"每份报告通常只调用一次"为由不冻结 `promptCache`。续写后这个理由不再成立（每段都要重发约 91 KB 前缀）。
  建议 #547 同步时改为冻结 #591 的 system 前缀缓存（第 7 节）。

## 7. 和在途方案的顺序与写入协调

### 7.1 顺序

```
#594（含 #590）合并
  ├─ C0 流式收拢 ─┐（可与 H1 并行；admission.ts 冲突由后合并方同步）
  ├─ C1 统一上限 ─┘（可与 C0 合成一个 PR）
  ├─ #601 H1（execute.ts 先写方）
  ├─ #598 实施 → PAYG PR-A
  └─ #593 B1
PAYG PR-A 与 H1 都合并 → PAYG PR-B
PAYG PR-B 合并 → C2 自动续写（含前端接续）
C2 合并 → REPORT-GEN R-A（缩小后）/ R-B → PAYG 默认切 v2 → 打开续写（maxSegments 改为批准值）
```

- **C2 必须在 PAYG PR-B 之后**：它依赖 v2 逐次冻结、`waiting_*`、断点和继续入口。如果把续写塞进 PR-B，会让已经很大的 PR-B 更难审查。
  PR-B 实施时只需要知道"断点要能带一个续写引用"，本方案第 4.7 节已写明。
- **C0 不依赖 PAYG**。用户最先感受到的"边写边出"可以早上线。
- **C1** 只是把输出上限收成一个值，现有值已经是 8192，行为基本不变，也不依赖 PAYG。

### 7.2 文件重叠与写入负责人

| 文件 | 在途改动 | 本方案 | 处理 |
|---|---|---|---|
| `runtime/execute.ts` | #594、H1（先写）、PAYG PR-B（后写） | C2：多段循环、`partial` 拼接、落点 | C2 在 PR-B 之后，基于含 H1 和 PR-B 的 staging 开工，不并行写 |
| `runtime/admission.ts` | #594、H1、PAYG PR-B | C0：流式格式；C1：`outputCapacity`；C2：冻结 `continuation` | C0/C1 和 H1 都是小改动；后合并方同步并重跑准入测试 |
| `runtime/executionStream.ts` | #594、#593 B1（完成回调）、PR-B | C2：`waiting_resume` 结果 | B1 的 capture 只在**最终完成**时执行一次，不能每段一次；C2 必测 |
| `runtime/runner.ts` | #547 R-B（不写 Session 窄分支） | C2：length 有正文时交回宿主，不当成完成 | C2 先写，R-B 后写 |
| `bill2/openRouterAdapter.ts`、`runtime/providerRequest.ts`、`promptCache.ts` | H1 | C2：续写尾部形状 | C2 在 H1 之后 |
| `runtime/purposeBudgets.ts`、`MentorBudgetSettings.tsx`、`mentorBudgetDraft.ts` | #547 R-A | C1 | C1 先做；R-A 不再按用途拆输出 |
| `shared/agentTurn.ts` | #594、PR-B（等待积分状态） | C2：`waiting_resume` 自动继续 | C2 在 PR-B 之后 |
| `app/runtime/page.tsx`、`topics/page.tsx` | #594 | C0：改用 `executeStream`；C2：去掉截断文案 | C0 在 #594 合并后开工 |
| `bill2_*` / `runtime_execution` SQL | PAYG PR-A/B、#598、B1 0159 | 可能放宽 `complete` 的 body 约束 | 只能在 PAYG 迁移之后追加，编号按当时 staging 最大号 + 1 |

- 共享测试文件（`runtime.integration.ts`、`streaming.integration.ts`、`terminalReply.integration.ts`、`code-size-baseline.json`）照例由后合并方同步。
- 各 PR 开工时写明会碰哪些共享文件。

## 8. #547 需要同步的地方（定稿后由总控安排，本方案不改 #547）

- **D1**：作废。报告用全站统一上限 8192，长度靠续写。D2 的 U/G 按 O=8192 重算，三份样本额度相应变小。
- **§0.3**：去掉"D1 待决"。
- **§2.2**："单次全文就是这个 run 里的一次调用"改为"一份报告是一个 execution，可能有多段续写调用"。
- **§2.3**：缓存排除的理由不再成立，改为冻结 #591 system 前缀缓存（见第 6 节）。
- **§4**：
  - 删除 report-full 24576 profile 和"不能把截断当成功，只能改走分章"；
  - 删除"不自动追加续写调用"；
  - 210/270/300 秒目标改为引用本方案 4.2 的段间交接。
- **§6**：整张 R(O)/F(O) profile 表不再需要，响应和帧上限保持 8192 对应值。
  - 报告全文的 `bill2_close` 262144 字节存储上限要按 `maxSegments × 8192` 的最坏字节数核对（第 10 节必测）。
- **§7 持久化契约**：
  - "receipt 显示截断……不作为报告候选"改为"有正文的 length 触发续写；正文为空的 length 和截断的工具调用仍不作候选"；
  - 候选 = 各段回执拼接。
- **§8 取消/超时、§9 分章**：分章原本是 D1 不批准时的退路，有了续写后不再需要。§8 改为引用本方案 4.5–4.6。
- **§10**：U/G 表和 D2 金额按 O=8192 重算。
- **§11**：
  - R-A 去掉按用途输出上限的两条接线（由 C1 完成）；
  - 必测"report-full 24576 通过 / 24577 拒绝"和 R(O)/F(O) 的 +1 边界改为"统一 8192 通过 / 8193 拒绝"；
  - "截断不追加续写"改为续写必测；
  - 顺序上 R-B 在 C2 之后。
- **§12 风险第 2 条**按上述内容同步。

## 9. 需要 Owner 决定的事项

只有一项会影响成本和体验的产品数值。其余都是技术决定，由规划窗口和总控负责。

**Q1：一次回答最多自动续写几次？**

- 推荐 **3 次**（加上第一段共 4 段，输出总量最多约 32768 token。中文大约两到三万字，按模型和内容不同会有出入）。
- 理由：
  - 报告和长文案都在这个范围内（定位报告目标是 5000 字以内，一段通常就够）；
  - 次数有上限，能防止模型陷入"一直写下去"时无限花钱；
  - 达到上限时回答照样完整保存，只在末尾提示"已达到单次回答的最长长度"，用户可以接着发消息让它继续。
- 次数越多，单次回答最坏情况的费用越高（约为单次调用上界乘以段数，后面的段输入更长）。
- 单次调用上限保持已批准的 8192，不需要另外批准。

可以直接复制的批准话：

> 同意对话原生体验方案：单次调用上限保持 8192，每次回答最多自动续写 3 次。

## 10. 风险、回退、必测

### 10.1 风险

1. **续写质量**：模型可能重复、换语气或在结构中间接错。缓解措施：固定指令、去重规则、结构化结果仍然过原有校验。
   必测里要有中文长文、Markdown 表格和代码块跨段的样本。
2. **一段超过 240 秒**：会进入现有的超时 / `cost_pending` 路径，正在写的那一段内容丢失（已写段保留）。
   缓解：按实测调低慢模型的 `max_tokens`。"中途收尾"另立方案。
3. **段间停顿**：Hobby 下每段之间要多一次 HTTP，停顿约等于一次新请求加上首字时间。Pro 下多段可以在同一次 HTTP 里写完。
4. **成本**：每段都重发输入。这一点由第 6 节的缓存和 Q1 的段数上限约束，用户按名义费用付费。
5. **语义变化**：取消后保留已写内容，以及"有正文的 length 不再静默当作完成"。两者都只作用于新冻结了 `continue-v1` 的 execution。

### 10.2 回退

- 续写参数随 execution 冻结。要回退，只需代码常量把新准入的 `maxSegments` 改为 1，进行中的执行仍按各自冻结的值完成。
- 回退不删数据，不需要回滚 SQL。
- C0 回退：前端改回 `runtime.execute`；新准入改回非流式格式；旧 execution 照冻结格式重放。
- C1 回退：`outputCapacity` 恢复读取用途配置（version 1 数据仍可读）。
- 如果 C2 带了放宽 `complete` 约束的迁移，回退 SQL 草稿放在 migrations 之外，远程执行另取 Owner 批准。

### 10.3 必测（C0–C2 实施 PR 按各自范围执行）

- **流式**：
  - runtime 页对话、视频包、工作引导、选题、plan 都能边写边出；
  - 旧 execution 按原格式重放，字节不变；
  - 流式和非流式的账单证据等价。
- **统一上限**：
  - 8192 通过、8193 拒绝；
  - 模型能力低于 8192 时取小值；
  - 后台表单只读显示；
  - version 1 配置可读。
- **续写，单次 HTTP 内**：
  - length 有正文 → 第 2 段 → stop；拼接后的全文等于各段回执拼接；
  - 去重规则生效；
  - 流式 text 事件不断档、不回退。
- **续写多次**：
  - 写满 `maxSegments` → 正常完成并带上限提示；
  - 正文为空的 length 不续写；
  - 截断的工具调用不续写；
  - 下一段放不下上下文时正常完成。
- **时长上限**：
  - 剩余时间 < `SEGMENT_DISPATCH_MS` 时落点 `waiting_resume`；
  - 前端自动继续，用户侧无按钮；
  - 模拟 300 秒 Hobby 下 4 段跨 4 次 HTTP 能完整写完；
  - 记录每段实际用时（只记日志，不做统计系统）。
- **取消**：
  - 写到一半时停止，当前段写完后不开新段，已写全文保留并标记已停止；
  - 在 `waiting_*` 时取消，直接收尾；
  - 旧 execution 的取消语义不变。
- **刷新与断线**：
  - 刷新后已写段立即可见，当前段完成后补上；
  - 断线后服务端不中断；
  - 两个标签页只有一个领到下一段；
  - 重复的继续请求不重复派发、不重复扣费。
- **余额不足**：
  - 段间 A < L 时进入 `waiting_credits`，显示已写全文和继续按钮；
  - 充值后点继续，从下一段接着写；
  - 充值本身不触发生成；
  - 一次回答在两次充值之间最多一段被余额封顶。
- **注销**：`waiting_*` 和进行中的续写都按 #598/PAYG 收尾，继续入口拒绝，已结算账务保留。
- **未知费用**：
  - 某段回执缺失时不开新段，进入 `cost_pending`，不重发；
  - 前 k−1 段可见；
  - 名义费用和实际费用的未知都不能当 0。
- **计费**：
  - 每段一次 v2 call，有独立的 B/T/U/G/H 和 L 检查；
  - run 内累计只进位一次；
  - `C + E = N` 守恒。
- **缓存**：
  - 续写段的 system 和历史缓存都命中读取；
  - 断点不后移；
  - adapter 只接受冻结了 `continue-v1` 的那一种尾部形状，其余形状照旧拒绝。
- **B1**：capture 只在最终完成时执行一次。
- **容量**：
  - `maxSegments × 8192` 最坏字节数的全文能存进 `bill2_close`（262144）；
  - `AGENT_TURN_MESSAGE_LIMIT` 改为由段数推出的值，并带边界测试。

## 11. 本方案实际做过的核对

- `gh`/`git` 核对 staging head `34017395`，以及上述 open PR 的 head 和文件列表。
- 只读阅读 staging 代码（第 1 节所列文件和行号），以及 #553、#547、#601、#593、#598 的描述和相关评论
  （#547 评论 5965354780，#601 评论 5958482083）。
- 未改代码，未访问数据库，未调用模型或付费接口，未改配置。
