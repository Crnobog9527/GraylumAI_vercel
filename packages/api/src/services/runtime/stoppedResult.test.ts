/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { agentTurnBody } from '../../shared/agentTurn';
import { stoppedResult, type StopProjectionInput } from './stoppedResult';
import { jsonbBytes, RESULT_BYTE_LIMIT } from './resultCapacity';
import { NativeTextTransport } from './nativeProgress';
const base: StopProjectionInput = {
  executionId: '10000000-0000-4000-8000-000000000001', format: 'plain', body: '中😀\n文', stopAt: 3,
  revisionMatches: true, primaryComplete: true, attachedOrganizer: false,
};
it('counts Unicode points and trims only trailing whitespace', () => {
  expect(stoppedResult(base)).toMatchObject({ body: '中😀', stopped: true, completeness: 'stopped' });
  expect(stoppedResult({ ...base, body: '  中😀后', stopAt: 4 })?.body).toBe('  中😀');
});
it.each([0, 1])('empty or whitespace-only visible prefix becomes cancellation (%s)', stopAt => {
  expect(stoppedResult({ ...base, body: ' 后', stopAt })).toBeNull();
});
it('revision mismatch follows empty-result cancellation even with nonempty body', () => {
  expect(stoppedResult({ ...base, revisionMatches: false })).toBeNull();
});
it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid stop position %s', stopAt => {
  expect(() => stoppedResult({ ...base, stopAt })).toThrow('RUNTIME_STOP_POSITION_INVALID');
});
it('preserves complete and distinguishes provider length from a complete primary', () => {
  expect(stoppedResult({ ...base, stopAt: 100 })?.completeness).toBe('complete');
  expect(stoppedResult({ ...base, stopAt: 100, primaryComplete: false })?.completeness).toBe('stopped');
});
it('keeps a complete card, drops it on visible truncation, and rebuilds a valid envelope', () => {
  const card = { message: '中😀后', question: 'Q?', options: ['A', 'B'], recommended: 0, recommendationReason: 'reason' };
  const input = { ...base, format: 'agent' as const, body: agentTurnBody(card.message, card) };
  expect(JSON.parse(stoppedResult(input)!.body).card).toEqual(card);
  expect(JSON.parse(stoppedResult({ ...input, stopAt: 2 })!.body)).toEqual({
    format: 'agent-turn.v1', message: '中😀', card: null,
  });
  expect(stoppedResult({ ...input, stopAt: 0 })).toBeNull();
});
it('rebuilds a cardless mentor envelope', () => {
  expect(stoppedResult({ ...base, format: 'agent', body: agentTurnBody('中😀后', null), stopAt: 2 })?.body)
    .toBe(agentTurnBody('中😀', null));
});
it.each([false, true])('step keeps validated private fields, truncates message only, organizer=%s', attachedOrganizer => {
  const envelope = { message: '中😀\n文', inputKind: 'answer', targetStepId: 'step-1',
    informationPatch: { a: { value: 'fact', status: 'provisional', nature: 'fact', basis: 'user_statement' } } };
  const result = stoppedResult({ ...base, attachedOrganizer, format: 'step', body: JSON.stringify({ ...envelope, secret: 'drop' }) });
  expect(JSON.parse(result!.body)).toEqual({ ...envelope, message: '中😀' });
  if (attachedOrganizer) expect(result).toMatchObject({ summary: '', organized: false });
  else expect(result).not.toHaveProperty('organized');
});
it.each(['{bad', '{"message":2}', '[]', '{"message":""}', 'plain non-envelope'])('invalid step becomes cancellation: %s', body => {
  expect(stoppedResult({ ...base, format: 'step', body })).toBeNull();
});
it('organizer not dispatched and primary still in flight both save without summary', () => {
  expect(stoppedResult({ ...base, attachedOrganizer: true, stopAt: 100 }))
    .toMatchObject({ completeness: 'complete', organized: false, summary: '' });
  expect(stoppedResult({ ...base, attachedOrganizer: true }))
    .toMatchObject({ completeness: 'stopped', organized: false, summary: '' });
});
it('inflight organizer keeps summary only when the whole primary is visible', () => {
  expect(stoppedResult({ ...base, attachedOrganizer: true, stopAt: 100, summary: 'summary' }))
    .toMatchObject({ completeness: 'complete', organized: true, summary: 'summary' });
  expect(stoppedResult({ ...base, attachedOrganizer: true, summary: 'summary' }))
    .toMatchObject({ completeness: 'stopped', organized: false, summary: '' });
});
it('omits oversized organizer summary without changing body', () => {
  expect(stoppedResult({ ...base, attachedOrganizer: true, stopAt: 100, summary: 'x'.repeat(70000) }))
    .toMatchObject({ body: base.body, organized: false, summary: '', summaryOmitted: true });
});
it.each(['😀', '中', '"', '\\', '\n', '\u0001'])('capacity remains bounded for %s', character => {
  const result = stoppedResult({ ...base, body: character.repeat(300000), stopAt: 300000 });
  if (character === '\n') { expect(result).toBeNull(); return; }
  expect(result?.completeness).toBe('length_limit');
  expect(jsonbBytes(result)).toBeLessThanOrEqual(RESULT_BYTE_LIMIT);
});
it('oversized private step fields use the existing compact fallback', () => {
  const result = stoppedResult({ ...base, format: 'step', body: JSON.stringify({ message: '中😀后', targetStepId: 'x'.repeat(300000) }) });
  expect(result).toMatchObject({ envelopeCompact: true, completeness: 'length_limit' });
  expect(JSON.parse(result!.body)).toEqual({ message: '中😀后' });
});
it('live and recovery projection are byte-identical with stable evidence hashes', () => {
  const input = { ...base, attachedOrganizer: true, summary: 'summary' };
  expect(JSON.stringify(stoppedResult(structuredClone(input)))).toBe(JSON.stringify(stoppedResult(structuredClone(input))));
});
it('demonstrates why saved provider bytes alone cannot reconstruct transmitted rev', () => {
  const early = new NativeTextTransport(), buffered = new NativeTextTransport();
  const assistant = { type: 'text' as const, text: 'assistant', delta: 'assistant', replace: true };
  const card = { type: 'text' as const, text: 'card', delta: 'card', replace: true };
  early.push(assistant); buffered.push(assistant);
  expect(early.flush()?.rev).toBe(0);
  early.push(card); buffered.push(card);
  // Exactly the same projection updates, different flush timing, different rev.
  expect(early.flush()).toMatchObject({ text: 'card', rev: 1 });
  expect(buffered.flush()).toMatchObject({ text: 'card', rev: 0 });
});
