# AI 对话系统重构设计方案简报

> **版本**: v1.0
> **日期**: 2026-01-21
> **状态**: 第一阶段审计完成

---

## 一、全量审计摘要

### 1.1 旧项目架构 (Base44 + Deno Functions)

| 模块 | 文件 | 行数 | 核心功能 |
|------|------|------|----------|
| AI 模型调用 | `callAIModel.ts` | 696 | 多 Provider 支持、Prompt Caching、成本统计 |
| 智能对话 | `smartChatWithSearch.ts` | 775 | 联网搜索、历史压缩、任务分类、计费扣费 |
| 任务分类器 | `taskClassifier.ts` | 141 | 双模型路由 (Sonnet/Haiku) |
| Token 预算 | `tokenBudgetManager.ts` | 150 | 对话级 Token 配额管理 |
| 对话压缩 | `compressConversation.ts` | 149 | 摘要生成、历史裁剪 |
| **总计** | **5 个核心函数** | **~1911** | - |

### 1.2 新项目架构 (Next.js + tRPC + Drizzle)

| 模块 | 文件 | 行数 | 当前状态 |
|------|------|------|----------|
| 对话管理 | `chat.ts` | 123 | ⚠️ 仅 CRUD，**无 AI 调用** |
| 积分系统 | `credits.ts` | 400+ | ✅ 完整，但**未与 AI 集成** |
| 模型管理 | `model.ts` | 200+ | ✅ 管理后台完整 |
| 管理后台 | `admin.ts` | 2200+ | ✅ 功能齐全 |

---

## 二、未迁移的用户端功能模块

### 2.1 核心缺失 (P0 - 用户无法使用)

| 功能 | 旧项目位置 | 新项目状态 | 影响 |
|------|-----------|------------|------|
| **AI 模型调用** | `callAIModel.ts` | ❌ 完全缺失 | 用户无法对话 |
| **智能对话流程** | `smartChatWithSearch.ts` | ❌ 完全缺失 | 无上下文、无计费 |
| **联网搜索** | `force_web_search` | ❌ 未实现 | 无法获取实时信息 |
| **流式响应** | OpenRouter streaming | ❌ 未实现 | 用户体验差 |

### 2.2 重要缺失 (P1 - 功能不完整)

| 功能 | 旧项目位置 | 新项目状态 |
|------|-----------|------------|
| 智能模型路由 | `taskClassifier.ts` | ❌ 缺失 |
| 对话历史压缩 | `compressConversation.ts` | ❌ 缺失 |
| Token 预算管理 | `tokenBudgetManager.ts` | ❌ 缺失 |
| 搜索结果缓存 | `SearchCache` 实体 | ❌ 缺失 |
| Prompt Caching | `cache_control` 逻辑 | ❌ 缺失 |

### 2.3 配置未对齐 (P2 - 管理配置无效)

| 配置项 | 管理后台状态 | 用户端对接 |
|--------|--------------|------------|
| 模型开关 (`is_active`) | ✅ 可配置 | ❌ 未读取 |
| 模型定价 (`token_costs`) | ✅ 可配置 | ❌ 未使用 |
| 联网搜索开关 | ✅ 可配置 | ❌ 未实现 |
| 系统设置 35+ 项 | ✅ 已存储 | ❌ 未读取 |

---

## 三、旧版 AI 逻辑缺陷审计

### 3.1 Token 浪费问题

| 问题 | 代码位置 | 严重程度 | 描述 |
|------|----------|----------|------|
| **重复系统提示词** | `smartChatWithSearch.ts:489-498` | 🔴 高 | 每轮对话都发送完整 system_prompt，未利用 conversation.system_prompt 缓存 |
| **摘要触发延迟** | `smartChatWithSearch.ts:680` | 🟡 中 | `COMPRESSION_TRIGGER_MESSAGES=20` 才触发，前 20 条消息浪费 Token |
| **缓存断点固定** | `callAIModel.ts:155` | 🟡 中 | 倒数第 4 条硬编码，对长对话效果差 |
| **搜索提示词冗余** | `smartChatWithSearch.ts:290` | 🟠 低 | 搜索关键词检测后仍发送完整消息 |

### 3.2 计费不准确问题

