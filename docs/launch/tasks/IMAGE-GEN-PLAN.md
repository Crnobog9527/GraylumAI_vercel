# IMAGE-GEN 图片生成：实施方案与模型对比（仅方案）

状态：**仅方案，未批准实施**。2026-11-03 起草（Claude 规划窗口，受总控-15 委托）。本文不改任何代码、配置或数据，也不构成上线、花钱或规则变更的授权。
2026-11-03 总控转述 Owner 对本方案的逐条决定，已改入正文（见 0.1），并记入 `MASTER_PLAN.md` 第 2.1 节；第 13 节的 4 个问题 Owner 也已答复（"全部按推荐"），见 0.2；方案现已无待 Owner 事项。Owner 原话与决定的出处见 `MASTER_PLAN.md` 第 2.1 节
（2026-10-27 "图片生成列为上线后立即开发的核心功能"）和 Owner 2026-11-03 选择"上线后做"（选项 A）。

## 0. 一页总览

**要做的三个入口**（Owner 2026-11-03）：

1. 用户在 Agent 对话里直接让 AI 生图 / 改图。
2. 运营教练的内容步骤（标题 + 封面）里，封面用我们自己的生图功能生成。
3. 对话页左侧导航新增"图片创作"：先看 Owner 精选的模板（按"系列"分组），一键"做同款"，用户可上传自己的照片或产品图。交互照搬 Lovart：点系列弹窗、点"开始制作"自动开一个新的 Agent 对话。

**推荐的做法（一句话）**：不新开一套计费和存储，**把生图当成"一种付费调用"接进现有主路径**——
对话里是一个新的付费工具 `generate_image`（和研究工具同一套 `turn_call_begin → 供应商 → turn_call_record`），
"开始制作"的第一张图走一个新的回合种类 `image`（**在新开的对话里跑，零对话模型调用**），之后的修改都是在这个对话里和 Agent 说、由工具出图；
图片文件放新的私有桶，登记一张新表，注销和删除沿用现有链路；平台模板的封面图放**单独的公开桶**，和用户私有图完全分开。
模型走已经在用的 OpenRouter（不新增密钥），首个模型是 `openai/gpt-image-2.5-flare`（Owner 2026-11-03 指定，不做盲测）。

**Owner 已定的事**见 0.1。**MVP 工期**：约 8 个日历日、3 个并行窗口（第 11 节）。目标 2026-11-25 前在 staging 全部验收；
**合并到 main 和对正式环境开启仍须 Owner 当次同意**（AGENTS.md 第 1 节）。

**还要 Owner 拍板的**：存储容量档位（权益变更，第 13 节）和少数产品细节，其余按已定执行。

**三件必须先说清的事实**（本方案的依据，不是猜测）：

- 现有主路径里**没有任何"图片输出"能力**：模型目录只有按 token 的价格；图片只在一处作为输入（`provider/imageInput.ts`，仅 `library_ocr` 用途）；
  Skill 包只允许 `text/markdown`、`text/yaml` 文件，不能带图片；`runtime_session_results` 全是文字列。（勘察，见第 5 节）
- 运营教练里**没有独立的"标题 + 封面"步骤**：代码里"封面"只是 `short-video-script` 这类文字 Skill 输出的一段文字（"封面字"）。
  所以入口 2 的做法是在成果卡上加"生成封面图"按钮 + 对话工具，而不是改一个现成步骤。
- 生成编号：`gpt-image-2.5-flare` 在 OpenRouter 的**图片接口示例响应里没有生成编号**，只有 `usage` 与 `cost`；
  **对话补全接口的响应里有 `id`（形如 `gen-…`）和 `usage.cost`**。恢复任务靠编号查成本，所以第 0 阶段要先验证：
  能不能用对话补全接口出图并拿到编号；不能就按 2026-11-03 已批准的"无编号满 24 小时自动退还"处理（第 12 节风险 1）。

### 0.1 Owner 2026-11-03 的决定（总控转述，已按此改方案；记录见 `MASTER_PLAN.md` 第 2.1 节）

| # | 决定 | 方案里的落点 |
|---|---|---|
| 1 | 每张图按**成本的 5 倍**收用户积分；图片倍数与对话倍数**分开单独设置**；能同时接多个图片模型，每个模型在后台模型目录里各自配成本和倍数 | 第 4 节、6.2 |
| 2 | **免费用户不能用图片功能**（积分留给定位分析）；只有 Pro / Gold 能用 | 第 4.3 节、6.1、6.2 |
| 3 | 首批 8 个模板按推荐；对用户叫"技能"，但**不必每个都配 Skill**；后台每个模板二选一：**固定提示词**或**调用 Skill** | 第 7 节 |
| 4 | 审核按 **B 档** | 第 8 节 |
| 5 | **不用字节的模型**（去掉 Seedream） | 第 3 节 |
| 6 | **不做盲测**；先用 `gpt-image-2.5-flare`；核实 OpenRouter 的模型 id、价格、参考图编辑、生成编号 | 第 3 节 |
| 7 | 第 6.4 节三处主路径例外：**批准** | 第 6.4 节 |
| 8 | 模板与模板系列要保存**封面图（多图轮播或 GIF）**；平台模板素材放公开桶或 CDN，与用户私有图分开；数据库要有改动 | 第 6.2、7 节 |
| 9 | 交互照搬 Lovart：点系列 → 弹窗，左选系列里的模板，右传参考图、填补充资料和提示词 → "开始制作" → **自动开新 Agent 对话**按模板生成 → 不满意就在这个对话里继续说 | 第 9 节 |
| 10 | 用户存储空间要提高；请给各档容量与理由，**权益变更由 Owner 拍板** | 第 13 节 |

### 0.2 Owner 对第 13 节 4 个问题的答复（总控转述，原话"全部按推荐"）

| 问题 | 结论 |
|---|---|
| ① 存储容量 | **Pro 2 GB、Gold 10 GB，免费档不变**（13.1 的推荐） |
| ② 免费用户界面 | **能看到模板，点"生成"弹出"会员专享"**（4.3、13.2 的默认） |
| ③ 两处检查名单补充 | **批准**：`db-function-closure.mjs` 目录名单加 3 张模板目录表；`erasure-storage` 检查加"不含用户数据的平台桶"清单（公开桶 `image-templates`）。真改时**单独审查** |
| ④ staging 实测 flare | **批准**，花费**不超过 1 美元**，P0 当天做 |

下文 6.4、13.1–13.3 里"待 Owner 批准 / 拍板"的措辞均以本表为准。

