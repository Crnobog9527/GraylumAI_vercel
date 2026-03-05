---
description: 排查和修复 Bug 的标准流程
---

# 🐛 调试和修复 Bug 工作流 (Debug & Fix)

当你需要协助排查 GraylumAI 项目的 Bug 时，请严格遵守以下步骤：

## 1. 现场保护与了解
- 请用户提供报错截图或完整的错误日志。
- 定位出现问题的功能模块（例如：是登录页报错？还是 AI 回复报错？）。

## 2. 问题定位 (Root Cause Analysis)
- 通过 `grep_search` 或文件搜索，定位错误栈（Error Stack）上的代码位置。
- 分析可能的原因（如：变量 null 引用、Drizzle SQL 异常、Supabase Auth 过期、tRPC payload 不匹配）。
- 向用户解释你发现的原因。

## 3. 提出修复方案
- 告诉用户具体的代码修改建议，并在得到允许后进行修改。
- 如果是不确定的逻辑，添加 console.log 或者 Sentry debug 信息以辅助测试。

## 4. 实施修复与验证
- 在 `packages/api` 修改业务逻辑或 `apps/web` 修改交互问题。
- 让用户重试触发错误的操作，验证问题是否解决。