| 问题 | 代码位置 | 严重程度 | 描述 |
|------|----------|----------|------|
| **Token 估算偏差** | `callAIModel.ts:46` | 🔴 高 | `chars/4` 粗糙估算，中文和代码偏差大 |
| **待结算累积溢出** | `smartChatWithSearch.ts:565-576` | 🟡 中 | `pending_credits` 浮点累积，长期使用有精度丢失 |
| **缓存折扣不透明** | `callAIModel.ts:468-471` | 🟡 中 | 90% 折扣硬编码，无法按模型配置 |
| **联网搜索固定费用** | `smartChatWithSearch.ts:556` | 🟠 低 | `WEB_SEARCH_FEE=5` 硬编码，无法动态配置 |

### 3.3 上下文管理混乱

| 问题 | 代码位置 | 严重程度 | 描述 |
|------|----------|----------|------|
| **摘要拼接方式** | `smartChatWithSearch.ts:367-372` | 🔴 高 | 摘要以文本块形式注入首条消息，破坏对话结构 |
| **历史截断粗暴** | `callAIModel.ts:213-222` | 🟡 中 | 按 2 条一组删除，可能截断相关上下文 |
| **RLS 绕过查询** | `smartChatWithSearch.ts:329-338` | 🟡 中 | filter 失败后用 list + find，性能和安全隐患 |

### 3.4 智能路由低效

| 问题 | 代码位置 | 严重程度 | 描述 |
|------|----------|----------|------|
| **多次 RPC 调用** | `smartChatWithSearch.ts:172-231` | 🔴 高 | 每条消息调用 `taskClassifier`，增加 50-100ms 延迟 |
| **分类结果浪费** | `smartChatWithSearch.ts:199` | 🟡 中 | `should_update_session_task_type` 很少为 true，大部分分类白做 |
| **模型匹配逻辑复杂** | `smartChatWithSearch.ts:206-226` | 🟡 中 | 三层包含匹配，容易误判 |

---

## 四、重构设计方案

### 4.1 智能路由方案：数据库驱动的动态模型分发

```
┌─────────────────────────────────────────────────────────────────┐
│                      请求入口 (tRPC sendMessage)                 │
└─────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│  Step 1: 读取系统配置 (缓存 5 分钟)                               │
│  - enable_smart_routing: boolean                                 │
│  - enable_web_search: boolean                                    │
│  - default_model_id: uuid                                        │
└─────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│  Step 2: 模型选择策略                                            │
│                                                                  │
│  if (conversation.model_id) {                                   │
│    → 使用对话绑定的模型                                          │
│  } else if (enable_smart_routing) {                             │
│    → 执行 inlineTaskClassifier (不调用外部函数)                  │
│  } else {                                                        │
│    → 使用系统默认模型                                            │
│  }                                                               │
└─────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│  Step 3: 从数据库读取模型配置                                    │
│                                                                  │
│  SELECT * FROM ai_models                                        │
│  WHERE id = :selected_model_id AND is_active = 'true'           │
│                                                                  │
│  → api_key, api_endpoint, max_tokens, input_limit               │
│  → input_token_cost, output_token_cost, web_search_cost         │
└─────────────────────────────────────────────────────────────────┘
```

**内联任务分类器 (无额外 RPC):**
```typescript
function inlineTaskClassifier(message: string, turns: number): ModelId {
  // 规则 1: 多轮对话 (>=3) → Sonnet
  if (turns >= 3) return config.sonnet_model_id;

  // 规则 2: 简单确认词 → Haiku
  if (message.length < 10 && SIMPLE_WORDS.has(message.toLowerCase())) {
    return config.haiku_model_id;
  }

  // 默认 → Sonnet
  return config.sonnet_model_id;
}
```

---

### 4.2 成本优化策略

#### 4.2.1 滑动窗口上下文管理

```
┌─────────────────────────────────────────────────────────────────┐
│                    上下文窗口策略                                │
│                                                                  │
│  Window Size = min(model.input_limit * 0.8, 150000)             │
│                                                                  │
│  ┌────────────────────────────────────────────────────────┐     │
│  │ [摘要区] 1024 tokens (可选)                            │     │
│  │ - 仅当历史 > 10 轮时生成                               │     │
│  ├────────────────────────────────────────────────────────┤     │
│  │ [稳定区] 最近 6-8 条消息 (cache_control: ephemeral)    │     │
│  │ - 缓存命中率目标: 60%+                                 │     │
│  ├────────────────────────────────────────────────────────┤     │
│  │ [动态区] 最新 2 条消息 (不缓存)                        │     │
│  │ - 当前问答对                                           │     │
│  └────────────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────────┘
```

#### 4.2.2 智能摘要压缩 (改进版)

