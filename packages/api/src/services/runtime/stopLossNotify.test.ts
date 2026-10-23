/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, expect, it, vi } from 'vitest';
import type { NoticeConfigResult } from '../notify/config';
import { deliverStopLossAlerts, describeStopLossAlert, STOP_LOSS_NOTICE_MAX_ATTEMPTS } from './stopLossNotify';

const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock('../../lib/logger', () => ({ logger: log }));

const now = new Date('2026-10-23T12:00:00Z');
const config: NoticeConfigResult = { ok: true, config: { apiKey: 'synthetic-key', from: 'Graylum <no-reply@graylum.com>',
  replyTo: null, allowedRecipients: new Set(['owner@example.test']) } };
type Row = { id: string; test_id: string; details: Record<string, unknown> | null; created_at: string };
const site = (id: string, notify?: unknown): Row => ({ id, test_id: 'runtime_stop_loss_siteDailyUsd',
  created_at: '2026-10-23T11:00:00Z', details: { dedupeKey: `2026-10-23:siteDailyUsd:${id}`, utcDate: '2026-10-23',
    scope: 'site', thresholdUsd: '20', actualUsd: '20.5', ...(notify ? { notify } : {}) } });

function fixture(rows: Row[], mailbox: unknown = 'owner@example.test', opts: { readError?: boolean } = {}) {
  const updates: Array<{ id: string; details: Record<string, unknown> }> = [];
  const filters: unknown[][] = [];
  const db = {
    rpc: vi.fn(),
    from(table: string) {
      if (table === 'system_settings') {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { value: mailbox }, error: null }) }) }) };
      }
      let patch: Record<string, unknown> | null = null;
      const q = {
        select() { return q; },
        eq(...args: unknown[]) {
          if (patch) { updates.push({ id: args[1] as string, details: patch.details as Record<string, unknown> }); return Promise.resolve({ error: null }); }
          filters.push(['eq', ...args]); return q;
        },
        like(...args: unknown[]) { filters.push(['like', ...args]); return q; },
        gte(...args: unknown[]) { filters.push(['gte', ...args]); return q; },
        order() { return q; },
        limit: async () => opts.readError ? { data: null, error: { code: 'x' } } : { data: rows, error: null },
        update(value: Record<string, unknown>) { patch = value; return q; },
      };
      return q;
    },
  };
  return { db: db as never, updates, filters };
}

beforeEach(() => { vi.clearAllMocks(); });

it('mails all undelivered alerts as one digest to the support mailbox and marks them sent', async () => {
  const f = fixture([site('a'), site('b', { state: 'sent', attempts: 1 }), site('c', { state: 'pending', attempts: 2 })]);
  const transport = vi.fn(async () => ({ kind: 'sent' as const, providerMessageId: 'msg_1' }));
  expect(await deliverStopLossAlerts(f.db, { config, transport, env: {}, now })).toEqual({ outcome: 'sent', alerts: 2 });
  expect(transport).toHaveBeenCalledTimes(1);
  const mail = (transport.mock.calls[0] as unknown[])[1] as { to: string; subject: string; text: string; idempotencyKey: string };
  expect(mail.to).toBe('owner@example.test');
  expect(mail.subject).toContain('[staging]');
  expect(mail.text).toContain('全站每日上限已达到');
  expect(mail.text).toContain('$20.5');
  expect(mail.idempotencyKey).toMatch(/^runtime-stop-loss-[0-9a-f]{40}$/);
  expect(f.updates.map(u => u.id)).toEqual(['a', 'c']);
  expect(f.updates[1]!.details).toMatchObject({ dedupeKey: '2026-10-23:siteDailyUsd:c', notify: { state: 'sent', attempts: 3 } });
  expect(f.filters).toContainEqual(['eq', 'test_name', 'Runtime stop-loss']);
  expect(f.filters).toContainEqual(['gte', 'created_at', '2026-10-22T12:00:00.000Z']);
});

it('the same alert set always reuses the same idempotency key', async () => {
  const keys: string[] = [];
  const transport = vi.fn(async (_k: string, mail: { idempotencyKey: string }) => {
    keys.push(mail.idempotencyKey); return { kind: 'unknown' as const, code: 'PAYMENT_NOTICE_PROVIDER_UNREACHABLE' };
  });
  await deliverStopLossAlerts(fixture([site('a'), site('b')]).db, { config, transport, env: {}, now });
  await deliverStopLossAlerts(fixture([site('b'), site('a')]).db, { config, transport, env: {}, now });
  expect(keys[0]).toBe(keys[1]);
});

