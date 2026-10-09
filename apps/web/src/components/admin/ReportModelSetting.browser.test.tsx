/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, expect as browserExpect, type Browser, type Page } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';

let browser: Browser;
let code: string;
const entry = fileURLToPath(new URL('./__report_model_fixture__.js', import.meta.url));
const MODULE = '33333333-3333-4333-8333-333333333333';
const DIALOGUE = '11111111-1111-4111-8111-111111111111';
const REPORT = '22222222-2222-4222-8222-222222222222';

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const vite = createRequire(require.resolve('vitest/package.json')).resolve('vite');
  const { build } = await import(pathToFileURL(vite).href);
  const source = fileURLToPath(new URL('./ReportModelSetting.tsx', import.meta.url));
  // Server double: window.stored is modules.report_model_id; window.updates records saves.
  const mock = `
    import {useState, useSyncExternalStore} from 'react';
    const listeners = new Set(); const notify = () => listeners.forEach(fn => fn());
    const subscribe = fn => { listeners.add(fn); return () => listeners.delete(fn); };
    window.updates = []; window.reads = 0;
    const row = () => ({moduleId: '${MODULE}', dialogueModelId: '${DIALOGUE}', reportModelId: window.stored,
      effectiveModelId: window.stored ?? '${DIALOGUE}'});
    let snapshot = null; const current = () => snapshot ??= row();
    export const trpc = {
      useUtils: () => ({reportModel: {get: {setData: (_input, value) => { snapshot = value; notify(); }}}}),
      settings: {getSummaryModels: {useQuery: () => ({data: [{id: '${DIALOGUE}', name: '模型 A'}, {id: '${REPORT}', name: '模型 B'}]})}},
      reportModel: {
        get: {useQuery: () => {
          const data = useSyncExternalStore(subscribe, current);
          return {data, isLoading: false, isError: false, error: null,
            refetch: async () => { window.reads++; snapshot = row(); notify(); }};
        }},
        options: {useQuery: () => ({data: {models: window.options}, isLoading: false, isError: false, refetch: async () => {}})},
        update: {useMutation: () => {
          const [isPending, setPending] = useState(false);
          return {isPending, mutateAsync: async input => {
            window.updates.push(input); setPending(true);
            try {
              if (window.serverStored !== undefined && input.expectedReportModelId !== window.serverStored) {
                window.stored = window.serverStored;
                throw new Error('REPORT_MODEL_CONFLICT');
              }
              if (window.updateFails) throw new Error(window.updateFails);
              window.stored = input.reportModelId;
              return row();
            } finally { setPending(false); }
          }};
        }},
      },
    };
  `;
  const bundle = await build({
    configFile: false, logLevel: 'silent', define: { 'process.env.NODE_ENV': JSON.stringify('development') },
    oxc: { jsx: { runtime: 'automatic' } },
    resolve: { alias: { '@': fileURLToPath(new URL('../../', import.meta.url)) } },
    plugins: [{ name: 'report-model-fixture', enforce: 'pre', resolveId(id: string) {
      if (id === entry) return id;
      if (id === '@/trpc/client' || id.endsWith('/trpc/client')) return '\0report-model-trpc';
    }, load(id: string) {
      if (id === '\0report-model-trpc') return mock;
      if (id === entry) return `import React from 'react'; import { createRoot } from 'react-dom/client';
        import {ReportModelSetting} from ${JSON.stringify(source)};
        createRoot(document.getElementById('root')).render(React.createElement(ReportModelSetting,
          {moduleId: window.moduleId, hasReport: window.hasReport}));`;
    } }],
    build: { write: false, minify: false, lib: { entry, name: 'ReportModelTest', formats: ['iife'] } },
  });
  const output = Array.isArray(bundle) ? bundle[0].output : bundle.output;
  code = output.find((item: { type: string }) => item.type === 'chunk').code;
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch({ executablePath: existsSync(chrome) ? chrome : undefined, headless: true });
}, 30000);
afterAll(async () => { await browser?.close(); }, 30000);

