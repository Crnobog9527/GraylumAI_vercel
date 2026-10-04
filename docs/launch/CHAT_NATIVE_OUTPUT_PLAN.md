# CHAT-NATIVE-OUTPUT：对话原生体验方案（仅方案，high）

- **状态**：第三版已合并（#604）；第四版只修订 C0 的两项遗留问题（2.3 出卡回合流式、2.4 调用中重连），见第 12 节末尾。只写方案，不改代码、SQL 或配置。
- **第四版依据**：Owner 2026-10-05 授权解决 #604 记录（评论 5971006438）里的两项：出卡回合流式（P1 4173860195）和调用中重连的快照（P2 4173860204）。同一记录里的停止交接（P1 4173860200）属于 C2，不在本版范围。第四版的代码行号指 staging `c0b3de3f`。
- **首版范围**（Owner 2026-10-03 决定，总控记录在本 PR 评论 5970578413）：
  > 同意 #604 首版先不做自动续写：全站统一边写边显示，正式环境单次上限提高到 32768，写满时干净收尾并提示已截断；自动续写（最多 3 次）放到上线后的第二版。
  - 首版只做三件事：全站统一流式、统一单次上限、写满时干净收尾并提示已截断。
  - 自动续写整体移到第 13 节"第二版设计（不在首版实施）"。
- **依据的 Owner 决定（2026-10-03）**：
  - 立项（总控记录在 #547 评论 5965354780）：全站对话统一流式输出；统一一个输出上限，报告也用这个上限，原 D1 并入；不按 Skill 区分。
  - 修订（本 PR 评论 5968952542）：
    - 停止时先保存已写内容；
    - 选题页和视频包暂不做边写边显示，等内容创作对话驱动方案一起重做。
  - F1（本 PR 评论 5969177321）：
    - 正式环境 Pro 提高全站统一单次上限，32768 是首个候选，实施时核对费用和时间后定值；
    - staging 保持 8192；
    - 首版如实说明中途超时不能无感完成。
  - 首版不做续写（本 PR 评论 5970578413）：见上面"首版范围"。
- **审查意见**：独立审查（评论 5965539310）的 F1–F10，以及机器人七轮行内意见，都已处理，逐条对照见第 12 节。
- **代码基准**：staging `1563a44d`。
  - 从第一版的基准 `34017395` 到现在，staging 已合并：#594（含 #590）、#610（#601 H1，默认不激活）、#593（B1，0159）、#611（0160）、#613，以及 #598、#601 两份方案。
  - 在途 PR 按当前描述读取：#553 第七版（描述 SHA-256 `e431af20…`）、#547 第七版（`8fb950af`）、PAYG PR-A #617（`54e0f757`，目前只是任务初始化）。
  - PAYG 的能力都还没有实现，本方案把它们当作依赖，不当作现成保证。
- **行号**：均指 staging `1563a44d`。迁移文件只能追加，所以 `0105`/`0106` 的行号不会变。
- **风险**：**high**。涉及 Runtime 执行流程、Provider 请求形状、冻结上下文、`runtime_execution` SQL（C2 停止）。

## 0. 结论摘要（首版）

1. **全站统一流式（C0）**
   - 服务端只有一个执行器。一个回答是否边写边出，取决于准入时冻结的请求格式。
   - 回复按"可见正文由谁产生"分为三类（3.4）：
     - T1 纯文本（导师）：开场回合已经是流式；**可以出问题卡片的非开场回合现在完全缓冲**，C0 按 2.3 改为流式（正文边写边出，卡片在结束后出现）；
     - T2 模型写的 JSON 信封（定位页 `step` 回复）：C0 改为流式，只流公开的 `message`；
     - T3 其他结构化输出（plan 数组、runtime 页、选题页）：首版保持整段缓冲，完成后再显示。
   - **重连**（2.4）：服务端只给发起调用的那条流发中间文字，重连只重放终态，不新增持久状态。同一标签页刷新后，页面用 `sessionStorage` 显示刷新前已显示的部分（不再增长）加等待状态；新标签页或换设备只显示等待状态；写完后整段显示。重连体验已由 Owner 确认（第 9 节）。
2. **统一单次上限（C1）**
   - 计算方式：O = min(全站统一上限, 模型能力, 报价上限)，并且要放得进上下文。
   - 全站统一上限：staging 8192；正式环境提高，32768 是首个候选，实施时定值。
   - 不区分 interactive 和 report，也不按 Skill 区分。
3. **写满时干净收尾（C1）**
   - 模型因为单次上限停下、并且已经写出正文时，保存已写内容，结果标记 `completeness:'length_limit'`，界面在正文**外面**明确提示已截断（3.4）。
   - 这一点修正了现状里"写满后静默当作完成"的缺口。
4. **停止（C2）**
   - 用户点停止时，先原子地保存已写内容，再收尾，不走会丢弃正文的 `runtime_cancel`。
   - 正在写的那次调用照常按回执结算一次。
   - 首版每次回答只有一次正文调用，规则按"只有一段"写（第 4 节）。
5. **保存上限**：按实际序列化字节计量，永不超过 262144 字节，底层上限不改（4.3）。
   - 带附属整理器时，主回复在 checkpoint 之前先为整理器摘要留出空间；
   - 摘要超出预留时不保存摘要正文，标为未整理（4.3）。
6. **顺序**：
   - C0+C1 作为一个 PR，在 PAYG PR-B2 #632 合并后开工（#632 正在改 C0 要改的 `execute.ts`、`executionStream.ts`、`admission.ts`，7.1）；
   - C2（停止）在 PAYG PR-B 合并后开工；
   - 自动续写在上线后的第二版另行实施（第 13 节）。

## 1. 现状（staging `1563a44d`，只读核对）

### 1.1 入口：哪些已经流式，哪些还没有

三个 tRPC 入口都进入同一个函数：`executeOriginalExecution`（`packages/api/src/services/runtime/executionStream.ts:38`），
再进入 `runtimeExecutor`（`runtime/execute.ts:38`）。

| 入口 | 流式 | 前端调用方 |
|---|---|---|
| `opc.mentorTurnStream`（`routers/opc.ts:80`） | 是，导师冻结 `agent-turn-v5-stream` | 定位页导师对话（`positioning/[draftId]/page.tsx:194`） |
| `runtime.executeStream`（`routers/runtime.ts:96`） | 入口是流式；有没有文字流取决于冻结格式 | 定位页恢复、plan 生成、"继续"（`page.tsx:191` 包装） |
| `runtime.execute`（`routers/runtime.ts:95`） | **否** | runtime 页（`app/runtime/page.tsx:75`）：`send()` :132、`runVideo()` :162、`recover()` :234、`guide()` :261；选题页（`topics/page.tsx:153`，:316、:389） |

- **准入冻结的格式**（`admission.ts:227-229`）：
  - 导师：`agent-turn-v5-stream`；
  - 整理器，**以及带附属整理器的非导师主回复**：非流式 `serial-tools-v6-reasoning`；
  - 其余：非流式 `serial-tools-v2`。
  - 流式格式只有 `serial-tools-v3/v4-stream` 和 `agent-turn-v5-stream`（`providerRequest.ts:11-15`）；其中 v4 和 v5 必须冻结思考设置。
- **前端显示**：
  - runtime 页用 `displayReply`（`app/runtime/page.tsx:29-37`）在完成后解析选题 JSON 数组和视频包 JSON，再显示；
  - 选题页也是完成后解析；
  - 两页都靠 `runtime.view` 每 5 秒轮询（`runtime/page.tsx:66`，`topics/page.tsx:149`）。
- **截断工具调用的拒绝**只在 `firstToolCallOnly` 时生效（`runner.ts:56-59`）。这是 v5 的保证，不能直接推到 v2、v4 的工具路径上。
- **Runtime 以外的模型调用**不在本方案范围：
  - `workbench.generate`：独立旧链路，由 LEGACY-CLOSE 决定去留；
  - `agentSlice`：只被已经 307 跳走的 `/chat` 使用；
  - 管理员试跑；
  - 已停用的 `/api/ai/stream`。

### 1.2 输出上限

- `PURPOSE_OUTPUT_CAP = 8192`（`bill2/responseCapacity.ts:2`），响应字节上限 139264 由它推出。
- `runtime/purposeBudgets.ts`：
  - interactive 和 report 各有 `maxOutputTokens ≤ 8192`；organize 用 `v3_summary_max_tokens`（128–4096，默认 2048）；
  - `frozenPurposeBudget` 不含输出。
- 单次 max_tokens 由 `outputCapacity`（`admission.ts:75-77`）计算：取报价 `outputLimit`（真实调用）或配置值、`ai_models.max_tokens`、整理器上限、配置值或 20000 中的最小值。
  `realModel`（`admission.ts:64-71`）要求 `ai_models.max_tokens ≥ 报价 outputLimit`，否则拒绝准入。

### 1.3 截断

- `RUNTIME_OUTPUT_TRUNCATED` 只在两种情况下抛出（`runner.ts:73-79`，流式 :115，非流式 :145）：
  - 正文为空的 `length`；
  - `firstToolCallOnly` 下带工具调用的 `length`。
- 抛出后，`execute.ts:386-394` 调 `runtime_cancel`，返回 `unavailable:'output_truncated'`。
- **缺口**：有正文的 `length` 会被当作成功完成，`terminalAgentReply.ts` 也放行。用户拿到半截回答，没有任何提示。
- 前端文案"……不会自动重试"在 `app/runtime/page.tsx`（`OPC_CONTENT_OUTPUT_TRUNCATED`）和导师页的 `agent-turn-display.ts` 里。
- v5 正文超过 `AGENT_TURN_MESSAGE_LIMIT = 20000` 字符时会被截短（`shared/agentTurn.ts:42`）。

### 1.4 时长

- 路由 `maxDuration=300`（`app/api/trpc/[trpc]/route.ts:8`）。
- `budget.ts:6-9` 定义了三个值：`RUNTIME_WORK_MS=265_000`、`RUNTIME_PERSISTENCE_MS=285_000`、`MIN_MODEL_DISPATCH_MS=60_000`。
- 单次供应商调用 `OPENROUTER_RESPONSE_TIMEOUT_MS=240_000`（`bill2/openRouterPolicy.ts:5`），adapter 取 min(240 秒, 剩余时间)。
- 正式运营用 Pro（函数时长最长可配到 800 秒）。升级套餐**不会**自动改掉代码里的这些值。

### 1.5 一个 execution 里的多次调用和收尾 SQL

- **已支持多次调用**：`maxCalls ≤ 32`，每次调用先按 sequence claim 再 dispatch，回执按 sequence 落库，重放只读回执。
- **流式文字**：`partial` 在每次 exchange 开头清零（`execute.ts:296`），实时文字只显示当前这次调用。
- **`live`**：只在 `prepared→running` 的那一次 begin 时为真（`0106_runtime_sessions.sql:407-410`）。之后再来的 HTTP 只能重放。
- **`runtime_cancel`**（`0106`，唯一定义）：
  - 立即调用 `bill2_cancel`：把 prepared 状态的 call 改成 cancelled，并设置 `cancel_requested=true, closed=true`；
  - 接着调用 `bill2_finalize`；
  - 没有结果的 execution 被改成 `cancelled`。
- **`runtime_execution` 的 `complete` 分支**（`0106:449-466`）：
  - 遇到 `cancel_requested` 直接拒绝（`RUNTIME_EXECUTION_CANCELLED`）；
  - 否则依次调用 `bill2_close('delivered', p_result)` 和 `bill2_finalize`，写入 `result`。
  - 它检查"有 primary checkpoint 时最终 body 必须与它一致"（:452），**不要求** body 等于某一次供应商回复。
- **结果上限**：
  - `bill2_close` 拒绝序列化后超过 262144 字节的 `p_result`（`0105:309`，0156 重定义后仍是 `0156:165`）；
  - `checkpoint_primary` 同样是 262144（`0106:440`）；
  - Session item 有 262144 的 CHECK（`0106:40`）。

## 2. 全站统一流式（C0）

### 2.1 范围

- "对话"指经过 Runtime 执行器、把模型正文直接显示给用户的回答。以后新增的 Skill 只要走 Runtime，就自动适用，不需要配置。
- **本方案 C0 收拢**：
  - 定位页 `step` 用途的回复（有附属整理器时冻结 `serial-tools-v6-reasoning`，没有时冻结 `serial-tools-v2`，两者都是非流式）；
  - **可以出问题卡片的导师回合**（非开场回合）：冻结格式已经是流式的 `agent-turn-v5-stream`，但宿主压掉了它的全部文字进度，现在完全缓冲（2.3）。导师开场回合不带提问工具，已经是流式。
  - `step` 回复是模型直接写出的 JSON 信封：第一个字段是公开的 `message`，后面是私有协议字段。
  - 现有 `publicMentorText`（`runtime/progress.ts:7`）只把开头的 `message` 字符串流给前端，不会露出 JSON。所以这类回复可以边写边出。
- **首版不做边写边显示的结构化输出**（总控技术决定，列为首版限制）：
  - **plan 生成**：模型只返回 JSON 数组，`publicMentorText` 对它输出空白。
  - 首版保持**整段缓冲，完成后再显示**，冻结格式不变，不做流式、不续写；停止仍走现有 `runtime_cancel`。
  - 已核对 C0 目标里的其他路径：定位页只有 `mentor`、`step`、`plan` 三种用途（`opc/service.ts` 的准入），除 plan 以外没有其他非信封的结构化输出。
- **暂不收拢**（Owner 2026-10-03 决定）：runtime 页的自由/Skill 对话、视频包、工作引导，以及选题页。
  - 原因：这些回复里有协议 JSON（选题数组、视频包对象），现在靠完成后的 `displayReply` 解析或隐藏。
  - 直接复用导师页的纯文本实时气泡，会在写的过程中把半截 JSON 露给用户。
  - 这些页面的交互会被 CONTENT-CONVERSATION-DRIVEN 方案整体取代（自由对话 + 按意图加载 Skill），届时按本方案的统一机制接入流式和续写。
  - 在那之前，这些入口保持写完再显示，冻结格式不变。
- **宿主内部的结构化调用**（附属整理器、匹配、搜索规划、只产出工具调用的轮次）不显示给用户，不属于对话输出，保持现状。这是按"输出给谁看"划分，不是按 Skill 划分。

### 2.2 做法

0. **前置**：#594 已合并（`2259e895`）。C0 回归 #594 的闸门行为：
   - 未准入的 held、429、各类 503、结果未知时，不自动重新准入；
   - 确定的结构化 4xx 按现有 abandon 规则释放；
   - 首次调用闸门取消时显示固定提示。
1. **准入**：对于定位页 `step` 用途的回复，新准入冻结已有的流式格式（`serial-tools-v4-stream`）；plan 不变。
   - 同时冻结与它匹配的思考设置（v4 属于 `REASONING_FORMATS`），附属整理器保持非流式。
   - 现有流式格式只要有一种无法表达这些路径的工具约束，实施 PR 就停下报告，不自行新增格式。
2. **前端**：`step` 回复已经通过 `executeStream` 调用，补上与导师相同的 `LiveReply` 渲染即可。实时文字只来自 `publicMentorText` 的 `message` 投影。
   - `publicMentorText` 现在把实时文字截到 4000 字符（`progress.ts`），对冻结了新上限的 execution 改为按 4.3 的保存上限约束。
3. **增量传输**（首版必做，是放开单次上限的前提）：
   - **问题**：现在每个 text 事件都带**累计全文**，每 100ms 发一次（`executionStream.ts` 的 `TEXT_EVENT_INTERVAL_MS`）。服务端每收到一个片段，还要把累计原文重新解析一遍（`publicMentorText`、`publicAgentText`）。单次上限提高到 32768 后，传输量和解析量都会随回答长度按平方增长。
   - **新事件**：对冻结了新上限的 execution，改发 `{type:'textDelta', offset, text}`。
     - `offset` 是这段增量之前已经发出的可见正文码点数，`text` 是新增部分；
     - 服务端在节流间隔内把多个片段合并成一个增量，仍然是每 100ms 最多一次，总传输量与回答长度成正比；
     - 旧 execution 和旧客户端继续使用原来的 `text` 全文事件，不变。
   - **服务端增量解析**：`publicMentorText` 改为保留扫描位置的增量解析器（只处理新到的原文），`publicAgentText` 同理，避免每个片段都重新扫描全文。
   - **快照**：`offset:0` 的事件一律是完整快照，客户端用它**替换**整个实时气泡（不是追加）。服务端发快照时，节流窗口里还没发出的增量一并丢弃，不在快照之后补发。快照只在三种时候发：流的第一个文字事件；可见正文的来源切换（2.3 出卡回合从助手文字切到卡片 `message`）；收尾时权威可见正文与已发出的内容不一致（例如卡片参数无效时改为固定提示）。每次替换型快照把事件里的 `rev`（从 0 开始）加 1，增量事件带当前 `rev`。
   - **客户端**：`rev` 相同且 `offset` 等于本地已显示的码点数时追加；否则丢弃这一帧，停止追加，等待下一个快照或 `result`。同一条流是单个有序的 HTTP 响应，正常情况下不会出现漏帧；出现不一致说明有缺陷，前端只停止增长，不主动重新调用 `executeStream`（调用进行中重新调用只会拿到 `pending`，见 2.4）。
   - **结束**：`result` 之前，服务端保证客户端最后显示的内容等于权威可见正文（一致就不再发，不一致就发一个快照）。
   - **重连**：只有发起调用的那条流有中间文字；重连规则见 2.4。
   - 停止用的 `stopAt` 取客户端已显示的码点数（4.2），和增量的 offset 是同一种计数；C2 实施时一起提交当前 `rev`，`rev` 与服务端不一致时的处理由 C2 定义（2.3 末尾）。
