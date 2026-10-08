/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, expect as ui, type Browser, type Page } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { agentTurnBody } from '@repo/api/src/shared/agentTurn';
import { livePrefixKey } from './live-prefix';

const executionId = '00000000-0000-4000-8000-000000000001';
const prefix = '合成🧭正文\n这是**停止时的重点';
const unseenCheckpoint = '只在未确认检查点存在的合成正文';
const artifacts = process.env.C2_LIFECYCLE_ARTIFACTS;
let browser: Browser;
let code: string;
let css: string;

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const { build } = await import(pathToFileURL(createRequire(require.resolve('vitest/package.json')).resolve('vite')).href);
  const entry = fileURLToPath(new URL('./__stop_lifecycle_fixture__.tsx', import.meta.url));
  const directory = fileURLToPath(new URL('./', import.meta.url));
  // Test-only transport: the production hook/controller still own stopping, recovery and lifecycle.
  const transport = `let resumed=0;
    export async function json(path,input,source){
    const response=await fetch(path,{method:input?'POST':'GET',cache:'no-store',
      headers:{'x-fixture-history-source':source??(resumed?'resume:'+resumed:'stop')},
      ...(input?{body:JSON.stringify(input),headers:{'Content-Type':'application/json'}}:{})});
    if(!response.ok)throw new Error('fixture HTTP '+response.status);return response.json();}
    export async function* events(path,input){
      const response=await fetch(path,{method:input?'POST':'GET',headers:{'x-fixture-document':String(performance.timeOrigin)},
        ...(input?{body:JSON.stringify(input)}:{})});
      if(!response.ok)throw new Error('fixture stream');
      const reader=response.body.getReader(),decoder=new TextDecoder();let pending='';
      try{while(true){const {done,value}=await reader.read();if(done){if(path==='/resume')resumed++;break;}
        pending+=decoder.decode(value,{stream:true});let end;
        while((end=pending.indexOf('\\n'))>=0){const line=pending.slice(0,end);pending=pending.slice(end+1);
          if(line)yield JSON.parse(line);}}}finally{reader.releaseLock();}}
    export let acceptHistory=()=>{};
    export const bindHistory=setter=>{acceptHistory=setter;};
    const utils={client:{runtime:{executeStream:{mutate:async input=>events('/resume',input)}}},
      runtime:{view:{invalidate:async()=>{try{acceptHistory(await json('/history'));}catch{}}}}};
    export const trpc={useUtils:()=>utils,runtime:{cancel:{useMutation:()=>({mutateAsync:input=>json('/stop',input)})}}};`;
  const bundle = await build({
    configFile: false, logLevel: 'silent', define: { 'process.env.NODE_ENV': JSON.stringify('development') },
    oxc: { jsx: { runtime: 'automatic' } },
    resolve: { alias: { '@/trpc/client': '\0stop-test-transport', '@': fileURLToPath(new URL('../../../', import.meta.url)) } },
    plugins: [{ name: 'stop-lifecycle-fixture', enforce: 'pre',
      resolveId(id: string) {
        if (id === entry) return id;
        if (id === '\0stop-test-transport') return '\0stop-test-transport';
      },
      load(id: string) {
        if (id === '\0stop-test-transport') return transport;
        if (id !== entry) return;
        return `import React from 'react';import {createRoot} from 'react-dom/client';
          import {useLiveReply} from ${JSON.stringify(directory + 'use-live-reply.ts')};
          import {MentorMarkdown} from ${JSON.stringify(directory + 'MentorMarkdown.tsx')};
          import {mentorReplyDisplay} from ${JSON.stringify(directory + 'agent-turn-display.ts')};
          import {mentorTailNotices,mentorTurnNotice} from ${JSON.stringify(directory + 'mentor-notices.ts')};
          import {ChatNoticeList} from '@/components/chat/ChatInlineNotice';
          import {json,events,bindHistory} from '@/trpc/client';
          function App(){
            const [history,setHistory]=React.useState();bindHistory(setHistory);
            const live=useLiveReply('synthetic-draft',history);
            React.useEffect(()=>{let disposed=false;
              void json('/history',undefined,'initial').then(h=>{if(disposed)return;setHistory(h);
                if(h.executions[0].state==='running'&&!h.executions[0].userStopPending)
                  void live.stream(async()=>events('/stream'),{}).catch(()=>{});});
              return()=>{disposed=true;};},[]);
            window.injectLate=()=>{live.apply('${executionId}',{type:'textDelta',offset:0,rev:99,
              text:'不该显示的替换快照',source:'final'});
              live.apply('${executionId}',{type:'text',text:'不该显示的迟到全文'});
              live.apply('${executionId}',{type:'card',card:{question:'不该显示的卡片',options:['A','B'],recommended:0}});};
            const execution=history?.executions[0]??{state:'running'};
            const reply=mentorReplyDisplay({...execution,legacyMessage:'',liveText:live.reply?.text,
              liveCard:live.reply?.card,stopLocal:live.stopLocal('${executionId}'),active:!!history?.activeExecution,busy:false});
            return <><main id="message"><MentorMarkdown text={reply.text} live={!!live.reply} result={execution}/></main>
              <output id="history-state" data-history-source={history?.source} data-history-sequence={history?.sequence}
                data-execution-id={execution.executionId}>{execution.state}:{String(execution.userStopPending)}</output>
              <ChatNoticeList notices={live.phase?mentorTailNotices({livePhase:live.phase,stop:live.stopAction,
                replying:false,lastTurnOpen:false,saving:false,recovery:null,error:'',notice:'',freeError:''})
                :[mentorTurnNotice('turn',reply.notice,null)]}/></>;}
          createRoot(document.getElementById('root')).render(<App/>);`;
      },
    }],
    build: { write: false, minify: false, cssCodeSplit: false, lib: { entry, name: 'StopLifecycleTest', formats: ['iife'] } },
  });
  const output: { type: string; fileName: string; code?: string; source?: string }[] =
    Array.isArray(bundle) ? bundle[0].output : bundle.output;
  code = output.find(item => item.type === 'chunk')?.code ?? '';
  css = String(output.find(item => item.fileName.endsWith('.css'))?.source ?? '');
  expect(css).toContain('line-height:');
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch({ executablePath: existsSync(chrome) ? chrome : undefined, headless: true });
  if (artifacts) mkdirSync(artifacts, { recursive: true });
}, 30000);
afterAll(async () => { await browser?.close(); });

