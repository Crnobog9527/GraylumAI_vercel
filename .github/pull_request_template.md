# Pull Request

<!-- 规则见 AGENTS.md。staging 合并由 AI 在 CI、独立审查和实际验证都通过后自己执行；
     只有 AGENTS.md 第 1 节列出的事项需要 Owner 在对话里明确同意。 -->

## 目标

- 这次要做到什么：
- 怎样算做完：
- 不做什么：

## 改动

- 改了哪些地方：
- 是否涉及 AGENTS.md 第 1 节事项（正式环境、密钥、真钱、平台设置或 staging 绑定、规则变更、产品决定）：`否` / 说明并附 Owner 同意记录
- 是否新增第三方脚本或像素：`否` / `是`，统计和广告类只在 Termly 判定同意后加载，并在 Termly 后台登记分类（[ANALYTICS 方案](https://github.com/Crnobog9527/GraylumAI_vercel/blob/staging/docs/launch/tasks/ANALYTICS.md) 第 3.4 节）
- 是否新增或修改公开页面（不登录可见、对搜索引擎开放）：`否` / `是`，并逐项勾选下面的 [SEO/GEO 规范](https://github.com/Crnobog9527/GraylumAI_vercel/blob/staging/docs/launch/SEO_GEO_SPEC.md) 第 13 节检查单：
  - [ ] title / description / canonical / hreflang / OG 图齐全；`keywords` 已删
  - [ ] 只有一个 H1；H2 覆盖真实疑问
  - [ ] 首屏给结论；有产品入口
  - [ ] JSON-LD 通过 Google 富媒体测试
  - [ ] 不是 `force-dynamic`；Lighthouse 移动端性能 ≥ 90
  - [ ] 内链 ≥ 3 条，无死链
  - [ ] 进入 sitemap；robots 允许；`/app`、`/admin`、`/auth`、登录入口页仍返回 `noindex`
  - [ ] 真实浏览器按 AGENTS.md 第 4 节验证过

## 验证

- 做了哪些操作、实际结果：
- 没跑或没验证的：

## 审查

- 独立审查结果：
- 修改后的复核：

## 发现的问题

-

## 上线后再看

-

## 交接

- 做完了什么：
- 下一步：
- 卡在哪里：
