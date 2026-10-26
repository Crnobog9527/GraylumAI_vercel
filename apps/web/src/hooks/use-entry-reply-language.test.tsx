/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, expect as browserExpect, type Browser } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';

/*
 * CHAT-LANGUAGE: the notice after entering the app from the Traditional Chinese site, in a real browser. The page really is
 * loaded twice (a new root layout), the hook sits before the Toaster exactly as in RootDocument, and storage persists between
 * the two loads. A toast sent before the Toaster has subscribed is lost, which is what this guards.
 */
let browser: Browser;
let code: string;
const entry = fileURLToPath(new URL('./__entry_language_fixture__.js', import.meta.url));
beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const vite = createRequire(require.resolve('vitest/package.json')).resolve('vite');
  const { build } = await import(pathToFileURL(vite).href);
  const hook = fileURLToPath(new URL('./use-entry-reply-language.ts', import.meta.url));
  const toaster = fileURLToPath(new URL('../components/ui/sonner.tsx', import.meta.url));
  const bundle = await build({
    configFile: false, logLevel: 'silent', define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    oxc: { jsx: { runtime: 'automatic', development: false } },
    resolve: { alias: { '@/lib/entry-language': fileURLToPath(new URL('../lib/entry-language.ts', import.meta.url)),
      '@repo/api': fileURLToPath(new URL('../../../../packages/api', import.meta.url)) } },
    plugins: [{ name: 'entry-language-fixture', enforce: 'pre', resolveId(id: string) {
      if (id === entry) return id;
      if (id === '@/trpc/client') return '\0trpc';
      if (id === '@/lib/supabase') return '\0supabase';
      if (id === 'next/navigation') return '\0navigation';
    }, load(id: string) {
      if (id === '\0trpc') return `const profile = { invalidate: async () => {} };
        export const trpc = { useUtils: () => ({ user: { getUserProfile: profile },
          client: { user: { applyEntryReplyLanguage: { mutate: async input => ({ language: input.language, previous: 'zh-Hans' }) } } } }) };`;
      if (id === '\0supabase') return 'export const createClient = () => ({ auth: { getSession: async () => ({ data: { session: { user: { id: "u" } } } }) } });';
      if (id === '\0navigation') return 'export const usePathname = () => location.pathname;';
      if (id === entry) return `import React from 'react'; import { createRoot } from 'react-dom/client';
        import { EntryReplyLanguage } from ${JSON.stringify(hook)}; import { Toaster } from ${JSON.stringify(toaster)};
        createRoot(document.getElementById('root')).render(React.createElement(React.Fragment, null,
          React.createElement(EntryReplyLanguage), React.createElement(Toaster)));`;
    } }],
    build: { write: false, minify: false, lib: { entry, name: 'EntryLanguageTest', formats: ['iife'] } },
  });
  const output = Array.isArray(bundle) ? bundle[0].output : bundle.output;
  code = output.find((item: { type: string }) => item.type === 'chunk').code;
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch({ executablePath: existsSync(chrome) ? chrome : undefined, headless: true });
}, 60000);
afterAll(async () => { await browser?.close(); }, 30000);

const page_html = '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>';
const serve = (page: import('@playwright/test').Page) => page.route('https://app.test/**', route => route.fulfill(
  route.request().url().endsWith('/bundle.js') ? { contentType: 'text/javascript; charset=utf-8', body: code } : { contentType: 'text/html', body: page_html }));
async function load(page: import('@playwright/test').Page, path: string) {
  await page.goto(`https://app.test${path}`);
}

it('shows the language notice after the server saved it, on the load that stays (zh-tw entry, third report)', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await serve(page);
  try {
    // Load 1: the server redirect carried entry_notice. The page is replaced right after (a new root layout).
    await load(page, '/app/positioning?entry_notice=zh-Hans.zh-Hant');
    await browserExpect(page.getByText('AI 回复语言：繁體中文')).toBeVisible({ timeout: 5000 });
    expect(page.url()).not.toContain('entry_notice');
    // Load 2: a fresh document, no parameters; storage is what the first load left behind.
    await load(page, '/app/positioning');
    await browserExpect(page.getByText('AI 回复语言：繁體中文')).toBeVisible({ timeout: 5000 });
    await browserExpect(page.getByText('已按你进入的页面，从简体中文改为繁體中文')).toBeVisible();
    const change = JSON.parse(await page.evaluate("localStorage.getItem('graylum.entry-language.change')") as string);
    expect(change).toMatchObject({ from: 'zh-Hans', to: 'zh-Hant', shows: 2 });
    // A third load changes nothing: the notice is not repeated forever.
    await load(page, '/app/positioning');
    await page.waitForTimeout(1500);
    await browserExpect(page.getByText('AI 回复语言：繁體中文')).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { await context.close(); }
}, 30000);

it('shows the notice when the language is passed on as entry_lang and applied after sign-in', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await serve(page);
  try {
    await load(page, '/app/positioning?entry_lang=zh-Hant');
    await browserExpect(page.getByText('AI 回复语言：繁體中文')).toBeVisible({ timeout: 5000 });
    expect(page.url()).not.toContain('entry_lang');
  } finally { await context.close(); }
}, 30000);
