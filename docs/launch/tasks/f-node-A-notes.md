# F-Node 任务 A：定位页（positioning/[draftId]）去掉旧路径调用（V2-12 主窗口，2026-11-03）

范围：`apps/web/src/app/(zh-hans)/app/positioning/[draftId]/**`。目标：这个目录里不再调用 Node 的旧过程 `runtime.view / executeStream / resume / resumeStream / cancel`、`opc.prepareStep / mentorTurnStream`，让 C 删除这些过程时 A 不受影响。

## 做了什么（分支 `claude/v2-12-f-node-A`）
- `use-mentor-turn-path.ts`：新增 `history`（对话历史只来自回合路径：`turnHistory(view)` 的 `executions / activeExecution`，`refetch` 读回合视图），删除 `withOld`（合并旧视图）。
- `page.tsx`：历史不再用 `runtime.view`；`execute` 只剩 `turnPath.settled`（等回合收口），不再有旧 `runtime.executeStream`；去掉 `usePaygResume`（`payg.busy / admitted / turnNotices / blockedNotices`）和 `openOrganizer` 判断。
- `use-live-reply.ts`：去掉 `runtime.cancel` 的停止、停止后的补读（`runtime.executeStream` + `runtime.view.invalidate`）。回合路径的回复本来就没有用户停止（`hasNoUserStop("turn:…")`），所以 `stopAction` 恒为空。
- `use-report-gen.ts` / `report-panel.tsx`：去掉 `usePaygResume` 和等待积分时的旧"继续"提示（回合路径的暂停由回合自己的"继续"提示处理）。
- `use-step-recovery.ts`：删除 `useHistoryPolling`（旧视图的轮询间隔）；回合视图由 `use-mentor-turn-path` 自己 3 秒读一次。

## 旧场景 → 新测试 / 保护
| 旧场景 | 现在 |
|---|---|
| 旧执行流（executeStream）续读未完成的回合 | 回合路径：`turnPath.settled` 等回合收口；`use-mentor-turn-path` 的读取轮询；`mentor-turn-path.test.ts`、`plan-turn-path.test.ts` |
| payg 暂停后"继续"（runtime.resume） | 回合暂停（waiting_credits）由 `turnPath.notices` 的"继续"走 POST /api/turn（kind=resume）；`use-mentor-turn-path` 测试 |
| 停止一条正在回复的执行（runtime.cancel） | 回合回复没有用户停止（`stop-reply-turn.test.ts`）；报告停止走 `/api/turn/stop`（`turn-report-stop.test.ts`） |
| 旧视图轮询（useHistoryPolling） | 回合视图自己轮询（active turn / 读取失败时 3 秒） |

## A4：A 目录不再引用 `lib/payg-wait.ts`
- 新增 `turn-pause.ts`：`isPaused`（回合暂停在页面上的状态 `waiting_credits / waiting_resume`）、`hostNotice`（回合结果上的宿主固定提示）、`PausedFields` 类型；`agent-turn-display.ts`、`live-reply-controller.ts`、`mentor-turn.ts` 改引用它。
- `mentor-turn-steps.tsx`：去掉"旧整理器仍开着"的进度（回合数据没有 `primaryBody / organizerComplete`）；`mentor-turn.ts`：去掉 Q1"上一轮整理还在等"的分支（`blockedAdmission`）和旧过程名的"准入前拒绝"判断；`admission-message.ts`：去掉整理器等待提示。
- 删掉的测试用例（都只测旧路径）：`payg-wait-mentor.test.ts` 的 3 个 Q1 用例（旧整理器等待）、`mentor-turn-steps.test.tsx` 的 2 个整理器步骤用例、`mentor-turn.test.ts` 的"宿主提示在前（走 blockedAdmission）"和"旧过程准入前拒绝释放信封"两个用例、`admission-message.test.ts` 的 2 个（旧过程路径上的拒绝文案）。对应的新路径保护：回合拒绝由 `mentor-turn-path.ts`（`TurnRefused.kept`）和 `mentor-turn-path.test.ts` 覆盖；暂停由 `turnPath.notices`；整理器没有等待（回合内一次完成）。

## 没改（留给后续）
- `admission-message.ts` / `mentor-turn.ts` 里剩下的旧过程路径名字符串（`opc.prepareStep` 等）只是不会再匹配的字符串，C 删过程时顺手清。
- 浏览器验收交给 Codex（`*.browser.test.tsx` 本机无浏览器，未跑）。
