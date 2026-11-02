# CORE-PATH-V2 V2-12 删除旧路径：准备方案

状态：草稿，只读盘点和方案。**没有迁移、没有代码改动、没有碰 staging**；`content_erasure_ledger_owned` 的草稿只在本机临时库里验证过。
基线：`origin/staging` `6a10a0557`（#1583、迁移 0453 之后）。这是**第二次重算**：#1558（定位方案）、#1561（选题）、#1568（work_item C2）、V2-7b、日限补预占都已合并，初稿基线是 `3f82f0a25`。
依据：`CORE-PATH-V2.md` 的 V2-12 行、5.3、5.4 节；Owner 确认的顺序是：**不可逆的删除等 100 人压测通过后才做**。
逐项清单（表、外键、函数、Node 文件、调用方）在 `CORE-PATH-V2-DELETE-INVENTORY.md`，是脚本生成的；每个批次开工前、压测之后都要再重算（第 7 节）。

## 0. 一页结论

1. **删除的范围比 5.3 节写的大，不能"整体删目录"。**
   - 数据库：19 张待删表（5.3 的 18 张加 `runtime_session_names`），本机建库实测全是空表；**其中 `runtime_scope_material` 新路径还在用，要保留（0.5）**。
     201 个待删函数（其中 5 个素材相关的也要保留）。另有 **200 个不在删除名单里的函数引用了待删对象**（其中 126 个现在还有现役 Node 代码在调用；初稿是 190 和 120），
     25 条外键从保留的表指向待删表，3 个触发器挂在保留的表上却调用待删函数。不先处理这些，DROP 会直接失败或让调用报错。
   - Node：`services/runtime`、`services/bill2` 共 140 个非测试文件、230 个测试文件。其中 **95 个文件现在被新路径
     （`services/turn/`、`/api/turn/*`）、cron、`trpc.ts`、管理后台设置导入**，要先原样搬出去才能删目录。
   - 前端和 tRPC：`runtime`、`opc`、`fusionReview`、`fusionCompare` 四个路由下，前端仍在调用约 100 个过程
     （很多是 `corePathV2=false` 的分支，哪些在开关打开时还会被走到，要靠 C2 之后的实测请求统计确认）。
2. **5.3 节没覆盖的旧路径使用者**（它们现在还靠 BILL2 计费，不接新路径就删不掉 `bill2_*`）：
   评审团的 tRPC 与后台推进、"学习我的文风"（声音）生成、复盘（`publishMonitor` 的定时读取与复盘回合）、
   研究工具子调用的回执写入、注销时的财务恢复、管理后台的 BILL2 报表/卡住调用/止损页、三个 cron 的旧段。
   这些不是定位方案、选题、work_item、对比旧入口，是第二批阻塞项（第 3 节）。
3. **"C2 和压测一过就能一次删干净"仍做不到，但 #1558/#1561/C2 已合并，批次 A（搬迁）和 B1–B3 的前置条件已满足。** 能做到的是：把一次性的不可逆迁移缩到最小（第 4 节批次 F），
   前面的批次都是可逆的"先接走、再搬迁、再改写"。批次 B4 以后（对比、评审团、报告、声音、复盘、研究、后台）不依赖这三个 PR，可以并行排期。
4. **函数数 ≤ 450 的目标已不现实。** 现在是 1023 个（初稿 1006，5.3 写的是 939；增加的是 #1558/#1561/C2/0451 新函数），只删名单里的 201+7 个剩约 815 个；
   把能随旧消费者一起删的函数全算上也到不了 450（见第 6 节估算）。这个口径要总控请 Owner 重定，本文不改它。
5. **0.5 新路径还依赖旧的素材快照（C2 之后新发现，初稿没有）。** 定位方案、选题、work_item 三条新路径把用户素材存成快照，
   存在 `runtime_scope_material`，由 `runtime_material` 写入；`opc_library_edit`、`opc_handoff`、`opc_step_material`、`opc_topic_bind`、
   `opc_video_material_prepare`、`opc_work_ui_change` 六个函数直接调它，`opc/service.ts` 现役调用这些函数。新路径的 `topic_turn_source`、
   `opc_work_verify`、`opc_video_turn_check` 读这张表核对 `turns.policy` 里记的素材版本和哈希。所以这张表和 `runtime_material`、
   `runtime_work_projection`、`runtime_material_allowed` 不能按"待删"处理：要**保留**，并把它们对 `bill2_actor`、`bill2_scope_allowed`、
   `runtime_executions` 的引用改写掉（批次 C）。5.3 把它放在待删名单里，是 C2 之前的判断。
   新路径里还留着一批"旧路径同一请求已受理则拒绝"的检查（`turn_open`、`turn_plan_context`、`topic_turn_source`、`opc_data_source_turn`，
   源码里写着 "V2-12 drops this"），和 `opc_video_turn_check` 对旧执行历史的核对，它们读 `runtime_executions`，批次 C 里去掉。

## 1. 需要总控定的事（4 项，新增第 4 项）

