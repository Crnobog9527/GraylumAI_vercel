# CHAT-NATIVE-OUTPUT C0+C1 后端交接

状态：后端候选实施中；C1 的旧计费合同上下文证明尚缺，不能作为完整交付或合并候选。
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
- 后台暂时继续读到兼容的 version 1 形状及 maxOutputTokens=8192；旧表单提交转存 version 2，
  原 interactive/report 输出数值忽略，inputBytes/historyItems 仍有效。后续前端应把输出输入框改为统一上限只读值。
- 旧 text 事件本 PR 不删除。旧执行需要永久保留该兼容路径；移除旧客户端分支须另行核实所有消费端完成切换。
  慢加载、复制标签页识别、实际客户端漏帧处理与截断提示由后续前端 PR 实现。C2 停止不在本 PR。

## 容量与兼容边界

新准入 O 取既有环境上限 8192、模型能力和报价上限的最小值；整理器保留内部上限。
新 PAYG 在规范化请求后、hash/claim 前用冻结的 template/margin 和最终字节数计算 T，必要时缩减 O。
原计费公式、真实使用量结算、供应商回执与旧执行字节保持原路径；新 PAYG 每次输出界限可以小于稳定报价，已有 SQL 支持。

**未完成项**：新 v1 计费合同仍由现有入口创建，且无冻结的 #553 template/margin 输入 profile。
现有 inputLimit 是字节界限，不能当作已证明的 T；窗口报价校验仅核实成本上界，不证明 T+O。
候选对 v1 保留原输入/报价行为，没有伪造开销参数，也没有通过禁用现有入口来掩盖缺口。
完整 C1 需要可信输入 profile 或单独明确的兼容交付决定；不应将当前候选记为全量容量验证通过。

结果按 PostgreSQL jsonb 实际序列化字节计量，限制 262144；先预留整理空间，截短按码点前缀并重验 schema。
不可保留全部私有 T2 字段时退到紧凑信封。整理摘要超限或正文不完整时省略，checkpoint 正文保持不变。
Session 正文与已存结果同步；供应商回执不裁切。旧冻结执行不套用新裁切规则。
结果读取复用 runtime_view 授权和 runtime_execution(read)，不扩大表权限。元数据补充增加 1+N 次 RPC，
N 为可见且非空的去重 execution 数，每批最多 8 次；既有 read 锁可能令同会话读取串行，长历史仍有性能代价。

## 验证状态

- PASS：API 单元 4561 项；本地 Runtime 集成 266 项；API 与既有 Web 类型检查、后端 lint、代码规模检查。
- SKIPPED：无页面模式跳过 5 项浏览器/页面测试，另行补跑中。
- 进行中：页面恢复测试与最终候选 CI/Security。
- BLOCKED：v1 新调用的完整 T+O 输入 profile 证明，见上文。
- NOT_RUN：真实模型速度/费用测试、前端产品验收、独立语义审查；本 PR 不申请付费或配置权限。

## 回退

保留旧执行冻结格式与旧事件读取，不修改数据库。回退代码只能影响后续准入；已经生成的新冻结执行仍须由支持该标记的版本恢复。
保持 draft，不转 ready，不合并。全部要求满足前不标记“实现完成”。
