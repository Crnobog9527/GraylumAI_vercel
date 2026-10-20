# AGENT-CORE 后端性能排查（2026-10-20）

## 范围与完成条件

以 Owner 2026-10-20 交接为准：先核实 pdx1 下定位第 2 步带搜索对话，解释计费及搜索读取次数，减少可证明多余的数据库往返，使长回合明显缩短。正常、重复、并发及失败场景须保持计费正确和防重；实际效果与未验证项分开记录。

只改同范围后端及测试；不改定价、权限、预算、计费安全裁决、密钥和平台绑定，不部署 graylumai-staging 的 production，不合并 staging，由总控核对并合并。不新增表、队列、定时任务、依赖或迁移。

## 区域与复测结论

只读取 Vercel 项目 `graylumai-staging` / `prj_N9BO48YSAYBQ5Nrvzd3WA9wrQEpC` 和 Supabase 测试项目 `gvcpmcunmfrbxuwimxfa`。

- 当前部署 `dpl_9vdR3xzvWYQc8yzuBSpgra969HfN` 对应 staging `8a1af7886b83c412719b41bb213ab80520e58f20`，包含 #1211，部署 API regions=[pdx1]。
- **原 124 秒请求所在部署也返回 regions=[pdx1]**：`dpl_C9HW3ZJJaPrk28biTQhePH5W7FcH`，对应 `3cb0c7f870dc6ceadbca79998144afad4436e874`。Supabase edge 日志中两轮来源均为 Boardman。不能只凭 Vercel 日志的 hkg1 字段认定数据库请求跨太平洋，也不能把这两轮当成受控的区域前后对照。
- 本任务首次复测于 13:02:40 UTC（北京时间 21:02:40）在 founder 原定位第 2 步发送一条“继续”；请求 `qzzw5-1792501360357-1541c9cb15e9`，响应头含 `hkg1::pdx1`。服务器 5609 ms，43 次往返，执行列表为空，无模型/供应商调用；数据库报 `RUNTIME_SESSION_BUSY`。已截图并停止发送，没有重试、恢复或解除占用。**5.6 秒不是完成耗时。**
- Owner 随后明确：founder 正由“验收定位报告与对标兜底”任务使用，不再使用该账号、不清理中断执行；本任务改读其 Vercel 日志。此后没有新增浏览器请求，也没有操作该账号的执行状态。

### 两轮真实日志对照（均为本 PR 上线前）

| 项目 | 原请求（12:12–12:14 UTC） | 验收任务请求（13:01–13:04 UTC） |
| --- | ---: | ---: |
| 请求 ID | `ld6dv-1792498337986-03089f2a0e11` | `rgnqw-1792501313670-3af0acbccd69` |
| execution | `7d4889e6-8971-4717-8c5d-e4ae08005ae0` | `46e86dcf-83ba-41cd-9979-7a16849d54a4` |
| 总耗时 | 123768 ms | 154497 ms（中断，不算成功完成） |
| 往返总次数 / 累计耗时 | 308 / 115814 ms | 324 / 129199 ms |
| provider 阶段 | 111799 ms | 132050 ms |
| 模型 | 3 次 / 6182 ms | 3 次 / 5732 ms |
| bill2_claim | 11 / 19864 ms | 15 / 11928 ms |
| bill2_dispatch | 11 / 10173 ms | 15 / 6900 ms |
| bill2_record | 26 / 21527 ms | 18 / 17876 ms |
| runtime_response | 14 / 7837 ms | 18 / 26258 ms |
| research_runtime_read | 52 / 7449 ms | 26 / 2067 ms |
| bill2_read | 16 / 5862 ms | 25 / 6285 ms |
| bill2_finalize | 3 / 2443 ms | 3 / 10437 ms |

第二轮有 12 次新工具调用，原轮为 8 次，工作量和结果不同；不能按总耗时计算区域收益。第二轮日志报 `BILL2_DATABASE_UNAVAILABLE`，后续验收任务恢复同一执行（`xswn8-1792501515385-2869f0209d77`）耗时 7927 ms，重读 38 次、恢复旧收据 12 次，仍不能算新的成功搜索回合。

同窗口 Supabase edge 入口 `response.origin_time` 与 Vercel 侧耗时基本对得上，说明大多数耗时发生在 Supabase 入口内部，而非函数到入口的网络往返；不能进一步把入口内部耗时全部说成 SQL 计算或锁等待。

| RPC | 原窗口入口平均 / 最大 ms | 新窗口入口平均 / 最大 ms |
| --- | ---: | ---: |
| bill2_claim | 1791.73 / 5797 | 779.13 / 2670 |
| bill2_dispatch | 910.09 / 2575 | 443.13 / 1605 |
| bill2_record | 810.54 / 5131 | 976 / 9101 |
| runtime_response | 545.14 / 2043 | 1438.78 / 12765 |
| research_runtime_read | 128.52 / 1046 | 60.65 / 231 |
| bill2_read | 352.38 / 1895 | 233.96 / 2683 |

这些入口统计按时间窗口及 RPC 聚合；计数逐项与各自 Vercel 请求吻合，仍不具备跨系统请求 ID 的逐条因果关联。新窗口的 12.765 秒 runtime_response（200）及 9.101 秒 bill2_record（200）说明当前区域下仍有明显长尾。

## 为什么有这么多计费和搜索往返

一个模型工具调用可以展开多次供应商请求。每次真实供应商子请求分别需要 claim（冻结/身份）、dispatch（唯一发送授权）、record（真实费用/结果），这些不是同一笔钱扣了三次。模型还会先保存 provider ID，再保存最终费用，用于中途进程退出后的恢复，两次不能直接合并删除。

