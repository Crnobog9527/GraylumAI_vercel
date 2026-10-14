/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import { handlePostForMeWebhook, secretMatches } from './webhook';

const SECRET = 'synthetic-webhook-secret-0001';
const post = (body: unknown, secret: string | null = SECRET) => new Request('https://x.test/api/postforme/webhook', {
  method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body),
  headers: secret === null ? {} : { 'Post-For-Me-Webhook-Secret': secret } });

describe('Post for Me webhook', () => {
  it('compares secrets in constant time and rejects missing or wrong ones', async () => {
    expect(secretMatches(SECRET, SECRET)).toBe(true);
    expect(secretMatches('short', SECRET)).toBe(false);
    expect(secretMatches(null, SECRET)).toBe(false);
    const rpc = vi.fn();
    expect((await handlePostForMeWebhook(post({ event_type: 'x', data: {} }, 'wrong'), SECRET, () => ({ rpc }) as never)).status)
      .toBe(401);
    expect((await handlePostForMeWebhook(post({ event_type: 'x', data: {} }, null), SECRET, () => ({ rpc }) as never)).status)
      .toBe(401);
    expect((await handlePostForMeWebhook(post({}), undefined, () => ({ rpc }) as never)).status).toBe(503);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('a provider-side disconnect is applied idempotently; other events change nothing', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: true, error: null });
    const db = () => ({ rpc }) as never;
    const disconnected = { event_type: 'social.account.updated', data: { id: 'spc_1', status: 'disconnected' } };
    expect(await handlePostForMeWebhook(post(disconnected), SECRET, db)).toEqual({ status: 200, body: { ok: true } });
    expect(await handlePostForMeWebhook(post(disconnected), SECRET, db)).toEqual({ status: 200, body: { ok: true } });
    expect(rpc).toHaveBeenCalledWith('publish_monitor_provider_account_disconnected', { p_provider_account_id: 'spc_1' });
    rpc.mockClear();
    await handlePostForMeWebhook(post({ event_type: 'social.account.updated', data: { id: 'spc_1', status: 'connected' } }),
      SECRET, db);
    await handlePostForMeWebhook(post({ event_type: 'social.account.created', data: { id: 'spc_2' } }), SECRET, db);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('rejects malformed or oversized bodies', async () => {
    const db = () => ({ rpc: vi.fn() }) as never;
    expect((await handlePostForMeWebhook(post('not json'), SECRET, db)).status).toBe(400);
    expect((await handlePostForMeWebhook(post({ event_type: 'social.account.updated', data: { id: '../x' } }), SECRET, db))
      .status).toBe(400);
    expect((await handlePostForMeWebhook(post('x'.repeat(70_000)), SECRET, db)).status).toBe(413);
  });
});
