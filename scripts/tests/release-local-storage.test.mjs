/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createLocalStorage } from '../e2e-sim/local-storage.mjs';
import { signPreviewJwt } from '../../packages/db/tests/v3/preview-lifecycle.mjs';

test('private storage double requires a service token and signs only objects uploaded in this run', async t => {
  const secret = 'synthetic-local-test-secret-longer-than-32-bytes';
  const server = createServer(createLocalStorage(secret));
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const key = '11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222.png';
  const endpoint = `${origin}/storage/v1/object/ticket-attachments/${key}`;
  const sign = `${origin}/storage/v1/object/sign/ticket-attachments/${key}`;
  const headers = { authorization: `Bearer ${signPreviewJwt(secret, 'service_role')}` };
  assert.equal((await fetch(endpoint, { method: 'POST', body: 'x' })).status, 403);
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { authorization: `Bearer ${signPreviewJwt(secret, 'authenticated')}` }, body: 'x' })).status, 403);
  const wrongSignature = signPreviewJwt('a-different-synthetic-secret-longer-than-32-bytes', 'service_role');
  const expired = signPreviewJwt(secret, 'service_role', { nowSeconds: Math.floor(Date.now() / 1000) - 100, ttlSeconds: 1 });
  for (const token of [wrongSignature, expired]) {
    assert.equal((await fetch(endpoint, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: 'x' })).status, 403);
  }
  assert.equal((await fetch(sign, { method: 'POST', headers, body: '{}' })).status, 404);
  assert.equal((await fetch(endpoint, { method: 'POST', headers, body: 'x' })).status, 200);
  assert.equal((await fetch(endpoint, { method: 'POST', headers, body: 'x' })).status, 409);
  const result = await (await fetch(sign, { method: 'POST', headers, body: '{}' })).json();
  assert.match(result.signedURL, /^\/object\/sign\/ticket-attachments\//);
  assert.equal((await fetch(`${origin}/storage/v1/object/public/ticket-attachments/${key}`, { headers })).status, 404);
});
