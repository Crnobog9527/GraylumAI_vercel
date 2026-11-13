/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// The legal documents on a phone (under 640px; Owner 2026-11-12, phone plan A), in a real browser: the real documents from
// content/legal, the real styles (legal-document.module.css) and the real section list (LegalDocNav), laid out as
// LegalDocumentPage lays them out. Measured on staging before this change (2026-11-13, 390px): the terms are about 28,900px
// long and the privacy policy about 37,500px, with their table of contents at the top only; the privacy policy's table is 512px
// wide in a 358px column with nothing saying it scrolls. LEGAL_PHONE_SHOTS=<dir> saves screenshots.
import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, expect as ui, type Browser, type Page } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';

let browser: Browser;
let code = '';
let css = '';
const shots = process.env.LEGAL_PHONE_SHOTS;
const entry = fileURLToPath(new URL('./__legal_phone_fixture__.js', import.meta.url));
const doc = (name: string) => readFileSync(fileURLToPath(new URL(`../../../content/legal/${name}.html`, import.meta.url)), 'utf8');

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const { build } = await import(pathToFileURL(createRequire(require.resolve('vitest/package.json')).resolve('vite')).href);
  const file = (name: string) => JSON.stringify(fileURLToPath(new URL(name, import.meta.url)));
  const bundle = await build({
    configFile: false, logLevel: 'silent', define: { 'process.env.NODE_ENV': JSON.stringify('development'), 'process.env': '({})' },
    oxc: { jsx: { runtime: 'automatic' } }, resolve: { alias: { '@': fileURLToPath(new URL('../../', import.meta.url)) } },
    plugins: [{ name: 'legal-phone-fixture', enforce: 'pre', resolveId(id: string) { if (id === entry) return id; }, load(id: string) {
      if (id !== entry) return;
      // The article of LegalDocumentPage.tsx (the page itself reads the file on the server; here the test hands it over).
      return `import React from 'react'; import { createRoot } from 'react-dom/client';
        import styles from ${file('./legal-document.module.css')};
        import { LegalDocNav } from ${file('./LegalDocNav.tsx')};
        const h = React.createElement;
        createRoot(document.getElementById('root')).render(h('article', { style: { maxWidth: 768, margin: '0 auto', padding: '40px 16px' } },
          h('div', { lang: 'en', 'data-legal-doc': '', className: styles.doc, dangerouslySetInnerHTML: { __html: window.__doc } }),
          h(LegalDocNav)));`;
    } }],
    build: { write: false, minify: false, cssCodeSplit: false, lib: { entry, name: 'LegalPhoneTest', formats: ['iife'] } },
  });
  const output: { type: string; fileName: string; code?: string; source?: string }[] = Array.isArray(bundle) ? bundle[0].output : bundle.output;
  code = output.find(item => item.type === 'chunk')?.code ?? '';
  css = String(output.find(item => item.fileName.endsWith('.css'))?.source ?? '');
  browser = await chromium.launch({ headless: true });
  if (shots) mkdirSync(shots, { recursive: true });
}, 60000);
afterAll(async () => { await browser?.close(); }, 30000);

async function open(name: string, width: number): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width, height: 780 } });
  page.setDefaultTimeout(8000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const body = '<!doctype html><html lang="zh-Hans"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + `<style>*{box-sizing:border-box}body{margin:0;background:#0a0a0a}${css}</style></head><body><div id="root"></div></body></html>`;
  await page.route('**/*', route => (new URL(route.request().url()).pathname === `/${name}`
    ? route.fulfill({ contentType: 'text/html; charset=utf-8', body }) : route.abort()));
  await page.goto(`https://legal.test/${name}`);
  await page.evaluate(html => { (window as unknown as { __doc: string }).__doc = html; }, doc(name));
  await page.addScriptTag({ content: code });
  await page.locator('[data-legal-doc] h1').waitFor();
  return { page, errors };
}
const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
const nav = (page: Page) => page.getByRole('button', { name: '目录' });
const sheet = (page: Page) => page.getByRole('dialog', { name: '目录' });

