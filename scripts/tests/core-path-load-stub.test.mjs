/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createStub } from '../loadtest/openrouter-stub.mjs';

async function start(t, options) {
  const server = createStub(options);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}/api/v1`;
}
const post = (base, body, path = '/chat/completions') => fetch(base + path, { method: 'POST', body: JSON.stringify(body) });
const parts = body => (body.match(/"content":"测试"/g) ?? []).length;
const skillTool = { type: 'function', function: { name: 'read_skill_file', parameters: { type: 'object', required: ['path', 'mode'],
  properties: { path: { type: 'string' }, mode: { type: 'string', enum: ['full', 'head'] } } } } };

test('streams a matching generation and exposes the completed receipt', async t => {
  const base = await start(t, { firstByteMs: 20, intervalMs: 5, chunks: 3 });
  const response = await post(base, { model: 'test/model', stream: true });
  const id = response.headers.get('x-generation-id');
  assert.match(id, /^gen-load-/);
  const body = await response.text();
  assert.equal(parts(body), 3);
  assert.match(body, /data: \[DONE\]/);
  const receipt = await (await fetch(`${base}/generation?id=${id}`)).json();
  assert.equal(receipt.data.id, id);
  assert.equal(receipt.data.model, 'test/model');
  assert.equal(receipt.data.total_cost, 0, 'a request without a price bound costs nothing');
  assert.equal((await fetch(`${base}/generation?id=unknown`)).status, 404);
});

test('first byte waits firstByteMs and chunks keep the 50 ms-style cadence', async t => {
  const base = await start(t, { firstByteMs: 120, intervalMs: 30, chunks: 4 });
  const started = Date.now();
  const response = await post(base, { model: 'm', stream: true });
  const reader = response.body.getReader();
  await reader.read();
  const firstByte = Date.now() - started;
  while (!(await reader.read()).done);
  const total = Date.now() - started;
  assert.ok(firstByte >= 110, `first byte after ${firstByte} ms`);
  assert.ok(total >= 120 + 4 * 30 - 15, `whole reply took ${total} ms`);
});

test('tool follow-up uses the shorter stream', async t => {
  const base = await start(t, { firstByteMs: 1, intervalMs: 1, chunks: 6, secondChunks: 2 });
  const body = await (await post(base, { model: 'm', stream: true, messages: [{ role: 'tool' }] })).text();
  assert.equal(parts(body), 2);
});

test('the coach first call answers with the skill tool call and schema-valid arguments, the second with text', async t => {
  const base = await start(t, { firstByteMs: 1, intervalMs: 1, chunks: 5, secondChunks: 2 });
  const first = await (await post(base, { model: 'm', stream: true, tools: [skillTool], messages: [{ role: 'user' }] })).text();
  assert.match(first, /"tool_calls"/);
  assert.match(first, /"finish_reason":"tool_calls"/);
  const args = JSON.parse(/"arguments":("(?:[^"\\]|\\.)*")/.exec(first)[1]);
  assert.deepEqual(JSON.parse(args), { path: 'references/01-discovery.md', mode: 'full' });
  const second = await (await post(base, { model: 'm', stream: true, tools: [skillTool],
    messages: [{ role: 'user' }, { role: 'assistant' }, { role: 'tool' }] })).text();
  assert.equal(parts(second), 2);
  assert.doesNotMatch(second, /"tool_calls"/);
});

test('a later turn of the same session starts with the tool call again although its history holds earlier tool results', async t => {
  const base = await start(t, { firstByteMs: 1, intervalMs: 1, chunks: 5, secondChunks: 2 });
  const history = [{ role: 'user' }, { role: 'assistant' }, { role: 'tool' }, { role: 'assistant' }];
  const next = await (await post(base, { model: 'm', stream: true, tools: [skillTool], messages: [...history, { role: 'user' }] })).text();
  assert.match(next, /"tool_calls"/);
  const followUp = await (await post(base, { model: 'm', stream: true, tools: [skillTool], messages: [...history, { role: 'user' }, { role: 'assistant' },
    { role: 'tool' }] })).text();
  assert.equal(parts(followUp), 2);
  assert.doesNotMatch(followUp, /"tool_calls"/);
});

test('non-streaming calls return the whole message, usage and a receipt; usage stays under the call\'s own price bound', async t => {
  const base = await start(t, { firstByteMs: 5, intervalMs: 1, chunks: 4 });
  const response = await post(base, { model: 'm', provider: { max_price: { prompt: 3, completion: 15 } }, messages: [{ role: 'user',
    content: 'x'.repeat(800) }] });
  const id = response.headers.get('x-generation-id');
  const reply = await response.json();
  assert.equal(reply.id, id);
  assert.equal(reply.choices[0].message.content, '测试'.repeat(4));
  assert.equal(reply.usage.completion_tokens, 8);
  assert.ok(reply.usage.cost > 0);
  const upper = (reply.usage.prompt_tokens * 3 + 1000 * 15) / 1e6;
  assert.ok(reply.usage.cost < upper, 'stays under a 1000-token output bound');
  const receipt = (await (await fetch(`${base}/generation?id=${id}`)).json()).data;
  assert.equal(receipt.total_cost, reply.usage.cost);
  assert.equal(receipt.native_tokens_completion, 8);
});

test('the positioning gate path answers low risk, other paths and bad input are refused', async t => {
  const base = await start(t, { decisionsMs: 1 });
  const direct = await (await fetch(base.replace('/api/v1', '/api/alpha/decisions'), { method: 'POST', body: '{}' })).json();
  assert.equal(direct.answers.own_account_social_media_operations.noul, 0.05);
  assert.equal((await post(base, { model: 'm' }, '/models')).status, 404);
  assert.equal((await fetch(`${base}/chat/completions`, { method: 'POST', body: 'not json' })).status, 400);
  assert.equal((await post(base, { stream: true })).status, 400, 'a model is required');
  assert.equal((await fetch(`${base}/anything`)).status, 404);
});
