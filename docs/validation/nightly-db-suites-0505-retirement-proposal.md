# 夜间数据库套件：因 0505 失效的第 3 类套件退役提案

状态：提案，**未删除任何东西**。每一条删除都要等总控逐条批准后另开 PR 做。
日期：2026-11-07。依据：总控 11-06 的夜间失败分类笔记（第 3 类 24 个套件文件）加上 #1793 里单独点名的 workspace-positioning，共 25 个文件，并对每个套件做了逐个核查。

## 这份文档回答什么

迁移 `0505_core_path_v2_drop_old_path.sql` 删除了旧 Runtime / BILL2 路径（15 张表、170 多个函数）。第 3 类套件的夹具或被测对象就是这条旧路径，0505 之后在夜间运行里失败。对每个套件写清三件事：

1. 它原来测什么行为；
2. 这个行为现在还在不在（哪些对象已删、哪些还在）；
3. 现在由哪个测试覆盖（写到文件和用例），没有就写"无"。

"现在还在不在"的依据是迁移和代码里的对象，不是运行结果；"现在由谁覆盖"只写读过的测试。这次**没有运行任何套件**，"为什么现在失败"是根据已删对象推断的。这些套件都在 `packages/db/tests/local-suites-excluded.json` 里（PR 的 CI 不跑它们），所以退役不会拿掉任何 CI 闸门，只影响夜间报告。

## 结论一览

| 建议 | 套件 | 数量 |
|---|---|---|
| **A. 可以退役**（行为已不存在，或已有现行测试覆盖） | mentor-history、mentor-history-purpose、native-metadata、runtime-view-perf、plain-text-stream、load-skill、work-items、workspace-positioning、workspace-posts、agent-core-r1 | 10 |
| **B. 退役前先确认或补一个小缺口**（大部分有覆盖，各有一两个边界没测） | agent-core-r9、content-material、content-source、library-references | 4 |
| **C. 退役前必须先补一个现行路径的用例**（涉及钱和数据，现行路径上缺一条链） | erasure-b2a、erasure-inflight | 2 |
| **D. 行为还在、没有现行覆盖：不退役，移植** | library-search（2 个文件）、workspace-benchmarks（剩余部分）、report-finalization、report-old-version、report-strategy-reads、report-visual-data、research-benchmarks、voice | 8 个套件（9 个文件） |

合计 25 个文件（10 + 4 + 2 + 9）。D 类不是"待退役"：它们测的行为还在，只是夹具是旧的，应当移植而不是删。

## 逐个套件

表头：套件 | 原来测什么 | 行为现在还在吗 | 现在由谁覆盖 | 建议 | 把握。路径都相对仓库根；`DB` = `packages/db`，`API` = `packages/api/src`。

### A. 可以退役

