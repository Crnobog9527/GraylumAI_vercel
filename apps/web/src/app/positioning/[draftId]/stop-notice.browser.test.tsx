/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, expect as ui, type Browser } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';

let browser: Browser;
let code: string;
let css: string;
const entry = fileURLToPath(new URL('./__stop_notice_fixture__.js', import.meta.url));
const shots = process.env.C2_NOTICE_SCREENSHOTS;

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const { build } = await import(pathToFileURL(createRequire(require.resolve('vitest/package.json')).resolve('vite')).href);
  const notice = fileURLToPath(new URL('../../../components/chat/ChatInlineNotice.tsx', import.meta.url));
  const mentor = fileURLToPath(new URL('./mentor-notices.ts', import.meta.url));
  const stop = fileURLToPath(new URL('./stop-reply.ts', import.meta.url));
  const bundle = await build({
    configFile: false, logLevel: 'silent', define: { 'process.env.NODE_ENV': JSON.stringify('development') },
    oxc: { jsx: { runtime: 'automatic' } },
    resolve: { alias: { '@': fileURLToPath(new URL('../../../', import.meta.url)) } },
    plugins: [{ name: 'stop-notice-fixture', resolveId(id: string) { if (id === entry) return id; }, load(id: string) {
      if (id === entry) return `import React from 'react'; import {createRoot} from 'react-dom/client';
        import {ChatNoticeList} from ${JSON.stringify(notice)};
        import {mentorTurnNotice} from ${JSON.stringify(mentor)};
        import {stoppedResultNotice} from ${JSON.stringify(stop)};
        const stopped = (organized, extra='') => mentorTurnNotice('stop', {tone:'status',
          text:stoppedResultNotice({stopped:true,completeness:'stopped',organized}) + extra}, null);
        createRoot(document.getElementById('root')).render(React.createElement('main', null,
          React.createElement('section', {id:'stopped'}, React.createElement(ChatNoticeList, {notices:[stopped(false)]})),
          React.createElement('section', {id:'history'}, React.createElement(ChatNoticeList, {notices:[stopped(false,'\\n历史附注')]})),
          React.createElement('section', {id:'organized'}, React.createElement(ChatNoticeList, {notices:[stopped(true)]})),
          React.createElement('section', {id:'ordinary'}, React.createElement(ChatNoticeList,
            {notices:[{id:'ordinary',tone:'status',text:'普通通知第一句\\n普通通知第二句'}]}))));`;
    } }],
    build: { write: false, minify: false, cssCodeSplit: false, lib: { entry, name: 'StopNoticeTest', formats: ['iife'] } },
  });
  const output: { type: string; fileName: string; code?: string; source?: string }[] =
    Array.isArray(bundle) ? bundle[0].output : bundle.output;
  code = output.find(item => item.type === 'chunk')?.code ?? '';
  css = String(output.find(item => item.fileName.endsWith('.css'))?.source ?? '');
  expect(css).toContain('line-height:');
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch({ executablePath: existsSync(chrome) ? chrome : undefined, headless: true });
  if (shots) mkdirSync(shots, { recursive: true });
}, 30000);

afterAll(async () => { await browser?.close(); });

for (const width of [1920, 390]) {
  it(`renders the stopped notice on two ordered lines at ${width}px without changing other notices`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 963 } });
    try {
      await page.route('**/*', route => route.abort());
      await page.setContent('<div id="root"></div>');
      await page.addStyleTag({ content: css });
      await page.addScriptTag({ content: code });
      const stopped = page.locator('#stopped [role=status]');
      await ui(stopped).toHaveCount(1);
      await ui(stopped).toHaveText('已停止，保留了停止前显示的内容。\n本轮未整理');
      await ui(stopped.getByRole('button')).toHaveCount(0);
      const rects = await page.evaluate(() => {
        function textRect(container: string, phrase: string) {
          const root = document.querySelector(container)!;
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
          let node: Node | null;
          while ((node = walker.nextNode())) {
            const index = node.textContent!.indexOf(phrase);
            if (index < 0) continue;
            const range = document.createRange();
            range.setStart(node, index); range.setEnd(node, index + phrase.length);
            const rect = range.getBoundingClientRect();
            return { top: rect.top, bottom: rect.bottom, left: rect.left };
          }
          throw new Error('notice text missing');
        }
        return {
          first: textRect('#stopped', '已停止，保留了停止前显示的内容。'),
          second: textRect('#stopped', '本轮未整理'),
          historyFirst: textRect('#history', '已停止，保留了停止前显示的内容。'),
          historySecond: textRect('#history', '本轮未整理'),
          historyThird: textRect('#history', '历史附注'),
          ordinaryFirst: textRect('#ordinary', '普通通知第一句'),
          ordinarySecond: textRect('#ordinary', '普通通知第二句'),
        };
      });
      expect(rects.second.top).toBeGreaterThanOrEqual(rects.first.bottom);
      expect(rects.second.left).toBe(rects.first.left);
      expect(rects.historySecond.top).toBeGreaterThanOrEqual(rects.historyFirst.bottom);
      expect(rects.historyThird.top).toBeGreaterThanOrEqual(rects.historySecond.bottom);
      expect(rects.ordinarySecond.top).toBe(rects.ordinaryFirst.top);
      await ui(page.locator('#organized [role=status]')).toHaveText('已停止，保留了停止前显示的内容。');
      await ui(page.getByRole('alert')).toHaveCount(0);
      if (shots) await page.screenshot({ path: `${shots}/stop-notice-${width}.png` });
    } finally { await page.close(); }
  });
}
