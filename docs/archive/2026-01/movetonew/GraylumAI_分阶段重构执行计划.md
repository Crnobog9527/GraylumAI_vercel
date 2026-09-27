# GraylumAI 分阶段重构执行计划

> **版本**: v1.0
> **日期**: 2026-01-21
> **参考文档**: `AI_REFACTOR_DESIGN_BRIEF.md` v1.3
> **状态**: 待执行

---

## 一、项目概览

### 1.1 重构范围总结

本次重构的核心目标是将 GraylumAI 平台的 AI 对话系统从旧架构 (Base44 云函数 + Deno) 迁移到新架构 (Next.js + tRPC + Drizzle ORM + Supabase)，同时实现严格的成本控制和安全规范。

**迁移范围:**

| 模块 | 旧项目文件 | 行数 | 迁移状态 |
|------|-----------|------|---------|
| AI 模型调用 | `callAIModel.ts` | 696 | ❌ 完全缺失 |
| 智能对话 | `smartChatWithSearch.ts` | 775 | ❌ 完全缺失 |
| 任务分类器 | `taskClassifier.ts` | 141 | ❌ 完全缺失 |
| Token 预算 | `tokenBudgetManager.ts` | 150 | ❌ 完全缺失 |
| 对话压缩 | `compressConversation.ts` | 149 | ❌ 完全缺失 |
| **总计** | **5 个核心函数** | **~1911** | **待迁移** |

**新项目已完成部分:**

| 模块 | 文件 | 状态 |
|------|------|------|
| 对话管理 | `chat.ts` | ⚠️ 仅 CRUD，无 AI 调用 |
| 积分系统 | `credits.ts` | ✅ 完整，但未与 AI 集成 |
| 模型管理 | `model.ts` | ✅ 管理后台完整 |
| 管理后台 | `admin.ts` | ✅ 功能齐全 |

### 1.2 核心目标

1. **功能完整性**: 用户可正常进行 AI 对话，体验与旧版一致
2. **成本优化**: Token 计费误差 <2%，Prompt Caching 命中率 >60%，整体成本降低 30%+
3. **安全合规**: RLS 策略 100% 覆盖，内容审查双向检测，防止积分负值
4. **稳定可靠**: 计费事务原子性，请求幂等性，异常熔断机制
5. **可维护性**: 代码结构清晰，类型安全，测试覆盖率 >80%

### 1.3 技术债务清单

| 债务项 | 严重程度 | 描述 | 解决方案 |
|--------|----------|------|----------|
| Token 估算不准确 | 🔴 高 | `chars/4` 粗糙估算 | 使用官方 count_tokens API |
| 重复系统提示词 | 🔴 高 | 每轮对话都发送完整 system_prompt | 实现 Prompt Caching |
| 计费浮点累积 | 🟡 中 | `pending_credits` 浮点累积有精度丢失 | 使用整数计费 (分/厘) |
| 摘要拼接破坏结构 | 🔴 高 | 摘要以文本块形式注入首条消息 | 滑动窗口上下文管理 |
| 多次 RPC 调用 | 🔴 高 | 每条消息调用 taskClassifier | 内联分类器 |
| 缓存断点固定 | 🟡 中 | 倒数第 4 条硬编码 | 动态断点策略 |

### 1.4 风险评估

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| Token 计费与官方差异 | 中 | 高 | 使用官方 count_tokens API + 每日对账 |
| 并发扣费导致负余额 | 低 | 高 | 数据库 CHECK 约束 + 行级锁 + 后端二次校验 |
| 流式传输中断 | 中 | 中 | SSE 重连机制 + 超时处理 |
| Prompt 注入攻击 | 低 | 高 | 输入转义 + 分隔符隔离 |
| 缓存命中率过低 | 中 | 中 | 动态断点 + 1 小时缓存选项 |
| 灰度发布数据不一致 | 低 | 中 | 功能开关 + 版本字段 |

---

## 二、架构决策记录 (ADR)

### ADR-001: 为什么选择 tRPC 而非 REST API？

**决策**: 使用 tRPC 作为前后端通信层

**背景**:
- 项目采用 TypeScript 全栈开发
- 需要端到端类型安全
- AI 对话涉及复杂的请求/响应结构

**理由**:
1. **类型安全**: tRPC 自动推导请求/响应类型，避免运行时类型错误
2. **开发效率**: 无需手写 API 文档，修改接口后 IDE 自动提示
3. **中间件支持**: 内置 `protectedProcedure`、`adminProcedure` 权限控制
4. **与 React Query 集成**: `@trpc/react-query` 提供开箱即用的缓存和状态管理
5. **流式支持**: tRPC 原生支持 Server-Sent Events

**替代方案**:
- REST API: 类型不安全，需要额外的 OpenAPI 生成
- GraphQL: 过于复杂，学习成本高

### ADR-002: 为什么使用 Drizzle ORM 而非 Prisma？

**决策**: 使用 Drizzle ORM 作为数据库访问层

