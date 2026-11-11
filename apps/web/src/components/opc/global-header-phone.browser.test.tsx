/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, type Browser } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';

/**
 * UI-UNIFY (2026-11-12): the signed-in top bar on a phone. At 360px the row was wider than the screen: the frame cut the
 * language switch off on the right, the word "Graylum" sat against the menu button, and the links were 11–12px. The real
 * GlobalHeader with the frame's own CSS in a browser: everything in the row is inside the screen, in order, without touching;
 * the logo stands without the word (the link keeps its name); the menu button is a 40px target; the links are 13px or more.
 * The frame hides what overflows, so the page's scroll width says nothing here: each item's own box is measured.
 */
let browser: Browser;
let html: string;

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const { build } = await import(pathToFileURL(createRequire(require.resolve('vitest/package.json')).resolve('vite')).href);
  const entry = fileURLToPath(new URL('./__global_header_phone_fixture__.tsx', import.meta.url));
  const src = fileURLToPath(new URL('../../', import.meta.url));
  const bundle = await build({
    configFile: false, logLevel: 'silent', define: { 'process.env': JSON.stringify({ NODE_ENV: 'development' }) },
    oxc: { jsx: { runtime: 'automatic' } },
    resolve: { alias: { '@': src } },
    plugins: [{ name: 'global-header-phone-fixture', enforce: 'pre',
      resolveId(id: string) { if (id === entry) return id; if (id === 'next/link') return '\0next/link'; },
      load(id: string) {
        // Only next/link is replaced (a plain anchor). The language switch needs the signed-in profile, so a button of its size
        // (LanguageSwitch.tsx: 16px icon, one character, px-2 py-1 text-xs) stands in for it.
        if (id === '\0next/link') return "import {createElement} from 'react'; export default function Link({href,children,prefetch,...rest}){return createElement('a',{href,...rest},children)}";
        if (id !== entry) return;
        return `import {createRoot} from 'react-dom/client';
          import {GlobalHeader} from '@/components/opc/rail-view';
          import styles from ${JSON.stringify(src + 'components/opc/workspace-frame.module.css')};
          const language=<button type="button" aria-label="语言：简体中文" style={{display:'inline-flex',alignItems:'center',gap:4,padding:'4px 8px',fontSize:12,lineHeight:'16px'}}>
            <svg width="16" height="16" aria-hidden="true"/><span>简</span></button>;
          createRoot(document.getElementById('root')).render(<div className={styles.workspace}><GlobalHeader area="chat" onOpenNav={()=>{}} end={language}/></div>);`;
      } }],
    build: { write: false, minify: false, cssCodeSplit: false, lib: { entry, name: 'GlobalHeaderPhoneTest', formats: ['iife'] } },
  });
  const output = Array.isArray(bundle) ? bundle[0].output : bundle.output;
  const code = output.find((item: { type: string }) => item.type === 'chunk').code;
  const css = output.filter((item: { type: string; fileName: string }) => item.type === 'asset' && item.fileName.endsWith('.css'))
    .map((item: { source: string }) => item.source).join('\n');
  html = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + `<style>*{box-sizing:border-box}body{margin:0;--font-primary:-apple-system,'PingFang SC',sans-serif}${css}</style>`
    + `<div id="root"></div><script>window.process={env:{NODE_ENV:'development'},browser:true}</script><script>${code}</script>`;
  browser = await chromium.launch({ headless: true });
}, 30000);
afterAll(async () => { await browser?.close(); }, 30000);

type Box = { left: number; right: number; width: number; height: number };
async function measure(width: number) {
  const tab = await browser.newPage({ viewport: { width, height: 700 } });
  try {
    await tab.setContent(html);
    await tab.waitForSelector('header nav a');
    return await tab.evaluate(() => {
      const box = (element: Element | null): Box | null => {
        if (!element || getComputedStyle(element).display === 'none') return null;
        const r = element.getBoundingClientRect();
        return { left: r.left, right: r.right, width: r.width, height: r.height };
      };
      const header = document.querySelector('header')!;
      const brand = header.querySelector('a')!;
      const links = [...header.querySelectorAll('nav a')];
      return { brand: box(brand), brandName: brand.textContent, logo: box(brand.querySelector('img')), menu: box(header.querySelector('button[aria-label="打开导航"]')),
        links: links.map(box), linkFont: links.map(link => parseFloat(getComputedStyle(link).fontSize)), language: box(header.querySelector('button[aria-label^="语言"]')) };
    });
  } finally { await tab.close(); }
}

for (const width of [320, 360, 390]) {
  it(`${width}px: logo, menu button, the three links and the language switch all fit, in order, without touching`, async () => {
    const m = await measure(width);
    const row = [m.brand, m.menu, ...m.links, m.language];
    expect(row.every(Boolean), 'every item of the bar is shown').toBe(true);
    const boxes = row as Box[];
    expect(boxes[0].left).toBeGreaterThanOrEqual(0);
    for (let index = 1; index < boxes.length; index++) expect(boxes[index].left, `item ${index} touches the one before it`).toBeGreaterThanOrEqual(boxes[index - 1].right);
    expect(boxes[boxes.length - 1].right, 'the language switch is cut off on the right').toBeLessThanOrEqual(width);
    // The logo without the word; the link is still named for a screen reader.
    expect(m.brand!.width).toBeLessThanOrEqual(32);
    expect(m.logo!.width).toBe(28);
    expect(m.brandName).toBe('Graylum');
    // Room between the logo and the menu button, a finger-sized button, readable links.
    expect(m.menu!.left - m.brand!.right).toBeGreaterThanOrEqual(6);
    expect(Math.min(m.menu!.width, m.menu!.height)).toBeGreaterThanOrEqual(40);
    expect(Math.min(...m.linkFont)).toBeGreaterThanOrEqual(13);
  }, 20000);
}

it('1280px: the word "Graylum" shows beside the logo and there is no menu button', async () => {
  const m = await measure(1280);
  expect(m.brand!.width).toBeGreaterThan(80);
  expect(m.menu).toBeNull();
  expect(Math.min(...m.linkFont)).toBe(14);
}, 20000);
