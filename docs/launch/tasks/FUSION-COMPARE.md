# FUSION-COMPARE：输入框里的多模型对比 — 实施方案

> 状态：实施方案（仅方案，2026-10-17）。这份方案只把已经确认的决定写细，不新增产品决定。
> **第 8 节 5 个问题 Owner 已全部决定（2026-10-17，原话见第 8 节和 Master Plan 第 2.1 节 2026-10-17 对比条目），正文已按决定写定。**
> 依据：[Master Plan](../MASTER_PLAN.md) 任务表 FUSION-COMPARE 一行；第 2.1 节第 50 项（默认勾选、用户可改、最少勾选数参数）、
> 第 51 项（对外叫"多模型专家评审团"、只给 Gold）、2026-10-12"评审团改为自研，复用对比模式的多模型并行能力"、
> 2026-10-14"各模型各自计费、各自取整"；第 4 节（Fusion）；第 10 节 D2、D3、D4；
> [FUSION 实施说明](FUSION.md)；[FUSION-REVIEW 实施方案](FUSION-REVIEW.md)（计费组、执行器、恢复，已合并）；
> [FUSION_PROFILE](../FUSION_PROFILE.md)（#1056，评审团计费档案）。
> 本文件只细化实现机制；产品规则仍以 Master Plan 和 FUSION.md 为准，两者有出入的地方见第 2 节末尾，FUSION.md 由 PR-4 同步（第 7 节）。

## 0. 大白话结论

1. **做什么**：Gold 会员在自由对话的输入框里点"多模型对比"，弹出的勾选框已经默认勾好管理员设定的一组模型，可以取消或换别的，
   数量在"最少勾选数"和"最多模型数"之间。发出后几个模型同时回答，每列各自逐字出现（手机上用标签切换）。用户选一个"用这个回答继续"，
   这一问一答就接回主对话；其余回答留在对话里可以展开看。
2. **复用什么**：评审团已经合并的计费组（0234）、不走会话的结果存储和删除注销（0235）、Fusion 执行器、每天的恢复对账、后台 Fusion 设置。
   对比只新增四块：对比的准入和设置、对比记录、"采用这个回答"写回主对话、对比界面。
3. **钱怎么算**：不新增收费口径。每个模型一个运行单，按普通边用边扣的名义费用各自结算、各自向上取整（Owner 2026-10-14）；
   成功返回才收费，确认失败不收，结果未知先保留这个模型的冻结（D2）。开始前显示"最多消耗 X 积分"，用户同意才发。
   余额要够这一组全部模型的上限之和才开始，不够就整组不发、充值后继续（Owner 2026-10-17 问题 2 选 A）。采用回答不调用模型、不收费。
4. **拆成 4 个 PR**：PR-1 数据库（high，迁移）、PR-2 服务端执行和采用（high，可能要迁移）、PR-3 对比界面和后台设置界面（ordinary，只改前端）、
   PR-4 计费档案、真实模型验收和文档同步（high，计费配置）。迁移编号开工时向总控申请。
   **顺序是 PR-1 → PR-2 → PR-4 → PR-3**：对比的计费档案写进 staging 之前，后台存不下可用的模型列表，前端没法在真实浏览器里验收，所以 PR-4 先于 PR-3。
5. **Owner 已定**（2026-10-17）：Q1 勾选框和回答显示后台配置的真实模型名称；Q2 余额要够整组上限才开始；
   Q3 第一版只在自由对话页放入口；Q4 方案 B 的放宽扩到对比用途，四个模型取证预算 2 美元。
   Q5 对比请求不加 Graylum 身份说明、不替换模型自报身份（和评审团的例外一样）。
   决定前，受影响的部分不开工（第 6 节）。

## 1. 目标、做完的标准、不做什么

- **目标**：按 Master Plan 第 4.1 节对比模式一列和第 2.1 节第 50 项，让有权限的会员在输入框里手动打开多模型对比：
  每次打开默认勾选管理员设定的一组模型；用户可以取消、自己搭配，范围受管理员允许列表和会员权限限制；
  后台参数"每次对比最少要勾选几个模型"由 Owner 调整，2 ≤ 最少勾选数 ≤ D3 的当前最多模型数，前端和服务端都校验；上线默认只给 Gold；
  第一版入口只在自由对话页（含在自由对话里用的其他 Skill），定位页不放（Owner 2026-10-17 问题 3 选 A）；对比结果接入删对话和账号注销。
- **做完的标准**：第 6 节每个 PR 的验收全部通过；FUSION.md 必测项里和对比有关的（1、4、5、6、7、8、9、10、17、18）按第 7 节新口径通过；
  staging 上用真实模型完整跑通至少 3 次对比（含一次采用、一次主对话已有新内容时改为引用、一次某列失败），每一次模型调用都能对上一条冻结和一条结算。
- **不做**：对比里开工具或联网（第 4.2 节"第一版不开放任何工具"）；把几个回答自动合成一个（那是评审团的汇总，不属于对比）；
  通用模型切换器（UI-MODEL 只显示 Auto，第 50 项）；正式环境开放和正式会员配置修改（AGENTS.md 第 1 节和第 51 项"实际修改配置前单独批准"，另行批准）；
  定位页入口（Owner 2026-10-17 问题 3 选 A，第一版不放）。

## 2. 现状盘点：评审团已经合并、对比能直接用的

依据 staging `90f14c94b`。