## 1. 约束清单（读过的规则，实施时逐条对照）

| 来源 | 约束 | 对图片的含义 |
|---|---|---|
| AGENTS.md §1 | 合并 main、动正式环境、新增密钥、真钱、**规则变更**、新产品决定都要 Owner 点头 | 第 6.4 节三处主路径例外 Owner 已批准；定价（成本 × 5）、仅会员可用已由 Owner 定；上线开关仍须 Owner 当次同意 |
| AGENTS.md §3、§5 | 付费测试只能在已批准预算内；损失线 5 美元；复用现有东西，新表要写理由 | 不做盲测；staging 小额实测（≤ 1 美元）要总控确认在已批预算内；第 6.2 节写新表理由 |
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
| ① 对话里生图 / 改图 | **新付费工具 `generate_image`**，挂在 `chat` 回合上（和 `social_search` 等同一类付费工具） | 用户边聊边要图，模型自己决定何时调用、拿什么参数；工具调用天然带"续轮"，上限和冻结规则已有（2.5.3） |
| ③ 图片创作（点"开始制作"） | **在新开的对话里跑一次新回合种类 `image`**（零对话模型调用）；之后的修改走 ① 的工具 | 固定提示词模板由模板 + 用户填的空 **用代码拼出来**（ENGINEERING §6："能用代码就不用模型"），不需要先花一次对话模型；首轮可预期、便宜 |
| ② 运营教练封面 | **复用 ③ 的 `image` 回合**，入口是成果卡上的"生成封面图"按钮，在当前对话里跑；也可以让教练 Skill 调用 ① 的工具 | 点击即同意扣费，不会在用户不知情时自动花钱；不改教练的回合预算 |

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

> 2026-11-03 Owner 决定：不做盲测，首个模型用 `gpt-image-2.5-flare`，不用字节模型。下面的对比表保留作将来加备用模型的参考，推荐以 3.3 为准。

- 价格单位不统一：有的按张、有的按百万像素、有的按 token。表里"每张价"：**直接标价的写原值；按 token 的按公开单价 × 典型输出 token 估算并标"估"**，第 0 阶段用真实 `usage` 校正。
- **延迟**：没有找到可靠的公开数据，OpenRouter 页面也没给，所以表里不编数字，第 0 阶段实测（P50 / P95）。
- **中文字**：公开基准很少，下表多数是第三方榜单与厂商自述，**可信度低于实测**；推荐也因此定为"暂定 + 盲测复核"。
- 全部候选都能经 OpenRouter 的统一图片接口调用（`POST /api/v1/images`，一个密钥、统一参数、响应带 `usage` 费用）。OpenRouter 全球可用，美国用户无地区问题。

### 3.2 对比表（2026-11-03 查询）

| 模型（OpenRouter id） | 每张价 | 中文字渲染 | 改图 / 参考图 | 可用性与地区 | 内容政策 / 水印 | 商用条款 |
|---|---|---|---|---|---|---|
| **OpenAI GPT Image 2.5 Flare（Owner 指定，首个模型）**（`openai/gpt-image-2.5-flare`） | 输入 $8 / 图片输出 $30 每百万 token；按张价格页面未给，同价位参考 1024² 约 0.006 / 0.05 / 0.21 美元（第三方） | 第三方榜单称 GPT Image 系列中日韩排版强；未做实测 | 参考图最多 16 张，质量档与比例可调，可流式 | OpenAI 为供应商；欧盟区域路由不可用；美国可用 | 审核参数页面未写 | OpenAI 条款，待过目 |
| Google Nano Banana 2.1（`google/gemini-nano-banana-2.1`） | 输入 $1.50/百万 token、图片输出 $30/百万 token；1K 一张**估约 0.04 美元** | 页面没写；同系列 Pro 版被评为"多语言排版出色"（第三方）。**待盲测** | 文生图 + 编辑；`input_references` 最多 14 张；支持遮罩 / 墨迹编辑；1K / 2K / 4K | OpenRouter 上只有 Google AI Studio 一家供应商（单点）；美国可用 | Google 安全过滤；输出带不可见 SynthID 水印（不影响观看） | 第三方称可商用；**以 Google 官方条款为准，待 Owner 过目** |
| Nano Banana 2（`google/gemini-3.1-flash-image`） | 输入 $0.50 / 输出 $60 每百万 token，估约 0.07 美元 | 同上 | 同上 | 同上 | 同上 | 同上 |
| Nano Banana Pro（`google/gemini-3-pro-image`） | 输入 $2 / 输出 $120 每百万 token，估 0.13–0.24 美元 | 页面写"文字渲染业内领先，含长段与多语言排版" | 多图混合、最多保持 5 个主体一致 | 同上 | 同上 | 同上 |
| OpenAI GPT Image 2（`openai/gpt-image-2`）；2.5 Sunburst（质量）/ Flare（速度） | 输入 $8 / 输出 $30 每百万 token；1024² 约低 0.006 / 中 0.05 / 高 0.21 美元（第三方汇总） | 第三方榜单称拉丁字与中日韩排版接近满分，榜单排名第一；**待盲测** | 生成 + 编辑；参考图会加输入 token 费用 | 经 OpenRouter 是否免组织验证**未核实**；直连 OpenAI 需要组织验证；美国可用 | 有 `moderation` 参数，违规返回 400；输出带 C2PA 元数据 | OpenAI 条款：用户对输出有权利（官方条款，待过目）；旧版本号下线日期各来源不一致，需以官方为准 |
| ~~字节 Seedream 5.0 Flash~~（Owner 已排除）（`bytedance-seed/seedream-5-0-flash`） | **从 0.018 美元/张起** | 页面没写；Seedream 2.0/3.0 技术报告强调中英文原生，3.0 报告称中英文字可用率 94%；整体口碑偏中文海报 | 最多 14 张参考图；1K / 2K | OpenRouter 上供应商是字节自己；**图片数据会流向字节**（隐私披露要写） | 字节过滤 | 待查 |
| ~~字节 Seedream 4.5~~（Owner 已排除） | 固定 0.04 美元/张（fal、BytePlus、OpenRouter 一致） | 第三方评"排版扎实" | 编辑端点同价 0.04 | 同上；fal.ai 也有 | 同上 | 待查 |
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

### 3.3 选型（Owner 2026-11-03 指定，不做盲测）

**首个图片模型：`openai/gpt-image-2.5-flare`**（OpenAI，速度档）。2026-11-03 在其 OpenRouter 页面核实到：

