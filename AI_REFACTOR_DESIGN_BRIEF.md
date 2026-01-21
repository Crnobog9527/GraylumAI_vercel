# AI 对话系统重构设计方案简报

> **版本**: v1.2 (新增文件上传/Web Fetch/财务统计模块)
> **日期**: 2026-01-21
> **状态**: 第一阶段审计完成

---

## 官方文档参考

本方案严格遵循以下 Claude 官方文档：

| 功能 | 文档链接 |
|------|----------|
| 提示词缓存 | [Prompt Caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) |
| 流式消息 | [Streaming](https://platform.claude.com/docs/en/build-with-claude/streaming) |
| Token 计数 | [Token Counting](https://platform.claude.com/docs/en/build-with-claude/token-counting) |
| 视觉功能 | [Vision](https://platform.claude.com/docs/en/build-with-claude/vision) |
| PDF 支持 | [PDF Support](https://platform.claude.com/docs/en/build-with-claude/pdf-support) |
| Web 搜索工具 | [Web Search Tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool) |
| Web 获取工具 | [Web Fetch Tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-fetch-tool) |
| 使用情况与成本 | [Usage Cost API](https://platform.claude.com/docs/en/build-with-claude/usage-cost-api) |
| 使用报告 API | [Get Messages Usage Report](https://docs.anthropic.com/en/api/admin-api/usage-cost/get-messages-usage-report) |
| 成本报告 API | [Get Cost Report](https://docs.anthropic.com/en/api/admin-api/usage-cost/get-cost-report) |
| 官方定价 | [Pricing](https://platform.claude.com/docs/en/about-claude/pricing) |
| Cookbooks | [claude-cookbooks](https://github.com/anthropics/claude-cookbooks) |

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

> **来源**: [Token Counting - Claude Docs](https://platform.claude.com/docs/en/build-with-claude/token-counting)

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
 * @see https://platform.claude.com/docs/en/build-with-claude/token-counting
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

> **来源**: [Prompt Caching - Claude Docs](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)

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
 * @see https://platform.claude.com/docs/en/build-with-claude/prompt-caching
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

> **来源**: [Web Search Tool - Claude Docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool)

**官方规格:**
- **定价**: $10 per 1,000 searches + 标准 Token 费用
- **搜索提供商**: Brave Search
- **支持模型**: Claude 3.7 Sonnet, Claude 3.5 Sonnet (upgraded), Claude 3.5 Haiku
- **Beta Header**: `anthropic-beta: web-search-2025-03-05`

```typescript
// packages/api/src/services/webSearch.ts

/**
 * Web 搜索工具配置
 * @see https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool
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

> **来源**: [Streaming - Claude Docs](https://platform.claude.com/docs/en/build-with-claude/streaming)

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
 * @see https://platform.claude.com/docs/en/build-with-claude/streaming
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

> **来源**: [Vision - Claude Docs](https://platform.claude.com/docs/en/build-with-claude/vision)

**支持格式:** JPEG, PNG, GIF, WebP

**限制:**
- 单图: 8000×8000 px
- 批量 (>20 张): 2000×2000 px

```typescript
// packages/api/src/services/vision.ts

/**
 * 图片消息构建
 * @see https://platform.claude.com/docs/en/build-with-claude/vision
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

> **来源**: [Usage Cost API - Claude Docs](https://platform.claude.com/docs/en/build-with-claude/usage-cost-api)

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
 * @see https://platform.claude.com/docs/en/build-with-claude/usage-cost-api
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

### 4.7 Web Fetch Tool (网页获取工具)

> **来源**: [Web Fetch Tool - Claude Docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-fetch-tool)

**功能描述**: 允许 Claude 获取指定 URL 的完整网页内容，用于分析文章、文档等。

**官方规格:**
- **Beta Header**: `anthropic-beta: web-fetch-2025-09-10`
- **工具类型**: `web_fetch_20250910`
- **最大内容 Token**: 100,000 tokens
- **限制**: 不支持 JavaScript 动态渲染的网站
- **安全**: Claude 不能动态构造 URL，只能获取用户明确提供的 URL

**安全注意事项:**
- 启用此工具可能存在数据泄露风险
- 建议使用 `allowed_domains` 限制可访问的域名
- 不建议在处理敏感数据的环境中使用

```typescript
// packages/api/src/services/webFetch.ts

/**
 * Web Fetch 工具配置
 * @see https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-fetch-tool
 */

// 工具定义 (必须使用此格式)
const WEB_FETCH_TOOL = {
  type: 'web_fetch_20250910',
  name: 'web_fetch',
  max_uses: 5,  // 单次请求最多获取次数
};

interface WebFetchOptions {
  max_uses?: number;             // 最大获取次数 (默认 5)
  allowed_domains?: string[];    // 域名白名单
  blocked_domains?: string[];    // 域名黑名单 (不能与白名单同时使用)
  max_content_tokens?: number;   // 最大内容 Token (默认 100,000)
}

export async function callWithWebFetch(
  messages: Message[],
  options?: WebFetchOptions
): Promise<Response> {
  const tool: any = { ...WEB_FETCH_TOOL };

  // 配置选项
  if (options?.max_uses) tool.max_uses = options.max_uses;
  if (options?.allowed_domains) tool.allowed_domains = options.allowed_domains;
  if (options?.blocked_domains) tool.blocked_domains = options.blocked_domains;
  if (options?.max_content_tokens) tool.max_content_tokens = options.max_content_tokens;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY!,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'web-fetch-2025-09-10',  // 必须
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 4096,
      messages,
      tools: [tool],
    }),
  });

  return response;
}

// 组合使用 Web Search + Web Fetch
export async function callWithSearchAndFetch(
  messages: Message[],
  searchOptions?: WebSearchOptions,
  fetchOptions?: WebFetchOptions
): Promise<Response> {
  const tools = [
    {
      type: 'web_search_20250305',
      name: 'web_search',
      max_uses: 5,
      ...searchOptions,
    },
    {
      type: 'web_fetch_20250910',
      name: 'web_fetch',
      max_uses: 3,
      ...fetchOptions,
    },
  ];

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY!,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'web-search-2025-03-05,web-fetch-2025-09-10',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 8192,
      messages,
      tools,
    }),
  });

  return response;
}
```

---

### 4.8 文件上传支持 (PDF/DOC/图片)

> **来源**:
> - [PDF Support - Claude Docs](https://platform.claude.com/docs/en/build-with-claude/pdf-support)
> - [Vision - Claude Docs](https://platform.claude.com/docs/en/build-with-claude/vision)

**设计目标**: 与 Claude 官方对话体验一致的文件上传功能。

**支持的文件类型:**
| 类型 | 格式 | API 处理方式 | Token 计算 |
|------|------|-------------|-----------|
| **图片** | JPEG, PNG, GIF, WebP | `image` content type | 按像素计算 |
| **PDF** | .pdf | `document` content type | 1,500-3,000 tokens/页 + 图片 tokens |
| **Office** | .docx, .xlsx, .pptx | Agent Skills (Beta) | 按文本提取后计算 |

**PDF 处理规格:**
- **最大文件**: 32 MB 或 100 页
- **处理方式**: 每页转换为图片 + 文本提取
- **Token 估算**: 1,500-3,000 tokens/页 (取决于内容密度)

**图片处理规格:**
- **单图限制**: 8000×8000 px
- **批量限制** (>20张): 2000×2000 px
- **格式要求**: media_type 必须与实际格式匹配

```typescript
// packages/api/src/services/fileUpload.ts

/**
 * 文件上传处理服务
 * @see https://platform.claude.com/docs/en/build-with-claude/pdf-support
 * @see https://platform.claude.com/docs/en/build-with-claude/vision
 */

type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
type DocumentMediaType = 'application/pdf';

// 支持的文件类型
const SUPPORTED_TYPES = {
  // 图片
  'image/jpeg': { maxSize: 20 * 1024 * 1024, ext: ['.jpg', '.jpeg'] },
  'image/png': { maxSize: 20 * 1024 * 1024, ext: ['.png'] },
  'image/gif': { maxSize: 20 * 1024 * 1024, ext: ['.gif'] },
  'image/webp': { maxSize: 20 * 1024 * 1024, ext: ['.webp'] },
  // PDF
  'application/pdf': { maxSize: 32 * 1024 * 1024, ext: ['.pdf'], maxPages: 100 },
};

/**
 * 构建图片消息内容
 */
export function buildImageContent(
  base64Data: string,
  mediaType: ImageMediaType
): ImageContentBlock {
  // 验证 media_type 与数据头匹配
  validateMediaType(base64Data, mediaType);

  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: mediaType,
      data: base64Data,
    },
  };
}

