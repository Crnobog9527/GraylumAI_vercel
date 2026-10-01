/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {classifyAsk} from './classify.ts';
import {createBudget, HARD_MAX_CALLS, HARD_MAX_USD, memoryLedger, usdToNano, validateCaps} from './budget.ts';
import {resolveConfigs} from './config.ts';
import {sseResponse, syntheticUpstream, textDeltas, toolDeltas} from './dryRun.ts';
import {assertOutsideRepository, KEY_ENV, runProbe} from './main.ts';
import {parseProbeArgs} from './plan.ts';
import {FIXTURE_SKILL_DIR} from './skill.ts';
import {accountHome} from './paths.ts';
import {assertDataCollectionDenied, probeTransport, type Upstream} from './transport.ts';

// Placeholder only; deliberately not shaped like a provider key.
const KEY = 'z'.repeat(40);
let home: string;
let out: string[] = [];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ac0-probe-'));
  out = [];
});
afterEach(() => {
  rmSync(home, {recursive: true, force: true});
  vi.restoreAllMocks();
});

type Sent = {url: string; init: RequestInit; body: Record<string, any>};
function recording(respond: Upstream = syntheticUpstream(['references/gather.md'])) {
  const sent: Sent[] = [];
  const upstream: Upstream = async (url, init) => {
    sent.push({url, init, body: JSON.parse(String(init.body))});
    return respond(url, init);
  };
  return {sent, upstream};
}

const deps = (fetch?: Upstream) => ({home, fetch, stdout: (t: string) => out.push(t), stderr: (t: string) => out.push(t)});
const outDir = () => join(home, 'results');
const base = (...extra: string[]) => ['--out-dir', outDir(), '--configs', 'qwen-deepinfra-none', ...extra];

async function planId(args: string[]): Promise<string> {
  const outcome = await runProbe(args, {}, deps());
  expect(outcome.exitCode).toBe(0);
  return outcome.plan!.planId;
}

function writtenFiles(): string {
  const texts: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, {withFileTypes: true})) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else texts.push(readFileSync(path, 'utf8'));
    }
  };
  walk(home);
  return texts.join('\n');
}

function askResponse(args: unknown, name = 'ask_question'): Upstream {
  return async (_url, init) => {
    const body = JSON.parse(String(init.body));
    return sseResponse(body.model, toolDeltas(name, args, 'call_' + body.messages.length), {finish: 'tool_calls'});
  };
}

describe('dry run', () => {
  it('runs every trial kind through the SDK without any network request', async () => {
    const globalFetch = vi.spyOn(globalThis, 'fetch');
    const network = recording();
    const outcome = await runProbe(base('--ask', '2', '--text', '1', '--reference', '1'), {[KEY_ENV]: KEY}, deps(network.upstream));
    expect(outcome.exitCode).toBe(0);
    expect(network.sent).toHaveLength(0);
    expect(globalFetch).not.toHaveBeenCalled();
    expect(outcome.results!.map(result => result.kind)).toEqual(['ask', 'ask', 'text', 'reference']);
    expect(outcome.results!.filter(result => result.kind === 'ask').map(result => result.outcome?.category)).toEqual(['correct', 'correct']);
    expect(outcome.results!.find(result => result.kind === 'reference')!.referenceReads).toBe(1);
    expect(readdirSync(outcome.runDir!).sort()).toEqual(['plan.json', 'results.jsonl', 'summary.json', 'summary.md']);
    expect(out.join('')).toContain('Dry run: no request leaves this machine');
  });

  it('keeps Skill text out of the summary files', async () => {
    const outcome = await runProbe(base('--ask', '1'), {}, deps());
    const summary = readFileSync(join(outcome.runDir!, 'summary.json'), 'utf8') + readFileSync(join(outcome.runDir!, 'summary.md'), 'utf8');
    expect(summary).not.toContain('Workshop notes');
    expect(summary).not.toContain('community workshop');
  });
});

describe('limits', () => {
  it('refuses caps above the hard total of 841 calls and 25.24 USD', async () => {
    expect(HARD_MAX_CALLS).toBe(841);
    expect(HARD_MAX_USD).toBe(25.24);
    expect(() => validateCaps(HARD_MAX_CALLS + 1, 1)).toThrow('PROBE_CAP_REFUSED');
    expect(() => validateCaps(10, 25.25)).toThrow('PROBE_CAP_REFUSED');
    expect(validateCaps(HARD_MAX_CALLS, 3.5)).toBeUndefined();
    expect(() => parseProbeArgs(['--max-calls', String(HARD_MAX_CALLS + 1)], home)).toThrow('PROBE_CAP_REFUSED');
    expect(() => parseProbeArgs(['--max-usd', '25.25'], home)).toThrow('PROBE_CAP_REFUSED');
    expect(parseProbeArgs([], home)).toMatchObject({maxCalls: 60, maxUsd: 1, live: false});
    const network = recording();
    const outcome = await runProbe(base('--max-calls', '500', '--live'), {[KEY_ENV]: KEY}, deps(network.upstream));
    expect(outcome.exitCode).toBe(2);
    expect(network.sent).toHaveLength(0);
  });

  it('refuses a plan whose worst case exceeds the run call cap', async () => {
    const outcome = await runProbe(base('--ask', '30', '--reference', '20', '--max-calls', '80'), {}, deps());
    expect(outcome.exitCode).toBe(2);
    expect(out.join('')).toContain('PROBE_PLAN_REFUSED');
  });

  it('stops before the call that would pass the run, total call or total spend cap', () => {
    const run = createBudget({maxCalls: 2, maxUsd: 1, ledger: memoryLedger()});
    run.reserve(1)(0);
    run.reserve(1)(0);
    expect(() => run.reserve(1)).toThrow('run_call_cap');
    const usd = createBudget({maxCalls: 10, maxUsd: 0.01, ledger: memoryLedger()});
    usd.reserve(usdToNano(0.006));
    expect(() => usd.reserve(usdToNano(0.006))).toThrow('run_usd_cap');
    const total = createBudget({maxCalls: 10, maxUsd: 1, ledger: memoryLedger({calls: HARD_MAX_CALLS, nanoUsd: 0})});
    expect(() => total.reserve(1)).toThrow('total_call_cap');
    const spent = createBudget({maxCalls: 10, maxUsd: 1, ledger: memoryLedger({calls: 0, nanoUsd: usdToNano(HARD_MAX_USD - 0.000001)})});
    expect(() => spent.reserve(usdToNano(0.01))).toThrow('total_usd_cap');
  });

  it('stops the live run when the next call would exceed --max-usd', async () => {
    const args = base('--ask', '5', '--max-usd', '0.02', '--live');
    const id = await planId(base('--ask', '5', '--max-usd', '0.02'));
    const network = recording(async (_url, init) => sseResponse(JSON.parse(String(init.body)).model,
      toolDeltas('ask_question', {question: 'Q?', options: ['A', 'B']}), {finish: 'tool_calls', usage: {prompt_tokens: 9, cost: 0.004}}));
    const outcome = await runProbe([...args, '--confirm', id], {[KEY_ENV]: KEY}, deps(network.upstream));
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stop).toBe('budget:run_usd_cap');
    // $0.004 settled per call plus a ~$0.005 reservation: the fifth call would pass $0.02.
    expect(network.sent).toHaveLength(4);
    const ledger = JSON.parse(readFileSync(join(home, '.graylum', 'ac0', 'ledger.json'), 'utf8'));
    expect(ledger.calls).toBe(network.sent.length);
  });

  it('refuses a live run once the cumulative ledger is exhausted', async () => {
    mkdirSync(join(home, '.graylum', 'ac0'), {recursive: true});
    writeFileSync(join(home, '.graylum', 'ac0', 'ledger.json'), JSON.stringify({calls: HARD_MAX_CALLS, nanoUsd: 0}));
    const id = await planId(base('--ask', '1'));
    const network = recording();
    const outcome = await runProbe([...base('--ask', '1', '--live'), '--confirm', id], {[KEY_ENV]: KEY},
      deps(network.upstream));
    expect(outcome.exitCode).toBe(2);
    expect(out.join('')).toContain('PROBE_TOTAL_BUDGET_EXHAUSTED');
    expect(network.sent).toHaveLength(0);
  });
});

