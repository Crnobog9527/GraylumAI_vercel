# V3-PACKAGE-RESEARCH：仓库实现与隔离验证

本批为 Owner 选择的 V3-PACKAGE-RESEARCH，仅到 staging PR 合并决策前。风险 **high**（私有正文权限、数据库事务、MCP 依赖）。不改变旧 M3 出口，不代表整个 V3 节点完成或授权后续任务。

## 实现与边界

- 0064 新增私有包、原字节文件、独立不可变撤销记录，复用 skills / skill_revisions 与原 loader。包 hash 绑定身份、文件 inventory、入口 hash 和管理员明确审阅的资源计划。发布器用现有 YAML 校验器完整检查载荷，再以一次 RPC 锁定 Skill、核对预期版本、插入 revision/所有文件、推进发布指针。重复请求核对身份/manifest/原字节；过期版本拒绝；任一失败回滚。旧文本发布/草稿入口不能覆盖目录包。无 ZIP/脚本执行。
- 0062/0063 未修改。0064 同时撤销普通角色表级及列级私有读权限，保留公开 metadata 投影；校验有效继承权限与依赖 view，遇到未知暴露拒绝迁移。新表启用 RLS、无普通角色政策，私有 RPC 只给 service_role。管理员载荷/撤销接口沿用 adminProcedure 的实时管理员验证。
- 数据库来源先通过已验证用户身份和用户作用域模块查询，再使用窄私有 RPC；RPC 每次重查用户状态、模块 active/binding、Skill 状态、revision 撤销。每个 source 实例只属于一次请求，固定所选 descriptor，每次读和最终返回重新检查准入；不缓存授权。宿主不能从浏览器接收 actorId。研究和目录加载未接线上聊天/模型。
- 文本聊天原来已经由现有认证/业务准入之后的 service client 读取正文；维持该路径，只加 kind 与实时可执行/撤销检查。管理激活也校验文本类型；目录包在旧入口明确拒绝，不退回 description 或只执行入口。普通模块目录查询仍使用普通客户端。
- 保留现有 hash 格式；本批 DB 发布宿主仅接受 ASCII 文件路径，明确拒绝 Unicode 文件路径，避免 JS UTF-16 与 SQL C 排序不一致。文件正文仍支持原始 UTF-8。公开 name/description 必须可公开；资源计划是管理员审阅输入，不宣称解析任意自然语言依赖。
- 0065 是本研究能力最小 plan/operation 状态，不是用户积分流水。有限计划绑定操作 ID、canonical 能力/schema/参数摘要和单次上限；SQL 对计划加锁预留预算、CAS 接管尚未发送的 prepared、限制同计划仅一个在途操作。dispatched/unknown 不重发；结果持久化后可恢复，未知状态及实际费用超报价会在 finish 同事务停计划。取消阻止未发出部分，不追回费用。预留在已发送操作结束后仍保守保留，不假定未知费用为零。
- AgentKey 固定目的地，禁止重定向及未知 URL 授权头；客户端不读取任何环境 Key。显式 loopback 测试工厂独立于生产工厂。MCP SDK 负责初始化、协议/HTTP/JSON/SSE/session/关闭；无 sampling/roots/elicitation 能力声明。发现不自动扩大白名单；每次新执行前 describe、审核 schema hash、校验参数/报价/预算，随后单次执行。

## 官方契约与依赖

2026-09-06 只读核实：AgentKey 当前是 `find_tools({q?,prefix?})` → `describe_tool({name})` → `execute_tool({name,params})`；name 是发现取得且宿主已审核的 canonical `Provider/Operation`。MCP `tools/list` 仅用于核实顶层工具。旧 aggregate/execute_as 不能当作当前 canonical 调用，适配器拒绝未审核的替代执行描述。

