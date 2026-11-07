/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDedupe, type MarkStore } from './dedupe';
import { feishuSign } from './feishu';
import { ERROR_SPIKE } from './kinds';
import { notifyOwner, notifyOwnerWith, ownerAlertsEnabled, resetOwnerAlertDefaults, type NotifyDeps } from './notify';
import { noteServerErrorWith, type ErrorCounter } from './errorSpike';
import { logger } from '../../lib/logger';

const HOOK = 'https://open.feishu.cn/open-apis/bot/v2/hook/0a1b2c3d-test-hook';
const ok = () => new Response(JSON.stringify({ code: 0, msg: 'success' }));

function sharedStore() {
  const marks = new Map<string, number>();
  const store: MarkStore = {
    async setIfAbsent(key, _v, ttl) {
      if ((marks.get(key) ?? 0) > clock.t) return false;
      marks.set(key, clock.t + ttl * 1000);
      return true;
    },
    async remove(key) { marks.delete(key); },
  };
  return store;
}
const clock = { t: Date.parse('2026-11-08T10:00:00Z') };

function deps(over: Partial<NotifyDeps> = {}, store = sharedStore()) {
  const fetch = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () => ok());
  const value: NotifyDeps = {
    config: { webhookUrl: HOOK, secret: 'demo' },
    dedupe: createDedupe(() => store, () => clock.t),
    feishu: { fetch: fetch as never, now: () => clock.t },
    origin: 'https://staging.graylum.com',
    testSite: true,
    now: () => new Date(clock.t),
    ...over,
  };
  return { deps: value, fetch, store };
}
const body = (fetch: ReturnType<typeof deps>['fetch'], i = 0) => JSON.parse(String(fetch.mock.calls[i]![1].body));
const refund = { orderId: 'ord-1', refundId: 're_1', orderKind: 'subscription_first', state: 'refunded' as const, refundedMinor: 6900,
  chargedMinor: 6900, currency: 'usd', creditsTakenBack: 6900, creditsShortfall: 0 };

afterEach(() => { resetOwnerAlertDefaults(); vi.restoreAllMocks(); });

