# DATA-ERASURE 在途收尾实施记录

风险：high。开工 staging `2259e8953bbfc60371ce891e0e847f6b5624c72d`。
依据：[#598](https://github.com/Crnobog9527/GraylumAI_vercel/pull/598) 定稿 `001d8b4450cf8760f3a455f23d663c190ae76780`；
[实施授权](https://github.com/Crnobog9527/GraylumAI_vercel/pull/598#issuecomment-5957866853)。

仅本机一次性环境验证；不应用远程迁移、不调用真实模型、不改外部配置。
保持 draft，CI 后交总控独立审查。迁移暂用 0160，合并前重新核对编号。
不改 execute.ts；executionStream.ts 与 #593 由后合并方同步，保留正常捕获并阻止注销后的捕获。
H1 的 execute.ts/context.ts 由其 writer 负责。PAYG v2 注销谓词归 PR-A，waiting_credits 归 PR-B。

## 必做补充

- 注销谓词同步覆盖 read、close、record、financial_recovery、revoke_unstarted_dispatch 五处。
  v2 未发出 call 撤权释放纳入 PAYG PR-A 联调验收，本次不引入 v2 合同。
- 实际费用未知不当零；actual_fallback 是实际费用已知、tokens 缺失的结算口径，不能标未知；
  v1 名义费用不适用。名义计价仍由 PAYG 实现。

## 验证与回退

实施中，功能验证 NOT_RUN。后续补充实际命令与结果；CI 不代替独立审查或远程验收。
回退保持账号封闭及财务证据，不能反转终态、恢复正文或派发 token；产生新事实后优先前向修复。

## 开工 open PR 完整文件快照

### #609 — `6e1d435517df165482d06bfb3c9823e3986443d5`

- `apps/web/src/app/admin/settings/membership.browser.test.tsx`
- `apps/web/src/app/admin/settings/page.tsx`
- `apps/web/src/components/admin/AdminGuard.test.tsx`
- `apps/web/src/components/admin/FusionCompareSetting.tsx`
- `apps/web/src/components/admin/MembershipPlanPermissions.tsx`
- `apps/web/src/components/admin/membershipEntitlementDraft.test.ts`
- `apps/web/src/components/admin/membershipEntitlementDraft.ts`
- `scripts/code-size-baseline.json`

### #608 — `d69883fab1f08f4ff55b2e4c0662528f23a7800e`

- `docs/launch/tasks/PAY-COMMON.md`

### #607 — `a1f808434c2433897cace32e2eed155a012bd3f1`

- `docs/PROJECT_MAP_FOR_OWNER.md`
- `packages/api/src/services/__tests__/promptCache.test.ts`
- `packages/api/src/services/diagnostics.ts`
- `packages/api/src/services/diagnosticsCoverage.test.ts`
- `packages/api/src/services/promptCache.ts`

### #606 — `dff1bf0748c586c628aa5f6699f7fa340285ae47`

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

### #605 — `2166f0ef3602fa21c3e988b44944e4efb1b03de3`

- `docs/DEPLOYMENT.md`
- `docs/STRIPE_ENABLEMENT_CHECKLIST.md`
- `docs/billing/BILLING_ENGINE_EXECUTION_LOG.md`
- `docs/launch/AGENT_TURN_ENABLE_PLAN.md`
- `docs/runbooks/ADMIN_OPERATIONS.md`
- `docs/runbooks/STAGING_REPRODUCIBILITY.md`

### #604 — `dbdc55b60ea1b3acf8e4854a9459cd05ce5b97f4`

- `docs/launch/CHAT_NATIVE_OUTPUT_PLAN.md`

### #603 — `6a0974bac436981fe89ba90de6cd254c520aa2ff`

- `packages/api/eslint-suppressions.json`
- `packages/api/src/services/__tests__/fixtures/schemaSnapshot.ts`
- `packages/api/src/services/opc/opc.integration.ts`
- `packages/db/tests/v3/run-workbench.mjs`

### #602 — `86185a47ab7a05097865a2b7ec2ba001abbdcb6b`

- `packages/api/src/services/opc/opc.integration.ts`

### #601 — `4c0c52a78b5a838313b1b3735fe945d09944aeae`

- `docs/launch/PROMPT_CACHE_HISTORY_PLAN.md`

### #598 — `001d8b4450cf8760f3a455f23d663c190ae76780`

- `docs/plans/DATA-ERASURE-INFLIGHT-RECOVERY.md`

### #593 — `fd210532e83c3299067ce2064bff4d2879a1f48b`

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

### #553 — `135d4c197a630e613ea692c0fe9742079e295869`

- 无文件差异（方案见 PR 描述）。

### #547 — `8fb950af3a95e1d40f3053f1b76c1bbea7486bcd`

- 无文件差异（方案见 PR 描述）。

