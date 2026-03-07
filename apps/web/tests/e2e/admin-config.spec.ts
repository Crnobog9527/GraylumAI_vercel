/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { expect, test, type Locator, type Page } from '@playwright/test';
import { authStatePaths, hasCredentials } from './support/auth';
import { gotoWithBypass } from './support/deploymentProtection';
import { createIssueMonitor, writeFlowAudit } from './support/monitoring';

async function acceptNextDialog(page: Page) {
  return page.waitForEvent('dialog', { timeout: 15000 }).then((dialog) => dialog.accept());
}

async function openSelectAndChoose(trigger: Locator, optionText: string) {
  await trigger.click();
  await trigger.page().getByRole('option', { name: new RegExp(optionText, 'i') }).click();
}

test.describe('Admin Config Flows', () => {
  test.describe.configure({ mode: 'serial' });
  test.use({ storageState: authStatePaths.admin });
  test.skip(!hasCredentials('admin'), 'E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD are required for admin config flows');

  test('should persist and restore global settings and membership export settings', async ({ page }, testInfo) => {
    const steps: string[] = [];
    const monitor = createIssueMonitor(page);
    const siteNameInput = page.getByTestId('admin-setting-site_name');
    const saveAllButton = page.getByTestId('admin-settings-save-all');
    let actual = 'Global settings flow completed';

    try {
      steps.push('Open /admin/settings');
      await gotoWithBypass(page, '/admin/settings');
      await expect(page).toHaveURL(/\/admin\/settings/);

      const originalSiteName = (await siteNameInput.inputValue()).trim();
      const updatedSiteName = `Parity Config ${Date.now()}`;

      steps.push('Update the site name and save all settings');
      await siteNameInput.fill(updatedSiteName);
      await saveAllButton.click();
      await expect(saveAllButton).toBeEnabled({ timeout: 60000 });

      steps.push('Reload and verify the new site name persisted');
      await page.reload();
      await expect(siteNameInput).toHaveValue(updatedSiteName, { timeout: 15000 });

      const membershipPlan = page.getByTestId(/^membership-plan-/).first();
      const membershipPlanCount = await membershipPlan.count();
      if (membershipPlanCount > 0) {
        const planId = (await membershipPlan.getAttribute('data-testid'))?.replace('membership-plan-', '') ?? '';
        const historyInput = page.getByTestId(`membership-plan-history-${planId}`);
        const exportSwitch = page.getByTestId(`membership-plan-allow-export-${planId}`);
        const planSaveButton = page.getByTestId(`membership-plan-save-${planId}`);

        const originalHistoryValue = await historyInput.inputValue();
        const updatedHistoryValue = String(Number(originalHistoryValue || '30') + 1);
        const originalExportChecked = await exportSwitch.getAttribute('data-state');

        steps.push('Update membership retention and export permission, then verify persistence');
        await historyInput.fill(updatedHistoryValue);
        await exportSwitch.click();
        await planSaveButton.click();
        await expect(planSaveButton).toBeEnabled({ timeout: 30000 });
        await page.reload();
        await expect(historyInput).toHaveValue(updatedHistoryValue, { timeout: 15000 });

        steps.push('Restore the original membership retention and export permission values');
        await historyInput.fill(originalHistoryValue);
        const currentExportChecked = await exportSwitch.getAttribute('data-state');
        if (currentExportChecked !== originalExportChecked) {
          await exportSwitch.click();
        }
        await planSaveButton.click();
        await expect(planSaveButton).toBeEnabled({ timeout: 30000 });
      } else {
        steps.push('Record that no membership plans exist in the current preview environment');
        actual = 'Global settings verified; membership plan settings unavailable in current preview data';
      }

      steps.push('Restore the original site name');
      await siteNameInput.fill(originalSiteName);
      await saveAllButton.click();
      await expect(saveAllButton).toBeEnabled({ timeout: 60000 });

      const blockingIssues = monitor.getIssues('P1');
      expect(blockingIssues, JSON.stringify(blockingIssues, null, 2)).toEqual([]);
    } catch (error) {
      actual = error instanceof Error ? error.message : 'Unknown settings persistence failure';
      monitor.addAssertionIssue(actual, 'P1');
      throw error;
    } finally {
      await writeFlowAudit(
        testInfo,
        {
          title: 'admin-settings-persistence',
          role: 'admin',
          route: '/admin/settings',
          expected: 'Admin users can persist and restore global settings, and membership export settings remain editable when plans exist.',
        },
        actual,
        steps,
        monitor.getIssues(),
      );
    }
  });

  test('should create, edit, toggle, and delete announcements while restoring chat page settings', async ({ page }, testInfo) => {
    const steps: string[] = [];
    const monitor = createIssueMonitor(page);
    const title = `Parity Announcement ${Date.now()}`;
    const editedTitle = `${title} Edited`;
    const chatPromptInput = page.getByTestId('announcement-chat-prompt-input');
    const saveChatSettingsButton = page.getByTestId('announcement-save-chat-settings');
    let actual = 'Announcement management flow completed';

    try {
      steps.push('Open /admin/announcements');
      await gotoWithBypass(page, '/admin/announcements');
      await expect(page).toHaveURL(/\/admin\/announcements/);
      await page.getByRole('tab', { name: '页面设置' }).click();
      await expect(chatPromptInput).toBeVisible({ timeout: 10000 });

      const originalChatPrompt = await chatPromptInput.inputValue();
      const updatedChatPrompt = `Parity welcome prompt ${Date.now()}`;

      steps.push('Update chat page settings and verify they persist');
      await chatPromptInput.fill(updatedChatPrompt);
      const chatSettingsDialogPromise = acceptNextDialog(page);
      await saveChatSettingsButton.click();
      await chatSettingsDialogPromise;
      await page.reload();
      await page.getByRole('tab', { name: '页面设置' }).click();
      await expect(chatPromptInput).toBeVisible({ timeout: 10000 });
      await expect(chatPromptInput).toHaveValue(updatedChatPrompt, { timeout: 15000 });

      steps.push('Create a new banner announcement');
      await page.getByRole('tab', { name: '横幅公告' }).click();
      await page.getByRole('button', { name: '添加' }).first().click();
      await page.getByTestId('announcement-title-input').fill(title);
      await page.getByTestId('announcement-content-input').fill(`Parity announcement body ${Date.now()}`);
      await page.getByRole('button', { name: '保存' }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 15000 });
      await expect(page.locator('tr').filter({ hasText: title }).first()).toBeVisible({ timeout: 15000 });

      const announcementRow = page.locator('tr').filter({ hasText: title }).first();

      steps.push('Edit the announcement title');
      await announcementRow.getByRole('button').first().click();
      await page.getByTestId('announcement-title-input').fill(editedTitle);
      await page.getByRole('button', { name: '保存' }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 15000 });
      await expect(page.locator('tr').filter({ hasText: editedTitle }).first()).toBeVisible({ timeout: 15000 });

      const editedRow = page.locator('tr').filter({ hasText: editedTitle }).first();

      steps.push('Toggle the announcement active status');
      const statusBadge = editedRow.getByText(/已启用|已禁用/).first();
      const originalStatus = (await statusBadge.textContent())?.trim() ?? '';
      await statusBadge.click();
      await expect.poll(async () => ((await editedRow.getByText(/已启用|已禁用/).first().textContent()) ?? '').trim(), {
        timeout: 15000,
      }).not.toBe(originalStatus);

      steps.push('Delete the temporary announcement');
      const deleteDialogPromise = acceptNextDialog(page);
      await editedRow.getByRole('button').nth(1).click();
      await deleteDialogPromise;
      await expect(editedRow).toHaveCount(0, { timeout: 15000 });

      steps.push('Restore the original chat page setting');
      await page.getByRole('tab', { name: '页面设置' }).click();
      await expect(chatPromptInput).toBeVisible({ timeout: 10000 });
      await chatPromptInput.fill(originalChatPrompt);
      const restoreDialogPromise = acceptNextDialog(page);
      await saveChatSettingsButton.click();
      await restoreDialogPromise;

      const blockingIssues = monitor.getIssues('P1');
      expect(blockingIssues, JSON.stringify(blockingIssues, null, 2)).toEqual([]);
    } catch (error) {
      actual = error instanceof Error ? error.message : 'Unknown announcement flow failure';
      monitor.addAssertionIssue(actual, 'P1');
      throw error;
    } finally {
      await writeFlowAudit(
        testInfo,
        {
          title: 'admin-announcements-crud',
          role: 'admin',
          route: '/admin/announcements',
          expected: 'Admin users can save chat page settings, create/edit/toggle/delete announcements, and restore settings without blocking issues.',
        },
        actual,
        steps,
        monitor.getIssues(),
      );
    }
  });

  test('should create, edit, and delete credit packages and membership plans', async ({ page }, testInfo) => {
    const steps: string[] = [];
    const monitor = createIssueMonitor(page);
    const packageName = `Parity Package ${Date.now()}`;
    const editedPackageName = `${packageName} Edited`;
    const planName = `Parity Plan ${Date.now()}`;
    const editedPlanName = `${planName} Edited`;
    let actual = 'Package and membership flow completed';

    try {
      steps.push('Open /admin/packages');
      await gotoWithBypass(page, '/admin/packages');
      await expect(page).toHaveURL(/\/admin\/packages/);

      steps.push('Create a new credit package');
      await page.getByRole('button', { name: '创建积分包' }).click();
      await page.getByTestId('credit-package-name-input').fill(packageName);
      await page.getByTestId('credit-package-price-input').fill('9.9');
      await page.getByTestId('credit-package-credits-input').fill('990');
      await page.getByTestId('credit-package-bonus-input').fill('99');
      await page.getByTestId('credit-package-save').click();
      await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 15000 });
      await expect(page.locator('tr').filter({ hasText: packageName }).first()).toBeVisible({ timeout: 15000 });

      steps.push('Edit and then delete the temporary credit package');
      const packageRow = page.locator('tr').filter({ hasText: packageName }).first();
      await packageRow.getByRole('button').first().click();
      await page.getByTestId('credit-package-name-input').fill(editedPackageName);
      await page.getByTestId('credit-package-bonus-input').fill('123');
      await page.getByTestId('credit-package-save').click();
      await expect(page.locator('tr').filter({ hasText: editedPackageName }).first()).toBeVisible({ timeout: 15000 });

      const deletePackageDialogPromise = acceptNextDialog(page);
      await page.locator('tr').filter({ hasText: editedPackageName }).first().getByRole('button').nth(1).click();
      await deletePackageDialogPromise;
      await expect(page.locator('tr').filter({ hasText: editedPackageName }).first()).toHaveCount(0, { timeout: 15000 });

      steps.push('Switch to membership plans and create a new plan');
      await page.getByRole('tab', { name: '会员等级' }).click();
      await page.getByRole('button', { name: '创建会员等级' }).click();
      await page.getByTestId('membership-plan-name-input').fill(planName);
      await openSelectAndChoose(page.getByRole('combobox').nth(0), 'Gold');
      await page.getByTestId('membership-plan-monthly-price-input').fill('29.9');
      await page.getByTestId('membership-plan-yearly-price-input').fill('299');
      await page.getByTestId('membership-plan-monthly-credits-input').fill('2900');
      await page.getByTestId('membership-plan-yearly-credits-input').fill('29900');
      await page.getByTestId('membership-plan-save').click();
      await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 15000 });
      await expect(page.locator('tr').filter({ hasText: planName }).first()).toBeVisible({ timeout: 15000 });

      steps.push('Edit and then delete the temporary membership plan');
      const planRow = page.locator('tr').filter({ hasText: planName }).first();
      await planRow.getByRole('button').first().click();
      await page.getByTestId('membership-plan-name-input').fill(editedPlanName);
      await page.getByTestId('membership-plan-monthly-price-input').fill('39.9');
      await page.getByTestId('membership-plan-save').click();
      await expect(page.locator('tr').filter({ hasText: editedPlanName }).first()).toBeVisible({ timeout: 15000 });

      const deletePlanDialogPromise = acceptNextDialog(page);
      await page.locator('tr').filter({ hasText: editedPlanName }).first().getByRole('button').nth(1).click();
      await deletePlanDialogPromise;
      await expect(page.locator('tr').filter({ hasText: editedPlanName }).first()).toHaveCount(0, { timeout: 15000 });

      const blockingIssues = monitor.getIssues('P1');
      expect(blockingIssues, JSON.stringify(blockingIssues, null, 2)).toEqual([]);
    } catch (error) {
      actual = error instanceof Error ? error.message : 'Unknown package or membership flow failure';
      monitor.addAssertionIssue(actual, 'P1');
      throw error;
    } finally {
      await writeFlowAudit(
        testInfo,
        {
          title: 'admin-packages-membership-crud',
          role: 'admin',
          route: '/admin/packages',
          expected: 'Admin users can create, edit, and delete temporary credit packages and membership plans without blocking issues.',
        },
        actual,
        steps,
        monitor.getIssues(),
      );
    }
  });

  test('should create, edit, toggle, and delete a prompt module', async ({ page }, testInfo) => {
    const steps: string[] = [];
    const monitor = createIssueMonitor(page);
    const promptName = `Parity Prompt ${Date.now()}`;
    const editedPromptName = `${promptName} Edited`;
    let actual = 'Prompt module flow completed';

    try {
      steps.push('Open /admin/prompts');
      await gotoWithBypass(page, '/admin/prompts');
      await expect(page).toHaveURL(/\/admin\/prompts/);

      steps.push('Create a temporary prompt module');
      await page.getByRole('button', { name: '新建提示词' }).click();
      await page.getByTestId('prompt-name-input').fill(promptName);
      await page.getByTestId('prompt-description-input').fill(`Parity prompt description ${Date.now()}`);
      await page.getByTestId('prompt-content-input').fill(`You are a parity audit helper ${Date.now()}.`);
      await page.getByTestId('prompt-save').click();
      await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 15000 });
      await expect(page.locator('tr').filter({ hasText: promptName }).first()).toBeVisible({ timeout: 15000 });

      steps.push('Edit the prompt module');
      const promptRow = page.locator('tr').filter({ hasText: promptName }).first();
      await promptRow.getByRole('button').first().click();
      await page.getByTestId('prompt-name-input').fill(editedPromptName);
      await page.getByTestId('prompt-description-input').fill(`Parity prompt edited ${Date.now()}`);
      await page.getByTestId('prompt-save').click();
      await expect(page.locator('tr').filter({ hasText: editedPromptName }).first()).toBeVisible({ timeout: 15000 });

      const editedRow = page.locator('tr').filter({ hasText: editedPromptName }).first();

      steps.push('Toggle the prompt active status');
      const statusBadge = editedRow.getByText(/已启用|已禁用/).first();
      const originalStatus = (await statusBadge.textContent())?.trim() ?? '';
      await statusBadge.click();
      await expect.poll(async () => ((await editedRow.getByText(/已启用|已禁用/).first().textContent()) ?? '').trim(), {
        timeout: 15000,
      }).not.toBe(originalStatus);

      steps.push('Delete the temporary prompt module');
      const deletePromptDialogPromise = acceptNextDialog(page);
      await editedRow.getByRole('button').nth(1).click();
      await deletePromptDialogPromise;
      await expect(editedRow).toHaveCount(0, { timeout: 15000 });

      const blockingIssues = monitor.getIssues('P1');
      expect(blockingIssues, JSON.stringify(blockingIssues, null, 2)).toEqual([]);
    } catch (error) {
      actual = error instanceof Error ? error.message : 'Unknown prompt module failure';
      monitor.addAssertionIssue(actual, 'P1');
      throw error;
    } finally {
      await writeFlowAudit(
        testInfo,
        {
          title: 'admin-prompts-crud',
          role: 'admin',
          route: '/admin/prompts',
          expected: 'Admin users can create, edit, toggle, and delete temporary prompt modules without blocking issues.',
        },
        actual,
        steps,
        monitor.getIssues(),
      );
    }
  });
});
