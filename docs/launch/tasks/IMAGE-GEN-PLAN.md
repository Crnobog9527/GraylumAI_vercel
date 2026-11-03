# IMAGE-GEN 图片生成：实施方案与模型对比（仅方案）

状态：**仅方案，未批准实施**。2026-11-03 起草（Claude 规划窗口，受总控-15 委托）。本文不改任何代码、配置或数据，也不构成上线、花钱或规则变更的授权。
文中带"待 Owner 决定"的项在 Owner 回复前都只是建议。Owner 原话与决定的出处见 `MASTER_PLAN.md` 第 2.1 节
（2026-10-27 "图片生成列为上线后立即开发的核心功能"）和 Owner 2026-11-03 选择"上线后做"（选项 A）。

## 0. 一页总览

**要做的三个入口**（Owner 2026-11-03）：

1. 用户在 Agent 对话里直接让 AI 生图 / 改图。
2. 运营教练的内容步骤（标题 + 封面）里，封面用我们自己的生图功能生成。
3. 对话页左侧导航新增"图片创作"：先看 Owner 精选模板，每个模板由一个打包好的 Skill 支撑，一键"做同款"，用户可上传自己的照片或产品图。

**推荐的做法（一句话）**：不新开一套计费和存储，**把生图当成"一种付费调用"接进现有主路径**——
对话里是一个新的付费工具 `generate_image`（和研究工具同一套 `turn_call_begin → 供应商 → turn_call_record`），
图片创作页走一个新的**固定价回合种类 `image`**（和报告同一类）；图片文件放一个新的私有桶，登记一张新表，注销和删除沿用现有链路。
模型走已经在用的 OpenRouter（不新增密钥），首选 Google Nano Banana 2.1，备选 OpenAI GPT Image 2，最终以上线后第 1 天的 20 条提示词盲测定（第 3 节）。

**MVP 工期**：约 7 个日历日、3 个并行窗口（第 11 节）。目标 2026-11-25 前在 staging 全部验收；**合并到 main 和对正式环境开启仍须 Owner 当次同意**（AGENTS.md 第 1 节）。

**需要 Owner 决定的 4 件事 + 3 件前置**见第 13 节；其中最影响钱和风险的是：每张图多少积分、谁能用、审核到哪一级。

**三件必须先说清的事实**（本方案的依据，不是猜测）：

- 现有主路径里**没有任何"图片输出"能力**：模型目录只有按 token 的价格；图片只在一处作为输入（`provider/imageInput.ts`，仅 `library_ocr` 用途）；
  Skill 包只允许 `text/markdown`、`text/yaml` 文件，不能带图片；`runtime_session_results` 全是文字列。（勘察，见第 5 节引用）
- 运营教练里**没有独立的"标题 + 封面"步骤**：代码里"封面"只是 `short-video-script` 这类文字 Skill 输出的一段文字（"封面字"）。
  所以入口 2 的做法是在成果卡上加"生成封面图"按钮 + 对话工具，而不是改一个现成步骤。
- OpenRouter 的新图片接口响应里**写明了带费用的 `usage`，但页面没提生成编号**（generation id）。
  现有"结果不明的调用靠编号查成本、查无就退"的链路依赖这个编号，**第 0 阶段必须先验证**（第 12 节风险 1）。

## 1. 约束清单（读过的规则，实施时逐条对照）

| 来源 | 约束 | 对图片的含义 |
|---|---|---|
| AGENTS.md §1 | 合并 main、动正式环境、新增密钥、真钱、**规则变更**、新产品决定都要 Owner 点头 | 第 6.4 节列的 3 处主路径例外属于规则变更，实施前要 Owner 批准；上线开关、定价是产品决定 |
| AGENTS.md §3、§5 | 付费测试只能在已批准预算内；损失线 5 美元；复用现有东西，新表要写理由 | 第 0 阶段盲测要 Owner 批预算（建议 15 美元）；第 6.2 节写新表理由 |
| ENGINEERING §5 主路径 | 一轮只有三类写入：`turn_open`、`turn_call_begin/identity/record`、`turn_close`；模型与工具调用之间不得有其他数据库读写 | 图片落盘发生在 begin 与 record 之间，见 6.4 |
| 同上 | 付费调用不重试；只有确定没发出/确定不计费可重试；结果不明交恢复 | 备用模型只能接在"确定没扣费"的失败之后（第 3.3 节），绝不在结果不明时再发一次 |
| 同上 | 冻结 / 日限预占 / 止损 | 图片价格是已知上界，直接进 `holdCredits` / `holdUsd`（第 4 节） |
| 同上 | 全站目录必须走 `catalogCache`；余额等永不缓存 | 图片模型、模板、价格档位读目录缓存 |
| 同上 | staging = 正式，环境差异只能是配置 | 功能开关用 `system_settings`，不写 if(staging) |
| 同上 | `check-turn-budget.mjs` 基线只许变小 | 新增 `image` 种类要新建预算条目，不能调高旧基线（6.4） |
| ENGINEERING §3 | 文件 ≤ 500 行、行宽 ≤ 160 | 第 6 节文件清单按此拆 |
| ENGINEERING §5 迁移 | 号码由主窗口分配；改函数整段 `CREATE OR REPLACE`；迁移与代码上线顺序 | 迁移全部由主窗口先上库后合并（AGENTS §8） |
| DATA-ERASURE | `storage.from` 每个调用点和桶要登记进 `scripts/tests/erasure-storage-buckets.test.mjs` 的两张表；禁止代码里建桶 | 第 6.3 节 |
| Skill 规则 | 公开仓库只放哈希，原文在私有 `graylum-skills`；`check-no-skill-source.mjs` 拦截 | 模板的提示词原文放私有仓库，第 7 节 |
| 2026-10-27 Owner | 图片生成上线后立即做；之后在对话里开放 | 与本方案一致 |
| 2026-10-10 Owner | 发布用的图片/视频由浏览器直传 Post for Me，不进资料库、不占空间；想留存的图片才放资料库 | 生成图默认**临时**保存，用户点"保存到资料库"才占资料库空间（6.3） |
| Owner 审核暂缓 | 审核上线后再定 | 生图不能零审核，至少供应商过滤（第 8 节给选项） |

