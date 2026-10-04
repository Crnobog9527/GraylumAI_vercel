# BILL-PAYG Runtime B1

按 [#553 实施说明](https://github.com/Crnobog9527/GraylumAI_vercel/pull/553) 和 Owner 的 B1/B2 拆分落地。
风险 high；默认准入仍为 BILL2 v1。只有可信服务端组合传入 `LocalRuntimePolicy.payg` 才创建 v2，浏览器不能选择合同或报价，没有新增环境开关。

## 状态及接入协议

`runtime.execute`/`executeStream` 读取等待中的原 execution 时不会继续调用模型。
可信宿主或未来 CHAT-NATIVE-OUTPUT 通过 `runtime.resume` 显式提供
`{ executionId, cursor, epoch }`；三个字段来自原 execution 的服务端结果或 `runtime.view`。
这不是新消息：不重复 admission 桶，但在获得新 epoch 之前按剩余可领取 call 数重新经过 calls 桶。
拒绝或限流服务失败时保持原等待及已收费前缀。两个并发继续请求只有一个 CAS 成功。
同一 epoch 还约束执行者的失败、检查点、完成、内部取消、Session 与工具写入；
这些操作复用 `runtime_execution`，在同一 Session/execution/run 锁内核验 `{epoch,value}`，
再调用原 Session/tool/cancel 能力。旧执行者迟到不能改写新执行者的状态、hold 或内容。
用户主动取消和 receipt/财务收尾保持各自原权限；不以旧执行者的 epoch 阻断收款事实落地。

| state / code | 含义和调用方动作 |
| --- | --- |
| `waiting_credits` / `RUNTIME_WAITING_CREDITS` | 锁内可用积分低于下一 call 启动门槛；充值后显式继续原任务，不重发原请求。 |
| `waiting_resume` / `RUNTIME_WAITING_RESUME` | 当前 HTTP 时间预算耗尽或未派发授权过期；保留原任务继续 token。无后台、定时器、webhook 或自动续跑。 |
| `unavailable: call_limited / paused / limit_unavailable` | calls 闸门拒绝，state、cursor、epoch 不变。 |
| `unavailable: RUNTIME_PRICE_UNCONFIRMED` | 没有可信价格检查能力；保持等待。 |
| `unavailable: RUNTIME_PRICE_CONFIGURATION_PENDING` | 价格上涨或原窗口不可用；管理员处理，不能把充值当成修复方法。 |
| `RUNTIME_RESUME_CONFLICT` | HTTP 412，token 已过期；刷新原任务状态，不能盲重试。 |
| `RUNTIME_RESUME_SOURCE_CHANGED` | HTTP 412，会话/资料版本变化；保留旧输出，处理冲突或另起明确的新操作。 |
| `RUNTIME_RESUME_CLOSED` | HTTP 412，run 已终结、取消或冲突阻断。 |
| `RUNTIME_CHECKPOINT_PENDING` | HTTP 412，旧调用财务事实尚未确认；不可重新派发。 |
| `RUNTIME_CALL_LIMIT_REACHED` | HTTP 412，本 run 原次数上限已用完；不重置上限或继续领 call。 |

等待结果还返回 `executionId/cursor/epoch/remainingCalls`；已经保存主回复时返回其 `body`。
对前端的 HTTP 错误只包含以上有限代码及可读提示，不包含数据库正文。
额度配置小于剩余 calls 的单独诊断属于 B2，与本 run 次数耗尽不同。

#604 当前已合并文档的 C2 是停止，第 13 节列出后续自动续写；本 PR 只提供它将来可复用的状态和 CAS 接口，不实现该调度机制或前端。

## 计量、恢复与权威

最终 provider 请求经过规范化与缓存标记后，以 UTF-8 字节计算 B，再算 T=B+K+M、U 和 G；
BILL2 在原钱包锁内判定 A/L 并冻结 H=min(G,A)。每个成功 call 保存 receipt 后立即结算，再进入下一步骤。
恢复用原 Session、冻结输入、provider response 和 toolCallId 结果重放；已完成的模型调用不重新派发。

staging 从 `admitPricing` 实际核对的同一快照冻结 nominalPricing 到 callPolicy；窗口仍只保留原批准费率，
不要求修改旧窗口。续跑重新核对报价和原窗口，不迁移窗口、不放宽预算。
生产 Runtime 尚未开放（现有合同仅 isolated/staging_test）；为未来生产接入提供的 `deriveProductionPaygPricing`
只接受新鲜且已持久化的快照，每次按 T 派生，拒绝 fresh_unwritten。它不是生产派发入口，
不能绕过现有 SQL 冻结报价等式；生产宿主接线仍由 RUNTIME-PROD 范围完成。

原 run.deadline 保留为初始事实；每 epoch 的派发时间为 265 秒，每 call 固定派发截止与截止后 24 小时恢复界限。
派发或 unknown 不走重领。只有确定未发送的 prepared/一次性未发送证明，才能取消原 call、释放其 hold、
保存 retryable 标记并用后续 sequence 关联 `supersedes_call_id`。次数、staging 费用上限仍包含这些原调用。

## AGENTS §5：最小持久化增量

复用 bill2_runs/calls、runtime_executions/sessions、receipt、session batches 和 tool results。
旧 run payload 不可变且没有恢复派发权；旧 live 仅授权第一次 prepared。
因此缺少的最小能力是原 run 的 cursor/epoch/有界 checkpoint、派发期限，及原 call 的固定期限和取消关联。
新增列保留在这些原表；不建表、钱包、账本、队列、调度器或通用工作流。
checkpoint 与 pausedReason 的 JSONB 文本合计不超过 65536 字节。它引用原 execution/run 的已有结果，
记录下一 sequence、requestHash、phase 和会话/资料版本，冻结载荷与 primary_result 不被覆写。
财务权威仍是 BILL2 与原钱包/来源账；内容权威仍是 Runtime Session 和已持久结果。

## 迁移与回退

0166 来源为开工时 staging `1016f75f384bb91d5b1f52913a25591ce3596377`。
以该提交全部迁移本机重建 PostgreSQL 17 后读取 `pg_get_functiondef` 并实测 MD5，未访问远端数据库。
迁移同时接受准确源/目标 MD5，因此可连续回放，其他漂移在任何 DDL 前拒绝。

| 替换函数 | 开工源 MD5 |
| --- | --- |
| `runtime_execution(uuid,uuid,text,jsonb)` | `f497b1c3d026b7182a98c15d4def9dba` |
| `bill2_payg_claim(uuid,uuid,integer,jsonb)` | `0e9af3688e33e3adc1d1400a3561b01e` |
| `bill2_dispatch(uuid,uuid,uuid,uuid,boolean,jsonb)` | `3a41fc21404ee5b541760704a9f7a387` |
| `bill2_recovery_claim(uuid,uuid,uuid)` | `f32d401cae96f9a2758c7d5345375d5b` |
| `bill2_revoke_unstarted_dispatch(uuid,uuid,uuid,uuid,text,boolean)` | `e8d056e17c4dfc9d52b7770e8e34c6b3` |
| `runtime_response(uuid,uuid,integer,text)` | `086f4d7ca79938e11c9d7c06bf8cd06f` |
| `bill2_payg_finalize(uuid,uuid)` | `9ddbd0ebb4d5972fe24fa4aab4ad61dd` |
| `runtime_test_window_allowed(uuid,jsonb)` | `ac72346ea6a895fc568247ac2cef3db6` |
| `runtime_view(uuid,uuid)` | `5671d0de602bf6e9c2ac4c7621fb5139` |
| `runtime_pending_financial_batch(uuid,integer)` | `48965682aa5d34a4d5fafa0bed90c732` |

迁移执行在单一事务，失败回滚结构、函数、ACL；测试覆盖每个源函数漂移拒绝、事务故障回滚、
历史位置连续两次回放、双连接 CAS、相同 claim 幂等、旧 epoch/token 拒绝、原载荷不变、65536/+1边界。
双客户端还覆盖新 epoch 已领取 hold 后的 11 类旧执行者迟到写入拒绝；
核对 Session、执行状态、call/hold 和工具事实不变，并证明新 owner 仍可写入和派发。
应用后的回退用向前迁移停掉新的 v2 准入/继续并保留新增列和旧函数的财务恢复能力，
不得直接覆盖回 v1-only 函数、删列或删除已发生的费用。v1 可继续使用。
B1 自身具备完整 per-call 钱路；B2 只叠加产品和管理员处理，不是 B1 结算的前提。

B2 留项：Q1 先整理再处理新消息、使用额度不足诊断、人工复核解除及审计、等待账号注销收尾。
本次不执行远端迁移、配置修改或付费调用，保持 draft 待总控审查。

开工时源码文件 MD5（同一 staging 提交）：

| 文件 | MD5 |
| --- | --- |
| `packages/api/src/services/runtime/execute.ts` | `490646b66368aa889a9b3525a62c739e` |
| `packages/api/src/services/runtime/admission.ts` | `9cad070670f963c816454c408cb45902` |
| `packages/api/src/services/bill2/service.ts` | `37cad4858776d2b390a18d4945c5b970` |
