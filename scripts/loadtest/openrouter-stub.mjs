import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

// An explicit bind address is required: exposing this server is an operator decision.
export function createStub({ firstByteMs = 1500, intervalMs = 50, chunks = 91 } = {}) {
  const generations = new Map();
  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://stub.invalid');
    if (req.method === 'GET' && url.pathname.endsWith('/generation')) {
      const data = generations.get(url.searchParams.get('id'));
      res.writeHead(data ? 200 : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data ? { data } : { error: 'generation not found' }));
      return;
    }
    if (req.method !== 'POST' || !url.pathname.endsWith('/chat/completions')) {
      res.writeHead(404).end();
      return;
    }
    let raw = '';
    for await (const part of req) {
      raw += part;
      if (raw.length > 2_000_000) {
        res.writeHead(413).end();
        return;
      }
    }
    let body;
    try { body = JSON.parse(raw); } catch { res.writeHead(400).end(); return; }
    if (typeof body.model !== 'string' || !body.stream) {
      res.writeHead(400).end(JSON.stringify({ error: 'stream and model required' }));
      return;
    }
    const id = `gen-load-${randomUUID()}`;
    const data = { id, model: body.model, finish_reason: 'stop', total_cost: 0,
      native_tokens_prompt: 100, native_tokens_completion: chunks };
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-generation-id': id,
      'cache-control': 'no-cache' });
    const start = Date.now();
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    await sleep(firstByteMs);
    for (let i = 0; i < chunks && !res.destroyed; i++) {
      const chunk = { id, object: 'chat.completion.chunk', model: body.model,
        choices: [{ index: 0, delta: { content: '测试' }, finish_reason: null }] };
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      await sleep(Math.max(0, start + firstByteMs + (i + 1) * intervalMs - Date.now()));
    }
    if (res.destroyed) return;
    generations.set(id, data);
    const final = { id, object: 'chat.completion.chunk', model: body.model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: chunks, total_tokens: 100 + chunks, cost: 0 } };
    res.end(`data: ${JSON.stringify(final)}\n\ndata: [DONE]\n\n`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const host = process.env.LOAD_STUB_HOST;
  const port = Number(process.env.LOAD_STUB_PORT);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Set LOAD_STUB_HOST and LOAD_STUB_PORT explicitly');
  }
  createStub().listen(port, host, () => console.log(`Load stub listening on ${host}:${port}`));
}
