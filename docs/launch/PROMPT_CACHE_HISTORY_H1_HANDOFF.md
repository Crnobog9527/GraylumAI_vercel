# PROMPT-CACHE-HISTORY H1 实施记录

风险：high。只实施机制，默认不激活，由 B2 激活；不改 SQL、结算、外部配置，不调用真实供应商。
方案：[PR #601 固定版本](https://github.com/Crnobog9527/GraylumAI_vercel/blob/4c0c52a78b5a838313b1b3735fe945d09944aeae/docs/launch/PROMPT_CACHE_HISTORY_PLAN.md)。
授权与写入顺序：#601 评论 5965739174、5958482083。

## 开工核验（2026-10-03）

- 仓库身份已用 git/gh 核验。staging：`2259e8953bbfc60371ce891e0e847f6b5624c72d`，含 #594。
- 本地 AGENTS.md 与该远程提交一致；已读工程规范与 CI/安全工作流。
- staging 受保护，必需检查：Lint & Type Check、Unit Tests、Build Check、Dependency Audit、Code Security Scan、TypeScript Check、Security Unit Tests、Security E2E Tests、Workflow Policy Check、Secret Scan。
- 本任务先写 execute.ts 请求定形、容量、hash、claim 段；PAYG PR-B 后续从含 H1 的 staging 开工。
- 已读相关本地 worktree。B1 正在同步 staging；其 execute.ts/admission.ts/cache 集成测试与本次 staging 无差异。
- 新用例优先放独立文件，不改 runtime.integration.ts；共享入口将仅增加独立 H1 集成文件：`packages/db/tests/v3/without-app.mjs`、`run-workbench.mjs`；大小基线仅降低 execute.ts 条目。按本次 Owner 的共享文件同步指令，后合并者同步。

### 全部开放 PR 文件快照

- #609 `6e1d435517df165482d06bfb3c9823e3986443d5`
  - `apps/web/src/app/admin/settings/membership.browser.test.tsx`
  - `apps/web/src/app/admin/settings/page.tsx`
  - `apps/web/src/components/admin/AdminGuard.test.tsx`
  - `apps/web/src/components/admin/FusionCompareSetting.tsx`
  - `apps/web/src/components/admin/MembershipPlanPermissions.tsx`
  - `apps/web/src/components/admin/membershipEntitlementDraft.test.ts`
  - `apps/web/src/components/admin/membershipEntitlementDraft.ts`
  - `scripts/code-size-baseline.json`
- #608 `d69883fab1f08f4ff55b2e4c0662528f23a7800e`
  - `docs/launch/tasks/PAY-COMMON.md`
- #607 `a1f808434c2433897cace32e2eed155a012bd3f1`
  - `docs/PROJECT_MAP_FOR_OWNER.md`
  - `packages/api/src/services/__tests__/promptCache.test.ts`
  - `packages/api/src/services/diagnostics.ts`
  - `packages/api/src/services/diagnosticsCoverage.test.ts`
  - `packages/api/src/services/promptCache.ts`
- #606 `dff1bf0748c586c628aa5f6699f7fa340285ae47`
  - `apps/web/src/app/admin/models/page.test.tsx`
  - `apps/web/src/app/profile/page.test.tsx`
  - `apps/web/src/app/profile/page.tsx`
  - `apps/web/src/components/admin/Bill2ModelReportCard.tsx`
  - `apps/web/src/components/admin/ModelEditPriceSection.test.tsx`
  - `apps/web/src/components/admin/ModelEditPriceSection.tsx`
  - `apps/web/src/components/admin/ModelMultiplierPanel.tsx`
  - `apps/web/src/components/admin/ModelReasoningDialog.tsx`
  - `apps/web/src/components/admin/ProviderPricesEditor.tsx`
  - `apps/web/src/components/admin/adminSmallFixes.browser.test.tsx`
  - `apps/web/src/components/admin/modelReportPricing.ts`
  - `apps/web/src/components/admin/useModelCatalogRefresh.ts`
  - `apps/web/src/components/profile/CreditRecordsCard.tsx`
  - `apps/web/src/components/profile/PersonalInfoCard.tsx`
  - `apps/web/src/components/profile/SubscriptionCard.tsx`
  - `apps/web/src/components/profile/SummaryRetry.test.tsx`
  - `apps/web/src/components/profile/SummaryRetry.tsx`
  - `apps/web/src/components/profile/creditsSummaryQuery.test.ts`
  - `apps/web/src/components/profile/creditsSummaryQuery.ts`
  - `apps/web/src/lib/safe-error-message.test.ts`
  - `apps/web/src/lib/safe-error-message.ts`
- #605 `2166f0ef3602fa21c3e988b44944e4efb1b03de3`
  - `docs/DEPLOYMENT.md`
  - `docs/STRIPE_ENABLEMENT_CHECKLIST.md`
  - `docs/billing/BILLING_ENGINE_EXECUTION_LOG.md`
  - `docs/launch/AGENT_TURN_ENABLE_PLAN.md`
  - `docs/runbooks/ADMIN_OPERATIONS.md`
  - `docs/runbooks/STAGING_REPRODUCIBILITY.md`
- #604 `dbdc55b60ea1b3acf8e4854a9459cd05ce5b97f4`
  - `docs/launch/CHAT_NATIVE_OUTPUT_PLAN.md`
- #603 `6a0974bac436981fe89ba90de6cd254c520aa2ff`
  - `packages/api/eslint-suppressions.json`
  - `packages/api/src/services/__tests__/fixtures/schemaSnapshot.ts`
  - `packages/api/src/services/opc/opc.integration.ts`
  - `packages/db/tests/v3/run-workbench.mjs`
- #602 `86185a47ab7a05097865a2b7ec2ba001abbdcb6b`
  - `packages/api/src/services/opc/opc.integration.ts`
- #601 `4c0c52a78b5a838313b1b3735fe945d09944aeae`
  - `docs/launch/PROMPT_CACHE_HISTORY_PLAN.md`
- #598 `001d8b4450cf8760f3a455f23d663c190ae76780`
  - `docs/plans/DATA-ERASURE-INFLIGHT-RECOVERY.md`
- #593 `fd210532e83c3299067ce2064bff4d2879a1f48b`
  - `docs/launch/rollback/CONVERSATION_CAPTURE_B1.sql`
  - `packages/api/src/routers/opc.ts`
  - `packages/api/src/routers/stagingAdmission.test.ts`
  - `packages/api/src/services/opc/agentTurnPromptCapacity.test.ts`
  - `packages/api/src/services/opc/capture.integration.ts`
  - `packages/api/src/services/opc/capture.test.ts`
  - `packages/api/src/services/opc/capture.ts`
  - `packages/api/src/services/opc/information.ts`
  - `packages/api/src/services/opc/organizerPrompt.test.ts`
  - `packages/api/src/services/opc/service.ts`
  - `packages/api/src/services/runtime/executionStream.ts`
  - `packages/api/src/services/runtime/runtime.integration.ts`
  - `packages/api/src/services/runtime/timing.test.ts`
  - `packages/api/src/services/runtime/timing.ts`
  - `packages/db/migrations/0159_opc_capture.sql`
  - `packages/db/tests/baseline/built-fingerprint.json`
  - `packages/db/tests/v3/run-workbench.mjs`
  - `packages/db/tests/v3/without-app.mjs`
  - `scripts/code-size-baseline.json`
  - `scripts/tests/integration-without-app.test.mjs`
- #553 `135d4c197a630e613ea692c0fe9742079e295869`
  - 无差异文件。
- #547 `8fb950af3a95e1d40f3053f1b76c1bbea7486bcd`
  - 无差异文件。

## 实现与方案对应

| 方案 | 落点与证据 |
| --- | --- |
| 2.1、2.2、2.5 | hostTurn.ts 定义 strict 宿主状态、host-turn-v1、HOST_TURN_DATA_NOTICE_V1；旧格式投影不变，v2 识别新旧格式，旧宿主状态不进入历史。当前 user JSON 的键顺序固定，注入字符串不能伪造顶层字段。 |
| 2.4 | historySelection.ts：块宽 16、预留 8000、标记预留 150；首次选择整块、兜底整轮对齐；冻结后逐调用只验证。session.ts 只读暴露修订号。 |
| 2.6、2.9 | admission.ts 同时冻结 hostTurnContext / scope-projection-v2 / historySelection，和缓存资格分离；v2 前缀含完整问题契约；开场、对比、超预留不加历史标记。 |
| 2.7、2.8 | promptCache.ts 在现有 providerRequest 唯一转换点加标记，之后仍是完整请求容量 → hash → 原回执查询 → claim。adapter 独立检查形状、位置、配对、价格和模型。 |
| 4、7.1 | 沿用 #591 黄金字节，另由实施前 staging 源码生成所有格式的 v1 缓存黄金字节；真实本机 SQL 覆盖 17–48 冻结、重放、v1→v2、停用缓存和坏哈希零 claim。 |

不修改 opc/service.ts 或 agentTurnPrompt.ts，没有宿主激活入口；当前产品仍走旧路径。
不修改 SQL、迁移、数据库指纹、结算、费用上限、供应商配置或 1 小时 TTL。
为控制现有 execute.ts 大小，仅把原 schema 搬到 runtimeContext.ts，保留原导出；大小基线只降低。
adapter 新 helper 被离线评测脚本固定模块清单引用，补清单后保持原离线评测语义。

## currentReserveBytes 取值与实际保留量（2.4 / 8.3）

采用 **8000 字节**。不是把所有允许输入都塞进固定预留：Runtime 用户输入上限为 20000 字符，JSON 转义最坏约 120000 字节；
现有 scope content 上限 32768 字节，新 host 对象上限 16000 字节。计入外层 JSON 字符串转义和信封后，
粗保守上界约 218 KB（120000 + 2×32768 + 2×16000 + 信封），远超 64/90 KB 输入上限。
把固定预留取到上界会使正常历史几乎全丢，故采用小预留；实际必需上下文放不下仍在发送/claim 前拒绝。
所有量最终按实际 UTF-8/JSON 测量，而非按这个粗上界放行。

本机合成 B2 形状夹具：3 步×8 字段清单、4000 ASCII 材料、16000 字节固定 system、真实提问工具定义、
160 条长历史（user 600 字符 / assistant 1600 字符交替）、100 条数上限。历史字节是投影后数组的 JSON UTF-8 字节。
未读取 staging 预算，也未把合成模型/分布当真实流量。

| 输入上限 | 当前输入 | 当前消息字节 | 旧保留条数 / 字节 | H1 保留条数 / 字节 | 兜底 |
| --- | --- | ---: | ---: | ---: | --- |
| 64000 | 短，100 字符 | 7820 | 32 / 36209 | 32 / 36209 | 否 |
| 64000 | 长，13000 字符 | 20720 | 21 / 24265 | 20 / 22631 | 是 |
| 90000 | 短，100 字符 | 7820 | 56 / 63365 | 48 / 54313 | 否 |
| 90000 | 长，13000 字符 | 20720 | 44 / 49787 | 44 / 49787 | 是 |

- 预留 12000 的初始测量在 64 KB 短输入场景只保留 16 条；收紧至 8000 后保留 32 条（16 个完整往返）。
  90 KB 少留 8 条来自整块对齐；长输入按实际长度兜底，仅去掉起始不完整轮。本夹具未见明显不足。
- 分布：输入字符数 [100,1000,8000,13000] × 材料字符数 [1000,4000,8000]，12 个等权合成样本，
  当前消息为 4820–24720 字节；**9/12（75%）兜底**。该分布刻意包含大量长输入，不能外推真实占比或缓存收益。
  取舍明确偏向保留对话，B2 应用最终清单文字重跑容量与分布，不因本报告追加付费样本。
- 固定预留损失另有复审等比例算例测试（旧保留 80，新从 65 开始保留 16），不声称损失永远只有约 16 条。

## 验证记录

- 通过：`pnpm test:api` 4129 项；其后新增 3 项容量/窗口测试通过（所在两文件 23 项全部通过）。
- 通过：Runtime 本机一次性集成 172 项（含 H1 新文件 4 项），BILL2 本机一次性集成 83 项。
- 跳过：API 12 项为现有可选用例；Runtime 5 项为既定需要应用/浏览器的排除清单，不算通过。
- 通过：API/Web 类型检查、API/Web lint、check-code-size、132 项 CI safeguards、3 项集成入口合约。
- 初次失败与修复：沙箱禁止回环监听/Docker，改用获准的本机验证环境；新增文件未入索引导致复制缺失，暂存后修复；
  离线评测固定模块清单遗漏新 helper，补齐后其 28 项通过；H1 集成按旧纯文本形状断言新导师信封，修正为实际协议后通过。
- 远程 CI：等待候选推送后的精确 head 检查；通过后仅留可审查评论。
- 新确定性用例覆盖：全部格式旧字节与 hash；普通/卡片/开场/对比/兜底完整请求；6+轮前缀；长短交替、条数与字节上限、
  SQL 滑动窗口与孤立结果、修订缺口、工具依赖、17–48 重放、J1 空/非空整轮对齐、空历史超限、多调用 claim 前失败、
  缓存停用与 Gemini、实际 150 字节边界、旧冻结值不读新默认、注入、adapter 零凭据/零传输拒绝矩阵。
- B2 最终提示词组合、回复质量、真实 OpenRouter 接受与命中效果：未运行，属于 B2；H1 的合成测试不替代这些证明。
- 独立审查：未运行，由总控安排。保持 draft。

## 推送前刷新与共享文件

2026-10-03 刷新：staging 仍为开工基线；#593 head 更新为 146540098e6aaa410256d1a945aa50358a980a92，
新增 #611 为注销实施交接文档，均无 execute.ts 竞争写入。#608 更新仍只有 PAY-COMMON 方案。
共享入口变动仅为注册独立 historyCache.integration.ts，并同步 scripts/tests/integration-without-app.test.mjs 的合约夹具；
不改 runtime.integration.ts。#593 后续同步时保留双方测试文件，代码大小基线取共同降低结果。

## Handoff

已完成：开工核验、机制实现、容量取值与报告、确定性测试；默认不激活。
下一步：等待精确 head 的远程 CI；通过后标记可审查并停止写入，由总控安排独立审查。
开放事项：B2 激活时采用导出的宿主 schema/常量，重算最终材料分布并按已批准预算验收；PAYG PR-B 在本 PR 合并后开工。
回退：仅在新准入不再冻结 historyMarker 或 promptCache；保留 host 状态与历史选择。回退 B2 宿主时恢复旧结构，
但保留 H1 对已冻结 v2 的重放支持。所有回退均通过发版，不需 SQL。
付费交接：复用 B2 及 B2+F1 已批准预算，其中安排一次 6–8 分钟轮间隔；证据不足由总控报告，不自动加样本。
