/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, expect as ui, type Browser } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';

// The report page (REPORT-VISUAL PR-1) in a real browser: the dialog card, its chapter list and the new view,
// on a wide screen and a 375px phone. Shot files are written only when REPORT_VIEW_SHOTS names a folder.
let browser: Browser;
let code: string;
let css: string;
const entry = fileURLToPath(new URL('./__report_view_fixture__.js', import.meta.url));

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const { build } = await import(pathToFileURL(createRequire(require.resolve('vitest/package.json')).resolve('vite')).href);
  const view = fileURLToPath(new URL('./report-view.tsx', import.meta.url));
  const outline = fileURLToPath(new URL('../report-outline.tsx', import.meta.url));
  const useOutline = fileURLToPath(new URL('../use-report-outline.ts', import.meta.url));
  const fixtures = fileURLToPath(new URL('../fixtures/report.ts', import.meta.url));
  const reportData = fileURLToPath(new URL('../../../../../../packages/api/src/shared/reportData.ts', import.meta.url));
  const card = fileURLToPath(new URL('../../opc/positioning-result.module.css', import.meta.url));
  const bundle = await build({ configFile: false, logLevel: 'silent',
    define: { 'process.env.NODE_ENV': JSON.stringify('development') },
    oxc: { jsx: { runtime: 'automatic' } },
    resolve: { alias: { '@': fileURLToPath(new URL('../../../', import.meta.url)) } },
    plugins: [{ name: 'report-view-fixture', enforce: 'pre',
      resolveId(id: string) { if (id === entry) return id; },
      load(id: string) {
        if (id !== entry) return;
        return `import React from 'react'; import {createRoot} from 'react-dom/client';
          import {ReportView} from ${JSON.stringify(view)}; import {ReportWithOutline} from ${JSON.stringify(outline)};
          import {useReportOutline} from ${JSON.stringify(useOutline)}; import {parseReportBody} from ${JSON.stringify(reportData)};
          import {SAMPLE_REPORT_BODY_WITH_DATA} from ${JSON.stringify(fixtures)}; import card from ${JSON.stringify(card)};
          const data = parseReportBody(SAMPLE_REPORT_BODY_WITH_DATA).data;
          data.data.benchmarks.accounts = data.data.benchmarks.accounts.map((a, i) => ({...a,
            metrics: {followers: 18000 - i * 9000, medianViews: 4200 - i * 1500, engagementRate: 0.05, weeklyPosts: 3, capturedAt: null}}));
          function Dialog(){ const ref = React.useRef(null); const o = useReportOutline(ref);
            return React.createElement('div',{style:{position:'fixed',inset:0,display:'flex',alignItems:'center',justifyContent:'center',padding:16}},
              React.createElement('div',{ref,className:card.consentCard,style:{maxWidth:1024}},
                React.createElement(ReportWithOutline,{bodyRef:o.bodyRef,chapters:o.chapters,activeId:o.activeId,onSelect:o.select},
                  React.createElement(ReportView,{body:SAMPLE_REPORT_BODY_WITH_DATA,data}))));}
          createRoot(document.getElementById('root')).render(React.createElement(Dialog));`;
      } }],
    build: { write: false, minify: false, cssCodeSplit: false, lib: { entry, name: 'ReportViewTest', formats: ['iife'] } },
  });
  const output = Array.isArray(bundle) ? bundle[0].output : bundle.output;
  code = output.find((item: { type: string }) => item.type === 'chunk').code;
  css = output.filter((item: { type: string; fileName: string }) => item.type === 'asset' && item.fileName.endsWith('.css'))
    .map((item: { source: string | Uint8Array }) => String(item.source)).join('\n');
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch({ executablePath: existsSync(chrome) ? chrome : undefined, headless: true });
}, 60000);
afterAll(async () => { await browser?.close(); }, 30000);

for (const viewport of [{ width: 1280, height: 900 }, { width: 375, height: 812 }]) {
  it(`shows the chapters, the charts and folded reasons at ${viewport.width}px without sideways scrolling`, async () => {
    const page = await browser.newPage({ viewport });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
      await page.setContent(`<!doctype html><style>body{margin:0;font-family:sans-serif}${css}</style><div id="root"></div>`);
      await page.addScriptTag({ content: code });
      await ui(page.getByText('30 秒看懂')).toBeVisible({ timeout: 5000 });
      // recharts arrives on demand, only because this sample has benchmark numbers.
      await ui(page.locator('.recharts-surface').first()).toBeVisible({ timeout: 10000 });
      const nav = page.getByRole('navigation', { name: '报告目录' });
      expect(await nav.locator('li').count()).toBe(14);
      await ui(page.getByText('怎样算过关').first()).toBeVisible();
      expect(await page.getByText('你的客户会先在小红书搜').count()).toBe(0);
      await page.getByRole('button', { name: '展开理由' }).click();
      await ui(page.getByText('你的客户会先在小红书搜', { exact: false })).toBeVisible();
      await ui(page.getByText('平台怎么推荐内容（大白话）')).toBeVisible();
      const overflow = await page.evaluate(() => [...document.querySelectorAll('section, figure, ol, dl')]
        .filter(element => !element.closest('[class*="tableScroll"], [class*="timeline"]'))
        .filter(element => element.scrollWidth > element.clientWidth + 1)
        .map(element => `${element.tagName}.${element.className} ${element.scrollWidth}>${element.clientWidth}`));
      expect(overflow).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      if (process.env.REPORT_VIEW_SHOTS) {
        const card = page.locator('[class*="consentCard"]');
        await card.evaluate(element => { element.style.maxHeight = 'none'; element.style.overflow = 'visible'; });
        await page.setViewportSize({ width: viewport.width, height: Math.ceil(await card.evaluate(element => element.scrollHeight)) + 40 });
        await card.screenshot({ path: `${process.env.REPORT_VIEW_SHOTS}/report-view-${viewport.width}.png` });
      }
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 40000);
}
