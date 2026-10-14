/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, type Browser, type Page } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';

let browser: Browser;
let code: string;
const entry = fileURLToPath(new URL('./__playback_fixture__.jsx', import.meta.url));

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const { build } = await import(pathToFileURL(createRequire(require.resolve('vitest/package.json')).resolve('vite')).href);
  const bundle = await build({
    configFile: false, logLevel: 'silent', define: { 'process.env.NODE_ENV': JSON.stringify('development') },
    oxc: { jsx: { runtime: 'automatic' } },
    resolve: { alias: { '@': fileURLToPath(new URL('../../../', import.meta.url)) } },
    plugins: [{ name: 'playback-fixture', resolveId(id: string) { if (id === entry) return id; }, load(id: string) {
      if (id === entry) return `import React from 'react'; import {createRoot} from 'react-dom/client';
        import {useScenePlayback} from '@/components/landing/preview-i/use-scene-playback';
        const lines=[{role:'coach',text:'${'这是一句很长的教练回答。'.repeat(12)}'},{role:'user',text:'好'}];
        function App(){
          const ref=React.useRef(null);
          const {playback}=useScenePlayback(lines,'scene',ref);
          return <div ref={ref} data-testid="state">{playback?playback.phase:'all'}</div>;
        }
        createRoot(document.getElementById('root')).render(<App/>);`;
    } }],
    build: { write: false, minify: false, lib: { entry, name: 'PlaybackTest', formats: ['iife'] } },
  });
  const output = Array.isArray(bundle) ? bundle[0].output : bundle.output;
  code = output.find((item: { type: string }) => item.type === 'chunk').code;
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch({ executablePath: existsSync(chrome) ? chrome : undefined, headless: true });
}, 30000);
afterAll(async () => { await browser?.close(); });

async function open(reducedMotion: 'reduce' | 'no-preference') {
  const page = await browser.newPage({ reducedMotion });
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }));
  await page.goto('http://localhost/playback');
  await page.addScriptTag({ content: code });
  return page;
}
const state = (page: Page) => page.getByTestId('state').textContent();

it('plays a conversation, and shows every line at once when reduced motion is switched on midway', async () => {
  const page = await open('no-preference');
  try {
    await expect.poll(() => state(page)).toMatch(/thinking|typing/);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect.poll(() => state(page)).toBe('all');
    await page.waitForTimeout(1500);
    expect(await state(page)).toBe('all');
  } finally { await page.close(); }
});

it('never starts playback when reduced motion is on from the start', async () => {
  const page = await open('reduce');
  try {
    await page.waitForTimeout(1200);
    expect(await state(page)).toBe('all');
  } finally { await page.close(); }
});
