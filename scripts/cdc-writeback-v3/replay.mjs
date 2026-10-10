/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Offline SQL replay of paid organizer outputs through the real host, 0199 functions and a disposable database.
// The host must rebuild exactly the frozen organizer request (system, payload, cap, route); the paid summary is then applied and rolled back per case.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { git } from '../cdc-writeback-v2/source.mjs';
import { runHost } from '../cdc-writeback-v2/host.mjs';
import { validateResponse } from '../cdc-writeback-v2/frozen.mjs';
import { paths, pins, runs, marker, outputTokens, hash, assert, readJson, splitRequest, sameOrganizerRequest, sameOrganizerUserContent,
  validateV3Response } from './common.mjs';
import { frozenV3 } from './run.mjs';

const synthetic = (slot, model, content) => JSON.stringify({ id: 'gen-offline-' + slot, object: 'chat.completion', created: 1, model,
  choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, cost: 0.001 } });
// The real mentor stream carries plain message text; the host wraps it into agent-turn.v1 itself.
// Re-wrapping the frozen envelope was one A12 defect; a stream without provider identity and usage
// was the other (the execution stayed cost_pending). Reuse a recorded stream's frames, replacing only the text.
export function mentorStream(tail, template) {
  const envelope = JSON.parse(tail.slice(marker.length));
  assert(envelope.format === 'agent-turn.v1' && typeof envelope.message === 'string' && envelope.card === null, 'V3_MENTOR_ENVELOPE');
  const frames = template.split('\n').filter(line => line.startsWith('data: ') && line !== 'data: [DONE]').map(line => JSON.parse(line.slice(6)));
  const final = frames.filter(f => f.choices?.[0]?.finish_reason === 'stop');
  assert(frames.length > 2 && final.length >= 1 && final.at(-1).usage && frames[0].choices[0].finish_reason === null, 'V3_MENTOR_TEMPLATE');
  const first = structuredClone(frames[0]);
  first.choices[0].delta = { ...first.choices[0].delta, content: envelope.message };
  // Each synthetic call needs its own generation identity; the runtime records it per provider call.
  const id = `${frames[0].id}-${randomUUID()}`;
  return [first, ...final].map(f => 'data: ' + JSON.stringify({ ...f, id })).join('\n\n') + '\n\ndata: [DONE]\n\n';
}

/** Batches: R1-R3 and S12 replay V3 paid outputs; A12-reference replays the already-paid A12 outputs at no cost. */
export function sources(batch) {
  assert([...runs, 'S12', 'A12-reference'].includes(batch), 'V3_REPLAY_BATCH');
  if (batch === 'A12-reference') {
    const manifest = readFileSync(join(paths.source, 'frozen/requests.manifest.json'));
    assert(hash(manifest) === pins.sourceManifestHash, 'V3_SOURCE_MANIFEST_CHANGED');
    const rows = JSON.parse(manifest).filter(r => r.stage === 'A' && r.group === 'source12')
      .map(r => ({ ...r, raw: readFileSync(join(paths.source, 'frozen', r.id.replace('/', '-') + '.request.json'), 'utf8') }));
    rows.forEach(r => assert(hash(r.raw) === r.requestHash, 'V3_SOURCE_REQUEST_CHANGED'));
    // Historical reference only: A12 was paid with the A-group prompt, so the request check is limited to the payload.
    return { rows, execution: join(paths.source, 'frozen/execution'), completedName: 'A12', validate: validateResponse,
      same: sameOrganizerUserContent, check: { exactOrganizerUserContent: true } };
  }
  const frozen = frozenV3();
  return { rows: frozen.requests.filter(r => r.batch === batch), execution: join(frozen.directory, 'execution'),
    completedName: batch, validate: response => validateV3Response(response, validateResponse), frozen,
    same: sameOrganizerRequest, check: { exactOrganizerRequest: true } };
}

export function paidVariants(batch, source) {
  const completed = readJson(join(source.execution, source.completedName + '.completed.json'));
  assert(JSON.stringify(completed.ids) === JSON.stringify(source.rows.map(r => r.id)), 'V3_REPLAY_INCOMPLETE');
  const raws = source.rows.map(r => readFileSync(join(source.execution, r.id.replace('/', '-') + '.response.json')));
  assert(hash(JSON.stringify(raws.map(raw => hash(raw)))) === completed.responsesHash, 'V3_REPLAY_RESPONSES_CHANGED');
  const variants = raws.map((raw, i) => {
    const response = JSON.parse(raw), row = source.rows[i];
    assert(response.id === row.id && response.requestHash === row.requestHash, 'V3_REPLAY_RESPONSE_ID');
    source.validate(response);
    const body = JSON.parse(response.body);
    return { slot: row.slot, effort: batch, summary: body.choices[0].message.content, finish: body.choices[0].finish_reason };
  });
  return { variants, responsesHash: completed.responsesHash };
}

