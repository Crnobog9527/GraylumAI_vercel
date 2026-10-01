# STG-MENTOR-MODEL：候选实测与 staging 切换方案

2026-10-01；风险 high；仅方案，等待总控审阅及 Owner 对后续实测的批准。
本轮真实推理请求 0 次；未读测试密钥、未写账本、未改 staging 配置、不合并。

## 1. 决策和证据边界

Owner 决定上线后以 Claude / Gemini 为主力、GPT-6 Luna 做整理；DeepSeek 退出，包括 staging。
当前启用模型及导师/整理器分工来自 Owner 本轮提供的信息，未连接数据库复核；测试窗口标识不公开。
此次不是恢复任何旧调用授权，也不借用 #497 尚余预算。

方案分支起点为最新 staging `cb243667ef2526a1a95a39939c6f794b4855035c`。
#497 读取时 head 为 `e3649015cf7e93603bb68754da111a6592ad4414`，仍 draft；
其五字段工具、统一展示、来源校验等下一增量尚在原 Codex writer 范围内。
[writer 与重叠安排](https://github.com/Crnobog9527/GraylumAI_vercel/pull/497#issuecomment-5914676850)、
[最新总控意见](https://github.com/Crnobog9527/GraylumAI_vercel/pull/497#issuecomment-5914946177)。
不把这个旧 head 或历史 Sonnet 22/40 当作新协议验收。

## 2. 固定候选及公开报价

以下为 2026-10-01 无密钥 GET OpenRouter 模型目录及各模型 `/endpoints` 返回的文本 token 价格，
单位 USD / 百万 token。选标准线路，不选 Flex、Priority 或自动路由。
`anthropic` 和 `openai` 本身就是目录返回的完整 tag，不自行追加 `/global`。

| 角色 | 精确模型 ID | 完整 tag | 输入 / 输出 | 思考字节 | 输出上限 |
| --- | --- | --- | --- | --- | --- |
| 导师 G | `google/gemini-3.8-flash` | `google-vertex/global` | 0.75 / 3.75 | `reasoning_effort: "low"` | 8192 |
| 导师 S | `anthropic/claude-sonnet-5.5` | `anthropic` | 2 / 10 | `reasoning_effort: "low"` | 8192 |
| 导师 H | `anthropic/claude-haiku-4.5` | `anthropic` | 1 / 5 | `reasoning: {max_tokens: 1024}` | 8192 |
| 固定整理器 L | `openai/gpt-6-luna` | `openai` | 0.10 / 0.50 | `reasoning_effort: "low"` | 2048 |

官方来源：[G 报价](https://openrouter.ai/google/gemini-3.8-flash)、
[S 报价](https://openrouter.ai/anthropic/claude-sonnet-5.5)、
[H 报价](https://openrouter.ai/anthropic/claude-haiku-4.5)、
[L 报价](https://openrouter.ai/openai/gpt-6-luna)、
[模型目录](https://openrouter.ai/api/v1/models)。
完整线路及价目分别来自
[G endpoints](https://openrouter.ai/api/v1/models/google/gemini-3.8-flash/endpoints)、
[S endpoints](https://openrouter.ai/api/v1/models/anthropic/claude-sonnet-5.5/endpoints)、
[H endpoints](https://openrouter.ai/api/v1/models/anthropic/claude-haiku-4.5/endpoints)、
[L endpoints](https://openrouter.ai/api/v1/models/openai/gpt-6-luna/endpoints)。

推荐三者都保留：G 是速度/成本候选，S 是导师判断质量候选，H 检验较便宜的 Claude 是否足够。
这是测试假设，不是质量结论。G/S 的目录均列出 low 且思考不可关闭；H 没有声明 effort，
故用 Anthropic 原生思考预算 1024，不能伪装成支持 low。
[思考参数与输出计费](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)、
[Anthropic 思考说明](https://platform.claude.com/docs/en/build-with-claude/extended-thinking)。
8192 为可见输出和思考预留空间；仍须记录截断，不能保证零截断。
L 的 low 是本轮建议固定配置，不声称等于 staging 现值；实测前须验证当前 Runtime 能冻结相同字节。

每次请求只允许表内单一 tag，`allow_fallbacks:false`、`require_parameters:true`；
`max_price.prompt/completion` 等于表中价格，另设 `max_price.request:0`。
不启用搜索、付费服务工具、显式缓存写入或多模态；数据收集字段沿用冻结产品请求，不能为了探测自行改变。
G 当前含 50% 折扣；折扣取消或涨价则拒绝调用，不自动提高报价。
L 表中为低于 272000 输入 token 的档位，本方案远低于该档。
缓存折扣不用于预算抵扣，实际缓存/思考用量单列；若出现未覆盖收费项则暂停重新报价。
[路由和 max_price 单位](https://openrouter.ai/docs/guides/routing/provider-selection)。

## 3. 样本、指标和选择方法

复用 #497 已有新卡片规则的 40 题，不用旧 30 卡片 + 10 文字集。
已本地只读核验 40 条及 A12/B6/C12/D5/E5 分布；不公开虚构样本原文、私有 Skill、账号或本地路径。
样本 SHA-256：`0be012a845999a8d6c345a74df7a66e9cb61e3242dac4db98880ef8ebcd2564a`。
[规则与门槛来源](https://github.com/Crnobog9527/GraylumAI_vercel/pull/497#issuecomment-5893603883)。
每个候选用同一 Skill 版本/hash、同一协议 head、同一 40 题和预先冻结的评分规则，各题仅测一次。

- 出卡判断至少 36/40；推荐判断至少 17/18；格式错误最多 1/40，即格式正确至少 39/40。
- 编造用户事实 0 次，正文与卡片不一致 0 次。A 方案选择须推荐，B 中性分类不推荐，C/D/E 不应出卡。
- 格式按最终 #497 五字段契约及宿主实际展示结果判断；包含错误工具、非法参数、无可展示内容、旧信封、截断。
  不为新契约降低上述语义门槛，也不针对样本改提示词。
- HTTP 拒绝、超时、截断、空响应、未完成、费用不明都保留在固定分母并单列。
  发生结果不明即停止整批；没有补题、自动重试或备用模型。未跑满 40 题为 INCOMPLETE。
- 首字：从请求发送到首个用户可见正文增量；另记首个流事件、首个工具参数及卡片可见时间，
  reasoning token 不能冒充首字。完整回复时间到宿主最终可展示结果完成，另记原始流结束时间。
- 每个模型报告首字/完整回复 median、p95、最大值、成功数/计划数；小样本 p95 仅作方向性比较。
  逐轮记录输入、可见输出、思考及缓存 token、provider 实际费用、未知费用预留、完整轮次总费用。
- 复用 `blindReview.ts`：现有工具只支持 1 或 2 个配置，所以分三包各 40 条，包名和材料均匿名，
  评审不看模型、延迟、费用、思考过程；先锁定全部判定再揭盲。不付费调用模型做裁判。

40 题通过的候选才进入端到端小样，失败候选不使用其剩余调用额度。
每个候选另设 3 组两轮脚本，共最多 6 次导师 + 6 次 L 整理调用：
①开场→明确回答；②模糊选择出卡→实际点选；③信息不足→自由文本澄清。
样例固定于执行前，复用既有场景内容和真实返回历史，不伪造工具调用关联。
若该出卡的首轮未出卡，记前提失败，不用替代样本凑数。

端到端必须经冻结的 #497 Runtime/SDK、历史规范化、整理器提示词和输出解析运行：
从用户提交到导师可见、卡片可见、整理完成/草稿落定，分别计时；
核对正文/卡片唯一显示、推荐、作答关联、用户事实提取、不编造、刷新后历史、一次执行一次结算。
思考非零的工具轮续接是否成功单列，未自然产生思考不得声称覆盖。
这一阶段在本地隔离夹具中接真实 provider（后续另批），不需要先切 staging；
任何尚不支持的本地真实链路不得用直接拼 prompt 的脚本替代成端到端证据。

只有全部语义/格式门槛和端到端检查通过才推荐切换；先比较首字/完整耗时，再比较成本。
没有通过者则停下报告，不在本任务改产品提示词或增加样本。

## 4. 次数和预算（全部待批准）

每个候选：40 次单轮 + 最多 6 次端到端导师；L 每个候选最多 6 次。
总计最多 138 次导师 + 18 次 L = 156 次 provider 请求，不是 156 次用户对话。
工具续轮、重试及任何额外调用都必须纳入次数；本方案不留额外请求名额。

以下为提议的约束预算，不冒充已经跑过最终协议的 dry-run。
复用 `callBoundUsd` 的请求字节 + 2048 模板余量算法与 reserve/settle 账本；
导师完整序列化请求最多 90000 UTF-8 bytes，L 最多 32000 bytes，超限拒绝，不截断 Skill/样本。
这里的 bytes 是探测预算约束，不等同于 staging 的 90000 字符用途配置或供应商 token 限额。
执行前须用完整最终请求跑离线预算，确认 tokenizer/工具封装余量和所有计费维度覆盖；
不满足时重新报告，不把本估算当供应商硬限额。

| 模型 | 最多调用 | max_price 输入/输出/request | 单次保守预留 | 单次金额上限 | 本轮累计上限 |
| --- | ---: | --- | ---: | ---: | ---: |
| G | 46 | 0.75 / 3.75 / 0 | $0.099756 | $0.10 | $4.60 |
| S | 46 | 2 / 10 / 0 | $0.266016 | $0.27 | $12.42 |
| H | 46 | 1 / 5 / 0 | $0.133008 | $0.14 | $6.44 |
| L | 18 | 0.10 / 0.50 / 0 | $0.0044288 | $0.005 | $0.09 |
| 总计 | 156 | 不转移模型间名额或费用 | $23.0235984 | — | $23.55 |

金额按 `(bytes + 2048) × 输入价 / 1e6 + max_tokens × 输出价 / 1e6` 计算。
建议批准总额上限 $24，但各模型小计仍按表内约束，$0.45 不是备用重试或额外样本额度。
情景估算（不是测得 token）：每次导师 12000 输入 + 2000 总输出，每次整理 8000 输入 + 1000 总输出，
按全部 156 次约 $3.82；实际取决于 Skill/历史、思考与截断。预算上限覆盖长请求，不能拿情景估算作硬限制。

本地账本只读确认已用 736 次；#497 当前硬上限 736 次/$15。
建议后续将同一本机累计上限设为 892 次/$39（旧上限加本轮 156 次/$24），
同时以本轮启动快照约束增量最多 156 次/$24，不能消耗历史授权余额或清空/换账本。
本轮没有读取或公开密钥余额，没有修改上限。后续先核对账本未漂移、只读确认测试密钥额度足够；
只公开“够/不够”。并发调用者未停、未知费用未结算或基线变化时停止，不挪用额度。

所有阶段单写入、串行；发送前按完整请求保守上界预留到同一账本，并同时检查单次、模型小计和本轮总额。
拿到 provider 可信费用后才结算，失败/未知保留预留并停；不能端到端跑完再补记外部费用。
`max_price` 只是线路单价筛选，不能单独强制本轮美元限额。
现有 probe 还没有本方案全部分模型/端到端共享额度约束，落实及离线测试前不能进入真实执行。

供 Owner 在总控审完、执行准备就绪后复制；此处展示不等于授权：

> 同意 STG-MENTOR-MODEL 按冻结的新协议方案实测：Gemini、Sonnet、Haiku 各最多 46 次，分别不超过 4.60、12.42、6.44 美元，GPT-6 Luna 整理最多 18 次、不超过 0.09 美元；单次上限分别为 0.10、0.27、0.14、0.005 美元，总计最多 156 次、24 美元，本机累计上限设为 892 次、39 美元；只在原账本仍为 736 次且本轮增量单独受限时开始，不重试、不补样本，结果不明即停；不改 staging 配置、不合并。

## 5. 复用方式与单一 writer

本 PR 只新增本方案文档；方案全文也放 PR 描述。本轮不修改探测器或产品文件。
后续允许范围仍为探测配置和结果文档；#497 的产品、提示词、工具契约、Runtime 与数据库均由其 Codex writer 负责。

已有可复用部分是 `ac0Probe/{agentTurn,plan,config,transport,budget,ledger,sse,summary,blindReview}.ts`，
以及 `mentor-browser.integration.ts`、Runtime 集成夹具、真实整理模型代码。
不新建评测框架、账本、数据库表、服务或第二套提示词。

当前确认的准备缺口：
1. staging 尚无 #497 的 v5 probe；旧 C2 固定 30+10 题，不能直接拿来做本次 A–E 40 题；
   现有候选也没有 H 和本次 G/S/H 统一输出预算。
2. 原 probe 是单轮导师评测，并非本次导师/L 整理与 UI/持久化端到端 runner。
3. #497 新五字段产品协议尚未完成并冻结；现有 first-call-only 等 probe 行为须与最终 Runtime 一致，
   不自行复制旧行为强行兼容。新模型配置、计时、预算若需超出配置文件的脚本逻辑改动，先列最小 diff 给总控，
   本轮不实施，也不把其默认为已授权。产品问题回到 #497 writer。

推荐优先等 #497 合入后从新 staging 做纯探测配置；若需提前测：
总控确认 #497 writer 的冻结 head/交接边界后，在该精确 SHA 的独立 detached 本地 worktree 中运行，
仅叠加经审阅的本任务探测配置/结果输出，产品文件逐一保持该 SHA 的 blob 不变；
不 checkout 或写入 #497 正在工作的目录，不 cherry-pick 产品代码到本 PR，不推回 #497。
冻结 Skill/hash、样本/hash、协议 SHA、配置 hash、无网络 dry-run plan ID 和预算后再实测。
协议/输入/配置任何变化均使对应成绩失效，需要重新审定，不能自发多跑。

## 6. 选定后的 staging 切换（由总控另获批准执行）

1. 总控核对胜出模型的新报价、完整 tag、思考字节、实际输出/思考最大值、超时、输入容量；
   复核 #497 已部署版本及已发布 Skill。生成新冻结报价，保留旧执行的报价与历史。
2. 只读核对测试窗口有效期/身份、已用次数、已结算与未决费用及 `call_policies`；
   备份受影响配置的可恢复快照，不公开账号/窗口 ID。另列切换后的 smoke 次数和预算给 Owner 批准，
   不包含在本轮 156 次内。
3. Owner 批准具体切换后，由总控按既有管理入口更新 `ai_models` 中胜出导师和 L 的价格、路由、
   思考/输出限制与启用状态，以及对应导师绑定、整理模型设置；不改 schema 或生产绑定。
4. 更新测试窗口 `call_policies`，精确覆盖导师和 L 两种调用及冻结报价，
   用途预算、调用次数、输出上限与剩余额度须覆盖完整双模型轮次。配置交集不足则不启用。
5. 暂停新导师请求并等待旧 DeepSeek 执行结算，再完成绑定切换和停用 DeepSeek；
   移除其新请求准入，但保留恢复旧执行所需的冻结记录，不删模型历史、不粗暴取消未知状态调用。
   回读模型、绑定、报价与窗口策略的一致性后恢复新请求。
6. 用另获批准的最小 smoke 验证导师正文、卡片作答、L 整理、恢复和 BILL2 实际费用。
   若失败，停止新请求并由总控处理恢复；Owner 已决定禁用 DeepSeek，不能把恢复到 DeepSeek 当默认回滚。
   可恢复配置快照用于核对/结算历史；新导师回退候选另经 Owner 确认。

## Handoff

- 已完成：最新 staging/政策/必需检查核验、相关 writer/PR 检查、公开模型目录和 endpoint 报价核验、
  原 40 题分布/hash 及复用缺口分析；只提交方案文档。
- 本地验证 PASS：预算算术、文档差异/隐私检查、代码大小检查（429 个源码文件）；没有真实调用，未运行最终协议 dry-run。
- CI/Security：创建 draft 后按当前 head 查看，不把旧结果记为通过。
- 独立语义审查：待总控审；保持 draft，不发自动审查请求，不合并。
- 下一步：总控审方案、预算及 #497 依赖；执行准备就绪后再请 Owner 批准具体实测。
  实测准备和 staging 切换是两项不同的后续授权，本 PR 不执行其中任何一项。