| 能力 | 在哪 | 对比能不能直接用 | 缺什么 |
| --- | --- | --- | --- |
| 计费组表、组领取（整组满额冻结或一个不建、按 `(组,步骤,尝试)` 幂等）、普通领取拒绝 Fusion 用途、先判定后结算 | `0234_fusion_billing_group.sql`；`fusion_billing_groups.kind` 已允许 `'compare'`（第 16 行），`fusion_purpose` 已含 `fusion_compare`（第 42 行） | 能。组领取不看 kind | 无 |
| 各运行单各自结算、各自取整 | 0234 对 `bill2_payg_finalize` 的改动 | 能 | 无 |
| 不走会话的结果表 `fusion_call_outputs`（按 call_id 存正文）、组记下来源会话 `source_session_id` | `0235_fusion_sessionless_storage.sql` 第 16–33 行 | 能 | 无 |
| 组准入 `fusion_group_admit` | 0235 第 79–136 行 | **不能**：第 86 行 `p_kind` 不是 review 就拒；只读 `review` 设置、只认 `fusion_review/fusion_summary` 阶段、只查 `allow_fusion_review` | 加 compare 分支（PR-1） |
| 删对话、删项目时连带清理组内运行单和结果；账号注销清 `fusion_call_outputs` | 0235 第 286–351 行 | 能：按 `source_session_id` 找组，不看 kind | 对比记录表要另外接（PR-1） |
| Fusion 执行器：每次调用前过 RATE-LIMIT callGate、单次调用不带工具、web 插件显式关闭、90000 B 输入上限、保存正文→判定→结算 | `services/fusion/executor.ts`、`request.ts`、`bill2/openRouterAdapter.ts` 第 27–30 行 | 能。`run` 已有 `onChunk` 参数，评审没用 | 对比的判定函数、流式转给浏览器（PR-2） |
| 组准入 TS 侧 `admitFusionGroup` | `services/fusion/admission.ts` | 部分：写死 `p_kind:'review'`、review 开关、review 允许列表（第 39、64、69–75 行） | 抽出共用部分，加对比入口（PR-2） |
| 每日恢复：过派发期限未派发的取消、已派发的查回执后结算 | `fusion_pending_financial_batch`（0235 第 210 行，不看 kind）、`recovery.ts` | 能 | `recovery.ts` 第 57–75 行"有正文没判定时重判"只覆盖评审，对比要加（PR-2） |
| 后台 Fusion 设置 | `system_settings` 键 `fusion_settings`，`services/fusion/settings.ts` 第 47–51 行 | 部分：只有 `compare.enabled` | 允许列表、默认勾选、最少勾选数、回答上限、单次最高预算、派发期限（PR-2/PR-3） |
| D3 最多模型数 | `system_settings` 键 `fusion_compare_max_models`（`0153` 第 44–55 行，2..8，默认 4）；后台 `FusionCompareSetting.tsx` | 能 | 无 |
| 会员权限 | `membership_plans.allow_fusion_compare`（0153）；`assertFusionEntitlement(...,'compare',...)`（`membershipEntitlements.ts` 第 102–116 行，已校验 2 ≤ 数量 ≤ min(D3,8)） | TS 能用；SQL 准入里还没查 `allow_fusion_compare` | PR-1 在准入事务里查 |
| 计费档案 `runtime_payg_staging` | `runtime/paygHostPolicy.ts` 第 23–24 行用途枚举 | **不能**：没有 `fusion_compare` 用途；#1056 的方案 B 证据只允许评审团用途 | PR-4（Q4 已定：方案 B 扩到对比用途） |
| 思考档位 | `runtime/reasoningAdmission.ts` 第 8 行：`interactive/organize/review/writing` | 对比按普通对话用 `interactive` 档位 | 无新用途，PR-2 核对 |
| 模型身份保护 | `modelIdentity/display.ts`：只有评审团界面例外，其他一律"模型 A/B/C" | 不能：对比要显示真实名（Q1 已定） | 加对比的显示例外（PR-2）；身份说明和自报替换按 Q5 不做 |
| 主对话历史版本号 | `runtime_sessions.revision`（`0106` 第 7 行，每次追加 +n）、`runtime_executions.history_revision` | 能：对比开始时冻结它，采用时比较 | 写回路径要新加（PR-1） |
| 前端按列状态、流式读取 | 评审界面是轮询事件，没有做出通用的每列组件；`mentor-turn.ts` 的 `readAgentTurn` 绑定 runtime 执行事件 | 不能直接用 | PR-3 新写一个对比列组件，借 big-AGI Beam 的每列状态机（#862） |
| 输入框 | `components/opc/work-composer.tsx`（UI-A，Tiptap，已合并）；`ModelSlot` 只显示 Auto | 能，在旁边加入口 | PR-3 |

**和规格的出入**（不改产品结果，只记一笔）：FUSION.md 和 FUSION-REVIEW.md 第 2.3 节写"每列一个附属会话"，
实际合并的是 0235 的"不走会话"做法（总控 2026-10-14 选 A）。对比照这个做：每个模型一个隔离运行单，挂进计费组，组记来源会话，
不建子会话，所以不会出现在对话列表里，也不会碰"会话同一时间只允许一个执行"（FUSION.md 必测项 1 自然满足）。

## 3. 设计

### 3.1 一次对比的流程

```
用户在自由对话页的输入框选好 Skill、写好问题 → 点"多模型对比"
  └─ 勾选框：默认勾选 = 后台默认组 ∩ 允许列表 ∩ 准入通过的模型；可以改，数量 ∈ [最少勾选数, D3]
  └─ 显示"最多消耗 X 积分"（compare.estimate），用户点"开始对比"
  └─ compare.start（一个数据库事务）：查开关、权限、数量、允许列表、熔断；冻结主对话历史版本号 R 和输入快照；
       建计费组（kind=compare，记来源会话）和 N 个运行单；整组领取一次（余额 ≥ 整组上界才全部冻结，否则返回"余额不足"、一个都不建）
  └─ 前端为每列各发一个流式请求 compare.stream({compareId, column})：服务端派发这一列的那一次调用，逐字转给浏览器；
       结束后保存正文 → 判定（有正文 = usable，没有 = no_delivery）→ 按边用边扣结算
       每列各自 300 秒期限，一列失败或超时不影响别的列
  └─ 全部列结束（成功 / 确认失败 / 结果未知）后，用户可以：
       "用这个回答继续"→ compare.adopt：主对话版本号仍是 R → 把"这一问 + 选中的回答"追加进主对话历史（不调用模型、不收费、按请求编号幂等）
                         主对话已经有新内容 → 不追加，提示"把这个回答引用到新消息里"（预填进输入框）或放弃
       也可以不采用：对比留在对话里可以展开看，不进入模型看到的上下文
```

