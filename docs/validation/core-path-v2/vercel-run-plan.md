# CORE-PATH-V2：Vercel 一侧 100 人最终验收 — 运行计划（只准备，未运行）

出处：`result-20261101.md` 第 4、6 节（本机应用 + 假 Redis + 本机桩；固定约 9 秒、连接数、真 Redis 限流都没量到）。
**这份计划不是结果。** 下面第 1 节没批的东西，一项都没动过；没有跑过任何压测，没碰正式环境，没花模型钱，没动 `packages/db/migrations`。

## 0. 先要总控/Owner 做的事（工具不替你做）

| # | 要做的 | 为什么 | 谁批 |
|---|---|---|---|
| 1 | 给**一个能被 Vercel 够到的地址**放桩（`openrouter-stub.mjs`，要 `LOAD_STUB_HOST/PORT/PREFIX`）。推荐 A：Owner 机器上跑桩 + 免费隧道（Owner 照做步骤见 `owner-tunnel-steps.md`；不用新账号，有隧道 1 跳的偏差，见第 3 节）；B：单独一个 Vercel 项目放桩（同区域更干净，但要新建项目）| 应用够不到本机；`openrouter.ai` 地址写死在代码里 | 总控定 A/B，B 要 Owner 批 |
| 2 | 在 graylumai-staging 项目设两个环境变量：`LOADTEST_MODEL_STUB_URL`（https 桩地址含密路径）和 `LOADTEST_STUB_DB_HOST`（staging Supabase 主机），**跑完立即删掉并重新部署** | 钩子（本 PR）只有这两个都在、且应用连的库就是该主机时才改道；两个变量都不在时代码什么都不做 | 总控（Vercel staging 设置） |
| 3 | 采样器按**整个 PostgreSQL 实例**统计连接（含采样器自己的一条；当前库的数字另列），要一个**读 pg_stat_activity 的 staging 只读角色连接串**（需 `pg_read_all_stats`），可选再给管理令牌 + 项目标识读池设置 | 只读；放本机环境变量，不进仓库 | Owner/总控提供 |
| 4 | 日限临时调到 300（上批同做法），跑完调回；100 个测试账号（沿用 loadtest211–310 或重置）| 桩的"花费"记在账上约 31.6 美元，不是真钱 | 总控 |
| 5 | 向总控要一个 staging 空闲时段；期间不合并、不写 staging（AGENTS 第 8 节）| 同账号并行会串输入 | 总控 |
| 6 | 确认 staging 部署的是含本 PR 的版本 | 没有钩子就会真的打 OpenRouter | 总控 |

代码上已确认：应用到数据库只走 PostgREST（HTTPS，`supabase-js`），源码里没有直连 `pg`/`DATABASE_URL`。所以"Vercel 函数数量"**不会**直接变成数据库连接数；真正的数据库连接是 PostgREST 的连接池（`authenticator` 角色，`db_pool`），外加 Auth/Realtime 等服务自己的连接。这条在第 5 节用实测证实或推翻。

## 1. 本 PR 带来的东西

| 东西 | 干什么 |
|---|---|
| `apps/web/src/lib/loadtest-model-stub.ts`（+ `instrumentation.ts` 一行、`envValidator` 两个名字）| 默认关闭的钩子：只把 `https://openrouter.ai` 的三类请求（对话、回执、定位决定）改到桩；别的域名不动 |
| `openrouter-stub.mjs` 新增 | 密路径前缀（`LOAD_STUB_PREFIX`，不知道前缀的请求 404）、`/healthz`、`/__stats`（调用数、峰值并发）|
| `scripts/loadtest/sample-connections.mjs`、`lib/connections.mjs` | 每秒按角色/应用/状态数连接；开头读 `max_connections` 和（给了令牌时）池设置；`--summarize` 出摘要和过线判定 |
| `core-path-load.mjs` 新增 | `--calibrate`（1 个用户连发 12 轮，量无争用的单轮开销）；记录每个请求的函数区域（`x-vercel-id`）和 429 次数 |

## 2. 步骤（总控给时段后，约 1 小时 45 分）

```bash
# 环境（值由总控给，全部在仓库外）：LOADTEST_BASE_URL、LOADTEST_ALLOWED_APP_HOST（应用主机，只给驱动）、LOADTEST_ACCOUNTS_FILE、
# LOADTEST_DATABASE_URL、LOADTEST_ALLOWED_DB_HOST（库主机，只给两个采样器）、可选 SUPABASE_MANAGEMENT_TOKEN / SUPABASE_PROJECT_REF
# run-all.sh 给每个进程只传它自己的那个主机；每次运行写进新目录 <RUN_ROOT>/run-<时间戳>，目录里已有文件则拒绝运行
# 1. 桩和隧道：scripts/loadtest/start-stub-tunnel.sh（备选 --ngrok），它会打印要填的 LOADTEST_MODEL_STUB_URL；Owner 逐步照做见 owner-tunnel-steps.md
# 2. 自检：scripts/loadtest/selfcheck.sh（读桩的调用计数，跑 1 账号 1 轮，计数增加才 PASS；STOP 则不要往下跑）
# 3–6. 一条命令：先跑 5 分钟无争用基线（不开采样器）；再把两个采样器放到后台（打印 PID 和日志路径）；
#      再启动整套 30→50→75→100→50→100（档间冷却 10 分钟）；驱动结束后等采样器退出（宽限 30 秒，超时停掉）；
#      最后打印连接汇总，并检查两份采样的时间段确实覆盖了驱动的时间段（不覆盖则命令以失败退出）
scripts/loadtest/run-all.sh          # 采样时长默认 4800 秒，可用 SAMPLE_SECONDS 改
# 先在本机确认编排没问题（十几秒，不连网络和数据库）：scripts/loadtest/run-all.sh --dry-run
# 7. 收尾：删环境变量并重新部署；日限调回
```

