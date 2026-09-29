/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { expect, test } from '@playwright/test';

const TEST_PROMPT = '请保留这段输入';

const localSession = {
  access_token: 'local-balance-test-access-token',
  refresh_token: 'local-balance-test-refresh-token',
  expires_at: 2524608000,
  expires_in: 3600,
  token_type: 'bearer',
  user: {
    id: '00000000-0000-4000-8000-000000000001',
    aud: 'authenticated',
    role: 'authenticated',
    email: 'local-balance-test@example.test',
    email_confirmed_at: '2026-01-01T00:00:00.000Z',
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: { email_verified: true },
    created_at: '2026-01-01T00:00:00.000Z',
  },
};

test.use({
  storageState: {
    cookies: [
      {
        name: 'sb-127-auth-token',
        value: `base64-${Buffer.from(JSON.stringify(localSession)).toString('base64url')}`,
        domain: 'localhost',
        path: '/',
        httpOnly: false,
        secure: false,
        sameSite: 'Lax',
        expires: 2524608000,
      },
    ],
    origins: [],
  },
});

function result(data: unknown) {
  return { result: { data } };
}

function mockedProcedureResult(procedure: string) {
  switch (procedure) {
    case 'settings.getSystemSettings':
      return {
        site_name: 'Graylum local test',
        chat_show_model_selector: false,
        max_input_characters: 2500,
        enable_free_tier: false,
        enable_long_text_warning: false,
        show_token_usage_stats: false,
      };
    case 'settings.getBannerAnnouncement':
      return null;
    case 'user.getUserProfile':
      return { role: 'user' };
    case 'chat.getExportPermissions':
      return { allowExport: false, allowBatchExport: false };
    case 'model.getActiveModels':
      return [];
    case 'chat.getConversations':
      return { data: [] };
    default:
      throw new Error(`Unmocked tRPC procedure: ${procedure}`);
  }
}

test('fails closed on an unavailable refetch and retries without losing the prompt', async ({ page }) => {
  let balanceRequestCount = 0;
  let failBalanceRefetch = false;
  let streamRequestCount = 0;

  await page.route('**/api/trpc/**', async (route) => {
    const url = new URL(route.request().url());
    const procedurePath = url.pathname.split('/api/trpc/')[1] ?? '';
    const procedures = procedurePath.split(',').filter(Boolean);

    if (procedures.includes('credits.getBalance')) {
      balanceRequestCount += 1;
      if (failBalanceRefetch) {
        await route.abort('failed');
        return;
      }
    }

    const payload = procedures.map((procedure) => result(
      procedure === 'credits.getBalance'
        ? { credits: 500, creditsExpiringSoon: 0, creditsExpiryDate: null }
        : mockedProcedureResult(procedure),
    ));

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(payload),
    });
  });

  await page.route('**/api/ai/stream', async (route) => {
    streamRequestCount += 1;
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: [
        `data: ${JSON.stringify({
          type: 'init',
          conversationId: '00000000-0000-4000-8000-000000000002',
          modelUsed: 'local-test-model',
        })}`,
        '',
        `data: ${JSON.stringify({ type: 'delta', content: '本地测试回复' })}`,
        '',
        `data: ${JSON.stringify({
          type: 'complete',
          conversationId: '00000000-0000-4000-8000-000000000002',
        })}`,
        '',
      ].join('\n'),
    });
  });

  await page.goto('/chat');
  await expect(page.getByText('500').first()).toBeVisible();

  await page.getByRole('button', { name: '打开用户菜单' }).click();
  await expect(page.getByRole('menuitem', { name: '充值积分' })).toBeVisible();
  await page.keyboard.press('Escape');

  const prompt = page.locator('textarea');
  await prompt.fill(TEST_PROMPT);
  failBalanceRefetch = true;
  await page.getByRole('button', { name: '发送' }).click();

  const unavailableDialog = page.getByRole('alertdialog');
  await expect(unavailableDialog.getByRole('heading', { name: '余额暂时无法验证' })).toBeVisible();
  await expect(unavailableDialog).toContainText('您的输入已保留');
  await expect(unavailableDialog).not.toContainText(/积分已用完|积分不足|充值|购买/);
  await expect(page.getByText('积分已用完', { exact: true })).toHaveCount(0);
  await expect(page.getByText('积分不足', { exact: true })).toHaveCount(0);
  await expect(page.getByText('立即充值', { exact: true })).toHaveCount(0);
  await expect(prompt).toHaveValue(TEST_PROMPT);
  expect(streamRequestCount).toBe(0);

  const requestsBeforeFailedRetry = balanceRequestCount;
  await unavailableDialog.getByRole('button', { name: '重试' }).click();
  await expect(unavailableDialog).toBeVisible();
  expect(balanceRequestCount).toBeGreaterThan(requestsBeforeFailedRetry);
  await expect(prompt).toHaveValue(TEST_PROMPT);
  expect(streamRequestCount).toBe(0);

  await unavailableDialog.getByRole('button', { name: '稍后再试' }).click();
  await page.getByRole('button', { name: '打开用户菜单' }).click();
  await expect(page.getByRole('menuitem', { name: '个人中心' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: '设置' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: '充值积分' })).toHaveCount(0);
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: '发送' }).click();
  await expect(unavailableDialog).toBeVisible();
  failBalanceRefetch = false;
  await unavailableDialog.getByRole('button', { name: '重试' }).click();

  await expect(prompt).toHaveValue('');
  await expect(page.getByText('本地测试回复')).toBeVisible();
  expect(streamRequestCount).toBe(1);

  const metricsResponse = await page.request.get('http://127.0.0.1:54321/metrics');
  expect(metricsResponse.ok()).toBe(true);
  const metrics = await metricsResponse.json() as {
    requests: Record<string, number>;
  };
  expect(metrics.requests['/auth/v1/user']).toBeGreaterThan(0);
  expect(metrics.requests['/rest/v1/system_settings']).toBeGreaterThan(0);
});