4. **T2 的"message 在第一个"约定**：
   - `publicMentorText` 只认 `{"message": "...` 开头的输出。新准入在冻结上下文里加 `envelopeOrder:'message-first-v1'`；
   - T2 的提示词和输出 schema 说明都写明"`message` 必须是第一个属性"。
   - 完成时，宿主检查原始 body 是否以 `{"message":` 开头（与 `publicMentorText` 用同一个正则）。
     - 不符合时**不判为失败**（避免把内容正确的回复变成错误）；
     - 这次回复写的过程中本来就没有实时文字，退回到"完成后再显示"；
     - 结果元数据记 `messageFirst:false`，只用于日志排查，不做统计系统。
   - 不符合约定的回复写的过程中没有可见正文；这时点停止，`stopAt=0`，按 4.2 (e) 处理。
5. **重放**：旧 execution 按冻结格式重放，字节不变。
6. **计费**：不变。流式回执解析（`openRouterStream.ts`）已在导师路径上线。C0 的集成测试要证明流式和非流式的账单证据等价。

### 2.3 可以出问题卡片的导师回合（第四版新增）

**现状**（staging `c0b3de3f`）：
- 非开场导师回合冻结 `agent-turn-v5-stream`，准入给了五字段提问契约（`questionContract`）和 `ask_question` 工具。
- 五字段契约下，出卡回合的公开正文写在工具参数的 `message` 里，不在助手文字里：
  - 收尾时只要模型调用了工具，`agentTurnResult` 就用参数里的 `message`，丢弃调用之前的助手文字（`agentTurnResult.ts`）；
  - `streaming.integration.ts` 的 five-field 用例里，调用前的助手文字 "Separate assistant text" 不会被保存。
- 所以宿主在"五字段 + 提问工具"的组合下压掉了全部文字进度（`execute.ts:318`），供应商结束后才一次发出权威文字和卡片（`execute.ts:396-401`）。
- 结果：模型最后只写了纯文字、没有出卡时，也要等到结束才显示。

**做法**（推荐：正文边写边出，卡片在结束后出现）：
1. **不改请求**：冻结格式、工具 schema、五字段契约和请求字节都不变；账单、Session、重放不受影响。只改宿主的进度投影。
2. **投影规则**：实时显示的是"权威可见正文"的前缀，与收尾时 `agentTurnResult` 的规则一致：
   - **还没有出现工具调用时**：可见正文是助手文字（`publicAgentText`），边写边出。模型最后没有出卡时，它就是最终正文。
   - **出现第一个 `ask_question` 调用（index 0）的参数增量后**：可见正文切换为该调用参数里顶层 `message` 字符串已经解码的前缀。
     - 宿主在 primary exchange 的帧回调里只读旁路读取参数增量，不改帧。`runner.ts` 已经只把 index 0 的调用交给 SDK（`firstCallFrame`），投影只看同一个调用。
     - 用增量 JSON 扫描器（保留扫描位置，只处理新到的参数片段）找顶层 `message` 键，逐段解码它的字符串值。转义、`\u` 和代理对跨片段时，等下一段再解码，规则与 `publicMentorText` 相同。
     - `question`、`options`、`recommended`、`recommendationReason` 和原始 JSON 一律不发出。
   - **切换时机**：解码出的 `message` 前缀**非空**时才发 `offset:0` 快照（2.2 第 3 项），`rev` 加 1。
     - schema 里 `message` 排在 `question`、`options`、`recommended` 后面，第一段参数增量到达时 `message` 前缀通常还是空的；在那之前保留原来显示的文字，不先清空气泡。
     - `message` 始终为空（例如参数无效）时不切换，由收尾快照纠正。
     - 工具说明要求把完整的公开回复写进 `message`（`agentTools.ts` 的 `askQuestionTool`）。模型仍然先写了助手文字时，这段文字在切换时被卡片的 `message` 替换。
     - 这与保存的结果一致：这段文字本来就不会保存，实时继续显示它反而会出现"看到了、刷新后消失"。
   - **卡片**：不在写的过程中出现。供应商结束、`agentTurnResult` 校验通过后，按现有顺序先保证最终文字一致（必要时发快照），再发 `card` 事件。
   - **卡片参数无效**：没有卡片；可见正文按现有规则（参数里合格的 `message`，否则固定提示 `INVALID_REPLY_NOTICE`），不一致时用快照收尾。
3. **粒度取决于线路**：工具参数是否逐段到达由供应商决定。参数一次性到达的线路，出卡回合退化为"结束时整段出现"（与现在相同），不报错。C1 实测三类主力模型时一并记录参数是否逐段到达，只记日志，不作为验收门槛。
4. **字段顺序**：五字段 schema 里 `message` 排在 `question`、`options`、`recommended` 之后（`agentTools.ts:42`）。
   - 扫描器不依赖字段顺序；
   - 模型按 schema 顺序先写问题和选项（最多约 1500 字符）时，正文要等这部分写完才开始出现；
   - 不为此改 schema 顺序（见下面的备选）。
5. **适用范围**：只对冻结了新上限的新 execution 生效（与 `textDelta` 同一标记）；旧 execution 重放时的显示不变。开场回合本来不带提问工具，不受影响。
6. **截断**：带工具调用的 `length` 仍走现有失败路径（3.4"不变的失败路径"）。写的过程中已显示的 `message` 前缀由失败提示替换，不保留为正文。
7. **停止（只记录给 C2 的约束，本版不实施）**：
   - 出卡回合的可见正文按本节的投影计量，`stopAt` 和 `rev` 一起提交；
   - 停止时服务端的 `rev` 已经变化（用户看到的是切换前的助手文字），C2 必须定义处理并补测试，推荐按"没有可保存的可见正文"处理，即 4.2 (e)；
   - 截断时 `card=null` 的规则不变（4.2）。

**被否决的备选**：
- **出卡回合仍然完全缓冲**：多数非开场导师回合都可以出卡，等于大部分导师回答不流式，违背 Owner"全站统一流式"的决定。
- **只流助手文字，出卡时整段换成卡片 `message`**：五字段契约下出卡回合的正文本来就在参数里，助手文字通常为空，等于出卡回合仍然缓冲。
- **把助手文字和卡片 `message` 拼接保存**：改变已定的权威正文规则（模型常把同一段话写两遍），也改变已存结果的含义，不在本任务范围。
- **改 schema，把 `message` 排第一**：需要新的契约版本，改变工具定义字节和提示缓存前缀，收益只是省掉问题和选项那一小段的等待。

### 2.4 调用进行中重连（第四版新增）

**现状**：
- 实时进度只在发起调用的那次 HTTP 的内存里（`executionStream.ts` 的 `streamOriginalExecution`，注释写明断开只丢显示进度）；SQL 在调用结束后才收到回执和结果。
- 第二个 `executeStream` 拿不到 `live`（`0106:407-410`），调用还在进行时立即返回 `{state:'pending'}`（`execute.ts:486`、`:496`）。
- 定位页已有处理（#595）：保留请求信封，每 2 秒读一次历史（`HISTORY_POLL_MS`），执行结束后自动用同一个幂等恢复取回结果；期间显示用户消息和等待状态，不出大卡片。
- 所以第三版"重连时第一个事件是当前快照"的承诺没有数据来源。

**做法**（推荐：服务端缩小承诺，只有发起调用的流有中间文字，重连只重放终态；同一标签页用浏览器会话存储保留已显示的部分）：
1. **发起调用的流**：第一个文字事件是 `offset:0` 快照，之后是增量，结束前保证一致（2.2 第 3 项）。
2. **服务端**：调用进行中重连（刷新、关闭后重新打开、断网后重新调用）时不发文字事件，照现有行为立即返回 `pending`。不新增持久状态，不新增接口，不需要迁移。
3. **页面保留已显示的前缀**（Owner 已确认，第 9 节）：
   - 发起调用的页面把当前 execution 已经显示的可见正文前缀和当前 `rev` 存进 `sessionStorage`。#595 已经用 `sessionStorage` 保存 step 信封（`step-recovery.ts` 的 `readStepEnvelopes`），这里用同一种存储，键带 `draftId` 和 `executionId`。
   - 只存已经显示给用户的文字，不存卡片、问题、选项和私有字段。
   - 普通增量随文字事件节流写入（例如最多每秒一次）。**替换型快照（`offset:0`、`rev` 变化）不受节流**：页面先同步写入新的前缀和 `rev`，再显示这个快照；写入失败时先删除存储项再显示。这样刷新后不会恢复已经被替换掉的文字。
   - 执行到终态、最终结果显示后删除这一项。存下的前缀只用于显示，不提交给服务端，也不作为结果的来源；SQL 结果仍是唯一权威。
   - 读写失败（隐私模式、存储已满）时按"没有保存"处理，不报错。
   - **只在原标签页重新加载时恢复**：复制标签页或由本页打开的新窗口会按 HTML 标准拷贝 `sessionStorage`，只靠 `draftId` 和 `executionId` 的键分不出来。做法：
     - 发起调用的页面在 `pagehide` 时写一个"即将重新加载"标记（带写入时间）；
     - 页面加载时只有读到这个标记、且写入不超过 10 秒，才恢复前缀，并立即删除标记；
     - 没有标记、标记过期时不恢复，删除本标签页里拷贝来的前缀，只显示等待状态。
     - 复制标签页、`window.open` 拷贝存储时，原页面还没有触发 `pagehide`，拷贝里没有标记，所以不会恢复。
4. **页面显示**（Owner 已确认，第 9 节）：
   - **同一标签页刷新**：先显示存下的前缀（不再增长）和等待状态；写完后用最终结果替换（含截断提示和卡片）。
   - **同一页面断线（没有刷新）**：已经显示的部分留在气泡里、不再增长，同时显示等待状态；结束后由完整回答替换。
     - 实现时要改 `page.tsx:167`：现在恢复已有 execution 时 `startLiveReply` 会先清空实时气泡，要改为保留已有前缀（或从 `sessionStorage` 恢复）。
   - **新标签页、换设备或没有存下前缀**：只显示用户消息和现有的"导师正在回复"等待状态，写完后整段显示。
   - 存下的前缀与最终结果不同（例如出卡时被替换、带工具调用的截断失败）时，最终结果直接替换，不另外提示。
   - 不显示"连接已断开"之类的大卡片，沿用 #595 的无感恢复；自动恢复用尽时沿用现有的单行"重试"。
   - 停止（C2 约束）：从存下的前缀恢复的页面点停止时，`stopAt` 和 `rev` 取存下的值。
5. **已完成的 execution 重放**：只发一个完整快照，然后是 `result`。
6. **影响**：O=32768 时一次回答可能要写几分钟。同一标签页刷新后能看到刷新前的部分，但不再增长，要等写完；新标签页或换设备要等写完才看到内容。发起调用的那条流不受影响。

**为什么不持久化或共享当前投影**（AGENTS 第 5 节）：
- 现有机制已经能正确完成重连：SQL 结果仍是唯一权威，#595 的轮询和幂等恢复已经上线。缺的只是"重连期间的中间文字"，属于显示体验，不影响结果和计费。
- **持久化投影**（每隔几秒把可见正文写进 `runtime_execution` 或新表）：需要追加迁移和新的写入动作，属于 high 的 SQL 变更；写入量随回答长度增长；经 `runtime_execution` 写入要依次锁会话、执行和 `bill2_runs` 三行（`0106:398-400`），会在调用进行中和计费写入争锁；还要定义它和最终结果不一致时以谁为准，等于多了一份正文。重连后的显示也只是几秒一跳。
- **共享投影**（Redis 或 Supabase Realtime 广播，加一个当前快照键）：新的共享基础设施，要处理鉴权、过期和跨函数实例订阅，超出首版需要。
- **让重连的请求等着"接管"原来的流**：不同函数实例之间没有共享内存，做不到；只能等到结束，结果和现在的 `pending` 加自动恢复一样，却多占一个长连接。
- 上线后如果实际使用表明重连期间等待太久是真实问题，再单独立项，届时按第 5 节说明最小缺口。

## 3. 统一输出上限（C1）

### 3.1 取值原则

```
O = min( 全站统一上限 CHAT_OUTPUT_CAP（按环境取值）,
         ai_models.max_tokens（#597 同步的模型能力）,
         报价 outputLimit（真实调用） )
```

- 同时要求 `T + O ≤ contextTokens`（T 的定义见 #553 §2）。放不下时 O 取能放下的较小值；仍然放不下时，按现有的容量错误在 claim 之前拒绝。
- **按环境取值**（Owner 2026-10-03 决定 F1）：
  - **staging（Hobby，函数 300 秒）**：8192，即现有 `PURPOSE_OUTPUT_CAP`，也是 #553 已批准的值。
  - **正式环境（Pro）**：提高。32768 是首个候选，**实施时核对费用和时间后定值**，正式值在正式发布前按第 10 节的上线批准流程确认。
  - "统一"指同一个环境里所有对话、所有 Skill 用同一个值；值本身按环境不同。
  - 取值放在代码常量里，按现有部署环境标识选择，不新增后台配置或运行开关。
- **提高上限必须一起改的东西**（C1 实施时按 #547 §6 的 R(O)/F(O) 方法推导，同一个候选一起交付）：
  - 响应接收上限 `OPENROUTER_RESPONSE_BYTE_LIMIT = 2×O×8+8192`：O=32768 时为 532480；
  - 帧上限 `2×O+64`；
  - 回执 `bill2_receipts.payload` 的 524288 上限（`0105:40`）：
    - 现有 adapter 对流式回执做 gzip，超过时会以 `rawBodyOmitted:'receipt_size_limit'` 省略原文（`openRouterAdapter.ts:112`、`openRouterEvidence.ts:38`）。
    - 重放（以及第二版的续写）都以回执原文为权威，所以必须证明：在选定的 O 下，回执原文**不会被省略**。
    - 证明不了就降低候选值。如果确实需要提高 524288，那是单独的 high 迁移，交 Owner 另行批准，不默认采用。
  - **时长**：
    - 单次供应商超时 `OPENROUTER_RESPONSE_TIMEOUT_MS`（现为 240 秒）、SDK 包装超时、`RUNTIME_WORK_MS`/`RUNTIME_PERSISTENCE_MS` 改为由该环境的函数时长推出；
    - 路由 `maxDuration` 在 Pro 上配置到所需值（最长 800 秒）。
    - Vercel 套餐和函数时长属于 provider 配置，按 AGENTS 第 10 节另取批准。
  - **PAYG**：O 变大后，单次 U、G 的输出项按比例增大，所以 #553 已验证的 profile 必须覆盖选定的 O；正式值不能超出已验证的范围。
- 单次 U、G、H 也会随每段请求变长而变化（后面的段要重发更长的已写全文），按 PAYG 规则每段重新计量。
- `max_tokens` 包含思考 token（#553 §2）。思考多的模型，可见正文会少一些；写满时按 3.4 收尾。
- **参考**：OpenAI 开源的 Codex 不设单次输出上限，`incomplete` 按错误处理，不自动续写；长内容通过工具写文件交付，全文存在本地文件，不受数据库上限约束。
  首版和它一样不自动续写，写满时明确提示已截断（3.4）；不同的是 Graylum 的回答保存在数据库里，受 262144 字节上限约束（4.3）。自动续写放在第二版（第 13 节）。

### 3.2 旧的按用途设计如何收敛

- **用途预算**：`runtime_purpose_budgets` 里 interactive 和 report 的 `maxOutputTokens` 不再参与新准入。
  - schema 升到 version 2：去掉这两个输出字段，保留各用途的 `inputBytes` 和 `historyItems`；
  - version 1 只读兼容；
  - 后台表单只读显示当前环境的"全站单次输出上限"。
- **`outputCapacity`**：去掉"配置值"和"20000"这两项；fixture 默认值 1000 只在本机测试路径保留。
- **整理器**（`v3_summary_max_tokens`）是宿主内部输出，保持现状。
- **#547 R-A**：取消按用途拆输出上限。R-A 里的输入容量和冻结读取工作保留（第 8 节）。

### 3.3 和时长的关系

- **粗算**（只作参考，忽略了排队、首字前思考、网络和收尾，**不是**完成保证）：
  - staging：8192 token 在 240 秒内写完，约需 34 token/秒；
  - 正式环境：32768 token 在约 700 秒内写完，约需 47 token/秒。
- **正式值**：实施时按三类主力模型的实测速度确定。候选值写不完的，就降低全站值，不按模型或 Skill 另设。
- **首版限制**（Owner 已同意如实说明）：
  - 一次调用写到一半超时（超过单次供应商超时，或者函数到期），首版**不能无感完成**。
  - 这次调用会进入现有的超时和 `cost_pending` 路径，这次的内容丢失。
  - 界面要如实显示"这次回答没能完成"，不能假装完成。
  - 首版不在一次调用写到一半时主动中止供应商流：中止后供应商仍可能计费，回执会变成"结果不明"，在 BILL2 里属于高风险的新证据形态。
  - 以后如果要做"中途收尾"，需要另立方案并经独立审查。
- 第一版提出"把慢模型的 `ai_models.max_tokens` 调低"，这条已撤回：`realModel` 要求 `max_tokens ≥ 报价 outputLimit`，单独调低会让这个模型无法通过准入。

### 3.4 写满时干净收尾（首版，C1）

**三类回复**（"可见正文由谁产生"；4.2、4.3 共用）：

| 类别 | 例子 | 流式 | 写满（有正文的 `length`）时 |
|---|---|---|---|
| **T1 纯文本**：模型直接写正文 | 导师（v5，宿主再把正文封进信封） | 是 | 保存已写正文，`completeness:'length_limit'`，正文外提示已截断 |
| **T2 模型写的信封**：模型输出 JSON 对象，公开字段是 `message`，其余是私有协议字段 | 定位页 `step` 回复（含带附属整理器的主回复） | 是，只流 `message` | JSON 没有写完，不能保存为合格的信封；走现有的"回复格式无效"路径，界面提示"回答达到长度上限，未能完整生成"。正式环境单次上限提高以后，这种情况很少发生 |
| **T3 其他结构化输出** | plan 的 JSON 数组；暂不收拢的 runtime 页和选题页 | 否，整段缓冲 | 沿用各自现有的"未完成"处理；页面原有的"不会自动重试"文案改为"已达到长度上限" |

