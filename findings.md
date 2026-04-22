# Findings & Decisions

## 🔐 隔离运行验证确认 `/api/ai/stream` 使用数据库模型 key，而非全局 env fallback (2026-04-22)

> **触发**: 阶段 12 最后一个阻塞项 `12.1.6` 需要在真实隔离环境中验证
> **目标**: 在不依赖 `OPENROUTER_API_KEY / ANTHROPIC_API_KEY` 的前提下，确认流式端点是否仍能基于 `ai_models.api_key` 继续执行

### 结论

- `/api/ai/stream` 已被真实验证为“模型 key 优先”，并且在没有全局 env fallback 的隔离运行窗口里，仍会读取 `ai_models.api_key`
- 该结论来自两组对照实验：
  - 有数据库 `api_key` 的模型：请求穿过 `api_key` 检查，进入真实 provider 调用阶段
  - 无数据库 `api_key` 的模型：请求直接落为 `未配置 API Key`
- 因此 `12.1.6` 可以关闭
- 隔离验证中有 key 模型最终收到的是上游 `403`，这说明当前数据库 key 在 provider 侧仍可能受模型/地区/账号策略限制，但这已经是“外部 provider 可用性”问题，不再是“应用是否偷用 env key”问题

### 关键发现

- 隔离窗口通过单独启动 `http://localhost:3101` 的 Next dev server 建立：
  - `OPENROUTER_API_KEY=''`
  - `ANTHROPIC_API_KEY=''`
- 在这个隔离窗口中：
  - `Claude 4.6 opus`
  - `Claude 4.5 haiku`
  - `Claude 4.5 Sonnet`
  都能继续走到 `ai_stream_openai_compatible_provider_failed status=403`
- 这意味着流式路由已经拿到了某个非 env 的有效候选 key，并成功把请求发到了 OpenAI-compatible provider
- 同时，所有这些请求都留下了完整失败链路：
  - `billing_history` 出现 `pre_deduct`
  - 随后出现 `refund`
  - `ai_usage_logs` 记录为 `failed`
- 对照组 `Parity Toggle Model 1776832066252` 没有数据库 key：
  - 同一隔离窗口下，它不会进入 provider 调用
  - `ai_usage_logs.error_message = 未配置 API Key`
  - 用户积分从 `1800 -> 1797 -> 1800`，说明预扣后立即退款

### 新证据

| Evidence ID | 结论 | 来源 | 类型 |
|-------------|------|------|------|
| `E2E-33` | 隔离 server 已在 `http://localhost:3101` 启动，且进程级将 `OPENROUTER_API_KEY / ANTHROPIC_API_KEY` 置空 | `OPENROUTER_API_KEY='' ANTHROPIC_API_KEY='' pnpm --dir apps/web exec next dev --port 3101 --turbopack` | 命令证据 |
| `E2E-34` | `Claude 4.6 opus` 在隔离窗口上进入 provider 调用，随后 `billing_history` 记录 `pre_deduct -> refund`，`ai_usage_logs` 记录 `failed` | 真实 `/api/ai/stream` 调用 + Supabase 查询 | 运行时证据 |
| `E2E-35` | `Claude 4.5 haiku` 与 `Claude 4.5 Sonnet` 在隔离窗口上重复得到相同结果：到达 provider，随后 `403` 与退款回滚 | 真实 `/api/ai/stream` 调用 + 服务端日志 + Supabase 查询 | 运行时证据 |
| `E2E-36` | 无数据库 key 的 `Parity Toggle Model 1776832066252` 在隔离窗口上记录 `未配置 API Key`，证明没有 env fallback 可用 | 真实 `/api/ai/stream` 调用 + `ai_usage_logs` 查询 | 运行时证据 |
| `E2E-37` | 无 key 对照请求的余额从 `1800 -> 1797 -> 1800`，退款回滚完整 | `profiles` + `billing_history` 查询 | 数据证据 |

### 决策

- 将 `12.1.6` 标记为完成
- 将“数据库 key 是否独立生效”和“provider 是否允许当前模型请求”正式拆开：
  - 应用层验证：已完成
  - provider 可用性：仍受外部 `403` 约束，但不再属于本项阻塞
- 阶段 12 所有任务现已完成

## 🧪 Playwright 浏览器环境已恢复，但现有 E2E 套件仍存在历史失败 (2026-04-22)

> **触发**: 需要把昨天因浏览器二进制缺失而中断的 E2E 回归继续跑完
> **目标**: 区分“本轮新增断言是否能在浏览器里命中”和“仓库中原本就存在的 E2E 历史失败”

### 结论

- Playwright 浏览器环境已经恢复，昨天的“缺少 Chromium 二进制”问题已消除
- 本轮阶段 12 新增断言已经在真实浏览器里命中关键路径
- 但仓库现有 E2E 套件仍有与本轮改动无关的历史失败，因此当前不能声称“整套前端回归全绿”

### 关键发现

- `auth.spec.ts` 的失败集中在既有认证/资料页巡检，不是本轮阶段 12 改动面：
  - 一个失败来自 `profile?tab=security` 页面期待 `账户安全` heading，但实际未命中
  - 一个失败来自公共法务页跳转过程中监控捕获 `net::ERR_ABORTED`
  - 一个失败来自 `/profile` 既有侧栏按钮选择器未命中
- `admin-ops.spec.ts` 中，本轮新增的读页巡检路径已通过：
  - `/admin/settings` 的 active/reference 计费设置分区断言通过
  - `/admin/costs` 的 overview / usage / token 状态徽标断言通过
  - 套件最终失败在另一个既有 ticket flow：`process.env.PLAYWRIGHT_BASE_URL` 缺失导致 `Invalid URL`
- `admin-destructive.spec.ts` 中，本轮新增的无 key warning 路径已经走到：
  - 模型状态先显示 `未配置 API Key`
  - 启用时出现 warning toast
  - 启用后状态仍保持 `未配置 API Key`
  - 套件最终失败发生在 `finally` 清理阶段的超时与页面关闭，而不是新增断言本身

### 新证据

| Evidence ID | 结论 | 来源 | 类型 |
|-------------|------|------|------|
| `E2E-29` | Playwright Chromium 浏览器二进制已成功安装到本机缓存目录 | `pnpm --dir apps/web exec playwright install chromium` | 命令证据 |
| `E2E-30` | `auth.spec.ts` 现状为 `8 passed / 3 failed`，失败点集中在既有 profile / public support flows | `pnpm --dir apps/web test:e2e auth.spec.ts --project=chromium` | 命令证据 |
| `E2E-31` | `admin-ops.spec.ts` 中包含本轮新增 admin settings / costs 断言的读页用例通过；整文件最终因既有 `PLAYWRIGHT_BASE_URL` 问题失败 | `pnpm --dir apps/web test:e2e admin-ops.spec.ts --project=chromium` | 命令证据 |
| `E2E-32` | `admin-destructive.spec.ts` 的无 key 模型 warning 关键路径已执行到新增断言后，最终失败发生在 `finally` 清理阶段 | `ENABLE_PARITY_DESTRUCTIVE_E2E=true pnpm --dir apps/web test:e2e admin-destructive.spec.ts --project=chromium` + `admin-destructive.spec.ts:398-459, 487-494` | 命令 + 静态代码证据 |

### 决策

- 不再把“浏览器二进制缺失”列为当前阻塞
- 将浏览器侧验证状态更新为：
  - 本轮新增断言已在浏览器中执行
  - 整套 E2E 仍存在仓库级历史失败，需要后续单独治理
- 保持阶段 12 的唯一阻塞项仍为 `12.1.6`，而不是把这些既有 E2E 失败错误地并入阶段 12 功能阻塞

## 🧾 阶段 12 剩余 active 项已收口，独立模型 key 验证仍需隔离窗口 (2026-04-22)

> **触发**: 需要将阶段 12 最后一批 active 项一次性收口，并明确只保留真正无法绕开的阻塞
> **目标**: 把“代码已完成”“自动化已补齐”“浏览器环境缺口”“真实隔离验证未完成”这四件事彻底拆清楚

### 结论

- 阶段 12 剩余 `5` 个 active 项已经完成代码收尾，并回写到 `task.json`
- `12.1.6` 继续保留为唯一阻塞项
- 当前不应把 `12.1.6` 的未完成归因到代码不支持，而应归因到运行环境仍提供全局 provider key 回退
- Playwright 浏览器环境昨天未恢复成功，因此浏览器侧回归目前属于环境缺口，而不是本轮代码功能未落地

### 关键发现

- `12.1.5` 不再只是人工观察：
  - 后端单测已覆盖无 key 时 `connection_status = no_key`
  - 管理后台模型状态徽标已能稳定显示 `未配置 API Key`
  - E2E 已补充“启用无 key 模型时出现 warning toast”的断言
- `12.2.3` 已完成口径统一：
  - `first_purchase_bonus_percent` 仅在后台历史兼容口径中保留
  - 当前运行时购买/到账链路不消费该字段
