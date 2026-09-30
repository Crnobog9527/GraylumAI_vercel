# MENTOR-BUDGET 实施方案（总控已审；容量预检阻断）

基于 staging `314fde20ec73be1e4f08cae50d10caaaa859334b`；风险 high。
总控审阅决定：[2026-09-30 审查评论](https://github.com/Crnobog9527/GraylumAI_vercel/pull/542#issuecomment-5910051123)。已接受下列修订；第一步容量预检复现超限，按 Owner 停止条件报告。尚未修改生产服务代码、数据库、配置或真实模型请求。

## 配置、冻结与管理 API

- 优先复用 `system_settings`：一个版本化的 `runtime_purpose_budgets` 配置，包含 `interactive`、`organize`、`report` 三种用途。报告只预留配置，不启用 B 的生成入口。
- interactive/report 保存 `inputBytes`、`maxOutputTokens`、`historyItems`；organize 只保存 `inputBytes`、`historyItems`，回答上限唯一来源仍为 `v3_summary_max_tokens`，get 标明来源，不复制一份可写值。回答长度单位是 token，不把 token 当字数。用途由服务端判定，不能由普通调用者提供预算。
- 不建表、不新增 RPC；复用管理员校验、service-role 设置写入和既有客户端禁止 DML 的权限。JSON 可序列化为设置字符串，兼容当前只接受标量的设置面板读取契约。
- 拟新增 `mentorBudget.get` / `mentorBudget.update` 管理接口（均使用 `adminProcedure`）。get 返回 schemaVersion、三用途配置、来源（legacy/configured）、有效限制和安全硬上限；update 接收完整三用途配置，严格拒绝未知字段、非整数、负数及越界值，保存后读回；同时仅在 settings.ts 现有按 key 校验函数增加一个 if 分支，拒绝通用设置接口写该 key；不碰 admin.ts，settings.test.ts 只追加用例。
- 新执行完成 replay 查找后再读取配置，并冻结用途及解析后的预算到既有 Runtime payload/BILL2 input；执行和恢复只读快照。旧快照继续按原规则解释。
- 初始无配置时完全沿用旧路径：OPC 输入 64000 bytes、历史 100；fixture 输出 1000；真实输出实际是 min(报价输出、模型输出、20000)，不是固定 1000；整理沿用现有 `v3_summary_max_tokens`（默认 2048）及原历史策略。get 明确展示继承来源，不自动落库或把所有真实输出改成 1000。
- 显式配置后统一联动模型容量、报价、安全硬上限及 MODEL-REASONING 校验；移除 admission/execute 中重复的 20000 输出截断，并统一 additionalInstructions 的 UTF-8 容量校验。保留原“先裁历史；必需内容装不下则拒绝”的处理。
- 建议系统硬上限：输入 1,000,000 bytes、输出 128,000 tokens、历史 1000 条；有效值仍不能越过模型和批准报价。执行 payload 现有 262144-byte 数据库限制单独检查，不能靠输入上限掩盖。具体边界须经本地既有表约束验证；若目标必须修改 SQL，停下报总控。

## 超时方案

- 函数 `maxDuration=300` 保持不变。拟将单次模型上限从 120s 放宽至 240s，工作截止从 255s 放宽至 265s，持久化截止保持 285s：保留 20s 结算/持久化、15s HTTP 收尾余量。
- 调用实际超时取 `min(240s, 剩余工作时间)`，而不是要求新调用必须还剩完整 240s；最低派发余量改为 60s，命名常量；剩余时间不足时不派发，避免人为制造未知结果和冻结预扣。该值必须覆盖取凭证、claim、真正发送和响应体读取；每次发送前重新核对截止，keepalive 不续期。
- 官方费用查询最多 45s，且不能越过请求剩余截止；不为了等回执挤占持久化余量。无足够时间时保留待恢复状态。
- 已派发超时仍为结果未知，不伪装为未发送、不自动重发、不重复扣费；未派发证明和现有原身份恢复机制保留。外部系统不可用时，只能保证请求有界退出并保留恢复语义，不能承诺每次都能在截止前成功写库。

## 预扣与止损（按总控决定，不改算法）

保留当前“选中报价的最大 upperUsd × maxCalls”预扣、call claim、冻结费用展示和供应商实际费用结算，不改 SQL 或账务契约。按实际发送内容估算留给 RUNTIME-PROD 第 ④ 项，不在本 PR 实现。

用途预算不得越过模型和批准报价；超过时沿用收窄或拒绝规则。`0108_runtime_staging_window.sql` 要求 run.callPolicy 与批准窗口条目完全一致，原报价保持不变。需要调整 staging 报价时，只在 PR 列出模型/线路、现有与建议输入/输出上界及成本影响，由总控另请 Owner 批准，本任务不写 staging 数据。

## 提示缓存：已知与待证

- 官方资料说明可以从 `usage.prompt_tokens_details.cached_tokens`、generation/Activity 费用看到缓存情况；DeepInfra 描述的是相同前缀的 KV 复用。这不能证明当前 `deepseek/deepseek-v4.1-flash` 的 `deepinfra/fp8` 路线已经命中或采用某个折扣。
- 本地 evidence 路径保留 SDK usage，并以响应 `usage.cost` / 官方查询 `total_cost` 结算；没有当前线路真实回执，命中率和实际优惠结论为 NOT_VERIFIED。
- 实施阶段检查 Skill 固定内容是否已在动态上下文之前；只有小幅调整且不改变指令/计费语义时才纳入。不得把缓存缺失记为零，不启用响应缓存或另建缓存系统。
- 来源：[OpenRouter 缓存文档](https://openrouter.ai/docs/guides/best-practices/prompt-caching)、[DeepInfra 前缀缓存说明](https://deepinfra.com/blog/token-verbosity)。

真实测试只提案、不执行：建议最多 6 次固定线路请求（3 次现有前缀、3 次稳定前缀；首个冷请求加两次不同后缀），使用合成内容，每次最多约 64KB 输入和 256 输出 tokens。按运行前批准报价计算冷缓存最坏总费用，建议申请总额不超过 US$0.20；报价算出的最坏值超过该额度则重新报批。当前尚未读取有效报价金额，不能把这个申请上限写成已核实预计花费。不开报告长输出实测、不自动补样；必须先在 PR 补全精确报价和预计费用，由总控请 Owner 批准后再跑。

## 验证和交付

1. 管理员保存读回；普通/匿名直调专用及通用 API、直写表被拒；非法和超范围值拒绝。直接表权限用本地数据库真实角色验证，不用 mock 冒充。
2. 配置变更仅作用新执行；旧执行、重复 requestId、断线恢复保持旧预算和原身份。
3. 默认路径回归；报价/模型/思考预算联动；裁历史与必需输入超限；长 Skill 资源边界；预扣/claim/费用展示一致。
4. 假时钟及可中断 transport 覆盖慢凭证、慢 claim、连续调用、流式 keepalive、响应体超时、结算与持久化超时、未知结果恢复与不重复扣费；整次请求有界收尾。
5. 运行相关单测、API/Web 类型和 lint、大小检查、BILL2/Runtime 本地集成及全部必需远程 CI/Security。真实 provider/Preview 验证另待额度授权，不能以模拟结果冒充。
6. CI 全绿后在 PR 报增量，交总控审；总控通过后才标 ready 并单独请求机器人复审。high 合并另待 Owner，不自行合并。

## 写入协调

- Owner 已允许本任务先于暂停的 #497 修改 Runtime/OPC/BILL2；不修改 #497 分支。
- #537 当前修改 SQL 的 runtime_start，与本方案 TS 范围不重叠；本任务不写 SQL。
- 总控已解决 #540 重叠安排：本任务只在 settings.ts 原有按 key 校验函数加一个 if，settings.test.ts 只新增用例，不碰 admin.ts；后续同步冲突由 #540 处理。
- 代码大小基线只手动更新本任务文件条目，不执行全量 update。后台页面另交 Claude。

## 第一实施步：payload 容量预检

约束来源：迁移 0106 的 `runtime_executions.payload` 和迁移 0105 的 `bill2_runs.payload` 均要求 `octet_length(payload::text) <= 262144`；未发现后续迁移放宽。输入检查衡量模型内容，SQL 衡量完整 JSONB 冻结记录，两者不能互相替代。

使用未修改的 `runtimeAdmissionService`、真实 Skill loader/context 筛选和合成 Skill/source；仅将数据库和身份查询替换为测试夹具，捕获 runtime_admit 的原参数。输入为现有 OPC 上限 8000 个中文字符，附属整理输入和额外指令均在现有限制内。将捕获的参数送入本任务独立、无网络的 PostgreSQL 17，以与迁移相同的 CHECK 逐条验证实际 JSONB 字节数；不是远端 staging 验证，也不是完整数据库集成。

| 合成资源字节数 | 准入输入计量（含余量） | Runtime JSONB | BILL2 JSONB | PostgreSQL CHECK |
| --- | ---: | ---: | ---: | --- |
| 46000 | 83739 | 146690 | 148026 | 两者通过 |
| 162000 | 199739 | 262690 | 264026 | 两者拒绝（check_violation） |

第二例通过 200000-byte 输入准入，却分别超过两个存储上限 546 / 1882 bytes。冻结载荷包含独立的 input、request.input 和 attachedOrganizer.input 等，不止一份当前轮输入。历史通常单独存储，并不表示所有 20 万字节的模型上下文都会超限。

**边界结论：FAIL（200000-byte 输入预算不能单独保证可冻结），不是 Skill 2.6.0 本体不可用的结论。** 46000-byte 样本只有合成资源，不是未发布 Skill 的完整内容；不能据此声称真实 Skill 已验收。复现测试见 `packages/api/src/services/runtime/mentorBudgetPayload.test.ts`。

按 Owner“装不下就停下报告”的指令，尚未继续预算/超时业务实现，也没有修改 SQL。此结果尚不能证明必须改 SQL：推荐最小路径是在 TS 准入前同时检查完整 Runtime 与 BILL2 冻结载荷，优先消除可安全去除的重复内容；不能安全容纳的组合在预扣前明确拒绝。不能只把模型输入限额一刀切减去本样本的 1882 bytes，也不能静默裁剪必要内容。若产品要求完整支持所有接近 200000 bytes 的合法组合，先评估 TS 去重与旧快照兼容是否足够，再决定是否必须另立 SQL 范围。将此具体结果交总控后再推进。

## Handoff

- Done：按总控四项决定与 P2 要求修订方案；完成首步容量预检并复现上述失败。最新远端 staging 为 `91a90e39410feba17bede03e83bddd2519b11be6`，新增 #536/#541；AGENTS 未变，已阅读 ENGINEERING 变化。任务分支保持原候选起点，未把他人改动混入。
- Next：总控处理已报告的容量边界后继续服务端实施。之后仍按 CI 全绿 → 报增量 → 总控审 → ready/机器人复审交付。
- Blockers：200000-byte 输入预算可产生超限冻结载荷；真实模型报价精确费用与额度尚未补齐/批准。
- Validation：两项合成准入容量测试 PASS（成功复现正/反边界）；PostgreSQL 17 约束测试 PASS（两项接受、两项按预期拒绝）；API 类型检查、该测试 ESLint、代码大小和 diff 检查 PASS；目标容量保证 FAIL。未执行产品全量回归、真实模型调用、远端数据库操作或最终语义审查；远程 CI 单独记录。
