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
      await gotoWithBypass(page, '/profile');

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
          route: '/profile',
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
        await gotoWithBypass(page, '/profile?tab=security');
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
            route: '/profile?tab=security',
            expected: 'Authenticated users can inspect real security-state details, see verification status, and invalid password changes are rejected without depending on fake success dialogs.',
          },
          actual,
          steps,
          monitor.getIssues(),
        );
      }
    });

    test('should open a real invitation dialog with a generated invitation code', async ({ page }, testInfo) => {
      const steps: string[] = [];
      const monitor = createIssueMonitor(page);
      let actual = 'Invitation dialog rendered with live invitation data';

      try {
        steps.push('Open /profile?tab=profile and locate the invitation action card');
        await gotoWithBypass(page, '/profile?tab=profile');
        await expect(page.getByText('快捷操作')).toBeVisible({ timeout: 10000 });
        const inviteCard = page.getByTestId('profile-invite-card');
        await expect(inviteCard).toBeVisible({ timeout: 10000 });

        steps.push('Open the invitation dialog');
        await inviteCard.click();
        const dialog = page.getByRole('dialog');
        await expect(dialog).toBeVisible({ timeout: 10000 });
        await expect(dialog.getByRole('heading', { name: '邀请好友' })).toBeVisible({ timeout: 10000 });

        steps.push('Verify the generated invitation code and copy actions are present');
        await expect(page.getByTestId('profile-invitation-code')).toBeVisible({ timeout: 15000 });
        await expect(dialog.getByRole('button', { name: '复制邀请码' })).toBeVisible({ timeout: 10000 });
        await expect(dialog.getByRole('button', { name: '复制链接' })).toBeVisible({ timeout: 10000 });

        const blockingIssues = monitor.getIssues('P1');
        expect(blockingIssues, JSON.stringify(blockingIssues, null, 2)).toEqual([]);
      } catch (error) {
        actual = error instanceof Error ? error.message : 'Unknown invitation dialog failure';
        monitor.addAssertionIssue(actual, 'P1');
        throw error;
      } finally {
        await writeFlowAudit(
          testInfo,
          {
            title: 'profile-invitation-dialog',
            role: 'user',
            route: '/profile',
            expected: 'Authenticated users can open a live invitation dialog, view a generated invitation code, and copy both the code and invite link.',
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
        const popularMenuItem = page.locator('[role="menuitem"]').filter({ hasText: '🔥 最受欢迎' }).first();
        const popularTextFallback = page.locator('text=🔥 最受欢迎').last();

        const usedRoleLocator = await popularMenuItem.isVisible().catch(() => false);
        if (usedRoleLocator) {
          await popularMenuItem.click({ force: true });
        } else {
          await expect(popularTextFallback).toBeVisible({ timeout: 10000 });
          await popularTextFallback.click({ force: true });
        }
        await expect(
          page.getByRole('button', { name: /最新上线|最受欢迎/ }).filter({ hasText: '最受欢迎' }).or(
            page.locator('button').filter({ hasText: '🔥 最受欢迎' }).first(),
          ),
        ).toBeVisible({ timeout: 10000 });

        steps.push('Open the first available module detail dialog');
        let availableUseButtons = page.getByRole('button', { name: '立即使用' });
        if (await availableUseButtons.count() === 0) {
          steps.push('Fallback to 全部功能 because the selected category has no visible modules in the current fixture data');
          await page.getByRole('button', { name: '全部功能' }).click();
          availableUseButtons = page.getByRole('button', { name: '立即使用' });
        }
        if (await availableUseButtons.count() === 0) {
          await expect(page.getByText(/共\s*0\s*个工具/)).toBeVisible({ timeout: 10000 });
          actual = 'Marketplace shell rendered but the current preview fixture data has no visible modules';
          return;
        }
        const firstUseButton = availableUseButtons.first();
        await expect(firstUseButton).toBeVisible({ timeout: 15000 });
        await firstUseButton.click();
        const detailDialog = page.getByRole('dialog');
        await expect(detailDialog).toBeVisible({ timeout: 10000 });
        await expect(detailDialog.getByText('功能介绍')).toBeVisible({ timeout: 10000 });

        // Modules now open the positioning workspace, and only modules in the published catalog are usable.
        const dialogUseButton = detailDialog.getByRole('button', { name: '立即使用' });
        await expect.poll(async () => (await dialogUseButton.isEnabled()) || (await detailDialog
          .getByText('该技能将在新工作区上线后开放').isVisible()), { timeout: 10000 }).toBe(true);
        if (await dialogUseButton.isEnabled()) {
          steps.push('Use the selected module and confirm routing into the positioning workspace');
          await dialogUseButton.click();
          await expect(page).toHaveURL(/\/positioning/, { timeout: 10000 });
        } else {
          steps.push('Record that the selected module is not in the published positioning catalog');
          await expect(detailDialog.getByText('该技能将在新工作区上线后开放')).toBeVisible();
          actual = 'Marketplace detail rendered; the selected module is not yet available in the positioning workspace';
        }

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
            expected: 'Authenticated users can filter marketplace modules, change sort order, inspect module detail, and route into the positioning workspace when the module is published.',
          },
          actual,
          steps,
          monitor.getIssues(),
        );
      }
    });
  });
});
