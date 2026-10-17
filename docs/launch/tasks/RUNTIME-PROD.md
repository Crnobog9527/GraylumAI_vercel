# RUNTIME-PROD 正式模式（切片 A：正式准入与合同）

状态：实施中，high（正式环境准入与计费）。2026-10-17。
依据：[RUNTIME_PROD_PLAN](../RUNTIME_PROD_PLAN.md) 第 3、4、7 节；Master Plan 第 2.1 节第 40 项
（正式价格全自动）、第 50 项（q=100、m=6）、2026-10-07 正式准入生命周期决定、
[REL-1](REL-1.md) 清单 R1。止损已由 [RUNTIME-PROD-STOP-LOSS](RUNTIME-PROD-STOP-LOSS.md) 交付。

## 1. 这次要做到什么

正式环境（独立的 Vercel 正式项目 + 正式 Supabase 库）里，已登录用户发消息时 Runtime 能真实调用
已准入的模型，并按现有 BILL2 v2 逐次冻结、结算。staging 测试窗口的行为不变。

**怎样算做完**：正式模式的准入、冻结、结算、拒绝、重复提交、并发和失败路径在本机隔离测试里通过；
staging 测试窗口现有测试全部照旧通过；错误环境、错误配置、staging 配置串到正式（或反过来）都在派发前拒绝，
零冻结、零供应商请求。

**不做**：正式环境的任何配置写入、部署、迁移应用（按 REL-1 逐项批准）；Fusion 评审团和研究工具的正式线路、
暂停中长时间等待的运行逐次刷新价格、后台界面、告警接线（见第 6 节，后续 PR）。

## 2. 正式模式怎么工作

| 问题 | 做法 |
| --- | --- |
| 报价从哪来 | 每次新准入从 `ai_models.config.pricing` 已落库的价格快照推导：线路价格、`max_price`、单次上界 U 和名义价格。快照过期（7 天）按 MODEL-PRICING-SYNC 原逻辑先刷新落库。涨价直接用新价，不需要重新批准，也不比较“窗口冻结价”（那只属于 staging）。已开始的运行用自己冻结的价格，不重算 |
| 逐次计费档案 | 新设置 `system_settings.runtime_payg_production`，结构与 `runtime_payg_staging` 的档案相同（线路、用途、请求格式、思考档位、容量、真实采样证据），但**没有** `windowId` 和到期日；`enabled:false` 一键关闭。缺失、关闭、内容不合法一律拒绝，绝不退回 v1 |
| 积分换算 | q 读 `billing_credits_per_usd`，默认 m 读 `billing_token_price_multiplier`，模型覆盖读 `ai_models.price_multiplier`。正式模式要求两行设置都真实存在（来源 configured），缺行即拒绝，不用代码默认值。数值（q=100、m=6）由上线批准包写入 |
| 开放给谁 | 所有已登录、账号正常（active、未注销）的用户。会员和功能门槛照旧由 ENTITLEMENTS、付费墙、定位门槛决定（免费用户可做完报告前全部步骤，Owner 2026-10-03）；本任务不新增门槛，也没有白名单 |
| 用哪把凭据 | 沿用模型行里已有的私有凭据；冻结的 `account` 是凭据指纹，派发和恢复时核对，凭据换了旧运行只能查回执、不能新派发 |
| 合同 | 只接受 BILL2 v2：`mode:'production'`、不带 `testWindowId`、`rules.version:'runtime-production-v1'`、`quoteVersion` 为档案版本 |

## 3. staging 和正式怎么区分、怎么防串用

1. **代码侧（服务器环境）**：正式模式只在同时满足以下条件时启用——Vercel 正式部署、`main` 分支、
   本仓库、`VERCEL_PROJECT_ID` 等于 `V3_RUNTIME_PRODUCTION_PROJECT_ID`、Supabase 主机等于
   `V3_RUNTIME_PRODUCTION_DATABASE_HOST`、域名在代码里的精确清单内、`V3_RUNTIME_PRODUCTION_ENABLED=true`，
   并且**没有设置任何** `V3_RUNTIME_STAGING_*` 变量。staging 原来的绑定（staging 分支、staging 域名）不变，
   两边条件互斥。
2. **数据库侧**：新增 `runtime_production_database()` 判断，正式库由上线批准包写入一行
   `runtime_environment = "production"` 标记，且库里不能有任何测试窗口。SQL 在准备、领取、派发、恢复时：
   正式模式要求本库是正式库；staging_test 模式要求本库**不是**正式库。staging 库有测试窗口、没有正式标记，
   所以即使正式代码连到 staging 库也会被拒绝，反之亦然。
3. 正式档案读独立的设置键，staging 的 `runtime_payg_staging` 和测试窗口在正式模式里一律不读。

## 4. 实现位置（复用现有机制）

- TS：`productionEnvironment.ts`（环境绑定）、`productionPolicy.ts`（从模型行、价格快照、档案、q/m 构造与测试窗口
  同形状的准入策略）；`stagingPolicy.ts` 的三个入口按部署环境分派；`admission.ts` 只在合同字段处区分模式；
  `newWorkGate` 用已有的 production 限流命名空间。
- SQL（一个追加迁移，按原文锚点修补，锚点缺失即中止）：`bill2_prepare` 接受 `production`；
  `runtime_test_window_allowed` 增加正式分支（正式库、v2、档案启用、线路与凭据指纹、q/m 与当前配置一致，
  准备时另核对价格快照指纹）；协议和供应商判断把 production 当成真实 OpenRouter 调用；
  恢复策略从运行本身冻结的调用策略读取。

## 5. 风险与验证

- 本机：API 单元测试、类型、lint、代码大小、计费与 Runtime 集成（含新增正式模式用例）、空库建库与指纹。
- staging：合并后照常回归 staging 测试窗口（正式模式在 staging 上按设计必然拒绝，不能也不应在 staging 打通）。
- 正式：上线当天按 REL-1 H4 做有上限的小额冒烟。

## 6. 后续（不在本 PR）

- Fusion 评审团、研究工具在正式模式下的准入（目前在正式模式明确拒绝，不会误扣费）。
- 暂停等待充值的运行跨越涨价时逐次刷新价格（RUNTIME_PROD_PLAN 第 4.1 节）；首版这种情况由供应商按冻结的
  `max_price` 拒绝、零费用，用户重新发起即按新价。
- 后台展示正式准入与价格新鲜度（切片 B）、告警接线（切片 C）。
