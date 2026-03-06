# 稳定化待办（Stabilization Backlog）

## 执行策略
- 总原则：稳定优先。
- 顺序：`P0 -> P1 -> P2`。
- 每项都要有：负责人、验收标准、验证结果、回滚方案。

## P0（必须先做）

### P0-1 密钥安全与轮换
- 目标：处理 `.env.example` 中真实密钥样式值，并完成密钥轮换。
- 状态：
  - 代码仓库：`已完成`（`.env.example` 已替换为安全占位符）。
  - 外部系统轮换：`待执行`（Supabase/Anthropic/Vercel 环境变量）。
- 验收标准：
  - 仓库中不存在真实密钥样式值。
  - 新密钥已在平台生效，旧密钥已失效。
- 验证：
  - 本地扫描：`rg -n "sk-ant-|eyJhbGciOiJIUzI1Ni|sb_publishable_" .`
  - 线上功能：登录和 AI 调用正常。

## P1（高优先，已首批锁定）

### P1-1 修复 admin 用户详情消息统计
- 目标：修复 `admin.getUserDetails` 统计逻辑错误。
- 状态：`已完成`。
- 实施：`packages/api/src/routers/admin.ts` 改为按用户 conversation IDs 统计 messages。
- 验收标准：后台显示消息总数与数据库一致。

### P1-2 明确单一聊天链路，避免误用旧链路
- 目标：只保留流式主链；旧入口不能被误当主链使用。
- 状态：`已完成`。
- 实施：
  - `packages/api/src/routers/chat.ts` 的 `chat.sendMessage` 已下线并返回 deprecated 错误。
  - 旧前端链路文件已加 `@deprecated` 标记。
- 验收标准：新需求不会再接入旧 Echo 路径。

### P1-3 修复 API 单测失败基线
- 目标：`pnpm --filter @repo/api test:run` 从 4 fail -> 0 fail。
- 状态：`已完成`。
- 当前结果：`228/228 passed`。
- 涉及修复：
  - `billing.ts` 对无 RPC client 的兼容回退。
  - `costCalculator.test.ts` 使用当前计费常量，修正过期断言。

### P1-4 聊天主链端到端冒烟
- 目标：验证登录->发消息->流式回复->积分变化->会话落库。
- 状态：`待执行`（依赖真实环境账号与密钥）。
- 验收标准：5 步全部通过并有截图/日志证据。

## P2（可排期）

### P2-1 旧链路清理计划
- 目标：彻底移除未使用旧组件/Hook，减少维护噪音。
- 候选：
  - `apps/web/src/hooks/useAIChat.ts`
  - `apps/web/src/components/ai/ChatInterface.tsx`
  - `apps/web/src/components/chat/ChatInterface.tsx`
- 风险：可能有隐藏引用，需要先全仓搜索和灰度验证。

### P2-2 CI 严格化
- 目标：去掉 CI 中 `|| true`，让失败真正阻断。
- 风险：短期可能增加失败率，需要先确保基线稳定。

### P2-3 负责人可视化周报
- 目标：每周输出稳定性报告（测试通过率、错误率、成本趋势、未闭环风险）。

## 本周建议执行清单（按顺序）
1. 完成 P0-1 外部密钥轮换并验证。
2. 执行 P1-4 聊天主链冒烟并留证据。
3. 再推进 P2-1 旧链路删除（若无引用）。
4. 评估 P2-2 CI 严格化窗口。
