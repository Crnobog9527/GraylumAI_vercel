/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Deterministic V3 roster from the 4096 B requests. Only the system text, the output cap and seeded pendingSuggestion change.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { budgetState } from '../cdc-writeback-v2/budget.mjs';
import { paths, pins, runs, outputTokens, hash, assert, readJson, reserveNano, organizerSystem, splitRequest, withPending,
  withoutPending } from './common.mjs';

const route = { allow_fallbacks: false, require_parameters: true, only: ['openai'],
  max_price: { prompt: 0.25, completion: 0.75, request: 0 } };

export function sourceInputs(p = paths, expected = pins) {
  const casesRaw = readFileSync(join(p.baseline, 'cases.json')), manifestRaw = readFileSync(join(p.source, 'frozen/requests.manifest.json'));
  const specialRaw = readFileSync(join(p.source, 'frozen/special12.json'));
  assert(hash(casesRaw) === expected.casesHash, 'V3_CASES_CHANGED');
  assert(hash(manifestRaw) === expected.sourceManifestHash, 'V3_SOURCE_MANIFEST_CHANGED');
  assert(hash(specialRaw) === expected.specialHash, 'V3_SPECIAL_CHANGED');
  const manifest = JSON.parse(manifestRaw), rows = manifest.filter(row => row.stage === 'B');
  assert(rows.length === 112, 'V3_SOURCE_ROSTER');
  const sources = rows.map(row => {
    const raw = readFileSync(join(p.source, 'frozen', row.id.replace('/', '-') + '.request.json'), 'utf8');
    assert(hash(raw) === row.requestHash && Buffer.byteLength(raw) === row.bytes, 'V3_SOURCE_REQUEST_CHANGED');
    return { ...row, raw };
  });
  return { cases: JSON.parse(casesRaw), special: JSON.parse(specialRaw), sources, specialRaw };
}

/** One V3 request per source. A1: everything except system, max_tokens (production cap) and pendingSuggestion stays
 * byte-identical. `system` must be the complete production organizer system prompt (see promptAt). */
export function freezeRequest(source, system, initial) {
  const { body, context, tail } = splitRequest(source.raw);
  assert(body.model === 'openai/gpt-6-luna' && body.max_tokens === 4096 && body.stream === false && body.store === false &&
    JSON.stringify(body.provider) === JSON.stringify(route) && body.reasoning === undefined && body.reasoning_effort === undefined &&
    JSON.stringify(Object.keys(body).sort()) === JSON.stringify(['max_tokens', 'messages', 'model', 'provider', 'store', 'stream']),
  'V3_SOURCE_PROFILE');
  assert(body.messages[0].role === 'system' && body.messages[1].role === 'user' && body.messages[0].content !== system, 'V3_SOURCE_SYSTEM');
  // The composed system prompt has no OPENING_EXTRACTION_RULE: every roster turn must be a user answer, never a host opening.
  assert(typeof context.userInput === 'string' && context.userInput.trim() && context.hostEvent === undefined, 'V3_OPENING_UNSUPPORTED');
  const updated = withPending(context, initial), text = JSON.stringify(updated);
  assert(text.length <= 24000, 'V3_CAPTURE_INPUT_LIMIT');
  const next = { ...body, messages: [{ ...body.messages[0], content: system }, { ...body.messages[1], content: text + tail }],
    max_tokens: outputTokens };
  const raw = JSON.stringify(next);
  // Prove the delta: restoring the old system text and cap and removing pendingSuggestion gives the source bytes back.
  const back = splitRequest(raw);
  assert(back.body.max_tokens === outputTokens, 'V3_DELTA');
  const restored = { ...back.body, max_tokens: body.max_tokens, messages: [body.messages[0], { ...back.body.messages[1],
    content: JSON.stringify(withoutPending(back.context)) + back.tail }] };
  assert(JSON.stringify(restored) === source.raw && Buffer.byteLength(raw) <= 64000, 'V3_DELTA');
  return raw;
}

