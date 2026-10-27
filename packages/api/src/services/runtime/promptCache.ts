/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {createHash} from 'node:crypto';
import {z} from 'zod';

const prefixShape = {
  systemPrefixChars: z.number().int().positive().max(262144),
  systemPrefixSha256: z.string().regex(/^[a-f0-9]{64}$/),
};
/**
 * v1: a chosen Skill turn marks only the Skill prefix of the system message.
 * v2: a mentor host turn marks the whole system message and, with historyMarker, the last plain history message.
 * v3 (PROMPT-CACHE-ALL): a free-chat or report turn marks the frozen system prefix (shared by every user with the
 * same catalog, or the Skill text of every report) AND the rest of the system message (per-user addenda, report
 * facts) as a second block, plus the last plain history message. Up to three of Anthropic's four breakpoints.
 */
export const promptCachePolicy = z.discriminatedUnion('version', [
  z.object({version: z.literal('prompt-cache-v1'), ...prefixShape}).strict(),
  // skillPrefixChars (PROMPT-CACHE-ALL): a breakpoint after the brand text and SKILL.md section, which every step of the
  // workflow shares; absent on executions frozen before it, which keep their two-marker bytes.
  z.object({version: z.literal('prompt-cache-v2'), ...prefixShape, historyMarker: z.boolean(),
    skillPrefixChars: z.number().int().positive().optional()}).strict(),
  z.object({version: z.literal('prompt-cache-v3'), ...prefixShape, historyMarker: z.boolean()}).strict(),
]);
export type PromptCachePolicy = z.infer<typeof promptCachePolicy>;
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const cached = (text: string) => ({type: 'text', text, cache_control: {type: 'ephemeral'}});
const blocks = (prefix: string, rest: string, cacheRest = false) => [
  cached(prefix),
  ...(rest ? [cacheRest ? cached(rest) : {type: 'text', text: rest}] : []),
];
// Two blocks are the largest fixed overhead. Text bytes and JSON escaping do
// not change when splitting at the host's newline boundary.
export const PROMPT_CACHE_OVERHEAD_BYTES = Buffer.byteLength(JSON.stringify(blocks('a', 'b'))) -
  Buffer.byteLength(JSON.stringify('ab'));

export const HISTORY_CACHE_OVERHEAD_BYTES = Buffer.byteLength(JSON.stringify(blocks('a', ''))) -
  Buffer.byteLength(JSON.stringify('a'));
export const HISTORY_MARKER_RESERVE_BYTES = PROMPT_CACHE_OVERHEAD_BYTES + HISTORY_CACHE_OVERHEAD_BYTES;
/** v3: two marked system blocks plus the history marker; sized before the history is selected. */
export const PROMPT_CACHE_V3_RESERVE_BYTES = Buffer.byteLength(JSON.stringify(blocks('a', 'b', true))) -
  Buffer.byteLength(JSON.stringify('ab')) + HISTORY_CACHE_OVERHEAD_BYTES;
/** Request bytes a frozen policy may add; a mentor turn reserves these through historySelection instead.
 * `sharedWrite` is the write price of a free-chat turn whose v3 policy is frozen only at the end of admission. */
export function promptCacheReserveBytes(policy: PromptCachePolicy | undefined, sharedWrite?: string): number {
  if (sharedWrite !== undefined || policy?.version === 'prompt-cache-v3') return PROMPT_CACHE_V3_RESERVE_BYTES;
  return policy === undefined ? 0 : PROMPT_CACHE_OVERHEAD_BYTES;
}
/** Anthropic allows four explicit breakpoints; every policy here uses at most three. */
export const MAX_CACHE_MARKERS = 4;

/** Only a trusted Skill admission with an explicit frozen write price opts in. */
export function freezePromptCache(input: {
  real: boolean; role: string; model: string; cacheWriteUsdPerMillion?: string;
  instructions: string; skillChars: number; stableAdditionalPrefix?: string;
}): PromptCachePolicy | undefined {
  if (!input.real || input.role !== 'skill' || !input.model.startsWith('anthropic/') ||
      input.cacheWriteUsdPerMillion === undefined || input.skillChars === 0) return undefined;
  const prefix = input.stableAdditionalPrefix ?? '';
  // Host text can evolve independently of the stable rules. A prepended or
  // changed dynamic section must fall back to the unchanged unmarked request.
  if (prefix && !input.instructions.slice(input.skillChars).startsWith('\n' + prefix)) return undefined;
  const extra = prefix.length;
  const chars = input.skillChars + (extra > 0 ? 1 + extra : 0);
  if (!Number.isSafeInteger(extra) || extra < 0 || chars > input.instructions.length)
    throw new Error('RUNTIME_CONTEXT_INVALID');
  return promptCachePolicy.parse({version: 'prompt-cache-v1', systemPrefixChars: chars,
    systemPrefixSha256: sha256(input.instructions.slice(0, chars))});
}

