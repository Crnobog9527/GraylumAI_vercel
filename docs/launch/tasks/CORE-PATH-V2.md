# CORE-PATH-V2 每轮对话主路径重做：诊断与完整计划

状态：方案（仅方案，待 Owner 决定第 8 节后开工）。2026-10-28，架构窗口（Fable 5.1）。
依据：Master Plan §2.1 2026-10-28 条（Owner 选 B：不升级数据库、推迟上线、重做主路径；staging 与正式不得有区别）、
2026-10-27 DB-PERF 条、2026-10-25 两条 DB-PERF 决定；代码以 `origin/staging` `4f6fbf995` 为准（本窗口逐条核对）；
压测与诊断数据来自 DB-PERF 窗口（10-25/26/27）、架构窗口 `db-rw-redesign-v1`、缓存窗口 `prompt-cache-diagnosis-v1`。
本文只做诊断和计划：不写产品代码、不写 staging、不花钱。

> 给接手窗口的话：按第 6 节的 PR 顺序做，每个 PR 的"验收"就是合并条件；第 2 节是设计，第 4 节是不能丢的产品规则，
> 第 7 节是以后每个主路径 PR 都要过的门。遇到本文没写的决定，先看 Master Plan §2.1，再问总控，不自己定。

## 0. 一页总览

- **病根**：每一轮对话把"这一轮能不能继续"的全部证明从头算、从头锁一遍。一次准入静态可达 112 个函数、62 张表，
  一轮 41–82 次数据库往返，事务里持 90–130 把关系锁，并在 `modules`、`system_settings`、止损账本、staging 测试窗口
  这些全站共用的行上排队。Micro 的 2 个共享核被这些 CPU 密集的 PL/pgSQL 吃满：100 人时 CPU 平均 66%、尖峰 89%，
  吞吐在 75 人后不再上涨（约 63 轮/分）。三个开关（0416/0418/0419）没有可测量的改善，因为它们削的是锁数，不是工作量。
- **方向**：一轮对话只剩三类数据库写入——**开轮**（`turn_open`）、**记账**（每次模型/工具调用一行回执，分"发出前 / 拿到供应商 id / 结束"三步写，2.5.2）、
  **收轮**（`turn_close`）。证明只在开轮做一次；目录（设置、模型、Skill 包、权益规则）进 Node 进程缓存（0419 已上库的机制）；
  历史可见性在删除时维护而不是读时重算；删除检查搭在必经的写入上。自由对话一轮 6 次往返（含登录），导师 12 次（今天 41 / 61）。
- **范围**：定位导师、自由对话、Skill 工具、研究工具、报告、对比、评审团、停止/退款/暂停、历史、删除/注销——都接到同一条核上；
  删掉 staging 测试窗口和 BILL2 逐调用四步；旧路径整体删除，不并存。
- **工期**：13 个 PR，三个窗口并行，计划 7 周（含 1 周余量，乐观 5 周）；100 人验收通过后 Owner 另定上线日期。
- **Owner 已决（10-28，第 8.0 节）**：A 重做并删旧；验收通过后 7 天内上线；五条简化全同意；评审团不给结束按钮；普通对话不提供停止；
  e2e 用 Claude Haiku 5.5；**新要求：扩容到 500/2000/5000 不再重构**——第 3.3 节回答：代码结构现在做对（无热点行、锁按人/会话、可分区主键、
  事务模式兼容、定时任务分批、供应商限流），人数靠加规格（Micro ≈ 真人节奏 950 人，5000 人要 2XL）。

## 1. 诊断：现在一轮对话发生了什么

### 1.1 一轮的生命周期（现状，自由对话一次模型调用）

| 阶段 | 入口 | 数据库调用（RPC） | 往返（10-27 实测中位数） |
|---|---|---|---|
| 请求开头 ×2（`prepare`、`executeStream` 是两个 tRPC 请求，`packages/api/src/routers/runtime.ts:172,204`） | 登录、维护开关、`profiles`、staging 策略 `runtime_test_policy`（`runtime/stagingPolicy.ts:22`；正式环境改走 `productionPolicy.ts:36` 的 7+N 次） | 每请求 3–4 | 6–8 |
| 准备（`runtime/admission.ts:155-195`） | `runtime_session_context`、`runtime_admission_replay`、资料库/PAYG/研究工具准入、`runtime_positioning_gate`，设置 10 次、Skill 包 5 次、模型 3 次，最后 `runtime_admit`（或 0418 的 `precheck`+`commit`，`admitSplit.ts:23-36`） | 1 个大事务 | 22 |
| 开始 | `runtime_execution('read')`、`runtime_session_items read/freeze`（`runtime/session.ts:24`） | 3 | 3 |
| 每次模型调用 | `bill2_claim`→`bill2_payg_claim`（冻结）、`bill2_dispatch`（发出）、`runtime_response` ×2、`bill2_record`（回执，内联 `bill2_payg_finalize`）、`bill2_finalize`（再结一次）（`execute.ts:177-217`、`bill2/service.ts:124-266`） | 7 | 7 |
| 流式输出 | 每个对外事件前 `executionVisibility.visible()`→`runtime_execution_visibility`（`executionStream.ts:233-250`，文本每 100 ms 一次） | 15–30 | 15–30 |
| 收尾 | `runtime_session_items append`、`runtime_execution complete`、`opc_capture_apply`（自由对话必被拒） | 3–4 | 3–4 |
| **合计** | | | **41（10-27）；教练 61；10-25 为 62/82** |

### 1.2 一次 `runtime_admit` 做了什么（`packages/db/functions/runtime/runtime_admit.sql`，db-rw-redesign-v1 §1.1 逐步核对）

归档守卫（`opc_assert_business_writable`，对 `opc_businesses` FOR KEY SHARE）→ 删除边界 → 请求锁与会话锁 → 范围归属
（`bill2_scope_allowed` 走 opc/artifact/library 一遍）→ 幂等 → 报告检查 → 整理待处理（`runtime_executions` 缺 session_id 索引，
0416 前顺序扫描）→ 提问卡 → 上下文（`runtime_context_allowed` 对 artifact_* FOR SHARE）→ 内容源 → **历史候选**（最近最多 228 行，
对每个祖先执行跑 `runtime_direct_billing_allowed` = 再走一遍权限链 + `modules/skills/skill_revisions FOR SHARE`）→ Skill 绑定
（`modules FOR SHARE`，全站热点行）→ `bill2_prepare`（`bill2_execution_allowed` 又一遍权限链；`profiles FOR UPDATE`；插 `bill2_runs`）
→ 插 `runtime_executions`、更新会话。

静态闭包（架构窗口脚本，`packages/db/functions` 为准）：

| RPC | 可达函数 | 不同的表 | 每轮次数 |
|---|---|---|---|
| runtime_admit | 112 | 62 | 1 |
| bill2_payg_claim | 100 | 56 | 每次调用 1 |
| bill2_dispatch | 121 | 68 | 每次调用 1 |
| runtime_execution | 127 | 67 | 5–7 |
| runtime_session_items | 87 | 54 | 2–3 |
| runtime_tool | 77 | 45 | 每次工具 2 |

规模：`packages/db/functions` 939 个函数文件（runtime 111、billing 102、fusion 63、erasure 61、opc 87、research 51、report 31……）；
398 个迁移（最新 0419）；`packages/api/src/services/runtime` 315 个文件、`bill2` 56 个；`packages/db/tests` 约 120 个套件。

### 1.3 压测事实（staging Micro、连接池 8、假回复、10-25 节奏；DB-PERF 窗口 10-26 第三轮、10-27 复测）

| 人数 | 自由对话失败 | 教练失败 | 57014 | 数据库 CPU 平均/最高 | 交换区最高 | 教练一轮 p50/p95 |
|---|---|---|---|---|---|---|
| 50 | 0 | 0 | 0 | 45% / 63% | 568 MB | 32 / 41 s |
| 75 | 0 | 4.8% | 0 | 61% / 82% | 726 MB | 44 / 56 s |
| 100 | 0 | 5.5% | 4 | 66% / 89% | 676 MB | 55 / 64 s |

- 吞吐在 75→100 人不再涨（63.2→62.8 轮/分）：**CPU 上限**。每完成 1 轮/分，数据库机器约用 1 个百分点 CPU。
- 数据库时间大头：`runtime_execution` 35%、`runtime_admit` 24%（并发时 600–970 ms；本机单用户只 7–25 ms）、`bill2_dispatch` 8.6%、
  `runtime_session_context` 8.3%、`bill2_claim` 7%、`bill2_record` 6.9%。
- 锁：precheck 事务持 90（本机最小 payload）–118（staging 真实回合）把关系锁，其中 69 把是索引——PostgreSQL 规划语句时锁住涉及表的全部索引，
  不管分支走不走。PG17 每连接 16 个快路径槽，超出进共享锁表，采样里 `LWLock:LockManager` 占 21–38%。
- staging 独有的两处失真：全站共用的测试窗口行（`runtime_test_window_allowed` FOR UPDATE，`bill2_payg_claim` 对窗口求和）让 admit 慢 4.3 倍；
  50 个压测账号共用让 `profiles` 行排队。正式形状没有这两项，但有全站止损锁 (201,1)（每次结算独占、每次冻结/发出共享）。
- 30 人并发教练失败 9–65%（随数据库"热度"），三个开关 0416/0418/0419 默认关、打开后无可测量改善（DB-PERF 窗口 10-27）。
- 提示缓存：导师真实调用缓存读 46%；自由对话、报告、评审团、对比 0%（缓存窗口 10-27，排除压测桩）。

### 1.4 根因排序

1. **证明重复**：权限/历史/范围/目录每轮重算，且在 admit、claim、dispatch、record、session_items 里各算一遍（1.2 节）。
   这是 CPU 的大头，也是锁的大头。做法上的原因：业务规则逐条叠加进 PL/pgSQL，每条新规则都"再查一次"，没有一个"本轮已证明"的载体。
2. **写入次数**：逐调用四步计费（claim/dispatch/record/finalize）+ 执行记录每步一写 + 会话历史独立写，一轮 10–20 次写事务，
   每次都锁同一个人的 `profiles` 行和止损账本行。
3. **读路径没有索引化的可见性**：历史可用性沿依赖链逐个祖先重算（`runtime_history_availability`→`runtime_direct_billing_allowed`），
   老账号准入 6–10 秒。
4. **删除检查按事件而不是按写入**：每 100 ms 一次往返（`executionStream.ts:240`），单项最大、最不固定。
5. **staging 与正式两条路径**：测试窗口、`staging_test` 合同、`productionPolicy`/`stagingPolicy` 分派、`runtime_production_allowed`——
   23 个 SQL 文件、30 个非测试 TS 文件。压测测的不是正式路径；正式路径（策略 7+N 次、自由对话跑两遍）压测里根本没跑过。
6. **提示缓存没按前缀设计请求体**：开场轮 `tools=[]`、历史标记受 8000 字节预留限制永远不生效、报告显式排除。

### 1.5 真正好的、必须保留的

- **BILL-PAYG 第七版的数学与不变量**：名义费用 n、q/m 冻结、G/H/L、`C+E=N` 守恒、收据幂等（payload hash）、402 不计费、未知成本 24 小时恢复、
  第三方工具未知 0 结算。全部保留，只改"什么时候写"。
- **回执是钱的证据、必须落盘后才交出正文**（BILL2 原要求）。保留。
- **DATA-ERASURE 的墓碑与投影设计**、注销执行器、内容删除预览/确认哈希（`accountErasure/content.ts:64-181`）。保留，改指新表。
- **0419 `catalog_versions` + `catalogCache.ts`**（DB-RW PR-B）：触发器版本号 + 进程内缓存，是新路径的目录层。保留并成为依赖。
- **Skill 包按内容哈希寻址、私密仓库 + 公开哈希**、`@openai/agents` runner、研究工具供应商适配层、Fusion 席位合并/引文核对的纯函数、
  prompt-cache-v2 的黄金字节测试思路、`packages/db/tests` 里 payg/erasure/stop-round/native-stop 这些**场景**（断言要按新 RPC 等效维护，场景一个不丢）。
- 0384 `runtime_read_verified`、0367 语句内 memo 的**思路**（"本轮已核验就不重算"）——新路径把它做成结构（`turns` 行就是载体），函数本身随旧路径删。

## 2. 目标架构：轻量 MVP 的主路径 v2

### 2.0 一句话

**一轮对话 = 一个 HTTP 流式请求 + 数据库里的"开轮、记账、收轮"三类写入 + 模型/工具调用之间不碰数据库。**
权限、历史、目录、Skill 包、策略这些"证明"在开轮时一次算清并随返回值带回 Node；之后只有钱的证据（每次调用的回执）
和最后的收轮才写库；删除检查搭在这些必经的写入上，不单独往返。

### 2.1 分层：什么放哪

| 关注点 | 放哪 | 为什么 |
|---|---|---|
| 身份与登录 | Node（Supabase Auth，一次 `auth/v1/user`，请求内复用） | 不变 |
| 准入（账号状态、墓碑、范围归属、Skill 绑定、模型可用、输入上限、会员门槛） | **数据库 `turn_open` 一次写事务** | 必须和"占住会话、冻结积分"原子；但只碰本轮自己的行 |
| 目录（系统设置、模型目录与价格、Skill 元数据与包文件、权益规则表、限流参数） | **Node 进程内缓存**，按 `catalog_versions` 失效（0419 已上库） | 全站只读、管理员写；每轮 3 组读 → 0 次往返 |
| 历史上下文 | 数据库 `session_messages`：按会话取最近 N 条可见消息；可见性在删除时维护，不在读取时重算 | 读路径一条索引查询 |
| 提示词拼装、缓存断点、输入裁剪 | Node 纯函数，黄金字节测试（2.9 节） | prompt-cache 原则 |
| 模型与工具调用 | Node（`@openai/agents` runner + OpenRouter）；工具白名单与每轮上限在进程内计数 | SDK 不换（Owner 10-20） |
| 钱的证据（每次模型/工具调用） | 数据库 `turn_calls` 一行，三步写：发出前 `turn_call_begin`、拿到供应商 id 时 `turn_call_identity`、结束时 `turn_call_record`（+ `turn_call_raw`）；begin/record 同一语句返回会话墓碑状态（2.5.2） | 发出前先留证据、崩溃后能按供应商 id 追成本（现有 dispatch/onIdentity 的等价物）；回执落盘后才把正文交出去；原始正文不进热表（3.3.2 第 9 条） |
| 结算、退款、追加历史、关闭回合、整理结果 | **数据库 `turn_close` 一次写事务** | 和"写入前照查删除"原子 |
| 暂停（余额不足/等用户）、24 小时自动退、评审团押金 | `turns.state` + 现有分钟级 `runtime-recovery` 定时任务（改读 `turns`） | 不新建队列（AGENTS 第 5 节） |
| 删除、注销 | 会话/消息打墓碑 + `turns` 可见性列；注销走 DATA-ERASURE 现有投影，改指新表 | 删除即时生效的语义不变 |
| staging 与正式的差别 | **没有代码分支**。差别只在配置：OpenRouter 密钥（测试密钥自带额度上限）、`OPENROUTER_BASE_URL`（压测指向桩）、`ai_models` 行价格快照、测试账号积分 | Owner 10-28 |

