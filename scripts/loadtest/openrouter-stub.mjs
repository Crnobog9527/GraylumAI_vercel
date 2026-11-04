/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// OpenRouter-compatible model stub for load tests (CORE-PATH-V2 plan 3.2). It answers the three paths the runtime uses and
// nothing else, spends no money, and holds no credential:
//   POST /api/v1/chat/completions   streaming or not; first byte after `firstByteMs`, then one chunk every `intervalMs`.
//                                   A call whose tools include `read_skill_file` and that carries no tool result yet answers with
//                                   that tool call (the coach's first call); the call that follows a tool result is the shorter
//                                   `secondChunks` reply (~4 s); every other call is the full `chunks` reply (~6 s).
//                                   The mentor's organizer call (its input carries "Primary assistant reply:") answers a valid empty
//                                   organization object, so the turn's close applies it instead of recording invalid_output.
//   GET  /api/v1/generation?id=     the receipt of a generation (ids start with `gen-load-`). The receipt travels inside the id, so the
//                                   lookup needs no memory: it works on serverless copies of this stub (stub-vercel/) where the call
//                                   and its lookup can land on different instances. Unlike a real provider it answers for a cut stream
//                                   too, with the full reply's figures.
//   POST /api/alpha/decisions       the positioning gate's answer ("own account social media operations", low).
// Usage figures stay far below the frozen quote (prompt = request bytes / 8, cost = 0.9 x the call's own `provider.max_price`
// bound, or 0 when the request carries none), so metering never flags a stub call.
// A caller that drops its request mid-way (the turn's own timeout, a tunnel that cancels) only ends that request: an error inside a
// request is answered or the socket closed, never left as an unhandled rejection that stops the whole process (11-04 V2-13 stage 1).
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const REQUEST_LIMIT = 2_000_000;
export const ORGANIZER_MARK = 'Primary assistant reply:'; // organizerInput() in packages/api/src/services/turn/mentorPrompt.ts
export const ORGANIZER_REPLY = JSON.stringify({ inputKind: 'answer', patches: [], notes: [] });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const ID_PREFIX = 'gen-load-';
const ID_LIMIT = 256; // the runtime refuses longer provider ids (openRouterAdapter.ts, BILL2_PROVIDER_ID_INVALID)

/** A generation id that carries its own receipt: gen-load-<random>.<base64url [model, cost, finish, prompt, completion]>. */
export function generationId(receipt) {
  const packed = Buffer.from(JSON.stringify([receipt.model, receipt.total_cost, receipt.finish_reason,
    receipt.native_tokens_prompt, receipt.native_tokens_completion])).toString('base64url');
  const id = `${ID_PREFIX}${randomBytes(6).toString('hex')}.${packed}`;
  if (id.length > ID_LIMIT) throw new Error('generation id too long');
  return id;
}

/** The receipt an id carries, or null for anything this stub did not issue. */
export function receiptOf(id) {
  if (typeof id !== 'string' || !id.startsWith(ID_PREFIX) || id.length > ID_LIMIT) return null;
  const dot = id.indexOf('.');
  if (dot < 0) return null;
  try {
    const [model, cost, finish, prompt, completion] = JSON.parse(Buffer.from(id.slice(dot + 1), 'base64url').toString('utf8'));
    if (typeof model !== 'string' || ![cost, prompt, completion].every(Number.isFinite)) return null;
    return { id, model, total_cost: cost, finish_reason: finish, native_tokens_prompt: prompt, native_tokens_completion: completion,
      native_tokens_reasoning: 0, native_tokens_cached: 0 };
  } catch { return null; }
}

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

// `prefix` (LOAD_STUB_PREFIX): a secret path segment in front of everything, so a stub reachable from the internet answers only the
// deployment that was told the full base URL. GET /healthz answers 200; GET /<prefix>/__stats answers the call count and the peak concurrency.
export function createStub(options = {}) {
  return createServer(createStubHandler(options));
}

