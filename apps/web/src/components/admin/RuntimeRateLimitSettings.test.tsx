/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, expect as browserExpect, type Browser } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';

let browser: Browser;
let code: string;
const entry = fileURLToPath(new URL('./__rate_limits_fixture__.js', import.meta.url));
beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const vite = createRequire(require.resolve('vitest/package.json')).resolve('vite');
  const { build } = await import(pathToFileURL(vite).href);
  const source = fileURLToPath(new URL('./RuntimeRateLimitSettings.tsx', import.meta.url));
  const mock = `
    import {useState,useSyncExternalStore} from 'react';
    let data = {config: {version:1, admissionPerMinute:10, admissionPer24Hours:200,
      callsPerMinute:30, callsPer24Hours:600, stopNewCalls:false}, source:'default',
      enforcement:{admission:false,calls:false,pause:false}};
    const listeners = new Set();
    const subscribe = fn => {listeners.add(fn);return () => listeners.delete(fn)};
    window.savedLimits = [];
    window.failSave = false;
    export const trpc = {
      useUtils: () => ({runtimeRateLimits:{get:{setData:(_,v)=>{data=v;listeners.forEach(fn=>fn())}}}}),
      runtimeRateLimits: {
        get:{useQuery:()=>({data:useSyncExternalStore(subscribe,()=>data),error:null,refetch:async()=>({data})})},
        update:{useMutation:options=>{
          const [isPending,setPending]=useState(false),[error,setError]=useState(null);
          return {isPending,error,reset:()=>setError(null),mutate:input=>{
            setPending(true);window.savedLimits.push(input);
            window.finishSave=()=>{
              if(window.failSave)setError(new Error('private raw failure'));
              else options.onSuccess({config:input,source:'configured',enforcement:data.enforcement});
              setPending(false);
            };
          }};
        }}
      }
    };
  `;
  const bundle = await build({
    configFile: false, logLevel: 'silent', define: { 'process.env.NODE_ENV': JSON.stringify('development') },
    oxc: { jsx: { runtime: 'automatic' } },
    resolve: { alias: { '@': fileURLToPath(new URL('../../', import.meta.url)) } },
    plugins: [{ name: 'packages-local-fixture', enforce: 'pre', resolveId(id: string) {
      if (id === entry) return id;
      if (id === '@/trpc/client' || id.endsWith('/trpc/client')) return '\0packages-trpc';
    }, load(id: string) {
      if (id === '\0packages-trpc') return mock;
      if (id === entry) return `import React from 'react'; import { createRoot } from 'react-dom/client';
        import {RuntimeRateLimitSettings} from ${JSON.stringify(source)};
        import {Tabs} from '@/components/ui/tabs';
        createRoot(document.getElementById('root')).render(React.createElement(Tabs,
          {defaultValue:'runtime-rate-limits'},React.createElement(RuntimeRateLimitSettings)));`;
    } }],
    build: { write: false, minify: false, lib: { entry, name: 'PackagesTest', formats: ['iife'] } },
  });
  const output = Array.isArray(bundle) ? bundle[0].output : bundle.output;
  code = output.find((item: { type: string }) => item.type === 'chunk').code;
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch({ executablePath: existsSync(chrome) ? chrome : undefined, headless: true });
}, 30000);
afterAll(async () => { await browser?.close(); });

it('validates, preserves in-flight edits, reads back saves and never implies enforcement', async () => {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.abort());
  try {
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({ content: code });
    await browserExpect(page.getByText('保护尚未接线：当前只能准备配置，保存不会启用限流或暂停模型调用。')).toBeVisible();
    await browserExpect(page.getByRole('button', {name:'一键暂停（待接线）'})).toBeDisabled();
    const minute = page.getByLabel('新对话：每分钟', {exact:true});
    const save = page.getByRole('button', {name:'保存额度配置'});
    await minute.fill('0');
    await browserExpect(save).toBeDisabled();
    await minute.fill('8');
    await save.click();
    await browserExpect(minute).toBeDisabled();
    await page.evaluate('window.finishSave()');
    await browserExpect(page.getByText('配置已保存并回读；保护仍未接线。')).toBeVisible();
    expect(await page.evaluate('window.savedLimits[0]')).toMatchObject({
      admissionPerMinute:8, admissionPer24Hours:200, callsPerMinute:30, callsPer24Hours:600,
      stopNewCalls:false,
    });
    await minute.fill('7');
    await page.evaluate('window.failSave=true');
    await save.click();
    await page.evaluate('window.finishSave()');
    await browserExpect(page.getByRole('alert')).toHaveText('保存或回读失败，请重新读取核对；未确认保存成功。');
    await browserExpect(page.getByText('配置已保存并回读；保护仍未接线。')).toHaveCount(0);
    await browserExpect(minute).toHaveValue('7');
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 15000);
