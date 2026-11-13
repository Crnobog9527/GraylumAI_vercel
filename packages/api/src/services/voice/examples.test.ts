/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { dominantType, excerpt, pickExamples, VOICE_EXAMPLE_CHARS, voiceExamplesText, withVoiceExamples } from './examples';
import type { VoiceDocumentLabel } from './profile';

const l = (n: number, type: VoiceDocumentLabel['type'], topics: string[]): VoiceDocumentLabel => ({ documentId: `d${n}`, type, topics });
const labels = [l(1, 'post', ['做饭']), l(2, 'post', ['健身']), l(3, 'post', ['健身', '减脂']), l(4, 'script', ['旅行']),
  l(5, 'post', ['理财']), l(6, 'post', ['读书']), l(7, 'article', ['育儿'])];

describe('voice examples (VOICE-2 PR-2, by code, no intent guessing)', () => {
  it('the type is the one the user writes most, from their own labels', () => {
    expect(dominantType(labels)).toBe('post');
    expect(dominantType([l(1, 'script', []), l(2, 'script', []), l(3, 'post', [])])).toBe('script');
    expect(dominantType([l(1, 'article', []), l(2, 'post', [])])).toBe('post');
    expect(dominantType([])).toBeNull();
  });
  it('that type, never a topic the message names, topics differing from each other, at most three', () => {
    // 健身 is named by the message: d2 and d3 are out; d1, d5, d6 are posts of other topics.
    expect(pickExamples(labels, '写一条关于健身的小红书')).toEqual(['d1', 'd5', 'd6']);
    // Whatever the message is: the choice never depends on guessing what it asks for.
    expect(pickExamples(labels, '今天天气怎么样')).toEqual(['d1', 'd2', 'd5']);
    expect(pickExamples([], '写一条帖子')).toEqual([]);
  });
  it('topics differing from each other first, then the rest fills up', () => {
    const same = [l(1, 'post', ['健身']), l(2, 'post', ['健身']), l(3, 'post', ['做饭'])];
    expect(pickExamples(same, '讲读书')).toEqual(['d1', 'd3', 'd2']);
  });
  it('a passage is cut at a sentence end within the limit', () => {
    const cut = excerpt('第一句话。'.repeat(200));
    expect([...cut].length).toBeLessThanOrEqual(VOICE_EXAMPLE_CHARS);
    expect(cut.endsWith('。')).toBe(true);
    expect(excerpt('短')).toBe('短');
  });
  it('the text says how to use them and never to copy; nothing at all without a passage', () => {
    const text = voiceExamplesText([{ text: '哎下班到家都七点了。' }, { text: '' }]);
    expect(text).toContain('<user_voice_examples>\n<example 1>\n哎下班到家都七点了。\n</example 1>\n</user_voice_examples>');
    expect(text).toContain('never copy a sentence');
    expect(text).not.toContain('<example 2>');
    expect(voiceExamplesText([])).toBe('');
  });
  it('added to a load result within the bytes reserved for one load, dropping passages from the end', () => {
    const result = JSON.stringify({ name: 'post-writer', instructions: '写' });
    const passages = [{ text: '甲'.repeat(500) }, { text: '乙'.repeat(500) }, { text: '丙'.repeat(500) }];
    expect(JSON.parse(withVoiceExamples(result, passages, 100_000)).writingVoiceExamples).toContain('丙');
    const tight = withVoiceExamples(result, passages, 4800);
    expect(Buffer.byteLength(JSON.stringify(tight))).toBeLessThanOrEqual(4800);
    expect(JSON.parse(tight).writingVoiceExamples).toContain('甲');
    expect(JSON.parse(tight).writingVoiceExamples).not.toContain('丙');
    expect(withVoiceExamples(result, passages, 10)).toBe(result);
    expect(withVoiceExamples(result, [], 100_000)).toBe(result);
    expect(withVoiceExamples('not json', passages, 100_000)).toBe('not json');
  });
});
