# 聊天内 Skill 引导：本地验证与恢复边界

本次实现对应 Owner 指定的 #388 产品修订，基线 staging
`420b420ba25d1433ee8c9bbf8712a0ba04b1f6b3`。风险为 high：新增持久化绑定、
权限检查及原生成计费路径的上下文整合。本文不授予合并或外部启用权限。

## 最新 Owner 修订：对话与整理模型强制分离（实现进行中）

2026-09-08 Owner 明确要求用户对话模型与成果整理模型分开，整理使用独立低成本模型；此前单次调用同时回复并整理的63be8b9验证只作为历史证据，不能满足本次要求。PR389已转为draft，原合并交付暂停。

实现验收要求：后台独立选择整理模型及输出上限；不与主力模型共用、缺失不回退；主力回复先持久化并显示，整理阶段使用该回复、当前保存成果及允许的上下文，输出进入自动保存；整理失败保留已完成回复与原成果；两次调用独立预留、结算、日志和未知结果恢复，不能重新调用已成功的主力回复来恢复整理；汇总完成不自动确认下一步。模型名称必须来自已验证供应商配置，不把 Codex 界面模型别名直接当供应商API名称。

## 双模型增量验证（尚未完成最终验收）

本地双模型调用、独立用量及禁止回复直接作为成果已通过SQL验证；整理模型配置策略12个单元测试通过，Web类型检查通过。最新恢复专项12个用例通过，覆盖已付费成果从服务端恢复、放弃状态跨会话保持、原保存回执恢复、并发放弃优先于未提交保存、二次网络未知保留冻结请求及后续编辑、关闭轮次的人工保存已提交/未提交分支。专项明确跳过67个其他场景，不能代替完整回归。迁移0070重复应用通过，应用日志无私有canary。

Qwen 已按真实 `qwen/qwen3.8-flash` 模型ID适配固定OpenRouter文本请求，并显式关闭reasoning。后台模型选项与运行时共享静态准入规则；新接口的匿名/普通用户拒绝、管理员四字段投影、数据库错误脱敏已通过真实router caller单测。Qwen不使用o200k计数：当前按UTF8字节加框架余量准入，保守预留完整配置输入容量，供应商用量超出预留时保留原unknown及无正文对账证据，不返回成功候选或自动再次调用。该容量策略不是精确Qwen分词器证明。

Qwen/OpenAI双阶段及输入越界3个真实SQL专项通过；相关79个单测通过。全API两次分别1508通过/1计时失败（AgentKey 200ms初始化、PII 100ms性能），两文件单独复测通过，当时全量尚待浏览器结束后复核，最新结果见下节。当时测试代理双路径版本仅离线准备，未增加真实调用；后续供应商限流现场见下节。

这些仍是一次性本地数据库、真实HTTP/浏览器与合成模型的验证；真实双模型体验、最终候选CI和两项审查尚未完成。没有新供应商收费调用、远程配置或迁移操作。

## 最新交付检查（2026-09-08）

聊天完整回归40通过/40跳过；其后输入越界及Qwen/OpenAI双阶段3专项通过，范围化入口4专项通过，覆盖首次创建、同请求复入不重复、当前坏注册拒绝、其他坏注册隔离、模块重绑定和社交账号约束。全API在浏览器结束后1509单测通过；Web类型检查、lint、无真实凭据生产构建通过。0070重复应用和各进程独立canary检查通过。

本地同模块目录HTTP从5.6秒变为303毫秒。首次创建与复用项目不是相同测量，不能用两次chatEnter时间声称同条件加速倍数。模型可用性选项、限定模块目录和本地证据目录隔离已实现；最终远程CI与两个精确候选审查仍待完成。

本轮真实双模型体验未通过：新Qwen首请求返回HTTP429，整理未开始。原请求保留unknown、未自动重发；密钥只读累计usage未增加，但不能据此取消原请求预留。该次本地保守预留约0.005864美元，累计本机预留0.06769410美元，仍在原1美元预算内。临时代理新路径严格透传Qwen与GPT-4o-mini的实际ID，旧路径仅供此前Qwen体验兼容。此记录不能替代真实两阶段成功证据，也不授予扩费、部署、远程迁移或合并权限。

## 先前实现行为

