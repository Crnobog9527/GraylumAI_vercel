/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, expect as browserExpect, type Browser } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';

let browser: Browser;
let code: string;
const entry = fileURLToPath(new URL('./__confirm_fixture__.js', import.meta.url));
beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const { build } = await import(pathToFileURL(createRequire(require.resolve('vitest/package.json')).resolve('vite')).href);
  const source = fileURLToPath(new URL('./step-confirm-card.tsx', import.meta.url));
  const bundle = await build({
    configFile: false, logLevel: 'silent', define: { 'process.env.NODE_ENV': JSON.stringify('development') },
    oxc: { jsx: { runtime: 'automatic' } },
    resolve: { alias: { '@': fileURLToPath(new URL('../../', import.meta.url)) } },
    plugins: [{ name: 'confirm-fixture', resolveId(id: string) { if (id === entry) return id; }, load(id: string) {
      if (id === entry) return `import React from 'react'; import {createRoot} from 'react-dom/client';
        import {flushSync} from 'react-dom'; import {StepConfirmCard} from ${JSON.stringify(source)};
        const root=createRoot(document.getElementById('root'));
        window.confirmed=[]; window.now=10000; Date.now=()=>window.now;
        window.renderCard=(stepId, text='相同内容')=>flushSync(()=>root.render(React.createElement(StepConfirmCard, {
          stepId, title:'同名步骤', info:{schema:[{id:'field',title:'字段',required:true}],
            values:{field:{value:text,status:'provisional'}}},
          resuming:false,disabled:false,canConfirm:true,onConfirm:settled=>window.confirmed.push(settled),
          onEdit:()=>{},onReview:()=>{}
        })));
        window.renderCard('step-1');`;
    } }],
    build: { write: false, minify: false, lib: { entry, name: 'ConfirmTest', formats: ['iife'] } },
  });
  const output = Array.isArray(bundle) ? bundle[0].output : bundle.output;
  code = output.find((item: { type: string }) => item.type === 'chunk').code;
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch({ executablePath: existsSync(chrome) ? chrome : undefined, headless: true });
}, 30000);
afterAll(async () => { await browser?.close(); });

it('requires a fresh visible interval for different step IDs even with identical titles and fields', async () => {
  const page = await browser.newPage();
  try {
    await page.route('**/*', route => route.abort());
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({content:code});
    const confirm = page.getByRole('button', {name:'没问题，进入下一步'});
    await browserExpect(confirm).toBeVisible();
    await page.evaluate('window.now=13000');
    await confirm.click();
    expect(await page.evaluate('window.confirmed')).toEqual([true]);
    // Preserve the component instance, the title, and all rows; only the actual step changes.
    await page.evaluate("window.renderCard('step-2')");
    await confirm.click();
    expect(await page.evaluate('window.confirmed')).toEqual([true,false]);
    await page.evaluate('window.now=15000');
    await confirm.click();
    expect(await page.evaluate('window.confirmed')).toEqual([true,false,true]);
    // A refreshed value resets the timer before a synchronous post-commit click can occur.
    await page.evaluate(`window.renderCard('step-2','刚刷新的内容');
      document.querySelector('button').click()`);
    expect(await page.evaluate('window.confirmed')).toEqual([true,false,true,false]);
    await page.evaluate(`window.now=18000; document.dispatchEvent(new Event('visibilitychange'))`);
    await confirm.click();
    expect(await page.evaluate('window.confirmed')).toEqual([true,false,true,false,false]);
  } finally { await page.close(); }
}, 15000);
