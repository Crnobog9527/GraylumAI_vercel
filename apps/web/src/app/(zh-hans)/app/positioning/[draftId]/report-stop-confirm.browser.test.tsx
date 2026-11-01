/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, expect as ui, type Browser, type Page } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';

let browser: Browser;
let code: string;
const id = '00000000-0000-4000-8000-000000000001';
const warning = '今天已停止过 2 次，本次将按已生成部分扣费（不超过 500 积分）';

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const { build } = await import(pathToFileURL(createRequire(require.resolve('vitest/package.json')).resolve('vite')).href);
  const entry = fileURLToPath(new URL('./__report_stop_fixture__.tsx', import.meta.url));
  const directory = fileURLToPath(new URL('./', import.meta.url));
  // Only the transport is synthetic: the real hook, controller and report dialog handle the answer.
  const transport = `
    const id=${JSON.stringify(id)}, queue=[]; let wake, release, offset=4;
    window.fixture={requests:[],defer:false,release(){release?.();release=null;},append(text){queue.push({type:'textDelta',text,offset,rev:1,source:'final'});
      offset+=Array.from(text).length;wake?.();wake=null;}};
    async function* events(){yield {type:'textDelta',text:'起始正文',offset:0,rev:1,source:'final'};
      while(true){if(!queue.length)await new Promise(resolve=>wake=resolve);yield queue.shift();}}
    const data={executionId:id,state:'running',body:null,completeness:null,candidate:false};
    const refetch=async()=>({data});
    const noop=async()=>{};
    const utils={client:{runtime:{executeStream:{mutate:async()=>events()},reportLatest:{query:async()=>({executionId:id})}}},
      runtime:{reportLatest:{setData:noop}},credits:{getBalance:{invalidate:noop}}};
    const mutation={isPending:false,mutateAsync:noop};
    export const trpc={useUtils:()=>utils,runtime:{
      choices: { useQuery: () => ({ data: { corePathV2: false } }) },
      reportLatest:{useQuery:()=>({isSuccess:true,data:{executionId:id}})},
      reportAvailable:{useQuery:()=>({data:{enabled:true,priceCredits:500}})},
      reportPreflight:{useQuery:()=>({data:{canGenerate:true},isFetching:false,isError:false})},
      reportStatus:{useQuery:()=>({data,refetch})},reportStart:{useMutation:()=>mutation},resume:{useMutation:()=>mutation},
      cancel:{useMutation:()=>({mutateAsync:async request=>{window.fixture.requests.push(request);
        if(window.fixture.defer)await new Promise(resolve=>release=resolve);
        return {state:request.confirmed?'stopping':'confirmation_required'};}})}},
      research:{chooseShortfall:{useMutation:()=>mutation}},user:{getEntitlements:{useQuery:()=>({})}}};`;
  const bundle = await build({
    configFile: false, logLevel: 'silent', define: { 'process.env': JSON.stringify({ NODE_ENV: 'development' }) },
    oxc: { jsx: { runtime: 'automatic' } },
    resolve: { alias: {
      '@/trpc/client': '\0report-stop-transport',
      '@/components/fusion-review/JuryEntry': '\0report-stop-jury',
      '@/components/fusion-review/VersionMark': '\0report-stop-marks',
      '@': fileURLToPath(new URL('../../../../../', import.meta.url)),
    } },
    plugins: [{ name: 'report-stop-fixture', enforce: 'pre',
      resolveId(path: string) {
        if (path === entry || path.startsWith('\0report-stop-')) return path;
      },
      load(path: string) {
        if (path === '\0report-stop-transport') return transport;
        if (path === '\0report-stop-marks') return 'export const useVersionMarks=()=>({});export const VersionMark=()=>null;';
        if (path === '\0report-stop-jury') return 'export const JuryEntry=()=>null;';
        if (path !== entry) return;
        return `import React from 'react';import {createRoot} from 'react-dom/client';
          import {ReportEntry} from ${JSON.stringify(directory + 'report-panel.tsx')};
          function App(){return <ReportEntry draftId="draft" sessionId="session" projectId="project" roundId="round"
            confirmed={true} busy={false} onTopics={()=>{}}/>;}
          createRoot(document.getElementById('root')).render(<App/>);`;
      } }],
    build: { write: false, minify: false, cssCodeSplit: false, lib: { entry, name: 'ReportStopTest', formats: ['iife'] } },
  });
  const output = Array.isArray(bundle) ? bundle[0].output : bundle.output;
  code = output.find((item: { type: string }) => item.type === 'chunk').code;
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch({ executablePath: existsSync(chrome) ? chrome : undefined, headless: true });
}, 30000);
afterAll(async () => { await browser?.close(); }, 30000);

