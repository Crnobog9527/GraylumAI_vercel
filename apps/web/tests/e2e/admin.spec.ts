/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { test, expect, type Browser, type Locator, type Page } from '@playwright/test';
import { authStatePaths, getCredentials, hasCredentials } from './support/auth';
import { safeCloseContext } from './support/contextCleanup';
import { gotoWithBypass } from './support/deploymentProtection';
import { createIssueMonitor, writeFlowAudit } from './support/monitoring';
import {
  isLocalPlaywrightBaseUrl,
  isRegionRestrictionIssue,
  responseShowsRegionRestriction,
} from './support/runtimeConstraints';

async function readCreditsFromRow(row: Locator) {
  const creditsCell = row.locator('td').nth(4);
  const rawText = await creditsCell.textContent();
  return Number((rawText ?? '').replace(/[^\d-]/g, ''));
}

async function ensureUserCreditsAtLeast(browser: Browser, minimumCredits: number) {
  if (!hasCredentials('admin') || !hasCredentials('user') || !process.env.PLAYWRIGHT_BASE_URL) {
    return;
  }

  const context = await browser.newContext({ storageState: authStatePaths.admin });
  const page = await context.newPage();

  try {
    await gotoWithBypass(page, '/admin/users');
    await expect(page).toHaveURL(/\/admin\/users/);

    const targetEmail = getCredentials('user').email;
    await page.locator('input[placeholder="邮箱或昵称..."]').fill(targetEmail);
    const targetRow = page.locator('tbody tr').filter({ hasText: targetEmail }).first();
    await expect(targetRow).toBeVisible({ timeout: 15000 });

    const currentCredits = await readCreditsFromRow(targetRow);
    if (currentCredits >= minimumCredits) {
      return;
    }

    const delta = minimumCredits - currentCredits;
    await targetRow.getByRole('button', { name: '积分' }).click();
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 10000 });
    await page.locator('input[type="number"]').fill(String(delta));
    await page.locator('input[placeholder="奖励积分、退款等..."]').fill(`Admin diagnostics runtime proof top-up ${Date.now()}`);

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
    await page.getByRole('button', { name: '刷新' }).click();
    await expect
      .poll(async () => readCreditsFromRow(targetRow), { timeout: 15000 })
      .toBeGreaterThanOrEqual(minimumCredits);
  } finally {
    await safeCloseContext(context);
  }
}

async function dismissLowBalanceDialogIfVisible(page: Page) {
  const dismissButton = page.getByRole('button', { name: '稍后再说' });
  if (await dismissButton.isVisible({ timeout: 5000 }).catch(() => false)) {
    await dismissButton.click();
    return true;
  }
  return false;
}

async function expectUserMessageVisible(page: Page, prompt: string, timeout = 20000) {
  await expect(
    page.locator('[data-testid="chat-message"][data-message-role="user"]').filter({ hasText: prompt }).last()
  ).toBeVisible({ timeout });
}

test.describe('Admin Dashboard', () => {
  test.use({ storageState: authStatePaths.admin });
  test.skip(!hasCredentials('admin'), 'E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD are required for admin flows');

  test('should display admin dashboard', async ({ page }, testInfo) => {
    const steps: string[] = [];
    const monitor = createIssueMonitor(page);
    let actual = 'Admin dashboard rendered';

    try {
      steps.push('Open /admin');
      await gotoWithBypass(page, '/admin');
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
      await gotoWithBypass(page, '/admin/models');
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
      await gotoWithBypass(page, '/admin/diagnostics');
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

  test('should show passed runtime proof after a real user chat request', async ({ browser, page }, testInfo) => {
    test.skip(isLocalPlaywrightBaseUrl(), 'Runtime-proof chat verification requires a deployed Vercel environment.');
    test.setTimeout(90000);
    const steps: string[] = [];
    const monitor = createIssueMonitor(page);
    const prompt = `运行证据测试${Date.now()}`;
    let actual = 'Runtime proof card showed passed status after a live chat request';

    const userContext = await browser.newContext({ storageState: authStatePaths.user });
    const userPage = await userContext.newPage();

    try {
      steps.push('Ensure the E2E user has enough credits for chat');
      await ensureUserCreditsAtLeast(browser, 100);

      steps.push('Open /chat as the E2E user');
      await gotoWithBypass(userPage, '/chat');

      steps.push('Send a real chat prompt and wait for /api/ai/stream');
      const input = userPage.locator('textarea[placeholder="请输入您的问题..."]');
      await input.fill(prompt);
      const streamResponsePromise = userPage.waitForResponse(
        (response) =>
          response.url().includes('/api/ai/stream') &&
          response.request().method() === 'POST',
        { timeout: 20000 },
      );
      await userPage.getByRole('button', { name: '发送' }).click();
      const dismissedLowBalance = await dismissLowBalanceDialogIfVisible(userPage);
      if (dismissedLowBalance) {
        await userPage.getByRole('button', { name: '发送' }).click();
      }
      const streamResponse = await streamResponsePromise;
      if (isLocalPlaywrightBaseUrl() && await responseShowsRegionRestriction(streamResponse)) {
        steps.push('Detected provider region restriction in the local environment and treated the runtime-proof chat probe as non-blocking');
        monitor.removeIssues((issue) => isRegionRestrictionIssue(issue));
        actual = 'Skipped local runtime-proof chat probe because the upstream model provider rejected the request by region';
        return;
      }
      expect(streamResponse.status()).toBe(200);
      await expectUserMessageVisible(userPage, prompt);
      await expect(userPage.getByRole('button', { name: '发送' })).toBeVisible({ timeout: 60000 });

      steps.push('Open /admin/diagnostics and refresh runtime proof');
      await gotoWithBypass(page, '/admin/diagnostics');
      await expect(page).toHaveURL(/\/admin\/diagnostics/);
      await page.getByRole('button', { name: '刷新证据' }).click();

      steps.push('Assert that the latest runtime proof is marked as passed');
      await expect(page.getByText('最新真实运行证据')).toBeVisible();
      await expect(page.getByTestId('runtime-proof-message')).toContainText('已验证最近一次真实请求', { timeout: 20000 });
      await expect(page.getByTestId('runtime-proof-status')).toContainText('通过');

      const blockingIssues = monitor.getIssues('P1');
      expect(blockingIssues, JSON.stringify(blockingIssues, null, 2)).toEqual([]);
    } catch (error) {
      actual = error instanceof Error ? error.message : 'Unknown runtime proof verification failure';
      monitor.addAssertionIssue(actual, 'P0');
      throw error;
    } finally {
      await safeCloseContext(userContext);
      await writeFlowAudit(
        testInfo,
        {
          title: 'admin-runtime-proof-live',
          role: 'admin',
          route: '/admin/diagnostics',
          expected: 'After a real user chat request, admin diagnostics should show the latest runtime proof as passed.',
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
      await gotoWithBypass(page, '/admin/users');
      await expect(page).toHaveURL(/\/admin\/users/);

      steps.push('Verify users page heading and filter form');
      await expect(page.getByRole('heading', { name: '用户管理' })).toBeVisible();
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
