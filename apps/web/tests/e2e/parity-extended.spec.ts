/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import { authStatePaths, getCredentials, hasCredentials } from './support/auth';
import { gotoWithBypass } from './support/deploymentProtection';
import { createIssueMonitor, writeFlowAudit } from './support/monitoring';

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

async function createConversation(page: Page, prompt: string) {
  await gotoWithBypass(page, '/chat');

  const input = page.locator('textarea[placeholder="请输入您的问题..."]');
  await input.fill(prompt);

  const streamResponsePromise = page.waitForResponse(
    (response) =>
      response.url().includes('/api/ai/stream') &&
      response.request().method() === 'POST',
    { timeout: 20000 },
  );

  await page.getByRole('button', { name: '发送' }).click();
  const dismissedLowBalance = await dismissLowBalanceDialogIfVisible(page);
  if (dismissedLowBalance) {
    await page.getByRole('button', { name: '发送' }).click();
  }

  const streamResponse = await streamResponsePromise;
  expect(streamResponse.status()).toBe(200);
  await expectUserMessageVisible(page, prompt);
  await expect(page.getByRole('button', { name: '发送' })).toBeVisible({ timeout: 60000 });
  await expect(page.getByRole('button', { name: '编辑标题' })).toBeEnabled({ timeout: 15000 });
}

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
    await page.locator('input[placeholder="奖励积分、退款等..."]').fill(`Parity extended top-up ${Date.now()}`);

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
    await expect
      .poll(async () => readCreditsFromRow(targetRow), { timeout: 15000 })
      .toBeGreaterThanOrEqual(minimumCredits);
  } finally {
    await context.close();
  }
}

