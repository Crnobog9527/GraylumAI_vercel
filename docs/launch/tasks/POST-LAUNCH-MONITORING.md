# 上线后监控方案（POST-LAUNCH-MONITORING）

状态：**方案，仅文档，不是已批准的决定**；不改 `MASTER_PLAN.md`（Owner 决定的记录由 V2-9 写）。2026-11-03，依据 staging 的代码（回合路径 `turns` / `turn_calls`、`runtime-recovery` 每分钟任务、Sentry 桥）。

## 0. 为什么要这份方案

Owner 2026-11-03（总控转述）：每日真实模型检查只做到上线；上线后改成“**每次发版前在 staging 跑一次**（`~/.graylum/daily-smoke/run.sh --release`，≤0.5 美元，只碰 staging）+ **盯真实用户数据的告警**”。发版前检查只能证明“这一版的主流程在 staging 上能走通”，证明不了正式站此刻有没有出事；后者靠告警。

原则：
- **不新增服务、表、队列**（AGENTS 第 5 节）。沿用现有做法：定时任务算出数量 → `captureMessage(固定代码, 只含整数)` → Sentry 规则 → Owner 邮箱（`erasure-backlog-alert.ts`、`publish-monitor-alert.ts` 就是这么做的）；钱相关的用止损邮件（Resend，发到 `support_email`）。
- **告警里不带用户内容**：`sentry-scrub.ts` 只放行已登记前缀的固定代码和整数附加数据；新代码都用已登记前缀（`RUNTIME_`、`REPORT_`、`PUBLISH_MONITOR_`、`BILLING_`）。
- 阈值先宽后紧：上线第一周按真实数据校准一次，之后每月看一次误报和漏报。
- 花钱或改正式环境设置的步骤标“**需 Owner 批准**”。

## 1. 已经有的告警（不重做）

上线手册 `REL-1-BUILD-PREP.md` 第 3.3 节（2026-10-26）已有一张值守表，覆盖：注销积压、资料库清理积压、止损邮件和“止损邮件发不出去”、拒付、付款证据冲突、发布配额和清理卡住、卡单对账、年付释放和付款提醒、每日对账失败（`API_SYSTEM_CRON_JOB`）、TikHub 价格、恢复任务单条失败（`API_API_TURN_RECOVERY_TURN_FAILED`）、限流后端不可用（503）、环境变量缺失、其余 `API_*` error。通知通道和“持续出现时每小时再提醒”的 Sentry 规则写法也在那里（10-25 的教训：只在“新问题”时通知会漏掉第二次）。**本方案只补它没有的**。

那张表已经点出的缺口：注销、资料库、评审团、分钟恢复这几个定时任务**整体失败（返回 500）时不发 Sentry**，只能靠人每天去看 Vercel 定时任务记录。

## 2. 缺口和新增信号

数据来源尽量用现有的：`turns`、`turn_calls`、`scheduled_job_runs`、`social_publish_jobs`、已授权给定时任务的只读函数 `turn_admin_unsettled_turns` 和 `turn_admin_model_report`（0471）。

