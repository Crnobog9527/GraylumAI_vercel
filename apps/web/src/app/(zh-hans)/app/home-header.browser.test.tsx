/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, type Browser } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';

/**
 * UI-UNIFY A4 validation on staging: the /app home header at 390px hid the credits link, but the handoff needs language, credits and the
 * avatar on the right on a phone. The real GlobalHeader with the home page's own CSS in Chrome: all three show, the header does not
 * overflow at 360px and nothing overlaps; the menu button (no rail to open here) stays hidden.
 * MOBILE-UX (Owner 2026-11-12, phone plan A): a phone goes round the product by its bottom bar, so the top bar's three links
 * (首页 / 对话 / 个人中心) no longer show under 640px; the logo stands at the left and the three on the right as before.
 */
let browser: Browser;
let page: string;

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const { build } = await import(pathToFileURL(createRequire(require.resolve('vitest/package.json')).resolve('vite')).href);
  const entry = fileURLToPath(new URL('./__home_header_fixture__.tsx', import.meta.url));
  const src = fileURLToPath(new URL('../../../', import.meta.url));
  const bundle = await build({
    configFile: false, logLevel: 'silent', define: { 'process.env': JSON.stringify({ NODE_ENV: 'development' }) },
    oxc: { jsx: { runtime: 'automatic' } },
    resolve: { alias: { '@': src } },
    plugins: [{ name: 'home-header-fixture', enforce: 'pre',
      resolveId(id: string) { if (id === entry) return id; if (id === 'next/link') return '\0next/link'; },
      load(id: string) {
        // Only the pieces that need the app are replaced: next/link renders a plain anchor.
        if (id === '\0next/link') return "import {createElement} from 'react'; export default function Link({href,children,prefetch,...rest}){return createElement('a',{href,...rest},children)}";
        if (id !== entry) return;
        return `import {createRoot} from 'react-dom/client';
          import {GlobalHeader} from '@/components/opc/rail-view';
          import styles from ${JSON.stringify(src + 'app/(zh-hans)/app/home.module.css')};
          const credits=new URLSearchParams(location.search).get('c')||'12,500';
          createRoot(document.getElementById('root')).render(<div className={styles.home}><GlobalHeader area="search" end={<div className={styles.headerEnd}>
            <button type="button" aria-label="语言" className={styles.language}>简</button><a href="/app/profile?tab=subscription">{credits} 积分</a>
            <a href="/app/profile" aria-label="个人中心" className={styles.avatar}>L</a></div>}/></div>);`;
      } }],
    build: { write: false, minify: false, cssCodeSplit: false, lib: { entry, name: 'HomeHeaderTest', formats: ['iife'] } },
  });
  const output = Array.isArray(bundle) ? bundle[0].output : bundle.output;
  const code = output.find((item: { type: string }) => item.type === 'chunk').code;
  const css = output.filter((item: { type: string; fileName: string }) => item.type === 'asset' && item.fileName.endsWith('.css'))
    .map((item: { source: string }) => item.source).join('\n');
  page = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box}body{margin:0;font-family:-apple-system,'PingFang SC',sans-serif}${css}</style>`
    + `<div id="root"></div><script>window.process={env:{NODE_ENV:'development'},browser:true}</script><script>${code}</script>`;
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch({ executablePath: existsSync(chrome) ? chrome : undefined, headless: true });
}, 30000);
afterAll(async () => { await browser?.close(); }, 30000);

for (const width of [390, 360]) {
  for (const credits of ['500', '12,500']) {
    it(`${width}px with ${credits} credits: language, credits and avatar show on the right, no overflow or overlap`, async () => {
      const tab = await browser.newPage({ viewport: { width, height: 700 } });
      try {
        await tab.setContent(page.replace(/new URLSearchParams\(location\.search\)\.get\(['"]c['"]\)\s*\|\|\s*['"]12,500['"]/, JSON.stringify(credits)));
        const measured = await tab.evaluate(() => {
          const box = (element: Element | null) => { const r = element?.getBoundingClientRect(); return r ? { left: r.left, right: r.right, width: r.width } : null; };
          const visible = (element: Element | null | undefined) => Boolean(element) && getComputedStyle(element as Element).display !== 'none';
          const nav = document.querySelector('header nav');
          const brand = document.querySelector('header > a');
          const language = document.querySelector('header button[aria-label="语言"]');
          const creditsLink = [...document.querySelectorAll('header a')].find(link => /积分/.test(link.textContent ?? ''));
          const avatar = document.querySelector('header a[aria-label="个人中心"]');
          return { overflow: document.documentElement.scrollWidth - innerWidth, navShown: visible(nav), brand: box(brand), language: box(language), credits: box(creditsLink ?? null),
            avatar: box(avatar), menuHidden: !visible(document.querySelector('header button[aria-label="打开导航"]')), shown: [language, creditsLink, avatar].every(visible) };
        });
        expect(measured.shown, 'language, credits and avatar are all visible').toBe(true);
        expect(measured.menuHidden, 'the menu button has no rail to open on this page').toBe(true);
        expect(measured.overflow).toBeLessThanOrEqual(0);
        // In order, left to right, with no overlap and inside the viewport.
        expect(measured.navShown, 'the three links are the bottom bar\'s on a phone').toBe(false);
        const row = [measured.brand!, measured.language!, measured.credits!, measured.avatar!];
        for (let index = 1; index < row.length; index++) expect(row[index].left, `item ${index} overlaps the previous one`).toBeGreaterThanOrEqual(row[index - 1].right - 0.5);
        expect(row[row.length - 1].right).toBeLessThanOrEqual(width);
      } finally { await tab.close(); }
    }, 20000);
  }
}
