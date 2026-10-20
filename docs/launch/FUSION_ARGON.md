# FUSION-REVIEW：Gemini 4 Argon 接入与配置交接

## 1. 结果

Owner 2026-10-21 决定执行约束席改用 `google/gemini-4-argon` / `google-ai-studio`，本轮抽样预算3美元。
**6次真实调用合计0.371400000000美元**；4条正常意见均通过正式 `parseOpinion`，2条截断均在512 token触顶。
原始预检的线路status=-2于2026-10-20 17:00:30 UTC恢复为0后才发送；没有改用其他线路。
本PR新增精确路线配对，并在共享 `matchedProfile` 限定Argon档案只能包含 `fusion_review`，防止修改档案扩大用途。

- [脱敏证据](evidence/fusion-argon-20261021.json)：每条用量、费用、上限、请求和回执哈希；没有报告原文或密钥。
- [可供总控追加的完整profile](evidence/fusion-argon-20261021.profiles-draft.json)：用正式 `paygHostProfile` 校验。
- 证据sha256：`1e32adfbabce00f19df97537aff7d4d3358355efd51f0751bb35e011d690989d`。
- [初始预检](evidence/fusion-argon-20261021-preflight.json)、[未发送时的计划](evidence/fusion-argon-20261021-plan.json)只作历史记录；实际结果以上面两份文件为准。

## 2. 候选列表与其他清单

`fusionModelOptions` 从窗口 `callPolicies` 取模型ID，再由 `admitFusionModel` 验证有效模型、OpenRouter接口/平台密钥绑定、
报价、该用途的思考设置、精确线路和PAYG档案。Argon原来缺报价、档案及代码路线条目，故不会列出。
后台没有另一张需要同步的静态模型名表；其他Flash清单属于外部搜索证据识别或旧AC-0探针，不参与评审团。
总控补齐下方配置后，候选函数会显示Argon可评审；汇总、对比、普通对话和Skill仍不允许。
真实候选链回归不替换准入函数，覆盖齐全、缺报价、缺档案、错线路和扩大档案用途的拒绝。

## 3. 方法、数据和限制

已只读核对现有Flash：`profileVersion=pr665-r9+fusion-20261017-a`，
`evidence.reference=pr665-r9-results-a1d98dde80b4`，60样本/15单元×4、历史压力12条、128消息；
low截断证据 `pr665-r7-results-a24d1839b5e5`，512 token两条。
不移植Flash证据：Argon只做fusion_review，按已有FUSION-PROFILE方案B（实际Fusion形状、至少4样本/两档、最大≥180000 B）重新取证。

用正式 `reviewerRequest` / `fusionRequestBody`、staging已发布评审Skill、仓库公开合成咖啡报告，
execution视角和引文规则、system+user两条消息、严格JSON schema、low，无工具、web插件关闭、指定完整线路且不回退。
两档50,000/186,000 B，各2条正常样本；另2条中档把输出压到512测试截断。
请求、generation及官方回执均有哈希；6个generation互不相同。首条账单查询短暂404时暂停后续付费请求，只补查既有generation，未重发模型请求。
逐条核对官方响应和generation查询的最终费用、身份、Google AI Studio提供商、用量，以及产品同一 `openRouterCallBound`。

| 样本 | 请求B | 输入token | 输出token | 结束 | 实际美元 | 正式上限美元 |
| --- | ---: | ---: | ---: | --- | ---: | ---: |
| medium-1 | 50000 | 11974 | 2185 | stop | 0.045798 | 0.168255000000 |
| medium-2 | 50000 | 11974 | 2453 | stop | 0.048478 | 0.168255000000 |
| large-1 | 186000 | 44032 | 2205 | stop | 0.110114 | 0.465755000000 |
| large-2 | 186000 | 44032 | 2081 | stop | 0.108874 | 0.465755000000 |
| stress-1 | 50000 | 11974 | 512 | length | 0.029068 | 0.132415000000 |
| stress-2 | 50000 | 11974 | 512 | length | 0.029068 | 0.132415000000 |

