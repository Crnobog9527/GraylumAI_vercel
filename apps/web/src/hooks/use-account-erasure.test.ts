import { describe, expect, it, vi } from 'vitest';

vi.mock('@/trpc/client', () => ({ trpc: {} }));
vi.mock('@/lib/supabase', () => ({ createClient: vi.fn() }));

import { settledPreview } from './use-account-erasure';

const facts = { credits: 1, subscriptionRenewing: false, subscriptionActiveUntil: null, pendingPayments: 0, runsInFlight: 0, closed: false };

describe('settledPreview', () => {
  it('uses only the facts of a finished, successful fetch', () => {
    expect(settledPreview({ data: facts, isFetching: false, error: null })).toBe(facts);
    expect(settledPreview({ data: facts, isFetching: true, error: null })).toBeUndefined();
    expect(settledPreview({ data: facts, isFetching: false, error: new Error('x') })).toBeUndefined();
    expect(settledPreview({ data: undefined, isFetching: true, error: null })).toBeUndefined();
  });
});
