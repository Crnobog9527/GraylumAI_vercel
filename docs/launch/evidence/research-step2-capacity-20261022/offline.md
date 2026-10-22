# RESEARCH-TOOLS 第 2 步容量修复离线证据（2026-10-22）

## 原轮次离线核算

对应 #716 2026-10-22 08:14 UTC 的容量拒绝。只读 GraylumAI Staging 项目 `gvcpmcunmfrbxuwimxfa`；指定 user6 原草稿及原 session，不关联其他轮次。

读取原 session 最新不可变材料（revision 11）和最后执行，取本机已保存的拒绝输入；按真实 `captureHostContext` 从冻结字段重新构造当次宿主清单。原执行中的清单早于整理写回，不能直接拿它当本轮清单。本地重算使用零历史、完整六项研究工具（当前 fast 搜索定义）、现有卡工具、150 B 历史标记预留、24576 B 结果预留；不调用模型或供应商。

| 纯数字分项（B） | 修复前 | 修复后 |
| --- | ---: | ---: |
| `inputBudgetBytes` | 112000 | 112000 |
| `fixedInstructionsBytes` | 59598 | 59598 |
| `currentInputHostBytes` | 22397 | 14609 |
| `existingToolsBytes` | 2520 | 2520 |
| `researchToolsBytes` | 5327 | 5327 |
| `researchHostDeltaBytes` | 708 | 708 |
| `resultReserveBytes` | 24576 | 24576 |
| `envelopeReserveBytes` | 1057 | 1057 |
| `totalRequiredBytes` | 116183 | 108395 |
| `deficitBytes` | 4183 | 0 |

最大固定项为约 59.6 KB 指令：入口 Skill 15271 B，当前步五份材料分别 6815 / 4223 / 11643 / 5981 / 2832 B，另有宿主规则、品牌、语言和序列化开销。它们包含当前步诊断、平台、受众与证据规则；本次不凭段落或路径猜测删减这些方法。

最小修复选择消除材料包与宿主清单中的相同字段值、状态及已表示的字段元数据，共节省 7788 B，余量 3605 B。研究预算、结果预留、六工具、价格、确认和计费约束不变。

## 投影边界

只对新准入的、当前声明包含 `benchmark_findings` 的非开场、非小结研究轮次，冻结 `checklist-dedup-v1` 标记。复用既有 `hostTurnInput` / `runtimeScopeInput` 发送路径，准入与执行使用同一投影；旧执行没有标记，原样回放。显式历史比较在去掉旧宿主权限时，把被去重的字段保留为 `historicalChecklistData`；只有确实被当前完整材料取代的历史块才省去它。标记本身也遵守既有 16000 B 宿主上限；装不下时保留原宿主，继续按完整材料检查容量，绝不放宽限制或创建无工具的必需研究执行。

完整材料、hash、session/round 绑定、步骤正文和持久化历史不修改；数据库授权仍检查完整冻结材料。模型输入只省去与宿主清单精确匹配的已知字段；省略值、未知属性、未知状态、内容/状态/依据不一致、待采纳建议正文全部保留。保留引用说明，避免把去重误认为缺少答案。无迁移、无数据库写入。

## 回归与停止边界

- `researchInputBudget.test.ts`：先让第 1 步真实准入预算精确达到 90000 B，再用同一轮次保存字段发下一步，保留全部六项研究工具；原材料不变。夹具只替代私有 Skill 文本和 SQL 边界，不调用模型。输入不超过现有 8000 字符；控制字符的 JSON 双层转义纳入边界。
- 超限研究请求：`runtime_admit` 未调用，不能创建执行/冻结/供应商调用；诊断全部数字且不含输入或链接。前端既有拒绝恢复测试核对原文恢复及未扣积分提示。
- `checklistMaterial.test.ts`：匹配去重、差异/省略/未知字段保留、待采纳建议保留、完整冻结材料不变、旧执行不投影、用户输入不能变成宿主权限。
- `researchCapacity.test.ts`：分项和准入在转义 UTF-8 的精确边界一致，多 1 B 拒绝。
- 私有复现命令：`RESEARCH_CAPACITY_SAVED_STATE=<本机原轮次快照> RESEARCH_CAPACITY_PROJECT=1 pnpm --filter @repo/api exec vitest run src/services/runtime/researchCapacityReplay.test.ts`。去掉 PROJECT 得到修复前分项；原文快照只保留在本机，不进入公开仓库/PR。

合并由总控执行；必须 CI 17/17、最终版本机器人无 P0/P1、未解决意见 0。正常 staging 部署后，只在 user6 原草稿页面发一次请求，关键词卡出现即停。此真实出卡验收尚未运行，不以离线通过代替。当前供应商费用 $0 / $0.5。

## 本地结果

- PASS：Runtime 测试 152 个文件通过 / 4 个按配置跳过，1994 项通过 / 12 项跳过；随后对最终历史比较修复的影响范围复核 27 项全部通过。
- PASS：前端输入恢复与拒绝消息 34 项；API TypeScript、ESLint、代码大小、diff 空白检查。
- NOT_RUN：远程真实关键词卡验收，等待总控合并后正常 staging 部署；费用仍为 $0。最终 CI 和机器人审查以 PR 最新版本在线状态为准。