## 2. 架构：新调用种类还是工具？——两个都要，各管一类入口

| 入口 | 形态 | 为什么 |
|---|---|---|
| ① 对话里生图 / 改图 | **新付费工具 `generate_image`**，挂在 `chat` 回合上（和 `social_search` 等同一类付费工具） | 用户是边聊边要图，模型要自己决定何时调用、拿什么参数；工具调用天然带"续轮"，上限和冻结规则已有（2.5.3） |
| ③ 图片创作页（模板"做同款"、自由生图） | **新回合种类 `image`，固定价**（像 `report`：开轮按价冻足、交付才收、没交付全退），**零模型调用** | 做同款的提示词由模板 + 用户填的几个空 **用代码拼出来**（ENGINEERING §6："能用代码就不用模型"），不需要先花一次对话模型；价格固定用户好懂 |
| ② 运营教练封面 | **复用 ③ 的 `image` 回合**，入口是成果卡上的"生成封面图"按钮，模板为"封面"（比例按目标平台）；也可以让对话里的教练 Skill 调用 ① 的工具 | 点击即同意扣费，不会在用户不知情时自动花钱；不改教练的回合预算 |

### 2.1 为什么不是"只做成工具"或"只做成新种类"

- 只做工具：图片创作页每次要先跑一次对话模型才能调工具，慢、贵、还多一个"模型可能不调用"的失败面。
- 只做新种类：对话里要能自由调用就得让模型选参数，不如工具自然。
- 两者共用同一个**供应商适配器**、**图片存储**、**价格表**、**登记表**，差别只在"谁来发起这一次付费调用"。

### 2.2 一次生图的生命周期（沿用 2.5.2，一步不省）

```
[回合外]  用户上传参考图 → 签名直传 → 服务端校验（魔数、尺寸、去 EXIF）→ 登记 image_assets(kind=in)
turn_open        冻结（image 种类：固定价 H；chat：并入 holdCredits）+ 日限预占 holdUsd
turn_call_begin  callKind='tool', paid=true, toolName='generate_image', upperUsd=U_img   ← 先写，再发
   → 供应商调用（OpenRouter Image API，maxRetries 0）
   → turn_call_identity（若拿得到供应商编号）
   → 收到图片字节 → 上传到私有桶 → 路径 = {actor}/out/{turn_id}-{seq}.{ext}（可由 turn_id+seq 推出，崩溃后能找到）
turn_call_record usage（费用、尺寸、模型）+ 路径；原始响应里**不存图片字节**，只存哈希和路径
turn_close       结算；在同一事务写一行 image_assets(kind=out)（6.4 例外 B）；消息里写图片引用，不写字节
```

规则对应：

- 状态机、`not_sent` / `rejected`（确定没扣费，可重试一次）/ `unknown`（不重试、交恢复）与文字调用完全一致。
- **供应商拒绝（安全过滤）= 确定不计费**，回执记 `rejected`、用户 0 积分、提示"这个内容不能生成，换个说法"。必须确认供应商对"被过滤"不收费（第 0 阶段验证）。
- 图片很大（1–4 MB）：**SSE 事件里不带字节**，只发"生成中 / 完成 + 资源编号"，前端再向接口换短时签名链接。

## 3. 模型对比与推荐

### 3.1 说明

- 价格单位不统一：有的按张、有的按百万像素、有的按 token。表里"每张价"：**直接标价的写原值；按 token 的按公开单价 × 典型输出 token 估算并标"估"**，第 0 阶段用真实 `usage` 校正。
- **延迟**：没有找到可靠的公开数据，OpenRouter 页面也没给，所以表里不编数字，第 0 阶段实测（P50 / P95）。
- **中文字**：公开基准很少，下表多数是第三方榜单与厂商自述，**可信度低于实测**；推荐也因此定为"暂定 + 盲测复核"。
- 全部候选都能经 OpenRouter 的统一图片接口调用（`POST /api/v1/images`，一个密钥、统一参数、响应带 `usage` 费用）。OpenRouter 全球可用，美国用户无地区问题。

### 3.2 对比表（2026-11-03 查询）

