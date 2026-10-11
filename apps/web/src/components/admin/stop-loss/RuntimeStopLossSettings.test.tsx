/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, expect as browserExpect, type Browser, type Page } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';

let browser: Browser;
let code: string;
const entry = fileURLToPath(new URL('./__stop_loss_fixture__.js', import.meta.url));

// Server state lives on window.server; failures are injected per procedure via window.fail.
const mock = `
  import {useState,useSyncExternalStore} from 'react';
  const listeners = new Set();
  const subscribe = fn => {listeners.add(fn);return () => listeners.delete(fn)};
  const notify = () => {window.version++;listeners.forEach(fn=>fn())};
  window.version = 0;
  window.calls = [];
  const fail = name => window.fail?.[name];
  const read = name => {
    if (fail(name)) throw fail(name);
    const s = window.server;
    if (name==='get') return {config:s.limits,source:'configured',enforcement:{admission:true,calls:true,pause:true}};
    if (name==='stopLossConfig') return {config:s.stopLoss,revision:s.revision,source:s.source};
    if (name==='stopLossStatus') return {config:s.stopLoss,revision:s.revision,source:s.source,usage:s.usage,basis:'settled_provider_usd',
      timezone:'UTC',externalNotifications:'not_connected'};
    if (name==='stopLossAlerts') return {alerts:s.alerts,limit:100};
  };
  const cache = {};
  function query(name){
    return {useQuery:()=>{
      useSyncExternalStore(subscribe,()=>window.version);
      let data, error=null;
      // A failed re-read keeps the previous data, like TanStack Query does.
      try { data = name in cache && !window.refetchFail ? cache[name] : (cache[name]=read(name)); }
      catch (e) { error=e; data=cache[name]; }
      return {data,error,isFetching:false,refetch:async()=>{if(!window.refetchFail)delete cache[name];notify();}};
    }};
  }
  function mutation(name, apply){
    return {useMutation:()=>{
      const [state,setState]=useState({isPending:false,error:null,data:undefined});
      const mutateAsync=async input=>{
        window.calls.push([name,input]);
        if (fail(name)) throw fail(name);
        return apply(input);
      };
      return {...state,reset:()=>setState({isPending:false,error:null,data:undefined}),mutateAsync,
        mutate:input=>{setState({isPending:true,error:null,data:undefined});
          mutateAsync(input).then(data=>setState({isPending:false,error:null,data}),
            error=>setState({isPending:false,error,data:undefined}));}};
    }};
  }
  export const trpc = {
    useUtils: () => ({runtimeRateLimits:{
      get:{setData:(_,v)=>{cache.get=typeof v==='function'?v(cache.get):v;notify()},
        invalidate:async()=>{delete cache.get;notify()}},
      stopLossStatus:{invalidate:async()=>{delete cache.stopLossStatus;notify()}},
    }}),
    runtimeRateLimits: {
      get:query('get'), stopLossStatus:query('stopLossStatus'), stopLossAlerts:query('stopLossAlerts'),
      // Mirrors the dedicated endpoint: only the flag changes; window.readBack can override the result.
      setStopNewCalls:mutation('setStopNewCalls',input=>{const s=window.server;
        s.limits={...s.limits,stopNewCalls:input.stopped,...window.readBack};return {config:s.limits,source:'configured'}}),
      // Mirrors the server compare-and-write: a stale expectedVersion is a 409 conflict.
      updateStopLoss:mutation('updateStopLoss',input=>{const s=window.server;
        if(input.expectedVersion!==s.revision)throw {message:'conflict',data:{code:'CONFLICT',httpStatus:409}};
        s.stopLoss=input.config;s.revision++;s.source='configured';return read('stopLossConfig')}),
      recordProviderBalance:mutation('recordProviderBalance',input=>({...input,observedAt:'2026-10-11T03:00:00.000Z',
        source:'admin_observation'})),
    },
  };
`;

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const vite = createRequire(require.resolve('vitest/package.json')).resolve('vite');
  const { build } = await import(pathToFileURL(vite).href);
  const source = fileURLToPath(new URL('./RuntimeStopLossSettings.tsx', import.meta.url));
  const bundle = await build({
    configFile: false, logLevel: 'silent', define: { 'process.env.NODE_ENV': JSON.stringify('development') },
    oxc: { jsx: { runtime: 'automatic' } },
    resolve: { alias: { '@': fileURLToPath(new URL('../../../', import.meta.url)) } },
    plugins: [{ name: 'stop-loss-fixture', enforce: 'pre', resolveId(id: string) {
      if (id === entry) return id;
      if (id === '@/trpc/client' || id.endsWith('/trpc/client')) return '\0stop-loss-trpc';
    }, load(id: string) {
      if (id === '\0stop-loss-trpc') return mock;
      if (id === entry) return `import React from 'react'; import { createRoot } from 'react-dom/client';
        import {RuntimeStopLossSettings,RuntimeStopLossTabTrigger,STOP_LOSS_TAB} from ${JSON.stringify(source)};
        import {Tabs,TabsList,TabsTrigger,TabsContent} from '@/components/ui/tabs';
        const h=React.createElement;
        createRoot(document.getElementById('root')).render(h(Tabs,{defaultValue:STOP_LOSS_TAB},
          h(TabsList,null,h(RuntimeStopLossTabTrigger),h(TabsTrigger,{value:'other'},'其他设置')),
          h(TabsContent,{value:'other'},'other tab'),h(RuntimeStopLossSettings)));`;
    } }],
    build: { write: false, minify: false, lib: { entry, name: 'StopLossTest', formats: ['iife'] } },
  });
  const output = Array.isArray(bundle) ? bundle[0].output : bundle.output;
  code = output.find((item: { type: string }) => item.type === 'chunk').code;
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch({ executablePath: existsSync(chrome) ? chrome : undefined, headless: true });
}, 30000);
afterAll(async () => { await browser?.close(); });

