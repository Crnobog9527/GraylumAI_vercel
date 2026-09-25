# V3-WORKBENCH local business acceptance

Owner selected this batch on 2026-09-14 and deferred **real AgentKey research acceptance until before enabling real research**. This does not waive original-method acceptance or authorize remote migrations, live calls, payments, deployment, merge, or subsequent Launch work.

## Candidate scope

The positioning entry uses one persistent Runtime Session and the published Skill workflow. Manual and mentor modes share artifact working drafts, immutable confirmations, configured dependencies and report versions. Required information comes from the method configuration; user-confirmed or explicitly deferred information closes the host completion condition. Model output remains a separate candidate. Profile fields are mapped from confirmed information, with confirmation/version provenance, rather than copying the complete report into future work.

Plan confirmation freezes the selected version and concrete platform/account set. Its SQL transaction adopts/creates accounts, work items and independent Runtime Sessions with source references. It does not execute a model or create a billing reservation. Existing BILL2/Runtime services remain the only execution and financial path. Changed positioning versions invalidate configured dependents without deleting old reports or changing existing work-item sources.

Skill output without a workflow is stored as an immutable artifact result, not fabricated business steps. The dedicated result projection is used by the work-item screen. Result containers are excluded from legacy editable-project lists; their workflow edit/export resolver is deliberately denied. Generic read projects an empty step list. Existing standalone `/runtime` fixtures remain a legacy compatibility/demo entry, not an alternative OPC onboarding path.

## Verification record

- Initial local API unit suite: 82 files / 1,879 tests passed, exit 0. A later full run had 1,878 pass / one local MCP connection-timeout failure (200 ms fixture deadline), exit 1; its focused 32-test file subsequently passed, exit 0. This failed full run is not reported as a suite pass. The final full suite with bounded worker concurrency passed all 82 files / 1,879 tests, exit 0; no production timeout or acceptance assertion was relaxed.
- BILL2 on 0105 + 0106 + 0107: 78 passed, 155 unrelated cases skipped, process exit 0. No real provider calls.
- OPC integration iterations retain failures for source-check recursion, stale UI state, and non-workflow read compatibility. Their individual successful assertions are not suite passes.
- Current OPC source digest `b5fdce3793cea7f0c7073527892053e4050b9b76ae345cfa227d84b8d4232f4a`: **16 passed / 155 unrelated skipped**, Vitest child exit 0, private-canary scan passed. That runner subsequently stopped cleanly after serving the preview; the latest isolated preview retains the same schema and business source. This includes original-method publication, host-only purpose binding, required information/dependency checks, stale-candidate protection, bounded plan parsing, manual browser adoption with a lost response, source revocation and non-workflow result recovery.
- Intermediate OPC snapshot: 13 passed / 155 unrelated skipped, exit 0. Upgrade/rollback against old app e17277e3a456d1ac394d9289842402eb91fd38e5: 2 passed, exit 0, new schema includes 0107. The current 16-case run supersedes this OPC snapshot; the old-app paths are unchanged by the later OPC-only binding checks.
- Initial f5f2d28a8cea6ae373a0cd6712f8b9f3b634db95: ten required CI/Security checks passed and independent fresh Codex review found no actionable code issue, with explicit acceptance limits. Later content changes require fresh complete-candidate review; prior conclusions are not reused.
- Runtime on the OPC schema: full run 45 pass / one browser failure, exit 1; the default selection defect was fixed. A second 45-pass run hit the cold-page navigation deadline; the affected browser case passed separately (1 pass / 200 unselected, exit 0) after an explicit bounded navigation wait.
- Old ordinary chat and SDK callers on OPC schema: two full runs each had 55 pass / one failure, exit 1 (settlement observation timing, then summary-rate-limit UI timing). Both affected cases passed together afterward (2 pass / 153 unselected, exit 0). Unrelated successful assertions are reusable only where source and baseline remain applicable; neither failed full run is called PASS.
- Integration runner logs include source tree digest, isolated DB/Auth/PostgREST identities and actual exit status. `--with-opc-schema` separates migration baseline from test selection. 0107 is applied twice within each relevant runner.

## Independent review remediation

The independent complete-candidate review of `2cab17e012721136541703045864f418c7e9f733` found P1: unsaved information edits did not disable formal publication. The initial probe was inconclusive because the preceding save was still busy. The corrected browser counterexample first waits for an otherwise enabled publish button; against the old UI it fails with `expected true to be false`, process exit 1 (`graylum-opc-dirty-red2.log`, source digest `a456351cd63d0089d8c525e7b5f4368dfe63129e3802302935b65749edb332e1`).

The repair blocks mentor/plan generation, publication, plan saving and adoption while information edits remain unsaved, and explains how to continue. The browser regression then saves/reconfirms and asserts the adopted account profile contains the updated value. Focused browser + original-method revalidation: **2 passed / 169 unselected**, child exit 0, source digest `f74af76feb56afb2f5b52d12b1ce7ab0fea22d01fb091247a06190e2f6f19c4d` (`graylum-opc-dirty-green.log`). The other 15 business assertions from the 16-case run remain applicable to unchanged implementation paths; these run counts are not added together as unique tests.

The final disposable preview returns explicitly labeled Chinese mock replies and mock plan JSON for the supplied concrete account. The actual original-method SDK → local HTTP → receipt → plan-candidate path additionally passed (1 pass / 170 unselected, child exit 0, `graylum-opc-preview-plan.log`). This exercises transport and business wiring, not real model/research quality. A new full base-to-head independent review is required for the repaired candidate; the earlier P1 review is not a PASS.

The adjacent in-flight-edit race was also reproduced with a held successful information response: the old UI kept information/work-draft inputs editable while its eventual response cleared the edit buffer (`graylum-opc-pending-red.log`, exit 1). The repair disables affected information, work and plan editing controls during the existing bounded save operation; it does not add another queue or recovery mechanism. The same held-response browser scenario plus publication/profile/handoff/re-login path passed (`graylum-opc-pending-green.log`, 1 pass / 170 unselected, exit 0). This follow-up changes only page input locking and its regression; financial, scope, Session and migration implementation are unchanged. TypeScript and lint also pass; final candidate CI and complete semantic review are recorded on the PR.

The Owner-preview refresh check exposed a further local-buffer initialization defect: the initial empty persistence effect overwrote unsaved information/plan candidates during mount. It was reproduced through the actual browser and an isolated counterexample (`graylum-opc-buffer-red.log`, exit 1: old confirmed information replaced the new unsaved value). Hydration now completes for the current draft before persistence or saved-plan synchronization runs. The complete browser path in `graylum-opc-buffer-green.log` passed (1 pass / 170 unselected, exit 0): delayed-save protection, unsaved information refresh, plan candidate plus manual plan edits refresh, explicit adoption, correct profile, lost-response handoff and re-login. The test also asserts exactly one billing run across those refreshes. No server financial or Session implementation changed in this follow-up.

## Real evidence boundary

The original private method was located in the adjacent project materials, `功能模块/6步定位分析skill/v1/social-media-commercial-strategist`. A local 1.1.0 productization artifact preserves all 12 reference/asset files byte-for-byte and narrowly replaces the legacy conversation protocol in SKILL.md and the bulk questionnaire instruction in references/01-intake.md. The source manifest, private publication input and 23-field reviewed profile mapping are retained outside Git in the task output folder `v3-workbench-original-method-v2`. The private publication input SHA-256 is `4e33b7521157ccddff42c159da644880cf3e3464fb39f72263d958c7f238ff9f`. Isolated publication/read-back verifies all 14 files, six configured steps, 23 provenance-bearing profile fields, original Session and model instructions, and account handoff. This is original-method wiring proof; real answer quality and Owner product acceptance remain NOT_RUN. Synthetic confirmations do not prove factual research or commercial advice quality. The typed module publication input accepts reviewed information/profile configuration; publication to a real environment remains outside this task's authorization.

All new HTTP business routes require a loopback isolated database. Real research, models, remote 0105/0106/0107, payment, external reconciliation and production are **NOT_RUN**. Production/staging activation requires separately approved actions and prerequisite validation.

## Owner business acceptance

Use the retained disposable `/positioning` preview with the original method as its sole available method. Verify the six business outputs and required information, explicit deferral instead of invented facts, editable week-plan items and concrete account adoption; then enter a topic, save its Skill result, and find the same result after re-login. The fixed model response is labeled and only checks wiring. Do not evaluate it as real consulting quality. The existing ordinary-chat default is retained.

## Rollback

Retain 0105 + 0106 + 0107, every unresolved receipt/run and immutable source/report. An old app rollback retains the two financial read compatibility patches and six legacy finalizer protections. Do not reset credits, delete pending evidence, drop new tables or replay unknown provider requests. New OPC data is accessed through its dedicated projection; rollback cannot imply OPC business availability on an app that lacks it.

## Owner stepwise experience correction

Owner rejected the simultaneous six-step form as a mentor experience. The page now renders one configured step, preserves explicit step selection and per-step reply buffers, and offers next-step navigation after confirmation. Mentor mode places the continuous Session conversation first and collapses the current information/artifact review; manual mode opens only the current step. Local examples are explicitly synthetic and step-specific; they do not prove adaptive advice, information extraction or real research quality. All financial and source interfaces remain unchanged.

The original browser counterexample expected one visible work-draft input but received three (`graylum-opc-step-red.log`, exit 1). Intermediate step-navigation and final validation results are recorded on the PR; prior candidate review does not cover this correction.

Stepwise browser validation: the first intermediate manual run timed out (exit 1) while confirmation changed the implicit selection. Selection is now explicitly initialized and retained, so confirmation does not switch the article underneath the user. `graylum-opc-step-green2.log` passed the complete manual publication/plan/adoption/re-login regression with one rendered step, next-step navigation and refresh (1 pass / 171 unselected, exit 0). `graylum-opc-mentor-green.log` passed collapsed mentor details, typed-reply refresh, distinct two-step local examples, same Session and exactly two billing runs (1 pass / 171 unselected, exit 0). TypeScript and repository lint pass. The original Owner preview keeps its existing database and draft; only local page code and the disposable loopback reply fixture were updated, without resetting information or money.

