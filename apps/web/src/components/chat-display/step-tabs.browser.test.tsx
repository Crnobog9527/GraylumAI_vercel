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
 * UI-UNIFY A4 validation on staging: at 390px the middle state ellipsized "诊断与平台对标" and "定位与执行方案" (content wider than the tab).
 * The real step strip and its real CSS module in Chrome: on a phone every visible tab shows its whole title (it wraps, it never ends in an
 * ellipsis or spills out) and stays at least 44px tall.
 */
let browser: Browser;
let page: string;

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const { build } = await import(pathToFileURL(createRequire(require.resolve('vitest/package.json')).resolve('vite')).href);
  const entry = fileURLToPath(new URL('./__step_tabs_fixture__.tsx', import.meta.url));
  const directory = fileURLToPath(new URL('./', import.meta.url));
  const bundle = await build({
    configFile: false, logLevel: 'silent', define: { 'process.env': JSON.stringify({ NODE_ENV: 'development' }) },
    oxc: { jsx: { runtime: 'automatic' } },
    resolve: { alias: { '@': fileURLToPath(new URL('../../', import.meta.url)) } },
    plugins: [{ name: 'step-tabs-fixture', enforce: 'pre',
      resolveId(path: string) { if (path === entry) return path; },
      load(path: string) {
        if (path !== entry) return;
        return `import {createRoot} from 'react-dom/client';
          import {PositioningStepStrip} from ${JSON.stringify(directory + 'positioning-chrome.tsx')};
          const steps=[['about','了解你',true],['diagnose','诊断与平台对标',true],['benchmark','对标账号分析',false],['position','定位与执行方案',false],['plan','内容规划',false],['review','核对与发布',false]]
            .map(([id,title,valid])=>({id,title,valid}));
          const selected=new URLSearchParams(location.search).get('s')||'benchmark';
          createRoot(document.getElementById('root')).render(<PositioningStepStrip steps={steps} selectedId={selected}/>);`;
      } }],
    build: { write: false, minify: false, cssCodeSplit: false, lib: { entry, name: 'StepTabsTest', formats: ['iife'] } },
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

for (const width of [390, 360, 320]) {
  for (const selected of ['about', 'benchmark', 'position', 'review']) {
    it(`${width}px, step "${selected}": every visible tab shows its whole title and is at least 44px tall`, async () => {
      const tab = await browser.newPage({ viewport: { width, height: 800 } });
      try {
        await tab.setContent(page.replace(/new URLSearchParams\(location\.search\)\.get\(['"]s['"]\)\s*\|\|\s*['"]benchmark['"]/, JSON.stringify(selected)));
        const tabs = await tab.evaluate(() => [...document.querySelectorAll('nav[aria-label="定位步骤"] button')]
          .filter(button => getComputedStyle(button).display !== 'none')
          .map(button => {
            const box = button.getBoundingClientRect(), style = getComputedStyle(button);
            return { text: button.textContent, height: box.height, clipped: button.scrollWidth > button.clientWidth || button.scrollHeight > button.clientHeight,
              ellipsis: style.textOverflow === 'ellipsis' && style.whiteSpace === 'nowrap' };
          }));
        const first = selected === 'about', last = selected === 'review';
        expect(tabs.map(item => item.text).length, 'the selected step and its neighbours').toBe(first || last ? 2 : 3);
        for (const item of tabs) {
          expect(item.height, item.text ?? '').toBeGreaterThanOrEqual(44);
          expect(item.clipped, `${item.text} is cut off`).toBe(false);
          expect(item.ellipsis, `${item.text} ends in an ellipsis`).toBe(false);
        }
        const overflow = await tab.evaluate(() => document.documentElement.scrollWidth - innerWidth);
        expect(overflow).toBeLessThanOrEqual(0);
      } finally { await tab.close(); }
    }, 20000);
  }
}