```typescript
// 触发条件优化
const COMPRESSION_CONFIG = {
  trigger_turns: 8,          // 8 轮触发 (而非 10 轮)
  keep_recent: 4,            // 保留最近 4 条 (而非 6 条)
  summary_max_tokens: 200,   // 摘要更短 (而非 300)
  use_haiku: true,           // 强制 Haiku 生成摘要
};

// 压缩流程
async function compressIfNeeded(conversationId: string, messageCount: number) {
  if (messageCount < COMPRESSION_CONFIG.trigger_turns * 2) return;

  // 异步压缩，不阻塞响应
  queueMicrotask(async () => {
    const oldMessages = await getOldMessages(conversationId, messageCount - 4);
    const summary = await generateSummary(oldMessages); // 使用 Haiku
    await saveSummary(conversationId, summary);
  });
}
```

#### 4.2.3 Token 估算改进

```typescript
// 改进的 Token 估算 (区分语言)
function estimateTokens(text: string): number {
  const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const otherChars = text.length - chineseChars;

  // 中文约 1.5 字符 = 1 token，英文约 4 字符 = 1 token
  return Math.ceil(chineseChars / 1.5 + otherChars / 4);
}
```

---

### 4.3 计费一致性方案：Drizzle 事务保证原子性

```typescript
// packages/api/src/services/billing.ts

import { db } from '@repo/db';
import { profiles, creditTransactions, tokenStats } from '@repo/db/schema';
import { eq, sql } from 'drizzle-orm';

interface BillingParams {
  userId: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  modelConfig: ModelConfig;
  webSearchUsed: boolean;
}

export async function atomicBilling(params: BillingParams) {
  const { userId, inputTokens, outputTokens, cachedTokens, modelConfig, webSearchUsed } = params;

  // 计算费用 (从数据库配置读取)
  const uncachedInputTokens = inputTokens - cachedTokens;
  const inputCredits = (uncachedInputTokens / 1000) * (modelConfig.inputTokenCost / 1000);
  const cachedCredits = (cachedTokens / 1000) * (modelConfig.inputTokenCost / 1000) * 0.1;
  const outputCredits = (outputTokens / 200) * (modelConfig.outputTokenCost / 1000);
  const searchCredits = webSearchUsed ? modelConfig.webSearchCost : 0;

  const totalCredits = Math.ceil(inputCredits + cachedCredits + outputCredits + searchCredits);

  // ========== 原子事务 ==========
  return await db.transaction(async (tx) => {
    // 1. 检查余额并锁定行
    const [user] = await tx
      .select({ credits: profiles.credits })
      .from(profiles)
      .where(eq(profiles.id, userId))
      .for('update'); // 行级锁

    if (!user || user.credits < totalCredits) {
      throw new Error(`积分不足，需要 ${totalCredits}，当前 ${user?.credits || 0}`);
    }

    // 2. 扣除积分
    await tx
      .update(profiles)
      .set({ credits: sql`${profiles.credits} - ${totalCredits}` })
      .where(eq(profiles.id, userId));

    // 3. 记录交易
    const [transaction] = await tx
      .insert(creditTransactions)
      .values({
        userId,
        amount: -totalCredits,
        type: 'deduction',
        description: `AI 对话 - ${modelConfig.name}`,
      })
      .returning();

    // 4. 记录 Token 统计
    await tx.insert(tokenStats).values({
      conversationId: params.conversationId,
      userId,
      modelUsed: modelConfig.name,
      inputTokens,
      outputTokens,
      cachedTokens,
      totalCost: totalCredits,
    });

    return {
      transactionId: transaction.id,
      creditsDeducted: totalCredits,
      newBalance: user.credits - totalCredits,
    };
  });
}
```

---

### 4.4 性能提升方案

#### 4.4.1 流式传输架构

```
┌─────────────────────────────────────────────────────────────────┐
│                     流式响应架构                                 │
│                                                                  │
│  Client (React)                                                  │
│       │                                                          │
│       │ POST /api/chat/stream                                    │
│       ▼                                                          │
│  ┌─────────────────────────────────────────────────────┐        │
│  │ Next.js Route Handler                               │        │
│  │                                                     │        │
│  │ export async function POST(req) {                   │        │
│  │   return new Response(                              │        │
│  │     new ReadableStream({                            │        │
│  │       async start(controller) {                     │        │
│  │         for await (const chunk of streamAI()) {     │        │
│  │           controller.enqueue(encode(chunk));        │        │
│  │         }                                           │        │
│  │         controller.close();                         │        │
│  │       }                                             │        │
│  │     }),                                             │        │
│  │     { headers: { 'Content-Type': 'text/event-stream' } }     │
│  │   );                                                │        │
│  │ }                                                   │        │
│  └─────────────────────────────────────────────────────┘        │
│                          │                                       │
│                          ▼                                       │
│  ┌─────────────────────────────────────────────────────┐        │
│  │ OpenRouter / Anthropic API (stream: true)           │        │
│  └─────────────────────────────────────────────────────┘        │
└─────────────────────────────────────────────────────────────────┘
```

