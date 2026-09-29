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