A lost execution response exposed one adjacent reply-buffer defect: recovering the original request cleared newly typed unsent text. `graylum-opc-mentor-pending-red.log` reproduces the empty-buffer failure (exit 1). The repair clears only text matching the recovered request; `graylum-opc-mentor-pending-green.log` passes response-loss recovery, retained newer text, next-step reply, refresh, original Session and exactly two billing runs (1 pass / 171 unselected, exit 0). This supersedes the earlier mentor browser run for the reply-clear path.

## Form-to-organizer correction

The Owner could save information values but was still required to write a separate artifact manually. The current-step button now explicitly confirms supplied text, persists the information through the existing versioned command, and requests the original Skill followed by the administrator-configured distinct attached organizer. The existing Runtime freezes both call policies and their combined budget in one run. Only the host-bound completed step execution may project that requested organizer output as an artifact candidate; existing authorized Runtime result reads stay unchanged, and private inputs/receipts are not projected. Adoption and step confirmation remain separate user decisions. Explicit unclear/provisional information cannot silently become confirmed; deferred items require a reason. Failed or ambiguous requests retain their original information/request identity, and recovery does not clear newer edits.

`graylum-opc-organize-red2.log` preserves the pre-fix browser failure (no organizer action after filling the form). The earlier `organize-red.log` failed fixture JSON setup and is not regression proof. Intermediate `organize-focused.log`/`organize-full.log` contain timeouts and are not suite passes. `organize-focused2.log` failed cold page navigation with an overly short action timeout; navigation now retains its separate 90-second bound. `organize-full2.log` has 17 passed / 1 failed / 155 unselected: the diagnostic poll incorrectly treated Next's empty accessibility alert as a failure. It is retained as a failed run, not relabeled as a full-suite pass. The poll now checks nonempty alerts; final focused proof and exact candidate CI/review are recorded on the PR.

The organizer browser regression uses real isolated Auth/PostgreSQL/PostgREST, Next, SDK and synthetic HTTP. It fills a form without manual artifact prose, drops the successful execution response, reloads, recovers the original request, saves one organizer candidate, adopts it and confirms the step. It checks incomplete-information denial, organizer revocation/read denial, restored availability, one run/reservation/execution, exactly two provider requests (primary plus organizer), two call records and a single six-credit synthetic settlement. Real organizer output quality and adaptive mentor quality remain NOT_RUN. The retained Owner preview uses the same local disposable database/draft and a separately configured local organizer fixture; no user inputs, balance or pending evidence are reset.

Final organizer proof: `graylum-opc-organize-final-focused2.log` passed (1 pass / 172 unselected, process exit 0), closing the diagnostic-poll failure above and covering the actual two HTTP calls and unique six-credit test settlement. `graylum-opc-organize-unit.log` passed 82 files / 1879 tests. Current candidate CI/review are recorded separately on the PR; no real model quality or external acceptance is inferred.

## Form-first, multi-turn mentor correction

The Owner's next correction supersedes the earlier chat-first/collapsed-form presentation above. The current step's configured information is always expanded and precedes the help button. Opening help shows a bounded, independently scrolling conversation next to the form on wide screens and immediately after it on narrow screens; artifact organization/adoption follows both. Only the current step's mentor messages appear in this pane. Previous step messages and organizer/plan executions remain in the original Session; pending non-mentor executions retain an original-execution recovery control.

A server-bound `mentor` purpose is distinct from artifact `step` and `plan`. It retains the same prerequisites, source/revision/account permissions and Runtime/BILL2 admission. Even with complete information, mentor discussion cannot be saved through the artifact-result RPC and does not automatically confirm/advance a step. The UI saves partially edited information using the existing versioned command before discussion, preserving uncertainty. Editing previously confirmed text resets that field to unknown; explicit confirmation or the clearly labeled organize action is still required. Lost responses replay the same information/request identities, preserving newer unsent replies.

The owned draft query returns only execution/step/kind metadata for presentation; actual bodies still come through the existing permission-filtered Runtime projection. Raw instructions, method resources, receipts and tokens are not added to browser responses. Previously saved message text is retained, including old mock wording; new mock responses no longer instruct users to expand a hidden form. Synthetic responses do not prove adaptive mentor quality.

`graylum-opc-form-first-red.log` preserves the old collapsed-form failure (exit 1). `form-first-green.log` is also a failed run: the default one-second poll expired while the real prepare/execute/refetch path was still completing. The same assertion with an explicit 15-second bound passed in `form-first-green2.log` (1 passed / 172 unselected, exit 0), including three mentor rounds, actual subsequent local HTTP inputs containing earlier replies, response-loss recovery, no artifact candidate, step filtering and original Session/unique billing identities. Later full and focused results, final CI and complete-candidate independent review are recorded on the PR. No failed run is relabeled as a suite pass.

The full form-first OPC run (`graylum-opc-form-first-full.log`) passed all 18 OPC cases / 155 unrelated unselected, process exit 0, including the original 14-file six-step method, 3/6/8/configured steps, manual/relogin/handoff, new mentor purpose, organizer response-loss recovery and source denials. API unit tests passed 82 files / 1879 tests (`form-first-unit2.log`, exit 0); the earlier incorrectly named package filter ran no tests and is NOT_RUN. TypeScript and lint exited 0. An additional focused mentor run extends the same case to explicitly completed information and logout/login; its result is reported separately. The final UI also retains pending non-mentor recovery; the preserved local Owner draft was checked in the browser with narrow form→chat→artifact order and a 1440px equal-height form/chat row, then viewport settings restored. No original input, confirmation, Session or billing record was reset.

## Review follow-up: metadata and rejected account revisions

Independent review of `211b47aa` identified two P1 issues (also GitHub threads 4008143765 / 4008143775); that candidate is **not clean**, despite green CI. The existing administrator read/form/save path now preserves step information and plan-resource metadata through routine republishing. It does not expose private method bytes to ordinary users or add a new configuration system. The real isolated admin browser regression republishes metadata through the normal service first, then opens/reviews/saves the existing editor and compares the newly published workflow; denied admin paths remain selected.

Handoff keeps its original payload for ambiguous failures and committed-response recovery. Only the specific server `OPC_ACCOUNT_CONFLICT` rejection clears the rejected local confirmation and refreshes account revisions, allowing the user's next explicit confirmation to use current state. That SQL rejection rolls back the whole transaction; old optimistic account revisions cannot become current again. A stale-account browser regression passed (`graylum-opc-stale-green.log`, 1 pass / 173 unselected, exit 0) after a second actual service handoff advanced the same account, then verifies one work item, no billing runs and recovery without clearing storage manually. Existing lost-success-response browser coverage is rerun separately.

Initial `stale-red.log` failed because the new test omitted the installed Chrome executable path; it did not reach the product counterexample. `metadata-red.log` attempted to alter immutable workflow registration during fixture setup and was correctly rejected; it is not a metadata-loss proof. The corrected fixture publishes a new revision through the actual service, retaining constraints. These failures remain failures and are not presented as before-fix product proof. Final affected tests and independent new complete-candidate review are recorded on the PR.

Corrected administrator publication/denial proof: `graylum-opc-metadata-green.log` passed 2 cases / 153 unselected, process exit 0; ordinary editor save preserved both metadata arrays after an actual versioned publication. Browser import/review invalidation, package isolation and unauthorized direct RPC denial also remain covered. Source field preservation is verified by the resulting registered workflow, not by UI field names alone.

## Persistent mentor and form-result correction

The Owner rejected the help-on-demand and duplicate-organizer interaction. The current product contract supersedes the two earlier presentation corrections above: the configured step navigation remains at the top; the current step alone is rendered below; a persistent, independently scrolling mentor conversation is on the left and the current-step structured form is on the right at wide widths. The mentor opens with the current step's first useful question and remains available for multiple turns. Users do not open a help panel or write a second artifact. On narrow screens the mentor remains first so the active question is not hidden after a long form.

The mentor response contract is a bounded JSON projection containing user-facing text plus a whitelisted information patch. Suggested values can fill only empty fields and remain provisional until the user confirms the step; they cannot overwrite user text, invent confirmed facts, expose instructions or return billing receipts. Direct form edits use the existing versioned information command after a 700 ms IME-safe debounce. Ambiguous responses retain the original request identity, definite version conflicts refresh once, failed edits remain in the browser buffer, and the UI reports saving, saved or retry state. There is no routine manual-save button.

The structured form is the step result. `确认本步骤` first flushes autosave, checks required information, then freezes the same schema-ordered values through the existing save/confirm transaction. It makes no model call, attached-organizer call, new reservation or second artifact. A lost success response replays the original information/save/confirm identities. The next step becomes available only after that confirmation. Existing versioned report publication and first-week plan adoption continue after all configured steps are confirmed.

The preserved pre-fix paths include the earlier organizer call and its synthetic settlement; those runs remain historical evidence for that earlier candidate and are not acceptance evidence for the final interaction. Current focused isolation passed the mentor and form-result browser cases together: **2 passed / 172 unselected**, process exit 0, including multi-turn step isolation, suggestion-to-form persistence, refresh/re-login, response-loss recovery, no duplicate Runtime/organizer/model call, and no second reservation. The complete manual positioning, plan, adoption and authenticated recovery case separately passed **1 / 173 unselected**, process exit 0. Earlier focused attempts with fixture-instruction and cold-page timing defects remain failed runs. A later full run reached 17 passes but failed the mentor reload assertion because its one-second poll observed the page before the history query completed; the browser also reported duplicate React keys for a repeated recovery projection. It remains a failed run. The UI now deduplicates mentor executions by persisted execution ID and the recovery assertion uses the same bounded 15-second read window as the other browser recovery checks.

