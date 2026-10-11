/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { expect, test, type Locator, type Page } from '@playwright/test';
import { authStatePaths, hasCredentials } from './support/auth';
import { safeCloseContext } from './support/contextCleanup';

import { applyDeploymentProtectionBypass, gotoWithBypass } from './support/deploymentProtection';
import { createIssueMonitor, writeFlowAudit } from './support/monitoring';

async function acceptNextDialog(page: Page) {
  return page.waitForEvent('dialog', { timeout: 15000 }).then((dialog) => dialog.accept());
}

async function openSelectAndChoose(trigger: Locator, optionText: string) {
  await trigger.click();
  await trigger.page().getByRole('option', { name: new RegExp(optionText, 'i') }).click();
}

async function saveAllSettings(page: Page) {
  const saveAllButton = page.getByTestId('admin-settings-save-all');
  await saveAllButton.click();
  await expect(saveAllButton).toBeEnabled({ timeout: 60000 });
}

async function openMaintenancePage(page: Page) {
  await gotoWithBypass(page, '/maintenance');
  await expect(page).toHaveURL(/\/maintenance/);
  await expect(page.getByRole('heading', { name: /维护中/ })).toBeVisible({ timeout: 15000 });
}

async function openAdminSettings(page: Page) {
  await gotoWithBypass(page, '/admin/settings');
  await expect(page).toHaveURL(/\/admin\/settings/);
  await expect(page.getByTestId('admin-settings-save-all')).toBeVisible({ timeout: 30000 });
  await expect(page.getByTestId('admin-setting-site_name')).toBeVisible({ timeout: 30000 });
}

async function setSwitchState(toggle: Locator, enabled: boolean) {
  await expect(toggle).toBeVisible({ timeout: 10000 });
  const currentState = (await toggle.getAttribute('data-state')) === 'checked';
  if (currentState !== enabled) {
    await toggle.click();
  }
}

async function saveMaintenanceMode(
  page: Page,
  enabled: boolean,
  saveAllButton: Locator,
  maintenanceSwitch: Locator,
) {
  await expect(maintenanceSwitch).toBeVisible({ timeout: 10000 });
  const currentState = (await maintenanceSwitch.getAttribute('data-state')) === 'checked';
  if (currentState !== enabled) {
    await maintenanceSwitch.click();
  }
  await saveAllButton.click();
  await expect(saveAllButton).toBeEnabled({ timeout: 60000 });
}

