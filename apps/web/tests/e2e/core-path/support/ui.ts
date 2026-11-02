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

export interface ReportSettlement { executionId: string; consumedCredits: number; refundedCredits: number; nominalReserved: number; outcome: string; createdAt: string }

/**
 * The newest report settlement in the user's credit ledger (credits.getCreditTransactions): what the stopped report really
 * consumed and what was given back. The balance alone cannot tell it, because the 500 hold leaves the balance before the refund
 * comes back.
 */
export async function latestReportSettlement(page: Page): Promise<ReportSettlement | null> {
  const input = encodeURIComponent(JSON.stringify({ limit: 20, actualOnly: true }));
  const body = await page.evaluate(async query => (await fetch(`/api/trpc/credits.getCreditTransactions?input=${query}`, { credentials: 'include' })).json(), input);
  const items = ((body as { result?: { data?: { items?: Array<{ created_at: string; metadata?: Record<string, unknown> }> } } }).result?.data?.items) ?? [];
  const entry = items.find(item => item.metadata?.sourceType === 'report' && typeof item.metadata?.consumedCredits === 'number');
  if (!entry?.metadata) return null;
  const { consumedCredits, refundedCredits, nominalReserved, outcome, executionId } = entry.metadata as Record<string, number | string>;
  return { executionId: String(executionId ?? ''), consumedCredits: Number(consumedCredits), refundedCredits: Number(refundedCredits ?? 0), nominalReserved: Number(nominalReserved ?? 0),
    outcome: String(outcome ?? ''), createdAt: entry.created_at };
}

/** The composer is a ProseMirror editor: type into it, never fill(). */
export const chatBox = (page: Page): Locator => page.getByRole('textbox', { name: '给 AI 教练的回复' });
export const sendButton = (page: Page): Locator => page.getByRole('button', { name: '发送', exact: true });
const assistantMessages = (page: Page) => page.locator('[data-message-role="assistant"]');
const stopNotice = (page: Page) => page.getByRole('button', { name: '停止', exact: true });
/** The coach's progress notices under a reply; while any is showing the turn is not finished and the composer is locked. */
const turnNotice = (page: Page) => page.getByText(/^(正在查阅方法资料|正文已返回，正在整理|正在保存结果并核对费用|正在回复|正在思考|正在写回复|正在想怎么回复)/);

/**
 * The page starts turns of its own: the coach's opening of a step (after the draft is created and after each confirm). Wait
 * for it to show up (it can take a few seconds) and then to finish, so the next message is not typed into a locked composer.
 */
export async function settleOpening(page: Page, timeoutMs = 150_000) {
  await turnNotice(page).first().waitFor({ state: 'visible', timeout: 15_000 }).catch(() => undefined);
  await expect(turnNotice(page)).toHaveCount(0, { timeout: timeoutMs });
  await expect(stopNotice(page)).toHaveCount(0);
}

/**
 * Sends one message to the coach and waits until the reply is finished: a new assistant message exists, the stop button
 * is gone and the composer accepts input again. There is no single test id for "done", so all three are required.
 */
export async function sendAndWait(page: Page, text: string, meter?: SpendMeter, label = 'turn', timeoutMs = 150_000) {
  await settleOpening(page, timeoutMs);
  const before = await assistantMessages(page).count();
  const box = chatBox(page);
  await box.click();
  await page.keyboard.insertText(text);
  await expect(sendButton(page)).toBeEnabled();
  await sendButton(page).click();
  await expect(async () => {
    expect(await assistantMessages(page).count()).toBeGreaterThan(before);
    await expect(stopNotice(page)).toHaveCount(0);
    await expect(turnNotice(page)).toHaveCount(0);
    await expect(sendButton(page)).toBeDisabled(); // empty composer: the send button is off until the next input
  }).toPass({ timeout: timeoutMs, intervals: [1000, 2000, 3000] });
  await expect(page.getByText('回复尚未完成')).toHaveCount(0);
  if (meter) await meter.checkpoint(label);
}

export const stepNav = (page: Page) => page.getByRole('navigation', { name: '定位步骤' });

const confirmedSteps = async (page: Page) =>
  (await stepNav(page).getByRole('button').allInnerTexts()).filter(text => text.trim().startsWith('✓')).length;

/**
 * Waits for the confirm card to say the step is ready, then confirms it. The card ignores clicks for 2 s after it changes.
 * Done means one more step shows "✓" in the step strip: the page moves on to the next step by itself, so the heading of
 * the confirmed step is gone by then.
 */
export async function confirmStepWhenReady(page: Page, timeoutMs = 120_000) {
  const card = page.getByRole('region', { name: '本步确认' });
  const confirm = card.getByRole('button', { name: /^没问题，(进入下一步|确认这一步)$/ });
  await expect(confirm).toBeVisible({ timeout: timeoutMs });
  const before = await confirmedSteps(page);
  await page.waitForTimeout(2500);
  await confirm.click();
  await expect.poll(() => confirmedSteps(page), { timeout: 60_000, intervals: [1000, 2000] }).toBe(before + 1);
}

export const currentStepHeading = (page: Page) => page.getByRole('heading', { name: /^\d+\. .* · (待确认|已确认)$/ });