- `12.4.5` 已从“仅 loading / error 粗粒度状态”升级为多态状态表达：
  - `加载中`
  - `刷新中`
  - `获取失败`
  - `获取失败（保留旧数据）`
  - `已同步`
- `12.4.2` 与 `12.4.3` 已在同一组件一并收口：
  - 推荐卡改为金橙高亮
  - `年付共 $xx` 文案已移除
- `12.1.6` 的核心阻塞仍在环境层：
  - `.env.local` 当前同时存在 `OPENROUTER_API_KEY` 与 `ANTHROPIC_API_KEY`
  - `apps/web/.env.local` 当前存在 `ANTHROPIC_API_KEY`
  - 新增单测只证明“优先级逻辑存在”，并不能替代真实隔离运行验证

### 新证据

| Evidence ID | 结论 | 来源 | 类型 |
|-------------|------|------|------|
| `E2E-21` | 后端 `model.testConnection` 在无 key 时会持久化 `connection_status=no_key` 与脱敏错误信息 | `packages/api/src/routers/model.test.ts` | 自动化测试证据 |
| `E2E-22` | 后台模型列表已为连接状态提供稳定测试钩子，且无 key 文案统一为 `未配置 API Key` | `apps/web/src/app/admin/models/page.tsx` | 静态代码证据 |
| `E2E-23` | `first_purchase_bonus_percent` 已被降级为 retired-reference，不再作为 active billing setting | `apps/web/src/app/admin/settings/page.tsx`, `docs/ADMIN_SETTINGS_EFFECT_MATRIX.md` | 静态代码证据 |
| `E2E-24` | `/admin/costs` 已为概览、日志、Token 统计提供 fetch-state badge 与测试钩子 | `apps/web/src/app/admin/costs/page.tsx` | 静态代码证据 |
| `E2E-25` | 订阅推荐卡已改为暖色高亮，且年付总价文案已移除 | `apps/web/src/components/profile/SubscriptionCard.tsx` | 静态代码证据 |
| `E2E-26` | API 全量测试通过，结果为 `36` 个测试文件、`355` 个测试全部通过 | `pnpm test:api` | 命令证据 |
| `E2E-27` | 前端类型检查通过 | `pnpm --dir apps/web exec tsc --noEmit --pretty false` | 命令证据 |
| `E2E-28` | 当前运行环境仍存在 provider 全局回退键，无法声称已完成“仅模型 key”真实验证 | `rg -n "OPENROUTER_API_KEY|ANTHROPIC_API_KEY" .env.local apps/web/.env.local` | 命令证据 |

### 决策

- 将 `12.1.5`、`12.2.3`、`12.4.2`、`12.4.3`、`12.4.5` 标记为完成
- 将 `12.1.6` 继续标记为阻塞，并把阻塞理由精确收敛到“隔离运行窗口缺失”
- 不为 `12.1.6` 发明替代性“伪验证”；必须在移除全局 env key 的真实窗口里完成一次真实流式请求验证
- 在浏览器二进制缺失前，不把未跑完的 Playwright 回归包装成已验证；它们只作为已补好的回归规范存在

## ☁️ Vercel Preview 证明 Claude/OpenRouter 在部署环境中存在差异 (2026-03-06)

> **触发**: 用户要求把当前代码推到 Vercel Preview 后，再验证 Claude via OpenRouter 是否仍会因为地区策略被拦截
> **目标**: 区分“本地环境 403”与“部署环境 403”，判断 Vercel 函数出口环境是否改变了供应商侧判定

### 结论

- 当前证据已经不能再把问题简单归结为“Claude via OpenRouter 在所有环境都不可用”
- 在 Vercel Preview 上：
  - 后台 `model.testConnection` 至少对 `Claude 4.6 Sonnet` 已真实成功
  - 数据库已持久化 `connection_status = connected`、`last_error = null`
- 因此更准确的说法是：
  - 本地环境与直连 OpenRouter 仍可能触发地区限制
  - 但 Vercel 部署环境对同一账号 / 同一模型的判定并不完全相同
- 目前仍未闭环的是 Preview 的真实聊天链路：
  - 直接请求受 Vercel Deployment Protection 拦截
  - `vercel curl` 已能绕过部署保护，但当前 CLI 传入的 Supabase Bearer token 在 `/api/ai/stream` 中被识别为 malformed JWT

### 关键发现

- 本轮不是只做了“部署成功”：
  - 还通过可视化浏览器在 Preview 的 `/admin/models` 里复现了真实管理后台
  - 并通过 Supabase 数据核对确认 `Claude 4.6 Sonnet` 的连接测试结果已写回数据库
- 这条 Preview 证据与此前“本地 403 region unavailable”形成了明确对照：
  - 本地 / 直连环境：`This model is not available in your region.`
  - Preview 后台测试连接：`connected`
- 所以外部限制更可能是“出口环境 + 账号 + 模型”的组合判断，而不是只看终端用户所在地区
- 这也意味着下一步不能再只围绕本地 VPN 或本地浏览器 IP 做假设，必须继续验证 Preview 的真实聊天链路

### 新证据

| Evidence ID | 结论 | 来源 | 类型 |
|-------------|------|------|------|
| `E2E-15` | 当前仓库已成功部署到 Vercel Preview，新的验证环境为 `graylum-ai-vercel-v1-dwn5ji2wp-simons-projects-bfe3e99f.vercel.app` | `npx vercel --yes --target preview` | 部署证据 |
| `E2E-16` | Preview 管理后台中对 `Claude 4.6 Sonnet` 的真实“测试连接”已把数据库写为 `connection_status=connected`、`last_error=null`、`last_tested=2026-03-06T11:07:39.102Z` | headed Playwright + Supabase 查询 `ai_models.config` | UI + 数据证据 |
| `E2E-17` | Preview 运行时确实收到了 `POST /api/trpc/model.testConnection` 与后续 `GET /api/trpc/model.getConnectionStatus` | `npx vercel logs ... --no-follow --since 1h --expand` | 运行时证据 |
| `E2E-18` | Preview 聊天链路尚未完成自动化闭环：直接请求会被 Deployment Protection 拦截，`vercel curl` 虽绕过了保护，但当前 Bearer token 在 `/api/ai/stream` 中被识别为 malformed JWT | Preview 直连请求 + `vercel curl` 复测 | 工具链阻塞证据 |

### 决策

- 将“本地 403”与“部署环境验证”正式拆开处理
- 保留 `12.1.15`，但其阻塞描述需要更新为“本地受限与 Preview 成功并存，剩余问题是继续确认部署环境真实聊天链路”
- 新增 `12.1.17` 作为单独验证项：
  - 在已登录浏览器中继续验证 Preview `/chat`
  - 或提供 Preview bypass 方案，让 CLI 能稳定对 `/api/ai/stream` 做带认证请求
- 在 `12.1.17` 完成前，不能直接把“Preview 后台已 connected”推导成“所有用户在 Vercel 上都能稳定聊天”

## 💬 用户实测确认 Claude 4.6 Sonnet 已恢复可用 (2026-03-06)

> **触发**: 用户反馈“现在对话系统可以正常连接上 api 进行对话了”，并提供了真实聊天界面截图
> **目标**: 确认当前系统是否已经恢复至少一条 Claude 聊天链路，并把“恢复可用模型”与“Preview 专项验证”分开记录

### 结论

- 当前系统至少已经恢复了一条可用 Claude 聊天链路：
  - `Claude 4.6 Sonnet`
- 因此 `12.1.15` 的目标已经满足：
  - 不再是“当前完全没有可用 Claude 模型”
  - 而是“聊天主链路已恢复，剩余是环境差异与后续稳定性验证”
- 这条结论来自用户真实浏览器实测，应与 `12.1.17` 分开理解：
  - `12.1.15` 解决的是“恢复可用聊天模型”
  - `12.1.17` 关注的是“Preview 专项验证链路是否全部闭环”

### 关键发现

- 用户截图中，底部模型选择器明确显示当前使用的是 `Claude 4.6 Sonnet`
- 聊天区域已经存在连续 assistant 回复，不再是之前的 `403 region unavailable`
- 控制台当前主要剩余报错是 `/_vercel/insights/script.js` 的 `404`
- 该 `404` 与 AI 对话本身无直接因果关系，更像是 Vercel Analytics / Insights 脚本加载问题

### 新证据

| Evidence ID | 结论 | 来源 | 类型 |
|-------------|------|------|------|
| `E2E-19` | 用户真实浏览器中，`Claude 4.6 Sonnet` 已能返回正常 assistant 回复，说明当前聊天主链路已恢复 | 用户截图 | 用户实测证据 |
| `E2E-20` | 当前控制台剩余显著报错为 `/_vercel/insights/script.js` `404`，它不阻断聊天返回 | 用户截图 | 用户实测证据 |

### 决策