### 2.2 每轮状态机（`turns.state`）

```
opening ─(turn_open 成功)─→ running ─(每次调用后 turn_call_record)─→ running
running ─(用户点停止，仅 kind=report)→ stopping ─(turn_close kind=stopped)──→ closed
running ─(余额低于 L，多次调用的回合)→ paused(waiting_credits) ─(充值后用户点继续 = 新 turn_open(resume_of) / 24h 自动退)→ running | closed
running ─(评审团两组之间 / 等用户)→ paused(awaiting_user) ─(用户动作 / 24h 自动结束)→ running | closed
running ─(模型/工具出错，可恢复)→ running（SDK 内重试，不写库）
running ─(不可恢复错误 / 402 / 超时 / 白名单系统原因)→ turn_close kind=failed → closed（退未用冻结）
running ─(正常结束)────────→ turn_close kind=completed → closed
任何状态 ─(会话被删 / 账号注销 / 文风来源被删)→ 下一次写入（record 或 close）返回 tombstone → Node 立即中止，不保存正文，close kind=erased
```

- 状态只在 `turn_open` / `turn_call_record` / `turn_close` 三个函数里改，没有第四个入口（恢复定时任务也只调 `turn_close`）。
- **普通对话（chat、mentor）没有用户停止入口**（Owner 10-28）：前端没有按钮，服务端对这两种 kind 的停止请求返回 `TURN_STOP_NOT_ALLOWED`；
  只有 `kind=report` 有 `stopping` 状态。用户关掉页面不影响回合：服务端照常跑完、照常结算（和今天一样）。
- 没有"准备"和"执行"两个 HTTP 请求：一个 `POST /api/turn`（SSE，`maxDuration` 沿用 300）从登录核验到最后一个事件；
  前端"准备中"由第一个 SSE 事件 `opened` 给出，里面带本轮的工具可用性、冻结额、兜底资格（`fallbackEligible`）、被裁剪的内容说明。
- 评审团、对比、报告是同一个状态机的不同 `kind`，区别只在 `turn_open` 的冻结额和 `turn_close` 的结算口径（2.5 节）。
- 崩溃恢复：进程死在 `running`，`turns` 行留着；`runtime-recovery` 每分钟扫 `state='running' AND updated_at < now()-15min` 调
  `turn_close(kind=interrupted)`：已有最终回执的按回执结算；**已发出但没有最终回执的（`dispatched`/`identified`）不退、标 `cost_pending`，
  由恢复任务按供应商 id 追成本**（2.5.2）；只有连 `turn_call_begin` 都没写过的调用名额才退（和今天的 15 分钟过期 + 未知成本保留规则一致）。

### 2.3 一轮要碰数据库几次（目标）

自由对话（一次模型调用、无工具）：

| 步骤 | 往返 | 事务里碰到的表 | 锁 |
|---|---|---|---|
| 登录核验 | 1（Auth，不是 Postgres 函数） | — | — |
| `turn_open` | 1 | `sessions`（FOR UPDATE，本会话一行）、`turns` INSERT、`profiles`（FOR UPDATE，本人一行，毫秒级）、`session_messages` 读、`catalog_versions` 读、按 kind 读 `opc_drafts`/`artifact_versions` 一行 | 两把行锁，都是本人/本会话的，不等别人 |
| `turn_call_begin`（发出前） | 1 | `turn_calls` INSERT、`sessions` 读墓碑 | 无行锁 |
| 模型调用 | 0 | — | — |
| `turn_call_identity`（拿到供应商 id，不阻塞流） | 1 | `turn_calls` UPDATE 一行 | 自己的行 |
| `turn_call_record`（流结束） | 1 | `turn_calls` UPDATE、`turn_call_raw` INSERT、`sessions` 读墓碑 | 自己的行 |
| `turn_close` | 1 | `turns` UPDATE、`session_messages` INSERT ×2、`profiles` UPDATE（结算差额）、`credit_transactions` INSERT、`daily_spend` UPDATE、`sessions` UPDATE | 本人/本会话行锁 |
| 每请求固定：`catalog_versions_snapshot`、`platform_secret_read` | 2 | `catalog_versions` 读；平台密钥表读（OR-1，每次 fresh） | 无 |
| **合计** | **8**（含登录 1 + 固定 2；未确认定位的账号再 +2 定位检查；每次模型调用 3 次是钱的证据，2.5.2） | | |

定位导师一轮（两次模型调用、一次读 Skill 文件、整理一次模型调用）：`turn_open` 1 + 3 次模型调用 × 3 + Skill 文件 0（进程缓存，按包哈希校验）+
`turn_close` 1（整理结果同事务写 `opc_drafts`）= **11**，含登录 **12**；非开场回合另加开轮前 1 次只读（已确认卡片和对标表，Owner 2026-10-30 批准）= **12**。挂研究工具的回合每次工具调用 +2（begin + record，工具无流式身份）；对标工具按分批回执计数，每批 +2。
对比（N 模型并行）：1 + 3N + 1。评审团（3 席 × 1 轮 + 汇总）：1 + 12 + 1，两组之间以 `paused` 落地。
对比今天：自由对话 41、导师 61（10-27），且今天每轮没有一次是在等别人的锁；新路径的每次往返都只碰自己的行。

### 2.4 缓存规则：什么可以缓存、什么绝对不能

| 可以进 Node 进程内缓存（按 `catalog_versions` 失效，兜底 60 秒） | 绝对不缓存（每次现查现写） |
|---|---|
| `system_settings` 全部键（含限流参数、输入上限、价格倍率、q、L 公式参数） | 余额、冻结、grants、权益到期 |
| `ai_models` 目录、线路、价格快照、凭据指纹（密钥本身仍按安全规则每请求 fresh 读） | 会话/消息/账号墓碑、文风来源版本 |
| Skill 元数据、修订、包文件（按内容哈希寻址，永不过期） | 会话 revision、`turns.state` |
| 权益规则表（Pro/Gold 的数值与门槛表） | 某个用户当前的会员等级（请求内从 profiles 复用一次） |
| 提示词固定段的哈希（给缓存断点用） | 任何用户写入的数据 |

Redis 继续只做限流，不放状态（10-25 R1 结论不变）。

### 2.5 计费：一轮冻结一次、结算一次

沿用 BILL-PAYG 第七版的全部数学（q、m、U、L、G=ceil(q×U×m)、H=min(G,A)、名义费用 n、W、N、C+E=N 守恒），只改"什么时候写库"：

| 现在（v2 逐调用） | 主路径 v2 |
|---|---|
| 每次调用各冻结（claim）、各发出（dispatch）、各回执（record）、各结算（finalize） | **开轮冻结一次**：H=min(G_turn, A)，G_turn = Σ本轮允许的**模型调用**上界 + Σ允许的**付费工具调用**上界（两类次数上限分开列，见 2.5.3；免费工具本身 0 元，但它引起的模型续轮算模型调用）；固定价 kind 另加固定价；**每次调用三步写入**（发出前 pending 回执 → 供应商 id → 最终回执，2.5.2 节；这是钱的证据，不省）；**收轮结算一次**：N=ceil(q×Σn_i×m_i)，D=min(N,H)，退 H−D，E=N−D 平台承担并记账；固定价 kind 按交付判定结算（2.7 节） |
| 用户侧冻结和平台侧日限混在同一个数上 | **分开两个数**：`H`（积分，用户侧冻结，按上面的 G_turn）和 `U_turn`（美元，平台侧本轮供应商成本上界 = Σ本轮允许的每次调用上界 U_i，给 2.5.1 的日限预占用）。固定价 kind 的 H 和 U_turn 不相等（报告 H=500 积分+临时上界，U_turn=一次调用上界）|
| `profiles FOR UPDATE` 每次 claim 和 finalize | 开轮一次、收轮一次 |
| 止损锁 (201,1) 全站独占 | **去掉，改为"开轮预占、收轮回补"**（细则与证明见 2.5.1）：`turn_open` 先在 `daily_spend(day, bucket)` 自己的桶行上 `UPDATE … SET reserved=reserved+U_turn`（U_turn 是本轮冻结的成本上界，和 H 用的同一个数），再读全天 `SUM(reserved+spent)`，加上预留带 B 超过日限 L 就回滚拒绝；`turn_close` 在同一桶行 `spent=spent+n_total, reserved=reserved−U_turn`。**当日实际花费永远 ≤ L，超额为 0**；代价是接近日限时提前拒绝，提前量 ≤ B（staging 现配置约 15 美元）——第 8 节 3b 据此改述 |
| 多次调用的回合中途余额不够 | `turn_call_begin` 按 `turns` 自己的行判断（剩余冻结 H − Σ已记名义积分 < min(下一次调用上界, L)，不读 `profiles`，2.5.4）→ `paused(waiting_credits)`；充值后"继续"= `turn_open(resume_of=turn_id)` 只补冻结差额，不重复收费 |
| 未知成本 24 小时恢复、`cost_pending` | 调用已发出但没有最终回执（崩溃、断线、超时）→ 回执停在 `dispatched`/`identified`，**不退该笔的用户冻结、不释放该笔的日限预占**；`turn_close` 把它标为 `cost_pending`、`turns.settlement='pending'`；现有恢复定时任务按 `provider_id` 查供应商成本后再结一次（幂等）；查不到按 BILL2 §0.3 的现行规则处理（未知 ≠ 零；第三方搜索工具例外按 0 结算）。细则 2.5.2 |
| 停止退款 | 只有报告能停（Owner 10-28）：`turn_close(kind=stopped)` 仅接受 `kind=report`；滚动 24 小时内前 2 次 D=0 全退，第 3 次起 D=按回执、≤500（`turns(actor_id, kind, stopped_by_user, closed_at)` 索引数）。普通对话没有停止，用户离开页面回合照常结算 |
| 402 不计费 | 回执 `status='no_charge_402'`, n=0 | 
| 白名单系统原因失败自动退（10-12） | `turn_close(kind=failed, reason∈白名单)` 全退；其余按回执结算，每日对账照旧 |
| 暂停 24 小时自动退（10-25）、评审团押金 24 小时自动结束（10-27） | 同一个恢复定时任务：`state='paused' AND updated_at<now()-24h` → `turn_close(kind=expired)`，`delivered=false` 全退，评审团按已交付席位扣 |
| 幂等 | `turns UNIQUE(actor_id, request_id)`；`turn_calls UNIQUE(turn_id, seq)`；`turn_close` 对已 closed 的行原样返回；payload hash 比对保留 |
| 并发 | 同一会话同时只能一个 `running/paused` 的 turn（`sessions.active_turn_id` + FOR UPDATE）；同一账号不同会话可并行，各自在 `profiles` 行上排毫秒级的队 |
| 积分记录只显示实际变动（10-25） | 冻结不进 `credit_transactions`，记在 `turns.reserved_credits`；收轮写一笔净扣（D）与一笔平台承担（E，`kind='platform_absorb'`） |

#### 2.5.1 每日止损：开轮预占、收轮回补（回应 #1508 审查 P1）

旧设计只在收轮累加，开轮看不到在途回合，并发时超额没有上界。改法：

表 `daily_spend(day, bucket smallint, reserved_usd, spent_usd)`：`bucket 0–15` 按 `actor_id` 哈希分摊给普通回合（chat、mentor、review）；
`bucket=-1` 是"大额行"，只给单轮上界大的 kind（report、compare、jury）用，它们是 Gold 功能、量少，串行无妨。
目录缓存提供：日限 L；`P` = 数据库最大并发事务数（= 连接池大小，staging 现在 8，必须 ≥ 实际池大小）；
`U_fast` = 普通回合的单轮上界最大值（导师 2 次调用 + 整理，按 150000 字节输入、32768 输出和当前最贵普通模型算，约 1–1.5 美元）；
`U_big` = 大额 kind 的单轮上界最大值（评审团 4 席或对比 N 模型，约 5 美元量级）。预留带 `B = (P−1)×U_fast + U_big`。

`turn_open`（本轮冻结上界 U_turn，与 H 用的同一个数；**先锁自己的行，再读总和，再检查**）：

```
1. UPDATE daily_spend SET reserved = reserved + U_turn
     WHERE (day,bucket) = (今天, 我的桶 或 -1)            -- 行锁；同桶的后来者在这里排队
2. s := SUM(reserved+spent) FROM daily_spend WHERE day=今天   -- 已含自己；≤17 行索引读
3. IF s + B > L THEN RAISE STOP_LOSS_REACHED                   -- 整个事务回滚，预占自动撤销
4. turns.policy 记下 (day, bucket, U_turn)；事务继续做其余开轮工作
```

`turn_close`（含恢复定时任务的 close，幂等）：
`UPDATE daily_spend SET spent = spent + n_total, reserved = reserved − U_turn WHERE (day,bucket) = policy 里记的那一行`。
跨天收轮回补的仍是开轮那天的行。

**上界证明**（读已提交隔离级别）：
- 第 2 步在拿到自己行锁之后读，所以 s 包含此刻所有**已提交**的预占和花费，以及自己的。它漏掉的只有此刻**未提交**的其他开轮事务的预占。
- 同时在数据库里的事务不超过 P 个（连接池），除自己外 ≤ P−1 个；其中走 `-1` 行的最多 1 个（那一行串行），其余 ≤ P−2 个走普通桶。
  所以漏掉的总额 ≤ (P−2)×U_fast + U_big ≤ B。
- 第 3 步要求 s + B ≤ L。因此任一开轮事务提交时，全天 `SUM(reserved+spent)`（含所有当时未提交、之后会提交的）≤ L。**预占总额永远 ≤ L。**
- 实际花费 n_total ≤ U_turn（U 就是 BILL2 的单次上界，H=min(G,A) 用的同一个数），所以任何时刻 `spent ≤ reserved`，**当日实际花费 ≤ L，超额为 0**。
- 代价（如实）：接近日限时会**提前拒绝**，提前量 ≤ B + 在途回合的 (U_turn − 实际花费)。按 staging 现在 P=8、U_fast≈1.5、U_big≈5 算，B ≈ 15.5 美元；
  P 调到 20 时 B ≈ 33.5 美元。这是保守方向，不是损失；B 相对 L 的占比随 L 调大而变小（3.3.3 扩容前检查：L ≥ 10×B）。
