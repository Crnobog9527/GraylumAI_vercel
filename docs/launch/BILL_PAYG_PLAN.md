# BILL-PAYG 边用边扣实施方案（#553 存档，仅供参考）

> 本文件是 [#553](https://github.com/Crnobog9527/GraylumAI_vercel/pull/553) 描述最后一版的原文存档，于 2026-10-05 关闭该 PR 时存入仓库（MASTER_PLAN 第 2.1 节第 54 项）。分隔线以下逐字节未改：142946 字节，SHA-256 `e431af202d821b2dc4cba2115098471c7a4e5d66e6e8283e2a64f50f26cf41d5`。
> 这不是 Owner 定稿文件：其中 Owner 的决定已写进 MASTER_PLAN 第 2.1 节第 13、26、27、32、33、41、42 项，以那里为准。后端已由 #617、#631、#632 及后续修复实施（见 BILL_PAYG_RUNTIME_B1.md、B2.md）。
> 剩余工作（默认切到 v2、管理员提醒页面、模型准入实测）实施时参考本文对应小节；文中"待总控复审""在途"等状态描述是当时的状态，已经过时。

---

## 结论与授权

**BILL-PAYG，风险 high，仅实施方案，修订v3，已获[总控方案通过结论](https://github.com/Crnobog9527/GraylumAI_vercel/pull/553#issuecomment-5926383915)，三条说明已通过；Owner已定q=100、全站默认m=3及余额封顶冻结，本轮同步模型/线路级m_i；本轮统一修订，待总控复审。** 按 [Owner 2026-10-01决定](https://github.com/Crnobog9527/GraylumAI_vercel/pull/547#issuecomment-5915435152)：所有模型调用改为边用边扣；每次调用前按完整输入＋回答上限估算费用，并以锁内可用余额封顶冻结；按真实费用的累计积分差额结算、实扣不超本次H，多余释放；可用余额低于模型/用途启动门槛时不发下一调用，暂停在步骤之间，充值后从原断点继续；不允许负余额。

推荐沿现有 BILL2 run/call/receipt、原钱包与预扣原语改造，不新建钱包、账本、队列或后台生成服务。**一个用户操作仍一张run；一次call一份预扣；run累计费用只进位一次，通过每次结算的累计差额实现。** Runtime增加必要的持久断点和“等待积分”状态，充值到账不自动重发模型，用户回到原任务继续。若充值期间页面仍打开，可在原任务明确继续授权下恢复；支付webhook本身不持有模型派发权。

本决定取代REPORT-GEN v3的报告固定上界预扣及④过渡选择，D16全站默认加价倍数按Owner决定为3，模型/线路可覆盖且每call冻结m_i（本轮只改方案），也不取消Fusion运行前预告。Master Plan由 #559 同步；按最新实施交接，后续 BILL-PAYG 实施 PR 必须同步 docs/launch/tasks/V3-BILL-2-provider-authoritative-billing.md 中整run预留、run与预扣一对一及超额需逐笔人工授权的旧条款。保留精确成本、锁序、原子结算、唯一钱路、原请求与未知结果恢复等不冲突保证；本轮只修订方案，不改这些文件。

本PR创建时从origin/staging **fe8e7860a7536574a4c50d41880b2a8441a194b0** 建立，分支 `codex/bill-payg-plan-20261001`，空提交head **135d4c197a630e613ea692c0fe9742079e295869**。零文件差异，全部方案在PR描述。已读当前AGENTS第5节、工程规范、相关源码与PR；未修改代码/SQL/配置，未连接远程DB，未发真实调用，不请求机器人审、不标ready、不合并。

（2026-10-02 开工前核对）写入方已交给 Claude 规划窗口（[接手记录](https://github.com/Crnobog9527/GraylumAI_vercel/pull/553#issuecomment-5954509751)）。本描述已对照 origin/staging `4d805783`（已含 #497 `255259cf`、#550 `7b880fc4`、#565 `7909c118`、#581 `1d75b130`、#591 `9600f2bc`）以及 #590 head `9874815e`、#593 head `a294c984` 的实际代码核对；修订处都标了本标记，汇总见末尾"2026-10-02 开工前核对"。Owner 2026-10-02 决定 #590 合并后开工、由 Codex 实施（[5952671504](https://github.com/Crnobog9527/GraylumAI_vercel/pull/553#issuecomment-5952671504)）；实施说明草稿见"Codex 实施说明草稿"一节，需要 Owner 决定的两个问题见"需要 Owner 决定的问题"一节。（2026-10-02 审查后修订）两个问题 Owner 已定，见"Owner 已定的问题"；新增的"管理员提醒"一节和审查后的其他改动见末尾"2026-10-02 审查后修订"。（2026-10-02 提醒设计修订）"管理员提醒"一节已改为读取时计算，见末尾"2026-10-02 提醒设计修订"。

## 1. 现有能力与最小改动

| 现有机制 | 可复用 / 不足 |
| --- | --- |
| bill2_runs，一操作一run，actor/request幂等 | 保留任务、规则、来源、总止损上限和聚合成本权威。当前prepare一次扣整run、reserved>0、唯一pre_deduct，不能直接支持逐call。 |
| bill2_calls，run/sequence唯一、dispatch token、官方ID与receipt | 保留调用身份、先claim后dispatch、未知不重发。在call补预扣ID、冻结积分、结算差额/状态、调用时间界限；不用额外calls表。 |
| atomic_pre_deduct / 原settle/refund，profiles.credits、grant来源、quarantine | 复用原子锁与资金来源。现有settle可接受超预扣实际费用，PAYG必须在调用它之前验证实扣D=min(累计理论差额Δ,H)<=本次hold，不可透支。 |
| credit_transactions / billing_history / token_stats | 保留唯一账务来源；现有“run＋reason_code唯一”只容一条reserve/spend，须按v1/v2分开索引与call幂等键，不删除旧约束后任意重复写。 |
| Runtime prepared/running、原回复重放、Session版本 | 现有live只给首次prepared，恢复不能继续派发；需窄化的checkpoint/epoch准入，不是让所有running重新获得live。 |
| 0108测试窗口 | 保留行锁、白名单和费率一致。全run一次费用/次数预占、整对象报价匹配须版本化调整为每次call的受控派生合同。 |

**必要新增信息，优先原表加列**：run增加v2合同分支、累计完整官方USD、累计加权计价USD W、理论应计积分、用户实扣与平台承担积分、paused_reason、最小继续状态版本；call增加pre_deduct_id、reserved_credits、charged_delta、结算/释放状态、quote证据及dispatch/recovery截止；断点、暂停数据、checkpoint引用/游标与epoch统一存在bill2_runs新增列中，不塞入execution或run的冻结payload，不覆写旧primary_result。列名以最终SQL设计为准。~~不预占迁移编号。~~（2026-10-02 开工前核对）迁移编号按第9节：B1（#593）已占 0159，PAYG 取其后的空号（B1 先合并则为 0160）。旧run.pre_deduct_id仅用于v1，新v2为空；v2允许零run预留，不能把0伪装成一次已扣款。

不另建表的依据：钱的身份已有run/call，内容已有execution/session/receipt，充值履约已有订单/grant。真正缺的是**call与现有预扣的一对一关联、可幂等结算的累计差额，以及下一次尚未发送调用的恢复权**。若落地发现有界checkpoint容纳不了必要SDK状态，先测现有存储/拆引用；不能预先建通用工作流平台。

## 2. 每次调用的实际冻结上限

1. 在任何扣款前，用原Agent SDK的确定输入投影构造**本次实际发送**的完整request：system/Skill、选定历史、工具定义及已知工具结果、模型、reasoning、outputLimit、provider路由。hash绑定最终bytes。组织后的下一次请求尚不可知时，不提前按整个上下文或整任务冻结。
2. 首版使用 **`T = B + K_family + M_family`**：B为本次最终请求序列化后的UTF-8字节数；K_family为按模型族及锁定协议profile写死的模板/协议/工具schema额外开销上界；M_family为同profile的固定安全余量。模型须通过下述两条准入路径之一；闭源路径是有损失承担规则的经验上界，不声称数学证明。B必须来自最终实际request，覆盖system/Skill、历史、工具schema及工具结果、转义和归一化；不得用字符数、报告容量限或模型context替代实际bytes。输出O为本次可强制约束的总输出上限；reasoning若不包含在O内，必须有独立硬上限R并按对应单价另计，否则拒绝。
3. **准入两条路径任选其一**，均绑定精确model、endpoint完整tag、协议/profile、证据版本、K/M、requestHash和报价版本，不按模型族前缀放行。最终request变化即重算。
   - **公开分词器证明（开源）**：核验精确版本的tokenizer、规范化、chat template与实际端点一致；证明普通文本token≤最终UTF-8 bytes，模板/特殊token/工具展开由有界K覆盖。不能只凭“BPE”名称通过；预处理扩张须计入B，无法证明服务端一致则此路径不通过。K由message/tool/schema硬限推导，M不替代证明。这条规则保留供以后开源模型使用，首版无开源候选。
   - **实测验证＋上线监控（闭源）**：按下列冻结样本、阈值和安全余量验证精确模型/线路；合格后每次记录原生prompt token与T之比，接近或超过阈值立即退出收费准入，复用既有冲突和对账记录。有限样本不证明所有未来输入，风险由用户单次扣款不超过H、差额由平台承担、估算异常停止新派发及低于启动门槛暂停共同约束；不再要求闭源模型提供公开分词器。

   两条路径均须限制messages、tools、schema大小与B；超出已验证profile直接拒绝。基础公式 `U=(T×输入最高单价+O×输出最高单价)/10^6+本次固定费用上界`。（2026-10-02 修订）**输入最高单价 = max(普通输入价, 5分钟缓存写入价, 适用的长上下文档位价)**（依据 [#572](https://github.com/Crnobog9527/GraylumAI_vercel/pull/572) 方案第4.3节）：缓存写入价本身就是写入token的总单价，取max后**不再另外逐项加入缓存写入加价**，避免在T×普通输入价之外再加一次T×写入价。该定义适用于所有有写入费的线路，包括不加缓存标记、但自动写入按1.25倍收费的GPT-6 Luna；Gemini以后若启用显式缓存，写入价=输入价+5分钟存储费，向上取整到12位小数。长上下文档位价指T达到或可能达到档位阈值（如Luna的272000 token）时用高档价，否则须把T限制在阈值以下。独立reasoning或其他计费单位仍逐项加入；缓存折扣不提前抵减。锁定provider路由、max_price，禁止fallback/hidden retry；联网、搜索等插件关闭。首版仅文本单模型；多模态及多模型收费不放行。tokenizer或供应商计token接口仅作后续降低冻结额的可选优化，首版不新增该运行依赖。

   （2026-10-02 开工前核对）**与已合并代码的对应关系**（行号为 staging `4d805783`）：
   - 价格取值已由 #581 实现：`packages/api/src/shared/modelPriceBound.ts` 的 `deriveFrozenPrices(model, endpoint, promptTokensUpper)` 对每个适用档位取 max(普通输入价, 缓存写入总价)；Google 线路，以及写入价低于输入价的线路，按"输入价＋写入费"相加（两者都是12位定点，精确相加，不需要再取整；上文"向上取整到12位小数"按此理解）。长上下文档位只在 `promptTokensUpper ≥ minPromptTokens` 时计入，分时档总是计入；输出价取 max(输出价, internal_reasoning 价)。`packages/api/src/services/bill2/openRouterPolicy.ts:32` 的 `openRouterBound` 再取一次 max(promptUsdPerMillion, cacheWriteUsdPerMillion)。两处都是取最大值、没有叠加，与本节定义一致。
   - 与现状的差异：今天 `deriveFrozenPrices` 的 `promptTokensUpper` 和 `openRouterBound` 的输入量都是整个 `contextTokens`（`runtime/pricingAdmission.ts:89`、`openRouterPolicy.ts:38`），PAYG 改为本次 T。实施时在 `openRouterPolicy.ts` 新增一个单次上界函数，与 `openRouterBound` 使用同一条 max 规则和同样的12位向上进位：`U = 向上进位到12位小数((T×输入单价 + O×输出单价)/10⁶) + requestUsd`。`openRouterBound` 原样保留，供 v1 和窗口的稳定上限使用；由于 T+O ≤ contextTokens，单次U不会超过窗口的 upperUsd。
   - reasoning：现有线路的输出单价已经取了 max(输出, internal_reasoning)，OpenRouter 的 max_tokens 也包含思考，所以 R 不单独加项。只有无法把思考限制在 O 之内的线路才需要独立的 R，首版一律拒绝这类线路。
   - #591 缓存：缓存标记由 `runtime/providerRequest.ts:70` 的 `applyPromptCache` 加到最终请求上；之后 `runtime/execute.ts:131` 才做字节容量检查，`:133` 计算 requestHash（#590 head 上为 138/140 行）。所以 **B 直接取这份最终请求的 `Buffer.byteLength`，88 字节的缓存块开销（`runtime/promptCache.ts` 的 `PROMPT_CACHE_OVERHEAD_BYTES`，已复算为88）已经包含在 B 里，K/M 不再另加**；`runtime/admission.ts:189-190` 预留的88字节只是容量预留，不进入U。写入溢价通过冻结的 `cacheWriteUsdPerMillion` 并入输入单价（没有该字段时 `freezePromptCache` 不加标记）。同一线路上不带标记的调用（匹配、整理）也按含写入价的单价冻结，这只影响冻结额H、不影响实扣，首版接受这一保守量。长暂停后继续时缓存早已过期，下一次会重新写入，费用仍在U之内。
   - 价格来源（Owner 2026-10-02"正式环境价格全自动"，[#581 合并记录](https://github.com/Crnobog9527/GraylumAI_vercel/pull/581#issuecomment-5951733074)）：**正式环境**（RUNTIME-PROD 接入时）每次 claim 前用最新价格快照（超过7天按 `pricingAdmission.ts` 的 `renew` 重读）调用 `deriveFrozenPrices(model, endpoint, T)`，得出本次单价、`max_price` 和U；涨价就按新价冻结，不拒绝、不要求重新批准；读价失败或出现未知价格字段时拒绝本次新 claim，提示"价格暂时无法确认"，不当作余额不足。派生报价记录 `pricingHash` 和端点完整 tag，作为报价版本。**staging 测试窗口**继续锁价：U 使用窗口冻结的单价（这些单价按 contextTokens 推导，已含全部档位，偏保守），不按 T 重新推导去降价；涨价按 #581 现有规则拒绝。
   - （2026-10-02 审查后修订）**正式环境的平台成本风险**：价格全自动时，平台没有事先固定的美元损失上限。每次调用的供应商收费受本次 `max_price` 和单次上界U约束，一个 run 的调用数也有上限；但价格可以持续上涨，又不设绝对单价或美元闸门，所以总损失没有事先固定的上界。用户实扣不超过 H，余额不会被扣成负数；平台只在余额封顶时承担 E（另有估算超界时超出U的部分，按第3节记为 e_bound）。按 Owner 决定不另加美元闸门，靠"管理员提醒"一节的价格变动提醒和平台承担提醒让管理员及时发现。
   - （2026-10-02 第三轮复核后修订）**正式模式的价格快照来源**：`runtime/pricingAdmission.ts:58-78` 的 `renew` 在写入失败或 CAS 冲突、重读后仍没有新鲜的已存快照时，会使用本次网络读到但没有写入的快照（`fresh_unwritten`）。正式模式不能沿用这条分支：新 claim 只能使用成功写入的快照，或重读得到的新鲜已存快照，并且派生报价里的 `pricingHash` 必须与这份已存快照一致；确认不了时，按"价格暂时无法确认"拒绝本次新 claim。staging 现有的 fallback 行为不变，也不借这次改动悄悄修改。必测：写入失败、CAS 冲突且已存快照仍过期、并发写入了新鲜快照这三种情况。

4. 这不是只改数据库upperUsd：`openRouterPolicy`、Runtime `stagingPolicy/admission/providerRequest`、adapter独立复核、strict frozenCallPolicy/call、SQL prepare/claim/dispatch必须认同同一新版算法。最终内容或输出上限变化就重新计量；已claim的请求不可替换。（2026-10-02 开工前核对）需要一起改的重复校验点：`runtime/stagingPolicy.ts:33`、`runtime/providerRequest.ts:61-62`、`bill2/openRouterAdapter.ts:127-128` 目前都要求 `upperUsd` 与 `openRouterBound(limits, outputLimit)` 完全相等；SQL 端 `bill2_claim`（最新定义在 0157）要求 `upper_cost ≤ policy.upperUsd`，并按 `ceil((已用加权成本+upper×m)×q) ≤ r.reserved` 判定。v2 分支改为：稳定上限仍按原等式核对；每次派生的U由新函数重算，必须完全相等且不超过稳定上限；SQL 按 v2 分支核对单次 G/H/A/L，不再与 r.reserved（v2 为0）比较。
5. q=frozen creditsPerUsd=100，全站默认m_default=3，模型/线路可覆盖；每call冻结其有效m_i；上界冻结额G_i=ceil(U_i×q×m_i)（此处U_i为本call费用上界），实际H_i=min(G_i,A_i)。A_i在原profile/grant锁内计算，排除同钱包全部其他在途冻结且不重复扣除已预扣部分。先满足模型/用途门槛A_i≥L才可新claim；不要求A_i≥G_i。总run费用/次数和窗口预算仍按完整供应商U占用，不因H变小放大真实额度，不预冻未来所有calls。

### 首版模型准入清单与依据

收费模型与第三方成本先按官方价格统一换成美元，再按冻结兑换参数换成平台积分；不能直接沿用第三方积分数，也不能用固定积分附加费代替美元成本。BILL-UNIT落实q=100、全站m_default=3、可空模型/线路覆盖及逐call m_i冻结；staging配置由总控在Owner批准后修改。

按[准入更正](https://github.com/Crnobog9527/GraylumAI_vercel/pull/553#issuecomment-5925575062)及[最终清单](https://github.com/Crnobog9527/GraylumAI_vercel/pull/553#issuecomment-5925598947)，首版只覆盖 **Claude、Gemini、GPT-6 Luna**；DeepSeek退出，包括staging，GPT-4o与Qwen也不列入首版。此处是方案候选，不表示已通过实测或已经修改收费配置；历史调用仍保留原恢复与结算能力。

| 用途 | 本批精确候选 / 完整线路tag | 准入依据 |
| --- | --- | --- |
| Claude导师/写作候选 | `anthropic/claude-sonnet-5.5` / `anthropic` | 实测验证＋逐次监控，未执行、未准入 |
| Gemini导师/写作候选 | `google/gemini-3.8-flash` / `google-vertex/global` | 实测验证＋逐次监控，未执行、未准入 |
| GPT-6 Luna整理 | `openai/gpt-6-luna` / `openai` | 实测验证＋逐次监控，未执行、未准入 |

精确候选沿用[#561模型方案](https://github.com/Crnobog9527/GraylumAI_vercel/pull/561)，不替代其质量/切换验收。执行准备时复核完整线路、模型版本和实际支持参数；别名更新、线路或profile变化须重新验证，不继承旧成绩。报告用途还须独立满足容量和语义要求；本轮token计量样本不能当作完整报告生成验收，不挪用 #547 三次额度。

### 闭源验证矩阵、阈值与安全余量（拟议，待批准）

- 每个精确模型/线路 **60个不同样本**：中文、英文、代码、JSON、工具定义五类 × 三档最终request长度 × 每格四种变体。三档分别为不超过4KiB、不超过32KiB、不超过192KiB；中/大档分别落在其上限的90%–100%，每格至少一例精确上限。小档覆盖最小合法请求及4KiB边界。全部为合成内容；中文含混合标点/emoji/NFC与NFD，英文含长数字/稀有词，代码含转义/高熵标识符，JSON含嵌套/Unicode转义，工具类含定义及历史工具结果。禁止无意义填充JSON字段来压低比值。
- 冻结样本hash和profile后才执行：最终B≤196608 bytes，messages≤32，工具定义≤2，工具schema序列化总量≤16384 bytes；三档工具样本分别按该档B允许的schema大小覆盖，中/大档覆盖16384 bytes schema上限，至少覆盖最大message数/多轮工具历史。生产若需要更大profile，另做验证，不能外推。正文与完整request只在受控测试材料中，不进入公开汇报。
- 试验profile统一拟定 **K=4096 tokens、M=4096 tokens**，`T=B+8192`。闭源K是待实测验证的协议预留，M为额外固定余量，不冒充供应商公开模板证明。最大B时T=204800；加输出/独立reasoning必须仍在精确模型容量以内。无法满足则该profile不准入，不擅自缩样本或放宽阈值。
- P采用官方原生prompt token总数（含输入缓存命中部分，不从P中扣掉缓存），同时计算 `rB=P/B` 与 `rT=P/T`。每个模型须60/60都有可核验的B/P/线路/成本，且 **max(rB)≤0.70、max(rT)≤0.70**，并无费用越界或未覆盖收费项，才通过。这要求至少30%的观测比例余量，另有固定M；只报均值/P95不能代替最大值验收。缺数/失败/超时不算通过，不补跑凑足60。
- （2026-10-02 修订）**样本须包含缓存场景**：Claude线路按PROMPT-CACHE（#572）冻结格式带缓存标记的请求，以及自动缓存线路（GPT-6 Luna、Gemini隐式缓存）的重复前缀请求。P仍取官方原生 `prompt_tokens`（含cached与cache write），另记 `prompt_tokens_details.cached_tokens` 和 `cache_write_tokens`，并验证写入溢价已被U覆盖（c≤U）。#561的无缓存样本不能证明写入溢价已覆盖；rB/rT阈值不变。
- 固定 `reasoning_effort: low`，拟定本批总输出硬限1024 tokens（含reasoning）；本批成绩仅覆盖该输出/profile，报告等更大输出用途须补相应profile验证和单独预算，不用本批成绩直接放行；若该端点不能证明O覆盖reasoning且没有独立硬限，则不发送。测试只验证输入计量，可见内容被截断不作为质量成绩；若截断仍有完整原生usage/成本则可计量，否则缺数。工具定义/历史为合成输入，不执行模型要求的真实外部工具，也不自动追发下一轮。
- **专项采样只补 #561 覆盖不到的格子**：#561 执行准备统一记录每次最终request的B、按本方案计算的T=B+8192、供应商原生prompt_tokens，以及精确model/线路、requestHash、profile、类别/长度和输出/缓存设置。#561自身预算算法的bytes+2048不能冒充本方案T；两者分别标记，不改变其已定试验。复用同一精确model/线路及可核验输入协议的完整证据，按“5类×3档×4变体”逐格去重。同一请求的重复/缓存对照不重复占不同样本名额；不能把约112次总调用机械地从180中相减。
- #561导师输出8192、整理输出2048与本专项1024不同：保留其原设置，逐项核验输入协议/模板一致性后，证据仅用于相应输入计量覆盖；输出及缓存收费边界仍按各自profile验证，不据此扩大收费准入。无法确认输入等价或缺B/P的记录不计复用。代码、JSON、工具定义、192KiB等格子的实际缺口由覆盖表确定，不预设必然全部缺失。
- **批准预算按扣除复用后的实际缺口申报**：等 #561 准备完成，先逐格列出可复用的既有证据、#561冻结计划覆盖及剩余专项样本；与 #561 一起报Owner。每模型新增数N为未覆盖格子的变体缺口之和，最多60；专项预算按这些新增请求的完整报价U逐项相加，并受下表单次/分模型上限约束。#561计划覆盖在执行后必须由合格实际证据确认；失败/缺数不自动扩充专项、重试或补样本，重新说明缺口再报。复用只减次数和预算，不把节余转成额外样本。

| 精确候选 | 零复用时新生成调用上限 | 每次USD上限 | 该模型USD总上限 |
| --- | ---: | ---: | ---: |
| Claude Sonnet 5.5 | 60 | 0.50 | 30.00 |
| Gemini 3.8 Flash | 60 | 0.25 | 15.00 |
| GPT-6 Luna | 60 | 0.05 | 3.00 |
| 合计 | **180** | 分模型限制 | **48.00** |

**48美元仅为专项绝对上限，不是预期花费，也不按整额申请批准**；实际申请须以扣除 #561 复用部分后的缺口清单和逐样本报价为准，连同 #561 批次一起报Owner。准备尚未完成，当前不虚报实际缺口数或应批金额。执行前用当时完整价目、T/O/R和所有收费项逐样本预演，U必须≤对应单次上限；费用预算按“已知实费＋所有未决上界＋下一次U”保守占用，三个分模型上限不可互借。调用串行、禁止自动重试/补样本；任何超上限、费用不明、身份或usage不明即停止本批。只允许沿原call查账，最多每call三次、合计最多540次原ID查询，不生成新内容；若查询本身收费，须计入同一预算，费率不明不查询。#561、#547预算独立，本批不得转用其授权。未准入模型只在Owner批准的受限验证窗口测试，不对普通用户开放收费，不为测试绕过现有收费准入；若现有验证路径还不支持B计量，先完成经审阅的最小实现和无网络预演。

总控审阅及执行准备完成后，由Owner明确批准本批具体样本/线路/预算才可调用。本轮实际生成调用 **0次**、费用 **0美元**，不创建/修改窗口或模型配置。

### 每次调用监控与退出收费配置

准入后每call保存B/K/M/T、P、rB/rT、冻结m_i及来源/版本、精确model/线路、profile/证据版本、requestHash、官方费用、U/G/H、启动门槛及用户实扣/平台承担关联。P未知记null与原因，不记0；走原有界查账，未知期间不继续该run，不能把缺失监控当通过。新监控字段持久化失败也不能继续派发。

- **接近阈值**定义为 `rT≥0.80`；另设 `rB≥0.80` 同等退出条件，防止固定K/M掩盖输入分词漂移。任一call达到即将该模型从所有新收费准入中移出，不等累计或反复超额。0.70以上、0.80以下仍记录对账，不自动放宽profile。
- **超过上界**：P>T或实际费用c>U（2026-10-03 名义费用收费修订），或名义费用n>U（第3A节第4条）等估算上界失效，记budget_conflict，停止新调用。用户最多承担本次H，超出由平台自动承担，不需逐笔人工批准；完整实际费用保留。只超token而尚未超美元仍属输入上界失效，不能因缓存折扣继续收费。仅Δ>H且c≤U/P≤T的余额封顶情形是预期承担，不设budget_conflict、不停用模型；正常0.80接近阈值的独立监控仍有效。
- 复用 `bill2_receipts` 现有JSONB记录计量异常原因及标量，沿 `bill2_runs.conflict` 锁住关联run，并在现有模型准入检查中读取该模型未解除的异常拒绝所有新claim；管理员通过现有 `ai_models.is_active` 管理入口停用该模型收费配置（若同时影响其他用途须明确展示），不可等待人工停用才阻断新收费。已有在途call按各自hold收尾，未知结果不重发。需验证并发claim与异常落账的串行边界，已获派发权的算在途，不承诺撤销供应商已接收请求。
- 近阈值记录不是虚假的财务超额：只记准入异常及原conflict标志，真实费用仍按receipt结算，不制造平台损失。现有conflict会拦截结算，实施时必须在原恢复入口区分“计量准入异常”和“身份/费用证据矛盾”：前者允许可信原call在H内幂等收尾，后者继续原拒绝规则；不能为恢复派发而清掉冲突。复用现有模型汇总报表，不建新表、报警服务或独立状态机。解除停用须重新验证精确profile并经原配置批准流程，不自动恢复或切到其他模型。

可选后续优化：[Anthropic计token接口](https://platform.claude.com/docs/en/api/http/messages/count_tokens)、[Gemini计token接口](https://ai.google.dev/api/tokens)。这类计量还需核对与最终路由输入一致性，不代替费用覆盖、官方结算及线上监控，首版不依赖。


### 总控只读聚合：表、字段与当前缺口

本轮只核对仓库源码/迁移，未连接staging数据库。下列现有结构已对照当前staging源码 `cb243667ef2526a1a95a39939c6f794b4855035c` 的 `0105_v3_bill2_authoritative_runs.sql` 与 `openRouterEvidence.ts`；查询前总控再核验实际表结构。只读事务、只投影标量与聚合，不返回payload整体或正文。

| 表 | 现有字段 / JSON路径 | 用途和限制 |
| --- | --- | --- |
| `public.bill2_calls` | `id, run_id, model, provider, account_namespace, state, dispatched_at, created_at, selected_cost_usd, upper_usd`；`payload->>'requestHash'`、`payload->>'protocol'`、`payload#>>'{providerLimits,providerSlug}'` | 按call关联及去重；account_namespace仅作内部隔离，不输出值。providerSlug是冻结路由tag，不把OpenRouter聚合provider字段当上游线路；有实际线路回报时交叉核对。 |
| `public.bill2_receipts` | `call_id, created_at, id, conflict, payload_hash`；payload内 `source, final, cost, providerId`；`payload#>>'{usage,sdkResponse,usage,prompt_tokens}'` 及同级 `completion_tokens`、`prompt_tokens_details`、`completion_tokens_details` | 响应receipt里取得原生输入token、缓存/思考标量。完整终态usage才可采纳；按call择权威一致记录，不能把response/lookup重复计样本。 |
| `public.bill2_receipts`（已留存lookup） | `payload->>'rawBody'` 解析JSON后的 `data.native_tokens_prompt`、`data.provider_name`、`data.total_cost` | 当前lookup投影usage=null，原生数若有仅在原始lookup JSON。仅在DB内安全解析并提取这些数字/线路，不返回rawBody，也不取prompt/completion内容；无合法JSON或字段缺失计缺失。读取已存lookup不等于批准新网络查询。 |
| `public.bill2_runs` | `id, contract_version, conflict, state, provider_cost_usd, reserved, charged, created_at` | 关联run状态/冲突、区分v1/v2与总费用。不能把run费用重复分配到每call当其成本。 |

**关键缺口**：现有 `bill2_calls.payload` 只有requestHash和配置限额，没有最终实际B/K/M/T；`inputLimit`、Runtime `purposeBudget.inputBytes`是限额，不是本次B。`requestHash`不能还原长度；`octet_length(payload::text)`测的是报价JSON，不是供应商request。现有统计表是run聚合，也不能拼出每call输入比值。因此现有staging数据可先聚合调用数、原生token分布、缺失率、成本及冲突，但如果没有同call/requestHash绑定的可信B证据，**token/B和token/T分布必须标记不可计算**，不能读正文重构后冒充实际发送bytes。

PAYG实施时在原 `bill2_calls.payload` 的受控派生报价中拟加 `metering.{requestBytes,templateTokens,marginTokens,inputUpperTokens,profileVersion,evidenceVersion,endpointTag}`，与requestHash一起在派发前冻结；在原 `bill2_receipts.payload` 拟加 `metering.{nativePromptTokens,tokenSource,ratioToBytes,ratioToUpper,missingReason,admissionIssue}`，从官方证据按call投影，保留原cost真值。以上JSON键为**拟新增，当前不存在**；纳入已有65536/524288容量约束、严格schema和幂等校验，不另建表。rB/rT可由存下的P/B/T复算，比例展示不得因舍入漏掉边界。

总控READ ONLY聚合按精确model/线路/profile、日期及（有可信标签时）样本类别/长度分组，输出call总数、有效配对数、B/P/线路/类别各缺失数，rB/rT的min/P50/P95/P99/max，≥0.80及>1数量，官方USD、费用超额与冲突数；无证据字段的统计返回unknown。排除fixture/未派发，冲突和缺数单列不得丢弃；身份不一致的样本不参加通过分布。同call多份矛盾receipt须先标冲突，不择较低token数。无需profiles、钱包余额、用户标识、对话、session或源材料表。旧模型统计可辅助对账，但不能转作首版三模型的准入证明。

响应原生token口径见[OpenRouter Usage Accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting)；lookup只用[Generation原生字段](https://openrouter.ai/docs/api/api-reference/generations/get-request-&-usage-metadata-for-a-generation)的 `native_tokens_prompt`，不与其他标准化token字段混用。本轮未取得历史实测分布，不声称任一模型已通过。


### q=100、各call继承默认3的冻结算例与启动门槛

以下沿用Owner给定价格，仅演示所有相关call均继承全站默认m_i=3的情景，有效换算率为300；有模型覆盖时按该call冻结m_i重算，不能直接沿用表值。q及倍数映射在原操作冻结，每call保存对应值；旧合同不变。U仍为完整供应商USD上界，G_i=ceil(U_i×q×m_i)，A为锁内可用余额，H_i=min(G_i,A)，先满足模型/用途L。
普通导师B=40000 bytes、T=B+8192=48192、O=8192（含reasoning）；价格沿用总控给定的Sonnet输入/输出2/10、Gemini 0.75/3.75 USD/百万token，假设无额外收费且不提前抵扣缓存折扣。（2026-10-02 修订）**下表及下方报告压力表均未计缓存写入**：按第2节的max定义，Sonnet输入价应取5分钟写入价2.5，普通导师U=48192×2.5/10⁶+8192×10/10⁶=0.20240美元，G=ceil(0.2024×100×3)=61积分；Gemini不加显式标记、隐式缓存无写入费，仍为21积分。

| 模型 | U（USD） | G=ceil(U×100×m_i)，此表m_i=3 | A=100时H | A=30时H（仅在L≤30时允许） |
| --- | ---: | ---: | ---: | ---: |
| Sonnet 5.5 | 0.178304 | 54积分 | 54积分 | 30积分 |
| Gemini 3.8 Flash | 0.066864 | 21积分 | 21积分 | 21积分 |

Gemini精确进位为21积分（20.0592向上取整）；总控“约20”是近似值。A低于G本身不再导致拒绝，A低于L才因积分不足暂停。以上是假设余额的单call例子，不是门槛默认值，也不保证整轮完成；附属整理等下一call按当时A及其模型/用途L重新判定。同钱包在途冻结、实际成本、用途限制仍以真实证据为准。

历史报告压力情景沿用O=24576（不代表当前已批准8192被扩大）、K=M=4096，价格不变：

| 最终请求B | T | 模型 | U（USD） | G，q=100/各m_i=3 | A=100时H（须L≤100） |
| --- | ---: | --- | ---: | ---: | ---: |
| 142942 | 151134 | Sonnet 5.5 | 0.548028 | 165 | 100 |
| 142942 | 151134 | Gemini 3.8 Flash | 0.2055105 | 62 | 62 |
| 174934 | 183126 | Sonnet 5.5 | 0.612012 | 184 | 100 |
| 174934 | 183126 | Gemini 3.8 Flash | 0.2295045 | 69 | 69 |
| 196608 | 204800 | Sonnet 5.5 | 0.65536 | 197 | 100 |
| 196608 | 204800 | Gemini 3.8 Flash | 0.24576 | 74 | 74 |

报告压力例不改变专项采样单次USD预算或实际输出配置。完整U仍占试验窗口及run总成本预算，不能因为用户只冻结100积分就少占平台风险额度。所有真实费用均保存，用户实扣按第3节封顶。

#### 模型/用途启动门槛（复用system_settings）

复用私有system_settings，拟用有界配置对象 `billing_start_thresholds`，键为精确model＋purpose（如interactive、organize、report），条目含整数 `thresholdCredits`、典型成本USD及加权成本、样本数/时间范围、证据版本和计算用q/模型倍数映射版本。管理员在原配置入口保存、校验、读回；不建配置表或门槛服务。键名为拟定，实施时沿现有设置约定落实。

推荐默认计算方法：从 #561 和获批专项中取该模型/用途完整典型单轮证据。单一倍数场景取官方USD成本P50为typicalUsd（2026-10-03 名义费用收费修订）（改为名义费用n的P50，见第3A节第7条），`L=max(1,ceil(typicalUsd×q×m_i))`。一轮包含主回复、匹配、整理等不同倍数时，先逐轮计算 `weightedRoundUsd=Σ(n_i×m_i)`（2026-10-03 第六轮复核后修订），再取同模型/用途/profile分组的P50，`L=max(1,ceil(q×P50(weightedRoundUsd)))`；不能先对原始总USD取P50再乘某个模型的倍数。列出样本数、P50/P95、覆盖与缺数，原始USD同时保留；不同线路/输出/版本不混样。P50只定义启动体验，不保证整轮无平台承担。缺样本不编造默认、不以0或估算U代替实费，由总控形成有证据候选后按原配置流程应用，本轮无额外调用。

纯算术示意（非实测）：单一模型典型单轮$0.02、q=100、m_i=3得L=6，m_i=2得L=4；$0.01且m_i=3得L=3。全站默认/模型覆盖或q变化时，重新计算新操作所用门槛版本；原run恢复选择与其冻结q及倍数映射相容的门槛版本，不套新倍率强改旧合同。每次claim保存生效L和设置版本，门槛设置变更只影响尚未claim且计价版本相容的新调用，不撤销已有H或改变结算。缺少相容有效配置时拒绝新收费并说明配置待处理，不误提示充值可修复。

A在原profile/grant锁内基于有效、未过期、未quarantine、未被其他在途hold占用的来源计算；含同钱包其他run和遗留钱路的未决冻结。原预扣已从可花余额扣除的hold不能再减第二次，未扣余额的占用必须减掉一次；以现有原子钱包/来源账为权威，不用前端缓存或profiles总数直接当A。A≥L才领取call并冻min(G,A)；A<L时不占新call/窗口名额，持久waiting_credits并提示“余额低于本次启动门槛，请充值后继续”。充值后再判定A≥L，不要求补足G。

旧全局最小预扣不得成为L之外另一隐藏启动门槛；PAYG按新合同分支用上述L/H，旧合同保护不被删除。异常设置/查询失败、权限/来源限制、窗口不足分别处理，不伪装成充值可解决。L不修改已冻结调用，也不使余额封顶免费化：收费用途L至少1，A=0无法开始。

#### 输入上界优化仍为可选，输出维持已批准值

仅保留有证据时的输入计量优化：`T_new=ceil(r_max×(1+s)×B)+K`；r_max来自精确模型/线路/profile的 #561 复用及专项缺口样本max(P/B)，不得用均值或缺B记录代替。尚无合格实测r_max；下面假设B=40000、K=4096、s=50%、导师O=8192、q=100/各m_i=3，列的是G而非余额封顶后的H：

| 假设r_max | T_new | Sonnet G（原54） | Gemini G（原21） | Luna整理G（原2） |
| --- | ---: | ---: | ---: | ---: |
| 0.25 | 19096 | 37，少17 | 14，少7 | 1，少1 |
| 0.40 | 28096 | 42，少12 | 16，少5 | 2，不变 |
| 0.60 | 40096 | 49，少5 | 19，少2 | 2，不变 |

Luna仅整理参照，沿 #561 输入/输出0.10/0.50、O=2048。有限样本不证明所有未来输入；新算法需冻结版本、回算全部证据仍满足max(P/B)≤0.70及max(P/T_new)≤0.70，并保留0.80监控退出、估算超界异常和旧call原合同。余额封顶时若A已低于新旧G，收紧G可能不改变H；也可能减少单次H并增加平台承担，须一并评估，不能承诺只会降低冻结而无成本影响。该优化不自动采用、不新增额度。

交互及报告保持Owner已批准的8192及其reasoning覆盖规则，回复长度不随余额改变；历史24576仅作压力算术，未授权上线。开户赠送100积分及模型选择未随本次决定修改；仅全部调用m_i=3时，100/(100×3)约为$0.333333的计价供应商成本等值，不是现金价值或一轮保证。q=100及默认m=3已明确，模型/线路覆盖由Owner决定并经管理员配置，不由本方案选具体值。



## 3. 逐调用结算与累计一次进位

（2026-10-03 名义费用收费修订）**本节公式里向用户收费的 c_i 一律换成名义费用 n_i，见第3A节；c_i 保留为实际费用，只用于对账和平台真实成本。**~~下面的原文保留作历史记录，凡与第3A节冲突的以第3A节为准。~~（2026-10-03 第六轮复核后修订）下面的公式已改为基于收费基准 n_i（名义费用；`actual_fallback` 时为 `min(c_i, U_i)`），与第3A节一致。

q在run冻结，每call冻结自己的有效倍数m_i，不能把run总成本乘一个统一m。记c_i为本call完整官方可计价USD（（2026-10-02 修订）即OpenRouter回执 `usage.cost`，已包含缓存读取折扣和写入溢价；不再用 `cache_discount` 或token数另行加减缓存金额），U_i为本call估算费用上界；与BILL-UNIT通式中的实际成本U_i同义的是本节c_i，避免把上界混入实费。S=Σc_i保留原始供应商成本，另记 S_n=Σn_i 为累计收费基准USD，W=Σ(n_i×m_i)为累计加权计价USD。N=ceil(q×W)为累计理论应计积分；C是用户累计实扣，E是平台累计承担的未收积分，因此BILL-UNIT通式的理论C在这里记作N。

本次收费基准n_i确定后（实际费用c_i同时入账），在同一run/call/钱包事务内：

- `Δ_i=ceil(q×(W+n_i×m_i))−ceil(q×W)`；先逐项精确乘各自倍数再求和，整个累计值只进位一次，不逐call取整后相加。
- `G_i=ceil(q×U_i×m_i)`，`H_i=min(G_i,A_i)`；用户实扣 `D_i=min(Δ_i,H_i)`，平台承担 `e_i=Δ_i−D_i`；释放H_i−D_i，沿原来源有效性/quarantine规则。
- 更新S←S+c_i，S_n←S_n+n_i，W←W+n_i×m_i，N←N+Δ_i，C←C+D_i，E←E+e_i；结算前缀满足 **C+E=N=ceil(q×Σ(n_i×m_i))**。S、S_n、W保留完整费用，不抹掉平台承担，也不是以后可追收的债务。
- 下次Δ减去理论N，绝不能减用户实扣C；否则会追回平台已承担部分。重复receipt返回原D_i/e_i；结单只核对，不补收E，充值/恢复不清空S/W/N/C/E。
- n_i≤U_i时，Δ_i≤ceil(q×n_i×m_i)≤G_i，但H_i可能小于G_i，所以Δ_i>H_i本身不是估算异常。仅n_i>U_i、c_i>U_i、P>T或原上界/证据异常沿原异常规则处理。

例1：三个call各$0.001，m_i分别1、2、3，q=100，加权累计为0.001/0.003/0.006，理论累计进位1/1/1，Δ为1/0/0；H各至少1时用户总收1积分。例2（假设）：首call Sonnet继承m_1=3，L=6、A=30、G=54、H=30；n_1=$0.12≤U=$0.178304，Δ_1=36、D_1=30、e_1=6，正常封顶不设budget_conflict。余额不足下一用途L时暂停；充值后下一call使用操作快照中的另一模型m_2=2，n_2=$0.01且H_2≥2，Δ_2=ceil(100×(0.36+0.01×2))−36=2，不是8；累计C=32、E=6、N=38，不补收旧6积分。

同时发生余额封顶和估算超界时，用结算前W计算 `Δ_bound=ceil(q×(W+min(n_i,U_i)×m_i))−ceil(q×W)`，`e_cap=max(Δ_bound−H_i,0)`，`e_bound=e_i−e_cap`。两者非负、相加等于e_i，分别归因为上界以内的余额封顶和超上界额外承担。n_i>U_i（或c_i>U_i）即使取整使e_bound=0，仍记估算异常及完整超界USD；identity/cost矛盾仍拒绝结算。

按[Owner模型级倍数记录](https://github.com/Crnobog9527/GraylumAI_vercel/pull/565#issuecomment-5928229374)及 #565，run开始保存q、全站默认倍数及获准模型/线路的有界有效倍数映射，复用既有冻结payload/callPolicy；每call从该快照冻结m_i、来源和版本。后台改价只影响新操作，长暂停及未claim的原操作后续步骤仍用原映射；不以当前配置重解释旧run/call。映射外新增模型须新操作授权，不用单一run multiplier覆盖混合模型。供应商单价仍按原规则在未claim时重读获准报价并算U_i/G_i，与商业倍数快照分开。（2026-10-02 开工前核对）"重读获准报价"在正式环境指每次 claim 前按最新价格快照自动推导（见第2节），长暂停后继续也用当时的新价，q 和 m_i 仍用原操作快照；staging 测试窗口仍用窗口锁定的单价。范围1–20、至多两位小数、管理员专用及读取失败拒绝新收费均沿 #565；旧冻结合同兼容不变。

精度复用 #565 精确十进制定点方案：~~12位USD乘2位倍数至少保留14位加权中间量~~（2026-10-03 第六轮复核后修订）名义费用 n_i 最多18位小数，乘2位倍数后加权中间量至少保留20位，q按精确值相乘，只有最终积分ceil；不得先舍入W或用JS浮点累计。W与原S分开保存并按run锁及sequence更新，防止混合模型重算旧前缀。未来最小字段/迁移与完整payload容量验证仍在原表内完成。

### 余额封顶的平台承担对账

复用bill2_calls的结算元数据、bill2_receipts官方成本证据与现有后台报表，拟记 `purpose, available_before_hold, start_threshold, threshold_version, upper_credits(G), reserved_credits(H), theoretical_delta(Δ), charged_delta(D), platform_cap_credits(e_cap), platform_bound_credits(e_bound), cap_applied, frozen_multiplier(m_i), multiplier_source, multiplier_version`。字段为待实施，按原表加列或受控JSON存放，不新建账本/异常表。余额快照只用于受控财务审计，不进入公开报告。

按**精确模型＋用途＋日期**汇总封顶call数、正常封顶承担积分、异常承担积分、官方真实USD、实际扣款积分、理论应计与封顶比例；同时提供 `sum(e_cap_i/(q×m_i))` 的**按冻结费率折算的计价成本等值USD**，逐call精确相加、仅展示时舍入。它用于Owner比较门槛和各m_i，不冒充供应商多开出的账单或真实现金亏损；官方成本仍取receipt，净毛利另结合实际收入/赠送来源计算。例2的6积分对应$0.02计价成本等值，官方成本仍完整记录$0.12。每call展示倍数、来源/版本、原始成本、加权计价、Δ/D/E和退款关联；按模型及用途汇总成本、实际净扣积分和收入，复用 #565 财务口径：名义积分收入不冒充现金，赠送来源无现金收入，实际收入沿原支付/来源分摊，未能分摊须明确标记。

封顶承担记入现有超额对账体系，原因明确为balance_cap，**不设置budget_conflict或模型退出标志**；估算异常标为estimate_bound并沿原监控/停新派发逻辑。重复回执、退款和迟到成本沿原call身份做幂等关联/逆向记录，聚合不得重复计数；已承担部分不是用户欠款，不随充值追收。

### 账务写入与退款兼容

call.pre_deduct_id绑定原billing_history；credit_transactions按v2 callId＋reserve/release/spend幂等，保留v1唯一索引。用户账本只写D，不写Δ或平台承担e为用户消费；run统计是这些明细的投影，不重复再写run spend。token_stats/usage保留原run聚合、partial/final/unknown与真实USD。邀请返利等下游只按D及唯一交易ID执行，不按理论Δ或平台承担返利。

无dispatch释放原H；确定不收费c=0。确认平台/供应商故障且整个操作无可用交付时，先封闭新派发，再按原call来源释放未结算hold、对已收D做关联原消费的唯一补偿；不退理论Δ或平台承担e，不再调用仅支持未结算预扣的refund碰运气。实际恢复受原grant过期/reversed/quarantine保护；supplier成本和承担记录保留并标记冲正原因，不伪造负成本，不因迟到receipt重扣。可用部分已交付、取消或不满意沿原证据规则处理，不扩大退款承诺，不改历史终结run。



## 3A. 名义费用：向用户收费的基准（2026-10-03 名义费用收费修订）

Owner 决定（2026-10-03，原话）：「向用户按名义费用收费（缓存和折扣都不让给用户，选 A），并进 #553 边用边扣实施」（[总控记录 5957160656](https://github.com/Crnobog9527/GraylumAI_vercel/pull/553#issuecomment-5957160656)）。本节取代前文"用户实扣按真实费用 `usage.cost`"的说法：**向用户扣的积分按名义费用 n_i 计算；实际费用 c_i（OpenRouter 回执的 `usage.cost`）原样记账，只用于对账和统计平台真实成本。** v1 运行单的结算方式不变。

**1. 名义费用的定义**

对 v2 的每个 call：

`n_i = [P × 输入标价 + (completion_tokens − R) × 输出标价 + R × 思考标价] ÷ 10⁶ + 请求标价`（2026-10-03 第六轮复核后修订）（token 标价按每百万 token 计，所以 token 部分除以10⁶；请求标价按每次计，不除）

- P 是本次全部输入 token：回执的 `prompt_tokens` 总数，包含缓存读取和缓存写入的部分，不扣除。
- completion_tokens 是输出总数，OpenRouter 的这个数已包含思考 token。R 是其中的思考 token（`completion_tokens_details.reasoning_tokens`）。档位里没有单独的 `internal_reasoning` 价，或它等于输出价时，思考 token 就按输出标价计，此时不需要 R。
- 输入标价、输出标价、思考标价、请求标价，都取价格快照里该端点的 `prompt`、`completion`、`internal_reasoning`、`request` 字段，单位与快照相同（token 价为美元/百万 token，请求价为美元/次）。**不用** `input_cache_read`、`input_cache_write` 的价格，**不用**快照里的 `discount`。
- 用户的理论应计照旧：`ceil(q × Σ(n_i × m_i))`，只在累计值上向上取整一次（第3节的公式不变，把 c_i 换成 n_i）。
- 精度：标价是12位小数，乘以 token 数再除以10⁶，n_i 最多18位小数；在 SQL 里用 numeric 精确保存和累计，只在最后换算积分时向上取整，不用浮点。

**多档位怎么取标价**：
- 长上下文等按输入 token 数分档的价格（快照 override 的 `minPromptTokens`）：按**本次实际的 P** 落在哪一档取价，也就是 `minPromptTokens ≤ P` 的档里阈值最大的那一档；没有满足的就用基础价。某档没写的字段继承基础价。整次调用的全部 token 都按这一档的标价算，与供应商的分档计费方式一致。
- 分时价（override 带 `utcDays`/`utcStart`/`utcEnd`）：（2026-10-03 第六轮复核后修订）**已定（Owner 选 C，[总控记录 5957737094](https://github.com/Crnobog9527/GraylumAI_vercel/pull/553#issuecomment-5957737094)）**：名义费用里的分时价一律取该线路所有时段中最贵的价格。具体做法：每个字段取"上一步按 P 选出的档位价"和"所有 token 条件被 P 满足的分时价"中的最大值（不带 token 条件的分时价总是计入）；便宜时段不让，更贵时段照收，与请求实际在哪个时刻处理无关。这和第2节上限U"分时档总是计入"一致，所以名义费用不会超出U。面向用户的说明要写明"有分时价的线路按最高时段标价计费"（见第8条）。首版三个模型的快照里有没有分时价，开工时核对。~~这是按"折扣不让给用户"做的技术解释；如果 Owner 希望按请求发出的时刻取分时价，需要另行决定。~~

**2. 每个 call 冻结什么**

现在冻结的 `promptUsdPerMillion` 是"普通输入价、缓存写入价和所有适用档位中的最大值"，只适合算上限U。直接拿它算名义费用会多收，所以要另外冻结一份标价表：
- 字段：派生 quote 新增 `nominalPricing`，存在 `bill2_calls.payload` 里，并与 run 的 `callPolicy` 条目一致：`{ version: 'nominal-v1', pricingHash, endpointTag, tiers: [{ minPromptTokens, prompt, completion, internalReasoning?, request }…], timeOfDay: [{ minPromptTokens?, prompt, completion, internalReasoning?, request }…] }`。基础价记为 `minPromptTokens: 0` 的一档；`discount` 不存。总大小受快照最多16个 override 的限制，远小于 payload 的65536字节上限，仍按第7节测完整 payload 的边界。
- 推导：在 `shared/modelPriceBound.ts` 里与 `deriveFrozenPrices` 并列新增一个纯函数（例如 `deriveListPrices(endpoint)`），复用同一套"读字段、缺字段继承基础价"的逻辑，输入同一份价格快照、同一个端点，不另起价格来源。~~冻结时检查：每档的标价都不超过同一快照推导出的冻结上限单价（`prompt ≤ promptUsdPerMillion`、`max(completion, internalReasoning) ≤ completionUsdPerMillion`、`request ≤ requestUsd`），`pricingHash` 必须与派生 quote 的一致，否则拒绝本次 claim。~~（2026-10-03 第六轮复核后修订）冻结时的单价上限校验**只核对本次 T 能到达的档位和分时组合**：对 `minPromptTokens ≤ T` 的每个 token 档，以及 token 条件被 T 满足的分时价，检查 `prompt ≤ promptUsdPerMillion`、`max(completion, internalReasoning) ≤ completionUsdPerMillion`、`request ≤ requestUsd`，这与 `deriveFrozenPrices(model, endpoint, T)` 的 `applicableLayers` 选档范围相同。T 到不了的高档仍完整保存在标价表里，但不参与本次的拒绝判断，所以快照里有更贵的高档时，短请求照常通过。`pricingHash` 必须与派生 quote 的一致，否则拒绝本次 claim。
- （2026-10-03 第六轮复核后修订）**P > T 时怎么取价**：仍按实际 P 在完整标价表里取档（这就是要保存不可达高档的原因），分时价规则同上，算出 n_i；这时 n_i 可能超过 U_i。P > T 本身就是第2节的"超过上界"：置 budget_conflict、停止新调用、该模型退出收费准入；用户最多付本次 H；按第3节，`Δ_bound` 用 `min(n_i, U_i)`，超出部分归入 e_bound。
- 来源：正式环境每次 claim 从同一份已存快照推导（与U同一个 `pricingHash`，见第2节的价格来源规则）；staging 测试窗口在准入时，从 `admitPricing` 核对过的那份快照推导并冻结进 run 的 `callPolicy`，之后每个 call 复制，续跑时照第5节先重查价格。
- 兼容：v1 运行单和它们的回放不读这个字段，仍按原合同用 `usage.cost` 结算。v2 的 call 缺 `nominalPricing` 时 `bill2_claim` 直接拒绝（v2 目前还没有任何数据，不存在没有这个字段的旧 v2 报价）。旧 staging 窗口不需要改：标价表来自价格快照，不来自窗口。
- 计算方：结算时由 SQL 按冻结的标价表和回执里的 token 数重算 n_i，作为权威值；服务端算出的值只用来交叉核对，两者不一致按证据矛盾处理。

**3. 计算依据：回执里的 token 数**

从回执 `usage`（以及有界查账的 generation 原生字段）取：`prompt_tokens`、`prompt_tokens_details.cached_tokens`、`prompt_tokens_details.cache_write_tokens`、`completion_tokens`、`completion_tokens_details.reasoning_tokens`、`cost`。名义费用只需要 P、completion_tokens，以及思考单独标价时的 R；缓存读写的分项只用于对账。

| 情况 | 处理 |
| --- | --- |
| P、completion_tokens 齐全且是非负整数（思考单独标价时 R 也齐全） | 按上式算 n_i，正常结算 |
| P 或 completion_tokens 缺失（或思考单独标价、R 缺失），但 `cost` 已知 | 先按原规则有界查账（每 call 最多3次）。仍然缺失时，（2026-10-03 第六轮复核后修订）**按 Owner 决定（[总控记录 5957737094](https://github.com/Crnobog9527/GraylumAI_vercel/pull/553#issuecomment-5957737094)）以实际费用为收费基准**：本次收费基准取 `min(c_i, U_i)`，即扣积分按 `ceil(q × m_i × min(c_i, U_i))` 进入累计（与其他 call 一样在累计值上取整一次），标记 `nominalSource='actual_fallback'`，账本元数据注明"本次收费基准是实际费用，不是名义费用"；同时按第2节的监控规则记为计量缺失（该模型退出新的收费准入）。Owner 已知这种少见情况下的两种偏差：写缓存的那一轮按 c 收会略高于名义费用，命中缓存的那一轮按 c 收会略低于名义费用 |
| `cost` 也未知 | 走原来的未知结果路径：保留 hold，转 cost_pending，不发后续调用 |
| 收费要用的字段互相矛盾（例如 R > completion_tokens、负数、响应和查账记录的数不一致） | 按"身份/费用证据矛盾"处理：不结算这个 call，保留 hold，置 conflict，沿原恢复规则人工处理 |
| 只是对账分项对不上（例如 cached_tokens + cache_write_tokens > P） | 不影响收费：n_i 照常算；记一条对账异常，报表里单列 |

（2026-10-03 第六轮复核后修订）**证据迟到**：按 `actual_fallback` 结算之后，即使有界查账用尽后又拿到了 token 数，也不重算、不补扣、不改已结算的 D、e 和累计值；迟到的 token 数只记入这个 call 的对账字段，报表里显示"如按名义费用应为 n"。首版不做差额补偿；以后如果允许补偿，必须关联原来那笔消费、按 call 幂等，并另行批准。

**4. 上限U覆盖名义费用**

第2节的U = T × 输入单价上限 + O × 输出单价上限 + 请求价上限，其中输入单价上限是 max(普通输入价, 缓存写入价)，并且已含 T 可达的全部档位和全部分时价。只要 P ≤ T、completion_tokens ≤ O，就有：所选档位 ⊆ U 计入的档位；输入标价 ≤ 输入单价上限；输出、思考、请求标价 ≤ 对应上限。所以 **n_i ≤ U_i 一定成立**。n_i > U_i 只可能来自 P > T、输出超过 O，或快照不一致，三者都按第2节的"超过上界"处理：置 budget_conflict、停止新调用、该模型退出收费准入，用户最多付本次 H，超出部分按第3节归入 e_bound。实际费用 c_i > U_i 仍然单独作为估算异常（平台真实成本超出估算），口径不变。

**5. 结算公式改为基于名义费用**

第3节的全部公式把 c_i 换成 n_i：`W = Σ(n_i × m_i)`，`N = ceil(q × W)`，`Δ_i = ceil(q × (W + n_i × m_i)) − ceil(q × W)`，`D_i = min(Δ_i, H_i)`，`e_i = Δ_i − D_i`，`C + E = N`；`Δ_bound` 里的 `min(c_i, U_i)` 改为 `min(n_i, U_i)`。另外：
- `S = Σ c_i` 继续保存实际费用（平台真实成本），新增 `S_n = Σ n_i` 保存名义费用（收费基准）。两者都按 run 累计，都不截断。
- **平台承担 E** 的含义：按名义费用算出的理论应计积分里，因为余额封顶（e_cap）或估算超界（e_bound）而没有向用户收取的部分。它是"少收的名义收入"，不是平台的现金亏损；平台真实成本始终看 c_i。
- 用户账本只写 D；`billing_history`/`credit_transactions` 的元数据同时记录 n_i、c_i 和 `nominalSource`。

**6. 平台差额与对账恒等式**

定义每个 call 的平台差额 `g_i = n_i − c_i`（美元，可正可负），于是逐 call、逐 run、逐日都精确成立：

**实际费用 Σc_i + 平台差额 Σg_i = 名义费用 Σn_i**

- 有分项时，把 g_i 拆成：缓存读取省下的 `cached_tokens × (输入标价 − 缓存读取价)`，减去缓存写入溢价 `cache_write_tokens × (缓存写入总价 − 输入标价)`，剩下的记为"折扣及其他"（快照 discount、分时价差、供应商取整等）。剩余项照实显示，不并入前两项，也不隐藏。
- g_i 可以是负数：缓存写入按输入标价向用户收费，写入溢价由平台承担。例如 Sonnet 首次写入4万 token 的前缀，平台多付的写入溢价就记为负的 g_i。
- `actual_fallback` 的 call，收费基准 n_i 取 `min(c_i, U_i)`，g_i 按定义算（c_i ≤ U_i 时为0），在报表里单列，不混入缓存和折扣收益的统计；如有迟到的 token 数，另列"按名义费用应为多少"，只作对账。（2026-10-03 第六轮复核后修订）
- 积分侧仍是 `C + E = N`。

算例（假设 Sonnet 标价：输入2、缓存读取0.2、缓存写入2.5、输出10 美元/百万 token；q=100，m=3，单 call 的 run，余额充足）：
- 命中缓存：P=48000（其中40000是缓存读取），输出1000。n=0.106 美元，c=0.034 美元，g=+0.072 美元；扣 ceil(0.106×300)=32 积分（按实际费用扣则是11积分）。
- 写入缓存：P=48000（其中40000是缓存写入），输出1000。n=0.106 美元，c=0.126 美元，g=−0.020 美元；扣32积分。
- 两种情况的U都是0.2024 美元（B=40000、T=48192、O=8192），n ≤ U。

**7. 适用范围**

所有 v2 收费调用都按名义费用计：主回复、匹配、整理、写作、报告，也包括 Sonnet 的显式缓存、Gemini 和 GPT-6 Luna 的自动缓存。启动门槛L的推荐计算（第2节）改用典型的名义费用：`typicalUsd` 取名义费用 n 的 P50，混合倍数时取 `Σ(n_i × m_i)` 的 P50。第2节准入验证的 `c ≤ U` 检查同时加上 `n ≤ U`。

**8. 面向用户的说明（只列位置，不改条款文字）**

需要从"按实际成本/实际用量"改为"按标价计费"的位置（staging `801e682e`）：
- `apps/web/src/components/chat/ModelSelector.tsx:81`、`:127`（"按实际用量计费"）——随 PAYG 前端 PR 修改；
- `apps/web/src/app/chat/standard-conversation.tsx:469`、`:747`（旧 `/chat`，正在下线；没下线之前一起改）；
- `docs/PROJECT_MAP_FOR_OWNER.md:8`；`docs/launch/MASTER_PLAN.md:40`、`:544`、`:665`，以及 `docs/launch/tasks/V3-BILL-2-provider-authoritative-billing.md`——随 PR-A 的文档同步修改，Master Plan 由总控安排；
- `apps/web/src/app/faq/page.tsx` 目前没有计费说明；以后新增时按"按标价计费"写；
- （2026-10-03 第六轮复核后修订）以上计费说明都要写明"有分时价的线路按最高时段标价计费"（Owner 选 C）。
- 服务条款、隐私和计费条款文字由 Owner 用第三方工具处理，本方案不改。

## 4. Claim、余额与派发：一次原子决定

`prepareRun`只验证身份/原操作边界并幂等创建v2 run，不冻未来钱。每次`claimCall`在现有锁序框架下完成：

1. （2026-10-02 修订）RATE-LIMIT（#573）的限流/暂停闸门已在每轮第一次claim之前通过；本步不重复实现该闸门，也不在闸门之前做PAYG冻结。（2026-10-02 开工前核对）按 #590 head `9874815e` 的实际代码，闸门有两处：①新消息准入在 `runtime/admission.ts:101` 调用 `newWorkGate(...).message`（admission 桶，每条消息计1次），位于重放判断之后、价格检查 `admitPricing`（:241）、输入审核占位 `requireAllowedInput`（:254）和 `runtime_admit`（:257，今天由其中的 `bill2_prepare` 整run预扣）之前；②执行时在 `runtime/execute.ts:155-163`，每次 `execute()` 的第一次 `billing.claimCall`（:164）之前调用 `options.callGate(actor, maxCalls)`（calls 桶，按 maxCalls 计数），被拒时抛 `RUNTIME_NEW_CALL_DENIED`，随后走 `fail_before_dispatch` 取消。PAYG 的 A/L 判定和 H 冻结都在 `bill2_claim` 事务内，天然排在两道闸门之后。PAYG 只需补续跑的规则：等待积分后继续，是同一 execution 的新一次 `execute()`；它不是新消息，不再过 admission 桶，但要重新过 calls 闸门（暂停开关必须能挡住续跑），计数取剩余可领取的 call 数，而不是整份 maxCalls；续跑时被闸门拒绝，不能走 `fail_before_dispatch` 把整个任务取消，而是保持原等待状态并返回限流原因，已结算前缀不动。第一次执行时被拒（还没有任何 claim）仍按 #590 现有行为处理。只做财务恢复的 `recoverFinancial` 继续使用 `denyNewCalls`。验证actor、原scope/来源权限、配置与报价授权、checkpoint期望版本、run未取消/冲突/终结、当前调度epoch有效；证明下一call尚未dispatch。
2. 对测试窗口先取窗口锁，随后沿已核验的Runtime/scope/run→call→profile/grant次序串行判定（实现前对照#497/#550及支付/注销调用图，禁止新旧函数反向加锁）。window的本次费用/次数预留、call身份和钱包冻结必须同一事务，不能先扣钱后因窗限失败留下孤儿。
3. 在同一profile/grant锁内读取门槛版本、计算排除其他冻结后的A，A<L则不发模型、不占新call/窗口名额，持久化waiting_credits和下一请求hash/游标，提示充值。A≥L时计算H=min(G,A)并由原atomic_pre_deduct冻结H，与窗口占用/call身份一起提交。不得把A<G当余额不足；并发锁内重算，不能靠前端余额。原预扣如不支持此原子顺序，只在现有受控事务补最小分支；不能先锁外算余额再扣。配置/权限/查询失败或来源quarantine是独立原因，不能都显示充值可解决。外层失败必须回滚占窗/冻结，不留孤儿；持久暂停不能被抛出最外层异常一并回滚。
4. 成功后call关联唯一pre_deduct与hold，领取一次dispatch capability。dispatch再次复核权限、epoch、内容hash和短期call截止；提交响应不确定先读原call。只有prepared且证明确未派发才可旋转token；dispatched/unknown永不重新授权。
5. 收到官方成本/回复后保存receipt与可恢复结果，再原子结算该call、更新checkpoint可继续标记；不是先对前端显示“可继续”再异步保存。持久化失败不伪装完成或重发。

并发保障：多个任务争同一钱包仍由profile/grant锁决定，缓存余额不是授权。首版原有串行步骤优先；若已有执行组允许并发，每个call独立领取自己的hold，不能先发送整组再统一补冻；run锁下逐次累计S/W与理论Δ，C+E始终等于ceil(q×Σ(n_i×m_i))（2026-10-03 第六轮复核后修订）。并发封顶时不同结算顺序可能改变D/E分配，首版同run按sequence确认结算与继续权；后到证据先保存，未知前序不越过，不虚称用户实扣与顺序无关。可用余额低于该模型/用途L时停止领取新call，已派发的必须收尾；一个未知call出现后不再扩大该run的外部调用集合。REPORT-GEN并行本身仍未获准。

“不负数”覆盖余额和可用额：D≤H≤A，所有扣款来自成功冻结。余额封顶导致Δ>H但c≤U/P≤T时，差额平台承担并按模型/用途对账，run可以在后续A≥L时继续；不以此设置conflict或停用模型。只有估算超界或原身份/证据异常进入原异常路径，停止新调用并保留模型准入监控；已有在途按各自H收尾。完整官方成本不截断，legacy overrun不能再补扣。E永久不向用户追收；来源过期/退款/quarantine及旧异常负余额不自动修平。

## 5. 长暂停、断点与三个不同的时限

**run代表逻辑操作，HTTP代表一次执行机会，call代表一次供应商请求；不能给暂停几天的run续期，从而顺便延长旧unknown的恢复窗口。**

| 时限/状态 | v2方案 |
| --- | --- |
| HTTP预算 | Hobby保持240/265/285/300秒；可用余额低于启动门槛L即返回持久暂停状态，不占住连接等充值。剩余时间不足也在下一call前落点，标waiting_resume，不能误显示缺积分。 |
| 每call dispatch/lookup截止 | 新call准入冻结dispatch_deadline、recovery_deadline；后者保留原“本次截止＋24h、最多3次lookup”政策。call发出后这些值不可延长；prepared未发且授权过期则原子标取消并释放原hold，不能留旧派发token。重新准入必须证明旧call从未dispatch且hold已终结，才用后续sequence的新call关联原取消记录和同一逻辑phase；原call/预扣不覆盖，每call仍唯一预扣。这种重新领取也计入原次数/试验上限，不能无限重领，已发或unknown绝不能使用这条分支。 |
| 逻辑run | v2不再以run.deadline封死长期充值恢复。保留原初始deadline为历史/初次准入边界，后续新call靠新epoch＋本call时限；v1按原deadline/lookup行为不变。run总call数/安全总成本/原scope保持固定，暂停不重置止损额度。（2026-10-02 开工前核对）正式环境价格全自动以后，"安全总成本"不能做成按准入时价格算死的美元上限，否则涨价会让进行中的任务中途被拒，违背"涨价不停止调用"。正式环境 v2 run 的止损由 call 数上限＋每 call 的U＋余额封顶H共同承担；美元总上限只用于 staging 测试窗口（锁住 Owner 批准的测试预算）。（2026-10-02 审查后修订）由此带来的风险见第2节"正式环境的平台成本风险"。 |
| waiting_credits | 持久化原run/execution、完成call结果引用、下一阶段/输入来源、期望Session/资料版本、SDK未完成tool-call对应关系。无未知在途时可释放active_execution；暂停不是取消/结单。 |
| resume | 原execution/run＋expectedCursor＋epoch CAS，经服务端重验后只给未派发的下一call。两个标签页只能一个领取；充值成功回执只证明支付履约已入账，不授予生成权。（2026-10-02 开工前核对）续跑要重新过 #590 的 calls 闸门，被拒时保持等待，见第4节第1步。 |

**存储边界**：断点与暂停数据仅存在`bill2_runs`新列，JSONB checkpoint/暂停结构合计上限首版拟定65536 bytes，以`octet_length(jsonb::text)`校验；可重建内容优先引用既有持久结果，不复制全部历史/正文。绝不写入`bill2_runs.payload`或Runtime冻结payload，两者原262144上限不变。保存前测量，超限停止新调用并保留既有结果/财务证据，不截断后冒充可恢复。离线验证新列上限及+1，并验证两份冻结载荷没有混入暂停数据。

需要保留的checkpoint是可重建SDK上下文的实际内容/受控引用，不是只有hash或浏览器游标。优先使用既有Session items、已落库provider response/tool-result与execution冻结输入；补存下一phase/sequence、已消费item游标与版本。所有有副作用工具须按原toolCallId查结果重放，不能恢复SDK时再执行一遍工具。跨步骤的信息整理也要保存已生成内容与写回版本，不能因可用余额低于门槛再跑主回复。

解除active_execution后，同会话可能有新消息/资料修改：恢复时检查Session revision及source hashes。完全一致才原样续跑；若只是本操作已记录的checkpoint写入，按预期版本接受。外部修改引发冲突时不覆写新状态、不自动花钱重做，保留已完成输出，提示在原任务解决冲突/选择基于新资料的新操作。可在无冲突的其他会话继续使用，不把等待充值永久锁住全站。模型/Skill被撤销或注销则不可恢复内容生成，即使已充值。

长暂停不自动清掉已完成工作，也不承诺删除后可恢复；存储/同意/注销遵守原D5/D7与B2a。已有源被合法删除时，仅保留最小财务关联。没有新定时生成器，恢复必须来自用户的原任务请求；暂停记录不会定时醒来发收费调用。

供应商报价/测试窗口过期：未派发call重新走当前允许的报价模板；新窗口必须明确授权原run继续，且其兑换参数与run冻结q相同，不能自动迁移到不兼容窗口、延长旧窗或重新冻已完成calls。若当前新窗口q不同，显示配置待处理而不是反复让用户充值。正式报价授权与窗口分别处理；不同费用参数如需变更旧操作，另走明确新操作，不悄悄改已收费前缀。（2026-10-02 开工前核对）staging 窗口锁价下，`admitPricing`（`runtime/pricingAdmission.ts`）目前只在新准入时检查，已经开始的 run 不再检查。PAYG 让 run 可能暂停好几天，所以续跑领取下一 call 之前，要对该 call 的窗口报价重跑同一项价格检查；发现涨价就保持等待，显示"价格配置待处理"，不发请求、不冻结，避免带着低于现价的 `max_price` 发出去。正式环境每次 claim 都自动取新价，不存在这个问题。

## 6. 未知结果、放弃与资金收尾

以下边界沿用BILL2：timeout/断流/无可靠成本不是0或确认失败；不换线路/模型、不换requestId重发、不再次冻结同call；只按可靠provider ID查原调用。保留原receipt、原hold、原call时限与最多3次lookup。pending/冲突时停止本run后续调用；明确显示“费用核对中”，充值不能解除未知状态。成本已知但正文未持久化，也不能因此再发同call。

取消/放弃只封闭未来调用，已结算前缀保留；未dispatch hold释放，已dispatch按原事实结算，未知继续待核对。只在waiting_credits且没有未决call时，**没有整份任务的冻结款挂着**；取消不退已正常交付步骤的有效消费。确认故障全退按第3节的受限补偿。B2a注销后仅财务恢复，不返回正文、不继续模型。

恢复入口复用请求内尽力收尾、本人下次访问/下一次准入的有界惰性维护、现有billing-reconcile补漏；不新建cron。Hobby日任务可能错过call恢复截止＋24h，用户不回访时可进入人工诊断并保留未知hold，不承诺24小时必释放。PAYG已结算前缀不会因另一call未知被重新全部冻结。永不续跑的waiting_credits任务可在原产品取消/删除入口结束，无需账务定时清零。

## 7. 0108测试窗口、批准报价与长期身份

不取消整对象匹配而接受客户端upperUsd。改为双层明确合同：

- 窗口批准**稳定quote policy**：policyId/version、model/endpoint/account、价格上下界/有效期、字节算法/准入路径/证明或实测证据版本/template profile及K/M身份、允许purpose、输入/输出硬限、重试/工具限制。run引用获准policy；稳定policy仍按整对象匹配。（2026-10-02 开工前核对）"价格上下界/有效期"只适用于 staging 测试窗口。正式环境的稳定 policy 只锁定模型、端点完整 tag、协议/profile、证据版本、K/M、用途和输入输出硬限，不锁价格；单价每次 call 按第2节自动推导，记入派生 quote。
- 每次call冻结**派生quote**：policyId/hash、完整requestHash、实际计量、T/O、U/G/H、A/L及门槛版本、q/m_i及倍数来源/版本、call时间界限。由可信服务端按批准算法重算；SQL验证policy成员关系/不可变参数、用途/上限与精确金额关系/窗口授权。SQL不运行tokenizer或自行证明字节上界，维持只有可信adapter可提交的边界，浏览器或模型不接受报价字段。派生报价不能仅凭U比模板上限小就通过。
- （2026-10-02 修订）稳定policy和每call派生quote都要带 `cacheWriteUsdPerMillion` 及其来源（OpenRouter目录字段和端点完整tag）与版本；字段名和计算方法与PROMPT-CACHE（#572）的 `providerLimits.cacheWriteUsdPerMillion` 一致，派生quote的U按第2节max定义计算，不形成第二套上界算法。没有该字段的线路不得带缓存标记，有自动写入费的模型缺该字段时不得准入收费。
- 派生quote与其他call字段合并后的整个`bill2_calls.payload`必须满足现有65536 bytes上限（SQL实际JSONB文本字节，含转义）。只存版本/哈希、B/K/M/T/O/R、各费率与费用分量、U/G/H/A/L/q/m_i及倍数来源/版本与有界身份/期限，不复制request、工具schema、断点或正文；证明材料绑定不可变版本引用。必须测完整payload的65536及65537边界，超限在hold/dispatch前拒绝，不截断计费证据。
- 升级现有stagingPolicy/providerRequest/adapter重复校验与SQL claim/dispatch，同时保留v1整对象机制；新旧合同不互相伪装。当前模型contextTokens只作真实模型能力，不人为改小以改变收费。
- 窗口费用/次数在**每次call成功claim时**、同一窗口锁下占用：所有窗口call的已知最终成本＋未决/未dispatch但已claim的U＋新U，均纳入费用；次数按已占用call加1，不因失败/未知/充值续跑重置。证明未dispatch取消后可释放金额，测试次数仍保守不复用，避免“免费重试次数”漏洞。旧v1运行单沿原整run预留计量，两类合并检查，不漏掉旧未结清run。
- 同时检查原操作总止损、模型/用途启动门槛、锁内A和Owner本批真实额度；窗口预算≠钱包hold。跨窗口续跑的成本仍归原call所属window并保留批准关联，任务试验累计额度另外跨窗口合计，不以换window重置。

实施前实时读取窗口参数/余额可用来源/所有未决占用，不从#542历史预览推出当前费率。费率q变动的新run用新值；旧run续跑须兼容第5节。窗口enable/expiry控制新dispatch，关闭窗口不能禁止旧receipt财务恢复。

## 8. 对话、整理、报告、Fusion、ENTITLEMENTS

| 场景 | 检查余额与恢复位置 |
| --- | --- |
| 普通对话每轮1–3次 | 第1次模型（可能是匹配/主回复）前；拿到其结果构造第2次实际请求后；附属整理前，每次都在锁内检查L并做claim+余额封顶hold。具体序列来自冻结计划，不写死一定3次。 |
| 主回复已完成、可用余额低于整理门槛 | 主回复仍可读，明示“回复已完成，整理等待积分”，checkpoint保存原回复与待整理来源版本。充值后只继续整理，不再生成/收费主回复；依赖整理的新步骤受版本校验，不把旧整理状态当已完成。 |
| 报告 | 一次全文就是一个call，只冻结这次；若以后另批分章，每章/提纲独立call，每次重新计量并结算。可用余额低于下一call门槛时停在章间；本次REPORT-GEN仍只测试单次全文。 |
| 工具后再次模型 | 工具结果先按原toolCallId保存，再构建下一请求计量。第三方调用成本先按官方价格换成美元，再按该call冻结的线路/供应商m_i加入加权累计，按冻结q换成平台积分，不能直接照搬第三方积分或收固定积分附加费。付费工具/搜索也须通过同一逐调用财政边界并核对官方单位；免费本地工具不造收费。当前未接入的供应商不得绕行旧钱路开启。 |
| Fusion | **在FUSION-REVIEW定义并验证“一次请求多个模型”的完整费用上界之前不放行Fusion收费**；单模型PAYG公式不能直接套用或只取最贵成员。以下是后续接入要求，非本阶段准入许可。**Master Plan 4.4运行前预告保留**：总预计消耗/组成/最大轮次仍先告知并确认，但不一次冻结全部预计值。OpenRouter整组单次调用只按官方总receipt结算，内含模型不重复收；应用分开发模型时分别call，同run累计取整。可用余额低于下一call门槛时保留既有成员结果和评审阶段，充值继续。改变组/功能/轮次属于新授权，不靠续跑扩大。 |
| （2026-10-02 开工前核对）定位导师与 B1 右侧信息（#593） | B1 的补应用 `opc_capture_apply` 只读写定位草稿，不调用模型、不准入、不计费：新导师准入前，`opc/service.ts` 的 `prepareStep` 先补应用（最多4批×5个，仍有剩余就抛 `OPC_CAPTURE_PENDING`，这时还没过任何闸门、没有 run）；执行完成后，`runtime/executionStream.ts` 的 `captureCompleted` 再补一次。它只处理 `state='completed'` 的 execution，所以"主回复已完成、整理等待积分"的 execution 在续跑完成前不会被补应用，也不会被当作已经整理。PAYG 不能把 `OPC_CAPTURE_PENDING` 显示成积分不足。续跑时的版本检查只核 Runtime Session 和本 execution 冻结的输入；草稿字段的冲突交给 B1 自己的逐字段版本保护，PAYG 不再另做一套。~~等待期间用户直接发新消息怎么办，见"需要 Owner 决定的问题"Q1。~~（2026-10-02 审查后修订）等待期间用户直接发新消息：Owner 已定 Q1=A，先补做上一轮整理再处理新消息，见"Owner 已定的问题"。 |

“适用于所有调用”指统一Runtime所有收费入口（对话、匹配、整理、写作、报告、评审以及独立计费工具）的最终覆盖；不是只给report开优惠通道。落地按用途逐项清点所有before-provider路径和遗留入口。关闭的旧路由保持关闭；仍可达的旧收费入口必须纳入同一协议或明确阻止收费，不能声称覆盖完成却留双钱路。

ENTITLEMENTS依据 [#540精确候选](https://github.com/Crnobog9527/GraylumAI_vercel/blob/8772a7883cab722f668994f064752a5b8ec42101/docs/launch/tasks/ENTITLEMENTS.md) §5/§7：**欠费/支付不确定不给新付费会员功能；已准入的原组执行按冻结权益完成**。PAYG可用余额低于启动门槛是另一条件，积分充值不等于解除会员欠费，也不改变等级：

- 新run先过当前功能权益，再在call前检查该模型/用途L；有100积分但会员权益被拒仍不能开新Fusion。
- waiting_credits续跑若属于原已准入操作、原mode/模型集合/轮次/范围未扩大，按原冻结权益恢复，继续做每call资金及账号/源权限检查；不因充值创建新功能授权，不把同run续跑误判成重复新收费操作。
- 若原操作已终结/取消或要扩展付费功能，重新按当前权益准入；欠费时不能借旧run“续跑”加入新功能。已完成结果读取/合法下载/删除继续按原权限。账号注销/来源撤权总是优先于冻结权益。
- 本方案不改变付款/订阅生命周期，不在查询余额时向支付供应商发付费动作。

## 9. Writer顺序、验证和回退

~~总控已确定顺序：#497 → #550 B2a → BILL-UNIT → BILL-PAYG → REPORT-GEN #547，全部由Codex写。~~ （2026-10-02 修订）**施工顺序：#497 → #550 B2a → BILL-UNIT（#565）→ PROMPT-CACHE（#572）→ BILL-PAYG（#553）→ REPORT-GEN（#547）；RATE-LIMIT接线（#573）排在PROMPT-CACHE之后。限流/暂停闸门始终在每轮第一次claim和PAYG冻结之前判定，被拦下时不占窗口、不冻结、不派发。写入方按Owner 2026-10-02分工由总控安排（开发由Claude执行窗口做）。** #497按总控记录仍进行中，不能由本方案视作暂停。同一Codex writer须等 #497/#550及BILL-UNIT基础交付后，基于当时最新staging实施PAYG；追加迁移编号排在已合并迁移之后，再交付REPORT-GEN，不并行覆盖相同函数或SQL。#540继续提供权益契约；AC-3分工按其既有任务。当前仅修订方案文字，不开始上述实施。

（2026-10-02 开工前核对）#497（`255259cf`）、#550（`7b880fc4`）、BILL-UNIT #565（`7909c118`）、PROMPT-CACHE #591（`9600f2bc`）、MODEL-PRICING-SYNC B #581（`1d75b130`）都已合并。Owner 2026-10-02 决定 #590 合并后开工，**由 Codex 实施**（[5952671504](https://github.com/Crnobog9527/GraylumAI_vercel/pull/553#issuecomment-5952671504)），取代上句"开发由Claude执行窗口做"。前端部分按 2026-10-02 晚的分工单独成 PR，由总控派发。

**迁移编号**：CI 的 `scripts/check-migration-ledger.mjs` 要求新迁移大于目标分支的最大编号，并且编号连续、不留空。B1（#593）已在其分支上使用 0159（`0159_opc_capture.sql`）；#590、#594、#595 没有迁移。PAYG 的迁移取开工时 staging 最大编号＋1：B1 先合并则为 **0160**（预期情况）。**后合并的一方负责同步**：rebase 到最新 staging，必要时改成下一个空号，重新生成 `packages/db/tests/baseline/built-fingerprint.json`，并重核自己的源码 md5 防漂移检查（0157 的写法）。两者唯一可能重叠的 SQL 对象是 `runtime_work_projection`（B1 在 0159 重写）：PAYG 如果要在工作区投影里显示等待积分状态，必须基于 0159 的定义，并在防漂移检查里使用 0159 的 md5。（2026-10-02 审查后修订）#593 当前 head 是 `044fef57`，正在修它自己的 P1，会改 `runtime_work_projection`，改完会在它的 PR 里写新的 md5；PAYG 以 B1 合并后的定义为准。（2026-10-02 提醒设计修订）#593 现在的 head 是 `fd210532`，它声明 `runtime_work_projection` 新定义的 md5 为 `fcb191fa3d9135c42509cd1395a6e025`（~~这是源码里的声明值，未用 SQL 复算~~（2026-10-02 第三轮复核后修订）已由独立复核在本机数据库用 SQL 复算确认，见 [#593 评论 5956041937](https://github.com/Crnobog9527/GraylumAI_vercel/pull/593#issuecomment-5956041937)；同一次复算确认 0159 重定义的 `runtime_material_allowed_before_b1` md5 为 `0a1bac81b4214c2151f8ac32660b8d76`，PAYG 若替换这个函数，基准用这个值）；仍以开工时 staging 上的最新定义和实测 md5 为准。staging 按编号顺序应用迁移，每次都要 Owner 单独批准。

**PAYG 要替换的 SQL 函数的当前最新定义**（~~实施时以这些作为防漂移基准~~（2026-10-02 审查后修订）防漂移基准一律以开工时 staging 上的最新定义为准，下面是 2026-10-02 的快照）：`bill2_prepare`（0108）、`bill2_claim` 和 `bill2_finalize`（0157）、`bill2_dispatch`（0106）、`bill2_record` 和 `bill2_close`（0156）、`runtime_admit`（0158，内部调用 `bill2_prepare`）、`runtime_financial_recovery`（0156）、`atomic_pre_deduct`（0061）、`bill2_legacy_settle`/`bill2_legacy_refund`（0105 由原 `atomic_settle`/`atomic_refund` 改名而来）。0105 新建的 `atomic_settle`/`atomic_refund` 包装只在 `bill2_runs.pre_deduct_id` 命中时拒绝旧收尾；v2 把预扣挂在 call 上，这道拒绝必须同时覆盖 `bill2_calls.pre_deduct_id`，否则旧收尾函数可以结算 v2 的单次冻结。（2026-10-02 审查后修订）不止这两个：0105 一共新建了六个旧公开收尾外层包装，`atomic_settle`、`atomic_refund`、`atomic_abort_settle`（0105:334-345）和 `atomic_finalize_ai_success`/`failure`/`abort`（0105:347-437），全部只检查 `bill2_runs.pre_deduct_id`；底层原函数改名为 `bill2_legacy_*`，最后定义分别在 0057（settle、refund、abort_settle）、0058（finalize_success、finalize_abort）、0059（finalize_failure）。v2 必须让这六个入口都拒绝 v1 的 run 级预扣（现有）和 v2 的 call 级预扣，与 bill2 无关的普通旧钱包预扣行为保持不变；六个包装和对应底层定义都列入防漂移基准，并逐个入口测试拒绝。漏掉 `atomic_abort_settle` 会让 v2 冻结经旧中断路径被结算，绕过 D≤H 和累计 Δ/D/E（审查 5954889611 的 P1）。`credit_transactions_bill2_phase`（0105，`(bill2_run_id, reason_code)` 唯一）留给 v1，v2 另建按 call 的幂等索引。

**与 #590 的文件重叠**：PAYG 会改 `runtime/execute.ts`、`runtime/executionStream.ts`、`shared/agentTurn.ts`（新增等待积分的结果状态；#590 在这里加了闸门原因）和 `runtime/runtime.integration.ts`，必须基于 #590 合并后的 staging 开工。#594 的前端闸门提示和 #595 的刷新恢复是 PAYG 前端 PR 的基础。（2026-10-02 审查后修订）#595 已合并（`d7011b7b`）。前端的等待和继续界面通过技术验收之前，v2 默认路径保持关闭，见实施说明草稿。（2026-10-02 提醒设计修订）**与 #597 的重叠**：#597（MODEL-PRICING-SYNC C1+C2，包含并取代 #596）改了 `routers/modelReasoning.ts`、`/admin/models` 和财务页，与价格变动提醒（PR-C）和提醒页面重叠；PR-C 和提醒页面等 #597 合并后再开工，并保留它的容量同步、CAS 和价格投影。（2026-10-02 第三轮复核后修订）#597 当前 head 是 `555e595d`。（2026-10-03 第四轮复核后修订）#597 已合并（staging `c6441946`）。PR-C 和提醒页面现在可以基于合并后的版本开工，但仍排在 #590 合并之后。

（2026-10-02 第三轮复核后修订）**与注销（#550 B2a、#598）的衔接**（Owner 决定见 [5955936040](https://github.com/Crnobog9527/GraylumAI_vercel/pull/553#issuecomment-5955936040)，来自 #598 独立审查的 P1）：0156 的注销判定 `bill2_erasure_closed(a, pre)` 只认传入的预扣 ID，而 0156 里的五处调用（第133、151、189、290、334行）传的都是 run 级 `pre_deduct_id`。v2 的 run 没有 run 级预扣，预扣挂在 call 上；不改的话，注销时在途的 v2 运行单会被判为"未注销"，一直挂着。PAYG 必须让注销判定同时认 v1 的 run 级预扣和 v2 的 call 级预扣；处于"等待积分"的 v2 运行单遇到已注销账号要能直接收尾，~~（释放未结算的冻结、只做财务恢复）~~（2026-10-03 第四轮复核后修订）收尾规则与 #598 §3.3/§3.6 和本方案第6节一致：关闭未来调用；只释放未派发的、或已有可靠撤权证明的 hold；已派发但费用未知的 call 各自保留 hold，转为 cost_pending；已结算的前缀不变；零 call、零 hold 的直接结束，不制造退款。不能等充值。#598 目前只是方案（`docs/plans/DATA-ERASURE-INFLIGHT-RECOVERY.md`，~~head `4c3a4942`~~（2026-10-03 第四轮复核后修订）head `3ba7a4fe`），它的实现也会改这一块：PAYG 的 PR-A 和 #598 的实现谁先合并都可以，**后合并的一方负责适配和同步**（重新对齐 `bill2_erasure_closed` 及其调用点的定义和防漂移 md5），新旧两种运行单在注销场景下都要测。

（2026-10-02 第三轮复核后修订）**流水类型**：财务页从 2026-09-29 起打不开，根因是 `routers/admin.ts` 的 `adminFinanceCreditTransactionRowSchema` 把 `credit_transactions.type` 写死为固定 enum，不认签到写入的 `checkin`，而数据库对 `type` 没有 CHECK 约束（[#599 评论 5956220312](https://github.com/Crnobog9527/GraylumAI_vercel/pull/599#issuecomment-5956220312)）。PAYG 的账务写入沿用现有 `type`（`adjustment`、`consumption`）；如果 PAYG 或平台承担投影需要新的流水类型，读取端（财务统计、报表）不能再用写死的 enum 校验整行，未知类型要能显示和汇总，不能让整个接口报错。

原方案读取的历史身份（不是本轮实时进度证明）：#497 head `e3649015cf7e93603bb68754da111a6592ad4414`；#550 head `16079f77a0a7fff002dccd24821489356877370f`。实现前重读当时head、base和writer交接；不拿方案里的SHA当未来开工授权。共享built指纹/迁移编号由总控排先后，不预占编号，不新增协调表。（2026-10-02 开工前核对）这两个 PR 都已合并（#497 `255259cf`，#550 `7b880fc4`）；迁移编号改按上一段的规则。

必要改动范围：同步 docs/launch/tasks/V3-BILL-2-provider-authoritative-billing.md；BILL2 service/policy/adapter/decimal和SQL；Runtime admission/execute/runner/session恢复与目的预算；余额/账单投影和继续按钮协议；原账务对账/返利接点；相关集成、追加迁移、built指纹；D5/D7/注销字段/有限财务保留接入#550。本阶段无这些代码改动。

离线验收必须覆盖：
- 单call上界准入与边界+1、真实计量含reasoning/tools/模板、过期/伪造quote、最终bytes漂移、hidden retry禁止；逐个模型核验适用的证明路径或实测路径及K/M、监控缺失/阈值边界与模型级阻断；reasoning/缓存写入/固定费任何无界项fail closed，不要求首版安装精确tokenizer。
- 余额封顶D≤H、平台承担按模型/用途对账且不置conflict；c>U/P>T才按估算异常停止；重复receipt不重扣；启动门槛L-1/L/L+1、A<G且A≥L正常派发、其他run冻结扣除不重复、旧全局min不成为隐藏门槛；run新列65536/+1、两份冻结payload262144/+1、call完整报价payload65536/+1；Fusion上界未定义拒绝。
- 3次极小费用累计只收1；C+E=N累计守恒、充值后不补收E、正常封顶/估算异常同时发生不重复归因；零费用；混合模型m_i差异及加权精度边界、长暂停q/倍数映射不漂移；窗口policy变更；多call/多run/双标签页争余额、充值与claim竞态，不负数、失败不留双hold。
- 冻结/dispatch提交响应丢失、回执后崩溃、结算后checkpoint返回丢失、prepared取消、unknown/冲突/迟到成本、已退款再到receipt，全部原身份幂等。
- 主回复完成整理等待、断点重放不重执行工具、Session版本冲突、长期等待后继续、原call24h不被延长、取消/注销后不恢复生成；已知前缀不因未知后续重复计费。
- 月度grant失效/退款/逆转/quarantine与充值来源守恒；确认故障全退补偿；返利/报表只记录一次；v1读写恢复兼容、v2新run零预留。
- ENTITLEMENTS新操作拒绝/原组允许/扩大范围拒绝；Fusion预告保留；所有收费入口清单与无旧绕行证明。
- 本地DB文件建库、迁移重复应用、指纹/恢复与安全允许/拒绝路径；API/Web/必要CI/Security；实际接线后预览/浏览器技术验收。

真实调用：**本PR没有新增额度授权**。优先fixture验证冻结/暂停/充值履约回执/恢复，不能为了测试充值去做真实付款。REPORT-GEN已有3次/$0.50只可在两方案审过、必要实现完成后跑其三份全文流式样本，不挪作普通对话/Fusion/未知故障样本，也不为凑3份成功加次数。本方案第2节已给出PAYG计量验证矩阵；专项仅补 #561 未覆盖的格子，最多180次/$48仅为零复用上限，待 #561 准备完成后按扣减后的实际缺口与 #561 一起报Owner批准。额外钱包/恢复故障真实验证不包含在此额度，先用fixture；若确需真实调用另报范围与预算，本阶段不启动。

回退：先停新v2 claim，保留receipt/结算/退款/读取与已暂停状态；v1继续原协议。不把已逐次收费v2 run转回一次整run预扣，不重扣已完成前缀，不删新增关联或账务数据。旧在途仍由原合同收尾；迁移为追加兼容分支，读写完成后才考虑退旧代码。上线/数据库应用/任何生产效果另批。

## Owner 已定的问题（2026-10-02 审查后修订）

~~需要 Owner 决定的问题~~　两项都已由 Owner 在 2026-10-02 于总控窗口决定，原话：「#553 Q1 选 A，Q2 首版不自动更新」（[总控记录 5954715142](https://github.com/Crnobog9527/GraylumAI_vercel/pull/553#issuecomment-5954715142)）。

**Q1（已定：A）：整理在等积分时，用户直接发了新消息。**
情况：主回复已完成，附属整理因为余额低于整理门槛而暂停；用户充值后没有点"继续"，而是直接发了下一条消息。
- **采用 A**：先在原 execution 上补做上一轮等着的整理，再处理新消息。补做的门槛和余额封顶规则不变，单独收这一次整理的费用，补做前按第5节检查版本。余额仍低于整理门槛时，新消息也一起等待，并提示充值。"充值后不自动调用模型"这条仍然成立，因为补做是由用户发新消息这个动作触发的。
- 未采用 B：放弃上一轮这一次的整理提取（不收费），只处理新消息。这一轮的信息不会由这次整理写入右侧；之后的整理会不会从后面的上下文里再提取到，取决于模型，不作保证。

**Q2（2026-10-06 已更新）：启动门槛随本 call 冻结倍数自动适配。**
Owner 在 PAYG-THRESHOLD-AUTO 任务中决定取代“首版不自动更新、管理员手动调整”：配置按精确模型＋用途保存典型名义费用 `typicalUsd`（美元十进制字符串），领取时使用 run 冻结的 q 和本 call 冻结的 m_i，计算 `L=max(1,ceil(typicalUsd×q×m_i))`。不同 Skill 指定模型的倍数分别参与计算；不再手动维护积分门槛。已冻结调用、G/H 和结算规则不变。用来观察的报表目前还没有：~~后台已有的平台承担报表~~要在现有报表入口 `bill2_admin_call_report`（2026-10-03 名义费用收费修订）（同时展示实际费用 c、名义费用 n 和平台差额 g=n−c 及其拆分，见第3A节第6条）（0157，经 `routers/billingReport.ts` 只对管理员开放）里补充平台承担投影，按精确模型＋用途＋日期汇总 `e_cap`、`e_bound`、`charged_delta`、理论 Δ、封顶 call 数，以及按冻结费率折算的计价成本等值（字段定义见第3节"余额封顶的平台承担对账"）。
- 归属：SQL 投影和接口随 PR-A，由 Codex 做；后台页面展示随 PAYG 前端 PR，按分工做。
- 验收：PR-A 的集成测试用固定数据逐项核对汇总值和 C+E=N，非管理员调用被拒绝；前端 PR 在 staging 预览里用测试数据核对页面数字与接口一致。

已按现有决定处理、不需要再决定的事项：正式环境 v2 run 不设按准入时价格算死的美元总上限（第5节）；续跑重新过 #590 的 calls 闸门，被拒时保持等待而不是取消（第4节第1步）；staging 续跑前重查窗口价格（第5节）。

## 管理员提醒（2026-10-02 提醒设计修订，Owner 新增范围）

Owner 原话：「另外加价格变动提醒（涨超 20% 或异常变化）和平台承担提醒，只提醒不拦截」（[总控记录 5955232832](https://github.com/Crnobog9527/GraylumAI_vercel/pull/553#issuecomment-5955232832)）。

（2026-10-02 提醒设计修订）~~上一版的"在写入点和结算点判断、写 warn 日志、后台读日志"设计~~已整体替换。[独立复核 5955643435](https://github.com/Crnobog9527/GraylumAI_vercel/pull/553#issuecomment-5955643435) 指出了 4 项 P2：`logger` 从未初始化，warn 不会落库，而且只写日志不等于通知管理员；结算事务里判断，跨钱包并发时会漏报或重复报；价格判断在 CAS 写入之前，会重复报或报出没写入的价格；没有定义比较用哪个 T、哪一档。现在改为**读取时计算**：不在写入或结算时发事件，不依赖 `logger` 落库，不在结算事务里加判断，所以也不存在并发去重的问题。提醒只在管理员页面上计算和显示，不拦截准入或调用。提醒计算出错时页面显示"提醒暂时无法计算"，不能显示成"没有提醒"；准入和结算根本不经过这段逻辑，结果不受影响。

**共同的展示方式**
- 位置：复用 `/admin/models`（价格提醒）和财务页（平台承担提醒），在页面顶部列出提醒，每条带时间、模型、原因和"已知悉"按钮。
- 接口：走管理员专用的 tRPC 接口（`adminProcedure`，与现有 `routers/billingReport.ts`、`routers/modelReasoning.ts` 同样的权限），非管理员被拒。不放开客户端对 `application_logs` 或其他表的权限。
- 不新建表、调度器、队列或通知服务。"已知悉"状态分别存在 `ai_models.config` 和私有 `system_settings` 里（见下文）。

**价格变动提醒**
- 已知悉的基线：放在 `ai_models.config.pricingBaseline`，结构与价格快照相同。注意：**不能放进 `config.pricing` 里面**。`shared/modelPricing.ts` 的 `pricingSnapshot` 是严格结构（`.strict()`），多一个字段 `readPricingSnapshot` 就会返回 null，准入会被拒（`RUNTIME_PRICE_SNAPSHOT_MISSING`）。它和 `pricing` 放在同一行、由同一次条件写入一起提交；两个写入点都是先展开原 config 再改字段，旁边的字段会保留。
- 写入时只做一件事，不做任何比较：在现有的两次快照写入里（管理员手动读取 `routers/modelReasoning.ts` 的 `refreshCatalog` → `writeReasoning`；准入时过期重读 `runtime/pricingAdmission.ts` 的 `renew`），只在**条件写入成功的那一次更新语句里**顺带补上基线：如果行里还没有 `pricingBaseline`，就把写入前已存的快照作为基线（如果之前没有快照，就用这次写入的快照）；已有基线时原样保留。CAS 失败、`write_failed`、使用别人写入的 `stored`、`fresh_unwritten` 这些分支都不写基线，也不产生任何提醒。
- 已知悉：管理员点"已知悉"时，接口对该模型行做条件写入（同时比对 `updated_at` 和页面显示的当前 `pricingHash`），把 `pricingBaseline` 更新为当前的 `pricing`。如果在这期间快照又变了，写入失败，提示刷新后重新确认。
- （2026-10-02 第三轮复核后修订）基线还要防止被通用保存冲掉：`services/models/modelConfig.ts` 的 `MANAGED_CONFIG_KEYS` 目前只有 `reasoning` 和 `pricing`，`updateModel`/`updateModelConfig` 以客户端传来的整个 config 为基础，只把这两个键换回服务端当前值。旧页面保存时，可能把 `pricingBaseline` 删掉或回滚到旧值（CAS 只保护服务端读到写之间，保护不了客户端更早拿到的内容）。PR-C 要把 `pricingBaseline` 加进托管键：所有通用 config 保存都保留服务端当前值，忽略客户端传入的这个键；只有上面两个快照写入点（初始化）和专用的"已知悉"接口能改它。
- 读取时比较：对每个端点，取基线和当前快照两边全部档位阈值的并集，再加上 0（只有基础档），形成一组 T。对每个 T，用同一个 `deriveFrozenPrices(model, endpoint, T)` 分别算出基线和当前的冻结单价，逐项比较输入（已含缓存写入）、输出（已含思考）、每次请求费，以及 `cacheWriteUsdPerMillion`。由于 `deriveFrozenPrices` 在 T 处取所有适用档的最大值，低档涨价而高档不变的情况会在低 T 处被发现。比较用现有12位定点整数，不用浮点。
- 分类（每个端点、每个字段只出一条，取最严重的一类）：新 ≥ 旧×5，或旧为0、新大于0，记为**异常上涨**；旧×1.2 < 新 < 旧×5，记为**上涨超过 20%**；新 < 旧×0.2，记为**异常下降**。恰好 +20% 和恰好 −80% 不提醒，恰好 5 倍提醒。下面几类单独显示，不算价格涨跌：端点在当前快照里消失或变得不可用（`admissible=false`）；出现未知价格字段（`UNKNOWN_PRICE_FIELD`）；端点新增。
- 时间：显示当前快照的 `fetchedAt`。
- 已知限制：提醒基于已写入的快照。供应商改价之后，要等下一次快照写入（管理员手动读取，或准入时快照超过7天自动重读）才能看到。~~正式环境定价用的也是同一份快照，所以提醒和实际定价始终一致。~~（2026-10-02 第三轮复核后修订）要区分两份快照：**报价时用的快照**，是某次 claim 冻结价格时用的已存快照（正式模式只能用已写入的快照，见第2节）；**页面读取时的最新快照**，是管理员打开页面时行里存的那一份。两者可能不是同一份，因为报价之后快照可能又刷新过。已冻结的调用按自己的报价结算，不会因为之后的刷新改价；提醒反映的是最新快照相对基线的变化。
- 归属：PR-C，由 Codex 做后端（基线写入、已知悉接口、读取比较接口），页面展示随前端 PR。**PR-C 必须等 #597（MODEL-PRICING-SYNC C1+C2）合并后再开工**（2026-10-03 第四轮复核后修订）（#597 已于 staging `c6441946` 合并，此条件已满足；仍排在 #590 合并之后）：#597 改了 `routers/modelReasoning.ts`（写入快照时同时更新容量、改了返回投影）、`/admin/models` 和财务页，PR-C 要在它的基础上接入，保留它的容量同步、CAS 和价格投影。
- 验收：
  - 单元测试：恰好 +20% 不提醒、超过 20% 提醒、5 倍只出一条异常、恰好 −80% 不提醒、超过 80% 提醒、旧值为0、低档涨价而高档不变能报出、档位阈值移动、端点消失、端点不可用、未知字段、端点新增。
  - 集成测试：两个写入点只在条件写入成功时补基线；手动读取和自动重读同时发生、两个实例同时自动重读、CAS 失败后重读，都不会写出错误的基线；已知悉的条件写入在快照变化时失败；非管理员调用被拒。（2026-10-02 第三轮复核后修订）基线不丢：旧页面保存 config、另一个标签页点了"已知悉"、自动重读、连接检测，这几种交错发生时，基线既不被删除也不被回滚。
  - 浏览器验证（前端 PR）：快照写入后管理员打开页面能看到提醒；刷新后仍在；点"已知悉"后消失；之后再变价会重新出现；比较逻辑出错时页面显示"提醒暂时无法计算"。

**平台承担提醒**
- 设定值：复用私有 `system_settings`，拟用键 `billing_platform_absorb_alert`，内容为全站默认美元值，加可选的精确模型覆盖（12位定点）。管理员在现有设置入口保存、校验、读回。**没有设定值时，页面显示"平台承担提醒未启用"，不能显示"没有超额"。**
- 读取时计算：管理员打开财务页时（2026-10-03 名义费用收费修订）（口径：E 是按名义费用算出、因封顶或超界没有收取的积分，折算成名义计价等值美元；平台差额 g 另在报表展示，不触发这项提醒），从 `bill2_admin_call_report` 的平台承担投影（PR-A 补充，见"Owner 已定的问题"Q2）按"精确模型＋UTC 自然日"汇总平台承担的计价成本等值（e_cap 与 e_bound 合计，按第3节的冻结费率折算成美元）。归日以 call 的结算提交时间（UTC）为准。最近7个 UTC 日内，任何一天超过当前设定值的模型，都在页面顶部显示提醒（标明是按冻结费率折算的计价成本等值，不是现金亏损）。比较用的始终是读取时的当前设定值，所以管理员改了设定值，下次打开页面就按新值计算，没有"改值后补发"的问题。
- 已知悉：存在私有 `system_settings`，拟用键 `billing_platform_absorb_ack`，每个模型只记一个"已知悉到的 UTC 日期"。管理员点"已知悉"后，该模型这个日期及之前的提醒不再显示；之后哪天再超过，会重新出现。~~写入用 `system_settings` 现有的保存方式，内容按模型数量有上限。~~（2026-10-02 第三轮复核后修订）不能用现有的保存方式：`routers/settings.ts:290-315` 按 key 整值 upsert，两个标签页分别确认模型 A 和 B 时，后写的会覆盖先写的；同一模型旧日期的请求迟到，也会把新日期覆盖回去。改为由管理员专用接口写入：读最新对象，只改目标模型，按条件保存（与读取时的值比较，冲突就重读再合并）；该模型的日期只取已存日期和本次日期中较大的那个，其他模型不动；第一次创建这个键时也要处理并发创建。通用设置入口不能写这个键（与 `pricingBaseline` 同样处理），内容按模型数量有上限。
- 归属：报表投影随 PR-A，由 Codex 做；设定值和已知悉的接口随 PR-A；页面展示随前端 PR。
- 验收：
  - 集成测试：固定数据下，某天累计等于设定值不提醒、超过提醒；多钱包、多 run 的结算都计入同一模型同一天；换日边界按结算时间正确归日；模型覆盖优先于默认值；没有设定值返回"未启用"；已知悉后不再返回该日期及之前的提醒，之后的日期照常返回；非管理员被拒。（2026-10-02 第三轮复核后修订）已知悉的并发：两个标签页分别确认不同模型，两条都保留；同一模型新旧日期乱序到达，最终仍是较新的日期；响应丢失后重试，结果不变；通用设置入口写这个键被拒。
  - 浏览器验证（前端 PR）：结算后管理员打开财务页能看到提醒；刷新后仍在；点"已知悉"后消失；没有设定值时显示"未启用"。

## Codex 实施说明草稿（2026-10-02 开工前核对，审查后修订）

供总控在 #590 合并后转发；转发前请总控按当时的 staging 和 open PR 再核一遍开头的事实。（2026-10-02 审查后修订）已按独立审查 [5954889611](https://github.com/Crnobog9527/GraylumAI_vercel/pull/553#issuecomment-5954889611) 和 Owner 的分类决定（[5955232832](https://github.com/Crnobog9527/GraylumAI_vercel/pull/553#issuecomment-5955232832)）补齐，下面是完整替换后的版本。

```markdown
任务：BILL-PAYG（边用边扣）实施，风险 high

仓库：Crnobog9527/GraylumAI_vercel（公开仓库）。PR 和评论里不提及任何人的用户名，不写邮箱、账号、密码，也不写审查机器人的触发词。先读 AGENTS.md 和 docs/ENGINEERING.md。

依据：PR #553 的描述（方案 v3、2026-10-02 修订、"2026-10-02 开工前核对"、"2026-10-02 审查后修订"），以描述当前版本和其后的总控评论为准。#553 只是方案记录：不在它上面提交，也不改它的描述。

开工条件和开工前核对：
1. RATE-LIMIT 接线 #590 已合并到 staging。
2. Q1、Q2 已由 Owner 决定（#553 评论 5954715142）：Q1 = A（整理等积分时用户发新消息，先补做上一轮整理）；Q2 = 启动门槛首版不随价格自动更新。
3. 读当时的 staging head、全部 open PR，以及 #593（B1，迁移 0159）是否已合并（#597 MODEL-PRICING-SYNC C1+C2 已于 c6441946 合并）、最新 head 和 #593 写在 PR 里的 runtime_work_projection md5；发现重叠的写入方先报总控，不要先动手。
4. 从最新 staging 新建任务分支，先开 draft PR，描述里写明风险 high、方案链接和 Handoff 节；每完成一步验证过的改动就推送一次。

默认路径：前端的等待积分和继续界面通过技术验收之前，新准入的默认路径保持 v1，v2 不对普通请求开放。PR-A、PR-B、PR-C 都按这个前提交付；切换默认路径放在前端技术验收之后的单独小 PR，不新增运行开关。

PR 拆分（PR-A → PR-B 按顺序，前一个合并后再开下一个；PR-C 可以并行）：
- PR-A 计费核心（SQL 和 BILL2 服务）：
  - 一个追加迁移。新增 v2 合同分支：run 零预留；每个 call 一份预扣；H=min(G,A)；A≥L 才领取新 call；按累计差额结算 D=min(Δ,H)，平台承担 e，始终 C+E=N。v1 原样保留。
  - 单次上界函数放在 packages/api/src/services/bill2/openRouterPolicy.ts，与 openRouterBound 同一条 max 规则。派生 quote 和计量字段按 #553 第2、7节。
  - 旧公开收尾入口一律拒绝 call 级预扣：atomic_settle、atomic_refund、atomic_abort_settle，以及 atomic_finalize_ai_success、atomic_finalize_ai_failure、atomic_finalize_ai_abort 的外层入口，对 v1 的 run 级预扣（现有）和 v2 的 call 级预扣都要拒绝；普通旧钱包预扣（与 bill2 无关的）行为保持不变。这六个外层包装的当前定义在 0105，底层原函数（已改名为 bill2_legacy_*）的最后定义分别在 0057（settle、refund、abort_settle）、0058（finalize_success、finalize_abort）、0059（finalize_failure）；以开工时最新定义为准，全部列入 md5 防漂移检查。
  - 启动门槛从 system_settings 读取，缺配置时拒绝新收费，不显示成余额不足。
  - 在现有 bill2_admin_call_report 补充平台承担投影（#553"Owner 已定的问题"Q2），以及平台承担提醒的设定值和"已知悉"接口（#553"管理员提醒"，读取时计算，不在结算事务里判断，不写日志事件）。
  - 注销衔接：0156 的 bill2_erasure_closed 及其调用点要同时认 v1 的 run 级预扣和 v2 的 call 级预扣；处于"等待积分"的 v2 运行单遇到已注销账号要能直接收尾，不等充值。收尾规则：关闭未来调用；只释放未派发的、或已有可靠撤权证明的 hold；已派发但费用未知的 call 各自保留 hold，转为 cost_pending；已结算的前缀不变；零 call、零 hold 的直接结束，不制造退款。财务绑定（注销判定认 call 级预扣）在 PR-A；等待状态遇到注销的接线在 PR-B。与 #598 实现谁先合并都可以，后合并的一方负责适配和同步（定义和防漂移 md5），并做集成回归。
  - 名义费用（#553 第3A节）：派生 quote 新增 nominalPricing 标价表（shared/modelPriceBound.ts 新增与 deriveFrozenPrices 同源的推导函数）；v2 claim 缺这个字段就拒绝；SQL 按冻结标价表和回执 token 数重算 n_i，W/N/Δ/D/E 基于 n_i；S=Σc_i 与 S_n=Σn_i 分别累计；缺 token 时按 Owner 决定以实际费用为收费基准：ceil(q×m×min(c_i,U_i)) 进入累计，标 actual_fallback，账本注明收费基准是实际费用；c 也缺失时保留预扣、转 cost_pending；兜底结算后证据迟到只记对账、不重算不补扣；冻结时的单价上限校验只核对本次 T 可达的档位和分时组合；P>T 时按实际 P 在完整标价表取档并按超界处理；分时价一律取所有时段中最贵的价格；bill2_admin_call_report 同时给出 c、n、g 及拆分。v1 不变。
  - 流水类型：账务写入沿用现有 type；如需新增 type，财务统计和报表的读取端不能用写死的 enum 校验整行（参考 #599 评论 5956220312 的财务页 500）。
  - 同步 docs/launch/tasks/V3-BILL-2-provider-authoritative-billing.md 里整run预留、run 与预扣一对一、超额逐笔人工授权的旧条款。
  - 本 PR 不改 Runtime 默认路径：新 run 仍是 v1，v2 只能由测试创建。
- PR-B Runtime 接线：（名义费用：正式环境每次 claim 推导 nominalPricing，staging 在准入时冻结进 callPolicy）
  - 准入可以创建 v2 run，但默认路径仍为 v1（见上面"默认路径"）。
  - execute 每个 call 用最终请求字节计算 B/T/U/G；余额低于门槛时持久化等待积分状态和断点，不取消任务；继续入口（原 execution＋游标＋epoch 比较交换）。
  - 续跑重新过 #590 的 calls 闸门，计数按剩余 call 数，被拒时保持等待，不走 fail_before_dispatch。
  - 剩余 call 数超过配置容量时（#590 redisRateLimiter.ts 的 checkRuntimeRateLimit 在 rate 大于每分钟或每日限额时直接返回 unavailable、60 秒），要单独识别为"使用额度配置低于本任务剩余调用数"：给出可诊断的状态码，前端据此提示"需要管理员调整使用额度"，处理入口是现有的使用额度设置页（管理员）和原任务的取消入口（用户）；不能无限显示"稍后再试"，也不能绕开限流。
  - Q1 = A 的编排：等待整理的 execution 存在时，同一会话的新消息先补做上一轮整理，再处理新消息；余额低于整理门槛时两者一起等待。
  - staging 续跑前重跑窗口价格检查；与 B1 的交互按 #553 第8节；新增结果状态和给前端用的状态码。
- PR-C 价格变动提醒（不依赖 PAYG）：按 #553"管理员提醒"的价格部分（读取时比较；基线放在 config.pricingBaseline，不能放进 config.pricing；只在条件写入成功时补基线；把 pricingBaseline 加进 services/models/modelConfig.ts 的 MANAGED_CONFIG_KEYS，通用 config 保存一律保留服务端当前值）。#597（MODEL-PRICING-SYNC C1+C2）已合并（c6441946），基于合并后的版本接入；仍排在 #590 合并之后。
- 前端（等待积分提示、继续按钮、"回复已完成，整理等待积分"、"费用核对中"、使用额度配置待调整的提示、平台承担报表和两种提醒的后台展示）不在本任务，按分工另派。
- PR-A 过大可以再拆，但每个 PR 都必须能单独回退，不能留下半套钱路。

迁移：
- 编号 = 开工时 staging 最大编号＋1（B1 已合并则为 0160）。CI 要求编号连续，并且大于目标分支的最大编号。后合并的一方负责 rebase、改号、重新生成 built-fingerprint.json。
- 照 0157 的写法，开头对每个要替换的函数做 md5 防漂移检查；基准一律以开工时 staging 上的最新定义为准（#553 第9节和上面 PR-A 列出的是 2026-10-02 的快照）。如果改 runtime_work_projection，基准是 B1 合并后的定义（#593 在 head fd210532 的 md5 是 fcb191fa3d9135c42509cd1395a6e025，已由独立复核在本机数据库复算确认；runtime_material_allowed_before_b1 的基准是 0a1bac81b4214c2151f8ac32660b8d76；仍以开工时最新定义和实测 md5 为准）。
- 只追加，不改已有迁移；新迁移在自己的位置连续执行两次结构不变；运行 node packages/db/tests/run-db-baseline-replay.mjs --local-only --write-built，并提交指纹。
- 不访问任何远程数据库。staging 应用迁移需要 Owner 单独批准，由总控执行。

必测（离线，本机 Docker），除 #553 第9节"离线验收必须覆盖"的全部条目外：
- 单次上界与 deriveFrozenPrices/openRouterBound 一致：普通输入、缓存写入、长上下文档位取最大值，不叠加；T 跨过长上下文阈值时的 -1/0/+1；Gemini 写入费相加；88 字节缓存开销只在 B 里算一次。
- 旧收尾入口：v1 的 run 级预扣和 v2 的 call 级预扣，分别经上面六个旧公开入口中的每一个，都被拒绝；与 bill2 无关的普通旧钱包预扣经这六个入口的原有行为不变。
- 正式环境价格模式（自动推导、涨价不拒绝、读价失败时拒绝新 claim）和 staging 锁价模式（涨价拒绝、续跑前重查）都要有用例；正式环境本身不接入。
- #590 闸门：第一次执行被拒时不领取任何 call；续跑被拒时保持等待、不取消、不冻结、不重放已结算前缀；暂停开关能挡住续跑；recoverFinancial 仍用 denyNewCalls。
- 配置容量边界：剩余 call 数等于每分钟/每日限额时能续跑；大于限额时进入"使用额度配置待调整"状态而不是一直"稍后再试"；管理员调高限额后能续跑；普通窗口限流在窗口重置后正常恢复。
- Q1 = A：等待整理时发新消息，先补做整理再处理新消息；整理只收一次；余额不够时两者一起等待；补做前的版本检查。
- B1：OPC_CAPTURE_PENDING 不显示成积分不足；等待中的 execution 不被补应用。
- 平台承担投影和两种提醒：按 #553"Owner 已定的问题"Q2 和"管理员提醒"的验收条目（提醒只在管理员页面读取时计算；准入和结算不经过提醒逻辑）。
- 正式模式价格来源：写入失败、CAS 冲突且已存快照仍过期、并发写入新鲜快照时，新 claim 只用已写入且 pricingHash 一致的快照，确认不了就按"价格暂时无法确认"拒绝；staging 现有 fallback 行为不变。
- 基线和已知悉的并发：旧页面保存、另一个标签页点"已知悉"、自动重读、连接检测交错时基线不丢；平台承担的已知悉在两个标签页确认不同模型、同一模型新旧日期乱序、响应丢失后重试时结果正确；通用设置入口改不了这两个键。
- 注销：v1 和 v2 运行单在注销场景下都能收尾；等待积分的 v2 运行单遇到已注销账号直接收尾、不等充值；未派发的 hold 只释放一次，已派发未知的 call 保留 hold 并转 cost_pending，已结算前缀不变，零 call 零 hold 不制造退款。并引用 #598（head 3ba7a4fe）方案里的用例：零 call；前缀已结算加未知后续；预扣缺失或错绑时被拒。
- 名义费用：有缓存读取、有缓存写入（g 为负）、快照有 discount、长上下文档位（P 恰好在阈值 -1/0/+1）、分时价（取所有时段最贵价，含只在某些时段更贵的情况）、冻结校验（T 在阈值 -1/0/+1；快照有更贵的高档但本次短请求仍通过；P>T 按实际档取价并按超界处理）、兜底偏差（写缓存时按 c 多收、命中缓存时按 c 少收、查账用尽后证据迟到不重算不补扣）、思考单独标价、token 分项缺失（兜底和查账）、分项矛盾（置 conflict）、只对账分项不一致（照常收费）这几种情况下，n_i 和扣费都正确；n_i ≤ U_i，构造 P>T 时按超界处理；标价表与冻结上限和 pricingHash 不一致时拒绝 claim；v1 回放仍按 usage.cost；对账恒等式 Σc+Σg=Σn 和 C+E=N 逐 call、逐 run、逐日成立。
- 流水类型：出现未知的 credit_transactions.type 时，财务统计和报表仍能返回。
- 默认路径：未切换前，普通准入仍创建 v1 run。
- pnpm test:api、API 和网站的类型检查与 lint、node scripts/check-code-size.mjs、docs/ENGINEERING.md 第7节的两条计费和恢复集成测试命令、空库文件建库检查。

不在范围：
- 不调用真实模型，不使用 OpenRouter 测试余额；准入实测和 #561 证据复用另报预算。
- 不改 staging 的 q、m、门槛、使用额度、提醒设定值、测试窗口或模型配置；这些值由总控按证据经 Owner 批准后配置。
- 不做 Fusion 收费、多模态、REPORT-GEN、分章报告、正式环境接入（RUNTIME-PROD）、付款和订阅流程。
- 不建新表、新队列、定时任务、通知服务或新钱包；按 #553 第1节在原表加列。
- 不加美元总闸门（正式环境的风险说明见 #553 第2节）。

审查和合并：
- 每个 PR 都按实际范围记为 high（PR-C 包含价格基线写入和已知悉的条件写入，也是 high）。CI 和 Security 全部通过后先报总控；独立审查由总控按 AGENTS.md 第7、12节安排。审查出的 P0/P1 修完后，在新 head 上重新审查。
- 合并需要 Owner 对具体 PR 明确批准，由总控核对后执行；不要自己合并，不开自动合并。staging 迁移应用另需 Owner 批准。
- 每次推送后更新 PR 的 Handoff 节：已完成、下一步、阻塞、实际运行过的验证和结果。
```

## Handoff

Done：同步 #565 的可空模型/线路倍数，默认m=3，q=100；每call从原操作映射快照冻结m_i。G_i=ceil(q×U_i×m_i)，H_i=min(G_i,A_i)；累计W=Σ(n_i×m_i)（2026-10-03 第六轮复核后修订），Δ_i为ceil(q×W)的前后差，D_i=min(Δ_i,H_i)，C+E=N=ceil(q×W)。封顶/估算超界归因、加权门槛及按模型财务汇总同步，充值不追回平台承担。普通导师继承3时G仍为Sonnet54、Gemini21积分；实测、输出限制、预算、锁和异常规则不变。本轮仅PR描述/评论，零文件差异。

方案记录处理：**#553只保留为GitHub方案及审阅记录，不单独把此空提交/方案描述合并进仓库**。当前无方案文件差异，因此不为该记录普通merge staging，也不处理其旧基线上的Dependency Audit失败；失败仍是历史失败，不记为通过。等 #497、#550 合并且实施获授权后，从当时最新staging建立后续BILL-PAYG实施PR，引用本方案及审阅结论，并同步BILL2技术契约。若以后改为将本PR转成实际文档/实现候选，则先普通merge最新staging，再核验新head的Dependency Audit及全部必需检查、适用独立审查与批准；不能沿用本空提交旧检查。

Validation：本轮算例、累计进位/封顶/不追收/归因守恒与方案一致性核查PASS。CI未重跑；真实钱包并发、SQL/功能、门槛样本、staging配置现值及真实调用验证NOT_RUN。没有模型调用、配置或数据库变更，不能把文字与算术验证当实现通过。

Next：报总控复审模型级倍数同步与累计结算方案。保持draft，不合并；按 #497 → #550 → BILL-UNIT → PROMPT-CACHE → BILL-PAYG → REPORT-GEN 顺序（（2026-10-02 修订）），实施和门槛配置按后续授权进行。staging q/默认m由总控在Owner批准后修改，旧冻结合同不变。#561复用及专项净缺口预算另按原边界报批。（2026-10-02 开工前核对）开工条件改为 #590 合并；由 Codex 按"Codex 实施说明草稿"开工，说明由总控在 #590 合并后转发。实施 PR 照常要独立审查，合并和 staging 迁移应用都要 Owner 批准。（2026-10-02 审查后修订）Q1/Q2 已定；独立审查 5954889611 的发现已按 Owner 分类写入；新增管理员提醒范围；等增量复核。（2026-10-02 提醒设计修订）提醒改为读取时计算，按复核 5955643435 的 4 项 P2 修订；等增量复核。（2026-10-02 第三轮复核后修订）按复核 5956002855 补 3 项 P2、1 项 P3，并写入注销衔接和流水类型两项；等增量复核。（2026-10-03 第四轮复核后修订）按复核 5956530433 改清注销收尾规则；#597 已合并；等增量复核。（2026-10-03 名义费用收费修订）按 Owner 2026-10-03 决定新增第3A节"名义费用"，第2、3节和报表、提醒、实施说明同步；等独立复核。（2026-10-03 第六轮复核后修订）按复核 5957535039 和 Owner 对兜底、分时价的决定修订；等增量复核。

## 2026-10-02 修订记录

写入方：Claude 执行窗口（[接手记录](https://github.com/Crnobog9527/GraylumAI_vercel/pull/553#issuecomment-5939483682)）。只改本描述，head `135d4c197a630e613ea692c0fe9742079e295869` 不变，零文件差异；Owner 原话、已有总控记录和其余段落原样保留，旧顺序句保留为删除线。各处修改都标了"（2026-10-02 修订）"。

| 段落 | 改了什么 | 依据 |
| --- | --- | --- |
| 第2节"每次调用的实际冻结上限"第3条的基础公式 | 输入最高单价定义为 max(普通输入价, 5分钟缓存写入价, 适用的长上下文档位价)；删掉"缓存写入加价逐项加入"，避免重复计算；写明适用于Luna自动写入、Gemini以后的显式缓存（向上取整12位小数）以及长上下文档位 | [#572](https://github.com/Crnobog9527/GraylumAI_vercel/pull/572) 第4.3节第1、6条；Master Plan 第2.1节第35项（逐次上界要包含缓存写入） |
| 第2节"闭源验证矩阵、阈值与安全余量" | 新增一条：准入实测样本包含带缓存标记的请求和自动缓存线路的重复前缀请求，另记cached和write token，验证c≤U | #572 第4.3节第3条 |
| 第2节"q=100、各call继承默认3的冻结算例与启动门槛" | 注明两张算例表都未计缓存写入，补充按max定义的Sonnet普通导师G=61积分（Gemini仍为21） | #572 第4.3节第5条 |
| 第3节"逐调用结算与累计一次进位" | c_i明确为已含缓存效果的 `usage.cost` | #572 第4.3节第5条 |
| 第7节"0108测试窗口、批准报价与长期身份" | 稳定policy和派生quote带 `cacheWriteUsdPerMillion` 及来源和版本，与 #572 同名同算法 | #572 第4.3节第2条 |
| 第4节第1步、第9节、Handoff 的 Next | 施工顺序改为 #497 → #550 → BILL-UNIT（#565）→ PROMPT-CACHE（#572）→ BILL-PAYG（#553）→ REPORT-GEN（#547），RATE-LIMIT（#573）排在PROMPT-CACHE之后；限流/暂停闸门在每轮第一次claim和PAYG冻结之前；写入方按Owner 2026-10-02分工由总控安排 | 总控 2026-10-02 安排；[#572 总控审阅](https://github.com/Crnobog9527/GraylumAI_vercel/pull/572#issuecomment-5938680511) 中 PROMPT-CACHE 与 RATE-LIMIT 的先后 |

#572 第4.3节第4条（c>U才记budget_conflict）与现有规则一致，不需要改动。本轮验证：只做了算术复核（Sonnet U=0.20240美元、G=61积分；Gemini 21积分不变）和文字一致性检查；CI 未重跑；没有真实调用、配置或数据库变更。

## 2026-10-02 开工前核对

写入方：Claude 规划窗口（[接手记录](https://github.com/Crnobog9527/GraylumAI_vercel/pull/553#issuecomment-5954509751)）。只改本描述，head `135d4c197a630e613ea692c0fe9742079e295869` 不变，零文件差异；Owner 原话、已有总控记录和其余段落原样保留，新增内容都标了"（2026-10-02 开工前核对）"。核对基准：origin/staging `4d805783`、#590 head `9874815e`、#593 head `a294c984`。

| 段落 | 改了什么 | 依据 |
| --- | --- | --- |
| 开头"结论与授权" | 加一段核对说明：基准提交、Codex 实施、两个新增节的位置 | Owner 2026-10-02 决定（[5952671504](https://github.com/Crnobog9527/GraylumAI_vercel/pull/553#issuecomment-5952671504)） |
| 第1节"必要新增信息" | "不预占迁移编号"改为按第9节取 0159 之后的空号 | B1 #593 已用 0159 |
| 第2节第3条之后 | 新增"与已合并代码的对应关系"：deriveFrozenPrices/openRouterBound 的取值规则与本方案一致；PAYG 把整个 contextTokens 换成 T，新增单次上界函数；reasoning 已并入输出单价；88 字节缓存开销已在 B 里，K/M 不再加；正式环境每次 claim 自动取价，staging 窗口锁价 | `modelPriceBound.ts`、`openRouterPolicy.ts:32-43`、`pricingAdmission.ts:89`、`providerRequest.ts:70`、`execute.ts:129-133`、`promptCache.ts`；[#581 合并记录](https://github.com/Crnobog9527/GraylumAI_vercel/pull/581#issuecomment-5951733074) |
| 第2节第4条 | 列出四处要求 upperUsd 等于整上下文上界的校验点，以及 v2 怎么改 | `stagingPolicy.ts:33`、`providerRequest.ts:61-62`、`openRouterAdapter.ts:127-128`、0157 `bill2_claim` |
| 第3节倍数快照段 | "重读获准报价"在正式环境和 staging 分别是什么意思 | 同上合并记录 |
| 第4节第1步 | 按 #590 实际代码写明两道闸门的位置和先后；续跑重新过 calls 闸门、计数按剩余 call 数、被拒保持等待而不取消 | #590 `admission.ts:101`、`execute.ts:155-164`、`executionStream.ts:49/62/71`、`newWorkGate.ts` |
| 第5节表格 resume 行、逻辑 run 行，以及报价过期段 | 续跑过闸门；正式环境不设按准入时价格算死的美元总上限；staging 续跑前重跑窗口价格检查 | 同上；`pricingAdmission.ts` 只在新准入时检查 |
| 第7节稳定 policy | 价格上下界只用于 staging 窗口；正式环境的稳定 policy 不锁价格 | #581 合并记录 |
| 第8节表格 | 新增"定位导师与 B1 右侧信息"一行 | #593 `opc/capture.ts`、`opc/service.ts` 的 `prepareStep`、`executionStream.ts`、`0159_opc_capture.sql` |
| 第9节 | 前序 PR 已合并；改为 Codex 实施；迁移编号规则和后合并方负责同步；要替换的 SQL 函数最新定义清单；旧收尾拒绝要覆盖 call 级预扣；与 #590 的文件重叠 | `check-migration-ledger.mjs`；0105/0106/0108/0156/0157/0158/0061；#590 文件清单 |
| Handoff 的 Next | 开工条件改为 #590 合并，由 Codex 按实施说明开工 | Owner 2026-10-02 决定 |
| 新增两节 | "需要 Owner 决定的问题"（Q1、Q2，各附推荐）；"Codex 实施说明草稿" | 本次任务要求 |

核对后不需要改的部分：第2节的 max 定义、第3节以 `usage.cost` 为 c_i、budget_conflict 只在 c>U 或 P>T 时设置、BILL-UNIT 的 q 和逐 call m_i（0157 在 `payload.billingUnit.multiplier` 冻结，`bill2_finalize` 按 ceil(q×Σ(c_i×m_i)) 一次进位）、`ai_models.is_active` 停用入口、0105 的 `credit_transactions_bill2_phase` 唯一索引，都与当前代码一致。

本轮验证：只读核对上面列出的源码和迁移；用 node 复算缓存块开销为 88 字节；读 `check-migration-ledger.mjs` 确认编号必须连续且大于目标分支最大值。没有运行测试，CI 未重跑；没有访问数据库，没有真实调用，没有改配置。

## 2026-10-02 审查后修订

写入方：Claude 规划窗口。只改本描述，head `135d4c197a630e613ea692c0fe9742079e295869` 不变，零文件差异；新增内容都标了"（2026-10-02 审查后修订）"，被替换的说法用删除线保留。依据：独立审查 [5954889611](https://github.com/Crnobog9527/GraylumAI_vercel/pull/553#issuecomment-5954889611)，Owner 的 Q1/Q2 决定（[5954715142](https://github.com/Crnobog9527/GraylumAI_vercel/pull/553#issuecomment-5954715142)），Owner 的分类处理决定和新增范围（[5955232832](https://github.com/Crnobog9527/GraylumAI_vercel/pull/553#issuecomment-5955232832)）。代码基准：staging `d7011b7b`（#595 已合并），#590 `9874815e`，#593 `044fef57`。

| 审查发现 / 决定 | 分类 | 改了哪里 |
| --- | --- | --- |
| Q1、Q2 | Owner 已定 | "需要 Owner 决定的问题"改为"Owner 已定的问题"，附 Owner 原话；Q1 的 B 选项改成准确说法，并标为未采用 |
| P1 旧中断结算入口 `atomic_abort_settle` 漏列 | C 类 | 第9节补上六个旧公开收尾入口和底层定义（0105 包装；0057、0058、0059 底层）；实施说明 PR-A 的必做和必测 |
| P2 剩余调用数超过配置容量会永久等待 | C 类 | 实施说明 PR-B 的必做和必测：单独的状态码、提示和处理入口，配置边界和窗口重置后恢复 |
| P2 Q1 未定、前端就绪条件缺失 | B 类 | 实施说明的开工条件写明 Q1 已定；前端等待和继续界面通过技术验收前，v2 默认路径保持关闭，切换放在单独小 PR |
| P3 平台承担报表写成现状 | B 类 | Q2 改为在 `bill2_admin_call_report` 补充平台承担投影，写明归属和验收 |
| 正式环境没有事先固定的平台美元损失上限 | 风险说明 | 第2节价格来源后新增"正式环境的平台成本风险"；不加美元闸门 |
| 价格变动提醒、平台承担提醒 | Owner 新增范围 | 新增"管理员提醒"一节：判断规则、复用现有日志和报表、归属（PR-C、PR-A、前端 PR）和验收；实施说明同步 |
| #593 head 和 `runtime_work_projection`；#595 已合并 | 顺带更新 | 第9节的防漂移基准改为"以开工时最新定义为准"，注明 #593 会写新的 md5；记下 #595 合并提交 |

本轮验证：只读核对 0105 的六个旧收尾包装（都只检查 `bill2_runs.pre_deduct_id`），以及它们底层原函数的最后定义位置；核对 #590 `redisRateLimiter.ts` 中 rate 超过配置时返回 unavailable 的分支；核对价格快照的两个写入点、`application_logs` 写入和现有后台页面。没有运行测试，CI 未重跑；没有访问数据库，没有真实调用，没有改配置。

## 2026-10-02 提醒设计修订

写入方：Claude 规划窗口。只改本描述，head `135d4c197a630e613ea692c0fe9742079e295869` 不变，零文件差异；新增内容标了"（2026-10-02 提醒设计修订）"。依据：独立复核 [5955643435](https://github.com/Crnobog9527/GraylumAI_vercel/pull/553#issuecomment-5955643435) 的 4 项 P2，以及总控的修订要求（读取时计算）。代码基准：staging `d7011b7b`，#593 `fd210532`，#597 `ed40dd67`。

| 复核发现 | 改了哪里 |
| --- | --- |
| P2 `logger.warn` 不会落库，只写日志不等于通知 | "管理员提醒"整节改为读取时计算：不发事件、不依赖日志；管理员专用接口，页面顶部显示，带"已知悉"；验收包含从事件发生到页面可见、刷新后仍在、已知悉后消失、非管理员被拒 |
| P2 平台承担提醒在结算事务里判断，跨钱包并发会漏报或重复报 | 改为管理员打开财务页时，从 `bill2_admin_call_report` 投影按"模型＋UTC 日"汇总，与当前设定值比较；没有设定值显示"未启用"；已知悉存在 `system_settings` |
| P2 价格提醒在 CAS 写入之前判断 | 写入时不做比较，只在条件写入成功的同一次更新里补基线；比较在页面读取时做；已知悉也用条件写入 |
| P2 没有定义比较用哪个 T、哪一档 | 在基线和当前快照档位阈值的并集（加 0）上逐个 T 用 `deriveFrozenPrices` 比较；5 倍只算异常一类，不重复报；未知字段、端点消失、不可用、新增分开显示 |
| 总控要求"基线放在 config.pricing 中" | 技术上改放在旁边的 `config.pricingBaseline`：`pricingSnapshot` 是严格结构，`config.pricing` 里多一个字段会让 `readPricingSnapshot` 返回 null，准入因此被拒。仍是同一行、同一次条件写入 |
| #597 重叠 | 第9节和实施说明写明 PR-C 和提醒页面等 #597 合并后开工 |
| #593 head 和 md5 | 第9节和实施说明更新为 `fd210532`、`fcb191fa3d9135c42509cd1395a6e025`（源码声明值），注明以开工时最新定义为准 |

本轮验证：只读核对 `shared/modelPricing.ts` 的 `pricingSnapshot`（`.strict()`）和 `readPricingSnapshot`；核对 `routers/modelReasoning.ts` 的 `writeReasoning`、`runtime/pricingAdmission.ts` 的 `renew` 都先展开原 config 再写；核对 `shared/modelPriceBound.ts` 中档位按 `minPromptTokens` 选取。没有运行测试，CI 未重跑；没有访问数据库，没有真实调用，没有改配置。

## 2026-10-02 第三轮复核后修订

写入方：Claude 规划窗口。只改本描述，head `135d4c197a630e613ea692c0fe9742079e295869` 不变，零文件差异；新增内容标了"（2026-10-02 第三轮复核后修订）"。依据：独立复核 [5956002855](https://github.com/Crnobog9527/GraylumAI_vercel/pull/553#issuecomment-5956002855)、Owner 对 #598 的决定 [5955936040](https://github.com/Crnobog9527/GraylumAI_vercel/pull/553#issuecomment-5955936040)、#593 评论 [5956041937](https://github.com/Crnobog9527/GraylumAI_vercel/pull/593#issuecomment-5956041937)、#599 评论 [5956220312](https://github.com/Crnobog9527/GraylumAI_vercel/pull/599#issuecomment-5956220312)。代码基准：staging `d7011b7b`，#590 `9874815e`，#593 `fd210532`，#597 `555e595d`，#598 `4c3a4942`。

| 来源 | 改了哪里 |
| --- | --- |
| P2-1 基线可能被通用保存冲掉 | "管理员提醒"的价格部分：`pricingBaseline` 加进 `MANAGED_CONFIG_KEYS`，只有快照写入点和专用"已知悉"接口能改；补交错场景测试；实施说明 PR-C 和必测同步 |
| P2-2 平台承担"已知悉"的并发 | 改为管理员专用接口按最新对象合并、条件保存、冲突重读；同一模型日期只取较大值；处理首次创建的竞争；通用设置入口不能写；补测试 |
| P2-3 `fresh_unwritten` | 第2节：正式模式只用已写入、`pricingHash` 一致的快照，确认不了就拒绝新 claim；staging fallback 不变；"已知限制"区分报价时的快照和页面读取时的最新快照 |
| P3 过时的分级括注 | 删除，PR-C 按实际范围记为 high |
| #598 审查（Owner 决定） | 第9节新增注销衔接：`bill2_erasure_closed` 同时认 run 级和 call 级预扣；等待积分的运行单遇到注销直接收尾；与 #598 实现后合并的一方负责同步；新旧运行单都测 |
| 引用更新 | #593 的两个 md5 已复算确认（`fcb191fa…`、`0a1bac81…`）；#597 head `555e595d`；财务页 500 的根因是写死的流水类型 enum，PAYG 若新增类型，读取端不能再写死 |

本轮验证：只读核对 `services/models/modelConfig.ts` 的 `MANAGED_CONFIG_KEYS` 和 `withStoredManagedKeys`；0156 `bill2_erasure_closed` 的定义和五处调用；读取了上面引用的评论。没有运行测试，CI 未重跑；没有访问数据库，没有真实调用，没有改配置。

## 2026-10-03 第四轮复核后修订

写入方：Claude 规划窗口。只改本描述，head `135d4c197a630e613ea692c0fe9742079e295869` 不变，零文件差异；新增内容标了"（2026-10-03 第四轮复核后修订）"，原措辞用删除线保留。依据：独立复核 [5956530433](https://github.com/Crnobog9527/GraylumAI_vercel/pull/553#issuecomment-5956530433)（上一轮 3 项 P2、1 项 P3 已关闭，剩 1 项 P2）。代码基准：staging `c6441946`（#597 已合并），#590 `9874815e`，#593 `fd210532`，#598 `3ba7a4fe`。

| 来源 | 改了哪里 |
| --- | --- |
| P2 注销收尾措辞没有区分未派发和已派发但费用未知 | 第9节"与注销的衔接"改为：关闭未来调用；只释放未派发或已有可靠撤权证明的 hold；已派发未知的 call 各自保留 hold、转 cost_pending；已结算前缀不变；零 call 零 hold 直接结束、不制造退款。实施说明写明财务绑定在 PR-A、等待状态接线在 PR-B，并引用 #598 的零 call、前缀已结算加未知后续、缺失或错绑被拒三类用例 |
| #597 已合并 | 第9节、"管理员提醒"、实施说明的开工条件和 PR-C：#597 状态改为已合并（`c6441946`），PR-C 和提醒页面可以基于合并后的版本开工，仍排在 #590 合并之后 |
| #598 head | 更新为 `3ba7a4fe` |

本轮验证：读取复核 5956530433，核对 staging 新增的唯一提交是 #597 的合并。没有运行测试，CI 未重跑；没有访问数据库，没有真实调用，没有改配置。

## 2026-10-03 名义费用收费修订

写入方：Claude 规划窗口。只改本描述，head `135d4c197a630e613ea692c0fe9742079e295869` 不变，零文件差异；新增内容标了"（2026-10-03 名义费用收费修订）"。依据：Owner 2026-10-03 决定（[总控记录 5957160656](https://github.com/Crnobog9527/GraylumAI_vercel/pull/553#issuecomment-5957160656)）。第五版已由复核 [5956761444](https://github.com/Crnobog9527/GraylumAI_vercel/pull/553#issuecomment-5956761444) 定稿，本版是在其上的新增修订，需要新的独立结论。代码基准：staging `801e682e`（#599 已合并），价格快照结构见 `shared/modelPricing.ts`。

| 要求 | 改了哪里 |
| --- | --- |
| 1 名义费用定义、多档位规则 | 新增第3A节第1条：全部输入 token（含缓存读写）× 输入标价 + 输出（含思考）× 输出标价 + 请求标价，不用缓存价和 discount；长上下文按实际 P 取档；分时价取较大者 |
| 2 冻结什么、旧报价兼容 | 第3A节第2条：派生 quote 新增 `nominalPricing` 标价表，与 `deriveFrozenPrices` 同源推导，pricingHash 一致；v1 不读，v2 缺字段拒绝 |
| 3 计算依据和分项缺失 | 第3A节第3条：处理表（齐全、缺失兜底、cost 未知、收费字段矛盾、对账分项不一致） |
| 4 U 覆盖名义费用 | 第3A节第4条：P≤T 且输出≤O 时 n≤U 一定成立；n>U 按超界处理；第2节"超过上界"同步 |
| 5 结算公式 | 第3A节第5条：Δ/N/C/E/D/H 基于 n_i；S 与 S_n 分开累计；E 的含义；第3节开头加指向说明 |
| 6 报表和提醒 | 第3A节第6条：恒等式和 g 的拆分；Q2 报表、平台承担提醒的口径同步 |
| 7 适用范围 | 第3A节第7条：所有 v2 收费调用；启动门槛改用名义费用 |
| 8 对外说明 | 第3A节第8条：列出要改的位置，条款文字由 Owner 处理 |
| 9 必测项 | 实施说明 PR-A 的必做和必测同步 |

本轮验证：只读核对价格快照结构（`TOKEN_PRICE_KEYS`、override 条件 `minPromptTokens`/`utcDays`/`utcStart`/`utcEnd`、端点 `discount` 字段），检索面向用户的计费文字；算例用 python 复算（n=0.106、c=0.034 或 0.126、扣32积分）。没有运行测试，CI 未重跑；没有访问数据库，没有真实调用，没有改配置。

## 2026-10-03 第六轮复核后修订

写入方：Claude 规划窗口。只改本描述，head `135d4c197a630e613ea692c0fe9742079e295869` 不变，零文件差异；新增内容标了"（2026-10-03 第六轮复核后修订）"，被替换的说法用删除线保留。依据：独立复核 [5957535039](https://github.com/Crnobog9527/GraylumAI_vercel/pull/553#issuecomment-5957535039) 的 3 项 P2；Owner 对 P2-1、P2-3 的决定（[总控记录 5957737094](https://github.com/Crnobog9527/GraylumAI_vercel/pull/553#issuecomment-5957737094)，原话：「#553 缺 token 时直接根据供应商返回的总花费乘以倍数不就等于用户花了多少美金吗？然后用这个用户花的美金数换算成积分不就可以了？ 分时价选 c」）；P2-2 由总控按技术问题决定。代码基准：staging `801e682e`。

| 来源 | 改了哪里 |
| --- | --- |
| P2-1 缺 token 的兜底（Owner 决定） | 第3A节第3条：以实际费用为收费基准 `ceil(q×m×min(c,U))`，标 `actual_fallback`，账本注明；c 也缺失时转 cost_pending；新增"证据迟到"规则（不重算、不补扣，首版不做补偿，以后补偿须关联原消费且幂等）；写明 Owner 已知的两种偏差；第6条和实施说明同步；补测写缓存多收、命中缓存少收、证据迟到 |
| P2-2 档位校验（总控决定） | 第3A节第2条：单价上限校验只核对本次 T 可达的档位和分时组合，不可达高档保留但不参与拒绝；新增"P>T 时怎么取价"；补测阈值 -1/0/+1 和有更贵高档时短请求仍通过 |
| P2-3 分时价（Owner 选 C） | 第3A节第1条改为"已定"：一律取所有时段中最贵的价格；第8条加上用户说明"有分时价的线路按最高时段标价计费"；删掉"需另行决定"的提示 |
| 顺带 | 第3A节第1条公式补上 ÷10⁶；第3节残留的 c_i 公式（W、Δ、更新、上界比较、Δ_bound、算例、精度）改为基于 n_i，并补 S_n；第2节启动门槛的加权式、第4节并发守恒式和 Handoff 的 Done 同步改为 n_i（v1 的 0157 说明保持原样） |

本轮验证：只读核对 `shared/modelPriceBound.ts` 的 `applicableLayers` 选档条件（`minPromptTokens > T` 的档被排除），确认 T 可达范围与 U 推导一致。没有运行测试，CI 未重跑；没有访问数据库，没有真实调用，没有改配置。
