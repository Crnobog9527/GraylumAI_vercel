/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// The simulated model for the layer-1 browser tests: OpenRouter-compatible, deterministic, free. Ordinary calls are answered by the
// load-test stub (scripts/loadtest/openrouter-stub.mjs, faster timings); this wrapper adds injected failures and a call journal.
//   POST /__sim/fault  {mode, target?, times?}   arm a failure for the next matching chat call(s):
//     cut        200 stream, two text frames, then the connection drops ~0.5 s in (the generation still has a receipt, like a
//                provider that billed a cut stream; with {receipt:false} the lookup answers 404 instead)
//     timeout    200 stream headers, then nothing until the caller gives up (the adapter's 240 s deadline); the lookup then
//                answers OpenRouter's official 404
//     silent     not even headers until the caller gives up (no generation id reaches the app)
//     malformed  the organizer's JSON (target 'organizer') or the card tool arguments come back broken
//     402        the official 402 refusal (OpenRouter credits), before any generation
//     tool       the call answers with one tool call {name, arguments} and no text (a reply that is only a load_skill, say)
//     slow       the call is answered normally, {delayMs} late (arm it after a tool fault to hold the call that follows the tool)
//   target: 'primary' (default: any call that is not the organizer), 'organizer', 'any'
//   GET  /__sim/calls   what was called, in order: [{model, role, stream, fault}]
//   POST /__sim/reset   clears armed faults and the journal
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

import { createStub, ORGANIZER_MARK } from '../loadtest/openrouter-stub.mjs';

