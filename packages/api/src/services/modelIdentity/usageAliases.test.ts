/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { resolveModelUsageAliases, withRealModelUsed } from './usageAliases';
import { buildModelDistributionFromRows } from '../costReport';
import { estimateCacheSavings } from '../performanceCostReport';

const A = 'm_0123456789abcdef', B = 'm_fedcba9876543210';
function admin(map: Record<string, string>, fail = false) {
  const reads: string[][] = [];
  return { reads, db: { from(table: string) {
    expect(table).toBe('model_usage_aliases');
    return { select: () => ({ in: async (_c: string, values: string[]) => {
      reads.push(values);
      return fail ? { data: null, error: { code: 'XX000' } }
        : { data: values.filter(v => v in map).map(alias => ({ alias, model: map[alias] })), error: null };
    } }) };
  } } as never };
}

it('maps aliases back to real models and leaves pre-0217 strings untouched', async () => {
  const f = admin({ [A]: 'anthropic/claude-x', [B]: 'bill2.aggregate' });
  const rows = [{ model_used: A, n: 1 }, { model_used: B, n: 2 }, { model_used: 'openai/legacy', n: 3 }, { model_used: null, n: 4 }];
  expect(await withRealModelUsed(f.db, rows)).toEqual([
    { model_used: 'anthropic/claude-x', n: 1 }, { model_used: 'bill2.aggregate', n: 2 },
    { model_used: 'openai/legacy', n: 3 }, { model_used: null, n: 4 },
  ]);
  expect(f.reads).toEqual([[A, B]]);
});

it('does not query when there are no aliases and fails loudly when the map cannot be read', async () => {
  const none = admin({});
  expect(await withRealModelUsed(none.db, [{ model_used: 'openai/legacy' }])).toEqual([{ model_used: 'openai/legacy' }]);
  expect(none.reads).toEqual([]);
  await expect(withRealModelUsed(admin({}, true).db, [{ model_used: A }])).rejects.toThrow('MODEL_USAGE_ALIASES_UNAVAILABLE');
});

it('reads large sets in chunks', async () => {
  const many = Array.from({ length: 450 }, (_, i) => 'm_' + i.toString(16).padStart(16, '0'));
  const f = admin(Object.fromEntries(many.map(a => [a, 'model/' + a])));
  const map = await resolveModelUsageAliases(f.db, many);
  expect(map.size).toBe(450);
  expect(f.reads.map(r => r.length)).toEqual([200, 200, 50]);
});

it('admin cost reports give the same result after aliasing as with the real strings', async () => {
  const f = admin({ [A]: 'openai/example', [B]: 'bill2.aggregate' });
  const real = [
    { model_used: 'openai/example', total_credits: 3, total_cost_usd: '0.003', cached_tokens: 100 },
    { model_used: 'bill2.aggregate', total_credits: 2, total_cost_usd: '0.002', cached_tokens: null },
  ];
  const aliased = [{ ...real[0], model_used: A }, { ...real[1], model_used: B }];
  const resolved = await withRealModelUsed(f.db, aliased);
  expect(buildModelDistributionFromRows(resolved as never, 'credits')).toEqual(buildModelDistributionFromRows(real as never, 'credits'));
  const priced = [{ model_id: 'openai/example', input_token_cost: 2000000, config: { pricing: { cacheReadPer1M: '0.25' } } }];
  expect(estimateCacheSavings(resolved as never, priced as never)).toEqual(estimateCacheSavings(real as never, priced as never));
});

it('restores aliased values anywhere in metadata for admin views (routing reasons, counters)', async () => {
  const f = admin({ [A]: 'gemini_count_tokens', [B]: 'Gemini 适合长上下文' });
  const [row] = await withRealModelUsed(f.db, [{ model_used: 'openai/legacy', metadata: {
    count_method: A, routingReason: B, routing_decision: { reasonCodes: [B, 'plain'] }, search_evidence: { q: 'x' },
  } }]);
  expect(row.metadata).toEqual({ count_method: 'gemini_count_tokens', routingReason: 'Gemini 适合长上下文',
    routing_decision: { reasonCodes: ['Gemini 适合长上下文', 'plain'] }, search_evidence: { q: 'x' } });
});
