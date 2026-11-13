/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// A product's introduction, opened from its card on the integrations page, in a real browser with the app's CSS (globals.css,
// Tailwind, the CSS modules) and a stand-in for the server. Why it is measured (Owner 2026-11-13, a screenshot of the first
// version): the dialog was the dark one with the light page's dark grey words on it, and the state box had white words on a
// cream ground, so most of it could not be read; and there was no mark of the product. So: every line of words is read against
// what is behind it, in each of the four states; the mark is a picture that loaded; on a phone it is a sheet with its head and
// its two links in place while the middle scrolls. INTEGRATION_SHOTS=<dir> saves a screenshot of each state.
import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import tailwind from '@tailwindcss/postcss';
import { chromium, expect as ui, type Browser, type Page } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';

let browser: Browser;
let html = '';
const shots = process.env.INTEGRATION_SHOTS;
const entry = fileURLToPath(new URL('./__integration_detail_fixture__.js', import.meta.url));
const src = fileURLToPath(new URL('../../', import.meta.url));
const PUBLIC = fileURLToPath(new URL('../../../public', import.meta.url));
const STUBS: Record<string, string> = {
  '@/trpc/client': `
    import { useState } from 'react';
    export const trpc = { useUtils: () => ({ connectors: { shotvivaStatus: { invalidate() {} } } }),
      connectors: { shotvivaStatus: { useQuery: () => window.__status },
        shotvivaDisconnect: { useMutation: () => {
          const [isError, setError] = useState(false);
          return { isPending: false, isError, mutate(_input, options) { window.__disconnects = (window.__disconnects || 0) + 1;
            setError(true); options?.onSettled?.(); } };
        } } } };`,
  '@/trpc/read-retry': `export const READ_RETRY = {};`,
  'next/link': `import { createElement } from 'react'; export default function Link({ prefetch, ...props }) { return createElement('a', props); }`,
};
const BALANCE = { credits: 12, freeCredits: 3, paidUntil: null, topUpUrl: 'https://shotviva.com/pricing?from=graylum' };
const STATES = {
  off: { available: false, eligible: true, connected: false, balance: null },
  members: { available: true, eligible: false, connected: false, balance: null },
  ready: { available: true, eligible: true, connected: false, balance: null },
  connected: { available: true, eligible: true, connected: true, balance: BALANCE },
} as const;
type StateName = keyof typeof STATES | 'loading' | 'failed';

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const { build } = await import(pathToFileURL(createRequire(require.resolve('vitest/package.json')).resolve('vite')).href);
  const file = (name: string) => JSON.stringify(fileURLToPath(new URL(name, import.meta.url)));
  const bundle = await build({
    configFile: false, logLevel: 'silent', define: { 'process.env.NODE_ENV': JSON.stringify('development'), 'process.env': '({})' },
    oxc: { jsx: { runtime: 'automatic' } }, css: { postcss: { plugins: [tailwind({ base: src })] } }, resolve: { alias: { '@': src } },
    plugins: [{ name: 'integration-detail-fixture', enforce: 'pre', resolveId(id: string) {
      if (id === entry) return id;
      const path = id.replace(/\.(tsx?|jsx?)$/, '');
      const key = Object.keys(STUBS).find(name => name === id || (name.startsWith('@/') && path.endsWith(name.slice(1))));
      if (key) return `\0stub:${key}`;
    }, load(id: string) {
      if (id.startsWith('\0stub:')) return STUBS[id.slice(6)];
      if (id !== entry) return;
      // The page as the workbench shows it: the light, warm canvas the cards sit on.
      return `import React from 'react'; import { createRoot } from 'react-dom/client';
        import ${file('../../app/globals.css')};
        import { IntegrationsView } from ${file('./IntegrationsView.tsx')};
        createRoot(document.getElementById('root')).render(React.createElement('div', { style: { height: '100vh', background: '#f7f5f1' } },
          React.createElement(IntegrationsView, { result: {} })));`;
    } }],
    build: { write: false, minify: false, cssCodeSplit: false, lib: { entry, name: 'IntegrationDetailTest', formats: ['iife'] } },
  });
  const output: { type: string; fileName: string; code?: string; source?: string }[] = Array.isArray(bundle) ? bundle[0].output : bundle.output;
  const code = output.find(item => item.type === 'chunk')?.code ?? '';
  const css = String(output.find(item => item.fileName.endsWith('.css'))?.source ?? '');
  html = `<!doctype html><html lang="zh-Hans"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<style>${css}</style></head><body style="margin:0"><div id="root"></div><script>${code.replace(/<\/script/g, '<\\/script')}</script></body></html>`;
  browser = await chromium.launch({ headless: true });
  if (shots) mkdirSync(shots, { recursive: true });
}, 60000);
afterAll(async () => { await browser?.close(); }, 30000);

