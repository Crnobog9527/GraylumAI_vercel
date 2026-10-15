/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import { BillingClaimRejection } from '../../bill2/claimFailure';
import type { ToolCallPolicy } from '../../bill2/toolBilling';
import type { ToolSubcallBilling } from '../../bill2/toolSubcall';
import type { ResearchCallResult } from '../vendors/types';
import { requestIdentity, runSubcall, type EvidencePort, type SubcallContext, type SupplierRequest, type VendorCalls } from './subcall';

const request: SupplierRequest = { vendor: 'parallel', route: 'parallel:search:fast', query: 'research', mode: 'fast' };
const policy: ToolCallPolicy = {
  provider: 'parallel', account: 'parallel-main', model: 'parallel:parallel:search:fast',
  protocol: 'research-tool-v1', modelId: '11111111-1111-4111-8111-111111111111', multiplier: '6',
  lookupSupported: false, upperUsd: '0.002', purposes: ['question'],
  toolPricing: { unit: 'sku_search', currency: 'USD', price: '0.001', unitsPerPrice: '1',
    usdPerCurrency: null, entryHash: 'a'.repeat(64), validUntil: '2026-12-01T00:00:00Z', maxUnitsPerCall: '2' },
};
const result: ResearchCallResult = {
  vendor: 'parallel', route: request.route, outcome: 'ok', reason: null, httpStatus: 200,
  supplierMayCharge: true, usage: { unit: 'sku_search', units: '1' },
  items: [{ url: 'https://example.com', fields: { title: 'Evidence' }, missing: [] }],
  truncated: false, fetchedAt: '2026-10-15T00:00:00.000Z',
};

function fixture() {
  const billing = {
    claim: vi.fn<ToolSubcallBilling['claim']>().mockResolvedValue({ state: 'claimed', callId: 'call-1', token: 'claim-token' }),
    dispatch: vi.fn<ToolSubcallBilling['dispatch']>().mockResolvedValue(true),
    record: vi.fn<ToolSubcallBilling['record']>().mockResolvedValue({ accountClosed: false, contentDeleted: false }),
  };
  const evidence = {
    open: vi.fn<EvidencePort['open']>().mockResolvedValue({ token: 'evidence-token' }),
    finish: vi.fn<EvidencePort['finish']>().mockResolvedValue(undefined),
    link: vi.fn<EvidencePort['link']>().mockResolvedValue(undefined),
  };
  const vendors = {
    parallel: vi.fn<VendorCalls['parallel']>().mockResolvedValue(result),
    tikhub: vi.fn<VendorCalls['tikhub']>(), firecrawl: vi.fn<VendorCalls['firecrawl']>(),
  };
  const context: SubcallContext = {
    policies: [policy], billing, evidence, nextSequence: vi.fn(() => 1), phase: 'question', runtimeEpoch: '3',
    secrets: vi.fn().mockResolvedValue('test-key'), rateCounter: vi.fn().mockResolvedValue(true),
    vendors, newId: vi.fn(() => 'operation-1'), now: () => new Date(result.fetchedAt),
  };
  return { context, billing, evidence, vendors };
}