- **"信封"的统一定义**：结果 body 是一个 JSON 对象，公开字段是 `message`。T1 导师的宿主信封（`agentTurnBody`）和 T2 模型写的信封都算。凡是信封，计量、截断、校验都只针对 `message`，其余字段原样保留，重建后用该格式**正常完成时的同一个**校验函数检查（4.2、4.3）。
- **不变的失败路径**：
  - 正文为空的 `length`（多半是思考用完了额度）：保持现有的 `RUNTIME_OUTPUT_TRUNCATED` 失败路径；
  - 截断的工具调用：同上。
- **T1 的收尾做法**：
  - `runner.ts` 不再把有正文的 `length` 当作普通完成，而是把结束原因交回宿主；
  - 宿主照常走 `complete`，结果 `kind:'usable_result'`，元数据 `completeness:'length_limit'`；
  - 完整回答为 `completeness:'complete'`；
  - 只对新准入、冻结了新上限的 execution 生效，旧 execution 照原样重放。
- **状态标记**：结果元数据 `completeness`。
  - 首版取值：`complete`、`length_limit`，以及停止时的 `stopped`（4.2）。
  - 依赖"完整成果"的消费者（报告候选、结构化解析、B1 capture）只采用 `complete` 的结果。
- **提示文案和位置**：
  - 位置：显示在回答气泡**下方、正文外面**，和现有固定通知同一位置（导师页 `agent-turn-display.ts` 的通知区，定位页 `step` 回复同一组件），不写进正文，所以不会破坏结构化解析。刷新后从结果元数据重新显示。
  - T1 文案："这次回答达到单次长度上限，已在这里结束。需要的话，可以发送'继续'让我接着写。"
  - T2、T3 文案："这次回答达到长度上限，未能完整生成。已有内容和原请求已保留，不会自动重试。"
  - 实时流结束时，`result` 事件携带 `completeness`，前端据此立即显示提示，不等刷新。
- **显示长度**：v5 的 `AGENT_TURN_MESSAGE_LIMIT`（20000 字符）在 O=32768 时可能先于模型上限截断正文。对冻结了新上限的 execution，`message` 的长度上限改由 4.3 的字节规则约束；旧 execution 不变。卡片 schema 不变。

## 4. 停止与保存上限（首版，只有一次正文调用）

### 4.1 前提

- 首版没有续写。一次回答只有**一次正文调用**；T2 带附属整理器时，后面还有一次整理器调用；工具轮次（`step` 的搜索、`read_source`）在正文调用之前。
- 下面的规则只针对新准入、冻结了新上限的 execution。旧 execution 的 `runtime_cancel`、`complete` 行为完全不变。

### 4.2 停止：先保存已写内容，再收尾（C2）

**问题**：
- 现有 `runtime_cancel` 会立刻调用 `bill2_cancel` 和 `bill2_finalize`，把没有结果的 execution 改成 `cancelled`；
- `complete` 分支遇到 `cancel_requested` 会拒绝。
- 所以如果停止复用 `runtime_cancel`，正在写的那次调用返回时无法保存。

**做法**：复用现有机制，不新建 RPC 家族、表或状态机。

1. **入口**：沿用现有 `runtime.cancel` 路由，增加可选参数 `stopAt`：用户停止时屏幕上已经显示的**可见正文**的 Unicode 码点数。
   - 前端用 `Array.from(text).length` 计算，数据库用 `char_length` 计算，口径一致。
   - 可见正文：凡是信封，一律取 `message`（3.4）；非信封的纯文本就是 `body`。
   - 实时 text 事件发送的就是可见正文，前端计数和服务器投影是同一份文本。
   - T3 不走停止路径，仍然用原来的 `runtime_cancel`。
2. **SQL 和宿主的分工**：在 PAYG PR-B 之后**追加**一张迁移，重定义 `runtime_execution`，加一个 `stop` 动作；不修改已合并的迁移。
   - `stop` 动作**只记录停止，从不在 SQL 里直接收尾**：它没有结果可以保存，结果只能由宿主从回执重建。
   - 收尾一律由宿主用 `complete` 提交校验过的结果来完成。
   - `stop` 动作在一个事务里，按现有锁顺序（session → execution → run）执行：
   - **(a) 记录停止**：复用 PAYG 的暂停字段，写入 `paused_reason='user_stop'` 和 `stopAt`。之后：
     - v2 claim 拒绝新调用，包括还没派发的工具轮次和整理器；
     - 只把 prepared 但还没派发的 call 改为 cancelled，并释放冻结；
     - **不调用 `bill2_cancel`，不设置 `cancel_requested`**。
   - **(b) 没有已派发、未结束的 call 时**：`stop` 动作只做 (a)，返回 `stopped_pending_result`。
     - 这包括"调用已经关闭、回执已经落库，但原 HTTP 还没解析 body、也还没构造 `p_result`"的窗口（`execute.ts:327-365`）。
     - 这种状态视为**等待宿主重建**，不当作"没有结果"。
     - 接下来由处理这次停止请求的宿主（`runtime.cancel` 路由）执行，不在 SQL 事务里收尾：
       1. 用现有的只读重放（`denyNewCalls` 闸门、只读回执，不派发）把回执重放成正文；
       2. 按第 4 项截到 `stopAt` 并重新封装，按 4.3 检查保存上限；
       3. 通过 `complete` 提交（满足下面的 R1–R4）；
       4. `complete` 照常依次调用 `bill2_close('delivered')` 和 `bill2_finalize`。
     - **原 HTTP 仍在运行时**：它解析完 body 后也会读到 `user_stop`，按同样的规则构造结果。两边用的是同样的回执、同样的 `stopAt` 和同样的确定性规则，所以结果逐字相同。
       - 先提交的一方完成收尾；后提交的一方走 `complete` 现有的"已完成且结果相同"分支，只读返回（`0106:454-455`），不会重复收尾。
       - 结果字段里不包含时间戳之类的非确定内容。
     - **宿主崩溃时**：停止已经记录，execution 仍停在 running 或 interrupted，由现有恢复路径（#595 的自动恢复、`executeStream` 重放、财务恢复）按 (d) 收尾。
   - **(c) 有已派发、未结束的 call 时**：只做 (a)，返回 `stopping`。那次调用所在的 HTTP 拿到回执后，按下面的规则走 `complete`。因为 `cancel_requested` 没被设置，`complete` 能成功。
   - **(d) 那次 HTTP 已经结束**（函数被回收、断线），或者 (b) 的宿主崩溃：下次恢复或重放时读到 `user_stop`，只读回执重建结果，按 (b) 的第 2–4 步用 `complete` 收尾。回执不明就按 PAYG 查账；仍然不明，就进入 `cost_pending`。不重发，不补扣。
   - **(e) 一个字都还没写出来**（`stopAt=0`，或者截断后可见正文为空）：结果为空，等价于现有取消，状态 `cancelled`。在途调用照常按回执结算一次。
3. **结果字段**（宿主生成）：
   - `stopped:true`：`user_stop` 下的每个结果都必须带。
   - `completeness`：主回复完整写完、并且没有因为 `stopAt` 被截断时为 `'complete'`，否则为 `'stopped'`；遇到 4.3 的保存截短时为 `'length_limit'`。
   - `organized`：只出现在带附属整理器的执行里。有可用摘要时为 `true`，否则为 `false`。
4. **截断后重新封装**（宿主执行，(b)、(c)、(d) 共用）：
   - **非信封纯文本**：`body` 取投影的前 `stopAt` 个码点。
   - **信封**（T1 导师、T2）：
     - 用该格式正常完成时的同一个解析函数解析完整 body；
     - 把 `message` 截到前 `stopAt` 个码点（只去掉尾部空白，保证仍是原文的前缀），其余字段按 4.3 的 T2 白名单规则保留，重建信封；
     - 用同一个校验函数检查。
     - **T1 带卡片**：卡片只在**没有发生截断**时保留。截断时 `card=null`，因为用户没看完正文，卡片也没有显示过。
     - **T2**：模型输出本身解析失败，或者截断后校验不通过时，不保存坏的协议 JSON，按 (e) 处理。
   - 截断永远发生在可见正文上，不截 JSON 字符串。
5. **`complete` 分支在 `paused_reason='user_stop'` 下的规则**（同一张追加迁移；不在 `user_stop` 下的执行保持 0106 现状）：
   - **R1**：结果必须带 `stopped:true`。
   - **R2 正文**：
     - **一律按 `stopAt` 计数**，包括已有 `primary_result` 的情况：可见正文的 `char_length` 不能超过登记的 `stopAt`。
       - 原因：主回复 checkpoint 的时候，客户端不一定已经看到完整主回复。`execute.ts` 把最后一次进度入队后紧接着就 checkpoint，而流式传输有缓冲和节流。
     - **已有 `primary_result` 时**：把 `0106:452` 的"body 必须等于 primary 的 body"放宽为"保存的可见正文是 primary 可见正文的**前缀**"。
       - 信封取两边的 `message` 比较；非信封直接比较 body。
       - 放宽**只**在 `paused_reason='user_stop'` 下生效。其他情况仍然要求完全相等。
       - 信封：把 `p_result->>'body'` 解析为 jsonb，取 `->>'message'` 再计数。解析失败、或者 `message` 不是字符串时，拒绝。
       - 非信封：直接对 body 计数。
       - 是不是信封，由冻结上下文的 `providerRequestFormat` 决定，不由结果自报。
   - **R3 整理器**（只针对带附属整理器的执行）：
     - 带非空摘要且 `organized:true`：现有 `0106:453` 检查本来就通过，不改；
     - 摘要为空字符串且 `organized:false`：
       - 现有 `0106:453` 有两个要求：`primary_result` 非空，summary 是字符串。空字符串满足后一项。
       - 已有 primary 时，原检查直接通过；
       - 主回复还在写就被停止时，没有 primary。**只在这种情况**（`user_stop` + `organized:false` + 空摘要）放宽"`primary_result` 非空"这一项；
     - 其他组合（空摘要却标 `organized:true`，或者非空摘要却标 `organized:false`），一律拒绝。
   - **R4**：`completeness` 只接受 `complete`、`stopped`、`length_limit`。
   - 除 R1–R4 外，其余检查（`kind`、`active_execution`、Session 批次、结果冲突）与 0106 相同。`stop` 动作本身不调用 `complete`，所有收尾都由宿主提交。`checkpoint_primary` 不改。
6. **带附属整理器的执行被停止**：
   - **主回复还在写**：这次调用落库后，宿主**不再** checkpoint primary，也不派发整理器（claim 已被拒）。按"没有 primary"的规则保存，`summary:""`、`organized:false`。
   - **主回复已完成，整理器还没派发**：取消这个 call 并释放冻结。按 (b) 保存：可见正文取 primary 的可见正文截到 `stopAt`，`summary:""`、`organized:false`。没有发生截断时 `completeness:'complete'`，否则为 `'stopped'`。
   - **整理器已在途**：按 (c)，等回执落库后收尾。可见正文同样截到 `stopAt`。
     - 没有发生截断（`stopAt` ≥ primary 可见正文的长度）：保留摘要，结果为 `stopped:true`、`completeness:'complete'`、`organized:true`；
     - 发生了截断：摘要是根据用户没看完的完整主回复整理的，所以不保存，记 `summary:""`、`organized:false`、`completeness:'stopped'`。整理器调用照常结算一次。
   - **`organized:false` 时**：这一轮右侧信息不更新，B1 capture 不执行；界面在回答下方显示"已停止，本轮未整理"。不自动补整理，也不在下一轮补做这一轮的整理。
7. **不重复扣费的保证**：
   - 每次调用只由自己的回执结算一次（BILL2 幂等）。
   - run 只由一次 `bill2_close` 和 `bill2_finalize` 收尾。(b) 和 (c) 都受同一把锁和同一个 `paused_reason` 约束，谁后到谁只读。
   - 停止从不在调用已派发时释放它的冻结。
   - 未派发的 call 只取消，不扣费。
   - 在途调用按回执和名义费用**整次**结算（供应商按实际生成量收费，和原生"停止生成"相同）；保存的正文截到 `stopAt`，完整原文留在回执里。
8. **界面**：
   - 点停止后立即停止显示新字，标记"已停止"；
   - 收尾完成后，用服务器上的结果替换显示，正文与停止时一致。

### 4.3 保存上限：按实际字节计量，永不超过 262144（C1，停止部分随 C2）

- **约束对象**：下面三处都按**序列化后的字节数**计算，上限 262144，底层上限不改。
  - `bill2_close` 的 `p_result`（`0105:309`，`0156:165`）；
  - `checkpoint_primary`（`0106:440`）；
  - Session item（`0106:40`）。
- **计量对象**：整个结果的 `octet_length(p_result::text)`，包括信封、卡片、摘要、元数据，以及导师 body 的**双层转义**。
  - 导师 body 是 JSON 字符串，又嵌在结果 JSON 里。所以正文里一个引号或反斜杠最终占 4 字节，换行占 3 字节，中文字占 3 字节。
  - 每个 UTF-16 码元最坏按 4 字节计算。
  - 宿主的计量与数据库 `octet_length(jsonb::text)` 用测试对照校准。
- **不按"每 token 最坏 8 字节"给整次调用预留**：O=32768 时这样要预留 262144 字节，正常调用也会被挡掉。8 字节/token 仍然只用于响应接收上限（`responseCapacity.ts`）。
- **整理器摘要的预留**（机器人第七轮 P1）：
  - **问题**：
    - 带附属整理器的执行，主回复在整理器运行**之前**就 checkpoint 了（`execute.ts:339`）；
    - 最终 `complete` 要求 body 等于 primary 的 body（`0106:452`），所以 checkpoint 之后不能再截主回复；
    - 摘要（`v3_summary_max_tokens` 最多 4096 token）嵌进结果时还要再转义一次，它的序列化大小没有可靠的 token 换算上界。
  - **做法**：两道规则，配合起来保证一定能收尾。
    1. **checkpoint 之前先预留**：
       - `SUMMARY_RESERVE` 取 65536 字节；
       - 要求 `bytes(primary 结果) + SUMMARY_RESERVE + META_RESERVE ≤ 262144`，其中 `META_RESERVE` 为 8192 字节，覆盖元数据和余量；
       - 超出时，在 checkpoint **之前**按下面的截短规则截短主回复的可见正文，并记 `completeness:'length_limit'`。checkpoint 之后主回复不再变化，`0106:452` 的一致性检查照常成立。
    2. **摘要超出预留时，只省略摘要正文**：
       - 整理器回执落库后，计算摘要嵌入结果后的实际序列化字节；
       - 超过 `SUMMARY_RESERVE` 时，不截断摘要（摘要可能被后续解析，截断会产生不完整的内容），而是保存 `summary:""`、`organized:false`、`summaryOmitted:true`。完整摘要仍在整理器的回执里。
       - 现有 `0106:453` 只要求 summary 是字符串，空字符串同样通过，所以这一条**不需要改 SQL**。
       - 整理器调用照常按回执结算一次。
  - 因为主回复在 checkpoint 前已经为摘要留出空间，而摘要只有"放得下"和"省略"两种结果，所以带整理器的执行**一定能收尾**。
- **保存前截短（硬保证）**：
  - 最终保存前（带整理器时，是在 checkpoint 前），按实际 `bytes(result)` 检查，超过 262144 时按固定顺序截短。
  - 截短都在 Unicode 码点边界进行，每截一次就重新封装、重新计量。
  - **无卡片的结果**：截短可见正文。信封截 `message` 后重新封装。
  - **T2 信封的白名单**（所有 T2 保存都适用，不只是停止）：
    1. 保存前，按该格式正常完成时的 schema **只保留已校验的字段**重建信封，未知字段一律丢弃；
    2. 截短 `message`，直到整个结果不超过 262144；
    3. 如果去掉 `message` 之后，私有字段本身仍然放不下（极端情况），退到**紧凑结果**：信封只保留公开的 `message`（照样截到放得下），结果记 `envelopeCompact:true`、`completeness:'length_limit'`；
    - 紧凑结果不再经过 T2 的完整 schema，只校验 `message` 是字符串，所以一定能保存、调用一定能收尾；
    - 紧凑结果不被结构化解析、报告候选和 B1 采用，私有字段的原文仍然在回执里。
  - **带卡片的导师回合**：
    1. 先截短 `message`。信封顶层的 `message` 和 `card.message` 截成同一个值，保持 `agentTurnResult` 的"两份一致"；
    2. 仍然超出时，截短 `recommendationReason`。
    - 两者都至少保留 1 个字符；`question`、`options`、`recommended` 永远不截。
    - 可行性：卡片 schema 允许 `message` 和 `recommendationReason` 各 20000 码元，`message` 在信封里还有一份，再加 `question` 500 和 `options` 5×200，最坏约 61500 码元 × 4 字节 ≈ 246000 字节。除这两个长文本以外，最坏不到 `6000 + SUMMARY_RESERVE + META_RESERVE` = 79728 字节，所以两个长文本至少还有约 182000 字节可用。截短一定能放下，截完仍然通过 `questionToolCardSchema` 和 `agentTurnBody` 的校验。
    - 本方案不改卡片 schema。
  - 截短后记 `completeness:'length_limit'`，完整原文仍在回执里。
- **Session item**：写入前按**实际序列化字节**计量每一个 item（`octet_length(item::text)`）。
  - 卡片回复可能同时带一段非公开的伴随 assistant 文本（`streaming.integration.ts` 已覆盖这种形状），O=32768 时它本身就可能接近上限。
  - 带卡片时，伴随文本先截短到 4000 码元；截短后这个 item 仍然超过 262144，就整条不写入 Session（回执保留原文）。
  - 工具参数所在的 item 按上面的卡片截短规则处理，最坏约 41500 码元 × 4 字节 ≈ 166000 字节，在上限之内。
  - 无卡片的 T1 回答：Session 写入用截短后的正文。
  - 截短发生时，Session 和结果用同一份截短后的值。

### 4.4 持久状态（AGENTS 第 5 节说明）

