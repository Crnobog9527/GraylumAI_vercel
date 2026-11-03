# REL-1 上线手册（放行条件：核心 12 项全部验收通过）

> 2026-10-24 按 Owner 要求重写（原话：「重写上线手册，确保上线手册和 masterplan 都更新到最新的状态。」）。
> 依据：[Master Plan](../MASTER_PLAN.md) 第 2.1 节 2026-10-23（晚）及之后的 Owner 决定、当天 GitHub 上的 PR 状态、
> 总控本机的缺口清单（10-24 晚版）和正式环境配置清单（10-23，含各执行窗口的补充和总控更正）。
> 取代 2026-10-17 版（按 10-31 倒排、10-25 冻结、没验收的功能关开关）；旧版逐条去向见第 8 节，原文在本文件的 Git 历史里。
>
> **2026-11-02 刷新（只更新现状，不改任何 Owner 决定）**：依据 Master Plan 第 2.1 节截至 2026-11-02 的全部条目（**第 2.1 节和旧文字冲突时，以第 2.1 节为准**）、
> staging `5cfb5ff42` 的代码与迁移目录、`docs/launch/tasks/CORE-PATH-V2.md`、`docs/validation/core-path-v2/result-20261101.md`，
> 以及总控提供的 2026-11-02 只读核对（不在仓库里，是二手材料，凡引用处标"未核实"）。本次刷新的要点：
> ① 2026-10-28 Owner 推迟上线、重做每轮对话主路径（CORE-PATH-V2），10-28 后一度没有上线日；**Owner 2026-11-03 定上线日 2026-11-15**（第 1.4 节，Master Plan 第 2.1 节 11-03），冻结日沿用 11-10（总控 11-03 确认）；
> ② 迁移清单更新到当前最新号 0471（第 2 节）；
> ③ 新增第 3.0a 节"主路径重做后正式环境多出来的东西"（`core_path_v2` 设置、每日止损、连接池数字）；
> ④ 2026-11-02 Owner 决定"运营教练复盘上线时必须开"，删除第 1.1 节第 2 条的"复盘整体先关"例外；
> ⑤ 第 6 节重排，每一项批准一句可复制的话；
> ⑥ 第 9 节列出 Master Plan 第 7.1 节任务表里过期的依赖列和标注（只记录，没改）。
>
> **这份文件不授权任何操作。** 合并到 `main`、读写正式库、改正式平台设置、新增或更换密钥、真钱操作，
> 都要按 [AGENTS.md](../../../AGENTS.md) 第 1 节在动手前由 Owner 在当前对话里明确同意；同意只对当时说清楚的那一个版本有效。
> 本文只写变量名、设置键和槽位名，不写任何密钥、邮箱或测试账号凭证。

## 0. 这份手册管什么

- **要做到**：说清楚什么时候可以上线（第 1 节）、冻结后怎么改代码（第 2 节）、正式环境按什么顺序搭（第 3 节）、
  上线当天怎么冒烟和回滚（第 4 节）、上线后第一周做什么（第 5 节），以及 Owner 要亲自做或批准的全部点（第 6 节）。
- **怎样算做完**：第 1.2 节 12 项都有 PASS 记录、第 3 节每一步都读回核对过、第 4 节冒烟和对账无误、Owner 同意公开开放。
- **不做什么**：本文不改产品决定，不定金额（花费上限由 Owner 自己设），不替代 [RUNTIME_PROD_PLAN](../RUNTIME_PROD_PLAN.md)
  第 7.3 节的停止点和第 8 节的批准包，按它们展开。旧正式库 `fhmshnqjjnnlvplojktv` 全程不碰（上线稳定后是否暂停或删除，另请 Owner 决定）。
- **现状会变**：第 1.2 节表里的"现状"一栏是 2026-10-24 晚的快照，**已过期**，最新状态看第 1.2a 节（2026-11-02）；任务进度以 `node scripts/plan-progress.mjs --ref origin/staging` 为准，
  验收结论以各 PR 上的验收记录为准，不以本文为准。

"谁做"的写法：

| 写法 | 意思 |
| --- | --- |
| ★ **Owner 操作** | 只能由 Owner 本人在平台后台或外部账号上点（付费、密钥、条款、对外发信、人机验证） |
| ★ **Owner 批准 → 总控** | 总控执行，但每一次正式环境的读、写、合并都要 Owner 当次批准；执行后读回核对 |
| **总控** | 主窗口：派活、上迁移、排验收、汇报；只动 staging |
| **执行窗口** | AI 在 staging 上开 PR、测试、复审，按 AGENTS 第 3、4 节合并到 staging |
| **Codex** | 浏览器验收（同一测试账号一次只跑一个任务）；Codex 没有额度时由 Claude 临时代做，并在 PR 上写明 |

## 1. 放行条件

### 1.1 规则（Owner 2026-10-23 晚，Master Plan 第 2.1 节）

1. **核心 12 项全部验收通过才上线。** 日期：**上线日 2026-11-15**（Owner 2026-11-03，Master Plan 第 2.1 节；取代 10-28 之后"日期待定"的状态）。冻结日沿用 11-10（Owner 11-03 没有再改，总控 11-03 确认）。
   同日 Owner 定：运营教练复盘、七个平台一键发布、删旧数据库表、100 人复测都必须在上线前完成，100 人复测没过就继续优化（第 1.4 节）。
2. **核心项不能用"关开关、对外隐藏"降级上线。** 赶不上就顺延上线日。**没有例外**：原先"Post for Me 正式项目或 TikHub 价格来不及时作品复盘整体先关"的例外已删除——
   Owner 2026-10-26 说"作品复盘上线开"，2026-11-02 再次确认**运营教练复盘上线时必须开**（2026-11-02 决定来自总控转达的 Owner 指令，**第 2.1 节还没有这条记录，待总控补**；
   起点是 2026-10-27 "改为运营教练复盘，上线前做完"）。一键发布同样不在任何例外内。
3. **首字速度不算核心、不挡上线**：在正式环境实测并记录，不达标作为上线后第一件优化（第 5 节）。
4. 每一项的"验收通过"都要对应**最终冻结版本**（AGENTS 第 4 节第 5 条）：冻结后又改了受影响的代码，要复验改动部分，不用从头重跑。
   NOT_RUN 不算通过；只有本机测试、没有 staging 浏览器记录的页面类项目也不算通过。
5. 第 1.2 节的放行标准是**冻结版本在 staging 上的验收**，是进入建库（第 3.2 节 Q1）的前提；标"（正式）"的部分只能在正式库建好后验证，放到公开开放前核对（第 3.7 节 O-1），不挡建库。
6. 除 12 项外，上线还需要：第 3 节正式环境步骤全部完成并读回；第 4 节冒烟和同日对账无误（正式站不做真钱付款测试，Owner 2026-11-03：staging 付款链路全部测通即可，上线后真实用户订阅出问题再解决）；备份恢复演练（Owner 2026-11-03 改为在 staging 原地恢复）通过或 Owner 明确批准延期（第 7 节 E2）；Owner 同意公开开放。

### 1.2 核心 12 项逐项放行标准

