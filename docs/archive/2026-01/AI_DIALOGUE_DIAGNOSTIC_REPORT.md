# AI 对话功能诊断报告

**诊断日期**: 2026-01-24
**诊断版本**: v1.0
**诊断范围**: GraylumAI 平台 AI 对话功能完整链路

---

## 执行摘要

经过对 AI 对话功能的全面诊断，发现 **AI 对话功能完全无法工作** 的根本原因是：

> **前端调用了占位符 API（chat.sendMessage），而完整的 AI 实现（ai.sendMessage、流式处理）从未被集成。**

这是一个架构断层问题，存在三套独立的实现但未正确连接：
1. `chat.sendMessage` - 占位符（当前被调用）
2. `ai.sendMessage` - 完整实现（未被调用）
3. `useStreamingChat` + `/api/ai/stream` - 流式实现（未被调用）

---

## 问题汇总

| 优先级 | 问题数量 | 影响范围 |
|--------|----------|----------|
| P0 (致命) | 4 | 功能完全不可用 |
| P1 (严重) | 3 | 功能缺陷或安全风险 |
| P2 (中等) | 3 | 功能不完整 |
| P3 (轻微) | 2 | 代码质量问题 |

---

## P0 - 致命问题（功能完全不可用）

### P0-1: chat.sendMessage 是占位符，只回显用户输入

**位置**: `packages/api/src/routers/chat.ts:82-145`

**问题描述**:
前端当前调用的 `chat.sendMessage` mutation 是一个 **占位符实现**，它只是简单地回显用户输入，并没有调用任何 AI 模型。

**问题代码**:
```typescript
// packages/api/src/routers/chat.ts:121
// TODO: Add logic to call AI model and stream response
// For now, just echo the message back

// Line 127-133: 返回模拟的 AI 回复
const aiMessage = await tx.insert(messages).values({
  conversationId: input.conversationId,
  role: 'assistant',
  content: `Echo: ${input.message}`,  // ← 只是回显！
  // ...
}).returning();
```

**根本原因**: 开发过程中创建的占位符从未被替换为实际实现。

**影响**: 用户发送任何消息只会收到 "Echo: [原消息]" 的回复，AI 功能完全不可用。

---

### P0-2: 前端调用了错误的 API

**位置**: `apps/web/src/app/chat/page.tsx`

**问题描述**:
前端聊天页面调用了占位符 API `trpc.chat.sendMessage`，而不是功能完整的 `trpc.ai.sendMessage`。

**问题代码**:
```typescript
// apps/web/src/app/chat/page.tsx
const sendMessage = trpc.chat.sendMessage.useMutation({
  onSuccess: (data) => {
    // ...
  },
  // 缺少 onError 处理
});
```

**根本原因**: 前端开发时使用了占位符 API，后续完整实现后未更新调用。

**影响**: 即使后端有完整的 AI 实现，前端也不会调用它。

---

### P0-3: 流式处理未集成

**位置**:
- `packages/api/src/services/streamHandler.ts` (402 行完整实现)
- `apps/web/src/hooks/useStreamingChat.ts` (423 行完整实现)
- `apps/web/src/app/api/ai/stream/route.ts` (完整的 SSE 端点)

**问题描述**:
存在完整的流式处理实现：
1. `StreamHandler` 服务类 - 已导出但从未被调用
2. `useStreamingChat` Hook - 完整实现但从未被使用
3. `/api/ai/stream` API 路由 - 完整实现但前端从未调用

**问题代码**:
```typescript
// packages/api/src/services/streamHandler.ts 被导出
export class StreamHandler { ... }  // 402 行完整实现

// 但没有任何路由调用它
// ai.ts 中的 sendMessage 使用的是非流式 callClaudeAPI
```

**根本原因**: 流式功能作为独立模块开发，但从未被整合到主流程中。

**影响**:
- 用户无法获得实时流式响应
- AI 回复需要等待完整生成才能显示
- 用户体验差

---

### P0-4: ai.sendMessage 使用非流式 API 但前端未调用

**位置**: `packages/api/src/routers/ai.ts:251-479`

**问题描述**:
`ai.sendMessage` 是功能完整的实现，包含：
- 幂等性检查
- 安全过滤
- 智能路由
- 计费集成
- Claude API 调用

但它使用的是 **非流式** `callClaudeAPI`，且前端 **从未调用** 这个 mutation。

**问题代码**:
```typescript
// packages/api/src/routers/ai.ts:164-241
async function callClaudeAPI(params: ClaudeAPIParams) {
  // 非流式调用，一次性返回完整响应
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    // ...
    body: JSON.stringify({
      model: params.model,
      messages: params.messages,
      max_tokens: params.maxTokens,
      // 没有 stream: true
    }),
  });
}
```