it('does nothing when every recent alert was already delivered or gave up', async () => {
  const f = fixture([site('a', { state: 'sent', attempts: 1 }), site('b', { state: 'failed', attempts: 5 })]);
  const transport = vi.fn();
  expect(await deliverStopLossAlerts(f.db, { config, transport, env: {}, now })).toEqual({ outcome: 'none', alerts: 0 });
  expect(transport).not.toHaveBeenCalled();
  expect(f.updates).toEqual([]);
});

it('records a failed send on the rows and gives up after the attempt limit', async () => {
  const transport = vi.fn(async () => ({ kind: 'failed' as const, code: 'PAYMENT_NOTICE_PROVIDER_422' }));
  const f = fixture([site('a'), site('b', { state: 'pending', attempts: STOP_LOSS_NOTICE_MAX_ATTEMPTS - 1 })]);
  expect(await deliverStopLossAlerts(f.db, { config, transport, env: {}, now }))
    .toEqual({ outcome: 'not_sent', alerts: 2, code: 'PAYMENT_NOTICE_PROVIDER_422' });
  expect(f.updates.map(u => u.details.notify)).toEqual([
    { state: 'pending', attempts: 1, lastErrorCode: 'PAYMENT_NOTICE_PROVIDER_422', lastAttemptAt: now.toISOString() },
    { state: 'failed', attempts: STOP_LOSS_NOTICE_MAX_ATTEMPTS, lastErrorCode: 'PAYMENT_NOTICE_PROVIDER_422', lastAttemptAt: now.toISOString() },
  ]);
  expect(log.error).toHaveBeenCalledWith('billing', 'runtime_stop_loss_notice_failed', { code: 'PAYMENT_NOTICE_PROVIDER_422', alerts: 2 });
});

it.each([
  [{ ok: false, code: 'PAYMENT_NOTICE_NOT_CONFIGURED' } as NoticeConfigResult, 'owner@example.test', 'PAYMENT_NOTICE_NOT_CONFIGURED'],
  [config, null, 'STOP_LOSS_NOTICE_NO_MAILBOX'],
  [config, 'someone@example.test', 'STOP_LOSS_NOTICE_RECIPIENT_NOT_ALLOWED'],
])('configuration refusal %#: nothing is sent and attempts are not used up', async (cfg, mailbox, code) => {
  const transport = vi.fn();
  const f = fixture([site('a'), site('b', { state: 'pending', attempts: 0, lastErrorCode: code })], mailbox);
  expect(await deliverStopLossAlerts(f.db, { config: cfg, transport, env: {}, now })).toEqual({ outcome: 'not_sent', alerts: 2, code });
  expect(transport).not.toHaveBeenCalled();
  expect(f.updates).toEqual([{ id: 'a', details: expect.objectContaining({ notify: { state: 'pending', attempts: 0, lastErrorCode: code } }) }]);
});

it('never throws when the alerts cannot be read', async () => {
  const f = fixture([], 'owner@example.test', { readError: true });
  expect(await deliverStopLossAlerts(f.db, { config, transport: vi.fn(), env: {}, now }))
    .toEqual({ outcome: 'not_sent', alerts: 0, code: 'STOP_LOSS_NOTICE_UNAVAILABLE' });
  expect(log.error).toHaveBeenCalledWith('billing', 'runtime_stop_loss_notice_unavailable', { alerts: 0 });
});

it('production mail has no staging marker', async () => {
  const transport = vi.fn(async () => ({ kind: 'sent' as const, providerMessageId: 'msg_2' }));
  const env = { VERCEL: '1', VERCEL_ENV: 'production', VERCEL_GIT_COMMIT_REF: 'main', VERCEL_PROJECT_PRODUCTION_URL: 'www.graylum.com' };
  await deliverStopLossAlerts(fixture([site('a')]).db, { config, transport, env, now });
  expect(((transport.mock.calls[0] as unknown[])[1] as { subject: string }).subject).not.toContain('staging');
});

it('describes alerts from whitelisted aggregate fields only', () => {
  expect(describeStopLossAlert({ test_id: 'runtime_stop_loss_balance_openrouter_low',
    details: { balanceUsd: '3', thresholdUsd: '5', userId: 'secret-user' } })).toBe('OpenRouter 余额偏低：记录余额 $3，提醒线 $5');
  expect(describeStopLossAlert({ test_id: 'runtime_stop_loss_userDailyUsd',
    details: { thresholdUsd: '<script>', utcDate: '2026-10-23' } })).toBe('有用户达到每人每日上限 未知（只记汇总，不记录是哪位用户）（统计日 2026-10-23 UTC）');
  expect(describeStopLossAlert({ test_id: 'runtime_stop_loss_other', details: null })).toBe('其他止损告警，请到后台查看。');
});
