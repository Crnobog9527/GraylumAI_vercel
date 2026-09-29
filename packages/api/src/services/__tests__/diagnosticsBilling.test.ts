import { beforeEach, describe, expect, it, vi } from 'vitest';
import { testBillingPrededuct, testBillingIdempotency, testBillingReconcile } from '../diagnosticsBilling';
const state = vi.hoisted(() => ({ reconcile: vi.fn() }));
vi.mock('../billingReconciliation', () => ({ runDailyBillingReconciliation: state.reconcile }));

function context(error: unknown = null) {
  const limit = vi.fn().mockResolvedValue({ data: [], error });
  const select = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ select }));
  const rpc = vi.fn(() => { throw new Error('Mutating RPC forbidden'); });
  return { ctx: { supabase: { from, rpc }, supabaseAdmin: { from, rpc }, userId: 'real-admin-id' } as any,
    from, select, limit, rpc };
}

describe('read-only billing diagnostics', () => {
  beforeEach(() => vi.clearAllMocks());
  for (const probe of [testBillingPrededuct, testBillingIdempotency]) {
    it(`${probe.name}: no deduction/refund; readable schema is not a billing pass`, async () => {
      const fixture = context();
      expect(await probe(fixture.ctx)).toMatchObject({
        status: 'warning', details: { mode: 'read_only', liveBillingVerified: false },
      });
      expect(fixture.from).toHaveBeenCalledWith('billing_history');
      expect(fixture.limit).toHaveBeenCalledWith(0);
      expect(fixture.rpc).not.toHaveBeenCalled();
    });
    it(`${probe.name}: reports database failure, without leaking internal details`, async () => {
      const fixture = context({ message: 'private database detail' });
      const result = await probe(fixture.ctx);
      expect(result.status).toBe('failed');
      expect(result.message).toContain('只读检查失败');
      expect(JSON.stringify(result)).not.toContain('private database detail');
      expect(fixture.rpc).not.toHaveBeenCalled();
    });
    it(`${probe.name}: reports thrown failures`, async () => {
      const fixture = context();
      fixture.limit.mockRejectedValue(new Error('private detail'));
      expect((await probe(fixture.ctx)).status).toBe('failed');
      expect(fixture.rpc).not.toHaveBeenCalled();
    });
  }
  it.each([
    ['SUCCESS', true, [], 'passed'],
    ['FAILED', false, ['ledger mismatch'], 'failed'],
    ['BLOCKED', false, ['baseline missing'], 'failed'],
    ['SUCCESS', true, ['contradictory mismatch'], 'failed'],
  ])('reflects reconciliation %s honestly', async (status, success, mismatches, expected) => {
    const fixture = context();
    state.reconcile.mockResolvedValue({ status, success, mismatches });
    const result = await testBillingReconcile(fixture.ctx);
    expect(result.status).toBe(expected);
    expect(result.details).toMatchObject({ mode: 'read_only', mismatches });
    expect(state.reconcile).toHaveBeenCalledWith(fixture.ctx.supabase);
    expect(fixture.rpc).not.toHaveBeenCalled();
  });
  it('reports unavailable reconciliation as failure', async () => {
    state.reconcile.mockRejectedValue(new Error('private detail'));
    const result = await testBillingReconcile(context().ctx);
    expect(result.status).toBe('failed');
    expect(result.message).toContain('无法完整读取');
  });
});


it('respects the authenticated 0079 and service-role 0103 column grants', async () => {
  const allowed = new Set(['user_id', 'operation_type', 'amount', 'created_at']);
  const userSelect = vi.fn((columns: string) => ({ limit: async () => ({
    data: [], error: columns.split(',').some(column => !allowed.has(column.trim()))
      ? { code: '42501' } : null,
  }) }));
  const adminSelect = vi.fn((columns: string) => ({ limit: async (count: number) => ({
    data: [], error: columns !== 'id, metadata' || count !== 0 ? { code: '42501' } : null,
  }) }));
  const rpc = vi.fn(() => { throw new Error('No billing mutations'); });
  const ctx = { supabase: { from: () => ({ select: userSelect }), rpc },
    supabaseAdmin: { from: () => ({ select: adminSelect }), rpc } } as any;
  expect((await testBillingPrededuct(ctx)).status).toBe('warning');
  expect((await testBillingIdempotency(ctx)).status).toBe('warning');
  expect(userSelect).toHaveBeenCalledTimes(1);
  expect(adminSelect).toHaveBeenCalledWith('id, metadata');
  expect(rpc).not.toHaveBeenCalled();
});
