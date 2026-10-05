/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, expect as browserExpect, type Browser } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';

let browser: Browser;
let code: string;
const entry = fileURLToPath(new URL('./__payment_channel_fixture__.js', import.meta.url));
beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const vite = createRequire(require.resolve('vitest/package.json')).resolve('vite');
  const { build } = await import(pathToFileURL(vite).href);
  const source = fileURLToPath(new URL('./PaymentChannelSetting.tsx', import.meta.url));
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
        snapshot = read(); notify(); const v = get(); return {...v, isError:Boolean(v.error)};
      }};
    }
    const packages = {data:[{checkout_ready:true}],error:null};
    const plans = {data:[{level:'pro',checkoutReady:{monthly:false,yearly:false}}],error:null};
    export const trpc = {settings:{
      getPaymentChannel:{useQuery:()=>query(current)},
      getCreditPackages:{useQuery:()=>query(()=>packages)},
      getMembershipPlans:{useQuery:()=>query(()=>plans)},
      updateSystemSettings:{useMutation:options=>{
        const [isPending,setPending]=useState(false),[error,setError]=useState(null);
        return {isPending,error,reset:()=>setError(null),mutate:input=>{
          window.saves.push(input); setPending(true);
          Promise.resolve().then(async()=>{
            const expected = (window.stored?.version ?? 0) + 1;
            if (input.value.version !== expected) {
              const e = Object.assign(new Error('raw conflict'),{data:{code:'CONFLICT'}});
              setError(e); setPending(false); options.onError?.(e); return;
            }
            window.stored = input.value;
            await options.onSuccess?.(); setPending(false);
          });
        }};
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
        import {PaymentChannelSetting} from ${JSON.stringify(source)};
        createRoot(document.getElementById('root')).render(React.createElement(PaymentChannelSetting));`;
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

it('saves Stripe with the next version and confirms it by reading back', async () => {
  const { page, errors } = await open(undefined);
  try {
    // A missing row reads as Waffo/version 0 on the server; here the double returns that value.
    await page.evaluate(() => { Object.assign(window, { stored: { channel: 'waffo', version: 0 } }); });
    await page.getByRole('button', { name: '重新读取' }).click();
    await browserExpect(page.getByTestId('admin-payment-channel-current')).toHaveText('当前选择：Waffo（未接入，新购买已暂停）');
    await browserExpect(page.getByTestId('admin-payment-readiness')).toContainText('积分包 1/1 个');
    await browserExpect(page.getByTestId('admin-payment-readiness')).toContainText('会员套餐 0/1 个');
    const save = page.getByTestId('admin-payment-channel-save');
    await browserExpect(save).toBeDisabled();
    await page.getByTestId('admin-payment-channel-option-stripe').click();
    await save.click();
    await browserExpect(page.getByText('已保存，重新读取确认无误。')).toBeVisible();
    await browserExpect(page.getByTestId('admin-payment-channel-current')).toHaveText('当前选择：Stripe');
    expect(await page.evaluate('window.saves')).toEqual([
      { key: 'payment_new_purchase_channel', value: { channel: 'stripe', version: 1 } },
    ]);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 15000);

it('on a conflict asks for a re-read, does not retry, and saves only after the admin saves again', async () => {
  const { page, errors } = await open({ channel: 'waffo', version: 3 });
  try {
    await browserExpect(page.getByTestId('admin-payment-channel-current')).toContainText('Waffo');
    // Someone else saves first.
    await page.evaluate(() => { Object.assign(window, { stored: { channel: 'stripe', version: 4 } }); });
    await page.getByTestId('admin-payment-channel-option-stripe').click();
    await page.getByTestId('admin-payment-channel-save').click();
    await browserExpect(page.getByTestId('admin-payment-channel-save-error')).toContainText('刚被其他人改过');
    await browserExpect(page.getByTestId('admin-payment-channel-save')).toBeDisabled();
    await browserExpect(page.getByTestId('admin-payment-channel-option-waffo')).toBeDisabled();
    expect(await page.evaluate('window.saves.length')).toBe(1);
    await page.getByRole('button', { name: '重新读取' }).click();
    await browserExpect(page.getByTestId('admin-payment-channel-current')).toHaveText('当前选择：Stripe');
    await browserExpect(page.getByTestId('admin-payment-channel-save-error')).toHaveCount(0);
    await page.getByTestId('admin-payment-channel-option-waffo').click();
    await browserExpect(page.getByText('保存后用户将无法发起新的购买', { exact: false })).toBeVisible();
    await page.getByTestId('admin-payment-channel-save').click();
    await browserExpect(page.getByText('已保存，重新读取确认无误。')).toBeVisible();
    expect(await page.evaluate('window.saves.map(s => s.value)')).toEqual([
      { channel: 'stripe', version: 4 }, { channel: 'waffo', version: 5 },
    ]);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 15000);

it('shows a read failure or invalid value as an error and never as a saved default', async () => {
  for (const [stored, fails] of [[{ channel: 'stripe', version: 1 }, true], [{ channel: 'paypal', version: 1 }, false]] as const) {
    const { page, errors } = await open(stored, fails);
    try {
      await browserExpect(page.getByTestId('admin-payment-channel-read-error')).toBeVisible();
      await browserExpect(page.getByTestId('admin-payment-channel-current')).toHaveCount(0);
      await browserExpect(page.getByTestId('admin-payment-channel-option-stripe')).toBeDisabled();
      await browserExpect(page.getByTestId('admin-payment-channel-save')).toBeDisabled();
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }
}, 15000);