async function fixture(width: number, pendingCheckpoint = false, holdFirstResume = true) {
  let state = 'running', stopped = false;
  let stream: ServerResponse | undefined;
  const stops: unknown[] = [], resumes: unknown[] = [];
  const resumeDocuments: string[] = [];
  let streams = 0, historySequence = 0;
  const heldResumes = new Map<string, () => void>();
  const saved = () => state === 'completed';
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    const path = request.url;
    if (path === '/') { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(
      '<div id="root"></div><link rel="stylesheet" href="/fixture.css"><script src="/fixture.js"></script>'); return; }
    if (path === '/fixture.js') { response.setHeader('Content-Type', 'text/javascript; charset=utf-8'); response.end(code); return; }
    if (path === '/fixture.css') { response.setHeader('Content-Type', 'text/css'); response.end(css); return; }
    if (path === '/probe') { response.end('online'); return; }
    if (path === '/history') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ sequence: ++historySequence,
        source: request.headers['x-fixture-history-source'], activeExecution: saved() ? null : executionId, executions: [{
        executionId, state, userStopPending: stopped && !saved(),
        ...(pendingCheckpoint && stopped && !saved() ? { body: agentTurnBody(unseenCheckpoint, null) } : {}),
        ...(saved() ? { body: agentTurnBody(prefix, null), stopped: true, completeness: 'stopped', organized: false } : {}),
      }] })); return;
    }
    if (path === '/stream') {
      streams++; stream = response;
      response.setHeader('Content-Type', 'application/x-ndjson');
      response.write(JSON.stringify({ type: 'admitted', executionId }) + '\n');
      response.write(JSON.stringify({ type: 'textDelta', offset: 0, rev: 1, text: prefix, source: 'assistant' }) + '\n');
      return;
    }
    let input = '';
    for await (const chunk of request) input += chunk;
    if (path === '/stop') {
      stops.push(JSON.parse(input)); stopped = true;
      // Accept the stop but do not complete persistence until the test explicitly releases it.
      stream?.end(JSON.stringify({ type: 'result', result: { state: 'stopping' } }) + '\n');
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ state: 'stopping' })); return;
    }
    if (path === '/resume') {
      resumes.push(JSON.parse(input));
      resumeDocuments.push(String(request.headers['x-fixture-document']));
      response.setHeader('Content-Type', 'application/x-ndjson');
      const finish = () => response.end(JSON.stringify({ type: 'result', result: { state: saved() ? 'completed' : 'stopping' } }) + '\n');
      const documentId = String(request.headers['x-fixture-document']);
      if (holdFirstResume && resumeDocuments.filter(id => id === documentId).length === 1) heldResumes.set(documentId, finish);
      else finish();
      return;
    }
    response.statusCode = 404; response.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing loopback port');
  const origin = `http://127.0.0.1:${address.port}`;
  const context = await browser.newContext({ viewport: { width, height: 963 }, serviceWorkers: 'block' });
  const unexpected: string[] = [];
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    unexpected.push(route.request().url()); return route.abort();
  });
  const page = await context.newPage();
  const failures: string[] = [];
  page.on('requestfailed', request => failures.push(new URL(request.url()).pathname));
  await page.goto(origin);
  return { page, context, stops, resumes, resumeDocuments, failures, unexpected, streams: () => streams,
    release: () => { state = 'completed'; },
    continueResume: (documentId: string) => {
      const finish = heldResumes.get(documentId);
      if (!finish) throw new Error('no held resume for this document');
      heldResumes.delete(documentId); finish();
    },
    close: async () => { await context.setOffline(false); await context.close(); server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); },
  };
}

