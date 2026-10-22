/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, expect as browserExpect, type Browser } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';

let browser: Browser;
let code: string;
const entry = fileURLToPath(new URL('./__payment_failover_fixture__.js', import.meta.url));
beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const vite = createRequire(require.resolve('vitest/package.json')).resolve('vite');
  const { build } = await import(pathToFileURL(vite).href);
  const source = fileURLToPath(new URL('./PaymentFailoverSetting.tsx', import.meta.url));
  // Server double: window.stored is the database row; window.readFails makes reads fail.
  const mock = `
    import {useState,useSyncExternalStore} from 'react';
    const listeners = new Set();
    const subscribe = fn => {listeners.add(fn);return () => listeners.delete(fn)};
    const notify = () => listeners.forEach(fn=>fn());
    let snapshot = null;
    const read = () => window.readFails ? {error:new Error('read failed'),data:undefined} : {error:null,data:window.stored};
    const current = () => snapshot ??= read();
    window.saves = [];
    function query(get){
      const value = useSyncExternalStore(subscribe, get);
      return {...value, isError:Boolean(value.error), isLoading:false, refetch:async()=>{
        if (window.readMode === 'throw') throw new Error('read failed');
        if (window.readMode === 'hang') await new Promise(resolve => { window.finishRead = resolve; });
        snapshot = read(); notify(); const v = get(); return {...v, isError:Boolean(v.error)};
      }};
    }
    export const trpc = {settings:{
      getPaymentMethodRoutes:{useQuery:()=>query(current)},
      setPaymentFailover:{useMutation:options=>{
        const [isPending,setPending]=useState(false),[error,setError]=useState(null);
        const mutateAsync = async input => {
          window.saves.push(input); setPending(true);
          try {
            if (window.saveMode === 'hang') await new Promise(resolve => { window.finishSave = resolve; });
            if (window.saveMode === 'fail') throw Object.assign(new Error('raw server failure'),{data:{code:'INTERNAL_SERVER_ERROR'}});
            if (window.saveMode === 'bad') throw Object.assign(new Error('raw validation'),{data:{code:'BAD_REQUEST'}});
            const expected = window.stored?.version;
            if (input.expectedVersion !== expected) throw Object.assign(new Error('raw conflict'),{data:{code:'CONFLICT'}});
            window.stored = {...window.stored,newPurchaseChannel:input.channel,version:expected+1};
            await options.onSuccess?.();
            return [];
          } catch(e) {setError(e); options.onError?.(e); throw e;}
          finally {setPending(false);}
        };
        return {isPending,error,reset:()=>setError(null),mutateAsync,
          mutate: input => {void mutateAsync(input).catch(()=>{});}};
      }},
    }};
  `;
  const bundle = await build({
    configFile: false, logLevel: 'silent', define: { 'process.env.NODE_ENV': JSON.stringify('development') },
    oxc: { jsx: { runtime: 'automatic' } },
    resolve: { alias: { '@': fileURLToPath(new URL('../../', import.meta.url)) } },
    plugins: [{ name: 'payment-channel-fixture', enforce: 'pre', resolveId(id: string) {
      if (id === entry) return id;
      if (id === '@/trpc/client' || id.endsWith('/trpc/client')) return '\0payment-trpc';
    }, load(id: string) {
      if (id === '\0payment-trpc') return mock;
      if (id === entry) return `import React from 'react'; import { createRoot } from 'react-dom/client';
        import {PaymentFailoverSetting} from ${JSON.stringify(source)};
        createRoot(document.getElementById('root')).render(React.createElement(PaymentFailoverSetting));`;
    } }],
    build: { write: false, minify: false, lib: { entry, name: 'PaymentChannelTest', formats: ['iife'] } },
  });
  const output = Array.isArray(bundle) ? bundle[0].output : bundle.output;
  code = output.find((item: { type: string }) => item.type === 'chunk').code;
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch({ executablePath: existsSync(chrome) ? chrome : undefined, headless: true });
}, 30000);
afterAll(async () => { await browser?.close(); }, 30000);

