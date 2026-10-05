# BILL-PAYG 真实入口接线

风险 high。此 PR 不启用配置、不合并、不访问远端数据库。正式环境没有启用路径。

## 入口、开关与回退

工作/普通对话的 `runtime.prepare`，导师（包括流式）、步骤、计划的 `opc.prepareStep`，
选题的 `opc.topicTurn` 共用 `runtimeAdmissionService`。宿主传入 `paygHost:true`，
准入在原 requestId 重放和等待整理处理之后读取 `system_settings.runtime_payg_staging`。
自动匹配及附带整理的所有模型也必须通过检查；缺少其中一个 profile 就拒绝整个新准入。
旧 `/chat` 引擎不属于统一 Runtime，不在本次范围。

- 设置缺失或 `enabled:false`：新请求继续 v1。
- 设置启用：必须先通过现有独立 staging 环境绑定、已批准测试窗口和身份检查；
  `windowId` 必须与加载的窗口相同。正式项目/main 即使复制了设置也不能启用。
- 只有全部所选模型/用途通过 profile、原窗口报价、现价、倍数和 SQL 检查才创建 v2。
  启用配置失效、读失败或缺 profile 时明确拒绝，不能偷偷改成 v1 收费。
- 回退是原管理员 `settings.updateSystemSettings` 的一次更新：
  `key: "runtime_payg_staging", value: { enabled: false }`。
  不关闭整个测试窗口、不删旧执行、不改旧账务。已进入准入并读到开关的请求视为在途。
- `runtime.execute`、`runtime.resume`、停止及财务恢复不读取此设置。
  原 requestId 重放在新开关之前返回；原 v2 继续使用冻结的 v2 合同。

复用管理员设置权限及原 `system_settings`，没有新表、RPC、钱包、服务或调度器。
现有窗口只有稳定报价，不能表达独立回退开关与已验证 profile，因此新增一个窗口绑定的设置值。
计费事实权威仍为 BILL2 run/call/receipt 和原账本。设置只是新准入配置，不是第二份账务。
审计修复在设置路由增加此键的 schema 校验，单项/批量共用，拒绝字符串保存。
`{enabled:false}` 可独立关闭，读取兼容旧 JSON 字符串中的布尔 false；字符串 false 不视为布尔值。
已核对 #661 的服务端停笔交接：本次仅负责 PAYG 键，保留其支付渠道键的独立改动，不改其分支或前端。

## Profile 与证据要求

设置形状：`{ version:1, enabled:true, windowId, profiles:[...] }`。
严格字段见 `packages/api/src/services/runtime/paygHostPolicy.ts`；只在可信管理员侧配置。
不把设置、窗口身份或完整请求写进公开 PR。

首版只认 #553 的精确候选：Claude Sonnet 5.5 / anthropic、Gemini 3.8 Flash /
 google-vertex/global、GPT-6 Luna / openai。不按模型前缀授权。
