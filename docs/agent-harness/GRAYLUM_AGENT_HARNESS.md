# Graylum Agent Harness

Graylum Agent Harness 是一个 GitHub issue 驱动的自动开发闭环，目标是把 owner 从代码审查责任中解放出来，让机器 gate 承担计划、实现、验证和 staging merge 前审计。

Phase 0 只建立自动化地基：规则、prompts、schema、PR 模板和 workflow trigger。它不会新增自动 merge workflow，也不会执行外部 staging 或 production 服务写操作。

## 闭环角色

1. Planner 只读 issue、仓库和文档，输出 sprint contract。
2. Generator 按 contract 开发，补测试，并只修复 Evaluator 指出的 contract fail。
3. Evaluator 不改代码，用 CI、Playwright、API、DB、Stripe test evidence 验证 contract。
4. Release Auditor 不改代码，检查 exact head SHA、base、changed files、CI/Security、forbidden actions，并判断是否允许进入 staging merge gate。

## 状态机 Labels

建议使用以下 GitHub labels 表示状态：

- `agent:needs-planning`
- `agent:contract-ready`
- `agent:ready-for-generation`
- `agent:generation-in-progress`
- `agent:needs-evaluation`
- `agent:evaluator-pass`
- `agent:evaluator-fail`
- `agent:ready-for-release-audit`
- `agent:release-auditor-pass`
- `agent:release-auditor-fail`
- `agent:ready-for-staging-merge`
- `agent:blocked`
- `release:production-gate`
- `risk:billing`
- `risk:stripe`
- `risk:supabase`
- `risk:cron`
- `risk:migration`

Labels 是状态信号，不是权限本身。任何高风险动作仍受 AGENTS.md 和 contract 限制。

## Sprint Contract

Sprint contract 是 Planner 的唯一交付物，也是 Generator 和 Evaluator 的共同边界。Contract 必须写清：

- issue
- business goal
- non-goals
- target base branch
- intended PR base
- allowed files or modules
- forbidden actions
- acceptance criteria
- required tests
- evaluator evidence
- rollback plan
- stop conditions

billing、Stripe、Supabase、cron、migration 类任务必须有 contract，并且必须在 Evaluator PASS 后才允许进入 staging merge gate。

## Evaluator Pass / Fail

Evaluator 报告必须以 `PASS`、`FAIL` 或 `BLOCKED` 开头。

PASS 代表：

- 当前 head SHA 已确认。
- base branch 已确认。
- changed files 在 contract 范围内。
- contract 验收标准全部通过。
- CI / Security 或 contract 要求的替代证据已通过。
- forbidden actions 未发生。

FAIL 代表：

- contract 某项验收未通过。
- 测试、CI、Security、Playwright、API 或 staging/test evidence 不满足要求。
- changed files 超出 contract 范围。
- PR 描述或证据缺失。

BLOCKED 代表：

- 需要 owner 决策。
- 需要被禁止的 production / live / settings / DB 写操作。
- 外部服务或权限问题导致无法完成只读验证。
- 当前 evidence 不足以安全判断。

## Staging Auto-Merge 条件

未来允许自动合并到 `staging` 时，必须同时满足：

- PR base 是 `staging`。
- PR head SHA 与 Evaluator 和 Release Auditor 报告一致。
- Sprint contract 存在且路径写入 PR 描述。
- Generator 只修改 contract 允许范围。
- CI / Security 在当前 head 通过。
- Evaluator result 是 PASS。
- Release Auditor result 是 `PASS_TO_STAGING_MERGE_GATE`。
- forbidden actions confirmation 是 PASS。
- 没有 unresolved high-risk blocker。

Phase 0 不新增自动 merge workflow；这些条件只定义未来 gate。

## Owner 角色

owner 负责：

- 定义业务目标。
- 决定优先级。
- 批准 production release。
- 对高风险业务后果做最终决策。

owner 不负责：

- 阅读代码 diff。
- 判断测试覆盖是否足够。
- 手动审查每个实现细节。
- 代替机器 gate 判断 staging PR 是否满足 contract。

## Staging 最大化权限原则

在 contract 和 Evaluator gate 约束下，`staging` 是自动化开发、测试、修复和集成的主要环境。允许尽量把可机器验证的工作前移到 staging，包括：

- 自动创建分支和 PR 到 `staging`。
- 自动运行 lint、typecheck、unit test、integration test。
- 自动运行 local-only 或 staging-only Playwright/API 验证。
- 自动修复 Evaluator fail。
- 在满足 gate 后进入 staging merge gate。

这不代表可以绕过 contract，也不代表可以执行 production 或 live action。

## Production 最小化权限原则

`main` 和 production 只接受单独 release gate。默认永久禁止无人执行：

- production deploy
- production smoke
- Supabase production DB access or write
- Stripe live action
- real checkout / payment / refund / cancel / webhook replay
- Vercel / Supabase / Stripe env or Project Settings changes
- high-risk issue closure

production release 必须由 owner 做业务决策，并用单独 release audit 报告说明 evidence、rollback 和剩余风险。
