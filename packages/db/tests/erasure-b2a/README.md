# DATA-ERASURE B2a：未编号开发切片

此切片按 PR #550 的总控协调，仅实现不与 #497 重叠的 SQL 收尾和 BILL2 服务层。
`PENDING_erasure_b2a.sql` 是实际开发 SQL，不是占位迁移、不预占编号。
它刻意不满足迁移账本命名规则，普通文件建库也不会选择它。迁移账本失败必须如实保留。
等 #538 → #539 → #540 合并后，刷新 staging，分配下一个编号、更新 canonical built 指纹，
再做完整候选验证。禁止应用远程迁移。

## 权威和边界

原文来自 `9a5554ca4780aab9c206e6fad680f28efde43e87` 文件建出的 PostgreSQL，
18 个函数的 MD5/长度与 #544 的 Q1 一致（PR #550 表格保留核验记录）。
本切片只重写 B2a 的五个函数，`source-md5.json` 固定它们的来源。
迁移在任何持久修改前逐个检查旧原文或本切片精确新原文；来源漂移立即失败。
已有 owner、SECURITY DEFINER、search_path、ACL 保持；两种客户端角色均无调用权。

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
不调用模型/支付。复用 baseline 文件建库及固定 PostgreSQL 镜像；153 步建库、84 个历史
迁移重复执行，然后显式应用开发 SQL 两次并逐对象比较结构。
用实际新事务验证来源漂移原子拒绝、无数据回退/重放、五 RPC 客户端拒绝、服务端允许、
越权/暂停账号拒绝、未发送证明、财务精度/幂等/冲突、故障全退后迟到成本、未知预留、
查询次数/期限、空正文 Runtime 终态/B1b 组合、故障回滚和双连接注销/收据锁竞争。
`local-catalog-delta.json` 是本切片结构增量摘要，不替代 canonical built 指纹。
`local-result.json` 是这一开发切片本地实际结果，不代表远程迁移或 CI 完成。

`--local-only --development` 仅省略历史迁移逐次指纹重放，用于迭代；正式结果必须使用上面的完整命令。

现有 BILL2 集成入口会用 git 已跟踪文件创建无凭据副本。因此暂存本切片后，复制
`tests/v3/run-workbench.mjs` 为同目录临时文件，仅在成功 `buildFromFiles` 后插入
`apply("packages/db/migrations/PENDING_erasure_b2a.sql")`，运行原
`--bill2-core-only --without-app --schema-from-files` 套件，随后删除临时入口。
原入口和 Runtime 集成文件没有改动，不分配测试迁移编号。

本地结果：API 145 文件、3122 通过/3 跳过；BILL2 集成 79/79 通过；API lint/typecheck 通过。
迁移账本实测失败：`Malformed migration filename: PENDING_erasure_b2a.sql`（协调中的预期阻塞）。

## 仍未完成

#497 合并前不改 execute.ts、executionStream.ts、Runtime 集成测试。
当前服务层成功落收据后再次检查封闭状态并抑制 observation；这不足以证明整个宿主安全。
SDK history、成果/研究副本以及 stream/最终回包前的封闭竞争，需要后续宿主接入和集成验证。
调用失败后保留的 pendingReceipt 仍是仅限可信宿主的内存恢复证据，不能进入公开响应。
当前 SQL 功能可独立验证；完整 Runtime/浏览器验收、CI 全绿、总控实施审阅及最终独立审查尚未完成。
