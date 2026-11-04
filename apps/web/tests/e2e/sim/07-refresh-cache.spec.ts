import { expect, test } from './fixtures';

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
  const hydrationErrors: string[] = [];
  page.on('pageerror', error => { if (/hydrat/i.test(error.message)) hydrationErrors.push(error.message.slice(0, 120)); });
  page.on('console', message => { if (message.type() === 'error' && /hydrat/i.test(message.text())) hydrationErrors.push(message.text().slice(0, 120)); });
  await signIn(page, 'alice');
  const session = await startFreeChat(page, '用两句话说明新账号为什么要先想清楚给谁看。');
  await expect(replies(page).first()).toBeVisible({ timeout: 120_000 }).catch(async error => { await evidence('after the reply'); throw error; });
  // The page saves a moment after a read changes; leaving the page flushes it too.
  await page.waitForTimeout(2_500);

  // Hold every read to the server: whatever shows up in the first frames can only come from the saved copy.
  await page.route(HOLD, () => new Promise(() => undefined));
  // Any frame in which the page's own scripts have drawn a placeholder counts, however short: the saved copy must be there from the first
  // render. (The server's HTML, before any script ran, cannot know what this browser saved; that is the server-side prefetch left for later.)
  await page.addInitScript(() => {
    const seen = window as unknown as { __placeholderSeen: boolean };
    seen.__placeholderSeen = false;
    new MutationObserver(() => {
      for (const node of document.querySelectorAll('[aria-busy="true"]'))
        if (Object.keys(node).some(key => key.startsWith('__reactFiber$'))) seen.__placeholderSeen = true;
    }).observe(document, { childList: true, subtree: true });
  });
  await page.reload({ waitUntil: 'commit' });
  await expect(page.getByText(/测试测试/).first()).toBeVisible({ timeout: 15_000 }).catch(async error => { await evidence('held reload'); throw error; });
  await expect(replies(page).first()).toBeVisible();
  // The full interface, not a placeholder: the input box is there and can be typed into while the reads are still held.
  await page.getByRole('textbox').first().click();
  await page.keyboard.insertText('草稿');
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __placeholderSeen: boolean }).__placeholderSeen), 'no placeholder in any frame').toBe(false);
  await expect(page.locator('body')).not.toContainText(WAITING_WORDS);
  expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('graylum:')).length)).toBeGreaterThan(0);

  expect(hydrationErrors, 'the saved copy never makes the server HTML and the first client render disagree').toEqual([]);

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

// A slow network or phone: until the page's scripts arrive the signed-in page is the empty frame (top bar, side column, input box
// position), never a white page, and it holds nothing of anyone's data.
test('before the scripts load, a signed-in page is the empty frame, not a white page', async ({ page }) => {
  await signIn(page, 'alice');
  await page.goto('/app/positioning');
  await page.waitForTimeout(3_000);
  await page.route(/\/_next\/static\/.*\.js/, route => route.abort());
  await page.goto('/app/positioning', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('signed-in-shell')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('body')).not.toContainText(seed().users.alice.email);
  await expect(page.locator('body')).not.toContainText(WAITING_WORDS);
  await page.screenshot({ path: test.info().outputPath('before-scripts.png') });
});
