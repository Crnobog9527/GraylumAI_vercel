# Graylum 工程规范

适用于所有实现代理（Claude Code、Codex）和人工开发。流程、风险分级和审批以
[AGENTS.md](../AGENTS.md) 为准；本文件只规定代码怎么写、放在哪里、怎么检查，
两者冲突时以 AGENTS.md 为准。修改本文件，或修改 `scripts/check-code-size.mjs`
的限制和检查范围，属于规则变更，按 AGENTS.md 第 1 节由 Owner 批准合并。

## 1. 技术栈

精确版本以各 `package.json` 和 `pnpm-lock.yaml` 为准，这里只记主版本。

| 领域 | 技术 | 位置 |
| --- | --- | --- |
| 仓库 | pnpm 10 workspaces + Turborepo 2，Node 24 | 根目录 `package.json`、`turbo.json` |
| 网站 | Next.js 16（App Router）+ React 19 + TypeScript 6 | `apps/web` |
| 接口 | tRPC 11 + zod 4，前端缓存用 TanStack Query 5 | `packages/api`；前端客户端在 `apps/web/src/trpc` |
| 界面 | Tailwind CSS 4 + CSS Modules；shadcn（new-york）基础组件，基于 Radix UI；图标 lucide-react；图表 recharts | `apps/web/src/components/ui`；视觉规范见 [DESIGN.md](../DESIGN.md) |
| 前端本地状态 | zustand 5 | `apps/web/src/stores` |
| 数据库与登录 | Supabase（PostgreSQL 17 + Auth），`@supabase/supabase-js` 2、`@supabase/ssr` | 结构以 `packages/db/baseline` 和 `packages/db/migrations` 为准 |
| AI | `@openai/agents` 0.18.0（精确锁定）+ `openai` 7；模型经 OpenRouter 调用，计费走 BILL2 | `packages/api/src/services/runtime`、`services/bill2` |
| 支付 | Stripe | `packages/api/src/services/stripe*.ts`、`routers/payments.ts` |
| 限流 | Upstash Redis（`@upstash/ratelimit`） | `packages/api` |
| 日志与监控 | pino、Sentry、Vercel Analytics | `packages/api/src/lib/logger.ts` |
| 测试 | Vitest 4、Playwright、node:test、Ruby minitest（CI 合约）、SQL 测试 | 见第 7 节 |
| 部署 | Vercel；staging 与 production 使用各自独立的 Vercel 和 Supabase 项目 | AGENTS.md 第 0 节 |

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
| `packages/db/baseline` | 空库缺失的迁移前提；`bridges/` 的衔接脚本在同名迁移之前执行，规则见该目录 README |
| `packages/db/migrations` | 后续数据库结构变更，文件名 `NNNN_名称.sql`，只能追加 |
| `scripts` | 仓库工具和 CI 检查；测试在 `scripts/tests` |
| `docs/launch` | 产品规划和已锁定的产品决策（Master Plan） |

本机开发：主仓库的 `apps/web/.env.local` 指向正式库，任何 Agent 都不许用它起本机服务或跑测试
（2026-10-25 发现）。

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
- 手动调高或新增基线条目等于放宽检查，按 AGENTS.md 第 1 节需要 Owner 批准。只有当文件
  属于计费、支付、鉴权、数据库等领域，并且在同一个改动里拆分会扩大这个改动的风险时，
  才可以申请，同时在 PR 描述里写明原因。没有批准的调高是审查阻断项。
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
- 公开页面（不登录就能打开、对搜索引擎开放的页面，例如落地页、价格、常见问题、教程、
  About、`/zh-tw` 下的页面和以后的博客）新增或修改时，必须遵守
  [SEO/GEO 规范](launch/SEO_GEO_SPEC.md)，并在 PR 描述里逐项勾选规范第 13 节检查单。
  元数据、JSON-LD 和 sitemap 走 `apps/web/src/lib/seo` 的统一函数，不在页面里自己拼。
  登录后才能看到的页面不在此列（它们始终 `noindex`）。

## 5. 后端约定

- tRPC 路由保持很薄：用 zod 校验输入，然后调用 `services/` 里的函数。
- 权限、金额和状态一致性必须在服务端保证（服务里的检查和数据库 RPC 函数），不能只靠
  前端按钮限制。