**背景**:
- 项目使用 Supabase (PostgreSQL)
- 需要支持复杂事务和行级锁
- 要求 SQL 原生能力

**理由**:
1. **SQL-like 语法**: Drizzle 的 API 更接近原生 SQL，学习成本低
2. **事务支持**: 完整的事务 API，支持 `FOR UPDATE` 行级锁
3. **类型推导**: 从 schema 自动推导 TypeScript 类型
4. **轻量级**: 无运行时依赖，bundle 更小
5. **迁移管理**: `drizzle-kit` 提供简洁的迁移工具

**替代方案**:
- Prisma: 抽象层过厚，事务控制不够灵活
- Raw SQL: 类型不安全，维护成本高

### ADR-003: AI 智能路由的设计原则

**决策**: 内联任务分类器 + 数据库驱动的模型配置

**背景**:
- 旧项目每条消息调用外部 `taskClassifier` 函数，增加 50-100ms 延迟
- 需要根据任务类型自动选择 Sonnet/Haiku 模型

**设计原则**:

1. **内联分类**: 不调用外部函数，使用规则引擎
   ```typescript
   function inlineTaskClassifier(message: string, turns: number): ModelId {
     if (turns >= 3) return config.sonnet_model_id;  // 多轮对话
     if (message.length < 10 && SIMPLE_WORDS.has(message)) return config.haiku_model_id;
     return config.sonnet_model_id;  // 默认
   }
   ```

2. **配置可控**: 模型选择逻辑读取数据库配置
   - `enable_smart_routing`: 是否启用智能路由
   - `default_model_id`: 默认模型
   - `sonnet_model_id` / `haiku_model_id`: 路由目标

3. **对话绑定**: 支持对话级别锁定模型
   - `conversation.model_id` 优先级最高

### ADR-004: 成本优化的核心策略

**决策**: 多层次成本优化体系

1. **Token 计数优化**
   - 使用官方 `count_tokens` API 精确计费
   - 本地快速估算仅用于 UI 预览

2. **Prompt Caching 策略**
   | 缓存层级 | 优先级 | 说明 |
   |----------|--------|------|
   | Tools | 1 | 工具定义最稳定 |
   | System | 2 | 系统提示词次之 |
   | Messages | 3 | 历史消息动态 |

3. **滑动窗口上下文**
   - 摘要区: 历史 >8 轮时生成摘要
   - 稳定区: 累积 ≥1024 tokens 添加缓存断点
   - 动态区: 最新 2 条消息不缓存

4. **模型路由**
   - 简单任务使用 Haiku (成本 1/3)
   - 复杂任务使用 Sonnet

5. **成本监控**
   - 每日与官方报告对账
   - 差异 >5% 自动告警

---

## 三、分阶段执行计划

### 阶段一：数据库与类型定义 (Schema & Types)

#### 交付物

- [ ] `packages/db/schema/ai-models.ts` - AI 模型配置表 (扩展现有)
- [ ] `packages/db/schema/token-stats.ts` - Token 统计表 (新增)
- [ ] `packages/db/schema/billing-history.ts` - 计费历史表 (新增)
- [ ] `packages/db/schema/usage-logs.ts` - 使用日志表 (新增)
- [ ] `packages/api/src/types/ai.ts` - AI 请求/响应的全栈共享类型
- [ ] `packages/api/src/types/billing.ts` - 计费相关类型定义

#### 技术要求

**数据库表定义:**

```typescript
// packages/db/schema/token-stats.ts
export const tokenStats = pgTable('token_stats', {
  id: uuid('id').primaryKey().defaultRandom(),
  conversationId: uuid('conversation_id').references(() => conversations.id).notNull(),
  userId: uuid('user_id').references(() => profiles.id).notNull(),
  messageId: uuid('message_id'),
  modelUsed: text('model_used').notNull(),
  inputTokens: integer('input_tokens').notNull(),
  outputTokens: integer('output_tokens').notNull(),
  cachedTokens: integer('cached_tokens').default(0),
  cacheCreationTokens: integer('cache_creation_tokens').default(0),
  webSearchCount: integer('web_search_count').default(0),
  totalCostUsd: decimal('total_cost_usd', { precision: 12, scale: 6 }).notNull(),
  totalCredits: integer('total_credits').notNull(),
  createdAt: timestamp('created_at').defaultNow(),
});

// packages/db/schema/billing-history.ts
export const billingHistory = pgTable('billing_history', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => profiles.id).notNull(),
  transactionId: uuid('transaction_id').references(() => creditTransactions.id),
  operationType: text('operation_type').notNull(), // 'pre_deduct' | 'settle' | 'refund'
  amount: integer('amount').notNull(),
  reason: text('reason'),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at').defaultNow(),
});
```

**RLS 策略:**