| 项 | 核实结果 |
|---|---|
| 模型 id | `openai/gpt-image-2.5-flare` |
| 价格 | OpenAI 供应商：输入 $8/百万 token，图片输出 $30/百万 token；页面说还有 3 项价格未在抓取内容里显示。**按张的价格页面没给**。参考：同价位的 GPT Image 2 在 1024² 下第三方汇总约 低 0.006 / 中 0.05 / 高 0.21 美元；以上线前 staging 实测的 `usage.cost` 为准 |
| 参考图编辑 | 图片接口支持 `input_references`，**最多 16 张**（https 链接或 base64）；也有 `n`（1–10，我们固定 1）、比例（含 `auto`）、质量档（`auto` 至 `max`）、背景、输出压缩、`stream: true` 流式预览 |
| 响应里的费用 | 图片接口返回 `usage`（含 token 数）和 `cost` |
| 生成编号 | **图片接口示例响应里没有**；对话补全接口返回 `id`（如 `gen-abc123`）和 `usage.cost`。该模型能否经对话补全接口输出图片，页面没说，**待验证** |
| 供应商 | 页面只点名 OpenAI，另说还有 3 个供应商未列出；`provider` 路由参数可用 |
| 内容审核参数 | 页面**没写** |
| 延迟、发布日期 | 页面**没写**（接口路径里有 20260908，页面未说明是发布日期） |
| 欧盟区域路由 | 不支持（对美国用户无影响） |
| 组织验证 | 之前写"经 OpenRouter 无需 OpenAI 组织验证"**没有核实**，改为待验证 |

**备选与后续**：目录支持多个图片模型，MVP 只上线一个；没有备用模型，OpenAI 故障时图片功能失败并**全额退款**（确定未扣费类失败）。
将来要加备用 / 便宜档，在后台目录加一行即可（候选：Google Nano Banana 2.1，估约 0.04 美元/张，OpenRouter 上仅 Google 一家供应商；其它见 3.2 表）。
Seedream 已被 Owner 排除；Qwen、混元同属中国厂商，Owner 没提，默认不用，需要时另问。
**备用的使用规则（有备用时）**：只在上一个调用被记为 `not_sent` / `rejected`（确定没扣费）之后，才在同一回合用下一行回执改发备用模型；**结果不明（`unknown`）绝不再发**。

**上线前 staging 实测（取代盲测）**：用最多约 20 张图、预计 ≤ 1 美元（需总控确认在已批准的测试预算内；否则先问 Owner），验证：
① 实际 `usage.cost` 和各比例 / 质量档的 token 数（用来定档位价）；② 能不能拿到生成编号（对话补全 vs 图片接口）；③ 被安全过滤时收不收费；④ 延迟 P50 / P95；⑤ 带中文字的封面是否可用（只看有没有明显错字，不做模型间比较）；⑥ 16 张参考图的实际限制与请求体大小。
结果写进 PR，Owner 不需要参与。

## 4. 计费与止损

沿用现有数学：1 美元 = 100 积分（`credits-per-usd-100`），用户支付 `D = min(N, H)`，`H` 开轮冻结；日限预占走 `holdUsd`。

### 4.1 定价：成本 × 5，图片倍数单独设置（Owner 2026-11-03）

- **用户付的钱 = 供应商实际成本（`usage.cost`）× 图片倍数**，倍数默认 5。积分 = `ceil(q × 成本 × 倍数)`。
- **倍数与对话倍数分开**：现有 `ai_models` 的倍数列是对话用的，不动；图片模型的成本和倍数存在这一行的 `config.image` 里（见 6.2），管理员在后台模型目录里**按模型**配置。
  `routers/modelPricing.ts` 与管理端模型页增加"图片价格"面板；`turnPolicy` 对图片调用传入图片倍数，不碰对话倍数。
- **多个图片模型**：目录里每个图片模型一行，各自的成本表、倍数、并发上限、是否启用；模板或设置里按 `model_key` 选用。
- **冻结与结算**：开轮按"该比例 / 质量档的成本上界 × 倍数"冻足（`H`）；结算按实际成本 `N`，`D = min(N, H)`，多冻的退还。
  GPT Image 的输出 token 数由尺寸和质量档决定，波动小，所以用户看到的价格基本是固定的；界面显示"约 X 积分"，以结算为准。
- **估算（待 staging 实测校正，按第三方 1024² 成本 × 5 × 100 积分/美元）**：

| 质量档 | 成本估 | 用户价（5 倍） |
|---|---|---|
| 低 | 约 0.006 美元 | 约 3 积分 |
| 中（建议"标准"默认） | 约 0.05 美元 | 约 25 积分 |
| 高（建议"高清"） | 约 0.21 美元 | 约 105 积分 |

  这是 Owner 定的倍数下的结果，不是我的建议值；"标准"对应哪个质量档、是否提供"低"档，由实测后定，不另问 Owner（技术细节）。

### 4.2 止损与其它保护

| 项 | 做法 |
|---|---|
| 对话工具 | `generate_image` 是付费工具，`paidToolUpperUsd` 放图片上界；一轮图片次数 ≤ 2（可调），每次一张。`holdCredits` 取"模型 + 最大付费工具"，图片上界通常不超过研究工具，不改冻结公式。 |
| 图片创作回合（`image`） | 开轮冻足（成本上界 × 倍数）；`turn_close` 按交付判定：交付了按实际成本收，被过滤 / 确定没发出 / 供应商明确查无 → 全退。 |
| 日限 | 图片花费计入同一个 `daily_spend`，全站日限 `L` 已罩得住，止损证明不变。额外加两道**不碰数据库**的闸：① 每用户每日张数上限（走现有 Redis 限流器，默认 30，可调）；② 管理员总开关 + 单模型并发上限（目录里的 `concurrency`）。图片单独的日限子桶是可选后续，不进 MVP。 |
| 5 美元损失线 | 偶发的丢图（结果不明且查无）由平台承担，一张约 0.05 美元，在损失线内、记日志；**同一用户反复触发或可被放大利用时按 AGENTS §5 先停该用户再报告**。 |
| 结果不明 | 优先靠供应商编号查成本；拿不到编号时走 2026-11-03 已批准的"无编号满 24 小时自动退还"（迁移 0494），平台承担。 |
| 并发上限 | 图片适配器像模型调用一样先取 Redis 槽位（`image:{model}`），没槽位就记 `not_sent`，不发。 |

### 4.3 谁能用：只有 Pro / Gold（Owner 2026-11-03）

