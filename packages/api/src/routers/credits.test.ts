import { describe, expect, it } from 'vitest';
import { checkIdempotency } from './credits';

describe('checkIdempotency', () => {
  it('returns an existing transaction when the idempotency key is already recorded', async () => {
    const supabase = {
      from(table: string) {
        expect(table).toBe('credit_transactions');
        return {
          select(selection: string) {
            expect(selection).toBe('id');
            return this;
          },
          eq(column: string, value: string) {
            expect(['user_id', 'idempotency_key']).toContain(column);
            if (column === 'user_id') {
              expect(value).toBe('user-1');
            }
            if (column === 'idempotency_key') {
              expect(value).toBe('idem-1');
            }
            return this;
          },
          maybeSingle() {
            return Promise.resolve({
              data: { id: 'txn-1' },
              error: null,
            });
          },
        };
      },
    };

    await expect(checkIdempotency(supabase, 'user-1', 'idem-1')).resolves.toEqual({
      exists: true,
      transactionId: 'txn-1',
    });
  });

  it('returns exists false when no transaction is recorded for the idempotency key', async () => {
    const supabase = {
      from() {
        return {
          select() {
            return this;
          },
          eq() {
            return this;
          },
          maybeSingle() {
            return Promise.resolve({
              data: null,
              error: null,
            });
          },
        };
      },
    };

    await expect(checkIdempotency(supabase, 'user-1', 'idem-miss')).resolves.toEqual({
      exists: false,
    });
  });
});