/**
 * PROMPT-CACHE-ALL: a real free-chat turn (no Skill matching, whose system text changes after admission) or a report
 * marks its frozen system prefix, the rest of the system message and the last plain history message.
 * `prefixChars` is the admission-time system text (free chat) or the brand plus Skill text (report); the executor
 * only appends to it, so the prefix bytes are stable across the user's turns and shared across users.
 */
export function freezeSharedPromptCache(input: {
  real: boolean; model: string; cacheWriteUsdPerMillion?: string; instructions: string; prefixChars: number;
  historyMarker: boolean;
}): PromptCachePolicy | undefined {
  if (!input.real || !input.model.startsWith('anthropic/') || input.cacheWriteUsdPerMillion === undefined ||
      input.prefixChars <= 0) return undefined;
  if (!Number.isSafeInteger(input.prefixChars) || input.prefixChars > input.instructions.length)
    throw new Error('RUNTIME_CONTEXT_INVALID');
  return promptCachePolicy.parse({version: 'prompt-cache-v3', systemPrefixChars: input.prefixChars,
    systemPrefixSha256: sha256(input.instructions.slice(0, input.prefixChars)), historyMarker: input.historyMarker});
}

/**
 * Free chat: frozen at the very end of admission, after research may have appended its instructions, so the prefix
 * equals the executor's `context.instructions` exactly; the executor only appends per-user addenda after it.
 * `write` is undefined for every turn that does not opt in (fixture, non-Anthropic, Skill matching, host turns).
 */
export function freezeSharedCacheInto(context: {model: string; instructions: string; promptCache?: PromptCachePolicy},
  billing: {sourceHash: string}, write: string | undefined): void {
  if (write === undefined || context.promptCache) return;
  const policy = freezeSharedPromptCache({real: true, model: context.model, cacheWriteUsdPerMillion: write,
    instructions: context.instructions, prefixChars: context.instructions.length, historyMarker: true});
  if (!policy) return;
  context.promptCache = policy;
  billing.sourceHash = sha256(JSON.stringify(context));
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
      cache.version === 'prompt-cache-v2' && cache.systemPrefixChars !== first.content.length ||
      sha256(first.content.slice(0, cache.systemPrefixChars)) !== cache.systemPrefixSha256)
    throw new Error('RUNTIME_PROVIDER_BINDING_DENIED');
  const messages = request.messages as Array<Record<string, unknown>>;
  const last = messages.at(-1);
  if (cache.version !== 'prompt-cache-v1' && cache.historyMarker && last?.role === 'user' && typeof last.content === 'string') {
    for (let i = messages.length - 2; i > 0; i--) {
      const message = messages[i]!;
      if ((message.role === 'user' || message.role === 'assistant' && message.tool_calls === undefined) &&
          typeof message.content === 'string' && message.content.length > 0) {
        if (Object.keys(message).some(key => !['role', 'content'].includes(key))) throw new Error('RUNTIME_PROVIDER_BINDING_DENIED');
        message.content = blocks(message.content, '');
        break;
      }
    }
  }
  const skillChars = cache.version === 'prompt-cache-v2' ? cache.skillPrefixChars : undefined;
  if (skillChars !== undefined) {
    if (skillChars >= cache.systemPrefixChars) throw new Error('RUNTIME_PROVIDER_BINDING_DENIED');
    first.content = blocks(first.content.slice(0, skillChars), first.content.slice(skillChars), true);
    return;
  }
  first.content = blocks(first.content.slice(0, cache.systemPrefixChars), first.content.slice(cache.systemPrefixChars),
    cache.version === 'prompt-cache-v3');
}

/** New host structure and caching remain independent; rollback edits affect only
 * future freezes, never the v2 replay implementation above. */
export function freezeHostPromptCache(input: Parameters<typeof freezePromptCache>[0] & {
  mentor: boolean; additionalInstructions?: string; historyMarker: boolean; skillPrefixChars?: number;
}): PromptCachePolicy | undefined {
  if (!input.mentor || input.additionalInstructions === undefined ||
      input.stableAdditionalPrefix !== input.additionalInstructions || !freezePromptCache(input)) return undefined;
  // The SKILL.md breakpoint must end inside the Skill text (brand plus SKILL.md section), never past it.
  const skill = input.skillPrefixChars !== undefined && input.skillPrefixChars > 0 && input.skillPrefixChars < input.skillChars
    ? {skillPrefixChars: input.skillPrefixChars} : {};
  return promptCachePolicy.parse({version: 'prompt-cache-v2', systemPrefixChars: input.instructions.length,
    systemPrefixSha256: sha256(input.instructions), historyMarker: input.historyMarker, ...skill});
}