- **权益开关**：`membership_plans` 加一列 `allow_image_generation`（和 `allow_fusion_review` 同一类权益列，`NOT NULL`，Pro / Gold 默认 `true`，free 默认 `false`），后台权益页可改。权益变更的上线仍按"权益"规则走 Owner。
- **三处都要查**：① `planTurnTools`：免费用户的 `generate_image` 被裁剪（新增 `TrimReason = 'not_entitled'`，工具定义字节不变，仍符合 2.9 规则 2）；② `image` 回合的 `turn_open` 拒绝并返回稳定错误码；③ 上传接口和模板接口拒绝免费用户的写入。**不能只靠前端按钮**（ENGINEERING §5）。
- 实际等级沿用 `membershipEntitlements.ts` 的有效等级（退款 / 订阅异常会降为 free，图片功能随之关闭，已生成图片保留可下载）。
- **免费用户在界面上看到什么**（Owner 没说，我的默认，可改）：左侧导航仍显示"图片创作"，点进去能浏览模板与封面图，点"开始制作"弹出现有的"会员专享"弹窗引导升级；对话里让 AI 生图，Agent 回复"图片功能为会员专享"。好处是展示价值、引导转化；若 Owner 想完全隐藏入口，改成按权益隐藏导航项即可。

## 5. 现状勘察摘要（本方案引用的事实）

- 存储：只有两个私有桶（`ticket-attachments`、`library-documents`）；新桶必须有迁移、注销清理路径，且在 `scripts/tests/erasure-storage-buckets.test.mjs` 的 `ERASED_BUCKETS` 与 `CALL_SITES` 两张表登记，代码里禁止建桶。上传路径有两条：工单图走 `apps/web/src/app/api/upload`；资料库走 tRPC 签名直传。
- 资料库：`library_documents.kind` 已有 `image`，但容量由会员档位给，**迁移默认值免费档只有 50 MB（`0153`，实际以后台为准）**；所有图片都是用户上传，没有"生成图"概念。所以生成图不能直接占资料库额度作为默认。
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
| `packages/api/src/services/turn/provider/imageAdapter.ts`（新） | 调 OpenRouter 图片接口 `POST /api/v1/images`，或对话补全接口（P0 验证哪个能拿到生成编号，flare 的对话补全响应有 `id`）；`maxRetries: 0`；解析 `usage.cost`、供应商编号（若有）、图片 base64 / URL；区分 `not_sent`、`rejected`（含安全过滤）、`unknown` |
| `provider/imageEvidence.ts`（新） | 把响应转成回执证据（费用、尺寸、哈希），**不含字节** |
| `services/turn/tools/image.ts`（新） | 对话工具 `generate_image`（参数：prompt、比例、档位、参考图编号数组）；复用 `openToolRow`；一轮上限；模型只看到文字结果（"已生成，编号 X，描述"），**绝不把图片字节喂回模型** |
| `services/turn/tools/index.ts`、`plan.ts`、`types.ts` | 把 `generate_image` 加进 `TurnToolName`、`planTurnTools`（受功能开关、价格、密钥、上限裁剪，原因沿用 `TrimReason`） |
| `services/turn/image.ts`（新） | 新回合种类 `image` 的运行器：校验模板与参数 → 拼提示词（纯代码）→ `turn_open` → 一次付费调用 → `turn_close`；`services/turn/imageHttp.ts` 是 SSE 处理 |
| `packages/api/src/lib/membershipEntitlements` 与 `services/turn/tools/plan.ts` | 读 `allow_image_generation`；免费用户的 `generate_image` 被裁剪（`TrimReason` 加 `'not_entitled'`）；`image` 回合 `turn_open` 拒绝非会员 |
| `services/turn/image.ts` 内的预检 | 用决策调用槽位（`limits.decisions`）对提示词和补充资料做文字预检（第 8 节），平台出钱 |
| `services/turn/policy.ts` | 加 `image` 种类的固定价 `H` 与 `U_turn` 分支；`policy.test.ts` 加用例 |
| `services/turn/quote.ts` | 图片报价（从目录读档位价、供应商价、倍率） |
| `services/turn/settings/*` | 新设置键：`image_gen.enabled`、各档积分、每日张数上限、模型 id（主 / 备）、保留天数 |
| `services/turn/recovery.ts` | 恢复任务认得图片回执：按路径找图、补登记行（6.4 例外 B 的崩溃兜底） |
| `app/api/turn/image/route.ts`（新） | SSE 入口，沿用其他回合路由的鉴权 / 限流 / 维护模式 |
| `packages/db/migrations/NNNN_image_gen_*.sql`（号码向主窗口要） | 见 6.2；改函数一律整段 `CREATE OR REPLACE`，并重新生成 `packages/db/functions/`、`built-fingerprint.json` |
| `packages/db/functions/turn/turn_open.sql`、`turn_close.sql`、`turn_call_begin.sql`（只在需要处）、`turn_recover.sql` | `image` 种类分支；`turn_close` 写登记行 |
| `scripts/check-turn-budget.mjs` | 新增 `image` 种类预算条目（往返 ≤ 6：开轮、begin、identity、record、close、取参考图一次只读）；**不调高既有基线** |

### 6.2 窗口 B：存储、素材、模板、权益、管理端

