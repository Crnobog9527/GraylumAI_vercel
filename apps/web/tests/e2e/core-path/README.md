# 核心路径自动浏览器测试（CORE-PATH-V2 V2-11）

站在用户角度，在已部署的 staging 上走核心旅程。跟后台走旧路径还是新路径无关，V2-10 切换前后都用它验收。
配置文件 `apps/web/playwright.core-path.config.ts`（默认的 `playwright test` 不会跑这里）。

## 旅程

| 文件 | 旅程 | 账号 |
| --- | --- | --- |
| `01-positioning-report.spec.ts` | ① 定位三步（含对标）→ 生成报告（确认框 500 积分）→ 13 章 → 定稿；③ 报告停止（前两次 24 小时内免费并全额退回；之后先弹确认，“继续生成”继续、“确认停止”按已生成部分扣费）；⑥ 评审团逐章选择并结算；④a 删除已定稿草稿的对话（留只读条目，旧链接不白屏） | gold |
| `02-free-chat.spec.ts` | ② 自由对话：自动加载 Skill、触发一次研究工具、回复完成、扣费 | pro |
| `04-delete-conversation.spec.ts` | ④b 删除 20 轮长对话（行消失、旧链接回到起始页） | pro |
| `05-compare.spec.ts` | ⑤ 对比两个模型：左列是测试模型（默认 Flash）、右列是对比名单里最便宜的另一个模型，两列都有结果，合计扣费 = 各列之和 | gold |
| `99-model-check.spec.ts` | 本次运行里语言模型调用只允许测试模型、整理和评审汇总模型，以及对比旅程的那一个“最便宜的另一个模型” | — |

**注销账号不在自动测试里**（Owner 2026-10-28：人机验证不改，注销留给人工验收），所以这里没有注销账号、种子和密钥。
01 里的几个测试共用一份草稿（对标会真实花钱查询，不为每条旅程重建），按顺序跑。整套要在 60 分钟内跑完（工作流超时上限）；超时就缩短旅程，不能调大。

## 花费上限

整套一次 ≤ 0.5 美元（Opus 汇总的那次评审如果让整套超出，如实报告）（`CORE_E2E_MAX_USD` 只能调低不能调高）。`support/spend.ts` 从 `bill2_runs.provider_cost_usd` 累计这几个测试账号本次运行的**平台实际成本**（不是用户积分：报告固定 500 积分，与成本无关），每个模型回合后检查，超了立刻停止并判失败，并把“已超”写进 `spend.json`：之后每个测试开始前先检查（`meter` fixture），已超就拒绝开始，所以不会再发起付费调用，worker 重启也一样；账号 id 取自登录会话（storageState 或登录页都行），拿不到就直接失败，不会把“不知道账号”当成零花费；每条旅程的花费写进 `test-results/core-path/spend.json` 和 `summary.md`。服务端的止损照旧，不另加。

## 只读数据库角色（取代 DATABASE_URL）

测试不使用应用的 `DATABASE_URL`，而用 `CORE_E2E_SPEND_DATABASE_URL`：一个只能 SELECT 下面这些列的角色。**角色由总控在 Owner 批准后创建，不写进迁移**。所有这些表都开了行级安全且没有给新角色的策略，所以每张表还要一条只给这个角色的 `FOR SELECT` 策略；测试按账号 id 查（id 取自登录会话），所以不需要读 `profiles`。

