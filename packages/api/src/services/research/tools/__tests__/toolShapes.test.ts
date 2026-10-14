/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import { DISABLED_RESEARCH_TOOLS } from '../../vendors/config';
import { statusForOutcome, toolEnvelope, TOOL_RESULT_MAX_BYTES } from '../envelope';
import {
  admitSubcalls, GENERAL_RESEARCH_TOOLS, POSITIONING_RESEARCH_TOOLS, RESEARCH_TOOL_DESCRIPTIONS, RESEARCH_TOOL_NAMES,
  researchToolArgs, subcallNeed,
} from '../schemas';
import { admitVendorCall, VENDOR_RATE_LIMITS } from '../vendorRateLimit';

const id = '00000000-0000-4000-8000-000000000001';

describe('tool arguments', () => {
  it('describes every tool and exposes the planned sets', () => {
    expect(Object.keys(researchToolArgs).sort()).toEqual([...RESEARCH_TOOL_NAMES].sort());
    expect(Object.keys(RESEARCH_TOOL_DESCRIPTIONS).sort()).toEqual([...RESEARCH_TOOL_NAMES].sort());
    expect(POSITIONING_RESEARCH_TOOLS).not.toContain('social_search');
    expect(GENERAL_RESEARCH_TOOLS).not.toContain('benchmark_fetch');
  });

  it('enforces counts, lengths and strictness', () => {
    const p = researchToolArgs.propose_keywords;
    expect(p.safeParse({ keywords: ['a', 'b', 'c'] }).success).toBe(true);
    expect(p.safeParse({ keywords: ['a', 'b'] }).success).toBe(false);
    expect(p.safeParse({ keywords: ['a', 'b', 'c', 'd', 'e', 'f'] }).success).toBe(false);
    expect(p.safeParse({ keywords: ['a', 'B', 'b'] }).success).toBe(false);
    expect(p.safeParse({ keywords: ['a', 'b', '字'.repeat(41)] }).success).toBe(false);
    expect(p.safeParse({ keywords: ['a', 'b', 'c'], extra: 1 }).success).toBe(false);
    expect(researchToolArgs.web_search.parse({ query: 'graylum' })).toEqual({ query: 'graylum', mode: 'fast' });
    expect(researchToolArgs.web_search.safeParse({ query: 'x'.repeat(201) }).success).toBe(false);
    expect(researchToolArgs.social_search.safeParse({ platform: 'tiktok', keywords: ['a'], limit: 31 }).success).toBe(false);
    expect(researchToolArgs.social_search.safeParse({ platform: 'facebook', keywords: ['a'] }).success).toBe(false);
  });

  it('accepts only public links for web_fetch', () => {
    const f = researchToolArgs.web_fetch;
    expect(f.safeParse({ url: 'https://example.com/a' }).success).toBe(true);
    for (const url of ['http://localhost/a', 'https://user:pw@example.com', 'file:///etc/passwd', 'https://10.0.0.1/', 'not a url']) {
      expect(f.safeParse({ url }).success).toBe(false);
    }
  });

  it('requires a source for benchmark_fetch and a start or continuation for discover', () => {
    const accounts = [{ platform: 'tiktok', account: 'homeideas' }];
    expect(researchToolArgs.benchmark_fetch.safeParse({ accounts }).success).toBe(false);
    expect(researchToolArgs.benchmark_fetch.safeParse({ accounts, source: { kind: 'model' } }).success).toBe(false);
    expect(researchToolArgs.benchmark_fetch.safeParse({ accounts: Array(6).fill(accounts[0]),
      source: { kind: 'candidate', confirmationId: id } }).success).toBe(false);
    const d = researchToolArgs.benchmark_discover;
    expect(d.safeParse({ keywordConfirmationId: id, platforms: ['tiktok', 'x'] }).success).toBe(true);
    expect(d.safeParse({ keywordConfirmationId: id, platforms: ['tiktok', 'x', 'bilibili'] }).success).toBe(false);
    expect(d.safeParse({ discoveryId: id }).success).toBe(true);
    expect(d.safeParse({ discoveryId: id, keywordConfirmationId: id, platforms: ['x'] }).success).toBe(false);
  });
});

