import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { test as base, expect, type BrowserContext, type Page } from '@playwright/test';

import { gotoWithBypass } from '../../support/deploymentProtection';
import { coreSql } from './db';
import { CORE_ROLES, credentialsFor, resultsDirectory, spendCapUsd, statePathFor, type CoreRole } from './config';
import { dbSpendReader, SpendMeter } from './spend';

let shared: SpendMeter | undefined;

/** One meter per worker process; the DB total is cumulative since run.json, so a restarted worker keeps counting. */
export async function spendMeter(): Promise<SpendMeter> {
  if (shared) return shared;
  const { startedAt } = JSON.parse(await readFile(path.join(resultsDirectory, 'run.json'), 'utf8')) as { startedAt: string };
  const emails = CORE_ROLES.map(role => credentialsFor(role).email).filter(Boolean);
  shared = new SpendMeter(spendCapUsd(), dbSpendReader(coreSql(), emails, startedAt));
  return shared;
}

interface Fixtures {
  /** A signed-in page for a role. Closed after the test. */
  openAs: (role: CoreRole) => Promise<{ page: Page; context: BrowserContext }>;
  meter: SpendMeter;
}

export const test = base.extend<Fixtures>({
  meter: async ({}, provide) => { await provide(await spendMeter()); },
  openAs: async ({ browser }, provide) => {
    const contexts: BrowserContext[] = [];
    await provide(async role => {
      const context = await browser.newContext({ storageState: statePathFor(role) });
      contexts.push(context);
      const page = await context.newPage();
      return { page, context };
    });
    await Promise.all(contexts.map(context => context.close()));
  },
});

export { expect, gotoWithBypass };
