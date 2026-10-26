# PUBLISH-MONITOR 每周自动复盘跳过排查（2026-10-26）

> 后续修复：本页保留当时旧实现的只读排查记录；提高预算/换模型的建议已被 Owner 保持0.30的明确要求取代。新实现及总控重跑步骤见 [复盘上限修复](PUBLISH-MONITOR-review-cap-fix-20261026.md)。

## 结论

当前 staging 配置会被 `PUBLISH_MONITOR_REVIEW_CAP_TOO_LOW` 拒绝，然后被汇总为 `CONFIGURATION_REQUIRED`。
复盘的 0.30 美元上限与所选 Sonnet 的批准报价不兼容：每次上限 2.827680 美元，
`capReviewAdmission` 至少需要两次调用（读取作品 + 生成结论），最低 5.655360 美元。
`floor(0.30 / 2.827680) = 0`，因此不能开始。

这是现有预算规则下的配置问题；本 PR 不放宽预算、不改变价格规则或自动重试行为。
增加两条本地复现测试，记录总控处理路径。

证据边界：原来的 skipped 行只保存汇总原因，`prepareReview` 没有记录具体配置错误码，
因此不能把本次只读配置复现说成取到了 07:50 的原始异常日志。
现有代码与只读快照足以证明当前配置必然不满足预算条件；原始拒绝是否还曾遇到模型配置异常无法从该行反推。

## 目标和边界

定位 founder 在 2026-10-25 周期被记为 `CONFIGURATION_REQUIRED` 的准入条件，区分配置问题和代码缺陷，
交付总控需要的配置及重跑记录定位。完成标准是只读证据、本地复现、配置处理步骤和整周跳过评估。

不改 staging 数据或设置，不触发真实模型调用，不删除 skipped 记录，不改变重试产品行为。

## 只读核验

2026-10-26 09:34–09:38 UTC，通过既有 Supabase CLI linked 配置查询 Graylum staging
`gvcpmcunmfrbxuwimxfa`；每次查询包在 `BEGIN READ ONLY` / `COMMIT` 中。
连接器只列出旧项目，故采用已绑定 staging 的 CLI；未更换绑定、认证或凭证。

| 项目 | 结果 |
| --- | --- |
| 周期 | `2026-10-25` |
| 记录 | `3ff9e2f2-c3d3-4723-9267-21763b7ef66f` |
| 创建 / 完成 | `2026-10-26 07:50:22.137868 / 07:50:23.003658 UTC` |
| 状态 | `skipped` / `CONFIGURATION_REQUIRED` |
| 模型 | `d04a4800-2d3a-43b3-8af9-cb960572e34f`，`anthropic/claude-sonnet-5.5` |
| 执行 / 计费单 | `runtime_execution_id = null`，`bill2_run_id = null` |
| 冻结上限 | `max_cost_usd = 0.30` |
| 复盘设置 | enabled 为 true；model_id 为 null，回落 primary_model_id，与记录模型相同 |
| 作品数据开关 | `chat_my_posts_enabled = true`，`publish_monitor_enabled = true` |
| 目的预算 | 已配置有效 v1；interactive inputBytes 90000、historyItems 100；不是缺项 |
| 当前 PAYG 窗口 | `a36c4f2f-573d-4df2-bffd-02119051c47b`，enabled、all_actors 均 true，到期 2027-12-31 |
| 模型批准 | 当前窗口包括该 Sonnet；ai_models 中 active、模型名及容量与报价相符 |

founder 不在显式 actor_ids 中，但 `all_actors = true`，所以不需要追加该账号。
预算配置读取失败的错误码 `RUNTIME_BUDGET_CONFIG_*` 和窗口拒绝码也不在本次
`CONFIGURATION_CODES` 的四个码内，不能仅凭汇总原因把它归为这些错误。

## 代码路径与本地复现

- `reviews.ts:prepareReview` 读取冻结模型和 cap，建立 `purposeBudgets: true` 的 Runtime admission。
- `runtime/admission.ts` 使用窗口和 PAYG profile；`freezeStagingPaygPricing` 保留批准的 `upperUsd`。
  `maxOutputTokens: 1000` 这个宿主默认值不会把窗口报价自动缩到 1000 token。
- `reviewAdmission.ts:capReviewAdmission` 取所选报价最大 `upperUsd`，计算可用调用次数；不足 2 次直接拒绝。
- `reviews.ts` 把 `PUBLISH_MONITOR_REVIEW_CAP_TOO_LOW` 映射为 `CONFIGURATION_REQUIRED`，不调用模型。

`reviewAdmission.test.ts` 增加当前 Sonnet 和低价 Luna 的实数边界复现：

