/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { applyRewrites, findOverlaps, OVERLAP_MAX_SENTENCES, rewriteInput, sentencesOf } from './overlap';

const old = ['哎下班到家都七点了，咋整呢，一口锅搞定呗。冰箱里还剩半颗白菜和两个鸡蛋。'];

describe('overlap with the past passages (VOICE-2 PR-3, Owner: 12 characters the same)', () => {
  it('finds only sentences sharing a run of 12 characters, whitespace ignored', () => {
    const draft = '周末去爬山。哎下班到家都七点了， 咋整呢，真累！今天也是七点到家。';
    const found = findOverlaps(draft, old);
    expect(found.map(item => item.text)).toEqual(['哎下班到家都七点了， 咋整呢，真累！']);
    // 11 characters the same is not "too similar".
    expect(findOverlaps('下班到家都七点了，咋整', old)).toHaveLength(0);
    expect(findOverlaps(draft, [])).toEqual([]);
  });
  it('splits at end marks and line breaks, keeping each sentence\'s place', () => {
    const text = 'a。\n- b！c';
    expect(sentencesOf(text).map(item => [item.start, item.text])).toEqual([[0, 'a。'], [3, '- b！'], [7, 'c']]);
  });
  it('sends at most a dozen sentences, numbered, with the old writing to avoid', () => {
    const many = Array.from({ length: 20 }, () => '哎下班到家都七点了，咋整呢。').join('');
    const found = findOverlaps(many, old);
    expect(found).toHaveLength(OVERLAP_MAX_SENTENCES);
    expect(rewriteInput(found.slice(0, 2), old)).toBe(`<old_writing>\n${old[0]}\n</old_writing>\n<sentences>\n1. 哎下班到家都七点了，咋整呢。\n2. 哎下班到家都七点了，咋整呢。\n</sentences>`);
  });
  it('replaces only the overlapping sentences, only with rewrites that no longer overlap', () => {
    const draft = '开头一句。哎下班到家都七点了，咋整呢，一口锅。中间一句。冰箱里还剩半颗白菜和两个鸡蛋的时候。结尾。';
    const found = findOverlaps(draft, old);
    expect(found).toHaveLength(2);
    // The second rewrite still repeats 12 characters: it is dropped and that sentence stays as it was.
    const answer = JSON.stringify({ 1: '回到家天都黑了，晚饭就交给一口锅。', 2: '冰箱里还剩半颗白菜和两个鸡蛋呢。' });
    const out = applyRewrites(draft, found, answer, old);
    expect(out).toEqual({ text: '开头一句。回到家天都黑了，晚饭就交给一口锅。中间一句。冰箱里还剩半颗白菜和两个鸡蛋的时候。结尾。', revised: 1 });
  });
  it('keeps the draft when the answer is not the object, or a rewrite is empty', () => {
    const draft = '哎下班到家都七点了，咋整呢。';
    const found = findOverlaps(draft, old);
    expect(applyRewrites(draft, found, '好的，改好了', old)).toEqual({ text: draft, revised: 0 });
    expect(applyRewrites(draft, found, '{"1":"  "}', old)).toEqual({ text: draft, revised: 0 });
    expect(applyRewrites(draft, found, '```json\n{"1":"回家晚了就简单吃。"}\n```', old)).toEqual({ text: '回家晚了就简单吃。', revised: 1 });
  });
});
