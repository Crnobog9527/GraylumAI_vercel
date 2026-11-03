import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { requireAccounts } from './support/accounts';
import { resultsDirectory } from './support/config';
import { expect, requireBudget, test } from './support/fixtures';
import { startFreeChat, waitForRuntimeTurn } from './support/freeChat';
import { completeBenchmarkStep, completeStep, PERSONA, startPositioning, stopsInLast24h } from './support/positioning';
import { expectBalanceBack, reportDialog, startReport, stopButton } from './support/report';
import { lastTurnId, settledTurnsAfter, turnsAfter } from './support/turns';
import { readCredits, sendAndWait, settleOpening, stepNav } from './support/ui';

/**
 * The daily real-model smoke check (layer 2, Owner 2026-11-03): a few short journeys on staging's own configuration, at most
 * $0.50 a UTC day for all runs together (CORE_E2E_DAILY=1). Each journey is skipped, not started, when its usual cost no longer
 * fits; the compare journey (05, also @daily) runs before these. The global teardown (support/teardown.ts) lists every turn the
 * run touched and fails the run if any is still open or unsettled, also when a journey failed or the cap stopped the run. Run with: pnpm test:e2e:core-path:daily (README, "每日真实模型检查").
 */
// Not a serial group: a failed or capped journey must not skip the ones after it, above all the last check for frozen credits.
// One worker runs the tests in file order (playwright.core-path.config.ts); the benchmark journey skips without the mentor's draft.

/** About what each journey costs on staging's models (2026-10 measurements, rounded up); used only to skip, never to bill. */
const RESERVE = { chat: 0.05, mentor: 0.08, report: 0.05, benchmark: 0.3, finish: 0.15 };
const draftFile = () => path.join(resultsDirectory, 'daily-draft.txt');
const readyDraftFile = () => path.join(resultsDirectory, 'ready-draft.txt');
const CANDIDATES = 'section[aria-label="对标候选账号"], section[aria-label="补选对标账号"]';

test('daily: one free-chat message is one charged turn and survives a reload @daily', async ({ openAs, meter }) => {
  test.setTimeout(6 * 60_000);
  await requireBudget(meter, RESERVE.chat);
  const pro = (await requireAccounts()).pro;
  const { page } = await openAs('pro');
  await page.goto('/app/profile');
  const before = await readCredits(page);
  const mark = await lastTurnId(pro.id);

  const session = await startFreeChat(page, '用两句话说明新账号为什么要先想清楚给谁看。');
  await waitForRuntimeTurn(page);
  const turns = await settledTurnsAfter(pro.id, mark);
  expect(turns.map(turn => turn.kind), 'one message opened exactly one chat turn').toEqual(['chat']);
  const [turn] = turns;
  expect(turn!.sessionId).toBe(session);
  expect(turn!.closeKind).toBe('completed');
  expect(turn!.charged ?? 0, 'the turn was charged').toBeGreaterThan(0);
  await expect.poll(() => readCredits(page), { message: 'the balance moved by exactly the turn charge', timeout: 60_000 }).toBe(before - turn!.charged!);

  // The reply is saved: after a reload it is still there and nothing new was opened.
  await page.reload();
  await expect(page.getByRole('button', { name: /保存到成果夹|再存一段到成果夹/ }).first()).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(5_000);
  expect((await turnsAfter(pro.id, mark)).length, 'a reload opens no turn').toBe(1);
  test.info().annotations.push({ type: 'turn', description: `chat ${turn!.id}: ${turn!.charged} credits` });
  await meter.finishJourney('daily: free chat');
});

test('daily: a new draft opens one turn, reopening it opens none, one mentor reply is one turn @daily', async ({ openAs, meter, browser }) => {
  test.setTimeout(8 * 60_000);
  await requireBudget(meter, RESERVE.mentor);
  const gold = (await requireAccounts()).gold;
  const { page } = await openAs('gold');
  const mark = await lastTurnId(gold.id);
  const url = await startPositioning(page);
  await settleOpening(page);
  const opening = await settledTurnsAfter(gold.id, mark);
  // The opening is a paid turn of its own: stop here if it took the day past the cap, before the next paid message.
  await meter.checkpoint('daily: mentor opening');
  expect(opening.map(turn => turn.kind), 'starting a draft opens at most its first step\'s opening').toEqual(opening.length ? ['mentor'] : []);
  await mkdir(resultsDirectory, { recursive: true });
  await writeFile(draftFile(), new URL(url).pathname);

  // Real-validation bug (round 9): opening a draft in a new tab must start nothing and charge nothing.
  const afterOpening = await lastTurnId(gold.id);
  // A new context carries the sign-in cookies but not the tab's sessionStorage, where the "user asked for an opening" mark lives.
  const other = await browser.newContext({ storageState: await page.context().storageState() });
  const reopened = await other.newPage();
  await reopened.goto(new URL(url).pathname);
  await expect(reopened.getByRole('navigation', { name: '定位步骤' })).toBeVisible({ timeout: 60_000 });
  await reopened.waitForTimeout(10_000);
  expect(await turnsAfter(gold.id, afterOpening), 'reopening a draft opens no turn').toEqual([]);
  await other.close();

  await sendAndWait(page, PERSONA.intro, meter, 'daily: mentor reply');
  const reply = await settledTurnsAfter(gold.id, afterOpening);
  expect(reply.map(turn => turn.kind), 'one message to the coach is one mentor turn').toEqual(['mentor']);
  expect(reply[0]!.charged ?? 0).toBeGreaterThan(0);
  test.info().annotations.push({ type: 'turn', description: [...opening, ...reply].map(turn => `${turn.kind} ${turn.id}: ${turn.charged}`).join('; ') });
  await meter.finishJourney('daily: mentor step');
});

