/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { createRedisShim, transactionGate } from '../e2e-sim/redis-shim.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const listen = async (t, server) => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
};

/** A bridge like SRH: it answers every request after a short delay and records what was in flight next to each transaction. */
function fakeBridge() {
  const seen = { overlaps: 0, bodies: [] };
  let inFlight = 0, transactionInFlight = false;
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    seen.bodies.push(Buffer.concat(chunks).toString('utf8'));
    const transaction = req.url.startsWith('/multi-exec');
    if (transactionInFlight || (transaction && inFlight > 0)) seen.overlaps++;
    inFlight++; if (transaction) transactionInFlight = true;
    await sleep(transaction ? 15 : 5);
    inFlight--; if (transaction) transactionInFlight = false;
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ result: 'OK' }));
  });
  return { server, seen };
}

const post = (base, path, body) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('a transaction never shares the bridge with another request, and every request is answered', async t => {
  const bridge = fakeBridge();
  const shim = await listen(t, createRedisShim(await listen(t, bridge.server)));
  const requests = [];
  for (let i = 0; i < 60; i++) {
    requests.push(i % 3 === 0 ? post(shim, '/multi-exec', [['zadd', 'k', 1, `m${i}`], ['zcard', 'k']]) : post(shim, '/', ['get', `k${i}`]));
  }
  const statuses = await Promise.all(requests.map(r => r.then(response => response.status)));
  assert.deepEqual([...new Set(statuses)], [200]);
  assert.equal(bridge.seen.overlaps, 0, 'SRH breaks a transaction that runs next to another request (ERR MULTI calls can not be nested)');
});

test('the Upstash-only Lua flag line is dropped, the script body is kept', async t => {
  const bridge = fakeBridge();
  const shim = await listen(t, createRedisShim(await listen(t, bridge.server)));
  await post(shim, '/', ['eval', '#!lua flags=allow-key-locking\nreturn 1', '0']);
  assert.deepEqual(JSON.parse(bridge.seen.bodies[0]), ['eval', 'return 1', '0']);
});

test('a waiting transaction is not starved: requests that arrive after it wait for it', async () => {
  const gate = transactionGate(), order = [];
  await gate.enter(false);
  const transaction = gate.enter(true).then(() => { order.push('transaction'); gate.leave(true); });
  const later = gate.enter(false).then(() => { order.push('later read'); gate.leave(false); });
  await sleep(5);
  assert.deepEqual(order, [], 'nothing runs while the first read is in flight and a transaction waits');
  gate.leave(false);
  await Promise.all([transaction, later]);
  assert.deepEqual(order, ['transaction', 'later read']);
});

test('the shim counts bridge errors and keeps only path, status and time, never the command', async t => {
  const failing = createServer((req, res) => { req.resume(); req.on('end', () => res.writeHead(500).end('{"error":"boom"}')); });
  const shim = createRedisShim(await listen(t, failing));
  const base = await listen(t, shim);
  assert.equal((await post(base, '/pipeline', [['get', 'secret-key']])).status, 500);
  assert.equal(shim.stats.calls, 1);
  assert.equal(shim.stats.errors, 1);
  assert.match(shim.stats.anomalies[0], /^\d\d:\d\d:\d\d\.\d{3} \/pipeline 500 \d+ms$/);
  assert.doesNotMatch(JSON.stringify(shim.stats), /secret-key/);
});
