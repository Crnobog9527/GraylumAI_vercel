import { test as base, type BrowserContext, type Page } from '@playwright/test';

import { watchPage } from './support';

export { expect } from '@playwright/test';

/**
 * The journeys' `test`: when a test fails, every page it opened (also in contexts it made itself) reports what it showed, the failed
 * requests, the browser's errors and its calls to the turn endpoints to the job log, and attaches a screenshot (uploaded by CI on
 * failure). Local simulated data only. Every context starts with statistics consent already given (no consent bar).
 */
export const test = base.extend<{ evidence: void }>({
  evidence: [async ({ browser, context }, provide, testInfo) => {
    const reports = new Map<Page, ReturnType<typeof watchPage>>();
    const throttle = Number(process.env.SIM_CPU_THROTTLE ?? 0);
    const add = (page: Page) => {
      if (reports.has(page)) return;
      reports.set(page, watchPage(page));
      if (throttle > 1) void page.context().newCDPSession(page).then(cdp => cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle }))
        .catch(() => undefined);
    };
    const watch = (target: BrowserContext) => {
      // The local app has no visitor country, so it counts as an opt-in region and shows the consent bar over the page bottom
      // (ANALYTICS-CONSENT). The journeys run as a visitor who already accepted, like a visitor outside Europe.
      void target.addInitScript(() => {
        try { localStorage.setItem('graylum.analytics.consent', JSON.stringify({ choice: 'granted', at: new Date().toISOString() })); }
        catch { /* storage unavailable */ }
      });
      target.pages().forEach(add);
      target.on('page', add);
    };
    watch(context);
    const newContext = browser.newContext.bind(browser);
    browser.newContext = async (...args) => { const made = await newContext(...args); watch(made); return made; };
    try {
      await provide();
    } finally {
      browser.newContext = newContext;
    }
    if (testInfo.status === testInfo.expectedStatus) return;
    let index = 0;
    for (const [page, report] of reports) {
      if (page.isClosed()) continue;
      index += 1;
      await report(`${testInfo.title} — page ${index}`);
      const file = testInfo.outputPath(`page-${index}.png`);
      if (await page.screenshot({ path: file, timeout: 10_000 }).then(() => true, () => false)) {
        await testInfo.attach(`page-${index}`, { path: file, contentType: 'image/png' });
      }
    }
  }, { auto: true }],
});