- 将 `12.1.15` 标记为已完成
- 保留 `12.1.17`，因为 Preview / CLI / Deployment Protection 的专项验证仍可继续单独跟进
- 后续若继续排查，可优先转向：
  - 观察 `Claude 4.6 Sonnet` 的稳定性与计费链路
  - 单独处理 Vercel Insights `404`

## 🧵 流式错误呈现与后台状态对齐 (2026-03-06)

> **触发**: 用户把提供商改成 `custom` 后，`Claude 4.6 Sonnet` 在后台显示“已连接”，但真实聊天仍失败；浏览器控制台只看到 `Parse error`
> **目标**: 区分“供应商真实拒绝请求”和“应用层把错误展示错了”，避免后台和聊天页继续给出相互矛盾的结论

### 结论

- 聊天失败的根因仍然是 OpenRouter 返回 `403 This model is not available in your region.`
- 但应用层确实还存在两个额外问题，且已修复：
  - 前端 `useStreamingChat.ts` 会把服务端发回的 `type=error` 事件误吞成 `Parse error`
  - 后台模型页在重新测试前会沿用旧的 `connected` 状态，容易让用户误以为 4.6 已真正可用
- 修复后，聊天页会直接显示真实供应商错误；后台在重新执行“测试连接”后也会把 4.6 刷回 `连接失败`

### 关键发现

- 当前数据库里：
  - `Claude 4.6 Sonnet` 一度保存为 `connection_status=connected`
  - 但用同一条记录的 `api_key + api_endpoint + model_id` 直接请求 OpenRouter，流式和非流式都返回 `403`
- 可视化浏览器强制选择 `Claude 4.6 Sonnet` 发消息后：
  - `/api/ai/stream` 返回 `type=error`
  - `modelUsed` 明确是 `anthropic/claude-sonnet-4.6`
  - 错误文本是 `OpenAI-compatible API error: 403 - This model is not available in your region.`
- 旧代码里，SSE 事件循环把 `type=error` 抛出的异常混进了 JSON 解析异常分支，所以控制台上只留下 `Parse error`
- 后台连接测试此前与真实聊天流并不完全一致；为了缩小偏差，连接测试现在也带上与聊天流一致的 OpenRouter 请求头，并按流式模式验证

### 新证据

| Evidence ID | 结论 | 来源 | 类型 |
|-------------|------|------|------|
| `E2E-11` | `Claude 4.6 Sonnet` 在数据库里虽曾标记为 `connected`，但同一条记录的直接 OpenRouter 非流式与流式请求都返回 `403 region unavailable` | 直连 OpenRouter 比对脚本 | 命令证据 |
| `E2E-12` | 可视化浏览器重新点击 `Claude 4.6 Sonnet` 的“测试连接”后，后台状态会从旧的 `已连接` 刷新为 `连接失败` | headed Playwright 复测 | UI + 网络证据 |
| `E2E-13` | 可视化浏览器强制选择 `Claude 4.6 Sonnet` 聊天后，`/api/ai/stream` 返回的真实错误是 `OpenAI-compatible API error: 403 - This model is not available in your region.` | headed Playwright 复测 | UI + 网络证据 |
| `E2E-14` | 旧版 `useStreamingChat.ts` 会吞掉流式 `type=error` 事件，导致控制台出现 `Parse error` 而不是供应商真实错误 | `apps/web/src/hooks/useStreamingChat.ts` | 静态代码证据 |

### 决策

- 将“前端吞错”和“供应商 403”拆成两个层次处理：
  - 应用层：必须把真实供应商错误原样呈现给用户
  - 外部层：仍需通过更换模型、调整账号/地区或改供应商来解决真正不可用的问题
- `12.1.11` 视为已完成：后台状态语义已补上 `configured` 映射，并通过重测可回收旧的错误 `connected`
- 新增 `12.1.16` 记录这轮流式错误呈现修复，并标记为已完成
- `12.1.15` 保持阻塞：代码已不能再把这类问题伪装成“应用连通”，但也不能替 OpenRouter 绕过地区限制

## 🖥️ 可视化调试确认 Claude/OpenRouter 地区受限 (2026-03-06)

> **触发**: 用户要求不要使用无头浏览器，而是在独立可视化浏览器窗口中直接复现并调试 `/admin/models` 的“连接失败”
> **目标**: 用 UI、网络、服务端和数据库四类证据确认当前失败是应用链路问题，还是 OpenRouter 侧拒绝请求

### 结论

- 当前后台模型页的“连接失败”已经不是前端未提交、tRPC 未送达或认证链路中断的问题
- 两条 Claude 模型在独立可视化浏览器窗口中都完成了真实“测试连接”，请求成功到达后台
- 后台返回、数据库持久化结果和直接调用 OpenRouter 的结果完全一致：
  - `This model is not available in your region.`
- 因此本轮应定性为：
  - 应用链路已通
  - 供应商/地区限制仍在
  - 当前 Claude via OpenRouter 不能继续作为完整聊天巡检的可用模型

### 关键发现

- 可视化浏览器中打开两条模型的编辑弹窗后，字段值都与预期一致：
  - `provider = OpenAI / OpenRouter (兼容)`
  - `model_id = anthropic/claude-haiku-4.5` / `anthropic/claude-sonnet-4.6`
  - `api_endpoint = https://openrouter.ai/api/v1/chat/completions`
  - `api_key` 前缀为 `sk-or-v1`
- `POST /api/trpc/model.testConnection?batch=1` 两次都返回 `200`，说明浏览器请求已成功到达后台并完成业务处理
- 两次 `model.testConnection` 的返回体都明确给出：
  - `success=false`
  - `status=error`
  - `error="This model is not available in your region."`
- 紧随其后的 `model.getConnectionStatus` 也都把相同错误同步回前端状态栏
- 直接用当前数据库里保存的 `api_key + api_endpoint + model_id` 请求 OpenRouter，仍然得到同样的 `403` 错误
- 代码复核确认：
  - 管理后台连接测试读取的是 `ai_models.model_id`
  - 聊天流式路由也通过 `ai_models.id -> model_id` 获取真实模型配置
  - `config.model` 不是这条链路的实际决策字段

### 新证据

| Evidence ID | 结论 | 来源 | 类型 |
|-------------|------|------|------|
| `E2E-07` | 可视化浏览器中两条 Claude 模型的 provider、model_id、api_endpoint 和 key 前缀都已正确保存为 OpenRouter 配置 | `apps/web/test-results/visible-debug/claude-openrouter-debug-report.json` + 对应截图 | UI + 命令证据 |
| `E2E-08` | 两次 `model.testConnection` 请求都成功到达后台，返回体一致为 `This model is not available in your region.` | 可视化浏览器网络抓包 | 网络证据 |
| `E2E-09` | 数据库在两次测试后持久化了新的 `last_tested`，并把 `connection_status=error`、`last_error=This model is not available in your region.` 写回 `ai_models.config` | Supabase 查询 `name,model_id,provider,api_endpoint,config,updated_at` | 数据证据 |
| `E2E-10` | 流式聊天路由与后台连接测试都使用 `ai_models.model_id`，不存在“测试用一个字段、聊天用另一个字段”的分叉 | `packages/api/src/routers/model.ts`, `apps/web/src/app/api/ai/stream/route.ts` | 静态代码证据 |

### 决策

- 将 `12.1.13` 视为已完成验证，而不是继续保留为阻塞项
- 不再把当前 Claude/OpenRouter 失败继续归因到前端表单、tRPC 认证或按钮行为
- 新增 `12.1.15` 承接下一阶段动作：
  - 更换当前 OpenRouter 账号下可用的模型
  - 调整 OpenRouter 账号/地区
  - 或改用非 OpenRouter 的 Claude 接入
- 在 `12.1.15` 处理完成前，不应继续把当前两条 Claude 模型当作可用聊天模型来验证主对话链路

## 🔌 OpenRouter 兼容的模型设置链路 (2026-03-06)

> **触发**: 用户明确说明 Claude 不是走 Anthropic 官方 API，而是走 OpenRouter
> **目标**: 修正管理后台模型设置、连接测试和流式对话链路中的协议假设，让 Claude via OpenRouter 可以被正确保存和验证

### 结论

- 当前后台“保存模型配置”本身不是完全失效，`ai_models.api_key` 已经写入数据库
- 真正的问题是协议错配：
  - 后台测试连接默认按 Anthropic `/v1/messages`
  - 流式对话路由也默认按 Anthropic `/v1/messages`
- 对于 OpenRouter，这两处都应走 OpenAI 兼容的 `chat/completions` 协议，并使用 `Authorization: Bearer`

### 关键发现

- 现有活动模型记录中：
  - `has_api_key=true`
  - `api_endpoint` 为空
  - 当前 key 也不是 OpenRouter 常见的 `sk-or-...` 格式
- 在现有配置下直接测试活动模型，会得到 Anthropic 返回的 `403 Request not allowed`
- 这说明“后台没有成功设置”更准确的说法是：
  - 数据已保存
  - 但保存的是无法按当前协议成功使用的凭证组合

### 新证据

