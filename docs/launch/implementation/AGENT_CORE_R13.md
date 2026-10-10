# AGENT-CORE R13：方案 B 必测项对照

依据：Owner 已批准的 [收口清单](../AGENT_CORE_CLOSEOUT.md)（#771），以及
[AGENT-CORE 必测项](../tasks/AGENT-CORE.md#必测项清单来自-2026-09-27-codex-审查pr-448)。
R3 #779 的当前候选通过机器人复审后才开始 R13。本项从 staging 独立分支；风险 `ordinary`：
只新增自动测试及本对照，把新用例加入现有集成入口，不改业务、权限、账务规则或迁移。
不修改 #764/#766/#778 的文件；不合并、不发布、不使用浏览器或付费模型。

## 对照原则与证据

方案 B 在同一次执行里串行回复、整理；取消方案 A 的附属会话和页面二次发起整理机制，
没有取消数据保护、收尾、确认新鲜度或金额守恒要求。以下 `适用` 指验收义务仍存在；
`机制不适用` 只指 A 特有的结构。第 16/17 项明确记后续交付，不标不适用。

证据索引（路径相对仓库根目录）：

- **OPC**：`packages/api/src/services/opc/agentCorePlanB.integration.ts`，新增真实 SQL/RPC 并发、迟到写回及确认测试。
- **FIN**：`packages/api/src/services/bill2/agentCorePlanB.integration.ts`，新增 v1/v2 两套账务交错测试。
  v1 整单预扣一次；v2 按调用预扣，回复和整理同属一单、按累计名义成本取整，不能误称 v2 整单只预扣一次。
- **CAP**：`packages/api/src/services/opc/capture.integration.ts`，既有持久化写回、轮次、容量与确认关卡测试。
- **RUN**：`packages/api/src/services/runtime/runtime.integration.ts`；**STREAM**：同目录 `streaming.integration.ts`，
  既有本机模拟供应商、真实运行单、停止和恢复集成测试；同目录 `terminalReply.integration.ts`
  覆盖整理异常终态的持久化、取消重放和下一次 admission 解锁。
- **WAIT**：`packages/api/src/services/runtime/waitingOrganizer.test.ts`；**CTX**：`services/opc/captureContext.test.ts`。
- **UI**：`apps/web/src/hooks/use-step-confirmation.test.ts`、`components/opc/step-confirm-card.test.tsx`，
  以及 `app/positioning/[draftId]/` 下 `confirm-conflict`、`payg-wait-mentor`、`mentor-notices`、`mentor-turn`、
  `mentor-response` 的 `.test.ts`。这些是无浏览器的逻辑测试，不是视觉或真实页面验收。

| 项 | 方案 B 下适用性及保证 | 自动证据 / 交付边界 |
| --- | --- | --- |
| 1 会话执行锁 | 适用。A 的附属会话独立锁机制不适用；B 回复与整理保留主会话执行所有权，未收尾不能开下一轮。 | RUN admission/竞争；CAP `Q1` pending organizer 阻断新 admission；WAIT 原执行 cursor/epoch 恢复及 exhausted 取消。 |
| 2 同运行单计费 | 适用。整理沿用触发消息的 run；Fusion 同组记账仍是 Fusion 接口的义务，不在 R13 新实现 Fusion。 | RUN `AC-1 opc.mentorTurnStream` 回复/整理同单；FIN `R13.2/6` 两次微额成本累计仅扣 1 积分，重复 claim 不产生第二 dispatch token。v1/v2 分别断言其合法预扣次数。Fusion 实现由 R5/R14/FUSION-REVIEW 承接，不能据此宣称 Fusion 已验收。 |
| 3 人工编辑与整理并发 | 适用。旧上下文不能覆盖人工字段，也不能直接写未改字段。 | OPC `R13.3` 两个独立数据库连接正向观测锁等待；人工编辑先提交，旧整理的两个字段都只成建议；重复写回保持结果。 |
| 4 整理完成逆序 | 适用结果义务。B 正常执行串行，但历史/恢复写回仍可能迟到。 | OPC `R13.4-5` 新轮先回写、旧轮后到，新值保持；CAP whole-material CAS / execution ordering。 |
| 5 被跳过轮次不遗漏 | 适用。A 排队模型任务机制不适用；B 持久化完成记录逐条处理，跳过也保留可追踪回执。 | OPC `R13.4-5` 两个执行都有写回回执；CAP drains before new admission / pending backlog、长会话。 |
| 6 整理不重复派发 | 适用。整理占原 run 的一个调用序号；冲突只能读取原调用。 | FIN `R13.2/6` 真正并发的重复 claim 只有一个 token，只有一次实际 dispatch，终态拒绝额外调用；RUN 同单与重放。 |
| 7 跳过/失败/超时收尾 | 适用。未派发释放；已知费用结算释放余额；未知费用保留原身份和待核对状态，不能假定为零。 | FIN `R13.7/9/15` 未派发、已知费用取消、未知超时及迟到回执，重复收尾不变账；`R13.12` 已确认失败退款。RUN/STREAM/terminalReply 测实际 Runtime 停止/恢复/失败解锁。 |
| 8 上下文和预算上限 | 适用。A 异步模型队列批处理机制不适用；B admission 前有界消化已有写回，并保留输入、输出及调用预算边界。 | CAP backlog 6/21、有界处理、2000 请求容量；CTX 全材料/压缩上下文；RUN 预算和拒绝路径。不会为 R13 新建后台队列。 |
| 9 失败后确认有出口 | 适用。终态解除运行占用；未明账务或仍在运行不伪装成功。页面给出可恢复提示，不能永久假“整理中”。 | FIN `R13.7/9/15` 收尾、terminalReply 失败解锁；WAIT exhausted 原等待取消后才放行；UI terminal 释放 envelope、interrupted 无 spinner/重试提示、confirmation gate。真实页面体验未运行，归 R12a/R12b。 |
| 10 小结绑定当前笔记、只确认一次 | 适用。确认携带最新 version/reviewVersion；更新后的卡可以确认；同请求重放不得创建第二份确认。 | OPC `R13.10-11` 整理更新前的确认被明确版本错误拒绝，最新内容确认成功、同 request 重放仅一条 confirmation；CAP frozen confirmation gate；UI 卡片版本和 conflict 分类。 |
| 11 确认时复查轮次和版本 | 适用。服务端不能仅信旧卡；确认后整理只给建议。 | OPC `R13.10-11` 加 CAP `Q1`（未完成轮次阻断确认）、frozen confirmation gate；UI conflict 刷新；确认后正文、information、valid 保持。 |
| 12 退款与未结算整理 | 适用。退款后迟到费用不再向用户补扣，不能重复退。 | FIN `R13.12` refund 与 late receipt 真正重叠；v1/v2 均校验钱包等于流水、退款后余额恢复、重复 finalize 不变。v2 保留原毛收费和补偿凭证，不删账。 |
| 13 月度积分释放交错 | 适用。订阅月度释放可以发生在整理预扣与结算之间，不得丢积分或多扣。 | FIN `R13.13` 两种锁序；真实 test-mode 购买记录和 annual grant RPC、第二期释放与整理结算重叠，v1/v2 钱包与流水一致，重放不二次发放/扣费。仅本机虚拟订单，无 Stripe 请求。 |
| 14 直接文字提问 | 适用。未调提问工具时按普通回复，不能卡流程。 | RUN `AC-1 opc.mentorTurnStream` 固定普通文本导师回复及附属整理；UI mentor-response/mentor-turn 普通回复路径。无真实模型准确率结论。 |
| 15 页面未派发整理 | A 的“页面另发整理请求”机制不适用；B 同执行串行，由服务端管理未启动整理、deadline、停止和恢复，收尾退款义务仍适用。 | RUN/STREAM stop/recovery、WAIT exhausted cancel、FIN `R13.7/9/15` 未派发/超时只收已知费用。新收费操作需新用户请求；恢复仍沿用原身份，不新增定时器。页面关闭实测未运行。 |
| 16 同意、撤回、服务端过滤 | **适用，DEFERRED 到 R10**：默认不同意、撤回、团队读取时过滤；**案例视图 DEFERRED 到 LEARN-1**。 | 按 #771 Owner 决定。R13 不新增表/接口，不把未实现能力写成通过；既有 Skill 权限撤销测试不等价于数据使用同意测试。 |
| 17 去身份信息 | **适用，DEFERRED 到 LEARN-1，且是其上线前置条件**。 | 要验证案例视图及接口不能读到姓名、联系方式、账号/用户编号原文。R13 未实现、未运行这类验收，不以权限过滤替代去身份信息。 |

## 测试方法与限制

新增并发测试先由连接 A 持有业务行锁，再启动连接 B，通过 `pg_blocking_pids` 确认 B
实际等待 A，随后 A 完成业务 RPC 并提交，B 才继续；没有用两个顺序请求冒充并发。
OPC 固定模型结果仅通过本机 fixture 构造，admission、写回与确认走实际服务/RPC；
FIN 的费用证据和购买记录为固定样本，调用真实结算和积分释放函数。
不新增迁移或业务架构；权威仍是原 runtime/bill2/artifact 表及 RPC。

新用例已加入 `packages/db/tests/v3/without-app.mjs` 的现有 required CI 集成入口。
不改变原 5 个明确排除的浏览器/Next HTTP 用例，也不放宽失败或跳过的校验。
本机固定样本证明确定性的状态/金额规则，不证明真实模型效果、延迟或完整产品体验。

## 验证与交接

- PASS：新增集成 17/17（定向选择，其余 532 项未运行）；API 定向单元 24/24；
  Web 无浏览器逻辑 98/98；runner 校验 3/3；API typecheck、lint、code-size。
- 早期完整本机运行暴露新增夹具错误，已修正并定向复测；不将该次全套记录成通过。
  最终完整集成、远程必需检查和独立机器人结论，以 PR Handoff 的对应版本证据为准。
- NOT_RUN：浏览器、付费模型、真实 staging 产品体验、后台 Skill 发布；本 PR 不合并。
- DEFERRED：第 16 项 R10/LEARN-1；第 17 项 LEARN-1；Fusion 未交付接口及 R12a/R12b 产品验收。
- 下一步：远程完整集成、检查及审查；同范围修复后把实际计数及版本写 PR Handoff。
- 阻塞：当前没有共享文件或迁移需求；发现此类需求先在 PR 说明并交总控排顺序。

复现（全部从本任务 worktree 运行）：

```sh
# 完整既有入口；排除清单固定，不启动应用或浏览器
node packages/db/tests/v3/run-workbench.mjs --runtime-only --with-staging-schema --without-app --schema-from-files
# 定向 R13：只启动本机测试服务，正则不选择任何浏览器用例
node packages/db/tests/v3/run-workbench.mjs --runtime-only --with-staging-schema --schema-from-files '--case-pattern=^RUNTIME: (v[12] )?R13'
node --test scripts/tests/integration-without-app.test.mjs
```
