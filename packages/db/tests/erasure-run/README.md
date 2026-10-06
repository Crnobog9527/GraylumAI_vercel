# DATA-ERASURE B2b：原运行单正文清除（0182）

对应 PR #699；依据 DATA-ERASURE §3 和 #674 的 B2b → PR-C 顺序。
仅清理 `bill2_runs.payload/result/scope`，不代表整个账号注销完成。

## 调用与数据边界

`account_erasure_scrub_run(profile, run)` 只授予 service_role，无自动调用方。
沿用 run → calls → receipts → profile 锁序；真实注销记录、deleted 状态和原 v1/v2
财务绑定都必须满足。调用集合未关闭时返回 remaining=1 / call_set_open；先由原恢复路径
关闭，再用新事务推进。本函数不取消执行、不派发、不查供应商、不退款或改变财务终态。
返回 processed/remaining 只指这个 run 的三个内容字段，不包含正文或错误原文。

- payload：逐层白名单重建，清掉 input、scope、sessionRef、额外字段及嵌套正文。
  保留契约/规则版本、内部模型/工具版本编号、操作类别、冻结预算、时间、
  汇率、billingUnit 和调用策略；PAYG 的原 nominalPricing 阶梯、时段、缓存价格及报价上限
  保持原精确表示。财务标识沿用创建时的非空字符串规则，允许空格、符号和 Unicode；
  UUID 接受大小写。不添加会卡住合法历史 run 的新字符限制。对象/数组不能藏进标量，
  非法财务值报错且整笔不改，不能假报完成。
- scope：清成空对象。session_ref 原列不变，解绑是后续独立边界。
- result：复用 B2a outcome 投影（kind/evidenceHash/evidenceRefHash），既有投影不重复哈希。
  原结果引用可能含正文/URL，因此仅保留既有 B2a 摘要，不把摘要说成原始证据备份。
- 未决/unknown 仍保留原预留、真实 call/receipt/供应商编号和冻结财务策略；不猜测零费用。
  原按 ID 核对、迟到 close、汇率换算、一次结算/退款继续可用。

已有对象缺少“payload 已擦除”的事实：仅追加 content_erased_at 一列。
按正文指纹清除规则删除 payload.sourceHash，不记录原 payload 摘要；run/request/call 的
原编号和既有财务幂等证据保持不变。没有新表、RPC 家族、队列或调度；原 run/call/receipt/账本仍是唯一权威。
不允许已擦除 payload/scope 回填、清除标记回退或重新提交原正文 result；迟到 close 只接受
现有 B2a 财务投影。普通账号路径不变，旧客户端仍调用原 RPC，且没有新增表写权限。

## 验证与恢复

```sh
node packages/db/tests/erasure-run/run-local.mjs --local-only
node packages/db/tests/run-db-baseline-replay.mjs --local-only --write-built
```

runner 仅允许本机 Docker Unix socket 和 loopback 临时数据库，不接受业务数据库 URL，
不读取业务环境文件。使用合成数据和 PostgreSQL 17；清理本次创建的容器。
用例也接入既有 BILL2 required 集成入口，不修改 CI/workflow/豁免清单。
覆盖允许/拒绝、伪封闭、v1/v2、精确金额及财务快照、递归清除、正文指纹不残留、重复推进、
迟到费用/结果、FX、故障全退后迟到成本、Runtime 恢复与 B1b、两连接实际锁竞争。
完整 runner 还覆盖迁移在历史位置重复执行、精确空事实回退/重应用及有事实拒绝回退。

rollback.sql 只在没有任何 run 清除事实时允许恢复旧结构；开始清除后前向修复，
不恢复正文、不反转财务终态。撤回代码不能恢复已删数据。

## 未完成边界

异常收据仍按 0181 跳过并计入 manualReview，最少保留证据之外的正文尚待处理。
call payload、公共财务字段和支付快照、terminal session_ref 解绑也未由本片清除。
PR-C 的编排/Storage/资料去身份/Auth 删除、PR-D 单条删除、日志/备份/第三方及
财务到期清理仍未完成。非法历史财务值必须继续记失败，不适用本片“remaining=0”。
本片没有达成整体在线 24 小时删除承诺。

不访问远端数据库、不应用 staging 迁移、不改配置、不合并。完成 CI/Security 和独立
审查后交主窗口审计，迁移应用与合并由主窗口在批准后执行。
