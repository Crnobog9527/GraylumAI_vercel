# RATE-LIMIT 接线与 MODERATION-HOOK 实施方案

风险 **high**（限流、暂停开关、Runtime 准入和模型调用路径）。本文只是方案，没有改产品代码、
配置或数据库，也没有连接远程 Redis 或数据库。

- 依据代码：#497 冻结 head `f9afd0db7805e80ccc6f5b7023a3e87b5014f5bd`（admission、execute、
  executionStream、runner、opc service、BILL2 service 及相关 SQL），以及 staging `2be631aa`
  上已合并的 #562 准备切片和 SEC-RATELIMIT（#488）。**文中行号都指 `f9afd0db`**；
  #497 会因 `reasoning_details` 缺陷同步 staging 后重新冻结，实施时以新的冻结 head 和当时的
  staging 重新核对。
- 规划依据：[MASTER_PLAN](MASTER_PLAN.md) 第 2.1 节第 19、30 项，第 7.1 节 RATE-LIMIT、
  MODERATION、SEC-RATELIMIT 行；[#562 总控接线决定](https://github.com/Crnobog9527/GraylumAI_vercel/pull/562#issuecomment-5926589161)；
  [内容审核接口要求](https://github.com/Crnobog9527/GraylumAI_vercel/pull/566#issuecomment-5930126786)；
  [总控对本方案第一版的审阅](https://github.com/Crnobog9527/GraylumAI_vercel/pull/573#issuecomment-5938673485)；
  [Owner 对计数口径和内测环境的答复](https://github.com/Crnobog9527/GraylumAI_vercel/pull/573#issuecomment-5938730128)。
- 实施前提：#497、#550（含宿主切片）、PROMPT-CACHE 都已进入 staging（顺序见第 7 节）。

## 0. 结论摘要

| 问题 | 结论 |
| --- | --- |
| 挂在哪一层 | 不在 tRPC 路由层。**消息闸门**放在 `runtimeAdmissionService.prepare` 里重放判定之后；**调用闸门**放在执行器 `exchange` 里，只在一轮的**第一次**新调用、`billing.claimCall` 之前检查一次。所有入口自动覆盖，不改 `opc/service.ts`、`bill2/service.ts` |
| 计数单位 | 都按已验证的用户 ID，跨会话、设备、入口共用。消息：用户每发一条消息（一轮）记 1 次，重放不记（Owner 2026-10-02 定）。调用：在一轮第一次调用前，按这一轮冻结的 `maxCalls` 一次性预扣。导师回复 + 整理那一轮：消息 1 次、调用预扣 2 次 |
| 超限时用户看到什么 | 4 句固定中文提示（分钟超限、近 24 小时超限、已暂停、额度服务不可用），都写明"本次被拦截的调用不扣积分" |
| 会不会扣费 | 被拦都发生在这一轮任何付费调用之前：消息被拦时没有执行和预留；调用被拦时这一轮走现有 `fail_before_dispatch`，预留全部释放，净扣 0。**一轮开始后不会再被中途拦下**，已付费、已显示的回复不会被作废 |
| 和计费冲突吗 | 不冲突。闸门在 BILL2 claim 之前；BILL-PAYG 的"两步之间暂停"只发生在一轮内部，和闸门不重叠 |
| Redis 不可用 | 一律拒绝（fail-closed），包括超时，和 #488 一致；没有放行开关 |
| 一键暂停 | 复用 `runtime_rate_limits.stopNewCalls`（已合并），管理员在 `/admin/settings` 操作；只拦新消息和新一轮的第一次调用，已经开始的一轮跑完；查看、取消、财务恢复不受影响 |
| MODERATION-HOOK | 输入检查点在准入里、`runtime_admit` 之前；输出检查点在执行器里、附属整理之后、保存结果之前。默认直接放行，返回值类型留出"拦截"；本轮拦截分支只保证不发生、不被改写成 `pending` |
| 新建什么 | 不新建表、RPC、配置键、队列或外部调用。新增两个小模块（闸门组合、审核接口），其余是在现有文件里接线 |
| 正式环境 | 封闭内测在正式环境进行（Owner 2026-10-02 定）。正式环境的 Upstash Redis 和其他配置就绪，限流才算满足内测条件；正式环境的前缀由 RUNTIME-PROD 负责 |

## 1. 现在已有什么

**#562 已合并（准备切片，未接线）**

- 私有设置 `runtime_rate_limits`（`services/runtime/rateLimitSettings.ts`）：
  10/分钟、200/24 小时的准入；30/分钟、600/24 小时的调用；`stopNewCalls=false`。
  管理员专用读写接口 `routers/runtimeRateLimits.ts`，通用设置入口禁写，不进公开白名单。
  **数据库里没有这一行时返回上述默认值；读取失败或内容不合法时抛 503**，不回退默认值；
  不跨请求缓存。
- 后台卡片 `/admin/settings` → AI使用额度：能保存额度，暂停按钮禁用，明确写着"尚未接线"。
  接口返回 `enforcement: {admission:false, calls:false, pause:false}`。
- `checkRuntimeRateLimit(identifier, bucket, config, environment)`（`services/redisRateLimiter.ts`）：
  先查分钟窗口、再查日窗口，分钟被拒不扣日额度；Redis 前缀按"环境:桶:窗口"隔离；
  500ms 截止、零重试、任何异常都返回 `unavailable`。目前没有任何运行时调用方。

**#488 已合并（SEC-RATELIMIT）**：所有限流 fail-closed。规划第 7.1 节里"Redis 超时放行"
指的是 #488 修掉的旧缺陷（SDK 等 5 秒后返回 `success: true`），不是要保留的规则。
现在超时、报错、未配置一律拒绝，503 + `retryAfter=60`；超限 429。

**已有的部署级开关**：`V3_RUNTIME_STAGING_ENABLED`。它不是 `true` 时，新准入在
`loadStagingPolicy` 被拒，执行入口走"只做财务恢复"的分支（`executionStream.ts`
里 `runtime_cancel` + `recoverFinancial`，发送被禁用）。它要改环境变量并重新部署，
`stopNewCalls` 是不用部署、管理员即时切换的那一个。两者并存，本方案不改前者。

**模型调用入口（`f9afd0db`）**

| 入口 | 准入 | 执行 | 冻结 `maxCalls` |
| --- | --- | --- | --- |
| `runtime.prepare`（含 `/runtime` 单独整理、写作和视频包） | `runtimeAdmissionService.prepare` | `runtime.execute` / `executeStream` | 3（`routers/runtime.ts:39`） |
| `opc.prepareStep` / `opc.mentorTurnStream` | `opcService.prepareStep` → 同一个 `prepare`（service.ts:246） | `executeOriginalExecution` | 导师带整理或开场 2，否则 1（service.ts:253） |
| `opc.topicTurn` | `prepareTopicTurn` → 同一个 `prepare`（service.ts:414） | `runtime.execute*` | 1（service.ts:421） |

`billing.dispatchOnce` 在仓库里只有一个调用方：`execute.ts:142` 的 `exchange`。

旧链路：`/api/ai/stream` 已由 #507 对新请求返回 410。工作台的付费入口见第 4 节末尾。

## 2. 限流挂在哪一层、怎么计数

### 2.1 为什么不在 tRPC 路由层

#562 已经核实并经总控确认：路由层拿不到 OPC 的规范请求和重放结果（在 `opc/service.ts`
里构造），也不知道一次 execute 是新执行还是只恢复收据（在 `execute.ts` 拿到 `begin`
结果后才知道）。在路由层拦，要么挡住财务恢复，要么复制一套规则。所以两个闸门都放在服务层。

### 2.2 消息闸门：`admission.ts` 的 `prepare`

位置：`admission.ts:91–92` 重放判定返回之后，紧接着就检查，排在 Skill 加载、模型读取和
`runtime_admit`（:233）之前。

```ts
const replay = await query('runtime_admission_replay', …);
if (replay) return replay;           // 重放：不计数、不检查暂停
await admitNewMessage(…);            // 新增：暂停 → 消息桶
```

- 放在最前面而不是紧贴 `runtime_admit`：被限流的用户不再消耗 Skill 加载和多次数据库读取。
  代价是配置错误（例如模型不可用）导致的失败也占一次，偏严，可以接受。
- 配置读取可以和重放查询同时发起，但**重放命中时直接返回，不等也不理会配置读取的结果**；
  配置读取失败只影响新请求。实现时先给配置读取的 Promise 接住错误，确认不是重放后再取用。
- 所有准入入口都经过这里，`opc/service.ts` 不用改。

**OPC 被拦后会不会卡住（本方案定：闸门就放在 `prepare` 里，不前移）**

OPC 的两条路径在调用 `prepare` 之前已经写了材料，读 SQL 后确认被拦不会卡住：

| 函数 | 第一次写入 | 同一个 requestId 再次提交 | 新的 requestId |
| --- | --- | --- | --- |
| `opc_step_material`（0107:281） | 新建一版会话材料（版本号 +1）和一条 `opc_turns` | 找到原材料和原 `opc_turns`，输入一致就原样返回原版本和 turnToken，不新建；输入不同报 `OPC_REQUEST_CONFLICT` | 再新建一版材料，版本号继续 +1 |
| `opc_topic_material`（0114:52） | 只插入一条 `opc_turns`，不改材料版本 | 输入一致就原样返回 | 新插一条 |

- 被拦后留下的只是"有材料、有 `opc_turns`、没有执行"。现行 `opc_query`（0111:71 起的定义，
  经 0116、0120、0133、0134 包装）列出轮次时用 `opc_turns` **inner join** `runtime_executions`，
  没有执行的轮次不显示；
  材料只有 `brief`（"用途:步骤"）和空材料，不含用户原话（原话只存哈希）。
- **同一个 requestId 重新提交**（页面"原请求与输入已保留"的情况）：材料函数原样返回，
  `prepare` 的 `expectedMaterialRevision` 等于当前版本，重放查询为空，重新过闸门，
  通过后正常准入。期间如果用户又发过别的请求让材料版本前进，会报 `RUNTIME_MATERIAL_CONFLICT`，
  这和现在任何延迟重试的行为一样。
- **新请求**：新建一版材料并正常准入，前一次被拦留下的记录不影响它。
- `prepareTopicTurn` 现在就是"先写材料、再判重放"，同样的状态已经存在。
- 实施时第 8 节的 OPC 集成测试覆盖这两种情况；若最新冻结 head 改了这两个函数或
  `opc_query` 的 join，重新核对。

### 2.3 调用闸门：只拦一轮的第一次新调用

按总控决定（第一版"每次调用都检查、中途被拦就取消"会把已付费、已显示的导师回复作废）：

- 位置：`execute.ts` 的 `exchange` 里，`:133` 判断"这是本执行的活跃所有者、这一步还没发过"
  之后，`billing.claimCall`（:139）之前。用执行器里的一个局部标志保证**每次执行只检查一次**：
  第一次要发新调用时检查，之后同一轮的调用不再检查。
- 活跃所有者只有一个：`begin` 只在 `prepared` 时把执行变成 `running`（0106:407），
  之后不会再有第二个活跃所有者，所以"第一次"是确定的。
- 检查内容：先读配置看暂停；再按这一轮冻结的 `execution.billing.limits.maxCalls`
  一次性预扣调用桶。同一轮后面的调用已经受冻结 `maxCalls` 约束，不需要再数。
- 只读和恢复路径都碰不到这个闸门：已保存回复的重放（`existing.rawBody`）、
  非活跃所有者（`live=false`）、`cost_pending` 恢复、`cancelRequested`、
  `recoverFinancial`（只查收据，不进 `exchange`）。
- **SDK 会包装 `exchange` 抛出的错误**，所以和现有 `transportNotStarted` 一样，
  用一个局部变量 `gateRejection` 记住原因，在外层 catch 里判断。

放在 `claimCall` 之前而不是 `dispatchOnce` 之前：`dispatchOnce` 只有 `exchange`
一个调用方，覆盖范围相同；claim 之前拒绝，BILL2 不会留下 prepared 调用，也不用撤销；
不改 `bill2/service.ts`。以后新增直接调用 `claimCall` 的代码必须先过闸门，在 `claimCall`
旁注释写明，作为审查检查项（总控已确认这个位置）。

**`rate` 参数的实际语义（核对锁定的 @upstash/ratelimit 2.0.8 源码）**

`limit(identifier, {rate: n})` 的滑动窗口脚本只在"已用 ≥ 上限"时提前拒绝且不计数；
否则**先把计数加 n，再看剩余是否 ≥ 0**。所以 `n > 1` 时，剩余不足的请求会被拒，
但计数已经加上了。用户被拒后反复重试，会一直把窗口顶满。处理：

- 给 `checkRuntimeRateLimit` 加可选参数 `rate`（默认 1，消息桶照旧）。
- `rate > 1` 时先对两个窗口各调一次只读的 `getRemaining`，两个都 ≥ n 才依次
  `limit({rate: n})`（分钟、日）。不够就直接拒绝，不加计数。
- 两次读取之间的并发仍可能让 `limit` 加了计数又被拒，这只会偏严，不会多放行。
  不做负数退回（脚本返回值分不清"提前拒绝"和"加完才拒"，盲目退回可能少计）。
- `n` 大于分钟或日上限时永远过不了：按配置错误拒绝（原因 `limit_unavailable`），
  记日志 `runtime_rate_limit_round_exceeds_limit`。后台卡片提示"模型调用每分钟"不能低于
  单轮最多调用数（现在是 3）。
- 一轮实际用的调用少于 `maxCalls` 时，多扣的部分不退回，偏严。
- 命令数：调用桶每轮约 2 次只读脚本 + 2 次 `limit`，比第一版"每次调用都查"少；
  #562 文档里的月用量估算按每轮重算，实施 PR 更新那张表。

### 2.4 被拦之后这一轮怎么结束

调用闸门只在第一次调用前拒绝，这时这一轮没有任何已发出的调用，**直接走现有 catch 里的
`fail_before_dispatch`**（`execute.ts:369`）：SQL 在没有已发出调用时取消 BILL2、
结算（全额退回）、执行改为 `cancelled`、释放会话的活跃执行（0106:411–416）。
只需要在返回 `cancelled` 时带上 `gateRejection` 原因，和现在的 `preflight`、`capacity`
原因一样。不需要 `runtime_cancel`，也没有"中途被拦"这一类状态。

`fail_before_dispatch` 的响应丢失时，现有代码会把执行标成 `interrupt` 并返回 `pending`，
由之后的恢复检查。这是现有的数据库故障处理，不是把"被拦"改写成 `pending`：
这一轮确实没有调用、没有费用，恢复时会取消。

结果原因写在返回值里，不写数据库。`runtime_executions.unavailable_reason` 只能由 SQL
函数写入，而且它的含义是"这一轮的内容和历史不可再用"（0106 的
`runtime_history_available`、0136 注释）；另加原因要改 SQL，超出最小改动。
刷新页面后这一轮显示通用的"已停止"提示，这是已知限制（第 10 节）。

### 2.5 计数口径

| 场景 | 消息次数 | 调用预扣 |
| --- | --- | --- |
| 导师一轮，不带整理 | 1 | 1 |
| 导师一轮 + 附属整理（`organizeAfter`，含回答卡片后的整理） | 1 | 2 |
| 开场轮（宿主开场 + 开场提取，`organizeOpening`） | 1 | 2 |
| OPC 步骤生成（`prepareStep` 用途 `step`），不带整理 | 1 | 1 |
| OPC 步骤生成（用途 `step`）带 `organizeAfter` | 1 | 2 |
| OPC 周计划（用途 `plan`，不允许带整理） | 1 | 1 |
| 选题一轮（`opc.topicTurn`） | 1 | 1 |
| `/runtime` 自由对话、Skill、写作、视频包 | 1 | 3 |
| `/runtime` 单独整理（`selection.kind = organizer`） | 1 | 3 |
| 同一请求重放、丢失响应后重新读取 | 0 | 0 |
| 并发两个相同请求（同一 requestId）同时到达 | 可能 2 | 只有一份执行，最多预扣一次 |
| 已保存回复的重放、收据恢复、取消、查看 | 0 | 0 |
| 新建会话 `runtime.start`、保存材料 | 0 | 0 |

- **"新对话"按"每发一条消息算一次"**（Owner 2026-10-02 选定）。后台卡片和本文都写成
  "新消息"或"每轮消息"，不单写"新对话"。开场轮是宿主替用户发起的一轮，也按一次算。
- 标识：已验证的用户 ID（准入用 `actor()`，执行用 `options.actor()`），不按会话或 IP。
  管理员同样受限，没有绕过。
- 按现在的 `maxCalls`，`/runtime` 每轮预扣 3：30 次/分钟、600 次/天正好对应
  10 轮/分钟、200 轮/天，和消息桶一致；导师和选题每轮预扣 1–2，正常使用时消息桶先起作用。
  调用桶主要防以后调大 `maxCalls` 的多步 Skill 和报告。
- **环境前缀的取法**：闸门模块自己不读环境变量，由已经做过本机/staging 判断的宿主传入，
  避免 `newWorkGate → executionStream` 的循环引用（`runtimeLocalEndpoint` 在
  `executionStream.ts` 里）：
  - 消息闸门：`runtimeAdmissionService` 里 `policy.real` 存在 → `staging`，否则 → `local`。
    `real` 只由 `loadStagingPolicy` 产生，它已经用 `stagingRuntimeWindow` 校验过 staging
    项目、`staging` 分支和 staging 数据库；本机回环由路由里的 `runtimeLocalEndpoint()` /
    回环地址判断后才不带 `real`。
  - 调用闸门：`executeOriginalExecution` 里 `maintenanceEndpoint` 存在 → `local`，
    staging 分支 → `staging`；`routers/runtime.ts` 同理按 `endpoint` / `real`。
  - 正式环境现在没有 Runtime 宿主；`production` 前缀和正式环境的判断由 RUNTIME-PROD
    接正式环境时加上，本任务不提前写。

### 2.6 超限时用户看到什么

沿用 #562 方案里总控已通过的 4 句固定提示，不拼动态数字和内部错误：

| 情况 | 发消息时被拦 | 第一次调用前被拦（结果原因） | 提示 |
| --- | --- | --- | --- |
| 分钟超限 | 429，`retryAfter`=窗口剩余秒数 | `call_limited` | 操作过于频繁，请稍后再试。本次被拦截的调用不扣积分。 |
| 24 小时超限 | 429，同上 | `call_limited` | 近24小时使用次数已达上限，请稍后再试。本次被拦截的调用不扣积分。 |
| 已暂停 | 503，`retryAfter`=60 | `paused` | AI服务暂时暂停新调用，请稍后再试。本次被拦截的调用不扣积分。 |
| Redis 或配置不可用 | 503，`retryAfter`=60 | `limit_unavailable` | 暂时无法确认使用额度，请稍后再试。本次被拦截的调用不扣积分。 |

- 发消息时被拦：复用 `RateLimitError`（tRPC 错误格式里已经带 `retryAfter`；
  `stagingProcedureError` 对非 500 的 TRPCError 原样放行）。只给它加按原因选择提示文字的参数，
  旧链路默认文字不变。
- 第一次调用前被拦：调用桶的分钟和日拒绝合成一个 `call_limited`（结果对象里不带窗口），
  提示用分钟那句；`AgentTurnUnavailable`（`shared/agentTurn.ts`）加三个值。
- 前端实际显示提示的地方（第一版漏列，已补）：
  - `positioning/[draftId]/admission-message.ts`：现在只认 `PRECONDITION_FAILED`、
    `FORBIDDEN`、`SERVICE_UNAVAILABLE`，429 会显示成"结果未知"，要加 `TOO_MANY_REQUESTS`；
  - `positioning/[draftId]/mentor-turn.ts:187` 的 `turnResultNotice`（page.tsx:182 调用）
    和 `mentor-turn.test.ts`：加三个原因的固定提示。`agent-turn-display.ts` 读的是数据库
    里的原因，本方案不写库，所以不改它；
  - `positioning/[draftId]/topics/page.tsx`（`opc.topicTurn` 唯一的前端调用方，:151、:326–358）：
    - 消息被拦（429/503）现在落到 `failureMessage`（:267–277）兜底，显示"本次请求状态待核实……
      不要重复发送相同内容"，要按原因显示固定提示；
    - 现在不读 `execute.mutateAsync` 的结果（:330），调用被拦时页面没有任何提示，
      要读取结果原因并显示固定提示。
  - `runtime/page.tsx`：
    - `send()` 里 `prepare` 被拒落到 :135 的 catch，显示"请求状态待核实。请读取原任务状态，
      不要重新发送相同内容。"，要按 429/503 原因显示固定提示；
    - :68（`execute` 成功回调，现在只认 `output_truncated`）加三个结果原因；
    - 写作/视频包流程：:183 一带把执行结果原因转成 `OPC_CONTENT_*` 错误，要加三个原因；
      :188 的 catch（准入被拒会落到"视频工作请求状态待核实"）要识别 429/503。
  - 以上每处补对应单测或组件测试。
  - 不自动重试。被拦的请求保留在页面的"原请求"恢复记录里，稍后用同一个 requestId
    重新发送是安全的（第 2.2 节）。
- "近24小时"是滑动窗口的近似说法，不承诺任意连续 24 小时都严格不超过 200 次。

### 2.7 和计费（BILL2 / BILL-PAYG）的关系

- 消息被拒发生在 `runtime_admit` 之前：没有执行、没有预留，余额和账本不动。
- 调用被拒发生在这一轮第一次 `claimCall` 之前：没有 BILL2 调用记录，
  `fail_before_dispatch` 全额退回，净扣 0。
- 一轮开始之后，限流、暂停、Redis 故障都不再打断它，不会出现"付了费的回复被作废"。
- BILL-PAYG（#553）以后在 claim 时按次冻结、余额低于 L 时在两步之间暂停。
  执行顺序是：调用闸门（一轮一次）→ PAYG 冻结（每次调用）→ 发送。
  限流拒绝不冻结；PAYG 的"余额不足暂停"在闸门之后，不消耗限流次数。两者原因不同，提示分开。
- 不做全站美元硬上限，那是 GLOBAL-DAILY-COST，和本任务分开。

## 3. Redis 不可用时

**一律拒绝，和 #488 一致。** 具体是：

- Redis 未配置、报错、500ms 内没返回、SDK 返回 timeout 标记 → 拒绝，原因 `limit_unavailable`。
- `runtime_rate_limits` 读取失败或内容不合法 → 同样拒绝（没有这一行时用默认值，不算失败）。
  现有 `readRuntimeRateLimits` 会抛 503；在调用闸门里要把它转换成 `gateRejection`。
- 因为调用闸门只在第一次调用前检查，Redis 故障不会打断已经开始的一轮。
- 没有内存兜底，没有"故障时放行"的开关。故障期间所有新消息都会被拒，
  恢复办法是修好 Redis，或者经 Owner 批准回退部署（第 10 节）。
- 已有日志事件不变：`runtime_rate_limit_backend_unavailable_denying_request`、
  `runtime_rate_limit_config_unavailable`。新增两个事件：暂停拒绝 `runtime_new_calls_paused`
  （info）、单轮调用数超过上限 `runtime_rate_limit_round_exceeds_limit`（error），
  只记入口类型，不记用户 ID 和正文。

**环境和前提**：

- staging：`UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` 已由 Owner 确认存在
  （#488 Handoff），Free 套餐。
- **正式环境：封闭内测在正式环境进行（Owner 2026-10-02 选定）。** 正式环境的 Upstash Redis
  （完整的 `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` 一对、足够的命令额度）
  和 Vercel Pro 等其他正式环境配置一样，是内测前提。因为 fail-closed，正式环境在配好
  Redis 之前，任何新消息都会被拒。**限流接线要在正式环境配置就绪、RUNTIME-PROD 接好
  正式环境前缀之后，才算满足内测条件**。由总控记入上线前待办，本任务不改任何远程配置。

## 4. 一键暂停开关

- **存在哪里**：已合并的 `system_settings` 私有键 `runtime_rate_limits` 的 `stopNewCalls`。
  不新建表、不加新键。
- **谁能操作**：只有管理员（现有 `adminProcedure` 专用接口）。普通用户和匿名用户读写都被拒，
  已有单元测试；验证里再补一条交互拒绝路径（第 9 节）。后台卡片的暂停按钮在接线后启用，
  保存后读回显示真实状态；`enforcement` 三个标志改为 `true`。
- **多快生效**：设置不缓存，下一条新消息或下一轮的第一次调用检查时就生效。
- **生效范围**：
  - 停：新消息（所有入口）；已经准入、但还没开始调用的一轮（第一次调用前被拦，净扣 0）。
  - 不打断：已经开始调用的一轮，跑完它冻结的全部调用（最多 `maxCalls` 次，每次最长
    `OPENROUTER_RESPONSE_TIMEOUT_MS` = 240 秒），回复正常保存和结算。
  - 不受影响：查看、取消、已保存回复的重放、收据和财务恢复、注销后的财务收尾。
- **检查顺序**：先读配置看暂停，暂停时直接拒绝、不访问 Redis（不消耗命令），再查限流桶。
- **合并前要核对一件事**：#562 起后台接口就能保存 `stopNewCalls`（只是没生效）。
  合并 staging 会立即自动部署，所以合并前要先在 staging 后台确认它是 `false`，否则一部署所有新消息就会停。
  写进验证的合并前检查 M0。
- 和规划里 RUNTIME-PROD ⑤"一键停止新调用的开关"是同一个开关，正式环境沿用，不另做。
- **旧链路**（总控已答复）：`/api/ai/stream` 已由 #507 对新请求返回 410，暂停开关只管新
  Runtime 的限流桶，旧代码由 LEGACY-CLOSE 删除。仍可能发起真实付费调用的旧路径
  （`f9afd0db` 上核对过直接调用 OpenRouter）：
  - `routers/agentSlice.ts`（`/chat` 页面的 `agent-slice-*` 组件调用，`services/agentSlice/runner.ts`
    直连 OpenRouter），仍在 `root.ts` 注册；
  - `routers/workbench.ts` 的 `generate`（`services/artifacts/generation.ts`，SEC-RATELIMIT 已有限流）。

  **处理办法**：实施 PR 开始前核对这两条路径在新 staging 上是否仍能被普通用户触发
  （入口页面可达、接口未被关闭）。
  - 仍可触发的：在它们各自的准入处（发起付费调用、建预留之前）加一行暂停检查，
    复用同一个读配置函数，暂停时返回同一句"AI服务暂时暂停新调用"；不给它们加新的限流桶
    （已有 SEC-RATELIMIT）。查看、恢复、取消照常。
  - 已不可触发的：在实施 PR 描述里写明"一键暂停不覆盖此路径，因为它已不对用户开放"，
    由总控在请求合并批准时报 Owner。
  - 管理员后台的模型试调（`models/tryReasoning.ts`）只有管理员能用，不接暂停开关，同样写明。

## 5. MODERATION-HOOK

### 5.1 接口

新文件 `packages/api/src/services/runtime/moderation.ts`：

```ts
export type ModerationVerdict =
  | { action: 'allow' }
  | { action: 'block'; category: string };   // 预留，本轮没有实现会返回它

export type ModerationInput = {
  actorId: string; sessionId: string; requestId: string;
  text: string;          // 解析后的用户输入（含卡片选项解析结果）
  opening: boolean;      // 宿主写的开场标记，不是用户原话
};
export type ModerationOutput = {
  actorId: string; executionId: string;
  body: string; summary?: string;   // 主回复和附属整理
};
export interface RuntimeModeration {
  checkInput(input: ModerationInput): Promise<ModerationVerdict>;
  checkOutput(output: ModerationOutput): Promise<ModerationVerdict>;
}
export const allowAllModeration: RuntimeModeration = {
  checkInput: async () => ({ action: 'allow' }),
  checkOutput: async () => ({ action: 'allow' }),
};
```

不读配置、不访问网络、不写日志、不建表。

### 5.2 两个检查点

| 检查点 | 位置 | 理由 |
| --- | --- | --- |
| 输入 | `admission.ts` 的 `prepare`，消息闸门之后、`assertFrozenPayloads`（:232）之前 | 这时已经拿到最终输入，还没有执行和预留；以后拦截时什么都不用撤销。放在闸门之后，以后接外部审核服务时，被限流的请求不会消耗审核调用 |
| 输出 | `execute.ts`，主回复和附属整理都完成之后、`runtime_execution complete`（:335）之前 | 这是"完整回复"第一次全部可得、还没保存成结果的位置；重放和恢复路径在前面已经返回，不会重复检查 |

`runner.ts` 不改：它只负责 SDK 一次运行，看不到准入和保存的边界。

**已知限制（写进代码注释）**：

- 输出检查点在附属整理**之后**：以后正式实现时如果主回复就要拦，整理调用的费用已经花了；
  是否把检查拆成"主回复后、整理前"一次加"整理后"一次，由正式实现决定。
- 导师回复是流式的，输出检查时用户已经看到了文字。正式实现要决定是否先缓冲或撤回。

### 5.3 本轮遇到"拦截"怎么办

默认实现永远放行，生产代码只接 `allowAllModeration`，所以拦截分支本轮不会出现。
为了不留隐患，代码里仍要写清楚：

- 输入返回 `block` → 抛出专用错误 `RUNTIME_MODERATION_BLOCKED`，在 `runtime_admit`
  之前，什么都没创建。
- 输出返回 `block` → 用现有 `runtime_cancel` 结束（和 `terminalReplyFailure` 同一条路径），
  **绝不落进通用 catch 变成 `pending`**。
- **检查函数本身抛异常**：按现在的 catch 顺序，输出检查点抛出的异常会走
  `interrupt` → `pending`。所以两个检查点都用 try/catch 包住调用，**异常一律按 `block`
  处理**：输入点抛 `RUNTIME_MODERATION_BLOCKED`；输出点走上面同一条 `runtime_cancel`
  路径。接口注释写明"实现不应抛异常；抛出等同拦截"。默认实现不会抛异常，
  补一条"检查函数抛异常 → 结果不是 `pending`"的测试。
- 不做的事：拦截后不收费、独立终止状态、拦截日志、界面提示、流式文字的撤回。
  这些等 Owner 决定正式实现时再做，届时"被拦截"要有自己的终止状态。

### 5.4 怎么证明行为不变

- 单元测试：`allowAllModeration` 对任何输入都返回放行，过程中没有网络请求（fetch 替身调用 0 次）。
- 准入：默认实现下 `runtime_admit` 收到的冻结上下文和计费参数与改动前逐字节相同
  （现有准入测试断言这些参数，保持通过）。
- 执行：现有 Runtime、流式、OPC 集成测试全部原样通过，其中已经断言发给供应商的请求字节、
  结果正文和状态。
- 次数：新准入时输入检查恰好 1 次；重放 0 次；新完成的执行输出检查恰好 1 次；
  `cost_pending` 恢复、已完成重放、取消 0 次。
- 拦截替身（只在测试里）：输入拦截 → 没有 `runtime_admit`、没有预留；
  输出拦截 → 结果是 `cancelled` 或 `cost_pending`，不是 `completed`，也不是 `pending`；
  两个检查函数抛异常时结果分别与拦截相同。

## 6. 实施范围和最小改动说明（AGENTS 第 5 节）

### 6.1 预计改动的文件

| 文件 | 改什么 |
| --- | --- |
| 新增 `services/runtime/newWorkGate.ts` | 组合"读配置 → 暂停 → 限流桶"，环境由宿主传入，返回 `{ok}` 或拒绝原因；消息和调用共用。不引用 `executionStream.ts` |
| 新增 `services/runtime/moderation.ts` | 第 5.1 节接口和默认放行实现 |
| `services/redisRateLimiter.ts` | `checkRuntimeRateLimit` 加 `rate` 参数和 `rate > 1` 时的只读预查 |
| `services/runtime/admission.ts` | 重放之后接消息闸门；`runtime_admit` 前接输入检查点 |
| `services/runtime/execute.ts` | `runtimeExecutor` 选项加**必填**的 `callGate`；第一次 `claimCall` 前调用它；`fail_before_dispatch` 返回时带原因；`complete` 前接输出检查点 |
| `services/runtime/executionStream.ts` | 三处构造执行器都传 `callGate`：本机维护（:47）→ 本机闸门；只做财务恢复（:60）→ **一律拒绝的闸门**（这条路径本来就不发送，多一道保险）；staging（:68）→ staging 闸门 |
| `routers/runtime.ts` | :40 构造执行器时传 `callGate`（`endpoint` → 本机，`real` → staging） |
| `lib/rateLimitError.ts` | 按原因选择提示文字，旧链路默认不变 |
| `routers/runtimeRateLimits.ts` | `enforcement` 改为三个 `true` |
| `shared/agentTurn.ts` | `AgentTurnUnavailable` 加 `call_limited`、`paused`、`limit_unavailable` |
| `components/admin/RuntimeRateLimitSettings.tsx` | 启用暂停按钮；"新对话"改为"新消息（每轮消息）"；"模型调用"注明"每轮开始时按这一轮最多可用的调用数一次性预扣（导师 1–2 次，`/runtime` 3 次），实际用得少也不退回"；提示"模型调用每分钟"不能低于单轮最多调用数 |
| `positioning/[draftId]/admission-message.ts`、`mentor-turn.ts`、`topics/page.tsx` 及测试，`runtime/page.tsx` | 显示固定提示，识别 429/503 和三个结果原因（第 2.6 节） |
| 旧链路付费入口（视实施前核对结果，见第 4 节） | 仍对用户开放的，在它们的准入处加一行暂停检查 |
| 测试文件 | 见第 8 节 |

不改：`opc/service.ts`、`bill2/service.ts`、`runner.ts`、OPC 路由的组合代码、
`agent-turn-display.ts`、SQL 和迁移、依赖。`execute.ts` 和 `admission.ts` 的行数要守住
代码大小基线（`execute.ts` 有超长行基线 22 条，不能增加），必要时把闸门判断放进新模块。

**两个闸门怎么拿到读配置的客户端（生产代码不留"可选放行"参数）**：

- **消息闸门**：`runtimeAdmissionService(user, admin, policy)` 的 `admin` 本来就是
  `SupabaseClient`，闸门在服务内部用它构造，所有准入调用方（含 `opc/service.ts`）不用改。
  测试按仓库已有做法 `vi.mock('../redisRateLimiter')` 或替换闸门模块（`accountErasure`、
  `invitationAbuse` 集成测试已经这样做）。
- **调用闸门**：`runtimeExecutor` 的 `database` 类型是 `SessionRpc`（只有 `rpc`），
  读不了 `system_settings`。**采用"加一个必填依赖"**，不放宽 `database` 的类型：
  `runtimeExecutor({..., callGate})`，`callGate(actorId, rounds)` 由宿主用 admin 客户端
  和它已知的环境构造（上表 `executionStream.ts`、`routers/runtime.ts` 三处加一处）。
  不放宽类型的原因：执行器里大量测试替身只实现 `rpc`，放宽后要么全部补 `from`，要么在
  缺少 `from` 时默认放行，后者正是要避免的。
- **防止漏接**：`callGate` 在类型上必填，漏传编译失败；`runtimeExecutor` 构造时再检查一次
  `typeof callGate === 'function'`，不是就直接抛错（防 `any` 绕过）。补测试：
  `executeOriginalExecution` 的三个分支和 `routers/runtime.ts` 构造执行器时都带了闸门，
  而且财务恢复分支带的是一律拒绝的闸门。
- **测试构造点**：Runtime、流式、OPC 集成测试里的执行器构造统一传一个测试专用的放行闸门，
  放在测试辅助文件里；加一条静态检查测试，确认非测试源码不引用它。
- 配置读取失败或内容不合法按"不可用"拒绝；数据库里没有这一行时用默认值。

### 6.2 为什么这是最小的正确做法

- **考虑过的现有机制**：`runtime_rate_limits` 设置和专用接口、`checkRuntimeRateLimit`、
  `RateLimitError` 和 tRPC 错误格式、`fail_before_dispatch` 收尾、`AgentTurnUnavailable`
  结果原因、`stagingRuntimeWindow` 环境判断、部署级开关 `V3_RUNTIME_STAGING_ENABLED`。
  前六个全部复用；部署级开关需要重新部署，满足不了"一键"，所以保留它、另外接 `stopNewCalls`。
- **最小缺口**：把已有的配置和限流函数接到准入和每轮第一次调用两个点上，给限流函数加
  一个 `rate` 参数，加上被拦后的提示。
- **不新增**：表、RPC、配置键、队列、定时任务、外部服务、通用策略框架。
  两个新模块都是本地辅助函数，不是新的权威来源。
- **权威来源不变**：额度和暂停以 `system_settings.runtime_rate_limits` 为准；
  计数以 Redis 为准，只决定放不放行，不做财务记录；费用仍以 BILL2 为准。

## 7. 和在途 PR 的交互

| PR | 关系 | 处理 |
| --- | --- | --- |
| #497（Codex 冻结 `f9afd0db`，将重新冻结） | 改 `admission.ts`、`execute.ts`、`opc/service.ts`、`shared/agentTurn.ts`、定位页 | 本方案插入点基于它。等它合并，不往里加东西；按新的冻结 head 重新核对 |
| #550（`8da3947a`，SQL 切片在途；宿主切片要等 #497） | 宿主切片会改 `execute.ts`、`executionStream.ts`、`bill2/service.ts`（注销后受限收尾） | 等它的宿主切片合并后再实施。核对调用闸门仍在第一次 `claimCall` 前，注销后的财务收尾路径不经过闸门 |
| PROMPT-CACHE #572（方案） | 它的第 6 节也要改 `admission.ts`（冻结上下文字段）、`execute.ts`（context schema）和 `opc/service.ts` | **总控定序：PROMPT-CACHE 先实施，RATE-LIMIT 接线后实施**（缓存关系到 BILL-PAYG 的上界，在关键路径上）。两者由同一个 Runtime 写入方先后完成，RATE-LIMIT 在 PROMPT-CACHE 合入后的新 staging 上重新核对插入点 |
| BILL-UNIT #565 / BILL-PAYG #553（方案） | PAYG 会改 claim 时的冻结，和调用闸门相邻（都在 `execute.ts` 的 `exchange` 一带） | 同样由同一个 Runtime 写入方先后完成，先后由总控排；后做的一方在新 staging 上重新核对。无论先后，调用闸门都在每轮第一次 claim 之前、PAYG 冻结之前 |
| #561（STG-MENTOR-MODEL 实测） | 在 #497 冻结 head 上跑，不受本方案影响；但接线部署后，同一测试账号每分钟最多 10 轮 | 如果实测排在接线之后，由管理员临时调高额度（上限 60/5000/180/15000），测完恢复，不加绕过 |
| #547 REPORT-GEN | 报告生成单轮会有多次调用 | 每轮按冻结 `maxCalls` 预扣；如果单轮 `maxCalls` 超过 30，需要在它的方案里说明需要的额度，否则会被判为配置错误 |

迁移编号：本方案没有迁移，不占编号。

## 8. 测试计划

### 8.1 单元测试（不需要 Docker）

- 限流函数：`rate` 默认 1 时行为与现在一致（已有测试保持通过）；`rate = n` 时两个窗口
  都够才扣、任一不够就拒绝且不调用 `limit`；`n` 大于上限 → 配置错误拒绝；
  `getRemaining` 失败或超时 → `unavailable`。
- 闸门模块：暂停时拒绝且 Redis 调用 0 次；配置读取失败、内容不合法 → `limit_unavailable`；
  没有这一行 → 用默认值；分钟、日拒绝的原因和 `retryAfter`；环境前缀按宿主传入的
  local / staging 隔离，准入（`policy.real`）和执行（`maintenanceEndpoint`）两侧取到的前缀一致；
  同一用户跨入口共用一个桶，不同用户互不影响；闸门模块不引用 `executionStream.ts`。
- 执行器构造：缺少 `callGate` 时构造即抛错；`executeOriginalExecution` 三个分支、
  `routers/runtime.ts` 都带闸门，财务恢复分支的闸门一律拒绝；非测试源码不引用测试放行闸门。
- 准入：重放请求不调用闸门、不检查暂停；**配置读取失败时重放仍正常返回**；新请求恰好调用
  1 次且在 `runtime_admit` 之前；被拒时没有 `runtime_admit`；四个入口（`runtime.prepare`、
  `opc.prepareStep`、`opc.topicTurn`、`opc.mentorTurnStream`）都被同一个闸门拦住。
- 执行：调用闸门每次执行只调用一次，用冻结的 `maxCalls` 作为 `rate`；第二次及以后的调用
  不调用闸门；重放、`cost_pending` 恢复、取消、`recoverFinancial` 都不调用；被拒时不调用
  `claimCall`，返回 `cancelled` 加对应原因；SDK 包装后的错误仍被识别。
- 错误和提示：429/503、`retryAfter`、4 句固定文字；旧链路 `RateLimitError` 默认文字不变；
  `admission-message.ts` 把 429 显示为固定提示而不是"结果未知"；`turnResultNotice` 和
  `/runtime` 页面三个新原因各有提示；选题页 `failureMessage` 对 429/503 显示固定提示、
  `execute` 结果原因有提示；`/runtime` 的 `send()` 和视频包流程准入被拒时显示固定提示，
  不再显示"请求状态待核实"。
- 审核接口：第 5.4 节全部。
- 后台：`enforcement` 为 `true`；暂停按钮可用，保存后显示读回值；文案为"新消息"；
  非管理员读写被拒（已有）。

### 8.2 本机集成测试（Docker：PostgreSQL + Redis + SRH）

- 允许路径：在限额内的多轮导师对话照常完成，账务和改动前一致。
- 消息被拒：第 N+1 条被拒，没有执行、没有预留，余额不变。
- **OPC 重新提交**：被拒后等窗口过去，(a) 用**同一个 requestId** 重新提交 → 原材料原样返回，
  正常准入并回复；(b) 用**新 requestId** → 新材料版本，正常准入并回复；两种情况草稿都没有
  多出可见的空轮次。选题一轮同样覆盖 (a)(b)。
- 调用被拒：先用满调用桶，新一轮准入成功但第一次调用前被拒 → `state=cancelled`，
  `bill2_calls` 0 条，预留全部退回，会话活跃执行已释放，再发新一轮可以继续。
- 一轮不被中途打断：导师 + 整理的一轮开始后，用满调用桶、打开暂停、停掉 SRH，
  这一轮仍完成两次调用并保存结果；下一轮才被拦。
- 暂停：开启后新消息被拒；已准入未开始的一轮在第一次调用前被拦、净扣 0；
  查看、取消、财务恢复照常；关闭后恢复。
- Redis 故障：停掉 SRH，新消息返回 503；没有任何放行。
- 并发：同一用户 20 个并发新消息、额度 10，最多 10 个通过（Upstash 脚本原子执行）；
  两个独立 Node 进程共享计数；同一 requestId 并发只建一份执行和预留；
  调用桶 `rate > 1` 的并发预查不会多放行。
- 配置变化：调高、调低额度不清零已有计数，下一次检查立即按新值。

### 8.3 CI

CI 必需的 10 项检查全部通过。CI 里的 Runtime 和计费集成测试是 `--without-app`，
没有 Redis，用 `vi.mock` 替换闸门；真实 Redis 行为只在本机集成测试里证明，
汇报时如实区分。

### 8.4 本机浏览器测试的注意点

本机预览（#492）每个用例前清空自己的 Redis，但单个用例里如果 1 分钟内超过 10 轮，
会被新限流拦住。这类用例在测试库里调高 `runtime_rate_limits`，不加绕过开关。
同样适用于 Codex 的 Playwright e2e。

## 9. 交互验证和交给 Codex 的 Validation handoff 草稿

运行时改动按 AGENTS 第 6、8 节，要先有浏览器验证，候选才算干净。

**分两段，原因**：真实 Runtime 只能在 staging 正式部署上跑。`stagingRuntimeWindow`
要求 `VERCEL_GIT_COMMIT_REF === 'staging'`、项目正式域名是 staging 的域名，
实施 PR 分支的 Vercel Preview 会被判为 `RUNTIME_STAGING_TARGET_DENIED`，不能调用真实模型。

- **A 段（合并前，在实施 PR 当前 head 上）**：本机预览（真实网页、PostgreSQL、BILL2、
  本机 Redis + SRH，供应商是合成回环），覆盖全部功能、拒绝路径和 Redis 故障。
  这是候选干净的前提。
- **合并前检查 M0**：只读确认当前 staging 的暂停设置是关闭的（合并会立即部署）。
- **B 段（合并后，staging 冒烟）**：少量真实模型调用，只确认部署环境里的接线和提示。
  总控在请求合并批准时向 Owner 说明 B 段只能合并后做。

**真实模型费用**：只有 B 段花钱，估算 6–8 轮导师对话。实施 PR 到验证阶段时按实际步骤
算出次数和金额，由总控请 Owner 批准。

本节是草稿。实施 PR 有了确定的 head、CI 全绿、总控审过之后，再按 CLAUDE.md 的要求
以 `Validation handoff` 评论贴到实施 PR 上。

```text
Validation handoff（草稿）— RATE-LIMIT 接线 + MODERATION-HOOK
A 段入口：实施 PR head <完整 SHA> 的本机预览（run-workbench 带网页启动，含本机 Redis + SRH）
B 段入口：staging auth-staging 域名，部署 commit = <合并后的 staging commit>
身份：总控提供的测试账号引用（管理员一个、普通测试用户一个；不写凭据）

—— A 段（合并前）——
A0. 管理员打开 /admin/settings → AI使用额度，记录 4 个额度和暂停状态原值。
    通过：卡片显示"已接线"，文案为"新消息"，暂停为关闭。
A1. 普通测试用户打开 /admin/settings。通过：被拒（无权限页面或跳转），看不到额度卡片。
    再在浏览器开发者工具里调用 runtimeRateLimits.get 和 update（含 stopNewCalls=true）。
    通过：都返回 FORBIDDEN，管理员刷新后暂停仍为关闭。
A2. 管理员把"新消息每分钟"改为 2，保存，刷新读回。通过：读回为 2。
A3. 测试用户在 /positioning/<草稿> 连续发 2 轮导师对话，均正常回复；1 分钟内发第 3 轮。
    通过：显示"操作过于频繁，请稍后再试。本次被拦截的调用不扣积分。"，第 3 轮前后积分相同，
    没有出现"结果未知"，页面没有多出空轮次。
A4. 等 1 分钟后，在原输入框直接重新发送刚才被拦的那一轮（同一请求）。通过：正常回复。
    再发一条新消息。通过：正常回复。
A5. 在 /runtime 发一轮。通过：和 /positioning 共用次数（在 A2 额度下，两边合计第 3 轮被拦）；
    /runtime 被拦时显示"操作过于频繁，请稍后再试。本次被拦截的调用不扣积分。"，
    不显示"请求状态待核实"，余额不变。
A5b. 在选题页 /positioning/<草稿>/topics 发一轮选题对话，使其在 A2 额度下被拦（必要时先在定位页发够次数）。
    通过：显示同一句"操作过于频繁……不扣积分"，不显示"本次请求状态待核实……"，余额不变；
    等 1 分钟后用页面的"恢复原请求"重新发送同一轮，正常回复。
A6. 管理员点"一键暂停"。测试用户发新一轮。通过：显示"AI服务暂时暂停新调用……"，余额不变；
    历史对话能正常查看。管理员关闭暂停，测试用户再发一轮。通过：正常回复。
A7. 管理员恢复"新消息每分钟"原值，把"模型调用每分钟"改为 2。测试用户在 /positioning 连续发导师轮次，
    直到出现提示。通过：被拦的那一轮显示"操作过于频繁……"，这一轮前后余额相同；
    之前已完成的每一轮回复和整理结果在刷新后都完整保留（没有被作废）。记录第几轮被拦。
A8. 管理员把"模型调用每分钟"改为 1。测试用户发一轮会带整理的导师回答（回答问题卡片）。
    通过：显示"暂时无法确认使用额度……"（单轮需要 2 次，超过上限按配置错误拒绝），余额不变。
A9. 停掉本机 SRH 容器，测试用户发新一轮。通过：显示"暂时无法确认使用额度……"，余额不变。
    重新启动 SRH，再发一轮。通过：正常回复。
A10. 把所有额度和暂停恢复为 A0 的原值，保存并读回。通过：一致。

—— 合并前检查（合并 staging 会立即自动部署，所以这一步必须在执行合并之前做）——
M0. 管理员打开当前 staging 的 /admin/settings → AI使用额度（仍是未接线版本），只读确认
    "暂停设置"显示"未暂停"（不是"已保存暂停意向"），并记录 4 个额度原值。
    否则不合并，报总控（一合并就会停掉所有新消息）。

—— B 段（合并后，staging，真实模型）——
B1. 部署后卡片显示"已接线"，读回值与 M0 一致。普通测试用户打开 /admin/settings 被拒。
B2. 管理员把"新消息每分钟"改为 2；测试用户发 2 轮正常、第 3 轮被拦，余额不变。
B3. 管理员一键暂停 → 测试用户新一轮被拦；关闭暂停 → 再发一轮正常。
B4. 恢复全部原值并读回。

通过标准：A 段全部通过（A5、A5b 若对应页面不对测试用户开放可 SKIP 并写原因）才算候选干净；M0 通过才能合并；
B 段全部通过才算部署验证完成。任何一步出现被拦却扣费、已完成的回复被作废、页面一直"处理中"、
或暂停后仍有新回复，即为失败。
不在范围内：staging 上的 Redis 故障注入和并发压测（只在本机做）、正式环境、内容审核
（默认放行，界面没有变化）、旧 /chat 链路。
记录：每步 PASS/FAIL/SKIP、head 或部署 commit、余额前后差值；不记录账号、密钥、余额原值或对话正文。
```

## 10. 风险和回退

| 风险 | 说明 | 处理 |
| --- | --- | --- |
| Redis 故障或额度用完 | fail-closed，所有新消息被拒 | 选定的取舍。staging 是 Free 套餐（50 万命令/月）；正式环境内测前配足额度（第 3 节） |
| 增加延迟 | 每条新消息多一次设置读取和最多两次 Redis 往返；每轮第一次调用前再多一次设置读取和最多四次 Redis 往返；未实测 | 计时记录里加 `rateLimit` 阶段，A/B 段验证时报告；消息闸门的配置读取与重放查询并行 |
| 调用预扣偏多 | 按 `maxCalls` 预扣，一轮实际用得少也不退回；`/runtime` 每轮 3 次 | 只会少放行；以后需要时再做退回 |
| `rate` 的并发窗口 | 预查和扣减之间并发，可能加了计数又被拒 | 只会偏严 |
| 结果原因不落库 | 刷新后被拦的那一轮显示通用"已停止" | 已知限制，避免改 SQL |
| 计数偏严 | 并发相同请求、配置错误的失败、日窗口拒绝时分钟已计数，都会多算 | 只会少放行，不会多放行 |
| "模型调用"口径比原话严 | Owner 原话"模型调用每分钟 30 次、每天 600 次"，实现为"每轮按最多可用调用数预扣" | 后台文案写明；总控请求合并批准时向 Owner 说明 |
| 被拦的 OPC 新请求仍写数据库 | 新 requestId 过闸门前已写入材料版本（`opc_step_material`）和 `opc_turns`，被拒的请求也会增加行数（不显示、不涉及费用） | 只受现有 `/api/trpc` 按 IP 60 次/分钟的限制；不为此前移闸门（第 2.2 节） |
| 旧链路 | `agentSlice`、工作台 `generate` 若仍对用户开放 | 第 4 节：接上暂停检查，或写明不覆盖并报 Owner |
| 滑动窗口近似 | 不保证任意连续 24 小时严格不超限 | 提示用"近24小时"，不承诺精确 |
| 暂停对长轮次有延迟 | 已开始的一轮会跑完 | 设计如此，避免作废已付费的回复 |
| 暂停意向已提前保存 | 合并即部署即生效 | 合并前检查 M0 |
| 输出检查在整理之后、在流式之后 | 以后正式拦截时已花整理费用、用户已看到文字 | 第 5.2 节已知限制，正式实现时处理 |

**回退**：

- 代码回退：普通 revert PR，回到"已配置、未接线"状态。没有迁移、没有设置结构变化，
  不影响账务数据。
- 运营上的临时缓解：管理员把额度调到上限（60/5000/180/15000）。没有"关掉限流"的选项，
  这是 #488 的设计。
- Redis 长时间故障导致全部被拒：修复 Redis；或经 Owner 批准把 staging 回退到上一个部署。
  不新增放行开关。

## 11. 第一版待确认事项的答复

| 问题 | 答复 | 落在本文 |
| --- | --- | --- |
| "新对话"怎么计 | Owner：每发一条消息算一次；后台写"新消息"/"每轮消息" | 第 2.5、6.1 节 |
| 调用闸门位置 | 总控：`claimCall` 之前，只拦一轮的第一次调用 | 第 2.3 节 |
| 旧链路是否受暂停控制 | 总控：`/api/ai/stream` 已 410，旧代码由 LEGACY-CLOSE 删除；独立审查补充：`agentSlice`、工作台 `generate` 仍开放的要接上暂停检查，否则写明不覆盖并报 Owner | 第 4 节 |
| 封闭内测环境 | Owner：正式环境；正式环境 Redis 等配置是内测前提 | 第 3 节 |
| staging 验证预算 | 总控：到验证阶段按实际步骤算，由总控请 Owner 批准；本文先写估算 | 第 9 节 |