async function open() {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.stack ?? error.message));
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }));
  await page.goto('http://report-stop.test/');
  await page.addScriptTag({ content: 'window.process={env:{NODE_ENV:"development"},browser:true};' });
  await page.addScriptTag({ content: code });
  try { await ui(page.getByText('起始正文', { exact: true })).toBeVisible(); }
  catch (error) {
    const body = await page.locator('body').innerText();
    await page.close();
    throw new Error(JSON.stringify({ body, errors, cause: String(error) }));
  }
  return page;
}
const requests = (page: Page) => page.evaluate(() =>
  (window as unknown as { fixture: { requests: Array<Record<string, unknown>> } }).fixture.requests);
const append = (page: Page, text: string) => page.evaluate(text =>
  (window as unknown as { fixture: { append: (text: string) => void } }).fixture.append(text), text);

it('third stop shows an in-page charge warning, then confirms once with the original stop request', async () => {
  const page = await open();
  try {
    await page.getByRole('button', { name: '停止', exact: true }).click();
    const dialog = page.getByRole('alertdialog');
    await ui(dialog).toContainText(warning);
    expect(await requests(page)).toEqual([{ executionId: id, stopAt: 4, source: 'final' }]);
    await dialog.getByRole('button', { name: '确认停止', exact: true }).dblclick();
    await ui(dialog).toHaveCount(0);
    expect(await requests(page)).toEqual([
      { executionId: id, stopAt: 4, source: 'final' },
      { executionId: id, stopAt: 4, source: 'final', confirmed: true },
    ]);
    await ui(page.getByText('已停止，正在保存已显示的内容…', { exact: true })).toBeVisible();
  } finally { await page.close(); }
}, 20000);

it('cancelling the third-stop warning keeps generating, restores buffered text and allows a fresh stop', async () => {
  const page = await open();
  try {
    await page.getByRole('button', { name: '停止', exact: true }).click();
    const dialog = page.getByRole('alertdialog');
    await ui(dialog).toContainText(warning);
    await append(page, '弹窗期间');
    await dialog.getByRole('button', { name: '继续生成', exact: true }).click();
    await ui(dialog).toHaveCount(0);
    await ui(page.getByText('起始正文弹窗期间', { exact: true })).toBeVisible();
    await append(page, '取消后');
    await ui(page.getByText('起始正文弹窗期间取消后', { exact: true })).toBeVisible();
    expect(await requests(page)).toHaveLength(1);
    await page.getByRole('button', { name: '停止', exact: true }).click();
    await ui(dialog).toContainText(warning);
    expect((await requests(page))[1]).toEqual({ executionId: id, stopAt: 11, source: 'final' });
    await page.keyboard.press('Escape');
    await ui(dialog).toHaveCount(0);
    expect(await requests(page)).toHaveLength(2);
    await ui(page.getByRole('dialog', { name: '完整运营策略报告', exact: true })).toBeVisible();
  } finally { await page.close(); }
}, 20000);

for (const close of ['button', 'Escape'] as const) {
  it(`reopens the report when confirmation arrives after closing it with ${close}`, async () => {
    const page = await open();
    try {
      await page.evaluate(() => { (window as unknown as { fixture: { defer: boolean } }).fixture.defer = true; });
      await page.getByRole('button', { name: '停止', exact: true }).click();
      if (close === 'button') await page.getByRole('button', { name: '关闭完整运营策略报告', exact: true }).click();
      else {
        await page.getByRole('dialog', { name: '完整运营策略报告', exact: true }).focus();
        await page.keyboard.press('Escape');
      }
      await ui(page.getByRole('dialog', { name: '完整运营策略报告', exact: true })).toHaveCount(0);
      expect(await requests(page)).toHaveLength(1);
      await page.evaluate(() => (window as unknown as { fixture: { release: () => void } }).fixture.release());
      const dialog = page.getByRole('alertdialog');
      await ui(dialog).toContainText(warning);
      await dialog.getByRole('button', { name: '继续生成', exact: true }).click();
      await ui(page.getByRole('dialog', { name: '完整运营策略报告', exact: true })).toBeVisible();
      await ui(page.getByRole('button', { name: '停止', exact: true })).toBeVisible();
      expect(await requests(page)).toHaveLength(1);
    } finally { await page.close(); }
  }, 20000);
}
