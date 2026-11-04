/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, expect as ui, type Browser } from '@playwright/test';
import { afterAll, beforeAll, it } from 'vitest';

/*
 * One positioning (mentor) reply in a real browser: the page's own reducer (liveReplyAfter) takes the turn's step events and
 * MentorTurnSteps lists them above the reply, open while no text has come, folded to one line once the text flows. Only the
 * stream is synthetic (buttons push the same events the turn path delivers).
 */
let browser: Browser;
let code: string;
let css: string;
const entry = fileURLToPath(new URL('./__mentor_steps_fixture__.jsx', import.meta.url));
const directory = fileURLToPath(new URL('./', import.meta.url));
beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const { build } = await import(pathToFileURL(createRequire(require.resolve('vitest/package.json')).resolve('vite')).href);
  const bundle = await build({
    configFile: false, logLevel: 'silent', define: { 'process.env.NODE_ENV': JSON.stringify('development') },
    oxc: { jsx: { runtime: 'automatic' } },
    resolve: { alias: { '@': fileURLToPath(new URL('../../../../../', import.meta.url)) } },
    plugins: [{ name: 'mentor-steps-fixture', resolveId(id: string) { if (id === entry) return entry; }, load(id: string) {
      if (id !== entry) return;
      return `import React from 'react';import {createRoot} from 'react-dom/client';
        import {MentorTurnSteps} from ${JSON.stringify(directory + 'mentor-turn-steps.tsx')};
        import {liveReplyAfter, startLiveReply} from ${JSON.stringify(directory + 'agent-turn-display.ts')};
        const events=[
          {type:'step',id:'1',tool:'load_skill',state:'running'},
          {type:'step',id:'1',tool:'load_skill',state:'done'},
          {type:'step',id:'2',tool:'research',state:'running',detail:'早起口播'},
          {type:'step',id:'2',tool:'research',state:'done',count:6},
          {type:'textDelta',text:'先说说你的情况。',offset:0,rev:1,source:'assistant'}];
        function App(){
          const [live,setLive]=React.useState(startLiveReply('turn:1'));
          const [next,setNext]=React.useState(0);
          return <><button onClick={()=>{setLive(old=>liveReplyAfter(old,'turn:1',events[next]));setNext(next+1);}}>下一个事件</button>
            <MentorTurnSteps live={live} reply={{text:live.text}} calls={[]}/>
            {live.text&&<p>{live.text}</p>}</>;
        }
        createRoot(document.getElementById('root')).render(<App/>);`;
    } }],
    build: { write: false, minify: false, lib: { entry, name: 'MentorStepsTest', formats: ['iife'] } },
  });
  const output = Array.isArray(bundle) ? bundle[0].output : bundle.output;
  code = output.find((item: { type: string }) => item.type === 'chunk').code;
  css = output.filter((item: { type: string; fileName: string }) => item.type === 'asset' && item.fileName.endsWith('.css'))
    .map((item: { source: string }) => item.source).join('\n');
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch({ executablePath: existsSync(chrome) ? chrome : undefined, headless: true });
}, 60000);
afterAll(async () => { await browser?.close(); }, 30000);

it('lists the mentor reply\'s steps as they come, then folds them into one line when the text flows', async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 800 } });
  try {
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }));
    await page.goto('http://localhost/mentor-steps');
    await page.addStyleTag({ content: css });
    await page.addScriptTag({ content: 'window.process={env:{NODE_ENV:"development"},browser:true};' });
    await page.addScriptTag({ content: code });
    const next = page.getByRole('button', { name: '下一个事件' });
    const list = page.getByRole('status', { name: '这条回复的步骤' });
    await ui(list.getByText('正在思考…')).toBeVisible();
    await next.click();
    await ui(list.getByText('正在读取方法…')).toBeVisible();
    await next.click();
    await ui(list.getByText('已读取方法')).toBeVisible();
    await next.click();
    await ui(list.getByText('正在联网搜索：早起口播…')).toBeVisible();
    await next.click();
    await ui(list.getByText('已搜索，找到 6 条结果')).toBeVisible();
    await next.click();
    await ui(page.getByText('先说说你的情况。', { exact: true })).toBeVisible();
    const fold = page.getByRole('button', { name: '已完成 2 个步骤' });
    await ui(fold).toBeVisible();
    await ui(page.getByText('已搜索，找到 6 条结果')).toHaveCount(0);
    await fold.click();
    await ui(page.getByText('已搜索，找到 6 条结果')).toBeVisible();
  } finally { await page.close(); }
}, 30000);
