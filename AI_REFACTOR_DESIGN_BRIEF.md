# AI 对话系统重构设计方案简报

> **版本**: v1.1 (基于官方文档修订)
> **日期**: 2026-01-21
> **状态**: 第一阶段审计完成

---

## 官方文档参考

本方案严格遵循以下 Claude 官方文档：

| 功能 | 文档链接 |
|------|----------|
| 提示词缓存 | [Prompt Caching](https://platform.claude.com/docs/zh-CN/build-with-claude/prompt-caching) |
| 流式消息 | [Streaming](https://platform.claude.com/docs/zh-CN/build-with-claude/streaming) |
| Token 计数 | [Token Counting](https://platform.claude.com/docs/zh-CN/build-with-claude/token-counting) |
| 视觉功能 | [Vision](https://platform.claude.com/docs/zh-CN/build-with-claude/vision) |
| Web 搜索工具 | [Web Search Tool](https://platform.claude.com/docs/zh-CN/agents-and-tools/tool-use/web-search-tool) |
| 使用情况与成本 | [Usage Cost API](https://platform.claude.com/docs/zh-CN/build-with-claude/usage-cost-api) |

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
| **Token 估算偏差** | `callAIModel.ts:46` | 🔴 高 | `chars/4` 粗糙估算，**应使用官方 count_tokens API** |
| **待结算累积溢出** | `smartChatWithSearch.ts:565-576` | 🟡 中 | `pending_credits` 浮点累积，长期使用有精度丢失 |
| **缓存折扣不透明** | `callAIModel.ts:468-471` | 🟡 中 | 90% 折扣硬编码，**官方定价为 0.1x** |
| **联网搜索固定费用** | `smartChatWithSearch.ts:556` | 🟠 低 | `WEB_SEARCH_FEE=5` 硬编码，**官方定价为 $10/1000 次** |

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

#### 4.2.1 Token 计数：使用官方 API

> **来源**: [Token Counting - Claude Docs](https://platform.claude.com/docs/zh-CN/build-with-claude/token-counting)

**❌ 旧方案 (不准确):**
```typescript
const estimateTokens = (text) => Math.ceil((text || '').length / 4);
```

**✅ 新方案 (官方 API):**
```typescript
// packages/api/src/services/tokenCounter.ts

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages/count_tokens';

/**
 * 使用官方 count_tokens API 精确计算 Token 数
 * @see https://platform.claude.com/docs/zh-CN/build-with-claude/token-counting
 *
 * 特点:
 * - 免费使用，但有速率限制 (2000 req/min)
 * - 支持 system, tools, images, PDFs
 * - 返回精确的 input_tokens 数量
 */
export async function countTokens(params: {
  model: string;
  messages: Message[];
  system?: string;
  tools?: Tool[];
}): Promise<number> {
  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY!,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: params.model,
      messages: params.messages,
      system: params.system,
      tools: params.tools,
    }),
  });

  const data = await response.json();
  return data.input_tokens;
}

// 本地快速估算 (仅用于 UI 预览，不用于计费)
export function estimateTokensLocal(text: string): number {
  const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const otherChars = text.length - chineseChars;
  return Math.ceil(chineseChars / 1.5 + otherChars / 4);
}
```

#### 4.2.2 Prompt Caching 优化

> **来源**: [Prompt Caching - Claude Docs](https://platform.claude.com/docs/zh-CN/build-with-claude/prompt-caching)

**官方规格:**
| 参数 | Claude Sonnet | Claude Haiku |
|------|--------------|--------------|
| **最小缓存 Token** | 1,024 | 2,048 |
| **最大缓存断点** | 4 | 4 |
| **默认 TTL** | 5 分钟 | 5 分钟 |
| **可选 TTL** | 1 小时 | 1 小时 |

**定价 (相对于基础输入价格):**
| 操作 | 5 分钟缓存 | 1 小时缓存 |
|------|-----------|-----------|
| 缓存写入 | 1.25x | 2x |
| 缓存读取 | 0.1x | 0.1x |

```typescript
// packages/api/src/services/promptCaching.ts

/**
 * 构建带缓存控制的消息
 * @see https://platform.claude.com/docs/zh-CN/build-with-claude/prompt-caching
 */

// 缓存配置 (根据模型动态调整)
const CACHE_CONFIG = {
  'claude-sonnet-4-5-20250929': { minTokens: 1024, maxBreakpoints: 4 },
  'claude-haiku-4-5-20251001': { minTokens: 2048, maxBreakpoints: 4 },
};

interface CacheControl {
  type: 'ephemeral';
  ttl?: '5m' | '1h';  // 可选: 1 小时缓存 (成本 2x)
}

export function buildCachedMessages(
  messages: Message[],
  systemPrompt: string,
  modelId: string,
  options?: { extendedCache?: boolean }
): APIMessage[] {
  const config = CACHE_CONFIG[modelId] || { minTokens: 1024, maxBreakpoints: 4 };
  const result: APIMessage[] = [];
  let breakpointCount = 0;

  // 缓存控制配置
  const cacheControl: CacheControl = {
    type: 'ephemeral',
    ...(options?.extendedCache && { ttl: '1h' }),
  };

  // 1. 系统提示词缓存 (优先级最高)
  // 缓存层级: tools → system → messages
  if (systemPrompt) {
    const systemTokens = await countTokens({ model: modelId, messages: [], system: systemPrompt });

    if (systemTokens >= config.minTokens && breakpointCount < config.maxBreakpoints) {
      result.push({
        role: 'system',
        content: [{
          type: 'text',
          text: systemPrompt,
          cache_control: cacheControl,
        }],
      });
      breakpointCount++;
    } else {
      result.push({ role: 'system', content: systemPrompt });
    }
  }

  // 2. 消息缓存 - 动态断点策略
  let cumulativeTokens = 0;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const msgTokens = estimateTokensLocal(msg.content); // UI 预览用本地估算
    cumulativeTokens += msgTokens;

    const isStableMessage = i < messages.length - 2; // 最后 2 条不缓存
    const reachedThreshold = cumulativeTokens >= config.minTokens;
    const canAddBreakpoint = breakpointCount < config.maxBreakpoints;

    if (isStableMessage && reachedThreshold && canAddBreakpoint) {
      result.push({
        role: msg.role,
        content: [{
          type: 'text',
          text: msg.content,
          cache_control: cacheControl,
        }],
      });
      breakpointCount++;
      cumulativeTokens = 0; // 重置累积
    } else {
      result.push({ role: msg.role, content: msg.content });
    }
  }

  return result;
}
```

#### 4.2.3 滑动窗口上下文管理

```
┌─────────────────────────────────────────────────────────────────┐
│                    上下文窗口策略                                │
│                                                                  │
│  Window Size = min(model.input_limit * 0.8, 150000)             │
│                                                                  │
│  ┌────────────────────────────────────────────────────────┐     │
│  │ [摘要区] ≥1024 tokens 时缓存 (Sonnet)                  │     │
│  │ - 仅当历史 > 8 轮时生成                                │     │
│  ├────────────────────────────────────────────────────────┤     │
│  │ [稳定区] cache_control: ephemeral                      │     │
│  │ - 累积 ≥1024/2048 tokens 时添加断点                    │     │
│  │ - 缓存命中率目标: 60%+                                 │     │
│  ├────────────────────────────────────────────────────────┤     │
│  │ [动态区] 最新 2 条消息 (不缓存)                        │     │
│  │ - 当前问答对                                           │     │
│  └────────────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────────┘
```

---

### 4.3 Web 搜索集成

> **来源**: [Web Search Tool - Claude Docs](https://platform.claude.com/docs/zh-CN/agents-and-tools/tool-use/web-search-tool)

**官方规格:**
- **定价**: $10 per 1,000 searches + 标准 Token 费用
- **搜索提供商**: Brave Search
- **支持模型**: Claude 3.7 Sonnet, Claude 3.5 Sonnet (upgraded), Claude 3.5 Haiku
- **Beta Header**: `anthropic-beta: web-search-2025-03-05`

```typescript
// packages/api/src/services/webSearch.ts

/**
 * Web 搜索工具配置
 * @see https://platform.claude.com/docs/zh-CN/agents-and-tools/tool-use/web-search-tool
 */

// 工具定义 (必须使用此格式)
const WEB_SEARCH_TOOL = {
  type: 'web_search_20250305',
  name: 'web_search',
  max_uses: 5,  // 单次请求最多搜索次数
};

interface WebSearchOptions {
  user_location?: {
    type: 'approximate';
    city?: string;
    region?: string;
    country: string;  // ISO 3166-1 alpha-2
    timezone?: string;
  };
  allowed_domains?: string[];  // 域名白名单
  blocked_domains?: string[];  // 域名黑名单
}

export async function callWithWebSearch(
  messages: Message[],
  options?: WebSearchOptions
): Promise<Response> {
  const requestBody: any = {
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 4096,
    messages,
    tools: [WEB_SEARCH_TOOL],
  };

  // 可选: 位置信息 (本地化搜索结果)
  if (options?.user_location) {
    requestBody.tools[0].user_location = options.user_location;
  }

  // 可选: 域名过滤
  if (options?.allowed_domains) {
    requestBody.tools[0].allowed_domains = options.allowed_domains;
  }
  if (options?.blocked_domains) {
    requestBody.tools[0].blocked_domains = options.blocked_domains;
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY!,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'web-search-2025-03-05',  // 必须
    },
    body: JSON.stringify(requestBody),
  });

  return response;
}

// 搜索费用计算
export function calculateSearchCost(searchCount: number): number {
  // $10 per 1,000 searches = $0.01 per search
  return searchCount * 0.01;
}
```

---

### 4.4 流式传输架构

> **来源**: [Streaming - Claude Docs](https://platform.claude.com/docs/zh-CN/build-with-claude/streaming)

**SSE 事件序列:**
```
message_start → content_block_start → content_block_delta* → content_block_stop → message_delta → message_stop
```

**事件类型:**
| 事件 | 描述 |
|------|------|
| `message_start` | 消息开始，包含 ID、model、input_tokens |
| `content_block_start` | 内容块开始 |
| `content_block_delta` | 增量文本 (`text_delta`) |
| `content_block_stop` | 内容块结束 |
| `message_delta` | 消息级更新 (stop_reason, usage) |
| `message_stop` | 消息完成 |
| `ping` | 心跳 |
| `error` | 错误 (如 `overloaded_error`) |

```typescript
// apps/web/src/app/api/chat/stream/route.ts

/**
 * 流式响应 API
 * @see https://platform.claude.com/docs/zh-CN/build-with-claude/streaming
 */

export async function POST(req: Request) {
  const { messages, model_id } = await req.json();

  // 获取模型配置
  const model = await getModelConfig(model_id);

  const response = await fetch(model.api_endpoint || 'https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': model.api_key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: model.model_id,
      max_tokens: model.max_tokens,
      messages,
      stream: true,  // 启用流式
    }),
  });

  // 转发 SSE 流
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const stream = new ReadableStream({
    async start(controller) {
      const reader = response.body?.getReader();
      if (!reader) return;

      let fullText = '';
      let inputTokens = 0;
      let outputTokens = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value);
        const lines = chunk.split('\n');

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = JSON.parse(line.slice(6));

            switch (data.type) {
              case 'message_start':
                inputTokens = data.message.usage?.input_tokens || 0;
                break;

              case 'content_block_delta':
                if (data.delta.type === 'text_delta') {
                  fullText += data.delta.text;
                  // 转发给客户端
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify({
                    type: 'text',
                    text: data.delta.text,
                  })}\n\n`));
                }
                break;

              case 'message_delta':
                outputTokens = data.usage?.output_tokens || 0;
                break;

              case 'message_stop':
                // 发送完成信号和使用统计
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({
                  type: 'done',
                  usage: { input_tokens: inputTokens, output_tokens: outputTokens },
                })}\n\n`));
                break;

              case 'error':
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({
                  type: 'error',
                  error: data.error,
                })}\n\n`));
                break;
            }
          }
        }
      }

      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}