describe('round subcall budget', () => {
  const config = DISABLED_RESEARCH_TOOLS;
  it('counts worst-case subcalls per tool', () => {
    expect(subcallNeed('social_search', researchToolArgs.social_search.parse({ platform: 'x', keywords: ['a', 'b'] }), config))
      .toEqual({ mode: 'all_or_nothing', subcalls: 2 });
    expect(subcallNeed('social_account', researchToolArgs.social_account.parse({ platform: 'x', account: 'a' }), config).subcalls).toBe(3);
    expect(subcallNeed('benchmark_discover', { discoveryId: id }, config)).toEqual({ mode: 'up_to', subcalls: 25 });
    expect(subcallNeed('propose_keywords', { keywords: ['a', 'b', 'c'] }, config).subcalls).toBe(0);
  });

  it('rejects a general lookup that does not fit and caps benchmark tools', () => {
    expect(admitSubcalls({ mode: 'all_or_nothing', subcalls: 3 }, 2)).toEqual({ allowed: 0, exhausted: true });
    expect(admitSubcalls({ mode: 'all_or_nothing', subcalls: 3 }, 3)).toEqual({ allowed: 3, exhausted: false });
    expect(admitSubcalls({ mode: 'up_to', subcalls: 25 }, 7)).toEqual({ allowed: 7, exhausted: false });
    expect(admitSubcalls({ mode: 'up_to', subcalls: 25 }, 0)).toEqual({ allowed: 0, exhausted: true });
    expect(admitSubcalls({ mode: 'all_or_nothing', subcalls: 0 }, 0)).toEqual({ allowed: 0, exhausted: false });
  });
});

describe('supplier rate limit', () => {
  it('counts per supplier and endpoint before dispatch and fails closed', async () => {
    const counter = vi.fn(async () => true);
    expect(await admitVendorCall('tikhub', '/tiktok/app/v3/handler_user_profile', counter)).toEqual({ ok: true });
    expect(counter).toHaveBeenCalledWith('tikhub:/tiktok/app/v3/handler_user_profile', 10, '1 s');
    expect(await admitVendorCall('parallel', 'parallel:search:fast', async () => false))
      .toEqual({ ok: false, reason: 'VENDOR_RATE_LIMITED' });
    expect(await admitVendorCall('firecrawl', 'firecrawl:scrape:markdown', async () => { throw new Error('down'); }))
      .toEqual({ ok: false, reason: 'VENDOR_RATE_LIMITED' });
    expect(VENDOR_RATE_LIMITS.tikhub).toEqual({ limit: 10, window: '1 s' });
  });

  it('lets only the admitted share of a burst through', async () => {
    let used = 0;
    const counter = async (_key: string, limit: number) => ++used <= limit;
    const results = await Promise.all(Array.from({ length: 13 }, () => admitVendorCall('tikhub', 'r', counter)));
    expect(results.filter(r => r.ok)).toHaveLength(10);
  });
});

describe('result envelope', () => {
  it('maps adapter outcomes to tool states', () => {
    expect(statusForOutcome({ outcome: 'ok', reason: 'NO_RESULTS' })).toEqual({ status: 'ok', reason: 'NO_RESULTS' });
    expect(statusForOutcome({ outcome: 'failed', reason: 'X' })).toEqual({ status: 'unavailable', reason: 'PROVIDER_FAILED' });
    expect(statusForOutcome({ outcome: 'unknown', reason: 'TIMEOUT' })).toEqual({ status: 'unavailable', reason: 'PROVIDER_RESULT_UNKNOWN' });
    expect(statusForOutcome({ outcome: 'not_sent', reason: 'PDF_NOT_SUPPORTED' }).status).toBe('not_supported');
    expect(statusForOutcome({ outcome: 'not_sent', reason: 'INVALID_URL' })).toEqual({ status: 'unavailable', reason: 'INVALID_URL' });
  });

  it('adds refs and keeps small results whole', () => {
    const parsed = JSON.parse(toolEnvelope({ status: 'ok', evidenceId: 'e1', fetchedAt: '2026-10-14T00:00:00.000Z',
      items: [{ url: 'https://x.com/a', fields: { followers: 12000 }, missing: ['views'] }] }));
    expect(parsed).toMatchObject({ status: 'ok', reason: null, evidenceId: 'e1', truncated: false,
      items: [{ ref: 'e1#1', url: 'https://x.com/a', fields: { followers: 12000 }, missing: ['views'] }] });
    expect(typeof parsed.note).toBe('string');
  });

  it('shortens text, then drops items, and never reports a cut list as complete', () => {
    const items = Array.from({ length: 80 }, (_, i) => ({ fields: { title: '字'.repeat(600), plays: i }, missing: [] }));
    const text = toolEnvelope({ status: 'ok', evidenceId: 'e9', items });
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(TOOL_RESULT_MAX_BYTES);
    const parsed = JSON.parse(text);
    expect(parsed).toMatchObject({ status: 'partial', reason: 'RESULT_TRUNCATED', truncated: true });
    expect(parsed.items.length).toBeGreaterThan(0);
    expect(parsed.items.length).toBeLessThan(80);
    expect([...parsed.items[0].fields.title].length).toBe(401);
    expect(parsed.items[1].ref).toBe('e9#2');
  });

  it('keeps an explicit failure state with no items', () => {
    expect(JSON.parse(toolEnvelope({ status: 'not_confirmed', reason: 'NOT_CONFIRMED' })))
      .toMatchObject({ status: 'not_confirmed', reason: 'NOT_CONFIRMED', items: [], truncated: false });
  });
});
