---
description: 新功能完整开发流程 (计划→实现→测试)
---

# ✨ 开发新功能范式 (Feature Development)

该工作流用于在 GraylumAI 中端到端地开发新功能，包含需求对齐、`task.json` 建模、代码实现到最后验证。

## 第一阶段: 任务建模
1. **读取三文件**: 先读取 `task.json`、`progress.md`、`findings.md` 获取当前状态。
2. **检查是否已有对应任务**: 如果用户的新需求还未进入 `task.json`，默认自动拆成 1-5 个可执行任务。
3. **任务拆解要求**:
   - 使用 `verify / audit / fix / optimize` 之一作为 `type`
   - 明确 `files`、`priority`、`passes`、`blocked`
   - 复杂需求先拆验证/审计，再拆实现
4. **同步记录**:
   - 在 `progress.md` 写需求启动记录
   - 在 `findings.md` 写需求理解、关键假设、待确认风险

## 第二阶段: 数据库与后端
1. **修改 Schema**: 如果涉及数据库变动，先在 `packages/db/schema.ts` 增加对应表的字段。
2. **迁移文件 (可选)**: 使用 Drizzle Kit 生成迁移并在本地 push。
3. **编写 Router**: 在 `packages/api/src/routers/` 编写 tRPC 接口并在 `root.ts` 暴露。
4. **服务逻辑**: 对于复杂业务，代码放在 `packages/api/src/services/` 中。
5. **发现同步**: 每 2 次研究或审计动作后，把新结论写入 `findings.md`。

## 第三阶段: 前端界面
1. **新增组件**: 在 `apps/web/src/components/` 对应的业务领域里增加组件。
2. **路由页面**: 更新 `apps/web/src/app/` 下的页面，通过 tRPC Client `trpc.useQuery` 或是 `trpc.useMutation` 和后端通信。
3. **样式调整**: 遵循 Tailwind v4 规范，使用 `var(--xxx)` 主题变量。

## 第四阶段: 验证
1. 运行 `pnpm lint` 检查基础错误。
2. 确保没有类型报错 (TS Errors)。
3. 请用户在浏览器中测试，确认功能正常。
4. 将验证方式和结果写入 `progress.md`。
5. 任务完成时同步更新：
   - `task.json`：标记 `passes=true` 或写入阻塞状态
   - `progress.md`：记录实现、验证、影响文件
   - `findings.md`：记录关键设计决策、证据或风险

## 阻塞处理
- 如果功能缺少账号、密钥、外部服务或人工确认，保持 `passes=false`。
- 在 `task.json` 写 `blocked=true` 和 `block_reason`。
- 在 `progress.md` 写已完成部分和缺失条件。
- 在 `findings.md` 写技术原因和建议的下一步。
