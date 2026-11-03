import { expect, test, type Page } from '@playwright/test';

import { replies, resetSim, signIn, startFreeChat } from './support';

/**
 * A read that fails for a moment must not leave a piece of the page missing without a word (2026-11-03: the save-to-library button
 * stayed away after one refused read). The conversation page reads its results folder with opc.sessionResults: a 503 is asked again
 * (twice, with a wait); if it still fails the page says so and offers 重试.
 */
test.beforeEach(resetSim);

const READ = 'opc.sessionResults';
const refused = JSON.stringify([{ error: { message: 'Service unavailable', code: -32603, data: { code: 'INTERNAL_SERVER_ERROR', httpStatus: 503 } } }]);

/** Answers the next `times` reads of the results folder (Infinity: all of them) with a 503, then lets them through. */
async function refuseReads(page: Page, times: number) {
  let left = times;
  const seen = { refused: 0 };
  await page.route(url => url.pathname.startsWith('/api/trpc/') && decodeURIComponent(url.pathname).includes(READ), async route => {
    if (left > 0) { left -= 1; seen.refused += 1; await route.fulfill({ status: 503, contentType: 'application/json', body: refused }); }
    else await route.continue();
  });
  return seen;
}

test('a refused read of the results folder is asked again, and a persistent failure is said with a retry', async ({ page }) => {
  await signIn(page, 'bob');
  await startFreeChat(page, '读取失败的恢复：说一句话。');
  await expect(replies(page).first()).toBeVisible({ timeout: 120_000 });
  const notice = page.getByRole('alert').filter({ hasText: '本对话成果夹' });

  // One refusal: asked again after a second, then the button is there, and nothing is said.
  const once = await refuseReads(page, 1);
  await page.reload();
  await expect(replies(page).first()).toBeVisible({ timeout: 60_000 });
  expect(once.refused, 'the first read was refused').toBe(1);
  await expect(notice).toHaveCount(0);
  await page.unrouteAll({ behavior: 'wait' });

  // Refused every time: after its retries the page says so, with 重试, instead of just not showing the button.
  const always = await refuseReads(page, Number.POSITIVE_INFINITY);
  await page.reload();
  await expect(notice).toBeVisible({ timeout: 60_000 });
  await expect(notice).toContainText('读取失败');
  expect(always.refused, 'one read and its two retries').toBeGreaterThanOrEqual(3);
  await expect(replies(page)).toHaveCount(0);

  // The server is back: 重试 brings the button.
  await page.unrouteAll({ behavior: 'wait' });
  await notice.getByRole('button', { name: '重试' }).click();
  await expect(replies(page).first()).toBeVisible({ timeout: 30_000 });
  await expect(notice).toHaveCount(0);
});