| 模型（OpenRouter id） | 每张价 | 中文字渲染 | 改图 / 参考图 | 可用性与地区 | 内容政策 / 水印 | 商用条款 |
|---|---|---|---|---|---|---|
| **Google Nano Banana 2.1**（`google/gemini-nano-banana-2.1`） | 输入 $1.50/百万 token、图片输出 $30/百万 token；1K 一张**估约 0.04 美元** | 页面没写；同系列 Pro 版被评为"多语言排版出色"（第三方）。**待盲测** | 文生图 + 编辑；`input_references` 最多 14 张；支持遮罩 / 墨迹编辑；1K / 2K / 4K | OpenRouter 上只有 Google AI Studio 一家供应商（单点）；美国可用 | Google 安全过滤；输出带不可见 SynthID 水印（不影响观看） | 第三方称可商用；**以 Google 官方条款为准，待 Owner 过目** |
| Nano Banana 2（`google/gemini-3.1-flash-image`） | 输入 $0.50 / 输出 $60 每百万 token，估约 0.07 美元 | 同上 | 同上 | 同上 | 同上 | 同上 |
| Nano Banana Pro（`google/gemini-3-pro-image`） | 输入 $2 / 输出 $120 每百万 token，估 0.13–0.24 美元 | 页面写"文字渲染业内领先，含长段与多语言排版" | 多图混合、最多保持 5 个主体一致 | 同上 | 同上 | 同上 |
| **OpenAI GPT Image 2**（`openai/gpt-image-2`）；2.5 Sunburst（质量）/ Flare（速度） | 输入 $8 / 输出 $30 每百万 token；1024² 约低 0.006 / 中 0.05 / 高 0.21 美元（第三方汇总） | 第三方榜单称拉丁字与中日韩排版接近满分，榜单排名第一；**待盲测** | 生成 + 编辑；参考图会加输入 token 费用 | 经 OpenRouter 无组织验证门槛；直连 OpenAI 需要组织验证；美国可用 | 有 `moderation` 参数，违规返回 400；输出带 C2PA 元数据 | OpenAI 条款：用户对输出有权利（官方条款，待过目）；旧版本号下线日期各来源不一致，需以官方为准 |
| **字节 Seedream 5.0 Flash**（`bytedance-seed/seedream-5-0-flash`） | **从 0.018 美元/张起** | 页面没写；Seedream 2.0/3.0 技术报告强调中英文原生，3.0 报告称中英文字可用率 94%；整体口碑偏中文海报 | 最多 14 张参考图；1K / 2K | OpenRouter 上供应商是字节自己；**图片数据会流向字节**（隐私披露要写） | 字节过滤 | 待查 |
| 字节 Seedream 4.5 | 固定 0.04 美元/张（fal、BytePlus、OpenRouter 一致） | 第三方评"排版扎实" | 编辑端点同价 0.04 | 同上；fal.ai 也有 | 同上 | 待查 |
| 阿里 Qwen Image 2.1 Pro（`qwen/qwen-image-2.1-pro`） | 从 0.046 美元/张起 | 第三方普遍认为中文字最强（Qwen-Image 技术报告专门做了中文字基准）；页面没写 | 最多 4 张参考图；1K / 2K；一次最多 6 张 | 供应商是阿里云国际站；不支持欧盟区内路由 | 阿里过滤 | 待查 |
| 腾讯 Hy Image 3.5 Preview | $1.60/百万 token | 页面明写"图内中英文渲染" | 文生图 / 图生图 / 多轮编辑，最多 20 张参考图，4K | 预览版，稳定性存疑 | 待查 | 待查 |
| Black Forest Labs FLUX 3 Image | 0.041（768）— 0.607 美元（4K）；Klein 0.008 起；FLUX.2 Pro 每百万像素 0.03 | 未见中文承诺 | 支持参考图 | OpenRouter 可用 | 待查 | 待查 |
| Meta Muse Image | 0.01 美元/张 | 页面写"精确的图内文字"，未提中文 | 参考图 / 多图合成 / 迭代编辑 | 可用 | 待查 | 待查 |
| Ideogram | 来源互相矛盾（0.025–0.10 美元），官方价目页抓不到数字 | 未见中文对比数据 | — | 未出现在 OpenRouter 图片列表前列；需直连 | — | — |
| Recraft V4 / V4.1 | 来源矛盾（0.04 与 0.007） | 厂商自称多语言文字清晰；无中文数据 | — | 在 OpenRouter 名单中；有来源称 V4 已停用，需核实 | — | — |

