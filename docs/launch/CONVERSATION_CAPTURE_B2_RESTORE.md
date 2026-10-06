# B2 第二轮恢复与本阶段验收记录

## 决定与质量证据

2026-10-06 [决定记录](https://github.com/Crnobog9527/GraylumAI_vercel/pull/675#issuecomment-6013300627)：
采用第二轮版本，仅保留之后的 CI 修复。风险仍为 high；不访问远端数据库、不改配置、不合并。
不再付费评测，沿用第二轮 manifest `ee8f408ba6e34635216b3b8aefd977ad0c9af0d675a1060f2fba97b1cc181edd` 的实测。
第三轮结果保留为失败的历史证据，不作为恢复后行为证据。三轮实际费用合计$2.893925000，本次新增$0。

|指标|本阶段门槛|第二轮实测|结论|
|---|---|---|---|
|无依据事实|≤4/70（原0/70）|4/70|PASS，阶段放宽|
|整理语义写回正确|≥25/30（原27/30）|25/30|PASS，阶段放宽|
|C/D/E 不出卡|≥21/22|21/22|PASS|
|正文卡片不一致|0/70|0/70|PASS|
|原始格式错误|≤1/100|1/100|PASS|
|受保护字段直接更改|0/30|0/30|PASS|
|重复询问已知|≤1/70|0/70|PASS|
|A/B 合法卡与推荐类型|各≥17/18|各17/18|PASS|

第二轮评分保留不确定项的原保守计法，不重新评分或改写原FAIL记录。
阶段放宽的理由是右侧信息有步骤级用户确认；不能据此推断不存在编造或写回错误。
上线后用真实使用数据跟踪写回与无依据事实；整理模型或推理档位的小实验另立任务、另行批准预算。
不在本PR继续叠加提示词；B2+F1 staging验收仍须单独完成。

## 恢复方法与唯一代码差异

比较基准：`bbed64ab5bc92135ee20a0f6bc7a042ab4145f1a`。对所有 packages/scripts/apps 改动按 Git blob 原字节恢复，
撤回第三轮的确认问句规则、正文转换、停止/恢复转换、待确认建议输入及其专属测试。
评测工具也恢复第二轮实现，第三轮执行器删除；历史请求/账本/一次性锁保留本机，不能重新执行。

仅保留以下 CI 修复：

1. `runtime.integration.ts` 模拟供应商改用固定 ac1 测试模型契约识别正文，避免提示词措辞成为协议分支条件。
   两条原 mentorTurnStream 测试的正文、调用次数、并发及重发断言均保持第二轮原文；第三轮转换用例随功能撤回。
2. `bridge.ts`、`policy.ts`、`secondRound.ts` 的 TypeScript 静态导入移除 `.ts` 后缀，共5处，解决 TS5097。
   没有改 tsconfig、编译限制、费用值、预算算法或执行授权判断；工具仍由 tsx 入口加载。
3. `execute.ts` 已恢复第二轮500行，自动满足500行限制，因此无需保留第三轮精简注释。
   大小检查、基线、限制均未放宽。
4. 容量、准入与请求快照恢复第二轮原文，没有运行快照更新。
   第三轮45字节及对应历史截断变化已不存在，不能保留第三轮快照数值；用恢复后的真实测试计算核验。

以下逐文件覆盖本PR第二轮代码范围及第三轮曾修改的代码，包含测试、快照与工具；
全仓库 `git diff bbed64ab -- packages scripts apps` 的非空文件只能是上述4个CI文件。

|文件|对比结论|
|---|---|
| `apps/web/src/app/positioning/[draftId]/mentor-response.test.ts` | 逐字相同 |
| `apps/web/src/app/positioning/[draftId]/mentor-response.ts` | 逐字相同 |
| `packages/api/package.json` | 逐字相同 |
| `packages/api/src/scripts/ac0Probe/agentTurn.ts` | 逐字相同 |
| `packages/api/src/scripts/ac0Probe/cdcB2Eval.integration.ts` | 逐字相同 |
| `packages/api/src/scripts/ac0Probe/legacyAgentTurnPrompt.ts` | 逐字相同 |
| `packages/api/src/scripts/ac0Probe/mentorPreparation.mjs` | 逐字相同 |
| `packages/api/src/scripts/cdcB2Fixture.ts` | 逐字相同 |
| `packages/api/src/services/__tests__/fixtures/captureWorkflow.ts` | 逐字相同 |
| `packages/api/src/services/opc/__snapshots__/captureAdmission.test.ts.snap` | 逐字相同 |
| `packages/api/src/services/opc/__snapshots__/captureCapacity.test.ts.snap` | 逐字相同 |
| `packages/api/src/services/opc/__snapshots__/captureContext.test.ts.snap` | 逐字相同 |
| `packages/api/src/services/opc/agentTurnPrompt.test.ts` | 逐字相同 |
| `packages/api/src/services/opc/agentTurnPrompt.ts` | 逐字相同 |
| `packages/api/src/services/opc/agentTurnPromptCapacity.test.ts` | 逐字相同 |
| `packages/api/src/services/opc/answerCard.test.ts` | 逐字相同 |
| `packages/api/src/services/opc/answerCard.ts` | 逐字相同 |
| `packages/api/src/services/opc/capture.integration.ts` | 逐字相同 |
| `packages/api/src/services/opc/captureAdmission.test.ts` | 逐字相同 |
| `packages/api/src/services/opc/captureCapacity.test.ts` | 逐字相同 |
| `packages/api/src/services/opc/captureContext.test.ts` | 逐字相同 |
| `packages/api/src/services/opc/captureContext.ts` | 逐字相同 |
| `packages/api/src/services/opc/captureReplay.test.ts` | 逐字相同 |
| `packages/api/src/services/opc/captureReplay.ts` | 逐字相同 |
| `packages/api/src/services/opc/organizerPrompt.test.ts` | 逐字相同 |
| `packages/api/src/services/opc/organizerPrompt.ts` | 逐字相同 |
| `packages/api/src/services/opc/service.ts` | 逐字相同 |
| `packages/api/src/services/runtime/__snapshots__/agentTurnRequest.test.ts.snap` | 逐字相同 |
| `packages/api/src/services/runtime/admission.ts` | 逐字相同 |
| `packages/api/src/services/runtime/admissionGate.integration.ts` | 逐字相同 |
| `packages/api/src/services/runtime/agentTurnRequest.test.ts` | 逐字相同 |
| `packages/api/src/services/runtime/cdcBridge.test.ts` | 逐字相同 |
| `packages/api/src/services/runtime/cdcEval.test.ts` | 逐字相同 |
| `packages/api/src/services/runtime/execute.ts` | 逐字相同 |
| `packages/api/src/services/runtime/groundedCard.test.ts` | 逐字相同 |
| `packages/api/src/services/runtime/groundedCard.ts` | 逐字相同 |
| `packages/api/src/services/runtime/groundedCardRunner.test.ts` | 逐字相同 |
| `packages/api/src/services/runtime/hostTurn.ts` | 逐字相同 |
| `packages/api/src/services/runtime/hostTurnAdmission.test.ts` | 逐字相同 |
| `packages/api/src/services/runtime/inferenceQuestions.test.ts` | 第三轮新增文件已删除；第二轮无此文件 |
| `packages/api/src/services/runtime/inferenceQuestions.ts` | 第三轮新增文件已删除；第二轮无此文件 |
| `packages/api/src/services/runtime/nativeProgress.ts` | 逐字相同 |
| `packages/api/src/services/runtime/promptCacheAdmission.test.ts` | 逐字相同 |
| `packages/api/src/services/runtime/runtime.integration.ts` | CI 夹具按固定测试模型选择协议；原断言不变 |
| `packages/api/src/services/runtime/stoppedCompletion.test.ts` | 逐字相同 |
| `packages/api/src/services/runtime/stoppedCompletion.ts` | 逐字相同 |
| `packages/api/src/shared/conversationCapture.test.ts` | 逐字相同 |
| `packages/api/src/shared/conversationCapture.ts` | 逐字相同 |
| `packages/db/tests/v3/run-workbench.mjs` | 逐字相同 |
| `packages/db/tests/v3/without-app.mjs` | 逐字相同 |
| `scripts/cdc-b2-eval.mjs` | 逐字相同 |
| `scripts/cdc-b2-eval/bridge.ts` | CI TS5097：仅移除静态导入的 .ts 后缀 |
| `scripts/cdc-b2-eval/policy.ts` | CI TS5097：仅移除静态导入的 .ts 后缀 |
| `scripts/cdc-b2-eval/secondRound.ts` | CI TS5097：仅移除静态导入的 .ts 后缀 |
| `scripts/cdc-b2-eval/thirdRound.ts` | 第三轮新增文件已删除；第二轮无此文件 |
| `scripts/code-size-baseline.json` | 逐字相同 |

## 验证与交接

恢复后检查结果以PR最新记录为准；完整CI/Security通过后转ready，进行完整base到当前版本审查并处理P0/P1。
不合并。B2+F1 staging浏览器验证未运行；第二轮质量证据不等于前端验收完成。