export function buildRoster(inputs, system) {
  const rows = [];
  for (const source of inputs.sources) {
    const special = source.group === 'source12';
    const initial = special ? [] : inputs.cases.find(c => c.id === source.slot)?.initial;
    assert(Array.isArray(initial), 'V3_CASE_MISSING');
    const raw = freezeRequest(source, system, initial), bytes = Buffer.byteLength(raw);
    for (const batch of special ? ['S12'] : runs) rows.push({ id: `${batch}/${source.slot}`, stage: batch, batch,
      slot: source.slot, group: source.group, budgetStage: 'suggestions', bytes, requestHash: hash(raw),
      reserveNano: reserveNano(bytes), sourceRequestHash: source.requestHash, raw });
  }
  assert(rows.length === 312 && new Set(rows.map(r => r.id)).size === 312, 'V3_ROSTER');
  assert(rows.filter(r => r.group === 'original100').length === 300, 'V3_ROSTER_GROUPS');
  return rows;
}

/** The complete organizer system prompt the checked-out backend sends for these turns. */
export function promptAt(repo) {
  const read = file => readFileSync(join(repo, 'packages/api/src/services/opc', file), 'utf8');
  return organizerSystem({ prompt: read('organizerPrompt.ts'), answerCard: read('answerCard.ts'), service: read('service.ts') });
}

/** The first V3 ledger is carried whole: its settled amount and every unknown hold. It must have nothing pending. */
export function carry(p = paths, expected = pins) {
  const path = join(p.firstRun, 'frozen/execution/budget.jsonl'), raw = readFileSync(path, 'utf8');
  assert(hash(raw) === expected.sourceLedgerHash, 'V3_LEDGER_CHANGED');
  const state = budgetState(raw.trimEnd().split('\n').map(JSON.parse));
  assert(!state.pending && state.settledNano === expected.settledNano && state.heldNano === expected.heldNano,
    'V3_LEDGER_STATE');
  return { path, carry: { settledNano: state.settledNano, heldNano: state.heldNano, sourceHash: expected.sourceLedgerHash } };
}

export function writeRoster(directory, rows, specialRaw) {
  assert(!existsSync(directory), 'V3_ALREADY_FROZEN');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const row of rows) writeFileSync(join(directory, row.id.replace('/', '-') + '.request.json'), row.raw, { flag: 'wx', mode: 0o600 });
  writeFileSync(join(directory, 'special12.json'), specialRaw, { flag: 'wx', mode: 0o600 });
  const manifest = JSON.stringify(rows.map(({ raw, ...row }) => row)) + '\n';
  writeFileSync(join(directory, 'requests.manifest.json'), manifest, { flag: 'wx', mode: 0o600 });
  return hash(manifest);
}

/** Recomputes the roster from pinned sources and the current checkout and requires identical files. */
export function loadRoster(directory, manifestHash, system, p = paths, expected = pins) {
  const inputs = sourceInputs(p, expected), rows = buildRoster(inputs, system);
  const manifestRaw = readFileSync(join(directory, 'requests.manifest.json'));
  assert(hash(manifestRaw) === manifestHash, 'V3_MANIFEST_CHANGED');
  assert(JSON.stringify(JSON.parse(manifestRaw)) === JSON.stringify(rows.map(({ raw, ...row }) => row)), 'V3_MANIFEST_NOT_REPRODUCIBLE');
  for (const row of rows) assert(readFileSync(join(directory, row.id.replace('/', '-') + '.request.json'), 'utf8') === row.raw,
    'V3_REQUEST_NOT_REPRODUCIBLE');
  assert(hash(readFileSync(join(directory, 'special12.json'))) === expected.specialHash, 'V3_SPECIAL_CHANGED');
  return { rows, cases: inputs.cases, special: inputs.special };
}

export const batchReserves = rows => Object.fromEntries(['R1', 'R2', 'R3', 'S12'].map(batch =>
  [batch, rows.filter(r => r.batch === batch).reduce((n, r) => n + r.reserveNano, 0)]));
export { readJson };
