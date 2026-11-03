import { expect, test, type Page } from '@playwright/test';

import { replies, resetSim, signIn, startFreeChat } from './support';

/**
 * A read that fails for a moment must not leave a piece of the page missing without a word (2026-11-03: the save-to-library button
 * stayed away after one refused read). The conversation page reads its results folder with opc.sessionResults:
 *  - a procedure's own server failure (a tRPC error) is asked again, twice, with a wait;
 *  - the web proxy's 503 (plain JSON, Retry-After 60, as apps/web/src/proxy.ts answers when its rate-limit backend is slow) is not asked
 *    again sooner than it asked: the page says the read failed and offers 重试, which asks later.
 */
test.beforeEach(resetSim);

const READ = 'opc.sessionResults';
const procedureFailure = JSON.stringify([{ error: { message: 'Internal error', code: -32603, data: { code: 'INTERNAL_SERVER_ERROR', httpStatus: 500 } } }]);
const proxyUnavailable = JSON.stringify({ error: 'Service Unavailable', message: '服务暂时繁忙，请稍后再试', retryAfter: 60 });

/** Answers the next `times` reads of the results folder (Infinity: all of them) the way `kind` says, then lets them through. */
async function refuseReads(page: Page, kind: 'procedure' | 'proxy', times: number) {
  let left = times;
  const seen = { refused: 0 };
  await page.route(url => url.pathname.startsWith('/api/trpc/') && decodeURIComponent(url.pathname).includes(READ), async route => {
    if (left <= 0) { await route.continue(); return; }
    left -= 1;
    seen.refused += 1;
    if (kind === 'procedure') await route.fulfill({ status: 500, contentType: 'application/json', body: procedureFailure });
    else await route.fulfill({ status: 503, contentType: 'application/json', headers: { 'retry-after': '60' }, body: proxyUnavailable });
  });
  return seen;
}

test('a refused read of the results folder is asked again; a proxy 503 is said with a retry, not asked sooner than it asked', async ({ page }) => {
  await signIn(page, 'bob');
  await startFreeChat(page, '读取失败的恢复：说一句话。');
  await expect(replies(page).first()).toBeVisible({ timeout: 120_000 });
  const notice = page.getByRole('alert').filter({ hasText: '本对话成果夹' });

  // A procedure failure once: asked again after a second, then the button is there, and nothing is said.
  const once = await refuseReads(page, 'procedure', 1);
  await page.reload();
  await expect(replies(page).first()).toBeVisible({ timeout: 60_000 });
  expect(once.refused, 'the first read was refused, the second one answered').toBe(1);
  await expect(notice).toHaveCount(0);
  await page.unrouteAll({ behavior: 'wait' });

  // The proxy's 503 with Retry-After 60 every time: the page says the read failed, with 重试, and did not ask again within a second.
  const proxy = await refuseReads(page, 'proxy', Number.POSITIVE_INFINITY);
  await page.reload();
  await expect(notice).toBeVisible({ timeout: 60_000 });
  await expect(notice).toContainText('读取失败');
  await page.waitForTimeout(4_000);
  expect(proxy.refused, 'asked once: the proxy asked for a longer wait than the retries use').toBe(1);
  await expect(replies(page)).toHaveCount(0);

  // The server is back: 重试 brings the button.
  await page.unrouteAll({ behavior: 'wait' });
  await notice.getByRole('button', { name: '重试' }).click();
  await expect(replies(page).first()).toBeVisible({ timeout: 30_000 });
  await expect(notice).toHaveCount(0);
});