| # | 信号 | 从哪里算 | 初始阈值（上线第一周校准） | 级别 · 通道 | 处理时限 | 代码 |
| --- | --- | --- | --- | --- | --- | --- |
| S1 | **回合失败率**（对话、导师、报告、对比、评审团、复盘分开看） | 最近 15 分钟已结束的回合里 `close_kind in (failed, interrupted, expired)` 的个数和占比 | 样本 ≥ 20 且失败 ≥ 20% → error；失败 ≥ 50% → fatal；任一类型连续两个窗口都超线才响 | Sentry `RUNTIME_TURN_FAILURE_RATE` | 4 小时；fatal 30 分钟 | M2 |
| S2 | **冻结未结清** | `turn_admin_unsettled_turns`：已结束但 `settlement=pending`，或还开着的回合，超过 1 小时 | ≥ 1 个超 1 小时 → error；≥ 10 个或冻结积分合计 ≥ 5000 → fatal | Sentry `RUNTIME_UNSETTLED_TURNS` | 30 分钟（用户的钱被占着） | M2 |
| S3 | **没有供应商编号的未知调用**（已知缺口：供应商连响应头都没给时，调用是 `unknown`、`provider_id` 为空，恢复任务和 0489“查无即退”都管不到它，冻结没有自动出口） | `turn_calls`：`unknown/cost_pending` 且 `provider_id is null`，所属回合已结束超过 24 小时 | ≥ 1 → error，每天一次 | Sentry `RUNTIME_UNKNOWN_CALL_NO_ID` | 当天；**要不要自动退是计费规则，需 Owner 决定** | M2 |
| S4 | **供应商 402 / 被拒** | `turn_calls.status in (no_charge_402, rejected)`。**402 现在只写数据库、不写日志，不会进 Sentry**，用户只看到“服务暂时不可用” | 10 分钟内 ≥ 3 次 402 → fatal（多半是 OpenRouter 余额或密钥上限用尽，所有付费回合都被拒）；`rejected` 10 分钟 ≥ 10 次 → error | Sentry `RUNTIME_PROVIDER_REFUSED` | **30 分钟**（全站付费功能停摆） | M2 |
| S5 | **429** | 用户限流是预期行为，**不告警**；只在每周看一次 Vercel 日志里 429 的量。限流后端不可用（503）已有告警 | — | — | — | — |
| S6 | **扣费异常** | ① 回合 `charged_credits > reserved_credits`（数据库不应出现）；② 用户余额 < 0；③ “平台承担”积分（`turn_admin_model_report` 的 `absorbedCredits`）当天合计；④ 当天平台实际成本折算成积分后高于用户被扣积分 | ① ≥ 1 → fatal；② ≥ 1 → error；③ 当天 > 500 积分（q=100 时约 5 美元，对应 AGENTS 第 5 节损失线）→ warning；④ 超 5% → warning（**阈值需 Owner 定**） | ①② Sentry `BILLING_CHARGE_ANOMALY`；③④ 并入每日对账的 `mismatches` | ① 30 分钟；其余当天 | M2、M3 |
| S7 | **复盘失败** | 复盘回合失败率并入 S1（`kind=review`）；`social_monitor` 任务连续 3 次运行记录为失败（沿用资料库 `failingRuns` 的做法） | 连续 3 次失败 → error | Sentry `PUBLISH_MONITOR_REVIEW_FAILING` | 当天 | M2、M3 |
| S8 | **发布失败** | `social_publish_jobs` 最近 1 小时进入失败终态的个数和占比（已有的只有配额和清理卡住） | 样本 ≥ 10 且失败 ≥ 30%，或失败 ≥ 5 个 → error | Sentry `PUBLISH_MONITOR_PUBLISH_FAILURES` | 4 小时 | M3 |
| S9 | **分钟恢复任务整体失败或停跑** | 失败：`runtime-recovery` 返回 500（`turns.failed > 0`）连续 3 次；停跑：每日对账里查 `scheduled_job_runs` 里 `runtime_recovery` 最近 24 小时最大间隔 | 连续 3 次失败 → error；间隔 > 10 分钟 → error | Sentry `RUNTIME_RECOVERY_RUN_FAILING`、`RUNTIME_RECOVERY_RUN_GAP` | 30 分钟（该退的钱可能没退） | M1、M3 |
| S10 | **页面和接口报错突增** | 已有：其余 `API_*` error 和未捕获异常；Sentry 的“错误突增”规则（`docs/SENTRY_ALERTS.md`） | 1 小时内是平时的 10 倍 → error | Sentry 规则 | 4 小时 | M5（只配规则） |

## 3. 通道、谁收

- **Sentry 正式项目 error/fatal** → Owner 指定邮箱（Owner 2026-10-26）；每个固定代码一条规则，设成“每次出现通知”或“持续出现时每小时再提醒”。
- **止损邮件**（全站花费、单用户上限、供应商余额）→ `support_email`（Resend），后台“成本止损”页同时显示。**金额没填就不会发**（上线手册 P4）。
- **谁收、谁处理**：Owner 收到后转总控；总控查原因、给处理建议；写正式库、改正式配置、退款仍逐次问 Owner。处理时限三档：30 分钟（钱、隐私承诺）、4 小时（功能停摆但不丢钱）、当天（要人工对单）。
- 没有新增 Slack、短信或第三方告警服务。

