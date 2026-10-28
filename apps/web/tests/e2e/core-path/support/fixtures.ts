import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { test as base, expect, type BrowserContext, type Page } from '@playwright/test';

import { gotoWithBypass } from '../../support/deploymentProtection';
import { coreSql } from './db';
import { requireAccounts } from './accounts';
import { resultsDirectory, spendCapUsd, statePathFor, type CoreRole } from './config';
import { dbSpendReader, fileSpendStore, SpendMeter } from './spend';

let shared: SpendMeter | undefined;

/** One meter per worker process; the DB total is cumulative since run.json, so a restarted worker keeps counting. */
export async function spendMeter(): Promise<SpendMeter> {
  if (shared) return shared;
  const { startedAt } = JSON.parse(await readFile(path.join(resultsDirectory, 'run.json'), 'utf8')) as { startedAt: string };
  const accounts = await requireAccounts();
  shared = new SpendMeter(spendCapUsd(), dbSpendReader(coreSql(), Object.values(accounts).map(account => account.id), startedAt), fileSpendStore());
  return shared;
}

interface Fixtures {
  /** A signed-in page for a role. Closed after the test. */
  openAs: (role: CoreRole) => Promise<{ page: Page; context: BrowserContext }>;
  meter: SpendMeter;
}

export const test = base.extend<Fixtures>({
  // A test that needs the meter starts only if the cap has not been passed yet: nothing paid runs after the budget is gone.
  meter: async ({}, provide, testInfo) => {
    const meter = await spendMeter();
    await meter.assertRoom(testInfo.title);
    await provide(meter);
  },
  openAs: async ({ browser }, provide) => {
    const contexts: BrowserContext[] = [];
    await provide(async role => {
      const context = await browser.newContext({ storageState: statePathFor(role) });
      contexts.push(context);
      const page = await context.newPage();
      // The cookie-consent banner (Termly, region "Cookie Consent Prompt") covers the lower left of every page and swallows
      // clicks there; "Decline" does not stick between page loads and calls analytics.withdrawConsent in the middle of a journey.
      // Taking the banner out of the page whenever it shows up changes nothing the journeys test.
      await page.addLocatorHandler(page.getByRole('region', { name: 'Cookie Consent Prompt' }), async banner => {
        await banner.evaluate(node => node.remove());
      });
      return { page, context };
    });
    await Promise.all(contexts.map(context => context.close()));
  },
});

export { expect, gotoWithBypass };
