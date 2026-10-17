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
      'process.env.NEXT_PUBLIC_COMPOSER_REFERENCES': JSON.stringify(''),
      // Word and PDF extraction stay closed here, so attachments take TXT and Markdown (UI-C).
      'process.env.NEXT_PUBLIC_LIBRARY_DOCX_EXTRACTION': JSON.stringify(''),
      'process.env.NEXT_PUBLIC_LIBRARY_PDF_EXTRACTION': JSON.stringify(''),
      'process.env.NEXT_PUBLIC_LIBRARY_SCAN_RECOGNITION': JSON.stringify('') },
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
        const found=query=>({nextCursor:null,documents:window.listData.documents.filter(d=>d.kind==='document'
          &&d.status==='ready'&&d.filename.toLowerCase().includes(query.toLowerCase()))});
        // UI-C: an upload is granted ready at once (a plain text file the server already holds), recorded in window.uploads;
        // window.uploadMode 'fail' refuses it, 'processing' leaves it out of the ready documents (a scan to recognise).
        const library={list:{useQuery:(input,options)=>{window.listCalls.push(Boolean(options&&options.enabled));
          return answer(options,window.listData)}},
          search:{useQuery:(input,options)=>{window.listCalls.push(Boolean(options&&options.enabled));
            if(options&&options.enabled)window.searches.push(input.query);
            return answer(options,found(input.query))}},
          beginUpload:{useMutation:()=>({mutateAsync:async input=>{window.uploads.push(input);
            if(window.uploadMode==='slow')await new Promise(resolve=>{window.releaseUpload=resolve;});
            if(window.uploadMode==='fail')throw Object.assign(new Error('LIBRARY_QUOTA'),{data:{code:'BAD_REQUEST'}});
            const id='u'+window.uploads.length;
            if(window.uploadMode!=='processing')window.listData.documents.unshift({id,filename:input.filename,kind:'document',
              status:'ready',content_version:1});
            return {documentId:id,status:'ready',upload:null}}})}};
        for(const name of ['completeUpload','abandonUpload','beginWordUpload','beginWordTextUpload','completeWordUpload',
          'beginPdfUpload','beginPdfTextUpload','completePdfUpload'])library[name]={useMutation:()=>({mutateAsync:async()=>({})})};
        const utils={library:{invalidate:async()=>{},search:{fetch:async input=>found(input.query)}}};
        export const trpc={useUtils:()=>utils,
        library,
        runtime:{choices:{useQuery:()=>({isLoading:false,error:null,data:undefined,refetch(){}})}}};`;
      if (id === LINK) return `import React from 'react'; export default function Link(p){return React.createElement('a',p)}`;
      if (id === entry) return `import React from 'react'; import {createRoot} from 'react-dom/client';
        import {WorkComposer} from ${JSON.stringify(source)};
        // about:blank is not a secure context; the upload flow needs request ids.
        let uuid=0; if(!crypto.randomUUID)crypto.randomUUID=()=>'00000000-0000-4000-8000-'+String(++uuid).padStart(12,'0');
        window.sent=[]; window.value=''; window.listCalls=[]; window.searches=[]; window.reported=[]; window.sentReferences=[]; window.uploads=[];
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
  // The same document again is not a sixth one.
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await page.keyboard.type('@资料甲');
  await ui(page.getByRole('option')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await ui(box(page).locator('.library-reference')).toHaveCount(6);
  await page.keyboard.press('Enter');
  expect((await read<string[][]>(page, 'sentReferences'))[0]).toHaveLength(5);
}));

// UI-C: a file added in the box goes into the library (its own upload flow) and joins the message as a reference.
const attach = (page: Page, files: Array<{ name: string; text: string; mimeType?: string }>) =>
  page.locator('input[aria-label="选择附件"]').setInputFiles(files.map(file => ({
    name: file.name, mimeType: file.mimeType ?? 'text/plain', buffer: Buffer.from(file.text),
  })));

it('uploads an attached document into the library as reference material and adds it as a reference', () => open(true, async page => {
  await page.keyboard.type('总结一下');
  await page.getByRole('button', { name: '添加资料' }).click();
  await ui(page.getByRole('dialog', { name: '添加资料' })).toContainText('文件会存进你的资料库，并作为引用加入本条消息');
  expect(await page.locator('input[aria-label="选择附件"]').getAttribute('accept')).toMatch(/^\.txt,\.md/);
  await attach(page, [{ name: '会议纪要.md', text: '# 纪要\n第一条' }]);
  await ui(box(page).locator('[data-library-reference="u1"]')).toHaveText('@会议纪要.md');
  expect(await read<Array<{ filename: string; purpose: string }>>(page, 'uploads'))
    .toMatchObject([{ filename: '会议纪要.md', purpose: 'reference' }]);
  // The file's text is not pasted into the message; only the reference is.
  expect(await read<string>(page, 'value')).toBe('总结一下 @会议纪要.md ');
  await ui(page.getByRole('button', { name: '发送' })).toBeEnabled();
  await box(page).click();
  await page.keyboard.press('Enter');
  expect(await read<string[][]>(page, 'sentReferences')).toEqual([['u1@1']]);
}));

