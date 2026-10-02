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
4. 价格过旧（建议超过 7 天）时，页面变黄提醒；推荐让系统在下一次调用前自动重读一次公开价格（第 9 节 D4），
   价格没涨就继续，不用人去点。
5. 如果 OpenRouter 涨价：系统**不会自动跟着提高上限**。已批准的报价会被拦下，需要重新批准。
   OpenRouter 那边也有一道"最高价"保护：线路的价格超过我们冻结的最高单价时，直接拒绝调用，不产生费用；
   小幅涨价拦不住，要靠我们这边的价格比较发现（第 10 节）。
6. 用户最终扣多少，仍然按 OpenRouter 实际收的钱（已经包含缓存折扣）乘倍数算，这一点不变。

**第 9 节的 D1–D7 已定**：Owner 2026-10-02 决定全部按推荐执行。

## 1. 现状核对（证据）

### 1.1 新 Runtime / BILL2 已经不读手填价格

- 调用前的上限和 `max_price` 只来自每次调用冻结的 `providerLimits`
  （`packages/api/src/services/bill2/openRouterPolicy.ts:7-11`：`providerSlug`、`contextTokens`、
  `promptUsdPerMillion`、`completionUsdPerMillion`、`requestUsd`）。
  `openRouterBound` 按 `prompt × contextTokens + completion × maxOutput` 向上取整加 `request` 得到上界，
  同时生成 `only:[线路]`、`allow_fallbacks:false`、`max_price:{prompt,completion,request}`（同文件 27-36 行）。
  **上界和 `max_price` 用的是同一个 `promptUsdPerMillion` / `completionUsdPerMillion`。** 总控 2026-10-02 在 staging
  新建的 v2 窗口 `239cea19…` 已把这两个字段直接填成最高单价（Sonnet 输入 2.5 = 5 分钟缓存写入价；Luna
  0.25 / 0.75 = 27.2 万档的写入价和输出价），所以现在实际发给 OpenRouter 的 `max_price` 就是最高单价。
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
- 结果存为 `ai_models.config.reasoning.catalog`（`shared/modelReasoning.ts:46-75`：`fetchedAt`、`model`、
  `reasoning`、`endpoints[]{tag, providerName, supportedParameters, contextLength, maxCompletionTokens}`），
  由后台 `modelReasoning.refreshCatalog`（`routers/modelReasoning.ts:78-89`）触发；页面入口是模型页的
  `ModelReasoningDialog`。**端点返回里的 `pricing` 目前被丢弃。**
- 线路用完整 tag（例如 `deepinfra/fp8`、`google-vertex/global`），这是仓库现有约定（MR-1/MR-2）。

### 1.3 手填价格列的读者

见第 6 节表格（逐文件核对结果）。

### 1.4 OpenRouter 公开目录实测（2026-10-02 06:56 UTC，一次匿名 GET，未调用任何付费接口）

`GET /api/v1/models` 返回 464 个模型（响应 762,784 字节，sha256 `18a7f5bb…10fa`）。各价格字段出现次数：
`prompt` 464、`completion` 464、`input_cache_read` 300、`web_search` 177、`input_cache_write` 94、
`overrides` 80、`input_cache_write_1h` 33、`internal_reasoning` 31、`image` 30、`audio` 33、
`input_audio_cache` 28、`image_output` 9、`audio_output` 2；**没有任何模型带 `request` 字段**。
端点价格另有数字型的 `discount` 字段（每条线路都有，多数是 0；含义见第 3.5 节）。价格单位是"美元 / 每个 token"的十进制字符串。

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
- **按时段变价**：`deepseek/deepseek-v4-pro-0813` 的 `overrides` 用 `utc_days`（小写星期名）、`utc_start`、`utc_end`
  （HHMM 写法，例如 `utc_start:1400, utc_end:0`，会跨过午夜）表示不同时段的价格。
- **override 是平铺对象**：条件键和价格键混在一起，例如 Luna 是
  `{min_prompt_tokens:272000, prompt, completion, input_cache_read, input_cache_write}`；override 不一定列出全部价格
  （DeepSeek 的时段 override 没写 `input_cache_write`）。
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
搜索服务价格（那是 #565 的 `billing_provider_prices`）；不加定时任务；不在每次调用时请求 OpenRouter 目录——只在快照过期时由准入重读一次（D4 推荐；如果 D4 选"只手动"，就完全不在调用时请求）；
不决定正式环境报价的审批流程（RUNTIME-PROD ①），只规定它必须用本方案的快照和推导函数。

## 3. 设计

### 3.1 快照放在哪里：复用现有目录读取和 `ai_models.config`，不新建表