| 文件 | 改动 |
|---|---|
| 迁移：私有桶 `image-studio` | 私有，10 MB，jpeg / png / webp；路径 `{actor}/in/…`（用户上传的参考图）、`{actor}/out/…`（生成图）。**一个桶两个前缀**，只增加一处注销清理 |
| 迁移：**公开桶 `image-templates`**（Owner 2026-11-03：平台素材与用户私有图分开） | 公开读、仅服务端写；放平台模板与系列的封面图 / GIF（≤ 5 MB，jpeg / png / webp / gif）。**不含任何用户数据，所以不进注销清理**；通过 Supabase 自带的 CDN 出图，不够再加 Vercel 图片优化。注意 `erasure-storage-buckets.test.mjs` 现在要求每个被打开的桶都在 `ERASED_BUCKETS`，需要在测试里**显式新增一个"不含用户数据的平台桶"清单**并写明理由；这等于改一个安全检查，PR 描述要单列，请独立审查确认不是放宽（若被判为放宽则要 Owner 批准） |
| 迁移：表 `image_assets` | 主键带所有者（`actor_id, id`）；列：`kind in/out`、路径、字节数、宽高、MIME、模型、`turn_id`+`seq`、`template_id`、`session_id`、`expires_at`、`saved_library_id`、`deleted_at`。RLS 开、不开放任何角色，只给 `SECURITY DEFINER` 函数。**新表理由**：需要按所有者列表、过期清理、"保存到资料库"、随会话删除，靠 `turn_calls` 的文字列做不到 |
| 迁移：表 `image_template_series`、`image_templates`、`image_template_media`（Owner 2026-11-03：数据库要有改动） | 见下面"模板数据模型"。`FREE_READ_CATALOG` 类全站只读目录，用户读只走 `catalogCache`，**不加所有者列**——需要在 `scripts/db-function-closure.mjs` 的名单里登记（往名单加表要 Owner 批准，请求随本方案一并提出）；RLS 开、不开放任何角色 |
| 迁移：`membership_plans.allow_image_generation` 与容量 | 见 4.3、第 13 节；`library_capacity` 的数值是配置，不用改函数 |
| 迁移：函数 | `image_asset_begin_upload`、`image_asset_complete`、`image_assets_list`（`FREE_READS`：第一个参数 `p_actor_id`，STABLE，只读）、`image_asset_delete`、`image_assets_sweep`（按批 `SKIP LOCKED`，多实例并行）；模板读取走目录缓存，不新增每轮数据库读 |
| 迁移：`runtime_session_results.result_type` | 放宽取值，加 `cover_image`（成果卡上挂封面图） |
| `services/image/storage.ts`（新） | 私有桶唯一的 `storage.from('image-studio')` 调用点；签名上传、批量签名下载、删除 |
| `services/image/templateMedia.ts`（新） | 公开桶的上传（管理员）与公开 URL 生成，**第二个** `storage.from('image-templates')` 调用点；两个调用点都登记进 `CALL_SITES` |
| `services/image/uploadPolicy.ts`（新） | 魔数校验、尺寸上限、**去掉 EXIF（含 GPS）**；GIF 只允许管理员上传到公开桶；是否能在 Vercel 运行时用 `sharp` 在第 0 阶段确认 |
| `services/image/templates.ts`（新） | 读目录缓存、按系列组装、校验补充资料字段、**用代码拼提示词** |
| `services/image/cleanup.ts` + `app/api/cron/image-assets-sweep/route.ts` + `vercel.json` | 每日清理过期对象（输入图 7 天、未保存的生成图 30 天，天数可调）；孤儿对象（有文件无登记行）超过 1 小时对账 |
| `services/accountErasure/storageTransport.ts`、`storage.ts` | 加 `image-studio` 桶的注销清理；`scripts/tests/erasure-storage-buckets.test.mjs` 两张表 |
| `routers/image.ts`（新，薄） | `listSeries`、`getSeries`（含模板与媒体 URL）、`beginUpload`、`completeUpload`、`startFromTemplate`（创建新对话 + 首轮请求）、`myImages`、`deleteImage`、`saveToLibrary`、`signedUrls`；全部先查 `allow_image_generation` |
| `services/library/*` | `saveToLibrary`：把生成图复制进 `library-documents`（`kind='image'`，走现有容量检查） |
| 管理端 `app/(zh-hans)/admin/image/*`（新） | 系列与模板的增删改、上下架、排序、封面媒体上传（多图轮播 / GIF，可排序）、每个模板选"固定提示词 / Skill"、参考图规则与补充资料字段；图片模型、成本、倍数、开关、每日上限 |
| `ai_models.config`（已有 jsonb） | 增加 `modality: 'image'`、`image: { costs: [{size, quality, usd}], multiplier, concurrency }`；对话用的倍数列不动 |

**模板数据模型**（建议，窗口 B 开工第 1 天核对后冻结）：

- `image_template_series(id, name, sort, status, description)`：系列，如"封面系列""产品图系列""内容卡片系列"。
- `image_templates(id, series_id, name, sort, status, mode, prompt_template, skill_module_id, model_key, aspect_ratio, quality_tier, ref_min, ref_max, fields jsonb)`：
  - `mode` ∈ `fixed_prompt` / `skill`（Owner 2026-11-03：后台二选一）；
  - `fixed_prompt`：提示词原文放 `prompt_template`（仅服务端读；公开仓库不放；不返回前端）；
  - `skill`：`skill_module_id` 指向一个已发布的 Skill 模块，提示词原文在私有 `graylum-skills`；
  - `fields`：用户要填的"补充资料"（名称、类型、必填、长度），如产品名、卖点、封面字。
- `image_template_media(id, owner_kind series|template, owner_id, kind image|gif, path, width, height, bytes, sort)`：封面图与效果示例，**多条 = 轮播**，`gif` 单张也行；路径指向公开桶。

### 6.3 窗口 C：前端

| 文件 | 改动 |
|---|---|
| `components/opc/rail-view.tsx`、`workspace-frame.tsx` | `RailArea` 加 `'image'`，加"图片创作"入口 + 图标（`public/opc-reference/`）；免费用户仍显示，点击后见"会员专享"弹窗（4.3） |
| `components/chat-display/fixtures/rail.ts` | 同步落地页的导航夹具 |
| `app/(zh-hans)/app/image/page.tsx`（新） | 系列库：按系列分区、系列卡片（轮播 / GIF 封面）、顶部"我的图片"标签 |
| `components/image/SeriesDialog.tsx`（新） | **Lovart 式弹窗**：左侧是该系列里的模板列表（缩略图 + 名称），右侧是所选模板的"参考图上传 + 补充资料 + 提示词"，底部价格与"开始制作"按钮 |
| `components/image/*`（新） | `SeriesCard`、`MediaCarousel`（含 GIF）、`UploadZone`、`TemplateFields`、`MyImages`；`hooks/use-image-upload.ts`、`use-start-from-template.ts` |
| 对话页（`components/chat/` 与 runtime 页的消息组件，路径开工时确认） | 新增 `image` 消息片段：占位 + 进度 + 结果卡（下载、保存到资料库、"基于这张继续改"）；用模板创建的对话首条消息显示"模板 + 参考图 + 补充资料"摘要 |
| 成果卡（对话右侧成果夹） | 脚本 / 文案卡上加"生成封面图"，在**当前对话**里发起 `image` 回合（模板"封面"，比例随平台）；结果以 `cover_image` 挂在这张成果卡下 |
| `lib/safe-error-message.ts` | 图片相关错误码映射成中文（被过滤、非会员、额度、忙、过期） |
| zh-tw 页面树 | MVP 不做；需要时由 Owner 另定 |