每个模型/完整线路只有一个 profile；`reasoningVariants` 列出多种思考参数及各自的
`outputLimit/testedOutputLimit/evidenceReference/manifestHash/outputStressSamples/includesReasoning`。
每种实际使用的 reasoning 必须有至少两个 length 且 0.9O ≤ completion ≤ O 的输出压力样本，completion 包含 reasoning。
依据 [r6 判定决定](https://github.com/Crnobog9527/GraylumAI_vercel/pull/665#issuecomment-6000858032)，超过 O 仍立即失败；
未达到判定标准的样本只记失败与费用，不能计入 profile 的合格证据数量。
`testedOutputLimit` 记录测试上限；profile、variant 和 evidence 的 `outputLimit` 记录允许上限（最多 8192）。
同一模型的测试上限须一致，evidence.outputSemantics 必须为 `max-tokens-includes-reasoning`；
小上限可证明该执行语义，不冒称已实测 8192，依据主窗口 2026-10-06 决定（#665 评论 5999661106）。
普通调用的无参数 `{parameter:"none"}` 与导师 low/medium 可共存；未列出的组合直接拒绝。
profile 同时绑定协议、请求格式、用途、有效期、版本和输入计量实测材料引用/hash。
用途统一为 `ordinary / skill / organizer / skill_matching / attached_organizer`，不使用 matching。
有效期必须覆盖冻结的 run deadline；只能有效到当前时刻之后仍不足以准入。
配置中的样本统计是管理员核验实测材料后的摘要；它本身不能证明测试真的运行过。
启用前必须独立核对引用材料，不得将单元测试里的 synthetic profile 写入真实配置。

`B` 来自最终规范化、缓存标记后的 UTF-8 请求，`T=B+4096+4096`。
遵守 #553 的 196608 bytes / 128 messages / 2 tools / 16384 schema bytes（2026-10-05 Owner 决定取代 32 条） 上界，
且 60 个不同样本、15 格×4 变体、最大 P/B 与 P/T 均不超过 0.70；必须覆盖缓存和费用上界，
输出硬限包括 reasoning；另需 messageStressSamples=12、maxVerifiedMessages=128 的真实多消息证据摘要。
样本/模板/用途的具体覆盖仍以引用的实测清单为准，详见 [新预演](BILL_PAYG_PROFILE_DRY_RUN.md)。

准入证明最坏 `196608+4096+4096+O <= contextTokens`：
O=8192 时需要至少 **212992** context tokens。达不到就拒绝该组合。
本次实际用途的 O 还必须不超过 profile 的 O，profile 的 O 不超过实测证据的 O。
1024 证据不能启用 8192；可以在已有模型/用途配置中缩小 O 后重新核对，不能扩大实测范围。
准入同时收紧冻结历史条数：保留一个系统消息、一个当前输入，以及每个可执行工具轮次四个 SDK item 的余量
（reasoning、assistant text、function call、result）；所有候选模型取最小消息上限。无法容纳必需轮次就拒绝准入。
附带整理独立冻结至多 `maxMessages-2` 条历史，其输入包含主回复，不能沿用未收紧的历史配置。
之后只会因字节预算进一步裁剪历史，不扩大冻结条数。已有 v1/v2 执行的 context 不被重写。
派发前原 `runtimePaygCall` 与 SQL 再检查实际 B、T、O、报价和本次冻结；原计量异常监控保持不变。

**当前证据状态：未取得可核验的真实模型 profile 材料，没有预置获准的 profile。**
接线和合成测试不等于真实模型已准入。本轮真实调用 0 次，不能宣称 staging 已启用或验收通过。

## Validation handoff（合并后执行，不是本 PR 已执行结果）

前置：独立审查、最终版本 CI 通过并由负责窗口完成 staging 合并/部署；记录实际部署版本。
核对 profile 原始证据及模型/用途输出设置，检查原批准窗口仍有效、预算足够。
本任务禁止远端数据库访问；以下积分准备与账务核对交给有相应授权的 staging 验收窗口，
使用既有管理员操作/报表，必要远端访问另按其授权处理。
不得把缺 profile 的模型先打开再靠用户收费试验补证据。

真实流程预算计划 **最多 18 次模型调用**：`/runtime`、`/positioning/<草稿>`、
`/positioning/<草稿>/topics` 各最多 6 次（含整理、工具后再次生成与 v1 回退对照）。
只消耗 Owner 已批准的 OpenRouter 测试余额；按实际调用计数，重试不自动追加额度。
这 18 次是流程验收上限，不是 #553 的 60 样本 profile 采样授权，也不包含 REPORT-GEN 额度。
如果 6 次不足以覆盖页面全部组合，停止并记录未运行项目，不把缺口说成通过。

1. 依 #658 评论 5990469067，在三个页面准备只够第一调用的积分：主回复后等待；
   不充值继续仍等待且没有新扣费；连点继续只能提交一次；充值页在新标签打开。
2. 充值后继续原执行：跨新 HTTP 请求恢复，不新增准入，已完成调用只派发/结算一次；
   核对 call、hold、账本与余额一致，余额始终非负。
3. 整理等待时发新消息：保留输入，提示上一轮未整理；继续完成后才允许新消息。
   次数耗尽显示“本轮没有整理右侧信息，主回复已保留。”，正文保留。
4. 等待/停止组合：停掉等待中的原生步骤，保留已付费主回复，不派发整理；
   重复停止、刷新、旧继续 token 都不能恢复新派发或重复结算。
   普通/计划缓冲入口继续原有取消语义，不冒称支持 C2 截断保存。
5. 有旧 v2 等待时关闭 PAYG 开关；旧 v2 正常继续收尾，新 requestId 创建 v1。
   原 requestId 仍只返回原执行。不要关闭整个 staging 窗口来模拟这个开关。
6. 402 确定未收费拒绝保持现有释放/零扣费路径；不要故意耗尽真实测试余额，
   以本地 HTTP 402 和 SQL 回归作为该失败分支证据。
7. 375px 检查等待、继续、次数耗尽提示和按钮；无服务器原文错误、无输入丢失。
   记录页面、操作、结果与去身份截图。任一预期失败即标 FAIL，未执行标 NOT_RUN。

前端交接给 Claude：本任务没有改 apps/web。等待 UI 沿用 #658，按上述评论验收；
如需要可见的一键开关，在既有后台增加此设置的启用/关闭操作，关闭只写 `enabled:false`，
不得顺便关闭测试窗口。开关 UI 和真实页面验证不是本 PR 已完成事项。

## 无网络 profile 采样工具与审计修复

见 [采样预演](BILL_PAYG_PROFILE_DRY_RUN.md)。工具只生成本地清单并统计已取得的回执，不含发送、重试、
查账或配置写入代码。工具输出不是 profile 准入证明，真实采样等待主窗口通知。

本机回归覆盖宿主生成合同，经真实 PostgREST/SQL 准入及重复领取：普通、工作、导师、步骤、计划、选题；
无 mock 准入、profile、定价或 SQL。导师/步骤用 low，普通用无参数，同一模型/线路 profile 同时覆盖。
另测 100 条历史、真实 SDK read_source 第二轮、整理独立历史预算、无法容纳必需轮次的准入拒绝、
skill_matching 阶段、profile 到期早于 run、设置单项/批量和旧字符串快速关闭。
已有原生输出等待/充值/恢复/停止/一次结算和 402 测试保持。

上线后再看：关闭状态每次新准入多一次设置读取；先保留即时回退语义，实测延迟后再决定是否优化。
实测统计摘要仍需人工核验原始材料；本任务没有引入证据服务或把摘要自动当作真实成绩。
