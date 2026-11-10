import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { test as base, expect, type BrowserContext, type Page } from '@playwright/test';

import { gotoWithBypass } from '../../support/deploymentProtection';
import { coreSql } from './db';
import { requireAccounts } from './accounts';
import { dailyMode, resultsDirectory, spendCapUsd, spendSince, statePathFor, type CoreRole } from './config';
import { dbSpendReader, dbStepCostReader, fileSpendStore, SpendMeter, STEP_FLOOR_USD, stepBoundUsd, type PaidStep } from './spend';

let shared: SpendMeter | undefined;

/**
 * One meter per worker process; the DB total is cumulative since run.json (in daily mode since the start of that UTC day), so a
 * restarted worker keeps counting.
 */
export async function spendMeter(): Promise<SpendMeter> {
  if (shared) return shared;
  const { startedAt } = JSON.parse(await readFile(path.join(resultsDirectory, 'run.json'), 'utf8')) as { startedAt: string };
  const accounts = await requireAccounts();
  const reader = dbSpendReader(coreSql(), Object.values(accounts).map(account => account.id), spendSince(startedAt));
  shared = new SpendMeter(spendCapUsd(), reader, fileSpendStore(), dailyMode());
  shared.history = dbStepCostReader(coreSql(), Object.values(accounts).map(account => account.id));
  return shared;
}

/**
 * Skips (never fails) a journey whose first paid step no longer fits under the cap (the step's pre-check bound, spend.ts); the summary
 * lists it as skipped for budget. Each later paid step is checked again before it is sent (SpendMeter.precheck).
 */
export async function requireBudget(meter: SpendMeter, step: PaidStep) {
  const left = await meter.remainingUsd();
  const bound = meter.history ? await stepBoundUsd(step, meter.history) : STEP_FLOOR_USD[step];
  base.skip(left < bound, `budget: $${left.toFixed(4)} left, the next ${step} step may cost up to $${bound.toFixed(4)}`);
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
    // Whatever the test spent and did not close itself (a failed journey, the part after its last checkpoint) is booked to it,
    // not to the next test.
    await meter.closeTest(testInfo.title);
  },
  openAs: async ({ browser }, provide) => {
    const contexts: BrowserContext[] = [];
    await provide(async role => {
      const context = await browser.newContext({ storageState: statePathFor(role) });
      contexts.push(context);
      const page = await context.newPage();
      // The statistics consent bar (ANALYTICS-CONSENT, region "Cookie 同意") shows only to a visitor from an opt-in region and
      // covers the bottom of the page; "仅必要" calls analytics.withdrawConsent in the middle of a journey. Hiding the bar whenever it
      // shows up changes nothing the journeys test (it is React's node, so it is hidden, not removed).
      await page.addLocatorHandler(page.getByRole('region', { name: 'Cookie 同意' }), async bar => {
        await bar.evaluate(node => { (node as HTMLElement).style.display = 'none'; });
      });
      return { page, context };
    });
    await Promise.all(contexts.map(context => context.close()));
  },
});

export { expect, gotoWithBypass };
