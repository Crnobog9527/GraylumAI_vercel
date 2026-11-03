import { expect, test } from '@playwright/test';

import { replies, resetSim, seed, signIn, startFreeChat, watchPage } from './support';

/**
 * UI-FINISH: after a reload the open conversation and the sidebar list are on screen at once from what this browser saved, with no
 * "loading" words, even while every read to the server is held; and a different user signing in on the same browser sees none of it.
 */
test.beforeEach(resetSim);

const WAITING_WORDS = /正在读取|读取中|加载中/;
const HOLD = /\/api\/(turn|trpc)/;

test('a reload shows the last conversation and the list at once, and another user sees none of it', async ({ page, context }) => {
  const evidence = watchPage(page);
  await signIn(page, 'alice');
  const session = await startFreeChat(page, '用两句话说明新账号为什么要先想清楚给谁看。');
  await expect(replies(page).first()).toBeVisible({ timeout: 120_000 }).catch(async error => { await evidence('after the reply'); throw error; });
  // The page saves a moment after a read changes; leaving the page flushes it too.
  await page.waitForTimeout(2_500);

  // Hold every read to the server: whatever shows up in the first frames can only come from the saved copy.
  await page.route(HOLD, () => new Promise(() => undefined));
  await page.reload({ waitUntil: 'commit' });
  await expect(page.getByText(/测试测试/).first()).toBeVisible({ timeout: 15_000 }).catch(async error => { await evidence('held reload'); throw error; });
  await expect(replies(page).first()).toBeVisible();
  // The full interface, not a placeholder: the input box is there and can be typed into while the reads are still held.
  await page.getByRole('textbox').first().click();
  await page.keyboard.insertText('草稿');
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText(WAITING_WORDS);
  expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('graylum:')).length)).toBeGreaterThan(0);

  // Phone width: the same first frame, nothing overflowing sideways.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByText(/测试测试/).first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no sideways scroll at 390px').toBe(true);
  await page.screenshot({ path: test.info().outputPath('reload-390.png'), fullPage: false });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.unroute(HOLD);

  // Another user on the same browser: nothing of the first user's saved data is shown, and it is not kept.
  await context.clearCookies();
  await page.route(HOLD, () => new Promise(() => undefined));
  await page.goto('/login', { waitUntil: 'commit' });
  await page.unroute(HOLD);
  await signIn(page, 'bob');
  await page.goto(`/app/runtime?session=${session}`);
  await page.waitForTimeout(3_000);
  await expect(page.getByText(/测试测试/)).toHaveCount(0);
  const kept = await page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith('graylum:')).map(([, value]) => value).join(''));
  expect(kept, 'the first user\'s saved data is gone').not.toContain(seed().users.alice.id);
  expect(kept).not.toContain('测试测试');
});