describe('live confirmation and key', () => {
  it('needs the matching plan id and the key before sending anything', async () => {
    const network = recording();
    expect((await runProbe(base('--ask', '1', '--live'), {[KEY_ENV]: KEY}, deps(network.upstream))).exitCode).toBe(2);
    expect((await runProbe(base('--ask', '1', '--live', '--confirm', 'wrong'), {[KEY_ENV]: KEY}, deps(network.upstream))).exitCode).toBe(2);
    const id = await planId(base('--ask', '1'));
    expect((await runProbe(base('--ask', '1', '--live', '--confirm', id), {}, deps(network.upstream))).exitCode).toBe(2);
    expect(out.join('')).toContain('PROBE_KEY_MISSING');
    expect(network.sent).toHaveLength(0);
  });

  it('sends data_collection deny with fixed routing on every call and never writes the key', async () => {
    const id = await planId(base('--ask', '2', '--reference', '1'));
    const network = recording(async (url, init) => {
      const body = JSON.parse(String(init.body));
      if (body.messages.some((m: {role: string}) => m.role === 'tool')) {
        throw new Error('socket closed while sending with ' + KEY);
      }
      return syntheticUpstream(['references/gather.md'])(url, init);
    });
    const outcome = await runProbe([...base('--ask', '2', '--reference', '1', '--live'), '--confirm', id], {[KEY_ENV]: KEY},
      deps(network.upstream));
    expect(outcome.exitCode).toBe(0);
    expect(network.sent.length).toBe(4);
    for (const call of network.sent) {
      expect(call.url).toBe('https://openrouter.ai/api/v1/chat/completions');
      expect(call.body.provider).toEqual({
        only: ['deepinfra'], allow_fallbacks: false, require_parameters: true, data_collection: 'deny',
        max_price: {prompt: 0.3, completion: 3.75},
      });
      expect(call.body.reasoning_effort).toBe('none');
      expect(call.body.store).toBe(false);
      // Tool requests carry tools but never parallel_tool_calls, which no probed route declares.
      expect(call.body.tools?.length).toBeGreaterThan(0);
      expect('parallel_tool_calls' in call.body).toBe(false);
      expect(new Headers(call.init.headers).get('authorization')).toBe('Bearer ' + KEY);
    }
    const reference = outcome.results!.find(result => result.kind === 'reference')!;
    expect(reference.calls[1]).toMatchObject({status: 'unknown', errorCode: 'network_error'});
    expect(reference.calls[1]!.errorMessage).toContain('[REDACTED]');
    expect(writtenFiles()).not.toContain(KEY);
    expect(out.join('')).not.toContain(KEY);
  });

  it('refuses a body without data_collection deny and configs that try to add routing fields', () => {
    expect(() => assertDataCollectionDenied({provider: {only: ['deepinfra']}})).toThrow('PROBE_DATA_COLLECTION_NOT_DENIED');
    expect(() => assertDataCollectionDenied({provider: {data_collection: 'allow'}})).toThrow('PROBE_DATA_COLLECTION_NOT_DENIED');
    const extra = [{id: 'x', model: 'a/b', route: 'r', effort: 'none', maxPrice: {prompt: 1, completion: 1}, data_collection: 'allow'}];
    expect(() => resolveConfigs(['x'], extra)).toThrow();
  });

  it('refuses results or a ledger inside a git checkout', async () => {
    expect(() => assertOutsideRepository(process.cwd())).toThrow('PROBE_OUTPUT_INSIDE_REPOSITORY');
    const outcome = await runProbe(['--out-dir', join(process.cwd(), 'ac0-results')], {}, deps());
    expect(outcome.exitCode).toBe(2);
  });
});