| # | 要定什么 | 推荐 |
|---|---|---|
| 1 | 第二批阻塞项（声音文风生成、复盘、研究回执、评审团后台）怎么接：沿用 `turns`（新增 kind 或无工具回合），还是各自保留一套极简计费 | 沿用 `turns`，每块一个小 PR；不另建计费。声音、复盘各需要一个明确的 kind 和 `policy` 冻结字段，属于技术细节，不是新产品决定 |
| 2 | "函数数 ≤ 450" 改成什么验收口径 | **已定**（Owner 2026-11-02 "同意改口径"，记入 #1598）：待删名单清零 + 闭包棘轮不放宽，不再用总数 |
| 3 | 搬迁批次（批次 A，95 个文件的纯改路径）排在什么时候 | **已定并做完：#1597。** 找一个其他窗口静默的时段一次做完；中途不并行改这些文件 |
| 4 | 素材快照（0.5）：保留 `runtime_scope_material` 表和 `runtime_material` 并改写，还是把快照搬到新表 | 保留表、整段改写 `runtime_material`/`runtime_work_projection`/`runtime_material_allowed`，只去掉对 BILL2 和 `runtime_executions` 的引用；不搬数据、不改表名。改名可以放到删除之后另做 |

## 2. 现状：删除对象一览

| 类别 | 数量 | 清单位置 |
|---|---|---|
| 待删表 | 19（`runtime_scope_material` 要保留，实际删 18） | INVENTORY A |
| 指向待删表的外键（保留的表上） | 25 | INVENTORY B |
| 保留的表上调用待删函数的触发器 | 3：`credit_transactions` 上 `runtime_stop_loss_settled`、`runtime_stop_loss_settlement_lock`，`system_settings` 上 `runtime_stop_loss_settings_guard` | INVENTORY B |
| 待删函数 | 201（其中 80 个现在能从现役调用方走到；5 个素材相关的要保留，见 0.5） | INVENTORY C |
| 引用待删对象的保留函数 | 200（初稿 190）：已无入口 7、只用 `bill2_actor` 等通用小函数 47、要改写 74、随 BILL2 消费者改写或删 72（含 `atomic_settle`/`atomic_refund`）。新增的 10 个是 #1558/#1561/C2 的新函数和 `turn_open`，见 0.5 | INVENTORY D |
| Node：必须先搬出 | 95 个文件（`bill2` 21、`runtime` 74） | INVENTORY E.1 |
| Node：随旧消费者一起删 | 44 个文件 | INVENTORY E.2 |
| Node：已无导入 | 1 个（`bill2/receiptRetention.ts`） | INVENTORY E.3 |
| Node 测试 | 230 个 | 第 5 节 |
| 引用待删对象的 DB 测试 | 80 多处目录或文件（`payg` 41 个文件、`content-erasure` 18、`workspace-posts` 12 等） | 第 5 节 |

几个值得单独说的发现：

- **`bill2_actor` 只查 `profiles`（账号是否活跃），被清单里 93 个保留函数调用。** 删它等于重写这 93 个函数。
  建议保留并改名（例如 `account_active_check`）或原样保留；`bill2_scope_allowed` 同理要先看它依赖的
  `runtime_check_memo_*` 是否也要保留。这一条能把需要改写的函数从 200 个降到约 150 个。
- **5.3 节说"`atomic_*` 账本函数保留"，但 `atomic_settle`、`atomic_refund` 内部调用 `bill2_legacy_settle`/`bill2_legacy_refund`，
  并引用 `bill2_runs`/`bill2_calls`。** 它们不能删：`publish_monitor_publish_close`、`research_user_charge`、`artifact_reject_generation`
  和两个 `agent_slice_*` 函数还在调它们（社媒发布收尾、研究收费、报告生成被拒的退款）。所以它们要**整段改写成不依赖 BILL2**，
  这是 5.3 没写的一项（批次 C）。`atomic_finalize_ai_success/failure/abort`、`atomic_abort_settle` 已无任何调用，随迁移删。
  新路径用的 `atomic_pre_deduct`、`turn_settle_credits`、`credit_available` 本机核对过，源文本里没有 `bill2_*`、`runtime_*`。
- **`runtime_start` 不能删**（V2-12 行已写）。它要改写成内联 `bill2_actor`/`bill2_scope_allowed`/`bill2_create_draft` 的用途；
  `opc_start`、`opc_start_b1`、`runtime.start` 路由和 `services/opc/start.ts` 同批处理。
- **新路径自己依赖旧目录**：`services/turn/` 下 28 个文件导入 `runtime/`、`bill2/` 的模块（`runner`、`context`、`providerRequest`、
  `promptCache`、`settingsRows`、`newWorkGate`、`positioningGate`、`bill2/decimal`、`openRouterAdapter` 等）。
  `stagingPolicy` 还被 `turn/tools/plan.ts` 导入，`stagingEnvironment` 被支付页的 `methodCheckoutGate` 导入——V2-12 要删的
  `stagingPolicy`/`productionPolicy`/`rwV2` 得先把这些引用去掉。

## 3. 还在使用旧路径的消费者

"等什么"一列：三项新路径 PR（#1558 定位方案、#1561 选题页、C2 work_item 页面）**都已合并**，对应行改成"已合并，轮到我们"；**自有**＝本文新发现、没有对应 PR。