/** The request handler on its own (a Node `(req, res)` function), for a plain server or a serverless function. */
export function createStubHandler({ firstByteMs = 1500, intervalMs = 50, chunks = 90, secondChunks = 50, decisionsMs = 300,
  toolName = 'read_skill_file', prefix = '' } = {}) {
  const stats = { calls: 0, active: 0, peak: 0 };
  const handle = async (req, res) => {
    const url = new URL(req.url, 'http://stub.invalid');
    if (req.method === 'GET' && url.pathname === '/healthz') { res.writeHead(200).end('ok'); return; }
    if (prefix) {
      if (!url.pathname.startsWith(`/${prefix}/`)) { res.writeHead(404).end(); return; }
      url.pathname = url.pathname.slice(prefix.length + 1);
    }
    // Behind the prefix: on serverless copies the counts are per instance, and they are nobody else's business.
    if (req.method === 'GET' && url.pathname === '/__stats') return json(res, 200, stats);
    if (req.method === 'POST') { stats.calls++; stats.active++; stats.peak = Math.max(stats.peak, stats.active); res.on('close', () => { stats.active--; }); }
    if (req.method === 'GET' && url.pathname.endsWith('/generation')) {
      const data = receiptOf(url.searchParams.get('id'));
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
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const tools = Array.isArray(body.tools) ? body.tools : [];
    // Only a tool result that comes after the newest user message makes this the follow-up call: a session that keeps its earlier
    // turns' tool results in its history still starts every new turn with the tool call.
    const lastUser = messages.map(message => message?.role).lastIndexOf('user');
    const hadToolResult = messages.slice(lastUser + 1).some(message => message?.role === 'tool');
    const skillTool = tools.find(tool => tool?.function?.name === toolName);
    const callTool = Boolean(skillTool) && !hadToolResult;
    const lastText = String(messages[lastUser]?.content ?? '');
    const organizer = !skillTool && lastText.includes(ORGANIZER_MARK);
    const pieces = organizer ? ORGANIZER_REPLY.match(/.{1,6}/g) : null;
    const count = organizer ? pieces.length : hadToolResult ? secondChunks : chunks;
    const toolArguments = callTool ? JSON.stringify(argumentsFor(skillTool)) : '';
    // '测试' = 2 characters per chunk
    const completionTokens = callTool ? Math.max(1, toolArguments.length) : organizer ? ORGANIZER_REPLY.length : count * 2;
    const promptTokens = Math.max(1, Math.floor(Buffer.byteLength(raw) / 8));
    const price = body.provider?.max_price ?? {};
    const cost = Number((((promptTokens * (Number(price.prompt) || 0) + completionTokens * (Number(price.completion) || 0)) / 1e6) * 0.9).toFixed(8));
    const model = body.model;
    const finishReason = callTool ? 'tool_calls' : 'stop';
    const id = generationId({ model, total_cost: cost, finish_reason: finishReason, native_tokens_prompt: promptTokens,
      native_tokens_completion: completionTokens });
    const usage = { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens,
      completion_tokens_details: { reasoning_tokens: 0 }, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, cost };
    const toolCall = { index: 0, id: `call_${randomUUID().slice(0, 12)}`, type: 'function', function: { name: toolName, arguments: toolArguments } };
    const created = Math.floor(Date.now() / 1000);
    if (!body.stream) {
      await sleep(firstByteMs + (callTool ? 0 : count * intervalMs));
      const message = callTool ? { role: 'assistant', content: null, tool_calls: [{ id: toolCall.id, type: 'function', function: toolCall.function }] }
        : { role: 'assistant', content: organizer ? ORGANIZER_REPLY : '测试'.repeat(count) };
      res.writeHead(200, { 'content-type': 'application/json', 'x-generation-id': id });
      res.end(JSON.stringify({ id, model, object: 'chat.completion', created, choices: [{ index: 0, finish_reason: finishReason, message }], usage }));
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
      const content = pieces?.[i] ?? '测试';
      res.write(frame([{ index: 0, delta: i === 0 ? { role: 'assistant', content } : { content }, finish_reason: null }]));
      await sleep(Math.max(0, start + firstByteMs + (i + 1) * intervalMs - Date.now()));
    }
    if (res.destroyed) return;
    res.write(frame([{ index: 0, delta: {}, finish_reason: finishReason }]));
    res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [], usage })}\n\n`);
    res.end('data: [DONE]\n\n');
  };
  return (req, res) => {
    // A write to a socket the caller already closed reports here instead of throwing at the process.
    res.on('error', () => {});
    handle(req, res).catch(() => {
      if (!res.headersSent) { res.writeHead(500).end(); return; }
      res.destroy();
    });
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // An explicit bind address is required: exposing this server is an operator decision.
  const host = process.env.LOAD_STUB_HOST;
  const port = Number(process.env.LOAD_STUB_PORT);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Set LOAD_STUB_HOST and LOAD_STUB_PORT explicitly');
  createStub({ prefix: process.env.LOAD_STUB_PREFIX ?? '' }).listen(port, host, () => console.log(`Load stub listening on ${host}:${port}`));
}