/**
 * 构建 PDF 文档消息内容
 * @see https://platform.claude.com/docs/en/build-with-claude/pdf-support
 */
export function buildDocumentContent(
  base64Data: string,
  filename?: string
): DocumentContentBlock {
  return {
    type: 'document',
    source: {
      type: 'base64',
      media_type: 'application/pdf',
      data: base64Data,
    },
    ...(filename && { title: filename }),
  };
}

/**
 * 处理用户上传的文件，返回 API 消息内容块
 */
export async function processUploadedFile(
  file: File
): Promise<ContentBlock[]> {
  const contentBlocks: ContentBlock[] = [];

  // 验证文件类型
  const mimeType = file.type;
  const typeConfig = SUPPORTED_TYPES[mimeType];

  if (!typeConfig) {
    throw new Error(`不支持的文件类型: ${mimeType}`);
  }

  // 验证文件大小
  if (file.size > typeConfig.maxSize) {
    throw new Error(`文件过大: ${file.name} (最大 ${typeConfig.maxSize / 1024 / 1024}MB)`);
  }

  // 读取文件为 Base64
  const arrayBuffer = await file.arrayBuffer();
  const base64Data = Buffer.from(arrayBuffer).toString('base64');

  // 根据类型构建内容块
  if (mimeType.startsWith('image/')) {
    contentBlocks.push(buildImageContent(base64Data, mimeType as ImageMediaType));
  } else if (mimeType === 'application/pdf') {
    contentBlocks.push(buildDocumentContent(base64Data, file.name));
  }

  return contentBlocks;
}

