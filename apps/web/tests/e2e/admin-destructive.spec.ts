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

async function sendChatPrompt(page: import('@playwright/test').Page, prompt: string) {
  await gotoWithBypass(page, '/chat');
  await expect(page).toHaveURL(/\/chat/);
  await page.locator('textarea[placeholder="请输入您的问题..."]').fill(prompt);
  const streamResponsePromise = page.waitForResponse(
    (response) =>
      response.url().includes('/api/ai/stream') &&
      response.request().method() === 'POST',
    { timeout: 30000 },
  );
  await page.getByRole('button', { name: '发送' }).click();
  const streamResponse = await streamResponsePromise;
  expect(streamResponse.status()).toBe(200);
  await expect(page.getByRole('button', { name: '发送' })).toBeVisible({ timeout: 60000 });
}

async function readLatestPromptNameForUser(page: import('@playwright/test').Page, userEmail: string) {
  await gotoWithBypass(page, '/admin/costs');
  await expect(page).toHaveURL(/\/admin\/costs/);
  await page.getByRole('tab', { name: 'AI 调用日志' }).click();

  let promptName: string | null = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await page.getByTestId('admin-usage-logs-refresh').click();
    const row = page.locator('tbody tr').filter({ hasText: userEmail }).first();
    if (await row.isVisible({ timeout: 10000 }).catch(() => false)) {
      const value = (await row.getByTestId('admin-usage-log-prompt-name').textContent())?.trim() ?? '';
      if (value) {
        promptName = value === '-' ? null : value;
        break;
      }
    }
    await page.waitForTimeout(1500);
  }

  return promptName;
}

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

  test('should disable a model and verify it disappears from the user model selector before restoring it', async ({ browser, page }, testInfo) => {
    test.skip(
      !destructiveGateEnabled,
      'Destructive parity coverage is intentionally gated. Enable ENABLE_PARITY_DESTRUCTIVE_E2E=true only with isolated preview fixtures.',
    );
    test.setTimeout(60000);

    const steps: string[] = [];
    const monitor = createIssueMonitor(page);
    let actual = 'Admin model toggle flow completed';
    const userContext = await browser.newContext({ storageState: authStatePaths.user });
    const userPage = await userContext.newPage();
    const logPage = await page.context().newPage();
    const modelName = `Parity Toggle Model ${Date.now()}`;
    const modelId = `parity-toggle-${Date.now()}`;
    let shouldRestoreModelSelector = false;
    let targetModelId = '';

    try {
      steps.push('Open /admin/models and create an isolated temporary model');
      await gotoWithBypass(page, '/admin/models');
      await expect(page).toHaveURL(/\/admin\/models/);
      await page.getByTestId('admin-model-create-trigger').click();
      await page.getByTestId('admin-model-name-input').fill(modelName);
      await page.getByTestId('admin-model-id-input').fill(modelId);
      await page.getByTestId('admin-model-description-input').fill('Parity reversible model toggle fixture');

      const createResponsePromise = page.waitForResponse(
        (response) =>
          response.url().includes('/api/trpc/model.createModel') &&
          response.request().method() === 'POST',
        { timeout: 30000 },
      );
      await page.getByTestId('admin-model-save').click();
      const createResponse = await createResponsePromise;
      expect(createResponse.status()).toBe(200);

      const targetRow = page.locator('tbody tr').filter({ hasText: modelName }).first();
      await expect(targetRow).toBeVisible({ timeout: 15000 });
      const targetRowId = await targetRow.getAttribute('data-testid');
      targetModelId = targetRowId?.replace('admin-model-row-', '') ?? '';
      expect(targetModelId).not.toBe('');

      steps.push('Ensure the chat model selector is enabled for the user-facing verification');
      await gotoWithBypass(page, '/admin/settings');
      await expect(page).toHaveURL(/\/admin\/settings/);
      await page.getByRole('tab', { name: '功能设置' }).click();
      const modelSelectorSetting = page.getByTestId('admin-setting-chat_show_model_selector');
      await expect(modelSelectorSetting).toBeVisible({ timeout: 15000 });
      const initialSelectorState = await modelSelectorSetting.getAttribute('data-state');
      if (initialSelectorState !== 'checked') {
        shouldRestoreModelSelector = true;
        await modelSelectorSetting.click();
        await page.getByTestId('admin-settings-save-all').click();
        await expect(page.getByTestId('admin-settings-save-all')).toBeEnabled({ timeout: 30000 });
      }

      steps.push('Open /chat as the user and inspect the current model selector state');
      await gotoWithBypass(userPage, '/chat');
      await expect(userPage).toHaveURL(/\/chat/);
      const modelSelectorTrigger = userPage.getByTestId('chat-model-selector-trigger');
      await expect(modelSelectorTrigger).toBeVisible({ timeout: 15000 });
      await modelSelectorTrigger.click();
      const targetOption = userPage.getByTestId(`chat-model-option-${targetModelId}`);
      await expect(targetOption).toBeVisible({ timeout: 10000 });
      await userPage.keyboard.press('Escape');

      steps.push('Disable the temporary model from /admin/models');
      await gotoWithBypass(page, '/admin/models');
      await expect(page).toHaveURL(/\/admin\/models/);
      const disableResponsePromise = page.waitForResponse(
        (response) =>
          response.url().includes('/api/trpc/model.updateModel') &&
          response.request().method() === 'POST',
        { timeout: 30000 },
      );
      await page.getByTestId(`admin-model-active-toggle-${targetModelId}`).click();
      const disableResponse = await disableResponsePromise;
      expect(disableResponse.status()).toBe(200);
      await expect(page.getByTestId(`admin-model-active-toggle-${targetModelId}`)).toContainText('已禁用', { timeout: 15000 });

      steps.push('Reload /chat and verify the disabled model no longer appears in the selector');
      await userPage.reload({ waitUntil: 'networkidle' });
      await expect(modelSelectorTrigger).toBeVisible({ timeout: 15000 });
      await modelSelectorTrigger.click();
      await expect(targetOption).toHaveCount(0, { timeout: 10000 });
      await userPage.keyboard.press('Escape');

      steps.push('Re-enable the model and verify it returns to the user selector');
      const enableResponsePromise = page.waitForResponse(
        (response) =>
          response.url().includes('/api/trpc/model.updateModel') &&
          response.request().method() === 'POST',
        { timeout: 30000 },
      );
      await page.getByTestId(`admin-model-active-toggle-${targetModelId}`).click();
      const enableResponse = await enableResponsePromise;
      expect(enableResponse.status()).toBe(200);
      await expect(page.getByTestId(`admin-model-active-toggle-${targetModelId}`)).toContainText('已启用', { timeout: 15000 });

      await userPage.reload({ waitUntil: 'networkidle' });
      await expect(modelSelectorTrigger).toBeVisible({ timeout: 15000 });
      await modelSelectorTrigger.click();
      await expect(targetOption).toBeVisible({ timeout: 10000 });
      await userPage.keyboard.press('Escape');

      steps.push('Delete the temporary model and verify cleanup');
      await page.getByTestId(`admin-model-delete-${targetModelId}`).click();
      const deleteResponsePromise = page.waitForResponse(
        (response) =>
          response.url().includes('/api/trpc/model.deleteModel') &&
          response.request().method() === 'POST',
        { timeout: 30000 },
      );
      await page.getByTestId('admin-model-delete-confirm').click();
      const deleteResponse = await deleteResponsePromise;
      expect(deleteResponse.status()).toBe(200);
      await expect(targetRow).toHaveCount(0, { timeout: 15000 });

      const blockingIssues = monitor.getIssues('P1');
      expect(blockingIssues, JSON.stringify(blockingIssues, null, 2)).toEqual([]);
      actual = `Model ${modelName} toggled off/on with user selector verification`;
    } catch (error) {
      actual = error instanceof Error ? error.message : 'Unknown admin model toggle failure';
      monitor.addAssertionIssue(actual, 'P1');
      throw error;
    } finally {
      if (targetModelId) {
        await gotoWithBypass(page, '/admin/models').catch(() => undefined);
        const lingeringRow = page.getByTestId(`admin-model-row-${targetModelId}`);
        if (await lingeringRow.count()) {
          await page.getByTestId(`admin-model-delete-${targetModelId}`).click().catch(() => undefined);
          await page.getByTestId('admin-model-delete-confirm').click().catch(() => undefined);
        }
      }
      if (shouldRestoreModelSelector) {
        await gotoWithBypass(page, '/admin/settings').catch(() => undefined);
        await page.getByRole('tab', { name: '功能设置' }).click().catch(() => undefined);
        const modelSelectorSetting = page.getByTestId('admin-setting-chat_show_model_selector');
        if (await modelSelectorSetting.isVisible().catch(() => false)) {
          const currentState = await modelSelectorSetting.getAttribute('data-state');
          if (currentState === 'checked') {
            await modelSelectorSetting.click().catch(() => undefined);
            await page.getByTestId('admin-settings-save-all').click().catch(() => undefined);
          }
        }
      }
      await userContext.close();
      await writeFlowAudit(
        testInfo,
        {
          title: 'admin-model-toggle-user-selector',
          role: 'admin',
          route: '/admin/models,/chat',
          expected: 'Admin users can disable a model and confirm it disappears from the user model selector, then re-enable it and confirm it returns.',
        },
        actual,
        steps,
        monitor.getIssues(),
      );
    }
  });

  test('should publish a banner announcement, verify it appears for users, then unpublish and restore it before cleanup', async ({ browser, page }, testInfo) => {
    test.skip(
      !destructiveGateEnabled,
      'Destructive parity coverage is intentionally gated. Enable ENABLE_PARITY_DESTRUCTIVE_E2E=true only with isolated preview fixtures.',
    );
    test.setTimeout(60000);

    const steps: string[] = [];
    const monitor = createIssueMonitor(page);
    let actual = 'Admin announcement publish rollback flow completed';
    const userContext = await browser.newContext({ storageState: authStatePaths.user });
    const userPage = await userContext.newPage();
    const announcementTitle = `Parity Banner ${Date.now()}`;
    let announcementId = '';

    try {
      steps.push('Open /admin/announcements and create an isolated banner announcement');
      await gotoWithBypass(page, '/admin/announcements');
      await expect(page).toHaveURL(/\/admin\/announcements/);
      await page.getByRole('tab', { name: '横幅公告' }).click();
      await page.getByTestId('admin-announcement-create-banner').click();
      await page.getByTestId('announcement-title-input').fill(announcementTitle);
      await page.getByTestId('announcement-content-input').fill('Parity destructive banner visibility verification');
      await page.getByTestId('announcement-priority-input').fill('100');

      const createResponsePromise = page.waitForResponse(
        (response) =>
          response.url().includes('/api/trpc/admin.createAnnouncement') &&
          response.request().method() === 'POST',
        { timeout: 30000 },
      );
      await page.getByTestId('admin-announcement-save').click();
      const createResponse = await createResponsePromise;
      expect(createResponse.status()).toBe(200);

      const announcementRow = page.locator('tbody tr').filter({ hasText: announcementTitle }).first();
      await expect(announcementRow).toBeVisible({ timeout: 15000 });
      const rowTestId = await announcementRow.getAttribute('data-testid');
      announcementId = rowTestId?.replace('admin-announcement-row-', '') ?? '';
      expect(announcementId).not.toBe('');

      steps.push('Open /chat as the user and verify the new banner becomes visible');
      await gotoWithBypass(userPage, '/chat');
      await expect(userPage).toHaveURL(/\/chat/);
      await userPage.evaluate(() => {
        window.localStorage.removeItem('dismissedBanners');
      });
      await userPage.reload({ waitUntil: 'networkidle' });
      const userBanner = userPage.getByTestId(`global-banner-${announcementId}`);
      await expect(userBanner).toBeVisible({ timeout: 15000 });
      await expect(userBanner.getByTestId('global-banner-title')).toContainText(announcementTitle, { timeout: 15000 });

      steps.push('Disable the banner announcement and verify it disappears for users');
      const disableResponsePromise = page.waitForResponse(
        (response) =>
          response.url().includes('/api/trpc/admin.updateAnnouncement') &&
          response.request().method() === 'POST',
        { timeout: 30000 },
      );
      await page.getByTestId(`admin-announcement-toggle-${announcementId}`).click();
      const disableResponse = await disableResponsePromise;
      expect(disableResponse.status()).toBe(200);
      await expect(page.getByTestId(`admin-announcement-toggle-${announcementId}`)).toContainText('已禁用', { timeout: 15000 });

      await userPage.reload({ waitUntil: 'networkidle' });
      await expect(userPage.getByTestId(`global-banner-${announcementId}`)).toHaveCount(0, { timeout: 15000 });

      steps.push('Re-enable the banner announcement and verify it returns for users');
      const enableResponsePromise = page.waitForResponse(
        (response) =>
          response.url().includes('/api/trpc/admin.updateAnnouncement') &&
          response.request().method() === 'POST',
        { timeout: 30000 },
      );
      await page.getByTestId(`admin-announcement-toggle-${announcementId}`).click();
      const enableResponse = await enableResponsePromise;
      expect(enableResponse.status()).toBe(200);
      await expect(page.getByTestId(`admin-announcement-toggle-${announcementId}`)).toContainText('已启用', { timeout: 15000 });

      await userPage.reload({ waitUntil: 'networkidle' });
      await expect(userPage.getByTestId(`global-banner-${announcementId}`)).toBeVisible({ timeout: 15000 });

      steps.push('Delete the temporary announcement and verify cleanup');
      page.once('dialog', (dialog) => dialog.accept());
      const deleteResponsePromise = page.waitForResponse(
        (response) =>
          response.url().includes('/api/trpc/admin.deleteAnnouncement') &&
          response.request().method() === 'POST',
        { timeout: 30000 },
      );
      await page.getByTestId(`admin-announcement-delete-${announcementId}`).click();
      const deleteResponse = await deleteResponsePromise;
      expect(deleteResponse.status()).toBe(200);
      await expect(page.getByTestId(`admin-announcement-row-${announcementId}`)).toHaveCount(0, { timeout: 15000 });

      await userPage.reload({ waitUntil: 'networkidle' });
      await expect(userPage.getByTestId(`global-banner-${announcementId}`)).toHaveCount(0, { timeout: 15000 });

      const blockingIssues = monitor.getIssues('P1');
      expect(blockingIssues, JSON.stringify(blockingIssues, null, 2)).toEqual([]);
      actual = `Announcement ${announcementTitle} published, unpublished, restored, and cleaned up successfully`;
    } catch (error) {
      actual = error instanceof Error ? error.message : 'Unknown admin announcement publish rollback failure';
      monitor.addAssertionIssue(actual, 'P1');
      throw error;
    } finally {
      if (announcementId) {
        await gotoWithBypass(page, '/admin/announcements').catch(() => undefined);
        const lingeringRow = page.getByTestId(`admin-announcement-row-${announcementId}`);
        if (await lingeringRow.count()) {
          page.once('dialog', (dialog) => dialog.accept());
          await page.getByTestId(`admin-announcement-delete-${announcementId}`).click().catch(() => undefined);
        }
      }
      await userContext.close();
      await writeFlowAudit(
        testInfo,
        {
          title: 'admin-announcement-banner-publish-rollback',
          role: 'admin',
          route: '/admin/announcements,/chat',
          expected: 'Admin users can publish a banner announcement, verify it appears for users, unpublish it to hide it, then restore and clean it up safely in preview fixtures.',
        },
        actual,
        steps,
        monitor.getIssues(),
      );
    }
  });

  test('should publish a credit package, verify it appears in the user subscription view, then unpublish and restore it before cleanup', async ({ browser, page }, testInfo) => {
    test.skip(
      !destructiveGateEnabled,
      'Destructive parity coverage is intentionally gated. Enable ENABLE_PARITY_DESTRUCTIVE_E2E=true only with isolated preview fixtures.',
    );
    test.setTimeout(60000);

    const steps: string[] = [];
    const monitor = createIssueMonitor(page);
    let actual = 'Admin credit package publish rollback flow completed';
    const userContext = await browser.newContext({ storageState: authStatePaths.user });
    const userPage = await userContext.newPage();
    const packageName = `Parity Credit Pack ${Date.now()}`;
    let packageId = '';

    try {
      steps.push('Open /admin/packages and create an isolated active credit package');
      await gotoWithBypass(page, '/admin/packages');
      await expect(page).toHaveURL(/\/admin\/packages/);
      await page.getByTestId('admin-credit-package-create-trigger').click();
      await page.getByTestId('credit-package-name-input').fill(packageName);
      await page.getByTestId('credit-package-price-input').fill('12.9');
      await page.getByTestId('credit-package-credits-input').fill('4321');
      await page.getByTestId('credit-package-bonus-input').fill('321');

      const createResponsePromise = page.waitForResponse(
        (response) =>
          response.url().includes('/api/trpc/admin.createPackage') &&
          response.request().method() === 'POST',
        { timeout: 30000 },
      );
      await page.getByTestId('credit-package-save').click();
      const createResponse = await createResponsePromise;
      expect(createResponse.status()).toBe(200);

      const packageRow = page.locator('tbody tr').filter({ hasText: packageName }).first();
      await expect(packageRow).toBeVisible({ timeout: 15000 });
      const rowTestId = await packageRow.getAttribute('data-testid');
      packageId = rowTestId?.replace('admin-credit-package-row-', '') ?? '';
      expect(packageId).not.toBe('');

      steps.push('Open /profile?tab=subscription as the user and verify the credit package appears');
      await gotoWithBypass(userPage, '/profile?tab=subscription');
      await expect(userPage).toHaveURL(/\/profile\?tab=subscription/);
      const userPackage = userPage.getByTestId(`profile-credit-package-${packageId}`);
      await expect(userPackage).toBeVisible({ timeout: 15000 });
      await expect(userPackage.getByTestId('profile-credit-package-name')).toContainText(packageName, { timeout: 15000 });

      steps.push('Disable the credit package and verify it disappears from the user subscription view');
      const disableResponsePromise = page.waitForResponse(
        (response) =>
          response.url().includes('/api/trpc/admin.updatePackage') &&
          response.request().method() === 'POST',
        { timeout: 30000 },
      );
      await page.getByTestId(`admin-credit-package-toggle-${packageId}`).click();
      const disableResponse = await disableResponsePromise;
      expect(disableResponse.status()).toBe(200);
      await expect(page.getByTestId(`admin-credit-package-toggle-${packageId}`)).toContainText('已下架', { timeout: 15000 });

      await userPage.reload({ waitUntil: 'networkidle' });
      await expect(userPage.getByTestId(`profile-credit-package-${packageId}`)).toHaveCount(0, { timeout: 15000 });

      steps.push('Re-enable the credit package and verify it returns to the user subscription view');
      const enableResponsePromise = page.waitForResponse(
        (response) =>
          response.url().includes('/api/trpc/admin.updatePackage') &&
          response.request().method() === 'POST',
        { timeout: 30000 },
      );
      await page.getByTestId(`admin-credit-package-toggle-${packageId}`).click();
      const enableResponse = await enableResponsePromise;
      expect(enableResponse.status()).toBe(200);
      await expect(page.getByTestId(`admin-credit-package-toggle-${packageId}`)).toContainText('已上架', { timeout: 15000 });

      await userPage.reload({ waitUntil: 'networkidle' });
      await expect(userPage.getByTestId(`profile-credit-package-${packageId}`)).toBeVisible({ timeout: 15000 });

      steps.push('Delete the temporary credit package and verify cleanup');
      page.once('dialog', (dialog) => dialog.accept());
      const deleteResponsePromise = page.waitForResponse(
        (response) =>
          response.url().includes('/api/trpc/admin.deletePackage') &&
          response.request().method() === 'POST',
        { timeout: 30000 },
      );
      await page.getByTestId(`admin-credit-package-delete-${packageId}`).click();
      const deleteResponse = await deleteResponsePromise;
      expect(deleteResponse.status()).toBe(200);
      await expect(page.getByTestId(`admin-credit-package-row-${packageId}`)).toHaveCount(0, { timeout: 15000 });

      await userPage.reload({ waitUntil: 'networkidle' });
      await expect(userPage.getByTestId(`profile-credit-package-${packageId}`)).toHaveCount(0, { timeout: 15000 });

      const blockingIssues = monitor.getIssues('P1');
      expect(blockingIssues, JSON.stringify(blockingIssues, null, 2)).toEqual([]);
      actual = `Credit package ${packageName} published, unpublished, restored, and cleaned up successfully`;
    } catch (error) {
      actual = error instanceof Error ? error.message : 'Unknown admin credit package publish rollback failure';
      monitor.addAssertionIssue(actual, 'P1');
      throw error;
    } finally {
      if (packageId) {
        await gotoWithBypass(page, '/admin/packages').catch(() => undefined);
        const lingeringRow = page.getByTestId(`admin-credit-package-row-${packageId}`);
        if (await lingeringRow.count()) {
          page.once('dialog', (dialog) => dialog.accept());
          await page.getByTestId(`admin-credit-package-delete-${packageId}`).click().catch(() => undefined);
        }
      }
      await userContext.close();
      await writeFlowAudit(
        testInfo,
        {
          title: 'admin-credit-package-publish-rollback',
          role: 'admin',
          route: '/admin/packages,/profile?tab=subscription',
          expected: 'Admin users can publish a credit package, verify it appears in the user subscription view, unpublish it to hide it, then restore and clean it up safely in preview fixtures.',
        },
        actual,
        steps,
        monitor.getIssues(),
      );
    }
  });

  test('should disable a membership plan, verify it disappears from the user subscription view, then restore it', async ({ browser, page }, testInfo) => {
    test.skip(
      !destructiveGateEnabled,
      'Destructive parity coverage is intentionally gated. Enable ENABLE_PARITY_DESTRUCTIVE_E2E=true only with isolated preview fixtures.',
    );
    test.setTimeout(60000);

    const steps: string[] = [];
    const monitor = createIssueMonitor(page);
    let actual = 'Admin membership plan rollback flow completed';
    const userContext = await browser.newContext({ storageState: authStatePaths.user });
    const userPage = await userContext.newPage();
    let targetPlanId = '';
    let targetPlanLevel = '';
    let targetPlanName = '';

    try {
      steps.push('Open /admin/packages and locate an active non-free membership plan');
      await gotoWithBypass(page, '/admin/packages');
      await expect(page).toHaveURL(/\/admin\/packages/);
      await page.getByRole('tab', { name: '会员等级' }).click();

      const activePlanRow = page.locator('tbody tr').filter({ hasText: '已启用' }).filter({ hasNotText: '免费版' }).first();
      await expect(activePlanRow).toBeVisible({ timeout: 15000 });
      const rowTestId = await activePlanRow.getAttribute('data-testid');
      targetPlanId = rowTestId?.replace('admin-membership-plan-row-', '') ?? '';
      expect(targetPlanId).not.toBe('');
      targetPlanName = ((await activePlanRow.textContent()) ?? '').replace(/\s+/g, ' ');
      if (targetPlanName.includes('Gold')) {
        targetPlanLevel = 'gold';
      } else if (targetPlanName.includes('Pro')) {
        targetPlanLevel = 'pro';
      } else {
        targetPlanLevel = 'free';
      }
      expect(targetPlanLevel).not.toBe('free');

      steps.push('Open /profile?tab=subscription as the user and verify the target plan is visible');
      await gotoWithBypass(userPage, '/profile?tab=subscription');
      await expect(userPage).toHaveURL(/\/profile\?tab=subscription/);
      const userPlan = userPage.getByTestId(`profile-membership-plan-${targetPlanLevel}`);
      await expect(userPlan).toBeVisible({ timeout: 15000 });

      steps.push('Disable the membership plan and verify it disappears from the user subscription view');
      const disableResponsePromise = page.waitForResponse(
        (response) =>
          response.url().includes('/api/trpc/admin.updateMembershipPlan') &&
          response.request().method() === 'POST',
        { timeout: 30000 },
      );
      await page.getByTestId(`admin-membership-plan-toggle-${targetPlanId}`).click();
      const disableResponse = await disableResponsePromise;
      expect(disableResponse.status()).toBe(200);
      await expect(page.getByTestId(`admin-membership-plan-toggle-${targetPlanId}`)).toContainText('已禁用', { timeout: 15000 });

      await userPage.reload({ waitUntil: 'networkidle' });
      await expect(userPage.getByTestId(`profile-membership-plan-${targetPlanLevel}`)).toHaveCount(0, { timeout: 15000 });

      steps.push('Re-enable the membership plan and verify it returns to the user subscription view');
      const enableResponsePromise = page.waitForResponse(
        (response) =>
          response.url().includes('/api/trpc/admin.updateMembershipPlan') &&
          response.request().method() === 'POST',
        { timeout: 30000 },
      );
      await page.getByTestId(`admin-membership-plan-toggle-${targetPlanId}`).click();
      const enableResponse = await enableResponsePromise;
      expect(enableResponse.status()).toBe(200);
      await expect(page.getByTestId(`admin-membership-plan-toggle-${targetPlanId}`)).toContainText('已启用', { timeout: 15000 });

      await userPage.reload({ waitUntil: 'networkidle' });
      await expect(userPage.getByTestId(`profile-membership-plan-${targetPlanLevel}`)).toBeVisible({ timeout: 15000 });

      const blockingIssues = monitor.getIssues('P1');
      expect(blockingIssues, JSON.stringify(blockingIssues, null, 2)).toEqual([]);
      actual = `Membership plan ${targetPlanLevel} disabled and restored successfully`;
    } catch (error) {
      actual = error instanceof Error ? error.message : 'Unknown admin membership plan rollback failure';
      monitor.addAssertionIssue(actual, 'P1');
      throw error;
    } finally {
      if (targetPlanId) {
        await gotoWithBypass(page, '/admin/packages').catch(() => undefined);
        await page.getByRole('tab', { name: '会员等级' }).click().catch(() => undefined);
        const planToggle = page.getByTestId(`admin-membership-plan-toggle-${targetPlanId}`);
        if (await planToggle.isVisible().catch(() => false)) {
          const label = await planToggle.textContent();
          if (label?.includes('已禁用')) {
            const restoreResponsePromise = page.waitForResponse(
              (response) =>
                response.url().includes('/api/trpc/admin.updateMembershipPlan') &&
                response.request().method() === 'POST',
              { timeout: 30000 },
            ).catch(() => undefined);
            await planToggle.click().catch(() => undefined);
            await restoreResponsePromise;
          }
        }
      }
      await userContext.close();
      await writeFlowAudit(
        testInfo,
        {
          title: 'admin-membership-plan-rollback',
          role: 'admin',
          route: '/admin/packages,/profile?tab=subscription',
          expected: 'Admin users can disable a membership plan, verify it disappears from the user subscription view, then restore it safely in preview fixtures.',
        },
        actual,
        steps,
        monitor.getIssues(),
      );
    }
  });

  test('should create a system prompt, verify runtime prompt metadata follows disable and restore, then clean it up', async ({ browser, page }, testInfo) => {
    test.skip(
      !destructiveGateEnabled,
      'Destructive parity coverage is intentionally gated. Enable ENABLE_PARITY_DESTRUCTIVE_E2E=true only with isolated preview fixtures.',
    );
    test.setTimeout(90000);

    const steps: string[] = [];
    const monitor = createIssueMonitor(page);
    let actual = 'System prompt rollback flow completed';
    const userContext = await browser.newContext({ storageState: authStatePaths.user });
    const userPage = await userContext.newPage();
    const logPage = await page.context().newPage();
    const userEmail = process.env.E2E_TEST_EMAIL ?? '';
    const systemPromptName = `Parity System Prompt ${Date.now()}`;
    let targetPromptId = '';

    try {
      steps.push('Create an isolated high-priority system prompt in /admin/prompts');
      await gotoWithBypass(page, '/admin/prompts');
      await expect(page).toHaveURL(/\/admin\/prompts/);
      await page.getByRole('button', { name: '新建提示词' }).click();
      await page.getByTestId('prompt-name-input').fill(systemPromptName);
      await page.getByTestId('prompt-content-input').fill('你是一个用于 E2E 验收的系统提示词。');
      await page.getByTestId('prompt-sort-order-input').fill('1000');
      const systemSwitch = page.getByTestId('prompt-is-system-switch');
      const switchState = await systemSwitch.getAttribute('data-state');
      if (switchState !== 'checked') {
        await systemSwitch.click();
      }

      const createResponsePromise = page.waitForResponse(
        (response) =>
          response.url().includes('/api/trpc/admin.createPrompt') &&
          response.request().method() === 'POST',
        { timeout: 30000 },
      );
      await page.getByTestId('prompt-save').click();
      const createResponse = await createResponsePromise;
      expect(createResponse.status()).toBe(200);

      const promptRow = page.locator('tbody tr').filter({ hasText: systemPromptName }).first();
      await expect(promptRow).toBeVisible({ timeout: 15000 });
      const rowTestId = await promptRow.getAttribute('data-testid');
      targetPromptId = rowTestId?.replace('admin-prompt-row-', '') ?? '';
      expect(targetPromptId).not.toBe('');

      steps.push('Send a chat request and verify usage logs record the new system prompt name');
      await sendChatPrompt(userPage, `Parity runtime prompt baseline ${Date.now()}`);
      await expect
        .poll(async () => readLatestPromptNameForUser(logPage, userEmail), { timeout: 30000, intervals: [1500, 2000, 3000] })
        .toBe(systemPromptName);

      steps.push('Disable the temporary system prompt');
      const disableResponsePromise = page.waitForResponse(
        (response) =>
          response.url().includes('/api/trpc/admin.updatePrompt') &&
          response.request().method() === 'POST',
        { timeout: 30000 },
      );
      await page.getByTestId(`admin-prompt-toggle-${targetPromptId}`).click();
      const disableResponse = await disableResponsePromise;
      expect(disableResponse.status()).toBe(200);
      await expect(page.getByTestId(`admin-prompt-toggle-${targetPromptId}`)).toContainText('已禁用', { timeout: 15000 });

      steps.push('Send another chat request and verify the runtime prompt metadata changes away from the disabled prompt');
      await sendChatPrompt(userPage, `Parity runtime prompt disabled ${Date.now()}`);
      await expect
        .poll(async () => readLatestPromptNameForUser(logPage, userEmail), { timeout: 30000, intervals: [1500, 2000, 3000] })
        .not.toBe(systemPromptName);

      steps.push('Re-enable the temporary system prompt and verify the runtime prompt metadata returns');
      const enableResponsePromise = page.waitForResponse(
        (response) =>
          response.url().includes('/api/trpc/admin.updatePrompt') &&
          response.request().method() === 'POST',
        { timeout: 30000 },
      );
      await page.getByTestId(`admin-prompt-toggle-${targetPromptId}`).click();
      const enableResponse = await enableResponsePromise;
      expect(enableResponse.status()).toBe(200);
      await expect(page.getByTestId(`admin-prompt-toggle-${targetPromptId}`)).toContainText('已启用', { timeout: 15000 });

      await sendChatPrompt(userPage, `Parity runtime prompt restored ${Date.now()}`);
      await expect
        .poll(async () => readLatestPromptNameForUser(logPage, userEmail), { timeout: 30000, intervals: [1500, 2000, 3000] })
        .toBe(systemPromptName);

      const blockingIssues = monitor.getIssues('P1');
      expect(blockingIssues, JSON.stringify(blockingIssues, null, 2)).toEqual([]);
      actual = `System prompt ${systemPromptName} created, disabled, restored, and verified successfully`;
    } catch (error) {
      actual = error instanceof Error ? error.message : 'Unknown system prompt rollback failure';
      monitor.addAssertionIssue(actual, 'P1');
      throw error;
    } finally {
      if (targetPromptId) {
        await gotoWithBypass(page, '/admin/prompts').catch(() => undefined);
        const promptToggle = page.getByTestId(`admin-prompt-toggle-${targetPromptId}`);
        if (await promptToggle.isVisible().catch(() => false)) {
          const label = await promptToggle.textContent();
          if (label?.includes('已禁用')) {
            const restoreResponsePromise = page.waitForResponse(
              (response) =>
                response.url().includes('/api/trpc/admin.updatePrompt') &&
                response.request().method() === 'POST',
              { timeout: 30000 },
            ).catch(() => undefined);
            await promptToggle.click().catch(() => undefined);
            await restoreResponsePromise;
          }
          const editButton = page.getByTestId(`admin-prompt-edit-${targetPromptId}`);
          if (await editButton.isVisible().catch(() => false)) {
            await editButton.click().catch(() => undefined);
            const promptIsSystemSwitch = page.getByTestId('prompt-is-system-switch');
            const currentState = await promptIsSystemSwitch.getAttribute('data-state').catch(() => null);
            if (currentState === 'checked') {
              await promptIsSystemSwitch.click().catch(() => undefined);
            }
            const demoteResponsePromise = page.waitForResponse(
              (response) =>
                response.url().includes('/api/trpc/admin.updatePrompt') &&
                response.request().method() === 'POST',
              { timeout: 30000 },
            ).catch(() => undefined);
            await page.getByTestId('prompt-save').click().catch(() => undefined);
            await demoteResponsePromise;
          }
          const deleteButton = page.getByTestId(`admin-prompt-delete-${targetPromptId}`);
          if (await deleteButton.isVisible().catch(() => false)) {
            page.once('dialog', (dialog) => dialog.accept());
            const deleteResponsePromise = page.waitForResponse(
              (response) =>
                response.url().includes('/api/trpc/admin.deletePrompt') &&
                response.request().method() === 'POST',
              { timeout: 30000 },
            ).catch(() => undefined);
            await deleteButton.click().catch(() => undefined);
            await deleteResponsePromise;
          }
        }
      }
      await logPage.close();
      await userContext.close();
      await writeFlowAudit(
        testInfo,
        {
          title: 'admin-system-prompt-runtime-rollback',
          role: 'admin',
          route: '/admin/prompts,/admin/costs,/chat',
          expected: 'Admin users can create a temporary system prompt, verify runtime usage metadata selects it, disable it to force a different runtime prompt, then restore and clean it up safely.',
        },
        actual,
        steps,
        monitor.getIssues(),
      );
    }
  });
});
