import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { requireAccounts } from './support/accounts';
import { resultsDirectory } from './support/config';
import { expect, test } from './support/fixtures';
import { buildReadyDraft, stopsInLast24h } from './support/positioning';
import { expectBalanceBack, expectThirteenChapters, finalizeReport, REPORT_PRICE, reportDialog, startReport, stopButton, waitForReportDone } from './support/report';
import { latestReportSettlement, readCredits } from './support/ui';

/**
 * Journeys 1 and 3 share one draft, because every draft costs real research calls: the three steps, then the report,
 * stopped on purpose (free while under two stops in 24 h, then it asks first), then written to the end and finalized.
 */
/** A reused draft whose conversation was deleted (journey 4a of an earlier run) is read-only: no report, no review to work on. */
async function skipIfReadOnly(page: import('@playwright/test').Page) {
  const readOnly = page.getByRole('heading', { name: '定位分析（只读）' });
  const normal = page.getByRole('navigation', { name: '定位步骤' });
  await expect(readOnly.or(normal).first()).toBeVisible({ timeout: 60_000 });
  test.skip(await readOnly.isVisible(), 'the draft\'s conversation was already deleted: it is read-only');
}

test.describe.serial('journey 1 + 3: positioning to a finalized report, with stops', () => {
  // A ready draft can be handed in (CORE_E2E_DRAFT_URL, a path like /app/positioning/<id>) so the later journeys run on their own.
  let draftUrl = process.env.CORE_E2E_DRAFT_URL ? new URL(process.env.CORE_E2E_DRAFT_URL, process.env.PLAYWRIGHT_BASE_URL).toString() : '';

  test('1: three steps to a ready draft', async ({ openAs, meter }) => {
    test.setTimeout(30 * 60_000);
    // Reuse a draft whose three steps are already confirmed (CORE_E2E_DRAFT_URL, a path like /app/positioning/<id>): the benchmark
    // search is the costly part of the run, so a follow-up run of the later journeys does not repeat it.
    if (process.env.CORE_E2E_DRAFT_URL) {
      draftUrl = new URL(process.env.CORE_E2E_DRAFT_URL, process.env.PLAYWRIGHT_BASE_URL).toString();
      return;
    }
    const { page } = await openAs('gold');
    draftUrl = await buildReadyDraft(page, meter);
    // Later runs hand this back in as CORE_E2E_DRAFT_URL, so the costly benchmark search is paid once (see README).
    await mkdir(resultsDirectory, { recursive: true });
    await writeFile(path.join(resultsDirectory, 'ready-draft.txt'), new URL(draftUrl).pathname);
    await meter.finishJourney('journey 1a: three steps');
  });

  test('3: stopping a report refunds it; the next stop asks first', async ({ openAs, meter }) => {
    test.setTimeout(30 * 60_000);
    test.skip(!draftUrl, 'needs the draft from the previous test');
    const gold = (await requireAccounts()).gold;
    const { page } = await openAs('gold');
    await page.goto(draftUrl);
    await skipIfReadOnly(page);

    // A draft that already carries a complete or finalized report offers no way to start one (a reused draft, CORE_E2E_DRAFT_URL):
    // there is nothing to stop. Look at the footer entry: "生成完整报告（N 积分）" starts one, "完整运营策略报告" opens an existing one.
    const startsHere = page.getByRole('button', { name: /^生成完整报告（[\d,]+ 积分）$/ });
    const opens = page.getByRole('button', { name: /^完整运营策略报告$/ });
    // Once the positioning is published the footer has no report entry at all (it offers "修订定位，保留原版本" instead).
    const published = page.getByRole('button', { name: '修订定位，保留原版本' });
    await expect(startsHere.or(opens).or(published).first()).toBeVisible({ timeout: 60_000 });
    test.skip(await published.isVisible(), 'the draft is already published: it has no report to stop');
    if (!(await startsHere.isVisible())) {
      await opens.click();
      const regenerate = reportDialog(page).getByRole('button', { name: /^重新生成/ });
      const hasOutline = await reportDialog(page).getByRole('navigation', { name: '报告目录' }).waitFor({ state: 'visible', timeout: 15_000 }).then(() => true, () => false);
      test.skip(hasOutline && (await regenerate.count()) === 0, 'the draft already has a complete or finalized report: nothing to stop');
      await reportDialog(page).getByRole('button', { name: '关闭完整运营策略报告' }).click();
    }

    const prior = await stopsInLast24h(gold.id);
    const before = await readCredits(page);

    // Free stops: the report is held, stopped within a minute, and the whole price comes back.
    for (let free = prior; free < 2; free += 1) {
      await startReport(page);
      await stopButton(page).click();
      await expect(reportDialog(page).getByText(/已停止/).first()).toBeVisible({ timeout: 60_000 });
      await expectBalanceBack(page, before);
      await meter.checkpoint(`journey 3: free stop ${free + 1}`);
    }

    // The next stop asks first. "继续生成" keeps the report going; "确认停止" charges the part already written.
    await startReport(page);
    await stopButton(page).click();
    const ask = page.getByRole('alertdialog', { name: '确认停止报告？' });
    await expect(ask).toBeVisible({ timeout: 30_000 });
    await expect(ask).toContainText('本次将按已生成部分扣费');
    await ask.getByRole('button', { name: '继续生成' }).click();
    await expect(ask).toBeHidden();
    await expect(stopButton(page)).toBeVisible();

    await stopButton(page).click();
    await expect(ask).toBeVisible({ timeout: 30_000 });
    await ask.getByRole('button', { name: '确认停止' }).click();
    await expect(reportDialog(page).getByText(/已停止/).first()).toBeVisible({ timeout: 60_000 });
    // The charge for the part already written, from the ledger: the 500 hold leaves the balance first and the refund comes back
    // later, so the balance alone would read a charge of about 500. (On staging the status line stayed at "已停止，正在保存已显示的内容…"
    // for minutes while the ledger was already right; the notice text is noted, not asserted.)
    const startedAt = Date.now();
    await expect.poll(async () => {
      const entry = await latestReportSettlement(page);
      return entry !== null && Date.parse(entry.createdAt) > startedAt - 15 * 60_000 && entry.outcome === 'user_stop' ? entry : null;
    }, { timeout: 180_000, intervals: [3000, 5000] }).not.toBeNull();
    const settled = (await latestReportSettlement(page))!;
    test.info().annotations.push({ type: 'paid-stop', description: `consumed ${settled.consumedCredits}, refunded ${settled.refundedCredits} of ${settled.nominalReserved}` });
    expect(settled.consumedCredits).toBeGreaterThan(0);
    expect(settled.consumedCredits).toBeLessThanOrEqual(REPORT_PRICE);
    expect(settled.consumedCredits + settled.refundedCredits).toBe(settled.nominalReserved);
    expect(settled.nominalReserved).toBe(REPORT_PRICE);
    // The page says so too, though late: the status line stays at "已停止，正在保存已显示的内容…" for minutes first.
    await expect(reportDialog(page).getByText(new RegExp(`本次报告扣了 ${settled.consumedCredits} 积分`))).toBeVisible({ timeout: 300_000 });
    await meter.finishJourney('journey 3: stops');
  });

  test('1: the report is written to the end, has 13 chapters, and is finalized', async ({ openAs, meter }) => {
    test.setTimeout(30 * 60_000);
    test.skip(!draftUrl, 'needs the draft from the previous test');
    const { page } = await openAs('gold');
    await page.goto(draftUrl);
    await skipIfReadOnly(page);
    const before = await readCredits(page);
    // A reused draft may already carry a complete report from an earlier run (CORE_E2E_DRAFT_URL): then it is only finalized.
    const entry = page.getByRole('button', { name: /^完整运营策略报告$/ });
    test.skip(await page.getByRole('button', { name: '修订定位，保留原版本' }).waitFor({ state: 'visible', timeout: 5_000 }).then(() => true, () => false),
      'the draft is already published (and its review adopted): there is no report entry left to check');
    let written = false;
    let alreadyFinal = false;
    if (await entry.waitFor({ state: 'visible', timeout: 10_000 }).then(() => true, () => false)) {
      await entry.click();
      // The dialog shows the written report (the outline) with a "定稿" button until it is finalized, and the start button when no
      // report exists yet. Once finalized it has the outline and neither button.
      const outline = reportDialog(page).getByRole('navigation', { name: '报告目录' });
      const start = reportDialog(page).getByRole('button', { name: /^(生成完整报告|重新生成)/ });
      await expect(outline.or(start).first()).toBeVisible({ timeout: 60_000 });
      written = await outline.isVisible();
      alreadyFinal = written && (await reportDialog(page).getByRole('button', { name: '定稿', exact: true }).count()) === 0;
    }
    if (!written) {
      await startReport(page);
      await waitForReportDone(page);
    }
    await expectThirteenChapters(page);
    await meter.checkpoint('journey 1b: report written');
    if (!alreadyFinal) await finalizeReport(page);
    // The fixed price: exactly 500 credits for a report written in this test.
    if (!written) expect(before - (await readCredits(page))).toBe(REPORT_PRICE);
    await meter.finishJourney('journey 1b: report and finalize');
  });

  test('6: the jury reviews the finalized report, the user picks chapter by chapter, and the charge settles by the rules', async ({ openAs, meter }) => {
    test.setTimeout(30 * 60_000);
    test.skip(!draftUrl, 'needs the draft from the previous test');
    const { page } = await openAs('gold');
    await page.goto(draftUrl);
    await skipIfReadOnly(page);
    const before = await readCredits(page);

    // A review that already ran on this draft (a reused draft, or a run that was cut short) is opened instead of paid for again.
    const earlier = page.getByRole('link', { name: /评审完成，去逐章选择|评审团正在审阅，去看看|评审团已暂停，去看看|查看上次评审/ });
    let price = 0;
    let reused = false;
    if (await earlier.first().waitFor({ state: 'visible', timeout: 10_000 }).then(() => true, () => false)) {
      reused = true;
      await earlier.first().click();
    } else {
      await page.getByRole('button', { name: '请评审团审阅报告' }).click();
      const panel = page.locator('section[aria-label="评审团"]');
      await expect(panel).toContainText(/本次评审 [\d,]+ 积分/, { timeout: 60_000 });
      price = Number(/本次评审 ([\d,]+) 积分/.exec(await panel.innerText())![1]!.replace(/,/g, ''));
      await panel.getByRole('button', { name: '开始评审' }).click();
    }
    await page.waitForURL(/\/review\/[0-9a-f-]{36}$/, { timeout: 60_000 });

    // The result page shows its title from the start; the review is over when the per-chapter choice appears, or the page says
    // that no revised draft was written (nothing to choose: the price comes back).
    const chapters = page.getByRole('group', { name: '这一章用哪个版本？' });
    const noDraft = page.getByText(/没有生成修订稿|不需要修改|报告和资料太长|评审没有完成/);
    await expect(chapters.first().or(noDraft.first())).toBeVisible({ timeout: 15 * 60_000 });
    await meter.checkpoint('journey 6: review ran');

    const count = await chapters.count();
    // A review whose choices were already made (a reused draft) shows them locked, with the outcome in place of the confirm bar.
    if (count > 0 && (await chapters.first().getByRole('radio').first().isDisabled())) {
      const outcome = page.getByText(/新版本已生成|你选择全部保留原文|你放弃了这次修改/);
      await expect(outcome.first()).toBeVisible({ timeout: 30_000 });
      test.info().annotations.push({ type: 'jury-already-adopted', description: (await outcome.first().innerText()).slice(0, 200) });
      await meter.finishJourney('journey 6: jury (choices already recorded)');
      return;
    }
    if (count === 0) {
      // Rule: the review price is charged only when a usable revised draft exists; otherwise it is refunded in full.
      test.info().annotations.push({ type: 'jury-no-draft', description: (await noDraft.first().innerText()).slice(0, 200) });
      await expect(page.getByText(/已全额退回|没有扣费|不需要修改/).first()).toBeVisible({ timeout: 120_000 });
      if (!reused) await expectBalanceBack(page, before, 180_000);
      await meter.finishJourney('journey 6: jury (no revised draft)');
      return;
    }
    // Pick a version for every chapter that needs a decision: the revised text for the first, the original for the rest.
    for (let i = 0; i < count; i += 1) {
      const chapter = chapters.nth(i);
      if (i === 0) {
        await chapter.getByRole('radio', { name: '采用修订版' }).check();
        const wording = chapter.getByRole('checkbox', { name: /只改了表述/ });
        if (await wording.count()) await wording.check();
      } else {
        await chapter.getByRole('radio', { name: '保留原文' }).check();
      }
    }
    await expect(page.locator('span[data-complete="true"]').filter({ hasText: `已选 ${count}/${count}` })).toBeVisible();
    await page.getByRole('button', { name: '确认', exact: true }).click();
    await page.getByRole('button', { name: '确认采用，生成新版本' }).click();
    await expect(page.getByText(/新版本已生成/)).toBeVisible({ timeout: 90_000 });

    // Settlement: a usable revised draft was adopted, so the review price is charged in full.
    const charged = page.getByText(/本次评审实际扣了 [\d,]+ 积分/);
    await expect(charged).toBeVisible({ timeout: 120_000 });
    const shown = Number(/本次评审实际扣了 ([\d,]+) 积分/.exec(await charged.innerText())![1]!.replace(/,/g, ''));
    if (!reused) {
      expect(shown).toBe(price);
      expect(before - (await readCredits(page))).toBe(price);
    }
    await meter.finishJourney('journey 6: jury');
  });

  test('4: deleting the conversation of a finalized draft keeps a read-only entry and the old link does not break', async ({ openAs, meter }) => {
    test.skip(!draftUrl, 'needs the draft from the previous test');
    const { page } = await openAs('gold');
    await page.goto('/app/positioning');
    // The draft's row is the <div> holding its link and its "⋯" button; the button only takes clicks while the row is hovered.
    const link = page.getByLabel('平台、账号与工作').locator('a[href$="' + new URL(draftUrl).pathname + '"]').first();
    await expect(link).toBeVisible();
    const row = link.locator('xpath=..');
    // A reused draft whose conversation was already deleted only has to show the read-only state.
    if (await row.getByText('对话已删除 · 只读').isVisible()) {
      await page.goto(draftUrl);
      await expect(page.getByRole('heading', { name: '定位分析（只读）' })).toBeVisible();
      await meter.finishJourney('journey 4a: draft conversation was already deleted');
      return;
    }
    await link.hover();
    await row.getByRole('button', { name: /定位分析的更多操作$/ }).click({ force: true });
    await page.getByRole('menuitem', { name: '删除对话' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('删除后无法恢复');
    await dialog.getByRole('button', { name: '删除', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText('对话已删除 · 只读').first()).toBeVisible();

    await page.goto(draftUrl);
    await expect(page.getByRole('heading', { name: '定位分析（只读）' })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: '这段定位对话已删除' })).toBeVisible();
    await meter.finishJourney('journey 4a: delete draft conversation');
  });
});