```sql
-- token_stats: 用户只能查看自己的统计
CREATE POLICY "users_own_token_stats" ON token_stats
  FOR SELECT USING (auth.uid() = user_id);

-- 管理员可查看所有
CREATE POLICY "admin_all_token_stats" ON token_stats
  FOR ALL USING (is_admin());

-- billing_history: 用户只读自己的
CREATE POLICY "users_own_billing_history" ON billing_history
  FOR SELECT USING (auth.uid() = user_id);
```

**类型定义:**

```typescript
// packages/api/src/types/ai.ts
import { z } from 'zod';

export const AIMessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system']),
  content: z.union([
    z.string(),
    z.array(z.object({
      type: z.enum(['text', 'image', 'document']),
      // ... content block details
    })),
  ]),
});

export const AIRequestSchema = z.object({
  conversationId: z.string().uuid().optional(),
  message: z.string().min(1).max(10000),
  modelId: z.string().uuid().optional(),
  enableWebSearch: z.boolean().optional(),
  attachments: z.array(z.object({
    type: z.enum(['image', 'pdf']),
    base64Data: z.string(),
    mediaType: z.string(),
    filename: z.string().optional(),
  })).optional(),
});

export const AIResponseSchema = z.object({
  messageId: z.string().uuid(),
  content: z.string(),
  usage: z.object({
    inputTokens: z.number(),
    outputTokens: z.number(),
    cacheReadTokens: z.number().optional(),
    cacheCreationTokens: z.number().optional(),
  }),
  cost: z.object({
    creditsDeducted: z.number(),
    costBreakdown: z.object({
      input: z.number(),
      output: z.number(),
      cacheWrite: z.number(),
      cacheRead: z.number(),
      search: z.number(),
      total: z.number(),
    }),
  }),
});

export type AIMessage = z.infer<typeof AIMessageSchema>;
export type AIRequest = z.infer<typeof AIRequestSchema>;
export type AIResponse = z.infer<typeof AIResponseSchema>;
```

#### 验证标准

- [ ] 数据库迁移可以无错误执行 (`pnpm db:push`)
- [ ] 所有表的 RLS 策略通过测试
  - [ ] 普通用户只能访问自己的数据
  - [ ] 管理员可访问所有数据
  - [ ] 匿名用户无法访问
- [ ] TypeScript 类型无 `any` 警告 (`pnpm tsc --noEmit`)
- [ ] 所有外键关系正确建立
- [ ] 索引查询性能 <100ms (通过 `EXPLAIN ANALYZE` 验证)

#### 手动验证清单

1. [ ] 在 Supabase Dashboard 手动执行迁移 SQL
2. [ ] 使用不同用户身份测试表的 CRUD 权限
3. [ ] 运行 `pnpm tsc --noEmit` 验证类型无错误
4. [ ] 使用 Supabase Studio 查看表关系图
5. [ ] 执行 `EXPLAIN ANALYZE` 验证索引生效

---

### 阶段二：后端核心逻辑 (tRPC Procedures)

#### 交付物

- [ ] `packages/api/src/middleware/securityChecks.ts` - 安全检查中间件
- [ ] `packages/api/src/routers/ai.ts` - AI 对话核心路由
- [ ] `packages/api/src/services/billing.ts` - 原子化计费服务
- [ ] `packages/api/src/services/modelRouter.ts` - AI 智能路由逻辑
- [ ] `packages/api/src/services/tokenCounter.ts` - Token 计数服务

#### 技术要求

**安全检查中间件:**

```typescript
// packages/api/src/middleware/securityChecks.ts

/**
 * AI 调用前安全检查
 * 1. 速率限制检查
 * 2. 消费熔断检查
 * 3. 余额预检
 */
export async function preAICallSecurityChecks(
  userId: string,
  estimatedCost: number
): Promise<void> {
  // 1. 速率限制
  await checkRateLimit(userId, 'ai');

  // 2. 消费熔断
  const circuitBreaker = await checkConsumptionCircuitBreaker(userId);
  if (!circuitBreaker.allowed) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: circuitBreaker.reason,
    });
  }

  // 3. 余额预检
  const balance = await getUserBalance(userId);
  if (balance < estimatedCost) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: `积分不足，需要约 ${estimatedCost}，当前 ${balance}`,
    });
  }
}
```

**原子化计费服务:**

