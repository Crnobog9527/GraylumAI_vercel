# LEGACY-CLOSE 删除与功能对照

状态：部分实施，**未完成 LEGACY-CLOSE，不合并**。
基线 staging `c91c526d3c43fb5e0b28c2a0a1942b457590fa3a`。
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
- `scripts/code-size-baseline.json` 与 #784 实际重叠：删除后基线必需缩减，已请求总控排顺序，尚未修改。
  当前大小检查因此 FAIL；不是允许忽略的检查。
- billing.test.ts 的旧 stream 源码断言已在 PR 说明，待总控安排；未绕过断言。
- modelRouter/旧 workbench/内容过滤仍有活跃引用，需总控安排后续退役；功能等价差异也未闭合。

## Handoff

- 已完成：独立 worktree 及草稿 PR；删除上述独占旧实现/测试；记录保留引用、功能差异和数据库候选清单。
- 下一步：总控安排共享基线及旧计费测试；决定活跃旧接口退役顺序与功能差异归属；继续删除受阻部分并刷新 CI/审查。
- 已运行 PASS：API 全量 5931 通过/13 既有跳过（313 文件通过、2 文件跳过）；新增路由契约 1/1；
  Web 定向 37/37；Web/API typecheck 与 ESLint；Playwright `--list` 收集 140 项（不运行浏览器）。
- 本机无凭据 HTTP smoke：`/chat` 及旧参数均 307 到 positioning；stream 请求在限流层因无 Redis 配置返回 503，
  因此 HTTP 410 验证 BLOCKED；原生产关闭契约单测已在 API 全量内通过。
- FAIL：代码大小基线需缩减；远端最终 CI/机器人审查结果以 PR 交接评论为准。
- NOT_RUN：本机浏览器、真实模型、远程数据库、生产、合并；无产品验收声明。
