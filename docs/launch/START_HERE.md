# Graylum Launch Plan — START HERE

当前产品规划只看 [Master Plan v12](MASTER_PLAN.md)。本文只做导航，不维护第二份产品规则、任务顺序、完成状态或执行授权。

## 从哪里读起

| 想知道 | 去哪里 |
| --- | --- |
| 产品是什么、现在到哪了、接下来先做什么 | [v12 §0 一页总览](MASTER_PLAN.md#overview)、[§1 现状](MASTER_PLAN.md#status) |
| 本版新决定、哪些旧规则被取代 | [v12 §2](MASTER_PLAN.md#changes) |
| 对话与定位新交互、Fusion、资料库与文风、Skill 数据基础 | [v12 §3](MASTER_PLAN.md#agent)、[§4](MASTER_PLAN.md#fusion)、[§5](MASTER_PLAN.md#library)、[§6](MASTER_PLAN.md#learning) |
| 施工顺序、依赖、并行线、授权批次 | [v12 §7](MASTER_PLAN.md#construction) |
| 技术债核实结果与清理顺序 | [v12 §8](MASTER_PLAN.md#debt) |
| 仍然有效的旧规则、技术规格、验收出口 | [v12 §9](MASTER_PLAN.md#rules) |
| Owner 决定事项（D1–D6 已确认） | [v12 §10](MASTER_PLAN.md#decisions) |
| 仓库操作、风险分级、审查、合并、生产权限 | [AGENTS.md](../../AGENTS.md) |
| 技术栈、代码组织、代码大小限制、测试命令 | [docs/ENGINEERING.md](../ENGINEERING.md) |

## 规划不等于授权

规划定义需求、依赖和验收，不启动任何功能，也不授予合并、部署、真实调用或生产权限。Owner 选定一个任务或批次（[v12 §7.4](MASTER_PLAN.md#construction)）后才开工；批次内由 Agent 按 AGENTS.md 自主排序、验证和修复，完成后停下，不自动开始下一批。

## 历史文档

| 文档 | 现在的用途 |
| --- | --- |
| [Master Plan v11](Graylum_Master_Plan_v11.md) | 历史版本；§3、§4.1–4.3、§5–§10、§13 中未被 v12 取代的要求继续有效（范围见 [v12 §9](MASTER_PLAN.md#rules)） |
| [OPC v10.2 修订](Graylum_Master_Plan_v10.2_OPC_Growth_Agent_Amendment.md)、[Master Plan v10.1](Graylum_Master_Plan_v10.1.md) | 历史依据；不冲突的钱路、认证、安全、年付、退款、cron、验收和发布要求继续有效 |
| [plan-core](plan-core.md)、[OPC 实施映射](tasks/V3-OPC-implementation.md) | 历史任务表；任务编号对照见 [v12 §7.5](MASTER_PLAN.md#construction) |
| [OPC 详细架构](tasks/V3-OPC-growth-agent-architecture.md)、[V3 标准 Skill](tasks/V3-standard-skills.md)、[BILL2 技术契约](tasks/V3-BILL-2-provider-authoritative-billing.md) | 技术附录；与 v12 §2.2 冲突的部分以 v12 为准 |
| [docs/archive/](../archive/README.md) | 已归档的旧计划、旧设计和旧开发规范，不作为当前依据 |

## 开工前的核对

先按当前 AGENTS.md 核对仓库、目标分支、适用规则、相关 PR 和 writer；再读 v12 中与任务相关的章节。判断就绪只看实时代码和验证证据，不看旧文档里的完成文案或某个 PR 的绿灯。