来源（均为 2026-11-03 查得的页面，价格会变）：
[OpenRouter 图片模型列表](https://openrouter.ai/collections/image-models)、
[OpenRouter 统一图片接口](https://openrouter.ai/blog/announcements/image-api/)、
[Nano Banana 2.1](https://openrouter.ai/google/gemini-nano-banana-2.1)、
[Seedream 5.0 Flash](https://openrouter.ai/bytedance-seed/seedream-5-0-flash)、
[Qwen Image 2.1 Pro](https://openrouter.ai/qwen/qwen-image-2.1-pro)、
[FLUX 3 Image](https://openrouter.ai/black-forest-labs/flux-3-image)、
[OpenAI 价格页](https://developers.openai.com/api/docs/pricing)、
[GPT Image 2 价格汇总](https://aireiter.com/blog/gpt-image-2-api-pricing)、
[Seedream 价格指南](https://evolink.ai/blog/seedream-pricing-guide-2026)、
[fal.ai Seedream 4.5](https://fal.ai/models/fal-ai/bytedance/seedream/v4.5/text-to-image)、
[Seedream 2.0 技术报告](https://arxiv.org/html/2503.07703v1)、
[Qwen-Image 技术报告](https://arxiv.org/pdf/2508.02324)、
[文字渲染模型对比（invideo）](https://invideo.io/blog/best-ai-model-text-in-images/)、
[2026 图像模型对比（tech-insider）](https://tech-insider.org/best-ai-image-generator-2026/)、
[Ideogram 价格](https://ideogram.ai/features/api-pricing)、
[Recraft 文档](https://www.recraft.ai/docs/recraft-models/recraft-V4)。
**没查到或不可靠的**：各模型延迟、各厂商商用条款原文、Ideogram 与 Recraft 的现价、Gemini 单张 token 数。这些放进第 0 阶段核对，不拿来当结论。

### 3.3 推荐（暂定，第 0 阶段盲测后定稿）

- **主力：Google Nano Banana 2.1。** 理由：单价低（估约 0.04 美元）、一次最多 14 张参考图、原生编辑，Google 已经是我们在用的供应商（Owner 已选 Claude + Gemini 为主力模型），数据去向与现有隐私披露一致。
  弱点：中文字能力页面无承诺；OpenRouter 上只有一家供应商。
- **备用：OpenAI GPT Image 2（中档质量）。** 理由：不同厂商（Google 故障时不连带）、第三方榜单里字体排版最稳、美国厂商、同样走 OpenRouter 同一个密钥。
  代价：每张更贵（估 0.05 美元），所以只做备用。
- **挑战者（盲测里一并比）：Seedream 5.0 Flash。** 最便宜（0.018 美元起）、中文海报口碑好；但图片数据流向字节，**要 Owner 接受隐私披露**才可作主力。
  若盲测里它在中文字上明显赢，且 Owner 接受，则有两种选择：把它设为"便宜档"让用户可选，或者换成主力。
- **备用怎么用（受主路径规则约束）**：只在上一个调用被记为 `not_sent` 或 `rejected`（确定没扣费，例如限流、供应商 5xx 且无任何字节）时，才用同一回合下一行回执改发备用模型；
  **结果不明（`unknown`）绝不再发**，交恢复任务。备用模型的价格上界要并入本轮的 `holdUsd`。
- **盲测方案（第 0 阶段，约 1 天，预算建议 15 美元，需 Owner 批准）**：20 条提示词 × 4 个模型（Nano Banana 2.1、GPT Image 2、Seedream 5.0 Flash、Qwen Image 2.1 Pro）。
  构成：10 条带中文字的封面 / 海报（标题 4–12 字、含数字和标点）、5 条产品图（传一张实拍图改场景）、3 条人物无关的风格模板、2 条会被过滤的试探（只看过滤是否收费）。
  由 Owner 盲评，每条看"字对不对、像不像想要的、能不能直接用"。同时记录：延迟 P50/P95、实际 `usage` 费用、是否带生成编号、被过滤时收不收费。

## 4. 计费与止损

沿用现有数学：1 美元 = 100 积分（`credits-per-usd-100`），用户支付 `D = min(N, H)`，`H` 开轮冻结；日限预占走 `holdUsd`。

| 项 | 做法 |
|---|---|
| 价格形态 | **按张固定档位**：标准（1K）一档，高清（2K）一档，积分数写在 `system_settings`，管理员可调。用户看到的是"每张 X 积分"。 |
| 内部成本 | 回执里照记真实费用（`usage.cost`），按 `nominal` 规则进账。供应商实际成本低于档位价时，差额是 Graylum 的毛利，**不退用户**；高于档位价时，用户仍只付 `H`，差额进 `platform_absorb`（现有规则，不新增类别）。 |
| 对话工具 | `generate_image` 属于付费工具。`paidToolUpperUsd` 里放图片上界；一轮图片次数 ≤ 2（可调），每次一张。`holdCredits` 取"模型 + 最大付费工具"，图片上界一般不超过研究工具，所以不改冻结公式。 |
| 图片创作回合（`image`） | 固定价，不带 `holdCredits`：开轮冻足（张数 × 档位价）；`turn_close` 按交付判定：交付了收费，被过滤 / 确定没发出 / 供应商明确查无 → 全退。 |
| 日限 | 图片花费计入同一个 `daily_spend`，所以全站日限 `L` 已经罩得住，不用改止损证明。额外加两道**不碰数据库**的闸：① 每用户每日张数上限（走现有 Redis 限流器，默认 30，可调）；② 管理员总开关 + 单模型并发上限（目录里的 `concurrency`）。图片单独的日限子桶作为可选后续，不进 MVP（需要改 `turn_open`/`turn_call_begin`，要先评估）。 |
| 5 美元损失线 | 偶发的丢图（结果不明且查无）由平台承担，一张约 0.04–0.05 美元，在损失线内、记日志人工处理；**同一用户反复触发或可被放大利用时按 AGENTS §5 先停该用户再报告**。 |
| 结果不明 | 优先靠供应商编号查成本；若 OpenRouter 图片接口不给编号，走 2026-11-03 已批准的规则"无编号满 24 小时自动退还"（迁移 0494），平台承担。 |
| 并发上限 | 图片适配器像模型调用一样先取 Redis 槽位（`image:{model}`），没槽位就记 `not_sent`，不发。 |

## 5. 现状勘察摘要（本方案引用的事实）

- 存储：只有两个私有桶（`ticket-attachments`、`library-documents`）；新桶必须有迁移、注销清理路径，且在 `scripts/tests/erasure-storage-buckets.test.mjs` 的 `ERASED_BUCKETS` 与 `CALL_SITES` 两张表登记，代码里禁止建桶。上传路径有两条：工单图走 `apps/web/src/app/api/upload`；资料库走 tRPC 签名直传。
- 资料库：`library_documents.kind` 已有 `image`，但容量由会员档位给，**免费档容量为 0**；所有图片都是用户上传，没有"生成图"概念。所以生成图不能直接占资料库额度作为默认。
- 左侧导航：`apps/web/src/components/opc/rail-view.tsx`（入口：新对话、功能广场、搜索、资料库、发布排期、数据复盘）与 `workspace-frame.tsx` 的 `area` 联合类型；落地页夹具 `components/chat-display/fixtures/rail.ts` 渲染同样的结构；`/app/*` 的登录校验在 `proxy.ts`，新路由不用改白名单；还有 zh-tw 页面树，未检查。
- 成果：`runtime_session_results`（自由对话成果夹）和 `opc_content_versions` 都是文字列，没有图片类型；`result_type` 有取值检查。
- Skill：表为 `skills` / `skill_revisions` / `skill_packages` / `skill_package_files`（只允许 markdown、yaml，单文件 ≤ 2 MiB）；清单 `workflowManifest.ts` 是严格模式（`kind` 只有 `document`、`social`），没有图片字段；模型绑定在 `modules.model_id` 上，不在 Skill 上；`modules` 就是功能广场里的条目。
- 模型目录：`ai_models` 只有按 token 的价格，`config` 是 jsonb；`catalogCache` 按 `catalog_versions` 失效，由 `runtime_rw_v2.catalogCache` 开关控制。
- 主路径：`services/turn/tools/meter.ts` 的 `openToolRow` / `paidToolCall` 就是付费工具的样板（begin → 供应商 → settle），`call.ts` 是模型调用样板；`policy.ts` 的 `turnPolicy` 算冻结和上界。

## 6. 逐文件改动清单

（路径是建议位置，开工第 1 天由各窗口核对。每个文件 ≤ 500 行。）

### 6.1 窗口 A：回合、适配器、计费（后端主路径）

| 文件 | 改动 |
|---|---|
| `packages/api/src/services/turn/provider/imageAdapter.ts`（新） | 调 `POST /api/v1/images`；`maxRetries: 0`；解析 `usage.cost`、供应商编号（若有）、图片 base64 / URL；区分 `not_sent`、`rejected`（含安全过滤）、`unknown` |
| `provider/imageEvidence.ts`（新） | 把响应转成回执证据（费用、尺寸、哈希），**不含字节** |
| `services/turn/tools/image.ts`（新） | 对话工具 `generate_image`（参数：prompt、比例、档位、参考图编号数组）；复用 `openToolRow`；一轮上限；模型只看到文字结果（"已生成，编号 X，描述"），**绝不把图片字节喂回模型** |
| `services/turn/tools/index.ts`、`plan.ts`、`types.ts` | 把 `generate_image` 加进 `TurnToolName`、`planTurnTools`（受功能开关、价格、密钥、上限裁剪，原因沿用 `TrimReason`） |
| `services/turn/image.ts`（新） | 新回合种类 `image` 的运行器：校验模板与参数 → 拼提示词（纯代码）→ `turn_open` → 一次付费调用 → `turn_close`；`services/turn/imageHttp.ts` 是 SSE 处理 |
| `services/turn/policy.ts` | 加 `image` 种类的固定价 `H` 与 `U_turn` 分支；`policy.test.ts` 加用例 |
| `services/turn/quote.ts` | 图片报价（从目录读档位价、供应商价、倍率） |
| `services/turn/settings/*` | 新设置键：`image_gen.enabled`、各档积分、每日张数上限、模型 id（主 / 备）、保留天数 |
| `services/turn/recovery.ts` | 恢复任务认得图片回执：按路径找图、补登记行（6.4 例外 B 的崩溃兜底） |
| `app/api/turn/image/route.ts`（新） | SSE 入口，沿用其他回合路由的鉴权 / 限流 / 维护模式 |
| `packages/db/migrations/NNNN_image_gen_*.sql`（号码向主窗口要） | 见 6.2；改函数一律整段 `CREATE OR REPLACE`，并重新生成 `packages/db/functions/`、`built-fingerprint.json` |
| `packages/db/functions/turn/turn_open.sql`、`turn_close.sql`、`turn_call_begin.sql`（只在需要处）、`turn_recover.sql` | `image` 种类分支；`turn_close` 写登记行 |
| `scripts/check-turn-budget.mjs` | 新增 `image` 种类预算条目（往返 ≤ 6：开轮、begin、identity、record、close、取参考图一次只读）；**不调高既有基线** |

### 6.2 窗口 B：存储、素材、模板、Skill、管理端

| 文件 | 改动 |
|---|---|
| 迁移：桶 `image-studio` | 私有，10 MB，jpeg / png / webp；路径 `{actor}/in/…`（用户上传的参考图）、`{actor}/out/…`（生成图）。**一个桶两个前缀**，只增加一处注销清理 |
| 迁移：表 `image_assets` | 主键带所有者（`actor_id, id`）；列：`kind in/out`、路径、字节数、宽高、MIME、模型、`turn_id`+`seq`、`template_id`、`expires_at`、`saved_library_id`、`deleted_at`。RLS 开、不开放任何角色，只给 `SECURITY DEFINER` 函数；**新表理由**：需要按所有者列表、过期清理、"保存到资料库"和下架，靠 `turn_calls` 的文字列做不到。更精简的备选：把引用写进 `session_messages.content`、不建表，但"我的图片"页、过期清扫和删除会话时清文件都要解析消息内容，不推荐。 |
| 迁移：函数 | `image_asset_begin_upload`、`image_asset_complete`（`FREE_READS`：第一个参数 `p_actor_id`，STABLE，只读）、`image_assets_list`（FREE_READ）、`image_asset_delete`、`image_assets_sweep`（按批 `SKIP LOCKED`，多实例并行） |
| `modules` 表扩展（或新目录表，二选一，第 0 阶段定） | 给"模板"加可空 `image_template` jsonb（排序、分类、缩略图路径、档位、是否需要上传、需要填的空）；**优先扩展 `modules`**，复用管理端发布流水线与 `catalogCache` 的 `skills` 版本组，避免新表。`runtime.choices`、功能广场的列表要排除 `image_template` 模块 |
| `services/skills/workflowManifest.ts` | 清单加可选段 `imageTemplate`（提示词模板文件名、参数、比例、参考图个数、槽位）和 `kind: 'image'`；严格模式要同步改；管理端 `module-skill-editor.tsx` 与发布校验同步 |
| `services/image/storage.ts`（新） | 仅此一个 `storage.from('image-studio')` 调用点（登记进 `CALL_SITES`）；签名上传、批量签名下载、删除 |
| `services/image/uploadPolicy.ts`（新） | 魔数校验、尺寸上限、**去掉 EXIF（含 GPS）**；是否能在 Vercel 运行时用 `sharp` 在第 0 阶段确认 |
| `services/image/cleanup.ts` + `app/api/cron/image-assets-sweep/route.ts` + `vercel.json` | 每日清理过期对象（输入图 7 天、未保存的生成图 30 天，天数可调）；孤儿对象（有文件无登记行）超过 1 小时对账 |
| `services/accountErasure/storageTransport.ts`、`storage.ts` | 加 `image-studio` 桶的注销清理；`scripts/tests/erasure-storage-buckets.test.mjs` 两张表 |
| `routers/image.ts`（新，薄） | `listTemplates`、`getTemplate`、`beginUpload`、`completeUpload`、`myImages`、`deleteImage`、`saveToLibrary`、`signedUrls` |
| `services/library/*` | `saveToLibrary`：把生成图复制进 `library-documents`（`kind='image'`，走现有容量检查）；免费档容量为 0 时给出"升级后可保存" |
| 管理端 `app/(zh-hans)/admin/image/*`（新，MVP 最小） | 模板上下架 / 排序 / 档位；模型与价格 / 开关；不做缩略图上传（见第 7 节） |
| `ai_models.config`（已有 jsonb） | 增加 `modality: 'image'`、`unit: 'image'`、`flatUsd`、档位表；`routers/modelPricing.ts` 与管理端模型页增加图片价格编辑（不改 token 价格列） |

### 6.3 窗口 C：前端

| 文件 | 改动 |
|---|---|
| `components/opc/rail-view.tsx`、`workspace-frame.tsx` | `RailArea` 加 `'image'`，加"图片创作"入口 + 图标（`public/opc-reference/`） |
| `components/chat-display/fixtures/rail.ts` | 同步落地页的导航夹具 |
| `app/(zh-hans)/app/image/page.tsx`（新） | 模板库：分类筛选、卡片网格（缩略图 + 名称 + 价格）、顶部"自由创作"入口、"我的图片"标签 |
| `app/(zh-hans)/app/image/[templateId]/page.tsx`（新） | 做同款：上传区（可选，多张）、模板要填的空、比例、档位与价格、"生成"、结果区（下载、再来一张、保存到资料库、发到发布排期） |
| `components/image/*`（新） | `TemplateGallery`、`TemplateCard`、`TemplateRunner`、`UploadZone`、`ImageResultCard`、`MyImages`；`hooks/use-image-turn.ts`（SSE）、`use-image-upload.ts` |
| 对话消息渲染（`components/chat/` 与 runtime 页的消息组件，路径开工时确认） | 新增 `image` 消息片段：占位 + 进度 + 结果卡（下载、保存、"用这张继续改"） |
| 成果卡（对话右侧成果夹） | 脚本 / 文案卡上加"生成封面图"，调用 `image` 回合（模板"封面"，比例随平台）；成果夹新增 `cover_image` 结果类型需要迁移放宽 `result_type` 取值 |
| `lib/safe-error-message.ts` | 图片相关错误码映射成中文（被过滤、额度、忙、过期） |
| zh-tw 页面树 | MVP 不做；需要时由 Owner 另定 |

### 6.4 主路径规则的 3 处例外（规则变更，**实施前要 Owner 批准**，按修改前的规则审）

| 编号 | 例外 | 为什么需要 | 把风险压到多小 |
|---|---|---|---|
| A | 允许在 `turn_call_begin` 与 `turn_call_record` 之间做一次对象存储上传（Supabase Storage 会在同一个库里写 `storage.objects`） | 付了钱的图必须在记回执前先落盘；放到 record 之后，崩溃就是"付钱没图" | 只在图片调用里发生，每张一次；预算脚本为 `image` 种类单列并如实计入；不碰任何全站行 |
| B | 允许 `turn_close` 在同一事务里写一行本人的 `image_assets`（仿 2026-10-30 批准的 `kind=mentor` 写 `research_*` 派生行） | 登记行必须和结算同事务，才不会"收了钱没登记" | 只限本人、本回合、一行 |
| C | 新增回合种类 `image` 与它的预算条目 | 固定价回合没有现成的种类可复用 | 只在 `turn_open` / `turn_close` / `turn_recover` 加分支；不调高旧基线 |

## 7. 模板与 Skill 设计

**目标**：每个模板"由一个打包的 Skill 支撑"，Owner 能挑选、排序、上下架，用户点一下就做同款。

- **一个模板 = 一个目录型 Skill 包 + 一条 `modules` 目录记录。**
  - Skill 包（放进私有 `graylum-skills`，公开仓库只留哈希；`check-no-skill-source.mjs` 保持绿）里有：
    `SKILL.md`（给人和审核者看的说明）、`template.yaml`（提示词模板、参数、比例、参考图规则、需要用户填的空、负面约束）。
    清单的 `kind: 'image'` 与 `imageTemplate` 段由本任务新增并通过严格校验。
  - 目录记录（`modules.image_template` jsonb）：分类、排序、缩略图路径、档位、是否需要上传、上架状态。
- **做同款的数据流（零模型）**：用户上传 / 填空 → 服务端按 `template.yaml` **用代码**替换占位符拼成提示词 → 取参考图 → 一次付费调用。
  用户填的内容当数据、不当指令；拼接前做长度和字符白名单；模板里的"风格描述"不暴露给前端（防抄）。
- **为什么不让模型润色提示词**：多花一次对话模型、结果更不稳定；需要"AI 帮我写提示词"时走对话里的 `generate_image`（入口 ①），那里模型本来就在场。
- **缩略图（MVP 取舍）**：Skill 包不能带二进制，所以首批模板的缩略图和"效果示例"放 `apps/web/public/image-templates/`（Owner 精选的营销图，本来就该公开），**上新模板要走一次部署**；
  上线后再做"管理员上传缩略图 + 公开桶"。这条是产品便利和复杂度的取舍，不影响用户使用。
- **版权与风格**："做同款"只能复刻**风格和版式**，不能复刻某个具体作品、品牌 Logo 或在世人物形象；每个模板上架前由 Owner 过目，来源记在包里的 `SKILL.md`。
- **管理端 MVP**：模板列表（上下架、排序、档位）、模型与价格、总开关、每日上限；新模板内容仍通过现有 Skill 发布流水线上传。

## 8. 内容审核（Owner 此前"审核暂缓"；生图不能零审核）

| 档位 | 内容 | 成本 / 代价 | 风险 |
|---|---|---|---|
| **A 最低**（底线） | 只靠供应商自带安全过滤；被过滤 = 不收费 + 友好提示；加每用户每日张数上限、管理员总开关、可被封号 | 0 | 对"真人照片被改成不当图"没有我们自己的一道防线；出事靠投诉后处理 |
| **B 推荐** | A + ① 提示词文本先过免费的审核接口（OpenAI omni-moderation，同样可看图）；② 用户上传的真人照片在条款里写明"只能用自己或已获授权的人像"，且模板库首批不放人像类；③ 记录审核结果与提示词哈希 30 天（不存原文图片以外的内容），用于封号与投诉处理 | 额外一次免费调用 + 约 200 ms；**把用户提示词（和图）送给 OpenAI 这个新的处理方，需在隐私条款里披露（条款由 Owner 用第三方工具生成）** | 仍可能漏判，但可追溯 |
| **C 严格** | B + 生成后再用视觉模型看一遍输出 | 每张多一次视觉调用（约 0.003–0.01 美元）和 1–3 秒 | 误伤率高、延迟明显；除非出现滥用事件，不建议 MVP 做 |

另外无论哪档：禁止"生成真实公众人物的肖像"类提示（交给供应商 + 条款）；投诉 / 下架入口走现有工单；
对美国用户上传人脸照片，需 Owner 让律师或第三方工具生成的条款确认生物特征类州法（如伊利诺伊）的披露要求——我们不提取人脸特征，只是把照片发给供应商处理。

## 9. 用户流程（三个入口）

**入口 ① 对话生图**：用户说"给我画一张……" → 教练 / 自由对话调用 `generate_image` → 消息里出现占位（"生成中，约 X 秒"）→ 图片卡（下载、保存到资料库、"基于这张继续改"、重新生成）。
余额不够时按现有"暂停等充值"流程；被过滤时给"这个内容不能生成"。用户附带的参考图用输入框的附件上传（受上传规则约束）。

**入口 ② 封面**：运营教练产出脚本 / 文案后，成果卡显示"生成封面图"→ 弹出确认（比例已按平台预选，显示价格）→ 点击即同意扣费 → 生成 1 张 → 结果挂在这张成果卡下，可"再来一张"。封面字取自成果里的"封面字"字段，用代码拼进提示词。

**入口 ③ 图片创作**：左侧"图片创作" → 模板库 → 点模板 → 上传自己的图（可跳过）+ 填几个空 → 看到价格 → 生成 → 结果页（下载 / 再来一张 / 保存 / 发到发布排期）。顶部另有"自由创作"（文字描述 + 可选参考图），作用等同对话里的工具。

## 10. 测试计划

- **单元**：价格与上界数学（档位 → `callCredits` → `turnPolicy`）、模板拼接（占位符 / 注入 / 长度）、适配器解析（成功、过滤、5xx、断流）、上传校验（魔数、EXIF、尺寸）、清单 `imageTemplate` 严格校验、路径推导、信号量。
- **数据库行为**（本机 Docker）：`image` 种类的开轮冻结 / 交付结算 / 被过滤全退 / 确定没发出全退 / 结果不明保留；`turn_close` 与登记行同事务；重复提交幂等；注销后桶和登记行被清；两次连续执行迁移结构不变；`check-function-patches`、指纹回放。
- **集成**（假供应商，接三层验证第一层 #1680 的故障注入）：崩溃在上传后 / record 前、record 后 / close 前，恢复任务补登记并按规则结算；并发 N 轮不破坏止损；备用模型只在 `not_sent` / `rejected` 之后触发，`unknown` 不触发；图片字节从未出现在 SSE、日志、Sentry。
- **真实模型**（三层验证第二层，发版前在 staging 跑一次）：每次 1 张（约 0.04 美元），查费用、编号、过滤是否收费。
- **浏览器**（AGENTS §4，按 CLAUDE.md 交 Codex 做交互验收，额度用完时 Claude 代做）：三个入口各一遍；允许 / 拒绝（未登录、余额不足、被过滤、上传超大 / 错类型）；移动端；删除对话后图片消失；保存到资料库。验收前先在 PR 贴 `Validation handoff`。
- **预算与性能**：`check-turn-budget.mjs` 对 `image` 种类的往返；100 人压测加一档"10% 用户生图"；Vercel 函数时长内（staging 300 秒）P95 要有余量。
- **机器可发现**：加一条 CI 检查，禁止 `services/turn/` 下出现对图片供应商的请求在 `turn_call_begin` 之前（沿用现有静态扫描）。

## 11. 分阶段排期

目标：2026-11-15 上线，之后约 11-16 开工，**11-25 前 staging 验收完**；到 main 另需 Owner 同意。
假设：迁移号和上库由总控-15 的窗口接力；3 个并行窗口 A / B / C，互不改同一文件。

| 阶段 | 日期（暂定） | 内容 | 谁 |
|---|---|---|---|
| P0 | 11-16 至 11-17 | 盲测（15 美元预算）；验证 OpenRouter 图片接口：是否有生成编号、被过滤是否收费、延迟；确认 `sharp` 可用；定扩展 `modules` 还是新目录表；Owner 批准 6.4 三处例外；**冻结 API 契约（tRPC 与 SSE 事件）** | 总控 + 窗口 A |
| P1 | 11-17 至 11-21 | A：适配器、`generate_image` 工具、`image` 种类、迁移、预算；B：桶、`image_assets`、清单扩展、清理任务、注销、管理端；C：导航、模板库页、做同款页、消息片段（先接假数据，契约冻结后切真接口） | A / B / C |
| P2 | 11-21 至 11-23 | 联调进 staging（开关默认关）；假供应商故障注入；注销与清理验证；首批 6–8 个模板入库 | A + B |
| P3 | 11-23 至 11-25 | 封面入口（成果卡按钮）；真实模型一次；Codex 浏览器验收；独立审查与修改后复核；价格与档位按盲测校准 | C + 总控 |
| P4（不在 MVP） | 11-26 起 | 管理员上传缩略图 + 公开桶；zh-tw；单模型选择；图片日限子桶；自动封面（教练自动调工具）；视频 | 另议 |

人力备注：A 是关键路径（碰主路径、受预算脚本约束、迁移要排队）；若只有 2 个窗口，则 B 的管理端和 C 的"我的图片"页顺延到 P4。
**合并顺序**：迁移先由主窗口上库 → 宽容读写的代码合并（开关关）→ 联调 → 打开开关。图片相关迁移不带破坏性变更，所以新旧代码兼容；回退办法是关开关，桶和表保留数据（Owner 已确认 staging 数据可丢弃，正式库新建）。

## 12. 风险与待核实

1. **OpenRouter 图片接口是否给生成编号**（最大风险）。没有的话，结果不明的图只能靠"无编号满 24 小时自动退还"规则，平台承担；若频繁，需要直连 Google / OpenAI 或加自己的对账。P0 第一项验证。
2. **中文字质量**：公开数据弱，推荐是暂定。盲测输了就换主力；产品上可以先给封面模板设"文字少于 12 字"的提示。
3. **供应商被过滤是否收费**：不收费才能记 `rejected` 全退；收费则要改记为"用户 0、平台承担"。P0 验证。
4. **滥用与成本**：一个用户一天生很多张、或批量注册薅开户赠送积分。对策：每日张数上限、免费账号限制（第 13 节 D2）、全站日限已有；仍留意"同一用户反复"按 AGENTS §5 停掉再报告。
5. **隐私**：用户照片发给第三方供应商。账号级训练已关（OpenRouter）；Seedream / Qwen 的数据去向在中国厂商，选用前要披露；存储里的输入图 7 天删除；日志不记提示词原文以外的内容。
6. **内容责任**：未成年人、真人肖像、版权风格；条款与投诉入口先于上线准备（条款由 Owner 生成）。
7. **函数时长与体积**：生图 10–60 秒，图片 1–4 MB 经函数中转；SSE 要有心跳；超时按"结果不明"走，不重发。
8. **提示缓存**：对话增加一个工具会改变工具定义字节，第一次部署后所有在途会话的缓存前缀会重建一次，成本可忽略但要在 PR 里写明。
9. **单点**：Nano Banana 在 OpenRouter 只有 Google 一家；故障时靠备用模型（第 3.3 节）。
10. **规则变更**：第 6.4 节三处例外，没批准就不能实施。
11. **计划外**：`docs/launch/MASTER_PLAN.md` 的任务表（第 7.1 节）还没有 `IMAGE-GEN` 一行；Owner 批准本方案后由总控另开 `docs(plan)` PR 加行和决定记录（本 PR 不动 Master Plan）。
12. **本方案没验证的**：所有模型价格是 2026-11-03 的页面值，会变；Gemini 单张 token 数、各家商用条款原文、延迟，均未核实。

## 13. 需要 Owner 决定的事（每项都有推荐）

**前置（不批准就不能开始）**

- **P-1 盲测预算**：建议 15 美元（OpenRouter 现有账号和密钥，不新增密钥）。
- **P-2 主路径三处例外**（第 6.4 节）：规则变更，需要 Owner 批准。
- **P-3 数据去向**：如果盲测里字节系 / 阿里系模型赢，Owner 是否接受用户图片发给中国厂商。推荐：**不接受作主力**，最多作用户可选的"便宜档"并披露。

**D1 每张图多少积分？**

- 推荐 **标准（1K）每张 8 积分，高清（2K）每张 16 积分**：成本约 0.04 / 0.08 美元，按现有倍率（具体倍率由管理员定）留约一倍毛利，且用户好懂。
- 备选：6 / 12（更便宜，毛利薄，备用模型更贵时可能倒挂）。
- 说明：盲测后用真实 `usage` 复核，再回给 Owner 定稿。

**D2 谁能用？**

- 推荐 **A：所有登录用户都能用，按积分付费；免费账号只能用开户赠送的积分，不能上传人像类参考图；Pro / Gold 无额外限制。** 免费也能用才有传播效果，成本由开户赠送积分封顶。
- 备选 B：只对 Pro / Gold 开放，免费用户只能看模板库不能生成（更稳，转化路径更清楚，但没有试用）。

**D3 首批模板清单（推荐 8 个，先不放人像）**

1. 小红书封面（3:4，大字报）
2. 抖音 / 视频号竖版封面（9:16）
3. B 站 / YouTube 横版封面（16:9）
4. 产品白底图（上传实拍图 → 干净白底）
5. 产品场景图（上传实拍图 → 生活场景）
6. 产品促销海报（带标题和卖点，文字 ≤ 12 字）
7. 知识卡片 / 金句图（1:1 或 3:4）
8. 前后对比图（上传两张图 → 对比版式）

人像 / 形象照类模板放第二批，等审核档位和条款到位。每个模板的名称、缩略图和风格由 Owner 过目。

**D4 内容审核到哪一级？**

- 推荐 **B**（供应商过滤 + 提示词过免费审核接口 + 条款约束 + 日上限 + 可封号，第 8 节）。
- 最低可接受：A，但要接受"出事后处理"。
- 不建议 MVP 做 C。

**保留期（顺带确认）**：未保存的生成图 30 天、上传的参考图 7 天；用户点"保存到资料库"才长期保留并占资料库空间。推荐沿用。

## 14. 不做的事（本方案范围外）

视频生成、批量生成、自动在教练步骤里替用户生成封面（须用户点击同意）、图片编辑器（遮罩画笔等）、对话里"看图"（Agent 理解图片，属 LIB-EXT）、发布排期自动带图、zh-tw、公开分享页。

## 15. 本任务的出处

- `AGENTS.md` §1–§8；`docs/ENGINEERING.md` §3、§5（主路径约束）、§6、§7
- `docs/launch/MASTER_PLAN.md` §2.1（2026-10-27 图片生成列为上线后核心功能；2026-10-10 资料库与发布媒体；2026-11-03 近期决定）、§7.0
- `docs/launch/tasks/CORE-PATH-V2.md` 2.5、2.5.1–2.5.4、2.9
- 代码：`packages/api/src/services/turn/`（`call.ts`、`policy.ts`、`tools/meter.ts`、`tools/types.ts`、`tools/index.ts`、`tools/suppliers.ts`、`provider/`）、`packages/db/functions/turn/`、`packages/api/src/services/accountErasure/`、`scripts/tests/erasure-storage-buckets.test.mjs`、`packages/db/migrations/0203_library_documents.sql`、`apps/web/src/components/opc/rail-view.tsx`、`services/skills/workflowManifest.ts`
- 模型资料：第 3.2 节来源列表
