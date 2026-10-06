/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Bounded, explicitly authorized new baseline runs. Never resumes the interrupted run.
import { appendFileSync, existsSync, mkdirSync, readFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { budgetState, openBudget } from './budget.mjs';
import { root, read, save, hash, assert, git, codeHash, measure, profiles, request, catalog } from './source.mjs';
import { runHost } from './host.mjs';
const [mode] = process.argv.slice(2);
assert(['prepare', 'run', 'replay'].includes(mode), 'CONTINUATION_MODE');
const directory = join(root, 'continuation-20261007');
const path = name => join(directory, name), old = name => join(root, name);
const digest = file => hash(readFileSync(file));
const lines = file => readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
const previousHash = '49856df1d6d92d571c7764fa12f0778333e1706b68c447f7f2c2bda70557fe26';
assert(digest(old('budget.jsonl')) === previousHash, 'PREVIOUS_LEDGER_CHANGED');
const previous = budgetState(lines(old('budget.jsonl')));
assert(previous.stopped && previous.pending?.id === 'organizer/2/C043' &&
  previous.settledNano === 1236088710 && previous.pending.nano === 6337000, 'PREVIOUS_EXPOSURE');
const carry = { settledNano: previous.settledNano, heldNano: previous.pending.nano, sourceHash: previousHash };
if (mode === 'prepare') {
  assert(!git('status', '--porcelain'), 'PREPARE_CLEAN_CHECKOUT');
  mkdirSync(directory, { mode: 0o700 });
  mkdirSync(path('mentor'), { mode: 0o700 });
  for (const name of ['cases.json', 'manifest.json', 'plan.json', 'organizer-manifest.json',
    'mentor/frozen-private.json', 'mentor-responses.jsonl']) copyFileSync(old(name), path(name));
  const names = ['cases.json', 'manifest.json', 'plan.json', 'organizer-manifest.json', 'mentor/frozen-private.json',
    'mentor-responses.jsonl', 'report.json', 'blind/lock.json', 'blind/scores.json'];
  save(path('authorization.json'), { authorization:
    'https://github.com/Crnobog9527/GraylumAI_vercel/pull/696#issuecomment-6020013597',
    runs: [2, 3], count: 200, carry, sourceHead: git('rev-parse', 'HEAD'), codeHash: codeHash(),
    sourceHashes: Object.fromEntries(names.map(name => [name, digest(old(name))])), createdAt: new Date().toISOString() });
  console.log(JSON.stringify({ prepared: 200, carry, authorizationHash: digest(path('authorization.json')), externalCalls: 0 }));
} else {
  const authorization = read(path('authorization.json'));
  for (const [name, expected] of Object.entries(authorization.sourceHashes)) assert(digest(old(name)) === expected, 'SOURCE_CHANGED');
  for (const name of ['cases.json', 'manifest.json', 'plan.json', 'organizer-manifest.json',
    'mentor/frozen-private.json', 'mentor-responses.jsonl']) assert(digest(path(name)) === authorization.sourceHashes[name], 'COPY_CHANGED');
  const frozen = read(path('mentor/frozen-private.json')), organizer = read(path('organizer-manifest.json'));
  const requests = frozen.rows.filter(r => r.role === 'organizer');
  assert(requests.length === 100 && organizer.frozenHash === digest(path('mentor/frozen-private.json')), 'INPUT_FREEZE');
  requests.forEach((r, i) => assert(measure(r.raw, 'organizer').requestHash === organizer.rows[i].requestHash, 'REQUEST_CHANGED'));
  if (mode === 'run') {
    assert(!git('status', '--porcelain') && codeHash() === authorization.codeHash, 'PAID_CODE_CHANGED');
    assert(!existsSync(path('started.json')), 'CONTINUATION_NO_RETRY');
    const key = process.env.GRAYLUM_PAYG_TEST_OPENROUTER_KEY;
    assert(key, 'TEST_KEY_MISSING');
    const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };
    await catalog();
    const credits = await request('https://openrouter.ai/api/v1/credits', { headers });
    assert(credits.status === 200, 'CREDITS_HTTP');
    const balance = JSON.parse(credits.body).data;
    assert(balance.total_credits - balance.total_usage > 0, 'TEST_BALANCE_EMPTY');
    const budget = openBudget(directory, carry);
    const record = (name, value) => appendFileSync(path(name), JSON.stringify(value) + '\n', { mode: 0o600 });
    try {
      save(path('started.json'), { at: new Date().toISOString(), executionHead: git('rev-parse', 'HEAD'),
        authorizationHash: digest(path('authorization.json')) });
      for (const run of [2, 3]) for (const [i, row] of requests.entries()) {
        const slot = organizer.rows[i].slot, id = `continuation/${run}/${slot}`, bound = measure(row.raw, 'organizer');
        budget.reserve({ id, stage: 'baseline', requestHash: bound.requestHash, nano: bound.reserveNano });
        record('organizer-requests.jsonl', { id, slot, run, ...bound, raw: row.raw });
        const startedAt = new Date().toISOString(), start = performance.now();
        const response = await request('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', headers, body: row.raw });
        const elapsedMs = performance.now() - start;
        record('organizer-responses.jsonl', { id, slot, run, ...bound, ...response, elapsedMs, startedAt });
        assert(response.status === 200, 'HTTP_STOP');
        const body = JSON.parse(response.body);
        budget.settle(id, body.usage?.cost);
        assert(body.provider === profiles.organizer.provider && ['stop', 'length'].includes(body.choices?.[0]?.finish_reason), 'ROUTE_FINISH_STOP');
        console.log(JSON.stringify({ run, slot, elapsedMs: Math.round(elapsedMs), cost: body.usage.cost, ...budget.snapshot() }));
      }
      save(path('completed.json'), { count: 200, responsesHash: digest(path('organizer-responses.jsonl')),
        budgetHash: digest(path('budget.jsonl')), ...budget.snapshot() });
    } catch (error) {
      budget.stop('CONTINUATION_FAILED');
      console.error('CONTINUATION_FAILED', error.message);
      process.exitCode = 1;
    } finally { budget.close(); }
  } else {
    const completed = read(path('completed.json'));
    assert(completed.responsesHash === digest(path('organizer-responses.jsonl')), 'RESPONSES_CHANGED');
    assert(!git('diff', authorization.sourceHead, '--', 'packages/', 'scripts/cdc-b2-eval/',
      'scripts/cdc-writeback-v2/host.mjs', 'scripts/cdc-writeback-v2/seed.ts'), 'HOST_CHANGED');
    const responses = lines(path('organizer-responses.jsonl'));
    assert(responses.length === 200 && new Set(responses.map(r => r.id)).size === 200, 'REPLAY_COUNT');
    const variants = responses.map(r => ({ slot: r.slot, effort: `run-${r.run}`,
      summary: JSON.parse(r.body).choices?.[0]?.message?.content ?? '', finish: JSON.parse(r.body).choices?.[0]?.finish_reason }));
    const mentors = lines(path('mentor-responses.jsonl'));
    await runHost(read(path('plan.json')), path('replay'), async input => {
      const original = frozen.rows.find(r => r.ordinal === input.ordinal);
      assert(original && (input.role === 'mentor' || original.raw === input.raw), 'REPLAY_INPUT_CHANGED');
      if (input.role === 'mentor') return mentors.find(r => r.slot === input.slot).body;
      return JSON.stringify({ id: 'gen-offline-' + randomUUID(), object: 'chat.completion', created: 1, model: profiles.organizer.model,
        choices: [{ index: 0, message: { role: 'assistant', content: '{"inputKind":"answer","patches":[],"notes":[]}' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, cost: 0.001 } });
    }, variants);
    assert(read(path('replay/reasoning-results.json')).length === 200, 'REPLAY_RESULT_COUNT');
    save(path('replay-proof.json'), { count: 200, externalCalls: 0, resultHash: digest(path('replay/reasoning-results.json')) });
    console.log(JSON.stringify({ replayed: 200, externalCalls: 0 }));
  }
}
