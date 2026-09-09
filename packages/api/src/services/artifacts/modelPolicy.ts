/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import { isOpenRouterEndpoint, resolveOpenAICompatibleEndpoint } from '../providerUtils';
import { inferTokenCountingMetadata } from '../modelCapabilities';

const configuredModel = z.object({
  id: z.string().uuid(), model_id: z.enum(['openai/gpt-4o-2024-08-06','openai/gpt-4o-mini-2024-07-18','qwen/qwen3.8-flash','qwen/qwen3.8-27b','openai/gpt-5.6-luna','anthropic/claude-opus-4.5']),
  is_active: z.literal('true'), max_tokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  input_limit: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  api_key: z.string().trim().min(1), api_endpoint: z.literal('https://openrouter.ai/api/v1/chat/completions'),
  token_counting_supported: z.literal('true'), tokenizer_family: z.literal('openai'),
}).refine(row=>Math.min(row.input_limit,128000)>Math.min(row.max_tokens,4096)+8192,{path:['input_limit'],message:'Insufficient task input space'});

// Use the same effective endpoint and derived metadata as ordinary chat. The
// configured context is provider capacity, not this task's spending allowance.
export const workbenchModelSchema = z.preprocess(value => {
  if (!value || typeof value !== 'object') return value;
  const row = value as Record<string, unknown>;
  const provider = typeof row.provider === 'string' ? row.provider : null;
  const endpoint = resolveOpenAICompatibleEndpoint(provider, typeof row.api_endpoint === 'string' ? row.api_endpoint : null);
  if (!isOpenRouterEndpoint(endpoint ?? '') || typeof row.model_id !== 'string') return row;
  return { ...row, api_endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    ...inferTokenCountingMetadata({provider, modelId:row.model_id, apiEndpoint:endpoint}) };
}, configuredModel);

export function summaryModelOption(row: {id:string;name:string;model_id:string;[key:string]:unknown}) {
  const result = workbenchModelSchema.safeParse(row);
  const messages: Record<string,string> = {
    api_key:'请先配置 API 密钥', api_endpoint:'当前 Skill 需要 OpenRouter 接口',
    is_active:'模型已停用', input_limit:'请设置有效的上下文容量', max_tokens:'请设置有效的输出上限',
    model_id:'此模型尚未适配 Skill 对话与整理，请选择已适配的固定模型', token_counting_supported:'无法确认供应商用量计数', tokenizer_family:'无法确认供应商用量计数',
  };
  const reason = result.success ? null : messages[String(result.error.issues[0]?.path[0])] ?? '模型配置不完整';
  return {id:row.id,name:row.name,model_id:row.model_id,available:result.success,reason};
}

// Provider usage is authoritative for settlement. Reserve the full bounded
// task capacity for models without the existing local tokenizer, as before;
// advertised 800K context does not increase the task's 128K budget boundary.
export function providerInputReservation(model: z.infer<typeof workbenchModelSchema>, messages: Array<{content:string}>, maxTokens:number) {
  if(['openai/gpt-4o-2024-08-06','openai/gpt-4o-mini-2024-07-18'].includes(model.model_id)) return null;
  const capacity=Math.min(model.input_limit,128000)-maxTokens;
  const bytes=messages.reduce((n,m)=>n+new TextEncoder().encode(m.content).length,8192);
  if(capacity<bytes)throw new Error('GENERATION_CAPACITY');
  return capacity;
}
