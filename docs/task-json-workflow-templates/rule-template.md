# Task.json Workflow Rule Template

将下面内容保存为仓库规则文件，例如 `.agents/rules/task-json-workflow-rules.md`：

```md
---
trigger: always_on
---

# Task.json Driven Workflow Rules

- `task.json` 是唯一计划源。
- `progress.md` 只记录执行日志、验证结果、阻塞历史。
- `findings.md` 只记录研究发现、证据、技术决策、风险和建议。
- `task_plan.md` 仅保留为历史归档，不再作为当前计划依据。
- 用户使用自然语言提出新需求时，如果 `task.json` 中没有对应任务，自动拆成 1-5 个任务写入。
- 继续开发时，默认从 `task.json` 中选择 `passes=false && blocked=false` 的最佳任务执行。
- 排序规则：`step` 最小优先，再按 `priority`（P0 > P1 > P2 > P3），再按 `id`。
- 每 2 次研究型动作后，必须把新增结论写入 `findings.md`。
- 任务完成时，同步更新 `task.json`、`progress.md`、`findings.md`。
- 任务阻塞时，禁止标记通过，必须设置 `blocked=true` 和 `block_reason`，并在 `progress.md` / `findings.md` 留痕。
```
