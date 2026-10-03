# RATE-LIMIT 前端接线清单（交给 Claude）

本任务 Owner 将界面组件实现交给 Claude。本文是实施说明，不代表界面已经完成或通过验收。
依据 `RATE_LIMIT_WIRING_PLAN.md` 第 2.6、4、6、8 节；#590 后端已接线，enforcement 三项均为 true。
以下错误码、执行结果原因和固定文案保持原方案不变；界面及浏览器验收由单独前端 PR 完成。

## 固定提示与返回契约

服务端消息拒绝使用 `RateLimitError`，tRPC `data.retryAfter` 保留。仅接受以下固定提示，
不要展示任意服务端内部异常，也不要在被拦时自动重试。

| 情况 | 消息准入错误码 | 执行结果原因 | 提示 |
| --- | --- | --- | --- |
| 分钟超限 | TOO_MANY_REQUESTS | call_limited | 操作过于频繁，请稍后再试。本次被拦截的调用不扣积分。 |
| 日超限 | TOO_MANY_REQUESTS | call_limited（不区分窗口） | 近24小时使用次数已达上限，请稍后再试。本次被拦截的调用不扣积分。 |
| 暂停 | SERVICE_UNAVAILABLE | paused | AI服务暂时暂停新调用，请稍后再试。本次被拦截的调用不扣积分。 |
| 配置或 Redis 故障 | SERVICE_UNAVAILABLE | limit_unavailable | 暂时无法确认使用额度，请稍后再试。本次被拦截的调用不扣积分。 |

执行结果 `call_limited` 始终使用分钟提示。消息错误可按固定文字白名单识别日提示。
共享常量位于 `packages/api/src/shared/runtimeGateMessages.ts`；前端可按仓库已有相对导入方式复用。
输入、requestId 和恢复记录保留，同一个请求稍后可重提。刷新后被取消轮次显示原有“已停止”，
本次不将原因写数据库，不改 `agent-turn-display.ts`。

## 需要改动的位置

- `apps/web/src/app/positioning/[draftId]/admission-message.ts`：识别 TOO_MANY_REQUESTS，
  用固定提示替代“结果未知”；503 只对白名单中的暂停/额度不可用文字作对应映射。
- 同目录 `mentor-turn.ts` 的 `turnResultNotice`：映射三个执行结果原因，并补单元测试。
- 同目录 `topics/page.tsx`：`failureMessage` 识别 429/503；读取 execute 返回结果并显示原因。
- `apps/web/src/app/runtime/page.tsx`：普通 send 准入错误、execute 回调、写作/视频包准入及
  执行结果分支全部覆盖，不能继续落到“请求状态待核实”兜底。
- `apps/web/src/components/admin/RuntimeRateLimitSettings.tsx`：仅在后端 enforcement 全为 true
  后显示已接线并启用暂停按钮；保存后使用读回值。新对话改为“新消息（每轮消息）”。
  模型调用说明：“每轮开始时按这一轮最多可用的调用数一次性预扣（导师 1–2 次，/runtime 3 次），
  实际用得少也不退回”。提示模型调用每分钟不能低于单轮最多调用数（当前 3）。

## 验证与交接边界

每个入口覆盖四句消息准入提示和三个执行结果原因；覆盖无自动重试、保留原请求、
保存暂停后读回及普通用户被拒。使用本机网页、PostgreSQL、Redis/SRH 和合成供应商。
完整浏览器验收按原方案第 9 节 A0–A10；前端未接入时不能把这些步骤记为 PASS。
独立审查由总控安排，合并必须 Owner 批准；本任务不连接 staging、不执行 M0/B 段或付费调用。
