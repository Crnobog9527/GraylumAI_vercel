/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, expect as ui, type Browser, type Page } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';

let browser: Browser;
let code: string;
let css: string;
const entry = fileURLToPath(new URL('./__references_fixture__.js', import.meta.url));
const TRPC = '\0fake-trpc';
const LINK = '\0fake-link';

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const { build } = await import(pathToFileURL(createRequire(require.resolve('vitest/package.json')).resolve('vite')).href);
  const source = fileURLToPath(new URL('./work-composer.tsx', import.meta.url));
  const bundle = await build({
    configFile: false, logLevel: 'silent', define: { 'process.env.NODE_ENV': JSON.stringify('development'),
      'process.env.NEXT_PUBLIC_COMPOSER_REFERENCES': JSON.stringify('') },
    oxc: { jsx: { runtime: 'automatic' } },
    resolve: { alias: { '@': fileURLToPath(new URL('../../', import.meta.url)) } },
    plugins: [{ name: 'references-fixture', enforce: 'pre', resolveId(id: string) {
      if (id === entry) return id;
      if (id === '@/trpc/client' || id.endsWith('/trpc/client')) return TRPC;
      if (id === 'next/link') return LINK;
    }, load(id: string) {
      // Library list and search answer from window.listData and record every call's `enabled`, so "off" can prove no
      // request; search filters by file name as the server does (#933) and records the text it was asked for.
      if (id === TRPC) return `const answer=(options,data)=>{
          if(options&&options.enabled&&window.listLoading)return {isLoading:true,error:null,data:undefined,refetch(){}};
          return options&&options.enabled?{isLoading:false,error:null,data,refetch(){}}
            :{isLoading:false,error:null,data:undefined,refetch(){}}};
        export const trpc={
        library:{list:{useQuery:(input,options)=>{window.listCalls.push(Boolean(options&&options.enabled));
          return answer(options,window.listData)}},
          search:{useQuery:(input,options)=>{window.listCalls.push(Boolean(options&&options.enabled));
            if(options&&options.enabled)window.searches.push(input.query);
            return answer(options,{nextCursor:null,documents:window.listData.documents.filter(d=>d.kind==='document'
              &&d.status==='ready'&&d.filename.toLowerCase().includes(input.query.toLowerCase()))})}}},
        runtime:{choices:{useQuery:()=>({isLoading:false,error:null,data:undefined,refetch(){}})}}};`;
      if (id === LINK) return `import React from 'react'; export default function Link(p){return React.createElement('a',p)}`;
      if (id === entry) return `import React from 'react'; import {createRoot} from 'react-dom/client';
        import {WorkComposer} from ${JSON.stringify(source)};
        window.sent=[]; window.value=''; window.listCalls=[]; window.searches=[]; window.reported=[]; window.sentReferences=[];
        const doc=(id,filename,extra={})=>({id,filename,kind:'document',status:'ready',content_version:4,format:'md',purpose:'reference',
          original_bytes:1,text_bytes:1,created_at:'2026-10-13T00:00:00Z',...extra});
        window.listData={usedBytes:0,capacityBytes:1,uploadEnabled:false,nextCursor:null,documents:[
          doc('d1','周报 第1周.md'),doc('d2','周报草稿.docx',{status:'processing'}),doc('d3','周报截图.png',{kind:'image'}),
          doc('d4','月报.pdf'),doc('d5','周报 第2周.md'),
          ...['甲','乙','丙','丁','戊'].map((name,index)=>doc('k'+index,'资料'+name+'.md'))]};
        // A page like /runtime: it keeps the references with the value and can set both (a restored draft).
        function Host({references,maxLength}){
          const [value,setValue]=React.useState('');
          const [list,setList]=React.useState([]);
          window.value=value; window.setValue=setValue;
          window.setDraft=(text,refs)=>{setValue(text);setList(refs);};
          return React.createElement(WorkComposer,{value,onChange:setValue,label:'消息',placeholder:'写点什么',references,maxLength,
            referenceList:list,onReferencesChange:next=>{window.reported.push(next);setList(next);},
            onSend:()=>{window.sent.push(value);window.sentReferences.push(list.map(r=>r.documentId+'@'+r.version));setValue('');}});
        }
        const root=createRoot(document.getElementById('root'));
        window.mount=(references,maxLength=20000)=>root.render(React.createElement(Host,{references,maxLength}));`;
    } }],
    build: { write: false, minify: false, lib: { entry, name: 'ReferencesTest', formats: ['iife'] } },
  });
  const output = Array.isArray(bundle) ? bundle[0].output : bundle.output;
  code = output.find((item: { type: string }) => item.type === 'chunk').code;
  css = output.filter((item: { fileName: string }) => item.fileName.endsWith('.css'))
    .map((item: { source: string }) => item.source).join('\n');
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch({ executablePath: existsSync(chrome) ? chrome : undefined, headless: true });
}, 60000);
afterAll(async () => { await browser?.close(); });

