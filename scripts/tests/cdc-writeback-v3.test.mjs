/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import test from 'node:test';
import strict from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { organizerInstructions, splitRequest, withPending, withoutPending, sameUserContent, validateV3Response, reserveNano,
  marker } from '../cdc-writeback-v3/common.mjs';
import { freezeRequest } from '../cdc-writeback-v3/frozen.mjs';
import { mentorStream } from '../cdc-writeback-v3/replay.mjs';
import { criteria, scrub, passes, validateScores } from '../cdc-writeback-v3/blind.mjs';
import { validateResponse } from '../cdc-writeback-v2/frozen.mjs';

const route = { allow_fallbacks: false, require_parameters: true, only: ['openai'], max_price: { prompt: 0.25, completion: 0.75, request: 0 } };
const context = { captureFormat: 'v2', userInput: '那条建议不对', checklist: [{ id: 'step-1', title: 'One', fields: [
  { id: 'goal', title: 'Goal', required: true, role: 'user_fact', status: 'draft', protected: true, elicit: 'user_fact',
    value: '每周两小时', nature: 'fact' },
  { id: 'track', title: 'Track', required: true, role: 'user_fact', status: 'missing', protected: true, elicit: 'user_fact',
    value: '', nature: 'unknown' }] }] };
const tail = marker + JSON.stringify({ format: 'agent-turn.v1', message: '好的，我记下了。', card: null });
const source = system => JSON.stringify({ model: 'openai/gpt-6-luna', messages: [{ role: 'system', content: system },
  { role: 'user', content: JSON.stringify(context) + tail }], max_tokens: 4096, stream: false, store: false, provider: route });
const initial = [{ stepId: 'step-1', fieldId: 'goal', value: '每周两小时', protected: true,
  suggestion: { value: '每周六小时，不露脸', nature: 'fact', basis: 'user_statement' } }];

test('V3 prompt extraction evaluates only the checked-in string expression', () => {
  const real = organizerInstructions(readFileSync(new URL('../../packages/api/src/services/opc/organizerPrompt.ts', import.meta.url), 'utf8'));
  strict.match(real, /withdrawals: \[\{stepId,fieldId\}\]/);
  strict.throws(() => organizerInstructions('export const ORGANIZER_INSTRUCTIONS = "no rules";\n'), /V3_PROMPT_VALUE/);
  strict.throws(() => organizerInstructions('export const ORGANIZER_INSTRUCTIONS = process.exit(1);\n'), /process is not defined/);
});

test('V3 freeze changes only the system text and the seeded pendingSuggestion, as the last field key', () => {
  const raw = freezeRequest({ raw: source('B system') }, 'V3 system', initial);
  const { body, context: frozen } = splitRequest(raw);
  strict.equal(body.messages[0].content, 'V3 system');
  strict.deepEqual(Object.keys(frozen.checklist[0].fields[0]).at(-1), 'pendingSuggestion');
  strict.deepEqual(frozen.checklist[0].fields[0].pendingSuggestion, initial[0].suggestion);
  strict.equal(frozen.checklist[0].fields[1].pendingSuggestion, undefined);
  strict.deepEqual(withoutPending(frozen), context);
  strict.equal(freezeRequest({ raw: source('B system') }, 'V3 system', []).includes('pendingSuggestion'), false);
  strict.throws(() => freezeRequest({ raw: source('same') }, 'same', []), /V3_SOURCE_SYSTEM/);
  strict.throws(() => freezeRequest({ raw: source('B').replace('"max_tokens":4096', '"max_tokens":2048') }, 'V3', []), /V3_SOURCE_PROFILE/);
  strict.throws(() => withPending(context, [{ ...initial[0], fieldId: 'missing' }]), /V3_PENDING_FIELD/);
  strict.equal(reserveNano(1000), (1000 + 8192) * 250 + 4096 * 750);
});

test('V3 replay compares normalized organizer payloads and unwraps the frozen mentor envelope once', () => {
  const frozen = freezeRequest({ raw: source('B') }, 'V3', initial);
  const body = JSON.parse(frozen), [text] = body.messages[1].content.split(marker);
  const reordered = Object.fromEntries(Object.entries(JSON.parse(text)).reverse());
  body.messages = [{ role: 'system', content: 'host system differs' }, { role: 'user', content: JSON.stringify(reordered) + tail }];
  strict.equal(sameUserContent(JSON.stringify(body), frozen), true);
  strict.equal(sameUserContent(source('B'), frozen), false);
  const stream = mentorStream(tail, 'P01', 'model');
  strict.match(stream, /"content":"好的，我记下了。"/);
  strict.doesNotMatch(stream, /agent-turn\.v1/);
});

test('V3 response validation stops on malformed withdrawals but accepts absent or valid lists', () => {
  const response = output => ({ status: 200, body: JSON.stringify({ provider: 'OpenAI', usage: { cost: 0.0001 },
    choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ inputKind: 'answer', patches: [], notes: [], ...output }) } }] }) });
  strict.equal(validateV3Response(response({}), validateResponse), 0.0001);
  strict.equal(validateV3Response(response({ withdrawals: [{ stepId: 'step-1', fieldId: 'goal' }] }), validateResponse), 0.0001);
  for (const bad of [{}, null, ['x'], Array(13).fill({ stepId: 's', fieldId: 'f' })])
    strict.throws(() => validateV3Response(response({ withdrawals: bad }), validateResponse), /WITHDRAWAL_FORMAT_STOP/);
});

test('V3 scoring hides run identity, keeps every gold condition and lets no score override technical failures', () => {
  strict.deepEqual(scrub({ withdrawnSuggestion: { value: 'x', withdrawnBy: 'id', withdrawnSeq: [1, 2], hash: 'h' } }),
    { withdrawnSuggestion: { value: 'x' } });
  strict.deepEqual(criteria({ retain: ['a', 'b'], patches: [] }).map(c => c.id), ['expected/retain/0', 'expected/retain/1', 'expected/patches']);
  const item = { opaqueId: 'o', checks: [{ id: 'c' }], formatError: false, protectedDirectChanged: false };
  const score = { opaqueId: 'o', checks: [{ id: 'c', pass: true, reason: 'ok' }], unsupportedFact: false, failureTypes: [], notes: '' };
  validateScores({ items: [item] }, [score]);
  strict.equal(passes(item, score), true);
  strict.equal(passes({ ...item, protectedDirectChanged: true }, score), false);
  strict.equal(passes(item, { ...score, failureTypes: ['x'] }), false);
  strict.throws(() => validateScores({ items: [item] }, [{ ...score, checks: [] }]), /V3_SCORE_SHAPE/);
});