| 消费者 | 现状证据 | 阻塞删除的对象 | 等什么 |
|---|---|---|---|
| 定位方案生成 | #1558 已合并（`turns` 的 `plan` kind，`plan_turn_read`、`turn_plan_apply`、`turn_plan_context`）。定位页代码里 `opc.prepareStep`、`runtime.executeStream`、`opc.planResult`、`opc.planRequestState` 的旧分支和 hook 还在（`use-mentor-turn-path`、`use-report-gen` 按 `corePathV2` 分支） | 旧分支：`bill2_prepare`、`runtime_execution`、`runtime_admission_replay`、`opc_plan_*`。新路径自己还读：`turn_plan_context` 查 `runtime_executions`（"V2-12 drops this"）、`plan_turn_read` 用 `bill2_scope_allowed` | **已合并，轮到我们**：B1 删前端旧分支和 tRPC 过程；批次 C 去掉 `turn_plan_context` 对旧表的查询 |
| 选题页 | #1561、#1579 已合并（`turn_*topic*`，`topic_turn_source`）。选题页 `topics/page.tsx` 仍实例化 `opc.topicTurn`、`runtime.execute`，`opc.adoptTopics`、`opc.saveTopicDraft`、`opc.topicWorkspace` 各有调用 | 旧分支：`runtime_executions`、`opc_topic_*`、`opc_adopt_topics_with_source`。新路径自己还读：`topic_turn_source` 查 `runtime_executions` 和 **`runtime_scope_material`**（0.5） | **已合并，轮到我们**：B2 删旧分支；`runtime_scope_material` 保留 |
| work_item 会话与作品 | C1（#1559）、C2（#1568）已合并（`opc_work_verify`、`opc_content_from_turn`、`opc_video_results_from_turn`、`opc_work_source`）。`/app/runtime` 页仍有 `runtime.start/prepare/resume`、`opc.saveWorkResult`、`saveContentResult`、`prepareVideoMaterial`、`checkVideoExecution`、`saveVideoResults`、`workResults` 的调用 | 旧分支：`runtime_work_*`、`runtime_session_result_*`、`opc_work_*` 旧版、`opc_video_*execution*`。新路径自己还读：`opc_work_verify`、`opc_video_turn_check` 读 **`runtime_scope_material`**，后者还查 `runtime_executions` 和 `runtime_history_available`（旧内容版本的来历核对） | **已合并，轮到我们**：B3 删旧分支；`opc_video_turn_check` 对旧执行历史的核对要改成只认 `turns`，旧内容版本的 `execution_id` 视为没有来历 |
| 对比旧入口 | `ComparePicker` 调 `fusionCompare.options/estimate/start`；`CompareCard` 调 `read/stop/stream/adopt`（新入口 `turnList/turnRead/turnAdopt` 已在用） | `fusion_compare_*`（23 个，16 个引用待删对象）、`fusion_group_*`、`bill2_runs`、`fusion_billing_groups` | 自有：先确认 `/api/turn/compare` 是否已替换这 7 个调用；若没有，是前端改动 |
| 评审团（tRPC 与后台） | `fusionReview` 路由导入 `bill2/service`、`runtime/budget`、`realHost`、`stagingPolicy`；`services/fusion/{admission,background,recovery,reviewRecord,executor}` 导入 `bill2/service`；`fusion-recovery` cron | `fusion_review_*`（34 个，5 个待删、19 个引用待删对象）、`fusion_review_fees`、`bill2_*`、`fusion_review_fee_*` | 自有：V2-7b 已把回合改到 `turns`，但旧入口和推进函数仍在（`reviewRecord` 的类型里仍保留"回合字段为空即走 BILL2 路径"的分支） |
| 报告 | `runtime.reportStart` 等 10 个过程经 `services/report/{service,fees}` 走 `report_fees`、`runtime_executions`；V2-7a 的新入口是 `services/turn/report.ts` | `report_fees`、`report_fee_*`、`report_document*`、`runtime_executions` | 自有：前端按 `corePathV2` 分支，旧分支要删；`reportDocument`/`reportLatest` 这类读取要改读 `artifact_versions` |
| 声音（"学习我的文风"） | `services/voice/{admission,generation,recovery}` 用 BILL2 无会话 PAYG 运行；`billing-reconcile` cron 的 `recoverVoiceGenerations` | `bill2_create_draft/prepare/finalize/cancel`、`voice_billing_scrub`、`voice_run_recovery` | 自有（5.3 没提） |
| 复盘与社媒监测 | `publishMonitor/billedRead.ts`（TikHub 读取，BILL2 工具回合）、`reviews.ts`（定时复盘走旧执行器）、`reviewAdmission.ts`；`social-monitor`、`publish-monitor` cron | `publish_monitor_billed_*`、`publish_monitor_review_*`、`runtime_cancel`、`bill2_*` | 自有（#1481/#1483 在途，`CORE-PATH-V2.md` 的在途 PR 表写了"等 V2-12 后改写"） |
| 研究工具回执 | `research/runtime/{store,subcall}` 调 `bill2_record`；`research_runtime_*`、`research_user_*`（8 个，6 个引用待删对象）读 `runtime_executions` | `bill2_record`、`research_runtime_call_charge`、`research_runtime_link`、`research_user_*` | 自有：`store.ts` 里已写"已在 `turn_calls` 结算的子调用没有 BILL2 回执"，说明新路径已接，旧分支可删，但要核对 |
| 注销与内容删除 | `accountErasure/{processor,financialRecovery,content}` 调 `bill2_read/cancel/finalize`、`runtime_financial_recovery`、`runtime_execution_visibility`；`account_erasure_scrub_*` 引用 `bill2_runs/calls/receipts` | 27 个注销函数（INVENTORY D 注销） | 自有：V2-9 只加了 `turns` 一侧，旧一侧的删除/改写还没做 |
| 管理后台与 cron | `billingReport`（`bill2ByModel`、卡住调用、止损）、`adminStaleRounds`、`runtimeRateLimits`、`runtimeSettingsTestHarness`；`billing-reconcile`、`runtime-recovery` cron | `bill2_stuck*`、`runtime_stale_*`、`runtime_stop_loss_*`（3 个触发器）、`runtime_update_*` | 自有：止损设置 `stopLossSettings`/`rateLimitSettings` 新路径还在用，是**搬迁**不是删除 |

