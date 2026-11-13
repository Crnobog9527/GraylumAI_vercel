/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { NO_PLATFORM_DIFFERENCE, parseVoiceDocuments, parseVoiceProfile, VOICE_INSTRUCTIONS, voiceInput, voiceProfile } from './profile';

const material = [{ documentId: 'd1', filename: '旧笔记.md', text: '哎下班到家都七点了，咋整。\n一口锅搞定呗。' }];
const both = ['哎下班到家都七点了，咋整。', '一口锅搞定呗。'];
const answer = (extra: Record<string, unknown> = {}) => JSON.stringify({ tone: '像跟朋友唠嗑', sentenceLength: '短句多',
  openings: '先吐槽一句', stance: '温和', phrases: ['咋整', '搞定'], avoid: ['家人们'], platforms: '',
  samples: both, ...extra });

describe('parseVoiceProfile', () => {
  it('accepts the JSON object, also inside a code fence', () => {
    expect(parseVoiceProfile(answer(), material)?.tone).toBe('像跟朋友唠嗑');
    expect(parseVoiceProfile('```json\n' + answer() + '\n```', material)?.samples).toEqual(both);
  });
  it('drops passages that are not verbatim and refuses when fewer than two are left', () => {
    expect(parseVoiceProfile(answer({ samples: ['编出来的一句', ...both] }), material)?.samples).toEqual(both);
    expect(parseVoiceProfile(answer({ samples: ['编出来的一句', '一口锅搞定呗。'] }), material)).toBeNull();
    expect(parseVoiceProfile(answer({ samples: ['编出来的一句'] }), material)).toBeNull();
  });
  it('never leaves the platform differences empty: says the samples cannot show them (acceptance step 3)', () => {
    expect(parseVoiceProfile(answer({ platforms: '' }), material)?.platforms).toBe(NO_PLATFORM_DIFFERENCE);
    expect(parseVoiceProfile(answer({ platforms: undefined }), material)?.platforms).toBe(NO_PLATFORM_DIFFERENCE);
    expect(parseVoiceProfile(answer({ platforms: '小红书更短' }), material)?.platforms).toBe('小红书更短');
    expect(VOICE_INSTRUCTIONS).toContain(NO_PLATFORM_DIFFERENCE);
  });
  it('refuses anything that is not the object', () => {
    expect(parseVoiceProfile('好的，这是文风总结', material)).toBeNull();
    expect(parseVoiceProfile('[1,2]', material)).toBeNull();
  });
  it('bounds every field', () => {
    const parsed = parseVoiceProfile(answer({ tone: '长'.repeat(900), phrases: Array.from({ length: 30 }, (_, i) => '说法' + i) }), material);
    expect(parsed?.tone.length).toBe(300);
    expect(parsed?.phrases).toHaveLength(12);
    expect(voiceProfile.safeParse(parsed).success).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(parsed))).toBeLessThan(16384);
  });
});

describe('voiceInput', () => {
  it('puts each document under its own heading in order', () => {
    expect(voiceInput([...material, { documentId: 'd2', filename: null, text: 'B' }]))
      .toBe('### 文件 1：旧笔记.md\n哎下班到家都七点了，咋整。\n一口锅搞定呗。\n\n### 文件 2：未命名\nB');
  });
});

describe('parseVoiceDocuments (VOICE-2 PR-1)', () => {
  const two = [...material, { documentId: 'd2', filename: null, text: '第二篇' }];
  it('labels every document read, by file number; an unknown type or a missing entry is other', () => {
    const labels = parseVoiceDocuments(answer({ documents: [{ file: 2, type: 'script', topics: ['做饭', '做饭', ' 下班 '] },
      { file: 1, type: 'tweet', topics: 'x' }] }), two);
    expect(labels).toEqual([{ documentId: 'd1', type: 'other', topics: [] }, { documentId: 'd2', type: 'script', topics: ['做饭', '下班'] }]);
    expect(VOICE_INSTRUCTIONS).toContain('documents');
  });
  it('bounds topics (five, twenty characters) and survives an answer that is not JSON', () => {
    const many = Array.from({ length: 8 }, (_, i) => '话'.repeat(25) + i);
    expect(parseVoiceDocuments(answer({ documents: [{ file: 1, type: 'post', topics: many }] }), material)[0]!.topics)
      .toEqual(Array.from({ length: 5 }, () => '话'.repeat(20)).slice(0, 1));
    expect(parseVoiceDocuments('不是 JSON', material)).toEqual([{ documentId: 'd1', type: 'other', topics: [] }]);
  });
});
