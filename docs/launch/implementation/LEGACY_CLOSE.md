# LEGACY-CLOSE 删除与功能对照

状态：第一段 #792、第二段 #898 已合并；第三段（旧 `/workbench` 与自研内容检查）见文末。
初始基线 staging `c91c526d3c43fb5e0b28c2a0a1942b457590fa3a`；
按总控 2026-10-11 通知同步至 `ea5a693c8b7b99463ede5fd41588c4dec4ef118c`（#784 已合并）。
授权：[#771 总控派发](https://github.com/Crnobog9527/GraylumAI_vercel/pull/771#issuecomment-6099912595)
及本任务 Owner 指令；候选与交接以 #792 为准。
风险 high：删除旧 API/代码及失效测试，需保留安全边界和新功能引用。
无新架构；无数据库、迁移、计费实现、生产或供应商配置改动。回退本 PR 即恢复被删代码。

## 删除前逐项引用核对

核对范围：仓库源码静态 import、动态 import、tRPC 客户端、测试和本地测试运行器；
类型检查验证新代码引用闭合。历史文档不是运行时调用证据。

| 对象 | 核对与处理 |
| --- | --- |
| `apps/web/src/app/chat` | 除关闭契约测试外全部删除；内部互相引用，没有其他现行页面使用。保留 next.config 的 `/chat` 307 规则。 |
| `ChatHeader/ChatSidebar/ModelSelector/ExportDialog/TokenUsageStats` | 仅旧 chat 页面使用，全部删除。 |
| `useStreamingChat`、`useChatStore` 及 stores barrel | 仅上述旧页面/组件使用，删除。 |
| `components/chat/MessageMarkdown`、`ChatInlineNotice`、`chat-scroll` | Runtime/定位仍使用；原路径、样式及测试保留，未改前端窗口文件。 |
| `services/agentSlice` 与 `routers/agentSlice.ts` | 仅旧 chat 页面调用；删除服务/路由及 root 注册、专属测试/夹具接线。数据库对象保留。 |
| `workbench.chat*` 9 个接口 | 仅旧 chat 页面调用；删除旧聊天接口与仅服务这些接口的客户端拆批分支。底层 artifacts/chat 保留用于旧请求恢复/访问校验。 |
| `workbench.execute/read/report/export` 等 | 定位页调用 execute，opc/service 使用 artifacts/workbench；旧 `/workbench` 也仍可达。保留，不整体删除。 |
| `/api/ai/stream`、`contextManager`、`streamingOutput` | 已关闭，但 billing.test.ts 的旧预扣/结算源码断言阻止删除；该文件在 Owner 禁改范围。先保留并在 PR 申请顺序。410 关闭规则不变。 |
| `modelRouter` | 被 diagnostics 与 routers/ai 使用，后者含计费估算/结算；先保留，不硬删。`routers/model.ts` 是在用后台配置路由，不等于旧 services/modelRouter。 |
| `aiOutputFilter`、`contentModerator` | 可达的 artifacts/generation 仍调用；保留，待旧生成退役排序。agentSlice 对它们的调用随服务删除。 |
| ordinary-chat 请求与计费恢复 | `/api/ai/requests`、访问校验、对账、计费与收款文件全部保持不变。 |

`legacy-runtime.mjs` 对历史固定 SHA 的 agentSlice 插桩保留：它验证旧版本恢复兼容性，
不是当前候选的可达入口。当前候选运行器已移除对被删 runner.ts 的读取。

## 功能对照（源码检查，不冒充产品验收）

本次删除的是 #507 已不可达的 chat 页面；没有把已关闭功能重新开放。
下表区分现有对应实现与尚未证明等价的差异，**不能据此宣称“完全无丢功能”**。

| 旧功能 | 现有承接位置 / 差异 |
| --- | --- |
| 自由对话、流式回复、多轮历史 | `/runtime` → runtime.prepare/executeStream/session；共享 MessageMarkdown 展示；AC-4 统一 Runtime。 |
| Skill 选择与执行、双模型回复/整理 | WorkComposer 的技能菜单、runtime.choices、统一 Runtime；旧 agentSlice 不再作为第二执行引擎。定位由 `/positioning` 的 mentorTurnStream/capture 流程承接。 |
| 模型选择 | 新服务仍有 choices/模型权限与后台配置；WorkComposer 当前只有 Skill 菜单，未找到旧普通聊天模型下拉框的同等入口。UI-MODEL 差异待总控确认，不能认定已接替。 |
| 引用、资料、来源隔离 | 新 Runtime source tools、OPC capture/library/source 及内容来源校验；旧 search-references 面板不保留。完整展示/操作等价性未做浏览器验收。 |
| 附件 | WorkComposer.addFiles 支持 TXT/MD/CSV/JSON/log，单文件 64 KB，内容加入消息；资料库文档扩展归 LIB-DOCS/在途前端，不以其尚未合并代码证明完成。 |
| 停止、重试、断线恢复 | `/runtime` 的 stop/recover、冻结 request、恢复查询与现有 Runtime 测试；旧 useStreamingChat 删除。 |
| 新开、重命名、归档、恢复、置顶、删除记录 | WorkspaceFrame/OPC conversations 管理；旧 conversations 只读入口已由 Master Plan 明确不再提供，不迁移或删除旧数据。 |
| 单条复制与成果编辑、版本/定稿 | 新 Markdown/内容编辑和报告流程保留；此记录未证明旧聊天逐消息按钮完全等价。 |
| 整段/批量聊天导出 | 旧 ExportDialog 已不可达；新工作区未找到等价整段/批量导出入口。报告/成果导出不等于聊天导出，待总控确认保留需求或明确退役。 |
| 余额、门槛、计费状态 | 新 Runtime/BILL2 与 payg 提示继续使用；本 PR 不改计费，也不主动处理旧冻结积分。 |
| 凭证保护、用户隔离 | 保留新 Runtime/OPC/资料库的鉴权、服务端 actor 校验、source 工具权限、私有方法保护及旧请求访问校验；没有迁移旧通用 PII 正则。仍被调用的旧过滤器暂未删除。 |

## #522 失效 e2e 清理

- 删除 chat.spec 全部 8 条、chat-balance-unavailable 专用用例/配置/桩。
- 混合文件仅删除依赖旧聊天的用例和无人调用的辅助函数：
  admin 的旧 runtime proof；user-supplemental 的旧余额发送；user-extended 的 5 项旧会话操作；
  parity-extended 的旧重命名/导出；admin-config 的旧聊天设置/免费发送/智能路由/搜索；
  admin-destructive 的旧模型选择/聊天公告/封禁后旧发送/旧 prompt 调用验证。
- admin-config 的设置持久化、公告 CRUD 保留，仅去除旧 chat 页面展示断言。
- security 的未登录工作区保护用例改为 `/positioning`，其他跨用户/附件/后台权限测试保留。
- critical 脚本去除已删 chat.spec；清理删除造成的 ESLint 抑制条目，只缩减。
- 清理 agentSlice 专属单测/集成测试和两个 SLICE 大用例，保留现行 Runtime/BILL2 安全验证。
- 保留的旧 stream/生成服务仍有历史集成测试；它们随上述受阻后端切片清理，不宣称本 PR 已覆盖全部历史测试。

## 数据库旧对象：仅交总控排查，不执行

- `conversations/messages/chat_requests` 等旧会话/请求对象及旧 token/账务记录：不能仅因页面删除就删表，
  请求恢复、对账、注销/删除链和历史财务兼容性仍可能依赖。
- `agent_slice_pairs/links/executions/calls` 与 `agent_slice_*` RPC、确认偏好对象（0081–0093 一带迁移）：
  当前 TS 入口退役不等于数据库调用权限已移除；应由独立任务追踪 SQL 依赖与历史数据后决定。
- artifacts/workbench 对象仍被 OPC/Runtime 使用，不能按“旧表”整体删除。

## 并行边界与阻塞

- 未修改 runtime/execute.ts、opc/service.ts、在途 #782/#783/#784/#785/#788/#789 的文件。
- #784 已合并；按总控排定顺序同步 staging 后，删除 28 个失效大小基线条目并降低 workbench.ts 的 1 个条目，未提高限制。大小检查已通过。
- 新开放 #794 与本 PR 已有的 apps/web/package.json 重叠；本 PR 仅删除 critical 测试脚本中的 chat.spec.ts，不再改该文件，合并顺序交总控安排。
- billing.test.ts 的旧 stream 源码断言已在 PR 说明，待总控安排；未绕过断言。
- modelRouter/旧 workbench/内容过滤仍有活跃引用，需总控安排后续退役；功能等价差异也未闭合。

## Handoff

- 已完成：独立 worktree 及草稿 PR；删除上述独占旧实现/测试；记录保留引用、功能差异和数据库候选清单。
- 下一步：本次同步与基线修复后刷新 CI/机器人复审；活跃旧接口、受限计费测试及功能差异仍由总控安排，不扩大本轮范围。
- 前轮已运行 PASS（非本轮最终版本）：API 全量 5931 通过/13 既有跳过（313 文件通过、2 文件跳过）；新增路由契约 1/1；
  Web 定向 37/37；Web/API typecheck 与 ESLint；Playwright `--list` 收集 140 项（不运行浏览器）。
- 本机无凭据 HTTP smoke：`/chat` 及旧参数均 307 到 positioning；stream 请求在限流层因无 Redis 配置返回 503，
  因此 HTTP 410 验证 BLOCKED；原生产关闭契约单测已在 API 全量内通过。
- 本轮：代码大小检查 PASS；完整验证及机器人复审结果以 PR 最新交接评论为准。
- NOT_RUN：本机浏览器、真实模型、远程数据库、生产、合并；无产品验收声明。

## 第二段：旧对话后端（2026-10-13）

范围以 Master Plan 第 7.1 节 LEGACY-CLOSE 一行为准。删除前逐项核对了静态 import、tRPC 客户端调用、测试和本地测试运行器。

| 删除对象 | 核对结果 |
| --- | --- |
| `/api/ai/stream`、`/api/ai/requests` 及 `lib/ordinary-chat-request`、`ordinary-chat-access`、`legacy-chat` | 只服务旧 `/chat`；#507 后发送已返回 410，页面已在 #792 删除。删除后旧地址返回 404。限流名单和测试观察器里的旧路径一并去掉。 |
| `services/contextManager`、`streamingOutput`、`contextSnapshots`、`modelRouter`、`chatRuntime`、`tokenCounter`、`promptCacheBuilder` | 只被上面的旧路由、`routers/ai` 和后台诊断的旧检查调用。`skillRuntime` 仍被 `routers/skills` 使用，保留。 |
| `routers/ai`（sendMessage、abortRequest、estimateCost、getAvailableModels、getConversationMessages、getTokenStats） | 前端和后台页面都没有调用；整组删除。后台模型管理用的是 `routers/model`，不受影响。 |
| `routers/chat` 除 `getConversations` 外的 11 个接口（新建、改名、删除、读消息、统计、导出、sendMessage） | 前端只剩个人中心"使用历史"调用 `getConversations`，保留它。 |
| 后台诊断的 6 项旧检查（智能路由、Token 计算、Prompt 缓存、上下文压缩、实时关键词、旧对话真实运行证据）和诊断页"最新真实运行证据"卡片 | 只读旧对话数据或调用旧路由；第 8 节第 3 条已定随 LEGACY-CLOSE 删除。模型状态、计费、限流、熔断、RLS 检查保留。 |
| 只测上述代码的测试 | 删除；`workbench.integration.ts` 中驱动已删 `/chat` 页面的 37 个 `CHAT:` 用例和依赖它的 `REAL SKILL`、两个 `REUSE` 用例一并删除（`/chat?module=` 跳转 `/positioning` 的后台用例保留）；`modelColumnGrants.integration.ts` 改为从后台模型页登录、只查保留的模型接口；本地运行器只选这些用例的 `--ordinary-only`、`--chat-only`、`--chat-reliability-only`、`--reuse-only`、`--real-skill-only` 改为报错退役，避免空跑当作通过；`billing.test.ts` 里对旧 stream 源码的断言、凭证边界测试里的旧路由用例、v3 Skill 集成测试里的旧模块提示词用例一并去掉，其余保留。 |

凭证保护和用户数据隔离：

- 删除的代码不被新 Runtime、定位、资料库调用（类型检查验证引用闭合）。新链路的密钥读取、actor 校验、来源工具权限没有改动。
- 模型密钥边界测试保留后台模型管理、诊断模型状态和非管理员拒绝三组；删除的只是已不存在的旧路由用例。
- 能按 ID 读旧对话消息的接口全部删除，剩下的 `getConversations` 仍只按当前用户读取。安全 e2e 里的旧对话跨用户用例随接口删除，工单跨用户用例保留。
- 没有迁移旧的通用 PII 正则过滤（Master Plan 已定不要求）。

未处理、留给后续：

- 后台设置页仍有只服务旧对话的设置项（智能路由、Prompt 缓存等），现在不再生效；是否从设置页移除交总控安排。
- `packages/db/tests/v3` 的旧版本兼容测试（legacy-runtime、bill2 upgrade）在历史固定版本上运行旧对话代码，保留。

## 第三段：旧 `/workbench` 与自研内容检查（2026-10-13）

| 删除对象 | 核对结果 |
| --- | --- |
| `apps/web/src/app/workbench/page.tsx`、`generation-panel.tsx`、`report-work-actions.tsx` | 新工作区没有链接指向旧 `/workbench`；`/workbench` 改为 307 跳到 `/positioning`。`/workbench/marketplace`、`/workbench/search` 是新工作区页面，保留。 |
| `workbench` 路由的 generationQuote、generate、generations、cancel/abandon/recoverGeneration、search、cancelSearch、createWork、workSource、referenceChoices、projects、rounds、report、export | 只被旧页面调用。保留 catalog、read、start、execute（定位、Runtime、功能详情在用）。 |
| `services/artifacts/generation.ts`、`services/research/workbenchSearch.ts` | 只被上面的接口使用。 |
| `services/contentModerator.ts`、`services/aiOutputFilter.ts` | 唯一调用方是旧成果生成。 |
| 后台设置页 19 项旧对话设置 | 见下表。 |

保留：`services/artifacts/reuse.ts`（Runtime 读资料的 `runtime_source` 和 CI 里的 Runtime 集成测试仍在用旧作品引用；只删了它在旧页面的接口）；`middleware/securityChecks.ts` 的 `checkOutputSecurity` / `sanitizeOutputSecurity`（现在只有自身测试使用，是否删除另议）。

MODERATION 检查点：`services/runtime/moderation.ts` 和 RATE-LIMIT 接线里的 `requireAllowedInput` / `allowedOutput` 调用没有改动，仍默认放行。

凭证保护：新链路的模型密钥只在调用供应商时由服务角色读出（`runtime/stagingTransport.ts`），不进入提示词，模型输出里不会出现；被删的正则输出过滤只作用于旧成果生成。按 Master Plan，不迁移旧的通用 PII 正则过滤。用户数据隔离：保留的 workbench 接口仍经登录、邮箱验证和服务端 actor 校验；删除的只是旧页面接口。

### 删除的后台设置项

依据：在 `packages/api/src`、`apps/web/src` 中，除设置页本身和设置路由的读取名单外，没有任何代码读取这些键（新 Runtime、PROMPT-CACHE、定位都不读）。数据库里已有的值不动。

| 设置键 | 原用途 |
| --- | --- |
| `enable_smart_routing`、`smart_routing_min_confidence` | 旧 `modelRouter` 智能路由 |
| `assistant_model_id` | 旧路由的辅助模型（同时去掉设置保存时对它的校验） |
| `enable_smart_search_decision`、`search_decision_min_confidence` | 旧对话联网判断 |
| `enable_prompt_cache` | 旧 `promptCacheBuilder`；Runtime 的提示缓存在 `runtime/promptCache.ts`，不读这个键 |
| `chat_show_model_selector`、`chat_prompt_text`、`chat_welcome_message`、`chat_billing_hint` | 旧 `/chat` 页面文案和模型下拉框 |
| `show_token_usage_stats`、`enable_long_text_warning`、`long_text_warning_threshold`、`max_messages_per_conversation` | 旧 `/chat` 页面统计、长文本提示、对话长度 |
| `enable_free_tier`、`free_tier_messages` | 旧对话免费体验 |
| `input_credits_per_1k`、`output_credits_per_1k`、`web_search_credits` | 旧对话计价（设置页已标"已退役 / 参考显示"） |

其中 11 项同时从设置路由对用户公开的读取名单里去掉。保留：`primary_model_id`（Runtime 自由对话默认模型）、`v3_summary_*`（Runtime 整理模型）、`search_surcharge_credits`（后台财务和搜索计费）、`home_*`、`max_input_characters`（新输入框正在别的窗口修改，暂不动）、`billing_*` 预扣设置（属计费服务，另议）、`first_purchase_bonus_percent`（不属于旧对话）。

### 测试和本地运行器

- `workbench.integration.ts` 只保留 `ADMIN:` 用例和 4 个搜索计费存储用例；旧页面浏览器流程、旧生成、旧工作台搜索、CONSUMPTION 用例删除。后台用例的登录改走 `/positioning`。
- 本地运行器退役 `--workbench-restart-only` 和不带 `--opc-only` / `--runtime-only` 的 `--serve`（都依赖已删的旧页面用例），去掉重启阶段和对已删文件的源码替换。