- 热点：普通回合各锁自己桶的一行（16 行分摊，3.3.2 第 1 条）；`-1` 行只有 Gold 的大额 kind 用，量少且本来就按席位串行调用，不是扩容热点。
- 连接池调大时必须同步调大 P（配置）；P 小于实际池大小证明就不成立，所以 `turn_open` 在 P < 当前池大小时直接拒绝开轮（池大小由目录里的一个设置键声明，上池时先改键）。
- 回合崩溃不收轮：预占会一直占着，直到恢复定时任务 15 分钟内 `turn_close(kind=interrupted)` 回补。注销、删除同样经 `turn_close` 回补。
- 桶数 16 不进证明（证明只依赖 P），它只决定普通回合的锁分摊；不够时改常量 + 一个迁移。

和旧机制的对应：旧 (201,1) 锁保证"按天止损准确"；新机制保证同样的事（实际 ≤ L），并且把"并发时谁先谁后"从全站一把锁变成普通回合 16 行分摊 + 大额 kind 一行。

#### 2.5.2 一次调用的生命周期：发出前留证据、结果不明不重试、未知成本进恢复（回应 #1508 审查 P1-②③）

每次付费调用（模型、研究工具）在 `turn_calls` 里有自己的一行，状态机：

```
turn_call_begin  →  dispatched ─(供应商返回 generation id，首个事件/响应头)→ identified ─(流结束，拿到 usage/cost)→ ok
                                                                                       └─(断线/超时/进程死)→ unknown（cost_pending）
                    dispatched ─(请求确定没发出去：连接被拒、DNS 失败、请求体没写完)→ not_sent（n=0，可重试一次）
                    dispatched/identified ─(供应商明确拒绝且确定不计费：402、429、5xx 且没有任何正文字节、没有 generation id)→ rejected（n=0，429/5xx 可退避重试一次）
```

三步写入（每次模型调用 3 次往返，研究工具 2 次；**如实计入 2.3 和 3.1 的预算**，不是"一条回执"）：

1. **`turn_call_begin`（发出前，1 次）**：插入 `turn_calls(turn_id, seq, call_kind, model/tool, request_hash, upper_usd U_i, status='dispatched')`，
   同一语句返回会话墓碑状态。没有这一行，Node 不许发请求（静态扫描：对 OpenRouter/供应商的 fetch 必须在 `turn_call_begin` 之后）。
   这就是现有 `bill2_dispatch` "发送前持久化"的等价物。
2. **`turn_call_identity`（拿到供应商 id 时，1 次，不阻塞流式输出）**：`UPDATE … SET provider_id, status='identified'`。
   等价于现有 `onIdentity` 提前保存 generation id（`bill2/service.ts:255`）；崩溃后恢复任务靠它去查成本。
3. **`turn_call_record`（流结束，1 次）**：写 usage、n_i、c_i、缓存 token、`status='ok'`，同事务写 `turn_call_raw`；同一语句再次返回墓碑。

规则（和现有 BILL2 一致，一条不放松）：

- **SDK 内不重试**：runner 保持 `retry:{maxRetries:0}`、OpenAI 客户端 `maxRetries:0`（现 `runner.ts:195,213`），调用策略 `automaticRetry:false`。
- **只有两种失败允许重试**：`not_sent`（确定没发出）和 `rejected`（确定不计费）。每次尝试都是 `turn_calls` 里独立的一行（自己的 seq），
  n=0、U_i 不计；同一逻辑调用最多 2 次尝试。`unknown`（发出后结果不明）**永不重试**，交恢复任务。
- **U_turn 的证明不受影响**：U_turn = Σ 本轮允许的逻辑调用的 U_i；一个逻辑调用在任何时刻最多有一次"可能产生费用"的尝试
  （`not_sent`/`rejected` 的尝试确定为 0，`unknown` 之后不再有新尝试），所以本轮供应商实际成本 ≤ Σ U_i = U_turn，2.5.1 的 `spent ≤ reserved` 仍成立。
- **未知成本不退、不释放**：`turn_close` 遇到 `dispatched`/`identified`（没有最终回执）的调用：标 `unknown, cost_pending=true`；
  该笔对应的用户冻结份额（min(G_i, 剩余 H)）和日限预占 U_i **都保留**，其余已知调用正常结算；`turns.settlement='pending'`。
  恢复定时任务按 `turn_calls(cost_pending)` 索引找活，用 `provider_id` 查供应商成本（现有 lookup 路径）；查到→按 n/c 结算并释放多余预占；
  按现行规则到期仍查不到的，沿 BILL2 §0.3（未知 ≠ 零，不推定失败、不重发）和 Owner 10-25/10-27 的 24 小时规则处理；
  **第三方搜索/社媒工具例外**（Owner 10-13）：对用户按 0 结算、释放用户冻结，供应商成本记 `cost_pending`，日限预占到成本确认或 24 小时后释放。
- 现有 `streaming.integration.ts` 的"断线保留供应商 id 与冻结、不发第二次 POST、不零退"场景原样迁入 V2-4 的验收。

#### 2.5.3 每种回合允许几次模型调用、几次工具调用（G_turn 与 U_turn 的来源；回应 #1508 审查 P2）

工具分两种：**付费工具**（研究工具：社媒搜索/账号取数/网页搜索/抓取，按供应商计费，Owner 10-13/10-17）和**免费工具**（读资料库 `read_source`、加载 Skill
`load_skill`、读 Skill 文件、读自己的作品数据——对用户 0 元，但每次工具返回后模型要再跑一次来消费结果）。
**每一次工具返回都引起一次模型续轮**，所以模型调用次数上限 = 1 + 允许的工具轮数（付费 + 免费），不管工具本身收不收费。
现有 `runnerRetrieval.test.ts`"两次资料库读取、三次模型请求"就是这种情况，新路径把它写成规则：

| kind | 模型调用上限 M（每次上界 U_model，按 kind 的模型与输入上限算） | 付费工具上限 T_paid（每次上界 U_tool） | 免费工具上限 T_free | G_turn / U_turn |
|---|---|---|---|---|
| chat（自由对话） | M = 1 + T_paid + T_free；T 按现有规则：研究 3 次（含子调用 12 次）、加载 Skill 2 次、资料库/作品读取 2 次 → **M ≤ 8**；没挂研究工具时 M = 1 + T_free ≤ 5 | 3（子调用 ≤ 12，计入 U_tool） | 4（Skill 2 + 读取 2） | G_turn = M×U_model(credits) + Σ U_tool；U_turn = M×U_model(usd) + Σ U_tool(usd) |
| mentor（定位导师） | 导师 2 次 + 整理 1 次 + 工具续轮：读 Skill 文件来自进程缓存**不计模型续轮**（它在同一次 SDK 调用里完成，不发新请求，现状如此）；挂研究工具时 +T_paid → **M ≤ 3 + T_paid** | 按对标步骤规则（发现/核对各自上限） | 读 Skill 文件不计 | 同上 |
| report | 1（续写不做，10-07） | 0 | 0 | 用户侧 H = 500 积分 + U_model；U_turn = U_model |
| compare | N（所选模型数，各自 U_model） | 0 | 0 | 各模型各自 G；用户合计 ≤ 500 积分 |
| jury | 每组席位数 + 汇总 1，按 maxRounds | 0（评审不联网） | 0 | 用户侧 H = 1500 + 当前组 Σ U_model；U_turn = 全部组 Σ U_model |
| review（上线后） | 同 chat | 同 chat | 同 chat | 另受 1 美元成本上限 |

- 这些数都是目录里的配置（现有 `maxCalls`、`FREE_CHAT_RESEARCH_CALLS=3`、`load_skill` 每轮 2 次、`read_source` 每轮 2 次），`turn_open` 读出来算 G_turn、U_turn 并冻结进 `turns.policy`；
  Node 在运行时按同一份上限计数，到上限就不再把工具挂给模型（现有 `runnerRetrieval` 的"最后一次允许的调用后不再提供工具"规则不变）。
- 2.5.1 的证明以此为准：U_turn 是本轮**所有**可能产生供应商费用的调用（模型续轮 + 付费工具）的上界之和，免费工具引起的续轮在 M 里。
- 余额不够 G_turn 时：开轮按 H=min(G,A) 冻结，运行中 `turn_call_begin` 发现剩余冻结 < min(下一次调用上界, L) → `paused(waiting_credits)`（2.2）；冻结被余额封顶时，超出 H 的部分按 D=min(N,H) 由平台承担，不向用户补扣（Owner 10-01），不会负余额。

#### 2.5.4 两种"冻结"不是一回事：实预扣 vs 逻辑预留（回应 #1508 审查 P1）

| | 用户侧积分冻结 H | 平台侧日限预占 U_turn |
|---|---|---|
| 怎么做 | `atomic_pre_deduct(actor, H, …)`：**真的从 `profiles.credits` 里扣掉**（`credits = balance_before − p_amount`），`billing_history` 留预扣记录 | `daily_spend.reserved_usd += U_turn`：只是一个计数，不碰任何余额 |
| `turns` 里记什么 | `reserved_credits = H`：**只是"已经预扣了多少"的记录**，收轮时用来算退多少（退 H−D）；**可用余额永远不再减它** | `policy.upper_usd = U_turn`：收轮回补用 |
| 可用余额 A 怎么算 | 现有 `credit_available`：`profiles.credits` − 隔离的赠送余量 − 退款包 hold − 拒付 pending hold（现有算法一条不改）。因为预扣已经在 `credits` 里扣掉了，**不减 `turns.reserved_credits`**；否则余额 1000、冻结 400 会被算成 200 而不是 600，同一账号的其他会话会被错误拒绝 | 不参与 A |
| 回合中途"够不够" | 只看 `turns` 自己的行：`H − Σ已记名义积分 ≥ min(下一次调用上界, L)` 否则 `paused(waiting_credits)`；**不读 `profiles`** | `turn_call_begin` 不再碰 `daily_spend`（预占在开轮一次做完） |
| 收轮 | `turn_settle_credits`：结算 D、退还 H−D 到 `profiles.credits`，守恒 `restored + D = H` | `spent += n_total, reserved −= U_turn` |
| 崩溃/未知成本 | 该笔份额留在预扣里（2.5.2），`turns.reserved_credits` 不变，直到恢复任务结算 | 同 2.5.2 |

验收（V2-3 套件）："**冻结只影响可用余额一次**"：余额 1000 的账号开一轮 H=400 → `profiles.credits=600`、`credit_available=600`；
同一账号另一个会话此时 `turn_open` 看到的 A 是 600（不是 200）；收轮 D=150 → `credits=850`、流水只有一笔 −150。
退款包 hold、拒付 pending hold 的现有算法和测试原样保留。

### 2.6 历史与删除

- `session_messages(session_id, seq, role, turn_id, content, content_hash, visible, deleted_at)`：收轮时追加用户消息和助手回复；
  历史 = 最近 N 条 `visible AND deleted_at IS NULL`，再按输入上限裁剪（Node，裁剪算法不变、只前进不后退）。
- 可见性在**写入时**维护：删除对话 → `sessions.deleted_at`（一条 UPDATE）；撤销来源/归档业务/删文风来源 → 对应消息 `visible=false`
  （一条按 `turn_id` 的 UPDATE，由现有的删除入口调）；注销 → DATA-ERASURE 投影对三张新表各加一条规则。不再有"祖先执行逐个重算权限链"。
- 流式输出中的删除检查（Owner 10-27"按阶段查、存结果前照查"）：搭在 `turn_call_begin`、`turn_call_record` 和 `turn_close` 上——每次调用前后的写入同一语句返回
  `session_tombstoned`、`voice_source_revoked`，Node 收到即中止；正文最后由 `turn_close` 写入前再查一次。零额外往返。
  正在出字的那段文字最多多显示到本次模型调用结束（自由对话即整轮），比 10-27 批准的"按阶段"略粗；写入前一定拦住。
- 长对话删除超时（核心 7②）：删除只打墓碑即返回；正文清理由现有 `content_erasure_sweep_sessions` 分批做。

### 2.7 研究工具、Skill、报告、评审团、对比：同一条核

| 路径 | 开轮差异 | 中间 | 收轮差异 |
|---|---|---|---|
| 自由对话 | kind=chat；工具白名单按会话固定（2.9 第 2 条）；输入上限 90000 / 挂研究工具 150000；模型/付费工具/免费工具次数上限分开（2.5.3，免费工具的续轮计入 G_turn）；定位前置检查（Decisions）是回合内第一次调用（`call_kind='decision'`，begin + record 两步）：**用户不计费**（回执 `charge_user=false`，n 对用户为 0，Owner 10-12），但**平台侧 U_i 是 Decisions 模型的真实单次上界**（不是 0），计入 U_turn 和日限预占，供应商成本照记 | SDK 工具循环；每个工具一条回执（免费工具 n=0，但其后的模型续轮照常三步写）；容量不够时去掉的是"工具可用性说明"（进 user 消息）而不是工具定义，并在 `opened` 事件里明说（修核心缺陷：静默丢工具仍计费） | 按回执结算 |
| 定位导师 | kind=mentor；Skill 包从缓存按 module→revision→packageHash 取；hostTurnContext 由 `turn_open` 返回的草稿摘要拼；`fallbackEligible` 按轮次计数算好返回（修核心缺陷：兜底卡从未显示） | 两次模型调用 + `read_skill_file`（进程缓存，不计费、不写库）+ 整理调用 | 整理结果与研究轮次计数在同一事务写 `opc_drafts`（替代 `opc_capture_apply` 独立往返）；对标工具的 `research_*` 派生行也在收轮同一事务写（Owner 2026-10-30 选 A） |
| 报告 | kind=report；冻结固定 500（+ 本次调用临时上界）；会员/草稿/确认/价格一致（`acceptedCredits`）检查搬进 kind 分支 | 一次长调用（32768 输出上限，不续写） | 成功 D=500；停止按 24 小时规则；结果写 `artifact_versions`（不变） |
| 对比 | kind=compare；G_turn=Σ各模型上界，用户合计上限 500 积分，超则拒开轮；Gold 门槛 | N 个并行调用各一条回执 | 各模型各自取整 |
| 评审团 | kind=jury；**用户侧冻结 = 固定价 1500 积分 + 当前这一组调用的临时上界**（10-17 规则）；平台侧 U_turn = 全部席位与汇总调用的成本上界之和（给 2.5.1 的日限用）；Gold 门槛；同版本 3 次未完成则拒 | 席位调用各一条回执——**只记供应商成本和名义费用，用于平台记账与报表，不按席向用户收费**；格式不合格 `status='unusable'`；每组结束后释放该组临时上界、下一组开始前再冻结下一组的（10-13 规则）；两组之间 `paused(awaiting_user)` | **用户按固定价结算，交付判定沿用 `fusion_review_fee_settle_internal`**：拿到可用修订稿（汇总判定 usable 或 outcome=revised）→ 扣固定价；无需修改（no_change）、修订失败、未完成 → 全退；中断或 24 小时自动结束 → 扣 min(固定价, 已发出调用的已知名义用量折算积分)，其余退（现有 `stopped/interrupted` 分支，也是 10-27"已交付部分按实际扣、未用押金退"的落实）；采纳后重定稿走 R14，不开回合（不加费、不调用模型、可反复修改，10-20） |
| 周复盘（上线后） | kind=review；定时任务代替用户发起；G_turn 由 1 美元换算 | 同自由对话 | 同自由对话 |

