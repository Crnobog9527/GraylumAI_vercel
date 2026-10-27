# DATA-ERASURE：长对话删除的账本归属查询

本机合成数据，不连接 staging、不调用模型。所有真实触发器和约束保持开启。

## 运行

```sh
node packages/db/tests/content-erasure-perf/verify.mjs --local-only
# 负例：恢复上一版完整函数，必须在"身份解析次数"断言处失败（ERASURE_PERF_TOO_MANY_PARSES）
node packages/db/tests/content-erasure-perf/verify.mjs --local-only --before-fix
# 0404 的负例：只恢复 0404 改过的三个函数，必须在"元数据投影次数"断言处失败（ERASURE_PERF_TOO_MANY_PROJECTIONS）
node packages/db/tests/content-erasure-perf/verify.mjs --local-only --before-0404
```

CI 在现有 `Integration — Empty-database build from files` 步骤通过 `--after` 加载两个已有
fixture、`fixture.sql` 和 `assertions.sql`，复用这次建库，不额外启动一套全库回放。

数据包含 30 个账号，约 3030 个背景运行、5130 次调用、9090 条回执与历史、15150 条背景
积分账本、9090 条背景账务历史。当前账号有 1000 个无关运行（5000 条无关账本），其余
账号各 70 个。目标定位对话另有 26 次已完成且已结算的执行，每次通过真实 claim/dispatch/record 接口生成
1 个调用、1 个回执、1 积分扣费，以及必须保留的确认报告。
偏斜账号分布用于覆盖测试账号积累很多历史的情况，避免平均分布掩盖逐行重复查询。

断言同时覆盖：一次删除的身份解析次数 ≤ 10 万（结构性断言，和机器快慢无关；耗时只作为 NOTICE 输出）、五种原绑定匹配与原定义等价、未标记/其他账号/坏 UUID 不匹配、
重复删除、报告保留、无关内容逐字不变、余额和运行结算事实/积分账本条数与合计不变。

## 性能保护为什么是解析次数

原来的 2 秒墙钟断言在 GitHub runner 上偶发超过（2129 ms），而本机新函数约 1.1 秒、旧函数约 3 秒，余量太小。现在改为数一次删除里 `content_erasure_uuid` 被调用的次数（`track_functions` 加 `pg_stat_xact_user_functions`，同一事务内可读）：新函数约 5.0 万次，旧函数约 107 万次，同样的数据每次都完全相同。上限 10 万次，保留 2 倍余量，且旧函数会超出 10 倍而失败；`verify.mjs --before-fix` 用来证明这一点。墙钟耗时仍打印，8 秒的 `statement_timeout` 仍在作为最外层保护。

## 已定位的慢点和结果

2026-10-27 本机 PostgreSQL 17：含目标调用、回执和非零结算的同份数据，旧函数 2891ms
（红），新函数 1149ms（绿）；此前不含目标调用的版本为 3205ms →1078ms。
带嵌套语句和函数计时的剖析为 4422ms →1489ms；剖析会增加开销。
旧函数在每条账本上先找到账号已删除的运行，再对每个候选重新解析 JSON 内编号。
当次删除约执行 106 万次 UUID 解析；0399 将每行的六个编号先物化一次，然后按运行单
主键和预扣单唯一索引查询，约 4.9 万次。`OFFSET 0` 保持先按编号查询，再过滤账号与
删除标记，防止计划重新退回按账号逐个比较运行。

这是本机相同总量及偏斜分布的复现，没有宣称复刻 staging 的准确 8 秒。未访问 staging
查询计划；上库后仍需由总控核对实际耗时。本机迁移能重复执行；回退时执行 `rollback.sql`
恢复之前的完整函数定义即可，没有数据格式变化或需要恢复的数据。

## 0404：擦除一条账本行的单行成本

2026-10-27 staging 第十八批 A1 删除长对话 8 秒超时（57014）。staging 只读数据：这个会话自己的 26 个运行拥有 1382 条账本行
（692 credit_transactions、228 billing_history、231 token_stats、231 ai_usage_logs），`erasure_ledger_guard` 恰好调了 1382 次：
不是扫了整个账号，而是每擦一行都很贵：语句自己投影一次元数据，守卫触发器再投影 NEW 和 OLD 各一次（每行 3 次，每次递归
`erasure_ledger_value` 遍历白名单形状的全部约 80 个键）。0404 让 `erasure_ledger_value` 只遍历值和形状共有的键、
`content_erasure_confirm` 不再自己投影（守卫写同样的投影）、`erasure_ledger_guard` 在 OLD/NEW 元数据相同时只算一次，
并让账本语句先用普通比较挑出命中账号已删内容运行的行，再调 `content_erasure_ledger_owned`。擦除结果不变。

夹具：被删会话的 26 个运行各自补到约 40 条账本行（credit_transactions 约 1000、billing_history 约 520，另有 token_stats /
ai_usage_logs 各 26，约 1590 行，比 staging 的 1382 略多），同账号另有 5000+ credit_transactions、3000+ billing_history。
断言：一次删除里元数据投影次数 ≤ 擦除行数的 1.5 倍（旧 4758 = 3 倍，新 1586）；`content_erasure_ledger_owned` 调用 ≤ 擦除行数
的 2.5 倍（旧 11174，新 3172）；每个被擦的行都等于"原元数据按旧实现投影"的结果、文本字段清空、其他列不变；`erasure_ledger_value`
对库里全部元数据加若干边界值，与保留在测试里的旧实现返回相同的值或同样报错。本机耗时：旧 2346 ms，新 1057 ms。
