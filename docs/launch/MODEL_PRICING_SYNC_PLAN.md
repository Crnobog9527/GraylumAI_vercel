# MODEL-PRICING-SYNC 实施方案：模型价格从 OpenRouter 自动读取

- 任务：MODEL-PRICING-SYNC。风险：**high**（计费：调用前冻结上限、OpenRouter `max_price`、后台价格来源）。
- 本文只是方案，未获批准前不写代码、不改配置、不应用迁移、不发真实模型请求。
- 基于 staging `7909c118`（BILL-UNIT #565 已于 2026-10-02 06:59 UTC 合并：倍数、q、第三方价格）。其他相关 PR：
  BILL-PAYG #553（边用边扣，仅方案）、PROMPT-CACHE #572（已合并，仅方案）、RATE-LIMIT #573（已合并，仅方案）。

## 0. 给 Owner 看的（白话）

**现在的问题**：后台"添加/编辑模型"要手填"输入成本、输出成本"，还分成"≤200K / >200K"两档。
现在多数模型只有一个价，有的模型分档的位置也不是 200K（GPT-6 Luna 是 27.2 万，Qwen 3.7 Flash 有 3.2 万和 25.6 万两档），
有的模型按时段变价（DeepSeek V4 Pro 有高峰和低谷价）；而且手填表格没有"缓存写入"这一项。手填既容易错，也跟不上供应商调价。

**改完以后你会看到**：

1. 添加模型时只填"模型 ID"，点"从 OpenRouter 读取"，系统列出这个模型的所有线路和每条线路的价格，你选一条线路保存。
2. 价格区变成**只读**，照搬 OpenRouter 的结构：输入、输出、缓存读取、缓存写入、思考、联网搜索，有分档就显示
   "输入超过 27.2 万 token 时：……"，不再写死两档。旁边显示"读取时间"和"已经过了几天"。
3. 同一页显示这个模型的加价倍数（#565 做的那块），以及"用户实际大约付多少积分"的换算。
4. 价格过旧（建议超过 7 天）时，页面变黄提醒，新的调用会被拒绝，点一下"重新读取"就恢复。
5. 如果 OpenRouter 涨价：系统**不会自动跟着提高上限**。已批准的报价会被拦下，需要重新批准；
   OpenRouter 那边也会因为我们设置的最高价，直接拒绝按新价调用，不会产生费用。
6. 用户最终扣多少，仍然按 OpenRouter 实际收的钱（已经包含缓存折扣）乘倍数算，这一点不变。

**需要你决定的事**见第 9 节，每项都有推荐答案；不想细看可以直接回复第 9 节末尾那句话。

## 1. 现状核对（证据）

### 1.1 新 Runtime / BILL2 已经不读手填价格

- 调用前的上限和 `max_price` 只来自每次调用冻结的 `providerLimits`
  （`packages/api/src/services/bill2/openRouterPolicy.ts:7-11`：`providerSlug`、`contextTokens`、
  `promptUsdPerMillion`、`completionUsdPerMillion`、`requestUsd`）。
  `openRouterBound` 按 `prompt × contextTokens + completion × maxOutput` 向上取整加 `request` 得到上界，
  同时生成 `only:[线路]`、`allow_fallbacks:false`、`max_price:{prompt,completion,request}`（同文件 26-37 行）。
- `providerLimits` 冻结在 staging 测试窗口 `runtime_test_windows.call_policies`
  （`packages/db/migrations/0108_runtime_staging_window.sql:8-16`）。这张表对 anon / authenticated / service_role
  都撤销了权限，窗口行由总控在 Owner 批准后用 SQL 写入；SQL 准入按**整对象相等**匹配报价（同文件 40-44 行），
  `stagingPolicy.ts:33` 再复核 `openRouterBound(...).upperUsd` 等于冻结的 `upperUsd`。
  也就是说，**现在窗口里的单价也是人工抄进 SQL 的**，只是不在后台表单里。
- 实际扣费用 OpenRouter 回执的 `usage.cost`（`openRouterEvidence.ts`），结算时若实际费用超过上界，
  SQL 把回执标为冲突（0105 第 261 行 `cost > c.upper_usd`，见 PROMPT_CACHE_PLAN 第 4.1 节）。
- 准入时 Runtime 已经读取 `ai_models.config.reasoning`，并要求它的 `route` 等于报价的 `providerSlug`
  （`services/runtime/reasoningAdmission.ts:24`），即 MODEL-REASONING 已经把"后台选的线路"和"窗口报价线路"绑在一起。

### 1.2 已经有一个从 OpenRouter 读目录的功能，只差价格

- `packages/api/src/services/models/openRouterCatalog.ts`：`readOpenRouterCatalog(model)` 用公开、不带密钥的
  GET 同时读 `/api/v1/models` 和 `/api/v1/models/{作者}/{名称}/endpoints`，有 15 秒超时、8 MB 上限、
  `redirect:'error'`，任何格式异常整体失败、不保存半份快照。
