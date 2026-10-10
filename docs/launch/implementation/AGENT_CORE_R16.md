# AGENT-CORE R16 — 本步收口（后端）

风险：high。Owner 已批准 R1 → R16 后端 → R4；R1 当前版本已通过机器人审查。
本 PR 从 origin/staging d4db3b58 新开，已同步 R1 合并后的 ea5a693c，不合并。目标是点击“这一步先到这里”后，宿主要求导师输出本步小结；
缺什么如实列出，仍由用户点击现有整步确认卡，不自动确认或进入下一步。界面由 Claude 另做。

## 接口与错误码

复用 `opc.prepareStep` / `opc.mentorTurnStream`，现有身份、草稿、步骤、预算、停止和重放保护继续生效。
请求的 `purpose` 为 `mentor`，`input` 为版本化宿主标记 `HOST_STEP_SUMMARY:v1`，提供原有 `draftId`、`stepId`、新的 `requestId`。
`organizeAfter` 必须省略或为 false；不同时提交 `answerSource` 或 `questionId`。重复同一请求使用同一 requestId，禁止变成新请求重复计费。
自然语言“这一步先到这里”不自动提升为宿主通知。宿主标记也不能被整理器当成用户新事实。

导师输出本步小结正文，沿用现有流式 text/result 和持久化 agent-turn.v1（message 正文、card 为 null）。
前端通过发起请求的宿主标记识别这轮为小结，将正文呈现为小结卡，并使用原来的整步确认 API / 版本校验。
缺少必填项时列出缺项，不代填、不自动暂缓、不宣称可以进入下一步。前端确认按钮仍遵守现有确认条件。
冻结的 `hostTurnContext.stepSummary` 包含当前步骤缺少的必填字段 ID；以当前冻结信息为准，不借用其他步骤的值。
本轮不提供 ask_question；允许最多一次 R1 read_skill_file 后继续小结。仍最多两次导师调用，按实际调用结算。
不附带整理器：宿主点击不是新事实，不应触发提取写入。发起前仍完成既有待整理恢复与材料同步。
使用现有冻结执行与重放，不改变旧请求行为。

`OPC_STEP_SUMMARY_INVALID`：错误用途、混合答卡/问题身份、organizeAfter=true 或损坏的保留标记。
`OPC_CAPTURE_INPUT_LIMIT`：加入缺项信息后宿主上下文超出原有容量；在准入与付费前拒绝。
`OPC_CAPTURE_PENDING`、`OPC_CAPTURE_MATERIAL_MISMATCH`、`RUNTIME_REQUEST_CONFLICT` 及既有身份/步骤/预算/确认错误码不变。
内部冻结结构不一致由 `RUNTIME_CONTEXT_INVALID` / `RUNTIME_STEP_SUMMARY_CONTEXT_INVALID` 拒绝，不作为前端新入口。
不增加表、RPC 家族或迁移；复用冻结执行和现有整步确认边界。

## 交接

- 已完成：宿主通知接线、当前冻结缺项、无提问卡工具/无整理器、重放和用户确认边界；无需迁移或新表。
- 按总控 #785 最新评论接手 opc/service.ts，顺序 R1 → R16 → R9；未修改 routers/runtime.ts 或前端。
- 本地针对性测试 24 项及执行器 12 项 PASS；类型、ESLint、代码大小与 diff 检查 PASS。
- 本地数据库集成 1 项 PASS / 549 项未选中 SKIPPED：完整 208 步建库，冻结缺项、重放、越权拒绝、不确认/不写字段。
  首次因指令超过现有 8000 字符上限失败，压缩重复指令后通过，并增加长度断言；未放宽上限。
  执行器模拟验证 read_skill_file 后返回正文、无 ask_question、恢复不重复派发；不是付费模型语义验收。
- 最终全量远程检查和机器人审查结果以 PR 交接为准，尚未返回时不算通过。
- 下一步：完成检查及独立机器人审查，随后停下等总控审计；不合并、不应用远程迁移，R4 暂不推进。
- 未运行：真实模型付费冒烟、前端体验验收。真实模型语义和 UI 完整效果不能由本地合成测试替代。
- 本任务付费调用 0 次；共享预算 5 美元，未读取共用 staging 实际美元账本，不推断剩余额度。
- 不使用浏览器。最新验证记录更新 PR 描述，避免仅为状态文档使已验证版本变化。