核对办法：C2 合并后，在 staging 跑一轮 V2-11 e2e（Codex 做），同时统计 tRPC 过程、cron 段和待删函数的实际调用；
没被调到的先删，被调到的回头找消费者。统计是读操作，但要在 Codex 浏览器批次期间由主窗口安排。

## 4. 分批顺序

原则：前面的批次只"加、搬、改"，对象都还在，随时能回退；**唯一不可逆的是批次 F，等压测通过**。
带迁移的批次都由总控上库，本文不分号。

| 批次 | 做什么 | 前置 | 可逆 | 能在压测前做 |
|---|---|---|---|---|
| A 搬迁 | 95 个仍在用的模块从 `services/runtime`、`services/bill2` 原样搬到 `services/turn/`（按用途分 `provider/`、`admission/`、`agent/`、`skills/`、`research/`、`settings/`）；只改路径和导入，不改行为；对应测试跟着搬 | **C2、#1558、#1561 已合并**；其他窗口静默 | 是 | 是 |
| B 接走 | 逐块把第 3 节的消费者接到新路径或删掉旧分支：B1 定位方案、B2 选题、B3 work_item（这三项的前置 PR 已合并）、B4 对比旧入口、B5 评审团旧入口、B6 报告旧分支、B7 声音、B8 复盘与社媒、B9 研究回执、B10 管理后台与 cron | B1–B3 已解锁；B4–B10 各自的等待项见第 3 节 | 是（旧对象都在） | 是，B1–B10 都可以在压测前做，只有 F 要等 |
| C 保留函数脱离旧表 | 把 INVENTORY D 里码 W、B 的函数整段 `CREATE OR REPLACE` 改写，去掉对待删表和待删函数的引用；小函数 `bill2_actor` 等先改名或确认保留；`runtime_start`、`opc_start*` 同批；**素材函数 `runtime_material`、`runtime_work_projection`、`runtime_material_allowed` 整段改写后保留（0.5）**；去掉新路径里"V2-12 drops this"的 `runtime_executions` 查询 | 对应的 B 批次 | 是 | 随 B 批次 |
| D 去外键和触发器 | 新迁移：去掉 INVENTORY B 的 25 条外键、3 个保留表上的触发器、引用旧列的检查约束与索引；保留表里没读者的 `bill2_*` 列删掉 | A、B、C 完成 | 外键可重建，删列不可逆（空表，影响为零） | 否 |
| E 回归 | 重算清单（第 7 节），确认待删对象的现役引用为零；跑全部本机套件 | D | — | 否 |
| F 一次性删除（不可逆） | 一个迁移：先 `content_erasure_ledger_owned` 整段改按 `turns`（第 6 节）→ DROP 待删函数 → DROP 待删表 → 删 `core_path_v2.enabled`、`runtime_rw_v2`、测试窗口设置；同一个 PR 删 `services/runtime`、`services/bill2` 剩余文件、旧 tRPC 过程、旧测试套件，把 `runtime_history_available`/`runtime_history_availability`（旧执行历史一律视为没有来历，草稿迁移 0462 在 #1617）和 `bill2_scope_allowed` 五层链（C3）的改写并进同一个迁移；改 ENGINEERING/ARCHITECTURE 文档、`local-suites-excluded.json`、指纹、闭包基线 | E，**100 人压测通过**，总控上库 | 否 | 否 |

批次 C 实测（2026-11-02，总控确认选 A）：C2（历史可用性只认 `turns`）、C3 在 F 之前做会让仍在 CI 里跑的旧路径套件（`billing.integration`、`runtime-history-perf`、`content-source`、`cron-idle-cost` 等）整体失败，所以不单独先做，并进 F，和旧套件、旧路径一起处理。已做的 C 项只有 0458（`runtime_work_projection` 不再读 `runtime_executions`）。依据：正式库新建不带旧数据，staging 只有测试数据，所以"旧历史没有来历"不是新的产品决定。

批次 F 的迁移开头按 5.4 写明：不可逆、staging 仅测试数据、正式库尚不存在。回退只能靠"V2-12 前关 `core_path_v2.enabled`"，F 之后没有。

## 5. 测试与护栏

- Node 的 230 个测试在 `services/runtime`、`services/bill2` 下。6.2 节要求"场景已迁移的才能删"：删之前在 PR 描述里
  列"旧场景 → 新测试"对照表，一个场景都不丢。盘点方法：对每个旧测试文件，列出它覆盖的待删函数，
  再在 `services/turn/` 和 `packages/db/tests/turn-core/` 里找覆盖同一行为的测试。
- DB 套件有 80 多处目录或文件引用待删对象，按类处理：
  - 场景在新路径有对应测试的（`turn-core`、`turn-fusion`、`workspace-posts` 的新路径部分）：删旧用例。
  - 注销与账本类（`erasure-*`、`content-erasure*`、`db100-recovery`、`erasure-ledger`）：不能删，改夹具从 `bill2_runs` 行改成 `turns` + `runtime_sessions` 行，断言保留。
  - 计费类（`payg` 41 个文件、`bill-unit`、`bill2-stuck*`、`receipt-retention`）：随 BILL2 一起删，先对照表。
