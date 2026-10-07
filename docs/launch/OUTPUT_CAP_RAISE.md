# OUTPUT-CAP-RAISE

风险分类：**high**。目标：staging；完成独立审查后停在主窗口审计，合并仍需批准。

## 改动与范围

2026-10-07 已批准提前实施：全站统一单次输出上限改为 32768，staging 同值。
这替代 CHAT_NATIVE_OUTPUT_PLAN §3.1 中 staging 保持 8192 的旧决定；不提前实施续写。
新准入仍取统一上限、模型能力、已批准报价三者的最小值；PAYG 派发前还受剩余上下文限制。
不按 Skill 分配上限，不增加长度统计、表、队列或状态机。

| 边界 | 原值 | 新值 |
| --- | ---: | ---: |
| 主模型统一输出 token 上限 | 8192 | 32768 |
| 完整响应接收字节（2 × O × 8 + 8192） | 139264 | 532480 |
| SSE 总接收字节（512 × O） | 4194304 | 16777216 |
| SSE 帧数（2 × O + 64） | 16448 | 65600 |
| 回执 payload 序列化字节 | 524288 | 4194304 |
| 单帧、查询与错误证据字节 | 65536 | 不变 |
| 结果、checkpoint、Session item 字节 | 262144 | 不变 |

接收上限不是保存预留。已有 native result / Session 按实际 JSONB 字节计量与截短；
不会按 32768 × 8 为首次调用预留完整结果空间。超出保存容量仍标记 length_limit。
interactive / organize / report 输入上限保持 90000 / 112000 / 196608；
整理器继续只由 v3_summary_max_tokens（128–4096）及模型、报价约束。

旧执行在读取新配置前返回冻结上下文；派发、重放和结算使用原 call policy、请求和回执。
用途配置内部仍标准化为 v2；落库保留 v1 形状和被忽略的旧输出字段 8192，便于代码回退；
管理界面只读显示当前 32768。不重写已有配置或执行。

## 迁移 0186 与恢复

现有 gzip 回执同时保存原始传输、SQL 重放 rawBody 和 sdkResponse；完整新上限的
转义正文、双份 reasoning 会越过旧 512 KiB。仅调大既有 CHECK 至 4 MiB，复用全部格式、
压缩、身份哈希和财务校验，不创建新持久机制。完整容量的流式/非流式测试必须证明回执原文保留。

任意高熵、非正文的巨量 SSE 注释仍可能超过回执边界；保留原有明确的
receipt_size_limit 诊断和未知费用恢复，不能冒充完整回执或零费用。
这是有界证据收集的既有失败路径，不是正常 32768 输出的容量截断。

本地文件建库指纹仅一个对象变化：
`con:bill2_receipts.bill2_receipts_payload_check`：`1556ac993aa6` → `0193ab03bb4d`。
迁移在历史位置连续执行两次通过；不改已有行、RLS、权限或函数。
合并后由主窗口应用迁移并抓取实际 staging 前后只读指纹；本任务没有远程数据库访问。
回退只能降低新准入上限，已冻结合同不改；保留大回执接收、解码、重放能力和扩大后的 CHECK。
不能直接回退整套旧部署或把派生接收容量一起缩小，否则新冻结的 32768 执行可能无法重放。
若要收紧 CHECK，必须先确认不存在超过 524288 的历史回执，不能删除回执来强行回退。

## 合并后的配置清单（本任务不执行）

按现有环境绑定定位测试窗口及模型，不新建测试身份，不重设已用费用。
应用 0186 后再放开新配置；部署与迁移窗口之间仍保留旧调用配置，避免大回执先于 CHECK 生效。