describe('research subcall safety and accounting', () => {
  it('binds claim and evidence to the same request and records official usage before delivery', async () => {
    const f = fixture();
    expect(await runSubcall(f.context, request)).toEqual({ sent: true, result, operationId: 'operation-1', callId: 'call-1' });
    expect(f.billing.claim).toHaveBeenCalledWith(1, expect.objectContaining({ requestHash: requestIdentity(request),
      runtimeEpoch: '3', automaticRetry: false, upperUsd: '0.002', phase: 'question' }));
    expect(f.evidence.open).toHaveBeenCalledWith('operation-1', requestIdentity(request), 2000);
    expect(f.vendors.parallel).toHaveBeenCalledWith('research', { apiKey: 'test-key', now: f.context.now }, 'fast');
    expect(f.billing.record).toHaveBeenCalledWith('call-1', expect.objectContaining({
      cost: '0.001', toolOutcome: 'delivered', usage: { unit: 'sku_search', units: '1' },
    }));
    expect(f.evidence.finish).toHaveBeenCalledWith('operation-1', 'evidence-token', 'succeeded',
      expect.objectContaining({ cost: { actual: 0.001 }, items: result.items }));
    expect(f.evidence.link).toHaveBeenCalledWith('operation-1', 'call-1');
    expect(f.evidence.open.mock.invocationCallOrder[0]).toBeLessThan(f.billing.dispatch.mock.invocationCallOrder[0]!);
    expect(f.billing.dispatch.mock.invocationCallOrder[0]).toBeLessThan(f.vendors.parallel.mock.invocationCallOrder[0]!);
    expect(f.vendors.tikhub).not.toHaveBeenCalled();
    expect(f.vendors.firecrawl).not.toHaveBeenCalled();
  });

  it.each(['ROUTE_NOT_FROZEN', 'KEY_MISSING', 'VENDOR_RATE_LIMITED'] as const)('does not claim or send after %s', async stop => {
    const f = fixture();
    if (stop === 'ROUTE_NOT_FROZEN') f.context.policies = [];
    if (stop === 'KEY_MISSING') f.context.secrets = vi.fn().mockResolvedValue(null);
    if (stop === 'VENDOR_RATE_LIMITED') f.context.rateCounter = vi.fn().mockResolvedValue(false);
    expect(await runSubcall(f.context, request)).toEqual({ sent: false, stop, budget: stop === 'VENDOR_RATE_LIMITED' });
    expect(f.billing.claim).not.toHaveBeenCalled();
    expect(f.evidence.open).not.toHaveBeenCalled();
    expect(f.vendors.parallel).not.toHaveBeenCalled();
  });

  it('fails closed if the rate counter is unavailable', async () => {
    const f = fixture();
    f.context.rateCounter = vi.fn().mockRejectedValue(new Error('counter unavailable'));
    expect(await runSubcall(f.context, request)).toMatchObject({ stop: 'VENDOR_RATE_LIMITED', budget: true });
    expect(f.billing.claim).not.toHaveBeenCalled();
  });

  it.each(['waiting_credits', 'replayed'] as const)('never resends a %s claim', async state => {
    const f = fixture();
    f.billing.claim.mockResolvedValue(state === 'replayed' ? { state, callId: 'call-1' } : { state });
    expect(await runSubcall(f.context, request)).toEqual({ sent: false,
      stop: state === 'replayed' ? 'CALL_REPLAYED' : 'BALANCE_LOW', budget: state === 'waiting_credits' });
    expect(f.evidence.open).not.toHaveBeenCalled();
    expect(f.billing.dispatch).not.toHaveBeenCalled();
    expect(f.vendors.parallel).not.toHaveBeenCalled();
  });

  it('reports policy rejections without leaking database details or sending', async () => {
    const f = fixture();
    f.billing.claim.mockRejectedValue(new BillingClaimRejection('BILL2_TOOL_PRICE_EXPIRED'));
    expect(await runSubcall(f.context, request)).toMatchObject({ stop: 'CLAIM_BILL2_TOOL_PRICE_EXPIRED', budget: false });
    expect(f.vendors.parallel).not.toHaveBeenCalled();
  });

  it.each(['open-null', 'open-error', 'dispatch-false', 'dispatch-error'] as const)('does not send on %s', async failure => {
    const f = fixture();
    if (failure === 'open-null') f.evidence.open.mockResolvedValue(null);
    if (failure === 'open-error') f.evidence.open.mockRejectedValue(new Error('storage unavailable'));
    if (failure === 'dispatch-false') f.billing.dispatch.mockResolvedValue(false);
    if (failure === 'dispatch-error') f.billing.dispatch.mockRejectedValue(new Error('dispatch unavailable'));
    if (failure.endsWith('error')) await expect(runSubcall(f.context, request)).rejects.toThrow('unavailable');
    else expect(await runSubcall(f.context, request)).toMatchObject({ sent: false, stop: 'NOT_DISPATCHED' });
    expect(f.vendors.parallel).not.toHaveBeenCalled();
    expect(f.billing.record).not.toHaveBeenCalled();
    if (failure === 'dispatch-false') expect(f.evidence.finish).toHaveBeenCalledWith(
      'operation-1', 'evidence-token', 'failed', { reason: 'NOT_DISPATCHED', cost: { actual: 0 } });
  });

  it('records a thrown supplier call as unknown and never retries or changes supplier', async () => {
    const f = fixture();
    f.vendors.parallel.mockRejectedValue(new Error('network timeout'));
    const outcome = await runSubcall(f.context, request);
    expect(outcome).toMatchObject({ sent: true, result: { outcome: 'unknown', reason: 'ADAPTER_ERROR', supplierMayCharge: true } });
    expect(f.billing.record).toHaveBeenCalledWith('call-1', expect.objectContaining({ toolOutcome: 'unknown', cost: null }));
    expect(f.vendors.parallel).toHaveBeenCalledTimes(1);
    expect(f.vendors.tikhub).not.toHaveBeenCalled();
    expect(f.vendors.firecrawl).not.toHaveBeenCalled();
  });

  it.each([
    { outcome: 'failed' as const, supplierMayCharge: true, cost: '0.001', toolOutcome: 'failed_charged' },
    { outcome: 'failed' as const, supplierMayCharge: false, cost: '0', toolOutcome: 'failed_free' },
    { outcome: 'not_sent' as const, supplierMayCharge: false, cost: '0', toolOutcome: 'failed_free' },
  ])('records $toolOutcome rather than dropping failed-call costs', async ({ outcome, supplierMayCharge, cost, toolOutcome }) => {
    const f = fixture();
    f.vendors.parallel.mockResolvedValue({ ...result, outcome, supplierMayCharge });
    await runSubcall(f.context, request);
    expect(f.billing.record).toHaveBeenCalledWith('call-1', expect.objectContaining({ cost, toolOutcome }));
  });

  it('charges the platform for known supplier cost when evidence persistence fails before delivery', async () => {
    const f = fixture();
    const failure = new Error('evidence unavailable');
    f.evidence.finish.mockRejectedValue(failure);
    await expect(runSubcall(f.context, request)).rejects.toBe(failure);
    expect(f.billing.record).toHaveBeenCalledWith('call-1', expect.objectContaining({ cost: '0.001', toolOutcome: 'failed_charged' }));
    expect(f.vendors.parallel).toHaveBeenCalledTimes(1);
  });

  it('keeps unknown usage pending when evidence persistence also fails', async () => {
    const f = fixture();
    const failure = new Error('evidence unavailable');
    f.evidence.finish.mockRejectedValue(failure);
    f.vendors.parallel.mockResolvedValue({ ...result, outcome: 'unknown', httpStatus: null,
      usage: { unit: 'sku_search', units: null } });
    await expect(runSubcall(f.context, request)).rejects.toBe(failure);
    expect(f.billing.record).toHaveBeenCalledWith('call-1', expect.objectContaining({
      cost: null, toolOutcome: 'unknown', usage: { unit: 'sku_search', units: null },
    }));
    expect(f.vendors.parallel).toHaveBeenCalledTimes(1);
  });

  it('does not deliver, resend or link when billing recording fails', async () => {
    const f = fixture();
    f.billing.record.mockRejectedValue(new Error('record unavailable'));
    await expect(runSubcall(f.context, request)).rejects.toThrow('record unavailable');
    expect(f.vendors.parallel).toHaveBeenCalledTimes(1);
    expect(f.evidence.link).not.toHaveBeenCalled();
  });

  it.each(['accountClosed', 'contentDeleted'] as const)('suppresses delivery after %s while keeping cost recorded', async field => {
    const f = fixture();
    f.billing.record.mockResolvedValue({ accountClosed: field === 'accountClosed', contentDeleted: field === 'contentDeleted' });
    expect(await runSubcall(f.context, request)).toEqual({ sent: false,
      stop: field === 'accountClosed' ? 'ACCOUNT_CLOSED' : 'CONTENT_DELETED', budget: false });
    expect(f.billing.record).toHaveBeenCalledTimes(1);
  });

  it('changes request identity when the query, mode or route changes', () => {
    const identity = requestIdentity(request);
    expect(identity).toMatch(/^[a-f0-9]{64}$/);
    expect(requestIdentity({ ...request })).toBe(identity);
    expect(requestIdentity({ ...request, query: 'other' })).not.toBe(identity);
    expect(requestIdentity({ ...request, mode: 'advanced' })).not.toBe(identity);
    expect(requestIdentity({ ...request, route: 'other' })).not.toBe(identity);
  });
});