### 2.8 staging = 正式

- 删除 `runtime_test_windows` 表、`mode='staging_test'` 合同、`runtime_test_window_allowed`、`runtime_test_policy`、`runtime_test_*`/`runtime_production_*` 9 个函数、
  `productionPolicy.ts`/`stagingPolicy.ts` 分派，以及 `runtime_payg_staging`/`runtime_payg_production` 两份档案——只留一份 `runtime_payg` 档案键：
  内容格式沿用现在的正式档案（`paygProductionSettings`：线路、用途、请求格式、思考档位、容量、采样证据、`enabled` 一键关闭），**没有** `windowId` 和到期日；
  报价由 `ai_models` 价格快照 + q/m 推导（`services/turn/quote.ts`，V2-4），不调 `runtime_production_access`，不查测试窗口。
  staging 与正式库的建库种子都要有这一行（键名、结构相同，值各自配）；键缺失或 `enabled:false` 时 `turn_open` 拒绝开轮，不退回任何旧路径。
- 花费控制：OpenRouter 测试密钥在 OpenRouter 后台设额度上限；测试账号积分由总控按批准预算发放；每日对账报表照旧。
- 保留一条最小"防串库"校验：部署声明的 Supabase 主机必须等于实际连接的主机，否则拒绝开轮。这是防串库，不是两套路径。
- 压测与 e2e 的"假 AI 回复"不再是代码分支：`OPENROUTER_BASE_URL` 指向压测桩进程（`scripts/loadtest/openrouter-stub.mjs`），同一份代码。
  桩生成的回执 `generationId` 以 `gen-load-` 开头（财务报表排除，缓存窗口的建议）。

### 2.9 提示缓存：新路径必须保住的 8 条（Owner 项 35：上线必做；原则来自缓存窗口 10-28 交接）

这 8 条是**请求体拼装层的硬约束**，写进 V2-4 的验收和黄金字节测试：

1. 顺序固定：工具定义 → 系统提示 → 历史 → 当前消息。
2. 工具列表跨轮不变：同一会话里不按轮增减工具；开场轮要禁止调用就用 `tool_choice:"none"`（#1504 已放行）。
   因此 `turn_open` 返回的工具白名单按会话 kind 决定，不按本轮容量决定。
3. 系统提示 = 全站共用段（品牌声明、SKILL.md、固定规则）+ 按用户稳定段（回复语言、工作区说明、文风），各一个断点；
   每轮会变的（清单状态、步骤、材料修订号）一律放当前 user 消息。
4. Skill 文本里 SKILL.md 排在步骤资源前面，换步骤只重写后半段。
5. 历史投影确定性：旧消息换占位时只取决于那条消息自己（`content_hash`）；裁剪只前进不后退；第三个断点放"当前消息之前最后一条纯文本历史"。
6. 当前 user 消息上不打断点、不用顶层自动缓存；最多 4 个断点，用 3 个。
7. Sonnet/Opus 5.5 最小 512 token、5 分钟 TTL、读 0.1×（官网 0.05×，以回执为准）、写 1.25×；盈亏点 22%。1 小时 TTL 不做（项 43）。
8. 复核用 #1503 脚本（排除压测桩）；目标导师和自由对话缓存读占输入 ≥ 50%（基线导师 46%、自由对话 0%）。

对数据模型的直接影响：`session_messages.content_hash`（第 5 条）；`turns.policy` 冻结工具白名单与 system 两段哈希（黄金字节测试）；
`turn_calls.cache_read_tokens/cache_write_tokens`（第 8 条）。

## 3. 每轮性能预算与 100 人验收

### 3.1 预算（每个主路径 PR 都要过；`scripts/check-turn-budget.mjs` 在本机 Docker 库 + 桩模型上实测并断言）

| 指标 | 自由对话 | 导师一轮 | 报告 | 测法 |
|---|---|---|---|---|
| Postgres 往返——回合自己的（不含 Auth 和 OpenRouter；每次模型调用 3 次、工具 2 次是钱的证据，2.5.2） | ≤ 5（无工具）；每多一轮免费工具 +5（工具 2 + 续轮 3），上限 M 按 2.5.3；未确认定位的账号另 +2（定位检查 begin/record） | ≤ 11；非开场回合 ≤ 12（Owner 2026-10-30 批准，开轮前 1 次只读）；账号策略草稿 ≤ 13（Owner 2026-10-31 批准，收轮前 1 次复查来源） | ≤ 5 | 计数的 Supabase 客户端包装，跑三条标准回合（无工具自由对话、导师、报告）后断言；工具回合另按 2.5.3 公式断言 |
| Postgres 往返——每个请求固定的 2 次 | `catalog_versions_snapshot`（0419，目录缓存的版本检查）+ `platform_secret_read`（OR-1：平台密钥每次 fresh 读，安全规定不动） | 同 | 同 | 单独一行计数、固定 = 2；V2-4a 本机实测自由对话合计 7（已定位）/ 9（未定位），今天 41 |
| 每轮数据库时间（本机 Docker，单用户） | ≤ 60 ms | ≤ 120 ms | ≤ 60 ms | `pg_stat_statements` 前后差 |
| `turn_open` 事务内关系锁数——主路径自己的表（`turns`、`runtime_sessions`、`profiles`、`daily_spend`、`session_messages`、墓碑表及其索引/TOAST） | ≤ 42（V2-3 本机实测 18；Owner 2026-10-31 批准，只许变小） | ≤ 42 | ≤ 42 | 事务内不提交时数 `pg_locks`（db-rw-c 套件办法），按表归类 |
| `turn_open` 事务内关系锁数——账本叶子（`atomic_pre_deduct`、`credit_available` 碰到的 grants/积分包/订单/账单表） | 棘轮：只许变小（V2-3 本机基线 38，其中 `bill2_runs` 9 把来自 `billing_history` 的注销账本守卫触发器，V2-12 改读 `turns` 后消失） | 同 | 同 | 同上，单独一行记录；口径和 7.1"账本叶子不展开"一致。合计（本机 56）也记录，对比今天的 90–130 |
| 按回合类型统计的单个主路径函数静态可达函数 / 表（Owner 2026-10-31 批准；`research_turn_apply` 单列） | ≤ 15 / ≤ 18 | 同 | 同 | 静态闭包脚本（架构窗口 10-27 的脚本进仓库 `scripts/db-function-closure.mjs`） |
| 行锁 | 0 把全站共用行锁；只允许本人 `profiles`、本会话 `sessions` | 同 | 同 | 静态扫描 `FOR UPDATE|FOR SHARE` 对象白名单 |
| 热表无顺序扫描 | 0 | 0 | 0 | 三条回合 + 定时任务认领语句的 `EXPLAIN`，对 `turns`/`turn_calls`/`session_messages`/`credit_transactions`/`runtime_sessions` 断言无 Seq Scan |
| 全站共用行的写/锁 | 0（止损的大额行 `bucket=-1` 除外，只给报告/对比/评审团） | 同 | 同 | 静态扫描：`UPDATE`/`FOR UPDATE` 只许白名单表，WHERE 必须带所有者键或 bucket |
| 会话级状态 | 0 | 0 | 0 | 静态扫描：禁止 `pg_advisory_lock(`、非 LOCAL `SET `、`CREATE TEMP` |
| 回执与结果的容量（和现有一致，`bill2/responseCapacity.ts`） | 完整响应接收 ≤ 532480 字节；持久化原始回执 ≤ 4194304 字节，存 `turn_call_raw` 不进 `turn_calls`；最终展示结果 ≤ 262144 字节；单次输出 32768 token | 同 | 同 | 现有 `mentorOutput.test.ts`（含 reasoning 的完整响应）等边界测试迁入；合法响应在记账时不许失败 |
| 首字延迟（服务端，收到请求→第一个模型字节，桩零延迟） | p95 ≤ 400 ms | p95 ≤ 600 ms | — | 桩模型 |
| 每轮核·秒 k（本机单机压测，500/2000/5000 虚拟用户） | 不随人数变化（±15%）；锁等待占比 < 2% | 同 | — | 3.3.3 节 |
| 100 人并发（staging Micro，桩模型，10-25 节奏） | 失败 0、57014 0、整轮 p95 ≤ 桩回复时间 + 2 s、CPU 平均 < 60%、交换区不涨、`LWLock:LockManager` < 2% | 同 | — | 3.2 节 |

### 3.2 100 人验收怎么跑才公平

1. **环境**：staging（Micro、连接池 8、Redis us-west-2）；`OPENROUTER_BASE_URL` 指向压测桩（固定 1.5 秒首字、每 50 ms 一段、约 6 秒回复；教练第二次调用约 4 秒），不花模型钱。
2. **账号**：100 个独立测试账号（不是 50 个共用），每批前用脚本重置为新账号（注册 + 发测试积分），避免 `profiles` 行争用和历史长度漂移。
3. **节奏**：10-25 的混合（自由对话:教练:资料库 = 5:3:2），每人回复后等 7–22 秒，每档 2.5 分钟含 10 秒爬坡。
4. **档位与顺序**：30 → 50 → 75 → 100 → 50（回归）→ 100（复测）；每档之间**冷却 10 分钟**（Micro 突发额度恢复、交换区回落）；
   每批先跑一次 30 人基线，和上一批 30 人基线差 >10% 判本批无效（Micro 突发额度漂移）。
5. **采样**：每 5 秒 `pg_stat_activity` 等待事件、`pg_locks` 按 locktype 计数；Supabase 报表 CPU/内存/交换区；应用日志里每轮往返计数。
6. **通过线**：3.1 节最后一行；达不到就按实测写"最多撑多少人、差多少"，不说做到了。
7. **对照**：切换前用同一桩、同一账号池对现有路径跑一次存档（`docs/validation/core-path-v2/baseline-old-path.md`）。
8. 正式库连接池按复测结果定，上线前问 Owner（10-24 待办不变）。

### 3.3 扩容到 500 / 2000 / 5000 并发不用再重构（Owner 10-28 要求）

实话先说：**代码结构能保证的是"扩容时只加规格、改配置、做一次数据搬家，不改业务代码"；它不能保证 Micro 撑 5000 人**。
5000 人要买更大的数据库，这是钱的事，不是重构的事。下面把"只靠加钱"和"现在就要做对"分开写清。

#### 3.3.1 容量模型（估算，依据和不确定性见 3.3.3）

单位和依据：
- 今天：staging 实测每完成 1 轮/分 ≈ 占数据库机器 1 个百分点 CPU（10-26 第三轮），折合每轮约 **1.15 核·秒**（2 核）。
- 新路径目标：每轮数据库时间 ≤ 60–100 ms（3.1 节）。`pg_stat_statements` 不含连接、PostgREST、JSON 编解码和共享核抖动，
  按 **3 倍保守系数**取每轮 **0.25 核·秒**（比今天少 4.6 倍；若实测更接近 0.1 核·秒，下表人数再乘 2.5）。
- 节奏：压测节奏每人 0.93 轮/分（回复后 7–22 秒再发）；真人节奏按每人 0.3 轮/分估（约 3 分钟一条，**没有实测，上线后用正式数据替换**）。
- 数据库 CPU 目标占用 60%（留尖峰）。

| 规格（Supabase，以其价格页为准） | 核 | 内存 | 每分钟可完成轮数（0.25 核·秒/轮，60%） | 压测节奏可撑人数 | 真人节奏可撑人数 |
|---|---|---|---|---|---|
| Micro（现在） | 2 共享 | 1 GB | ≈ 290 | ≈ 300 | ≈ 950 |
| Small / Medium | 2 共享 | 2 / 4 GB | ≈ 290（内存多，交换区压力小，更稳） | ≈ 300 | ≈ 950 |
| Large | 2 专用 | 8 GB | ≈ 430 | ≈ 450 | ≈ 1400 |
| XL | 4 专用 | 16 GB | ≈ 860 | ≈ 900 | ≈ 2900 |
| 2XL | 8 专用 | 32 GB | ≈ 1700 | ≈ 1800 | ≈ 5700 |
| 4XL | 16 专用 | 64 GB | ≈ 3400 | ≈ 3700 | ≈ 11000 |

结论：
- **100 人**：Micro，目标是 CPU < 60%（今天 100 人是 66–89%，且是 CPU 上限）。
- **500 人**：真人节奏 Micro 够（有余量）；压测节奏要 Large。
- **2000 人**：真人节奏 Large–XL；压测节奏 2XL。
- **5000 人**：真人节奏 2XL；压测节奏 4XL。此外只读副本（历史页、积分记录、后台报表）把主库的读分走，主库只剩每轮 5–11 次小写入——这是配置，不是代码。
- 其他资源在同样人数下够不够（都是配置/钱）：
  - **数据库连接**：每轮只在 3 次 RPC 里各占连接几十毫秒，5000 人真人节奏 ≈ 25 轮/秒 × 0.1 秒 ≈ 2.5 条连接常驻，Supavisor 事务模式池 15–20 绰绰有余。
    前提是函数不依赖会话状态（3.3.2 第 6 条）。
  - **写入量与存储**：每轮约 6 行、约 15 KB（两条消息 + 回执用量；原始回执另存，见 3.3.2 第 9 条）。5000 人真人节奏 ≈ 1500 轮/分 ≈ 22 MB/分 ≈ 30 GB/天；
    原始回执 30 天清理、删除的会话正文分批清理（已有规则）。Micro 磁盘 IO 基线低，1000 人以上要看 IOPS，升规格同时升磁盘（配置）。
  - **Vercel**：每轮一个函数实例流式占用模型时长（10–60 秒）；Fluid compute 下流式是 IO 等待，不占 CPU；并发上限按套餐（Pro → 更高档），
    是套餐/配置。前提：流式期间不占数据库连接（新路径成立：调用之间不碰库）。
  - **OpenRouter / TikHub 等供应商**：按密钥限速和余额；需要按模型/供应商的并发上限和 429 退避（3.3.2 第 10 条，代码现在做）；额度是钱。
  - **Redis（Upstash）**：限流和并发计数的 QPS 按套餐；配置。

#### 3.3.2 现在就必须做对的结构点（逐条对照新设计）

