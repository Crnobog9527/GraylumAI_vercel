# FUSION-REVIEW：Gemini 4 Argon 接入与配置交接

## 目标

执行约束席改用 `google/gemini-4-argon` / `google-ai-studio`。
代码补齐真实准入、回归测试；沿用 FUSION-PROFILE 方案 B，抽样总费用不超过 3 美元。
配置由总控审计执行，配置就绪后 founder 只做一次真实评审（另限 1 美元）。

## 当前阻塞

后台候选来自测试窗口报价，再逐个调用 `admitFusionModel`，不是静态模型名列表。
Argon 缺少窗口报价、计费档案和 `paygHostPolicy.ts` 路线条目，故不会被列出。
模型行 `7169edbf-aaa2-414e-ad6d-f79d0751dc16` 已经由后台创建，评审用途 low。

## 总控配置交接（待抽样完成后补齐）

1. `runtime_payg_staging` 新增本轮有证据的 Argon 档案。
2. 测试窗口 `897525f9-66f1-4504-8d91-a52d2c0f0e60` 的 `call_policies` 新增 Argon 报价。
3. `fusion_settings.review` 把 Flash 席替换为 Argon，角色 execution，保留 GPT finance、Sonnet evidence。

本 PR 不执行配置变更，交接使用文字和 JSON，不提供 SQL。

## 验证与交接

抽样、代码验证和机器人审查待完成；founder 真实评审须等总控配置就绪。