- **考虑过的现有机制**：
  - Runtime execution 和回执：正文的权威来源；
  - `runtime_execution` 的 `complete` 和 checkpoint：最终保存；
  - PAYG 的暂停字段：停止；
  - #595 的恢复信封与轮询：刷新后显示。
- **最小新增**：
  - 结果元数据 `completeness`、`stopped`、`organized`、`summaryOmitted`：写在现有结果 JSONB 里，不改表；
  - PAYG 暂停字段增加取值 `user_stop`，并记录 `stopAt`；
  - `runtime_execution` 增加 `stop` 动作，`complete` 分支增加 R1–R4。这两项用 PAYG PR-B 之后的一张**追加**迁移完成，编号取当时 staging 最大号 + 1。
  - C1（流式、上限、写满收尾、保存截短、摘要省略）**不需要迁移**。
- **不新增**：表、RPC 家族、队列、定时器或状态机。
- **权威来源不变**：正文以回执为准，账务以 BILL2 为准，状态以 `runtime_executions` 为准。

## 5. 计费（首版）

- 首版不新增调用，计费按 #553 第七版原样执行。PAYG 落地前，按现行 v1 执行。
- **单次上限提高的影响**：
  - 正式环境 O 从 8192 提高到最多 32768，单次 U、G 的输出项按比例增大；
  - #553 已验证的 profile 必须覆盖选定的 O，正式值不能超出已验证的范围（3.1）；
  - 用户的名义费用按实际 token 计算，不因为上限提高而多扣。上限提高影响的只是冻结额，以及余额封顶时的平台承担。
- **停止**：在途调用整次结算一次，未派发的 call 取消并释放冻结（4.2）。
- **摘要省略**：整理器调用照常结算，与摘要是否保存无关（4.3）。

## 6. 和提示缓存的关系（首版）

- 首版不改变任何请求形状，只改变冻结的流式格式（C0）和 `max_tokens`（C1）。#591 和 #610 的缓存规则不受影响。
- C0 把 `step` 回复从非流式改为流式，前缀字节不变。新旧格式的请求字节差异由 C0 的黄金测试覆盖。

## 7. 顺序和写入负责人（首版）

### 7.1 顺序（第四版按 staging `c0b3de3f` 更新）

```
已合并：#594、H1 #610、B1 #593、#611；PAYG PR-B1 #631（6fccfaba）
PAYG PR-B2 #632（进行中，改 execute.ts、executionStream.ts、admission.ts）
#632 合并 → C0+C1（一个 PR）：流式、统一上限、写满收尾、保存截短、摘要省略；不需要迁移
C0+C1 合并 → C2（停止：追加迁移、宿主收尾、前端停止）
REPORT-GEN R-A / R-B 按 #547 原顺序，用统一上限
上线后：第二版自动续写（第 13 节），另行定稿和审查
```

- #547 原有的前置条件"B1 未合并就等待"已经满足：B1 #593 已于 `e122857f` 合并。
- 正式环境的单次上限值、Pro 函数时长和 Vercel 配置，在正式发布前按 AGENTS 第 10 节另取批准。

### 7.2 文件重叠与单一写入负责人

| 文件 | 本方案 | 写入负责人与交接 |
|---|---|---|
| `runtime/admission.ts` | C0：流式格式；C1：`outputCapacity` | PAYG PR-B2 #632 正在改这个文件；C0+C1 在 #632 合并后再写。不并行写 |
| `runtime/runner.ts`、`execute.ts`、`progress.ts`、`shared/agentTurn.ts` | C1：结束原因交回宿主、`completeness`、保存截短、摘要省略；C2：停止收尾 | PAYG PR-B2 #632 正在改 `execute.ts`；C0+C1 在 #632 合并后再写（2.3 的核心改动在 `execute.ts`），C2 在 C0+C1 之后；R-B 在 C1 之后 |
| `runtime/executionStream.ts`、`agentTurnResult.ts`、`agentTools.ts` | C0：`textDelta`/快照/`rev`（2.2）、出卡回合投影（2.3） | PAYG PR-B2 #632 正在改 `executionStream.ts`；C0+C1 在 #632 合并后再写，C2 在 C0+C1 之后 |
| `bill2/responseCapacity.ts`、`openRouterStream.ts`、`openRouterPolicy.ts`、`budget.ts` | C1：按环境推导上限和超时 | C0+C1 PR 唯一写入；R-A 在 C1 之后 |
| `runtime/purposeBudgets.ts`、`MentorBudgetSettings.tsx`、`mentorBudgetDraft.ts` | C1 | C1 先写；R-A 在 C1 之后 |
| `positioning/[draftId]/page.tsx`、`agent-turn-display.ts`、`mentor-turn.ts`、`app/runtime/page.tsx`（只改文案） | C0：渲染；C1：截断提示；C2：停止 | C0+C1 PR → C2，依次进行 |
| `runtime_execution` SQL | C2 追加迁移 | 只能在 PAYG 迁移之后追加；编号冲突时由后合并方改号，并重新生成 built-fingerprint |
| 共享测试（`runtime.integration.ts`、`streaming.integration.ts`、`terminalReply.integration.ts`）和 `code-size-baseline.json` | C0–C2 | 跟随所在 PR 的写入顺序，同一时间只有一个 PR 改它们 |

- 各 PR 开工时写明会碰哪些共享文件。

## 8. 对 #547、#553 的影响（定稿后由总控安排同步，本方案不改它们）

### 8.1 #547（REPORT-GEN）

- **D1**：作废。报告用该环境的全站统一单次上限：staging 8192，正式环境按 3.1 定值。首版没有续写。
- **报告长度**：#547 锁定的是 13 部分、最多 12000 字。
  - 正式环境 32768 的单次上限，按常见中文写作预计可以一次写完，但以实测为准。
  - staging 8192 可能写不完整份报告。写不完时，结果是 `length_limit`，不能作为完整候选。staging 的报告验收是否需要临时用更高的 O，由 #547 同步时提出，并单独申请。
- **D2**：按 O=8192（staging）重新测算付费验收的份数、每份的调用次数和总预算，并重新申请。原额度不自动沿用。
- **§0.3、§1、§3**：
  - 去掉"D1 待决"；
  - 共享文件的写入负责人按本方案 7.2；
  - 前置条件改为 C0+C1 已合并。
- **§2.3**：缓存排除理由不变（首版一份报告仍然只有一次正文调用）。
- **§4**：
  - 删除 report-full 24576 profile；
  - "截断只能改走分章"改为"写满时以 `length_limit` 收尾，不作为完整候选"；
  - 时长目标引用本方案 3.3。
- **§6**：响应、帧和回执容量按该环境的 O，用 R(O)/F(O) 推导（3.1），方法保留。报告的结果容量按本方案 4.3 处理。
- **§7 持久化契约**：
  - `completeness` 不是 `'complete'` 的报告，**不能**作为可确认的完整候选（13 部分完整性校验不变）；
  - 正文为空的 `length`、截断的工具调用，仍然不能作为候选。
- **§8 取消**：报告如果走流式停止路径，按本方案 4.2 处理。
- **§9 分章**：分章原本是 D1 不批准时的退路，现在不再需要。
- **§11**：
  - R-A 保留输入容量和冻结读取，去掉按用途的输出接线；
  - 必测"24576/24577"改为"该环境的统一上限通过，上限 +1 拒绝"；
  - 截断必测改为"`length_limit` 收尾、不作为候选"。
- **§12**：风险、Handoff 和阻塞条件按上述内容同步。
- 第二版续写上线后，#547 是否改为"写满时续写"，届时另行同步。

### 8.2 #553（BILL-PAYG）

- **首版**：本方案不新增调用形态，#553 按原样实施。
  - 只需确认已验证的 profile 覆盖正式环境选定的 O（3.1）；
  - PAYG 暂停字段增加 `user_stop` 取值（4.2），由 C2 的追加迁移完成，不要求 PR-A 或 PR-B 预先支持。
- **§5 续跑闸门**：第二版设计里提到的冲突（"续跑按剩余调用数重新过 calls 闸门"与续写额度一次扣满）**不再是首版问题**。等第二版定稿时再处理，见第 13 节的闸门约束。

## 9. 需要 Owner 决定的事项

**首版没有其他待 Owner 决定的事项。** 已定的决定：

- 全站统一流式；
- 统一单次上限（staging 8192，正式环境 32768 为首个候选，实施时定值）；
- 写满时干净收尾，并提示已截断；
- 首版不做自动续写，放到上线后的第二版。

**第四版 Owner 决定（2.4 第 3、4 项，2026-10-05，总控记录在 #635 评论 5982731860）**：

> 同意 C0 重连按推荐处理：同一标签页刷新时保留已显示的部分并显示等待状态，写完后换成完整回复；新标签页或换设备时只显示等待状态，写完后整段显示；同一页面断线时已显示的部分保留、不再增长。

- 服务端只重放终态，不新增持久状态、不需要迁移；同一标签页的保留由页面的 `sessionStorage` 实现（2.4 第 3 项）。

2.3 出卡回合"正文边写边出、卡片在结束后出现"属于 Owner 已定的"全站统一流式"，不另请决定；模型出卡前先写的助手文字会在出卡时被替换（2.3 第 2 项），这与保存的结果一致。

正式环境的上限定值、Pro 函数时长和 Vercel 配置，在正式发布前按 AGENTS 第 10 节的上线批准流程处理。原 Q1（最多续写几次）移到第 13 节，第二版定稿时再交 Owner 确认。

## 10. 风险、回退、必测（首版）

### 10.1 风险

1. **中途超时**：一次调用写到一半超时，这次内容丢失，不能无感完成（3.3）。正式值必须按实测速度确定。
2. **写满截断**：
   - T1 回答在上限处结束，提示用户可以发送"继续"；
   - T2 和 T3 写满时，回答未能完整生成。
   - 正式环境提高上限后，这两种情况都会很少。
3. **语义变化**：
   - 有正文的 `length` 不再静默当作完成；
   - 停止后保留已写内容；
   - 摘要过大时省略摘要，并标为未整理。
   - 这些都只作用于新冻结的 execution。
4. **线路差异**：三类主力模型在 32768 下的实际用时和费用都还没有实测证据，由 C1 的实施验证。
5. **出卡回合的流式粒度**（2.3）：工具参数一次性到达的线路，出卡回合仍是结束时整段出现；模型按 schema 顺序先写问题和选项时，正文开始得稍晚。
6. **重连期间不再增长**（2.4）：长回答写作期间重连，同一标签页只能看到刷新前的部分，新标签页或换设备看不到中间内容，都要等写完。

### 10.2 回退

- **C0**：新准入改回非流式格式，旧 execution 按冻结格式重放。出卡回合的投影（2.3）可以单独退回为现在的"整段缓冲"，请求和结果不变。
- **C1**：
  - 正式环境的统一上限可以单独退回 8192，相关的响应、帧、超时常量一起退回；
  - `outputCapacity` 恢复读取用途配置（version 1 的数据仍然可读）；
  - 已冻结的 execution 按冻结的 O 完成。
- **C2**：
  - 前端停止改回调用原 `runtime_cancel`；
  - 追加迁移的回退 SQL 草稿放在 migrations 目录之外，远程执行另取 Owner 批准。

### 10.3 必测

- **流式（C0）**：
  - `step` 回复（带整理器和不带整理器）能边写边出，写的过程中只显示 `message`，不显示 JSON；
  - plan、runtime 页、选题页仍然整段缓冲，完成后显示；
  - **增量传输**：
    - O=32768 写满时，总传输字节数与回答长度成正比（与累计全文方式对照）；
    - 服务端解析是增量的，不会在每个片段重新扫描全文；
    - 发起调用的流第一个文字事件是 `offset:0` 的完整快照；`offset:0` 事件在客户端替换整个气泡；替换型快照让 `rev` 加 1；
    - `result` 之前，客户端显示的内容与权威可见正文逐字相同（一致时不重复发快照）；
    - 客户端遇到 `rev` 或 offset 不一致的帧时丢弃并停止增长，不重新调用 `executeStream`，等下一个快照或 `result`；
  - **重连（2.4）**：
    - 调用进行中第二次调用 `executeStream`：不发文字事件，立即返回 `pending`，不派发、不改执行状态；
    - 同一标签页刷新：先显示 `sessionStorage` 里存下的前缀（不再增长）和等待状态；执行结束后自动恢复，由最终结果替换，与权威结果逐字相同，含截断提示和卡片；终态后存储项被删除；
    - 新标签页、换设备、存储读写失败：只显示用户消息和等待状态，结束后整段显示，不报错；
    - 复制标签页、由本页 `window.open` 打开的窗口：拷贝来的存储里没有"即将重新加载"标记，不恢复前缀，只显示等待状态；原标签页刷新时照常恢复；标记超过 10 秒不恢复；
    - 同一页面断线：已显示的部分保留、不再增长（`page.tsx:167` 的 `startLiveReply` 不再清空气泡）；结束后由完整回答替换；
    - 存下的前缀与最终结果不同（出卡替换、截断失败）时，最终结果直接替换；
    - 存储里只有已显示的可见正文，没有卡片、选项和私有字段；
    - 替换型快照（例如出卡时从助手文字切到 `message`）后立刻刷新：恢复的是新 `rev` 的前缀，不会出现被替换掉的文字；快照写入存储失败时，刷新后只显示等待状态；
    - 已完成的 execution 重放：只有一个完整快照，然后是 `result`；
    - 整个过程中调用只派发一次、只结算一次；
    - 旧 execution 和旧客户端仍然收到原来的 `text` 全文事件；
    - `stopAt` 与增量 offset 的计数一致；
  - **出卡导师回合（2.3）**：改写 `streaming.integration.ts` 现有的 five-field 用例（现在断言供应商结束前没有文字），按场景断言：
    - 纯文字（没出卡）：供应商结束前已有多次文字增量，最终正文与保存的 `message` 相同；
    - 出卡，参数分多段到达：写的过程中只出现 `message` 的前缀，从不出现 `question`、`options`、`recommended`、`recommendationReason` 或原始 JSON；`card` 事件只在结束后出现一次；最终文字等于 `card.message`；
    - 先写助手文字再出卡：切换时发 `offset:0` 快照、`rev` 加 1，最终文字等于 `card.message`，保存结果不含那段助手文字；
    - 卡片参数无效：没有卡片，最终文字按现有规则（合格的 `message` 或固定提示），不一致时以快照收尾；
    - 多个调用：只投影 index 0；
    - 参数里 `message` 前面的字段还在写时，不切换、不清空气泡；`message` 前缀非空时才发切换快照；
    - 发快照时节流窗口里未发出的增量被丢弃，快照之后不会出现旧来源的文字；
    - 参数一次性到达：结束时整段出现，不报错；
    - `message` 中的引号、反斜杠、`\u` 转义、中文、emoji 和代理对跨片段切开时，投影与最终解码逐字一致；
    - 带工具调用的 `length`：走原失败路径，已显示的前缀由失败提示替换；
    - 开场回合、旧契约（没有 `message` 的卡片）和旧 execution 的显示与现在相同；
    - 请求字节、账单证据和 Session 写入与现在逐字相同（只改投影）；
  - **message 第一个**：符合约定时，T2 边写边显示；不符合时不判失败，完成后再显示，并记 `messageFirst:false`；这时停止按 (e) 处理；
  - 旧 execution 按原格式重放，字节不变；
  - 流式和非流式的账单证据等价；
  - #594 的闸门回归：未准入的 held、429、各类 503、结果未知时，不自动重新准入；确定的结构化 4xx 按 abandon 释放；首次调用闸门取消时显示固定提示。
- **统一上限（C1）**：
  - staging 8192 通过、8193 拒绝；正式环境用选定值做同样的边界测试；
  - 模型能力低于统一上限时取小值；
  - 后台表单只读显示，version 1 配置可读；
  - 正式候选值下，响应、帧、回执容量按 R(O)/F(O) 推导，回执原文不会被省略（`rawBodyOmitted`）；
  - 三类主力模型在该环境单次超时内写满 O，用时只记日志；
  - PAYG 已验证的 profile 覆盖选定的 O。
- **写满收尾（C1）**：
  - T1 有正文的 `length`：保存已写正文，结果为 `length_limit`，提示显示在正文外，实时结束和刷新后都显示；
  - T2 写满：走"回复格式无效"路径，并显示对应提示；
  - T3：沿用原有处理，文案已更新；
  - 正文为空的 `length`、截断的工具调用：保持原失败路径；
  - `length_limit` 的结果不被报告候选、结构化解析、B1 capture 采用；
  - 旧 execution 行为不变。
- **保存上限（C1）**：
  - 构造性证明（属性测试）：任意 O（含 32768）、卡片、摘要和元数据的组合，保存前截短后，序列化字节**永不超过** 262144；
  - 宿主计算的字节数与数据库 `octet_length(jsonb::text)` 一致；
  - **最坏卡片**：`message` 和 `recommendationReason` 各 20000 码元，分别用引号、反斜杠、中文、换行、代理对构造，再加 500 码元的 `question` 和 5 个 200 码元的选项。验证：
    - 结果不超过上限；
    - 按"先 `message`、后 `recommendationReason`"的顺序截短，信封的 `message` 等于 `card.message`；
    - 截短后通过 schema 校验，`question` 和 `options` 不变；
    - 结果为 `length_limit`。
  - **卡片带伴随文本**（O=32768 写满）：伴随文本被截短到 4000 码元；构造成截短后仍然超出时，整条不写入 Session；每个 Session item 都不超过上限；
  - **整理器摘要**：
    - 主回复接近上限时，在 checkpoint 前截短，为摘要留出 `SUMMARY_RESERVE`，之后 `0106:452` 的一致性检查通过；
    - 转义很多、超出预留的合法摘要，保存为 `summary:""`、`organized:false`、`summaryOmitted:true`，`complete` 成功，执行能收尾，整理器只结算一次；
    - 摘要在预留之内时正常保存。
