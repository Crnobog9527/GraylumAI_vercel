/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { excerpt, isWritingRequest, pickExamples, requestedType, VOICE_EXAMPLE_CHARS, voiceExamplesNote } from './examples';
import type { VoiceDocumentLabel } from './profile';

const l = (n: number, type: VoiceDocumentLabel['type'], topics: string[]): VoiceDocumentLabel => ({ documentId: `d${n}`, type, topics });
const labels = [l(1, 'post', ['做饭']), l(2, 'post', ['健身']), l(3, 'post', ['健身', '减脂']), l(4, 'script', ['旅行']),
  l(5, 'post', ['理财']), l(6, 'post', ['读书']), l(7, 'article', ['育儿'])];

describe('voice examples (VOICE-2 PR-2, by code)', () => {
  it('only a message that asks for writing gets examples; the type comes from the message', () => {
    expect(isWritingRequest('今天天气怎么样')).toBe(false);
    expect(pickExamples(labels, '今天天气怎么样')).toEqual([]);
    expect(requestedType('写一条小红书')).toBe('post');
    expect(requestedType('帮我写个口播脚本')).toBe('script');
    expect(requestedType('写一篇公众号长文')).toBe('article');
    expect(requestedType('帮我写点东西')).toBeNull();
  });
  it('same type, never the topic of the message, topics differing from each other, at most three', () => {
    // 健身 is this message's topic: d2 and d3 are out; d1, d5, d6 are posts of other topics.
    expect(pickExamples(labels, '写一条关于健身的小红书')).toEqual(['d1', 'd5', 'd6']);
    expect(pickExamples(labels, '帮我写个口播脚本，讲做饭')).toEqual(['d4']);
    // No type asked: any type, still another topic.
    expect(pickExamples(labels, '帮我写点关于做饭的')).toEqual(['d2', 'd4', 'd5']);
  });
  it('topics differing from each other first, then the rest fills up', () => {
    const same = [l(1, 'post', ['健身']), l(2, 'post', ['健身']), l(3, 'post', ['做饭'])];
    expect(pickExamples(same, '写一条帖子讲读书')).toEqual(['d1', 'd3', 'd2']);
    expect(pickExamples([], '写一条帖子')).toEqual([]);
  });
  it('a passage is cut at a sentence end within the limit', () => {
    const long = '第一句话。'.repeat(200);
    const cut = excerpt(long);
    expect([...cut].length).toBeLessThanOrEqual(VOICE_EXAMPLE_CHARS);
    expect(cut.endsWith('。')).toBe(true);
    expect(excerpt('短')).toBe('短');
  });
  it('the note says how to use them and never to copy; nothing at all without a passage', () => {
    const note = voiceExamplesNote([{ text: '哎下班到家都七点了。' }, { text: '' }]);
    expect(note).toContain('<user_voice_examples>\n<example 1>\n哎下班到家都七点了。\n</example 1>\n</user_voice_examples>');
    expect(note).toContain('never copy a sentence');
    expect(note).not.toContain('<example 2>');
    expect(voiceExamplesNote([])).toBe('');
  });
});