Final complete OPC isolation with the retained original private publication input passed **19 / 155 unselected**, process exit 0. It applied 0107 twice and exercised PostgreSQL, Auth, PostgREST, Next, the actual services and synthetic loopback HTTP. The original-method proof read back 14 files, six configured steps and 23 profile fields from input SHA-256 `4e33b7521157ccddff42c159da644880cf3e3464fb39f72263d958c7f238ff9f`, with zero real provider calls. The runner's private-canary scan also passed. CI and exact-candidate review results are recorded on the PR.

## Review follow-up: Skill-result eligibility and invalid plan recovery

Independent complete review of `87d4f9476114885200c317c7f267df6f26641e02` found two P2 issues. A completed ordinary conversation in a work-item Session still displayed the Skill-result save action even though the server correctly rejected it. The 0107 public Runtime projection now returns only a `skillExecution` boolean derived from the frozen server payload; it does not disclose module, Skill or revision identities. The browser shows the action only for the completed Skill execution. The regression runs an ordinary reply and a Skill reply in the same work-item Session, verifies exactly one save action, saves the Skill result once, rejects direct ordinary-result saving, and preserves source-revocation denial.

A completed plan execution whose authorized public body was invalid JSON or violated the bounded plan schema also retained its browser request identity forever. The service now labels only that definite post-RPC validation outcome, and the router returns a typed invalid result. The browser clears the rejected identity after receiving that result, while prepare, execute, network and other ambiguous failures still retain the original identity. The regression submits an invalid completed plan, verifies the rejected identity is removed, corrects the account input, receives a valid candidate on a distinct request, and preserves the user's original title and brief.

The first combined focused run failed both cases: the plan assertion inspected storage before the asynchronous request finished, and the expanded browser result test retained Vitest's 20-second default timeout. The second combined run passed the work-item case but repeated the early plan assertion; neither failed run is a suite pass. After waiting for the actual `opc.planResult` response and setting the existing browser timeout explicitly, the plan case passed separately. Final complete isolation passed **20 / 155 unselected**, process exit 0, with 0107 applied twice and the private-canary scan passing. API unit tests passed **82 files / 1,879 tests**; repository lint, TypeScript and the 45-page production build passed. Exact-head CI and independent review are recorded separately on the PR.

## One conversation across every configured step

This latest Owner correction supersedes the earlier per-step mentor-message filtering described above. Step navigation changes only the structured form and the mentor's current information target. All configured steps share the draft's original Runtime Session, one composer buffer and one uninterrupted visible mentor history. The UI no longer filters executions by their originating step or remounts the conversation when a step changes. Each message keeps a small originating-step label so its response projection is still parsed against that step's field allowlist; organizer, plan and unrelated Runtime executions remain excluded.

The Runtime contract already stored every mentor turn in the same Session with a bounded history window. The current-step instruction now explicitly tells the model to continue the single workflow conversation, and the cross-step regression verifies that the next step execution freezes dependency edges to the prior step's actual mentor executions. Browser coverage also checks identical visible history while moving backward and forward, one unsent composer draft across a step change, refresh and logout/login recovery, and suggestion persistence in the correct right-side form. No new Session, provider retry, reservation, result projection or cross-step field write is introduced by this correction.

The first two focused runs correctly failed because the synthetic loopback fixture still recognized only the former field-allowlist wording and therefore returned an empty patch; extending the poll did not hide that failure. The fixture now accepts both bounded phrasings, and the same focused case passed **1 / 174 unselected**, process exit 0. Final complete OPC isolation with the retained private publication input passed **20 / 155 unselected**, process exit 0. It applied 0107 twice and covered 3/4/6/8-step workflows, the original 14-file six-step method and 23 profile fields, the shared conversation and frozen cross-step dependencies, browser refresh/re-login, authorization, recovery, autosave, plan adoption and handoff. The private-canary scan passed and real provider calls remained zero. API unit tests passed **82 files / 1,879 tests**; repository lint, TypeScript, diff/secret checks and the 45-page production build passed. Exact-head CI and fresh complete-candidate independent review are recorded separately on the PR.

The first independent complete-candidate review of `f7f9baa095a9b55986cc76f5deb69078bdc82d7f` found one P2: a definite version/review conflict during step confirmation left its stale recovery envelope in browser storage forever. Confirmation now removes only that step's envelope after a named, definite server rollback and refreshes authoritative state; timeouts, unavailable responses and lost successful responses retain their original identities. The browser regression advances the information version outside the page, verifies the stale confirmation is rejected and removed, then combines that path with a lost successful save response and recovers exactly once. Its first combined run failed because the assertion reused the still-visible prior error and reloaded while the second request was active; it is retained as a failed run. Waiting for that prior error to clear produced **1 / 174 unselected**, process exit 0, and the subsequent complete OPC run again passed **20 / 155 unselected**, process exit 0. A fresh review is required for the repaired head.

## 2026-09-15 连续引导与独立周计划修正

Owner 要求保留全程同一对话，切步立即引导、回看已完成步骤不重做；聊天中可提出旧步骤修改，确认最终定位后进入独立周计划页。

- `/positioning/[draftId]` 的步骤引导随当前表单即时更新，显示缺项或修改提示；它是确定性的步骤提示，不伪装成模型新回复。浏览步骤不派发、不追加伪造对话、不扣费。每次实际发送仍冻结当前步骤、服务端步骤状态与完整允许字段表，并使用原 Runtime Session 的有界历史。
- 2026-09-18 Owner 修正后本条部分被取代：首次进入当前问题、以及确认后进入下一题时，宿主用同一持久 Session 主动产生一次真实导师引导，不需要用户先发占位消息，也不写入伪造的用户消息（请求携带宿主标记而非用户发言）。回看已确认问题只恢复既有内容、不重新派发。主动引导的请求身份由草稿、步骤和问题确定性派生，刷新、重新登录、多标签与丢失响应复用同一回合，不重复执行或重复扣费。具体实现与验证见本文件 2026-09-18 小节。
- 模型可提出另一合法步骤的 `targetStepId`，结果只按该步骤字段白名单投影。已有值先保持不变，Owner 显式采用后才沿现有版本化 information RPC 保存；已确认结果及受影响后续成果按既有规则失效待核对。未知保存响应保留原采用请求；明确版本拒绝后可重新核对。模型不能直接确认、发布或承接。
- 最终定位确认成功后导航 `/positioning/[draftId]/plan`。新页面复用原草稿/计划/承接接口，展示定位摘要及平台、具体账号、选题、日期和简报表格；可返回原导师对话。定位尚未确认时不可从该路由绕过发布要求。
- 修复前回归：`/private/tmp/pr422-step-guidance-red.log` 在真实 PostgreSQL/Auth/PostgREST/Next 浏览器中失败，旧切步提示未出现新阶段引导，child exit 1。此日志是失败证据。
- 本轮真实模型理解、跨步骤意图识别与归纳质量仍 NOT_RUN；合成响应只验证投影、明确采用、保存恢复和唯一调用身份，不代表模型能力验收。

- 本轮完整运行 `pr422-flow-full.log`：19 通过、1 失败、155 未选择，退出 1，不能称为套件 PASS。失败位于连续对话浏览器首次进入草稿后的表单加载等待，尚未到新增断言；已改为等待真实表单可见，保留原业务断言，聚焦复验见 `pr422-flow-focused.log`，最终结果记录在精确候选 PR 评论。
- `pr422-flow-api-unit.log`：82 文件 / 1,879 单测通过，退出 0；`pr422-flow-unit.log`：3 项受控响应投影测试通过，退出 0；lint、TypeScript 通过。首次本地 build 缺构建所需非凭证环境变量，退出 1；按仓库 CI 的 local.invalid/非凭证值重新运行 `pr422-flow-build-ci-env.log`，退出 0。
- 原 Owner 体验环境原址保留，未重建草稿或数据库；`pr422-flow-preview.png` 是更新后的真实本地浏览器截图，仅证明界面与已有结果读取。Staging 真实接入准备与费用/操作边界见 [真实对话准备方案](v3-workbench-staging-dialogue-plan.md)。
- 聚焦第一轮 `pr422-flow-focused.log` 退出 1：新回复尚未投影时测试命中了旧建议入口。现每步骤仅保留最新可采用建议（聊天原文不删除），并等待本次具体修改内容后操作；对应复验 `pr422-flow-focused2.log`，最终状态在候选 PR 记录。
- 独立审查 P2：显式无效 targetStepId 不得回退后把同名字段写入当前步。`pr422-invalid-target-red.log` 对 95d07830 原函数运行反例，退出 1；修复后 `pr422-flow-projection-final.log` 4 项通过，退出 0，覆盖缺失目标、原型名、null、数字目标；仅目标字段省略时沿用原步骤。
- 聚焦第2/3轮仍为失败，分别在自动保存前读取 null、历史尚未加载前采集对比基准；保留 `pr422-flow-focused2.log`、`pr422-flow-focused3.log`。现等待实际持久状态/第三条历史出现后再保留原业务断言，最终运行 `pr422-flow-focused4.log` 的真实退出和结果由精确候选 PR 记录，不拼接为完整套件 PASS。


## Autosave edit-baseline correction (2026-09-15, in-progress candidate)

Both Owner-reported overwrite paths were reproduced with the real isolated PostgreSQL/Auth/Next/browser runner against the pre-fix page. `pr422-autosave-real-red2.log` preserves the conflict-retry failure; `pr422-autosave-real-red4.log` preserves the stale-buffer/fresh-version failure. Each assertion observed A's saved field become empty after B submitted another field, process exit 1. Earlier fixture-registration and cold-login failures did not reach these counterexamples and are not product reproductions.

The page now keeps an independent edit baseline, merges only actual changes into the current server snapshot, and retains local input when the same field conflicts. The user sees the compared values before explicitly retaining their changes. Autosave and new mentor-adoption requests share this merge path; ambiguous transport outcomes retain the immutable original request. Missing legacy edit baselines require explicit comparison rather than silently treating stale values as new edits.

