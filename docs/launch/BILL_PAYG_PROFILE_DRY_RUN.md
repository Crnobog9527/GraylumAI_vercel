# BILL-PAYG profile 无付费预演（2026-10-05）

**采样计划和执行器完成，等待审查后执行。** 当前真实调用 0 次，费用 $0；独立审查及真实采样 NOT_RUN。
本文件取代 #662 的 32 条消息、历史假设报价预演。真实 128 条 profile 尚未获证明，不能启用配置。

manifestHash：`4289cffc98ac5fda57b46e93e8a7e3d083b30ab71223428a961d118593bad9c5`。

[逐样本完整清单](evidence/payg-profile-20261005.manifest.json)包含 B、T、O、消息条数、requestHash、批准的单次限制和费用预留。
清单、最终请求及费用均可复现：

```bash
node scripts/payg-profile.mjs plan scripts/payg-profile/plan-prices.json /tmp/payg-profile-manifest.json
```

离线工具不含发送、凭据、查账或数据库入口；两次预演逐字节一致。

## 当前线路与能力

报价取自 OpenRouter 2026-10-05 公共 models 及精确 endpoint API；
[报价配置](../../scripts/payg-profile/plan-prices.json)、[目录快照](../../scripts/payg-profile/catalog-2026-10-05.json)。
表中输入/输出/缓存写入/缓存读取为 USD/百万 token，请求费为 USD/次；写入表示目录的写入报价，
Gemini 只用隐式缓存，不创建有持续存储费用的缓存资源。无搜索、媒体、收费服务端工具或 1h 缓存。

| 模型 / 精确 tag | 输入 / 输出 / 写入 / 读取 | 请求费 | context / 最大输出 |
| --- | --- | ---: | ---: |
| anthropic/claude-sonnet-5.5 / `anthropic` | 2.000000000000 / 10.000000000000 / 2.500000000000 / 0.200000000000 | 0 | 1000000 / 128000 |
| google/gemini-3.8-flash / `google-vertex/global` | 0.750000000000 / 3.750000000000 / 0.041666666667 / 0.075000000000 | 0 | 1048576 / 65536 |
| openai/gpt-6-luna / `openai` | 0.100000000000 / 0.500000000000 / 0.125000000000 / 0.010000000000 | 0 | 1050000 / 128000 |

请求费字段在这三条目录中均缺省，按目录接口的无逐请求费语义记 0；单价未重复应用 discount。
Gemini 写入百万价向上保留 12 位小数；它低于普通输入价，因此不抬高本次保守上界。
Luna 的加价档从 272000 输入 token 开始，超过本清单 T 的最大值 204800；完整档位仍保留在快照。
执行前逐次检查原线路的全部 pricing（含档位）、容量、输出上限、参数和状态；漂移即停，不能原地换报价继续。

三条线路的 supported_parameters 都包含 `reasoning_effort`；matrix 和多消息样本实际发送
`reasoning_effort:"low"`，输出压力分别覆盖它与完全不传 reasoning 参数，每种两条。
**Luna + require_parameters:true 在当前目录层面支持，未发现需退回无参数的条件；真实兼容性未调用验证。**
不传参数不等于关闭思考：目录中 Sonnet mandatory、默认 high；Gemini mandatory、默认 medium；Luna 默认 medium。
本次不生成 none-effort/medium 等未实测组合的配置建议。

