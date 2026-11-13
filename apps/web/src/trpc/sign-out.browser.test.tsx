/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Signing out from a signed-in page, in a real browser: the real provider (its sign-out handling and its recovery from calls
// refused as not signed in), the real profile menu's sign-out, and a real read that is on the page, with a stand-in for
// Supabase and for the server. Why (Owner 2026-11-13: pressing 退出 on the conversation page took him to the login page, not
// the home page): signing out empties the session and tells the provider, which reads the page's data again; without a
// session the server refuses those reads (401) within a few milliseconds, and the recovery from a refusal went to
// /login?redirect=… . The sign-out's own move to the home page had started just before, and the home page takes longer to
// answer than the refusal does, so the later move to the login page replaced it. Measured here with the home page answering
// slower than the refusal, as it does for a person, and the other way round.
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, type Browser, type Page } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';

let browser: Browser;
let html = '';
const entry = fileURLToPath(new URL('./__sign_out_fixture__.js', import.meta.url));
const src = fileURLToPath(new URL('../', import.meta.url));
const STUBS: Record<string, string> = {
  // Supabase's order when signing out: ask the server, drop the session, tell whoever listens, and only then answer the caller.
  '@/lib/supabase': `
    const listeners = new Set();
    let session = { access_token: 'token', user: { id: '11111111-1111-4111-8111-111111111111' } };
    const auth = {
      getSession: async () => ({ data: { session }, error: null }),
      getUser: async () => ({ data: { user: session ? session.user : null }, error: null }),
      refreshSession: async () => ({ data: { session }, error: null }),
      onAuthStateChange(listener) { listeners.add(listener); return { data: { subscription: { unsubscribe() { listeners.delete(listener); } } } }; },
      async signOut() {
        window.__signOuts = (window.__signOuts || 0) + 1;
        await new Promise(resolve => setTimeout(resolve, 30));
        if (window.__signOutFails) throw new Error('offline');
        session = null;
        for (const listener of listeners) listener('SIGNED_OUT', null);
        return { error: null };
      },
    };
    export const createClient = () => ({ auth });`,
  'next/navigation': `export const usePathname = () => window.location.pathname;
    export const useRouter = () => ({ push() {}, replace() {}, refresh() {}, prefetch() {} });
    export const useSearchParams = () => new URLSearchParams(window.location.search);`,
  'next/link': `import { createElement } from 'react'; export default function Link({ prefetch, ...props }) { return createElement('a', props); }`,
};

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const { build } = await import(pathToFileURL(createRequire(require.resolve('vitest/package.json')).resolve('vite')).href);
  const file = (name: string) => JSON.stringify(fileURLToPath(new URL(name, import.meta.url)));
  const bundle = await build({
    configFile: false, logLevel: 'silent', define: { 'process.env.NODE_ENV': JSON.stringify('development'), 'process.env': '({})' },
    oxc: { jsx: { runtime: 'automatic' } }, resolve: { alias: { '@': src } },
    plugins: [{ name: 'sign-out-fixture', enforce: 'pre', resolveId(id: string) {
      if (id === entry) return id;
      const path = id.replace(/\.(tsx?|jsx?)$/, '');
      const key = Object.keys(STUBS).find(name => name === id || (name.startsWith('@/') && path.endsWith(name.slice(1))));
      if (key) return `\0stub:${key}`;
    }, load(id: string) {
      if (id.startsWith('\0stub:')) return STUBS[id.slice(6)];
      if (id !== entry) return;
      // A signed-in page with one read on it, and the three ways out: the profile menu's, the rail's and the old header's.
      return `import React from 'react'; import { createRoot } from 'react-dom/client';
        import Provider from ${file('./provider.tsx')};
        import { trpc } from ${file('./client.ts')};
        import { useProfileLogout } from ${file('../components/profile/profile-menu.ts')};
        const h = React.createElement;
        function Page() {
          const me = trpc.user.getProfile.useQuery();
          const logout = useProfileLogout();
          return h('main', null, h('p', { id: 'read' }, me.status),
            h('button', { type: 'button', disabled: logout.pending, onClick: () => void logout.run() }, logout.pending ? '退出中...' : '退出登录'));
        }
        createRoot(document.getElementById('root')).render(h(Provider, null, h(Page)));`;
    } }],
    build: { write: false, minify: false, lib: { entry, name: 'SignOutTest', formats: ['iife'] } },
  });
  const output: { type: string; code?: string }[] = Array.isArray(bundle) ? bundle[0].output : bundle.output;
  const code = output.find(item => item.type === 'chunk')?.code ?? '';
  html = `<!doctype html><html lang="zh-Hans"><head><meta charset="utf-8"></head><body><div id="root"></div>`
    + `<script>${code.replace(/<\/script/g, '<\\/script')}</script></body></html>`;
  browser = await chromium.launch({ headless: true });
}, 90000);
afterAll(async () => { await browser?.close(); }, 30000);

