# MENTOR-BUDGET 实施方案（待总控审阅）

基于 staging `314fde20ec73be1e4f08cae50d10caaaa859334b`；风险 high。
本提交只有方案，尚未修改服务端、数据库、配置或真实模型请求。

## 配置、冻结与管理 API

- 优先复用 `system_settings`：一个版本化的 `runtime_purpose_budgets` 配置，包含 `interactive`、`organize`、`report` 三种用途。报告只预留配置，不启用 B 的生成入口。
- 每用途保存 `inputBytes`、`maxOutputTokens`、`historyItems`；回答长度单位是 token，不把 token 当字数。用途由服务端判定，不能由普通调用者提供预算。
- 不建表、不新增 RPC；复用管理员校验、service-role 设置写入和既有客户端禁止 DML 的权限。JSON 可序列化为设置字符串，兼容当前只接受标量的设置面板读取契约。
- 拟新增 `mentorBudget.get` / `mentorBudget.update` 管理接口（均使用 `adminProcedure`）。get 返回 schemaVersion、三用途配置、来源（legacy/configured）、有效限制和安全硬上限；update 接收完整三用途配置，严格拒绝未知字段、非整数、负数及越界值，保存后读回；同时封堵通用设置接口对该 key 的绕过。
- 新执行完成 replay 查找后再读取配置，并冻结用途及解析后的预算到既有 Runtime payload/BILL2 input；执行和恢复只读快照。旧快照继续按原规则解释。
- 初始无配置时完全沿用旧路径：OPC 输入 64000 bytes、历史 100；fixture 输出 1000；真实输出实际是 min(报价输出、模型输出、20000)，不是固定 1000；整理沿用现有 `v3_summary_max_tokens`（默认 2048）及原历史策略。get 明确展示继承来源，不自动落库或把所有真实输出改成 1000。
- 显式配置后统一联动模型容量、报价、安全硬上限及 MODEL-REASONING 校验；移除 admission/execute 中重复的 20000 输出截断，并统一 additionalInstructions 的 UTF-8 容量校验。保留原“先裁历史；必需内容装不下则拒绝”的处理。
- 建议系统硬上限：输入 1,000,000 bytes、输出 128,000 tokens、历史 1000 条；有效值仍不能越过模型和批准报价。执行 payload 现有 262144-byte 数据库限制单独检查，不能靠输入上限掩盖。具体边界须经本地既有表约束验证；若目标必须修改 SQL，停下报总控。

## 超时方案

- 函数 `maxDuration=300` 保持不变。拟将单次模型上限从 120s 放宽至 240s，工作截止从 255s 放宽至 265s，持久化截止保持 285s：保留 20s 结算/持久化、15s HTTP 收尾余量。
- 调用实际超时取 `min(240s, 剩余工作时间)`，而不是要求新调用必须还剩完整 240s；保留 5s 最低派发余量。该值必须覆盖取凭证、claim、真正发送和响应体读取；每次发送前重新核对截止，keepalive 不续期。
- 官方费用查询最多 45s，且不能越过请求剩余截止；不为了等回执挤占持久化余量。无足够时间时保留待恢复状态。
- 已派发超时仍为结果未知，不伪装为未发送、不自动重发、不重复扣费；未派发证明和现有原身份恢复机制保留。外部系统不可用时，只能保证请求有界退出并保留恢复语义，不能承诺每次都能在截止前成功写库。

## 预扣与止损：需总控审阅的现状差异

当前 `admission.ts` 按选中报价的最大 upperUsd × maxCalls 预扣；`openRouterBound` 按整个 provider context 算成本安全上界。代码并非已经按实际发送长度预扣。

实现拟分清批准报价安全上界、实际发送内容的预扣估算和供应商实际结算：估算只统计最终发送的 instructions/history/tools/input，加输出预算及合理余量；不因缓存预期降低预扣；逐次 claim 不得越过已冻结运行单预算和报价，缺额时不发请求；费用展示复用该冻结估算，实际费用继续只取供应商证据。

关键约束：`0108_runtime_staging_window.sql` 要求 run.callPolicy 与批准窗口条目完全一致。因此不能在 TS 中随意改写该报价。拟保留原报价，在执行 payload 保存更窄的用途预算，并在现有允许更窄上限的 call claim 内使用；需先用本地 BILL2/Runtime 集成证明可行。若实现“按实际发送内容估算”必须改变 SQL 或账务契约，停止该部分并报总控，不绕过校验、不偷偷扩大范围。本方案不建设 RUNTIME-PROD 的完整日限额/告警系统。

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
- 新发现 #540 当前占用 `routers/settings.ts`、`settings.test.ts`、`admin.ts` 等；通用设置入口的 key 校验会碰到该写入面。推荐总控安排该小补丁的先后顺序；专用 router/service 可独立推进，但重叠文件在安排确认前不写。不能仅靠新建 worktree 宣称冲突消失。
- 代码大小基线只手动更新本任务文件条目，不执行全量 update。后台页面另交 Claude。

## Handoff

- Done：读取授权与最新 staging、AGENTS/ENGINEERING/Master Plan v12 §3/§7/AGENT-CORE；核验保护规则、相关 PR 和本地 worktree；完成上述源码只读核查。
- Next：总控审本方案，确认 #540 写入顺序及预扣差异处理后实施。
- Blockers：等待方案审阅；#540 重叠点待协调；真实缓存和实际账单无授权实测证据。
- Validation：本提交只有文档；尚未运行产品单测、集成、真实调用或独立最终审查。后续 CI 结果单独记录。
