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
