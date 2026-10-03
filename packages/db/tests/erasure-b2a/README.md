# DATA-ERASURE B2a：0156 SQL 切片

按 [PR #550 总控协调](https://github.com/Crnobog9527/GraylumAI_vercel/pull/550#issuecomment-5929618776)，
在原分支普通 merge staging `da4aa6be5084e329d40fb6bb6b760965c91f16e5`，
将未编号 SQL 正式登记为 `0155_erasure_b2a.sql`；按[编号决定](https://github.com/Crnobog9527/GraylumAI_vercel/pull/497#issuecomment-5933388205)，
合入 #497（占用 0155）后改名为 `0156_erasure_b2a.sql`。0151–0154 已在目标分支；
0156 由原 canonical builder 在历史顺序中（#497 的 0155 之后）执行并重复校验，不再需要临时入口。
本切片仍仅为不与 #497 重叠的 SQL 收尾和 BILL2 服务层；禁止应用远程迁移。

## 权威和边界

原文来自 `9a5554ca4780aab9c206e6fad680f28efde43e87` 文件建出的 PostgreSQL，
18 个函数的 MD5/长度与 #544 的 Q1 一致（PR #550 表格保留核验记录）。
本切片只重写 B2a 的五个函数，`source-md5.json` 固定它们的来源。
迁移在任何持久修改前逐个检查旧原文或本切片精确新原文；来源漂移立即失败。
已有 owner、SECURITY DEFINER、search_path、ACL 保持；两种客户端角色均无调用权。封闭判断只是谓词；普通停用账号原有受限财务恢复继续保留，
但不能借注销例外越过原 read/未发送撤权的 actor 门槛。

没有新表、账本或恢复状态机。原 run/call/预扣仍为计费权威，原注销请求/封闭 profile
决定受限例外。四个私有 helper 只复用封闭判断和递归白名单，不增加服务可调用 RPC。
五列投影元数据用于区分原证据去重 hash 与财务投影 hash/版本/时间，旧行不回填。
仅未知结果不退款；可靠 ID 的三次/原 deadline 后 24 小时限制原样复用。
正文不能藏进 transport、Base64/gzip、usage.sdkResponse 或任意嵌套值。
模型不匹配保留冲突事实并清除任意模型自由文本；不因此允许结算。

Runtime SQL 按原财务 outcome 推终态，不回填结果，scrub 在财务事务提交后单独调用。
B2b 的四个函数和历史数据脱敏/解绑不在此切片，原 immutable 约束仍拒绝普通改删。
结构回退仅用于无投影数据的本地测试；一旦写过投影，`rollback.sql` 拒绝回退，必须前向修复。
不恢复已清除内容。

## 本地验证

```sh
node packages/db/tests/erasure-b2a/run-local.mjs --local-only
```

只接受本机 Docker unix socket，数据库只绑定 loopback；不读取数据库 URL 或环境凭据，
不调用模型/支付。复用 baseline 文件建库及固定 PostgreSQL 镜像；在首次执行 0156 前核对
五个原函数的 Q1 MD5，0156 随正式迁移重复执行并逐对象比较结构。
用实际新事务验证来源漂移原子拒绝、无数据回退/重放、五 RPC 客户端拒绝、服务端允许、
越权/暂停账号拒绝、未发送证明、财务精度/幂等/冲突、故障全退后迟到成本、未知预留、
查询次数/期限、空正文 Runtime 终态/B1b 组合、故障回滚和双连接注销/收据锁竞争。
`local-catalog-delta.json` 是本切片结构增量摘要，不替代 canonical built 指纹。
`local-result.json` 是本切片本地实际结果，不代表远程迁移或完整宿主验收。
canonical built 指纹由 `run-db-baseline-replay.mjs --local-only --write-built` 生成并提交，
staging 快照保持原样，不能以本地建库冒充远程迁移已应用。

`--local-only --development` 仅省略历史迁移逐次指纹重放，用于迭代；正式结果必须使用上面的完整命令。

编号后的 SQL 已被现有 BILL2/Runtime CI 同款集成入口自动纳入，无须改测试或入口：

```sh
node packages/db/tests/v3/run-workbench.mjs --bill2-core-only --without-app --schema-from-files
node packages/db/tests/v3/run-workbench.mjs --runtime-only --with-staging-schema --without-app --schema-from-files
pnpm test:ci:safeguards
ruby .github/scripts/test-ci-workflows.rb
```

迁移账本沿用原 exact-base、连续编号和历史文件不可改写的契约，不新增例外或放宽检查。
实际运行结果见 PR Handoff；旧切片的测试数量不作为新 head 的验证证据。

## 宿主接入（合入 #497 后）

SQL 是权威：确认注销后，`bill2_actor` 拒绝这个主体的所有 Runtime 读写（读回响应、写 Session、
保存结果、工具调用），所以晚到内容进不了 SDK 历史、执行结果或成果副本。宿主只做两件事：
`dispatchOnce` 报告 `accountClosed` 后立即停止，不读回正文、不交给 SDK，也不再调用注定失败的
状态 RPC；封闭之后不再向前端发送任何进度。执行停在未完成状态，由可信维护调用
`runtime_financial_recovery` 收尾，不重新派发。

`streaming.integration.ts` 用真实 SDK、执行器、BILL2 和本机 PostgreSQL 验证：
- 供应商调用途中确认注销（非流式和 v5 五字段卡片两种格式）：回执只保留财务投影；没有正文、
  卡片或保存阶段事件；Session 和执行结果里没有晚到内容；封闭后只有那一次回执记录，没有别的
  Runtime 调用；之后可信恢复把执行推到 cancelled、按实际成本结清一次，不再派发；
- 回执记录之后、Session 写入之前确认注销：不显示卡片，不保存这一轮。

已知边界：SQL 确认封闭之后，执行器不再产生新的进度；但有三段检查与发送之间的时间差无法
消除，内容都是用户这一轮自己的回复，只发往发起请求的那个已登录连接：
- 流式格式（v3/v4 和 v5 开场）在"派发"到"回执记录"之间实时转发的增量；
- `executionStream.ts` 对回执前已产生的文本事件最多缓冲 100ms，可能在封闭之后才发出；
- 注销恰好在最后一次 Session 写入成功之后、执行器发送最终进度之前提交时，这一轮的回复或
  卡片仍可能发出。
v5 带卡片的导师回合本来就缓冲正文，只受最后一种影响。

封闭后执行停在 pending/running，预扣保持冻结，直到可信调用方执行 `runtime_financial_recovery`。
目前仓库里没有针对已注销账号的自动调用方，自动收尾由 PR-C 编排。
本目录的 SQL 用例（`run-local.mjs`）目前只在本机运行，计划在 B2b 接入 CI。调用失败后保留的 pendingReceipt 仍是仅限可信宿主的内存恢复证据，
不能进入公开响应。浏览器端到端验收、总控实施审阅和最终独立审查仍待完成。
