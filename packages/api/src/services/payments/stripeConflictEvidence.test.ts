/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { recordStripeInvoiceConflict } from './stripeConflictEvidence';
const scope = { merchant: 'acct_fixture', mode: 'test' as const };
const id = '00000000-0000-4000-8000-000000000001';
function fixture() {
  let metadata: Record<string, unknown> = { grantedCredits: 120 };
  let races = 0;
  let writes = 0;
  let mode = 'test';
  const db = { from(table: string) {
    const filters = new Map<string, unknown>();
    let payload: { metadata: Record<string, unknown> } | undefined;
    const query = {
      select() { return query; }, eq(key: string, value: unknown) { filters.set(key, value); return query; },
      limit: async () => ({ data: [{ order_id: id }], error: null }),
      maybeSingle: async () => ({ data: filters.get('payment_mode') === mode ? { id, metadata } : null, error: null }),
      update(value: { metadata: Record<string, unknown> }) { payload = value; return query; },
      then(resolve: (value: unknown) => unknown) {
        expect(table).toBe('payment_orders');
        if (races-- > 0) metadata = { ...metadata, concurrent: writes + 1 };
        writes++;
        const matched = filters.get('metadata') === JSON.stringify(metadata);
        if (matched && payload) metadata = payload.metadata;
        return Promise.resolve({ data: matched ? [{ id }] : [], error: null }).then(resolve);
      },
    };
    return query;
  } } as unknown as Parameters<typeof recordStripeInvoiceConflict>[0]['db'];
  return { db, read: () => metadata, writes: () => writes, race: (count: number) => { races = count; },
    mode: (value: string) => { mode = value; }, set: (value: Record<string, unknown>) => { metadata = value; } };
}
describe('bounded invoice conflict evidence', () => {
  it('appends once without retaining provider payload or losing fulfillment metadata', async () => {
    const f = fixture();
    await recordStripeInvoiceConflict({ db: f.db, scope, invoiceId: 'in_fixture' });
    await recordStripeInvoiceConflict({ db: f.db, scope, invoiceId: 'in_fixture' });
    expect(f.read()).toEqual({ grantedCredits: 120, paymentConflicts: [
      { evidence_ref: 'in_fixture', reason: 'PAY_COMMON_INVOICE_EVIDENCE_REJECTED' },
    ] });
    expect(f.writes()).toBe(1);
  });
  it('re-reads a concurrent financial write before appending', async () => {
    const f = fixture(); f.race(1);
    await recordStripeInvoiceConflict({ db: f.db, scope, invoiceId: 'in_fixture' });
    expect(f.read()).toMatchObject({ grantedCredits: 120, concurrent: 1 });
    expect(f.writes()).toBe(2);
  });
  it('refuses a scope mismatch without touching another payment', async () => {
    const f = fixture(); f.mode('live');
    await recordStripeInvoiceConflict({ db: f.db, scope, invoiceId: 'in_fixture' });
    expect(f.writes()).toBe(0);
  });
  it('bounds contention and evidence history', async () => {
    const f = fixture(); f.race(4);
    await expect(recordStripeInvoiceConflict({ db: f.db, scope, invoiceId: 'in_fixture' }))
      .rejects.toThrow('PAY_COMMON_CONFLICT_WRITE_RETRY_REQUIRED');
    expect(f.writes()).toBe(3);
    f.set({ paymentConflicts: Array.from({ length: 32 }, (_, n) => ({ evidence_ref: `in_old_${n}` })) });
    await expect(recordStripeInvoiceConflict({ db: f.db, scope, invoiceId: 'in_fixture' }))
      .rejects.toThrow('PAY_COMMON_CONFLICT_LIMIT');
  });
});