- `scripts/tests/local-suites.test.mjs` 要求 `local-suites-excluded.json` 只能缩小：删套件时同步删条目。
- 机器人审查和 CI 对 F 批次的"关键验收"：所有保留表上的外键为零指向待删表；`pg_depend` 里没有保留对象依赖待删对象（DROP 不带 CASCADE，失败就是证据）；
  `node scripts/db-function-closure.mjs` 的棘轮只许变小；`packages/db/functions` 不再有待删文件。

## 6. `content_erasure_ledger_owned` 的改动方案

### 6.1 现状

`credit_transactions`、`billing_history`、`token_stats`、`ai_usage_logs` 上的 `zz_erasure_ledger_guard` 触发器（`erasure_ledger_guard()`）在每次写入时调
`content_erasure_ledger_owned(行)`，判断这一行账本是否属于一个**已删除内容的 BILL2 运行**：按行里的 `bill2_run_id`、`metadata.usage.runId`、
`metadata.runId` 查 `bill2_runs.id`，按行 `id`、`metadata.preDeductId` 查 `bill2_runs.pre_deduct_id`，且 `content_deleted_at` 非空。
`atomic_pre_deduct` 往 `billing_history` 插行会触发它，所以 `turn_open` 事务里多出 `bill2_runs` 的锁（V2-3 实测 9 把）。

### 6.2 新规则

新路径的账本行已经带着回合的标识，不需要 `bill2_runs`：

- `atomic_pre_deduct` 写的 `billing_history` 行：`metadata.requestId` = `turns.request_id`（`billing_history_pre_deduct_request` 是同一把键）。
- `turn_settle_credits` 写的 `credit_transactions` 和 `billing_history` 行：`metadata.turnId` = `turns.id`。
- "内容已删除"在新路径是会话的墓碑：`runtime_sessions.content_deleted_at` 或 `erased_at`（`turn_open` 用的是同一个条件，回合本身保留为账单记录）。

规则：行的 `user_id` 与 `metadata.turnId`（或 `metadata.requestId`）对应同一所有者的回合，且该回合的会话已被墓碑化，则账本行归属已删除内容。
查找都走现有索引：`turns_pkey (actor_id, id)`、`turns_actor_id_request_id_key`、`runtime_sessions` 主键；只读，不加行锁。
对 `token_stats`、`ai_usage_logs`：新路径不写这两张表，规则对它们恒为否，不影响。

### 6.3 草案（本机临时库验证过，不在迁移文件里）

```sql
CREATE OR REPLACE FUNCTION public.content_erasure_ledger_owned(j jsonb)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
 WITH binding AS MATERIALIZED (
  SELECT content_erasure_uuid(j->>'user_id') actor_id,
   CASE WHEN (j#>>'{metadata,turnId}') ~ '^[0-9]{1,18}$' THEN (j#>>'{metadata,turnId}')::bigint END turn_id,
   content_erasure_uuid(j#>>'{metadata,requestId}') request_id
 )
 SELECT EXISTS(
  -- OFFSET 0 keeps the identity lookup before the session filter, as the current text does.
  SELECT 1 FROM binding b CROSS JOIN LATERAL (
   SELECT session_id FROM turns WHERE actor_id=b.actor_id AND id=b.turn_id OFFSET 0
  ) t JOIN runtime_sessions s ON s.id=t.session_id AND s.actor_id=b.actor_id
   WHERE s.content_deleted_at IS NOT NULL OR s.erased_at IS NOT NULL
  UNION ALL
  SELECT 1 FROM binding b CROSS JOIN LATERAL (
   SELECT session_id FROM turns WHERE actor_id=b.actor_id AND request_id=b.request_id OFFSET 0
  ) t JOIN runtime_sessions s ON s.id=t.session_id AND s.actor_id=b.actor_id
   WHERE s.content_deleted_at IS NOT NULL OR s.erased_at IS NOT NULL
 );
$function$;
```

本机用 `run-db-baseline-replay` 同款的临时库验证了：

| 用例 | 结果 |
|---|---|
| 会话未删，按 `turnId`／按 `requestId` 查 | 否／否 |
| 会话墓碑后，按 `turnId`／按 `requestId` 查 | 是／是 |
| 另一个所有者带同样的 `turnId`、`requestId` | 否 |
| `user_id` 不是 UUID、`turnId` 不是数字、`requestId` 是数字、空对象 | 否，不报错 |
| 同一事务里调 `turn_open`，事务内持有的表级锁 | 现在包含 `bill2_runs`，草案后不再包含；其余表不变 |

没有验证的：真正替换后 `erasure-ledger`、`content-erasure-perf`、`db100-recovery` 三个套件的断言（要改夹具）；
EXPLAIN 计划（本机空库下看不出索引选择）；时间点（见 6.4）。

### 6.4 为什么只能放在 F 批次

只要 B 批次里还有消费者写 `bill2_runs`（#1558、#1561、C2 之前的旧路径，以及声音、复盘），把规则换成只看 `turns` 就会让这些行失去"按原始账本绑定"的保护。
所以不能提前单独上这个函数，也不能写成"新旧并存的 OR 版本"（两个分支的表都会被锁，锁数不降）。
它在 F 迁移里排在 DROP 之前，同一个事务内先改函数再 DROP 触发器依赖的表。

### 6.5 要同步改的测试和文件

