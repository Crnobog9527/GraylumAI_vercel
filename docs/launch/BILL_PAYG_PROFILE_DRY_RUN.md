# BILL-PAYG profile 无网络预演

状态：**预演已完成；真实执行 BLOCKED / NOT_RUN**。实际生成调用 0 次，费用 0 美元。
样本清单 hash：`66dd2bfeb5a25e97110929a4c94355856492bc802a59311d72ab8ad5f5166882`。

命令：`node scripts/payg-profile.mjs plan scripts/payg-profile/plan-prices.json /tmp/payg-profile-dry-run.json`。
只使用仓库现有依赖；无网络访问、无数据库、无模型调用。临时编译文件自动清理，输出文件权限 0600。
清单只含结构、长度、hash、金额，不公开正文或完整请求。`createSamplePlan` 返回的正文仅供未来受控执行者使用。

## 计划与费用

零复用上限计划 180 个不同输入样本：3 精确模型/线路 × 5 类 × 3 档 × 4 变体。
另 10 个 O=8192 输出压力样本：Sonnet 和 Gemini 各含无参数/low 两种 reasoning 各 2 个；
Luna 暂按无参数 2 个。如实际配置使用 medium 或不同 wire，须调整并重新冻结计划，不继承这些证据。
矩阵遵循方案 low、O=1024，仅验证输入计量，不能用于证明 O=8192。
小档有最小合法请求及 4096 边界；中/大档 91%、93.5%、96%、100%，精确 32768 / 196608 上限。
工具中/大档覆盖 32 messages、16384 schema bytes 和多轮工具历史；不实际执行工具。
所有 B 均在宿主的规范化和缓存标记之后测量，T=B+8192；Claude 带 ephemeral，其他线路用同格重复系统前缀。
是否真正缓存命中/写入仍必须以回执为准，没有命中证据不能宣布缓存覆盖通过。

| 模型/线路 | 计划次数 | 费用上界 USD |
| --- | ---: | ---: |
| Sonnet 5.5 / anthropic | 64 | 13.358212500000 |
| Gemini 3.8 Flash / google-vertex/global | 64 | 4.077932250000 |
| GPT-6 Luna / openai | 62 | 0.656601625000 |
| 合计 | 190 | **18.092746375000** |

这些是逐样本最坏费用上界的和，不是实际平均成本预测，更不是付费授权。
价格沿 BILL_PAYG_PLAN 的历史算例：Sonnet 2/10、写入总价 2.5；Gemini .75/3.75；Luna .10/.50、写入总价 .125，
单位 USD/百万 token，固定请求费假设 0。`contextTokens=250000` 是预演假设，不是当前目录核验结果。
真实运行前必须换成经核验的当前完整线路报价（含档位、写入和其他收费项）、容量、reasoning 支持与输出硬限证明，
重新预演；不能仅把 currentVerified 改成 true 就视为核验完成。

**发现的实际阻断：**Sonnet 大档 96% 和 100% 的每类样本共 10 个超过原方案单次 $0.50；
最高 $0.52224。总上界虽然低于 $48，不能挪用总预算覆盖单次超限。
没有缩小必测边界或扩大单次授权。由主窗口结合当前价格、#561 可复用证据和所需 O 决定如何准备新的获批采样批次。
#561 复用尚未核验，本次不擅自扣减次数。新增 10 次输出压力样本也不从原 180 次授权中推定获批。

## 回执记录

`node scripts/payg-profile.mjs record manifest.json report.json receipts.json`，只读取本地文件。
每条已授权采样的受控回执投影包含 sampleId、requestHash、model、endpointTag、官方原生 nativePromptTokens、
nativeCompletionTokens（含 reasoning）、costUsd、cachedTokens、cacheWriteTokens、source 和 includesReasoning。
source 仅允许 response.prompt_tokens 或 lookup.native_tokens_prompt；原始来源应由执行者留存在受控材料中。
工具验证清单 hash 与样本身份，输出 P、rB=P/B、rT=P/T 和费用/输出边界结果；不会扣掉缓存命中 token。
未运行/缺字段为 null，重复回执标 CONFLICT，身份不符单列，不自动重试、不补样本、不写 profile。
SAMPLE_WITHIN_BOUNDS 只是该条投影的算术检查，不表示来源已独立核验、缓存已覆盖或整个 profile 获准。

## 每个样本清单

