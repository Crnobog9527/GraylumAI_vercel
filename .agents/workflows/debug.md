---
description: 排查和修复 Bug 的标准流程
---

# 🐛 调试和修复 Bug 工作流 (Debug & Fix)

当你需要协助排查 GraylumAI 项目的 Bug 时，请严格遵守以下步骤：

## 1. 建立任务上下文
- 先读取 `task.json`、`progress.md`、`findings.md`。
- 如果该 Bug 不在 `task.json` 中，默认新增 1-3 个任务：复现/审计、修复、验证。
- 在 `progress.md` 记录当前 Bug 的启动时间、现象和影响范围。
- 在 `findings.md` 记录初始线索、假设和需要验证的点。

## 2. 问题定位 (Root Cause Analysis)
- 通过 `grep_search` 或文件搜索，定位错误栈（Error Stack）上的代码位置。
- 分析可能的原因（如：变量 null 引用、Drizzle SQL 异常、Supabase Auth 过期、tRPC payload 不匹配）。
- 每 2 次研究、搜索、审计动作后，把新增发现写入 `findings.md`。
- 向用户解释你发现的原因。

## 3. 提出修复方案
- 给出具体的代码修改建议，并在当前任务内直接实施修复。
- 如果是不确定的逻辑，添加 console.log 或者 Sentry debug 信息以辅助测试。

## 4. 实施修复与验证
- 在 `packages/api` 修改业务逻辑或 `apps/web` 修改交互问题。
- 运行可行的本地验证，再让用户重试触发错误的操作，验证问题是否解决。
- 将修复动作和验证结果写入 `progress.md`。
- 更新 `task.json` 中对应任务的 `passes` / `blocked` 状态。
- 在 `findings.md` 记录根因、修复方式、残余风险。

## 5. 阻塞原则
- 无法稳定复现、缺少环境、缺少第三方权限时，禁止标记完成。
- 在 `task.json` 写明 `blocked` 和 `block_reason`。
- 在 `progress.md` 留下已验证范围。
- 在 `findings.md` 留下证据和下一步建议。