async function open(references: boolean, run: (page: Page) => Promise<void>, maxLength = 20000) {
  const page = await browser.newPage();
  try {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => route.abort());
    // The menu opens above the box, as in the app where the box sits at the bottom of the page.
    await page.setContent('<div id="root" style="padding-top:360px"></div>');
    await page.addStyleTag({ content: css });
    await page.addScriptTag({ content: code });
    await page.evaluate(([on, max]) => (window as unknown as { mount: (on: boolean, max: number) => void })
      .mount(on as boolean, max as number), [references, maxLength] as const);
    await ui(box(page)).toBeVisible();
    expect(errors).toEqual([]);
    await box(page).click();
    await run(page);
  } finally {
    await page.close();
  }
}
const box = (page: Page) => page.getByRole('textbox', { name: '消息' });
const menu = (page: Page) => page.getByRole('dialog', { name: '引用资料库文档' });
const read = <T,>(page: Page, key: string) => page.evaluate(k => (window as unknown as Record<string, T>)[k], key);

it('switched off: @ is plain text, no menu, no library request, Enter sends as before', () => open(false, async page => {
  await page.keyboard.type('参考@周报');
  await ui(menu(page)).toHaveCount(0);
  await page.keyboard.press('Enter');
  expect(await read<string[]>(page, 'sent')).toEqual(['参考@周报']);
  expect(await read<boolean[]>(page, 'listCalls')).not.toContain(true);
  await ui(box(page).locator('.library-reference')).toHaveCount(0);
}));

it('UI-MODEL: the box shows a read-only Auto next to send; clicking it opens nothing and Tab skips it', () => open(false, async page => {
  const auto = page.locator('[title="模型由系统按用途自动选择"]');
  await ui(auto).toBeVisible();
  // Screen readers hear "Auto，模型由系统按用途自动选择"; sighted users see only Auto.
  await ui(auto).toHaveText('Auto，模型由系统按用途自动选择');
  expect((await auto.boundingBox())!.width).toBeLessThan(60);
  await auto.click();
  await ui(page.getByRole('dialog')).toHaveCount(0);
  await ui(page.getByRole('button', { name: /Auto|模型/ })).toHaveCount(0);
  await box(page).click();
  await page.keyboard.type('你好');
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).not.toMatch(/Auto|模型/);
  // Narrow screen: the chip stays on one line beside send without pushing the row wider than the box.
  await page.setViewportSize({ width: 360, height: 760 });
  const [chip, send] = await Promise.all([auto.boundingBox(), page.getByRole('button', { name: '发送' }).boundingBox()]);
  expect(chip && send && chip.x + chip.width <= send.x && Math.abs(chip.y + chip.height / 2 - (send.y + send.height / 2)) < 4).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}));

