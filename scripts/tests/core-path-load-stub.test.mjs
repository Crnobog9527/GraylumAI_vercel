import test from 'node:test';
import assert from 'node:assert/strict';
import { createStub } from '../loadtest/openrouter-stub.mjs';

test('streams a matching generation and exposes the completed receipt', async t => {
  const server = createStub({ firstByteMs: 20, intervalMs: 5, chunks: 3 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const response = await fetch(`${base}/chat/completions`, {
    method: 'POST', body: JSON.stringify({ model: 'test/model', stream: true }),
  });
  const id = response.headers.get('x-generation-id');
  assert.match(id, /^gen-load-/);
  const body = await response.text();
  assert.equal((body.match(/"content":"测试"/g) ?? []).length, 3);
  assert.match(body, /data: \[DONE\]/);
  const receipt = await (await fetch(`${base}/generation?id=${id}`)).json();
  assert.equal(receipt.data.id, id);
  assert.equal(receipt.data.model, 'test/model');
  assert.equal(receipt.data.total_cost, 0);
  assert.equal((await fetch(`${base}/generation?id=unknown`)).status, 404);
});
