# C8 CI 提速测量

状态：测量与实现中；高风险（CI），仅 draft PR，禁止合并和删除现有 Actions 缓存。

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

## 计划与测量边界

复用既有 pnpm store 缓存；审计直接读取原始 lockfile；构建缓存限制大小和 key 增长。
不改十个必需检查名称、检查命令或跳过策略。比较 GitHub job/step 时间，并单独列出缓存恢复成本。
共享 runner 和网络存在波动，单次前后差异不等于稳定加速比例。

后续补入候选运行、完整检查覆盖说明及现有缓存删除建议。现有缓存删除必须先获 Owner 批准。
