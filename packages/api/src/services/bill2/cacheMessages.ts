/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {z} from 'zod';
const cachedText = z.object({type: z.literal('text'), text: z.string().min(1),
  cache_control: z.object({type: z.literal('ephemeral')}).strict()}).strict();
export const cachedSystemContent = z.tuple([
  cachedText, z.object({type: z.literal('text'), text: z.string().min(1)}).strict().optional(),
]);
const cachedHistory = z.object({role: z.enum(['user', 'assistant']), content: z.tuple([cachedText])}).strict();
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Independent adapter boundary. Tool schemas/pairing remain validated by the
 * caller; this only grants the single additional cached message position. */
export function historyCacheIndex(messages: unknown[], eligible: boolean): number {
  if (!eligible) return -1;
  const first = object(messages[0]), last = object(messages.at(-1));
  if (first.role !== 'system' || !cachedSystemContent.safeParse(first.content).success ||
      last.role !== 'user' || typeof last.content !== 'string') return -1;
  for (let index = messages.length - 2; index > 0; index--) {
    const message = object(messages[index]);
    if (cachedHistory.safeParse(message).success) return index;
    // Only paired tool messages may be skipped, not another plain text turn.
    if (message.role === 'tool' || message.role === 'assistant' && Array.isArray(message.tool_calls)) continue;
    return -1;
  }
  return -1;
}