### 3.2 输入快照

- 对比各列拿到**同一份**快照：当前 Skill 的指令（自由对话没有 Skill 时就是自由对话的系统指令）+ 主对话到版本 R 为止的历史 + 用户这次的问题。
  由宿主在 `compare.start` 时组装一次、冻结进每个运行单（和评审团一样写进 `payload.input.fusion.body`，`requestHash = sha256(body)`）。
- **Skill 由请求带上、服务端校验后冻结**：服务端会话不记"当前选的 Skill"（`runtime/page.tsx` 的选择只在页面状态和 localStorage 里），
  所以 `estimate` / `start` 和普通对话的 `runtime.prepare` 一样，接收同一个 Skill 选择字段（`services/runtime/admission.ts` 第 64 行
  `{kind:'skill', moduleId, revisionId}`，没有 Skill 时不传）。服务端用普通对话同一套校验（模块对用户可见、Skill 版本存在且用户有权使用，
  `databaseSkillSource` 的检查）读出这个版本的 Skill 指令，把 `moduleId`、`revisionId` 和指令哈希一起冻结进对比记录和每个运行单；
  校验不过就拒绝（`FUSION_COMPARE_SKILL_INVALID`），不退回"无 Skill"或上一次执行的配置。各列请求都用这一份冻结的指令。
  PR-2 验收：刚在输入框切换 Skill 就发起对比，各列请求里是新选的 Skill 版本；传一个用户看不到的模块被拒。
- 历史的读取复用 runtime 现有的"按会话读历史并裁剪到用途上限"的读取函数，口径和普通对话一样，不另写一套裁剪；裁剪后整份输入受 90000 B 上限（`FUSION_INPUT_CAP`）。
  超过就在冻结前拒绝并说明原因，不悄悄截掉问题本身。
- 不带工具：请求里没有 `tools`、`tool_choice`，web 插件显式关闭（复用 `fusionRequestBody`）。Skill 指令里提到的工具，模型没法调用；
  需要资料的由宿主事先读好（第一版只放快照里已有的内容，资料库附件沿用普通对话已经读进历史的那部分）。
- **当前工作材料（scopeMaterial）**：普通 Runtime 每轮除了历史，还用 `runtimeScopeInput(input, session.scopeMaterial, hostTurnContext)`
  （`services/runtime/admission.ts` 第 289 行）把会话当前的工作材料（例如选题简报）拼进本轮输入，这些材料不一定在历史里。对比的"用户这次的问题"
  一段直接复用同一个函数生成（自由对话没有 `hostTurnContext`），不另写拼接；把材料的 revision 和内容哈希冻结进对比记录和每个运行单，
  采用写回时核对材料 revision 没变（变了按"已有新内容"改为引用）。PR-2 验收：带选题简报的会话发起对比，各列请求里的本轮输入和同一时刻普通对话
  准入组装出的完全一致（测试比较两边结果）；材料改了之后采用被拒并改为引用。
- **工作区资料**：普通自由对话在会话有工作区时（`runtime_workspace_session` 为真，`services/runtime/admission.ts` 第 328–335 行）会给模型
  `read_source` 工具，按需读取用户已确认的定位、账号策略和选题。对比不开工具，所以改为**开始前由宿主读好、冻结进快照**：会话有工作区时，
  用 `read_source` 背后同一个读取函数把工作区资料读出（只读本人、当前版本），整份放进快照并冻结 revision 和哈希；放不进 90000 B 时整次拒绝
  （`FUSION_COMPARE_INPUT_TOO_LARGE`，提示用户在普通对话里问），不悄悄少给资料。采用写回时同样核对这些 revision 没变。
  PR-2 验收：有已确认定位、历史里从没读过的会话发起对比，各列请求里有这份资料；资料超上限时开始前被拒、不冻结积分。
- **定位前置检查（POSITIONING-GATE）**：普通 Runtime 准入时对没有定位的用户做两层检查（`services/runtime/positioningGate.ts`、`positioningFallback.ts`）：
  选了"与社交媒体相关"的 Skill 直接拒绝；其他请求先由 Decisions 判断，判为拦截就拒绝，判不准时主模型带兜底指令、回答兜底标记时这一轮不收费。
  对比在建运行单之前复用同一套：
  - 静态拒绝和 Decisions 判为拦截：`estimate` / `start` 直接返回同一个拒绝（引导去做定位），不建组、不冻结、不收费；Decisions 这一次判断的费用和普通对话一样由 Graylum 承担。
  - 判不准或 Decisions 不可用：每一列都带同一份兜底指令；某一列回答了兜底标记，这一列判定 `no_delivery`、不收费（成本由平台承担、计入熔断统计），
    其他列照常；全部列都是兜底标记时整次对比显示和普通对话一样的定位引导。
    **识别标记必须在保存之前**：现有 `fusionExecutor.run` 先 `fusion_call_output_save` 再判定，而 0235 不允许给已保存输出的调用写 `no_delivery`，
    照搬就会在恢复期限按 `unjudged_saved` 收费。所以带兜底指令的列，执行器像普通 Runtime 一样先缓冲开头、识别兜底标记
    （复用 `positioningFallback.ts` 的 `isPositioningRefusal`）：命中时不转发、不保存正文，直接写 `no_delivery` 结算为零；没命中才开始转发和保存。
    不带兜底指令的列照常边收边转。
  - PR-2 验收：没有定位的用户选社媒 Skill 发起对比被拒且余额不变；Decisions 判拦截时被拒且不建运行单；判不准时模拟某列回答兜底标记，该列不收费、其他列照常收费；该列没有 `fusion_call_outputs` 记录、判定是 `no_delivery`，到恢复期限也不会变成 `unjudged_saved`。
- 上下文容量：按每个模型的窗口分别检查"输入 + 回答上限"，装不下的模型在冻结前拒绝；用户勾选里有装不下的就整次拒绝并告诉用户是哪一个
  （不悄悄去掉，用户可以取消它再发）。复用 `measureCallInput` / `fitNativeRequestOutput`。