/**
 * 估算文件的 Token 消耗
 * @see https://platform.claude.com/docs/en/build-with-claude/token-counting
 */
export async function estimateFileTokens(
  file: File,
  model: string
): Promise<number> {
  const mimeType = file.type;

  if (mimeType === 'application/pdf') {
    // PDF: 使用官方 count_tokens API 精确计算
    // 粗估: 每页 1,500-3,000 tokens
    const pageEstimate = Math.ceil(file.size / (100 * 1024)); // 估算页数
    return pageEstimate * 2000; // 取中间值
  }

  if (mimeType.startsWith('image/')) {
    // 图片: 根据分辨率计算
    // 官方建议使用 count_tokens API
    return 1500; // 平均估算
  }

  return 0;
}

/**
 * 验证 media_type 与实际数据匹配
 */
function validateMediaType(base64Data: string, declaredType: string): void {
  const header = base64Data.substring(0, 20);
  let detectedType: string;

  if (header.startsWith('/9j/')) detectedType = 'image/jpeg';
  else if (header.startsWith('iVBORw')) detectedType = 'image/png';
  else if (header.startsWith('R0lGOD')) detectedType = 'image/gif';
  else if (header.startsWith('UklGR')) detectedType = 'image/webp';
  else if (header.startsWith('JVBERi')) detectedType = 'application/pdf';
  else throw new Error('无法识别的文件格式');

  if (detectedType !== declaredType) {
    throw new Error(`文件类型不匹配: 声明 ${declaredType}, 检测到 ${detectedType}`);
  }
}

// TypeScript 类型定义
interface ImageContentBlock {
  type: 'image';
  source: {
    type: 'base64';
    media_type: ImageMediaType;
    data: string;
  };
}

interface DocumentContentBlock {
  type: 'document';
  source: {
    type: 'base64';
    media_type: DocumentMediaType;
    data: string;
  };
  title?: string;
}