- **停止（C2）**：
  - (b) 没有在途调用：`stop` 只记录停止，不收尾；停止请求的宿主只读重放回执，提交截到 `stopAt` 的结果，再收尾；
  - **回执落库与结果写入之间点停止**（`execute.ts:327-365` 的窗口）：
    - 停止返回 `stopped_pending_result`，SQL 不直接调用 `bill2_close`；
    - 停止宿主重放得到的结果，与原 HTTP 随后构造的结果逐字相同；
    - 两边谁先提交都只收尾一次，另一边只读返回；
    - 停止宿主在提交前崩溃时，由现有恢复路径收尾；
    - 整个过程中调用只结算一次；
  - (c) 有在途调用：返回 `stopping`，回执落库后 `complete` 保存带 `stopped:true` 的结果；超过 `stopAt` 的可见正文被拒绝；
  - (d) 在途 HTTP 已经消失：恢复时读回执收尾；回执不明时进入 `cost_pending`；
  - (e) 没写出字：状态 `cancelled`；
  - 停止后 claim 被拒（工具轮次、整理器）；未派发的 call 被取消并释放冻结；在途调用只结算一次；run 只收尾一次；
  - 可见正文：
    - 导师回合不带卡、带卡（没有截断时保留卡片，截断时 `card=null`）；
    - `step` 回复（带整理器和不带整理器）：截断信封的 `message`，私有字段不变，用正常完成的校验函数检查；模型输出不合格时按 (e) 处理，不保存坏 JSON；
    - 非信封纯文本；
    - 中文、emoji、换行下，前端的 `Array.from` 与数据库的 `char_length` 计数一致。
  - 带整理器：
    - 主回复在写时停止：没有 primary，`organized:false`，`complete` 成功；
    - 主回复已完成、整理器未派发：body 等于 primary；
    - 整理器在途：正常带摘要完成，结果为 `stopped:true`、`complete`、`organized:true`；
    - R1 和 R3 的拒绝组合；
    - 未停止的执行缺摘要时，仍报 `RUNTIME_ORGANIZER_PENDING`。
  - **整理器运行期间停止**（primary 已 checkpoint，但客户端只显示到一部分）：
    - 保存的可见正文截到 `stopAt`，是 primary 的前缀；
    - R2 的"前缀"放宽只在 user_stop 下生效，非停止的执行仍然要求完全相等；
    - 截断时不保存摘要（`organized:false`），整理器只结算一次；
    - 停止后气泡里不会出现停止之后才到的文字；
  - **T2 白名单**：
    - 带未知字段的信封保存时丢弃未知字段；
    - 私有字段本身超过上限时，退到紧凑结果（`envelopeCompact:true`、`length_limit`），保存成功、调用收尾，结构化消费者不采用；
  - B1：只在 `complete` 且（带整理器时）`organized:true` 时执行一次，重放不会产生第二份。
  - 旧 execution 的 `runtime_cancel` 行为不变。

## 11. 本方案实际做过的核对

- **第一版**：核对 staging `34017395` 和当时的 open PR；只读阅读代码，以及 #553、#547、#601、#593、#598 的描述和评论。
- **第二版**：
  - 同步到 staging `1563a44d`，核对第 1 节的全部行号；
  - 阅读 `0105`、`0106`、`0156` 中的 `runtime_cancel`、`runtime_execution` 的 `complete` 和 `checkpoint_primary` 分支、`bill2_cancel`、`bill2_close` 的结果上限和回执上限；
  - 核对 `admission.ts`、`runner.ts`、`providerRequest.ts`、`openRouterAdapter.ts`、`openRouterEvidence.ts`、`newWorkGate.ts`、`progress.ts`、`agentTurn.ts`、`agentTurnResult.ts`、`runtime/page.tsx`、`opc/service.ts`；
  - 阅读本 PR 的全部评论和行内意见。
- **第三版**：
  - 核对 `execute.ts:336-363` 的整理器流程（先 checkpoint primary，再运行整理器，再 complete）；
  - 核对 `0106:452-453` 的 summary 检查（只要求字符串）；
  - 核对 `summaryPolicy.ts` 的摘要上限。
- **第四版**（staging `c0b3de3f`，只读）：
  - 出卡回合：`execute.ts:300-401`（文字进度的压制条件、`agentCardMessage`、收尾顺序）、`agentTurnResult.ts`、`agentTools.ts`（五字段 schema 和字段顺序、`questionMessageFromArguments`）、`runner.ts`（`firstCallFrame`、流式帧和重放时合成的单帧）、`openRouterStream.ts`（帧里的 `tool_calls` 增量）、`streaming.integration.ts` 的 five-field 用例；
  - 重连：`executionStream.ts`（进度只在内存里）、`execute.ts:446-496`（非 `live` 时返回 `pending`）、定位页 `mentor-turn.ts`（`isTerminalTurn`）、`step-recovery.ts` 和 `use-step-recovery.ts`（#595 的轮询和自动恢复）；
  - 当前 open PR 里，#632（PAYG PR-B2）改 `execute.ts`、`executionStream.ts`、`admission.ts`，与 C0 重叠，已写入 7.1、7.2：C0+C1 在 #632 合并后再写这些文件；
  - 定位页 `page.tsx:167`：恢复已有 execution 时，`startLiveReply` 会先清空实时气泡（2.4）；`0106:398-400`：`runtime_execution` 依次锁会话、执行和 `bill2_runs` 三行（2.4）。
- 未运行测试（纯文档）；未改代码，未访问数据库，未调用模型或付费接口，未改配置。

## 12. 修订记录

- 第一、二版各行里的节号，指当时版本的编号。续写相关的内容现在在第 13 节，对应"原 x.x"小节；停止和保存上限按首版重写在第 4 节。

| 意见 | 修订位置 |
|---|---|
| 机器人 P1（结果容量，原第 513 行） | 新增 4.8：派发前按累计序列化字节加最坏段预留判断；保存前按实际字节截短；必测改为构造性证明；第 9 节说明 4 段是上限、不是保证 |
| 机器人 P1（停止，原第 287 行） | 重写 4.6：新增 `runtime_execution` 的 `stop` 动作和 `complete` 的停止校验；不走 `bill2_cancel`；写明 (a)–(e) 各情况、不重复扣费、在途段结算和必测 |
| 机器人 P2（结构化输出，原第 125 行） | 2.1：runtime 页和选题页不纳入 C0，等 CONTENT-CONVERSATION-DRIVEN；4.1：这些入口 `maxSegments=1`，有正文的 `length` 记为未完成；第 8 节同步 |
| 独立审查 F10（代码事实） | 1.1：带附属整理器的主回复是 v6 非流式，`firstToolCallOnly` 的限制；4.2 D：Hobby 下"每次 HTTP 一段"不是严格结论；4.9：撤回"放宽 0106 单段相等约束" |
| 独立审查 F2（段数、容量、调用预算） | 4.2 C 和 4.3：完整请求按实际序列化计算 B，冻结 `continuationInputBytes`（不超过报价和 PAYG profile），用户材料预算不放宽；每段是独立的 `runRuntime`，不加大 `maxTurns`（v5 要求为 1）；`maxCalls` 随段数冻结，其他次数不变；跨 HTTP 时 calls 闸门按剩余次数检查；结果存储见 4.8；删除未定义的 `O_min` |
| 独立审查 F3（收尾不等于成功） | 4.2：引入 `completeness`（complete / length_limit / stopped），提示放在正文外；报告候选、结构化解析、B1 只认 complete；补必测 |
| 独立审查 F4（计费推论） | 3.1：U、G、H 随每段变化；第 5 节：删除"每次回答最多一段"的推论，区分 H<G 和 Δ>H，E 不等于现金亏损，`e_bound` 不以 U 为上限，`actual_fallback` 例外，报告 L 单独核对 |
| 独立审查 F5（续写请求和拼接） | 4.3：续写输入包含本 execution 已完成的工具调用和结果；不保留推理状态；线路要求保留思考签名时不续写；逐模型验证；`join-v1` 最长后缀—前缀匹配、64 字符流式缓冲、去重后零进展时收尾 |
| 独立审查 F6（前端接续和停止） | 2.2：#594 已合并（`2259e895`）及其回归项；4.4：扩展 #595 恢复判定，只对 `waiting_resume` 自动继续、每个 epoch 一次，其余拒绝不循环；4.5：断线只在本次函数执行期间有效；4.6：停止立刻停字 |
| 独立审查 F7（缓存） | 第 6 节：H1 默认不激活、B2 才有历史断点；没有断点的分支；可信冻结合同；配对工具历史照样允许；命中条件和必测改为"有资格时能证实" |
| 独立审查 F8（#547 和 Owner 决定的说明） | 第 8 节：报告是 13 部分、最多 12000 字；D2 重新申请；补齐 #547 各节；R-A 输入容量保留；R(O)/F(O) 保留；第 9 节：3 次只作异常兜底，补费用、时间、截断的边界说明 |
| 独立审查 F9（写入负责人） | 7.2：每个重叠文件只有一个写入负责人，串行交接，不再"后合并方同步"；7.1：B1 已合并，PAYG 前端验收在默认切换之前；4.9：只追加迁移 |
| 第一版事实错误 | 3.3：撤回"调低 `ai_models.max_tokens`" |
| 独立审查 F1（快超时、Pro 下是否提高单次上限） | 按 Owner 决定（5969177321）修订：0 和 3.1，正式环境提高统一上限（32768 为首个候选），staging 8192，响应/帧/回执/超时/PAYG profile 一起推导；3.3，如实写明中途超时不能无感续写；4.2 D，按环境取 `SEGMENT_DISPATCH_MS`；第 9 节，Q1 改为兜底语义；10.1–10.3，风险、回退和必测同步 |
| 总控补充（32768 与结果容量） | 4.8 重写：不再按每 token 8 字节给整段预留；按实际字节计量，续写段 O 按剩余空间缩小，保存前截短是唯一的硬保证，第一次调用不受影响；不提高 262144，只在证明行不通时另列 high 迁移交 Owner 批准 |
| 机器人复审 P1（续写输入递归重复，线程 4173417610） | 4.3：第 k 段输入固定为"最初请求前缀 + 第 1 段之前的工具往返各一次 + 最新全文投影 + 一条 CONTINUE_V1"，不在上一段输入上追加；第 6 节：adapter 尾部只允许一条 assistant 和一条 CONTINUE_V1；补第 3、4 段的输入必测 |
| 机器人复审 P1（续写段调用工具会耗尽调用预算，线程 4173417613） | 4.3：续写段不允许新的工具调用（总控技术决定），每段固定一次模型调用，`maxSegments − 1` 的预算成立；模型请求工具时宿主拒绝、不执行、以 `length_limit` 收尾；写明对付费搜索、`read_source` 和导师提问卡的影响；补必测 |
| 机器人复审 P1（stopAt 校验对象，线程 4173464770） | 4.6：`stopAt` 按可见正文的码点计数；导师回合取信封的 `message`，普通回合取 `body`；格式由冻结上下文决定；新增 2A 截断后重新封装（截断时去掉卡片、经 schema 校验）；`complete` 按可见正文计数；补三类必测 |
| 机器人复审 P2（calls 闸门重复扣，线程 4173464773） | 4.3：续写段额度在首次闸门里随 `maxCalls` 一次扣满；跨 HTTP 继续只检查暂停、不扣额度，以已有 claim 过的 call 作为扣过的依据，不新增状态；标注 #553 §5 需要对齐；补"四段 Hobby 回复只扣一次"必测 |
| 机器人复审 P1（带整理器的执行被停止，线程 4173504630） | 4.6 新增 2B：停止后不整理，结果 `stopped`、`organized:false`、没有 summary；已有 primary 时用它的 body；整理器在途时等回执后正常完成；追加迁移里的 `complete` 只在 user_stop 下跳过 `RUNTIME_ORGANIZER_PENDING`，保留 primary 一致性检查；右侧不更新、B1 不执行、不自动补整理；4.2 同步；补必测 |
| 机器人复审 P2（join-v1 与 64 字符缓冲，线程 4173504631） | 4.3：重叠检测长度上限 64，缓冲 64 正好覆盖所有候选长度，实时和重放的投影一致；超过 64 字符的重复原样保留（首版限制）；补必测 |
| 机器人复审 P1（卡片最坏值超过预留，线程 4173597656） | 4.8：计量对象改为整个结果（含导师 body 的双层转义，每码元最坏 4 字节）；把结果分成形状 P（多段、无卡片）和形状 C（带卡片、只有一段）；预留只用于形状 P；形状 C 由保存前截短保证（先 message 两份同步、后 recommendationReason，其他字段不截），并给出可行性计算；Session item 的最坏值；补最坏卡片必测 |
| 机器人复审 P1（停止规则不统一，线程 4173597658） | 4.6：统一为 `user_stop` 下所有结果都带 `stopped:true`，另用 `completeness` 和 `organized` 区分；`complete` 分支只改 R1–R4 一处，已有 primary 时沿用 0106:452、不按 `stopAt` 计数；整理器在途完成的结果为 `stopped:true`、`complete`、`organized:true`；主回复段在途时停止也写明了；4.2 的消费规则同步；补必测 |
| 机器人复审 P1（T2 信封的停止，线程 4173655350） | 4.1：按"可见正文由谁产生"分成 T1/T2/T3，统一定义"信封"；4.6：凡是信封一律取 `message` 计量和截断，私有字段原样保留，重建后用正常完成的同一个校验函数检查，校验不通过就不保存坏 JSON；R2 改为同一条规则；补 T2 必测 |
| 机器人复审 P1（卡片伴随文本的 Session item，线程 4173655362） | 4.8：按实际序列化字节计量每个 Session item；带卡片时，非公开的伴随文本先截到 4000 码元，仍然超出就整条丢弃；补必测 |
| 机器人复审 P2（plan 数组，线程 4173655358） | 2.1、2.2、4.1：plan 等非信封的结构化输出（T3）首版整段缓冲，完成后再显示，不续写，停止走原取消；C0 只收拢 `step` 回复；已核对定位页没有其他这类路径；T2 首版不续写 |
| 第三版：Owner 决定首版不做自动续写（总控记录 5970578413） | 首版只保留流式、统一上限和写满收尾（3.4）；停止和保存上限按"只有一次正文调用"重写（第 4 节）；续写相关的全部内容移到第 13 节；第 0、5–11 节按首版重写；对 #547、#553 的影响见第 8 节 |
| 机器人第七轮 P1（整理器摘要的序列化大小，线程 4173706457） | 4.3：checkpoint 之前先为摘要预留 `SUMMARY_RESERVE`=65536 字节，主回复超出就在 checkpoint 前截短；摘要超出预留时保存 `summary:""`、`organized:false`、`summaryOmitted:true`（现有 0106:453 接受空字符串），保证一定能收尾；补必测 |
| 机器人第七轮 P1（暂停后恢复绕过限流窗口，线程 4173706459） | 只在有续写时成立，已移到第二版；第 13 节记下约束：恢复时不能只凭"已有 claim"跳过闸门，必须按限流窗口的实际有效期重新校验，或者只为新派发的调用扣额度 |
| 机器人第八轮 P1（回执落库后、结果写入前停止，线程 4173778352） | 4.2：`stop` 动作只记录停止，从不在 SQL 里收尾；"调用已关闭但还没有结果"视为等待宿主重建，由停止请求的宿主只读重放回执，提交截到 `stopAt` 的结果后再收尾；与原 HTTP 的结果逐字相同、只收尾一次；宿主崩溃时由现有恢复路径收尾；补必测 |
| 机器人第九轮 P1（整理器运行期间停止，线程 4173825851） | 4.2：停止结果一律按 `stopAt` 截断，包括已有 primary 的情况；R2 只在 user_stop 下把 0106:452 的"完全相等"放宽为"前缀"；截断后不保存摘要，`organized:false`；补必测 |
| 机器人第九轮 P1（T2 信封的大小，线程 4173825854） | 4.3：T2 保存前按白名单只保留已校验字段；仍然超出时退到只含 `message` 的紧凑结果，标 `envelopeCompact:true`，保证一定能收尾；补必测 |
| 机器人第九轮 P1（累计全文传输，线程 4173825856） | 2.2 第 3 项：改为 `textDelta`（offset + 增量），服务端增量解析；每次新的流以完整快照开始；客户端 offset 不连续时重新拿快照；列入 C0 首版；补必测 |
| 机器人第九轮 P2（message 第一个属性，线程 4173825859） | 2.2 第 4 项：冻结 `envelopeOrder:'message-first-v1'`，提示词和 schema 说明都写明；不符合时不判失败，退回完成后显示，记 `messageFirst:false` |
| 第四版：机器人第十轮 P1（出卡导师回合完全缓冲，线程 4173860195；Owner 接受后列为实施前必须解决） | 新增 2.3：不改请求，宿主按"没出卡时投影助手文字、出卡后投影参数里的 `message`"实时显示，卡片结束后出现，切换时发快照；0、2.1 同步；7.2 增加写入负责人；10.1–10.3 补风险、回退和必测（改写现有 five-field 用例） |
| 第四版：机器人第十轮 P2（调用中重连拿不到快照，线程 4173860204；同上） | 新增 2.4：缩小承诺为"只有发起调用的流有中间文字，重连只重放终态"，沿用 #595 的等待和自动恢复，不新增持久状态；2.2 第 3 项改写快照、`rev` 和不一致时的处理；页面显示由 Owner 确认（第 9 节）；10.3 改写重连必测 |
| 第四版总控审阅（head `04bfee66`，P2×1、P3×3 及补充） | 7.1、7.2、第 0、11 节：#632 同时改 `execute.ts`、`executionStream.ts`、`admission.ts`，C0+C1 在 #632 合并后再写；2.3：`message` 前缀非空才切换，不先清空气泡；2.2：快照到达时丢弃节流窗口里未发出的增量；2.4：补充持久化方案的锁竞争理由（`0106:398-400`），推荐方案改为同一标签页用 `sessionStorage` 保留已显示前缀，并写明 `page.tsx:167` 要改；第 9 节、10.1、10.3 同步 |
| 第四版 Owner 决定（重连体验，评论 5982731860） | 第 9 节记录 Owner 原话，去掉第 0 节和 2.4 的“待 Owner 确认”标记 |
| 第四版机器人 P2（替换快照与存储节流，线程 4178686535） | 2.4 第 3 项：替换型快照不受节流，先同步写入存储再显示，写入失败先删除存储项；10.3 补必测 |
| 第四版机器人 P2（复制标签页继承会话存储，线程 4178699613） | 2.4 第 3 项：只在原标签页重新加载时恢复，靠 `pagehide` 写入的短时标记区分；拷贝来的存储不恢复并删除；10.3 补必测 |