- **模型名称（Q1 已定，Owner 2026-10-17）**：勾选框和每列回答的标题显示后台配置的真实模型名称（`ai_models` 里管理员配置的名称，不另设显示名）。
  `modelIdentity/display.ts` 现在只允许评审团界面显示真实名，PR-2 加一个对比界面的例外（`FUSION_COMPARE_SURFACE`），只有 `fusionCompare.*` 接口能传，
  其他接口照旧只返回"模型 A/B/C"；采用写回主对话后，主对话里这条回答不再标模型名（按普通对话显示）。
- **身份说明和自报替换（Q5 已定选 A，Owner 2026-10-17）**：对比请求不加 Graylum 身份说明，也不替换模型在回答里的自报身份，和评审团的例外一致
  （组装请求时不调用加身份说明的函数，`compare.stream` 和保存都不过 `runtimeGuard` / `outputGuard` 的自报替换）。流式片段只做"原始帧 → 累计可见正文"的投影
  （`openRouterStream` 给回调的是原始 JSON 帧，不能直接转给浏览器）。采用写回主对话的正文保持模型原样；之后普通对话新生成的回答照常受身份保护。
  PR-2 验收：对比请求里没有身份说明；浏览器收到的是可见正文而不是协议帧；普通对话的身份保护行为不变（回归测试）。

### 3.3 模型清单和勾选规则

后台 Fusion 设置 `compare` 一组从只有 `enabled` 扩成：

| 字段 | 含义 | 校验 |
| --- | --- | --- |
| `enabled` | 对比总开关（已有），默认关 | — |
| `allowedModelIds` | 用户可选的模型（管理员允许列表） | 每个都要通过 `fusion_compare` 用途的准入（计费档案、线路、思考档位）；不重复；数量 ≥ 最少勾选数 |
| `defaultModelIds` | 每次打开默认勾选的一组 | ⊆ 允许列表；最少勾选数 ≤ 数量 ≤ D3 |
| `minModels` | 每次对比最少勾选几个（第 50 项新参数），默认 2 | 整数，2 ≤ `minModels` ≤ D3（`fusion_compare_max_models` 的当前值） |
| `answerOutputTokens` | 每列回答长度上限（含思考 token），随运行单冻结 | 默认沿用普通对话的回答上限 |
| `maxBudgetUsd` | 单次对比最高预算（第 4.5 节） | 超过时开始前拒绝，提示少选几个 |
| `dispatchMinutes` | 领取后多久没派发就取消（同评审团，默认 10 分钟） | 1..60 |
| `breaker` | 平台承担熔断，复用评审团同一套 7 天统计（见第 3.6 节） | 同评审团 |

- **D3 改小后的一致性**：管理员把 D3 调到低于 `minModels` 或默认组数量时，保存 D3 的接口拒绝并提示先改对比设置（D3 和对比设置是两个键，
  两处保存都互相校验）；`compare.start` 准入时再按当时读到的 D3 校验一次，不合规就拒绝，不会让用户发出超过 D3 的对比。
- **前端和服务端都校验**（第 50 项）：勾选框不让勾少于 `minModels`、多于 D3、允许列表外的模型；`compare.start` 在数据库事务里按冻结的设置再校验一遍，
  直接调接口也一样被拒（`FUSION_COMPARE_TOO_FEW` / `FUSION_COMPARE_TOO_MANY` / `FUSION_COMPARE_MODEL_NOT_ALLOWED`）。
- **默认勾选里有模型暂时不可用**（被管理员移出允许列表、准入失败）：打开时只勾可用的；不够 `minModels` 时按钮置灰并提示"请再勾选 N 个"，不自动替用户补选。
- 开关、权限、设置都在创建执行时读取并随运行单冻结（FUSION.md 必测项 17、18）；进行中的对比按创建时的设置完成并结算。
- 入口范围（Owner 2026-10-17 问题 3 选 A）：第一版只在自由对话页（含在自由对话里用的其他 Skill）放入口，定位页不放，上线后看反馈再加；
  取代第 4.1 节"自由对话或使用任何 Skill 时"在第一版的范围。以后要加定位页时按第 3.8 节的做法另开任务。
- 会员权限：`allow_fusion_compare`。上线默认只给 Gold（第 51 项）；**本任务不改正式和 staging 的会员配置**，实际修改前由总控单独请 Owner 批准，
  PR-4 验收用 staging 的测试会员。开关关闭或没有权限时：开关关 → 输入框不显示入口；没权限 → 显示入口但点开是升级提示（第 4.1 节"没有权限的会员看到升级提示"），服务端照样拒绝。

### 3.4 对比记录和"采用这个回答"

- **对比记录表**（新表，理由：对比的产品状态——属于哪个对话、冻结的历史版本 R、用户的问题、勾了哪些模型、每列结局、采用了哪一列——
  不是计费状态，`bill2_runs` 只放钱，`fusion_call_outputs` 只按调用存正文，现有表放不下；和评审团的 `fusion_reviews` 是同样的理由）：
  `fusion_compares(id, actor_id, session_id, group_id, request_id, history_revision, question, models, state, adoption, created_at)`，
  `UNIQUE(actor_id, request_id)`；`state` ∈ `running / finished / stopped`；`adoption` 只能写一次（采用的列、写回的版本区间，或"已引用"）。
  正文不重复存，各列回答从 `fusion_call_outputs` 读。
