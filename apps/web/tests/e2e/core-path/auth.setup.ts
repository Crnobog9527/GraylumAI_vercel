import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { expect, test as setup } from '@playwright/test';

import { gotoWithBypass } from '../support/deploymentProtection';
import { identityFromState, saveAccounts, type Account } from './support/accounts';
import { waitForLoginFormReady } from '../support/auth';
import { authDirectory, CORE_ROLES, credentialsFor, resultsDirectory, statePathFor } from './support/config';

/**
 * Logs the dedicated core-path accounts in. It writes nothing to the site: no maintenance-mode or other site-wide
 * switch is touched (the shared e2e setup does that; this one deliberately does not). Two ways to get a session:
 *  - CORE_E2E_STATE_DIR/<role>.json: a ready Playwright storageState (local runs, made by the staging-login tool);
 *  - CORE_E2E_<ROLE>_EMAIL / _PASSWORD: the normal login page (CI secrets).
 */
setup.describe.configure({ mode: 'serial' });
setup.setTimeout(120_000);

const accounts: Partial<Record<(typeof CORE_ROLES)[number], Account>> = {};

setup('start the run clock', async () => {
  await mkdir(resultsDirectory, { recursive: true });
  await saveAccounts({});
  await writeFile(path.join(resultsDirectory, 'run.json'), JSON.stringify({ startedAt: new Date().toISOString() }));
});

/** The billing account behind each session, so the spend cap can be enforced whichever way the session was made. */
async function rememberAccount(role: (typeof CORE_ROLES)[number]) {
  const state = JSON.parse(await readFile(statePathFor(role), 'utf8'));
  const account = identityFromState(state);
  if (!account) throw new Error(`Could not tell which account the ${role} session belongs to.`);
  accounts[role] = account;
  await saveAccounts(accounts);
}

for (const role of CORE_ROLES) {
  setup(`log in ${role}`, async ({ page }) => {
    await mkdir(authDirectory, { recursive: true });
    const stateDir = process.env.CORE_E2E_STATE_DIR;
    const provided = stateDir ? path.join(stateDir, `${role}.json`) : '';
    if (provided && existsSync(provided)) {
      await copyFile(provided, statePathFor(role));
      await rememberAccount(role);
      return;
    }
    const { email, password } = credentialsFor(role);
    setup.skip(!email || !password, `No ${role} session: set CORE_E2E_STATE_DIR or CORE_E2E_${role.toUpperCase()}_EMAIL/_PASSWORD`);
    await gotoWithBypass(page, '/login');
    await waitForLoginFormReady(page);
    await page.locator('#email, input[type="email"], input[name="email"]').fill(email);
    await page.locator('#password, input[type="password"], input[name="password"]').fill(password);
    await page.locator('button[type="submit"]').click();
    await page.waitForFunction(() => window.location.pathname !== '/login', undefined, { timeout: 45_000 });
    await gotoWithBypass(page, '/app/profile');
    await expect(page).toHaveURL(/\/app\/profile/);
    await page.context().storageState({ path: statePathFor(role) });
    await rememberAccount(role);
  });
}
