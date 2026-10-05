/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { questionToolCardSchema } from '../../shared/agentTurn';
import { attachNativeSummary, fitNativeResult, fitNativeSessionItem, jsonbBytes,
  META_RESERVE, RESULT_BYTE_LIMIT, SUMMARY_RESERVE } from './resultCapacity';

describe('native result storage capacity', () => {
  it('counts jsonb spacing, double escapes, Unicode and expanded numeric notation', () => {
    expect(jsonbBytes({ x: [1, 2], body: JSON.stringify({ message: '中"\\\n😀' }) }))
      .toBe(Buffer.byteLength('{"x": [1, 2], "body": ' + JSON.stringify(JSON.stringify({ message: '中"\\\n😀' })) + '}'));
    expect(jsonbBytes({ n: 1e21, small: 1e-7 })).toBe(Buffer.byteLength('{"n": 1000000000000000000000, "small": 0.0000001}'));
  });
  it.each(['😀', '中', '\\', '"', '\n', 'x'])('fits actual escaped bytes and code points for %j', unit => {
    const body = JSON.stringify({ message: unit.repeat(300000), phase: 'done' });
    const result = fitNativeResult({ body, kind: 'usable_result' });
    expect(jsonbBytes(result)).toBeLessThanOrEqual(RESULT_BYTE_LIMIT);
    expect(result.completeness).toBe('length_limit');
    const parsed = JSON.parse(result.body);
    expect(parsed.phase).toBe('done');
    expect((unit.repeat(300000)).startsWith(parsed.message)).toBe(true);
    expect(parsed.message).not.toMatch(/[\uD800-\uDBFF]$/);
  });
  it('reserves summary before checkpoint and never changes that body afterwards', () => {
    const primary = fitNativeResult({ body: JSON.stringify({ message: '😀'.repeat(100000) }) }, { attachedOrganizer: true });
    expect(jsonbBytes(primary) + SUMMARY_RESERVE + META_RESERVE).toBeLessThanOrEqual(RESULT_BYTE_LIMIT);
    for (const summary of ['short', '"\\'.repeat(40000)]) {
      const result = attachNativeSummary(primary, summary);
      expect(result.body).toBe(primary.body);
      expect(jsonbBytes(result)).toBeLessThanOrEqual(RESULT_BYTE_LIMIT);
      expect(result.organized).toBe(false);
      expect(result.summary).toBe('');
    }
  });
  it('retains bounded summaries only for complete results', () => {
    const primary = fitNativeResult({ body: 'complete' }, { attachedOrganizer: true });
    expect(attachNativeSummary(primary, 'summary')).toMatchObject({ summary: 'summary', organized: true });
    expect(attachNativeSummary(primary, '\\'.repeat(40000)))
      .toMatchObject({ summary: '', organized: false, summaryOmitted: true });
  });
  it('whitelists T2 even without truncation and compacts oversized private fields', () => {
    const validateEnvelope = (value: unknown) => {
      const input = value as { message: string; private: string };
      return { message: input.message, private: input.private };
    };
    const clean = fitNativeResult({ body: JSON.stringify({ message: 'hello', private: 'small', ignored: 'secret' }) }, { validateEnvelope });
    expect(JSON.parse(clean.body)).toEqual({ message: 'hello', private: 'small' });
    const compact = fitNativeResult({ body: JSON.stringify({ message: 'hello', private: 'x'.repeat(300000) }) }, { validateEnvelope });
    expect(JSON.parse(compact.body)).toEqual({ message: 'hello' });
    expect(compact).toMatchObject({ envelopeCompact: true, completeness: 'length_limit' });
  });
  it('keeps both card messages equal and preserves the fixed question fields', () => {
    const card = { message: '"'.repeat(20000), recommendationReason: '\\'.repeat(20000),
      question: 'Q', options: ['A', 'B'], recommended: 0 };
    const result = fitNativeResult({ body: JSON.stringify({ format: 'agent-turn.v1', message: card.message, card }),
      metadata: 'x'.repeat(80000) }, { attachedOrganizer: true });
    const saved = JSON.parse(result.body);
    expect(jsonbBytes(result) + SUMMARY_RESERVE + META_RESERVE).toBeLessThanOrEqual(RESULT_BYTE_LIMIT);
    expect(saved.message).toBe(saved.card.message);
    expect(saved.card.message.length).toBeGreaterThanOrEqual(1);
    expect(saved.card.recommendationReason.length).toBeGreaterThanOrEqual(1);
    expect(questionToolCardSchema.safeParse(saved.card).success).toBe(true);
    expect(saved.card).toMatchObject({ question: 'Q', options: ['A', 'B'], recommended: 0 });
  });
  it('fails closed on oversized host metadata and drops oversized Session items', () => {
    expect(() => fitNativeResult({ body: 'hello', metadata: 'x'.repeat(300000) })).toThrow('RUNTIME_RESULT_METADATA_CAPACITY');
    expect(fitNativeSessionItem({ text: 'x'.repeat(300000) })).toBeNull();
    expect(fitNativeSessionItem({ text: 'safe' })).toEqual({ text: 'safe' });
  });
});
