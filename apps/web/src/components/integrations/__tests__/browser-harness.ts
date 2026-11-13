/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// What the integrations page's browser tests stand on: the real page (IntegrationsView and everything under it) built with the
// app's CSS (globals.css through Tailwind, the CSS modules) and a stand-in for the server, served to a real browser together
// with the pictures of the app's public folder. Not a test itself: test support, kept under __tests__ like the library sandbox's.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import tailwind from '@tailwindcss/postcss';
import type { Browser, Page } from '@playwright/test';
import { expect } from 'vitest';

const entry = fileURLToPath(new URL('../__integration_detail_fixture__.js', import.meta.url));
const src = fileURLToPath(new URL('../../../', import.meta.url));
const PUBLIC = fileURLToPath(new URL('../../../../public', import.meta.url));
const STUBS: Record<string, string> = {
  '@/trpc/client': `
    import { useState } from 'react';
    export const trpc = { useUtils: () => ({ connectors: { shotvivaStatus: { invalidate() {} } } }),
      connectors: { shotvivaStatus: { useQuery: () => window.__status },
        shotvivaDisconnect: { useMutation: () => {
          const [isError, setError] = useState(false);
          return { isPending: false, isError, mutate(_input, options) { window.__disconnects = (window.__disconnects || 0) + 1;
            setError(true); options?.onSettled?.(); } };
        } } } };`,
  '@/trpc/read-retry': `export const READ_RETRY = {};`,
  'next/link': `import { createElement } from 'react'; export default function Link({ prefetch, ...props }) { return createElement('a', props); }`,
};
/** Where to save screenshots of what is measured (INTEGRATION_SHOTS=<dir>), read here once for both test files; unset: none. */
export const SHOTS = process.env.INTEGRATION_SHOTS;
export const BALANCE = { credits: 12, freeCredits: 3, paidUntil: null, topUpUrl: 'https://shotviva.com/pricing?from=graylum' };
const STATES = {
  off: { available: false, eligible: true, connected: false, balance: null },
  members: { available: true, eligible: false, connected: false, balance: null },
  ready: { available: true, eligible: true, connected: false, balance: null },
  connected: { available: true, eligible: true, connected: true, balance: BALANCE },
} as const;
export type StateName = keyof typeof STATES | 'loading' | 'failed';

/** The integrations page as one HTML document: the real components, the app's compiled CSS, the server stood in for. */
export async function buildIntegrationsPage(): Promise<string> {
  const require = createRequire(import.meta.url);
  const { build } = await import(pathToFileURL(createRequire(require.resolve('vitest/package.json')).resolve('vite')).href);
  const file = (name: string) => JSON.stringify(fileURLToPath(new URL(name, import.meta.url)));
  const bundle = await build({
    configFile: false, logLevel: 'silent', define: { 'process.env.NODE_ENV': JSON.stringify('development'), 'process.env': '({})' },
    oxc: { jsx: { runtime: 'automatic' } }, css: { postcss: { plugins: [tailwind({ base: src })] } }, resolve: { alias: { '@': src } },
    plugins: [{ name: 'integration-detail-fixture', enforce: 'pre', resolveId(id: string) {
      if (id === entry) return id;
      const path = id.replace(/\.(tsx?|jsx?)$/, '');
      const key = Object.keys(STUBS).find(name => name === id || (name.startsWith('@/') && path.endsWith(name.slice(1))));
      if (key) return `\0stub:${key}`;
    }, load(id: string) {
      if (id.startsWith('\0stub:')) return STUBS[id.slice(6)];
      if (id !== entry) return;
      // The page as the workbench shows it: the light, warm canvas the cards sit on.
      return `import React from 'react'; import { createRoot } from 'react-dom/client';
        import ${file('../../../app/globals.css')};
        import { IntegrationsView } from ${file('../IntegrationsView.tsx')};
        createRoot(document.getElementById('root')).render(React.createElement('div', { style: { height: '100vh', background: '#f7f5f1' } },
          React.createElement(IntegrationsView, { result: {} })));`;
    } }],
    build: { write: false, minify: false, cssCodeSplit: false, lib: { entry, name: 'IntegrationDetailTest', formats: ['iife'] } },
  });
  const output: { type: string; fileName: string; code?: string; source?: string }[] = Array.isArray(bundle) ? bundle[0].output : bundle.output;
  const code = output.find(item => item.type === 'chunk')?.code ?? '';
  const css = String(output.find(item => item.fileName.endsWith('.css'))?.source ?? '');
  return `<!doctype html><html lang="zh-Hans"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<style>${css}</style></head><body style="margin:0"><div id="root"></div><script>${code.replace(/<\/script/g, '<\\/script')}</script></body></html>`;
}

export type Opened = {
  page: Page; errors: string[];
  /** The small sample pictures the page has asked the server for, in order, by file name. */
  asked: string[];
  /** The large ones, the same way. */
  askedLarge: string[];
};

/**
 * The integrations page with Shotviva in the given state, and its introduction opened from its card. `touch`: a phone's
 * screen, which takes fingers. `slowLarge`: the large pictures take this long to arrive.
 */
export async function openIntroduction(browser: Browser, html: string, state: StateName, width: number, height = 780,
  options: { touch?: boolean; slowLarge?: number } = {}): Promise<Opened> {
  const page = await browser.newPage({ viewport: { width, height }, hasTouch: !!options.touch });
  page.setDefaultTimeout(8000);
  const errors: string[] = [];
  const asked: string[] = [];
  const askedLarge: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/app/integrations') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
    // The two marks, as the app serves them from its public folder.
    if (path === '/integrations/shotviva.png' || path === '/graylum-logo.png') {
      return route.fulfill({ contentType: 'image/png', body: readFileSync(PUBLIC + path) });
    }
    // Shotviva's sample pictures, the same way: the small ones, and the large ones of the large view.
    const sample = /^\/integrations\/shotviva\/(large\/)?([a-z-]+)\.webp$/.exec(path);
    if (sample) {
      (sample[1] ? askedLarge : asked).push(sample[2]!);
      if (sample[1] && options.slowLarge) await new Promise(resolve => setTimeout(resolve, options.slowLarge));
      return route.fulfill({ contentType: 'image/webp', body: readFileSync(PUBLIC + path) });
    }
    return route.abort();
  });
  const status = state === 'loading' ? { data: undefined, isLoading: true } : state === 'failed' ? { data: undefined, isLoading: false }
    : { data: STATES[state], isLoading: false };
  await page.addInitScript(value => { (window as unknown as { __status: unknown }).__status = value; }, status);
  await page.goto('https://app.test/app/integrations');
  // Nothing of the introduction is fetched for a page whose card has not been opened.
  expect([asked, askedLarge]).toEqual([[], []]);
  await page.getByRole('button', { name: /Shotviva/ }).click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  await page.waitForFunction(() => document.querySelector('[role=dialog]')!.getAnimations().every(animation => animation.playState === 'finished'));
  // The click leaves the keyboard's focus ring on the close button; a person who clicked with a mouse does not see one.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  return { page, errors, asked, askedLarge };
}