```

---

### 4.5 Vision (视觉) 支持

> **来源**: [Vision - Claude Docs](https://platform.claude.com/docs/zh-CN/build-with-claude/vision)

**支持格式:** JPEG, PNG, GIF, WebP

**限制:**
- 单图: 8000×8000 px
- 批量 (>20 张): 2000×2000 px

```typescript
// packages/api/src/services/vision.ts

/**
 * 图片消息构建
 * @see https://platform.claude.com/docs/zh-CN/build-with-claude/vision
 *
 * 重要: media_type 必须与实际图片格式匹配！
 */

type MediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

interface ImageContent {
  type: 'image';
  source: {
    type: 'base64';
    media_type: MediaType;
    data: string;  // Base64 编码的图片数据
  };
}

export function buildImageMessage(
  base64Data: string,
  mediaType: MediaType
): ImageContent {
  // 验证 media_type 与数据头匹配
  const header = base64Data.substring(0, 10);
  const detectedType = detectMediaType(header);

  if (detectedType !== mediaType) {
    throw new Error(`Media type mismatch: declared ${mediaType}, detected ${detectedType}`);
  }

  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: mediaType,
      data: base64Data,
    },
  };
}

function detectMediaType(base64Header: string): MediaType {
  if (base64Header.startsWith('/9j/')) return 'image/jpeg';
  if (base64Header.startsWith('iVBORw')) return 'image/png';
  if (base64Header.startsWith('R0lGOD')) return 'image/gif';
  if (base64Header.startsWith('UklGR')) return 'image/webp';
  throw new Error('Unknown image format');
}
```

---

### 4.6 计费一致性方案：Drizzle 事务 + 官方定价

> **来源**: [Usage Cost API - Claude Docs](https://platform.claude.com/docs/zh-CN/build-with-claude/usage-cost-api)

**官方定价 (Per Million Tokens):**
| 模型 | 输入 | 输出 | 缓存写入 (5m) | 缓存读取 |
|------|------|------|--------------|---------|
| Claude Sonnet 4.5 | $3.00 | $15.00 | $3.75 (1.25x) | $0.30 (0.1x) |
| Claude Haiku 4.5 | $1.00 | $5.00 | $1.25 (1.25x) | $0.10 (0.1x) |
| Web Search | - | - | - | $10/1000 次 |

```typescript
// packages/api/src/services/billing.ts