首页「开始分析」统一打开功能广场，模块「使用」进入 `/chat`；旧 `mode=skill` 入口重定向到广场。顶部不再提供重复的 Skill 引导导航。服务端区分有流程的 Skill、
普通文档 Skill 和自由聊天。有流程时左侧历史、中间多轮消息、右侧真实配置步骤；
窄屏右栏可收起。聊天固定关联用户、模块、Skill、项目和轮次，打开历史恢复步骤。
普通聊天不加载流程目录，也没有右栏占位。

0069 为增量迁移，不改写既有工作台历史。聊天消息和 AI 候选、工作稿、确认、
发布仍是不同操作；沿用原成果、来源、版本及原子计费事务。新消息提交时固定
当时已成功的相关前文及完整来源，后来完成的回答不会进入该消息的报价上下文。
方法停止执行不删除历史，也不阻止读取来源仍允许的内容或恢复已知结果。
新执行仍要求当前方法准入。重写工作稿并取消关联某份资料后，后续发送会排除依赖该资料的旧讨论上下文，已有可读历史保持不变；失效的未预留发送通过原有取消记录结束，不改写旧消息或重发已调度请求。旧 `/workbench` 提供继续固定轮次聊天的显式入口。

## 2026-09-08 早期体验修订记录（交互已被下方自动保存优化替代）

直接「发送」替代查看报价再发送，不展示每条消息的预计积分。后台仍取得服务端报价，按原请求身份检查、预扣、结算；报价阶段编辑消息则取消旧发送意图，未知已发送结果仍按原身份恢复。取消前台报价展示不改变服务端定价或余额体系。

右栏按需展开「参考资料（可选）」「本步骤的确认记录」「历史版本」，提供「重新做一版」。来源渲染为资料正文/检索条目，避免直接展示内部 JSON；供应商未给链接时明确标记缺失，不合成一个已核实来源。所有外部文本只作显示，不执行 HTML、脚本或自动请求。采用候选、编辑、保存、确认和发布仍保留用户控制。

当时的 AgentKey 核验记录（不是当前余额或授权状态）：AgentKey 搜索接入单独交付：当前代码只具备已核验的 X 账号/帖子适配器，尚无可上线的通用搜索结果契约、Graylum 取数定价或真实许可验证。资料展示支持已有研究结果，不宣称发起过实时搜索。Owner 批准的两轮元数据核验累计执行 8 次 find_tools、9 次 describe_tool，并免费读取一次 agentkey_account；真实搜索执行为 0。已发现 Tavily 网页搜索（当时报价 1.1 AgentKey credits/次）及小红书笔记搜索（2 credits/次），最近读取的 AgentKey 余额为 5 credits。接口说明未提供完整返回契约，单次真实公开网页取数仍待独立费用批准。不得猜测工具名称、静默扩展白名单或把本地合成搜索当作实际可用。既有凭证仅在本机进程使用，未修改配置；这些历史余额与报价不能代替执行前复核。

## 复现

在安装依赖且 Docker 可用的本地执行：

```sh
node packages/db/tests/v3/run-workbench.mjs
node packages/db/tests/v3/run-workbench.mjs --chat-only
node packages/db/tests/v3/run-workbench.mjs --chat-only --serve
pnpm --filter @repo/api test:run
pnpm --filter web typecheck
pnpm --filter web lint
```

完整运行覆盖既有工作台及新聊天场景，并在真实应用重启后执行恢复阶段；
`--chat-only` 显式跳过旧场景，仅运行名称以 CHAT 开头的用例。
`--serve` 在测试通过后保留一次性环境供产品体验，终端打印本地 URL，
输出目录 `acceptance.json` 提供一次性虚构登录账号。停止运行器后清理容器及临时源码。
每次输出记录源 HEAD、源码树摘要、原始结果及脱敏应用日志；以该次实际输出为准。证据保存在每次独占的临时子目录，启动时输出 LOCAL_EVIDENCE_DIRECTORY。V3_WORKBENCH_OUTPUT 如有设置，仅指定证据根目录，运行器仍创建独占子目录，避免并行覆盖或清理其他运行的恢复文件。

运行器使用一次性 PostgreSQL、GoTrue、PostgREST 和无凭据源码副本。
真实 SQL、Auth、HTTP 和浏览器交互连接合成模型 transport；只在临时副本替换
固定发送点，服务端 fetch 拒绝非 loopback 主机，自动化浏览器也阻止外部请求。
合成模型只用于验证上下文、费用流、持久化和恢复，不能证明真实模型质量或供应商行为。
发版代码没有假模型开关。本地配置、虚构账号及 Key 不写入发版迁移。