| 套件 | 原来测什么 | 现在还在吗 | 现在由谁覆盖 | 建议 | 把握 |
|---|---|---|---|---|---|
| mentor-history（0228） | 旧的导师历史读取函数：不列分段、按 id 读一段、字数和字节上限、别人和已结束的回合读不到、已删回答连带 | 不在：`runtime_mentor_history*`、`runtime_mentor_messages` 在 0505 删除。现行做法是把整段历史直接放进提示词 | `API/services/turn/mentorPrompt.test.ts:160`（只保留可见回复）、`mentorHostTurn.test.ts:52`（宿主事件不当用户的话） | 退役 | 高 |
| mentor-history-purpose（0245） | 旧函数只返回本草稿的导师回合、宿主 JSON 不当用户的话 | 不在：同上。"宿主 JSON 不当用户的话"这个风险还在，在提示词构造里 | 同上两个测试；`DB/tests/turn-core/plan-cases.mjs` 覆盖计划回合（未细读） | 退役 | 高 |
| native-metadata | 旧 `runtime_view` 返回白名单 `nativeMetadata` 字段、函数体漂移守卫、权限矩阵、性能 | 不在：`runtime_view` 已删，现行读取 `turn_session_view` 没有这些字段（在 `turn_session_view.sql` 里搜不到）；字段只留在 API/页面的显示代码里 | 读取本身：`API/services/turn/view.test.ts`、`DB/tests/turn-core/topic-cases.mjs` | 退役 | 高 |
| runtime-view-perf | 0158 对旧 `runtime_view` 的性能重写：五个函数的源码哈希、漂移守卫、回滚、权限观察 | 不在：被测函数全部已删 | 无（旧视图已删；新读取的性能由 `scripts/check-turn-budget.mjs` 一类承担，未细读） | 退役，但**必须保留 `local-db.mjs`**（见"必须保留的文件"） | 高 |
| plain-text-stream（0239） | 普通对话/Skill 回合的用户"停止"：纯文本前缀保存、已发出的调用只结算一次 | 不在：Owner 10-28 决定普通对话不提供中途停止（报告的停止保留）。数据库用 `TURN_STOP_NOT_ALLOWED` 拒绝 | `DB/tests/turn-core/recovery-local.mjs:453`（聊天和导师回合拒绝停止）、`turn-core/run-local.mjs:184`；报告停止：`turn-core/report-cases.mjs` 的 stop 用例 | 退役 | 高 |
| load-skill（0342） | `load_skill` 工具调用的认领/完成/重放、名字在准入时冻结、非自由对话拒绝、每个回合最多 2 次、结果必须是冻结的那个包 | 工具还在，但已纯 API 化；数据库里的日志、认领、重放对象（`runtime_tool`、`runtime_load_skill_*`）在 0505 删除，现行是"免费工具：没有行、没有读"（Owner 10-28） | 拒绝：`API/services/turn/tools/chatTools.test.ts`；上限常量：`skills/loadSkillTool.test.ts`（`MAX_SKILL_LOADS_PER_TURN` 为 2）；选中 Skill 的闸门：`turn/chat.integration.ts` | 退役 | 高（"第三次加载被拒"没有专门测试，只有常量） |
| work-items（0303） | 把定位读取、搜索、分段读取变成"工作项"行，固定顺序，最多 12 行，删文档立即删行 | 旧行表已删；现行是 `turns.steps` + `turn_session_view` + `turn_chat_steps_apply`，步骤不带名字，只有工具/状态/数量 | `API/services/turn/tools.integration.ts` 的 "TURN-STEPS" 用例（搜索显示步骤，关闭后保留，重载可读，外人和畸形步骤被拒）；删文档：`DB/tests/turn-erasure/run-local.mjs` "library deletion on the turn path" | 退役 | 高（"已关闭账号读 `turn_session_view` 被拒"没找到测试，风险低） |
| workspace-positioning（0218） | 工作区定位读取，核心是 0218 在已删的 `runtime_tool_calls` 上的触发器 | 触发器不在；"读工作区和自己的帖子"这个行为还在 | `API/services/turn/tools.integration.ts` 的 "read_source reads the workspace and own posts..." 用例 | 退役；**保留 `fixture.sql`**（`tools.integration.ts` 第 337 行加载它） | 中高 |
| workspace-posts（0306，B2 我的帖子） | 按套餐窗口（免费 14 天等）列帖子，约 30 个检查，几乎全在旧的日志/回执/历史机制上 | 旧机制已删；`posts_turn_read`、`runtime_workspace_post_window` 等还在 | 窗口和上限：`API/services/turn/tools/workspace.test.ts`；自己的数据和别人的隔离：`tools.integration.ts`；注销清理：`turn-erasure`、`erasure-post-f` | 退役 | 中（套餐窗口在数据库层没有测试，API 测试里是模拟的） |
| agent-core-r1 | 旧 `runtime_tool` 日志里的 `read_skill_file`：允许读、`../` 路径、多余参数、外人拒绝、伪造结果、重放、调用次数上限、取消、撤销、权限 | 日志机制已删；"模型读一个 Skill 文件"还在，在 `API/services/turn/skills/skillFile.ts` | `mentor.integration.ts:204`、`mentorPrompt.test.ts:132`、`skills/skillFile.test.ts:25`、`API/services/__tests__/modulePublication.test.ts:46` | 退役 | 高（伪造结果和单回合次数上限没有测试，它们是日志机制的细节） |

### B. 退役前先确认或补一个小缺口

