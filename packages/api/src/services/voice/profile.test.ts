/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { NO_PLATFORM_DIFFERENCE, parseVoiceDocuments, VOICE_LABELS_MAX, voiceLabelsBytes, parseVoiceProfile, VOICE_INSTRUCTIONS, voiceInput, voiceProfile } from './profile';

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
  // Staging 11-14 (#1994 check): the model wrote "file": "1"; every label was dropped and all documents read as 其他.
  it('takes the file number written as a string too, and nothing that is not a number', () => {
    const two = [...material, { documentId: 'd2', filename: null, text: '第二篇' }];
    expect(parseVoiceDocuments(answer({ documents: [{ file: '1', type: 'script', topics: ['菜市场'] },
      { file: ' 2 ', type: 'post', topics: ['跑步'] }] }), two)).toEqual([{ documentId: 'd1', type: 'script', topics: ['菜市场'] },
      { documentId: 'd2', type: 'post', topics: ['跑步'] }]);
    expect(parseVoiceDocuments(answer({ documents: [{ file: 'one', type: 'post', topics: ['x'] }, { file: 1.5, type: 'post' }] }), material))
      .toEqual([{ documentId: 'd1', type: 'other', topics: [] }]);
  });
  it('bounds topics (five, twenty characters) and survives an answer that is not JSON', () => {
    const many = Array.from({ length: 8 }, (_, i) => '话'.repeat(25) + i);
    expect(parseVoiceDocuments(answer({ documents: [{ file: 1, type: 'post', topics: many }] }), material)[0]!.topics)
      .toEqual(Array.from({ length: 5 }, () => '话'.repeat(20)).slice(0, 1));
    expect(parseVoiceDocuments('不是 JSON', material)).toEqual([{ documentId: 'd1', type: 'other', topics: [] }]);
  });
});

describe('labels of a corpus of many short posts (VOICE-2 PR-1 review)', () => {
  it('more than 200 documents with full topics: at most 200 labels, under the 32 KB column limit, never a refused profile', () => {
    const posts = Array.from({ length: 260 }, (_, i) => ({ documentId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      filename: null, text: `第 ${i} 条短帖` }));
    const full = Array.from({ length: 5 }, (_, k) => '话'.repeat(19) + k);
    const labels = parseVoiceDocuments(answer({ documents: posts.map((_p, i) => ({ file: i + 1, type: 'post', topics: full })) }), posts);
    expect(labels.length).toBe(VOICE_LABELS_MAX);
    expect(labels[0]).toEqual({ documentId: posts[0]!.documentId, type: 'post', topics: full });
    expect(labels.at(-1)!.topics).toEqual([]);
    // What Postgres stores: jsonb text puts a space after every ':' and ','.
    const stored = JSON.stringify(labels).replace(/([:,])/g, '$1 ');
    expect(Buffer.byteLength(stored)).toBeLessThanOrEqual(32768);
    expect(voiceLabelsBytes(labels)).toBeGreaterThanOrEqual(Buffer.byteLength(stored));
    // Every label still passes the database's shape rules: at most 5 topics of at most 20 characters, a known type.
    expect(labels.every(l => l.topics.length <= 5 && l.topics.every(t => [...t].length <= 20))).toBe(true);
  });
});