// Hold the first response per document to exercise the arrival-before-read window deterministically.
// Only a new, rendered history from that completed resume may release persistence.
async function applyFirstResumeHistory(f: Awaited<ReturnType<typeof fixture>>, previous: 'initial' | 'stop') {
  const documentId = await f.page.evaluate(() => String(performance.timeOrigin));
  await expect.poll(() => f.resumeDocuments.filter(id => id === documentId).length, { timeout: 7000 }).toBe(1);
  const history = f.page.locator('#history-state');
  await ui(history).toHaveAttribute('data-history-source', previous);
  await ui(history).toHaveText('running:true');
  const previousSequence = Number(await history.getAttribute('data-history-sequence'));
  // The old arrival + running:true barrier already passes here while the response is still held.
  f.continueResume(documentId);
  await ui(history).toHaveAttribute('data-history-source', 'resume:1');
  await ui(history).toHaveText('running:true');
  expect(Number(await history.getAttribute('data-history-sequence'))).toBeGreaterThan(previousSequence);
  await ui(history).toHaveAttribute('data-execution-id', executionId);
}

type Observation = { at: number; height: number; kind: string; text: string; html: string; visible: boolean };
type Trace = { baseline: Observation | null; samples: Observation[]; mutations: string[]; clickTrusted: boolean; frames: number };
type FixtureWindow = Window & { trace: Trace; finish: () => Trace; injectLate: () => void };

async function observeAndClick(page: Page) {
  await ui(page.locator('[data-message-markdown]')).toHaveText('合成🧭正文\n这是停止时的重点');
  await page.evaluate(() => {
    const win = window as unknown as FixtureWindow;
    const host = document.getElementById('message')!;
    const trace: Trace = { baseline: null, samples: [], mutations: [], clickTrusted: false, frames: 0 };
    win.trace = trace;
    const sample = (kind: string): Observation => {
      const body = host.querySelector<HTMLElement>('[data-message-markdown]');
      const rect = body?.getBoundingClientRect();
      const style = body && getComputedStyle(body);
      return { at: performance.now(), height: rect?.height ?? 0, kind, text: body?.innerText ?? '', html: body?.innerHTML ?? '',
        visible: !!rect?.width && !!rect.height && style?.visibility !== 'hidden' && style?.display !== 'none' && style?.opacity !== '0' };
    };
    const changes = new MutationObserver(records => {
      if (!trace.baseline) return;
      // Preserve every record, including transient remove/reinsert within one observer batch.
      trace.mutations.push(...records.map(record => record.type + ':' + (record.oldValue ?? '') + ':' +
        [...record.removedNodes].map(node => node.textContent).join('|')));
      trace.samples.push(sample('mutation'));
    });
    changes.observe(host, { subtree: true, childList: true, characterData: true, characterDataOldValue: true,
      attributes: true, attributeOldValue: true });
    let frame = 0;
    const tick = () => { if (trace.baseline) { trace.frames++; trace.samples.push(sample('frame')); }
      frame = requestAnimationFrame(tick); };
    frame = requestAnimationFrame(tick);
    const capture = (event: MouseEvent) => {
      if (!(event.target instanceof Element) || event.target.closest('button')?.textContent !== '停止') return;
      trace.clickTrusted = event.isTrusted; trace.baseline = sample('capture');
    };
    document.addEventListener('click', capture, true);
    win.finish = () => { changes.disconnect(); cancelAnimationFrame(frame); document.removeEventListener('click', capture, true);
      trace.samples.push(sample('finish')); return trace; };
  });
  await page.getByRole('button', { name: '停止', exact: true }).click();
}