describe('no retry and unknown results', () => {
  const config = resolveConfigs(['qwen-deepinfra-none'], undefined)[0]!;
  const body = (content: string) => JSON.stringify({
    model: config.model, messages: [{role: 'user', content}], stream: true, stream_options: {include_usage: true},
    store: false, reasoning_effort: 'none', max_tokens: 64,
  });
  const transport = (upstream: Upstream, timeoutMs = 1000) => probeTransport({
    config, maxTokens: 64, timeoutMs, budget: createBudget({maxCalls: 10, maxUsd: 1, ledger: memoryLedger()}),
    upstream, authorization: 'Bearer test', clock: () => performance.now(), trialStart: performance.now(), redact: text => text,
  });
  const post = (t: ReturnType<typeof transport>, content: string) =>
    t.fetch('http://127.0.0.1/ac0/chat/completions', {method: 'POST', body: body(content)});

  it('records a 5xx as unknown at its upper bound and never sends again in that trial', async () => {
    const network = recording(async () => new Response('{"error":{"message":"upstream"}}', {status: 502}));
    const t = transport(network.upstream);
    await expect(post(t, 'one')).rejects.toThrow('PROBE_HTTP_502');
    await expect(post(t, 'two')).rejects.toThrow('PROBE_TRIAL_STOPPED');
    expect(network.sent).toHaveLength(1);
    expect(t.records[0]).toMatchObject({status: 'unknown', costSource: 'upper_bound'});
    expect(t.records[0]!.costUsd).toBe(t.records[0]!.boundUsd);
  });

  it('records a timeout as unknown without resending', async () => {
    const network = recording((_url, init) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    const t = transport(network.upstream, 20);
    await expect(post(t, 'slow')).rejects.toThrow('PROBE_CALL_UNKNOWN');
    expect(t.records[0]).toMatchObject({status: 'unknown', errorCode: 'timeout'});
    expect(network.sent).toHaveLength(1);
  });

  it('charges the full bound when a completed stream reports no usage', async () => {
    const t = transport(async () => sseResponse(config.model, textDeltas('hi'), {usage: {}}));
    await (await post(t, 'no usage')).text();
    expect(t.records[0]).toMatchObject({status: 'ok', costSource: 'upper_bound'});
    expect(t.records[0]!.costUsd).toBe(t.records[0]!.boundUsd);
    const priced = transport(async () => sseResponse(config.model, textDeltas('hi'), {usage: {prompt_tokens: 1000, completion_tokens: 100}}));
    await (await post(priced, 'tokens')).text();
    expect(priced.records[0]).toMatchObject({costSource: 'tokens_at_max_price', costUsd: (1000 * 0.3 + 100 * 3.75) / 1_000_000});
  });

  it('refuses a body that carries parallel_tool_calls before any request', async () => {
    const network = recording(async () => sseResponse(config.model, textDeltas('hi')));
    const t = transport(network.upstream);
    const withFlag = JSON.stringify({...JSON.parse(body('flag')), parallel_tool_calls: false});
    await expect(t.fetch('http://127.0.0.1/ac0/chat/completions', {method: 'POST', body: withFlag}))
      .rejects.toThrow('PROBE_REQUEST_DENIED:parallel_tool_calls');
    expect(network.sent).toHaveLength(0);
  });

  it('denies an identical request body inside one trial', async () => {
    const network = recording(async () => sseResponse(config.model, textDeltas('hi')));
    const t = transport(network.upstream);
    const response = await post(t, 'same');
    await response.text();
    await expect(post(t, 'same')).rejects.toThrow('PROBE_REQUEST_DENIED:duplicate');
    expect(network.sent).toHaveLength(1);
  });

  it('records a data-policy rejection as unbilled, skips the rest of that config and never drops the setting', async () => {
    const network = recording(async () => new Response(JSON.stringify({error: {message: 'No endpoints found matching your data policy'}}),
      {status: 404}));
    const id = await planId(base('--ask', '3'));
    const outcome = await runProbe([...base('--ask', '3', '--live'), '--confirm', id], {[KEY_ENV]: KEY}, deps(network.upstream));
    expect(outcome.exitCode).toBe(0);
    expect(network.sent).toHaveLength(1);
    expect(network.sent[0]!.body.provider.data_collection).toBe('deny');
    expect(outcome.results![0]!.outcome?.category).toBe('provider_rejected');
    expect(outcome.results![0]!.calls[0]).toMatchObject({status: 'rejected', costUsd: 0, costSource: 'not_billed'});
    const summary = JSON.parse(readFileSync(join(outcome.runDir!, 'summary.json'), 'utf8'));
    expect(summary.skipped).toEqual([{configId: 'qwen-deepinfra-none', kind: 'ask', count: 2, reason: 'provider_rejected_http_404'}]);
  });

  it('stops the whole run on an authentication or credit failure', async () => {
    const network = recording(async () => new Response('{"error":{"message":"no credit"}}', {status: 402}));
    const args = ['--out-dir', outDir(), '--configs', 'qwen-deepinfra-none,qwen-alibaba-none', '--ask', '2'];
    const id = await planId(args);
    const outcome = await runProbe([...args, '--live', '--confirm', id], {[KEY_ENV]: KEY}, deps(network.upstream));
    expect(outcome.stop).toBe('provider_rejected_http_402');
    expect(network.sent).toHaveLength(1);
  });
});

describe('ask_question classification', () => {
  it('treats a second provider call after a valid ask_question as a turn that did not end', () => {
    const call = (toolCalls: Array<{id: string; name: string; arguments: string}>) => ({
      sequence: 1, status: 'ok' as const, sentAtMs: 0, requestBytes: 1, dataCollection: 'deny' as const, boundUsd: 0,
      facts: {content: '', reasoningChars: 0, toolCalls, done: true, malformedFrames: 0},
    });
    const valid = [{id: 'c', name: 'ask_question', arguments: '{"question":"Q?","options":["A","B"]}'}];
    expect(classifyAsk([call(valid), call([])], undefined, undefined)).toMatchObject({category: 'turn_not_ended', argsValid: true});
    expect(classifyAsk([call(valid)], 'MaxTurnsExceededError: Max turns (1) exceeded', undefined).category).toBe('turn_not_ended');
    expect(classifyAsk([], undefined, 'budget').category).toBe('not_run');
  });

  it('counts several tool calls in one turn apart from malformed and checks the first call', () => {
    const call = (toolCalls: Array<{id: string; name: string; arguments: string}>) => ({
      sequence: 1, status: 'ok' as const, sentAtMs: 0, requestBytes: 1, dataCollection: 'deny' as const, boundUsd: 0,
      facts: {content: '', reasoningChars: 0, toolCalls, done: true, malformedFrames: 0},
    });
    const valid = {id: 'c', name: 'ask_question', arguments: '{"question":"Q?","options":["A","B"]}'};
    const broken = {id: 'd', name: 'ask_question', arguments: '{"question":"Q?"'};
    expect(classifyAsk([call([valid, valid])], undefined, undefined)).toEqual({
      category: 'multiple_calls', toolCalled: true, argsValid: false, turnEnded: true, textBeforeTool: false,
      toolCallCount: 2, firstCallValidAsk: true,
    });
    expect(classifyAsk([call([broken, valid, valid])], undefined, undefined)).toMatchObject({
      category: 'multiple_calls', toolCallCount: 3, firstCallValidAsk: false, detail: 'invalid_json',
    });
    expect(classifyAsk([call([valid])], undefined, undefined)).toMatchObject({category: 'correct', toolCallCount: 1});
  });

  it('runs a two-call turn through the SDK and records what stopAtToolNames did', async () => {
    const id = await planId(base('--ask', '1'));
    const args = {question: 'Who is it for?', options: ['Friends', 'Clients']};
    const respond: Upstream = async (_url, init) => {
      const body = JSON.parse(String(init.body));
      const second = toolDeltas('ask_question', args, 'call_b').map(delta =>
        ({tool_calls: (delta.tool_calls as Array<Record<string, unknown>>).map(part => ({...part, index: 1}))}));
      return sseResponse(body.model, [...toolDeltas('ask_question', args, 'call_a'), ...second], {finish: 'tool_calls'});
    };
    const network = recording(respond);
    const outcome = await runProbe([...base('--ask', '1', '--live'), '--confirm', id], {[KEY_ENV]: KEY}, deps(network.upstream));
    const result = outcome.results![0]!;
    expect(result.outcome).toMatchObject({category: 'multiple_calls', toolCallCount: 2, firstCallValidAsk: true, turnEnded: true});
    expect(result.calls).toHaveLength(1);
    expect(network.sent).toHaveLength(1);
    // @openai/agents 0.18.0 executes both calls, then stops with one card and no second provider call.
    expect(result.askExecutions).toBe(2);
    expect(JSON.parse(result.finalOutput!)).toMatchObject({card: 'question'});
    const summary = JSON.parse(readFileSync(join(outcome.runDir!, 'summary.json'), 'utf8'));
    expect(summary.configs[0].ask.counts).toMatchObject({multiple_calls: 1, malformed: 0, correct: 0});
    expect(summary.configs[0].ask.multipleCalls).toMatchObject({trials: 1, callsPerTrial: {2: 1}, firstCallValidAsk: 1, turnEnded: 1});
    expect(readFileSync(join(outcome.runDir!, 'summary.md'), 'utf8')).toContain('## Several tool calls in one turn');
  });

  async function classify(respond: Upstream) {
    const id = await planId(base('--ask', '1'));
    const outcome = await runProbe([...base('--ask', '1', '--live'), '--confirm', id], {[KEY_ENV]: KEY}, deps(recording(respond).upstream));
    return outcome.results![0]!;
  }
  const text = (content: string): Upstream => async (_url, init) => sseResponse(JSON.parse(String(init.body)).model, textDeltas(content));

  it('counts one valid call that ends the turn as correct', async () => {
    const result = await classify(askResponse({question: 'Who is it for?', options: ['Friends', 'Clients']}));
    expect(result.outcome).toMatchObject({category: 'correct', toolCalled: true, argsValid: true, turnEnded: true});
    expect(result.calls).toHaveLength(1);
    expect(JSON.parse(result.finalOutput!)).toMatchObject({card: 'question'});
  });

  it('flags malformed arguments without a second provider call', async () => {
    const schema = await classify(askResponse({question: 'Only one option?', options: ['Yes']}));
    expect(schema.outcome).toMatchObject({category: 'malformed', detail: 'schema_mismatch'});
    expect(schema.calls).toHaveLength(1);
    const json: Upstream = async (_url, init) => {
      const body = JSON.parse(String(init.body));
      return sseResponse(body.model, [{tool_calls: [{index: 0, id: 'c1', type: 'function',
        function: {name: 'ask_question', arguments: '{"question": "x", "options": ['}}]}], {finish: 'tool_calls'});
    };
    expect((await classify(json)).outcome).toMatchObject({category: 'malformed', detail: 'invalid_json'});
    expect((await classify(askResponse({path: 'x'}, 'read_reference'))).outcome).toMatchObject({category: 'malformed', detail: 'wrong_tool'});
  });

  it('separates a question asked in text from no question', async () => {
    expect((await classify(text('Who is the workshop for？'))).outcome?.category).toBe('text_question');
    expect((await classify(text('Here is some general advice.'))).outcome?.category).toBe('no_question');
  });
});

describe('isolation and reasoning evidence', () => {
  it('records reasoning returned even when effort is none', async () => {
    const id = await planId(base('--ask', '1'));
    const respond: Upstream = async (_url, init) => sseResponse(JSON.parse(String(init.body)).model,
      [{reasoning: 'thinking...'}, ...toolDeltas('ask_question', {question: 'Q?', options: ['A', 'B']})],
      {finish: 'tool_calls', usage: {prompt_tokens: 9, completion_tokens: 20, completion_tokens_details: {reasoning_tokens: 12}, cost: 0.0001}});
    const outcome = await runProbe([...base('--ask', '1', '--live'), '--confirm', id], {[KEY_ENV]: KEY}, deps(recording(respond).upstream));
    expect(outcome.results![0]).toMatchObject({reasoningSeen: true, reasoningTokens: 12});
    expect(outcome.results![0]!.calls[0]).toMatchObject({costUsd: 0.0001, costSource: 'provider'});
  });

  it('is not imported by application code', () => {
    const roots = [join(__dirname, '..', '..'), join(__dirname, '..', '..', '..', '..', '..', 'apps', 'web', 'src')];
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, {withFileTypes: true})) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'node_modules' && path !== __dirname) walk(path);
        } else if (/\.(ts|tsx|js|mjs)$/.test(entry.name) && readFileSync(path, 'utf8').includes('ac0Probe')) {
          offenders.push(path);
        }
      }
    };
    roots.forEach(walk);
    expect(offenders).toEqual([]);
  });
});

