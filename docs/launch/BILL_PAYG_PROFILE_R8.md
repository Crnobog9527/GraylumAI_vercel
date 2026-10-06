# BILL-PAYG r8 离线准备

r8 准备完成，等待复核。**本批未执行；有单条预算阻塞，当前不是可执行批准。**
风险 high。依据[主窗口 r7 审计和 r8 技术决定](https://github.com/Crnobog9527/GraylumAI_vercel/pull/665#issuecomment-6002163766)。

## 范围与准确边界

14 条：Sonnet low 输出压力2条，O=2048；Sonnet/Gemini 各3用途×短长2条，共12条，全部low。
mentor映射skill / agent-turn-v5-stream；step映射skill / serial-tools-v4-stream；report映射report / agent-turn-v5-stream。
路由补测 B=4096/196608，O=8192，stream=true且include_usage=true。mentor复用askQuestionTool(true)五字段工具定义；不执行工具。
mentor使用v1系统缓存标记，无历史消息，不能宣称已覆盖新host v2历史缓存标记；
step无工具路径；既有tools矩阵不是所有步骤上下文的端到端验收。report无工具、无历史、关闭显式prompt cache。

O依据 staging `c0efffe28a080c37684d0cc153fd16b34de7441c` 的 admission.ts:87–89、150、239–240：
实际为 min(报价.outputLimit, ai_models.max_tokens, PURPOSE_OUTPUT_CAP=8192)。本轮未读取数据库，
使用源码统一上限8192作为保守补测O，不能独立声称已确认数据库较小限制。思考设置low来自主窗口已核实的配置。

输出压力改为B=32768的数百行显式编号库存记录，要求逐行照抄并继续编号到010000；
输入可复制行数本身已明显超过2048 token，避免只有几十行可复制内容后提前结束。
两条采用不同产品变体、独立ID/hash。提示只能提高触及上限概率，最终必须仍凭真实回执判断，不能保证模型一定服从。
判定保持length且0.9O≤completion（含reasoning）≤O。未触及标准只记录后继续；超过O等安全失败停批。

## 预演与执行阻塞

manifestHash：`e0eeae332e0266903ff09815ac6d3fffc22cc73d922c45ca97ae74989b429941`。
价格和线路复用已审r7快照；没有把旧检索时间写成新实时报价。以后授权执行仍须执行器逐次只读目录预检。

| 范围 | 条数 | 上界 USD |
| --- | ---: | ---: |
| Sonnet | 8 | 2.365440000000 |
| Gemini AI Studio | 6 | 0.672768000000 |
| r8 | 14 | **3.038208000000** |
| 以前已入账 | | 6.470137565000 |
| 累计上界 | | **9.508345565000 < 25** |

三条Sonnet长路由样本各上界 **$0.593920000000**，超过现有$0.50（旧$0.55特例仅针对原矩阵，也不足）。
**没有擅自提高approvedCap**，manifest保留三条PER_CALL_BUDGET_EXCEEDED。建议主窗口仅批准这三条的$0.59392上限，
然后更新清单并重新审查hash；当前未收到该项批准，不能执行。累计<$25不能替代单条批准。
执行器已补精确格式限定的Agent工具支持并用真实adapter离线预检14条；执行入口本轮未切换，仍不能用r8启动；旧r7已经完成且锁保留，旧批次也不得再运行。

prior accounting附r7已确认$1.47815285，前批费用合计$6.470137565。
r7-evidence.json仅存公开报告白名单的结构、hash、金额和判定；原始回执留本机。
94条WITHIN并入保留证据；两条Sonnet low未达标仍保留在r7结果中、不作为合格输出证据。
旧r5/r6继续作废，全部旧锁和记录不修改。

| ID | B | O | 上界 USD | 当前单条批准 USD | requestHash |
| --- | ---: | ---: | ---: | ---: | --- |
| `anthropic/claude-sonnet-5.5:output:low:32768:0:r8` | 32768 | 2048 | 0.122880000000 | 0.50 | `1c44d0a8ab61808f982eefab2933912f4a28bb82f09fe70233faeb6f55d3ddb9` |
| `anthropic/claude-sonnet-5.5:output:low:32768:1:r8` | 32768 | 2048 | 0.122880000000 | 0.50 | `d6313336968873223591716ac93b0c4b5dcf2b7a0cc54a6f102ca19b551f901a` |
| `anthropic/claude-sonnet-5.5:route:mentor:4096:0:r8` | 4096 | 8192 | 0.112640000000 | 0.50 | `1036e570cbcb292e8cd1d7cd6a5f914d88f22b85437f867e2e819e51d904d9ee` |
| `anthropic/claude-sonnet-5.5:route:mentor:196608:0:r8` | 196608 | 8192 | 0.593920000000 | 0.50 | `5dd43bf24169c4bb109db73cd4a270491c58da8af84e906fa9a5b09ac3e70148` |
| `anthropic/claude-sonnet-5.5:route:step:4096:0:r8` | 4096 | 8192 | 0.112640000000 | 0.50 | `435dbffcf5fa7e91aeefc9384d651108e8f5b411598778a4eed15724ed40394d` |
| `anthropic/claude-sonnet-5.5:route:step:196608:0:r8` | 196608 | 8192 | 0.593920000000 | 0.50 | `7929591f9399963f978188bcb7f5b1ca0f7f60e3c5ccffb412a3d87806972622` |
| `anthropic/claude-sonnet-5.5:route:report:4096:0:r8` | 4096 | 8192 | 0.112640000000 | 0.50 | `05dfd8bd412a2f19be370638b141d9a1762e512a5db27cb0b42e422663c9edc3` |
| `anthropic/claude-sonnet-5.5:route:report:196608:0:r8` | 196608 | 8192 | 0.593920000000 | 0.50 | `9de6632c3f481f8b4ca5cd562793f413009314b3524400472bfedcadfb4cb68d` |
| `google/gemini-3.8-flash:route:mentor:4096:0:r8` | 4096 | 8192 | 0.039936000000 | 0.25 | `d48409a8489eb4b451358a14c273969e9c0aa511ca22b869d8c2a84134cd309c` |
| `google/gemini-3.8-flash:route:mentor:196608:0:r8` | 196608 | 8192 | 0.184320000000 | 0.25 | `be44db1d3329b766afc3917529d5c3bf6c8c75819f5de1ab954f1266cb78e4d6` |
| `google/gemini-3.8-flash:route:step:4096:0:r8` | 4096 | 8192 | 0.039936000000 | 0.25 | `847cbf41fde240446e885b4c393eb713920f433bb318545691a0c3d886d36385` |
| `google/gemini-3.8-flash:route:step:196608:0:r8` | 196608 | 8192 | 0.184320000000 | 0.25 | `4a339a8577fd224a866dfd7c6b8f5f1a3a62ea12f28e728a8fdb80400c478191` |
| `google/gemini-3.8-flash:route:report:4096:0:r8` | 4096 | 8192 | 0.039936000000 | 0.25 | `f77ccda3d295a253933b3565f184d35dfbe8e6670f7cad73afabec03c5bb196d` |
| `google/gemini-3.8-flash:route:report:196608:0:r8` | 196608 | 8192 | 0.184320000000 | 0.25 | `76fffb9b2809e16cbf45287a54af80dc83917f74864a44f693f7492552df318c` |

## Profile 草稿与发现的问题

[三个模型草稿](evidence/payg-profile-20261006-r8.profiles-draft.json)标为DRAFT_NOT_FOR_ACTIVATION，不能直接启用。
有效期统一2026-10-13T00:00:00Z，覆盖主窗口给定窗口2026-10-09T15:59:59Z。
Sonnet/Gemini用途skill、report与v4/v5/v6交叉；Luna用途organizer、attached_organizer与v4/v5/v6交叉。
交叉组合是主窗口明确允许的模型级模板开销推广；未生成的组合不是逐对独立采样。
reasoningVariants仅含已证明设置：Gemini low、Luna none、Sonnet暂仅none。Sonnet实际需要low，
但必须等r8两条输出压力合格后才能加入；本轮不伪造low证据。Sonnet/Gemini新增用途/格式也待r8实际结果。
所有草稿保留r7实际证据引用，不把r8计划hash当已完成证据；真实结果回来后重算最大比率并换证据引用。

**报告执行链阻塞（独立只读复核发现，本地测试已复现）**：execute.ts:117以phase===effective.role判断primaryDialogue；
report路径phase=report（:344），但context/effective.role=skill（:207）。
因此实际report low在providerRequest.ts:59–61取不到主reasoning，报RUNTIME_PROVIDER_BINDING_DENIED。
r8报告样本使用期望的主报告wire，只证明供应商层格式/预算，不证明当前报告执行链已修好。
本轮只准备采样，未修改运行时；建议主窗口安排最小同范围修复并回归主报告、matching、attached_organizer隔离后再验收报告。

## 验证与交接

本轮只运行离线生成、合成测试和代码检查；没有加载凭据、发送模型请求、读远端数据库或修改设置。
本地精确结果与远端CI状态写入PR交接，不能以预演或schema通过替代真实采样。
保留现有迁移编号冲突；最终0176由主窗口安排。本轮不合并。
