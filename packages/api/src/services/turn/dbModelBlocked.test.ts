/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, expect, it, vi } from 'vitest';
const owner = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../ownerAlerts/notify', () => ({ notifyOwner: owner, OWNER_ALERT_TURN_BUDGET_MS: 2000 }));
import { turnDatabase } from './db';

/*
 * Deep review 2026-11-11, finding 10: a model blocked by an over-bound receipt was refused for every user and nobody was told. The
 * first refusal now tells the Owner (ownerAlerts dedupes it to once an hour per model), and the user's turn still gets its code.
 */
const MODEL = '00000000-0000-4000-8000-000000000020';
const begin = { actorId: 'a', turnId: 1, seq: 1, callKind: 'model' as const, modelId: MODEL, toolName: null, paid: null,
  requestHash: 'a'.repeat(64), upperUsd: '0.02', multiplier: '6' };
beforeEach(() => owner.mockClear());

it('ALERT-FEISHU: a call refused because its model is blocked tells the Owner which model, and keeps the refusal for the turn', async () => {
  const rpc = vi.fn(async () => ({ data: null, error: { message: 'TURN_MODEL_METERING_BLOCKED' } }));
  const db = turnDatabase({ write: { rpc }, read: { rpc } } as never);
  await expect(db.begin(begin)).rejects.toThrow('TURN_MODEL_METERING_BLOCKED');
  expect(owner).toHaveBeenCalledExactlyOnceWith('model_blocked', { modelId: MODEL }, { budgetMs: 2000 });
  // Not retried as a freeze race: one call to the database.
  expect(rpc).toHaveBeenCalledTimes(1);
});

it('ALERT-FEISHU: any other refusal of a call says nothing about a blocked model', async () => {
  const rpc = vi.fn(async () => ({ data: null, error: { message: 'TURN_NOT_RUNNING' } }));
  const db = turnDatabase({ write: { rpc }, read: { rpc } } as never);
  await expect(db.begin(begin)).rejects.toThrow('TURN_NOT_RUNNING');
  expect(owner).not.toHaveBeenCalled();
});