test.describe('Parity Extended', () => {
  test.describe.configure({ mode: 'serial' });

  test.describe('User Flows', () => {
    test.use({ storageState: authStatePaths.user });
    test.skip(!hasCredentials('user'), 'E2E_TEST_EMAIL and E2E_TEST_PASSWORD are required for extended user flows');

    test.beforeAll(async ({ browser }) => {
      await ensureUserCreditsAtLeast(browser, 150);
    });

    test('should rename a conversation from the chat header', async ({ page }, testInfo) => {
      const steps: string[] = [];
      const monitor = createIssueMonitor(page);
      const prompt = `Parity rename seed ${Date.now()}`;
      const renamedTitle = `Parity renamed ${Date.now()}`;
      let actual = 'Conversation rename flow completed';

      try {
        steps.push('Create a fresh conversation from /chat');
        await createConversation(page, prompt);

        steps.push('Open the title editor from the chat header');
        await expect(page.getByRole('button', { name: '编辑标题' })).toBeEnabled({ timeout: 10000 });
        await page.getByRole('button', { name: '编辑标题' }).click();

        steps.push('Save a new conversation title');
        await page.locator('input[type="text"]').fill(renamedTitle);
        const renameResponsePromise = page.waitForResponse(
          (response) =>
            response.url().includes('/api/trpc/chat.updateConversationTitle') &&
            response.request().method() === 'POST',
          { timeout: 15000 },
        );
        await page.getByRole('button', { name: '保存' }).click();
        const renameResponse = await renameResponsePromise;
        expect(renameResponse.status()).toBe(200);

        steps.push('Verify the new title is visible in the header and sidebar');
        await expect(page.getByRole('heading', { name: renamedTitle })).toBeVisible({ timeout: 10000 });
        await expect(page.getByText(renamedTitle).first()).toBeVisible({ timeout: 10000 });

        const blockingIssues = monitor.getIssues('P1');
        expect(blockingIssues, JSON.stringify(blockingIssues, null, 2)).toEqual([]);
      } catch (error) {
        actual = error instanceof Error ? error.message : 'Unknown conversation rename failure';
        monitor.addAssertionIssue(actual, 'P1');
        throw error;
      } finally {
        await writeFlowAudit(
          testInfo,
          {
            title: 'chat-rename-conversation',
            role: 'user',
            route: '/chat',
            expected: 'Authenticated users can rename an existing conversation from the chat header without blocking issues.',
          },
          actual,
          steps,
          monitor.getIssues(),
        );
      }
    });

    test('should open export flow and download the current conversation when permitted', async ({ page }, testInfo) => {
      const steps: string[] = [];
      const monitor = createIssueMonitor(page);
      const prompt = `Parity export seed ${Date.now()}`;
      let actual = 'Export flow completed';

      try {
        steps.push('Create a fresh conversation from /chat');
        await createConversation(page, prompt);

        const exportButton = page.getByRole('button', { name: '导出' });
        const exportAvailable = await exportButton.isVisible({ timeout: 5000 }).catch(() => false);

        if (!exportAvailable) {
          steps.push('Record that export is not available for the current E2E membership');
          actual = 'Export permission unavailable for current E2E user';
        } else {
          steps.push('Open the export dialog');
          await exportButton.click();
          await expect(page.getByRole('dialog')).toBeVisible();
          await expect(page.getByText('导出对话')).toBeVisible();

          steps.push('Download the current conversation as Markdown');
          const downloadPromise = page.waitForEvent('download', { timeout: 15000 });
          await page.getByRole('button', { name: '导出当前对话' }).click();
          const download = await downloadPromise;
          expect(download.suggestedFilename()).toMatch(/\.md$/);
          await expect(page.getByText('导出成功！')).toBeVisible({ timeout: 10000 });
        }

        const blockingIssues = monitor.getIssues('P1');
        expect(blockingIssues, JSON.stringify(blockingIssues, null, 2)).toEqual([]);
      } catch (error) {
        actual = error instanceof Error ? error.message : 'Unknown export flow failure';
        monitor.addAssertionIssue(actual, 'P1');
        throw error;
      } finally {
        await writeFlowAudit(
          testInfo,
          {
            title: 'chat-export-conversation',
            role: 'user',
            route: '/chat',
            expected: 'Authenticated users can see export availability and download the current conversation when membership permissions allow it.',
          },
          actual,
          steps,
          monitor.getIssues(),
        );
      }
    });
  });

  test.describe('Admin Flows', () => {
    test.use({ storageState: authStatePaths.admin });
    test.skip(!hasCredentials('admin'), 'E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD are required for extended admin flows');

    test('should invoke model connection testing from the admin models table', async ({ page }, testInfo) => {
      const steps: string[] = [];
      const monitor = createIssueMonitor(page);
      let actual = 'Model connection test request completed';

      try {
        steps.push('Open /admin/models');
        await gotoWithBypass(page, '/admin/models');
        await expect(page).toHaveURL(/\/admin\/models/);

        const firstDataRow = page.locator('tbody tr').first();
        await expect(firstDataRow).toBeVisible({ timeout: 10000 });

        steps.push('Trigger test connection for the first listed model');
        const testConnectionResponsePromise = page.waitForResponse(
          (response) =>
            response.url().includes('/api/trpc/model.testConnection') &&
            response.request().method() === 'POST',
          { timeout: 20000 },
        );
        await firstDataRow.getByRole('button', { name: '测试 API 连接' }).click();
        const testConnectionResponse = await testConnectionResponsePromise;
        expect(testConnectionResponse.status()).toBe(200);

        steps.push('Wait for the row action to return to idle');
        await expect(firstDataRow.getByRole('button', { name: '测试 API 连接' })).toBeEnabled({ timeout: 15000 });

        const blockingIssues = monitor.getIssues('P1');
        expect(blockingIssues, JSON.stringify(blockingIssues, null, 2)).toEqual([]);
      } catch (error) {
        actual = error instanceof Error ? error.message : 'Unknown model connection test failure';
        monitor.addAssertionIssue(actual, 'P1');
        throw error;
      } finally {
        await writeFlowAudit(
          testInfo,
          {
            title: 'admin-test-model-connection',
            role: 'admin',
            route: '/admin/models',
            expected: 'Admin users can trigger a model connection test from the models table and receive a completed backend response without blocking issues.',
          },
          actual,
          steps,
          monitor.getIssues(),
        );
      }
    });

    test('should adjust user credits and restore the original balance', async ({ page }, testInfo) => {
      const steps: string[] = [];
      const monitor = createIssueMonitor(page);
      const targetEmail = getCredentials('user').email;
      let actual = 'Credit adjustment flow completed';

      try {
        steps.push('Open /admin/users');
        await gotoWithBypass(page, '/admin/users');
        await expect(page).toHaveURL(/\/admin\/users/);

        steps.push('Filter the users table to the configured E2E user');
        await page.locator('input[placeholder="邮箱或昵称..."]').fill(targetEmail);
        const getTargetRow = () => page.locator('tbody tr').filter({ hasText: targetEmail }).first();
        await expect(getTargetRow()).toBeVisible({ timeout: 15000 });

        const originalCredits = await readCreditsFromRow(getTargetRow());

        steps.push('Open the credit adjustment dialog and add 100 credits');
        await getTargetRow().getByRole('button', { name: '积分' }).click();
        await expect(page.getByRole('dialog')).toBeVisible();
        await page.getByRole('button', { name: '增加积分' }).click();
        await page.locator('input[placeholder="奖励积分、退款等..."]').fill(`Parity add ${Date.now()}`);
        const addResponsePromise = page.waitForResponse(
          (response) =>
            response.url().includes('/api/trpc/admin.adjustUserCredits') &&
            response.request().method() === 'POST',
          { timeout: 20000 },
        );
        await page.getByRole('button', { name: '确认调整' }).click();
        const addResponse = await addResponsePromise;
        expect(addResponse.status()).toBe(200);
        await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 15000 });

        steps.push('Verify the table reflects the incremented credit balance');
        await expect
          .poll(async () => readCreditsFromRow(getTargetRow()), { timeout: 15000 })
          .toBe(originalCredits + 100);

        steps.push('Reopen the dialog and subtract 100 credits to restore the original balance');
        await getTargetRow().getByRole('button', { name: '积分' }).click();
        await expect(page.getByRole('dialog')).toBeVisible();
        await page.getByRole('button', { name: '减少积分' }).click();
        await page.locator('input[placeholder="奖励积分、退款等..."]').fill(`Parity rollback ${Date.now()}`);
        const rollbackResponsePromise = page.waitForResponse(
          (response) =>
            response.url().includes('/api/trpc/admin.adjustUserCredits') &&
            response.request().method() === 'POST',
          { timeout: 20000 },
        );
        await page.getByRole('button', { name: '确认调整' }).click();
        const rollbackResponse = await rollbackResponsePromise;
        expect(rollbackResponse.status()).toBe(200);
        await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 15000 });

        steps.push('Verify the credit balance returns close to the original value after rollback');
        await expect
          .poll(async () => Math.abs((await readCreditsFromRow(getTargetRow())) - originalCredits), { timeout: 15000 })
          .toBeLessThanOrEqual(1);

        const blockingIssues = monitor.getIssues('P1');
        expect(blockingIssues, JSON.stringify(blockingIssues, null, 2)).toEqual([]);
      } catch (error) {
        actual = error instanceof Error ? error.message : 'Unknown credit adjustment failure';
        monitor.addAssertionIssue(actual, 'P1');
        throw error;
      } finally {
        await writeFlowAudit(
          testInfo,
          {
            title: 'admin-adjust-user-credits',
            role: 'admin',
            route: '/admin/users',
            expected: 'Admin users can adjust a user credit balance from the table and restore the original balance without blocking issues.',
          },
          actual,
          steps,
          monitor.getIssues(),
        );
      }
    });
  });
});