| # | 结构点 | 新设计是否满足 | 要补/要守的 |
|---|---|---|---|
| 1 | **没有任何全站共用的热点行（写）** | `profiles`（按人）、`runtime_sessions`（按会话）、`turns`/`turn_calls`/`session_messages`（按轮）✓；`catalog_versions` 只读 ✓；**`daily_spend` 原设计单行 ✗ → 改为 `(day, bucket 0–15)` 16 行按 actor 哈希分摊，开轮预占、收轮回补（2.5.1）**：开轮和收轮各更新自己桶的一行。5000 人真人节奏 25 轮/秒 × 2 次更新分到 16 行 ≈ 每行 3 次/秒，每次持锁 < 1 ms，占用 < 0.3%。`-1` 大额行只给 Gold 的报告/对比/评审团用，量少、本来就串行；桶数不够时只改常量和一个迁移，不改逻辑 | 7.1 静态扫描：主路径 SQL 里 `UPDATE/FOR UPDATE` 的表只能是白名单，且 WHERE 必须带 actor/session/turn/bucket 键（`bucket=-1` 只允许大额 kind 使用） |
| 2 | **所有锁按用户或会话** | `turn_open`：`runtime_sessions FOR UPDATE`（本会话）、`profiles FOR UPDATE`（本人）；`turn_close` 同；无 advisory 锁 ✓ | 禁止 `pg_advisory_lock`（会话级）；事务级 `pg_advisory_xact_lock` 也不用（没必要） |
| 3 | **幂等键** | `turns UNIQUE(actor_id, request_id)`、`turn_calls UNIQUE(turn_id, seq)`、`session_messages UNIQUE(session_id, seq)`、`turn_close` 重复调用原样返回、回执 payload_hash ✓ | 幂等键都带所有者列，为第 4 条服务 |
| 4 | **大表将来能按所有者分区，不改代码** | 主键改为复合：`turns (actor_id, id)`、`turn_calls (turn_id, seq)`、`session_messages (session_id, id)`；`id` 用 bigint identity（时间有序、紧凑）；所有查询都带所有者键（没有"按 id 全表找"的查询）；`credit_transactions` 已有 `user_id`。将来按 `HASH(actor_id)` / `HASH(session_id)` / `HASH(turn_id)` 分区：唯一键都含分区列，PostgreSQL 直接支持；转换是一次运维搬家（建分区表、搬数据、改名），不改任何 SQL 函数或 Node 代码。时间列（`opened_at`/`created_at`）单独建索引，供保留期清理按时间批量删 | V2-2 的迁移注释写明分区方案；7.1 静态扫描：主路径 SQL 对这四张表的 WHERE 必须带所有者键 |
| 5 | **读写分离将来能接上** | 主路径三类写入必须走主库；`turn_open` 内的历史读也在主库（和墓碑同一事务）。可以走只读副本的：会话列表、历史消息展示、积分记录、报告阅读、后台报表、发布监测数据、e2e/压测分析 | V2-4 加 `readClient`/`writeClient` 两个客户端接缝（今天都指主库，上副本时只改环境变量）；路由层按"读展示 / 写回合"分别用 |
| 6 | **Supavisor 事务模式兼容（不依赖会话状态）** | 新函数都是单次调用单事务；不用 `SET`（只允许 `SET LOCAL`）、不用会话级 advisory 锁、不用临时表、不用预编译语句跨调用；0367 的 memo 用事务内 `set_config(..., true)` 也可以不要（新函数没有重复子检查）✓ | 7.1 静态扫描：主路径 SQL 禁止 `pg_advisory_lock(`、非 LOCAL 的 `SET `、`CREATE TEMP`；Node 侧不开长连接 |
| 7 | **后台定时任务按批、可并行、可水平扩展** | `runtime-recovery`、内容清除、未知成本补结：`SELECT … FOR UPDATE SKIP LOCKED LIMIT 50` 认领，每批处理完提交，按时间预算循环；两个实例同时跑不重复、不冲突；处理函数幂等（都是 `turn_close`）；按部分索引 `(state, updated_at)` 找活，没有全表扫 | V2-8/V2-9 的验收含"双实例并行不重复"；Vercel cron 以后可改为多区域或外部调度（配置） |
| 8 | **限流在 Redis** | 已是 Upstash；参数从目录缓存读 ✓ | 新增"按模型/供应商并发计数"也放 Redis（第 10 条） |
| 9 | **没有每轮扫全表的查询；大字段不进热表** | 三个函数的每条语句都走主键/唯一键/部分索引；`check-turn-budget` 对三条标准回合跑 `EXPLAIN`，断言热表无 Seq Scan。**原始回执（模型完整输出）不放 `turn_calls` 热行**：单独表 `turn_call_raw(turn_id, seq, body)`，单条 ≤ 4194304 字节（现有持久化回执上限，`bill2/responseCapacity.ts`）、30 天清理（线 G 规则不变），`turn_calls` 只留用量、金额、哈希 | 5.1 节加 `turn_call_raw`；7.1 EXPLAIN 断言进 CI |
| 10 | **外部供应商按并发设上限、做退避** | 今天没有按模型并发上限，只有每用户限流。新路径：每个模型/供应商一个 Redis 计数（`INCR`+TTL）作为并发上限（目录缓存里配），超上限先等再拒；重试只允许 2.5.2 的两种确定不计费的失败（`not_sent`、`rejected`），每次尝试独立一行回执、最多 2 次、带退避；结果不明的永不重试（SDK `maxRetries:0` 保留） | V2-4、V2-6 实现并单测；上限值是配置 |
| 11 | **流式期间不占数据库连接、不占内存里的大对象** | 调用之间不碰库 ✓；历史在开轮时读一次后只在内存里裁剪（≤ 196608 字节）✓ | 7.1 静态扫描已含 |
| 12 | **目录缓存在多实例下一致** | 每个 Vercel 实例各自缓存，按 `catalog_versions` 失效，最多 60 秒旧（已上库机制）；实例数多了也不加库压力（版本号随 `turn_open` 返回）✓ | — |

补一句什么**不是**现在要做的：不分库、不上消息队列、不上事件溯源、不做多区域写。这些在 5000 人以内都用不上；真到那一步也是加组件，不是重写主路径，因为主路径的接口就是三个函数。

#### 3.3.3 怎么证明

1. **100 人在 Micro 实测**（3.2 节）：这是唯一真实环境的数据点，也给出"每轮核·秒"的实测值 k。
2. **500 / 2000 / 5000 用单机压测 + 线性外推**：
   - 在一台开发机的 Docker PostgreSQL 17 上（固定核数、`shared_buffers` 与 Supabase 对应规格一致），用桩模型跑 500 / 2000 / 5000 虚拟用户（压测节奏和真人节奏各一遍），
     采 `pg_stat_statements` 的每轮 CPU 时间、`pg_locks` 等待、每秒写入行数与 WAL 量。
   - 外推依据：新路径每轮的数据库工作量与并发人数无关（只碰自己的行、没有共用行、没有随表变大的查询），所以数据库 CPU ≈ k × 轮数/分，
     是线性的；锁等待应接近 0 且不随人数增长——压测要**证明这两条**（k 在 500 → 5000 之间不变、等待事件占比不涨），而不是证明某台开发机能撑 5000。
   - 不确定性（如实写进报告）：共享核的突发额度（Micro/Small/Medium）；内存与交换区（表变大后缓存命中率下降）；磁盘 IOPS；Vercel 到数据库的网络往返
     （本机为 0，线上 1–5 ms × 3 次）；OpenRouter 的真实限速；真人节奏没有实测。外推结果按"量级"给，不按"精确人数"给。
3. **第一次真要扩容前（比如要上 500 人）必做的验证**：
   - 开一个临时 Supabase 项目选目标规格，从文件建库，用桩模型按目标人数压一次（费用按次问 Owner），核对 k 和等待事件与外推一致；
   - 确认连接池模式为事务模式、池大小按 3.3.1 算；确认 Vercel 套餐的并发与时长上限；确认 OpenRouter 密钥限速与余额告警；
   - 连接池调大前先把目录里的 P 调到新池大小，并确认日限 L ≥ 10×B（B=(P−1)×U_fast+U_big，2.5.1），否则接近日限时提前拒绝的比例会变大；
   - 若到 2000 人：开只读副本，把 3.3.2 第 5 条的读切过去；评估是否做第 4 条的分区搬家（表超过几千万行或保留期清理变慢时才做）；
   - 看一遍慢查询日志和 `check-turn-budget` 最新基线，确认没有人把"每轮一次"的查询偷偷加回去。
4. **持续证明**：7.1 的守门脚本每个 PR 都跑，基线只许变小；k 的实测值随每次压测记进 `docs/validation/core-path-v2/`。

## 4. 产品规则清单：保留、简化、删除

来源：Master Plan §2.1 全部 Owner 决定（本窗口 10-28 逐条读完，第 85–3003 行）。只列和主路径有关的；会员价格、支付渠道、退款审批、
拒付这类不经过主路径的规则不在表里，不受本任务影响。

状态含义：**保留** = 新路径原样实现，不需要 Owner 点头；**简化** = 结果对用户一样或差别极小、实现方式变了，列在第 8 节请 Owner 点头；
**删除** = 规则本身随旧路径消失，必须 Owner 点头。

### 4.1 计费与积分

| 规则（§2.1 出处） | 新路径里怎么做 | 状态 |
|---|---|---|
| 1 美元 = 100 积分（q=100，项 32）；默认倍数 m=6，按模型/线路可单独设，调用时冻结（项 50/33/34） | `turn_open` 从目录缓存读 q、m、模型倍数，写进 `turns.policy`；收轮按冻结值算 | 保留 |
| 按名义费用收费、不让缓存折扣、分时价取最贵、缺 token 时 min(c,U)（项 41） | 回执写 n_i、c_i、usage；`turn_close` 按第七版公式算 N、D、E | 保留 |
| 边用边扣、余额封顶冻结 H=min(G,A)、不负余额、低于 L 暂停提示充值、断点续跑不重复收费（项 26、记录 J） | 冻结改为**一轮一次**；L 在 `turn_open`；中途不够 `credits_low`→暂停；"继续"= `turn_open(resume_of)` | **简化**（第 8 节 3d：冻结从每次调用一次变成一轮一次；开始门槛仍是 L，冻结 H=min(G_turn,A)——2026-10-28 Owner 更正） |
| 单次超冻结额平台承担；只有真实成本超估算上界才停新调用（项 27） | E=N−D；上界校验在回执写入 | 保留 |
| 启动门槛 L 自动按模型×用途算（10-06） | 同公式，目录缓存里算 | 保留 |
| 整理等积分时用户发新消息，先补上一轮整理（项 41 Q1=A） | 上一轮 `paused(waiting_credits)` 时新消息开轮先完成它 | 保留 |
| 402 当作没有费用（项 53） | 回执 `status='no_charge_402'`, n=0 | 保留 |
| 白名单系统原因失败自动退本轮；白名单外走每日对账（10-12） | `turn_close(kind=failed, reason)` | 保留 |
| 暂停回合 24 小时没交付自动退（10-25）；"Graylum 原因没答案 24 小时后退"（10-12） | 恢复定时任务对 `turns` 统一处理 | 保留（入口合一，第 8 节 3c） |
| 报告固定 500、点生成时冻结、完整才扣、失败/截断/停止全退、重生成照收（10-17）；停止防刷 24 小时前 2 次全退、第 3 次起按已生成部分扣（10-27） | `kind=report` 分支；次数用 `turns` 索引数 | 保留 |
| 普通对话（自由对话、导师）不提供用户停止（Owner 10-28） | 前端无按钮；服务端拒绝；没有普通对话的 `stopped` 分支 | 保留（新决定） |
| 报告成本逐次记账、超 500 平台承担；删除/注销时完整报告照收、其余退（10-17） | 回执照记；注销投影对 `turns` 加规则 | 保留 |
| 评审团固定价 1500、只给 Gold、一次冻结、可用修订稿才扣、未完成/失败/无需修改全退（10-17，**取代**了 10-14 的逐席按量规则）；每组前余额 ≥ 该组临时上界、组后释放（10-13）；格式不合格席位的意见不进汇总（10-13）；暂停 24 小时自动结束，已交付部分按实际扣、未用押金退（10-27） | `kind=jury`：用户侧冻结 1500 + 当前组临时上界；每席一条回执只做供应商成本记账；收轮按 2.7 节的交付判定结算固定价（可用修订稿→全价；无需修改/失败/未完成→全退；中断/24 小时自动结束→min(固定价, 已知用量)） | 保留 |
| 评审团各席各自结算各自取整、某席失败只退它自己（10-14） | 已被 10-17 固定价取代，用户侧不再按席结算；"某席失败"在固定价下的含义是：该席不进汇总，用户仍按交付判定付固定价或全退。**供应商侧**仍逐席记账 | 保留（按 10-17 解释） |
| 评审团不提供中途停止（10-17）；10-27 又提到"用户点结束评审" | 新路径只留"完成"和"24 小时自动结束"两个收轮入口；要不要用户"结束评审"入口请 Owner 确认 | **待确认**（第 8 节 4） |
| 对比按量、各模型各自结算取整、开始前显示最多 X、余额够全部上限之和、用户合计 ≤ 500 积分（10-17、10-26） | `kind=compare`：G_turn=Σ上界，超 500 拒开轮 | 保留 |
| 第三方搜索结果未知对用户 0 结算、释放冻结、供应商成本待确认（10-13 9.2） | 工具回执 `status='unknown'`, n=0, `cost_pending=true` | 保留 |
| 发布每成功平台 0.01×6 美元；读自己作品不收积分（10-13） | 发布不经主路径；读作品作为工具调用，回执 n=0 | 保留 |
| 复盘每份成本上限 1 美元、按用量扣、多品牌各一份（10-27） | `kind=review` 的 G_turn 由 1 美元换算 | 保留（上线后接入） |
| 积分记录只列实际变动，预留/释放不列（10-25） | 预扣走 `atomic_pre_deduct`（`billing_history` 记录，不进 `credit_transactions`）；`turns.reserved_credits` 只是预扣额的记录，不参与可用余额（2.5.4）；收轮写净扣一笔 | 保留（实现更简单） |
| 带步骤 Skill 的报告必须付费会员，免费可做完前面步骤（项 50） | `turn_open(kind=report)` 查会员等级 | 保留 |
| 限流：新对话 10/分 200/天、模型调用 30/分 600/天、一键暂停（项 30/49） | Redis 限流器不变，参数从目录缓存读 | 保留（落地状态待核，9 节） |

### 4.2 导师与自由对话

