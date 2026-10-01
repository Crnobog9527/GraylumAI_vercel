# STG-MENTOR-MODEL：无缓存离线准备

2026-10-02；真实模型调用 0 次；保持 draft，提交总控审，不是执行授权。

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

新增两个离线准备文件：
- `scripts/stg-mentor-offline.mjs`：限定完整冻结 SHA、detached 且干净的副本，校验原 40 题 hash，
  将受控本地 Skill/样本交给现有 `run-workbench.mjs --opc-only --with-staging-schema`；无 live 参数。
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