| 样本 | B | O | 预计费用上界 USD |
| --- | ---: | ---: | ---: |
| anthropic/claude-sonnet-5.5:matrix:chinese:small:0 | 475 | 1024 | 0.031907500000 |
| anthropic/claude-sonnet-5.5:matrix:chinese:small:1 | 3829 | 1024 | 0.040292500000 |
| anthropic/claude-sonnet-5.5:matrix:chinese:small:2 | 3932 | 1024 | 0.040550000000 |
| anthropic/claude-sonnet-5.5:matrix:chinese:small:3 | 4096 | 1024 | 0.040960000000 |
| anthropic/claude-sonnet-5.5:matrix:chinese:medium:0 | 29818 | 1024 | 0.105265000000 |
| anthropic/claude-sonnet-5.5:matrix:chinese:medium:1 | 30638 | 1024 | 0.107315000000 |
| anthropic/claude-sonnet-5.5:matrix:chinese:medium:2 | 31457 | 1024 | 0.109362500000 |
| anthropic/claude-sonnet-5.5:matrix:chinese:medium:3 | 32768 | 1024 | 0.112640000000 |
| anthropic/claude-sonnet-5.5:matrix:chinese:large:0 | 178913 | 1024 | 0.478002500000 |
| anthropic/claude-sonnet-5.5:matrix:chinese:large:1 | 183828 | 1024 | 0.490290000000 |
| anthropic/claude-sonnet-5.5:matrix:chinese:large:2 | 188743 | 1024 | 0.502577500000 |
| anthropic/claude-sonnet-5.5:matrix:chinese:large:3 | 196608 | 1024 | 0.522240000000 |
| anthropic/claude-sonnet-5.5:matrix:english:small:0 | 475 | 1024 | 0.031907500000 |
| anthropic/claude-sonnet-5.5:matrix:english:small:1 | 3829 | 1024 | 0.040292500000 |
| anthropic/claude-sonnet-5.5:matrix:english:small:2 | 3932 | 1024 | 0.040550000000 |
| anthropic/claude-sonnet-5.5:matrix:english:small:3 | 4096 | 1024 | 0.040960000000 |
| anthropic/claude-sonnet-5.5:matrix:english:medium:0 | 29818 | 1024 | 0.105265000000 |
| anthropic/claude-sonnet-5.5:matrix:english:medium:1 | 30638 | 1024 | 0.107315000000 |
| anthropic/claude-sonnet-5.5:matrix:english:medium:2 | 31457 | 1024 | 0.109362500000 |
| anthropic/claude-sonnet-5.5:matrix:english:medium:3 | 32768 | 1024 | 0.112640000000 |
| anthropic/claude-sonnet-5.5:matrix:english:large:0 | 178913 | 1024 | 0.478002500000 |
| anthropic/claude-sonnet-5.5:matrix:english:large:1 | 183828 | 1024 | 0.490290000000 |
| anthropic/claude-sonnet-5.5:matrix:english:large:2 | 188743 | 1024 | 0.502577500000 |
| anthropic/claude-sonnet-5.5:matrix:english:large:3 | 196608 | 1024 | 0.522240000000 |
| anthropic/claude-sonnet-5.5:matrix:code:small:0 | 472 | 1024 | 0.031900000000 |
| anthropic/claude-sonnet-5.5:matrix:code:small:1 | 3829 | 1024 | 0.040292500000 |
| anthropic/claude-sonnet-5.5:matrix:code:small:2 | 3932 | 1024 | 0.040550000000 |
| anthropic/claude-sonnet-5.5:matrix:code:small:3 | 4096 | 1024 | 0.040960000000 |
| anthropic/claude-sonnet-5.5:matrix:code:medium:0 | 29818 | 1024 | 0.105265000000 |
| anthropic/claude-sonnet-5.5:matrix:code:medium:1 | 30638 | 1024 | 0.107315000000 |
| anthropic/claude-sonnet-5.5:matrix:code:medium:2 | 31457 | 1024 | 0.109362500000 |
| anthropic/claude-sonnet-5.5:matrix:code:medium:3 | 32768 | 1024 | 0.112640000000 |
| anthropic/claude-sonnet-5.5:matrix:code:large:0 | 178913 | 1024 | 0.478002500000 |
| anthropic/claude-sonnet-5.5:matrix:code:large:1 | 183828 | 1024 | 0.490290000000 |
| anthropic/claude-sonnet-5.5:matrix:code:large:2 | 188743 | 1024 | 0.502577500000 |
| anthropic/claude-sonnet-5.5:matrix:code:large:3 | 196608 | 1024 | 0.522240000000 |
| anthropic/claude-sonnet-5.5:matrix:json:small:0 | 472 | 1024 | 0.031900000000 |
| anthropic/claude-sonnet-5.5:matrix:json:small:1 | 3829 | 1024 | 0.040292500000 |
| anthropic/claude-sonnet-5.5:matrix:json:small:2 | 3932 | 1024 | 0.040550000000 |
| anthropic/claude-sonnet-5.5:matrix:json:small:3 | 4096 | 1024 | 0.040960000000 |
| anthropic/claude-sonnet-5.5:matrix:json:medium:0 | 29818 | 1024 | 0.105265000000 |
| anthropic/claude-sonnet-5.5:matrix:json:medium:1 | 30638 | 1024 | 0.107315000000 |
| anthropic/claude-sonnet-5.5:matrix:json:medium:2 | 31457 | 1024 | 0.109362500000 |
| anthropic/claude-sonnet-5.5:matrix:json:medium:3 | 32768 | 1024 | 0.112640000000 |
| anthropic/claude-sonnet-5.5:matrix:json:large:0 | 178913 | 1024 | 0.478002500000 |
| anthropic/claude-sonnet-5.5:matrix:json:large:1 | 183828 | 1024 | 0.490290000000 |
| anthropic/claude-sonnet-5.5:matrix:json:large:2 | 188743 | 1024 | 0.502577500000 |
| anthropic/claude-sonnet-5.5:matrix:json:large:3 | 196608 | 1024 | 0.522240000000 |
| anthropic/claude-sonnet-5.5:matrix:tools:small:0 | 737 | 1024 | 0.032562500000 |
| anthropic/claude-sonnet-5.5:matrix:tools:small:1 | 3829 | 1024 | 0.040292500000 |
| anthropic/claude-sonnet-5.5:matrix:tools:small:2 | 3932 | 1024 | 0.040550000000 |
| anthropic/claude-sonnet-5.5:matrix:tools:small:3 | 4096 | 1024 | 0.040960000000 |
| anthropic/claude-sonnet-5.5:matrix:tools:medium:0 | 29818 | 1024 | 0.105265000000 |
| anthropic/claude-sonnet-5.5:matrix:tools:medium:1 | 30638 | 1024 | 0.107315000000 |
| anthropic/claude-sonnet-5.5:matrix:tools:medium:2 | 31457 | 1024 | 0.109362500000 |
| anthropic/claude-sonnet-5.5:matrix:tools:medium:3 | 32768 | 1024 | 0.112640000000 |
| anthropic/claude-sonnet-5.5:matrix:tools:large:0 | 178913 | 1024 | 0.478002500000 |
| anthropic/claude-sonnet-5.5:matrix:tools:large:1 | 183828 | 1024 | 0.490290000000 |
| anthropic/claude-sonnet-5.5:matrix:tools:large:2 | 188743 | 1024 | 0.502577500000 |
| anthropic/claude-sonnet-5.5:matrix:tools:large:3 | 196608 | 1024 | 0.522240000000 |
| anthropic/claude-sonnet-5.5:output:chinese:output-stress:0 | 4096 | 8192 | 0.112640000000 |
| anthropic/claude-sonnet-5.5:output:code:output-stress:1 | 4096 | 8192 | 0.112640000000 |
| anthropic/claude-sonnet-5.5:output:chinese:output-stress:2 | 4096 | 8192 | 0.112640000000 |
| anthropic/claude-sonnet-5.5:output:code:output-stress:3 | 4096 | 8192 | 0.112640000000 |
| google/gemini-3.8-flash:matrix:chinese:small:0 | 425 | 1024 | 0.010302750000 |
| google/gemini-3.8-flash:matrix:chinese:small:1 | 3829 | 1024 | 0.012855750000 |
| google/gemini-3.8-flash:matrix:chinese:small:2 | 3932 | 1024 | 0.012933000000 |
| google/gemini-3.8-flash:matrix:chinese:small:3 | 4096 | 1024 | 0.013056000000 |
| google/gemini-3.8-flash:matrix:chinese:medium:0 | 29818 | 1024 | 0.032347500000 |
| google/gemini-3.8-flash:matrix:chinese:medium:1 | 30638 | 1024 | 0.032962500000 |
| google/gemini-3.8-flash:matrix:chinese:medium:2 | 31457 | 1024 | 0.033576750000 |
| google/gemini-3.8-flash:matrix:chinese:medium:3 | 32768 | 1024 | 0.034560000000 |
| google/gemini-3.8-flash:matrix:chinese:large:0 | 178913 | 1024 | 0.144168750000 |
| google/gemini-3.8-flash:matrix:chinese:large:1 | 183828 | 1024 | 0.147855000000 |
| google/gemini-3.8-flash:matrix:chinese:large:2 | 188743 | 1024 | 0.151541250000 |
| google/gemini-3.8-flash:matrix:chinese:large:3 | 196608 | 1024 | 0.157440000000 |
| google/gemini-3.8-flash:matrix:english:small:0 | 425 | 1024 | 0.010302750000 |
| google/gemini-3.8-flash:matrix:english:small:1 | 3829 | 1024 | 0.012855750000 |
| google/gemini-3.8-flash:matrix:english:small:2 | 3932 | 1024 | 0.012933000000 |
| google/gemini-3.8-flash:matrix:english:small:3 | 4096 | 1024 | 0.013056000000 |
| google/gemini-3.8-flash:matrix:english:medium:0 | 29818 | 1024 | 0.032347500000 |
| google/gemini-3.8-flash:matrix:english:medium:1 | 30638 | 1024 | 0.032962500000 |
| google/gemini-3.8-flash:matrix:english:medium:2 | 31457 | 1024 | 0.033576750000 |
| google/gemini-3.8-flash:matrix:english:medium:3 | 32768 | 1024 | 0.034560000000 |
| google/gemini-3.8-flash:matrix:english:large:0 | 178913 | 1024 | 0.144168750000 |
| google/gemini-3.8-flash:matrix:english:large:1 | 183828 | 1024 | 0.147855000000 |
| google/gemini-3.8-flash:matrix:english:large:2 | 188743 | 1024 | 0.151541250000 |
| google/gemini-3.8-flash:matrix:english:large:3 | 196608 | 1024 | 0.157440000000 |
| google/gemini-3.8-flash:matrix:code:small:0 | 422 | 1024 | 0.010300500000 |
| google/gemini-3.8-flash:matrix:code:small:1 | 3829 | 1024 | 0.012855750000 |
| google/gemini-3.8-flash:matrix:code:small:2 | 3932 | 1024 | 0.012933000000 |
| google/gemini-3.8-flash:matrix:code:small:3 | 4096 | 1024 | 0.013056000000 |
| google/gemini-3.8-flash:matrix:code:medium:0 | 29818 | 1024 | 0.032347500000 |
| google/gemini-3.8-flash:matrix:code:medium:1 | 30638 | 1024 | 0.032962500000 |
| google/gemini-3.8-flash:matrix:code:medium:2 | 31457 | 1024 | 0.033576750000 |
| google/gemini-3.8-flash:matrix:code:medium:3 | 32768 | 1024 | 0.034560000000 |
| google/gemini-3.8-flash:matrix:code:large:0 | 178913 | 1024 | 0.144168750000 |
| google/gemini-3.8-flash:matrix:code:large:1 | 183828 | 1024 | 0.147855000000 |
| google/gemini-3.8-flash:matrix:code:large:2 | 188743 | 1024 | 0.151541250000 |
| google/gemini-3.8-flash:matrix:code:large:3 | 196608 | 1024 | 0.157440000000 |
| google/gemini-3.8-flash:matrix:json:small:0 | 422 | 1024 | 0.010300500000 |
| google/gemini-3.8-flash:matrix:json:small:1 | 3829 | 1024 | 0.012855750000 |
| google/gemini-3.8-flash:matrix:json:small:2 | 3932 | 1024 | 0.012933000000 |
| google/gemini-3.8-flash:matrix:json:small:3 | 4096 | 1024 | 0.013056000000 |
| google/gemini-3.8-flash:matrix:json:medium:0 | 29818 | 1024 | 0.032347500000 |
| google/gemini-3.8-flash:matrix:json:medium:1 | 30638 | 1024 | 0.032962500000 |
| google/gemini-3.8-flash:matrix:json:medium:2 | 31457 | 1024 | 0.033576750000 |
| google/gemini-3.8-flash:matrix:json:medium:3 | 32768 | 1024 | 0.034560000000 |
| google/gemini-3.8-flash:matrix:json:large:0 | 178913 | 1024 | 0.144168750000 |
| google/gemini-3.8-flash:matrix:json:large:1 | 183828 | 1024 | 0.147855000000 |
| google/gemini-3.8-flash:matrix:json:large:2 | 188743 | 1024 | 0.151541250000 |
| google/gemini-3.8-flash:matrix:json:large:3 | 196608 | 1024 | 0.157440000000 |
| google/gemini-3.8-flash:matrix:tools:small:0 | 687 | 1024 | 0.010499250000 |
| google/gemini-3.8-flash:matrix:tools:small:1 | 3829 | 1024 | 0.012855750000 |
| google/gemini-3.8-flash:matrix:tools:small:2 | 3932 | 1024 | 0.012933000000 |
| google/gemini-3.8-flash:matrix:tools:small:3 | 4096 | 1024 | 0.013056000000 |
| google/gemini-3.8-flash:matrix:tools:medium:0 | 29818 | 1024 | 0.032347500000 |
| google/gemini-3.8-flash:matrix:tools:medium:1 | 30638 | 1024 | 0.032962500000 |
| google/gemini-3.8-flash:matrix:tools:medium:2 | 31457 | 1024 | 0.033576750000 |
| google/gemini-3.8-flash:matrix:tools:medium:3 | 32768 | 1024 | 0.034560000000 |
| google/gemini-3.8-flash:matrix:tools:large:0 | 178913 | 1024 | 0.144168750000 |
| google/gemini-3.8-flash:matrix:tools:large:1 | 183828 | 1024 | 0.147855000000 |
| google/gemini-3.8-flash:matrix:tools:large:2 | 188743 | 1024 | 0.151541250000 |
| google/gemini-3.8-flash:matrix:tools:large:3 | 196608 | 1024 | 0.157440000000 |
| google/gemini-3.8-flash:output:chinese:output-stress:0 | 4096 | 8192 | 0.039936000000 |
| google/gemini-3.8-flash:output:code:output-stress:1 | 4096 | 8192 | 0.039936000000 |
| google/gemini-3.8-flash:output:chinese:output-stress:2 | 4096 | 8192 | 0.039936000000 |
| google/gemini-3.8-flash:output:code:output-stress:3 | 4096 | 8192 | 0.039936000000 |
| openai/gpt-6-luna:matrix:chinese:small:0 | 403 | 1024 | 0.001586375000 |
| openai/gpt-6-luna:matrix:chinese:small:1 | 3829 | 1024 | 0.002014625000 |
| openai/gpt-6-luna:matrix:chinese:small:2 | 3932 | 1024 | 0.002027500000 |
| openai/gpt-6-luna:matrix:chinese:small:3 | 4096 | 1024 | 0.002048000000 |
| openai/gpt-6-luna:matrix:chinese:medium:0 | 29818 | 1024 | 0.005263250000 |
| openai/gpt-6-luna:matrix:chinese:medium:1 | 30638 | 1024 | 0.005365750000 |
| openai/gpt-6-luna:matrix:chinese:medium:2 | 31457 | 1024 | 0.005468125000 |
| openai/gpt-6-luna:matrix:chinese:medium:3 | 32768 | 1024 | 0.005632000000 |
| openai/gpt-6-luna:matrix:chinese:large:0 | 178913 | 1024 | 0.023900125000 |
| openai/gpt-6-luna:matrix:chinese:large:1 | 183828 | 1024 | 0.024514500000 |
| openai/gpt-6-luna:matrix:chinese:large:2 | 188743 | 1024 | 0.025128875000 |
| openai/gpt-6-luna:matrix:chinese:large:3 | 196608 | 1024 | 0.026112000000 |
| openai/gpt-6-luna:matrix:english:small:0 | 403 | 1024 | 0.001586375000 |
| openai/gpt-6-luna:matrix:english:small:1 | 3829 | 1024 | 0.002014625000 |
| openai/gpt-6-luna:matrix:english:small:2 | 3932 | 1024 | 0.002027500000 |
| openai/gpt-6-luna:matrix:english:small:3 | 4096 | 1024 | 0.002048000000 |
| openai/gpt-6-luna:matrix:english:medium:0 | 29818 | 1024 | 0.005263250000 |
| openai/gpt-6-luna:matrix:english:medium:1 | 30638 | 1024 | 0.005365750000 |
| openai/gpt-6-luna:matrix:english:medium:2 | 31457 | 1024 | 0.005468125000 |
| openai/gpt-6-luna:matrix:english:medium:3 | 32768 | 1024 | 0.005632000000 |
| openai/gpt-6-luna:matrix:english:large:0 | 178913 | 1024 | 0.023900125000 |
| openai/gpt-6-luna:matrix:english:large:1 | 183828 | 1024 | 0.024514500000 |
| openai/gpt-6-luna:matrix:english:large:2 | 188743 | 1024 | 0.025128875000 |
| openai/gpt-6-luna:matrix:english:large:3 | 196608 | 1024 | 0.026112000000 |
| openai/gpt-6-luna:matrix:code:small:0 | 400 | 1024 | 0.001586000000 |
| openai/gpt-6-luna:matrix:code:small:1 | 3829 | 1024 | 0.002014625000 |
| openai/gpt-6-luna:matrix:code:small:2 | 3932 | 1024 | 0.002027500000 |
| openai/gpt-6-luna:matrix:code:small:3 | 4096 | 1024 | 0.002048000000 |
| openai/gpt-6-luna:matrix:code:medium:0 | 29818 | 1024 | 0.005263250000 |
| openai/gpt-6-luna:matrix:code:medium:1 | 30638 | 1024 | 0.005365750000 |
| openai/gpt-6-luna:matrix:code:medium:2 | 31457 | 1024 | 0.005468125000 |
| openai/gpt-6-luna:matrix:code:medium:3 | 32768 | 1024 | 0.005632000000 |
| openai/gpt-6-luna:matrix:code:large:0 | 178913 | 1024 | 0.023900125000 |
| openai/gpt-6-luna:matrix:code:large:1 | 183828 | 1024 | 0.024514500000 |
| openai/gpt-6-luna:matrix:code:large:2 | 188743 | 1024 | 0.025128875000 |
| openai/gpt-6-luna:matrix:code:large:3 | 196608 | 1024 | 0.026112000000 |
| openai/gpt-6-luna:matrix:json:small:0 | 400 | 1024 | 0.001586000000 |
| openai/gpt-6-luna:matrix:json:small:1 | 3829 | 1024 | 0.002014625000 |
| openai/gpt-6-luna:matrix:json:small:2 | 3932 | 1024 | 0.002027500000 |
| openai/gpt-6-luna:matrix:json:small:3 | 4096 | 1024 | 0.002048000000 |
| openai/gpt-6-luna:matrix:json:medium:0 | 29818 | 1024 | 0.005263250000 |
| openai/gpt-6-luna:matrix:json:medium:1 | 30638 | 1024 | 0.005365750000 |
| openai/gpt-6-luna:matrix:json:medium:2 | 31457 | 1024 | 0.005468125000 |
| openai/gpt-6-luna:matrix:json:medium:3 | 32768 | 1024 | 0.005632000000 |
| openai/gpt-6-luna:matrix:json:large:0 | 178913 | 1024 | 0.023900125000 |
| openai/gpt-6-luna:matrix:json:large:1 | 183828 | 1024 | 0.024514500000 |
| openai/gpt-6-luna:matrix:json:large:2 | 188743 | 1024 | 0.025128875000 |
| openai/gpt-6-luna:matrix:json:large:3 | 196608 | 1024 | 0.026112000000 |
| openai/gpt-6-luna:matrix:tools:small:0 | 665 | 1024 | 0.001619125000 |
| openai/gpt-6-luna:matrix:tools:small:1 | 3829 | 1024 | 0.002014625000 |
| openai/gpt-6-luna:matrix:tools:small:2 | 3932 | 1024 | 0.002027500000 |
| openai/gpt-6-luna:matrix:tools:small:3 | 4096 | 1024 | 0.002048000000 |
| openai/gpt-6-luna:matrix:tools:medium:0 | 29818 | 1024 | 0.005263250000 |
| openai/gpt-6-luna:matrix:tools:medium:1 | 30638 | 1024 | 0.005365750000 |
| openai/gpt-6-luna:matrix:tools:medium:2 | 31457 | 1024 | 0.005468125000 |
| openai/gpt-6-luna:matrix:tools:medium:3 | 32768 | 1024 | 0.005632000000 |
| openai/gpt-6-luna:matrix:tools:large:0 | 178913 | 1024 | 0.023900125000 |
| openai/gpt-6-luna:matrix:tools:large:1 | 183828 | 1024 | 0.024514500000 |
| openai/gpt-6-luna:matrix:tools:large:2 | 188743 | 1024 | 0.025128875000 |
| openai/gpt-6-luna:matrix:tools:large:3 | 196608 | 1024 | 0.026112000000 |
| openai/gpt-6-luna:output:chinese:output-stress:0 | 4096 | 8192 | 0.005632000000 |
| openai/gpt-6-luna:output:code:output-stress:1 | 4096 | 8192 | 0.005632000000 |
