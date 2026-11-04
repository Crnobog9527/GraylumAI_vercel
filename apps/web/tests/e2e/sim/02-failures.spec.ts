import { type Page } from '@playwright/test';

import { expect, test } from './fixtures';

import { armFault, db, expectNothingFrozen, lastTurnId, ledger, resetSim, runRecovery, seed, signIn, simCalls, startFreeChat, turns, type SimFault, type Turn } from './support';

/**
 * Injected provider failures on a free-chat turn. Whatever happens, the turn must end closed and settled under the existing rules
 * (CORE-PATH-V2 2.5): a 402 refusal charges nothing; a broken or silent stream keeps the freeze until the recovery job finds the
 * provider's receipt (charge what it says, never more than was frozen) or learns there is none (refund, #1667); never twice.
 */
test.beforeEach(resetSim);

/** Sends one message with a fault armed; returns the one turn it opened, and the balance before. */
async function failedTurn(page: Page, fault: SimFault, waitMs = 120_000): Promise<{ turn: Turn; before: number }> {
  const bob = seed().users.bob;
  await signIn(page, 'bob');
  await expectNothingFrozen(bob.id);
  const before = (await ledger(bob.id)).credits;
  const mark = await lastTurnId(bob.id);
  await armFault(fault);
  await startFreeChat(page, `模拟故障：${fault.mode}`);
  await expect.poll(async () => (await turns(bob.id, mark)).map(t => `${t.kind}:${t.state}`).join(','),
    { message: 'the turn closes by itself', timeout: waitMs, intervals: [1000, 2000, 5000] }).toBe('chat:closed');
  const opened = await turns(bob.id, mark);
  expect(opened.map(t => t.kind), 'one message opened exactly one turn').toEqual(['chat']);
  // The turn's own failure code goes into the message: a turn refused before its model call (e.g. TURN_PROVIDER_LIMIT_UNAVAILABLE)
  // sent nothing to the simulator, and the count alone does not say why.
  expect((await simCalls()).filter(c => c.role === 'primary' && c.fault === fault.mode),
    `the failing call was sent once (turn ${opened[0]?.id} ended ${opened[0]?.close_kind}/${opened[0]?.failure_code})`).toHaveLength(1);
  // The page says the message did not finish and does not keep spinning.
  await expect(page.getByText('正在思考…')).toHaveCount(0, { timeout: 30_000 });
  await expect(page.locator('[data-step-state="running"]')).toHaveCount(0, { timeout: 30_000 });
  return { turn: opened[0]!, before };
}

/** After the recovery job, the turn is settled once and the balance moved by exactly what it charged. */
async function expectSettledBy(turnId: string, before: number) {
  const bob = seed().users.bob;
  await expect.poll(async () => { await runRecovery(); return (await turns(bob.id)).find(t => t.id === turnId)?.settlement; },
    { message: 'the recovery job settles the turn', timeout: 180_000, intervals: [3000, 5000, 10_000] }).toBe('done');
  const turn = (await turns(bob.id)).find(t => t.id === turnId)!;
  expect(turn.charged ?? 0).toBeLessThanOrEqual(turn.reserved);
  const after = await ledger(bob.id);
  expect(after.credits, 'charged exactly once').toBe(before - (turn.charged ?? 0));
  expect(after.recorded).toBe(after.credits);
  // Settling again changes nothing.
  await runRecovery();
  expect((await ledger(bob.id)).credits).toBe(after.credits);
  await expectNothingFrozen(bob.id);
  return turn;
}

test('402 from the provider: refused before generation, nothing charged, nothing frozen', async ({ page }) => {
  const { turn, before } = await failedTurn(page, { mode: '402' });
  expect(turn.settlement).toBe('done');
  expect(turn.charged ?? 0).toBe(0);
  expect((await ledger(seed().users.bob.id)).credits).toBe(before);
  await expectNothingFrozen(seed().users.bob.id);
});

test('stream cut after ~0.5 s with a receipt: frozen until recovery, then charged what the receipt says, once', async ({ page }) => {
  const { turn, before } = await failedTurn(page, { mode: 'cut' });
  expect(turn.close_kind).toBe('interrupted');
  const settled = await expectSettledBy(turn.id, before);
  expect(settled.charged ?? 0, 'the provider billed the cut generation').toBeGreaterThan(0);
});

/**
 * The provider has no record of the call (official 404). Rule 0489 (#1667): the freeze stays while the turn is under 24 hours old
 * (the provider's records may lag), then the recovery job refunds it. The disposable database's clock for this one turn is moved
 * back 25 hours to reach the second half; nothing else is changed.
 */
async function expectHeldThenRefunded(turn: Turn, before: number) {
  const bob = seed().users.bob;
  await runRecovery();
  const held = (await turns(bob.id)).find(t => t.id === turn.id)!;
  expect(held.settlement, 'under 24 hours the unknown cost stays frozen').toBe('pending');
  expect((await ledger(bob.id)).credits).toBe(before - held.reserved);
  await db()`update turns set opened_at = opened_at - interval '25 hours', recovery_lease_until = null
    where actor_id = ${bob.id}::uuid and id = ${turn.id}::bigint`;
  const calls = await db()`select seq, call_kind, status, provider_id is not null as has_provider_id, cost_pending
    from turn_calls where actor_id = ${bob.id}::uuid and turn_id = ${turn.id}::bigint order by seq`;
  test.info().annotations.push({ type: 'turn-calls', description: JSON.stringify(calls) });
  const settled = await expectSettledBy(turn.id, before);
  expect(settled.charged ?? 0, 'refunded in full').toBe(0);
  expect((await ledger(bob.id)).credits).toBe(before);
}

test('stream cut and the provider has no record: frozen for 24 hours, then refunded once (0489)', async ({ page }) => {
  const { turn, before } = await failedTurn(page, { mode: 'cut', receipt: false });
  expect(turn.close_kind).toBe('interrupted');
  await expectHeldThenRefunded(turn, before);
});

test('provider timeout after its headers (240 s deadline): the turn closes, its freeze is held, then refunded once', async ({ page }) => {
  test.setTimeout(12 * 60_000);
  const { turn, before } = await failedTurn(page, { mode: 'timeout' }, 420_000);
  await expectHeldThenRefunded(turn, before);
});

// Known gap, reported (not a pass): when the provider sends nothing at all before the 240 s deadline, the call has no generation id,
// so the recovery job can never look it up and rule 0489 (which needs the provider's own "not found") never applies: the freeze has
// no automatic exit. Observed with the simulator on 2026-11-03 (turn_calls: status unknown, cost_pending, provider_id null).
// Whether such a freeze is refunded is a billing decision for the Owner; until then this case is listed, not asserted.
test.fixme('provider silent until the deadline (no generation id): the freeze has an automatic exit', async ({ page }) => {
  test.setTimeout(10 * 60_000);
  const { turn, before } = await failedTurn(page, { mode: 'silent' }, 300_000);
  await expectHeldThenRefunded(turn, before);
});