| 规则 | 新路径 | 状态 |
|---|---|---|
| 模型按用途后台配置，会员不区分模型，输入框只显示 Auto（项 13/50/38） | 目录缓存里的用途→模型表 | 保留 |
| 输入上限：普通 90000、挂研究工具 150000、报告 196608（10-27 RT-6） | 常量不变（`purposeBudgets.ts`）；裁剪结果在 `opened` 事件里明说 | 保留 |
| 提问卡只在选择且意思不明时出、推荐一项、末尾"其他"、开场不出卡（项 20）；出卡前分析保留（10-05） | 提示词与 Skill 规则 | 保留 |
| 整步确认：一张确认卡、一步点一次、"继续"重出卡不自动确认（10-07） | 确认是独立动作，写 `opc_drafts`，不经回合 | 保留 |
| 导师每轮看到右侧已填内容；"让导师接着聊"由用户点（10-07） | `turn_open` 返回草稿摘要拼进 hostTurnContext（进 user 消息，2.9 第 3 条） | 保留 |
| 右侧信息跟对话走、AI 提议用户确认才保存、不自动整理（项 48、10-13） | 整理结果在收轮同事务写 `opc_drafts` 候选 | 保留 |
| 自由对话模型自己调"加载 Skill"，每轮最多 2 个，按当前模型计费；定位/选题/报告用绑定模型（10-23） | 工具白名单与计数在 Node；Skill 包来自缓存；加载后的模型续轮计入 G_turn（2.5.3） | 保留 |
| AI 自己决定检索资料库/读发布数据/取对标；每条回答最多 3 次研究调用、12 次子调用；逐行显示扣费；资料库/读定位/读对标表免费；读自己发布数据按档位（10-17） | 工具计数在 Node；每次工具一条回执（免费的 n=0） | 保留 |
| 联网不受用户设置限制，发生搜索时展示；评审团不联网（项 21） | 同上 | 保留 |
| 定位前置检查只拦"为自己账号做运营"；Decisions 先判、主模型兜底；被拦不扣费（10-12）；代码预过滤（10-25 B）待 Owner 确认 | 开轮前一次 Decisions 调用，回执 n=0；代码预过滤不做 | 保留 |
| 回复语言按顶栏设置、用户明确要求时按要求、公开页进来以页为准（10-24/25） | 语言规则进 system 按用户段 | 保留 |
| 模型身份保护默认开；对比显示真实模型名，评审团只显席位名（10-12/14/17） | 提示词与前端 | 保留 |
| 一窗口一选题、提醒并给新窗口入口（CONTENT-CONVERSATION-2，上线后） | 不在本任务 | 保留 |

### 4.3 研究与对标

| 规则 | 新路径 | 状态 |
|---|---|---|
| 对标发现：关键词 6–10、按需翻页、直搜账号、网页线索；子调用上限 TikTok/X/YouTube 80、抖音/小红书 40（10-23）；单次核对最多 5 个账号（10-27） | 工具参数与计数在 Node，不变 | 保留 |
| 合格对标 1 万–20 万粉、30 天活跃、≥20 条、候选 8–12、合格 ≥3；YouTube 约数保守（10-23、10-16） | Skill + 代码校验 | 保留 |
| 对标不允许跳过（R11）；兜底 B：≥1 合格 + ≥2 轮确认过的搜索 + 用户明确选"用现有先生成"（10-20）；贴链接核对也算一轮（10-27） | 轮次计数在 `opc_drafts`，`turn_close` 更新；兜底卡按 `opened.fallbackEligible` 显示 | 保留 |
| 小众领域 1–7 个也出卡（10-23）；每轮重新对标（10-23 晚） | Skill 规则 | 保留 |
| 供应商 TikHub / Parallel / Firecrawl / monid / Bright Data，各自平台设硬上限（项 10、10-07）；Firecrawl 不开零保留（10-24） | 不变 | 保留 |

### 4.4 报告、评审团、对比

| 规则 | 新路径 | 状态 |
|---|---|---|
| 报告由模型写、12000 字、Skill 模板定结构（项 22/25）；两种形态、结构化 9000 字（REPORT-VISUAL） | `kind=report`；结果写 `artifact_versions` | 保留 |
| 后台可单独指定报告模型（10-10）；单次输出 32768 不续写（10-07） | 目录；常量 | 保留 |
| 旧版本报告可看可导出（10-12）；已评审徽章代码判断（10-20） | `artifact_versions` 不变 | 保留 |
| 评审团 3 席固定视角 + 汇总、默认 1 轮、代码合并去重、引文核对（10-20/10-14）；模型 Sonnet/GPT-6.1 Sol/Gemini 4 Argon/Opus（10-25）；逐章选择一次（10-14）；三次未完成暂停该版本（10-20）；采纳后可编辑重定稿不加费（10-20） | `kind=jury`；合并、引文核对是 Node 纯函数；采纳后重定稿走 R14，不开回合 | 保留 |
| 评审、对比只给 Gold，非 Gold 弹付费墙（记录 D、10-20） | `turn_open` 查会员等级 | 保留 |
| 对比默认勾选、最少 ≥2、第一条消息就支持对比（项 50、10-24） | 前端 + `kind=compare` | 保留 |

### 4.5 历史与缓存

| 规则 | 新路径 | 状态 |
|---|---|---|
| 保留原始对话记录，不做摘要压缩（项 31）；历史最多约 100 条、受 196608 字节约束（项 55） | `session_messages` 原文；裁剪算法不变 | 保留 |
| 提示缓存上线必做（项 35）；历史缓存 H1、不做 1 小时（项 43） | 2.9 节 | 保留 |
| 结算放回复结束后、历史按标记读写前照查、流式按阶段查删除（10-27 三项） | 结算在收轮（一次，同步，不再需要异步）；历史按 `visible`；删除检查搭回执 | 保留（"异步结算"不再需要，第 8 节 3e） |
| 数据库 Micro、100 人并发（10-25） | 第 3 节 | 保留 |

### 4.6 删除、注销、隐私

| 规则 | 新路径 | 状态 |
|---|---|---|
| 只能整个删对话（10-13）；删除瞬间完成、不显示影响清单（10-13） | `sessions.deleted_at` 一条 UPDATE；正文分批清 | 保留 |
| 删除检查立即生效（10-25）；同一轮只读不重复查、写前照查（C3） | 每次写入返回墓碑；收轮前必查 | 保留 |
| 删除定位对话后已确认内容只读可导出（10-14） | `opc_drafts` 不变 | 保留 |
| 删文风画像立即生效、正在写的作废、按"删除中止"结算（10-23） | 文风来源版本进 `turns.policy`；回执写入核对→中止；`kind=erased` | 保留 |
| 注销立即、无冷静期、账务 3 年、日志 30 天（项 14、10-12） | DATA-ERASURE 投影改指新表 | 保留 |
| 收据原始输出 30 天清、计费字段 3 年（10-25 线 G） | `turn_call_raw` 30 天按批清理；`turn_calls` 计费字段 3 年 | 保留 |
| 数据不用于训练（10-12/26）；备份恢复演练是公开前提（10-24 E2） | 不变 | 保留 |

### 4.7 随旧路径一起消失的（需要 Owner 点头）

| 项 | 说明 |
|---|---|
| staging 测试窗口（`runtime_test_windows`、`staging_test` 合同、窗口累计额度、"再开一个 1000 次窗口"，10-25 原话） | Owner 10-28 已决定去掉；staging 花费改由测试密钥额度 + 测试账号积分控制。**取代** 10-25"测试窗口用满时总控再开一个 1000 次新窗口" |
| BILL2 v1 合同、逐调用 claim/dispatch/record/finalize、`bill2_runs`/`bill2_calls`/`bill2_receipts` | 由 `turns`/`turn_calls` 取代；数学不变；"积分记录"规则不变 |
| 按天止损的全站独占锁 (201,1) | 改 `daily_spend` 分桶行，开轮预占、收轮回补（2.5.1）：当日实际花费不超日限，接近日限时提前拒绝 ≤ 预留带 B（第 8 节 3b 改述） |

## 5. 数据模型：保留、替换、删除，以及切换

### 5.1 新表（一个迁移，V2-2）

| 表 | 列（要点） | 索引 |
|---|---|---|
| `turns` | id bigint identity, actor_id, session_id, request_id, kind(chat/mentor/report/compare/jury/jury_adopt/review), state, resume_of, policy jsonb（冻结：模型、q、m、上界、工具白名单哈希、system 两段哈希、文风来源版本、Skill packageHash）, input_bytes, reserved_credits, charged_credits, absorbed_credits, settlement(pending/done), stopped_by_user bool, delivered bool, failure_code, opened_at, updated_at, closed_at | **pk(actor_id, id)**；UNIQUE(actor_id, request_id)；(session_id, opened_at)；(state, updated_at) WHERE state IN ('running','paused')；(actor_id, kind, closed_at) WHERE stopped_by_user；(settlement) WHERE settlement='pending'；(opened_at) 供保留期清理 |
| `turn_calls` | turn_id, seq, call_kind(model/tool/decision), model_id/tool_name, status(dispatched/identified/ok/unknown/not_sent/rejected/no_charge_402/unusable), request_hash, upper_usd U_i, provider_id（generation id，发出后尽早写）, nominal_usd n, actual_usd c（可空）, multiplier m, usage jsonb（含 cache_read/cache_write）, payload_hash, cost_pending bool, dispatched_at, settled_at | **pk(turn_id, seq)**；(cost_pending) WHERE cost_pending；(status) WHERE status IN ('dispatched','identified')；(dispatched_at) |
| `turn_call_raw` | turn_id, seq, body（完整响应/传输记录，≤ 4194304 字节，与现有持久化回执上限一致）, created_at | pk(turn_id, seq)；(created_at) 供 30 天清理（线 G） |
| `session_messages` | id bigint identity, session_id, seq, role, turn_id, content text, content_hash, visible bool, deleted_at | **pk(session_id, id)**；UNIQUE(session_id, seq)；(session_id, seq DESC) WHERE visible AND deleted_at IS NULL |
| `daily_spend` | day date, bucket smallint (−1 大额 kind, 0–15 普通回合), reserved_usd numeric, spent_usd numeric；日限 L、P、U_fast、U_big 从目录缓存读 | pk(day, bucket)；开轮先锁本桶预占 U_turn、再读 SUM 检查、收轮回补（2.5.1） |

`sessions`：复用 `runtime_sessions`，改名为 `sessions` 或保留原名（V2-2 决定，建议保留原名少改引用），加 `active_turn_id`、`deleted_at`；
去掉 `active_execution`、revision 相关列的使用。

主键都带所有者列、`id` 用时间有序的 bigint、所有查询都带所有者键——这是为了将来按 `HASH(actor_id)`/`HASH(session_id)`/`HASH(turn_id)` 分区时
不改任何代码（3.3.2 第 4 条）。V2-2 的迁移注释要写明这个分区方案和触发条件（单表超过几千万行或保留期清理变慢）。

### 5.2 保留的表（主路径只读或按 kind 写一行）

`profiles`（余额、会员、状态）、`credit_transactions`、`credit_source_entries`（grants）、`billing_history`、`subscription_credit_grants`、`credit_package_sources`
（**积分账本按"账本叶子"接法**，10-28 骨架窗口与架构窗口定：开轮调现有 `atomic_pre_deduct(actor, H, …, request_id)` 冻结；收轮调新写的
`turn_settle_credits`，它把 `bill2_legacy_settle` 的账本数学整段拷过来不改、只去掉 `bill2_*` 依赖，再写一笔净扣进 `credit_transactions`；
`credit_available`、`credit_source_apply` 照用。额度来源、会员赠送消耗、拒付冻结的规则一条不动。这四个账本函数里的行锁都是按用户的，
没有全站共用行，符合 3.3.2）、`catalog_versions`、
`system_settings`、`ai_models`、`modules`/`skills`/`skill_revisions`/`skill_packages`/`skill_package_files`、`opc_drafts`/`opc_turns`（导师整理与轮次）、
`bill2_drafts`、`artifact_versions`（报告）、`fusion_reviews`/`fusion_compares`（评审团/对比的产物与逐章选择，去掉它们的 billing_group 列）、
`research_*`（对标发现产物）、`library_*`、`voice_*`、`social_*`、`account_erasure_*` 状态表。

### 5.3 删除的表与函数（V2-12，staging 只有测试数据，直接 DROP；正式库新建时不带）

- 表：`runtime_executions`、`runtime_session_history`、`runtime_history_dependencies`、`runtime_tool_calls`、`runtime_session_batches`、
  `runtime_session_results`、`runtime_scope_material`、`runtime_library_references`、`runtime_voice_references`、`runtime_test_windows`、
  `bill2_runs`、`bill2_calls`、`bill2_receipts`、`bill2_provider_ids`、`fusion_billing_groups`、`fusion_billing_group_steps`、`report_fees`、`fusion_review_fees`。
  （`runtime_session_names` 并入 `sessions.title`。）
- 函数：`runtime/` 111 个中除 `runtime_start`（改写为建会话）外全部；`billing/` 102 个中 `bill2_*` 全部（`atomic_*`、`credit_*` 账本函数保留）；
  `fusion/` 63 个中计费与推进相关的（产物读写保留）；`report/` 的 `report_fee_*`、`report_stop`、`report_admission_check`；`other/` 中 `catalog_versions_snapshot` 保留。
  目标：`packages/db/functions` 从 939 降到约 450（主路径相关从约 330 降到约 20）。
- Node：`services/runtime/` 315 个文件和 `services/bill2/` 56 个文件整体删除，新目录 `services/turn/`（目标 ≤ 60 个文件，每个 ≤ 500 行）；
  `routers/runtime.ts`、`fusionReview.ts`、`fusionCompare.ts` 的计费部分改调 `services/turn`。

### 5.4 切换顺序（staging 只有测试数据；正式库从文件新建）

1. V2-2 先加新表（旧表不动），V2-3 加新函数，V2-4 起新 Node 路径在 `services/turn/` 下，前端 V2-10 前仍走旧路由——新旧并存只在开发期，
   由 `system_settings.core_path_v2.enabled`（staging 与正式同值）决定前端调哪条；这不是 staging 专用分支。
2. V2-10 合并后 staging 切到 v2，旧路径跑不到；V2-11 e2e 在 staging 跑通；V2-13 压测通过。
3. V2-12 一个迁移 DROP 旧表旧函数（迁移开头写明：不可逆、staging 仅测试数据、正式库尚不存在）；删旧 Node 代码；删 `core_path_v2.enabled` 开关。
4. 正式库按 REL-1/BASELINE-SQUASH 从文件新建，天然只有新结构。
5. 回退：V2-12 之前任何时候关 `core_path_v2.enabled` 即回旧路径（旧表旧函数都在）；V2-12 之后不回退（删除是不可逆的，所以它排最后、压测通过后才做）。

## 6. 实施计划

### 6.1 PR 清单

风险等级按 AGENTS.md（high = 计费/数据库/权限/CI）。"窗口"：Claude = Claude 执行窗口（Opus），Codex = 交 Codex。
带迁移的 PR 由总控上库后合并；迁移号开工时向总控要。

