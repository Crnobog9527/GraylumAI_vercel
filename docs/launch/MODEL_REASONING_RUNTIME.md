# MODEL-REASONING Runtime（MR-2）

Runtime 在准入时读取管理员保存的 `ai_models.config.reasoning`，校验用途、目录及完整线路
与测试窗口报价一致后冻结；执行和重放只读取冻结上下文。交互对话当前只接定位导师，
必须显式配置；整理未配置等于供应商默认，不发送思考字段。评审、写作不接入。

旧 `{effort}` 上下文及 v4 请求字节保持兼容。对象写法与供应商默认使用明确的冻结值；
attached organizer 单独冻结整理设置，所有冻结值参与现有 sourceHash，不新增存储设施。

已知限制：provider_default 沿用 checkReasoningConfig 规则，不检查强制思考模型的
4096 输出下限。模型或线路上限过低可能导致回复截断。

合并部署后仍需单独授权 staging 验证：导师真实对话 1–2 轮，核对请求携带
`reasoning_effort:"none"`、思考 token 为 0、每轮仅结算一次。本任务开发验证只使用模拟
供应商与本机隔离集成环境，不调用真实模型、不改变环境配置。


## 请求格式与兼容

- 原有 v4/v5 现在接受三种严格联合值：`{effort}`、`{parameter:"reasoning",value:...}`、
  `{parameter:"none"}`；v4 的 effort 写法仍生成原请求字节。
- 新的 `serial-tools-v6-reasoning` 仅是现有序列化格式标记：沿用 v2 的非流式发送与历史
  规范化，让独立整理及带整理的非流式调用可以冻结设置，不放宽旧 v1/v2/v3 的规则。
  它不启用 AC1-4，也不新增执行引擎。未配置整理时与旧 v2 请求逐字节相同。
- attached organizer 保存自己的 reasoning，matching 不发送思考字段。v4/v5/v6 必须有
  主调用 reasoning；旧格式不能夹带主调用或整理 reasoning。
- `checkReasoningConfig` 仅检查本次用途。有效输出上限同时受模型、线路目录、报价、
  Runtime 原有上限及整理上限约束；预算必须留出回答 token。provider_default 例外保持。
- 结构名单沿用共享 MR-1 常量，包含 max；适配器预算上限为 128000。依据
  [OpenRouter reasoning 文档](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)。

## 验证入口

准入测试覆盖配置/模型切换、sourceHash、重放不再读模型、完整线路匹配、用途与输出上限。
执行、序列化、SDK guardedFetch、适配器分别有反向测试，拒绝双写法、篡改和非法结构。
`runner.test.ts`、`runnerTools.test.ts`、`providerRequest.test.ts` 保留旧 golden hash；
新增测试证明当前导师配置生成相同 v4 字节，以及默认整理保持旧字节。
隔离 Runtime 集成覆盖两种写法、独立整理设置、配置变化后的中断重放、每次调用一次发送与
一条 BILL2 最终扣费记录。所有供应商响应均为本机模拟。

恢复边界：旧执行继续用已冻结值。新格式的未完成执行需要保留支持 MR-2 的执行器，不能
让旧执行器接管；如需回退，应先停止新准入并由支持新格式的版本完成或恢复这些执行。
