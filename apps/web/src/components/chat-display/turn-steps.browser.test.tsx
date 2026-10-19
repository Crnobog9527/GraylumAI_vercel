/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {chromium, expect as ui, type Browser} from '@playwright/test';
import {afterAll, beforeAll, it} from 'vitest';

let browser: Browser;
let code: string;
let css: string;
const entry = fileURLToPath(new URL('./__turn_steps_fixture__.jsx', import.meta.url));
beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const {build} = await import(pathToFileURL(createRequire(require.resolve('vitest/package.json')).resolve('vite')).href);
  const bundle = await build({
    configFile: false, logLevel: 'silent', define: {'process.env.NODE_ENV': JSON.stringify('development')},
    oxc: {jsx: {runtime: 'automatic'}},
    resolve: {alias: {'@': fileURLToPath(new URL('../../', import.meta.url))}},
    plugins: [{name: 'turn-steps-fixture', resolveId(id: string) { if (id === entry) return entry; }, load(id: string) {
      if (id === entry) return `import React from 'react';import {createRoot} from 'react-dom/client';
        import {TurnSteps} from '@/components/chat-display/turn-steps';
        const stages=[
          {phase:'mentor',hasText:false,tools:{running:1,done:2,failed:0}},
          {phase:'mentor',hasText:false,tools:{running:0,done:5,failed:1}},
          {phase:'mentor',hasText:true,tools:{running:0,done:5,failed:1}},
          {phase:'saving',hasText:true,tools:{running:0,done:5,failed:1}}];
        function App(){
          const reopened=new URL(location.href).searchParams.has('reopened');
          const [i,setI]=React.useState(0);
          return <><button onClick={()=>setI(i+1)}>下一步</button><TurnSteps reopened={reopened} progress={stages[i]}/></>;
        }
        createRoot(document.getElementById('root')).render(<App/>);`;
    }}],
    build: {write: false, minify: false, lib: {entry, name: 'TurnStepsTest', formats: ['iife']}},
  });
  const output = Array.isArray(bundle) ? bundle[0].output : bundle.output;
  code = output.find((item: {type: string}) => item.type === 'chunk').code;
  css = output.filter((item: {type: string; fileName: string}) => item.type === 'asset' && item.fileName.endsWith('.css'))
    .map((item: {source: string}) => item.source).join('\n');
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch({executablePath: existsSync(chrome) ? chrome : undefined, headless: true});
}, 60000);
afterAll(async () => {await browser?.close();}, 30000);

it('shows each action as its own line and ticks it off, never one long wait', async () => {
  const page = await browser.newPage();
  try {
    await page.route('**/*', route => route.fulfill({contentType: 'text/html', body: '<div id="root"></div>'}));
    await page.goto('http://localhost/turn-steps');
    await page.addStyleTag({content: css});
    await page.addScriptTag({content: code});
    await ui(page.getByText('正在查资料和数据（已完成 2/3）…')).toBeVisible();
    await ui(page.getByText('查完资料后开始写回复')).toBeVisible();
    await page.getByRole('button', {name: '下一步'}).click();
    await ui(page.getByText('查资料和数据：完成 5 项，1 项这次没查到')).toBeVisible();
    await ui(page.getByText('正在根据查到的内容写回复…')).toBeVisible();
    await page.getByRole('button', {name: '下一步'}).click();
    await ui(page.getByText('正在写回复…', {exact: true})).toBeVisible();
    await page.getByRole('button', {name: '下一步'}).click();
    await ui(page.getByText('回复已写完')).toBeVisible();
    await ui(page.getByText('正在保存结果、核对费用…')).toBeVisible();
    await ui(page.locator('[data-step-state="running"]')).toHaveCount(1);
  } finally {await page.close();}
}, 30000);

it('a reopened turn keeps the steps and says the page updates by itself', async () => {
  const page = await browser.newPage();
  try {
    await page.route('**/*', route => route.fulfill({contentType: 'text/html', body: '<div id="root"></div>'}));
    await page.goto('http://localhost/turn-steps?reopened=1');
    await page.addStyleTag({content: css});
    await page.addScriptTag({content: code});
    await ui(page.getByText('写完会自动显示在这里，不用重发')).toBeVisible();
    await ui(page.getByText('回复暂未完成')).toHaveCount(0);
  } finally {await page.close();}
}, 30000);
