/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// The page's side of the rail's "多模型对比" entry, in a browser: the real CompareHost and picker beside a message box, with a
// stand-in for the server. Asked with an empty box it says so and puts the caret in the box; asked with a question it opens the
// picker for it, as the button that used to stand beside the box did; a message a compare cannot take says why.
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, expect as browserExpect, type Browser, type Page } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';

let browser: Browser;
let code: string;
const entry = fileURLToPath(new URL('./__compare_host_fixture__.js', import.meta.url));
const src = fileURLToPath(new URL('../../', import.meta.url));
const STUBS: Record<string, string> = {
  '@/trpc/client': `
    const options = { enabled: true, minModels: 2, maxModels: 3, models: [{ id: 'a', name: '模型甲' }, { id: 'b', name: '模型乙' }, { id: 'c', name: '模型丙' }],
      defaultModelIds: ['a', 'b'] };
    export const trpc = { fusionCompare: { options: { useQuery: () => ({ data: window.__compareOff ? { enabled: false, reason: 'plan' } : options, isError: false }) } } };`,
  '@/lib/turn-fusion': `export const estimateFusion = async () => ({ credits: 40, columns: [{ modelId: 'a', credits: 20, usd: '0.2' }, { modelId: 'b', credits: 20, usd: '0.2' }],
    tooLarge: [], refundCapReached: false, overBudget: false }); export const startCompare = () => { throw new Error('not started in this test'); };`,
  '@/components/paywall/ReportPaywallDialog': `export const ReportPaywallDialog = () => null;`,
  '@/components/opc/query-notice': `export const QueryNotice = () => null;`,
};

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const { build } = await import(pathToFileURL(createRequire(require.resolve('vitest/package.json')).resolve('vite')).href);
  const file = (name: string) => JSON.stringify(fileURLToPath(new URL(name, import.meta.url)));
  const bundle = await build({
    configFile: false, logLevel: 'silent', define: { 'process.env.NODE_ENV': JSON.stringify('development'), 'process.env': '({})' },
    oxc: { jsx: { runtime: 'automatic' } }, resolve: { alias: { '@': src } },
    plugins: [{ name: 'compare-host-fixture', enforce: 'pre', resolveId(id: string) {
      if (id === entry) return id;
      if (id.endsWith('.module.css')) return '\0css-module';
      const path = id.replace(/\.(tsx?|jsx?)$/, '');
      const key = Object.keys(STUBS).find(name => name === id || path.endsWith(name.slice(1)));
      if (key) return `\0stub:${key}`;
    }, load(id: string) {
      if (id === '\0css-module') return `export default new Proxy({}, { get: (_, name) => String(name) });`;
      if (id.startsWith('\0stub:')) return STUBS[id.slice(6)];
      if (id !== entry) return;
      return `import React, { useState } from 'react'; import { createRoot } from 'react-dom/client';
        import { CompareHost } from ${file('./ComparePicker.tsx')};
        import { askCompare } from ${file('./compare-entry.ts')};
        window.askCompare = askCompare;
        function Page() {
          const [question, setQuestion] = useState('');
          return React.createElement('main', null,
            React.createElement(CompareHost, { sessionId: 's1', question, blockedReason: question.includes('@') ? '带 @ 引用资料的消息暂时不能多模型对比，请去掉引用后再试。' : undefined,
              onStarted() {} }),
            React.createElement('div', { contentEditable: true, role: 'textbox', 'aria-label': '消息', suppressContentEditableWarning: true,
              onInput: event => setQuestion(event.currentTarget.textContent ?? ''), style: { minHeight: 40, border: '1px solid #ccc' } }));
        }
        createRoot(document.getElementById('root')).render(React.createElement(Page));`;
    } }],
    build: { write: false, minify: false, lib: { entry, name: 'CompareHostTest', formats: ['iife'] } },
  });
  const output = Array.isArray(bundle) ? bundle[0].output : bundle.output;
  code = output.find((item: { type: string }) => item.type === 'chunk').code;
  browser = await chromium.launch({ headless: true });
}, 60000);
afterAll(async () => { await browser?.close(); }, 30000);

async function open(off = false): Promise<{ page: Page; errors: string[]; ask: () => Promise<boolean> }> {
  const page = await browser.newPage();
  page.setDefaultTimeout(8000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.abort());
  await page.setContent('<html lang="zh-Hans"><head><meta charset="utf-8"></head><body><div id="root"></div></body></html>');
  await page.evaluate(value => { (window as unknown as { __compareOff: boolean }).__compareOff = value; }, off);
  await page.addScriptTag({ content: code });
  await page.getByRole('textbox', { name: '消息' }).waitFor();
  return { page, errors, ask: () => page.evaluate(() => (window as unknown as { askCompare: () => boolean }).askCompare()) };
}

it('draws nothing by itself: the entry is in the rail now, there is no button beside the box', async () => {
  const { page, errors } = await open();
  try {
    await browserExpect(page.getByRole('button', { name: /多模型对比/ })).toHaveCount(0);
    await browserExpect(page.getByRole('status')).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 30000);

it('asked with an empty box: says 先写好问题再对比 and puts the caret in the box; the words go once something is written', async () => {
  const { page, errors, ask } = await open();
  try {
    expect(await ask()).toBe(true);
    await browserExpect(page.getByRole('status')).toHaveText('先写好问题再对比');
    await browserExpect(page.getByRole('textbox', { name: '消息' })).toBeFocused();
    await browserExpect(page.getByRole('dialog')).toHaveCount(0);
    await page.keyboard.type('这周写什么选题');
    await browserExpect(page.getByRole('status')).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 30000);

it('asked with a question written: opens the picker for it, with the default group ticked and the most it can cost', async () => {
  const { page, errors, ask } = await open();
  try {
    await page.getByRole('textbox', { name: '消息' }).click();
    await page.keyboard.type('这周写什么选题');
    expect(await ask()).toBe(true);
    const picker = page.getByRole('dialog', { name: '多模型对比' });
    await browserExpect(picker).toBeVisible();
    await browserExpect(picker.getByRole('checkbox', { name: '模型甲' })).toBeChecked();
    await browserExpect(picker).toContainText('最多消耗 40 积分');
    await browserExpect(picker.getByRole('button', { name: '开始对比' })).toBeEnabled();
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 30000);

it('asked with a message a compare cannot take: says why, and opens nothing', async () => {
  const { page, errors, ask } = await open();
  try {
    await page.getByRole('textbox', { name: '消息' }).click();
    await page.keyboard.type('看看 @品牌介绍.pdf 怎么改');
    await ask();
    await browserExpect(page.getByRole('status')).toContainText('带 @ 引用资料的消息暂时不能多模型对比');
    await browserExpect(page.getByRole('dialog')).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 30000);

it('a plan without the tool: the page does nothing (the rail opens the paywall itself)', async () => {
  const { page, errors, ask } = await open(true);
  try {
    await ask();
    await browserExpect(page.getByRole('status')).toHaveCount(0);
    await browserExpect(page.getByRole('dialog')).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 30000);