it('lists only ready documents that match, and picks with the arrow keys and Enter instead of sending', () => open(true, async page => {
  await page.keyboard.type('参考@周报');
  await ui(menu(page)).toBeVisible();
  await ui(page.getByRole('option')).toHaveText(['周报 第1周.md', '周报 第2周.md']);
  await ui(page.getByRole('option', { name: '周报 第1周.md' })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowDown');
  await ui(page.getByRole('option', { name: '周报 第2周.md' })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
  expect(await read<string[]>(page, 'sent')).toEqual([]);
  await ui(menu(page)).toHaveCount(0);
  await ui(box(page).locator('[data-library-reference="d5"]')).toHaveText('@周报 第2周.md');
  expect(await read<string>(page, 'value')).toBe('参考@周报 第2周.md ');
  await page.keyboard.type('写总结');
  await page.keyboard.press('Enter');
  expect(await read<string[]>(page, 'sent')).toEqual(['参考@周报 第2周.md 写总结']);
}));

it('deletes a reference as a whole with one Backspace', () => open(true, async page => {
  await page.keyboard.type('@月');
  await page.getByRole('option', { name: '月报.pdf' }).click();
  await ui(box(page).locator('.library-reference')).toHaveCount(1);
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await ui(box(page).locator('.library-reference')).toHaveCount(0);
  expect(await read<string>(page, 'value')).toBe('');
}));

it('closes the menu on Esc so Enter sends, and lets IME composition keep Enter', () => open(true, async page => {
  await page.keyboard.type('@周');
  await ui(menu(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await ui(menu(page)).toHaveCount(0);
  await page.keyboard.press('Enter');
  expect(await read<string[]>(page, 'sent')).toEqual(['@周']);
  await page.keyboard.type('@周');
  await ui(menu(page)).toBeVisible();
  await page.evaluate(() => document.querySelector('[role=textbox]')!.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true, bubbles: true, cancelable: true })));
  await ui(box(page).locator('.library-reference')).toHaveCount(0);
  expect(await read<string[]>(page, 'sent')).toEqual(['@周']);
}));

it('does not open for an e-mail address, and with no match Enter still sends', () => open(true, async page => {
  await page.keyboard.type('me@example');
  await ui(menu(page)).toHaveCount(0);
  await page.keyboard.type(' @不存在');
  await ui(menu(page)).toContainText('没有匹配的已就绪文档');
  await page.keyboard.press('Enter');
  expect(await read<string[]>(page, 'sent')).toEqual(['me@example @不存在']);
}));

it('keeps a reference when the host appends text, as adding a file does', () => open(true, async page => {
  await page.keyboard.type('@月');
  await page.keyboard.press('Enter');
  await page.evaluate(() => (window as unknown as { setValue: (f: (v: string) => string) => void })
    .setValue(v => v + '\n\n附件资料\n第一行'));
  await ui(box(page).locator('p')).toHaveCount(4);
  await ui(box(page).locator('[data-library-reference="d4"]')).toHaveCount(1);
  expect(await read<string>(page, 'value')).toBe('@月报.pdf \n\n附件资料\n第一行');
}));

it('says so and lets Enter send when a reference does not fit the length limit', () => open(true, async page => {
  await page.keyboard.type('一二三四五六七八九十@周');
  await ui(page.getByRole('option')).toHaveCount(2);
  await page.keyboard.press('Enter');
  await ui(menu(page)).toHaveCount(0);
  await ui(page.getByRole('alert')).toHaveText('加入这个引用会超过字数上限，请先删减内容。');
  await ui(box(page).locator('.library-reference')).toHaveCount(0);
  await page.keyboard.press('Enter');
  expect(await read<string[]>(page, 'sent')).toEqual(['一二三四五六七八九十@周']);
}, 15));

it('does not send while the document list is still loading', () => open(true, async page => {
  await page.evaluate(() => { (window as unknown as { listLoading: boolean }).listLoading = true; });
  await page.keyboard.type('参考@周');
  await ui(menu(page)).toContainText('正在读取资料库');
  await page.keyboard.press('Enter');
  expect(await read<string[]>(page, 'sent')).toEqual([]);
  expect(await read<string>(page, 'value')).toBe('参考@周');
}));

// UI-B wiring (#1022): server search, references reported to the page, restored from it, at most five.
it('searches every document on the server by the typed name; an empty @ lists the recent ones', () => open(true, async page => {
  await page.keyboard.type('@');
  await ui(page.getByRole('option')).toHaveCount(8);
  expect(await read<string[]>(page, 'searches')).toEqual([]);
  await page.keyboard.type('资料');
  await ui(page.getByRole('option')).toHaveText(['资料甲.md', '资料乙.md', '资料丙.md', '资料丁.md', '资料戊.md']);
  expect(await read<string[]>(page, 'searches')).toContain('资料');
  await ui(menu(page)).toContainText('每条消息最多引用 5 篇文档。');
  await ui(menu(page)).not.toContainText('尚未开放');
}));

it('reports each change of the references to the page, which sends them with the text', () => open(true, async page => {
  await page.keyboard.type('对比@月');
  await page.keyboard.press('Enter');
  await page.keyboard.type('和@第1周');
  await ui(page.getByRole('option')).toHaveCount(1);
  await page.keyboard.press('Enter');
  expect((await read<Array<Array<{ documentId: string }>>>(page, 'reported')).at(-1)!.map(r => r.documentId)).toEqual(['d4', 'd1']);
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  expect((await read<Array<Array<{ documentId: string }>>>(page, 'reported')).at(-1)!.map(r => r.documentId)).toEqual(['d4']);
  await page.keyboard.type('总结');
  await page.keyboard.press('Enter');
  expect(await read<string[]>(page, 'sent')).toEqual(['对比@月报.pdf 和总结']);
  expect(await read<string[][]>(page, 'sentReferences')).toEqual([['d4@4']]);
  // The box is empty after the send: no references are left over for the next message.
  expect((await read<Array<unknown[]>>(page, 'reported')).at(-1)).toEqual([]);
}));

it('a draft the page restores (reload, failed send) gets its references back as tags', () => open(true, async page => {
  await page.evaluate(() => (window as unknown as { setDraft: (t: string, r: unknown[]) => void }).setDraft('看 @月报.pdf 和 @周报 第2周.md',
    [{ documentId: 'd4', version: 4, label: '月报.pdf' }, { documentId: 'd5', version: 4, label: '周报 第2周.md' }]));
  await ui(box(page).locator('[data-library-reference="d4"]')).toHaveText('@月报.pdf');
  await ui(box(page).locator('[data-library-reference="d5"]')).toHaveText('@周报 第2周.md');
  expect(await read<string>(page, 'value')).toBe('看 @月报.pdf 和 @周报 第2周.md');
  await box(page).click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  expect(await read<string[][]>(page, 'sentReferences')).toEqual([['d4@4', 'd5@4']]);
}));

it('refuses a sixth document with a notice, and Enter sends again', () => open(true, async page => {
  for (const name of ['甲', '乙', '丙', '丁', '戊']) {
    await page.keyboard.type('@资料' + name);
    await ui(page.getByRole('option')).toHaveCount(1);
    await page.keyboard.press('Enter');
  }
  await ui(box(page).locator('.library-reference')).toHaveCount(5);
  await page.keyboard.type('@月');
  await ui(page.getByRole('option')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await ui(page.getByRole('alert')).toHaveText('每条消息最多引用 5 篇文档。');
  await ui(box(page).locator('.library-reference')).toHaveCount(5);
  // The same document again is not a sixth one: it replaces its earlier tag.
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await page.keyboard.type('@资料甲');
  await ui(page.getByRole('option')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await ui(box(page).locator('.library-reference')).toHaveCount(5);
  await ui(box(page).locator('[data-library-reference="k0"]')).toHaveCount(1);
  await page.keyboard.press('Enter');
  expect((await read<string[][]>(page, 'sentReferences'))[0]).toHaveLength(5);
}));

it('choosing a document that is already in the message replaces its older tag with the new version', () => open(true, async page => {
  await page.evaluate(() => (window as unknown as { setDraft: (t: string, r: unknown[]) => void }).setDraft('看 @月报.pdf 然后',
    [{ documentId: 'd4', version: 1, label: '月报.pdf' }]));
  await ui(box(page).locator('[data-library-reference="d4"]')).toHaveCount(1);
  await box(page).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' @月');
  await ui(page.getByRole('option')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await ui(box(page).locator('[data-library-reference="d4"]')).toHaveCount(1);
  expect((await read<Array<Array<{ documentId: string; version: number }>>>(page, 'reported')).at(-1)).toMatchObject([{ documentId: 'd4', version: 4 }]);
  await page.keyboard.press('Enter');
  expect(await read<string[][]>(page, 'sentReferences')).toEqual([['d4@4']]);
}));
