# REPORT-GEN 实施方案（#547 第八版定稿存档）

> 本文件是 [#547](https://github.com/Crnobog9527/GraylumAI_vercel/pull/547) 描述第八版的原文存档，于 2026-10-05 关闭该 PR 时存入仓库（MASTER_PLAN 第 2.1 节第 54 项）。
> Owner 2026-10-04 定稿（[原话](https://github.com/Crnobog9527/GraylumAI_vercel/pull/547#issuecomment-5971932591)）。分隔线以下是原文，逐字节未改：81361 字节，SHA-256 `55f02f21d392f7a60674fc0b4daed81a6c54e0d4da5938347914b0255235f0fa`，与定稿记录一致。
> 已被取代的三处（以 MASTER_PLAN 为准）：报告单独输出上限 24576（D1，第 44 项）；截断后自动续写（首版不做，第 44 项后续决定）；默认加价倍数 3（第 50 项改为 6）。还没定的事见第 54 项，开工时问 Owner。
> 以后修改实施做法，直接改本文件并按 AGENTS.md 审查；涉及产品决定的，先问 Owner。

---

## 结论与授权

**REPORT-GEN，风险 high，仅方案，第八版（2026-10-04）：第五版按边用边扣第七版重写，第六版按[完整审查 5959181491](https://github.com/Crnobog9527/GraylumAI_vercel/pull/547#issuecomment-5959181491) 的 F1–F5 修订（[总控记录 5961420581](https://github.com/Crnobog9527/GraylumAI_vercel/pull/547#issuecomment-5961420581)）；第七版按[复核 5964786138](https://github.com/Crnobog9527/GraylumAI_vercel/pull/547#issuecomment-5964786138) 的 G1 修订（[总控记录 5964792671](https://github.com/Crnobog9527/GraylumAI_vercel/pull/547#issuecomment-5964792671)）；第八版按已合并的 [#604 对话原生体验方案](https://github.com/Crnobog9527/GraylumAI_vercel/pull/604)（staging `95ecefd7`）做小同步：D1 作废、报告用全站统一单次上限、写满以 `length_limit` 收尾（[总控记录 5965354780](https://github.com/Crnobog9527/GraylumAI_vercel/pull/547#issuecomment-5965354780)、[#604 合并决定 5971006438](https://github.com/Crnobog9527/GraylumAI_vercel/pull/604#issuecomment-5971006438)）。待增量复核。**

授权：Owner 2026-10-03 在总控窗口决定，原话「同意现在开规划窗口，按边用边扣第七版重写 #547 报告生成方案。」（[总控记录 5958789958](https://github.com/Crnobog9527/GraylumAI_vercel/pull/547#issuecomment-5958789958)）。写入方：本描述从这一版起由 Claude 规划窗口写，原写入方不再修改。

**一句话**：REPORT-GEN 只负责报告**内容**——报告清单和资源、确认事实快照、输入容量（单次输出上限用 #604 的全站统一值）、生成接线、候选保存、分章调度（分章另批）；**钱的事全部交给 BILL-PAYG（[#553](https://github.com/Crnobog9527/GraylumAI_vercel/pull/553) 第七版定稿）**：每次调用怎么冻结、怎么扣、余额不够怎么暂停和续跑、平台承担和提醒、取消、未知费用、退款、注销收尾，报告一律调用 PAYG 的通用能力，不另建报告专用的财务状态、冻结逻辑、队列或 worker。

依据（以 GitHub 原文为准）：
- #553 第七版定稿：描述 UTF-8 142,946 字节、SHA-256 `e431af202d821b2dc4cba2115098471c7a4e5d66e6e8283e2a64f50f26cf41d5`，[独立复核 5958005853](https://github.com/Crnobog9527/GraylumAI_vercel/pull/553#issuecomment-5958005853)，[总控定稿记录 5958061928](https://github.com/Crnobog9527/GraylumAI_vercel/pull/553#issuecomment-5958061928)。
- #598（注销期间在途执行收尾，方案定稿 `001d8b44`）先于 PAYG 实施：[Owner 决定 5957866853](https://github.com/Crnobog9527/GraylumAI_vercel/pull/598#issuecomment-5957866853)。
- #601（PROMPT-CACHE-HISTORY）的[总控决定 5958482083](https://github.com/Crnobog9527/GraylumAI_vercel/pull/601#issuecomment-5958482083)：`runtime/execute.ts` 里"最终请求定形 → 字节检查 → hash → claim"这一段由 H1 先写，PAYG PR-B 在 H1 合并后开工。
- #604（CHAT-NATIVE-OUTPUT）已合并到 staging `95ecefd7`，方案文件 `docs/launch/CHAT_NATIVE_OUTPUT_PLAN.md`：首版不做自动续写；全站统一单次上限 staging 8192、正式环境提高（32768 为首个候选，实施时定值）；写满时以 `completeness:'length_limit'` 干净收尾并在正文外提示已截断。Owner 决定见 [5969177321](https://github.com/Crnobog9527/GraylumAI_vercel/pull/604#issuecomment-5969177321)、[5970578413](https://github.com/Crnobog9527/GraylumAI_vercel/pull/604#issuecomment-5970578413)、[5971006438](https://github.com/Crnobog9527/GraylumAI_vercel/pull/604#issuecomment-5971006438)（含三项实施前必须先解决的事项）；对本方案的同步清单见 #604 第 8.1 节。

身份：本 PR head `b9e31c0adae109a8387f0240c99c17f926e6cf8b`（第八版在原空提交 `8fb950af` 上合并 staging `95ecefd7af3980bfd80f5cfae087dea00d1a6348`，与 staging 零文件差异），分支 `codex/report-gen-plan-20260930`，base staging。第五到七版核对时 staging 为 `34017395`（#600）。方案只在描述里，不改分支文件。

## 0. Owner 决定

### 0.1 继续有效（原样保留）

| 决定 | 来源 |
| --- | --- |
| 所有带步骤的 Skill 由模型写报告、收积分、**不做运行前费用预告** | [#545 评论 5912684833](https://github.com/Crnobog9527/GraylumAI_vercel/pull/545#issuecomment-5912684833) |
| 先做定位：13 部分、最多 12000 字；能力通用（3/6/8 步的 Skill 都能用） | [#545 评论 5912946236](https://github.com/Crnobog9527/GraylumAI_vercel/pull/545#issuecomment-5912946236) |
| 无步骤 Skill 不进入报告 | 同上 |
| Fusion 评审保留运行前预告（Master Plan 4.4），不被报告决定取消 | Master Plan 4.4 |
| 正式运营用 Vercel Pro；staging 仍是 Hobby | 总控 v4.2 复审 [5929954633](https://github.com/Crnobog9527/GraylumAI_vercel/pull/547#issuecomment-5929954633) |
| staging 实测授权：单次全文最多 3 次、供应商累计不超过 0.50 美元，未知费用即停，不补样（第八版：按 #604 第 8.1 节不自动沿用，改按 O=8192 重新申请，见 D2） | [#547 评论 5915060111](https://github.com/Crnobog9527/GraylumAI_vercel/pull/547#issuecomment-5915060111) |
| 报告不单独设输出上限，D1 并入全站统一单次上限；首版不做自动续写，写满时干净收尾并提示已截断；staging 8192，正式环境提高（32768 为首个候选，实施时定值） | [总控记录 5965354780](https://github.com/Crnobog9527/GraylumAI_vercel/pull/547#issuecomment-5965354780)；#604 的 [5969177321](https://github.com/Crnobog9527/GraylumAI_vercel/pull/604#issuecomment-5969177321)、[5970578413](https://github.com/Crnobog9527/GraylumAI_vercel/pull/604#issuecomment-5970578413) |
| **报告付费墙**：带步骤 Skill 生成报告必须是付费会员，同时照常扣积分；有积分的免费用户也不能生成报告；一次性会员（微信 1 个月/1 年）同样算付费会员；会员检查在服务端的报告入口和调用准入两处执行，页面只负责提示；会员到期后已生成的报告仍可看、可导出，只是不能生成新报告；报告前已确认的资料免费用户也可以看、可以导出，不收回 | #618 合并的 [MASTER_PLAN 第 50 项](https://github.com/Crnobog9527/GraylumAI_vercel/blob/95ecefd7af3980bfd80f5cfae087dea00d1a6348/docs/launch/MASTER_PLAN.md#L351-L398)（Owner 2026-10-03） |
| 所有模型调用边用边扣 | [#547 评论 5915435152](https://github.com/Crnobog9527/GraylumAI_vercel/pull/547#issuecomment-5915435152)，细则以 #553 第七版为准 |

### 0.2 来自 #553 第七版、报告直接适用的决定

向用户按名义费用收费，缓存和临时折扣不让给用户（[5957160656](https://github.com/Crnobog9527/GraylumAI_vercel/pull/553#issuecomment-5957160656)）；缺 token 时按 min(c,U) 收、标 `actual_fallback`；分时价取所有时段最高（[5957737094](https://github.com/Crnobog9527/GraylumAI_vercel/pull/553#issuecomment-5957737094)）；q=100、全站默认 m=3、模型/线路可覆盖；不允许负余额；价格变动提醒和平台承担提醒只提醒不拦截；#553 Q1=A、Q2=门槛首版不随价格自动更新（[5954715142](https://github.com/Crnobog9527/GraylumAI_vercel/pull/553#issuecomment-5954715142)）。

### 0.3 需要 Owner 新决定的事项

见文末"需要 Owner 决定"一节：**D1 已作废**（并入 #604 全站统一单次上限，不再需要 Owner 单独批准）；D2 staging 实测用哪个模型、额度按 O=8192 重新申请；D3 staging 测报告时是否临时调高单次上限（推荐不调高）。D2、D3 都是实测前才需要，不阻塞开工。

## 1. 分工：REPORT-GEN 做什么、不做什么

| 责任 | 归属 |
| --- | --- |
| 每次调用的上限 U、冻结 H=min(G,A)、启动门槛 L、名义费用 n、累计一次进位、余额封顶和平台承担、暂停 waiting_credits / waiting_resume、充值后续跑（原 execution＋游标＋epoch 比较交换）、取消、未知费用 cost_pending、退款补偿、注销收尾、测试窗口占用、管理员报表和两种提醒 | **BILL-PAYG #553**（PR-A 计费核心、PR-B Runtime 接线、PR-C 价格提醒、前端 PR、默认路径切换小 PR） |
| 报告清单（manifest）和资源加载、确认事实快照、输入容量预检和冻结读取（单次输出上限、写满收尾和截断提示归 #604 C0+C1）、无持久对话 Session 的调用方式、报告候选保存和重放、报告生成控制器（start/status/cancel/resume 只是转调 PAYG 原语）、分章调度（另批） | **REPORT-GEN #547** |
| 每步确认和依赖复核、生成入口布局和文案、确认候选、正式版本定稿、评审修订同步、第一周选题 | **AC-3** |
| 付费会员的判定（复用现有会员权威：`profiles.membership_level` 和最新会员事实，与 `membershipEntitlements.ts` 同一套判定；一次性会员接入同一权威后同样算付费会员）、可在创建/预留事务里调用的服务端会员检查、开通会员的提示和价格页、免费用户的报告前资料导出 | **PAYWALL**（MASTER_PLAN 第 50 项的实施分工） |
| 在两处服务端位置调用 PAYWALL 的会员检查：报告 start 入口，以及每次报告调用的创建/预留事务（PAYG claim 之前，含等待积分后续跑发起的新调用）；会员不合格时的报告状态；到期后旧报告读取不看会员资格 | **REPORT-GEN #547** |

REPORT-GEN **不新增**：会员状态或会员表、钱包、账本、报告专用 run 类型、报告专用冻结或结算、报告专用暂停状态机、队列、worker、定时任务。报告显示的状态都是 PAYG 状态的映射，只有"资料冲突"（source_conflict）是报告内容自己的检查结果。

## 2. 计费：全部引用 PAYG 第七版

### 2.1 符号统一

按总控 v4.2 复审的提示，本方案改用 #553 的同一套符号（v4.2 里的 U_i 表示实际费用、Û_i 表示上限，已废止）：

| 符号 | 含义（#553） |
| --- | --- |
| U_i | 本次调用的估算费用**上限**（美元） |
| c_i | 实际费用（OpenRouter 回执 `usage.cost`），**只用于对账、平台真实成本和测试额度** |
| n_i | **名义费用**：按标价算的收费基准（#553 第3A节）；`actual_fallback` 时为 min(c_i,U_i) |
| m_i、q | 本次冻结的倍数（默认 3）、兑换参数 q=100 |
| G_i、A_i、H_i、L | 上限积分 ceil(q×U_i×m_i)、锁内可用余额、实际冻结 min(G_i,A_i)、模型＋用途的启动门槛 |
| W、N、Δ_i、D_i、e_i、C、E | W=Σ(n_i×m_i)；N=ceil(q×W)；Δ_i 为 N 的前后差；用户实扣 D_i=min(Δ_i,H_i)；平台承担 e_i=Δ_i−D_i；累计 C+E=N |
| S、S_n、g_i | S=Σc_i、S_n=Σn_i、平台差额 g_i=n_i−c_i |

### 2.2 报告怎么收费

一份用户发起的报告是**一个 PAYG v2 run**；单次全文就是这个 run 里的**一次调用**；以后若另批分章，提纲和每章各是同一 run 里的一次调用，不逐章另开 run（否则会绕过累计一次进位）。

- **调用前**：PAYG 用本次最终请求的 UTF-8 字节 B 算 T=B+K+M，按 #553 第2节的单价上限（输入取 max(普通输入价, 5分钟缓存写入价, 适用档位价)，输出已含思考，分时档总是计入）算 U；G=ceil(q×U×m)；在锁内算 A。**A<L 时不发调用**，持久化 waiting_credits，提示"余额低于本次启动门槛，请充值后继续"；A≥L 时冻结 H=min(G,A)，**不要求 A≥G**。
- **调用后**：n 由 PAYG 的 SQL 按冻结的 `nominalPricing` 标价表和回执 token 数计算，规则完全按 #553 第3A节第1条：`n = [P×输入标价 + (completion_tokens−R)×输出标价 + R×思考标价]/10⁶ + 请求标价`。其中 P 是全部输入 token（含缓存读写），completion_tokens 已含思考，R 是其中的思考 token（档位没有单独思考价时思考按输出标价计，不需要 R）；不用缓存价和 discount；分时价取最高。报告不另写计价器。然后扣 D=min(Δ,H)，平台承担 e=Δ−D，释放 H−D。c 原样记账。
- **缺 token**：有界查账后仍缺、但 c 已知 → 收费基准取 min(c,U)，标 `actual_fallback`；c 也未知 → 保留 hold，转 cost_pending，不发后续调用，充值不能解除。
- **超界**：n>U、c>U 或 P>T 按 #553 的"超过上界"处理（budget_conflict、停新调用、该模型退出收费准入）；用户最多付本次 H，超出部分归入 e_bound。**只是余额封顶造成的平台承担不设 budget_conflict、不停用模型。**
- **不允许负余额**：D≤H≤A。平台承担 E 不是用户欠款，充值和恢复都不追收。
- 报告用途的启动门槛 L 用 PAYG PR-A（#617，staging `da0a89a5`）已合并的 [0162 实际读取的 `billing_payg_start_thresholds`](https://github.com/Crnobog9527/GraylumAI_vercel/blob/da0a89a52819f23c801ca53ed7c7348a5a2aecfd/packages/db/migrations/0162_bill_payg.sql#L299-L304)：`thresholds` 数组里按 **精确模型＋`purpose`** 唯一匹配（`purpose` 与本次调用冻结的 `phase` 比较），报告用 `report` 这一项；不新增平行配置，本方案不写配置。不借用对话用途的 L（报告单次费用比对话高得多，借用低门槛会让小余额用户触发大额平台承担）。缺报告用途的有效 L 时，PAYG 拒绝新收费并显示"配置待处理"，不提示充值。
- 报告的调用自动进入 #553 的管理员报表（报表按精确模型＋用途＋日期汇总）。两种提醒直接沿用 #553 各自的规则：平台承担提醒按"精确模型＋UTC 自然日"汇总（不按用途拆分），价格变动提醒比较端点字段的当前快照和基线。报告不另做报表或提醒。

REPORT-GEN 只负责把报告请求组装成"最终请求"交给 PAYG 计量；不重复实现 U/G/H/n 的任何一步，不保存另一份金额。

### 2.3 报告请求是否加提示缓存（技术决定）

名义费用收费以后，缓存只影响**平台实际成本**，不影响用户扣费（#553 第3A节；`actual_fallback` 的调用除外，单独核对）。

- **首版单次全文：明确排除**，报告请求不冻结 `promptCache`（v1、v2 都不加）。理由：每份报告通常只调用一次，Anthropic 显式标记会让约 91 KB 稳定前缀按 1.25 倍写入，5 分钟内没有同前缀的再次读取就是平台净增成本；用户扣费不变。这个选择要写进准入代码并有测试，**不能因为报告也是 skill 角色、`anthropic/` 模型就无意中继承 #591 的自动冻结**。
- U 不受这个选择影响：同一线路上不带标记的调用，PAYG 仍按含写入价的单价冻结（#553 第2节，保守量，只影响 H 不影响实扣）。
- GPT-6 Luna 的自动写入和 Gemini 的隐式缓存不受标记控制，按回执记账即可。
- H1（#601）的 `prompt-cache-v2`、`hostTurnContext`、`historySelection` 只用于导师轮；报告 history=0，不使用这三项。
- 以后另批分章时，13 章和提纲共用"资源＋事实＋提纲"前缀，再按 #572/#601 的净成本口径评估是否开启。

### 2.4 报告付费墙（第八版按复核 FULL-1 补入）

依据 [MASTER_PLAN 第 50 项](https://github.com/Crnobog9527/GraylumAI_vercel/blob/95ecefd7af3980bfd80f5cfae087dea00d1a6348/docs/launch/MASTER_PLAN.md#L351-L398)，这是已锁定的产品决定，不需要 Owner 再定。

- **谁能生成**：只有付费会员（有效订阅，或一次性会员）。有积分的免费用户也不能生成报告；生成照常按 PAYG 扣积分，会员资格和积分余额是两道独立的检查，谁也不能代替谁。
- **两处服务端检查**（页面只负责提示，不是检查点）：
  1. **报告入口**：报告 start 路由先查会员，不合格直接拒绝，不建 run、不冻结、不派发。
  2. **调用准入**：每次报告调用在创建/预留事务里（PAYG claim 之前）再查一次。`readMembershipEntitlements` 的读取投影**不是**准入凭证（源码注释写明消费方须在创建/预留事务里重新检查），只能用来显示。等待积分（waiting_credits）后续跑发起的新调用也要重新检查；这时会员已到期，就不派发新调用，未派发的 hold 按 PAYG 取消规则释放，已结算的不变，报告标为未完成并提示开通会员，不提示充值。
- **会员权威**：复用现有会员权威（`profiles.membership_level` 和最新会员事实，判定与 `membershipEntitlements.ts` 一致），不新建会员状态、表或开关。一次性会员由支付/PAYWALL 任务接入同一权威，接入后自动算付费会员，报告侧不另写判断。
- **接口分工**：PAYWALL 提供"这个用户现在是不是付费会员"的服务端检查，并保证能在事务里调用；REPORT-GEN 只在上面两处调用它并处理拒绝结果。具体落点（SQL 函数或同事务的等价检查）实施时由两边按单一写入规则定，不重复实现。
- **到期后**：已生成的报告仍可看、可导出；报告前已确认的资料也不收回。读取旧报告**不检查会员资格**，只按第 7 节检查 actor/scope/Skill/source、注销和撤权——会员到期不等于来源撤权，真实注销和来源撤权照常生效。
- **用户入口开放前提**：双层服务端会员检查已交付并通过验证（第 3 节、第 11 节必测）。

## 3. 开工顺序和写入协调

### 3.1 前置链

```
RATE-LIMIT 联合候选 #594（含 #590）合并
  ├─ #598 实施（Owner：先于 PAYG）──→ PAYG PR-A（SQL 和 BILL2）
  ├─ H1（#601 机制 PR，改 execute.ts 这一段）
  └─ B1 #593（可与上面并行）
PAYG PR-A 合并 ＋ H1 合并 ──→ PAYG PR-B（Runtime 接线）
#604 C0+C1（统一流式、统一上限、写满收尾、保存截短）合并
PAYG PR-B 合并 ＋ C0+C1 合并 ──→ **REPORT-GEN 实施开工**
PAYG 前端 PR 通过技术验收 ──→ PAYG 默认路径切换小 PR ──→ 三份真实样本
PAYG 默认路径切换 ＋ PAYWALL 双层服务端会员检查交付并验证 ──→ 报告入口对用户开放
```

- **REPORT-GEN 在 PAYG PR-B 合并后开工**，基于当时最新的 staging（必然已含 #594、#598 实施、H1、PAYG PR-A/PR-B，预期也已含 B1）。只有 PR-A 不够：报告需要 PR-B 提供的每次调用计量、waiting_credits、断点列、续跑、闸门重过和新结果状态，这些都在 `runtime/execute.ts`、`executionStream.ts`、`shared/agentTurn.ts` 里。
- **报告入口对用户开放和三份真实样本，要等 PAYG 默认路径切换 PR 合并**。#553 规定前端等待和继续界面通过技术验收前，新准入默认仍是 v1、v2 只能由测试创建、不新增运行开关；报告**不走 v1**（v1 是整 run 一次预扣，正是 Owner 已取代的做法），也不为报告单独开 v2 开关。在此之前，报告实现可以合并到 staging，但入口保持关闭，只用测试创建的 v2 run 做集成测试。
- **第八版补充**：#594、H1 #610、B1 #593 已合并（staging `95ecefd7`）。报告实施还要等 #604 C0+C1 合并：统一上限、`completeness`、写满收尾和保存截短由 C0+C1 先写（#604 第 7.2 节），R-A、R-B 在其后。#604 合并时 Owner 接受、要求在相关实施 PR 先解决的三项（导师可出卡片回合的流式 4173860195、结果已提交未送达时停止 4173860200、调用进行中重连的快照 4173860204）不由报告解决；报告用到流式显示、停止、重连这些路径时，以对应实施 PR 解决后的规则为准。
- **第八版补充（付费墙）**：报告入口对用户开放还要等 PAYWALL 的会员检查交付，并且报告入口和调用准入两处检查都通过验证（第 2.4 节）。在那之前入口保持关闭，只用测试创建的 run 做集成验证。
- 报告生成也走 #590 的两道闸门：新报告是一条新操作，过 admission 桶；每次 `execute()` 第一次 claim 前过 calls 桶。续跑按 PAYG PR-B 的规则重过 calls 闸门，被拒时保持等待、不取消。

### 3.2 文件和写入顺序

| 对象 | 会碰的文件（以开工时实际清单为准） | 顺序 |
| --- | --- | --- |
| H1（#601） | `runtime/promptCache.ts`、`providerRequest.ts`、`context.ts`、`execute.ts`、`session.ts`、`admission.ts`、`bill2/openRouterAdapter.ts` | H1 → PAYG PR-B → REPORT-GEN。REPORT-GEN 量到的 B 已是 H1 定形后的最终请求；报告不再自己加缓存开销，也不改 H1 的历史裁剪 |
| PAYG PR-A / PR-B | BILL2 服务和 SQL、`openRouterPolicy.ts`、`openRouterAdapter.ts` 的重复校验、`runtime/execute.ts`、`executionStream.ts`、`shared/agentTurn.ts`、`runtime.integration.ts`、追加迁移 | 报告在 PR-B 之后；报告用到的 PAYG 断点列、状态码只读取或按 PAYG 约定写入，不改它们的定义 |
| #598 实施 | 注销判定和财务恢复（按 #601 总控决定不改 `execute.ts`）；同改 `executionStream.ts` 时与 B1 由后合并方同步 | 先于 PAYG，因而先于报告。报告不改注销判定 |
| B1 #593 | `opc/service.ts`、`opc/capture.ts`、`runtime/executionStream.ts`、`timing.ts`、`runtime.integration.ts`、迁移 0159 | 预期远早于报告合并；若开工时 B1 仍未合并，REPORT-GEN 等它，不并行改 `opc/service.ts` 和 `executionStream.ts` |
| #604 C0+C1 | `responseCapacity.ts`、`openRouterStream.ts`、`openRouterPolicy.ts`、`budget.ts`、`purposeBudgets.ts`、`MentorBudgetSettings.tsx`、`mentorBudgetDraft.ts`、`runner.ts`、`execute.ts`、`admission.ts` 等（以 #604 第 7.2 节为准） | 先于报告。统一上限、R(O)/F(O)、超时推导、`completeness` 和保存截短由 C0+C1 写，报告只读取 |
| REPORT-GEN | Skill 发布和加载（report 节点声明、资源清单）、`runtime/purposeBudgets.ts`（只改报告输入上限和冻结读取）、`runtime/runner.ts`（不写 Session 内容的分支；宿主空批次）、`admission.ts`（报告用途准入）、报告服务和路由；不再改 `responseCapacity.ts`、`openRouterStream.ts`、`openRouterAdapter.ts` 的输出容量，也不再有回执 CHECK 迁移 | 最后（在 PAYG PR-B 和 #604 C0+C1 之后） |

- **共享测试和基线文件**（`without-app.mjs`、`run-workbench.mjs`、`code-size-baseline.json`、`eslint-suppressions.json`、`tsconfig.json`/`type-check-baseline.json`、`runtime.integration.ts`、`built-fingerprint.json`）：沿用 #601 第5.3节的规则，每个 PR 开工前在 PR 里写明会碰哪些，由总控为每个共享文件指定单一写入负责人；合并时仍由后合并方同步。
- 迁移编号取开工时 staging 最大编号＋1（排在 PAYG 的迁移之后），按 0157 的写法对要替换的函数做 md5 防漂移检查，基准一律取开工时 staging 上的最新定义。
- 写入方由总控按当时分工安排（当前分工：后端开发 Codex、前端 Claude）。

## 4. 输出上限：用 #604 的全站统一单次上限（第八版，D1 作废）

**代码现状（本地只读核对 staging `34017395`；第八版在 `95ecefd7` 复核，这些常量未变）**：`bill2/responseCapacity.ts` 的 `PURPOSE_OUTPUT_CAP=8192`，完整回复接收上限 `2×8192×8+8192=139264` bytes；`openRouterStream.ts` 帧数上限 `2×PURPOSE_OUTPUT_CAP+64=16448`；`runtime/purposeBudgets.ts` 中 report 输入上限 90000 bytes、`maxOutputTokens` 不超过 8192；`readPurposeBudgetView` 的 legacy 视图写着 `report: { active: false }`。staging 的两项 8192 配置按[总控写入并读回记录](https://github.com/Crnobog9527/GraylumAI_vercel/pull/564#issuecomment-5927680806)；本轮未读远程数据库。

**单次上限按 #604 第 3.1 节**：`O = min(CHAT_OUTPUT_CAP（按环境取值）, ai_models.max_tokens, 报价 outputLimit)`，同时要求 T+O ≤ 上下文容量。staging 8192；正式环境（Pro）提高，32768 是首个候选，C1 实施时核对费用和时间后定值，正式值上线前按 AGENTS 第 10 节批准。同一环境里所有对话和 Skill（包括报告）用同一个值，取值放在代码常量里，不新增后台配置或运行开关。

- **删除**：原 report-full 24576 profile、按用途拆分输出上限、`readPurposeBudgetView` 按用途返回输出上限。#604 第 3.2 节把 `runtime_purpose_budgets` 的 interactive/report `maxOutputTokens` 移出新准入（schema 升到 version 2、version 1 只读兼容、后台只读显示全站上限），由 #604 C1 实施，报告不再写这一块。
- **保留**：报告只保留输入侧——report 输入上限 196608、`frozenPurposeBudget.inputBytes` 按用途校验（第 6、11 节）。
- 实际 max_tokens 取上式的最小值；浏览器不能选择上限；历史冻结上限读取继续兼容（`FROZEN_OUTPUT_CAP=128000` 只是历史读取容量，不是新调用许可）。模型能力仍以 #597 的供应商容量同步为准。

**报告长度和写满**：报告锁定为 13 部分、最多 12000 字。正式环境 32768 按常见中文写作预计可以一次写完，以实测为准；**staging 8192 可能写不完整份报告**。

- 写不完时按 #604 第 3.4 节干净收尾：报告是模型直接写出的 Markdown 正文，按 T1 处理——保存已写正文，结果 `completeness:'length_limit'`，在正文**外面**提示已截断（实时结束和刷新后都显示）；这份结果可以读，但**不作为可确认的完整报告候选**（第 7 节）。如果实施时报告结果改用信封（JSON＋`message`），按 #604 的信封规则只对 `message` 计量和截断。
- 首版**没有自动续写**。自动续写是 #604 第二版（第 13 节）；第二版上线后报告是否改为"写满时续写"，届时另行同步。
- 原来"截断不算成功、只能改走分章"改为"写满时以 `length_limit` 收尾，不作为完整候选"；分章不再是上限不足的默认退路（第 9 节）。

**PAYG 准入要求**：#553 的闭源验证矩阵只覆盖输出 1024 的 profile，并写明"报告等更大输出用途须补相应 profile 验证和单独预算"。报告的输出 profile 证据由报告自己的样本提供（记录 completion_tokens、reasoning_tokens ≤ O，n、c ≤ U），不挪用 #553 的 180 次/48 美元或 #561 的额度；正式环境选定的 O 必须被 #553 已验证的 profile 覆盖（#604 第 3.1、5 节）。输入计量仍须该模型已通过 #553 的输入准入（最大档 B≤196608 正好覆盖报告输入上限）。另外按 #553 第2节核对：T+O 不超过精确模型的上下文容量（B=196608 时 T=204800，加 O=8192 为 212992、加 O=32768 为 237568 tokens），T 达到长上下文档位阈值时 U 按高档价，否则拒绝或把报告 T 限在阈值以下。

**时长**（引用 #604 第 3.3 节）：12000 字不等于固定 token 数，正文和思考都占输出。粗算（不是完成保证）：staging 8192 token 在 240 秒内约需 34 token/秒；正式环境 32768 在约 700 秒内约需 47 token/秒；按 12000–24000 输出 tokens、首字 20 秒估算，staging 240 秒内写完整份报告约需 55–109 tokens/s，**能否一次写完还没有实测**。

- 一次调用写到一半超时，首版**不能无感完成**：进入现有超时和 `cost_pending` 路径，这次内容丢失，界面如实显示没能完成（#604 第 3.3 节）。
- staging 目标：模型 ≤210 秒、报告保存完成端到端 ≤270 秒，留 300 秒内收尾余量；账务失败都不算通过。staging 8192 写满以 `length_limit` 收尾是可预期结果，按写满路径验证，不算报告长度验收；不自动追加"续写"调用。

**正式运营 Pro**：[Fluid Compute 通常最长 800 秒、默认仍 300 秒](https://vercel.com/docs/functions/limitations)；按 #604 第 3.1 节，单次供应商超时、SDK 包装超时、`RUNTIME_WORK_MS`/`RUNTIME_PERSISTENCE_MS` 改为由该环境的函数时长推出（全站统一，由 C1 实施，不再单给报告路由）；路由 `maxDuration`、Vercel 套餐和函数时长属于 provider 配置，按 AGENTS 第 10 节另取批准；升级套餐不会自动取消代码里的 240 秒限制。staging Hobby 成功不能当 Pro 验收，Hobby 超时也不能直接判定 Pro 不可行。Pro 环境变更和新增样本另按执行安排批准。不建后台队列或生成 worker；`waitUntil` 不解除函数时限。

## 5. 资源、事实快照和输入容量

### 5.1 报告清单和资源

复用 `workflow.yaml → modulePublication/validateWorkflow → 不可变发布包 → databaseSkillSource → activateSkill(resources)`。在既有 report 节点增加可选生成声明：模板身份、完整资源根、章节顺序/资源/长度、总字数、执行模式。代码按声明处理 3/6/8 步，不写死定位 13 章；旧的无声明轮次和历史报告保持原格式可读，不因字段缺省偷启用新的收费能力。

本地 2.6.0 候选清单（v4.1 的本地测量记录，本轮未重测；是本地未发布包，不是 staging 已发布版本证据）：**18 个资源、原文 90165 bytes、仅资源 JSON 93019 bytes**。

| 资源（Skill 内相对路径） | 原文 UTF-8 bytes |
| --- | ---: |
| SKILL.md | 13937 |
| references/reporting.md | 3782 |
| assets/report-template.md | 6495 |
| references/naming.md | 4303 |
| references/compliance.md | 2229 |
| references/07-hypotheses.md | 2617 |
| references/audience-analysis.md | 6768 |
| references/06-monetization.md | 11279 |
| references/05-operations.md | 7622 |
| references/04-content-planning.md | 4893 |
| references/03-positioning.md | 4223 |
| references/02-benchmark-analysis.md | 7077 |
| references/platform-playbook.md | 5981 |
| references/research-policy.md | 2639 |
| references/metrics.md | 1571 |
| references/review-rubric.md | 3353 |
| assets/content-plan-template.md | 920 |
| assets/benchmark-table-template.md | 476 |
| 合计 | 90165 |

精简顺序（先去重复的输出模板，不删事实、合规和关键方法）：
1. 报告清单不含 `content-plan-template`（30 天排期已由 report-template 运营章覆盖）；该文件继续供第一周选题的 planResources 使用。
2. 报告清单不含 `benchmark-table-template`（report-template 已含对标总表）；02 保留。
3. **保留 review-rubric**（reporting 要求写完按它自检）；其中"评审可联网""至少 3 个对标才能完成"的旧文案，在发布前按当前锁定决定消除冲突：生成不联网、不强凑对标。
4. metrics 保留。还不够时在 Skill 发布任务里逐条证明等价后提炼，不由 Runtime 临时裁剪。

去掉两个模板后 **16 个资源的紧凑 JSON 实测 91442 bytes**（v4.1 本地记录）。Loader 现成的路径校验、SHA、requires 去重、权限/撤销检查和有界缓存继续复用；当前发布器把 requires 置空，新增报告清单须显式完整；现有 planResources 不挪作报告清单。发布包身份或字节变化就重新计量。

### 5.2 确认事实快照和容量（沿用 v4.1 本地测量，未读真实用户资料）

每份 Runtime/BILL2 冻结载荷内，**事实只放进模型指令（instructions）一次**，不放进 `input`、`request.input`、`scopeMaterial` 或 `sources`；来源权限只带最小 ID/hash 引用。只带当前有效确认正文一次，不同时复制 steps.body、confirmations.body 和历史候选。

| 合成样本（12 步压力情景） | 事实 JSON bytes | 协议形状 bytes | 对 196608 的剩余 |
| --- | ---: | ---: | ---: |
| 中等信息量 | 47641 | 142942 | **53666** |
| 密集信息量 | 79465 | 174934 | **21674** |
| 合法字段/正文上限反例（非全系统上界） | 1089997 | 1188826 | 超出 992218 |
| 转义压力反例 | 2155597 | 2609626 | 超出 2413018 |

**报告输入上限提议：只对 report 用途升到 196608 bytes（192 KiB），事实最终序列化贡献 ≤81920 bytes。** 静态预算 91442（资源）+81920（事实）+12288（编码/宿主指令/协议预留）=185650，余 10958 bytes。196608 恰好是 #553 闭源验证矩阵最大档的 B 上限，报告不得超过它（超出就是未验证 profile，PAYG 拒绝）。普通交互和整理的输入上限不变。

实际 SDK 和完整宿主指令接好后，用同一批样本重测最终 wire、两份冻结 JSONB 和内存：最终请求 ≤196608、事实 ≤81920、两份冻结 payload 各 ≤262144 才准入。额外指令超过 12288 就在冻结前拒绝。

**超出容量**：不扣费、不派发，返回"确认资料超出报告容量"，回到 AC-2/AC-3 的资料整理和重新确认入口；宿主只能无损去重，不得自行概括或丢弃确认事实；需要模型整理时是用户另行发起的一次正常收费操作，不能在本次报告里暗加调用。当前不自动切分章。大工作稿暂不能生成是已知产品边界。AC-2 最终快照或 Skill 资源变化会让上表失效，须在真实样本前重做离线容量检查。

**生成前的资料检查**：报告基于 AC-3 全部确认的快照。若同一会话有一轮"主回复已完成、整理等待积分"的 execution（#553 Q1=A 情形），说明右侧资料可能还缺这一轮，报告准入不放行，提示先继续那一步整理（单独收费，按 #553 规则）；不跳过、不在报告里代做整理。`OPC_CAPTURE_PENDING` 不能显示成积分不足。

## 6. 响应容量（按该环境的统一上限 O）

沿用现有算法，设 profile 输出额度 O：聚合回复 `R(O)=2×O×8+8192` bytes，数据帧 `F(O)=2×O+64`（2 用于正文/思考和 reasoning_details 重复投影；8 bytes/单位和 8192 封套是现有工程假设，不是数学定理）。

| 路径 | O tokens | R(O) bytes | F(O) frames | 状态 |
| --- | ---: | ---: | ---: | --- |
| staging 全站统一（含报告） | 8192 | 139264 | 16448 | #564 已合并 |
| 正式环境统一上限首个候选（含报告） | 32768 | **532480** | **65600** | #604 C1 推导和验证，未实现、未实测 |
| report-section 章节 | 6144 | 106496 | 12352 | 分章后备，另批 |
| report-outline 提纲 | 2048 | 40960 | 4160 | 分章后备，另批 |

第八版：原 report-full 24576 行已删除。`responseCapacity.ts`（硬编码 8192）和 `openRouterStream.ts`（引用共享常量）按 #604 第 3.1 节改为按环境的统一 O 推导，由 C1 写；报告不新增用途级 profile，只读取冻结的 O；旧冻结执行维持原解码和接收行为。分章两行只是备选（第 9 节），未授权。

| 其他边界 | 处理 |
| --- | --- |
| report 输入 90000；冻结读取 `frozenPurposeBudget.inputBytes` ≤112000 | 报告专用拟 196608；冻结读取按用途校验（report ≤196608，其他用途保持原上限），旧冻结合同照旧可读；普通/整理不变 |
| Runtime/BILL2 冻结 payload 各 262144 | 保持；history=0、organizeAfter=false；事实只在 instructions 一次 |
| 非流式回复/流式 SDK 聚合 | 当前 139264；按该环境 O 用 R(O) 推导（C1）；O 贯穿 adapter 读体、流式累计、`parseExactJson`、evidence 解压和恢复投影，不能漏一层 |
| 单帧/detail 增量、费用查询、HTTP 错误证据 | **65536 保持** |
| SSE wire 总量 | 当前 4194304 不等于 R(O)；按该环境 O 由 C1 定全站值，报告不另设专用总量 |
| receipt JSONB 524288 | 按 #604 第 3.1 节：C1 证明在选定 O 下回执原文不会以 `receipt_size_limit` 省略，证明不了就降低候选值；提高 524288 是单独的 high 迁移，另交 Owner 批准；报告不另提专用边界 |
| bill2_close 结果 262144 | 保持；只存报告正文、精简来源/章节/哈希，不存思考；保存前按 #604 第 4.3 节按实际字节计量和截短，永不超过 262144，截短时记 `length_limit` |
| Session item 262144 / batch 1048576 | 保持；报告不写 Session 正文 |
| bill2_calls.payload 65536 | 保持；PAYG 在里面放派生报价、`nominalPricing` 和计量字段，报告不往里加内容 |
| PAYG 断点列（run 新列，合计 65536） | 报告只放引用（见第8节），不复制正文 |

**wire 和回执的测量与定值（未执行）**：第八版起由 #604 C1 对全站统一 O 执行；报告样本照样记录下面这些数字，作为报告路径的补充证据，不单独为报告定值。
1. 离线合成覆盖文本、重复 reasoning_details、极小碎片、长帧、高熵、转义、usage/结束帧，测实际 JSONB，验证本地 PostgreSQL 能保存，不设无限 buffer。
2. 执行前预览写出候选 profile 的 wire bytes / maxFrames / 每帧 bytes / 聚合 bytes / gzip base64 / receipt JSONB 每一项确切数字和内存峰值；没有预览和相应授权不开跑；数据库 CHECK 变更走独立审查和批准。
3. 三份真实样本都走这个候选链路，记录帧分布、总帧数、字节/token 比、压缩率、receipt JSONB 和内存峰值；保护限命中就是 FAIL，不在探针里放大后算通过。
4. 上线取样本最大值和最坏 fixture 上界的较大者，加明确工程余量（建议至少 25%，按部署内存复核），逐项推导而不是一起乘倍数。

这是技术证据门槛，不要求 Owner 选字节数。

## 7. 无持久对话 Session 的调用和持久化

报告基于冻结确认快照、模板和来源，不需要读写聊天历史。继续用同一官方 Agent SDK/Runtime/BILL2，tools=[]、maxTurns=1、history=0。

- 现有 `runtime/runner.ts:89-97` 已有 `readSessionHistory===false` 的包装（读历史返回空），但写入仍落到原 Session。实施时在这个包装上**加一个窄分支：报告不写 Session 内容**，不另起 runner；不能给 SDK 一个"append 成功但实际丢数据"的假 Session——SDK 层用真实的不持久化方式（不把报告轮次交给持久 Session）。
  - **完成凭据（第八版按复核 FULL-2）**：0106 `runtime_execution` 的 `complete` 分支要求本 execution 至少有一条 `runtime_session_batches`，否则抛 `RUNTIME_SESSION_PENDING`（[0106:449-466](https://github.com/Crnobog9527/GraylumAI_vercel/blob/95ecefd7af3980bfd80f5cfae087dea00d1a6348/packages/db/migrations/0106_runtime_sessions.sql#L449-L466)）。所以"完全不 append"会让已有回执的报告无法保存结果。做法：复用现有合法的空批次（[0106:294-306](https://github.com/Crnobog9527/GraylumAI_vercel/blob/95ecefd7af3980bfd80f5cfae087dea00d1a6348/packages/db/migrations/0106_runtime_sessions.sql#L294-L306) 的 `append` 接受空数组）：宿主在 `complete` 之前显式记录一次 `p_items=[]` 的空批次，这时不写任何历史条目，Session revision 不增长；不改 0106 的完成条件，不全局放宽普通对话的保护，不新增迁移。
  - 验收从"append 次数为 0"改为：**不写任何内容条目**（`runtime_session_history` 行数和 Session revision 都不变，只有一条空批次）。
- 供应商原始回复/reasoning/usage 存原 BILL2 receipt；最终报告存原 Runtime result；重放用冻结 request hash 和原 runtime_response，只解析原回复，不发新请求。
- 再次读取正文须检查 actor/scope/Skill/source 是否仍可用，注销和撤权优先。
- 准入、进度、active_execution 仍用现有 Runtime 会话身份；运行中占用会话；等待积分且无未决在途时按 PAYG 释放占用。
- 下一轮普通对话需要报告时，由 AC-3 通过工作区资料/正式报告引用加载，不把 reasoning 塞回历史。
- **哪些内容可读（首版契约）**：只有**已经持久化的完整调用结果**可读——单次全文就是供应商完整回复已存入 receipt、且报告结果已存入 Runtime result 的那一次调用（以后分章时是已完成并持久化的章节）。**首版不保存、也不承诺恢复中途的流式片段**：浏览器里已经显示过的文字不是持久结果；取消、超时或断流时如果还没有最终 receipt/result，这份报告就没有可读正文，费用按 PAYG 处理（已派发且 c 已知就结算，c 未知转 cost_pending），不重发。receipt 已存但 result 未存（例如保存前崩溃）时，恢复入口用原 receipt 重放解析出结果，不发新请求、不产生重复消费（这次调用本身仍按 PAYG 幂等结算，尚未结清的照常结清，不是免除原费用）；**写满和完整性（第八版按 #604 第 3.4 节）**：有正文的 `length` 时保存已写正文，结果 `completeness:'length_limit'`，正文外提示已截断——用户可以读到这份截断的正文，但它**不作为可确认的完整报告候选**；只有 `completeness:'complete'` 且通过 13 部分完整性校验的结果才能作为候选。正文为空的 `length`、截断的工具调用（报告 tools=[]，本不应出现）、`content_filter` 或无法通过报告校验时，只保留为账务和诊断证据，不作为候选。**停止**：报告接入 #604 C2 的停止（`stopAt`）路径时，按 #604 第 4.2 节保存停止时已显示的正文（`stopped:true`，`completeness` 为 `stopped`，恰好已写完时为 `complete`），同样只有 `complete` 且通过校验的才能作为候选；没有接入 C2 时走原取消，仍按上面"最终结果持久化前取消就没有可读正文"的契约。不新增保存片段的位置。
- 报告正文和来源只存在现有 Runtime result、receipt、artifact 版本里；实施时核对 #550 B2a/#598 的注销擦除覆盖这些位置，**不新增擦除范围外的正文存储**。

## 8. 暂停、续跑、取消、注销：只接 PAYG

| 情形 | PAYG 负责 | REPORT-GEN 负责 |
| --- | --- | --- |
| 开始前 A<L | 不发调用，持久化 waiting_credits 和下一请求 hash/游标；无未决在途时释放 active_execution | 报告保留"待生成"，显示 PAYG 的等待积分提示；充值后用户在原任务点继续 |
| 余额 ≥L 但 <G | 冻结 H=min(G,A) 正常开始；平台承担记 balance_cap | 无额外处理 |
| 时间不足 | 下一调用前落点 waiting_resume，不显示缺积分 | 单次全文只有一次调用，基本不触发；分章时在章间落点 |
| 续跑 | 原 execution＋expectedCursor＋epoch 比较交换；重过 calls 闸门，被拒保持等待；staging 续跑前重查窗口价格，涨价显示"价格配置待处理"；剩余调用数超过使用额度配置时给出可诊断状态 | 报告控制器只转调 PAYG 的继续入口，先查服务器状态，不信浏览器游标；双标签页只一个领取下一调用 |
| 费用未知 | 保留 hold，cost_pending，不发后续调用，只按原 ID 查账 | 显示"费用核对中"，不重发、不换模型 |
| 取消/放弃/超时 | 封闭未来调用，释放未派发 hold，已知调用结算，未知待核对；不新增 cron | 报告标记取消或未完成；只有已持久化的完整调用结果可读（第7节契约），中途流式片段不保存、不恢复；单次全文在最终结果持久化前取消或超时，就没有可读正文。报告如果走 #604 C2 的流式停止路径，按 #604 第 4.2 节保存停止时已显示的正文；能否作为候选按第7节的 `completeness` 和 13 部分校验决定：`length_limit`/`stopped` 截断的不作为候选，`complete` 且通过校验的照常可作候选 |
| 确认故障全退 | 来源感知补偿，只补已收 D，不退理论 Δ 或平台承担 e | 无 |
| 账号注销 | 按 #598 §3.3/§3.6 和 #553 第9节：关闭未来调用；只释放未派发或有可靠撤权证明的 hold；已派发未知的保留 hold 转 cost_pending；已结算前缀不变；零调用零 hold 直接结束，不制造退款；等待积分的 v2 run 直接收尾，不等充值 | 报告不再生成、不返回正文 |
| 资料变化 | 续跑前检查 Session revision 和本 execution 冻结输入 | 报告自己的 source_conflict：来源和确认版本与冻结快照不一致时，不覆盖新资料、不自动花钱重做，保留旧结果，要求用户基于新资料发起新操作 |

**断点**：报告只在 PAYG 的 run 断点列里加一个有界子对象：报告清单/模板身份、确认快照 hash、来源身份、已完成调用的结果引用（分章时为章节引用和统一提纲引用）。合计受 PAYG 的 65536 bytes 上限约束，不进入两份冻结 payload，不新增列。单次全文首版只有"尚未调用"和"已调用"两个位置，基本只需要 PAYG 本身的游标。

充值通过现有支付履约到账；支付 webhook 不持有生成权，不自动生成。长期等待不延长旧调用的 lookup 截止。

## 9. 分章备选（尚未授权）

**第八版**：分章原本是 D1 不批准时的退路；D1 作废、报告用全站统一上限后，不再是上限不足的默认退路。只有正式环境选定的统一上限下实测仍写不完或质量不达标时，才重新评估。

单次全文不达标时（时长、输出或质量），先核对原调用和账务、报总控。下一研究路线是"提纲＋有界并行分章"，再考虑跨请求串行；两者都未授权实施或真实调用。

- **收费**：提纲和每章都是同一 PAYG run 里的独立调用，各自计量、冻结、结算；A<L 时停在章间，已完成章不重做、不重复收费；**不把整组上限一次冻结**。并行时每个调用独立领取 hold；#553 第4节规定首版同 run 按 sequence 确认结算与继续权，"REPORT-GEN 并行本身仍未获准"。
- **输入契约**：提纲由本 run 第一次调用生成（maxOutputTokens ≤2048，序列化 ≤4096 bytes）；每章都拿完整事实快照和同一提纲，不累积前面章节的结论。v2 的"每章事实 32000 bytes、最坏 111872 bytes"预算覆盖不了本版 80 KiB 事实，分章前要按每章完整资源重新离线测量。
- **并行度**：A10 秒＋提纲 30 秒后 265 秒前剩 225 秒，k=4/7/13 分别需每波最慢 ≤56.25/112.5/225 秒；要另批实测供应商并发、限流、首字和内存后再选 k。串行 13 章约 26–40 分钟，需 Owner 知情，不默认成为产品体验。
- 报告输出按 13 个编号章节加"一句话结论"；模板建议字数合计 11850，写作目标约 11000，完整 Markdown 按 Unicode 码点保守计数 ≤12000，变现章至少 2000 字；用户事实、市场证据、行为假设分开；没有对标数据就标未获取，不编造。

旧 42 次/6.40 美元只作历史成本比较，不是 PAYG 的固定预留或授权。

## 10. 真实验证和额度

**当前 NOT_RUN。** 原授权：staging Hobby 单次全文最多 3 次、**供应商实际费用**累计不超过 0.50 美元；没有授权现在执行，也没有扩大到 PAYG 独立测试或分章。**第八版**：原授权按 O=24576 的测算申请；改用 staging 统一上限 O=8192 后，按 #604 第 8.1 节**不自动沿用**，按下表重新测算并重新申请（D2）。

**前提**：REPORT-GEN 实现合并；**PAYG 默认路径切换 PR 合并（含其前置的 PAYG 前端技术验收）**，这是真实样本唯一的放行条件，在此之前只做离线 fixture 和测试创建的 v2 run 集成验证；该模型已通过 #553 输入准入；staging 的 q、m、报告用途 L、测试窗口等配置由总控按证据经 Owner 批准后配置（报告用途 L 在三份样本前没有报告名义费用样本，按 #553 第2节不编造默认，实测窗口用的值由总控提出、Owner 批准；上线值等样本后按 P50 公式算）。

**额度怎么占（PAYG 第7节）**：每次 claim 在原窗口行锁内占用"所有窗口调用的已知实际费用 c ＋ 未决调用的 U ＋ 本次 U"，不能只算 H；一份结清后才跑下一份；不因换窗口重置次数。按 #553 第2节单价上限（Sonnet 输入取缓存写入价 2.5、输出 10；Gemini 0.75/3.75 美元/百万 token，均为总控给定价格，执行前按实时快照重算），O=8192（staging 统一上限）时：

| 最终请求 B | T | Sonnet 5.5 的 U（G，q=100、m=3） | Gemini 3.8 Flash 的 U（G） |
| ---: | ---: | ---: | ---: |
| 103730（只含资源） | 111922 | 0.361725（109） | 0.1146615（35） |
| 142942 | 151134 | 0.459755（138） | 0.1440705（44） |
| 174934 | 183126 | 0.539735（162） | 0.1680645（51） |
| 196608 | 204800 | 0.59392（179） | 0.18432（56） |

（正式环境 O=32768 候选时，后三档 Sonnet 为 0.705515/0.785495/0.83968（212/236/252），Gemini 为 0.2362305/0.2602245/0.27648（71/79/83），供 Pro 验证申请参考。原 O=24576 的数字已作废。）

结论：O=8192 时 Sonnet 单份 U 为 0.36–0.59 美元，B 较大时单份就超过 0.50，现有额度最多跑一份；Gemini 单份 U ≤0.18432，前两份可以跑，第三份要满足"前两份实际费用＋第三份 U ≤0.50"（前两份实际费用合计不超过 0.31568 即可），不满足就停下报总控，不加次数。所以实测用哪个模型、额度多少要重新申请（**D2**，实测前决定）。

三份样本：常规中文完整报告；接近事实上限、含长来源/中英/转义的完整快照；近 12000 码点长报告（含 ≥2000 字变现章和长运营章）。全部走同一上线候选的**流式**链路：真实准入 → 已发布资源 → Agent SDK → PAYG 逐次冻结和结算 → 原 receipt/报告读回。无搜索、无附属整理、不补样、未知即停。staging O=8192 下这三份（尤其第三份）可能以 `length_limit` 收尾：这时验证的是写满收尾、不作为候选、账务正确，**不算报告长度验收**；完整 12000 字的长度验收在正式环境选定 O 下进行（Pro 验证另行批准）。非流式、余额暂停、充值续跑、故障用离线 fixture 覆盖，不为 PAYG 单独发探针。

**每份记录**：候选/配置/profile 身份；输入各分量、B、T、O；U、G、A、L、H；q、m_i 及映射版本；首字/模型/端到端/保存时间；SSE 帧分布、总 wire、聚合和 receipt JSONB、内存峰值；输出长度和 13 章约束、`completeness`；读回 hash；回执的 P、completion_tokens、reasoning_tokens、cached_tokens、cache_write_tokens；**c、n、g、`nominalSource`**；W、N、Δ、D、e（e_cap/e_bound）、释放额；账本唯一记录。原始正文私有保留，公开只放脱敏结果。三份样本不证明 p95。

原公开价全 context 测算的 3 次 0.47136768 美元只是既有额度的历史依据，不是现在的执行上限；执行上限由 PAYG 对每份实际请求求出。正式运营 Pro 环境的三份验证仍需执行安排和额度批准（若仍按每组三次不超过 0.50 美元，Hobby＋Pro 累计最多 6 次/1.00 美元）。

## 11. 实施拆分和必测

**拆分（PAYG PR-B 和 #604 C0+C1 都合并后开工，按顺序）**：
- **R-A 报告输入容量（high）**：前提 #604 C0+C1 已合并（第八版：D1 作废，不再做用途级输出上限）。report 输入上限 196608、冻结读取按用途校验；输出上限、R(O)/F(O)、回执容量和超时由 C1 按环境统一推导，R-A 不改；交互完全不变。必须接好：
  1. **冻结用途输入校验**：`runtime/purposeBudgets.ts` 的 `frozenPurposeBudget.inputBytes` 现在硬限 112000，`runtime/execute.ts` 的冻结上下文 schema 用它校验；改为按冻结的 purpose 校验（report ≤196608，interactive/organize 保持原上限），没有新字段的旧冻结合同按原规则照旧通过，新旧执行的重读和恢复都不受影响。
  - 第七版的第 2 条"按用途返回和读取输出上限"及其"交付和回退""兜底""配置顺序（不在 staging 保存 report=24576）"**全部删除**：#604 第 3.2 节取消按用途的输出上限，后台只读显示全站上限，由 C1 实施。G1 讨论的投影兼容问题随之归 C1：C1 改 `readPurposeBudgetView` 和后台表单时，同样要求同一候选交付和回退，或只做向后兼容的新增（本方案只作提示）。
  - 模型能力上限仍来自 #597 的容量同步；实际 max_tokens 按 #604 第 3.1 节取最小值。
- **R-B 报告生成接线（high）**：report 节点声明和资源清单、确认快照组装（事实只在 instructions 一次）、输入预检、promptCache 明确排除、runner 不写 Session 内容的分支和宿主空批次完成凭据（第 7 节）、两处会员检查调用（第 2.4 节）、作为 PAYG v2 run 的一次调用接入、候选保存和重放（只认 `completeness:'complete'` 且通过 13 部分校验的结果为候选）、报告控制器 API（start/status/cancel/resume 转调 PAYG）、source_conflict 检查。入口保持关闭，直到 PAYG 默认路径切换，并且 PAYWALL 双层服务端会员检查已交付并通过验证。
- **R-C 前端（按分工另派）**：生成控制器界面，复用 PAYG 前端的等待积分、继续、费用核对中、价格配置待处理等提示组件；报告界面的计费说明写"按标价计费；有分时价的线路按最高时段标价计费"（#553 第3A节第8条），不写"按实际用量"；不做运行前费用预告；写满和停止的提示复用 #604 在正文外的通知位置和文案，不另做。
- AC-3 负责确认和定稿入口：现有 `artifact_action(confirm)` 全确认即确定性汇编正式报告的路径，由 AC-3 改为"先模型候选再确认"；Runtime result/receipt 是生成证据，artifact_versions 是正式报告权威，导出不再调模型；旧格式可读。
- 每个 PR 都能单独回退，不留半套路径。

**必测（离线，本机 Docker；PAYG 的通用财务矩阵在 #553 负责，报告做跨层集成）**：
- 通用 manifest：3/6/8 步；资源依赖、来源撤销；history=0 但权限完整。
- 事实只在 instructions 一次；`input`、`request.input`、`scopeMaterial`、`sources` 无事实副本；两份冻结 payload 262144/262145；最终请求 196608/196609；事实 81920/81921。
- 输出上限：报告调用使用该环境的全站统一上限，统一上限通过、上限 +1 拒绝（staging 8192/8193；正式环境用选定值）；报告不能请求比统一上限更大的 O；伪造 purpose/profile 拒绝；实际限额更小时取最小值；历史冻结合同可读但不能扩大新调用。
- 冻结输入：**196608 bytes 的报告新准入 → 冻结 → 重读/恢复**全程通过，196609 拒绝；interactive/organize 冻结读取仍按原上限；无新字段的旧冻结执行照旧可读和恢复。
- （第八版删除）第七版的"后台表单 report 可存 24576"和"过渡期旧表单读取投影"两条：按用途输出上限已取消，全站上限的显示和投影兼容由 #604 C1 的测试覆盖。
- 容量：按该环境 O 的 R(O)、F(O) 边界及 +1（staging 139264、16448；正式环境按选定 O，由 C1 推导，报告路径复用并覆盖）；单帧 65536/+1；wire 候选边界/+1；纯正文、纯思考、重复 reasoning_details、多字节/转义/高熵；#564 的压缩 hash/长度/UTF-8 和篡改拒绝保持。
- 截断（第八版按 #604 第 3.4、4.3 节）：有正文的 `length` 以 `length_limit` 收尾——保存已写正文、正文外提示已截断（实时结束和刷新后都显示）、**不作为报告候选**、费用照常按 PAYG 结算、不追加续写调用；正文为空的 `length` 和 `content_filter` 不冒充完整报告，也不作为候选；保存前截短后结果永不超过 262144。
- `completeness`：只有 `complete` 且通过 13 部分校验的结果成为候选；`length_limit`、`stopped` 可读不可确认；`stopped:true` 但 `complete` 时照常可作候选。
- 不写 Session 内容（第八版按 FULL-2）：不写任何内容条目——`runtime_session_history` 行数和 Session revision 不变，只有宿主记录的一条空批次；断线后已持久化的正文和账务可恢复。
- 空批次完成凭据的 SQL 集成测试（本机 Docker 实际调用 `runtime_execution`）：正常 `complete` 成功；回执已存但结果未存时崩溃，重放后用同一空批次完成，不发新请求、不重复消费；重复 `complete`（同一结果只读返回、不同结果冲突拒绝）；取消和完成竞争（只有一个生效，不出现两次收尾或两次扣费）；空批次重复记录按 0106 的同批次规则幂等。
- 报告付费墙（第 2.4 节）：免费用户积分充足也被拒（入口和调用准入两处分别覆盖，被拒时不建 run、不冻结、不派发）；有效订阅和一次性会员可以生成；只看页面投影、不在事务里检查的路径不存在；等待积分后续跑发起的新调用重新核对会员资格，到期则不派发、按 PAYG 释放未派发 hold、提示开通会员而不是充值；会员到期后旧报告和报告前已确认的资料仍可读取、可导出；真实注销和来源撤权照常让正文不可读。
- **报告专属的故障路径**（每项都核对：不重发、不重复收费、不把片段当完整报告、正文读取受撤权和注销限制）：
  - 派发前取消：不派发，hold 释放，没有正文；
  - 派发后中途取消或超时、没有最终正文：c 已知时按 PAYG 结算，c 未知时保留 hold 转 cost_pending；报告显示取消/未完成，没有可读正文，浏览器已显示的片段不被当作结果保存；
  - receipt 已存但 result 未存时崩溃：恢复入口从原 receipt 重放出结果，不发新请求、不产生重复消费（原调用仍按 PAYG 幂等结算）；receipt 显示截断时不作为报告候选；
  - 已知 c 和未知 c 两支分别覆盖；
  - 两个请求同时取消、同时续跑、一个取消一个续跑的竞争：按 PAYG 的 epoch 比较交换只有一个生效，不会出现两次派发或两次扣费。
- promptCache：报告请求在 `anthropic/` 模型上也不冻结 `promptCache`；不出现 `prompt-cache-v2`/`hostTurnContext`/`historySelection`。
- **PAYG 跨层集成**：报告 run 是 v2；n 的计算复用 #553 PR-A 的"思考单独标价"fixture（completion 含思考、R 单独计价，不重复计算思考 token）；A=L−1 不派发并进入 waiting_credits、A=L 和 A=L+1 派发；A≥L 但 A<G 正常封顶（不置 conflict）；充值后在原断点继续，同一调用不重复收费；双标签页只一个继续；续跑时闸门被拒保持等待；cost_pending 不重发；n 由 SQL 按冻结标价表计算、c 原样记账、`actual_fallback` 路径；n>U 或 P>T 按超界；报告用途 L 缺配置时拒绝并显示配置待处理；平台承担进入 #553 报表（按 report 用途汇总）。
- 注销：等待积分的报告 run 遇注销直接收尾；生成中注销后不返回正文；零调用零 hold 不制造退款。
- 资料：同会话有等待整理的 execution 时报告准入不放行；来源/确认版本变化触发 source_conflict，不覆盖新资料。
- 旧格式兼容：无声明的旧轮次和历史报告可读；旧冻结执行按原 profile 解码。
- SQL/内存：满额 receipt、result、两份冻结 payload 及 +1；高熵 gzip 负收益；记录峰值内存和持久化时长。
- 实际接线后：API/Web 单元和类型检查、lint、代码大小、ENGINEERING 第7节两条计费和恢复集成命令、空库建库、必需 CI/Security；入口开放前的浏览器验证按 AGENTS 和当前分工安排。
- 环境：staging 300/240/265/285 秒；Pro 另按部署验证。

## 12. 风险和回退

- staging Hobby 240 秒可能不够；不能把 staging 失败当作正式运营不可行。
- staging 8192 可能写不完整份报告（以 `length_limit` 收尾）；staging 只能验证链路、写满收尾和账务，完整长度要在正式环境选定 O 下验收。正式环境 O 如果因时长或费用定得低于 32768，报告也可能写不完，届时再评估分章（另批）。
- 首版一次调用写到一半超时不能无感完成（#604 第 3.3 节）：这次内容丢失，按超时和 `cost_pending` 处理。
- 192 KiB 覆盖不了所有合法大工作稿；统一上限 O 的接收公式由 #604 C1 验证。
- 报告单次冻结上限 G 远高于对话（Sonnet 最大输入时 staging O=8192 约 179 积分、正式环境 O=32768 约 252 积分），余额封顶时平台承担可能集中在报告上（实际承担取决于 n 和 H）；报告用途 L 必须单独按报告样本定，并靠 #553 的平台承担提醒观察。
- 会员检查如果只落在页面或读取投影上，免费用户可以绕过；所以两处都必须是服务端、且调用准入在事务里检查（第 2.4 节）。
- 等待期间资料、权益、价格可能变化；未知费用不能靠充值或 TTL 解除。
- 正式环境价格全自动，没有事先固定的美元损失上限（#553 第2节风险说明，Owner 已知）。
- 回退：先关闭新报告入口；保留原 profile 解码、候选读取、PAYG 的财务恢复/取消/暂停状态；不把已逐次扣费的 run 改回整份冻结；不删已完成内容或账务证据。

## 需要 Owner 决定

**D1（已作废，不需要 Owner 回答）：原"报告用途的单次输出上限提高到 24576"。**
- 按 Owner 2026-10-03 决定（[总控记录 5965354780](https://github.com/Crnobog9527/GraylumAI_vercel/pull/547#issuecomment-5965354780)），报告并入 #604 的全站统一单次上限：staging 8192，正式环境提高（32768 为首个候选，实施时定值）；首版不做自动续写，写满时以 `length_limit` 收尾并提示已截断。
- 第七版 D1 的说明、推荐和批准话不再使用。其中"提高上限本身不收钱、实扣按实际 token 和标价、G 变大不等于确定的平台成本"的口径对正式环境 O=32768 同样成立（#604 第 5 节）。

**D2（实测前才需要，不阻塞开工，现在可以不回答）：报告 staging 实测用哪个模型、额度多少。**
- 情况：原授权（3 次、供应商实际费用累计不超过 0.50 美元）是按旧的 24576 上限申请的，按 #604 不自动沿用，需要重新确认。staging 上限现在是 8192：Gemini 3.8 Flash 单份报告费用上限约 0.11–0.18 美元，最大输入时三份上限合计约 0.55 美元，超过 0.50 美元，所以不保证三份都能跑；Claude Sonnet 5.5 单份约 0.36–0.59 美元，资料多时一份就超过 0.50 美元。
- staging 8192 下报告可能写不满；写不满时验证的是"截断收尾、不当完整报告、扣费正确"，不算报告长度验收。
- **推荐：先用 Gemini 3.8 Flash 在 0.50 美元硬上限内测，最多 3 份**。第三份开跑前必须满足"前两份已知实际费用＋第三份费用上限 U ≤0.50 美元"，不满足就停下报总控，不补样、不自动加额度（第 10 节）。要用 Claude 写报告时，再追加 Claude 的额度。
- 批准话：「同意报告在 staging 按 8192 上限用 Gemini 3.8 Flash 实测，最多 3 份，供应商实际费用累计不超过 0.50 美元；第三份放不进这个额度就停，不补样、不加额度。」
- 如果要同时测 Claude：「同意报告 staging 实测另加 Claude Sonnet 5.5 三份，供应商实际费用累计不超过 1.80 美元。」

**D3（实测前才需要，不阻塞开工；推荐维持现状）：staging 测报告时，要不要临时把单次上限调高。**
- 情况：#604 定了 staging 保持 8192，同时说明 8192 可能写不完 12000 字的报告，这个问题由本方案提出。
- **推荐：不调高。** 理由：
  - staging 是 Hobby，单次供应商调用最长 240 秒。写完整份报告约需 12000–24000 输出 token，相当于每秒 55–109 token，多数情况写不完。调高上限只会把"写满后干净收尾、已写内容保留"变成"中途超时、这次内容丢失、费用待核对"，结果更差。
  - 临时调高要给 staging 加一个单独的上限值或开关；#604 定了上限放在按环境的代码常量里，不加运行开关。
  - staging 用 8192 验证链路、截断收尾和扣费；完整长度的验收放到正式环境（Pro）选定的上限下做，按第 10 节另行批准。
- 批准话：「同意 staging 测报告时单次上限保持 8192，不临时调高；完整报告长度在正式环境验收。」

## 相对 v4.2 的修订对照表

| v4.2 的说法 | 第五版 | 依据 |
| --- | --- | --- |
| "结束按官方费用加权累计结算""用户实扣按实际费用"；C=ceil(q×Σ(U_i×m_i))，U_i 为官方实际 USD | 收费基准改为名义费用 n_i：W=Σ(n_i×m_i)、N=ceil(q×W)、C+E=N；c_i（`usage.cost`）只用于对账、平台成本和测试额度 | #553 第3A节；Owner 5957160656 |
| "实际 U_i 取 OpenRouter 回执 `usage.cost`" | c_i=`usage.cost`；用户扣费不用它；缺 token 时按 min(c,U) 兜底并标 `actual_fallback`，c 也缺转 cost_pending | #553 第3A节第3条；Owner 5957737094 |
| 符号 U_i（实际）/Û_i（上限）/D+E=C | 统一为 #553 符号：U_i 上限、c_i 实际、n_i 名义、C 用户实扣、N 理论应计 | 总控 5929954633 的非阻塞提示 |
| 只写"超估算按#553处理" | 明确 n>U、c>U、P>T 为超界；余额封顶不置 budget_conflict | #553 第2、3A节 |
| 未提分时价、标价表 | 分时价取最高；n 由 SQL 按冻结的 `nominalPricing` 标价表计算，报告不实现 | #553 第3A节第1、2条 |
| 未提启动门槛的键 | 报告用 `billing_start_thresholds` 的精确模型＋`report` 键；缺配置拒绝并显示配置待处理 | #553 第2节 |
| 未提提醒 | 报告的平台承担和价格变动进入 #553 报表和两种提醒，报告不另做 | #553"管理员提醒" |
| PROMPT-CACHE"实施时按 #572 规则评估，现在不下结论"；以净增成本口径讨论用户收费 | 首版单次全文明确排除缓存标记（技术决定）；缓存只影响平台成本，不影响用户扣费；H1 的 v2 不适用报告 | #553 第3A节；#601 |
| 施工顺序 #497 → #550 → #565 → #572 → #553 → #547 | 新前置链：#594 →（#598 实施、H1、B1）→ PAYG PR-A → PR-B → REPORT-GEN；入口开放和真实样本等 PAYG 默认路径切换 | Owner 5957866853；总控 5958061928、5958482083 |
| 未写和 H1、B1、#598 的文件关系 | 新增第3.2节文件和写入顺序表；共享文件单一写入负责人 | #601 第5.3节；总控 5958482083 |
| report-full 24576 写成"技术选择" | 改为需 Owner 决定（D1）；补 PAYG 对报告输出 profile 的准入要求、T+O 和长上下文档位核对 | #553 第2节"交互及报告保持 Owner 已批准的 8192" |
| 报告输入上限 196608 | 保留，并注明它正好是 #553 验证矩阵最大档，不得超过 | #553 第2节 |
| 实测额度"每次 claim 按完整 Û 预留" | 按 PAYG 第7节：已知实际费用 c＋未决 U＋本次 U；补 Sonnet/Gemini 在 O=24576 时的 U/G 表；指出 Sonnet 单份就超 0.50 美元（D2） | #553 第2、7节 |
| 实测记录项"真实供应商成本 U_i、加权 W 与理论 C" | 改为记录 c、n、g、`nominalSource`、W、N、Δ、D、e_cap/e_bound | #553 第3A节 |
| "跨请求推进复用 PAYG checkpoint" | 明确报告只在 PAYG 断点列里放有界引用子对象，受 65536 bytes 约束，不新增列 | #553 第5节 |
| 注销收尾只写"PAYG 封闭未来 call……" | 按 #598 §3.3/§3.6 写清：只释放未派发或有可靠撤权证明的 hold，已派发未知转 cost_pending | #598 `001d8b44`；#553 第9节 |
| 无 | 新增：同会话有等待整理的 execution 时报告准入不放行（Q1=A 的一致处理）；报告计费说明用"按标价计费" | #553 Q1=A、第3A节第8条 |
| 无 | 新增：runner 已有 `readSessionHistory=false` 包装，报告只加不写 Session 的窄分支 | staging `runtime/runner.ts:89-97` |
| 无 | 新增：报告正文只存在现有位置，须在注销擦除范围内 | #550 B2a、#598 |
| 资源清单、事实容量、响应容量公式、Pro/Hobby 时限、分章备选、三份样本类型 | 内容保留，文字压缩；未重测 | v4.1/v4.2 |
| 2026-10-02 修订记录 | 已并入本版正文，不再单列 | — |

## 第六版修订（相对第五版）

依据：[完整审查 5959181491](https://github.com/Crnobog9527/GraylumAI_vercel/pull/547#issuecomment-5959181491)（第五版 46,968 字节、SHA-256 `5b2ec756…`，P0/P1 为 0，P2 为 5）和[总控记录 5961420581](https://github.com/Crnobog9527/GraylumAI_vercel/pull/547#issuecomment-5961420581)（F2 是对 Owner 的说明，须在交给 Owner 前改准；F1、F3、F4、F5 是方案内部技术修订）。除下表各处外，正文未改。

| 发现 | 改了哪里 |
| --- | --- |
| F1 名义费用简写可能重复计算思考 token | 第2.2节"调用后"改为直接引用 #553 第3A节第1条公式 `n = [P×输入标价 + (completion_tokens−R)×输出标价 + R×思考标价]/10⁶ + 请求标价`，写明 completion_tokens 已含思考；第11节跨层集成必测复用 #553 PR-A 的"思考单独标价"fixture |
| F2 D1 的说明过满 | "需要 Owner 决定"D1 改为：提高上限本身不收钱，条件相同时金额不变；但模型可能思考和写得更多，实扣可能变多（附算例 3→6 积分）；179→228、56→74 是冻结上限 G 的变化，实际冻结看余额，平台承担取决于实际 n 和 H，不是确定的增量。推荐和批准话不变。第12节风险措辞同步 |
| F3 真实样本有替代放行条件 | 第10节删掉"或总控确认 staging 上报告走 v2 的路径已就绪"；真实样本唯一前提是 PAYG 默认路径切换 PR 合并（含前端技术验收），之前只做离线 fixture 和测试创建的 v2 集成验证 |
| F4 R-A 缺两条接线 | 第4节点明两处；第6节边界表补冻结读取；第11节 R-A 列出：①`frozenPurposeBudget.inputBytes`（112000，`execute.ts` 冻结 schema 使用）按用途校验、旧合同兼容；②`readPurposeBudgetView` 按用途返回输出上限、`mentorBudgetDraft.ts` 的 `fieldRange` 按用途读取；负责人和顺序（后端先、前端表单紧随，表单就绪前不在 staging 保存 24576）；模型能力仍来自 #597 容量同步。补必测"196608 报告新准入→冻结→重读/恢复""后台 report 可存 24576、interactive 仍拒 8193" |
| F5 "部分内容可读"缺契约 | 第7节新增首版契约：只有已持久化的完整调用结果可读，不保存、不恢复中途流式片段；receipt 已存 result 未存时用原 receipt 重放、不再收费；截断结果不作候选。第8节取消行改写。第11节补报告专属故障必测：派发前取消；中途取消/超时无最终正文；receipt 已存 result 未存时崩溃；已知 c 与未知 c；双请求取消/续跑竞争 |

## 第七版修订（相对第六版）

依据：[复核 5964786138](https://github.com/Crnobog9527/GraylumAI_vercel/pull/547#issuecomment-5964786138)（第六版 55,577 字节、SHA-256 `caa78976…`；F1、F2、F3、F5 关闭，F4 剩 G1 一项 P2）和[总控记录 5964792671](https://github.com/Crnobog9527/GraylumAI_vercel/pull/547#issuecomment-5964792671)（同范围技术修订，不需要 Owner 选择）。除下表各处外，正文未改；第六版完整原文附在本次"可以审查"评论的折叠块里，便于逐字比对。

| 来源 | 改了哪里 |
| --- | --- |
| G1 后端先改返回类型、前端下一 PR 跟进会留下不兼容的中间版本 | 第11节 R-A 第2条下的"负责人和顺序"改为"交付和回退"：服务端按用途输出上限和全部消费方（`fieldRange`、`BudgetView` 类型、后台表单、相关测试）同一候选交付和回退，删掉"紧随的小 PR"选项；新增兜底规则（必须拆分时只新增按用途字段、保留旧数值字段，前端切换后再处理旧字段）；"表单就绪前不在 staging 保存 24576"作为配置顺序保留；"每个 PR 都能单独回退"一条同步；必测新增"过渡期旧表单读取投影仍然正常" |
| 复核澄清：平台承担的口径 | D1 说明里"平台承担取决于实际费用"改为"取决于实际的名义收费基准 n（不是供应商实际费用 c）和实际冻结额" |
| 复核澄清："不再收费"的含义 | 第7节契约和第11节故障必测里 receipt 重放的"不再收费/不再扣费"改为"不产生重复消费，原调用仍按 PAYG 幂等结算" |

## 第八版修订（相对第七版）

依据：已合并的 [#604 对话原生体验方案](https://github.com/Crnobog9527/GraylumAI_vercel/pull/604)（staging `95ecefd7`，`docs/launch/CHAT_NATIVE_OUTPUT_PLAN.md` 第 3、4、8.1 节）、[总控记录 5965354780](https://github.com/Crnobog9527/GraylumAI_vercel/pull/547#issuecomment-5965354780)（第 4、6、11 节和 D1 要同步）、#604 的 Owner 决定 [5969177321](https://github.com/Crnobog9527/GraylumAI_vercel/pull/604#issuecomment-5969177321)、[5970578413](https://github.com/Crnobog9527/GraylumAI_vercel/pull/604#issuecomment-5970578413)、[5971006438](https://github.com/Crnobog9527/GraylumAI_vercel/pull/604#issuecomment-5971006438)。底稿是远端第七版描述（59,184 字节、SHA-256 `dc33dc10…`）。计费引用 PAYG（第 2 节）、资源和事实容量（第 5 节）、无 Session 调用、PAYG 暂停续跑注销、故障必测的原有内容不变。除下表各处外，正文未改。

| 来源 | 改了哪里 |
| --- | --- |
| 第七版复核 P3 | 开头版本标签改为"第八版"，补第八版依据 |
| #604 第 8.1 节 D1 | 0.1 加 Owner 决定；0.3 和文末 D1 标为作废，不再请 Owner 批准 |
| #604 第 3.1、3.2、3.3 节 | 第 4 节重写：报告用全站统一单次上限（staging 8192，正式环境 32768 为首个候选）；删除 report-full 24576 和按用途输出上限；只保留输入侧；时长引用 #604 第 3.3 节，写明首版中途超时不能无感完成；Pro 超时按环境由 C1 推导 |
| #604 第 3.4 节、第 13 节 | "截断不算成功、不自动续写、只能改走分章"改为"写满以 `length_limit` 收尾、正文外提示已截断、不作为完整候选；首版没有续写，续写是 #604 第二版"（第 4、7、11、12 节） |
| #604 第 3.1 节 R(O)/F(O)、第 4.3 节 | 第 6 节：表格改为 staging 8192 和正式环境 32768 候选两行，删除 24576 行；聚合、wire、回执、结果容量改为按该环境 O 由 C1 推导；回执不另提报告专用 SQL 边界；结果保存前按实际字节截短 |
| #604 第 7.1、7.2 节 | 第 3 节：开工前置增加"#604 C0+C1 合并"；文件表加 C0+C1 一行，REPORT-GEN 不再改输出容量文件、不再有回执 CHECK 迁移；注明 #594、H1、B1 已合并，#604 的三项实施前事项以对应实施 PR 为准 |
| #604 第 8.1 节 §7、§8 | 第 7 节契约补 `completeness`：只有 `complete` 且通过 13 部分校验才是候选；接入 #604 C2 停止路径时按其第 4.2 节保存停止前已显示的正文，能否作为候选按 `completeness` 和 13 部分校验决定（`length_limit`/`stopped` 截断的不作为候选，`complete` 且通过校验的照常可作候选）；第 8 节取消行同步 |
| #604 第 8.1 节 §9 | 第 9 节注明分章不再是上限不足的默认退路 |
| #604 第 8.1 节 D2 | 第 10 节：原额度不自动沿用；U/G 表改为 O=8192，附正式环境 O=32768 参考值；三份样本在 staging 可能以 `length_limit` 收尾，不算长度验收；记录项加 `completeness`。D2 重写并给出新批准话 |
| #604 第 8.1 节 staging 报告上限 | 新增 D3：staging 测报告是否临时调高单次上限，推荐不调高 |
| #604 第 8.1 节 §11 | R-A 改为"报告输入容量"，前提改为 C0+C1 合并，删除按用途输出上限、G1 的交付/兜底/配置顺序（投影兼容归 C1）；R-B 加候选只认 `complete`；必测"24576/24577"改为"统一上限通过、上限 +1 拒绝"，删除两条按用途表单必测，容量必测改为按 O，截断必测改为 `length_limit` 收尾不作为候选，新增 `completeness` 必测 |
| #604 第 3.4 节提示位置 | 第 11 节 R-C：写满和停止提示复用 #604 的正文外通知；拆分开工条件加 C0+C1 |
| 第八版复核 5971182178 V8-1（P2） | D2：删掉"三份能跑完"，保留 0.50 美元硬上限，改为最多 3 份、第三份放不进额度就停、不补样不加额度，批准话同步 |
| 第八版复核 5971182178 V8-2（P3） | 第 8 节取消行和本表 §7、§8 行：停止结果能否作为候选统一按第 7 节的 `completeness` 和 13 部分校验决定 |
| 全文复核 5971718212 FULL-1（P2） | 0.1 加报告付费墙决定；第 1 节加 PAYWALL 与 REPORT-GEN 的分工；新增第 2.4 节（两处服务端会员检查、事务内检查、复用现有会员权威、一次性会员、到期后旧报告可读可导出）；第 3 节入口开放前提加"双层服务端会员检查交付并验证"；R-B 和必测、第 12 节风险同步 |
| 全文复核 5971718212 FULL-2（P2） | 第 7 节：复用 0106 合法空批次作为完成凭据，SDK 用真实的不持久化方式；验收改为"不写任何内容条目"；第 3.2 节、R-B 同步；补空批次 SQL 集成必测（正常完成、崩溃重放、重复完成、取消竞争） |
| 全文复核 5971718212 FULL-3（P3） | 第 2.2 节：报表维度和两种提醒分开写，提醒沿用 #553 各自规则 |
| 全文复核 5971718212 FULL-4（P3） | 第 2.2 节：启动门槛键改为 0162 实际读取的 `billing_payg_start_thresholds`，引用 PR-A 合同 |
| #604 第 8.1 节 §12 | 第 12 节风险：删除"D1 不批准"，加 staging 可能写不完、首版中途超时、G 的数字改为 179/252 |

## Handoff

**已做**：第五版按 #553 第七版重写；第六版按完整审查 5959181491 修订 F1–F5；第七版按复核 5964786138 修订 G1（复核 5964875307 干净，剩 P3）。第八版：按已合并的 #604 做小同步（见上表），顺手修复 P3；分支在原空提交 `8fb950af` 上合并 staging `95ecefd7`，新 head `b9e31c0a`，与 staging 零文件差异。

第八版复核 5971182178（P0/P1 为 0）的 V8-1、V8-2 已在同版内修正，head 不变。全文复核 5971718212（P0/P1 为 0）的 FULL-1–FULL-4 也已在同版内修正（见上表），head 仍不变。PAYG PR-A #617 已合并（staging `da0a89a5`），启动门槛等引用按其实际合同（0162）；全文复核的源码依赖覆盖截止 staging `5c56fa4b`。

**下一步**：可以审查（覆盖当前全文；base 已从 `34017395` 变为 `95ecefd7`）。保持 draft；复核由总控安排。D2、D3 实测前再交 Owner，不阻塞开工。

**阻塞**：开工要等 PAYG PR-B 和 #604 C0+C1 都合并；真实样本等 PAYG 默认路径切换 PR 合并，以及 D2（和 D3）的 Owner 决定；用户入口开放还要等 PAYWALL 双层服务端会员检查交付并验证。

**实际做过的核对**（只读）：
- 第五版：`gh` 核对 staging `34017395`、#547 head `8fb950af`（draft、零文件差异）；#553 描述 142,946 字节、SHA-256 与 `e431af20…` 一致及复核 5958005853、定稿 5958061928；#598 决定 5957866853 和 `001d8b44` 方案中的分工段；#601 方案和决定 5958482083；#593/#594/#590 文件清单；全部 open PR；本地源码 `responseCapacity.ts`、`openRouterStream.ts`、`purposeBudgets.ts`、`runner.ts:80-100`；python 复算 U/G 表。
- 第六版：读完整审查 5959181491 和总控记录 5961420581；修订前确认远端描述仍是第五版（SHA-256 `5b2ec756…`）；本地源码核对 `purposeBudgets.ts:30-49`（`frozenPurposeBudget.inputBytes` 112000、`readPurposeBudgetView` 共用 `maxOutputTokens`）、`execute.ts:16,35`（冻结 schema 引用）、`routers/mentorBudget.ts`、`apps/web/src/components/admin/mentorBudgetDraft.ts` 的 `fieldRange`；复算 F2 算例（n 0.00843→0.01995 美元，3→6 积分）。
- 第七版：读复核 5964786138 和总控记录 5964792671；修订前用 API 确认远端描述仍是第六版（55,577 字节、SHA-256 `caa78976…`），并以这份原文为底稿修改；核对 `mentorBudgetDraft.ts` 的 `fieldRange` 返回 `[number, number]` 且直接读取 `view.limits.maxOutputTokens`。
- 第八版：读复核 5964875307、总控记录 5965215097 和 5965354780；读 staging `95ecefd7` 上 `docs/launch/CHAT_NATIVE_OUTPUT_PLAN.md` 全文和 #604 的总控记录（5969177321、5970578413、5971006438、5971020867）；修订前确认远端描述仍是第七版；确认 `responseCapacity.ts` 在 `95ecefd7` 仍是 `PURPOSE_OUTPUT_CAP=8192`；python 复算 O=8192 和 O=32768 的 U/G 表；按全文复核读 staging `5c56fa4b` 上的 MASTER_PLAN 第 50 项、0106:294-306 和 449-466（确认空数组 append 只建批次、不写历史、不增 revision）、0162:299-304（`billing_payg_start_thresholds`）、`membershipEntitlements.ts`（投影不是准入凭证）、#553"管理员提醒"一节；列出 open PR（#617、#621、#553、#547），本分支没有其他写入方。
- **没有**：运行测试、访问数据库、调用模型或付费接口、改配置、改分支文件内容（只有合并 staging 的提交）。


🤖 Generated with [Claude Code](https://claude.com/claude-code)