总费用0.3714 ≤3；逐条保守上限合计1.53285 ≤3。最大输入token/字节0.23948，输入token/上限0.22674466507374144，均≤0.7。
正常意见4/4可用；截断输出2/2为length/512（它们故意不构成完整意见）。
low在本轮回执里的reasoning_tokens均为0，缓存命中/写入token也均为0；不宣称观察到了非零思考或缓存命中。
缓存费用按目录输入2+写入附加费0.1875的保守冻结价覆盖。每条缓存token均不超过输入，输出均不超过配置上限。
这是计费形状和可解析性取证，不替代founder真实评审的扣费、修订稿和结算验收。
私有完整回执与单轮锁保留在本机 `~/.graylum/fusion-argon-20261021/`，不进入公开仓库；不自动重复抽样。

## 4. 总控执行的三处staging配置（文字，无SQL）

共同前提：本PR合入staging、包含本次代码的环境可用，再执行配置。每步改前保存完整原值和摘要，
核对没有其他任务改动，改后读回逐项比对；先profile和报价，最后改席位。保留所有原设置与旧档案；本任务不执行远端写入。

1. **`system_settings.runtime_payg_staging`**：只追加 `fusion-argon-20261021.profiles-draft.json` 的唯一profile。
   model=`google/gemini-4-argon`、endpointTag=`google-ai-studio`、仅fusion_review/low、输出4096；
   maxBytes196608、template/margin各4096、maxMessages128、maxTools2、maxSchemaBytes16384、过期2027-12-31T00:00:00Z。
   reference、实际样本数、比值和manifestHash必须照完整文件，不能复制旧模型证据。保留version/enabled/windowId和全部原profiles，
   禁止出现重复的Argon模型/线路档案；写前用正式 `paygHostSettings` 校验整份value。
2. **测试窗口 `call_policies`**：先备份完整原数组，更新须断言只影响目标窗口恰好1行，不符即撤销。
   仅在 `897525f9-66f1-4504-8d91-a52d2c0f0e60` 新增模型ID `7169edbf-aaa2-414e-ad6d-f79d0751dc16`；
   model=`google/gemini-4-argon`，provider=openrouter、protocol=openrouter-chat-v1，account沿用现有Flash的相同平台绑定，不读取或输出密钥。
   inputLimit196608、outputLimit4096、multiplier3；providerLimits的providerSlug=`google-ai-studio`、contextTokens1048576；
   按正式 `deriveFrozenPrices` 计算，当前prompt和cacheWrite均2.1875、completion10、request0（美元/百万token，request为每次美元），
   `openRouterBound` 为2.334720000000美元。缓存写入0.1875是附加费，不可只填输入2。
   automaticRetry=false、hiddenTools=false、lookupSupported=true。写前重新核价，价格变化先重算；原条目逐项保留。
3. **`system_settings.fusion_settings.review`**：将reviewerModelIds中的旧Flash
   `da9e7046-fddc-4b97-bf65-a275b05d6cf0` 原位替换为Argon `7169edbf-aaa2-414e-ad6d-f79d0751dc16`；
   reviewerRoles移除旧Flash键，新增Argon=execution；保留GPT `8122be92-88c7-4be9-9629-14a75c459219`=finance、
   Sonnet `d04a4800-2d3a-43b3-8af9-cb960572e34f`=evidence。
   走后台保存校验，保留Opus汇总、Skill、1轮、意见4096、汇总32768、固定1500积分和其他配置。

恢复：尚未发起新评审时按备份恢复席位、移除本次追加的报价和profile；已冻结运行单、回执和账本不可改写。

## 5. 验证与下一步

新增路线测试先红后绿；当前82项相关测试（含证据/费用/profile校验）、类型、ESLint、代码大小检查通过。
前一代码版本完整CI和机器人复审通过；加入本次真实证据后的最终CI与机器人结果以PR为准。
总控完成三处配置后，用已批准founder只做1次真实评审（另限1美元），核对Argon实际调用、可用修订稿才扣1500、失败退回，结果写#716。
真实评审尚未执行，不能把本轮抽样当作扣费结算验收。没有部署任何分支，没有操作正式环境。