async function open(setup: Record<string, unknown>) {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.abort());
  await page.setContent('<div id="root"></div>');
  await page.evaluate(value => { Object.assign(window, value); },
    { moduleId: MODULE, hasReport: true, stored: null, options: [{ id: REPORT, name: '模型 B', model: 'b' }], ...setup });
  await page.addScriptTag({ content: code });
  return { page, errors };
}
const updates = (page: Page) => page.evaluate('window.updates');

it('shows the dialogue model and that the report follows it by default, then saves a separate report model', async () => {
  const { page, errors } = await open({});
  try {
    await browserExpect(page.getByTestId('report-model-dialogue')).toHaveText('模型 A');
    await browserExpect(page.getByTestId('report-model-effective')).toHaveText('模型 A（沿用对话模型）');
    await browserExpect(page.getByRole('combobox', { name: '写报告用的模型' })).toHaveText('沿用对话模型');
    await browserExpect(page.getByTestId('report-model-save')).toBeDisabled();
    await page.getByRole('combobox', { name: '写报告用的模型' }).click();
    await page.getByRole('option', { name: '模型 B' }).click();
    await page.getByTestId('report-model-save').click();
    await browserExpect(page.getByTestId('report-model-notice')).toContainText('已保存');
    await browserExpect(page.getByTestId('report-model-effective')).toHaveText('模型 B');
    expect(await updates(page)).toEqual([{ moduleId: MODULE, reportModelId: REPORT, expectedReportModelId: null }]);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 20000);

it('clears back to the dialogue model with null, sending the value it read', async () => {
  const { page, errors } = await open({ stored: REPORT });
  try {
    await browserExpect(page.getByTestId('report-model-effective')).toHaveText('模型 B');
    await page.getByRole('combobox', { name: '写报告用的模型' }).click();
    await page.getByRole('option', { name: '沿用对话模型' }).click();
    await page.getByTestId('report-model-save').click();
    await browserExpect(page.getByTestId('report-model-effective')).toHaveText('模型 A（沿用对话模型）');
    expect(await updates(page)).toEqual([{ moduleId: MODULE, reportModelId: null, expectedReportModelId: REPORT }]);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 20000);

it('on a conflict tells the admin to reload, and reload shows the newer setting', async () => {
  // Another admin already saved REPORT; this page still believes nothing is set.
  const { page, errors } = await open({ serverStored: REPORT });
  try {
    await page.getByRole('combobox', { name: '写报告用的模型' }).click();
    await page.getByRole('option', { name: '模型 B' }).click();
    await page.getByTestId('report-model-save').click();
    await browserExpect(page.getByTestId('report-model-notice')).toContainText('刚被其他人改过');
    await page.getByRole('button', { name: '重新读取' }).click();
    await browserExpect(page.getByTestId('report-model-effective')).toHaveText('模型 B');
    await browserExpect(page.getByTestId('report-model-save')).toBeDisabled();
    expect(await updates(page)).toHaveLength(1);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 20000);

it('explains a server refusal in plain Chinese and never shows the raw code', async () => {
  const { page, errors } = await open({ updateFails: 'REPORT_MODEL_PRICING_UNAVAILABLE' });
  try {
    await page.getByRole('combobox', { name: '写报告用的模型' }).click();
    await page.getByRole('option', { name: '模型 B' }).click();
    await page.getByTestId('report-model-save').click();
    await browserExpect(page.getByTestId('report-model-notice')).toContainText('报价缺失或已过期');
    await browserExpect(page.getByTestId('report-model-notice')).not.toContainText('REPORT_');
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 20000);

it('shows a saved model that is no longer eligible as unavailable, and renders nothing without a report', async () => {
  const { page, errors } = await open({ stored: REPORT, options: [] });
  try {
    await page.getByRole('combobox', { name: '写报告用的模型' }).click();
    await browserExpect(page.getByRole('option', { name: '模型 B（当前不可选）' })).toBeDisabled();
    await page.keyboard.press('Escape');
    await page.close();
    const second = await open({ hasReport: false });
    await browserExpect(second.page.getByTestId('report-model-setting')).toHaveCount(0);
    expect([...errors, ...second.errors]).toEqual([]);
    await second.page.close();
  } finally { if (!page.isClosed()) await page.close(); }
}, 30000);
