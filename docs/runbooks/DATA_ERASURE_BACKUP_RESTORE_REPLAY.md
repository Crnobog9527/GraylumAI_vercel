# 从备份恢复后重放删除（库外删除清单）

> **还没有演练过。** staging 目前没有每日备份、PITR 也没开（2026-10-12 只读核对），所以这份流程只在本机测试库里验证过
> 各个函数，没有做过一次真实的"恢复 → 重放 → 开放"。正式上线前要按 DATA-ERASURE T16 用虚构账号演练一次。
> 依据：[DATA-ERASURE.md](../launch/tasks/DATA-ERASURE.md) §8、E7、附录 C [S8]；
> [保留期核对清单](DATA_ERASURE_RETENTION_CHECKLISTS.md) 缺口第 5 条。

## 为什么需要

旧备份只包含备份那一刻的数据。备份之后才确认的账号注销、单条删除（回答、对话、成果、内容、资料库文档）
不在里面。如果直接把恢复出来的库开放，这些已经删掉的内容会重新出现。

所以每次确认删除时，数据库在**同一个事务**里写一条"待同步"记录（表 `erasure_manifest_outbox`，迁移 0227），
再由服务端把它复制到**数据库以外**的 Upstash Redis（就是限流用的那个，没有新增供应商）。
恢复备份时，从 Redis 读出这份清单，在开放服务之前逐条重新删除。

清单里**只有**：删除类型、目标编号、账号编号、确认时间。没有正文、标题、文件名、邮箱，也没有内容的 hash。

| 类型 `kind` | 什么时候记 | 目标编号是什么 |
| --- | --- | --- |
| `account` | 账号注销确认（`account_erasure_requests` 新增一行） | 账号编号 |
| `answer` / `session` / `artifact` / `content` | 用户确认单条删除（`content_erasure_confirm` 成功） | 用户选中的那一条，不含它连带删除的其他记录 |
| `library_document` | 资料库文档被删除（`library_delete` 第一次打上删除时间）；已注销账号的清理不单独记，已由 `account` 覆盖 | 文档编号 |

Redis 键名：`graylum:erasure-manifest:<kind>:<目标编号>`，值是上面四项的 JSON。

## 保留多久：35 天

- 每个键在**确认时间 + 35 天**自动过期（`SET NX EXAT`）。重复同步不会延长，因为键已存在时不改写。
- 数据库里的待同步记录，超过 35 天的（不管有没有同步）由每天的注销定时任务删除。
- 依据 [S8]：Supabase 每日备份可访问窗口 Pro 7 天、Team 14 天、Enterprise 30 天；PITR 最长 28 天。
  35 天覆盖其中最长的 30 天，再留几天余量。
- staging：没有每日备份，PITR 未开（2026-10-12 只读核对）。
- **正式环境：套餐和备份窗口未核实，上线前核对。** 如果正式环境的备份或 PITR 保留期超过 30 天，
  必须先把 35 天调大（代码 `ERASURE_MANIFEST_TTL_SECONDS` 和迁移里的 `35 days` 一起改），否则清单会比备份先过期。

## 同步是怎么发生的

1. 删除确认的事务里写入待同步记录。写入失败只记一条不带编号的警告，**不会**挡住或撤销用户的删除。
2. 删除接口返回成功后，服务端顺手尝试同步一次（最多约 3 秒，失败不影响用户）。
3. 每天的注销定时任务（`runAccountErasureExecutor`）再同步一遍所有没同步的记录，并清掉 35 天以前的记录。
   Redis 没配置或连不上时，记录保持"未同步"，定时任务的失败计数加一，第二天继续重试。

**剩余风险**：如果 Redis 在删除后一直不可用，且在下一次定时任务成功之前就不得不用旧备份恢复，那么这一小段时间里的删除
只存在于丢失的数据库里，清单里没有。恢复前先看定时任务最近是否报过同步失败；有的话，把失败那段时间当作"清单不完整"处理（见下面第 1 步）。

## 恢复步骤

整个过程**不开放读写、不派发任何任务**，直到第 6 步通过。

