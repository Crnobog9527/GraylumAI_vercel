---
description: 新功能完整开发流程 (计划→实现→测试)
---

# ✨ 开发新功能范式 (Feature Development)

该工作流用于在 GraylumAI 中端到端地开发新功能，包含需求对齐、代码实现到最后验证。

## 第一阶段: 理解与规划
1. **澄清需求**: 跟用户对齐，了解需要添加的新功能的业务逻辑、涉及的数据表和前端页面。
2. **分析影响**: 分析这次改动是否需要修改 `packages/db`（数据库 schema），需要修改哪些 `packages/api` 的 tRPC router，以及前端页面 `apps/web/src` 需要新增或修改的内容。
3. **输出方案**: 开始写代码之前，先通过 artifacts 给出详细的实现方案 (Implementation Plan)。

## 第二阶段: 数据库与后端
1. **修改 Schema**: 如果涉及数据库变动，先在 `packages/db/schema.ts` 增加对应表的字段。
2. **迁移文件 (可选)**: 使用 Drizzle Kit 生成迁移并在本地 push。
3. **编写 Router**: 在 `packages/api/src/routers/` 编写 tRPC 接口并在 `root.ts` 暴露。
4. **服务逻辑**: 对于复杂业务，代码放在 `packages/api/src/services/` 中。

## 第三阶段: 前端界面
1. **新增组件**: 在 `apps/web/src/components/` 对应的业务领域里增加组件。
2. **路由页面**: 更新 `apps/web/src/app/` 下的页面，通过 tRPC Client `trpc.useQuery` 或是 `trpc.useMutation` 和后端通信。
3. **样式调整**: 遵循 Tailwind v4 规范，使用 `var(--xxx)` 主题变量。

## 第四阶段: 验证
1. 运行 `pnpm lint` 检查基础错误。
2. 确保没有类型报错 (TS Errors)。
3. 请用户在浏览器中测试，确认功能正常。
