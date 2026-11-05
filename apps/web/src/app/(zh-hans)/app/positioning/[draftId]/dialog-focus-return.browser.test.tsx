/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, expect as ui, type Browser, type Page } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';

/**
 * The report's "关闭报告？" confirm is a state-opened AlertDialog (no Trigger). Cancelling it, by 继续编辑 or Esc, must give focus back to the
 * control that had it, so the next Esc or Tab is still inside the report. The fixture is the same wiring as report-panel.tsx: the real
 * useDialogFocusReturn hook and the real light ui/alert-dialog around an editor and a × button.
 */
let browser: Browser;
let code: string;

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const { build } = await import(pathToFileURL(createRequire(require.resolve('vitest/package.json')).resolve('vite')).href);
  const entry = fileURLToPath(new URL('./__dialog_focus_fixture__.tsx', import.meta.url));
  const directory = fileURLToPath(new URL('./', import.meta.url));
  const bundle = await build({
    configFile: false, logLevel: 'silent', define: { 'process.env': JSON.stringify({ NODE_ENV: 'development' }) },
    oxc: { jsx: { runtime: 'automatic' } },
    resolve: { alias: { '@': fileURLToPath(new URL('../../../../../', import.meta.url)) } },
    plugins: [{ name: 'dialog-focus-fixture', enforce: 'pre',
      resolveId(path: string) { if (path === entry) return path; },
      load(path: string) {
        if (path !== entry) return;
        return `import React,{useRef,useState} from 'react';import {createRoot} from 'react-dom/client';
          import {AlertDialog,AlertDialogAction,AlertDialogCancel,AlertDialogContent,AlertDialogDescription,AlertDialogFooter,AlertDialogHeader,AlertDialogTitle} from '@/components/ui/alert-dialog';
          import {useDialogFocusReturn} from ${JSON.stringify(directory + 'dialog-focus-return.ts')};
          function App(){
            const [confirmClose,setConfirmClose]=useState(false),[closed,setClosed]=useState(false),root=useRef(null);
            const focus=useDialogFocusReturn(()=>root.current);
            const close=()=>{focus.remember();setConfirmClose(true);};
            if(closed)return <p>已关闭</p>;
            return <div ref={root} role="dialog" aria-label="报告" tabIndex={-1} onKeyDown={e=>{if(e.key==='Escape'&&!confirmClose)close();}}>
              <button aria-label="关闭报告" onClick={close}>×</button>
              <textarea aria-label="报告正文" defaultValue="正文"/>
              <AlertDialog open={confirmClose} onOpenChange={setConfirmClose}>
                <AlertDialogContent tone="light" onKeyDown={e=>e.stopPropagation()} onCloseAutoFocus={focus.onCloseAutoFocus}>
                  <AlertDialogHeader><AlertDialogTitle>关闭报告？</AlertDialogTitle><AlertDialogDescription>未保存</AlertDialogDescription></AlertDialogHeader>
                  <AlertDialogFooter><AlertDialogCancel>继续编辑</AlertDialogCancel><AlertDialogAction onClick={()=>{setConfirmClose(false);setClosed(true);}}>关闭，放弃修改</AlertDialogAction></AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>;}
          createRoot(document.getElementById('root')).render(<App/>);`;
      } }],
    build: { write: false, minify: false, cssCodeSplit: false, lib: { entry, name: 'DialogFocusTest', formats: ['iife'] } },
  });
  const output = Array.isArray(bundle) ? bundle[0].output : bundle.output;
  code = output.find((item: { type: string }) => item.type === 'chunk').code;
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch({ executablePath: existsSync(chrome) ? chrome : undefined, headless: true });
}, 30000);
afterAll(async () => { await browser?.close(); }, 30000);

async function open(): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }));
  await page.goto('http://dialog-focus.test/');
  await page.addScriptTag({ content: 'window.process={env:{NODE_ENV:"development"},browser:true};' });
  await page.addScriptTag({ content: code });
  return page;
}
const active = (page: Page) => page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName);
// Radix gives focus back a moment after the dialog unmounts, so the focus is awaited, not read at once.
const focused = (page: Page, label: string) => expect.poll(() => active(page), { timeout: 5000 }).toBe(label);

it('Esc in the editor opens the confirm; 继续编辑 returns focus to the editor', async () => {
  const page = await open();
  try {
    await page.getByRole('textbox', { name: '报告正文' }).focus();
    await page.keyboard.press('Escape');
    const dialog = page.getByRole('alertdialog');
    await ui(dialog).toBeVisible();
    await dialog.getByRole('button', { name: '继续编辑', exact: true }).click();
    await ui(dialog).toHaveCount(0);
    await focused(page, '报告正文');
    // The next Esc is still inside the report: it asks again instead of going nowhere.
    await page.keyboard.press('Escape');
    await ui(page.getByRole('alertdialog')).toBeVisible();
  } finally { await page.close(); }
}, 20000);

it('Esc inside the confirm cancels it and returns focus to the control that opened it', async () => {
  const page = await open();
  try {
    await page.getByRole('button', { name: '关闭报告', exact: true }).focus();
    await page.getByRole('button', { name: '关闭报告', exact: true }).click();
    const dialog = page.getByRole('alertdialog');
    await ui(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await ui(dialog).toHaveCount(0);
    await focused(page, '关闭报告');
    // The report did not close and Tab stays inside it.
    await ui(page.getByRole('dialog', { name: '报告' })).toBeVisible();
    await page.keyboard.press('Tab');
    await focused(page, '报告正文');
  } finally { await page.close(); }
}, 20000);

it('with no focused control it falls back to the report itself, and 关闭，放弃修改 still closes', async () => {
  const page = await open();
  try {
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.getByRole('button', { name: '关闭报告', exact: true }).evaluate(button => (button as HTMLButtonElement).click());
    const dialog = page.getByRole('alertdialog');
    await ui(dialog).toBeVisible();
    await dialog.getByRole('button', { name: '继续编辑', exact: true }).click();
    await ui(dialog).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('role')), { timeout: 5000 }).toBe('dialog');
    await page.getByRole('button', { name: '关闭报告', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: '关闭，放弃修改', exact: true }).click();
    await ui(page.getByText('已关闭', { exact: true })).toBeVisible();
  } finally { await page.close(); }
}, 20000);
