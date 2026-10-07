# BILL2：遗留 v1 cost_pending 的只读调查与恢复交接

本次对象：报告中的 staging run 短 ID `42dd468b`，创建于 2026-09-27，
状态 `cost_pending`，报告冻结 48 积分。这些是任务输入，不是本次数据库实测。
源码基线：staging `60954c86b50a3cdb33bc08447f39d8f8a6aa856d`。

**处理决定：遗留 v1 run 保持原状，不做维护修复。**
依据[主窗口只读查询与处理决定](https://github.com/Crnobog9527/GraylumAI_vercel/pull/700#issuecomment-6021487746)，
该 run 属于成本未知且已过查询窗口的 C 类；本执行窗口未访问远端数据库，未独立复测该结果。
下文保留通用诊断和条件式步骤供参考，不构成对此 run 执行恢复的授权。本次不修改运行时代码。

## 已确认的源码行为

| 条件 | 现有行为与依据 |
| --- | --- |
| v1 已派发，但任一调用 `selected_cost_usd` 为空 | `bill2_finalize` 保留未结状态和原预扣，不把未知费用当成零；0162 的 v1 分支 |
| 发生账务冲突或关闭结果是 `unknown` | 已派发的普通结果不进入正常结算；0162 `bill2_finalize` |
| 需要查询原调用 | 必须有原 provider ID、支持 lookup、未冲突、未处于 60 秒退避；v1 只能到 `run.deadline + 24 hours`；0166 `bill2_recovery_claim` |
| 自动恢复选择 | 要求 run / execution / session 的账号和绑定相符；排除一般已终结 run、冲突及过期调用；0171 `runtime_pending_financial_batch` |
| 成本已知，只差收尾，但已经过期 | 普通自动清单仍有时间限制；这不等于手动调用已有收尾函数也被禁止 |
| 用户停止 | 0171 另有 user_stop 分支和内容重建；不能套用普通取消步骤覆盖已取得的回复 |
| 管理员“人工计量复核” | 0167 `bill2_payg_metering_review_snapshot` / `review_metering` 明确只接受 v2，不能用于 v1；也不是强制退款入口 |

源码入口：

- `packages/api/src/services/bill2/service.ts`：`recoverReceipts`、`recoverRun`、`finalizeRun`。
- `packages/api/src/services/runtime/automaticRecovery.ts`：只查询原调用，禁止新派发。
- `packages/api/src/services/runtime/executorRpc.ts`：`recoverExecutorFinancial`。
- `packages/db/migrations/0162_bill_payg.sql`：v1 finalize / close 兼容分支。
- `packages/db/migrations/0166_payg_runtime.sql`：recovery claim 的有效期和退避。
- `packages/db/migrations/0171_runtime_native_stop.sql`：当前 financial recovery 与自动清单。

“2026-09-27 创建、现在仍未结”不能单独证明超时就是最初失败原因；
创建时间也不能代替实际 deadline。即使现在已超自动查询窗口，仍需查明原收据是否存在、
是否有成本或冲突、是否运行过恢复。没有日志证据时不能断言 cron 从未执行或平台没返回成本。

## 主窗口代为执行的只读查询

完整 SQL：[BILL2_V1_PENDING_READONLY.sql](BILL2_V1_PENDING_READONLY.sql)。

在指定 staging 项目、获得相应只读授权后执行。SQL 自带 `REPEATABLE READ READ ONLY`
事务、10 秒超时和 `ROLLBACK`，只有 SELECT；不会调用领取、恢复、结算或其他写函数。
先核实短 ID 只匹配一个 run；不是 1 就停止本对象的诊断，不能挑第一条继续。
后续查询也只在唯一匹配时返回业务行。不存在或结构查询失败不是“没有待结费用”。

输出仅包含 run / execution 标识、状态、数值、日期、布尔值和计数；
不返回 actor、原 provider ID、payload、rawBody、凭证或用户内容。
完整查询结果仅留在主窗口私有交接材料；公开 PR 仅总结状态、数量和分类。
函数列表是选择性指纹，包含 v1 余额变更函数 `bill2_legacy_refund` 和 `bill2_legacy_settle`，
但仍不能证明全部依赖或部署逻辑一致，也不能代替
`packages/db/tests/baseline/fingerprint.sql` 的完整只读结构核对。
不能用仓库合并记录代替部署证据。

判读顺序：

1. 核对唯一 run、v1、日期和状态。`reserved = 48` 是原始预留额，不单独证明当前仍冻结 48。
   结合终结账务记录、release/spend 计数及主窗口已有余额证据判断；发现账务不一致先停。
2. 比对 Runtime 绑定、execution 状态、结果是否存在和 session 是否仍被占用。
   无 Runtime 绑定的独立 BILL2 run 不在 Runtime 自动清单中，不能传一个猜测的 execution ID。
3. 逐调用查 `dispatched_at`、成本、provider ID 是否存在、lookupSupported、恢复次数和最近查询时间。
   零次恢复只能证明此计数为零，不能独自证明 cron 没运行。
4. 收据区分“存在”与“已被账务认可”：`has_cost`、`final` 和 USD 标识只是线索；
   账务使用 `selected_cost_usd`，不能从未选中的收据手工抄一个成本覆盖数据库。
5. 比对实际函数指纹、恢复窗口、冲突与绑定。记录已确认的阻断条件；若资料不足，标记待调查。

## 条件式恢复步骤：本 PR 不执行

本次任务明确要求：“如果属于现有恢复流程能处理的情况，写出用现有管理员收尾或恢复机制处理的步骤，
由主窗口在 Owner 批准后执行”，并要求“不访问远端数据库”“不直接改数据”。
因此本次仅交付步骤，实际执行留给主窗口按该授权边界处理；这不是新增仓库通用审批规则，
也不要求对已经取得的有效批准再批一次。AGENTS.md 第 2 节要求遵守当前任务的明确限制。

以下为主窗口取得只读结果、核对本次有效批准范围后的交接步骤。
先绑定完整 run / execution / actor 身份，冻结调用和账务快照；恢复使用原身份和原调用，
适配器必须禁用 dispatch，只允许现有 lookup。凭证通过既有服务入口加载，不复制到 PR 或命令历史。

### A. 已有认可成本，或确认从未派发，只差结束

前提：没有冲突，账务尚未终结；Runtime 绑定准确；无仍在执行的工作。
有保存结果时必须保留它，不能为了释放冻结把结果改成失败。user_stop 的可用内容先按现有
`stoppedCompletion` 恢复路径重建，不能直接跳过。

- Runtime 绑定完整：通过受信维护调用现有 `runtimeExecutor(...).recoverFinancial(executionId)`。
  它先检查 `runtime_financial_recovery(..., p_finish=false)`，再恢复原收据，最后
  `runtime_financial_recovery(..., p_finish=true)`；原保存结果决定完成或取消，已有账务保护负责结算。
  不调用 `execute` / `resume` 来试图“继续一下”。
- 已关闭且无 Runtime 绑定的独立 BILL2 run：使用既有 `authoritativeBilling(...).recoverRun(runId)`；
  它只恢复收据并在已关闭时 finalize。未关闭、outcome unknown 或绑定不一致时不能把它描述为可直接结算，
  先进一步核实原交付结果和关闭证据。
- 若返回 `RUNTIME_EXECUTION_STILL_ALLOWED`、关闭冲突、账务冲突或仍 cost_pending，就停止并保留结果，
  不改 deadline、取消保护或伪造 `confirmed_failure`。

这不是新增管理员网页功能：现有财务报表仅有 v2 计量复核，v1 需要受信维护入口。
过期只会阻止新的 lookup；已有认可成本的最终结算本身没有相同的 24 小时限制。

### B. 成本未知，但仍满足原调用查询条件

通过上面的受信 Runtime 恢复入口查询原 provider ID；独立 BILL2 run 用 `recoverRun`。
沿用既有时限、60 秒退避和单次调用身份，禁止重新生成回复。
如果得到可信成本，按保存结果走正常结算；否则仍保留冻结并记录未解决，不声称成功。
不要触发全局恢复批次来修复单个 run，以免扩大到其他对象。

### C. 成本未知且已过窗口、缺失 provider ID、或存在冲突

现有原调用 lookup 不能处理。现有管理员 v2 计量复核也不能处理 v1。
没有可据此直接执行的“强制解冻”步骤；更不能把未知费用或收据缺失当成零成本、确认失败。
主窗口需收集原供应商费用证据和原交付结果，再决定是否需要单独授权的维护修复。
本次没有这些数据，不把“超时仍保持冻结”的既有保护直接认定为代码缺陷。
若只读证据证明现有机制违反已确认需求，再实施同范围修复并重跑相应账务回归。

## 收尾后核验及不确定结果

对相同完整 ID 重跑只读 SQL：run 应进入 settled/refunded；Runtime 应完成/取消并释放占用；
有保存回复时检查其仍存在。终结账务和 release/spend 记录按原调用只产生一次，
收费与恢复金额符合原预扣来源规则；不能把原始 reserved 全额当成应退积分。

超时或返回丢失：先重新只读查看该 run、终结账务和 ledger，确认实际结果后再决定下一步。
不要因为接口报错重复执行金融操作。若仍待核对，保持原记录并汇报。

## 验证与限制

- 源码调查：已核对上述当前迁移和服务代码；没有修改 SQL 账务函数。
- 查询验证：使用仓库文件构建的本地 PostgreSQL 空库执行只读 SQL，结果见 PR Handoff。
  这只证明查询与当前文件建库结构兼容，不证明 staging 部署结构或实际 run 状态。
- 远端数据库查询、供应商查询、实际恢复、余额解冻：NOT_RUN。
- 任务边界：本 PR 交付可执行只读查询与条件式交接，不宣称故障已修复或 48 积分已恢复。