```sql
-- 以 postgres 角色执行（staging）。<随机密码> 只放进 CORE_E2E_SPEND_DATABASE_URL 密钥。
create role core_e2e_reader login password '<随机密码>' nosuperuser nocreatedb nocreaterole noinherit connection limit 3;
alter role core_e2e_reader set default_transaction_read_only = on;
alter role core_e2e_reader set statement_timeout = '10s';
grant usage on schema public to core_e2e_reader;

grant select (id, actor_id, created_at, provider_cost_usd)            on public.bill2_runs         to core_e2e_reader;
grant select (run_id, model, selected_cost_usd)                       on public.bill2_calls        to core_e2e_reader;
grant select (actor_id, user_stopped_at)                              on public.report_fees        to core_e2e_reader;
grant select (id, session_id)                                         on public.runtime_executions to core_e2e_reader;
grant select (execution_id, name)                                     on public.runtime_tool_calls to core_e2e_reader;
grant select (id, model_id, name, is_active, config)                  on public.ai_models          to core_e2e_reader;

create policy core_e2e_read on public.bill2_runs         for select to core_e2e_reader using (true);
create policy core_e2e_read on public.bill2_calls        for select to core_e2e_reader using (true);
create policy core_e2e_read on public.report_fees        for select to core_e2e_reader using (true);
create policy core_e2e_read on public.runtime_executions for select to core_e2e_reader using (true);
create policy core_e2e_read on public.runtime_tool_calls for select to core_e2e_reader using (true);
create policy core_e2e_read on public.ai_models          for select to core_e2e_reader using (true);
```

- 角色没有任何写权限、不能读其他列和其他表；`system_settings` 不开放（对比名单从页面上读，价格从 `ai_models.config` 读，里面没有密钥）。
- 连接串用 Supabase 的连接池地址（用户名带项目标识），`ssl=require`。
- 撤销：`drop owned by core_e2e_reader; drop role core_e2e_reader;`，同时删掉 6 条 `core_e2e_read` 策略。

## 需要的环境

| 变量 | 说明 |
| --- | --- |
| `PLAYWRIGHT_BASE_URL` | staging 网站地址 |
| `CORE_E2E_SPEND_DATABASE_URL` | 上面的只读角色连接串 |
| `CORE_E2E_STATE_DIR` | 本机：放 `gold.json`、`pro.json`（Playwright storageState，用 `~/.graylum/staging-login` 生成）的目录 |
| `CORE_E2E_<GOLD/PRO>_EMAIL`、`_PASSWORD` | CI：走登录页登录（没有 STATE_DIR 时使用） |
| `VERCEL_BYPASS_COOKIE` | 如果 staging 有部署保护 |
| `CORE_E2E_MODEL_ID` | 测试用模型，默认 `google/gemini-3.8-flash` |
| `CORE_E2E_SIDE_MODEL_IDS` | 额外放行的模型（逗号分隔），默认整理 `openai/gpt-6-luna` 和评审汇总 `anthropic/claude-opus-5.5` |
| `CORE_E2E_PATH=v2` | V2-10 之后设置：额外断言普通对话没有“停止”按钮（旧路径的回复里有，所以此前只记一条说明） |

登录只读：`auth.setup.ts` 不写站点，不动维护模式等全站开关。

## 账号和种子

`node scripts/e2e-core-path/seed.mjs --out <文件>` 建/刷新两个专用账号（gold 至少 6000 积分、pro 至少 2000），密码随机、只写进 `--out` 文件（0600），不打印。只接受 staging 项目（脚本里硬校验，正式项目一律拒绝）。需要 `E2E_SEED_SUPABASE_URL`、`E2E_SEED_SERVICE_ROLE_KEY`、`CORE_E2E_EMAIL_DOMAIN`（邮箱域名不进仓库）。写 staging，由总控执行。

## 测试用模型：Gemini 3.8 Flash（总控照这一节执行）

模型由 `CORE_E2E_MODEL_ID` 决定，默认 `google/gemini-3.8-flash`。选它是因为它在 staging 已经有每次调用的计费档案（对话、报告、技能匹配、评审、对比），**不需要新增模型、档案或测试窗口条目**；价格是输入 $0.375 + 输出 $1.875（每百万 token）。整理类调用仍是 GPT-6 Luna（便宜，已有档案），评审团的汇总仍是 Opus 5.5（`fusion_summary` 目前只有 Opus 有档案），所以 `99-model-check` 放行：Flash、Luna、Opus，以及对比旅程里“对比名单中最便宜的另一个模型”（`CORE_E2E_SIDE_MODEL_IDS` 可改）。Opus 汇总那一次评审可能是整套里最贵的一笔，花费按实测如实报，超过 0.5 美元由计量直接判失败。

