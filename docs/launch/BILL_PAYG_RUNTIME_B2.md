# BILL-PAYG Runtime B2

方案：[PR #553 实施说明](https://github.com/Crnobog9527/GraylumAI_vercel/pull/553)。
依赖：已合并的 #631 / 0166。风险：high（准入顺序、管理员权限、计量阻断与数据库函数）。
默认仍为 v1；不新增运行开关、消息队列或自动续跑机制。前端界面不在范围内。

## Q1：先完成原整理

同一 Session 有主回复已完成、附带整理未完成的 v2 execution 时，新消息先使用原
execution ID、cursor、epoch CAS 完成整理。继续前仍通过 B1 的余额、窗口和剩余 calls
闸门。整理成功后重新读取 Session，再准入新消息；OPC 先补整理，再执行既有 capture
和 material 流程。数据库在既有 Session 锁内再次检查，防止并发绕过顺序。

余额不足或续跑受阻时返回原 execution 的等待结果，同时附加 `admitted: false`、
`blockedRequestId`（本次新请求）、`executionId`（旧整理）。新消息尚未持久化、收费或
准入；调用方必须保留输入和原 requestId，待旧整理完成后重试。流式入口只返回 result，
不发送新任务 admitted 事件。原请求重放优先，保持幂等。

原整理处于 running、interrupted 或 cost_pending 时返回 `RUNTIME_ORGANIZER_PENDING`，
不抢占正在运行的 owner，也不把费用未知当作可继续。该错误可诊断，不启动新调用。

## 对外状态

| 状态码 | 含义与调用方动作 |
| --- | --- |
| `RUNTIME_WAITING_CREDITS` | 原 execution 等待积分；保持原断点 |
| `RUNTIME_WAITING_RESUME` | 持久化可继续状态；由明确继续入口处理 |
| `RUNTIME_USAGE_CONFIGURATION_REQUIRED` | 剩余 calls 超过分钟或每日配置容量；需要管理员调整使用额度，不能只显示稍后重试 |
| `RUNTIME_ORGANIZER_PENDING` | 原整理尚未完成，当前不能准入新消息 |
| `RUNTIME_RESUME_CONFLICT` | v1、过期 cursor/epoch 或不允许的状态；拒绝续跑 |

配置不足保留 waiting 状态，`unavailable: usage_configuration_required`；不消耗 Redis
额度，不绕过 calls 闸门。普通窗口耗尽仍按既有重试时间处理。CHAT-NATIVE-OUTPUT
#604 C2 可使用既有 waiting_resume / executionId / cursor / epoch 协议；这里没有
定时器、自动续写或后台重试。

## 管理员人工解除计量阻断

`billingReport.meteringReviewSnapshot({callId})` 读取待复核元数据。
`billingReport.reviewMetering({callId,requestId,review})` 由现有 adminProcedure 保护，
数据库再次要求未注销且 active 的管理员。review 必须包含当前 evidenceHash、冻结
profileVersion / evidenceVersion、人工复核参考 reviewReference、`humanReviewed: true`。
请求中的 actor 不受客户端控制。前端管理界面不在此 PR。

每条异常 call 单独复核；只有已结算、财务绑定完整且无 receipt/run conflict 才允许。
审核使用既有 run / model / call 锁，证据变化使旧审核失效。audit 和 call 的审核引用
在同一事务提交；重复 requestId 只接受完全相同的请求。新异常仍阻断后续 claim。
旧 run 的异常退出状态、原费用、回执与全部计量标记保持不变；审核不重新启用模型、
不重写价格配置、不自动恢复旧 run，也不能绕过窗口和余额检查。

错误码：`BILL2_METERING_REVIEW_DENIED`、`BILL2_METERING_REVIEW_CONFLICT`、
`BILL2_METERING_REVIEW_NOT_READY`、`BILL2_METERING_REVIEW_UNAVAILABLE`。

### AGENTS.md §5 最小基础设施说明

沿用 `user_activity_logs` 作为管理员操作记录。现有 best-effort 日志 helper 吞掉失败，
不足以保证解除阻断与审计原子提交，因此由受限 SQL RPC 在同一事务写入现有审计表。
新增 call 上一个 audit 外键指针及读取/人工复核两个专用 RPC；不新增表、审计系统、
队列或平行财务账本。BILL2 call/receipt 仍为计量和财务事实权威，既有审计记录只授予
对精确证据的模型级新 claim 阻断例外。私有证据摘要函数不对客户端或 service_role 开放。

## 注销等待收尾

复用既有 `account_erasure_financial_batch` 与 `runtime_financial_recovery`；数据库
确认账号已注销且财务绑定正确后，v2 waiting execution 可直接收尾，无须 Auth 刷新、
充值或价格窗口。零 call 不制造退款；未派发 hold 只释放一次；未知费用保持 cost_pending
和 hold；已结算前缀不变。返回仅含状态，不返回已删除用户正文。v1 原收尾保持兼容。

## 0167 防漂移与恢复

开工 staging：`6fccfabaf20a97df7fd2db7e0916f451ef26d36b`。按该 ref 的完整迁移在
本地 PostgreSQL 17 重建后实测 `md5(pg_get_functiondef(...))`；没有读取或应用远端数据库。

| 被替换函数 | 开工 MD5 |
| --- | --- |
| runtime_admit(uuid,uuid,uuid,jsonb,jsonb) | 1513a5cf6ac6cb1b26975036a37ed3b9 |
| opc_step_material(uuid,uuid,uuid,text,text,text) | 05865c9d70bf4f4bc3ea383d556b2125 |
| runtime_session_context(uuid,uuid) | 9a159d2e2cbf6f6bcc151410fc57564d |
| bill2_payg_claim(uuid,uuid,integer,jsonb) | a67839c4bbbe56e72cebf972a2d19ff5 |

0167 在任何 DDL 之前检查四个函数的源/目标 MD5，允许相同迁移重放，拒绝漂移。
事务失败回滚整个迁移。部署时必须先 SQL 后应用；默认 v1 不变。
需要回退时以追加迁移撤回审核入口并恢复相应函数，保留审核指针、审计、异常和金融事实，
不得删除历史费用或将已生效审核解释为退款。B1 原 execution 续跑与财务恢复仍保留。

验证结果、精确 head 与独立审查以 PR #632 的 Handoff 为准。本文件不是远端迁移授权。