- **采用写回**：`fusion_compare_adopt(actor, compareId, column, requestId)`，一个事务里：
  1. 锁会话，核对会话没被删、`runtime_sessions.revision = 冻结的 R`、会话当前没有进行中的执行（`active_execution` 为空）、该列判定是 `usable`；
  2. 把"用户问题 + 选中的回答"按普通对话历史条目的格式追加进 `runtime_session_history`，`revision` +2；
  3. 记 `adoption`。同一 `requestId` 重放返回同一结果；已采用过别的列时拒绝（`FUSION_COMPARE_ADOPTED`）。
  - 现有追加路径 `runtime_session_items('append')` 要求一个正在跑的执行和打开的计费运行单，所以采用不能直接用它。
    做法：写一条不计费的"采用"执行记录（`runtime_executions.billing_run_id` 本来可以为空，状态直接 `completed`，`payload` 标记 `kind: fusion_adopt`），
    历史条目挂在它上面，满足 `runtime_session_history.execution_id NOT NULL`。PR-1 开工时先核对所有读 `runtime_executions` 的地方
    （对话列表、计费核对、恢复、删对话、注销、草稿续接）对"没有运行单的已完成执行"都安全；有任何一处不安全，就在 PR-1 里一起处理并加测试，
    不改普通执行的行为。
  - 主对话已有新内容（`revision ≠ R`）或正在跑执行：返回 `FUSION_COMPARE_STALE` 和引用文本，前端把选中的回答作为引用预填进输入框（FUSION.md 必测项 4）。
    这一步**不改** `adoption`，引用不算终态：用户刷新、关页面、清空输入框，或带引用的消息后来在执行或保存时失败，都可以再点"采用"重新拿到引用文本；
    引用只是把文字预填进输入框，发出后就是一条普通消息，照普通对话收费，不和对比记录绑定。`adoption` 只在第 2 步直接写回成功时记一次。
    PR-1 验收：STALE 后不发消息、或发出的消息执行失败，再次采用仍返回引用文本；直接采用成功后再采用被拒。
- **显示顺序**：对比卡片按创建时间插在对话里（读对话时把本会话的对比记录和历史条目按时间合并显示）；没采用的回答只给人看，不进模型上下文。
- **同时进行的对比**：同一用户同时最多一个进行中的对比（数据库唯一约束，含"还有已派发、未收尾的对比调用"），口径和评审团一样，
  防止在多个对话里并发开对比再一起断流来绕开熔断。和评审团的关系：现有 `fusion_review_start` 在用户有任何 Fusion 调用在途时拒绝（0236 第 111–114 行），
  对比在途时也开不了评审，反过来对比也查评审在途；两者都只是"等上一个结束"，页面提示"上一个多模型任务还在进行"。

### 3.5 流式和停止

- 评审团是服务端自己推进（`/api/fusion/advance`）、页面轮询；对比要每列逐字出现，所以改为**前端每列发一个流式请求**（#862 原结论"客户端各发一个请求"）：
  `compare.stream` 用和 runtime 一样的异步生成器 tRPC mutation，加进 `apps/web/src/trpc/provider.tsx` 第 104 行的流式白名单；
  服务端调 `fusionExecutor.run(..., onChunk)` 把片段转出去。同一列同一尝试只派发一次：重复请求（刷新、重连）不新派发，
  已有正文时直接返回已保存的正文，正在派发时返回"进行中"、前端轮询 `compare.read` 直到结束。
- 浏览器在某列派发前关掉：这一列的调用过了派发期限（默认 10 分钟）由每日对账取消、退回冻结、不收费（复用评审团的恢复批次，不新增定时任务）；
  用户在期限内回来，前端对没派发的列重新发 `compare.stream`。最坏冻结约 1 天，和评审团一致。
- 停止：`compare.stop` 在一个事务里锁对比记录、设为 `stopped`，取消还没派发的列（退冻结、不收费）；已派发的列按 BILL2"派发后取消"口径
  （`user_stopped`，按已知用量结算，不免费）。每列也可以单独停（只停这一列的运行单）。
- 判定：对比是自由文本，没有格式检查。宿主判定只有两种：正文非空 → `usable`；没有保存下正文 → `no_delivery`。
  到恢复期限仍没写判定但正文已保存的，按现有 `unjudged_saved` 口径收费；PR-2 把 `recovery.ts` 的"有正文没判定时重判"扩到对比，
  这样对比的判定和不中断时一致。

### 3.6 计费（不新增收费口径）

- **每个模型一个运行单**，用途 `fusion_compare`，按普通 BILL-PAYG 名义费用规则（第 2.1 节第 41 项）和该模型的倍数各自结算、各自向上取整（Owner 2026-10-14）。
  单个调用的上界照旧 = `输入上限 × 输入单价 + 回答上限 × 输出单价`（`runtimePaygCall`）。
- **一组的上界** = 勾选的每个模型上界之和（FUSION-REVIEW 第 3.2 节"Fusion 多模型单次上界"的同一定义）；对比只有一组、一次领取。
- **余额门槛（Q2 已定选 A，Owner 2026-10-17）**：可用余额 ≥ 整组上界才发出，否则一个都不建、提示"余额不足，充值后继续"。
  直接用 0234 组领取现成的"整组满额冻结"，不改计费底座；取代第 4.4 节对对比适用的"按估算上界和可用余额较小值冻结"（Master Plan 第 2.1 节 2026-10-17 对比条目）。
- **三种结局**（D2、第 4.4 节）：成功返回计入应收 `min(名义费用, 冻结额)`；确认失败不收费（供应商仍收费时成本入账、平台承担）；
  结果未知只保留这一列的冻结，其他列先结算、先退多余冻结，页面显示"某模型的结果待核对，暂时冻结 N 积分"（必测项 6、7）。
- **运行前预告**：`compare.estimate` 按勾选模型各自冻结的积分（各自取整、各自倍数）加总显示"最多消耗 X 积分"；`compare.start` 带上用户看到的数，
  准入时重算，超过就拒绝并让用户重新确认（价格或倍数中途变了，不突破用户看到的上限；做法同评审团 #962 的 `estimateCredits`）。
- **单次最高预算**：`maxBudgetUsd` 超过时开始前拒绝。
- **平台承担熔断**：对比里应收为 0 的结局只有 `no_delivery` 和 `erased_before_verdict`，仍可能被反复触发（例如故意断流）。
  复用评审团的 7 天统计 `fusion_review_breaker_usage`（它本来就统计所有 Fusion 组内调用，对比也算进去），对比准入也查同样的上限，
  达到后不能开新对比、进行中的照常收尾。上限是技术参数，后台可调，不改变正常收费。
