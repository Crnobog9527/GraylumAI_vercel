/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
import {existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {chromium, expect as ui, type Browser} from '@playwright/test';
import {afterAll, beforeAll, it} from 'vitest';

let browser: Browser;
let code: string;
let css: string;
const entry = fileURLToPath(new URL('./__work_status_fixture__.jsx', import.meta.url));
const trpcClient = fileURLToPath(new URL('../../trpc/client.ts', import.meta.url));
beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const {build} = await import(pathToFileURL(createRequire(require.resolve('vitest/package.json')).resolve('vite')).href);
  const bundle = await build({
    configFile: false, logLevel: 'silent', define: {'process.env.NODE_ENV': JSON.stringify('development')},
    oxc: {jsx: {runtime: 'automatic'}},
    resolve: {alias: {'@': fileURLToPath(new URL('../../', import.meta.url))}},
    plugins: [{name: 'work-status-fixture', resolveId(id: string) {
      if (id === entry || id === '@/trpc/client') return id === entry ? entry : trpcClient;
    }, load(id: string) {
      if (id === trpcClient) return `
        const item={type:'agent_tool',tool:'read_source',callId:'c1',kind:'library_search',state:'running',label:''};
        const utils={credits:{getBalance:{invalidate:async()=>{}}},client:{runtime:{executeStream:{mutate:async()=>
          (async function*(){yield item;await new Promise(resolve=>{window.completeRead=resolve});
            yield {...item,state:'done',label:'在资料库里找到 1 篇相关内容',detail:'定位资料'};
            yield {type:'textDelta',text:'根据资料回答',offset:0,rev:1,source:'assistant'};
            yield {type:'result',result:{state:'completed',body:'根据资料回答'}};
          })()}}}};
        export const trpc={useUtils:()=>utils};`;
      if (id === entry) return `import React from 'react';import {createRoot} from 'react-dom/client';
        import {useRuntimeStream} from '@/app/runtime/use-runtime-stream';
        import {AgentWorkStatus} from '@/components/chat-display/agent-work-status';
        import {streamedWorkItems} from '@/components/chat-display/agent-work-model';
        const saved={id:'c1',kind:'library_search',state:'done',label:'在资料库里找到 1 篇相关内容',detail:'定位资料'};
        function App(){
          const loaded=new URL(location.href).searchParams.has('saved');
          const [execution,setExecution]=React.useState({state:loaded?'completed':'running',workItems:loaded?[saved]:[]});
          const runner=useRuntimeStream('session-1',()=>setExecution({state:'completed',workItems:[saved]}));
          return <><button onClick={()=>runner.run('e1')}>查资料</button>
            <AgentWorkStatus items={streamedWorkItems(execution,runner.workItems.e1)}/>
            <p>{runner.reply?.text}</p>
            <button onClick={()=>setExecution({state:'completed',workItems:[]})}>删除来源后的投影</button></>;
        }
        createRoot(document.getElementById('root')).render(<App/>);`;
    }}],
    build: {write: false, minify: false, lib: {entry, name: 'WorkStatusTest', formats: ['iife']}},
  });
  const output = Array.isArray(bundle) ? bundle[0].output : bundle.output;
  code = output.find((item: {type: string}) => item.type === 'chunk').code;
  css = output.filter((item: {type: string; fileName: string}) => item.type === 'asset' && item.fileName.endsWith('.css'))
    .map((item: {source: string}) => item.source).join('\n');
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch({executablePath: existsSync(chrome) ? chrome : undefined, headless: true});
}, 30000);
afterAll(async () => {await browser?.close();});

it('shows live work through the real hook before polling; refresh uses saved rows and deletion removes them', async () => {
  const page = await browser.newPage();
  try {
    await page.route('**/*', route => route.fulfill({contentType: 'text/html', body: '<div id="root"></div>'}));
    const open = async (query = '') => {
      await page.goto('http://localhost/work-status' + query);
      await page.addStyleTag({content: css});
      await page.addScriptTag({content: code});
    };
    await open();
    await page.getByRole('button', {name: '查资料', exact: true}).click();
    await ui(page.getByText('正在查资料库…', {exact: true})).toBeVisible();
    await ui(page.getByText('根据资料回答', {exact: true})).toHaveCount(0);
    await page.evaluate('window.completeRead()');
    await ui(page.getByText('在资料库里找到 1 篇相关内容', {exact: true})).toBeVisible();
    await ui(page.getByText('根据资料回答', {exact: true})).toBeVisible();
    await open('?saved=1');
    await ui(page.getByText('在资料库里找到 1 篇相关内容', {exact: true})).toBeVisible();
    await page.getByRole('button', {name: '删除来源后的投影'}).click();
    await ui(page.getByRole('status')).toHaveCount(0);
  } finally {await page.close();}
}, 30000);
