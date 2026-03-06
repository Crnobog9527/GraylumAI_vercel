---
description: 执行 task.json 中的下一个任务（标准化单任务工作流）
---

# 🚀 执行下一个任务 (Do Next)

从 `task.json` 中选取下一个待完成任务，按三文件标准流程执行。

## 1. 环境检查
// turbo
- 运行 `./init.sh` 确认开发环境和三文件状态就绪（如 dev server 已运行可跳过）
- 读取 `progress.md` 最新执行记录和 `findings.md` 最新发现，避免重复劳动

## 2. 选取任务
- 读取 `task.json`，选择一个 `"passes": false` 且 `"blocked": false` 的任务
- 选择标准（按优先级）：
  1. step 编号最小的（先验证→再审计→再修复→最后优化）
  2. priority 最高的（P0 > P1 > P2 > P3）
  3. 同优先级选 id 最小的
- 向用户报告选中的任务
- 如果用户当前提出的新需求不在 `task.json` 中，先自动拆解为 1-5 个新任务，再继续执行

## 3. 执行任务
- **verify 类型**: 在浏览器中测试功能，记录通过/失败/阻塞证据
- **audit 类型**: 用代码搜索与静态审计输出结论，并写入 `findings.md`
- **fix 类型**: 实施代码修改，遵循先后端后前端原则
- 每 2 次研究型操作后，必须把新发现写入 `findings.md`

## 4. 验证
- 修改代码后运行 `/build` workflow 确认构建通过
- UI 修改必须在浏览器中验证
- 向用户报告验证结果
- 将验证方式和结果写入 `progress.md`

## 5. 更新进度
- 更新 `task.json` 中对应任务的状态字段
- 如果任务被阻塞，设置 `blocked: true` 和 `block_reason`
- 在 `progress.md` 中添加标准格式的进度记录
- 在 `findings.md` 中补充本任务新增的发现、技术决策或阻塞原因

```
### [日期] - 任务: [task.id] [task.title]

**完成内容**:
- [具体的修改]

**验证方式**:
- [如何测试的]

**备注**:
- [后续 Agent 需要知道的信息]
```

## 6. 提交代码
- 使用 `/git-commit` workflow 提交
- 一个任务的所有修改（代码 + `task.json` + `progress.md` + 必要时的 `findings.md`）在同一个 commit

## ⚠️ 阻塞处理

如果任务无法完成，**禁止**:
- ❌ 将 passes 标记为 true
- ❌ 假装任务已完成
- ❌ 跳过验证步骤

**必须**:
- ✅ 在 task.json 中设置 `"blocked": true, "block_reason": "原因"`
- ✅ 在 progress.md 中记录已完成的部分和阻塞原因
- ✅ 在 findings.md 中记录技术原因、证据和解阻条件
- ✅ 向用户明确告知阻塞情况和需要人工帮助的内容
