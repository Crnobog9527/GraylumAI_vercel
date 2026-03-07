/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { expect, test } from '@playwright/test';
import { authStatePaths, getCredentials, hasCredentials } from './support/auth';
import { gotoWithBypass } from './support/deploymentProtection';
import { createIssueMonitor, writeFlowAudit } from './support/monitoring';

test.describe('Admin Operations Flows', () => {
  test.describe.configure({ mode: 'serial' });
  test.use({ storageState: authStatePaths.admin });
  test.skip(!hasCredentials('admin'), 'E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD are required for admin ops flows');

  test('should run diagnostics for one category and expose history views', async ({ page }, testInfo) => {
    const steps: string[] = [];
    const monitor = createIssueMonitor(page);
    let actual = 'Diagnostics operations flow completed';

    try {
      steps.push('Open /admin/diagnostics');
      await gotoWithBypass(page, '/admin/diagnostics');
      await expect(page).toHaveURL(/\/admin\/diagnostics/);

      steps.push('Run the AI category diagnostics');
      const runResponsePromise = page.waitForResponse(
        (response) =>
          response.url().includes('/api/trpc/diagnostics.runCategoryTests') &&
          response.request().method() === 'POST',
        { timeout: 30000 },
      );
      await page.getByRole('button', { name: '运行测试' }).first().click();
      const runResponse = await runResponsePromise;
      expect(runResponse.status()).toBe(200);

      steps.push('Verify results, history, and health tabs remain accessible after execution');
      await expect(page.getByText(/通过|失败|警告|跳过/).first()).toBeVisible({ timeout: 30000 });
      await page.getByRole('tab', { name: '运行历史' }).click();
      await expect(page.getByText('近期运行记录')).toBeVisible({ timeout: 10000 });
      await page.getByRole('tab', { name: '健康检查' }).click();
      await expect(page.getByText('系统健康检查')).toBeVisible({ timeout: 10000 });
      await page.getByRole('button', { name: '刷新' }).click();

      const blockingIssues = monitor.getIssues('P1');
      expect(blockingIssues, JSON.stringify(blockingIssues, null, 2)).toEqual([]);
    } catch (error) {
      actual = error instanceof Error ? error.message : 'Unknown diagnostics operations failure';
      monitor.addAssertionIssue(actual, 'P1');
      throw error;
    } finally {
      await writeFlowAudit(
        testInfo,
        {
          title: 'admin-diagnostics-operations',
          role: 'admin',
          route: '/admin/diagnostics',
          expected: 'Admin users can execute diagnostics for a category and inspect the results/history views without blocking issues.',
        },
        actual,
        steps,
        monitor.getIssues(),
      );
    }
  });

  test('should filter the users table and open the detail sheet for the configured E2E user', async ({ page }, testInfo) => {
    const steps: string[] = [];
    const monitor = createIssueMonitor(page);
    const targetEmail = getCredentials('user').email;
    let actual = 'Users detail flow completed';

    try {
      steps.push('Open /admin/users');
      await gotoWithBypass(page, '/admin/users');
      await expect(page).toHaveURL(/\/admin\/users/);

      steps.push('Filter the table to the configured E2E user');
      await page.locator('input[placeholder="邮箱或昵称..."]').fill(targetEmail);
      const targetRow = page.locator('tbody tr').filter({ hasText: targetEmail }).first();
      await expect(targetRow).toBeVisible({ timeout: 15000 });

      steps.push('Open the user detail sheet');
      await targetRow.getByRole('button', { name: '详情' }).click();
      await expect(page.getByText('用户详情')).toBeVisible({ timeout: 15000 });
      await expect(page.getByText(targetEmail)).toBeVisible({ timeout: 15000 });

      const blockingIssues = monitor.getIssues('P1');
      expect(blockingIssues, JSON.stringify(blockingIssues, null, 2)).toEqual([]);
    } catch (error) {
      actual = error instanceof Error ? error.message : 'Unknown users detail failure';
      monitor.addAssertionIssue(actual, 'P1');
      throw error;
    } finally {
      await writeFlowAudit(
        testInfo,
        {
          title: 'admin-users-detail',
          role: 'admin',
          route: '/admin/users',
          expected: 'Admin users can filter the table to the configured E2E user and open the user detail sheet without blocking issues.',
        },
        actual,
        steps,
        monitor.getIssues(),
      );
    }
  });

  test('should open operational read pages and exercise their primary tabs or filters', async ({ page }, testInfo) => {
    const steps: string[] = [];
    const monitor = createIssueMonitor(page);
    let actual = 'Operational read pages flow completed';

    try {
      steps.push('Open /admin/transactions and use a transaction tab and search filter');
      await gotoWithBypass(page, '/admin/transactions');
      await expect(page.getByText('交易记录')).toBeVisible({ timeout: 10000 });
      await page.getByRole('tab', { name: '增加' }).click().catch(() => undefined);
      await page.locator('input[placeholder="搜索用户邮箱或昵称..."]').fill('e2e');

      steps.push('Open /admin/finance and switch to API statistics');
      await gotoWithBypass(page, '/admin/finance');
      await expect(page.getByText('财务统计')).toBeVisible({ timeout: 10000 });
      await page.getByRole('tab', { name: 'API 统计' }).click();

      steps.push('Open /admin/invitations and verify search and refresh controls');
      await gotoWithBypass(page, '/admin/invitations');
      await expect(page.getByText('邀请管理')).toBeVisible({ timeout: 10000 });
      await page.locator('input[placeholder="搜索邮箱或邀请码..."]').fill('test');
      await page.getByRole('button', { name: '刷新数据' }).click();

      steps.push('Open /admin/costs and switch the report tab');
      await gotoWithBypass(page, '/admin/costs');
      await expect(page.getByText('成本趋势')).toBeVisible({ timeout: 10000 });
      await page.getByRole('tab').nth(1).click();

      steps.push('Open /admin/performance and switch to token statistics');
      await gotoWithBypass(page, '/admin/performance');
      await expect(page.getByText('AI 性能监控')).toBeVisible({ timeout: 10000 });
      await page.getByRole('tab', { name: 'Token 统计' }).click();

      steps.push('Open /admin/tickets and verify the detail sheet shell is available');
      await gotoWithBypass(page, '/admin/tickets');
      await expect(page.getByText('工单管理')).toBeVisible({ timeout: 10000 });
      await page.getByRole('tab', { name: '全部' }).click();

      const blockingIssues = monitor.getIssues('P1');
      expect(blockingIssues, JSON.stringify(blockingIssues, null, 2)).toEqual([]);
    } catch (error) {
      actual = error instanceof Error ? error.message : 'Unknown operational read pages failure';
      monitor.addAssertionIssue(actual, 'P1');
      throw error;
    } finally {
      await writeFlowAudit(
        testInfo,
        {
          title: 'admin-operations-read-pages',
          role: 'admin',
          route: '/admin/transactions,/admin/finance,/admin/invitations,/admin/costs,/admin/performance,/admin/tickets',
          expected: 'Admin users can open the major operational read pages and interact with their primary tabs or filters without blocking issues.',
        },
        actual,
        steps,
        monitor.getIssues(),
      );
    }
  });
});