- 结果存为 `ai_models.config.reasoning.catalog`（`shared/modelReasoning.ts:43-73`：`fetchedAt`、`model`、
  `reasoning`、`endpoints[]{tag, providerName, supportedParameters, contextLength, maxCompletionTokens}`），
  由后台 `modelReasoning.refreshCatalog`（`routers/modelReasoning.ts:85-96`）触发；页面入口是模型页的
  `ModelReasoningDialog`。**端点返回里的 `pricing` 目前被丢弃。**
- 线路用完整 tag（例如 `deepinfra/fp8`、`google-vertex/global`），这是仓库现有约定（MR-1/MR-2）。

### 1.3 手填价格列的读者

见第 6 节表格（逐文件核对结果）。

### 1.4 OpenRouter 公开目录实测（2026-10-02 06:56 UTC，一次匿名 GET，未调用任何付费接口）

`GET /api/v1/models` 返回 464 个模型（响应 762,784 字节，sha256 `18a7f5bb…10fa`）。各价格字段出现次数：
`prompt` 464、`completion` 464、`input_cache_read` 300、`web_search` 177、`input_cache_write` 94、
`overrides` 80、`input_cache_write_1h` 33、`internal_reasoning` 31、`image` 30、`audio` 33、
`input_audio_cache` 28、`image_output` 9、`audio_output` 2；**没有任何模型带 `request` 字段**。
端点价格另有 `discount` 字段（含义见第 3.5 节）。价格单位是"美元 / 每个 token"的十进制字符串。

我们在用或准备用的 5 个模型（线路取各自 `/endpoints` 的值，单位已换成美元 / 百万 token）：

| 模型 | 线路示例 | 输入 | 输出 | 缓存读 | 缓存写 | 其他 |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| `anthropic/claude-sonnet-5.5` | `anthropic` | 2 | 10 | 0.2 | 2.5（1 小时 4） | 联网 $0.01/次 |
| `google/gemini-3.8-flash` | `google-vertex/global` | 0.75 | 3.75 | 0.075 | 0.0416666666666667（存储费，另加） | 思考 3.75；`discount` 0.5 |
| `openai/gpt-6-luna` | `openai` | 0.1 | 0.5 | 0.01 | 0.125 | **≥272,000 输入 token：输入 0.2、输出 0.75、读 0.02、写 0.25** |
| `deepseek/deepseek-v4.1-flash` | `deepinfra/fp8` | 0.14 | 0.42 | 0.0042 | — | `discount` 0.3 |
| `qwen/qwen3.8-27b` | `wafer` | 0.0248 | 4.35 | 0.0198 | — | 有 1 条线路 status=-2 |

另外观察到、方案必须处理的形状：

- **多档**：`qwen/qwen3.7-flash` 有 `min_prompt_tokens` 32,000 和 256,000 两档。
- **按时段变价**：`deepseek/deepseek-v4-pro-0813` 的 `overrides` 用 `utc_days`、`utc_start`、`utc_end`
  表示周末和工作日不同时段的价格。
- **同一模型下线路 tag 重复**：`deepseek/deepseek-v4.1-flash` 的 `/endpoints` 里 `baseten/fp8` 出现两次
  （本次两条价格相同）。tag 不能直接当唯一键。