**短版**（总控要缩短时）：`--calibrate` + `--stage 100` 跑两次，约 25 分钟；只能回答 9 秒来源和 100 人连接数，不含 30→100 的爬坡对比。

## 3. 要回答的三件事与过线

| 问题 | 怎么量 | 过线 / 读法 |
|---|---|---|
| ① 固定约 9 秒是不是本机往返 | `--calibrate` 的 p50 减去桩 6 秒（`classifyFixedOverhead`）；再看整套各档 p50 是否仍是同一个数 | 只报"每轮多出几秒"，**来源写"未确定"**：没有网络基线（`roundTripMs`）或应用内分段计时，就不下"是本机往返"或"是应用内串行"的结论。要下结论，先量一次从驱动机到 Vercel 的往返作基线，或加应用内分段计时。整轮 p95 ≤ 8 秒沿用 3.1 节。方案 A 的隧道每次模型调用多约 0.05–0.15 秒、一轮最多 3 次，偏差 ≤ 约 0.5 秒，读结果时扣掉 |
| ② 真 Vercel 下数据库连接数 | `sample-connections`（每秒）| 客户端连接峰值 ≤ 可用连接（`max_connections` − 保留）的 **75%**；`authenticator` 峰值 ≤ `db_pool`（读不到管理接口时按 staging 的 8）；"事务内空闲"最长 ≤ 5 秒；未读到的数按不通过 |
| ③ 真 Redis 限流 | 驱动记录 429 次数；Vercel 日志的 Redis 超时 | 100 人 2.5 分钟里 429 为 0（限流 `ai_stream` 每人每分钟 20 次、同 IP `ip_session` 每分钟 600 次；整套从一台机器出，约 330 次/分，余量不到 2 倍，出现 429 要先分清是 IP 限流还是产品限流）；`rate_limit_unavailable` 为 0 |

其余沿用 `judgeStage`（失败 0、57014 为 0、CPU 均值 < 60%、交换区不涨、`LWLock:LockManager` < 2%），取不到按未通过。**注意**：staging 以生产目标部署，`VERCEL_ENV` 区分不了 staging 和正式，所以钩子靠"数据库主机 = 指定的 staging 主机"限定。

## 4. 对照 Micro 的连接上限与正式站池设置

- Supabase Micro 计算规格（来自官方文档，我没在本环境核对，**以运行时 `SHOW max_connections` 为准**）：直连约 60，Supavisor 客户端上限约 200。按 75% 线，客户端连接峰值不得超过约 40。
- 应用侧占用来源：PostgREST 池（staging 现为 8，且数据库目录里的 `P` 必须 ≥ 实际池大小，否则 `turn_open` 拒绝开轮）+ Auth 等服务 + 采样器自己 1–2 条。
- **正式站需要的池设置（上线前必须问 Owner 的那个数）：PostgREST `db_pool` = 8（与 staging 相同，数据库目录 `P` 同步 ≥ 8）；Supavisor 池因为应用不走它，维持默认。** 这是按"staging 与正式不得有区别"和 100 人 0 失败的推荐，**要等本次实测的 `authenticator` 峰值和总连接峰值确认有余量再给 Owner**；若总连接峰值超过 75% 线，要往下调 `db_pool` 并同步调 `P`，而不是上调。

## 5. 估算花费与时长

| 项 | 估算 |
|---|---|
| 模型 | **0 美元**（全走桩；钩子没生效时会在 1 账号 1 轮的自检里发现，那一轮最多是 1–3 个小额真实调用）|
| Vercel | 约 1745 轮 × 约 15 秒函数时长，按 Pro 活跃 CPU/内存计费预计 < 2 美元 |
| Upstash Redis | 约 1.2 万条命令，在免费额度内 |
| 账内记账 | 桩计 `spent_usd` 约 30 美元，对着日限，不是真钱 |
| 时长 | 准备 20 分钟 + 校准 5 + 整套 70（6 档 × 2.5 分 + 5 × 10 分冷却 + 收尾）+ 收尾 10 ≈ 1 小时 45 分；短版约 25 分钟 |

## 6. 做不到/不确定

- 方案 A 隧道有偏差（见 ①）；桩不模拟 OpenRouter 的限速和排队。
- 采样是 1 秒一次的快照，瞬时尖峰可能漏；Supabase 管理接口的路径（`/config/database/pooler`、`/postgrest`）我没在本环境调用验证，读不到时报告写"未读到"。
- 单个批次、一台 Micro，没有重复。
