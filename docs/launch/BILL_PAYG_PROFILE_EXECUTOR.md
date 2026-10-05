# BILL-PAYG profile 执行器交接（仅准备）

**重跑准备完成，等待复核。** 旧批次已锁定；本轮不发送模型请求、不访问远端数据库、不改配置。
本页不是执行批准；必须先收到主窗口对本 PR 最终版本和 manifest 的审阅通过及执行通知。

## 入口

使用已批准测试余额的凭据，仅通过进程环境 `GRAYLUM_PAYG_TEST_OPENROUTER_KEY` 注入。
执行器不读项目 env 文件、不回退到生产凭据、不查询或充值余额、不改任何 OpenRouter 设置。
凭据选择必须由执行窗口核实属于 Owner 批准的测试余额；环境变量名本身不证明归属。
没有足够余额时报错停止，不改用另一凭据。

批准后，从本 PR 工作区执行（下列命令在第一步没有运行）：

```bash
NODE_USE_ENV_PROXY=1 NO_PROXY= no_proxy= https_proxy= node scripts/payg-profile-execute.mjs execute-approved \
  scripts/payg-profile/plan-prices.json \
  docs/launch/evidence/payg-profile-20261005-proxy-r2.manifest.json \
  596c57a3839de657e46058d16d8a558af2c84d3ea4b79b74e80a9b96e4a10ef7 \
  owner-approved-test-balance-only
```

必须始终用同一个系统用户运行，**不用 sudo**，不切换 HOME 或复制工作区来绕过已有锁。

入口重新生成全部请求和清单，与已批准 manifest 整体深比较；任何请求、价格、上限或样本顺序变化均拒绝。
先检查专用密钥，再检查代理和出口国家，完成首次模型目录预检，最后才建锁和批次事件。
`HTTPS_PROXY` 必须预先指向 Owner 同意的本机代理；不得输出其值。命令只清空本进程的 bypass/小写覆盖，
不改系统配置。必须在 Node 启动前设置 NODE_USE_ENV_PROXY=1（当前 Node 24.14.0）。
代理和国家检查失败不创建锁、不发模型请求；不会查询第二个出口服务或自动重试。
每条发送前仍重新 GET 精确模型 endpoint 目录，与冻结目录比较全部价格层和能力；漂移后须重新预演/审阅，不能继续。
本地费用计算复用 openRouterCallBound，发送和查账复用现有 openRouterAdapter/openRouterEvidence；
无 SDK 自动重试、无 fallback、固定 OpenRouter URL、禁止重定向。工具样本只带合成历史，不执行真实工具。

## 持久材料与停机

材料固定存入用户主目录的 `.local/state/graylum/payg-profile/<manifestHash>/`，目录 0700、文件 0600：

- `attempted.lock`：排他创建并同步，保证同一清单重复启动拒绝。**不要删除它来重跑已尝试或结果不明的批次。** 零次尝试例外见下文。
- `events.jsonl`：发送前同步记录 sampleId、requestHash、费用预留；每次查账前记录原 ID 和查账次数。
- `*.private.json`：真实 transport 回执和原始字节，仅本机保存，禁止整份上传 PR。
- `report.json`：返回时的结构化逐样本判定、费用和已知/未知总额；异常退出时以事件日志为准。

请求的费用预留只增加，不把便宜样本的余额转给后面的样本；每条预留为清单 upperUsd。
POST 最多一次；超时/断线无原 ID 时保留未知费用并停止，不能推断未收费。
有原 ID 但缺用量/费用/线路时最多 GET 三次，不重新发 POST、不更换 ID。
出现身份/费用/token 冲突、超费用/输出边界或不合格样本即停，未执行样本保留未执行，不补跑凑满。
进程重启、磁盘写失败和人工中止都不会自动续发。先审计已有事件及回执，再交主窗口处理。
批次中途目录读取失败/漂移写入 `{type:"halt",reason:"固定原因码"}`，不写上游消息、响应或 URL。
脚本输出同一原因码并以非零状态结束；未知异常仅输出 `PAYG_EXECUTOR_STOPPED`，不泄露原始错误。

