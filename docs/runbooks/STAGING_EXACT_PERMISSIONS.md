# staging 测试权限精确核对

Owner 2026-11-16 已批准（MASTER_PLAN §2.1）：保留远程测试权限，仅核验已有25项列只读授权和3条策略。
清单在 `packages/db/tests/baseline/staging-test-permissions.json`，包含列名、被授权角色、授权来源、权限及策略完整定义。
它不是创建权限的 SQL；不得放入业务迁移或正式建库。不改密钥和远程权限。

## 采集与回放

先核实 Supabase CLI workdir 仍链接指定 staging 项目。以下只生成 SQL / 比对本机文件；远程查询由总控用已链接的 staging CLI 执行：

```sh
node scripts/staging-structure.mjs sql > /absolute/evidence/capture.sql
# 在已核实的 staging workdir 执行，保存完整 JSON，不删行、不截断：
supabase db query --linked --workdir /absolute/staging-workdir -f /absolute/evidence/capture.sql -o json > /absolute/evidence/staging.json
node packages/db/tests/run-db-baseline-replay.mjs --local-only
node packages/db/tests/run-db-baseline-replay.mjs --local-only --staging /absolute/evidence/staging.json
```

生成的查询用 REPEATABLE READ / READ ONLY 事务及 `SET LOCAL search_path=public`；只读目录、不读业务行。
v2 快照保存对象数量和全部定义，拒绝旧散列快照、缺失定义及不一致数量；查询搜索路径不同时不能静默忽略索引差异。
快照是某一时点的证据，不能证明采集后远端没有变化；上库前后分别重新采集。

## 失败条件

- 28项中任何一项缺失、完整定义变化，或本地业务建库出现这些测试权限。
- 多出的列/表权限、策略，或同一张表上任何其他未批准结构差异。
- SELECT变写权限或带转授权、授权对象/角色/来源改变、策略条件/适用角色改变。
- 原有检查发现的问题，或原有平台允许差异已不再出现。

只在 `--staging` / `compare-staging` 路径核验测试权限。普通空库检查继续与仓库指纹和函数快照比对，
不会接受测试权限。成功报告必须列出实际核验的28个对象；不能把这28个对象以外的差异隐藏。

## 本机总控工具安装

本 PR 独立审查、CI通过并合staging后，从包含该合并的干净工作区运行：

```sh
node scripts/install-staging-structure-tools.mjs --target /absolute/controller-tools
```

它只复制本机文件：`mig-go.sh`、`mig-apply.sh` 和 `structure-check/` 内的离线检查程序/清单/查询源；
不会执行上库、合并或平台操作。已有文件先备份在目标目录的 `structure-backup-<时间>/`，安装校验值保存在
`structure-check/install-sha256.json`。安装后先对真实只读快照跑 `compare-staging`，再确认安装校验值。

两个上库脚本都检查staging绑定；前后比较都调用同一检查器，任何读取、解析或比较失败都停止。
执行窗口只能运行 `mig-go.sh <PR> --check`（不带模式也默认只检查）。所有迁移的实际执行仅由主窗口
使用 `MIG_REVIEWED=1 mig-go.sh <PR> --apply`；不再按SQL关键词区分是否需要主窗口确认。
直接调用 `mig-apply.sh` 同样要求主窗口确认标记。

独立审查后备入口要求最近一条针对该版本的独立审查评论具有下列完整提交标记（提交必须为40位）：

```text
独立审查通过
<!-- graylum-independent-review:v1 commit=<完整提交> verdict=pass -->
```

“未通过”“需修改”、旧版本/短提交、重复标记及之后出现的否决不能通过此入口。未解决审查线程仍阻断。
标记是审查结果的机器可读记录，不代替独立审查，也不是执行窗口自行批准自己的权限。
`ALLOW_EXTRA`不再支持。脚本在上库后检查失败时明确报告“已应用、未合并”，不得重新上库。
本次不为验证脚本而实际应用迁移；写入/合并拦截由模拟CLI集成测试验证。

恢复本机工具时保留备份，但不得直接启用旧宽泛过滤来继续上库；先修复精确检查器并重新审查。
没有远程改动，因此本 PR 不涉及远程回滚。
