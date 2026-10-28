/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { expect, type Page } from '@playwright/test';

import { coreSql } from './db';
import { gotoWithBypass } from '../../support/deploymentProtection';
import type { SpendMeter } from './spend';
import { confirmStepWhenReady, sendAndWait, stepNav } from './ui';

/** One fixed persona, so every run says the same things and the coach's questions are predictable. */
export const PERSONA = {
  intro: '我叫小林，在上海做上班族快手晚餐博主，想把小红书做成副业收入。目标：6 个月内粉丝到 1 万，每月靠带货和接单赚到 3000 元。'
    + '赛道：15 分钟快手晚餐。目标用户：25-35 岁的上班族，下班晚、怕麻烦。平台：先做小红书，再做抖音。'
    + '资源：每周能拍 3 条，每条花 2 小时；有一台手机和一个小厨房。资产：已有 200 条做饭照片，没有粉丝。'
    + '没有明确的对标账号，请你帮我找。其他信息先按这些来，不确定的先标出来，不要追问太多。',
  keywordHint: '关键词请用你建议的，我都接受。',
  fill: '请按我已经说过的信息补全这一步，缺的先用合理假设并标注为待确认；不要再问我新问题。',
};

export async function startPositioning(page: Page): Promise<string> {
  await gotoWithBypass(page, '/app/positioning');
  await expect(page.getByRole('heading', { name: '今天，想推进什么？' })).toBeVisible();
  await page.getByRole('button', { name: '梳理账号定位' }).first().click();
  const dialog = page.getByRole('dialog', { name: '梳理账号定位' });
  await expect(dialog.getByRole('button', { name: '从头分析新定位' })).toBeEnabled({ timeout: 30_000 });
  await dialog.getByRole('button', { name: '从头分析新定位' }).click();
  await page.waitForURL(/\/app\/positioning\/[0-9a-f-]{36}$/, { timeout: 60_000 });
  return page.url();
}

/** Drives the coach until this step's confirm card is ready, then confirms it. Each extra turn is a paid call. */
export async function completeStep(page: Page, meter: SpendMeter, label: string, firstMessage: string, maxTurns = 4) {
  const ready = page.getByRole('region', { name: '本步确认' }).getByRole('button', { name: /^没问题，(进入下一步|确认这一步)$/ });
  let message = firstMessage;
  for (let turn = 1; turn <= maxTurns; turn += 1) {
    if (await ready.isVisible()) break;
    await sendAndWait(page, message, meter, `${label} turn ${turn}`);
    message = PERSONA.fill;
  }
  await confirmStepWhenReady(page);
}

/**
 * The benchmark step: the coach searches (a paid research call), the user confirms the keyword card and the candidate
 * card, and the benchmark table fills. Qualification comes from the server's `数据条件达标` flag; relevance is ignored.
 * If fewer than 3 qualify after the second round, the shortfall card appears and the existing benchmarks are used.
 */
export async function completeBenchmarkStep(page: Page, meter: SpendMeter) {
  await sendAndWait(page, '请帮我找对标账号。' + PERSONA.keywordHint, meter, 'benchmark ask');
  const keywordCard = page.locator('section[aria-label="关键词选择"]');
  await expect(keywordCard).toBeVisible({ timeout: 60_000 });
  await keywordCard.getByRole('button', { name: '确认关键词' }).click();
  await expect(keywordCard).toBeHidden({ timeout: 60_000 }).catch(() => undefined);
  const candidates = page.locator('section[aria-label="对标候选账号"], section[aria-label="补选对标账号"]').first();
  await expect(candidates).toBeVisible({ timeout: 240_000 });
  await meter.checkpoint('benchmark search');
  // Nothing is ticked at first and the button stays off until the card's minimum is reached: tick accounts until it turns on.
  const confirmChoice = candidates.getByRole('button', { name: '确认选择' });
  const boxes = candidates.getByRole('group', { name: '候选账号' }).getByRole('checkbox');
  for (let i = 0; i < await boxes.count() && !(await confirmChoice.isEnabled()); i += 1) {
    if (await boxes.nth(i).isEnabled()) await boxes.nth(i).check();
  }
  await expect(confirmChoice).toBeEnabled();
  await confirmChoice.click();
  const table = page.locator('section[aria-label="对标表"]');
  await expect(table).toBeVisible({ timeout: 240_000 });
  await meter.checkpoint('benchmark fetch');
  const qualified = table.getByText('数据条件达标', { exact: true });
  await expect(async () => expect(await qualified.count()).toBeGreaterThanOrEqual(1)).toPass({ timeout: 120_000 });
  const shortfall = page.locator('section[aria-label="对标不足时怎么办"]');
  if (await shortfall.isVisible().catch(() => false)) {
    await shortfall.getByRole('radio', { name: /^用现有 \d+ 个对标先生成报告/ }).check();
    await shortfall.getByRole('button', { name: '确认选择' }).click();
    await expect(page.locator('[data-selection-card="shortfall-confirmed"]')).toBeVisible({ timeout: 60_000 });
  }
}

/** Walks the three steps up to the point where the report can be generated. Returns the draft URL. */
export async function buildReadyDraft(page: Page, meter: SpendMeter): Promise<string> {
  const url = await startPositioning(page);
  await expect(stepNav(page).getByRole('button').first()).toBeVisible();
  await completeStep(page, meter, 'step 1', PERSONA.intro);
  await completeBenchmarkStep(page, meter);
  await completeStep(page, meter, 'step 2', '请根据对标结果给出可行性和平台选择，我同意你的建议。');
  await completeStep(page, meter, 'step 3', '请给出定位、资料包、第一个月计划和变现方案，我同意你的建议。');
  await expect(stepNav(page).getByRole('button').filter({ hasText: '✓' })).toHaveCount(3);
  return url;
}

/** How many reports this account has stopped in the last 24 hours (the third stop asks for confirmation). */
export async function stopsInLast24h(actorId: string): Promise<number> {
  const rows = await coreSql()<Array<{ n: string }>>`
    select count(*)::text as n from report_fees f
    where f.actor_id = ${actorId}::uuid and f.user_stopped_at > now() - interval '24 hours'`;
  return Number(rows[0]?.n ?? 0);
}