构建使用 CI 同款无效 Supabase 占位配置。现有 lint 配置不匹配 TS/TSX，
其命令通过不代表新增 TypeScript 规则覆盖；类型检查及构建单独记录。
GitHub required checks、完整候选 Codex Review 和 Owner 指定的独立 Codex 审计
必须分别取得准确候选结果；本地记录不能代替它们或 Owner 产品体验。

## 审查后的入口兼容修正

普通聊天收到服务端 init 后立即更新会话 URL，创建者在 URL 更新和历史查询回填期间保持同一组件实例，避免中断正在接收的流。中止/错误后的刷新仍定位到已落库的会话。普通生成失败只持久化失败记录和会话身份，不保存未完成消息正文；客户端停止也不代表供应商已取消或费用已退还。成功消息的正文恢复由成功路径验证。

社媒模块改绑另一 Skill 时，不支持把已有账号项目直接迁移到新 Skill。保留同账号一个项目与固定历史方法身份，在创建前返回明确业务冲突并提供旧项目历史入口；数据库唯一约束继续处理竞态兜底。不修改旧项目绑定，不创建重复项目，也不宣称已支持跨 Skill 迁移。

## 兼容与恢复

0069 可重复应用，保留旧项目、报告和生成/计费记录；不做历史删除或数据搬运。
未来部署需先在批准的非生产环境执行增量迁移，再启用兼容该模式的应用代码。
若需要恢复应用，优先向前修复；必须保留普通生成接口对 guided conversation 的
扣费前拒绝检查。不能直接回退到不识别 `skill_mode` 的旧应用：旧流可能先调用模型，
随后才被新的消息写入检查拒绝。不能通过删表、请求或流水来规避这个边界。

未知已发送请求不能换身份重发或推测退款。加密结果凭据沿用原项目/轮次会话存储；
如果服务端结果入库失败同时客户端也未收到凭据，或用户清除会话存储，仍需外部
证据核对，不能保证自动恢复。测试证明的本地恢复不扩大真实外部调用授权。

本分支在 `apps/web/vercel.json` 显式禁用自身自动部署，main/staging 规则不变；
没有修改 Vercel 项目设置。
早期合成验证阶段未运行远端迁移、真实模型或 AgentKey 搜索取数、真实收费、部署或生产操作；上述 AgentKey 只读元数据和免费余额查询除外。随后 Owner 单独批准的公开网页搜索已执行一次，AgentKey 余额由 5 变为 3.9 credits；该结果不代表产品搜索入口已经接通。后续真实模型验证见下文，远端迁移、部署和生产操作仍未执行。
真实模型对抗、研究/账号接线、许可、预算、保留与物理删除、完整 M3 保持各自未完成状态。

## 当前对话成果自动保存优化（2026-09-08）

Owner 体验反馈调整了交互：功能选择后直接显示对话布局；只有需要选择账号时显示选择项。
每轮模型生成完整的当前步骤成果，综合已有成果和允许的历史，保留已确定信息、合并修改、
移除明确否定内容，缺失信息保留为问题。生成内容自动进入未确认成果保存队列，不自动确认。
确认按钮先提交当前成果的明确确认，再打开依赖已就绪的后续步骤；末步骤只确认。

人工编辑和模型成果共用防抖保存、版本比较和原请求重放。保存成功时仅推进该客户端
已确认写入的版本，保留飞行期间的新编辑；确定版本冲突需要比较并显式采用最新版本。
网络或未知响应不能换请求身份；仅两类精确的服务端未提交错误可以释放原保存请求。

同一浏览器会话按认证用户和 conversation 隔离保存本地恢复内容，恢复前核对服务端
project/round，并继续使用原有来源和权限校验。浏览器存储不可用、清理数据、设备丢失
不承诺恢复；离开时尚未提交到服务端的内容也不等于跨设备同步完成。

回归包含候选保存期间编辑、原保存提交后丢失响应的重试/刷新恢复、浏览器后退恢复、
外部版本冲突后的人工比较和继续保存。最终结果以当轮日志为准。
真实模型体验通过单独的本机代理接入，凭据与累计预算留在仓库外私密目录；
代理不携带正式账号或生产数据，不启用搜索/脚本/浏览器工具，不重试未知收费结果。
真实模型效果与合成 transport 的 SQL/HTTP 回归分别记录，不能相互替代。