- `packages/db/tests/erasure-ledger/`：夹具从 `bill2_runs` 改成 `turns` + `runtime_sessions`，保留"会话墓碑前后账本行是否被擦"的两侧断言。
- `packages/db/tests/content-erasure-perf/`（`assertions.sql`、`rollback*.sql`、`README.md`）：行代价断言按新规则重写。
- `packages/db/tests/db100-recovery/`（`seed.sql`、`ledger-cases.sql`、`run-local.mjs`）：账本种子按回合构造。
- 迁移注释写明：新旧代码是否兼容（F 之后旧代码已删）、可重复执行（`CREATE OR REPLACE`）、恢复方式（只能整体回退迁移前的 staging 数据，空表无数据损失）。

### 6.6 函数数估算

| 步骤 | 函数数 |
|---|---|
| 现在（含重载） | 1023（初稿 1006） |
| 删 201 个待删（其中 5 个素材函数要保留）+ 7 个已无入口 | 约 815 |
| 再删 B 批次里随旧消费者一起删的（INVENTORY D 里码 B 的函数中不再有现役调用方者，上限约 72） | 约 743 以上 |
| 5.3 的目标 | ≤ 450 |

差距来自 5.3 写的 939 没算到 `turn_*`、`fusion_review_*`、`opc_*` 等 V2-2 之后新增和长期保留的函数。结论见第 0 节第 4 条。

## 7. 重算方法与记录

**重算记录：**
- 2026-11-01 初稿，基线 `3f82f0a25`：1006 个函数，190 个保留函数引用待删对象。
- 2026-11-02 第二次，基线 `6a10a0557`：1023 个函数；引用待删对象的保留函数 200 个，新增的 10 个是 `opc_content_from_turn`、`opc_data_source_turn`、`opc_data_turn`、`opc_video_results_from_turn`、`opc_video_turn_check`、`opc_work_verify`、`plan_turn_read`、`topic_turn_source`、`turn_open`、`turn_plan_context`。待删表 19、待删函数 201、外键 25、触发器 3、Node 的 95/44/1 个文件和 230 个测试，**都没变**（新路径 PR 没改 `services/runtime`、`services/bill2` 的导入关系）。变的是：新路径开始依赖素材快照（0.5）。

做法：

盘点用的三段脚本不在仓库里，留在共享笔记目录 `side-session-notes/local_d8bc3b2c-63f9-44d5-a8ca-c002bb397c23/v2-12-inventory/`，原因：它们只服务这一次删除，不值得进 CI。要点：

1. 从文件建本机库（`packages/db/tests/runtime-view-perf/local-db.mjs`，要占 `db-slot.sh` 的名额），导出 `pg_class`、`pg_proc`、`pg_constraint`、`pg_trigger`、`pg_attribute` 到 JSON。
2. 对每个函数的源文本找对待删表名和待删函数名的引用（带 `\b` 边界），再用"现役 Node 里的字符串字面量"、"触发器函数"补出入口，得到哪些保留函数仍能从现役入口走到待删对象。
3. 对 `services/` 下所有 `.ts` 建导入图，从非旧消费者的文件出发，不穿过旧消费者，求 `runtime/`、`bill2/` 里仍可达的文件。

局限（本文没验证的）：
- 函数文本匹配是名字匹配，注释或字符串里的同名会多算；动态拼名的 `rpc(name)` 调用会漏。所以数字作为上限用。
- "现役 Node"包含了所有旧消费者自己；本文把它们当作现役，所以 200 里 126 个"有现役调用"不代表现在真的有人在用，要靠第 3 节的实测请求统计。
- 前端调用统计只数了 `trpc.<路由>.<过程>` 形式，用 `utils.` 或变量间接调用的可能漏数。
- 没读 staging 数据库，也没读任何日志：19 张表为空是本机从文件建库的结果，不是 staging 的行数。F 批次开始前要由总控核对 staging 的行数。

### 7.1 第三次重算（批次 F 之前，基线 `17607a9cf`，2026-11-03）

结论先说：**现役引用还没有清零，所以 F 现在写不出"最终"迁移。** 下面是脚本重算的数字（上次 80 个，现在 79 个，变化很小；B 批次大多还没合并）。

| 项 | 数量 |
|---|---|
| 待删函数 | 201；其中现在能从现役代码走到的 **79** |
| 其中有现役 Node 调用的 | **16**（下表） |
| 其中只被保留的 SQL 函数引用的 | 63（`bill2_actor`、`bill2_erasure_*`、`bill2_decimal` 等） |
| 引用待删对象的保留函数 | 188；能从现役走到的 **163**；已无入口 25（可直接删） |
| 指向待删表的外键 | 25（`runtime_executions` 14、`bill2_runs` 5、`bill2_calls` 5、`fusion_billing_groups` 2 和 `runtime_scope_material` 2 条） |
| 保留的表上调用待删函数的触发器 | 3（止损） |

有现役 Node 调用的 16 个待删函数，按要接走的消费者分：

