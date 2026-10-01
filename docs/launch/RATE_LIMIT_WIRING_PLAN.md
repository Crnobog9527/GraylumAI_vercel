# RATE-LIMIT 接线与 MODERATION-HOOK 实施方案

风险 **high**（限流、暂停开关、Runtime 准入和模型调用路径）。本文只是方案，没有改产品代码、
配置或数据库，也没有连接远程 Redis 或数据库。

- 依据代码：#497 冻结 head `f9afd0db7805e80ccc6f5b7023a3e87b5014f5bd`（admission、execute、
  executionStream、runner、opc service、BILL2 service），以及 staging `2be631aa`
  上已合并的 #562 准备切片和 SEC-RATELIMIT（#488）。下文行号均指 `f9afd0db`。
- 规划依据：[MASTER_PLAN](MASTER_PLAN.md) 第 2.1 节第 19、30 项，第 7.1 节 RATE-LIMIT、
  MODERATION、SEC-RATELIMIT 行；[#562 总控接线决定](https://github.com/Crnobog9527/GraylumAI_vercel/pull/562#issuecomment-5926589161)；
  [内容审核接口要求](https://github.com/Crnobog9527/GraylumAI_vercel/pull/566#issuecomment-5930126786)。
- 实施前提：#497 和 #550（含其宿主切片）都已进入 staging。实施时从最新 staging 新开分支，
  先按第 7 节重新核对插入点，再动代码。

## 0. 结论摘要

| 问题 | 结论 |
| --- | --- |
| 挂在哪一层 | 不在 tRPC 路由层。**准入闸门**放在 `runtimeAdmissionService.prepare` 里重放判定之后；**调用闸门**放在执行器 `exchange` 里、`billing.claimCall` 之前。两处都在服务层，所有入口自动覆盖，不改 `opc/service.ts`、`bill2/service.ts` |
| 计数单位 | 都按已验证的用户 ID，跨会话、设备、入口共用。准入：每个新的执行（用户每发一轮）记 1 次，重放不记。调用：每次真正要发给供应商的新调用记 1 次。一次导师回复加一次整理 = 准入 1 次、调用 2 次 |
| 超限时用户看到什么 | 4 句固定中文提示（分钟超限、近 24 小时超限、已暂停、额度服务不可用），都写明"本次被拦截的调用不扣积分"；准入阶段用 429/503，执行中途被拦用新的结果原因 |
| 会不会扣费 | 被拦的准入在预留之前，余额和账本不动；被拦的调用不建 BILL2 调用记录、不冻结，费用 0；同一轮里已经发出的调用照原规则结算 |
| 和计费冲突吗 | 不冲突。闸门在 BILL2 之前，只决定"发不发"；BILL-PAYG 以后在 claim 时逐次冻结，顺序是先过闸门再冻结 |
| Redis 不可用 | 一律拒绝（fail-closed），包括超时，和 #488 一致；没有放行开关 |
| 一键暂停 | 复用 `runtime_rate_limits.stopNewCalls`（已合并），管理员在 `/admin/settings` 操作；停新准入和新调用，正在发出的那一次调用不打断，同一轮的下一次调用被拦；查看、取消、财务恢复不受影响 |
| MODERATION-HOOK | 输入检查点在准入里、`runtime_admit` 之前；输出检查点在执行器里、保存结果（`complete`）之前。默认实现直接放行，返回值类型留出"拦截"；本轮拦截分支只保证不发生、不被改写成 `pending` |
| 新建什么 | 不新建表、RPC、配置项、队列或外部调用。新增两个小模块（闸门组合、审核接口），其余是在现有文件里接线 |

## 1. 现在已有什么

**#562 已合并（准备切片，未接线）**

- 私有设置 `runtime_rate_limits`（`services/runtime/rateLimitSettings.ts`）：
  10/分钟、200/24 小时的准入；30/分钟、600/24 小时的调用；`stopNewCalls=false`。
  管理员专用读写接口 `routers/runtimeRateLimits.ts`，通用设置入口禁写，不进公开白名单。
  读不到或格式不对时抛 503，不回退默认值；不跨请求缓存。
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

| 入口 | 准入 | 执行 |
| --- | --- | --- |
| `runtime.prepare` | `runtimeAdmissionService.prepare` | — |
| `opc.prepareStep` / `opc.topicTurn` | `opcService` → 同一个 `prepare`（service.ts:246、:414） | — |
| `opc.mentorTurnStream` | 同上（一次流里先准入） | `executeOriginalExecution` → `runtimeExecutor.execute` |
| `runtime.execute` / `executeStream` | — | 同上 |

`billing.dispatchOnce` 在仓库里只有一个调用方：`execute.ts:142` 的 `exchange`。

## 2. 限流挂在哪一层、怎么计数

### 2.1 为什么不在 tRPC 路由层

#562 已经核实并经总控确认：路由层拿不到 OPC 的规范请求和重放结果（在 `opc/service.ts`
里构造），也不知道一次 execute 是新执行还是只恢复收据（在 `execute.ts` 拿到 `begin`
结果后才知道）。在路由层拦，要么挡住财务恢复，要么复制一套规则。所以两个闸门都放在服务层。

### 2.2 准入闸门：`admission.ts` 的 `prepare`

位置：`admission.ts:91–92` 重放判定返回之后，紧接着就检查，排在 Skill 加载、模型读取和
`runtime_admit`（:233）之前。

```ts
const replay = await query('runtime_admission_replay', …);
if (replay) return replay;           // 重放：不计数、不检查暂停
await admitNewWork(admin, actorId, environment);   // 新增：暂停 → 准入桶
```

- 放在最前面而不是紧贴 `runtime_admit`：被限流的用户不再消耗 Skill 加载和多次数据库读取。
  代价是配置错误（例如模型不可用）导致的失败也占一次准入次数，偏严，可以接受。
- 所有准入入口都经过这里，`opc/service.ts` 不用改。OPC 的 `opc_step_material` /
  `opc_topic_material` 在调用 `prepare` 之前已经写入；被限流时会留下"有材料、没有执行"
  的记录。这和现在任何准入失败（模型不可用、预算配置错误）留下的状态一样，
  `prepareTopicTurn` 本来就先写材料再判重放。实施时用 OPC 集成测试证明被拦后等窗口过去、
  用新请求还能正常继续；如果测试发现会卡住，再把闸门挪到 OPC 写材料之前，
  并用"每个请求只算一次"的同一个闸门实例传进 `prepare`，不加跳过检查的标志位。
- 配置读取可以和重放查询并行发起，只在确认不是重放后才使用结果，省一次往返。

### 2.3 调用闸门：`execute.ts` 的 `exchange`

位置：`execute.ts:133` 判断"这是本执行的活跃所有者、而且这一步还没发过"之后，
`billing.claimCall`（:139）之前。

```ts
if (!execution.live || existing?.state === 'dispatched' || …) throw new Error('RUNTIME_RESPONSE_PENDING');
const verdict = await checkNewCall(…);           // 新增：暂停 → 调用桶
if (!verdict.ok) { gateRejection = verdict.reason; throw new Error('RUNTIME_CALL_GATE'); }
const claim = await billing.claimCall(…);
```

和 #562 时总控说的"`dispatchOnce` 发送前"相比，本方案建议提前到 `claimCall` 之前，原因：

1. `dispatchOnce` 只有 `exchange` 一个调用方，覆盖范围相同。
2. 在 claim 之前拒绝，BILL2 里不会留下一条 prepared 的调用，不用走撤销
   （`bill2_revoke_unstarted_dispatch`），以后 BILL-PAYG 在 claim 时冻结，被拦的调用也不会冻结。
3. 拒绝后要结束这一轮，需要执行状态（是不是活跃所有者、前面有没有发过调用），
   这些都在 `execute.ts`。放进 `bill2/service.ts` 还得把原因再传回来。
4. 不改 `bill2/service.ts`，少和 #550、BILL-PAYG 重叠。

代价：以后如果有新代码绕开 `exchange` 直接调 `claimCall`，就绕开了闸门。处理：在
`claimCall` 旁边写明"必须先过调用闸门"，审查时检查；如果总控更想要 BILL2 层的硬边界，
替代做法是给 `authoritativeBilling` 加一个必填的 `beforeClaim` 依赖，其余设计不变。

只读和恢复路径都碰不到这个闸门：已保存回复的重放（`existing.rawBody`）、
非活跃所有者（`live=false`）、`cost_pending` 恢复、`cancelRequested`、
`recoverFinancial`（只查收据，不进 `exchange`）。

**SDK 会包装 `exchange` 抛出的错误**，所以和现有 `terminalReplyFailure`、
`transportNotStarted` 一样，用一个局部变量 `gateRejection` 记住原因，在外层 catch 里判断。

### 2.4 被拦之后这一轮怎么结束

在 `execute.ts` 的 catch 里，和 `RUNTIME_OUTPUT_TRUNCATED` 分支（:347）并列加一个分支：

- `gateRejection` 存在且 `execution.live` → 调用现有 `runtime_cancel`，返回
  `{state, unavailable: <原因>}`。
- 第一次调用就被拦：这一轮没有任何已发出的调用，`runtime_cancel` → BILL2 取消并结算，
  预留全部释放，净扣 0，会话的活跃执行被释放。
- 中途被拦（例如导师回复已发出、附属整理被拦）：已发出的调用按原规则结算，
  被拦的调用没有 claim，费用 0。
- `runtime_cancel` 的响应丢失时不重试，和现有分支一样交给之后的恢复流程检查。

**为什么不走 `fail_before_dispatch`**：SQL 里它只在"这一轮没有任何已发出调用"时才取消
（0106 迁移 `runtime_execution`），中途被拦时它什么都不做，代码会落到 `interrupt`，
返回 `pending`。`interrupted` 状态的执行再调用 `begin` 不会重新变成活跃所有者，
只能重放，等于卡住。`runtime_cancel` 两种情况都能正确结束，`OUTPUT_TRUNCATED`
和 `transportNotStarted` 已经这样用。

`runtime_cancel` 按结算结果返回 `cancelled`、`completed`（已有保存结果时）或
`cost_pending`，本分支原样返回，和 `transportNotStarted` 分支一致。

结果原因写在返回值里，不写数据库。`runtime_executions.unavailable_reason` 只能由 SQL
函数写入，而且它的含义是"这一轮的内容和历史不可再用"（0106 的
`runtime_history_available`、0136 注释），借用它会让被限流的这一轮从后续上下文里消失；
另加原因要改 SQL，超出最小改动。刷新页面后只显示通用的"已取消"，这是已知限制。

### 2.5 计数口径

| 场景 | 准入次数 | 调用次数 |
| --- | --- | --- |
| 自由对话或 Skill 一轮，只有主回复 | 1 | 1 |
| 导师一轮 + 附属整理（`organizeAfter` 或开场提取） | 1 | 2 |
| 需要先做 Skill 匹配的一轮 | 1 | 匹配 1 + 主回复 1 + … |
| SDK 多步（工具调用后再问模型） | 1 | 每一次模型请求各 1 |
| 付费搜索工具（`tool:search`，走 BILL2） | 0 | 1（staging 真实搜索目前关闭） |
| 同一请求重放、丢失响应后重新读取 | 0 | 0 |
| 并发两个相同请求（同一 requestId）同时到达 | 可能 2 | 0（SQL 只建一份预留） |
| 已保存回复的重放、收据恢复、取消、查看 | 0 | 0 |
| 新建会话 `runtime.start`、保存材料 | 0 | 0 |

- 标识：已验证的用户 ID（准入用 `actor()`，执行用 `options.actor()`），不按会话或 IP。
  管理员同样受限，没有绕过。
- 环境前缀：本机回环模式为 `local`，staging 测试窗口为 `staging`，沿用现有判断
  （`runtimeLocalEndpoint()` 成功即本机）。`production` 留给 RUNTIME-PROD 接正式环境时使用。
- 按现在的配置（`runtime.prepare` 最多 3 次调用，OPC 1–2 次），10 次准入/分钟最多
  产生 30 次调用，200 次/天最多 600 次，正好等于调用限额。所以正常使用时准入桶先起作用，
  调用桶主要防多步 Skill 和以后调大 `maxCalls`。滑动窗口是近似算法（#562 文档已说明），
  边界上可能出现中途被调用桶拦下的情况，第 2.4 节已覆盖。
- **口径请总控确认**：Owner 原话是"新对话"，#562 方案和本文都按"每发一轮（新执行）"计，
  不是"每新建一个会话"。按会话计会让单个会话里的轮数不受限，失去保护作用。

### 2.6 超限时用户看到什么

沿用 #562 方案里总控已通过的 4 句固定提示，不拼动态数字和内部错误：

| 情况 | 准入阶段 | 执行中途（结果原因） | 提示 |
| --- | --- | --- | --- |
| 分钟超限 | 429，`retryAfter`=窗口剩余秒数 | `call_limited` | 操作过于频繁，请稍后再试。本次被拦截的调用不扣积分。 |
| 24 小时超限 | 429，同上 | `call_limited` | 近24小时使用次数已达上限，请稍后再试。本次被拦截的调用不扣积分。 |
| 已暂停 | 503，`retryAfter`=60 | `paused` | AI服务暂时暂停新调用，请稍后再试。本次被拦截的调用不扣积分。 |
| Redis 或配置不可用 | 503，`retryAfter`=60 | `limit_unavailable` | 暂时无法确认使用额度，请稍后再试。本次被拦截的调用不扣积分。 |

- 准入阶段复用 `RateLimitError`（tRPC 错误格式里已经带 `retryAfter`；
  `stagingProcedureError` 对非 500 的 TRPCError 原样放行）。只给它加按原因选择提示文字的参数，
  旧链路默认文字不变。
- 中途被拦：扩展 `AgentTurnUnavailable`（`shared/agentTurn.ts`）三个值，页面按原因显示
  上表提示；中途被拦时补一句"已完成的部分按实际用量结算"。
- 前端要改的地方：`positioning/[draftId]/admission-message.ts` 现在只认
  `PRECONDITION_FAILED`、`FORBIDDEN`、`SERVICE_UNAVAILABLE`，429 会显示成"结果未知"，
  要加上 `TOO_MANY_REQUESTS`；`agent-turn-display.ts` 和 `/runtime` 页面的结果提示加三个原因。
  不自动重试。
- "近24小时"是滑动窗口的近似说法，不承诺任意连续 24 小时都严格不超过 200 次。

### 2.7 和计费（BILL2 / BILL-PAYG）的关系

- 准入被拒发生在 `runtime_admit` 之前：没有执行、没有预留，余额和账本不动。
- 调用被拒发生在 `claimCall` 之前：没有 BILL2 调用记录。第一次就被拒时整轮退回，
  净扣 0；中途被拒时只结算已经发出的调用，不补扣、不重发；金额未知的照原来的待核对处理。
- BILL-PAYG（#553）以后在 claim 时按次冻结、余额低于 L 时在两步之间暂停。
  执行顺序是：调用闸门 → PAYG 冻结 → 发送。限流拒绝不冻结，PAYG 的"余额不足暂停"
  不消耗限流次数（它在闸门之后）。两者原因不同，提示分开。
  PAYG 落地后，如果它提供了"两步之间暂停、可继续"的状态，中途被限流可以改用它代替取消，
  届时由 PAYG 方案决定，本方案不预留。
- 不做全站美元硬上限，那是 GLOBAL-DAILY-COST，和本任务分开。

## 3. Redis 不可用时

**一律拒绝，和 #488 一致。** 具体是：

- Redis 未配置、报错、500ms 内没返回、SDK 返回 timeout 标记 → 拒绝，原因 `limit_unavailable`。
- `runtime_rate_limits` 读取失败或内容不合法 → 同样拒绝。现有 `readRuntimeRateLimits`
  会抛 503；在调用闸门里要把它转换成 `gateRejection`，**不能让它落进通用 catch 变成
  `pending`**。
- 中途遇到 Redis 故障也按第 2.4 节结束这一轮。偏严，但不会多放行。
- 没有内存兜底，没有"故障时放行"的开关。故障期间所有新对话和新调用都会被拒，
  恢复办法是修好 Redis，或者经 Owner 批准回退部署（第 10 节）。
- 已有日志事件不变：`runtime_rate_limit_backend_unavailable_denying_request`、
  `runtime_rate_limit_config_unavailable`。新增一个暂停拒绝的 info 事件
  `runtime_new_calls_paused`，只记入口类型，不记用户 ID 和正文。

前提（来自 #562 和 #488）：staging 的 `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`
已由 Owner 确认存在（#488 Handoff）；正式环境还没有配置。因为 fail-closed，
**正式环境上的 Runtime 在配好 Redis 和足够额度之前，任何新对话都会被拒**。
封闭内测如果在正式环境进行，配置 Redis 是内测前提，请总控记入上线前待办。

## 4. 一键暂停开关

- **存在哪里**：已合并的 `system_settings` 私有键 `runtime_rate_limits` 的 `stopNewCalls`。
  不新建表、不加新键。
- **谁能操作**：只有管理员（现有 `adminProcedure` 专用接口）。普通用户和匿名用户读写都被拒，
  已有测试。后台卡片的暂停按钮在接线后启用，保存后读回显示真实状态；
  `enforcement` 三个标志改为 `true`。
- **多快生效**：设置不缓存，下一次准入或下一次调用检查时就生效。
- **生效范围**：
  - 停：新准入（所有入口）；正在进行的轮次里的下一次新调用。
  - 不打断：已经发出、正在返回的那一次调用（最长到 `OPENROUTER_RESPONSE_TIMEOUT_MS`
    = 240 秒），它的回复正常保存和结算。
  - 不受影响：查看、取消、已保存回复的重放、收据和财务恢复、注销后的财务收尾。
- **检查顺序**：先读配置看暂停，暂停时直接拒绝、不访问 Redis（不消耗命令），
  再查限流桶。
- **上线前要核对一件事**：#562 起后台接口就能保存 `stopNewCalls`（只是没生效）。
  部署接线版本前，要先在 staging 后台确认它是 `false`，否则一部署所有新调用就会停。
  写进验证步骤第 0 步。
- 和规划里 RUNTIME-PROD ⑤"一键停止新调用的开关"是同一个开关，正式环境沿用，不另做。
- **旧链路不在范围内**：`/chat`（`routers/ai.ts`、`/api/ai/stream`）、工作台和
  `agentSlice` 有各自的 SEC-RATELIMIT 限流，暂停开关不管它们。如果封闭内测前旧链路
  还对用户开放，需要另定：要么 LEGACY-CLOSE 先下线，要么在旧链路共用的检查里加一行暂停判断。
  请总控决定，本方案默认不碰旧链路。

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
| 输入 | `admission.ts` 的 `prepare`，准入闸门之后、`assertFrozenPayloads`（:232）之前 | 这时已经拿到最终输入，还没有执行和预留；以后拦截时什么都不用撤销。放在闸门之后，以后接外部审核服务时，被限流的请求不会消耗审核调用 |
| 输出 | `execute.ts`，主回复和附属整理都完成之后、`runtime_execution complete`（:335）之前 | 这是"完整回复"第一次全部可得、还没保存成结果的位置；重放和恢复路径在前面已经返回，不会重复检查 |

`runner.ts` 不改：它只负责 SDK 一次运行，看不到准入和保存的边界。

### 5.3 本轮遇到"拦截"怎么办

默认实现永远放行，生产代码只接 `allowAllModeration`，所以拦截分支本轮不会出现。
为了不留隐患，代码里仍要写清楚：

- 输入返回 `block` → 抛出专用错误 `RUNTIME_MODERATION_BLOCKED`，在 `runtime_admit`
  之前，什么都没创建。
- 输出返回 `block` → 走第 2.4 节同一条 `runtime_cancel` 结束路径，**绝不落进通用 catch
  变成 `pending`**。
- 不做的事：拦截后不收费、独立终止状态、拦截日志、界面提示、流式文字的撤回。
  这些等 Owner 决定正式实现时再做，届时"被拦截"要有自己的终止状态。
- 已知限制写进代码注释：导师回复是流式的，输出检查时用户已经看到了文字。
  正式实现要决定是否先缓冲或撤回，本轮不处理。

### 5.4 怎么证明行为不变

- 单元测试：`allowAllModeration` 对任何输入都返回放行，过程中没有网络请求（fetch 替身调用 0 次）。
- 准入：默认实现下 `runtime_admit` 收到的冻结上下文和计费参数与改动前逐字节相同
  （现有准入测试断言这些参数，保持通过）。
- 执行：现有 Runtime、流式、OPC 集成测试全部原样通过，其中已经断言发给供应商的请求字节、
  结果正文和状态。
- 次数：新准入时输入检查恰好 1 次；重放 0 次；新完成的执行输出检查恰好 1 次；
  `cost_pending` 恢复、已完成重放、取消 0 次。
- 拦截替身（只在测试里）：输入拦截 → 没有 `runtime_admit`、没有预留；
  输出拦截 → 结果是 `cancelled` 或 `cost_pending`，不是 `completed`，也不是 `pending`。

## 6. 实施范围和最小改动说明（AGENTS 第 5 节）

### 6.1 预计改动的文件

| 文件 | 改什么 |
| --- | --- |
| 新增 `services/runtime/newWorkGate.ts` | 组合"读配置 → 暂停 → `checkRuntimeRateLimit`"，返回 `{ok}` 或拒绝原因；准入和调用共用 |
| 新增 `services/runtime/moderation.ts` | 第 5.1 节接口和默认放行实现 |
| `services/runtime/admission.ts` | 重放之后接准入闸门；`runtime_admit` 前接输入检查点 |
| `services/runtime/execute.ts` | `claimCall` 前接调用闸门；`complete` 前接输出检查点；catch 里加结束分支 |
| `lib/rateLimitError.ts` | 按原因选择提示文字，旧链路默认不变 |
| `routers/runtimeRateLimits.ts` | `enforcement` 改为三个 `true` |
| `shared/agentTurn.ts` | `AgentTurnUnavailable` 加 `call_limited`、`paused`、`limit_unavailable` |
| `components/admin/RuntimeRateLimitSettings.tsx` | 启用暂停按钮，文案改为已接线 |
| `positioning/[draftId]/admission-message.ts`、`agent-turn-display.ts`、`/runtime` 结果提示 | 显示固定提示，识别 429 |
| 测试文件 | 见第 8 节；集成测试按仓库已有做法 `vi.mock` 替换 Redis |

不改：`opc/service.ts`、`bill2/service.ts`、`runner.ts`、`executionStream.ts`、
两个路由的组合代码、SQL 和迁移、依赖。`execute.ts` 和 `admission.ts` 的行数要守住
代码大小基线（`execute.ts` 有超长行基线 22 条，不能增加），必要时把闸门判断放进新模块。

**生产代码不留"可选放行"参数**：闸门在服务内部用现有 admin 客户端构造，测试通过
`vi.mock('../redisRateLimiter')` 或替换闸门模块（`accountErasure`、`invitationAbuse`
集成测试已经这样做）。这样不会因为某个调用点忘了传参数而默认放行；
读不到设置的情况按"不可用"拒绝。

### 6.2 为什么这是最小的正确做法

- **考虑过的现有机制**：`runtime_rate_limits` 设置和专用接口、`checkRuntimeRateLimit`、
  `RateLimitError` 和 tRPC 错误格式、`runtime_cancel` 结束路径、`AgentTurnUnavailable`
  结果原因、部署级开关 `V3_RUNTIME_STAGING_ENABLED`。前五个全部复用；
  部署级开关需要重新部署，满足不了"一键"，所以保留它、另外接 `stopNewCalls`。
- **最小缺口**：把已有的配置和限流函数接到准入和调用两个点上，加上被拦后的结束路径和提示。
- **不新增**：表、RPC、配置键、队列、定时任务、外部服务、通用策略框架。
  两个新模块都是本地辅助函数，不是新的权威来源。
- **权威来源不变**：额度和暂停以 `system_settings.runtime_rate_limits` 为准；
  计数以 Redis 为准，只决定放不放行，不做财务记录；费用仍以 BILL2 为准。

## 7. 和在途 PR 的交互

| PR | 关系 | 处理 |
| --- | --- | --- |
| #497（冻结 `f9afd0db`，Codex 写入） | 改 `admission.ts`、`execute.ts`、`opc/service.ts`、`shared/agentTurn.ts`、定位页 | 本方案的插入点就是基于它。等它合并，不往里加东西 |
| #550（`8da3947a`，SQL 切片在途；宿主切片要等 #497） | 宿主切片会改 `execute.ts`、`executionStream.ts`、`bill2/service.ts`（注销后受限收尾、抑制观测） | 等它的宿主切片合并后再实施。实施前重新核对：调用闸门仍在 `claimCall` 前，注销后的财务收尾路径不经过新调用闸门 |
| BILL-UNIT #565 / BILL-PAYG #553（方案） | PAYG 会改 claim 时的冻结，和调用闸门相邻 | 规划顺序是 RATE-LIMIT 在 #497、#550 之后、内测之前。如果 PAYG 先实施，调用闸门仍放在冻结之前；两边写入方不同时改 `execute.ts` 的同一段 |
| PROMPT-CACHE | 改请求组装，不改闸门位置 | 无直接冲突，按合并先后同步 |
| #561（STG-MENTOR-MODEL 实测） | 在 #497 冻结 head 上跑，不受本方案影响；但接线部署后，同一测试账号每分钟最多 10 轮 | 如果实测排在接线之后，由管理员临时调高额度（上限 60/5000/180/15000），测完恢复，不加绕过 |
| #547 REPORT-GEN | 报告生成会产生多次调用 | 每次调用照常计数；如果报告单轮调用数会超过 30/分钟，在它的方案里说明需要的额度 |

迁移编号：本方案没有迁移，不占编号。

## 8. 测试计划

### 8.1 单元测试（不需要 Docker）

- 闸门模块：暂停时拒绝且 Redis 调用 0 次；配置读取失败、内容不合法 → `limit_unavailable`；
  分钟拒绝、日拒绝分别给出正确原因和 `retryAfter`；Redis 报错和 500ms 挂起 → `limit_unavailable`；
  环境前缀 local/staging 正确；同一用户跨入口共用一个桶，不同用户互不影响。
- 准入：重放请求不调用闸门、不检查暂停；新请求恰好调用 1 次且在 `runtime_admit` 之前；
  被拒时没有 `runtime_admit` 调用；四个入口（`runtime.prepare`、`opc.prepareStep`、
  `opc.topicTurn`、`opc.mentorTurnStream`）都被同一个闸门拦住。
- 执行：闸门只在活跃所有者的新调用前运行；重放、`cost_pending` 恢复、取消、
  `recoverFinancial` 都不调用；被拒时不调用 `claimCall`；SDK 包装后的错误仍被识别。
- 错误和提示：429/503、`retryAfter`、4 句固定文字；旧链路 `RateLimitError` 默认文字不变；
  前端映射把 429 显示为固定提示而不是"结果未知"，三个新结果原因各自有提示。
- 审核接口：第 5.4 节全部。
- 后台：`enforcement` 为 `true`；暂停按钮可用，保存后显示读回值；非管理员读写被拒（已有）。

### 8.2 本机集成测试（Docker：PostgreSQL + Redis + SRH）

- 允许路径：在限额内的多轮导师对话照常完成，账务和改动前一致。
- 拒绝路径（准入）：第 N+1 轮被拒，没有执行、没有预留，余额不变；窗口过去后用新请求能继续，
  OPC 草稿没有卡住。
- 拒绝路径（第一次调用）：把调用分钟额度设为 0 次可用（先用满），新执行被拒后
  `state=cancelled`，`bill2_calls` 0 条，预留全部释放，会话活跃执行已释放。
- 拒绝路径（中途）：导师 + 整理的一轮，第一次调用后用满额度，整理被拒：第一次调用已结算，
  整理调用没有记录，结果不是 `pending`，再发新一轮可以继续。
- 暂停：开启后新准入被拒；正在返回的调用完成并保存；下一次调用被拦；
  查看、取消、财务恢复照常；关闭后恢复。
- Redis 故障：停掉 SRH，准入返回 503；正在进行的一轮在下一次调用时按不可用结束；
  没有任何放行。
- 并发：同一用户 20 个并发新准入、额度 10，最多 10 个通过（Upstash 脚本原子执行）；
  两个独立 Node 进程共享计数；同一 requestId 并发只建一份预留。
- 配置变化：调高、调低额度不清零已有计数，下一次检查立即按新值。

### 8.3 CI

CI 必需的 10 项检查全部通过。CI 里的 Runtime 和计费集成测试是 `--without-app`，
没有 Redis，用 `vi.mock` 替换闸门；真实 Redis 行为只在本机集成测试里证明，
汇报时如实区分。

### 8.4 本机浏览器测试的注意点

本机预览（#492）每个用例前清空自己的 Redis，但单个用例里如果 1 分钟内超过 10 轮，
会被新限流拦住。这类用例在测试库里调高 `runtime_rate_limits`，不加绕过开关。
同样适用于 Codex 的 Playwright e2e。

## 9. staging 验证和交给 Codex 的 Validation handoff 草稿

本节是草稿。实施 PR 有了确定的 head、CI 全绿、总控审过之后，再按 CLAUDE.md 的要求
以 `Validation handoff` 评论贴到实施 PR 上。

**会花真实模型费用**：staging 测试窗口用真实供应商。预计 10–15 轮导师对话，
费用受测试窗口报价上限约束。开始前需要总控确认这笔预算。

```text
Validation handoff（草稿）— RATE-LIMIT 接线 + MODERATION-HOOK
入口：staging auth-staging 域名，部署 commit = <实施 PR 合并后的 staging commit>
身份：总控提供的 staging 隔离测试账号引用（管理员一个、普通测试用户一个；不写凭据）
前提：部署前已在 /admin/settings → AI使用额度 确认"暂停"为关闭（第 0 步记录）

0. 部署前，管理员打开 AI使用额度卡片，记录 4 个额度和暂停状态原值。
   通过：暂停为关闭。否则停止，报总控。
1. 部署后，卡片显示"已接线"，暂停按钮可点。通过：读回值与第 0 步一致。
2. 把"新对话每分钟"改为 2，保存，刷新页面读回。通过：读回为 2。
3. 普通测试用户在 /positioning/<草稿> 连续发 2 轮导师对话，均正常回复；
   1 分钟内发第 3 轮。通过：显示"操作过于频繁，请稍后再试。本次被拦截的调用不扣积分。"，
   第 3 轮前后积分余额相同，没有出现"结果未知"。
4. 等 1 分钟后再发一轮。通过：正常回复。
5. 如果 /runtime 对测试用户开放：在 /runtime 发一轮，确认和 /positioning 共用次数
   （在第 2 步额度下，两边合计第 3 轮被拦）。不开放则记 SKIP。
6. 管理员点"一键暂停"。测试用户发新一轮。通过：显示"AI服务暂时暂停新调用……"，
   余额不变；历史对话能正常查看。
7. 管理员关闭暂停。测试用户再发一轮。通过：正常回复。
8. 把"模型调用每分钟"改为 1、"新对话每分钟"恢复原值。测试用户发一轮会触发附属整理的
   导师回答（回答问题卡片）。通过：导师回复出现，随后显示限流提示，页面不卡在"处理中"；
   刷新后可以继续发新一轮；余额只扣了导师那一次调用。
   （是否触发整理取决于当时的轮次；没触发则记 SKIP，并说明原因。）
9. 把所有额度和暂停恢复为第 0 步的原值，保存并读回。通过：读回与原值一致。

通过标准：1–4、6、7、9 全部通过；5、8 通过或有理由的 SKIP；任何一步出现扣费、
页面一直"处理中"、或暂停后仍有新回复，即为失败。
不在范围内：Redis 故障注入（只在本机测）、并发压测、正式环境、内容审核
（默认放行，界面没有变化）、旧 /chat 链路。
记录：每步 PASS/FAIL/SKIP、部署 commit、余额前后差值；不记录账号、密钥、余额原值或对话正文。
```

## 10. 风险和回退

| 风险 | 说明 | 处理 |
| --- | --- | --- |
| Redis 故障或额度用完 | fail-closed，所有新对话和新调用被拒 | 选定的取舍。staging 是 Free 套餐（50 万命令/月，#562 估算两步合计满额单用户约 19–24 万/月）；正式环境上线前配足额度 |
| 增加延迟 | 每次准入、每次调用各多一次设置读取和最多两次 Redis 往返；未实测 | 计时记录里加 `rateLimit` 阶段，staging 实测后报告；配置读取与重放查询并行 |
| 中途被拦 | 用户已看到导师回复，随后提示被拦，这一轮结束为已取消 | 正常额度下准入桶先起作用，很少发生；提示写明已完成部分按实际结算 |
| 结果原因不落库 | 刷新后只显示通用"已取消" | 已知限制，避免改 SQL |
| 计数偏严 | 并发相同请求、配置错误的失败、日窗口拒绝时分钟已计数，都会多算 | 只会少放行，不会多放行 |
| 滑动窗口近似 | 不保证任意连续 24 小时严格不超限 | 文档和提示用"近24小时"，不承诺精确 |
| 暂停意向已提前保存 | 部署即生效 | 验证第 0 步 |
| 旧链路不受暂停控制 | 见第 4 节 | 请总控决定 |

**回退**：

- 代码回退：普通 revert PR，回到"已配置、未接线"状态。没有迁移、没有设置结构变化，
  不影响账务数据。
- 运营上的临时缓解：管理员把额度调到上限（60/5000/180/15000）。没有"关掉限流"的选项，
  这是 #488 的设计。
- Redis 长时间故障导致全部被拒：修复 Redis；或经 Owner 批准把 staging 回退到上一个部署。
  不新增放行开关。

## 11. 请总控确认的事项

1. "新对话"按"每发一轮（新执行）"计数（第 2.5 节），是否需要向 Owner 再确认措辞。
2. 调用闸门放在 `execute.ts` 的 `claimCall` 之前（推荐），还是放进 BILL2 作为必填依赖（第 2.3 节）。
3. 旧链路（`/chat`、工作台）是否要受暂停开关控制，还是以 LEGACY-CLOSE 先下线为准（第 4 节）。
4. 封闭内测在哪个环境进行；如果是正式环境，Redis 配置要列为内测前提（第 3 节）。
5. staging 验证的真实模型预算（第 9 节）。