**做法**：现有 `refreshCatalog` 已经读回每条线路的 `pricing`，只是丢掉了。改为在同一次读取里，把价格存成
`ai_models.config.pricing`（和 `config.reasoning` 并列的一个键）：

```
config.pricing = {
  fetchedAt, model,                 // 后台按钮读取时与 config.reasoning.catalog 同一次写入；准入自动重读只更新 pricing
  source: "openrouter:/api/v1/models/{model}/endpoints",
  pricingHash,                      // 规范化后全部线路价格的 sha256
  endpoints: [ { tag, pricing } ]   // 最多 64 条；准入自动重读后可能比目录快照新，线路不保证一一对应
}
```

为什么不直接加进 `config.reasoning.catalog.endpoints[]`：现有 `catalogSnapshot` 是 `.strict()`，一旦回退到旧版本，
带价格的目录会被判为无效，导致思考设置和 Runtime 准入（`RUNTIME_REASONING_CONFIG_INVALID`）一起失效。
放在并列的键里，旧代码只读 `config.reasoning`，回退是干净的。代价是两处要保持一致：推导时校验
`pricing.model` 和 `reasoning.catalog.model` 都等于当前行的 `model_id`（改过模型 ID 的行必须重新读取），所选线路在两边
都存在。`fetchedAt` 不要求相同：后台按钮一次写两处，准入自动重读（第 3.4 节）只更新 `pricing`，思考设置用的目录
只由管理员按钮更新；
`services/models/modelConfig.ts` 的 `withStoredReasoning`（`routers/model.ts:389,456` 在编辑通用配置时用它保住
`reasoning`）同样要处理 `pricing`：**丢掉客户端传来的 `pricing`**（防伪造），再放回已存的值。
连接测试的 `persistConnectionState`（`routers/model.ts:106-133`）也是对整个 `config` 先读后写，和"重新读取"同时
发生时会把 `pricing` 改回旧快照（不会提高上限，但会让一次已发现的涨价暂时"消失"）；PR A 让它只合并自己的键
（或同样加 `updated_at` 防覆盖）。

每条线路的 `pricing` 保持 OpenRouter 的形状，只做规范化，不压成两档：

```
pricing: {
  base: { prompt, completion, inputCacheRead?, inputCacheWrite?, inputCacheWrite1h?,
          internalReasoning?, webSearch?, request?, image?, audio?, ... }   // 美元/百万 token（或每次），十进制字符串
  overrides: [ { when: { minPromptTokens? , utcDays?, utcStart?, utcEnd? }, prices: {同上的子集} } ]  // 最多 16 条
  discount: number | null      // 原样记录（数字，例如 0、0.3、0.5），不参与计算
  unknownKeys: string[]        // 目录里出现、但本版本不认识的价格字段名
  raw: object                  // OpenRouter 原始 pricing 对象（字符串原样），只供核对
}
```

- 单位换算：OpenRouter 字符串 × 1,000,000 用十进制移位完成（不经过浮点）；超过 12 位小数的**向上取整到 12 位**
  （和 `bill2/decimal.ts` 精度一致，与 PROMPT_CACHE_PLAN 第 4.1 节对 Gemini 的规定相同），原始字符串另存一份
  `raw` 供核对。
- 重复 tag：价格完全相同则合并，`contextLength` 不同时取较小值；价格不同则这条 tag 标为"价格不唯一"，不能被选为线路。
- 键分类（OpenRouter 的 override 是平铺对象，必须分类）：
  - 已知条件键：`min_prompt_tokens`、`utc_days`、`utc_start`、`utc_end`。
  - 已知价格键：`prompt`、`completion`、`request`、`input_cache_read`、`input_cache_write`、`input_cache_write_1h`、
    `internal_reasoning`、`web_search`、`image`、`audio`、`input_audio_cache`、`image_output`、`audio_output`。
  - 基础价层另有 `discount`、`overrides` 两个结构键。
  - **override 里出现任何其他键**：整条线路不可准入（无法判断它是新条件还是新价格），不受 D5 影响。
  - 基础价层出现其他键：记入 `unknownKeys`，按 D5 处理。
  - 条件值校验：`utc_days` 只接受 7 个小写星期名；`utc_start` / `utc_end` 是 0–2359 的 HHMM，分钟 ≤ 59，
    允许 `utc_end < utc_start`（跨午夜）；`min_prompt_tokens` 是正整数。不合法 → 整条线路不可准入。