#### 4.4.2 配置缓存层

```typescript
// packages/api/src/services/configCache.ts

import { unstable_cache } from 'next/cache';

// 系统设置缓存 (5 分钟)
export const getSystemSettings = unstable_cache(
  async () => {
    const settings = await db.select().from(systemSettings);
    return Object.fromEntries(settings.map(s => [s.key, s.value]));
  },
  ['system-settings'],
  { revalidate: 300 }
);

// 活跃模型缓存 (1 分钟)
export const getActiveModels = unstable_cache(
  async () => {
    return db.select().from(aiModels).where(eq(aiModels.isActive, 'true'));
  },
  ['active-models'],
  { revalidate: 60 }
);
```

#### 4.4.3 Prompt Caching 优化

```typescript
function buildCachedMessages(messages: Message[], systemPrompt: string) {
  const result: APIMessage[] = [];

  // 1. 系统提示词缓存 (如果 >= 1024 tokens)
  if (systemPrompt && estimateTokens(systemPrompt) >= 1024) {
    result.push({
      role: 'system',
      content: [{
        type: 'text',
        text: systemPrompt,
        cache_control: { type: 'ephemeral' }
      }]
    });
  }

  // 2. 动态缓存断点 (基于消息长度，而非固定位置)
  let cumulativeTokens = 0;
  const CACHE_THRESHOLD = 2048;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const tokens = estimateTokens(msg.content);
    cumulativeTokens += tokens;

    // 在累积超过 2048 tokens 的边界添加缓存
    const shouldCache = cumulativeTokens >= CACHE_THRESHOLD &&
                        i < messages.length - 2; // 最后 2 条不缓存

    result.push({
      role: msg.role,
      content: shouldCache
        ? [{ type: 'text', text: msg.content, cache_control: { type: 'ephemeral' } }]
        : msg.content
    });

    if (shouldCache) cumulativeTokens = 0; // 重置计数
  }

  return result;
}
```

---

## 五、实施优先级

| 优先级 | 模块 | 预估工作量 | 依赖 |
|--------|------|-----------|------|
| **P0** | AI 模型调用 (callAIModel) | 3-4h | 无 |
| **P0** | 流式响应 API | 2-3h | P0-1 |
| **P0** | 计费事务 (atomicBilling) | 2h | P0-1 |
| **P1** | 上下文管理与压缩 | 3h | P0 完成 |
| **P1** | Prompt Caching 集成 | 2h | P0 完成 |
| **P2** | 智能路由 (内联版) | 1h | P0 完成 |
| **P2** | Token 预算管理 | 1h | P1 完成 |
| **P3** | 搜索缓存层 | 2h | 可独立 |

---

## 六、数据库变更预览

```sql
-- 新增表: conversation_summaries (摘要存储)
CREATE TABLE conversation_summaries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
  summary_text TEXT NOT NULL,
  covered_messages INTEGER NOT NULL,
  summary_tokens INTEGER NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 新增表: token_stats (性能监控)
CREATE TABLE token_stats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  user_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  model_used TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cached_tokens INTEGER DEFAULT 0,
  cache_creation_tokens INTEGER DEFAULT 0,
  total_cost INTEGER NOT NULL,
  response_time_ms INTEGER,
  is_error BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 扩展 conversations 表
ALTER TABLE conversations ADD COLUMN system_prompt TEXT;
ALTER TABLE conversations ADD COLUMN session_task_type TEXT;
ALTER TABLE conversations ADD COLUMN total_tokens_used INTEGER DEFAULT 0;
```

---

## 七、风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| API Key 泄露 | 高 | 环境变量 + Supabase Vault |
| 计费事务死锁 | 中 | 事务超时 5s + 重试 3 次 |
| 流式响应中断 | 中 | 客户端重连 + 断点续传 |
| 缓存一致性 | 低 | 短 TTL + 主动失效 |

---

**下一步**: 待确认后，进入第二阶段「核心模块实现」。
