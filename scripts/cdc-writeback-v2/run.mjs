/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { streamObserver } from '../../packages/api/src/scripts/ac0Probe/sse.ts';
import { openBudget } from './budget.mjs';
import { runHost } from './host.mjs';
import { root, assert, hash, read, save, skillFiles, skillPath, checkCases, codeHash, git,
  measure, profiles, request, catalog } from './source.mjs';

const [mode] = process.argv.slice(2);
assert(['prepare', 'verify', 'mentor', 'organizer', 'replay'].includes(mode), 'USAGE_PREPARE_VERIFY_MENTOR_ORGANIZER_REPLAY');
const path = name => join(root, name);
const jsonLines = name => readFileSync(path(name), 'utf8').trim().split('\n').map(JSON.parse);
const record = (name, value) => appendFileSync(path(name), JSON.stringify(value) + '\n', { mode: 0o600 });
const fileHash = name => hash(readFileSync(path(name)));
const synthetic = raw => JSON.stringify({ id: 'gen-v2-' + randomUUID(), model: JSON.parse(raw).model,
  choices: [{ index: 0, message: { role: 'assistant', content: '{"inputKind":"answer","patches":[],"notes":[]}' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, cost: 0.001 } });

if (mode === 'prepare') {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  assert(!existsSync(path('manifest.json')) && !existsSync(path('mentor.started')), 'ALREADY_PREPARED');
  const workflow = read(join(skillPath, 'workflow.yaml')), cases = read(path('cases.json'));
  checkCases(cases, workflow);
  const old = read(join(root, '../cdc-b2-eval/round2-input.json')).moduleSkill;
  const files = skillFiles();
  const plan = { writebackV2: true, moduleSkill: { ...old, ...workflow, files }, groups: cases.map(c => ({
    stepId: c.stepId, questionId: c.questionId, initial: c.initial,
    turns: [{ slot: c.id, category: c.category, input: c.input, organize: true, dryPatches: [] }],
  })) };
  save(path('plan.json'), plan);
  save(path('catalog.json'), await catalog());
  await runHost(plan, path('preflight'));
  const dry = read(path('preflight/frozen-private.json'));
  assert(dry.rows.length === 200 && dry.results.length === 100, 'PREFLIGHT_COUNT');
  dry.rows.forEach(r => measure(r.raw, r.role));
  const manifest = { version: 1, stage: 'baseline', sourceHead: git('rev-parse', 'HEAD'), codeHash: codeHash(),
    casesHash: fileHash('cases.json'), planHash: fileHash('plan.json'), catalogHash: fileHash('catalog.json'),
    preflightHash: fileHash('preflight/frozen-private.json'), skillRevision: '388fa8cc', skillVersion: 7,
    skillHash: hash(JSON.stringify(files)), caseCount: 100, runs: 3, capUsd: 5,
    goldLockedAt: new Date().toISOString() };
  save(path('manifest.json'), manifest);
  console.log(JSON.stringify({ prepared: 100, externalCalls: 0, manifestHash: hash(JSON.stringify(manifest)) }));
} else {
  const manifest = read(path('manifest.json'));
  assert(fileHash('cases.json') === manifest.casesHash && fileHash('plan.json') === manifest.planHash &&
    fileHash('catalog.json') === manifest.catalogHash && fileHash('preflight/frozen-private.json') === manifest.preflightHash &&
    hash(JSON.stringify(skillFiles())) === manifest.skillHash && codeHash() === manifest.codeHash, 'FROZEN_INPUT_CHANGED');
  const plan = read(path('plan.json'));
  if (mode === 'verify') {
    const dry = read(path('preflight/frozen-private.json'));
    await runHost(plan, path('verify'), async input => {
      assert(dry.rows.find(r => r.ordinal === input.ordinal)?.raw === input.raw, 'DRY_REQUEST_NOT_REPRODUCIBLE');
      if (input.role === 'organizer') return synthetic(input.raw);
      const body = { id: 'gen-v2-dry', model: profiles.mentor.model,
        choices: [{ index: 0, delta: { role: 'assistant', content: 'Synthetic dry-run reply, not model evidence.' },
          finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, cost: 0.001 } };
      return 'data: ' + JSON.stringify(body) + '\n\ndata: [DONE]\n\n';
    });
    save(path('verify-proof.json'), { preflightHash: manifest.preflightHash, matchedRequests: 200, externalCalls: 0 });
    console.log(JSON.stringify({ matchedRequests: 200, externalCalls: 0 }));
  } else if (mode === 'replay') {
    const responses = jsonLines('organizer-responses.jsonl');
    assert(responses.length === 300 && new Set(responses.map(r => r.id)).size === 300, 'REPLAY_INCOMPLETE');
    const frozen = read(path('mentor/frozen-private.json'));
    assert(fileHash('mentor/frozen-private.json') === read(path('organizer-manifest.json')).frozenHash, 'REPLAY_SOURCE_CHANGED');
    const mentors = jsonLines('mentor-responses.jsonl');
    const variants = responses.map(r => {
      const b = JSON.parse(r.body);
      return { slot: r.slot, effort: `run-${r.run}`, summary: b.choices?.[0]?.message?.content ?? '',
        finish: b.choices?.[0]?.finish_reason ?? 'error' };
    });
    await runHost(plan, path('replay'), async input => {
      const original = frozen.rows.find(r => r.slot === input.slot && r.role === input.role);
      // Older fixture rows do not expose slot; ordinal preserves the frozen roster.
      const row = original ?? frozen.rows.find(r => r.ordinal === input.ordinal);
      assert(row?.raw === input.raw, 'REPLAY_REQUEST_CHANGED');
      return input.role === 'mentor' ? mentors.find(r => r.slot === input.slot).body : synthetic(input.raw);
    }, variants);
    const rows = read(path('replay/reasoning-results.json'));
    assert(rows.length === 300, 'REPLAY_RESULTS');
    save(path('replay-proof.json'), { count: 300, externalCalls: 0, resultHash: fileHash('replay/reasoning-results.json') });
    console.log(JSON.stringify({ replayed: 300, externalCalls: 0 }));
  } else {
    assert(!git('status', '--porcelain'), 'PAID_REQUIRES_CLEAN_CHECKOUT');
    const proof = read(path('verify-proof.json'));
    assert(proof.preflightHash === manifest.preflightHash && proof.matchedRequests === 200, 'PREPAID_REPLAY_REQUIRED');
    const key = process.env.GRAYLUM_PAYG_TEST_OPENROUTER_KEY;
    assert(key, 'TEST_KEY_MISSING');
    const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };
    // Re-read prices before either paid batch, without changing frozen requests or price caps.
    await catalog();
    const credits = await request('https://openrouter.ai/api/v1/credits', { headers });
    assert(credits.status === 200, 'CREDITS_HTTP');
    const balance = JSON.parse(credits.body).data;
    assert(balance.total_credits - balance.total_usage > 0, 'TEST_BALANCE_EMPTY');
    assert(!existsSync(path(`${mode}.started`)), 'NO_RETRY');
    const budget = openBudget();
    save(path(`${mode}.started`), { executionHead: git('rev-parse', 'HEAD'), manifestHash: hash(JSON.stringify(manifest)), at: new Date().toISOString() });
    async function send(raw, role, slot, run = 0) {
      const id = `${role}/${run}/${slot}`, bound = measure(raw, role);
      budget.reserve({ id, stage: 'baseline', requestHash: bound.requestHash, nano: bound.reserveNano });
      record(`${role}-requests.jsonl`, { id, slot, run, role, raw, ...bound });
      const startedAt = new Date().toISOString(), start = performance.now();
      const result = await request('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', headers, body: raw });
      const elapsedMs = performance.now() - start;
      record(`${role}-responses.jsonl`, { id, slot, run, ...bound, ...result, startedAt, elapsedMs });
      assert(result.status === 200, 'PROVIDER_HTTP_STOP');
      let cost, provider, finish;
      if (role === 'mentor') {
        const observer = streamObserver(() => 0);
        observer.push(Buffer.from(result.body));
        const facts = observer.end();
        assert(facts.done && !facts.streamError && !facts.malformedFrames, 'STREAM_INCOMPLETE');
        cost = facts.usage?.costUsd; provider = facts.provider; finish = facts.finishReason;
      } else {
        const body = JSON.parse(result.body);
        cost = body.usage?.cost; provider = body.provider; finish = body.choices?.[0]?.finish_reason;
      }
      budget.settle(id, cost);
      assert(provider === profiles[role].provider, 'PROVIDER_ROUTE_STOP');
      assert((role === 'mentor' ? ['stop', 'tool_calls'] : ['stop', 'length']).includes(finish), 'FINISH_STOP');
      console.log(JSON.stringify({ role, slot, run, cost, elapsedMs: Math.round(elapsedMs), ...budget.snapshot() }));
      return result.body;
    }
    try {
      if (mode === 'mentor') {
        const dry = read(path('preflight/frozen-private.json'));
        await runHost(plan, path('mentor'), async input => {
          if (input.role === 'organizer') return synthetic(input.raw);
          assert(dry.rows.find(r => r.ordinal === input.ordinal)?.raw === input.raw, 'MENTOR_REQUEST_CHANGED');
          return send(input.raw, 'mentor', input.slot);
        });
        const frozen = read(path('mentor/frozen-private.json'));
        const rows = frozen.rows.filter(r => r.role === 'organizer');
        assert(rows.length === 100, 'FROZEN_ORGANIZERS');
        save(path('organizer-manifest.json'), { frozenHash: fileHash('mentor/frozen-private.json'),
          mentorResponsesHash: fileHash('mentor-responses.jsonl'),
          rows: rows.map((r, i) => ({ slot: plan.groups[i].turns[0].slot, ...measure(r.raw, 'organizer') })) });
      } else {
        const frozen = read(path('mentor/frozen-private.json')), organizer = read(path('organizer-manifest.json'));
        assert(fileHash('mentor/frozen-private.json') === organizer.frozenHash &&
          fileHash('mentor-responses.jsonl') === organizer.mentorResponsesHash, 'MENTOR_FREEZE_CHANGED');
        const rows = frozen.rows.filter(r => r.role === 'organizer');
        for (let run = 1; run <= 3; run++) for (const [i, row] of rows.entries()) {
          assert(hash(row.raw) === organizer.rows[i].requestHash, 'ORGANIZER_REQUEST_CHANGED');
          await send(row.raw, 'organizer', organizer.rows[i].slot, run);
        }
      }
      save(path(`${mode}.completed`), budget.snapshot());
    } catch (error) {
      budget.stop(error.message);
      throw error;
    } finally { budget.close(); }
  }
}