- 只读、不可手改：没有任何接口能单独写 `pricing`；唯一写入路径是"重新读取"，每次整体替换成新快照（新 `fetchedAt`、
  新 `pricingHash`）。历史价格的权威记录在已冻结的报价里（窗口 `call_policies`、`bill2_runs.payload.callPolicy`、
  `bill2_calls.payload.providerLimits`），不在 `ai_models` 里另存历史。
- "重新读取"的写入改为带 `updated_at` 防覆盖（和 #565 `modelPricing` 一样），并且**只合并自己负责的键**
  （按钮：`pricing` 和 `reasoning.catalog`；准入自动重读：只有 `pricing`），不把读到的整个 `config` 写回去。
  现有 `writeReasoning` 是读后整体写，慢请求期间别人改过的线路、思考设置会被覆盖。
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
  价格(L, k) = override 写了 k ? override 的值 : 基础价的值        // 没写的沿用基础价，不能当 0
  写入价(L)  = 没有写入价                ? 0
             : 写入价是"总价"           ? 价格(L, input_cache_write)
             : 写入价是"附加费"         ? 价格(L, prompt) + 价格(L, input_cache_write)   // 每一层分别相加，向上取整到 12 位
  输入(L)    = max(价格(L, prompt), 写入价(L))
  输出(L)    = max(价格(L, completion), 价格(L, internal_reasoning) ?? 0)
  每次(L)    = 价格(L, request) ?? 0
输入最高单价 = max over L 输入(L)；输出最高单价 = max over L 输出(L)；每次最高 = max over L 每次(L)
```

- **适用的价格层**：
  - `minPromptTokens`：当 `promptTokensUpper ≥ minPromptTokens` 时适用。现在 `promptTokensUpper = contextTokens`
    （整个上下文都预留），所以 Luna、Qwen 的高档都适用；PAYG 后改为 #553 的 `T = B + K + M`，T 低于阈值才用低档。
  - `utcDays` / `utcStart` / `utcEnd`：一律适用（调用可能跨过时段边界），即冻结时取所有时段中最高的价。
  - override 里出现不认识的键：整条线路**不可准入**，不猜（第 3.1 节键分类）。
- **缓存写入是"总价"还是"附加费"**：Anthropic、OpenAI、Qwen 的 `input_cache_write` 是写入 token 的总单价
  （都高于普通输入价）；Gemini 的是 5 分钟存储费，需要加在输入价上（#572 第 4.1 节）。规则：作者是 `google/`
  的按附加费；其他作者若写入价低于输入价，也按附加费处理（保守，算高不算低）；写入价不低于输入价按总价。
  这条规则写在代码注释和测试里。它只在一个方向上保守：写入价不低于输入价、但其实是附加费的线路会被算低
  （现有 5 个模型都不是这种情况），写进第 10 节。
- **1 小时缓存写入**：Runtime 现在只发 5 分钟缓存标记（#572）。请求里出现 1 小时标记时必须把
  `inputCacheWrite1h` 纳入输入最高单价，否则拒绝发送；首版不发。
- **思考 token**：`internal_reasoning` 存在时与 `completion` 取大。这只在思考 token 计入 `outputLimit` 时成立；
  不计入的情况按 #553 第 2 节要求另设硬上限 R 并逐项加，本任务不放宽这条。
- **联网搜索、图片、音频、1 小时写入**（已知的非文本价格键白名单：`web_search`、`image`、`audio`、
  `input_audio_cache`、`image_output`、`audio_output`、`input_cache_write_1h`）：Runtime 首版是纯文本、
  `network:'deny'`、关闭搜索插件（0108 准入要求），这些价格只保存和显示，不进上限。以后开启某一项时，
  必须同时把对应单价 × 次数上限加进上限，否则拒绝。
- **`request`**：目录目前没有这个字段，缺省为 `"0"`；出现时照实计入（取各层最高）。
- **`discount`**：只记录，不参与计算（第 3.5 节）。
- **基础价层不认识的字段**（`unknownKeys` 非空）：页面显示出来；准入按 D5（推荐拒绝，见第 9 节）。

输出给 BILL2 的 `providerLimits`——**单字段写法**（与 v2 窗口 `239cea19…` 完全一致）：

```
{ providerSlug, contextTokens,
  promptUsdPerMillion:     输入最高单价,
  completionUsdPerMillion: 输出最高单价,
  requestUsd:              每次最高 }
