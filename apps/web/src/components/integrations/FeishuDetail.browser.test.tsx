/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// INTEGRATION-BASE B2: the Feishu Base introduction, opened from its card, in a real browser with the app's CSS. Owner 2026-11-14:
// the wording of the approved draft, a drawn animation of "a work becomes one row of the table" instead of screenshots (played
// when the dialog opens, still with reduced motion), and 去查看 to Feishu's official Base page. Measured: every line can be read,
// nothing scrolls sideways on a phone, the animation runs and ends on the finished row, reduced motion shows that row at once.
import { chromium, type Browser, type Page } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { buildIntegrationsPage, openIntroduction } from './__tests__/browser-harness';

let browser: Browser;
let html = '';
beforeAll(async () => {
  html = await buildIntegrationsPage();
  browser = await chromium.launch({ headless: true });
}, 60000);
afterAll(async () => { await browser?.close(); }, 30000);

const open = (width: number, reducedMotion = false) =>
  openIntroduction(browser, html, 'ready', width, 780, { card: /飞书多维表格/, reducedMotion });

/** Words of the dialog and their contrast against the first painted ground behind them (WCAG 2.1; 4.5 is the floor). */
const lines = (page: Page) => page.getByRole('dialog').evaluate(dialog => {
  const rgb = (value: string) => (value.match(/[\d.]+/g) ?? []).map(Number);
  const light = (value: string) => {
    const [r = 0, g = 0, b = 0] = rgb(value).map(channel => { const c = channel / 255; return c <= .03928 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; });
    return .2126 * r + .7152 * g + .0722 * b;
  };
  const ground = (element: Element): string => {
    for (let node: Element | null = element; node; node = node.parentElement) {
      const value = getComputedStyle(node).backgroundColor;
      if ((rgb(value)[3] ?? 1) > .98) return value;
    }
    return 'rgb(255, 255, 255)';
  };
  return [...dialog.querySelectorAll<HTMLElement>('*')].filter(element => element.getClientRects().length
    && [...element.childNodes].some(node => node.nodeType === 3 && (node.textContent ?? '').trim())).map(element => {
    const [text, back] = [light(getComputedStyle(element).color), light(ground(element))];
    return { text: (element.textContent ?? '').trim().slice(0, 24), inArt: !!element.closest('[role=img]'),
      contrast: Math.round(((Math.max(text, back) + .05) / (Math.min(text, back) + .05)) * 10) / 10 };
  });
});
const freshRow = (page: Page) => page.getByRole('img', { name: /示意/ }).locator('div').last();

for (const width of [1280, 390]) {
  it(`at ${width}px: every line can be read once the animation has finished, nothing scrolls sideways, 去查看 is Feishu's page`, async () => {
    const { page, errors } = await open(width, true);
    try {
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('heading', { name: '飞书多维表格' }).waitFor();
      for (const line of await lines(page)) {
        // The drawing's own small words are part of the picture (it is named as a whole); still, they are readable.
        expect(line.contrast, `"${line.text}" cannot be read`).toBeGreaterThanOrEqual(line.inArt ? 3 : 4.5);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
      const art = await page.getByRole('img', { name: /示意/ }).boundingBox();
      const box = await dialog.boundingBox();
      expect(art!.x + art!.width).toBeLessThanOrEqual(box!.x + box!.width + 1);
      expect(await dialog.locator('footer a').evaluateAll(list => list.map(link => [link.textContent, link.getAttribute('href')])))
        .toEqual([['去查看', 'https://www.feishu.cn/product/base']]);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 30000);
}

it('the animation plays when the dialog opens and rests on the finished row; reduced motion shows that row at once', async () => {
  let { page } = await open(1280);
  try {
    const running = await page.getByRole('img', { name: /示意/ }).evaluate(art =>
      art.getAnimations({ subtree: true }).map(animation => animation.playState));
    expect(running.length).toBeGreaterThan(0);
    expect(running.every(state => state === 'running')).toBe(true);
    await page.waitForFunction(() => document.querySelector('[role=img]')!.getAnimations({ subtree: true })
      .every(animation => animation.playState === 'finished'), undefined, { timeout: 12000 });
    expect(await freshRow(page).evaluate(row => getComputedStyle(row.firstElementChild!).color)).not.toBe('rgba(0, 0, 0, 0)');
  } finally { await page.close(); }
  ({ page } = await open(1280, true));
  try {
    expect(await page.getByRole('img', { name: /示意/ }).evaluate(art => art.getAnimations({ subtree: true }).length)).toBe(0);
    expect(await freshRow(page).evaluate(row => getComputedStyle(row.firstElementChild!).color)).not.toBe('rgba(0, 0, 0, 0)');
    await expect(freshRow(page).textContent()).resolves.toContain('咖啡店的三种拍法');
  } finally { await page.close(); }
}, 40000);
