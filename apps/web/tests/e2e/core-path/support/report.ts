/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { expect, type Locator, type Page } from '@playwright/test';

import { readCredits } from './ui';

export const REPORT_PRICE = 500;
export const reportDialog = (page: Page): Locator => page.getByRole('dialog', { name: '完整运营策略报告' });

/** Opens the report dialog from the page footer and starts generation through the 500-credit confirm. */
export async function startReport(page: Page, acceptCredits = REPORT_PRICE) {
  const footerButton = page.getByRole('button', { name: /^(生成完整报告（[\d,]+ 积分）|重新生成)$/ });
  await footerButton.first().click();
  const dialog = reportDialog(page);
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: /生成完整报告|重新生成/ }).first().click();
  const confirm = dialog.getByRole('group', { name: '确认扣费' });
  await expect(confirm).toContainText(`确认后将扣除 ${acceptCredits} 积分`);
  await confirm.getByRole('button', { name: `确认并扣 ${acceptCredits} 积分` }).click();
  await expect(dialog.getByText('正在写报告…').first()).toBeVisible({ timeout: 90_000 });
}

export const stopButton = (page: Page): Locator => reportDialog(page).getByRole('button', { name: '停止', exact: true });

/** Waits until the balance is back to `expected` (the full refund of a stopped report), polling the real balance. */
export async function expectBalanceBack(page: Page, expected: number, timeoutMs = 60_000) {
  await expect.poll(() => readCredits(page), { timeout: timeoutMs, intervals: [2000, 3000, 5000] }).toBe(expected);
}

export async function waitForReportDone(page: Page, timeoutMs = 600_000) {
  await expect(reportDialog(page).getByRole('button', { name: '定稿', exact: true })).toBeVisible({ timeout: timeoutMs });
}

export async function expectThirteenChapters(page: Page) {
  const outline = reportDialog(page).getByRole('navigation', { name: '报告目录' });
  await expect(outline).toBeVisible();
  await expect(outline.getByRole('listitem')).toHaveCount(13);
}

export async function finalizeReport(page: Page) {
  const dialog = reportDialog(page);
  await dialog.getByRole('button', { name: '定稿', exact: true }).click();
  await expect(dialog.getByText('定稿后这份报告成为正式定位版本，之后不能再修改。确定定稿吗？')).toBeVisible();
  await dialog.getByRole('button', { name: '确定定稿' }).click();
  await expect(dialog.getByText(/报告已定稿，成为正式定位/)).toBeVisible({ timeout: 60_000 });
  await expect(dialog.getByRole('button', { name: '定稿', exact: true })).toHaveCount(0);
}