`pr422-autosave-full1.log` completed with **24 passed / 156 skipped**, process exit **0**, and private-canary scan PASS. Source snapshot digest: `d41b5bda5e785bd74fdafe96514d5c27864e6fe3a8a6582d9f1f8db91ee365e1` (uncommitted snapshot based on ca03420a, not the ca03420a commit itself). This run covers configured 3/6/8/4-step flows, original Session/mentor persistence, confirmation without another model pass, plan/handoff recovery, work-item source denial, and all five new autosave browser cases: fresh-version overwrite, conflict retry, same-field comparison, offline retry and committed-response loss across reauthentication. The original private Skill publication-input case was skipped in this run; its earlier exact-input evidence is separate. Later real-provider bridge edits are not covered by this snapshot.

The private real-protocol adapter/evidence tests pass **27 cases**, exit 0 (`pr422-provider-exact-cost-unit.log`), including HTTP error observations, bounded bodies, no transport retry, denied tools/plugins/remote content, malformed choices and exact exponent-form costs. Current TypeScript and diff checks pass. The API-wide unit run remains **FAIL: 1 failed / 1,905 passed**, exit 1 (`pr422-provider-api-unit1.log`): the existing local AgentKey MCP fixture hit its 200 ms connection deadline under concurrent test load. Running that exact unchanged file alone passed **32 cases**, exit 0 (`pr422-provider-agentkey-focused.log`); this does not relabel the failed full run as PASS. No real AgentKey or model call occurred.

The candidate remains **NOT clean**: real Staging policy/budget/forward-schema wiring, affected end-to-end provider-contract proof, exact-head CI and fresh complete independent review are unfinished. No merge, remote migration/configuration, real provider cost or Owner real-dialogue acceptance is claimed.

2026-09-16：`pr422-opc-full-staging-stack.log` 在完整 0105/0106/0107/0108 隔离迁移栈下完成 OPC 全量：24 通过 / 156 未选择，退出 0，private-canary PASS。源码快照 `c66edb5907b6aebc2bc99ae751945a7148e1526f14f37ddf7afd145158c9576c`，包含 OPC wrapper 保留、全流程、确认不重复模型调用、五类自动保存浏览器场景。原私有六步输入用例本轮未提供输入，仍单独跳过；不冒充新的原方法验收。该轮浏览器走本地 fixture 分支，不替代 Staging 专用 host/真实供应商验收。后续维护分支变更由独立的 actual-router/HTTP 聚焦记录验证，最终完整候选审查仍待完成。

## Positioning consent separation (2026-09-20)

`确认正式定位` 现在只发布正式定位版本并弹出「是否继续生成第一周选题」询问，不再冻结生成请求、也不再跳转到计划页；发布定位本身不调用模型。选择「稍后」、关闭、Escape、刷新或仅重新进入草稿都不产生选题执行，也不创建账号或工作项；再次继续入口保留在已完成状态与 `/plan` 页。

生成请求改为携带显式同意标记的冻结包（`v:3` + `consentedAt`）：只有用户明确选择「继续生成第一周选题」或点击「生成候选」才会写入该标记，随后仍沿用原有 request/execution/billing 身份与幂等重放。旧版本 `v:2` 冻结包与更早的裸请求仍可读取，但只在用户显式点击「继续这条原请求」后按其原 request id 重放，页面挂载、刷新或跟随链接都不会自动执行；「丢弃这条记录」会把本机原值归档到 `…:stale:<时间>` 后再清除。

本增量在隔离 disposable 栈实测（本机 Docker，仅新建隔离数据；未触碰保留中的 Owner 预览 `owner422-5d14112b`、原始输入或取证卷/归档）：

- `run-workbench.mjs --opc-only --case-pattern='^OPC: (Stage C1|browser manual positioning|browser can correct plan inputs|workbench (save|confirm) conflict recovery)'`：**5 passed / 202 skipped**，退出 0，private-canary PASS。含改写后的 Stage C1（先询问、稍后与刷新零花费、显式继续恰好一次）与 F1 确定拒绝/丢回包恢复。
- `run-workbench.mjs --opc-only --case-pattern='^OPC: (Stage C[2-8]|a retained handoff request|a confirmed positioning produces|the Agent opens the current question|question-by-question confirmation keeps mentor|plan generation uses the original SDK|a revised round opens|a revision makes the page|revising positioning retains)'`：**15 passed / 192 skipped**，退出 0，private-canary PASS。旧 Stage C2–C8 的丢回包/多标签/跨轮次幂等恢复断言保留。
- `pnpm --filter web lint` 与 `apps/web` 的 `tsc --noEmit`：通过。

旧 Stage C「确认定位即授权生成」的验收口径已按新产品决定（架构文档 §5.1）作废，不再作为验收预期。本增量不含选题 Agent 工作对话与来源/Skill/Session 持久绑定（该闭环仍未实现），也不含真实模型、Staging/远端环境与 Owner 产品验收，均为 NOT_RUN。

## Retained request identity and state (2026-09-20, second correction)

`继续生成第一周选题` 对**已同意**的 `v:3` 冻结包不再覆盖身份：它按原 request id 继续该请求，"重新生成（新请求）" 是独立显式动作，被替换的本机记录归档为 `…:replaced:<时间>` 而不是被丢弃。旧 `v:2`/legacy 记录不再声称"尚未执行或没有费用"：新增只读 `opc_plan_request_state`（迁移 `0112_opc_plan_request_state.sql`）返回服务端自己的 identity/lifecycle（是否准入、material revision/撤回、turn purpose、execution state、是否有结果、财务是否已关闭），页面据此区分"服务端没有准入记录""结果尚未确定""已完成可恢复读取""来源已撤回"，每一种都保留按原身份的恢复入口，核对失败时明确写"暂时无法核对"。

隔离 disposable 栈实测（仅新建隔离数据；未触碰 Owner 预览与取证资源）：

- `run-workbench.mjs --opc-only --case-pattern='^OPC: (an explicit continue keeps|a local record without consent|Stage C1|Stage C4|Stage C5|workbench (save|confirm) conflict recovery)'`：**7 passed，退出 0**，private-canary PASS。
- `pnpm --filter web lint`、`apps/web` `tsc --noEmit`、`node --test scripts/tests/*.test.mjs`（44 passed / 0 failed）：通过。

仍未实现：评论 5748406396 的 B/C（绑定来源与 Skill 的多轮选题工作对话、服务端持久绑定与拒绝语义、对话内候选版本与采纳承接）。真实模型/provider、Staging/远端环境与 Owner 产品验收仍然 NOT_RUN。

## Positioning → topic conversation → adoption continuation (2026-09-20, GPT-6)

This batch continues the existing PR/branch and does not complete the other historical Owner requirements. The original worktree was clean at `0129c4b0`; no old writer process was active. Owner preview `owner422-5d14112b`, other retained previews and forensic resources were not modified.

- Explicit consent now uses one atomic server operation to check the displayed source against the immutable binding. Cached/missing/failed binding queries and `BOUND`/`SOURCE_CHANGED` cannot cause an unchecked navigation. The original F1 canonical binding-row stability assertion is retained.
- Additive `0114_opc_topic_consent.sql` records one immutable first-turn request/input per workspace after explicit consent. Opening a URL without consent does nothing. Repeated consent and concurrent pages recover that same intent. Existing bound conversations with turns do not acquire a new automatic opening. The bound source round and original material revision drive later topic turns rather than the current draft round/latest material.
- Topic chat, candidate save and adoption retain the complete original operation in Session-scoped browser storage before dispatch. Unknown outcomes retain original request IDs and payloads, including source/body/expected plan and account revisions. Named transaction rollbacks release only the rejected request, retain an archive and require a new explicit action. Browser locks serialize recovery across tabs.
- Replies show readable topic rows; candidate titles/briefs and the target existing account can be edited and restored after refresh. Partial-account or historical selections first become an actual saved plan version. The user then explicitly adopts that displayed version through the existing atomic handoff. Persisted handoff links survive refresh. No implicit article/script generation, external account creation or publication is added.
- The consent dialog focuses correctly for Escape and provides a close control. Topic page scrolling keeps recovery controls reachable while candidate/history panels are expanded.

Validation is local PostgreSQL/Auth/PostgREST/Next/Chrome with a synthetic loopback provider. The fixture asserts that the topic instructions and confirmed material reach the request; this does not establish real method/model/research quality. `0114` is applied twice by the runner and re-applied against populated consent records by the concurrency test. The migration preserves old plans, bindings, turns and paid records, denies client roles direct table/function access, and enforces actor/source ownership. Application rollback can leave the additive table/read fields in place; do not delete consent/turn history or roll back monetary records.

Focused evidence (logs retained outside the repository under `/private/tmp/pr422-gpt6-*`):

- `first2`: Stage C1 + topic binding/permission/identity tests: 2 passed, exit 0.
- `closure2`: Stage C1, original workbench save/confirm recovery, topic edit/subset/existing-account/adoption path passed individually. Overall run FAILED (4 passed, 1 failed) because the v2 test expected a different status phrase, plus an interception teardown race; it is not a suite pass.
- `final-browser`: consent/close/Escape, topic permission checks, populated migration/consent concurrency, and executed-v2 upgrade recovery passed individually. Overall run FAILED (4 passed, 1 failed): the topic test checked execution count before its intentionally intercepted admission finished. The fix waits for the actual aborted successful response before asserting durable effects or reloading; no sleep or relaxed identity assertion.
- `concurrent`: Stage C4/C5 and two real topic pages simultaneously consenting: 3 passed, exit 0; one execution/run/reservation and one opening identity.
- Web ESLint and TypeScript passed; scoped handoff projection unit test passed; CI safeguards: 44 passed, 0 failed. Required remote CI and fresh full-candidate semantic review are recorded on the PR after delivery.

Earlier failed attempts are retained: the initial migration was missing from the runner's tracked source copy (before initialization), a real recovery-button overlap was fixed in the page, and legacy status matching/interception teardown was corrected in tests. None of these runs is relabeled PASS. Real provider calls, remote migrations, production, merge and Owner product acceptance remain NOT_RUN.