describe('cumulative ledger (review P1-1)', () => {
  const ledgerPath = () => join(home, '.graylum', 'ac0', 'ledger.json');
  beforeEach(() => mkdirSync(join(home, '.graylum', 'ac0'), {recursive: true}));

  it('refuses to start while a lock exists and never removes that lock itself', async () => {
    const id = await planId(base('--ask', '1'));
    writeFileSync(ledgerPath() + '.lock', '{"pid":1}\n', {flag: 'w'});
    const network = recording();
    const outcome = await runProbe([...base('--ask', '1', '--live'), '--confirm', id], {[KEY_ENV]: KEY}, deps(network.upstream));
    expect(outcome.exitCode).toBe(2);
    expect(out.join('')).toContain('PROBE_LEDGER_LOCKED');
    expect(network.sent).toHaveLength(0);
    expect(existsSync(ledgerPath() + '.lock')).toBe(true);
  });

  it('lets only one of two concurrent live runs send, then releases its lock', async () => {
    const id = await planId(base('--ask', '3'));
    const network = recording();
    const run = () => runProbe([...base('--ask', '3', '--live'), '--confirm', id], {[KEY_ENV]: KEY}, deps(network.upstream));
    const outcomes = await Promise.all([run(), run()]);
    expect(outcomes.map(outcome => outcome.exitCode).sort()).toEqual([0, 2]);
    expect(out.join('')).toContain('PROBE_LEDGER_LOCKED');
    expect(network.sent).toHaveLength(3);
    expect(JSON.parse(readFileSync(ledgerPath(), 'utf8')).calls).toBe(3);
    expect(existsSync(ledgerPath() + '.lock')).toBe(false);
  });

  it('creates a missing ledger but refuses a damaged one instead of starting from zero', async () => {
    const id = await planId(base('--ask', '1'));
    const network = recording();
    for (const damaged of ['not json', 'null', '{"calls":-1,"nanoUsd":0}']) {
      writeFileSync(ledgerPath(), damaged);
      const outcome = await runProbe([...base('--ask', '1', '--live'), '--confirm', id], {[KEY_ENV]: KEY}, deps(network.upstream));
      expect(outcome.exitCode).toBe(2);
    }
    expect(out.join('')).toContain('PROBE_LEDGER_INVALID');
    expect(network.sent).toHaveLength(0);
    rmSync(ledgerPath());
    expect((await runProbe([...base('--ask', '1', '--live'), '--confirm', id], {[KEY_ENV]: KEY}, deps(network.upstream))).exitCode).toBe(0);
    expect(JSON.parse(readFileSync(ledgerPath(), 'utf8'))).toMatchObject({calls: 1, external: []});
  });

  it('records external usage without sending and counts it against the total', async () => {
    const network = recording();
    const record = ['--record-external-calls', String(HARD_MAX_CALLS - 1), '--record-external-usd', '0.5', '--external-note', 'browser measurement'];
    expect((await runProbe(record, {[KEY_ENV]: KEY}, deps(network.upstream))).exitCode).toBe(0);
    const ledger = JSON.parse(readFileSync(ledgerPath(), 'utf8'));
    expect(ledger).toMatchObject({calls: HARD_MAX_CALLS - 1, nanoUsd: 500_000_000, external: [{calls: HARD_MAX_CALLS - 1, usd: 0.5, note: 'browser measurement'}]});
    expect((await runProbe([...record, '--live'], {}, deps(network.upstream))).exitCode).toBe(2);
    const id = await planId(base('--ask', '2'));
    const outcome = await runProbe([...base('--ask', '2', '--live'), '--confirm', id], {[KEY_ENV]: KEY}, deps(network.upstream));
    expect(outcome.stop).toBe('budget:total_call_cap');
    expect(network.sent).toHaveLength(1);
    expect(JSON.parse(readFileSync(ledgerPath(), 'utf8'))).toMatchObject({calls: HARD_MAX_CALLS, external: [{calls: HARD_MAX_CALLS - 1}]});
  });
});

