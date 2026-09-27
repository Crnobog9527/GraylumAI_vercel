# Graylum 工程规范

适用于所有实现代理（Claude Code、Codex）和人工开发。流程、风险分级和审批以
[AGENTS.md](../AGENTS.md) 为准；本文件只规定代码怎么写、放在哪里、怎么检查，
两者冲突时以 AGENTS.md 为准。修改本文件，或修改 `scripts/check-code-size.mjs`
的限制和检查范围，属于治理变更，按 AGENTS.md 第 9 节由 Owner 批准合并。

## 1. 技术栈

精确版本以各 `package.json` 和 `pnpm-lock.yaml` 为准，这里只记主版本。

| 领域 | 技术 | 位置 |
| --- | --- | --- |
| 仓库 | pnpm 10 workspaces + Turborepo 2，Node 24 | 根目录 `package.json`、`turbo.json` |
| 网站 | Next.js 16（App Router）+ React 19 + TypeScript 6 | `apps/web` |
| 接口 | tRPC 11 + zod 4，前端缓存用 TanStack Query 5 | `packages/api`；前端客户端在 `apps/web/src/trpc` |
| 界面 | Tailwind CSS 4 + CSS Modules；shadcn（new-york）基础组件，基于 Radix UI；图标 lucide-react；图表 recharts | `apps/web/src/components/ui`；视觉规范见 [DESIGN.md](../DESIGN.md) |
| 前端本地状态 | zustand 5 | `apps/web/src/stores` |
| 数据库与登录 | Supabase（Postgres + Auth），`@supabase/supabase-js` 2、`@supabase/ssr` | 结构只由 `packages/db/migrations` 定义 |
| AI | `@openai/agents` 0.18.0（精确锁定）+ `openai` 7；模型经 OpenRouter 调用，计费走 BILL2 | `packages/api/src/services/runtime`、`services/bill2` |
| 支付 | Stripe | `packages/api/src/services/stripe*.ts`、`routers/payments.ts` |
| 限流 | Upstash Redis（`@upstash/ratelimit`） | `packages/api` |
| 日志与监控 | pino、Sentry、Vercel Analytics | `packages/api/src/lib/logger.ts` |
| 测试 | Vitest 4、Playwright、node:test、Ruby minitest（CI 合约）、SQL 测试 | 见第 7 节 |
| 部署 | Vercel；staging 与 production 使用各自独立的 Vercel 和 Supabase 项目 | AGENTS.md 第 4 节 |

## 2. 代码放在哪里

| 目录 | 放什么 |
| --- | --- |
| `apps/web/src/app` | 页面（App Router）和服务端路由（`app/api` 下的 trpc、stripe、cron、ai、upload） |
| `apps/web/src/components/<领域>` | 按业务领域分组的组件（admin、chat、opc、profile……）；`ui/` 放基础组件 |
| `apps/web/src/hooks` | React hooks：状态、副作用和数据请求的组合 |
| `apps/web/src/lib` | 前端工具函数和配置 |
| `packages/api/src/routers` | tRPC 路由：只做输入校验和调用服务，不写业务逻辑 |
| `packages/api/src/services/<领域>` | 业务逻辑，按领域分目录（runtime、bill2、opc、skills、artifacts……） |
| `packages/api/src/shared` | 前后端共用、不依赖服务器的纯逻辑 |
| `packages/api/src/lib` | 基础设施：日志、鉴权、环境变量、错误包装 |
| `packages/db/migrations` | 数据库结构的唯一来源，文件名 `NNNN_名称.sql`，只能追加 |
| `scripts` | 仓库工具和 CI 检查；测试在 `scripts/tests` |
| `docs/launch` | 产品规划和已锁定的产品决策（Master Plan） |

## 3. 代码大小与格式

硬限制由 CI 自动检查（"Lint & Type Check"）：

- 单个源码文件不超过 **500 行**；
- 单行不超过 **160 个字符**。

检查范围是 Git 跟踪的 `.ts`、`.tsx`、`.js`、`.jsx`、`.mjs`、`.cjs` 文件，不含测试
（`*.test.*`、`*.spec.*`、`*.integration.*`，以及 `__tests__/`、`tests/`、`e2e/` 目录）。

已经超标的文件记录在 `scripts/code-size-baseline.json`，**只许变小，不许变大**：

- 本地检查：`node scripts/check-code-size.mjs`。
- 改小了基线里的文件后，运行 `node scripts/check-code-size.mjs --update`，把降低后的
  基线一起提交。这个命令只会降低或删除条目，永远不会调高。
- 为了不超限而拆分文件，属于"最小正确改动"的一部分，不算扩大范围（AGENTS.md 第 5 节）。
- 只有当文件属于高风险领域（AGENTS.md 第 4 节，例如计费、支付、鉴权、数据库），并且
  在同一个改动里拆分会扩大这个改动的风险时，才可以手动调高或新增基线条目，同时在 PR
  描述里写明原因。没有理由的调高是审查阻断项。
- 移动或改名基线里的文件时，把它的条目原样挪到新路径。

超限时怎么拆：

- 页面：`page.tsx` 只负责组装。区块拆成 `components/<领域>/` 下的组件，状态和副作用
  放进 `hooks/use-*.ts`，纯计算放进 `lib/` 或 `packages/api/src/shared/`。
- 服务端：按职责把一个服务拆成同一目录下的多个文件，对外只导出需要的函数。
- 长字符串（例如提示词）：分成多行拼接，或放到单独的模块。