async function assertTrace(page: Page, name: string) {
  const trace = await page.evaluate(() => (window as unknown as FixtureWindow).finish());
  expect(trace.clickTrusted).toBe(true);
  expect(trace.baseline?.text).toBe('合成🧭正文\n这是停止时的重点');
  expect(trace.baseline?.visible).toBe(true);
  expect(trace.frames).toBeGreaterThan(2);
  for (const sample of trace.samples) {
    expect(sample.text, sample.kind).toBe(trace.baseline!.text);
    expect(sample.html, sample.kind).toBe(trace.baseline!.html);
    expect(sample.visible, sample.kind).toBe(true);
  }
  // Same input and DOM survive settlement; even a same-batch clear/reinsert must fail this assertion.
  expect(trace.mutations).toEqual([]);
  if (artifacts) writeFileSync(`${artifacts}/${name}.json`, JSON.stringify(trace, null, 2));
  return trace.baseline!;
}

for (const offline of [false, true]) {
  it(offline ? 'C2: one real network outage during saving recovers and survives a page reload'
    : 'C2: a real stop click freezes its capture-phase DOM through delayed persistence', async () => {
    const f = await fixture(offline ? 390 : 1920, false, !offline);
    try {
      await observeAndClick(f.page);
      await ui(f.page.getByText('已停止，正在保存已显示的内容…', { exact: true })).toBeVisible();
      await ui(f.page.locator('#history-state')).toHaveText('running:true');
      expect(f.stops).toEqual([{ executionId, stopAt: Array.from(prefix).length, source: 'assistant' }]);
      await f.page.evaluate(() => (window as unknown as FixtureWindow).injectLate());
      if (offline) {
        await f.context.setOffline(true);
        const probeFailed = await f.page.evaluate(() => fetch('/probe').then(() => false, () => true));
        expect(probeFailed).toBe(true);
        // Keep the persistence gate closed until a real scheduled recovery request fails offline.
        await expect.poll(() => f.failures.includes('/resume'), { timeout: 7000 }).toBe(true);
        // The hook invalidates history after the failed stream. Keep that read offline too,
        // so recovery cannot race through it before the next scheduled follow-up.
        await expect.poll(() => f.failures.includes('/history'), { timeout: 7000 }).toBe(true);
        expect(f.resumes).toHaveLength(0);
        expect(f.failures).toContain('/probe');
      } else {
        await applyFirstResumeHistory(f, 'stop');
      }
      f.release();
      if (offline) await f.context.setOffline(false);
      await ui(f.page.locator('#history-state')).toHaveText('completed:false', { timeout: 15000 });
      await ui(f.page.getByText('本轮未整理', { exact: false })).toBeVisible();
      await ui(f.page.getByRole('button', { name: '停止', exact: true })).toHaveCount(0);
      const before = await assertTrace(f.page, offline ? 'offline' : 'delayed');
      expect(f.stops).toHaveLength(1);
      expect(f.streams()).toBe(1);
      expect(f.resumes.length).toBe(offline ? 1 : 2);
      for (const request of f.resumes) expect(request).toEqual({ executionId, textProtocol: 'textDelta-v1' });
      if (offline) {
        const oldDocument = await f.page.evaluate(() => { (window as unknown as { oldDocument: boolean }).oldDocument = true; return true; });
        expect(oldDocument).toBe(true);
        await f.page.reload();
        expect(await f.page.evaluate(() => 'oldDocument' in window)).toBe(false);
        await ui(f.page.locator('#history-state')).toHaveText('completed:false');
        const body = f.page.locator('[data-message-markdown]');
        expect(await body.innerText()).toBe(before.text);
        expect(await body.innerHTML()).toBe(before.html);
        await ui(f.page.getByText('本轮未整理', { exact: false })).toBeVisible();
        expect(f.streams()).toBe(1); expect(f.stops).toHaveLength(1);
      }
      expect(f.unexpected).toEqual([]);
    } finally { await f.close(); }
  }, 35000);
}