const json = (res, status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * The organizer's checklist patches for the simulated method: when the user really answered (not an opening), every required field
 * of the step the turn was for that is still empty gets a provisional value, so the step can be confirmed. Null: the stub's empty answer.
 */
export function organizerPatches(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const text = String(messages[messages.map(m => m?.role).lastIndexOf('user')]?.content ?? '');
  const at = text.indexOf(ORGANIZER_MARK);
  let input;
  try { input = JSON.parse(text.slice(0, at).trim()); } catch { return null; }
  if (!input?.userInput) return null;
  const step = (input.checklist ?? []).find(item => item.id === input.originalStepId);
  const patches = (step?.fields ?? []).filter(field => field.required && !field.value)
    .map(field => ({ stepId: step.id, fieldId: field.id, value: `模拟回答：${field.title}`, status: 'provisional', nature: 'fact',
      basis: 'user_statement' }));
  return patches.length ? JSON.stringify({ inputKind: 'answer', notes: [], patches }) : null;
}

function roleOf(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const last = messages.map(m => m?.role).lastIndexOf('user');
  return String(messages[last]?.content ?? '').includes(ORGANIZER_MARK) ? 'organizer' : 'primary';
}

export function createSim({ timings = { firstByteMs: 200, intervalMs: 15, chunks: 24, secondChunks: 12, decisionsMs: 50 } } = {}) {
  const stub = createStub(timings);
  const delegate = stub.listeners('request')[0];
  const faults = [], calls = [], receipts = new Map();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://sim.invalid');
    if (url.pathname === '/__sim/fault' && req.method === 'POST') {
      let raw = ''; for await (const part of req) raw += part;
      const fault = JSON.parse(raw || '{}');
      if (!['cut', 'timeout', 'silent', 'malformed', '402', 'tool', 'slow'].includes(fault.mode)) return json(res, 400, { error: 'unknown mode' });
      faults.push({ target: 'primary', times: 1, receipt: true, ...fault });
      return json(res, 200, { armed: faults.length });
    }
    if (url.pathname === '/__sim/calls') return json(res, 200, { calls, armed: faults });
    if (url.pathname === '/__sim/reset' && req.method === 'POST') {
      faults.length = 0; calls.length = 0; server.resets.push(Date.now());
      return json(res, 200, {});
    }
    // Receipts of generations this wrapper produced itself (cut streams); everything else is the stub's.
    if (req.method === 'GET' && url.pathname.endsWith('/generation') && receipts.has(url.searchParams.get('id'))) {
      const data = receipts.get(url.searchParams.get('id'));
      // OpenRouter's own "no such generation" shape: the only 404 the recovery job takes as evidence.
      return data ? json(res, 200, { data }) : json(res, 404, { error: { code: 404, message: 'Generation not found' } });
    }
    if (req.method !== 'POST' || !url.pathname.endsWith('/chat/completions')) return delegate(req, res);
    // Read the body once, then hand the stub a replayed request when no fault applies.
    const chunks = []; for await (const part of req) chunks.push(part);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = {}; try { body = JSON.parse(raw); } catch { /* the stub answers 400 */ }
    const role = roleOf(body);
    const fault = faults.find(f => f.target === 'any' || f.target === role);
    calls.push({ model: body.model ?? null, role, stream: body.stream === true, fault: fault?.mode ?? null, at: new Date().toISOString() });
    if (fault && --fault.times <= 0) faults.splice(faults.indexOf(fault), 1);
    const id = `gen-sim-${randomUUID()}`;
    if (fault?.mode === '402') {
      return json(res, 402, { error: { code: 402, message: 'Insufficient credits (simulated)', metadata: { limit_source: 'openrouter_credits' } } });
    }
    const created = Math.floor(Date.now() / 1000);
    const frame = choices => `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: body.model, choices })}\n\n`;
    // Nothing at all, not even headers, until the caller gives up: no generation id ever reaches the app.
    if (fault?.mode === 'silent') { req.socket.setTimeout(0); return; }
    if (fault?.mode === 'cut' || fault?.mode === 'timeout') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'x-generation-id': id, 'cache-control': 'no-cache' });
      // Headers (with the generation id) and one keep-alive comment, then silence until the caller's own deadline ends it. The
      // provider then has no record of the generation.
      if (fault.mode === 'timeout') { receipts.set(id, null); req.socket.setTimeout(0); res.write(': OPENROUTER PROCESSING\n\n'); return; }
      await sleep(150);
      res.write(frame([{ index: 0, delta: { role: 'assistant', content: '模拟回复的前半' }, finish_reason: null }]));
      await sleep(350);
      res.write(frame([{ index: 0, delta: { content: '，然后连接断了' }, finish_reason: null }]));
      // A receipt as a provider that billed the cut generation would show it, priced inside the call's own bound.
      const price = body.provider?.max_price ?? {};
      const cost = Number(((((raw.length / 8) * (Number(price.prompt) || 0)) + 20 * (Number(price.completion) || 0)) / 1e6 * 0.5).toFixed(8));
      receipts.set(id, fault.receipt ? { id, model: body.model, total_cost: cost, finish_reason: 'stop', native_tokens_prompt: Math.floor(raw.length / 8),
        native_tokens_completion: 20, native_tokens_reasoning: 0, native_tokens_cached: 0 } : null);
      res.socket.destroy();
      return;
    }
    if (fault?.mode === 'malformed') {
      // A complete, billed answer whose structured part is not valid: the organizer's JSON or the card's tool arguments.
      const content = role === 'organizer' ? '{"inputKind":"answer","patches":[' : '模拟回复。';
      const tool = role === 'organizer' ? null
        : { index: 0, id: 'call_sim_bad', type: 'function', function: { name: 'ask_question', arguments: '{"question":' } };
      const usage = { prompt_tokens: Math.floor(raw.length / 8), completion_tokens: 20, total_tokens: Math.floor(raw.length / 8) + 20, cost: 0 };
      if (!body.stream) {
        const message = tool ? { role: 'assistant', content, tool_calls: [{ id: tool.id, type: 'function', function: tool.function }] }
          : { role: 'assistant', content };
        const choices = [{ index: 0, finish_reason: tool ? 'tool_calls' : 'stop', message }];
        return json(res, 200, { id, model: body.model, object: 'chat.completion', choices, usage }, { 'x-generation-id': id });
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'x-generation-id': id });
      res.write(frame([{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }]));
      if (tool) res.write(frame([{ index: 0, delta: { tool_calls: [tool] }, finish_reason: null }]));
      res.write(frame([{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }]));
      res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model: body.model, choices: [], usage })}\n\n`);
      res.end('data: [DONE]\n\n');
      receipts.set(id, { id, model: body.model, total_cost: 0, finish_reason: 'stop', native_tokens_prompt: usage.prompt_tokens,
        native_tokens_completion: 20, native_tokens_reasoning: 0, native_tokens_cached: 0 });
      return;
    }
    if (fault?.mode === 'tool') {
      const tool = { index: 0, id: 'call_sim_tool', type: 'function', function: { name: fault.name, arguments: JSON.stringify(fault.arguments ?? {}) } };
      const usage = { prompt_tokens: Math.floor(raw.length / 8), completion_tokens: 20, total_tokens: Math.floor(raw.length / 8) + 20, cost: 0 };
      receipts.set(id, { id, model: body.model, total_cost: 0, finish_reason: 'tool_calls', native_tokens_prompt: usage.prompt_tokens,
        native_tokens_completion: 20, native_tokens_reasoning: 0, native_tokens_cached: 0 });
      if (!body.stream) {
        const message = { role: 'assistant', content: null, tool_calls: [{ id: tool.id, type: 'function', function: tool.function }] };
        const choices = [{ index: 0, finish_reason: 'tool_calls', message }];
        return json(res, 200, { id, model: body.model, object: 'chat.completion', choices, usage }, { 'x-generation-id': id });
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'x-generation-id': id });
      res.write(frame([{ index: 0, delta: { role: 'assistant', tool_calls: [tool] }, finish_reason: null }]));
      res.write(frame([{ index: 0, delta: {}, finish_reason: 'tool_calls' }]));
      res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model: body.model, choices: [], usage })}\n\n`);
      res.end('data: [DONE]\n\n');
      return;
    }
    if (fault?.mode === 'slow') await sleep(Number(fault.delayMs) || 2000);
    const patched = role === 'organizer' && !fault ? organizerPatches(body) : null;
    if (patched) {
      const prompt = Math.floor(raw.length / 8);
      const usage = { prompt_tokens: prompt, completion_tokens: patched.length, total_tokens: prompt + patched.length, cost: 0 };
      receipts.set(id, { id, model: body.model, total_cost: 0, finish_reason: 'stop', native_tokens_prompt: usage.prompt_tokens,
        native_tokens_completion: usage.completion_tokens, native_tokens_reasoning: 0, native_tokens_cached: 0 });
      if (!body.stream) {
        const choices = [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: patched } }];
        return json(res, 200, { id, model: body.model, object: 'chat.completion', choices, usage }, { 'x-generation-id': id });
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'x-generation-id': id });
      res.write(frame([{ index: 0, delta: { role: 'assistant', content: patched }, finish_reason: null }]));
      res.write(frame([{ index: 0, delta: {}, finish_reason: 'stop' }]));
      res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model: body.model, choices: [], usage })}\n\n`);
      res.end('data: [DONE]\n\n');
      return;
    }
    // No fault: replay the body into the stub.
    const { Readable } = await import('node:stream');
    const replay = Object.assign(Readable.from([Buffer.from(raw)]), { method: req.method, url: req.url, headers: req.headers });
    return delegate(replay, res);
  });
  // When each test started (every test begins with /__sim/reset): run.mjs ties the server's stalls and compiles to the test that was running.
  server.resets = [];
  return server;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.SIM_PORT ?? 0);
  const server = createSim();
  server.listen(port, '127.0.0.1', () => console.log(`SIM_READY http://127.0.0.1:${server.address().port}`));
}
