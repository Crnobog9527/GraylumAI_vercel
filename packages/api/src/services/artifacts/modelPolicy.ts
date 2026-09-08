/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from "zod";
const uuid=z.string().uuid();
export const workbenchModelSchema = z.object({
  id: uuid, model_id: z.enum(['openai/gpt-4o-2024-08-06', 'openai/gpt-4o-mini-2024-07-18', 'qwen/qwen3.8-flash', 'openai/gpt-5.6-luna']),
  is_active: z.literal('true'), max_tokens: z.number().int().min(1).max(16384),
  input_limit: z.number().int().min(1).max(128000),
  api_key: z.string().min(1), api_endpoint: z.enum(['https://openrouter.ai/api/v1', 'https://openrouter.ai/api/v1/chat/completions']),
  token_counting_supported: z.literal('true'), tokenizer_family: z.enum(['o200k_base','openai']),
});

export function summaryModelOption(row: {id:string;name:string;model_id:string;[key:string]:unknown}) {
 return {id:row.id,name:row.name,model_id:row.model_id,available:workbenchModelSchema.safeParse(row).success};
}

// Provider-usage metadata does not establish an exact local tokenizer.
// For Qwen and Luna, reserve the complete configured
// input capacity; settle only the provider's actual usage. Text admission uses
// a conservative UTF-8 byte envelope and never truncates the prompt.
export function providerInputReservation(model: z.infer<typeof workbenchModelSchema>, messages: Array<{content:string}>, maxTokens:number) {
 if(!['qwen/qwen3.8-flash','openai/gpt-5.6-luna'].includes(model.model_id)) return null;
 const capacity=model.input_limit-maxTokens;
 const bytes=messages.reduce((n,m)=>n+new TextEncoder().encode(m.content).length,8192);
 if(capacity<bytes)throw new Error('GENERATION_CAPACITY');
 return capacity;
}