**根本原因**:
1. 非流式实现完成后，流式版本作为单独模块开发
2. 前端始终调用 chat.sendMessage 占位符

**影响**: 完整的 AI 功能存在但无法被用户使用。

---

## P1 - 严重问题（功能缺陷或安全风险）

### P1-1: 输出安全过滤未应用

**位置**:
- `packages/api/src/services/security.ts` (完整的 SecurityService)
- `packages/api/src/routers/ai.ts:383-397`

**问题描述**:
`ai.ts` 中获取了 AI 响应后，输出安全过滤代码被标记为 TODO：

```typescript
// packages/api/src/routers/ai.ts:383-397
const aiResponse = await callClaudeAPI({...});

// TODO: Apply output security filtering
// const securityService = new SecurityService();
// const filteredResponse = await securityService.sanitizeOutput(aiResponse.content);
```

**根本原因**: 安全过滤服务已开发完成，但集成工作未完成。

**影响**: AI 可能返回敏感或不当内容，存在安全风险。

---

### P1-2: 签名验证未使用

**位置**:
- `packages/api/src/services/requestSigner.ts`
- `apps/web/src/app/api/ai/stream/route.ts`

**问题描述**:
`RequestSigner` 服务已实现请求签名功能，但：
1. 前端从未使用它签名请求
2. 后端没有强制验证签名

```typescript
// packages/api/src/services/requestSigner.ts
export class RequestSigner {
  sign(payload: any): string { ... }
  verify(payload: any, signature: string): boolean { ... }
}

// 但 stream/route.ts 中签名验证是可选的
// if (signature && !requestSigner.verify(body, signature)) { ... }
```

**根本原因**: 签名验证被设计为可选功能，但从未被启用。

**影响**: API 请求可能被伪造或篡改。

---

### P1-3: 计费服务使用的价格来源与 UI 配置不一致

**位置**:
- `packages/api/src/services/billing.ts:89-127`
- `apps/admin/src/app/settings/page.tsx` (系统设置页面)

**问题描述**:
管理后台的系统设置页面允许配置 `input_credits_per_1k` 和 `output_credits_per_1k`，但实际计费服务 **从 `ai_models` 表读取价格**，而不是 `system_settings` 表。

```typescript
// packages/api/src/services/billing.ts:89-127
async getModelPricing(modelId: string) {
  const model = await this.db.query.aiModels.findFirst({
    where: eq(aiModels.id, modelId),
  });
  return {
    inputCost: model?.inputTokenCost ?? 0.003,
    outputCost: model?.outputTokenCost ?? 0.015,
  };
  // ↑ 从 ai_models 表读取，不是 system_settings！
}
```

**根本原因**: 计费服务和管理后台设计脱节，两者使用不同的数据源。

**影响**:
- 管理员在 UI 上修改的价格设置不会生效
- 实际计费与 UI 显示不一致
- 可能导致财务损失或用户投诉

---

## P2 - 中等问题（功能不完整）

### P2-1: 前端缺少错误处理

**位置**: `apps/web/src/app/chat/page.tsx`

**问题描述**:
前端 mutation 调用缺少 `onError` 回调：

```typescript
const sendMessage = trpc.chat.sendMessage.useMutation({
  onSuccess: (data) => { ... },
  // ← 缺少 onError 处理
});
```

**影响**: API 错误时用户看不到任何提示，体验差。

---

### P2-2: 使用量统计未连接到实际 API 调用

**位置**: `packages/api/src/routers/ai.ts:420-445`

**问题描述**:
使用量日志记录代码存在，但由于整个 `ai.sendMessage` 从未被调用，日志也不会被记录。

```typescript
// packages/api/src/routers/ai.ts:420-445
await tx.insert(aiUsageLogs).values({
  userId: ctx.user.id,
  modelId: selectedModel.id,
  inputTokens: response.usage.input_tokens,
  outputTokens: response.usage.output_tokens,
  // ...
});
// ↑ 这段代码从未执行
```

**影响**: 管理后台的使用量统计和成本监控无数据。

---

### P2-3: 会话上下文长度限制未实现

**位置**: `packages/api/src/routers/ai.ts:300-320`

**问题描述**:
代码注释表明需要实现上下文窗口管理，但相关逻辑未完成：

```typescript
// TODO: Implement context window management
// - Truncate old messages when context is too long
// - Summarize old context for long conversations
```

