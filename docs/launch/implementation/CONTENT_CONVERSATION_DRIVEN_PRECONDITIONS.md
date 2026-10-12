# CONTENT-CONVERSATION-DRIVEN（AGENT-CORE R8a）开工前置设计

> 状态：仅方案（high），不改代码、SQL 或配置。是 [#621 方案](../CONTENT_CONVERSATION_DRIVEN_PLAN.md) 的补充，
> 专门解决 #621 第八轮审查留下、Owner 2026-10-04 列为"实施前必须先解决"的三项
> （[#621 总控记录](https://github.com/Crnobog9527/GraylumAI_vercel/pull/621#issuecomment-5971687700)；Master Plan 第 7.1 节
> CONTENT-CONVERSATION-DRIVEN 行）。**本文和 #621 冲突的地方以本文为准**，其余照 #621。
> 基线：staging `f8c24fb2`（迁移到 0219）。代码事实都是在这个基线上只读核对的，行号以它为准；
> 在途 PR 按 2026-10-13 的开放列表核对。没有访问数据库，没有调用模型，没有跑测试。

## 0. 结论摘要

| 前置项 | 一句话结论 | 落在哪个 PR |
| --- | --- | --- |
| ① 素材投影（审查 P1 4174135716） | 选题窗口的常驻材料只放"定位档案 + 本选题标题、类型、简报"，**已保存的正文一律不再写进常驻材料**；正文只在衍生操作时按需注入，并把注入记录接进可用性检查和删除联动 | A1（写入方）、A2（按需注入）、R（旧视频写入退役） |
| ② 内容类型（审查 P1 4174135718） | **不新增 kind 值**："简报"统一指选题条目的简报（`opc_item_edits.brief`），不是内容版本；文章 / 图文的"正文"沿用现有 kind `brief`（现有编辑器和资料库本来就这样用），只把名字在接口和界面上讲清楚；补齐 `storyboard`、`editing` 的执行保存和 API schema；守卫不放宽 | A1（简报写入和接口）、A2（分镜、剪辑建议保存） |
| ③ 提议是否已消耗（审查 P2 4174135724） | 提议有效 = 它所在的对话执行之后**没有任何已准入的对话执行**（不论成功、失败、停止、被删、不可用）；"可用"只在展示和接受这条提议时检查；判断放在数据库准入事务里，不放在浏览器或 TS 预检 | A3 |

另外写清：按意图加载 Skill 的触发方式（第 4 节）、"一窗口一选题"提醒（第 5 节）、PR 拆分和验收（第 6 节）、和在途工作的冲突（第 7 节）、
需要 Owner 决定的事（第 8 节，只列出，不替 Owner 定）。

## 1. 现状核对（和 #621 基线 `95ecefd7` 相比的变化）

- **#621 的前置 PR 都已合并**：#604 C0+C1、BILL-PAYG PR-B、CDC B1/B2/F1/V3（#593、#675、#688、#768、#773）。
  CDC 仍只服务定位（`opc_capture_apply` 只认定位草稿），本方案不改它。
- **R9 数据基础已合并（0209）**：新表 `opc_data_events`（action：`topic_draft` / `topic_adoption` / `rewrite` / `abandon`），
  `opc_adopt_topics_with_source` 已把"AI 原提议"和"用户采用的文字"连同执行 id 一起记下。第 3 节直接复用它。
- **自由对话读定位已改为按需（0218）**：`runtime_workspace_source` 列出本人已确认的定位、账号策略、选题，模型用 `read_source` 读取，
  结果带 `dependencies`，由 `runtime_context_allowed` 复查可用性。自由对话没有常驻材料。
- **POSITIONING-GATE PR1 已合并（0219）**：`modules.social_media_related`、`opc_has_confirmed_positioning`；PR2（运行时接线）在 ① 线排队。
- **D7 删除（0201）**：会话、成果、内容版本的删除会抹掉相关执行、历史和 `runtime_scope_material` 的对应修订；
  并且用 `pg_get_functiondef` + 标记（`-- D7 read boundary`、`-- D7 account strategy boundary`）给
  `runtime_material`、`runtime_session_context`、`runtime_admit`、`runtime_view`、`opc_content_from_execution`、
  `opc_content_manual_save`、`opc_content_allowed` 等现有函数打了补丁。**以后任何 `CREATE OR REPLACE` 这些函数都必须带上这些守卫**，
  否则删除保护会悄悄丢失（第 6.3 节必测）。
- **#873（开放）**：用户只能删除整个对话，不能单独删除一条回答（Owner 2026-10-13 决定）；内容版本、成果的删除照常。
  所以本文的删除联动只考虑"删对话 / 删成果（定位版本）/ 删稿件"三种。

## 2. 前置项 ①：素材投影

### 2.1 问题在哪里（代码事实）

- 每轮准入时，`runtime_session_context`（0167:296 起，0201 加了 D7 守卫）取本会话 `runtime_scope_material` **最新一版**，
  没撤销就整份作为 `scopeMaterial` 冻结进执行载荷（`admission.ts:245`、`:331`），再由 `context.ts:55-57` 拼进每一轮的模型输入。
- 选题会话的材料有 6 个写入方，**每次都整份覆盖成新的一版**（后写的赢）：

| 写入方（最新定义） | 写进去的 `brief` | `material` |
| --- | --- | --- |
| `opc_handoff`（0107:176） | 选题简报 | `opc_profile(定位版本)` |
| `opc_library_edit`（0127:59） | 内容类型、标题、简报 | `opc_profile` |
| `opc_content_from_execution`（0122:149） | **"已定稿口播稿：" / "已保存内容："+ 整篇正文** | `opc_profile` |
| `opc_content_manual_save`（0128:90） | **同上，整篇正文** | `opc_profile` |
| 视频准备（0122:260） | **整篇口播稿** | 分镜正文或 `opc_profile` |
| 选题讨论工作区（0113:109） | `topic:first-week` | `opc_profile` |

- 后果：存过一次定稿，之后每一轮普通对话都背着整篇正文（最多 2 万字）；而且标题、简报会被正文那一版挤掉，
  直到下一次改条目信息才回来。#621 第 4.3 节"只冻结版本 id、按需注入"在这个前提下做不到（审查 P1）。
- 另一个已有问题（记入"发现的问题"）：`runtime_material` 限制载荷 ≤ 24000 字节（0106:91），`opc_profile` 本身最多 20000 字节，
  简报最多 2000 个汉字（约 6000 字节）。定位档案接近上限时，改条目信息会因为 `RUNTIME_MATERIAL_INVALID` 失败。A1 用最大尺寸样本测这一点，
  超了就让条目信息的编辑给出明确提示，不静默截断定位档案。

### 2.2 投影规则：各窗口常驻什么、按需读什么

| 窗口 | 常驻材料（每轮都带） | 按需读取（只在需要的那一轮） | 不进入模型输入 |
| --- | --- | --- | --- |
| 定位（不在本方案） | 现状不变：本步骤工作投影 | — | — |
| 选题讨论 | 绑定的**已确认**定位版本的档案（`opc_profile`） | 无 | 定位草稿、未确认的步骤、导师历史、报告全文 |
| 选题窗口 | 绑定定位版本的档案 + 本选题的**内容类型、标题、简报**（`opc_item_edits`） | 衍生操作需要的那一份已保存正文（第 2.4 节） | 已保存正文（不是衍生操作时）、别的选题、别的会话 |
| 自由对话 | 无 | 经 `read_source` 读本人已确认定位、账号策略、选题简报（0218 现状） | 内容正文（`read_source` 现在就不返回正文，保持） |

读取边界（全部沿用现有检查，不另写一套）：

- **定位成果 = 已发布（确认）版本里带 `profileKey` 的字段值**，由 `opc_profile(source_version_id)` 生成；草稿、没确认的步骤、
  CDC 的待确认建议（存在 `fieldMeta` 的 suggestion 里，`opc_profile` 不读）都不投影。
- 选题窗口绑定的是**采用这个选题时**的定位版本（`opc_items.source_version_id`），之后定位修订产生新版本也不自动换
  （是否要换是产品问题，见第 8 节 O1）。
- 每次准入前，材料里的定位版本仍要通过 `opc_source_allowed`；不通过时这个会话已经被 D7 连带删除（见 2.5），不会走到准入。

### 2.3 写入方怎么改（A1，迁移 X1）

1. 新增一个内部函数 `opc_work_material_payload(actor, work_item)`，只拼"内容类型、标题、简报"和 `opc_profile`，
   **是选题窗口常驻材料的唯一来源**。`opc_handoff`、`opc_library_edit` 改为调用它（函数体改动，签名不变）。
2. `opc_content_from_execution`、`opc_content_manual_save` **不再写材料**（删掉 `IF p_status='final' THEN … runtime_material(…)` 这一段）。
   这样也不再出现"存稿把简报挤掉"。改这两个函数时保留 0201 的 D7 守卫（用 0209 的"按唯一锚点打补丁"方式，或在新定义里原样带上守卫语句）。
3. 新写的材料修订用**自己的确定性请求 id**（例如由 `work_item_id`、条目编辑的 revision 推出），不再用内容版本的 id 当请求 id。
   原因：0201 删稿件时会抹掉 `request_id` 等于稿件 id 的材料修订；材料里已经没有正文，删稿件不应该把标题和定位档案一起抹掉。
4. **旧数据**：已有会话里最新一版材料可能还带着正文。迁移不改历史修订（它们是已冻结执行的证据），而是给"最新一版材料带正文"
   （判断依据：最新修订的 `request_id` 是某个内容版本 id，或来自视频准备）的选题会话**追加一版**只含条目信息和定位档案的材料。
   请求 id 确定（`md5(session_id||':material-reproject-v1')::uuid`），重复执行时因 `UNIQUE(session_id,request_id)` 跳过；
   会话已删除或范围不可用的跳过。正式环境没有真实用户，staging 上的旧会话也照这个规则处理。
5. 视频准备（0122:260）这个写入方暂时保留：旧的视频按钮流程在 B1 上线前还要用它（它靠 `expectedMaterialRevision` 对准材料修订）。
   B1 上线时由 **R 小 PR（迁移 X5）** 让它直接报 `OPC_VIDEO_RETIRED`，并对视频准备留下的最新修订再跑一次第 4 条的追加。
   顺序和验证（第二、四轮审查 P1）：
   - B1 是页面改动，**在包含 B1 这个版本的 preview 上做完浏览器验收**（B1 本身不调用视频准备，它的 preview 不依赖 R），不拿合并后的状态补验；
   - R 是纯数据库改动，按第 4 节用数据库和集成测试验证（含"旧会话最新材料带视频正文，迁移后不再带""迁移后调用视频准备被拒"）；
   - **合并时 R 在前、B1 紧接在后**（同一批，中间不开工别的）：R 合并并应用后，旧页面就不能再写入带正文的材料，追加步骤也已经把残留清掉，
     所以 B1 生效时不会有新被污染的最新修订。R 和 B1 之间旧页面的视频按钮会报错，这段时间只在 staging、没有真实用户，可以接受；
     正式环境两者随同一次上线批准一起发布。B1 合并后对保存和衍生流程做一次冒烟复验，复验发现问题从新分支修。
   **回退顺序**（第三轮审查 P2，修订 #621 第 12 节"前端可以单独回退"）：R 合并之后，B1 不能再单独回退——旧页面要调用视频准备，而 R 让它直接报错。
   要回退 B1，必须先（或同一次）合并一个追加迁移恢复视频准备的原函数体，再回退 B1 页面。
6. 选题讨论工作区（0113）、定位会话的写入方不改。

### 2.4 正文按需注入（A2，迁移 X2）——修订 #621 第 4.3 节

#621 原写法是"每轮准入都冻结 `contentSources:{scriptId, storyboardId}`"。核对后改为**注入时解析、注入时记录**，原因：
按意图匹配的路径要到执行里匹配完才知道选中了哪个 Skill，每轮预先冻结两个 id 对普通对话没有用处，还多一处要和删除联动对齐的数据。

- 选中的 Skill 在 `workflow.yaml` 里声明 `contentSource: script | storyboard`（`workflowManifest.ts` 扩一个可选字段，旧包没有即不需要来源）。
  没声明的 Skill 和普通对话**不读、不注入任何正文**。
- 执行器在匹配之后、正文调用之前，经下面的 `checkpoint_source` 取本人本选题**通过 `opc_content_allowed` 的**最新定稿口播稿或最新分镜
  （剪辑建议另核"分镜的 `source_content_id` 等于当前定稿口播稿"，不等就固定提示结束、不派发、不收费，规则同 #621 第 4.3 节）。
- **读取和记录必须是同一个数据库事务**（第一轮审查 P1）：不能先读正文、再另发一次 RPC 写检查点——两次之间用户删掉这份稿件时，
  D7 的删除闭包算出来时这次执行还没引用它，之后写进去的引用就漏删了，已经读到的正文还会发给模型并留在执行里。做法：
  - `runtime_execution` 新增动作 `checkpoint_source`，**一次调用里**完成：按 D7 的加锁顺序先锁会话、再锁本次执行、再以 `FOR SHARE`
    锁住选中的内容版本（以及剪辑建议需要核对的口播稿）；在锁内跑 `opc_content_allowed` 和"分镜来源等于当前口播稿"检查；
    写入 `runtime_executions` 新增的可空列 `injected_source jsonb`（形如 `{"contentId": <uuid>, "kind": "script"}`）；
    然后**在同一事务里返回正文**。按钮路径在准入时的计费前预检（2.4 下一条、3.3 X2 的"只读的当前来源函数"）只判断能不能做，不返回正文；
  - 写过就不能改（和 `checkpoint_match` 一样，冲突报错）。键名用 `contentId` 是有意的：D7 的 `content_erasure_references` 认这个键；
  - **重放和恢复用已记录的来源，不重新取最新**（第四轮审查 P1）：只有第一次调用（`injected_source` 为空时）解析"当前最新"；
    已经记录过的执行再次调用 `checkpoint_source`（执行器崩溃后恢复、重试），按已记录的 `contentId` 同样加锁、重新跑 `opc_content_allowed`，
    可用就返回这份正文继续派发，不用之后新保存的版本、不报冲突；已不可用就以固定提示结束、不派发。剪辑建议同理，核对的是记录时的那对口播稿和分镜。
    必测：检查点提交后、派发前模拟崩溃，期间保存一份新的定稿口播稿，恢复后仍注入原来记录的版本并正常完成，匹配调用不重复收费；
  - 这样只有两种顺序：删除先拿到锁 → 检查点读不到可用内容，以固定提示结束、不派发；检查点先提交 → 删除闭包能看到 `injected_source`，
    把这次执行一起抹掉，之后派发前的现有检查（`content_erasure_runtime_check`）拒绝派发和保存结果。正文已在网络上发出后才删除的，
    和现在任何在途调用一样：结果不保存、执行被抹掉；
  - 必测：在检查点事务和删除事务之间人为制造两种先后顺序（用两个连接和锁等待），分别断言"不派发"和"执行被抹掉、结果不保存、历史里没有正文"。
- 按钮直接准入的路径（第 3 节）在准入时就知道 Skill，**在任何计费之前**做同样的读取和检查；放不下（超过该用途 `inputBytes`）同样在计费前拒绝。
- 容量：放不下只拒绝这次衍生操作（#621 第 4.3 节原规则）。

### 2.5 删除联动

| 删除什么（D7） | 现有行为 | 本方案要保证的 |
| --- | --- | --- |
| 整个对话（`session`） | 会话内所有执行、历史、材料修订抹掉 | 不变 |
| 定位成果（`artifact`，含定位版本） | 由这个版本采用的选题、它们的会话和材料一起抹掉（0201:235-249） | 不变；常驻材料只含定位档案和条目信息，不会残留别的东西 |
| 某份稿件（`content`，同选题同 kind 的整组版本） | 抹掉这些版本、生成它们的执行，以及 `request_id` 等于稿件 id 的材料修订；独立保存的后代版本保留但来源标为不可用 | **新增**：凡是 `injected_source` 指向被删稿件（含其后代链上的 id）的执行，也进入删除闭包——它们的模型输入里有那份正文。实现：在 0201 删除闭包的第一段加 `OR content_erasure_references(ex.injected_source, refs)`，用锚点补丁方式，不重写整个函数 |
| 单独一条回答（`answer`） | #873 起用户不能发起 | 不涉及 |

可用性（不删除、只是来源被撤销）走 #621 第七轮已定的做法：`runtime_context_allowed` 加 `injected_source` 分支，跑 `opc_content_allowed`，
不通过就让这次执行和之后依赖它的历史都不可用（经 `runtime_history_available` 传递）。
注意 #863（开放，0225）也用锚点补丁改 `runtime_context_allowed`：A2 在它之后，基于合并后的定义打补丁。

### 2.6 验收（前置项 ① 解决的判定）

- 存一份接近 2 万字的定稿口播稿后，同一窗口里的普通提问：执行载荷的 `scopeMaterial` 里没有正文、模型输入里没有正文，正常完成（#621 第 565 行的必测）。
- 存稿之后，常驻材料仍有标题、类型、简报（不再被挤掉）；改条目信息后材料更新，正文仍不进入。
- 旧会话（迁移前最新材料带正文）迁移后最新一版不带正文；迁移连跑两次只追加一次。
- 选中声明了 `contentSource` 的 Skill 时才注入，并写 `injected_source`；普通对话、没声明的 Skill 不写；读取正文和写 `injected_source` 在同一事务（2.4 并发必测）。
- 删除被注入的稿件 → 注入它的执行被抹掉、之后的历史不再含那份正文；删除别的稿件不影响；只删对话时行为不变。
- 0201 的 D7 守卫在所有被改写的函数里仍在（用 `pg_get_functiondef` 断言标记存在）。

## 3. 前置项 ②：内容类型（`opc_content_versions.kind` 和守卫）

### 3.1 现状

- `opc_content_versions.kind`：`brief` / `script` / `storyboard` / `editing`（0117:68）。守卫 `opc_guard_content_kind`（0124:101）：
  `brief` 只给文章 / 图文，`script`、`storyboard`、`editing` 只给视频；内容类型为 `unknown` 的选题什么都存不了。
- **现有代码里 kind `brief` 的实际意思是"文章 / 图文的正文"**：编辑器 `content-editor.tsx:18`、资料库 `library/page.tsx:36`
  都是 `contentType==='video' ? 'script' : 'brief'`；发布状态检查（0124:139）也把文章的定稿 `brief` 当成"内容已完成"。
- **"简报"在现有代码里是另一样东西**：选题条目的简报 `opc_item_edits.brief`（≤ 2000 字，带 revision），资料库和常驻材料里显示的就是它。
- API：`shared/opcRequests.ts:59` 的保存接口只接受 `brief`、`script`。

所以审查说的两个缺口，实质是 #621 第 4.3、5.4 节把"简报"写成了一个内容版本：视频没有这种 kind，文章里它又和正文撞名。

### 3.2 设计

| 用户看到的 | 存在哪里 | 适用类型 | 改动 |
| --- | --- | --- | --- |
| 简报 | `opc_item_edits.brief`（选题条目，一份，带 revision） | 全部 | "整理本选题 → 更新简报"走现有 `opc_library_edit`（带 expected revision）；不新增 kind |
| 正文 | `opc_content_versions`，kind `brief`（沿用） | 文章、图文 | 不改存储；接口和界面统一叫"正文"，`shared/` 里放一个 kind→显示名的函数，按内容类型取名；数据库加 `COMMENT ON COLUMN` 写明 |
| 口播稿 | kind `script` | 视频 | 不变 |
| 分镜、剪辑建议 | kind `storyboard`、`editing` | 视频 | `opc_content_from_execution` 放开这两个 kind（来源规则见 2.4 和 #621 第 4.3 节）；API schema 同步 |

- **守卫不放宽**：`opc_guard_content_kind` 保持原样。`unknown` 类型的选题保存时，确认框先让用户选"视频 / 文章 / 图文"，
  定类型和保存必须在**同一个数据库事务**里（第二轮审查 P2）：现有 `opc.editLibrary` 和 `opc.saveContentResult` 是两次 RPC，
  类型改成功、保存因版本或来源冲突失败时，选题会留在新类型上。做法是新增一个组合函数 `opc_content_save_typed`（参数：选题、
  期望的条目 revision、选定类型，以及原保存函数的全部参数），在一个事务里先按条目 revision 改类型、再调用原保存逻辑，任何一步失败整体回滚；
  请求重放按同一请求 id 返回同一结果。原有保存函数签名不变，只在 `unknown` 类型时走组合函数。不让守卫自己猜类型。
  必测：类型修改成功但保存冲突时，选题类型仍是 `unknown`；同一请求重放不改两次类型。
- **为什么不新增 `body` 之类的 kind**：要么把已有的 `brief` 行改名（版本不可改、请求重放按 kind 匹配、新旧代码部署期间会互相拒绝），
  要么两种 kind 并存（同一篇文章的版本号会分成两串）。两样都比"讲清名字"风险大，而用户可见的两个概念已经各有归处。
  以后真要改名，随 LEGACY-CLOSE 单独做。
- **"更新简报"的采纳记录**：简报来自整理执行时，用户可能先改再存。接口带上来源执行 id，写一条 `opc_data_events`
  （`action` 新增 `brief_adoption`，`original` 是整理结果里的简报段，`adopted` 是用户实际保存的文字），复用 R9 的表和 `opc_data_execution` 检查；
  不带来源（用户手动改）就不写。迁移 X1 只改这个表的 `action` CHECK 和新增写入函数。
- 简报超过 2000 字：确认框里显示字数并要求先改短，不自动截断。

### 3.3 迁移设计（编号实施时向总控要）

- **X1（A1）**：`opc_work_material_payload`；`opc_handoff`、`opc_library_edit`、`opc_content_from_execution`、`opc_content_manual_save`
  的函数体（保留 D7 守卫）；组合函数 `opc_content_save_typed`（3.2，A1 支持 `brief`/`script`，A2 扩到 `storyboard`/`editing`）；旧会话材料追加（2.3 第 4 条）；`opc_data_events.action` 加 `brief_adoption` 及写入函数；`opc_content_versions.kind` 的说明注释。
  可重复执行：函数用 `CREATE OR REPLACE` 或带标记的锚点补丁，CHECK 用 `DROP CONSTRAINT IF EXISTS` + `ADD`，追加材料靠确定性请求 id。
- **X2（A2）**：`runtime_executions.injected_source`（`ADD COLUMN IF NOT EXISTS`）；`runtime_execution` 的 `checkpoint_source` 动作；
  `runtime_context_allowed` 的 `injected_source` 分支；D7 删除闭包的 `injected_source` 条件；`opc_content_from_execution` 放开 `storyboard`、`editing`；
  只读的"当前来源"函数。
- **X3（A3）**：见第 4 节的提议规则（`runtime_admit` 校验、`runtime_view` 带 `role`、`signal`、`offerState`；`runtime_executions.dialogue_role` 列、准入时写入、回填）。
- **X4（P2-A）**、**X5（R）**：见第 6 节。
- 每个迁移：本机连续执行两次结构不变；更新 `built-fingerprint.json`；旧代码（迁移后、新代码部署前）仍能正常保存和对话（新列可空、
  函数签名不变、`brief`/`script` 行为不变）；回退靠追加迁移恢复原函数体，`injected_source` 列保留不删（可空、无写入即无影响）。

## 4. 前置项 ③：提议怎么记录、什么时候算用掉

### 4.1 本方案里有哪几种"AI 提议"

| 提议 | AI 这一侧怎么记 | 用户采用怎么记 | 和右侧清单 / 已确认版本的关系 |
| --- | --- | --- | --- |
| 候选选题 | 执行结果（T2 信封的 `topics`）+ `opc_topic_draft_versions` + `opc_data_events(topic_draft)` | `opc_adopt_topics_with_source` → `opc_data_events(topic_adoption)`，记原提议和采用文字；`adoption-consent` 规则不变 | 采用生成选题（`opc_items`），绑定当时的定位版本；不改定位 |
| 换一个 Skill（`offer_skill`） | 这次执行的已校验信号（`runtime_view.signal`，见 4.3） | 下一次对话执行的冻结载荷 `offerResponse:{executionId, response}`；不建表 | 不碰任何版本 |
| 存稿（`save_content`） | 已校验信号：`{kind, target}`，`target` 换算成执行 id | 用户确认后生成的内容版本本身（带 `execution_id`，衍生内容带来源） | 只写本选题的内容版本 |
| 更新简报（整理本选题） | 整理执行的结果 | `opc_library_edit` + `opc_data_events(brief_adoption)` | 只写本选题条目 |
| 定位字段建议（CDC） | `fieldMeta` 里的建议（#588，定位专用） | 用户在右侧清单接受 / 每步确认卡 | **不在本方案**：内容窗口里不产生、不修改定位字段建议；要改定位只能回到定位流程，生成新版本 |

原则：AI 的提议**从不直接写入用户内容或确认过的版本**；每一种都要用户点一下或用自己的话明确同意，写入时记下来源执行。

### 4.2 消耗规则（解决 P2）

**定义**：会话 S 里，执行 E 带一条 `offer_skill` 提议。

- **已消耗**：S 里存在任何一次 (created_at, id) 排在 E 之后的**对话执行**（冻结角色 `ordinary` 或 `skill`）。
  只看"有没有被准入过"（`runtime_executions` 里有这一行），**不看**它的状态（prepared / running / interrupted / cost_pending / completed / cancelled）、
  不看它现在是否可用、是否被删除内容。整理（`organizer`）执行不算。
- **角色要存在不会被删除抹掉的地方**（第三轮审查 P1）：D7 删除内容时把执行的 `payload` 换成只剩 `input`（0201:405），冻结的 `role` 随之消失；
  只按载荷里的角色判断，被删的后续执行会被漏掉、旧提议复活。做法：X3 给 `runtime_executions` 加一列 `dialogue_role text`
  （只取 `ordinary` / `skill` / `organizer` 等角色名，不含任何用户内容，D7 不清空它），由准入时写入、之后不可改；
  迁移时用 `payload->>'role'` 回填已有行。**角色未知的行（载荷已被抹、回填不到）一律算作对话执行、会消耗提议**——
  宁可让旧提议失效（用户再说一次即可），也不让它复活去发起付费生成。消耗判断只读这一列和 (created_at, id)，不读载荷。
- **可以展示 / 接受**：没被消耗，并且 E 本身已完成、`runtime_history_available(E)` 为真、没有被删除内容。可用性**只在这一步**检查。
- **回应**："好" / "先不用"按钮各自是一次对话执行，请求 id 由 E 的 id 确定性推出，冻结 `offerResponse`；它被准入的同时提议就按上面的规则被消耗。
  打字回复"好"时，`pendingOffer` 只在提议仍可展示时放进匹配输入（#621 第 3.5 节其余规则不变）。

为什么不能沿用 #621 的"最新一次已完成、可用的对话执行"：之后那次执行失败、停止，或完成后因为来源被撤销而不可用，
它会从"最新"里消失，旧提议就重新变成最新的，刷新后按钮复活，点"好"会用过期的 Skill 发起一次付费生成（审查 P2 原文的场景）。

**放在哪里判断**：在数据库准入函数里，和"一个会话同一时间只有一个执行"在同一个事务、同一把会话锁下判断，不在浏览器或 TS 里预检：

- `runtime_admit` 收到带 `offerResponse` 的准入时：锁住会话后查 E 之后有没有对话执行；有就报 `RUNTIME_OFFER_CONSUMED`，没有再查 E 可展示，
  然后准入。两个标签页同时点"好"，第二个因为第一个已被准入而被拒；重放同一请求 id 命中第一个。
- `runtime_view` 给每条带提议的执行投影 `offerState`：`pending` / `consumed` / `accepted` / `declined` / `unavailable`，由服务端按上面的规则算，
  客户端只显示。因为 `runtime_view` 会遮蔽不可用的执行，客户端自己从列表里推算会再次掉进 P2 的坑，所以必须由服务端给。
- 改 `runtime_admit`、`runtime_view` 时保留 0201 的 D7 守卫。

**同一规则也用于** `request_minutes` 的"继续整理"提示：之后有对话执行被准入就不再提示（用户仍可直接点右侧按钮）。
**不用于**"当前 Skill"和存稿编号表：它们只是默认值和查找表，不授权生成，沿用 #621 第 2.5 节"最新一次已完成、可用的对话执行"。

### 4.3 必测（A3）

- 提议之后：下一次对话执行完成 / 失败 / 停止 / 准入后被取消 / 完成后来源被撤销而不可用 / 被删除内容，六种情况刷新后 `offerState` 都是 `consumed`，点"好"都返回 `RUNTIME_OFFER_CONSUMED`，不产生运行单、不收费；
  "被删除内容"一项要真的跑 D7 删除（载荷被换成只剩 `input`）后再断言；载荷被抹且回填不到角色的旧行同样算消耗；后续只有整理执行（角色列为 `organizer`）时不消耗。
- 提议之后只做了一次整理纪要：提议仍是 `pending`，点"好"正常准入、不发匹配调用。
- 提议所在执行变成不可用（没有后续执行）：`offerState=unavailable`，按钮不显示，接受被拒。
- 两个标签页同时点"好"：只有一次准入、一笔运行单；同一请求 id 重放返回同一执行。
- 点"先不用"之后再点"好"被拒；打字回"好"时匹配输入里没有 `pendingOffer`。

## 5. 按意图加载 Skill 和"一窗口一选题"

### 5.1 触发方式（ENGINEERING 第 6 节：不用关键词或正则判断用户意图）

| 判断什么 | 谁来判断 | 宿主做什么 |
| --- | --- | --- |
| 这句话该用哪个 Skill | 匹配调用（`selection.kind:'auto'`，模型在候选 Skill 的公开名称和简介里选，#621 第 3 节） | 只组装候选（去掉带步骤的 Skill；用户没有定位时按 POSITIONING-GATE 去掉"与社交媒体相关"的 Skill 或由闸门拦截）、冻结结果 |
| 是否同意 AI 上一条的提议 | 按钮（确定）；打字时由匹配调用看 `pendingOffer` 判断 | 只核对提议仍可展示（第 4 节） |
| 是否要整理纪要、要存哪一稿 | 对话模型调用信号工具 `request_minutes` / `save_content` | 只校验工具名在白名单、参数在本轮冻结表里 |
| 是否在聊别的选题 | 对话模型按系统提示词自己判断并提醒 | 宿主不判断、不拦截 |
| 是不是"为自己账号做社媒运营"（没有定位的用户） | POSITIONING-GATE：Decisions 先判断，主模型兜底（Owner 2026-10-12） | 本方案不另做判断，只排在它之后 |

- 删除的东西不留"兜底正则"：`runtime/page.tsx` 里四选一卡片的正则、`[OPC_SCRIPT_V1]` 等前缀、正文 JSON 解析随 P1-B 一起删，代码搜索断言它们不再出现。
- 一轮的顺序：POSITIONING-GATE（只对没有定位的用户）→ 匹配（有候选时）→ 来源注入检查（选中的 Skill 声明了来源时）→ 正文调用。
  前面任何一步拒绝，后面的调用都不发生；计费按 #621 第 8 节和 POSITIONING-GATE 的规则（被闸门拦下不扣用户积分）。
- 选题窗口和选题讨论窗口的用户一定有已确认定位（选题来自已确认版本），闸门对他们不判断；自由对话按闸门规则。

### 5.2 "一窗口一选题"提醒

沿用 #621 第 6 节，不变：只靠选题窗口的固定说明（常驻材料里有本选题标题和简报，2.2 节保证不会被正文挤掉），
用户聊别的选题时提醒一次、照常回答、不拦截；选题窗口顶部固定"新开一个选题"入口跳到选题讨论窗口并预填。
"整理本选题"只整理本选题；存稿和更新简报只能写本会话绑定的选题（数据库按会话范围校验，写不到别的选题）。
提醒是否到位由第 6 节 E 的付费小评测（10 个场景 × 3 轮）验收，宿主没有任何关键词判断。

## 6. 拆成哪些 PR、怎么验收

### 6.1 拆分（取代 #621 第 10 节的 P1-A 一项；其余顺延）

| 顺序 | PR | 风险 | 内容 | 迁移 | 前置 |
| --- | --- | --- | --- | --- | --- |
| 0 | 本文件 | 文档 | 前置设计 | — | — |
| A1 | 素材投影 + 简报 / 正文语义 | high | 2.3 全部；3.2 的简报更新接口和 `brief_adoption`；API 和界面统一"正文 / 简报"名字（只改显示函数，不改页面结构） | X1 | 无（可先做） |
| A2 | 衍生内容来源 + 分镜、剪辑建议保存 | high | 2.4、2.5；`workflowManifest.ts` 的 `contentSource`；`opc_content_from_execution` 放开两个 kind；`shared/opcRequests.ts` schema | X2 | A1；#863 合并后（同改 `runtime_context_allowed`） |
| A3 | 意图匹配和提议、信号 | high | #621 第 3 节（当前 Skill、过滤带步骤的 Skill）；`offer_skill` / `save_content` 信号工具和白名单；第 4 节消耗规则；`runtime_view` 带 `role`、`signal`、`offerState` | X3 | A2；POSITIONING-GATE PR2、#829、#845（同改 `admission.ts` / `execute.ts` / `matching.ts`） |
| S | 首批平台 Skill 包 | 按内容 | 口播稿、分镜、剪辑建议、图文 / 文章；分镜、剪辑建议声明 `contentSource` | — | 和 A1–A3 并行；发布前 Owner 看样例（Q2 已定） |
| B1 | 内容窗口前端（#621 P1-B） | ordinary | 选题窗口改为对话界面、当前 Skill 标签、回复下的保存按钮和确认、提议按钮、删除固定流程 | — | A1–A3；S 已在 staging 发布；工作区页面排队（第 7 节）；R 先合并 |
| R | 旧视频写入退役 | high | 视频准备报 `OPC_VIDEO_RETIRED`；对视频准备留下的最新材料再追加一版 | X5 | B1 已在自己的 preview 上验收；合并时 R 在前、B1 紧接其后（2.3 第 5 条） |
| P2-A | 纪要后端 | high | #621 第 5 节：纪要说明、`request_minutes`、确定性请求 id、整理执行历史 `internal_control`、纪要列表（`runtime_view` 的 `role`/`signal` 已在 A3） | X4 | A3 |
| P2-B | 纪要前端 | ordinary | 右侧"整理纪要 / 整理本选题"、历史纪要、复制导出、"更新简报" | — | P2-A；B1 |
| P3-A / P3-B | 选题讨论 | high / ordinary | #621 第 7 节 T2 信封、流式 | — | 和 A 线串行写 `opc/service.ts` |
| E | 付费小评测 | 真实调用 | #621 第 11.3 节，硬上限 5 美元（Q4 已定） | — | A3、P2-A、S |

迁移合计 5 个（X1–X5），编号实施时向总控要；当前 staging 到 0219，开放 PR 已占用 0220、0221、0223–0227。

### 6.2 每个 PR 的验收

- **A1**：2.6 的前三条；简报更新带来源时写 `brief_adoption`、不带时不写，超长被拒；`opc_library_edit` 在最大定位档案下的行为（2.1 末条）有测试；
  文章 / 图文存"正文"仍写 kind `brief`，资料库显示为"正文"；`brief`/`script` 原有集成用例全过。
- **A2**：2.6 的后三条；#621 第 11.2 节"衍生内容来源""依赖链"两组必测（按本文 2.4 把 `contentSources` 改成 `injected_source`）。
- **A3**：4.3 全部；#621 第 11.2 节匹配、`save_content`、"最新执行口径"三组必测；POSITIONING-GATE 拦截时不发匹配调用。
- **B1、P2-B**：#621 第 11.1 节验收 1–4、7 和 5–6，**在包含这个版本的 preview 上、合并之前**做浏览器验收（按 CLAUDE.md 交给 Codex，同一测试账号一次一个）。
- **R**：调用视频准备被拒；旧数据仍能在资料库显示；旧会话最新材料带视频正文的，迁移后追加一版不带正文的材料（数据库和集成测试）；R 先于 B1 合并，B1 合并后做冒烟复验。
- **全部数据库 PR**：连续执行两次结构不变、指纹更新、0201 守卫标记仍在、本机 without-app 集成用例通过。

### 6.3 所有改写现有函数的 PR 共同必测

对 `runtime_material`、`runtime_session_context`、`runtime_admit`、`runtime_view`、`opc_content_from_execution`、`opc_content_manual_save`、
`opc_content_allowed`、`runtime_context_allowed`：迁移后用 `pg_get_functiondef` 断言 `-- D7 read boundary` 等标记仍在，
并各跑一条"内容已删除时被拒"的回归用例。

## 7. 和在途工作的冲突

| 共享的东西 | 在途 | 本方案 | 怎么排 |
| --- | --- | --- | --- |
| `services/opc/service.ts` | 开放 PR 里没有改它的 | A1（简报更新接口）、P3-A | 同一时间只有一个 PR 写；A1 先，P3-A 后 |
| `runtime/admission.ts`、`execute.ts`、`matching.ts` | #829（模型身份，改三者）、#845（`execute.ts`）、#832（`execute.ts`）、POSITIONING-GATE PR2（① 线） | A2、A3 | A2、A3 等它们合并后再开工写这几个文件；A1 不碰 |
| `runtime_context_allowed` | #863（0225，锚点补丁） | A2 | A2 在 #863 后，基于合并后的定义打补丁 |
| `runtime_view`、`runtime_admit` | 无开放 PR；0201 的守卫 | A3、P2-A | A3 先改 `runtime_view`，P2-A 只加纪要列表；都保留守卫 |
| `app/runtime/page.tsx`、`components/opc/workspace-frame.tsx` | #873（删回答入口、侧栏 ⋯ 菜单）、#872（UI-A 发送清空）、#829 | B1、P2-B | B1 在这三个合并后开工 |
| 输入框组件 `components/opc/work-composer.tsx`、`composer-editor.tsx` 等 | UI-A / UI-B（④ 线：#872、#871，"新输入框与 R8a/R8b 工作区页面排队"） | B1 只用输入框、不改它；当前 Skill 标签放在输入框外层 | B1 不改输入框组件；需要输入框新增插槽时由输入框窗口提供，按 ④ 线顺序 |
| `topics/page.tsx` | #829 | P3-B | P3-B 在 #829 后 |
| 共用工作区页面 | R8b（⑤ 线：R14 #849 → R8b，未开工） | B1、P2-B | R8b 和 R8a 先后改同一页面（AGENT_CORE_CLOSEOUT 第 2 节）。建议后端 A1–A3 和 R8b 后端可并行；页面层谁先开工由总控按 ④⑤ 线定，后开工的基于先合并的版本 |
| 迁移编号、`built-fingerprint.json` | 0220–0227 在途 | X1–X5 | 按合并顺序重建指纹；编号向总控要 |

## 8. 需要 Owner 决定的事（只列出，交总控）

- **O1 定位修订后，已有的选题窗口跟不跟着换？** R5 定稿后再修订、R14 同步会产生新的定位版本。现状是选题窗口固定绑定采用时的版本。
  选项：A. 继续用旧版本，窗口顶部提示"定位已更新，这个选题基于旧版定位"，新选题用新版本（AI 推荐：不改动用户已在写的稿子，也不需要新代码路径）；
  B. 已有选题窗口自动换成新版本。
- **O2 R8a 的真实模型验收预算**：AGENT_CORE_CLOSEOUT 第 5 节写"R8a 另报预算"。#621 Q4 的 5 美元只覆盖第 6 节 E 的小评测；
  B1、P2-B 在 staging 的浏览器验收要调用真实模型（估计每次完整走一遍约 0.5–1 美元，含口播稿、分镜、纪要）。需要 Owner 定一个上限，或者确认并入 Q4 的 5 美元。

以下由 AI 按技术判断处理，不需要 Owner 决定（Owner 不同意可以推翻）：简报继续是一份可编辑的条目信息、不保留历史版本（沿用现有资料库行为）；
`unknown` 类型保存时先让用户选类型；"正文"沿用 kind `brief` 不改名；正文按需注入的记录方式。

## 9. 发现的问题（不在本方案范围，汇报给总控）

1. 改条目信息在定位档案很大时可能因材料载荷 24000 字节上限失败（2.1 末条）。A1 顺手加测试和明确提示；如果要调上限，单独评估。
2. 0201 删稿件会抹掉 `request_id` 等于稿件 id 的材料修订，在现状下会连带抹掉标题和定位档案（因为它们在同一版材料里）。A1 改为独立请求 id 后自然消除，旧修订不追溯。
3. kind `brief` 实际表示文章 / 图文正文，名字容易误导。本方案只在接口和显示层讲清楚，改名留给 LEGACY-CLOSE。

## 10. 本方案做过的核对

- 本地只读：迁移 0106、0107、0113、0117、0122、0124、0127、0128、0167、0201、0209、0218、0219；`runtime/admission.ts`、`context.ts`；
  `components/opc/content-editor.tsx`、`app/library/page.tsx`、`app/runtime/page.tsx`；`shared/opcRequests.ts`；
  文档 AGENTS.md、`docs/ENGINEERING.md`、Master Plan（第 2.1 节 10-12 各项、第 7.1 节、第 7.4 节）、`AGENT_CORE_CLOSEOUT.md`、#621 方案及第八轮审查三条意见。
- GitHub：开放 PR #873、#872、#871、#869、#867、#865、#863、#857、#856、#849、#845、#832、#829 的改动文件和迁移。
- 没有访问数据库、没有调用模型、没有运行测试。
