# FUSION-COMPARE：对比模式的计费档案取证

> 状态：取证完成（2026-10-23）；staging 写入由总控执行（第 5 节）。
> 依据：[FUSION-COMPARE 方案](tasks/FUSION-COMPARE.md) 第 8 节问题 4；规则放宽见 [FUSION_PROFILE.md](FUSION_PROFILE.md) 第 4 节同一类做法。
> 证据 [fusion-compare-20261023.json](evidence/fusion-compare-20261023.json)（sha256 `07aeefd7890e9b7a81bc618087649a15512b42fe326ad462655201c0a50ba74f`）；
> 写入补丁 [fusion-compare-20261023.profiles-draft.json](evidence/fusion-compare-20261023.profiles-draft.json)。

## 0. Owner 的决定

- 2026-10-17 原话（方案第 8 节问题 4）："对比计费档案选 A，预算 2 美元"——把评审团"只按实际会发的请求取证"的放宽扩到对比，四个模型合计真实调用上限 2 美元。
- 2026-10-23 原话（经总控转达）："同意 FUSION-COMPARE PR-4 用本机代理对 Sol、Opus 做对比档案取证，合计不超过 2 美元。"

## 1. 做了什么

- **范围**：只对 Sol（`openai/gpt-6.1-sol`）和 Opus（`anthropic/claude-opus-5.5`）取证。Sonnet、Gemini 的档案用的是 #665 完整矩阵证据（含 64–128 条历史消息、工具、英文和代码），对比的请求形状（系统指令 + 对话历史 + 问题，纯文本，不带工具）是它的子集，不需要再花钱，只要给档案加用途和格式。
- **请求**：用仓库里真实的 `compareRequest` → `fusionRequestBody` 组装，思考 low，provider 单线路、不回退，web 插件关闭；历史是合成的中文内容规划对话（不含任何用户数据）。每个模型 4 次：中档大小（约 3.9–4.3 万字节）3 次、大档（约 18.6 万字节，每次调用字节上限 196608 减去 8192 余量后的上限）1 次。其中 3 次把输出上限压到档案的 `testedOutputLimit`（Sol 512、Opus 2048）做截断测试。
- **执行**：Codex 通过美国住宅 IP 代理（出口核对 `loc=US`），8 次调用都返回 200。

## 2. 结果

| 样本 | 请求字节 | 输出上限 | 结束原因 | 输入 token | 输出 token | 输入 token / 字节 | 实际花费（美元） | 低于上限公式 |
| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | :---: |
| Sol 中档 | 39331 | 8192 | stop | 10877 | 821 | 0.2766 | 0.0354 | 是 |
| Sol 中档压力 1 | 41769 | 512 | length | 11561 | 512 | 0.2768 | 0.0340 | 是 |
| Sol 中档压力 2 | 43395 | 512 | length | 12017 | 512 | 0.2769 | 0.0352 | 是 |
| Sol 大档压力 | 185926 | 512 | length | 51917 | 512 | 0.2792 | 0.1349 | 是 |
| Opus 中档 | 39342 | 32768 | stop | 14348 | 1721 | 0.3647 | 0.0918 | 是 |
| Opus 中档压力 1 | 41780 | 2048 | stop | 15248 | 1412 | 0.3650 | 0.0892 | 是 |
| Opus 中档压力 2 | 43406 | 2048 | stop | 15848 | 1560 | 0.3651 | 0.0946 | 是 |
| Opus 大档压力 | 185937 | 2048 | stop | 68348 | 1335 | 0.3676 | 0.3001 | 是 |

- 合计 **0.8152 美元**（上限 2 美元），Sol 0.2395、Opus 0.5757。
- 输入 token / 字节最大 0.3676（Opus），远低于规则线 0.7；缓存 token 都不超过输入；每条花费都低于产品的上限公式（`openRouterCallBound`，输入按"字节 + 8192"计 token）。
- Sol 的 3 次压力样本都在上限处截断（`finish=length`，输出正好 512），证明 Sol 的"输出上限包含思考"在对比请求上同样成立。

## 3. Opus 的截断证据：不需要补测（Owner 2026-10-23 决定）

Owner 决定不补测 Opus 的截断。依据：

- 所有模型走同一套输出上限代码：`max_tokens` 由我们的代码传给 OpenRouter，不是模型自己定；
- Sol 的 3 次压力样本都被截断在 512，证明上限会被执行，计费按上限冻结；
- 8 条样本的实际花费都在单次上界内；
- Opus 这次 3 次都在上限内自然结束，所以 Opus 的截断路径这次没有观察到。