### 6.4 主路径规则的 3 处例外（规则变更；Owner 2026-11-03 已批准，原话"批准"，总控转述）

按修改前的规则审查（AGENTS §1）；实施这三处的 PR 要在描述里引用本批准记录，改 `docs/ENGINEERING.md` 的文字也走同一个批准。

| 编号 | 例外 | 为什么需要 | 把风险压到多小 |
|---|---|---|---|
| A | 允许在 `turn_call_begin` 与 `turn_call_record` 之间做一次对象存储上传（Supabase Storage 会在同一个库里写 `storage.objects`） | 付了钱的图必须在记回执前先落盘；放到 record 之后，崩溃就是"付钱没图" | 只在图片调用里发生，每张一次；预算脚本为 `image` 种类单列并如实计入；不碰任何全站行 |
| B | 允许 `turn_close` 在同一事务里写一行本人的 `image_assets`（仿 2026-10-30 批准的 `kind=mentor` 写 `research_*` 派生行） | 登记行必须和结算同事务，才不会"收了钱没登记" | 只限本人、本回合、一行 |
| C | 新增回合种类 `image` 与它的预算条目 | "开始制作"的第一张图不需要对话模型，没有现成的种类可复用 | 只在 `turn_open` / `turn_close` / `turn_recover` 加分支；不调高旧基线 |

**另两项（Owner 已于 0.2 批准，真改时单独审查）：**① 在 `scripts/db-function-closure.mjs` 名单里登记 3 张模板目录表（"往名单加表要 Owner 批准"）；
② `erasure-storage-buckets.test.mjs` 新增"不含用户数据的平台桶"清单（见 6.2）。

## 7. 模板、系列与 Skill 设计

**目标**：Owner 能挑选、排序、上下架模板；用户点一下就做同款。**对用户统一叫"技能 / Skill"，内部不强求每个都配 Skill**（Owner 2026-11-03）。

- **系列 → 模板 → 媒体**：系列是 Lovart 式的一组风格相近的模板；用户先看系列卡片（轮播或 GIF），点开弹窗再选里面的具体模板。数据模型见 6.2。
- **模板的两种工作方式（后台二选一）**：
  1. **固定提示词**（首批 8 个全部用这种）：提示词原文存在 `image_templates.prompt_template`（数据库私有表，不进公开仓库，不下发到浏览器），含占位符；用户填的"补充资料"和额外提示词由**代码**替换进去并附在末尾；参考图作为 `input_references`。
  2. **调用 Skill**：模板指向一个已发布的 Skill 模块，复杂玩法（多步、需要模型先理解用户需求再出图）用这种；Skill 原文仍在私有 `graylum-skills`，公开仓库只留哈希，`check-no-skill-source.mjs` 保持绿。需要给清单加可选段 `imageTemplate`（`services/skills/workflowManifest.ts` 严格模式要同步改）。**MVP 只实现固定提示词，Skill 模式在后台选项里先做占位并校验，真正执行放 P4**，除非首批 8 个里有模板必须用 Skill（目前没有）。
- **做同款的数据流（固定提示词、零对话模型）**：用户在弹窗里上传 / 填空 → `startFromTemplate` 创建新对话 → 首轮 `image` 回合：服务端按模板**用代码**拼提示词 → 取参考图 → 一次付费调用 → 图片与"模板摘要"一起写入这个对话。之后用户在对话里继续修改，走 `generate_image` 工具（可自动带上上一张图为参考）。
- **安全**：用户填的内容当数据、不当指令；拼接前做长度和字符白名单；固定提示词原文不下发；工具结果里不把原文回给模型之外的任何人。
- **封面媒体**：由管理员在后台上传到公开桶（多图轮播或 GIF，可排序），不再需要随代码部署（取代了之前"缩略图放 public 目录"的 MVP 折中）。
- **版权与风格**："做同款"只复刻**风格和版式**，不复刻某个具体作品、品牌 Logo 或在世人物；每个模板上架前由 Owner 过目，来源记在模板备注里。
- **首批 8 个模板（Owner：按推荐）与系列划分（我的建议，Owner 没指定）**：
  - 封面系列：小红书封面（3:4 大字报）、抖音 / 视频号竖版封面（9:16）、B 站 / YouTube 横版封面（16:9）
  - 产品图系列：产品白底图、产品场景图、产品促销海报（标题 + 卖点，文字 ≤ 12 字）
  - 内容卡片系列：知识卡片 / 金句图、前后对比图（两张参考图）
  - 全部先用"固定提示词"；不含人像类，人像第二批。

## 8. 内容审核（Owner 2026-11-03：按 B 档）

Owner 此前"审核暂缓"，但生图不能零审核；Owner 已选 **B 档**：

| 环节 | 做法 |
|---|---|
| ① 供应商过滤 | 依赖 OpenAI 自带安全过滤（OpenRouter 页面没写审核参数，上线前 staging 实测被过滤时的返回与计费）；被过滤 = 不收费 + 友好提示 |
| ② 提示词与补充资料的文字预检 | 用 CORE-PATH-V2 已有的"决策调用"槽位（`limits.decisions`，平台出钱、不向用户收，像定位检查那样记回执并进 `holdUsd`）调一次便宜的分类模型；**不用直连 OpenAI 审核接口**，那需要新增 OpenAI 密钥（AGENTS §1 要 Owner 批准）。若 Owner 之后愿意新增密钥，免费的 omni-moderation 还能顺便看图 |
| ③ 条款与上传规则 | 只能上传自己或已获授权的人像；禁止生成真实公众人物肖像、未成年人相关不当内容（条款由 Owner 用第三方工具生成） |
| ④ 追溯 | 记录审核结果与提示词哈希 30 天（不存图片以外的内容），用于封号和投诉；投诉 / 下架走现有工单；可封号 |
| ⑤ 其它 | 每用户每日张数上限；管理员总开关；首批模板不含人像（模板本身是 Owner 审过的固定提示词，风险低，风险主要在用户自由提示词与上传图）；用户上传图本身只靠供应商过滤，不做我们自己的图像审核 |

美国用户上传人脸照片的生物特征类州法（如伊利诺伊）披露要求，需 Owner 让律师或第三方工具生成的条款确认——我们不提取人脸特征，只是把照片发给供应商处理（供应商是 OpenAI，经 OpenRouter）。

## 9. 用户流程（三个入口）

