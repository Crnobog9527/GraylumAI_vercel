# FUSION-PROFILE：评审团模型的逐次计费档案和汇总模型实测

> 状态：取证完成（2026-10-17），四个模型的证据齐全；staging 写入由总控执行（第 6 节）。
> 依据：[FUSION-REVIEW](tasks/FUSION-REVIEW.md) 第 6 节 FUSION-PROFILE 一行；采样方法 [#665](https://github.com/Crnobog9527/GraylumAI_vercel/pull/665)
> （[BILL_PAYG_PROFILE_FINAL](BILL_PAYG_PROFILE_FINAL.md)），按 Owner 方案 B 缩小到评审团实际请求；
> 证据 [fusion-profile-20261017.json](evidence/fusion-profile-20261017.json)（sha256 `e0588e1009370a8e69dfbd7b2f7e62c813daea6d8b2473036af057a633e7aa0f`）；
> Sol / Opus 档案草稿 [fusion-profile-20261017.profiles-draft.json](evidence/fusion-profile-20261017.profiles-draft.json)。

## 0. Owner 的决定

- **模型**（2026-10-17）原话："评审模型： Claude Sonnet 5.5、chatgpt 6 sol、Gemini 3.8 Flash；汇总模型： Claude opus 5.5"。
  对应 OpenRouter：评审 A `anthropic/claude-sonnet-5.5`（线路 anthropic）、评审 B `openai/gpt-6.1-sol`（线路 openai）、
  评审 C `google/gemini-3.8-flash`（线路 google-ai-studio）；汇总 `anthropic/claude-opus-5.5`（线路 anthropic，目录价每百万输入 4 美元、输出 20 美元）。
  汇总模型由 Owner 指定，取代 FUSION-REVIEW 原来"比较候选汇总模型再定默认"的做法；第 2 节的实测用来确认 Opus 能不能胜任。
- **取证范围**（2026-10-17，方案 B）原话："B：只按评审团实际会发的请求测，约 3.5 美元，在原预算内。但要改规则，让评审团专用的核验记录可以少做测试，
  opus 和GPT-6.1 Sol 的能力只会比 sonnet 更强，不用再跑一套Sonnet 和 Gemini 以前已经测过的这一整套标准测试了，浪费钱。"

## 1. 为什么后台评审团选不到模型（2026-10-17 只读核对 staging）

`fusionModelOptions` 对每个模型分别按评审、汇总两种用途走一次真实准入，四个模型都过不了：

| 卡点 | Sonnet | Gemini | Sol | Opus |
| --- | --- | --- | --- | --- |
| 模型设置里的思考档位（`config.reasoning.purposes`）没有评审 / 写作 | 缺 | 缺 | 缺 | 模型不存在 |
| 计费档案 `runtime_payg_staging` 没有 `fusion_review`/`fusion_summary` 用途和 `fusion-json-v1-stream` 格式 | 缺 | 缺 | 没有档案 | 没有档案 |
| 代码里允许建档案的线路（`paygHostPolicy.ts` 的 `admittedRoutes`） | 有 | 有 | **没有**（本 PR 加上） | **没有**（本 PR 加上） |
| 测试窗口报价 | 有 | 有 | 有，但价格是旧价 $5/$15、输入上限 90000 B | 没有 |

## 2. 汇总模型 Opus 5.5 实测（同一份报告、同样三份意见）

做法：从 staging 取出两次真实评审交给汇总模型的原始请求字节（评审 9ec67439 和 170ec08f，报告 10888 字、全文上限 12000 字、
14 个章节、3 个步骤 14 个字段），只把模型换成 Opus、线路换成 anthropic、输出上限 32768、思考 low，原样重发；
用产品里同一个宿主检查 `checkRevision` 判定，再逐条读裁决记录、抽查改动。Sonnet 的数字是当时 staging 上的真实输出。

| | Sonnet（9ec67439） | **Opus（9ec67439 同题）** | Sonnet（170ec08f） | **Opus（170ec08f 同题）** |
| --- | --- | --- | --- | --- |
| 宿主检查 | 通过 | **通过** | 失败：输出在 16384 token 截断 | **通过** |
| 修订后全文 / 上限 | 11536 / 12000 字（+648） | **11098 / 12000 字（+210）** | — | **11223 / 12000 字（+335）** |
| 未改章节逐字照抄 | 7 章 | **7 章** | — | **9 章** |
| 改动章节都有修改说明 | 7/7 | **7/7** | — | **5/5**（含一章只改一个词、字数不变） |
| 裁决记录 | 8 条，采纳 7 | 8 条，采纳 7，驳回 1 | — | 8 条，全部采纳 |
| 输出 token（含思考） | — | 16525（思考 1691） | 16384（触顶） | 16813（思考 1693） |
| 用时 | — | 119 秒 | — | 120 秒 |
| 实际花费 | 0.2030 美元 | **0.4325 美元** | 0.2157 美元 | **0.4399 美元** |

四项结论：
1. **裁决理由**：每条都写了回原文核实的结果。例：评审建议补 3 个对标账号，Opus 以"没有资料，补账号就是编造"驳回；
   评审把"好评换优惠"标在第十一章，Opus 核实原句在第十章并改在第十章；三位评审对"暂判可行"意见不一，只降低结论强度、不推翻路径。
2. **修订版正确性**：抽查两处——第九章发布日"周四"改为与前文一致的"周五"（原文确实前后不一）；"违反平台规则"改为"可能触及平台规则、待核实"。都改对了，没有新增无来源的事实或金额。
3. **修改说明完整性**：两次都没有漏写。PR-4b 里 Sonnet 漏写的正是"只改一两个字的章节"，这次 Opus 在第九章只改一个词、字数 1922→1922 时也写了说明。
4. **篇幅控制**：两次都在上限内，增幅 2%–3%（Gemini 在 PR-4b 两次把 10888 字扩到 16000 多字）。

代价：一次汇总约 0.44 美元，是 Sonnet 的 2.1 倍；输出约 1.65 万 token，32768 的上限够用、余量约一半。
结论：**Opus 5.5 能胜任汇总**，和 Owner 的选择一致。样本只有同一份报告的两次，正式开放后按真实案例继续看。

## 3. 评审团请求的计费取证（方案 B）

**做法**：请求都是 `fusionRequestBody` 生成的真实字节（system + user 两条消息、中文报告 + JSON 资料、严格 JSON schema 输出、不带工具、web 插件关闭、
`provider.only` 单线路不回退），思考一律 low。每个模型取两档大小：
中档 = 原样重放 staging 上真实的评审 / 辩论 / 汇总请求（4.2 万–6.7 万 B）；大档 = 同一请求把资料字段补长到约 186000 B（加上宿主的 8192 B 余量后贴近每次调用 196608 B 的上限）。
截断测试把输出上限压到档案的 `testedOutputLimit`，确认"输出上限包含思考"。Opus 的大档同时就是截断测试（上限 2048）。

| 模型（用途） | 样本 | 最大请求 | 输入 token / 字节（最大） | 输入 token / 上限（最大） | 截断样本（上限内触顶） | 花费 |
| --- | ---: | ---: | ---: | ---: | --- | ---: |
| Sonnet（评审） | 6 | 185999 B | 0.401 | 0.384 | 2048 ×2 | 0.4825 |
| Gemini（评审） | 5 | 185959 B | 0.261 | 0.250 | 498/512 ×2 | 0.0812 |
| Sol（评审） | 6 | 186000 B | 0.281 | 0.270 | 512 ×2（其中一条含思考 56） | 0.4267 |
| Opus（汇总） | 4 | 185970 B | 0.398 | 0.381 | 2048 ×2（含思考 1213、1312） | 1.5456 |

- 每条样本：实际花费都低于产品的上限公式（`openRouterCallBound`，输入按"字节 + 8192"计 token、按报价最高输入价）；缓存 token 不超过输入；输出不超过上限。
- 输入 token / 字节最大 0.401，远低于规则线 0.7，也低于 Sonnet、Gemini 在 #665 完整矩阵里测到的 0.562、0.463。
- 思考 low 时 Sonnet、Gemini 的思考 token 是 0，Sol 偶尔几十，Opus 汇总约 1200–1700；评审 4096 的上限基本全用于正文。
- 7 份评审输出用产品的 `parseOpinion` 解析都是可用意见（Gemini 3 条问题、Sonnet 5–6 条、Sol 9 条，4 个关键决定齐全）。

## 4. 规则改动（方案 B，Owner 批准的放宽）

`paygHostPolicy.ts` 的档案 schema 新增一种证据 `scope: "fusion-request-shape"`：至少 4 个样本、2 档大小、最大样本 ≥ 180000 B，
其余检查（输入 token/字节 ≤ 0.7、花费不超上限、缓存、输出语义、每个思考档位 2 条截断样本）和完整矩阵一样。

**只限评审团**：用这种证据的档案，用途只能是 `fusion_review` / `fusion_summary`，请求格式只能是 `fusion-json-v1-stream`；加上任何其他用途或格式，
档案整体不合格、准入拒绝。档案按"模型 + 线路"唯一，所以 Sol、Opus 的评审团档案不可能被普通对话、Skill、报告、整理等用途借用；
这些用途仍然要 #665 完整矩阵，规则不变。Sonnet、Gemini 的档案继续用原来的完整矩阵证据，只是加上评审用途。

为什么够用：评审团请求的形状是固定的（两条消息、无工具、中文 + JSON），完整矩阵里"英文、代码、工具调用、64–128 条历史消息"这些形状评审团永远不会发；
本次在真实形状上测了中档和贴近上限的大档，计费上限依赖的"每字节最多多少 token"在两档上都远低于规则线。

## 5. 花费

真实调用 21 次，合计 **2.5359 美元**（Owner 授权的 OpenRouter 测试余额，本任务上限 5 美元；Owner 2026-10-17 在执行窗口里逐项同意）：
Opus 4 次 1.5456（汇总对比 2 次 0.8724、大档 2 次 0.6731）；Sonnet 6 次 0.4825；Sol 6 次 0.4267；Gemini 5 次 0.0812。
经本机代理发出，发送前核对出口地区为 US。私有回执（完整输出）只留在本机，仓库只存数字、请求哈希和 generation id。

## 6. staging 写入清单（由总控执行，本 PR 不写）

每一步改前先存原值和 md5，回滚就是原样写回。

1. **思考设置**（优先走后台"模型管理 → 思考设置"，浏览器操作由 Codex 做；对话框里"评审""写作"两项提示"暂未接入任何调用"已过时，不影响保存）：
   Sonnet、Gemini、Sol 加"评审" = low（线路分别 anthropic、google-ai-studio、openai）；Opus 加"写作" = low（线路 anthropic）。
   等价的数据是 `config.reasoning.purposes.review` / `.writing` = `{"mode":"effort","effort":"low","wire":"reasoning_effort"}`。
2. **新增 Opus 模型行**：只在库内用 SQL 从 Sonnet 行（`d04a4800-…`，它的密钥就是测试窗口报价绑定的那把）复制密钥和接口，不读出、不打印：
   ```sql
   INSERT INTO ai_models (name, model_id, provider, api_key, api_endpoint, description, max_tokens, input_limit, enable_web_search,
     input_token_cost, output_token_cost, input_token_cost_above_200k, output_token_cost_above_200k, web_search_cost,
     token_counting_supported, token_counting_method, tokenizer_family, is_active, config, price_multiplier)
   SELECT 'claude-opus-5.5', 'anthropic/claude-opus-5.5', provider, api_key, api_endpoint, 'FUSION-REVIEW 汇总（Owner 2026-10-17）',
     128000, 1000000, 'false', 4000000, 20000000, 4000000, 20000000, 0,
     token_counting_supported, token_counting_method, tokenizer_family, 'true', NULL, NULL
   FROM ai_models WHERE id = 'd04a4800-2d3a-43b3-8af9-cb960572e34f'
   RETURNING id;
   ```
   之后在后台点"同步价格/目录"填好 `config.pricing` 和目录，再做第 1 步的"写作"。回滚：`DELETE FROM ai_models WHERE id = <返回的 id>`（在任何调用使用它之前）。
3. **测试窗口报价**（`runtime_test_windows` 9d02a18e 的 `call_policies`）：
   - 加 Opus：provider openrouter、protocol openrouter-chat-v1、account 与现有条目相同、inputLimit 196608、outputLimit 32768、multiplier 3、
     providerLimits `{providerSlug:"anthropic", contextTokens:1000000, promptUsdPerMillion:"4", completionUsdPerMillion:"20", cacheWriteUsdPerMillion:"5", requestUsd:"0"}`、
     upperUsd 按 `openRouterBound` 计算、automaticRetry false、hiddenTools false、lookupSupported true。
   - Sol 改现价：promptUsdPerMillion "2"、completionUsdPerMillion "10"、cacheWriteUsdPerMillion "2.5"，inputLimit 90000 → 196608，upperUsd 重算。
4. **`runtime_payg_staging`**：
   - Sonnet、Gemini 两条：`purposes` 加 `fusion_review`；`requestFormats` 加 `fusion-json-v1-stream`；`profileVersion` 改为 `pr665-r9+fusion-20261017`。
     现有 low 变体的 outputLimit 32768 已覆盖评审的 4096，其他字段不动。
   - 追加 Sol、Opus 两条：照抄档案草稿文件里的 `profiles`（Sol 只开 `fusion_review`，Opus 只开 `fusion_summary`）。
   - 写入前用 `paygHostSettings` 校验整份 value（本 PR 合并后的 schema 才认 `fusion-request-shape` 证据，所以 Sol、Opus 两条要等本 PR 合并部署后再写）。
5. **后台评审团设置**（走后台页面，Codex 操作）：评审 A Sonnet、B Sol、C Gemini，汇总 Opus，评审 Skill 选 report-review，保存并打开。
   保存会对每个模型重走准入，打开成功本身就是第 1–4 步的验证。
