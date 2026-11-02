# 本机 CI 试点方案（CI-LOCAL-PILOT）

状态：方案，未启用。Owner 2026-11-02（经总控转述）：“可以把最重的 CI 测试放在我的电脑上，先试点尝试一下。”
范围只到试点：一个任务、2–3 个真实 PR 对比；不是全部搬走，不改仓库公开状态。省不到一半时间就撤回。

## 1. 选哪个任务

近四次成功运行（GitHub 托管机，x64）各任务用时：

| 任务（检查名不变） | 用时 | 备注 |
| --- | --- | --- |
| `integration` “Run billing and recovery integration tests” | 956–1384 秒 | 最长，整条 CI 的关键路径 |
| `db-suites` 两个分片 | 484–784 秒 | 同样起 Docker 数据库，第二步再考虑 |
| `build-and-e2e` | 304–485 秒 | 不选 |

试点只放 `integration`：它只需要 Docker、Node、pnpm，不需要任何密钥。

## 2. 怎么跑

- 机器：Owner 的 Mac（M1 Max，arm64）上的 Linux 容器。runner 容器 + 独立的 Docker-in-Docker 容器（不挂载 Docker Desktop 的
  `docker.sock`、用户目录、`~/.graylum`、`~/.ssh`；不放任何密钥）。runner 用一次性的 JIT 配置（`--ephemeral`），只接一个任务，
  任务结束容器和里面起的数据库容器一起销毁。
- 注册令牌：由 Owner 在场用自己的 `gh` 登录当场生成（`generate-jitconfig`），只在内存里传给容器，不进仓库、日志、PR。
- 网络：runner 容器启动时用防火墙规则禁止访问本机和局域网地址（只留公网），然后丢掉 `NET_ADMIN`。
- 资源：runner 容器 2 核 / 2 GB；DinD 容器 4 核 / 5 GB（上限，数据库容器都在它里面）。同一时间只有一个 runner。
  启动前先按“本机建库名额”占一个 `~/.graylum/db-slots/slotN`（只删自己写了 owner 的目录），拿不到就不启动、走 GitHub。
- Docker Desktop 现在只分到 7.7 GB：试点期间 Owner 可能需要调到 12 GB（Docker Desktop 的设置，要 Owner 动手）。

## 3. 开关与回退（默认走 GitHub）

`scope` 任务（仍在 GitHub 机器上）多输出一个 `runner`：只有以下条件**全部**成立才输出 `local`，否则一律 `github`：

1. 仓库变量 `CI_LOCAL_RUNNER` 等于 `on`（默认不存在）；
2. 事件是 `pull_request`，并且 `head.repo.full_name == github.repository`（fork 不行）；
3. 触发者不是 `dependabot[bot]`，PR 作者不是机器人；
4. 本机心跳变量 `CI_LOCAL_RUNNER_SEEN` 在 3 分钟内，并且状态是 `idle`（机器离线、正忙、心跳过期都走 GitHub）。

这个判断放在 `scripts/ci-runner-choice.mjs`，有单元测试，覆盖 fork、Dependabot、关闭开关、心跳过期、忙碌。
`integration` 的 `runs-on` 在 `local` 时是本机标签，否则 `ubuntu-latest`。任务名、步骤、命令、超时一律不变，
所以必需检查名字不变，也没有任何检查被删除或放宽。安全扫描、Workflow Policy Check、Secret Scan 等一律留在 GitHub。
心跳变量由 Mac 上的守护脚本用 Owner 自己的 `gh` 登录写（凭证留在宿主机，不进容器）。
想关：把 `CI_LOCAL_RUNNER` 删掉即可，下一次运行立刻回到 GitHub。

## 4. 两个必须先让 Owner 知道的发现

1. **Workflow Policy Check 现在明令禁止自托管和动态 `runs-on`**（`check-workflow-policy.rb` 的 `approved_runner?`，
   测试 `test-workflow-policy.rb` 里 7 条专门拦截）。这是必需检查，且用“修改前”的基线政策审查。
   所以要分两步：先一个只改政策的 PR，只放开“`integration` 这一个任务、这一个固定的 `runs-on` 写法和固定标签”，其余仍然禁止，
   并新增对应的拒绝测试；合并后再发改 `ci.yml` 的 PR。第一步属于“放宽检查”类规则变更，需要 Owner 明确同意这个具体改法。
2. **公开仓库的 fork 风险不能只靠工作流条件挡住。** fork 的 PR 运行的是 fork 里那份 workflow 文件，恶意 fork 可以把
   `runs-on` 直接改成本机标签，绕过上面的条件。当前仓库设置是“只有首次贡献者需要批准”
   （`fork-pr-contributor-approval = first_time_contributors`）。要真正挡住，需要 Owner 把它改成
   “所有外部贡献者都需批准”（Settings → Actions → General，平台安全设置，只有 Owner 能改）。
   另外，runner 只在试点窗口内才开，平时离线；容器无密钥、无挂载、禁止访问局域网，作为纵深防御。

## 5. 对比与撤回

用 2–3 个真实 PR，各记录：本机与 GitHub 的 `integration` 总用时和逐步骤用时、通过/失败及失败用例、排队等待。
同一提交先后各跑一次（关开关重跑）以排除代码差异。记录 arm64 与 x64 的差异（镜像是多平台索引摘要，两种架构都能拉；
时间、浮点或排序相关的差异单独列出）。本机平均用时不到 GitHub 的一半以下才继续，否则撤回（删变量、停守护脚本、还原政策 PR）。

## 6. 已知局限

- 只有一个 runner：本机正忙时其他 PR 自动走 GitHub，不会排队卡住，但两个 PR 同时判断为“空闲”时第二个会排在后面。
- 本机 Docker 时钟偏差（见内部备忘）可能影响 Runtime 用例：对比时单独记录，不当作代码问题。
- 本机睡眠、断网会让心跳过期，自动回到 GitHub。
