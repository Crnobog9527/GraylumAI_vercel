# BILL-PAYG r9：流式回执修复与路由补测

**r9 准备完成，等待复核。没有发送真实请求。** 风险high；不访问远端数据库、不改设置、不合并。
依据[主窗口r8审计与技术决定](https://github.com/Crnobog9527/GraylumAI_vercel/pull/665#issuecomment-6010007610)。

## 修复与离线证据

旧执行器对解压后的整个SSE调用JSON.parse，因此provider/finish_reason为空，即使已有有效费用也进入查账并停批。
现在执行器复用生产openRouterStream的有界、完整性/身份校验和分块回调；只在完整合法流上采纳provider/finish。
provider若跨块冲突、为空字符串或非法类型，记身份冲突；缺失仍未知，不用预期线路补造。
费用、usage、reasoning、generation ID继续来自openRouterAdapter/openRouterEvidence的SSE精确数值解析，
不会用浮点重算cost，也不以HTTP头替代流内ID。HTTP失败的JSON仍走原错误解析，地区403和拒绝停批行为保留。
content_filter或native_finish_reason=refusal仍立即停止；成本缺失时仍只按原ID最多查账3次，不补发。
共享生产流式解析器没有修改；本轮未修报告Runtime的phase绑定问题。

运行 `node scripts/payg-profile-private-regression.mjs`，只读取r8第3条本机私有回执，网络与凭据入口均为抛错替身。
脚本固定本机样本路径与已知sourceHash；只输出脱敏结构、金额、hash与判定，不能打印或上传原文。
[离线回归结果](evidence/payg-profile-20261006-r9.private-regression.json)：
provider=Anthropic，finish_reason=stop，P=2046，completion（含reasoning）=314，cost=$0.0076005，
从流内取得generation ID（只记录hash）；修复后离线判定SAMPLE_WITHIN_BOUNDS，网络调用0。
**原始r8仍保持UNKNOWN，不改回执，不作为合格证据**；该样本费用按Owner确认入账。

## r9清单与费用

新ID：payg-profile-20261006-r9；manifestHash：`31ecd1e3397ce1fe8b92613e0230e5b4917a3c9f550e31f92f873fec2ff2158d`。
12条全为low：Sonnet/Gemini各mentor→skill/v5、step→skill/v4、report→report/v5，短B4096、长B196608。
O=8192，stream=true。请求正文、requestHash、逐条upperUsd/spendCapUsd与r8对应12条完全相同，仅样本ID改r9。
不再包含Sonnet low输出压力；三个Sonnet长样本沿用approvedCap=$0.60（实际费用上界仍$0.59392）。
价格/目录沿用已审快照，未伪称本轮重新查询实时报价；未来授权执行仍须逐次目录预检，漂移即停。

| 范围 | 条数 | 费用上界USD |
| --- | ---: | ---: |
| Sonnet | 6 | 2.119680000000 |
| Gemini AI Studio | 6 | 0.672768000000 |
| r9 | 12 | **2.792448000000** |
| 已入账 | | **6.537562065000** |
| 累计上界 | | **9.330010065000 < 25** |

prior accounting新增r8 $0.0674245，含第3条已知费UNKNOWN $0.0076005，unknownCostSamples=0；
不把它误认为未结费用，不添加零费例外，不改原始报告。r8合格证据新增0条，r9沿用既有保留证据。
旧批次全部保留，入口仅接受精确r9清单，r8和其他旧hash不能执行。

| ID | B | O | 上界USD | approvedCap | requestHash |
| --- | ---: | ---: | ---: | ---: | --- |
| `anthropic/claude-sonnet-5.5:route:mentor:4096:0:r9` | 4096 | 8192 | 0.112640000000 | 0.50 | `1036e570cbcb292e8cd1d7cd6a5f914d88f22b85437f867e2e819e51d904d9ee` |
| `anthropic/claude-sonnet-5.5:route:mentor:196608:0:r9` | 196608 | 8192 | 0.593920000000 | 0.60 | `5dd43bf24169c4bb109db73cd4a270491c58da8af84e906fa9a5b09ac3e70148` |
| `anthropic/claude-sonnet-5.5:route:step:4096:0:r9` | 4096 | 8192 | 0.112640000000 | 0.50 | `435dbffcf5fa7e91aeefc9384d651108e8f5b411598778a4eed15724ed40394d` |
| `anthropic/claude-sonnet-5.5:route:step:196608:0:r9` | 196608 | 8192 | 0.593920000000 | 0.60 | `7929591f9399963f978188bcb7f5b1ca0f7f60e3c5ccffb412a3d87806972622` |
| `anthropic/claude-sonnet-5.5:route:report:4096:0:r9` | 4096 | 8192 | 0.112640000000 | 0.50 | `05dfd8bd412a2f19be370638b141d9a1762e512a5db27cb0b42e422663c9edc3` |
| `anthropic/claude-sonnet-5.5:route:report:196608:0:r9` | 196608 | 8192 | 0.593920000000 | 0.60 | `9de6632c3f481f8b4ca5cd562793f413009314b3524400472bfedcadfb4cb68d` |
| `google/gemini-3.8-flash:route:mentor:4096:0:r9` | 4096 | 8192 | 0.039936000000 | 0.25 | `d48409a8489eb4b451358a14c273969e9c0aa511ca22b869d8c2a84134cd309c` |
| `google/gemini-3.8-flash:route:mentor:196608:0:r9` | 196608 | 8192 | 0.184320000000 | 0.25 | `be44db1d3329b766afc3917529d5c3bf6c8c75819f5de1ab954f1266cb78e4d6` |
| `google/gemini-3.8-flash:route:step:4096:0:r9` | 4096 | 8192 | 0.039936000000 | 0.25 | `847cbf41fde240446e885b4c393eb713920f433bb318545691a0c3d886d36385` |
| `google/gemini-3.8-flash:route:step:196608:0:r9` | 196608 | 8192 | 0.184320000000 | 0.25 | `4a339a8577fd224a866dfd7c6b8f5f1a3a62ea12f28e728a8fdb80400c478191` |
| `google/gemini-3.8-flash:route:report:4096:0:r9` | 4096 | 8192 | 0.039936000000 | 0.25 | `f77ccda3d295a253933b3565f184d35dfbe8e6670f7cad73afabec03c5bb196d` |
| `google/gemini-3.8-flash:route:report:196608:0:r9` | 196608 | 8192 | 0.184320000000 | 0.25 | `76fffb9b2809e16cbf45287a54af80dc83917f74864a44f693f7492552df318c` |

## 三模型profile草稿

[完整草稿](evidence/payg-profile-20261006-r9.profiles-draft.json)状态为DRAFT_PENDING_R9_ROUTE_EVIDENCE；
Sonnet/Gemini扩大用途/格式要等r9真实通过才能算合格，当前不写入任何设置。

- Sonnet：skill/report × v4/v5/v6；保留none直接证据variant，同时加入low。
  low标注outputSemanticsEvidence=same-route-none、testedOutputLimit=2048、outputStressSamples=0，
  evidenceReference/manifestHash引用同profile的none来源；none保留两条2048 length直接证据，另有8192观测。
  这是主窗口批准的同线路语义推广，不声称low自身触顶。实际配置仍使用low，不擅改模型思考设置。
- Gemini：skill/report × v4/v5/v6；low，testedOutputLimit=512，保留r7两条508/512 length直接证据。
- Luna：organizer/attached_organizer × v4/v5/v6；none，testedOutputLimit=512，复用已审r4/r7证据。
- 三者profile outputLimit=8192，expiresAt=2026-10-13T00:00:00Z，覆盖窗口2026-10-09T15:59:59Z。
  用途/格式交叉集合按主窗口已批准模型级推广，不声称每一组合逐对实测。草稿仍用真实旧证据引用，r9通过后更新。

schema只对精确Sonnet/anthropic/low允许same-route-none；要求同profile有直接none来源≥2条、
来源testedOutputLimit=2048、相同证据引用/hash且足够outputLimit。其他模型/线路、缺来源、来源不足、错引用、
未标记的0条直接证据均拒绝。历史直接证据≥2的配置保持兼容，未改变费用或超限处理。

## 验证范围与后续

合成测试覆盖分块、无header的流内ID、provider冲突/缺失、ID冲突、截断、缺DONE、拒绝、缺费用、原ID查账；
以及精确清单、12条沿用请求、费用累计、旧批次拒绝和schema允许/拒绝路径。私有原文回归只能在本机运行，
CI使用合成数据；已提交的回归JSON仅是脱敏结果，不是私有回执。

mentor探针仍无历史，仅v1系统缓存标记，不证明新host v2历史缓存标记；step为无工具路径。
report探针仅验证预期wire，不能代替报告端到端验收。既有三模型64/96/128证据保留。
远端CI结果、独立审查与本地检查实际结论记在PR交接。当前迁移/合并冲突仍由主窗口最终安排，本轮不修改迁移。
完成准备后停下；未收到主窗口对当前版本与hash的明确执行通知前，不发送模型请求。
