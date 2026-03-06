# 正确工作流程：以 task.json 为唯一计划源

此文档描述本仓库当前正在使用的正确工作流程。核心原则只有一句：

`task.json` 管计划，`progress.md` 管过程，`findings.md` 管发现。

`task_plan.md` 仅作为历史归档保留。

---

## 可视化工作流程

```text
用户自然语言下达需求
        │
        ▼
读取 task.json / progress.md / findings.md
        │
        ▼
需求是否已在 task.json 中？
   ├─ 是 → 选出下一个 passes=false 且 blocked=false 的任务
   └─ 否 → 自动拆成 1-5 个任务写入 task.json
        │
        ▼
开始工作
   ├─ 研究 / 搜索 / 读代码 → findings.md
   ├─ 实现 / 修复 / 测试 → progress.md
   └─ 每 2 次研究型操作 → 必须刷新 findings.md
        │
        ▼
任务结束？
   ├─ 完成
   │   ├─ task.json: passes=true
   │   ├─ progress.md: 记录实现与验证
   │   └─ findings.md: 记录关键结论/证据/风险
   └─ 阻塞
       ├─ task.json: blocked=true + block_reason
       ├─ progress.md: 记录已完成部分和卡点
       └─ findings.md: 记录技术原因和解阻建议
```

---

## 正确顺序

### 1. 先读三文件

在开始任何复杂任务前，先读：

1. `task.json`
2. `progress.md`
3. `findings.md`

目的是确认：

- 当前计划是什么
- 最近做到哪里
- 已经查明了什么

### 2. 只认 task.json

所有“当前任务状态”只能以 `task.json` 为准。

要看这些字段：

- `passes`
- `blocked`
- `block_reason`
- `updated_at`

不要再用 `task_plan.md` 判断当前任务进度。

### 3. 没有任务就自动建任务

如果用户提了一个新需求，而 `task.json` 里没有对应项，Codex 应自动：

1. 理解需求
2. 拆成 1-5 个可执行任务
3. 写入 `task.json`
4. 在 `progress.md` 留启动记录
5. 在 `findings.md` 留需求理解和关键假设

### 4. 执行时分工清晰

| 行为 | 正确写入位置 |
|------|-------------|
| 增删改任务状态 | `task.json` |
| 记录实现过程、测试、阻塞经过 | `progress.md` |
| 记录研究发现、证据、决策、风险 | `findings.md` |

### 5. 两次研究规则

每累计 2 次研究型动作，必须更新一次 `findings.md`。

研究型动作包括：

- 搜索
- 打开文档
- 阅读关键代码
- `rg` / `grep`
- 浏览器检查页面

这样做的目的，是避免重要发现只停留在临时上下文里。

---

## 正确完成方式

### 任务完成时

必须同轮同步：

1. `task.json`
   - `passes = true`
   - `blocked = false`

2. `progress.md`
   - 写完成内容
   - 写验证方式
   - 写影响文件

3. `findings.md`
   - 写新增的关键结论、技术决策、风险说明

### 任务阻塞时

必须同轮同步：

1. `task.json`
   - `passes = false`
   - `blocked = true`
   - `block_reason = 具体原因`

2. `progress.md`
   - 写已完成工作
   - 写阻塞点
   - 写继续所需条件

3. `findings.md`
   - 写技术原因
   - 写证据
   - 写建议的下一步

---

## 文件关系

```text
task.json
  ├─ 当前计划
  ├─ 优先级
  ├─ 是否通过
  └─ 是否阻塞

progress.md
  ├─ 做过什么
  ├─ 怎么验证
  └─ 卡在哪里

findings.md
  ├─ 学到了什么
  ├─ 证据是什么
  └─ 为什么这样决策

task_plan.md
  └─ 历史归档，不参与当前决策
```

---

## 5 问重启测试

如果中途上下文很多、工作很久，重新回答这 5 个问题：

| 问题 | 应看哪里 |
|------|---------|
| 我现在在做哪一项？ | `task.json` 中当前未完成任务 |
| 下一步是什么？ | `task.json` 中排序后的下一项 |
| 最近做了什么？ | `progress.md` |
| 最近发现了什么？ | `findings.md` |
| 旧的 task_plan.md 还要不要维护？ | 不要，它只是归档 |

---

## 给 Codex 的执行要求

- 用户只需说目标，不需要提醒更新哪个文件
- 如果新需求不在 `task.json`，自动补任务
- 如果工作发生阻塞，不得假装完成
- 如果 repo 里旧文档仍提到 `task_plan.md`，以当前文档和仓库规则为准