Final focused rerun `pr422-gpt6-closure-preview2.log`: **3 passed / 212 unselected, test child exit 0**, no unhandled errors, private-canary PASS. It covers successful consent/admission/save/handoff responses deliberately lost after server commit; original complete payload recovery after refresh/re-authentication; multi-turn reply and manual-edit restoration; saved subset version selection; a definite stale-existing-account rejection followed by explicit retry; work-item entry with no new topic/model/billing work; executed-v2 upgrade recovery with identical request/execution/run/reservation identities; and two real pages explicitly consenting concurrently with exactly one first execution/run/reservation. The isolated synthetic preview `topic422-gpt6-20260920` is retained separately for this batch's Owner handoff. Its fixture is synthetic, not the Owner's original private method or a real model-quality demonstration. Final lint/typecheck and diff checks pass. This result does not replace the separate old-mentor recovery and source-permission evidence above or claim the unrelated 17 requirements are complete.


Independent review follow-up (same batch): the fresh enforced-read-only Codex review of `b39be54a` reported two concrete findings (PR comment 5750420899): cross-round legacy recovery could authorize a new topic opening, and invalid edited input could remain permanently pending. The follow-up preserves the original envelope/source, queries the original execution, reads its result through the original turn/source, and shows recovered historical results separately. A revised-but-unpublished positioning also retains the recovery entry. Unadmitted old-round records stay intact and cannot dispatch against the new round. `0115` replaces only the result reader, retains owner/source/evidence checks, does not mutate existing rows, and is repeatable; rollback may restore the previous reader while keeping all records, with the known cross-round read limitation. Client and server now share the exact pure request schemas: invalid new input never dispatches, and old invalid pending records are archived/released before any dispatch so editing remains possible. Transport-unknown valid operations still replay the original complete request. No model/provider, remote database, deployment or governance change is included. Follow-up validation and exact-candidate independent review are recorded below/on the PR.

Follow-up evidence: `pr422-gpt6-reviewfix-final.log` completed **8 passed / 2 failed / 209 unselected, exit 1**. The eight passing cases include old v2 executed/lost results in unchanged, revised-unpublished and revised-published rounds; old v3 after publication; original source identity and other-actor/revoked-source denials; repeated 0115 against populated data and function privileges; invalid empty title/brief/overlength chat and recovery of an invalid pre-upgrade pending record; two concurrent topic pages; and Stage C7/C8. One failed assertion expected the specific unadmitted-old-request notice while the generic error handler hid it; the notice is now visible. The other checked local pending removal at the default one-second deadline while the real handoff replay returned HTTP 200 after 1326 ms. That assertion now waits up to 30 seconds for the actual recovery record to clear, retaining exact payload/identity assertions. Neither failure is relabeled PASS. The earlier `reviewfix-browser1` attempt was interrupted after its obsolete automatic-archive assertion and a result-reader alias ambiguity were identified and corrected.

`pr422-gpt6-reviewfix-consent.log`: **4 passed / 215 unselected, exit 0**, private-canary PASS. Stage C1, updated C5, explicit-continue retained identity, and unconsented server-state recovery pass with the final notice/source behavior. Web typecheck and lint pass. Final adoption-recovery rerun and new exact-head review follow on the PR.

Final follow-up rerun `pr422-gpt6-ready.log`: **2 passed / 217 unselected, test child exit 0**, private-canary PASS. The full topic browser path (including complete frozen handoff recovery after re-login) and two-page first-intent concurrency pass on the final implementation. Final source-identical synthetic preview `topic422-gpt6-ready` is retained. Combined with the four passing consent tests and the passing historical/invalid-input cases above, both independent-review findings are addressed. Real provider quality, Owner acceptance and other historical product requirements remain unclaimed.


Second independent review follow-up (comment 5750598235, `1a136aec`): the reviewer confirmed the two earlier fixes and found that in-memory mentor-consumption tracking could reapply an old suggestion after a saved clear, including in a revised round. `0116` now projects only the frozen information version from each already-owned execution; the client auto-projects only a matching current round/version after hydration, and leaves any local edit untouched. History and explicit suggestion adoption remain available. Successful autosave advances the existing information version, so later history cannot silently refill a cleared field; genuinely unread lost replies with unchanged input still recover. No new ledger or dispatch path is introduced. The additive read wrapper preserves underlying ownership checks, is applied twice, and is tested again with populated executions; rollback can restore the prior reader without any data migration, at the cost of automatic form projection until compatible metadata is present. Real provider/remote database/Owner preview operations remain excluded.

Mentor regression evidence: `pr422-gpt6-mentor-basis2.log` remains FAILED (1 passed / 4 failed): the newly added local-edit check also read a ref mutated inside a React state updater, making repeated updater evaluation inconsistent; new test reads also incorrectly assumed initial information was non-null. The updater now bases that guard on its state argument only; test reads permit the actual initial null. `pr422-gpt6-mentor-basis3.log` is 4 passed / 1 failed: both saved-clear scenarios, genuine executed-lost-reply recovery, and autosave/confirm recovery passed with original identities; the long mentor case passed its cross-step projection but reached an existing 1-second assertion before asynchronous explicit suggestion adoption completed. That assertion now waits up to 30 seconds for the same exact saved value, without relaxing identities or acceptance. The final long-flow rerun is recorded separately below. The earlier first attempt failed before these checks because the initial SQL wrapper used an ambiguous local name; the corrected wrapper uses `projection`.

Final long-flow rerun `pr422-gpt6-mentor-long-final.log`: **1 passed / 221 unselected, exit 0**, private-canary PASS. Original multi-step mentor history, exact execution/request/billing recovery after lost response and re-login, and explicit cross-step suggestion adoption all passed. Together with the four individually passing cases in `mentor-basis3`, the affected mentor paths pass; that earlier aggregate remains FAILED. Web TypeScript and the repository web lint command pass (the existing ESLint configuration does not lint TSX directly). The retained synthetic preview `topic422-gpt6-ready` was restarted from this code with 0116 applied to its owned local database, preserving its data and URL; the rendered topic page was read back through the browser.

## 2026-09-21 B1 default-entry UX correction (Owner comment 5762150079)

First-principles implementation check: existing `opc_query` owns the actor-scoped draft/account/work listing; `opc_businesses`, `opc_draft_businesses`, Artifact projects/rounds and source versions already hold the names, dates and pinned method. The missing capability is a read projection, not new storage. Migration 0120 extends the existing reader without table grants, new RPC families or writes. Rollback can restore the previous reader; all records remain, with less entry metadata. The original reader still performs authentication and ownership checks. This correction adds no infrastructure primitive; the pre-existing B1 tables remain the sole business authorities.

Candidate expansion is presentation state only. Adoption still uses the exact frozen body/version/account operation, and successful adoption collapses the candidate without deleting the unadopted remainder. Existing content work selects its own source method by default; choosing a reply as the final script is an explicit user action, not automatic classification of every Skill reply. Script finalization and optional derived generation retain separate existing requests and versions. A user who temporarily ends can return to the same script's choices.

The delivered synthetic runner had two confirmed faults: curation disabled its separately configured extraction model, and served UUID provider IDs could not be read by the numeric-only receipt endpoint. Curation now retains the configured extractor; receipts use their exact provider ID and a local fixture evidence file so restarting that fixture does not forget new known receipts. Old unknown IDs are not invented or relabeled as settled. Owner's previously used previews and data remain untouched. The old delivered preview was read only: its configured OPC organizer was inactive; its six existing Runtime executions were completed. This does not prove the reported new send was admitted or a database deadlock.

Verification must include the final curated preview and its delivered login identity, not only the test setup before curation. The added default-entry browser journey creates a new named business through the visible page, sends a mentor message and observes extraction/persistence, enters another existing-strategy business through the visible form, publishes and explicitly consents to topics, adopts only part, returns to the library, drafts/finalizes a specific script, temporarily ends and finds the same work again. Separate focused recovery coverage includes lost successful adoption, real re-login, lost derived-result responses, concurrent consent, subsequent script revision and stale derived versions. Results are recorded on the PR after actual execution; no synthetic result demonstrates real model understanding or quality.

Actual results: `pr422-b1-ux-0921c.log` had 3 passed / 1 failed (login navigation timing in the start-request recovery test), not a suite PASS. `0921d.log` revalidated default subset/library/video flow and new-business cross-actor/re-login recovery successfully; it was interrupted when another stale test attempted to preselect the now-collapsed mode control. Both hidden mode preselection sites were removed. `0921f.log` then passed 3 selected cases (script consent/partial choice/UUID pending-receipt recovery and stale derivatives; concurrent topic consent; actor-scoped projection with populated repeat migration), followed by the separately invoked post-curation default-journey test: 1 passed. No numbers are aggregated into a claimed full-suite pass. The delivered-identity page journey made every business mutation through visible UI; its screenshot and URLs are in the preview evidence directory's `default-content-journey.png` / `default-journey.json`. Lint, web typecheck (including API imports) and 19 preview lifecycle/resource tests passed. Early interrupted fixtures and address-pool setup failures remain logged; only this task's unserved temporary Docker resources were removed, preserving evidence and all earlier Owner previews.

### Owner 预览反馈修正：分镜依赖与跨业务拒绝（2026-09-21）

实现前核对权威机制：账号归属由 opc_accounts/business_id 与原子 opc_adopt_topics 决定；明确拒绝仍为SQL事务回滚，未知结果继续冻结原请求。复用候选编辑与实际采用版本，不迁移账号、不清空未知请求。口播稿/分镜仍由 opc_content_versions 权威保存；0121 仅修正现有 material prepare，新 editing-only 请求须存在匹配分镜，精确分镜版本/ID/正文冻结进现有 Runtime material；旧绑定在新校验前原样重放。无新表、API family、状态机或基础设施。Risk high（现有RPC准入条件修正），须隔离验证，不触碰旧预览的数据。

聊天协议标记与JSON仅作显示转换，不改写历史Runtime原负载。提问按已保存成果呈现；组合请求明确要求Skill先分镜再基于分镜给出剪辑建议，模拟一次返回仅证明接线，不能证明真实Skill质量或分步骤执行。