/** The integrations page with Shotviva in the given state, and its introduction opened from its card. */
async function open(state: StateName, width: number, height = 780): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width, height } });
  page.setDefaultTimeout(8000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/app/integrations') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
    // The two marks, as the app serves them from its public folder.
    if (path === '/integrations/shotviva.png' || path === '/graylum-logo.png') {
      return route.fulfill({ contentType: 'image/png', body: readFileSync(PUBLIC + path) });
    }
    return route.abort();
  });
  const status = state === 'loading' ? { data: undefined, isLoading: true } : state === 'failed' ? { data: undefined, isLoading: false }
    : { data: STATES[state], isLoading: false };
  await page.addInitScript(value => { (window as unknown as { __status: unknown }).__status = value; }, status);
  await page.goto('https://app.test/app/integrations');
  await page.getByRole('button', { name: /Shotviva/ }).click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  await page.waitForFunction(() => document.querySelector('[role=dialog]')!.getAnimations().every(animation => animation.playState === 'finished'));
  // The click leaves the keyboard's focus ring on the close button; a person who clicked with a mouse does not see one.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  return { page, errors };
}

/**
 * Every element of the dialog that has words of its own: the words, and their contrast against the first painted ground behind
 * them (WCAG 2.1 relative luminance; 4.5 is the floor for text of this size).
 */
const words = (page: Page) => page.getByRole('dialog').evaluate(dialog => {
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
    && [...element.childNodes].some(node => node.nodeType === 3 && (node.textContent ?? '').trim())
    && !element.closest('.sr-only')).map(element => {
    const [text, back] = [light(getComputedStyle(element).color), light(ground(element))];
    return { text: (element.textContent ?? '').trim().slice(0, 24), size: parseFloat(getComputedStyle(element).fontSize),
      contrast: Math.round(((Math.max(text, back) + .05) / (Math.min(text, back) + .05)) * 10) / 10 };
  });
});
const box = async (page: Page, selector: string) => {
  const rect = await page.locator(selector).first().boundingBox();
  return { top: Math.round(rect!.y), bottom: Math.round(rect!.y + rect!.height), left: Math.round(rect!.x), right: Math.round(rect!.x + rect!.width),
    height: Math.round(rect!.height) };
};
const ground = (page: Page, name: string, role: 'link' | 'button' = 'link') =>
  page.getByRole('dialog').getByRole(role, { name }).evaluate(element => getComputedStyle(element).backgroundColor);
const DARK = 'rgb(38, 38, 38)';
const WHITE = 'rgb(255, 255, 255)';

