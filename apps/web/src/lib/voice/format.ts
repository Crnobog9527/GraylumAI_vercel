/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/** VOICE「我的文风」(Master Plan 5.3): the profile as the page shows and edits it. */
export type VoiceProfile = { tone: string; sentenceLength: string; openings: string; stance: string; phrases: string[];
  avoid: string[]; platforms: string; samples: string[] };
export type VoiceVersion = { id: string; version: number;
  status: 'generating' | 'draft' | 'confirmed' | 'superseded' | 'stale' | 'failed';
  profile: VoiceProfile | null; failure: string | null; createdAt: string; confirmedAt: string | null;
  sources: Array<{ documentId: string; filename: string | null }> };
export type VoiceDocument = { id: string; filename: string | null; textBytes: number; preferred: boolean };
export type VoiceState = { enabled: boolean; revision: number; needsUpdate: boolean; confirmed: VoiceVersion | null;
  latest: VoiceVersion | null; documents: VoiceDocument[] };

export const TEXT_FIELDS = [
  ['tone', '语气'], ['sentenceLength', '句子长短'], ['openings', '开头方式'], ['stance', '观点强弱'], ['platforms', '各平台差异'],
] as const;
export const LIST_FIELDS = [['phrases', '常用表达'], ['avoid', '不会用的表达']] as const;
export const MAX_PREFERRED = 20;

/** The editable form: list fields are one item per line. */
export type VoiceForm = Record<(typeof TEXT_FIELDS)[number][0], string> & Record<(typeof LIST_FIELDS)[number][0], string>
  & { samples: string[] };
export function toForm(profile: VoiceProfile): VoiceForm {
  return { tone: profile.tone, sentenceLength: profile.sentenceLength, openings: profile.openings, stance: profile.stance,
    platforms: profile.platforms, phrases: profile.phrases.join('\n'), avoid: profile.avoid.join('\n'),
    samples: [...profile.samples, '', '', ''].slice(0, 3) };
}
const lines = (value: string) => value.split('\n').map(line => line.trim()).filter(Boolean);
/** Back to the stored shape with the server's bounds; null when fewer than two passages are left (2–3 are required). */
export function fromForm(form: VoiceForm): VoiceProfile | null {
  const samples = form.samples.map(sample => sample.trim()).filter(Boolean).map(sample => sample.slice(0, 400));
  if (samples.length < 2) return null;
  const text = (value: string) => value.trim().slice(0, 300);
  return { tone: text(form.tone), sentenceLength: text(form.sentenceLength), openings: text(form.openings),
    stance: text(form.stance), platforms: text(form.platforms),
    phrases: lines(form.phrases).map(item => item.slice(0, 80)).slice(0, 12),
    avoid: lines(form.avoid).map(item => item.slice(0, 80)).slice(0, 12), samples };
}

const MESSAGES: Record<string, string> = {
  VOICE_NO_CORPUS: '还没有「我本人写的」文档。先在「我的文档」上传你自己写的文章，用途选「我本人写的」。',
  VOICE_GENERATION_BUSY: '正在学习你的文风，请等这一次完成。',
  VOICE_INSUFFICIENT_CREDITS: '积分不够这一次学习，充值后再试。这次没有扣积分。',
  VOICE_FORMAT_INVALID: '这次没有整理出能用的文风画像，请再试一次。',
  VOICE_PROVIDER_REJECTED: '模型这次没有返回结果，请稍后再试。',
  VOICE_RATE_LIMITED: '操作太频繁，请稍后再试。',
  VOICE_PAUSED: '系统暂时停止了新任务，请稍后再试。',
  VOICE_INTERRUPTED: '上一次学习没有完成就中断了，可以重新学习。',
  VOICE_RESULT_PENDING: '结果还在核对，请稍后刷新查看。',
  VOICE_REVISION_CONFLICT: '页面内容已经更新，请刷新后再操作。',
  VOICE_STALE: '生成期间你的文档有变化，这一版不能使用，请重新学习。',
  VOICE_VERSION_GONE: '这一版已经删除（用到的文档被删除了）。',
  LIBRARY_ACCOUNT_CLOSED: '账号已注销，不能再操作。',
};
const FALLBACK = '暂时无法完成，请稍后再试。';
export function voiceErrorCode(error: unknown): string | null {
  const message = typeof error === 'string' ? error : error instanceof Error ? error.message : null;
  return message && /^(VOICE|LIBRARY)_[A-Z_]+$/.test(message) ? message : null;
}
export function voiceErrorMessage(error: unknown): string {
  const code = voiceErrorCode(error);
  return (code && MESSAGES[code]) || FALLBACK;
}