**入口 ③ 图片创作（Lovart 式，Owner 2026-11-03）**：
左侧"图片创作" → 系列库（每个系列卡片是轮播或 GIF）→ 点开一个系列，弹出窗口：**左侧**是这个系列里的多个模板（点选），**右侧**是所选模板的"上传参考图（按模板规则 0–N 张）+ 补充资料（模板定义的几个空）+ 额外提示词"，底部显示价格 → 点"**开始制作**" →
系统自动开一个**新的 Agent 对话**（标题用模板名），第一条消息是"模板 + 参考图 + 补充资料"摘要，首轮立刻出图（零对话模型调用）→ 结果满意可下载 / 保存到资料库；
**不满意就在这个对话里继续跟 Agent 说怎么改**，Agent 调用 `generate_image`（默认以上一张图为参考）再出图，每次都按成本 × 5 扣积分，余额不够按现有"暂停等充值"处理。

**入口 ① 对话生图**：用户在任意对话里说"给我画一张……" → Agent 调用 `generate_image` → 消息里出现占位（"生成中，约 X 秒"）→ 图片卡（下载、保存到资料库、"基于这张继续改"、重新生成）。被过滤时给"这个内容不能生成"。用户附带的参考图用输入框的附件上传。

**入口 ② 封面**：运营教练产出脚本 / 文案后，成果卡显示"生成封面图"→ 弹出确认（比例已按平台预选，显示价格）→ 点击即同意扣费 → 在**当前对话**里出 1 张 → 结果挂在这张成果卡下，可"再来一张"。封面字取自成果里的"封面字"字段，用代码拼进提示词。

**免费用户**：能浏览系列库，点"开始制作"或让 AI 生图时见"会员专享"提示，不扣积分（4.3）。

## 10. 测试计划

- **单元**：价格与上界数学（档位 → `callCredits` → `turnPolicy`）、模板拼接（占位符 / 注入 / 长度）、适配器解析（成功、过滤、5xx、断流）、上传校验（魔数、EXIF、尺寸）、清单 `imageTemplate` 严格校验、路径推导、信号量。
- **数据库行为**（本机 Docker）：`image` 种类的开轮冻结 / 交付结算 / 被过滤全退 / 确定没发出全退 / 结果不明保留；`turn_close` 与登记行同事务；重复提交幂等；注销后桶和登记行被清；两次连续执行迁移结构不变；`check-function-patches`、指纹回放。
- **集成**（假供应商，接三层验证第一层 #1680 的故障注入）：崩溃在上传后 / record 前、record 后 / close 前，恢复任务补登记并按规则结算；并发 N 轮不破坏止损；备用模型只在 `not_sent` / `rejected` 之后触发，`unknown` 不触发；图片字节从未出现在 SSE、日志、Sentry。
- **真实模型**（三层验证第二层，发版前在 staging 跑一次）：每次 1 张（约 0.04 美元），查费用、编号、过滤是否收费。
- **浏览器**（AGENTS §4，按 CLAUDE.md 交 Codex 做交互验收，额度用完时 Claude 代做）：三个入口各一遍；允许 / 拒绝（未登录、余额不足、被过滤、上传超大 / 错类型）；移动端；删除对话后图片消失；保存到资料库。验收前先在 PR 贴 `Validation handoff`。
- **权益**：免费用户在工具裁剪、`image` 回合开轮、上传与模板接口三处都被拒（允许 / 拒绝两种都测）；会员降为 free 后已生成图仍可下载。
- **模板**：固定提示词拼接、补充资料校验、Skill 模式占位校验；公开桶里只有平台素材；轮播 / GIF 显示；"开始制作"创建新对话且首轮零对话模型调用。
- **预算与性能**：`check-turn-budget.mjs` 对 `image` 种类的往返；100 人压测加一档"10% 用户生图"；Vercel 函数时长内（staging 300 秒）P95 要有余量。
- **机器可发现**：加一条 CI 检查，禁止 `services/turn/` 下出现对图片供应商的请求在 `turn_call_begin` 之前（沿用现有静态扫描）。

## 11. 分阶段排期

目标：2026-11-15 上线，之后约 11-16 开工，**11-25 前 staging 验收完**（模板系列、素材管理和 Lovart 式弹窗比最初方案多了一块，工期按 8 天算，偏紧）；到 main 另需 Owner 同意。
假设：迁移号和上库由总控窗口接力；3 个并行窗口 A / B / C，互不改同一文件。

| 阶段 | 日期（暂定） | 内容 | 谁 |
|---|---|---|---|
| P0 | 11-16（1 天） | staging 小额实测 flare（≤ 1 美元，第 3.3 节清单）；确认能否拿到生成编号；确认 `sharp` 可用；冻结 API 契约（tRPC 与 SSE 事件）和模板数据模型；向总控要迁移号 | 总控 + 窗口 A |
| P1 | 11-17 至 11-21 | A：适配器（图片接口 / 对话补全二选一）、`generate_image` 工具、`image` 种类、权益检查、决策调用预检、迁移、预算；B：两个桶、`image_assets`、模板三表、权益列、清理任务、注销、管理端（系列 / 模板 / 媒体上传 / 图片模型价格）；C：导航、系列库、Lovart 式弹窗、新对话衔接、消息片段（先接假数据，契约冻结后切真接口） | A / B / C |
| P2 | 11-21 至 11-23 | 联调进 staging（开关默认关）；假供应商故障注入；注销与清理验证；首批 8 个模板入库、传封面 | A + B |
| P3 | 11-23 至 11-25 | 封面入口（成果卡按钮）；真实模型一次；Codex 浏览器验收；独立审查与修改后复核；档位价按实测校准 | C + 总控 |
| P4（不在 MVP） | 11-26 起 | Skill 模式真正执行；zh-tw；第二个图片模型 / 备用；图片日限子桶；自动封面（教练自动调工具）；视频 | 另议 |

人力备注：A 是关键路径（碰主路径、受预算脚本约束、迁移要排队）；若只有 2 个窗口，则管理端的"媒体上传"和"我的图片"页顺延。
**合并顺序**：迁移先由主窗口上库 → 宽容读写的代码合并（开关关）→ 联调 → 打开开关。图片相关迁移不带破坏性变更，新旧代码兼容；回退办法是关开关，桶和表保留数据。

## 12. 风险与待核实

