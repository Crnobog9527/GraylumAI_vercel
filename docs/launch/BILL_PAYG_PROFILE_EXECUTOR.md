# BILL-PAYG profile 执行器交接（采样完成）

**r9采样完成，12/12合格；所有批次均不得重跑。最终配置与迁移见[BILL_PAYG_PROFILE_FINAL.md](BILL_PAYG_PROFILE_FINAL.md)。** 旧批次已锁定；本轮不发送模型请求、不访问远端数据库、不改配置。
本页不是执行批准；必须先收到主窗口对本 PR 最终版本和 manifest 的审阅通过及执行通知。

## 入口

使用已批准测试余额的凭据，仅通过进程环境 `GRAYLUM_PAYG_TEST_OPENROUTER_KEY` 注入。
执行器不读项目 env 文件、不回退到生产凭据、不查询或充值余额、不改任何 OpenRouter 设置。
凭据选择必须由执行窗口核实属于 Owner 批准的测试余额；环境变量名本身不证明归属。
没有足够余额时报错停止，不改用另一凭据。

当前入口仅接受r9精确清单。详见[r9逐条上界、私有回执离线回归与证据范围](BILL_PAYG_PROFILE_R9.md)。
以下命令仅供复核通过并另行收到执行通知后使用，本轮没有运行：