it('refuses images and other files with a reason and uploads nothing', () => open(true, async page => {
  await attach(page, [{ name: '截图.png', text: 'x', mimeType: 'image/png' }, { name: '数据.csv', text: 'a,b' }]);
  await ui(page.getByRole('alert')).toHaveText([
    '「截图.png」不能作为附件：这里只支持 TXT、Markdown 文档。图片请到资料库上传。',
    '「数据.csv」不能作为附件：这里只支持 TXT、Markdown 文档。图片请到资料库上传。',
  ]);
  expect(await read<unknown[]>(page, 'uploads')).toEqual([]);
  await ui(box(page).locator('.library-reference')).toHaveCount(0);
}));

it('shows a failed upload with 重试 and 移除, and adds no reference', () => open(true, async page => {
  await page.evaluate(() => { (window as unknown as { uploadMode: string }).uploadMode = 'fail'; });
  await attach(page, [{ name: '计划.txt', text: '计划' }]);
  const failed = page.getByRole('alert').filter({ hasText: '计划.txt' });
  await ui(failed).toBeVisible();
  await ui(failed.getByRole('button', { name: '重试' })).toBeVisible();
  await failed.getByRole('button', { name: '移除' }).click();
  await ui(page.getByRole('alert')).toHaveCount(0);
  await ui(box(page).locator('.library-reference')).toHaveCount(0);
}));

it('says when a stored file is not ready to reference yet, or would be a sixth document', () => open(true, async page => {
  await page.evaluate(() => { (window as unknown as { uploadMode: string }).uploadMode = 'processing'; });
  await attach(page, [{ name: '扫描件.txt', text: '扫描' }]);
  await ui(page.getByRole('alert')).toHaveText('「扫描件.txt」已存入资料库，文字还在处理（扫描页要先识别），处理好后可以用 @ 引用。');
  await page.evaluate(() => { (window as unknown as { uploadMode: string }).uploadMode = ''; });
  await box(page).click();
  for (const name of ['甲', '乙', '丙', '丁', '戊']) {
    await page.keyboard.type('@资料' + name);
    await ui(page.getByRole('option')).toHaveCount(1);
    await page.keyboard.press('Enter');
  }
  await attach(page, [{ name: '第六篇.md', text: '六' }]);
  await ui(page.getByRole('alert')).toHaveText('「第六篇.md」已存入资料库，但每条消息最多引用 5 篇文档。');
  await ui(box(page).locator('.library-reference')).toHaveCount(5);
}));

it('switched off: a file is read into the message as before and nothing is uploaded', () => open(false, async page => {
  expect(await page.locator('input[aria-label="选择附件"]').getAttribute('accept')).toBe('.txt,.md,.csv,.json,.log');
  await attach(page, [{ name: '笔记.txt', text: '第一行' }]);
  await ui.poll(() => read<string>(page, 'value')).toContain('【文件：笔记.txt】');
  expect(await read<unknown[]>(page, 'uploads')).toEqual([]);
}));

it('waits for an attachment still uploading: send stays off and Enter does not send without it', () => open(true, async page => {
  await page.evaluate(() => { (window as unknown as { uploadMode: string }).uploadMode = 'slow'; });
  await page.keyboard.type('看看这个');
  await attach(page, [{ name: '慢文件.md', text: '慢' }]);
  await ui(page.getByRole('status').filter({ hasText: '慢文件.md' })).toContainText('正在存入资料库');
  await ui(page.getByRole('button', { name: '发送' })).toBeDisabled();
  await box(page).click();
  await page.keyboard.press('Enter');
  expect(await read<string[]>(page, 'sent')).toEqual([]);
  await page.evaluate(() => (window as unknown as { releaseUpload: () => void }).releaseUpload());
  await ui(box(page).locator('[data-library-reference="u1"]')).toHaveText('@慢文件.md');
  await ui(page.getByRole('button', { name: '发送' })).toBeEnabled();
}));

it('six files chosen together add five references and say so for the sixth', () => open(true, async page => {
  await attach(page, ['一', '二', '三', '四', '五', '六'].map(name => ({ name: '文件' + name + '.md', text: name })));
  await ui(page.getByRole('alert')).toHaveText(/已存入资料库，但每条消息最多引用 5 篇文档。/);
  await ui(box(page).locator('.library-reference')).toHaveCount(5);
  await ui(page.getByRole('button', { name: '发送' })).toBeEnabled();
}));
