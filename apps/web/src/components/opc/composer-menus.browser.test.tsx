/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, type Browser } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { fileHintText } from './work-composer';

/**
 * UI-UNIFY (Codex batch D-1): typing @ in a new conversation showed the library candidates, but they sat under the top bar and could not be
 * clicked: the menu always opened upward and the work panel clips what leaves it. The real composer menus (the @ picker, the file menu)
 * with the real CSS, in a page shaped like the app (a header, then a work panel that clips its overflow), with the box near the top
 * (a new conversation) and near the bottom (a long one): the point at the middle of every candidate must be that candidate.
 */
let browser: Browser;
let code: string;
let css: string;
const entry = fileURLToPath(new URL('./__composer_menus_fixture__.js', import.meta.url));
const LINK = '\0fake-link';
const HEADER = 100;

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const { build } = await import(pathToFileURL(createRequire(require.resolve('vitest/package.json')).resolve('vite')).href);
  const source = fileURLToPath(new URL('./composer-view.tsx', import.meta.url));
  const bundle = await build({
    configFile: false, logLevel: 'silent', define: { 'process.env.NODE_ENV': JSON.stringify('development') },
    oxc: { jsx: { runtime: 'automatic' } },
    resolve: { alias: { '@': fileURLToPath(new URL('../../', import.meta.url)) } },
    plugins: [{ name: 'composer-menus-fixture', enforce: 'pre', resolveId(id: string) {
      if (id === entry) return id;
      if (id === 'next/link') return LINK;
    }, load(id: string) {
      if (id === LINK) return `import React from 'react'; export default function Link(p){return React.createElement('a',p)}`;
      if (id === entry) return `import React from 'react'; import {createRoot} from 'react-dom/client';
        import {ComposerView,ReferenceMenuView} from ${JSON.stringify(source)};
        import styles from ${JSON.stringify(fileURLToPath(new URL('./work-composer.module.css', import.meta.url)))};
        const params=window.fixtureParams||{};
        const choices=Array.from({length:Number(params.rows||8)},(_, i)=>({id:'d'+i,label:'文档 '+i+'.md'}));
        const where=params.where||'top', which=params.menu||'reference';
        window.picked=[];
        function Page(){
          // The app: a header, then a work panel that clips its overflow. A new conversation puts the box near the top of the panel,
          // a long one at its bottom.
          const box=which==='files'
            ? React.createElement('div',{style:{margin:'0 20px'}},React.createElement(ComposerView,{menu:'files',fileHint:params.hint||'支持 txt、md、docx',onPickFile:()=>window.picked.push('file'),
                editor:React.createElement('div',{style:{minHeight:60}},'输入框')}))
            : React.createElement('div',{className:styles.composer,style:{margin:'0 20px',minHeight:96}},
                React.createElement(ReferenceMenuView,{choices,footnote:'每条消息最多引用 3 篇文档。',onPick:i=>window.picked.push(i)}));
          return React.createElement('div',{style:{height:'100dvh',display:'flex',flexDirection:'column'}},
            React.createElement('header',{style:{height:${HEADER},flex:'none',background:'#fff',position:'relative',zIndex:30}},'顶栏'),
            React.createElement('main',{style:{flex:1,minHeight:0,overflow:'hidden',position:'relative',display:'flex',flexDirection:'column',
              justifyContent:where==='top'?'flex-start':'flex-end',paddingTop:where==='top'?24:0,paddingBottom:where==='top'?0:16}},box));
        }
        createRoot(document.getElementById('root')).render(React.createElement(Page));`;
    } }],
    build: { write: false, minify: false, lib: { entry, name: 'ComposerMenusTest', formats: ['iife'] } },
  });
  const output = Array.isArray(bundle) ? bundle[0].output : bundle.output;
  code = output.find((item: { type: string }) => item.type === 'chunk').code;
  css = output.filter((item: { fileName: string }) => item.fileName.endsWith('.css'))
    .map((item: { source: string }) => item.source).join('\n');
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch({ executablePath: existsSync(chrome) ? chrome : undefined, headless: true });
}, 90000);
afterAll(async () => { await browser?.close(); }, 30000);

