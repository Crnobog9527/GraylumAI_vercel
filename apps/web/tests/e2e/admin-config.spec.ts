/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import { authStatePaths, getCredentials, hasCredentials } from './support/auth';
import { safeCloseContext } from './support/contextCleanup';
import {
  getAiUsageLogByRequestId,
  createConversationFixtureForUserEmail,
  createTokenStatsFixture,
  getCreditsForUserEmail,
  setCreditsForUserEmail,
  softDeleteConversationFixture,
} from './support/creditFixtures';
import { applyDeploymentProtectionBypass, gotoWithBypass } from './support/deploymentProtection';
import { createIssueMonitor, writeFlowAudit } from './support/monitoring';
import { isLocalPlaywrightBaseUrl, probeShowsRegionRestriction } from './support/runtimeConstraints';

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

function chatPromptInput(page: Page) {
  return page.locator('.chat-input-box textarea').first();
}

async function setChatPrompt(page: Page, prompt: string) {
  const input = chatPromptInput(page);
  const sendButton = page.getByRole('button', { name: '发送' });
  await expect(input).toBeEditable({ timeout: 20000 });

  await input.fill(prompt);
  if ((await input.inputValue()) !== prompt || await sendButton.isDisabled()) {
    await input.fill('');
    await input.click();
    await input.type(prompt);
  }
  if (await sendButton.isDisabled()) {
    await input.evaluate((element, value) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(element, value);
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }, prompt);
  }

  await expect.poll(async () => input.inputValue(), { timeout: 5000 }).toBe(prompt);
}

async function setSwitchState(toggle: Locator, enabled: boolean) {
  await expect(toggle).toBeVisible({ timeout: 10000 });
  const currentState = (await toggle.getAttribute('data-state')) === 'checked';
  if (currentState !== enabled) {
    await toggle.click();
  }
}

type StreamProbeResult = {
  status: number;
  body: string;
  events: Array<Record<string, unknown>>;
};

async function streamChatEventsThroughAuthenticatedSession(
  page: Page,
  prompt: string,
): Promise<StreamProbeResult> {
  await gotoWithBypass(page, '/landing');
  await expect(page).toHaveURL(/\/landing/);

  return page.evaluate(async (message) => {
    const authCookieEntry = document.cookie
      .split('; ')
      .find((entry) => entry.includes('-auth-token='));

    if (!authCookieEntry) {
      return { status: 0, body: 'Missing auth cookie', events: [] };
    }

    const rawCookieValue = decodeURIComponent(authCookieEntry.split('=').slice(1).join('='));
    let accessToken = '';

    if (rawCookieValue.startsWith('base64-')) {
      const parsed = JSON.parse(atob(rawCookieValue.slice(7)));
      accessToken = parsed.access_token ?? '';
    }

    if (!accessToken) {
      return { status: 0, body: 'Missing access token', events: [] };
    }

    const response = await fetch('/api/ai/stream', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        message,
        requestId: crypto.randomUUID(),
      }),
    });

    const reader = response.body?.getReader();
    if (!reader) {
      return {
        status: response.status,
        body: await response.text(),
        events: [],
      };
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let rawBody = '';
    const events: Array<Record<string, unknown>> = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      rawBody += chunk;
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (!payload) continue;

        try {
          events.push(JSON.parse(payload) as Record<string, unknown>);
        } catch {
          // Ignore malformed provider keepalive frames.
        }
      }
    }

    return {
      status: response.status,
      body: rawBody,
      events,
    };
  }, prompt);
}

function clearIntentionalStreamAbortIssues(
  monitor: ReturnType<typeof createIssueMonitor>,
) {
  monitor.removeIssues((issue) =>
    (issue.source === 'requestfailed'
      && issue.method === 'POST'
      && issue.url?.includes('/api/ai/stream')
      && issue.message === 'net::ERR_ABORTED')
    || (issue.source === 'console' && issue.message.includes('Streaming error'))
    || (issue.source === 'pageerror' && issue.message === 'signal is aborted without reason')
  );
}