| 消费者 | 待删函数 | 现役调用方 |
|---|---|---|
| 提供方服务（B10 的一部分，`turn/provider/service.ts`） | `bill2_cancel`、`bill2_claim`、`bill2_close`、`bill2_create_draft`、`bill2_finalize`、`bill2_prepare` | `services/turn/provider/service.ts`（新路径的提供方文件里还留着 BILL2 调用，要先查是不是死代码） |
| 注销（财务恢复） | `bill2_cancel`、`bill2_finalize`、`runtime_financial_recovery` | `services/accountErasure/processor.ts` |
| 复盘与社媒（B8） | `bill2_close`、`bill2_finalize` | `publishMonitor/billedReadLegacy.ts`（#1624 B8b 在途） |
| 对比与评审团（B4、B5） | `bill2_create_draft`、`fusion_review_fee_settle`、`runtime_workspace_source` | `fusion/admission.ts`、`fusion/compareAdmission.ts`、`fusion/reviewRecord.ts`、`fusion/compareLoad.ts` |
| 研究读取与工作区帖子（B9、新路径内） | `runtime_source`、`runtime_workspace_source`、`runtime_workspace_posts_visible`、`runtime_workspace_post_window`、`runtime_workspace_session` | `turn/research/sourceRuntimeTool.ts`、`turn/agent/workspacePosts.ts`（新路径自己在用，要改写不是删除） |
| 定位服务 | `runtime_session_context` | `opc/service.ts` |
| 账本 | `bill2_legacy_refund`、`bill2_legacy_settle` | 被 `atomic_refund`、`atomic_settle` 调用（批次 C 里整段改写） |

staging 上旧表的行数（只读查询，2026-11-03）：`runtime_executions` 4630、`runtime_session_history` 11907、`runtime_history_dependencies` 6825、`runtime_tool_calls` 1120、`runtime_session_batches` 4625、`bill2_runs` 4870、`bill2_calls` 7886、`bill2_receipts` 23936、`report_fees` 19、`fusion_billing_groups` 91；要保留的 `runtime_scope_material` 3019。**所以 F 必须带数据跑通**：25 条外键指向的行、`credit_transactions`/`ai_usage_logs`/`token_stats` 上的 `bill2_*` 列都有值，去外键和 DROP 之前要先决定这些列删还是置空（正式库未建，没有真实用户数据；staging 全是测试数据）。

周复盘 #1624（B8b，迁移 0467，未合并）用到的旧对象，F 要等它合并后收口：`runtime_cancel`、`runtime_executions`、`runtime_workspace_posts_visible`、`runtime_workspace_post_window`、`bill2_runs`（在 `publish_monitor_review_step` 里）；它自己也在把 `publish_monitor_review_*` 改到 `turns`，合并后这几处要重算。

对批次顺序的影响：
- F 必须等 B4、B5、B8b、B9 的 `turn` 侧改写，和批次 C 对 163 个保留函数的改写（其中 63 个只靠通用小函数连着）都做完。现在这两块的量是 F 之前的主要工作。
- 本 PR 只更新盘点数据（`CORE-PATH-V2-DELETE-INVENTORY.md`）和本节，**没有迁移、没有代码删除**；F 的迁移与代码删除按"清单清零"那一刻的盘点再写。

### 7.2 收缩：少改写，能删就不改（2026-11-03，总控要求）

做法：①"待删"名单里，源文本不碰任何待删表、也只调保留函数的，**移到保留清单，不改写不改名**（不动点算出，不是人工挑的）；
②保留函数里，只有"碰待删表或剩下的待删函数"的才算要改写；③再按"能否从现役入口走到"分：走不到的**随 F 一起 DROP，不改写**。
入口 = 现役 Node 的 RPC 调用、触发器、cron；脚本 `narrow.mjs`、`reach2.mjs` 在共享笔记目录（不进仓库）。

| 项 | 原数 | 收缩后 |
|---|---|---|
| 待删名单（按命名规则圈的） | 201 | **128**；另外 **73 个移到保留清单**（下面） |
| 其中走得到的（要先有人接走调用方或改写调用它的函数） | 79 | **37** |
| 其中走不到的（随 F 直接 DROP） | 122 | **91** |
| 引用待删对象的保留函数 | 188 | **124**（对收缩后的名单重算） |
| 其中走得到的（**必须整段改写**，或先把入口删掉） | 163 | **103** |
| 其中走不到的（随 F 直接 DROP，不改写） | 25 | **21** |

**保留清单（73 个，原在待删名单里）**，理由：源文本不碰待删表，只调保留函数；`runtime_*`/`bill2_*` 只是命名：
`bill2_actor`、`bill2_decimal`、`bill2_scope_allowed` 与它的 4 层 `_before_*`、`bill2_create_draft`、`bill2_revoke_draft`、`bill2_erasure_*`（4）、`bill2_financial_projection`、`bill2_outcome_projection`、`bill2_legacy_*`（6，**账务，单独批给总控审，见下**）、`bill2_payg_*`（9，价目与校验）、`bill2_public`、`bill2_tool_*`（2）、`bill2_unit_multiplier`、`bill2_calls_kind_guard`、`bill2_receipt_raw_scrub`、`bill2_run_erasure_guard`，
`runtime_material`、`runtime_work_projection`（和 `_before_opc`）、`runtime_material_allowed`（和 `_before_b1`）、`runtime_check_memo_*`（4）、`runtime_source`、`runtime_workspace_*`（4）、`runtime_session_results_*`/`runtime_session_result_title`、`runtime_session_names_owner_guard`、`runtime_stop_loss_*`（6，新路径止损在用）、`runtime_update_stop_loss`/`runtime_update_rate_limits`/`runtime_rate_limits_patch`、`runtime_rw_flag`、`runtime_set_stop_new_calls`、`runtime_capacity_marker_*`（2）、`runtime_admit_source_check`、`runtime_context_allowed_before_workspace`、`runtime_load_skill_*`（2）、`runtime_mentor_history_draft`。
注意：留下的函数里仍有名字带旧前缀的，F 之后可以另行改名（不是删除）。

**必须整段改写的 103 个，按业务分批（每批几十个以内，一批一个迁移，迁移号逐批向总控要）：**