来源：[固定官方 Skill](https://github.com/chainbase-labs/Agentkey/blob/8e93c67a3362a8ec088896a71e3ef228af868932/skills/agentkey/SKILL.md)、[废弃聚合分发说明](https://github.com/chainbase-labs/Agentkey/pull/84)、[价格说明](https://github.com/chainbase-labs/Agentkey/blob/8e93c67a3362a8ec088896a71e3ef228af868932/skills/agentkey/references/cost-aware.md)。describe 的 `cost.credits_per_call` 才是可能的数值价格；只有 billing_note 或路由相关信息不能解释成零。AgentKey credits 与 Graylum 积分没有换算关系。

公开资料尚未完整定义 discovery/schema/result 的业务 envelope。`ProviderContract` 是显式审核的解码接入点；生产工厂没有猜测的默认 decoder。测试 decoder 明确使用虚构 envelope 与 `Fixture/Search`，不能声称当前真实服务支持这些字段/能力。真实 envelope、平台质量、价格和许可仍需获准后的验证及对应 decoder 复核。

直接锁定：`@modelcontextprotocol/client@2.0.0`、测试用 `@modelcontextprotocol/server@2.0.0` / `@modelcontextprotocol/node@2.0.0`、`ajv@8.18.0`、`@types/pg@8.15.6`。SDK v2 stable/Node >=20 经 [官方仓库](https://github.com/modelcontextprotocol/typescript-sdk/blob/5119ee7fd7790e335a3fb60ef36f85334e2a6326/README.md) 与 npm 核实。实际发布包 LICENSE 说明 Apache-2.0 迁移并保留部分历史 MIT 代码；不能只按 package metadata 写成全部 MIT。Ajv/@types/pg 为 MIT。未升级既有依赖版本；保留 pnpm integrity 锁。未复制供应商商业方法。

## 可复现的本地验证

在无 .env 的独立工作树运行；通用测试命令使用 `env -i PATH="$PATH" HOME="$HOME"` 清除继承变量。

| 验证 | 命令 / 接线 |
| --- | --- |
| 实际 SQL / PostgREST / adapter | `node packages/db/tests/v3/run-local.mjs` |
| 官方 SDK MCP 协议 | `pnpm --filter @repo/api exec vitest run src/services/__tests__/agentKeyResearch.test.ts`，包含在 API 全套 |
| API 回归 | `pnpm test:api` |
| Web 相关回归 | `pnpm --filter web exec vitest run src/app/admin/skills/page.test.tsx src/app/chat/balancePreflight.test.ts` |
| 类型与 lint | `pnpm --filter web typecheck`、`pnpm --filter web lint` |
| 本地构建 | `NEXT_PUBLIC_SUPABASE_URL=https://local.invalid NEXT_PUBLIC_SUPABASE_ANON_KEY=local-noncredential-value NEXT_TELEMETRY_DISABLED=1 pnpm build` |

DB runner 创建独立 PostgreSQL 17、PostgREST 14.13 和 loopback HTTP 网关，使用随机的一次性 JWT 签名材料；不复用已有数据库、不读取凭证，结束清理容器和网络。基础 fixture 按 schema.ts 建必要 profile/module 列，再实际应用 0039、0062、0064、0065，新迁移重复应用。不是完整 Supabase 全栈或全历史迁移验证：没有 GoTrue，adapter 的 getUser 边界使用明确的虚构已验证身份；模块、profile、管理接口与所有正文/RPC/角色授权都走真实 PostgreSQL/PostgREST。管理员接口另用真实本地 JWT/profile 查询。原子发布并发用独立 PostgreSQL backend，并确认第二连接实际等待行锁，不能被顺序调用替代。

协议测试用官方 SDK 本地服务器，不 Mock MCP client/transport。覆盖 JSON、SSE、关闭、结构化错误、超时/断线、schema/价格/预算拒绝、execute_as 拒绝、重复操作与保存失败。SQL 测试独立证明跨实例预算、单个在途 dispatch、prepared 接管和实际费用异常停用。协议测试中的内存 store 仅用于协议错误注入，不作为数据库原子性证据。

CI 同范围修复：迁移 ledger 的正向测试从 fixture 现有迁移推导下一编号，避免新迁移使旧编号样本失效，未改检查器或工作流。Secret Scan 首次仅命中本地一次性 Docker 的固定假密码 URL；现已移除密码。`.gitleaksignore` 只增加该历史提交/路径/规则/行号的精确 fingerprint，未豁免文件或更改扫描规则；完整 PR 提交范围本地复扫通过。

最终次数、当前 candidate CI / mandatory GitHub Codex Review 和 changed-file manifest 以 PR live 证据为准。没有技术运行证明或审查缺口时不得称 clean。

## 后续远端验证（NOT_RUN；本批不执行）

1. 在 Owner 指定的非生产项目，对当前 schema/角色继承/依赖 view/RPC/public 出口只读预检；单独批准后应用 0064/0065 并读回。先部署相容 runtime，再发布非机密目录样本；旧 runtime 不能运行新目录包。验证合法文本聊天、缺 Key、模块拒绝、完整包发布/撤销与回滚；真实商业包另行批准。
2. 确認真实 AgentKey API Key 的服务器配置目标后，单独批准受控 discovery/describe。公开资料不足以预填任何真实报价、调用免费承诺或平台许可。需先获取实际 envelope 和单价/单位/保留条款，审核 decoder/白名单和 bounded plan，再给出具体最多操作数及总 AgentKey credits 预算供 Owner 决定；执行预算目前未获授权。
3. 不修改支付/退款/订阅计数；真实取数后的费用联通、完整 M3、上线与下一 Launch 节点均未运行、未完成、未授权。

## 独立审计同范围修复

数据库 source 直接复用现有 `isEmailVerified(getUser().data.user)`，不另定认证政策。getUser 仍是服务端认证边界；普通确认邮箱、Google provider/providers 与 identity_data.email_verified 的布尔 true / 字符串 "true" 均经真实本地数据库加载验证。未验证、认证错误、无用户和无 private client 在私有 RPC 前拒绝；禁用用户、模块关闭/解绑、归档和撤销继续实时拒绝。getUser 样本仍是模拟身份，不能视作完整 GoTrue/OAuth 验证。

费用换算以 Number 的规范十进制字符串（与 JSON 数值序列化一致）为输入，用 BigInt 十进制位移与余数检查精确转为百万分之一单位；预算、单次上限、报价与实际费用共用同一函数。非有限、负数、超过 1000 credits、非零超精度余数均拒绝，不使用容差或向下取整。`0.000123`、`0.001001`、`1.000001` 分别为 123、1001、1000001 单位；计算产生的 `0.1 + 0.2` 在规范表示中有超精度尾数，按严格规则拒绝。

新增 SDK→PostgREST→SQL 联合验证费用预留、批准上限、实际费用、succeeded 对象保存与重复恢复；报价 1 / 实际 0.000123 保留对象且不停止计划，恢复不再 execute。超预算/超单次上限/超精度报价在执行前拒绝，实际费用超报价或未知结果仍按原边界停计划。不修改任何迁移、权限政策或依赖。

可读的脱敏原始 SQL/PostgREST、MCP、Web 输出及命令/候选身份/退出状态附在 PR 评论；CI 日志证明当前远端检查。输出只包含测试名、计数、本地连接 ID 和合成费用，不包含正文、manifest、JWT 或凭证。SQL 集成使用 verbose reporter，明确区分原子数据库证明、模拟 getUser、真实本地 SDK 与内存故障注入。