describe('notifyOwnerWith', () => {
  it('posts one signed text message: the sentence, then the admin link', async () => {
    const { deps: d, fetch } = deps();
    expect(await notifyOwnerWith(d, 'refund', refund)).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![0]).toBe(HOOK);
    const sent = body(fetch);
    expect(sent).toMatchObject({ msg_type: 'text', timestamp: String(Math.floor(clock.t / 1000)) });
    expect(sent.sign).toBe(feishuSign(Math.floor(clock.t / 1000), 'demo'));
    expect(sent.content.text).toBe('（测试站）【退款】会员订单 ord1 在 Stripe 那边退了 $69.00（不是从后台发起的），已自动扣回 6900 积分。'
      + '\n去后台看：https://staging.graylum.com/admin/refunds');
  });

  it('sends the same event once, also from another instance (Stripe redelivery)', async () => {
    const store = sharedStore();
    const a = deps({}, store);
    const b = deps({}, store);
    expect(await notifyOwnerWith(a.deps, 'refund', refund)).toBe(true);
    expect(await notifyOwnerWith(a.deps, 'refund', refund)).toBe(false);
    expect(await notifyOwnerWith(b.deps, 'refund', refund)).toBe(false);
    expect(await notifyOwnerWith(b.deps, 'refund', { ...refund, refundId: 're_2' })).toBe(true);
    expect(a.fetch.mock.calls.length + b.fetch.mock.calls.length).toBe(2);
  });

  it('holds a condition alert for its cooldown, then lets it through again', async () => {
    const { deps: d, fetch } = deps();
    const start = clock.t;
    expect(await notifyOwnerWith(d, 'provider_402', { provider: 'openrouter' })).toBe(true);
    clock.t = start + 29 * 60_000;
    expect(await notifyOwnerWith(d, 'provider_402', { provider: 'openrouter' })).toBe(false);
    clock.t = start + 30 * 60_000;
    expect(await notifyOwnerWith(d, 'provider_402', { provider: 'openrouter' })).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    clock.t = start;
  });

  it('skips silently, with no Redis or network call, when the variables are not set', async () => {
    const store = { setIfAbsent: vi.fn(), remove: vi.fn() };
    const { deps: d, fetch } = deps({ config: null }, store as unknown as MarkStore);
    expect(await notifyOwnerWith(d, 'refund', refund)).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect(store.setIfAbsent).not.toHaveBeenCalled();
    resetOwnerAlertDefaults();
    const env = { ...process.env };
    delete process.env.FEISHU_ALERT_WEBHOOK_URL;
    delete process.env.FEISHU_ALERT_SECRET;
    expect(ownerAlertsEnabled()).toBe(false);
    process.env = env;
  });

  it('isolates failures: a refused or failed send never throws, frees the event key and logs a warning only', async () => {
    const warn = vi.spyOn(logger, 'warn');
    const error = vi.spyOn(logger, 'error');
    const failing = vi.fn(async () => new Response(JSON.stringify({ code: 19021, msg: 'sign match fail' })));
    const { deps: d } = deps({ feishu: { fetch: failing as never, now: () => clock.t } });
    await expect(notifyOwnerWith(d, 'refund', refund)).resolves.toBe(false);
    expect(warn).toHaveBeenCalledWith('system', 'owner_alert_not_sent', expect.objectContaining({ code: 'FEISHU_REFUSED_19021' }));
    expect(error).not.toHaveBeenCalled();
    // Freed: the redelivery tries again.
    await expect(notifyOwnerWith(d, 'refund', refund)).resolves.toBe(false);
    expect(failing).toHaveBeenCalledTimes(2);
    const thrown = deps({ feishu: { fetch: (async () => { throw new Error('ECONNRESET'); }) as never, now: () => clock.t } });
    await expect(notifyOwnerWith(thrown.deps, 'refund', refund)).resolves.toBe(false);
  });

  it('notifyOwner itself never throws, even when setup fails', async () => {
    resetOwnerAlertDefaults({ ...deps().deps, dedupe: { claim: () => { throw new Error('boom'); }, seen: () => false, release: async () => {} } });
    await expect(notifyOwner('test', { note: 'x' })).resolves.toBeUndefined();
  });
});

describe('noteServerErrorWith (error spike)', () => {
  function counter(start = 0): ErrorCounter & { n: number } {
    return { n: start, async add() { this.n += 1; return this.n; } };
  }

  it(`alerts once at ${ERROR_SPIKE.count} errors in ${ERROR_SPIKE.minutes} minutes, then stays quiet for the cooldown`, async () => {
    const { deps: d, fetch } = deps();
    const errors = counter(ERROR_SPIKE.count - 2);
    expect(await noteServerErrorWith(d, errors)).toBe(false);
    expect(await noteServerErrorWith(d, errors)).toBe(true);
    expect(body(fetch).content.text).toContain(`过去 ${ERROR_SPIKE.minutes} 分钟服务器报错 ${ERROR_SPIKE.count} 次`);
    // Inside the cooldown this instance does not even count.
    expect(await noteServerErrorWith(d, errors)).toBe(false);
    expect(errors.n).toBe(ERROR_SPIKE.count);
    const start = clock.t;
    clock.t = start + ERROR_SPIKE.cooldownSeconds * 1000;
    expect(await noteServerErrorWith(d, errors)).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    clock.t = start;
  });

  it('keeps the cooldown after a failed send, so its own failure log cannot loop', async () => {
    const failing = vi.fn(async () => new Response('down', { status: 502 }));
    const { deps: d } = deps({ feishu: { fetch: failing as never, now: () => clock.t } });
    const errors = counter(ERROR_SPIKE.count);
    expect(await noteServerErrorWith(d, errors)).toBe(false);
    expect(await noteServerErrorWith(d, errors)).toBe(false);
    expect(failing).toHaveBeenCalledTimes(1);
  });

  it('does nothing without configuration', async () => {
    const errors = counter(100);
    expect(await noteServerErrorWith(deps({ config: null }).deps, errors)).toBe(false);
    expect(errors.n).toBe(100);
  });
});
