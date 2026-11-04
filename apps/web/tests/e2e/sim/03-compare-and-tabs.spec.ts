import { expect, test } from './fixtures';

import { expectNothingFrozen, lastTurnId, ledger, readSidebarCredits, replies, resetSim, seed, signIn, simCalls, startFreeChat, turns } from './support';

test.beforeEach(resetSim);

/**
 * Multi-model compare (Gold): one compare is one turn; both columns answer; the total shown is the sum of the columns and is what the
 * balance and the credit records lost; nothing stays frozen.
 */
// Not yet runnable locally: the compare picker's options (services/fusion/compareOptions.ts) read the host's staging window policy
// (loadStagingPolicy), which the local stack does not emulate yet; the button stays hidden. Needs the same staging-host emulation as
// 04-mentor.spec.ts; deferred by the controller on 2026-11-03.
test.fixme('compare: one turn, two answered columns, the total is the sum of the columns and what the balance lost', async ({ page }) => {
  const carol = seed().users.carol;
  await signIn(page, 'carol');
  await startFreeChat(page, '用一句话说明小红书和抖音的内容分发区别。');
  await expect(replies(page).first()).toBeVisible({ timeout: 120_000 });
  await expectNothingFrozen(carol.id);
  const before = (await ledger(carol.id)).credits;
  const mark = await lastTurnId(carol.id);

  await page.getByRole('textbox', { name: '消息' }).click();
  await page.keyboard.insertText('用两句话说明为什么新账号要先做定位。');
  await page.getByRole('button', { name: '多模型对比' }).click();
  const picker = page.getByRole('dialog', { name: '多模型对比' });
  await expect(picker).toBeVisible();
  const boxes = picker.getByRole('checkbox');
  await expect(boxes).toHaveCount(2);
  for (let i = 0; i < 2; i += 1) if (!(await boxes.nth(i).isChecked())) await boxes.nth(i).check();
  await expect(picker.getByText(/最多消耗/)).toBeVisible({ timeout: 60_000 });
  await picker.getByRole('button', { name: '开始对比' }).click();

  const card = page.getByRole('region', { name: '多模型对比' });
  await expect(card.getByRole('article')).toHaveCount(2, { timeout: 60_000 });
  const total = card.getByText(/本次对比共扣 \d+ 积分/);
  await expect(total).toBeVisible({ timeout: 120_000 });
  const charges: number[] = [];
  for (let i = 0; i < 2; i += 1) {
    const column = card.getByRole('article').nth(i);
    await expect(column).not.toContainText('没有回答');
    charges.push(Number(/实际扣费 (\d+) 积分/.exec(await column.getByText(/实际扣费 \d+ 积分/).innerText())![1]));
  }
  const shown = Number(/本次对比共扣 (\d+) 积分/.exec(await total.innerText())![1]);
  expect(shown).toBe(charges[0]! + charges[1]!);

  await expectNothingFrozen(carol.id);
  const opened = await turns(carol.id, mark);
  expect(opened.map(t => t.kind), 'one compare is one turn').toEqual(['compare']);
  expect(opened[0]!.charged).toBe(shown);
  const after = await ledger(carol.id);
  expect(after.credits).toBe(before - shown);
  expect(after.recorded).toBe(after.credits);
  await expect.poll(() => readSidebarCredits(page)).toBe(after.credits);
  expect((await simCalls()).filter(c => c.role === 'primary').length, 'one call per column, after the chat turn').toBe(3);
});

/** Two tabs of one account, a message in each at the same time: two turns, both settled, the balance lost exactly both charges. */
test('two tabs at once: two turns, both settled, charged exactly once each', async ({ browser }) => {
  const alice = seed().users.alice;
  const context = await browser.newContext();
  const first = await context.newPage();
  await signIn(first, 'alice');
  const second = await context.newPage();
  await expectNothingFrozen(alice.id);
  const before = (await ledger(alice.id)).credits;
  const mark = await lastTurnId(alice.id);

  await Promise.all([startFreeChat(first, '第一个标签页：说一句话。'), startFreeChat(second, '第二个标签页：说一句话。')]);
  await Promise.all([first, second].map(page => expect(replies(page).first()).toBeVisible({ timeout: 120_000 })));
  await expectNothingFrozen(alice.id);
  const opened = await turns(alice.id, mark);
  expect(opened.map(t => t.kind)).toEqual(['chat', 'chat']);
  expect(new Set(opened.map(t => t.session_id)).size, 'each tab has its own conversation').toBe(2);
  const charged = opened.reduce((sum, t) => sum + (t.charged ?? 0), 0);
  const after = await ledger(alice.id);
  expect(after.credits).toBe(before - charged);
  expect(after.recorded).toBe(after.credits);
  await context.close();
});
