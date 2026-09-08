# V3 网页搜索接线验证

当前为同一 V3-WORKBENCH 目标下的独立搜索接线分支，不改聊天 PR #389。风险 high：受控供应商能力与成本边界；当前只新增显式选择的 decoder/capability，不启用环境、凭证、网络执行或用户扣费。

已根据 2026-09-08 Owner 授权的一次 AgentKey `Tavily/post_search` 基础搜索核对 metadata、执行参数和返回形态。只支持 general/basic、最多 3 条、禁止自动参数、生成答案、原文抓取及图片；未知 schema/template、身份不符、重复对象、不安全链接和未审核参数拒绝。参数 schema 为公开接口元数据；测试标题/内容/链接完全虚构，实际搜索内容和私有文件不进入仓库。

供应商响应的 `usage.credits` 是 Tavily 单位，保留为 providerUsage，不能解释为 AgentKey 实际收费。AgentKey 报价仍由既有适配器逐次核对，上限 1.1；actualCredits 保持 null。一个有界搜索页面完成不代表网页资料完整，结果明确标记 ranked-results-not-exhaustive，缺少发布时间不猜测。

本地验证：16 项 contract 单测 PASS；仓库外私有既有返回的离线解码 1 PASS，合计 17 PASS。Web typecheck PASS。离线核验没有新增供应商调用；没有使用或打印凭证。证据日志 `/tmp/graylum-tavily-observed-validation.log` 与 `/tmp/graylum-tavily-typecheck.log` 留在本机。

尚未完成：产品内检索入口、研究权限与成果引用接线、Graylum 取数费用策略、供应商许可/保留条款及完整链路验收；不将 decoder PASS 等同搜索功能交付或实际可上线。后续复用已有受控研究服务、预算和恢复，不自动扩展付费授权。

补充 MCP 协议回归：通过官方 SDK 对本地 JSON/SSE 服务运行已审核 Tavily contract，验证单次执行、同请求恢复不再次执行、不同参数复用身份拒绝、报价上涨在执行前拒绝。与原 AgentKey 测试合计 51 PASS；Web typecheck PASS。该协议测试使用内存预算 store 和合成正文，不替代后续真实 SQL/用户积分事务及产品入口验证。


## Provider policy evidence (read-only, 2026-09-08)

[AgentKey Terms §§5–7](https://agentkey.app/terms.html) require compliance with the originating provider and source rights; routing does not grant a blanket data license. [AgentKey Privacy §§2,5,8](https://agentkey.app/privacy.html) distinguishes relayed query/response bodies from retained usage metadata and independent provider policies.

[Tavily Terms §§3.2–3.5](https://www.tavily.com/terms) expressly address application integration and outside end users; this is not evidence of a blanket ban on product integration. [Tavily Privacy §2.1 and §3](https://www.tavily.com/privacy) permits query processing, possible sharing with search-index providers, and retention for stated purposes; no fixed zero-retention promise was established. Therefore product search should send only its explicit query, not silently append the full conversation, private Skill text or documents. Keep existing source links, unknown publication dates and evidence restriction behavior. Source-specific reuse rights remain unknown; do not label all returned content as freely redistributable.

This read-only review adds no paid request, acceptance of new terms, external configuration, user price, or retention-policy change. Product entry, original user-credit billing integration, and complete product validation remain unfinished.


## Local billing integration in progress

The unactivated search implementation links existing research operations to the canonical pre-deduct/settle/refund RPCs; no new balance or workflow state table is introduced. The local price of 5 credits is synthetic test configuration only, not an approved user price. Missing/zero price denies new paid admission. Provider results persist before user settlement, and the billed store resumes settlement on read rather than fetching again.

`/tmp/graylum-research-billing-validation-2.log`: 3 PASS / 40 SKIP, real disposable SQL and PostgREST, including repeat migration, concurrent reservation/settlement, forced settlement rollback with the result retained, cancellation after store recreation, no automatic refund of dispatched work, and rejection of an unconfigured price. No provider calls occurred.

Still required before enabling or claiming delivery: daily reconciliation must count research settlements independently of model token stats; product admission/entry and result adoption must use the billed store; finish/recovery and full evidence/UI paths need integrated validation and independent review. Current code is work in progress, not merge-ready.

### Settlement reconciliation and reference admission follow-up

Daily reconciliation now adds the service-only research aggregate to canonical settlement totals without inventing model token usage. Migration 0071 must precede deploying this reconciliation code; the deployment must not interpret a missing aggregate RPC as a zero balance. The aggregate validates its date window and is denied to ordinary users.

The existing workbench command admits stored research identity only, resolves the user's project first, and requires billed-store success before adding reference material. Failed settlement leaves no adopted evidence; retry settles once without another provider request. Existing source restrictions and project binding remain authoritative.

Validation: `/tmp/graylum-research-adoption-unit.log` 102 PASS; `/tmp/graylum-research-adoption-validation.log` 4 PASS / 40 SKIP with real disposable Auth/SQL/PostgREST, aggregate window and access checks, settlement failure/recovery, adoption, cross-user denial and restricted-source denial; cleanup/canary PASS. `/tmp/graylum-research-adoption-types.log` web typecheck exit 0. The preceding snapshot also passed 42 workbench tests plus one process-restart restoration test (`/tmp/graylum-research-billing-validation-3.log`); that earlier full run does not cover the later admission change. No external calls or settings changes occurred.

Still outstanding: bounded product search admission/entry and results UI, full browser integration, remote CI and independent review. No search price or external activation has been approved.

### Explicit-query product host (not externally enabled)

The workbench search route now constructs one bounded Tavily basic request from an explicit user query. Server-side admission rechecks the authenticated actor, fixed project/round/step, published Skill package/resources, existing consumption limits and balance. Neither private method content nor conversation text is added to provider parameters. The existing operation identity includes project/round/step scope; replay from another scope is rejected without a new provider connection. An intent row alone does not reserve credits or dispatch a call.

New dispatch requires the server setting `v3_web_search=true`, a positive existing search surcharge, and the server-only `AGENTKEY_API_KEY`. None is seeded or externally configured by this change. Persisted terminal recovery requires no provider connection and still works when new dispatch is disabled. Results returned to the UI omit internal provider price metadata; billing uses the original ledger. Unknown/dispatched results remain conservative unresolved records, not proof of recovered content.

`/tmp/graylum-search-host-validation-2.log`: 5 PASS / 40 SKIP with real disposable Auth/SQL/PostgREST and official MCP loopback transport. Covers disabled admission with zero provider connections, one execution/one canonical charge, terminal replay without reconnecting, exact outgoing parameter assertion, identity/scope mismatch and forbidden extra actor input, plus the prior billing/adoption cases. Cleanup/canary and repeated migration PASS. `/tmp/graylum-search-host-unit.log`: 58 PASS; web typecheck `/tmp/graylum-search-host-types-3.log` exit 0. No external AgentKey request occurred.

Remaining: wire the search control and human-readable results into the chat reference area after its dependency is available, run browser end-to-end cases, obtain remote CI and independent review, and separately obtain any activation/price/provider permissions. This backend progress is not full search feature acceptance.
