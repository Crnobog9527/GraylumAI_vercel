/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { chromium } from '@playwright/test';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Actual page components with synthetic read-only API results. No live accounts or services.
it('checks return links, maintenance recovery and escaped ticket previews in Chromium', async () => {
  const require = createRequire(import.meta.url);
  const vitePath = createRequire(require.resolve('vitest/package.json')).resolve('vite');
  const { build } = await import(pathToFileURL(vitePath).href);
  const fixtureId = fileURLToPath(new URL('./__c6b_fixture__.tsx', import.meta.url));
  const src = fileURLToPath(new URL('../', import.meta.url));
  const mock = `
    const query = data => ({ data, isSuccess: true, isLoading: false,
      refetch: async () => ({ data }) });
    const mutation = { useMutation: () => ({ isPending: false }) };
    const endpoint = data => ({ useQuery: () => query(data) });
    export const trpc = {
      opc: { library: endpoint({businesses: []}), list: endpoint({drafts: []}),
        editLibrary: mutation, saveContentManual: mutation, publicationUiChange: mutation,
        workUiChange: mutation },
      modules: { getModules: endpoint({modules: []}), getModuleById: endpoint(null) },
      runtime: { choices: endpoint({skills: []}) },
      user: { getUserProfile: endpoint({id: 'synthetic'}) },
      settings: { getSystemSettings: endpoint({maintenance_mode: false}) },
      ticket: { getTickets: endpoint([]), createTicket: mutation }
    };
  `;
  const mocks: Record<string, string> = {
    '@/trpc/client': mock,
    '@/lib/supabase': `export const createClient = () => ({auth: {getSession: async () =>
      ({data: {session: {access_token: 'synthetic-local-only'}}})}});`,
    '@/components/opc/workspace-frame': 'export const WorkspaceFrame = ({children}) => children;',
    '@/components/opc/content-editor': 'export const ContentEditor = () => null;',
    '@/components/opc/version-compare': 'export const VersionCompare = () => null;',
    '@/components/opc/strategy-overview-dialog': 'export const StrategyOverviewDialog = () => null;',
    'next/link': `import React from 'react'; export default function Link(props) {
      return React.createElement('a', props); }`,
  };
  const bundle = await build({ configFile: false, logLevel: 'silent',
    define: { 'process.env.NODE_ENV': JSON.stringify('test'), 'process.env': '{}' },
    oxc: { jsx: { runtime: 'automatic' } }, resolve: { alias: { '@': src } },
    plugins: [{ name: 'c6b-local-fixture', enforce: 'pre', resolveId(id: string) {
      if (id === fixtureId) return id;
      for (const key of Object.keys(mocks)) {
        if (id === key || (key.startsWith('@/') && id.endsWith('/' + key.slice(2)))) return '\0c6b:' + key;
      }
    }, load(id: string) {
      if (id.startsWith('\0c6b:')) return mocks[id.slice('\0c6b:'.length)];
      if (id === fixtureId) return `
        import React from 'react'; import {createRoot} from 'react-dom/client';
        import Library from '@/app/library/page';
        import Search from '@/app/workbench/search/page';
        import Marketplace from '@/app/workbench/marketplace/page';
        import Maintenance from '@/app/maintenance/page';
        import Tickets from '@/components/profile/TicketsPanel';
        const pages = {'/library': Library, '/workbench/search': Search,
          '/workbench/marketplace': Marketplace, '/maintenance': Maintenance};
        const Page = pages[location.pathname];
        if (Page) createRoot(document.getElementById('root')).render(React.createElement(Page));
        else if (location.pathname === '/profile') createRoot(document.getElementById('root'))
          .render(React.createElement(Tickets, {user: {}, initialView: 'create'}));
      `;
    } }], build: { write: false, minify: false,
      lib: { entry: fixtureId, name: 'C6bTest', formats: ['iife'] } } });
  const output = Array.isArray(bundle) ? bundle[0].output : bundle.output;
  const code = output.find((item: { type: string }) => item.type === 'chunk').code;
  const browser = await chromium.launch({ headless: true,
    executablePath: existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined });
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== 'https://c6b.example.test') return route.abort();
      if (url.pathname === '/fixture.js') return route.fulfill({contentType: 'text/javascript; charset=utf-8', body: code});
      if (url.pathname === '/api/upload') return route.fulfill({contentType: 'application/json',
        body: JSON.stringify({path: 'synthetic/screenshot.png'})});
      return route.fulfill({contentType: 'text/html; charset=utf-8', body:
        '<div id="root"></div><script src="/fixture.js"></script>'});
    });
    const session = '11111111-1111-4111-8111-111111111111';
    const valid = '/runtime?session=' + session;
    const unsafe = ['javascript:window.__xss=1', '//evil.example', '/\\evil.example',
      '/\n/evil.example', 'https://evil.example'];
    for (const path of ['/library', '/workbench/search', '/workbench/marketplace']) {
      for (const target of [valid, ...unsafe]) {
        await page.goto('https://c6b.example.test' + path + '?returnTo=' + encodeURIComponent(target));
        const link = page.getByRole('link', {name: /返回.*工作/});
        await link.waitFor({timeout: 5000}).catch(error => {
          throw new Error(path + ': ' + errors.join('; ') + '; ' + String(error));
        });
        await expect.poll(() => link.getAttribute('href')).toBe(target === valid ? valid : '/positioning');
        await link.click();
        await page.waitForURL('https://c6b.example.test' + (target === valid ? valid : '/positioning'));
      }
    }
    for (const target of ['/library', ...unsafe, '/\r/evil.example', '/\t/evil.example']) {
      await page.goto('https://c6b.example.test/maintenance?from=' + encodeURIComponent(target));
      await page.getByRole('button', {name: '重新检查状态'}).click();
      await page.waitForURL('https://c6b.example.test' + (target === '/library' ? '/library' : '/profile'));
    }
    await page.goto('https://c6b.example.test/profile');
    const filename = '<img src=x onerror=window.__xss=1>.png';
    await page.locator('#ticket-attachment').setInputFiles({name: filename, mimeType: 'image/png',
      buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')});
    const preview = page.getByRole('img', {name: filename});
    await preview.waitFor();
    expect(await preview.getAttribute('src')).toMatch(/^blob:https:\/\/c6b\.example\.test\//);
    expect(await page.locator('[onerror]').count()).toBe(0);
    expect(await page.evaluate(() => (window as any).__xss)).toBeUndefined();
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
}, 120_000);