| 套件 | 原来测什么 | 现在还在吗 | 现在由谁覆盖 | 没覆盖的边界 | 把握 |
|---|---|---|---|---|---|
| agent-core-r9 | `opc_content_reaction` 事件的重放/冲突/外人/D7 清理；话题草稿来自执行的来源；字段来源在 D7 时清理但保留用户自己的修改；所有 opc_/artifact_/runtime_ 基表都有 `created_at` | 反应事件表已删；`opc_data_events`、话题草稿、`opc_data_source_turn` 还在 | `DB/tests/turn-core/topic-cases.mjs`（删对话清事件和草稿、注销证明）；`mentor.integration.ts:241` 部分 | "D7 清自动值、保留用户独立修改"、`created_at` 审计，现行路径没找到 | 中 |
| content-material（0229） | `runtime_scope_material` 投影；内容保存不写材料；接近 2 万字保存；采用简报（`opc_brief_adoption`） | 简报采用已删；`runtime_scope_material` 还在 | `turn-core/topic-cases.mjs:219-245`、`work-result-cases.mjs:62-65`、`work-content-cases.mjs:235`、`API/services/opc/opc.integration.ts:4028` | 2 万字最终稿的边界没找到；旧数据的"只有头部的修订"回填是一次性迁移 | 中 |
| content-source（0276） | 派生内容 Skill 的来源：读最新定稿并记录版本、准入时冻结、不返回正文、缺失或不匹配拒绝、撤销后读取不可用、D7 删除；两条并发竞态 | 基于执行的 SQL 已删；回合上的派生来源还在（`API/services/turn/agent/contentSource.ts`、`opc_work_source`） | `chat.integration.ts:467`、`agent/contentSource.test.ts:9`、`turn-core/work-content-cases.mjs:61-71` 和 `:235` | "检查点 vs 删除""准入 vs 删除"两条真实双连接竞态；撤销来源后连带后代回合不可读 | 中（需要总控决定要不要移植这两条竞态） |
| library-references（0262） | `@` 引用：随执行冻结、最多 5 个、拒绝清单、分页读、16384 字节上限、每执行 8 次读、删除竞态、删除后传播、注销清理 | 引用表和旧函数已删；`library_turn_read`（0427/0483）还在，16384 字节上限在 SQL 里保留 | 删除和归属：`turn-erasure/run-local.mjs:417`；`tools.integration.ts:301`；`tools/source.test.ts:40` | `library_turn_read` 的分页、16384 字节上限、每回合读次数预算没有测试 | 中 |

### C. 退役前必须先补一个现行路径用例（钱和数据）

| 套件 | 原来测什么 | 现在还在吗 | 现在由谁覆盖 | 缺口 | 把握 |
|---|---|---|---|---|---|
| erasure-b2a | 0156：账号被注销（关闭）后，旧 BILL2 运行的财务恢复：关闭后的身份/准入拒绝、递归投影和重放、已送达结果关闭执行、未知结果保留预留、确认失败只退一次、迟到成本不重复扣、两个后端并发 | 旧资金路径已删（`bill2_*`、`runtime_financial_recovery`、`runtime_executions` 等）。还在的：`account_erasure_work_batch`、`account_erasure_financial_batch`、`account_erasure_scrub_turns`、`turn_close`、`turn_recover` | `turn-erasure/run-local.mjs` 第 13 块（注销资金：工作批次不列运行、把开着的回合算作待处理、关闭前清资金被拒、回合以 erased 关闭后放行）和第 8 块（开着的回合保留到关闭、回执保留计费）；`turn-core/run-local.mjs:198-218`（回执仍计费）和 `:~420-440`（等待注销提交的 `turn_open` 被拒） | **没找到**：账号被注销 + 回合一直没人关 + 由恢复任务 `turn_recover` 结算，断言"钱只结一次、之后内容被清、注销走到 closed"。凡是调用 `turn_recover` 的测试里都没有账号注销的情况 | 中 |
| erasure-inflight | 0160：注销批次处理在途 BILL2 运行：窄读/撤销、财务批次分页、已清除的未知结果只关自己的指针、终态资金仍可选、三后端并发恢复只结一次 | 同上；`account_erasure_financial_batch` 还在，但现在只返回计数（`items` 为空） | 同上 | 同上 | 中 |

建议补的用例（放在 `turn-erasure/run-local.mjs` 或 `turn-core/recovery-local.mjs`）：账号有一个运行中的回合和一条已计费回执 → 标记账号已删并写入 `account_erasure_requests` → 把回合放老 → 走 `turn_recovery_claim`/`turn_recover` → 断言回合只关闭一次、余额按预期只变一次（重放不再变）、`account_erasure_scrub_turns` 之后没有原文和消息、`account_erasure_financial_batch.totalPending` 为 0、阶段到 `closed`。补完这一条，两个旧套件才退役。`turn_close`、`turn_recover` 里看起来没有账号状态分支，行为大概率没问题，但没有测试证明。

### D. 行为还在、现行没有覆盖：不退役，移植

