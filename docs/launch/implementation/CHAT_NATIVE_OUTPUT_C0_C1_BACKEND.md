# CHAT-NATIVE-OUTPUT C0+C1 后端交接

状态：按总控审计 #640 评论 5984616610 修复后端候选；最终验证与独立审查记录见 PR。
依据第四版方案与 #635 拆分说明。风险 high：涉及 Runtime 准入、结果保存、计费请求绑定及重放边界。
没有修改 apps/web、数据库结构、正式环境值或外部配置，没有真实模型调用。

## Handoff：前端接口

- `opc.mentorTurnStream` 与 `runtime.executeStream` 可选传 `textProtocol:'textDelta-v1'`。
  只有新冻结 `nativeOutput:'native-output-v1'` 的 C0 回合使用增量；不传协议或旧执行仍返回原 `text` 全文事件。
- 新事件 `{type:'textDelta',offset,rev,text}`：offset 按 Unicode 码点计数；第一条 offset/rev 为 0。
  offset 为 0 时替换整段；来源切换或权威正文修正时 rev 加 1，窗口内未发出的旧增量丢弃。
  非快照帧只在 rev 相同、offset 等于已显示码点数时追加；不连续就停止追加，等待快照或终态。
- 中间文字只属于原始 HTTP 流；并发重连返回 pending，不重放中间正文、不重新调用供应商。
  已完成执行重连返回终态快照及 result。无需新增持久状态或迁移。
- result 与可见的 runtime.view 执行可包含 `completeness:'complete'|'length_limit'`、
  `organized`、`summaryOmitted`、`envelopeCompact`、`messageFirst`。
  截断提示放在正文之外；length_limit、紧凑信封或未整理结果不能视为完整定位候选。
- 新 step 冻结既有 `serial-tools-v4-stream`、相应推理设置与 `envelopeOrder:'message-first-v1'`。
  只流式显示公开 message；属性不在开头则缓冲至完成并标 messageFirst:false。plan 保持缓冲。
  附带整理仍非流式。卡片请求/schema/冻结格式不变，仅宿主投影改为渐进显示 message。
- 后台暂时继续读到兼容的 version 1 形状及 maxOutputTokens=8192；旧表单提交仍保存 version 1 兼容形状（输出字段固定 8192），
  原 interactive/report 输出数值忽略，inputBytes/historyItems 仍有效。后续前端应把输出输入框改为统一上限只读值。
- 旧 text 事件本 PR 不删除。旧执行需要永久保留该兼容路径；移除旧客户端分支须另行核实所有消费端完成切换。
  慢加载、复制标签页识别、实际客户端漏帧处理与截断提示由后续前端 PR 实现。C2 停止不在本 PR。

## 容量与兼容边界

新准入 O 取既有环境上限 8192、模型能力和报价上限的最小值；整理器保留内部上限。
新 PAYG 在规范化请求后、hash/claim 前用冻结的 template/margin 和最终字节数计算 T，必要时缩减 O。
原计费公式、真实使用量结算、供应商回执与旧执行字节保持原路径；新 PAYG 每次输出界限可以小于稳定报价，已有 SQL 支持。

**C1 适用边界（Owner 本轮确认）**：T+O 校准仅适用于 v2 PAYG profile。
v1 保持现有报价、冻结和字节上限，O = min(8192, max_tokens, 报价 O)，不构造字节换算 T 或额外常数，不关闭入口。
v1 的 openRouterBound 按整个上下文输入加报价输出冻结；实际 O 不超过报价 O，适配器仍拒绝越界请求。
超出模型上下文的请求沿用明确结构化 4xx 的放弃/释放路径；这是既有容量体验限制，不是新增计费缺口。
后续 PAYG 接线和正式环境上限选择必须证明 profile 覆盖所选 O；不在此 PR 声称已经完成。
原 staging 只读核对请求已撤回，不访问远端数据库。

