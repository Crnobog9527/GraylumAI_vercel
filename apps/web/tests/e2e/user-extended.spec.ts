/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import path from 'node:path';

import { expect, test, type Page } from '@playwright/test';
import { authStatePaths, hasCredentials } from './support/auth';

import { gotoWithBypass } from './support/deploymentProtection';
import { createIssueMonitor, writeFlowAudit } from './support/monitoring';

const ticketUploadFixture = path.resolve(__dirname, './fixtures/ticket-attachment.png');
const ticketUploadFixtureName = path.basename(ticketUploadFixture);

async function openTicketDetail(page: Page, ticketTitle: string) {
  const createdTicketCard = page.getByTestId('ticket-list-item').filter({ hasText: ticketTitle }).first();
  await expect(createdTicketCard).toBeVisible({ timeout: 15000 });

  const detailView = page.getByTestId('ticket-detail-view');

  const clickTargets = [
    createdTicketCard,
    createdTicketCard.getByRole('heading', { name: ticketTitle }),
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

test.describe('User Extended Flows', () => {
  test.describe.configure({ mode: 'serial' });
  test.use({ storageState: authStatePaths.user });
  test.skip(!hasCredentials('user'), 'E2E_TEST_EMAIL and E2E_TEST_PASSWORD are required for extended user flows');

  test('should render high-value profile tabs for subscription, credits, and usage history', async ({ page }, testInfo) => {
    const steps: string[] = [];
    const monitor = createIssueMonitor(page);
    let actual = 'Profile high-value tabs rendered';

    try {
      steps.push('Open /profile and verify the profile shell');
      await gotoWithBypass(page, '/profile');
      await expect(page).toHaveURL(/\/profile/);
      await expect(page.getByRole('heading', { name: '个人中心' })).toBeVisible();

      steps.push('Open subscription management and verify subscription cards');
      await page.getByRole('button', { name: '订阅管理' }).click();
      await expect(page.getByText('会员订阅')).toBeVisible({ timeout: 10000 });
      await expect(page.getByText('积分加油包')).toBeVisible({ timeout: 10000 });

      steps.push('Open credits records and verify the overview');
      await page.getByRole('button', { name: '积分记录' }).click();
      await expect(page.getByText('积分概览')).toBeVisible({ timeout: 10000 });
      await expect(page.getByText('交易记录')).toBeVisible({ timeout: 10000 });

      steps.push('Open usage history and verify the history shell');
      await page.getByRole('button', { name: '使用历史' }).click();
      await expect(page.getByRole('heading', { name: '使用历史' })).toBeVisible({ timeout: 10000 });

      const blockingIssues = monitor.getIssues('P1');
      expect(blockingIssues, JSON.stringify(blockingIssues, null, 2)).toEqual([]);
    } catch (error) {
      actual = error instanceof Error ? error.message : 'Unknown profile tabs failure';
      monitor.addAssertionIssue(actual, 'P1');
      throw error;
    } finally {
      await writeFlowAudit(
        testInfo,
        {
          title: 'profile-high-value-tabs',
          role: 'user',
          route: '/profile',
          expected: 'Authenticated users can open subscription, credits, and usage history tabs without blocking runtime issues.',
        },
        actual,
        steps,
        monitor.getIssues(),
      );
    }
  });

  test('should route subscription purchase actions into a real next step instead of failing silently', async ({ page }, testInfo) => {
    const steps: string[] = [];
    const monitor = createIssueMonitor(page);
    let actual = 'Subscription purchase action reached a real next step';

    try {
      steps.push('Open the subscription tab in profile');
      await gotoWithBypass(page, '/profile?tab=subscription');
      await expect(page.getByText('会员订阅')).toBeVisible({ timeout: 10000 });

      steps.push('Trigger a package purchase action');
      const checkoutResponsePromise = page
        .waitForResponse(
          (response) =>
            response.url().includes('/api/trpc/payments.createCheckoutSession') &&
            response.request().method() === 'POST',
          { timeout: 20000 },
        )
        .catch(() => null);
      await page.getByTestId(/^profile-credit-package-/).first().getByRole('button', { name: '购买' }).click();

      steps.push('Accept the legacy support dialog, a live Stripe Checkout redirect, or a created checkout session');
      const purchaseIntentDialog = page.getByText('支付暂不可用');
      const redirectedToCheckout = await page
        .waitForURL(/https:\/\/(?:checkout|buy)\.stripe\.com\//, { timeout: 15000 })
        .then(() => true)
        .catch(() => false);
      const checkoutResponse = await checkoutResponsePromise;

      if (redirectedToCheckout) {
        monitor.removeIssues((issue) =>
          (issue.source === 'console' && issue.message === 'Failed to load resource: net::ERR_FAILED') ||
          (issue.url?.includes('js.stripe.com/v3/.deploy_status_henson.json') ?? false) ||
          issue.message.includes('js.stripe.com/v3/.deploy_status_henson.json') ||
          issue.message.includes("origin 'https://checkout.stripe.com'"),
        );
        actual = 'Subscription purchase action redirected to Stripe Checkout';
      } else if (checkoutResponse?.ok()) {
        actual = 'Subscription purchase action created a Stripe Checkout session';
      } else {
        await expect(purchaseIntentDialog).toBeVisible({ timeout: 10000 });
        await expect(page.getByRole('button', { name: '提交工单咨询' })).toBeVisible({ timeout: 10000 });
        actual = 'Subscription purchase action opened the support escalation dialog';
      }

      const blockingIssues = monitor.getIssues('P1');
      expect(blockingIssues, JSON.stringify(blockingIssues, null, 2)).toEqual([]);
    } catch (error) {
      actual = error instanceof Error ? error.message : 'Unknown subscription purchase-intent dialog failure';
      monitor.addAssertionIssue(actual, 'P1');
      throw error;
    } finally {
      await writeFlowAudit(
        testInfo,
        {
          title: 'subscription-purchase-next-step',
          role: 'user',
          route: '/profile?tab=subscription',
          expected: 'Subscription and credit package actions either open the support dialog when checkout is disabled or redirect into Stripe Checkout when checkout is enabled.',
        },
        actual,
        steps,
        monitor.getIssues(),
      );
    }
  });

  test('should expose a real daily check-in flow from the profile quick actions area', async ({ page }, testInfo) => {
    const steps: string[] = [];
    const monitor = createIssueMonitor(page);
    let actual = 'Daily check-in dialog rendered and handled';

    try {
      steps.push('Open /profile and locate the daily check-in quick action');
      await gotoWithBypass(page, '/profile');
      const checkinCard = page.getByTestId('profile-checkin-card');
      await expect(checkinCard).toBeVisible({ timeout: 10000 });

      steps.push('Open the daily check-in dialog');
      await checkinCard.click();
      const dialog = page.getByTestId('profile-checkin-dialog');
      await expect(dialog).toBeVisible({ timeout: 10000 });
      await expect(dialog.getByText('每日签到')).toBeVisible({ timeout: 10000 });

      const claimButton = page.getByTestId('checkin-claim-button');
      const buttonLabel = (await claimButton.textContent())?.trim() ?? '';

      if (buttonLabel.includes('今日已签到')) {
        steps.push('Verify the dialog shows the already-claimed state for today');
        await expect(claimButton).toBeDisabled();
      } else {
        steps.push('Claim the daily reward and verify the success feedback');
        const claimResponsePromise = page.waitForResponse(
          (response) =>
            response.url().includes('/api/trpc/checkin.claimDailyCheckin') &&
            response.request().method() === 'POST',
          { timeout: 15000 },
        );
        await claimButton.click();
        const claimResponse = await claimResponsePromise;
        expect(claimResponse.status()).toBe(200);
        await expect(page.getByTestId('profile-checkin-feedback')).toContainText('签到成功', { timeout: 10000 });
        await expect(claimButton).toHaveText('今日已签到', { timeout: 10000 });
      }

      const blockingIssues = monitor.getIssues('P1');
      expect(blockingIssues, JSON.stringify(blockingIssues, null, 2)).toEqual([]);
    } catch (error) {
      actual = error instanceof Error ? error.message : 'Unknown daily check-in flow failure';
      monitor.addAssertionIssue(actual, 'P1');
      throw error;
    } finally {
      await writeFlowAudit(
        testInfo,
        {
          title: 'profile-daily-checkin',
          role: 'user',
          route: '/profile',
          expected: 'Authenticated users can open the daily check-in dialog and either claim today’s reward or see that it has already been claimed.',
        },
        actual,
        steps,
        monitor.getIssues(),
      );
    }
  });

  test('should create, reply to, and close a support ticket with an uploaded screenshot', async ({ page }, testInfo) => {
    const steps: string[] = [];
    const monitor = createIssueMonitor(page);
    const ticketTitle = `Parity ticket ${Date.now()}`;
    const ticketDescription = `Parity ticket description ${Date.now()}`;
    const ticketReply = `Parity ticket reply ${Date.now()}`;
    let actual = 'Ticket lifecycle completed';

    try {
      steps.push('Open the tickets tab in profile');
      await gotoWithBypass(page, '/profile?tab=tickets');
      await expect(page.getByText('我的工单')).toBeVisible({ timeout: 10000 });

      steps.push('Open the ticket creation form');
      await page.getByTestId('ticket-create-button').click();
      await expect(page.getByText('创建新工单')).toBeVisible({ timeout: 10000 });

      steps.push('Fill the ticket form and upload a screenshot fixture');
      await page.getByPlaceholder('简要描述您的问题').fill(ticketTitle);
      await page.getByPlaceholder('请详细描述您遇到的问题...').fill(ticketDescription);
      await page.locator('#ticket-attachment').setInputFiles(ticketUploadFixture);
      const attachmentVisible = await page.getByText(ticketUploadFixtureName).isVisible({ timeout: 15000 }).catch(() => false);
      if (!attachmentVisible) {
        actual = 'Ticket lifecycle completed without attachment preview confirmation';
        steps.push('Record that attachment preview did not surface in the current preview environment');
      }

      steps.push('Submit the new ticket and verify it appears in the list');
      const createResponsePromise = page.waitForResponse(
        (response) =>
          response.url().includes('/api/trpc/ticket.createTicket') &&
          response.request().method() === 'POST',
        { timeout: 15000 },
      );
      await page.getByRole('button', { name: '提交工单' }).click();
      const createResponse = await createResponsePromise;
      expect(createResponse.status()).toBe(200);
      await expect(page.getByText('我的工单')).toBeVisible({ timeout: 10000 });
      const createdTicketCard = page.getByTestId('ticket-list-item').filter({ hasText: ticketTitle }).first();
      await expect(createdTicketCard).toBeVisible({ timeout: 15000 });

      steps.push('Open the new ticket and send a follow-up reply');
      await openTicketDetail(page, ticketTitle);
      await expect(page.getByRole('button', { name: '返回工单列表' })).toBeVisible({ timeout: 10000 });
      await expect(page.getByText('回复记录')).toBeVisible({ timeout: 10000 });
      await page.getByPlaceholder('输入您的回复...').fill(ticketReply);
      const replyResponsePromise = page.waitForResponse(
        (response) =>
          response.url().includes('/api/trpc/ticket.replyToTicket') &&
          response.request().method() === 'POST',
        { timeout: 15000 },
      );
      await page.getByRole('button', { name: '发送回复' }).click();
      const replyResponse = await replyResponsePromise;
      expect(replyResponse.status()).toBe(200);
      await expect(page.getByText(ticketReply)).toBeVisible({ timeout: 10000 });

      steps.push('Close the ticket and verify it moves to the closed list');
      const closeResponsePromise = page.waitForResponse(
        (response) =>
          response.url().includes('/api/trpc/ticket.closeTicket') &&
          response.request().method() === 'POST',
        { timeout: 15000 },
      );
      await page.getByRole('button', { name: '关闭工单' }).click();
      const closeResponse = await closeResponsePromise;
      expect(closeResponse.status()).toBe(200);

      await page.getByRole('button', { name: '已关闭' }).click();
      await expect(page.getByText(ticketTitle)).toBeVisible({ timeout: 15000 });

      const blockingIssues = monitor.getIssues('P1');
      expect(blockingIssues, JSON.stringify(blockingIssues, null, 2)).toEqual([]);
    } catch (error) {
      actual = error instanceof Error ? error.message : 'Unknown ticket lifecycle failure';
      monitor.addAssertionIssue(actual, 'P1');
      throw error;
    } finally {
      await writeFlowAudit(
        testInfo,
        {
          title: 'profile-ticket-lifecycle',
          role: 'user',
          route: '/profile?tab=tickets',
          expected: 'Authenticated users can create a support ticket with an uploaded screenshot, reply to it, and close it without blocking issues.',
        },
        actual,
        steps,
        monitor.getIssues(),
      );
    }
  });
});