1. **只恢复到隔离的新项目**。不要覆盖正在用的项目，不要把隔离项目接到网站、定时任务、收款回调上。
   先确认最近的注销定时任务没有持续报"清单同步失败"；如果有，停下来报告 Owner，不开放服务。
2. **导出清单（只读）**。在能访问 Redis 的机器上运行：

   ```bash
   # 先空跑：只打印数量、最早和最晚时间，不写文件
   node scripts/erasure-manifest-export.mjs
   # 确认数量合理后，写到本机文件（只有编号、类型、时间）
   node scripts/erasure-manifest-export.mjs --since <备份时间，ISO 格式> --write erasure-manifest.json
   ```

   脚本只用 `SCAN` 和 `MGET`，不会改 Redis。读不完整（包括读取途中有键刚好过期）、发现格式不对的条目、或者没有凭证，都会以非零状态退出，这时重新导出一次。
   **读不出清单就不能开放服务。** 文件用完即删，不要提交到仓库、不要贴到 PR。
3. **导入并按顺序重放**（在隔离项目里，用 service_role，逐条执行；文件里已经排好序：先账号，再按确认时间）：
   - `account`：走产品同样的注销路径——`account_erasure_confirm_with_digests`（防刷摘要用
     `loadOpeningGrantDigests` 从恢复出来的 Auth 用户计算，请求编号用新的 UUID），然后让注销执行器
     （`runAccountErasureExecutor`）在隔离项目里跑到该账号 `stage='completed'`，它会重新删除存储文件和 Auth 账号。
     如果注销被拒绝（例如恢复出来的订阅还在自动续费），停下来报告 Owner，不要绕过检查。
     先核对账号在恢复出来的库里是否存在：`profiles` 里没有这个编号、Auth 里也没有这个用户编号，
     说明账号是备份之后才注册又注销的，恢复出来的库里本来就没有它的数据，记为"不存在"，跳过，不算失败。
     只有其中一边存在（比如有 profile 没有 Auth 用户）时停下来人工核对，不能当成"不存在"。
   - 标了 `supersededByAccount: true` 的单条删除：账号已整体注销，跳过（注销会清掉它）。
   - `answer` / `session` / `artifact` / `content`：先 `content_erasure_preview(账号, kind, 目标)` 拿到
     `previewHash`，再 `content_erasure_confirm(账号, kind, 目标, previewHash)`。
     返回 `CONTENT_NOT_FOUND` 表示这条是备份之后才创建的，恢复出来的库里本来就没有，记为"不存在"。
   - `library_document`：`library_delete(账号, 文档)`，然后运行资料库清理（`cleanupLibrary`），把对应存储文件删掉。
     文档不存在时返回 `deleted`，记为"不存在"。
   - 重放本身会在隔离库里再写一遍待同步记录；它们同步到 Redis 时键已存在，不会改写。
4. **存储文件单独核对**：数据库备份不含 Storage 文件 [S8]。重放后确认被删账号和被删资料库文档的存储路径都已不存在。
5. **核对**：对清单里每一条确认删除标记已经存在：
   - `account`：`account_erasure_requests.stage='completed'`；
   - `answer` / `session` / `artifact`：对应行 `content_deleted_at` 不为空（或整行已不存在）；
   - `content`：`opc_content_versions.erased_at` 不为空；
   - `library_document`：状态是 `deleting` 或整行已不存在。
   另外按 DATA-ERASURE §8：财务的 unknown 和防重复记录照常保留，不能因为恢复重新派发或重新发放开户积分。
6. **只有第 2–5 步全部通过**，才把隔离项目切换为服务项目并开放。任何一条失败、或数量对不上，停下来报告 Owner。
   记录：备份时间、清单条数（按类型）、重放结果（删除 / 不存在 / 失败）、核对结果。记录里不写编号以外的内容。

## 相关代码

- 迁移：`packages/db/migrations/0227_erasure_offdb_manifest.sql`
- 同步：`packages/api/src/services/accountErasure/offdbManifest.ts`
- 导出脚本：`scripts/erasure-manifest-export.mjs`
- 本机测试：`node packages/db/tests/erasure-offdb-manifest/run-local.mjs --local-only`