step 白名单只清洗，不因非标准字段拒绝正常回复：字符串 message 原样保留，坏 patch 丢弃，
status 除 unclear 外映射 provisional，basis 缺失/异常映射 user_statement，非法 inputKind/targetStepId 丢弃。
字段 ID/目标步骤的授权过滤仍由现有消费者执行。非 JSON 正常回复保存为正文，不进行信封裁剪；
空 message 正常完成不被拒绝。只有供应商 length 且没有可用信封时，step 才走原截断失败路径。

结果按 PostgreSQL jsonb 实际序列化字节计量，限制 262144；先预留整理空间，截短按码点前缀并重验 schema。
不可保留全部私有 T2 字段时退到紧凑信封。整理摘要超限或正文不完整时省略，checkpoint 正文保持不变。
对已经明确 length_limit 或 envelopeCompact 的新主回复，checkpoint 后不派发不可采用的整理调用，
以空摘要、未整理标记完成原计费关单，按现有规则释放未用预留。正常完整回复的整理及未知费用恢复保持原路径。
Session 正文与已存结果同步；供应商回执不裁切。旧冻结执行不套用新裁切规则。
结果读取复用 runtime_view 授权和 runtime_execution(read)，不扩大表权限。元数据只补最近 8 个可见、非空、去重 execution；含 view 总共最多 9 次 RPC。
更早历史保留 SQL 原形状，需要完整元数据时通过原 execute 读取终态。既有同会话锁仍可能串行；
1000 条历史的模拟延迟测试验证新增开销有界；100 回合真实本地 PostgreSQL 测试验证补读最多 8 次、
读取低于 1 秒、权限撤销仍生效。两者都不是实际 staging 耗时基准。

## 验证与后续必测

本轮覆盖：纯文本/空 message/confirmed patch、带整理的 step 流式、缓冲入口路由、
带工具调用时 length、原生标记下门控回归、v1 8192/8193 边界、长历史元数据补读上界、v1 配置回退。
最终 PASS / FAIL / SKIPPED / NOT_RUN、精确 head 和独立审查归属更新在 PR，旧 head 的绿灯不能替代新 head。

后续 PAYG 接线前必须补测：原生输出与 PAYG waiting_credits / waiting_resume、跨 HTTP 请求恢复，
确保正文/checkpoint/offset/rev、只派发一次和只结算一次保持一致；当前业务路由尚未接线，不能记为已验收。
正式环境上限选择还需 profile 覆盖 O、响应/帧/回执大小和真实模型时间/费用证据；本 PR 不做付费采样或配置改动。
前端负责新的增量消费者、存储恢复、截断提示及后台只读控件，相关产品验收 NOT_RUN。

## 审计 P3 与方案偏差

- 删除 opc 路由多余的空 import。
- 暂保留原生流出错后的固定纠正提示；超时/结果未知同样可能显示此提示，但执行恢复/计费仍以原状态为准，
  不把提示视为允许重发或已取消的证据。区分错误文案留后续前端状态体验处理。
- length_limit 或紧凑信封跳过不可采用的附带整理，并标 summaryOmitted；这是相对 §4.3 的明确偏差，
  防止已保存正文被无法使用的整理请求卡住。后续总控同步方案；此 PR 保留并测试关单与未用预留释放。
- 单独代理字符可能暂显 U+FFFD，最终权威快照纠正；合法跨片段代理对已有逐字一致性测试。

## 回退

预算设置在前端切换之前始终写 version 1 兼容形状，无需回退前远端重存设置；内部归一仍支持 v2。
保留旧执行冻结格式与旧事件读取，不修改数据库。回退代码只能影响后续准入；已经生成的新冻结执行仍须由支持该标记的版本恢复。
保持 draft，不转 ready，不合并。风险 high；本次实现和验证不构成上线授权。

共享文件核对：#633 不改 Runtime，但与本 PR 的既有提交同时涉及代码规模及 ESLint 基线文件；
已核对为不同键，双方该文件均无本地未提交改动。本轮不再写这两个共享文件；后续若需调整，必须先串行协调写入。