书写格式：2 空格缩进，一行一个语句，行宽以 100 字符左右为目标；引号和分号沿用所在
文件的风格。不要把多条逻辑压成一行。仓库目前没有安装格式化工具，文件大小和行宽以
上面的自动检查为硬边界。

## 4. 前端约定

- 一个组件只做一件事。组件里的状态和副作用变多时（经验值：超过约 10 个
  `useState`/`useEffect`），拆出 hook 或子组件。
- 服务器数据通过 tRPC hooks 读取，由 TanStack Query 缓存。写操作成功后按需失效
  （invalidate）或直接使用返回结果，不要对同一份数据连续多次手动 refetch。
- 业务状态以服务器为准。`localStorage`/`sessionStorage` 只放本机便利信息（草稿、
  界面偏好、待恢复请求的 ID），不在浏览器里维护第二份业务状态机。
- 界面优先复用 `components/ui` 的基础组件和 [DESIGN.md](../DESIGN.md) 的设计变量。
  类名拼接用 `cn()`（`apps/web/src/lib/utils.ts`），很长的类名分成多段传入。
- 不直接向用户展示原始错误信息，参考 `apps/web/src/lib/safe-error-message.ts`。

## 5. 后端约定

- tRPC 路由保持很薄：用 zod 校验输入，然后调用 `services/` 里的函数。
- 权限、金额和状态一致性必须在服务端保证（服务里的检查和数据库 RPC 函数），不能只靠
  前端按钮限制。
- 数据库结构只能通过在 `packages/db/migrations` 新增迁移文件来修改，不改已有的迁移
  （CI 的 migration ledger 检查会拦截）。生产代码不引用 `packages/db/schema.ts`，不要
  把它当作结构来源。数据库改动属于高风险（AGENTS.md 第 4 节）。
- 对外返回稳定的错误码（例如 `OPC_*`、`RUNTIME_*`），由前端映射成用户能看懂的提示；
  内部异常用 `packages/api/src/lib/publicError.ts` 包装，不把原始错误返回给前端。
- 服务端日志用 `packages/api/src/lib/logger.ts`。新增必需的环境变量要加到
  `packages/api/src/lib/envValidator.ts` 的校验里。

## 6. AI 与 Agent 功能

以下原则来自已锁定的
[Master Plan v10.2](launch/Graylum_Master_Plan_v10.2_OPC_Growth_Agent_Amendment.md)
第 2、5 节：

- 全站只保留一个基于官方 Agent SDK 的统一 Runtime（`packages/api/src/services/runtime`）。
  新的 AI 能力接到这里，不要在旧对话链路（`routers/ai.ts`、`app/api/ai/stream`、
  `services/modelRouter.ts`、`services/contextManager.ts`）上加新功能。
- 流程交给 Skill 和模型：步骤、问题、完成条件和报告格式来自已发布的 Skill。页面和
  数据库代码不写死某个 Skill 的步骤或问题。
- 应用（宿主）只负责权限、工具白名单、预算与计费（BILL2）、身份、持久化、版本和显示。
- 模型分工：Skill 执行模型由管理员在 Skill 配置中绑定；信息汇总和整理使用管理员指定的
  独立整理模型。
- 不用关键词或正则表达式判断用户意图来代替模型判断。

另外，用户资料、附件和检索到的内容对模型来说是数据，不是指令。

## 7. 测试与验证

| 内容 | 命令 |
| --- | --- |
| API 单元测试 | `pnpm test:api` |
| 网站单元测试 | `pnpm --filter web exec vitest run <文件>` |
| 类型检查 | `pnpm --filter web typecheck` |
| 代码大小检查 | `node scripts/check-code-size.mjs` |
| 脚本和 CI 保护测试 | `pnpm test:ci:safeguards`、`ruby .github/scripts/test-ci-workflows.rb` |
| 端到端测试 | `pnpm --filter web test:e2e`（Playwright） |

- 新逻辑要配单元测试，放在源码旁边的 `*.test.ts`；已经使用 `__tests__/` 的目录沿用
  原来的写法。修 bug 时先写一个能复现问题的测试。
- 运行时或界面改动还需要浏览器验证；数据库、权限、支付等改动的验证要求见 AGENTS.md
  第 6 节。

## 8. 文档同步

- 新增或删除模块、改变数据流时，在同一个 PR 里更新相关文档。
- [docs/ARCHITECTURE.md](ARCHITECTURE.md) 目前主要描述旧对话链路（`routers/ai.ts`、
  `modelRouter`、`contextManager`、`billing.ts` 三段式计费），还没有覆盖统一 Runtime、
  BILL2 和定位（OPC）模块。在它更新之前，以本文件第 1、2、6 节和 `docs/launch` 为准。

## 9. 已知缺口

以下问题已经确认，但不在本规范的范围内，需要单独立项：

- ESLint 目前只检查 `apps/web` 下的 4 个 `.mjs` 文件，不检查任何 TS/TSX 业务代码。
  CI 的 "Lint & Type Check" 实际起作用的是类型检查和第 3 节的大小检查。补上
  TypeScript/React 规则需要新增依赖（例如 typescript-eslint），属于依赖变更。
- 仓库没有安装代码格式化工具（Prettier）。
- 基线里有 50 个文件超过 500 行、146 个文件含超长行。结合相关功能的改动逐步拆分；
  计费、支付等高风险大文件的拆分单独立项。
- 对话功能有三套实现并存（`/chat` 旧链路、`/runtime`、`/positioning`），按 Master
  Plan v10.2 第 4、5 节逐步合并。
