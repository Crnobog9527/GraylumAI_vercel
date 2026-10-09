# RUNTIME-PROD 止损后端

状态：实施与验证中，high（计费与调用准入）。本切片不代表整个 RUNTIME-PROD 完成。
依据：RUNTIME_PROD_PLAN 第 5–7 节、Master Plan 7.1 的 RUNTIME-PROD ⑤，
以及 [2026-10-10 批次授权](https://github.com/Crnobog9527/GraylumAI_vercel/issues/716#issuecomment-6086031987)。

## 行为与最小实现

复用 system_settings、Redis 次数限流、BILL2 冻结与结算、credit_transactions、diagnostic_results 和诊断调度。
不新建表、账本、队列、cron 或监控平台；不修改前端、远程配置或正式宿主。

- 停止开关仍是 runtime_rate_limits.stopNewCalls。原入口检查之外，SQL 在创建 call 和首次派发时再次检查。
  已派发调用按原流程读取回执与结算；停止不等于取消供应商在途请求。
- 每用户、全站美元上限为空时关闭；配置为字符串 `"0"` 则拒绝所有新计费调用。
  金额支持至小数点后 12 位，不在 JavaScript 中用浮点数累计。
- 实际美元来自现有 BILL2 v1/v2 结算事务的 credit_transactions（bill2_release）的 metadata.providerCostUsd；
  按该账本记录 created_at 的 UTC 日汇总。解除冻结账目每次结算仅一条，也保留退款调用已知的供应商成本。
  不使用名义金额、积分、冻结额或 Redis 次数替代成本。当天达到上限即拒绝新增 call。
- 单个事务级锁串行化新 call、最终派发、已结算成本写入和配置修改，不维护另一份用量计数。
  已冻结 call 不再检查美元上限，仍可结算；紧急开关会拦住它尚未获得的首次派发资格。
  并发在途费用可能使当天超过上限；本切片不是按冻结上界预留的绝对总预算。
- 触限告警在原结算事务内写入 diagnostic_results，按 UTC 日、范围、阈值去重；用户触限只存匿名聚合提示，不保存用户标识。
  现有诊断调度还会检查当前累计成本。监控配置损坏不阻断结算，但新计费调用拒绝。

## 前端接口（本 PR 不做界面）

均在已有 `runtimeRateLimits` tRPC router，使用 adminProcedure。
未登录为 UNAUTHORIZED，非管理员为 FORBIDDEN；普通 settings 写接口不能绕过专用金额校验。

| 接口 | 输入和结果 |
| --- | --- |
| `get` / `update` | 原限流配置，含 stopNewCalls；保持原合同 |
| `stopLossConfig` | 返回 `{config,source}` |
| `updateStopLoss` | 完整配置，保存后读回 `{config,source}` |
| `stopLossStatus` | 配置、当天全站实际 USD、UTC 日期和 externalNotifications=not_connected |
| `stopLossAlerts` | 最新 100 条止损告警，含类型、金额、阈值、日期和来源 |
| `recordProviderBalance` | `{provider,balanceUsd}`；仅记录管理员观察，返回 observedAt 和 source=admin_observation |

配置对象：`{version:1,userDailyUsd:null,siteDailyUsd:null,siteAlertUsd:null,
providerBalanceAlertUsd:null,notificationChannel:null}`。
四个金额字段为十进制字符串或 null。notificationChannel 只存管理员提供的渠道标签，
本切片不发送外部通知、不存 webhook 密钥。

稳定业务码：`RUNTIME_NEW_CALLS_STOPPED`、`RUNTIME_USER_DAILY_USD_LIMIT`、
`RUNTIME_SITE_DAILY_USD_LIMIT`、`RUNTIME_STOP_LOSS_CONFIG_INVALID`、`RUNTIME_STOP_LOSS_UNAVAILABLE`。
入口暂停沿用 SERVICE_UNAVAILABLE，并在 tRPC error.data.businessCode 提供 RUNTIME_NEW_CALLS_STOPPED。
执行过程中 SQL 的可信拒绝映射为固定中文 notice 与 outcome.code；错误不会泄漏数据库原文。

## 余额观察的明确限制

账户余额不等于 API key 的调用限额。OpenRouter 的
[账户余额接口](https://openrouter.ai/docs/api/api-reference/credits/get-credits)要求管理级密钥；
本切片不向应用引入这类权限，也未读取任何供应商密钥或调用远端余额接口。
当前提供管理员观察记录，明确标 manual 来源；24 小时后为 unknown，不能显示成余额充足。
支持 openrouter、tikhub、parallel、firecrawl、brightdata；余额低于或等于配置阈值告警，
缺记录或过期同样记录 unknown。具体供应商自动读取方式仍需主窗口决定，不能算自动余额监控已完成。
不配置余额阈值时，不作余额检查。阈值和渠道的实际配置留待后续批准，不以示例自动启用。

## 迁移、兼容与恢复

0201 由主窗口分配。复用现有表，追加私有 SQL 函数和触发器；没有业务配置种子写入。
新应用代码之前应用迁移；旧应用仍受数据库准入保护，旧 call、hold、receipt 和结算保持有效。
撤回应用不删除账务和告警；需要停用美元限制时，将阈值设为 null。
紧急停止保留原 runtime_rate_limits 开关，恢复调用需明确关闭它；不能靠删除账本或换调用身份回退。
本 PR 不应用远程迁移、不修改 staging 配置，不合并。

## 验证与交接

验证包括 API 单元、类型/lint、代码大小、计费和 Runtime 的无应用集成，以及：

```sh
node packages/db/tests/run-db-baseline-replay.mjs --local-only --write-built --after packages/db/tests/runtime-stop-loss.sql
```

具体结果和当前阻塞以 PR 的 Handoff 为准。
0201 的前序 0198–0200 尚未进入本任务基线；仓库要求编号连续，因此目前 CI 的迁移检查阻断。
保留主窗口分配的 0201，不填占位迁移、不放宽检查；等待前序迁移后再同步、回放和复审。
未运行浏览器、真实模型、远端数据库、真实余额接口、外部通知和正式环境。
完成独立审查后停下等主窗口审计，合并仍需批准。
