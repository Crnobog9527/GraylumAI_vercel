/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import { authStatePaths, getCredentials, hasCredentials } from './support/auth';
import { applyDeploymentProtectionBypass, gotoWithBypass } from './support/deploymentProtection';
import { createIssueMonitor, writeFlowAudit } from './support/monitoring';

async function readCreditsFromRow(row: Locator) {
  const creditsCell = row.locator('td').nth(4);
  const rawText = await creditsCell.textContent();
  return Number((rawText ?? '').replace(/[^\d-]/g, ''));
}

async function setUserCredits(browser: Browser, targetCredits: number, reason: string) {
  if (!hasCredentials('admin') || !hasCredentials('user') || !process.env.PLAYWRIGHT_BASE_URL) {
    throw new Error('E2E admin and user credentials are required for credit adjustment.');
  }

  const context = await browser.newContext({ storageState: authStatePaths.admin });
  const page = await context.newPage();

  try {
    await applyDeploymentProtectionBypass(page);
    await page.goto(new URL('/admin/users', process.env.PLAYWRIGHT_BASE_URL).toString());
    await expect(page).toHaveURL(/\/admin\/users/);

    const targetEmail = getCredentials('user').email;
    await page.locator('input[placeholder="邮箱或昵称..."]').fill(targetEmail);
    const targetRow = page.locator('tbody tr').filter({ hasText: targetEmail }).first();
    await expect(targetRow).toBeVisible({ timeout: 15000 });

    const currentCredits = await readCreditsFromRow(targetRow);
    const delta = targetCredits - currentCredits;

    if (delta === 0) {
      return currentCredits;
    }

    await targetRow.getByRole('button', { name: '积分' }).click();
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 10000 });
    await page.locator('input[type="number"]').fill(String(delta));
    await page.locator('input[placeholder="奖励积分、退款等..."]').fill(reason);

    const adjustResponsePromise = page.waitForResponse(
      (response) =>
        response.url().includes('/api/trpc/admin.adjustUserCredits') &&
        response.request().method() === 'POST',
      { timeout: 20000 },
    );
    await page.getByRole('button', { name: '确认调整' }).click();
    const adjustResponse = await adjustResponsePromise;
    expect(adjustResponse.status()).toBe(200);
    await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 15000 });
    await expect.poll(async () => readCreditsFromRow(targetRow), { timeout: 15000 }).toBe(targetCredits);

    return currentCredits;
  } finally {
    await context.close();
  }
}