describe('cost booking (review P1-2)', () => {
  const config = resolveConfigs(['qwen-deepinfra-none'], undefined)[0]!;
  const run = async (usage: Record<string, unknown>) => {
    const t = probeTransport({
      config, maxTokens: 64, timeoutMs: 1000, budget: createBudget({maxCalls: 10, maxUsd: 1, ledger: memoryLedger()}),
      upstream: async () => sseResponse(config.model, textDeltas('hi'), {usage}), authorization: 'Bearer test',
      clock: () => performance.now(), trialStart: performance.now(), redact: text => text,
    });
    const body = JSON.stringify({model: config.model, messages: [{role: 'user', content: 'x'}], stream: true,
      stream_options: {include_usage: true}, store: false, reasoning_effort: 'none', max_tokens: 64});
    await (await t.fetch('http://127.0.0.1/ac0/chat/completions', {method: 'POST', body})).text();
    return t.records[0]!;
  };

  it('keeps the full bound when a token count is missing and no cost is reported', async () => {
    const record = await run({prompt_tokens: 1000});
    expect(record).toMatchObject({costSource: 'upper_bound', costUsd: record.boundUsd});
  });

  it('books the larger of reported cost and token cost and flags the difference', async () => {
    const tokens = (1000 * 0.3 + 100 * 3.75) / 1_000_000;
    const low = await run({prompt_tokens: 1000, completion_tokens: 100, cost: 0.0001});
    expect(low).toMatchObject({costSource: 'tokens_at_max_price', costUsd: tokens, providerCostUsd: 0.0001, costDisagreement: true});
    const high = await run({prompt_tokens: 1000, completion_tokens: 100, cost: 0.01});
    expect(high).toMatchObject({costSource: 'provider', costUsd: 0.01, costDisagreement: true});
    const reportedOnly = await run({prompt_tokens: 1000, cost: 0.0002});
    expect(reportedOnly).toMatchObject({costSource: 'provider', costUsd: 0.0002});
    expect(reportedOnly.costDisagreement).toBeUndefined();
  });

  it('keeps the full bound for an incomplete stream even when a cost was reported', async () => {
    const t = probeTransport({
      config, maxTokens: 64, timeoutMs: 1000, budget: createBudget({maxCalls: 10, maxUsd: 1, ledger: memoryLedger()}),
      upstream: async () => new Response('data: {"choices":[],"usage":{"cost":0.00001}}\n\n'), authorization: 'Bearer test',
      clock: () => performance.now(), trialStart: performance.now(), redact: text => text,
    });
    const body = JSON.stringify({model: config.model, messages: [{role: 'user', content: 'y'}], stream: true,
      stream_options: {include_usage: true}, store: false, reasoning_effort: 'none', max_tokens: 64});
    await (await t.fetch('http://127.0.0.1/ac0/chat/completions', {method: 'POST', body})).text();
    expect(t.records[0]).toMatchObject({status: 'unknown', errorCode: 'incomplete_stream', costSource: 'upper_bound'});
    expect(t.records[0]!.costUsd).toBe(t.records[0]!.boundUsd);
  });
});

