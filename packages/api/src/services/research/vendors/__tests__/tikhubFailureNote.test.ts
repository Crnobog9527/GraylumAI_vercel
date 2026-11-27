/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// BENCHMARK-COVERAGE (2026-11-27): every Xiaohongshu app_v2 route answered HTTP 400 and the stored result said only
// "HTTP_400", so nobody could tell a parameter mistake from a TikHub outage without a key. A failed answer now keeps
// TikHub's request id and short message. The fixture is that real answer (it holds no key and no account data).
import { describe, expect, it, vi } from 'vitest';
import type { ToolCallPolicy } from '../../../turn/provider/toolBilling';
import { runSubcall, type EvidencePort, type SubcallContext, type ToolSubcallBilling, type VendorCalls } from '../../runtime/subcall';
import { buildTikhubRequest, callTikhub, tikhubFailureNote } from '../tikhub';
import { FIXED_NOW, jsonFetch } from './fetchDoubles';
import samples from './fixtures/tikhubErrorSamples.json';

const deps = (fetchImpl: typeof fetch) => ({ apiKey: 'test-key', fetchImpl, now: FIXED_NOW, timeoutMs: 50 });
const real400 = samples.xhsSearchNotes400;

describe('TikHub failure note', () => {
  it('keeps the request id and message of the real 2026-11-27 Xiaohongshu 400, never the echoed keyword', async () => {
    const result = await callTikhub({ platform: 'xiaohongshu', kind: 'keyword_posts', keyword: '搬家整理' },
      deps(jsonFetch(real400.status, real400.body)));
    expect(result).toMatchObject({ outcome: 'failed', reason: 'HTTP_400', supplierMayCharge: false, usage: { units: '0' } });
    expect(result.supplierNote).toEqual({ requestId: real400.body.detail.request_id,
      message: expect.stringMatching(/^Request failed\. Please retry\./) });
    expect(result.supplierNote!.message!.length).toBeLessThanOrEqual(200);
    const stored = JSON.stringify(result);
    expect(stored).not.toContain('搬家整理');
    expect(stored).not.toContain('test-key');
  });

  it('sends the same parameters the recorded failing call carried (route unchanged, so the 400 was not a parameter change)', () => {
    const built = buildTikhubRequest({ platform: 'xiaohongshu', kind: 'keyword_posts', keyword: '搬家整理' });
    if (!('request' in built)) throw new Error('not built');
    const sent = Object.fromEntries(new URL(built.request.url).searchParams);
    expect(sent).toEqual(real400.body.detail.params);
    expect(new URL(built.request.url).pathname).toBe(`/api${real400.body.detail.router.replace(/^\/api/, '')}`);
  });

  it('reads a plain string detail and a 200 that wraps an upstream error', async () => {
    const paid = await callTikhub({ platform: 'x', kind: 'account_profile', account: 'NASA' }, deps(jsonFetch(402, { detail: 'no credit' })));
    expect(paid.supplierNote).toEqual({ message: 'no credit' });
    const wrapped = await callTikhub({ platform: 'xiaohongshu', kind: 'keyword_posts', keyword: '护肤' },
      deps(jsonFetch(200, { code: 400, message: 'upstream error', request_id: 'abcd-1234-ef' })));
    expect(wrapped).toMatchObject({ reason: 'UPSTREAM_400', supplierNote: { requestId: 'abcd-1234-ef', message: 'upstream error' } });
  });

  it('gives no note for unreadable bodies and drops malformed ids, control characters and long text', async () => {
    const html = await callTikhub({ platform: 'x', kind: 'account_profile', account: 'NASA' }, deps(jsonFetch(502, '<html>bad gateway</html>')));
    expect(html).toMatchObject({ reason: 'HTTP_502' });
    expect(html).not.toHaveProperty('supplierNote');
    expect(tikhubFailureNote(null)).toBeUndefined();
    expect(tikhubFailureNote({ detail: { request_id: 'id with spaces <script>' } })).toBeUndefined();
    expect(tikhubFailureNote({ detail: { message: 'a\u0000b\nc‮' + 'x'.repeat(300) } })!.message).toMatch(/^a b c x+$/);
    expect(tikhubFailureNote({ detail: { message: 'y'.repeat(300) } })!.message).toHaveLength(200);
  });

  it('stores the note with the research operation, so the failure is readable later', async () => {
    const policy: ToolCallPolicy = {
      provider: 'tikhub', account: 'tikhub-main', model: 'tikhub:/xiaohongshu/app_v2/search_notes', protocol: 'research-tool-v1',
      modelId: '11111111-1111-4111-8111-111111111111', multiplier: '1', lookupSupported: false, upperUsd: '0.02', purposes: ['research'],
      toolPricing: { unit: 'call', currency: 'USD', price: '0.01', unitsPerPrice: '1', usdPerCurrency: null, entryHash: 'a'.repeat(64),
        validUntil: '2026-12-31T00:00:00Z', maxUnitsPerCall: '1' },
    };
    const failed = await callTikhub({ platform: 'xiaohongshu', kind: 'keyword_posts', keyword: '搬家整理' },
      deps(jsonFetch(real400.status, real400.body)));
    const evidence = {
      open: vi.fn<EvidencePort['open']>().mockResolvedValue({ token: 't' }), finish: vi.fn<EvidencePort['finish']>().mockResolvedValue(undefined),
      link: vi.fn<EvidencePort['link']>().mockResolvedValue(undefined), dispatch: vi.fn<EvidencePort['dispatch']>().mockResolvedValue(true),
      cancel: vi.fn<EvidencePort['cancel']>().mockResolvedValue(undefined),
    };
    const billing = { runId: '22222222-2222-4222-8222-222222222222',
      claim: vi.fn<ToolSubcallBilling['claim']>().mockResolvedValue({ state: 'claimed', callId: 'c', token: 'k' }),
      dispatch: vi.fn<ToolSubcallBilling['dispatch']>().mockResolvedValue(true),
      record: vi.fn<ToolSubcallBilling['record']>().mockResolvedValue({ accountClosed: false, contentDeleted: false }) };
    const vendors = { tikhub: vi.fn<VendorCalls['tikhub']>().mockResolvedValue(failed),
      parallel: vi.fn<VendorCalls['parallel']>(), firecrawl: vi.fn<VendorCalls['firecrawl']>() };
    const context: SubcallContext = { policies: [policy], billing, evidence, nextSequence: () => 1, phase: 'research', runtimeEpoch: 1,
      secrets: async () => 'test-key', rateCounter: async () => true, vendors, newId: () => 'op-1', now: FIXED_NOW };
    await runSubcall(context, { vendor: 'tikhub', route: policy.model.slice('tikhub:'.length),
      call: { platform: 'xiaohongshu', kind: 'keyword_posts', keyword: '搬家整理' } });
    expect(evidence.finish).toHaveBeenCalledWith('op-1', 't', expect.any(String),
      expect.objectContaining({ reason: 'HTTP_400', supplierNote: failed.supplierNote }));
  });
});
