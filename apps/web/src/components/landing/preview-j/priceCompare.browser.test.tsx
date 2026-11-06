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
 * total's figure stays unseen until it counts (so it never shows its value and then drops to 0). With LANDING_PROMO_OFFERS on the
 * Gold first-month line sits in our price box, readable, at desktop and phone widths.
 */
let browser: Browser;
let code = '';
let css = '';
const entry = fileURLToPath(new URL('./__price_compare_fixture__.js', import.meta.url));
const src = fileURLToPath(new URL('../../../', import.meta.url));
/** PRICE_COMPARE_SHOTS=<dir> saves our price box with the offer line at each width. */
const shots = process.env.PRICE_COMPARE_SHOTS;

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
        import page from ${JSON.stringify(src + 'components/landing/preview-j/j.module.css')};
        // The page's tokens (--j-ink, --j-muted) live on sample J's page class, as SampleL applies it.
        createRoot(document.getElementById('root')).render(React.createElement(MotionJ, { className: page.page },
          React.createElement('div', { style: { height: '3000px' } }),
          React.createElement(PriceJ, { proMonthly: 29, rows: PRICE_COMPARE.rows, calm: true, plainTotal: true, checked: false, quiet: true,
            offer: window.__offer ?? null })));`;
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

async function open(options: { holdFrames?: boolean; offer?: string; width?: number; still?: boolean } = {}): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: options.width ?? 390, height: 844 },
    reducedMotion: options.still ? 'reduce' : 'no-preference' });
  await page.setContent(`<!doctype html><html><head><style>${css}</style></head><body><div id="root"></div></body></html>`);
  if (options.offer) await page.evaluate(offer => { (window as unknown as { __offer: string }).__offer = offer; }, options.offer);
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

  // Owner 2026-11-06 "A：显示": with LANDING_PROMO_OFFERS on, sample L shows the Gold first month under our price.
  for (const width of [1280, 390]) {
    it(`shows the Gold first-month line inside our price box at ${width}px, readable and without sideways scrolling`, async () => {
      const line = 'Gold 新用户首月 $49，之后每月 $69';
      // The layout at rest (reduced motion: the box is simply there); with motion it is the same box, risen.
      const page = await open({ offer: line, width, still: true });
      try {
        await page.locator('[data-region="Graylum 价格"]').scrollIntoViewIfNeeded();
        const offer = page.locator('[data-offer]');
        expect(await offer.innerText()).toBe(line);
        const box = await offer.evaluate(node => {
          const own = node.parentElement!.getBoundingClientRect(), rect = node.getBoundingClientRect(), style = getComputedStyle(node);
          return { inside: rect.left >= own.left && rect.right <= own.right + 0.5, width: rect.width, size: style.fontSize, color: style.color,
            opacity: getComputedStyle(node.parentElement!).opacity, overflow: document.documentElement.scrollWidth - window.innerWidth };
        });
        expect(box.inside).toBe(true);
        expect(box.width).toBeGreaterThan(0);
        expect(box.size).toBe('15px');
        // Ink on the warm box (#141312 on #fff6e0 is far above 4.5:1).
        expect(box.color).toBe('rgb(20, 19, 18)');
        expect(box.opacity).toBe('1');
        expect(box.overflow).toBeLessThanOrEqual(0);
        if (shots) await page.locator('[data-region="Graylum 价格"]').screenshot({ path: `${shots}/price-offer-${width}.png` });
      } finally { await page.close(); }
    });
  }
});