- **同一线路名在不同地区价格不同**：Sonnet 5.5 的 `google-vertex/global` 是 2，`google-vertex/us` 是 2.2。
- Gemini 的缓存写入价有无限小数，换成百万 token 后是 0.0416666666666667，超过现有 `decimal()` 的 12 位小数。
- OpenRouter 文档：`provider.max_price` 只接受 `prompt`、`completion`、`request`、`image`（美元 / 百万 token 或每次），
  **不覆盖缓存写入、分档价和联网搜索**；没有线路满足时请求直接不执行
  （[provider selection 文档](https://openrouter.ai/docs/guides/routing/provider-selection)）。

## 2. 目标与不做的事

目标：调用前用到的所有单价（冻结上限、`max_price`、窗口报价、以后正式环境的报价）都从**同一份
OpenRouter 价格快照**按**同一个函数**推导，后台不再有手填成本；实际扣费仍是 OpenRouter `usage.cost`。

不做：不改 #565 的 q / m 公式和取整；不改 #553 的 PAYG 算法（只提供它要的单价）；不做第三方
搜索服务价格（那是 #565 的 `billing_provider_prices`）；不加定时任务；不在调用时实时请求 OpenRouter 目录；
不决定正式环境报价的审批流程（RUNTIME-PROD ①），只规定它必须用本方案的快照和推导函数。

## 3. 设计

### 3.1 快照放在哪里：复用现有目录读取和 `ai_models.config`，不新建表

**做法**：现有 `refreshCatalog` 已经读回每条线路的 `pricing`，只是丢掉了。改为在同一次读取里，把价格存成
`ai_models.config.pricing`（和 `config.reasoning` 并列的一个键）：

```
config.pricing = {
  fetchedAt, model,                 // 与同一次写入的 config.reasoning.catalog 完全相同
  source: "openrouter:/api/v1/models/{model}/endpoints",
  pricingHash,                      // 规范化后全部线路价格的 sha256
  endpoints: [ { tag, pricing } ]   // 最多 64 条，与目录快照的线路一一对应
}
```

为什么不直接加进 `config.reasoning.catalog.endpoints[]`：现有 `catalogSnapshot` 是 `.strict()`，一旦回退到旧版本，
带价格的目录会被判为无效，导致思考设置和 Runtime 准入（`RUNTIME_REASONING_CONFIG_INVALID`）一起失效。
放在并列的键里，旧代码只读 `config.reasoning`，回退是干净的。代价是两处要保持一致：同一次写入、相同 `fetchedAt`
和 `model`，推导时校验两者一致且 `model` 等于当前行的 `model_id`（改过模型 ID 的行必须重新读取）；
`services/models/modelConfig.ts` 的 `withStoredReasoning`（`routers/model.ts:389,456` 在编辑通用配置时用它保住
`reasoning`）同样要保住 `pricing`。

每条线路的 `pricing` 保持 OpenRouter 的形状，只做规范化，不压成两档：

```
pricing: {
  base: { prompt, completion, inputCacheRead?, inputCacheWrite?, inputCacheWrite1h?,
          internalReasoning?, webSearch?, request?, image?, audio?, ... }   // 美元/百万 token（或每次），十进制字符串
  overrides: [ { when: { minPromptTokens? , utcDays?, utcStart?, utcEnd? }, prices: {同上的子集} } ]  // 最多 16 条
  discount: string | null      // 原样记录，不参与计算
  unknownKeys: string[]        // 目录里出现、但本版本不认识的价格字段名
  raw: object                  // OpenRouter 原始 pricing 对象（字符串原样），只供核对
}
```

- 单位换算：OpenRouter 字符串 × 1,000,000 用十进制移位完成（不经过浮点）；超过 12 位小数的**向上取整到 12 位**
  （和 `bill2/decimal.ts` 精度一致，与 PROMPT_CACHE_PLAN 第 4.1 节对 Gemini 的规定相同），原始字符串另存一份
  `raw` 供核对。
- 重复 tag：价格完全相同则合并；不同则这条 tag 标为"价格不唯一"，不能被选为线路。
- 只读、不可手改：没有任何接口能单独写 `pricing`；唯一写入路径是"重新读取"，每次整体替换成新快照（新 `fetchedAt`、
  新 `pricingHash`）。历史价格的权威记录在已冻结的报价里（窗口 `call_policies`、`bill2_runs.payload.callPolicy`、
  `bill2_calls.payload.providerLimits`），不在 `ai_models` 里另存历史。
- "重新读取"的写入改为带 `updated_at` 防覆盖（和 #565 `modelPricing` 一样），现有 `writeReasoning` 只是读后写，
  慢请求期间别人改过配置会被覆盖。
- 重新读取时服务端把新旧快照逐线路逐字段比较，结果返回给页面（"输入 2 → 2.2，上涨"）并写一条结构化日志
  `model_price_snapshot_changed`（模型、线路、字段、旧值、新值、新旧 hash），不建历史表。

**为什么不新建表或新列**（AGENTS.md 第 5 节）：

- 已考虑的现有机制：`ai_models` 手填整数列（单位是微美元，只有两档、不能表示 0.0416666…，也没有缓存字段，
  结构上装不下）；#565 的 `billing_provider_prices`（为第三方非 token 计价服务设计，按供应商 / SKU 版本化，
  不适合放 OpenRouter 的 token 价格，混在一起会出现两套模型价格来源）；现有目录读取和 `ai_models.config`
  （同一次读取、已有 fetchedAt、已有线路列表、准入已在读同一行的 config）。
- 最小缺口：把已经读回来的 `pricing` 存下来，并提供一个推导函数。
- 不需要迁移：`config` 是 jsonb；没有 `config.pricing` 的行视为"未读取价格"。
- 权威来源：OpenRouter 目录 → 快照（唯一的调用前价格来源）→ 冻结报价（每次调用的唯一依据）。
  手填列不再是任何新路径的来源。

### 3.2 后台"添加 / 编辑模型"

模型页（`apps/web/src/app/admin/models/page.tsx`，906 行，在代码大小基线上限，只许变小）：

1. 表单删除"Token 成本设置"整块（约 90 行，第 749-840 行附近）和对应 `formData` 字段；保存不再提交这 5 个字段。
   页面行数因此下降，基线一起调低。
2. 新增只读组件 `ModelPriceSnapshotPanel`（`apps/web/src/components/admin/`），放在每个模型的编辑对话框里，取代
   被删掉的成本表单，模型页只加一个挂载行。#565 的倍数面板 `ModelMultiplierPanel` 是页面底部的全站列表
   （`page.tsx:599`），保留不动；价格面板里同时显示这个模型的生效倍数，并提供跳到倍数面板的链接：
   - 顶部：模型 ID、已选线路、读取时间、距今多久、来源、`pricingHash` 前 8 位；"从 OpenRouter 读取"按钮
     （调用扩展后的 `refreshCatalog`，思考档位和价格一次读完）。
   - 已选线路的价格表：只列快照里实际出现的字段，单位"美元 / 百万 token"；分档逐条显示条件
     （"输入 ≥ 272,000 token""周六、周日""工作日 UTC 01:00–04:00"）；`discount` 和不认识的字段原样列出并标注
     "不参与计算"。
   - "冻结用单价"一行：显示第 3.3 节推导出的输入最高单价、输出最高单价及来源（例如"取缓存写入 2.5"、
     "取 ≥272K 档"），让管理员看到上限是怎么来的。
   - 用户价预览：`单价 × 生效倍数 m × q`（#565 的值），写明"仅供参考，实扣按实际费用"。
   - 其他线路折叠列表（价格、上下文长度、状态），供选线路时对比；"价格不唯一"的线路在线路选择里不可选。
   - 状态提示：未读取价格、快照超过时限（第 3.4 节）、已选线路在新快照里消失或价格不唯一。
3. 添加模型：先建行（模型 ID），再读取目录、选线路。没有价格快照或没有选线路的模型可以保存，但不能被 Runtime
   准入（第 3.4 节），页面明确提示。线路仍在现有 `ModelReasoningDialog` 里选（同一个 `route` 字段），
   不新增第二个线路选择。
4. 新组件放在独立文件里；后端路由不写进 `routers/model.ts`（514 行，在基线上限），扩展 `routers/modelReasoning.ts`
   的 `refreshCatalog` / `get`，或参照 #565 单独加一个很薄的只读 `modelPriceSnapshot` 路由。

### 3.3 从快照推导冻结单价（唯一的推导函数）

新增纯函数 `deriveOpenRouterLimits(snapshot, route, { contextTokens, outputLimit, promptTokensUpper })`，
放在 `packages/api/src/shared/` 或 `services/bill2/`，Runtime 准入、后台显示和生成窗口报价都调用它。

输入最高单价（与 #572 第 4.3 节、#553 第 2 节已定的定义一致）：

```
对每个"适用的价格层"L（基础价 + 所有适用的 overrides）：
  写入价(L) = inputCacheWrite 是"总价"   ? inputCacheWrite
            : inputCacheWrite 是"附加费" ? prompt + inputCacheWrite（向上取整到 12 位）
            : 无写入价                   ? 0
  输入(L)   = max(prompt, 写入价(L))
  输出(L)   = max(completion, internalReasoning ?? 0)
输入最高单价 = max over L 输入(L)；输出最高单价 = max over L 输出(L)
```

- **适用的价格层**：
  - `minPromptTokens`：当 `promptTokensUpper ≥ minPromptTokens` 时适用。现在 `promptTokensUpper = contextTokens`
    （整个上下文都预留），所以 Luna、Qwen 的高档都适用；PAYG 后改为 #553 的 `T = B + K + M`，T 低于阈值才用低档。
  - `utcDays` / `utcStart` / `utcEnd`：一律适用（调用可能跨过时段边界），即冻结时取所有时段中最高的价。
  - `when` 里出现不认识的条件键：整条线路**不可准入**，不猜。
- **缓存写入是"总价"还是"附加费"**：Anthropic、OpenAI、Qwen 的 `input_cache_write` 是写入 token 的总单价
  （都高于普通输入价）；Gemini 的是 5 分钟存储费，需要加在输入价上（#572 第 4.1 节）。规则：作者是 `google/`
  的按附加费；其他作者若写入价低于输入价，也按附加费处理（保守，算高不算低）；写入价不低于输入价按总价。
  这条规则写在代码注释和测试里。
- **1 小时缓存写入**：Runtime 现在只发 5 分钟缓存标记（#572）。请求里出现 1 小时标记时必须把
  `inputCacheWrite1h` 纳入输入最高单价，否则拒绝发送；首版不发。
- **思考 token**：`internal_reasoning` 存在时与 `completion` 取大。这只在思考 token 计入 `outputLimit` 时成立；
  不计入的情况按 #553 第 2 节要求另设硬上限 R 并逐项加，本任务不放宽这条。
- **联网搜索、图片、音频**：Runtime 首版是纯文本、`network:'deny'`、关闭搜索插件（0108 准入要求），
  这些价格只保存和显示，不进上限。以后开启某一项时，必须同时把对应单价 × 次数上限加进上限，否则拒绝。
- **`request`**：目录目前没有这个字段，缺省为 `"0"`；出现时照实计入。
- **`discount`**：只记录，不参与计算（第 3.5 节）。
- **不认识的价格字段**（`unknownKeys` 非空）：显示出来；首版**仍允许**准入，前提是请求类型不会用到它
  （纯文本）。是否改为一律拒绝，见第 9 节 D5。

输出给 BILL2 的 `providerLimits`（向后兼容扩展 `openRouterLimits`）：

```
{ providerSlug, contextTokens, promptUsdPerMillion, completionUsdPerMillion, requestUsd,   // 现有字段：基础价，用于 max_price
  cacheWriteUsdPerMillion?,                                                               // #572 已定名字和含义
  boundInputUsdPerMillion?, boundCompletionUsdPerMillion?,                                // 新增：上面推导的最高单价
  priceSnapshot?: { fetchedAt, pricingHash } }                                            // 新增：来源，便于对账
```

- `openRouterBound` 改为：有 `boundInput/boundCompletion` 时用它们算上界，没有时退回现有算法（旧窗口和旧回执不变）；
  #572 的 `cacheWriteUsdPerMillion` 仍保留并参与同一个 max（两者取大，保证只有一套算法）。
- `max_price` 仍用基础的 `prompt` / `completion` / `request`：作用是"线路挂牌价比快照高就不执行"，
  这是调用时唯一的实时涨价保护。分档后的实际单价能否通过基础价的 `max_price`，OpenRouter 文档没写，
  列为第 7 节必测项；不通过时改为 `max_price` 取分档最高价（仍不超过上界）。
- `contextTokens` 取所选线路的 `contextLength`（真实能力，#553 要求不为改变收费而人为改小）；
  仍须满足现有 `ai_models.input_limit ≥ contextTokens`。
- 冻结报价整体放进 `bill2_calls.payload`，新增字段约 150 字节，远低于 65,536 字节上限；测试覆盖。

### 3.4 准入时的价格检查、过期和涨价

新增 `pricingAdmission.ts`（与 `reasoningAdmission.ts` 并列），真实窗口的每次新准入：

1. 读取当前模型行的快照，按窗口报价的 `providerSlug` 找到线路；没有快照、没有价格、线路消失或价格不唯一 → 拒绝
   `RUNTIME_PRICE_SNAPSHOT_MISSING`。
2. 快照 `fetchedAt` 超过时限 → 拒绝 `RUNTIME_PRICE_SNAPSHOT_STALE`（中文："模型价格太久没更新，请在后台重新读取"）。
   推荐时限 7 天（D1）。
3. 用当前快照重新推导报价，与窗口里冻结的报价比较价格字段：
   - 完全相同 → 通过（只是重新读取、价格没变，不影响窗口）。
   - **任一单价上涨 → 拒绝** `RUNTIME_PRICE_INCREASED`，提示"供应商涨价，需要重新批准报价"。系统永远不会自动提高上限。
   - 只有下降 → 按 D2 处理（推荐：继续用旧的、偏高的冻结报价，直到重新批准；实扣仍按实际费用，用户不吃亏）。
4. 已开始的 run 和恢复、重放不受影响：它们只用自己冻结的报价，不重新读快照（和 MR-2 的冻结规则一致）。

为什么调用时不实时查 OpenRouter：会给每次调用增加一个外部依赖和延迟；实时涨价已由 `max_price` 在 OpenRouter
那边拦截（不产生费用）；`max_price` 覆盖不到的缓存写入和分档价，由过期时限 + 结算时 `cost > upper_usd`
冲突检查兜底（冲突时平台承担差额，按 #553 规则停止新派发）。

不加定时刷新（不新增 cron）：管理员点按钮即可；过期会在页面和准入两处提示。是否要自动刷新见 D4。

### 3.5 `discount` 字段

端点价格带 `discount`（Gemini 0.5、DeepSeek `deepinfra/fp8` 0.3），文档未说明挂牌价是折前还是折后。
处理：只记录、不参与计算，冻结按挂牌价。若挂牌价是折前价，实际扣费更低，上限偏高但安全；若是折后价且折扣到期，
挂牌价上涨会被 `max_price` 和第 3.4 节拦下。第一次经批准的 staging 小额对账时核对 `usage.cost` 与挂牌价的关系。

### 3.6 测试窗口和以后的正式环境怎么用

- **staging 测试窗口**：窗口仍由总控在 Owner 批准后用 SQL 新建（不改 0108 的权限设计）。变化是窗口报价不再手抄：
  后台面板提供"复制报价 JSON"（由 `deriveOpenRouterLimits` 生成，带 `fetchedAt` 和 `pricingHash`），
  总控把它原样放进窗口 SQL；准入第 3 步保证两者一致。建窗口前 24 小时内必须重新读取一次。
  #565 合并后窗口条目还带每个模型的 `multiplier`（必须等于当时配置，`assertWindowMultipliers`），这部分仍按 #565 的规则
  取值；"复制报价 JSON"只负责 `providerLimits` 和 `upperUsd`，不生成倍数。
- **v1 旧窗口**（报价没有新字段）：`openRouterBound` 结果不变；第 3.4 节检查对它们照样生效（基础单价比较），
  旧窗口的价格若和当前快照不同会被拦下，需要新窗口。合并前列出当时有效窗口，由总控决定是否一起换。
- **正式环境（RUNTIME-PROD ①）**：报价审批机制由 RUNTIME-PROD 设计，本方案只约束：报价必须由
  `deriveOpenRouterLimits` 从快照生成，带来源和 hash；准入走同一个 `pricingAdmission`；涨价拒绝、过期拒绝规则相同。

## 4. 与 #565、#572、#553 的关系

| 来源 | 本方案怎么对齐 |
| --- | --- |
| #565 BILL-UNIT | 不碰 q、m、`price_multiplier`、`billing_provider_prices` 和 `C = ceil(q × Σ(U_i × m_i))`。U_i 仍是 OpenRouter 实际费用。页面把价格面板放在倍数面板旁边，只读取 #565 的生效倍数用于预览。 |
| #572 PROMPT-CACHE | 沿用 `cacheWriteUsdPerMillion` 的名字和含义、Gemini 附加费换算和 12 位向上取整；本方案让这个值由快照自动生成，不再手填。 |
| #553 BILL-PAYG | 提供 #553 第 2 节"输入最高单价 = max(普通输入价, 5 分钟缓存写入价, 适用的长上下文档位价)"所需的数据；`promptTokensUpper` 参数就是 #553 的 T。第 7 节"稳定 quote policy"里的价格和来源就是本方案的快照字段。#553 的算法不在这里改。 |
| RATE-LIMIT #573 | 无交叉。 |

## 5. 实施拆分

| PR | 内容 | 风险 |
| --- | --- | --- |
| A | 新的严格 schema `pricingSnapshot`（`config.pricing`）；`readOpenRouterCatalog` 同一次读取里解析和规范化价格（十进制换算、重复 tag、overrides、unknownKeys）；`refreshCatalog` 同时写 `reasoning.catalog` 和 `pricing`，加 `updated_at` 防覆盖、新旧比较和日志；`withStoredReasoning` 保住 `pricing`；只读价格面板。不改任何收费路径 | high（只新增价格来源和显示，但属于计费数据；按 AGENTS.md 第 4 节保守按 high） |
| B | `deriveOpenRouterLimits`；`openRouterLimits` 增加可选字段，`openRouterBound` 使用推导单价；`pricingAdmission` 接入真实窗口准入；"复制报价 JSON"；stagingPolicy / SQL 整对象匹配随新字段自然生效（无 SQL 改动，需测试证明） | high（计费上界、准入） |
| C | 删除模型页"Token 成本设置"表单和 `routers/model.ts` / `admin.ts` 对 5 个手填列的写入；读者按第 6 节处理；列本身保留到 LEGACY-CLOSE | high（计费字段、旧链路） |

如果 PROMPT-CACHE 实现届时还没开始，B 按 #572 的名字一并加 `cacheWriteUsdPerMillion`，PROMPT-CACHE 直接复用；
两边不能各写一套 `openRouterBound`，由总控指定 `openRouterPolicy.ts` 的唯一写入方。

## 6. 手填价格列的读者：保留、迁移还是随 LEGACY-CLOSE 删除

核对结论（staging `7909c118`，只读代码）：

- 五个手填列都是 `integer`，单位是微美元：输入 / 输出是"每百万 token"，联网搜索是"每千次"
  （`packages/db/baseline/0000_core_prerequisites.sql:57-61`）。**仓库里没有任何 200K 分档计算**：两个
  `*_above_200k` 列只被后台写入、读出和显示，没有计费代码使用。
- 缓存价不是存的，而是旧计费代码写死的比例：写入 = 1.25 × 输入、读取 = 0.1 × 输入（`services/billing.ts:397-398`）。
- 新 Runtime / BILL2 不读这些列（第 1.1 节）。
- `/api/ai/stream` 已对新请求返回 410（`route.ts:272-274`），但 `billing.ts:getModelPricing` 还有 4 个**仍可调用**的入口：
  `routers/ai.ts:295`（`estimateCost`）、`services/agentSlice/admission.ts:38`、`services/agentSlice/accounting.ts:41`、
  `services/artifacts/generation.ts:283,291`（旧工作台生成）。它们都在 LEGACY-CLOSE 的删除清单里。

| 读者 | 读什么、做什么 | 处理 |
| --- | --- | --- |
| `routers/model.ts:293-297, 318-322, 355-359, 383-387`（`createModel` / `updateModel`） | 写入 5 列（美元 × 1,000,000） | **PR C 删除写入**；输入 schema 不再接受这 5 个字段 |
| `routers/model.ts:239, 253` | 后台列表读 5 列 | PR C 不再返回；页面改读快照 |
| `apps/web/src/app/admin/models/page.tsx:65-69, 106-127, 285-308, 749-840` | 手填表单（≤200K / >200K） | **PR C 删除**，换成第 3.2 节只读面板 |
| `services/billing.ts:360-415`（`getModelPricing`）及上面 4 个仍可调用的入口 | 读输入、输出、搜索价，预扣和结算旧链路 | **保留到 LEGACY-CLOSE，不迁移**（D6）。已有模型继续用原值；新模型手填列为 0，旧链路按现有规则报"价格不可用"拒绝（`billing_require_model_pricing` 默认开，第 402-411 行），不会少收或乱收 |
| `services/billing.ts:1181` 起（`settleAbort`）、`apps/web/src/app/api/ai/stream/route.ts:184-198, 666-798, 1054` | 旧聊天预扣和结算 | 入口已 410；随 LEGACY-CLOSE 删除 |
| `services/modelRouter.ts:300-355`、`services/models/publicColumns.ts:4-6` | 只用输入 / 输出价给旧聊天的模型路由打分 | 旧聊天已关；随 LEGACY-CLOSE 删除 |
| `services/costCalculator.ts` | 不读数据库，用写死的旧价格表；只被 `services/index.ts:43` 再导出，没找到生产调用方 | 随 LEGACY-CLOSE 删除 |
| SQL `atomic_finalize_ai_success`（0023、0058；0105 改名旧函数并重定义） | 调用方未传价格时读这 3 列写结算元数据 | 旧链路；0105 新函数体是否仍读这些列未核对，PR C 实施时核对；随 LEGACY-CLOSE 处理 |
| `routers/admin.ts:66-78, 2152-2155, 2402-2470`（`getFinanceStats`）、`apps/web/src/app/admin/finance/page.tsx:555-578` | 财务页显示 5 列和"每千 token 积分范围" | **PR C 迁移**：改显示快照的基础价和推导出的冻结单价；没有快照显示"未读取" |
| `routers/admin.ts:2612-2614, 2778-2780, 2837`（`getPerformanceStats`）、`apps/web/src/app/admin/performance/page.tsx:715-718`、`services/performanceCostReport.ts:12-29` | 性能页显示输入 / 输出价；"缓存节省"按 `cached_tokens × 输入价 × 0.9` 估算 | **PR C 迁移**：显示改读快照；节省估算改为 `cached_tokens × (输入价 − 缓存读价)`（快照没有缓存读价时显示"未知"）。实际成本仍取 `token_stats.total_cost_usd` |
| `packages/db/seeds/staging_non_secret_baseline.sql:228-324` | 两行占位模型写了手填值 | 不改值，只加注释说明这些列已不被新路径使用；随 LEGACY-CLOSE 一起删 |
| 列权限（`0142_ai_models_column_grants.sql`：`authenticated` 可读除 `api_key` 外所有列） | — | 价格不是机密，不改；删列时一起处理 |

LEGACY-CLOSE 删除上述旧链路后，再用一个迁移删掉 5 列（含建库指纹更新），不在本任务里做。

## 7. 迁移、兼容、回退和测试

### 7.1 现有数据

- 不需要 SQL 迁移。现有 5 个模型行（`deepseek/deepseek-v4.1-flash`、`google/gemini-3.8-flash`、`openai/gpt-6-luna`、
  `qwen/qwen3.8-27b`、`anthropic/claude-sonnet-5.5`；以 staging 实际行为准，本方案未连库读取）在 PR A 部署后，
  由管理员在后台对每个模型点一次"从 OpenRouter 读取"。这会改写 staging `ai_models.config`，按 D3 推荐由
  Owner 给一次性许可，执行方读回核对 `pricingHash` 和线路。
- 手填列保留原值、不再显示、不再被新路径读取；LEGACY-CLOSE 时再决定删列（那时需要迁移和指纹更新）。
- 正式库建库（REL-1）：模型行导入后同样点读取，不从 staging 复制价格。

### 7.2 回退

- PR A：回退代码即可。价格在并列的 `config.pricing` 键里，旧代码不读它，`config.reasoning` 结构不变；
  旧版通用配置编辑可能把 `config.pricing` 清掉，重新部署后再点一次读取即可。测试覆盖"带 `config.pricing`
  的行在旧解析下思考设置仍有效"。
- PR B：新字段可选，删掉准入检查和推导即可回到旧算法；已冻结的新格式报价需要保留能读新字段的版本完成或恢复
  （同 MR-2 的恢复边界）。
- PR C：恢复表单即可；列一直没删。

### 7.3 测试

单元测试：

- 价格换算：每 token 字符串 → 每百万；12 位以上向上取整（Gemini 0.0000000416666666666667 → 0.041666666667）；
  非法字符串、负数、科学计数法拒绝。
- overrides：Luna 在 T = 271,999 / 272,000 的输入和输出单价；Qwen 两档；DeepSeek 时段价取最高；不认识的条件键拒绝。
- 写入价：Anthropic 总价、Gemini 附加费、"写入价低于输入价"的非 google 作者按附加费；1 小时写入价不进首版上限。
- `internal_reasoning` 取大；`request` 缺省为 0；重复 tag 相同合并、不同标为不可选。
- `openRouterBound`：无新字段时结果与现在逐位相同（旧窗口）；有新字段时等于推导值；`max_price` 只用基础价。
- 准入：快照缺失、过期（边界 ±1 秒）、线路消失、涨价、降价、价格不变但 `fetchedAt` 变化，各一条。
- `refreshCatalog`：`updated_at` 冲突返回 CONFLICT；比较结果和日志字段。
- 后台：没有任何接口能写 `pricing`；`updateModel` 不再接受 5 个手填字段（PR C）。

集成测试（本机 Docker，CI 同款入口）：

- `run-workbench.mjs --runtime-only --with-staging-schema --without-app --schema-from-files`：本机窗口的报价由
  `deriveOpenRouterLimits` 从测试快照生成；准入、冻结、结算一条 BILL2 记录；快照涨价后新准入被拒、已有 run 正常结算。
- `--bill2-core-only`：带新字段的 `providerLimits` 通过整对象匹配、`payload` 大小、`cost > upper_usd` 冲突规则不变。

浏览器验证（交 Codex，PR A 和 C 各一次，按全局分工发 Validation handoff）：后台读取价格、选线路、分档和时段显示、
过期提示、倍数面板联动、旧成本表单已消失、模型保存后其他字段不受影响。只用 staging 测试管理员身份，不发模型调用。

必测项（需要另行批准的 staging 真实小额调用，不在本任务里执行）：

1. 分档模型在基础价 `max_price` 下，长输入请求能否被 OpenRouter 接受（第 3.3 节）。
2. `discount` 线路的 `usage.cost` 与挂牌价的关系（第 3.5 节）。

## 8. 施工顺序

1. #565 已合并（`7909c118`）；本方案获批后即可开始 PR A。
2. PR A（可与 PROMPT-CACHE 实现并行，不碰 `openRouterPolicy.ts`）。
3. PR A 部署后：Owner 许可 → 后台逐个模型读取价格。
4. PR B：在 PROMPT-CACHE 的 `openRouterLimits` 改动之后，或由同一写入方一起做；合并后新建 staging 窗口时用"复制报价 JSON"。
5. PR C：可在 B 之后任何时间；如果 LEGACY-CLOSE 先到，就并入 LEGACY-CLOSE。
6. BILL-PAYG 实现直接使用 `deriveOpenRouterLimits` 的 T 参数版本。

## 9. 需要 Owner 决定的事

| 编号 | 问题 | 推荐 | 理由 |
| --- | --- | --- | --- |
| D1 | 价格快照多久算过期（过期后新调用被拒、要点"重新读取"） | **7 天**；新建测试窗口前 24 小时内必须读一次 | 供应商调价不频繁；实时涨价已有 `max_price` 拦截，7 天主要防缓存写入和分档价变化 |
| D2 | 供应商**降价**时，已批准的报价怎么办 | **继续用旧报价**，等下次批准时再降 | 旧报价只是冻结得多一点，实扣按实际费用，用户不多花钱；自动降低会让"批准过的报价"悄悄变化 |
| D3 | staging 上管理员点"重新读取"是否要每次请示 | **staging 一次性许可**：执行方可以在 staging 后台对模型点读取，读后核对；正式环境仍要逐次批准 | 只是读公开价格写进 staging 配置，不调用模型、不花钱 |
| D4 | 要不要自动定时刷新价格 | **不要**，手动读取 + 过期拦截 | 加定时任务就是新基础设施；手动加过期提示已够用 |
| D5 | OpenRouter 出现我们不认识的新价格字段时 | **纯文本调用照常，页面标注**；以后开放图片 / 音频 / 搜索时再纳入 | 一律拒绝会因为无关的新字段让模型突然不可用 |
| D6 | 旧手填价格列 | **后台不再填写；还在用它的 4 个旧入口（旧估价、agentSlice、旧工作台生成）继续读原值，不改造；LEGACY-CLOSE 删掉这些入口后再删列** | 这些入口本来就要删，改造它们是白做；新模型没有手填价，旧入口会按现有规则拒绝，不会少收或乱收 |
| D7 | 按时段变价的模型（如 DeepSeek V4 Pro 高峰/低谷价） | **冻结时按最高时段价，实扣按实际** | 调用可能跨时段；按实际扣费，用户享受低谷价 |

如果全部接受推荐，可以直接回复：

> 同意 MODEL-PRICING-SYNC 方案第 9 节 D1–D7 全部按推荐执行。

## 10. 剩余风险

- `max_price` 不覆盖缓存写入和分档价，这部分涨价只能靠过期时限和结算冲突检查发现；冲突时差额由平台承担。
- "写入价低于输入价就当附加费"是保守规则，可能让个别模型冻结偏高，不会偏低。
- `discount` 的确切含义未经实测。
- 本方案没有连接 staging 数据库，第 7.1 节的模型清单来自仓库文档和代码，以 staging 实际行为准。
