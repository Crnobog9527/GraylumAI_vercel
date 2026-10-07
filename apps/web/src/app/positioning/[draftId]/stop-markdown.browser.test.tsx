/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, expect as ui, type Browser } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';

let browser: Browser;
let code: string;
let css: string;
const entry = fileURLToPath(new URL('./__stop_markdown_fixture__.js', import.meta.url));
const shots = process.env.C2_MARKDOWN_SCREENSHOTS;

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const { build } = await import(pathToFileURL(createRequire(require.resolve('vitest/package.json')).resolve('vite')).href);
  const component = fileURLToPath(new URL('./MentorMarkdown.tsx', import.meta.url));
  const display = fileURLToPath(new URL('./agent-turn-display.ts', import.meta.url));
  const stop = fileURLToPath(new URL('./stop-reply.ts', import.meta.url));
  const bundle = await build({
    configFile: false, logLevel: 'silent', define: { 'process.env.NODE_ENV': JSON.stringify('development') },
    oxc: { jsx: { runtime: 'automatic' } },
    resolve: { alias: { '@': fileURLToPath(new URL('../../../', import.meta.url)) } },
    plugins: [{ name: 'stop-markdown-fixture', resolveId(id: string) { if (id === entry) return id; }, load(id: string) {
      if (id === entry) return `import React from 'react'; import {createRoot} from 'react-dom/client';
        import {flushSync} from 'react-dom';
        import {agentTurnBody} from '@repo/api/src/shared/agentTurn';
        import {MentorMarkdown} from ${JSON.stringify(component)};
        import {mentorReplyDisplay,startLiveReply,liveReplyAfter} from ${JSON.stringify(display)};
        import {stopRequestFor} from ${JSON.stringify(stop)};
        let root = createRoot(document.getElementById('root'));
        window.showReply = (text, phase, result = {stopped:true,completeness:'stopped'}) => {
          const saved = phase === 'saved' || phase === 'reloaded';
          if (phase === 'reloaded') {
            flushSync(() => root.unmount());
            root = createRoot(document.getElementById('root'));
          }
          let live = liveReplyAfter(startLiveReply('synthetic'), 'synthetic',
            {type:'textDelta',text,offset:0,rev:1,source:'assistant'});
          const request = stopRequestFor(live);
          if (phase === 'saving') {
            live = {...live,stopped:true,phase:'stopped'};
            live = liveReplyAfter(live,'synthetic',{type:'text',text:text+'不应出现的新内容'});
          }
          const execution = saved
            ? {state:'completed',body:agentTurnBody(text,null),userStopPending:false,...result}
            : {state:'running',body:null,userStopPending:phase==='saving'};
          const reply = mentorReplyDisplay({...execution,legacyMessage:'',active:!saved,busy:false,
            liveText:saved?undefined:live.text,stopLocal:phase==='saving'?'stopped':undefined});
          flushSync(() => root.render(React.createElement(MentorMarkdown,
            {text:reply.text,live:!saved,result:execution})));
          return {raw:reply.text,request};
        };`;
    } }],
    build: { write: false, minify: false, cssCodeSplit: false, lib: { entry, name: 'StopMarkdownTest', formats: ['iife'] } },
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

type FixtureWindow = Window & { showReply: (text: string, phase: string, result?: object) => {
  raw: string; request: { executionId: string; stopAt: number; source: string };
} };

for (const width of [1920, 390]) {
  it(`keeps every visible character through stop, save and reload at ${width}px`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 963 } });
    try {
      await page.route('**/*', route => route.abort());
      await page.setContent('<div id="root"></div>');
      await page.addStyleTag({ content: css });
      await page.addScriptTag({ content: code });
      const body = page.locator('[data-message-markdown]');
      for (const text of ['这是**重点内', '第一句。\n**', '使用 `部分代码', '使用 `',
        '完整**重点**与普通文字。', '普通文字🧭到这里', '```text\n保留**代码', '---']) {
        await page.evaluate(text => (window as unknown as FixtureWindow).showReply(text, 'streaming'), text);
        const before = await body.innerText();
        const markup = await body.innerHTML();
        if (text === '这是**重点内') expect(before).toBe('这是重点内');
        for (const phase of ['saving', 'saved', 'reloaded']) {
          const result = await page.evaluate(({ text, phase }) =>
            (window as unknown as FixtureWindow).showReply(text, phase), { text, phase });
          expect(result.raw).toBe(text);
          expect(result.request).toEqual({ executionId: 'synthetic', stopAt: Array.from(text).length, source: 'assistant' });
          // Strict innerText and DOM equality: no trimming, normalized whitespace or allowed extra characters.
          expect(await body.innerText(), `${phase}: ${text}`).toBe(before);
          expect(await body.innerHTML(), `${phase}: ${text}`).toBe(markup);
        }
      }
      if (shots) {
        await page.evaluate(() => (window as unknown as FixtureWindow).showReply('这是**重点内', 'reloaded'));
        await page.screenshot({ path: `${shots}/stop-markdown-${width}.png` });
      }
    } finally { await page.close(); }
  });
}

it('leaves normal completed replies and stops after complete content on the ordinary Markdown path', async () => {
  const page = await browser.newPage();
  try {
    await page.route('**/*', route => route.abort());
    await page.setContent('<div id="root"></div>');
    await page.addStyleTag({ content: css });
    await page.addScriptTag({ content: code });
    const body = page.locator('[data-message-markdown]');
    for (const result of [{}, { stopped: false, completeness: 'stopped' },
      { stopped: true, completeness: 'complete' }, { stopped: true, completeness: 'length_limit' }]) {
      await page.evaluate(result => (window as unknown as FixtureWindow).showReply('这是**重点内', 'saved', result), result);
      await ui(body).toHaveText('这是**重点内');
      await ui(body.locator('strong')).toHaveCount(0);
    }
  } finally { await page.close(); }
});
