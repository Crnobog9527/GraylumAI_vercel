# AGENT-CORE R15：已有定位入口（后端）

当前为独立模块准备，**未接线、R15 未完成**。依据 `AGENT_CORE_CLOSEOUT.md` R15 和
[#771 总控派发](https://github.com/Crnobog9527/GraylumAI_vercel/pull/771#issuecomment-6099912595)。

## 最小实现

复用 `opc.start(mode: "manual")` 创建的草稿和同一个 Runtime session。
`opc_start` 已把 mode 固定在草稿中，并对重复 requestId 的 mode/registration 冲突报错；
不新增表、迁移、会话、模型调用链或入口状态机。

新增 `existingPositioningInstructions`：仅接受服务端草稿 mode 和既有 host context；
空的第一步开场请用户粘贴/描述已有定位，后续结合本轮原话和笔记核对当前步骤。
原话仍走现有串行整理器，按冻结 Skill 字段映射到各步，不硬编码步骤或关键词判断意图。
确认仍走现有带快照/版本检查的整步确认接口，不能把粘贴或口头同意当成确认。

## 等待接线

`opc/service.ts` 按 R1 #784 → R16 #785 → R9 #782 → R15 排队。
在 R9 释放前不修改该文件。之后：

1. 同步 staging，在 `prepareStep` 的新 mentor admission 中，将 helper 返回值附加到
   `agentTurnInstructions()` 后；mode 来自 `opc_query` 的 d.mode，context 来自原冻结材料。
   additionalInstructions 与 stableAdditionalInstructions 都使用拼接后的完整字符串，
   满足现有 freezeHostPromptCache 的相等契约；回放路径保持返回既有 execution。
   helper 仅返回两种固定指令（接收/核对），不插入用户数据；核对阶段保持相同缓存前缀。
2. 补服务级测试：manual/mentor 分支、开场、已有各步资料、确认卡、跨步整理、重复请求、
   越权和被删除草稿。验证完整 admission 预算与缓存结构，不能仅以字符串长度证明运行通过。
3. 在包含候选的非生产环境做少量接口真实模型冒烟；先查共享 5 美元预算消耗，
   按 staging 账本实际美元和 executionId 在 PR 记账。不充值、不超预算、不使用浏览器。
4. 请求最终机器人审查。本任务不合并。前端在后端合并后由 Claude 接入。

## 前端接口（沿用，R15 行为尚未接线）

- `opc.start`：`{requestId, registration, mode:"manual", businessId?:uuid|null, businessName?:string}`；
  返回 `draftId/projectId/roundId/sessionId/businessId/businessName`。用同一 requestId 恢复重试。
- 直接进入 `/positioning/[draftId]` 的 Agent 工作区；不能再绕资料库，也不能因为 mode=manual
  禁用 Agent。本 PR 不改界面。
- `opc.read({draftId})` 取得冻结 workflow、information、stepConfirmation 等；第一步及字段 ID
  从该 workflow 读取，不写死。`opc.mentorTurnStream` 沿用现有开场和输入协议；用户粘贴走
  `purpose:"mentor", organizeAfter:true`，内容仍为原始用户输入。
- `OPC_AUTH_REQUIRED` / `OPC_DENIED`：认证或访问拒绝；`OPC_REGISTRATION`：工作流不可用；
  `OPC_REQUEST_CONFLICT`：重复请求内容冲突；`OPC_BUSINESS_DENIED`：无权访问业务；
  `OPC_STEP_DENIED` / `OPC_DEPENDENCIES_UNCONFIRMED`：步骤不可执行或前置未确认；
  `OPC_CAPTURE_PENDING` / `RUNTIME_ORGANIZER_PENDING`：整理尚未完成；
  `OPC_CAPTURE_INPUT_LIMIT`：整理输入超限。沿用当前路由错误封装，不新增错误码。

## 验证边界与恢复

独立模块测试只证明宿主选择和数据边界，不证明模型遵循指令或运行链路已经接通。
准备切片未被生产服务引用，可直接撤回本切片。后续接线不得改写历史草稿/冻结执行。
付费调用未运行，本切片新增费用为 0 美元；不是整个收口预算余额的声明。