1. **生成编号**（最大风险）。flare 的图片接口示例响应没有编号，对话补全接口有。P0 验证后二选一；都没有则靠"无编号满 24 小时自动退还"，平台承担。
2. **单模型单供应商**：MVP 只有 flare，OpenAI 故障时功能不可用（失败全额退）。缓解：目录支持多模型，随时加备用（3.3）。
3. **中文字质量**：没做模型间对比，只在 staging 看有无明显错字；封面模板提示词里限制"文字不超过 12 字"。
4. **被过滤是否收费**：不收费才能记 `rejected` 全退；收费则改记"用户 0、平台承担"。P0 验证。
5. **定价体感**：成本 × 5 下，"标准"一张约 25 积分（估算，4.1），高清约 105 积分；用户对"一张图要这么多积分"的接受度未验证，上线后看数据；倍数是后台配置，可调。
6. **滥用与成本**：免费用户已排除，主要风险是付费用户高频使用，对策是每日张数上限、全站日限、可封号；"同一用户反复"按 AGENTS §5 先停再报告。
7. **隐私**：用户照片发给 OpenAI（经 OpenRouter）；账号级训练已关；输入图 7 天删除；日志不记提示词原文。
8. **内容责任**：未成年人、真人肖像、版权风格；条款与投诉入口先于上线准备（条款由 Owner 生成）。
9. **函数时长与体积**：生图 10–60 秒，图片 1–4 MB 经函数中转；SSE 要有心跳；超时按"结果不明"走，不重发。图片接口的 16 张参考图 base64 请求体可能很大，需要改传签名 https 链接。
10. **提示缓存**：对话增加一个工具会改变工具定义字节，第一次部署后在途会话的缓存前缀重建一次，成本可忽略，PR 里写明。
11. **公开桶**：封面素材走公开桶，要确认里面没有用户数据、文件名不带个人信息；改安全检查测试的方式需独立审查（6.2）。
12. **工期偏紧**：模板系列 + 素材管理 + 弹窗比最初多一块，8 天里 A 窗口是关键路径，P0 如果发现必须直连 OpenAI 或没有编号，会再多 1–2 天。
13. **计划外**：`docs/launch/MASTER_PLAN.md` 的任务表（第 7.1 节）还没有 `IMAGE-GEN` 一行；本 PR 只在第 2.1 节记 Owner 决定，任务表由总控另开 `docs(plan)` PR 加行。
14. **本方案没验证的**：各模型价格是 2026-11-03 的页面值，会变；flare 的按张价格、延迟、审核参数页面没写；第 3.2 表里其它模型的商用条款原文未核实。

## 13. 原待 Owner 拍板的事（已全部答复，见 0.2）

### 13.1 存储容量（权益变更；Owner 已按推荐拍板：Pro 2 GB、Gold 10 GB、免费不变）

现状：`membership_plans.library_storage_bytes` 的迁移默认值是 **free 50 MB、Pro 500 MB、Gold 2 GB**（`0153`，实际值以后台为准，我没有读 staging 数据）。资料库容量按"上传预占"计，单文件 ≤ 10 MB。

建议（图片功能只给 Pro / Gold，所以免费档不动）：

| 档位 | 现默认 | 建议 | 大约能放 |
|---|---|---|---|
| free | 50 MB | 不变 | 资料库文档，不放图片 |
| Pro | 500 MB | **2 GB** | 约 4000 张压缩后的生成图（按每张 ~0.5 MB） |
| Gold | 2 GB | **10 GB** | 约 20000 张 |

理由：
- 未保存的生成图在**临时区**保留 30 天、不占资料库额度；只有用户点"保存到资料库"的才占。所以额度不用按"每个人生成多少"来算，而是按"用户愿意长期留多少"。
- 生成图建议统一转成 WebP / 高质量 JPEG 存（约 0.3–0.6 MB，原始 PNG 1–3 MB），下载时给用户 PNG 或原图；这能让同样额度放 3–5 倍的图。
- 成本很低：Supabase 存储约 0.021 美元 / GB·月，10 GB 一个 Gold 用户满额也不到 0.25 美元 / 月；图片出网流量走 CDN 缓存和短时签名链接。需要确认 Supabase 套餐的总存储包含量（Pro 套餐含 100 GB，之后按量计）能否撑住预计用户数，这个上线后看真实用量再调。
- 备选 B：Pro 1 GB、Gold 5 GB（更保守）。备选 C：图片单独设一个额度，不和文档共用（实现更复杂，不推荐）。
- 另外建议把"临时区保留天数"也做成后台配置（默认 30 天）。

### 13.2 少量产品细节（我都给了默认，不回复就按默认做）

- **免费用户看到什么**：默认"导航显示、可浏览、点生成见会员专享弹窗"（4.3）。备选：完全隐藏入口。
- **系列划分**：默认按 7 节的 3 个系列（封面 / 产品图 / 内容卡片）；系列名和封面图 Owner 过目。
- **提示词预检用什么**：默认用"决策调用槽位 + 便宜分类模型"，不新增密钥（8 节）；备选是新增直连 OpenAI 的审核密钥（需 Owner 批准）。
- **保留期**：未保存的生成图 30 天、上传的参考图 7 天。

### 13.3 额外批准的两项（Owner 已批准，见 0.2；真改时单独审查）

- 往 `db-function-closure.mjs` 名单加 3 张模板目录表。
- `erasure-storage-buckets.test.mjs` 新增"不含用户数据的平台桶"清单（若被判为放宽安全检查）。

## 14. 不做的事（本方案范围外）

视频生成、批量生成、自动在教练步骤里替用户生成封面（须用户点击同意）、图片编辑器（遮罩画笔等）、对话里"看图"（Agent 理解图片，属 LIB-EXT）、发布排期自动带图、zh-tw、公开分享页。

## 15. 本任务的出处

- `AGENTS.md` §1–§8；`docs/ENGINEERING.md` §3、§5（主路径约束）、§6、§7
- `docs/launch/MASTER_PLAN.md` §2.1（2026-10-27 图片生成列为上线后核心功能；2026-10-10 资料库与发布媒体；2026-11-03 近期决定）、§7.0
- `docs/launch/tasks/CORE-PATH-V2.md` 2.5、2.5.1–2.5.4、2.9
- 代码：`packages/api/src/services/turn/`（`call.ts`、`policy.ts`、`tools/meter.ts`、`tools/types.ts`、`tools/index.ts`、`tools/suppliers.ts`、`provider/`）、`packages/db/functions/turn/`、`packages/api/src/services/accountErasure/`、`scripts/tests/erasure-storage-buckets.test.mjs`、`packages/db/migrations/0203_library_documents.sql`、`apps/web/src/components/opc/rail-view.tsx`、`services/skills/workflowManifest.ts`
- 模型资料：第 3.2 节来源列表
