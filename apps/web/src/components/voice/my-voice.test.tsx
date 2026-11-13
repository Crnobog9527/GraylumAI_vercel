/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { canClearRequestId, fromForm, generationJustEnded, toForm, topicsFromText, voiceErrorMessage, type VoiceState, type VoiceVersion } from '@/lib/voice/format';
import { MyVoiceView, type MyVoiceViewProps } from './my-voice-view';

const profile = { tone: '像跟朋友唠嗑', sentenceLength: '短句多', openings: '先吐槽', stance: '', phrases: ['咋整'], avoid: ['家人们'],
  platforms: '', samples: ['哎下班到家都七点了，咋整。', '一口锅搞定呗。'] };
const version = (status: VoiceVersion['status'], extra: Partial<VoiceVersion> = {}): VoiceVersion => ({ id: status, version: 1,
  status, profile: ['draft', 'confirmed'].includes(status) ? profile : null, failure: null, createdAt: '', confirmedAt: null,
  sources: [{ documentId: 'd1', filename: '旧笔记.md' }], ...extra });
const base: VoiceState = { enabled: true, revision: 1, needsUpdate: false, confirmed: null, latest: null,
  documents: [{ id: 'd1', filename: '旧笔记.md', textBytes: 3000, preferred: false }] };
const noop = () => undefined;
const render = (state: Partial<VoiceState> = {}, props: Partial<MyVoiceViewProps> = {}) => renderToStaticMarkup(<MyVoiceView
  state={{ ...base, ...state }} preferred={[]} busy={false} generating={false} onTogglePreferred={noop} onGenerate={noop}
  onToggleEnabled={noop} onConfirm={noop} onDelete={noop} onOpenDocuments={noop} {...props} />);

describe('MyVoiceView', () => {
  it('without authored documents points to 我的文档 and offers no generation', () => {
    const html = render({ documents: [] });
    expect(html).toContain('去上传文章');
    expect(html).not.toContain('>学习我的文风</button>');
  });
  it('lists the authored documents with "最像我" and says it is billed by use, with no estimate', () => {
    const html = render();
    expect(html).toContain('旧笔记.md');expect(html).toContain('最像我');
    expect(html).toContain('按实际用量扣积分');
    expect(html).not.toMatch(/预计|约\s*\d+\s*积分/);
  });
  it('a draft opens as an editable form with 确认使用', () => {
    const html = render({ latest: version('draft') });
    expect(html).toContain('待你确认');expect(html).toContain('确认使用');expect(html).toContain('<textarea');
  });
  it('the confirmed profile is shown read-only with its passages', () => {
    const html = render({ confirmed: version('confirmed') });
    expect(html).toContain('当前使用的文风画像');expect(html).toContain('<blockquote>哎下班到家都七点了，咋整。</blockquote>');expect(html).toContain('<blockquote>一口锅搞定呗。</blockquote>');
    expect(html).toContain('重新学习');
  });
  it('the confirmed profile cannot be edited while a newer result is pending (#1262 review)', () => {
    expect(render({ confirmed: version('confirmed') })).toContain('>修改</button>');
    for (const latest of [version('generating'), { ...version('draft'), version: 2 }]) {
      const html = render({ confirmed: version('confirmed'), latest });
      expect(html).toContain('当前使用的文风画像');
      expect(html).not.toContain('>修改</button>');
      expect(html).toContain('>删除</button>'); // deleting the current profile stays possible
      expect(html).toContain('先处理它');
    }
    expect(render({ confirmed: version('confirmed'), latest: version('failed') })).toContain('>修改</button>');
  });
  it('shows generating, stale, failure, switched off and needs update', () => {
    expect(render({ latest: version('generating') })).toContain('正在读你的文章');
    expect(render({ latest: version('stale') })).toContain(voiceErrorMessage('VOICE_STALE'));
    expect(render({ latest: version('failed', { failure: 'VOICE_INSUFFICIENT_CREDITS' }) })).toContain('积分不够');
    expect(render({ enabled: false, confirmed: version('confirmed') })).toContain('已关闭');
    expect(render({ needsUpdate: true, confirmed: version('confirmed') })).toContain('文档有变化');
  });
});

