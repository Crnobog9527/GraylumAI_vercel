/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { createReleaseProxy } from '../e2e-sim/release-proxy.mjs';
const listen = server => new Promise(ok => server.listen(0, '127.0.0.1', ok));
const close = server => new Promise(ok => server.close(ok));
const get = (port, target) => new Promise((ok, fail) => {
  const req = request({ host: '127.0.0.1', port, path: target }, res => { res.resume(); res.on('end', () => ok(res.statusCode)); });
  req.on('error', fail); req.end();
});
test('proxy allows only the exact run-owned local origins', async () => {
  const app = createServer((_req, res) => res.end('ok'));
  await listen(app);
  const appUrl = `http://127.0.0.1:${app.address().port}`;
  const proxy = createReleaseProxy([appUrl]); await listen(proxy);
  try {
    const port = proxy.address().port;
    assert.equal(await get(port, `${appUrl}/login`), 200);
    assert.equal(await get(port, 'http://127.0.0.1:1/'), 403);
    assert.equal(await get(port, 'http://example.com/'), 403);
    assert.equal(await get(port, 'http://127.0.0.1.example.com/'), 403);
  } finally { await close(proxy); await close(app); }
});
