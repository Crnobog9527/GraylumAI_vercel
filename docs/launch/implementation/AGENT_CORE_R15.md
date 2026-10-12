# AGENT-CORE R15：已有定位入口（后端）

后端已接线（Claude 2026-10-11 接手 Codex 的准备切片）。依据 `AGENT_CORE_CLOSEOUT.md` R15 和
[#771 总控派发](https://github.com/Crnobog9527/GraylumAI_vercel/pull/771#issuecomment-6099912595)。
前端入口（不经资料库、manual 草稿启用 Agent）由 Claude 在后端合并后另做，本 PR 不改界面。

## 最小实现

复用 `opc.start(mode: "manual")` 创建的草稿和同一个 Runtime session。
`opc_start` 已把 mode 固定在草稿中，并对重复 requestId 的 mode/registration 冲突报错；
不新增表、迁移、会话、模型调用链或入口状态机。

新增 `existingPositioningInstructions`：仅接受服务端草稿 mode 和既有 host context；
空的第一步开场请用户粘贴/描述已有定位，后续结合本轮原话和笔记核对当前步骤。
原话仍走现有串行整理器，按冻结 Skill 字段映射到各步，不硬编码步骤或关键词判断意图。
确认仍走现有带快照/版本检查的整步确认接口，不能把粘贴或口头同意当成确认。

## 接线（已完成）

`opc/service.ts` 的 `prepareStep` 在新导师回合里，把 helper 返回值接在 `agentTurnInstructions()` 之后；
mode 取自按当前用户查询的 `opc_query` 的 `d.mode`，context 是本回合冻结材料生成的 hostTurnContext。
additionalInstructions 与 stableAdditionalInstructions 仍是同一个完整字符串，满足 freezeHostPromptCache 的相等契约；
重放路径在接线点之前返回，旧执行不变。mentor 模式草稿得到空字符串，行为与之前完全相同。

前提：环境必须配置 `system_settings.runtime_purpose_budgets`（staging 已配置，交互 90000 字节）。
没配置时 Runtime 沿用旧的额外指令 8000 字符上限；导师固定指令约 7700 字符，加上 R15 约 730 字符会超限，
manual 草稿的导师回合会在写入前被拒绝（集成测试覆盖），mentor 草稿不受影响。正式环境上线前须确认该设置存在（列入 RUNTIME-PROD 核对）。

验证：
- 单元测试（`existingPositioning.test.ts`）：模式判断、只在空的第一步开场请用户粘贴、已有资料时改为核对、不插入用户数据、缓存契约。
- 集成测试（`capture.integration.ts` 的 `RUNTIME: R15 …` 三项，CI 的 Runtime 必需检查会跑）：
  manual 开场冻结接收指令、mentor 草稿不受影响、开场重放；粘贴原话进入现有跨步整理（原话只在整理输入里，不进指令），
  整理写入第一步和第三步；口头「确认」只是普通导师回合，不改步骤状态；确认卡走带版本的 information 写入，过期版本被拒；
  已有资料时恢复为核对；其他用户和未登录用户被拒、数据不变。
- 真实模型冒烟：见 PR 记账。用 staging 已冻结的真实定位 Skill 提示词加 R15 指令直接调 OpenRouter，不经过 staging 服务；
  只证明模型会遵循这段指令，不代替 R12a 的 staging 浏览器验收。

## 前端接口（沿用）

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

没有迁移、新表或新状态；撤回本 PR 即恢复原导师行为，历史草稿和冻结执行不需要改写。
浏览器验收由 Codex 在 R12a 做。
