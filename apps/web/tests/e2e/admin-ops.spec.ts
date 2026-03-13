/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { expect, test, type Page } from '@playwright/test';
import { authStatePaths, getCredentials, hasCredentials } from './support/auth';
import { safeCloseContext } from './support/contextCleanup';
import { applyDeploymentProtectionBypass, gotoWithBypass } from './support/deploymentProtection';
import { createIssueMonitor, writeFlowAudit } from './support/monitoring';

async function openUserTicketDetail(page: Page, ticketTitle: string) {
  const ticketCard = page.getByTestId('ticket-list-item').filter({ hasText: ticketTitle }).first();
  await expect(ticketCard).toBeVisible({ timeout: 15000 });

  const detailView = page.getByTestId('ticket-detail-view');
  const clickTargets = [
    ticketCard,
    ticketCard.getByRole('heading', { name: ticketTitle }),
    page.getByText(ticketTitle, { exact: true }).first(),
  ];

  for (const target of clickTargets) {
    if (await detailView.isVisible().catch(() => false)) {
      return;
    }

    await target.click({ force: true });
    const opened = await detailView.isVisible({ timeout: 3000 }).catch(() => false);
    if (opened) {
      return;
    }
  }

  await expect(detailView).toBeVisible({ timeout: 10000 });
}

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
      await page.getByRole('button', { name: '刷新', exact: true }).click();

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
    test.setTimeout(90000);
    const steps: string[] = [];
    const monitor = createIssueMonitor(page);
    let actual = 'Operational read pages flow completed';

    try {
      steps.push('Open /admin/transactions and use a transaction tab and search filter');
      await gotoWithBypass(page, '/admin/transactions');
      await expect(page.getByTestId('admin-transactions-stat-additions')).toBeVisible({ timeout: 15000 });
      await expect(page.getByTestId('admin-transactions-filters')).toBeVisible({ timeout: 15000 });
      await page.getByRole('tab', { name: '增加' }).click().catch(() => undefined);
      await expect(page.getByTestId('admin-transactions-type-tabs')).toContainText('增加');
      await page.getByPlaceholder('搜索用户邮箱或昵称...').fill('e2e');
      await expect(page.getByTestId('admin-transactions-table-card')).toBeVisible({ timeout: 10000 });
      const transactionRows = page.locator('[data-testid^="admin-transaction-row-"]');
      const loadingBadge = page.getByTestId('admin-transactions-loading-badge');
      await expect
        .poll(async () => {
          const transactionRowCount = await transactionRows.count();
          const emptyVisible = await page.getByTestId('admin-transactions-empty-state').isVisible().catch(() => false);
          const loadingVisible = await loadingBadge.isVisible().catch(() => false);
          return transactionRowCount > 0 || emptyVisible || !loadingVisible;
        }, { timeout: 15000 })
        .toBe(true);
      const transactionRowCount = await transactionRows.count();
      if (transactionRowCount > 0) {
        await expect(transactionRows.first()).toBeVisible({ timeout: 10000 });
      } else {
        await expect(page.getByTestId('admin-transactions-empty-state')).toBeVisible({ timeout: 15000 });
      }

      steps.push('Open /admin/finance and switch to API statistics');
      await gotoWithBypass(page, '/admin/finance');
      await expect(page.getByTestId('admin-finance-page')).toBeVisible({ timeout: 15000 });
      await expect(page.getByTestId('admin-finance-header')).toContainText('财务统计');
      await expect(page.getByTestId('admin-finance-tabs')).toBeVisible({ timeout: 15000 });
      await expect(page.getByTestId('admin-finance-overview-revenue')).toBeVisible({ timeout: 15000 });
      await page.getByRole('tab', { name: 'API 统计' }).click();
      await expect(page.getByTestId('admin-finance-api-section')).toBeVisible({ timeout: 10000 });
      await page.getByRole('tab', { name: '模型渠道' }).click();
      await expect(page.getByTestId('admin-finance-models-section')).toBeVisible({ timeout: 10000 });
      const financeModelRows = page.locator('[data-testid^="admin-finance-model-row-"]');
      const financeModelRowCount = await financeModelRows.count();
      if (financeModelRowCount > 0) {
        await expect(financeModelRows.first()).toBeVisible({ timeout: 10000 });
      }

      steps.push('Open /admin/invitations and verify search, filter, and refresh controls');
      await gotoWithBypass(page, '/admin/invitations');
      await expect(page.getByTestId('admin-invitations-stat-total')).toBeVisible({ timeout: 15000 });
      await expect(page.getByTestId('admin-invitations-records-section')).toBeVisible({ timeout: 15000 });
      await page.getByPlaceholder('搜索邮箱或邀请码...').fill('test');
      await page.getByTestId('admin-invitations-status-filter').click();
      await page.getByRole('option', { name: '已发放' }).click();
      await page.getByTestId('admin-invitations-refresh').click();
      const invitationRows = page.locator('[data-testid^="admin-invitation-row-"]');
      const invitationRowCount = await invitationRows.count();
      if (invitationRowCount > 0) {
        await expect(invitationRows.first()).toBeVisible({ timeout: 10000 });
      } else {
        await expect(page.getByTestId('admin-invitations-empty-state')).toBeVisible({ timeout: 10000 });
      }

      steps.push('Open /admin/costs and switch the report tab');
      await gotoWithBypass(page, '/admin/costs');
      await expect(page.getByTestId('admin-costs-distribution-card')).toBeVisible({ timeout: 15000 });
      await page.getByRole('tab', { name: 'AI 调用日志' }).click();
      await expect(page.getByTestId('admin-costs-usage-logs-section')).toBeVisible({ timeout: 10000 });
      const usageRows = page.locator('[data-testid^="admin-usage-log-row-"]');
      await expect
        .poll(async () => {
          const usageRowCount = await usageRows.count();
          const usageEmptyVisible = await page.getByTestId('admin-costs-usage-logs-empty').isVisible().catch(() => false);
          return usageRowCount > 0 || usageEmptyVisible;
        }, { timeout: 10000 })
        .toBe(true);
      const usageRowCount = await usageRows.count();
      if (usageRowCount > 0) {
        await expect(usageRows.first()).toBeVisible({ timeout: 10000 });
      } else {
        await expect(page.getByTestId('admin-costs-usage-logs-empty')).toBeVisible({ timeout: 10000 });
      }
      await page.getByRole('tab', { name: 'Token 统计' }).click();
      await expect(page.getByTestId('admin-costs-token-stats-section')).toBeVisible({ timeout: 10000 });
      const tokenRows = page.locator('[data-testid^="admin-token-stat-row-"]');
      await expect
        .poll(async () => {
          const tokenRowCount = await tokenRows.count();
          const tokenEmptyVisible = await page.getByTestId('admin-costs-token-stats-empty').isVisible().catch(() => false);
          return tokenRowCount > 0 || tokenEmptyVisible;
        }, { timeout: 10000 })
        .toBe(true);
      const tokenRowCount = await tokenRows.count();
      if (tokenRowCount > 0) {
        await expect(tokenRows.first()).toBeVisible({ timeout: 10000 });
      } else {
        await expect(page.getByTestId('admin-costs-token-stats-empty')).toBeVisible({ timeout: 10000 });
      }

      steps.push('Open /admin/performance and switch through overview, token, and model statistics');
      await gotoWithBypass(page, '/admin/performance');
      await expect(page.getByTestId('admin-performance-tabs')).toBeVisible({ timeout: 15000 });
      await expect(page.getByTestId('admin-performance-overview-requests')).toBeVisible({ timeout: 15000 });
      await expect(page.getByTestId('admin-performance-activity-trend')).toBeVisible({ timeout: 15000 });
      await page.getByRole('tab', { name: 'Token 统计' }).click();
      await expect(page.getByTestId('admin-performance-token-summary')).toBeVisible({ timeout: 15000 });
      const modelsTab = page.getByRole('tab', { name: '模型使用' });
      await modelsTab.click();
      await expect(modelsTab).toHaveAttribute('data-state', 'active');
      await expect(page.getByText('AI 模型使用情况', { exact: true })).toBeVisible({ timeout: 15000 });
      const performanceModelRows = page.locator('[data-testid^="admin-performance-model-row-"]');
      const performanceModelRowCount = await performanceModelRows.count();
      if (performanceModelRowCount > 0) {
        await expect(performanceModelRows.first()).toBeVisible({ timeout: 15000 });
      } else {
        await expect(page.getByTestId('admin-performance-models-empty')).toBeVisible({ timeout: 15000 });
      }

      steps.push('Open /admin/tickets and verify the detail sheet shell is available');
      await gotoWithBypass(page, '/admin/tickets');
      await expect(page.getByTestId('admin-tickets-page')).toBeVisible({ timeout: 10000 });
      await expect(page.getByTestId('admin-tickets-header')).toContainText('工单管理');
      await expect(page.getByTestId('admin-tickets-table-card')).toBeVisible({ timeout: 10000 });

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

  test('should let admins process a user ticket and surface the reply back in the user profile', async ({ browser, page }, testInfo) => {
    test.setTimeout(60000);
    const steps: string[] = [];
    const monitor = createIssueMonitor(page);
    const ticketTitle = `Parity admin ticket ${Date.now()}`;
    const ticketDescription = `Parity admin ticket description ${Date.now()}`;
    const adminReply = `Parity admin reply ${Date.now()}`;
    let actual = 'Admin ticket lifecycle completed';

    const userContext = await browser.newContext({ storageState: authStatePaths.user });
    const userPage = await userContext.newPage();
    const userMonitor = createIssueMonitor(userPage);

    try {
      steps.push('Open the user tickets tab and create a fresh ticket');
      await applyDeploymentProtectionBypass(userPage);
      await userPage.goto(new URL('/profile?tab=tickets', process.env.PLAYWRIGHT_BASE_URL!).toString(), {
        waitUntil: 'networkidle',
      });
      await expect(userPage.getByText('我的工单')).toBeVisible({ timeout: 15000 });
      await userPage.getByTestId('ticket-create-button').click();
      await expect(userPage.getByText('创建新工单')).toBeVisible({ timeout: 10000 });
      await userPage.getByPlaceholder('简要描述您的问题').fill(ticketTitle);
      await userPage.getByPlaceholder('请详细描述您遇到的问题...').fill(ticketDescription);

      const createResponsePromise = userPage.waitForResponse(
        (response) =>
          response.url().includes('/api/trpc/ticket.createTicket') &&
          response.request().method() === 'POST',
        { timeout: 15000 },
      );
      await userPage.getByRole('button', { name: '提交工单' }).click();
      const createResponse = await createResponsePromise;
      expect(createResponse.status()).toBe(200);
      const createdTicketCard = userPage.getByTestId('ticket-list-item').filter({ hasText: ticketTitle }).first();
      await expect(createdTicketCard).toBeVisible({ timeout: 15000 });

      steps.push('Open /admin/tickets and locate the new ticket');
      await gotoWithBypass(page, '/admin/tickets');
      await expect(page).toHaveURL(/\/admin\/tickets/);
      const targetRow = page.locator('tbody tr').filter({ hasText: ticketTitle }).first();
      await expect(targetRow).toBeVisible({ timeout: 15000 });

      steps.push('Open the admin ticket detail sheet and update the status to in-progress');
      await targetRow.locator('[data-testid^="admin-ticket-open-"]').click();
      await expect(page.getByTestId('admin-ticket-detail-sheet')).toBeVisible({ timeout: 10000 });
      const updateStatusPromise = page.waitForResponse(
        (response) =>
          response.url().includes('/api/trpc/admin.updateTicketStatus') &&
          response.request().method() === 'POST',
        { timeout: 15000 },
      );
      await page.getByTestId('admin-ticket-status-select').click();
      await page.getByRole('option', { name: '处理中' }).click();
      const updateStatusResponse = await updateStatusPromise;
      expect(updateStatusResponse.status()).toBe(200);

      steps.push('Reply as admin inside the ticket detail sheet');
      await page.getByTestId('admin-ticket-reply-input').fill(adminReply);
      const replyResponsePromise = page.waitForResponse(
        (response) =>
          response.url().includes('/api/trpc/admin.replyToTicket') &&
          response.request().method() === 'POST',
        { timeout: 15000 },
      );
      await page.getByTestId('admin-ticket-reply-submit').click();
      const replyResponse = await replyResponsePromise;
      expect(replyResponse.status()).toBe(200);
      await expect(page.getByTestId('admin-ticket-reply-input')).toHaveValue('', { timeout: 15000 });

      steps.push('Return to the user profile and verify the admin reply is visible');
      await userPage.reload({ waitUntil: 'networkidle' });
      await openUserTicketDetail(userPage, ticketTitle);
      await expect(userPage.getByText(adminReply)).toBeVisible({ timeout: 15000 });
      await expect(userPage.getByText('处理中')).toBeVisible({ timeout: 15000 });

      steps.push('Close the ticket from the user side to keep the audit data isolated');
      const closeResponsePromise = userPage.waitForResponse(
        (response) =>
          response.url().includes('/api/trpc/ticket.closeTicket') &&
          response.request().method() === 'POST',
        { timeout: 15000 },
      );
      await userPage.getByRole('button', { name: '关闭工单' }).click();
      const closeResponse = await closeResponsePromise;
      expect(closeResponse.status()).toBe(200);

      const blockingIssues = [
        ...monitor.getIssues('P1'),
        ...userMonitor.getIssues('P1'),
      ];
      expect(blockingIssues, JSON.stringify(blockingIssues, null, 2)).toEqual([]);
    } catch (error) {
      actual = error instanceof Error ? error.message : 'Unknown admin ticket lifecycle failure';
      monitor.addAssertionIssue(actual, 'P1');
      throw error;
    } finally {
      await safeCloseContext(userContext);
      await writeFlowAudit(
        testInfo,
        {
          title: 'admin-ticket-lifecycle',
          role: 'admin',
          route: '/admin/tickets,/profile?tab=tickets',
          expected: 'Admins can process a user support ticket by changing status and replying, and the user can see the update in the profile ticket detail view.',
        },
        actual,
        steps,
        [...monitor.getIssues(), ...userMonitor.getIssues()],
      );
    }
  });
});
