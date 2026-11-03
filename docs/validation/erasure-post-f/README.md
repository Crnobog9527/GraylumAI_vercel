# 批次 F 之后：在新路径上重新验证删除对话和注销账号

对应 `docs/launch/tasks/REL-1.md` 第 1.2a 节第 7 项：批次 F（迁移 0495，删除旧 Runtime / BILL2 表）上 staging 之后，
长对话删除、注销审计要在新路径（`turns`、`turn_calls`、`turn_call_raw`、`session_messages` 等）上重新验一遍。

**这份东西现在不碰 staging。** 只有 CI 里的本机套件在跑；staging 步骤要等 F 上库、Codex 验收批次结束之后才做。

## 一、已经在 CI 里的部分

套件 `packages/db/tests/erasure-post-f/run-local.mjs`（放在 `packages/db/tests/` 下，`run-local-suites.mjs` 自动发现，和其他数据库套件一起在 CI 的数据库作业里跑）：

1. 一个账号有两个对话：一个 401 轮（802 条消息、401 份供应商响应原文）的长对话，一个普通对话；另一个账号作对照。
2. 先删长对话：消息立刻从历史里消失，文字和响应原文被清掉，账号的另一个对话不受影响。
3. 再注销整个账号：确认 → 工作清单 → 清内容 / 清会话 / 清回合 → 清账务流水里的自由文字 → 记录库存储证明 → 本地清理，一遍走完，`remaining` 为 0、无人工复核项；会话和清空后的消息随本地清理一并删除（本机结果：会话 0 个留下）。
4. 然后跑只读审计 `audit-account.sql`（和 staging 手工步骤用的是同一份 SQL）：全部通过；回合、回合调用、积分流水这三类账务记录条数和注销前一致；对照账号不受影响。
5. 反向用例（保证审计会变红）：账号还活着时审计必须在“没注销”的各项上失败；注销后人为放回一条消息正文、一份响应原文、一个未关闭的回合，审计必须报出来。
6. 审计在 `BEGIN READ ONLY` 里运行（任何写入都会报错），它调用的两个完成证明函数是 `STABLE`。

套件只点名 F 前后都存在的表，所以 F 合并前后都应该是绿的。F 合并到 staging 之后，同一个套件会在新的函数上重跑一遍，这就是“F 之后注销审计覆盖新表”的机器证据。

审计 SQL 检查什么（每一行带 `expect`，`info` 只展示不判错）：

| 部分 | 检查 |
| --- | --- |
| record | 注销记录存在；资料已关闭、昵称邮箱头像等已清空；`profile_scrubbed_at`、`local_cleaned_at` 已记；没有人工复核代码；用户活动日志的行保留但地址和正文已清；（完整注销时）`storage_verified_at`、`auth_deleted_at` 已记、阶段为 `completed`、站外清单没有未同步项 |
| proof | `account_erasure_body_remaining` 和 `account_erasure_local_remaining` 都为 0（F 里这两个函数被改写，所以它们覆盖新表） |
| core_path | `turn_call_raw` 无行；`session_messages` 无正文、无可见行、哈希是空串的哈希；`runtime_sessions` 已标记清除且 `scope`、`start_payload` 为空；`fusion_turn_outputs`、`fusion_reviews`、`fusion_compares`、会话结果、会话名称无行；没有未关闭的回合、没有费用未定的调用；账务记录条数只展示 |
| post_f | （`--post-f`）旧表 `runtime_executions` 等 7 张已不存在 |
| tables | 所有带账号列的表里该账号还剩多少行（只展示，供人看；带 `erased_at` 的表同时展示还没标记清除的行数） |

## 二、F 上 staging 之后要手工做的步骤

**前提**（缺一不做）：

- 0495 已经在 staging 的迁移记录里，staging 部署包含 F 的 Node 改动；
- 没有 Codex 浏览器验收批次在进行（AGENTS 第 8 节：验收期间任何 staging 写操作先告诉总控、等回复）；
- 注销不可恢复，所以**只能用一次性测试账号**，不要用 user2 等常用验收账号。由总控指定（或由 staging 登录脚本新建）这个账号，并把它的账号编号（profile id）告诉执行的人。
- 本机工作目录只链接 staging（不是正式项目）：在草稿目录里 `supabase link`，不要在仓库里链接。检查脚本会核对链接的项目编号，不是 staging 就拒绝运行。

**角色**：A = 一次性测试账号（被注销的人）；B = 另一个常用测试账号（只用来验证“拒绝”）。

| 步骤 | 谁做 | 操作 | 预期结果 |
| --- | --- | --- | --- |
| 1 | 总控 | 给 A 准备数据：一个**新路径**的长对话（至少 20 轮，来自 100 人复测数据或在已批准的测试预算内用最便宜的模型聊出来），再加一个普通对话。付费调用只能在已批准预算内。 | A 的对话列表里有两个对话 |
| 2 | 执行人 | 注销前先记账务基线（此时审计会因为账号还活着而报红，这是对的，只要基线文件写出来）：`node packages/db/tests/erasure-post-f/check-account.mjs --profile <A 的编号> --workdir <草稿目录> --save-baseline <基线文件>` | 输出里 `core_path/turns_billing_record_kept` 等三项大于 0；`record/*`、`core_path/turn_call_raw_rows` 等报 FAIL |
| 3 | Codex（浏览器） | 用 A 登录；记余额；打开长对话；左侧更多操作 → 删除对话 → 确认；记录 UTC 和耗时 | 几秒内成功；刷新后列表没有该对话；原链接打不开内容；余额不变；另一个对话还在、内容完整 |
| 4 | 执行人 | 只读核对这个对话（`supabase db query --linked --workdir <草稿目录>`）：`select count(*) filter (where visible) visible, count(*) filter (where content<>'') text from session_messages where session_id = '<长对话编号>'` | 两个数都是 0（几分钟内由清理任务清掉正文；刚删完可以先看 `visible` 为 0） |
| 5 | Codex（浏览器，**拒绝**情形） | 用 B 登录，打开 A 的长对话链接 | 打不开、不报错堆栈；B 自己的对话和余额不变 |
| 6 | Codex（浏览器） | 用 A：个人资料 → 注销账号 → 确认身份 → 确认注销；记录 UTC | 立即退出登录；用 A 重新登录失败；页面有进度提示 |
| 7 | 总控 | 等账号注销定时任务跑完（按 cron 间隔，通常几分钟；超过 30 分钟没完成就停下来报告，不要手工补数据） | 注销记录阶段变为 `completed` |
| 8 | 执行人 | 注销后整体审计：`node packages/db/tests/erasure-post-f/check-account.mjs --profile <A 的编号> --workdir <草稿目录> --complete --post-f --compare <基线文件>` | 全部 `ok`，最后一行 `all checks passed`；三项账务记录条数和基线一致；`tables` 部分只剩账务、审计类的表 |
| 9 | 执行人 | 对照账号 B 跑一遍同样的命令（不加 `--complete`） | B 因为没注销而报红（`record/profile_closed` 等），且 B 的消息和响应原文条数没变 |

**通过标准**：第 3、4、6、8 步按预期；第 5 步被拒绝；第 8 步没有任何 `FAIL`，账务记录条数和基线一致。

**失败怎么处理**：注销是单向的，不要手工修数据，也不要重试注销。把审计输出里的 `FAIL` 行原样贴到 PR / 汇报里，由总控判断是代码缺口（补迁移或补函数）还是测试数据问题；一次性账号用完即弃。

**不在范围内**：真实 Stripe / 支付退款路径、站外备份与日志平台是否已清、正式环境（正式站暂停，没有真实用户）。