| 套件 | 原来测什么 | 现在还在吗 | 现在由谁覆盖 | 移植要点 | 把握 |
|---|---|---|---|---|---|
| library-search（`run-local.mjs`） | `search:<词>` 的中英文命中、2 字和 1 字匹配、别人/失败/非文本/已删文档不被搜到、空词/过多/过长拒绝、`%` `_` 字面匹配、第 4 次搜索 read_limit、索引填充 | `library_turn_read` 的 `search:` 分支还在（0427：ILIKE ANY、`similarity` 排序、每文档最多 3 条、LIMIT 8） | 只有 `tools.integration.ts:301`（搜到一个文档、别人得到空）和 `turn-erasure/run-local.mjs:417`（删除后搜不到） | 把搜索词相关用例移到 `library_turn_read` 的测试：中文和短词、字面 `%`/`_`、词数校验、命中数上限、索引填充 | 中高 |
| library-search（`postmerge-run-local.mjs`） | 完全相同标题的相似度先于 8 条上限、三个 GIN 三元组索引被用到、每文档上限 | 排序逻辑还在 0427 | 无 | 排序和索引使用的检查移到 `library_turn_read`。排序质量不是钱/数据/安全风险，总控也可以决定放弃；**没核对 0505 之后这三个 GIN 索引还在不在** | 中 |
| workspace-benchmarks（0299） | 已确认定位的对标表可列可读、未确认的新草稿不列、8000 字截断、已删回答的行不列、副本和旧触发器 | `runtime_workspace_source`（0484 改写）和 `workspace_turn_read`（0483）还在，截断在 8000 字；旧触发器和日志已删 | 部分：`API/services/opc/opc.integration.ts` "a free chat reads benchmarks a turn made..."；`tools.integration.ts` 的 read_source 用例 | 只移植剩余部分：对标表正文读取、8000 字截断、未确认草稿不列；副本和旧触发器的用例退役 | 中 |
| report-finalization（0206） | 报告定稿：公共角色拒绝、版本冲突、正文不可变、重放、两次并发编辑只有一个赢、确认快照变化作废、127 条来源定稿成 128、D7、注销 | 已经基于新的回合行（`turn-seed.mjs`）；只有两处还碰已删的 `runtime_executions`（`cases.mjs` 第 67-72 行和第 95 行） | 部分：`DB/tests/turn-core/report-final-cases.mjs`（定稿一次、重放、一条链接、删对话保留报告）、`turn-core/report-cases.mjs` | 删掉那两处旧执行的断言（"旧执行 id 被拒"已无意义）；`REPORT_VERSION_CONFLICT`、`REPORT_REQUEST_CONFLICT`、并发编辑、快照变化、127→128 容量现行没有测试 | 中 |
| report-old-version（0225） | 改版后旧报告仍可读可导出、生成绑定当前轮、工作项会话读自己发布的报告、来源撤回/删除/注销后隐藏或清理 | `report_source_for_read`、`opc_revise` 等还在；它自己的文件不碰已删对象 | 部分：`report-revision/cases.mjs`（另一个功能）、`turn-core/report-final-cases.mjs` | 手工 `opc_revise` 路径、`report_source_for_read`、改版后撤回来源，没有替代测试。**这次无法静态判断它现在为什么失败**，需要真跑一次 | 低中 |
| report-strategy-reads（0301） | 带策略数据的定稿报告按 `strategy_report:<id>` 读、字段、读取规则、>48000 字节按固定顺序丢整块、别人被拒 | 相关函数还在，分支活在 `workspace_turn_read`（0483）和 `runtime_workspace_source`（0484） | 只有模拟测试（`API/services/turn/tools/workspace.test.ts`、`chatTools.test.ts`），数据库层没有 | 去掉 `cases.mjs` 第 63 行的 `runtime_executions` 插入。**注意**：它会在最终目录上重放 0301，覆盖 0484 版本的 `runtime_workspace_source`；这个函数在 `packages/db/functions` 里没有文件，需要恢复步骤或去掉重放 | 中 |
| report-visual-data（0300） | 报告正文末尾的 `graylum-report-data` 块规则、手改必须保留生成块、定稿只在基准哈希匹配时存数据（`REPORT_DATA_INVALID`）、删除即清 | 函数都在（`report_body_parts`、`report_document`、`report_final_data` 等），只有夹具是旧的 | 无：`turn-core/report-final-cases.mjs` 里 `report_document` 的数据参数一直传 null；`REPORT_DATA_INVALID`、`report_body_parts` 只出现在这个套件里 | 夹具换成 turn-core 风格的报告回合 | 高 |
| research-benchmarks | 对标表只来自抓取证据、合格判定、少于 3 个合格拒绝出报告并冻结表哈希、对标不足卡（0320/0343）、关键词卡 3-10 个和相关性排序、未完成轮 | `research_*` 函数和表还在；夹具用的 `runtime_executions` 和 `bill2_calls` 文本探针已删 | 部分：`DB/tests/research-rounds/run-local.mjs`（轮次计数和卡资格）、`API/services/turn/mentor.integration.ts:705`（关键词卡）、`tools/rounds.test.ts:8`（纯 JS） | 合格判定、报告门槛和冻结哈希、`research_benchmark_shortfall_choose`、刷新替换行、对标行随注销清理、3-10 个关键词边界、相关性排序，现行都没有。迁移重放检查（0268/0315）可以丢；未完成轮部分可能已被回合版逻辑取代，没核实 | 高（行为在）/中（体量） |
| voice | `cases.mjs`：文风档案生命周期（语料、草稿→确认→编辑生成新版本、开关、语料变化标过期、源文档删除删版本）加一段已删的计费清理；`references.mjs`：运行绑定版本、删版本使进行中运行作废、`VOICE_PENDING_RESULT`；`visibility.mjs`：显示栅栏 | 档案函数还在；`voice_billing_scrub`、`voice_run_recovery`、`bill2_*`、`runtime_voice_references` 已删 | `references.mjs` 和 `visibility.mjs` 大部分已被覆盖：`turn-core/voice-cases.mjs`（删版本使回合作废、没有收费）、`turn-erasure/run-local.mjs:282,330`。语料、过期、确认规则：无 | `cases.mjs` 保留并删掉计费清理段（约 143-172 行）；`references.mjs` 只移植 `VOICE_PENDING_RESULT` 一例，其余退役；`visibility.mjs` 退役 | 高（后两者）/中（`cases.mjs`） |

