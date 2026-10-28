/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { expect, type Locator, type Page } from '@playwright/test';

import type { SpendMeter } from './spend';

/** The user's credit balance, read the way the app reads it (credits.getBalance), not from rendered text. */
export async function readCredits(page: Page): Promise<number> {
  const body = await page.evaluate(async () => {
    const response = await fetch('/api/trpc/credits.getBalance', { credentials: 'include' });
    return { status: response.status, json: await response.json().catch(() => null) };
  });
  const credits = (body.json as { result?: { data?: { credits?: number } } } | null)?.result?.data?.credits;
  if (body.status !== 200 || typeof credits !== 'number') throw new Error(`Could not read the credit balance (HTTP ${body.status}).`);
  return credits;
}

/** The composer is a ProseMirror editor: type into it, never fill(). */
export const chatBox = (page: Page): Locator => page.getByRole('textbox', { name: '给 AI 教练的回复' });
export const sendButton = (page: Page): Locator => page.getByRole('button', { name: '发送', exact: true });
const assistantMessages = (page: Page) => page.locator('[data-message-role="assistant"]');
const stopNotice = (page: Page) => page.getByRole('button', { name: '停止', exact: true });

/**
 * Sends one message to the coach and waits until the reply is finished: a new assistant message exists, the stop button
 * is gone and the composer accepts input again. There is no single test id for "done", so all three are required.
 */
export async function sendAndWait(page: Page, text: string, meter?: SpendMeter, label = 'turn', timeoutMs = 150_000) {
  const before = await assistantMessages(page).count();
  const box = chatBox(page);
  await box.click();
  await page.keyboard.insertText(text);
  await expect(sendButton(page)).toBeEnabled();
  await sendButton(page).click();
  await expect(async () => {
    expect(await assistantMessages(page).count()).toBeGreaterThan(before);
    await expect(stopNotice(page)).toHaveCount(0);
    await expect(sendButton(page)).toBeDisabled(); // empty composer: the send button is off until the next input
  }).toPass({ timeout: timeoutMs, intervals: [1000, 2000, 3000] });
  await expect(page.getByText('回复尚未完成')).toHaveCount(0);
  if (meter) await meter.checkpoint(label);
}

export const stepNav = (page: Page) => page.getByRole('navigation', { name: '定位步骤' });

/** Waits for the confirm card to say the step is ready, then confirms it. The card ignores clicks for 2 s after it changes. */
export async function confirmStepWhenReady(page: Page, timeoutMs = 120_000) {
  const card = page.getByRole('region', { name: '本步确认' });
  const confirm = card.getByRole('button', { name: /^没问题，(进入下一步|确认这一步)$/ });
  await expect(confirm).toBeVisible({ timeout: timeoutMs });
  await page.waitForTimeout(2500);
  await confirm.click();
  // The page either moves on to the next step or marks this one confirmed.
  await expect(page.getByRole('heading', { name: /· 已确认$/ }).first()).toBeVisible({ timeout: 60_000 });
}

export const currentStepHeading = (page: Page) => page.getByRole('heading', { name: /^\d+\. .* · (待确认|已确认)$/ });
