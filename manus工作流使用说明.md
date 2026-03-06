# Task.json 驱动三文件工作流使用说明

本仓库已经将 Manus 原始的 `task_plan.md + findings.md + progress.md` 模式，定制为更适合自动化执行的：

- `task.json`：唯一工作计划源
- `progress.md`：执行过程、验证结果、阻塞日志
- `findings.md`：研究发现、证据、技术决策、风险

`task_plan.md` 只保留为历史归档，不再新增、不再更新、不再作为当前计划依据。

---

## 你只需要做什么

你以后只需要用自然语言下命令，例如：

- “继续做下一个任务”
- “修复聊天页面的发送报错”
- “新增一个管理员导出报表功能”
- “审计模型设置到底有没有生效”

Codex 默认应自动完成这些动作：

1. 读取 `task.json`、`progress.md`、`findings.md`
2. 判断需求是否已存在于 `task.json`
3. 如果不存在，自动拆成 1-5 个任务写入 `task.json`
4. 执行时自动把过程写入 `progress.md`
5. 把发现、证据、决策写入 `findings.md`
6. 任务完成或阻塞时同步回写三文件

你不需要再提醒“更新哪个文件”。

---

## 三个文件分别负责什么

| 文件 | 角色 | 什么时候更新 |
|------|------|-------------|
| `task.json` | 唯一任务真相源 | 新需求进入、任务完成、任务阻塞、状态变化 |
| `progress.md` | 执行日志 | 开始任务、完成任务、运行验证、记录阻塞 |
| `findings.md` | 发现与决策日志 | 研究、审计、做技术决策、记录风险与证据 |

---

## 标准工作流

## 步骤 1：收到需求

**时机：** 用户提出新任务，或要求“继续开发”

**Codex 应该做什么：**

1. 先读取 `task.json`
2. 再读取 `progress.md` 最新进展
3. 再读取 `findings.md` 最新发现

**判断逻辑：**

- 如果 `task.json` 里已有对应任务：直接继续执行
- 如果没有：自动拆成 1-5 个可执行任务写入 `task.json`

**默认拆分原则：**

1. 先 `verify`
2. 再 `audit`
3. 再 `fix`
4. 最后 `optimize`

---

## 步骤 2：开始执行

**任务选择规则：**

从 `task.json` 中选择：

- `passes = false`
- `blocked = false`

排序规则：

1. `step` 最小优先
2. `priority` 最高优先（`P0 > P1 > P2 > P3`）
3. `id` 最小优先

**开始执行时要同步：**

- `progress.md`：记录开始处理哪个任务
- `findings.md`：如果有关键假设、风险、待确认点，立即记录

---

## 步骤 3：研究、审计、实现

### 研究和审计时

- 任何有价值的新发现都写入 `findings.md`
- 每累计 2 次研究型操作，必须更新一次 `findings.md`

研究型操作包括：

- 搜索
- 浏览器查看
- `rg` / `grep` 搜索
- 阅读关键代码文件
- 阅读 API / 配置 / 文档

### 实现时

- 真正改代码时，把动作、验证、影响文件写入 `progress.md`
- 如果做了重要技术选择，把原因写入 `findings.md`

---

## 步骤 4：完成或阻塞

### 如果任务完成

必须在同一轮工作里同步更新三处：

1. `task.json`
   - 标记 `passes = true`
   - 保持 `blocked = false`
2. `progress.md`
   - 记录做了什么
   - 记录验证方式
   - 记录修改了哪些文件
3. `findings.md`
   - 记录新增结论、关键证据、设计决策或残余风险

### 如果任务阻塞

必须这样处理：

1. `task.json`
   - 保持 `passes = false`
   - 设置 `blocked = true`
   - 写清楚 `block_reason`
2. `progress.md`
   - 记录已经完成的部分
   - 记录为什么卡住
   - 记录需要什么条件才能继续
3. `findings.md`
   - 记录技术根因、证据、建议的下一步

禁止把阻塞任务假装标记成完成。

---

## 步骤 5：交付前自检

交付前应检查：

1. `task.json` 中当前任务状态是否真实
2. `progress.md` 是否写了执行过程和验证结果
3. `findings.md` 是否写了本轮新增发现或确认“无新增关键发现”
4. 是否仍错误依赖 `task_plan.md`

---

## 给新手的最简理解

你可以把这三份文件理解成：

- `task.json`：任务清单
- `progress.md`：施工日志
- `findings.md`：调查笔记

以后你只要说“做什么”，Codex 负责：

- 把任务放进清单
- 记录施工过程
- 记录调查和决策

---

## 常见错误与规避

| 不要 | 应该这样做 |
|------|-----------|
| 同时把 `task.json` 和 `task_plan.md` 当计划源 | 只认 `task.json` |
| 做完任务只改代码，不更新三文件 | 至少同步 `task.json` + `progress.md`，有发现再写 `findings.md` |
| 研究很多内容却不记录 | 每 2 次研究动作就写 `findings.md` |
| 任务卡住却继续硬做 | 立刻标记 `blocked` 并写清原因 |
| 让用户手动提醒更新哪个文件 | Codex 自动维护三文件 |

---

## 模板位置

可复用模板位于：

- `docs/task-json-workflow-templates/rule-template.md`
- `docs/task-json-workflow-templates/task.template.json`
- `docs/task-json-workflow-templates/progress.template.md`
- `docs/task-json-workflow-templates/findings.template.md`
- `docs/task-json-workflow-templates/migration.md`