for (const width of [390, 360]) {
  const what = 'a button in the corner opens the sections as a sheet on the bottom edge; a section jumps there; the first row goes back to the top';
  it(`${width}px, the terms: ${what}`, async () => {
    const { page, errors } = await open('terms', width);
    try {
      const place = await nav(page).boundingBox();
      expect(place!.height).toBeGreaterThanOrEqual(48);
      expect(Math.round(place!.x + place!.width)).toBe(width - 16);
      expect(Math.round(place!.y + place!.height)).toBe(780 - 16);
      // The button stays there however far down the document one is.
      await page.evaluate(() => window.scrollTo(0, 9000));
      expect(Math.round((await nav(page).boundingBox())!.y)).toBe(Math.round(place!.y));
      await nav(page).click();
      await ui(sheet(page)).toBeVisible();
      await page.waitForFunction(() => document.querySelector('dialog')!.getAnimations().every(animation => animation.playState === 'finished'));
      if (shots) await page.screenshot({ path: `${shots}/terms-sections-${width}.png` });
      const box = await sheet(page).boundingBox();
      expect([Math.round(box!.x), Math.round(box!.width), Math.round(box!.y + box!.height)]).toEqual([0, width, 780]);
      expect(box!.y, 'the document stays visible above the sheet').toBeGreaterThanOrEqual(120);
      // The sheet lists the document's own numbered headings, in order, after the way back to the top.
      const headings = await page.locator('[data-legal-doc] h2[id]').allInnerTexts();
      expect(headings.length).toBeGreaterThan(20);
      expect(await sheet(page).getByRole('link').allInnerTexts()).toEqual(headings);
      for (const row of [sheet(page).getByRole('button', { name: '回到顶部' }), sheet(page).getByRole('link').first()]) {
        expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(48);
      }
      // A section: the sheet closes and that heading is at the top of the screen, under where the site's bar stands.
      await sheet(page).getByRole('link', { name: headings[8], exact: true }).click();
      await ui(sheet(page)).toBeHidden();
      const top = await page.locator('[data-legal-doc] h2[id]').nth(8).evaluate(heading => Math.round(heading.getBoundingClientRect().top));
      expect(top).toBeGreaterThanOrEqual(0);
      expect(top).toBeLessThanOrEqual(120);
      expect(new URL(page.url()).hash).toBe('#' + await page.locator('[data-legal-doc] h2[id]').nth(8).getAttribute('id'));
      // Back to the top.
      await nav(page).click();
      await sheet(page).getByRole('button', { name: '回到顶部' }).click();
      await ui(sheet(page)).toBeHidden();
      await page.waitForFunction(() => window.scrollY === 0);
      expect(await sideways(page)).toBeLessThanOrEqual(0);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 30000);
}

it('390px: the sheet closes from its button, from the Escape key and from a press on the dimmed page above it', async () => {
  const { page, errors } = await open('terms', 390);
  try {
    await nav(page).click();
    await sheet(page).getByRole('button', { name: '关闭' }).click();
    await ui(sheet(page)).toBeHidden();
    await nav(page).click();
    await page.keyboard.press('Escape');
    await ui(sheet(page)).toBeHidden();
    await nav(page).click();
    await ui(sheet(page)).toBeVisible();
    await page.mouse.click(195, 40);
    await ui(sheet(page)).toBeHidden();
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 30000);

it('390px, the privacy policy: its own table of contents has rows a thumb can hit; the wide table says it scrolls, and only it scrolls sideways', async () => {
  const { page, errors } = await open('privacy', 390);
  try {
    const rows = page.locator('[data-legal-doc] .toc a');
    expect(await rows.count()).toBeGreaterThan(10);
    for (const row of [rows.first(), rows.nth(5), rows.last()]) expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    const wrap = page.locator('[data-legal-doc] .table-wrap').first();
    await wrap.scrollIntoViewIfNeeded();
    if (shots) await page.screenshot({ path: `${shots}/privacy-table-390.png` });
    expect(await wrap.evaluate(element => [element.scrollWidth > element.clientWidth, getComputedStyle(element, '::before').content]))
      .toEqual([true, '"表格较宽，可以左右滑动"']);
    expect(await sideways(page)).toBeLessThanOrEqual(0);
    await ui(nav(page)).toBeVisible();
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 30000);

it('390px, a short document without numbered sections (the cookie policy): no button, it is a few screens long', async () => {
  const { page, errors } = await open('cookies', 390);
  try {
    await ui(nav(page)).toHaveCount(0);
    expect(await sideways(page)).toBeLessThanOrEqual(0);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 30000);

it('1280px: the documents are what they were: no button, no word above the table, the headings at their size', async () => {
  const { page, errors } = await open('privacy', 1280);
  try {
    await ui(nav(page)).toBeHidden();
    const wrap = page.locator('[data-legal-doc] .table-wrap').first();
    expect(await wrap.evaluate(element => getComputedStyle(element, '::before').content)).toBe('none');
    expect(await page.locator('[data-legal-doc] h1').evaluate(heading => getComputedStyle(heading).fontSize)).toBe('36px');
    expect(await page.locator('[data-legal-doc] h2').first().evaluate(heading => getComputedStyle(heading).fontSize)).toBe('24px');
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 30000);
