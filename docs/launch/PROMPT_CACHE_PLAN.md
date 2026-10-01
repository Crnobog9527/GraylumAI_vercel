# PROMPT-CACHE 实施方案（只是方案，不改产品代码）

- 任务来源：Master Plan 第 2.1 节第 35 项、第 7.1 节 PROMPT-CACHE 行；
  [总控记录 Owner 原话](https://github.com/Crnobog9527/GraylumAI_vercel/pull/561#issuecomment-5935197856)
  （2026-10-01）："必须要把这个缓存的功能加上的。不然成本太高了，用户消耗积分的速度也会很快。"
- 风险：**high**（Runtime 发往供应商的请求字节、BILL2 单次费用上界、收费口径）。
- 读的代码：#497 冻结 head `f9afd0db7805e80ccc6f5b7023a3e87b5014f5bd`（只读，未改）。staging 基线
  `2be631aa977bb6d7b95e74d1df4df76506ee247f`。
- 实施时机：#497 合并之后、BILL-PAYG（#553）定稿之前。写入方由总控确定。本方案不改 #497、#553、#565。
- 本轮没有发真实模型请求，没有改 staging 配置、数据库或测试窗口。只用无密钥 GET 读了 OpenRouter
  公开模型目录（见第 2 节）。

## 0. 结论

1. **第一版只缓存"系统指令里不变的开头"**：Skill 正文 + 导师固定规则前半段（`HOST_RULES` 里第一个
   `{{...}}` 占位符所在行之前的部分，冻结代码中为 4898 个字符）。系统指令后半段包含每轮变化的
   步骤状态（字段状态、当前问题、工作流上下文），历史对话排在它后面，跨轮次的前缀一定不同。所以
   **第一版不在历史消息上加缓存标记**：加了每轮都要按 1.25 倍付写入费，下一轮又读不到，反而更贵
   （第 1.3 节）。
2. **只给 Anthropic（Claude）请求加显式 `cache_control`**，TTL 用默认 5 分钟。Gemini 使用 Google 默认开启的
   隐式缓存，GPT-6 Luna 使用 OpenAI 的自动缓存，这两类都不加标记（第 2 节有官方依据）。验收时照样测量
   Gemini 的命中率。
3. **只放开一个位置**：adapter 只允许在 `role:"system"` 消息的文本块上出现一个
   `cache_control:{"type":"ephemeral"}`。顶层自动缓存标记、`ttl`、用户/助手/工具消息和工具定义上的标记，
   一律仍然拒绝（第 3 节）。
4. **旧执行字节不变**：标记只由新准入冻结的上下文字段 `promptCache` 决定。旧执行没有这个字段，重放时
   `openRouterRequestBody` 输出和现在逐字节相同，`requestHash` 不变（第 3.3 节）。
5. **费用上界计入缓存写入**：冻结报价 `providerLimits` 增加可选字段 `cacheWriteUsdPerMillion`，有这个字段时，
   上界的输入单价取 `max(普通输入价, 缓存写入价)`。没有这个字段就不加标记。实际扣费仍按 OpenRouter
   返回的 `usage.cost`，这个金额已经包含缓存读取折扣和写入溢价（第 4 节）。
6. 不新建表、迁移、服务、配置项或框架。第 6 节说明为什么这是最小正确改动。

## 1. 冻结产品的请求组装和稳定前缀

### 1.1 一次导师请求的实际字节顺序（`f9afd0db`）

| 顺序 | 内容 | 来源 | 跨轮是否稳定 |
| --- | --- | --- | --- |
| 工具定义 | 开场轮 `[]`，其他轮 `[ask_question]` | `admission.ts:202`、`runner.ts:162` | 开场轮和后续轮不同，后续轮之间稳定 |
| `messages[0]` system，① | Skill 正文 `loaded.forModel()`（SKILL.md + 本步骤 resources） | `admission.ts:119-120` | 同一步骤内稳定，换步骤会变 |
| system，② | `"\n"` + `agentTurnInstructions()` 的固定开头（4898 字符，以 `\n\n` 结尾） | `admission.ts:164`、`opc/service.ts:231-236`、`opc/agentTurnPrompt.ts` | 稳定（代码常量） |
| system，③ | `Current workflow step` / `Current step material`（每个字段的状态）/ 当前问题 / 字段角色 / 工作流上下文 | `agentTurnPrompt.ts:112-128` 的占位符替换 | **每轮可能变**：字段状态由整理模型更新，问题和可见字段随进度变化 |
| system，④ | `HOST_RULES` 剩余固定部分（约 1250 字符）+ 开场轮另加 `OPENING_RULE` + `"\n"` + `QUESTION_CONTRACT_INSTRUCTIONS` | `agentTurnPrompt.ts`、`admission.ts:165` | 固定，但排在 ③ 后面 |
| 历史消息 | 以前各轮的 user / assistant / ask_question 调用和结果；旧的 scopeMaterial 被替换成 "Superseded" 占位 | `context.ts:66-87`、`92-135`，`openRouterHistory.ts` | 位于 ③ 之后。超过输入预算时从最早一轮开始删 |
| 当前 user 消息 | `JSON.stringify({scopeMaterial, userRequest, dataNotice})` | `context.ts:54-56` | 每轮变 |

补充核对：

- SDK 0.18.0 把 instructions 作为 `{content: <字符串>, role: 'system'}` 插到 `messages` 最前面
  （`@openai/agents-openai/dist/openaiChatCompletionsModel.js:449-453`）。
- 请求转成发送字节的唯一位置是 `providerRequest.ts:openRouterRequestBody`（`execute.ts:121-122` 调用）。随后
  `assertRuntimeRequestCapacity`、`requestHash`、`runtime_response` 重放查询、`claimCall`、`dispatchOnce` 用的都是
  它的输出。所以缓存标记只能在这里添加，并且必须由冻结上下文决定。
- adapter（`openRouterAdapter.ts:144-151`）对普通消息的检查只允许 `role/content` 两个键，文本块只允许
  `type/text`；顶层字段也有白名单（`requestFields`）。这和
  [#561 的离线复现](https://github.com/Crnobog9527/GraylumAI_vercel/pull/561#issuecomment-5934667097)一致：
  加了任何缓存标记都会在凭据读取和发送之前报 `BILL2_PROVIDER_REQUEST_DENIED`。
- 整理模型（attached organizer，GPT-6 Luna）有自己独立的 instructions 和 input；匹配调用（matching）也一样。
  这两类调用不在第一版范围内。

### 1.2 加标记的位置和顺序要求

缓存命中的条件是前缀完全相同。Anthropic 的拼接顺序是工具 → system → messages，缓存标记把它之前的
全部内容写成一条缓存。因此：

- **唯一标记位置**：把 `messages[0].content` 字符串在"可缓存前缀长度"处切成两个文本块：
  `[{type:'text', text:<①+②>, cache_control:{type:'ephemeral'}}, {type:'text', text:<③+④>}]`。
  两块拼起来和原字符串完全相同，模型看到的文字不变。切分点在 ② 的结尾 `\n\n` 之后，
  正好是一行的开头，不会把一个词切开。
- 必须保证**稳定内容在变化内容之前**：① 和 ② 本来就在 ③ 前面，不需要调整提示词顺序，
  所以不改变 #497 已经验证过的提示词内容。
- 普通 Skill 轮（非导师、没有 `HOST_RULES`）：可缓存前缀只有 ①，`additionalInstructions` 整体算作变化部分。
- ordinary、auto、organizer、matching 调用不冻结 `promptCache`，请求字节保持不变。

### 1.3 为什么第一版不在历史消息上加标记

- 历史在 ③ 之后。只要 ③ 这一轮和上一轮不同，历史部分的前缀就不一样，历史缓存读不到。
  ③ 在导师流程中经常变化：整理模型更新字段状态、换问题、推进步骤都会改变它。
- Anthropic 只在标记位置写缓存，没命中时，从上一次命中点到标记之间的内容全部按 1.25 倍计费。
  在历史上加标记，等于大部分轮次给 ③ 和整段历史多付 25%，下一轮又读不到。
- 另外两点也会让历史前缀变化：超过输入预算时从最早一轮删历史（`context.ts:103-131`）；
  用户要求对比旧版本时保留旧的完整材料（`requestsHistoricalComparison`）。
- 如果以后要缓存历史，需要把 ③ 移到历史之后（例如放进当前 user 消息）。这会改变提示词结构，
  需要重新做导师质量评测，属于后续改进（第 7 节 B 阶段），不放进第一版。

### 1.4 粗略收益（情景估算，不是实测）

#561 离线样本中导师请求约 27.7–31.2 KB。设可缓存前缀为 S token，同一步骤内连续对话：

- 第一轮写入：1.25 × S × 输入价；之后 5 分钟内的每一轮读取：0.1 × S × 输入价（每次读取会刷新 5 分钟 TTL）。
- 以 Sonnet 5.5（输入 $2/百万 token）、S = 6000 token 为例：不缓存时每轮这部分是 $0.012，命中时是 $0.0012，
  第一轮多付 $0.003。实际节省多少取决于 Skill 的真实长度、回合间隔和换步骤的频率，由第 5 节的验收测量。

## 2. 官方资料核实（2026-10-01/02 查阅）

| 项目 | Anthropic Claude（经 OpenRouter） | Google Gemini 3.8 Flash（经 OpenRouter） | OpenAI GPT-6 Luna（经 OpenRouter） |
| --- | --- | --- | --- |
| 缓存方式 | 显式：在内容块上加 `cache_control`，最多 4 个。也支持顶层 `cache_control` 自动缓存（自动放在最后一个可缓存块上） | 隐式缓存，Gemini 2.5 及以后默认开启；也接受显式 `cache_control`，但 OpenRouter 只使用最后一个标记 | 自动缓存，不需要配置 |
| 最小前缀 | Sonnet 5.5：512 token（Opus 5.5 为 512，Sonnet 5 为 1024） | 4096 token（3.5–3.8 Flash） | 1024 个可见输入 token（GPT-5.6 及以后） |
| TTL | 默认 5 分钟（`{"type":"ephemeral"}`），可选 1 小时（`"ttl":"1h"`）；命中后刷新 | 隐式缓存平均 3–5 分钟，不固定 | GPT-5.6 及以后为最近一次写入或复用后 30 分钟 |
| 写入价格 | 5 分钟：1.25 倍输入价；1 小时：2 倍 | 隐式：没有写入和存储费用。显式：输入价 + 5 分钟存储费 | GPT-5.6 及以后：1.25 倍输入价，自动缓存也收，不需要开启 |
| 读取价格 | 0.1 倍（Opus 5.5 为 0.05 倍） | 目录价 0.075 / 0.75 = 0.1 倍（OpenRouter 文档写的通用值是 0.25 倍，以目录为准） | 0.1 倍 |
| 目录实价（USD/百万 token） | `anthropic/claude-sonnet-5.5` 的 `anthropic` 线路：输入 2，写入 2.5，1 小时写入 4，读取 0.2 | `google/gemini-3.8-flash` 的 `google-vertex/global` 线路：输入 0.75，读取 0.075，`input_cache_write` 0.041667（= 5 分钟存储费） | `openai/gpt-6-luna` 的 `openai` 线路：输入 0.1，写入 0.125，读取 0.01；输入超过 272000 token 时价格翻倍 |

usage 返回（OpenRouter 统一格式）：`usage.prompt_tokens`、`usage.prompt_tokens_details.cached_tokens`（缓存读取）、
`usage.prompt_tokens_details.cache_write_tokens`（缓存写入）、`usage.cost`（"the total amount charged to your
account"，即实际扣费总额）。另有 `cache_discount`（Anthropic 写入时为负数，读取时为正数），只能作为说明。
OpenRouter 对多线路模型使用"粘性路由"保持缓存，但我们的冻结路由是 `only:[单一线路]`，不依赖这一点。

来源：

- [OpenRouter Prompt Caching](https://openrouter.ai/docs/guides/best-practices/prompt-caching)（2026-10-02 读取；
  包括 Anthropic 自动/显式缓存、可用线路、Gemini 只用最后一个标记、OpenAI GPT-5.6+ 写入 1.25 倍、`cache_discount`、粘性路由）。
- [OpenRouter Usage Accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting)（2026-10-02 读取；usage 字段结构，流式最后一帧带 usage）。
- [Anthropic Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)（2026-10-02 读取；最小长度表、
  只在标记处写缓存、向前最多查 20 个块、最多 4 个标记、工具→system→messages 的层级、倍率）。
- [Google Gemini Context caching](https://ai.google.dev/gemini-api/docs/caching)（页面标注更新于 2026-09-02；隐式默认开启、3.x Flash 最小 4096）。
- [OpenAI Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)（2026-10-02 读取；GPT-5.6+ 最小 1024、30 分钟、写入 1.25 倍）。
- OpenRouter 公开目录 `GET https://openrouter.ai/api/v1/models` 和 `/models/<id>/endpoints`，无密钥只读，
  2026-10-01 18:52 UTC（北京时间 10-02）读取。价格以执行当时重新读取并冻结的报价为准。

由此得出的两个设计判断：

- **Gemini 第一版不加标记**：隐式缓存默认开启，没有写入和存储费用。显式标记会额外产生存储费，而且
  OpenRouter 只用最后一个标记，并不能多缓存什么。验收测量隐式命中率，如果命中率低，再另开小改动
  给 `google/*` 加标记（报价里写入价 = 输入价 + 存储费）。
- **Luna 不加标记，但它的报价也要带写入价**：GPT-6 Luna 的自动缓存在写入时收 1.25 倍。现在的上界按整个
  context 预留，实际上很难被超过，但正式的上界不应该依赖这种余量。PAYG 把上界收紧到 `T=B+K+M` 之后，
  这一点必须明确算进去（第 4.3 节）。

## 3. adapter 白名单的最小放开和重放兼容

### 3.1 冻结上下文（新准入才有）

在 `execute.ts` 的上下文 schema 里加一个可选字段（strict 对象）：

```ts
promptCache?: {version:'prompt-cache-v1'; systemPrefixChars:number; systemPrefixSha256:string}
```

`admission.ts` 只在以下条件**同时满足**时写入这个字段：真实报价；主对话角色是 skill（导师轮是 skill 角色加 v5 格式）；
主模型 id 以 `anthropic/` 开头；该模型的冻结 `providerLimits` 带有 `cacheWriteUsdPerMillion`；前缀长度大于 0。
`systemPrefixChars` = `loaded.forModel().length` + 由 opc 服务提供的稳定开头长度（导师轮为 `1 + 4898`，
从 `agentTurnPrompt.ts` 导出一个常量计算，不手写数字）。哈希是对这段前缀算 sha256。字段随 `sourceHash`
冻结进 `runtime_admit`。SQL 不检查 context 的键，不需要迁移（已核对 0105–0108、0155）。

### 3.2 发送前的转换（`providerRequest.ts`）

在 `openRouterRequestBody` 中，`normalizeOpenRouterHistory` 之后：

- 仅当 `context.promptCache` 存在，并且是主对话（`primaryDialogue && phase !== 'attached_organizer'`）时处理；
- 要求 `messages[0]` 恰好是 `{role:'system', content:<字符串>}`，前 `systemPrefixChars` 个字符的 sha256 等于冻结值，
  并且后面还有内容或刚好结束；否则抛 `RUNTIME_PROVIDER_BINDING_DENIED`（在 claim 之前失败，不产生费用）；
- 把 content 换成第 1.2 节的两个文本块（后半段为空时只保留一个块）。

这样切分只由冻结上下文和 SDK 实际给出的字节决定，不靠识别提示词关键词。

### 3.3 adapter（`openRouterAdapter.ts`）：只多接受一种形状

在普通消息检查（第 144-151 行）中增加**唯一**的例外，其余检查全部保持不变：

- 只适用于 `role === 'system'`，并且必须是 `messages` 中的第一条消息；
- content 是 1–2 个文本块。每个块的键只能是 `type/text`，或者 `type/text/cache_control`；
- 整个请求最多一个 `cache_control`，值必须完全等于 `{"type":"ephemeral"}`（不能带 `ttl`，不能有其他键）；
- 带标记时，`identity.providerLimits.cacheWriteUsdPerMillion` 必须存在，并且已有的
  `openRouterBound(...).upperUsd === identity.upperUsd` 检查已经按写入价算过上界。adapter 自己独立复核这一点，
  不依赖 Runtime 的判断。

继续拒绝：顶层 `cache_control`（Anthropic 自动缓存会把标记放到最后一个块，也就是当前 user 消息，每轮都写、
下一轮读不到）；user、assistant、tool 消息和工具定义上的标记；`ttl:"1h"`；两个及以上标记；`cache_control`
出现在 `requestFields` 里。B 阶段如果需要更多位置，再单独评审。

### 3.4 冻结字节和 requestHash 兼容

- 没有 `promptCache` 的执行（所有旧执行和不满足条件的新执行）：`openRouterRequestBody` 不进入新分支，
  输出和 `f9afd0db` 逐字节相同。重放时 `runtime_response` 用同一个 `requestHash` 查到原来的响应。
- 有 `promptCache` 的执行：重放时从同一冻结上下文重新算出相同的切分，`requestHash` 一致。
- 旧测试窗口的报价没有 `cacheWriteUsdPerMillion`：`openRouterBound` 结果不变，`stagingPolicy` 的
  `RUNTIME_STAGING_QUOTE_CONFLICT` 校验和 SQL 中 `providerLimits` 的整对象比较都不受影响；新准入也不会冻结
  `promptCache`。
- 必测项中包含：用 #497 测试夹具覆盖每一种 `PROVIDER_REQUEST_FORMATS`，比较改动前后的请求字节和哈希
  （作为"黄金字节"测试）。

## 4. 计费

### 4.1 现行 BILL2 上界（PAYG 之前）

`openRouterPolicy.ts:openRouterBound`：

```
现在：upper = ceil((prompt × contextTokens + completion × maxOutput) / 1e6) + request
改后：inputRate = cacheWriteUsdPerMillion 存在 ? max(prompt, cacheWriteUsdPerMillion) : prompt
      upper = ceil((inputRate × contextTokens + completion × maxOutput) / 1e6) + request
```

- `openRouterLimits` 是 strict schema，加一个可选字符串字段，用现有的 `decimal()` 做精确计算。
- 这个字段表示"写入缓存的 1 个 token 实际要付的总单价"。Anthropic 取目录的 `input_cache_write`（已经是 1.25 倍
  总价）；OpenAI 取 `input_cache_write`；Gemini 以后启用显式缓存时取 `prompt + input_cache_write`（存储费是额外加的）。
  这条换算规则写在代码注释和测试里。
- `max_price` 路由只约束 prompt/completion/request 三项，不包括缓存价格，保持不变。防止超额靠两点：
  `only:[单一线路]`、`allow_fallbacks:false` 锁定线路；结算时如果实际费用超过上界，SQL 会把回执标为冲突
  （0105 第 261 行 `cost > c.upper_usd`）。**正因为有这一条，上界必须先把写入溢价算进去，否则一次正常的缓存写入
  就可能被当成异常回执。**
- 积分冻结 `aggregateCredits(upperUsd, q, m)` 的写法不变，只是 upperUsd 变大。以 Sonnet 为例，context 部分的单价
  从 2 变成 2.5，单次冻结额相应提高。这在 PAYG 之前的 staging 测试窗口中可以接受。

### 4.2 实际扣费

- 继续使用 `openRouterEvidence` 取得的 `usage.cost`（官方实际扣费总额，已经包含缓存读取折扣和写入溢价），
  不需要改。不用 `cache_discount` 或 token 数自己重算金额。
- usage 原样保存在回执里（`usage.sdkResponse.usage`，包括 `prompt_tokens_details`），对账和验收直接读取，不新建表。
- 验收需要实测确认（第 5 节）：每次调用的 `usage.cost` 等于按 token 数和冻结单价算出的金额；
  `prompt_tokens` 包含 cached 和 write 两部分。确认之前，这两点只是依据文档的判断。

### 4.3 需要 #553（BILL-PAYG）修改的地方（只列出，不改那个 PR）

1. 第 35 行的基础公式 `U=(T×输入最高单价+O×输出最高单价)/10^6+固定费用`：把"输入最高单价"明确定义为
   `max(普通输入价, 5 分钟缓存写入价, 适用的长上下文档位价)`。这对所有有写入费的线路都适用，**包括不加标记的
   GPT-6 Luna 自动写入**；"缓存折扣不提前抵减"保持不变。
2. 冻结报价和派生报价（第 243–248 行）要带上 `cacheWriteUsdPerMillion` 及其来源和版本，和本方案的
   `providerLimits` 字段使用同一个名字和同一套计算方法，避免两套上界算法。
3. 准入实测（第 59–62 行）：样本要包含带缓存标记的请求。P 取官方 `prompt_tokens`（包含 cached 和 write），
   rB 和 rT 的阈值不变。另外记录 cached 和 write 的 token 数。#561 的无缓存样本不能代表写入溢价已经覆盖。
4. 异常（第 81 行）：c > U 时记 `budget_conflict` 的规则不变。只要按第 1 条定义 U，正常的缓存写入不会触发它。
5. 实际费用 `c_i` 使用包含缓存效果的 `usage.cost`。第 111 行的价格示例应注明"未计缓存写入"，
   或改用写入价重新算出 Sonnet 54、Gemini 21 积分这两个 G 示例。
6. Luna 的长上下文档位（超过 272000 token 价格翻倍）：如果 T 可能超过这个阈值，上界要用高档价格，
   或者把 T 限制在阈值以下。这和缓存无关，是在核对时一起发现的。

### 4.4 需要 #565（BILL-UNIT）修改的地方（只列出）

1. 第 94 行"reasoning、缓存……是否已包含需有完整语义"：补充说明 OpenRouter `usage.cost` 已包含缓存读取和写入，
   不能再另外加或减缓存金额（以第 5 节的对账结果为准）。
2. `C=ceil(q×Σ(U_i×m_i))` 中的 U_i 是包含缓存效果的实际费用，加价倍数作用在折扣后的成本上，
   缓存节省直接体现为用户少扣积分，这符合 Owner 的原话。
3. 财务明细（第 44–46 行）：建议在 call 明细中显示 cached 和 write token 数，用于按模型对账缓存效果。
   这只是展示，数据来自现有回执，不新建账。

## 5. 验收（合入 staging 后执行；本节只是建议，未获批准，现在不执行）

在真实产品路径上测试：staging 定位导师页面，使用测试身份，由 Codex 做交互验证（按全局分工）。真实费用
由 BILL2 冻结和结算。执行前需要两项 Owner 批准：(a) 用带 `cacheWriteUsdPerMillion` 的报价新建或替换 staging
测试窗口（这是 staging 数据/配置变更）；(b) 下表中的次数和金额。

| 组 | 内容 | 次数上限 | 单次上限 | 金额上限 |
| --- | --- | ---: | ---: | ---: |
| Sonnet 5.5 + 显式缓存 | 4 段对话 × 6 轮导师（同一步骤内连续 4 轮，至少 1 次间隔超过 5 分钟，至少 1 次换步骤） | 24 | $0.32 | $7.68 |
| Gemini 3.8 Flash 隐式缓存 | 同样的 4 段 × 6 轮 | 24 | $0.11 | $2.64 |
| GPT-6 Luna 附带整理 | 每轮最多 1 次 | 48 | $0.006 | $0.29 |
| 合计 | | **96** | | **$10.61** |

单次上限的算法沿用 #561：Sonnet 按 90000 字节输入 × 写入价 2.5 + 8192 输出 × 10，约 $0.31，取 $0.32；
Gemini 输入价 0.75 加 5 分钟存储费 0.0417，约 $0.10，取 $0.11（为以后可能开显式缓存留出空间）；
Luna 按 #561 的 $0.006。按 #561 的情景估算，实际花费预计远低于上限。不重试、不补样本，结果不明就停。
第一次 Sonnet 调用同时用来确认 OpenRouter 在 `require_parameters:true` 下接受 `cache_control`：如果返回 404
或拒绝（AC-0 曾因为 `parallel_tool_calls` 出现全线路 404），立即停止并报告。

记录的证据：每次调用的 `prompt_tokens`、`cached_tokens`、`cache_write_tokens`、`usage.cost`、冻结 `upperUsd`、
首字时间、轮次间隔、是否换步骤、开场轮还是后续轮。未缓存时的对照费用用 `prompt_tokens × 输入价` 计算，
并和 #561 的无缓存端到端结果对比，不再单独跑一组无缓存对照。

通过标准：

1. 带标记的请求被拒绝 0 次，回执冲突 0 次，所有调用 `usage.cost ≤ upperUsd`；
2. 每次调用的 `usage.cost` 与按 token 数和冻结单价算出的金额一致（允许官方取整），`prompt_tokens` 包含 cached 和 write；
3. Sonnet：同一步骤、非开场、间隔不超过 5 分钟的轮次中，至少 90% 的轮次 `cached_tokens ≥` 可缓存前缀 token 数的 90%；
   写入只发生在每段的第一轮、换步骤、超时和开场后第一轮；
4. Gemini：报告隐式命中率和节省比例，**不设通过门槛**。如果低于 50%，作为启用 Gemini 显式标记的依据另行报告；
5. 抽查 6 条回复，质量与 #561 同题无缓存回复没有明显差异（文字相同，只是切成两块，预期不会变化）。

## 6. 风险、回退、必测项、为什么是最小改动

### 6.1 风险

| 风险 | 处理 |
| --- | --- |
| OpenRouter 因 `require_parameters` 拒绝带标记的请求 | 验收第一次调用就能发现，发现即停；必要时另行评审 |
| 上界没算写入溢价，导致回执冲突 | 第 4.1 节的公式加上单元测试（边界值 +1） |
| 前缀切分和实际 system 内容不一致 | 发送前用冻结 sha256 校验，不一致就在 claim 前失败，不产生费用 |
| 缓存效果不如预期（③ 变化、换步骤、开场轮工具不同、5 分钟过期） | 验收量化；B 阶段再考虑调整结构或用 1 小时 TTL |
| 隐私 | 缓存前缀只有 Skill 和固定规则，不含用户数据；Anthropic 缓存按组织隔离，5 分钟过期 |
| 写入溢价让单次冻结额变大 | 只影响 PAYG 前的 staging 测试窗口；PAYG 后由余额封顶冻结决定（#553） |

### 6.2 回退

- 最快的方法：新的测试窗口或报价不带 `cacheWriteUsdPerMillion`，新准入就不再冻结 `promptCache`，不需要发版。
- 代码回退：只删除 admission 中设置 `promptCache` 的部分；`providerRequest`、adapter 和上界中对旧字段的支持
  必须保留，保证已冻结的带缓存执行仍能重放和结算。
- 不涉及数据库迁移，没有数据需要回滚。

### 6.3 必测项

1. 黄金字节：所有格式、没有 `promptCache` 时，请求字节和 `requestHash` 与 `f9afd0db` 相同；
2. `openRouterBound`：没有新字段时结果不变；写入价低于、等于、高于输入价三种情况；精确小数；
   `stagingPolicy` 的报价冲突检查；
3. `openRouterRequestBody`：正常切分；前缀为空；整个 system 都是前缀；哈希不一致；system 不在第一条；
   整理和匹配阶段不加标记；
4. adapter：唯一允许的形状通过；其他位置、两个标记、带 `ttl`、顶层标记、user 消息上的标记、没有写入价时带标记，
   全部返回 `BILL2_PROVIDER_REQUEST_DENIED`，并且在凭据读取和发送之前就失败（transport 调用 0 次）；
5. admission：只有 anthropic + 有写入价 + skill 主对话才冻结；导师轮的前缀长度等于 Skill 加固定开头；重放走冻结值；
6. 现有 Runtime 和 BILL2 集成测试（`--runtime-only`、`--bill2-core-only`）在 CI 中通过；
7. 合入后，由 Codex 按第 5 节做 staging 交互验证（需要先获批准）。

### 6.4 为什么是最小正确改动（AGENTS 第 5 节）

- 考虑过的现有机制：冻结上下文（`sourceHash`）、`openRouterRequestBody` 唯一的转换点、adapter 白名单、
  `providerLimits` 报价和 `openRouterBound`、回执中的 usage 和 `usage.cost`、SQL 的 `cost > upper_usd` 冲突检查。
  这些机制已经能满足需求，缺少的只有三点：在一个位置加标记的规则、adapter 接受这个标记、上界计入写入价。
- 不新建表、迁移、RPC、服务、队列、配置项或框架。改动的代码文件是 `openRouterPolicy.ts`、`openRouterAdapter.ts`、
  `providerRequest.ts`、`admission.ts`、`execute.ts`（context schema），以及 `opc/agentTurnPrompt.ts`、`opc/service.ts`
  （导出固定开头长度并传入），另加测试。
- 权威来源不变：报价仍以冻结的 `providerLimits` 为准；实际费用仍以 OpenRouter 回执为准；是否加标记由冻结上下文决定。
- 不使用"最后一个块"的顶层自动缓存，也不给历史加标记：这两种做法按第 1.3 节的分析会多付写入费，
  不符合"最小且正确"。

## 7. 实施顺序（写入方由总控确定）

A 阶段（本方案范围，一个 high PR，目标 staging）：

1. `openRouterLimits` 增加可选的 `cacheWriteUsdPerMillion`，修改 `openRouterBound`，加测试；
2. 增加冻结上下文 `promptCache`，修改 admission 和 opc 服务传入前缀长度，加测试；
3. 在 `openRouterRequestBody` 中切分 system，加测试；
4. adapter 增加最小例外，加测试；黄金字节测试；
5. CI 全绿 → 总控审 → 独立审查 → Owner 批准合并（high）→ Owner 批准第 5 节的测试窗口和预算 → Codex 执行验收。

B 阶段（按验收数据再决定，不在本方案范围）：把 ③ 移到历史之后，并在历史上加标记；Gemini 显式标记；1 小时 TTL；
整理模型的缓存键。每一项都需要单独的方案和导师质量评测。
