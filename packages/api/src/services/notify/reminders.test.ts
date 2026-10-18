/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ send: vi.fn(), enqueue: vi.fn(), config: vi.fn() }));
vi.mock('./sender', async original => ({ ...await original<typeof import('./sender')>(), sendPaymentNotice: mocks.send }));
vi.mock('./enqueue', () => ({ enqueuePaymentNotice: mocks.enqueue }));
vi.mock('./config', () => ({ noticeConfig: mocks.config }));
import { runPaymentReminders, sendDisputeWonNotice } from './reminders';
const id = '00000000-0000-4000-8000-000000000001';
const db = (data: unknown = [id], error: unknown = null) => ({ rpc: vi.fn(async () => ({ data, error })) });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.send.mockResolvedValue({ outcome: 'sent' });
  mocks.config.mockResolvedValue({ ok: false, code: 'PAYMENT_NOTICE_NOT_CONFIGURED' });
});
it('scans a bounded batch and uses the registered templates and a shared deadline', async () => {
  const d = db();
  expect(await runPaymentReminders(d as never, { now: () => 0 })).toMatchObject({ success: true, sent: 1, processed: 1 });
  expect(d.rpc).toHaveBeenCalledWith('payment_notice_scan', { p_limit: 100 });
  expect(mocks.send).toHaveBeenCalledWith(d, id, expect.objectContaining({ deadline: 50_000 }));
});
it('reports safe attention and keeps processing after one delivery fails', async () => {
  mocks.send.mockRejectedValueOnce(new Error('private payload'));
  mocks.send.mockResolvedValueOnce({ outcome: 'manual', attention: 'PAYMENT_NOTICE_UNKNOWN_UNRESOLVED' });
  const result = await runPaymentReminders(db([id, id]) as never);
  expect(mocks.send).toHaveBeenCalledTimes(2);
  expect(result.success).toBe(false);
  expect(result.attention).toEqual([{ attention: 'PAYMENT_NOTICE_SEND_FAILED' }, { attention: 'PAYMENT_NOTICE_UNKNOWN_UNRESOLVED' }]);
  expect(JSON.stringify(result)).not.toMatch(/private|00000000/);
});
it('defers unstarted work if the 60-second cron cannot fit another provider request', async () => {
  const result = await runPaymentReminders(db() as never, { now: () => 0, deadline: 10_000 });
  expect(result.deferred).toBe(1);
  expect(mocks.send).not.toHaveBeenCalled();
});
it('keeps unconfigured notices pending and surfaces scan failure instead of a false pass', async () => {
  mocks.send.mockResolvedValue({ outcome: 'held' });
  expect(await runPaymentReminders(db() as never)).toMatchObject({ held: 1, sent: 0 });
  await expect(runPaymentReminders(db(null, { code: 'fixture' }) as never)).rejects.toThrow('PAYMENT_NOTICE_SCAN_FAILED');
});
it('exposes dispute delivery only as an explicit server call, with one key per dispute and order', async () => {
  mocks.enqueue.mockResolvedValue({ id, state: 'pending' });
  const input = { userId: id, orderId: id, disputeId: 'dp_test' };
  await sendDisputeWonNotice(db() as never, input);
  await sendDisputeWonNotice(db() as never, input);
  expect(mocks.enqueue.mock.calls[0]![1]).toEqual(mocks.enqueue.mock.calls[1]![1]);
  expect(mocks.enqueue).toHaveBeenCalledWith(expect.anything(), { userId: id, kind: 'dispute_won_resubscribe',
    sourceRef: id, dueKey: 'dp_test' });
});
