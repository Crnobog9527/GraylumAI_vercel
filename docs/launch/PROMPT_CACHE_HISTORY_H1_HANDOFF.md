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
- 新用例优先放独立文件，不改 runtime.integration.ts；共享测试入口及基线若需调整会明确记录，后合并者同步。

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

## Handoff

已完成：开工核验、方案读取、专用分支。
下一步：机制实施、容量测量、确定性及一次性本机集成验证。
验证：尚未运行。独立审查由总控安排；本 PR 保持 draft，不标 ready、不合并。
