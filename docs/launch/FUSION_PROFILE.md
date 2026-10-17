# FUSION-PROFILE：评审团模型的逐次计费档案和汇总模型实测

> 状态：第一段完成（2026-10-17）。Sonnet / Gemini 作为评审的档案证据已齐；Sol / Opus 的完整采样矩阵等 Owner 定方案（见第 4 节）。
> 依据：[FUSION-REVIEW](tasks/FUSION-REVIEW.md) 第 6 节 FUSION-PROFILE 一行；采样方法 [#665](https://github.com/Crnobog9527/GraylumAI_vercel/pull/665)
> （[BILL_PAYG_PROFILE_FINAL](BILL_PAYG_PROFILE_FINAL.md)）；证据 [fusion-profile-20261017.json](evidence/fusion-profile-20261017.json)
> （sha256 `371536f53bb25c36f1baee839d709bd4f2a94222d64f816ab199f80ee5db4e48`）。

## 0. Owner 的模型决定

Owner 2026-10-17 原话："评审模型： Claude Sonnet 5.5、chatgpt 6 sol、Gemini 3.8 Flash；汇总模型： Claude opus 5.5"。
对应 OpenRouter：评审 A `anthropic/claude-sonnet-5.5`（线路 anthropic）、评审 B `openai/gpt-6.1-sol`（线路 openai）、
评审 C `google/gemini-3.8-flash`（线路 google-ai-studio）；汇总 `anthropic/claude-opus-5.5`（线路 anthropic，目录价每百万输入 4 美元、输出 20 美元）。
汇总模型由 Owner 指定，FUSION-REVIEW 原来"比较候选汇总模型再定默认"的做法由这条决定取代；第 2 节的实测用来确认 Opus 能不能胜任。

## 1. 为什么后台评审团选不到模型（2026-10-17 只读核对 staging）

`fusionModelOptions` 对每个模型分别按评审、汇总两种用途走一次真实准入，四个模型都过不了：

| 卡点 | Sonnet | Gemini | Sol | Opus |
| --- | --- | --- | --- | --- |
| 模型设置里的思考档位（`config.reasoning.purposes`）没有 review / writing | 缺 | 缺 | 缺 | 模型不存在 |
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

## 3. 评审团请求格式的实测（Sonnet / Gemini，思考 low）

请求都是 `fusionRequestBody` 生成的真实字节：第 1 轮评审、第 2 轮辩论各原样重放一次；把资料字段补长到 185999 B 测大请求；
再把输出上限压到档案的 `testedOutputLimit`（Sonnet 2048、Gemini 512）测截断语义。全部 `provider.only` 单线路、不回退、web 插件关闭。

| 模型 | 样本 | 请求字节 | 输入 token / 字节 | 结束 | 输出 / 上限 | 花费 |
| --- | --- | ---: | ---: | --- | ---: | ---: |
| Gemini | 第 1 轮重放 | 41991 | 0.249 | STOP | 1721 / 4096 | 0.0143 |
| Gemini | 第 2 轮重放 | 59673 | 0.242 | STOP | 1631 / 4096 | 0.0169 |
| Gemini | 大请求 | 185959 | 0.261 | STOP | 1410 / 4096 | 0.0417 |
| Gemini | 截断 ×2 | 41990 / 59672 | — | MAX_TOKENS ×2 | 498 / 512 ×2 | 0.0082 |
| Sonnet | 第 1 轮重放 | 41975 | 0.396 | end_turn | 2497 / 4096 | 0.0582 |
| Sonnet | 第 2 轮重放 | 59657 | 0.387 | end_turn | 2549 / 4096 | 0.0717 |
| Sonnet | 大请求 | 185999 | 0.401 | end_turn | 1966 / 4096 | 0.1688 |
| Sonnet | 截断 ×3 | 59657 / 41975 / 59657 | — | max_tokens ×2、end_turn ×1 | 2048 / 2048 ×2 | 0.1838 |

- 输入 token / 字节最大 0.401，低于档案已证明的上限（Sonnet 0.562、Gemini 0.463）和规则线 0.7；每次实际花费都低于按冻结报价算的上限。
- 输出上限包含思考：截断样本都停在上限内（Gemini 498/512、Sonnet 2048/2048）。Sonnet 的第 2 条截断样本输出本身不到 2048，没有触顶，按 #665 规则另补一条，触顶样本合计 2 条。
- 思考 low 时 Sonnet 和 Gemini 的思考 token 都是 0（Opus 汇总是 1691），所以评审 4096 的上限基本全用于正文。
- 4 份正常输出用产品的 `parseOpinion` 解析都是可用意见（Gemini 3 条问题、Sonnet 5–6 条问题，4 个关键决定齐全）。

## 4. 还没做的：Sol 和 Opus 的完整采样矩阵（等 Owner 定）

档案 schema 要求每个模型都有 #665 的完整矩阵（60 个样本，5 类内容 × 3 档大小 × 4 个变体，最大 196608 B；再加 12 个多消息样本）。
Sonnet、Gemini 已有；Sol、Opus 没有。按 #665 的实际花费推算：Sol 约 4.6 美元，Opus 约 9.1 美元。已报总控请 Owner 二选一：

- **A（推荐）**：照 #665 原方法做完整矩阵，总预算提到 18 美元。计费检查不放宽，证据和现有模型同一个标准。
- **B**：只按评审团实际的请求形状取证（约 3.5 美元），要改 schema 让"只给评审团用的档案"接受较小的证据集——属于放宽计费检查，要 Owner 批准。

## 5. 本段花费

真实调用 13 次，合计 **1.4361 美元**（Owner 授权的 OpenRouter 测试余额，本轮上限 5 美元，总控和 Owner 2026-10-17 在执行窗口里同意）：
Opus 汇总 2 次 0.8724；Gemini 5 次 0.0811；Sonnet 6 次 0.4825。经本机代理发出，发送前核对出口地区为 US。
私有回执（完整输出）只留在本机，仓库只存数字和请求哈希。

## 6. staging 写入清单（由总控执行，本 PR 不写）

第一批（现在就能做，证据已齐）：

1. **Sonnet、Gemini 的思考设置**：`ai_models.config.reasoning.purposes` 加
   `"review": {"mode":"effort","effort":"low","wire":"reasoning_effort"}`（和现有 interactive 同形）。回滚：删掉 review 键（改前先存整段 config 的 md5）。
2. **`runtime_payg_staging` 里 Sonnet、Gemini 两条档案**：`purposes` 加 `fusion_review`；`requestFormats` 加 `fusion-json-v1-stream`；
   `profileVersion` 改为 `pr665-r9+fusion-20261017-a`（这个值会冻结进每次调用的报价，作为正式依据的记录）。
   现有 low 变体的 outputLimit 32768 已覆盖评审的 4096，不新增变体；其他字段不动。回滚：改前存整份 value 和 md5，原样写回。

第二批（等第 4 节的方案和 Sol/Opus 采样完成后）：

3. 新增 Opus 模型行（`anthropic/claude-opus-5.5`，route anthropic，`purposes.writing` 用 low；密钥用 staging 的 OpenRouter 测试密钥——密钥操作要 Owner 同意）。
4. 测试窗口 `call_policies` 加 Opus 报价（anthropic，$4/$20、cacheWrite $5，contextTokens 1000000，inputLimit 196608，outputLimit 32768，upperUsd 用 `openRouterCallBound` 算）；
   Sol 报价更新为现价 $2/$10（cacheWrite $2.5）、inputLimit 196608。
5. Sol 的 `purposes.review`、Opus/Sol 两条档案（Opus 只开 `fusion_summary`，Sol 只开 `fusion_review`）。
6. 后台评审团设置（走后台页面，浏览器操作由 Codex 做）：评审 A Sonnet、B Sol、C Gemini，汇总 Opus，评审 Skill 选 report-review，打开。
