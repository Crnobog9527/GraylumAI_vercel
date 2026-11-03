import { expect, test } from '@playwright/test';

import { expectNothingFrozen, lastTurnId, ledger, readSidebarCredits, replies, resetSim, seed, sidebarCredits, signIn, startFreeChat, turns } from './support';

/**
 * Free chat on the simulated model: one message is one charged turn; the sidebar balance follows without a reload and matches the
 * account and its credit records; the reply survives a reload, and the reload opens nothing.
 */
test.beforeEach(resetSim);

test('free chat: one message is one charged turn, the sidebar follows, a reload keeps the reply and opens nothing', async ({ page }) => {
  const alice = seed().users.alice;
  await signIn(page, 'alice');
  const before = (await ledger(alice.id)).credits;
  const mark = await lastTurnId(alice.id);

  const session = await startFreeChat(page, '用两句话说明新账号为什么要先想清楚给谁看。');
  await expect(replies(page).first()).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText(/测试测试/).first()).toBeVisible();
  await expectNothingFrozen(alice.id);

  const opened = await turns(alice.id, mark);
  expect(opened.map(t => t.kind), 'one message opened exactly one turn').toEqual(['chat']);
  expect(opened[0]).toMatchObject({ session_id: session, close_kind: 'completed', settlement: 'done' });
  expect(opened[0]!.charged).toBeGreaterThan(0);

  // Real-validation bug: the balance must follow without a reload, and equal the account and its newest credit record.
  const after = await ledger(alice.id);
  expect(after.credits).toBe(before - opened[0]!.charged!);
  expect(after.recorded, 'the newest credit record leaves the same balance').toBe(after.credits);
  await expect.poll(() => readSidebarCredits(page), { message: 'the sidebar shows the new balance without a reload' }).toBe(after.credits);

  await page.reload();
  await expect(replies(page).first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/测试测试/).first()).toBeVisible();
  await expect(sidebarCredits(page)).toBeVisible();
  await page.waitForTimeout(3_000);
  expect((await turns(alice.id, mark)).length, 'a reload opens no turn').toBe(1);
});

// Real-validation bug (round 9): opening the voice page or a conversation list started paid turns. Merely looking opens nothing.
test('opening the start page, the library and the voice tab opens no turn and charges nothing', async ({ page }) => {
  const bob = seed().users.bob;
  await signIn(page, 'bob');
  await expectNothingFrozen(bob.id);
  const before = (await ledger(bob.id)).credits;
  const mark = await lastTurnId(bob.id);
  for (const path of ['/app/positioning', '/app/library', '/app/library?tab=voice']) {
    await page.goto(path);
    await expect(sidebarCredits(page)).toBeVisible({ timeout: 60_000 });
  }
  await expect(page.getByRole('tab', { name: '我的文风', selected: true })).toBeVisible();
  await page.waitForTimeout(8_000);
  expect(await turns(bob.id, mark), 'looking opens no turn').toEqual([]);
  expect((await ledger(bob.id)).credits).toBe(before);
});
