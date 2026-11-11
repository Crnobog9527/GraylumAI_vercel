/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// useTurnChat in a real browser against a scripted server (走查 26). The server refused a message in 3 seconds and the page went on
// saying "正在思考…": the notice waited for the stream to close and then for the conversation to be read again. Here the stream is
// left open, or the read never answers, and a definite refusal still has to be said at once. A failure that is not a definite
// refusal keeps waiting for the read, as before.
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, expect as browserExpect, type Browser } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { POSITIONING_REQUIRED_NOTICE } from './gate-notices';

let browser: Browser;
let code: string;
const entry = fileURLToPath(new URL('./__turn_chat_refusal_fixture__.js', import.meta.url));
type Scenario = { code: string; streamStaysOpen: boolean; readAnswers: boolean };
beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const vite = createRequire(require.resolve('vitest/package.json')).resolve('vite');
  const { build } = await import(pathToFileURL(vite).href);
  const hook = fileURLToPath(new URL('./use-turn-chat.ts', import.meta.url));
  const bundle = await build({
    configFile: false, logLevel: 'silent', define: { 'process.env.NODE_ENV': JSON.stringify('development') },
    oxc: { jsx: { runtime: 'automatic' } },
    resolve: { alias: { '@': fileURLToPath(new URL('../../../../', import.meta.url)) } },
    plugins: [{ name: 'turn-chat-refusal-fixture', enforce: 'pre', resolveId(id: string) { if (id === entry) return id; },
      load(id: string) {
        if (id !== entry) return;
        return `import React from 'react'; import { createRoot } from 'react-dom/client';
          import { useTurnChat } from ${JSON.stringify(hook)};
          const scenario = window.scenario;
          const empty = { activeTurn: null, lastTurn: null, messages: [], calls: [] };
          const json = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
          const frame = event => new TextEncoder().encode('event: ' + event.type + '\\ndata: ' + JSON.stringify(event) + '\\n\\n');
          window.reads = 0; window.sent = false;
          // One function for the page's life, as the hook asks of its fetcher.
          const server = (url, init) => {
            if (init?.method === 'POST') {
              window.sent = true;
              return Promise.resolve(new Response(new ReadableStream({ start(controller) {
                controller.enqueue(frame({ type: 'opened', turnId: 7, reservedCredits: 10, replay: false }));
                controller.enqueue(frame({ type: 'error', code: scenario.code, turnId: 7 }));
                if (!scenario.streamStaysOpen) controller.close();
              } }), { headers: { 'content-type': 'text/event-stream' } }));
            }
            window.reads++;
            // Before the send the conversation reads as empty; after it the read answers only when the scenario lets it.
            if (!window.sent || scenario.readAnswers) return Promise.resolve(json(empty));
            return new Promise(resolve => { window.releaseRead = () => resolve(json(empty)); });
          };
          function Harness() {
            const chat = useTurnChat('11111111-1111-4111-8111-111111111111', () => {}, server);
            return React.createElement('div', null,
              React.createElement('p', { 'data-testid': 'notice' }, chat.notice?.text ?? ''),
              React.createElement('p', { 'data-testid': 'state' }, (chat.sending ? 'sending' : 'idle') + ' ' + (chat.live ? 'thinking' : 'quiet')),
              React.createElement('button', { disabled: !chat.view, onClick: () => {
                void chat.send('帮我写一篇小红书笔记', 'request-1').then(answer => { window.answer = answer; });
              } }, 'send'));
          }
          createRoot(document.getElementById('root')).render(React.createElement(Harness));`;
      } }],
    build: { write: false, minify: false, lib: { entry, name: 'TurnChatRefusalTest', formats: ['iife'] } },
  });
  const output = Array.isArray(bundle) ? bundle[0].output : bundle.output;
  code = output.find((item: { type: string }) => item.type === 'chunk').code;
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch({ executablePath: existsSync(chrome) ? chrome : undefined, headless: true });
}, 60000);
afterAll(async () => { await browser?.close(); });

async function open(scenario: Scenario) {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  // A real origin (the hook keeps the last view in this browser's storage); nothing leaves the machine.
  await page.route('**/*', route => (route.request().url() === 'https://chat.test/'
    ? route.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="root"></div>' }) : route.abort()));
  await page.goto('https://chat.test/');
  await page.evaluate(value => { (window as unknown as { scenario: Scenario }).scenario = value; }, scenario);
  await page.addScriptTag({ content: code });
  await page.getByRole('button', { name: 'send' }).click();
  return { page, errors, notice: page.getByTestId('notice'), state: page.getByTestId('state') };
}

it('says the positioning refusal when its event arrives, though the stream stays open and nothing can be read back', async () => {
  const { page, errors, notice, state } = await open({ code: 'POSITIONING_REQUIRED', streamStaysOpen: true, readAnswers: false });
  try {
    await browserExpect(notice).toHaveText(POSITIONING_REQUIRED_NOTICE);
    // "正在思考…" is gone with it: there is no reply being written
    await browserExpect(state).toHaveText('sending quiet');
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 30000);

it('gives the message back once the stream ends, without waiting for the conversation to be read again', async () => {
  const { page, errors, notice, state } = await open({ code: 'POSITIONING_REQUIRED', streamStaysOpen: false, readAnswers: false });
  try {
    await browserExpect(notice).toHaveText(POSITIONING_REQUIRED_NOTICE);
    await browserExpect(state).toHaveText('idle quiet');
    await browserExpect.poll(() => page.evaluate('window.answer')).toBe('kept');
    // the read was still asked for (the balance and the list follow it); it just is not waited for
    expect(await page.evaluate('window.reads')).toBeGreaterThanOrEqual(2);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 30000);

it('still reads the conversation back before speaking of a failure that may have been stored', async () => {
  const { page, errors, notice, state } = await open({ code: 'TURN_PROVIDER_BUSY', streamStaysOpen: false, readAnswers: false });
  try {
    await browserExpect.poll(() => page.evaluate('typeof window.releaseRead')).toBe('function');
    await browserExpect(notice).toHaveText('');
    await browserExpect(state).toHaveText('sending thinking');
    await page.evaluate('window.releaseRead()');
    await browserExpect(notice).toContainText('模型服务繁忙');
    await browserExpect(state).toHaveText('idle quiet');
    await browserExpect.poll(() => page.evaluate('window.answer')).toBe('unknown');
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 30000);