### 零次尝试锁的人工恢复

首次预检后仍可能在建锁或第二次预检时中断。禁止自动删锁或自动重跑；只有同时满足以下条件才可人工恢复：

1. 原进程已退出，确认没有同一系统用户下的执行器仍在运行；保留整个目录作为恢复材料。
2. 完整读取日志，确认只含 batch/halt（或日志尚未创建/为空），**没有任何 attempt**；
   没有 observation、lookup、result、原始回执文件或已执行报告。发现残缺行、无法读取或无法解释的材料则停止。
3. 发送之前必须先成功同步 attempt；只有上述证据完整、可确认零次尝试时，才能把整个目录改名为
   同一父目录下唯一的 `原manifestHash.zero-attempt-时间戳` 归档，不删除或覆盖文件。
4. 修复失败原因后仍由原系统用户启动。目录漂移必须先重新预演并交主窗口复核；未获执行通知仍不得启动。
   只要存在一次 attempt（即使费用显示为零），就不适用该恢复方法，不能换目录或换用户续发。

### provider 字段的公开核实（2026-10-05）

公开 [provider 目录](https://openrouter.ai/api/v1/providers) 和三条模型 endpoint 目录给出一致的 API 名称：

| 精确线路 tag | API provider 名称（严格相等） |
| --- | --- |
| `anthropic` | `Anthropic` |
| `google-vertex/global` | `Google` |
| `openai` | `OpenAI` |

模型目录分别为 [Sonnet](https://openrouter.ai/api/v1/models/anthropic/claude-sonnet-5.5/endpoints)、
[Gemini](https://openrouter.ai/api/v1/models/google/gemini-3.8-flash/endpoints)、
[Luna](https://openrouter.ai/api/v1/models/openai/gpt-6-luna/endpoints)。
官方 [ProviderName 类型](https://github.com/OpenRouterTeam/typescript-sdk/blob/50486fa616c04f3d036d0c45166b80f9bff15e13/src/models/providername.ts)
也区分 `Google` 与 `Google AI Studio`；网页显示的 Google Vertex 不是这里的 API 名称。
官方 [generation 回执类型](https://github.com/OpenRouterTeam/typescript-sdk/blob/50486fa616c04f3d036d0c45166b80f9bff15e13/src/models/generationresponse.ts)
将 `provider_name` 定义为实际服务请求的 provider 名称。
因此保留 response.provider / lookup.provider_name 与冻结 providerName 严格相等；
不增加 Google Vertex、Google AI Studio、线路 tag 或任意字符串别名。固定 only、禁 fallback 和逐次目录预检保持不变。
这是公开契约核实，**没有声称已取得真实回执**；response 缺字段时仍仅按原 ID 查账最多三次，未知值不放行。


查账和 response 的成本必须一致；P 用原生总 prompt token，缓存读写不从 P 扣除。
实际总额为已确认样本费用的精确十进制和；任一已尝试样本费用未知时 actualUsd=null，另报 knownUsd。
缓存字段缺失保持 null。输出压力需核对 finishReason、outputCapReached 和 reasoning 用量；
“未超界”不等于“已触及并证明 8192 的输出边界”。

## 公开报告与配置建议

只公开每条 sampleId、请求/回执 hash、B/P/rB/rT、实际费用、合格/失败/未知及总花费；
不要上传原始正文、思考正文、请求头、任何凭据、账号或邮箱；原 generation ID 留在本机材料里供查账。
对 manifest 中没尝试的条目明确标 NOT_RUN，对已尝试但缺证据的条目标 UNKNOWN，不能混作 0。
结果必须对照 [预演验收标准](BILL_PAYG_PROFILE_DRY_RUN.md)，不能扩大上界让样本通过。

第二步才根据完整合格格子提出 profile JSON 建议：只列被实测的 model/tag、reasoning wire、O 和消息容量；
填入真实 manifest/证据引用、缓存及多消息摘要、有效期。缺任何材料不生成可启用 profile。
本 PR 不访问 system_settings、不应用迁移、不打开开关；最终由主窗口在获准 staging 窗口处理。

## 兼容与恢复

0172 仅将 SQL 校验的全局消息硬限从 32 放到 128，仍取它与每个旧请求冻结 maxMessages 的较小值。
32 条旧执行不受放宽；无数据重写、新表、权限变化。开启新 profile 前必须先完成迁移，不能仅设置开关。
有活动 128 条执行时，恢复方式是关闭新准入并完成旧执行；不直接回退 SQL 上限造成在途执行拒绝。

迁移顺序按主窗口 2026-10-05 审计更新：#666 使用 0172；本 PR 在采样结束、最终合并前改为 0173，
以届时 staging 重建指纹。在此之前若产生账本编号/跳号失败应如实记录，不加入占位迁移或放宽 CI。

## 代理与新批次（2026-10-05）

新批次 ID：`payg-profile-20261005-proxy-r2`；旧 manifest `4289cffc…bad9c5` 的锁、日志和原回执保持不变。
旧首条依 [主窗口审计](https://github.com/Crnobog9527/GraylumAI_vercel/pull/665#issuecomment-5996661703)
作为 Owner 接受的风险按 $0 入账；原始 UNKNOWN 保留，不伪造已结算回执。新批次 228 个样本、请求 hash、
单价、逐条上界均与旧清单一致；新上界及两批累计上界都是 **$22.587902625000**，小于 $48。

同一 Node 原生 fetch 用于出口检查、目录和模型/查账；代理由 Node 启动环境驱动，拒绝 NO_PROXY / no_proxy
或冲突的 https_proxy，避免两类请求一部分直连。依据 [Node 环境代理文档](https://nodejs.org/api/cli.html#node_use_env_proxy1)。
只 GET 一次同域入口 `https://openrouter.ai/cdn-cgi/trace`，不携带凭据，不跟随重定向、不重试。
trace 响应可能包含其他字段；执行器按字节流跳过非 loc 行，不解码其字段值、不读取 ip 字段值，
不记录或保存完整响应。只保留 loc= 后的严格两位大写国家码，拒绝重复、缺失或格式异常的 loc。
批次事件仅记录通过的国家码。查询异常或 HTTP 非成功状态仍在建锁前停止。
当前使用保守的已核实子集 US/CA/GB/DE/FR/NL/JP/SG/AU/KR/TW；不声称这是全部可用地区。
依据 [Anthropic](https://www.anthropic.com/supported-countries)、
[OpenAI](https://help.openai.com/en/articles/5347006-openai-api-supported-countries-and-territories)、
[Google Gemini](https://ai.google.dev/gemini-api/docs/available-regions) 的公开地区信息。
Google 页面覆盖 Gemini API，不是 OpenRouter Vertex 路由的可用性承诺；端点仍可按其策略拒绝。
未在已核实子集的国家停止为 PROXY_COUNTRY_NOT_ALLOWED；查询失败、重定向或无效响应为 PROXY_COUNTRY_CHECK_FAILED。
预检与模型请求现在同为 openrouter.ai，使用同一域名分流规则；一次国家检查不能证明代理之后不换出口，
也不能代替服务商实际准入。此轮只用合成数据测试，尚未实测本机代理出口。

403 只有同时匹配 error.code=403 和 metadata.failed_routing_step 的
`Gate Endpoints with Geo Restrictions` 才记为 PROVIDER_REGION_BLOCKED（结构取自旧批次私有回执，未上传原文）。
它立即停批、无查账重试；其他 403 保持 UNKNOWN_OR_FAILED，不根据模糊错误文案认定地区问题。
新的地区拒绝仍是费用未知，不能自动沿用旧批次的 Owner $0 决定。

### 同域 trace 预检修复

依据 [主窗口诊断](https://github.com/Crnobog9527/GraylumAI_vercel/pull/665#issuecomment-5997378844)，
旧第三方国家查询被限流/质询；切换同域 trace，无新增查询回退入口。主窗口报告的 loc=US
不代替本执行器下一次启动时的检查。本轮只做合成测试，不查询真实出口或发送模型请求。
清单 `596c57a3…a10ef7`、样本及费用上界保持不变。最终迁移编号按最新安排为 0174，本轮不改迁移。