```typescript
// packages/api/src/services/billing.ts

/**
 * 三段式计费: 预扣 → 结算 → 退费
 */
export class BillingService {
  /**
   * 预扣积分 (请求开始前)
   */
  async preDeduct(userId: string, estimatedCredits: number): Promise<string> {
    return await db.transaction(async (tx) => {
      // 行级锁 + 余额校验
      const [user] = await tx
        .select({ credits: profiles.credits })
        .from(profiles)
        .where(eq(profiles.id, userId))
        .for('update');

      if (!user || user.credits < estimatedCredits) {
        throw new Error('积分不足');
      }

      // 预扣
      await tx
        .update(profiles)
        .set({ credits: sql`${profiles.credits} - ${estimatedCredits}` })
        .where(eq(profiles.id, userId));

      // 记录预扣历史
      const [record] = await tx
        .insert(billingHistory)
        .values({
          userId,
          operationType: 'pre_deduct',
          amount: -estimatedCredits,
          reason: 'AI 对话预扣',
        })
        .returning();

      return record.id;
    });
  }

  /**
   * 结算 (请求完成后)
   */
  async settle(
    preDeductId: string,
    actualCredits: number,
    usage: TokenUsage
  ): Promise<void> {
    await db.transaction(async (tx) => {
      // 获取预扣记录
      const [preDeduct] = await tx
        .select()
        .from(billingHistory)
        .where(eq(billingHistory.id, preDeductId));

      const preDeductedAmount = Math.abs(preDeduct.amount);
      const difference = preDeductedAmount - actualCredits;

      if (difference > 0) {
        // 退还多扣的
        await tx
          .update(profiles)
          .set({ credits: sql`${profiles.credits} + ${difference}` })
          .where(eq(profiles.id, preDeduct.userId));
      } else if (difference < 0) {
        // 补扣不足的 (极少数情况)
        await tx
          .update(profiles)
          .set({ credits: sql`${profiles.credits} - ${Math.abs(difference)}` })
          .where(eq(profiles.id, preDeduct.userId));
      }

      // 记录结算
      await tx.insert(billingHistory).values({
        userId: preDeduct.userId,
        operationType: 'settle',
        amount: -actualCredits,
        reason: 'AI 对话结算',
        metadata: { preDeductId, usage },
      });
    });
  }

  /**
   * 退费 (请求失败时)
   */
  async refund(preDeductId: string, reason: string): Promise<void> {
    await db.transaction(async (tx) => {
      const [preDeduct] = await tx
        .select()
        .from(billingHistory)
        .where(eq(billingHistory.id, preDeductId));

      const refundAmount = Math.abs(preDeduct.amount);

      // 退还全部预扣
      await tx
        .update(profiles)
        .set({ credits: sql`${profiles.credits} + ${refundAmount}` })
        .where(eq(profiles.id, preDeduct.userId));

      // 记录退费
      await tx.insert(billingHistory).values({
        userId: preDeduct.userId,
        operationType: 'refund',
        amount: refundAmount,
        reason,
        metadata: { preDeductId },
      });
    });
  }
}
```

**AI 对话路由:**

```typescript
// packages/api/src/routers/ai.ts

export const aiRouter = createTRPCRouter({
  sendMessage: protectedProcedure
    .input(AIRequestSchema)
    .mutation(async ({ ctx, input }) => {
      const { user, profileId } = ctx;
      const billingService = new BillingService();

      // 1. 安全检查
      const estimatedCost = await estimateRequestCost(input);
      await preAICallSecurityChecks(profileId, estimatedCost);

      // 2. 预扣积分
      const preDeductId = await billingService.preDeduct(profileId, estimatedCost);

      try {
        // 3. 获取/创建对话
        const conversation = await getOrCreateConversation(profileId, input.conversationId);

        // 4. 模型路由
        const modelConfig = await selectModel(conversation, input);

        // 5. 构建消息
        const messages = await buildMessages(conversation, input.message, input.attachments);

        // 6. 调用 AI
        const response = await callClaudeAPI(modelConfig, messages, input.enableWebSearch);

        // 7. 保存消息
        await saveMessages(conversation.id, input.message, response.content);

        // 8. 结算
        await billingService.settle(preDeductId, response.actualCredits, response.usage);

        // 9. 记录统计
        await recordTokenStats(conversation.id, profileId, response);

        return response;
      } catch (error) {
        // 失败退费
        await billingService.refund(preDeductId, error.message);
        throw error;
      }
    }),

  // 流式对话 (SSE)
  streamMessage: protectedProcedure
    .input(AIRequestSchema)
    .subscription(async function* ({ ctx, input }) {
      // ... 流式实现
    }),
});
```

#### 验证标准

- [ ] 未登录用户无法调用 `sendMessage` (返回 401)
- [ ] 积分不足时正确拒绝 (返回 PRECONDITION_FAILED)
- [ ] 计费事务在任何异常情况下都能正确回滚
- [ ] 重复请求不会重复扣费 (幂等性)
- [ ] AI 路由能正确判断模型选择

#### 手动验证清单

1. [ ] 使用 Postman 测试未授权访问（应返回 401）
2. [ ] 模拟数据库连接失败，验证事务回滚
3. [ ] 使用相同 requestId 发送重复请求，验证幂等性
4. [ ] 测试积分不足场景，验证预扣和退费逻辑
5. [ ] 检查 Supabase 日志确认没有 RLS 绕过

---

### 阶段三：AI 引擎与成本优化 (AI Engine & Optimization)

#### 交付物

