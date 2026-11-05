/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { expect, test, type Page } from '@playwright/test';
import { authStatePaths, getCredentials, hasCredentials } from './support/auth';

import { gotoWithBypass } from './support/deploymentProtection';
import { createIssueMonitor, writeFlowAudit } from './support/monitoring';

test.describe('User Supplemental Flows', () => {
  test('should redirect unauthenticated users away from protected profile routes', async ({ page }, testInfo) => {
    const steps: string[] = [];
    const monitor = createIssueMonitor(page);
    let actual = 'Protected route redirected unauthenticated visitor';

    try {
      steps.push('Open /profile without authenticated storage state');
      await gotoWithBypass(page, '/app/profile');

      steps.push('Wait for the route guard to redirect to /login');
      await page.waitForURL(/\/login/, { timeout: 15000 });
      await expect(page.locator('form').getByRole('button', { name: /^登录$|^Login$/i })).toBeVisible({ timeout: 10000 });

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
          route: '/app/profile',
          expected: 'Unauthenticated visitors attempting to open protected profile routes are redirected to the login page.',
        },
        actual,
        steps,
        monitor.getIssues(),
      );
    }
  });

  test.describe('Authenticated Account Surface', () => {
    test.use({ storageState: authStatePaths.user });
    test.skip(!hasCredentials('user'), 'E2E_TEST_EMAIL and E2E_TEST_PASSWORD are required for supplemental user flows');

    test('should expose real security settings flows without relying on fake verification or password stubs', async ({ page }, testInfo) => {
      const steps: string[] = [];
      const monitor = createIssueMonitor(page);
      let actual = 'Security settings interactions completed';

      try {
        steps.push('Open /profile?tab=security and verify the security shell');
        await gotoWithBypass(page, '/app/profile?tab=security');
        await expect(page.locator('h3').filter({ hasText: '账户安全' })).toBeVisible({ timeout: 10000 });
        await expect(page.getByText(getCredentials('user').email)).toBeVisible({ timeout: 10000 });
        await expect(page.getByText('登录方式')).toBeVisible({ timeout: 10000 });

        // auth.setup.ts rejects unverified accounts, so the E2E user is always verified here.
        steps.push('Record that the current E2E user is already email-verified');
        await expect(
          page.getByText(/已验证|Google 账户默认已完成邮箱验证/)
        ).toBeVisible({ timeout: 10000 });
        actual = 'Security settings interactions completed; email verification requirements already satisfied for current E2E user';

        steps.push('Open the password dialog and verify invalid input is rejected without closing the dialog');
        await page.getByRole('button', { name: '修改' }).click();
        await expect(page.getByRole('dialog')).toBeVisible({ timeout: 10000 });
        await page.locator('#current-password').fill('wrong-current-password');
        await page.locator('#new-password').fill('12345678');
        await page.locator('#confirm-password').fill('12345679');
        await page.getByRole('button', { name: '确认修改' }).click();
        await expect(page.getByRole('dialog')).toBeVisible({ timeout: 2000 });
        await expect(page.getByText('两次输入的新密码不一致')).toBeVisible({ timeout: 10000 });

        steps.push('Close the dialog explicitly because password updates now require a real current password');
        await page.getByRole('button', { name: '取消' }).click();
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
            route: '/app/profile?tab=security',
            expected: 'Authenticated users can inspect real security-state details, see verification status, and invalid password changes are rejected without depending on fake success dialogs.',
          },
          actual,
          steps,
          monitor.getIssues(),
        );
      }
    });

    test('should browse the workbench marketplace and switch categories', async ({ page }, testInfo) => {
      const steps: string[] = [];
      const monitor = createIssueMonitor(page);
      let actual = 'Marketplace browsing flow completed';

      try {
        steps.push('Open /app/workbench/marketplace and verify the page shell');
        await gotoWithBypass(page, '/app/workbench/marketplace');
        await expect(page.getByRole('heading', { name: '功能广场' })).toBeVisible({ timeout: 10000 });

        steps.push('Switch category and back to all');
        await page.getByRole('button', { name: '营销文案' }).click();
        await page.getByRole('button', { name: '全部功能' }).click();

        const blockingIssues = monitor.getIssues('P1');
        expect(blockingIssues, JSON.stringify(blockingIssues, null, 2)).toEqual([]);
      } catch (error) {
        actual = error instanceof Error ? error.message : 'Unknown marketplace browsing failure';
        monitor.addAssertionIssue(actual, 'P1');
        throw error;
      } finally {
        await writeFlowAudit(
          testInfo,
          {
            title: 'marketplace-browse',
            role: 'user',
            route: '/app/workbench/marketplace',
            expected: 'Authenticated users can open the workbench marketplace and switch categories without blocking issues.',
          },
          actual,
          steps,
          monitor.getIssues(),
        );
      }
    });
  });
});
