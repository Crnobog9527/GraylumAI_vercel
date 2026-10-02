# BILL-UNIT：0157 SQL 本机验证

`packages/db/migrations/0157_bill_unit.sql`（#565）做三件事：

1. `ai_models.price_multiplier`：模型单独的加价倍数，可空（空 = 继承全站默认），CHECK 1–20、最多两位小数，不给 anon / authenticated 列权限。
2. 替换 `bill2_claim`、`bill2_finalize`：`payload.rules` 带 `billingUnit` 对象的新合同运行单，每次调用冻结自己的倍数（`payload.billingUnit.multiplier`，必须等于对应 callPolicy 条目的 `multiplier`，且 `modelId` 一致），预留按 `ceil(q × (Σ上界_j × m_j + 本次上界 × m_i))` 检查，结算 `ceil(q × Σ(cost_i × m_i))` 只进位一次。没有 `billingUnit` 的旧合同运行单逐字走原来的 `ceil(Σcost × q × m)` 分支。`bill2_prepare` 不改：新合同的 `rules.multiplier` 是本运行单获准倍数的最大值，预留仍成立。
3. `bill2_admin_call_report`：只读、只给 service_role 的财务投影，数字以文本返回；`bill2_calls(created_at, id)` 索引供它按时间窗读取。

替换前核对两个原函数的 MD5（`source-md5.json`，来自 0108 / 0105 的原文）；迁移也接受本文件自己的输出，所以可以重复执行。来源不符时整个迁移在任何修改前失败。

## 运行

```sh
node packages/db/tests/bill-unit/run-local.mjs --local-only
```

只接受本机 Docker unix socket，数据库只绑定 loopback；不读取数据库 URL 或环境凭据，不调用模型或支付。用 baseline 文件建库和固定的 PostgreSQL 镜像，在首次执行 0157 前核对来源 MD5，并在完整建库中逐个迁移重放比较结构。验证内容：

- 0157 重复执行结构不变；无数据回退（`rollback.sql`）精确还原到 0157 之前的完整结构；再次执行得到同一结构。
- 来源漂移时整体拒绝、结构不变；已有其他类型的 `price_multiplier` 列时整体回滚。
- 通过真实的 `bill2_prepare` → `bill2_claim` → `bill2_dispatch` → `bill2_record` → `bill2_close` → `bill2_finalize`：
  - 旧合同按原算法收费（0.0002 美元 × 1000 × 1.5 → 1 积分；0.0021 美元 → 4 积分）。
  - 新合同混合倍数（2 和 3、各 0.002 美元、q=100）收 1 积分，统一倍数 3 收 2 积分；重复结算幂等。
  - 每次调用的倍数被改低、换成别的模型的、缺失、为 0、超过两位小数、`modelId` 不对、高于运行单预留倍数时都拒绝，且不留调用记录。
- 报表函数只给 service_role，返回冻结的 m_i 和文本数字；私有辅助函数和 bill2 表仍拒绝 API 角色。
- `price_multiplier` 的 CHECK 边界和列权限。
- 一旦有新合同运行单，回退拒绝执行，必须前向修复。

`--local-only --development` 省略历史迁移的逐次重放，只用于迭代；正式结果用上面的完整命令。

0157 已由建库计划自动纳入，现有 CI 集成入口照常覆盖旧合同：

```sh
node packages/db/tests/v3/run-workbench.mjs --bill2-core-only --without-app --schema-from-files
node packages/db/tests/v3/run-workbench.mjs --runtime-only --with-staging-schema --without-app --schema-from-files
node packages/db/tests/run-db-baseline-replay.mjs --local-only
```

把 0157 应用到 staging 需要 Owner 另行批准，按既定流程：只读预检（两个函数的 MD5）→ 指纹前 → 应用 → 账本核对 → 指纹后对比 built。本机建库不代表远程已应用。