- [ ] `packages/api/src/lib/ai/tokenCounter.ts` - Token 计数模块 (官方 API)
- [ ] `packages/api/src/lib/ai/contextManager.ts` - 上下文滑动窗口
- [ ] `packages/api/src/lib/ai/promptCaching.ts` - Prompt Caching 构建器
- [ ] `packages/api/src/lib/ai/streamHandler.ts` - SSE 流式传输
- [ ] `packages/api/src/lib/ai/costCalculator.ts` - 成本计算器
- [ ] `packages/api/src/lib/ai/contentModeration.ts` - 内容审查

#### 技术要求

**Token 计数 (官方 API):**

```typescript
// packages/api/src/lib/ai/tokenCounter.ts

const COUNT_TOKENS_URL = 'https://api.anthropic.com/v1/messages/count_tokens';

/**
 * 使用官方 count_tokens API 精确计算
 * @see https://platform.claude.com/docs/en/build-with-claude/token-counting
 */
export async function countTokensOfficial(params: {
  model: string;
  messages: Message[];
  system?: string;
  tools?: Tool[];
}): Promise<number> {
  const response = await fetch(COUNT_TOKENS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY!,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(params),
  });

  const data = await response.json();
  return data.input_tokens;
}

/**
 * 本地快速估算 (仅用于 UI 预览)
 */
export function estimateTokensLocal(text: string): number {
  const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const otherChars = text.length - chineseChars;
  return Math.ceil(chineseChars / 1.5 + otherChars / 4);
}
```

**Prompt Caching 构建器:**

```typescript
// packages/api/src/lib/ai/promptCaching.ts

const CACHE_CONFIG = {
  'claude-sonnet-4-5-20250929': { minTokens: 1024, maxBreakpoints: 4 },
  'claude-haiku-4-5-20251001': { minTokens: 2048, maxBreakpoints: 4 },
};

interface CacheControl {
  type: 'ephemeral';
  ttl?: '5m' | '1h';
}

/**
 * 构建带缓存控制的消息
 */
export function buildCachedMessages(
  messages: Message[],
  systemPrompt: string,
  modelId: string,
  options?: { extendedCache?: boolean }
): APIMessage[] {
  const config = CACHE_CONFIG[modelId] || CACHE_CONFIG['claude-sonnet-4-5-20250929'];
  const result: APIMessage[] = [];
  let breakpointCount = 0;
  let cumulativeTokens = 0;

  const cacheControl: CacheControl = {
    type: 'ephemeral',
    ...(options?.extendedCache && { ttl: '1h' }),
  };

  // 1. 系统提示词缓存
  if (systemPrompt && estimateTokensLocal(systemPrompt) >= config.minTokens) {
    result.push({
      role: 'system',
      content: [{
        type: 'text',
        text: systemPrompt,
        cache_control: cacheControl,
      }],
    });
    breakpointCount++;
  }

  // 2. 消息缓存 - 动态断点
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const msgTokens = estimateTokensLocal(msg.content);
    cumulativeTokens += msgTokens;

    const isStable = i < messages.length - 2;
    const reachedThreshold = cumulativeTokens >= config.minTokens;
    const canAddBreakpoint = breakpointCount < config.maxBreakpoints;

    if (isStable && reachedThreshold && canAddBreakpoint) {
      result.push({
        role: msg.role,
        content: [{
          type: 'text',
          text: msg.content,
          cache_control: cacheControl,
        }],
      });
      breakpointCount++;
      cumulativeTokens = 0;
    } else {
      result.push({ role: msg.role, content: msg.content });
    }
  }

  return result;
}
```

**上下文滑动窗口:**

```typescript
// packages/api/src/lib/ai/contextManager.ts

interface WindowConfig {
  maxTokens: number;       // 窗口大小
  summaryThreshold: number; // 触发摘要的消息数
  keepLatest: number;       // 保留最新消息数
}

/**
 * 滑动窗口上下文管理
 */
export class ContextManager {
  private config: WindowConfig;

  constructor(modelInputLimit: number) {
    this.config = {
      maxTokens: Math.min(modelInputLimit * 0.8, 150000),
      summaryThreshold: 8,
      keepLatest: 3,
    };
  }

  /**
   * 压缩对话历史
   */
  async compressHistory(
    messages: Message[],
    existingSummary?: string
  ): Promise<{ messages: Message[]; summary?: string }> {
    // 计算总 Token
    const totalTokens = await this.calculateTotalTokens(messages);

    // 未超限，无需压缩
    if (totalTokens < this.config.maxTokens) {
      return { messages, summary: existingSummary };
    }

    // 需要压缩
    if (messages.length > this.config.summaryThreshold) {
      // 生成摘要
      const oldMessages = messages.slice(0, -this.config.keepLatest);
      const newSummary = await this.generateSummary(oldMessages, existingSummary);

      // 保留最新消息
      const recentMessages = messages.slice(-this.config.keepLatest);

      return {
        messages: recentMessages,
        summary: newSummary,
      };
    }

    return { messages, summary: existingSummary };
  }

  private async generateSummary(messages: Message[], existingSummary?: string): Promise<string> {
    // 使用 Haiku 生成摘要 (成本更低)
    const prompt = existingSummary
      ? `基于已有摘要和新对话，更新摘要:\n\n已有摘要:\n${existingSummary}\n\n新对话:\n${formatMessages(messages)}`
      : `总结以下对话的关键信息:\n\n${formatMessages(messages)}`;

    const response = await callClaudeAPI({
      model: 'claude-haiku-4-5-20251001',
      maxTokens: 500,
      messages: [{ role: 'user', content: prompt }],
    });

    return response.content;
  }
}
```