for (const state of ['off', 'members', 'ready', 'connected', 'loading', 'failed'] as const) for (const width of [1280, 390]) {
  it(`${state} at ${width}px: a white dialog on which every line can be read, with the product's mark beside its name`, async () => {
    const { page, errors } = await open(state, width);
    try {
      if (shots) await page.screenshot({ path: `${shots}/${state}-${width}.png` });
      const dialog = page.getByRole('dialog');
      expect(await dialog.evaluate(element => getComputedStyle(element).backgroundColor)).toBe(WHITE);
      const lines = await words(page);
      expect(lines.length).toBeGreaterThan(12);
      for (const line of lines) {
        expect(line.contrast, `"${line.text}" cannot be read`).toBeGreaterThanOrEqual(4.5);
        expect(line.size, `"${line.text}" is too small`).toBeGreaterThanOrEqual(13);
      }
      // The mark: Shotviva's own picture, loaded, in the dialog's head and on the card behind it.
      for (const scope of [dialog.locator('header'), page.locator('main')]) {
        const mark = scope.locator('img[src="/integrations/shotviva.png"]').first();
        expect(await mark.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth)).toBe(192);
      }
      expect(await dialog.getByRole('heading', { name: 'Shotviva' }).evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBe(20);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 30000);
}

it('the four states: what the connection says and offers, and which one action is the dark one', async () => {
  // Not open yet: nothing to press about the connection; 去购买 is the dialog's action.
  let { page } = await open('off', 1280);
  try {
    const dialog = page.getByRole('dialog');
    await ui(dialog.getByText('未连接：连接暂未开放，可以先去 Shotviva 看看。')).toBeVisible();
    await ui(dialog.getByRole('button', { name: '连接 Shotviva' })).toHaveCount(0);
    expect([await ground(page, '去查看'), await ground(page, '去购买')]).toEqual([WHITE, DARK]);
  } finally { await page.close(); }
  // Not a member: the membership page.
  ({ page } = await open('members', 1280));
  try {
    const dialog = page.getByRole('dialog');
    await ui(dialog.getByText('未连接：连接 Shotviva 是 Pro 和 Gold 会员的功能。')).toBeVisible();
    await ui(dialog.getByRole('link', { name: '查看会员' })).toHaveAttribute('href', '/app/profile?tab=subscription');
    await ui(dialog.getByRole('button', { name: '连接 Shotviva' })).toHaveCount(0);
    expect(await ground(page, '去购买')).toBe(DARK);
  } finally { await page.close(); }
  // Can connect: 连接 is the one dark action, so the two links at the foot are both plain.
  ({ page } = await open('ready', 1280));
  try {
    expect(await ground(page, '连接 Shotviva', 'button')).toBe(DARK);
    expect([await ground(page, '去查看'), await ground(page, '去购买')]).toEqual([WHITE, WHITE]);
    const links = page.getByRole('dialog').locator('footer a');
    expect(await links.evaluateAll(list => list.map(link => [link.textContent, link.getAttribute('target'), new URL((link as HTMLAnchorElement).href).search])))
      .toEqual([['去查看', '_blank', '?from=graylum&utm_source=graylum&utm_medium=integration&utm_campaign=shotviva&utm_content=view'],
        ['去购买', '_blank', '?from=graylum&utm_source=graylum&utm_medium=integration&utm_campaign=shotviva&utm_content=buy']]);
  } finally { await page.close(); }
  // Connected: the balance, Shotviva's own top-up page, and 断开 asked twice.
  ({ page } = await open('connected', 1280));
  try {
    const dialog = page.getByRole('dialog');
    await ui(dialog.getByText('已连接：剩余 12 积分，另有 3 免费积分')).toBeVisible();
    await ui(dialog.getByRole('link', { name: '去 Shotviva 充值' })).toHaveAttribute('href', BALANCE.topUpUrl);
    // The line between the two marks is joined, with a tick on it.
    await ui(dialog.locator('[data-linked=true] svg')).toBeVisible();
    await dialog.getByRole('button', { name: '断开' }).click();
    await ui(dialog.getByText('断开后，对话里就不能再用 Shotviva 出图了。')).toBeVisible();
    await dialog.getByRole('button', { name: '取消' }).click();
    await ui(dialog.getByText('断开后，对话里就不能再用 Shotviva 出图了。')).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __disconnects?: number }).__disconnects ?? 0)).toBe(0);
    await dialog.getByRole('button', { name: '断开' }).click();
    if (shots) await page.screenshot({ path: `${shots}/connected-confirm-1280.png` });
    await dialog.getByRole('button', { name: '确认断开' }).click();
    expect(await page.evaluate(() => (window as unknown as { __disconnects?: number }).__disconnects)).toBe(1);
    // A disconnect that failed is said, in words that can be read.
    await ui(dialog.getByRole('alert')).toHaveText('断开没有成功，请稍后再试。');
    for (const line of await words(page)) expect(line.contrast, `"${line.text}" cannot be read`).toBeGreaterThanOrEqual(4.5);
    expect(await ground(page, '去购买')).toBe(DARK);
  } finally { await page.close(); }
}, 60000);

