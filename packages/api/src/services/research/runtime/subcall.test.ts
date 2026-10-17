/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import { BillingClaimRejection } from '../../bill2/claimFailure';
import type { ToolCallPolicy } from '../../bill2/toolBilling';
import type { ToolSubcallBilling } from '../../bill2/toolSubcall';
import type { ResearchCallResult } from '../vendors/types';
import { requestIdentity, ResearchPause, runSubcall, type EvidencePort, type SubcallContext, type SupplierRequest, type VendorCalls } from './subcall';

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
    runId: '22222222-2222-4222-8222-222222222222',
    claim: vi.fn<ToolSubcallBilling['claim']>().mockResolvedValue({ state: 'claimed', callId: 'call-1', token: 'claim-token' }),
    dispatch: vi.fn<ToolSubcallBilling['dispatch']>().mockResolvedValue(true),
    record: vi.fn<ToolSubcallBilling['record']>().mockResolvedValue({ accountClosed: false, contentDeleted: false }),
  };
  const evidence = {
    open: vi.fn<EvidencePort['open']>().mockResolvedValue({ token: 'evidence-token' }),
    finish: vi.fn<EvidencePort['finish']>().mockResolvedValue(undefined),
    link: vi.fn<EvidencePort['link']>().mockResolvedValue(undefined),
    dispatch: vi.fn<EvidencePort['dispatch']>().mockResolvedValue(true),
    cancel: vi.fn<EvidencePort['cancel']>().mockResolvedValue(undefined),
  };
  const vendors = {
    parallel: vi.fn<VendorCalls['parallel']>().mockResolvedValue(result),
    tikhub: vi.fn<VendorCalls['tikhub']>(), firecrawl: vi.fn<VendorCalls['firecrawl']>(),
  };
  const context: SubcallContext = {
    policies: [policy], billing, evidence, nextSequence: vi.fn(() => 1), phase: 'question', runtimeEpoch: 3,
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
      runtimeEpoch: 3, automaticRetry: false, upperUsd: '0.002', phase: 'question' }));
    expect(f.evidence.open).toHaveBeenCalledWith('operation-1', requestIdentity(request), 2000);
    expect(f.vendors.parallel).toHaveBeenCalledWith('research', { apiKey: 'test-key', now: f.context.now }, 'fast');
    expect(f.billing.record).toHaveBeenCalledWith('call-1', expect.objectContaining({
      cost: '0.001', toolOutcome: 'delivered', usage: { unit: 'sku_search', units: '1' },
    }));
    expect(f.evidence.finish).toHaveBeenCalledWith('operation-1', 'evidence-token', 'succeeded',
      expect.objectContaining({ cost: { actual: 0.001 }, items: result.items }));
    expect(f.evidence.link).toHaveBeenCalledWith('operation-1', 'call-1');
    expect(f.evidence.open.mock.invocationCallOrder[0]).toBeLessThan(f.evidence.link.mock.invocationCallOrder[0]!);
    expect(f.evidence.link.mock.invocationCallOrder[0]).toBeLessThan(f.billing.dispatch.mock.invocationCallOrder[0]!);
    expect(f.billing.dispatch.mock.invocationCallOrder[0]).toBeLessThan(f.evidence.dispatch.mock.invocationCallOrder[0]!);
    expect(f.evidence.dispatch).toHaveBeenCalledWith('operation-1', 'evidence-token');
    expect(f.evidence.dispatch.mock.invocationCallOrder[0]).toBeLessThan(f.vendors.parallel.mock.invocationCallOrder[0]!);
    expect(f.evidence.cancel).not.toHaveBeenCalled();
    expect(f.vendors.tikhub).not.toHaveBeenCalled();
    expect(f.vendors.firecrawl).not.toHaveBeenCalled();
  });

  it.each(['ROUTE_NOT_FROZEN', 'KEY_MISSING'] as const)('does not claim or send after %s', async stop => {
    const f = fixture();
    if (stop === 'ROUTE_NOT_FROZEN') f.context.policies = [];
    if (stop === 'KEY_MISSING') f.context.secrets = vi.fn().mockResolvedValue(null);
    expect(await runSubcall(f.context, request)).toEqual({ sent: false, stop, budget: false });
    expect(f.billing.claim).not.toHaveBeenCalled();
    expect(f.evidence.open).not.toHaveBeenCalled();
    expect(f.vendors.parallel).not.toHaveBeenCalled();
  });

  // A resumed turn must reach its saved slot again; a temporary outage before the claim keeps it resumable (#1062 review).
  it.each(['key store unavailable', 'rate limit full', 'rate counter unavailable'] as const)(
    'pauses (waiting_resume) at the slot without claiming or sending when the %s', async cause => {
      const f = fixture();
      if (cause === 'key store unavailable') f.context.secrets = vi.fn().mockRejectedValue(new Error('RESEARCH_KEY_UNAVAILABLE'));
      if (cause === 'rate limit full') f.context.rateCounter = vi.fn().mockResolvedValue(false);
      if (cause === 'rate counter unavailable') f.context.rateCounter = vi.fn().mockRejectedValue(new Error('counter unavailable'));
      const paused = await runSubcall(f.context, request).catch(error => error);
      expect(paused).toBeInstanceOf(ResearchPause);
      expect(paused.state).toBe('waiting_resume');
      expect(paused.message).toBe('RUNTIME_WAITING_RESUME');
      expect(paused.point).toEqual({ sequence: 1, requestHash: requestIdentity(request), phase: 'question' });
      expect(f.billing.claim).not.toHaveBeenCalled();
      expect(f.evidence.open).not.toHaveBeenCalled();
      expect(f.vendors.parallel).not.toHaveBeenCalled();
    });

  it('persists the exact billing receipt before a record outage so replay can reconcile without repricing', async () => {
    const f = fixture();
    f.billing.record.mockRejectedValue(new Error('record unavailable'));
    await expect(runSubcall(f.context, request)).rejects.toThrow('record unavailable');
    const saved = f.evidence.finish.mock.calls[0]![3] as { billing: unknown };
    expect(saved.billing).toEqual({ runId: f.billing.runId, callId: 'call-1', receipt: f.billing.record.mock.calls[0]![1] });
    expect(f.evidence.finish.mock.invocationCallOrder[0]).toBeLessThan(f.billing.record.mock.invocationCallOrder[0]!);
    expect(f.evidence.link).toHaveBeenCalledWith('operation-1', 'call-1');
    expect(f.vendors.parallel).toHaveBeenCalledTimes(1);
  });

  it('never dispatches or contacts the supplier if the original call link cannot be saved', async () => {
    const f = fixture();
    f.evidence.link.mockRejectedValue(new Error('link unavailable'));
    await expect(runSubcall(f.context, request)).rejects.toThrow('link unavailable');
    expect(f.billing.dispatch).not.toHaveBeenCalled();
    expect(f.billing.record).toHaveBeenCalledWith('call-1', expect.objectContaining({ toolOutcome: 'failed_free', cost: '0' }));
    // The operation was never dispatched on the research side: it is cancelled, not finished.
    expect(f.evidence.dispatch).not.toHaveBeenCalled();
    expect(f.evidence.finish).not.toHaveBeenCalled();
    expect(f.evidence.cancel).toHaveBeenCalledWith('operation-1');
    expect(f.vendors.parallel).not.toHaveBeenCalled();
  });

  it('records a zero-cost terminal result when BILL2 dispatch fails locally before any supplier request', async () => {
    const f = fixture();
    f.billing.dispatch.mockRejectedValue(new Error('dispatch response lost'));
    await expect(runSubcall(f.context, request)).rejects.toThrow('dispatch response lost');
    expect(f.vendors.parallel).not.toHaveBeenCalled();
    expect(f.evidence.dispatch).not.toHaveBeenCalled();
    expect(f.evidence.finish).not.toHaveBeenCalled();
    expect(f.evidence.cancel).toHaveBeenCalledWith('operation-1');
    expect(f.billing.record).toHaveBeenCalledWith('call-1', expect.objectContaining({ toolOutcome: 'failed_free', cost: '0' }));
  });


  it('never resends a replayed claim', async () => {
    const f = fixture();
    f.billing.claim.mockResolvedValue({ state: 'replayed', callId: 'call-1' });
    expect(await runSubcall(f.context, request)).toEqual({ sent: false, stop: 'CALL_REPLAYED', budget: false });
    expect(f.evidence.open).not.toHaveBeenCalled();
    expect(f.billing.dispatch).not.toHaveBeenCalled();
    expect(f.vendors.parallel).not.toHaveBeenCalled();
  });

  it('pauses at the slot when the balance cannot start the subcall, instead of reporting a stop (BILL-PAYG)', async () => {
    const f = fixture();
    f.billing.claim.mockResolvedValue({ state: 'waiting_credits' });
    const paused = await runSubcall(f.context, request).catch(error => error);
    expect(paused).toBeInstanceOf(ResearchPause);
    expect(paused.state).toBe('waiting_credits');
    // The exact slot, request and phase the run resumes with (payg_wait → bill2_claim checkpoint check).
    expect(paused.point).toEqual({ sequence: 1, requestHash: requestIdentity(request), phase: 'question' });
    expect(f.billing.claim).toHaveBeenCalledWith(1, expect.objectContaining({ requestHash: requestIdentity(request), phase: 'question' }));
    expect(f.evidence.open).not.toHaveBeenCalled();
    expect(f.billing.record).not.toHaveBeenCalled();
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
    if (failure === 'dispatch-error') expect(f.billing.record).toHaveBeenCalledWith('call-1',
      expect.objectContaining({ toolOutcome: 'failed_free', cost: '0' }));
    else expect(f.billing.record).not.toHaveBeenCalled();
    if (failure === 'dispatch-false') expect(f.evidence.cancel).toHaveBeenCalledWith('operation-1');
    expect(f.evidence.dispatch).not.toHaveBeenCalled();
    expect(f.evidence.finish).not.toHaveBeenCalled();
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

  it('does not deliver or resend when billing recording fails, but retains the original call link', async () => {
    const f = fixture();
    f.billing.record.mockRejectedValue(new Error('record unavailable'));
    await expect(runSubcall(f.context, request)).rejects.toThrow('record unavailable');
    expect(f.vendors.parallel).toHaveBeenCalledTimes(1);
    expect(f.evidence.link).toHaveBeenCalledWith('operation-1', 'call-1');
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

describe('supplier dispatch boundary hooks', () => {
  it.each(['false', 'throw'] as const)('never sends and records zero failed_free when beforeSend returns %s', async mode => {
    const f = fixture();
    const failure = new Error('fetch dispatch unavailable');
    f.context.beforeSend = mode === 'throw' ? vi.fn().mockRejectedValue(failure) : vi.fn().mockResolvedValue(false);
    const started = vi.fn();
    f.context.onSupplierDispatch = started;
    if (mode === 'throw') await expect(runSubcall(f.context, request)).rejects.toBe(failure);
    else expect(await runSubcall(f.context, request)).toMatchObject({ result: { outcome: 'not_sent', supplierMayCharge: false } });
    expect(f.vendors.parallel).not.toHaveBeenCalled();
    expect(f.vendors.tikhub).not.toHaveBeenCalled();
    expect(f.vendors.firecrawl).not.toHaveBeenCalled();
    expect(started).not.toHaveBeenCalled();
    expect(f.billing.record).toHaveBeenCalledWith('call-1', expect.objectContaining({ toolOutcome: 'failed_free', cost: '0' }));
    expect(f.evidence.finish).toHaveBeenCalledWith('operation-1', 'evidence-token', 'failed',
      expect.objectContaining({ outcome: 'not_sent', cost: { actual: 0 } }));
    expect(f.billing.dispatch.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(f.context.beforeSend).mock.invocationCallOrder[0]!);
  });

  it('marks supplier start synchronously only after permission and immediately before calling the vendor', async () => {
    const f = fixture();
    const order: string[] = [];
    f.billing.dispatch.mockImplementation(async () => { order.push('bill2-dispatch'); return true; });
    f.context.beforeSend = vi.fn(async () => { order.push('before-send'); return true; });
    f.context.onSupplierDispatch = vi.fn(() => { order.push('supplier-dispatch'); });
    f.vendors.parallel.mockImplementation(async () => { order.push('vendor'); return result; });
    f.evidence.dispatch.mockImplementation(async () => { order.push('evidence-dispatch'); return true; });
    await runSubcall(f.context, request);
    expect(order).toEqual(['bill2-dispatch', 'evidence-dispatch', 'before-send', 'supplier-dispatch', 'vendor']);
    expect(f.context.onSupplierDispatch).toHaveBeenCalledTimes(1);
  });

  it.each(['claim', 'rate-limit', 'evidence-open'] as const)('does not consume the fetch dispatch boundary after %s failure', async stage => {
    const f = fixture();
    f.context.beforeSend = vi.fn().mockResolvedValue(true);
    f.context.onSupplierDispatch = vi.fn();
    if (stage === 'claim') f.billing.claim.mockRejectedValue(new Error('claim unavailable'));
    if (stage === 'rate-limit') f.context.rateCounter = vi.fn().mockRejectedValue(new Error('counter unavailable'));
    if (stage === 'evidence-open') f.evidence.open.mockRejectedValue(new Error('evidence unavailable'));
    if (stage === 'rate-limit') await expect(runSubcall(f.context, request)).rejects.toBeInstanceOf(ResearchPause);
    else await expect(runSubcall(f.context, request)).rejects.toThrow('unavailable');
    expect(f.context.beforeSend).not.toHaveBeenCalled();
    expect(f.context.onSupplierDispatch).not.toHaveBeenCalled();
    expect(f.vendors.parallel).not.toHaveBeenCalled();
    expect(f.billing.record).not.toHaveBeenCalled();
  });
});

describe('#1005 P2: research-side dispatch sits right before the supplier send', () => {
  it('opening evidence only reserves; nothing is dispatched on the research side before BILL2 dispatch', async () => {
    const f = fixture();
    f.billing.dispatch.mockResolvedValue(false);
    expect(await runSubcall(f.context, request)).toMatchObject({ sent: false, stop: 'NOT_DISPATCHED' });
    expect(f.evidence.dispatch).not.toHaveBeenCalled();
    expect(f.evidence.cancel).toHaveBeenCalledWith('operation-1');
    expect(f.vendors.parallel).not.toHaveBeenCalled();
  });

  it('a research dispatch refused after BILL2 dispatch records a free failure and cancels the operation', async () => {
    const f = fixture();
    f.evidence.dispatch.mockResolvedValue(false);
    expect(await runSubcall(f.context, request)).toMatchObject({ sent: false, stop: 'NOT_DISPATCHED' });
    expect(f.vendors.parallel).not.toHaveBeenCalled();
    expect(f.evidence.finish).not.toHaveBeenCalled();
    expect(f.evidence.cancel).toHaveBeenCalledWith('operation-1');
    expect(f.billing.record).toHaveBeenCalledWith('call-1', expect.objectContaining({ toolOutcome: 'failed_free', cost: '0' }));
  });

  it('a committed research dispatch whose response is lost finishes as not sent, never as unknown', async () => {
    const f = fixture();
    const lost = new Error('dispatch response lost');
    f.evidence.dispatch.mockRejectedValue(lost);
    await expect(runSubcall(f.context, request)).rejects.toBe(lost);
    expect(f.vendors.parallel).not.toHaveBeenCalled();
    expect(f.evidence.finish).toHaveBeenCalledWith('operation-1', 'evidence-token', 'failed',
      expect.objectContaining({ outcome: 'not_sent', reason: 'LOCAL_PRE_SEND_FAILED', cost: { actual: 0 } }));
    expect(f.evidence.cancel).not.toHaveBeenCalled();
    expect(f.billing.record).toHaveBeenCalledWith('call-1', expect.objectContaining({ toolOutcome: 'failed_free', cost: '0' }));
  });

  it('an uncommitted research dispatch (finish refused) is cancelled so the stable operation can be replaced', async () => {
    const f = fixture();
    const lost = new Error('dispatch response lost');
    f.evidence.dispatch.mockRejectedValue(lost);
    f.evidence.finish.mockRejectedValue(new Error('invalid finish'));
    await expect(runSubcall(f.context, request)).rejects.toBe(lost);
    expect(f.evidence.cancel).toHaveBeenCalledWith('operation-1');
    expect(f.vendors.parallel).not.toHaveBeenCalled();
    expect(f.billing.record).toHaveBeenCalledWith('call-1', expect.objectContaining({ toolOutcome: 'failed_free', cost: '0' }));
  });
});
