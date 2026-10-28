import { requireAccounts } from './support/accounts';
import { expect, test } from './support/fixtures';
import { buildReadyDraft, stopsInLast24h } from './support/positioning';
import { expectBalanceBack, expectThirteenChapters, finalizeReport, REPORT_PRICE, reportDialog, startReport, stopButton, waitForReportDone } from './support/report';
import { readCredits } from './support/ui';

/**
 * Journeys 1 and 3 share one draft, because every draft costs real research calls: the three steps, then the report,
 * stopped on purpose (free while under two stops in 24 h, then it asks first), then written to the end and finalized.
 */
test.describe.serial('journey 1 + 3: positioning to a finalized report, with stops', () => {
  let draftUrl = '';

  test('1: three steps to a ready draft', async ({ openAs, meter }) => {
    test.setTimeout(30 * 60_000);
    const { page } = await openAs('gold');
    draftUrl = await buildReadyDraft(page, meter);
    await meter.finishJourney('journey 1a: three steps');
  });

  test('3: stopping a report refunds it; the next stop asks first', async ({ openAs, meter }) => {
    test.setTimeout(30 * 60_000);
    test.skip(!draftUrl, 'needs the draft from the previous test');
    const gold = (await requireAccounts()).gold;
    const { page } = await openAs('gold');
    await page.goto(draftUrl);

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
    await expect(reportDialog(page).getByText(/本次报告扣了 \d+ 积分/)).toBeVisible({ timeout: 90_000 });
    const afterPaidStop = await readCredits(page);
    expect(before - afterPaidStop).toBeGreaterThan(0);
    expect(before - afterPaidStop).toBeLessThanOrEqual(REPORT_PRICE);
    await meter.finishJourney('journey 3: stops');
  });

  test('1: the report is written to the end, has 13 chapters, and is finalized', async ({ openAs, meter }) => {
    test.setTimeout(30 * 60_000);
    test.skip(!draftUrl, 'needs the draft from the previous test');
    const { page } = await openAs('gold');
    await page.goto(draftUrl);
    const before = await readCredits(page);
    await startReport(page);
    await waitForReportDone(page);
    await expectThirteenChapters(page);
    await meter.checkpoint('journey 1b: report written');
    await finalizeReport(page);
    // The fixed price: exactly 500 credits for a finished report.
    expect(before - (await readCredits(page))).toBe(REPORT_PRICE);
    await meter.finishJourney('journey 1b: report and finalize');
  });

  test('6: the jury reviews the finalized report, the user picks chapter by chapter, and the charge settles by the rules', async ({ openAs, meter }) => {
    test.setTimeout(30 * 60_000);
    test.skip(!draftUrl, 'needs the draft from the previous test');
    const { page } = await openAs('gold');
    await page.goto(draftUrl);
    const before = await readCredits(page);

    await page.getByRole('button', { name: '请评审团审阅报告' }).click();
    const panel = page.locator('section[aria-label="评审团"]');
    await expect(panel).toContainText(/本次评审 [\d,]+ 积分/, { timeout: 60_000 });
    const price = Number(/本次评审 ([\d,]+) 积分/.exec(await panel.innerText())![1]!.replace(/,/g, ''));
    await panel.getByRole('button', { name: '开始评审' }).click();
    await page.waitForURL(/\/review\/[0-9a-f-]{36}$/, { timeout: 60_000 });
    await expect(page.getByRole('heading', { name: '评审团的结果' })).toBeVisible({ timeout: 12 * 60_000 });
    await meter.checkpoint('journey 6: review ran');

    // Pick a version for every chapter that needs a decision: the revised text for the first, the original for the rest.
    const chapters = page.getByRole('group', { name: '这一章用哪个版本？' });
    const count = await chapters.count();
    expect(count, 'the jury marked at least one chapter').toBeGreaterThan(0);
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
    await expect(page.getByText(`已选 ${count}/${count}`)).toBeVisible();
    await page.getByRole('button', { name: '确认', exact: true }).click();
    await page.getByRole('button', { name: '确认采用，生成新版本' }).click();
    await expect(page.getByText(/新版本已生成/)).toBeVisible({ timeout: 90_000 });

    // Settlement: a usable revised draft was adopted, so the review price is charged in full.
    await expect(page.getByText(new RegExp(`本次评审实际扣了 ${price.toLocaleString('zh-CN')} 积分`))).toBeVisible({ timeout: 120_000 });
    expect(before - (await readCredits(page))).toBe(price);
    await meter.finishJourney('journey 6: jury');
  });

  test('4: deleting the conversation of a finalized draft keeps a read-only entry and the old link does not break', async ({ openAs, meter }) => {
    test.skip(!draftUrl, 'needs the draft from the previous test');
    const { page } = await openAs('gold');
    await page.goto('/app/positioning');
    const row = page.locator('a[href$="' + new URL(draftUrl).pathname + '"]').first();
    await expect(row).toBeVisible();
    await page.getByRole('button', { name: /定位分析的更多操作$/ }).first().click();
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