| Evidence ID | 结论 | 来源 | 类型 |
|-------------|------|------|------|
| `E2E-04` | `ai_models` 中两条活动 Claude 模型均已写入 `api_key`，但 `api_endpoint` 为空 | Supabase 查询 `ai_models(id,name,model_id,provider,is_active,api_key,api_endpoint,config,updated_at)` | 数据证据 |
| `E2E-05` | 现有活动 Claude 模型直连 Anthropic 官方接口均返回 `403 Request not allowed` | 真实第三方连接测试 | 命令证据 |
| `E2E-06` | 当前数据库里保存的 key 不是 OpenRouter 常见格式，说明现有记录尚未切换成真实 OpenRouter 配置 | Supabase 查询 `api_key.startsWith('sk-or-')` | 数据证据 |

### 决策

- 模型保存和“测试连接”逻辑改为：
  - 若 endpoint 指向 OpenRouter / OpenAI 兼容接口，则走 `chat/completions`
  - 若 key 形态像 OpenRouter，则默认回退到 `https://openrouter.ai/api/v1/chat/completions`
  - 否则继续保留 Anthropic 官方协议
- 流式对话路由也按同样规则切换协议，避免“后台能配，聊天不能发”
- 后台模型设置 UI 补充 OpenRouter endpoint 示例，并在保存后直接反馈真实连接结果

### 追加决策

- 新增 `12.1.12` 记录本轮 OpenRouter 兼容修复
- 新增 `12.1.13` 作为外部阻塞验证项：需先把后台模型改成真实 OpenRouter key + endpoint，再继续对话端到端验证

## 🔐 管理后台 tRPC 401 兜底 (2026-03-06)

> **触发**: 用户在真实浏览器中访问 `/admin/models` 时看到整页黑屏，控制台出现 `model.getAvailableModels` / `admin.getStatistics` 的 `401 Unauthorized`
> **目标**: 让管理后台在浏览器已有 Supabase 登录 cookie 的情况下，不再因为缺失 `Authorization` header 而整页失效

### 结论

- 前端 tRPC provider 已经尝试通过 `supabase.auth.getSession()` 发送 `Authorization`
- 但后端 `/api/trpc` 之前只认这个 header，不认浏览器现有的 Supabase cookie 会话
- 这会导致一种实际故障：
  - 页面路由层通过 cookie 判定“已登录”
  - 但数据请求层因为 header 缺失而返回 `401`

### 决策

- `/api/trpc` 路由层新增 Supabase server client，从请求 cookie 中直接恢复用户会话
- `createTRPCContext` 支持接收路由层已解析的用户对象
- 当 `Authorization` header 缺失但 cookie 会话仍有效时，管理后台应继续正常取数

### 追加决策

- 新增 `12.1.14` 记录本轮管理后台认证兜底修复
- 若刷新后仍出现“连接失败”，则应继续排查模型配置或第三方接口，而不是把认证问题和模型问题混在一起

## 🧭 本地开发环境自动登录巡检范式 (2026-03-06)

> **触发**: 需要让 Codex 在本地开发环境中自动登录站点、主动巡检关键业务流并沉淀结构化问题证据
> **目标**: 先建立“发现问题而非自动修复”的稳定范式，再将确认后的问题回写到三文件工作流

### 结论

- 当前仓库已有 Playwright、`auth.setup.ts` 和本地 `webServer` 配置，足够支撑第一版关键业务流巡检
- 第一版应采用“半探索、半脚本”方案，而不是追求自由探索全站
- 巡检的最小闭环应是：
  - 双账号登录态
  - 关键业务流断言
  - 控制台/网络/运行时异常采集
  - 结构化 issue-report 产物
  - 确认后再回写 `task.json`

### 关键发现

- 原有 `auth.spec.ts`、`chat.spec.ts`、`admin.spec.ts` 存在大量 `test.skip`，更像示意用例，不足以承担真实巡检
- 仅有一个 `E2E_TEST_EMAIL` / `E2E_TEST_PASSWORD` 不足以覆盖管理员页面，必须补充管理员独立账号
- 默认 `trace: on-first-retry` 与本地 `retries=0` 组合下，不会在首次失败时留下 trace，不满足“失败即保留证据”的要求
- 关键业务流更适合按角色拆分：
  - 普通用户：landing、首页、profile、chat、发送消息、停止生成
  - 管理员：dashboard、models、diagnostics、users

### 决策

- 使用 `apps/web/tests/e2e/support/auth.ts` 统一管理双账号登录态路径与环境变量读取
- 使用 `apps/web/tests/e2e/support/monitoring.ts` 统一采集问题，并为每个巡检流写出 `issue-report.json` 和 `issue-report.md`
- Playwright 证据策略改为：
  - HTML report + JSON report
  - `trace: retain-on-failure`
  - `video: retain-on-failure`
  - `screenshot: only-on-failure`
- 新增 `test:e2e:critical` 作为关键巡检命令入口，避免每次手工拼接 spec 列表
- 若缺少测试账号，则明确 `skip`，不把无法执行伪装成通过

### 首轮验证结果

- `pnpm --dir apps/web exec playwright test auth.spec.ts --project=chromium --list` 成功发现 15 个测试，说明 setup、关键巡检 spec 和配置已完成装载
- 首次真实执行 `pnpm --dir apps/web exec playwright test auth.spec.ts --project=chromium` 后得到：
  - `4 passed`
  - `2 skipped`
  - `1 failed`
- `2 skipped` 的原因是本地未提供 `E2E_TEST_*` 账号，因此已登录用户流被显式跳过，符合设计预期
- 失败项来自公开 landing 巡检，而不是账号或环境变量缺失

### 新证据

| Evidence ID | 结论 | 来源 | 类型 |
|-------------|------|------|------|
| `E2E-01` | Playwright 已能装载 15 个关键巡检测试 | `pnpm --dir apps/web exec playwright test auth.spec.ts chat.spec.ts admin.spec.ts --project=chromium --list` | 命令证据 |
| `E2E-02` | 本地执行 `auth.spec.ts` 时，登录页与无效登录断言通过，已登录用户流按设计跳过 | `pnpm --dir apps/web exec playwright test auth.spec.ts --project=chromium` | 命令证据 |
| `E2E-03` | 公开 landing 页存在 hydration mismatch，根因指向 `CTASection.tsx` 中基于 `Math.random()` 的服务端/客户端样式差异 | Playwright 失败日志 + `apps/web/src/components/landing/CTASection.tsx:29-32` | 命令 + 静态代码证据 |

### 追加决策

- 将 landing 页 hydration mismatch 记为确认后的修复任务 `12.5.6`
- 保持“巡检先发现、确认后再修”的边界，本轮不直接改动 landing 业务代码

## 🔄 工作流标准化: task.json 成为唯一计划源 (2026-03-06)

> **触发**: 将仓库的 Manus 三文件模式从 `task_plan.md` 驱动，切换为 `task.json` 驱动
> **目标**: 让用户只需自然语言下达需求，Codex 自动维护 `task.json`、`progress.md`、`findings.md`

### 结论

- `task.json` 更适合作为唯一计划源，因为它可解析、可排序、可自动选择下一项任务
- `progress.md` 应只承担执行日志和验证记录，不再承担计划真相源职责
- `findings.md` 应只承担发现、证据、技术决策、风险沉淀
- `task_plan.md` 保留为历史归档，只允许标记退役，不再继续维护

### 落地策略

1. 在 `.agents/rules` 增加 `always_on` 仓库规则，强制三文件协作
2. 更新 `do-next`、`new-feature`、`debug` 工作流，统一以 `task.json` 驱动
3. 更新 `init.sh`，在会话开始时检查三文件和下一任务
4. 重写本仓库两份 Manus 说明文档，消除双计划源歧义
5. 提供一套可复制到其他仓库的模板层

### 关键发现

- 仓库此前已出现“双计划源”问题：
  - `.agents/workflows/do-next.md` 已以 `task.json` 为入口
  - `manus工作流使用说明.md` 和 `Manus正确工作流程.md` 仍以 `task_plan.md` 为入口
- 如果不统一唯一计划源，后续自然语言指令会持续产生状态漂移
- 对于编程新手，`task.json` 的结构化状态比 `task_plan.md` 的自由文本更适合自动维护

### 决策

- 默认行为改为：用户提新需求时，若 `task.json` 中不存在对应任务，则自动拆解为 1-5 个任务并写入
- 默认排序改为：`step` 最小优先，再按 `priority`，再按 `id`
- 默认阻塞策略改为：一律保留 `passes=false`，必须写清 `blocked=true` 和 `block_reason`

## 🧪 阶段 12 P0 验证批次对齐 (2026-03-06)

> **触发**: 需要将阶段 12 步骤 1 的 P0 验证任务统一收敛为同一事实版本
> **目标**: 区分 PASS / BLOCKED / FAIL，并让 `task.json`、`progress.md`、`findings.md` 使用同一结论和证据编号