**影响**: 长对话可能超过 Claude API 的上下文限制导致失败。

---

## P3 - 轻微问题（代码质量）

### P3-1: 重复的类型定义

**位置**:
- `packages/api/src/types/ai.ts`
- `packages/api/src/routers/ai.ts` (内联类型)

**问题描述**:
AI 相关类型在多处重复定义，不一致。

**影响**: 维护困难，可能导致类型不匹配。

---

### P3-2: 环境变量验证不完整

**位置**: `apps/web/src/app/api/ai/stream/route.ts:15-25`

**问题描述**:
环境变量检查存在但不够严格：

```typescript
const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  // 返回错误，但没有详细日志
}
```

**影响**: 部署时环境变量配置问题难以诊断。

---

## 诊断结论

### 架构问题总结

```
当前状态:
┌─────────────────┐     调用      ┌───────────────────┐
│  Chat Page      │ ────────────→ │ chat.sendMessage  │ (占位符!)
│  (前端)         │               │ 只回显输入        │
└─────────────────┘               └───────────────────┘

                                  ┌───────────────────┐
                     从未被调用 → │ ai.sendMessage    │ (完整实现)
                                  │ 非流式            │
                                  └───────────────────┘

                                  ┌───────────────────┐
                     从未被调用 → │ /api/ai/stream    │ (流式实现)
                                  │ + StreamHandler   │
                                  │ + useStreamingChat│
                                  └───────────────────┘

期望状态:
┌─────────────────┐     调用      ┌───────────────────┐
│  Chat Page      │ ────────────→ │ /api/ai/stream    │
│  (前端)         │  SSE 连接     │ + StreamHandler   │
│  + useStreaming │               │ + 计费集成        │
│    Chat Hook    │               │ + 智能路由        │
└─────────────────┘               └───────────────────┘
```

### 根本原因

1. **开发阶段遗留问题**: chat.sendMessage 作为占位符创建，后续从未更新
2. **模块化开发未整合**: 流式处理、计费、智能路由作为独立模块开发，但未集成到主流程
3. **前后端脱节**: 后端有完整实现，前端未更新调用

---

## 修复方案建议

### 方案 A: 集成流式处理（推荐）

**优先级**: P0
**工作量**: 中等
**风险**: 低

**步骤**:
1. 修改 `apps/web/src/app/chat/page.tsx`:
   - 移除 `trpc.chat.sendMessage` 调用
   - 集成 `useStreamingChat` Hook
   - 添加错误处理和加载状态

2. 验证 `/api/ai/stream` 端点:
   - 确认环境变量配置正确
   - 确认计费服务正常工作
   - 确认智能路由正常工作

3. 测试:
   - 端到端流式对话测试
   - 计费扣费测试
   - 错误处理测试

### 方案 B: 使用非流式 ai.sendMessage

**优先级**: P0（如果方案 A 有阻碍）
**工作量**: 小
**风险**: 中（用户体验较差）

**步骤**:
1. 修改前端调用 `trpc.ai.sendMessage`
2. 添加加载状态显示
3. 后续再迁移到流式

---

## 环境变量检查清单

以下环境变量需要确认配置正确：

| 变量名 | 用途 | 验证状态 |
|--------|------|----------|
| `ANTHROPIC_API_KEY` | Claude API 密钥 | ⚠️ 需验证 |
| `DATABASE_URL` | 数据库连接 | ⚠️ 需验证 |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase URL | ⚠️ 需验证 |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase 匿名密钥 | ⚠️ 需验证 |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase 服务角色密钥 | ⚠️ 需验证 |

---

## 附录: 诊断过的文件列表

### 后端 API 路由
- `packages/api/src/routers/chat.ts` - 占位符实现
- `packages/api/src/routers/ai.ts` - 完整实现（未使用）

### 后端服务
- `packages/api/src/services/streamHandler.ts` - 流式处理（未使用）
- `packages/api/src/services/billing.ts` - 计费服务（完整）
- `packages/api/src/services/modelRouter.ts` - 智能路由（完整）
- `packages/api/src/services/security.ts` - 安全服务（完整但未集成）

### 前端
- `apps/web/src/app/chat/page.tsx` - 聊天页面（调用错误 API）
- `apps/web/src/hooks/useStreamingChat.ts` - 流式 Hook（未使用）
- `apps/web/src/app/api/ai/stream/route.ts` - 流式端点（完整）

### 数据库
- `packages/db/schema.ts` - 完整的表结构定义

---

**诊断完成时间**: 2026-01-24
**诊断人**: Claude AI Assistant
**下一步**: 等待确认后执行修复方案
