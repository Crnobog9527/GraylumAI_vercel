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

## 没改（留给后续）
- `payg-wait.ts` 的纯函数在 `admission-message.ts`、`agent-turn-display.ts`、`live-reply-controller.ts`、`mentor-turn-steps.tsx`、`mentor-turn.ts` 里仍被引用（只处理旧数据里才有的字段，回合数据上恒为"无"）；C 在 A、B 合并后删 `payg-wait.ts` 时一并清这些引用。`admission-message.ts` / `mentor-turn.ts` 里写着旧过程名的错误映射同理。
- 浏览器验收交给 Codex（`*.browser.test.tsx` 本机无浏览器，未跑）。
