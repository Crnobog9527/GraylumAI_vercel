/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Real-Chromium harness for the library sandbox. Server A plays the Graylum origin: it serves the
// test page, the production worker bundle and the samples. Server B is an outside listener that
// must never receive anything. Every request either server sees is recorded.
import { existsSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium, type Browser, type Page } from '@playwright/test';
import { buildLibrarySandbox } from '../../../../scripts/build-library-sandbox.mjs';

export type Harness = {
  browser: Browser;
  origin: string;
  outside: string;
  /** Paths requested from server A that are not the page, harness, worker bundle or a sample. */
  unexpected: string[];
  /** Every request (HTTP or WebSocket upgrade) the outside server received. */
  outsideRequests: string[];
  samples: Map<string, Buffer>;
  workerSource: string;
  /** How server A answers the worker bundle request: normally, or like a signed-out visitor / an error page. */
  workerResponse: 'script' | 'login-redirect' | 'html' | 'stall';
  open(): Promise<Page>;
  close(): Promise<void>;
};

const PAGE = '<!doctype html><html><head><meta charset="utf-8"></head><body><script src="/harness.js"></script></body></html>';

async function bundleHarness(): Promise<string> {
  const entry = fileURLToPath(new URL('./harness-entry.ts', import.meta.url));
  const output = await build({
    entryPoints: [entry], bundle: true, platform: 'browser', format: 'iife', target: ['es2022'], write: false,
    logLevel: 'silent', define: { 'process.env.NEXT_PUBLIC_LIBRARY_DOCX_EXTRACTION': '"true"', 'process.env.NODE_ENV': '"test"' },
  });
  return output.outputFiles[0].text;
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  }));
}

export async function startHarness(): Promise<Harness> {
  const [{ 'docx-worker': docx }, harnessCode] = await Promise.all([buildLibrarySandbox({ outdir: null }), bundleHarness()]);
  const samples = new Map<string, Buffer>();
  const unexpected: string[] = [];
  const outsideRequests: string[] = [];
  const sockets = new Set<Socket>();
  const graylum = createServer((request, response) => {
    const url = request.url ?? '';
    const send = (type: string, body: string | Buffer) => {
      response.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
      response.end(body);
    };
    if (url === '/') return send('text/html; charset=utf-8', PAGE);
    if (url === '/favicon.ico') return response.writeHead(204).end();
    if (url === '/harness.js') return send('text/javascript', harnessCode);
    if (url === '/library-sandbox/docx-worker.js') {
      if (harness.workerResponse === 'login-redirect') return response.writeHead(307, { location: '/login' }).end();
      if (harness.workerResponse === 'html') return send('text/html; charset=utf-8', PAGE);
      if (harness.workerResponse === 'stall') return;
      return send('text/javascript', docx.code);
    }
    const sample = url.startsWith('/sample/') ? samples.get(decodeURIComponent(url.slice(8))) : undefined;
    if (sample) return send('application/octet-stream', sample);
    unexpected.push(`${request.method} ${url}`);
    response.writeHead(404).end();
  });
  const record = (request: IncomingMessage) => outsideRequests.push(`${request.method} ${request.url}`);
  const outsideServer = createServer((request, response) => {
    record(request);
    response.writeHead(200, { 'access-control-allow-origin': '*' }).end('leak');
  });
  outsideServer.on('upgrade', (request, socket) => {
    record(request);
    socket.destroy();
  });
  for (const server of [graylum, outsideServer]) server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  const [origin, outside] = await Promise.all([listen(graylum), listen(outsideServer)]);
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const browser = await chromium.launch({ executablePath: existsSync(chrome) ? chrome : undefined, headless: true });
  const harness: Harness = {
    browser, origin, outside, unexpected, outsideRequests, samples, workerSource: docx.code, workerResponse: 'script',
    async open() {
      const page = await browser.newPage();
      await page.goto(`${origin}/`);
      await page.waitForFunction(() => 'sandboxTest' in window);
      return page;
    },
    async close() {
      await browser.close();
      for (const socket of sockets) socket.destroy();
      await Promise.all([graylum, outsideServer].map((server) => new Promise((resolve) => server.close(resolve))));
    },
  };
  return harness;
}