const emptyStopLoss = { version: 1, userDailyUsd: null, siteDailyUsd: null, siteAlertUsd: null,
  providerBalanceAlertUsd: null, notificationChannel: null };
const limits = { version: 1, admissionPerMinute: 10, admissionPer24Hours: 200, callsPerMinute: 30,
  callsPer24Hours: 600, stopNewCalls: false };

async function open(server: Record<string, unknown>, fail: Record<string, unknown> = {}) {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.abort());
  // The bundle has no Tailwind build; this one rule stands in for the inactive-tab utility class.
  await page.setContent('<style>[data-state="inactive"].data-\\[state\\=inactive\\]\\:hidden{display:none}</style>'
    + '<div id="root"></div>');
  await page.evaluate(([s, f]) => {
    Object.assign(window, { server: s, fail: f });
  }, [{ limits, stopLoss: emptyStopLoss, revision: 0, source: 'default', usage: { utcDate: '2026-10-11', userUsd: '0', siteUsd: '0' },
    alerts: [], ...server }, fail] as const);
  await page.addScriptTag({ content: code });
  return { page, errors };
}
const calls = (page: Page) => page.evaluate('window.calls') as Promise<unknown[][]>;

it('stops and resumes new calls only after confirmation, using the fresh read-back', async () => {
  const { page, errors } = await open({});
  try {
    await browserExpect(page.getByTestId('stop-new-calls-state')).toHaveText('当前状态：正常运行');
    await page.getByRole('button', { name: '停止新调用' }).click();
    await browserExpect(page.getByRole('alertdialog')).toContainText('确认停止全站新的模型调用？');
    await page.getByRole('button', { name: '取消' }).click();
    expect((await calls(page)).filter(c => c[0] === 'setStopNewCalls')).toEqual([]);
    await page.getByRole('button', { name: '停止新调用' }).click();
    await page.getByRole('button', { name: '确认停止' }).click();
    await browserExpect(page.getByTestId('stop-new-calls-state')).toHaveText('当前状态：已停止新调用');
    await browserExpect(page.getByText('已停止新的模型调用（已回读确认）', { exact: false })).toBeVisible();
    // Only the dedicated flag endpoint is used; the rate limits are never sent.
    expect((await calls(page)).filter(c => c[0] !== 'setStopNewCalls')).toEqual([]);
    expect((await calls(page)).find(c => c[0] === 'setStopNewCalls')?.[1]).toEqual({ stopped: true });
    // The server read-back decides what is shown.
    await page.evaluate('window.readBack={stopNewCalls:true}');
    await page.getByRole('button', { name: '恢复新调用' }).click();
    // (The read-back below still says stopped, so the page must keep showing stopped.)
    await browserExpect(page.getByRole('alertdialog')).toContainText('确认恢复新的模型调用？');
    await page.getByRole('button', { name: '确认恢复' }).click();
    await browserExpect(page.getByText('已停止新的模型调用（已回读确认）', { exact: false })).toBeVisible();
    await browserExpect(page.getByTestId('stop-new-calls-state')).toHaveText('当前状态：已停止新调用');
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 20000);

it('shows friendly errors for a failed toggle and a forbidden read', async () => {
  const { page, errors } = await open({}, { setStopNewCalls: { message: 'raw db failure', data: { code: 'INTERNAL_SERVER_ERROR' } } });
  try {
    await page.getByRole('button', { name: '停止新调用' }).click();
    await page.getByRole('button', { name: '确认停止' }).click();
    await browserExpect(page.getByText('保存没有确认成功。请点“重新读取”核对当前设置后再试。')).toBeVisible();
    await browserExpect(page.getByText('raw db failure')).toHaveCount(0);
    await browserExpect(page.getByTestId('stop-new-calls-state')).toHaveText('当前状态：正常运行');
  } finally { await page.close(); }
  const denied = { message: 'FORBIDDEN', data: { code: 'FORBIDDEN' } };
  const forbidden = await open({}, { get: denied, stopLossStatus: denied, stopLossAlerts: denied });
  try {
    await browserExpect(forbidden.page.getByText('只有管理员可以查看和修改成本止损设置。')).toHaveCount(3);
    await browserExpect(forbidden.page.getByRole('button', { name: '停止新调用' })).toHaveCount(0);
    await browserExpect(forbidden.page.getByRole('button', { name: '保存止损设置' })).toHaveCount(0);
    expect([...errors, ...forbidden.errors]).toEqual([]);
  } finally { await forbidden.page.close(); }
}, 20000);

it('shows empty limits as not blocking, saves the full config and reads it back', async () => {
  const { page, errors } = await open({ usage: { utcDate: '2026-10-11', userUsd: '0', siteUsd: '3.456789' } });
  try {
    const usage = page.getByTestId('stop-loss-usage');
    await browserExpect(usage).toContainText('今天（UTC 2026-10-11）全站实际成本：$3.4567');
    await browserExpect(usage).toContainText('全站每日上限：未设置，不拦截。');
    await browserExpect(page.getByText('设置来源：默认（全部未设置）')).toBeVisible();
    const save = page.getByRole('button', { name: '保存止损设置' });
    await browserExpect(save).toBeDisabled();
    const site = page.getByLabel('全站每日上限（美元）');
    await site.fill('-3');
    await browserExpect(page.getByText('请填写不带符号的金额', { exact: false })).toBeVisible();
    await browserExpect(save).toBeDisabled();
    await site.fill('3');
    await page.getByLabel('每位用户每日上限（美元）').fill('0');
    await browserExpect(page.getByText('上限填 0 会让对应范围当天的新计费调用全部被拒绝', { exact: false })).toBeVisible();
    await page.getByLabel('每位用户每日上限（美元）').fill('0.5');
    await page.getByLabel('通知渠道备注').fill('  运营群  ');
    await save.click();
    await browserExpect(page.getByText('止损设置已保存（已回读确认）。')).toBeVisible();
    expect((await calls(page)).find(c => c[0] === 'updateStopLoss')?.[1]).toEqual({ expectedVersion: 0, config: { version: 1,
      userDailyUsd: '0.5', siteDailyUsd: '3', siteAlertUsd: null, providerBalanceAlertUsd: null, notificationChannel: '运营群' } });
    await browserExpect(usage).toContainText('全站每日上限：$3（已达到）');
    await browserExpect(page.getByText('设置来源：已保存的设置')).toBeVisible();
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 20000);

it('keeps an unsaved limit draft when switching to another settings tab and back', async () => {
  const { page, errors } = await open({});
  try {
    await page.getByLabel('全站每日上限（美元）').fill('7');
    await page.getByRole('tab', { name: '其他设置' }).click();
    await browserExpect(page.getByLabel('全站每日上限（美元）')).toBeHidden();
    await page.getByRole('tab', { name: '成本止损' }).click();
    await browserExpect(page.getByLabel('全站每日上限（美元）')).toHaveValue('7');
    await page.getByRole('button', { name: '保存止损设置' }).click();
    await browserExpect(page.getByText('止损设置已保存（已回读确认）。')).toBeVisible();
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 20000);

it('keeps the editor and the draft when a background re-read fails', async () => {
  const { page, errors } = await open({});
  try {
    await page.getByLabel('全站每日上限（美元）').fill('6');
    await page.evaluate(() => {
      const w = window as unknown as { refetchFail: boolean; fail: Record<string, unknown> };
      w.refetchFail = true;
      w.fail = { stopLossStatus: { message: 'x', data: { code: 'SERVICE_UNAVAILABLE' } } };
    });
    await page.getByRole('button', { name: '刷新' }).click();
    await browserExpect(page.getByText('最新数据暂时读取失败', { exact: false })).toBeVisible();
    await browserExpect(page.getByLabel('全站每日上限（美元）')).toHaveValue('6');
    await page.getByRole('button', { name: '重试读取' }).click();
    await browserExpect(page.getByLabel('全站每日上限（美元）')).toHaveValue('6');
    await page.evaluate(() => {
      const w = window as unknown as { refetchFail: boolean; fail: Record<string, unknown> };
      w.refetchFail = false;
      w.fail = {};
    });
    await page.getByRole('button', { name: '保存止损设置' }).click();
    await browserExpect(page.getByText('止损设置已保存（已回读确认）。')).toBeVisible();
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 20000);

it('sends the revision the edit started from and turns a 409 into a reload prompt', async () => {
  const { page, errors } = await open({ stopLoss: { ...emptyStopLoss, siteDailyUsd: '10' }, revision: 4, source: 'configured' });
  try {
    await page.getByLabel('全站每日上限（美元）').fill('20');
    // Another administrator saves meanwhile, so the server revision moves to 5.
    await page.evaluate('window.server.stopLoss={...window.server.stopLoss,siteDailyUsd:"15"}; window.server.revision=5');
    await page.getByRole('button', { name: '保存止损设置' }).click();
    await browserExpect(page.getByText('设置已被其他人修改', { exact: false })).toBeVisible();
    expect((await calls(page)).find(c => c[0] === 'updateStopLoss')?.[1]).toMatchObject({ expectedVersion: 4 });
    await browserExpect(page.getByText('止损设置已保存', { exact: false })).toHaveCount(0);
    await page.getByRole('button', { name: '重新读取' }).click();
    await browserExpect(page.getByLabel('全站每日上限（美元）')).toHaveValue('15');
    await page.getByLabel('全站每日上限（美元）').fill('12');
    await page.getByRole('button', { name: '保存止损设置' }).click();
    await browserExpect(page.getByText('止损设置已保存（已回读确认）。')).toBeVisible();
    expect((await calls(page)).filter(c => c[0] === 'updateStopLoss').at(-1)?.[1]).toMatchObject({ expectedVersion: 5 });
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 20000);

it('records a manual provider balance with its source and validity', async () => {
  const { page, errors } = await open({});
  try {
    const record = page.getByRole('button', { name: '记录余额' });
    await browserExpect(record).toBeDisabled();
    await page.getByLabel('供应商', { exact: true }).selectOption('tikhub');
    await page.getByLabel('当前余额（美元）').fill('25.5');
    await record.click();
    await browserExpect(page.getByText('已记录：TikHub 余额 $25.5', { exact: false })).toBeVisible();
    await browserExpect(page.getByText('来源：管理员手动记录，24 小时内有效', { exact: false })).toBeVisible();
    expect((await calls(page)).find(c => c[0] === 'recordProviderBalance')?.[1])
      .toEqual({ provider: 'tikhub', balanceUsd: '25.5' });
    expect(errors).toEqual([]);
  } finally { await page.close(); }
  const failed = await open({}, { recordProviderBalance: { message: 'RUNTIME_STOP_LOSS_UNAVAILABLE', data: null } });
  try {
    await failed.page.getByLabel('当前余额（美元）').fill('3');
    await failed.page.getByRole('button', { name: '记录余额' }).click();
    await browserExpect(failed.page.getByText('余额没有确认记录成功，请稍后再试。')).toBeVisible();
    await browserExpect(failed.page.getByText('RUNTIME_STOP_LOSS_UNAVAILABLE')).toHaveCount(0);
  } finally { await failed.page.close(); }
}, 20000);

it('lists alerts as aggregates, shows the empty state, and fits a 375px screen', async () => {
  const empty = await open({});
  try {
    await browserExpect(empty.page.getByTestId('stop-loss-alerts-empty')).toHaveText('暂无止损告警。');
  } finally { await empty.page.close(); }
  const alerts = [
    { id: 'a1', test_id: 'runtime_stop_loss_userDailyUsd', status: 'warning', created_at: '2026-10-11T02:00:00.000Z',
      details: { dedupeKey: 'k', utcDate: '2026-10-11', scope: 'user', thresholdUsd: '2', actualUsd: '2.4', userId: 'u-secret' } },
    { id: 'a2', test_id: 'runtime_stop_loss_balance_openrouter_unknown', status: 'warning',
      created_at: '2026-10-11T01:00:00.000Z', details: { provider: 'openrouter', status: 'unknown', thresholdUsd: '5' } },
  ];
  const { page, errors } = await open({ alerts });
  try {
    await page.setViewportSize({ width: 375, height: 800 });
    const list = page.getByTestId('stop-loss-alerts');
    await browserExpect(list.getByRole('listitem')).toHaveCount(2);
    await browserExpect(list).toContainText('有用户达到每人每日上限');
    await browserExpect(list).toContainText('OpenRouter 余额未知');
    await browserExpect(list).not.toContainText('u-secret');
    const overflowing = await page.evaluate(() => [...document.querySelectorAll('p, label, button, h3, li')]
      .filter(node => node.getBoundingClientRect().right > window.innerWidth + 1)
      .map(node => node.textContent?.slice(0, 40)));
    expect(overflowing).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 20000);