test.describe('User Supplemental Flows', () => {
  test('should redirect unauthenticated users away from protected profile routes', async ({ page }, testInfo) => {
    const steps: string[] = [];
    const monitor = createIssueMonitor(page);
    let actual = 'Protected route redirected unauthenticated visitor';

    try {
      steps.push('Open /profile without authenticated storage state');
      await gotoWithBypass(page, '/profile');

      steps.push('Wait for the route guard to redirect to /login');
      await page.waitForURL(/\/login/, { timeout: 15000 });
      await expect(page.getByRole('button', { name: 'Login' })).toBeVisible({ timeout: 10000 });

      const blockingIssues = monitor.getIssues('P1');
      expect(blockingIssues, JSON.stringify(blockingIssues, null, 2)).toEqual([]);
    } catch (error) {
      actual = error instanceof Error ? error.message : 'Unknown protected-route redirect failure';
      monitor.addAssertionIssue(actual, 'P1');
      throw error;
    } finally {
      await writeFlowAudit(
        testInfo,
        {
          title: 'unauthenticated-profile-redirect',
          role: 'public',
          route: '/profile',
          expected: 'Unauthenticated visitors attempting to open protected profile routes are redirected to the login page.',
        },
        actual,
        steps,
        monitor.getIssues(),
      );
    }
  });

  test.describe('Authenticated Credit Guards', () => {
    test.describe.configure({ mode: 'serial' });
    test.use({ storageState: authStatePaths.user });
    test.skip(!hasCredentials('user'), 'E2E_TEST_EMAIL and E2E_TEST_PASSWORD are required for supplemental user flows');

    test('should block sends at zero credits and route recharge CTA to subscription management', async ({ browser, page }, testInfo) => {
      const steps: string[] = [];
      const monitor = createIssueMonitor(page);
      const prompt = `Parity empty credits ${Date.now()}`;
      let actual = 'Low balance guard blocked chat send at zero credits';
      let originalCredits: number | null = null;
      let streamRequestCount = 0;

      try {
        steps.push('Reduce the E2E user credits to zero through admin adjustment');
        originalCredits = await setUserCredits(browser, 0, `Parity low-balance test ${Date.now()}`);

        steps.push('Open /chat and attempt to send a new prompt');
        await gotoWithBypass(page, '/chat');
        await expect(page.getByText('已用完')).toBeVisible({ timeout: 15000 });
        page.on('request', (request) => {
          if (request.url().includes('/api/ai/stream') && request.method() === 'POST') {
            streamRequestCount += 1;
          }
        });
        await page.locator('textarea[placeholder="请输入您的问题..."]').fill(prompt);
        await page.getByRole('button', { name: '发送' }).click();

        steps.push('Verify the empty-balance dialog appears and no stream request is sent');
        const lowBalanceDialog = page.getByRole('alertdialog');
        await expect(lowBalanceDialog).toBeVisible({ timeout: 10000 });
        await expect(lowBalanceDialog.getByText('积分已用完')).toBeVisible({ timeout: 10000 });
        await expect(lowBalanceDialog.getByText('请充值积分后继续使用 AI 对话功能')).toBeVisible({ timeout: 10000 });
        await page.waitForTimeout(2000);
        expect(streamRequestCount).toBe(0);

        steps.push('Use the recharge CTA and confirm navigation to subscription management');
        await lowBalanceDialog.getByRole('button', { name: '立即充值' }).click();
        await expect(page).toHaveURL(/\/profile\?tab=subscription/, { timeout: 10000 });
        await expect(page.getByText('会员订阅')).toBeVisible({ timeout: 10000 });

        const blockingIssues = monitor.getIssues('P1');
        expect(blockingIssues, JSON.stringify(blockingIssues, null, 2)).toEqual([]);
      } catch (error) {
        actual = error instanceof Error ? error.message : 'Unknown low-balance guard failure';
        monitor.addAssertionIssue(actual, 'P1');
        throw error;
      } finally {
        if (originalCredits !== null) {
          await setUserCredits(browser, originalCredits, `Restore credits after low-balance parity test ${Date.now()}`);
        }

        await writeFlowAudit(
          testInfo,
          {
            title: 'chat-low-balance-guard',
            role: 'user',
            route: '/chat',
            expected: 'Users with zero credits are blocked before the chat stream starts and the recharge CTA routes to the subscription tab.',
          },
          actual,
          steps,
          monitor.getIssues(),
        );
      }
    });

  });

  test.describe('Authenticated Account Surface', () => {
    test.use({ storageState: authStatePaths.user });
    test.skip(!hasCredentials('user'), 'E2E_TEST_EMAIL and E2E_TEST_PASSWORD are required for supplemental user flows');

    test('should expose security settings dialogs and close the password dialog only after valid input', async ({ page }, testInfo) => {
      const steps: string[] = [];
      const monitor = createIssueMonitor(page);
      let actual = 'Security settings interactions completed';

      try {
        steps.push('Open /profile?tab=security and verify the security shell');
        await gotoWithBypass(page, '/profile?tab=security');
        await expect(page.getByRole('heading', { name: '账户安全' })).toBeVisible({ timeout: 10000 });
        await expect(page.getByText(getCredentials('user').email)).toBeVisible({ timeout: 10000 });
        await expect(page.getByText('登录方式')).toBeVisible({ timeout: 10000 });

        const verifyButton = page.getByRole('button', { name: '验证邮箱' });
        if (await verifyButton.isVisible({ timeout: 3000 }).catch(() => false)) {
          steps.push('Open the email verification dialog when the account is not yet verified');
          await verifyButton.click();
          await expect(page.getByRole('dialog')).toBeVisible({ timeout: 10000 });
          await expect(page.getByText('验证码已发送至')).toBeVisible({ timeout: 10000 });
          await page.getByRole('button', { name: '取消' }).click();
          await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 10000 });
        } else {
          steps.push('Record that the current E2E user is already email-verified');
          actual = 'Security settings interactions completed; email verification CTA already satisfied for current E2E user';
        }

        steps.push('Open the password dialog and verify invalid input does not close it');
        await page.getByRole('button', { name: '修改' }).click();
        await expect(page.getByRole('dialog')).toBeVisible({ timeout: 10000 });
        await page.locator('#current').fill('wrong-current-password');
        await page.locator('#new').fill('12345678');
        await page.locator('#confirm').fill('12345679');
        await page.getByRole('button', { name: '确认修改' }).click();
        await expect(page.getByRole('dialog')).toBeVisible({ timeout: 2000 });

        steps.push('Provide valid input and verify the dialog closes');
        await page.locator('#confirm').fill('12345678');
        await page.getByRole('button', { name: '确认修改' }).click();
        await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 5000 });

        const blockingIssues = monitor.getIssues('P1');
        expect(blockingIssues, JSON.stringify(blockingIssues, null, 2)).toEqual([]);
      } catch (error) {
        actual = error instanceof Error ? error.message : 'Unknown security settings failure';
        monitor.addAssertionIssue(actual, 'P1');
        throw error;
      } finally {
        await writeFlowAudit(
          testInfo,
          {
            title: 'profile-security-settings',
            role: 'user',
            route: '/profile?tab=security',
            expected: 'Authenticated users can inspect account security details, open the verification and password dialogs, and only close password changes after valid input.',
          },
          actual,
          steps,
          monitor.getIssues(),
        );
      }
    });

    test('should browse marketplace modules, change sort order, and open a module detail flow', async ({ page }, testInfo) => {
      const steps: string[] = [];
      const monitor = createIssueMonitor(page);
      let actual = 'Marketplace exploration flow completed';

      try {
        steps.push('Open /marketplace and verify the page shell');
        await gotoWithBypass(page, '/marketplace');
        await expect(page.getByRole('heading', { name: '功能广场' })).toBeVisible({ timeout: 10000 });
        await expect(page.getByText('AI TOOLS MARKETPLACE')).toBeVisible({ timeout: 10000 });

        steps.push('Switch category and sort order');
        await page.getByRole('button', { name: '营销文案' }).click();
        await page.getByRole('button', { name: /最新上线|最受欢迎/ }).click();
        await page.getByRole('menuitem', { name: '🔥 最受欢迎' }).click();
        await expect(page.getByRole('button', { name: /最受欢迎/ })).toBeVisible({ timeout: 10000 });

        steps.push('Open the first module detail dialog');
        const firstUseButton = page.getByRole('button', { name: '立即使用' }).first();
        await expect(firstUseButton).toBeVisible({ timeout: 15000 });
        await firstUseButton.click();
        const detailDialog = page.getByRole('dialog');
        await expect(detailDialog).toBeVisible({ timeout: 10000 });
        await expect(detailDialog.getByText('功能介绍')).toBeVisible({ timeout: 10000 });

        steps.push('Use the selected module and confirm routing into chat with module context');
        await detailDialog.getByRole('button', { name: '立即使用' }).click();
        await expect(page).toHaveURL(/\/chat\?module=/, { timeout: 10000 });
        await expect(page.getByRole('button', { name: '发送' })).toBeVisible({ timeout: 10000 });

        const blockingIssues = monitor.getIssues('P1');
        expect(blockingIssues, JSON.stringify(blockingIssues, null, 2)).toEqual([]);
      } catch (error) {
        actual = error instanceof Error ? error.message : 'Unknown marketplace exploration failure';
        monitor.addAssertionIssue(actual, 'P1');
        throw error;
      } finally {
        await writeFlowAudit(
          testInfo,
          {
            title: 'marketplace-filter-detail-use',
            role: 'user',
            route: '/marketplace',
            expected: 'Authenticated users can filter marketplace modules, change sort order, inspect module detail, and route into chat with the chosen module.',
          },
          actual,
          steps,
          monitor.getIssues(),
        );
      }
    });
  });
});