输出 O 依据 [OpenRouter 的 combined token 说明](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens#reasoning-tokens-and-max_tokens)
计入 reasoning；Gemini 同时依据 [Google 输出上限说明](https://ai.google.dev/gemini-api/docs/generate-content/thinking#token-limits-and-max_output_tokens)。
**具体风险：**[Google 论坛的一手复现](https://discuss.ai.google.dev/t/gemini-3-8-flash-high-does-maxoutputtokens-include-thinking-tokens/181077/4)
报告过 Gemini 3.8 Flash 在 low 下越过 combined 上限，与文档不一致。这里的 outputCapIncludesReasoning 是文档语义，
不是本任务的实测结论。每个模型先跑输出压力，实际 completion（含 reasoning）超过 O 就失败并停止整批，绝不扩大 O。

## 覆盖与判定

保留 180 条矩阵：3 模型 × 5 类（中文、英文、代码、JSON、工具）× 3 长度档 × 4 变体。
另有 36 条消息压力：每模型 64/96/128 条 × 短/长消息 × 2 变体。长消息内容分布在每条历史中，
不是只把最终输入拉长。短档 B=16384，长档 B=180000，重复系统前缀相同、当前输入不同；
Sonnet 标记 ephemeral，其他模型使用自动缓存。原矩阵仍保留 B=196608 的完整边界及 16384 schema bytes。
另有 12 条 O=8192 输出压力；180+36 的 O=1024 不替代这层证据。

所有样本 B 为最终规范化、缓存标记、store:false 和路由参数后的 UTF-8 字节；T=B+4096+4096。
实际 P 使用原生总 prompt tokens，不扣缓存命中。回执保留 B、P、rB=P/B、rT=P/T、
max(0,P-B)（逐消息模板所需余量）、费用、completion/reasoning 与缓存读写 token、原始回执 hash。
单条需 rB≤0.70、rT≤0.70、P−B≤8192、总 completion≤O、实际费用≤原 upperUsd。
这些只是有限样本的经验准入证明，不是 tokenizer 对任意文本的数学保证。

**目前任何消息条数都还不能声称已真实证明。** 第二步逐模型/长度/条数报告；若 128 失败，
只报告完整合格格子中最多能证明的条数（例如 64 或 96），不能把失败格删除后宣布 128 合格。
每个模型的 profile 还要求原 60 个不同矩阵样本全部合格、多消息 12 条全部合格、缓存命中/写入证据可核验，
每个 reasoning 的两个输出压力样本触及 O 并包含 reasoning；未触及上限只能说明该次未超限，不能充作完整压力证明。
配置校验新增 messageStressSamples=12、maxVerifiedMessages=128 摘要要求；合成测试摘要绝不能用于启用。

[#561](https://github.com/Crnobog9527/GraylumAI_vercel/pull/561) 的最终交接记录有 80 条已结算主评测，
但请求/输出 profile、字节模板、缓存与消息密度不匹配本次冻结清单；不抵扣、不伪造同 profile 覆盖。
本次零复用重新申请整份清单，旧批次花费不混入本次费用。

## 费用上界

| 模型 | 样本数 | 费用上界 USD |
| --- | ---: | ---: |
| anthropic/claude-sonnet-5.5 | 76 | 16.672787500000 |
| google/gemini-3.8-flash | 76 | 5.081520750000 |
| openai/gpt-6-luna | 76 | 0.833594375000 |
| 合计 | 228 | **22.587902625000** |

原 10 个 Sonnet 大档（每类 variant 2/3）采用本会话批准的 $0.55，实际预留仍为各自 upperUsd，
最高 $0.52224。其他 Sonnet 单次 $0.50、Gemini $0.25、Luna $0.05；新增长消息不借用 $0.55 例外。
模型总额分别受 $30/$15/$3 限制，总额不超过 $48；不得挪用、补样本或充值。

**上界的实际含义：**执行器发送前按 T、O、冻结单价精确预留，并用 provider.max_price、单线路、
无 fallback 和 max_tokens 限制请求。OpenRouter 没有逐请求美元熔断参数；max_price 只限制单价，
不能当作缓存收费上限或远端绝不会越过 token 上限的保证。若上游违反文档或尚未校准的 P>T，
该次已发生费用可能超过预留；执行器只能如实记失败、停止后续调用，不能追回已花费用。
这项风险须随清单由主窗口审阅，不将 $22.59 描述成无条件的外部扣款硬保证。

## 执行与恢复边界

独立付费入口：`scripts/payg-profile-execute.mjs`，只有主窗口审阅并通知后才能调用。
完整操作和故障处理见 [执行说明](BILL_PAYG_PROFILE_EXECUTOR.md)。第一步未加载任何模型凭据、未调用付费入口。
重复启动同一 manifest 拒绝；发送前落盘并同步预留，未知发送不重试，无 ID 不猜测；有原 ID 时最多 GET 查账 3 次。
失败、冲突或不合格即停，不自动补跑。重启不续发，先人工审计本机材料；未实际发送的也不会自动凑数。
公开报告只上传结构、hash、金额和判定；完整 provider 回执只存本机受控目录，不上传正文、账号或任何凭据。

## 历史恢复与本机迁移

128 条上限贯穿 profile、稳定/逐次计费 schema、历史预留和 SQL 校验。
普通历史原有 100 条不变；预留 system/current 两条和每个工具轮次四条，字节裁剪仍生效。
旧冻结 maxMessages=32 继续严格受 32 限制；开关仍默认关闭。
`0172_payg_profile_messages.sql` 仅改一处 SQL 的全局最大值，有前驱指纹防漂移，可重复执行，
不改已有请求、表、授权或数据。没有应用到远端；以后开启前需由获准窗口应用迁移。
回退优先关闭新准入，已有冻结执行收尾；不能在 128 条执行尚未结束时强降 SQL 上限。
#661 也使用待合并的 0172，并更新 built-fingerprint；当前 staging 最新为 0171，迁移检查禁止跳号。
本 PR 因此使用当前合法的 0172；指纹仅改本函数一项。两个 PR 不能原样一起合入；
主窗口排定先后后，后合入者须重编号、重放并合并指纹差异。本任务不合并，也不修改 #661。

## 每个样本费用预留

下表是生成清单的可读视图；身份与 requestHash 以链接的完整 JSON 为准。

| 样本 | 消息数 | B | O | 费用上界 USD | 批准的单次上限 |
| --- | ---: | ---: | ---: | ---: | ---: |
| anthropic/claude-sonnet-5.5:output:chinese:output-stress:0 | 2 | 4096 | 8192 | 0.112640000000 | 0.50 |
| anthropic/claude-sonnet-5.5:output:code:output-stress:1 | 2 | 4096 | 8192 | 0.112640000000 | 0.50 |
| anthropic/claude-sonnet-5.5:output:chinese:output-stress:2 | 2 | 4096 | 8192 | 0.112640000000 | 0.50 |
| anthropic/claude-sonnet-5.5:output:code:output-stress:3 | 2 | 4096 | 8192 | 0.112640000000 | 0.50 |
| anthropic/claude-sonnet-5.5:matrix:chinese:small:0 | 2 | 489 | 1024 | 0.031942500000 | 0.50 |
| anthropic/claude-sonnet-5.5:matrix:chinese:small:1 | 2 | 3829 | 1024 | 0.040292500000 | 0.50 |
| anthropic/claude-sonnet-5.5:matrix:chinese:small:2 | 2 | 3932 | 1024 | 0.040550000000 | 0.50 |
| anthropic/claude-sonnet-5.5:matrix:chinese:small:3 | 2 | 4096 | 1024 | 0.040960000000 | 0.50 |
| anthropic/claude-sonnet-5.5:matrix:chinese:medium:0 | 2 | 29818 | 1024 | 0.105265000000 | 0.50 |
| anthropic/claude-sonnet-5.5:matrix:chinese:medium:1 | 2 | 30638 | 1024 | 0.107315000000 | 0.50 |
| anthropic/claude-sonnet-5.5:matrix:chinese:medium:2 | 2 | 31457 | 1024 | 0.109362500000 | 0.50 |
| anthropic/claude-sonnet-5.5:matrix:chinese:medium:3 | 2 | 32768 | 1024 | 0.112640000000 | 0.50 |
| anthropic/claude-sonnet-5.5:matrix:chinese:large:0 | 2 | 178913 | 1024 | 0.478002500000 | 0.50 |
| anthropic/claude-sonnet-5.5:matrix:chinese:large:1 | 2 | 183828 | 1024 | 0.490290000000 | 0.50 |
| anthropic/claude-sonnet-5.5:matrix:chinese:large:2 | 2 | 188743 | 1024 | 0.502577500000 | 0.55 |
| anthropic/claude-sonnet-5.5:matrix:chinese:large:3 | 2 | 196608 | 1024 | 0.522240000000 | 0.55 |
| anthropic/claude-sonnet-5.5:matrix:english:small:0 | 2 | 489 | 1024 | 0.031942500000 | 0.50 |
| anthropic/claude-sonnet-5.5:matrix:english:small:1 | 2 | 3829 | 1024 | 0.040292500000 | 0.50 |
| anthropic/claude-sonnet-5.5:matrix:english:small:2 | 2 | 3932 | 1024 | 0.040550000000 | 0.50 |
| anthropic/claude-sonnet-5.5:matrix:english:small:3 | 2 | 4096 | 1024 | 0.040960000000 | 0.50 |
| anthropic/claude-sonnet-5.5:matrix:english:medium:0 | 2 | 29818 | 1024 | 0.105265000000 | 0.50 |
| anthropic/claude-sonnet-5.5:matrix:english:medium:1 | 2 | 30638 | 1024 | 0.107315000000 | 0.50 |
| anthropic/claude-sonnet-5.5:matrix:english:medium:2 | 2 | 31457 | 1024 | 0.109362500000 | 0.50 |
| anthropic/claude-sonnet-5.5:matrix:english:medium:3 | 2 | 32768 | 1024 | 0.112640000000 | 0.50 |
| anthropic/claude-sonnet-5.5:matrix:english:large:0 | 2 | 178913 | 1024 | 0.478002500000 | 0.50 |
| anthropic/claude-sonnet-5.5:matrix:english:large:1 | 2 | 183828 | 1024 | 0.490290000000 | 0.50 |
| anthropic/claude-sonnet-5.5:matrix:english:large:2 | 2 | 188743 | 1024 | 0.502577500000 | 0.55 |
| anthropic/claude-sonnet-5.5:matrix:english:large:3 | 2 | 196608 | 1024 | 0.522240000000 | 0.55 |
| anthropic/claude-sonnet-5.5:matrix:code:small:0 | 2 | 486 | 1024 | 0.031935000000 | 0.50 |
| anthropic/claude-sonnet-5.5:matrix:code:small:1 | 2 | 3829 | 1024 | 0.040292500000 | 0.50 |
| anthropic/claude-sonnet-5.5:matrix:code:small:2 | 2 | 3932 | 1024 | 0.040550000000 | 0.50 |
| anthropic/claude-sonnet-5.5:matrix:code:small:3 | 2 | 4096 | 1024 | 0.040960000000 | 0.50 |
| anthropic/claude-sonnet-5.5:matrix:code:medium:0 | 2 | 29818 | 1024 | 0.105265000000 | 0.50 |
| anthropic/claude-sonnet-5.5:matrix:code:medium:1 | 2 | 30638 | 1024 | 0.107315000000 | 0.50 |
| anthropic/claude-sonnet-5.5:matrix:code:medium:2 | 2 | 31457 | 1024 | 0.109362500000 | 0.50 |
| anthropic/claude-sonnet-5.5:matrix:code:medium:3 | 2 | 32768 | 1024 | 0.112640000000 | 0.50 |
| anthropic/claude-sonnet-5.5:matrix:code:large:0 | 2 | 178913 | 1024 | 0.478002500000 | 0.50 |
| anthropic/claude-sonnet-5.5:matrix:code:large:1 | 2 | 183828 | 1024 | 0.490290000000 | 0.50 |
| anthropic/claude-sonnet-5.5:matrix:code:large:2 | 2 | 188743 | 1024 | 0.502577500000 | 0.55 |
| anthropic/claude-sonnet-5.5:matrix:code:large:3 | 2 | 196608 | 1024 | 0.522240000000 | 0.55 |
| anthropic/claude-sonnet-5.5:matrix:json:small:0 | 2 | 486 | 1024 | 0.031935000000 | 0.50 |
| anthropic/claude-sonnet-5.5:matrix:json:small:1 | 2 | 3829 | 1024 | 0.040292500000 | 0.50 |
| anthropic/claude-sonnet-5.5:matrix:json:small:2 | 2 | 3932 | 1024 | 0.040550000000 | 0.50 |
| anthropic/claude-sonnet-5.5:matrix:json:small:3 | 2 | 4096 | 1024 | 0.040960000000 | 0.50 |
| anthropic/claude-sonnet-5.5:matrix:json:medium:0 | 2 | 29818 | 1024 | 0.105265000000 | 0.50 |
| anthropic/claude-sonnet-5.5:matrix:json:medium:1 | 2 | 30638 | 1024 | 0.107315000000 | 0.50 |
| anthropic/claude-sonnet-5.5:matrix:json:medium:2 | 2 | 31457 | 1024 | 0.109362500000 | 0.50 |
| anthropic/claude-sonnet-5.5:matrix:json:medium:3 | 2 | 32768 | 1024 | 0.112640000000 | 0.50 |
| anthropic/claude-sonnet-5.5:matrix:json:large:0 | 2 | 178913 | 1024 | 0.478002500000 | 0.50 |
| anthropic/claude-sonnet-5.5:matrix:json:large:1 | 2 | 183828 | 1024 | 0.490290000000 | 0.50 |
| anthropic/claude-sonnet-5.5:matrix:json:large:2 | 2 | 188743 | 1024 | 0.502577500000 | 0.55 |
| anthropic/claude-sonnet-5.5:matrix:json:large:3 | 2 | 196608 | 1024 | 0.522240000000 | 0.55 |
| anthropic/claude-sonnet-5.5:matrix:tools:small:0 | 2 | 751 | 1024 | 0.032597500000 | 0.50 |
| anthropic/claude-sonnet-5.5:matrix:tools:small:1 | 2 | 3829 | 1024 | 0.040292500000 | 0.50 |
| anthropic/claude-sonnet-5.5:matrix:tools:small:2 | 2 | 3932 | 1024 | 0.040550000000 | 0.50 |
| anthropic/claude-sonnet-5.5:matrix:tools:small:3 | 2 | 4096 | 1024 | 0.040960000000 | 0.50 |
| anthropic/claude-sonnet-5.5:matrix:tools:medium:0 | 32 | 29818 | 1024 | 0.105265000000 | 0.50 |
| anthropic/claude-sonnet-5.5:matrix:tools:medium:1 | 32 | 30638 | 1024 | 0.107315000000 | 0.50 |
| anthropic/claude-sonnet-5.5:matrix:tools:medium:2 | 32 | 31457 | 1024 | 0.109362500000 | 0.50 |
| anthropic/claude-sonnet-5.5:matrix:tools:medium:3 | 32 | 32768 | 1024 | 0.112640000000 | 0.50 |
| anthropic/claude-sonnet-5.5:matrix:tools:large:0 | 32 | 178913 | 1024 | 0.478002500000 | 0.50 |
| anthropic/claude-sonnet-5.5:matrix:tools:large:1 | 32 | 183828 | 1024 | 0.490290000000 | 0.50 |
| anthropic/claude-sonnet-5.5:matrix:tools:large:2 | 32 | 188743 | 1024 | 0.502577500000 | 0.55 |
| anthropic/claude-sonnet-5.5:matrix:tools:large:3 | 32 | 196608 | 1024 | 0.522240000000 | 0.55 |
| anthropic/claude-sonnet-5.5:messages:english:short-64:0 | 64 | 16384 | 1024 | 0.071680000000 | 0.50 |
| anthropic/claude-sonnet-5.5:messages:english:short-64:1 | 64 | 16384 | 1024 | 0.071680000000 | 0.50 |
| anthropic/claude-sonnet-5.5:messages:english:long-64:0 | 64 | 180000 | 1024 | 0.480720000000 | 0.50 |
| anthropic/claude-sonnet-5.5:messages:english:long-64:1 | 64 | 180000 | 1024 | 0.480720000000 | 0.50 |
| anthropic/claude-sonnet-5.5:messages:english:short-96:0 | 96 | 16384 | 1024 | 0.071680000000 | 0.50 |
| anthropic/claude-sonnet-5.5:messages:english:short-96:1 | 96 | 16384 | 1024 | 0.071680000000 | 0.50 |
| anthropic/claude-sonnet-5.5:messages:english:long-96:0 | 96 | 180000 | 1024 | 0.480720000000 | 0.50 |
| anthropic/claude-sonnet-5.5:messages:english:long-96:1 | 96 | 180000 | 1024 | 0.480720000000 | 0.50 |
| anthropic/claude-sonnet-5.5:messages:english:short-128:0 | 128 | 16384 | 1024 | 0.071680000000 | 0.50 |
| anthropic/claude-sonnet-5.5:messages:english:short-128:1 | 128 | 16384 | 1024 | 0.071680000000 | 0.50 |
| anthropic/claude-sonnet-5.5:messages:english:long-128:0 | 128 | 180000 | 1024 | 0.480720000000 | 0.50 |
| anthropic/claude-sonnet-5.5:messages:english:long-128:1 | 128 | 180000 | 1024 | 0.480720000000 | 0.50 |
| google/gemini-3.8-flash:output:chinese:output-stress:0 | 2 | 4096 | 8192 | 0.039936000000 | 0.25 |
| google/gemini-3.8-flash:output:code:output-stress:1 | 2 | 4096 | 8192 | 0.039936000000 | 0.25 |
| google/gemini-3.8-flash:output:chinese:output-stress:2 | 2 | 4096 | 8192 | 0.039936000000 | 0.25 |
| google/gemini-3.8-flash:output:code:output-stress:3 | 2 | 4096 | 8192 | 0.039936000000 | 0.25 |
| google/gemini-3.8-flash:matrix:chinese:small:0 | 2 | 439 | 1024 | 0.010313250000 | 0.25 |
| google/gemini-3.8-flash:matrix:chinese:small:1 | 2 | 3829 | 1024 | 0.012855750000 | 0.25 |
| google/gemini-3.8-flash:matrix:chinese:small:2 | 2 | 3932 | 1024 | 0.012933000000 | 0.25 |
| google/gemini-3.8-flash:matrix:chinese:small:3 | 2 | 4096 | 1024 | 0.013056000000 | 0.25 |
| google/gemini-3.8-flash:matrix:chinese:medium:0 | 2 | 29818 | 1024 | 0.032347500000 | 0.25 |
| google/gemini-3.8-flash:matrix:chinese:medium:1 | 2 | 30638 | 1024 | 0.032962500000 | 0.25 |
| google/gemini-3.8-flash:matrix:chinese:medium:2 | 2 | 31457 | 1024 | 0.033576750000 | 0.25 |
| google/gemini-3.8-flash:matrix:chinese:medium:3 | 2 | 32768 | 1024 | 0.034560000000 | 0.25 |
| google/gemini-3.8-flash:matrix:chinese:large:0 | 2 | 178913 | 1024 | 0.144168750000 | 0.25 |
| google/gemini-3.8-flash:matrix:chinese:large:1 | 2 | 183828 | 1024 | 0.147855000000 | 0.25 |
| google/gemini-3.8-flash:matrix:chinese:large:2 | 2 | 188743 | 1024 | 0.151541250000 | 0.25 |
| google/gemini-3.8-flash:matrix:chinese:large:3 | 2 | 196608 | 1024 | 0.157440000000 | 0.25 |
| google/gemini-3.8-flash:matrix:english:small:0 | 2 | 439 | 1024 | 0.010313250000 | 0.25 |
| google/gemini-3.8-flash:matrix:english:small:1 | 2 | 3829 | 1024 | 0.012855750000 | 0.25 |
| google/gemini-3.8-flash:matrix:english:small:2 | 2 | 3932 | 1024 | 0.012933000000 | 0.25 |
| google/gemini-3.8-flash:matrix:english:small:3 | 2 | 4096 | 1024 | 0.013056000000 | 0.25 |
| google/gemini-3.8-flash:matrix:english:medium:0 | 2 | 29818 | 1024 | 0.032347500000 | 0.25 |
| google/gemini-3.8-flash:matrix:english:medium:1 | 2 | 30638 | 1024 | 0.032962500000 | 0.25 |
| google/gemini-3.8-flash:matrix:english:medium:2 | 2 | 31457 | 1024 | 0.033576750000 | 0.25 |
| google/gemini-3.8-flash:matrix:english:medium:3 | 2 | 32768 | 1024 | 0.034560000000 | 0.25 |
| google/gemini-3.8-flash:matrix:english:large:0 | 2 | 178913 | 1024 | 0.144168750000 | 0.25 |
| google/gemini-3.8-flash:matrix:english:large:1 | 2 | 183828 | 1024 | 0.147855000000 | 0.25 |
| google/gemini-3.8-flash:matrix:english:large:2 | 2 | 188743 | 1024 | 0.151541250000 | 0.25 |
| google/gemini-3.8-flash:matrix:english:large:3 | 2 | 196608 | 1024 | 0.157440000000 | 0.25 |
| google/gemini-3.8-flash:matrix:code:small:0 | 2 | 436 | 1024 | 0.010311000000 | 0.25 |
| google/gemini-3.8-flash:matrix:code:small:1 | 2 | 3829 | 1024 | 0.012855750000 | 0.25 |
| google/gemini-3.8-flash:matrix:code:small:2 | 2 | 3932 | 1024 | 0.012933000000 | 0.25 |
| google/gemini-3.8-flash:matrix:code:small:3 | 2 | 4096 | 1024 | 0.013056000000 | 0.25 |
| google/gemini-3.8-flash:matrix:code:medium:0 | 2 | 29818 | 1024 | 0.032347500000 | 0.25 |
| google/gemini-3.8-flash:matrix:code:medium:1 | 2 | 30638 | 1024 | 0.032962500000 | 0.25 |
| google/gemini-3.8-flash:matrix:code:medium:2 | 2 | 31457 | 1024 | 0.033576750000 | 0.25 |
| google/gemini-3.8-flash:matrix:code:medium:3 | 2 | 32768 | 1024 | 0.034560000000 | 0.25 |
| google/gemini-3.8-flash:matrix:code:large:0 | 2 | 178913 | 1024 | 0.144168750000 | 0.25 |
| google/gemini-3.8-flash:matrix:code:large:1 | 2 | 183828 | 1024 | 0.147855000000 | 0.25 |
| google/gemini-3.8-flash:matrix:code:large:2 | 2 | 188743 | 1024 | 0.151541250000 | 0.25 |
| google/gemini-3.8-flash:matrix:code:large:3 | 2 | 196608 | 1024 | 0.157440000000 | 0.25 |
| google/gemini-3.8-flash:matrix:json:small:0 | 2 | 436 | 1024 | 0.010311000000 | 0.25 |
| google/gemini-3.8-flash:matrix:json:small:1 | 2 | 3829 | 1024 | 0.012855750000 | 0.25 |
| google/gemini-3.8-flash:matrix:json:small:2 | 2 | 3932 | 1024 | 0.012933000000 | 0.25 |
| google/gemini-3.8-flash:matrix:json:small:3 | 2 | 4096 | 1024 | 0.013056000000 | 0.25 |
| google/gemini-3.8-flash:matrix:json:medium:0 | 2 | 29818 | 1024 | 0.032347500000 | 0.25 |
| google/gemini-3.8-flash:matrix:json:medium:1 | 2 | 30638 | 1024 | 0.032962500000 | 0.25 |
| google/gemini-3.8-flash:matrix:json:medium:2 | 2 | 31457 | 1024 | 0.033576750000 | 0.25 |
| google/gemini-3.8-flash:matrix:json:medium:3 | 2 | 32768 | 1024 | 0.034560000000 | 0.25 |
| google/gemini-3.8-flash:matrix:json:large:0 | 2 | 178913 | 1024 | 0.144168750000 | 0.25 |
| google/gemini-3.8-flash:matrix:json:large:1 | 2 | 183828 | 1024 | 0.147855000000 | 0.25 |
| google/gemini-3.8-flash:matrix:json:large:2 | 2 | 188743 | 1024 | 0.151541250000 | 0.25 |
| google/gemini-3.8-flash:matrix:json:large:3 | 2 | 196608 | 1024 | 0.157440000000 | 0.25 |
| google/gemini-3.8-flash:matrix:tools:small:0 | 2 | 701 | 1024 | 0.010509750000 | 0.25 |
| google/gemini-3.8-flash:matrix:tools:small:1 | 2 | 3829 | 1024 | 0.012855750000 | 0.25 |
| google/gemini-3.8-flash:matrix:tools:small:2 | 2 | 3932 | 1024 | 0.012933000000 | 0.25 |
| google/gemini-3.8-flash:matrix:tools:small:3 | 2 | 4096 | 1024 | 0.013056000000 | 0.25 |
| google/gemini-3.8-flash:matrix:tools:medium:0 | 32 | 29818 | 1024 | 0.032347500000 | 0.25 |
| google/gemini-3.8-flash:matrix:tools:medium:1 | 32 | 30638 | 1024 | 0.032962500000 | 0.25 |
| google/gemini-3.8-flash:matrix:tools:medium:2 | 32 | 31457 | 1024 | 0.033576750000 | 0.25 |
| google/gemini-3.8-flash:matrix:tools:medium:3 | 32 | 32768 | 1024 | 0.034560000000 | 0.25 |
| google/gemini-3.8-flash:matrix:tools:large:0 | 32 | 178913 | 1024 | 0.144168750000 | 0.25 |
| google/gemini-3.8-flash:matrix:tools:large:1 | 32 | 183828 | 1024 | 0.147855000000 | 0.25 |
| google/gemini-3.8-flash:matrix:tools:large:2 | 32 | 188743 | 1024 | 0.151541250000 | 0.25 |
| google/gemini-3.8-flash:matrix:tools:large:3 | 32 | 196608 | 1024 | 0.157440000000 | 0.25 |
| google/gemini-3.8-flash:messages:english:short-64:0 | 64 | 16384 | 1024 | 0.022272000000 | 0.25 |
| google/gemini-3.8-flash:messages:english:short-64:1 | 64 | 16384 | 1024 | 0.022272000000 | 0.25 |
| google/gemini-3.8-flash:messages:english:long-64:0 | 64 | 180000 | 1024 | 0.144984000000 | 0.25 |
| google/gemini-3.8-flash:messages:english:long-64:1 | 64 | 180000 | 1024 | 0.144984000000 | 0.25 |
| google/gemini-3.8-flash:messages:english:short-96:0 | 96 | 16384 | 1024 | 0.022272000000 | 0.25 |
| google/gemini-3.8-flash:messages:english:short-96:1 | 96 | 16384 | 1024 | 0.022272000000 | 0.25 |
| google/gemini-3.8-flash:messages:english:long-96:0 | 96 | 180000 | 1024 | 0.144984000000 | 0.25 |
| google/gemini-3.8-flash:messages:english:long-96:1 | 96 | 180000 | 1024 | 0.144984000000 | 0.25 |
| google/gemini-3.8-flash:messages:english:short-128:0 | 128 | 16384 | 1024 | 0.022272000000 | 0.25 |
| google/gemini-3.8-flash:messages:english:short-128:1 | 128 | 16384 | 1024 | 0.022272000000 | 0.25 |
| google/gemini-3.8-flash:messages:english:long-128:0 | 128 | 180000 | 1024 | 0.144984000000 | 0.25 |
| google/gemini-3.8-flash:messages:english:long-128:1 | 128 | 180000 | 1024 | 0.144984000000 | 0.25 |
| openai/gpt-6-luna:output:chinese:output-stress:0 | 2 | 4096 | 8192 | 0.005632000000 | 0.05 |
| openai/gpt-6-luna:output:code:output-stress:1 | 2 | 4096 | 8192 | 0.005632000000 | 0.05 |
| openai/gpt-6-luna:output:chinese:output-stress:2 | 2 | 4096 | 8192 | 0.005632000000 | 0.05 |
| openai/gpt-6-luna:output:code:output-stress:3 | 2 | 4096 | 8192 | 0.005632000000 | 0.05 |
| openai/gpt-6-luna:matrix:chinese:small:0 | 2 | 417 | 1024 | 0.001588125000 | 0.05 |
| openai/gpt-6-luna:matrix:chinese:small:1 | 2 | 3829 | 1024 | 0.002014625000 | 0.05 |
| openai/gpt-6-luna:matrix:chinese:small:2 | 2 | 3932 | 1024 | 0.002027500000 | 0.05 |
| openai/gpt-6-luna:matrix:chinese:small:3 | 2 | 4096 | 1024 | 0.002048000000 | 0.05 |
| openai/gpt-6-luna:matrix:chinese:medium:0 | 2 | 29818 | 1024 | 0.005263250000 | 0.05 |
| openai/gpt-6-luna:matrix:chinese:medium:1 | 2 | 30638 | 1024 | 0.005365750000 | 0.05 |
| openai/gpt-6-luna:matrix:chinese:medium:2 | 2 | 31457 | 1024 | 0.005468125000 | 0.05 |
| openai/gpt-6-luna:matrix:chinese:medium:3 | 2 | 32768 | 1024 | 0.005632000000 | 0.05 |
| openai/gpt-6-luna:matrix:chinese:large:0 | 2 | 178913 | 1024 | 0.023900125000 | 0.05 |
| openai/gpt-6-luna:matrix:chinese:large:1 | 2 | 183828 | 1024 | 0.024514500000 | 0.05 |
| openai/gpt-6-luna:matrix:chinese:large:2 | 2 | 188743 | 1024 | 0.025128875000 | 0.05 |
| openai/gpt-6-luna:matrix:chinese:large:3 | 2 | 196608 | 1024 | 0.026112000000 | 0.05 |
| openai/gpt-6-luna:matrix:english:small:0 | 2 | 417 | 1024 | 0.001588125000 | 0.05 |
| openai/gpt-6-luna:matrix:english:small:1 | 2 | 3829 | 1024 | 0.002014625000 | 0.05 |
| openai/gpt-6-luna:matrix:english:small:2 | 2 | 3932 | 1024 | 0.002027500000 | 0.05 |
| openai/gpt-6-luna:matrix:english:small:3 | 2 | 4096 | 1024 | 0.002048000000 | 0.05 |
| openai/gpt-6-luna:matrix:english:medium:0 | 2 | 29818 | 1024 | 0.005263250000 | 0.05 |
| openai/gpt-6-luna:matrix:english:medium:1 | 2 | 30638 | 1024 | 0.005365750000 | 0.05 |
| openai/gpt-6-luna:matrix:english:medium:2 | 2 | 31457 | 1024 | 0.005468125000 | 0.05 |
| openai/gpt-6-luna:matrix:english:medium:3 | 2 | 32768 | 1024 | 0.005632000000 | 0.05 |
| openai/gpt-6-luna:matrix:english:large:0 | 2 | 178913 | 1024 | 0.023900125000 | 0.05 |
| openai/gpt-6-luna:matrix:english:large:1 | 2 | 183828 | 1024 | 0.024514500000 | 0.05 |
| openai/gpt-6-luna:matrix:english:large:2 | 2 | 188743 | 1024 | 0.025128875000 | 0.05 |
| openai/gpt-6-luna:matrix:english:large:3 | 2 | 196608 | 1024 | 0.026112000000 | 0.05 |
| openai/gpt-6-luna:matrix:code:small:0 | 2 | 414 | 1024 | 0.001587750000 | 0.05 |
| openai/gpt-6-luna:matrix:code:small:1 | 2 | 3829 | 1024 | 0.002014625000 | 0.05 |
| openai/gpt-6-luna:matrix:code:small:2 | 2 | 3932 | 1024 | 0.002027500000 | 0.05 |
| openai/gpt-6-luna:matrix:code:small:3 | 2 | 4096 | 1024 | 0.002048000000 | 0.05 |
| openai/gpt-6-luna:matrix:code:medium:0 | 2 | 29818 | 1024 | 0.005263250000 | 0.05 |
| openai/gpt-6-luna:matrix:code:medium:1 | 2 | 30638 | 1024 | 0.005365750000 | 0.05 |
| openai/gpt-6-luna:matrix:code:medium:2 | 2 | 31457 | 1024 | 0.005468125000 | 0.05 |
| openai/gpt-6-luna:matrix:code:medium:3 | 2 | 32768 | 1024 | 0.005632000000 | 0.05 |
| openai/gpt-6-luna:matrix:code:large:0 | 2 | 178913 | 1024 | 0.023900125000 | 0.05 |
| openai/gpt-6-luna:matrix:code:large:1 | 2 | 183828 | 1024 | 0.024514500000 | 0.05 |
| openai/gpt-6-luna:matrix:code:large:2 | 2 | 188743 | 1024 | 0.025128875000 | 0.05 |
| openai/gpt-6-luna:matrix:code:large:3 | 2 | 196608 | 1024 | 0.026112000000 | 0.05 |
| openai/gpt-6-luna:matrix:json:small:0 | 2 | 414 | 1024 | 0.001587750000 | 0.05 |
| openai/gpt-6-luna:matrix:json:small:1 | 2 | 3829 | 1024 | 0.002014625000 | 0.05 |
| openai/gpt-6-luna:matrix:json:small:2 | 2 | 3932 | 1024 | 0.002027500000 | 0.05 |
| openai/gpt-6-luna:matrix:json:small:3 | 2 | 4096 | 1024 | 0.002048000000 | 0.05 |
| openai/gpt-6-luna:matrix:json:medium:0 | 2 | 29818 | 1024 | 0.005263250000 | 0.05 |
| openai/gpt-6-luna:matrix:json:medium:1 | 2 | 30638 | 1024 | 0.005365750000 | 0.05 |
| openai/gpt-6-luna:matrix:json:medium:2 | 2 | 31457 | 1024 | 0.005468125000 | 0.05 |
| openai/gpt-6-luna:matrix:json:medium:3 | 2 | 32768 | 1024 | 0.005632000000 | 0.05 |
| openai/gpt-6-luna:matrix:json:large:0 | 2 | 178913 | 1024 | 0.023900125000 | 0.05 |
| openai/gpt-6-luna:matrix:json:large:1 | 2 | 183828 | 1024 | 0.024514500000 | 0.05 |
| openai/gpt-6-luna:matrix:json:large:2 | 2 | 188743 | 1024 | 0.025128875000 | 0.05 |
| openai/gpt-6-luna:matrix:json:large:3 | 2 | 196608 | 1024 | 0.026112000000 | 0.05 |
| openai/gpt-6-luna:matrix:tools:small:0 | 2 | 679 | 1024 | 0.001620875000 | 0.05 |
| openai/gpt-6-luna:matrix:tools:small:1 | 2 | 3829 | 1024 | 0.002014625000 | 0.05 |
| openai/gpt-6-luna:matrix:tools:small:2 | 2 | 3932 | 1024 | 0.002027500000 | 0.05 |
| openai/gpt-6-luna:matrix:tools:small:3 | 2 | 4096 | 1024 | 0.002048000000 | 0.05 |
| openai/gpt-6-luna:matrix:tools:medium:0 | 32 | 29818 | 1024 | 0.005263250000 | 0.05 |
| openai/gpt-6-luna:matrix:tools:medium:1 | 32 | 30638 | 1024 | 0.005365750000 | 0.05 |
| openai/gpt-6-luna:matrix:tools:medium:2 | 32 | 31457 | 1024 | 0.005468125000 | 0.05 |
| openai/gpt-6-luna:matrix:tools:medium:3 | 32 | 32768 | 1024 | 0.005632000000 | 0.05 |
| openai/gpt-6-luna:matrix:tools:large:0 | 32 | 178913 | 1024 | 0.023900125000 | 0.05 |
| openai/gpt-6-luna:matrix:tools:large:1 | 32 | 183828 | 1024 | 0.024514500000 | 0.05 |
| openai/gpt-6-luna:matrix:tools:large:2 | 32 | 188743 | 1024 | 0.025128875000 | 0.05 |
| openai/gpt-6-luna:matrix:tools:large:3 | 32 | 196608 | 1024 | 0.026112000000 | 0.05 |
| openai/gpt-6-luna:messages:english:short-64:0 | 64 | 16384 | 1024 | 0.003584000000 | 0.05 |
| openai/gpt-6-luna:messages:english:short-64:1 | 64 | 16384 | 1024 | 0.003584000000 | 0.05 |
| openai/gpt-6-luna:messages:english:long-64:0 | 64 | 180000 | 1024 | 0.024036000000 | 0.05 |
| openai/gpt-6-luna:messages:english:long-64:1 | 64 | 180000 | 1024 | 0.024036000000 | 0.05 |
| openai/gpt-6-luna:messages:english:short-96:0 | 96 | 16384 | 1024 | 0.003584000000 | 0.05 |
| openai/gpt-6-luna:messages:english:short-96:1 | 96 | 16384 | 1024 | 0.003584000000 | 0.05 |
| openai/gpt-6-luna:messages:english:long-96:0 | 96 | 180000 | 1024 | 0.024036000000 | 0.05 |
| openai/gpt-6-luna:messages:english:long-96:1 | 96 | 180000 | 1024 | 0.024036000000 | 0.05 |
| openai/gpt-6-luna:messages:english:short-128:0 | 128 | 16384 | 1024 | 0.003584000000 | 0.05 |
| openai/gpt-6-luna:messages:english:short-128:1 | 128 | 16384 | 1024 | 0.003584000000 | 0.05 |
| openai/gpt-6-luna:messages:english:long-128:0 | 128 | 180000 | 1024 | 0.024036000000 | 0.05 |
| openai/gpt-6-luna:messages:english:long-128:1 | 128 | 180000 | 1024 | 0.024036000000 | 0.05 |
