# 核心路径自动浏览器测试（CORE-PATH-V2 V2-11）

站在用户角度，在已部署的 staging 上走六条核心旅程。跟后台走旧路径还是新路径无关，V2-10 切换前后都用它验收。
配置文件 `apps/web/playwright.core-path.config.ts`（默认的 `playwright test` 不会跑这里）。

## 旅程

| 文件 | 旅程 | 账号 |
| --- | --- | --- |
| `01-positioning-report.spec.ts` | ① 定位三步（含对标）→ 生成报告（确认框 500 积分）→ 13 章 → 定稿；③ 报告停止（前两次 24 小时内免费并全额退回；之后先弹确认，“继续生成”继续、“确认停止”按已生成部分扣费）；⑥ 评审团逐章选择并结算；④a 删除已定稿草稿的对话（留只读条目，旧链接不白屏） | gold |
| `02-free-chat.spec.ts` | ② 自由对话：自动加载 Skill、触发一次研究工具、回复完成、扣费 | pro |
| `04-delete-and-erase.spec.ts` | ④b 删除 20 轮长对话（行消失、旧链接回到起始页）；④c 注销账号（登录被拒）**待定**：人机验证的站点密钥是凭证，要 Owner 决定后设 `CORE_E2E_ENABLE_ERASE=1` 才跑 | pro、erase |
| `05-compare.spec.ts` | ⑤ 对比两个模型：左列 Haiku、右列是对比名单里最便宜的另一个模型，两列都有结果，合计扣费 = 各列之和 | gold |
| `99-model-check.spec.ts` | 本次运行里语言模型调用只允许 Claude Haiku 5.5，以及对比旅程的那一个“最便宜的另一个模型” | — |

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

## 测试用模型：Claude Haiku 5.5（总控照这一节执行）

**结论：不是纯配置。** 查证后有三层，第一层要先合一个代码 PR：

1. **代码**：`packages/api/src/services/runtime/paygHostPolicy.ts` 的 `admittedRoutes` 是写死的“已批准的模型/线路”清单（现有：Sonnet 5.5、Gemini 3.8 Flash、Gemini 4 Argon、GPT-6 Luna、GPT-6.1 Sol、Opus 5.5）。没有 `anthropic/claude-haiku-5.5 → anthropic`，哪怕配置写对了准入也认不出它（Gemini 4 Argon 当时就是这样接入的，见 `docs/launch/FUSION_ARGON.md`）。要先开一个小 PR 加这一行和测试（不扩大用途）。
2. **取样证据**：`runtime_payg_staging` 里每个模型/线路/用途组合都要有真实取样证据（`scripts/payg-profile`，Haiku 目录价 输入 $0.1/百万、输出 $0.5/百万，预计整套远低于 1 美元，总控已批上限 1 美元）。Sonnet 现有档案覆盖：skill、report、ordinary、skill_matching、fusion_review、fusion_compare；整理类（organizer、attached_organizer）现在是 GPT-6 Luna；评审汇总（fusion_summary）是 Opus。Haiku 要覆盖的用途取决于下面第 4 步切哪些席位。
3. **配置写入**（下面清单）。

OpenRouter 线路已核对：`anthropic/claude-haiku-5.5` 有 10 条线路，其中 `anthropic`、`google-vertex/global`、`azure/global`、`amazon-bedrock`、`claude-on-aws` 价格为输入 $0.1、输出 $0.5、缓存读 $0.01、缓存写 $0.125（每百万），上下文 1,000,000，最大输出 128,000，都支持 tools 和 reasoning；`*/us`、`*/eu` 区域线路贵 10%。**选 `anthropic`**（和 Sonnet、Opus 同一个线路名，已有同线路的准入与密钥绑定经验）。

### 写 staging 的清单（总控执行；每步先备份旧值，跑完切回）

压测结束、第 1、2 步的 PR 已合并并部署后：