Docker清理：Owner要求后，归档并回收60个遗留临时容器、20个网络及其匿名卷；保留所有命名Owner预览/取证/其他项目。归档 `/Users/simon/.graylum/docker-cleanup-20260921/`。发现旧runner只在serve就绪后监听终止信号，普通测试中断会绕过finally。最小修正将监听前移，终止活动测试进程组，并经原finally回收资源；不新增清理服务/调度器。实际SIGTERM验证创建3容器后remaining=[]，网络不存在，证据 `/tmp/pr422-signal-cleanup-result.json`。早期pool耗尽使用临时runner小网段，清理后恢复原runner，临时副本已删除。

本轮最终定向验证：`/tmp/pr422-owner-feedback-final2.log` 2 PASS /235 skipped：真实页面跨业务明确拒绝→原请求归档→账号修改→刷新→单题准确采用；动态分镜前置/自然语言拒绝、精确冻结分镜正文与版本、撤回来源、旧editing绑定升级重放、重复迁移、并发卡片/丢回包和重新定稿。此前 `/tmp/pr422-owner-feedback-test4.log` 3 PASS（含旧单项升级恢复）；`test3` 主闭环单项PASS但另2项失败，随后修复，不能合称全套PASS。`final.log` 新增断言曾发现返回投影误比及刷新勾选重置，已修正并由final2覆盖。lint、web typecheck通过；preview lifecycle/resources 19 PASS。旧paid/unknown按原绑定回放；模拟不证明真实Skill质量。当前Owner预览先备份数据后原址更新，不清空输入与历史。

独立审查在385ae164发现新卡片文案未被自然语言识别，必须修正后重新审查；已沿用原chooseVideo动作补充匹配（中文/英文逗号及空白），不增加派发通道。对应浏览器回归输入页面原文，断言无普通runtime.prepare请求、仅一个组合execution，并恢复同一丢回包成果。首次该回归在更早的选题阶段失败：后端新版本已保存但页面旧版本尚未替换时测试取消勾选。页面在原操作完成前禁用选择，测试等待实际新标题及可操作状态再选择，保留准确单题断言。

原址预览385ae164读回：旧视频协议已显示为分镜/剪辑自然文本。摄影课程原冻结请求经页面“恢复原请求”确认OPC_BUSINESS_CONFLICT，显示明确归属提示并恢复编辑，未替Owner改账号或采用；历史、定位、选题均保留。

`/tmp/pr422-natural-choice-final2.log`仍为FAIL：新禁用条件下断言在恢复回调刷新完成前读到disabled；改为等待该具体控件启用，不放松单题/版本/身份断言。

`natural-choice-final3.log`FAIL为新增观测断言误比：视频动作本来就复用runtime.prepare，不能禁止该RPC。已按原负载区分普通消息与视频协议请求，仍验证唯一视频execution、绑定及同一次结果恢复。

最终`/tmp/pr422-natural-choice-final4.log`：1 PASS /236 skipped，exit0，private canary PASS；覆盖多轮/部分采用/实际重登/资料库编辑和新文案组合请求成功丢回包恢复，无额外普通消息、仅1个组合execution。web typecheck通过。最终候选另见PR精确SHA/独立审查记录。

### 2026-09-22 右侧资料与内容类型反馈

写入前第一性检查：选题及历史已经由opc_plans/opc_topic_draft_versions保存，当前修改由opc_item_edits及原revision/请求表负责；Session/Runtime/BILL2已有执行去重、历史与付费恢复。采用Sheet右侧面板，链接使用既有handoff workItemId。类型直接存在计划行，用户后续纠正在既有item edits增加一个nullable字段，旧无类型选题保持unknown；只对已存在script成果的旧工作推导video。0122仅扩展原函数，内部类型读取无客户端权限，无新表/API family/状态机。普通成果旧记录保留读取；明确保存内容复用opc_content_versions。继续工作引导复用原Runtime，按当前成果ID/工作项ID稳定请求，浏览器完整冻结，跨标签/重进相同阶段不新增执行；只讨论，不隐含创作或派生授权。Risk high：既有SQL类型约束与Runtime准入，必须本地隔离验证及独立审查。

本轮验证记录：`pr422-content-types-test1.log` FAIL（测试清理误调用不存在的restoreCatalog，已删除；不能记为PASS）；`test2` 2 PASS/236 skipped，覆盖原B1多轮/部分采用/实际重登/资料库编辑/视频成功丢回包及新类型/面板/主动引导主线；`test3` 1 PASS/237 skipped，增加引导与类型保存成功丢回包、双标签及刷新原请求恢复。`pr422-types-video-regression.log` 1 PASS/237 skipped：分镜前置、部分派生、并发、旧绑定升级重放、0122已存数据重复迁移、重新定稿后旧版本及撤回保护。`pr422-content-types-final.log`为1 PASS/1 FAIL：扩展内容保存丢回包与唯一成果版本的typed case通过；资料库并发编辑仅旧提示文案断言失败，准确原字段/版本断言保留，改用新明确拒绝提示后单独复跑。最终结果和独立审查归属以PR最新候选记录为准，不把选中用例记成全套通过。新内部SQL helper无authenticated/service_role执行权，新Runtime口播请求和保存对非视频均拒绝。保存与类型确认冻结完整请求，旧script-key与新的written-key各自可恢复；不因用户改类型丢弃已冻结旧保存。文章/图文定稿材料复用现有Runtime material，继承原来源撤回检查。

独立审查408fbcb9发现同一execution先存brief后存script会复用Runtime material请求ID而冲突。最小修正复用既有content version.id作为新material identity；公开保存请求及完整冻结负载不变，已保存结果仍优先原样回放。来源检查同时支持新content ID和旧request ID+原正文匹配，不新增表或请求机制。补充真实页面改类型后同回复定稿，以及双方向相同请求ID保存/重复恢复和唯一material断言。资料库并发编辑最终`pr422-types-conflict-final.log`为1 PASS/237 skipped。

## 2026-09-26 U3：类型、工具结果、交互语义与升级兼容

范围依据：Owner 本轮明确的五项 U3 要求、`V3-OPC-growth-agent-architecture.md` §0，以及原网页交接对 UX Proposal v2 §14 的 U3 定义（统一类型、工具结果、保存/采用/聚焦/恢复及旧记录/请求/深链接兼容）。原 Proposal 文件全文未在本地或 PR 附件中取得，不宣称已逐字核验全文。保留已认可 UI、版本来源与上下文容量规则；未进入 U4、全站迁移、任意历史版本检索或真实外部服务。

### 修复及兼容边界

- `6d70caf1` 的实际 Runtime + 官方 SDK 0.18.0，在隔离 Postgres/Session 中发送带旧稿材料的请求，模型模拟服务真实返回，回执入库后在 Session append 前通过 RPC 故障注入模拟中断。`34bbea47` 恢复相同 execution 时得到 `RUNTIME_RESPONSE_CONFLICT`、停在 pending：`pr422-u3-red.log` 是完整失败证据，不是单函数哈希演示。
- 新 admission 在既有不可变执行负载内固定 `inputSelection=scope-projection-v1`。已有无标记执行先使用现有筛选；仅在 **replay-only 且数据库明确返回原请求哈希冲突** 时，使用升级前的输入选择方式做一次有界 SDK 回放。每个回包仍通过原哈希校验；不发送模型请求、不重写旧哈希/回执/材料/历史。无标记但已筛选的 `34bbea47` 请求不降级；有标记请求不协商其他策略。权限、存储错误不触发兼容回放。没有新表、迁移、执行器、Session、账本或持久化状态机。
- 修正旧浏览器 `opc-script-final` 未带 `kind` 的待恢复保存：沿用旧 `script/final` 语义；不能把同一请求重建为 `script/draft`。文章/图文采用仍为 draft，视频定稿仍为 final。
- 旧 `/positioning/:id/plan` 曾无条件跳转 `/topics`，导致原 v2/v3 本机计划请求不可恢复。复用原页面的解析、服务端请求状态、原 execution 恢复和结果读取，提供只恢复旧请求的兼容入口；没有本机旧请求时仍进入当前选题工作。未准入不补建请求，跨工作记录拒绝，撤销来源不显示缓存结果，旧轮次结果只读不采用到新轮次；不恢复旧生成表单，不新增平行工作流程。旧入口禁止定位自动保存与导师自动投影，查看不会写入定位。
- 图文正文/展开编辑/定稿按钮按图文显示，不再显示“文章”；继续工作不再固定专业问法的句数和问题数。视频的来源依赖、明确同意、禁止发布和严格 JSON 字段约束保留；专业写法继续由冻结 Skill revision 提供。

### 实际验证记录

