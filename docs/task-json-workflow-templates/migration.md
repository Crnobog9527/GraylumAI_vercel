# 从 task_plan.md 迁移到 task.json

适用于已经在使用 Manus 原始三文件模式，但希望改成 `task.json + progress.md + findings.md` 的仓库。

## 迁移原则

- `task.json` 成为唯一计划源
- `progress.md` 保留执行日志职责
- `findings.md` 保留发现与决策职责
- `task_plan.md` 改为历史归档，不再继续维护

## 迁移步骤

1. 保留旧的 `task_plan.md`，在顶部标注“已归档/已退役”。
2. 新建或整理 `task.json`，把当前仍未完成的阶段、任务、优先级转换成结构化任务。
3. 在仓库规则里声明：
   - 只认 `task.json`
   - 不再把 `task_plan.md` 当成当前状态源
4. 更新工作流文件，让“继续开发”“修 bug”“新增功能”都先读 `task.json`。
5. 更新初始化脚本，检查 `task.json`、`progress.md`、`findings.md` 是否齐全且可用。
6. 更新说明文档，防止团队成员继续维护旧的 `task_plan.md`。

## 字段映射建议

| 原 task_plan.md 内容 | 新位置 |
|----------------------|--------|
| 总目标 / 当前阶段说明 | `task.json.description` |
| 每个阶段 / 子任务 | `task.json.tasks[]` |
| 阶段顺序 | `task.json.tasks[].step` |
| 是否完成 | `task.json.tasks[].passes` |
| 是否阻塞 / 错误 | `task.json.tasks[].blocked` + `block_reason` |
| 执行经过 | `progress.md` |
| 技术决策 / 研究记录 | `findings.md` |

## 推荐做法

- 不要试图把旧 `task_plan.md` 的所有自由文本一次性塞进 `task.json`
- 只迁移当前仍会影响执行的任务
- 历史背景继续保留在 `task_plan.md`、`progress.md`、`findings.md` 中即可