| 批 | 业务 | 个数 | 谁 | 内容 |
|---|---|---|---|---|
| R1 | 定位/选题/work_item/素材 | 33 | 本窗口（拆 R1a 读/查询 17、R1b 执行侧 16） | 去掉 `*_from_execution`、`opc_data_execution`、`opc_result_link_available` 等对 `runtime_executions` 的旧分支（同 0458 的做法） |
| R2 | 注销/内容删除 | 25 | V2-9 窗口 | `account_erasure_*`、`content_erasure_*` 去掉旧 run/receipt 一侧 |
| R3 | 评审团/对比 | 22 | 视 B4/B5 结果：旧入口删了就**随 F 删**，不改写 | `fusion_*` |
| R4 | 复盘/社媒 | 6 | 复盘窗口（#1624 B8b） | `publish_monitor_review_*`、`billed_*` |
| R5 | 新路径回合 | 6 | 本窗口，mig-go 审，闭包不放宽 | `turn_open`、`turn_plan_context`、`turn_mentor_context`、`turn_report_admit`、`turn_stop`、`workspace_turn_read` 去掉旧执行检查 |
| R6 | 研究/报告/其他 | 8 | 本窗口 | `research_*` 4、`report_final_snapshot`、`report_model_window`、`topic_turn_source`、`voice_run_recovery` |
| R7 | **账务（总控亲审）** | 3 | 总控审 | `atomic_settle`、`atomic_refund`、`billing_reconcile_day`，加上上面保留清单里的 `bill2_legacy_*` 是否留 |

R1–R6 之间文件不重叠（函数不同），R2 给 V2-9、R4 给复盘窗口，本窗口做 R1、R5、R6。每批：本机跑相关套件和 `check-turn-budget`，闭包棘轮不放宽。
F（DROP）仍排最后，验收和复测通过、总控放行才做。

### 7.3 批次 F 删 Node 代码前的清单（2026-11-03，导入图重算）

方法：以 `apps/web/src/app`、`routers`、`trpc`、`services/turn` 为入口，沿导入走一遍，不穿过要删的 `services/runtime`、`services/bill2`。
结果：现役代码里还有 **34 处导入**指向这两个目录，删目录之前必须先清零：

| 现役文件 | 还在导入的要删文件 |
|---|---|
| `routers/opc.ts` | `runtime/libraryVisibility.ts`, `runtime/executionStream.ts` |
| `routers/runtime.ts` | `runtime/libraryVisibility.ts`, `runtime/nativeView.ts`, `runtime/workItems.ts`, `runtime/paygRuntime.ts`, `runtime/admission.ts`, `runtime/stagingTransport.ts`, `runtime/execute.ts`, `runtime/realHost.ts`, `runtime/actor.ts`, `runtime/defaultModel.ts`, `runtime/executionStream.ts` |
| `services/accountErasure/financialRecovery.ts` | `runtime/inflightFinancial.ts`, `runtime/stagingTransport.ts` |
| `services/fusion/admission.ts` | `runtime/paygRuntime.ts`, `runtime/paygPricing.ts`, `runtime/realHost.ts` |
| `services/fusion/compareAdmission.ts` | `runtime/realHost.ts`, `runtime/paygRuntime.ts`, `runtime/paygPricing.ts` |
| `services/fusion/models.ts` | `runtime/realHost.ts` |
| `services/opc/service.ts` | `runtime/waitingOrganizer.ts`, `runtime/admission.ts` |
| `services/publishMonitor/billedReadLegacy.ts` | `bill2/toolSubcall.ts` |
| `services/publishMonitor/reviews.ts` | `runtime/executorRpc.ts`, `runtime/admission.ts`, `runtime/execute.ts`, `runtime/stagingTransport.ts`, `runtime/realHost.ts` |
| `services/report/modelSettings.ts` | `runtime/realHost.ts`, `runtime/paygPricing.ts` |
| `services/report/service.ts` | `runtime/admission.ts`, `runtime/nativeView.ts` |

另外：
- `packages/api/src/services/opc/opc.integration.ts` 是 v3 工作台（`run-workbench.mjs` 的 opcMode）手动运行的集成套件，CI 不跑；它的 116 个用例里有 **73 个走旧路径**（旧执行、旧计划结果、旧视频流程，浏览器用例居多），其中调用 `planResult`、`saveResult`、`planRequestState`、`positionHistory`、`contentFromExecution`、`videoExecutionCheck` 等已删方法的，随旧路径在 F 一起删，并按第 5 节写“旧场景 → 新测试”对照表。
- `opc.saveWorkResult` 路由已收窄为只收 `turnId`；`services/opc/service.ts` 里 `saveWorkResult(executionId)` 的旧分支和 `opc_work_result`，随上面那个集成用例一起在 F 删。
- 静态无调用方的入口已分两批删：`opc` 路由 11 个（#1647）、`runtime` 路由 9 个（#1648）。

## 8. 发现的问题（不在本任务范围，已记录）

- `docs/runbooks/BILL2_V1_PENDING_READONLY.sql` 引用 10 个待删函数，删除时要一并处理。
- `stagingPolicy` 的引用不止旧路径：`services/turn/tools/plan.ts` 在用，与 5.3 "删 `stagingPolicy`" 相冲，需要先改。
- 管理后台的止损页（`runtimeRateLimits`）和 `runtime_stop_loss_*` 触发器是否还要保留，取决于新路径的 `daily_spend` 是否已经完全替代；本文按"搬迁"处理，未做产品判断。