- 旧 `6d70caf1` → 新代码：`pr422-u3-legacy-final.log` PASS，含已保存回执恢复完成、unknown 不重发、新标记请求恢复；原请求 UTF-8 3,914 / 3,920 B，新标记 2,585 B。逐项比较原 execution/request/run ID、冻结 payload、candidate/selected history、调用 hash、回执和原历史前缀，完成只追加一次应有的两条 Session 记录。保存新版后恢复仍依据原材料。
- 无标记筛选版 `34bbea47` → 新代码：`pr422-u3-filtered-upgrade.log` PASS；已保存回执与新标记均完成，unknown 仍 pending，恢复新增发送为 0，无哈希冲突。测试分别加载 exact-ref 源码与其锁文件依赖，只有模型网络和中断位置由测试控制。
- `pr422-u3-browser2.log` 中已通过的容量场景：1/60/100 个真实保存版本分别 3,388/3,390/3,392 B，仅当前稿；界面保存 v101 后 3,144 B 仅 v101，明确比较 7,556 B 保留 v100/v101，普通“比较喜欢当前稿”4,458 B 仅 v101。12 轮保留原始 24 条历史，最后请求 12,413 B，仅 v12 全文。9,000 B 工具请求为 5,205/5,908/8,508 B，两个完整调用/结果对、必要来源出现一次；4,000 B 时明确 capacity，保留两份工具成果，未发送超限第三次请求。
- 同一初轮日志包含两个 FAIL：旧视频用例未通过当前可见入口确认类型，且仍查找已改为折叠摘要的旧 heading。测试已改为点击“视频”并读取实际成果/版本状态；未改变生产类型规则、原输入、版本归属或重复执行断言。这些 FAIL 不计为通过，定向复跑另记。
- `pr422-u3-followup.log`：工具拥挤场景中，在三次回执和两个工具结果完成、Session append 前中断，原身份恢复完成；三个请求仍为 5,205/5,908/8,508 B，没有新派发或重复追加。两个旧视频用例复跑通过。新增 Skill 切换断言初次因测试模块同名匹配四个按钮而失败，改为独立模块名后 `pr422-u3-typed-final.log` 通过：同一 Session/execution、固定 Skill revision、图文草稿自动保存→明确定稿、历史查看和资料库一致。旧无 kind 口播保存缓存恢复与重复定稿已在 `pr422-u3-legacy-ui.log` 通过；同一日志旧计划深链接失败暴露上述真实兼容缺口，保留 FAIL。修复后 `pr422-u3-legacy-link.log` 5 PASS，含 v2/v3 原请求、跨轮次与丢回包、他人拒绝、来源撤回以及非法选题恢复。
- 增强拒绝路径：旧请求未准入时，页面保持按钮禁用、原缓存完全不变且执行数为 0；准入由测试服务显式完成后才进入旧请求恢复。`pr422-u3-revoked-link.log` 1 PASS，等待实际授权拒绝后再断言缓存正文不显示（不是加载态空白断言）。当前手动定位、六阶段引导及 v2 当前/草稿轮次在 `pr422-u3-legacy-link-final.log` 中逐项通过。未完成或超时的汇总执行不算整套通过。
- Runtime context/Session/admission 单元测试 14 PASS；web typecheck、web lint PASS。午夜临时目录有 562 个未改动跟踪文件及 Git 指针缺失；先备份差异，仅从当前 HEAD 补回不存在的文件，现存修改全部保留；依赖按原锁文件离线恢复。没有 reset、分支更换或 Owner 预览清理。

真实模型理解/生成质量、供应商精确 token/usage、真实 compaction、远端数据库、发布/支付服务未运行。所有容量数字都是完整模型请求的 UTF-8 字节，不是 token；模拟 usage 不参与容量结论。历史任意版本按需读取能力未扩建。

## 2026-09-26 U4：核心工作区验证与交付（未授权合并）

沿用 Owner 的 U4 范围、当前产品说明及已认可合版；后续顶部导航、账号分类、入口和保存决定优先于旧原型。复用 U3 精确候选 `a8dba69c3ab80e91a1f48a9cccc9626f94d8eab7` 中未改动的 Runtime/SDK/数据库证明；不是重新开发 U0–U3、全站迁移或下一项 Launch。

### 原聚合超时：原因仍 BLOCKED

原 `pr422-u3-legacy-link-final.log` 保持 **6 PASS / 1 timeout FAIL / 255 skipped**。v2 published 的最后页面请求是 `/plan` GET 200；原日志没有阶段标记，不能确定它属于哪一次 reload（此前将其认定为撤销访问后的 reload，证据不足，在此更正）；当时数据库只读采样没有活动查询或锁等待，测试连接最后执行的是 execution/request 身份查询。原测试没有阶段结束标记或浏览器关闭追踪，不能区分最终身份读取的 Node 返回与浏览器清理阶段，也不能证明根因。`legacy-link`、`revoked-link` 单项成功不改变原失败结论。

在原 a8 生产代码上，仅加入测试阶段、耗时、未完成请求的 pathname 诊断（无正文、凭据或常驻日志），按原七项及相邻顺序运行 `pr422-u4-timeout.log`：**7 PASS / 255 skipped**。v2 published 在 16.710 s 看见实际撤销判定、16.714 s 开始关闭浏览器、16.907 s 关闭完成。未增加 300 s 超时、删断言或减少材料。此结果排除了这次运行的卡点，不能反推旧失败原因；没有继续盲目重跑。因此 U4 不能以最终 clean / 全部验收通过交付。

### 键盘缺口与最小修复

普通入口从定位进入选题、只采用第二条、生成文章、资料库返回及保存 v2 后，新增实际键盘测试。`pr422-u4-keyboard-red.log` 首先暴露过时的链接精确文案；改用当前可见箭头文案后，`pr422-u4-keyboard-red2.log` 真实失败于展开编辑打开后焦点仍在弹窗外。

复用已安装的 Radix Dialog，为展开编辑和历史比较提供进入焦点、Tab 限定、Escape 和关闭后返回焦点；保留原 DOM 样式类、内容、版本冻结和保存调用。无 CSS、Runtime、Session、SDK、依赖或数据结构改动。保留弹窗 aria-label，兼容资料库外层现有关闭保护。初次修复回归 `pr422-u4-keyboard-green.log` 为 **1 PASS / 2 FAIL**：展开版本冲突通过；另两项分别为焦点返回的同步断言（锁定 Radix 在 unmount 后 setTimeout 恢复）及新模态正确隐藏背景状态的可访问性选择器。改为等待同一焦点结果，以及读取该背景状态的 includeHidden；未放松保存、正文、身份或版本断言。

未接入/未运行边界：任意历史版本来源检索未扩建；完整个人中心、工单、高级编辑器、发布/支付/社媒集成不在本批。真实模型理解质量、真实供应商 usage/token、压缩 API、远端数据库与外部服务均 NOT_RUN；本地模拟回复不代表专业能力。Chrome 的桌面/390 px 模拟视口不是实机、Safari、Firefox 或完整读屏验收。

### 最终定向结果与证据复用

- `pr422-u4-final.log` 保持 **4 PASS / 1 FAIL / 257 skipped**：资料库定稿失败与迟到结果、自由对话附件/刷新、账号策略进入/修订隔离、展开编辑版本冲突通过；键盘主流程失败在窄屏仍查找桌面入口。改用实际“展开右边栏”后，`pr422-u4-core-final.log` **1 PASS / 261 skipped**：只采用第二条、文章 v1→v2、资料库返回、1600×900 与 390×844 的展开编辑和历史比较初始焦点/8 次 Tab/Escape/焦点返回、取消不改正文、未发送输入及编辑刷新/重新登录保留。不同运行不合称一次全套 PASS。
- 已实际查看当前渲染的桌面/窄屏定位、编辑弹窗、历史比较截图，并对照已认可合版的相同视口组件；标题/正文/操作区域可见、无横向溢出。当前应用窄屏历史为上下排列、原型截图有左右排列，底部按钮尺寸也有既存差异；本轮没有变更这些已认可应用样式，不宣称像素一致。`u2-article-*` 截图实际仍在历史弹窗状态，只能证明该状态，不能作为关闭弹窗后文章页面的视觉证据。
- U3 的文章/图文/视频标签与明确采用/定稿、Skill revision、v65/v67 来源、账号/用户与撤销保护、当前稿去重、9,000 B 连续工具及必要材料超限、旧 6d / 无标记筛选版 / 新标记版原回执恢复证据保留。U4 未改对应服务、SDK、SQL、保存或恢复逻辑；是否复用其完整审查覆盖由最终独立审查者判定。
- 本轮 web TypeScript 与仓库 web lint 通过；最终精确候选 CI/Security、独立审查和原址预览的源码核对结果记录于原 PR。预览继续使用 `pr422-u2-20260924` 与原数据，resume 而非 bootstrap；入口 `http://127.0.0.1:49550/positioning`。

交付状态：已修复并回归本轮实际键盘缺陷；旧超时根因仍 BLOCKED，不能宣布 U4 clean 或授权合并。证据保留在原 PR 及本机任务的 `pr422-u4` 输出目录；不新建审计台账或常驻采样。


### 2026-09-26 再次诊断：聚合通过，发现并修复确认入口丢失

- 原失败日志仍保留。其 Git 指针为 `34bbea47`，但隔离副本包含当时未提交的 U3 修改，副本已清理；不能用该 Git 提交的测试源码替代当时实际执行源码，也不能从最后一次重复调用的身份查询确定失败阶段。
- `pr422-u4-timeout-retry.log` 和 `pr422-u4-timeout-diagnostic.log` 均为 **6 PASS / 1 FAIL / 255 skipped**。原 v2 published 两次通过；失败均在相邻六阶段引导的“确认这项修改”入口。第一次 DEBUG 被 runner 的 cleanEnv 丢弃；第二次增加仅允许 `DEBUG=pw:browser` 的测试专用透传，真实记录启动、退出和临时目录清理，不输出 API 请求正文。
- 真实缺陷：已确认字段编辑后成为 provisional；自动保存完成、服务端投影刷新清除本地编辑时，右侧仅按当前 confirmed 状态筛选，导致该字段与重新确认按钮消失。刷新后稳定复现，不能用延长超时解决。现在从已有不可变 `artifact_requests` 中，按原授权读者已验证的同一 project/round/step 与 schema 字段投影 `previouslyConfirmed`，并沿当前轮唯一 `opc_revision` 读取其精确发布前轮所继承的 confirmed 信息；只保留曾明确 confirmed 的字段，未确认或仅 deferred 不纳入。UI 保留原编辑及明确确认操作，空值不可确认；不改布局、自动保存、Runtime、Session、来源或请求身份。
- 风险 **high**：增加 `0133_opc_confirmed_information_history.sql` 读函数替换，权限不变、没有新存储或数据重写。真实本地数据库验证：单字段确认但步骤未完成、编辑后刷新重新确认、未确认/延后字段排除、不同步骤/新轮次隔离、他人及撤销访问拒绝、客户端无执行权、重复应用与恢复旧 0120 读函数再升级；原历史逐行不变。回滚只恢复 0120 的 `opc_query`，不修改已保存资料。
- 第一次修复后运行 `pr422-u4-timeout-fixed.log` 在测试准备期因未跟踪的新 SQL 未被 runner 复制而失败，无用例结果；将新增迁移纳入 Git 跟踪后执行。`pr422-u4-timeout-fixed2.log` 为 **8 PASS / 255 skipped**（原七项顺序及新增读投影回归），没有增大预算、超时或减少输入。`pr422-u4-reconfirm-final.log` 为 **1 PASS / 262 skipped**，只为修正截图采样时机再次验证六阶段；实际查看刷新后字段正文及重新确认按钮截图，点击后服务端 confirmed 断言通过。加载态截图不计视觉证据。
- 实际浏览器追踪显示部分成功用例关闭 Chrome 等待约 24–25 s，随后 exit 0、临时目录清理约十余毫秒；其他关闭约百毫秒。锁定 Playwright 1.60.0 已有 30 s graceful-close 后 kill 兜底。本次原生采样为测试 Chrome 主线程空闲，不证明原 300 s 的原因。一次按已确认测试 PID 发出的终止命令返回 No such process，实际未终止进程；这些结果不能宣称原超时已归因或修复。
- web TypeScript/lint、runner 生命周期/资源单元测试 **19 PASS**。新精确候选 CI、独立审查与保留数据的原址预览结果见 PR 后续交付评论。

