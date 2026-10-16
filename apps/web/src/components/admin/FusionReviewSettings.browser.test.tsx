/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, expect as ui, type Browser } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';

// The jury admin card against fusionSettings answers shaped like the API's; nothing is saved anywhere.
let browser: Browser;
let code: string;
const entry = fileURLToPath(new URL('./__fusion_review_settings_fixture__.js', import.meta.url));
const M = (n: number) => `40000000-0000-4000-8000-00000000000${n}`;
const SAVED = { version: 1, compare: { enabled: false }, review: {
  enabled: true, reviewerModelIds: [M(1), M(2), M(3)], summaryModelId: M(4), skillId: M(5), maxRounds: 2, opinionOutputTokens: 4096,
  summaryOutputTokens: 32768, maxBudgetUsd: '0.5', dispatchMinutes: 10, breaker: { platformUsd: '2', noDeliveryCalls: 10 },
  displayNames: { reviewers: ['目标用户', '操盘手', '挑刺审核人'], summary: '主笔' } } };
const MODELS = { models: [1, 2, 3, 4, 6].map(n => ({ id: M(n), name: `模型 ${n}`, model: `vendor${n}/model` })) };
const SKILLS = { total: 2, skills: [
  { id: M(5), skill_key: 'fusion-review', status: 'published', published_version: 3 },
  { id: M(7), skill_key: 'draft-skill', status: 'draft', published_version: 0 },
] };

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const { build } = await import(pathToFileURL(createRequire(require.resolve('vitest/package.json')).resolve('vite')).href);
  const source = fileURLToPath(new URL('./FusionReviewSettings.tsx', import.meta.url));
  const client = fileURLToPath(new URL('../../trpc/client.ts', import.meta.url));
  const bundle = await build({ configFile: false, logLevel: 'silent',
    define: { 'process.env.NODE_ENV': JSON.stringify('development') },
    oxc: { jsx: { runtime: 'automatic' } },
    resolve: { alias: { '@': fileURLToPath(new URL('../../', import.meta.url)) } },
    plugins: [{ name: 'fusion-review-settings-fixture', enforce: 'pre',
      resolveId(id: string) { if (id === entry) return id; },
      load(id: string) {
        if (id !== entry) return;
        return `import React from 'react'; import {createRoot} from 'react-dom/client';
          import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
          import {httpLink} from '@trpc/client'; import {trpc} from ${JSON.stringify(client)};
          import {FusionReviewSettings} from ${JSON.stringify(source)};
          const queryClient=new QueryClient({defaultOptions:{queries:{retry:false}}});
          const client=trpc.createClient({links:[httpLink({url:'http://localhost/api/trpc'})]});
          createRoot(document.getElementById('root')).render(React.createElement(trpc.Provider,{client,queryClient},
            React.createElement(QueryClientProvider,{client:queryClient},React.createElement(FusionReviewSettings))));`;
      } }],
    build: { write: false, minify: false, lib: { entry, name: 'FusionReviewSettingsTest', formats: ['iife'] } },
  });
  const output = Array.isArray(bundle) ? bundle[0].output : bundle.output;
  code = output.find((item: { type: string }) => item.type === 'chunk').code;
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch({ executablePath: existsSync(chrome) ? chrome : undefined, headless: true });
}, 60000);
afterAll(async () => { await browser?.close(); }, 30000);

async function open(opts: { running?: number; refuse?: string; warnings?: string[] } = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  page.setDefaultTimeout(5000);
  const errors: string[] = [];
  const updates: unknown[] = [];
  const dialogs: string[] = [];
  const calls: Record<string, number> = {};
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/') return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
    const name = path.split('/').pop() ?? '';
    calls[name] = (calls[name] ?? 0) + 1;
    if (name === 'fusionSettings.update') {
      updates.push(JSON.parse(route.request().postData() ?? '{}'));
      if (opts.refuse) {
        return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: { message: opts.refuse,
          code: -32600, data: { code: 'BAD_REQUEST', httpStatus: 400, path: name } } }) });
      }
    }
    const result = name === 'fusionSettings.get' ? SAVED : name === 'reportModel.options' ? MODELS : name === 'skills.list' ? SKILLS
      : name === 'settings.getSummaryModels' ? [] : name === 'fusionSettings.reviews'
        ? Array.from({ length: opts.running ?? 0 }, () => ({ state: 'running' })).concat([{ state: 'completed' }])
        : name === 'fusionSettings.update' ? { settings: SAVED, warnings: opts.warnings ?? [] } : null;
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ result: { data: result } }) });
  });
  await page.goto('http://localhost/');
  await page.addScriptTag({ content: code });
  await ui(page.getByLabel('评审 C 的显示名')).toHaveValue('挑刺审核人', { timeout: 8000 });
  return { page, errors, updates, dialogs, calls };
}

it('shows the saved panel, lists only published Skills, and saves a renamed seat without asking about running reviews', async () => {
  const { page, errors, updates, calls } = await open({ running: 2 });
  try {
    expect(await page.locator('#fusion-skill option').allTextContents()).toEqual(['未选择', 'fusion-review（第 3 版）']);
    await ui(page.getByRole('button', { name: '保存评审团设置' })).toBeDisabled();
    await page.getByLabel('汇总的显示名').fill('  首席主笔 ');
    await page.getByRole('button', { name: '保存评审团设置' }).click();
    await ui(page.getByText('已保存。新开始的评审使用这个设置。')).toBeVisible();
    expect(calls['fusionSettings.reviews'] ?? 0).toBe(0);
    expect(updates).toEqual([expect.objectContaining({ review: expect.objectContaining({
      displayNames: { reviewers: ['目标用户', '操盘手', '挑刺审核人'], summary: '首席主笔' } }) })]);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 30000);

it('warns how many reviews are running before a model change, and saves nothing when the admin cancels', async () => {
  const { page, errors, updates } = await open({ running: 2, warnings: ['FUSION_REVIEWERS_SAME_PROVIDER'] });
  try {
    const seen: string[] = [];
    page.once('dialog', dialog => { seen.push(dialog.message()); void dialog.dismiss(); });
    await page.locator('#fusion-model-C').selectOption(M(6));
    await page.getByRole('button', { name: '保存评审团设置' }).click();
    await page.waitForTimeout(300);
    expect(seen).toEqual(['有 2 个评审正在进行，保存后它们的后续轮次会失败。确定保存吗？']);
    expect(updates).toEqual([]);
    page.once('dialog', dialog => void dialog.accept());
    await page.getByRole('button', { name: '保存评审团设置' }).click();
    await ui(page.getByText(/同一家公司/)).toBeVisible();
    expect(updates).toEqual([expect.objectContaining({ review: expect.objectContaining({ reviewerModelIds: [M(1), M(2), M(6)] }) })]);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 30000);

it('blocks turning on an incomplete panel and explains a refused save in plain words', async () => {
  const { page, errors, updates } = await open({ refuse: 'FUSION_MODEL_ADMISSION_REQUIRED' });
  try {
    await page.locator('#fusion-model-A').selectOption('');
    await ui(page.getByText(/开启评审团前/)).toBeVisible();
    await ui(page.getByRole('button', { name: '保存评审团设置' })).toBeDisabled();
    await page.locator('#fusion-model-A').selectOption(M(1));
    await page.locator('#fusion-rounds').selectOption('1');
    await page.getByRole('button', { name: '保存评审团设置' }).click();
    await ui(page.getByText(/还没有准入评审/)).toBeVisible();
    expect(updates).toHaveLength(1);
    await ui(page.getByText('FUSION_MODEL_ADMISSION_REQUIRED')).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 30000);
