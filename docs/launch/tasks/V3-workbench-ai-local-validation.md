# V3-WORKBENCH AI 与计费接线：本地交付

Owner 本轮范围：继续 V3-WORKBENCH 的 AI 与计费接线，先完成代码与本地验证。
基线：`staging` / `37b39ba621fa75bca78ef35c74d65af035ead02a`。
风险：high（计费、私有方法准入、持久化迁移及分词依赖）。本记录不授予外部启用或合并权限。

## 实现

- 工作台先读取费用，明确显示最多预留的 Graylum 积分；只使用已保存的工作稿、该步骤及其依赖来源。AI 输出只进入候选，采用后仍需保存和确认。
- 服务端决定模型、定价、Skill 身份与资源。每次完整加载固定版本入口、当前步骤资源及文件依赖闭包；保留旧非工作流 `task` 加载方式。完整消息按本地 `o200k_base` 分词，加消息封装余量和输出预算后检查容量，不截断方法。
- 初始适配器只支持配置明确的 `openai/gpt-4o-2024-08-06` 与 `openai/gpt-4o-mini-2024-07-18`。其他模型拒绝生成，不能把未知 tokenizer 的估算冒充已支持。固定 OpenRouter endpoint、显式配置凭据、禁止重定向、工具、插件和模型回退；不读取环境 Key 作为后备。
- 0068 只增加生成请求与现有候选的关联，并更新必要的读/采用函数。已有 0053–0067 不变；复用当前 `atomic_pre_deduct` / `atomic_settle` / `atomic_refund`，没有第二套余额或新执行 Harness。
- 项目锁内预留积分并固定输入版本、直接来源、完整出处与价格快照。发送前取得唯一发送权；同请求不同输入拒绝。并发和刷新不重新发送已发送请求。
- 模型结果先持久化，再在同一事务插入候选、计费终态和结果关联。结算失败回滚候选，但保留已收到结果供恢复。迟到结果不覆盖工作稿，旧输入基础的候选不能盲目采用。
- 未发送请求可取消并按原退款规则恢复积分；已经发送但结果不明的请求保留为待核对，阻止该项目自动重发或替换，不能推测为失败而退款。实际外部结果核对与人工处置不在本轮范围。
- 扣费不超过用户接受的预留上限；记录的模型美元成本来自固定计费价格计算，不冒充供应商实际账单。普通计费历史只保存费用与结果标识，私有资源清单留在无普通角色读权限的操作表中。
- 生成状态随原项目读取返回，不额外增加每次切换步骤的请求；生成后的读取不得覆盖晚到的新保存状态。失败时保留原生成请求身份。

## 本地验证与复现

- `pnpm --filter @repo/api exec vitest run src/services/__tests__/workbenchGeneration.test.ts src/services/__tests__/standardSkillLoader.test.ts src/services/__tests__/artifacts.test.ts src/services/__tests__/billing.test.ts src/services/__tests__/billing.security.test.ts`：151 项通过。
- `pnpm --filter web exec tsc --noEmit`：通过。
- `pnpm --filter web lint`：通过；仓库现有 ESLint 配置不匹配 TS/TSX，不能把它称为新增 TS/TSX 的规则覆盖，相关静态验证由 TypeScript 完成。
- 凭据隔离的源码副本执行 `pnpm build`：通过。仅使用 CI 同款无效占位 Supabase 配置。
- `pnpm audit --prod --audit-level=high`：通过高危阈值；仍报告 2 low、2 moderate，未扩展修复无关依赖。
- 迁移编号和历史不可变检查：相对上列 exact base 通过。
- `node packages/db/tests/v3/run-workbench.mjs`：修复后原浏览器回归及 10 项 AI 场景通过，应用真实重启后恢复通过。两阶段共 26 个不同场景；第二阶段只运行重启恢复，其余跳过是显式筛选。
- `node packages/db/tests/v3/run-workbench.mjs --ai-only`：增加计费 metadata 隔离、实际月度 grant 消耗、来源限制和版本撤销等专项证明；12 项通过（其余 16 项原工作台场景由完整运行覆盖，专项筛选显式跳过）。长名称社媒方法的创建按钮已允许换行，390px 布局通过。

运行器新建并清理本地 PostgreSQL 17、PostgREST 14.13、GoTrue 和 Next。计费函数逐字取自当前仓库迁移并实际执行；表基础为一次性 fixture。服务测试显式注入模型函数；网页测试仅在无凭据的临时源码副本将固定 provider transport 替换为 loopback HTTP 合成响应。发版源码没有可通过环境变量启用的假模型或任意 URL 开关。

覆盖：重复/并发请求、迟到输出保留用户编辑、过期候选拒绝、未知结果不重发、候选与结算事务回滚及恢复、取消退款、真实月度积分 grant、扣费前关闭/容量/余额/依赖/归属/来源/撤销拒绝、三/六/八步配置、普通角色 RPC 与私表拒绝、网页询价/生成/采用/保存/刷新。

Computer Use 另用一次性虚构账号在 390px 视口实测：询价、生成期间继续编辑、候选保存、保存工作稿、刷新恢复均通过；两条记录各预留 10 积分、结算 1 积分，工作稿未被迟到响应覆盖。视口 390px、页面宽度 379px；结束恢复视口并关闭临时页。

本地证据目录：`/tmp/graylum-workbench-ai-local-v2`（完整回归与重启）、`/tmp/graylum-workbench-ai-final-v2`（最终 12 项专项）、`/tmp/graylum-workbench-ai-cua`（Computer Use 预览）。最终专项日志 `/tmp/graylum-workbench-ai-final-v2-run.log`，构建日志 `/tmp/graylum-workbench-ai-build-final.log`。测试容器、临时源码副本和临时登录凭据已清理；保留验证截图和日志。

## 启用及回滚边界

迁移不创建模型、Key、账号、价格或启用配置。`system_settings.v3_workbench_ai` 缺失或不是 JSON boolean `true` 时不生成；配置存在也必须满足模型与 Skill 校验。本轮没有远端迁移、真实模型、AgentKey、真实收费、部署、main 或合并。

可撤回网页/服务代码并保留新表与历史，不能删除已有预留及结果来假装回滚完成。外部启用前仍需真实模型非生产验证、价格与预算决定、供应商/保留条款核对，以及既定 GitHub Codex Review 和独立 ChatGPT 审计。本轮仅代码与本地验证，不宣称 V3-WORKBENCH 全部验收或 V3-M3 完成。