- **采用不收费**：不调用模型，不建运行单。
- **月度积分释放、退款发生在冻结和结算之间**：每个运行单走现有 PAYG 处理，PR-1 加测试（必测项 8、9）。
- **只在 staging 测试窗口里跑**：Fusion 运行单目前都冻结成 `mode: 'staging_test'`、走 `newWorkGate(admin,'staging')`，对比也一样；
  正式环境开放随 RUNTIME-PROD / REL-1 另行批准。

### 3.7 删除和注销

- 删一个对话（或整个项目）：现有 0235 按组的 `source_session_id` 已经会取消、结算、清洗组内运行单并删 `fusion_call_outputs`；
  PR-1 在同一处加删 `fusion_compares`（问题正文在这张表里）。"采用"写进历史的条目随会话历史一起删（现有逻辑）。
- 账号注销：`account_erasure_scrub_content` 和 `account_erasure_body_remaining` 加 `fusion_compares`；`processorContracts.ts` 第 46 行的清单同步。
- 计费组和组步骤行是钱的记录，照旧不删（和评审团一致）。
- 删对话后：读不到对比和各列回答；不能再保存、采用、开始新对比；还没派发的调用退回冻结，已派发未知的按 FUSION-REVIEW 第 3.3 节保留冻结、
  等迟到回执或恢复流程按 `user_stopped` 结算。

### 3.8 定位页的对比（第一版不做，Owner 2026-10-17 问题 3 选 A；以后加定位入口时的参考做法）

定位导师的一轮不只靠会话历史：`opc.prepareStep`（`services/opc/service.ts` 第 188–241 行）每轮还按草稿现场组装宿主上下文——
当前步骤、冻结的字段和确认状态（`runtime_session_context` 的 `scopeMaterial`）、`hostTurnContext`、`stableAdditionalInstructions`
（`agentTurnInstructions + existingPositioningInstructions`）、material revision 和 turn token，以及按步骤的 Skill 资源和导师的读 Skill 文件工具。
只用"会话历史 + Skill 指令"会让各列脱离当前草稿和流程约束，用户会为不对题的回答付费，所以定位页不能套第 3.2 节的自由对话快照。做法：

- 定位入口的请求带 `{ draftId, stepId }`，服务端按普通导师轮同一套校验（草稿属于本人、步骤是当前步骤、`runtime_session_context` 的 material revision
  和 round 与草稿一致，否则 `OPC_CAPTURE_MATERIAL_MISMATCH` 同类拒绝），**复用** OPC 组装宿主上下文的函数：把 `prepareStep` 里组装
  `hostTurnContext` 和导师附加指令的部分抽成纯函数，普通导师轮和对比共用，不复制一份。对比不消耗 turn token（它不推进流程），
  只把 material revision 冻结进对比记录。
- 对比不开工具（第 4.2 节），导师平时用工具读的 Skill 文件改为宿主按当前步骤的 `skillResources` 事先读好放进快照；
  研究工具、整理调用都不进对比。放不进 90000 B 就在冻结前拒绝。
- 采用写回除了第 3.4 节的检查，还要求草稿的 material revision 仍等于冻结值、没有进行中的导师轮；否则按"已有新内容"改为引用。
  采用只写对话历史，不确认、不改右侧字段，字段仍由下一轮导师按定位流程处理。
- 验收：定位页发起的对比，各列请求里有和同一时刻普通导师轮相同的宿主上下文（用测试对比两边组装结果）；改了草稿后采用被拒并改为引用；
  采用后右侧字段不变。
- 这部分要动 `services/opc/service.ts` 和定位页，和改这两处的在途 PR 排队。

## 4. 接口

| 接口 | 作用 |
| --- | --- |
| `fusionCompare.options({ sessionId })` | 返回能不能用（开关、权限）、允许列表（显示后台配置的真实模型名称）、默认勾选、`minModels`、D3 |
| `fusionCompare.estimate({ sessionId, skill?, question, modelIds })` | 校验 Skill、数量和输入大小，返回"最多消耗 X 积分"和装不下的模型；`skill` 同 `runtime.prepare`；第一版不收 `positioning`（第 3.8 节只作以后参考） |
| `fusionCompare.start({ sessionId, requestId, skill?, question, modelIds, estimateCredits })` | 校验并冻结 Skill 版本、准入、冻结、整组领取；按 `requestId` 幂等；余额不够返回 `waiting_credits`、一个都不建 |
| `fusionCompare.stream({ compareId, column })` | 派发这一列并逐字返回；重复调用不重复派发 |
| `fusionCompare.read({ compareId })` | 每列状态（排队 / 生成中 / 成功 / 失败 / 待核对 + 冻结积分）、正文、采用状态；刷新后恢复用 |
| `fusionCompare.stop({ compareId, column? })` | 停整组或某一列 |
| `fusionCompare.adopt({ compareId, column, requestId })` | 写回主对话；主对话已有新内容时返回 `FUSION_COMPARE_STALE` 和引用文本 |
| `fusionCompare.list({ sessionId })` | 这个对话里的对比卡片，按时间和历史合并显示 |
| `fusionSettings.update`（扩展） | 保存 `compare` 新字段，按第 3.3 节校验；`fusionSettings.models` 增加对比用途的准入结果 |

拒绝代号：`FUSION_COMPARE_DISABLED`、`FUSION_COMPARE_FORBIDDEN`、`FUSION_COMPARE_TOO_FEW`、`FUSION_COMPARE_TOO_MANY`、`FUSION_COMPARE_MODEL_NOT_ALLOWED`、
`FUSION_COMPARE_INPUT_TOO_LARGE`、`FUSION_COMPARE_PRICE_CHANGED`、`FUSION_COMPARE_BUDGET`、`FUSION_COMPARE_ACTIVE`、`FUSION_COMPARE_BREAKER`、
`FUSION_COMPARE_STALE`、`FUSION_COMPARE_ADOPTED`、`FUSION_COMPARE_SESSION_GONE`、`FUSION_COMPARE_SKILL_INVALID`。前端映射成大白话提示，不显示原始错误。