test('daily: the benchmark confirm opens one turn and fills the table @daily', async ({ openAs, meter }) => {
  test.setTimeout(20 * 60_000);
  await requireBudget(meter, RESERVE.benchmark);
  const draft = await readFile(draftFile(), 'utf8').catch(() => '');
  test.skip(!draft, 'needs the draft from the mentor journey');
  const gold = (await requireAccounts()).gold;
  const { page } = await openAs('gold');
  await page.goto(draft);
  await completeStep(page, meter, 'daily: step 1', PERSONA.fill);
  const mark = await lastTurnId(gold.id);
  try { await completeBenchmarkStep(page, meter); }
  catch (error) {
    // Known supplier gap (Xiaohongshu search returned no data, 2026-11-03): no candidate card at all is a skip, not a failure.
    if (await page.locator(CANDIDATES).count()) throw error;
    await meter.finishJourney('daily: benchmark (no candidates)');
    test.skip(true, 'skipped: the search supplier returned no candidates (供应商无数据)');
  }
  const turns = await settledTurnsAfter(gold.id, mark);
  test.info().annotations.push({ type: 'turn', description: turns.map(turn => `${turn.kind} ${turn.id}: ${turn.charged}`).join('; ') });
  await meter.finishJourney('daily: benchmark');

  // The report-stop journey needs a draft with its three steps confirmed and a qualified benchmark: finish this one once and keep
  // it (the runner saves ready-draft.txt and hands it back as CORE_E2E_DRAFT_URL), so the paid search is not repeated every day.
  if (process.env.CORE_E2E_DRAFT_URL) return;
  await requireBudget(meter, RESERVE.finish);
  await completeStep(page, meter, 'daily: step 2', '请根据对标结果给出可行性和平台选择，我同意你的建议。');
  await completeStep(page, meter, 'daily: step 3', '请给出定位、资料包、第一个月计划和变现方案，我同意你的建议。');
  await expect(stepNav(page).getByRole('button').filter({ hasText: '✓' })).toHaveCount(3);
  await writeFile(readyDraftFile(), draft);
  await meter.finishJourney('daily: ready draft for the report');
});



test('daily: a report stopped at once is refunded in full @daily', async ({ openAs, meter }) => {
  test.setTimeout(8 * 60_000);
  await requireBudget(meter, RESERVE.report);
  // A draft whose three steps are confirmed with a qualified benchmark: the kept one (CORE_E2E_DRAFT_URL) or the one the benchmark
  // journey just finished. Without either (the search had no data, or the budget ran out first) there is nothing to stop.
  const readyDraft = process.env.CORE_E2E_DRAFT_URL || await readFile(readyDraftFile(), 'utf8').catch(() => '');
  test.skip(!readyDraft, 'no ready draft yet (the benchmark journey makes one)');
  const gold = (await requireAccounts()).gold;
  // Only the first two stops in 24 hours are free; a third would charge, which the daily check does not do.
  test.skip(await stopsInLast24h(gold.id) >= 2, 'two report stops in the last 24 hours: a third would charge');
  const { page } = await openAs('gold');
  await page.goto(readyDraft);
  const entry = page.getByRole('button', { name: /^(生成完整报告（[\d,]+ 积分）|完整运营策略报告)$/ });
  const ready = await entry.first().waitFor({ state: 'visible', timeout: 60_000 }).then(() => true, () => false);
  // A kept draft that can no longer start a report (published, or its conversation deleted) is a failure to look at, not a skip.
  expect(ready, 'the ready draft offers a report').toBe(true);
  const before = await readCredits(page);
  const mark = await lastTurnId(gold.id);
  await startReport(page);
  await stopButton(page).click();
  await expect(reportDialog(page).getByText(/已停止/).first()).toBeVisible({ timeout: 60_000 });
  await expectBalanceBack(page, before, 120_000);
  const turns = (await settledTurnsAfter(gold.id, mark)).filter(turn => turn.kind === 'report');
  expect(turns).toHaveLength(1);
  expect(turns[0]).toMatchObject({ stoppedByUser: true, charged: 0 });
  test.info().annotations.push({ type: 'turn', description: `report ${turns[0]!.id}: stopped, refunded ${turns[0]!.reserved}` });
  await meter.finishJourney('daily: report stop');
});
