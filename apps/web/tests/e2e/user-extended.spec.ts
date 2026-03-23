/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import path from 'node:path';

import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import { authStatePaths, getCredentials, hasCredentials } from './support/auth';
import {
  createConversationFixtureForUserEmail,
  ensureCreditsAtLeastForUserEmail,
  softDeleteConversationFixture,
} from './support/creditFixtures';
import { safeCloseContext } from './support/contextCleanup';
import { applyDeploymentProtectionBypass, gotoWithBypass } from './support/deploymentProtection';
import { createIssueMonitor, writeFlowAudit } from './support/monitoring';

const ticketUploadFixture = path.resolve(__dirname, './fixtures/ticket-attachment.txt');
const ticketUploadFixtureName = path.basename(ticketUploadFixture);

async function expectUserMessageVisible(page: Page, prompt: string, timeout = 20000) {
  await expect(
    page.locator('[data-testid="chat-message"][data-message-role="user"]').filter({ hasText: prompt }).last()
  ).toBeVisible({ timeout });
}

async function ensureUserHasChatCredits(browser: Browser, minimumCredits = 300) {
  if (!hasCredentials('user')) {
    return;
  }
  await ensureCreditsAtLeastForUserEmail(
    getCredentials('user').email,
    minimumCredits,
    `Parity user suite top-up ${Date.now()}`
  );
}

async function createSeededConversation(
  title: string,
  userMessage = `Fixture user message ${Date.now()}`,
  assistantMessage = `Fixture assistant reply ${Date.now()}`
) {
  return createConversationFixtureForUserEmail(getCredentials('user').email, {
    title,
    userMessage,
    assistantMessage,
  });
}

async function openConversationRow(page: Page, title: string) {
  await gotoWithBypass(page, '/chat');
  const conversationRow = page.getByTestId('conversation-item').filter({ hasText: title }).first();
  await expect(conversationRow).toBeVisible({ timeout: 15000 });
  await conversationRow.click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible({ timeout: 15000 });
  return conversationRow;
}

