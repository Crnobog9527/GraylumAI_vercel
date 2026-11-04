import { randomUUID } from 'node:crypto';

import { type Browser, type Page } from '@playwright/test';

import { expect, test } from './fixtures';

import { armFault, expectNothingFrozen, lastTurnId, ledger, resetSim, seed, signIn, simCalls, turns } from './support';

/**
 * The positioning mentor on the simulated method (seed.ts: three steps, one required field each). Guards for the bugs real validation
 * found: opening a draft starts nothing; "开始这一步" opens exactly one turn; a confirm opens exactly the next step's opening.
 */
test.beforeEach(resetSim);

// Not yet runnable locally (2026-11-03): with V3_RUNTIME_LOCAL_ENDPOINT set (needed for runtime.start on a loopback host) the draft
// page runs its old isolated demo mode ("本地模拟 · 回复、保存与交接均为演示"), not the turn path. These journeys need the local app to
// pass for the staging host instead (synthetic Supabase host routed to the gateway for server and browser, the staging environment,
// and a runtime_test_windows row with frozen call policies), the same work compare and the jury need (about half a day). Deferred by
// the controller on 2026-11-03: the report journey and its stop are left to the final real-model acceptance before launch (layer 3).
const journey = test.fixme;

const coachBox = (page: Page) => page.getByRole('textbox', { name: '给 AI 教练的回复' });
const confirmButton = (page: Page) => page.getByRole('region', { name: '本步确认' })
  .getByRole('button', { name: /^没问题，(进入下一步|确认这一步)$/ });
const busy = (page: Page) =>
  page.getByText(/^(正在查阅方法资料|正文已返回，正在整理|正在保存结果并核对费用|正在回复|正在思考|正在写回复|正在想怎么回复)/);

async function newDraft(page: Page): Promise<string> {
  await page.goto(`/app/positioning?start=mentor&intent=${randomUUID()}`);
  await page.waitForURL(/\/app\/positioning\/[0-9a-f-]{36}$/, { timeout: 120_000 });
  return new URL(page.url()).pathname;
}

/** Waits until the account has `count` turns after `mark`, all closed and settled. */
async function settledTurns(actorId: string, mark: string, count: number) {
  await expect.poll(async () => (await turns(actorId, mark)).map(t => `${t.kind}:${t.state}:${t.settlement ?? '-'}`),
    { message: `${count} settled turn(s)`, timeout: 120_000 }).toEqual(Array.from({ length: count }, () => expect.stringMatching(/^mentor:closed:(done|-)$/)));
  return turns(actorId, mark);
}

async function reopenOpensNothing(browser: Browser, page: Page, path: string, actorId: string) {
  const mark = await lastTurnId(actorId);
  const other = await browser.newContext({ storageState: await page.context().storageState() });
  const tab = await other.newPage();
  await tab.goto(path);
  await expect(tab.getByRole('navigation', { name: '定位步骤' })).toBeVisible({ timeout: 120_000 });
  await tab.waitForTimeout(8_000);
  expect(await turns(actorId, mark), 'opening a draft in a new tab opens no turn').toEqual([]);
  return { other, tab };
}

async function reply(page: Page, text: string) {
  await expect(busy(page)).toHaveCount(0, { timeout: 120_000 });
  await coachBox(page).click();
  await page.keyboard.insertText(text);
  await page.getByRole('button', { name: '发送', exact: true }).click();
}

journey('mentor: a new draft opens one turn, reopening opens none, a reply is one turn, a confirm opens only the next opening', async ({ page, browser }) => {
  const alice = seed().users.alice;
  await signIn(page, 'alice');
  await expectNothingFrozen(alice.id);
  const before = (await ledger(alice.id)).credits;
  const mark = await lastTurnId(alice.id);

  const path = await newDraft(page);
  await settledTurns(alice.id, mark, 1);
  const { other } = await reopenOpensNothing(browser, page, path, alice.id);
  await other.close();

  await reply(page, '我想做上班族快手晚餐的小红书账号。');
  await settledTurns(alice.id, mark, 2);
  await expect(confirmButton(page)).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(2_500); // the card ignores clicks for 2 s after it changes
  await confirmButton(page).click();
  // The confirm starts the next step's opening, and only that.
  const all = await settledTurns(alice.id, mark, 3);
  await page.waitForTimeout(5_000);
  expect((await turns(alice.id, mark)).length, 'nothing else was opened').toBe(3);

  await expectNothingFrozen(alice.id);
  const charged = all.reduce((sum, t) => sum + (t.charged ?? 0), 0);
  const after = await ledger(alice.id);
  expect(after.credits).toBe(before - charged);
  expect(after.recorded).toBe(after.credits);
});

journey('mentor: after a refused opening, reopening offers 开始这一步 and one click opens exactly one turn', async ({ page, browser }) => {
  const bob = seed().users.bob;
  await signIn(page, 'bob');
  await expectNothingFrozen(bob.id);
  const mark = await lastTurnId(bob.id);
  await armFault({ mode: '402' });
  const path = await newDraft(page);
  await settledTurns(bob.id, mark, 1);
  expect((await turns(bob.id, mark))[0]!.charged ?? 0, 'the refused opening charged nothing').toBe(0);

  const { other, tab } = await reopenOpensNothing(browser, page, path, bob.id);
  const start = tab.getByRole('button', { name: '开始这一步' });
  await expect(start).toBeVisible({ timeout: 60_000 });
  const before = await lastTurnId(bob.id);
  await start.click();
  await settledTurns(bob.id, before, 1);
  await tab.waitForTimeout(5_000);
  expect((await turns(bob.id, before)).length, '开始这一步 opens exactly one turn').toBe(1);
  await other.close();
  await expectNothingFrozen(bob.id);
});

journey('mentor: a malformed organizer answer keeps the delivered reply, settles once, applies nothing', async ({ page }) => {
  const carol = seed().users.carol;
  await signIn(page, 'carol');
  await newDraft(page);
  const mark = await lastTurnId(carol.id);
  await expect(busy(page)).toHaveCount(0, { timeout: 120_000 });
  await armFault({ mode: 'malformed', target: 'organizer' });
  await reply(page, '模拟：整理结果损坏。');
  const [turn] = await settledTurns(carol.id, mark, 1);
  expect(turn!.close_kind).toBe('completed');
  expect((await simCalls()).some(c => c.role === 'organizer' && c.fault === 'malformed')).toBe(true);
  // The broken patch applied nothing: the step is not ready to confirm.
  await expect(confirmButton(page)).toHaveCount(0);
  await expectNothingFrozen(carol.id);
});
