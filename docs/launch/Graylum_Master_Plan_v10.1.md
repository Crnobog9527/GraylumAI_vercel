# Graylum Launch 产品规格（v10.1 + 已批准 V3.1 扩展）

本文保留 v10.1 历史产品决策与任务交付；本批仅同步 Owner 批准的 V3 产品范围及 V3.1 最小加载交付。执行遵循 current staging `AGENTS.md`，本文不授予合并、数据库、配置、收费调用或生产操作权限。旧流程用语仅作历史，不恢复 Gate 或台账。

2026-09-07 产品修订：Owner 批准“通用 Skill 基座＋配置驱动多步骤工作台”，补充 D7、§7 及[V3 详细规格](tasks/V3-standard-skills.md#generic-skill-workbench)。社媒六步保留为首个业务模板；本次仅补规格，功能与新增验收尚待实现/运行，不启动后续任务。以下带日期阶段及其 NOT_RUN 是历史记录，不据此改写当前验证结论或宣布研究/V3/M3完成。

## 当前仓库事实与本批边界（2026-09-06 核验）

GitHub live 仓库 `Crnobog9527/GraylumAI_vercel`，本批起点 staging 为 `283686d00733d69147c89f8ac5f552e4b380074b`。以下仅证明代码/文档已合并，不等于远端 schema、权限、模型效果、付款验收或 M3 已通过：

| 历史交付 | GitHub 合并证据 |
| --- | --- |
| SKILL-1A 发布契约 | [#364](https://github.com/Crnobog9527/GraylumAI_vercel/pull/364) |
| SKILL-1B 管理端及当前正文 runtime | [#366](https://github.com/Crnobog9527/GraylumAI_vercel/pull/366) |
| BILL-1 对账 | [#365](https://github.com/Crnobog9527/GraylumAI_vercel/pull/365) |
| PAY-1 付费与升级 | [#367](https://github.com/Crnobog9527/GraylumAI_vercel/pull/367) |
| CI-1 精选回归与 db:push 防护 | [#372](https://github.com/Crnobog9527/GraylumAI_vercel/pull/372) |
| M3 付费矩阵文字修正 | [#375](https://github.com/Crnobog9527/GraylumAI_vercel/pull/375) |

Owner 本窗口仅选择 **V3.1 规格同步与标准 Skill 最小真实加载**。第一批交付、后续依赖和验收见 [V3 技术规格](tasks/V3-standard-skills.md) 与 [依赖结构](plan-core.md)。本批不切换聊天运行路径，不代表 V3 完成；不接手旧 M3 支付验收、不启动 REL-1。远端数据库、模型、AgentKey、计费与完整 M3 在本批均为 **NOT_RUN**。

以下 2026-08-14 至 08-16 的代码、环境、进度、日期承诺和“下一任务”快照均为历史，不能作为当前状态；仍有效的产品决策、验收与出口保留，D7 及直接相关 Skill/M3 要求由本批显式扩展。进度须以每次 GitHub live 及获准的运行证据重新核实。

# Graylum 公开付费 MVP — Master Plan v10.1（执行进度刷新版）

> 下列 YAML 为 2026-08-16 历史快照，不是当前执行状态。

```yaml
version: v10.1
date: 2026-08-16
supersedes: v10（仅刷新执行进度与 live 状态；D1–D12、任务设计与审计结论不重开）
change_driver: 交叉审计六轮 23+10+8+5+5+1=52 条，均经独立核验全部成立、0 误报；第 6 轮仅 1 条 P1、无 P0，审计双方确认收敛（见 §21）→ 本版为执行定稿
audit_status: CONVERGED（趋势 23→10→8→5→5→1，无 P0）
evidence_base:
  repo_audit: origin/staging @ b148803（Graylum_MasterPlan_FINAL_R2_独立代码审计报告）
  ext0: 2026-08-14 生产/staging 只读体检（Graylum_EXT-0_外部环境体检报告）
roles:
  owner: 单人 Owner，不读代码；只做 5 类 gate（§3）
  coding_agent: 编码代理，按 AGENTS.md session authorization 执行任务卡
  planner_auditor: 本文件作者，规划与审计，不写代码/不建分支/不发 PR
target: 30 天冲刺目标 / 45 天有余量承诺；deadline 永不覆盖 Go/No-Go
lanes: 最多 2 条实现 lane
credit_accounting: B 方案（周期消耗计数器）；不建 credit_lots
status: EXECUTION_IN_PROGRESS（R0-A / GOV-1 / R0-B 已完成；下一计划任务 = STG-FIX，尚未获得该任务独立执行授权）
change_driver_v10: 第6轮交叉审计 1 条 P1（AUTH-1 漏 SecuritySettingsCard captcha 入口，已核实并改为 grep 全覆盖，见 §21）；F3 计数器模型深水问题经穷举四类确认自洽、未突破 D1
progress_refresh_v10_1:
  refreshed_at: 2026-08-16
  repository: Crnobog9527/GraylumAI_vercel
  repository_id: 1133708061
  current_main: ecf4c6a347038f9352477a98d4171a8ef00c85de
  current_staging: c39311bca4ab44769d5cd2cf3d0e3f8046fb0938
  current_main_staging_tree: f1a6bb44d456666984e7295328843283413afeaa
  current_compare: ahead=1 / behind=0 / changed_files=0（history-only sync）
  completed:
    - R0-A（PR #309 merged）
    - GOV-1（PR #310 merged）
    - R0-B（Issue #311 closed/completed；PR #312 merged；PR #313 merged）
  next_planned_task: STG-FIX
  next_task_authorized: false
  separate_bug_backlog:
    - ADMIN_MODEL_API_KEY_SAVE_FAILURE
```

> **本文件不是执行授权。** 每个任务开工前，编码代理必须 fresh-read GitHub live state 并取得 Owner 按 §12 模板给出的本任务授权。合并、直接 push main/staging、Supabase/Stripe/Vercel/生产/环境变量/真实支付退款，一律不由本文件授权。

---

## 0. 决策记录（已锁死；重开须附 file:line 或可复现证据）

| # | 决策 | 内容 |
|---|------|------|
| D1 | 记账机制 | **周期消耗计数器**：`subscription_credit_grants.consumed_amount`；消费"当期优先、封顶为当期发放额"；退款扣回=`credits_granted − consumed_amount`（余额≥0 保护）。不建 credit_lots、不做 legacy 切换。 |
| D2 | 时间 | 30 天=内部冲刺目标；45 天=对外承诺口径。 |
| D3 | 流程 | ≤2 lane；Owner 只做 5 类 gate（§3）；高风险任务的 Evaluator/Release Auditor PASS **以机器证据+结构化结论达成**，不写自由散文报告。 |
| **D10** | 治理一致性 | **✅ 已完成（PR #310 merged）。** 当前 live `AGENTS.md` 已将 High-Risk Gate 收敛到 canonical Sprint Contract + Evaluator / Release Auditor 结构化三态 `PASS | FAIL | BLOCKED`，且**只有 PASS 满足 gate**；同时明确纯只读代码/文档评审不因缺少 Task Issue/gate 被拒绝。D3 已生效。<br>历史约束仍保留为执行留痕：R0-B / REL-1 属 production release，高风险 gate 必须按当前 live `AGENTS.md` 执行；R0-B 已于 2026-08-16 完成并 closeout。 |
| D4 | 退款 | 任何 Owner 批准的订阅退款（partial/full 事件同语义）＝整份订阅立即终止：Stripe 端 Owner 立即取消+退款 → 本地先写 release termination → 只扣当前退款周期尚未使用的订阅积分 → 历史周期不追回 → 开户/签到/管理员/其他订阅/未退款积分包不动 → 年付未来释放全部停止。系统不自算现金金额、无自助退款。 |
| D5 | 正常取消 | Stripe Customer Portal `cancel_at_period_end=true`；已付周期权益继续；年付剩余月度按周年继续释放到 Stripe period end。正常取消≠退款。 |
| D6 | 年付释放 | 12 期；第 1 期在首张年付发票支付后立即发放；anchor=原始 Stripe term start；UTC 日历月周年；月末保留原日、超出 clamp 到月末；每期从原始 anchor 计算；**禁止毫秒÷12**。示例：01-31 → 01-31 / 02-28(29) / 03-31 / 04-30。 |
| D7 | Skill（V3 已批准扩展） | 建设**共享 Skill 基座与配置驱动多步骤工作台**，社媒六步是首个模板而非平台固定结构；在已支持能力范围内，仅改变步骤数、业务名称、问题或报告章节应通过方法包与校验后的流程配置接入，不改核心页面、存储结构、保存/确认接口或报告代码；新增能力通过受控可复用模块扩展，不复制系统。服务端与界面共用该轮固定定义，配置不是任意代码。详细边界及[通用验收](tasks/V3-standard-skills.md#generic-skill-workbench)适用于后续既有任务，尚非实现证明。保留 `skills`、不可变 revision 与模块绑定基础，扩展为**私有标准目录包、完整入口和按需资源真实读取**；六步成果、用户确认快照、策略历史及确定性报告按 [V3 规格](tasks/V3-standard-skills.md) 交付，Skill 外部研究统一走受控服务端数据适配层（首选 AgentKey MCP）。不执行任意脚本、沙箱或无限工具循环。active 模块必须绑定有效 published 且可执行的 Skill；缺失、归档、撤销、无权限或读取失败均拒绝执行，不调用 provider/收费取数、不预扣，不回退 description。**普通聊天**下个请求读取当前发布版本；**工作台**固定该轮方法版本，升级须明确确认；固定旧版不绕过实时模块/Skill/版本/权限检查。历史成果读取与私有方法可执行性分开。 |
| D8 | 首发商品 | Pro/Gold 月付+年付 + ≥1 个正金额积分包；零金额/未配置不得 checkout-ready（#276）；首发恢复 Billing Engine v1.5 仅升级路径（Pro→Gold、月付→年付）；禁止降级/同级同周期重复；到期取消须先恢复续费。 |
| **D11** | 大陆支付（2026-08-15） | **大陆是核心付费盘。** Owner 实测确认两条已跑通：① **会员订阅**=卡支付（Visa/Master，含大陆发行的双币卡）可成功续费 ✓ —— 大陆会员的**主路径**；② **积分包**=支付宝+卡，一次性收款成功 ✓。<br>**支付宝续费订阅**（Stripe Checkout subscription 模式**不支持** alipay、recurring alipay 仅 private preview，[文档](https://docs.stripe.com/payments/alipay)）降级为**可选增强、且非"置开关即得"**：Owner 可并行向 Stripe 申请 recurring preview，但**审批通过只是前提，续费机制仍需单独实现任务**（保存方式+off-session），非本次范围（详见 PAY-1 第 3 条）。`alipay_subscription_enabled` 上线保持 false；**不批、批了但未实现，均不影响上线**（卡订阅已覆盖会员）。<br>**已删除**：原"一次性会员资格包"保底路径——卡订阅实测可用后不再需要，PAY-1 相应减负、**取消其迁移槽**。<br>**边界说明**（备查，非任务）：仅持银联单币卡且不用支付宝的用户无法购买会员，但可用支付宝购买积分包；无人被完全挡在付费之外。 |
| **D12** | 人机验证架构（2026-08-15） | **全体统一用 Supabase 原生 hCaptcha**，弃用"应用层地域分流（极验/阿里云）"。**根因**：注册/登录是浏览器用公开 anon key **直连 Supabase**（`login/page.tsx:128/181/222` 实测），不经 Graylum 服务端 → 应用层 CAPTCHA 无法卡住注册端点（第 4 轮 F2）；而 Supabase 原生 CAPTCHA **只支持 hCaptcha/Turnstile**（官方文档），选 hCaptcha（大陆可用的 reCAPTCHA 替代）。覆盖：邮箱注册、密码登录、**未来手机 OTP**（同为客户端直连，原生 hCaptcha 一并覆盖）。**OAuth（Google）不走 hCaptcha**（重定向流不接受 captchaToken），依赖 Google 自身机器人防护——AUTH-1 不得强行给 OAuth 加 captcha 否则会打断。<br>**时序纪律（F7 复活）**：开启 Supabase 原生 CAPTCHA 后，客户端必须传 `captchaToken`，否则登录全断 → 后台开关必须与 AUTH-1 前端接入**同环境配对**开启（见 AUTH-1、§9）。 |
| D9 | 生产 8 个旧模块 | **全部停用。** 它们是生产库 `modules` 表的 8 条真实数据行（2026-01-20 创建、带历史 usage_count、全部无 system_prompt/prompt_content），非硬编码。停用=生产库数据操作（§9 gate 内执行，复验须按 id 逐行确认，见 §4-C）。上线所需 active 模块由 SKILL-1B 新建并在生产库创建绑定（§9）。 |

---

## 1. 唯一上线价值闭环（任务准入标准）

注册（**邮箱注册 + Google OAuth 两条路径**）→ 邮箱验证/OAuth 身份 → 恰好一次开户 100 积分 → 看到正确可购买的月付/年付/积分包 → Stripe Checkout 成功 → 订单正确落库 → 积分只到账一次 → 进入 Owner 批准的 published-Skill 模块 → AI 消费按"当期优先"计数 → 余额/账本/计数一致 → 可正常 cancel-at-period-end → Owner 可立即取消并退款 → 只扣当期未用订阅积分、其他来源不动 → 年付未来释放停止 → 对账/告警/回滚可用。

**不能直接保护或打通这条链的工作，不进 30 天关键路径。**

---

## 2. 历史事实地基（2026-08-14 快照；不得当作当前缺陷清单）

**代码事实**（origin/staging b148803）：
- Billing v1.5 主体已存在且已上生产 → **只增量修，禁止重建**。
- 年付日期=毫秒÷12（`subscriptionCreditGrants.ts:361`）；金额拆分正确（`:324-339`）。
- 退款：full 扣回=min(发票发放总额, 当前总余额)（`:1711-1714`）误扣其他来源；partial 只标 review（`:1552`）；`shouldReleaseAnnualSubscriptionCredits` 到期分支死逻辑（`:409-415`）。
- **结算超用行为**：`0023_ai_settle_pricing_metadata.sql:98,105` — `v_difference := v_pre_deducted - p_total_credits`，`actual > reserved` 时**直接从总余额扣差额、不分来源** → REFUND-1B 必须处理该竞态（§4）。
- `ensureProfile` 先于邮箱验证（`trpc.ts:443→445`）；service-role`||`anon 降级（`trpc.ts:50`）；`profiles.credits` 默认 100（`schema.ts:13`，应为 0）。
- `isEmailVerified()`（`lib/auth.ts`）对 Google provider 直接返回 true → **AUTH-1 调整验证顺序时必须保证 OAuth 注册仍能开户且只发一次**。
- `chatRuntime.ts:121-124` 静默回退 description；`settings.ts:276` checkout_ready 不校验金额>0（#276）。
- vercel.json 4 cron；`/api/cron/billing-reconcile` 存在未注册；`cron-auth.ts` 在 CRON_SECRET 缺失时生产返回 503。
- CI 只跑 API tests；13 个 Playwright spec 未进 CI；`db:push` 脚本裸露。
- 迁移曾有 0018 编号冲突先例。

**EXT-0 事实**（2026-08-14 实测）：
- 🔴 生产库 **21 个 SECURITY DEFINER 函数对 anon、22 个对 authenticated 可执行**（含 atomic_refund/pre_deduct/settle/finalize*/abort_settle/deduct_credits_atomic/get_user_credits/purge_deleted_records），且不校验 `auth.uid()`。唯一锁对的是 `atomic_apply_credit_ledger_entry`。
  **根因说明（重要更正）**：生产迁移账本**完整应用到 0047**，0027–0034 加固**确曾应用**。现状偏离的推定机制是：后续迁移以 `CREATE OR REPLACE` 改变函数签名，新签名默认回到 PUBLIC EXECUTE。**该机制为推断、尚未验证**，SEC-1 必须先确认根因，否则修复可能被同样方式再次抹掉。
- 生产数据量级：5 profiles / 465 账本行 / 43 订单(10 completed) / 3 订阅(0 active) / 2376 积分。
- 生产 `modules`=8 全 active 全空 prompt（→D9）；**staging 库缺 `claim_daily_checkin` 函数、`application_logs` 与 `diagnostic_results` 表**（→STG-FIX）。
- 计费类 Vercel cron 在生产**零执行记录**；Vercel、Supabase 均免费版；泄露密码保护关闭；SMTP 高度疑似默认。
- Stripe live 已完成商业验证可收款；域名 graylum.com/app/www 绑生产项目；Node 24.x 两端一致。
- **生产与 staging 是两个独立数据库**（fhmshnqjjnnlvplojktv / gvcpmcunmfrbxuwimxfa）：staging 建的任何数据不会出现在生产。

---

## 3. 角色与门禁模型

**Owner 的 5 类 gate（不需要读代码）：**
1. **合并 PR** — 看两样：该 PR 的 CI 全绿？任务卡验收命令的绿灯证据在 PR 描述里？（钱路 PR 另加：云端评审无未处理 P0。）
2. **staging→main promotion** — 额外看 §4 REL 任务卡要求的 6 项证据（AGENTS.md §Required Validation Before Main）。
3. **Stripe live** — 真实商品/价格/退款/取消只由 Owner 在 Dashboard 操作。
4. **生产 DB/env/数据** — 迁移应用、grants、环境变量、D9 停用、生产 Skill 与模块创建，只由 Owner 在 gate 内执行；每步后跑任务卡给的复验命令。
5. **产品验收** — Skill 内容、定价文案、条款。

**Evaluator / Release Auditor PASS 的达成方式（D10 已生效）**：机器证据（CI 状态 + 任务卡 `required_validation` 输出）+ canonical 结构化结论 `PASS | FAIL | BLOCKED`（含 scope / forbidden-action 检查）；**只有 PASS 满足对应 High-Risk Gate**。自由散文可选，不能替代机器证据或结构化结论。
**审计收敛规则**：本计划生效后，"审计意见"唯一合法形式=让一条验收失败，或给出 file:line/可复现命令；否则记 backlog 不阻塞。

---

## 4. 任务卡

### 全局条款（适用于所有任务卡，构成 sprint contract 的一部分，无需逐卡重复）

**全局禁止动作**：合并任何 PR；直接 push `main`/`staging`；任何数据库/Stripe/Vercel/生产/环境变量操作；修改 §0 决策；自行扩大 allowed_paths；编辑已应用的迁移；执行 `db:push`。

**全局停止条件**（命中任一即停止并上报，不得自行绕过）：
1. 需要修改 allowed_paths 之外的文件才能完成任务；
2. 迁移编号冲突、`schema.ts` 冲突、或分配的 SLOT 已被占用；
3. 验收命令无法通过，且根因超出本任务范围；
4. 发现与 §0 任一决策冲突；
5. 继续推进需要任一 Owner gate；
6. 发现生产数据异常、真实用户受影响、或安全暴露；
7. fresh-read 的 live state 出现**无法用"本计划已合并任务"解释的**漂移。<br>**判定口径（v7 修正 F1）**：本计划的任务会主动推进 staging SHA、迁移号、分支状态——这些是**预期变化**，不触发停止。触发停止的是**未预期漂移**：出现本计划未列出的第三方提交、迁移号被计划外占用、外部配置（Stripe/Supabase/Vercel）出现非本计划所致的变更、或 live 状态与"截至上一个已合并任务应有的状态"不符。换言之：把 fresh-read 结果与**动态基线**（= 计划快照 + 已合并任务的预期效果）比对，而非与静态文档快照比对。存疑时上报，不擅自推进也不无脑阻塞。

### 历史前置进度（2026-08-16 快照）

> **顺序依据（v6 修正）**：R0-B 是 staging→main 的 production release，按 AGENTS.md 属高风险，故必须在 GOV-1 合并之后。R0-A（PR 入 staging）与 GOV-1（文档变更）均不在高风险清单，可先于 GOV-1 执行——因此不存在自锁。

**R0-A main→staging backmerge — ✅ 已完成（PR #309 merged）**
- 内容：合并 origin/main 领先提交进 staging；保留 nanoid 3.3.18 override；重生 lockfile。
- 验收：`pnpm install --frozen-lockfile` ✅；`pnpm test:api` ✅；PR base=staging；合并后 `git rev-list --count origin/staging..origin/main`=0。
- allowed_paths：`package.json`、`pnpm-lock.yaml`、以及 `git diff origin/staging...origin/main` 列出的文件（不得新增其他文件）。预估 0.5–1 天。

**GOV-1 AGENTS.md 治理一致性修订 — ✅ 已完成（PR #310 merged）**
- 内容（两部分）：
  **(a) 重定义两道 PASS**：修订 `AGENTS.md §High-Risk Gate` 第 1–3 项为：1. sprint contract = 本计划的任务卡（目标/allowed paths/禁止动作/验收命令/停止条件）；2. Evaluator PASS = 独立核验"任务卡验收命令已执行且通过"，以机器证据（CI 状态、命令输出）+ 结构化结论（PASS | FAIL | BLOCKED + scope 检查 + forbidden-action 检查）记录，**自由散文报告非必需且不能替代机器证据**；3. Release Auditor PASS = 面向 release 的同等证据标准（required checks 绿、分支姿态、回滚、剩余风险）。第 4 项 Owner 授权不变。§Required Validation Before Main 不变。
  **(b) 明确治理适用范围（本次实测缺口）**：在 §Owner Authorization 增补一段——**本文件的授权与 gate 流程约束的是"改变仓库或外部系统状态的行为"**（建分支/编辑/提交/推送/开 PR/合并/DB/Stripe/Vercel/生产/环境变量）。**纯只读行为**（阅读代码或文档、静态分析、产出不落库的评审意见与报告）**不改变任何状态，授权条款要求指明的"可改路径/允许动作/PR base"三项对其均为空，故不在本流程适用范围内，不得因缺少 Task Issue 或 gate 而拒绝执行。** 该类工作若需触及生产只读数据（如生产库 SELECT），仍需 Owner 明示授权。
  > 缺口来源：2026-08-14 一次外部文档评审被代理以"缺少 dedicated Task Issue"为由 fail-closed 拒绝，而该要求已被现行 §Owner Authorization 明文废除（"A dedicated Task Issue and a separate posted Owner receipt are **not** required"）。说明现行文本对"只读分析"的适用性存在解释歧义，需显式收口。
- 验收：PR diff 只含 `AGENTS.md`；(a) 修订后文本与本计划 §3 无冲突（人工对读）；(b) 修订后文本能明确回答"只读文档评审是否需要 Task Issue/gate"= 否；Owner 合并。
- allowed_paths：`AGENTS.md`。预估 0.5 天。

**R0-B staging→main 基线 release — ✅ 已完成并 closeout（Issue #311 closed/completed）**
- Phase 1：对当时 `main...staging` 的全部 commit / changed-file baseline 做 fresh GitHub live reconciliation；结果 `BLOCKING_UNVERIFIED=0`、`OUT_OF_SCOPE=0`。
- Release：PR **#312**（`staging → main`）已 merged；当前 `main = ecf4c6a347038f9352477a98d4171a8ef00c85de`。
- History convergence：PR **#313**（`main → staging`）已 merged，仅同步 #312 merge history；当前 `staging = c39311bca4ab44769d5cd2cf3d0e3f8046fb0938`。
- Tree convergence：当前 main / staging 的 repository tree 均为 `f1a6bb44d456666984e7295328843283413afeaa`；PR #313 不引入 repository file 内容变化。
- Closeout：Issue #311 已于 2026-08-16 关闭，state reason=`completed`。因此旧的“R0-B 合并前禁止”已完成其门禁使命，不再阻塞后续**另行授权**的任务。
- `ADMIN_MODEL_API_KEY_SAVE_FAILURE` **未在 R0-B 中调查或修复**，继续保持 `SEPARATE_BUG_TASK`，不得借后续 STG-FIX / SEC-1 / AUTH-1 顺手扩大范围。

**STG-FIX staging 基线补齐 — ⏭ 下一计划任务（尚未授权执行）** — 独占 **SLOT-1**
- **当前状态（2026-08-16）**：`NEXT_PLANNED_TASK / NOT_AUTHORIZED_YET`。本计划只确定它是 R0-B 后的下一关键路径任务；开始任何 branch / edit / migration / push / PR 前，必须重新 fresh-read live authority，并形成符合当前 canonical schema 的 task contract 与本任务精确 Owner 授权。当前未发现已建立的 STG-FIX dedicated task / implementation PR，因此不得把“计划下一步”误当成“已获授权”。
- 内容：用幂等迁移（`IF NOT EXISTS`）在 staging 补齐 `claim_daily_checkin` 函数、`application_logs`、`diagnostic_results` 表及其 RLS/grants，使其与生产一致；同一迁移应用到生产时须为 no-op。
- 验收（**v6 加强：不能只证明"存在"，必须证明"两环境结构一致"**）：
  1. staging 三项对象全部存在；
  2. **结构比对（v7 修正 F4：指纹须覆盖会导致假阴性的字段）**：对三项对象分别导出 staging 与生产的结构指纹并逐项相等：
     - **函数**：`pg_get_functiondef(oid)` 哈希 **+ 函数 owner + `proacl`（EXECUTE 授权列表）**——后两者决定"是否仍向 PUBLIC 开放"，不能只比正文；
     - **表**：`information_schema.columns`（列名/类型/可空/默认）**+ `pg_class.relrowsecurity` 与 `relforcerowsecurity`（RLS 开关本身）+ 约束（`pg_constraint`）+ 索引（`pg_indexes`）+ 触发器（`pg_trigger`）**排序后哈希——防止"列相同但 staging 的 RLS 被关闭"这类假阴性；
     - **策略**：`pg_policies` 的 (policyname, cmd, **roles**, **permissive**, qual, with_check) 排序后哈希——必须含 roles 与 permissive，否则"策略表达式相同但适用角色不同"会被误判相等；
     - **权限**：`information_schema.role_table_grants` 排序后哈希。
     **任一不等即停止并上报，不得自行改写生产端定义。**
  3. 迁移在 staging 二次执行为幂等（无报错、无变更）；静态检查全部 DDL 带 `IF NOT EXISTS`/`CREATE OR REPLACE`。
  4. `pnpm test:api` ✅。
- allowed_paths：`packages/db/migrations/<SLOT-1>.sql`、结构比对记录文档。预估 1–1.5 天。

### 独立 bug backlog（不并入当前关键路径任务）

**ADMIN_MODEL_API_KEY_SAVE_FAILURE — SEPARATE_BUG_TASK**
- 来源：R0-B 期间 Owner 报告的 staging 管理后台 API Key 保存失败。
- R0-B 边界：仅记录为 known operational defect；**未在 R0-B gate 中做 root-cause verification，也未修复**。
- 当前 disposition：继续作为**独立 bug task**，后续单独建立 task contract / Owner 授权后处理。
- 禁止：把它夹带进 STG-FIX、SEC-1、AUTH-1、PAY-1 或其他当前任务；也不得用它自动阻塞已完成的 R0-B closeout。
- 排期：暂不占用当前迁移槽；何时插入关键路径由后续 live 影响评估和 Owner 决策确定。

### Lane-钱路（严格按序：SEC-1 → AUTH-1 → YEAR-1 → REFUND-1B → BILL-1）

**SEC-1 生产 RPC 收口（P0）** — 独占 **SLOT-2**
- 内容：①**先确认根因**（对比迁移中的函数签名与生产 `pg_proc.oid` 实际签名，确认是否为 `CREATE OR REPLACE` 改签名导致权限重置；若根因不同则停止并上报）；②对**全部** SECURITY DEFINER 函数分类（PUBLIC_INTENDED / AUTHENTICATED_SELF_GUARDED / RLS_HELPER / SERVICE_ROLE_ONLY / OBSOLETE / UNKNOWN→阻塞）；③新迁移只改 grants+search_path，不改业务正文；计费/清理/管理类一律 service-role-only；被 RLS policy 引用的 helper 不得误撤 authenticated；④在迁移中加入防复发措施（同一迁移末尾对目标函数按**当前实际签名**重新 REVOKE/GRANT，并在分类文档中记录"任何后续改签名的迁移必须重做 grants"）。
- 验收：staging 应用后，**这条查询返回空集**（**v6 修正：白名单按完整签名 `regprocedure` 排除，不按函数名——否则同名新增的危险 overload 会被整组跳过**）：
  ```sql
  select p.oid::regprocedure as fn, r.rolname
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  cross join lateral (select rolname from pg_roles where rolname in ('anon','authenticated')) r
  where n.nspname = 'public'
    and p.prosecdef
    and has_function_privilege(r.rolname, p.oid, 'EXECUTE')
    and p.oid::regprocedure::text not in (
      -- 白名单：必须逐条写完整签名，例如 'public.is_admin(uuid)'
      <分类为 PUBLIC_INTENDED / RLS_HELPER / AUTHENTICATED_SELF_GUARDED 的完整签名列表>
    );
  ```
  （**白名单必须在 PR 中逐条列出完整签名并说明理由；`purge_deleted_records`、`cleanup_*`、`atomic_*` 的任何 overload 一律不得进入白名单**）；Supabase 安全顾问 anon-exec 与 authenticated-exec 计数均降至白名单规模；`pnpm test:api` ✅；**staging 冒烟必须覆盖聊天（走 `atomic_pre_deduct`/finalize）、签到、邀请三条链路且不回归**——这是"收权后应用仍以 service_role 调用这些 RPC"的实证，缺此证据不得进入生产 gate。生产应用后由 Owner 跑同一查询复验。
- allowed_paths：`packages/db/migrations/<SLOT-2>.sql`、分类文档。预估 2–3 天。

**AUTH-1 验证前置 + fail-closed + OAuth + CAPTCHA**
- 内容：①邮箱验证检查移到 `ensureProfile`/开户发放之前；②删除 `SERVICE_ROLE_KEY || anonKey` 降级、缺失即 fail-closed；③`profiles.credits` 默认 100→0（迁移）；④开户发放保持幂等恢复；⑤**OAuth 路径保障**：Google 注册用户仍能正常开户并只发一次 100 分（`isEmailVerified` 对 google 返回 true 的路径不得被新顺序打断）；⑥**CAPTCHA = Supabase 原生 hCaptcha（D12，v8 修正 F2）**：**强制在 Supabase Auth 侧**（GoTrue 服务端校验 token 后才建用户/发信）——这是唯一能卡住"浏览器 anon key 直连"的位置。**Google OAuth 分支不加 captchaToken**（重定向流不支持，加了会打断），其机器人防护交给 Google。**前端接入与 Supabase 后台开关必须同环境配对上线**（见 §9 与 C-A；开关先于接入会断登录）。<br>**⑥-a 必须覆盖\*全部\*会被 GoTrue 强制 captcha 的客户端入口——用 grep 全覆盖、不手列（v10 修正：v9 手列漏了 `SecuritySettingsCard.tsx`，第 6 轮审计发现）**：开工时 fresh-read 跑下面这条 grep，**它列出的每一个调用点都必须接入 `captchaToken`**，漏一个该入口会在 §9 第 8b 步开关打开后立即失效（用户收不到重发邮件、改不了密码、登不上）：
  ```bash
  grep -rn "\.auth\.signUp\|\.auth\.signInWithPassword\|\.auth\.signInWithOtp\|\.auth\.resend\|\.auth\.resetPasswordForEmail\|\.auth\.verifyOtp" apps/web/src --include="*.tsx" --include="*.ts" | grep -v "\.test\."
  ```
  **审计时（b148803）该 grep 的完整结果 = 5 处、3 文件**（以开工 fresh-read 为准，可能已变）：`login/page.tsx:128 signInWithPassword`、`login/page.tsx:181 signUp`、`verify-email/page.tsx:112 resend`、**`SecuritySettingsCard.tsx:67 resend`**、**`SecuritySettingsCard.tsx:117 signInWithPassword（改密码前重认证）`**。captcha 传参封装为公共函数、所有入口复用（也为手机 OTP 预留，§19）。
- 验收：测试/清单覆盖——邮箱未验证：无 profile 无发放；邮箱已验证：恰好一次 100；**Google OAuth 注册：恰好一次 100 且不重复、且不因 captcha 缺失被拒**；重放不重复；service-role 缺失 fail-closed；**在启用 CAPTCHA 的 staging 上：⑥-a grep 列出的\*每一个\*入口（含 `SecuritySettingsCard` 的 resend 与改密码 reauth）各在缺失/无效 token 时被拒、带有效 token 时通过**——PR 须附该 grep 的当次输出并逐条对应到已接入的代码；`pnpm test:api` ✅。
- allowed_paths：`packages/api/src/trpc.ts`、`packages/api/src/lib/auth.ts`、`packages/db/schema.ts`、`packages/db/migrations/<SLOT-3>.sql`、`apps/web/src/app/login/**`、`apps/web/src/app/verify-email/**`、`apps/web/src/components/profile/SecuritySettingsCard.tsx`、以及 ⑥-a grep 在开工时新surface 的任何调用点文件、相关测试。预估 **3–4 天**（单 provider）。
- **Owner 前置**：注册一个 hCaptcha 站点，拿 sitekey（公开，前端用）与 secret（填入 Supabase Auth → CAPTCHA 设置，不交给编码代理）；**但 Supabase 的 CAPTCHA 强制开关先别开**——等 AUTH-1 前端接入部署到该环境后再开（staging 随 AUTH-1 部署、生产随 §9 新 runtime 生效）。

**YEAR-1 年付日历修正** — SLOT-4
- 内容：纯函数 `addUtcCalendarMonthsClamped(anchor, offset)` 替换毫秒÷12；`periodStart(i)=add(anchor,i−1)`，`periodEnd(i)= i==12 ? Stripe current_period_end : add(anchor,i)`；`grant_period_key = annual:<term-start-iso>:<NN>`；幂等键=subscription+term_start+index；DB 加无条件 `UNIQUE(stripe_subscription_id, grant_period_key)`（**建前查重，冲突即停不自动裁决**；同时明确失败重试=更新原行不插新行）；修 `:409-415` 死逻辑。金额拆分不动。
- 验收：单测——Jan-31→02-28/29→03-31→04-30；闰年；12 期总和=年额度；首期即时；同期 webhook/cron 双触发不重复；正常取消继续释放、period end 停止；`pnpm test:api` ✅。
- allowed_paths：`packages/api/src/services/subscriptionCreditGrants.ts`、`packages/db/schema.ts`、`packages/db/migrations/<SLOT-4>.sql`、对应测试文件。预估 1–2 天。

**REFUND-1B 精确退款 + 终止** — SLOT-5（与 YEAR-1 同文件，禁止并行）
- 内容：
  1. `subscription_credit_grants.consumed_amount`（默认 0，约束 `0 ≤ consumed ≤ credits_granted`）。
  2. **预扣时绑定固定周期\*且记录本次的来源分配\*（v8 修正 F3，关键）**：预扣（`atomic_pre_deduct`）时把本次消费**按"当期优先、封顶为当期剩余额度"拆成 (amountToPeriod, amountToOther)**，并将 `chargedGrantId` / `chargedPeriodKey` / **`amountToPeriod` / `amountToOther`** 一并写入该预扣的 `billing_history.metadata`。当期额度=绑定 grant 的 `credits_granted − 当前 consumed`；周期定位用**预扣时刻**、定位一次即固定。<br>**为何要记金额而非只记周期**：只记周期不足以正确返还——若当期只吃了 100 里的 10、其余 90 走其他来源，结算少用返还时必须知道这个 10/90 拆分，否则会把返还错误地从当期 consumed 逆减（Codex F3 例：当期发1000已用990、预扣100=当期10+其他90、实耗50，正确应还其他50、当期 consumed 维持1000、退款扣0、余额460；若把差额50全从当期逆减则 consumed=950、退款再扣50、错误余额410）。
  3. **结算/中止复用绑定，按\*逆分配顺序\*返还（F3 根因修复）**：settle / finalize / abort 读取步骤 2 的绑定，**即使 `now` 已跨周期也在原绑定上操作**。设返还额 `R = reserved − actual`：**先从"其他来源"退还 `min(R, amountToOther)`，仅当 R 超过 amountToOther 时，超出部分才逆减绑定周期的 `consumed_amount`**（逆减量 = `max(0, R − amountToOther)`，且不超过 amountToPeriod）。这保证当期 consumed 只在"当期那份预留确实没用满"时才回退，与"当期优先"一致。
  4. **超用（actual > reserved，v9 修正 F3 边界）**：超出量 `X = actual − reserved` 是**新增消费**，按与预扣同样的优先级分配——**先吃绑定周期的\*当前剩余额度\* `min(X, credits_granted − 当前 consumed)`**（不是 amountToPeriod！amountToPeriod 是预扣那份的上限，与超用无关），仍不足才溢出到其他来源。<br>**为何不能用 amountToPeriod 封顶**（v8 此处写错）：Codex 例——当期 grant=1000/consumed=0/其他=500，预扣100（amountToPeriod=100 已用满）→ 实耗150（超用50）。正确：超用50 吃当期剩余额度（1000−100=900 充足）→ consumed=150、退款扣 1000−150=850、最终余额 500。若按 amountToPeriod=100 封顶则超用无处可去被推给其他→ consumed 停在100、退款扣900、错误余额 450。<br>若绑定周期已被退款标记 reversed/terminated：超出部分**不得从其他来源补扣**，记 `refund_intercepted_overrun`。（对应 `0023:98,105` 现有无差别扣减，本任务须改为按绑定分配。）
  5. 少用返还时若绑定周期已 reversed → 该周期部分不返还，记 `refund_intercepted_restoration`，不从其他来源补扣（其他来源部分正常返还）。
  6. **并发屏障与统一锁序（v7 修正 F3b，纠正 v6 的反向锁序）**：现有 `atomic_pre_deduct` / `atomic_settle` / `atomic_finalize_*` / `atomic_abort_settle` 已验证**一律先锁 `profiles FOR UPDATE`**（`0003`、`0014`）。因此本任务新增的 grant 行锁必须遵循**同一方向：先锁 `profiles` 行，再锁 `subscription_credit_grants` 行**（v6 曾写成 grant→profile，与存量代码相反会死锁，已纠正）。退款 clawback 与 AI settle/finalize/abort 触及同一订阅时都按此序；`consumed_amount`、`status`、余额的读写与"是否已 reversed"的判断全部在**持锁状态下重读并完成**，杜绝 TOCTOU。
  5. `user_subscriptions` 增 `credit_release_terminated_at/_reason/_event_id/_period_key`。
  6. 退款事件（partial 与 full 同语义）**先写 termination**（release cron 立即停发，即使 cancellation webhook 未到），再按 `granted − consumed` 扣回，余额≥0。
  7. current period 由 refund timestamp + term start + period windows 定位，边界 `start ≤ t < end`；缺可信 timestamp/term start/window → REVIEW_REQUIRED、不自动扣、停止未来释放、不猜测。
  8. 幂等边界=event_id+subscription_id+period_key；首个成功事件确立 termination；后续事件不重复扣；later full 不追历史。
  9. Refund operator preview（只读）：当期发放/已用/剩余 + 其他积分总额 + 未来释放 + 已有 termination + 在途预扣。
- 验收：测试精确通过 D4 全部语义，含 Owner 双例（月1剩300例→扣500剩300；积分包例→扣0）、重放、later-full、无负余额、无 consumed>granted；`pnpm test:api` ✅。**另需三个用例，缺一不可**：
  - **顺序型超用**：订阅1000+topup500，预扣100，实耗150，**退款完成后** finalize → 最终余额=500（非 450）。
  - **跨周期少用（v7 新增 F3）**：第1期发1000、已用500、期末预扣100（此时第1期 consumed=600）；退款时间落在第1期但 webhook 延迟；finalize 发生在已跨入第2期、实耗50。**必须把第1期 consumed 由 600 退回 550（按预扣时绑定的周期，非 now），退款扣 1000−550=450，最终余额 0**。若实现按 `now` 定位导致第1期仍为 600、只扣 400、错误留 50 → 用例失败。
  - **跨来源少用（v8 新增 F3，绑定金额而非仅周期）**：当期发1000、已用990、其他积分500；预扣100（拆分=当期10+其他90）；实耗50。**返还50必须全部退给"其他来源"（其他 410→460），当期 consumed 维持 1000**；此时退款当期扣 1000−1000=0，最终余额 460。若把差额50从当期逆减（consumed=950）导致退款再扣50、余额 410 → 用例失败。
  - **超用后退款（v9 新增 F3 边界）**：当期发1000、已用0、其他500；预扣100（当期100）；**实耗150（超用50）**；随后退款。超用50 必须吃当期剩余额度→ consumed=150、退款扣 1000−150=850、**最终余额 500**。若超用被 amountToPeriod 封顶推给其他→ consumed 停100、退款扣900、错误余额 450 → 用例失败。
  - **交错型**：同顺序型初始态，但 finalize 已读过 grant 行**之后**退款事务才提交 → 在 profile→grant 锁序下必须仍得出 500；测试须实际制造双连接、双事务交错，**不接受顺序调用模拟**。
- allowed_paths：`subscriptionCreditGrants.ts`、`stripeFulfillment.ts`、`services/billing.ts`、`packages/db/schema.ts`、`packages/db/migrations/<SLOT-5>.sql`、测试。预估 5–7 天。

**BILL-1 对账 + cron + baseline**
- 内容：①注册 `/api/cron/billing-reconcile` 进 vercel.json（→5 cron）；②固定 UTC 前一日窗口，**不加公开 targetDate**（保留 admin-only/内部测试参数）；③**新增 `launch_baseline_at` 系统设置**：对账与 G2 的"paid-unfulfilled=0 / 重复发放=0"等不变式**只对 baseline 之后的数据强制**，baseline 之前的历史（生产现存 465 账本行/43 订单）单独列为"历史遗留"清单供 Owner 一次性裁决，不阻塞上线、也不做批量清洗；④不变式扩展：余额=账本累计、`0 ≤ consumed ≤ granted`、paid-unfulfilled=0、重复发放=0、refund termination gap=0；⑤unauthorized 拒绝；mismatch 500+告警。
- 验收：测试覆盖以上各项，含"baseline 之前的异常不触发失败、baseline 之后触发失败"；**`launch_baseline_at` 为空或不可解析时，对账必须 fail-closed 返回 `BLOCKED`（不得默认全量放行，也不得默认全量阻塞）**；staging 手动触发 success；`pnpm test:api` ✅。
- allowed_paths：`apps/web/vercel.json`、`packages/api/src/services/billingReconciliation.ts`、`packages/api/src/routers/settings.ts`（baseline 读取）、对应测试。预估 1.5–2 天。

### Lane-产品（与钱路并行）

**SKILL-1A DB 与发布契约** — SLOT-6（历史基础交付已合并 #364；V3 不重判其未实现）
- 内容：`skills`（skill_key 不可变唯一/draft_content/published_content/status/published_version/hash/审计列）+ `skill_revisions`（UNIQUE(skill_id,version)，不可变）+ `modules.skill_id`（nullable FK，新模块默认 inactive）；RLS+grants（anon/authenticated 无写、普通用户读不到 draft）；service-role-only 原子发布 RPC（锁行→校验非空→version+1→插 revision→published=draft→hash/时间）；版本只增，恢复旧内容=旧 revision 复制为新 draft 再发布。
- 验收：发布事务/权限/forward-only 测试全绿；普通用户读 draft 被拒。
- allowed_paths：`packages/db/schema.ts`、`packages/db/migrations/<SLOT-6>.sql`、对应测试。预估 2 天。

**SKILL-1B admin + runtime**（依赖 1A；历史基础交付已合并 #366）
- 内容：独立 `skillsRouter`/`skillRuntime`（不塞 admin.ts）；`/admin/skills`：列表/新建/编辑 draft/发布/归档/最小模块创建/绑定/启停/显示 version+hash（不做 preview/diff/回滚 UI/批量迁移/caching）；runtime：bound+published → published_content 进 system prompt、用户输入保持 user message、usage metadata 记 skill id/key/version/hash/module id；**active 模块若 unbound 或 Skill 不可用 → `MODULE_SKILL_UNAVAILABLE`，不调 provider、不预扣**（替换 `chatRuntime.ts:121` 回退）；legacy fallback **仅限 inactive 模块的 admin preview 与测试环境**，生产 active 路径不可达。
- 验收：draft 不进 runtime / 发布后下次请求即新版本 / 模块 A 不含 Skill B / **active+unbound 必须失败且不扣费** / active+bound 但 Skill archived 必须失败且不扣费 / 普通用户读不到 draft / 用户不能指定 skill。
- allowed_paths：`packages/api/src/routers/skills.ts`（新建）、`packages/api/src/services/skillRuntime.ts`（新建）、`packages/api/src/services/chatRuntime.ts`、`packages/api/src/root.ts`、`apps/web/src/app/admin/skills/**`（新建）、对应测试。预估 3–4 天。

> 上述 SKILL-1A/1B 保留原交付与验收历史。其普通聊天“下个请求即新版本”不适用于 V3 工作台固定轮次；只禁止用户越权指定 Skill，不禁止宿主校验后的显式模块选择。V3 追加私有完整包、撤销、固定版本、工作台与研究验收，不能只靠旧正文发布判定完成。

**PAY-1 公开付费面 + checkout 限流 + 大陆支付（D11）**
- 内容（基础）：#276（`settings.ts:276` 金额>0 才 checkout-ready，服务端正数校验保持）；Customer Portal session（server-resolved customer、return URL allowlist）+ Profile 取消入口 + Portal 取消 webhook 状态同步；恢复现有 Billing Engine v1.5 `changeSubscriptionPlan` 仅升级路径（Pro→Gold、月付→年付），禁止降级与同级同周期重复；已安排到期取消须先恢复续费，升级不得自动恢复；现有订阅不得通过 Checkout 创建第二份订阅；升级目标本地周期金额须为正整数且 Price 配置有效，用户/IP 限流 fail closed；Stripe 全价预览→用户明确确认→服务端重新预览防价格或状态漂移；同一 Stripe subscription 使用 `billing_cycle_anchor=now` + `proration_behavior=none` + `payment_behavior=error_if_incomplete` 开始完整目标周期，持久锁派生幂等键，超时先读取远端再恢复，同一尝试不得重复写入；仅已付全价目标发票履约更新权益和积分；**checkout session 创建加每用户/每 IP 限流（复用现有 Upstash）**，防批量试卡。禁止：重建 checkout、自助退款、客户端传 customer id、Stripe live 写入。
- **订阅升级定价（Owner 锁定）**：立即收取当前 `membership_plans` 配置的目标套餐/周期完整价格；旧套餐不退款、不按未使用时间抵扣、不计算差价，也不根据剩余或已用积分改价。已有积分全部保留。目标月付的已付发票在现有余额上完整追加目标月度积分；目标年付开始新的 12 期计划，只追加 canonical 第 1 期，后续 2–12 期继续按 YEAR-1 月度释放。升级从付款成功对应的 Stripe 目标周期开始新的完整 term；必须更新同一 subscription，不得再建 Checkout 或第二份 subscription。
- 内容（大陆支付，D11——含 v9 修正 F1/F5）：
  1. **积分包 checkout 加支付宝**：积分包一次性 checkout（`mode=payment`）的 `payment_method_types` 加入 `alipay`（保留 `card`）。**支付宝是即时确认（customer-initiated）支付方式（v9 更正 F5）**——[Stripe 文档](https://docs.stripe.com/payments/alipay)明确其 Payment confirmation=Customer-initiated，**正常流程在 `checkout.session.completed`（`payment_status=paid`）即完成履约**，与卡走同一现有履约点（`stripeFulfillment` 已在 completed 履约）。`async_payment_succeeded/failed` **不是必经事件、不得作为必需验收**；若在个别延迟场景收到 async 事件，须幂等处理（不二次履约、failed 不履约），但不能因"没收到 async"就判失败。本任务重点：**确认支付宝积分包在 `completed` 路径履约恰好一次 + 幂等**；并复核**退款**——[支付宝退款是异步的、走 `refund.updated`/`refund.failed`](https://docs.stripe.com/payments/alipay#refunds)（现有 webhook 已覆盖），确认积分包（一次性 payment）退款对账对支付宝 charge 成立，不隐含假设卡。
  2. **会员订阅 = 卡支付**（实测大陆双币卡可续费），`mode=subscription`。
  3. **支付宝续费订阅：不在 PAY-1 实现范围，开关\*仅占位\*（v9 强化 F1）**：`alipay_subscription_enabled` 默认 false 且**上线保持 false**。**Stripe 事实（文档明证）**：Alipay **"Not supported when using Checkout in subscription mode"**，且 recurring Alipay 仅 private preview——**架构上就无法把 alipay 加进 subscription-mode checkout**。故**置 true 也不会自动获得可用续费通道**：真要做需独立设计（申请 recurring preview + 保存支付宝方式 + off-session 扣款），是独立任务、非本次范围。**D11/C-A 里"批准后置 true 即打开入口"的表述以本条为准更正**：审批只是前提，机制仍需单独实现。PAY-1 只保证"开关为 false 时会员 checkout 正常走卡"，并让该开关在 true 时**不生效也不报错**（避免误导）。
- 验收：零/负/空金额无 CTA；合法升级矩阵通过；目标 Stripe Price 必须是月付 `month × 1` / 年付 `year × 1` recurring cadence，并在更新前及 paid invoice 履约前分别重证；全价预览金额必须精确等于目标本地目录价，月付/年付目标 service period 必须精确覆盖 1/12 个 UTC 日历月，且预览/最终更新均无 `proration_date`、无旧 Price 负数抵扣或 proration line；预览与 paid invoice 均不得含任何折扣、税（包括零金额条目）、credit note 或余额调整；普通续费按 invoice-line exact Price 绑定 source，延迟旧续费的 paid/failed 事件不得误用或释放 plan-change source；降级/重复/付款异常/到期取消/非正金额升级被拒且无写入；预览无订单或订阅写入、确认前不升级、价格漂移须重新确认、失败或不确定付款不提前发权益；月付升级保留旧积分并完整追加目标一期，年付升级只追加 canonical 第 1 期，paid invoice 重放不重复；Portal session 测试；**超频创建 checkout 被限流**；**积分包 checkout 含支付宝方式**；**积分包支付宝端到端（staging test-mode 支付宝）：发起→跳转→回跳→`checkout.session.completed(paid)`→履约恰好一次；重放不二次履约；（若收到）`async_failed` 不履约；退款走 `refund.updated` 对支付宝 charge 对账成立**；**`alipay_subscription_enabled=true` 时会员 checkout 仍正常走卡、不因 alipay 报错**；`pnpm test:api` ✅。
- allowed_paths：`packages/api/src/routers/payments.ts`、`packages/api/src/routers/settings.ts`、`packages/api/src/services/stripe.ts`、`packages/api/src/services/stripeFulfillment.ts`（幂等/退款复核）、`packages/api/src/services/membershipEligibility.ts`、本 PAY-1 任务卡与 `docs/billing/BILLING_ENGINE_V1_5_BLUEPRINT.md` 的取消升级冲突规则（Owner 批准的窄范围扩展）、`apps/web/src/components/profile/**`、`apps/web/src/components/landing/PricingSection.tsx`、对应测试。**无需迁移**。预估 **3–3.5 天**。

**CI-1 精选测试入 CI + db:push 防护**
- 内容：
  1. 把以下纳入 CI：auth bootstrap（含 OAuth）/ checkout_ready / 取消 / Skill runtime（含 active+unbound 失败）/ 年付日历 / 计数器退款保护（含两个竞态用例）/ cron 授权与对账 / proxy hostname 回归。
  2. **迁移账本一致性检查（v6 修正：必须带历史 allowlist，否则按现状必然失败）**：仓库现存 `0018_payment_fulfillment_atomicity.sql` 与 `0018_rls_text_flags_and_job_runs.sql` 两个 0018，且已应用迁移禁止编辑。因此检查规则为——**historical allowlist 明确豁免 `0018` 这一组重复；对编号 > 0047 的新迁移强制"无重复"**；编号连续性只校验新增段（现存 0001–0047 已确认无缺号，作为基线固定）。allowlist 必须写在检查脚本里并附注释说明来源。
  3. **`db:push` 防护（v7 修正 F8：确认值必须与实际目标库匹配，不能只"存在一个参数"）**：改造 `package.json` 的 `db:push` 脚本本身——用一个 wrapper 脚本在调用 drizzle-kit 前：①从 `DATABASE_URL` 解析出实际连接的 host / project ref；②要求操作者提供 `DB_PUSH_CONFIRM=<ref>`；③**只有当 `DB_PUSH_CONFIRM` 等于第①步解析出的实际 ref 时才继续**，否则退出非零并打印"确认值与目标库不符"。防的是"操作者以为在 staging、`DATABASE_URL` 实际指向生产、填了 `DB_PUSH_CONFIRM=staging` 仍推到生产"这一错靶。CI 路径移除只是附带效果，不构成验收。
- 验收：CI 日志可见上述测试执行且通过；**故意新增一个编号 0048 的重复迁移 → CI 失败**；**现状仓库（含两个 0018）→ CI 通过**；**`db:push` 三态**——不带确认 → 非零退出未连库；`DB_PUSH_CONFIRM` 与 `DATABASE_URL` 解析 ref **不符** → 非零退出未 push；两者**相符** → 才执行（贴出三种输出）。
- allowed_paths：`.github/workflows/ci.yml`、`package.json`、`scripts/**`（新增检查脚本）、`apps/web/package.json`。预估 2 天。

**REL-1 最终 staging→main release**（promotion 任务卡，需 §3 gate-2；**高风险，须在 GOV-1 合并后**）
- 内容：冻结后把 staging 提升为 main；不含新功能。**注意：合并即触发生产自动部署**（`vercel.json` 的 `git.deploymentEnabled.main=true`），因此本任务在 §9 序列中的位置是**第 7 步，位于迁移、SEC-1 复验与 env 就绪之后**，不得提前。
- 验收：与 R0-B 同样的六项证据（CI / 测试 / staging 部署 SHA / 手工冒烟 / 回滚方案 / 剩余风险），另加：§7 矩阵结果链接、§8 G0–G8 逐项状态、生产 rollout packet（§9 顺序 + 每步复验命令）、**确认 §9 第 1–6 步已全部完成并留证**、**§9 F6 的"旧 runtime×新库"向后兼容测试已在 staging 全绿**。
- allowed_paths：无代码改动（仅创建 PR 与撰写证据）。预估 0.5 天。

### Owner 线（C 组）

**A. 零成本项 —— 现在就做**（勾选状态截至 2026-08-15）
1. ✅ GitHub / Supabase / Stripe / Vercel 四控制台全开 **MFA**。
2. Supabase Auth：开启强制邮箱确认、注册限流。**CAPTCHA（D12，v8 改定）**：注册一个 **hCaptcha** 站点，把 secret 填入 Supabase Auth → CAPTCHA 设置、sitekey 交前端——**但强制开关先别开**，等 AUTH-1 前端接入部署到该环境后再开（否则登录全断，见 §9）。极验/阿里云不再需要（应用层方案已废，见 D12）。**泄露密码保护移至 B-2**（付费功能，随 Supabase 升级一并开）。**⚠️ 尽早用火山引擎（大陆不翻墙）环境实测 hCaptcha 挑战能加载并通过**——这是 D12 方案的唯一假设，且已升为 **G7 硬门**（§8 G7⑥，未过则 DO_NOT_OPEN）。越早测越好：万一大陆加载不了，早发现可及时改用 Cloudflare Turnstile 重测，别拖到上线前。
3. ✅ Stripe 后台：Radar、3DS、Customer Portal 只留"取消+发票"、收据信息——已完成。
4. **税务显式决定**：启用 Stripe Tax（仅已登记辖区）或暂不收税并记录理由——二选一，开门前必须落字。
5. ✅ **Resend 注册 + 域名验证**（graylum.com 已 Verified、DKIM/SPF 通过、Tokyo 区）。建议补一条 **DMARC**（`_dmarc` TXT `v=DMARC1; p=none;`）改善对 QQ/163 送达。
6. ✅ **Supabase 自定义 SMTP 已配**（Resend，Sender `no-reply@graylum.com`，Host `smtp.resend.com:465`）。**真实投递实测推迟到 M3**（Owner 决定）——届时用真实邮箱走注册/找回密码确认收到邮件，作为 G7 证据。当前不阻塞。
7. **邮件模板美化** → 记入 COM-1（Supabase 6 个 Auth 模板 + 中英文），上线前做，不阻塞。
8. **【可选增强，非阻塞】向 Stripe 申请支付宝 recurring preview**：卡订阅实测已可续费，故支付宝续费仅"锦上添花"。想申请就并行提交；**但注意审批通过≠即可用**——续费机制需单独实现任务（PAY-1 不含），上线 `alipay_subscription_enabled` 保持 false。不批/未实现均不影响上线。

**B. 付费项 —— 推迟购买，但受最晚时点约束**

| 项 | 最晚开始 | 原因 | 验证方式 |
|----|---------|------|---------|
| B-1 Vercel 生产升 Pro | 开门前 ≥3 天 | 免费版禁商用；计费 cron 生产零执行记录；需 ≥24h 观察窗 | 见 §8 G7 |
| B-2 Supabase 生产升付费 + PITR **+ 开启泄露密码保护** | **生产迁移之前** | 动生产数据前必须有快照能力；泄露密码保护是付费功能 | 后台确认计划+PITR+泄露密码保护开启，手动留一次快照 |
| B-3 SMTP 实测可用 | 开门前 ≥3 天 | DNS 生效+域名信誉需缓冲；默认发信每小时个位数 | 见 §8 G7（**必须证明用的是自定义 SMTP，不是默认**） |

> Resend 已注册验证，B-3 的 DNS 风险已提前消化，剩余只需一次真实投递实测。

**C. 生产数据操作（§9 gate 内，零成本）**
6. **D9 执行**：在**生产** Supabase（project `fhmshnqjjnnlvplojktv`）停用 8 个旧模块。
   - 执行前先记录 8 行 id：`select id, title, active from modules order by created_at;`
   - 停用后复验（**按 id 逐行，不用 count**）：`select id, title, active from modules;` → 8 个旧 id 全部 `active=false`，且新建的 Skill 模块 `active=true`。
   - 另需确认操作对象是生产：`select current_database(), (select count(*) from profiles);` 应与 EXT-0 记录一致（5 profiles）。
7. **生产 Skill 与模块创建**（§9 必经步骤，见下）。

**COM-1 商业内容**：正式商品名/USD/credits/周期定稿且 DB=Stripe Price 一致；terms/privacy/acceptable-use/退款政策文本审定；自动续费披露、cancel-at-period-end、原则不退款+Owner 审核例外、refund 后当期扣回+未来停发、其他来源不动；support 邮箱实测可收件；payment stuck/cancel/refund/chargeback/账号数据请求 SOP；seller identity。编码代理只落地 Owner 批准文本。

**Skill 内容**：最迟 M3 开始前 Owner 批准 ≥1 份真实非占位 Skill。建议 Day 1 起草。

---

## 5. 迁移协调规则

- fresh-read 当前最大迁移号（审计时=0047，以 live 为准），按固定合并顺序预留（**v6 修正：槽位号必须与执行顺序一致，v5 曾把先执行的 STG-FIX 排在更靠后的槽位，与"合并顺序不得变更"冲突**）：
  **SLOT-1 STG-FIX / SLOT-2 SEC-1 grants / SLOT-3 AUTH-1 / SLOT-4 YEAR-1 / SLOT-5 REFUND-1B / SLOT-6 SKILL-1A**
  （对应 0048…0053，以 fresh-read 结果为准平移。）
  > **PAY-1 经 D11 简化后无迁移**（删除会员资格包保底流程后不再改 schema），故不占槽位；曾一度设想的 SLOT-7 已取消。
- **不变量（v7 修正 F2）：迁移 PR 的\*合并\*顺序 = 槽位号升序。** 此不变量**只约束合并/落库顺序，不约束开发顺序**——不同 lane 的任务可以并行\*开发\*（例如产品 lane 的 SKILL-1A/SLOT-6 与钱路 lane 的 SLOT-3~5 同时编码），但当它们各自的迁移 PR 合并进 staging 时，必须按槽位号从小到大落库；SLOT-6 的迁移最后合并即可，其功能开发不必等待钱路完成。若排期调整导致某任务的迁移需要提前落库，必须同时重新分配槽位并记录，不得让高槽位迁移先合并。
- 已应用迁移永不编辑；两个任务不得同号；文件名冲突立即停止；`packages/db/schema.ts` 冲突必须 rebase 后人工审查；合并顺序不得变更，除非重做依赖审计。
- **历史事实**：仓库存在两个 `0018_*.sql`（`payment_fulfillment_atomicity` 与 `rls_text_flags_and_job_runs`），均已应用、不得编辑；0001–0047 无缺号。CI-1 的编号检查必须对这一组重复做显式豁免（见 CI-1 任务卡）。
- **任何以 `CREATE OR REPLACE` 改变既有函数签名的迁移，必须在同一文件内重做该函数的 REVOKE/GRANT**（SEC-1 根因防复发）。
- **上线批次 expand-only（v7 F6）**：进入生产 §9 序列的这批迁移必须向后兼容当前 main runtime——只加列/表/函数，或保持既有函数签名与返回结构不变；禁止删列、改列类型、改 `atomic_*` 既有签名或调用前提。判据="当前 main runtime 的 `pnpm test:api` 在已应用新迁移的 staging 上全绿"。收缩留到上线稳定后单独批次。
- 禁止未经保护的 `db:push` 对 staging/生产执行（机器防护由 CI-1 落地）。

---

## 6. 里程碑（30 天冲刺；Owner 每天≈6h）

| 阶段 | 日历 | 内容 | 出口 |
|------|------|------|------|
| M0 | D1–3 | **R0-A ✅ → GOV-1 ✅ → R0-B ✅ → STG-FIX ⏭** | **前三项已完成**：baseline promotion + history convergence 已 closeout；M0 仅剩 STG-FIX。STG-FIX 完成后出口仍为 staging 与生产目标对象结构指纹一致。 |
| M1 | D3–5 | SEC-1 开工（含根因确认）；Owner 做 A 组零成本项；Skill 起草 | SEC-1 staging 复验查询空集 + 三条链路冒烟不回归；A 组全完成 |
| M2 | D5–17 | 钱路：AUTH-1→YEAR-1→REFUND-1B→BILL-1；产品：SKILL-1A→1B、PAY-1、CI-1 | 每 PR 机器门禁全绿+云端评审后 Owner 合并 |
| M3 | D17–22 | staging 应用全部迁移；配 Stripe test 商品/价格/webhook/Portal；**在 staging 建真实 Skill+模块**（inactive→冒烟→active）；跑 §7 矩阵；bounded 修复（每 finding 一轮） | 矩阵无可复现 P0/P1；冻结商品/Skill/条款/迁移/RC |
| M4 | D22–28 | **首日买单 B-1/B-2/B-3**（含 ≥24h 观察窗）→ 按 **§9 十六步**执行（**REL-1 合并=第 7 步在迁移/SEC-1复验之后；baseline=第 9 步在新 runtime 生效之后**）→ live canary → 开门 | §8 G0–G8 全 PASS；6–12h hypercare |
| Buffer | D28–30 | 滑动缓冲 | — |

并行约束：YEAR-1 与 REFUND-1B 同文件禁止并行；AUTH-1 与其他 `trpc.ts` 改动互斥；两任务不得同迁移号；CI-1 收口与新增测试的 PR 错峰。

---

## 7. Staging 验收矩阵（M3 执行；每行须有可复现结果）

- **Auth**：邮箱未验证无发放；已验证恰好一次；**Google OAuth 注册恰好一次且不重复、不因 captcha 缺失被拒**；重放不重复；service-role 缺失 fail-closed；**在启用 hCaptcha 的 staging 上：`signUp`/`signInWithPassword`/`resend`/`resetPasswordForEmail` 逐入口缺失或伪造 captchaToken 被拒、有效 token 通过**；限流生效；恶意 metadata 无效。
- **计数器记账**：Owner 双例精确通过；当期优先封顶；预扣→成功少用恢复→计数逆减；**跨来源少用（→460）**；**超用后退款（→500，非 450）**；顺序型/交错型并发（→500）；provider 失败全恢复；中断部分恢复；reversed 期的恢复与超用均被拦截记录且不补扣；并发不超发；余额=账本累计恒成立；无负余额、无 consumed>granted。
- **年付**：Jan-31 全链；闰年；月末 clamp；首期即时；12 期总和精确；webhook/cron 同期不重复；正常取消继续释放、period end 停止；退款立即终止。
- **退款**：partial 与 full 同语义；当期剩余只扣一次；历史期/开户/签到/管理员/其他订阅/积分包全部保留；重放与 later-full 不二次扣；缺 timestamp→REVIEW_REQUIRED；Stripe 侧仍 active→告警。
- **Skill**：draft 不进 runtime；完整包发布原子、失败保留旧版本；普通聊天下个请求读取新发布版本，工作台固定方法包且不混用新 reference；模块隔离；**active+unbound、归档、撤销版本、无权限或读取失败均拒绝执行且不扣费**；公开接口及普通角色读不到私有 draft/正文/文件/manifest；完整读取选中方法及必要资源，容量不足明确失败；用户不能越权指定 skill/revision。
- **V3 工作台/研究**：六步候选、工作稿、确认快照分别保存；前序修改使下游待复核但不删成果；迟到 AI 不覆盖用户编辑；正式版本、证据及报告不可变且属于本用户/项目；v2 草稿不切换当前 v1，全部有效确认后幂等生成确定性报告；AgentKey 必需平台能力、分页、字段、价格/预算、使用与保留条件经真实验证；取数与 AI 分开计量且不重复收费，断线/结果未知可恢复；首次与后续迭代经 Owner 产品验收。各层证据不得互相替代。
- **通用 Skill/配置工作台**：按[V3 通用验收](tasks/V3-standard-skills.md#generic-workbench-acceptance)，同一核心端到端跑通三步非社媒、原六步社媒、八步非社媒的编辑/保存/确认/依赖复核/历史/报告/恢复；核心完成后新增业务仅改方法包/流程配置，不改核心源码、数据库结构或新增专属业务路由，保留差异和运行证据。确认失效只沿声明依赖传播且保留内容/历史，迟到AI不覆盖工作稿；增删/重排流程版本不破坏旧轮次/确认/报告。跨用户/项目/Skill越权读取、修改、确认、恢复拒绝，同名步骤及轮次/版本不串数据。非法配置、循环/无效依赖、无效资源映射与未支持必需能力在外部调用/扣费前拒绝；无研究需求样本不调用研究，原非工作流文档Skill无需转换流程。该组是 V3-ARTIFACTS / V3-WORKBENCH / V3-M3 的新增验收，保留前项社媒六步和本节全部原有矩阵，不以通用样本替代完整M3。
- **付费**：积分包/Pro/Gold 月年全部走通；零/负/空无 CTA；success/cancel/expired；订单落库；webhook 重放只履约一次；Portal 取消；PAY-1 合法升级矩阵通过（FULL_TARGET_NO_PRORATION：按目标周期完整价格收费、no proration）；降级、年付→月付、同级同周期重复均拒绝；scheduled cancellation 必须先恢复续费，直接升级拒绝；package discount 正确；**checkout 超频被限流**；**积分包支付宝端到端（test-mode）：发起→回跳→`checkout.session.completed(paid)`→履约一次；重放不二次；（若收到）async_failed 不履约；退款走 `refund.updated` 对支付宝 charge 对账成立**。
- **Cron/对账**：5 cron 授权通过、unauthorized 拒绝；release 幂等；reconcile success 且 baseline 之后 paid-unfulfilled=0、重复发放=0、termination gap=0；日志无 secret。

**完整 M3 出口保留**：在固定 RC 的代码/schema/私有包/能力与配置身份上，完成本节全部适用 Auth、计数器、年付、退款、Skill、V3、付费与 Cron/对账项，无可复现 P0/P1，才可报告 M3 完成。旧任务已合并、本批格式/加载测试通过或规格已同步均不能替代该出口。任何受保护外部验证需另获授权；M3 完成后仍由 Owner 选择后续任务，绝不自动启动 REL-1。

---

## 8. Go / No-Go（任何 FAIL → DO_NOT_OPEN + KEEP_MAINTENANCE；deadline 不覆盖）

- **G0 授权与分支（恢复自 R2）**：main/staging refs 已收敛且与 release packet 一致；AGENTS.md 与 DEVELOPMENT_POLICY 绑定有效（含 GOV-1 已合并）；本次 release 有明确 Owner 授权；`git log origin/main..origin/staging` 无未预期第三方提交；无 dirty/ambiguous worktree 参与本次 release。
- **G1 仓库**：frozen install；audit high=0；test:api+精选 Web 测试；lint/typecheck/build；exact staging SHA 部署。
- **G2 数据**：迁移全应用；无重复 period key；余额=账本恒等；`0≤consumed≤granted` 全表成立；**`launch_baseline_at` 已设置、已读回确认、已冻结**（§9 第 9 步留证）；**baseline 之后**无 paid-unfulfilled、无重复发放；baseline 之前的历史遗留已列清单并由 Owner 裁决。
- **G3 安全**：SEC-1 复验查询（§4）在**生产**返回空集；service role 有效且无 anon 降级；邮箱 gate 生效；泄露密码保护开启；**Supabase 生产 hCaptcha 强制已开（§9 第 8b 步）且实测"缺失/伪造 token 注册被拒"**；限流开启；无 secret 输出。
- **G4 产品**：**生产库**中 ≥1 个 Owner 批准的 published Skill；**生产库**中 ≥1 个 active 且 bound 的模块；8 个旧模块按 id 逐行确认 inactive；**active 且 unbound 的模块数=0**；生产真实 AI 冒烟通过；Skill 故障不扣费。
- **G5 付费全周期**：月/年/积分包、取消、退款、年付首期、未来终止、对账、#276、目录=Stripe 一致；**积分包卡+支付宝两种方式各走通**；D11 边界（仅银联单币卡且不用支付宝者买不了会员但可买积分包）已知并接受，不算 FAIL。
- **G6 商业**：条款上线；support 实测收件；SOP 就位；税务已落字。
- **G7 基础设施**：① Vercel Pro **且生产 cron 有成功状态的执行记录**（`scheduled_job_runs`/日志中 release 与 reconcile 为 success，非 401/503/error）；② Supabase 付费+PITR 开启且已留快照；③ **SMTP 证明为自定义服务**（Supabase Auth 设置显示自定义 SMTP host + Resend 后台可见该封投递记录）**且**新邮箱实测收到验证邮件；④ 四控制台 MFA；⑤ 模型供应商余额/额度足够并已配置低余额告警；⑥ **（v9 修正 F5-hCaptcha）hCaptcha 从大陆网络实测可加载并完成挑战**——用火山引擎（或任一大陆不翻墙）环境实际打开注册页、hCaptcha 挑战正常渲染并能通过、注册成功。**这是硬门不是可选**：D12 的 hCaptcha 是核心盘邮箱注册/密码登录的唯一人机验证，若大陆加载不了则核心盘注册+登录全部失效，而 G3 的"缺失/伪造 token 被拒"无法发现这种"根本加载不出来"的故障。**未过则 DO_NOT_OPEN**（回退方案：换 Cloudflare Turnstile 重测，或临时降级人机验证策略——属单独 Owner 决策）。
- **G8 生产 canary（Owner 执行）**：live 积分包（**卡 + 支付宝各一笔，验 `checkout.session.completed(paid)` 履约恰好一次**）、live 月付（大陆双币卡）、live 年付（只验第 1 期）、正常取消、Owner 退款（验当期精确扣回+未来停发；**支付宝那笔退款验 `refund.updated` 异步对账成立**）均通过；**canary 结束后手动触发一次覆盖当日窗口的对账**（不能只看昨日窗口的定时结果）且无 mismatch。

---

## 9. 生产 rollout 顺序（M4；每步独立 Owner gate，顺序唯一，不得调换）

> **v6 关键修正：schema 先于 runtime。** v5 把 REL-1 合并排在迁移之前，而 `vercel.json` 的 `git.deploymentEnabled.main=true` 意味着**合并即自动部署生产**——新代码会在 `skills` 表、`consumed_amount` 列存在之前上线，cron 与 webhook 会立刻打到缺失对象上。且实测 `maintenance_mode` 只覆盖 tRPC / upload / ai-stream 三条路径，**不阻断 cron 与 Stripe webhook**。因此迁移、env、baseline 必须全部先于合并完成。
>
> **本窗口的风险边界（须在执行前确认仍成立）**：EXT-0 记录生产 active 订阅=0、站点未公开，故窗口内不应有真实付费流量；Stripe 对失败 webhook 有自动重试（数天）。**若未来在已有真实用户时重复本流程，必须先补 cron/webhook 的 release-freeze 开关，否则本序列不成立。**
>
> **v7 修正 F6：迁移必须向后兼容（expand-only）。** 第 5 步应用迁移后、第 7 步新 runtime 生效前，**旧 runtime 仍是生产在跑的代码**（且 cron/webhook 不受 maintenance 阻断，会以旧代码打新库）；第 7 步合并部署之后若需回滚 Vercel 部署，又会变成"旧代码 + 新库"。因此本批次所有迁移必须是 **expand 阶段**：只加列/加表/加函数、或以 `CREATE OR REPLACE` 保持既有函数**签名与返回结构不变**；**禁止**在本批次删列、改列类型、改既有 `atomic_*` 函数签名或调用前提。收缩（contract，如删旧列）留到上线稳定后单独批次。<br>**验证证据（REL-1 合并前必备）**：把**当前 main runtime 的 `pnpm test:api`** 跑在**已应用新迁移的 staging 库**上并全绿——这证明旧代码对新库向后兼容，回滚与窗口期都安全。

1. **付费项就位**：B-1 Vercel Pro（已过 ≥24h 观察窗）/ B-2 Supabase 付费+PITR / B-3 SMTP 实测通过。
2. **开启 `maintenance_mode=true`**（覆盖用户可见路径；已知不覆盖 cron/webhook，见上方风险边界）。
3. **生产 env 核对与补齐**（清单，缺一即停并补齐后重来）：`SUPABASE_SERVICE_ROLE_KEY`、`CRON_SECRET`、`STRIPE_SECRET_KEY(live)`、`STRIPE_WEBHOOK_SECRET`、`NEXT_PUBLIC_APP_URL`、Upstash 连接串、`RATE_LIMIT_FAIL_CLOSED`、provider keys、Sentry env/release、**hCaptcha sitekey（前端 env）**、`alipay_subscription_enabled`（默认 false）。只报告 presence/scope，不输出值。（**hCaptcha secret 配在 Supabase Auth 设置里、不是 Vercel env**；其"强制开关"在第 8 步冒烟通过后才开，见第 8b 步。）
4. **留生产快照**（依赖 B-2）。
5. **应用全部待应用迁移**（SLOT-1…SLOT-6 按槽位号升序，SEC-1 的 grants 迁移**包含在内、后续不再单独重复执行**）。**前置证据**：上方 F6 的"旧 runtime × 新库"向后兼容测试已在 staging 全绿。
6. **SEC-1 复验**：跑 §4 的 `regprocedure` 查询，生产返回空集；否则停止。
7. **合并 REL-1 → 生产自动部署**。合并后：确认生产部署使用的 commit SHA = release SHA；若第 3 步之后发生过任何 env 变更，**必须手动触发一次 redeploy 并确认新部署已生效**（Vercel 环境变量对已存在的部署不生效）。
8. **部署后冒烟（CAPTCHA 强制\*仍未开\*）**：登录、聊天一轮（走 pre-deduct/finalize）、套餐页渲染，均正常——**确认新 runtime（含 hCaptcha 前端接入）已实际接管生产**。
8b. **开启 Supabase 生产 CAPTCHA 强制（D12 时序，v8）**：确认第 8 步的新 runtime（前端已传 `captchaToken`）生效后，才在 Supabase 生产 Auth 设置里打开 hCaptcha 强制 → 立刻用真实邮箱注册一次验证"带 captcha 能过、伪造/缺失被拒"。**顺序不可颠倒**：开关早于前端接入会立即打断所有邮箱注册/登录。
9. **设置并冻结 `launch_baseline_at`（F5：新 runtime 生效之后）**：设为本步骤执行时刻 → **读回确认非空且等于预期值** → 记录到 rollout packet，此后不得再改（如需修改属单独 Owner gate）。<br>**为何在此**：baseline 必须晚于"新 runtime 生效"（第 7 步合并部署）——否则第 5–7 步窗口内旧 runtime 经 cron/webhook 产生的、按旧语义记账的行会被划入"baseline 之后"，污染新语义观测层并可能误报 G2。移到此处后，baseline 干净地把"旧世界（含建库窗口）"与"canary 起的新世界"分开；第 8 步冒烟属 Owner 自测流量，落在 baseline 之前（历史侧），符合预期。
10. **创建生产 Skill 与模块**：在生产 admin（`graylum.com/admin`；**操作前先确认所连数据库 ref = `fhmshnqjjnnlvplojktv`**）创建并发布 Owner 批准的 Skill → 新建模块并绑定 → 保持 inactive → admin 冒烟 → 置为 active。
11. **D9 停用 8 个旧模块**，按 id 逐行复验（§4-C）。
12. **G4 复验**：`active 且 bound 的模块数 ≥1` 且 `active 且 unbound 的模块数 =0`。
13. **Stripe live 核对**：商品/价格/webhook endpoint 与 secret/Customer Portal 配置逐项；**live 模式已启用 alipay 支付方式**；**live webhook 事件订阅须含 `checkout.session.completed`（支付宝履约主路径）、`refund.updated`/`refund.failed`（支付宝异步退款）**，async_payment_* 若已订阅保留但非必需（v9 F5 更正）。
14. **验 cron**：等待或触发一轮，确认 release 与 reconcile 均为 **success 状态**（非 401/503/error）。
15. **G8 canary** → **手动触发一次覆盖当日窗口的对账**（不能只看昨日窗口的定时结果）→ 无 mismatch。
16. **maintenance off** → 公开注册 + 付费 CTA → 6–12h hypercare（订单/履约/计数/退款/Skill/5xx/cron/webhook）。

---

## 10. 回滚 / Kill Switch

顺序：`maintenance_mode=true` → 下架 plans/packages → 停用 modules → 停公开注册 → Vercel rollback → 关 Checkout 入口 → Stripe 端下架价格 → **轮换 webhook secret（必须三步一起：Stripe 生成新 secret → 更新 Vercel `STRIPE_WEBHOOK_SECRET` → 重新部署并验证一次 webhook 签名通过；否则会把事故扩大为全量 webhook 失败）** → operator review → 手工退款。

数据库 forward-only；不以恢复公开 RPC 权限做回滚；Skill 问题发新版本不降版本号；生产数据操作前必有快照。

立即关站条件：金额不匹配；已付未履约；重复发放；余额账本不一致或任何负余额；server-only RPC 暴露；service key/cron secret 缺失；Skill 串模块或 draft 泄漏；退款误扣其他来源；年付重复发放；Checkout/5xx 连续超阈值。

---

## 11. 汇报模板

```
任务：<名称>  分支/PR：<链接>  base=staging
改动文件：<清单>
验收命令与结果：<逐条命令 + 绿灯输出摘要>
Evaluator 结论：PASS | FAIL | BLOCKED（scope 检查：符合/越界；forbidden-action：无/有）
Release Auditor 结论（如适用）：PASS | FAIL | BLOCKED
DB/外部副作用：<无 或 列明>   secret 输出：无
需要的 Owner gate：<合并 / promotion / 生产应用 / 无>
唯一下一步：<一句话>
```

## 12. Owner 授权模板

```
授权 <任务名>：允许你从 origin/staging 创建分支 <分支名>；
仅可修改：<任务卡 allowed_paths>；
允许动作：创建分支、编辑、提交、push 非保护分支、开 PR（base=staging）；
禁止：合并、直接 push main/staging、任何数据库/Stripe/Vercel/生产/环境变量操作；
本授权仅限本任务本会话。
```

R0-A 历史示例（**已完成，禁止重用为当前授权**）：
```
授权 R0-A：允许你从 origin/staging 创建分支 codex/r0a-main-backmerge；仅可修改：合并 origin/main 引入的文件、package.json、pnpm-lock.yaml；允许动作：branch/edit/commit/push 非保护分支/开 PR，base=staging；禁止：合并、直接 push main/staging、任何 DB/Stripe/Vercel/生产操作。本授权仅限本任务本会话。
```

> **STG-FIX 注意**：不得照抄 R0-A 示例。STG-FIX 属 database schema / migration 高风险任务，开工时必须以 fresh live `AGENTS.md` 和 canonical Sprint Contract 为准；迁移编号、exact allowed path、required validation、services 与 Owner gate 都要当次解析，本文不预先产生授权。

## 13. 历史下一动作快照（2026-08-16；当前选择见文首）

```text
状态（2026-08-16，fresh GitHub live）：
✅ R0-A：PR #309 merged
✅ GOV-1：PR #310 merged；当前 High-Risk Gate 三态语义已生效
✅ R0-B：Issue #311 closed/completed；PR #312 staging→main merged；PR #313 main→staging history sync merged
   current main    = ecf4c6a347038f9352477a98d4171a8ef00c85de
   current staging = c39311bca4ab44769d5cd2cf3d0e3f8046fb0938
   main/staging tree = f1a6bb44d456666984e7295328843283413afeaa
   compare main...staging = ahead 1 / behind 0 / changed files 0（仅 #313 history sync）

⏭ 计划层唯一下一任务：STG-FIX
   当前含义：NEXT_PLANNED_TASK / NOT_AUTHORIZED_YET
   必须先 fresh-read live authority → 建立 canonical high-risk task contract → 获得 STG-FIX 精确 Owner 授权，才可执行 mutation。

独立 bug lane：
ADMIN_MODEL_API_KEY_SAVE_FAILURE = SEPARATE_BUG_TASK
- 后续单独处理；
- 当前不并入 STG-FIX / SEC-1 / AUTH-1；
- R0-B 未做 root-cause 或修复；
- 不占当前迁移槽。

OWNER 当前动作：
① 若决定开始 STG-FIX：只对 STG-FIX 单独启动新的 high-risk task/gate 流程；本文不是授权。
② 继续补齐 Owner 线剩余项：税务落字、（可选）DMARC；AUTH-1 开工前准备 hCaptcha，但强制开关仍按 AUTH-1 时序纪律执行。
③ 付费基础设施按 §4-B / §9 的最晚时点执行，不因 R0-B 已完成而提前越过后续 gate。

关键路径：R0-A✅ → GOV-1✅ → R0-B✅ → STG-FIX → SEC-1 → AUTH-1 → YEAR-1 → REFUND-1B → BILL-1
产品 lane（依赖满足后并行）：SKILL-1A → SKILL-1B、PAY-1、CI-1
独立 bug lane：ADMIN_MODEL_API_KEY_SAVE_FAILURE（later / separate task）
```
---

## 14. v4 → v5 变更记录（对应 Codex 交叉审计 23 条，全部经独立核验）

**事实错误（4）**：① 治理冲突 → 新增 D10 + GOV-1 任务，§3 重定义两道 PASS。② 迁移顺序矛盾 → §9 改为唯一 12 步序列，SEC-1 迁移**包含在**统一迁移步骤内、不单独重复执行；env 核对位置在 §6/§9 统一为第 2 步。③ R0 边界 → 禁令从"R0-A 合并前"改为"R0-B 合并前"，R0-B 补任务卡。④ "0027–0034 从未应用到生产"表述错误 → §2 更正为"已应用，推定被改签名重置"，并标注**根因待 SEC-1 验证**。

**遗漏（9）**：⑤ 生产 Skill/模块创建 → §9 第 6 步 + G4 改为查生产库。⑥ REFUND-1B 超用竞态 → 任务卡第 3 条 + 验收例 + §7 矩阵（已用 `0023:98,105` 验证现有行为确实无差别扣减）。⑦ 两次 promotion 无任务卡 → 新增 R0-B、REL-1 任务卡（六项证据）。⑧ staging 缺失对象 → 新增 STG-FIX 任务（独占 SLOT-2）。⑨ CAPTCHA 无人认领 → 并入 AUTH-1（前端接入）+ C-A 组（后台开关）。⑩ ENV-1 → §9 第 2 步给出完整环境变量清单与"缺一即停"规则。⑪ Gate 0 → 恢复为 G0。⑫ db:push 无机器防护 → 并入 CI-1（迁移账本一致性检查 + 禁 CI 执行）。⑬ OAuth 无验收 → §1 明写两条注册路径，AUTH-1 加 OAuth 保障与测试。

**风险（10）**：⑭ D9 复验太弱 → 改为按 id 逐行 + 确认所连数据库。⑮ active+unbound 可回退 → D7 明确"active+unbound 即故障"，SKILL-1B 验收与 G4 增加该项。⑯ G8 对账窗口错位 → canary 后手动触发覆盖当日窗口的对账。⑰ SEC-1 验收不足 → 改为白名单式空集查询，覆盖 anon 与 authenticated 全集，`purge_deleted_records`/`cleanup_*`/`atomic_*` 禁入白名单。⑱ SMTP 验收可蒙混 → G7 要求证明自定义 SMTP（设置页 + Resend 投递记录）。⑲ G7 cron 只要记录 → 改为要求 success 状态。⑳ webhook secret 轮换 → §10 改为三步绑定（生成→更新 Vercel→重新部署验证）。㉑ `launch_baseline_at` 缺失 → BILL-1 恢复 baseline 分层，G2 相应改写。㉒ checkout 限流 → 并入 PAY-1。㉓ provider 余额告警 → 并入 G7。

**口味（3，采纳其判断）**：credit_lots 相关物件确实可弃，不补回；EXT-0/SEC-0/INT-1/FULL_PAID_E2E 任务名无需恢复；stale refresh token、Skill 十轮稳定性、billing document 三项测试后置为 backlog，不阻塞 §1 闭环。

**工期影响**：AUTH-1 +1 天（OAuth+CAPTCHA）、REFUND-1B +1 天（超用竞态）、BILL-1 +0.5 天（baseline）、PAY-1 +0.5 天（限流）、CI-1 +0.5 天（迁移检查），新增 GOV-1 0.5 天、STG-FIX 0.5–1 天、R0-B/REL-1 各 0.5 天。合计约 +5–6 个工作日，已吸收进 §6（M0 延长、M2/M3/M4 各后移，Buffer 由 3 天压到 2 天）。**30 天仍成立但余量更薄；45 天承诺不变。**

---

## 15. v5 → v6 变更记录（对应第 2 轮交叉审计 10 条，全部经独立核验成立）

**事实错误（4）**
1. `[承接#1][P0] D10 自锁` —— **确认成立**。R0-B 是 staging→main 的 production release，按 AGENTS.md §High-Risk Gate 属高风险，而 v5 把它排在 GOV-1 之前，与 D10"GOV-1 合并前不得启动高风险任务"直接冲突。**修正**：执行顺序改为 **R0-A → GOV-1 → R0-B → STG-FIX**；D10 显式列出两项豁免（R0-A 入 staging 的依赖 backmerge、GOV-1 自身的文档变更均不在高风险清单），并声明 R0-B/REL-1 必须后置。§6、§13 同步。
2. `[承接#2][P0] 槽位与执行顺序反向` —— **确认成立**。STG-FIX 在 M0 执行却分到 SLOT-2、SEC-1 在 M1 执行却分到 SLOT-1，与"合并顺序不得变更"互斥。**修正**：**SLOT-1=STG-FIX、SLOT-2=SEC-1**，其余不变；新增不变量"执行/合并顺序 = 槽位号升序"。
3. `[承接#12][P0] CI 迁移编号检查必然失败` —— **确认成立**（实测：`0018_payment_fulfillment_atomicity.sql` 与 `0018_rls_text_flags_and_job_runs.sql` 并存，且已应用不得编辑；0001–0047 无缺号）。**修正**：CI-1 明确 historical allowlist 豁免这组 0018，仅对编号 >0047 的新迁移强制无重复；连续性只校验新增段。并加验收"现状仓库必须通过、新增重复必须失败"。
4. `[新][P1] 任务卡缺 allowed_paths 与停止条件` —— **确认成立**（实测 14 张卡中 9 张无 `allowed_paths`）。**修正**：为 R0-A、R0-B、YEAR-1、BILL-1、SKILL-1A、SKILL-1B、PAY-1、CI-1、REL-1 全部补齐 `allowed_paths`；§4 新增"全局禁止动作 + 7 条全局停止条件"，构成 GOV-1 所定义的 sprint contract 组成部分，无需逐卡重复。

**遗漏（0）**：本轮无新增遗漏。

**风险（6）**
5. `[承接#7+#10][P0] runtime 先于 schema 上线` —— **确认成立**（`vercel.json` main 自动部署；实测 `maintenance_mode` 只覆盖 tRPC/upload/ai-stream，**不阻断 cron 与 webhook**）。**修正**：§9 重排为 16 步，**REL-1 合并降为第 8 步**，位于 maintenance→env→快照→迁移→SEC-1 复验→baseline 之后；新增"env 变更后必须手动 redeploy 并确认生效"；新增部署后冒烟步；显式写出本窗口风险边界（生产 active 订阅=0、站点未公开、Stripe 自动重试）与"未来有真实用户时必须先补 cron/webhook release-freeze"的前提声明。
6. `[承接#6][P0] 超用竞态验收不覆盖真并发` —— **确认成立**（v5 的"若已 reversed 则不补扣"是读后判断，存在 TOCTOU）。**修正**：REFUND-1B 新增第 3b 条**并发屏障**——退款 clawback 与 AI finalize/abort 统一锁序（先 `SELECT … FOR UPDATE` 锁 grant 行，再锁 profile 行），状态与计数的读写全部在锁内；验收拆为**顺序型 + 交错型**两个用例，交错型必须真实制造双事务交错，不接受顺序调用模拟。
7. `[承接#17][P1] 白名单按函数名排除` —— **确认成立**。**修正**：SEC-1 验收查询改为按 `p.oid::regprocedure` 完整签名排除，白名单须逐条写完整签名；并明确 `atomic_*`/`cleanup_*`/`purge_deleted_records` 的**任何 overload** 均不得入白名单。
8. `[承接#21][P1] baseline 未设置/未冻结` —— **确认成立**。**修正**：§9 新增第 7 步（设置 → 读回确认 → 冻结并记入 rollout packet，时点定在迁移之后、canary 之前）；BILL-1 验收新增"baseline 为空或不可解析时对账 fail-closed 返回 BLOCKED"；G2 增列该项。
9. `[承接#8][P1] STG-FIX no-op 证明不足` —— **确认成立**。**修正**：验收从"存在性"升级为**两环境结构指纹比对**（函数 `pg_get_functiondef` 哈希、表列定义哈希、`pg_policies` 哈希、grants 哈希），任一不等即停止上报，不得自行改写生产端定义。
10. `[承接#12][P1] db:push 防护可空过` —— **确认成立**（CI 本就不执行 db:push，移除等于没做）。**修正**：CI-1 要求改造 `package.json` 脚本本身，缺显式确认参数即非零退出；验收须贴出"不带确认参数执行 → 退出码非零且未连任何数据库"的输出。

**口味（0）**：本轮无。

**工期影响（v6）**：STG-FIX +0.5 天（结构比对）、CI-1 +0.5 天（脚本改造与 allowlist）、REFUND-1B 并发屏障计入原 5–7 天区间上沿。合计约 +1 天，仍在 §6 的 Buffer 内吸收。

> 注：§14/§15 的步骤号引用（如"REL-1 降为第 8 步"）记录的是**当时 v6 的状态**；v7 因 F5/F6 再次重排，REL-1 合并=第 7 步、baseline=第 9 步，以 §9 正文为准。

---

## 16. v6 → v7 变更记录（对应第 3 轮交叉审计 8 条，全部经独立核验成立）

**事实错误（2）**
1. `[承接#4][P0] 全局停止条件 7 会自锁` —— **确认成立**。原条款"live state 与文档快照不一致即停"会因 R0-A 自身改变 staging SHA 而触发下一任务 fail-closed。**修正**：§4 停止条件 7 改为与**动态基线**（计划快照 + 已合并任务的预期效果）比对，只有**未预期漂移**才停止；预期的 SHA/迁移号推进不触发。
2. `[承接#2][P1] 槽位不变量与产品 lane 并行冲突` —— **确认成立**。原"执行/合并顺序=槽位升序"会强制 SKILL-1A(SLOT-6) 等钱路全部执行完，与产品 lane 并行矛盾。**修正**：§5 不变量改为**只约束迁移 PR 的合并/落库顺序，不约束开发顺序**；不同 lane 可并行开发，SLOT-6 迁移最后合并即可。

**遗漏（0）**：本轮无。

**风险（6）**
3. `[承接#6][P0] 预扣未绑定固定周期` —— **确认成立**（跨周期延迟退款场景，v6 按 `now` 定位会少扣 50、错误留存）。**修正**：REFUND-1B 第 2 条——预扣时把 `chargedGrantId/chargedPeriodKey` 写入 `billing_history.metadata`；第 3 条——settle/finalize/abort 复用该绑定，即使已跨周期也在原周期上返还/追加。新增"跨周期少用"验收用例（第1期 600→550、扣 450、余额 0）。
4. `[承接#6 附] pre_deduct 锁序死锁` —— **确认成立并纠正 v6 的错误**（实测 `0003`/`0014`：现有 pre_deduct/settle/finalize/abort **一律先锁 profiles**；v6 却规定退款走 grant→profile，方向相反=死锁）。**修正**：REFUND-1B 第 6 条统一锁序为 **profile→grant**（与存量代码一致），所有触及同一订阅的路径同序，状态判断在持锁下重读。交错型验收用例保留。
5. `[承接#9][P1] 结构指纹会假阴性` —— **确认成立**。**修正**：STG-FIX 指纹扩展——函数加 owner+`proacl`；表加 `relrowsecurity/relforcerowsecurity`+约束+索引+触发器；策略加 roles+permissive。防"列相同但 RLS 关闭/角色不同"漏过。
6. `[承接#8][P1] baseline 时点仍在旧 runtime 窗口内` —— **确认成立**。**修正**：§9 把 baseline 从"迁移后（旧 runtime 仍在跑）"移到**第 9 步**（新 runtime 生效+冒烟之后），干净分隔旧/新世界；REL-1 合并相应成为第 7 步。
7. `[承接#5][P1] 十六步缺 expand/contract 兼容门` —— **确认成立**（迁移后~部署前旧 runtime 打新库；回滚后旧代码对新库）。**修正**：§5 新增"上线批次 expand-only"规则（禁删列/改列类型/改 `atomic_*` 签名）；§9 与 REL-1 增设前置证据"当前 main runtime 的 test:api 在已应用新迁移的 staging 上全绿"。
8. `[承接#10][P1] db:push 确认值不校验目标` —— **确认成立**（填 `DB_PUSH_CONFIRM=staging` 但 `DATABASE_URL` 指生产仍会推）。**修正**：CI-1 的 wrapper 从 `DATABASE_URL` 解析实际 ref，**只有确认值=实际 ref 才继续**；验收改为三态（无确认/不符/相符）。
9. `[新][P1] CAPTCHA 启用时序`（Codex 编号 F7）—— **确认成立**。⚠️ **本条 v7 的"应用层地域分流即可消解时序"结论已被 v8 D12/§18-F2 推翻**：应用层根本挡不住浏览器直连的注册端点，v8 改回 Supabase 原生 hCaptcha，F7 时序缺口**复活**并由 §9 第 8b 步（开关与前端接入配对、开关后置到冒烟通过）正式处置。此处保留作演进留痕。

**口味（0）**：本轮无。

**工期影响（v7）**：REFUND-1B 因 F3 周期绑定 + F3b 锁序纠正 +0.5~1 天（仍在原 5–7 天上沿附近）；其余为文档/验收强化，不增净工期。仍在 §6 Buffer 内。

**收敛趋势**：findings 23 → 10 → 8，逐轮下降；三轮共 41 条**全部经独立核验成立、0 误报**；且第 3 轮 8 条中 7 条落在 v6 新增/改写面（唯一例外 F7 是此前未被识别的时序），印证"发现集中在上一版新增面、稳定部分零发现"的规律。**残余风险高度集中在 REFUND-1B 一个任务**（本轮 2 个 P0 都在它身上）——该任务的剩余不确定性用"真实并发测试 + 实际代码评审"消除，比继续评审散文更有效。

---

## 17. 增补决策记录（2026-08-15，Owner 进展 + 大陆核心盘）——已并入正文

> 以下为 Owner 于 2026-08-15 在并行窗口提交的进展与决策，**已同步进本 v7 正文相应章节**（本节留作变更留痕）。**均为 Owner 自身决定与事实状态，未经交叉审计**——其中 AUTH-1 地域分流 CAPTCHA 与 PAY-1 支付宝为新代码面，建议纳入下一轮审计范围。

**已完成（Owner，2026-08-15）**：四控制台 MFA；Stripe 后台 Radar/3DS/Portal 收窄/收据；Resend 注册 + graylum.com 域名验证（Tokyo，DKIM/SPF 通过）；Supabase 自定义 SMTP 已配。→ §4 C-A 组已相应勾选；B-3 的 DNS 风险已提前消化，仅剩一次真实投递实测（G7）。

**R0-A 进度留痕**：本段记录的是 2026-08-15 当时状态（PR #309 已完成待合并）。**2026-08-16 live 状态已前进：PR #309 merged；其后 GOV-1 / R0-B 也均完成，详见 §13 与 §22。**

**D11 大陆支付（含 08-15 简化）**：大陆确认为核心付费盘。Owner 实测两条已跑通——**卡支付（大陆双币 Visa/Master）可续费会员** + **支付宝可付积分包**。故：会员=卡（含大陆双币卡），积分包=支付宝+卡。支付宝续费订阅（Checkout 原生不支持）降为可选增强、开关默认关、不 gating。**原"会员资格包"保底路径已删除**（卡订阅实测可用后不需要）→ PAY-1 回落到 3–3.5 天、取消 SLOT-7、无迁移。→ 已并入 §0 D11、PAY-1 任务卡、§5、C-A 第 8 项。

**CAPTCHA 改地域分流** ~~（v7 决策）~~ → **⚠️ 已被 v8 D12 推翻，见 §18 F2**：第 4 轮审计证实注册是浏览器直连 Supabase，应用层地域分流挡不住；改回 **Supabase 原生 hCaptcha 全体统一**，AUTH-1 回落 3–4 天，F7 时序纪律随之复活。本行保留仅作演进留痕，实际以 D12 / AUTH-1 / §9 第 8b 步为准。

**泄露密码保护**：移至 B-2（付费功能，随 Supabase 升级一并开启）。→ 已并入 C-A 第 2 项与 B-2。

**大陆访问"顺畅性" —— 已实测可用（08-15 关闭该风险）**：Owner 确认域名托管在**火山引擎**（字节云，国内可达），大陆不翻墙可正常打开，仅偶尔网速偏慢。→ 此前担心的"Vercel/Supabase 美东被墙"**不成立**；该项从架构级开放风险**降级为"已验证可用、性能可后续优化"，不再是上线阻断项**。剩余仅"偶尔慢"的体验优化（按需加国内 CDN/边缘缓存静态资源）列入上线后 backlog。
> 备注：数据库/AI 调用仍走生产 Supabase（us-east-1）与海外 provider，延迟客观存在；若上线后大陆用户反馈 AI 响应慢，再评估就近部署或缓存层——属体验优化，非阻断。

**工期净影响（08-15，v7 口径，已被 §18 更新）**：~~AUTH-1 +1 天（地域分流）~~ → v8 弃用地域分流后 AUTH-1 回落 3–4 天、净工期基本持平；PAY-1 积分包支付宝 +0.5 天。**以 §18 v8 口径为准**：30 天目标余量偏紧、45 天承诺稳。

---

## 18. v7 → v8 变更记录（对应第 4 轮交叉审计 5 条，全部经独立核验成立）

**事实错误（1）**
1. `[新-B][P1] 支付宝续费机制描述错误`（Codex F1）—— **确认成立**。Stripe 兼容矩阵：alipay 支持 payment 模式、**不支持 subscription 模式**，不能把 alipay 加进 subscription-mode checkout 的 `payment_method_types`。**修正**：PAY-1 第 3 条改为——`alipay_subscription_enabled` 仅占位、上线保持 false；支付宝续费真要做需独立设计（保存方式+off-session），非本次范围。

**遗漏（0）**：本轮无。

**风险（4）**
2. `[承接#7][P0][改错] 应用层 CAPTCHA 挡不住注册端点`（Codex F2）—— **确认成立并已用代码证实**：`login/page.tsx:128/181/222` 用公开 anon key **浏览器直连** `supabase.auth.signUp/signInWithPassword/signInWithOAuth`，不经 Graylum 服务端；攻击者直接打 Supabase 注册端点即绕过应用层 CAPTCHA。且 Supabase 原生 CAPTCHA **只支持 hCaptcha/Turnstile**（官方文档），极验/阿里云无法作原生开关。**Owner 决策=方案 A**：全体统一 Supabase 原生 hCaptcha（新增 D12）。→ AUTH-1 CAPTCHA 重写、C-A 第 2 项、§9 第 8b 步（强制开关配对时序）、G3、§7 全部改写；F7 时序纪律复活；地域分流废弃（连带消解 F4）。
3. `[承接#3][P0][不彻底] 预扣只绑周期未绑金额`（Codex F3）—— **确认成立**：v7 记了 `chargedGrantId/PeriodKey` 但没记本次预扣落在当期 vs 其他的**金额拆分**，跨来源少用返还仍会把差额错误从当期逆减（例：应还其他50、余额460，错算成扣当期→余额410）。**修正**：REFUND-1B 第 2 条预扣时记 `amountToPeriod/amountToOther`；第 3 条结算按**逆分配顺序**返还（先退其他、超出才逆减当期）；新增"跨来源少用"验收用例。
4. `[新-A][P1] 地域分流无可信信号`（Codex F4）—— **确认成立**，但**因 F2 采用方案 A（弃用地域分流）而整体消解**，不再单独修。
5. `[新-B][P1] 支付宝无端到端验收`（Codex F5）—— **确认成立**。**修正**：PAY-1 加"积分包支付宝 test-mode 端到端（发起→回跳→`async_payment_succeeded`→履约一次、异步 failed 不履约、退款对账对支付宝成立）"；§9 第 13 步核对 live webhook 含 async 事件、live 启用 alipay；§7、G5、G8 相应加支付宝专项。

**口味（0）**：本轮无。

**工期影响（v8）**：AUTH-1 由 4–5 天**回落 3–4 天**（单 provider，方案 A 反而省时）；REFUND-1B F3 金额拆分并入原区间；PAY-1 支付宝端到端 +0.5 天（计入 3–3.5）。**净工期基本持平甚至略省**；30 天目标余量偏紧、45 天稳。

**收敛趋势**：findings 23 → 10 → 8 → 5，逐轮下降；四轮共 46 条**全部经独立核验成立、0 误报**。本轮 5 条中 4 条落在 v7 新增/改写面（F1/F4/F5 是 D11 支付宝新面、F2 是 CAPTCHA 新面），1 条（F3）是上一轮修订的不彻底。**两个 P0（F2/F3）均已在 v8 消解**：F2 由架构决策 D12 根治，F3 由金额绑定补全。CAPTCHA 与支付宝这两个新代码面首次经审计后已收敛。

---

## 19. 手机号 + 短信验证码登录（Owner 2026-08-15 提出）——上线后 backlog，非 30 天范围

> Owner 表示"后续也想支持大陆手机号验证码登录"。经评估**不进本次 30 天上线范围**（引入短信服务商选型 + 大陆短信签名/模板报备审批周期，会显著扩大范围与工期）；但本计划的 CAPTCHA/auth 架构**已为其预留、将来可增量添加而不返工**。若 Owner 希望纳入本次上线，需明确提出并重排工期。

**为何天然兼容（不返工的依据）**：
- Supabase 手机 OTP（`signInWithOtp({phone})`）与邮箱注册**同为浏览器直连 Supabase**——D12 的原生 hCaptcha **一并覆盖**其机器人防护，无需额外架构。
- AUTH-1 已要求把 `captchaToken` 传参封装为公共函数，手机 OTP 复用同一机制。

**将来实现时需要决定/准备的（backlog 清单，非现在做）**：
1. **短信服务商**：Twilio（可发 +86，但大陆有发送方/模板限制、送达不稳、成本高）vs 大陆原生（阿里云短信/腾讯云短信，经 Supabase "Send SMS Hook" 接入）。
2. **大陆短信合规**：短信签名与模板需报备审核（阿里云/腾讯云），有 1–数日 lead time；可能涉及企业资质。
3. **短信滥用防护**：SMS pumping / toll fraud——hCaptcha 前置 + Supabase 短信频控 + 每号码/每 IP 限流。
4. **账号合并语义**：同一用户邮箱+手机+OAuth 的身份合并策略（避免一人多 profile 重复领开户积分）——与 AUTH-1 的开户幂等对齐。
5. **验收**：手机 OTP 注册恰好一次开户积分、不重复；短信频控生效；缺 captcha 被拒。

**结论**：本次上线不实现；AUTH-1 只做"不挡路 + 预留封装"。上线稳定后作为独立任务（约 3–5 天 + 短信报备等待）排期。

---

## 20. v8 → v9 变更记录（对应第 5 轮交叉审计 5 条，全部经独立核验成立）

**事实错误（2）**
1. `[承接#3][P0][不彻底] REFUND-1B 超用边界错误`（Codex）—— **确认成立并纠正 v8 第二次修 F3 的边界**。v8 把 `actual>reserved` 的追加封顶写成 `amountToPeriod`，但该金额预扣时已用满，导致超用被错误推给其他来源。**代码级复算**：当期 grant=1000/consumed=0/其他=500，预扣100→实耗150（超用50）→退款；正确应超用吃当期剩余额度（consumed=150、扣850、余额500），v8 规则误得450。**修正**：REFUND-1B 第 4 条改为"超用吃绑定周期\*当前剩余额度\* `credits_granted−consumed`，非 amountToPeriod 封顶"；新增"超用后退款→500"验收用例。**（少用/restore 方向的 amountToPeriod 上限仍正确，未动。）**
2. `[承接#5][P1][改错] 支付宝被误当作异步支付方式`（Codex）—— **确认成立，Stripe 文档实证**：Alipay 是 **customer-initiated（即时确认）**，正常流程在 `checkout.session.completed(paid)` 完成履约（与卡同一现有履约点），`async_payment_succeeded` **非必经**。v8 把 async 写成必需验收会让正常支付宝支付假失败。**修正**：PAY-1 履约挂 `completed`、async 仅防御性幂等处理；退款走 `refund.updated/failed`（支付宝退款异步，文档实证，现有 webhook 已覆盖）；§7/G8/§9-13 全部改。**连带**：Stripe 文档明确 "Alipay Not supported in Checkout subscription mode" → F1 钉死（见下）。

**遗漏（1）**
3. `[新-A][P1] AUTH-1 只覆盖登录页，漏 resend/找回密码入口`（Codex）—— **确认成立，代码实证** `verify-email/page.tsx:112` 的 `auth.resend()`。开启项目级 CAPTCHA 后 Supabase 对 `resend`/`resetPasswordForEmail` 也强制 captchaToken，AUTH-1 只接了登录页 `signUp`/`signInWithPassword` → 8b 步开关打开后用户收不到重发邮件、无法找回密码，而 AUTH-1 验收仍全绿。**修正**：AUTH-1 第⑥-a 条枚举全部 GoTrue 强制 captcha 入口逐一接入；验收逐入口各测一次；allowed_paths 加 verify-email 与找回密码组件。

**风险（1）**
4. `[新-A][P1] hCaptcha 大陆可加载假设未进硬门`（Codex）—— **确认成立**。v8 把"hCaptcha 大陆可加载"称为 D12 唯一假设却只做可选实测；G3 只验"缺失/伪造 token 被拒"、验不出"根本加载不出来"。若大陆加载失败，全部门禁仍可过，而核心盘邮箱注册+密码登录同时失效。**修正**：升为 **G7⑥ 硬门**（大陆网络实测 hCaptcha 渲染+通过+注册成功，未过 DO_NOT_OPEN，回退 Turnstile）；C-A 第 2 项与 §13 提示"尽早测"。

**事实错误補（併入#2）：`alipay_subscription_enabled` 语义**（Codex 承接#1 P1）—— Stripe 文档实证 subscription 模式不支持 alipay、recurring 仅 private preview → 置 true 不会自动得到可用续费通道。**修正**：PAY-1 第 3 条强化"仅占位、true 也不生效不报错"，D11/C-A 第 8 项同步更正"审批≠即可用、机制需单独任务"。

**口味（0）**：本轮无。

**工期影响（v9）**：全部为既有任务卡内的边界/验收/入口修正，**不新增任务、不增净工期**（AUTH-1 仍 3–4 天，多接 2 个 captcha 入口在区间内；REFUND-1B 超用修正是改逻辑分支非加范围；PAY-1 履约改挂 completed 反而更简单）。30 天目标余量偏紧、45 天稳。

**收敛趋势**：findings 23→10→8→5→5，第 5 轮持平未降。**Codex 自陈原因（与实情一致）**：不是稳定主体失守，而是 5 条全部落在 v8 新写/重写的 A/B/C 三面，唯一 P0 来自 F3 修法本身的新边界错误。**判断**：CAPTCHA 与支付宝这两个新面已连续两轮聚焦、本轮 P0 已消解且只剩这一个；F3 已第三次修正并加了覆盖超用/少用/跨来源/并发四类的验收用例。**建议**：v9 后停止散文评审、进入执行——REFUND-1B 的剩余把握用"实际代码 + 四类并发/边界测试"验，比继续评审散文更有效；若仍要审，只审 v9 这次改的 4 处，不重开主体。

---

## 21. v9 → v10 变更记录 + 审计收敛声明（第 6 轮，收尾轮）

**风险（1，唯一发现）**
1. `[承接#4][P1][不彻底] AUTH-1 仍漏 SecuritySettingsCard captcha 入口`（Codex）—— **确认成立，代码实证**：`apps/web/src/components/profile/SecuritySettingsCard.tsx:67`（`auth.resend()`）与 `:117`（改密码前 `auth.signInWithPassword()` 重认证）均无 `captchaToken`，v9 的 AUTH-1 枚举与 allowed_paths 未含此文件；§9 第 8b 步开关打开后，"安全页重发验证邮件"与"验证当前密码后改密码"会失败，而 v9 验收仍可全绿。**根因**：v9 用手列文件名枚举 captcha 入口，天然可能漏。**修正（v10）**：AUTH-1 ⑥-a 改为**用 grep 全库覆盖**（给出确切 grep 命令 + 审计时完整结果 5 处/3 文件），验收要求 PR 附 grep 当次输出并逐条对应；allowed_paths 加 `SecuritySettingsCard.tsx` 且允许 grep 新 surface 的任何文件。此后不会再有"漏某个 captcha 入口"的同类缺口。

**事实错误（0）/ 遗漏（0）/ 口味（0）**：本轮无。

**F3 计数器模型深水问题——经穷举四类确认自洽、未突破 D1（连续两轮悬置的问题，本轮定案）**
Codex 逐一走通四类且结果全部正确：(a) 纯少用 G1000/C0/其他500、预扣100实耗50→C=50、退950余500；(b) 纯超用实耗150→超用50进当期、C=150、扣850余500；(c) 超用但当期已满 G1000/C1000→150全落其他、扣0余350；(d) 跨来源少用 G1000/C990→返还其他50、C维持1000、扣0余460。**深水结论**：**"其他来源"不需要独立余额计数器**——其总余额就是 `profiles.credits` 中扣除"当期受保护剩余"后的聚合；`amountToOther` 只负责保存单次预扣的可逆分配事实（写在 billing_history.metadata，与现有 lotAllocations 思路一致）；D4 不要求把 opening/check-in/topup 等其他来源内部继续区分。**故 F3 修法在 D1 计数器模型内自洽闭合、没有突破 D1，也未发现可复现的后续退款错算场景。** 该问题正式关闭。

**审计收敛声明**
- 六轮 findings：23 → 10 → 8 → 5 → 5 → **1**；六轮共 **52 条全部经独立核验成立、0 误报**。
- 第 6 轮**无 P0**，唯一 1 条 P1 已核实并修入（且改为 grep 全覆盖，根除同类）。
- **审计双方一致判定收敛**：Codex 明确"同意继续散文评审边际收益已明显递减；REFUND-1B 剩余风险主要在事务实现、锁序、元数据写入及并发交错，必须由真实 SQL/RPC 代码 + 四类边界加双事务测试裁决，而非继续扩写方案"。本文件作者（独立核验方）判断一致。
- **决定**：**v10 为执行定稿，停止散文评审，进入执行。** REFUND-1B 的剩余把握转由代码测试兜底——§4/§7 已备好覆盖"少用/超用/超用溢出/跨来源/顺序并发/交错并发"六类的验收用例，编码时直接落为测试。若后续出现\*新事实\*（外部环境变化、Stripe/Supabase 行为与文档不符、EXT-0 未覆盖项暴露）再定点修订，不再做无差别整篇复审。

**历史执行路径提醒（2026-08-16 快照，已过时）**：R0-A ✅ → GOV-1 ✅ → R0-B ✅ → **STG-FIX（下一计划任务，未授权）** → SEC-1 → AUTH-1 → YEAR-1 → REFUND-1B → BILL-1；产品 lane 在依赖满足后并行 SKILL-1A→1B、PAY-1、CI-1。迁移槽仍按 §5 规则在每个任务开工时 fresh-read / 分配，**本进度刷新不重新写死当前最大迁移号**。`ADMIN_MODEL_API_KEY_SAVE_FAILURE` 走独立 bug lane，不夹带进上述任务。

---

## 22. v10 → v10.1 执行进度刷新（2026-08-16）

> 本节**不是第 7 轮架构审计**，也不重开 D1–D12。它只把 v10 的静态执行入口更新为 2026-08-16 fresh GitHub live 状态，并同步 GOV-1 已生效的 canonical 三态门禁。

### 22.1 历史 live baseline（2026-08-16）

```yaml
repository: Crnobog9527/GraylumAI_vercel
repository_id: 1133708061
default_branch: main
main_sha: ecf4c6a347038f9352477a98d4171a8ef00c85de
staging_sha: c39311bca4ab44769d5cd2cf3d0e3f8046fb0938
main_tree_sha: f1a6bb44d456666984e7295328843283413afeaa
staging_tree_sha: f1a6bb44d456666984e7295328843283413afeaa
compare_main_to_staging:
  status: ahead
  ahead_by: 1
  behind_by: 0
  changed_files: 0
  interpretation: HISTORY_ONLY_PR313_SYNC
accepted_g2_binding_comment: 5250992438
accepted_policy_blob: 16b8674e672f493e3c7f3c2d1df91b04dc781a99
authority_epoch: G2_MINIMAL_POLICY_EPOCH_1
```

### 22.2 已完成

- **R0-A ✅** — PR #309 merged to `staging`。
- **GOV-1 ✅** — PR #310 merged；canonical High-Risk Gate 已使用 `PASS | FAIL | BLOCKED`，仅 PASS 满足 gate。
- **R0-B ✅** — Phase 1 reconciliation 通过；PR #312 merged `staging → main`；PR #313 以 **0 repository file diff** 将 #312 merge history 同步回 `staging`；Issue #311 已 `closed/completed`。
- 当前 `main` 与 `staging` 的 tree SHA 相同，说明 R0-B closeout 后代码/文件内容已收敛；`staging` 的额外差异仅为 history-sync merge commit。

### 22.3 当时关键路径（历史）

```text
R0-A ✅
→ GOV-1 ✅
→ R0-B ✅
→ STG-FIX ⏭（NEXT_PLANNED_TASK / NOT_AUTHORIZED_YET）
→ SEC-1
→ AUTH-1
→ YEAR-1
→ REFUND-1B
→ BILL-1
```

R0-B 完成后，原先“R0-B 前不得进入功能/迁移”的冻结已解除；**但这不等于自动授权 STG-FIX 或任何后续任务。** STG-FIX 是 DB/migration 高风险任务，必须按 live `AGENTS.md` 重新取得 canonical task contract、机器验收条件与 exact Owner authorization。

### 22.4 `ADMIN_MODEL_API_KEY_SAVE_FAILURE` disposition

```yaml
bug_id: ADMIN_MODEL_API_KEY_SAVE_FAILURE
disposition: SEPARATE_BUG_TASK
r0b_root_cause_verified: false
r0b_fix_performed: false
bundle_into_stg_fix: false
bundle_into_sec1: false
bundle_into_auth1: false
migration_slot_reserved: false
```

该缺陷继续作为独立 bug task，后续单独调查、单独授权、单独验收。除非后续 fresh evidence 证明它成为上线关键路径 blocker，否则不允许为了“顺手修”扩大当前任务 scope。

### 22.5 本次刷新未改变的内容

- D1–D12 产品/技术决策不变；
- REFUND-1B 的计数器、锁序与六类边界验收不变；
- hCaptcha / 支付宝 / Skill / rollout / Go-No-Go 设计不变；
- 30 天冲刺 / 45 天承诺口径不变；
- v4→v10 的历史审计记录保留，不改写当时语境；
- 本文件仍是**计划，不是任何 mutation authority**。

---

Launch status: `STAGING_REF_CONDITIONAL_ACTIVE` (active only when this exact cutover content is present on the authoritative current `staging` ref; feature-branch/PR existence is not activation and this plan still does not authorize a task).
