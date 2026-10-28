/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { expect, test, type Page } from '@playwright/test';

import { gotoWithBypass } from '../../support/deploymentProtection';
import type { SpendMeter } from './spend';

export const runtimeBox = (page: Page) => page.getByRole('textbox', { name: '消息' });
const progress = (page: Page) => page.locator('ul[aria-label="这一轮的进度"]');

/** A free-chat turn is done when the progress list is gone, the composer is usable again and the reply is saved. */
export async function waitForRuntimeTurn(page: Page, timeoutMs = 150_000) {
  await expect(progress(page)).toHaveCount(0, { timeout: timeoutMs });
  await expect(page.getByRole('button', { name: '保存到成果夹' }).last()).toBeVisible({ timeout: 60_000 });
}

/** Starts a free conversation from the start page; returns the session id from the URL. */
export async function startFreeChat(page: Page, firstMessage: string): Promise<string> {
  await gotoWithBypass(page, '/app/positioning');
  const box = page.getByRole('textbox', { name: '新任务内容' });
  await box.click();
  await page.keyboard.insertText(firstMessage);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.waitForURL(/\/app\/runtime\?session=[0-9a-f-]{36}/, { timeout: 60_000 });
  return new URL(page.url()).searchParams.get('session')!;
}

/** The refusal a provider's rejection shows; it is free ("没有扣积分") and the product's own way of saying "try again". */
const unavailableNotice = (page: Page) => page.getByText('服务暂时不可用，没有扣积分。');

/**
 * Sends one message and waits for its reply. A provider rejection ("服务暂时不可用，没有扣积分") is an observed, free
 * outcome, so it is recorded as an annotation and the message is sent once more instead of failing a long journey on a
 * flaky supplier; a second rejection fails.
 */
export async function sendRuntimeMessage(page: Page, text: string, meter?: SpendMeter, label = 'chat turn') {
  const replies = page.getByRole('button', { name: /保存到成果夹|再存一段到成果夹/ });
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const before = await replies.count();
    const refusalsBefore = await unavailableNotice(page).count();
    await runtimeBox(page).click();
    await page.keyboard.insertText(text);
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect.poll(async () => (await replies.count() > before ? 'reply' : await unavailableNotice(page).count() > refusalsBefore ? 'refused' : 'waiting'),
      { timeout: 150_000, intervals: [1000, 2000] }).not.toBe('waiting');
    if ((await replies.count()) > before) break;
    test.info().annotations.push({ type: 'provider-rejected', description: `${label}: 服务暂时不可用，没有扣积分 (attempt ${attempt})` });
    expect(attempt, `${label} was refused twice`).toBeLessThan(2);
    await expect(progress(page)).toHaveCount(0, { timeout: 60_000 });
  }
  await expect(progress(page)).toHaveCount(0);
  if (meter) await meter.checkpoint(label);
}