for (const [width, height] of [[1280, 800], [1280, 560], [390, 800]]) {
  for (const where of ['top', 'bottom']) {
    it(`@ reference candidates are all clickable at ${width}x${height} with the box near the ${where}`, async () => {
      const page = await browser.newPage({ viewport: { width, height } });
      try {
        const errors: string[] = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.route('**/*', route => route.abort());
        await page.setContent('<style>body{margin:0;font-family:sans-serif}</style><div id="root"></div>');
        await page.addStyleTag({ content: css });
        await page.evaluate(place => { (window as unknown as { fixtureParams: object }).fixtureParams = { menu: 'reference', where: place }; }, where);
        await page.addScriptTag({ content: code });
        const menu = page.getByRole('dialog', { name: '引用资料库文档' });
        await menu.waitFor();
        expect(errors).toEqual([]);
        // The menu lies inside the visible work panel: below the header, above the bottom of the viewport.
        const box = (await menu.boundingBox())!;
        expect(box.y, 'under the top bar').toBeGreaterThanOrEqual(HEADER);
        expect(box.y + box.height, 'past the bottom of the window').toBeLessThanOrEqual(height);
        // Every candidate is reachable (a list taller than the room scrolls inside the menu), and the point at its middle is that candidate.
        const options = page.getByRole('option');
        const count = await options.count();
        expect(count).toBe(8);
        for (let index = 0; index < count; index += 1) {
          const option = options.nth(index);
          await option.scrollIntoViewIfNeeded();
          const hit = await option.evaluate(element => {
            const rect = element.getBoundingClientRect(), found = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
            return Boolean(found) && (found === element || element.contains(found));
          });
          expect(hit, `candidate ${index} is covered`).toBe(true);
        }
        await options.nth(7).click({ timeout: 3000 });
        expect(await page.evaluate(() => (window as unknown as { picked: number[] }).picked)).toEqual([7]);
      } finally { await page.close(); }
    }, 30000);
  }
}

for (const [width, height] of [[1280, 800], [390, 800]]) {
  for (const where of ['top', 'bottom']) {
    it(`the + file menu is inside the work panel and its button clickable at ${width}x${height} with the box near the ${where}`, async () => {
      const page = await browser.newPage({ viewport: { width, height } });
      try {
        await page.route('**/*', route => route.abort());
        await page.setContent('<style>body{margin:0;font-family:sans-serif}</style><div id="root"></div>');
        await page.addStyleTag({ content: css });
        await page.evaluate(place => { (window as unknown as { fixtureParams: object }).fixtureParams = { menu: 'files', where: place }; }, where);
        await page.addScriptTag({ content: code });
        const menu = page.getByRole('dialog', { name: '添加资料' });
        await menu.waitFor();
        const box = (await menu.boundingBox())!;
        expect(box.y, 'under the top bar').toBeGreaterThanOrEqual(HEADER);
        expect(box.y + box.height, 'past the bottom of the window').toBeLessThanOrEqual(height);
        const hit = await page.getByRole('button', { name: /从文件添加/ }).evaluate(element => {
          const rect = element.getBoundingClientRect(), found = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
          return Boolean(found) && (found === element || element.contains(found));
        });
        expect(hit, 'the file button is covered').toBe(true);
        await page.getByRole('button', { name: /从文件添加/ }).click({ timeout: 3000 });
        expect(await page.evaluate(() => (window as unknown as { picked: string[] }).picked)).toEqual(['file']);
      } finally { await page.close(); }
    }, 30000);
  }
}

// Validation of #1889 (2026-11-12): on a 360px phone the positioning conversation leaves 158px above the box; the "+" menu was 232px
// tall with its real explanation, so the last sentence was only reached by scrolling inside the menu.
for (const [name, hint] of [['the positioning conversation', fileHintText(false, true)], ['a box without library references', fileHintText(false, false)]] as const) {
  it(`360px: the + menu shows the whole explanation of ${name} without scrolling, inside the screen`, async () => {
    const page = await browser.newPage({ viewport: { width: 360, height: 740 } });
    try {
      await page.route('**/*', route => route.abort());
      await page.setContent('<style>body{margin:0;font:400 16px/24px sans-serif}</style><div id="root"></div>');
      await page.addStyleTag({ content: css });
      await page.evaluate(text => { (window as unknown as { fixtureParams: object }).fixtureParams = { menu: 'files', where: 'bottom', hint: text }; }, hint);
      await page.addScriptTag({ content: code });
      const menu = page.getByRole('dialog', { name: '添加资料' });
      await menu.waitFor();
      const measured = await menu.evaluate(element => ({ content: element.scrollHeight, shown: element.clientHeight,
        left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right }));
      expect(measured.content, 'taller than the room a phone leaves above the box').toBeLessThanOrEqual(158);
      expect(measured.content, 'the menu scrolls').toBeLessThanOrEqual(measured.shown);
      expect(measured.left).toBeGreaterThanOrEqual(0);
      expect(measured.right).toBeLessThanOrEqual(360);
      await expect(menu.textContent()).resolves.toContain(hint.slice(-12));
    } finally { await page.close(); }
  }, 30000);
}
