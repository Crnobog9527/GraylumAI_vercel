/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, expect as ui, type Browser, type Page } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';

let browser: Browser;
let code: string;
const entry = fileURLToPath(new URL('./__review_fixture__.jsx', import.meta.url));
beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const { build } = await import(pathToFileURL(createRequire(require.resolve('vitest/package.json')).resolve('vite')).href);
  const bundle = await build({
    configFile: false, logLevel: 'silent', define: { 'process.env.NODE_ENV': JSON.stringify('development') },
    oxc: { jsx: { runtime: 'automatic' } },
    resolve: { alias: { '@': fileURLToPath(new URL('../', import.meta.url)) } },
    plugins: [{ name: 'review-fixture', resolveId(id: string) { if (id === entry) return id; }, load(id: string) {
      if (id === entry) return `import React from 'react'; import {createRoot} from 'react-dom/client';
        import {useStepConfirmation,reviewedStep} from '@/hooks/use-step-confirmation';
        import {StepReviewDialog} from '@/components/opc/step-review-dialog';
        const field=value=>({value,status:'provisional',nature:'decision'});
        const schema=[{id:'audience',title:'受众',required:true}];
        const data=value=>({projectId:'p',roundId:'r',information:{s:{schema,values:{audience:field(value)}}},
          snapshot:{steps:{s:{version:2,reviewVersion:1,valid:false,evidenceIds:[]}}}});
        window.reads=[]; window.writes=[]; window.transitions=[];
        function App(){
          const [cache,setCache]=React.useState(data('3公里')); const [error,setError]=React.useState('');
          window.refreshCache=value=>setCache(data(value));
          const c=useStepConfirmation({draftId:'test',ready:true,steps:[{id:'s',title:'受众'}],
            refetch:()=>new Promise(resolve=>window.reads.push((value,fail)=>{
              const fresh=data(value); if(!fail)setCache(fresh);resolve(fail?{error:new Error('offline')}:{data:fresh});})),
            flush:async()=>{},pendingEdits:()=>undefined,releaseEdits:()=>{},
            writeInformation:async input=>window.writes.push(input),transition:async input=>window.transitions.push(input),
            run:async fn=>{try{await fn()}catch(e){return e}},nonAnswers:()=>[],onConfirmed:()=>{},setError,setRunning:()=>{}});
          window.c=c;
          return <><p data-testid="cache">{cache.information.s.values.audience.value}</p><p>{error}</p>
            <button onClick={()=>c.confirmNow('s',cache.information.s,undefined,cache.snapshot.steps,false)}>立即核对</button>
            {c.review&&<StepReviewDialog title="受众" schema={schema} reviewed={reviewedStep(c.review)} updates={{}}
              deferred={c.review.deferred} problems={c.review.problems} changed={c.review.changed}
              loading={c.review.loading} loadError={c.review.loadError} busy={c.confirming}
              onEdit={(id,value)=>c.noteEdit(id,field(value))} onDefer={c.setDeferred}
              onConfirm={()=>c.submit(cache.information.s)} onClose={c.close}/>}</>;
        }
        createRoot(document.getElementById('root')).render(<App/>);`;
    } }],
    build: { write: false, minify: false, lib: { entry, name: 'ReviewTest', formats: ['iife'] } },
  });
  const output = Array.isArray(bundle) ? bundle[0].output : bundle.output;
  code = output.find((item: { type: string }) => item.type === 'chunk').code;
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch({ executablePath: existsSync(chrome) ? chrome : undefined, headless: true });
}, 30000);
afterAll(async () => { await browser?.close(); });
async function fixture(run: (page: Page) => Promise<void>) {
  const page = await browser.newPage();
  try {
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }));
    await page.goto('http://localhost/review'); await page.addScriptTag({ content: code });
    await page.getByRole('button', { name: '立即核对' }).click();
    await run(page);
  } finally { await page.close(); }
}

it('A5a: delayed fresh read replaces the cached dialog baseline before claiming freshness or allowing confirmation', async () => {
  await fixture(async page => {
    await ui(page.getByText(/正在读取/)).toBeVisible();
    await ui(page.getByText(/已刷新为最新/)).toHaveCount(0);
    await ui(page.getByRole('button', { name: '确认这一步', exact: true })).toBeDisabled();
    // The background query returns after the click; it must not be mistaken for a bound review read.
    await page.evaluate("window.refreshCache('2公里')");
    await ui(page.getByTestId('cache')).toHaveText('2公里');
    await expect.poll(() => page.evaluate('window.reads.length')).toBe(1);
    await page.evaluate("window.reads[0]('2公里')");
    await ui(page.getByLabel('核对：受众')).toHaveValue('2公里');
    await ui(page.getByRole('button', { name: '确认这一步', exact: true })).toBeEnabled();
    expect(await page.evaluate('window.writes')).toEqual([]);
    expect(await page.evaluate('window.transitions')).toEqual([]);
  });
});
