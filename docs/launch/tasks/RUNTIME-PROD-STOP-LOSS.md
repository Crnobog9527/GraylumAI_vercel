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
| `stopLossStatus` | 配置、当天全站实际 USD、UTC 日期和 externalNotifications=email（切片 C 起） |
| `stopLossAlerts` | 最新 100 条止损告警，含类型、金额、阈值、日期和来源 |
| `recordProviderBalance` | `{provider,balanceUsd}`；仅记录管理员观察，返回 observedAt 和 source=admin_observation |

配置对象：`{version:1,userDailyUsd:null,siteDailyUsd:null,siteAlertUsd:null,
providerBalanceAlertUsd:null,notificationChannel:null}`。
四个金额字段为十进制字符串或 null。notificationChannel 为去除首尾空白后 1–100 个 Unicode 字符的渠道标签，
只是备注，不决定发送去向；本切片不存 webhook 密钥。外部通知见下方“告警外发（切片 C）”。

稳定业务码：`RUNTIME_NEW_CALLS_STOPPED`、`RUNTIME_USER_DAILY_USD_LIMIT`、
`RUNTIME_SITE_DAILY_USD_LIMIT`、`RUNTIME_STOP_LOSS_CONFIG_INVALID`、`RUNTIME_STOP_LOSS_UNAVAILABLE`。
入口暂停沿用 SERVICE_UNAVAILABLE，并在 tRPC error.data.businessCode 提供 RUNTIME_NEW_CALLS_STOPPED。
执行过程中 SQL 的可信拒绝映射为固定中文 notice 与 outcome.code；错误不会泄漏数据库原文。

## 告警外发（切片 C）

`stopLossNotify.ts` 把最近 24 小时内还没送达的止损告警逐条发邮件给 Owner（每条一封，每次运行最多 3 封、8 秒内，其余下一次运行再发），复用 PAY-NOTIFY 的 Resend 通道：
密钥用后台“第三方密钥”的 resend 槽，收件人是系统设置里的 `support_email`（与专家诊断预约提醒同一地址），
非正式站只发给 `PAYMENT_NOTICE_TEST_RECIPIENTS` 里的地址，邮件主题带 `[staging]`。
不新增表、队列或定时任务：发送状态写回同一条告警的 `details.notify`（sent / pending / failed、次数、错误码），
已送达的不再发；Resend 幂等键是告警 id 加整封邮件（收件人、发件人、主题、正文）的哈希：重试请求完全相同，只会送达一次；期间改了收件地址或模板则成为新请求，不会撞上幂等冲突。
传输失败最多重试 5 次后标 failed；缺密钥、缺收件地址、收件人不在测试名单这类配置问题不消耗次数，改好后自动补发。
每次失败都记 error 日志，后台告警列表逐条显示“已发邮件通知 / 会自动重试（错误码）/ 已停止重试”。
邮件正文只取金额、日期、供应商等白名单字段，不含用户标识、正文或密钥。
发送在告警落库之后、在原监控之外进行，任何失败都不影响止损拒绝调用，也不删除告警记录。

触发点：`/api/cron/runtime-recovery`（每分钟，Vercel Pro 后生效）在恢复之后调用；
每日诊断和后台手动运行“Runtime 成本与余额告警”检查时也会调用。上线前 Vercel 未升级 Pro 时，时效以每日诊断为准。

## 余额观察的明确限制

账户余额不等于 API key 的调用限额。OpenRouter 的
[账户余额接口](https://openrouter.ai/docs/api/api-reference/credits/get-credits)要求管理级密钥；
本切片不向应用引入这类权限，也未读取任何供应商密钥或调用远端余额接口。
当前提供管理员观察记录，明确标 manual 来源；24 小时后为 unknown，不能显示成余额充足。
支持 openrouter、tikhub、parallel、firecrawl、brightdata；余额低于或等于配置阈值告警，
缺记录或过期同样记录 unknown。当前阶段已确认采用上述手动观察；自动读取另行设计只读权限方案，不能算自动余额监控已完成。
不配置余额阈值时，不作余额检查。阈值和渠道的实际配置留待后续批准，不以示例自动启用。

## 迁移、兼容与恢复

0202 由主窗口于 2026-10-10 重新分配，排在 #774 的 0200、#766 的 0201 之后。复用现有表，追加私有 SQL 函数和触发器；没有业务配置种子写入。
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
0202 的前序 0199–0201 已随 staging 同步，迁移编号连续；指纹由完整文件链重新生成。
保留主窗口重新分配的 0202，不填占位迁移、不放宽检查；最终检查和独立复核结论记录在 PR。
未运行浏览器、真实模型、远端数据库、真实余额接口、外部通知和正式环境。
完成独立审查后停下等主窗口审计，合并仍需批准。