### 写 staging 的清单（总控执行；每步先备份旧值，跑完切回）

| 步骤 | 写哪里 | 内容 | 备份 / 切回 |
| --- | --- | --- | --- |
| 0 | 备份 | 把下面各键当前完整值导出到本机 `~/.graylum/core-e2e-backup-<日期>/`（权限 600，不进仓库）：`modules` 表里定位 Skill 模块的 `model_id`、`report_model_id`；`system_settings` 的 `primary_model_id`、`fusion_settings` | 切回时按它还原 |
| 1 | `modules.model_id`、`modules.report_model_id`（定位 Skill 模块，后台“模块”页或同一张表） | 都改成 Flash：`da9e7046-fddc-4b97-bf65-a275b05d6cf0` | 还原备份值 |
| 2 | `system_settings.primary_model_id`（自由对话） | 改成 `da9e7046-fddc-4b97-bf65-a275b05d6cf0` | 还原备份值 |
| 3 | `system_settings.fusion_settings.review`（走后台保存校验） | `reviewerModelIds` 里的 Sonnet `d04a4800-2d3a-43b3-8af9-cb960572e34f` 原位换成 Flash `da9e7046-fddc-4b97-bf65-a275b05d6cf0`；`reviewerRoles` 去掉 Sonnet 键，加 Flash=`evidence`；保留 Sol `8122be92-…`=finance、Argon `7169edbf-…`=execution、Opus 汇总、Skill、1 轮、固定 1500 积分和其他配置 | 还原备份的整个 `fusion_settings` |
| 4 | 不用改 | `assistant_model_id`、`v3_summary_model_id`（GPT-6 Luna，整理类）保持；对比名单（Sonnet、Flash、Sol、Opus）保持，对比旅程左列 Flash、右列自动选名单里最便宜的另一个（现为 Sol，约 $6/百万） | — |
| 5 | 读回 | 逐项读回上面的键，确认和预期一致；用后台“测试准入”确认 Flash 在对话/报告/评审/对比用途下可被准入（不被“缺报价/缺档案”拒绝） | — |
| 6 | 跑种子脚本、通知实跑 | 见上面“账号和种子” | — |

跑完后按步骤 0 的备份还原第 1、2、3 步。

## 当前路径与未验证的部分

- 本机没有可跑的后端（没有本地库、模型和供应商），测试只做了类型检查、`--list`、花费计量/模型选择/种子脚本的单元测试。**旅程的选择器来自源码阅读，从未在真实页面上执行**；staging 压测结束后实跑，必然要根据实际页面修一轮。
- 已知风险：模型对话是否按预期给出“信息齐了”（`completeStep` 最多追 4 轮）；对标搜索和候选卡是否出现；确认按钮 2 秒稳定期；评审团约 3–4 分钟。
- 20 轮长对话不是种子数据而是用产品本身一轮一个字地建（约 20 次极短调用，不到 1 美分）：运行表带冻结载荷和计费关联，直接 INSERT 不安全。

## 工作流

`staging-e2e.workflow.yml` 是工作流文件的草稿，放在这里是因为 `.github/workflows` 受工作流策略保护。Owner 2026-10-28 批准了这一个文件的例外；策略脚本的改动和文件搬迁在单独的 CI-POLICY PR 里做（只改 `.github/scripts/check-workflow-policy.rb`、它的测试，并把文件搬到 `.github/workflows/staging-e2e.yml`）。该 PR 合并前，这里的文件不生效。启用还需要环境 `staging-e2e` 里的 `CORE_E2E_` 开头的密钥（只列名字）：`CORE_E2E_BASE_URL`、`CORE_E2E_SPEND_DATABASE_URL`、`CORE_E2E_GOLD_EMAIL`、`CORE_E2E_GOLD_PASSWORD`、`CORE_E2E_PRO_EMAIL`、`CORE_E2E_PRO_PASSWORD`、`CORE_E2E_VERCEL_BYPASS`。不用环境里旧的 `E2E_*` 密钥。
