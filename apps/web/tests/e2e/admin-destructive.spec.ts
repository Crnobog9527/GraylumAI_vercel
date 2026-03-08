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
});
