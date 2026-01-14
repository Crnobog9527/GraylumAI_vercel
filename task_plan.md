# Task Plan: GraylumAI Phase 3 迁移

## Goal
完成 GraylumAI 项目从阶段九到阶段十一的所有迁移工作，包括工单系统、系统设置、邀请推广、AI模型管理和管理后台。

## Current Phase
阶段九 - 工单与系统设置迁移

## Phases

### 阶段九：工单与系统设置迁移
- [ ] 任务 9.1：迁移工单系统 API (创建 ticketRouter)
- [ ] 任务 9.2：迁移系统设置 API (创建 settingsRouter)
- [ ] 任务 9.3：创建工单页面 (tickets/page.tsx)
- [ ] 任务 9.4：提交第九阶段成果 → 等待 Vercel 验证
- **Status:** pending

### 阶段十：邀请推广与模型管理迁移
- [ ] 任务 10.1：迁移 AI 模型管理 API (创建 modelRouter)
- [ ] 任务 10.2：迁移邀请推广 API (创建 invitationRouter)
- [ ] 任务 10.3：创建 AI 模型管理页面 (models/page.tsx)
- [ ] 任务 10.4：创建邀请码管理页面 (invitations/page.tsx)
- [ ] 任务 10.5：提交第十阶段成果 → 等待 Vercel 验证
- **Status:** pending

### 阶段十一：管理后台与最终优化
- [ ] 任务 11.1：实现管理员角色权限控制 (adminProcedure)
- [ ] 任务 11.2：应用管理员权限到相关 API
- [ ] 任务 11.3：创建管理后台仪表盘 (admin/page.tsx)
- [ ] 任务 11.4：创建获取统计数据的 API (getStatistics)
- [ ] 任务 11.5：最终代码提交与部署准备 → 等待 Vercel 验证
- **Status:** pending

## 执行流程

每个阶段完成后：
1. 提交代码并推送到 `claude/install-plugin-wACm3` 分支
2. 等待用户确认 Vercel 部署是否有报错
3. 如有报错，优先解决报错
4. 用户确认无误后，继续下一阶段

## Decisions Made
| Decision | Rationale |
|----------|-----------|
| 按阶段分步执行 | 便于 Vercel 验证每步的正确性 |
| 每次推送后等待确认 | 确保部署无误再继续 |

## Errors Encountered
| Error | Resolution |
|-------|------------|
