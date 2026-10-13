/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, expect as ui, type Browser, type Page } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';

let browser: Browser;
let code: string;
const entry = fileURLToPath(new URL('./__composer_fixture__.js', import.meta.url));

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const { build } = await import(pathToFileURL(createRequire(require.resolve('vitest/package.json')).resolve('vite')).href);
  const source = fileURLToPath(new URL('./composer-editor.tsx', import.meta.url));
  const bundle = await build({
    configFile: false, logLevel: 'silent', define: { 'process.env.NODE_ENV': JSON.stringify('development') },
    oxc: { jsx: { runtime: 'automatic' } },
    resolve: { alias: { '@': fileURLToPath(new URL('../../', import.meta.url)) } },
    plugins: [{ name: 'composer-fixture', resolveId(id: string) { if (id === entry) return id; }, load(id: string) {
      // A host like WorkComposer: it owns the string, sends on Enter when non-blank and then clears it.
      if (id === entry) return `import React from 'react'; import {createRoot} from 'react-dom/client';
        import {ComposerEditor} from ${JSON.stringify(source)};
        window.sent=[]; window.value='';
        function Host(){
          const [value,setValue]=React.useState(''); const [disabled,setDisabled]=React.useState(false);
          window.value=value; window.setValue=setValue; window.setDisabled=setDisabled;
          return React.createElement(ComposerEditor,{value,onChange:setValue,disabled,label:'消息',placeholder:'写点什么',
            maxLength:20,onEnter:()=>{if(value.trim()){window.sent.push(value);setValue('');}}});
        }
        createRoot(document.getElementById('root')).render(React.createElement(Host));`;
    } }],
    build: { write: false, minify: false, lib: { entry, name: 'ComposerTest', formats: ['iife'] } },
  });
  const output = Array.isArray(bundle) ? bundle[0].output : bundle.output;
  code = output.find((item: { type: string }) => item.type === 'chunk').code;
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch({ executablePath: existsSync(chrome) ? chrome : undefined, headless: true });
}, 60000);
afterAll(async () => { await browser?.close(); });

async function open(run: (page: Page) => Promise<void>) {
  const page = await browser.newPage();
  try {
    await page.route('**/*', route => route.abort());
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({ content: code });
    await ui(page.getByRole('textbox', { name: '消息' })).toBeVisible();
    await run(page);
  } finally {
    await page.close();
  }
}
const box = (page: Page) => page.getByRole('textbox', { name: '消息' });
const value = (page: Page) => page.evaluate(() => (window as unknown as { value: string }).value);
const sent = (page: Page) => page.evaluate(() => (window as unknown as { sent: string[] }).sent);
const paste = (page: Page, text: string) => page.evaluate(text => {
  const data = new DataTransfer();
  data.setData('text/plain', text);
  document.querySelector('[role=textbox]')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
}, text);

it('sends on Enter, adds a line on Shift+Enter, and shows the placeholder after the host clears it', () => open(async page => {
  await box(page).click();
  await page.keyboard.type('第一行');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('第二行');
  expect(await value(page)).toBe('第一行\n第二行');
  await page.keyboard.press('Enter');
  expect(await sent(page)).toEqual(['第一行\n第二行']);
  await ui(box(page)).toHaveText('');
  await ui(page.locator('p[data-placeholder="写点什么"]')).toBeVisible();
  await ui(box(page)).toHaveAttribute('aria-placeholder', '写点什么');
  await ui(box(page)).toBeFocused();
}));

it('sends the last typed character when Enter follows before React renders', () => open(async page => {
  await box(page).click();
  await page.evaluate(async () => {
    document.execCommand('insertText', false, '快');
    // Let the editor read the change (a microtask), then press Enter in the same task, before any scheduled render.
    await new Promise<void>(resolve => queueMicrotask(resolve));
    document.querySelector('[role=textbox]')!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true, cancelable: true }));
  });
  expect(await sent(page)).toEqual(['快']);
}));

it('does not send while an input method is composing', () => open(async page => {
  await box(page).click();
  await page.keyboard.type('pin');
  await page.evaluate(() => document.querySelector('[role=textbox]')!.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true, bubbles: true, cancelable: true })));
  expect(await sent(page)).toEqual([]);
}));

it('undoes and redoes typing', () => open(async page => {
  await box(page).click();
  await page.keyboard.type('撤销测试');
  await page.keyboard.press('ControlOrMeta+z');
  expect(await value(page)).toBe('');
  await page.keyboard.press('ControlOrMeta+Shift+z');
  expect(await value(page)).toBe('撤销测试');
}));

it('pastes plain text with its blank lines, trimmed to the length limit', () => open(async page => {
  await box(page).click();
  await paste(page, '上\r\n\r\n下');
  expect(await value(page)).toBe('上\n\n下');
  await paste(page, '0123456789abcdefghijklmn');
  expect(await value(page)).toBe('上\n\n下0123456789abcdef');
  await page.keyboard.type('xyz');
  expect((await value(page)).length).toBe(20);
  await page.keyboard.press('Backspace');
  expect(await value(page)).toBe('上\n\n下0123456789abcde');
}));

it('cuts filled text at the limit, as textarea maxLength did', () => open(async page => {
  await box(page).fill('a'.repeat(25));
  expect(await value(page)).toBe('a'.repeat(20));
  await ui(box(page)).toHaveText('a'.repeat(20));
}));

it('shows text set by the host and follows the disabled state', () => open(async page => {
  await page.evaluate(() => (window as unknown as { setValue: (v: string) => void }).setValue('资料\n\n第三行'));
  await ui(box(page).locator('p')).toHaveCount(3);
  expect(await value(page)).toBe('资料\n\n第三行');
  await page.evaluate(() => (window as unknown as { setDisabled: (v: boolean) => void }).setDisabled(true));
  await ui(box(page)).toHaveAttribute('aria-disabled', 'true');
  await ui(box(page)).toHaveAttribute('contenteditable', 'false');
  await page.evaluate(() => (window as unknown as { setDisabled: (v: boolean) => void }).setDisabled(false));
  await ui(box(page)).toBeEnabled();
  await ui(box(page)).toHaveAttribute('contenteditable', 'true');
}));
