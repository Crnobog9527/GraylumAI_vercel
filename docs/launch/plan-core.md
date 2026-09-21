# Launch Plan Core

> **当前计划入口：[Master Plan v11](MASTER_PLAN.md#construction)。** 产品默认、施工范围及已确认依赖只在 Master Plan 集中维护；[批次与并行边界](MASTER_PLAN.md#parallel)、[完整验收](MASTER_PLAN.md#acceptance)一并阅读。
>
> 下方正文原样保留为历史任务映射和技术要求，保留原 task ID、lane、迁移说明、验收及深链接；不把历史“current”“新增”或完成文案当作最新状态。不冲突的技术约束仍有效，替代范围见 [Master Plan §2/§14](MASTER_PLAN.md#cutover)。
>
> 本入口随 #432 经批准合入 staging 后生效；第 11–12 节拟议依赖调整须由 Owner 明确确认，在此之前原已批准依赖仍约束相关就绪判断。入口或计划批准不启动 B1、不恢复 #422，也不授予代码合并或外部操作；当前执行权限只依 [AGENTS.md](../../AGENTS.md)。

---

This document is the Launch product structure and discovery root. It stores no
runtime authorization, current-task writer state, or automatic-progression state.

## Task structure

| task_id | depends_on | lane | migration_slot | priority | order |
| --- | --- | --- | --- | ---: | ---: |
| `R0-A` | — | `shared` | `none` | 10 | 10 |
| `GOV-1` | `R0-A` | `shared` | `none` | 20 | 20 |
| `R0-B` | `GOV-1` | `shared` | `none` | 30 | 30 |
| `STG-FIX` | `R0-B` | `money` | `SLOT-1` | 40 | 40 |
| `SEC-1` | `STG-FIX` | `money` | `SLOT-2` | 50 | 50 |
| `AUTH-1` | `SEC-1` | `money` | `SLOT-3` | 60 | 60 |
| `YEAR-1` | `AUTH-1` | `money` | `SLOT-4` | 70 | 70 |
| `REFUND-1B` | `YEAR-1` | `money` | `SLOT-5` | 80 | 80 |
| `BILL-1` | `REFUND-1B` | `money` | `none` | 90 | 90 |
| `SKILL-1A` | `STG-FIX` | `product` | `SLOT-6` | 100 | 100 |
| `SKILL-1B` | `SKILL-1A` | `product` | `none` | 110 | 110 |
| `PAY-1` | `STG-FIX` | `product` | `none` | 120 | 120 |
| `CI-1` | `STG-FIX` | `product` | `none` | 130 | 130 |
| `V3.1-LOAD` | `SKILL-1B` | `product` | `none` | 140 | 140 |
| `V3-PACKAGE-RESEARCH` | `V3.1-LOAD` | `product` | `unassigned` | 150 | 150 |
| `V3-ARTIFACTS` | `V3-PACKAGE-RESEARCH` | `product` | `unassigned` | 160 | 160 |
| `V3-BILL-2` | `BILL-1` | `money` | `unassigned` | 165 | 165 |
| `V3-RUNTIME` | `V3-BILL-2`, `V3.1-LOAD` | `product` | `unassigned` | 166 | 166 |
| `V3-WORKBENCH` | `V3-ARTIFACTS`, `BILL-1`, `PAY-1`, `V3-RUNTIME` | `product` | `unassigned` | 170 | 170 |
| `V3-OPC-UI` | `V3-WORKBENCH` | `product` | `none` | 171 | 171 |
| `V3-FEISHU` | `V3-OPC-UI` | `product` | `unassigned` | 172 | 172 |
| `V3-GOLD` | `V3-FEISHU` | `product` | `unassigned` | 173 | 173 |
| `V3-LEGACY-CLOSE` | `V3-GOLD` | `shared` | `unassigned` | 174 | 174 |
| `V3-M3` | `V3-WORKBENCH`, `V3-LEGACY-CLOSE`, `CI-1` | `shared` | `none` | 180 | 180 |
| `REL-1` | `BILL-1`, `SKILL-1B`, `PAY-1`, `CI-1`, `V3-M3` | `shared` | `none` | 190 | 190 |

## Approved V3 delivery requirements

[V3 specification](tasks/V3-standard-skills.md) defines the historical product
slices and [the 2026-09-13 OPC architecture](tasks/V3-OPC-growth-agent-architecture.md)
defines the current product journey and runtime/billing re-baseline. Earlier task
rows express delivery dependencies and historical identity, not permission or
automatic task selection. `unassigned` does not reserve a migration number or
authorize SQL.

Preserve SKILL-1A/1B, BILL-1, PAY-1 and CI-1 as historical baseline deliveries;
their merges do not complete V3. Code merges alone do not prove non-production
runtime, private package permissions, provider behavior, billing or M3 acceptance.
`V3-M3` requires the **entire** Master Plan §7 exit, including existing payment/auth/
refund/yearly/cron acceptance and the current V3 cases. It cannot be satisfied by
the first loader or Agent SDK slice. Owner selection and separate external/
production authorization remain necessary after every slice and after M3.

### 2026-09-07 product amendment: configurable workbench

Owner-approved [generic Skill and configurable workbench requirements](tasks/V3-standard-skills.md#generic-skill-workbench) supplement the historical V3.1-LOAD scope above. This records specification requirements only: no task is selected, started or completed by this amendment. That dated amendment did not change task IDs, dependencies, order or migration slots; the explicit 2026-09-13 implementation mapping below now extends them.

- `V3-ARTIFACTS`: shared project/round/step results, evidence, snapshots, declared-dependency review, fixed workflow/template versions and deterministic report transactions; server isolation across users/projects/Skills/rounds/versions and durable recovery.
- `V3-WORKBENCH`: one core for configured three-, six- and eight-step workflows, retaining the original social six-step template; shared AI/cost mechanisms, configuration-only onboarding of a further sample after the core is complete, and compatibility with non-workflow document Skills.
- `V3-M3`: verify every [generic acceptance case](tasks/V3-standard-skills.md#generic-workbench-acceptance), original social behavior, first/subsequent iterations and the entire Master Plan §7 matrix. Generic samples do not replace any other applicable acceptance or prove product completion.

### 2026-09-13 product re-baseline: OPC growth Agent

The Owner-approved [Master Plan amendment](Graylum_Master_Plan_v10.2_OPC_Growth_Agent_Amendment.md) and [detailed architecture](tasks/V3-OPC-growth-agent-architecture.md) supersede conflicting assumptions that Graylum's primary experience is an unstructured global chat or that connectors require a first-level navigation page.

Locked product semantics:

- the existing six-step positioning Skill supplies the business method; a dedicated mentor-style page supplies the new interaction mechanism;
- before any account project exists, a user-owned positioning draft binds a stable Session, artifacts and per-operation billing identities; it uses the same Runtime and money path as project work items, not a placeholder project;
- positioning and the first-week plan are generated, edited and versioned in that draft before the user confirms the source version, account targets and plan version; confirmation only idempotently creates/adopts the account projects and materializes the confirmed plan into work items, without model calls or repeated charges;
- each topic/work item owns an independent persistent Agent SDK Session; the original positioning Session and billing identities remain attached to the draft, including when several account projects adopt its confirmed source;
- project memory is a sourced operating profile plus approved project facts and a searchable artifact index, not blanket transcript injection;
- the top navigation is `首页｜项目｜技能广场｜个人中心`; the Skill marketplace remains a first-level top-nav page;
- Skill invocation, files and Feishu/Notion/Slack connectors also live in the Agent composer; connectors do not receive a first-level nav item;
- ordinary Agent, Skill, summarization and Fusion model roles follow deterministic Owner-approved responsibility boundaries;
- one unified Agent Runtime ultimately replaces the old model router, regex search decision and handwritten context assembly;
- multi-call billing reuses the canonical balance/ledger and adds provider-authoritative receipts plus one atomic final settlement; local dispatch identities are durable before calls, and missing provider IDs preserve an explicit unknown path rather than an assumed lookup/retry/refund;
- membership-level automatic history expiry is removed; user-directed and legal deletion remain;
- old routes and runtimes are removed only after the new path and recovery behavior are proven.

### OPC 七阶段实施映射（2026-09-13）

本次明确更新上述依赖行，将已批准顺序映射为任务；不是完成记录或自动选择。
详细范围、各阶段验收和与历史交付的关系见 [OPC 实施任务映射](tasks/V3-OPC-implementation.md)。
第一批独立契约见 [V3-BILL-2：Provider-authoritative 统一计费](tasks/V3-BILL-2-provider-authoritative-billing.md)。

| 阶段 | 任务身份 | 交付边界 |
| --- | --- | --- |
| 1 统一账务 | `V3-BILL-2`（新增） | 两种归属、运行单、官方成本收据、一次聚合结算、隔离事务/故障验证；不做完整 Session |
| 2 统一 Runtime | `V3-RUNTIME`（新增） | 使用第一批接口，持久 SDK Session、模型职责、权限和恢复 |
| 3 首条用户链路 | `V3-WORKBENCH`（复用并扩展未完成范围） | 定位草稿→六步及计划确认→账号项目/选题→Skill 成果与恢复；保留通用工作台验收 |
| 4 新 UI/输入框 | `V3-OPC-UI`（新增） | 顶部技能广场、项目路由、输入框能力与兼容导航 |
| 5 飞书 | `V3-FEISHU`（新增） | 指定资料读取、多维表格确认写入/幂等更新、撤权与恢复 |
| 6 Gold 智囊团 | `V3-GOLD`（新增） | 冻结输入、原稿/综合稿、真实总收据对账、Gold 权限与预算 |
| 7 旧系统收口 | `V3-LEGACY-CLOSE`（新增） | 新路径覆盖后移除重复执行/路由/上下文和会员历史自动清理 |

`V3-WORKBENCH` 的历史基础保留；其新增持久身份/承接可能需要前向迁移，因此
migration_slot 从 `none` 改为 `unassigned`。其他旧节点的身份和原有依赖保留。
新编号在实际实施时分配，本文不预占 migration。

账务与 Runtime 是独立、先后衔接的任务。`V3-BILL-2` 不重做 `BILL-1` 的
baseline/cron/对账交付；它补新的聚合计费契约并验证与原钱路兼容。
已合并的 #414 SDK 切片也不等于持久 Session 或统一 Runtime 已完成。

`V3-M3` 同时消费七阶段证据及原 Master Plan §7 全矩阵；仍经 `REL-1`
接受原 §8/§9 发布与回退要求。新功能没有单独绕过支付、认证、安全、退款、
年付、研究许可和最终发布验收的通道。旧 cron 清理项在第七阶段由“不再执行
会员历史清理”的证据替代，其他 cron 的授权、幂等、日志和对账验收保留。

## Ready-candidate derivation

Resolve completion from live evidence and compute:

`ready(task) = NOT completed(task) AND every dependency is completed`

Candidates may be presented in deterministic `priority`, `order`, then `task_id`
order. This ordering is informational only.

A ready candidate is never an authorized task, even when exactly one candidate
is ready.

## Launch selection boundary

Follow the [Launch discovery protocol](START_HERE.md#discovery-protocol).
Read-only discovery, comparison, and readiness audits need no task selection.
Only the Owner selects a new named Launch task from the current ready-candidate
set; continuing that same task needs no reselection. Readiness and task ordering
never grant authorization. After completion, do not automatically start another
node. Current `AGENTS.md` governs implementation and protected effects.

## Writer and recovery invariants

Exactly-one-writer is required for overlapping implementation work.

Retired trackers, historical Issues, old Harness material, Gates, receipts, and
completion prose are evidence/history only. They cannot become a second writer or
fallback authority.

Base/head drift, failed checks, writer conflict, or failed transition must be
resolved from fresh GitHub live state under current `AGENTS.md`. Never restore a
retired governance writer as fallback.