| # | PR | 范围 | 风险 | 窗口 | 依赖 | 工期 | 验收（合并条件） |
|---|---|---|---|---|---|---|---|
| V2-0 | `docs(CORE-PATH-V2)` 本文 | 本文；Owner 决定后记进 MASTER_PLAN §2.1 | ordinary | Claude | — | 已做 | Codex 审查；Owner 第 8 节决定 |
| P-1 | `feat(PROMPT-CACHE)` 合 #1501 | 报告/评审团/对比的断点（改 base 到 staging，补复审）；#1500、#1502 关闭，改动迁入 V2-4/V2-5 | high | Claude | — | 0.5 天 | 现有单测；不改主路径 |
| V2-1 | `chore(CORE-PATH-V2)` 守门工具与压测桩 | `scripts/check-turn-budget.mjs`（往返/锁/数据库时间/EXPLAIN 无顺序扫描断言，棘轮基线）；`scripts/db-function-closure.mjs`（闭包 + 行锁白名单 + 会话级状态禁用扫描）；`scripts/loadtest/openrouter-stub.mjs` + 100 账号重置脚本 + 单机外推压测脚本（3.3.3，500/2000/5000 虚拟用户、记 k 与等待事件）；对旧路径跑一次基线存档 | low | Codex | — | 3.5 天 | 脚本进 CI 的 db-suites job（实测时长写进 PR，≥8 分钟余量）；基线文件提交 |
| V2-2 | `feat(CORE-PATH-V2)` 新表迁移 | 5.1 节四张表 + `runtime_sessions` 新列；不动旧表；主键与唯一键按 3.3.2 的"可分区"约束设计（按所有者哈希可分区、时间列可做保留期清理） | high（迁移） | Claude | — | 2 天 | 回放两次结构不变；指纹更新；总控上库；迁移注释写明未来分区方案 |
| V2-3 | `feat(CORE-PATH-V2)` 核心函数 | `turn_open`、`turn_call_begin`/`turn_call_identity`/`turn_call_record`、`turn_close` + 恢复入口；DB 套件 `packages/db/tests/turn-core/`：幂等（重复 request_id、重复 seq、重复 close）、并发（同会话两轮、同账号多会话、开轮与删除竞争、开轮与注销竞争）、守恒 C+E=N、余额不负、**冻结只影响可用余额一次**（2.5.4：开轮 H=400 后 `credits` 与 `credit_available` 都是 600，另一会话开轮看到 600）、402、未知成本（发出后无最终回执：不退冻结、不释放日限预占、`cost_pending`；恢复按 provider_id 补结；工具例外 0 结算）、评审团固定价交付判定（修订稿→全价、无需修改→全退、中断→min(固定价,已知用量)）、停止（只有报告能停，普通对话拒绝；报告 24 小时规则）、暂停与 24 小时退、评审团分组、对比上限 500、墓碑中止、文风来源撤销、止损（2.5.1：P 个并发开轮在日限附近全天预占不超 L、`spent ≤ reserved` 不变量；P 小于声明池大小时拒绝；崩溃回合由恢复 close 回补；跨天回补开轮当天）；全部函数只用事务级锁、不 SET 会话变量（Supavisor 事务模式兼容，3.3 节） | high（迁移） | Claude | V2-2 | 5 天 | 套件进 `run-local-suites`；锁数 ≤ 42、闭包 按回合类型 ≤ 15 / ≤ 18（Owner 2026-10-31 批准）；EXPLAIN 无顺序扫描；总控上库 |
| V2-4 | `feat(CORE-PATH-V2)` Node 核心 + 自由对话 | `services/turn/`：`POST /api/turn` SSE、状态机、runner 接线、回执、目录缓存接入、提示词拼装层（prompt-cache-v3 + 2.9 节 8 条 + #1500 迁入）、黄金字节测试、`kind=chat`（含 Decisions 前置检查、加载 Skill 工具）；读/写客户端分开的接缝（`readClient`/`writeClient`，今天都指主库，3.3.2 第 5 条）；OpenRouter 按模型并发上限；重试只限 `not_sent`/`rejected`、SDK `maxRetries:0`（2.5.2）；回执与结果容量沿用 `responseCapacity.ts`（532480 / 4194304 / 262144） | high | Claude | V2-3 | 6.5 天 | `check-turn-budget` 自由对话 ≤ 5；黄金字节；runtime 集成套件里自由对话场景等效迁移，**含 `streaming.integration.ts` 的"断线保留供应商 id 与冻结、不二次 POST、不零退"**，以及 `runnerRetrieval.test.ts` 的"两次资料库读取、三次模型请求"（三次模型调用都在开轮的 G_turn/U_turn 内、各自三步回执，最后一次后不再提供工具）；`mentorOutput.test.ts` 等容量边界测试迁入；并发上限与退避单测 |
| V2-5 | `feat(CORE-PATH-V2)` 定位导师 | `kind=mentor`：Skill 包缓存、hostTurnContext、提问卡/确认卡、整理入收轮、兜底资格、#1502 的三断点按新结构重写、黄金字节 | high | Claude | V2-4 | 5 天 | 预算导师 ≤ 11；`hostTurnAdmission.test.ts` 断言等效迁入；换步骤第一断点哈希不变 |
| V2-6 | `feat(CORE-PATH-V2)` 研究与 Skill 工具接核 | 研究工具回执计量、子调用计数、容量裁剪明示（`opened` 事件）、研究轮次计数（含贴链接核对）、`read_source`/`load_skill`/`read_skill_file`；TikHub/Parallel/Firecrawl/monid 按供应商并发上限 + 退避（复用 V2-4 的 Redis 计数） | high | Codex | V2-4 | 4 天 | `payg-three-tools`、`research-tools` 场景等效迁移；未知结果 0 结算测试；供应商限流退避单测 |
| V2-7a | `feat(CORE-PATH-V2)` 报告 | `kind=report`：固定价、`acceptedCredits` 校验、会员门槛、停止（唯一允许停止的 kind）与 24 小时防刷、前端停止确认与第 3 次扣费说明（修核心缺陷 1⑤ J2/J3）、`artifact_versions` 写入、#1501 断点保留 | high | Codex | V2-4 | 3.5 天 | `report`、`report-stop` 场景迁移；24 小时 3 次停止测试；双击只扣一次 |
| V2-7b | `feat(CORE-PATH-V2)` 对比与评审团 | `kind=compare`/`jury`（采纳后重定稿走 R14，不开回合）：并行调用、分组暂停、押金、Gold 门槛、三次未完成、`fusion-recovery` 改读 `turns` | high | Claude | V2-4 | 5 天 | fusion 套件场景迁移；24 小时自动结束测试 |
| V2-8 | `feat(CORE-PATH-V2)` 暂停/恢复/定时任务 | `runtime-recovery` 定时任务改读 `turns`（15 分钟中断、24 小时暂停、未知成本补结），按批认领（`FOR UPDATE SKIP LOCKED`、每批 ≤50、可多实例并行、幂等）；普通对话停止入口删除、服务端拒绝 | high | Codex | V2-3、V2-4 | 3 天 | `bill2-stuck`、`stop-round`（改为"普通对话不能停"的拒绝断言）场景迁移；崩溃恢复集成测试；两个实例同时跑定时任务不重复处理 |
| V2-9 | `feat(CORE-PATH-V2)` 删除与注销接新表 | 会话删除墓碑化、内容清除投影、注销投影、文风来源撤销、`content_erasure_runtime_check` 替换 | high | Codex | V2-3 | 4 天 | erasure 套件逐条等效迁移；长对话（≥100 轮）删除 < 1 秒 |
| V2-10 | `feat(CORE-PATH-V2)` 前端切换 | `/app` 对话工作区改调 `/api/turn` SSE；`opened` 事件渲染（工具可用性、裁剪说明、兜底卡）；右侧成果夹；普通对话去掉停止按钮（报告保留）；`core_path_v2.enabled` 开关 | ordinary | Claude | V2-5、V2-6、V2-7、V2-8 | 4 天 | 浏览器验证（Codex 验收批次）；旧 e2e 全过；实测新路径评审走到采纳后的 R14 接口 |
| V2-10b | `feat(CORE-PATH-V2)` 作品类会话与定位方案生成接新路径 | V2-10 只切自由对话、定位导师和报告，下面两块仍走旧路径，V2-12 删除旧路径前都必须接完。① `scope=work_item` 的会话和选题页：选题进入写作、口播稿、分镜和剪辑（`saveWorkResult`、`saveContent`、`prepareVideoMaterial`、`checkVideo`，现在都按 `executionId` 工作）。② 定位方案（第一周计划）生成：现在由定位页 `generatePlan` 调 `opc.prepareStep`（`purpose=plan`）准入，再走 `runtime.executeStream` 执行、`opc.planResult` 取结果；账单走 BILL2（`bill2_prepare` 的 `operation=plan`），和其他 Skill 回合一样按用量扣积分。回合目前没有对应的 `kind`，要新增或并入现有 kind，收费规则不变 | high | 待派 | V2-10 | 待估 | 这些流程在新路径跑通后，旧路径才能删 |
| V2-11 | `test(CORE-PATH-V2)` 核心路径 e2e | `apps/web/tests/e2e/core-path/`：① 定位三步到定稿报告；② 自由对话 + 加载 Skill + 一次研究；③ 报告停止与 24 小时防刷（第 3 次看到扣费说明）、普通对话无停止按钮；④ 删除对话（长对话）与注销；⑤ 对比；⑥ 评审团到逐章选择。新 workflow `staging-e2e.yml`：staging 每次部署成功后跑，模型用 **Claude Haiku 5.5**（Owner 10-28 批准），每次运行 ≤ 0.5 美元，失败开 issue | high（CI） | Codex | V2-10 | 4 天 | 在 staging 跑通一次并附报告与实际花费 |
| V2-12 | `chore(CORE-PATH-V2)` 删除旧路径 | **先**改 `content_erasure_ledger_owned`（V2-3 本机实测定位：`atomic_pre_deduct` 往 `billing_history` 插行 → 触发器 `zz_erasure_ledger_guard` → `erasure_ledger_guard()` → 它在第 23/28 行按 run_ids/pre_ids 查 `bill2_runs`，9 把锁全来自这里；`credit_available` 本身 0 把），把按 `bill2_runs` 判断账本归属改为按 `turns`（整段 CREATE OR REPLACE，同一迁移里排在 DROP 之前，并把 erasure-ledger 套件里"账本行归属"的断言改成按 `turns`；**`credit_available` 不改、也不减 `turns.reserved_credits`**，预扣已在 `profiles.credits` 里，2.5.4）；再 DROP 旧表旧函数（一个迁移）；删 `services/runtime`、`services/bill2`、测试窗口、`productionPolicy`/`stagingPolicy`、`runtime_rw_v2`、`core_path_v2.enabled`；**旧对话历史要先迁走**：V2-10 里已有旧路径历史（`runtime_session_history`）的自由对话继续走旧路径，因为新路径只读 `session_messages`，直接切会让页面显示上文、模型却没有；V2-12 删旧前把这些对话的历史迁入 `session_messages`（或由 V2-10b 单独做），并让多模型对比的采纳和读取一起改成读写新表；**建会话入口不能随旧路径删掉**：`runtime_start` 改写时要内联它用到的 `bill2_actor`、`bill2_create_draft`、`bill2_scope_allowed`，并保留 `runtime.start` 路由和 `admission.start`；`opc_start` 同样调 `bill2_actor`、`bill2_scope_allowed`，还调 `runtime_start` 并读它返回的 `scope.draftId`，要一起改，返回形状不能变；`opc.start` 的 Node 层（`services/opc/start.ts`）调 `opc_start_b1`，它再调 `opc_start`，`opc_start_b1` 自己也调 `bill2_actor`，三层都要接上；清理 `turn_fusion_open` 里无入口可达的 `jury_adopt` 门槛（含每个评审一次的限制）与 `turns.kind` 的这个取值；删对应测试套件（场景已迁移的）；更新 ENGINEERING/ARCHITECTURE 文档、`local-suites-excluded.json` | high（迁移） | Claude | V2-10b、V2-11、V2-13 通过 | 5 天 | 全部 CI 过；函数数 ≤ 450；指纹更新；总控上库 |
| V2-13 | `docs(CORE-PATH-V2)` 100 人验收与外推 | 3.2 节 staging 压测 + 3.3.3 单机 500/2000/5000 外推压测，报告进 `docs/validation/core-path-v2/`（含 k 值、等待事件、不确定性）；MASTER_PLAN §2.1 记录结果 | ordinary | Codex | V2-10 | 3 天 | 3.1 节通过线；k 在 500→5000 不变（±15%） |

### 6.2 顺序与并行

```
P-1 ─┐
V2-1 ─┤（与 V2-2/3 并行）
V2-2 → V2-3 → V2-4 ─┬→ V2-5 ──┐
                     ├→ V2-6 ──┤
                     ├→ V2-7a ─┼→ V2-10 → V2-11 → V2-13 → V2-12
                                        └→ V2-10b ──────────→ V2-12
                     ├→ V2-7b ─┤
                     ├→ V2-8 ──┤
                     └→ V2-9 ──┘
```

- 串行骨架 V2-2→3→4 约 13 个工作日（一个 Claude 窗口）；V2-1 同时由 Codex 做。
- V2-5…V2-9 六个 PR 文件不重叠（各自 `services/turn/<kind>/`、各自的定时任务与投影文件），三个窗口并行约 6 个工作日。
- V2-10 → V2-11 → V2-13 → V2-12 串行约 15 个工作日（其中 V2-11、V2-13 可部分并行）。
- **合计约 56 个工作日的工作量（含 10-28 扩容要求新增的约 3 天）；三窗口并行约 31 个工作日 ≈ 6 周；加 1 周余量 = 7 周。** 乐观 5 周。
- 期间不做：运营教练复盘、图片生成、落地页以外的新功能；上线前其他任务（REL-1 未完项、ARCH-FIX 不重叠的线）可以由不碰主路径文件的窗口继续。
- 冻结前排不下时的砍法：V2-11 的 ⑤⑥（对比、评审团 e2e）后补；V2-12 的文档部分后补。不砍 V2-12 的删除本身。

### 6.3 每个 PR 共同的验收

1. CI 全绿（含 `check-turn-budget` 棘轮）。
2. 迁移：整段 `CREATE OR REPLACE`/`CREATE TABLE`，开头写兼容/可重复/回退；回放两次；指纹与 `functions/` 重新生成。
3. 旧套件的场景按"等效维护"迁移，PR 描述列出"旧场景 → 新测试"的对照表，一个场景都不许丢；删除旧套件只在 V2-12。
4. 独立审查（Codex 审 Claude 写的，反之亦然）+ 一轮复核。
5. 碰主路径的 PR 描述写明"往返 / 锁 / 数据库时间 前→后"。

## 7. 治理：不让它再劣化

### 7.1 "架构守门"——每个碰主路径的 PR 必须过

进 CI 的 `scripts/check-turn-budget.mjs`（本机 Docker 库，桩模型）：
- 跑三条标准回合（自由对话、导师、报告），断言 3.1 节的往返、锁数、数据库时间；数字只许变小，基线 `scripts/turn-budget-baseline.json`
  和代码大小基线一样是棘轮，手动调高需要 Owner 批准。
