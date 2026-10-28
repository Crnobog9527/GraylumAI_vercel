# 核心路径自动浏览器测试（CORE-PATH-V2 V2-11）

站在用户角度，在已部署的 staging 上走六条核心旅程。跟后台走旧路径还是新路径无关，V2-10 切换前后都用它验收。
配置文件 `apps/web/playwright.core-path.config.ts`（默认的 `playwright test` 不会跑这里）。

## 旅程

| 文件 | 旅程 | 账号 |
| --- | --- | --- |
| `01-positioning-report.spec.ts` | ① 定位三步（含对标）→ 生成报告（确认框 500 积分）→ 13 章 → 定稿；③ 报告停止（前两次 24 小时内免费并全额退回；之后先弹确认，“继续生成”继续、“确认停止”按已生成部分扣费）；⑥ 评审团逐章选择并结算；④a 删除已定稿草稿的对话（留只读条目，旧链接不白屏） | gold |
| `02-free-chat.spec.ts` | ② 自由对话：自动加载 Skill、触发一次研究工具、回复完成、扣费 | pro |
| `04-delete-and-erase.spec.ts` | ④b 删除 20 轮长对话（行消失、旧链接回到起始页）；④c 注销账号（登录被拒） | pro、erase |
| `05-compare.spec.ts` | ⑤ 对比两个模型：两列都有结果，合计扣费 = 各列之和 | gold |
| `99-model-check.spec.ts` | 本次运行里所有语言模型调用都是 Claude Haiku 5.5 | — |

01 里的几个测试共用一份草稿（对标会真实花钱查询，不为每条旅程重建），按顺序跑。

## 花费上限

整套一次 ≤ 0.5 美元（`CORE_E2E_MAX_USD` 只能调低不能调高）。`support/spend.ts` 从 `bill2_runs.provider_cost_usd` 累计这几个测试账号本次运行的**平台实际成本**（不是用户积分：报告固定 500 积分，与成本无关），每个模型回合后检查，超了立刻停止并判失败；每条旅程的花费写进 `test-results/core-path/spend.json` 和 `summary.md`。服务端的止损照旧，不另加。需要 `DATABASE_URL`（只读这两张表和 `profiles`、`report_fees`、`runtime_tool_calls`）。

## 需要的环境

| 变量 | 说明 |
| --- | --- |
| `PLAYWRIGHT_BASE_URL` | staging 网站地址 |
| `DATABASE_URL` | staging 数据库只读连接（花费、24 小时停止次数、Skill 加载记录） |
| `CORE_E2E_STATE_DIR` | 本机：放 `gold.json`、`pro.json`、`erase.json`（Playwright storageState，用 `~/.graylum/staging-login` 生成）的目录 |
| `CORE_E2E_<GOLD/PRO/ERASE>_EMAIL`、`_PASSWORD` | CI：走登录页登录（没有 STATE_DIR 时使用）。注销旅程还需要密码来重新验证身份 |
| `VERCEL_BYPASS_COOKIE` | 如果 staging 有部署保护 |
| `CORE_E2E_PATH=v2` | V2-10 之后设置：额外断言普通对话没有“停止”按钮（旧路径的回复里有，所以此前只记一条说明） |

登录只读：`auth.setup.ts` 不写站点，不动维护模式等全站开关。

## 账号和种子

`node scripts/e2e-core-path/seed.mjs --out <文件>` 建/刷新三个专用账号（gold 至少 6000 积分、pro 至少 2000、erase 100 且每次重建），密码随机、只写进 `--out` 文件（0600），不打印。只接受 staging 项目（脚本里硬校验，正式项目一律拒绝）。需要 `E2E_SEED_SUPABASE_URL`、`E2E_SEED_SERVICE_ROLE_KEY`、`CORE_E2E_EMAIL_DOMAIN`（邮箱域名不进仓库）。写 staging，由总控执行。

## 测试用模型：Claude Haiku 5.5

OpenRouter 有 `anthropic/claude-haiku-5.5`（目录价 输入 $0.1/百万、输出 $0.5/百万，上下文 100 万），但 staging 的 `ai_models` 里**还没有这个模型**（现有 7 个：Qwen3.8 Max、Opus 5.5、Sonnet 5.5、Gemini 3.8 Flash、Gemini 4 Argon、GPT-6 Luna、GPT-6.1 Sol）。不改代码、不给测试账号单独指定模型。用纯配置办法，由总控在测试窗口期间执行，跑完切回：

1. 后台“添加模型”：模型 ID `anthropic/claude-haiku-5.5`，点“从 OpenRouter 读取”，选线路，保存价格快照。
2. `system_settings.runtime_payg_staging` 追加该模型各用途的 profile（对话/报告/整理/研究/评审…），需要小额真实取样证据（`scripts/payg-profile`，Haiku 价格极低，预计远低于 1 美元，仍属付费调用，需先批预算）。
3. 测试窗口 `call_policies` 加该模型条目（价格按 `deriveFrozenPrices`），`billing_payg_start_thresholds` 补对应路线。
4. 切换（跑完切回，先保存原值）：定位 Skill 模块的 `model_id` 和 `report_model_id`（`modules` 表，对话与报告）；`primary_model_id`（自由对话）；`fusion_settings.review` 的评审席位和汇总模型（现为 Argon/GPT/Sonnet/Opus，一次评审就可能超过 0.5 美元，必须换成 Haiku）；`fusion_settings.compare.allowedModelIds` 至少两个可对比模型（对比旅程要两列，可以是 Haiku 加一个便宜模型，需要 Owner 知情，见下）；`assistant_model_id`、`v3_summary_model_id` 如被用到。

对比旅程要“选 2 个模型”：只有一个 Haiku 时，第二个必须是别的模型，那一列就不是 Haiku，`99-model-check` 会失败。要么把同一个模型的两条线路都列进可对比名单，要么对比旅程放宽成“允许名单里最便宜的两个”，请总控定。

## 当前路径与未验证的部分

- 本机没有可跑的后端（没有本地库、模型和供应商），测试只做了类型检查、`--list`、花费计量与种子脚本的单元测试。**六条旅程的选择器来自源码阅读，从未在真实页面上执行**；staging 压测结束后实跑，必然要根据实际页面修一轮。
- 已知风险：模型对话是否按预期给出“信息齐了”（`completeStep` 最多追 4 轮）；对标搜索和候选卡是否出现；确认按钮 2 秒稳定期；注销要重新验证密码并过人机验证（staging 需要用测试密钥）；评审团约 3–4 分钟。
- 20 轮长对话不是种子数据而是用产品本身一轮一个字地建（约 20 次极短调用，不到 1 美分）：运行表带冻结载荷和计费关联，直接 INSERT 不安全。

## 工作流

`staging-e2e.workflow.yml` 是**模板，没有启用**：`.github/workflows` 受工作流策略保护（禁止 secrets、`issues: write`、`github.*` 上下文，超时 ≤ 60 分钟），所以它放不进去。启用要先改这条策略，属规则变更，按 AGENTS 第 1 节需 Owner 批准；批准后移到 `.github/workflows/staging-e2e.yml`，设置仓库变量 `CORE_E2E_ENABLED=true`、`CORE_E2E_BASE_URL` 和各密钥。
