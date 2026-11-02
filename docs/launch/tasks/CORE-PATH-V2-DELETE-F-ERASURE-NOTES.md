# CORE-PATH-V2 V2-12 批次 F：注销与内容删除（R2c）说明

状态：草稿，不上库。文本在同目录的 `CORE-PATH-V2-DELETE-F-ERASURE-SEGMENT.sql`，要并进 `CORE-PATH-V2-DELETE-F-DRAFT.sql` 的"前置改写"段
（`billing_reconcile_day` 之后、`DO $guard$` 之前，同一事务）。本文件只写：改了什么、保护有没有放宽、怎么验证的、F 前要做的 staging 处理。

## 1. 24 个函数各自怎么处理

守卫（`V2_12_F_REFERENCES_REMAIN_*`）在 2026-11-03 的 staging 基线上点名了 24 个注销相关函数；这一段把它们清零。

整段改写（18 个，签名、返回键、权限不变，`CREATE OR REPLACE`）：

| 函数 | 改动 |
|---|---|
| `account_erasure_preview` | 在途数量只数回合（`turns`） |
| `account_erasure_note_error` | 钱是否在途只看回合 |
| `account_erasure_financial_proof` | `financialPending` 只数回合 + 付款单 + 调研操作；去掉旧 run、旧收据人工核对、评审团/报告待结算费 |
| `account_erasure_financial_batch` | 只报告回合；`items` 恒为空，键不变 |
| `account_erasure_work_batch` | `runs` 恒为空数组、`nextRunId` 为空，键不变 |
| `account_erasure_body_remaining` | 去掉五张旧运行表的计数，其余照旧 |
| `account_erasure_scrub_runtime` | 只清 `runtime_scope_material`、`runtime_sessions`、旧聊天三表；"是否可清"由"旧执行已结清"改为"会话上没有开着的回合" |
| `account_erasure_scrub_content` | 去掉评审团费、报告费的待结算处理 |
| `account_erasure_prune_business` | 删除名单去掉七张旧表和会话历史的专门分支 |
| `erasure_business_owner` | 去掉旧表分支；没有回合归属的 `opc_result_links` 改经证据所属项目找账号（旧链接仍能被清掉） |
| `content_erasure_scope` | 不再从旧执行表取执行，不再算历史依赖闭包；`answer` 类型恒为"找不到"（Node 早已禁用）；回合范围的算法不变 |
| `content_erasure_confirm` | 去掉旧执行、旧 run、历史、工具调用、费用和账本行的处理；其余（回合、消息、调研、产物、工作项、评审团表）照旧 |
| `content_erasure_mark_session` | 去掉旧执行加锁和评审团分组判断 |
| `content_erasure_parent_guard` | 触发器函数，去掉旧表分支，只留会话下的素材和各项目分支 |
| `content_erasure_saved_readable` | 由旧执行生成的版本读不到（旧执行已不存在，原来也是读不到） |
| `content_erasure_artifact_readable` | 去掉旧执行那一支，回合那一支照旧 |
| `content_erasure_capture_steps` | 没有旧执行可指，等于不改 |
| `content_erasure_ledger_owned` | 恒为 false（账本行原来按"账号已删内容的旧 run"认领；旧 run 不存在了；账号注销本身照旧关账本行） |

在这一段里直接删除（6 个，它们只被会被 F 删的旧路径函数调用，已逐个核对）：
`account_erasure_detach_runtime`、`account_erasure_scrub_run`、`account_erasure_scrub_calls`、`account_erasure_scrub_receipts`、
`content_erasure_financial_allowed`、`content_erasure_runtime_check`。

没有放进 24 个、但变成无人调用的：`content_erasure_capture_copy`（只被改写前的 scope / confirm 调用）。F 清单可以顺手删。

## 2. 保护有没有放宽

没有。保护的东西换成了新路径里真实存在的东西：

- 钱：账号还有没关或没结清的回合 → 注销停在 `billing_pending`，`BILLING_CLEAR` 被拒，Auth 不会被移除。新路径一侧原来就有，这里只是去掉旧 run 的那半。
- 内容：会话删除仍然等开着的回合（`CONTENT_ERASURE_BUSY`）；回合的响应正文、消息文本、产物、工作项、调研、评审团表都照旧清理。
- 少掉的只有"处理已经不存在的行"（旧 run / 执行 / 历史 / 收据 / 费用）。