for (const keepPrefix of [true, false]) {
  it(`C2: reload during pending v1 saving with ${keepPrefix ? 'a retained' : 'no retained'} prefix`, async () => {
    const f = await fixture(keepPrefix ? 1920 : 390, true);
    try {
      await observeAndClick(f.page);
      await ui(f.page.locator('#history-state')).toHaveText('running:true');
      const before = await f.page.evaluate(() => (window as unknown as FixtureWindow).finish().baseline!);
      // The gate is still closed. A new document, rather than a remount, must recover this execution.
      await f.page.evaluate(() => { (window as unknown as { oldDocument: boolean }).oldDocument = true; });
      await f.page.addInitScript(({ dropKey, marker }) => {
        if (dropKey) sessionStorage.removeItem(dropKey);
        const win = window as unknown as { checkpointExposed: boolean };
        win.checkpointExposed = false;
        new MutationObserver(records => {
          if (document.body?.textContent?.includes(marker) || records.some(record =>
            [...record.addedNodes, ...record.removedNodes].some(node => node.textContent?.includes(marker))))
            win.checkpointExposed = true;
        }).observe(document, { subtree: true, childList: true, characterData: true });
      }, { dropKey: keepPrefix ? null : livePrefixKey('synthetic-draft'), marker: unseenCheckpoint });
      await f.page.reload();
      expect(await f.page.evaluate(() => 'oldDocument' in window)).toBe(false);
      await ui(f.page.locator('#history-state')).toHaveText('running:true');
      await ui(f.page.locator('#history-state')).toHaveAttribute('data-execution-id', executionId);
      await ui(f.page.getByText('已停止，正在保存已显示的内容…', { exact: true })).toBeVisible();
      await ui(f.page.getByRole('button', { name: '停止', exact: true })).toHaveCount(0);
      await ui(f.page.getByRole('button', { name: '重试', exact: true })).toHaveCount(0);
      await ui(f.page.getByText('本轮未整理', { exact: false })).toHaveCount(0);
      const body = f.page.locator('[data-message-markdown]');
      const pendingText = await body.innerText();
      // A safe restored prefix is allowed, but continuous visibility is not a new requirement.
      expect(keepPrefix ? ['', before.text] : ['']).toContain(pendingText);
      expect(await f.page.evaluate(() => (window as unknown as { checkpointExposed: boolean }).checkpointExposed)).toBe(false);
      // Bind the follow-up to the new document, not an old request finishing during navigation.
      await applyFirstResumeHistory(f, 'initial');
      expect(await body.innerText()).toBe(pendingText);
      expect(f.stops).toEqual([{ executionId, stopAt: Array.from(prefix).length, source: 'assistant' }]);
      expect(f.streams()).toBe(1);
      f.release();
      await ui(f.page.locator('#history-state')).toHaveText('completed:false', { timeout: 15000 });
      await ui(f.page.getByText('已停止，保留了停止前显示的内容。', { exact: false })).toBeVisible();
      await ui(f.page.getByText('本轮未整理', { exact: false })).toBeVisible();
      expect(await body.innerText()).toBe(before.text);
      expect(await body.innerHTML()).toBe(before.html);
      expect(f.stops).toHaveLength(1); expect(f.streams()).toBe(1);
      for (const request of f.resumes) expect(request).toEqual({ executionId, textProtocol: 'textDelta-v1' });
      expect(await f.page.evaluate(() => (window as unknown as { checkpointExposed: boolean }).checkpointExposed)).toBe(false);
      expect(f.unexpected).toEqual([]);
      if (artifacts) writeFileSync(`${artifacts}/pending-reload-${keepPrefix}.json`, JSON.stringify({
        keepPrefix, realReload: true, pendingText, finalText: await body.innerText(),
        checkpointExposed: false, stops: f.stops, streams: f.streams(), resumes: f.resumes,
      }, null, 2));
    } finally { await f.close(); }
  }, 35000);
}
