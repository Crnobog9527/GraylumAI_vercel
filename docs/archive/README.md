# 历史归档

这里存放已经不再作为当前依据的旧计划、旧设计和旧开发规范，只作为历史线索保留。

- 当前产品规划和施工顺序：[docs/launch/MASTER_PLAN.md](../launch/MASTER_PLAN.md)
- 当前仓库规则：[AGENTS.md](../../AGENTS.md)
- 当前工程规范：[docs/ENGINEERING.md](../ENGINEERING.md)

| 目录 | 内容 | 归档原因 |
| --- | --- | --- |
| `2026-01/` | 2026 年 1 月的 AI 对话重构简报与诊断报告、`movetonew/` 下的旧重构计划、UI 复刻指令、旧设计系统和旧开发规范清单 | 描述的是旧 Base44 迁移期和旧对话链路，与当前统一 Runtime、[DESIGN.md](../../DESIGN.md) 和 [工程规范](../ENGINEERING.md) 冲突，继续放在仓库根目录会误导开发 |

2026-09 C2 归档保留历史叙述，仅修正移动后的引用并脱敏本机路径、个人部署域名和环境标识。历史提交中的原值仍存在，本任务不改写历史；需要追溯时按原文件名查找。

## 2026-09 C2 文档清理

[2026-09-c2/](2026-09-c2/) 收录一次性审计、旧签核状态、旧本地审计流程与诊断记录，
不是当前验收或操作授权。

- [ADMIN_TECH_DEBT_AUDIT.md](2026-09-c2/ADMIN_TECH_DEBT_AUDIT.md)
- [CHAT_RUNTIME_AUDIT.md](2026-09-c2/CHAT_RUNTIME_AUDIT.md)
- [DB_INDEX_REVIEW.md](2026-09-c2/DB_INDEX_REVIEW.md)
- [LOGGING_EXCEPTION_REVIEW.md](2026-09-c2/LOGGING_EXCEPTION_REVIEW.md)
- [PHASE4_LOCAL_PERFORMANCE_BASELINE.md](2026-09-c2/PHASE4_LOCAL_PERFORMANCE_BASELINE.md)
- [PHASE4_SECURITY_RLS_AUDIT.md](2026-09-c2/PHASE4_SECURITY_RLS_AUDIT.md)
- [RLS_AUDIT_REPORT.md](2026-09-c2/RLS_AUDIT_REPORT.md)
- [SECURITY_AUDIT_PHASE9.md](2026-09-c2/SECURITY_AUDIT_PHASE9.md)
- [SECURITY_AUDIT_REPORT.md](2026-09-c2/SECURITY_AUDIT_REPORT.md)
- [STABILIZATION_BACKLOG.md](2026-09-c2/STABILIZATION_BACKLOG.md)
- [STRICT_SIGNOFF_STATUS.md](2026-09-c2/STRICT_SIGNOFF_STATUS.md)
- [LOCAL_E2E_AUDIT_WORKFLOW.md](2026-09-c2/LOCAL_E2E_AUDIT_WORKFLOW.md)
- [REFACTOR_PARITY_AUDIT_WORKFLOW.md](2026-09-c2/REFACTOR_PARITY_AUDIT_WORKFLOW.md)
- [API_DEVELOPMENT.md](2026-09-c2/runbooks/API_DEVELOPMENT.md)
- [evaluation-report.md](2026-09-c2/diagnostics/context-limits-removal/evaluation-report.md)
- [function-comparison-matrix.draft.md](2026-09-c2/refactor-parity/current-audit/function-comparison-matrix.draft.md)
- [issue-list.draft.md](2026-09-c2/refactor-parity/current-audit/issue-list.draft.md)
- [legacy-repo-baseline.draft.md](2026-09-c2/refactor-parity/current-audit/legacy-repo-baseline.draft.md)

保留原位的依赖文件：`docs/refactor-parity/templates/` 下的 3 个模板仍被
`scripts/run-refactor-parity-audit.sh:223`、`:225`、`:227` 读取，故不移动。
