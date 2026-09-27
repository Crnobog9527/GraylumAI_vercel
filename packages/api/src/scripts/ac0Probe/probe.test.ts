/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {classifyAsk} from './classify.ts';
import {createBudget, HARD_MAX_CALLS, memoryLedger, usdToNano, validateCaps} from './budget.ts';
import {resolveConfigs} from './config.ts';
import {sseResponse, syntheticUpstream, textDeltas, toolDeltas} from './dryRun.ts';
import {assertOutsideRepository, KEY_ENV, runProbe} from './main.ts';
import {parseProbeArgs} from './plan.ts';
import {FIXTURE_SKILL_DIR} from './skill.ts';
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
  it('refuses caps above the hard total of 200 calls and 3 USD', async () => {
    expect(() => validateCaps(HARD_MAX_CALLS + 1, 1)).toThrow('PROBE_CAP_REFUSED');
    expect(() => validateCaps(10, 3.01)).toThrow('PROBE_CAP_REFUSED');
    expect(() => parseProbeArgs(['--max-calls', '201'], home)).toThrow('PROBE_CAP_REFUSED');
    expect(() => parseProbeArgs(['--max-usd', '3.5'], home)).toThrow('PROBE_CAP_REFUSED');
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
    const total = createBudget({maxCalls: 10, maxUsd: 1, ledger: memoryLedger({calls: 200, nanoUsd: 0})});
    expect(() => total.reserve(1)).toThrow('total_call_cap');
    const spent = createBudget({maxCalls: 10, maxUsd: 1, ledger: memoryLedger({calls: 0, nanoUsd: usdToNano(2.999999)})});
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
    const ledgerPath = join(home, 'ledger.json');
    writeFileSync(ledgerPath, JSON.stringify({calls: 200, nanoUsd: 0}));
    const id = await planId(base('--ask', '1'));
    const network = recording();
    const outcome = await runProbe([...base('--ask', '1', '--live', '--ledger', ledgerPath), '--confirm', id], {[KEY_ENV]: KEY},
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
    expect(classifyAsk([call([...valid, ...valid])], undefined, undefined)).toMatchObject({category: 'malformed', detail: 'multiple_tool_calls'});
    expect(classifyAsk([], undefined, 'budget').category).toBe('not_run');
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
    const record = ['--record-external-calls', '199', '--record-external-usd', '0.5', '--external-note', 'browser measurement'];
    expect((await runProbe(record, {[KEY_ENV]: KEY}, deps(network.upstream))).exitCode).toBe(0);
    const ledger = JSON.parse(readFileSync(ledgerPath(), 'utf8'));
    expect(ledger).toMatchObject({calls: 199, nanoUsd: 500_000_000, external: [{calls: 199, usd: 0.5, note: 'browser measurement'}]});
    expect((await runProbe([...record, '--live'], {}, deps(network.upstream))).exitCode).toBe(2);
    const id = await planId(base('--ask', '2'));
    const outcome = await runProbe([...base('--ask', '2', '--live'), '--confirm', id], {[KEY_ENV]: KEY}, deps(network.upstream));
    expect(outcome.stop).toBe('budget:total_call_cap');
    expect(network.sent).toHaveLength(1);
    expect(JSON.parse(readFileSync(ledgerPath(), 'utf8'))).toMatchObject({calls: 200, external: [{calls: 199}]});
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
    const ledger = await runProbe([...base('--ask', '1', '--live', '--ledger', join(link, 'ledger.json')), '--confirm', id],
      {[KEY_ENV]: KEY}, deps(network.upstream));
    expect(ledger.exitCode).toBe(2);
    expect(out.join('')).toContain('PROBE_LEDGER_INSIDE_REPOSITORY');
    expect(network.sent).toHaveLength(0);
    const skill = await runProbe(base('--ask', '1', '--skill-dir', FIXTURE_SKILL_DIR), {}, deps());
    expect(skill.exitCode).toBe(2);
    expect(out.join('')).toContain('PROBE_SKILL_INSIDE_REPOSITORY');
  });
});
