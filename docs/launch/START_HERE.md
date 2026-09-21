# Graylum Launch Plan — START HERE

当前产品规划从 [Master Plan v11](MASTER_PLAN.md) 开始阅读。本文只作导航，不维护第二份产品规则、任务顺序、完成状态或执行授权。

## Entry points

- [当前目标分支 AGENTS.md](../../AGENTS.md)：仓库操作、writer、验证、审查、合并及生产权限。
- [Master Plan：产品与已确认决定](MASTER_PLAN.md#overview)：Agent、定位、资料库、内容交付、后台、集成、自动追踪与支付。
- [施工范围、依赖和状态](MASTER_PLAN.md#construction)；[批次与并行边界](MASTER_PLAN.md#parallel)：只在 Master Plan 维护；第 11–12 节的拟议调整须获 Owner 明确确认才替代原顺序，见下方生效边界。
- [完整验收与发布出口](MASTER_PLAN.md#acceptance)；[不可变来源和技术附录](MASTER_PLAN.md#sources)。
- [原任务图的兼容入口](plan-core.md)；[原实施映射的兼容入口](tasks/V3-OPC-implementation.md)：保留历史身份与原文，不再分别更新当前施工顺序。

## Product specification vs execution authority

本入口与 Master Plan 同属 #432 文档候选。只有该候选经适用验证、独立审查及 Owner 明确批准合入 `staging` 后，才完成目标分支的入口切换；在候选分支读到本文不代表已经合并。

入口统一不使拟议依赖或批次自动获批。Owner 尚未确认第 11–12 节调整时，原已批准依赖仍用于相关就绪判断；Owner 可以在明确批准本计划及其顺序后合并。任何一种文档批准都不选中 B1 或其他功能批次、不恢复已暂停的 #422、不授予代码合并、真实调用或生产权限。当前工作仍限 B0 文档收口。

当前执行要求只来自 authoritative `staging/AGENTS.md` 和 Owner 的实际授权。技术规范定义需求、依赖、验收和 Definition of Done，不替代权限；历史文档中的状态、未来选择示例和过程用语也不构成新授权。

## Historical specifications and retained requirements

以下文档保留原文和既有链接，不再充当另一份当前产品总计划。替代范围集中在 [Master Plan §2](MASTER_PLAN.md#conflicts)、[§14](MASTER_PLAN.md#cutover) 和 [§15](MASTER_PLAN.md#sources)，不是无条件删除旧要求。

| 历史来源 | 新入口中的用途与保留边界 |
| --- | --- |
| [Master Plan v10.1](Graylum_Master_Plan_v10.1.md) | 保留不冲突的钱路、认证、安全、年付、退款、cron、完整验收和发布/回退要求；历史日期、已勾选状态、固定槽位及旧流程措辞不作当前执行指令 |
| [OPC v10.2 修订](Graylum_Master_Plan_v10.2_OPC_Growth_Agent_Amendment.md) | 原 OPC 产品依据；与后续明确决定冲突的默认入口、交互、支付和套餐假设以 Master Plan 对应替代说明为准，未冲突的需求仍保留 |
| [OPC 详细架构](tasks/V3-OPC-growth-agent-architecture.md) | 保留业务归属、版本、Session、权限、账务及恢复契约；页面主导和独立周计划表格的默认体验已由后续 Agent 主线替代。#422 未合并增补须从 Master Plan 所列精确来源读取，不能误作 staging 代码 |
| [V3 标准 Skill](tasks/V3-standard-skills.md)及[通用工作台验收](tasks/V3-standard-skills.md#generic-workbench-acceptance) | 保留私有包、固定 revision、来源/成果、3/6/8 步、配置扩展、无步骤 Skill、隔离与恢复要求；原社交六步方法不被新宿主替换 |
| [BILL2 技术契约](tasks/V3-BILL-2-provider-authoritative-billing.md) | 保留精确成本、锁序、原子结算、原请求与未知恢复、兼容和隔离测试；旧“尚待开工”不覆盖 Master Plan 所区分的已合并基础与后续未验证能力 |

#423、#424、#431 已关闭但未合并，其不可变文档、关闭原因和吸收位置见 Master Plan。#422 和其他技术候选不因规划收口而关闭、合并或认定完成。

## Discovery protocol

先按当前 AGENTS 核验本任务所需的仓库、目标 ref、适用规则、候选及 writer；再读 Master Plan 的相关需求、已确认决定、依赖状态与技术附录。只有必要的 live 代码和验证证据才能支持就绪判断，不能用旧完成文案或某个 PR 的绿灯替代。

只读发现不需要选择功能任务；实施范围依 Owner 实际选定的具名任务或有界批次及当前 AGENTS。在已授权范围内由 Agent 排序、验证并修复；计划批准不自动启动功能，任务暂停也不被本文解除。未解决的依赖、writer 或授权问题只阻断受影响部分；完成已选范围后停止，不自动选择下一项。
