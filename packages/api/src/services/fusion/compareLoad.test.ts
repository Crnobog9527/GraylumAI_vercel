/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';

import { fitHistory, historyTurn } from './compareLoad';
import { FUSION_INPUT_CAP } from './request';
import { compareRequest, compareRequestBytes } from './compareSnapshot';

const user = (text: string) => ({ role: 'user', content: text });
const assistant = (text: string) => ({ role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] });
describe('compare loading (FUSION-COMPARE §3.2)', () => {
  it('keeps only visible user and assistant text from stored history items', () => {
    expect(historyTurn(user('问'))).toEqual({ role: 'user', text: '问' });
    expect(historyTurn({ role: 'user', content: [{ type: 'input_text', text: '甲' }, { type: 'input_text', text: '乙' }] }))
      .toEqual({ role: 'user', text: '甲乙' });
    expect(historyTurn(assistant('答'))).toEqual({ role: 'assistant', text: '答' });
    expect(historyTurn({ type: 'function_call_result', output: 'x' })).toBeNull();
    expect(historyTurn({ role: 'assistant', content: [{ type: 'reasoning', text: 'hidden' }] })).toBeNull();
  });

  it('keeps the same turns whatever the language setting, so the request identity does not change with it', () => {
    const turn = (n: number) => ({ role: n % 2 ? 'assistant' as const : 'user' as const, text: 'x'.repeat(4000 + n) });
    const history = Array.from({ length: 40 }, (_, n) => turn(n));
    const base = { skill: null, positioningFallback: false, scopeMaterial: undefined, workspace: [], references: [], question: '问题', history };
    // A question size where the English request with the kept turns is exactly at the cap: measured with its own (longer)
    // rule, Traditional Chinese would have to drop one more turn.
    const size = (replyLocale: 'zh-Hant' | 'en', question: string, h: typeof history) =>
      compareRequestBytes(compareRequest({ ...base, question, history: h, positioningFallback: true, replyLocale }));
    const ownTurns = (replyLocale: 'zh-Hant' | 'en', question: string) => {
      let h = history;
      while (h.length && size(replyLocale, question, h) > FUSION_INPUT_CAP) h = h.slice(1);
      return h.length;
    };
    let edge = history;
    while (edge.length && size('en', '问题', edge) > FUSION_INPUT_CAP) edge = edge.slice(1);
    const question = '问题' + 'y'.repeat(FUSION_INPUT_CAP - size('en', '问题', edge));
    expect(ownTurns('en', question)).not.toBe(ownTurns('zh-Hant', question));
    const kept = (['zh-Hans', 'zh-Hant', 'en'] as const).map(replyLocale => fitHistory({ ...base, question, replyLocale }).history.length);
    expect(new Set(kept).size).toBe(1);
  });

  it('drops the oldest turns until the request fits the per-call cap, never the question', () => {
    const big = 'x'.repeat(30000);
    const parts = { skill: null, positioningFallback: false, scopeMaterial: undefined, workspace: [], references: [], question: '问题',
      replyLocale: 'zh-Hans' as const,
      history: [{ role: 'user' as const, text: big }, { role: 'assistant' as const, text: big }, { role: 'user' as const, text: big },
        { role: 'assistant' as const, text: 'short' }] };
    const fitted = fitHistory(parts);
    expect(fitted.history.length).toBeLessThan(4);
    expect(fitted.history.at(-1)).toEqual({ role: 'assistant', text: 'short' });
    expect(fitted.question).toBe('问题');
    expect(JSON.stringify(fitted.history).length).toBeLessThan(FUSION_INPUT_CAP);
  });
});