describe('real paths (review P2)', () => {
  const repoDir = join(__dirname, '..');

  it('refuses output, ledger or Skill paths that reach a repository through a symlink', async () => {
    const link = join(home, 'looks-outside');
    symlinkSync(repoDir, link);
    expect(() => assertOutsideRepository(join(link, 'results'))).toThrow('PROBE_OUTPUT_INSIDE_REPOSITORY');
    expect((await runProbe(['--out-dir', join(link, 'results')], {}, deps())).exitCode).toBe(2);
    const id = await planId(base('--ask', '1'));
    const network = recording();
    const ledger = await runProbe([...base('--ask', '1', '--live'), '--confirm', id],
      {[KEY_ENV]: KEY}, {...deps(network.upstream), ledgerPath: join(link, 'ledger.json')});
    expect(ledger.exitCode).toBe(2);
    expect(out.join('')).toContain('PROBE_LEDGER_INSIDE_REPOSITORY');
    expect(network.sent).toHaveLength(0);
    const skill = await runProbe(base('--ask', '1', '--skill-dir', FIXTURE_SKILL_DIR), {}, deps());
    expect(skill.exitCode).toBe(2);
    expect(out.join('')).toContain('PROBE_SKILL_INSIDE_REPOSITORY');
  });
});

describe('private content stays in the local results file', () => {
  const SKILL_MARKER = 'SKILL-PRIVATE-MARKER-7d1f';
  const REFERENCE_MARKER = 'REFERENCE-PRIVATE-MARKER-2b9c';
  const INPUT_MARKER = 'USER-INPUT-MARKER-5e3a';
  const REPLY_MARKER = 'MODEL-REPLY-MARKER-9a4d';
  const PROMPT_TEXT = 'You are the Graylum mentor';

  function privateInputs() {
    const skillDir = join(home, 'skill');
    mkdirSync(join(skillDir, 'references'), {recursive: true});
    writeFileSync(join(skillDir, 'SKILL.md'), `# Private\n${SKILL_MARKER}\nRead [step](references/step.md).\n`);
    writeFileSync(join(skillDir, 'references', 'step.md'), REFERENCE_MARKER + '\n');
    const scenarios = join(home, 'scenarios.json');
    writeFileSync(scenarios, JSON.stringify({scenarios: ['ask', 'text', 'reference'].map(kind =>
      ({id: kind + '-1', kind, input: `${INPUT_MARKER} ${kind}`}))}));
    return ['--skill-dir', skillDir, '--scenarios', scenarios];
  }

  it('prints and summarizes ids and numbers only', async () => {
    const extra = privateInputs();
    const args = base('--ask', '1', '--text', '1', '--reference', '1', ...extra);
    const id = await planId(args);
    const network = recording(async (_url, init) => {
      const body = JSON.parse(String(init.body));
      const names = (body.tools ?? []).map((tool: {function: {name: string}}) => tool.function.name);
      const replied = body.messages.some((message: {role: string}) => message.role === 'tool');
      if (names.includes('read_reference') && !replied) {
        return sseResponse(body.model, toolDeltas('read_reference', {path: 'references/step.md'}, 'call_ref'), {finish: 'tool_calls'});
      }
      return sseResponse(body.model, textDeltas(`${REPLY_MARKER} Which audience?`));
    });
    out = [];
    const outcome = await runProbe([...args, '--live', '--confirm', id], {[KEY_ENV]: KEY}, deps(network.upstream));
    expect(outcome.exitCode).toBe(0);
    const sent = JSON.stringify(network.sent.map(call => call.body));
    expect(sent).toContain(SKILL_MARKER);
    expect(sent).toContain(REFERENCE_MARKER);
    const visible = out.join('') + readFileSync(join(outcome.runDir!, 'summary.md'), 'utf8') +
      readFileSync(join(outcome.runDir!, 'summary.json'), 'utf8') + readFileSync(join(outcome.runDir!, 'plan.json'), 'utf8');
    for (const marker of [SKILL_MARKER, REFERENCE_MARKER, INPUT_MARKER, REPLY_MARKER, PROMPT_TEXT]) {
      expect(visible).not.toContain(marker);
    }
    expect(readFileSync(join(outcome.runDir!, 'results.jsonl'), 'utf8')).toContain(REPLY_MARKER);
  });

  it('reports a malformed private file without quoting it', async () => {
    const extra = privateInputs();
    writeFileSync(extra[3]!, `{"scenarios": [${INPUT_MARKER}]}`);
    expect((await runProbe(base('--ask', '1', ...extra), {}, deps())).exitCode).toBe(2);
    writeFileSync(extra[3]!, JSON.stringify({scenarios: [{id: 'x', kind: 'ask', input: INPUT_MARKER, extra: INPUT_MARKER}]}));
    expect((await runProbe(base('--ask', '1', ...extra), {}, deps())).exitCode).toBe(2);
    const config = join(home, 'configs.json');
    writeFileSync(config, JSON.stringify([{id: INPUT_MARKER.toLowerCase(), model: INPUT_MARKER}]));
    expect((await runProbe([...base('--ask', '1'), '--config-file', config], {}, deps())).exitCode).toBe(2);
    expect(out.join('')).toContain('PROBE_SCENARIOS_INVALID');
    expect(out.join('')).toContain('PROBE_CONFIG_FILE_INVALID');
    expect(out.join('').toLowerCase()).not.toContain(INPUT_MARKER.toLowerCase());
  });
});

