/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { expect, test } from '@playwright/test';
import { authStatePaths, hasCredentials } from './support/auth';
import { gotoWithBypass } from './support/deploymentProtection';
import { createIssueMonitor, writeFlowAudit } from './support/monitoring';

const destructiveGateEnabled = process.env.ENABLE_PARITY_DESTRUCTIVE_E2E === 'true';

test.describe('Admin Destructive Flows', () => {
  test.describe.configure({ mode: 'serial' });
  test.use({ storageState: authStatePaths.admin });
  test.skip(!hasCredentials('admin'), 'E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD are required for destructive admin flows');

  test('should remain gated until dedicated destructive fixtures are enabled', async () => {
    test.skip(
      !destructiveGateEnabled,
      'Destructive parity coverage is intentionally gated. Enable ENABLE_PARITY_DESTRUCTIVE_E2E=true only with isolated preview fixtures.',
    );
  });

  test('should execute conversation cleanup only when expired data exists and otherwise stay safely disabled', async ({ page }, testInfo) => {
    test.skip(
      !destructiveGateEnabled,
      'Destructive parity coverage is intentionally gated. Enable ENABLE_PARITY_DESTRUCTIVE_E2E=true only with isolated preview fixtures.',
    );

    const steps: string[] = [];
    const monitor = createIssueMonitor(page);
    let actual = 'Admin conversation cleanup flow completed';

    try {
      steps.push('Open /admin/settings and inspect cleanup totals');
      await gotoWithBypass(page, '/admin/settings');
      await expect(page).toHaveURL(/\/admin\/settings/);
      await page.getByRole('tab', { name: '会员权限' }).click();

      const cleanupButton = page.getByTestId('admin-settings-cleanup-trigger');
      const cleanupStatus = page.getByTestId('admin-settings-cleanup-status');
      const totalExpiredCard = page.getByText('待清理总数').locator('..');
      await expect(cleanupStatus).toBeVisible({ timeout: 15000 });

      const totalExpiredRaw = (await totalExpiredCard.textContent()) ?? '';
      const match = totalExpiredRaw.match(/待清理总数\s*(\d+)/);
      const totalExpired = Number(match?.[1] ?? '0');

      if (totalExpired > 0) {
        steps.push('Run cleanup and verify visible success feedback');
        const cleanupResponsePromise = page.waitForResponse(
          (response) =>
            response.url().includes('/api/trpc/admin.cleanupExpiredConversations') &&
            response.request().method() === 'POST',
          { timeout: 30000 },
        );
        await cleanupButton.click();
        const cleanupResponse = await cleanupResponsePromise;
        expect(cleanupResponse.status()).toBe(200);
        await expect(cleanupStatus).toContainText('清理完成', { timeout: 15000 });
      } else {
        steps.push('Verify cleanup remains disabled when there is no expired conversation data');
        await expect(cleanupButton).toBeDisabled();
        await expect(page.getByText('暂无需要清理的对话')).toBeVisible({ timeout: 15000 });
      }

      const blockingIssues = monitor.getIssues('P1');
      expect(blockingIssues, JSON.stringify(blockingIssues, null, 2)).toEqual([]);
    } catch (error) {
      actual = error instanceof Error ? error.message : 'Unknown admin conversation cleanup failure';
      monitor.addAssertionIssue(actual, 'P1');
      throw error;
    } finally {
      await writeFlowAudit(
        testInfo,
        {
          title: 'admin-settings-destructive-cleanup',
          role: 'admin',
          route: '/admin/settings',
          expected: 'Admin destructive cleanup only executes when expired conversations exist and otherwise remains safely disabled in preview fixtures.',
        },
        actual,
        steps,
        monitor.getIssues(),
      );
    }
  });

  test('should run diagnostics record cleanup behind the destructive gate', async ({ page }, testInfo) => {
    test.skip(
      !destructiveGateEnabled,
      'Destructive parity coverage is intentionally gated. Enable ENABLE_PARITY_DESTRUCTIVE_E2E=true only with isolated preview fixtures.',
    );

    const steps: string[] = [];
    const monitor = createIssueMonitor(page);
    let actual = 'Diagnostics cleanup flow completed';

    try {
      steps.push('Open /admin/diagnostics');
      await gotoWithBypass(page, '/admin/diagnostics');
      await expect(page).toHaveURL(/\/admin\/diagnostics/);

      steps.push('Execute diagnostic history cleanup and verify visible feedback');
      page.once('dialog', (dialog) => dialog.accept());
      const cleanupResponsePromise = page.waitForResponse(
        (response) =>
          response.url().includes('/api/trpc/diagnostics.cleanupOldResults') &&
          response.request().method() === 'POST',
        { timeout: 30000 },
      );
      await page.getByTestId('admin-diagnostics-cleanup-trigger').click();
      const cleanupResponse = await cleanupResponsePromise;
      expect(cleanupResponse.status()).toBe(200);
      await expect(page.getByTestId('admin-diagnostics-cleanup-status')).toContainText('已清理', { timeout: 15000 });

      const blockingIssues = monitor.getIssues('P1');
      expect(blockingIssues, JSON.stringify(blockingIssues, null, 2)).toEqual([]);
    } catch (error) {
      actual = error instanceof Error ? error.message : 'Unknown diagnostics cleanup failure';
      monitor.addAssertionIssue(actual, 'P1');
      throw error;
    } finally {
      await writeFlowAudit(
        testInfo,
        {
          title: 'admin-diagnostics-destructive-cleanup',
          role: 'admin',
          route: '/admin/diagnostics',
          expected: 'Admin destructive cleanup can remove old diagnostic records only when the explicit parity gate is enabled.',
        },
        actual,
        steps,
        monitor.getIssues(),
      );
    }
  });
});
