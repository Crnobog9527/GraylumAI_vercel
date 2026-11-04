# 回复步骤列表（TurnStepList）使用说明

Owner 2026-11-04：所有对话里，一轮回复的加载过程（读取 Skill 方法、联网搜索、查资料库、读作品数据）都要把进行中、完成、失败的明细显示出来，让用户知道没有卡住。
本文件是共用组件的接口和用法，给要把别的对话（定位、导师、报告等）接上同一组件的人看。

## 数据：服务端的 `step` 事件

`packages/api/src/services/turn/sse.ts` 的 `StepEvent`，在 POST /api/turn 的流里，工具开始和结束各一条，同一 `id` 表示同一步：

| 字段 | 含义 |
| --- | --- |
| `id` | 这一轮内的序号字符串；同一 id 的后一条替换前一条 |
| `tool` | `load_skill`、`research`、`read_source`、`coach_review`、`other` |
| `state` | `running` → `done`；或 `failed`（工具没做成）；或 `skipped`（这次没用到，不是错误） |
| `label` | 只有 `load_skill` 有：Skill 的目录显示名（模型传来的名字在本轮目录里才带） |
| `detail` | 只有 `research` 有：搜索词的前约 20 个字，或网页的域名 |
| `count` | 结果条数（研究、资料库），结果里有才带 |

不会出现：工具参数全文、搜索词全文、网址路径、结果正文、Skill 原文、内部 id。服务端生成事件的地方：`packages/api/src/services/turn/tools/toolStage.ts`（`stepStart`、`stepEnd`），由 `tools/chatTools.ts` 的 `build` 在每个工具执行前后发出（参数 `announce`，自由对话传 `emit`）。
别的类型的回合要接入时：在它自己的工具执行处调用同样两个函数、发同样的 `step` 事件即可，不要新加事件类型。

## 页面：`TurnStepList`

- 组件：`apps/web/src/components/chat-display/turn-step-list.tsx`；纯函数模型：`turn-step-list-model.ts`（`ReplyStep`、`mergeStep`、`stepLine`、`stepsSummary`、`visibleSteps`、`stepsOpen`）。
- 用法：`<TurnStepList steps={steps} live hasText={Boolean(text)} />`，放在这条回复正文的上方。
  - `steps`：到目前为止的步骤，用 `mergeStep(旧列表, 事件)` 累加；
  - `live`：这条回复正在写（历史里读回来的回复不传或传 false）；
  - `hasText`：正文已经开始出字。
- 行为：回复在写、正文还没出字时展开，最后一行是进行中的步骤，没有进行中的步骤就显示「正在思考…」；正文开始出字后、以及回复结束后，折叠成一行「已完成 N 个步骤」，点开看明细；有步骤没成功时写「，其中 N 个没成功」。没有步骤且不在写时什么都不渲染。
- 失败和跳过用中性的话（「…暂时读取不了，改为直接回答」「这次没有联网搜索」），不用红色和「错误」。
- 在自由对话里的接线：`app/runtime/use-turn-chat.ts` 的 `liveAfter`（事件 → `live.steps`）、`turn-workspace.tsx` 和 `work-item-workspace.tsx`（渲染）。
- 测试：`turn-step-list-model.test.ts`、`turn-step-list.test.tsx`、`turn-step-list.browser.test.tsx`（真浏览器里点开折叠；设环境变量 `TURN_STEP_SHOTS=<目录>` 会顺带出桌面和 390px 的图，图在 `docs/launch/evidence/turn-step-list/`）、`tools/toolStage.test.ts`、模拟浏览器 `tests/e2e/sim/10-steps.spec.ts`（模拟模型可以用故障模式 `tool` 只回一个工具调用、`slow` 让下一次调用晚到）。

## 刷新后的历史

第一版（本文件对应的 PR）：正在写的回复显示步骤，写完后本页会话内留在回复上方（折叠）；刷新后历史里的步骤行由紧接着的迁移 PR 存储和读回（只存类型、显示名、状态、数量），到时 `steps` 作为 `TurnStepList` 的参数传入、`live` 不传即可。在那之前，刷新后历史里只有付费研究的行（`AgentWorkStatus`）。

## 已知的重复

自由对话里付费研究仍有 `AgentWorkStatus` 的行（带积分），和步骤列表里的「联网搜索」是同一件事的两个视图。历史步骤行上线后再合并成一个，这一版不动付费行，以免改动已验收的积分显示。
