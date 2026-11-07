/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it, vi } from 'vitest';
const owner = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../ownerAlerts/notify', () => ({ notifyOwner: owner }));
import { CREDIT_ACCOUNT_REVIEW, turnDatabase, turnDatabaseCode } from './db';

it('keeps a turn code, names a refused freeze for what it is, and hides everything else behind unavailable', () => {
  expect(turnDatabaseCode('TURN_SESSION_BUSY')).toBe('TURN_SESSION_BUSY');
  expect(turnDatabaseCode('PRE_DEDUCT_AMBIGUOUS_CANONICAL_GRANT_WINDOWS: 2')).toBe(CREDIT_ACCOUNT_REVIEW);
  expect(turnDatabaseCode('PRE_DEDUCT_SUBSCRIPTION_MIRROR_MISSING')).toBe(CREDIT_ACCOUNT_REVIEW);
  expect(turnDatabaseCode('relation "x" does not exist')).toBe('TURN_DATABASE_UNAVAILABLE');
  expect(turnDatabaseCode(undefined)).toBe('TURN_DATABASE_UNAVAILABLE');
  // A caller's own list of known codes still decides first.
  expect(turnDatabaseCode('FUSION_REVIEW_ACTIVE', /\b(FUSION_[A-Z_]+)\b/)).toBe('FUSION_REVIEW_ACTIVE');
});

it('ALERT-FEISHU: a stop-loss refusal tells the Owner once a day, other refusals do not', async () => {
  const rpc = vi.fn(async () => ({ data: null, error: { message: 'STOP_LOSS_REACHED' } }));
  const db = turnDatabase({ write: { rpc }, read: { rpc } } as never);
  const open = { actorId: 'a', sessionId: null, requestId: 'r', kind: 'chat', policy: {} };
  await expect(db.open(open)).rejects.toThrow('STOP_LOSS_REACHED');
  expect(owner).toHaveBeenCalledExactlyOnceWith('stop_loss_reached', { utcDate: new Date().toISOString().slice(0, 10) });
  rpc.mockResolvedValue({ data: null, error: { message: 'TURN_SESSION_BUSY' } });
  await expect(db.open(open)).rejects.toThrow('TURN_SESSION_BUSY');
  expect(owner).toHaveBeenCalledTimes(1);
});