describe('second review fixes', () => {
  it('has no command-line ledger override and prints the real ledger path and totals on a live run', async () => {
    const network = recording();
    expect((await runProbe([...base('--ask', '1', '--live'), '--ledger', join(home, 'other.json')], {[KEY_ENV]: KEY},
      deps(network.upstream))).exitCode).toBe(2);
    expect((await runProbe(['--record-external-calls', '1', '--record-external-usd', '0.01', '--ledger', join(home, 'x.json')], {},
      deps())).exitCode).toBe(2);
    expect(existsSync(join(home, 'other.json')) || existsSync(join(home, 'x.json'))).toBe(false);
    expect(parseProbeArgs([], home).ledger).toBe(join(home, '.graylum', 'ac0', 'ledger.json'));
    const id = await planId(base('--ask', '1'));
    out = [];
    await runProbe([...base('--ask', '1', '--live'), '--confirm', id], {[KEY_ENV]: KEY}, deps(network.upstream));
    expect(out.join('')).toContain('Ledger file (real path): ' + join(realpathSync(home), '.graylum', 'ac0', 'ledger.json'));
    expect(out.join('')).toContain('Cumulative ledger before this run: 0 calls');
  });

  it('creates results owner-only and refuses an existing output directory others can read', async () => {
    const id = await planId(base('--ask', '1'));
    const network = recording();
    const outcome = await runProbe([...base('--ask', '1', '--live'), '--confirm', id], {[KEY_ENV]: KEY}, deps(network.upstream));
    const mode = (path: string) => statSync(path).mode & 0o777;
    expect(mode(outcome.runDir!)).toBe(0o700);
    for (const name of ['plan.json', 'results.jsonl', 'summary.json', 'summary.md']) expect(mode(join(outcome.runDir!, name))).toBe(0o600);
    expect(mode(join(home, '.graylum', 'ac0', 'ledger.json'))).toBe(0o600);
    chmodSync(outDir(), 0o755);
    const sentBefore = network.sent.length;
    const refused = await runProbe([...base('--ask', '1', '--live'), '--confirm', id], {[KEY_ENV]: KEY}, deps(network.upstream));
    expect(refused.exitCode).toBe(2);
    expect(out.join('')).toContain('PROBE_OUTPUT_DIR_NOT_PRIVATE');
    expect(network.sent).toHaveLength(sentBefore);
    expect(mode(outDir())).toBe(0o755);
  });

  it('counts a trial whose SDK run failed after a provider response as sdk_error, not as measured', async () => {
    const args = base('--ask', '0', '--reference', '1');
    const id = await planId(args);
    const respond: Upstream = async (_url, init) => sseResponse(JSON.parse(String(init.body)).model,
      [{content: 'Let me check. '}, ...toolDeltas('read_reference', {file: 'wrong argument'}, 'call_bad')], {finish: 'tool_calls'});
    const outcome = await runProbe([...args, '--live', '--confirm', id], {[KEY_ENV]: KEY}, deps(recording(respond).upstream));
    const trial = outcome.results![0]!;
    expect(trial.calls[0]!.status).toBe('ok');
    expect(trial.stop).toBe('sdk_error');
    const summary = JSON.parse(readFileSync(join(outcome.runDir!, 'summary.json'), 'utf8'));
    expect(summary.configs[0].reference).toMatchObject({trials: 1, measured: 0, sdkErrors: 1});
    expect(readFileSync(join(outcome.runDir!, 'summary.md'), 'utf8')).toContain('| qwen-deepinfra-none | reference | 0 / 1 | 1 |');
  });
});

