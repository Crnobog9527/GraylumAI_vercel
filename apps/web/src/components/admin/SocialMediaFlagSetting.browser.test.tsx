/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, expect as browserExpect, type Browser, type Page } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';

let browser: Browser;
let code: string;
const entry = fileURLToPath(new URL('./__social_media_flag_fixture__.js', import.meta.url));
const MODULE = '33333333-3333-4333-8333-333333333333';

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const vite = createRequire(require.resolve('vitest/package.json')).resolve('vite');
  const { build } = await import(pathToFileURL(vite).href);
  const source = fileURLToPath(new URL('./SocialMediaFlagSetting.tsx', import.meta.url));
  // Server double: window.stored is modules.social_media_related; window.updates records saves.
  const mock = `
    import {useState, useSyncExternalStore} from 'react';
    const listeners = new Set(); const notify = () => listeners.forEach(fn => fn());
    const subscribe = fn => { listeners.add(fn); return () => listeners.delete(fn); };
    window.updates = [];
    const row = () => ({moduleId: '${MODULE}', socialMediaRelated: window.stored});
    let snapshot = null; const current = () => snapshot ??= row();
    export const trpc = {
      useUtils: () => ({socialMediaFlag: {get: {setData: (_input, value) => { snapshot = value; notify(); }}}}),
      socialMediaFlag: {
        get: {useQuery: () => {
          const data = useSyncExternalStore(subscribe, current);
          return {data, isLoading: false, isError: false, error: null, refetch: async () => { snapshot = row(); notify(); }};
        }},
        update: {useMutation: () => {
          const [isPending, setPending] = useState(false);
          return {isPending, mutateAsync: async input => {
            window.updates.push(input); setPending(true);
            try {
              if (window.serverStored !== undefined && input.expectedSocialMediaRelated !== window.serverStored) {
                window.stored = window.serverStored;
                throw new Error('SOCIAL_MEDIA_FLAG_CONFLICT');
              }
              if (window.updateFails) throw new Error(window.updateFails);
              window.stored = input.socialMediaRelated;
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
    plugins: [{ name: 'social-media-flag-fixture', enforce: 'pre', resolveId(id: string) {
      if (id === entry) return id;
      if (id === '@/trpc/client' || id.endsWith('/trpc/client')) return '\0social-media-flag-trpc';
    }, load(id: string) {
      if (id === '\0social-media-flag-trpc') return mock;
      if (id === entry) return `import React from 'react'; import { createRoot } from 'react-dom/client';
        import {SocialMediaFlagSetting} from ${JSON.stringify(source)};
        window.syncs = 0;
        createRoot(document.getElementById('root')).render(React.createElement(SocialMediaFlagSetting,
          {moduleId: window.moduleId, onSaved: async () => { window.syncs++; return window.syncFails !== true; }}));`;
    } }],
    build: { write: false, minify: false, lib: { entry, name: 'SocialMediaFlagTest', formats: ['iife'] } },
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
  await page.evaluate(value => { Object.assign(window, value); }, { moduleId: MODULE, stored: false, ...setup });
  await page.addScriptTag({ content: code });
  return { page, errors };
}
const updates = (page: Page) => page.evaluate('window.updates');
const box = (page: Page) => page.getByRole('checkbox', { name: '与社交媒体相关' });

it('starts unchecked, saves on, then saves off, sending the value it read each time', async () => {
  const { page, errors } = await open({});
  try {
    await browserExpect(box(page)).not.toBeChecked();
    await browserExpect(page.getByTestId('social-media-flag-save')).toBeDisabled();
    await box(page).check();
    await page.getByTestId('social-media-flag-save').click();
    await browserExpect(page.getByTestId('social-media-flag-notice')).toContainText('导入已有定位');
    await browserExpect(box(page)).toBeChecked();
    await browserExpect(page.getByTestId('social-media-flag-save')).toBeDisabled();
    await box(page).uncheck();
    await page.getByTestId('social-media-flag-save').click();
    await browserExpect(page.getByTestId('social-media-flag-notice')).toContainText('不再要求');
    expect(await updates(page)).toEqual([
      { moduleId: MODULE, socialMediaRelated: true, expectedSocialMediaRelated: false },
      { moduleId: MODULE, socialMediaRelated: false, expectedSocialMediaRelated: true },
    ]);
    expect(await page.evaluate('window.syncs')).toBe(2);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 20000);

it('on a conflict tells the admin to reload, and reload shows the newer setting', async () => {
  const { page, errors } = await open({ serverStored: true });
  try {
    await box(page).check();
    await page.getByTestId('social-media-flag-save').click();
    await browserExpect(page.getByTestId('social-media-flag-notice')).toContainText('刚被其他人改过');
    await page.getByRole('button', { name: '重新读取' }).click();
    await browserExpect(box(page)).toBeChecked();
    await browserExpect(page.getByTestId('social-media-flag-save')).toBeDisabled();
    expect(await updates(page)).toHaveLength(1);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 20000);

it('explains a refusal in plain Chinese, keeps the module version, and renders nothing without a module', async () => {
  const { page, errors } = await open({ updateFails: 'SOCIAL_MEDIA_FLAG_UNAVAILABLE' });
  try {
    await box(page).check();
    await page.getByTestId('social-media-flag-save').click();
    await browserExpect(page.getByTestId('social-media-flag-notice')).toContainText('暂时无法读取或保存');
    await browserExpect(page.getByTestId('social-media-flag-notice')).not.toContainText('SOCIAL_');
    expect(await page.evaluate('window.syncs')).toBe(0);
    await page.close();
    const second = await open({ moduleId: undefined });
    await browserExpect(second.page.getByTestId('social-media-flag-setting')).toHaveCount(0);
    expect([...errors, ...second.errors]).toEqual([]);
    await second.page.close();
  } finally { if (!page.isClosed()) await page.close(); }
}, 30000);
