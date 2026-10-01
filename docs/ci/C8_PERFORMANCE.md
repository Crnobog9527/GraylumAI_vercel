# C8 CI 提速测量

状态：实现及首轮完整 CI 已通过；高风险（CI），仅 draft PR，不合并或删除现有 Actions 缓存。

## 改动前核实（2026-10-01，Asia/Shanghai）

基线提交：`0470e7a7519ec6b37dcd54566ad459e605782ab9`。

- [CI 基线运行](https://github.com/Crnobog9527/GraylumAI_vercel/actions/runs/36767747604)：
  单元/回归 worker 58 秒，安装 8 秒；构建 worker 124 秒，构建 46 秒。
- [Security 基线运行](https://github.com/Crnobog9527/GraylumAI_vercel/actions/runs/36767747587)：
  Dependency Audit 33 秒，其中全仓安装 7 秒，实际 audit 1 秒。
- 审计仍安装全仓依赖后，再用独立 pnpm 11.13.0 对临时目录中的 lockfile 审计。
- 单元/回归 worker 的 setup-node 明确关闭缓存；其他安装 worker 已使用 pnpm store 缓存。
- Actions API：43 条缓存，10,951,483,225 bytes（10.95 GB，10.20 GiB）。
  其中构建缓存 38 条、9,598,349,396 bytes；单条 240.32–307.83 MB，中位 242.07 MB。
  pnpm store 缓存 5 条、1,353,133,829 bytes。
- 旧“每提交约 300 MB”只近似成立：当前 key 含提交 SHA，每个成功构建的新提交均可新增一条；
  本次存量中位约 242 MB，约 11 GB 总占用仍成立。

## 实现与测量边界

复用既有 pnpm store 缓存；审计直接读取原始 lockfile；构建缓存限制大小和 key 增长。
不改十个必需检查名称、检查命令或跳过策略。比较 GitHub job/step 时间，并单独列出缓存恢复成本。
共享 runner 和网络存在波动，单次前后差异不等于稳定加速比例。

检查范围及所有已知跳过项见 [十个必需检查说明](REQUIRED_CHECKS.md)。

- 测试 worker 使用既有 setup-node `cache: pnpm`，仍无条件执行 frozen-lockfile 安装。
  只缓存 store，不缓存 node_modules；保留锁文件完整性验证。
- 审计工具版本、隔离目录、原始锁文件和 high 阈值不变，删除其无用的全仓安装和初始 pnpm setup。
- 构建改用既有固定版本 `actions/cache/restore` / `save`。
  key 保留 OS、架构、Node、lockfile、workspace、配置、workflow hash 和 ref hash，去掉 commit SHA。
  同 ref/配置只在缓存未命中时保存一次，命中后不会更新，缓存会停在第一次保存时的状态。
  随代码变化，缓存会逐渐变旧，命中收益可能下降；只影响速度，不影响正确性。
  源码变化仍重新构建并执行全部测试；配置变化或缓存淘汰时重新生成。
  以后若构建明显变慢，再考虑按周轮换 key；本次不引入轮换。
- 只保存 `apps/web/.next/cache`，成功完成测试后检查目录占用，不超过 1 GiB 才保存。
  超限仅放弃保存；既有远程缓存不删。v2 无 v1 或跨配置 fallback。
  GitHub 分支可见性加 ref hash 隔离 PR；不缓存构建产物、测试结果、凭证或浏览器状态。
- 大小上限是本地目录 `du -sk` 占用，不宣称是精确的压缩包大小或仓库总量上限。
  多个 ref/配置仍会各有一份；不能称全仓永远只剩一条。命中后不会更新，因此长期配置不变时
  新源码仍可能需要额外编译，这是控制存量增长的取舍。
- 不增加仓库写权限、清理定时任务或删除逻辑。不更改依赖锁定、检查阈值、用例选择、分支保护。

标准行为参考 [setup-node v5](https://github.com/actions/setup-node/blob/v5.0.0/README.md)、
[cache v4.2.4](https://github.com/actions/cache/blob/v4.2.4/README.md)、
[pnpm audit](https://pnpm.io/cli/audit)。

## 同 PR 前后测量

对比同一 PR、同一 staging 基线、相同依赖锁文件和业务代码。
改动前为仅文档提交 `ebb2282622d5a8331643f44ab9503a8594e7e6ac`：
[CI 36770257403](https://github.com/Crnobog9527/GraylumAI_vercel/actions/runs/36770257403)、
[Security 36770257616](https://github.com/Crnobog9527/GraylumAI_vercel/actions/runs/36770257616)。
改动后首轮为 `13405b8fd86c2712e2e074e9dc11bede1be9e60a`：
[CI 36770960689](https://github.com/Crnobog9527/GraylumAI_vercel/actions/runs/36770960689)、
[Security 36770960671](https://github.com/Crnobog9527/GraylumAI_vercel/actions/runs/36770960671)。
两轮完整 CI/Security 都成功（15 项检查，其中 10 项必需）。

| 指标（秒） | 改动前 | 改动后首轮 | 说明 |
| --- | ---: | ---: | --- |
| Dependency Audit 完整任务 | 32 | 10 | 去掉安装与初始 pnpm setup |
| Audit 全仓依赖安装 | 10 | 未运行（已移除） | 实际审计仍执行；锁文件输入不变 |
| 实际 audit 命令 | 1 | 1 | 同版本、同阈值 |
| 单元/回归依赖安装 | 7 | 3 | 前：578 下载/0 复用；后：0 下载/578 复用 |
| 单元/回归 Node 设置（含 store 恢复） | 1 | 5 | 缓存恢复不是免费操作 |
| 单元/回归 Node 设置＋安装 | 8 | 8 | 本轮合计无缩短 |
| 单元/回归完整任务 | 63 | 62 | 包含新增契约断言，不据此承诺稳定提速 |
| 构建命令 | 91 | 91 | 两轮均为当前 key 首次冷构建 |
| 构建/E2E 完整任务 | 163 | 165 | 无省略测试；首轮未因缓存加快 |
| 集成完整任务 | 217 | 221 | 本任务没有改集成逻辑，是主要耗时路径 |
| lint/type 完整任务 | 92 | 57 | 未修改该 worker；差异说明 runner 波动，不计为本次优化收益 |

时间来自 GitHub jobs API 的 started_at/completed_at，按整秒差计算，含 job 收尾但不含排队。
不要用单步骤或未修改 worker 的随机差异宣称端到端固定提速。

首轮构建日志确认 v2 未命中，编译缓存目录 315,040 KiB（约 307.7 MiB），低于 1 GiB 上限；
保存缓存 ID `8332167394`，归档大小 240,303,579 bytes（240.30 MB）。
后续最终文档提交的完整 CI 会验证相同 key 命中、缓存不再逐提交新增；最终 head、运行链接、
热缓存耗时及总控交接结论记录在本 PR 中，避免将旧 head 的绿色状态误写成新候选结果。

本地：frozen-lockfile 安装成功；工作流契约 9 测试/341 断言、政策回归 232 cases、
CI safeguards 128/128、代码大小和 diff 检查通过。最初新 worktree 缺依赖导致 safeguards
4 项失败；离线安装发现 store 缺包，改为锁文件联网安装后全过。未改依赖版本或放宽断言。
独立审查已覆盖首轮完整候选，无阻断发现；一处表格排版已在后续文档修正，最终候选仍需对应审查结论。

## 现有 v1 缓存：不删除，等自然过期

下列核实时已存在的 **38 条 `secretless-next-v1-` 缓存**，合计 9,598,349,396 bytes（9.60 GB），
**不删除，等 GitHub 自然过期或按容量策略淘汰**。v2 不再读取 v1；仍使用 v1 的旧分支若继续访问，
可能延后其淘汰，不能承诺从本次改动起固定期限内清空。无需另行申请删除批准。
列表仅保留为历史容量快照，不是待执行的删除清单；pnpm store 和其他缓存也不做人工清理。
本 PR 没有删除动作、删除脚本或轮换任务，也没有更改仓库缓存保留设置。

| Cache ID | ref | key 末尾提交 | bytes |
| --- | --- | --- | ---: |
| 8315482462 | `refs/pull/497/merge` | `9bc90625b8ecee2e55faa404e866d8c40cefbcf7` | 244175134 |
| 8318937389 | `refs/heads/staging` | `6ba5611e9d302aedd7b2b6a8b11ff5b6ab5ce73f` | 306877464 |
| 8319902583 | `refs/pull/538/merge` | `2e5ce76eda0b2e86fdcaf66480206944d9fb11f3` | 240323107 |
| 8319996322 | `refs/pull/550/merge` | `e0efed59131547f08031bc411ca71fd343cb3a67` | 240832547 |
| 8320008181 | `refs/pull/548/merge` | `a2c0262016ca6f1eb7a10633ae86e661095787e9` | 240620072 |
| 8320410397 | `refs/pull/549/merge` | `1dc228b93fdfab478926735e066534ab24e09a54` | 240544260 |
| 8320869677 | `refs/pull/548/merge` | `09e80ae5e2e265e803da862220d4a35298efcccb` | 242213571 |
| 8320873065 | `refs/pull/548/merge` | `4e5b78784538e373f88bdcd8e0543bc352f41d24` | 242232987 |
| 8321224913 | `refs/pull/552/merge` | `446098d022d4355feae7aee4701e79d39ea5ce01` | 240884939 |
| 8321275200 | `refs/heads/staging` | `1d5de72052059de5b6e0cb5c9219519ad2788e11` | 304893436 |
| 8321440472 | `refs/pull/497/merge` | `bcd2670cf81994fa46ea7cf2be24944df9065985` | 307829459 |
| 8321709382 | `refs/pull/538/merge` | `20cfe5298785ffd067ffe9070eb1c30a1109e1ae` | 242037974 |
| 8321791844 | `refs/pull/552/merge` | `48f9b49fb72f76d63fa89ce0ff65358a32268d45` | 242773086 |
| 8322046626 | `refs/pull/548/merge` | `65854b187a30e5e7f4d4487c65c2578c4eee8ad1` | 267950356 |
| 8322193379 | `refs/pull/549/merge` | `798de91df961916ea8ffd436f87b3ac3c3afe6b1` | 242096908 |
| 8322602276 | `refs/pull/550/merge` | `5b2eae433cecc3299ce6248ad7ca727bc94bc723` | 264045983 |
| 8323082742 | `refs/pull/550/merge` | `9ea7e23abcebb1c1fad6ca64ace8d2b3946d7905` | 297743713 |
| 8323210282 | `refs/heads/staging` | `fe8e7860a7536574a4c50d41880b2a8441a194b0` | 241064792 |
| 8323362173 | `refs/pull/538/merge` | `7b529b7e4efff228bd8b8fdb6670f69bc9889d7e` | 240697949 |
| 8323484192 | `refs/pull/553/merge` | `cad1c14a9901516157265f65f41804b0d35f05d7` | 240783408 |
| 8323504044 | `refs/pull/554/merge` | `3c8caef63a69f717dfe946b1032a7cfb67d36fc9` | 240851360 |
| 8323726541 | `refs/pull/555/merge` | `001f0e649018b09b8055299ac2b6710725ac2ff1` | 240567815 |
| 8325177367 | `refs/heads/staging` | `29656fb955c669c5dcfdb6c385bae439574eae57` | 240649978 |
| 8325277808 | `refs/pull/554/merge` | `7c4f709e381a5bd77407e85658d47aea5df0d5c4` | 240871848 |
| 8325609304 | `refs/pull/548/merge` | `f5e0c42a81bb0a32122f44d246106e2358f8b900` | 240799665 |
| 8325647272 | `refs/pull/538/merge` | `20a311cfcab6f0eecabd147735159cfb1e68ca72` | 240336766 |
| 8325686535 | `refs/pull/548/merge` | `e53aaba292d42f7d77462c3c79c4750c25ac9018` | 242330888 |
| 8325895176 | `refs/pull/551/merge` | `e32c8eebc015c85f8760e20d08642e11b7e7f151` | 240721857 |
| 8326527886 | `refs/pull/538/merge` | `452d6df2e1fbc50060a42f158cc96c204fc3b7c1` | 242361322 |
| 8326815782 | `refs/pull/551/merge` | `3eaf1901dd2790f364194500e4486172319f1a84` | 243088267 |
| 8327507568 | `refs/heads/staging` | `f546b58faaf676a9dacfb68194bef5fe03e17bf7` | 247292457 |
| 8327625707 | `refs/heads/staging` | `02de1daa7d9fbfdbdb0ddcc2d84feaad3efa8586` | 250070545 |
| 8327956523 | `refs/pull/538/merge` | `1cc8cc0c07fe0abf0219c09a137908c65dbbd340` | 259779742 |
| 8329177110 | `refs/heads/staging` | `3c28e5ee0fcde5049160e59031390e64c17024d6` | 287676526 |
| 8329574315 | `refs/pull/539/merge` | `e1c8c2a1555136b24472c264d69ab64081d7aab5` | 241141945 |
| 8331083864 | `refs/heads/staging` | `0470e7a7519ec6b37dcd54566ad459e605782ab9` | 286808212 |
| 8331551416 | `refs/pull/556/merge` | `ac217004c26046fb1626f1a1ea33451d583b3c98` | 241055760 |
| 8331593453 | `refs/pull/540/merge` | `0203d5bf13831e2a6717cef97cdc01af2a57ed6e` | 241323298 |