describe('ledger location (third review)', () => {
  it('does not follow HOME', () => {
    const original = process.env.HOME;
    const expected = accountHome();
    try {
      process.env.HOME = join(home, 'elsewhere');
      expect(accountHome()).toBe(expected);
      expect(parseProbeArgs([], accountHome()).ledger).toBe(join(expected, '.graylum', 'ac0', 'ledger.json'));
    } finally {
      process.env.HOME = original;
    }
  });

  it('locates ledger and results only through accountHome()', () => {
    for (const name of readdirSync(__dirname).filter(file => file.endsWith('.ts') && !file.endsWith('.test.ts'))) {
      const source = readFileSync(join(__dirname, name), 'utf8');
      expect(source, name).not.toMatch(/homedir\(|env\.HOME|env\[['"]HOME/);
      if (name !== 'paths.ts') expect(source, name).not.toMatch(/userInfo\(/);
    }
    expect(readFileSync(join(__dirname, 'main.ts'), 'utf8')).toContain('deps.home ?? accountHome()');
  });
});

describe('question-card history and step fields', () => {
  const workflowYaml = [
    'kind: social', 'steps:', '  - title: Basics', '    resources:', '      - references/step-1.md', '    information:',
    '      - {id: offer, title: Offer, required: true}', '      - {id: channel, title: Channel, required: true, elicitation: agent_proposal}',
    '      - {id: notes, title: Notes, required: false}', '',
  ].join('\n');
  const workflowJson = JSON.stringify({kind: 'social', steps: [{title: 'Basics', resources: ['references/step-1.md'], information: [
    {id: 'offer', title: 'Offer', required: true}, {id: 'channel', title: 'Channel', required: true, elicitation: 'agent_proposal'},
    {id: 'notes', title: 'Notes', required: false},
  ]}]});
  function privateSkill(workflow: string | false = workflowYaml) {
    const dir = join(home, 'skill');
    rmSync(dir, {recursive: true, force: true});
    mkdirSync(join(dir, 'references'), {recursive: true});
    writeFileSync(join(dir, 'SKILL.md'), '# Synthetic Skill\nGuide the user one question at a time.\n');
    writeFileSync(join(dir, 'references', 'step-1.md'), 'Synthetic reference.\n');
    if (workflow !== false) writeFileSync(join(dir, 'workflow.yaml'), workflow);
    return dir;
  }
  const card = {question: 'Which channel first?', options: ['Channel A', 'Channel B']};
  function scenarios(list: unknown[]) {
    const path = join(home, 'scenarios.json');
    writeFileSync(path, JSON.stringify({scenarios: list}));
    return path;
  }
  const withHistory = {
    id: 'tool-history', kind: 'ask', step: 0, expectStepComplete: true,
    history: [
      {role: 'user', content: 'I sell handmade cups.'},
      {role: 'assistant', content: 'Nice, cups travel well.', askQuestion: card},
      {role: 'user', content: 'Channel A'},
    ],
    input: 'That is all I can say about it for now.',
  };

  it('replays a question card as a tool call and its result, and gives the model the step fields', async () => {
    const args = ['--out-dir', outDir(), '--configs', 'qwen-deepinfra-none', '--skill-dir', privateSkill(),
      '--scenarios', scenarios([withHistory]), '--ask', '1'];
    const id = await planId(args);
    const network = recording(askResponse({question: 'Anything else?', options: ['Yes', 'No']}));
    const outcome = await runProbe([...args, '--live', '--confirm', id], {[KEY_ENV]: KEY}, deps(network.upstream));
    expect(outcome.exitCode).toBe(0);
    const messages = network.sent[0]!.body.messages as Array<Record<string, any>>;
    const assistant = messages.find(message => message.role === 'assistant')!;
    expect(assistant.content).toEqual([{type: 'text', text: 'Nice, cups travel well.'}]);
    expect(assistant.tool_calls).toHaveLength(1);
    expect(assistant.tool_calls[0].function).toEqual({name: 'ask_question', arguments: JSON.stringify(card)});
    const tool = messages[messages.indexOf(assistant) + 1]!;
    expect(tool).toMatchObject({role: 'tool', tool_call_id: assistant.tool_calls[0].id});
    expect(JSON.parse(tool.content)).toEqual({card: 'question', ...card});
    expect(messages.slice(-2).map(message => message.role)).toEqual(['user', 'user']);
    const system = messages[0]!;
    expect(system.role).toBe('system');
    expect(system.content).toContain('Current step: Basics.');
    // Offer declares no role, so it is a user fact; Channel is a proposal the mentor writes.
    expect(system.content).toContain('Facts only the user can provide (ask for them; the user may also defer them): Offer.');
    expect(system.content).toContain('Items you must propose yourself from what is known, for the user to confirm, edit or defer: Channel.');
    expect(system.content).toContain('Never ask the user to write these');
    expect(system.content).not.toContain('Notes');
    expect(outcome.results![0]).toMatchObject({expectStepComplete: true, outcome: {category: 'correct'}});
    // Step fields and history stay in the request; summaries carry none of them.
    const summary = readFileSync(join(outcome.runDir!, 'summary.json'), 'utf8') + readFileSync(join(outcome.runDir!, 'summary.md'), 'utf8');
    for (const text of ['Basics', 'Offer', 'Channel A', 'handmade']) expect(summary).not.toContain(text);
  });

  it('refuses tool history in text scenarios and steps the Skill does not declare', async () => {
    const text = {...withHistory, id: 'text-history', kind: 'text', step: undefined};
    let outcome = await runProbe(['--out-dir', outDir(), '--skill-dir', privateSkill(), '--scenarios', scenarios([text]),
      '--ask', '0', '--text', '1'], {}, deps());
    expect(outcome.exitCode).toBe(2);
    expect(out.join('')).toContain('PROBE_SCENARIO_TOOL_HISTORY_UNSUPPORTED');
    outcome = await runProbe(['--out-dir', outDir(), '--skill-dir', privateSkill(), '--scenarios',
      scenarios([{...withHistory, step: 3}]), '--ask', '1'], {}, deps());
    expect(outcome.exitCode).toBe(2);
    expect(out.join('')).toContain('PROBE_SCENARIO_STEP_UNAVAILABLE');
    outcome = await runProbe(['--out-dir', outDir(), '--skill-dir', privateSkill(false), '--scenarios',
      scenarios([withHistory]), '--ask', '1'], {}, deps());
    expect(outcome.exitCode).toBe(2);
  });

  it('parses workflow.yaml written as YAML or as JSON, and refuses a broken one without quoting it', async () => {
    const args = ['--out-dir', outDir(), '--configs', 'qwen-deepinfra-none', '--scenarios', scenarios([withHistory]), '--ask', '1'];
    const systemFor = async (workflow: string) => {
      const withSkill = [...args, '--skill-dir', privateSkill(workflow)];
      const id = await planId(withSkill);
      const network = recording(askResponse({question: 'Anything else?', options: ['Yes', 'No']}));
      await runProbe([...withSkill, '--live', '--confirm', id], {[KEY_ENV]: KEY}, deps(network.upstream));
      return network.sent[0]!.body.messages[0].content as string;
    };
    const fromYaml = await systemFor(workflowYaml);
    expect(fromYaml).toContain('for the user to confirm, edit or defer: Channel.');
    expect(await systemFor(workflowJson)).toBe(fromYaml);
    out = [];
    const broken = 'kind: social\nsteps: [secret-private-marker\n';
    const outcome = await runProbe([...args, '--skill-dir', privateSkill(broken)], {}, deps());
    expect(outcome.exitCode).toBe(2);
    expect(out.join('')).toContain('PROBE_SKILL_WORKFLOW_INVALID');
    expect(out.join('')).not.toContain('secret-private-marker');
  });

  it('accepts any step the loaded manifest declares, beyond the first twenty', async () => {
    const steps = Array.from({length: 21}, (_, index) => ({title: 'Step ' + (index + 1), resources: ['references/step-1.md'],
      information: [{id: 'fact', title: 'Fact ' + (index + 1), required: true}]}));
    const skill = privateSkill(JSON.stringify({kind: 'social', steps}));
    const outcome = await runProbe(['--out-dir', outDir(), '--skill-dir', skill, '--scenarios',
      scenarios([{...withHistory, step: 20}]), '--ask', '1'], {}, deps());
    expect(outcome.exitCode).toBe(0);
  });

  it('changes the Skill digest only when workflow.yaml is present', async () => {
    const args = (dir: string) => ['--out-dir', outDir(), '--skill-dir', dir, '--scenarios',
      scenarios([{...withHistory, step: undefined}]), '--ask', '1'];
    const withWorkflow = (await runProbe(args(privateSkill()), {}, deps())).plan!.skillDigest;
    const without = (await runProbe(args(privateSkill(false)), {}, deps())).plan!.skillDigest;
    expect(withWorkflow).not.toBe(without);
  });
});