## 5. 和其他任务的关系

| 任务 / 在途 PR | 关系 | 先后 |
| --- | --- | --- |
| FUSION-REVIEW（已合并）、#1056 FUSION-PROFILE（在途，改 `paygHostPolicy.ts`） | 复用计费组、执行器、恢复、设置；PR-4 也要改 `paygHostPolicy.ts` 的用途枚举和档案规则 | PR-4 排在 #1056 合并之后；PR-1–PR-3 不碰 `paygHostPolicy.ts` |
| 改 `admission.ts`（Fusion） | PR-2 把 review 写死的部分抽成共用 | 开工时确认没有别的窗口在改 `services/fusion/*` |
| UI-A（输入框已合并）、UI-B/UI-C、R8a、SKILL-I18N-HOOK #1027 等改 `work-composer.tsx` 或 `runtime/page.tsx` 的 PR | PR-3 要在输入框加入口、在对话页加对比卡片 | PR-3 开工前由总控判断有没有同时改这两个文件的 PR，有就排队 |
| MODEL-IDENTITY-GUARD（已合并） | 给对比加例外：显示真实名（Q1）、不加身份说明、不替换自报身份（Q5）；普通对话不受影响 | — |
| LEGACY-CLOSE PR-C #1030（在途，改注销函数，迁移 0271） | PR-1 也要改注销函数 | PR-1 在 #1030 合并后开工，按合并后的函数改 |
| 改 `content_erasure_confirm` 的其他在途迁移 | 同上，都是整体替换函数 | 开工时向总控核对迁移队列，按合并顺序改最新版本 |
| ENTITLEMENTS / PAYWALL | 会员权限已有；价格页"多模型对比"跟随对比开关（第 51 项），由 PAYWALL 读开关 | 不改它们的文件 |

## 6. 拆分、验收、迁移和测试预算

每个 PR 都按 AGENTS.md 第 4 节：CI、Codex 审查一轮 + 复核、实际验证都对应最终版本；数据库、计费、删除、注销相关的测试先红后绿。

| # | PR | 风险 | 迁移 | 依赖 |
| --- | --- | --- | --- | --- |
| PR-1 | 数据库：`fusion_group_admit` 加 compare 分支（读 `compare` 设置、查 `allow_fusion_compare`、数量在 `[minModels, D3]`、允许列表、熔断、单用户一个进行中）；`fusion_compares` 表；`fusion_compare_start / read / stop / adopt`；采用写回（不计费的采用执行记录）；删对话和账号注销接上 `fusion_compares` | 高 | 是（向总控要号） | #1030 合并；FUSION-REVIEW 已合并部分 |
| PR-2 | 服务端（TS）：Skill 选择的校验和冻结；对比的身份保护例外（显示真实名、不加身份说明）；原始帧投影；对比设置 schema 扩展和保存校验（含和 D3 互相校验）；组准入抽共用、加对比入口；快照组装（复用 runtime 历史读取和 90000 B 上限）；`fusionCompare.*` 路由；每列流式派发（`onChunk`、流式白名单）；判定；恢复重判扩到对比；拒绝代号 | 高 | 预计不要；如要再申请 | PR-1 |
| PR-3 | 前端：自由对话页输入框"多模型对比"入口和勾选框（默认勾选、最少/最多限制、升级提示）、预告、每列状态机和逐字显示（手机用标签）、停止、采用 / 改为引用、对话里的对比卡片、"待核对冻结 N 积分"提示；后台对比设置界面（允许列表、默认组、最少勾选数、上限、预算） | 普通（只改前端） | 否 | PR-2、PR-4（合并并由总控把对比档案写进 staging 后才能做浏览器验收）；和改 `work-composer.tsx` / `runtime/page.tsx` 的 PR 排队 |
| PR-4 | 计费档案和真实模型验收：`paygHostPolicy.ts` 用途枚举加 `fusion_compare` 和对比的请求格式（自由文本流式，不是评审团的 JSON 格式）；按第 8 节问题 4 补每个可选模型的档案证据；staging 真实模型跑完第 6.1 节 PR-4 一行；同步 FUSION.md、Master Plan 第 4 节对比描述、ENTITLEMENTS.md P4 | 高（计费配置） | 否 | PR-2、#1056（已合并）；第 8 节问题 4 已定。真实模型验收通过接口跑，不依赖 PR-3 的页面 |

### 6.1 每个 PR 的验收

