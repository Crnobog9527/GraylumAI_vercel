/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { test, expect, type Browser, type Locator, type Page } from '@playwright/test';
import { authStatePaths, getCredentials, hasCredentials } from './support/auth';
import { safeCloseContext } from './support/contextCleanup';
import { gotoWithBypass } from './support/deploymentProtection';
import { createIssueMonitor, writeFlowAudit } from './support/monitoring';
import {
  isLocalPlaywrightBaseUrl,
  isRegionRestrictionIssue,
  probeShowsRegionRestriction,
  responseShowsRegionRestriction,
} from './support/runtimeConstraints';

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

type StreamProbeResult = {
  status: number;
  body: string;
  events: Array<Record<string, unknown>>;
};

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
    await page.locator('input[placeholder="奖励积分、退款等..."]').fill(`Ensure minimum chat credits ${Date.now()}`);

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
    await page.getByRole('button', { name: '刷新' }).click();
    await expect
      .poll(async () => readCreditsFromRow(targetRow), { timeout: 15000 })
      .toBeGreaterThanOrEqual(minimumCredits);
  } finally {
    await safeCloseContext(context);
  }
}

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
          // Ignore malformed upstream keepalive frames.
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

test.describe('AI Chat', () => {
  test.describe.configure({ mode: 'serial' });
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

  test('should require confirmation before sending oversized long text prompts', async ({ page }, testInfo) => {
    const steps: string[] = [];
    const monitor = createIssueMonitor(page);
    const oversizedPrompt = '测'.repeat(2200);
    let streamRequestCount = 0;
    let actual = 'Long text confirmation gate prevented immediate send';

    try {
      steps.push('Open /chat and prepare an oversized long-text prompt');
      await gotoWithBypass(page, '/chat');
      await page.on('request', (request) => {
        if (request.url().includes('/api/ai/stream') && request.method() === 'POST') {
          streamRequestCount += 1;
        }
      });

      const input = page.locator('textarea[placeholder="请输入您的问题..."]');
      await input.fill(oversizedPrompt);

      steps.push('Attempt to send and verify the long-text confirmation dialog appears before any stream request');
      await page.getByRole('button', { name: '发送' }).click();
      await expect(page.getByText('长文本发送确认')).toBeVisible({ timeout: 10000 });
      expect(streamRequestCount).toBe(0);

      steps.push('Dismiss the confirmation dialog without sending');
      await page.getByRole('button', { name: '再检查一下' }).click();
      await expect(page.getByText('长文本发送确认')).not.toBeVisible({ timeout: 10000 });

      const blockingIssues = monitor.getIssues('P1');
      expect(blockingIssues, JSON.stringify(blockingIssues, null, 2)).toEqual([]);
    } catch (error) {
      actual = error instanceof Error ? error.message : 'Unknown long-text confirmation failure';
      monitor.addAssertionIssue(actual, 'P1');
      throw error;
    } finally {
      await writeFlowAudit(
        testInfo,
        {
          title: 'chat-long-text-confirmation',
          role: 'user',
          route: '/chat',
          expected: 'Oversized prompts trigger a confirmation dialog before the browser sends /api/ai/stream.',
        },
        actual,
        steps,
        monitor.getIssues(),
      );
    }
  });

  test('should send message and receive stream response', async ({ browser, page }, testInfo) => {
    test.skip(isLocalPlaywrightBaseUrl(), 'Live chat streaming verification requires a deployed Vercel environment.');
    const steps: string[] = [];
    const monitor = createIssueMonitor(page);
    const prompt = `E2E smoke message ${Date.now()}`;
    let actual = 'Chat send flow completed';

    try {
      steps.push('Ensure the E2E user has enough credits for chat');
      await ensureUserCreditsAtLeast(browser, 100);

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
      if (isLocalPlaywrightBaseUrl() && await responseShowsRegionRestriction(streamResponse)) {
        steps.push('Detected provider region restriction in the local environment and treated it as a non-blocking verification constraint');
        monitor.removeIssues((issue) => isRegionRestrictionIssue(issue));
        actual = 'Skipped local send verification because the upstream model provider rejected the request by region';
        return;
      }
      expect(streamResponse.status()).toBe(200);

      steps.push('Verify user prompt is echoed into the conversation list');
      await expectUserMessageVisible(page, prompt);

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

  test('should emit route_upgraded for long realtime prompts that start on the assistant path', async ({ browser, page }, testInfo) => {
    test.skip(isLocalPlaywrightBaseUrl(), 'Live route-upgrade verification requires a deployed Vercel environment.');
    test.setTimeout(90000);
    const steps: string[] = [];
    const monitor = createIssueMonitor(page);
    const prompt = '查今天全球AI三条要闻及影响，仅回已阅。';
    let actual = 'Route upgrade stream event emitted for a realtime-heavy assistant candidate prompt';

    try {
      steps.push('Ensure the E2E user has enough credits for a direct stream probe');
      await ensureUserCreditsAtLeast(browser, 100);

      steps.push('Send a long realtime prompt directly to /api/ai/stream through the authenticated browser session');
      const probe = await streamChatEventsThroughAuthenticatedSession(page, prompt);
      if (isLocalPlaywrightBaseUrl() && probeShowsRegionRestriction(probe)) {
        steps.push('Detected provider region restriction in the local environment and treated the live route-upgrade probe as non-blocking');
        monitor.removeIssues((issue) => isRegionRestrictionIssue(issue));
        actual = 'Skipped local route-upgrade verification because the upstream model provider rejected the request by region';
        return;
      }
      expect(probe.status, probe.body).toBe(200);

      steps.push('Assert the SSE stream emitted init, route_upgraded, and complete events');
      const initEvent = probe.events.find((event) => event.type === 'init');
      const routeUpgradeEvent = probe.events.find((event) => event.type === 'route_upgraded');
      const completeEvent = probe.events.find((event) => event.type === 'complete');

      expect(initEvent, probe.body).toBeTruthy();
      expect(routeUpgradeEvent, probe.body).toBeTruthy();
      expect(completeEvent, probe.body).toBeTruthy();
      expect(String(routeUpgradeEvent?.modelUsed ?? '')).not.toEqual('');
      expect(String(completeEvent?.routingReason ?? '')).toContain('route_upgraded_preflight');

      const blockingIssues = monitor.getIssues('P1');
      expect(blockingIssues, JSON.stringify(blockingIssues, null, 2)).toEqual([]);
    } catch (error) {
      actual = error instanceof Error ? error.message : 'Unknown route-upgrade stream failure';
      monitor.addAssertionIssue(actual, 'P0');
      throw error;
    } finally {
      await writeFlowAudit(
        testInfo,
        {
          title: 'chat-route-upgrade-live-stream',
          role: 'user',
          route: '/api/ai/stream',
          expected: 'A long realtime prompt that initially matches the assistant path emits a live route_upgraded SSE event and completes successfully.',
        },
        actual,
        steps,
        monitor.getIssues(),
      );
    }
  });

  test('should expose stop control during long-running stream', async ({ browser, page }, testInfo) => {
    test.skip(isLocalPlaywrightBaseUrl(), 'Live stream-abort verification requires a deployed Vercel environment.');
    const steps: string[] = [];
    const monitor = createIssueMonitor(page);
    const prompt = '请按行输出数字 1 到 400，并在每行附带一句简短中文说明。';
    let actual = 'Stop control interrupted the stream';

    try {
      steps.push('Ensure the E2E user has enough credits for chat');
      await ensureUserCreditsAtLeast(browser, 100);

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

  test('should surface a visible error banner when the stream request fails', async ({ browser, page }, testInfo) => {
    const steps: string[] = [];
    const monitor = createIssueMonitor(page);
    const prompt = `Parity injected failure ${Date.now()}`;
    let actual = 'Injected stream failure displayed a recoverable error banner';

    try {
      steps.push('Ensure the E2E user has enough credits for chat');
      await ensureUserCreditsAtLeast(browser, 100);

      steps.push('Open /chat and inject a one-shot stream failure');
      await gotoWithBypass(page, '/chat');
      await page.route('**/api/ai/stream', async (route) => {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Injected parity failure' }),
        });
      }, { times: 1 });

      steps.push('Submit a prompt while the injected failure route is active');
      await page.locator('textarea[placeholder="请输入您的问题..."]').fill(prompt);
      await page.getByRole('button', { name: '发送' }).click();

      steps.push('Verify the user prompt remains visible and an error banner is rendered');
      await expectUserMessageVisible(page, prompt);
      await expect(page.getByText('Injected parity failure')).toBeVisible({ timeout: 10000 });
      await expect(page.getByRole('button', { name: '发送' })).toBeVisible({ timeout: 10000 });

      monitor.removeIssues(
        (issue) =>
          issue.source === 'response' &&
          issue.url?.includes('/api/ai/stream') === true &&
          issue.status === 500,
      );
      monitor.removeIssues(
        (issue) =>
          issue.source === 'console' &&
          issue.message.includes('Streaming error: Injected parity failure'),
      );
      monitor.removeIssues(
        (issue) =>
          issue.source === 'console' &&
          issue.message.includes('Failed to load resource: the server responded with a status of 500'),
      );

      const blockingIssues = monitor.getIssues('P1');
      expect(blockingIssues, JSON.stringify(blockingIssues, null, 2)).toEqual([]);
    } catch (error) {
      actual = error instanceof Error ? error.message : 'Unknown injected stream failure handling';
      monitor.addAssertionIssue(actual, 'P1');
      throw error;
    } finally {
      await writeFlowAudit(
        testInfo,
        {
          title: 'chat-injected-stream-failure',
          role: 'user',
          route: '/chat',
          expected: 'When the stream request fails, the chat UI keeps the user prompt, surfaces a visible error banner, and returns to idle.',
        },
        actual,
        steps,
        monitor.getIssues(),
        ['This flow intentionally injects a one-shot 500 response to validate user-visible error handling without depending on provider-side failures.'],
      );
    }
  });
});