async function open(stored: unknown, readFails = false) {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.abort());
  await page.setContent('<div id="root"></div>');
  await page.evaluate(([value, fails]) => {
    Object.assign(window, { stored: value, readFails: fails });
  }, [stored, readFails] as const);
  await page.addScriptTag({ content: code });
  return { page, errors };
}

const routes = (channel = 'stripe', version = 4) => ({version, newPurchaseChannel:channel, card:{enabled:true}});

it('switches to Waffo and back with the exact read version through the audited endpoint', async () => {
  const { page, errors } = await open(routes());
  try {
    await browserExpect(page.getByTestId('admin-payment-channel-current')).toContainText('Stripe（主渠道）');
    await browserExpect(page.getByTestId('admin-payment-readiness')).toHaveCount(0);
    await browserExpect(page.getByText('切换只影响新建订单；商品映射、准入和支付结果仍按原订单核对。')).toBeVisible();
    await page.getByTestId('admin-payment-channel-option-waffo').click();
    await browserExpect(page.getByText('切到 Waffo 后，所有新购买均为一次性付款', {exact:false})).toBeVisible();
    await page.getByTestId('admin-payment-channel-save').click();
    await browserExpect(page.getByText('已保存，重新读取确认无误。')).toBeVisible();
    await browserExpect(page.getByTestId('admin-payment-channel-current')).toContainText('Waffo（应急，一次性付款）');
    await page.getByTestId('admin-payment-channel-option-stripe').click();
    await page.getByTestId('admin-payment-channel-save').click();
    await browserExpect(page.getByTestId('admin-payment-channel-current')).toContainText('Stripe（主渠道）');
    expect(await page.evaluate('window.saves')).toEqual([
      {expectedVersion:4,channel:'waffo'}, {expectedVersion:5,channel:'stripe'},
    ]);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 15000);

it('blocks stale switching until reread and never retries a conflict', async () => {
  const { page, errors } = await open(routes());
  try {
    await page.evaluate(() => { Object.assign(window, {stored:{version:5,card:{enabled:true},newPurchaseChannel:'waffo'}}); });
    await page.getByTestId('admin-payment-channel-option-waffo').click();
    await page.getByTestId('admin-payment-channel-save').click();
    await browserExpect(page.getByTestId('admin-payment-channel-save-error')).toContainText('刚被其他人改过');
    await browserExpect(page.getByTestId('admin-payment-channel-option-stripe')).toBeDisabled();
    expect(await page.evaluate('window.saves.length')).toBe(1);
    await page.getByTestId('admin-payment-channel-reread').click();
    await browserExpect(page.getByTestId('admin-payment-channel-current')).toContainText('Waffo');
    await browserExpect(page.getByTestId('admin-payment-channel-option-stripe')).toBeEnabled();
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 15000);

it('does not turn failed or malformed reads into an editable default', async () => {
  for (const [stored,fails] of [[routes(),true],[{version:4,newPurchaseChannel:'other'},false]] as const) {
    const {page,errors} = await open(stored,fails);
    try {
      await browserExpect(page.getByTestId('admin-payment-channel-read-error')).toBeVisible();
      await browserExpect(page.getByTestId('admin-payment-channel-save')).toBeDisabled();
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }
},15000);

it('requires a fresh read after a lost result and ignores the late completion', async () => {
  const {page,errors} = await open(routes());
  try {
    await page.clock.install();
    await page.evaluate(() => { Object.assign(window,{saveMode:'hang'}); });
    await page.getByTestId('admin-payment-channel-option-waffo').click();
    await page.getByTestId('admin-payment-channel-save').click();
    await page.clock.fastForward(10001);
    await browserExpect(page.getByTestId('admin-payment-channel-save-error')).toContainText('没能确认');
    await browserExpect(page.getByTestId('admin-payment-channel-option-stripe')).toBeDisabled();
    await page.getByTestId('admin-payment-channel-reread').click();
    await page.evaluate('window.finishSave()');
    await browserExpect(page.getByText('已保存，重新读取确认无误。')).toHaveCount(0);
    expect(await page.evaluate('window.saves.length')).toBe(1);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
},15000);