#### 验证标准

- [ ] Token 统计与 Claude API 实际计费误差 <2%
- [ ] 压缩后上下文能保持对话连贯性
- [ ] 流式输出在网络中断后能恢复
- [ ] 缓存命中率 >30%（相同提示词）
- [ ] 成本计算精确到小数点后 6 位

#### 手动验证清单

1. [ ] 对比 100 次请求的 Token 统计与 API 计费
2. [ ] 进行 50 轮对话，验证上下文压缩效果
3. [ ] 模拟网络中断，验证流式输出恢复
4. [ ] 记录 1000 次请求的缓存命中率
5. [ ] 验证成本报表与实际账单一致

---

### 阶段四：前端集成与 UI 还原 (Frontend Integration)

#### 交付物

- [ ] `apps/web/src/components/chat/ChatInterface.tsx` - 对话界面 (接入新 tRPC)
- [ ] `apps/web/src/components/chat/MessageStream.tsx` - 流式消息渲染
- [ ] `apps/web/src/components/chat/InterruptButton.tsx` - 中断控制
- [ ] `apps/web/src/components/chat/TokenUsageDisplay.tsx` - Token 用量显示
- [ ] `apps/web/src/hooks/useAIChat.ts` - 封装 AI 对话逻辑
- [ ] `apps/web/src/hooks/useStreamResponse.ts` - 流式响应处理

#### 技术要求

**AI 对话 Hook:**

```typescript
// apps/web/src/hooks/useAIChat.ts

export function useAIChat(conversationId?: string) {
  const utils = api.useUtils();
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamContent, setStreamContent] = useState('');
  const abortControllerRef = useRef<AbortController | null>(null);

  // 非流式发送
  const sendMessage = api.ai.sendMessage.useMutation({
    onSuccess: () => {
      utils.chat.getMessages.invalidate({ conversationId });
    },
  });

  // 流式发送
  const streamMessage = useCallback(async (message: string) => {
    setIsStreaming(true);
    setStreamContent('');
    abortControllerRef.current = new AbortController();

    try {
      const response = await fetch('/api/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId, message }),
        signal: abortControllerRef.current.signal,
      });

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();

      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value);
        const lines = chunk.split('\n');

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = JSON.parse(line.slice(6));
            if (data.type === 'text') {
              setStreamContent(prev => prev + data.text);
            } else if (data.type === 'done') {
              // 刷新消息列表
              utils.chat.getMessages.invalidate({ conversationId });
            }
          }
        }
      }
    } finally {
      setIsStreaming(false);
    }
  }, [conversationId]);

  // 中断
  const interrupt = useCallback(() => {
    abortControllerRef.current?.abort();
    setIsStreaming(false);
  }, []);

  return {
    sendMessage,
    streamMessage,
    interrupt,
    isStreaming,
    streamContent,
  };
}
```

**流式消息渲染:**

```typescript
// apps/web/src/components/chat/MessageStream.tsx

export function MessageStream({
  content,
  isStreaming,
}: {
  content: string;
  isStreaming: boolean;
}) {
  return (
    <div className="message-bubble ai">
      <ReactMarkdown>{content}</ReactMarkdown>
      {isStreaming && (
        <span className="cursor animate-pulse">|</span>
      )}
    </div>
  );
}
```

**Token 用量显示:**

```typescript
// apps/web/src/components/chat/TokenUsageDisplay.tsx

export function TokenUsageDisplay({
  usage,
  cost,
}: {
  usage: TokenUsage;
  cost: CostBreakdown;
}) {
  return (
    <div className="token-usage text-xs text-muted-foreground">
      <div className="flex items-center gap-2">
        <span>输入: {usage.inputTokens}</span>
        <span>输出: {usage.outputTokens}</span>
        {usage.cacheReadTokens > 0 && (
          <span className="text-green-500">
            缓存命中: {usage.cacheReadTokens}
          </span>
        )}
      </div>
      <div>
        消耗: <span className="text-primary">{cost.creditsDeducted}</span> 积分
      </div>
    </div>
  );
}
```

#### 验证标准

- [ ] 界面与设计稿一致（误差 <5px）
- [ ] 流式输出延迟 <50ms（60fps）
- [ ] 中断按钮点击后 <100ms 停止
- [ ] Token/成本显示实时更新
- [ ] 移动端自适应无错位

#### 手动验证清单

1. [ ] 与设计稿逐像素对比
2. [ ] 录制流式输出视频，检查帧率
3. [ ] 点击中断，检查网络面板请求取消
4. [ ] 对比前端显示的 Token 与后端日志
5. [ ] 在 iPhone/Android 真机测试布局