| 步骤 | 写哪里 | 内容 | 备份 / 切回 |
| --- | --- | --- | --- |
| 0 | 备份 | 把下面各键的当前完整值导出到本机 `~/.graylum/core-e2e-backup-<日期>/`（`system_settings` 的 `runtime_payg_staging`、`billing_payg_start_thresholds`、`billing_provider_prices`、`fusion_settings`、`primary_model_id`、`assistant_model_id`、`v3_summary_model_id`；定位模块在 `modules` 表的 `model_id`、`report_model_id`；测试窗口 `call_policies` 数组） | 文件权限 600，不进仓库 |
| 1 | 后台“模型管理 → 添加模型” | 模型 ID `anthropic/claude-haiku-5.5`，名称 `claude-haiku-5.5`；点“从 OpenRouter 读取”，线路选 `anthropic`，保存价格快照（MODEL-PRICING-SYNC）。读回 `ai_models.config.pricing.endpoints` 里有 `anthropic` 且 `admissible: true`；`config.reasoning.route = anthropic` | 切回：该行置 `is_active=false`（不删） |
| 2 | `billing_provider_prices` | 确认后台价格同步已为该路线写入价格；缺则按后台“价格”页补（输入 0.1、输出 0.5、缓存读 0.01、缓存写 0.125 每百万，单位与其他模型一致） | 备份见步骤 0 |
| 3 | `runtime_payg_staging.profiles` | 追加第 2 层取样 PR 产出的 `*.profiles-draft.json` 里 Haiku 的档案（写前用 `paygHostProfile` 校验整份 value；不得出现重复的 Haiku/线路档案；保留 version、enabled、windowId 和全部原档案） | 切回：移除追加的 Haiku 档案 |
| 4 | 测试窗口 `call_policies` | 追加 Haiku 条目（provider openrouter、protocol openrouter-chat-v1、account 沿用 Sonnet 的同一平台绑定、providerSlug `anthropic`、contextTokens 1000000、multiplier 与窗口一致、价格按 `deriveFrozenPrices`）；写前重新核价；断言只改目标窗口恰好 1 行 | 切回：移除该条目 |
| 5 | `billing_payg_start_thresholds` | 为 Haiku 每个用途补一条（同模型 Sonnet 的 typicalUsd 可作参考，取样 PR 会给出名义成本） | 切回：移除这些条目 |
| 6 | 把用到的席位切到 Haiku | ① 定位 Skill 模块：`modules.model_id`、`modules.report_model_id`；② `system_settings.primary_model_id`（自由对话）；③ `assistant_model_id`、`v3_summary_model_id`（整理/摘要，现为 GPT-6 Luna；不换就会在 `99-model-check` 里出现 GPT-6 Luna）；④ `fusion_settings.review`：`reviewerModelIds`、`reviewerRoles`、`summaryModelId` 全换成 Haiku（现为 Sonnet/Sol/Argon + Opus 汇总，一次评审就可能超过 0.5 美元）；⑤ `fusion_settings.compare.allowedModelIds` 在原名单（Sonnet、Gemini 3.8 Flash、GPT-6.1 Sol、Opus）基础上追加 Haiku，**不要**另加第二条 Haiku 线路。对比旅程自动选 Haiku + 名单里最便宜的另一个（现为 Gemini 3.8 Flash），并断言它确实最便宜 | 切回：按步骤 0 的备份逐项还原；`allowedModelIds` 去掉 Haiku |
| 7 | 读回 | 逐项读回上面的键，确认和预期一致，并用后台“测试准入”看 Haiku 在上述用途下可被准入（不被“缺报价/缺档案/错线路”拒绝） | — |
| 8 | 跑种子脚本、通知实跑 | 见上面“账号和种子” | — |

跑完后按步骤 0 的备份切回第 6、5、4、3 步，Haiku 模型行可以保留（置为停用）。

## 当前路径与未验证的部分

- 本机没有可跑的后端（没有本地库、模型和供应商），测试只做了类型检查、`--list`、花费计量与种子脚本的单元测试。**六条旅程的选择器来自源码阅读，从未在真实页面上执行**；staging 压测结束后实跑，必然要根据实际页面修一轮。
- 已知风险：模型对话是否按预期给出“信息齐了”（`completeStep` 最多追 4 轮）；对标搜索和候选卡是否出现；确认按钮 2 秒稳定期；注销要重新验证密码并过人机验证（staging 需要用测试密钥）；评审团约 3–4 分钟。
- 20 轮长对话不是种子数据而是用产品本身一轮一个字地建（约 20 次极短调用，不到 1 美分）：运行表带冻结载荷和计费关联，直接 INSERT 不安全。

## 工作流

`staging-e2e.workflow.yml` 是**模板，没有启用**：`.github/workflows` 受工作流策略保护（禁止 secrets、`issues: write`、`github.*` 上下文，超时 ≤ 60 分钟），所以它放不进去。启用要先改这条策略，属规则变更，按 AGENTS 第 1 节需 Owner 批准；批准后移到 `.github/workflows/staging-e2e.yml`，设置仓库变量 `CORE_E2E_ENABLED=true`、`CORE_E2E_BASE_URL` 和各密钥。
