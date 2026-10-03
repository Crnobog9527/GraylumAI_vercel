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

## 实现与安全边界

- 只新增已观测的 `reasoning.text / anthropic-claude-v1` 严格对象：
  `text`、非负整数 `index`、非空 `signature`；正文/签名有现有响应容量上限。
  私有推理与签名只留在原存储，投影仅发送公开文本；不解码、不记录、不转发签名。
- 仅新执行持有 live 所有权、SQL 明确报告历史尚未冻结时，尝试完整校验旧历史。
  不兼容则依次尝试从后续 user 开始的后缀，但必须完整保留最近一轮 user 及其 assistant/tool 条目。
  若最近一轮不兼容、没有非空安全后缀，或恢复后的容量选择会丢掉最近一轮，按 provider_history 拒绝；
  不派发、不收费。技能匹配前同样检查历史兼容性，避免先产生匹配费用。
  保留对象身份与对应 revision，仍由既有选择器执行容量限制和 SQL 冻结。
  原始历史、来源权限、依赖检查、当前输入与工具轨迹不改写。
- 不在已冻结重放或当前模型调用中运行恢复。兼容变更对过去已经通过的请求投影不变；
  不以新的历史成员改写旧 request hash。重放不能取得 live 写入权。
- 只省略较早轮次时，本轮持久显示非阻塞提示：“较早的部分对话记录无法使用，本轮回复未参考它们”。
  原有正常回复仍可访问；刷新和重放不会丢失提示。
- 省略历史只记录 `executionId` 和省略条数，不记录条目、正文或推理。

以下形状仍不能进入模型：

| 形状 | 处理原因 |
| --- | --- |
| 未知 format/type/字段，非法 signature/index、非空 annotations、非文本内容 | 无已验证的语义和路由保证，不做任意字段清洗 |
| 未知工具、并行工具、重复工具信息不一致、孤立/不配对结果 | 不能改变工具授权或拼出虚假的调用链 |
| 带签名/加密推理的工具续接 | 文本投影无法保留供应商要求的原始推理链，继续拒绝 |
| 当前输入或当前工具轨迹不兼容 | 必需上下文不可被当作可选旧历史删除 |
| 已冻结历史不兼容 | 不改变冻结成员及重放请求身份 |

这些不兼容条目若属于**未冻结且早于最近一轮的可选历史**，可以连同它之前的历史安全省略；
“省略旧历史”并不表示接受该形状。调用前的 sizing 与 wire 校验继续严格执行。

已知限制：**开启推理的 Claude 停在工具调用上（签名推理续接）仍被拒**。最近一轮出现该形状时
不能安全省略，也不能用公开文本替代供应商要求的签名链；本 PR 不实现签名推理续接。

`0163_runtime_history_failure.sql` 复用原 `runtime_execution`、`runtime_session_items`、`runtime_view`，不新增表、RPC 或权限。
在现有 execution 增加 `history_omitted` 布尔值，与首次 selected_history 冻结原子保存，重放不能改写。
这是区分兼容性省略和普通容量裁剪所需的最小持久事实：仅比较 candidate/selected 无法区分原因，
`unavailable_reason` 会撤销内容访问，result/payload 属于冻结模型输出，均不适合存非阻塞提示。
view 在原内容授权通过后返回该标记，runtime 与 mentor 页面均在刷新后显示提示。
只有原 `fail_before_dispatch` 的零派发取消条件成功时，才原子记录
`unavailable_reason=provider_history`；原因仅允许这一固定值。旧调用方省略参数的行为不变。
该字段原本就禁止内容访问，因此失败执行的输入正文也不会通过 view 返回；之前成功轮次不受影响，
没有删除任何记录。重复 execute/read/view 会保留原因，不重新派发或重复收费。

建议在获批的 staging 迁移窗口先应用 0163，再部署应用，以一次获得完整体验；顺序反过来也安全，
只是功能降级。旧应用可运行于新 SQL；新应用遇到旧 SQL 缺少 historyFrozen 时保守禁用恢复，
旧 SQL 也不会持久化新的拒绝原因/省略提示。不能把混合版本当作完整验收通过。
本任务不执行远程迁移。回退采用后续迁移恢复 0106 的 runtime_execution 和 0158 的
runtime_session_items/runtime_view；新增布尔列可保留并忽略，无需破坏性删除。
已记录的拒绝原因继续保持不可用，不清空它来绕过内容权限。

## Validation handoff

由总控安排独立审查、合并及迁移/部署后执行。不要直接给真实会话注入异常条目。

1. 确认 staging 部署包含本 PR 的最终 head、0163 已应用；使用既有 staging 测试账号，
   Chrome 桌面 1440×900，打开原故障工作对话 `/runtime?session=<原会话>`。
   连续发送两条普通消息，中间刷新一次。预期均能进入模型并正常完成，不再立即 history denied；
   原有成功对话仍可查看。只记录 execution/deployment 标识、状态、耗时和调用数，不公开正文。
2. 本地隔离测试使用合成未知元数据：最近一轮不兼容时，确认 provider_history 拒绝、
   零模型派发、退款后零收费，不能通过空历史继续。对应 `... unsupported` 和 `... frozen-unsupported`。
   runtime 与定位 mentor 页面均显示 PROVIDER_HISTORY_NOTICE：
   “这条对话的历史记录格式不兼容，本轮无法继续。请新开一个对话，并重新提供需要参考的内容。”
   刷新、重新进入后仍相同，不显示“已停止”，不提供无效重试；旧本地停止标记不能覆盖服务器原因。
3. 仅较早轮次不兼容、最近一轮完整安全时，确认正常完成，并显示：
   “较早的部分对话记录无法使用，本轮回复未参考它们”。刷新后回复和提示均保留。
   对应 `... older-unsupported`：selected_history 保留最近一轮原 revision，原 Session 记录仍在，
   provider 请求不含未知元数据/私有推理/签名。中断后重放保持相同请求 hash、提示及调用数；
   不重新派发或重复收费。冻结 RPC 非法标记/空后缀不能绕过校验。

4. 正常工作对话开始回复后主动点停止，确认仍使用 #624 的用户停止文案；非 history 的服务端结束
   仍使用 #624 的普通结束文案。375×812 下确认新提示完整换行、无横向溢出。
5. 新开一个对话并重新提供所需内容，确认能正常继续；失败旧执行不被重放。

通过标准：上述结构/状态/文案均符合预期，无原始正文公开，无新增重复派发或收费。
本地合成 SDK/SQL 验证与 staging 交互复测是两层证据；未部署时不能声称现场会话已恢复。
