/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it, vi } from 'vitest';
const owner = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../ownerAlerts/notify', () => ({ notifyOwner: owner, OWNER_ALERT_TURN_BUDGET_MS: 2000 }));
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
  expect(owner).toHaveBeenCalledExactlyOnceWith('stop_loss_reached', { utcDate: new Date().toISOString().slice(0, 10) }, { budgetMs: 2000 });
  rpc.mockResolvedValue({ data: null, error: { message: 'TURN_SESSION_BUSY' } });
  await expect(db.open(open)).rejects.toThrow('TURN_SESSION_BUSY');
  expect(owner).toHaveBeenCalledTimes(1);
});

// Deep review 2026-11-11, finding 2: a NUL or half an emoji in a message made turn_close fail (jsonb refuses both) after the whole
// answer had been streamed. Every turn write now sends text PostgreSQL accepts.
it('every turn write is cleaned of what PostgreSQL refuses: a NUL, a lone surrogate', async () => {
  const rpc = vi.fn(async (...call: unknown[]) => { void call; return { data: { turnId: 1, closeKind: 'completed', chargedCredits: 1,
    absorbedCredits: 0, settlement: 'done', replay: false }, error: null }; });
  const db = turnDatabase({ write: { rpc }, read: { rpc } } as never);
  await db.close({ actorId: 'a', turnId: 1, kind: 'completed', delivered: true, failureCode: null,
    messages: [{ role: 'user', content: 'hi\0 \ud83d' }, { role: 'assistant', content: 'ok 😀' }],
    kindResult: { research: { cards: [{ title: 'cut \ude00title\0' }] } } });
  const [name, args] = rpc.mock.calls[0] as unknown as [string, Record<string, unknown>];
  expect(name).toBe('turn_close');
  expect(args.p_messages).toEqual([{ role: 'user', content: 'hi \ufffd' }, { role: 'assistant', content: 'ok 😀' }]);
  expect(args.p_kind_result).toEqual({ research: { cards: [{ title: 'cut \ufffdtitle' }] } });
  expect(JSON.stringify(args)).not.toMatch(/\\u0000|\\ud83d(?!\\ude00)|(?<!\\ud83d)\\ude00/i);
});
