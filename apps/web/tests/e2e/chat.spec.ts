/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { test, expect, type Page } from '@playwright/test';
import { authStatePaths, hasCredentials } from './support/auth';
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

test.describe('AI Chat', () => {
  test.use({ storageState: authStatePaths.user });
  test.skip(!hasCredentials('user'), 'E2E_TEST_EMAIL and E2E_TEST_PASSWORD are required for chat flows');

  test('should display chat input', async ({ page }, testInfo) => {
    const steps: string[] = [];
    const monitor = createIssueMonitor(page);
    let actual = 'Chat shell rendered';

    try {
      steps.push('Open /chat');
      await gotoWithBypass(page, '/chat');
      await expect(page).toHaveURL(/\/chat/);

      steps.push('Verify input shell and CTA controls');
      await expect(page.getByText('开始新对话')).toBeVisible();
      await expect(page.locator('textarea[placeholder="请输入您的问题..."]')).toBeVisible();
      await expect(page.getByRole('button', { name: '发送' })).toBeVisible();

      const blockingIssues = monitor.getIssues('P1');
      expect(blockingIssues, JSON.stringify(blockingIssues, null, 2)).toEqual([]);
    } catch (error) {
      actual = error instanceof Error ? error.message : 'Unknown chat shell failure';
      monitor.addAssertionIssue(actual, 'P1');
      throw error;
    } finally {
      await writeFlowAudit(
        testInfo,
        {
          title: 'chat-shell-smoke',
          role: 'user',
          route: '/chat',
          expected: 'Chat page renders the main shell, input, and send CTA without blocking runtime issues.',
        },
        actual,
        steps,
        monitor.getIssues(),
      );
    }
  });

  test('should display conversation shell', async ({ page }, testInfo) => {
    const steps: string[] = [];
    const monitor = createIssueMonitor(page);
    let actual = 'Conversation shell rendered';

    try {
      steps.push('Open /chat and inspect sidebar');
      await gotoWithBypass(page, '/chat');
      await expect(page).toHaveURL(/\/chat/);

      steps.push('Verify conversation sidebar or empty state');
      await expect(page.getByText('全部对话')).toBeVisible();
      await expect(page.getByRole('button', { name: /新建对话/ })).toBeVisible();

      const blockingIssues = monitor.getIssues('P1');
      expect(blockingIssues, JSON.stringify(blockingIssues, null, 2)).toEqual([]);
    } catch (error) {
      actual = error instanceof Error ? error.message : 'Unknown conversation shell failure';
      monitor.addAssertionIssue(actual, 'P1');
      throw error;
    } finally {
      await writeFlowAudit(
        testInfo,
        {
          title: 'chat-conversation-shell',
          role: 'user',
          route: '/chat',
          expected: 'Chat page exposes the conversation list container or equivalent shell without blocking issues.',
        },
        actual,
        steps,
        monitor.getIssues(),
      );
    }
  });

  test('should send message and receive stream response', async ({ page }, testInfo) => {
    const steps: string[] = [];
    const monitor = createIssueMonitor(page);
    const prompt = `E2E smoke message ${Date.now()}`;
    let actual = 'Chat send flow completed';

    try {
      steps.push('Open /chat');
      await gotoWithBypass(page, '/chat');

      steps.push('Fill chat prompt');
      const input = page.locator('textarea[placeholder="请输入您的问题..."]');
      await input.fill(prompt);

      steps.push('Submit the prompt and wait for stream endpoint');
      const streamResponsePromise = page.waitForResponse(
        (response) =>
          response.url().includes('/api/ai/stream') &&
          response.request().method() === 'POST',
        { timeout: 20000 },
      );
      await page.getByRole('button', { name: '发送' }).click();
      const dismissedLowBalance = await dismissLowBalanceDialogIfVisible(page);
      if (dismissedLowBalance) {
        steps.push('Dismiss low-balance dialog and retry send');
        await page.getByRole('button', { name: '发送' }).click();
      }

      const streamResponse = await streamResponsePromise;
      expect(streamResponse.status()).toBe(200);

      steps.push('Verify user prompt is echoed into the conversation list');
      await expect(page.getByText(prompt).first()).toBeVisible({ timeout: 10000 });

      steps.push('Wait until the UI returns to idle after streaming');
      await expect(page.getByRole('button', { name: '发送' })).toBeVisible({ timeout: 60000 });

      const blockingIssues = monitor.getIssues('P1');
      expect(blockingIssues, JSON.stringify(blockingIssues, null, 2)).toEqual([]);
    } catch (error) {
      actual = error instanceof Error ? error.message : 'Unknown chat send failure';
      monitor.addAssertionIssue(actual, 'P0');
      throw error;
    } finally {
      await writeFlowAudit(
        testInfo,
        {
          title: 'chat-send-message',
          role: 'user',
          route: '/chat',
          expected: 'Authenticated users can send a prompt, hit /api/ai/stream successfully, and return to idle without blocking issues.',
        },
        actual,
        steps,
        monitor.getIssues(),
        ['If this fails, inspect model configuration, user credits, and stream route auth before changing UI logic.'],
      );
    }
  });

  test('should expose stop control during long-running stream', async ({ page }, testInfo) => {
    const steps: string[] = [];
    const monitor = createIssueMonitor(page);
    const prompt = '请按行输出数字 1 到 400，并在每行附带一句简短中文说明。';
    let actual = 'Stop control interrupted the stream';

    try {
      steps.push('Open /chat and start a long-running prompt');
      await gotoWithBypass(page, '/chat');
      const input = page.locator('textarea[placeholder="请输入您的问题..."]');
      await input.fill(prompt);
      await page.getByRole('button', { name: '发送' }).click();
      const dismissedLowBalance = await dismissLowBalanceDialogIfVisible(page);
      if (dismissedLowBalance) {
        steps.push('Dismiss low-balance dialog and retry send');
        await page.getByRole('button', { name: '发送' }).click();
      }

      steps.push('Wait for stop control and click it');
      const stopButton = page.getByRole('button', { name: '停止' });
      await expect(stopButton).toBeVisible({ timeout: 15000 });
      await stopButton.click();

      steps.push('Verify interrupted marker is rendered');
      await expect(page.getByText('[已中断]')).toBeVisible({ timeout: 10000 });

      // Stopping a stream intentionally aborts the underlying fetch request.
      monitor.removeIssues(
        (issue) =>
          issue.source === 'requestfailed' &&
          issue.message === 'net::ERR_ABORTED' &&
          issue.method === 'POST' &&
          issue.url?.includes('/api/ai/stream') === true,
      );

      const blockingIssues = monitor.getIssues('P1');
      expect(blockingIssues, JSON.stringify(blockingIssues, null, 2)).toEqual([]);
    } catch (error) {
      actual = error instanceof Error ? error.message : 'Unknown abort flow failure';
      monitor.addAssertionIssue(actual, 'P0');
      throw error;
    } finally {
      await writeFlowAudit(
        testInfo,
        {
          title: 'chat-abort-stream',
          role: 'user',
          route: '/chat',
          expected: 'Long-running chat responses expose the stop control and render an interrupted marker after abort.',
        },
        actual,
        steps,
        monitor.getIssues(),
      );
    }
  });
});