- 数据库结构只能通过在 `packages/db/migrations` 新增迁移文件来修改，不改已有的迁移
  （CI 的 migration ledger 检查会拦截）。新迁移编号必须大于 staging 上已有的最大编号、
  全仓不重复，允许空号（Owner 2026-10-25 批准的规则变更，取代"编号必须连续"）；
  staging 是否漏应用用 `scripts/check-staging-migrations-applied.mjs` 核对。`packages/db/baseline` 只补空库缺失的前提，
  不承载新的业务结构；基线和衔接脚本的例外规则见
  [baseline/README.md](../packages/db/baseline/README.md)。`db:push` 已退役。
  `packages/db/schema.ts` 只作类型参考，生产代码不引用它；结构以 `migrations/` 和
  `baseline/` 为准。数据库改动的验证要求见 AGENTS.md 第 4 节，上正式环境须 Owner 批准（第 1 节）。
- 对外返回稳定的错误码（例如 `OPC_*`、`RUNTIME_*`），由前端映射成用户能看懂的提示；
  内部异常用 `packages/api/src/lib/publicError.ts` 包装，不把原始错误返回给前端。
- 服务端日志用 `packages/api/src/lib/logger.ts`。新增必需的环境变量要加到
  `packages/api/src/lib/envValidator.ts` 的校验里。

### 数据库文件建库与指纹

空库使用 PostgreSQL 17，按以下顺序建库；共享实现是
`packages/db/tests/baseline/build-from-files.mjs`：

1. 平台前提：Supabase 提供角色、`auth.uid()`、扩展以及 `extensions`、`storage` schema；
   本机用 `packages/db/tests/baseline/platform-local.sql` 替代，不能把替身应用到正式环境。
2. 按文件名顺序执行 `packages/db/baseline/*.sql`，目前为 `0000_core_prerequisites.sql`。
3. 按文件名顺序执行 `packages/db/migrations` 的全部迁移；
   `packages/db/baseline/bridges/<迁移同名>.sql` 紧接在同名迁移之前执行。

基线和衔接脚本仅用于空库，不能应用到已有 staging 库。结构变更 PR（新迁移、基线或
衔接脚本变化）必须运行下面的命令，更新并提交
`packages/db/tests/baseline/built-fingerprint.json`；CI 会逐对象比对：

```bash
node packages/db/tests/run-db-baseline-replay.mjs --local-only --write-built
```

新迁移必须在它自己的历史位置连续执行两次且结构不变。回放目前检查从 0067 起的全部
迁移；确实不能重复执行的例外须在 `build-from-files.mjs` 的 `NOT_REPEATABLE` 中注明原因，
并随高风险 PR 独立审查，当前没有例外。

经批准向 staging 应用迁移前后，都要在 READ ONLY 事务中用
`packages/db/tests/baseline/fingerprint.sql` 抓取只读结构指纹，并分别运行：

```bash
node packages/db/tests/run-db-baseline-replay.mjs --local-only --staging <只读快照.json>
```

