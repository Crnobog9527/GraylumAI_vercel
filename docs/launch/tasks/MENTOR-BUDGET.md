# MENTOR-BUDGET 实施方案与交接

风险 high；继续 PR #542 的既有分支，原始起点 staging `314fde20`。
按[方案审查](https://github.com/Crnobog9527/GraylumAI_vercel/pull/542#issuecomment-5910051123)和
[容量决定](https://github.com/Crnobog9527/GraylumAI_vercel/pull/542#issuecomment-5911038927)实施。
只改服务端、管理 API 和相关测试；没有 SQL、载荷去重、后台页面、staging 配置写入或真实模型调用。

## 配置与管理 API 契约

复用 `system_settings` 的字符串 JSON 值 `runtime_purpose_budgets`、`adminProcedure` 和现有服务端写入权限。
MODEL-REASONING 配置仍负责模型/用途的思考参数和线路能力；预算是宿主用途设置，准入再与具体模型和批准报价求交集。
没有新表、RPC、账本或配置权威。专用 `mentorBudget` router 是既有管理 API 下的两个过程，复用原权限，避免通用设置接口绕过结构校验。
`settings.ts` 只在既有按 key 校验函数加一个 if；没有改 `admin.ts`。

`mentorBudget.get`：无参数，管理员 query。返回：

- `version: 1`、`source: legacy | configured`、`config: null | 配置对象`。
- `limits: { inputBytes: { interactive: 90000, organize: 112000, report: 90000 }, maxOutputTokens: 128000, historyItems: 1000 }`。
- `organizeOutput: { source: "v3_summary_max_tokens", maxOutputTokens }`，仍只读原设置，合法 128–4096，未设置默认 2048。
- `legacy` 描述原行为：OPC 输入 64000 bytes、历史 100；fixture 回答 1000 tokens；真实回答 `min(批准报价输出, 模型输出, 20000)`；附属整理历史 0；report 未启用。

get 返回配置与安全上限，不声称返回所有模型/报价的即时有效预算。实际有效值在新执行准入时求交集并冻结。

`mentorBudget.update`：管理员 mutation，完整替换以下严格对象，保存成功后返回与 get 相同的读回视图：

```json
{
  "version": 1,
  "interactive": { "inputBytes": 64000, "maxOutputTokens": 1000, "historyItems": 100 },
  "organize": { "inputBytes": 64000, "historyItems": 0 },
  "report": { "inputBytes": 64000, "maxOutputTokens": 1000, "historyItems": 100 }
}
```

上例仅说明写入结构，不是要自动写入的新默认值。未设置该 key 时沿用原默认路径；特别是不能把真实模型原报价输出自动改成 1000。
inputBytes 必须为 1024 至各用途硬上限的整数；输出 1–128000 tokens；历史 0–1000 条。拒绝未知字段、分数、负数、越界和 organize.maxOutputTokens。
普通用户为 FORBIDDEN，匿名为 UNAUTHORIZED；通用单条/批量设置接口均拒绝该 key。存储失败不返回成功。
报告配置仅预留给 B，本 PR 没有报告调用入口。前端单位应写“token”，不可显示为字数。

## 准入、冻结与默认兼容

先查询原 requestId 的 replay，再读用途设置。新执行按服务端用途选择预算；模型限制、批准报价和 MODEL-REASONING 继续校验。
冻结解析后的输入预算、输出和历史条数到现有 Runtime/BILL2 payload；执行/恢复只读快照，后台修改不影响已准入记录。
附属整理输出唯一来源仍是 v3_summary_max_tokens；独立整理同样遵循此来源。附属整理的历史只取该执行已冻结的主调用历史子集，不扩大 Session 依赖。

无配置保持原输入、历史、输出和预扣路径。唯一新增安全拒绝是两份完整冻结载荷无法存入数据库，或含 PostgreSQL 无法保存的字符。
历史超限仍先裁旧历史；必需内容或最终请求超限仍拒绝，不静默裁剪 Skill、当前输入或工具结果。
额外指令不再单独固定为 8000 字符，但计入用途的完整输入字节预算。数据库、模型、报价限制不随后台配置放大。
每次新准入增加一次用途设置查询；replay 不增加读取。这一有意的往返增量已纳入 AC-0/AC-1 集成断言。

## 262144 字节边界与硬上限推导

两个现有 CHECK 分别来自迁移 0106 `runtime_executions.payload` 和 0105 `bill2_runs.payload`，均为
`octet_length(payload::text) <= 262144`。不改 SQL、不去重、不改变旧快照结构；只添加可选冻结预算字段。
准入先构建完整 Runtime 和 BILL2 对象，再按 PostgreSQL JSONB 文本计量（UTF-8、逗号/冒号空格、字符串转义、指数数字展开）。
任一超限在调用 `runtime_admit` 前返回 BAD_REQUEST，消息包含 `RUNTIME_FROZEN_PAYLOAD_TOO_LARGE` 与中文说明。
因此没有 execution/run/pre-deduct 写入，也没有模型派发。不可保存字符使用 `RUNTIME_FROZEN_PAYLOAD_INVALID`。
最终逐份检查始终执行，不将经验硬上限当成对任意扩展元数据的绝对保证。

最坏合法组合采用现有 OPC 8000 字符输入（全部为可保存控制字符，JSON 中占 48000 bytes）、
12000 字符整理指令、24000 字符整理输入（中文与转义字符混合），交互的 Skill + 额外指令填满输入预算，
历史条数 1000，交互输出上限 128000，保留 OPC token 和重复 request.input。
附属整理的完整输入计量恰好为 112000；交互恰好为 90000。
字段字符上限与用途总字节上限必须同时满足：不声称所有字段各自采用最大转义膨胀后仍合法；这种组合会先被完整输入检查拒绝。

在该组合中 BILL2 大小为 `interactiveBytes + 48000 + organizeBytes + 349`。
要求至少 8192 余量，则两个用途预算之和不应大于 `262144 - 8192 - 48000 - 349 = 205603`。
选取可同时成立的 `90000 + 112000 = 202000`，额外留下 3603 字节结构余量，总余量 11795。
整理单独运行并不受这个联合上限挤压，但同一 organize 配置还服务附属整理，因此统一采用 112000。
report 没有执行入口，保守复用交互加附属整理的封套和 90000 上限，B 接线时还必须再次验证真实报告结构。

以下是独立、无网络 PostgreSQL 17 对真实准入捕获参数的实测；报告行是保守封套投影，不冒充报告执行：

| 用途/组合 | 用途输入计量 | Runtime JSONB | BILL2 JSONB | 距存储上限余量 |
| --- | ---: | ---: | ---: | ---: |
| 交互 + 附属整理 | 90000 / 112000 | 249012 | 250349 | 11795 |
| 独立整理 | 112000 | 159636 | 160522 | 101622 |
| 报告预留 + 附属整理封套 | 90000 / 112000 | 249007 | 250344 | 11800 |

自动测试覆盖交互/整理预算恰好上限可准入、必需内容增加 1 byte 在预扣前拒绝、配置硬上限 +1 保存拒绝，
以及完整 BILL2 payload 恰好 262144 接受、262145 拒绝；分别覆盖两份 payload 的边界判断。
46KB 合成资源正常准入。此证据不是未发布 Skill 2.6.0 本体或 12000 字完整报告的真实验收。
原预检中 200000 输入预算可产生 262690 / 264026 的冻结记录，证明仅扩大输入数值不够；现在该组合先明确拒绝。

## 超时与账务

函数 maxDuration 保持 300s。单次模型最多 240s；共享工作截止 265s；持久化截止 285s，
留 20s 结算/持久化以及 15s HTTP 收尾余量。常量分别位于 openRouterPolicy.ts / budget.ts。
实际调用超时为 min(240s, 剩余工作时间)，最低派发剩余为 60000ms，取凭证、claim 后和真正发送前均再检查。
不足 60s 不派发；恰好 60s 可以派发；keepalive 不续期，响应体读取同样受固定 signal 限制。
官方费用查询仍最多 45s，必须完整装入剩余工作预算。数据库 fetch 在共享 285s 截止取消。
外部不可用只能保证有界退出和保留恢复身份，不能保证截止前写库必然成功。

保留既有“选中报价最大 upperUsd × maxCalls”的预扣、call claim、冻结费用展示及实际供应商费用结算；
实际发送内容估算留给 RUNTIME-PROD ④。本 PR 不改报价、不改 SQL/账务契约。
已派发超时仍为 unknown/pending，保留原请求身份，不重发、不重复扣费；未派发证明沿用原机制撤销本次授权。

## 提示缓存评估和真实调用提案

源码确认 Skill 固定内容已经在 additionalInstructions 之前，当前请求前缀无需重排。交换历史可能改变后缀，不能据此承诺命中。
OpenRouter 回执原始 usage 保留在私有证据（流式保存原 SSE），费用取官方 usage.cost / total_cost，缓存优惠若供应商已反映其中，就随实际费用结算；不自行按缓存 token 重算。
当前 OpenRouter evidence 的归一化 usage 仅含 sdkResponse，未映射顶层 cachedTokens；BILL2 聚合因此不能把统计页 cached_tokens 的 null 当零或当无缓存。
本 PR 不改账务投影或缓存语义。

2026-09-30 只读[官方线路目录](https://openrouter.ai/api/v1/models/deepseek/deepseek-v4.1-flash/endpoints)结果：
`deepinfra/fp8` context 1048576，最大输出 131072；输入 $0.14/M，输出 $0.42/M，缓存读取 $0.0042/M。
目录同时返回 supports_implicit_caching=false，仅有价格字段不能证明本产品当前请求会命中。
参见[OpenRouter 缓存文档](https://openrouter.ai/docs/guides/best-practices/prompt-caching)。
[Owner 已批准](https://github.com/Crnobog9527/GraylumAI_vercel/pull/542#issuecomment-5911713537)
最多 6 次真实调用、总额度 $0.89。运行前只读核实当前批准线路、密钥绑定和窗口报价：
inputLimit 64000、outputLimit 4096、upperUsd $0.14852096。探针输出上限降为 256，
不改窗口报价；每次派发前要求已结算费用、未决预留与下一次上界之和不超过 $0.89。
六次全按报价上界为 $0.89112576，不能直接一次性承诺六次。

已离线准备两组三次纯合成内容，每份请求体 47742 bytes、输出最多 256 tokens。
实际仅执行现有前缀组 A1 一次：HTTP 200，输入 9832 / 输出 5 tokens，
`usage.prompt_tokens_details.cached_tokens=0`（明确存在），响应 `usage.cost=$0.00137858`。
同一 generation 两次只读查询均返回 404，官方 `total_cost` 记为**缺失**。
立即停止，未重发、未补样；保留 $0.14852096 预留，未达到次数或费用上限。
密钥只从现有安全位置读取，未回显或写入证据；没有远端配置写入。

其余五次及两组比较为 NOT_RUN / INCONCLUSIVE。单个首次样本不能证明长期无缓存，
也不能证明调整前缀有收益；响应费用不能冒充本次要求的官方 generation.total_cost。
因此不添加未经证实的缓存改动，不改变 BILL2 计费语义。
[完整结果与停止依据](https://github.com/Crnobog9527/GraylumAI_vercel/pull/542#issuecomment-5911907996)。

需总控另行核对/批准的 staging 清单（本 PR 不写入）：

- 交互 deepseek/deepseek-v4.1-flash / deepinfra/fp8：若现有 inputLimit < 90000，目标输入报价至少需 90000；配置默认不自动放宽。
- 独立整理模型：若要使用整个新输入范围，inputLimit 至少需 112000，仍受该模型 context 和已批准线路约束；输出保持 v3_summary_max_tokens。
- 实测的输出上界 256 不替换现有窗口条目；已批准探针使用原报价，窗口调整不在本 PR 执行。
- 交互新输出值尚无真实质量/时延证据，本 PR 不指定后台新默认；report 未启用。后续长输出若需扩大批准 outputLimit/upperUsd，单独列实测结果再配置。

## 验证与 Handoff

- Done：预算配置与冻结、两份载荷预检、超时调整、管理权限和错误映射，默认兼容及超时回归测试。
- 本地已通过：API 3111 项通过/3 项既有跳过，最后准入/预算小改 41 项通过；API/Web 类型、两端 lint、大小检查；BILL2 隔离集成 78 项通过；Runtime/流式隔离集成 102 项通过，5 项浏览器/本地应用用例由该运行模式明确排除；PostgreSQL 字节计量、直接表角色权限及三用途封套测量。
- P2 修复验证：回归先在旧代码失败（冻结 64000 而非 90000），修复后 Runtime/流式隔离集成 103 PASS / 5 明确 SKIP；70KB Skill 在 90KB 候选模型下完成，初始模型仍限 64KB，重放未增调用且账本一致。准入单元 19 PASS；API 类型、lint、大小与 diff 检查通过。
- Web 全量首轮 438 项通过、1 项旧截止断言失败；已修复并单独复验该项通过，完整最终回归由远程 CI 验证。
- 已获总控批准并标 ready；机器人在 ea3661a5 报告一条有效 P2：自动匹配后错误沿用初始模型输入上限。修复冻结用途配置值，每次调用仍与该模型报价求交集，并补充 64KB 匹配到 90KB 候选的回归。新候选需 CI 与独立复审。
- 缓存实测执行 1 次后因官方费用缺失停止；其余 5 次未运行。远端 DB/配置写入、后台页面验收和合并未运行。
- #497 的重叠写入已获授权，未动其分支；#537 SQL 不碰；#540 后续处理 settings.ts 一处分支同步。
- high 合并另需 Owner 批准，不自行合并。回滚前应让新格式在途执行完成或由当前版本恢复，再撤回代码；旧版本 strict parser 不认识新增冻结字段。新增设置不影响旧版本，原有旧快照无需迁移。