本地恢复的直接来源与完整来源记录分开保存。显示脏稿、恢复候选和重放冻结保存前，
重新校验完整来源可用性；候选还必须在当前服务端投影中可读。缺少完整来源记录的旧
本地恢复项不作为可读内容恢复。历史回复只读展示，不承诺已失效候选能够再次恢复写入。

### Real-model current-result refinement (2026-09-08)

Local Qwen `qwen/qwen3.8-flash` testing found that an older conversation reply could displace a directly edited topic despite the saved body being present in the general step context. Chat generation now names `currentStepResult` explicitly and instructs the model to use the latest saved result before older replies, applying the current requested changes. This does not confirm the step. Four configured-workflow SQL/HTTP tests verify the saved body/version reaches the generation transport; web TypeScript passed.

Real browser retesting retained community-family audience, online sharing, pet-action photography, October 12, Tencent Meeting and 60 minutes, then changed only the requested budget from 1200 to 1100. Model results saved automatically. This is observed text-model behavior, not a guarantee for arbitrary Skills or every model output. An earlier separate provider operation remained unknown after timeout and was not retried; its conservative budget reservation remains held. The temporary credential and budget control stay outside the repository and apply only to the local test.


## Luna 与审查修复（2026-09-08）

Owner 指定整理模型 `openai/gpt-5.6-luna`；公开 OpenRouter models/endpoints 元数据已只读核验。新增精确模型 ID 适配，推理 low，固定端点、无工具/旁路/自动回退；以完整配置输入容量保守预留并按供应商实际 usage 核对，不声称使用其精确 tokenizer。本地测试配置已改为 Luna，凭证仍在仓库外，未增加真实调用，原 1 USD 总预算不变。

独立审计发现的父回复模型漂移已修复：整理同时与当前对话配置及父回复不可变 quote 的模型 UUID/provider ID 比较。内部 context 只返回两个模型身份字段；不开放生成记录表读取。数据库 INSERT/dispatch 也拒绝同模型，已 dispatch 的已知回执恢复保持可用。第一次专项因直接读取受保护表而 4 FAIL，改用既有受权限检查的内部接口后 4 PASS；失败不计入通过。

GitHub 审查的两项同时修复：scoped catalog 的 100 项上限只计算目标模块，原全局 catalog 上限保留；对话回复使用独立 20000 文本上限及 token 上限，summary/legacy 仍受成果步骤长度限制。

最新本地专项 `graylum-luna-review-regression.log`：5 PASS / 78 SKIP，覆盖 OpenAI/Qwen/Luna 三种双阶段组合、长于成果上限的正常对话、父模型 UUID/alias 漂移在服务和直接 SQL 准入时拒绝、来源撤回后已发出整理的结算恢复、超过 100 个无关注册时当前模块入口。迁移重复应用和日志 canary 检查通过。相关模型/transport 单测 40 PASS，Web typecheck 通过。真实双模型成功仍未验证；旧候选审查与 CI 不替代下一候选复审。

补充反向专项 `graylum-oversized-summary-validation.log`：1 PASS / 83 SKIP，真实本地 SQL 验证 summary 101 字符超过步骤 100 上限后进入 unknown、原 reply 可读、无成功 summary 候选、仅原 reply 一条 token 结算、同请求重放不再调用 transport；canary 通过。

后续独立 Luna 虚构整理试跑返回供应商 HTTP 403，未得到内容，未自动重试。当前累计 10 次调用保守预留 0.10129650 USD；只读 key 元数据仍显示余量 1.997864138 USD，但本地 Owner 总上限保持 1 USD，不能据余额推断拒绝原因或释放未知预留。该独立探测不代表完整产品两阶段链路通过。

## 跨步骤未保存成果与发送（2026-09-08）

GitHub P1 3956133617 已修复：发送按钮、send 函数入口、可恢复 run 回调均检查所有步骤的 dirty 成果；报价返回后再检查，发生编辑则按原未预留请求执行 abandon，不能携带旧已确认前序内容生成收费回复。已发出/unknown 请求仍保留原身份恢复。

`graylum-dirty-send-final-validation.log`：2 PASS / 84 SKIP，真实本地浏览器/HTTP/SQL验证：前序编辑后切后序在自动保存前不发 quote/generate；保存后前序失去确认。另一个场景将quote响应挂起，此期间编辑成果，释放后零generate且旧意图abandon；编辑保存后显式再次发送成功。私有canary检查通过。Web typecheck PASS。该专项不代表真实模型或完整V3验收。
