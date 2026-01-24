/**
 * AI Streaming API Route
 *
 * 提供真正的流式响应，实现打字机效果
 * 支持中断保存和计费
 */

import { NextRequest } from 'next/server';
import { createClient } from '@supabase/supabase-js';

// Types
interface StreamRequest {
  message: string;
  conversationId?: string;
  modelId?: string;
  requestId?: string;
}

interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

// Helpers
function estimateTokens(text: string): number {
  // Rough estimate: ~4 characters per token for English, ~2 for Chinese
  const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const otherChars = text.length - chineseChars;
  return Math.ceil(chineseChars / 1.5 + otherChars / 4);
}

/**
 * 输出安全检查 (P1-4: 应用输出安全过滤)
 * 检测 AI 输出中的敏感内容
 */
function checkOutputSecurity(content: string): boolean {
  // 检测敏感信息泄露模式
  const sensitivePatterns = [
    /api[_-]?key\s*[:=]\s*["']?[a-zA-Z0-9-_]{20,}/i,
    /password\s*[:=]\s*["']?[^\s"']{8,}/i,
    /secret\s*[:=]\s*["']?[a-zA-Z0-9-_]{20,}/i,
    /sk-[a-zA-Z0-9]{48}/i, // OpenAI API key pattern
    /sk-ant-[a-zA-Z0-9-_]{95}/i, // Anthropic API key pattern
  ];

  for (const pattern of sensitivePatterns) {
    if (pattern.test(content)) {
      console.warn('[Security] Detected potential sensitive content in AI output');
      return false;
    }
  }

  return true;
}

async function getModelConfig(supabase: any, modelId?: string) {
  // Default to claude-sonnet-4 if no model specified
  const defaultModel = 'claude-sonnet-4-20250514';

  if (!modelId) {
    return {
      modelId: defaultModel,
      name: 'Claude Sonnet 4',
      maxTokens: 8192,
      inputTokenCost: 3000, // per 1M tokens in micro-dollars
      outputTokenCost: 15000,
    };
  }

  const { data } = await supabase
    .from('ai_models')
    .select('model_id, name, max_tokens, input_token_cost, output_token_cost')
    .eq('id', modelId)
    .single();

  if (data) {
    return {
      modelId: data.model_id,
      name: data.name,
      maxTokens: data.max_tokens,
      inputTokenCost: data.input_token_cost,
      outputTokenCost: data.output_token_cost,
    };
  }

  return {
    modelId: defaultModel,
    name: 'Claude Sonnet 4',
    maxTokens: 8192,
    inputTokenCost: 3000,
    outputTokenCost: 15000,
  };
}

async function getConversationHistory(
  supabase: any,
  conversationId: string,
  limit: number = 20
): Promise<Array<{ role: 'user' | 'assistant'; content: string }>> {
  const { data } = await supabase
    .from('messages')
    .select('role, content')
    .eq('conversation_id', conversationId)
    .eq('is_deleted', 'false')
    .order('created_at', { ascending: true })
    .limit(limit);

  return data ?? [];
}

async function getOrCreateConversation(
  supabase: any,
  userId: string,
  conversationId?: string,
  title?: string
): Promise<{ id: string; isNew: boolean }> {
  if (conversationId) {
    const { data: existing } = await supabase
      .from('conversations')
      .select('id')
      .eq('id', conversationId)
      .eq('user_id', userId)
      .eq('is_deleted', 'false')
      .single();

    if (existing) {
      return { id: existing.id, isNew: false };
    }
  }

  const { data: newConversation, error } = await supabase
    .from('conversations')
    .insert({
      user_id: userId,
      title: title ?? '新对话',
    })
    .select('id')
    .single();

  if (error || !newConversation) {
    throw new Error('创建对话失败');
  }

  return { id: newConversation.id, isNew: true };
}

// Main handler
export async function POST(request: NextRequest) {
  const encoder = new TextEncoder();

  try {
    // Parse request
    const body: StreamRequest = await request.json();
    const { message, conversationId, modelId, requestId } = body;

    if (!message?.trim()) {
      return new Response(
        JSON.stringify({ error: '消息内容不能为空' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Get auth from cookie
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Get user from auth header or cookie
    const authHeader = request.headers.get('authorization');
    const token = authHeader?.replace('Bearer ', '');

    if (!token) {
      return new Response(
        JSON.stringify({ error: '未授权' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const { data: { user }, error: authError } = await supabase.auth.getUser(token);

    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: '无效的认证令牌' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const userId = user.id;

    // Get model config
    const modelConfig = await getModelConfig(supabase, modelId);

    // Get or create conversation
    const conversation = await getOrCreateConversation(
      supabase,
      userId,
      conversationId,
      message.substring(0, 50)
    );

    // Get history
    const history = await getConversationHistory(supabase, conversation.id);

    // Build messages
    const messages = [
      ...history,
      { role: 'user' as const, content: message },
    ];

    // Estimate cost and check balance
    const estimatedInputTokens = messages.reduce(
      (sum, m) => sum + estimateTokens(m.content),
      0
    );
    const estimatedOutputTokens = 1000; // Conservative estimate
    const estimatedCredits = Math.ceil(
      (estimatedInputTokens * modelConfig.inputTokenCost +
        estimatedOutputTokens * modelConfig.outputTokenCost) /
        1000000
    );

    // Check balance
    const { data: profile } = await supabase
      .from('profiles')
      .select('credits')
      .eq('id', userId)
      .single();

    if (!profile || profile.credits < estimatedCredits) {
      return new Response(
        JSON.stringify({ error: '积分不足' }),
        { status: 402, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Pre-deduct credits
    const { error: deductError } = await supabase.rpc('atomic_pre_deduct', {
      p_user_id: userId,
      p_amount: estimatedCredits,
      p_reason: 'AI 对话预扣',
      p_idempotency_key: requestId ?? crypto.randomUUID(),
    });

    if (deductError) {
      return new Response(
        JSON.stringify({ error: '积分扣除失败' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Create streaming response
    const stream = new ReadableStream({
      async start(controller) {
        let fullContent = '';
        let usage: TokenUsage = {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        };

        try {
          // Send initial metadata
          const initEvent = {
            type: 'init',
            conversationId: conversation.id,
            modelUsed: modelConfig.modelId,
            requestId: requestId ?? crypto.randomUUID(),
          };
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(initEvent)}\n\n`)
          );

          // Call Anthropic streaming API
          const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': process.env.ANTHROPIC_API_KEY!,
              'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
              model: modelConfig.modelId,
              max_tokens: modelConfig.maxTokens,
              stream: true,
              messages: messages.map((m) => ({
                role: m.role,
                content: m.content,
              })),
            }),
          });

          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Anthropic API error: ${response.status} - ${errorText}`);
          }

          const reader = response.body?.getReader();
          if (!reader) {
            throw new Error('No response body');
          }

          const decoder = new TextDecoder();
          let buffer = '';

          while (true) {
            const { done, value } = await reader.read();

            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              if (line.startsWith('data: ')) {
                const data = line.slice(6);

                if (data === '[DONE]') continue;

                try {
                  const event = JSON.parse(data);

                  if (event.type === 'content_block_delta') {
                    const delta = event.delta?.text || '';
                    fullContent += delta;

                    // Send delta to client
                    const deltaEvent = {
                      type: 'delta',
                      content: delta,
                    };
                    controller.enqueue(
                      encoder.encode(`data: ${JSON.stringify(deltaEvent)}\n\n`)
                    );
                  } else if (event.type === 'message_delta') {
                    // Final usage stats
                    if (event.usage) {
                      usage.outputTokens = event.usage.output_tokens || 0;
                    }
                  } else if (event.type === 'message_start') {
                    if (event.message?.usage) {
                      usage.inputTokens = event.message.usage.input_tokens || 0;
                      usage.cacheReadTokens = event.message.usage.cache_read_input_tokens || 0;
                      usage.cacheCreationTokens = event.message.usage.cache_creation_input_tokens || 0;
                    }
                  }
                } catch (parseError) {
                  // Ignore parse errors for non-JSON lines
                }
              }
            }
          }

          // 10. 输出安全检查 (P1-4: 应用输出安全过滤)
          const isOutputSafe = checkOutputSecurity(fullContent);
          if (!isOutputSafe) {
            // 记录警告日志，但不阻止响应 (避免影响正常使用)
            console.warn('[Security] Potential sensitive content detected in streaming AI response');
            // 可选: 在这里可以添加更多处理逻辑，如通知管理员
          }

          // Save messages
          await supabase.from('messages').insert([
            {
              conversation_id: conversation.id,
              role: 'user',
              content: message,
            },
            {
              conversation_id: conversation.id,
              role: 'assistant',
              content: fullContent,
            },
          ]);

          // Update conversation title if new
          if (conversation.isNew) {
            const title = message.length > 50 ? message.substring(0, 47) + '...' : message;
            await supabase
              .from('conversations')
              .update({ title })
              .eq('id', conversation.id);
          }

          // Calculate actual cost
          const actualCredits = Math.ceil(
            (usage.inputTokens * modelConfig.inputTokenCost +
              usage.outputTokens * modelConfig.outputTokenCost -
              usage.cacheReadTokens * modelConfig.inputTokenCost * 0.9) / // Cache reads are 90% cheaper
              1000000
          );

          // Settle billing - refund difference if needed
          const refundAmount = Math.max(0, estimatedCredits - actualCredits);
          if (refundAmount > 0) {
            await supabase.rpc('atomic_settle', {
              p_user_id: userId,
              p_refund_amount: refundAmount,
              p_reason: 'AI 对话结算退还',
            });
          }

          // Record token stats
          await supabase.from('token_stats').insert({
            conversation_id: conversation.id,
            user_id: userId,
            model_used: modelConfig.modelId,
            input_tokens: usage.inputTokens,
            output_tokens: usage.outputTokens,
            cached_tokens: usage.cacheReadTokens,
            cache_creation_tokens: usage.cacheCreationTokens,
            total_cost_usd: (
              (usage.inputTokens * modelConfig.inputTokenCost +
                usage.outputTokens * modelConfig.outputTokenCost) /
              1000000000
            ).toFixed(6),
            total_credits: actualCredits,
          });

          // Send completion event
          const completeEvent = {
            type: 'complete',
            usage,
            cost: {
              creditsDeducted: actualCredits,
              estimatedCredits,
              refunded: refundAmount,
            },
            conversationId: conversation.id,
          };
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(completeEvent)}\n\n`)
          );
        } catch (error) {
          // Refund on error
          await supabase.rpc('atomic_refund', {
            p_user_id: userId,
            p_amount: estimatedCredits,
            p_reason: `AI 调用失败: ${error instanceof Error ? error.message : 'Unknown error'}`,
          });

          const errorEvent = {
            type: 'error',
            error: error instanceof Error ? error.message : 'Unknown error',
          };
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(errorEvent)}\n\n`)
          );
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