| 模型 | 单次上限 USD | 当前 cap 0.30 | 两次最低 cap USD |
| --- | ---: | --- | ---: |
| Sonnet | 2.827680 | 拒绝，原 billing/context 不变 | 5.655360 |
| Luna | 0.265572 | 拒绝，原 billing/context 不变 | 0.531144 |

运行 `pnpm --filter @repo/api exec vitest run src/services/publishMonitor/reviewAdmission.test.ts src/services/publishMonitor/reviews.test.ts`：
21 / 21 通过。其中新增 2 条；没有实施行为修复，所以不声称先红后绿。
这是无外部调用的预算函数和调度单元测试，不等于完整 staging 复盘验收。

## 给总控的配置处理

在现有 0.30 美元预算内，当前窗口的任一可用模型都达不到两次批准上限。
只删除 skipped 行会再次跳过；只把复盘模型改为 Luna、保留 0.30 也不能解决。

建议先由总控确认是否允许提高复盘上限，再执行设置及重跑；本 PR 不授权增加付费预算。
当前没有需要修正的缺失 purposeBudgets、账号白名单或启用开关。

| 处理路径 | `publish_monitor_review_model_id` | `publish_monitor_review_max_usd` | 影响 |
| --- | --- | --- | --- |
| 保持现有模型 | 保持 null（仍回落现有 Sonnet） | JSON 字符串 `"5.655360"` 或更高 | 两次调用可通过 cap 检查；额度显著增加 |
| 推荐的低成本复验 | JSON 字符串 `"2cf4bf00-c24c-4c48-a7e7-b99f68806d71"` | JSON 字符串 `"0.54"` | Luna 两次上限 0.531144；模型变化，质量另验 |

两条路径均只表示通过本次预算条件，不保证其他准入条件、模型质量、积分余额或供应商请求成功。
若必须维持 0.30，则先保留 skipped 行，另行决定是否建立更小且经过验证的报价配置；不要直接降低冻结报价来绕过保护。

总控在配置和额外测试预算获准后，删除且仅删除下列记录：

- id：`3ff9e2f2-c3d3-4723-9267-21763b7ef66f`
- actor_id：`9fb17665-53a5-41a9-b5df-16b5abfdd34c`（指定 staging founder）
- period_start：`2026-10-25`
- 删除前再确认 status 为 skipped、skip_reason 为 CONFIGURATION_REQUIRED、runtime_execution_id 和 bill2_run_id 仍为空。

不删除会话、账单、其他周期或其他账号记录。

## 暂时配置不全导致整周跳过

现有 `publish_monitor_review_claim` 同时存在两道限制：

1. `(actor_id, period_start)` 唯一，同周期记录不能重复创建；
2. `completed` 和 `skipped` 的最新 finished_at 都参与下一次时间计算，下一次至少在该时间后 7 天。

本例会把下次自动复盘推到至少 `2026-11-02 07:50:23.003658 UTC`。
修好设置不会立即补回本周；这是现有行为，配置拒绝并非真正永久的原因。

建议后续只把明确不再允许执行的原因记为终结；配置错误应有可恢复的记录和退避，保留原请求标识，
并避免前五个坏配置账号反复占满领取批次。现有 `reviews.test.ts` 专门测试跳过能释放批次，
所以不能简单删除 catch 中的 skip 而不处理饥饿问题。是否改变这项行为由总控决定，本 PR 不改。
另建议在配置拒绝时记录安全的具体错误码和 reviewId，避免以后再次只能从汇总原因推断。

## Validation handoff / 交接

已完成：只读配置定位、两条实数边界测试、两条配置路径及指定记录定位。

下一步由总控完成，顺序如下：

1. 确认模型选择及提高后的每次复盘 cap / 测试预算，再更改对应 staging 设置。
2. 重新核对上述指定行，按限定条件删除；等待已有定时任务领取，不同时手动发起第二次。
3. 检查同周期新记录：不能再次为同一 cap 原因 skipped；应出现一个 runtime_execution 和一份 BILL2 运行单。
4. 等待完成或有明确失败原因；确认实际调用总额不超过所选 cap、没有重复扣费，保留最终账务证据。
5. 在 `https://auth-staging.graylum.com` 的作品数据 / 复盘入口，用 founder 检查本周复盘正文和数据对应。
   运行 `node ~/.graylum/staging-login founder`，用生成的 storageState 打开浏览器；过期就重跑；不读取、不记录凭证。

未运行：staging 写入、删除、真实定时重跑、供应商调用、页面验收。
尚待：独立审查与最终 CI；合并仅交付排查报告和测试，不会自动修好 staging 配置。