type ContentBlock = ImageContentBlock | DocumentContentBlock | { type: 'text'; text: string };
```

**DOC/DOCX 支持方案:**

DOC/DOCX 文件需要先提取文本，有两种方案：

1. **服务端提取** (推荐): 使用 `mammoth` 库提取 DOCX 文本
2. **Agent Skills (Beta)**: 使用官方 `skills-2025-10-02` beta 功能

```typescript
// 方案 1: 服务端文本提取
import mammoth from 'mammoth';

export async function extractDocxText(file: File): Promise<string> {
  const arrayBuffer = await file.arrayBuffer();
  const result = await mammoth.extractRawText({ arrayBuffer });
  return result.value;
}

// 转换为普通文本消息
export function buildDocxContent(extractedText: string): ContentBlock {
  return {
    type: 'text',
    text: `[文档内容]\n${extractedText}`,
  };
}
```

---

### 4.9 财务统计模块 (Admin API 集成)

> **来源**:
> - [Get Messages Usage Report](https://docs.anthropic.com/en/api/admin-api/usage-cost/get-messages-usage-report)
> - [Get Cost Report](https://docs.anthropic.com/en/api/admin-api/usage-cost/get-cost-report)
> - [Pricing](https://platform.claude.com/docs/en/about-claude/pricing)
> - [claude-cookbooks](https://github.com/anthropics/claude-cookbooks)

**设计目标**:
- 管理员无需登录 Claude Console 即可查看官方使用数据和成本
- 后台财务统计与官方数据 100% 一致
- 支持每日使用报告、成本归属、缓存效率等分析

**Admin API 认证:**
- 需要 Admin API Key (以 `sk-ant-admin...` 开头)
- 只有组织管理员可以在 Claude Console 中生成

**API 端点:**
| 端点 | 用途 |
|------|------|
| `/v1/organizations/usage_report/messages` | Token 使用报告 |
| `/v1/organizations/cost_report` | 成本报告 |

**数据更新频率:**
- 数据通常在 API 请求完成后 5 分钟内可用
- 建议轮询频率: 每分钟 1 次

```typescript
// packages/api/src/services/adminReports.ts

/**
 * Claude Admin API 报告服务
 * @see https://docs.anthropic.com/en/api/admin-api/usage-cost/get-messages-usage-report
 * @see https://docs.anthropic.com/en/api/admin-api/usage-cost/get-cost-report
 */

const ADMIN_API_BASE = 'https://api.anthropic.com/v1/organizations';

interface UsageReportParams {
  starting_at: string;      // RFC 3339 时间戳
  ending_at: string;        // RFC 3339 时间戳
  bucket_width?: '1m' | '1h' | '1d';  // 时间粒度
  limit?: number;           // 最大返回数量
  group_by?: Array<'api_key_id' | 'workspace_id' | 'model' | 'service_tier' | 'context_window'>;
  api_key_id?: string[];    // 按 API Key 过滤
}

interface CostReportParams {
  starting_at: string;
  ending_at: string;
  bucket_width?: '1m' | '1h' | '1d';
  limit?: number;
  group_by?: Array<'workspace_id' | 'description'>;
}

// Usage Report 响应类型
interface UsageReportItem {
  start_time: string;
  end_time: string;
  items: Array<{
    model: string;
    service_tier: string;
    context_window: string;
    workspace_id?: string;
    api_key_id?: string;
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
    web_search_count?: number;
  }>;
}

// Cost Report 响应类型
interface CostReportItem {
  start_time: string;
  end_time: string;
  items: Array<{
    amount: string;         // 美分 (如 "123.45" = $1.23)
    currency: 'USD';
    description?: string;
    model?: string;
    service_tier?: string;
    workspace_id?: string;
  }>;
}

/**
 * 获取 Token 使用报告
 */
