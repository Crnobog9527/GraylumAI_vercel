/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Offline-only analysis of a terminally stopped batch. This entry point cannot
// reset the budget, send a provider request, or add replacement samples.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { budgetState } from './budget.mjs';
import { root, read, save, assert, hash, git, measure } from './source.mjs';
import { runHost } from './host.mjs';
const path = name => join(root, name);
const fileHash = name => hash(readFileSync(path(name)));
const lines = name => readFileSync(path(name), 'utf8').trim().split('\n').map(JSON.parse);
const manifest = read(path('manifest.json')), organizer = read(path('organizer-manifest.json'));
assert(!existsSync(path('organizer.completed')) && !existsSync(path('sealed-stopped.json')), 'STOPPED_ONLY');
const state = budgetState(lines('budget.jsonl'));
assert(state.stopped && state.pending, 'UNKNOWN_CALL_REQUIRED');
assert(manifest.casesHash === fileHash('cases.json') && manifest.planHash === fileHash('plan.json') &&
  organizer.frozenHash === fileHash('mentor/frozen-private.json') &&
  organizer.mentorResponsesHash === fileHash('mentor-responses.jsonl'), 'STOPPED_SOURCE_CHANGED');
const started = read(path('organizer.started'));
assert(!git('diff', started.executionHead, '--', 'packages/', 'scripts/cdc-b2-eval/',
  'scripts/cdc-writeback-v2/seed.ts', 'scripts/cdc-writeback-v2/host.mjs', 'scripts/cdc-writeback-v2/source.mjs'),
'STOPPED_HOST_CHANGED');
const requests = lines('organizer-requests.jsonl'), responses = lines('organizer-responses.jsonl');
const roster = [1, 2, 3].flatMap(run => organizer.rows.map(row => ({ id: `organizer/${run}/${row.slot}`, run, slot: row.slot })));
assert(requests.length < 300 && responses.length + 1 === requests.length &&
  state.pending.id === requests.at(-1).id, 'STOPPED_ROSTER');
requests.forEach((q, i) => {
  assert(q.id === roster[i].id && q.requestHash === hash(q.raw) &&
    q.requestHash === organizer.rows.find(r => r.slot === q.slot).requestHash, 'STOPPED_REQUEST_CHANGED');
  const r = responses[i];
  if (r) assert(r.id === q.id && r.requestHash === q.requestHash && r.status === 200, 'STOPPED_RESPONSE_CHANGED');
});
const seal = { sealedAt: new Date().toISOString(), expected: 300, attempted: requests.length, received: responses.length,
  unknown: { id: state.pending.id, reservedNano: state.pending.nano }, settledNano: state.settledNano,
  notDispatched: 300 - requests.length, requestsHash: fileHash('organizer-requests.jsonl'),
  responsesHash: fileHash('organizer-responses.jsonl'), budgetHash: fileHash('budget.jsonl') };
save(path('sealed-stopped.json'), seal);
const frozen = read(path('mentor/frozen-private.json')), mentors = lines('mentor-responses.jsonl');
const variants = responses.map(r => {
  const b = JSON.parse(r.body);
  return { slot: r.slot, effort: `run-${r.run}`, summary: b.choices?.[0]?.message?.content ?? '',
    finish: b.choices?.[0]?.finish_reason ?? 'error' };
});
await runHost(read(path('plan.json')), path('replay'), async input => {
  const row = frozen.rows.find(r => r.ordinal === input.ordinal);
  assert(row && (input.role === 'mentor' || row.raw === input.raw), 'STOPPED_REPLAY_INPUT_CHANGED');
  measure(input.raw, input.role);
  if (input.role === 'mentor') return mentors.find(r => r.slot === input.slot).body;
  return JSON.stringify({ id: 'gen-offline-' + randomUUID(), object: 'chat.completion', created: 1,
    model: JSON.parse(input.raw).model,
    choices: [{ index: 0, message: { role: 'assistant', content: '{"inputKind":"answer","patches":[],"notes":[]}' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, cost: 0.001 } });
}, variants);
const results = read(path('replay/reasoning-results.json'));
assert(results.length === responses.length, 'STOPPED_REPLAY_COUNT');
save(path('replay-proof.json'), { count: results.length, externalCalls: 0,
  resultHash: fileHash('replay/reasoning-results.json'), stoppedSealHash: fileHash('sealed-stopped.json') });
console.log(JSON.stringify({ ...seal, replayed: results.length, externalCalls: 0 }));