只允许 `expected-differences.json` 中列出的差异；已合并但未应用的迁移对象可临时列入
`pendingOnStaging`，应用后更新 `staging-fingerprint.json` 和差异清单。`--staging` 只读取
快照文件并与本机建库比对，不连接远程数据库。正式建库的整段 SQL 执行、平台设置和
建库后比对要求见 [REL-1 注意事项](runbooks/STAGING_REPRODUCIBILITY.md#rel-1-file-built-release-database)。

#### 迁移和代码的上线顺序

迁移改了数据格式、而已部署的旧代码读不懂新格式时，先合并并部署能同时读新旧两种格式的代码，
部署成功后再上迁移；不能先上迁移再等部署（2026-10-25 #1349 事故后定）。

#### 改已有数据库函数的写法

（Owner 2026-10-26 批准的规则变更。）`packages/db/functions/` 存着每个 `public` 函数在全部迁移之后的
当前全文。改一个已有函数时：

1. 从 `packages/db/functions/<分组>/<函数名>.sql` 拷出它的当前全文，整段修改；
2. 在新迁移里用 `CREATE OR REPLACE FUNCTION` 写出修改后的完整定义。需要确认 staging 上的旧版本
   就是这份全文时，可以先用 `md5(pg_get_functiondef(...))` 比对，不一致就报错停止；
3. 禁止在迁移里读出函数文本再改写：`pg_get_functiondef` 或 `prosrc` 配合 `replace`、`regexp_replace`、
   `overlay`、`position`、`strpos` 之类的文本补丁，包括写成 `pg_temp` 辅助函数的补丁。CI 的
   `node scripts/check-function-patches.mjs` 拦截 0398 起的新迁移；0397 及以前的老迁移不追究；
4. 迁移开头的注释写清：新旧代码能否兼容、能否重复执行、出问题怎么恢复；
5. 运行 `node packages/db/tests/run-db-baseline-replay.mjs --local-only --write-built`，把重新生成的
   `packages/db/functions/` 和 `built-fingerprint.json` 一起提交。任何带迁移的 PR 都要这样做；合并冲突时
   先解决迁移冲突，再重新生成，不手工合并这些文件。

### 主路径约束（CORE-PATH-V2，Owner 2026-10-28 批准）

适用范围：主路径 v2 的代码，即 `packages/api/src/services/turn/`、`packages/db/functions/turn/` 以及它们调用的账本函数；计划见 `docs/launch/tasks/CORE-PATH-V2.md`。旧路径（`services/runtime/`、`services/bill2/`）在 V2-12 删除前只做必要修复，不加新功能。

- 主路径的表主键带所有者列，查询必须带所有者键；不得对全站共用行加锁或更新（按天累计类数据用分桶行）；数据库函数只用事务级状态（不用 `pg_advisory_lock`、非 LOCAL 的 `SET`、临时表），以兼容连接池事务模式；后台定时任务按批认领（`SKIP LOCKED`）、幂等、可多实例并行；对外部供应商的调用按模型/供应商设并发上限并做退避。
- 一轮对话只允许三类数据库写入：开轮（`turn_open`）、回执（`turn_call_begin`/`turn_call_identity`/`turn_call_record`，每次付费调用发出前必须先写 `turn_call_begin`）、收轮（`turn_close`）。模型调用与工具调用之间不得有其他数据库读写；需要的数据在开轮时取回，或来自进程内目录缓存。例外（Owner 2026-10-28 批准）：免费的读取工具（读用户自己的资料库、作品）可以在回合中途按本人键只读查询一次，不加锁、不写入，不写回执；次数按本轮免费工具上限计，冻结进 `turns.policy`。
- 免费只读函数（`FREE_READS`，Owner 2026-10-28）的扫描（Owner 2026-11-01 放宽）：第一个参数是 `p_actor_id`，走到的每个函数都是 STABLE/IMMUTABLE，不写、不加锁，自身按所有者验证。每条查询带所有者键，只有两类表例外，且都写在 `scripts/db-function-closure.mjs` 的明确名单里：① `FREE_READ_LINKED`：本身没有所有者列、必须从已验证属于本人的行按 id 关联下来的表（如 `artifact_versions`、`artifact_rounds`），每条查询要用名单里的键点名这一行；② `FREE_READ_CATALOG`：全站只读目录表。名单外没有所有者列的表一律不通过；往名单加表要 Owner 批准。
- 付费调用在 SDK 和 HTTP 客户端里不重试（`maxRetries` 为 0）；只有确定没发出或确定不计费的失败可以重试，每次尝试各自一行回执；结果不明的调用交恢复任务，不退冻结、不释放预占。
- 主路径的数据库函数只能读写 `turns`、`turn_calls`、`session_messages`、`runtime_sessions`、`profiles`、`credit_transactions`、`credit_source_entries`、`daily_spend`、`catalog_versions`，以及按 `kind` 需要的草稿/报告/评审表各一行；只允许对本人 `profiles` 和本会话 `runtime_sessions` 加行锁；不得对任何全站共用行加锁。例外（Owner 2026-10-29 批准）：扣积分和结算用到的账本函数（`atomic_pre_deduct`、`turn_settle_credits`、`credit_available`、`credit_source_apply`，含其中按订阅期、积分包记账的来源记录，如 `subscription_credit_grants`）不受这条表白名单限制，按账本叶子计数；结算积分时，这些账本函数还可以锁住用户本人的订阅期和积分包来源记录（Owner 2026-10-29 另行批准），只限本人的行，其他行锁限制照旧。它们只能读写本人的账本行。例外（Owner 2026-10-30 批准）：`kind=mentor` 的回合可以在收轮事务内写本回合对标工具产生的 `research_*` 派生行，只限本人、本回合的行，不加这条之外的行锁；回合中途仍不得写 `research_*`。
- 全站只读、管理员写的目录（系统设置、模型目录、Skill 包、权益规则）必须通过 `catalogCache` 读取；余额、冻结、墓碑、会话状态、用户写入的数据永不缓存。
- staging 与正式环境不得有代码分支；环境差异只能是配置（密钥、地址、价格快照、账号积分）。
- `scripts/check-turn-budget.mjs` 的基线只许变小（调高需 Owner 批准；Owner 2026-10-30 批准导师非开场回合 ≤ 11 → ≤ 12，2026-10-31 批准账号策略草稿 ≤ 13，见计划 3.1）；碰主路径的 PR 描述写明往返/锁/数据库时间的前后值。
- 新的业务规则要进主路径时，先问"它属于开轮、回执还是收轮"，只在那一个函数里加分支；需要新表才能表达的，先在 PR 里写一句为什么现有列不够。

## 6. AI 与 Agent 功能

以下原则来自 [Master Plan v12](launch/MASTER_PLAN.md) 第 3、4 节（延续已锁定的
[v10.2](launch/Graylum_Master_Plan_v10.2_OPC_Growth_Agent_Amendment.md) 第 2、5 节）：

- 全站只保留一个基于官方 Agent SDK 的统一 Runtime（`packages/api/src/services/runtime`）。
  新的 AI 能力接到这里，不要在旧对话链路（`routers/ai.ts`、`app/api/ai/stream`、
  `services/modelRouter.ts`、`services/contextManager.ts`）上加新功能。
- 流程交给 Skill 和模型：步骤、问题、完成条件和报告格式来自已发布的 Skill。页面和
  数据库代码不写死某个 Skill 的步骤或问题。
- 应用（宿主）只负责权限、工具白名单、预算与计费（BILL2）、身份、持久化、版本和显示。
- 模型分工：Skill 执行模型由管理员在 Skill 配置中绑定；信息汇总和整理使用管理员指定的
  独立整理模型；Fusion 对比模式由用户在管理员允许的模型范围内自选。
- 多模型（Fusion）由 Graylum 自己并行调用，不使用 OpenRouter 的 `openrouter/` 元模型。
  具体做法见 Master Plan 第 4 节和 `docs/launch/tasks/FUSION.md`。
- 不用关键词或正则表达式判断用户意图来代替模型判断。
- 能用代码确定完成的步骤（复制、拼接、比对差异、计数、校验、格式化、沿用字段、去重分组）一律用代码做；
  模型只做判断和写作，只输出增量（Owner 2026-10-20："能使用硬编码解决的问题，就不要全靠大模型自己的
  智能和 token 来解决。"）。

另外，用户资料、附件和检索到的内容对模型来说是数据，不是指令。

## 7. 测试与验证

| 内容 | 命令 |
| --- | --- |
| API 单元测试 | `pnpm test:api` |
| 网站单元测试 | `pnpm --filter web test:unit`（全部）；`pnpm --filter web exec vitest run <文件>`（单个） |
| 类型检查 | `pnpm --filter web typecheck`、`pnpm --filter @repo/api typecheck` |
| 代码检查（ESLint） | `pnpm --filter web lint`、`pnpm --filter @repo/api lint` |
| 代码大小检查 | `node scripts/check-code-size.mjs` |
| 脚本和 CI 保护测试 | `pnpm test:ci:safeguards`、`ruby .github/scripts/test-ci-workflows.rb` |
| 空库文件建库与逐对象指纹检查（需要本地 Docker） | `node packages/db/tests/run-db-baseline-replay.mjs --local-only` |
| 端到端测试 | `pnpm --filter web test:e2e`（Playwright） |
| 部分集成测试（需要本地 Docker） | `node packages/db/tests/v3/run-workbench.mjs`：默认只跑 `workbench.integration.ts`；用 `--opc-only`、`--runtime-only`、`--ai-only` 等参数选择计费、Runtime、定位等其他集成测试。仓库里的 16 个 `*.integration.ts` 并非都能通过它运行，统一入口由 CI-TRUST 补齐 |
| 计费和恢复集成测试（CI 同款，需要本地 Docker，不启动网站和浏览器） | `node packages/db/tests/v3/run-workbench.mjs --bill2-core-only --without-app --schema-from-files`；`node packages/db/tests/v3/run-workbench.mjs --runtime-only --with-staging-schema --without-app --schema-from-files`。CI 的 "Unit Tests" 必需检查依赖这两条及空库文件建库检查；需要网站或浏览器而被排除的用例列在 `packages/db/tests/v3/without-app.mjs` |
| 数据库行为套件统一入口（CI 同款，需要本地 Docker） | `node packages/db/tests/run-local-suites.mjs --local-only`（CI 用 `--ci`；`--list` 只列出，`--only <目录>` 只跑一个目录）。自动发现 `packages/db/tests/<目录>/` 下文件名带 `-local` 的套件，默认全部进 CI；暂时不能跑的写进 `packages/db/tests/local-suites-excluded.json`（要有原因和日期，只许变少，`scripts/tests/local-suites.test.mjs` 检查）。新套件的入口要接受 `--ci`（在 CI）和 `--local-only`（本机）。空库建库回放还会检查：标 STABLE/IMMUTABLE 的函数体里不许写数据或加行锁（PostgREST 对它们开只读事务），误报才可写进 `packages/db/tests/baseline/volatility-allow.json`，同样只许变少 |

- ESLint 用 typescript-eslint 推荐规则检查 TS/TSX，网站另加 React Hooks 的
  `rules-of-hooks` 和 `exhaustive-deps`。已有问题记在各包的 `eslint-suppressions.json`
  （ESLint 批量抑制），只许变少：新问题直接报错；修掉旧问题后运行
  `pnpm exec eslint --prune-suppressions`（在对应包目录下）把基线一起提交，否则检查会因
  "有未使用的抑制"失败。文件改名或移动会让原来的抑制失效，要在同一个 PR 里修掉或按原样
  迁移。
- `packages/api/tsconfig.json` 的 `exclude` 列出了加入独立类型检查时已有类型错误的测试
  文件，也只许变少，并且必须和 `packages/api/type-check-baseline.json` 完全一致。
  `node scripts/check-api-type-baseline.mjs`（CI 同款）只能发现两种情况：两处不一致；某个
  被排除的文件已经没有类型错误（这时要把它从两处一起删掉）。
- 这两个基线和第 3 节的代码大小基线一样，自动检查不和目标分支比较：用 `--suppress-all`
  或手工调大计数来放过新的 ESLint 问题，或者把新文件同时加进 `exclude` 和
  `type-check-baseline.json`，CI 都发现不了。这些都等于调高基线，是审查阻断项。
- typescript-eslint 8.71.0 要求 TypeScript 低于 6.1.0。以后把 TypeScript 升到 6.1 或更高时，
  要同时升级 typescript-eslint（`apps/web` 和 `packages/api` 两处）。
- 新逻辑要配单元测试，放在源码旁边的 `*.test.ts`；已经使用 `__tests__/` 的目录沿用
  原来的写法。修 bug 时先写一个能复现问题的测试。
- 运行时或界面改动还需要浏览器验证；数据库、权限、支付等改动的验证要求见 AGENTS.md
  第 4 节。
- 往 CI 加测试或测试套件时，PR 描述写明加入后该 job 的实测总时长，离 30 分钟上限至少留 8 分钟；
  不够就拆成并行 job。不许调大超时时间：调大超时算放宽 CI，要 Owner 批准（2026-10-26 #1404 教训）。
- 作为门槛的检查（代码大小、类型检查、测试等）不能接管道或用别的方式吞掉失败（例如接 `| tail`
  后再提交推送）：要单独运行看退出码，或者用 `set -o pipefail`。检查没过不能提交推送
  （2026-10-13 #900 教训）。

## 8. 文档同步

- 新增或删除模块、改变数据流时，在同一个 PR 里更新相关文档。
- [docs/ARCHITECTURE.md](ARCHITECTURE.md) 目前主要描述旧对话链路（`routers/ai.ts`、
  `modelRouter`、`contextManager`、`billing.ts` 三段式计费），还没有覆盖统一 Runtime、
  BILL2 和定位（OPC）模块。在它更新之前，以本文件第 1、2、6 节、
  [项目地图](PROJECT_MAP_FOR_OWNER.md) 和 `docs/launch` 为准。

## 9. 已知缺口

以下问题已经确认，但不在本规范的范围内，已列入 [Master Plan v12](launch/MASTER_PLAN.md)
第 7、8 节的任务（主要是 CI-TRUST 和 LEGACY-CLOSE）：

- ESLint 和 API 类型检查已经打开，但靠第 7 节的基线放过了已有问题（ESLint：网站 57 个
  文件 130 处、API 102 个文件 587 处；API 类型检查：35 个测试文件共 683 处，排除在外）。
  结合相关功能的改动逐步修掉。
- 集成测试（`*.integration.ts`，约 2 万行）只有计费（`bill2/billing.integration.ts`）和 Runtime 恢复与流式
  （`runtime/runtime.integration.ts`、`runtime/streaming.integration.ts`）在 CI 里运行，其中需要网站或浏览器的
  5 个用例被明确排除（见 `packages/db/tests/v3/without-app.mjs`）；定位（OPC）、工作台等其余集成测试仍不在 CI 里；
  网站单元和组件测试已全部在 CI 里运行（`pnpm --filter web test:unit`）。
- 仓库没有安装代码格式化工具（Prettier）。
- 基线里有 50 个文件超过 500 行、146 个文件含超长行。结合相关功能的改动逐步拆分；
  计费、支付等高风险大文件的拆分单独立项。
- 对话界面有三套（`/chat`、`/runtime`、`/positioning`），引擎两套（`/chat` 用旧引擎），
  按 v12 第 3、8 节合并为一个工作区并下线旧链路。