export async function getMessagesUsageReport(
  params: UsageReportParams
): Promise<UsageReportItem[]> {
  const searchParams = new URLSearchParams();
  searchParams.set('starting_at', params.starting_at);
  searchParams.set('ending_at', params.ending_at);
  if (params.bucket_width) searchParams.set('bucket_width', params.bucket_width);
  if (params.limit) searchParams.set('limit', params.limit.toString());
  if (params.group_by) {
    params.group_by.forEach(g => searchParams.append('group_by[]', g));
  }
  if (params.api_key_id) {
    params.api_key_id.forEach(id => searchParams.append('api_key_id', id));
  }

  const response = await fetch(
    `${ADMIN_API_BASE}/usage_report/messages?${searchParams}`,
    {
      headers: {
        'x-api-key': process.env.ANTHROPIC_ADMIN_API_KEY!,
        'anthropic-version': '2023-06-01',
      },
    }
  );

  if (!response.ok) {
    throw new Error(`Usage Report API 错误: ${response.status}`);
  }

  const data = await response.json();
  return data.data;
}

/**
 * 获取成本报告
 */
export async function getCostReport(
  params: CostReportParams
): Promise<CostReportItem[]> {
  const searchParams = new URLSearchParams();
  searchParams.set('starting_at', params.starting_at);
  searchParams.set('ending_at', params.ending_at);
  if (params.bucket_width) searchParams.set('bucket_width', params.bucket_width);
  if (params.limit) searchParams.set('limit', params.limit.toString());
  if (params.group_by) {
    params.group_by.forEach(g => searchParams.append('group_by[]', g));
  }

  const response = await fetch(
    `${ADMIN_API_BASE}/cost_report?${searchParams}`,
    {
      headers: {
        'x-api-key': process.env.ANTHROPIC_ADMIN_API_KEY!,
        'anthropic-version': '2023-06-01',
      },
    }
  );

  if (!response.ok) {
    throw new Error(`Cost Report API 错误: ${response.status}`);
  }

  const data = await response.json();
  return data.data;
}

/**
 * 每日使用情况报告 (Dashboard 用)
 * @see claude-cookbooks: 每日使用情况报告
 */
export async function getDailyUsageSummary(date: Date): Promise<DailyUsageSummary> {
  const startOfDay = new Date(date);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(date);
  endOfDay.setHours(23, 59, 59, 999);

  const [usageData, costData] = await Promise.all([
    getMessagesUsageReport({
      starting_at: startOfDay.toISOString(),
      ending_at: endOfDay.toISOString(),
      bucket_width: '1d',
      group_by: ['model', 'service_tier'],
    }),
    getCostReport({
      starting_at: startOfDay.toISOString(),
      ending_at: endOfDay.toISOString(),
      bucket_width: '1d',
      group_by: ['description'],
    }),
  ]);

  // 汇总数据
  const summary: DailyUsageSummary = {
    date: date.toISOString().split('T')[0],
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheCreationTokens: 0,
    totalWebSearches: 0,
    totalCostUSD: 0,
    byModel: {},
  };

  // 处理使用数据
  for (const bucket of usageData) {
    for (const item of bucket.items) {
      summary.totalInputTokens += item.input_tokens;
      summary.totalOutputTokens += item.output_tokens;
      summary.totalCacheReadTokens += item.cache_read_input_tokens;
      summary.totalCacheCreationTokens += item.cache_creation_input_tokens;
      summary.totalWebSearches += item.web_search_count || 0;

      if (!summary.byModel[item.model]) {
        summary.byModel[item.model] = {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        };
      }
      summary.byModel[item.model].inputTokens += item.input_tokens;
      summary.byModel[item.model].outputTokens += item.output_tokens;
      summary.byModel[item.model].cacheReadTokens += item.cache_read_input_tokens;
      summary.byModel[item.model].cacheCreationTokens += item.cache_creation_input_tokens;
    }
  }

  // 处理成本数据 (美分转美元)
  for (const bucket of costData) {
    for (const item of bucket.items) {
      summary.totalCostUSD += parseFloat(item.amount) / 100;
    }
  }

  return summary;
}

/**
 * 缓存效率分析
 * @see claude-cookbooks: 缓存效率
 */