for (const width of [390, 360]) {
  it(`${width}px: a sheet on the bottom edge; its head and its two links stay where they are while the middle scrolls`, async () => {
    const { page, errors } = await open('connected', width, 700);
    try {
      const dialog = await box(page, '[role=dialog]');
      expect([dialog.left, dialog.right, dialog.bottom]).toEqual([0, width, 700]);
      expect(dialog.top, 'the page behind stays visible above the sheet').toBeGreaterThanOrEqual(28);
      expect(await page.getByRole('dialog').evaluate(element => [getComputedStyle(element).borderTopLeftRadius,
        getComputedStyle(element).borderBottomLeftRadius])).toEqual(['24px', '0px']);
      const middle = page.getByRole('dialog').locator('header + div');
      expect(await middle.evaluate(element => element.scrollHeight - element.clientHeight), 'the introduction is longer than a phone').toBeGreaterThan(100);
      const before = [await box(page, '[role=dialog] header'), await box(page, '[role=dialog] footer')];
      await middle.evaluate(element => { element.scrollTop = element.scrollHeight; });
      if (shots) await page.screenshot({ path: `${shots}/connected-${width}-end.png` });
      expect([await box(page, '[role=dialog] header'), await box(page, '[role=dialog] footer')]).toEqual(before);
      // The two links: one row of 48px buttons, 去购买 wider and on the thumb side, clear of the bottom edge.
      const [view, buy] = [await box(page, '[role=dialog] footer a:first-child'), await box(page, '[role=dialog] footer a:last-child')];
      expect([view.top, view.height, buy.height]).toEqual([buy.top, 48, 48]);
      expect(buy.right - buy.left).toBeGreaterThan((view.right - view.left) * 1.6);
      expect(700 - buy.bottom).toBe(16);
      // What is pressed inside the sheet is thumb-sized too.
      for (const name of ['去 Shotviva 充值', '断开']) {
        const target = await page.getByRole('dialog').getByText(name, { exact: true }).boundingBox();
        expect(target!.height, name).toBeGreaterThanOrEqual(44);
      }
      // The last line of the introduction ends above the foot, not under it.
      const last = await page.getByRole('dialog').locator('li').last().boundingBox();
      expect(Math.round(last!.y + last!.height)).toBeLessThanOrEqual(before[1]!.top);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 30000);
}

it('1280px on a short screen: a centred dialog no wider than 600px; the close button, the head and the foot stay while it scrolls', async () => {
  const { page, errors } = await open('ready', 1280, 620);
  try {
    const dialog = await box(page, '[role=dialog]');
    expect(dialog.right - dialog.left).toBe(600);
    expect(Math.abs((dialog.left + dialog.right) / 2 - 640)).toBeLessThanOrEqual(1);
    expect([dialog.top >= 16, dialog.bottom <= 604]).toEqual([true, true]);
    expect(await page.getByRole('dialog').evaluate(element => getComputedStyle(element).borderTopLeftRadius)).toBe('18px');
    const middle = page.getByRole('dialog').locator('header + div');
    expect(await middle.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(100);
    const places = async () => [await box(page, '[role=dialog] header'), await box(page, '[role=dialog] footer'),
      await box(page, '[role=dialog] button:has(.sr-only)')];
    const before = await places();
    await middle.evaluate(element => { element.scrollTop = element.scrollHeight; });
    expect(await places()).toEqual(before);
    // On a computer a row is its name on the left and its lines on the right.
    const row = page.getByRole('dialog').locator('section').last();
    const [name, lines] = [await row.locator('h3').boundingBox(), await row.locator('ul').boundingBox()];
    expect(lines!.x).toBeGreaterThan(name!.x + name!.width);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 30000);
