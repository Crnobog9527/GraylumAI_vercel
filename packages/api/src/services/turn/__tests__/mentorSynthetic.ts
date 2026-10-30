/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { VendorCalls } from '../../research/runtime/subcall';
import { tikhubRouteId } from '../../research/vendors/tikhub';
import type { MentorDeps } from '../mentor';

export const MENTOR = 'anthropic/claude-sonnet-5.5', ORGANIZER = 'anthropic/claude-opus-5.5';

// The synthetic OpenRouter: the mentor streams (text, or one tool call); the organizer answers one JSON completion.
const frame = (id: string, model: string, extra: Record<string, unknown>) =>
  'data: ' + JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model, ...extra }) + '\n\n';
const usage = (id: string, model: string, finish: string) => frame(id, model, { choices: [{ index: 0, delta: {}, finish_reason: finish }] })
  // A cost inside the call's frozen bound (this fixture's bound is small): above it the model would be blocked (budget_conflict).
  + frame(id, model, { choices: [], usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1, cost: 0.000003 } }) + 'data: [DONE]\n\n';
const streamed = (id: string, body: string) => new Response(body, { headers: { 'content-type': 'text/event-stream', 'x-generation-id': id } });
export const prose = (id: string, text: string) => streamed(id, frame(id, MENTOR, { choices: [{ index: 0, delta: { role: 'assistant', content: text },
  finish_reason: null }] }) + usage(id, MENTOR, 'stop'));
export const toolCall = (id: string, name: string, args: unknown) => streamed(id, frame(id, MENTOR, { choices: [{ index: 0, delta: { role: 'assistant',
  tool_calls: [{ index: 0, id: 'call-' + id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] })
  + usage(id, MENTOR, 'tool_calls'));
export const organized = (id: string, content: string) => new Response(JSON.stringify({ id, object: 'chat.completion', created: 1, model: ORGANIZER,
  choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1, cost: 0.000003 } }),
{ headers: { 'content-type': 'application/json', 'x-generation-id': id } });

type TikhubCall = { platform: string; kind: string; account?: string };
// Synthetic TikTok: a qualifying profile and 25 dated posts per account. `before` runs ahead of each supplier call.
export const tiktokVendors = (before?: (call: TikhubCall) => Promise<void>): NonNullable<MentorDeps['research']> => ({ readKey: async () => 'local-synthetic', vendors: {
  parallel: () => { throw new Error('not used'); }, firecrawl: () => { throw new Error('not used'); },
  tikhub: async (call: TikhubCall) => {
    await before?.(call);
    const base = { vendor: 'tikhub', route: tikhubRouteId(call.platform as never, call.kind as never), outcome: 'ok', reason: null, httpStatus: 200,
      supplierMayCharge: true, usage: { unit: 'call', units: '1' }, truncated: false, fetchedAt: new Date().toISOString() };
    if (call.kind === 'account_profile') return { ...base, items: [{ fields: { followers: 50000, postsCount: 200, nickname: String(call.account) }, missing: [] }] };
    return { ...base, items: Array.from({ length: 25 }, (_, i) => ({ url: `https://example.test/${call.account}/${i}`, missing: [], fields: { id: `${call.account}-${i}`,
      views: 1000 + i, likes: 50, comments: 5, shares: 2, publishedAt: new Date(Date.now() - i * 86400000).toISOString() } })) };
  } } as unknown as VendorCalls });