- `scripts/db-function-closure.mjs` 扫 `packages/db/functions/turn/`：按回合类型统计，闭包 ≤ 15 函数 / ≤ 18 表（Owner 2026-10-31 批准；**账本叶子不展开**：`atomic_pre_deduct`、`turn_settle_credits`、
  `credit_available`、`credit_source_apply` 四个按名字计 1、不递归进去，它们只碰本人的 `profiles`/grants/积分包行，列表写死在脚本里、加名字要 Owner 批准；
  锁数断言同口径：主路径自己的表 ≤ 42（Owner 2026-10-31 批准，只许变小），账本叶子的锁单独一行、棘轮只许变小，合计也记录）；`FOR UPDATE/FOR SHARE` 只允许 `runtime_sessions`、`profiles`、`turns`，
  且 WHERE 带所有者键；`UPDATE` 的表只许白名单（上述三张 + `daily_spend` 带 bucket、`session_messages`、`turn_calls`）；
  禁止 `pg_advisory_lock(`、`pg_advisory_xact_lock(`、非 LOCAL 的 `SET `、`CREATE TEMP`（Supavisor 事务模式与"无全站热点"两条，3.3.2）。
- `EXPLAIN` 断言：三条标准回合和定时任务认领语句对热表无 Seq Scan（3.1 节）。
- 静态扫描 `packages/api/src/services/turn/`：模型/工具调用前后只允许 `turn_call_begin`/`turn_call_identity`/`turn_call_record` 三个 RPC，其他 `.rpc(`/`.from(` 不许出现在调用之间；
  对供应商的 fetch 必须在 `turn_call_begin` 之后；`maxRetries` 只许为 0；写路径只用 `writeClient`。
- 单机外推压测（3.3.3）不进 CI，但每次主路径大改（新 kind、新表）后由总控安排跑一次，k 值记进 `docs/validation/core-path-v2/`。
- PR 模板加一行"主路径影响：往返 / 锁 / 数据库时间 前→后"。架构守门人（当时的总控窗口）合并前核对这一行和基线差。

### 7.2 建议加进 `docs/ENGINEERING.md` 的规则（提议文本；规则变更需 Owner 批准后另开 PR）

> **第 5 节新增"主路径约束"**
> - 主路径的表主键带所有者列，查询必须带所有者键；不得对全站共用行加锁或更新（按天累计类数据用分桶行）；数据库函数只用事务级状态
>   （不用 `pg_advisory_lock`、非 LOCAL 的 `SET`、临时表），以兼容连接池事务模式；后台定时任务按批认领（`SKIP LOCKED`）、幂等、可多实例并行；
>   对外部供应商的调用按模型/供应商设并发上限并做退避。
> - 一轮对话只允许三类数据库写入：开轮（`turn_open`）、回执（`turn_call_begin`/`turn_call_identity`/`turn_call_record`，每次付费调用发出前必须先写 `turn_call_begin`）、收轮（`turn_close`）。模型调用与工具调用之间不得有其他数据库读写；需要的数据在开轮时取回，或来自进程内目录缓存。
> - 付费调用在 SDK 和 HTTP 客户端里不重试（`maxRetries` 为 0）；只有确定没发出或确定不计费的失败可以重试，每次尝试各自一行回执；结果不明的调用交恢复任务，不退冻结、不释放预占。
> - 主路径的数据库函数只能读写 `turns`、`turn_calls`、`session_messages`、`runtime_sessions`、`profiles`、`credit_transactions`、`credit_source_entries`、`daily_spend`、`catalog_versions`，以及按 `kind` 需要的草稿/报告/评审表各一行；只允许对本人 `profiles` 和本会话 `runtime_sessions` 加行锁；不得对任何全站共用行加锁。
> - 全站只读、管理员写的目录（系统设置、模型目录、Skill 包、权益规则）必须通过 `catalogCache` 读取；余额、冻结、墓碑、会话状态、用户写入的数据永不缓存。
> - staging 与正式环境不得有代码分支；环境差异只能是配置（密钥、地址、价格快照、账号积分）。
> - `scripts/check-turn-budget.mjs` 的基线只许变小；碰主路径的 PR 描述写明往返/锁/数据库时间的前后值。
> - 新的业务规则要进主路径时，先问"它属于开轮、回执还是收轮"，只在那一个函数里加分支；需要新表才能表达的，先在 PR 里写一句为什么现有列不够。

### 7.3 搁置的工作在新路径下变成什么

| 搁置项 | 处置 |
|---|---|
| DB-RW PR-D（历史可用标记）、PR-E（每轮写合并）、PR-F（结算异步） | **不再做**：目标由 `session_messages.visible`、三类写入、收轮一次结算直接达成。已上库的 PR-B（0419 `catalog_versions` + `catalogCache`）**保留并成为主路径依赖**；PR-A（0416）的索引保留、开关函数随旧路径删；PR-C（0418 `admitSplit`）随旧路径删 |
| 权限链分支化（chain-branch） | 不再做：新函数闭包受 3.1 表数上限约束，没有对象 |
| 提示缓存 #1500（自由对话 v3） | **改写后并入 V2-4**：它的三个假设（system = 前缀 + 按用户段；工具跨轮不变；每轮状态只在 user 消息）新路径全部成立并写成硬约束（2.9 节），但冻结位置从 `admission.ts` 挪到新拼装层；`promptCache.ts`/`cacheMessages.ts`/adapter 形状白名单与 ≤3 标记上限按文件迁移，单测随迁。原 PR 关闭 |
| 提示缓存 #1501（报告/评审团/对比） | **直接合**（P-1，开工前第一件事）：报告、评审团、对比的请求体拼装在 V2-7 之前不动；V2-7 接核时保留断点位置。先改 base 到 staging、补 Codex 复审 |
| 提示缓存 #1502（导师历史标记 + SKILL.md 断点） | **按新路径改写**（V2-5）：三个断点规则不变，hostTurnContext/材料位置、历史投影占位算法按 2.9 节第 3、5 条重写；`hostTurnAdmission.test.ts` 的断言作为 V2-5 验收原样迁入。原 PR 关闭 |
| #1503 复核脚本 | 改读 `turn_calls` 缓存 token 列后合并（V2-13 之前） |
| #1504 `tool_choice:"none"` 放行 | 已合并；V2-5 开场轮对齐依赖它 |
| 运营教练复盘 #1481（迁移 0407）、#1483 | 主路径完成后以 `kind=review` 接核：#1481 的数据地基（结算事实、实验账本）与主路径无关，可在 V2-2 之后由总控择机上库合并；#1483 要改成不走 `REVIEW_PROMPT`+旧 Runtime，而是 V2-6 的"固定 Skill"入口，等 V2-12 后改写 |
| 图片生成规划 | 上线后；按新 `kind=image` 接入，冻结额按张数 |
| ARCH-FIX 未完成的线 | 与主路径重叠的（线 C 工具参数、线 D 卡住回合收尾、线 A 入口限流）在 V2-6/V2-8/V2-4 内完成并在 PR 标题带 ARCH-FIX；不重叠的（线 B 上传存储、线 E 订阅积分隔离与对账、线 G 收据保留期改读 `turn_calls`）照原计划 |
| REL-1 核心 12 项未通过的（10-27 清单） | 1⑤ 报告停止退款与确认、1② 兜底 B、7② 长对话删除、9③ >500 拒绝、10⑤ 周复盘：前四项由 V2-7a/V2-5/V2-9/V2-7b 直接解决并在 V2-11 e2e 覆盖；周复盘随复盘任务上线后 |

## 8. Owner 的决定

### 8.0 已定（2026-10-28，总控-13 转达）

Owner 原话：

> 普通对话（不是报告）中途不允许用户点停止，不提供这个功能。自动浏览器测试的费用我批准，用 claude haiku 5.5 模型做测试，这个省钱。其他的都按你的推荐做。

> 这次新路径设计好以后我希望未来扩容的时候能够无缝支持 500 人、2000 人、5000 人使用都不用再次重构了可以吗？所以这一次你的这个重构一定要找好正确的技术方案了。

落实范围（不是原话）：

- 决定 1 选 A：重做主路径，旧路径删掉。决定 2 选 A：100 人验收通过后 7 天内上线。3a–3e 全部同意。决定 4 选 A：评审团不给"结束评审"按钮。
- **普通对话（自由对话、定位导师）不提供用户停止**：前端去掉停止按钮，服务端不接受普通对话的停止请求，`turn_close` 没有普通对话的 `kind=stopped` 分支。
  报告的停止与 24 小时防刷规则（10-27）保留。本文 2.2、2.5、4.1、6.1（V2-7a/V2-8/V2-10/V2-11）已按此改。第 9 节问题 1 随之了结。
- V2-11 的 staging 自动浏览器测试用 Claude Haiku 5.5，每次运行 ≤ 0.5 美元，Owner 已批准费用。
- 扩容要求：新路径在 500 / 2000 / 5000 并发时只靠加规格和改配置扩，不再重构。本文新增 3.3 节回答，并把结构点写进 3.1 预算、7.1 守门和 6.1 PR 清单。
- 下面 8.1 保留当时给 Owner 的选项，供追溯；以上决定为准。

### 8.1 当时的选项（已决，仅追溯）

**决定 1：怎么重做**

- A（推荐）：**重做主路径，旧的删掉**。新写"开轮 / 记账 / 收轮"三步的数据库函数和一条 Node 流程，把定位导师、自由对话、报告、评审团、对比都接上，
  然后删掉旧 Runtime/BILL2 和 staging 测试窗口。好处：一轮往返从 40–60 次降到 4–7 次，主路径函数从约 330 个减到约 20 个，以后任何窗口都看得懂、改得动；
  坏处：约 7 周（乐观 5 周），期间不上新功能。
- B：**沿 DB-RW 方案继续改**（D/E/F + 分支化）。约 3 周；往返只能降到 12–18 次，940 个函数、62 张表的闭包还在，测试窗口的双路径还在，下一次改需求又会长回来。
- C：A 的范围，但先只做自由对话 + 导师（报告/评审团/对比暂留旧路径，上线后再迁）。约 5 周；新旧两套并存，正式库建库时要同时带两套表，和"旧路径删掉"的目标冲突。

可直接复制的话：`主路径按 A 重做，旧路径删掉。`

**决定 2：新的上线日期**

- A（推荐）：主路径通过 100 人验收后再定，现在只定"验收通过后 7 天内上线"。
- B：现在定固定日期（7 周 + 核心 12 项余下验收 ≈ 12 月中旬），到期没过验收就延。

可直接复制的话：`上线日期按 A，验收通过后 7 天内上线。`

**决定 3：五条规则的简化（第 4 节标"简化"的，都不改用户能感知的结果）**

- 3a 同一会话里一次只跑一轮；用户没等回复结束又发，前端排队。现在也是这样，只是改由会话行保证。确认即可。
- 3b 每日止损从"全站一把锁、绝不超一分"改为"允许最后一笔略超（最多一轮的上界，≤ 0.5 美元），超过后下一轮拒绝"。
  **10-28 审查后改述（2.5.1）**：改成"开轮按上界预占、收轮回补"后，当日实际花费**不会超过日限**（超额为 0，比原来承诺的还紧）；
  代价是接近日限时会**提前拒绝**，提前量 ≤ 预留带 B =（连接池大小−1）× 普通回合单轮上界 + 大额回合单轮上界，staging 现配置约 15 美元
  （池 8、普通 1.5、大额 5）。总控按这个新说法重新向 Owner 确认 3b。
- 3c 暂停回合与评审团押金的 24 小时自动结束，由同一个分钟级定时任务按 `turns` 表统一处理（规则不变，入口合一）。
- 3d 一轮冻结一次：开始一轮需要的可用积分从"一次调用的上界"变成"本轮最多几次调用的上界之和"（导师 2 次 + 整理 1 次）。
  - **2026-10-28 Owner 更正**：开始一轮仍按 10-01 的启动门槛 L（"余额够一轮正常费用就能开始"）；冻结 H=min(本轮上界之和, 可用余额)，一轮只冻结一次；`turn_call_begin` 在剩余冻结 < min(本次调用上界, L) 时暂停并提示充值。上面"开始需要的可用积分为上界之和"的说法作废。
  余额刚好够一次调用的用户，会在开轮时就被提示充值，而不是第一次调用后暂停；暂停与"继续"的规则不变。
- 3e 10-27 批的"结算放到回复结束后异步做"不再需要：新路径一轮只结算一次、就在回复结束时同步做，余额不会晚几秒。等于撤回那条取舍，按更好的结果执行。

可直接复制的话：`3a、3b、3c、3d、3e 都同意。`

**决定 4：评审团要不要给用户一个"结束评审"按钮**

10-17 定的是评审团不提供中途停止；10-27 的决定里又出现"用户点结束评审"。新路径两种都能做：
- A（推荐）：不提供，只有"评审完成"和"暂停超过 24 小时自动结束退押金"两个出口（和 10-17 一致，少一个入口少一类争议）。
- B：提供"结束评审"，走和 24 小时自动结束同样的结算。

可直接复制的话：`评审团结束按 A，不给按钮。`

## 9. 发现的问题（不在本任务范围，记给总控）

1. **已决（10-28）**：普通对话不提供用户停止（第 8.0 节），停止退款规则只剩报告一条；原问题了结。
2. 限流（项 30/49）的接线状态：§2.1 写"尚未生效"，后续没有生效记录，V2-4 接目录缓存时顺带核对。
3. 项 28 的单次回复接收上限 139264 字节（对应旧 8192 输出上限）与 10-07 的 32768 输出上限是否同步：#714 已改为 532480，§2.1 条目未更新。
4. 压测桩回执应标 `gen-load-`（缓存窗口建议），V2-1 落实。
5. `runtime_tool_calls` 114 万次顺序扫描、`runtime_executions.payload` 与 `bill2_runs.payload.input` 两份 20–33 KB 重复——随旧路径删除一并消失，不单独修。
6. 评审团固定价 1500 与报告 500 仍是"暂定"（10-17），本计划按现值做，后台键可改。

## 10. 资料出处

- 代码：`origin/staging` `4f6fbf995`（2026-10-28）；文内路径与行号均为该版本。
- 压测：DB-PERF 窗口共享笔记 `db-perf-round3-result-1026.md`（10-26 第三轮与本机回放对比）、总控转述的 10-27 复测（30 人 9–65%、三开关无改善）。
- 诊断：架构窗口 `db-rw-redesign-v1.md`（10-27）、`db-rw-chain-branch-plan.md`（10-28）。
- 缓存：缓存窗口 `prompt-cache-diagnosis-v1.md`（10-27，10-28 第 6 节）；PR #1500/#1501/#1502 交接。
- 规则：Master Plan §2.1（第 85–3003 行，10-28 逐条）；`docs/ENGINEERING.md`；`AGENTS.md`。
- 核心 12 项未通过清单：总控-13 `core12-open-1027.md`。