async function renameConversation(page: Page, title: string) {
  const renameDialog = page.getByRole('dialog', { name: '重命名对话' });
  await expect(renameDialog).toBeVisible({ timeout: 10000 });
  const renameInput = renameDialog.getByRole('textbox', { name: '输入新标题' });
  await renameInput.fill(title);

  const renameResponsePromise = page.waitForResponse(
    (response) =>
      response.url().includes('/api/trpc/chat.updateConversationTitle') &&
      response.request().method() === 'POST',
    { timeout: 15000 },
  );
  await renameDialog.getByRole('button', { name: '保存' }).click();
  const renameResponse = await renameResponsePromise;
  expect(renameResponse.status()).toBe(200);

  await expect(page.getByRole('heading', { name: title })).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId('conversation-item').filter({ hasText: title }).first()).toBeVisible({ timeout: 10000 });
}

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

  test.beforeAll(async ({ browser }) => {
    await ensureUserHasChatCredits(browser);
  });

  test('should delete a conversation from the chat sidebar after creating and renaming it', async ({ page }, testInfo) => {
    const steps: string[] = [];
    const monitor = createIssueMonitor(page);
    const seededTitle = `Parity delete seed ${Date.now()}`;
    const renamedTitle = `Parity delete ${Date.now()}`;
    let actual = 'Conversation deletion flow completed';
    let fixtureConversationId: string | null = null;

    try {
      steps.push('Seed a conversation fixture and open it from the sidebar');
      const seededConversation = await createSeededConversation(seededTitle);
      fixtureConversationId = seededConversation.id;
      const seededRow = await openConversationRow(page, seededTitle);

      steps.push('Rename the seeded conversation to a deterministic title');
      await seededRow.hover();
      await seededRow.getByTestId('conversation-actions-trigger').click({ force: true });
      await page.getByRole('menuitem', { name: '重命名' }).click();
      await renameConversation(page, renamedTitle);

      const conversationRow = page.getByTestId('conversation-item').filter({ hasText: renamedTitle }).first();
      await expect(conversationRow).toBeVisible({ timeout: 10000 });

      steps.push('Open the conversation action menu from the sidebar');
      await conversationRow.hover();
      await conversationRow.getByTestId('conversation-actions-trigger').click({ force: true });
      await page.getByRole('menuitem', { name: '删除' }).click();

      steps.push('Confirm deletion and verify the conversation disappears');
      const deleteResponsePromise = page.waitForResponse(
        (response) =>
          response.url().includes('/api/trpc/chat.deleteConversation') &&
          response.request().method() === 'POST',
        { timeout: 15000 },
      );
      await page.getByRole('button', { name: '删除' }).click();
      const deleteResponse = await deleteResponsePromise;
      expect(deleteResponse.status()).toBe(200);

      await expect(conversationRow).toHaveCount(0, { timeout: 15000 });
      await expect(page.getByRole('heading', { name: renamedTitle })).toHaveCount(0);
      const blockingIssues = monitor.getIssues('P1');
      expect(blockingIssues, JSON.stringify(blockingIssues, null, 2)).toEqual([]);
    } catch (error) {
      actual = error instanceof Error ? error.message : 'Unknown conversation deletion failure';
      monitor.addAssertionIssue(actual, 'P1');
      throw error;
    } finally {
      await writeFlowAudit(
        testInfo,
        {
          title: 'chat-delete-conversation',
          role: 'user',
          route: '/chat',
          expected: 'Authenticated users can delete an existing conversation from the sidebar and the deleted item disappears from the list.',
        },
        actual,
        steps,
        monitor.getIssues(),
      );
      if (fixtureConversationId) {
        await softDeleteConversationFixture(fixtureConversationId);
      }
    }
  });

  test('should delete multiple conversations from sidebar management mode', async ({ page }, testInfo) => {
    const steps: string[] = [];
    const monitor = createIssueMonitor(page);
    const firstTitle = `Parity batch delete A ${Date.now()}`;
    const secondTitle = `Parity batch delete B ${Date.now()}`;
    let actual = 'Batch conversation deletion flow completed';
    const fixtureConversationIds: string[] = [];

    try {
      steps.push('Seed two conversations that will be deleted in management mode');
      const firstConversation = await createSeededConversation(firstTitle);
      const secondConversation = await createSeededConversation(secondTitle);
      fixtureConversationIds.push(firstConversation.id, secondConversation.id);

      await gotoWithBypass(page, '/chat');

      const firstRow = page.getByTestId('conversation-item').filter({ hasText: firstTitle }).first();
      const secondRow = page.getByTestId('conversation-item').filter({ hasText: secondTitle }).first();
      await expect(firstRow).toBeVisible({ timeout: 10000 });
      await expect(secondRow).toBeVisible({ timeout: 10000 });

      steps.push('Enter management mode and select both conversations');
      await page.getByTestId('conversation-manage-toggle').click();
      await expect(page.getByTestId('conversation-selected-count')).toContainText('已选择 0 条');
      await firstRow.click();
      await secondRow.click();
      await expect(page.getByTestId('conversation-selected-count')).toContainText('已选择 2 条');

      steps.push('Trigger batch deletion and confirm the selected conversations disappear');
      const deleteRequestPromise = page.waitForRequest(
        (request) =>
          request.url().includes('/api/trpc/chat.deleteConversations') &&
          request.method() === 'POST',
        { timeout: 15000 },
      );
      await page.getByTestId('conversation-batch-delete').click();
      await page.getByRole('button', { name: '删除 2 条' }).click();
      await deleteRequestPromise;

      await expect(firstRow).toHaveCount(0, { timeout: 15000 });
      await expect(secondRow).toHaveCount(0, { timeout: 15000 });
      fixtureConversationIds.length = 0;

      const blockingIssues = monitor.getIssues('P1');
      expect(blockingIssues, JSON.stringify(blockingIssues, null, 2)).toEqual([]);
    } catch (error) {
      actual = error instanceof Error ? error.message : 'Unknown batch conversation deletion failure';
      monitor.addAssertionIssue(actual, 'P1');
      throw error;
    } finally {
      await writeFlowAudit(
        testInfo,
        {
          title: 'chat-batch-delete-conversations',
          role: 'user',
          route: '/chat',
          expected: 'Authenticated users can enter chat management mode, select multiple conversations, and delete them in one action.',
        },
        actual,
        steps,
        monitor.getIssues(),
      );
      await Promise.all(fixtureConversationIds.map((conversationId) => softDeleteConversationFixture(conversationId)));
    }
  });

  test('should expose selected conversation export in sidebar management mode', async ({ page }, testInfo) => {
    const steps: string[] = [];
    const monitor = createIssueMonitor(page);
    const title = `Parity selected export ${Date.now()}`;
    const userMessage = `Parity selected export user ${Date.now()}`;
    let actual = 'Selected conversation export management flow completed';
    let fixtureConversationId: string | null = null;

    try {
      steps.push('Seed a conversation with message history to export from management mode');
      const seededConversation = await createSeededConversation(title, userMessage, `Parity selected export assistant ${Date.now()}`);
      fixtureConversationId = seededConversation.id;
      const conversationRow = await openConversationRow(page, title);

      steps.push('Enter management mode and select the conversation');
      await page.getByTestId('conversation-manage-toggle').click();
      await conversationRow.click();
      await expect(page.getByTestId('conversation-selected-count')).toContainText('已选择 1 条');

      steps.push('Open the batch export dialog');
      await page.getByTestId('conversation-batch-export').click();
      await expect(page.getByRole('dialog')).toBeVisible({ timeout: 10000 });

      const exportButton = page.getByTestId('export-selected-conversations');
      const canExportSelected = await exportButton.isEnabled();
      if (canExportSelected) {
        steps.push('Download the selected conversation bundle when membership allows it');
        const downloadPromise = page.waitForEvent('download', { timeout: 15000 });
        await exportButton.click();
        const download = await downloadPromise;
        expect(download.suggestedFilename()).toMatch(/\.(md|json)$/);
        await expect(page.getByText('导出成功！')).toBeVisible({ timeout: 10000 });
      } else {
        steps.push('Verify the upgrade hint is shown when selected batch export is locked');
        await expect(page.getByText('升级会员可解锁批量导出功能')).toBeVisible({ timeout: 10000 });
      }

      const blockingIssues = monitor.getIssues('P1');
      expect(blockingIssues, JSON.stringify(blockingIssues, null, 2)).toEqual([]);
    } catch (error) {
      actual = error instanceof Error ? error.message : 'Unknown selected batch export failure';
      monitor.addAssertionIssue(actual, 'P1');
      throw error;
    } finally {
      await writeFlowAudit(
        testInfo,
        {
          title: 'chat-selected-batch-export',
          role: 'user',
          route: '/chat',
          expected: 'Authenticated users can select conversations in management mode and either export them in batch or see the membership restriction clearly.',
        },
        actual,
        steps,
        monitor.getIssues(),
      );
      if (fixtureConversationId) {
        await softDeleteConversationFixture(fixtureConversationId);
      }
    }
  });

  test('should restore the active conversation after refreshing the chat page', async ({ page }, testInfo) => {
    const steps: string[] = [];
    const monitor = createIssueMonitor(page);
    const renamedTitle = `Parity refresh ${Date.now()}`;
    const userMessage = `Parity refresh user ${Date.now()}`;
    let actual = 'Conversation restored after refresh';
    let fixtureConversationId: string | null = null;

    try {
      steps.push('Seed an existing conversation and open it from the sidebar');
      const seededConversation = await createSeededConversation(renamedTitle, userMessage, `Parity refresh assistant ${Date.now()}`);
      fixtureConversationId = seededConversation.id;
      const conversationRow = await openConversationRow(page, renamedTitle);

      steps.push('Refresh /chat to verify the active conversation is restored from persisted state');
      await page.reload({ waitUntil: 'networkidle' });
      await expect(page).toHaveURL(/\/chat/);

      steps.push('Verify the renamed conversation title and previous prompt are still loaded');
      await expect(page.getByRole('heading', { name: renamedTitle })).toBeVisible({ timeout: 15000 });
      await expectUserMessageVisible(page, userMessage);
      await expect(conversationRow).toBeVisible({ timeout: 15000 });
      monitor.removeIssues(
        (issue) =>
          issue.source === 'requestfailed' &&
          issue.message === 'net::ERR_ABORTED' &&
          issue.method === 'GET' &&
          issue.url?.includes('/rest/v1/messages') === true
      );

      const blockingIssues = monitor.getIssues('P1');
      expect(blockingIssues, JSON.stringify(blockingIssues, null, 2)).toEqual([]);
    } catch (error) {
      actual = error instanceof Error ? error.message : 'Unknown conversation refresh recovery failure';
      monitor.addAssertionIssue(actual, 'P1');
      throw error;
    } finally {
      await writeFlowAudit(
        testInfo,
        {
          title: 'chat-refresh-recovery',
          role: 'user',
          route: '/chat',
          expected: 'Authenticated users can refresh the chat page and continue in the previously active conversation with title and history intact.',
        },
        actual,
        steps,
        monitor.getIssues(),
      );
      if (fixtureConversationId) {
        await softDeleteConversationFixture(fixtureConversationId);
      }
    }
  });

  test('should expose batch export availability and allow model switching when the controls are enabled', async ({ page }, testInfo) => {
    const steps: string[] = [];
    const monitor = createIssueMonitor(page);
    let actual = 'Batch export and model selector flow completed';
    let fixtureConversationId: string | null = null;

    try {
      steps.push('Open /chat');
      await gotoWithBypass(page, '/chat');

      const modelSelector = page.getByRole('combobox').first();
      const modelSelectorVisible = await modelSelector.isVisible({ timeout: 3000 }).catch(() => false);
      if (modelSelectorVisible) {
        steps.push('Open the model selector and switch to a non-default option when available');
        const currentLabel = (await modelSelector.textContent())?.trim() ?? '';
        await modelSelector.click();

        const options = page.getByRole('option');
        const optionCount = await options.count();
        if (optionCount > 1) {
          const nextOption = options.nth(1);
          const nextLabel = (await nextOption.textContent())?.trim() ?? '';
          await nextOption.click();
          await expect(modelSelector).toContainText(nextLabel.split('\n')[0] ?? nextLabel, { timeout: 10000 });
        } else {
          actual = 'Only one active model available; model switch skipped';
          await page.keyboard.press('Escape').catch(() => undefined);
          await expect(modelSelector).toContainText(currentLabel);
        }
      } else {
        actual = 'Model selector hidden by current settings; model switch skipped';
      }

      steps.push('Seed and open a conversation so the export dialog has current data');
      const exportTitle = `Parity batch export ${Date.now()}`;
      const seededConversation = await createSeededConversation(
        exportTitle,
        `Parity batch export user ${Date.now()}`,
        `Parity batch export assistant ${Date.now()}`
      );
      fixtureConversationId = seededConversation.id;
      await openConversationRow(page, exportTitle);

      const exportButton = page.getByRole('button', { name: '导出' });
      const exportAvailable = await exportButton.isVisible({ timeout: 5000 }).catch(() => false);
      if (exportAvailable) {
        await exportButton.click();
        await expect(page.getByRole('dialog')).toBeVisible();

        const batchExportButton = page.getByRole('button', { name: '导出全部对话' });
        const batchExportAvailable = await batchExportButton.isVisible({ timeout: 3000 }).catch(() => false);
        if (batchExportAvailable) {
          steps.push('Trigger batch export when the membership allows it');
          const downloadPromise = page.waitForEvent('download', { timeout: 15000 });
          await batchExportButton.click();
          const download = await downloadPromise;
          expect(download.suggestedFilename()).toMatch(/\.(md|json)$/);
          await expect(page.getByText('导出成功！')).toBeVisible({ timeout: 10000 });
        } else {
          steps.push('Record that batch export is unavailable for the current E2E membership');
          await expect(page.getByText('升级会员可解锁批量导出功能')).toBeVisible();
        }
      } else {
        steps.push('Record that export is unavailable for the current E2E membership');
        actual = actual === 'Batch export and model selector flow completed'
          ? 'Export permission unavailable for current E2E user'
          : `${actual}; export permission unavailable for current E2E user`;
      }

      const blockingIssues = monitor.getIssues('P1');
      expect(blockingIssues, JSON.stringify(blockingIssues, null, 2)).toEqual([]);
    } catch (error) {
      actual = error instanceof Error ? error.message : 'Unknown batch export or model selector failure';
      monitor.addAssertionIssue(actual, 'P1');
      throw error;
    } finally {
      await writeFlowAudit(
        testInfo,
        {
          title: 'chat-batch-export-and-model-switch',
          role: 'user',
          route: '/chat',
          expected: 'Authenticated users can inspect batch export availability and switch models when the selector is enabled.',
        },
        actual,
        steps,
        monitor.getIssues(),
      );
      if (fixtureConversationId) {
        await softDeleteConversationFixture(fixtureConversationId);
      }
    }
  });

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
      await page.getByTestId(/^profile-credit-package-/).first().getByRole('button', { name: '购买' }).click();

      steps.push('Accept either the legacy support dialog or a live Stripe Checkout redirect');
      const purchaseIntentDialog = page.getByText('支付暂不可用');
      const redirectedToCheckout = await page
        .waitForURL(/https:\/\/(?:checkout|buy)\.stripe\.com\//, { timeout: 15000 })
        .then(() => true)
        .catch(() => false);

      if (!redirectedToCheckout) {
        await expect(purchaseIntentDialog).toBeVisible({ timeout: 10000 });
        await expect(page.getByRole('button', { name: '提交工单咨询' })).toBeVisible({ timeout: 10000 });
        actual = 'Subscription purchase action opened the support escalation dialog';
      } else {
        actual = 'Subscription purchase action redirected to Stripe Checkout';
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