代码路径与原请求计数吻合的解释如下（“12 个旧操作”是由计数推导，未保存逐调用追踪）：

- 3 次模型 + 8 次新供应商子请求 = 11 claim + 11 dispatch。
- 3×2 模型收据 + 8 新工具收据 + 12 旧工具收据恢复 = 26 record。
- 模型发送前/后各一次 response 共 6 次；模型序号越过 8 个工具序号，每个先制造一次冲突，因此 14 次 response。
- 8 次新工具取下一序号各读整份 bill2 run；越过 8 个工具序号时再各读一次，共 16 次 bill2_read。
- 旧工具每个 operation、恢复所用 plan、discovery 再次读取 plan 共 3 次；新工具各 operation+plan 共 2 次：12×3+8×2=52。**这是持久搜索游标重建，不是定时轮询。**

## 本 PR 的最小改动

1. 每次工具执行第一次仍从数据库读 run；本 invocation 成功 claim 的工具序号在内存中递增，模型遇到这些已确认工具序号时直接跳过冲突扫描。工具成功或异常结束都清空下一序号水位；下个工具重新读数据库，以容纳中间的模型调用。新 invocation、等待余额、重放和不确定 claim 不继承这些快捷信息。
2. discovery 读取已 dispatched 或终态 operation 后，不再额外读一次只用于 prepared/cancelled 恢复的 plan。store.readOperation 的原始 plan/link 校验、同收据恢复、擦除屏障完全保留。

所有实际 claim、dispatch、record、预算/epoch/未结算裁决以及恢复时未知序号查询均保持。没有删除早期 provider ID 写入，也没有改变账务锁序。prepared/cancelled/缺失操作的取消、复核和稳定后继恢复不变。

按原请求形状推算：bill2_read 16→1，runtime_response 14→6，research_runtime_read 52→40；减少 35 次往返，claim/dispatch/record 次数不变。此为代码路径推算，不是实际完成耗时改善证明。

## 锁等待判断

存在潜在竞争点：`0162_bill_payg.sql` 的 bill2_payg_lock_models 对 run 的全部模型/工具路线取独占事务 advisory lock，claim、dispatch、record、finalize 都经过它；重复收据也可能先获取锁再判断重复。

但没有抓到该慢请求执行中的 blocker 样本。事后只读快照未发现等待锁，这不能排除之前发生过锁等待。pg_stat_statements 累计均值（claim 约 414 ms，record 约 240 ms）跨越多轮请求，不能代替该轮 SQL 耗时，更不能据此排除竞争、入口排队或数据库资源不足。本 PR 不凭推测修改钱路锁。

以后由总控安排空闲账号跑同类回合时，另开只读连接在请求期间采样如下 SQL，并取前后 pg_stat_statements 差分。`wait_event_type='Lock'` 且存在 blockers 才是抓到锁等待。视图含义见 [PostgreSQL 17 统计文档](https://www.postgresql.org/docs/17/monitoring-stats.html#MONITORING-PG-STAT-ACTIVITY-VIEW) 与 [阻塞进程函数](https://www.postgresql.org/docs/17/functions-info.html#FUNCTIONS-INFO-SESSION-TABLE)。不修改数据库日志设置、平台配置或凭证。

```sql
BEGIN READ ONLY;
SET LOCAL statement_timeout = '5s';
SELECT pid, wait_event_type, wait_event,
  clock_timestamp() - query_start AS query_age,
  pg_blocking_pids(pid) AS blockers,
  CASE
    WHEN query LIKE '%bill2_claim%' THEN 'bill2_claim'
    WHEN query LIKE '%bill2_record%' THEN 'bill2_record'
    WHEN query LIKE '%bill2_dispatch%' THEN 'bill2_dispatch'
    WHEN query LIKE '%runtime_response%' THEN 'runtime_response'
    ELSE 'other'
  END AS operation
FROM pg_stat_activity
WHERE datname=current_database() AND pid<>pg_backend_pid() AND state='active';
COMMIT;
```

## 验证与交接

- PASS：225 项相关既有单元/组件测试；新增序号测试 11/11（真实 discover→runSubcall→BILL2 包装，仅 RPC/供应商用替身），包含多子调用只一次 run read、每笔仍独立 claim/dispatch/record、工具边界、余额不足、重放、不确定结果、恢复隔离、原冲突及调用上限。
- PASS：API 类型检查、ESLint、代码大小和 diff 格式检查。
- PASS：93 项本地 BILL2 数据库集成，覆盖正常、重复、并发、失败、恢复；全部使用临时本地库、模拟供应商，未调用真实付费接口。
- 独立审查：另一 Agent 无代码阻断；其独立运行 9 文件 204 测试通过。具体最终提交、CI/安全检查及完整 Runtime 集成结果以本 PR 验证/交接记录为准。
- BLOCKED：本 PR 代码的真实带搜索回合耗时对比未完成；它尚未被合并或部署。不能宣称“明显提速”已经验收，也不能以既有 pdx1 日志替代改后实测。
- 发现的问题：pdx1 仍有 Supabase 入口长尾，验收任务该回合因数据库不可用中断；未改未授权的环境和执行状态。完整日志的 CLI 请求结果只返回请求首条日志，无法补齐尾部 timing，分析保留连接器已提供的明确字段，不猜测未返回字段。
- 下一步：总控核验 PR 的最终 CI/审查/本地集成证据后安排合并；验收任务独占 founder，合并后的耗时只读其同类请求日志，若需本任务自己发送则先由总控安排空闲测试账号与预算。尚无改后实际提速证明时，任务保持“优化已实现，性能验收未完成”。
