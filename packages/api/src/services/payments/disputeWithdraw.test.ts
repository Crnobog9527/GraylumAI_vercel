/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { afterEach, expect, it, vi } from 'vitest';
const send = vi.hoisted(() => vi.fn());
vi.mock('../notify/reminders', () => ({ sendDisputeWonNotice: send }));
import { withdrawDisputeHold } from './disputeWithdraw';

const ACTOR = '00000000-0000-4000-8000-0000000000aa';
const DISPUTE = '00000000-0000-4000-8000-000000000001';
const USER = '00000000-0000-4000-8000-000000000002';
const ORDER = '00000000-0000-4000-8000-000000000003';
const db = (data: unknown, error: unknown = null) => ({ rpc: vi.fn(async () => ({ data, error })) }) as never;
const row = (status: string, duplicate = false) =>
  ({ restored: 100, duplicate, backfilled: 300, userId: USER, orderId: ORDER, status });
afterEach(() => send.mockReset());

it('emails "please resubscribe" only for a won dispute and reports the backfill', async () => {
  send.mockResolvedValue({ outcome: 'sent' });
  const database = db(row('won'));
  expect(await withdrawDisputeHold(database, ACTOR, DISPUTE)).toEqual({ restored: 100, duplicate: false, backfilled: 300, email: 'sent' });
  expect(send).toHaveBeenCalledWith(database, { userId: USER, orderId: ORDER, disputeId: DISPUTE }, { actor: ACTOR });
  for (const status of ['under_review', 'lost', 'needs_response']) {
    send.mockClear();
    expect((await withdrawDisputeHold(db(row(status)), ACTOR, DISPUTE)).email).toBe('not_won');
    expect(send).not.toHaveBeenCalled();
  }
});
it('never emails twice for a repeated withdrawal and reports packs as not applicable', async () => {
  expect((await withdrawDisputeHold(db(row('won', true)), ACTOR, DISPUTE)).email).toBe('not_won');
  expect(send).not.toHaveBeenCalled();
  send.mockResolvedValue({ outcome: 'skipped' });
  expect((await withdrawDisputeHold(db(row('warning_closed')), ACTOR, DISPUTE)).email).toBe('not_sent');
});
it('keeps the withdrawal when the email fails and fails closed on a database error', async () => {
  send.mockRejectedValue(new Error('PAYMENT_NOTICE_SEND_FAILED'));
  expect(await withdrawDisputeHold(db(row('won')), ACTOR, DISPUTE)).toMatchObject({ restored: 100, email: 'failed' });
  await expect(withdrawDisputeHold(db(null, { message: 'x' }), ACTOR, DISPUTE)).rejects.toThrow('PAY_DISPUTE_WITHDRAW_UNAVAILABLE');
});
it('still accepts the old result shape from a database without 0537', async () => {
  expect(await withdrawDisputeHold(db({ restored: 7, duplicate: false }), ACTOR, DISPUTE))
    .toEqual({ restored: 7, duplicate: false, backfilled: 0, email: 'not_won' });
});