## 13. 第二版设计：自动续写（不在首版实施）

- **状态**：Owner 2026-10-03 决定，自动续写（最多 3 次）放到上线后的第二版。本章保留第二版审查过的设计，供第二版定稿时使用。**首版不实施本章的任何内容**，首版的实施清单、迁移和必测都不包含它。
- 第二版定稿时，需要基于当时的 staging，重新核对本章的全部引用和依赖（PAYG 的实际实现、首版的 4.2 停止和 4.3 保存上限），并重新经过独立审查。
- 本章里的小节号保留第二版原稿的编号（"原 4.x"等）；章内的"见 4.x"指本章对应的原小节。
- **第二版必须满足的新增约束**（机器人第七轮，线程 4173706459）：
  - 现有调用限流是一分钟和一天两个滑动窗口，不是持久的预留。
  - 如果执行在 `waiting_credits` 等待的时间超过窗口，首次扣的额度已经过期。
  - 这时如果只凭"已有 claim 过的 call"跳过闸门，恢复后派发的续写调用就不在任何有效窗口里，用户可以借暂停的执行绕过调用上限。
  - 第二版必须二选一：按窗口的实际有效期持久化并校验预留；或者每次恢复只为新派发的调用扣额度。
  - 必测覆盖两个窗口各自过期后的恢复。
  - 原 4.3 中"跨 HTTP 继续只检查、不扣"的写法，按这条约束修改。
- 原 9 节的 Q1（最多续写几次）在第二版定稿时再交 Owner 确认。

### 原 4 自动续写（C2）

### 原 4.1 概念和适用范围

- 一次用户回答仍然是**一张 run、一个 execution**。
- 每一**段**是这个 execution 里的一次调用，有自己的 sequence、请求 hash、claim、回执和 PAYG v2 冻结与结算。
- 各段正文的**唯一权威来源是已落库的回执**。全文是各段正文按 sequence 顺序的确定性投影（4.3 的拼接规则）。
  发给模型、实时显示、重放和最终保存，都用同一个投影。
- **按"可见正文由谁产生"分成三类**。首版只给每类一条规则，不按每种线上格式各设计一套：

| 类别 | 例子 | 流式 | 续写 | 停止 |
|---|---|---|---|---|
| **T1 纯文本**：模型直接写正文 | 导师（v5，宿主再把正文封进信封） | 是 | **是** | 4.6 停止路径 |
| **T2 模型写的信封**：模型输出 JSON 对象，公开字段是 `message`，其余是私有协议字段 | 定位页 `step` 回复（含带附属整理器的主回复） | 是，只流 `message` | **否**（`maxSegments=1`） | 4.6 停止路径 |
| **T3 其他结构化输出** | plan 的 JSON 数组；2.1 中暂不收拢的 runtime 页和选题页 | 否，整段缓冲 | 否（`maxSegments=1`） | 现有 `runtime_cancel` |

- **T2 不续写的原因**：`length` 停下时 JSON 还没写完。跨段拼接 JSON 属于结构化续写，首版不做。
  - 正式环境的单次上限提高以后（3.1），T2 写满的情况很少。
- **T2、T3 遇到有正文的 `length`**：不再静默当成功，结果记 `completeness:'length_limit'`，不作为合格的结构化成果，显示和保存沿用现有的"未完成"通知。
- **"信封"一词的统一定义**（4.6、4.8 共用）：结果 body 是一个 JSON 对象，公开字段是 `message`。
  - 包括 T1 导师的宿主信封（`agentTurnBody`），也包括 T2 模型写的信封。
  - 两者用同一条规则：取 `message` 计量和截断，其余字段原样保留，重建信封后，用该格式**正常完成时的同一个**校验函数检查。

### 原 4.2 触发和继续条件

在文字回答阶段，每一段结束后按下面的顺序判断。

**A. 是否需要续写**：

- `finish_reason=length`；
- 本段正文按拼接投影去重后**非空**；
- 本段没有被截断的工具调用。

不满足时：

- `stop`：正常完成；
- 正文为空的 `length`、截断的工具调用：沿用现有失败路径；
- 去重后零进展：按 C 的"长度上限"收尾，防止重复花钱。

**B. 能否继续**：

- 已写段数 < 冻结的 `maxSegments`；
- 没有未知费用的调用；
- 没有停止或取消；
- 账号有效；
- 下一段没有被 L 拒绝；跨 HTTP 继续时，全站暂停开关没有打开（只检查、不扣额度，见 4.3）。

**C. 容量是否放得下**：

1. **结果容量**（4.8）：
   - 按**已经实际写出**的正文字节判断：剩余可保存空间至少还有 `MIN_SEGMENT_ROOM` 时才续写；
   - 下一段的 O 按剩余空间缩小到够用为止；
   - 保存前按实际字节截短兜底。
2. **完整请求容量**：
   - 下一段的完整最终请求（按实际 JSON 序列化计算 B，含已写全文、继续指令和工具定义）通过现有的完整请求检查；
   - 检查的上限是冻结在续写合同里的 `continuationInputBytes`（4.3），并且不超过报价的 `inputLimit`；
   - 同时满足 `T + O ≤ contextTokens`，并且落在 PAYG 已验证的 profile 内。
3. **调用次数**：总调用次数不超过冻结的 `maxCalls`（4.3）。

C 中任何一项不满足时：

- 不派发；
- 以已写全文**收尾**（不是"成功完成"）；
- 结果元数据记 `completeness:'length_limit'`；
- 界面在正文**外面**显示"已达到单次回答的最长长度"，不把提示写进正文，以免破坏结构化解析。

**收尾和成功是两回事。** 结果元数据 `completeness` 有三种取值：`complete`、`length_limit`、`stopped`。

- 三种情况都通过现有 `complete` 分支保存，`kind` 仍是 `usable_result`，所以聊天里能展示已写内容。
- 依赖"完整成果"的消费者（报告候选、结构化解析、B1 capture）只采用 `completeness:'complete'` 的结果；带附属整理器的执行还要求 `organized:true`。`stopped:true` 只表示用户点过停止，本身不阻止采用。
- 附属整理器：`length_limit` 时照常处理用户已经看到的正文（现有 `complete` 分支要求有 summary），整理结果同样带上来源的 `completeness`；`stopped` 时不再整理，见 4.6 的 2B。
- 下列情况都不会把前面已持久化的正文误判为合格成果，这些正文仍然可读：
  - 第 `maxSegments` 段仍然是 `length`；
  - 容量耗尽；
  - 停止；
  - 最后一段被拒、返回空正文或坏的工具调用。

下文提到的 `lengthLimit`，是 `completeness:'length_limit'` 的简写。`stopped:true` 是另一个字段，只表示用户点过停止（4.6），和 `completeness:'stopped'` 不是一回事。

**D. 时间**：

- 每一段开始前，如果本次 HTTP 剩余的工作时间小于 `SEGMENT_DISPATCH_MS`（等于该环境的单次供应商超时：staging 240 秒，正式环境按 3.1 由函数时长推出），就不在本次开新段，而是按 PAYG 的 `waiting_resume` 落点，交给下一次 HTTP。
- 用于对话正文调用时，它取代 `MIN_MODEL_DISPATCH_MS`（60 秒）。
- Hobby（工作预算 265 秒）下：第一段及其前置开销超过约 25 秒时，第二段就要换一次 HTTP；开销更少时，同一次 HTTP 里也可能接着写。
- 首版不在一段写到一半时主动中止供应商流，原因和限制见 3.3。

### 原 4.3 续写请求和冻结合同

Claude 新模型不支持 assistant 预填，所以续写段是**以 user 结束的新一轮**：

```
第 k 段（k ≥ 2）的输入 =
[ 最初请求前缀：第 1 段的 system、历史、当前 user，与第 1 段逐字节相同；
  第 1 段之前已完成的每一次工具往返，各出现一次：一条带 tool_calls 的 assistant，加上对应的 tool 结果，
    原样引用，按原 toolCallId 读取，不重新执行；
  assistant: 最新的全文投影（第 1..k−1 段按 join-v1 拼接，不含思考、不含工具调用），
  user: CONTINUE_V1（恰好一条） ]
```

- **始终从第 1 段的输入重建，不在上一段的输入上追加。**
  - 第 k−1 段的输入里已经有一条 assistant 全文和一条 `CONTINUE_V1`。如果在它上面追加，之前的输出和指令会递归重复，撑大上下文和费用，模型还会看到相互矛盾的重复历史。
  - 所以每个续写段的输入都只有**一条** assistant 全文（最新投影）和**一条** `CONTINUE_V1`；工具往返只来自第 1 段之前，因为续写段不允许新的工具调用（见下文"工具"）。
  - 续写段的 B 随最新投影的长度增长，不随段数重复累加。

- **冻结合同**：新准入在冻结上下文里加入下面的字段，随 `sourceHash` 冻结。旧 execution 没有这个字段，按"不续写"处理，字节不变。
  ```
  continuation: { version: 'continue-v1', maxSegments, instruction: 'CONTINUE_V1',
                  joinVersion: 'join-v1', continuationInputBytes }
  ```
  - `continuationInputBytes` = 原完整请求上限 + 4.8 的正文字节上限。它由宿主在准入时计算并冻结，用于让续写段的完整请求检查有一个明确的、经过验证的上限，**不跳过**完整请求检查。
    - 用户材料预算（用途的 `inputBytes`）仍然只约束第 1 段的材料和历史选择，不因续写放宽；
    - `continuationInputBytes` 只额外容纳宿主从回执投影出的已写全文和固定指令；
    - B 一律按续写段**实际序列化后**的完整请求计算，而不是"原请求 + 正文"的估算；
    - `continuationInputBytes` 同时不得超过报价 `inputLimit` 和 PAYG 已验证 profile 的 B 上限，取较小值。
- **调用次数**：
  - **每段是宿主发起的一次独立 `runRuntime` 调用**，不靠加大 SDK 的 `maxTurns` 实现。
    - 原因：v5 要求 `commitSessionOnSuccess` 时 `maxTurns === 1`（`runner.ts:82-83`），一个 SDK 循环只能是一次调用。
    - 续写段保持原来的 `maxTurns`（v5 为 1），以不写 Session 的方式运行；Session 只在最终完成时由宿主写一次。
  - 准入时，冻结的 BILL2 `maxCalls` 加上 `maxSegments − 1`；搜索、匹配、整理器各自的次数不变（`admission.ts:207` 的 `primaryTurns` 计算不变）。v2 没有 run 级预扣，所以不会放大冻结额。
  - 这个预算成立的前提是**每个续写段固定只有一次模型调用**：续写段不允许新的工具调用（见下文"工具"），所以不会出现"工具往返再加一轮模型调用"。
  - **calls 闸门只在第一次扣，一次扣满全部预留**：
    - 现有首次调用闸门（`execute.ts:139-145`）按冻结的 `execution.billing.limits.maxCalls` 扣限流额度，而 `maxCalls` 已经包含了 `maxSegments − 1` 个续写段。
    - 所以续写段的额度在第一次闸门里已经扣过，后面任何一次 HTTP 交接（`waiting_resume`、`waiting_credits` 之后继续）都**不再扣**。
    - 跨 HTTP 继续时只做**不扣额度的检查**：
      - 检查全站暂停开关 `stopNewCalls`，由 `newWorkGate` 的现有 `pauseResult` 判断；暂停时保持等待，不自动循环（4.4）。
      - 检查依据是这个 run 是否已有 claim 过的 call：claim 只发生在闸门通过之后（`execute.ts:139-149`），有就证明首次闸门已经扣过。不新增持久状态。
    - 同一次 HTTP 里的后续段，按现有 `gateChecked` 不再过闸门。
    - #553 §5 写的是"续跑按剩余 call 数重新过 calls 闸门"，这会对续写重复扣额度。本方案对续写的恢复改为只检查、不扣，PAYG PR-B 实施时按此对齐。其他类型的恢复是否同样只检查，由总控在 #553 同步时决定。
  - PAYG 恢复不重置已用调用数（#553 §5），claim 仍然受冻结的 `maxCalls` 约束。
  - 窗口和限流计数按 #590 已合并的规则计算，本方案不另设预算。
- **`CONTINUE_V1`**：宿主固定指令，所有 Skill 共用。大意是：
  - 上一条回答因长度中断，请从中断处直接接着写；
  - 不重复已写内容，不加开场白、过渡语或总结；
  - 如果停在未闭合的代码块、表格或列表里，就在里面接着写。
- 续写是一次新的对话轮，**不保留**上一段的推理状态，也不保证词句或代码块无缝衔接；衔接靠固定指令和 `join-v1`。
- **工具：续写段不允许新的工具调用**（总控技术决定）。
  - 续写只负责把正文写完。需要的工具结果已经在前缀里，续写段不再搜索、不再读资料、不再出提问卡。
  - 工具定义仍然原样发送，不加 `tool_choice`，保持请求形状和缓存前缀稳定。现有 `guardedFetch` 也拒绝 `tool_choice`（`runner.ts:102`）。
  - `CONTINUE_V1` 写明"不要调用工具，只续写正文"。
  - **模型仍然请求工具时**：
    - 在交给 SDK 之前，由宿主拒绝，**不执行**任何工具：不扣搜索费、不读资料、不出卡片。
    - 这次调用照常按回执结算一次（模型已经产生输出）。
    - 本段的正文内容（如果有）按 `join-v1` 计入投影，工具调用部分丢弃。
    - 然后以 `length_limit` 收尾，不再开新段，以免再次请求工具时又多花一次。
  - **对付费搜索和 `read_source` 的影响**：续写段不会再产生搜索费用或资料读取；搜索次数和 `read_source` 的冻结配额只在第 1 段及之前消耗，与续写无关。
  - **对导师提问卡的影响**：长回答如果写满上限，结尾的提问卡不会在续写段里出现。这种情况下回答以正文收尾，下一轮对话照常可以出卡。
- **线路要求**（只涉及前缀里已经有的工具往返）：
  - 有些线路要求带工具续接时原样保留思考块或思考签名：OpenRouter 要求保留工具推理块，Gemini 3 当前轮的函数调用要求保留 thought signature。
    现有 `openRouterHistory.ts` 会剥除 reasoning，并且明确拒绝携带 OpenAI reasoning 的工具续接。
  - 因此，如果续写段的输入前缀里含有本轮的工具调用，而该线路要求保留思考签名或思考块，就不续写，按 C 收尾（结果标 `lengthLimit`）。
    首版不为续写改动 `openRouterHistory.ts`。
  - 不含本轮工具调用的纯文本续写不受影响。
  - 三类主力模型各自的续写请求能否被接受，没有真实调用证据。C2 必测要逐模型验证；验证不通过的模型，`maxSegments` 按 1 处理。
    这是按模型能力区分，不是按 Skill 区分。
- **拼接 `join-v1`**：
  - 各段原文不改，回执保持原样；
  - **重叠检测有上限**：只在长度 L ∈ [16, 64] 字符（Unicode 码点）的范围内，找"已写全文的后缀 = 新段的前缀"的最长精确匹配；
    匹配不跨代码块或表格边界时，去掉新段开头的这 L 个字符。
  - 实时流在新段开头先缓冲 64 个字符，正好覆盖所有候选长度：
    - 缓冲满 64 字符，或者新段结束时，再做判断并输出；
    - 判断只依赖已写全文和新段的前 64 个字符，所以实时输出和重放时的投影逐字相同；
    - 已经显示的文字不回退。
  - 超过 64 字符的重复**不去除**，原样保留在正文里。这是首版接受的限制，由 `CONTINUE_V1` 的"不重复已写内容"来减少发生。
  - 除此之外不改写模型正文。
- **重放**：续写请求由回执和冻结合同确定性地重建，hash 相同，只读回执，不重发。
- **Session**：只在最终完成时写入一条 assistant 消息，内容为全文投影（受 4.8 约束）。继续指令和中间各段都不写入 Session。
- **B1 capture**：只在**最终完成**、`completeness:'complete'`（带附属整理器时还要 `organized:true`）时幂等执行一次，不按段执行。

### 原 4.4 一次回答的流程

```
准入（冻结 continuation、O、maxCalls）
→ 段 1：claim → dispatch → 流式输出 → 回执落库 → 结算
→ A 需要续写？
   ├─ 否 → complete（全文 = 投影）
   └─ 是 → B 能继续？
            ├─ 否 → 按原因收尾（未知费用 → cost_pending；停止 → 4.6；余额 → waiting_credits）
            └─ 是 → C 放得下？
                     ├─ 否 → complete（lengthLimit）
                     └─ 是 → D 时间够？
                              ├─ 是 → 段 k+1（同一次 HTTP）
                              └─ 否 → 落点 waiting_resume → 前端继续 → 新 HTTP
```

- **落点**：结算第 k 段和写入"下一段可继续"的断点在同一次原子操作里完成（PAYG §5）。断点只放引用：下一段序号、已写段的 sequence 列表、epoch。
- **前端继续**：`executeStream` 返回 `waiting_resume` 时，前端用原 executionId 调继续入口。新流的第一个 text 事件就是已写全文。
  - 这一步需要扩展 #595 的恢复判定。现有 `useAutoStepRecovery` 只恢复已到终态的 execution，`waiting_resume` 不在其中。
  - 新的判定按服务器上的游标和 epoch 继续，保留同一个气泡和 busy 状态。
  - 只有 `waiting_resume` 会自动继续，并且每个 epoch 最多自动发起一次。
  - 下面这些**不进入**自动继续：继续请求被 calls 闸门拒绝、429、503、`waiting_credits`、`cost_pending`、撤权、资料冲突。它们保持原状态并显示对应提示，沿用 #594 已合并的拒绝边界。
