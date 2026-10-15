/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, type Browser } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';

let browser: Browser;
let code: string;
const entry = fileURLToPath(new URL('./__secrets_fixture__.jsx', import.meta.url));
beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const { build } = await import(pathToFileURL(createRequire(require.resolve('vitest/package.json')).resolve('vite')).href);
  const bundle = await build({
    configFile: false, logLevel: 'silent', define: { 'process.env.NODE_ENV': JSON.stringify('development') },
    oxc: { jsx: { runtime: 'automatic' } },
    resolve: { alias: { '@': fileURLToPath(new URL('../../', import.meta.url)) } },
    plugins: [{ name: 'secrets-fixture', enforce: 'pre',
      resolveId(id: string) { if (id === entry || id.endsWith('/trpc/client')) return id; },
      load(id: string) {
        if (id.endsWith('/trpc/client')) return `
          import {useState} from 'react';
          const slots=['firecrawl','tikhub'].map(slot=>({slot,configured:false,last4:null,revision:0,
            updatedAt:null,updatedByEmail:null,envFallback:null,source:'none'}));
          window.calls=[];
          const mutateAsync=input=>new Promise((resolve,reject)=>{
            window.calls.push(input.slot);
            window.finish=(fail=false)=>fail ? reject(new Error('failed')) : resolve({
              statusRefreshFailed:location.hash==='#metadata-failure',
              slots:slots.map(s=>s.slot===input.slot?{...s,configured:true,revision:1,last4:'test',source:'admin'}:s)});
          });
          let setView;
          export const trpc={useUtils:()=>({platformSecrets:{status:{setData:(_,data)=>setView(data)}}}),
            platformSecrets:{status:{useQuery:()=>{const [data,set]=useState({slots});setView=set;
              return {data,error:null,refetch:async()=>({data})};}},
              set:{useMutation:()=>({mutateAsync})},clear:{useMutation:()=>({mutateAsync})}}};`;
        if (id === entry) return `import React from 'react';import {createRoot} from 'react-dom/client';
          import {PlatformSecretsSettings} from '@/components/admin/PlatformSecretsSettings';
          createRoot(document.getElementById('root')).render(<PlatformSecretsSettings/>);`;
      },
    }],
    build: { write: false, minify: false, lib: { entry, name: 'SecretsTest', formats: ['iife'] } },
  });
  const output = Array.isArray(bundle) ? bundle[0].output : bundle.output;
  code = output.find((item: { type: string }) => item.type === 'chunk').code;
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch({ executablePath: existsSync(chrome) ? chrome : undefined, headless: true });
}, 30000);
afterAll(async () => { await browser?.close(); });

it.each(['success', 'failure', 'metadata-failure'])('serializes slots and preserves other drafts after %s', async outcome => {
  const page = await browser.newPage();
  try {
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }));
    await page.goto(`http://localhost/secrets#${outcome}`);
    await page.addScriptTag({ content: code });
    const firecrawl = page.getByTestId('platform-secret-firecrawl');
    const tikhub = page.getByTestId('platform-secret-tikhub');
    await firecrawl.locator('input').fill('synthetic-firecrawl-test');
    await tikhub.locator('input').fill('synthetic-tikhub-draft');
    await firecrawl.getByRole('button', { name: '保存' }).click();
    expect(await tikhub.locator('input').isDisabled()).toBe(true);
    expect(await tikhub.locator('button').isDisabled()).toBe(true);
    // Even programmatic repeated submits must not dispatch another mutation.
    await tikhub.locator('form').dispatchEvent('submit');
    await firecrawl.locator('form').dispatchEvent('submit');
    expect(await page.evaluate(() => (window as unknown as { calls: string[] }).calls)).toEqual(['firecrawl']);
    await page.evaluate(fail => (window as unknown as { finish: (fail: boolean) => void }).finish(fail), outcome === 'failure');
    await expect.poll(() => firecrawl.locator('input').isDisabled()).toBe(false);
    expect(await firecrawl.locator('input').inputValue()).toBe('');
    expect(await tikhub.locator('input').inputValue()).toBe('synthetic-tikhub-draft');
    if (outcome === 'metadata-failure') {
      expect(await firecrawl.textContent()).toContain('已保存，但操作人信息刷新失败');
      expect(await firecrawl.getByRole('alert').count()).toBe(0);
    } else if (outcome === 'failure') {
      expect(await firecrawl.getByRole('alert').count()).toBe(1);
    } else {
      expect(await firecrawl.textContent()).toContain('已保存，末 4 位 test');
    }
  } finally { await page.close(); }
});
