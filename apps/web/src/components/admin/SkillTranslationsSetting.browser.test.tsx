/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, expect as browserExpect, type Browser, type Page } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';

let browser: Browser;
let code: string;
const entry = fileURLToPath(new URL('./__skill_translations_fixture__.js', import.meta.url));
const MODULE = '33333333-3333-4333-8333-333333333333';

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const vite = createRequire(require.resolve('vitest/package.json')).resolve('vite');
  const { build } = await import(pathToFileURL(vite).href);
  const source = fileURLToPath(new URL('./SkillTranslationsSetting.tsx', import.meta.url));
  // Server double: window.stored is modules.display_translations; window.updates records saves.
  const mock = `
    import {useState, useSyncExternalStore} from 'react';
    const listeners = new Set(); const notify = () => listeners.forEach(fn => fn());
    const subscribe = fn => { listeners.add(fn); return () => listeners.delete(fn); };
    window.updates = [];
    const row = () => ({moduleId: '${MODULE}', moduleUpdatedAt: window.version, source: window.source, translations: window.stored});
    let snapshot = null; const current = () => snapshot ??= row();
    export const trpc = {
      useUtils: () => ({skillTranslations: {get: {setData: (_input, value) => { snapshot = value; notify(); }}}}),
      skillTranslations: {
        get: {useQuery: () => {
          const data = useSyncExternalStore(subscribe, current);
          return {data, isLoading: false, isError: false, error: null, refetch: async () => { snapshot = row(); notify(); }};
        }},
        update: {useMutation: () => {
          const [isPending, setPending] = useState(false);
          return {isPending, mutateAsync: async input => {
            window.updates.push(input); setPending(true);
            try {
              if (input.expectedModuleUpdatedAt !== window.version) throw new Error('SKILL_TRANSLATIONS_CONFLICT');
              if (window.updateFails) throw new Error(window.updateFails);
              window.stored = Object.keys(input.translations).length ? {en: input.translations} : {};
              window.version = 'v' + window.updates.length;
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
    plugins: [{ name: 'skill-translations-fixture', enforce: 'pre', resolveId(id: string) {
      if (id === entry) return id;
      if (id === '@/trpc/client' || id.endsWith('/trpc/client')) return '\0skill-translations-trpc';
    }, load(id: string) {
      if (id === '\0skill-translations-trpc') return mock;
      if (id === entry) return `import React from 'react'; import { createRoot } from 'react-dom/client';
        import {SkillTranslationsSetting} from ${JSON.stringify(source)};
        window.adopted = [];
        function Host() {
          const [opened, setOpened] = React.useState(window.opened);
          return React.createElement(SkillTranslationsSetting, {moduleId: window.moduleId, moduleUpdatedAt: opened,
            onVersion: v => { window.adopted.push(v); setOpened(v); }});
        }
        createRoot(document.getElementById('root')).render(React.createElement(Host));`;
    } }],
    build: { write: false, minify: false, lib: { entry, name: 'SkillTranslationsTest', formats: ['iife'] } },
  });
  const output = Array.isArray(bundle) ? bundle[0].output : bundle.output;
  code = output.find((item: { type: string }) => item.type === 'chunk').code;
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch({ executablePath: existsSync(chrome) ? chrome : undefined, headless: true });
}, 30000);
afterAll(async () => { await browser?.close(); }, 30000);

const SOURCE = { reportTitle: '账号定位报告', reportSections: ['定位结论'], steps: [
  { id: 'step-1', title: '了解你', fields: [{ id: 'goal', title: '目标' }] },
] };
async function open(setup: Record<string, unknown>) {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.abort());
  await page.setContent('<div id="root"></div>');
  await page.evaluate(value => { Object.assign(window, value); },
    { moduleId: MODULE, source: SOURCE, stored: {}, version: 'v0', opened: 'v0', ...setup });
  await page.addScriptTag({ content: code });
  return { page, errors };
}
const updates = (page: Page) => page.evaluate('window.updates');
const save = (page: Page) => page.getByTestId('skill-translations-save');
const notice = (page: Page) => page.getByTestId('skill-translations-notice');

it('lists each Chinese original, saves the English typed, then clears it, sending the module version it holds', async () => {
  const { page, errors } = await open({});
  try {
    for (const original of ['账号定位报告', '了解你', '目标', '定位结论']) await browserExpect(page.getByText(original)).toBeVisible();
    await browserExpect(save(page)).toBeDisabled();
    await page.getByTestId('skill-translation-step:step-1').fill(' About you ');
    await page.getByTestId('skill-translation-field:step-1:goal').fill('Goal');
    await save(page).click();
    await browserExpect(notice(page)).toContainText('已保存英文对照');
    await browserExpect(page.getByTestId('skill-translation-step:step-1')).toHaveValue('About you');
    await browserExpect(save(page)).toBeDisabled();
    await page.getByTestId('skill-translation-step:step-1').fill('');
    await page.getByTestId('skill-translation-field:step-1:goal').fill('');
    await save(page).click();
    await browserExpect(notice(page)).toContainText('已保存英文对照');
    expect(await updates(page)).toEqual([
      { moduleId: MODULE, locale: 'en', expectedModuleUpdatedAt: 'v0',
        translations: { steps: { 'step-1': { original: '了解你', text: 'About you' } },
          fields: { 'step-1': { goal: { original: '目标', text: 'Goal' } } } } },
      { moduleId: MODULE, locale: 'en', expectedModuleUpdatedAt: 'v1', translations: {} },
    ]);
    // The editor adopts exactly the versions its own saves produced.
    expect(await page.evaluate('window.adopted')).toEqual(['v1', 'v2']);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 20000);

it('shows saved English, refuses a stale editor and an invalid input in plain Chinese, adopting nothing', async () => {
  const { page, errors } = await open({ version: 'v9', stored: { en: { reportTitle: { original: '账号定位报告', text: 'Positioning report' } } } });
  try {
    await browserExpect(page.getByTestId('skill-translation-reportTitle')).toHaveValue('Positioning report');
    await page.getByTestId('skill-translation-section:0').fill('x'.repeat(161));
    await save(page).click();
    await browserExpect(notice(page)).toContainText('最多 160 个字符');
    expect(await updates(page)).toEqual([]);
    await page.getByTestId('skill-translation-section:0').fill('Positioning');
    await save(page).click();
    await browserExpect(notice(page)).toContainText('请关闭窗口重新打开');
    await browserExpect(notice(page)).not.toContainText('SKILL_');
    expect(await page.evaluate('window.adopted')).toEqual([]);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 20000);

it('asks to publish first when there is no workflow, and renders nothing without a module', async () => {
  const { page, errors } = await open({ source: null });
  try {
    await browserExpect(page.getByTestId('skill-translations-setting')).toContainText('发布后才能填写英文对照');
    await browserExpect(save(page)).toHaveCount(0);
    await page.close();
    const second = await open({ moduleId: undefined });
    await browserExpect(second.page.getByTestId('skill-translations-setting')).toHaveCount(0);
    expect([...errors, ...second.errors]).toEqual([]);
    await second.page.close();
  } finally { if (!page.isClosed()) await page.close(); }
}, 30000);