- **段间停顿**：等于一次新请求加上新一段的首字时间，具体时长没有实测，不作产品承诺。
- **服务端实时文字**：`partial` 改为"前 k 段投影 + 当前段"，text 事件仍然发全文，前端渲染不变。

### 原 4.5 刷新、断线、多标签页

- **断线**：本次函数执行期间不受影响，当前段照常写完、落库、结算。下一段如果需要新的 HTTP，就停在 `waiting_resume`，等客户端回来。
  不建后台任务。关闭页面以后，没有任何东西会继续写。
- **刷新**：恢复信封在终态前不释放。页面回来后按 4.4 的扩展判定继续。
  正在写的那一段完成前，看不到新增文字（沿用 #547 §7 "只读已持久化的完整调用结果"），已完成的段立即可见。
- **两个标签页**：继续入口是 epoch CAS，只有一个能领到下一段。
- **重放**：重复的继续请求只读回执，不重复派发、不重复扣费。

### 原 4.6 停止：先保存已写内容，再收尾

**问题**：现有 `runtime_cancel` 会立刻调用 `bill2_cancel` 和 `bill2_finalize`，把没有结果的 execution 改成 `cancelled`；
`complete` 分支遇到 `cancel_requested` 会拒绝。所以如果停止复用 `runtime_cancel`，正在写的那一段返回时无法保存。

**做法**：复用现有机制，不新建 RPC 家族、表或状态机。

1. **入口**：沿用现有 `runtime.cancel` 路由，增加可选参数 `stopAt`：用户停止时屏幕上已经显示的**可见正文**的 Unicode 码点数。
   - 前端用 `Array.from(text).length` 计算。数据库用 `char_length` 计算，口径一致。
   - **可见正文**按 4.1 的统一定义：**凡是信封格式，一律取信封的 `message`**，不按线上格式分别处理。
     - 导师回合（T1）：`result.body` 是 `agentTurnBody(message, card)` 生成的信封（`shared/agentTurn.ts:217-225`、`runtime/agentTurnResult.ts:9-12`）。
     - `step` 回复（T2）：`result.body` 是模型写的信封，`publicMentorText` 只露出 `message`。
     - 不是信封的纯文本 body（以后的 T1 纯文本格式）：可见正文就是 `body`。
     - T3 不走停止路径，也就不需要可见正文。
   - 实时 text 事件发送的也是可见正文的投影，前端计数和服务器投影是同一份文本。
   - 只对冻结了 `continue-v1` 的 execution 改走下面的停止路径。旧 execution 和不续写的入口仍走原 `runtime_cancel`，语义不变。
2. **SQL**：在现有的 `runtime_execution` 函数里加一个 `stop` 动作，做法是在 PAYG PR-B 之后**追加**一张迁移，重定义该函数；不修改已合并的迁移。
   它在同一个事务里按现有锁顺序（session → execution → run）执行：
   - **(a) 记录停止**：复用 PAYG 的暂停字段和 epoch，写入 `paused_reason='user_stop'`、`stopAt` 并递增 epoch。之后：
     - v2 claim 拒绝新调用；
     - 继续入口的 CAS 失败；
     - 只把 prepared 但还没派发的 call 改为 cancelled，并释放冻结；
     - **不调用 `bill2_cancel`，不设置 `cancel_requested`**。
   - **(b) 没有已派发、未结束的 call 时**（例如停在 `waiting_*`）：同一个事务内按 `complete` 的规则保存结果，然后依次调用 `bill2_close('delivered')` 和 `bill2_finalize`。
     - 结果由宿主根据回执投影截到 `stopAt`（截断规则见下面第 2A 项），元数据 `stopped:true`；
     - execution 进入 `completed`；如果有未知费用，进入 `cost_pending`。
   - **(c) 有已派发、未结束的 call 时**：只做 (a)，返回 `stopping`。
     - 那次调用所在的 HTTP 拿到回执后，按下面的规则走 `complete` 分支保存结果（含这一段）。
     - 因为 `cancel_requested` 没被设置，`complete` 能成功。
   - **停止下的结果字段**（宿主生成，(b)、(c)、(d) 共用）：
     - `stopped:true`：`user_stop` 下的每个结果都必须带，没有例外。
     - `completeness`：
       - 主回复已经完整写完，并且没有因为 `stopAt` 被截断时，为 `'complete'`；
       - 否则为 `'stopped'`；
       - 遇到 4.8 的保存截短时为 `'length_limit'`。
     - `organized`：只在 `attachedOrganizer` 的执行里出现。有 summary 时为 `true`，没有时为 `false`（见 2B）。
   - **`complete` 分支在 `paused_reason='user_stop'` 下的完整规则**（C2 追加迁移重定义 `runtime_execution`；不在 `user_stop` 下的执行完全保持 0106 现状）：
     - **R1**：结果必须带 `stopped:true`。
     - **R2 正文**：
       - 已有 `primary_result` 时，沿用 `0106:452`：body 必须等于 primary 的 body，不做 `stopAt` 计数（主回复已经全部写完并显示）；
       - 没有 `primary_result` 时，**可见正文**的 `char_length` 不超过登记的 `stopAt`：
         - 信封格式（T1 导师、T2）：把 `p_result->>'body'` 解析为 jsonb，取 `->>'message'` 计数；解析失败，或者 `message` 不是字符串，都直接拒绝；
         - 非信封的纯文本：直接对 `p_result->>'body'` 计数；
         - 是不是信封由冻结上下文的 `providerRequestFormat` 决定，不由结果自报。
     - **R3 整理器**（只针对 `attachedOrganizer`）：
       - 结果带 summary 且 `organized:true`：现有的 `0106:453` 检查本来就会通过，不改；
       - 结果不带 summary 且 `organized:false`：跳过 `RUNTIME_ORGANIZER_PENDING`；
       - 其他组合（不带 summary 却标 `organized:true`，或者带 summary 却标 `organized:false`）一律拒绝。
     - **R4**：`completeness` 只接受 `complete`、`stopped`、`length_limit` 三个值。
     - 除 R1–R4 之外的检查（`kind`、`active_execution`、Session 批次、结果冲突）与 0106 相同。
     - `stop` 动作 (b) 调用同一段 `complete` 逻辑；`checkpoint_primary` 不改。
   - **2A. 截断后重新封装**（宿主执行，(b)、(c)、(d) 共用）：
     - **非信封的纯文本**：`body = 投影前 stopAt 个码点`。
     - **T2 模型写的信封**（只有一段，因为 T2 不续写）：
       - 在途段落库后，用该格式**正常完成时的同一个**解析函数解析完整 body；
       - 把 `message` 截到前 `stopAt` 个码点，私有协议字段原样保留，重建信封；
       - 重建后用同一个校验函数检查；
       - 解析失败（例如模型输出本身不合格），或者截断后校验不通过时，不保存坏的协议 JSON，按 (e) 处理：没有正文，状态 `cancelled`，这次调用照常按回执结算一次。
     - **T1 导师信封**：
       - 取全部已写段的 `message` 投影，截到前 `stopAt` 个码点，去掉首尾空白，得到 `m`；
       - 卡片 `card` 只在**没有发生截断**时保留，即 `stopAt` ≥ 完整 `message` 的码点数，并且这一段确实带回了卡片。
         截断时 `card = null`，因为用户没有看完正文，问题卡也没有显示过。
       - 带卡片的导师回合只有一段：截断的工具调用不续写（4.2 A），续写段也不允许调用工具（4.3）。
         所以"卡片 + 多段正文"的组合不存在。
       - 再用 `agentTurnBody(m, card)` 重新生成信封，经过与正常完成相同的 schema 校验后保存。
         对冻结了 `continue-v1` 的 execution，`message` 的长度上限按 4.8 的字节规则，不再是 20000 字符。
       - `m` 为空且 `card = null` 时，`agentTurnBody` 会拒绝（`AGENT_TURN_BODY_EMPTY`），这种情况按 (e) 处理。
     - 截断永远发生在可见正文上，不截 JSON 字符串，所以不会产生无效 JSON。
     - 4.8 的保存前截短同样作用在可见正文上，之后再重新封装。
   - **(d) 那次 HTTP 已经结束**（函数被回收、断线）：下次恢复或重放时读到 `user_stop`，只读回执，然后按 (b) 收尾。
     - 回执结果不明时，按 PAYG 查账；仍然不明就进入 `cost_pending`，结果是已持久化各段的投影；
     - 不重发，不补扣。
   - **2B. 带附属整理器的执行被停止**（`attachedOrganizer`，C0 收拢的定位页主回复）：
     - **问题**：停止时整理器可能还没跑。现有 `complete` 分支在 `attachedOrganizer` 下要求有 `primary_result` 和 `summary`，否则以 `RUNTIME_ORGANIZER_PENDING` 拒绝（`0106:452-453`）。而停止又拒绝新的 claim，整理器之后也没法再跑。
     - **做法：停止后不整理**（与"停止 = 不再产生新的调用和花费"一致，不为整理器另开一次调用）：
       - 结果保存已写正文，`stopped:true`、`organized:false`，没有 `summary`。`completeness` 按上面的规则取值：已有 `primary_result` 时为 `'complete'`，否则为 `'stopped'`。无论哪种，`organized:false` 都不会被 B1 和报告采用。
       - 已经有 `primary_result`（主回复已完成、整理器还没完成）时，body 就用 `primary_result.body`，不再按 `stopAt` 截断（主回复已经全部显示）。现有的"body 必须与 primary checkpoint 一致"校验（`0106:452`）保持不变。
       - 整理器的调用如果已经派发（在途），按 (c) 处理：等它的回执落库，正常带 summary 完成。
         结果为 `stopped:true`、`completeness:'complete'`、`organized:true`，满足 R1–R3。
       - 整理器还没派发：按 (a) 取消未派发的 call 并释放冻结，然后按 (b) 保存未整理的结果。
       - 停止时主回复的段还在途：这一段落库后，宿主**不再** checkpoint primary、也不派发整理器（claim 已被拒），直接按 R2（没有 primary 的分支）和 R3（`organized:false`）保存。
     - **需要改的 SQL**：只有上面 R1–R4 这一处。`checkpoint_primary` 和不在 `user_stop` 下的分支都不改。
     - **右侧整理怎么处理**：
       - `organized:false` 时，这一轮不更新右侧信息，B1 capture 不执行；
       - 界面在这条回答下显示"已停止，本轮未整理"；
       - 不自动补整理，也不在下一轮自动补做这一轮的整理。用户可以重新发送，或者在后续的对话驱动设计里手动整理（CONTENT-CONVERSATION-DRIVEN）。
   - **(e) 一个字都还没写出来**（`stopAt=0`，且没有任何已落库的正文）：结果为空，等价于现有取消，最终状态 `cancelled`，没有正文。
     在途的那次调用仍按回执结算一次。
3. **不重复扣费的保证**：
   - 每段调用只由自己的回执结算一次（BILL2 幂等，重复回执返回原 D/e）；
   - run 只由一次 `bill2_close` 和 `bill2_finalize` 收尾，(b) 和 (c) 两条路径都受同一把锁、同一个 `paused_reason`/epoch 约束，谁后到谁只读；
   - 停止从不在调用已派发时释放它的冻结，所以不会出现"已释放冻结、又要扣这一段"的冲突；
   - 未派发的 call 只取消，不扣费。
4. **正在写的那一段怎么结算**：按回执和名义费用**整段**结算（供应商按实际生成量收费，和原生停止生成相同）。保存的正文截到 `stopAt`，完整原文留在回执里。
5. **界面**：
   - 点停止后立刻停止显示新字，标记"已停止"，退出自动继续；
   - 收尾完成后，用服务器上的结果替换显示；正文与停止时一致（截到 `stopAt`）。
6. **竞态**：
   - 停止和继续同时到达时，epoch CAS 只让一个成功。
   - 继续先成功：已派发的段按 (c) 处理。
   - 停止先成功：继续请求失败，只读结果。

### 原 4.7 余额不足、注销、未知费用

- **余额不足**（Owner 已定"暂停在两步之间、充值后继续"）：
  - 下一段 A < L 时，落点 `waiting_credits`，显示已写全文和继续按钮；
  - 充值本身不触发生成（PAYG），用户点继续后从第 k+1 段接着写。
- **注销**：`waiting_*` 和进行中的续写按已合并的 #611（0160）以及 PAYG 的注销收尾处理。继续入口和下一段的 claim 都会被拒，已结算的段保留账务。
- **未知费用**：不开新段，进入 `cost_pending`，已持久化各段的投影可见，不重发。

### 原 4.8 结果容量：按实际字节计量，永不超过 262144

- **约束对象**：下面三处都按**序列化后的字节数**计算，上限 262144。底层上限不改。
  - `bill2_close` 的 `p_result`（`0105:309`，`0156:165`）；
  - `checkpoint_primary`（`0106:440`）；
  - Session item（`0106:40`）。
- **不再按"每 token 最坏 8 字节"给整段预留**：
  - 第一版的做法在正式环境 O=32768 时要预留 262144 字节，正好顶满上限，连正常的第一次调用也会被挡掉。
  - 8 字节/token 仍然只用于响应接收上限（`responseCapacity.ts`），那里约束的是网络接收，不是保存。
- **计量方式**：
  - 宿主在流式过程中和每段结束后，按**实际**结果投影计算 `bytes(result)`；
  - 计算方式与数据库 `jsonb::text` 的序列化一致（JSON 转义，非 ASCII 字符保持 UTF-8），由测试对照数据库实际的 `octet_length` 校准。
- **计量对象是整个结果**：`bytes(result)` = `octet_length(p_result::text)`，包括信封、卡片、summary、元数据，以及导师回合 body 的**双层转义**。
  - 导师回合的 body 是 JSON 字符串，又嵌在结果 JSON 里，所以正文里的一个引号或反斜杠最终占 4 字节，一个换行占 3 字节，一个中文字占 3 字节。
  - 所以每个 UTF-16 码元最坏按 4 字节计算。
- **结果只有两种形状**（4.6 2A）：
  - **形状 P，纯正文**：可以多段，不可能带卡片，信封里 `card:null`。
  - **形状 C，带卡片的导师回合**：只有一段，不续写。
- **形状 P 的预留** `RESERVE_P`，用于续写前的判断：
  - 信封和元数据的固定开销；
  - 附属整理器 summary 的最坏值：`v3_summary_max_tokens` 上限 4096 × 8 字节 = 32768；
  - 4096 字节余量；
  - 合计约 4 万字节。不含卡片，因为形状 P 不可能有卡片。
  - 可用于正文的空间：`ROOM = 262144 − RESERVE_P`。
- **形状 C 的最坏值**：
  - `questionToolCardSchema` 允许 `message` 和 `recommendationReason` 各 20000 个 UTF-16 码元；
  - `agentTurnBody` 把卡片的 `message` 在信封顶层再存一份；
  - 再加上 `question` 500 和 `options` 5 × 200。
  - 合计最多约 61500 码元，按每码元 4 字节约 246000 字节；再加 summary 最坏 32768 字节，可能超过 262144。
  - 所以形状 C **不能**靠预留来保证，由下面"保存前截短"的规则处理。
  - 本方案不改卡片 schema。卡片 schema 属于提问工具协议，单独调整会影响导师提示词。
- **第一次调用不受影响**：第一段照常用该环境的 O 派发，派发前不做容量预留。
- **续写前的判断**：
  - `bytes(已写正文)` 指已写正文在结果里的实际序列化字节（导师回合按双层转义计算）。
  - 只有 `ROOM − bytes(已写正文) ≥ MIN_SEGMENT_ROOM`（首版 16384 字节）时才续写，否则以 `lengthLimit` 收尾。
  - 续写段的输出上限取：
    ```
    O_k = min(O, floor((ROOM − bytes(已写正文)) / ρ))
    ```
  - ρ 为每 token 的典型序列化字节数，首版取 4：中文约 3 字节/字，英文平均每 token 不到 4 字节。
  - ρ 用实际回执校准，只用来**减少付费写出、却存不下的 token**，不承担"不超过上限"的保证。
- **保存前截短（唯一的硬保证）**：最终保存前，按实际的 `bytes(result)` 检查，超过 262144 时按固定顺序截短。截短都在 Unicode 码点边界进行，每截一次重新封装、重新计量：
  1. **形状 P**：截短可见正文，导师回合截 `message` 后重新调用 `agentTurnBody`。
  2. **形状 C**：
     1. 先截短 `message`。信封顶层的 `message` 和 `card.message` 截成**同一个**值，保持 `agentTurnResult` 的"两份一致"；
     2. 仍然超出时，截短 `recommendationReason`。
     - 两者都至少保留 1 个字符，满足 schema 的 `min(1)`；
     - `question`、`options`、`recommended` 和 summary 永远不截。
  - **能保证的依据**：除这两个长文本以外的部分，最坏约为：
    - `question` 和 `options` 1500 码元 × 4 字节 = 6000；
    - summary 32768；
    - 信封、元数据和余量约 8192；
    - 合计不到 47000 字节。
    - 所以两个长文本至少还有约 215000 字节可用，截短后一定能放下，并且截完仍然通过 `questionToolCardSchema` 和 `agentTurnBody` 的校验。
  - 截短后记 `completeness:'length_limit'`，完整原文仍在回执里。
  - 所以无论 O、段数、卡片、字符组成如何，保存都不会因为超过上限而失败；正常的第一次调用也不会被预留挡掉。