function clearExpectedMessageLimitIssues(
  monitor: ReturnType<typeof createIssueMonitor>,
) {
  monitor.removeIssues((issue) =>
    (issue.source === 'response'
      && issue.method === 'POST'
      && issue.status === 400
      && issue.url?.includes('/api/ai/stream'))
    || (issue.source === 'console'
      && issue.message?.includes('当前对话已达到')
      && issue.message?.includes('消息上限'))
    || (issue.source === 'console'
      && issue.message === 'Failed to load resource: the server responded with a status of 400 (Bad Request)')
  );
}

async function readCreditsFromRow(row: Locator) {
  const creditsCell = row.locator('td').nth(4);
  const rawText = await creditsCell.textContent();
  return Number((rawText ?? '').replace(/[^\d-]/g, ''));
}

async function setUserCredits(browser: Browser, targetCredits: number, reason: string) {
  if (!hasCredentials('admin') || !hasCredentials('user')) {
    throw new Error('E2E admin and user credentials are required for credit adjustment.');
  }

  const targetEmail = getCredentials('user').email;
  try {
    const snapshot = await getCreditsForUserEmail(targetEmail);
    await setCreditsForUserEmail(targetEmail, targetCredits, reason);
    return snapshot.credits;
  } catch {
    // Fall back to the admin UI path when direct fixture writes are unavailable.
  }

  const context = await browser.newContext({ storageState: authStatePaths.admin });
  const page = await context.newPage();

  try {
    await gotoWithBypass(page, '/admin/users');
    await expect(page).toHaveURL(/\/admin\/users/);

    await page.locator('input[placeholder="邮箱或昵称..."]').fill(targetEmail);
    const targetRow = page.locator('tbody tr').filter({ hasText: targetEmail }).first();
    await expect(targetRow).toBeVisible({ timeout: 15000 });

    const currentCredits = await readCreditsFromRow(targetRow);
    const delta = targetCredits - currentCredits;
    if (delta === 0) {
      return currentCredits;
    }

    await targetRow.getByRole('button', { name: '积分' }).click();
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 10000 });
    await page.locator('input[type="number"]').fill(String(delta));
    await page.locator('input[placeholder="奖励积分、退款等..."]').fill(reason);

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
    await expect.poll(async () => readCreditsFromRow(targetRow), { timeout: 15000 }).toBe(targetCredits);

    return currentCredits;
  } finally {
    await safeCloseContext(context);
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

      steps.push('Verify chat and home surfaces consume the updated page-experience settings');
      await gotoWithBypass(page, '/chat');
      await expect(page.getByText(updatedChatWelcome)).toBeVisible({ timeout: 15000 });
      await expect(page.locator(`textarea[placeholder="${updatedChatPrompt}"]`)).toBeVisible({ timeout: 10000 });
      await expect(page.getByText(updatedBillingHint, { exact: false })).toBeVisible({ timeout: 10000 });
      if (originalModelSelectorState) {
        await expect(page.getByTestId('chat-model-selector-trigger')).toHaveCount(0);
      } else {
        await expect(page.getByTestId('chat-model-selector-trigger')).toBeVisible({ timeout: 10000 });
      }

      await gotoWithBypass(page, '/');
      if (originalOnboardingState) {
        await expect(page.getByTestId('home-onboarding-guide')).toHaveCount(0);
      } else {
        await expect(page.getByTestId('home-onboarding-guide')).toBeVisible({ timeout: 10000 });
      }
      if (originalFeaturedState) {
        await expect(page.getByTestId('featured-modules-section')).toHaveCount(0);
      } else {
        await expect(page.getByTestId('featured-modules-section')).toBeVisible({ timeout: 10000 });
      }

      steps.push('Open /admin/announcements and verify CRUD remains isolated to announcement management');
      await gotoWithBypass(page, '/admin/announcements');
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
          route: '/admin/settings,/admin/announcements,/chat,/',
          expected: 'Admin users manage page-experience settings from /admin/settings, those settings affect chat and home surfaces, and announcement CRUD remains isolated to /admin/announcements.',
        },
        actual,
        steps,
        monitor.getIssues(),
      );
    }
  });

  test('should apply chat runtime feature settings from admin settings to the live chat surface', async ({ browser, page }, testInfo) => {
    test.setTimeout(120000);
    const steps: string[] = [];
    const monitor = createIssueMonitor(page);
    let actual = 'Chat runtime settings flow completed';
    let seededConversationId: string | null = null;
    const seededConversationTitle = `Parity runtime stats fixture ${Date.now()}`;

    const userContext = await browser.newContext({ storageState: authStatePaths.user });
    const userPage = await userContext.newPage();
    const userMonitor = createIssueMonitor(userPage);

    try {
      steps.push('Open /admin/settings and update chat runtime settings');
      await gotoWithBypass(page, '/admin/settings');
      await page.getByRole('tab', { name: '功能设置' }).click();

      const maxInputInput = page.getByTestId('admin-setting-max_input_characters');
      const maxMessagesPerConversationInput = page.getByTestId('admin-setting-max_messages_per_conversation');
      const enableLongTextWarningSwitch = page.getByTestId('admin-setting-enable_long_text_warning');
      const longTextThresholdInput = page.getByTestId('admin-setting-long_text_warning_threshold');
      const showTokenUsageStatsSwitch = page.getByTestId('admin-setting-show_token_usage_stats');

      const originalMaxInput = await maxInputInput.inputValue();
      const originalMaxMessagesPerConversation = await maxMessagesPerConversationInput.inputValue();
      const originalLongTextThreshold = await longTextThresholdInput.inputValue();
      const originalLongTextWarningState = (await enableLongTextWarningSwitch.getAttribute('data-state')) === 'checked';
      const originalTokenUsageStatsState = (await showTokenUsageStatsSwitch.getAttribute('data-state')) === 'checked';

      await maxInputInput.fill('40');
      await maxMessagesPerConversationInput.fill('2');
      await longTextThresholdInput.fill('10');
      await setSwitchState(enableLongTextWarningSwitch, true);
      await setSwitchState(showTokenUsageStatsSwitch, true);
      await saveAllSettings(page);

      steps.push('Seed a metered conversation fixture so token usage visibility does not depend on local live model output');
      const conversationFixture = await createConversationFixtureForUserEmail(getCredentials('user').email, {
        title: seededConversationTitle,
        userMessage: '请总结后台设置影响路径。',
        assistantMessage: '后台设置已同步到前台运行时。',
      });
      seededConversationId = conversationFixture.id;
      await createTokenStatsFixture({
        conversationId: conversationFixture.id,
        userId: conversationFixture.userId,
        inputTokens: 128,
        outputTokens: 256,
        totalCredits: 12,
        totalCostUsd: '0.018000',
      });

      steps.push('Open /chat and verify the updated runtime constraints appear on the live surface');
      await gotoWithBypass(userPage, '/chat');
      const textarea = userPage.locator('textarea[placeholder]');
      await expect(textarea).toHaveAttribute('maxlength', '40', { timeout: 10000 });

      const prompt = '请用一句话总结后台设置影响路径';
      await textarea.fill(prompt);
      await userPage.getByRole('button', { name: '发送' }).click();
      await expect(userPage.getByText('长文本发送确认')).toBeVisible({ timeout: 10000 });
      await userPage.getByRole('button', { name: '再检查一下' }).click();
      await expect(userPage.getByText('长文本发送确认')).toHaveCount(0, { timeout: 10000 });
      clearIntentionalStreamAbortIssues(userMonitor);

      steps.push('Open the seeded metered conversation and verify token usage stats become visible');
      const meteredConversation = userPage
        .getByTestId('conversation-item')
        .filter({ hasText: seededConversationTitle })
        .first();
      await expect(meteredConversation).toBeVisible({ timeout: 15000 });
      await meteredConversation.click();
      await expect(userPage.getByTestId('chat-token-usage-stats')).toBeVisible({ timeout: 15000 });

      steps.push('Verify the seeded conversation is blocked once the per-conversation message limit is reached');
      const assistantCountBeforeBlockedSend = await userPage.locator('[data-testid="chat-message"][data-message-role="assistant"]').count();
      await textarea.fill('继续');
      await userPage.getByRole('button', { name: '发送' }).click();
      await expect(userPage.getByText('当前对话已达到 2 条消息上限，请新建对话后继续')).toBeVisible({ timeout: 15000 });
      await expect.poll(
        () => userPage.locator('[data-testid="chat-message"][data-message-role="assistant"]').count(),
        { timeout: 5000 }
      ).toBe(assistantCountBeforeBlockedSend);
      clearExpectedMessageLimitIssues(userMonitor);

      steps.push('Disable token usage stats and verify the live chat surface hides the stats panel');
      await gotoWithBypass(page, '/admin/settings');
      await page.getByRole('tab', { name: '功能设置' }).click();
      await setSwitchState(showTokenUsageStatsSwitch, false);
      await saveAllSettings(page);

      await gotoWithBypass(userPage, '/chat');
      await expect(userPage.getByTestId('chat-token-usage-stats')).toHaveCount(0);

      steps.push('Restore the original chat runtime settings');
      await gotoWithBypass(page, '/admin/settings');
      await page.getByRole('tab', { name: '功能设置' }).click();
      await maxInputInput.fill(originalMaxInput);
      await maxMessagesPerConversationInput.fill(originalMaxMessagesPerConversation);
      await longTextThresholdInput.fill(originalLongTextThreshold);
      await setSwitchState(enableLongTextWarningSwitch, originalLongTextWarningState);
      await setSwitchState(showTokenUsageStatsSwitch, originalTokenUsageStatsState);
      await saveAllSettings(page);

      clearIntentionalStreamAbortIssues(userMonitor);
      const blockingIssues = [
        ...monitor.getIssues('P1'),
        ...userMonitor.getIssues('P1'),
      ];
      expect(blockingIssues, JSON.stringify(blockingIssues, null, 2)).toEqual([]);
    } catch (error) {
      actual = error instanceof Error ? error.message : 'Unknown chat runtime settings failure';
      monitor.addAssertionIssue(actual, 'P1');
      throw error;
    } finally {
      if (seededConversationId) {
        await softDeleteConversationFixture(seededConversationId);
      }
      await safeCloseContext(userContext);
      await writeFlowAudit(
        testInfo,
        {
          title: 'admin-settings-chat-runtime-effects',
          role: 'admin',
          route: '/admin/settings,/chat',
          expected: 'Admin feature settings update the live chat constraints, long-text confirmation, and token usage visibility from the canonical settings page.',
        },
        actual,
        steps,
        [...monitor.getIssues(), ...userMonitor.getIssues()],
      );
    }
  });

  test('should toggle free-tier chat access from admin settings for zero-credit users', async ({ browser, page }, testInfo) => {
    test.setTimeout(120000);
    const steps: string[] = [];
    const monitor = createIssueMonitor(page);
    let actual = 'Free-tier gating flow completed';
    let originalCredits: number | null = null;

    const userContext = await browser.newContext({ storageState: authStatePaths.user });
    const userPage = await userContext.newPage();
    const userMonitor = createIssueMonitor(userPage);

    try {
      steps.push('Set the user credits to zero to exercise the zero-balance path');
      originalCredits = await setUserCredits(browser, 0, `Parity free-tier toggle ${Date.now()}`);

      steps.push('Enable free tier and set the daily free message count to 1');
      await gotoWithBypass(page, '/admin/settings');
      await page.getByRole('tab', { name: '功能设置' }).click();

      const enableFreeTierSwitch = page.getByTestId('admin-setting-enable_free_tier');
      const freeTierMessagesInput = page.getByTestId('admin-setting-free_tier_messages');
      const originalFreeTierState = (await enableFreeTierSwitch.getAttribute('data-state')) === 'checked';
      const originalFreeTierMessages = await freeTierMessagesInput.inputValue();

      await setSwitchState(enableFreeTierSwitch, true);
      await freeTierMessagesInput.fill('1');
      await saveAllSettings(page);

      steps.push('Verify a zero-credit user can initiate a chat request when free tier is enabled');
      await gotoWithBypass(userPage, '/chat');
      let streamRequestCount = 0;
      userPage.on('request', (request) => {
        if (request.url().includes('/api/ai/stream') && request.method() === 'POST') {
          streamRequestCount += 1;
        }
      });
      await setChatPrompt(userPage, `Parity free tier request ${Date.now()}`);
      await userPage.getByRole('button', { name: '发送' }).click();
      await expect.poll(() => streamRequestCount, { timeout: 15000 }).toBeGreaterThan(0);
      await expect(userPage.getByRole('alertdialog')).toHaveCount(0);
      const stopButton = userPage.getByRole('button', { name: '停止' });
      if (await stopButton.isVisible({ timeout: 5000 }).catch(() => false)) {
        await stopButton.click();
        await expect(userPage.getByRole('button', { name: '发送' })).toBeVisible({ timeout: 15000 });
      }
      clearIntentionalStreamAbortIssues(userMonitor);

      steps.push('Disable free tier and verify the same zero-credit user is blocked again');
      await gotoWithBypass(page, '/admin/settings');
      await page.getByRole('tab', { name: '功能设置' }).click();
      await setSwitchState(enableFreeTierSwitch, false);
      await saveAllSettings(page);

      await gotoWithBypass(userPage, '/chat');
      const blockedRequestBaseline = streamRequestCount;
      await setChatPrompt(userPage, `Parity blocked free tier request ${Date.now()}`);
      await userPage.getByRole('button', { name: '发送' }).click();
      await expect(userPage.getByRole('heading', { name: '积分已用完' })).toBeVisible({ timeout: 10000 });
      await userPage.waitForTimeout(1500);
      expect(streamRequestCount).toBe(blockedRequestBaseline);
      clearIntentionalStreamAbortIssues(userMonitor);

      steps.push('Restore the original free-tier settings');
      await gotoWithBypass(page, '/admin/settings');
      await page.getByRole('tab', { name: '功能设置' }).click();
      await setSwitchState(enableFreeTierSwitch, originalFreeTierState);
      await freeTierMessagesInput.fill(originalFreeTierMessages);
      await saveAllSettings(page);

      const blockingIssues = [
        ...monitor.getIssues('P1'),
        ...userMonitor.getIssues('P1'),
      ];
      expect(blockingIssues, JSON.stringify(blockingIssues, null, 2)).toEqual([]);
    } catch (error) {
      actual = error instanceof Error ? error.message : 'Unknown free-tier gating failure';
      monitor.addAssertionIssue(actual, 'P1');
      throw error;
    } finally {
      if (originalCredits !== null) {
        await setUserCredits(browser, originalCredits, `Restore credits after free-tier toggle ${Date.now()}`);
      }
      await safeCloseContext(userContext);
      await writeFlowAudit(
        testInfo,
        {
          title: 'admin-settings-free-tier-effects',
          role: 'admin',
          route: '/admin/settings,/chat',
          expected: 'Admin users can enable free-tier chat access for zero-credit users and disabling it restores the low-balance guard.',
        },
        actual,
        steps,
        [...monitor.getIssues(), ...userMonitor.getIssues()],
      );
    }
  });

  test('should toggle smart routing from admin settings and change preview runtime upgrade behavior', async ({ browser, page }, testInfo) => {
    test.skip(isLocalPlaywrightBaseUrl(), 'Smart-routing effect proof requires a deployed Vercel preview.');
    test.setTimeout(120000);
    const steps: string[] = [];
    const monitor = createIssueMonitor(page);
    const prompt = '查今天全球AI三条要闻及影响，仅回已阅。';
    let actual = 'Smart routing toggle changed preview route-upgrade behavior as expected';
    let originalSmartRoutingState: boolean | null = null;
    let originalCredits: number | null = null;

    const userContext = await browser.newContext({ storageState: authStatePaths.user });
    const userPage = await userContext.newPage();

    try {
      steps.push('Ensure the E2E user has enough credits for two direct preview runtime probes');
      originalCredits = await setUserCredits(browser, 120, `Preview smart routing probe ${Date.now()}`);

      steps.push('Open /admin/settings and switch to 功能设置');
      await gotoWithBypass(page, '/admin/settings');
      await page.getByRole('tab', { name: '功能设置' }).click();

      const smartRoutingSwitch = page.getByTestId('admin-setting-enable_smart_routing');
      originalSmartRoutingState = (await smartRoutingSwitch.getAttribute('data-state')) === 'checked';

      steps.push('Disable smart routing and save settings');
      await setSwitchState(smartRoutingSwitch, false);
      await saveAllSettings(page);

      steps.push('Probe the deployed preview runtime and verify route_upgraded is absent while smart routing is disabled');
      const disabledProbe = await streamChatEventsThroughAuthenticatedSession(userPage, prompt);
      expect(disabledProbe.status, disabledProbe.body).toBe(200);
      expect(probeShowsRegionRestriction(disabledProbe)).toBe(false);
      const disabledRouteUpgradeEvent = disabledProbe.events.find((event) => event.type === 'route_upgraded');
      const disabledCompleteEvent = disabledProbe.events.find((event) => event.type === 'complete');
      expect(disabledRouteUpgradeEvent, disabledProbe.body).toBeFalsy();
      expect(String(disabledCompleteEvent?.routingReason ?? '')).not.toContain('route_upgraded_preflight');

      steps.push('Re-enable smart routing and save settings');
      await gotoWithBypass(page, '/admin/settings');
      await page.getByRole('tab', { name: '功能设置' }).click();
      await setSwitchState(smartRoutingSwitch, true);
      await saveAllSettings(page);

      steps.push('Probe the deployed preview runtime again and verify route_upgraded returns');
      const enabledProbe = await streamChatEventsThroughAuthenticatedSession(userPage, prompt);
      expect(enabledProbe.status, enabledProbe.body).toBe(200);
      expect(probeShowsRegionRestriction(enabledProbe)).toBe(false);
      const enabledRouteUpgradeEvent = enabledProbe.events.find((event) => event.type === 'route_upgraded');
      const enabledCompleteEvent = enabledProbe.events.find((event) => event.type === 'complete');
      expect(enabledRouteUpgradeEvent, enabledProbe.body).toBeTruthy();
      expect(String(enabledCompleteEvent?.routingReason ?? '')).toContain('route_upgraded_preflight');

      const blockingIssues = monitor.getIssues('P1');
      expect(blockingIssues, JSON.stringify(blockingIssues, null, 2)).toEqual([]);
    } catch (error) {
      actual = error instanceof Error ? error.message : 'Unknown smart-routing preview effect failure';
      monitor.addAssertionIssue(actual, 'P0');
      throw error;
    } finally {
      if (originalSmartRoutingState !== null) {
        try {
          await gotoWithBypass(page, '/admin/settings');
          await page.getByRole('tab', { name: '功能设置' }).click();
          await setSwitchState(page.getByTestId('admin-setting-enable_smart_routing'), originalSmartRoutingState);
          await saveAllSettings(page);
        } catch {
          // Preserve the original assertion failure; restoration best effort only.
        }
      }
      if (originalCredits !== null) {
        await setUserCredits(browser, originalCredits, `Restore credits after smart routing probe ${Date.now()}`);
      }
      await safeCloseContext(userContext);
      await writeFlowAudit(
        testInfo,
        {
          title: 'admin-settings-smart-routing-preview-effects',
          role: 'admin',
          route: '/admin/settings,/api/ai/stream',
          expected: 'Disabling smart routing removes route_upgraded in preview runtime probes, and re-enabling it restores the route_upgraded SSE event.',
        },
        actual,
        steps,
        monitor.getIssues(),
      );
    }
  });

  test('should toggle smart search decision from admin settings and change preview search events', async ({ browser, page }, testInfo) => {
    test.skip(isLocalPlaywrightBaseUrl(), 'Smart-search effect proof requires a deployed Vercel preview.');
    test.setTimeout(120000);
    const steps: string[] = [];
    const monitor = createIssueMonitor(page);
    const prompt = '联网搜索今天全球AI三条要闻并只回已阅。';
    let actual = 'Smart search decision toggle changed preview runtime metadata as expected';
    let originalSmartSearchState: boolean | null = null;
    let originalCredits: number | null = null;

    const userContext = await browser.newContext({ storageState: authStatePaths.user });
    const userPage = await userContext.newPage();

    try {
      steps.push('Ensure the E2E user has enough credits for two direct preview search probes');
      originalCredits = await setUserCredits(browser, 120, `Preview smart search probe ${Date.now()}`);

      steps.push('Open /admin/settings and switch to 功能设置');
      await gotoWithBypass(page, '/admin/settings');
      await page.getByRole('tab', { name: '功能设置' }).click();

      const smartSearchSwitch = page.getByTestId('admin-setting-enable_smart_search_decision');
      originalSmartSearchState = (await smartSearchSwitch.getAttribute('data-state')) === 'checked';

      steps.push('Disable smart search decision and save settings');
      await setSwitchState(smartSearchSwitch, false);
      await saveAllSettings(page);

      steps.push('Probe the deployed preview runtime and verify usage metadata records webSearchRequested=false while smart search is disabled');
      const disabledProbe = await streamChatEventsThroughAuthenticatedSession(userPage, prompt);
      expect(disabledProbe.status, disabledProbe.body).toBe(200);
      expect(probeShowsRegionRestriction(disabledProbe)).toBe(false);
      const disabledInitEvent = disabledProbe.events.find((event) => event.type === 'init');
      const disabledRequestId = String(disabledInitEvent?.requestId ?? '');
      await expect
        .poll(async () => {
          const usageLog = disabledRequestId ? await getAiUsageLogByRequestId(disabledRequestId) : null;
          const metadata = usageLog?.metadata as Record<string, unknown> | undefined;
          return metadata?.webSearchRequested ?? null;
        }, { timeout: 15000 })
        .toBe(false);

      steps.push('Re-enable smart search decision and save settings');
      await gotoWithBypass(page, '/admin/settings');
      await page.getByRole('tab', { name: '功能设置' }).click();
      await setSwitchState(smartSearchSwitch, true);
      await saveAllSettings(page);

      steps.push('Probe the deployed preview runtime again and verify usage metadata records webSearchRequested=true');
      const enabledProbe = await streamChatEventsThroughAuthenticatedSession(userPage, prompt);
      expect(enabledProbe.status, enabledProbe.body).toBe(200);
      expect(probeShowsRegionRestriction(enabledProbe)).toBe(false);
      const enabledInitEvent = enabledProbe.events.find((event) => event.type === 'init');
      const enabledRequestId = String(enabledInitEvent?.requestId ?? '');
      await expect
        .poll(async () => {
          const usageLog = enabledRequestId ? await getAiUsageLogByRequestId(enabledRequestId) : null;
          const metadata = usageLog?.metadata as Record<string, unknown> | undefined;
          return metadata?.webSearchRequested ?? null;
        }, { timeout: 15000 })
        .toBe(true);

      const blockingIssues = monitor.getIssues('P1');
      expect(blockingIssues, JSON.stringify(blockingIssues, null, 2)).toEqual([]);
    } catch (error) {
      actual = error instanceof Error ? error.message : 'Unknown smart-search preview effect failure';
      monitor.addAssertionIssue(actual, 'P0');
      throw error;
    } finally {
      if (originalSmartSearchState !== null) {
        try {
          await gotoWithBypass(page, '/admin/settings');
          await page.getByRole('tab', { name: '功能设置' }).click();
          await setSwitchState(page.getByTestId('admin-setting-enable_smart_search_decision'), originalSmartSearchState);
          await saveAllSettings(page);
        } catch {
          // Preserve the original assertion failure; restoration best effort only.
        }
      }
      if (originalCredits !== null) {
        await setUserCredits(browser, originalCredits, `Restore credits after smart search probe ${Date.now()}`);
      }
      await safeCloseContext(userContext);
      await writeFlowAudit(
        testInfo,
        {
          title: 'admin-settings-smart-search-preview-effects',
          role: 'admin',
          route: '/admin/settings,/api/ai/stream',
          expected: 'Disabling smart search decision makes preview ai_usage_logs record webSearchRequested=false, and re-enabling it restores webSearchRequested=true for the same runtime probe shape.',
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

  test('should create, edit, toggle, and delete a prompt module', async ({ page }, testInfo) => {
    test.setTimeout(90000);
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
      await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 15000 });
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
