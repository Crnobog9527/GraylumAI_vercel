/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Phones (639px and below; Owner 2026-11-12, mobile plan A): the compare picker and the jury chooser rise from the bottom edge
// instead of sitting in the middle. The real components with the app's CSS (globals.css, Tailwind, their CSS modules) in a
// browser, with a stand-in for the server: where the sheet sits, that nothing scrolls sideways, that the main buttons stay
// reachable while the sheet scrolls, and that at desktop width the dialogs are what they were. The paywall's sheet is measured
// with the other paywall cases (paywall/paywallLight.browser.test.tsx). BOTTOM_SHEET_SHOTS=<dir> saves a screenshot of each sheet.
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import tailwind from '@tailwindcss/postcss';
import { chromium, type Browser, type Page } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';

let browser: Browser;
let code = '';
let css = '';
const entry = fileURLToPath(new URL('./__bottom_sheet_fixture__.js', import.meta.url));
const src = fileURLToPath(new URL('../../', import.meta.url));
const shots = process.env.BOTTOM_SHEET_SHOTS;
const MODELS = ['模型甲', '模型乙', '模型丙', '模型丁', '模型戊', '模型己'];
const STUBS: Record<string, string> = {
  '@/trpc/client': `
    const read = data => ({ useQuery: () => ({ data, isSuccess: true, isPending: false, isLoading: false, isError: false, error: null }) });
    const models = ${JSON.stringify(MODELS)}.map((name, index) => ({ id: 'm' + index, name }));
    export const trpc = {
      fusionCompare: { options: read({ enabled: true, minModels: 2, maxModels: 3, models, defaultModelIds: ['m0', 'm1'] }) },
      fusionReview: { mine: read([{ reviewId: 'r1', draftId: 'd1', state: 'completed', awaitingChoice: true, createdAt: '2026-11-10T00:00:00Z' }]) },
      opc: {
        library: read({ businesses: [{ name: '美国报税', accounts: [
          { projectId: 'p1', platform: 'xiaohongshu', account: '报税笔记', strategyDraftId: 'd1', items: [] },
          { projectId: 'p2', platform: 'douyin', account: '老陈讲税', strategyDraftId: 'd2', items: [] }] }] }),
        list: read({ drafts: [{ draftId: 'd1', state: 'published', currentVersion: 2 }, { draftId: 'd2', state: 'published', currentVersion: 1 }] }),
        businesses: read([]),
      },
    };`,
  '@/lib/turn-fusion': `export const estimateFusion = async () => ({ credits: 40, columns: [{ modelId: 'm0', credits: 20, usd: '0.2' },
    { modelId: 'm1', credits: 20, usd: '0.2' }], tooLarge: [], refundCapReached: false, overBudget: false });
    export const startCompare = () => { throw new Error('not started in this test'); };`,
  '@/components/paywall/ReportPaywallDialog': `export const ReportPaywallDialog = () => null;`,
  'next/link': `import React from 'react'; export default function Link({ prefetch, ...props }) { return React.createElement('a', props); }`,
};

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const { build } = await import(pathToFileURL(createRequire(require.resolve('vitest/package.json')).resolve('vite')).href);
  const file = (name: string) => JSON.stringify(fileURLToPath(new URL(name, import.meta.url)));
  const bundle = await build({
    configFile: false, logLevel: 'silent', define: { 'process.env.NODE_ENV': JSON.stringify('development'), 'process.env': '({})' },
    oxc: { jsx: { runtime: 'automatic' } }, css: { postcss: { plugins: [tailwind({ base: src })] } }, resolve: { alias: { '@': src } },
    plugins: [{ name: 'bottom-sheet-fixture', enforce: 'pre', resolveId(id: string) {
      if (id === entry) return id;
      const path = id.replace(/\.(tsx?|jsx?)$/, '');
      const key = Object.keys(STUBS).find(name => name === id || (name.startsWith('@/') && path.endsWith(name.slice(1))));
      if (key) return `\0stub:${key}`;
    }, load(id: string) {
      if (id.startsWith('\0stub:')) return STUBS[id.slice(6)];
      if (id !== entry) return;
      return `import React from 'react'; import { createRoot } from 'react-dom/client';
        import ${file('../../app/globals.css')};
        import { CompareHost } from ${file('../fusion-compare/ComparePicker.tsx')};
        import { askCompare } from ${file('../fusion-compare/compare-entry.ts')};
        import { JuryChooser } from ${file('../fusion-review/JuryChooser.tsx')};
        window.askCompare = askCompare;
        const views = {
          picker: () => React.createElement('main', null,
            React.createElement(CompareHost, { sessionId: 's1', question: '这周写什么选题', onStarted() {} })),
          chooser: () => React.createElement(JuryChooser, { onClose() {} }),
        };
        createRoot(document.getElementById('root')).render(React.createElement(views[window.__view]));`;
    } }],
    build: { write: false, minify: false, cssCodeSplit: false, lib: { entry, name: 'BottomSheetTest', formats: ['iife'] } },
  });
  const output: { type: string; fileName: string; code?: string; source?: string }[] = Array.isArray(bundle) ? bundle[0].output : bundle.output;
  code = output.find(item => item.type === 'chunk')?.code ?? '';
  css = String(output.find(item => item.fileName.endsWith('.css'))?.source ?? '');
  browser = await chromium.launch({ headless: true });
  if (shots) mkdirSync(shots, { recursive: true });
}, 60000);
afterAll(async () => { await browser?.close(); }, 30000);