export function calculateCacheEfficiency(usage: UsageReportItem[]): CacheEfficiencyMetrics {
  let totalCacheableTokens = 0;
  let totalCacheHitTokens = 0;
  let totalCacheCreationTokens = 0;

  for (const bucket of usage) {
    for (const item of bucket.items) {
      // 可缓存 Token = 输入 + 缓存读取 + 缓存创建
      totalCacheableTokens += item.input_tokens + item.cache_read_input_tokens;
      totalCacheHitTokens += item.cache_read_input_tokens;
      totalCacheCreationTokens += item.cache_creation_input_tokens;
    }
  }

  const hitRate = totalCacheableTokens > 0
    ? (totalCacheHitTokens / totalCacheableTokens) * 100
    : 0;

  // 节省计算 (缓存读取是 0.1x 价格)
  const savingsRate = hitRate * 0.9; // 90% 折扣 × 命中率

  return {
    cacheHitRate: hitRate.toFixed(2) + '%',
    cacheHitTokens: totalCacheHitTokens,
    cacheCreationTokens: totalCacheCreationTokens,
    estimatedSavings: savingsRate.toFixed(2) + '%',
  };
}

// TypeScript 类型
interface DailyUsageSummary {
  date: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  totalWebSearches: number;
  totalCostUSD: number;
  byModel: Record<string, {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
  }>;
}

interface CacheEfficiencyMetrics {
  cacheHitRate: string;
  cacheHitTokens: number;
  cacheCreationTokens: number;
  estimatedSavings: string;
}
```

**数据库表 (存储同步的官方数据):**

```sql
-- 官方使用报告快照 (每日同步)
CREATE TABLE claude_usage_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_date DATE NOT NULL,
  bucket_width TEXT NOT NULL DEFAULT '1d',
  model TEXT NOT NULL,
  service_tier TEXT,
  input_tokens BIGINT NOT NULL,
  output_tokens BIGINT NOT NULL,
  cache_read_tokens BIGINT DEFAULT 0,
  cache_creation_tokens BIGINT DEFAULT 0,
  web_search_count INTEGER DEFAULT 0,
  synced_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(report_date, model, service_tier)
);

-- 官方成本报告快照 (每日同步)
CREATE TABLE claude_cost_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_date DATE NOT NULL,
  description TEXT,
  model TEXT,
  amount_cents DECIMAL(12, 2) NOT NULL,  -- 美分
  currency TEXT DEFAULT 'USD',
  synced_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(report_date, description, model)
);

