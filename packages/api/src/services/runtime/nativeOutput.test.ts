/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { questionToolCardSchema } from '../../shared/agentTurn';
import { finalizeNativeSummary, prepareNativePrimary, stepEnvelope, nativeVisible } from './nativeOutput';
import { jsonbBytes, RESULT_BYTE_LIMIT, SUMMARY_RESERVE, META_RESERVE } from './resultCapacity';
const executionId = '10000000-0000-4000-8000-000000000001';
const options = { envelopeOrder: 'message-first-v1', length: false, attachedOrganizer: false, executionId };
const saved = (body: string, metadata: Record<string, unknown>) => ({
  kind: 'usable_result', evidenceRef: executionId, evidenceHash: '0'.repeat(64), body, ...metadata,
});
it.each(['plain text reply', '{"message":"unfinished', '{"message":2}', '{"card":{"question":2}}', '[]'])
  ('preserves legacy bodies without a usable envelope unless output reached length: %s', body => {
    expect(prepareNativePrimary(body, {}, options).body).toBe(body);
    expect(() => prepareNativePrimary(body, {}, { ...options, length: true }))
      .toThrow('RUNTIME_OUTPUT_TRUNCATED');
  });
it('keeps empty message on normal completion without charging a rejected reply', () => {
  expect(prepareNativePrimary('{"message":""}', {}, options)).toEqual({
    body: '{"message":""}', metadata: { completeness: 'complete', messageFirst: true },
  });
  expect(() => prepareNativePrimary('{"message":""}', {}, { ...options, length: true }))
    .toThrow('RUNTIME_OUTPUT_TRUNCATED');
});
it('cleans model patches with the existing permissive frontend rules', () => {
  const result = prepareNativePrimary(JSON.stringify({ message: ' kept ', inputKind: 'bogus', targetStepId: 2,
    informationPatch: {
      valid: { value: ' yes ', status: 'confirmed', nature: 'fact', basis: 'bad', private: true },
      uncertain: { value: ' maybe ', status: 'unclear', nature: 'hypothesis', basis: 'agent_proposal' },
      empty: { value: ' ', nature: 'fact' }, long: { value: 'x'.repeat(401), nature: 'fact' },
      badNature: { value: 'no', nature: 'bad' }, scalar: 'no', array: [],
    },
  }), {}, options);
  expect(JSON.parse(result.body)).toEqual({ message: ' kept ', informationPatch: {
    valid: { value: 'yes', status: 'provisional', nature: 'fact', basis: 'user_statement' },
    uncertain: { value: 'maybe', status: 'unclear', nature: 'hypothesis', basis: 'agent_proposal' },
  } });
});
it('strips unknown top-level and nested private fields using the completed step schema', () => {
  const result = prepareNativePrimary(JSON.stringify({ message: 'public', inputKind: 'answer', unknown: 'private',
    informationPatch: { topic: { value: 'value', status: 'provisional', nature: 'fact', secret: 'private' } },
  }), {}, options);
  expect(JSON.parse(result.body)).toEqual({ message: 'public', inputKind: 'answer',
    informationPatch: { topic: { value: 'value', status: 'provisional', nature: 'fact', basis: 'user_statement' } } });
  expect(result.metadata).toEqual({ completeness: 'complete', messageFirst: true });
});
it('records messageFirst false without losing a valid buffered envelope', () => {
  const result = prepareNativePrimary('{"inputKind":"answer","message":"complete public reply"}', {}, options);
  expect(result.metadata).toEqual({ completeness: 'complete', messageFirst: false });
  expect(stepEnvelope.parse(JSON.parse(result.body))).toEqual({ message: 'complete public reply', inputKind: 'answer' });
});
it('compacts oversized validated private fields, preserving the public message', () => {
  const result = prepareNativePrimary(JSON.stringify({ message: 'saved public prefix', targetStepId: 'x'.repeat(300000) }), {}, options);
  expect(JSON.parse(result.body)).toEqual({ message: 'saved public prefix' });
  expect(result.metadata).toMatchObject({ envelopeCompact: true, completeness: 'length_limit' });
  expect(jsonbBytes(saved(result.body, result.metadata))).toBeLessThanOrEqual(RESULT_BYTE_LIMIT);
});
it('does not emit an invalid empty-message envelope when private fields consume the last byte', () => {
  const empty = { message: '', targetStepId: '' };
  const privateLength = RESULT_BYTE_LIMIT - jsonbBytes(saved(JSON.stringify(empty), {
    completeness: 'length_limit', messageFirst: true,
  }));
  const result = prepareNativePrimary(JSON.stringify({ message: 'ABCDE', targetStepId: 'x'.repeat(privateLength) }), {}, options);
  expect(result.metadata.completeness).toBe('length_limit');
  const envelope = JSON.parse(result.body);
  expect(envelope.message.length).toBeGreaterThanOrEqual(1);
  expect(envelope.message).toBe('ABCDE');
  expect(result.metadata.envelopeCompact).toBe(true);
  expect(jsonbBytes(saved(result.body, result.metadata))).toBeLessThanOrEqual(RESULT_BYTE_LIMIT);
});
it('synchronizes both truncated card messages and validates the original card contract', () => {
  const card = { message: '"'.repeat(20000), recommendationReason: '\\'.repeat(20000),
    question: 'Q', options: ['A', 'B'], recommended: 0 };
  const result = prepareNativePrimary(JSON.stringify({ format: 'agent-turn.v1', message: card.message, card }),
    {}, { length: false, attachedOrganizer: true, executionId });
  const envelope = JSON.parse(result.body);
  expect(envelope.message).toBe(envelope.card.message);
  expect(envelope.message.length).toBeGreaterThanOrEqual(1);
  expect(envelope.message.length).toBeLessThan(card.message.length);
  expect(questionToolCardSchema.safeParse(envelope.card).success).toBe(true);
  expect(envelope.card).toMatchObject({ question: 'Q', options: ['A', 'B'], recommended: 0 });
  expect(result.metadata.completeness).toBe('length_limit');
  expect(jsonbBytes(saved(result.body, result.metadata)) + SUMMARY_RESERVE + META_RESERVE).toBeLessThanOrEqual(RESULT_BYTE_LIMIT);
});
it('rejects an invalid card during final validation', () => {
  const body = JSON.stringify({ format: 'agent-turn.v1', message: 'valid text',
    card: { message: 'valid text', question: 'Q', options: ['A', 'A'], recommended: null, recommendationReason: null } });
  expect(() => prepareNativePrimary(body, {}, { length: false, attachedOrganizer: false, executionId })).toThrow();
});
it('preserves primary bodies while omitting oversized or incomplete-result summaries', () => {
  const body = JSON.stringify({ message: 'saved primary' });
  expect(finalizeNativeSummary(body, { completeness: 'complete' }, 'valid summary'))
    .toEqual({ summary: 'valid summary', metadata: { completeness: 'complete', organized: true } });
  for (const [metadata, summary] of [
    [{ completeness: 'complete' }, '\\'.repeat(40000)],
    [{ completeness: 'length_limit' }, 'short'],
    [{ completeness: 'complete', envelopeCompact: true }, 'short'],
  ] as const) {
    const result = finalizeNativeSummary(body, metadata, summary);
    expect(result.summary).toBe('');
    expect(result.metadata).toMatchObject({ ...metadata, organized: false, summaryOmitted: true });
  }
});

it('projects preserved plain text and empty messages without exposing malformed JSON fields', () => {
  expect(nativeVisible('plain text reply')).toBe('plain text reply');
  expect(nativeVisible('123')).toBe('123');
  expect(nativeVisible('{"message":""}')).toBe('');
  expect(nativeVisible('{"private":"unfinished')).not.toContain('private');
});