- **Session item**（`0106:40`）：
  - 形状 P 由宿主在最终完成时写入一条 assistant 消息，内容是截短后的投影，受同一个 ROOM 约束。
  - 形状 C 沿用 v5 现有的 Session 写入，但写入前按**实际序列化后的字节数**计量**每一个** Session item（`octet_length(item::text)`，与 `0106:40` 的 CHECK 口径一致），而不是只估算卡片字段。
    - 卡片回复除了工具调用参数（`message`、`recommendationReason`、`question`、`options`），还可能带一段普通 assistant 文本（伴随文本，`streaming.integration.ts` 已覆盖这种形状）。
    - 伴随文本不公开，页面显示的是卡片的 `message`（`agentTurnResult` 只在没有卡片时才用它兜底）。
    - O=32768 时，光伴随文本就可能接近或超过 262144。
  - **写入前处理**，只作用于冻结了 `continue-v1` 的 execution：
    1. 带卡片时，伴随文本先截短到 4000 码元（与 `publicMentorText` 的显示上限同一量级）；
    2. 截短后这个 item 仍超过 262144，就整条丢弃伴随文本 item（只是不写入 Session，回执里仍然保留原文）；
    3. 工具调用参数所在的 item 按上面形状 C 的截短规则处理。这个 item 最坏约 41500 码元 × 4 字节，约 166000 字节，在 262144 之内。
  - 截短发生时，Session 写入和结果都用截短后的值，两者一致。
- **量级**（只作说明，以实测为准）：O=32768 写满时，中文正文约十万字节，在 ROOM 之内。
  所以正式环境一般只会在第二段续写时，才可能因为容量收尾。
- **为什么不提高 262144**：
  - 上面的做法已经保证不超过上限，并且第一次调用不受影响，所以不需要提高。
  - 只有实施时证明这个做法行不通（例如实际回答经常超过约 22 万字节），才把"提高结果上限"列为单独的 high 迁移，交 Owner 另行批准。不默认采用。
- **显示长度**：
  - 对冻结了 `continue-v1` 的 execution，`AGENT_TURN_MESSAGE_LIMIT`（20000 字符）改为由上面的字节规则约束；
  - 旧 execution 不变。

### 原 4.9 持久状态（AGENTS 第 5 节说明）

- **考虑过的现有机制**：
  - Runtime execution 和回执：每段正文的权威来源；
  - `runtime_execution` 的 `complete` 和 checkpoint：最终保存；
  - PAYG 的 v2 call、`waiting_*`、断点、epoch 和暂停字段：落点、继续和停止；
  - #595 的恢复信封与轮询：前端接续。
- **为什么够用**：这些已覆盖续写和停止需要的全部能力。**不新增表、RPC 家族、队列、定时器或状态机。**
- **最小新增**：
  - 冻结上下文里加 `continuation` 字段；
  - PAYG 断点里加续写引用；
  - PAYG 暂停字段增加取值 `user_stop`，并记录 `stopAt`；
  - `runtime_execution` 增加 `stop` 动作，`complete` 分支增加停止校验。
  - 后两项要在 PAYG PR-B 合并后用一张**追加**迁移完成，编号取当时 staging 最大号 + 1。
- **权威来源不变**：正文以回执为准，账务以 BILL2 为准，状态以 `runtime_executions` 为准。不另存第二份"全文"。

### 原 5 计费（以 #553 第七版为准）

- **每段一次 v2 调用**：
  - 按本段最终请求重新计量 B、T、U、G；
  - 冻结 H = min(G, A)；
  - 段前检查 L；
  - 按名义费用 n 结算，在 run 内累计、只进位一次（W/N/Δ）；
  - 没有"一次回答"级别的预扣。
- **用户多付的部分**：后面的段要重发更长的已写全文，所以用户的名义费用会随段数上升。缓存不抵扣名义费用（Owner 决定 12）；
  缺 token 时按 #553 的 `actual_fallback` 例外处理。
  准确的积分算例要在 PAYG 定价函数实施后，按当时的价格快照写进 C2 的 PR。
- **平台承担**：按 #553 原规则逐段计算（`e_cap`/`e_bound`），不做"每次回答最多一段"之类的推论。
  - 余额封顶冻结（H<G）不等于发生了平台承担：只有 Δ>H 时才产生 E。
  - 期间其他任务释放冻结、退款或赠送，也会恢复可用余额。
  - E 是没有收到的名义积分，不等于平台的现金亏损。现金成本看实际费用 c，按 #553 §3A 对账。
  - 后面的段 T 更大，U 和 G 也更高；并发调用、缓存写入溢价和价格变化，都按 #553 原规则逐段处理。本方案不给出"续写不增加平台风险"的结论。
  - 估算超界（`e_bound`）按 #553 处理：该模型退出收费准入，不以 U 作为实际损失的上限。
- **L**：沿用"精确模型 + 现有用途"的 L，不新增续写用途。报告用途（#547）的 L 要按续写后的工作负载重新核对，这一项由 #547 同步处理。
- **v1 路径**：PAYG 默认切到 v2 之前，新准入冻结 `maxSegments=1`（统一上限仍然生效）。

### 原 6 和提示缓存的关系

- **现状**：
  - #591 的 system 前缀缓存已上线；
  - #610（H1）已合并，但**默认不激活**；
  - 导师的历史断点要等 B2 激活后才有；
  - 非导师路径、开场轮、超出预留的轮次、历史对比轮可能没有历史断点。
- **续写段的缓存规则**：
  - 续写段**沿用第 1 段的断点身份和位置**，不把断点后移到已写全文上；
  - 第 1 段没有历史断点，续写段也不加。
- **adapter**：增加**一种**严格的尾部形状：`[…原调用的消息…, assistant 纯文本, user = 冻结的 CONTINUE_V1]`。
  - 只在宿主可信地传入 `continue-v1` 冻结合同时允许；
  - 尾部恰好一条 assistant 纯文本和一条 `CONTINUE_V1`，多于一条即拒绝；
  - 原有的配对工具历史照样允许；
  - 不靠检查用户文本来推断授权。
- **命中条件**：同前缀只是命中的条件之一。TTL（5 分钟）、最小长度和线路都会影响，充值、断线和长时间停顿都可能让缓存过期。
  必测只要求"有资格命中时，回执能证实命中；冷缓存、过期、没有断点时仍然正确"。
- **影响范围**：缓存只影响平台实际成本，不影响用户的名义费用。

### 原 9 需要 Owner 决定的事项

已定（Owner 2026-10-03，F1）：
- 正式环境 Pro 提高全站统一单次上限（32768 为首个候选，实施时核对费用和时间后定值）；
- 续写作为写满时的兜底；
- staging 保持 8192；
- 首版如实说明中途超时不能无感续写。

**Q1：一次调用写满上限时，最多再自动续写几次？**（兜底语义）

- 推荐：**最多 3 次**，staging 和正式环境同一个值。
- 理由：
  - **正式环境**：单次上限提高以后，绝大多数回答一次写完，续写很少触发。
    而且受 4.8 的保存容量约束，O=32768 写满时一段的中文正文约十万字节，实际最多还能续写一次左右，就会因为容量收尾。
    所以 3 次在正式环境只是不会被碰到的上限，真正起作用的是保存容量。
  - **staging**：8192 × (1+3) = 32768，与正式环境单次候选值相当。staging 能用同一套机制写出和正式环境同等长度的回答（例如 13 部分、最多 12000 字的报告），方便验收。
  - **防失控**：次数有上限，能防止模型一直写下去、无限花钱。
- 收尾：达到次数上限、保存容量、完整请求容量或遇到未知费用时，已写内容完整保存，正文外提示"已达到单次回答的最长长度"，不算完整成果（4.2）。用户可以接着发消息让它继续。
- **边界说明**（批准前请一并知悉）：
  - **费用**：一次回答的名义费用 = 各段名义费用之和。
    - 续写段要重发"原请求 + 前面已写的正文"，所以续写一次的费用高于前一段。
    - 单次上限提高后，单次调用的冻结额也按比例增大（3.1）。
    - 每段单独过启动门槛，余额不足时停在两段之间。
    - 具体积分算例在 PAYG 定价实施后，按当时价格写进 C1/C2 的 PR。
  - **时间**：一次调用最长受该环境单次超时限制（staging 240 秒；正式环境由函数时长推出，最长不超过 Pro 的 800 秒）。
    异常情况下多段都写满时，总用时是各段之和，段与段之间可能要换一次 HTTP。
  - **截断**：一次调用写到一半超时，这一段会丢失，不能无感续写（首版限制，3.3）。

可以直接复制的批准话：

> 同意对话原生体验方案：写满单次上限时最多自动续写 3 次，接近保存上限时提前收尾。

### 原 10.3 必测（第二版原稿，定稿时只保留续写相关的部分，并重新整理）

- **流式（C0）**：
  - `step` 回复（带整理器和不带整理器）能边写边出，写的过程中只显示 `message`，不显示 JSON；
  - plan 仍然整段缓冲，完成后显示；
  - 旧 execution 按原格式重放，字节不变；
  - 流式和非流式的账单证据等价；
  - runtime 页和选题页行为不变，写的过程中不显示半截 JSON。
- **统一上限（C1）**：
  - staging 8192 通过、8193 拒绝；正式环境用选定值做同样的边界测试；
  - 模型能力低于统一上限时取小值；
  - 正式候选值：响应、帧、回执容量按 R(O)/F(O) 推导，并证明在该 O 下回执原文不会被省略（`rawBodyOmitted`）；
  - 三类主力模型按实测速度，在该环境单次超时内写满 O，记录用时（只写日志）；
  - PAYG 已验证的 profile 覆盖选定的 O；
  - 后台表单只读；
  - version 1 配置可读。
- **续写**：
  - 第 1 段 `length` → 第 2 段 → `stop`，最终结果等于各段回执按 `join-v1` 拼接的投影；
  - `join-v1` 的重叠上限：重复 16–64 个字符时去除；重复超过 64 个字符时原样保留；新段短于 64 个字符时在段结束时判断；
    这三种情况下，实时输出（逐帧拼接）与重放得到的投影逐字相同，已显示的文字不回退；
  - 去重：正常去掉重复、去重后零进展时收尾、跨段的空格和换行、Markdown 表格和代码块跨段不被误删；
  - 流式缓冲不回退已显示的文字；
  - 写满 `maxSegments` 时以 `lengthLimit` 收尾；
  - 正文为空的 `length`、截断的工具调用、最后一段被拒或返回坏的工具调用时，前面已持久化的正文仍然可读，并且不会被当作合格成果；
  - 带工具调用的路径续写时，按原 toolCallId 读取结果，不重新执行工具；
  - 第 3、4 段的实际请求里，assistant 全文恰好一条（等于最新投影），`CONTINUE_V1` 恰好一条；第 1 段之前的每次工具往返恰好出现一次；不包含之前续写段的输入；
  - 续写段的模型请求工具（单个、多个、伴随正文、只有工具调用）：宿主在 SDK 执行前拒绝，不执行工具、不扣搜索费；这次调用只结算一次；伴随的正文计入投影；以 `length_limit` 收尾，不再开新段；调用总数不超过冻结的 `maxCalls`；
  - 线路要求保留思考签名的工具续接以 `lengthLimit` 收尾；
  - 每段是一次独立的 `runRuntime`（v5 保持 `maxTurns=1`），中间各段不写 Session，最终完成时只写一次；
  - `maxCalls` 按段数冻结，搜索、匹配、整理器的次数不变；
  - 四段的 Hobby 回复（跨多次 HTTP）只在第一次 HTTP 扣一次限流额度（等于冻结的 `maxCalls`），后续 HTTP 不再扣；
  - 后续 HTTP 遇到全站暂停时保持等待、不扣额度、不自动循环；首次闸门被拒的 execution 没有已 claim 的 call，继续时仍然要过完整闸门；
  - `completeness`：`length_limit`/`stopped` 的结果能在聊天中展示，但报告候选、结构化解析、B1 都不采用；
  - 逐模型验证续写请求能被接受，并检查衔接质量（Claude Sonnet 5.5、Gemini 3.8 Flash、GPT-6 Luna），
    付费调用次数和预算由总控另行申请，不沿用其他任务的额度。
- **容量（4.8）**：
  - 构造性证明（属性测试）：任意段数、任意 O（含 32768）、卡片、summary 和元数据的组合，保存前截短之后，序列化字节**永不超过** 262144；
  - O=32768 的第一次调用不会被容量预留挡掉；
  - `O_k` 按剩余空间缩小；剩余空间小于 `MIN_SEGMENT_ROOM` 时以 `lengthLimit` 收尾；
  - 宿主计算的字节数与数据库 `octet_length(jsonb::text)` 一致；
  - **最坏卡片**：构造 `message` 和 `recommendationReason` 各 20000 码元（分别全用引号、反斜杠、中文、换行和代理对构造），`question` 500、5 个 200 码元的选项，再加最坏 summary：
    - 保存的结果不超过 262144；
    - 按"先 message、后 recommendationReason"的顺序截短；
    - 截短后信封的 `message` 等于 `card.message`；
    - 截短后通过 `questionToolCardSchema` 和 `agentTurnBody` 的校验；
    - `question`、`options` 和 summary 不变；
    - 记 `length_limit`；
    - Session item 不超过 262144；
  - **卡片带伴随文本**：卡片加上一段 O=32768 写满的伴随文本：
    - 伴随文本被截短到 4000 码元；
    - 构造成截短后仍然超出时，伴随文本 item 被整条丢弃；
    - 每个 Session item 都不超过 262144，Session 写入成功；
    - 回执保留原文；
    - 页面显示的仍是卡片 `message`；
  - 夹具覆盖 4 字节 emoji、引号、反斜杠、控制字符（每字符 6 字节转义）和全中文；
  - 恰好等于上限通过，加 1 字节被截短；
  - Session item 和 `checkpoint_primary` 用同一套测试；
  - 完整请求容量：续写段超过 `continuationInputBytes` 时在 claim 前收尾，不跳过检查。
- **时长**：
  - 剩余时间小于 `SEGMENT_DISPATCH_MS` 时落点 `waiting_resume`；
  - 模拟 300 秒 Hobby 时，4 段跨多次 HTTP 能写完；
  - 一段超时时，这一段丢失、前面的段保留，执行进入 `cost_pending`，不重发；
  - 记录每段用时（只写日志）。
- **停止（4.6）**：
  - (b) 停在 `waiting_*`：一个事务内保存截到 `stopAt` 的结果并收尾，状态为 `completed`；
  - 停止时的可见正文校验，各补一条：
    - 导师回合不带卡：截到 `stopAt` 的 `message` 重新封装后通过 schema，`complete` 按 `message` 计数通过，超过 `stopAt` 的被拒绝；
    - 带附属整理器的执行被停止：
      - 停在 `waiting_resume`、整理器还没派发：保存 `stopped:true`、`organized:false`、没有 summary，`complete` 成功（不报 `RUNTIME_ORGANIZER_PENDING`），未派发的 call 被取消并释放冻结；
      - 已有 `primary_result`：body 等于 primary 的 body；body 不一致仍然报 `RUNTIME_CHECKPOINT_CONFLICT`；
      - 整理器在途：回执落库后正常带 summary 完成，结果为 `stopped:true`、`completeness:'complete'`、`organized:true`，`complete` 接受；整理器只结算一次；
      - 主回复段在途时停止：这一段落库后不 checkpoint primary、不派发整理器，按 `organized:false` 保存；
      - R3 拒绝"没有 summary 却标 `organized:true`"和"有 summary 却标 `organized:false`"；R1 拒绝 `user_stop` 下没有 `stopped:true` 的结果；
      - 没有停止的执行如果缺 summary，仍然报 `RUNTIME_ORGANIZER_PENDING`；
      - 右侧信息不更新，B1 不执行；
    - 导师回合带卡：没有截断时保留卡片；截断时 `card=null`；`message` 为空且无卡时按 (e) 处理；
    - T2 `step` 回复（带整理器和不带整理器各一条）：截断信封的 `message`，私有字段不变，重建后通过正常完成的校验函数，`complete` 按 `message` 计数；模型输出本身不合格时按 (e) 处理，不保存坏 JSON；
    - 非信封的纯文本：`body` 截到 `stopAt` 个码点，`complete` 按 `body` 计数；
    - plan（T3）：仍然整段缓冲，写的过程中不显示任何文字，停止走原 `runtime_cancel`；
    - 中文、emoji（代理对）和换行下，前端的 `Array.from` 与数据库的 `char_length` 计数一致；
  - (c) 在途时停止：返回 `stopping`；在途段回执落库后，`complete` 成功保存带 `stopped:true` 的结果；`complete` 拒绝超过 `stopAt` 的 body；
  - (d) 在途 HTTP 消失：恢复时读回执收尾；回执不明时进入 `cost_pending`；
  - (e) 没写出字：结果为空，状态为 `cancelled`；
  - 停止和继续同时到达：只有一个成功；
  - 停止后 claim 被拒；
  - 未派发的 call 被取消并释放冻结；
  - 在途段只结算一次；
  - run 只收尾一次；
  - 旧 execution 的 `runtime_cancel` 行为不变。
- **前端接续**：
  - `waiting_resume` 时自动继续，每个 epoch 最多一次；
  - calls 闸门拒绝、429、503、`waiting_credits`、`cost_pending`、撤权、资料冲突时，不自动循环（保留 #594 的拒绝边界）；
  - 刷新后已写段立即可见；
  - 两个标签页只有一个领到下一段。
- **余额、注销、未知费用**：
  - 段间 A < L 时进入 `waiting_credits`，充值后点继续接着写，充值本身不触发生成；
  - 注销按 #611（0160）和 PAYG 收尾；
  - 未知费用不开新段，名义费用和实际费用的未知都不能当 0。
- **计费**：
  - 每段一次 v2 调用，各自独立计算 B/T/U/G/H，并各自检查 L；
  - run 内累计只进位一次；
  - `C + E = N` 守恒。
- **缓存**：
  - 有资格命中时，回执能证实命中；
  - 冷缓存、过期、没有历史断点时仍然正确；
  - 断点不后移；
  - adapter 只接受带可信冻结合同的那一种尾部形状。
- **B1**：capture 只在最终完成、`completeness:'complete'`（带附属整理器时还要 `organized:true`）时执行一次；`completeness` 为 `length_limit`/`stopped` 或 `organized:false` 时不执行；`stopped:true` 但 `complete` 且已整理时照常执行；重放不会产生第二份。
