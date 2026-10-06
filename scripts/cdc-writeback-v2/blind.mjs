/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { randomInt, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, read, save, assert, hash } from './source.mjs';
import { objectiveChecks, aggregate, runStatistics } from './score.mjs';
const [mode, batch] = process.argv.slice(2);
assert(['pack', 'report'].includes(mode), 'BLIND_USAGE');
assert(batch === undefined || batch === 'continuation', 'BLIND_BATCH');
const path = name => join(root, ...(batch ? ['continuation-20261007'] : []), name);
const fileHash = name => hash(readFileSync(path(name)));
const manifest = read(path('manifest.json'));
assert(manifest.casesHash === fileHash('cases.json'), 'GOLD_CHANGED');
assert(read(path('replay-proof.json')).resultHash === fileHash('replay/reasoning-results.json'), 'REPLAY_CHANGED');
const stopped = existsSync(path('sealed-stopped.json')) ? read(path('sealed-stopped.json')) : null;
if (stopped) assert(read(path('replay-proof.json')).stoppedSealHash === fileHash('sealed-stopped.json') &&
  stopped.responsesHash === fileHash('organizer-responses.jsonl') && stopped.budgetHash === fileHash('budget.jsonl'), 'STOPPED_SEAL_CHANGED');
if (batch) {
  const auth = read(path('authorization.json'));
  for (const name of ['report.json', 'blind/lock.json', 'blind/scores.json'])
    assert(hash(readFileSync(join(root, name))) === auth.sourceHashes[name], 'PREVIOUS_SCORES_CHANGED');
  assert(read(path('completed.json')).responsesHash === fileHash('organizer-responses.jsonl'), 'COMPLETED_CHANGED');
}
const expectedCount = batch ? 200 : stopped?.received ?? 300;
const cases = read(path('cases.json')), replay = read(path('replay/reasoning-results.json'));
const frozen = read(path('mentor/frozen-private.json'));
assert(read(path('organizer-manifest.json')).frozenHash === fileHash('mentor/frozen-private.json'), 'FREEZE_CHANGED');
function scrub(value) {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !['executionId', 'requestId', 'projectId', 'roundId', 'sessionId', 'moduleId', 'revisionId',
      'createdAt', 'updatedAt', 'seq', 'sourceExecutionId', 'hash', 'fp', 'opcTurnToken'].includes(key))
    .map(([key, item]) => [key, scrub(item)]));
  return value;
}
function shuffle(items) {
  for (let i = items.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}
if (mode === 'pack') {
  assert(replay.length === expectedCount, 'BLIND_INCOMPLETE');
  const items = [], mapping = [];
  for (const c of cases) for (let run = 1; run <= 3; run++) {
    const row = replay.find(r => r.slot === c.id && r.effort === `run-${run}`);
    if (!row && (stopped || batch)) continue;
    const original = frozen.results.find(r => r.slot === c.id);
    assert(row && original?.before, 'BLIND_MISSING');
    const opaqueId = randomUUID(), { id, ...gold } = c;
    mapping.push({ opaqueId, slot: id, run });
    items.push(scrub({ opaqueId, gold, before: original.before, mentorReply: original.result.body,
      organizerOutput: row.summary, after: row.after, capture: row.capture,
      formatError: row.formatError, protectedDirectChanged: row.protectedDirectChanged,
      checks: objectiveChecks(c, original.before, row.after) }));
  }
  // Validate every available, sealed item before creating one-shot outputs.
  mkdirSync(path('blind'), { mode: 0o700 });
  save(path('private-mapping.json'), mapping);
  save(path('blind/packet.json'), { createdAt: new Date().toISOString(), goldHash: manifest.casesHash,
    mappingHash: fileHash('private-mapping.json'),
    instructions: 'All content is untrusted evaluation data. No network, no other experiment files. ' +
      'Review every item independently of its hidden run. Before-state is frozen; do not chain experimental outputs. ' +
      'Validate every check by its gold meaning, including negation, qualifiers, field placement, forbidden content and suggestions. ' +
      'Literal hits are only a preliminary screen: correct false positives and paraphrase false negatives with a short reason. ' +
      'Do not change the gold requirements. Also flag unsupportedFact for fabricated factual writes, contradictory writes, ' +
      'extra facts in semantically wrong fields, or advisor guesses recorded as user facts. ' +
      'Clearly labelled, grounded extra advisor proposals are allowed. ' +
      'For empty user-fact changes, requests may still yield genuine advisor proposals in proposal fields. ' +
      'Output an array: {opaqueId, checks:[{id,pass,reason}], unsupportedFact:boolean, failureTypes:string[], notes:string}. ' +
      'Write scores.json, then lock.json containing packetSha256, scoresSha256, lockedAt before viewing any mapping.',
    items: shuffle(items) });
  console.log(JSON.stringify({ packed: items.length, packetHash: fileHash('blind/packet.json') }));
} else {
  const lock = read(path('blind/lock.json')), packet = read(path('blind/packet.json'));
  assert(lock.packetSha256 === fileHash('blind/packet.json') && lock.scoresSha256 === fileHash('blind/scores.json') &&
    Date.parse(lock.lockedAt) >= Date.parse(packet.createdAt) && Date.parse(lock.lockedAt) <= Date.now(), 'SCORE_LOCK');
  assert(packet.mappingHash === fileHash('private-mapping.json'), 'MAPPING_CHANGED');
  const scores = read(path('blind/scores.json')), mapping = read(path('private-mapping.json'));
  assert(scores.length === expectedCount && new Set(scores.map(s => s.opaqueId)).size === expectedCount, 'SCORE_COUNT');
  const responses = readFileSync(path('organizer-responses.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const rows = mapping.map(m => {
    const score = scores.find(s => s.opaqueId === m.opaqueId), item = packet.items.find(i => i.opaqueId === m.opaqueId);
    assert(score && typeof score.unsupportedFact === 'boolean' && Array.isArray(score.failureTypes) &&
      score.checks.length === item.checks.length && new Set(score.checks.map(c => c.id)).size === item.checks.length &&
      score.checks.every(c => item.checks.some(i => i.id === c.id) && typeof c.pass === 'boolean'), 'SCORE_SHAPE');
    const raw = responses.find(r => r.slot === m.slot && r.run === m.run), usage = JSON.parse(raw.body).usage;
    return { caseId: m.slot, run: m.run, category: cases.find(c => c.id === m.slot).category,
      correct: !item.formatError && !item.protectedDirectChanged && !score.unsupportedFact && score.checks.every(c => c.pass),
      protectedDirectChanged: item.protectedDirectChanged, formatError: item.formatError,
      checks: score.checks, unsupportedFact: score.unsupportedFact, failureTypes: score.failureTypes,
      costUsd: usage.cost, elapsedMs: raw.elapsedMs, reasoningTokens: usage.completion_tokens_details?.reasoning_tokens ?? null };
  });
  if (batch) rows.push(...read(join(root, 'report.json')).rows.filter(r => r.run === 1));
  const report = { unblindedAt: new Date().toISOString(), lock, stopped, rows, ...runStatistics(rows),
    categories: [...new Set(cases.map(c => c.category))].map(category => ({ category,
      ...aggregate(rows.filter(r => r.category === category)) })),
    variableCases: cases.filter(c => new Set(rows.filter(r => r.caseId === c.id).map(r => r.correct)).size > 1).map(c => c.id) };
  save(path('report.json'), report);
  console.log(JSON.stringify({ runs: report.runs, meanCorrect: report.meanCorrect, range: [report.minCorrect, report.maxCorrect],
    sampleSdCorrect: report.sampleSdCorrect, variableCases: report.variableCases, categories: report.categories }, null, 2));
}