---

### 阶段五：全链路测试与安全审计 (Testing & Security)

#### 交付物

- [ ] `__tests__/unit/billing.test.ts` - 计费逻辑单元测试
- [ ] `__tests__/unit/tokenCounter.test.ts` - Token 统计测试
- [ ] `__tests__/unit/contextManager.test.ts` - 上下文管理测试
- [ ] `__tests__/integration/ai-chat.test.ts` - 对话流程集成测试
- [ ] `__tests__/e2e/user-journey.spec.ts` - 端到端测试
- [ ] `docs/SECURITY_AUDIT.md` - 安全审计报告

#### 技术要求

**单元测试示例:**

```typescript
// __tests__/unit/billing.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { BillingService } from '@/services/billing';

describe('BillingService', () => {
  let service: BillingService;

  beforeEach(() => {
    service = new BillingService();
  });

  describe('preDeduct', () => {
    it('should deduct credits and return record id', async () => {
      const recordId = await service.preDeduct('user-1', 100);
      expect(recordId).toBeDefined();

      const balance = await getUserBalance('user-1');
      expect(balance).toBe(900); // 假设初始 1000
    });

    it('should throw error when balance insufficient', async () => {
      await expect(service.preDeduct('user-1', 10000))
        .rejects.toThrow('积分不足');
    });
  });

  describe('settle', () => {
    it('should refund excess when actual < estimated', async () => {
      const recordId = await service.preDeduct('user-1', 100);
      await service.settle(recordId, 80, mockUsage);

      const balance = await getUserBalance('user-1');
      expect(balance).toBe(920); // 退还 20
    });
  });

  describe('refund', () => {
    it('should restore full amount on failure', async () => {
      const recordId = await service.preDeduct('user-1', 100);
      await service.refund(recordId, 'API error');

      const balance = await getUserBalance('user-1');
      expect(balance).toBe(1000); // 完全退还
    });
  });
});
```

**集成测试:**

```typescript
// __tests__/integration/ai-chat.test.ts
import { describe, it, expect } from 'vitest';
import { createCaller } from '@/server/api/root';

describe('AI Chat Integration', () => {
  const caller = createCaller({ user: mockUser });

  it('should complete full chat flow', async () => {
    // 1. 发送消息
    const response = await caller.ai.sendMessage({
      message: '你好',
    });

    expect(response.content).toBeDefined();
    expect(response.usage.inputTokens).toBeGreaterThan(0);
    expect(response.cost.creditsDeducted).toBeGreaterThan(0);
  });

  it('should handle concurrent requests without double charging', async () => {
    const promises = Array(10).fill(null).map(() =>
      caller.ai.sendMessage({ message: 'test' })
    );

    const results = await Promise.all(promises);
    const totalDeducted = results.reduce((sum, r) => sum + r.cost.creditsDeducted, 0);

    const balance = await getUserBalance(mockUser.id);
    expect(balance).toBe(initialBalance - totalDeducted);
  });
});
```

**安全审计清单:**

```markdown
# 安全审计报告

## 检查项

### API 安全
- [ ] 所有 AI 接口使用 protectedProcedure
- [ ] 速率限制已配置 (10 req/min)
- [ ] 请求签名验证已实现

### 计费安全
- [ ] 数据库 CHECK 约束 (credits >= 0)
- [ ] 行级锁防并发扣费
- [ ] 后端二次余额校验
- [ ] 消费熔断机制启用

### 内容安全
- [ ] 输入内容审查
- [ ] 输出内容流式扫描
- [ ] Prompt 注入防御

### 数据安全
- [ ] RLS 策略 100% 覆盖
- [ ] 敏感数据脱敏
- [ ] Service Role 仅服务端使用

### 环境安全
- [ ] CORS 仅允许正式域名
- [ ] 环境变量审计通过
- [ ] .env 文件已在 .gitignore
```

#### 验证标准

- [ ] 单元测试覆盖率 >80%
- [ ] 并发测试无数据竞争
- [ ] RLS 测试确认用户数据完全隔离
- [ ] 安全扫描无高危漏洞
- [ ] 性能测试满足 <500ms 响应时间

#### 手动验证清单

1. [ ] 运行 `pnpm test:coverage` 查看覆盖率报告
2. [ ] 使用 k6 模拟 100 并发请求
3. [ ] 用不同用户账号尝试访问他人数据
4. [ ] 运行 `pnpm audit` 检查依赖漏洞
5. [ ] 使用 Lighthouse 测试性能得分

---

## 四、风险缓解策略

### 阶段一风险

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| 迁移脚本失败 | 低 | 高 | 先在测试环境执行，准备回滚 SQL |
| RLS 策略过严 | 中 | 中 | 逐表测试，保留默认 SELECT 权限 |