import { db } from '@repo/db';
import { profiles, creditTransactions, tokenStats } from '@repo/db/schema';
import { eq, sql } from 'drizzle-orm';

// 官方定价 (美元/百万 Token)
const PRICING = {
  'claude-sonnet-4-5-20250929': {
    input: 3.0,
    output: 15.0,
    cacheWrite: 3.75,  // 1.25x
    cacheRead: 0.3,    // 0.1x
  },
  'claude-haiku-4-5-20251001': {
    input: 1.0,
    output: 5.0,
    cacheWrite: 1.25,
    cacheRead: 0.1,
  },
};

const WEB_SEARCH_COST_PER_1000 = 10.0; // $10 per 1000 searches

interface BillingParams {
  userId: string;
  conversationId: string;
  modelId: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  webSearchCount?: number;
}

/**
 * 原子计费事务
 * @see https://platform.claude.com/docs/zh-CN/build-with-claude/usage-cost-api
 */
export async function atomicBilling(params: BillingParams) {
  const { userId, conversationId, modelId, usage, webSearchCount = 0 } = params;
  const pricing = PRICING[modelId] || PRICING['claude-sonnet-4-5-20250929'];

  // 计算成本 (美元)
  const inputCost = (usage.input_tokens / 1_000_000) * pricing.input;
  const outputCost = (usage.output_tokens / 1_000_000) * pricing.output;
  const cacheWriteCost = ((usage.cache_creation_input_tokens || 0) / 1_000_000) * pricing.cacheWrite;
  const cacheReadCost = ((usage.cache_read_input_tokens || 0) / 1_000_000) * pricing.cacheRead;
  const searchCost = (webSearchCount / 1000) * WEB_SEARCH_COST_PER_1000;

  const totalCostUSD = inputCost + outputCost + cacheWriteCost + cacheReadCost + searchCost;

  // 转换为积分 (假设 1 积分 = $0.01)
  const creditsToDeduct = Math.ceil(totalCostUSD * 100);

  // ========== 原子事务 ==========
  return await db.transaction(async (tx) => {
    // 1. 检查余额并锁定行
    const [user] = await tx
      .select({ credits: profiles.credits })
      .from(profiles)
      .where(eq(profiles.id, userId))
      .for('update');

    if (!user || user.credits < creditsToDeduct) {
      throw new Error(`积分不足，需要 ${creditsToDeduct}，当前 ${user?.credits || 0}`);
    }

    // 2. 扣除积分
    await tx
      .update(profiles)
      .set({ credits: sql`${profiles.credits} - ${creditsToDeduct}` })
      .where(eq(profiles.id, userId));

    // 3. 记录交易
    const [transaction] = await tx
      .insert(creditTransactions)
      .values({
        userId,
        amount: -creditsToDeduct,
        type: 'deduction',
        description: `AI 对话 - ${modelId}`,
      })
      .returning();

    // 4. 记录 Token 统计
    await tx.insert(tokenStats).values({
      conversationId,
      userId,
      modelUsed: modelId,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cachedTokens: usage.cache_read_input_tokens || 0,
      cacheCreationTokens: usage.cache_creation_input_tokens || 0,
      webSearchCount,
      totalCostUsd: totalCostUSD,
      totalCredits: creditsToDeduct,
    });

    return {
      transactionId: transaction.id,
      creditsDeducted: creditsToDeduct,
      costBreakdown: {
        input: inputCost,
        output: outputCost,
        cacheWrite: cacheWriteCost,
        cacheRead: cacheReadCost,
        search: searchCost,
        total: totalCostUSD,
      },
    };
  });
}
```

---

## 五、实施优先级

| 优先级 | 模块 | 预估工作量 | 依赖 | 官方文档 |
|--------|------|-----------|------|----------|
| **P0** | AI 模型调用 (callAIModel) | 3-4h | 无 | [Vision](https://platform.claude.com/docs/zh-CN/build-with-claude/vision) |
| **P0** | 流式响应 API | 2-3h | P0-1 | [Streaming](https://platform.claude.com/docs/zh-CN/build-with-claude/streaming) |
| **P0** | 计费事务 (atomicBilling) | 2h | P0-1 | [Usage Cost API](https://platform.claude.com/docs/zh-CN/build-with-claude/usage-cost-api) |
| **P1** | Token 计数集成 | 1h | P0 完成 | [Token Counting](https://platform.claude.com/docs/zh-CN/build-with-claude/token-counting) |
| **P1** | Prompt Caching 集成 | 2h | P0 完成 | [Prompt Caching](https://platform.claude.com/docs/zh-CN/build-with-claude/prompt-caching) |
| **P1** | 上下文管理与压缩 | 3h | P1 完成 | - |
| **P2** | Web 搜索集成 | 2h | P0 完成 | [Web Search Tool](https://platform.claude.com/docs/zh-CN/agents-and-tools/tool-use/web-search-tool) |
| **P2** | 智能路由 (内联版) | 1h | P0 完成 | - |
| **P3** | Token 预算管理 | 1h | P1 完成 | - |

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

-- 新增表: token_stats (性能监控) - 扩展字段
CREATE TABLE token_stats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  user_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  model_used TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cached_tokens INTEGER DEFAULT 0,
  cache_creation_tokens INTEGER DEFAULT 0,
  web_search_count INTEGER DEFAULT 0,
  total_cost_usd DECIMAL(10, 6),  -- 精确到微美元
  total_credits INTEGER NOT NULL,
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
| Token 计数 API 速率限制 | 低 | 本地估算回退 + 请求合并 |

---

## 八、v1.1 修订说明

| 修订项 | 旧版本 | 新版本 | 依据 |
|--------|--------|--------|------|
| Token 估算 | `chars/4` 硬编码 | 官方 `count_tokens` API | [Token Counting](https://platform.claude.com/docs/zh-CN/build-with-claude/token-counting) |
| 缓存最小 Token | 1024 固定 | Sonnet 1024, Haiku 2048 | [Prompt Caching](https://platform.claude.com/docs/zh-CN/build-with-claude/prompt-caching) |
| 缓存定价 | 90% 折扣 | 读取 0.1x, 写入 1.25x | [Prompt Caching](https://platform.claude.com/docs/zh-CN/build-with-claude/prompt-caching) |
| 搜索费用 | 5 积分固定 | $10/1000 次 | [Web Search Tool](https://platform.claude.com/docs/zh-CN/agents-and-tools/tool-use/web-search-tool) |
| 流式事件 | 简化描述 | 完整 SSE 事件类型 | [Streaming](https://platform.claude.com/docs/zh-CN/build-with-claude/streaming) |
| Web 搜索 | 模糊描述 | 官方工具定义 + Beta Header | [Web Search Tool](https://platform.claude.com/docs/zh-CN/agents-and-tools/tool-use/web-search-tool) |
| Vision | 未涉及 | media_type 匹配规则 | [Vision](https://platform.claude.com/docs/zh-CN/build-with-claude/vision) |

---

**下一步**: 待确认后，进入第二阶段「核心模块实现」。