## 4. 小改动清单（每项一个小 PR，都不新增服务）

| # | 改动 | 位置 | 复用 | 迁移 |
| --- | --- | --- | --- | --- |
| M1 | `runtime-recovery` 任务连续失败时发 `RUNTIME_RECOVERY_RUN_FAILING`（S9 的失败部分） | `apps/web/src/app/api/cron/runtime-recovery/route.ts`，新增一个小告警模块 | `erasure-backlog-alert.ts` 的写法；`scheduled_job_runs` 连续失败读法 | 无 |
| M2 | 新增一个只读函数 `turn_health_counts(窗口)`，只返回整数（失败数/总数、冻结数、无编号未知调用数、402 数、`charged>reserved` 数、负余额数）；在每分钟任务里调用并按阈值发码（S1–S4、S6①②、S7 的失败率部分）。读取预算 ≤ 1.5 秒，读不到只记日志，不影响恢复本身 | 同上 + `packages/db/migrations/` | `turn_admin_unsettled_turns`（0471）的写法和授权（只给 `service_role`） | **有迁移，只能由主窗口上库** |
| M3 | 每日对账里加：平台承担和成本/扣费比（S6③④）、`runtime_recovery` 心跳缺口（S9）、`social_monitor` 连续失败（S7）、发布失败（S8）；写进现有的 `mismatches`，已经会触发 `API_SYSTEM_CRON_JOB` | `apps/web/src/app/api/cron/billing-reconcile/route.ts` | 现有 `mismatches` 机制、`turn_admin_model_report` | 无（S8 如需新读函数则有） |
| M4 | 把新代码登记进清洗规则的测试，保证只带整数、不带用户内容 | `sentry-scrub.ts` 的测试 | 前缀 `RUNTIME`、`REPORT`、`PUBLISH_MONITOR`、`BILLING` 已登记，不需要加前缀 | 无 |
| M5 | 在 Sentry 正式项目为每个新代码建一条规则；加“错误突增”规则 | Sentry 后台（不在仓库） | `docs/SENTRY_ALERTS.md` | **需 Owner 批准**（改正式环境的平台设置） |
| M6 | 文档同步：`REL-1-BUILD-PREP.md` 第 3.3 节表加新行；`docs/SENTRY_ALERTS.md` 里按消息文字匹配的规则（“积分不足”等）和现在的固定代码对不上，改成按代码 | `docs/` | — | 无 |

做完 M1–M4 后，在上线前的冒烟日做一次**合成告警演练**：对每个新代码手动触发一次（或在 staging 造一条满足阈值的数据），确认 Owner 邮箱收到；结果记在上线 PR。

## 5. 需要 Owner 批准或决定的事

1. M5：正式 Sentry 项目里新增规则、通知邮箱和提醒频率（改正式环境的平台设置）。
2. 上线第一周之后，总控是否继续只读正式 Sentry 和 Vercel 日志（Owner 2026-10-26 只批了上线后 7 天）；上线日期现在没定，这条随上线日重新批。
3. S3：供应商没给编号的未知调用，冻结要不要、多久后自动退还（计费规则，现在没有出口）。
4. S6③④ 的阈值（平台承担积分、成本和扣费的偏差）。
5. M2 的迁移上正式库（按上线手册的上库流程，逐个批准）。

## 6. 这份方案没有覆盖的

- 供应商余额本身：仍是 Owner 每天在后台手动记一次（24 小时没记会触发止损邮件）。S4 的 402 告警是兜底，不能替代余额提醒。
- 真实模型的内容质量：发版前检查只看流程和扣费，不看回答好不好；内容由 Owner 验收。
- Sentry 的 Cron Monitors：能发现“任务没跑”，但可能产生费用，本方案不用，用 S9 的心跳缺口检查代替。
