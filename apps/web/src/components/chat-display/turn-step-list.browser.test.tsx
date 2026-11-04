/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {existsSync, mkdirSync} from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {chromium, expect as ui, type Browser} from '@playwright/test';
import {afterAll, beforeAll, it} from 'vitest';

// The steps list in a real browser: the fold opens on a click, and (when TURN_STEP_SHOTS names a folder) pictures of every state
// at desktop and 390 px width for a person to look at. The page holds only fixed sample text: no account, balance or conversation.
let browser: Browser;
let code: string;
let css: string;
const entry = fileURLToPath(new URL('./__turn_step_list_fixture__.jsx', import.meta.url));
beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const {build} = await import(pathToFileURL(createRequire(require.resolve('vitest/package.json')).resolve('vite')).href);
  const bundle = await build({
    configFile: false, logLevel: 'silent', define: {'process.env.NODE_ENV': JSON.stringify('development')},
    oxc: {jsx: {runtime: 'automatic'}},
    resolve: {alias: {'@': fileURLToPath(new URL('../../', import.meta.url))}},
    plugins: [{name: 'turn-step-list-fixture', resolveId(id: string) { if (id === entry) return entry; }, load(id: string) {
      if (id === entry) return `import React from 'react';import {createRoot} from 'react-dom/client';
        import {TurnStepList} from '@/components/chat-display/turn-step-list';
        const done=(id,tool,extra={})=>({id,tool,state:'done',...extra});
        const cases=[
          ['刚发送：还没有任何步骤，正在思考',{steps:[],live:true,hasText:false}],
          ['读完方法，接着思考下一步',{steps:[done('1','load_skill',{label:'分镜脚本'})],live:true,hasText:false}],
          ['正在联网搜索',{steps:[done('1','load_skill',{label:'分镜脚本'}),{id:'2',tool:'research',state:'running',detail:'早起口播的开头怎么写'}],live:true,hasText:false}],
          ['正在读取作品数据',{steps:[{id:'1',tool:'coach_review',state:'running'}],live:true,hasText:false}],
          ['开始出字：折叠成一行（点开看明细）',{steps:[done('1','load_skill',{label:'分镜脚本'}),done('2','research',{detail:'早起口播的开头怎么写',count:6})],live:false,hasText:true}],
          ['有步骤没成功或没用到：中性的话',{steps:[done('1','load_skill',{label:'分镜脚本'}),{id:'2',tool:'research',state:'failed'},{id:'3',tool:'read_source',state:'skipped'}],live:false,hasText:true,open:true}],
        ];
        function Case({title,props}){
          const ref=React.useRef(null);
          React.useEffect(()=>{ if(props.open){ ref.current.querySelector('button').click(); } },[]);
          return <section ref={ref} style={{margin:'0 0 22px'}}><p style={{margin:'0 0 6px',font:'12px sans-serif',color:'#999'}}>{title}</p>
            <TurnStepList steps={props.steps} live={props.live} hasText={props.hasText}/>
            {props.hasText||props.live&&props.hasText?<p style={{margin:0,font:'15px/1.7 sans-serif',color:'#262626'}}>回复正文从这里开始（示例文字）。</p>:null}</section>;
        }
        function App(){return <div style={{maxWidth:640,margin:'0 auto',padding:16,background:'#fff',fontFamily:'sans-serif'}}>{cases.map(([t,p])=><Case key={t} title={t} props={p}/>)}</div>;}
        createRoot(document.getElementById('root')).render(<App/>);`;
    }}],
    build: {write: false, minify: false, lib: {entry, name: 'TurnStepListTest', formats: ['iife']}},
  });
  const output = Array.isArray(bundle) ? bundle[0].output : bundle.output;
  code = output.find((item: {type: string}) => item.type === 'chunk').code;
  css = output.filter((item: {type: string; fileName: string}) => item.type === 'asset' && item.fileName.endsWith('.css'))
    .map((item: {source: string}) => item.source).join('\n');
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch({executablePath: existsSync(chrome) ? chrome : undefined, headless: true});
}, 60000);
afterAll(async () => {await browser?.close();}, 30000);

async function open(width: number) {
  const page = await browser.newPage({viewport: {width, height: 900}});
  await page.route('**/*', route => route.fulfill({contentType: 'text/html', body: '<body style="margin:0;background:#fff"><div id="root"></div></body>'}));
  await page.goto('http://localhost/turn-step-list');
  await page.addStyleTag({content: css});
  await page.addScriptTag({content: code});
  return page;
}

it('thinking, a running step and the folded line each show; the fold opens and closes on a click', async () => {
  const page = await open(390);
  try {
    await ui(page.getByText('正在思考…')).toHaveCount(2);
    await ui(page.getByText('正在联网搜索：早起口播的开头怎么写…')).toBeVisible();
    await ui(page.getByText('正在读取你的作品数据…')).toBeVisible();
    const fold = page.getByRole('button', {name: '已完成 2 个步骤'});
    await ui(fold).toHaveAttribute('aria-expanded', 'false');
    await ui(page.getByText('已搜索，找到 6 条结果')).toHaveCount(0);
    await fold.click();
    await ui(page.getByText('已搜索，找到 6 条结果')).toBeVisible();
    await ui(page.getByText('已读取「分镜脚本」方法').first()).toBeVisible();
    await ui(page.getByRole('button', {name: '已完成 2 个步骤'})).toHaveAttribute('aria-expanded', 'true');
    await page.getByRole('button', {name: '已完成 2 个步骤'}).click();
    await ui(page.getByText('已搜索，找到 6 条结果')).toHaveCount(0);
    // A step that did not work is said neutrally, and the folded line counts it.
    await ui(page.getByText('联网搜索暂时没成功，改用已有信息回答')).toBeVisible();
    await ui(page.getByText('这次没有查阅资料库')).toBeVisible();
    // No horizontal scroll at phone width.
    await ui.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  } finally {await page.close();}
}, 60000);

it('pictures of every state (only when TURN_STEP_SHOTS names a folder)', async () => {
  const dir = process.env.TURN_STEP_SHOTS;
  if (!dir) return;
  mkdirSync(dir, {recursive: true});
  for (const [name, width] of [['desktop', 1280], ['mobile-390', 390]] as const) {
    const page = await open(width);
    try { await page.screenshot({path: `${dir}/${name}.png`, fullPage: true}); } finally {await page.close();}
  }
}, 60000);
