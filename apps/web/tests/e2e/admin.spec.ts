/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { test, expect } from '@playwright/test';
import { authStatePaths, hasCredentials } from './support/auth';
import { createIssueMonitor, writeFlowAudit } from './support/monitoring';

test.describe('Admin Dashboard', () => {
  test.use({ storageState: authStatePaths.admin });
  test.skip(!hasCredentials('admin'), 'E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD are required for admin flows');

  test('should display admin dashboard', async ({ page }, testInfo) => {
    const steps: string[] = [];
    const monitor = createIssueMonitor(page);
    let actual = 'Admin dashboard rendered';

    try {
      steps.push('Open /admin');
      await page.goto('/admin');
      await expect(page).toHaveURL(/\/admin/);

      steps.push('Verify dashboard heading and summary copy');
      await expect(page.getByText('管理后台仪表盘')).toBeVisible();
      await expect(page.getByText('平台运营数据概览')).toBeVisible();

      const blockingIssues = monitor.getIssues('P1');
      expect(blockingIssues, JSON.stringify(blockingIssues, null, 2)).toEqual([]);
    } catch (error) {
      actual = error instanceof Error ? error.message : 'Unknown admin dashboard failure';
      monitor.addAssertionIssue(actual, 'P0');
      throw error;
    } finally {
      await writeFlowAudit(
        testInfo,
        {
          title: 'admin-dashboard-smoke',
          role: 'admin',
          route: '/admin',
          expected: 'Admin users can load the dashboard and see the primary heading without blocking issues.',
        },
        actual,
        steps,
        monitor.getIssues(),
      );
    }
  });

  test('should display models dashboard', async ({ page }, testInfo) => {
    const steps: string[] = [];
    const monitor = createIssueMonitor(page);
    let actual = 'Models page rendered';

    try {
      steps.push('Open /admin/models');
      await page.goto('/admin/models');
      await expect(page).toHaveURL(/\/admin\/models/);

      steps.push('Verify models page heading and table shell');
      await expect(page.getByText('AI 模型管理')).toBeVisible();
      await expect(page.locator('table').first()).toBeVisible();

      const blockingIssues = monitor.getIssues('P1');
      expect(blockingIssues, JSON.stringify(blockingIssues, null, 2)).toEqual([]);
    } catch (error) {
      actual = error instanceof Error ? error.message : 'Unknown admin models failure';
      monitor.addAssertionIssue(actual, 'P0');
      throw error;
    } finally {
      await writeFlowAudit(
        testInfo,
        {
          title: 'admin-models-smoke',
          role: 'admin',
          route: '/admin/models',
          expected: 'Admin users can load the models page, see its heading, and render the primary data table without blocking issues.',
        },
        actual,
        steps,
        monitor.getIssues(),
      );
    }
  });

  test('should display diagnostics dashboard', async ({ page }, testInfo) => {
    const steps: string[] = [];
    const monitor = createIssueMonitor(page);
    let actual = 'Diagnostics page rendered';

    try {
      steps.push('Open /admin/diagnostics');
      await page.goto('/admin/diagnostics');
      await expect(page).toHaveURL(/\/admin\/diagnostics/);

      steps.push('Verify diagnostics heading and run button');
      await expect(page.getByRole('heading', { name: '系统诊断' })).toBeVisible();
      await expect(page.getByRole('button', { name: /运行|Run/ }).first()).toBeVisible();

      const blockingIssues = monitor.getIssues('P1');
      expect(blockingIssues, JSON.stringify(blockingIssues, null, 2)).toEqual([]);
    } catch (error) {
      actual = error instanceof Error ? error.message : 'Unknown diagnostics failure';
      monitor.addAssertionIssue(actual, 'P0');
      throw error;
    } finally {
      await writeFlowAudit(
        testInfo,
        {
          title: 'admin-diagnostics-smoke',
          role: 'admin',
          route: '/admin/diagnostics',
          expected: 'Admin users can load diagnostics and see the primary test-run controls without blocking issues.',
        },
        actual,
        steps,
        monitor.getIssues(),
      );
    }
  });

  test('should display users list', async ({ page }, testInfo) => {
    const steps: string[] = [];
    const monitor = createIssueMonitor(page);
    let actual = 'Users page rendered';

    try {
      steps.push('Open /admin/users');
      await page.goto('/admin/users');
      await expect(page).toHaveURL(/\/admin\/users/);

      steps.push('Verify users page heading and filter form');
      await expect(page.getByText('用户管理')).toBeVisible();
      await expect(page.locator('table').first()).toBeVisible();
      await expect(page.locator('input[placeholder="邮箱或昵称..."]').first()).toBeVisible();

      const blockingIssues = monitor.getIssues('P1');
      expect(blockingIssues, JSON.stringify(blockingIssues, null, 2)).toEqual([]);
    } catch (error) {
      actual = error instanceof Error ? error.message : 'Unknown users page failure';
      monitor.addAssertionIssue(actual, 'P0');
      throw error;
    } finally {
      await writeFlowAudit(
        testInfo,
        {
          title: 'admin-users-smoke',
          role: 'admin',
          route: '/admin/users',
          expected: 'Admin users can load the users page, see the table shell, and access the primary search input without blocking issues.',
        },
        actual,
        steps,
        monitor.getIssues(),
      );
    }
  });
});
