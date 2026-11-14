/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, type Browser, type Page } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { HOVER_PREFETCH_DWELL_MS } from './hover-prefetch-link';

/**
 * SITE-SPEED: HoverPrefetchLink under a real pointer, a real keyboard and a real touch, in a browser.
 *
 * What the link hands to next/link is the whole of its job: `prefetch={false}` (never fetch the page ahead) until the
 * visitor points at it, `prefetch={null}` (Next's default, which fetches a link on screen) while they do. next/link is
 * replaced by an anchor that writes the prop it was given into `data-prefetch`, and every value the attribute takes is
 * kept, so "was never switched on" is checked over the whole gesture and not only at its end.
 */
let browser: Browser;
let html: string;

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const { build } = await import(pathToFileURL(createRequire(require.resolve('vitest/package.json')).resolve('vite')).href);
  const entry = fileURLToPath(new URL('./__hover_prefetch_link_fixture__.tsx', import.meta.url));
  const src = fileURLToPath(new URL('../../', import.meta.url));
  const bundle = await build({
    configFile: false, logLevel: 'silent', define: { 'process.env': JSON.stringify({ NODE_ENV: 'development' }) },
    oxc: { jsx: { runtime: 'automatic' } },
    resolve: { alias: { '@': src } },
    plugins: [{ name: 'hover-prefetch-link-fixture', enforce: 'pre',
      resolveId(id: string) { if (id === entry) return id; if (id === 'next/link') return '\0next/link'; },
      load(id: string) {
        if (id === '\0next/link') return "import {createElement} from 'react'; export default function Link({href,children,prefetch,...rest}){return createElement('a',{href,'data-prefetch':String(prefetch),...rest},children)}";
        if (id !== entry) return;
        // Three links in a column, like the rail's entries, and a plain button to move the focus away to.
        return `import {createRoot} from 'react-dom/client';
          import {HoverPrefetchLink} from '@/components/opc/hover-prefetch-link';
          const row={display:'block',height:40,width:200,margin:0};
          createRoot(document.getElementById('root')).render(<nav>
            <HoverPrefetchLink id="a" style={row} href="/app/library" aria-current="page">资料库</HoverPrefetchLink>
            <HoverPrefetchLink id="b" style={row} href="/app/workbench/search">搜索</HoverPrefetchLink>
            <HoverPrefetchLink id="c" style={row} href="/app/positioning">新对话</HoverPrefetchLink>
            <button id="away" style={{display:'block',marginTop:200}}>别处</button></nav>);`;
      } }],
    build: { write: false, minify: false, lib: { entry, name: 'HoverPrefetchLinkTest', formats: ['iife'] } },
  });
  const output = Array.isArray(bundle) ? bundle[0].output : bundle.output;
  const code = output.find((item: { type: string }) => item.type === 'chunk').code;
  // The history of every link's data-prefetch, from the first render on.
  const watch = `window.__seen={};new MutationObserver(()=>{for(const a of document.querySelectorAll('a')){const v=a.getAttribute('data-prefetch');
    const list=window.__seen[a.id]||(window.__seen[a.id]=[]);if(list[list.length-1]!==v)list.push(v);}}).observe(document.getElementById('root'),
    {subtree:true,childList:true,attributes:true,attributeFilter:['data-prefetch']});`;
  html = '<!doctype html><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0}</style>'
    + `<div id="root"></div><script>window.process={env:{NODE_ENV:'development'},browser:true};${watch}</script><script>${code}</script>`;
  browser = await chromium.launch({ headless: true });
}, 30000);
afterAll(async () => { await browser?.close(); }, 30000);

const seen = (tab: Page) => tab.evaluate(() => (window as unknown as { __seen: Record<string, string[]> }).__seen);
const now = (tab: Page, id: string) => tab.locator('#' + id).getAttribute('data-prefetch');
/** Longer than the dwell by a wide margin: the browser has drawn the change by then. */
const SETTLED_MS = HOVER_PREFETCH_DWELL_MS + 250;

async function open(options: { touch?: boolean } = {}) {
  const tab = await browser.newPage({ viewport: { width: 600, height: 500 }, hasTouch: options.touch === true });
  await tab.setContent(html);
  await tab.waitForSelector('#c');
  // The pointer starts off the links.
  await tab.mouse.move(400, 400);
  return { tab, close: () => tab.close() };
}