| # | 核心项 | 放行标准（全部满足才算通过） | 证据放在哪 | 现状（2026-10-24 晚，**已过期**，最新见第 1.2a 节） | 负责 |
| --- | --- | --- | --- | --- | --- |
| 1 | 定位三步 + 报告 | ① 新账号从第 1 步走到报告定稿；② 对标：合格 ≥3 才出报告，小众领域扫完不足 8 个也出 1–7 个候选卡，两轮不足 3 个时可选"用现有对标生成、报告注明样本不足"（兜底 B）真实触发一次；③ 对标加深（关键词、按需翻页、自动续扫、YouTube 约数）按 [BENCHMARK_COVERAGE_PLAN](../implementation/BENCHMARK_COVERAGE_PLAN.md) 验收；④ 第 2 步停止不卡、刷新后接回；⑤ 报告扣费一次、双击只扣一次、生成中停止全额退回、生成中刷新接回、导出可用 | 兜底 B：[#1195](https://github.com/Crnobog9527/GraylumAI_vercel/pull/1195) 验收记录；小卡 [#1296](https://github.com/Crnobog9527/GraylumAI_vercel/pull/1296)；停止不卡 [#1272](https://github.com/Crnobog9527/GraylumAI_vercel/pull/1272)；YouTube [#1297](https://github.com/Crnobog9527/GraylumAI_vercel/pull/1297)；加深 [#1313](https://github.com/Crnobog9527/GraylumAI_vercel/pull/1313)、[#1314](https://github.com/Crnobog9527/GraylumAI_vercel/pull/1314)、[#1316](https://github.com/Crnobog9527/GraylumAI_vercel/pull/1316)、[#1317](https://github.com/Crnobog9527/GraylumAI_vercel/pull/1317)；重复请求修复 [#1298](https://github.com/Crnobog9527/GraylumAI_vercel/pull/1298) | 主流程、停止不卡、YouTube 复验 PASS；兜底 B 两次没触发，等 #1296（0343）上库后重跑；加深 4 个 PR 在途（2 个草稿）；报告导出、停止退回、双击、刷新接回在冻结版本上没有新记录 | 对标加深窗口、小卡窗口；Codex |
| 2 | 评审团 | ① Gold 完整走一轮（三位评审 + 汇总）并采用；② 非 Gold 看到"Gold 专属"、不能发起；③ 编辑定稿后再评审、第三轮行为；④ 失败时退款、页面不卡；⑤（正式）正式库准入档案含评审用途（第 3.3 节 B4） | [FUSION-REVIEW](FUSION-REVIEW.md) 各 PR 验收记录 | 10-20 Gold 主流程 PASS；②–④ 在 10-23 后没有新记录 | 总控排窗口；Codex |
| 3 | 我的文风 | ① 生成、确认、修改画像，按量扣一次；② 写稿时注入画像（含模型自行加载的写作 Skill）；③ 删除画像或来源立刻生效，进行中的那次写稿也作废；④ 4 个写作 Skill 勾"使用用户文风"；⑤ 写作 Skill 输出语言跟随用户沟通语言、【】只留给真实素材 | [#1259](https://github.com/Crnobog9527/GraylumAI_vercel/pull/1259)、[#1262](https://github.com/Crnobog9527/GraylumAI_vercel/pull/1262)、[#1266](https://github.com/Crnobog9527/GraylumAI_vercel/pull/1266)、[#1305](https://github.com/Crnobog9527/GraylumAI_vercel/pull/1305) 验收；[#1293](https://github.com/Crnobog9527/GraylumAI_vercel/pull/1293)、[#1318](https://github.com/Crnobog9527/GraylumAI_vercel/pull/1318)、[#1306](https://github.com/Crnobog9527/GraylumAI_vercel/pull/1306) | ①② 9 步验收 PASS（一次发送分笔扣费是按模型调用分笔，设计如此）；③ #1293（0345）、#1318、#1306 在途，合并后复验 | 文风窗口、内容对话窗口；Codex |
| 4 | 自由对话（资料库 + 模型自行加载 Skill） | ① 资料库 @ 引用和自动检索回答用到文档；② 说"写口播稿"会加载对应 Skill，同一轮最多 2 个，按当前对话模型计费、无匹配费；③ 定位、选题窗口、报告仍用后台绑定模型，"重做定位"不在自由对话里跑；④ 手动"技能"菜单可用 | 资料库：CHAT-AUTO-CONTEXT 验收记录；LOAD-SKILL：[#1285](https://github.com/Crnobog9527/GraylumAI_vercel/pull/1285) 验收记录 | 资料库 10-20 PASS；#1285 已合并（0342 已上库），**还没有浏览器验收**；#1258 抽查结果未核实 | 内容对话窗口；Codex |
| 5 | 付款和会员 | ① 银行卡订阅（月付、年付、创始年付、Gold 首月）结账开通；② 续费成功、续费失败宽限后取消、续费期退款规则；③ 微信、支付宝一次性会员和年付在沙盒付款成功和失败；④ 升级、改年付规则；⑤ 积分包只给会员；⑥ 付款前条款勾选 | PAY-STRIPE-MP、PAY-FOUNDER、PAY-NOTIFY 各 PR 验收；续费沙盒测试时钟记录；[#1302](https://github.com/Crnobog9527/GraylumAI_vercel/pull/1302)、[#1304](https://github.com/Crnobog9527/GraylumAI_vercel/pull/1304)、[#1307](https://github.com/Crnobog9527/GraylumAI_vercel/pull/1307) | 续费成功、失败全链、续费外部退款在沙盒 PASS；创始 7 天宽限本机集成测试 PASS；钱包沙盒结果未核实；#1307 后台文案、#1304 回归抽查待页面复验；[#1299](https://github.com/Crnobog9527/GraylumAI_vercel/pull/1299)（旧冒烟脚本）在途 | Codex；总控 |
| 6 | 退款和拒付 | ① 用户申请 → 管理员报价 → 批准 → 执行，只退一次；② 积分已用的订单被拒、续费订单不退；③ 拒付冻结、停续费、判赢后手动撤回；④ 已退款续费单报价说明原因 | [#1104](https://github.com/Crnobog9527/GraylumAI_vercel/pull/1104) 验收表、[#1152](https://github.com/Crnobog9527/GraylumAI_vercel/pull/1152)、[#1155](https://github.com/Crnobog9527/GraylumAI_vercel/pull/1155)、[#1253](https://github.com/Crnobog9527/GraylumAI_vercel/pull/1253)、[#1307](https://github.com/Crnobog9527/GraylumAI_vercel/pull/1307) | 退款主路径和拒付冻结此前 PASS；#1253 后台两栏、②、"上一期拒付 + 下一期续费并发"未核实 | Codex；上线当天真钱一笔见第 4 节 |
| 7 | 注销 24 小时 | ① 真实注销一个现有测试账号，24 小时内正文和存储清完；② 删除定位对话不超时；③ 注销清理慢查询修好；④ 注销弹窗页面验收；⑤ 新表都接入注销审计；⑥ **资料库清理积压演练**：在 Pro 的 5 分钟频率下做大量并发删除、存储删除失败后重试、签名晚到对象，证明最坏情况也在 24 小时内清完，并定出积压告警阈值，结果记在 PR 上（[LIB_DOCS_PLAN](../LIB_DOCS_PLAN.md) 第 146–147 行；只看定时任务返回 200 不算） | 端到端结果表在 [#1292](https://github.com/Crnobog9527/GraylumAI_vercel/pull/1292) 评论；[#1311](https://github.com/Crnobog9527/GraylumAI_vercel/pull/1311)、[#1312](https://github.com/Crnobog9527/GraylumAI_vercel/pull/1312) | ① PASS（约 3 小时清完）；②③⑤ 在途（0344、0349）；④ 浏览器提示词还没出；⑥ 还没做（#1158 写明不在该 PR 内） | DATA-ERASURE 窗口；Codex |
| 8 | 注册登录 + 开户 500 积分 | ① 冻结版本上新邮箱从零注册（过 hCaptcha、邮件确认）→ 恰好 500 积分、一条流水；② 登录、找回密码邮件送达；③ Google 登录只发一次赠送 | 第 4 节冒烟记录；staging 回归记录 | 0230 已合并、此前单点验过；同邮箱重注册 Owner 说 10-12 已测，不再重测；①② 冻结版本上未跑 | Codex（人机验证由 Owner 点）；Owner |
| 9 | 多模型对比 | ① 只给 Gold，非 Gold 看到"Gold 专属"；② 默认勾 Sonnet 5.5、Gemini 3.8 Flash、GPT-6.1 Sol，Opus 只在可选列表；③ 每次用户扣的积分合计最多 500 积分（5 美元，Owner 2026-10-26）；④ 新对话第一条消息就能对比；⑤ 出字后全部停止，已开始的列按部分计费、各列之和等于合计；⑥ 采用一列后对话继续；⑦（正式）正式库"正式模式准入"验证通过（第 4.1 节 K6） | [#1260](https://github.com/Crnobog9527/GraylumAI_vercel/pull/1260)、[#1270](https://github.com/Crnobog9527/GraylumAI_vercel/pull/1270)、[#1273](https://github.com/Crnobog9527/GraylumAI_vercel/pull/1273)、[#1309](https://github.com/Crnobog9527/GraylumAI_vercel/pull/1309) 验收；[#1310](https://github.com/Crnobog9527/GraylumAI_vercel/pull/1310)（0348，上库前后各跑一次 PR 评论里的比对 SQL） | 首轮 13 步有 5 步失败，修后复验部分通过；⑤ 没覆盖；④ #1310 在途；⑦ 正式路径从没测过 | 对比窗口；总控；Codex |
| 10 | 作品复盘 + 一键发布 | 一键发布：① 从选题定稿、成果夹成果、"我的账号"里添加的品牌账号都能走到发布（添加账号要先有已确认定位）；② 不真发的 7 步验收通过；③ X、YouTube 各真实发布并查回一次（每次 Owner 当次批准）；④ 名单内平台开放（见第 7 节 E1）。运营教练复盘：⑤ 导入表格、按档位显示 30/90 天（长期成绩单和实验账本不按窗口截断）、每周自动复盘、对话里主动复盘，每份平台成本上限 1 美元（Owner 2026-10-27，取代原 0.30 美元；读截图的费用算在内）；**上线必须开，没有整体关的例外**（Owner 2026-11-02，第 1.1 节第 2 条） | [#1263](https://github.com/Crnobog9527/GraylumAI_vercel/pull/1263)、[#1261](https://github.com/Crnobog9527/GraylumAI_vercel/pull/1261)、[#1267](https://github.com/Crnobog9527/GraylumAI_vercel/pull/1267) 验收；[#1300](https://github.com/Crnobog9527/GraylumAI_vercel/pull/1300)（0347）、[#1295](https://github.com/Crnobog9527/GraylumAI_vercel/pull/1295) | 复盘关闭态和后台页 PASS；一键发布已合并但全库品牌账号 0 条、入口可能走不到，等 #1300、#1295；② 未跑；Post for Me 多平台计数回复未核实 | 一键发布窗口；Codex；Owner |
| 11 | 自由对话研究工具 | ① 4 个场景真实调用并逐条扣费；② 删除整段对话后研究证据被清；③ TikHub 价格每日刷新和到期告警已上线；④ 三家供应商硬上限已设、后台勾"已设硬上限" | [#1264](https://github.com/Crnobog9527/GraylumAI_vercel/pull/1264) 验收；[#1294](https://github.com/Crnobog9527/GraylumAI_vercel/pull/1294)（0346） | ① PASS；② 等 #1292；③ #1294 在途；④ Owner 设 | 研究工具/对标窗口；Codex；Owner |
| 12 | 成果夹 + 付费墙曝光 | ① 成果夹保存、查看、重复保存不重复；② 选题窗口里的成果（第 11 步）；③ 付费墙曝光事件 `paywall_view` 发出（GA4 上线后第一周才定，不发不挡上线，但要记录结果） | [#1268](https://github.com/Crnobog9527/GraylumAI_vercel/pull/1268)、[#1269](https://github.com/Crnobog9527/GraylumAI_vercel/pull/1269)、[#1288](https://github.com/Crnobog9527/GraylumAI_vercel/pull/1288)、[#1255](https://github.com/Crnobog9527/GraylumAI_vercel/pull/1255) | ① PASS；② 待补验；③ 未核实 | Codex |

**2026-10-26 晚验收证据全量核对**（以它为准，上表"现状"栏已过时）：见 [REL-1-TASK-AUDIT-2026-10-26 第 6 节](REL-1-TASK-AUDIT-2026-10-26.md#6-2026-10-26-晚验收证据全量核对取代第-2-节的还差判断)。**2026-10-26 逐个定性**：44 个实施中任务的结论和每个核心项还差什么见 [REL-1-TASK-AUDIT-2026-10-26](REL-1-TASK-AUDIT-2026-10-26.md)（上表“现状”栏截至 10-24 晚）。

### 1.2a 现状（2026-11-02）

**先说一个会误导判断的事实**：2026-10-28 重做了每轮对话主路径（CORE-PATH-V2，开轮／回执／收轮）。10-28 以前在旧路径（`runtime_executions`、BILL2）上做的"PASS"，
只能证明产品逻辑，**不能证明新路径**；上表里 10-26 及以前的 PASS 记录，凡走主路径的项都要在新路径上重验。
旧路径的最终删除（V2-12）还没做完，要等在途的各个 PR 合并后才做（不可逆），所以现在 staging 上新旧代码还并存。

下表来自总控 2026-11-02 的只读核对（本机笔记，**不在仓库里，我没有逐条复核**；标"未核实"的是总控也没找到证据的）。以 PR 上的验收评论为准。

| # | 核心项 | 新路径上已有的证据 | 还要做什么 |
| --- | --- | --- | --- |
| 1 | 定位三步 + 报告 | 开场／下一轮扣费、刷新后草稿仍在；定位计划生成并确认；报告确认后扣 500、13 章完整、生成中刷新接回；第 1、2 次停止全额退（第 3 次起按已生成扣）。 | "新档案从第 1 步一条龙到定稿"在新路径从没一次跑通；兜底 B（对标不足）从没真实触发；导出、归档报告能否打开没有新记录；导师"首发在选项出现前"的竞态是否已修**未核实** |
| 2 | 评审团 | 新路径第 7、8 轮通过：三位评审都在、逐章选择、刷新还在、扣 1500。 | 非 Gold 看到"Gold 专属"、改后再评审／第三轮、失败退款抽验；（正式）准入档案 |
| 3 | 我的文风 | 仅 10-26 旧路径 5 项 PASS。 | **必须重验**：文风改接主路径的 PR 还在途；合并后整套 5 项在新路径重跑，文风表要接入注销审计 |
| 4 | 自由对话（资料库 + LOAD-SKILL） | 自由对话首发／续聊／刷新、两个标签并发余额正确。 | **必须重验**：@ 引用、自动检索、"写口播稿"加载 Skill（同一轮 ≤2 个）、手动技能菜单、"重做定位"不在自由对话里跑 |
| 5 | 付款和会员 | 10-26 六项 PASS（微信／支付宝为 Owner 亲测）。 | 不在主路径，不用重验；冻结版本冒烟一遍；免费账号点积分包被拒 |
| 6 | 退款和拒付 | 退款只退一次、拒付冻结／停续费／撤回 PASS。 | "上一期拒付 + 下一期续费并发"；确认"冻结只冻真实剩余"与新回合冻结不冲突（**未核实**）；Owner 在 Waffo 后台打开拒付邮件（E5） |
| 7 | 注销 24 小时 | 10-26 真实注销 24 小时内清完（Owner 亲测）。 | **必须重验**：注销的钱检查、会话墓碑、内容清除改接新表的 PR 还在途；删除 20+ 轮定位对话不超时（**未核实**）；新表接入注销审计；备份恢复演练（E2，费用待 Owner 确认） |
| 8 | 注册登录 + 500 积分 | Owner 亲测通过。 | 冻结版本冒烟；建库日 hCaptcha 由 Owner 点 |
| 9 | 多模型对比 | 两列、三列各 7／4／2 积分、采用后内容进入对话。 | 新路径上的停止／部分计费、非 Gold 付费墙；>500 积分拒绝开始以单元测试为准 |
| 10 | 运营教练复盘 + 一键发布 | 仅"复盘关闭态 + 后台页"PASS。 | **必须重验并补做**：付费读取 TikHub 接主路径、复盘（RC-2）的 PR 在途；复盘开启态整套（导入、30／90 天、每周自动复盘、每份 ≤1 美元、余额不足跳过）**从没成功生成过**；不真发 7 步没跑；X／YouTube 真发要 Owner 当次批准；**这是剩余里最不确定的一项** |
| 11 | 自由对话研究工具 | 10-26 四场景真实调用并逐条扣费 PASS、删对话证据被清、三家各 30 美元硬上限为 Owner 设。 | **必须重验**研究读取函数改接主路径后的四场景 |
| 12 | 成果夹 + 付费墙曝光 | 成果夹保存 PASS。 | 选题窗口里的成果（第 11 步）待补验 |

**100 人验收**（`docs/validation/core-path-v2/result-20261101.md`，已在仓库、我读过前半）：2026-11-01 在 staging Micro 上 30→100 人六档共 1745 个回合，0 失败、0 次超时、账目全平；
**但"整轮 p95 ≤ 桩回复 + 2 秒（约 8 秒）"这条线没过**（实测约 18.6 秒，且与人数无关，疑为本机到 staging 的往返，报告自己写"未验证"）；交换区"不涨"严格算也没过。
所以**目前不能说"100 人验收通过"**。Owner 是否已验收、是否接受这两条未过的线，我没有找到记录（**未核实**）。

**冻结版本不存在**：10-26 到 11-01 的多轮 Codex 验收中间都发生过部署切换，总控核对认为它们**不能算单一版本的验收**；冻结版本要整套核心 12 项重跑（本手册第 1.1 节第 4 条）。

**验收排队建议**（Codex 一次只能跑一个浏览器任务）：最难、最可能再失败的先跑——兜底 B → 对比合并轮 → LOAD-SKILL + 文风 →
一键发布不真发 7 步 → 注销浏览器部分 → 付款和注册 → 评审团剩余项 → 成果夹第 11 步。
验收提示词放在对应 PR 的 `Validation handoff` 评论里，结果也回写到那个 PR。

### 1.3 不在上线范围（上线后再做，Owner 2026-10-23 晚已批）

内容对话剩余 7 个 PR（不含成果夹和 LOAD-SKILL）、"一窗口一选题"提醒、整理纪要、首字速度优化、新一轮定位沿用上一轮对标
（上线时每轮重新对标）、MODERATION（上线时继续暂缓）、MOBILE-UX、ANALYTICS-POSTHOG、GA4 方案。见第 5 节。

### 1.4 上线日期（2026-11-03 更新）

- **上线日 2026-11-15**（Owner 2026-11-03："全力推进，不要找任何借口"，Master Plan 第 2.1 节 11-03），取代 10-28 推迟上线后"日期待定"的状态。
- 冻结日：沿用 11-10（Owner 2026-10-26 定的"冻结 11-10、上线 11-15"，11-03 Owner 没有再改；总控 2026-11-03 确认沿用）。
- 11-03 同日 Owner 的"上线必须有"：运营教练复盘和七个平台一键发布、删旧数据库表（V2-12 批次 F）、100 人复测，都必须在上线前完成；复测没过就继续优化（"七个平台"以第 7 节 E1 的 9 个平台名单为准，总控 11-03 确认）。
- 11-03 同日：正式站不做真钱付款测试（staging 付款链路全部测通为前提）；备份恢复演练改在 staging 原地恢复。
- 倒排的各步排期由总控另出；"验收通过"以 Owner 当次明确说通过为起点，AI 不替 Owner 宣布通过。

## 2. 冻结后的规则

冻结日 11-10（第 1.4 节）：冻结后按下面做。冻结不等于上线日：冻结之后一直到上线都按下面做。

1. **冻结前要完成**：
   - CORE-PATH-V2 全部合并，并完成最后一步 V2-12（删除旧路径的数据库表和函数，**不可逆**，按计划排在所有改接新路径的 PR 之后、复验通过之后）；
   - 在途的迁移全部定号上库（现状见下面的迁移清单），冻结版本里没有重号、没有暂定号；
   - 核心 12 项需要的功能代码全部合并。
2. **冻结后只改两类东西**：核心 12 项验收发现的问题；上线阻塞问题（登录、对话、付款、回调、监控、注销）。
   不加新功能，不做"上线后"清单里的事，不做和这两类无关的重构和依赖升级（安全公告修复除外）。
3. **每个冻结后的修复**照常走 PR、CI、独立审查；合并后由总控判断要复验哪几项（只复验受影响的部分），
   在对应 PR 写明"需要/不需要重新做浏览器验收"。
4. **新迁移**冻结后原则上不再加；确实需要时由总控当场给号，并在上库前后各做一次重放比对。
5. **冻结版本**由总控在全部 12 项 PASS 后选定，作为合并到 `main` 的版本；之后再有修复，冻结版本随之更新，
   Owner 的"同意上线"只对说清楚的那一个版本有效。
6. 冻结期间可以照常做第 3.1 节那些不依赖冻结版本的正式环境准备。

### 2.1 迁移清单（截至 staging `5cfb5ff42`，2026-11-02）

- **当前最新号 0471**（`0471_core_path_v2_admin_turn_reports`，费用报表读 `turn_calls`）。`packages/db/migrations/` 里从 0349 起共 89 个文件，**号码有空缺是正常的**
  （被改号或关闭的 PR 不补号）。正式库建库按文件目录为准，不按下面的摘要；建库日用 `built-fingerprint` 和 `expected-differences.json` 比对（B1）。
- **上库状态我没法核实**（没有读数据库）：某个号"在仓库里"不等于"已在 staging 库应用"。已上库的记录以总控的迁移账本和 PR 评论为准；本节只列仓库里有的。
- **10-24 版手册写的"待上库 0343–0351、下一个可用号 0352"已过期**：0343–0348 在仓库里；0349–0351 没有对应文件（未使用或已改号，**未核实原因**）。
- 0352–0419（49 个）：旧路径时期的修补——运行时可见性与恢复、注销清理提速、研究关键词卡与相关度、资料库、账本约束与对账、每日签到下线（0396）、报告停止限制（0412）、评审团暂停结束（0415）等；
  其中 DB-RW 的 0416、0418、0419（共享行锁、准入拆分、目录版本号）**已按 Owner 10-28 决定保持关闭**（主路径重做期间暂停）。
- 0420–0471（40 个）：**CORE-PATH-V2 新主路径**——新表（0420）、核心函数（0421）、启动门槛 L（0422）、定位导师（0423、0428、0434、0435）、恢复（0424）、注销（0426、0461）、
  资料库读取（0427）、报告（0429、0432、0440、0456、0468）、评审团与对比（0436、0443）、补冻与止损按次补（0451、0453）、语音／文风（0459）、复盘基础（0457）、管理员费用报表（0471）等。
- **还会再增加**：V2-12 的"删除旧表旧函数"迁移、文风（B7）、TikHub 读取（B8a）、研究读取函数（B9b）、注销钱检查（B10）等在途 PR 若带迁移，都要由总控定号上库。号码以当时为准，本节不预留。
- 带迁移的 PR 只能由总控先上库再合并（AGENTS 第 8 节）；本手册不分配号码。

## 3. 正式环境上线步骤

顺序铁律（出错代价最大的三件事）：
① `main` 还是旧依赖（Next 有严重漏洞），**绝不能单独部署 `main`**，只能在 staging 合并进 `main` 时一起部署；
② Vercel 正式变量**先**换成新 Supabase 项目，**再**合并 `main`，否则部署出来连的是旧库；
③ 域名：先撤 `www → app` 的临时 307，先把 Stripe、Post for Me 回调主机改成 `www.graylum.com`，**最后**才放旧主机到 www 的 308，否则无限循环。
站点恢复、模型调用开放是两件事，分别批准，不能一句话全包（正式站不做真钱付款测试，Owner 2026-11-03）。

**总顺序（2026-11-02 刷新；每个箭头都是一次停下来等 Owner）**：
① 主路径在 staging 上完成并通过 **100 人验收**（Owner 当次说通过）→ ② 上线日 2026-11-15（Owner 11-03，第 1.4 节）→ ③ 旧路径删除（V2-12）完成、冻结版本选定、核心 12 项全部 PASS（Q1）→
④ 批准包（Q2）、Owner 同意（Q3）、三地区一致（Q4）→ ⑤ 建库日：B1 建库 → B2 标记 → B3–B12 配置（含连接池数字、日限，第 3.0a 节）→ ⑥ V1–V4 Vercel 变量 → M1 合并到 `main` 部署（站点仍暂停）→
⑦ 冒烟日 S-1…S-8 + 第 4 节冒烟 → ⑧ 同日对账无误、备份恢复演练（staging 原地恢复）通过 → ⑨ O-1…O-6 公开开放。
第 3.1 节（P1…P9）是 Owner 外部事项，可以在 ① 之前就做，不依赖冻结版本，但**每一项仍要 Owner 自己操作或当次批准**。

建库日从头到尾的顺序清单（2026-11-03）、B8 的 staging 对照表、上线第一天告警值守表见 [REL-1-BUILD-PREP](REL-1-BUILD-PREP.md)；建库日按当天的 staging 重查。

### 3.0 已经完成的（只在步骤里核对，不用再做）

| 事项 | 现状 | 出处 |
| --- | --- | --- |
| 正式 Supabase 项目 `Graylum_main` | 已新建（Owner 2026-10-17 选新建）；区域 us-west-1（旧版建议 us-west-2，已建不能改，和 Vercel sfo1、Upstash sfo1 同在美西）；10-22 已升级 Pro、换 Micro | 总控记录 |
| Vercel | 已是 Pro；正式项目 `graylum-ai-vercel-v1` 暂停中、函数区域 sfo1 | 总控记录 |
| 定时任务频率（旧 A2） | `apps/web/vercel.json` 已是 Pro 频率：`runtime-recovery` 每分钟（也负责发止损告警）、`account-erasure` 和 `library-cleanup` 每 5 分钟、`social-monitor` 每 10 分钟（作品复盘开关关着时空转）、`fusion-recovery` 每 10 分钟（MAINT-P3b：评审团/对比里已派发且过了派发期限 10 分钟的未结算调用，不等每日对账）。**只是频率改好了**（主路径重做后恢复任务的分工是否变了、是否还需要这些频率，**未核实**，建库日按当天 `vercel.json` 对照），资料库清理积压演练不在 #1158 里，仍是开放门槛（第 1.2 节第 7 项⑥） | [#1158](https://github.com/Crnobog9527/GraylumAI_vercel/pull/1158) |
| 正式 Upstash Redis | 已建，`UPSTASH_REDIS_REST_URL` / `_TOKEN` 已加到 Production | 总控记录 |
| Resend | `graylum.com` 发信域名已验证 | 总控记录 |
| Stripe 正式 | 已开通 Managed Payments；续费、卡到期、扣款失败提醒由 Stripe 发（我方不再发卡类续费提醒） | 总控记录；Master Plan 第 2.1 节 2026-10-19 |
| OpenRouter | 账号已关闭"允许用于训练" | 总控记录 |
| 钱包税务核实 | 已完成，Owner 同意打开钱包年付 | Master Plan 第 2.1 节 |
| 条款正文、客服邮箱 | `/privacy`、`/terms`、`/cookies`、`/refund-policy` 已上线为公开页面；客服邮箱已有；Termly 已配好 | [#1184](https://github.com/Crnobog9527/GraylumAI_vercel/pull/1184) |
| 正式模型调用、付款入口代码闸门（旧 R1、R7） | 已合并：正式准入和库标记（0291）；付款入口闸门 [#1093](https://github.com/Crnobog9527/GraylumAI_vercel/pull/1093)；银行卡和钱包按账户模式走、四类退款、钱包一次性会员退款（0296、0297、0298） | 迁移合集 [#1129](https://github.com/Crnobog9527/GraylumAI_vercel/pull/1129) |
| 单主机 `/app`（旧 E1 代码） | 已合并：应用并入 www、登录后页面放 `/app`、旧主机一次 308 到 `/app` | [#1206](https://github.com/Crnobog9527/GraylumAI_vercel/pull/1206)、[#1225](https://github.com/Crnobog9527/GraylumAI_vercel/pull/1225) |
| 明文模型密钥列、环境变量后备（旧 B4、T-END） | 已合并：删除 `ai_models.api_key`（0323）、结束环境变量后备 | [#1208](https://github.com/Crnobog9527/GraylumAI_vercel/pull/1208) |
| Sentry 规则 `PUBLISH_MONITOR_CLEANUP_STUCK` | 正式和 staging 各建一条（按消息内容匹配） | 总控记录 10-23 |

### 3.0a 主路径重做（CORE-PATH-V2）后，正式环境多出来的东西

依据：CORE-PATH-V2 计划第 2.5.1、2.8、5.4 节，Master Plan 第 2.1 节 2026-10-28、10-31、11-01。**staging 和正式走同一条代码路径，没有“测试窗口”和“正式准入”两套**；差别只在配置值。
下面每一项都是正式库建好后要写进去的设置，**每次都要 Owner 当次批准，金额和数字由 Owner 定，AI 不定**。

| 设置（`system_settings` 键） | 里面是什么 | 谁定数字 | 注意 |
| --- | --- | --- | --- |
| `core_path_v2` | `enabled`（开关）、`stopLoss`（`limitUsd` 每日全站上限＝**日限**，`p` 数据库最大并发事务数，`poolSize` 连接池大小，`uFastUsd` 普通回合单轮成本上界，`uBigUsd` 大额回合单轮上界）、`decisionUpperUsd`（一次定位检查的成本上界） | 日限和连接池数字：Owner；`uFastUsd`、`uBigUsd`、`decisionUpperUsd`：总控按当时模型价格算好后给 Owner 批 | 缺这一行或 `enabled:false` 时**所有回合都被拒**，不会退回旧路径。V2-12 之后“开关”本身会被删除，只剩参数（**未核实最终形状**，建库日按当天 staging 读回值对照） |
| `runtime_payg` | 线路、用途、请求格式、思考档位、容量、`enabled` 一键应急关闭；**没有**窗口编号和到期日 | 总控按 B4 的覆盖要求准备，Owner 批 | 取代原来的 `runtime_payg_production`（第 3.3 节 B4）。键名以 V2-12 合并后的代码为准（**未核实**，今天代码里两个名字都还在） |
| `runtime_stop_loss` | 后台“成本止损”页：每用户每日、全站每日、全站告警线、供应商余额告警线 | Owner 自己在后台填 | **金额是空的时候不会发任何告警**（P4）。它管告警；真正挡住花费的是上一行 `core_path_v2.stopLoss` |
| `billing_payg_start_thresholds` | 每个模型×用途的开轮启动门槛 L（余额够这个数就能开始一轮） | 自动按价格算，导入模型后在后台读取 | Owner 2026-10-28 补充 3：余额够一轮正常费用就能开始，冻结取“本轮上界”和“可用余额”较小值，中途不够时暂停提示充值，**不允许负余额** |

**这几个数字之间的关系（写错会出事，建库日照这个顺序）**：
1. **先定连接池大小**（第 7 节 E4）：正式库 PostgREST 连接池数字要上线前问 Owner，Owner 同意后才设（staging 现在是 8）。
2. **再把 `stopLoss.poolSize` 和 `stopLoss.p` 写成同一个数**，并且不小于实际连接池大小。`p` 小于实际连接池大小时，数据库在开轮时直接拒绝（计划写明：安全证明只在 P ≥ 池大小时成立）。以后调大连接池，必须**先**改这两个数再调池。
3. **再定日限 `limitUsd`**。预留带 `B = (p−1)×uFastUsd + uBigUsd`；接近日限时会提前拒绝约 B 美元，计划要求日限 ≥ 10×B，否则太早拒绝。
   计划里的算例：照 staging 的 p=8、`uFastUsd`≈1.5、`uBigUsd`≈5，B≈15.5 美元，日限至少约 155 美元；按 11-01 补冻后每轮在途占用约 3 美元，同时 N 轮需要日限 ≥ 3N + B + 当天已花。**这只是算例，正式数字等 Owner 定。**
4. 日限是**每日全站上限**。Owner 2026-11-01 同意“按次补预占”：`chat`、`mentor` 每轮开轮只预占一次模型加最大一个付费工具，不够时补预占，超限按止损拒绝；当日实际花费不会超过日限。
5. 每轮用户积分冻结同样“开轮冻一次、不够补冻”（Owner 2026-11-01）；有余额不暂停，余额真不够才暂停。

**一句话**：连接池数字 ≤ `poolSize` ＝ `p` → 才能定日限 → 日限太小会提前拒绝。这三个数字都要 Owner 点头。

### 3.1 现在就能做、不依赖冻结版本（Owner 外部事项）

| # | 谁 | 做什么 | 怎么确认 |
| --- | --- | --- | --- |
| P1 | ★ Owner 操作 | Supabase `Graylum_main` → Authentication：SMTP 接 Resend（发件 `no-reply@graylum.com`）；Google Cloud 的 OAuth 客户端加新项目回调，客户端编号和密钥填进新项目；hCaptcha 填密钥；Site URL 设 `https://www.graylum.com`（不是 `/app`），Redirect URLs 允许 `https://www.graylum.com/**`；邮箱确认开启。其余 Auth 设置（邮件模板、密码强度）按总控整理的 staging 对照清单逐项设 | 第 4 节冒烟时真实走一遍注册、确认邮件、Google 登录、找回密码 |
| P2 | ★ Owner 操作 | Stripe 正式：建 webhook 端点 `https://www.graylum.com/api/stripe/webhook`，**事件选"所有事件"**（Owner 2026-10-21 同意；代码对没处理的事件直接返回成功）；新端点的签名密钥由 Owner 填进 Vercel，之后不轮换。重试改为第 1、3、6 天、失败后取消；账单描述、客服邮箱、条款和隐私链接；开 Stripe Tax 门槛监控；客户门户关闭"切换套餐"；开通 WeChat Pay、Alipay | 端点详情显示"所有事件"；后台设置读回 |
| P3 | ★ Owner 操作 | Post for Me：订阅正式环境**独占**的项目（每月至少 10 美元，不与 staging 共用）。Owner 2026-10-26 的话是“Post for Me 正式已订阅”；项目是否独占、Webhook 是否已指向 www、项目里是否只有正式环境的账号，**未核实**，由 Owner 在后台确认；Webhook 指向 `https://www.graylum.com/api/postforme/webhook`，订阅账号变化和发布结果事件 | 项目里只有正式环境的账号 |
| P4 | ★ Owner 操作 | 花费上限（Owner 自己设，总控不定金额）：OpenRouter 正式专用密钥的每日美元上限、不自动充值、禁用 BYOK；TikHub、Parallel、Firecrawl 各自硬上限；止损金额（每用户每日、全站每日、全站告警线、供应商余额告警线）在建库后由 Owner 在后台"成本止损"页填。**金额是空的时候不会发任何告警**。真正挡住花费的每日上限和连接池数字在 `core_path_v2`（第 3.0a 节、B12） | 各家后台读回；建库后后台读回 `runtime_stop_loss` 和 `core_path_v2` |
| P5 | ★ Owner 操作 | 取得正式站的 hCaptcha sitekey（域名 `www.graylum.com`）、Termly 网站编号；生成正式专用的 `OPENING_GRANT_HMAC_KEYS`（不复用 staging）、`CRON_SECRET`（没有它所有定时任务返回 503） | 3.3 节变量清单里有这些变量名 |
| P6 | ★ Owner 操作 | 正式 Sentry、Vercel、Resend 的日志保留期 ≤30 天；`Graylum_main` 的每日备份和 PITR 保留期 ≤30 天（隐私政策承诺；删除清单在 Redis 里保留 35 天，备份保留期更长会让已删内容在恢复后复活） | 各后台读回，记进上线记录 |
| P7 | ★ Owner 操作 | 隐私条款补写：素材经 Post for Me 处理、发布期间是公开链接、失败素材约一天后由对方清理；Parallel 未书面确认零保留前按"可能用于训练"写（条款文字由 Owner 用第三方工具生成，AI 不写） | Owner 确认 |
| P8 | ★ Owner 操作 | Stripe 正式商品目录（第 3.6 节 S1–S5），在建库日之前跑完 `plan`、`apply`；`sql`、`sql-packs` 的输出只交总控审核 | 再跑一次 `plan` 全部 exists、没有 MISMATCH |
| P9 | ★ Owner 批准 → 总控 | 正式只读核验：Vercel 项目仍暂停、Pro、sfo1；`Graylum_main` 是 Pro、PostgreSQL 17、有 `supabase_vault`、允许迁移 0010 建 `pg_cron` 再由 0148 删掉；`rls_auto_enable` / `ensure_rls` 事件触发器取值和 staging 一致；Vercel 正式变量名清单（不读值）；正式变量里不再出现旧项目的地址和编号 | 只读报告，每项 PASS / NOT_RUN；缺项 Owner 当天补 |

### 3.2 冻结版本选定后、建库前

| # | 谁 | 做什么 | 怎么确认 |
| --- | --- | --- | --- |
| Q1 | 总控 | 确认第 1.2 节 12 项在 staging 上全部 PASS 且对应冻结版本（标"（正式）"的部分除外，见第 1.1 节第 5 条）；冻结版本的 CI、独立审查都对应同一个版本；`pnpm audit --audit-level high` 0 高危 | 记录贴在冻结版本的 PR 上 |
| Q2 | 总控 | 准备**批准包**：正式项目、域名、冻结版本、迁移清单、每组配置值、各家上限金额（Owner 已设的读回值）、冒烟预算；没读过的正式事实标 NOT_RUN | 批准包发 Owner |
| Q3 | ★ Owner 批准 | 同意冻结版本和批准包（第 6 节可复制句） | 总控记下 Owner 原话 |
| Q4 | 总控 | 建正式站前核对三地区一致：Supabase 正式项目 us-west-1、Vercel 正式项目 Function Region = sfo1、Upstash 正式 Redis us-west-1，三者一致才继续（Owner 2026-10-26，Master Plan 第 2.1 节） | 三项只读读回值写进批准包；任何一项不一致就停下来报告，不继续建库和部署 |

### 3.3 建库日：维护态（站点保持暂停、`stopNewCalls` 开着、付款路由关着）

每一步都读回，每一步后停下等 Owner 确认。每组数值 Owner 当次批准。

**先后顺序（2026-11-03 更正）**：后台页面（读取价格、管理员注册、密钥槽、止损金额、研究工具上限确认、Skill 发布）要等站点指向新库**部署之后**才有，所以下面凡是要用后台的动作（B3 的"读取价格"、B3a 的 Skill 发布、B7 的 `hardCapAttested`、B10、B11、全量核对 B8／B9）都排在第 3.4 节 V1–V4、M1 部署和第 3.5 节 S-1 恢复站点**之后**，顺序见 [REL-1-BUILD-PREP](REL-1-BUILD-PREP.md) 第 1 部分第 30a–30f 步；只写数据库的 B1、B2、B3（除读取价格）、B4–B7（除 `hardCapAttested`）、B12 仍在部署之前。期间新调用和付款路由保持关。

| # | 谁 | 做什么 | 怎么确认 |
| --- | --- | --- | --- |
| B1 | ★ Owner 批准 → 总控 | `Graylum_main` 从空库建库（按 Master Plan 第 2.1 节 2026-10-25 BASELINE-SQUASH：冻结后先做干净起点，三方一致才用；不一致退回下面的旧方式）：平台前置 → `packages/db/baseline`（0000）→ 全部迁移（同名 bridge 紧挨在迁移前）；**每个文件整段交给服务端执行，不用 `psql -f`** | 只读抓指纹，和 `built-fingerprint`、`expected-differences.json` 比对，没有解释不了的差异 |
| B2 | ★ Owner 批准 → 总控 | 写正式库标记：`runtime_environment="production"`，读回 `runtime_production_database()` 为 true；正式库启用的测试窗口为 0（**绝不在 staging 写**） | 读回 |
| B3 | ★ Owner 批准 → 总控 | 配置类数据：套餐（Pro $29 / 3,480、Gold $69 / 8,970，年付 $279 / $621，免费每月 0、每年 0）、积分包和会员折扣、`billing_credits_per_usd`=100、`billing_token_price_multiplier`=6、模型和线路（用 SQL 写入；"读取价格"要用后台，排在部署之后；不从 staging 复制价格）、`runtime_purpose_budgets`、已发布的 Skill 和模块、输出上限 32768。不复制 staging 的测试账号、对话、订单、流水、沙盒编号、测试窗口 | 逐项读回 |
| B3a | ★ Owner 确认 → 总控 | （排在部署并恢复站点之后）**首批创作 Skill 正式发布前，Owner 看过样例并单独确认**（Master Plan 第 2.1 节 2026-10-17：只豁免 staging 测试发布，正式版本仍须单独确认）。确认前这些 Skill 不在正式库发布（可以导入但保持未发布）；不能用"同意建库""同意上线"这类通用批准代替 | Owner 原话记在上线记录；正式后台 Skill 版本读回 |
| B4 | ★ Owner 批准 → 总控 | 正式准入档案（今天叫 `runtime_payg_production`，主路径重做完成后合并成一份 `runtime_payg`，见第 3.0a 节；结构同 staging，去掉 windowId 和到期日；模型 id 字符串和线路可照抄取证，`ai_models` 的 uuid 要用正式库的）。**必须覆盖**：对话和报告模型（Claude、Gemini）；整理模型（`v3_summary_model_id` 指向 GPT-6 Luna）要有 `organizer` 用途、`serial-tools-v6-reasoning` 格式和报价（文风生成用它）；评审团三位评审和汇总；对比四个模型的 `fusion_compare` 用途和 `fusion-text-v1-stream` 格式；自由对话研究工具 `maxTools` ≥5、定位导师回合 ≥9；档案用途上限 9 | 读回；应急关闭写 `{"enabled":false}` |
| B5 | ★ Owner 批准 → 总控 | 付款配置：`payment_terms_version`＝`{"version":"<已发布版本>"}`（对象）；Stripe 正式目录绑定写进 `payment_provider_refs`（第 3.6 节 S4 的 SQL，每个套餐/积分包/方式/周期恰好一条当前 live 映射）；`launch_baseline_at`（建库后、第一笔真钱前）；微信、支付宝 `annualVerified=true`（路由 `enabled` 仍关）；新购买渠道 `payment_method_routes.newPurchaseChannel` 缺省就是 `stripe`，读回即可（旧键 `payment_new_purchase_channel` 只剩后台旧面板读取，写不写不影响用户） | 逐个读回；会员页 `termsVersion` 不为空、可结账 |
| B6 | ★ Owner 批准 → 总控 | 限流和停止：`runtime_rate_limits` 消息 10/分钟、200/天，调用 30/分钟、600/天，`stopNewCalls`＝开（这些数字是 10-24 的值，主路径重做后是否仍适用**未核实**，建库日按当天 staging 读回值对照） | 读回 |
| B7 | ★ Owner 批准 → 总控 | 功能配置（取值来自 Owner 已定的决定）：对比 `fusion_settings.compare`（允许 Sonnet/Gemini/Sol/Opus 的正式 uuid，默认 Sonnet 5.5、Gemini 3.8 Flash、GPT-6.1 Sol，`minModels`=2，`answerOutputTokens`=8192，`maxBudgetUsd` 随实现改成“用户扣的积分合计 ≤ 500 积分”，Owner 2026-10-26；旧值 3.5 作废）；Sol、Opus 的 `config.reasoning.purposes.interactive` 加低思考档；`allow_fusion_compare` 和评审团只给 Gold；研究工具 `chat_research_tools_enabled`、`research_tools_config`（三家供应商 `enabled`；`hardCapAttested` 要正式管理员在后台勾，排在部署和管理员注册之后、各家上限设好之后；已验证平台、每条回答子调用 ≤12）、`billing_provider_prices`（未过期）、`billing_payg_start_thresholds`；资料库 `library_agent_read_enabled`、`chat_library_retrieval_enabled`、`chat_my_posts_enabled`、`library_upload_enabled`、`library_scan_recognition_enabled`；作品复盘 `publish_monitor_enabled`（JSON 布尔 `true`）、`_review_enabled`、`_review_model_id`、`_review_max_usd`＝每份复盘平台成本上限 1 美元（Owner 2026-10-27，取代 0.30；字段名和格式以当天 staging 读回为准，**未核实**）；一键发布 `publish_monitor_publish_platforms`（名单见第 7 节 E1）、`publish_monitor_publish_quota`（条数和 Post for Me 套餐一致，不填就不能发布）、`publish_monitor_publish_listed`；P3 的独占项目确认后才打开孤儿清扫删除 `publish_monitor_orphan_sweep_delete`（默认只记录不删）；自由对话主力模型 `primary_model_id`（正式库 `ai_models` 的 uuid，且这个模型在 B4 准入档案里，不配则自由对话全部被拒）；定位报告开关 `runtime_report_generation`＝`{"enabled":true}`（空库没有迁移写它，不写则定位报告全部 REPORT_DISABLED）；写作 Skill `modules.uses_user_voice`（`short-video-script`、`post-and-article`、`video-storyboard`、`video-editing-guide`）；`model_identity_guard` 开 | B8 差异表 |
| B8 | 总控（只读 staging，需批准读新库） | （排在部署并恢复站点之后）**种子配置全量核对**：列出 staging 全部 `system_settings` 键、套餐、积分包、模型、Skill 发布状态、`payment_provider_refs`，和新库逐项对照；每个差异补上或写明为什么不需要 | 差异表没有未处理项，附在执行记录 |
| B9 | 总控（需批准只读） | Vault 已装、0259 已应用；没有"付款方式为空、未关闭、未付款"的旧路径订单；两个资料库桶私有、`storage.objects` / `storage.buckets` 上没有策略 | 只读 SQL |
| B10 | ★ Owner 注册；授权 Owner 批准 → 总控 | （排在部署并恢复站点之后）Owner 在新项目注册自己的管理员账号，总控授予管理员角色 | 管理员能进后台、普通账号被拒 |
| B11 | ★ Owner 操作 | （排在部署并恢复站点之后）正式后台填密钥槽：`openrouter`、`postforme`、`postforme_webhook`（至少 16 位，和 Post for Me 一侧末 4 位一致）、`tikhub`、`parallel`、`firecrawl`、`resend`（付款提醒和止损告警共用）；后台"客服邮箱" `support_email` 填收止损告警和专家预约提醒的邮箱；**注意它也会公开显示**在关于我们、无障碍、博客、维护页等页面，所以要填可以对外公开的客服邮箱（2026-10-26 建库准备核对更正） | 每个槽位显示"后台已填写"（只看状态和末 4 位） |
| B12 | ★ Owner 批准 → 总控 | 主路径设置（第 3.0a 节）：按 **E4 连接池数字 → `core_path_v2.stopLoss` 的 `poolSize`／`p` → 日限 `limitUsd`** 的顺序写 `core_path_v2`（含 `uFastUsd`、`uBigUsd`、`decisionUpperUsd`），再写 `runtime_payg`；每个数字 Owner 当次批准 | 逐项读回，且 `poolSize` ＝ `p` ≥ 正式库实际连接池大小；日限 ≥ 10×B |

### 3.4 部署前：Vercel 正式变量（只对新部署生效）

| # | 谁 | 做什么 | 怎么确认 |
| --- | --- | --- | --- |
| V1 | ★ Owner 操作（新凭证） | 换成新项目：`NEXT_PUBLIC_SUPABASE_URL`、`NEXT_PUBLIC_SUPABASE_ANON_KEY`、`SUPABASE_SERVICE_ROLE_KEY`、`DATABASE_URL`、`EXPECTED_SUPABASE_PROJECT_REF`；Stripe 三件和 P2 的新 webhook 密钥；`OPENING_GRANT_HMAC_KEYS`、`CRON_SECRET`；`GA4_API_SECRET`（可选，GA4 上线后第一周再定，不设不影响业务） | 变量名清单读回（不读值） |
| V2 | ★ Owner 批准 → 总控 | 非密钥：`NEXT_PUBLIC_APP_URL`、`NEXT_PUBLIC_AUTH_APP_URL`＝`https://www.graylum.com`；`APP_ENV` / `NEXT_PUBLIC_APP_ENV`；`V3_RUNTIME_PRODUCTION_PROJECT_ID`、`V3_RUNTIME_PRODUCTION_DATABASE_HOST`、`V3_RUNTIME_PRODUCTION_ENABLED=true`（此时 `stopNewCalls` 开着；CORE-PATH-V2 只保留一条“部署声明的数据库主机必须等于实际连接的主机”的防串库检查，这三个变量在 V2-12 之后是否还要设**未核实**，建库日按当天代码对照）；`STRIPE_CARD_RECONCILIATION_MODE=live`；`PAY_PRODUCTION_CARD_CHECKOUT_ENABLED=true`、`PAY_PRODUCTION_WALLET_CHECKOUT_ENABLED=true`（必须恰好是 `true`，后台付款路由此时仍关）；`NEXT_PUBLIC_HCAPTCHA_SITEKEY`、`NEXT_PUBLIC_TERMLY_WEBSITE_UUID`、`NEXT_PUBLIC_COMPOSER_REFERENCES=on`、资料库三个 `NEXT_PUBLIC_LIBRARY_*` 开关（值照 staging）、`PAYMENT_NOTICE_FROM`、Sentry 几个变量（**`NEXT_PUBLIC_SENTRY_DSN` 必须有**，缺了所有告警静默；Sentry 正式项目要建 error/fatal 的通知规则，上线前做一次合成告警演练，见 [建库准备包](REL-1-BUILD-PREP.md) 第一天告警值守表）。**`SITE_INDEXING` 这时不设成 `public`** | 变量名清单和本行对照 |
| V3 | 总控只读核对 | **不能设**：任何 `V3_RUNTIME_STAGING_*`（设了代码拒绝）、`WAFFO_TEST_*`、`E2E_*`、`LANDING_PREVIEW_FEATURES`、`ANTHROPIC_API_KEY`、`PAYMENT_NOTICE_TEST_RECIPIENTS`、`OPENROUTER_API_KEY`（只从后台槽位读）；也**不要**把 `EXPECTED_APP_HOST` 加进 Vercel——应用运行时不读它，只有本机就绪检查脚本读，总控在本机跑检查时设成 `www.graylum.com` | 变量名清单里没有这些 |
| V4 | ★ Owner 操作 | 删除 Vercel 正式环境里过渡期的旧后备变量和不再需要的 E2E 测试凭证（OR-2 和 T-END 已合并，前提是 B11 的槽位都已填写） | 删除后发布、Webhook、三家搜索和模型调用都正常 |
| M1 | ★ Owner 批准 → 总控 | 把冻结版本从 staging 合并到 `main`（**合并前就要拿到批准**，合并会自动触发正式部署）；Dependency Audit 在 `main` 的 CI 上通过，不新增豁免 | CI 全绿；部署连的是新库；站点仍暂停 |

### 3.5 恢复访问和冒烟日（公众仍被部署访问保护挡住）

| # | 谁 | 做什么 | 怎么确认 |
| --- | --- | --- | --- |
| S-1 | ★ Owner 操作 | Vercel 取消暂停，部署访问保护保持开启 | 正式域名不再是暂停页；未登录公众被挡住 |
| S-2 | ★ Owner 操作 | 域名：先把 `www` 改回直接服务（撤掉到 app 的 307），再把 `graylum.com` 改回 308 → www；这时还不放 `app.graylum.com` → www | 访问 www 不再跳到 app，没有链式跳转 |
| S-3 | ★ Owner 操作 | Vercel 生成冒烟专用的访问保护绕过口令（新凭证），只加在 Stripe 和 Post for Me 的回调地址上（`x-vercel-protection-bypass`） | Stripe 后台测试事件返回成功、错误签名返回 400；看 Vercel 调用记录确认定时任务在保护下照常触发 |
| S-4 | ★ Owner 操作 | S-3 通过后，放 `app.graylum.com` → www 的 308 | 带请求体的 POST 跳转后方法和内容不变 |
| S-5 | 总控 | 受控身份发一条消息：返回"新调用暂停"（不是限流 5xx），Upstash 有读写记录 | 限流连上了 |
| S-6 | ★ Owner 批准 → 总控 | 冒烟窗口内临时关 `stopNewCalls`，结束后立刻重新打开；打开 `card`、`card_cn`、`wechat_pay`、`alipay` 四条付款路由并逐个读回 | 读回 |
| S-7 | 总控 + ★ Owner | 第 4 节冒烟清单逐项做 | 第 4 节记录 |
| S-8 | ★ Owner 操作 | Waffo 应急渠道：正式站能打开后在 Waffo 客服群提交正式审核；审核通过后建 12 个正式一次性商品、填正式密钥、总控写正式映射（channel=waffo、mode=live），**渠道保持 stripe**。审核通过前没有备用渠道（已知、接受） | 映射 12/12；后台切换开关显示当前为 Stripe |

### 3.6 正式 Stripe 商品目录（Owner 亲自操作；脚本 `scripts/stripe-mp-live-catalog.mjs`，[#1113](https://github.com/Crnobog9527/GraylumAI_vercel/pull/1113)）

脚本在 Stripe 正式账号里建商品、价格和首月优惠券（建对象不扣任何人的钱），并打印要在正式库执行的绑定 SQL。
覆盖：银行卡订阅（Pro/Gold 月付年付、创始年付、Gold 首月优惠券）、微信/支付宝一次性会员（六个会员产品、七个价格，含 Gold 首月）、六个会员档积分包。

| # | 谁 | 做什么 | 怎么确认 |
| --- | --- | --- | --- |
| S1 | ★ Owner 操作 | 建一把受限密钥（`rk_live_…`），只开 Products、Prices、Coupons 读写和 Balance/Account 读；只放本机环境变量，不发给任何人 | 密钥权限页读回 |
| S2 | ★ Owner 操作 | `STRIPE_LIVE_SECRET_KEY=… MP_EXPECT_ACCOUNT=acct_… node scripts/stripe-mp-live-catalog.mjs plan`（只读） | 账号是预期的正式账号 |
| S3 | ★ Owner 操作 | `apply` 只建缺的，再跑一次 `plan` | 全部 exists、没有 MISMATCH |
| S4 | ★ Owner 运行；Owner 批准 → 总控执行 | `sql`（会员价格和首月优惠券）、`sql-packs`（积分包）打印绑定 SQL，**只交总控审核，不进仓库** | 建库日 B5 读回 `payment_provider_refs` |
| S5 | ★ Owner 操作 | 用完立刻删除这把受限密钥 | Stripe 后台没有它 |

`apply` 建错的价格不能改金额，要新建并归档旧的，再让总控重新生成 SQL。

### 3.7 公开开放

只有当第 4 节冒烟和同日对账无误、第 1.2 节 12 项 PASS（含标"（正式）"的部分）、备份恢复演练已通过或 Owner 已明确批准延期时才做；任何一项没过，维持冒烟日状态，修好后重新批准，不硬上。

| # | 谁 | 做什么 | 怎么确认 |
| --- | --- | --- | --- |
| O-1 | 总控 | 开放前核对表：第 1.2 节标"（正式）"的部分已通过；资料库清理积压演练（第 1.2 节第 7 项⑥）有 PASS 记录；备份恢复演练（[DATA_ERASURE_BACKUP_RESTORE_REPLAY](../../runbooks/DATA_ERASURE_BACKUP_RESTORE_REPLAY.md)）已通过，或有 Owner 明确批准延期的原话；成本、扣款、平台承担、冻结释放、重复请求没有新派发；告警和停止开关可用；正式库里没有测试数据 | 每项 PASS / FAIL；任何一项不过不开放 |
| O-2 | ★ Owner 批准 → 总控 | 设 `SITE_INDEXING=public` **并重新部署**（构建时读，不重新部署不生效） | `/robots.txt` 放行搜索爬虫、拒绝训练爬虫；首页响应头没有 `X-Robots-Tag: noindex`；登录后页面仍有 noindex |
| O-3 | ★ Owner 操作 | 撤掉部署访问保护；作废 S-3 的绕过口令并从回调地址上去掉 | 公众能打开首页；Stripe 回调仍成功 |
| O-4 | ★ Owner 批准 → 总控 | 关掉 `stopNewCalls`，其他限流保持初始值 | 一个公开测试身份完成一次对话 |
| O-5 | ★ Owner 操作 | Google Search Console、Bing 提交站点和 sitemap | 后台显示已验证 |
| O-6 | 总控 | 记录正式部署地址和编号、Stripe 模式、冒烟结果 | 记录贴在上线 PR |

## 4. 上线当天的冒烟和回滚

### 4.1 冒烟清单（站点在部署访问保护后，只有受控身份能进；金额、笔数和总预算由 Owner 当次批准）

| # | 冒烟什么 | 通过标准 |
| --- | --- | --- |
| K1 | 注册：新邮箱注册（hCaptcha、确认邮件）→ 开户 500 积分 → 登录 → 找回密码；Google 登录一次 | 赠送恰好 500、一条流水；邮件发件人是 `Graylum AI <no-reply@graylum.com>` |
| K2 | 模型调用：一次成功、一次已确认拒绝、一次重复操作、回执对账 | 官方成本、名义费用、实际扣款、平台承担一致；重复请求没有新派发 |
| K3 | 定位第 1 步和一次对标（研究工具真实调用一次） | 对标表出数据；子调用逐条扣费 |
| K4 | 自由对话：@ 一份文档、加载一个写作 Skill、一次对话内研究 | 回答用到文档；Skill 加载；工具行出现 |
| K5 | 文风：上传 1–2 篇本人写的文章 → 学习文风 → 确认 | 一笔按量扣费，没有重复 |
| K6 | 评审团和对比：Gold 身份各一次完整流程并采用（先做对比的"正式模式准入"验证） | 各列之和等于合计；评审采用后报告更新 |
| K7 | 作品复盘和一键发布：页面能开、导入表格、按档位显示；**不做真实对外发布** | 页面按档位显示；名单外平台返回 `PUBLISH_MONITOR_PLATFORM_NOT_OPEN` |
| K8 | ~~真钱付款再退款~~ **已取消（Owner 2026-11-03）**：staging 付款链路全部测通，正式站不测，上线后真实用户订阅出问题再解决。原写法见 Git 历史 | 不再是通过标准 |
| K9 | ~~拒付金额口径用真实一笔对照~~ **随 K8 取消**（它需要真钱付款）。沙盒里争议金额与订单差 1.17（订单 $29 + 税 $1.45）的原因仍是 PAY-DISPUTE-GUARD 的待说清项，不挡上线（Owner 2026-11-03） | 不再是通过标准 |
| K10 | 邮件：付款提醒一封；后台手动运行一次"Runtime 成本与余额告警"检查 | 测试邮箱收到；止损告警进 `support_email`，标题没有 `[staging]` |
| K11 | 每日对账 | 同日对账有成功记录，不是 BLOCKED |
| K12 | TikHub 价格：手工刷新一次（每条最多 7 天有效，过期工具直接不可用）；之后看每日刷新任务有记录 | 价格行未过期 |
| K13 | 首字速度：正式环境 20 次实测并记录（不挡上线） | 记录在上线 PR |

### 4.2 三道刹车（随时可用）

1. **模型出问题**：总控打开 `stopNewCalls`；已冻结的调用按原流程结算，不取消供应商在途请求。也可以写 `runtime_payg_production` 为 `{"enabled":false}`。
2. **付款出问题**：总控关掉 `payment_method_routes` 对应路由；先查 Stripe 实际状态再决定是否重试，不盲目重复收款或退款。
3. **整站出问题**：Owner 在 Vercel 重新暂停项目或重新开启部署访问保护；已收钱的订单保留账务，后续人工处理。

### 4.3 回滚

**触发条件**（出现任一项立即踩刹车）：登录不可用、对话主流程不可用、后台进不去、结账建不了、回调大面积失败、付了钱没到账、
扣费和对账对不上、出现越权访问。

**怎么回滚**：
- 先踩第 4.2 节对应的刹车，保留现场和账务记录，查清实际状态。
- 代码问题：在 staging 修复，走 PR、CI、审查，必要时复验受影响的核心项，再按第 3.4 节 M1 合并到 `main`（重新批准）；
  紧急时 Owner 可以在 Vercel 把正式部署回退到上一次成功的部署（只回代码，不回数据库）。
- 配置问题：Vercel 变量改完要重新部署；`system_settings` 改回后读回。
- 域名循环：回退到上一次的跳转设置，再按"撤 307 → 回调改 www → 放 308"的顺序重来。
- 数据库：正式库没有真实用户之前出问题，可以清空新项目按迁移重建（不影响旧库）；有了真实用户之后，
  需要保留的数据不能用"撤回代码"代替恢复，按 [ENGINEERING](../../ENGINEERING.md) 的恢复要求处理，并先报 Owner。
- 没解决的账务或安全问题不扩大开放。

## 5. 上线后第一周

以 Master Plan 已记录的为准：

| 事项 | 依据 |
| --- | --- |
| 首字速度：用正式环境实测数据做第一件优化（20 次至少 18 次 ≤3 秒；回复结束到整理结果 20 次至少 18 次 ≤10 秒） | 第 2.1 节 2026-10-23（晚） |
| ANALYTICS-POSTHOG：接入 PostHog（美国区），跟随 Termly 同意状态，注销同步删除 | 第 2.1 节 2026-10-21 |
| GA4 方案再定 | 第 2.1 节 2026-10-23（晚） |
| MOBILE-UX：先出方案给 Owner 定稿，属上线后第一批 | 第 2.1 节 2026-10-23 |
| 上线日起 7 天，总控可以只读正式 Sentry 和 Vercel 日志（出事时查原因）；正式数据库仍不读不写；上线前仍不访问正式环境 | 第 2.1 节 2026-10-26（删除每日签到；正式告警邮箱） |
| 观察：成本、错误（Sentry）、未结算项、每日对账；`runtime-recovery` 分钟任务稳定性；每天在后台记一次供应商余额（24 小时后变"未知"会触发告警） | RUNTIME-PROD |
| Waffo 正式审核和正式商品映射（第 3.5 节 S-8）；支付宝最小金额真钱验证另批 | 第 2.1 节 PAY-FAILOVER |
| 一键发布：没有真实发布过的平台盯紧失败率 | 第 7 节 E1 |
| 之后再排：内容对话剩余 7 个 PR、一窗口一选题提醒、整理纪要、新一轮定位沿用对标、MODERATION、CHARGEBACK、I18N-EN、依赖 overrides 清理 | 第 2.1 节、第 7.1 节 |

## 6. Owner 要亲自做或批准的事（可以直接复制）

规则：**每一项批准一句话，只对这一件事、这一个版本有效**（AGENTS 第 1 节）；没回复不等于同意。
金额、版本、日期用 `<…>` 标出的，由总控填实后再发给 Owner；没填实的句子不能当授权。AI 不替 Owner 选数字。
本节所有“同意”都不包含对方没写进句子的其他操作。

**A. 现在就能做（不依赖冻结版本；多数是 Owner 自己点后台）**
1. 我来在 Supabase `Graylum_main` 配好 Resend SMTP、Google 登录回调、hCaptcha、Site URL 和回跳地址。
2. 我来在 Stripe 正式环境建“所有事件”的 webhook 端点，设好重试、账单描述、Stripe Tax 门槛监控，关闭门户“切换套餐”，开通 WeChat Pay 和 Alipay。
3. 我确认 Post for Me 正式独占项目已订阅，Webhook 已指向 `www.graylum.com`，项目里只有正式环境的账号。（Owner 10-26 说已订阅；独占和 Webhook 未核实）
4. 我来自己设 OpenRouter 正式密钥的每日上限、TikHub / Parallel / Firecrawl 硬上限。（建库后的后台止损金额见 C 组）
5. 我来把正式 Sentry、Vercel、Resend 日志和 Supabase 备份的保留期设为不超过 30 天。
6. 我来准备隐私条款里 Post for Me 三件事和 Parallel 训练措辞。
7. 我来按手册第 3.6 节跑 Stripe 正式目录脚本，SQL 交总控审核，用完删除受限密钥。
8. 同意总控只读核验正式环境：Vercel 项目 `graylum-ai-vercel-v1` 的暂停状态和绑定、Supabase `Graylum_main` 的版本、扩展、项目设置和备份设置；不输出密钥。（P9；**在 Owner 说这句话之前，任何人不得访问正式环境，连只读日志也不行**）

**B. 定日期和冻结**
9. 我确认主路径 100 人验收通过。（只有 Owner 本人看过结果后才说；AI 不能替说）
10. 上线日期定为 `<日期>`。（Owner 在 9 之后自己定）
11. 同意 REL-1 冻结版本 `<版本>` 和批准包 `<批准包链接>`。

**C. 建库日（每步之后停下等 Owner 确认）**
12. 同意总控在 `Graylum_main` 按迁移文件从空库建库（迁移到 `<最新号>`），写入正式库标记并读回，导入已核对的配置（套餐、积分包、q=100、m=6、模型和线路、免费套餐每月 0 积分）。
13. 我看过首批创作 Skill `<Skill 列表>` 的样例，同意在正式环境发布这些版本 `<版本>`。
14. 同意总控写入正式准入档案、付款条款版本 `<版本>`、对账起点 `<时间>`、钱包年付标记、Stripe 目录绑定，以及手册第 3.3 节 B6、B7 的限流和功能配置（含运营教练复盘打开），并做 staging 对照的种子配置核对。
15. 同意把正式库的 PostgREST 连接池设成 `<数字>`。（E4；需要 Owner 生成的 Supabase 管理令牌，放本机密钥文件，不进仓库、日志或 PR）
16. 同意总控把正式环境的 `core_path_v2` 设为：连接池大小和 `p` 都是 `<数字>`，每日全站花费上限 `<金额>` 美元，普通回合单轮上界 `<金额>` 美元，大额回合单轮上界 `<金额>` 美元，定位检查上界 `<金额>` 美元。（第 3.0a 节；数字必须满足日限 ≥ 10×预留带，由总控先算好给 Owner 看）
17. 我来在正式后台“成本止损”页填好每用户每日、全站每日、全站告警线、供应商余额告警线的金额：`<金额>`。
18. 同意总控设置 Vercel 正式环境的非密钥变量 `<变量清单>`，并给 `<管理员账号>` 授予管理员角色。
19. 我来在正式后台填好 7 个密钥槽和客服邮箱，并对照 Post for Me Webhook 共享密钥的末 4 位。
20. 同意把 staging `<版本>` 合并到 `main` 并部署正式环境，部署时站点保持暂停、新调用保持关闭。

**D. 冒烟日**
21. 同意恢复正式站 `graylum-ai-vercel-v1` 的访问，部署访问保护保持开启，新调用仍关闭。
22. 我来撤掉 www 到 app 的临时跳转，生成冒烟专用的回调绕过口令，验证通过后放 app 到 www 的 308。
23. 同意冒烟窗口内临时关闭 `stopNewCalls`、打开四条付款路由，冒烟结束后重新打开 `stopNewCalls`。
24. 同意正式小额冒烟：用 `<测试身份>` 调用 `<模型和次数>`，总预算不超过 `<金额>` 美元。
25. ~~同意上线当天真实付款再退款~~ 已取消（Owner 2026-11-03：正式站不做真钱付款测试）。
26. 同意 X 和 YouTube 各真实发布验收一次 `<账号和内容>`。
27. 同意在 staging 用备份恢复功能原地演练一次备份恢复和删除重放。（E2；Owner 2026-11-03 原话：直接用 staging 的备份恢复功能做恢复测试，数据丢了没关系）
28. Waffo 后台的拒付邮件通知已打开。（E5，Owner 亲手做）
29. 我来在 Waffo 提交正式审核；通过后建 12 个正式一次性商品、填正式密钥，渠道保持 Stripe。（S-8，可在上线后）

**E. 公开开放**
30. 同意对账无误后公开开放：关闭“停止新调用”、撤掉部署访问保护，设置 `SITE_INDEXING=public` 并重新部署，核对 robots 和响应头后让搜索引擎收录。
31. 我来删除 Vercel 正式环境里过渡期的旧变量和不再需要的 E2E 测试凭证。

**不用 Owner 做、但必须有人做（总控）**：把 Owner 2026-11-02“运营教练复盘上线时必须开”写进 Master Plan 第 2.1 节（日期、Owner 原话、取代 2026-10-26 条目里隐含保留的“整体先关”例外；按 AGENTS 第 6 节走 PR）；
本手册第 1.1 节第 2 条已按这个决定改写，在第 2.1 节记录合并之前，它的出处只是“总控转达”，不是 Owner 原话。

## 7. 还要 Owner 定的事

| # | 事项 | 推荐 | 可复制 |
| --- | --- | --- | --- |
| E1 | **已定（Owner 2026-10-24：「E1 选 A，七个平台一起开」，见 Master Plan 第 2.1 节）**：名单 tiktok、instagram、youtube、facebook、x、threads、linkedin、pinterest、bluesky 一起开放（TikTok 商业号不开放）；只有 X、YouTube 有测试账号 | 上线前 X、YouTube 各真实发布验收一次（每次 Owner 当次批准）；其余 7 个平台首次真实发布在用户侧，上线首周盯失败率 | 已回复 |
| E2 | **已定（Owner 2026-10-24：「E2 上线前做备份恢复演练」；2026-11-03 改法）**：完整的"恢复备份 → 重放删除"演练按 [DATA_ERASURE_BACKUP_RESTORE_REPLAY](../../runbooks/DATA_ERASURE_BACKUP_RESTORE_REPLAY.md)，仍是公开开放前的门槛，不延期；**Owner 2026-11-03：直接用 staging 的备份恢复功能原地恢复**，取代原来"单独的隔离 Pro 项目"的写法（staging 没有真实用户，数据丢了没关系） | 在 staging 上做，需先告诉总控（staging 写操作） | 「同意在 staging 用备份恢复功能原地演练一次备份恢复和删除重放。」 |
| E3 | **已定（Owner 2026-10-24：「Firecrawl 不开零保留，直接上线」，取代同日先前的"开零保留"）**：Firecrawl 不开零保留，不挡上线 | — | 已回复 |
| E4 | **待办（建库日 Owner 操作，建库日清单第 8 步，要在设置每日花费上限和 `core_path_v2` 之前）：正式库 PostgREST 连接池**（Master Plan 第 2.1 节 2026-10-25（晚））。staging 现在是 8；正式库**上线前要问 Owner**，Owner 同意后才设（需 Owner 生成的 Supabase 管理令牌，放本机密钥文件，不进仓库、日志或 PR）。不设会回到约 20 人就卡。**2026-11-01 的 100 人压测（报告 `result-20261101.md`）是在池 8 上跑的**，新路径正式池该设多少没有单独复测；这个数字还决定 `core_path_v2` 的 `poolSize`／`p` 和日限（第 3.0a 节），所以**必须先于日限确定** | 总控用 100 人压测结果和真实数字问 Owner | 「同意把正式库的 PostgREST 连接池设成 `<数字>`。」 |
| E5 | **待办（建库日 Owner 操作）：Waffo 后台打开拒付邮件通知 `notifyChargeback`**（#1355 的建议）。Owner 亲手在 Waffo 后台做；没打开时拒付只靠我们这边的对账发现 | 上线前做；做完告诉总控 | 「Waffo 后台的拒付邮件通知已打开。」 |

## 8. 旧版（2026-10-17）条目去向

旧版条目编号在 Git 历史里可查。"保留"的条目已并入本文对应位置；"已取代"写明被哪条决定或事实取代。

| 旧条目 | 去向 |
| --- | --- |
| 第 1.3 节、第 6 节第 1 项"10-31 按时上线、10-25 冻结、没验收的功能关开关、10-24 缺口清单一次批" | **已取代**：Owner 2026-10-23（晚）"上线时间可以放宽，核心功能必须要做好才能上线"和"冻结调到 28 号"（Master Plan 第 2.1 节）→ 本文第 1、2 节 |
| 第 3 节倒排时间表、第 3.0 节 P0/P1 两档（Owner 2026-10-19） | **已取代**：同上；P1 里的评审团、对比、发布和复盘已升为核心项 → 第 1.2 节 |
| 第 1.1 节未完成任务清单、第 1.2 节迁移队列 0271–0288、第 7 节待核实汇总 | **已取代**：0271–0342 已上库；任务进度看 `plan-progress`；待上库队列见第 2 节第 1 条 |
| N1 新建项目、N15 备份 | **已完成**（`Graylum_main`，us-west-1，Pro）→ 第 3.0 节；保留期要求并入 P6 |
| N2、N3、B1a、A7 只读核对 | 保留 → P9 |
| N5–N9、C3a Auth 设置 | 保留 → P1 |
| N10 `EXPECTED_APP_HOST` 改为 www 写进 Vercel | **已取代**：按代码核实应用运行时不读，只有本机检查脚本读 → V3 |
| N11、R5 Vercel 变量 | 保留 → V1、V2、V3 |
| N12、C1、C3 密钥槽 | 保留 → B11（`resend` 也供止损告警） |
| N13、D4 回调 | 保留 → P2、P3、S-3；D4 的逐个事件清单**已取代**为"所有事件"（Owner 2026-10-21） |
| N14 管理员账号 | 保留 → B10 |
| R1 正式模型调用、R7 付款入口代码闸门 | **已完成**（0291、#1093、0296–0298）→ 第 3.0 节 |
| R2–R4 | 保留 → B2、B3、B4（B4 补了文风、对比、研究工具的档案要求） |
| R6"评审团、研究工具首版正式环境不可用，研究工具补不上按缺口清单处理" | **已取代**：研究工具是核心项，不能关开关上线；对比的正式路径要在建库后先验证 → 第 1.2 节第 9、11 项 |
| A1 Vercel Pro、A2 定时任务频率、A2a、A5 Upstash | **已完成** → 第 3.0 节；A2 的 24 小时积压演练**没做、保留为门槛** → 第 1.2 节第 7 项⑥ |
| A3 取消暂停、A6 限流、A9 Sentry | 保留 → S-1、B6、第 3.0 节 |
| A4 `main` 依赖漏洞 | 保留 → M1 |
| A8 备份恢复演练"公开开放的前提" | 保留为开放门槛 → 第 3.7 节、O-1；只有 Owner 明确批准才可延期 → 第 7 节 E2 |
| B0 旧库不动 | 保留 → 第 0 节 |
| B1–B3、B5、B6 建库和核对 | 保留 → B1、B3、B9 |
| B2a–B2e 付款配置和种子核对 | 保留 → B5、B8；B2c 旧键 `payment_new_purchase_channel` **已取代**为新键缺省 stripe（[#1277](https://github.com/Crnobog9527/GraylumAI_vercel/pull/1277) 后旧接口也服从新开关） |
| B4 OR-2、C2 删除后备变量 | OR-2 和 T-END **已合并**（#1208）；删除变量保留 → V4 |
| C4 OpenRouter 关训练 | **已完成** → 第 3.0 节 |
| C5、C7 上限 | 保留 → P4；金额由 Owner 自己设（Owner 2026-10-23 晚） |
| C6 Parallel 书面确认、G4 隐私条款 | 保留 → P7 |
| C8 Post for Me 独占项目 | 保留 → P3（Owner 10-26 说已订阅，独占和 Webhook 未核实） |
| C9 向 Post for Me 询问 | 两项已有答复（可以嵌入付费产品；超量不自动升级、要手动升级）；多平台计数未核实 → 第 1.2 节第 10 项 |
| C10 统计 | Termly 已配好；GA4 上线后第一周再定 → V1、第 5 节 |
| C11 E2E 凭证 | 保留 → V4 |
| C12 Firecrawl 零保留 | 保留 → 第 7 节 E3 |
| D1 MP 开通、D8 钱包税务、D10 条款正文、D11 客服邮箱 | **已完成** → 第 3.0 节 |
| D2、2.5 节 Stripe 目录 | 保留 → P8、第 3.6 节 |
| D3、D5、D6 Stripe 设置 | 保留 → P2 |
| D4a 回调绕过口令 | 保留 → S-3 |
| D7、D8a | 保留 → V2、B5 |
| D9 真钱付款退款、H4 小额冒烟 | H4 保留 → 第 4.1 节 K2；D9 真钱付款退款 **已取消**（Owner 2026-11-03，K8） |
| E1 单主机 `/app` 代码 | **已完成**（#1206、#1225）；域名切换顺序保留 → S-2、S-4 |
| E2 撤 307、E3 `SITE_INDEXING`、E4 搜索引擎 | 保留 → S-2、O-2、O-5 |
| F1–F7、F9 功能开关 | 保留 → B7；"没验收就关"的写法**已取代**（核心项不降级） |
| F11 首批创作 Skill 正式版 Owner 看样例单独确认 | 保留 → B3a |
| F8 落地页能力开关核对、H1 能力说法核对 | 保留：冻结版本上由总控逐条对照第 1.2 节验收结果，落地页写到的能力都要已验收 |
| F10 数据使用同意卡片隐藏 | 保留：冻结版本回归时核对 |
| G1–G3 数据保留、MODERATION | G1、G2 已合并；G3 已定上线时暂缓 → 第 1.3 节 |
| H2 全量回归 | **已取代**为第 1.2 节逐项放行标准 + 第 2 节冻结后复验规则 |
| H3 正式准入初始模型 | 保留 → B4 |
| H6 拒付撤回冻结手动 | 保留 → 第 1.2 节第 6 项 |
| 第 4 节上线当天操作顺序 | 保留并展开 → 第 3.3–3.7 节、第 4 节 |
| 第 5 节可复制句 | 更新 → 第 6 节 |

## 9. Master Plan 第 7.1 节任务表里过期的列（2026-11-02 核对，**只记录，没有改**）

范围：只列“依赖”列和“标注”列。我没有改 `docs/launch/MASTER_PLAN.md`——这些改动要么涉及对任务状态的判断，要么属于总控的计划维护（AGENTS 第 6 节），不是纯机械替换。
来源：本次对 7.1 表的逐行阅读，加总控 2026-11-02 核对笔记（二手）。**请总控确认后决定谁来改。**

| 任务行 | 过期的地方 | 现在应该是什么 | 能不能机械替换 |
| --- | --- | --- | --- |
| V3-M3 → REL-1 | 依赖列写“以上全部；PAY-FOUNDER、PAY-NOTIFY、PAY-DISPUTE-GUARD、SKILL-I18N-HOOK、ADMIN-SECRETS”，与 REL-1 的闸门（核心 12 项）口径不一致；表里没有 CORE-PATH-V2 | 依赖应写“核心 12 项（REL-1 第 1.2 节）、CORE-PATH-V2 的 100 人验收和 V2-12” | 不能：要加任务名 |
| 整个 7.1 表 | **没有 CORE-PATH-V2 这个任务行**（`plan-progress.mjs` 只认表里的任务名）；Owner 2026-10-28 的决定未体现在任务表 | 增加 CORE-PATH-V2 行（V2-1…V2-13） | 不能：新增任务行 |
| ANALYTICS-POSTHOG | 依赖列“10-31 上线后第一周开工，冻结前不做” | 上线日已取消 10-31；应改为“上线后第一周（上线日由 Owner 定）” | 可以机械替换日期措辞，但我没动 |
| LOAD-SKILL | 依赖“CHAT-AUTO-CONTEXT C”；总控核对称代码已合并，被标“阻塞”是过期依赖造成 | 看 plan-progress 实际阶段 | 不能：要看 PR |
| EXPERT-CONSULT | 同上：#1060 已合并（0278），staging 有页面，仍显示阻塞 | 同上 | 不能 |
| RUNTIME-PROD | 依赖“④ 按 BILL-PAYG 行提前实施；其余项依赖 AGENT-CORE 稳定”，其中的旧路径部分被 CORE-PATH-V2 取代 | 标注“部分被 CORE-PATH-V2 取代” | 不能：要判断范围 |
| DB-PERF | 依赖 BILL-PAYG、AGENT-CORE；Owner 10-27 的方案（A–F 步）已被 10-28 重做主路径取代，目前验收物是 100 人压测报告 | 依赖和标注应指向 CORE-PATH-V2 | 不能 |
| PUBLISH-MONITOR | 依赖“RESEARCH-TOOLS；Post for Me 实测和条款核对”；内容已是“运营教练复盘”，复盘 RC-2 和 TikHub 读取接主路径的 PR 在途 | 依赖应加 CORE-PATH-V2 | 不能 |
| UI-A | 依赖里仍写 2026-10 的排队约束（与 R8a/R8b 排队），已过期 | 视是否还有在途 UI PR | 不能 |
| VOICE | 依赖列没写 CORE-PATH-V2；文风改接主路径的 PR 在途（总控笔记） | 依赖应加 CORE-PATH-V2 | 不能 |

没有发现可以不经判断直接替换的地方，所以 7.1 表这次一个字都没改。

## 交接

- 2026-11-02：REL-1 现状刷新。只改了 `docs/launch/tasks/REL-1.md`：删除 11-10 冻结／11-15 上线日期，新增第 1.2a（现状）、1.4（上线日期未定）、2.1（迁移到 0471）、3.0a（`core_path_v2`、日限、连接池）、
  第 6 节重排为 31 句可复制的批准话、第 9 节（7.1 表过期列清单）；删除作品复盘的“整体先关”例外；复盘每份成本上限改 1 美元；对比上限改按用户 500 积分。
  没有改任何 Owner 决定、没有改 `AGENTS.md`／`ENGINEERING.md`／`MASTER_PLAN.md`，没有访问正式环境，没有读数据库，没有密钥。
- 下一步：总控确认第 9 节后，决定谁改 7.1 表；总控把 2026-11-02 的“复盘必须开”写进 Master Plan 第 2.1 节；V2-12 合并后重核第 3.0a 节标“未核实”的键名和变量；Owner 验收 100 人压测后定日期。
- 没核实（本次刷新的边界）：① 各迁移在 staging 库是否已应用；② 第 1.2a 节里来自总控笔记的各项核对；③ V2-12 之后 `core_path_v2` 的最终形状、`runtime_payg` 键名、`V3_RUNTIME_PRODUCTION_*` 变量是否保留；
  ④ B6 限流数字是否仍适用；⑤ 正式库连接池该设多少；⑥ 压测报告里“本机到 staging 往返”的解释；⑦ Owner 是否已验收 100 人压测。
- 旧交接（2026-10-24）：按 Owner 要求整体重写；放行条件改为核心 12 项全部验收通过；旧版条目逐条标了去向（第 8 节）。
