# Runtime 历史兼容与恢复

## 诊断（2026-10-04）

基线 staging `856661709fc25baaa57d73b6eb12c26075103bab`；来源：
[#624 总控诊断](https://github.com/Crnobog9527/GraylumAI_vercel/pull/624#issuecomment-5972280197)。
对 Owner 指定的六次执行，只读查询 staging `runtime_session_history`
（`runtime_session_items` 是其读取 RPC），仅返回结构、字段类型与格式标识。
六次执行的候选历史均为 revision 1–7。revision 7 的 assistant/output_text
携带 `providerData.reasoning_details[]`：
`{type: reasoning.text, format: anthropic-claude-v1, index: number, text: string, signature: string}`。
现有 strict schema 只接受 reasoning.text 的 format=unknown，且不允许 signature，
因此在派发前拒绝。revision 6 的 reasoning/rawContent 结构本身符合现有 schema。
未读取或保存用户正文、推理正文、签名值；所有回归数据使用合成值。

## 交付边界

风险为 high：涉及模型输入安全边界及拒绝原因持久化。
复用现有投影、历史选择/冻结、执行取消与 unavailable_reason；不新增基础设施。
独立审查、合并、远程迁移、部署及 staging 交互复测由总控安排。
实现与 Validation handoff 将随本 PR 更新。