test.describe('Admin Config Flows', () => {
  test.describe.configure({ mode: 'serial' });
  test.use({ storageState: authStatePaths.admin });
  test.skip(!hasCredentials('admin'), 'E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD are required for admin config flows');

  test('should persist and restore global settings and membership export settings', async ({ page }, testInfo) => {
    test.setTimeout(90000);
    const steps: string[] = [];
    const monitor = createIssueMonitor(page);
    const siteNameInput = page.getByTestId('admin-setting-site_name');
    const supportEmailInput = page.getByTestId('admin-setting-support_email');
    let actual = 'Global settings flow completed';

    try {
      steps.push('Open /admin/settings');
      await openAdminSettings(page);

      const originalSiteName = (await siteNameInput.inputValue()).trim();
      const originalSupportEmail = (await supportEmailInput.inputValue()).trim();
      const updatedSiteName = `Parity Config ${Date.now()}`;
      const updatedSupportEmail = `parity-${Date.now()}@example.com`;

      steps.push('Update the site name and support email, then save all settings');
      await siteNameInput.fill(updatedSiteName);
      await supportEmailInput.fill(updatedSupportEmail);
      await saveAllSettings(page);

      steps.push('Reload and verify the new site name persisted');
      await page.reload();
      await expect(siteNameInput).toHaveValue(updatedSiteName, { timeout: 15000 });
      await expect(supportEmailInput).toHaveValue(updatedSupportEmail, { timeout: 15000 });

      steps.push('Verify the landing page, contact page, and maintenance page pick up the updated branding and support email');
      await gotoWithBypass(page, '/landing');
      await expect(page).toHaveTitle(new RegExp(updatedSiteName));
      await expect(page.getByText(updatedSiteName, { exact: true }).first()).toBeVisible({ timeout: 15000 });
      await expect(page.getByText(updatedSupportEmail, { exact: true }).first()).toBeVisible({
        timeout: 15000,
      });
      await gotoWithBypass(page, '/contact');
      await expect(page.getByText(updatedSupportEmail, { exact: true }).first()).toBeVisible({
        timeout: 15000,
      });
      await openMaintenancePage(page);
      await expect(page.getByText(updatedSupportEmail, { exact: true }).first()).toBeVisible({
        timeout: 15000,
      });
      await openAdminSettings(page);

      const membershipPlan = page.getByTestId(/^membership-plan-/).first();
      const membershipPlanCount = await membershipPlan.count();
      if (membershipPlanCount > 0) {
        const planId = (await membershipPlan.getAttribute('data-testid'))?.replace('membership-plan-', '') ?? '';
        const exportSwitch = page.getByTestId(`membership-plan-allow-export-${planId}`);
        const planSaveButton = page.getByTestId(`membership-plan-save-${planId}`);

        const originalExportChecked = await exportSwitch.getAttribute('data-state');
        const updatedExportChecked = originalExportChecked === 'checked' ? 'unchecked' : 'checked';

        steps.push('Update membership export permission, then verify persistence');
        await exportSwitch.click();
        await planSaveButton.click();
        await expect(planSaveButton).toBeEnabled({ timeout: 30000 });
        await page.reload();
        await expect(exportSwitch).toHaveAttribute('data-state', updatedExportChecked, { timeout: 15000 });

        steps.push('Restore the original membership export permission value');
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

      steps.push('Restore the original site name and support email');
      await siteNameInput.fill(originalSiteName);
      await supportEmailInput.fill(originalSupportEmail);
      await saveAllSettings(page);

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

  test('should redirect public visitors to maintenance mode while allowing admins to continue', async ({ browser, page }, testInfo) => {
    test.setTimeout(90000);
    const steps: string[] = [];
    const monitor = createIssueMonitor(page);
    const publicContext = await browser.newContext({
      storageState: { cookies: [], origins: [] },
    });
    const publicPage = await publicContext.newPage();
    const publicMonitor = createIssueMonitor(publicPage);
    const maintenanceSwitch = page.getByTestId('admin-setting-maintenance_mode');
    const saveAllButton = page.getByTestId('admin-settings-save-all');
    let actual = 'Maintenance mode redirected public visitors and preserved admin access';
    let originalMaintenanceState: boolean | null = null;

    try {
      steps.push('Open /admin/settings and capture the original maintenance mode state');
      await openAdminSettings(page);
      originalMaintenanceState = (await maintenanceSwitch.getAttribute('data-state')) === 'checked';

      steps.push('Enable maintenance mode from the admin settings page');
      await saveMaintenanceMode(page, true, saveAllButton, maintenanceSwitch);

      // Middleware caches the maintenance flag briefly to avoid hammering Supabase.
      await page.waitForTimeout(2500);

      steps.push('Verify the admin can still access /admin while maintenance mode is enabled');
      await gotoWithBypass(page, '/admin');
      await expect(page).toHaveURL(/\/admin/);

      steps.push('Verify a public visitor is redirected from /login to /maintenance');
      await applyDeploymentProtectionBypass(publicPage);
      await publicPage.goto('/login');
      await publicPage.waitForURL(/\/maintenance/, { timeout: 15000 });
      await expect(publicPage.getByRole('heading', { name: /维护中/ })).toBeVisible({ timeout: 10000 });

      const blockingIssues = [
        ...monitor.getIssues('P1'),
        ...publicMonitor.getIssues('P1'),
      ];
      expect(blockingIssues, JSON.stringify(blockingIssues, null, 2)).toEqual([]);
    } catch (error) {
      actual = error instanceof Error ? error.message : 'Unknown maintenance mode failure';
      monitor.addAssertionIssue(actual, 'P1');
      throw error;
    } finally {
      if (originalMaintenanceState !== null) {
        try {
          steps.push('Restore the original maintenance mode state');
          await openAdminSettings(page);
          await saveMaintenanceMode(page, originalMaintenanceState, saveAllButton, maintenanceSwitch);
          await page.waitForTimeout(2500);
        } catch (restoreError) {
          const restoreMessage =
            restoreError instanceof Error
              ? restoreError.message
              : 'Failed to restore maintenance mode state';
          monitor.addAssertionIssue(`Maintenance mode cleanup failed: ${restoreMessage}`, 'P1');
        }
      }
      await safeCloseContext(publicContext);
      await writeFlowAudit(
        testInfo,
        {
          title: 'admin-maintenance-mode',
          role: 'admin',
          route: '/admin/settings,/login,/maintenance',
          expected: 'Admins can enable maintenance mode without locking themselves out, and public visitors are redirected to the maintenance page until the setting is restored.',
        },
        actual,
        steps,
        [...monitor.getIssues(), ...publicMonitor.getIssues()],
      );
    }
  });

  test('should save page-experience settings from admin settings and keep announcement CRUD isolated', async ({ page }, testInfo) => {
    test.setTimeout(90000);
    const steps: string[] = [];
    const monitor = createIssueMonitor(page);
    const title = `Parity Announcement ${Date.now()}`;
    const editedTitle = `${title} Edited`;
    let actual = 'Settings ownership and announcement CRUD flow completed';

    try {
      steps.push('Open /admin/settings and switch to 页面体验');
      await gotoWithBypass(page, '/admin/settings');
      await expect(page).toHaveURL(/\/admin\/settings/);
      await page.getByRole('tab', { name: '页面体验' }).click();

      const chatPromptInput = page.getByTestId('admin-setting-chat_prompt_text');
      const chatWelcomeInput = page.getByTestId('admin-setting-chat_welcome_message');
      const chatModelSelectorSwitch = page.getByTestId('admin-setting-chat_show_model_selector');
      const chatBillingHintInput = page.getByTestId('admin-setting-chat_billing_hint');
      const homeOnboardingSwitch = page.getByTestId('admin-setting-home_show_onboarding');
      const homeFeaturedSwitch = page.getByTestId('admin-setting-home_show_featured_modules');
      await expect(chatPromptInput).toBeVisible({ timeout: 10000 });

      const originalChatPrompt = await chatPromptInput.inputValue();
      const originalChatWelcome = await chatWelcomeInput.inputValue();
      const originalChatBillingHint = await chatBillingHintInput.inputValue();
      const originalModelSelectorState = (await chatModelSelectorSwitch.getAttribute('data-state')) === 'checked';
      const originalOnboardingState = (await homeOnboardingSwitch.getAttribute('data-state')) === 'checked';
      const originalFeaturedState = (await homeFeaturedSwitch.getAttribute('data-state')) === 'checked';
      const updatedChatPrompt = `Parity welcome prompt ${Date.now()}`;
      const updatedChatWelcome = `欢迎来到新的聊天页 ${Date.now()}`;
      const updatedBillingHint = `Parity billing hint ${Date.now()}`;

      steps.push('Update page-experience settings from the canonical settings page');
      await chatPromptInput.fill(updatedChatPrompt);
      await chatWelcomeInput.fill(updatedChatWelcome);
      await chatBillingHintInput.fill(updatedBillingHint);
      await setSwitchState(chatModelSelectorSwitch, !originalModelSelectorState);
      await setSwitchState(homeOnboardingSwitch, !originalOnboardingState);
      await setSwitchState(homeFeaturedSwitch, !originalFeaturedState);
      await saveAllSettings(page);
      await page.reload();
      await page.getByRole('tab', { name: '页面体验' }).click();
      await expect(chatPromptInput).toBeVisible({ timeout: 10000 });
      await expect(chatPromptInput).toHaveValue(updatedChatPrompt, { timeout: 15000 });
      await expect(chatWelcomeInput).toHaveValue(updatedChatWelcome, { timeout: 15000 });
      await expect(chatBillingHintInput).toHaveValue(updatedBillingHint, { timeout: 15000 });

      // The new home page (/) no longer renders the onboarding guide or featured modules; these
      // toggles now only affect /landing, so the stale home-page assertions were removed.

      steps.push('Open /admin/announcements and verify CRUD remains isolated to announcement management');
      await gotoWithBypass(page, '/admin/announcements');
      await page.getByTestId('admin-announcement-create-banner').click();
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

      steps.push('Restore the original page-experience settings from /admin/settings');
      await gotoWithBypass(page, '/admin/settings');
      await page.getByRole('tab', { name: '页面体验' }).click();
      await expect(chatPromptInput).toBeVisible({ timeout: 10000 });
      await chatPromptInput.fill(originalChatPrompt);
      await chatWelcomeInput.fill(originalChatWelcome);
      await chatBillingHintInput.fill(originalChatBillingHint);
      await setSwitchState(chatModelSelectorSwitch, originalModelSelectorState);
      await setSwitchState(homeOnboardingSwitch, originalOnboardingState);
      await setSwitchState(homeFeaturedSwitch, originalFeaturedState);
      await saveAllSettings(page);

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
          title: 'admin-settings-page-experience-and-announcements-crud',
          role: 'admin',
          route: '/admin/settings,/admin/announcements',
          expected: 'Admin users manage page-experience settings from /admin/settings, settings persist, and announcement CRUD remains isolated to /admin/announcements.',
        },
        actual,
        steps,
        monitor.getIssues(),
      );
    }
  });

  test('should apply check-in and invitation reward settings to the profile surface', async ({ browser, page }, testInfo) => {
    test.setTimeout(90000);
    const steps: string[] = [];
    const monitor = createIssueMonitor(page);
    let actual = 'Check-in and invitation settings flow completed';

    const userContext = await browser.newContext({ storageState: authStatePaths.user });
    const userPage = await userContext.newPage();
    const userMonitor = createIssueMonitor(userPage);

    try {
      steps.push('Update check-in rewards from /admin/settings');
      await gotoWithBypass(page, '/admin/settings');
      await page.getByRole('tab', { name: '签到福利' }).click();

      const checkinDay1Input = page.getByTestId('admin-setting-checkin_day1');
      const monthlyBonusInput = page.getByTestId('admin-setting-checkin_monthly_bonus');
      const originalCheckinDay1 = await checkinDay1Input.inputValue();
      const originalMonthlyBonus = await monthlyBonusInput.inputValue();
      const updatedCheckinDay1 = String(60 + (Date.now() % 10));
      const updatedMonthlyBonus = String(90 + (Date.now() % 10));

      await checkinDay1Input.fill(updatedCheckinDay1);
      await monthlyBonusInput.fill(updatedMonthlyBonus);
      await saveAllSettings(page);

      steps.push('Update invitation rewards from /admin/settings');
      await page.getByRole('tab', { name: '邀请奖励' }).click();
      const inviterRewardInput = page.getByTestId('admin-setting-invite_inviter_reward');
      const inviteeRewardInput = page.getByTestId('admin-setting-invite_invitee_reward');
      const originalInviterReward = await inviterRewardInput.inputValue();
      const originalInviteeReward = await inviteeRewardInput.inputValue();
      const updatedInviterReward = String(110 + (Date.now() % 10));
      const updatedInviteeReward = String(70 + (Date.now() % 10));

      await inviterRewardInput.fill(updatedInviterReward);
      await inviteeRewardInput.fill(updatedInviteeReward);
      await saveAllSettings(page);

      steps.push('Verify the profile check-in dialog reflects the new reward ladder and monthly bonus');
      await gotoWithBypass(userPage, '/profile');
      await userPage.getByTestId('profile-checkin-card').click();
      const checkinDialog = userPage.getByTestId('profile-checkin-dialog');
      await expect(checkinDialog).toBeVisible({ timeout: 10000 });
      await expect(checkinDialog.getByText(`+${updatedCheckinDay1}`, { exact: false }).first()).toBeVisible({ timeout: 10000 });
      await expect(checkinDialog.getByText(`+${updatedMonthlyBonus}`, { exact: false }).first()).toBeVisible({ timeout: 10000 });
      await userPage.keyboard.press('Escape');

      steps.push('Verify the invitation dialog reflects the updated inviter and invitee rewards');
      await userPage.getByTestId('profile-invite-card').click();
      const inviteDialog = userPage.getByRole('dialog');
      await expect(inviteDialog.getByRole('heading', { name: '邀请好友' })).toBeVisible({ timeout: 10000 });
      await expect(inviteDialog.getByText(`+${updatedInviterReward}`, { exact: false }).first()).toBeVisible({ timeout: 10000 });
      await expect(inviteDialog.getByText(`+${updatedInviteeReward}`, { exact: false }).first()).toBeVisible({ timeout: 10000 });
      await userPage.keyboard.press('Escape');

      steps.push('Restore the original reward settings');
      await gotoWithBypass(page, '/admin/settings');
      await page.getByRole('tab', { name: '签到福利' }).click();
      await checkinDay1Input.fill(originalCheckinDay1);
      await monthlyBonusInput.fill(originalMonthlyBonus);
      await page.getByRole('tab', { name: '邀请奖励' }).click();
      await inviterRewardInput.fill(originalInviterReward);
      await inviteeRewardInput.fill(originalInviteeReward);
      await saveAllSettings(page);

      const blockingIssues = [
        ...monitor.getIssues('P1'),
        ...userMonitor.getIssues('P1'),
      ];
      expect(blockingIssues, JSON.stringify(blockingIssues, null, 2)).toEqual([]);
    } catch (error) {
      actual = error instanceof Error ? error.message : 'Unknown reward settings failure';
      monitor.addAssertionIssue(actual, 'P1');
      throw error;
    } finally {
      await safeCloseContext(userContext);
      await writeFlowAudit(
        testInfo,
        {
          title: 'admin-settings-checkin-invite-effects',
          role: 'admin',
          route: '/admin/settings,/profile',
          expected: 'Admin users can change check-in and invitation reward settings from /admin/settings, and the profile check-in/invitation dialogs reflect the new values.',
        },
        actual,
        steps,
        [...monitor.getIssues(), ...userMonitor.getIssues()],
      );
    }
  });

  test('should create, edit, and delete credit packages and membership plans', async ({ page }, testInfo) => {
    test.setTimeout(90000);
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
      await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 15000 });
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

  test('should create, edit, toggle, and soft-disable a function module', async ({ page }, testInfo) => {
    test.setTimeout(90000);
    const steps: string[] = [];
    const monitor = createIssueMonitor(page);
    const promptName = `Parity Module ${Date.now()}`;
    const editedPromptName = `${promptName} Edited`;
    let actual = 'Function module flow completed';

    try {
      steps.push('Open /admin/prompts');
      await gotoWithBypass(page, '/admin/prompts');
      await expect(page).toHaveURL(/\/admin\/prompts/);

      steps.push('Create a temporary function module');
      await page.getByRole('button', { name: '新建模块' }).click();
      await page.getByTestId('prompt-name-input').fill(promptName);
      await page.getByTestId('prompt-description-input').fill(`Parity prompt description ${Date.now()}`);
      await page.getByTestId('prompt-content-input').fill(`You are a parity audit helper ${Date.now()}.`);
      await page.getByTestId('prompt-save').click();
      await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 15000 });
      await expect(page.locator('tr').filter({ hasText: promptName }).first()).toBeVisible({ timeout: 15000 });

      steps.push('Edit the function module');
      const promptRow = page.locator('tr').filter({ hasText: promptName }).first();
      await promptRow.getByRole('button').first().click();
      await page.getByTestId('prompt-name-input').fill(editedPromptName);
      await page.getByTestId('prompt-description-input').fill(`Parity prompt edited ${Date.now()}`);
      await page.getByTestId('prompt-save').click();
      await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 15000 });
      await expect(page.locator('tr').filter({ hasText: editedPromptName }).first()).toBeVisible({ timeout: 15000 });

      const editedRow = page.locator('tr').filter({ hasText: editedPromptName }).first();

      steps.push('Toggle the function module active status');
      const statusBadge = editedRow.getByText(/展示中|已下架/).first();
      const originalStatus = (await statusBadge.textContent())?.trim() ?? '';
      await statusBadge.click();
      await expect.poll(async () => ((await editedRow.getByText(/展示中|已下架/).first().textContent()) ?? '').trim(), {
        timeout: 15000,
      }).not.toBe(originalStatus);

      steps.push('Soft-disable the temporary function module');
      // Soft-disable is the status toggle; the row's delete button is now a hard delete behind an in-app dialog.
      if (!((await editedRow.getByText(/展示中|已下架/).first().textContent()) ?? '').includes('已下架')) {
        await editedRow.getByText('展示中').first().click();
      }
      await expect(editedRow).toBeVisible({ timeout: 15000 });
      await expect(editedRow.getByText('已下架')).toBeVisible({ timeout: 15000 });

      const blockingIssues = monitor.getIssues('P1');
      expect(blockingIssues, JSON.stringify(blockingIssues, null, 2)).toEqual([]);
    } catch (error) {
      actual = error instanceof Error ? error.message : 'Unknown function module failure';
      monitor.addAssertionIssue(actual, 'P1');
      throw error;
    } finally {
      await writeFlowAudit(
        testInfo,
        {
          title: 'admin-function-modules-crud',
          role: 'admin',
          route: '/admin/prompts',
          expected: 'Admin users can create, edit, toggle, and soft-disable temporary function modules without blocking issues.',
        },
        actual,
        steps,
        monitor.getIssues(),
      );
    }
  });
});