```bash
set +x
set -a
. ~/.graylum/secrets/payg-profile.env
set +a
NODE_USE_ENV_PROXY=1 NO_PROXY= no_proxy= https_proxy= node scripts/payg-profile-execute.mjs execute-approved \
  scripts/payg-profile/plan-prices.json \
  docs/launch/evidence/payg-profile-20261006-r9.manifest.json \
  31ecd1e3397ce1fe8b92613e0230e5b4917a3c9f550e31f92f873fec2ff2158d \
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

## r9 范围与费用

仅12条Sonnet/Gemini实际路由补测，全部low，新ID但请求正文及逐条费用上界保持r8对应值。
不再有low输出压力。Sonnet长样本三条approvedCap=$0.60，其他限制不变。
本批上界$2.792448；已入账$6.537562065；累计上界$9.330010065 < $25。
r8第3条UNKNOWN但费用已知，保留原始记录，不加入合格证据。流式费用/usage/ID由现有账务解析器读取，
provider/finish由校验过的SSE分块补充；缺失保持未知，冲突停止，不用预期值补造。

凭据/代理/加锁前核对本机已有旧锁对应的报告，按 manifest 绑定的批次、样本ID、requestHash、原始UNKNOWN状态和
Owner确认记录逐一对账。r1首条、r2第49条、r4第77条仅这三个固定例外按$0入账，原始report/events不写回。
未知数量、样本身份、已知小计、实际总额或金额汇总不匹配即 PRIOR_ACCOUNTING_MISMATCH，不接收临时豁免参数。
原r5或r6若意外出现attempted.lock，停止为SUPERSEDED_BATCH_ATTEMPTED，不能视作未执行。没有本机旧锁时以清单引用的已审计证据为依据。

既有直接输出压力证据仍要求length且0.9O≤completion（含reasoning）≤O。
Sonnet low按主窗口批准使用同线路none语义证据，标注same-route-none；不伪造low触顶记录。
OUTPUT_CAP_NOT_REACHED仍不计入直接证据；completion > O仍立即停止，费用和身份保护不变。

finish_reason=content_filter 或 native_finish_reason=refusal（response 或原 ID lookup）立即记
PROVIDER_CONTENT_REFUSED 并停批；response 已识别时不再查账，lookup 识别后不再继续查账。
没有有效费用仍为 null，不能自动按 $0 入账；有已结算费用则如实计入，但拒绝样本不成为合格证据。

## 持久材料与停机

材料固定存入用户主目录的 `.local/state/graylum/payg-profile/<manifestHash>/`，目录 0700、文件 0600：

- `attempted.lock`：排他创建并同步，保证同一清单重复启动拒绝。**不要删除它来重跑已尝试或结果不明的批次。** 零次尝试例外见下文。
- `events.jsonl`：发送前同步记录 sampleId、requestHash、费用预留；每次查账前记录原 ID 和查账次数。
- `*.private.json`：真实 transport 回执和原始字节，仅本机保存，禁止整份上传 PR。
- `report.json`：返回时的结构化逐样本判定、费用和已知/未知总额；异常退出时以事件日志为准。

请求的费用预留只增加，不把便宜样本的余额转给后面的样本；每条预留为清单 upperUsd。
POST 最多一次；超时/断线无原 ID 时保留未知费用并停止，不能推断未收费。
有原 ID 但缺用量/费用/线路时最多 GET 三次，不重新发 POST、不更换 ID。
费用未知、拒绝、线路/目录不可用、身份/hash校验失败、费用/token冲突或越界仍立即停止。
唯一可继续的未合格判定为 OUTPUT_CAP_NOT_REACHED；批次跑完不等于所有样本合格，必须逐条核对。
未执行样本保留未执行，不补跑凑满。
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

### provider 字段的公开核实（Gemini于2026-10-06更新）

公开 [provider 目录](https://openrouter.ai/api/v1/providers) 和三条模型 endpoint 目录给出一致的 API 名称：

| 精确线路 tag | API provider 名称（严格相等） |
| --- | --- |
| `anthropic` | `Anthropic` |
| `google-ai-studio` | `Google AI Studio` |
| `openai` | `OpenAI` |

模型目录分别为 [Sonnet](https://openrouter.ai/api/v1/models/anthropic/claude-sonnet-5.5/endpoints)、
[Gemini](https://openrouter.ai/api/v1/models/google/gemini-3.8-flash/endpoints)、
[Luna](https://openrouter.ai/api/v1/models/openai/gpt-6-luna/endpoints)。
官方 [ProviderName 类型](https://github.com/OpenRouterTeam/typescript-sdk/blob/50486fa616c04f3d036d0c45166b80f9bff15e13/src/models/providername.ts)
也区分 `Google` 与 `Google AI Studio`；网页显示的 Google Vertex 不是这里的 API 名称。
官方 [generation 回执类型](https://github.com/OpenRouterTeam/typescript-sdk/blob/50486fa616c04f3d036d0c45166b80f9bff15e13/src/models/generationresponse.ts)
将 `provider_name` 定义为实际服务请求的 provider 名称。
依据[Provider Routing](https://openrouter.ai/docs/guides/routing/provider-selection)，服务档位需显式选择，
裸google-ai-studio不选入flex/priority；请求无service_tier且禁fallback。出现新的非服务档位后缀时目录预检拒绝，防止裸tag扩选。
response.provider / lookup.provider_name 与冻结 providerName 严格相等；
Gemini只接受Google AI Studio，不接受Google、Google Vertex、线路tag或任意别名。固定 only、禁 fallback 和逐次目录预检保持不变。
这是公开契约核实，**没有声称已取得AI Studio真实回执**；response 缺字段时仍仅按原 ID 查账最多三次，未知值不放行。


查账和 response 的成本必须一致；P 用原生总 prompt token，缓存读写不从 P 扣除。
实际总额为已确认样本费用的精确十进制和；任一已尝试样本费用未知时 actualUsd=null，另报 knownUsd。
缓存字段缺失保持 null。输出压力需核对 finishReason、outputCapReached 和 reasoning 用量；
r6起的 outputCapReached 表示满足清单中的 90%–100% 判定，不代表精确等于 O；旧回执字段原样保留。
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

0178 仅将 SQL 校验的全局消息硬限从 32 放到 128，仍取它与每个旧请求冻结 maxMessages 的较小值。
32 条旧执行不受放宽；无数据重写、新表、权限变化。开启新 profile 前必须先完成迁移，不能仅设置开关。
有活动 128 条执行时，恢复方式是关闭新准入并完成旧执行；不直接回退 SQL 上限造成在途执行拒绝。

再次同步staging f239b384后使用0178（#679已合并并占用0177），重建本地指纹；历史批次文档中的旧编号仅作历史记录。

## 历史：代理与第二批（2026-10-05）

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
也不能代替服务商实际准入。第二批已实测出口 US 并停批；第三批仍须在下一次获准执行时重新通过预检。

403 只有同时匹配 error.code=403 和 metadata.failed_routing_step 的
`Gate Endpoints with Geo Restrictions` 才记为 PROVIDER_REGION_BLOCKED（结构取自旧批次私有回执，未上传原文）。
它立即停批、无查账重试；其他 403 保持 UNKNOWN_OR_FAILED，不根据模糊错误文案认定地区问题。
新的地区拒绝仍是费用未知，不能自动沿用旧批次的 Owner $0 决定。

### 同域 trace 预检修复

依据 [主窗口诊断](https://github.com/Crnobog9527/GraylumAI_vercel/pull/665#issuecomment-5997378844)，
旧第三方国家查询被限流/质询；切换同域 trace，无新增查询回退入口。主窗口报告的 loc=US
不代替本执行器下一次启动时的检查。本轮只做合成测试，不查询真实出口或发送模型请求。
清单 `596c57a3…a10ef7`、样本及费用上界保持不变。最终迁移编号按最新安排为 0176，本轮不改迁移。

## 输出语义证据与 profile 上限（2026-10-06）

依据[主窗口决定](https://github.com/Crnobog9527/GraylumAI_vercel/pull/665#issuecomment-5999661106)，
`evidence.testedOutputLimit` 和各 reasoning variant 的 `testedOutputLimit` 记录实际探针上限；同一模型本轮使用相同上限。
依据[最新判定决定](https://github.com/Crnobog9527/GraylumAI_vercel/pull/665#issuecomment-6000858032)，
每种参数至少两条 length 且 completion（含 reasoning）在测试上限的 90%–100% 内，才能声明 `outputSemantics=max-tokens-includes-reasoning`。
`evidence.outputLimit`、variant/outputLimit、profile/outputLimit 则记录经审查允许的用途上限，可为 PURPOSE_OUTPUT_CAP=8192。
输入矩阵、多消息、缓存、费用、线路、有效期及逐种 reasoning 覆盖仍须全部合格；不能把小上限样本称作 8192 触顶。
缺少新字段的旧启用配置拒绝，关闭配置和已有冻结执行不受影响。配置建议只写 PR，不自动应用。