本次已关闭可复现的确认入口缺陷，当前相邻聚合通过；**原 300 s 历史超时根因仍 BLOCKED**，不以本次绿色覆盖原 FAIL，不宣称 U4 最终 clean。真实模型、远端数据库、支付、发布与压缩接口仍 NOT_RUN；未合并、部署或推进下一阶段。


Owner 后续决定：停止追查未复现的历史超时；在当前必要验证通过后，不再以该未知历史失败单独阻塞交付。原始 FAIL 和原因未确定的限制保留，不改记为 PASS，也不把 skipped 算作通过。独立审查另发现曾 confirmed 后明确 deferred 的字段不应继续显示为待重新确认；UI 已按当前状态排除 deferred，补充真实页面刷新及原暂缓状态不变回归。最终结果以新候选 PR 记录为准。


独立审查还发现：修订轮次继承前轮 confirmed 信息，却尚无本轮 confirmed 写入；仅查本轮历史会再次丢失重确认入口。0133 因此只沿当前 project/round 的既有 `opc_revision`（request_id=round_id）关联同 project 已发布前轮，读取当时继承的字段状态；不遍历任意旧轮，也不引入新状态。补 mentor 修订轮次编辑后刷新与确认的页面回归。`pr422-u4-deferred-final.log` 的 1 PASS / 1 FAIL 是新增测试仅等信息写入而未等整项确认结束，即发下一次版本写入，引发真实冲突保护；补等步骤 valid 后才进行下一项操作，不删除冲突校验。后续精确结果记录在 PR。


审查修复验证：`pr422-u4-review-fixes.log` 中修订轮次、投影权限、历史不变和读函数回滚/重放用例 PASS；同一运行的暂缓测试仍使用尚未加入完整确认等待的副本，保留 1 PASS / 1 FAIL。最终 `pr422-u4-deferred-settled.log` 为 **1 PASS / 262 skipped**，含完整确认后明确暂缓、刷新后退出右栏且服务端 deferred 不变。web TypeScript/lint PASS。后续最终候选聚合及 CI 结果记录于 PR，不将不同运行伪称为一次全套执行。


## 2026-09-26 账号已定稿定位返回讨论的定向修复

Owner 新报告优先于 U4 交付；暂停 staging 交付。原 writer、PR #422 和预览数据保留。

- 原按钮复现 `pr422-account-revision-red.log`：1 FAIL /263 skipped。六步不同答案的正式定位经“资料库 → 账号定位详情 → 回到策略讨论”，前五题被降为 provisional，第六题无 profileKey 被漏掉；六步可点击状态仅第一步。独立草稿/Session 身份正确，故不是进入别的账号。
- 0134 复用现有草稿、不可变 artifact_requests、来源证据及正式版本。精确读取正式 round 的方法和答案，给新项目重新通过已有确认校验；不复制外项目 confirmation/evidence ID、不直接置 valid。合法 workflow 的显示顺序不必是依赖顺序，因此按依赖就绪顺序确认。
- 旧草稿在再次显式进入时修复，不批量更新。只恢复初始 legacy seed 后从未改变的字段；曾改后改回仍保留为修改。方法/revision 不同保留原草稿和正式来源并提示。原 immutable 请求、正式版本及账号关联选题不改。
- 来源撤销在 OPC、Runtime scope、证据使用和直接 workbench.read/resolve 重新检查；新增 revision evidence 使用既有限制表。自动保存与正式版本分开标注，历史显示完整问题答案并提供当前修改草稿入口。
- 中途证据保留：green1 1 PASS（仅入口）；green2 2 PASS /3 FAIL；green3 2 PASS /2 FAIL；green4 2 PASS /1 FAIL。失败分别涉及新测试的三阶段确认仅给默认 1 秒、fixture 误把 accepted 回包当证据 ID、旧方法标题断言，以及直接服务拒绝码已映射为 ARTIFACT_DENIED。实际确认等待采用原测试常用的 15 秒，未改总超时或业务容量。最终结果见下方与 PR 精确候选记录；这些中途日志不称全套通过。

兼容与回退：迁移可重复应用，无新表、无批量改写。已创建继承记录后不可直接恢复旧授权函数，否则会丢失来源撤销保护；如需产品回退，可暂停新修订入口，保留本迁移的来源检查及所有原数据。未经授权不执行远端迁移。真实模型理解质量、供应商 usage、远端服务、支付及发布均 NOT_RUN。

已完成验证：`pr422-account-revision-final2.log` **8 PASS /259 skipped**，覆盖实际弹窗返回、六步/无映射字段、修改/刷新/退出返回、自动保存不新增正式版、丢失定稿回包后回读 v2、旧正式内容与选题来源、双账号/双标签冲突、旧草稿保留、不同方法并列提示、逆序依赖与本地/原始来源撤销、新用户六步逐题确认。随后仅修订提示文案，并补同项目旧 revise 入口后重开不形成自继承，`final3.log` **1 PASS /266 skipped**。`final.log` 保留 6 PASS /2 FAIL（两项均为已确认的拒绝错误码映射断言），不能与后续运行合称一次全套通过。最终源码的弹窗来源投影、逆序夹具补测、精确 CI/独立审查及原址预览同步结果记在原 PR 交付评论。lint、web typecheck 已通过。


### 2026-09-26 追加：修改后正式确认禁用的可操作解释

Owner 截图对应原本地草稿只读状态为九个答案 confirmed、六个步骤 valid=false。答案确认与步骤依赖确认不同：上游修改已合法使后续失效，原界面却只显示“已确认”与禁用正式按钮，最后一步确认只得到笼统冲突。此次只改 UI：标识“答案已确认 · 步骤待核对”，给出依赖已满足的下一待核对步骤和直接入口；提前确认下游时，在建立新确认请求前引导到待核对步骤。既有未决确认 envelope 仍按原身份恢复，正式发布仍要求所有必要信息及步骤校验通过。无 SQL/Runtime/Session 变化，不替 Owner 自动核对或发布。

新增实际弹窗浏览器场景：改第 0、3 步后跳第 5 步，原输入保留；提前确认不写服务端；按依赖核对已有答案，无需重填；最后正式 v2 包含两处修改且 v1 不变。同时回归完整继承与新用户六步。红测、聚合结果、精确候选检查/独立结论和原址预览同步记录于原 PR，未运行项不计 PASS。


### 2026-09-26 Owner 替代规则：仅确认实际改动的信息

上一段“逐步核对受影响步骤”的交互已由 Owner 明确否决。账号正式定位修订仅需确认修改字段，未改字段沿用原确认；新定位逐题规则保留。自动保存仍是草稿，明确“确认正式定位”才创建下一正式版本。

0135 不新增存储。仅在尚未发送的新确认或明确定稿时，通过既有确认函数重建失效校验快照；资格来自当前准确 confirmation、未被后续写入改变的精确正式来源继承，或不可变的显式 information + canonical save 版本链。已改后改回不能伪装未改，未确认修改、正文单独改写、旧版本请求、撤销来源仍拒绝。旧请求回执优先按原身份重放，不重写历史；锁顺序统一为账号后项目。同一字段的未决确认 envelope 继续恢复原请求；未发送的下游步骤确认允许先保存已明确接受的信息，稍后由服务端完整校验。

只保留未改文本的既有人工接受，不声称自动验证修改后所有业务内容的语义一致性，也没有增加模型调用。测试使用真实本地数据库、服务及浏览器和模拟传输。原始失败保留：edit-only-red 是旧交互阻止先确认后面修改的复现；edit-only-final 是新增 SQL 别名与局部记录变量冲突导致的 fixture 失败，未改断言或预算。修正后结果与最终精确候选 CI/独立审查见原 PR。Owner 预览保留原数据，不代替 Owner 确认或定稿。

定向证据：`pr422-edit-only-fixed.log` 7 PASS /1 FAIL（账号路径均通过；新用户用例单独运行缺少先前测试留下的模拟 organizer 配置）。`proof.log` 2 PASS /1 FAIL，新增 required-deferred 入口、原确认回包恢复、旧草稿改回负例通过；`review.log` 2 PASS /2 FAIL，单次 target 确认数=1 通过，新增来源漂移测试的 SQL bigint 字符串被接口类型拒绝。补齐测试自身 fixture 配置、按接口类型转换 revision 后，`ready.log` **2 PASS /266 skipped**，新用户逐题/回包恢复与账号仅确认改动/正式 v2 均通过，已查看定稿按钮可用的实际渲染截图。其余补测与精确候选结果以 PR 交付记录为准，不将多次执行合称一次全套绿。

兼容/回退：0135 可重复应用；不更新任何原始表行，运行时只追加原机制所需确认与显式发布记录。必要时可恢复 0125 的 account wrapper 与 0067 的 publish-current 函数并保留 0134 来源授权及全部数据（交互会回到逐步复核）；不自动执行回退或远端迁移。