async function open(view: 'picker' | 'chooser', width: number, height = 760, reducedMotion = false): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width, height }, reducedMotion: reducedMotion ? 'reduce' : 'no-preference' });
  page.setDefaultTimeout(8000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.abort());
  await page.setContent(`<!doctype html><html lang="zh-Hans"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<style>${css}</style></head><body><div id="root"></div></body></html>`);
  await page.evaluate(name => { (window as unknown as { __view: string }).__view = name; }, view);
  await page.addScriptTag({ content: code });
  if (view === 'picker') {
    // The host registers after its first render; the rail's entry is what asks it.
    await page.waitForFunction(() => (window as unknown as { askCompare: () => boolean }).askCompare());
  }
  await page.getByRole('dialog').waitFor();
  // Past the rise, so the sheet is measured where it rests.
  await page.waitForFunction(() => document.querySelector('[role=dialog]')!.getAnimations().every(animation => animation.playState === 'finished'));
  return { page, errors };
}

const sheet = (page: Page) => page.getByRole('dialog').evaluate(dialog => {
  const box = dialog.getBoundingClientRect();
  const style = getComputedStyle(dialog);
  return { left: Math.round(box.left), right: Math.round(box.right), top: Math.round(box.top), bottom: Math.round(box.bottom),
    topRadius: style.borderTopLeftRadius, bottomRadius: style.borderBottomLeftRadius, animation: style.animationName,
    width: innerWidth, height: innerHeight, sideways: document.documentElement.scrollWidth - innerWidth, inner: dialog.scrollWidth - dialog.clientWidth };
});

for (const view of ['picker', 'chooser'] as const) for (const width of [390, 360]) {
  it(`${view} at ${width}px: a sheet on the bottom edge, as wide as the screen, rounded on top only, nothing scrolls sideways`, async () => {
    const { page, errors } = await open(view, width);
    try {
      if (shots) await page.screenshot({ path: `${shots}/${view}-${width}.png` });
      const measured = await sheet(page);
      expect([measured.left, measured.right, measured.bottom]).toEqual([0, measured.width, measured.height]);
      expect(measured.top, 'the page behind stays visible above the sheet').toBeGreaterThanOrEqual(28);
      expect([measured.topRadius, measured.bottomRadius]).toEqual(['24px', '0px']);
      expect(measured.sideways, 'the page scrolls sideways').toBeLessThanOrEqual(0);
      expect(measured.inner, 'the sheet scrolls sideways').toBeLessThanOrEqual(0);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 30000);
}

it('picker on a phone: 取消 and 开始对比 share one row of 48px buttons, the main one wider and on the thumb side', async () => {
  const { page, errors } = await open('picker', 390);
  try {
    const cancel = await page.getByRole('button', { name: '取消' }).boundingBox();
    const start = await page.getByRole('button', { name: '开始对比' }).boundingBox();
    expect(Math.round(cancel!.y)).toBe(Math.round(start!.y));
    expect(cancel!.height).toBeGreaterThanOrEqual(48);
    expect(start!.height).toBeGreaterThanOrEqual(48);
    expect(start!.x).toBeGreaterThan(cancel!.x);
    expect(start!.width).toBeGreaterThan(cancel!.width * 1.6);
    expect(Math.round(760 - (start!.y + start!.height)), 'the space under the buttons').toBe(16);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 30000);

it('picker on a short phone screen: the sheet scrolls inside and the two buttons stay at its bottom the whole way', async () => {
  const { page, errors } = await open('picker', 360, 480);
  try {
    const dialog = page.getByRole('dialog');
    const scrolls = await dialog.evaluate(element => element.scrollHeight - element.clientHeight);
    expect(scrolls, 'six models do not fit a 480px screen').toBeGreaterThan(40);
    const place = async () => Math.round((await page.getByRole('button', { name: '开始对比' }).boundingBox())!.y);
    const top = await place();
    expect(top + 48, 'the button is on screen before any scrolling').toBeLessThanOrEqual(480);
    await dialog.evaluate(element => { element.scrollTop = element.scrollHeight / 2; });
    expect(await place()).toBe(top);
    await dialog.evaluate(element => { element.scrollTop = element.scrollHeight; });
    expect(await place()).toBe(top);
    // The last model can be scrolled clear of the buttons.
    const last = await page.getByText('模型己').boundingBox();
    expect(last!.y + last!.height).toBeLessThanOrEqual(top);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 30000);

it('chooser on a phone: each report is a row of at least 44px', async () => {
  const { page, errors } = await open('chooser', 360);
  try {
    for (const name of [/报税笔记/, /老陈讲税/]) {
      expect((await page.getByRole('link', { name }).first().boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 30000);

for (const view of ['picker', 'chooser'] as const) {
  it(`${view} at 1280px: still the centred dialog with the 18px radius`, async () => {
    const { page, errors } = await open(view, 1280);
    try {
      const measured = await sheet(page);
      expect(measured.left).toBeGreaterThan(200);
      expect(measured.right).toBeLessThan(measured.width - 200);
      expect(measured.bottom).toBeLessThan(measured.height - 40);
      expect([measured.topRadius, measured.bottomRadius]).toEqual(['18px', '18px']);
      expect(Math.abs((measured.left + measured.right) / 2 - measured.width / 2)).toBeLessThanOrEqual(1);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 30000);
}

it('reduced motion on a phone: the sheet is simply there, without the rise or the dialog\'s zoom', async () => {
  const { page, errors } = await open('chooser', 390, 760, true);
  try {
    const measured = await sheet(page);
    expect(measured.animation).toBe('none');
    expect(measured.bottom).toBe(measured.height);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 30000);