| PR | 正常 | 重复提交 | 并发 | 失败 |
| --- | --- | --- | --- | --- |
| PR-1 | 勾 2–4 个模型能建组、每个运行单满额冻结；采用后主对话历史多两条、版本号 +2；各运行单各自取整（例：三个 0.4 积分的调用共扣 3 积分）；普通对话、定位、报告、评审团的回归照跑 | 同一 `requestId` 开始两次返回同一组、不重复冻结；采用同一 `requestId` 重放返回同一结果；采用过 A 列再采用 B 列被拒 | 同一用户两个对话同时开对比只成功一个；采用和主对话新一轮执行同时发生，只有一个先拿到会话锁，另一个按"已有新内容"处理；对比在途时开评审被拒、评审在途时开对比被拒 | 开关关、没权限、少于 `minModels`、多于 D3、允许列表外的模型、熔断已满，直接调数据库函数都被拒；余额不够整组上界时一个调用都不建、余额不变；主对话已有新内容时采用返回 STALE、历史不变；删对话后读不到对比、不能采用、组内运行单按 0235 收尾；账号注销后 `fusion_compares` 和各列正文都清掉、剩余计数为 0；采用执行记录不出现在需要计费运行单的读取路径里（对话列表、恢复、计费核对、注销都有测试） |
| PR-2 | 刚切换 Skill 就发起对比，各列请求用新选的 Skill 版本，传用户看不到的模块被拒；每列都经过 callGate 和预算检查；请求里没有工具字段、web 插件关闭；快照和普通对话同一套历史裁剪；输入超 90000 B 在冻结前拒绝 | 刷新页面、重连后 `stream` 不重复派发，已有正文直接返回 | 两个标签页同时对同一列发 `stream` 只派发一次 | 某列确认失败不收费、其他列照常结算；某列结果未知只保留它的冻结，其他列先结算退款（必测项 6）；进程在"保存正文→判定→结算"之间中断，恢复后判定和收费一致、只结算一次；派发前关页面，过派发期限后对账取消、退冻结；派发后停止按 `user_stopped` 结算；价格中途上涨超过用户看到的上限时拒绝开始；设置保存：`minModels` < 2、> D3、默认组不在允许列表、默认组数量不在范围内都被拒；D3 调到低于 `minModels` 被拒 |
| PR-3 | staging 真实浏览器：自由对话页能打开对比（定位页第一版不放入口，页面上看不到对比按钮）；打开勾选框默认勾好管理员设定的组；取消到少于最少数时按钮置灰；勾到 D3 后其他框不能勾；每列逐字出现；采用后回答出现在主对话、下一轮模型看得到；手机宽度用标签切换 | 采用按钮连点只采用一次 | 两个标签页同时采用只有一个成功，另一个看到已处理 | 没权限看到升级提示、开关关看不到入口；余额不足、某列失败、某列待核对、主对话已有新内容（改为引用）几种状态显示正确；Codex 按交接做交互验证 |
| PR-4 | 每个可选模型的 `fusion_compare` 档案能通过准入；staging 真实模型跑 3 次对比（含一次采用、一次改为引用、一次某列失败），每次模型调用都对上一条冻结和一条结算 | — | 两列并发结算不重不漏 | 没有 `fusion_compare` 档案的模型在后台保存允许列表时被拒、准入时被拒 |

### 6.2 测试预算

- 来源：Owner 2026-10-02 授权 OpenRouter 现有余额用于测试、不充值；本任务上限 **5 美元**（总控记下）：
  档案取证 2 美元（Owner 2026-10-17 问题 4 批准的预算，超过先找总控），流程实测约 3 美元（便宜模型跑失败、重复、并发，强模型完整跑 3 次）。
- 总控开好本任务的 staging 测试窗口前只跑模拟和数据库测试；开测前查余额，不够就停下报告总控。每个 PR 在描述里记实际花费。

## 7. 文档同步（PR-4 做）

- [FUSION.md](FUSION.md)：对比模式一条改为"默认勾选管理员设定的一组、用户可改、最少勾选数为后台参数（2 ≤ 最少 ≤ D3）、不走附属会话（0235 做法）"；
  必测项 4、5、6、7、10、17、18 按本方案的实现写清；必测项 1 注明"不走会话，自然满足"。
- [Master Plan](../MASTER_PLAN.md) 第 4.1、4.5 节对比模式描述按实际做法补充（不改产品规则）；第 2.2 节取代表第 1890 行记"已由 FUSION-COMPARE 同步"。
- [ENTITLEMENTS.md](ENTITLEMENTS.md) 第 221 行 P4"对比最少 2"改为"最少勾选数是后台参数，下限 2"。
- [BILL2 技术契约](V3-BILL-2-provider-authoritative-billing.md)：对比和评审团一样逐个调用结算，FUSION-REVIEW 已改过的那一行加上"对比同"。

## 8. Owner 的决定（2026-10-17，全部已定）

5 个问题 2026-10-17 经总控转 Owner，原话按问题列在下面，也记在 Master Plan 第 2.1 节 2026-10-17 对比条目。

1. **对比里模型叫什么——已定**。Owner 原话（2026-10-17，总控-8 对话）：
   > 对比时显示什么模型名：显示后台配置的真实模型名称

   取代方案原推荐的"不显示真实名、管理员另写显示名"。身份说明是否保留另列为问题 5。
2. **余额门槛——已定选 A**。Owner 原话（2026-10-17，总控-8 对话）：
   > 余额不够时怎么办：A

   即余额要够这次勾选的全部模型的上限之和才开始，不够就整组不发、充值后继续。
3. **定位页放不放入口——已定选 A**。Owner 原话（2026-10-17，总控-8 对话）：
   > 对比入口选 A

   即第一版只在自由对话页（含在自由对话里用的其他 Skill）放入口，定位页先不放，上线后看反馈再加。
4. **对比的计费档案——已定选 A**。Owner 原话（2026-10-17，总控-8 对话）：
   > 对比计费档案选 A，预算 2 美元

   即把 2026-10-17 方案 B 的放宽扩到 `fusion_compare` 用途：只按对比实际会发的请求取证（`paygHostPolicy.ts` 的 `fusion-request-shape` 证据可用于
   只含 `fusion_compare` 等 Fusion 用途和对比请求格式的档案，其他用途仍要完整矩阵）；四个模型（Sonnet 5.5、Gemini 3.8 Flash、GPT-6.1 Sol、Opus 5.5）
   合计 2 美元，从 OpenRouter 现有测试余额出。这是规则放宽，已由 Owner 批准，由 PR-4 实施并照常审查。
5. **对比请求还加不加 Graylum 身份说明——已定选 A**。Owner 原话（2026-10-17，总控-8 对话）：
   > 对比身份说明选 A

   即对比请求不加 Graylum 身份说明、不替换模型自报身份，和评审团的例外一致。

## 9. 发现的问题（不在本任务范围，交总控）

- FUSION.md 第 16 行和 FUSION-REVIEW.md 第 2.3 节还写着"每列一个附属会话"，和已合并的 0235"不走会话"不一致；对比的部分由 PR-4 改，评审团的部分建议 FUSION-REVIEW 后续文档 PR 一起改。
- 评审团的 7 天熔断和"一个进行中"判断统计所有 Fusion 调用，对比上线后两者会互相影响（对比用掉的平台承担额度也会挡评审）。本方案按"共用一套统计"写，
  这只是防滥用的技术参数；如果总控希望两者分开统计，PR-1 可以按 `kind` 分开，不影响收费。
- 后台"思考设置"里"评审""写作"的"暂未接入任何调用"提示已过时（#1056 已记）。
