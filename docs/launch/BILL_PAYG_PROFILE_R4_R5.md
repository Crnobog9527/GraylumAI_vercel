# BILL-PAYG r4/r5 离线预演（2026-10-06）

**预演记录；r4 已授权执行，最新结果见 PR。r5 未执行、不得执行。** 两批分别授权。
依据：[主窗口技术决定与第三批审计](https://github.com/Crnobog9527/GraylumAI_vercel/pull/665#issuecomment-5999267254)。

## 小输出上限与验收

| 模型 / 精确线路 | 两种思考设置 | max_tokens | 新输出压力数 |
| --- | --- | ---: | ---: |
| GPT-6 Luna / openai | 不传参数；reasoning_effort=low | 512 | 每种 2 条 |
| Sonnet 5.5 / anthropic | 不传参数；reasoning_effort=low | 2048 | 每种 2 条 |
| Gemini 3.8 Flash / google-vertex/global | 不传参数；reasoning_effort=low | 512 | 每种 2 条 |

选择依据（2026-10-06 读取）：[OpenRouter reasoning 文档](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)
规定 Anthropic 显式思考预算最低 1024，且总输出上限应更高；本方案取 2048，保留默认/low 原参数写法，不新增显式思考预算。
这是保守的兼容选择，不声称所有 adaptive 模式都强制同一最低值。不传参数也不等于关闭思考。
Gemini 的 effort 映射 thinkingLevel，没有公开的逐档 token 最小值；保持原设置，取 512 总输出上限。
[OpenAI reasoning 指南](https://developers.openai.com/api/docs/guides/reasoning) 将思考计入输出预算；
Luna 现有目录没有公开最小思考 token 字段，因此取 512 作为待实测的较小总额，不能把未公布的最低值当作已确认的零。
上述均未用真实请求试探；不支持、提前结束、超界或未知时停止，不临时调大或重试。

压力提示沿用编号 000001 到 010000 的逐行固定格式；输入 B=4096，调整 max_tokens 后重新规范化到相同字节目标。
**每条输出压力通过必须同时满足**：finish_reason=length、原生 completion（含 reasoning）精确等于本条 O，且原有 token/费用边界全部通过。
不允许一 token 越界；正常 stop 或少于 O 为 OUTPUT_CAP_NOT_REACHED，立即停批，不补样本。原生 completion 已含 reasoning，不重复相加。
离线 record 和真实执行使用同一严格判定，未带 finishReason 的输出回执不能冒充触顶证据。
原来 1 条 8192 触顶仍作为历史观测保留；不能替代本次每种设置两条小上限样本。

依据[主窗口后续技术决定](https://github.com/Crnobog9527/GraylumAI_vercel/pull/665#issuecomment-5999661106)，
小上限证明执行语义，而非限制 profile 的业务上限。`evidence.testedOutputLimit` 与每个 `reasoningVariants[].testedOutputLimit`
如实填写该模型统一使用的 512 或 2048；各变体至少两条严格触顶、completion 包含 reasoning。
`evidence.outputSemantics` 固定为 `max-tokens-includes-reasoning`，`evidence.outputLimit`、variant/outputLimit 和 profile/outputLimit
记录经审查允许的用途上限，可为 PURPOSE_OUTPUT_CAP（8192）。测试上限与允许上限分开，不能把 512 写成实测 8192。
旧证据缺少新字段时启用校验拒绝；紧急关闭和已冻结执行不变。其余矩阵、多消息、缓存和费用要求不变。
配置只是建议，须主窗口核验材料后应用；本轮不修改实际设置。

## 独立批次与已完成证据

- r4：先 Luna 的 76 条（60 矩阵 + 12 多消息 + 4 新输出压力），再 Sonnet 4 条新输出压力，共 **80 条**。
- r5：仅 Gemini 的 76 条（60 矩阵 + 12 多消息 + 4 新输出压力）；**仅准备**，Vertex 状态恢复且主窗口另行授权后才能执行。主窗口报告当前 status=-2；本轮未重新查询，不更换线路。
- 第二、三批的 **79 条已完成观测**保留在每份 manifest.retainedEvidence；Sonnet 60/60 矩阵和 12/12 多消息不重发。
- Luna/Gemini 非输出样本沿用 r3 ID、请求 hash 和上界；输出改用 :r4/:r5 新 ID、新 hash、小上限，不另发旧 8192 压力请求。
- 每个 batch 分别绑定完整 manifestHash 和永久本机锁；只执行被明确授权的那个。旧三个批次的文件与锁不动。

## 费用与累计保护

| 项目 | 上界 USD | 已入账加本批 USD |
| --- | ---: | ---: |
| 前三批已入账 | 4.810139500000 | — |
| r4（Luna 0.818234375 + Sonnet 0.2048） | **1.023034375000** | 5.833173875000 |
| r5（Gemini） | **4.966320750000** | 9.776460250000 |
| 已入账 + r4 + r5 全部预留 | **10.799494625000 < 25** | — |

两份 manifest 的 cumulativeUpperUsd 都包含**另一批的整个上界预留**，不只检查本批，避免分别使用同一剩余额度。
逐条实际费用上界与 approvedCap 对照；单条批准限额和冻结目录单价不变，新输出压力费用按较小 O 重算。
执行前如兄弟批次已有锁，必须有同 hash 的已完成报告、无未知费用且实际额不超过它的预留；否则在凭据/出口/加锁前停止为
SIBLING_BATCH_UNSETTLED 或 SIBLING_BATCH_BUDGET_EXCEEDED。无自动清锁、查账、续发或重建预算。
两批依序独立授权，任意未知或超额先交主窗口审计，不拿剩余预留补跑。上界不是服务商美元熔断。

历史账目：r1 依 Owner 决定 $0；r2 $2.5964977（第 49 条依 Owner 核实 $0）；r3 $2.2136418，合计 $4.8101395。
完整历史 manifest hash、决定链接、脱敏回执字段及 hash 保存在新清单里；原 UNKNOWN 回执不改写。

## manifest 与逐条费用

r4：`04e92dfa3a33a49090c853da83cf088b5d83555ac447b92760a5b3461725f1db`，见[清单](evidence/payg-profile-20261006-r4.manifest.json)。
r5：`72a8bc28bbd64a8c1139afafbdec71d8631ac1ceabfec35dbeca7e6dca51c97a`，见[清单](evidence/payg-profile-20261006-r5.manifest.json)。
以下所有新样本真实执行均 NOT_RUN。

### r4

| 样本 ID | B | T | O | 单条批准上限 USD | 预留上界 USD |
| --- | ---: | ---: | ---: | ---: | ---: |
| openai/gpt-6-luna:output:chinese:output-stress:0:r4 | 4096 | 12288 | 512 | 0.05 | 0.001792000000 |
| openai/gpt-6-luna:output:code:output-stress:1:r4 | 4096 | 12288 | 512 | 0.05 | 0.001792000000 |
| openai/gpt-6-luna:output:chinese:output-stress:2:r4 | 4096 | 12288 | 512 | 0.05 | 0.001792000000 |
| openai/gpt-6-luna:output:code:output-stress:3:r4 | 4096 | 12288 | 512 | 0.05 | 0.001792000000 |
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
| anthropic/claude-sonnet-5.5:output:chinese:output-stress:0:r4 | 4096 | 12288 | 2048 | 0.50 | 0.051200000000 |
| anthropic/claude-sonnet-5.5:output:code:output-stress:1:r4 | 4096 | 12288 | 2048 | 0.50 | 0.051200000000 |
| anthropic/claude-sonnet-5.5:output:chinese:output-stress:2:r4 | 4096 | 12288 | 2048 | 0.50 | 0.051200000000 |
| anthropic/claude-sonnet-5.5:output:code:output-stress:3:r4 | 4096 | 12288 | 2048 | 0.50 | 0.051200000000 |

### r5

| 样本 ID | B | T | O | 单条批准上限 USD | 预留上界 USD |
| --- | ---: | ---: | ---: | ---: | ---: |
| google/gemini-3.8-flash:output:chinese:output-stress:0:r5 | 4096 | 12288 | 512 | 0.25 | 0.011136000000 |
| google/gemini-3.8-flash:output:code:output-stress:1:r5 | 4096 | 12288 | 512 | 0.25 | 0.011136000000 |
| google/gemini-3.8-flash:output:chinese:output-stress:2:r5 | 4096 | 12288 | 512 | 0.25 | 0.011136000000 |
| google/gemini-3.8-flash:output:code:output-stress:3:r5 | 4096 | 12288 | 512 | 0.25 | 0.011136000000 |
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

## 离线复现

```bash
node scripts/payg-profile.mjs plan scripts/payg-profile/plan-prices.json /tmp/payg-r4.json r4
node scripts/payg-profile.mjs plan scripts/payg-profile/plan-prices.json /tmp/payg-r5.json r5
cmp docs/launch/evidence/payg-profile-20261006-r4.manifest.json /tmp/payg-r4.json
cmp docs/launch/evidence/payg-profile-20261006-r5.manifest.json /tmp/payg-r5.json
```

报价快照保持 2026-10-05 版本，本轮只读文档、离线生成及合成测试；没有进行出口/目录/模型请求或读取凭据。
获准执行时仍须同一代理的出口和逐次目录预检，status 必须为 0，不换 provider。
最终合并前迁移改为 0175，本轮不改迁移、不访问远端数据库、不改配置、不合并。

编号交叉检查：当前在途 #670 也使用 0175；本轮保留原迁移，最终合并前由主窗口统一排定，不能把编号已无冲突作为通过结论。
