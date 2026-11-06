/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, type Browser, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PRICE_COMPARE } from '@/lib/landing/landing-copy';
import { J_PRICE_TOTAL } from '@/lib/landing/landing-copy-j-price';

/*
 * The home page's price comparison ("正常方案要花多少钱", PriceJ in MotionJ as sample L uses it) in Chrome with motion on. Codex B3 on
 * staging 6a3ec003 read every amount as $0 ("$0–0/月（2024 年调查平均 $0）", "每月约 $0 起"): the count-up showed its numbers at 0
 * while waiting to play. The section must read the real amounts whenever it is read, before it is scrolled to, while it plays and
 * after, in a tab whose animation frames are held back too; only a number that is visibly counting may be below its value, and the
 * total's figure stays unseen until it counts (so it never shows its value and then drops to 0).
 */
let browser: Browser;
let code = '';
let css = '';
const entry = fileURLToPath(new URL('./__price_compare_fixture__.js', import.meta.url));
const src = fileURLToPath(new URL('../../../', import.meta.url));

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const vite = createRequire(require.resolve('vitest/package.json')).resolve('vite');
  const { build } = await import(pathToFileURL(vite).href);
  const bundle = await build({
    configFile: false, logLevel: 'silent', define: { 'process.env.NODE_ENV': JSON.stringify('development') },
    oxc: { jsx: { runtime: 'automatic' } }, resolve: { alias: { '@': src } },
    plugins: [{ name: 'price-compare-fixture', enforce: 'pre', resolveId(id: string) { if (id === entry) return id; }, load(id: string) {
      if (id === entry) return `import React from 'react'; import { createRoot } from 'react-dom/client';
        import { MotionJ } from ${JSON.stringify(src + 'components/landing/preview-j/MotionJ.tsx')};
        import { PriceJ } from ${JSON.stringify(src + 'components/landing/preview-j/PriceJ.tsx')};
        import { PRICE_COMPARE } from ${JSON.stringify(src + 'lib/landing/landing-copy.ts')};
        createRoot(document.getElementById('root')).render(React.createElement(MotionJ, null,
          React.createElement('div', { style: { height: '3000px' } }),
          React.createElement(PriceJ, { proMonthly: 29, rows: PRICE_COMPARE.rows, calm: true, plainTotal: true, checked: false, quiet: true })));`;
    } }],
    build: { write: false, minify: false, target: 'es2022', cssCodeSplit: false, rollupOptions: { input: entry, output: { format: 'es' } } },
  });
  const outputs = (Array.isArray(bundle) ? bundle : [bundle]).flatMap(item => item.output);
  code = outputs.find(item => item.type === 'chunk' && item.isEntry)?.code ?? '';
  css = outputs.filter(item => item.type === 'asset' && item.fileName.endsWith('.css')).map(item => String(item.source)).join('\n');
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch({ executablePath: existsSync(chrome) ? chrome : undefined });
}, 120_000);
afterAll(async () => { await browser?.close(); });

async function open(options: { holdFrames?: boolean } = {}): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.setContent(`<!doctype html><html><head><style>${css}</style></head><body><div id="root"></div></body></html>`);
  // A background tab or a capture tool: animation frames never come.
  if (options.holdFrames) await page.evaluate(() => { window.requestAnimationFrame = () => 0; });
  await page.addScriptTag({ type: 'module', content: code });
  await page.locator('#pricing').waitFor();
  return page;
}

const sectionText = (page: Page) => page.locator('#pricing').innerText();
const ZERO = /\$0(?![\d.,])|–0\//;

function expectRealAmounts(text: string) {
  for (const row of PRICE_COMPARE.rows) expect(text).toContain(row.price);
  expect(text).toContain(J_PRICE_TOTAL.text);
  expect(text).not.toMatch(ZERO);
}

describe('home page price comparison amounts (Codex B3)', () => {
  it('reads the real amounts before the comparison is scrolled to', async () => {
    const page = await open();
    try {
      await page.waitForTimeout(400);
      expectRealAmounts(await sectionText(page));
    } finally { await page.close(); }
  });

  it('counts up once scrolled to and ends on the real amounts; the total waits unseen until it counts', async () => {
    const page = await open();
    try {
      const total = page.locator('[data-region="Graylum 价格"] b').first();
      // Past its .3s fade (the page mounts at rest, then waits).
      await page.waitForTimeout(600);
      expect(await total.evaluate(node => getComputedStyle(node).opacity)).toBe('0');
      await page.locator('[data-region="费用对比表"]').scrollIntoViewIfNeeded();
      await page.waitForTimeout(3500);
      expectRealAmounts(await sectionText(page));
      expect(await total.evaluate(node => getComputedStyle(node).opacity)).toBe('1');
    } finally { await page.close(); }
  });

  it('reads the real amounts when animation frames never come', async () => {
    const page = await open({ holdFrames: true });
    try {
      await page.locator('#pricing').scrollIntoViewIfNeeded();
      await page.waitForTimeout(2500);
      expectRealAmounts(await sectionText(page));
    } finally { await page.close(); }
  });
});
