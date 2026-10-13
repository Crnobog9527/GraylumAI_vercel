import { describe, expect, it, vi } from 'vitest';

vi.mock('@/trpc/client', () => ({ trpc: {} }));
vi.mock('@/lib/supabase', () => ({ createClient: vi.fn() }));

import { settledPreview } from './use-account-erasure';

const facts = { credits: 1, subscriptionRenewing: false, subscriptionActiveUntil: null, pendingPayments: 0, runsInFlight: 0, closed: false };

describe('settledPreview', () => {
  const opened = 1_000;
  const query = (overrides: Record<string, unknown> = {}) =>
    ({ data: facts, fetchStatus: 'idle' as const, error: null, dataUpdatedAt: 2_000, ...overrides });

  it('uses only facts read successfully during this opening', () => {
    expect(settledPreview(query(), opened)).toBe(facts);
    expect(settledPreview(query({ fetchStatus: 'fetching' }), opened)).toBeUndefined();
    expect(settledPreview(query({ fetchStatus: 'paused' }), opened)).toBeUndefined();
    expect(settledPreview(query({ error: new Error('x') }), opened)).toBeUndefined();
    expect(settledPreview(query({ dataUpdatedAt: 500 }), opened)).toBeUndefined();
  });
});