### 阶段二风险

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| 事务死锁 | 低 | 高 | 设置事务超时，监控慢查询 |
| 计费精度丢失 | 中 | 高 | 使用整数运算，避免浮点数 |

### 阶段三风险

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| Token 计数 API 超限 | 中 | 中 | 本地估算兜底，批量请求优化 |
| 缓存命中率低 | 中 | 中 | 动态调整断点策略 |

### 阶段四风险

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| 流式渲染卡顿 | 中 | 中 | 虚拟滚动，防抖处理 |
| 中断后状态不一致 | 低 | 中 | 乐观更新 + 重新获取 |

### 阶段五风险

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| 测试覆盖不全 | 中 | 中 | 代码审查，边界用例补充 |
| 安全漏洞遗漏 | 低 | 高 | 第三方审计，渗透测试 |

---

## 五、回滚方案

### 阶段一回滚

```sql
-- 回滚数据库变更
DROP TABLE IF EXISTS token_stats;
DROP TABLE IF EXISTS billing_history;
-- 恢复旧表结构 (如有修改)
```

### 阶段二回滚

1. 关闭功能开关 `enable_new_ai_engine: false`
2. 旧 AI 调用逻辑仍保留，可立即切换

### 阶段三回滚

1. 关闭 Prompt Caching `enable_prompt_caching: false`
2. 关闭上下文压缩 `enable_context_compression: false`

### 阶段四回滚

1. 切换前端组件 `useNewChatInterface: false`
2. 恢复旧版 ChatInterface 组件

### 阶段五回滚

测试阶段不影响生产，无需回滚。

---

## 六、成功指标

### 功能指标

| 指标 | 目标 | 测量方式 |
|------|------|----------|
| AI 对话成功率 | >99% | 请求成功数/总请求数 |
| 平均响应时间 | <2s | P95 响应时间 |
| 流式首字节时间 | <500ms | TTFB 监控 |

### 成本指标

| 指标 | 目标 | 测量方式 |
|------|------|----------|
| Token 计费误差 | <2% | 本地计费 vs 官方账单 |
| 缓存命中率 | >60% | cache_read_tokens / total_input_tokens |
| 成本节省 | >30% | 对比重构前后月度成本 |

### 安全指标

| 指标 | 目标 | 测量方式 |
|------|------|----------|
| 安全漏洞 | 0 高危 | 安全扫描报告 |
| RLS 绕过尝试 | 0 | 审计日志监控 |
| 异常消费触发 | <1%用户 | 熔断触发统计 |

### 质量指标

| 指标 | 目标 | 测量方式 |
|------|------|----------|
| 测试覆盖率 | >80% | Istanbul 报告 |
| TypeScript 严格模式 | 100% | tsc --noEmit |
| Lint 错误 | 0 | ESLint 报告 |

---

## 七、依赖与前置条件

### 环境变量

```bash
# Claude API
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_ADMIN_API_KEY=sk-ant-admin-...  # 可选，用于官方报告

# 速率限制 (Upstash Redis)
UPSTASH_REDIS_REST_URL=https://...
UPSTASH_REDIS_REST_TOKEN=...

# 请求签名
REQUEST_SIGNATURE_SECRET=...
```

### 依赖包

```json
{
  "@anthropic-ai/sdk": "^0.30.0",
  "@upstash/ratelimit": "^2.0.0",
  "@upstash/redis": "^1.28.0"
}
```

### 数据库迁移顺序

1. `20240121_create_token_stats_table.sql`
2. `20240121_create_billing_history_table.sql`
3. `20240121_update_ai_models_table.sql`
4. `20240121_enable_rls_policies.sql`

---

## 附录：文件结构

```
packages/
├── api/
│   └── src/
│       ├── middleware/
│       │   └── securityChecks.ts      # 安全检查
│       ├── routers/
│       │   └── ai.ts                   # AI 对话路由
│       ├── services/
│       │   ├── billing.ts              # 计费服务
│       │   └── modelRouter.ts          # 模型路由
│       ├── lib/
│       │   └── ai/
│       │       ├── tokenCounter.ts     # Token 计数
│       │       ├── contextManager.ts   # 上下文管理
│       │       ├── promptCaching.ts    # Prompt 缓存
│       │       ├── streamHandler.ts    # 流式处理
│       │       ├── costCalculator.ts   # 成本计算
│       │       └── contentModeration.ts # 内容审查
│       └── types/
│           ├── ai.ts                   # AI 类型
│           └── billing.ts              # 计费类型
├── db/
│   └── schema/
│       ├── token-stats.ts
│       └── billing-history.ts
└── apps/
    └── web/
        └── src/
            ├── components/
            │   └── chat/
            │       ├── ChatInterface.tsx
            │       ├── MessageStream.tsx
            │       ├── InterruptButton.tsx
            │       └── TokenUsageDisplay.tsx
            └── hooks/
                ├── useAIChat.ts
                └── useStreamResponse.ts
```

---

**文档结束**

> 本计划制定完成后，请逐阶段审核。确认无误后开始实际编码。