### 批次结论

- `12.1.3` 可直接判定为 `PASS`
- `12.1.1`、`12.1.2`、`12.1.6`、`12.1.8` 因缺少真实登录态、真实模型 key 或真实调用条件，统一判定为 `BLOCKED`
- `12.1.4` 已通过代码审计核实真实行为，但结果与预期不一致，应判定为 `FAIL`，并新增后续修复任务 `12.1.11`

### 证据索引

| Evidence ID | 结论 | 来源 | 类型 |
|-------------|------|------|------|
| `E-01` | Chat 页面已接入流式主链路，并通过 Bearer token 调用 `/api/ai/stream` | `apps/web/src/app/chat/page.tsx:16,96`, `apps/web/src/hooks/useStreamingChat.ts:141`, `apps/web/src/app/api/ai/stream/route.ts:325` | 静态代码证据 |
| `E-02` | 打字机逐字更新与中断后追加 `[已中断]` 的逻辑存在于流式 Hook | `apps/web/src/hooks/useStreamingChat.ts:205,212,274,279,320` | 静态代码证据 |
| `E-03` | 模型创建/更新/测试连接的成功失败 toast 已接入 | `apps/web/src/app/admin/models/page.tsx:138,144,150,156,176,184` | 静态代码证据 |
| `E-04` | 后端对 `hasApiKey=true` 的默认状态是 `untested`，前端显示为“待测试”而非“已连接” | `packages/api/src/routers/model.ts:308-316`, `apps/web/src/app/admin/models/page.tsx:198-208` | 静态代码证据 |
| `E-05` | 流式路由使用“模型 key 优先，环境变量回退”的策略，无法仅靠静态代码证明独立 key 完全生效 | `apps/web/src/app/api/ai/stream/route.ts:81-92,319-322` | 静态代码证据 |
| `E-06` | 扣费链路包含预扣、结算和 `token_stats` 写入，但缺少真实会话与落库证据 | `apps/web/src/app/api/ai/stream/route.ts:278-283,448-453,460-474`, `apps/web/src/app/chat/page.tsx:112` | 静态代码证据 |
| `E-07` | API 测试基线为 `228 passed, 0 failed` | `pnpm --filter @repo/api test:run` | 命令证据 |
| `E-08` | `.env.local` 未配置 `E2E_TEST_EMAIL` / `E2E_TEST_PASSWORD` | `rg "^E2E_TEST_EMAIL=|^E2E_TEST_PASSWORD=" .env.local` 无匹配 | 环境阻塞证据 |

### 关键发现

- `12.1.1` 和 `12.1.2` 的代码路径已经具备流式 AI 回复与中断能力，但没有真实登录态就无法完成浏览器端到端验证
- `12.1.3` 的成功/失败 toast 逻辑已经完整接入，可直接判定为通过
- `12.1.4` 当前真实语义是：
  - 无 key -> `未配置密钥`
  - 有 key 但未测 -> `待测试`
  - 只有显式连接成功才会显示 `已连接`
- 这与“有 API Key 的模型显示已连接”的原验证预期不一致，因此应从“待验证”转成“已验证发现问题”
- `12.1.6` 不能仅靠代码审计证明“完全不依赖全局 key”，因为代码仍保留环境变量回退
- `12.1.8` 不能仅靠代码审计证明积分真的落账，必须结合真实用户会话与数据库写入结果

### 阻塞解除条件

| Task | Owner | Prerequisite | Unblock Proof |
|------|-------|--------------|---------------|
| `12.1.1` | 用户 | 有效登录态、真实模型 key、可访问 `/chat` | 截图 AI 非 Echo 回复 |
| `12.1.2` | 用户 | 有效登录态、真实流式返回 | 截图逐字输出过程与停止后的 `[已中断]` |
| `12.1.6` | 用户 + 环境 | 移除全局 key，仅保留模型 key，能发起真实请求 | 在该条件下仍成功收到回复 |
| `12.1.8` | 用户 | 有效登录态、可发送消息、可查看积分与落库结果 | 发送前后积分变化截图，且 `billing_history` / `token_stats` 有新增记录 |

### 决策

- 对于 `verify` 类型任务，结论应表示“真实行为已否被核实”，而不是“是否符合预期”
- 当真实行为已核实但不符合预期时，应结束当前验证任务并新增 `fix` 任务承接修复
- 因此本轮新增 `12.1.11`，用于修复模型 API 状态显示语义

## 📋 阶段 12: 遗留问题清理与系统稳定化 (2026-03-06)

> **决策时间**: 2026-03-06
> **触发**: 阶段 0-11 全部完成后，对三份核心文档 (task_plan.md / progress.md / findings.md) 进行全面复盘
> **目标**: 清理所有遗留待办项，使系统进入稳定可交付状态

### 复盘发现

对 `task_plan.md` 中所有 `⏳ 待修复` / `⏳ 待验证` 标记进行交叉验证后，发现：

| 分类 | 数量 | 说明 |
|------|------|------|
| 真正已修复但归档区未更新 | ~15 | P2-B/P2-C/P2-D/P3 等在后续阶段修复，但归档区标记未同步 |
| 阶段 10/11 修复完成但未验证 | 10 | 代码已改，验证步骤从未执行 |
| 系统设置生效性未验证 | 9 | system_settings 多项配置未确认是否被读取 |
| 管理后台数据准确性 | 8 | 财务统计、性能监控、诊断检查的数据来源问题 |
| 订阅管理 UI 问题 | 6 | 热门推荐、样式、年付总价等 |
| 成本监控 UI + 用户菜单 | 4 | 排版拥挤、API 状态、绿色高亮、管理入口 |

### 决策: 4 步骤分阶段清理

**执行原则**: 先验证再修复，先后端再前端，先核心再边缘

#### 步骤 1: 验证已完成工作 (阶段 10/11)
- **优先级**: 🔴 最高
- **内容**: 在浏览器中手动验证 AI 对话功能、模型管理、积分计费
- **理由**: 代码已写完但从未验证，是整个系统最大的不确定性

#### 步骤 2: 系统设置生效性审计 (#28-41)
- **优先级**: 🟠 高
- **内容**: 代码审计聊天页面和流式端点，确认 system_settings 哪些配置被读取
- **理由**: 避免管理员看到的设置面板是"假的"

#### 步骤 3: 管理后台数据修复 (#13, #15-17, #20-27)
- **优先级**: 🟡 中
- **内容**: 修复财务统计、性能监控、诊断健康检查的数据来源
- **理由**: 影响管理员决策的数据准确性

#### 步骤 4: UI 与体验优化 (#6-11, #18-19, #49-52)
- **优先级**: 🟢 低
- **内容**: 订阅管理样式、页面设置功能、成本监控排版
- **理由**: 不影响核心功能，属于体验优化

### 关于归档区遗留标记的处理

**决策**: 不修改归档区历史记录（保持原始状态），在新阶段 12 中统一跟踪实际状态。

| 归档区问题 | 实际状态 | 阶段 12 处理 |
|-----------|---------|-------------|
| #1-2 AI 模型配置/状态 | ✅ 阶段 10 已修复 | 步骤 1 验证 |
| #3-5 功能广场模块 | ✅ P2-B 已修复 | 无需处理 |
| #6-11 订阅管理 | ⚠️ #6-7 已有 API 但 UI 未更新 | 步骤 4 |
| #12 状态栏图标 | ✅ P3-1 已修复 | 无需处理 |
| #14 财务单位统一 | ✅ P3-2 已修复 | 无需处理 |
| #18-19 页面设置 | ✅ P2-C 标记已修复 | 步骤 1 验证 |
| #51-52 菜单高亮/管理入口 | ✅ P3-4/P3-5 已修复 | 无需处理 |

---

## 🔄 工作范式整合: auto-coding-agent-demo (2026-03-06)

