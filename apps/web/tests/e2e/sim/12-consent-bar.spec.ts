import { expect, test, type Locator, type Page } from '@playwright/test';

import { replies, resetSim, signIn, startFreeChat, watchPage } from './support';

/**
 * ANALYTICS-CONSENT: the local app has no visitor country, so it counts as an opt-in region and the statistics consent bar shows
 * until the visitor chooses. Every other journey starts with a choice already made (playwright.sim.config.ts); this one starts
 * without, on a phone-width window, and checks that the bar covers nothing at the bottom of the start page and the conversation
 * page, that not choosing yet never calls the server's withdrawal, and that "接受" takes the bar away and gives the space back.
 */
test.beforeEach(resetSim);
test.use({ storageState: { cookies: [], origins: [] }, viewport: { width: 360, height: 740 } });

const bar = (page: Page) => page.getByRole('region', { name: 'Cookie 同意' });

async function expectAbove(target: Locator, page: Page) {
  await target.scrollIntoViewIfNeeded();
  const [box, barBox] = [await target.boundingBox(), await bar(page).boundingBox()];
  expect(box, 'the control is on the page').not.toBeNull();
  expect(barBox, 'the bar is on the page').not.toBeNull();
  expect(box!.y + box!.height, 'the control ends above the bar').toBeLessThanOrEqual(barBox!.y + 1);
}

test('the consent bar covers nothing at the bottom, and an undecided visitor sends no withdrawal', async ({ page }) => {
  const withdrawals: string[] = [];
  page.on('request', request => { if (request.url().includes('analytics.withdrawConsent')) withdrawals.push(request.url()); });
  const evidence = watchPage(page);
  await signIn(page, 'alice');

  await page.goto('/app/positioning');
  await expect(bar(page)).toBeVisible({ timeout: 60_000 }).catch(async error => { await evidence('no consent bar'); throw error; });
  await expectAbove(page.getByRole('textbox', { name: '新任务内容' }), page);
  await expectAbove(page.getByRole('button', { name: '发送', exact: true }), page);

  // The composer and its send button work while the bar shows.
  await startFreeChat(page, '用一句话说明为什么要先想清楚给谁看。');
  await expect(bar(page)).toBeVisible();
  const message = page.getByRole('textbox', { name: '消息' });
  await expect(message).toBeVisible({ timeout: 120_000 });
  await expectAbove(message, page);
  await message.click();

  await page.waitForTimeout(2_000);
  expect(withdrawals, 'not having chosen yet is not a withdrawal').toEqual([]);

  // "接受": the bar goes, the reserved space goes with it, and it stays gone after a reload.
  await bar(page).getByRole('button', { name: '接受' }).click();
  await expect(bar(page)).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.style.getPropertyValue('--consent-bar-space'))).toBe('');
  await page.reload();
  await expect(message).toBeVisible({ timeout: 60_000 });
  await expect(bar(page)).toHaveCount(0);
  expect(withdrawals).toEqual([]);
});

// Validation of #1816 (step 11): with the bar shown the phone drawer got shorter and squeezed its list to nothing, so an existing
// conversation in it could not be clicked. The list keeps a usable height and scrolls as a whole.
// MOBILE-UX (Owner 2026-11-12, phone plan A): on a phone the pages with the bottom bar no longer open a drawer; that same list is
// the 对话 page, reached from the bar. What this guards is unchanged: with the consent bar shown, the way to an existing conversation
// is not under the bar (the bottom bar stands on it), the list keeps a usable height, and the conversation opens.
test('with the consent bar shown, an existing conversation opens from the phone\'s 对话 page', async ({ page }) => {
  const evidence = watchPage(page);
  await signIn(page, 'alice');
  const session = await startFreeChat(page, '用一句话说明为什么要先想清楚给谁看。');
  await expect(replies(page).first()).toBeVisible({ timeout: 120_000 }).catch(async error => { await evidence('no reply'); throw error; });

  await page.goto('/app/positioning');
  await expect(bar(page)).toBeVisible({ timeout: 60_000 });
  // The phone's bottom bar is the way round: it shows, whole, above the consent bar, and the drawer's button is gone.
  const tabs = page.getByRole('navigation', { name: '主导航' });
  await expect(tabs).toBeVisible({ timeout: 60_000 }).catch(async error => { await evidence('no bottom bar'); throw error; });
  await expectAbove(tabs, page);
  await expect(page.getByRole('button', { name: '打开导航' })).toHaveCount(0);
  await tabs.getByRole('link', { name: '对话' }).click();
  await page.waitForURL(url => url.pathname === '/app/chats', { timeout: 60_000 });
  await expect(bar(page)).toBeVisible();

  const list = page.getByLabel('平台、账号与工作');
  const row = list.locator(`a[href="/app/runtime?session=${session}"]`);
  await expect(row).toBeVisible({ timeout: 60_000 }).catch(async error => { await evidence('conversation not in the list'); throw error; });
  expect((await list.boundingBox())!.height, 'the list keeps a usable height').toBeGreaterThanOrEqual(100);
  await expectAbove(row, page);
  // …and above the bottom bar, which stands on the consent bar.
  const [rowBox, tabsBox] = [await row.boundingBox(), await tabs.boundingBox()];
  expect(rowBox!.y + rowBox!.height, 'the row ends above the bottom bar').toBeLessThanOrEqual(tabsBox!.y + 1);
  await row.click();
  await page.waitForURL(url => url.searchParams.get('session') === session, { timeout: 60_000 });
  await expect(page.getByRole('textbox', { name: '消息' })).toBeVisible({ timeout: 60_000 });
});
