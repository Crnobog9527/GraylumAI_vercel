# STG-MENTOR-MODEL：无缓存探测准备与真实入口

2026-10-02；真实模型调用 0 次；Owner 已批准预算，本次仅做第1步入口实现，保持 draft，待总控审。

## 本轮范围与 Owner 更正

按 [Owner 更正](https://github.com/Crnobog9527/GraylumAI_vercel/pull/561#issuecomment-5935197856)：
本轮仅 Gemini / Sonnet 主评测及端到端，全部不带 `cache_control`。
提示缓存是上线必做功能；缓存实验**延后到 PROMPT-CACHE 合入 staging 之后**，届时在真实产品路径
测 Sonnet 和 Gemini 的缓存命中、延迟及真实费用，另报次数与预算。不是取消，也不是可选功能。

Owner 已说明额度够用；不再以测试密钥余额 >= 本轮预算为前提，不要求充值，不换 key。
账本逐次预留、单次上限与累计上限仍保留。若真实执行遇拒绝/未知结果，停止报告，不重试、不补样本。
本轮没有重读真实密钥；真实账本前后全文件 hash 相同，调用数仍 736，金额未因本轮变化。
不把这一检查外推为此前全部时间段金额均未变化。

## 冻结与最小改动

[#497 冻结声明](https://github.com/Crnobog9527/GraylumAI_vercel/pull/497#issuecomment-5934332975)：
`f9afd0db7805e80ccc6f5b7023a3e87b5014f5bd`，SDK 0.18.0。
独立 detached checkout 只叠加本 PR 探测脚本和临时测试入口；结束后入口恢复，冻结工作区无差异。
不写 #497 分支及其工作区，不改 Runtime、提示词、工具契约、账务、迁移或数据库结构。
原 runner 自带的临时测试替身仍存在；本次使用的 OPC → Runtime → SDK/Session → BILL2 核心调用链未改。

以下为上一轮离线准备（本轮入口增量见末节）：
- `scripts/stg-mentor-offline.mjs`：限定完整冻结 SHA、detached 且干净的副本，校验原 40 题 hash，
  将受控本地 Skill/样本交给现有 `run-workbench.mjs --opc-only --with-staging-schema`；上一轮无 live 参数。
- `ac0Probe/mentorPreparation.mjs`：复用原样本转换、冻结 Skill loader/指令、五字段工具、Runtime Runner、
  `openRouterRequestBody`、历史规范化、结果投影、adapter、`callBoundUsd`、`memoryLedger/createBudget` 和合成响应工具。
  没有新建评测框架、持久账本或数据库表。真实账本没有写入，硬上限没有提高。

运行前在独立冻结副本安装锁定依赖；入口接受四个位置参数：冻结副本、受控 Skill 目录、原样本 JSON、私有输出目录。
运行命令为 `node scripts/stg-mentor-offline.mjs <frozen-checkout> <skill-directory> <scenarios-json> <private-output>`。
原样本文件 SHA-256 为 `0be012a845999a8d6c345a74df7a66e9cb61e3242dac4db98880ef8ebcd2564a`。
私有输出保存逐条 B/T/requestHash/费用预留；公开只保留[聚合结果](STG_MENTOR_MODEL_DRY_RUN.json)和文件 hash。

### 必须区分的证据范围

80 次主评测按冻结声明第 6 条保留独立 single-turn sample harness：不改原 40 题及其预置历史，
复用冻结 Skill loader、五字段指令/工具、SDK、归一化、容量规则、adapter 校验和结果投影。
这部分不是完整 admission/真实 Session/UI 证据；没有将旧样本 assistant/tool 历史灌入产品数据库。
其 workflowContext 仍是样本夹具投影，不声称与真实草稿 scopeMaterial 全字节相同。
总控须确认该单轮证据边界符合冻结声明第 6 条；若要求主评测也与完整产品请求逐字节一致，
仍需先审定原 40 题的产品状态映射，不能把本次 80 条结果冒充已经完成该一致性验证。

24 次端到端则实际通过 `opcService.prepareStep` → admission → `runtimeExecutor.execute` →
`runRuntime`/官方 SDK/`PostgresSession` → `openRouterRequestBody`/历史规范化 → BILL2 adapter。
复用一次性本地数据库，包含 0155；每个导师三组两轮，每轮导师+Luna 各一次，合计 12 导师+12 整理。
卡片由首轮合成供应商响应经 SDK/产品写入，再由第二轮 answerSource 引用；没有手工伪造 Session 工具记录。
开场自动附整理也计入 24 次；第二轮实际使用同一 draft/Session。
每次核对 BILL2 冻结 requestHash 与传输边界的原始序列化字节 hash 相同。

所有供应商响应为明确标注的离线合成数据：80 次只调用 adapter.prepareDispatch，不执行 send；
24 次 adapter transport 只返回内存 Response，绝不调用 fetch。原 runner 另限制服务端非本机网络访问。
没有真实首字/完整回复耗时、模型质量、缓存命中、思考用量或实际费用结论。

### Luna 探测配置修正，待总控审

原方案 `low + 2048` 被精确冻结产品拒绝，错误 `RUNTIME_REASONING_CONFIG_INVALID`。
`shared/modelReasoning.ts` 的 `MIN_MAX_TOKENS_WITH_THINKING=4096` 对整理模型同样生效。
因此建议保持 Luna 输出 2048、将本轮探测思考改为 `reasoning_effort:"none"`；G/S 仍为 low + 8192。
这是本 PR 待审探测配置修正，不是修改产品校验、不提高输出/金额上限，也不更改 staging。
2026-10-02 只读模型目录确认 Luna `mandatory:false` 且 supported_efforts 含 none。
[官方模型目录](https://openrouter.ai/api/v1/models)、
[冻结产品规则](https://github.com/Crnobog9527/GraylumAI_vercel/blob/f9afd0db7805e80ccc6f5b7023a3e87b5014f5bd/packages/api/src/shared/modelReasoning.ts#L36)。

## 官方价格与能力（公开只读核验）

| 模型 / 完整 tag | 普通输入 / 输出 USD 每百万 token | 供应商最大输出 | 本轮输出 / 思考 |
| --- | --- | ---: | --- |
| `google/gemini-3.8-flash` / `google-vertex/global` | 0.75 / 3.75 | 65536 | 8192 / low |
| `anthropic/claude-sonnet-5.5` / `anthropic` | 2 / 10 | 128000 | 8192 / low |
| `openai/gpt-6-luna` / `openai` | 0.10 / 0.50 | 128000 | 2048 / none（待审修正） |

Sonnet 5.5 官方缓存最小前缀为 512 token；5 分钟写入 $2.50/M、读取 $0.20/M。
Luna 预算输入费率仍按 $0.125/M 覆盖自动写缓存。G 当前目录价格包含折扣，涨价仍拒绝。
本轮不测缓存；这些能力/价目不证明 staging 的实际配置或部署状态。
来源：[Sonnet 官方说明](https://platform.claude.com/docs/en/models/sonnet-5-5/overview)、
[G endpoints](https://openrouter.ai/api/v1/models/google/gemini-3.8-flash/endpoints)、
[S endpoints](https://openrouter.ai/api/v1/models/anthropic/claude-sonnet-5.5/endpoints)、
[L endpoints](https://openrouter.ai/api/v1/models/openai/gpt-6-luna/endpoints)。

## 离线测量与建议预算

| 模型 | 请求数 | 实测 B 最小—最大（UTF-8 bytes） | 最大单次预留 | 全组实测预留 | 建议本轮上限 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Gemini | 46 | 27683—31167 | $0.055631250 | $2.487844500 | $2.77 |
| Sonnet | 46 | 27671—31155 | $0.148326000 | $6.633148000 | $7.39 |
| Luna | 12 | 4562—5220 | $0.001932500 | $0.022563500 | $0.08 |
| 总计 | 104 | — | — | **$9.143556000** | **$10.24** |

逐条预留复用 `(B+2048)×输入费率/1e6 + 输出上限×输出费率/1e6`，向上取整至 nanoUSD。
主评测 40 次的冻结样本预留为 G $2.161215750、S $5.762282000。
真实端到端后续载荷依赖前一轮返回，不能把合成历史的字节数当作将来实际字节数。
故建议 G 上限 = ceil_cent(2.161215750 + 6×0.10) = $2.77；
S = ceil_cent(5.762282000 + 6×0.27) = $7.39；L = ceil_cent(12×0.006) = $0.08。
总计 $10.24，单次仍 $0.10 / $0.27 / $0.006；不挪用各模型差额，不补题、不重试。
真实发送前仍须测 B、核对冻结配置和本轮剩余额度；载荷或价格超出就停，不自动截断或提高上限。

若完全沿用原字节限额而非实测主评测载荷，104 次约束预算为 $17.10，仍低于原 $19.46。
此前无缓存版本 $17.08 是算术误差，本次已更正。上述均是预留/建议上限，实际花费为 0。
产品 BILL2 自身另按供应商完整 context 预扣，不能把该产品报价和 ac0Probe 的 B+2048 预留混为一谈；
一次性数据库使用足够的合成积分来运行这个既有机制，不改变实际账本或 staging 的窗口配置。

计量：104 条均记录 B、K=4096、M=4096、T=B+8192 和 requestHash；与费用的 B+2048 分开。
P/思考 token/真实费用/真实 finish_reason/截断均为 null，原因是离线合成，没有供应商回执。
本轮可交 #553 的真实准入样本数为 0；不能把 fixture token 或合成零费用当成供应商证据。
后续真实回执仍按方案两层去重，重复 lookup 不重复计样本，profile 不同不继承准入结论。

## 验证与执行边界

- PASS：104 条离线组装；80 次五字段合成结果投影；24 次真实本地产品链；请求 hash 与 BILL2 记录一致；
  配额/未知停止路径；真实账本前后 hash 相同；冻结核心调用链无改动；源码尺寸及 diff 检查。
- NOT_RUN：真实模型质量、真实耗时、真实 token/成本、缓存实验、staging 配置或部署验证。
- 待总控审：Luna none 修正、主评测 single-turn 的证据范围及准备改动；80 条不是完整产品字节一致性证明。
- 实际部署生效与第 5.1 节其他条件仍须分别核验。本轮只做离线准备，不声明已能开始真实调用。
- CI/Security 以本次提交精确 head 的远端结果为准；绿色检查不替代总控审或 Owner 批准。

供总控审后交 Owner 的条件式批准文字（不是已经获得的授权）：

> 同意 STG-MENTOR-MODEL 在五字段协议冻结、8192 调整合并并部署、准备最小改动（含 Luna none / 2048 和单轮评测证据范围）经总控审且离线 dry-run 通过后，按冻结方案实测：Gemini 最多 46 次/$2.77，Sonnet 无缓存标记最多 46 次/$7.39，Luna 最多 12 次/$0.08；单次上限分别 $0.10、$0.27、$0.006，总计最多 104 次/$10.24；执行阶段本机累计上限建议设为 840 次/$25.24，仅在原账本仍为 736 次且本轮增量单独受限时开始，不挪用历史额度、不重试、不补样本，结果不明即停；缓存实验延后到 PROMPT-CACHE 合入后另报，不改 staging 配置、不合并。

此段只提出未来执行授权范围，本轮没有修改任何硬上限。缓存实验不包含在这 104 次/$10.24 内。


## 第1步：真实发送入口（总控审过前不得运行 live）

依据[Owner 批准](https://github.com/Crnobog9527/GraylumAI_vercel/pull/561#issuecomment-5935911029)及
[总控决定](https://github.com/Crnobog9527/GraylumAI_vercel/pull/561#issuecomment-5935886740)：
Luna **none / 2048 是被测目标配置**，不是探测例外；80条主评测用统一单轮夹具，24条端到端覆盖产品全路径。
上文“待总控确定两项边界”“预算待批准”“无 live 开关”是上一轮记录，已由这里的决定取代。

Owner 原话：
> 同意 #561 按冻结方案实测：Gemini 最多 46 次/$2.77，Sonnet 最多 46 次/$7.39，Luna 最多 12 次/$0.08，总计最多 104 次/$10.24；单次上限分别 $0.10、$0.27、$0.006；本机累计上限 840 次/$25.24；真实发送入口经总控审过后才开始，不重试、不补样本，结果不明就停；缓存实验另报。

### 最小实现与资金边界

- `ac0Probe/budget.ts` 将累计硬上限设为840次/$25.24。新 `mentorLive.ts` 复用 `createBudget`、
  `callBoundUsd`、`fileLedger` 和原锁，不复制或重置真实账本；父进程使用系统账户目录定位同一账本。
- 同一个锁覆盖整批（含盲评暂停；用本机短请求查询评分状态，避免长HTTP等待超时），启动要求原账本仍736次；每条再次校验账本未被其他写入者改变。
  发出前持久化预留；本轮最多104次/$10.24、分模型46/$2.77、46/$7.39、12/$0.08各自检查，
  `--max-usd` 必填且只能降低本轮总额；不转移模型间剩余额度。
- HTTP拒绝、费用缺失、身份冲突、断流、超时、保存失败或不明结果：保留预留，停止整批。
  已知费用的模型拒答/内容过滤，或实际费用超出预留，均据实记账后停止；没有任何重试、补样本或换key分支。
  一次预留后进程重启会因基线不再736而拒绝，不能用重启刷新本轮预算。
- `scripts/stg-mentor-live.mjs` 是同一命令的临时 loopback 转发：原runner强制子进程只访问本机，
  因而真实key与原账本只在父进程；转发逐块保留响应字节，结清后才结束下游响应。
  不修改冻结网络防护、产品代码或数据库结构，不部署服务、不另建持久账本。
- 原40题、Skill文件、原发布身份和主评测80条requestHash绑定已批准离线证据；改变主评测字节会在发送前拒绝。
  原私有输入sha256为 `406d521f92b5da5f1356ae7bc9a6f05175a47ffd12752ff39cc540193e3780c6`。
  必须复用这些发布身份，否则虽然长度相同，请求hash仍会改变。
- 80题结束后调用原 `blindReview` 生成匿名材料和单独私有映射；先锁定判断再揭盲，人工输入已锁定评分。
  达到原门槛的候选才继续各自12条端到端请求，不合格候选的名额不转移。
  已可信结清的格式失败保留固定分母并继续下一唯一题；未知/拒绝不能按格式失败略过。
  点选组必须读取实际卡片；自由澄清仅在实际有卡时携带作答关联，无卡可在同一Session续聊。

### 入口与证据

默认命令仍离线。总控审过后才可在原命令的四个位置参数之后追加：
`--live --max-usd 10.24 --approved-evidence <原私有mentor-preparation.json>`。
该证据文件必须匹配已批准hash；其上两级目录的 `private-input.json` 必须匹配上述固定hash。
使用既有 `AC0_OPENROUTER_API_KEY`，无其他key参数；本次没有读取它。
不带 `--live` 时可加同一 `--approved-evidence` 复现固定输入，不打开真实发送或账本。

私有输出沿用结果文件：`mentor-live-results.jsonl` 包含预留/结算记录、B/K/M/T、原生P、思考token、
费用、finish reason、截断、流式首正文/首工具/完整回复计时和原始响应；同一调用以模型/阶段/样本/requestHash关联。
预留记录与结算记录是同一次调用的不同状态，不作为两份#553样本；缺字段记null，原始响应只留私有目录。
`mentor-main-results.json`、`blind-review.json`、`private-blind-mapping.json` 分别保留投影与评审材料。
主评测不能替代产品全路径证明；本次没有任何真实模型质量、速度或实际费用结论。

本地验证：原探测回归及新增资金边界共77项通过；API类型检查、相关ESLint、语法、代码尺寸、diff检查通过。
固定原输入的104条离线组装通过（筛选测试1 passed、311 skipped），预留仍$9.143556；
80条主评测requestHash与原批准记录逐一相同。真实账本全文件hash与此前快照相同，仍736次。
同head CI与独立审查结果在PR总控报告记录。未运行真实入口，未读取真实密钥、未写真实账本。


## 恢复准备（2026-10-02）

风险仍为 high（真实付费探测资金边界）。依据 Owner 本会话最新批准及
[总控恢复安排](https://github.com/Crnobog9527/GraylumAI_vercel/pull/561#issuecomment-5936981809)，
此节覆盖上文历史736次启动、840次累计条件；原冻结产品、模型、价格、样本和预算金额不变。

Owner 原话：
> 同意 #561 恢复实测：被拒的那 1 次请求按 $0 结清（OpenRouter 后台已确认没有扣费），账本基线改为 737 次，本机累计上限改为 841 次/$25.24，本轮 104 次/$10.24 从头开始（Gemini 第 1 条重新发送）；启动时必须带代理环境变量，并在第一条请求前用免费检查确认 OpenRouter 看到的来源是美国；改动经总控审过后才开始，其余条件不变。

- 唯一403请求 `ee0ac53bf46e32e5ea3f0a532ed74cdb75b2d573a82e9cab001cfa1875d4edda` 已按$0结清。
  持原账本锁，核对停止结果hash、两条事件、HTTP403、精确预留53802750 nanoUSD，以及前次736次快照，
  仅释放该预留，保留737次；没有重置账本、删除历史或改外部入账项。
  $0依据是Owner确认后台，没有伪造供应商usage回执；原结果文件不变。
  私有结算证据sha256：`7d7e06e7916403b99146c3ecca5f7d078d5963302e33f2c256b661d69e5a747a`。
- 入口只接受737次基线；累计硬上限841次/$25.24。本轮仍104次/$10.24，
  G46/$2.77、S46/$7.39、L12/$0.08；单次仍$0.10/$0.27/$0.006。
  使用原输入/原key/新私有输出目录，从G第1题开始。本次恢复授权不允许下一次失败后自动恢复。
- 启动要求 HTTP_PROXY、HTTPS_PROXY 一致，小写变量若有也必须一致；NO_PROXY只允许回环地址，
  必须显式 `node --use-env-proxy`。仅设置代理地址而未启用Node代理会拒绝启动。
  [Node官方说明](https://nodejs.org/docs/latest-v24.x/api/cli.html#--use-env-proxy)。
  不改本机代理规则、产品网络防护或冻结子进程环境；key和代理只留父进程。
- 首条预留前，使用与付费请求相同的Node fetch执行无密钥GET
  `https://openrouter.ai/cdn-cgi/trace`，要求HTTP成功、h=openrouter.ai、唯一loc=US。
  不跳转、不重试，15秒超时，响应最多4096字节；失败/不明/非US不预留、不发送付费请求。
  此证据表示OpenRouter域名边缘看到的来源地区，不宣称模型供应商地域准入已经通过。
  结果只保存域名、国家、时间，不保存IP。此次免费检查实际返回200/US；执行时会重新检查。
- 后续上游非2xx仅记录HTTP状态及100–599范围内数字错误码；正文、任意字符串、metadata和headers不保存。
  错误码缺失记null，仍保留预留并停下，不以403惯例自动按0结清。
- 80条后仍停在 `/main-complete`，报告匿名文件路径/hash和费用，等待总控新开只读上下文锁定JSON。
  不打开私有映射、不自行评分；输入锁定原文后只有达标候选进入端到端。

此次恢复只改探测脚本/配置/测试/记录，不改#497产品、staging配置、数据库或冻结请求字节。
原104条离线证据与$9.143556预留继续有效；新代码的网络及资金边界通过离线合成测试验证。
当前恢复批次真实模型调用0次；待同head CI、独立审查和总控审过后，才可执行。

## 第3条未知结果：仅诊断与转发修复（2026-10-02）

依据[总控处理](https://github.com/Crnobog9527/GraylumAI_vercel/pull/561#issuecomment-5937543024)。
本节不授权恢复；原账本740次、未知预留$0.053151保持不变，不发真实请求、不启动live。

### 诊断结论与证据限制

- 原私有事件只有第3条预留、HTTP200、通用 `local_or_transport`；没有保存响应字节数、generation ID或底层异常类别。
  runner输出只有 `RUNTIME_EXECUTION_PENDING`。缺数不是0字节，也不能证明请求没有生成或没有扣费。
  结果文件hash仍为 `7b478a7f611cc01c8d851fb9dc75e93b1adcf39f2703f2a3f4ca1805d76ee15d`。
- 整个筛选测试31115ms，前两条完整响应分别8386.079/7363.900ms；此次不是240秒到期。
- 冻结 `runner.ts` 的 firstToolCallOnly 只过滤工具delta和最终工具列表，不直接取消真实传输；
  exchange仍收集最终回复。冻结 `openRouterAdapter.ts` 在流格式错误/字节限制等条件下会取消下游reader；
  UI/SDK观察异常本身在 `openRouterStream.ts` 被隔离，不中断费用收集。
- 用获审旧版本、合成上游和抛出CLIENT_DISCONNECTED的下游复现：旧入口取消上游reader、费用尾帧未收齐、
  保留预留，记录同一通用停止码。**确认转发层有此缺陷，但不能据此认定历史第3条一定由它引起。**
  代理/上游断流也可能产生同一旧码，旧证据不足以区分。
- 现存第3条证据没有generation ID，未调用免费generation查询接口，实际费用仍未知。
  没有把前两条的ID挪用给第3条，也没有查询或发送模型来试探。

### 最小改动

- 下游headers/write异常或关闭不再取消上游；在原240秒和4MiB边界内继续读到EOF，验证身份、完成状态和费用。
  得到可信费用后按原账本结清，再以 `client_disconnected` 停止整批，**不继续下一题**。
  如果上游也断流、超时或身份不可信，继续保留原预留，不能用部分回执结清。
- 临时转发关闭时先等当前发送结束再释放原账本锁，避免runner先退出导致收款证据尚在收集而锁已释放。
- 新增累计 `receivedBytes`、停止耗时、下游断开布尔值，以及头部/完整SSE帧中已见的受限generation ID。
  失败类别只用固定 `client_disconnected / upstream_stream_error / timeout / size_limit / utf8 / identity / local`，
  不保存异常原文；未知记录不保存原始响应或流正文。既有预算停止码保留。
  这些字段用于未来诊断，不能补造历史第3条缺失数据。
- 不改冻结产品、样本、请求字节、次数、金额上限、基线或恢复规则，不改staging配置、数据库。

离线验证：77项探测测试（合成断流、真实回环HTTP下游取消、读完后结算并停止、超时/大小/UTF8/身份分类）；
冻结产品原有runner工具及流解析101项测试通过，全部为合成数据，无供应商请求。
API类型、相关ESLint、源码尺寸和同head CI结果以本PR报告为准。
后续是否按实扣结清、重发哪一题、如何恢复，由总控请Owner决定；本次保持停止、draft，不合并。


## 第二次恢复授权（2026-10-02）

[总控已通过ddc2df73及提出恢复规则](https://github.com/Crnobog9527/GraylumAI_vercel/pull/561#issuecomment-5937869955)。
Owner本会话明确批准，覆盖此前停止状态，但不授权下一次停止后自动恢复：

> 同意 #561 第二次恢复：第 3 条的预留 $0.053151 按已花费保留、不结清，账本基线改为 740 次，本机累计上限改为 844 次/$25.24，本轮 104 次/$10.24 从头重新开始（前两条结果只作计量证据、不计入评测）；使用 ddc2df73 的修复，启动仍须带代理并通过美国来源检查；再停下照旧停止报告、不自动恢复，其余条件不变。

本增量只将启动次数737改740、累计次数841改844，并同步断言；没有改金额、请求字节或转发修复。
真实账本及未知预留不作任何调整；“按已花费保留”是保守预算占用，不代表供应商实扣已查明。
旧结果文件完整保留，仅供计量证据；新批次独立输出目录，从G第1题开始，80题及盲评不混入旧结果。
同head验证/独立审查通过后按本次授权启动，仍携带代理环境、--use-env-proxy及--max-usd 10.24，首条前免费US检查。
80条后照旧停在/main-complete，等总控独立锁定JSON；再有未知/拒绝/本地断开则停下报告。
