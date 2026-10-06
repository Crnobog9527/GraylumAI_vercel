# BILL-PAYG 第三批离线预演（2026-10-06）

**历史第三批记录。当前准备见 [r4/r5](BILL_PAYG_PROFILE_R4_R5.md)；不再执行第三批。** 本轮没有发送真实请求，不读取专用凭据，不查询出口、目录、余额或回执。

批次 `payg-profile-20261006-r3`；manifestHash：`3cbeb87e1e9895527cf8e56c611337c897ef28bb7df637412724c05949be5e74`。
[完整 manifest](evidence/payg-profile-20261006-r3.manifest.json) 包含逐条 requestHash、B/T/O、线路、reasoning、单条限制、历史证据和费用。
[第二批公开结果](https://github.com/Crnobog9527/GraylumAI_vercel/pull/665#issuecomment-5998404793)、
[主窗口审计](https://github.com/Crnobog9527/GraylumAI_vercel/pull/665#issuecomment-5998458038)、
[第 49 条 $0 核实](https://github.com/Crnobog9527/GraylumAI_vercel/pull/665#issuecomment-5998488867)、
[累计限额 $25 决定](https://github.com/Crnobog9527/GraylumAI_vercel/pull/665#issuecomment-5998517105)。

## 样本与复用

第二批 48 条 WITHIN 全部保留在 manifest.retainedEvidence，只含结构、hash、token、费用与判定；没有正文、原 ID 或原始回执。
其中 44 条矩阵已完成，不发送；4 条输出压力中仅第 1 条真正触及 8192，保留这一条上限证据。
其余 3 条仍保留为未超界的观测，但不算完成输出压力验收；替换为新内容和新 ID 的压力样本。
第三批 = 原剩余 180 条（第 49 条加原 179 条未执行）+ 3 条缺失输出压力的新样本 = **183 条**。

- 矩阵 136 条，和旧 44 条合计 180 个原定格子；仅各模型各变体的 json:large 共 12 条替换为普通商品记录。
- 多消息 36 条不变：各模型的 64/96/128 条、短/长消息及两变体。
- 新输出压力 11 条，和旧已触顶的 1 条形成每模型每种 reasoning 各 2 条的目标覆盖。
- 所有修订样本 ID 增加 `:r3`；未修改的待采样样本逐字段及 requestHash 与第二批一致。
- 已完成 48 条的原 requestHash 均不出现在第三批发送清单；所有新样本 B、T、O、单价和单条上限与对应旧样本相等。

输出压力在 system/user 要求从 000001 到 010000 逐行输出固定格式，不概括、不省略、不提前停止。
这会请求远超 O=8192 的输出长度，但**无法保证模型遵从**；只能由真实回执验证 length + nativeCompletionTokens=8192，且包含 reasoning。
任何样本越界/拒绝/未知则立即停批；提前正常结束仍如实记未触顶，不自动补样本、不放宽准入。
准备阶段只验证提示和覆盖结构，不宣称已经取得输出上限证明。三个模型目前均无可启用 profile，64/96/128 档仍需真实证明。

## 费用

| 项目 | 条数 | 上界 USD |
| --- | ---: | ---: |
| Sonnet 5.5 | 31 | 8.227522500000 |
| Gemini 3.8 Flash | 76 | 5.081520750000 |
| GPT-6 Luna | 76 | 0.833594375000 |
| 第三批 | 183 | **14.142637625000** |
| 前两批已入账 | — | **2.596497700000** |
| 累计上界 | — | **16.739135325000 < 25** |

第一批 hash `4289cffc98ac5fda57b46e93e8a7e3d083b30ab71223428a961d118593bad9c5`，Owner 接受 $0 入账；
第二批 hash `596c57a3839de657e46058d16d8a558af2c84d3ea4b79b74e80a9b96e4a10ef7`，48 条确认 $2.5964977，第 49 条 Owner 后台核实后按 $0 入账。
历史 UNKNOWN 回执保持原样，没有伪造结算凭证。第三批累计校验拒绝大于或等于 $25 的计划。
单条原上限保持 Sonnet $0.50 / 原大档 $0.55、Gemini $0.25、Luna $0.05；新批次中剩余 4 条采用 $0.55，另外 6 条已完成不重发。
最大单条预留仍 $0.522240000000。上界是预留而非上游美元熔断，真实越界也必须如实停止和记录。
报价配置和目录快照保持不变；本轮离线，不冒称重新获得实时报价，获准执行时仍须逐次通过精确目录检查。

## 逐条预留（真实执行 NOT_RUN）

| 样本 ID | B | T | O | 原批准单条上限 USD | 本次预留上界 USD |
| --- | ---: | ---: | ---: | ---: | ---: |
| anthropic/claude-sonnet-5.5:output:code:output-stress:1:r3 | 4096 | 12288 | 8192 | 0.50 | 0.112640000000 |
| anthropic/claude-sonnet-5.5:output:chinese:output-stress:2:r3 | 4096 | 12288 | 8192 | 0.50 | 0.112640000000 |
| anthropic/claude-sonnet-5.5:output:code:output-stress:3:r3 | 4096 | 12288 | 8192 | 0.50 | 0.112640000000 |
| anthropic/claude-sonnet-5.5:matrix:json:large:0:r3 | 178913 | 187105 | 1024 | 0.50 | 0.478002500000 |
| anthropic/claude-sonnet-5.5:matrix:json:large:1:r3 | 183828 | 192020 | 1024 | 0.50 | 0.490290000000 |
| anthropic/claude-sonnet-5.5:matrix:json:large:2:r3 | 188743 | 196935 | 1024 | 0.55 | 0.502577500000 |
| anthropic/claude-sonnet-5.5:matrix:json:large:3:r3 | 196608 | 204800 | 1024 | 0.55 | 0.522240000000 |
| anthropic/claude-sonnet-5.5:matrix:tools:small:0 | 751 | 8943 | 1024 | 0.50 | 0.032597500000 |
| anthropic/claude-sonnet-5.5:matrix:tools:small:1 | 3829 | 12021 | 1024 | 0.50 | 0.040292500000 |
| anthropic/claude-sonnet-5.5:matrix:tools:small:2 | 3932 | 12124 | 1024 | 0.50 | 0.040550000000 |
| anthropic/claude-sonnet-5.5:matrix:tools:small:3 | 4096 | 12288 | 1024 | 0.50 | 0.040960000000 |
| anthropic/claude-sonnet-5.5:matrix:tools:medium:0 | 29818 | 38010 | 1024 | 0.50 | 0.105265000000 |
| anthropic/claude-sonnet-5.5:matrix:tools:medium:1 | 30638 | 38830 | 1024 | 0.50 | 0.107315000000 |
| anthropic/claude-sonnet-5.5:matrix:tools:medium:2 | 31457 | 39649 | 1024 | 0.50 | 0.109362500000 |
| anthropic/claude-sonnet-5.5:matrix:tools:medium:3 | 32768 | 40960 | 1024 | 0.50 | 0.112640000000 |
| anthropic/claude-sonnet-5.5:matrix:tools:large:0 | 178913 | 187105 | 1024 | 0.50 | 0.478002500000 |
| anthropic/claude-sonnet-5.5:matrix:tools:large:1 | 183828 | 192020 | 1024 | 0.50 | 0.490290000000 |
| anthropic/claude-sonnet-5.5:matrix:tools:large:2 | 188743 | 196935 | 1024 | 0.55 | 0.502577500000 |
| anthropic/claude-sonnet-5.5:matrix:tools:large:3 | 196608 | 204800 | 1024 | 0.55 | 0.522240000000 |
| anthropic/claude-sonnet-5.5:messages:english:short-64:0 | 16384 | 24576 | 1024 | 0.50 | 0.071680000000 |
| anthropic/claude-sonnet-5.5:messages:english:short-64:1 | 16384 | 24576 | 1024 | 0.50 | 0.071680000000 |
| anthropic/claude-sonnet-5.5:messages:english:long-64:0 | 180000 | 188192 | 1024 | 0.50 | 0.480720000000 |
| anthropic/claude-sonnet-5.5:messages:english:long-64:1 | 180000 | 188192 | 1024 | 0.50 | 0.480720000000 |
| anthropic/claude-sonnet-5.5:messages:english:short-96:0 | 16384 | 24576 | 1024 | 0.50 | 0.071680000000 |
| anthropic/claude-sonnet-5.5:messages:english:short-96:1 | 16384 | 24576 | 1024 | 0.50 | 0.071680000000 |
| anthropic/claude-sonnet-5.5:messages:english:long-96:0 | 180000 | 188192 | 1024 | 0.50 | 0.480720000000 |
| anthropic/claude-sonnet-5.5:messages:english:long-96:1 | 180000 | 188192 | 1024 | 0.50 | 0.480720000000 |
| anthropic/claude-sonnet-5.5:messages:english:short-128:0 | 16384 | 24576 | 1024 | 0.50 | 0.071680000000 |
| anthropic/claude-sonnet-5.5:messages:english:short-128:1 | 16384 | 24576 | 1024 | 0.50 | 0.071680000000 |
| anthropic/claude-sonnet-5.5:messages:english:long-128:0 | 180000 | 188192 | 1024 | 0.50 | 0.480720000000 |
| anthropic/claude-sonnet-5.5:messages:english:long-128:1 | 180000 | 188192 | 1024 | 0.50 | 0.480720000000 |
| google/gemini-3.8-flash:output:chinese:output-stress:0:r3 | 4096 | 12288 | 8192 | 0.25 | 0.039936000000 |
| google/gemini-3.8-flash:output:code:output-stress:1:r3 | 4096 | 12288 | 8192 | 0.25 | 0.039936000000 |
| google/gemini-3.8-flash:output:chinese:output-stress:2:r3 | 4096 | 12288 | 8192 | 0.25 | 0.039936000000 |
| google/gemini-3.8-flash:output:code:output-stress:3:r3 | 4096 | 12288 | 8192 | 0.25 | 0.039936000000 |
| google/gemini-3.8-flash:matrix:chinese:small:0 | 439 | 8631 | 1024 | 0.25 | 0.010313250000 |
| google/gemini-3.8-flash:matrix:chinese:small:1 | 3829 | 12021 | 1024 | 0.25 | 0.012855750000 |
| google/gemini-3.8-flash:matrix:chinese:small:2 | 3932 | 12124 | 1024 | 0.25 | 0.012933000000 |
| google/gemini-3.8-flash:matrix:chinese:small:3 | 4096 | 12288 | 1024 | 0.25 | 0.013056000000 |
| google/gemini-3.8-flash:matrix:chinese:medium:0 | 29818 | 38010 | 1024 | 0.25 | 0.032347500000 |
| google/gemini-3.8-flash:matrix:chinese:medium:1 | 30638 | 38830 | 1024 | 0.25 | 0.032962500000 |
| google/gemini-3.8-flash:matrix:chinese:medium:2 | 31457 | 39649 | 1024 | 0.25 | 0.033576750000 |
| google/gemini-3.8-flash:matrix:chinese:medium:3 | 32768 | 40960 | 1024 | 0.25 | 0.034560000000 |
| google/gemini-3.8-flash:matrix:chinese:large:0 | 178913 | 187105 | 1024 | 0.25 | 0.144168750000 |
| google/gemini-3.8-flash:matrix:chinese:large:1 | 183828 | 192020 | 1024 | 0.25 | 0.147855000000 |
| google/gemini-3.8-flash:matrix:chinese:large:2 | 188743 | 196935 | 1024 | 0.25 | 0.151541250000 |
| google/gemini-3.8-flash:matrix:chinese:large:3 | 196608 | 204800 | 1024 | 0.25 | 0.157440000000 |
| google/gemini-3.8-flash:matrix:english:small:0 | 439 | 8631 | 1024 | 0.25 | 0.010313250000 |
| google/gemini-3.8-flash:matrix:english:small:1 | 3829 | 12021 | 1024 | 0.25 | 0.012855750000 |
| google/gemini-3.8-flash:matrix:english:small:2 | 3932 | 12124 | 1024 | 0.25 | 0.012933000000 |
| google/gemini-3.8-flash:matrix:english:small:3 | 4096 | 12288 | 1024 | 0.25 | 0.013056000000 |
| google/gemini-3.8-flash:matrix:english:medium:0 | 29818 | 38010 | 1024 | 0.25 | 0.032347500000 |
| google/gemini-3.8-flash:matrix:english:medium:1 | 30638 | 38830 | 1024 | 0.25 | 0.032962500000 |
| google/gemini-3.8-flash:matrix:english:medium:2 | 31457 | 39649 | 1024 | 0.25 | 0.033576750000 |
| google/gemini-3.8-flash:matrix:english:medium:3 | 32768 | 40960 | 1024 | 0.25 | 0.034560000000 |
| google/gemini-3.8-flash:matrix:english:large:0 | 178913 | 187105 | 1024 | 0.25 | 0.144168750000 |
| google/gemini-3.8-flash:matrix:english:large:1 | 183828 | 192020 | 1024 | 0.25 | 0.147855000000 |
| google/gemini-3.8-flash:matrix:english:large:2 | 188743 | 196935 | 1024 | 0.25 | 0.151541250000 |
| google/gemini-3.8-flash:matrix:english:large:3 | 196608 | 204800 | 1024 | 0.25 | 0.157440000000 |
| google/gemini-3.8-flash:matrix:code:small:0 | 436 | 8628 | 1024 | 0.25 | 0.010311000000 |
| google/gemini-3.8-flash:matrix:code:small:1 | 3829 | 12021 | 1024 | 0.25 | 0.012855750000 |
| google/gemini-3.8-flash:matrix:code:small:2 | 3932 | 12124 | 1024 | 0.25 | 0.012933000000 |
| google/gemini-3.8-flash:matrix:code:small:3 | 4096 | 12288 | 1024 | 0.25 | 0.013056000000 |
| google/gemini-3.8-flash:matrix:code:medium:0 | 29818 | 38010 | 1024 | 0.25 | 0.032347500000 |
| google/gemini-3.8-flash:matrix:code:medium:1 | 30638 | 38830 | 1024 | 0.25 | 0.032962500000 |
| google/gemini-3.8-flash:matrix:code:medium:2 | 31457 | 39649 | 1024 | 0.25 | 0.033576750000 |
| google/gemini-3.8-flash:matrix:code:medium:3 | 32768 | 40960 | 1024 | 0.25 | 0.034560000000 |
| google/gemini-3.8-flash:matrix:code:large:0 | 178913 | 187105 | 1024 | 0.25 | 0.144168750000 |
| google/gemini-3.8-flash:matrix:code:large:1 | 183828 | 192020 | 1024 | 0.25 | 0.147855000000 |
| google/gemini-3.8-flash:matrix:code:large:2 | 188743 | 196935 | 1024 | 0.25 | 0.151541250000 |
| google/gemini-3.8-flash:matrix:code:large:3 | 196608 | 204800 | 1024 | 0.25 | 0.157440000000 |
| google/gemini-3.8-flash:matrix:json:small:0 | 436 | 8628 | 1024 | 0.25 | 0.010311000000 |
| google/gemini-3.8-flash:matrix:json:small:1 | 3829 | 12021 | 1024 | 0.25 | 0.012855750000 |
| google/gemini-3.8-flash:matrix:json:small:2 | 3932 | 12124 | 1024 | 0.25 | 0.012933000000 |
| google/gemini-3.8-flash:matrix:json:small:3 | 4096 | 12288 | 1024 | 0.25 | 0.013056000000 |
| google/gemini-3.8-flash:matrix:json:medium:0 | 29818 | 38010 | 1024 | 0.25 | 0.032347500000 |
| google/gemini-3.8-flash:matrix:json:medium:1 | 30638 | 38830 | 1024 | 0.25 | 0.032962500000 |
| google/gemini-3.8-flash:matrix:json:medium:2 | 31457 | 39649 | 1024 | 0.25 | 0.033576750000 |
| google/gemini-3.8-flash:matrix:json:medium:3 | 32768 | 40960 | 1024 | 0.25 | 0.034560000000 |
| google/gemini-3.8-flash:matrix:json:large:0:r3 | 178913 | 187105 | 1024 | 0.25 | 0.144168750000 |
| google/gemini-3.8-flash:matrix:json:large:1:r3 | 183828 | 192020 | 1024 | 0.25 | 0.147855000000 |
| google/gemini-3.8-flash:matrix:json:large:2:r3 | 188743 | 196935 | 1024 | 0.25 | 0.151541250000 |
| google/gemini-3.8-flash:matrix:json:large:3:r3 | 196608 | 204800 | 1024 | 0.25 | 0.157440000000 |
| google/gemini-3.8-flash:matrix:tools:small:0 | 701 | 8893 | 1024 | 0.25 | 0.010509750000 |
| google/gemini-3.8-flash:matrix:tools:small:1 | 3829 | 12021 | 1024 | 0.25 | 0.012855750000 |
| google/gemini-3.8-flash:matrix:tools:small:2 | 3932 | 12124 | 1024 | 0.25 | 0.012933000000 |
| google/gemini-3.8-flash:matrix:tools:small:3 | 4096 | 12288 | 1024 | 0.25 | 0.013056000000 |
| google/gemini-3.8-flash:matrix:tools:medium:0 | 29818 | 38010 | 1024 | 0.25 | 0.032347500000 |
| google/gemini-3.8-flash:matrix:tools:medium:1 | 30638 | 38830 | 1024 | 0.25 | 0.032962500000 |
| google/gemini-3.8-flash:matrix:tools:medium:2 | 31457 | 39649 | 1024 | 0.25 | 0.033576750000 |
| google/gemini-3.8-flash:matrix:tools:medium:3 | 32768 | 40960 | 1024 | 0.25 | 0.034560000000 |
| google/gemini-3.8-flash:matrix:tools:large:0 | 178913 | 187105 | 1024 | 0.25 | 0.144168750000 |
| google/gemini-3.8-flash:matrix:tools:large:1 | 183828 | 192020 | 1024 | 0.25 | 0.147855000000 |
| google/gemini-3.8-flash:matrix:tools:large:2 | 188743 | 196935 | 1024 | 0.25 | 0.151541250000 |
| google/gemini-3.8-flash:matrix:tools:large:3 | 196608 | 204800 | 1024 | 0.25 | 0.157440000000 |
| google/gemini-3.8-flash:messages:english:short-64:0 | 16384 | 24576 | 1024 | 0.25 | 0.022272000000 |
| google/gemini-3.8-flash:messages:english:short-64:1 | 16384 | 24576 | 1024 | 0.25 | 0.022272000000 |
| google/gemini-3.8-flash:messages:english:long-64:0 | 180000 | 188192 | 1024 | 0.25 | 0.144984000000 |
| google/gemini-3.8-flash:messages:english:long-64:1 | 180000 | 188192 | 1024 | 0.25 | 0.144984000000 |
| google/gemini-3.8-flash:messages:english:short-96:0 | 16384 | 24576 | 1024 | 0.25 | 0.022272000000 |
| google/gemini-3.8-flash:messages:english:short-96:1 | 16384 | 24576 | 1024 | 0.25 | 0.022272000000 |
| google/gemini-3.8-flash:messages:english:long-96:0 | 180000 | 188192 | 1024 | 0.25 | 0.144984000000 |
| google/gemini-3.8-flash:messages:english:long-96:1 | 180000 | 188192 | 1024 | 0.25 | 0.144984000000 |
| google/gemini-3.8-flash:messages:english:short-128:0 | 16384 | 24576 | 1024 | 0.25 | 0.022272000000 |
| google/gemini-3.8-flash:messages:english:short-128:1 | 16384 | 24576 | 1024 | 0.25 | 0.022272000000 |
| google/gemini-3.8-flash:messages:english:long-128:0 | 180000 | 188192 | 1024 | 0.25 | 0.144984000000 |
| google/gemini-3.8-flash:messages:english:long-128:1 | 180000 | 188192 | 1024 | 0.25 | 0.144984000000 |
| openai/gpt-6-luna:output:chinese:output-stress:0:r3 | 4096 | 12288 | 8192 | 0.05 | 0.005632000000 |
| openai/gpt-6-luna:output:code:output-stress:1:r3 | 4096 | 12288 | 8192 | 0.05 | 0.005632000000 |
| openai/gpt-6-luna:output:chinese:output-stress:2:r3 | 4096 | 12288 | 8192 | 0.05 | 0.005632000000 |
| openai/gpt-6-luna:output:code:output-stress:3:r3 | 4096 | 12288 | 8192 | 0.05 | 0.005632000000 |
| openai/gpt-6-luna:matrix:chinese:small:0 | 417 | 8609 | 1024 | 0.05 | 0.001588125000 |
| openai/gpt-6-luna:matrix:chinese:small:1 | 3829 | 12021 | 1024 | 0.05 | 0.002014625000 |
| openai/gpt-6-luna:matrix:chinese:small:2 | 3932 | 12124 | 1024 | 0.05 | 0.002027500000 |
| openai/gpt-6-luna:matrix:chinese:small:3 | 4096 | 12288 | 1024 | 0.05 | 0.002048000000 |
| openai/gpt-6-luna:matrix:chinese:medium:0 | 29818 | 38010 | 1024 | 0.05 | 0.005263250000 |
| openai/gpt-6-luna:matrix:chinese:medium:1 | 30638 | 38830 | 1024 | 0.05 | 0.005365750000 |
| openai/gpt-6-luna:matrix:chinese:medium:2 | 31457 | 39649 | 1024 | 0.05 | 0.005468125000 |
| openai/gpt-6-luna:matrix:chinese:medium:3 | 32768 | 40960 | 1024 | 0.05 | 0.005632000000 |
| openai/gpt-6-luna:matrix:chinese:large:0 | 178913 | 187105 | 1024 | 0.05 | 0.023900125000 |
| openai/gpt-6-luna:matrix:chinese:large:1 | 183828 | 192020 | 1024 | 0.05 | 0.024514500000 |
| openai/gpt-6-luna:matrix:chinese:large:2 | 188743 | 196935 | 1024 | 0.05 | 0.025128875000 |
| openai/gpt-6-luna:matrix:chinese:large:3 | 196608 | 204800 | 1024 | 0.05 | 0.026112000000 |
| openai/gpt-6-luna:matrix:english:small:0 | 417 | 8609 | 1024 | 0.05 | 0.001588125000 |
| openai/gpt-6-luna:matrix:english:small:1 | 3829 | 12021 | 1024 | 0.05 | 0.002014625000 |
| openai/gpt-6-luna:matrix:english:small:2 | 3932 | 12124 | 1024 | 0.05 | 0.002027500000 |
| openai/gpt-6-luna:matrix:english:small:3 | 4096 | 12288 | 1024 | 0.05 | 0.002048000000 |
| openai/gpt-6-luna:matrix:english:medium:0 | 29818 | 38010 | 1024 | 0.05 | 0.005263250000 |
| openai/gpt-6-luna:matrix:english:medium:1 | 30638 | 38830 | 1024 | 0.05 | 0.005365750000 |
| openai/gpt-6-luna:matrix:english:medium:2 | 31457 | 39649 | 1024 | 0.05 | 0.005468125000 |
| openai/gpt-6-luna:matrix:english:medium:3 | 32768 | 40960 | 1024 | 0.05 | 0.005632000000 |
| openai/gpt-6-luna:matrix:english:large:0 | 178913 | 187105 | 1024 | 0.05 | 0.023900125000 |
| openai/gpt-6-luna:matrix:english:large:1 | 183828 | 192020 | 1024 | 0.05 | 0.024514500000 |
| openai/gpt-6-luna:matrix:english:large:2 | 188743 | 196935 | 1024 | 0.05 | 0.025128875000 |
| openai/gpt-6-luna:matrix:english:large:3 | 196608 | 204800 | 1024 | 0.05 | 0.026112000000 |
| openai/gpt-6-luna:matrix:code:small:0 | 414 | 8606 | 1024 | 0.05 | 0.001587750000 |
| openai/gpt-6-luna:matrix:code:small:1 | 3829 | 12021 | 1024 | 0.05 | 0.002014625000 |
| openai/gpt-6-luna:matrix:code:small:2 | 3932 | 12124 | 1024 | 0.05 | 0.002027500000 |
| openai/gpt-6-luna:matrix:code:small:3 | 4096 | 12288 | 1024 | 0.05 | 0.002048000000 |
| openai/gpt-6-luna:matrix:code:medium:0 | 29818 | 38010 | 1024 | 0.05 | 0.005263250000 |
| openai/gpt-6-luna:matrix:code:medium:1 | 30638 | 38830 | 1024 | 0.05 | 0.005365750000 |
| openai/gpt-6-luna:matrix:code:medium:2 | 31457 | 39649 | 1024 | 0.05 | 0.005468125000 |
| openai/gpt-6-luna:matrix:code:medium:3 | 32768 | 40960 | 1024 | 0.05 | 0.005632000000 |
| openai/gpt-6-luna:matrix:code:large:0 | 178913 | 187105 | 1024 | 0.05 | 0.023900125000 |
| openai/gpt-6-luna:matrix:code:large:1 | 183828 | 192020 | 1024 | 0.05 | 0.024514500000 |
| openai/gpt-6-luna:matrix:code:large:2 | 188743 | 196935 | 1024 | 0.05 | 0.025128875000 |
| openai/gpt-6-luna:matrix:code:large:3 | 196608 | 204800 | 1024 | 0.05 | 0.026112000000 |
| openai/gpt-6-luna:matrix:json:small:0 | 414 | 8606 | 1024 | 0.05 | 0.001587750000 |
| openai/gpt-6-luna:matrix:json:small:1 | 3829 | 12021 | 1024 | 0.05 | 0.002014625000 |
| openai/gpt-6-luna:matrix:json:small:2 | 3932 | 12124 | 1024 | 0.05 | 0.002027500000 |
| openai/gpt-6-luna:matrix:json:small:3 | 4096 | 12288 | 1024 | 0.05 | 0.002048000000 |
| openai/gpt-6-luna:matrix:json:medium:0 | 29818 | 38010 | 1024 | 0.05 | 0.005263250000 |
| openai/gpt-6-luna:matrix:json:medium:1 | 30638 | 38830 | 1024 | 0.05 | 0.005365750000 |
| openai/gpt-6-luna:matrix:json:medium:2 | 31457 | 39649 | 1024 | 0.05 | 0.005468125000 |
| openai/gpt-6-luna:matrix:json:medium:3 | 32768 | 40960 | 1024 | 0.05 | 0.005632000000 |
| openai/gpt-6-luna:matrix:json:large:0:r3 | 178913 | 187105 | 1024 | 0.05 | 0.023900125000 |
| openai/gpt-6-luna:matrix:json:large:1:r3 | 183828 | 192020 | 1024 | 0.05 | 0.024514500000 |
| openai/gpt-6-luna:matrix:json:large:2:r3 | 188743 | 196935 | 1024 | 0.05 | 0.025128875000 |
| openai/gpt-6-luna:matrix:json:large:3:r3 | 196608 | 204800 | 1024 | 0.05 | 0.026112000000 |
| openai/gpt-6-luna:matrix:tools:small:0 | 679 | 8871 | 1024 | 0.05 | 0.001620875000 |
| openai/gpt-6-luna:matrix:tools:small:1 | 3829 | 12021 | 1024 | 0.05 | 0.002014625000 |
| openai/gpt-6-luna:matrix:tools:small:2 | 3932 | 12124 | 1024 | 0.05 | 0.002027500000 |
| openai/gpt-6-luna:matrix:tools:small:3 | 4096 | 12288 | 1024 | 0.05 | 0.002048000000 |
| openai/gpt-6-luna:matrix:tools:medium:0 | 29818 | 38010 | 1024 | 0.05 | 0.005263250000 |
| openai/gpt-6-luna:matrix:tools:medium:1 | 30638 | 38830 | 1024 | 0.05 | 0.005365750000 |
| openai/gpt-6-luna:matrix:tools:medium:2 | 31457 | 39649 | 1024 | 0.05 | 0.005468125000 |
| openai/gpt-6-luna:matrix:tools:medium:3 | 32768 | 40960 | 1024 | 0.05 | 0.005632000000 |
| openai/gpt-6-luna:matrix:tools:large:0 | 178913 | 187105 | 1024 | 0.05 | 0.023900125000 |
| openai/gpt-6-luna:matrix:tools:large:1 | 183828 | 192020 | 1024 | 0.05 | 0.024514500000 |
| openai/gpt-6-luna:matrix:tools:large:2 | 188743 | 196935 | 1024 | 0.05 | 0.025128875000 |
| openai/gpt-6-luna:matrix:tools:large:3 | 196608 | 204800 | 1024 | 0.05 | 0.026112000000 |
| openai/gpt-6-luna:messages:english:short-64:0 | 16384 | 24576 | 1024 | 0.05 | 0.003584000000 |
| openai/gpt-6-luna:messages:english:short-64:1 | 16384 | 24576 | 1024 | 0.05 | 0.003584000000 |
| openai/gpt-6-luna:messages:english:long-64:0 | 180000 | 188192 | 1024 | 0.05 | 0.024036000000 |
| openai/gpt-6-luna:messages:english:long-64:1 | 180000 | 188192 | 1024 | 0.05 | 0.024036000000 |
| openai/gpt-6-luna:messages:english:short-96:0 | 16384 | 24576 | 1024 | 0.05 | 0.003584000000 |
| openai/gpt-6-luna:messages:english:short-96:1 | 16384 | 24576 | 1024 | 0.05 | 0.003584000000 |
| openai/gpt-6-luna:messages:english:long-96:0 | 180000 | 188192 | 1024 | 0.05 | 0.024036000000 |
| openai/gpt-6-luna:messages:english:long-96:1 | 180000 | 188192 | 1024 | 0.05 | 0.024036000000 |
| openai/gpt-6-luna:messages:english:short-128:0 | 16384 | 24576 | 1024 | 0.05 | 0.003584000000 |
| openai/gpt-6-luna:messages:english:short-128:1 | 16384 | 24576 | 1024 | 0.05 | 0.003584000000 |
| openai/gpt-6-luna:messages:english:long-128:0 | 180000 | 188192 | 1024 | 0.05 | 0.024036000000 |
| openai/gpt-6-luna:messages:english:long-128:1 | 180000 | 188192 | 1024 | 0.05 | 0.024036000000 |

## 复现与交接

```bash
node scripts/payg-profile.mjs plan scripts/payg-profile/plan-prices.json /tmp/payg-profile-r3-check.json
cmp docs/launch/evidence/payg-profile-20261006-r3.manifest.json /tmp/payg-profile-r3-check.json
```

仅离线预演；实际运行入口见 [执行文档](BILL_PAYG_PROFILE_EXECUTOR.md)，必须先收到主窗口对新版本和新 hash 的复核及执行通知。
两个旧批次的锁和本机记录不删除、不改写。内容拒绝新增 PROVIDER_CONTENT_REFUSED，缺费用仍为未知，不自动沿用 Owner 的历史 $0 决定。
最终合并前迁移改为 0175，本轮不改号、不访问远端数据库、不改配置、不合并。