| 位置 | 目标值 / 操作 |
| --- | --- |
| runtime_test_windows.call_policies 中参与主对话/报告的模型条目 | outputLimit = 32768；仅在实际模型能力支持时放开 |
| 同条目的 upperUsd | 必须同步用 openRouterBound(providerLimits, 32768).upperUsd 精确重算，不能沿用旧值 |
| ai_models.max_tokens | 同一主模型设为 32768；能力较低的模型保留其真实较小值，不虚报能力 |
| system_settings.runtime_payg_staging.profiles 对应线路 | outputLimit = 32768 |
| 对应 reasoningVariants（实际启用的思考变体） | outputLimit = 32768 |
| 对应 evidence.outputLimit | 更新授权输出范围为 32768；testedOutputLimit、真实样本数、哈希和引用保持实际证据，不能伪造新实测 |
| profile 覆盖 | report 必须在 purposes；实际请求格式、思考变体必须已覆盖；保留原有证据要求 |
| 上下文准入 | profile.maxBytes + templateTokens + marginTokens + 32768 ≤ providerLimits.contextTokens；现有固定三项合计 204800，因此需至少 237568 |

首要报告模型是已有测试窗口里的 Sonnet / Gemini；其他用于主回复的模型同样受统一常量约束，
各自仍须有匹配报价、能力和 PAYG profile。整理专用模型不因本任务提高其整理输出。
不改各用途 inputBytes、窗口 inputLimit、v3_summary_max_tokens、价格倍数、次数/花费上限或已用额度。
不需要改 runtime_purpose_budgets 的输出字段；它已不参与新准入。

upperUsd 按既有整数定点计算：
`ceil12(max(promptPrice, cacheWritePrice) × contextTokens / 1e6 + completionPrice × O / 1e6) + requestPrice`。
PAYG 每次 claim 按最终请求实际字节计算 T，再由 T 与本次冻结 O 算 U / G / H。
启动门槛保留 `max(1, ceil(typicalUsd × q × m_call))`，不改成按新最大输出直接设门槛。
本任务不修改 typicalUsd 或现有价格事实。

## Hobby 超时与现有恢复

路由 maxDuration = 300 秒；模型请求最多 240 秒，且受剩余 work budget 限制；
工作截止 265 秒，持久化截止 285 秒，保留最终响应余量；SDK 包装超时 270 秒。
这些值保持不变。约 12000 字的既有速度估算并不保证排队、思考和网络情况下都能完成；
32768 写满可能超时，上限不是时长承诺。

派发前 SQL claim 和一次性 dispatch token 固定调用身份；SDK maxRetries = 0。
流中供应商 ID 尽早记入账本。超时不自动重新生成；有可用完整回执时按冻结请求重放，
否则用现有财务恢复查询供应商。已知 ID / 费用待定保留 cost_pending，身份未知保留 unknown，
不因为超时释放已派发冻结、不凭异常认定零费用。重复恢复沿用原身份，结算幂等。
若函数在持久化前被强制终止，恢复仍可能无法取得正文或立即确定费用；
这是“财务状态可恢复/可查账”，不承诺中断正文无损或自动续写。

## 验证与 Handoff

- PASS：本地空库回放 189 步，120 个迁移重复执行检查；结构指纹仅上述 CHECK 变化。
- PASS：API 全量单元 5390 项通过、12 项跳过；最终容量请求边界定向 9 项通过。
- PASS：BILL2 本地数据库集成 90 项；含 4 MiB 回执精确边界、32768 原文保留、保存截短和幂等结算。
- PASS：API 类型、ESLint、代码大小检查。
- PASS：Runtime 本地数据库集成 354 项通过、5 项跳过；上一实现提交全部 15 项 CI 通过。
- 复审：初审指出 Master Plan 旧上限决定未同步，已在 §2.1 补录批准并同步现行方案；最终 SHA 的 CI/审查以 PR Handoff 为准。
- NOT_RUN：付费模型、完整报告、staging 配置/迁移、部署和生产操作。
- 下一步：完成验证和独立审查修复后转交主窗口审计；不合并。
- 后续实测：由主窗口在合并并改完配置后，沿用同一草稿另行安排；累计预算 2 美元，背景记录已用约 0.16 美元。