补充说明（工程侧的理由）：Opus 的 3 次压力样本都自然结束（`finish=stop`，输出 1335–1560，没到 2048）。不补测还因为：

1. 规则要的"输出上限包含思考"是模型加线路的属性，不是请求内容的属性。Opus 在同一条线路（anthropic）、同一个上限（2048）、同一个思考档位（low）上已有 2 条截断样本（[FUSION_PROFILE.md](FUSION_PROFILE.md) 第 3 节，含思考 1213、1312 token，`outputStressSamples: 2`），档案的 `outputStressSamples`、`testedOutputLimit` 沿用那份证据，对比样本只证明"请求形状"那几项（字节、成本上限、缓存）。
2. 对比的回答是自由文本，没有格式要求；被截断的回答照常保存、展示、按实际用量收费，不会因为截断变成无法使用（评审团的 JSON 输出才怕截断）。
3. 钱的上限不依赖这次有没有触顶：每列的冻结额按"输入上限 × 输入单价 + 回答上限 × 输出单价"算（上限公式），8 条样本的实际花费都低于它；Opus 回答自然结束时实际花费更低，只会多退，不会多扣。

结论：档案规则不要求 Opus 的对比截断样本；规则里 `compareShape.testedOutputLimit` 必须等于档案证据里的 `testedOutputLimit`（Opus 2048、Sol 512），这一点两个模型都满足（Opus 压力样本的输出上限设的是 2048）。

## 4. 规则（`paygHostPolicy.ts`，本 PR）

形状证据 `scope: "fusion-request-shape"` 可以多带 `compareShape`（对比请求上的样本）：≥4 个样本、2 档大小、最大样本 ≥180000 B，输入 token/字节和 token/上限都不超过 0.7，缓存和成本上限检查通过，`testedOutputLimit` 与档案证据一致。有 `compareShape` 的档案才能带 `fusion-text-v1-stream` 格式和 `fusion_compare` 用途；没有就仍然只能评审团用。形状证据档案的用途只能是 Fusion 三种之一；普通对话、Skill、报告、整理仍然要完整矩阵。档案的用途上限从 8 种改为 9 种。

## 5. staging 写入清单（由总控执行，本 PR 不写）

每一步改前先存原值和 md5，回滚就是原样写回。

1. **思考设置**（对比的回答按普通对话用"交互"档位 `interactive`）：Sol、Opus 的 `config.reasoning.purposes.interactive` 加 `{"mode":"effort","effort":"low","wire":"reasoning_effort"}`（Sonnet、Gemini 普通对话已有）。
2. **`runtime_payg_staging.profiles`**：按补丁文件逐个模型处理（在现有那条同模型同线路的档案上改，其余字段不动）：
   - Sol、Opus：`purposes` 加 `fusion_compare`，`requestFormats` 加 `fusion-text-v1-stream`，`evidence.compareShape` 照补丁文件填；
   - Sonnet、Gemini：只加 `fusion_compare` 和 `fusion-text-v1-stream`（完整矩阵证据，不用 `compareShape`）。
   写完后在后台"Fusion 设置"的对比模型列表里，四个模型都应出现。
3. **`fusion_settings.compare`**（验收期间，开关由总控临时打开，验完关闭）：
   - `allowedModelIds`：Sonnet、Gemini、Sol、Opus 四个模型的编号；`defaultModelIds`：其中 3 个（Owner 没定默认组，验收期间用 Sonnet、Gemini、Sol）；`minModels` 2；
   - **`answerOutputTokens` 设为 8192**：对比的每一列必须用同一个回答上限，Sol 的档案上限是 8192，设得更高 Sol 会被判"回答上限需要降低"而不能入选（后台保存也会拒绝）；将来提高 Sol 的档案上限后再调高；
   - `maxBudgetUsd` 验收期间设 5（四个列的上限之和，正式值由 Owner 定）；
   - 对比开关打开，同时给一个 Gold 测试账号（会员权限 `allow_fusion_compare` 沿用现状，不改会员配置）。
4. **测试窗口报价**：四个模型都已有报价（评审团用过）；写入前用 `deriveFrozenPrices` 核对价格没变（沿用 FUSION_PROFILE.md 第 6 节第 3 步的取值规则），不要手算。

## 6. 花费

真实调用 8 次，合计 **0.8152 美元**（Owner 批准上限 2 美元），经 Codex 本机代理发出，出口 US。私有回执只留在 Codex 本机，仓库只存数字、请求哈希和 generation id 的哈希。