## 必须保留的共享文件

套件目录里有被大量其它测试引用的文件，退役只能动各自的 `run-local.mjs` 等，不能整目录删：

- `packages/db/tests/erasure-b2a/cases.mjs`（导出 `rpc`、`closeAccount`、`fixture` 等）和 `erasure-b2a/fixture.sql`：约 85 个文件引用。退役 erasure-b2a 时只删 `run-local.mjs`、`concurrency.mjs`、`edges.mjs`、回滚、md5、delta json 和 README。
- `packages/db/tests/runtime-view-perf/local-db.mjs`：79 个文件引用（包括 `turn-erasure`、`erasure-post-f`、`scripts/check-turn-budget.mjs`、`scripts/loadtest/single-machine.mjs`），`scripts/tests/local-suites.test.mjs` 把它列为"不是套件"。
- `packages/db/tests/workspace-positioning/fixture.sql`：`API/services/turn/tools.integration.ts`（第 337 行）加载它。

退役时还要同步改 `packages/db/tests/local-suites-excluded.json`（`scripts/tests/local-suites.test.mjs` 会检查这个列表和目录一致）。

## 发现的问题（不在这份文档范围，没动）

- 疑似死代码：`API/services/turn/agent/mentorHistory.ts`（`mentorHistoryTool` 没有非测试调用）、`READ_HISTORY_TOOL`、`historyRead`（`runtimeContext.ts`）、`API/services/turn/admission/libraryAdmission.ts` 里的引用辅助函数（`LIBRARY_REFERENCE_LIMIT`=5、`LIBRARY_READS`=8，除自身文件外没有调用也没有测试）。
- 过期注释：`skills/loadSkillTool.ts` 头注释还说结果记在 `runtime_tool_calls`。
- 同样的旧夹具问题还影响没在第 3 类里评估的套件：`native-stop-view`（调用已删的 `runtime_view`）、`session-results`（用 `erasure-b2a` 的助手）。
- 第 3 类里"重放自己旧迁移"的几个套件（workspace-positioning、workspace-benchmarks、workspace-posts 等）还有一个共同原因：重放 0218/0299/0306 会在已删的 `runtime_tool_calls` 上建触发器，这一条本身就足以让它们失败，和夹具无关。

## 没验证的

- 没有运行任何套件，"现在为什么失败"都来自对已删对象的搜索。`report-old-version` 的失败原因静态读不出，需要真跑一次。
- 覆盖关系只写了读到的测试；`library-search` 的 GIN 索引在 0505 之后是否还在没核对；`workspace-posts` 的套餐窗口在数据库层没有测试。
- `agent-core-r9` 里 `created_at` 审计、`content-source` 的两条并发竞态是否要移植，是总控的取舍，我没有替总控决定。

## 建议的批准方式

总控逐条回复"退役 / 不退役 / 先补用例"即可。我建议先批 A 类（10 个，行为已不存在或有现行覆盖），再批 C 类的补用例，再看 B 类缺口要不要补。D 类走各自的移植任务。
