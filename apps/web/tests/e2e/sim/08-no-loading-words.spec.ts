import { expect, test } from '@playwright/test';

import { resetSim, signIn } from './support';

/**
 * UI-FINISH: while the reads of a signed-in page are still out, the page shows grey placeholders, never "loading" words or a spinner.
 * Every read to the server is held for the whole time, so only what the page draws by itself can be on screen.
 */
test.beforeEach(resetSim);

const WAITING_WORDS = /正在读取|读取中|加载中|正在加载/;
const PAGES = ['/app/profile', '/app/library', '/app/marketplace', '/app/workbench/search'];

for (const path of PAGES) {
  test(`${path}: reads still out shows no loading words and no spinner`, async ({ page }) => {
    await signIn(page, 'alice');
    await page.goto('/app/positioning');
    await page.waitForTimeout(2_000);
    await page.route(/\/api\/(turn|trpc)/, () => new Promise(() => undefined));
    await page.goto(path, { waitUntil: 'commit' });
    await page.waitForTimeout(4_000);
    await expect(page.locator('body')).not.toContainText(WAITING_WORDS);
    await expect(page.locator('.animate-spin')).toHaveCount(0);
  });
}