```

- `openRouterBound` **算法不变**，`openRouterLimits` 的结构只加一个可选字段 `cacheWriteUsdPerMillion`（见下）：上界仍是
  `ceil((prompt × contextTokens + completion × maxOutput) / 1e6) + request`，`max_price` 也用这三个最高单价。
  所以只有一套上界算法；`max_price` 一定不低于任何分档价，长输入跨档不会被 OpenRouter 拒；旧窗口、v2 窗口和旧回执
  的上界逐位不变；0108 的整对象相等匹配和 `stagingPolicy.ts:33` 的 `upperUsd` 复核都不用动。
- 代价（写入第 10 节）：OpenRouter 端的实时拦截只能拦住"挂牌价涨到超过冻结的最高单价"的情况；涨幅更小的
  （例如 Sonnet 基础价从 2 涨到 2.4），要靠第 3.4 节的快照比较和过期时限发现，结算时 `cost > upper_usd` 记冲突兜底。
- `cacheWriteUsdPerMillion`（#572）：保留，作为 PROMPT-CACHE "能否加缓存标记"的前提和来源说明。由 PR B 作为
  `openRouterLimits` 的可选字段加入，值由推导函数填写；在上界里它只是 `max(prompt, cacheWrite)` 中一个不起作用的项
  （prompt 已经是最高价），测试证明加上它上界不变。旧报价没有这个字段，行为不变。
- 来源（`fetchedAt`、`pricingHash`）**不放进** `providerLimits`，避免让 SQL 整对象匹配更复杂：建窗口时写进总控的
  执行记录；每次准入由 `pricingAdmission` 写进结构化日志。
- `contextTokens` 取所选线路的 `contextLength`（真实能力，#553 要求不为改变收费而人为改小）；
  仍须满足现有 `ai_models.input_limit ≥ contextTokens`。
- `bill2_calls.payload` 只多一个可选的 `cacheWriteUsdPerMillion`，远低于 65,536 字节上限；测试覆盖。

### 3.4 准入时的价格检查、过期和涨价

新增 `pricingAdmission.ts`（与 `reasoningAdmission.ts` 并列），真实窗口的每次新准入：

1. 读取当前模型行的快照，按窗口报价的 `providerSlug` 找到线路；没有快照、没有价格、线路消失、价格不唯一、
   线路不可准入（第 3.1 节键分类）或 `pricing.model` 不等于行的 `model_id` → 拒绝 `RUNTIME_PRICE_SNAPSHOT_MISSING`。
2. 快照 `fetchedAt` 超过时限（推荐 7 天，D1）：按 D4 推荐，由准入自动重读一次公开目录（与后台按钮同一个
   `readOpenRouterCatalog`，15 秒超时），成功后用新快照继续第 3 步；读取失败 → 拒绝 `RUNTIME_PRICE_SNAPSHOT_STALE`
   （中文："模型价格太久没更新，暂时无法核对，请稍后重试或在后台重新读取"）。若 D4 选"只手动"，过期直接拒绝。
   自动重读的细则：
   - **写入**：用读到快照前的 `updated_at` 做防覆盖条件，只合并 `config.pricing` 一个键（不碰 `reasoning`、线路和
     连接状态）。不能只按 `fetchedAt` 判断要不要覆盖。
   - **抢写失败**（两个调用同时发现过期，或管理员同时保存了思考设置、做了连接测试、编辑了模型）：重新读一次模型行；
     库里的快照已经不过期，就用库里的；否则这次准入直接用自己刚读到的快照做第 3 步比较，**但不写库**。不循环重试写入。
     刚读到的是公开数据，只用来比较，不会提高任何上限。
   - **多个模型**：一次准入涉及的主模型、附带的整理模型（`organizeAfter`）和 `auto` 候选模型（最多 16 个）中，所有过期的
     **并行**重读，共用一个 15 秒的总时限；所以一次调用最多多等约 15 秒（每个读取含两次 GET，模型列表约 0.75 MB）。
   - **失败冷却**：同一服务器进程里，某个模型重读失败后 60 秒内的准入直接按 `RUNTIME_PRICE_SNAPSHOT_STALE` 拒绝，
     不再重读。取舍：OpenRouter 目录持续不可用时，用户不用每次多等 15 秒才失败；代价是 OpenRouter 恢复后最多晚 60 秒
     才恢复调用（管理员点按钮可立即恢复）。冷却只在单个进程内有效，不加共享存储。
   - **思考目录不随自动重读更新**：`admitReasoning` 继续用管理员维护的 `reasoning.catalog`，所以自动重读不会让思考设置
     在无人在场时变得不合格；目录里线路的参数变化，要等管理员按按钮时才看到。
   - **日志**：每次自动重读都写 `model_price_snapshot_changed`（触发方 `admission`、模型、线路、变化的字段、新旧
     `pricingHash`、是否写库成功 / 抢写失败 / 读取失败），价格没变也记一条"无变化"。
   - **新的写入方**：这是第一次由用户请求路径（用 service-role 的 `admin` 客户端）写 `ai_models.config`。写入内容只来自
     OpenRouter 公开目录，范围只有 `config.pricing` 一个键；PR B 的描述要写明这一点。
3. 用当前快照按本次的 `promptTokensUpper` 推导出三个最高单价，与窗口冻结的 `promptUsdPerMillion`、
   `completionUsdPerMillion`、`requestUsd` **逐项比较**：
   - 三项都是"窗口 ≥ 推导值" → 通过。价格没变、或供应商降价（D2：继续用旧的、偏高的冻结报价，直到重新批准；
     实扣按实际费用，用户不吃亏）都走这条。
   - **任一项"窗口 < 推导值" → 拒绝** `RUNTIME_PRICE_INCREASED`，提示"供应商涨价，需要重新批准报价"。
     系统永远不会自动提高上限。比较的是推导出的**最高单价**，所以缓存写入价、分档价、时段价单独上涨也能发现。
   - 例：v2 窗口（Sonnet 2.5、Luna 0.25 / 0.75）对当前目录通过；按基础价 2 冻结 Sonnet 的 v1 窗口被拒（2 < 2.5）。
4. 已开始的 run 和恢复、重放不受影响：它们只用自己冻结的报价，不重新读快照（和 MR-2 的冻结规则一致）。

为什么不是每次调用都实时查 OpenRouter：会给每次调用增加一个外部依赖和延迟。只在快照过期时由准入重读一次
（每个模型最多每 7 天一次）；两次读取之间，挂牌价涨过冻结最高价的由 `max_price` 在 OpenRouter 那边拦截（不产生费用），
更小的涨幅由下一次读取后的比较发现，期间多出的费用由结算时 `cost > upper_usd` 冲突检查兜底
（差额平台承担，按 #553 规则停止新派发）。

不加定时任务（不新增 cron）。

### 3.5 `discount` 字段

端点价格带 `discount`（Gemini 0.5、DeepSeek `deepinfra/fp8` 0.3），文档未说明挂牌价是折前还是折后。
处理：只记录、不参与计算，冻结按挂牌价。若挂牌价是折前价，实际扣费更低，上限偏高但安全；若是折后价且折扣到期，
挂牌价上涨会被第 3.4 节的比较拦下（涨过冻结最高价的也会被 `max_price` 拦下）。第一次经批准的 staging 小额对账时核对 `usage.cost` 与挂牌价的关系。

### 3.6 测试窗口和以后的正式环境怎么用

- **staging 测试窗口**：窗口仍由总控在 Owner 批准后用 SQL 新建（不改 0108 的权限设计）。变化是窗口报价不再手抄：
  后台面板提供"复制报价 JSON"（由 `deriveOpenRouterLimits` 生成，旁边单独列出 `fetchedAt` 和 `pricingHash`
  供执行记录引用），总控把报价原样放进窗口 SQL；准入第 3 步保证窗口不低于当前推导值。建窗口前 24 小时内必须重新读取一次。
  #565 合并后窗口条目还带每个模型的 `multiplier`（必须等于当时配置，`assertWindowMultipliers`），这部分仍按 #565 的规则
  取值；"复制报价 JSON"只负责 `providerLimits` 和 `upperUsd`，不生成倍数。
- **已有窗口**：`openRouterBound` 结果逐位不变；第 3.4 节检查对它们同样生效。按总控提供的事实，现在 staging 用的是
  v2 窗口 `239cea19…`（已按最高单价冻结，会通过）；旧 v1 窗口 `3b90b458…` 若仍按基础价冻结，会被拒。
  **合并 PR B 之前**，执行方列出当时所有有效窗口及每条报价按当前快照的比较结果，交总控决定是否先停用或换新窗口。
- **正式环境（RUNTIME-PROD ①）**：报价审批机制由 RUNTIME-PROD 设计，本方案只约束：报价必须由
  `deriveOpenRouterLimits` 从快照生成，带来源和 hash；准入走同一个 `pricingAdmission`；涨价拒绝、过期拒绝规则相同。

## 4. 与 #565、#572、#553 的关系

| 来源 | 本方案怎么对齐 |
| --- | --- |
| #565 BILL-UNIT | 不碰 q、m、`price_multiplier`、`billing_provider_prices` 和 `C = ceil(q × Σ(U_i × m_i))`。U_i 仍是 OpenRouter 实际费用。页面把价格面板放在倍数面板旁边，只读取 #565 的生效倍数用于预览。 |
| #572 PROMPT-CACHE | 沿用 `cacheWriteUsdPerMillion` 的名字和含义、Gemini 附加费换算和 12 位向上取整；这个值由快照自动生成，不再手填。**取代 #572 第 4.1 节"改 `openRouterBound`"的做法**：单字段写法下 `prompt` 已含写入价，PROMPT-CACHE 实现只读取推导出的单价和 `cacheWriteUsdPerMillion`，不改 `openRouterBound`，因此可以和 PR B 并行。 |
| #553 BILL-PAYG | 提供 #553 第 2 节"输入最高单价 = max(普通输入价, 5 分钟缓存写入价, 适用的长上下文档位价)"所需的数据；`promptTokensUpper` 参数就是 #553 的 T。第 7 节"稳定 quote policy"里的价格和来源就是本方案的快照字段。#553 的算法不在这里改。 |
| RATE-LIMIT #573 | 无交叉。 |

## 5. 实施拆分

| PR | 内容 | 风险 |
| --- | --- | --- |
| A | 新的严格 schema `pricingSnapshot`（`config.pricing`）；`readOpenRouterCatalog` 同一次读取里解析和规范化价格（十进制换算、重复 tag、键分类、overrides、unknownKeys）；`refreshCatalog` 同时写 `reasoning.catalog` 和 `pricing`，加 `updated_at` 防覆盖、新旧比较和日志；`withStoredReasoning` 丢掉客户端 `pricing` 并保住已存值；`persistConnectionState` 只合并自己的键；只读价格面板。不改任何收费路径 | high（只新增价格来源和显示，但属于计费数据；按 AGENTS.md 第 4 节保守按 high） |
| B | `deriveOpenRouterLimits`（单字段写法）；`openRouterLimits` 只加可选 `cacheWriteUsdPerMillion`，`openRouterBound` 算法不变；`pricingAdmission`（含过期自动重读，按 D4：并行、15 秒总时限、抢写失败不写库、60 秒失败冷却；PR 描述写明这是用户请求路径上新的 `config.pricing` 写入方）接入真实窗口准入；"复制报价 JSON"；合并前列出有效窗口（第 3.6 节）。无 SQL 改动 | high（计费上界、准入） |
| C | 删除模型页"Token 成本设置"表单和 `routers/model.ts` / `admin.ts` 对 5 个手填列的写入；读者按第 6 节处理；列本身保留到 LEGACY-CLOSE | high（计费字段、旧链路） |

**写入方（总控 2026-10-02 指定）**：`openRouterPolicy.ts` 的唯一写入方是本任务 PR B。PROMPT-CACHE 实现只读取
推导出的单价和 `cacheWriteUsdPerMillion`，不自己改 `openRouterBound`。A 可以先做；C 在 B 之后做，或并入 LEGACY-CLOSE。

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
  由管理员在后台对每个模型点一次"从 OpenRouter 读取"。这会改写 staging `ai_models.config`；按 D3 推荐，读取公开价格
  不需要逐次批准，执行方读回核对 `pricingHash` 和线路。
- 手填列保留原值、不再显示、不再被新路径读取；LEGACY-CLOSE 时再决定删列（那时需要迁移和指纹更新）。
- 正式库建库（REL-1）：模型行导入后同样点读取，不从 staging 复制价格。

### 7.2 回退

- PR A：回退代码即可。价格在并列的 `config.pricing` 键里，旧代码不读它，`config.reasoning` 结构不变；
  旧版通用配置编辑可能把 `config.pricing` 清掉，重新部署后再点一次读取即可。测试覆盖"带 `config.pricing`
  的行在旧解析下思考设置仍有效"。
- PR B：`openRouterBound` 算法没变，回退只是删掉准入检查和推导；报价里唯一的新字段 `cacheWriteUsdPerMillion`
  是可选的，已冻结带该字段的报价需要保留能读它的版本完成或恢复（同 MR-2 的恢复边界）。
- PR C：恢复表单即可；列一直没删。

### 7.3 测试

单元测试：

- 价格换算：每 token 字符串 → 每百万；12 位以上向上取整（Gemini 0.0000000416666666666667 → 0.041666666667）；
  非法字符串、负数、科学计数法拒绝。
- overrides：Luna 在 T = 271,999 / 272,000 的输入和输出单价；Qwen 两档；DeepSeek 时段价取最高；override 缺字段时
  沿用基础价（含写入价）；附加费写法每层分别相加；`utc_end < utc_start` 跨午夜能解析；override 里有未知键、
  条件值不合法时整条线路不可准入。
- 写入价：Anthropic 总价、Gemini 附加费、"写入价低于输入价"的非 google 作者按附加费；1 小时写入价不进首版上限。
- `internal_reasoning` 取大；`request` 缺省为 0；重复 tag 价格相同合并且 `contextTokens` 取小，价格不同标为不可选；
  `discount` 是数字。
- 推导结果：当前目录下 Sonnet `anthropic` = 2.5 / 10、Luna `openai` = 0.25 / 0.75、Gemini 按附加费；
  `openRouterBound` 对 v1 / v2 形状报价的结果与现在逐位相同；加上 `cacheWriteUsdPerMillion` 上界不变；
  `max_price` 等于三个最高单价。
- 自动重读（全部注入假的 `transport`，单元测试和集成测试都不访问外网）：两个调用同时发现过期、一方抢写失败后
  不写库也完成比较；与管理员保存思考线路交错时线路不被覆盖；主模型和整理模型同时过期时并行、总时限 15 秒；
  读取失败后 60 秒冷却；只更新 `config.pricing`，`reasoning` 不变；日志字段。
- 准入：快照缺失、过期（边界 ±1 秒）、过期后自动重读成功 / 失败、线路消失、`model` 不一致、涨价（逐项：prompt、
  completion、request 各一条）、降价、价格不变但 `fetchedAt` 变化；v2 形状窗口（Sonnet 2.5、Luna 0.25 / 0.75）通过，
  v1 形状窗口（Sonnet 2）被拒。
- 基础价层 `unknownKeys` 按 D5 的结果（推荐：拒绝）各一条。
- `refreshCatalog`：`updated_at` 冲突返回 CONFLICT；比较结果和日志字段。
- 后台：没有任何接口能写 `pricing`——覆盖 `updateModel`、旧版 `updateModelConfig`、连接测试 `persistConnectionState`
  三条路径（客户端传 `pricing` 被丢掉，已存值保留；连接测试与重新读取交错时不回滚）；`updateModel` 不再接受
  5 个手填字段（PR C）。

集成测试（本机 Docker，CI 同款入口）：

- `run-workbench.mjs --runtime-only --with-staging-schema --without-app --schema-from-files`：本机窗口的报价由
  `deriveOpenRouterLimits` 从测试快照生成；准入、冻结、结算一条 BILL2 记录；快照涨价后新准入被拒、已有 run 正常结算。
- `--bill2-core-only`：带 `cacheWriteUsdPerMillion` 的 `providerLimits` 通过整对象匹配、`payload` 大小、
  `cost > upper_usd` 冲突规则不变。

浏览器验证（交 Codex，PR A 和 C 各一次，按全局分工发 Validation handoff）：后台读取价格、选线路、分档和时段显示、
过期提示、倍数面板联动、旧成本表单已消失、模型保存后其他字段不受影响。只用 staging 测试管理员身份，不发模型调用。

必测项（需要另行批准的 staging 真实小额调用，不在本任务里执行）：`discount` 线路的 `usage.cost` 与挂牌价的关系
（第 3.5 节）。单字段写法下 `max_price` 不低于任何分档价，原"分档请求能否通过基础价 `max_price`"一项不再需要。

## 8. 施工顺序

1. #565 已合并（`7909c118`）；本方案获批后即可开始 PR A。
2. PR A（可与 PROMPT-CACHE 实现并行，不碰 `openRouterPolicy.ts`）。
3. PR A 部署后：后台逐个模型读取价格（D3）。
4. PR B（`openRouterPolicy.ts` 唯一写入方）：合并前列出有效窗口；合并后新建 staging 窗口时用"复制报价 JSON"。
   PROMPT-CACHE 实现不改 `openRouterBound`，可与 B 并行；B 合并后用它生成的报价建下一个窗口。
5. PR C：可在 B 之后任何时间；如果 LEGACY-CLOSE 先到，就并入 LEGACY-CLOSE。
6. BILL-PAYG 实现直接使用 `deriveOpenRouterLimits` 的 T 参数版本。

## 9. Owner 决定（已定）

**已定（2026-10-02）**。Owner 在总控窗口的原话（由总控转达）：「#578 的 D1–D7 全部按推荐」。下表"推荐"一列就是
已定的决定：

| 编号 | 问题 | 决定（按推荐） | 理由 |
| --- | --- | --- | --- |
| D1 | 价格快照多久算过期 | **7 天**；新建测试窗口前 24 小时内必须读一次 | 供应商调价不频繁。**白话后果**：过期以后，如果系统不能自动重读（D4 选"只手动"，或者 OpenRouter 读不到），这个模型的新调用会全部停下，直到有人点"重新读取"。所以 D1 必须和 D3、D4 一起看 |
| D2 | 供应商**降价**时，已批准的报价怎么办 | **继续用旧报价**，等下次批准时再降 | 旧报价只是冻结得多一点，实扣按实际费用，用户不多花钱；自动降低会让"批准过的报价"悄悄变化 |
| D3 | 读取公开价格要不要每次请示 | **staging 和正式环境都不用逐次批准**：读取公开价格（按钮或自动重读）是日常动作；只有"涨价以后重新批准报价"需要 Owner 批准 | 读取本身不调用模型、不花钱，也不会提高任何上限（涨价会被拦下等批准）。如果正式环境也要逐次批准读取，再加上 D1 的 7 天过期，就等于上线后你**至少每 7 天要批准一次**，漏一次所有调用都会停 |
| D4 | 价格过期后怎么续期 | **不加定时任务；过期后由下一次调用前自动重读一次**（每个模型最多每 7 天一次，那一次调用最多多等约 15 秒，涉及几个模型都并行读）。价格没涨就继续，涨了就拦下等批准；读不到就拒绝这次调用，之后 60 秒内直接拒绝 | 不用人每周去点，也不新增定时任务。另一个选项"只手动"：最简单，但要有人每 7 天点一次，否则调用会停 |
| D5 | OpenRouter 出现我们不认识的新价格字段时 | 已知的非文本字段（图片、音频、联网搜索、1 小时缓存写入等）列入白名单，纯文本调用照常；**真正不认识的新字段：推荐拒绝这个模型的新调用**，等代码更新后再放开 | 两边都有风险：拒绝会让模型在代码更新前不能用；放行的话，如果新字段是纯文本也会收的费用（比如按时间收的缓存存储费），冻结上限没算进去，超出部分平台承担。内测阶段停用一个模型比少冻结更容易接受。（override 里出现不认识的键一律拒绝，不在这项选择里） |
| D6 | 旧手填价格列 | **后台不再填写；还在用它的 4 个旧入口（旧估价、agentSlice、旧工作台生成）继续读原值，不改造；LEGACY-CLOSE 删掉这些入口后再删列** | 这些入口本来就要删，改造它们是白做；新模型没有手填价，旧入口会按现有规则拒绝，不会少收或乱收 |
| D7 | 按时段变价的模型（如 DeepSeek V4 Pro 高峰/低谷价） | **冻结时按最高时段价，实扣按实际** | 调用可能跨时段；按实际扣费，用户享受低谷价 |

各项结论摘要（均为已定）：

- D1：价格快照 7 天过期；新建测试窗口前 24 小时内必须读一次。
- D2：供应商降价时继续用旧报价，下次批准时再降。
- D3：staging 和正式环境读取公开价格都不用逐次批准；只有涨价后重新批准报价需要 Owner 批准。
- D4：不加定时任务；快照过期后由下一次准入自动重读一次（细则见第 3.4 节第 2 步）。
- D5：已知的非文本价格字段列入白名单；真正不认识的新字段拒绝这个模型的新调用，等代码更新后再放开。
- D6：后台不再填写手填价格列；4 个旧入口继续读原值不改造；LEGACY-CLOSE 删掉这些入口后再删列。
- D7：按时段变价的模型冻结时按最高时段价，实扣按实际费用。

这些是产品决定；本方案仍是 high 风险，合并方案需要 Owner 另外批准，批准方案也不等于批准实施代码的合并。

## 10. 剩余风险

- **OpenRouter 端的实时拦截变松**（单字段写法的代价）：`max_price` 用的是冻结的最高单价，只能拦住"挂牌价涨到超过
  最高单价"的情况；涨幅更小的（例如 Sonnet 基础价 2 → 2.4，仍低于 2.5），以及 `max_price` 本来就不覆盖的
  缓存写入价，要等下一次读取快照后的比较才发现；两次读取之间多出的费用由结算冲突检查记录，差额平台承担。
- "写入价低于输入价就当附加费"**只在一个方向上保守**：写入价不低于输入价、但其实是附加费的线路会被算低。现有 5 个
  模型都不是这种情况；新增模型时若出现，结算冲突检查会发现。
- 过期自动重读（D4）在 OpenRouter 不可用时会让过期模型的新调用失败；失败后 60 秒冷却期内直接失败，OpenRouter
  恢复后最多晚 60 秒恢复（管理员点按钮可立即恢复）。
- 自动重读是用户请求路径上新的 `ai_models.config` 写入方（只写 `config.pricing`）。
- `discount` 的确切含义未经实测。
- 本方案没有连接 staging 数据库，第 7.1 节的模型清单来自仓库文档和代码，以 staging 实际行为准。
