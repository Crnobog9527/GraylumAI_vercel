/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// OpenRouter-compatible model stub for load tests (CORE-PATH-V2 plan 3.2). It answers the three paths the runtime uses and
// nothing else, spends no money, and holds no credential:
//   POST /api/v1/chat/completions   streaming or not; first byte after `firstByteMs`, then one chunk every `intervalMs`.
//                                   A call whose tools include `read_skill_file` and that carries no tool result yet answers with
//                                   that tool call (the coach's first call); the call that follows a tool result is the shorter
//                                   `secondChunks` reply (~4 s); every other call is the full `chunks` reply (~6 s).
//   GET  /api/v1/generation?id=     the receipt of a finished generation (ids start with `gen-load-`).
//   POST /api/alpha/decisions       the positioning gate's answer ("own account social media operations", low).
// Usage figures stay far below the frozen quote (prompt = request bytes / 8, cost = 0.9 x the call's own `provider.max_price`
// bound, or 0 when the request carries none), so metering never flags a stub call.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const REQUEST_LIMIT = 2_000_000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

// Arguments that satisfy a tool's own schema: first enum value, a plausible path for file arguments, minimum for numbers.
export function argumentsFor(tool) {
  const props = tool?.function?.parameters?.properties ?? {};
  const required = tool?.function?.parameters?.required ?? Object.keys(props);
  const out = {};
  for (const key of required) {
    const p = props[key] ?? {};
    if (Array.isArray(p.enum) && p.enum.length) out[key] = p.enum[0];
    else if (p.type === 'string') out[key] = /path|file/i.test(key) ? 'references/01-discovery.md' : 'x';
    else if (p.type === 'integer' || p.type === 'number') out[key] = p.minimum ?? 1;
    else if (p.type === 'boolean') out[key] = false;
  }
  return out;
}

export function createStub({ firstByteMs = 1500, intervalMs = 50, chunks = 90, secondChunks = 50, decisionsMs = 300,
  toolName = 'read_skill_file' } = {}) {
  const generations = new Map();
  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://stub.invalid');
    if (req.method === 'GET' && url.pathname.endsWith('/generation')) {
      const data = generations.get(url.searchParams.get('id'));
      return json(res, data ? 200 : 404, data ? { data } : { error: 'generation not found' });
    }
    if (req.method !== 'POST') { res.writeHead(404).end(); return; }
    let raw = '';
    for await (const part of req) {
      raw += part;
      if (raw.length > REQUEST_LIMIT) { res.writeHead(413).end(); return; }
    }
    let body;
    try { body = JSON.parse(raw || '{}'); } catch { res.writeHead(400).end(); return; }
    if (url.pathname.endsWith('/decisions')) {
      await sleep(decisionsMs);
      return json(res, 200, { answers: { own_account_social_media_operations: { type: 'noul', noul: 0.05 } },
        usage: { input_tokens: 100, output_tokens: 1, cost: 0 } });
    }
    if (!url.pathname.endsWith('/chat/completions')) { res.writeHead(404).end(); return; }
    if (typeof body.model !== 'string') return json(res, 400, { error: 'model required' });
    const id = `gen-load-${randomUUID()}`;
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const tools = Array.isArray(body.tools) ? body.tools : [];
    const hadToolResult = messages.some(message => message?.role === 'tool');
    const skillTool = tools.find(tool => tool?.function?.name === toolName);
    const callTool = Boolean(skillTool) && !hadToolResult;
    const count = hadToolResult ? secondChunks : chunks;
    const toolArguments = callTool ? JSON.stringify(argumentsFor(skillTool)) : '';
    const completionTokens = callTool ? Math.max(1, toolArguments.length) : count * 2; // '测试' = 2 characters per chunk
    const promptTokens = Math.max(1, Math.floor(Buffer.byteLength(raw) / 8));
    const price = body.provider?.max_price ?? {};
    const cost = Number((((promptTokens * (Number(price.prompt) || 0) + completionTokens * (Number(price.completion) || 0)) / 1e6) * 0.9).toFixed(8));
    const model = body.model;
    const receipt = { id, model, total_cost: cost, finish_reason: callTool ? 'tool_calls' : 'stop', native_tokens_prompt: promptTokens,
      native_tokens_completion: completionTokens, native_tokens_reasoning: 0, native_tokens_cached: 0 };
    const usage = { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens,
      completion_tokens_details: { reasoning_tokens: 0 }, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, cost };
    const toolCall = { index: 0, id: `call_${randomUUID().slice(0, 12)}`, type: 'function', function: { name: toolName, arguments: toolArguments } };
    const created = Math.floor(Date.now() / 1000);
    if (!body.stream) {
      await sleep(firstByteMs + (callTool ? 0 : count * intervalMs));
      generations.set(id, receipt);
      const message = callTool ? { role: 'assistant', content: null, tool_calls: [{ id: toolCall.id, type: 'function', function: toolCall.function }] }
        : { role: 'assistant', content: '测试'.repeat(count) };
      res.writeHead(200, { 'content-type': 'application/json', 'x-generation-id': id });
      res.end(JSON.stringify({ id, model, object: 'chat.completion', created, choices: [{ index: 0, finish_reason: receipt.finish_reason, message }], usage }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-generation-id': id, 'cache-control': 'no-cache' });
    const start = Date.now();
    const frame = choices => `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices })}\n\n`;
    await sleep(firstByteMs);
    if (res.destroyed) return;
    res.write(': OPENROUTER PROCESSING\n\n');
    if (callTool) res.write(frame([{ index: 0, delta: { role: 'assistant', content: null, tool_calls: [toolCall] }, finish_reason: null }]));
    else for (let i = 0; i < count && !res.destroyed; i++) {
      res.write(frame([{ index: 0, delta: i === 0 ? { role: 'assistant', content: '测试' } : { content: '测试' }, finish_reason: null }]));
      await sleep(Math.max(0, start + firstByteMs + (i + 1) * intervalMs - Date.now()));
    }
    if (res.destroyed) return;
    generations.set(id, receipt);
    res.write(frame([{ index: 0, delta: {}, finish_reason: receipt.finish_reason }]));
    res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [], usage })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // An explicit bind address is required: exposing this server is an operator decision.
  const host = process.env.LOAD_STUB_HOST;
  const port = Number(process.env.LOAD_STUB_PORT);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Set LOAD_STUB_HOST and LOAD_STUB_PORT explicitly');
  createStub().listen(port, host, () => console.log(`Load stub listening on ${host}:${port}`));
}