/**
 * A signed-in page at `path`. The server answers a read with the login header, and refuses one without (401, `refusal` ms
 * later); the home page takes `home` ms to answer. `moves`: every address the page was sent to, in order.
 */
async function open(path: string, timing: { home: number; refusal: number }): Promise<{ page: Page; moves: string[]; refused: () => number }> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.setDefaultTimeout(8000);
  const moves: string[] = [];
  let refused = 0;
  const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/api/trpc/')) {
      const calls = url.pathname.slice('/api/trpc/'.length).split(',').length;
      if (route.request().headers().authorization) {
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify(Array.from({ length: calls }, () => ({ result: { data: { id: 'me' } } }))) });
      }
      refused += 1;
      await wait(timing.refusal);
      const error = { error: { message: 'UNAUTHORIZED', code: -32001, data: { code: 'UNAUTHORIZED', httpStatus: 401 } } };
      return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify(Array.from({ length: calls }, () => error)) }).catch(() => undefined);
    }
    if (route.request().resourceType() !== 'document') return route.abort();
    if (url.pathname === path) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
    moves.push(url.pathname + url.search);
    if (url.pathname === '/') await wait(timing.home);
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><title>${url.pathname}</title><h1>${url.pathname}</h1>` })
      .catch(() => undefined);
  });
  await page.goto(`https://app.test${path}`);
  await page.locator('#read', { hasText: 'success' }).waitFor();
  return { page, moves, refused: () => refused };
}
/** Where the browser is once it has stopped moving. */
async function rest(page: Page): Promise<string> {
  await page.waitForLoadState('load');
  await page.waitForTimeout(700);
  await page.waitForLoadState('load');
  const url = new URL(page.url());
  return url.pathname + url.search;
}

for (const path of ['/app/profile', '/app/positioning/draft-1', '/app']) {
  it(`退出登录 on ${path} goes to the home page, also when the server refuses the page's reads before the home page has answered`, async () => {
    const { page, moves, refused } = await open(path, { home: 500, refusal: 5 });
    try {
      await page.getByRole('button', { name: '退出登录' }).click();
      expect(await rest(page)).toBe('/');
      // The reads were refused while the home page was on its way, and nothing sent the browser to the login page for it.
      expect(refused()).toBeGreaterThan(0);
      expect(moves).toEqual(['/']);
    } finally { await page.close(); }
  }, 30000);
}

it('the home page answering first: the home page as well', async () => {
  const { page, moves } = await open('/app/profile', { home: 0, refusal: 400 });
  try {
    await page.getByRole('button', { name: '退出登录' }).click();
    expect(await rest(page)).toBe('/');
    expect(moves).toEqual(['/']);
  } finally { await page.close(); }
}, 30000);

it('a sign-out that fails leaves the page where it is, signed in, and a refusal met later is recovered from as before', async () => {
  const { page, moves } = await open('/app/profile', { home: 0, refusal: 5 });
  try {
    await page.evaluate(() => { (window as unknown as { __signOutFails: boolean }).__signOutFails = true; });
    await page.getByRole('button', { name: '退出登录' }).click();
    await page.getByRole('button', { name: '退出登录' }).waitFor();
    expect(await rest(page)).toBe('/app/profile');
    expect(moves).toEqual([]);
  } finally { await page.close(); }
}, 30000);
