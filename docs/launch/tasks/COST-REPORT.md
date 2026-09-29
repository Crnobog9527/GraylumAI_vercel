# COST-REPORT：后台金额口径

本任务只读取既有数据，不改变 BILL2 记账或数据库结构。美元成本以 `token_stats.total_cost_usd` 已记录值为准，积分消耗以 `token_stats.total_credits` 为准；两种单位不互相换算。

| 页面与接口 | 金额来源与计算 | 性质 |
| --- | --- | --- |
| `/admin/costs`：`costs.getDashboard`、`getOverview` | `token_stats` 当日、本月美元与积分分别求和；平均每次为本月合计除以记录数 | 已记录值 |
| `/admin/costs`：`getCostTrend`、`getModelDistribution`、`getTopUsers` | `token_stats` 在所选日历天范围内分别按天、模型、用户求和；分布占比按当前所选单位求出 | 已记录值 |
| `/admin/costs`：`getCacheEfficiency` | `cached_tokens` 与 `input_tokens` 的比例乘以记录的总积分或总美元成本，再乘 90% | 粗估；缓存用量未知时显示无法估算 |
| `/admin/costs`：`getUsageLogs`、`getTokenStats` | 分页读取 `ai_usage_logs` 与 `token_stats`；Token 列表显示记录的积分消耗 | 已记录值；日志不显示金额 |
| `/admin/performance`：`admin.getPerformanceStats` | `token_stats` 美元合计、每条成本记录均价；月成本是所选区间合计按 30 天推算 | 合计与均价为已记录值；月成本为估算 |
| `/admin/performance`：同一接口 | 缓存节省按当前 `ai_models` 输入价格和缓存读取折扣估算；输入与输出拆分按总成本的 30%／70% 展示 | 估算；缓存用量或模型价格未知时显示无法估算，不能视为账单明细 |
| `/admin/finance`：`admin.getFinanceStats` | `payment_orders` 中 `status` 为 `completed`、已支付且币种为 USD 的订单金额（美分）合计；`token_stats` 美元成本合计；两者相减 | 收入与成本为已记录值；毛利仅为粗估，未扣手续费等其他费用；退款口径见下文 |

成本汇总查询按稳定顺序分批读取完整结果；分页日志与 Token 明细仍按页查询。`getDashboard` 与独立成本接口使用请求时区的日历日，避免一天范围多出一天或跨日错位。其他币种订单不做未经定义的汇率换算，排除在 USD 收入之外。

BILL2 的 `token_stats.model_used = bill2.aggregate` 是一次运行的汇总，不代表单个模型。成本页把它单列为汇总；性能页按当前模型目录列出的模型明细可能不包含这部分，但总成本仍包含全部 `token_stats` 记录。

## 退款口径

收入只统计 `status` 为 `completed` 的订单。订单发生退款后状态变为 `refunded` 或 `partially_refunded`，因此：

- 全额退款（`refunded`）的订单不计入收入；
- 部分退款（`partially_refunded`）的订单整单排除，未退还的部分也不计入，收入因此偏低。

**待 Owner 决定**：部分退款的订单是否改为按净额（已付金额减已退金额）计入收入。本次不改口径。

## 美元精度

美元合计、均价、月估算和毛利在服务端以整数皮美元（1e-12 美元）精确累加和计算，最后只转换一次数值再交给页面格式化，不用浮点逐条累加。均价和月估算按皮美元四舍五入。页面最多显示 12 位小数，因此显示的是精确合计，而不是累加误差。
