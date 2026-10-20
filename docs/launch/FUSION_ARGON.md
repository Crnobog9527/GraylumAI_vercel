# FUSION-REVIEW：Gemini 4 Argon 接入与配置交接

## 1. 范围与状态

Owner 2026-10-21 决定：执行约束席改用 `google/gemini-4-argon` / `google-ai-studio`，代码改动加一轮 ≤3 美元抽样。
代码仅补模型与线路配对；证据门槛、计费规则和候选校验不变。
抽样在派发前被线路状态阻塞：OpenRouter 指定线路 `status=-2`，现有取证流程要求 `status=0`。
**实际调用 0、费用 0、profile 尚未生成**；[预检记录](evidence/fusion-argon-20261021-preflight.json)。
本轮未执行 staging 配置变更；founder 真实评审也未启动。

## 2. 候选列表为何缺 Argon

`fusionModelOptions` 先从当前测试窗口的 `callPolicies` 取得模型 ID，再逐个按 `admitFusionModel` 检查：
模型有效且可派发、平台密钥匹配、报价、该用途的思考设置、精确线路和有证据的 PAYG 档案。
Argon 原来缺窗口报价、档案和 `paygHostPolicy.ts` 路线条目，因而不能出现在候选中。

本 PR 新增唯一配对 `google/gemini-4-argon → google-ai-studio`。
其他带 Flash 名字的清单属于外部搜索证据识别或旧 AC-0 探针，不参与评审团准入，不应加入 Argon。
后台页没有另一张模型名白名单；总控补齐配置后，同一准入函数会把 Argon 列为可评审。
回归测试调用真实的候选函数和准入链，覆盖配置齐全、缺报价、缺档案、错误线路；不使用准入函数替身。

## 3. 抽样方法和未完成项

已只读核对 Flash 当前档案：`profileVersion=pr665-r9+fusion-20261017-a`，
`evidence.reference=pr665-r9-results-a1d98dde80b4`，完整矩阵 60 样本、15 单元×4、历史压力 12 条、上限128条；
low 的截断证据引用 `pr665-r7-results-a24d1839b5e5`，512 token 两条。
Flash 多用途证据不能移植给新模型；Argon 只开放 `fusion_review`，沿用 Owner 已批准的 FUSION-PROFILE 方案 B。

准备的单轮为 6 个互不相同请求：中档 50,000 B×2、大档 186,000 B×2、512 输出截断×2（中档）。
请求用正式 `reviewerRequest` / `fusionRequestBody` 生成：已发布评审 Skill、公开合成咖啡报告、execution 视角、引文规则、
system+user 两条消息、严格 JSON schema、low、无工具、禁用 web 插件、仅指定完整线路且不回退。
逐条核对正式回执和 generation 查询的身份、费用、线路、缓存、输出含思考、输入比值≤0.7，以及 `openRouterCallBound`。
每次发送前重核目录和剩余预算，超预算或回执未知即停；稳定单轮锁防重复派发，不自动重试。

计划输出上限 4096、截断上限512；新档案保持 `maxBytes=196608`、template/margin各4096、maxMessages128、maxTools2、maxSchemaBytes16384，
用途仅 `fusion_review`，格式仅 `fusion-json-v1-stream`，思考仅low，过期时间与窗口一致为2027-12-31T00:00:00Z。
真实抽样成功后才能写入 reference、manifestHash、实际样本数、比值、最大请求和费用检查结论，并用正式 `paygHostProfile` 校验。
**本 PR 当前没有可应用的 Argon profile；不提供伪造或套用 Flash 的档案。**

## 4. 三处 staging 配置（由总控审计后执行，无 SQL）

共同前提：代码已合入 staging 且包含本次代码的环境已可用、指定线路恢复、抽样成功并提交正式校验通过的profile。
每次改前保存完整原值与摘要，核对当前内容未被其他任务改动；改后读回逐项比对。先profile和报价，最后切席位。

1. **`system_settings.runtime_payg_staging`**：只追加 Argon 的真实抽样档案；保留当前 `version/enabled/windowId`、五条原档案及其内容。
   Argon model=`google/gemini-4-argon`，endpointTag=`google-ai-studio`，purposes仅fusion_review，reasoning仅low，outputLimit4096。
   证据成功后将完整 JSON 放入本 PR；整份设置须通过 `paygHostSettings`，不能把未完成取证字段写为true。
2. **`runtime_test_windows` 的 `call_policies`**：仅在 `897525f9-66f1-4504-8d91-a52d2c0f0e60` 追加模型ID
   `7169edbf-aaa2-414e-ad6d-f79d0751dc16` 的报价；复制现有Flash条目的OpenRouter account绑定，不读取或输出密钥。
   provider=openrouter、protocol=openrouter-chat-v1、inputLimit196608、outputLimit4096、multiplier3；
   providerLimits的providerSlug=`google-ai-studio`、contextTokens1048576；按当前正式 `deriveFrozenPrices` 算得
   prompt和cacheWrite均2.1875、completion10、request0（美元/百万token，request为每次美元），
   对应 `openRouterBound` 上限2.334720000000美元。Google缓存写入0.1875是输入2的附加费，不能只填输入2。
   保持automaticRetry=false、hiddenTools=false、lookupSupported=true；写前重新核价，价格变化先重算；原报价逐条保留。
3. **`system_settings.fusion_settings.review`**：仅把reviewerModelIds中的
   `da9e7046-fddc-4b97-bf65-a275b05d6cf0` 原位置替换为 `7169edbf-aaa2-414e-ad6d-f79d0751dc16`；
   reviewerRoles移除旧Flash键、为Argon添加execution，保留GPT `8122be92-88c7-4be9-9629-14a75c459219`=finance、
   Sonnet `d04a4800-2d3a-43b3-8af9-cb960572e34f`=evidence。
   用后台保存校验，保留汇总Opus、Skill、1轮、意见4096、汇总32768、固定1500积分及其他配置。

恢复：还未发起新评审时按原值恢复席位、删除本次追加的报价和profile；已经冻结的运行单不可改写。

## 5. 验证与后续

新增路线测试先红后绿；真实候选准入测试通过。类型检查和相关ESLint通过；Runtime/Fusion全套、CI、机器人审查另见PR实时记录。
三处配置尚未执行；新Argon真实抽样与计费证据BLOCKED，founder真实评审NOT_RUN。
总控完成三处配置并确认指定线路可调用后，使用已批准founder只做一次真实评审（另限1美元），
核对Argon实际调用、可用修订稿才扣1500、失败退回，并把实际结果写入#716。
本PR不执行合并或部署，不操作正式环境。