describe('voice form', () => {
  it('round-trips and requires two passages', () => {
    expect(fromForm(toForm(profile))).toEqual(profile);
    expect(fromForm({ ...toForm(profile), samples: ['', ' ', ''] })).toBeNull();
    expect(fromForm({ ...toForm(profile), samples: ['只有一段', '', ''] })).toBeNull();
    expect(fromForm({ ...toForm(profile), phrases: ' 咋整 \n\n搞定 ' })?.phrases).toEqual(['咋整', '搞定']);
  });
  it('maps unknown errors to a plain sentence', () => {
    expect(voiceErrorMessage(new Error('boom'))).toBe('暂时无法完成，请稍后再试。');
  });
});

describe('kept request id (review P1)', () => {
  it('is dropped only after a fresh read shows no generation', () => {
    expect(canClearRequestId(false, base, false)).toBe(false); // cached state from before the paid call
    expect(canClearRequestId(true, undefined, false)).toBe(false);
    expect(canClearRequestId(true, { ...base, latest: version('generating') }, false)).toBe(false);
    expect(canClearRequestId(true, base, true)).toBe(false);
    expect(canClearRequestId(true, base, false)).toBe(true);
  });
});

describe('balance refresh after learning', () => {
  it('refreshes the balance only when a run leaves "generating"', () => {
    expect(generationJustEnded('generating', 'draft')).toBe(true);
    expect(generationJustEnded('generating', 'failed')).toBe(true);
    expect(generationJustEnded('generating', 'generating')).toBe(false);
    expect(generationJustEnded(undefined, 'draft')).toBe(false);
    expect(generationJustEnded('draft', 'confirmed')).toBe(false);
  });
});

// VOICE-2 PR-4: the writing stats (by code, free) and each document's type and topics, which the user may correct.
describe('MyVoiceView: 文风 2.0 data', () => {
  const stats = { documents: 3, sentences: 40, avgSentenceChars: 14, shortSentenceShare: 30, longSentenceShare: 10,
    openings: { question: 25, number: 5, firstPerson: 40 }, perThousandChars: { exclamation: 3.5, question: 2, ellipsis: 1, emoji: 0.5 },
    avgParagraphsPerDocument: 3, avgParagraphChars: 60, listShare: 10 };
  const labelled = version('confirmed', { stats, documents: [{ documentId: 'd1', type: 'post', topics: ['做饭', '下班'], edited: true }] });
  it('shows the stats as numbers, said to cost nothing', () => {
    const html = render({ confirmed: labelled });
    expect(html).toContain('写作数据');expect(html).toContain('平均每句 14 字');expect(html).toContain('问句 25%');
    expect(html).toContain('不扣积分');
  });
  it('lists each read document with its type and topics; 修改 only when the page can save', () => {
    const html = render({ confirmed: labelled }, { onSetLabel: async () => true });
    expect(html).toContain('旧笔记.md');expect(html).toContain('社媒短帖 · 做饭、下班（已修改）');expect(html).toContain('>修改</button>');
    expect(render({ confirmed: labelled })).not.toContain('社媒短帖 · 做饭、下班（已修改）</span><button');
  });
  it('a version made before 文风 2.0 shows neither', () => {
    const html = render({ confirmed: version('confirmed') });
    expect(html).not.toContain('写作数据');expect(html).not.toContain('每篇文章的类型和话题');
  });
  it('topics as typed: commas, 顿号 or spaces; at most five of at most twenty characters', () => {
    expect(topicsFromText(' 做饭，下班、 健身,做饭 ')).toEqual(['做饭', '下班', '健身']);
    expect(topicsFromText('a b c d e f')).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(topicsFromText('话'.repeat(30))).toEqual(['话'.repeat(20)]);
  });
});
