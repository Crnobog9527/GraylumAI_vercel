/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, type Browser } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';

// REL-1 (Codex batch 11 #900/#926): on the home page the Skill menu opened upward past the top of the clipped work panel,
// so its first rows could be neither seen nor clicked. Every row must be reachable at the sizes the batch used.
let browser: Browser;
let code: string;
let css: string;
const entry = fileURLToPath(new URL('./__skill_menu_fixture__.js', import.meta.url));
const LINK = '\0fake-link';

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const { build } = await import(pathToFileURL(createRequire(require.resolve('vitest/package.json')).resolve('vite')).href);
  const source = fileURLToPath(new URL('./composer-view.tsx', import.meta.url));
  const bundle = await build({
    configFile: false, logLevel: 'silent', define: { 'process.env.NODE_ENV': JSON.stringify('development') },
    oxc: { jsx: { runtime: 'automatic' } },
    plugins: [{ name: 'skill-menu-fixture', enforce: 'pre', resolveId(id: string) {
      if (id === entry) return id;
      if (id === 'next/link') return LINK;
    }, load(id: string) {
      if (id === LINK) return `import React from 'react'; export default function Link(p){return React.createElement('a',p)}`;
      if (id === entry) return `import React from 'react'; import {createRoot} from 'react-dom/client';
        import {SkillMenuView} from ${JSON.stringify(source)};
        import styles from ${JSON.stringify(fileURLToPath(new URL('./work-composer.module.css', import.meta.url)))};
        const skills=Array.from({length:12},(_, i)=>({moduleId:'m'+i,name:'技能 '+i}));
        window.picked=[];
        // The home page: a header, then a work panel that clips its overflow, with the box near the middle of it.
        function Page(){return React.createElement('div',{style:{height:'100dvh',display:'flex',flexDirection:'column'}},
          React.createElement('header',{style:{height:100,flex:'none'}},'头部'),
          React.createElement('main',{style:{flex:1,minHeight:0,overflow:'hidden',position:'relative',paddingTop:200}},
            React.createElement('div',{className:styles.menuAnchor,style:{width:34,marginLeft:40}},
              React.createElement('button',{type:'button'},'技能'),
              React.createElement(SkillMenuView,{query:'',skills,hint:'加载到本对话',onPick:id=>window.picked.push(id)}))));}
        createRoot(document.getElementById('root')).render(React.createElement(Page));`;
    } }],
    build: { write: false, minify: false, lib: { entry, name: 'SkillMenuTest', formats: ['iife'] } },
  });
  const output = Array.isArray(bundle) ? bundle[0].output : bundle.output;
  code = output.find((item: { type: string }) => item.type === 'chunk').code;
  css = output.filter((item: { fileName: string }) => item.fileName.endsWith('.css'))
    .map((item: { source: string }) => item.source).join('\n');
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch({ executablePath: existsSync(chrome) ? chrome : undefined, headless: true });
}, 90000);
afterAll(async () => { await browser?.close(); });

it.each([[1280, 800], [1280, 900], [375, 812]])('every Skill row can be reached at %ix%i', async (width, height) => {
  const page = await browser.newPage({ viewport: { width, height } });
  try {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => route.abort());
    await page.setContent('<style>body{margin:0}</style><div id="root"></div>');
    await page.addStyleTag({ content: css });
    await page.addScriptTag({ content: code });
    const menu = page.getByRole('dialog', { name: '使用技能' });
    await menu.waitFor();
    // The menu lies inside the visible work panel (below the 100px header, above the viewport bottom).
    const box = await menu.boundingBox();
    expect(errors).toEqual([]);
    expect(box!.y).toBeGreaterThanOrEqual(100);
    expect(box!.y + box!.height).toBeLessThanOrEqual(height);
    // The head and the footer stay visible, and each row is clickable after scrolling the list.
    await expect(page.getByText('浏览功能广场').isVisible()).resolves.toBe(true);
    for (let index = 0; index < 12; index += 1) {
      const row = page.getByRole('button', { name: new RegExp('^技能 ' + index + '\\b') });
      await row.scrollIntoViewIfNeeded();
      await row.click({ timeout: 3000 });
    }
    expect(await page.evaluate(() => (window as unknown as { picked: string[] }).picked.length)).toBe(12);
  } finally {
    await page.close();
  }
}, 30000);