export function plan(batch, source) {
  const planRaw = readFileSync(join(paths.source, 'host-plan.json')), base = JSON.parse(planRaw);
  // The local host emits the live organizer cap; the full-request comparison then proves the frozen cap matches it.
  base.organizerOutputTokens = outputTokens;
  if (runs.includes(batch)) {
    assert(base.writebackV2 === true && base.groups.length === 100 &&
      JSON.stringify(base.groups.map(g => g.turns[0].slot)) === JSON.stringify(source.rows.map(r => r.slot)), 'V3_PLAN_ROSTER');
    return { plan: base, planHash: hash(planRaw) };
  }
  const gold = readJson(join(paths.source, 'frozen/special12.json'));
  base.groups = source.rows.map((row, i) => {
    const { context, tail } = splitRequest(row.raw), c = gold[i];
    assert(c.id === row.slot && context.originalStepId === 'step-1' && context.userInput === c.userInput &&
      JSON.parse(tail.slice(marker.length)).message === c.mentorContext, 'V3_SPECIAL_GOLD_CONTEXT');
    return { stepId: context.originalStepId, questionId: context.checklist[0].fields[0].id, initial: [],
      specialFrozenChecklist: context.checklist,
      turns: [{ slot: c.id, category: 'source12', input: context.userInput, organize: true, dryPatches: [] }] };
  });
  return { plan: base, planHash: hash(planRaw) };
}

/** dry: zero-cost proof that the host rebuilds every frozen request (synthetic empty outputs, no paid responses read). */
export async function main(batch, dry = false) {
  const source = sources(batch), built = plan(batch, source);
  const { variants, responsesHash } = dry ? { variants: undefined, responsesHash: null } : paidVariants(batch, source);
  const output = join(paths.root, (dry ? 'dry-' : 'replay-') + batch);
  assert(!existsSync(output), 'V3_REPLAY_EXISTS');
  const recorded = readFileSync(join(paths.baseline, 'mentor-responses.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const mentors = runs.includes(batch) ? recorded : null, template = recorded.find(m => m.slot === 'C001').body;
  await runHost(built.plan, output, async input => {
    const row = source.rows.find(r => r.slot === input.slot);
    assert(row, 'V3_REPLAY_SLOT');
    const model = JSON.parse(input.raw).model;
    if (input.role === 'mentor') {
      if (mentors) { const found = mentors.find(m => m.slot === input.slot); assert(found, 'V3_MENTOR_MISSING'); return found.body; }
      return mentorStream(splitRequest(row.raw).tail, template);
    }
    assert(source.same(input.raw, row.raw), 'V3_REPLAY_FROZEN_REQUEST_MISMATCH');
    return synthetic(input.slot, model, '{"inputKind":"answer","patches":[],"notes":[]}');
  }, variants);
  if (dry) {
    const proof = { batch, dry: true, count: source.rows.length, head: git('rev-parse', 'HEAD'), planHash: built.planHash,
      manifestHash: source.frozen?.expected.manifestHash ?? pins.sourceManifestHash, ...source.check, externalModelCalls: 0 };
    writeFileSync(join(paths.root, 'dry-' + batch + '.proof.json'), JSON.stringify(proof) + '\n', { flag: 'wx', mode: 0o600 });
    return proof;
  }
  const raw = readFileSync(join(output, 'reasoning-results.json'));
  const results = JSON.parse(raw);
  assert(results.length === source.rows.length &&
    JSON.stringify(results.map(r => r.slot)) === JSON.stringify(source.rows.map(r => r.slot)), 'V3_REPLAY_RESULTS');
  const proof = { batch, count: results.length, head: git('rev-parse', 'HEAD'), planHash: built.planHash,
    manifestHash: source.frozen?.expected.manifestHash ?? pins.sourceManifestHash, paidResponsesHash: responsesHash,
    resultsHash: hash(raw), frozenPrivateHash: hash(readFileSync(join(output, 'frozen-private.json'))),
    ...source.check, externalModelCalls: 0, replay: 'COMPLETED' };
  writeFileSync(join(paths.root, 'replay-' + batch + '.proof.json'), JSON.stringify(proof) + '\n', { flag: 'wx', mode: 0o600 });
  return proof;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await main(process.argv[2], process.argv[3] === 'dry'))); }
  catch (e) { console.error(/^[A-Z0-9_]+$/.test(e.message) ? e.message : 'V3_REPLAY_STOP_SEE_PRIVATE_LOG'); process.exitCode = 1; }
}
