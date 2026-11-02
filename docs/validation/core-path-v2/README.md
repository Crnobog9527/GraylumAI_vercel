# CORE-PATH-V2 压测：脚本与跑法（V2-13 准备）

计划出处：`docs/launch/tasks/CORE-PATH-V2.md` 第 3.1（通过线）、3.2（100 人 staging 验收）、3.3.3（单机 500/2000/5000 外推）节。
这里只放**怎么跑**。结果写进同目录的报告，格式见 `REPORT-TEMPLATE.md`；旧路径基线见 `baseline-old-path.md`。

**状态：100 人 staging 压测已在 2026-11-01（UTC）跑过一批，结果见 `result-20261101.md`。** 单机 500/2000/5000 仍只做过本机演练。

## 1. 有什么

| 文件 | 干什么 | 碰什么 |
|---|---|---|
| `scripts/loadtest/openrouter-stub.mjs` | 模型桩（1.5 秒首字、每 50 ms 一段、约 6 秒回复；教练第二次调用约 4 秒） | 只听本机端口，要显式给地址和端口 |
| `scripts/loadtest/reset-accounts.mjs` | 每批前重置 100 个测试账号 | staging（只许 `LOADTEST_ALLOWED_HOST`） |
| `scripts/loadtest/core-path-load.mjs` | 3.2 节 100 人驱动：6 档、10 分钟冷却、30 人基线比对、失败过多自停 | staging 的 `POST /api/turn`；**不带 `--go` 只打印计划** |
| `scripts/loadtest/sample-waits.mjs` | 每 5 秒采 `pg_stat_activity` 等待事件和 `pg_locks` 按类型计数 | staging 数据库，只读角色，两条 SELECT |
| `scripts/loadtest/single-machine.mjs` | 3.3.3 单机压测：本机 Docker 库，N 个虚拟用户，模型换成计时器；量 k、等待、WAL、写入行数 | 只碰本机 Docker，不联网 |
| `scripts/loadtest/extrapolate.mjs` | 把单机结果算成报告里的 k 稳定性、等待是否持平、各规格量级表和"没覆盖什么" | 只读 JSON |
| `scripts/loadtest/lib/core.mjs`、`lib/extrapolate.mjs` | 纯函数：档位、节奏、判定、外推算术（有单测） | 无 |

## 2. 安全边界（脚本里写死的，不靠自觉）

- 驱动和采样器都不带地址、密钥、令牌：全部从环境变量读，且**主机名必须等于 `LOADTEST_ALLOWED_HOST`**，否则拒绝。
- 账号令牌文件、结果、账号凭证文件必须在仓库**外**（`--out` 经 `assertOutsideRepo` 检查）。
- 驱动必须带 `--go` 才会发请求；同一个输出目录同一时间只能有一个驱动在跑（`RUNNING.lock`）。
- 模型一律走桩，不花模型钱。放量超出下面第 3 节的单路慢速规则，先问总控。
- 单机压测只用本机 Docker 里的一次性库，用完即删；它不读任何环境变量里的数据库地址。

## 3. 100 人 staging 验收怎么跑（总控通知后）

前提（总控确认）：staging 已切到新路径；`OPENROUTER_BASE_URL` 已指向压测桩；同一时间没有别的浏览器验收批次；staging 写操作已告知总控。

```bash
# 0. 看计划（不发请求）
node scripts/loadtest/core-path-load.mjs --series --out "$OUT"

# 1. 每批前重置 100 个账号（见 reset-accounts.mjs 文件头）
# 2. 另开一个终端采样（900 秒覆盖一档加冷却，按需重复）
node scripts/loadtest/sample-waits.mjs --out "$OUT/waits.jsonl" --seconds 900

# 3. 跑整套（30 → 50 → 75 → 100 → 50 → 100）
node scripts/loadtest/core-path-load.mjs --series --go --out "$OUT"
```

- 每档 2.5 分钟（含 10 秒爬坡）；档间冷却至少 10 分钟（`--cooldown-ms` 只能调大）。
- 账号文件 `LOADTEST_ACCOUNTS_FILE`：每个用户一个令牌和一个已建好的会话（教练用户另带 `moduleId`/`stepId`）；
  资料库读取走 tRPC，要带会话 cookie（字段 `cookie`），回合接口只认令牌。
  会话和草稿用账号自己的令牌建：聊天会话 `runtime.start`（scope `positioning_draft`），教练草稿 `opc.start`（mode `mentor`，registration 取 `opc.catalog` 第一项，moduleId 取同一项，stepId 取其第一步）；本批用的本机脚本不进仓库，现驱动仍只读文件，不替账号建会话。
- 每档结束后在 Supabase 报表读 CPU 均值、内存、交换区，填进报告；驱动不抓这些。
- 30 人基线和上一批差 > 10% 本批作废（`baselineValid`）；本批是首批就写"无可比基线"。
- 判定用 `judgeStage`（失败 0、57014 为 0、整轮 p95 ≤ 桩回复 + 2 秒、CPU 均值 < 60%、交换区不涨、`LWLock:LockManager` < 2%）；
  **取不到的数按未通过算**，不按通过算。达不到就写"最多撑多少人、差多少"（`capacityWords`），不说做到了。

## 4. 单机 500/2000/5000 怎么跑（本机，不花钱）

```bash
OUT=$HOME/graylum-loadtest/single   # 仓库外
for users in 500 2000 5000; do
  node scripts/loadtest/single-machine.mjs --local-only --users $users --rhythm load --minutes 3 --cpus 8 --memory 8g --shared-buffers 2GB --out "$OUT"
  node scripts/loadtest/single-machine.mjs --local-only --users $users --rhythm human --minutes 6 --cpus 8 --memory 8g --shared-buffers 2GB --out "$OUT"
done
node scripts/loadtest/extrapolate.mjs "$OUT"/single-*-load.json --rhythm load
node scripts/loadtest/extrapolate.mjs "$OUT"/single-*-human.json --rhythm human
```

- 每个档位新建一个库（从仓库文件建），三个档位的核数、内存、`shared_buffers`、连接池必须一样；这几个数字写进结果里，报告照抄。
- 每个用户一个账号和一个会话；`--mix chat:5,mentor:3` 可加入导师轮（建账号较慢，5000 个导师账号要几十分钟，先小档位验证）。
- k = 容器 cgroup 的 CPU 秒（`cpu.stat usage_usec`）÷ 完成的回合数。它包含库的后台进程（autovacuum、检查点），不含驱动程序自己。
- 容器核数要让最高档位的 CPU 占用留在 70% 以内，否则 k 里混进排队；占用太高就加核数（三档同样加），或用真人节奏。
- 采样每秒一次：等待事件（无等待的活动后端记为 `CPU`）和锁；`LWLock:LockManager`、`Lock:tuple` 占比随人数的变化是要证明的第二条。
- 要证明的两条：k 在 500 → 5000 之间波动 ≤ ±15%；锁等待占比不涨且 < 2%。**不是**证明这台机器撑得住 5000 人。

## 5. 演练记录

本机演练（桩计时压到 5%）：20 个自由对话用户 30 秒、10 个自由对话 + 导师用户 24 秒，都跑通，无失败；结果仅证明脚本能走完整条链，**不是**压测结果，不进报告。
