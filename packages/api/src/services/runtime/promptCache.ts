/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {createHash} from 'node:crypto';
import {z} from 'zod';

export const promptCachePolicy = z.object({
  version: z.literal('prompt-cache-v1'),
  systemPrefixChars: z.number().int().positive().max(262144),
  systemPrefixSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type PromptCachePolicy = z.infer<typeof promptCachePolicy>;
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const blocks = (prefix: string, rest: string) => [
  {type: 'text', text: prefix, cache_control: {type: 'ephemeral'}},
  ...(rest ? [{type: 'text', text: rest}] : []),
];
// Two blocks are the largest fixed overhead. Text bytes and JSON escaping do
// not change when splitting at the host's newline boundary.
export const PROMPT_CACHE_OVERHEAD_BYTES = Buffer.byteLength(JSON.stringify(blocks('a', 'b'))) -
  Buffer.byteLength(JSON.stringify('ab'));

/** Only a trusted Skill admission with an explicit frozen write price opts in. */
export function freezePromptCache(input: {
  real: boolean; role: string; model: string; cacheWriteUsdPerMillion?: string;
  instructions: string; skillChars: number; stableAdditionalChars?: number;
}): PromptCachePolicy | undefined {
  if (!input.real || input.role !== 'skill' || !input.model.startsWith('anthropic/') ||
      input.cacheWriteUsdPerMillion === undefined || input.skillChars === 0) return undefined;
  const extra = input.stableAdditionalChars ?? 0;
  const chars = input.skillChars + (extra > 0 ? 1 + extra : 0);
  if (!Number.isSafeInteger(extra) || extra < 0 || chars > input.instructions.length)
    throw new Error('RUNTIME_CONTEXT_INVALID');
  return promptCachePolicy.parse({version: 'prompt-cache-v1', systemPrefixChars: chars,
    systemPrefixSha256: sha256(input.instructions.slice(0, chars))});
}

/** Applied before capacity, requestHash and claim; never infer from prompt text. */
export function applyPromptCache(request: {messages?: unknown}, cache: PromptCachePolicy,
  model: string, writePrice: string | undefined): void {
  const parsed = promptCachePolicy.safeParse(cache);
  const first = Array.isArray(request.messages) ? request.messages[0] : undefined;
  if (!parsed.success || !model.startsWith('anthropic/') || writePrice === undefined ||
      !first || typeof first !== 'object' || Array.isArray(first) || first.role !== 'system' ||
      typeof first.content !== 'string' || Object.keys(first).some(key => !['role', 'content'].includes(key)) ||
      cache.systemPrefixChars > first.content.length ||
      sha256(first.content.slice(0, cache.systemPrefixChars)) !== cache.systemPrefixSha256)
    throw new Error('RUNTIME_PROVIDER_BINDING_DENIED');
  first.content = blocks(first.content.slice(0, cache.systemPrefixChars), first.content.slice(cache.systemPrefixChars));
}