需要 F 的负责人知道的两处取舍：

1. `fusion_call_outputs` 的正文表保留，但它和会话的唯一联系是被删的 `fusion_billing_groups.source_session_id`。删内容时只能经 `fusion_compares`
   找到它；F 之后没有 group 的输出行只会在**账号注销**时被清（按 `actor_id`）。建议 F 把这张表的现有行一并清空或随评审团一起删（评审团已随 F 删除）。
2. 由旧执行保存的内容版本（`opc_content_versions.execution_id` 非空）F 之后读不到（原来执行行不存在时也是读不到，且 #1617 已让旧执行一律读不到）。

## 3. 验证

本机从文件建库，套上 F 草稿（15 张旧表、164 个函数删除，守卫里把评审团 / `opc_capture_apply` 这批 V2-8 名下的暂时放行）：

- 守卫：注销相关函数名全部不再出现；剩下的只有评审团 21 个、`opc_capture_apply`、`opc_work_result`、`opc_video_runtime_binding_guard`（V2-8 名下）。
- `turn-erasure` 套件：带 F 通过，不带 F 通过（新路径的全部用例）。
- `erasure-completion`、`content-erasure`：见下一节。

## 4. F 的 PR 里要删或改写的旧路径用例（跑完回填）

见 PR 描述。

## 5. F 前 staging 未结清旧 run 的处理（只读核对 2026-11-03，没有写任何东西）

核对对象：链接的 staging 项目（`GraylumAI Staging`）。只读聚合，没有取账号信息。

| 状态 | 版本 | 条数 | 账号数 | 已扣积分 | 冻结积分 | 最早 → 最晚 |
|---|---|---|---|---|---|---|
| cost_pending | v2 | 12 | 12 | 10 | 0 | 10-26 → 10-28 |
| prepared | v2 | 7 | 4 | 15 | 0 | 10-06 → 10-27 |
| cost_pending | v1 | 1 | 1 | 0 | 48 | 09-27 |
| dispatched | v2 | 1 | 1 | 0 | 0 | 10-28 |
| prepared（无执行） | v2 | 1 | 1 | 0 | 0 | 10-15 |
| unknown | v1 | 1 | 1 | 0 | 848 | 09-26 |

合计 23 条、活跃旧执行 20 条；已注销账号名下的未结清旧 run 是 0 条；注销请求 11 个，没有一个停在 `billing_pending`；开着的回合 0 个。
涉及的全部是 staging 测试账号的测试积分：已扣 25 积分 + 冻结 896 积分，按 1 美元 = 100 积分合计约 9 美元的测试额度，没有真钱。

**建议：明确丢弃，不结清。**

- F 删表后这 23 条和 20 个活跃执行一起消失。冻结的 896 积分是 2 条 v1 老 run 留下的测试额度，不会再被任何代码退回；这些账号的当前余额不变。
- 结清要对每条走 `bill2_cancel` + `bill2_finalize`，cost_pending 的 13 条还缺供应商成本证据，结不干净；而且是对 staging 的写操作，要先通知总控。得不偿失。
- 如果 Owner 想把这 896 积分还给测试账号：F 前由总控批准后，对那 2 条 v1 run 单独 `bill2_cancel`，并把结果记在 PR 里（只 2 条）。默认不做。

F 当天（不是现在）的核对，全部只读，通过才能上 F：

```sql
-- 1. 已注销账号名下不应有未结清旧 run（现在是 0）
select count(*) from bill2_runs r
 where (not r.closed or r.state not in ('settled','refunded') or r.conflict)
   and exists (select 1 from account_erasure_requests a where a.profile_id = r.actor_id);
-- 2. 没有开着的回合，也没有停在 billing_pending 的注销（现在都是 0）
select (select count(*) from turns where state <> 'closed' or settlement = 'pending') open_turns,
       (select count(*) from account_erasure_requests where stage = 'billing_pending') billing_pending;
-- 3. 未结清旧 run 的总数（现在是 23）：与上面表对不上就先停下来问
select count(*) from bill2_runs where not closed or state not in ('settled','refunded') or conflict;
```