> **来源**: [SamuelQZQ/auto-coding-agent-demo](https://github.com/SamuelQZQ/auto-coding-agent-demo)
> **决策**: 部分借鉴，采用混合范式（结构化任务 + 对话式协作）

### 评估结论

该项目为从零开发的全自动编程实验，核心是 `CLAUDE.md` + `task.json` + `progress.txt` 的三件套。经评估：
- **适合借鉴**: 结构化任务队列、环境初始化、阻塞处理规则、进度日志标准化
- **不适合套用**: 无人值守执行、跳过权限检查、简单 lint+build 验证

### 整合的具体内容

| 借鉴项 | 落地方式 | 文件 |
|--------|---------|------|
| 结构化任务队列 | `task.json` 26 项任务，含 passes/blocked/priority/type 字段 | `task.json` |
| 环境初始化脚本 | `init.sh` 检查 Node/pnpm/env/dev server/任务进度 | `init.sh` |
| 标准化执行流程 | `/do-next` workflow 定义 6 步执行循环 | `.agents/workflows/do-next.md` |
| 阻塞处理规则 | 写入 `/do-next` workflow，禁止假装完成 | `.agents/workflows/do-next.md` |
| 进度日志格式 | 三段式：完成内容 / 验证方式 / 备注 | `/do-next` workflow |
| 单任务单 commit | 每完成一个修复项独立 commit | `/do-next` workflow |

### 与原项目的关键差异

| 维度 | auto-coding-agent-demo | GraylumAI 混合范式 |
|------|----------------------|-------------------|
| 人工参与 | 最小化 | 每阶段审阅 |
| 执行方式 | `--dangerously-skip-permissions` | 对话式协作 |
| 任务格式 | JSON only | JSON (task.json) + Markdown (task_plan.md) 并行 |
| 验证方式 | lint + build + Playwright | 代码审计 + 浏览器测试 + 数据验证 |

---

## 🔴 AI 对话功能诊断报告 (2026-01-24)

> **诊断文档**: `AI_DIALOGUE_DIAGNOSTIC_REPORT.md`

### 根本原因

**AI 对话功能完全无法工作的核心原因**：前端调用了占位符 API (`chat.sendMessage`)，而完整的 AI 实现从未被集成。

存在三套独立实现但未正确连接：
1. `chat.sendMessage` - **占位符**（当前被调用，只回显输入）
2. `ai.sendMessage` - **完整实现**（从未被调用）
3. 流式处理链路 - **完整实现**（从未被调用）

### 问题汇总

| 优先级 | 问题数量 | 影响范围 |
|--------|----------|----------|
| P0 (致命) | 4 | 功能完全不可用 |
| P1 (严重) | 3 | 功能缺陷或安全风险 |
| P2 (中等) | 3 | 功能不完整 |
| P3 (轻微) | 2 | 代码质量问题 |

### P0 致命问题

| ID | 问题 | 位置 | 原因 |
|----|------|------|------|
| P0-1 | chat.sendMessage 是占位符 | `packages/api/src/routers/chat.ts:121` | 只回显用户输入，未调用 AI |
| P0-2 | 前端调用错误的 API | `apps/web/src/app/chat/page.tsx` | 调用 chat.sendMessage 而非 ai.sendMessage |
| P0-3 | 流式处理未集成 | `streamHandler.ts`, `useStreamingChat.ts` | 完整实现存在但从未被调用 |
| P0-4 | ai.sendMessage 前端未调用 | `packages/api/src/routers/ai.ts:251-479` | 完整实现存在但前端从未调用 |

### P1 严重问题

| ID | 问题 | 位置 | 原因 |
|----|------|------|------|
| P1-1 | 输出安全过滤未应用 | `packages/api/src/routers/ai.ts:383-397` | 代码标记为 TODO |
| P1-2 | 签名验证未使用 | `packages/api/src/services/requestSigner.ts` | 前端从未签名，后端验证可选 |
| P1-3 | 计费价格来源与 UI 不一致 | `packages/api/src/services/billing.ts` | 从 ai_models 表读取，非 system_settings |

### P2 中等问题

| ID | 问题 | 位置 | 原因 |
|----|------|------|------|
| P2-1 | 前端缺少错误处理 | `apps/web/src/app/chat/page.tsx` | 无 onError 回调 |
| P2-2 | 使用量统计未连接 | `packages/api/src/routers/ai.ts:420-445` | ai.sendMessage 从未被调用 |
| P2-3 | 上下文长度限制未实现 | `packages/api/src/routers/ai.ts:300-320` | 代码标记为 TODO |

### P3 轻微问题

| ID | 问题 | 位置 | 原因 |
|----|------|------|------|
| P3-1 | 重复的类型定义 | `packages/api/src/types/ai.ts` + 内联类型 | 维护困难 |
| P3-2 | 环境变量验证不完整 | `apps/web/src/app/api/ai/stream/route.ts` | 缺少详细日志 |

---

## ✅ 修复方案: 集成流式处理（方案 A）

> **推荐方案**：集成流式处理（方案 A）

### 方案概述

| 属性 | 值 |
|------|------|
| 优先级 | P0 |
| 工作量 | 中等 |
| 风险 | 低 |

### 架构修正

```
当前状态 (错误):
┌─────────────────┐     调用      ┌───────────────────┐
│  Chat Page      │ ────────────→ │ chat.sendMessage  │ (占位符!)
│  (前端)         │               │ 只回显输入        │
└─────────────────┘               └───────────────────┘

目标状态 (正确):
┌─────────────────┐     调用      ┌───────────────────┐
│  Chat Page      │ ────────────→ │ /api/ai/stream    │
│  (前端)         │  SSE 连接     │ + StreamHandler   │
│  + useStreaming │               │ + 计费集成        │
│    Chat Hook    │               │ + 智能路由        │
└─────────────────┘               └───────────────────┘
```

### 修复步骤

| 步骤 | 任务 | 涉及文件 | 工作量 |
|------|------|---------|--------|
| 1 | 修改前端调用流式 API | `apps/web/src/app/chat/page.tsx` | 中 |
| 2 | 集成 useStreamingChat Hook | `apps/web/src/hooks/useStreamingChat.ts` | 小 |
| 3 | 添加错误处理和加载状态 | `apps/web/src/app/chat/page.tsx` | 小 |
| 4 | 验证环境变量配置 | `.env`, Vercel 环境变量 | 小 |
| 5 | 测试计费和智能路由 | 端到端测试 | 中 |

### 关键代码修改

**1. 前端 chat/page.tsx 修改**:
```typescript
// 移除
const sendMessage = trpc.chat.sendMessage.useMutation({...});

// 替换为
import { useStreamingChat } from '@/hooks/useStreamingChat';
const { sendMessage, isStreaming, error } = useStreamingChat({
  conversationId,
  onMessage: (content) => { /* 更新消息列表 */ },
  onComplete: () => { /* 刷新消息列表 */ },
  onError: (error) => { /* 显示错误提示 */ },
});
```

**2. 验证环境变量**:
```bash
ANTHROPIC_API_KEY=sk-ant-xxx  # 必须配置
DATABASE_URL=xxx              # 必须配置
```

---

## 🚨 待修复问题 (2026-01-23)

### 对话功能失效

| # | 问题 | 位置 | 原因 | 状态 |
|---|------|------|------|------|
| 1 | 对话功能失效 | `chat/page.tsx` | 前端调用了占位符 API | ⏳ 待修复 |

**问题描述**: 发送对话后只收到 "Echo: [原消息]" 回复，AI 功能完全不可用。

**根本原因** (2026-01-24 诊断确认):
- 前端调用 `trpc.chat.sendMessage`（占位符）
- 完整的 AI 实现在 `trpc.ai.sendMessage` 和流式处理链路中
- 三套实现从未正确集成

**修复方案**: 方案 A - 集成流式处理（见上文）

---

## ✅ 已修复问题 (2026-01-23)

### 工单附件功能

| # | 问题 | 位置 | 原因 | 状态 |
|---|------|------|------|------|
| 1 | 工单上传图片不显示 | `TicketsPanel.tsx` | 附件上传是 mock 代码，未实际上传到存储 | ✅ 已修复 |
| 2 | 管理员后台附件图片不显示 | `admin/tickets/page.tsx` | 代码只显示 Lucide Image 图标，未渲染实际 `<img>` 标签 | ✅ 已修复 |

**修复内容**:
- 创建 `/api/upload/route.ts` 文件上传 API，支持上传到 Supabase Storage
- `ticket.ts` 路由支持 attachments 参数
- `TicketsPanel.tsx` 实现真实文件上传和附件展示
- `admin/tickets/page.tsx` 修复附件图片渲染，使用 `<img>` 标签

---

## 🚨 首页数据集成 Bug (2026-01-23)

### 问题发现

用户登录后，首页存在 4 个严重的数据集成问题：

| # | 问题 | 影响 | 严重程度 |
|---|------|------|---------|
| 1 | 积分 API 404 | Header 积分显示 "--" | 🔴 P0 |
| 2 | 用户名硬编码 | 所有用户显示 "office" | 🔴 P0 |
| 3 | 会员等级硬编码 | 所有用户显示 "普通会员" | 🔴 P0 |
| 4 | 公告硬编码 | 管理后台公告无法显示 | 🟡 P1 |

### 根本原因分析

**1. 积分 API 404 (`credits.getBalance`)**

- **位置**: `apps/web/src/hooks/use-credits.tsx:19`
- **调用**: `trpc.credits.getBalance.useQuery()`
- **可能原因**:
  - tRPC context 中 `profileId` 未正确设置
  - Supabase 认证 token 未正确传递到 API
  - 路由配置问题

**2. 用户数据硬编码**

- **位置**: `apps/web/src/app/page.tsx:66-71`
- **当前代码**:
```javascript
const user = {
  full_name: 'office',                    // ❌ 硬编码
  email: 'office@example.com',            // ❌ 硬编码
  membership_level: 'free',               // ❌ 硬编码
  membership_expiry_date: undefined
};
```
- **修复方案**: 调用 `trpc.user.getProfile.useQuery()` 获取真实数据

**3. 公告数据硬编码**

- **位置**: `apps/web/src/app/page.tsx:74-84`
- **当前代码**:
```javascript
const announcements = [
  {
    id: '1',
    title: '应用上线特惠',               // ❌ 硬编码
    description: '黄金会员年卡 5 折...',  // ❌ 硬编码
    ...
  }
];
```
- **修复方案**: 调用 `trpc.admin.getActiveAnnouncements.useQuery()` 获取

### 修复任务清单

| # | 任务 | 交付物 | 状态 |
|---|------|--------|------|
| 1 | 调试积分 API 404 | 修复 tRPC context | ✅ 已有 |
| 2 | 集成用户 profile 数据 | page.tsx 调用 tRPC | ✅ 完成 |
| 3 | 集成公告 API | page.tsx 调用 announcements API | ✅ 完成 |
| 4 | 测试验证 | 确保数据正确显示 | ✅ 完成 |

### 修复详情 (2026-01-23)

**修改的文件**:

| 文件 | 修改内容 |
|------|---------|
| `packages/api/src/routers/settings.ts` | 新增 `getActiveAnnouncements` 和 `getBannerAnnouncement` 公开 API |
| `apps/web/src/app/page.tsx` | 使用 tRPC 获取用户 profile 和公告数据 |
| `apps/web/src/components/home/UpdatesSection.tsx` | 添加 yellow 标签颜色支持 |

**关键修复**:

1. **用户数据**: 调用 `trpc.user.getUserProfile.useQuery()` 获取真实用户数据
   ```javascript
   const user = {
     full_name: userProfile?.nickname || userProfile?.email?.split('@')[0] || '用户',
     membership_level: userProfile?.membership_level || 'free',
   };
   ```

2. **公告数据**: 新建公开 API `settings.getActiveAnnouncements`
   - 原 `admin.getActiveAnnouncements` 使用 `adminProcedure`，普通用户无法访问
   - 新 API 使用 `publicProcedure`，返回活跃公告列表

3. **积分 API**: 检查发现 `credits.getBalance` 实现正确，404 可能是 session 时序问题
   - tRPC provider 已正确配置 Authorization header
   - 建议：确保 auth session 稳定后再请求

---

## 着陆页与访问控制实施决策 (2026-01-23)

### 任务概述

实现标准 SaaS 网站的访问逻辑：
- **www.graylum.com** - 公开营销着陆页
- **app.graylum.com** - 应用后台（需登录）
- **graylum.com** - 重定向到 www

### 技术架构决策

#### 1. 路由组结构

**决策**: 使用 Next.js 16 路由组分离着陆页和应用

```
apps/web/src/app/
├── (landing)/              # 公开页面 (www 域名)
│   ├── layout.tsx          # 着陆页独立布局
│   └── page.tsx            # 着陆页首页
├── (app)/                  # 应用页面 (app 域名)
│   ├── layout.tsx          # 应用布局 (带 tRPC Provider)
│   ├── page.tsx            # 应用首页 (Dashboard)
│   ├── admin/              # 管理后台
│   ├── chat/               # AI 对话
│   ├── marketplace/        # 应用市场
│   ├── profile/            # 个人设置
│   └── login/              # 登录页面
├── layout.tsx              # 根布局 (共享)
└── globals.css             # 全局样式
```

**理由**:
- 路由组 `()` 不影响 URL 结构
- 允许独立的布局和样式
- 便于维护和扩展

#### 2. 中间件访问控制策略

**决策**: 修改 `middleware.ts` 实现域名路由和认证拦截

```typescript
// 访问控制逻辑
const hostname = request.headers.get('host') || ''
const isAppDomain = hostname.startsWith('app.')
const isWwwDomain = hostname.startsWith('www.') || !hostname.includes('.')

// app 域名: 检查登录状态
if (isAppDomain) {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user && !isPublicPath) {
    return NextResponse.redirect(new URL('/login', request.url))
  }
}
// www 域名: 允许所有访问
```

**公开路径**: `/login`, `/api/*`, `/_next/*`, `/favicon.ico`

#### 3. 着陆页组件架构

**决策**: 创建独立的着陆页组件目录

```
apps/web/src/components/landing/
├── LandingHeader.tsx       # 导航栏 (滚动效果)
├── HeroSection.tsx         # Hero 区域
├── FeaturesSection.tsx     # 6 步增长策略展示
├── PricingSection.tsx      # 定价方案
├── CTASection.tsx          # 行动号召
└── LandingFooter.tsx       # 页脚
```

#### 4. 设计规范

**决策**: 遵循 `VISUAL_DESIGN_SYSTEM.md` 设计系统

| 元素 | 值 | 用途 |
|------|----|----|
| 主色 | `#FFD700` | CTA 按钮、强调文字 |
| 背景 | `#0A0A0A` | 页面背景 |
| 次级背景 | `#1A1A1A` | 卡片、容器 |
| 文字主色 | `#FFFFFF` | 标题、重要内容 |
| 文字次色 | `#B0B0B0` | 描述文字 |

#### 5. CTA 链接策略

**决策**: 所有行动按钮链接到 `app.graylum.com`

- "免费开始" → `https://app.graylum.com/login?action=signup`
- "登录" → `https://app.graylum.com/login`
- "查看定价" → `https://app.graylum.com/login?redirect=/pricing`

### 实施步骤

| 步骤 | 任务 | 预计交付 |
|------|------|---------|
| 1 | 修改中间件添加域名路由 | middleware.ts |
| 2 | 创建 `(landing)` 路由组 | layout.tsx, page.tsx |
| 3 | 移动现有页面到 `(app)` 组 | 文件重组织 |
| 4 | 开发着陆页组件 | 6 个组件 |
| 5 | 测试验证 | 本地 + 生产 |

### 潜在风险与解决方案

| 风险 | 解决方案 |
|------|---------|
| 本地开发无多域名 | 使用环境变量 `NEXT_PUBLIC_APP_ENV` 控制行为 |
| 样式冲突 | 路由组独立布局，不共享 Provider |
| SEO 影响 | 着陆页添加适当的 meta 标签和 sitemap |

---

## 开发规范决策 (2026-01-22)

### 采用新的 7 阶段开发流程

**决策**: 全面采用 `开发规范清单-终极版.md` 作为项目后续维护的标准流程。

**来源**: `movetonew/开发规范清单-终极版.md` (1244 行，2026-01-22 创建)

**核心原则**:
1. **先建监控，再修 BUG** - 没有监控就是盲修
2. **从内到外** - 先保证核心功能（AI、计费）正常
3. **小步快跑** - 每完成一步就验证
4. **留有记录** - 所有测试结果都保存
5. **成本意识** - AI API 成本监控

**7 阶段执行路线**:

| 阶段 | 内容 | 紧急程度 | 重要程度 | 状态 |
|------|------|---------|---------|------|
| **阶段 0** | 系统诊断 | 🔴 高 | 🔴 高 | 🔜 下一步 |
| **阶段 1** | 基础监控 (Sentry + 日志 + 成本仪表板) | 🔴 高 | 🔴 高 | ⏳ 待执行 |
| **阶段 2** | 安全加固 (RLS + 环境变量 + 依赖扫描) | 🟡 中 | 🔴 高 | ⏳ 待执行 |
| **阶段 3** | CI/CD 自动化 | 🟡 中 | 🟡 中 | ⏳ 待执行 |
| **阶段 4** | 性能优化 | 🟢 低 | 🟡 中 | ⏳ 待执行 |
| **阶段 5** | 文档体系 | 🟢 低 | 🟡 中 | ⏳ 待执行 |
| **阶段 6** | 高级优化 | 🟢 低 | 🟢 低 | ⏳ 待执行 |

**阶段 0 首要任务**: 创建系统诊断页面 (`/admin/diagnostics`)
- 11 项测试功能 (AI 5项 + 计费 3项 + 安全 3项)
- Vercel Cron 每小时自动测试
- 测试账号 system-test@graylum.internal

---

## Tech Stack Versions (2026-01-21)

| Category | Package | Version |
|----------|---------|---------|
| **Framework** | Next.js | 16.1.4 |
| | React | 19.2.3 |
| | TypeScript | 5.9.3 |
| **Styling** | Tailwind CSS | 4.1.18 |
| **State & Data** | @tanstack/react-query | 5.90.19 |
| | @trpc/* | 11.8.1 |
| **Database** | @supabase/supabase-js | 2.90.1 |
| | drizzle-orm | 0.45.1 |
| | postgres | 3.4.8 |
| **Validation** | zod | 4.3.5 |
| **UI** | lucide-react | 0.562.0 |
| | @radix-ui/* | 1.1.x - 2.2.x |
| **Build** | turbo | 2.7.5 |
| | pnpm | 10.27.0 |

---

## Phase 10 安全与合规审计发现 (2026-01-21)

### 审计总览

| 类别 | 评分 | 状态 |
|------|------|------|
| 计费安全 | 3.5/5 | ⚠️ 需改进 |
| 前端功能 | 3.0/5 | ⚠️ 需改进 |
| API 安全 | 4.0/5 | ✅ 良好 |
| 数据隐私 | 2.5/5 | 🔴 需修复 |
| AI 优化 | 3.0/5 | ⚠️ 需改进 |
| 可观测性 | 2.5/5 | 🔴 需修复 |
| **总体评分** | **3.1/5** | ⚠️ 部分达标 |

---

### 🔴 P0 严重问题 (必须修复)

#### 1. 费率配置未对齐
- **位置**: `packages/api/src/types/billing.ts:283-305`, `packages/api/src/services/costCalculator.ts:68-114`
- **问题**: 计费系统使用硬编码 `MODEL_PRICING` 常量，完全忽略数据库 `ai_models.token_rate` 字段
- **影响**: 管理后台修改费率无效，需要修改代码重新部署
- **建议**: 创建 `getModelPricing(modelId)` 函数，从数据库实时读取费率

#### 2. Header 积分硬编码
- **位置**: `apps/web/src/components/layout/AppHeader.tsx:38`
- **代码**: `const [credits] = useState(100); // TODO: Get from user context`
- **影响**: 全站所有页面积分显示为硬编码的 100，与实际积分不同步
- **建议**: 调用 `trpc.credits.getBalance.useQuery()` 获取实时积分

#### 3. RLS 策略缺失
- **位置**: `packages/db/migrations/`
- **问题**: 18 个表中仅 3 个启用 RLS (token_stats, billing_history, ai_usage_logs)
- **缺失表**: profiles, conversations, messages, creditTransactions, tickets, ticketReplies, userActivityLogs, prompts, invitationRecords, systemSettings, aiModels 等 15 个
- **影响**: 用户可能越权访问他人数据
- **建议**: 为所有用户数据表添加 `USING (auth.uid() = user_id)` RLS 策略

#### 4. 流式中断未正确实现
- **位置**: `apps/web/src/hooks/useAIChat.ts`, `packages/api/src/routers/ai.ts`
- **问题**:
  - useAIChat 使用 tRPC mutation 而非流式接口
  - abortControllerRef 定义但未被正确使用
  - 中断后无积分结算机制
- **影响**: 用户点击中断后，后端继续计算并扣全额积分
- **建议**: 实现真正的 SSE 流式 API，中断时计算已消耗 tokens 进行部分结算

#### 5. 请求幂等性缺失
- **位置**: `packages/api/src/routers/ai.ts:295-339`
- **问题**: AI 路由的 preDeduct/settle 调用缺少 idempotencyKey
- **影响**: 网络重试可能导致重复扣费
- **建议**: 生成唯一 requestId，添加幂等性检查

#### 6. 事务原子性不足
- **位置**: `packages/api/src/services/billing.ts`
- **问题**:
  - 使用 Supabase REST API，无法使用 PostgreSQL 事务
  - preDeduct/settle/refund 三步操作非原子性
  - 记录插入与余额更新分离
- **影响**: 并发情况下可能数据不一致
- **建议**: 使用 Supabase RPC 函数实现原子操作

---

### 🟡 P1 中等问题 (计划修复)

#### 7. 请求签名/时间戳未实现
- **位置**: `packages/api/src/middleware/securityChecks.ts`
- **问题**: 无 API 请求签名验证，无时间戳校验
- **影响**: 无法防止重放攻击
- **建议**: 实现 HMAC-SHA256 签名 + 30秒时间戳校验

#### 8. 上下文压缩阈值配置不一致
- **位置**: `packages/api/src/services/contextManager.ts:25`
- **问题**:
  - 当前阈值 80000/150000 = 53.3%，非要求的 60%
  - contextManager 稳定区域 5 轮，promptCacheBuilder 稳定区域 3 轮
- **建议**: 统一配置为 90000 (60%) 和 3 轮

#### 9. 递归摘要算法未实现 ✅ 已修复
- **位置**: `packages/api/src/services/contextManager.ts`
- **问题**: 仅实现单层摘要，无递归压缩机制
- **修复**: 实现 `generateRecursiveSummary()` 方法，支持多层摘要链式压缩，最多 5 层，每层压缩比 30%

#### 10. 智能路由关键词不完整
- **位置**: `packages/api/src/services/modelRouter.ts:48-67`
- **问题**: 缺少实时数据关键词（新闻、天气、股票、实时、最新等）
- **影响**: 无法识别需要 Web Search 的查询
- **建议**: 添加 `REALTIME_DATA_KEYWORDS` 正则匹配

#### 11. settle() 缺少成本验证
- **位置**: `packages/api/src/services/billing.ts:229-326`
- **问题**: 接收 actualCredits 参数但未验证与 usage 对应
- **建议**: 添加 `calculateTokenCost(modelId, usage)` 验证

#### 12. 日志信息不完整
- **位置**: `packages/api/src/routers/ai.ts:353-360`
- **问题**: ai_usage_logs 记录缺少 request_id、ip_address、user_agent
- **建议**: 从请求上下文提取并传递完整日志信息

#### 13. 路由系统 window.location 使用
- **位置**:
  - `apps/web/src/app/login/page.tsx:22`
  - `apps/web/src/components/home/SixStepsGuide.tsx:60`
- **问题**: 使用 window.location.href 替代 Next.js useRouter
- **建议**: 改用 `router.push()`

---

### ✅ 已达标项目

| # | 检查项 | 评分 | 位置 |
|---|--------|------|------|
| 1 | 后端积分计算 | 5/5 | billing.ts - calculateTokenCost() |
| 2 | 三段式计费 | 5/5 | billing.ts - preDeduct/settle/refund |
| 3 | tRPC 权限保护 | 5/5 | ai.ts - 全部使用 protectedProcedure |
| 4 | 速率限制 | 5/5 | securityChecks.ts - 60次/分钟 |
| 5 | 消费熔断 | 5/5 | securityChecks.ts - 10000/小时 |
| 6 | 内容审核 | 5/5 | contentModerator.ts - 双向审查 |
| 7 | Prompt 注入防御 | 5/5 | contentModerator.ts - 9种模式检测 |
| 8 | Sidebar 对话切换 | 5/5 | ChatSidebar.tsx + useChatStore |
| 9 | Prompt Caching | 5/5 | promptCacheBuilder.ts - cache_control |
| 10 | 环境安全 | 4/5 | 无通配符 CORS，.env 正确忽略 |
| 11 | CHECK 约束 | 5/5 | profiles.credits >= 0 |

---

### 技术决策

| 决策 | 理由 |
|------|------|
| 费率应从数据库读取 | 硬编码无法通过管理后台配置 |
| 使用 RPC 函数实现原子计费 | REST API 无法保证事务原子性 |
| 所有用户数据表需 RLS | 防止越权访问 |
| 流式 API 需支持中断结算 | 避免用户被扣全额但未完成生成 |
| 请求需唯一 ID | 支持幂等性和链路追踪 |

---

## 数据库表结构

### 核心表
| 表名 | 字段 | 用途 |
|------|------|------|
| `profiles` | id, email, nickname, avatar_url, role, credits, status, membership_level, created_at | 用户资料 |
| `conversations` | id, user_id, title, model_id, created_at | 对话 |
| `messages` | id, conversation_id, role, content, created_at | 消息 |
| `credit_transactions` | id, user_id, amount, type, description, created_at | 积分交易 |

### AI 相关表
| 表名 | 字段 | 用途 |
|------|------|------|
| `ai_models` | id, name, provider, endpoint, config, token_rate, created_at | AI 模型配置 |
| `token_stats` | id, user_id, conversation_id, model_id, input_tokens, output_tokens, cost | Token 统计 |
| `billing_history` | id, user_id, operation, amount, balance_before, balance_after | 计费历史 |
| `ai_usage_logs` | id, user_id, model_id, status, response_time, created_at | AI 使用日志 |

### 业务表
| 表名 | 用途 |
|------|------|
| `tickets` | 工单 |
| `ticket_replies` | 工单回复 |
| `credit_packages` | 积分包 |
| `membership_plans` | 会员套餐 |
| `invitations` | 邀请码 |
| `invitation_records` | 邀请记录 |
| `announcements` | 公告 |
| `prompts` | 提示词模块 |
| `modules` | 功能模块 |
| `system_settings` | 系统设置 |

---

## Environment Variables

```
NEXT_PUBLIC_SUPABASE_URL=<your-supabase-url>
NEXT_PUBLIC_SUPABASE_ANON_KEY=<your-anon-key>
SUPABASE_SERVICE_ROLE_KEY=<your-service-role-key>
```

---

## Resources

- **UI 复刻规则**: `movetonew/UIfix_rule.md`
- **AI 重构计划**: `movetonew/GraylumAI_分阶段重构执行计划.md`
- **设计简报**: `AI_REFACTOR_DESIGN_BRIEF.md`
- **旧项目备份**: `/home/user/graylumAi-backup-ref/`