-- 财务对账差异记录
CREATE TABLE billing_reconciliation (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reconcile_date DATE NOT NULL,
  local_cost_usd DECIMAL(12, 6) NOT NULL,    -- 本地计算成本
  official_cost_usd DECIMAL(12, 6) NOT NULL, -- 官方成本
  difference_usd DECIMAL(12, 6) NOT NULL,    -- 差异
  difference_pct DECIMAL(5, 2) NOT NULL,     -- 差异百分比
  status TEXT DEFAULT 'pending',             -- pending/reviewed/resolved
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 索引优化
CREATE INDEX idx_usage_snapshots_date ON claude_usage_snapshots(report_date);
CREATE INDEX idx_cost_snapshots_date ON claude_cost_snapshots(report_date);
CREATE INDEX idx_reconciliation_date ON billing_reconciliation(reconcile_date);
```

**定时任务 (每日同步):**

```typescript
// packages/api/src/jobs/syncOfficialReports.ts

/**
 * 每日同步官方报告
 * 建议执行时间: 每天 UTC 01:00 (数据延迟 ~5 分钟)
 */
export async function syncDailyOfficialReports() {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  yesterday.setHours(0, 0, 0, 0);

  const endOfYesterday = new Date(yesterday);
  endOfYesterday.setHours(23, 59, 59, 999);

  // 1. 同步使用报告
  const usageData = await getMessagesUsageReport({
    starting_at: yesterday.toISOString(),
    ending_at: endOfYesterday.toISOString(),
    bucket_width: '1d',
    group_by: ['model', 'service_tier'],
  });

  for (const bucket of usageData) {
    for (const item of bucket.items) {
      await db.insert(claudeUsageSnapshots).values({
        reportDate: yesterday.toISOString().split('T')[0],
        bucketWidth: '1d',
        model: item.model,
        serviceTier: item.service_tier,
        inputTokens: item.input_tokens,
        outputTokens: item.output_tokens,
        cacheReadTokens: item.cache_read_input_tokens,
        cacheCreationTokens: item.cache_creation_input_tokens,
        webSearchCount: item.web_search_count || 0,
      }).onConflictDoUpdate({
        target: [claudeUsageSnapshots.reportDate, claudeUsageSnapshots.model, claudeUsageSnapshots.serviceTier],
        set: {
          inputTokens: item.input_tokens,
          outputTokens: item.output_tokens,
          cacheReadTokens: item.cache_read_input_tokens,
          cacheCreationTokens: item.cache_creation_input_tokens,
          webSearchCount: item.web_search_count || 0,
          syncedAt: new Date(),
        },
      });
    }
  }

  // 2. 同步成本报告
  const costData = await getCostReport({
    starting_at: yesterday.toISOString(),
    ending_at: endOfYesterday.toISOString(),
    bucket_width: '1d',
    group_by: ['description'],
  });

  for (const bucket of costData) {
    for (const item of bucket.items) {
      await db.insert(claudeCostSnapshots).values({
        reportDate: yesterday.toISOString().split('T')[0],
        description: item.description,
        model: item.model,
        amountCents: parseFloat(item.amount),
        currency: item.currency,
      }).onConflictDoUpdate({
        target: [claudeCostSnapshots.reportDate, claudeCostSnapshots.description, claudeCostSnapshots.model],
        set: {
          amountCents: parseFloat(item.amount),
          syncedAt: new Date(),
        },
      });
    }
  }

  // 3. 执行对账
  await reconcileDailyCosts(yesterday);
}

/**
 * 对账: 比较本地计费与官方成本
 */
async function reconcileDailyCosts(date: Date) {
  const dateStr = date.toISOString().split('T')[0];

  // 获取本地计算的成本
  const localCosts = await db
    .select({ total: sql<number>`SUM(total_cost_usd)` })
    .from(tokenStats)
    .where(sql`DATE(created_at) = ${dateStr}`);

  // 获取官方成本
  const officialCosts = await db
    .select({ total: sql<number>`SUM(amount_cents)` })
    .from(claudeCostSnapshots)
    .where(eq(claudeCostSnapshots.reportDate, dateStr));

  const localCostUSD = localCosts[0]?.total || 0;
  const officialCostUSD = (officialCosts[0]?.total || 0) / 100;
  const difference = Math.abs(localCostUSD - officialCostUSD);
  const differencePct = officialCostUSD > 0 ? (difference / officialCostUSD) * 100 : 0;

  // 差异超过 1% 时记录
  if (differencePct > 1) {
    await db.insert(billingReconciliation).values({
      reconcileDate: dateStr,
      localCostUsd: localCostUSD,
      officialCostUsd: officialCostUSD,
      differenceUsd: difference,
      differencePct: differencePct,
      status: 'pending',
    });
  }
}
```

---

## 五、实施优先级

| 优先级 | 模块 | 预估工作量 | 依赖 | 官方文档 |
|--------|------|-----------|------|----------|
| **P0** | AI 模型调用 (callAIModel) | 3-4h | 无 | [Vision](https://platform.claude.com/docs/en/build-with-claude/vision) |
| **P0** | 流式响应 API | 2-3h | P0-1 | [Streaming](https://platform.claude.com/docs/en/build-with-claude/streaming) |
| **P0** | 计费事务 (atomicBilling) | 2h | P0-1 | [Usage Cost API](https://platform.claude.com/docs/en/build-with-claude/usage-cost-api) |
| **P0** | 文件上传 (图片/PDF) | 3h | P0-1 | [PDF Support](https://platform.claude.com/docs/en/build-with-claude/pdf-support), [Vision](https://platform.claude.com/docs/en/build-with-claude/vision) |
| **P1** | Token 计数集成 | 1h | P0 完成 | [Token Counting](https://platform.claude.com/docs/en/build-with-claude/token-counting) |
| **P1** | Prompt Caching 集成 | 2h | P0 完成 | [Prompt Caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) |
| **P1** | 上下文管理与压缩 | 3h | P1 完成 | - |
| **P1** | 财务统计模块 (Admin API) | 4h | P0 完成 | [Usage Report](https://docs.anthropic.com/en/api/admin-api/usage-cost/get-messages-usage-report), [Cost Report](https://docs.anthropic.com/en/api/admin-api/usage-cost/get-cost-report) |
| **P2** | Web 搜索集成 | 2h | P0 完成 | [Web Search Tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool) |
| **P2** | Web Fetch 集成 | 2h | P0 完成 | [Web Fetch Tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-fetch-tool) |
| **P2** | 智能路由 (内联版) | 1h | P0 完成 | - |
| **P3** | Token 预算管理 | 1h | P1 完成 | - |
| **P3** | DOC/DOCX 文件支持 | 2h | P0 完成 | 服务端文本提取 |

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
| Token 估算 | `chars/4` 硬编码 | 官方 `count_tokens` API | [Token Counting](https://platform.claude.com/docs/en/build-with-claude/token-counting) |
| 缓存最小 Token | 1024 固定 | Sonnet 1024, Haiku 2048 | [Prompt Caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) |
| 缓存定价 | 90% 折扣 | 读取 0.1x, 写入 1.25x | [Prompt Caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) |
| 搜索费用 | 5 积分固定 | $10/1000 次 | [Web Search Tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool) |
| 流式事件 | 简化描述 | 完整 SSE 事件类型 | [Streaming](https://platform.claude.com/docs/en/build-with-claude/streaming) |
| Web 搜索 | 模糊描述 | 官方工具定义 + Beta Header | [Web Search Tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool) |
| Vision | 未涉及 | media_type 匹配规则 | [Vision](https://platform.claude.com/docs/en/build-with-claude/vision) |

---

## 九、v1.2 修订说明

| 修订项 | v1.1 状态 | v1.2 更新 | 依据 |
|--------|----------|----------|------|
| Web Fetch Tool | 未涉及 | 新增 4.7 节 - 网页获取工具设计 | [Web Fetch Tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-fetch-tool) |
| 文件上传 | 仅图片 Vision | 新增 4.8 节 - PDF/DOC/图片完整支持 | [PDF Support](https://platform.claude.com/docs/en/build-with-claude/pdf-support) |
| 财务统计 | 仅本地计费 | 新增 4.9 节 - Admin API 集成 | [Usage Report](https://docs.anthropic.com/en/api/admin-api/usage-cost/get-messages-usage-report), [Cost Report](https://docs.anthropic.com/en/api/admin-api/usage-cost/get-cost-report) |
| 官方数据同步 | 无 | 新增每日同步定时任务 + 对账机制 | [claude-cookbooks](https://github.com/anthropics/claude-cookbooks) |
| 数据库表 | 3 个表 | 新增 3 个表: `claude_usage_snapshots`, `claude_cost_snapshots`, `billing_reconciliation` | - |
| 实施优先级 | 9 项 | 新增 4 项: 文件上传(P0), 财务统计(P1), Web Fetch(P2), DOC支持(P3) | - |

### v1.2 新增功能清单

1. **Web Fetch Tool (4.7)**
   - Beta Header: `web-fetch-2025-09-10`
   - 工具类型: `web_fetch_20250910`
   - 安全配置: `allowed_domains`, `max_uses`
   - 与 Web Search 组合使用

2. **文件上传支持 (4.8)**
   - 图片: JPEG, PNG, GIF, WebP (media_type 验证)
   - PDF: 32MB/100页限制, 1,500-3,000 tokens/页
   - DOC/DOCX: 服务端文本提取 (mammoth)
   - 与 Claude 官方体验一致

3. **财务统计模块 (4.9)**
   - Admin API Key 认证 (`sk-ant-admin...`)
   - Messages Usage Report: Token 消耗明细
   - Cost Report: 成本明细 (美分)
   - 每日同步 + 自动对账
   - 缓存效率分析

---

**下一步**: 待确认后，进入第二阶段「核心模块实现」。