it('at rest every link is given prefetch={false}; it keeps its href and the attributes it was given', async () => {
  const { tab, close } = await open();
  try {
    await tab.waitForTimeout(SETTLED_MS);
    expect(await seen(tab)).toEqual({ a: ['false'], b: ['false'], c: ['false'] });
    expect(await tab.locator('#a').getAttribute('href')).toBe('/app/library');
    expect(await tab.locator('#a').getAttribute('aria-current')).toBe('page');
    expect(await tab.locator('#a').textContent()).toBe('资料库');
  } finally { await close(); }
}, 20000);

it('the pointer resting on a link switches that link on, and only that one; leaving switches it off again', async () => {
  const { tab, close } = await open();
  try {
    await tab.mouse.move(100, 60);
    await tab.waitForTimeout(SETTLED_MS);
    expect(await now(tab, 'b')).toBe('null');
    expect(await now(tab, 'a')).toBe('false');
    expect(await now(tab, 'c')).toBe('false');
    await tab.mouse.move(400, 400);
    await tab.waitForTimeout(SETTLED_MS);
    expect(await seen(tab)).toEqual({ a: ['false'], b: ['false', 'null', 'false'], c: ['false'] });
  } finally { await close(); }
}, 20000);

it('the pointer crossing the three links on its way elsewhere switches none of them on', async () => {
  const { tab, close } = await open();
  try {
    // Down the column and out: one step onto each link (they are 40px high, at y 0-40, 40-80, 80-120), then away. The browser
    // takes one pointer move per frame (~17ms), so the crossing lasts about four frames and each link is under the pointer for one,
    // well below the dwell. (It used to take thirteen 10px steps: about fourteen frames, ~240ms, whose third sat right on the
    // 80ms dwell and failed the check below on CI with 80.67ms.) The pointer starts beside the column, on no link.
    await tab.mouse.move(300, 20);
    await tab.evaluate(() => { const w = window as unknown as { __entered: string[] }; w.__entered = [];
      document.addEventListener('pointerover', event => { const id = (event.target as Element).closest('a')?.id; if (id) w.__entered.push(id); }); });
    const started = Date.now();
    for (const y of [20, 60, 100]) await tab.mouse.move(100, y);
    await tab.mouse.move(400, 400);
    const crossing = Date.now() - started;
    await tab.waitForTimeout(SETTLED_MS);
    expect(await seen(tab)).toEqual({ a: ['false'], b: ['false'], c: ['false'] });
    // The pointer really went over each link, in order (else "switched none on" would prove nothing).
    expect(await tab.evaluate(() => (window as unknown as { __entered: string[] }).__entered)).toEqual(['a', 'b', 'c']);
    // The crossing itself must have been a crossing: if the machine was so slow that the pointer sat on a link for the
    // dwell, the line above would have failed for the wrong reason. Each link got about a third of the time.
    expect(crossing / 3).toBeLessThan(HOVER_PREFETCH_DWELL_MS);
  } finally { await close(); }
}, 20000);

it('moving from one link to the next leaves the first off and switches the second on', async () => {
  const { tab, close } = await open();
  try {
    await tab.mouse.move(100, 20);
    await tab.waitForTimeout(SETTLED_MS);
    await tab.mouse.move(100, 100);
    await tab.waitForTimeout(SETTLED_MS);
    expect(await seen(tab)).toEqual({ a: ['false', 'null', 'false'], b: ['false'], c: ['false', 'null'] });
  } finally { await close(); }
}, 20000);

it('the keyboard reaching a link switches it on after the dwell; tabbing straight past switches nothing on; leaving switches it off', async () => {
  const { tab, close } = await open();
  try {
    // Tab, Tab, Tab at once: the focus passes a and b and rests on c.
    await tab.keyboard.press('Tab');
    await tab.keyboard.press('Tab');
    await tab.keyboard.press('Tab');
    await tab.waitForTimeout(SETTLED_MS);
    expect(await tab.evaluate(() => document.activeElement?.id)).toBe('c');
    expect(await seen(tab)).toEqual({ a: ['false'], b: ['false'], c: ['false', 'null'] });
    await tab.keyboard.press('Tab');
    await tab.waitForTimeout(SETTLED_MS);
    expect(await tab.evaluate(() => document.activeElement?.id)).toBe('away');
    expect(await now(tab, 'c')).toBe('false');
  } finally { await close(); }
}, 20000);

it('a finger on a link switches it on at once, without the dwell', async () => {
  const { tab, close } = await open({ touch: true });
  try {
    await tab.locator('#a').dispatchEvent('touchstart');
    await tab.waitForFunction(() => document.getElementById('a')?.getAttribute('data-prefetch') === 'null', null, { timeout: 2000 });
    expect(await now(tab, 'b')).toBe('false');
  } finally { await close(); }
}, 20000);
