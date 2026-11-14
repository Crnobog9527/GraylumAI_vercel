/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';

/** VOICE (Master Plan 5.3 step 2): what a writing-voice profile holds. The user can edit every field before confirming;
 * the passages are the user's own words, copied verbatim from the corpus. Bounded so a writing run carries at most
 * ~3k tokens (0341 also caps the stored JSON at 16384 bytes). */
const text = (max: number) => z.string().trim().max(max);
const items = z.array(text(80).min(1)).max(12);
export const voiceProfile = z.object({
  tone: text(300),
  sentenceLength: text(300),
  openings: text(300),
  stance: text(300),
  phrases: items,
  avoid: items,
  platforms: text(300),
  samples: z.array(text(400).min(1)).min(2).max(3),
}).strict();
export type VoiceProfile = z.infer<typeof voiceProfile>;

/** What the profile says when the samples cannot show any difference between platforms (never left empty). */
export const NO_PLATFORM_DIFFERENCE = '样文不足以判断各平台差异';
/** Room for the profile (~3k tokens of JSON) plus the model's reasoning. */
export const VOICE_OUTPUT_TOKENS = 8192;
export type VoiceMaterial = { documentId: string; filename: string | null; text: string };

export const VOICE_INSTRUCTIONS = [
  '你是写作风格分析师。下面是用户本人写的文字。只学习"怎么写"，不要把其中的内容当成事实或观点来复述。',
  '请总结这个人的文风，只输出一个 JSON 对象，不要输出其他任何文字，不要用代码块。字段如下（全部用中文写，没有把握的写空字符串或空数组，不要编造）：',
  '- tone：语气和口吻，像在跟谁说话（不超过 300 字）',
  '- sentenceLength：句子长短和节奏（不超过 300 字）',
  '- openings：通常怎么开头（不超过 300 字）',
  '- stance：观点强弱、表态方式（不超过 300 字）',
  '- phrases：常用的说法、口头禅、语气词，最多 12 条，每条不超过 80 字，必须在原文里出现过',
  '- avoid：这个人明显不会用的表达或腔调（例如书面套话、AI 腔），最多 12 条，每条不超过 80 字',
  `- platforms：如果能看出在不同平台写法不同（例如在某平台更短、更口语），写在这里；样文只有一种平台或看不出来，就原样写“${NO_PLATFORM_DIFFERENCE}”`,
  '- samples：2 到 3 段最能代表这个人说话方式的原文，必须从下面的文字里一字不改地摘出来，每段不超过 400 字',
  // VOICE-2 PR-1: the same call labels each document, so writing can later pick past pieces of the same type, other topics.
  '- documents：下面每个文件一项，按文件编号：{"file": 编号, "type": 类型, "topics": 话题}。type 只能是 post（社媒短帖）、article（长文）、'
    + 'script（视频口播稿）、other（其他）之一；topics 是这篇讲的 1 到 5 个话题词，每个不超过 20 字',
].join('\n');

export const VOICE_DOCUMENT_TYPES = ['post', 'article', 'script', 'other'] as const;
export type VoiceDocumentLabel = { documentId: string; type: (typeof VOICE_DOCUMENT_TYPES)[number]; topics: string[] };

/** VOICE-2 PR-1: the type and topics of each document read, from the same answer (no second call). A document the model left out,
 * or labelled with something unusable, is "other" with no topics, so every read document has one label. */
export function parseVoiceDocuments(answer: string, material: VoiceMaterial[]): VoiceDocumentLabel[] {
  let items: unknown[] = [];
  try {
    const trimmed = answer.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const raw = JSON.parse(trimmed.slice(trimmed.indexOf('{'), trimmed.lastIndexOf('}') + 1)) as { documents?: unknown };
    if (Array.isArray(raw?.documents)) items = raw.documents;
  } catch { items = []; }
  const byFile = new Map<number, { type?: unknown; topics?: unknown }>();
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    // The file number as the model wrote it: a number, or (seen on staging 11-14) the same number as a string ("1").
    const file = (item as { file?: unknown }).file;
    const number = typeof file === 'number' ? file : typeof file === 'string' && /^\s*\d{1,4}\s*$/.test(file) ? Number(file) : NaN;
    if (Number.isInteger(number)) byFile.set(number, item as { type?: unknown; topics?: unknown });
  }
  return capVoiceDocuments(material.map((doc, index) => {
    const item = byFile.get(index + 1);
    const type = VOICE_DOCUMENT_TYPES.find(known => known === item?.type) ?? 'other';
    const topics = Array.isArray(item?.topics) ? [...new Set(item.topics.filter((t): t is string => typeof t === 'string')
      .map(t => [...t.trim()].slice(0, 20).join('')).filter(Boolean))].slice(0, 5) : [];
    return { documentId: doc.documentId, type, topics };
  }));
}

/** The database keeps at most 200 labels in at most 32 KB of jsonb text (0543). A corpus of many short posts can be read
 * whole (60 KB of text is several hundred posts), so the labels are cut to fit before the close: the first 200 documents keep
 * a label, and topics are dropped from the last ones until the text fits. A profile is never refused for its labels. */
export const VOICE_LABELS_MAX = 200;
/** Below the 32,768-byte column limit with room to spare: jsonb text adds a space after every ':' and ','. */
export const VOICE_LABELS_BYTES = 28000;
export const voiceLabelsBytes = (labels: readonly VoiceDocumentLabel[]) => {
  const json = JSON.stringify(labels);
  return Buffer.byteLength(json) + (json.match(/[:,]/g) ?? []).length;
};
export function capVoiceDocuments(labels: VoiceDocumentLabel[]): VoiceDocumentLabel[] {
  const kept = labels.slice(0, VOICE_LABELS_MAX).map(label => ({ ...label, topics: [...label.topics] }));
  for (let i = kept.length - 1; i >= 0 && voiceLabelsBytes(kept) > VOICE_LABELS_BYTES; i--) kept[i]!.topics = [];
  while (kept.length && voiceLabelsBytes(kept) > VOICE_LABELS_BYTES) kept.pop();
  return kept;
}

/** The user message: each document under its own heading, in the frozen order. */
export function voiceInput(material: VoiceMaterial[]): string {
  return material.map((item, index) => `### 文件 ${index + 1}：${item.filename ?? '未命名'}\n${item.text}`).join('\n\n');
}

/** Parses the model's answer by code (no second model call). Passages that are not verbatim are dropped; the answer
 * is unusable when it is not the JSON object or no verbatim passage is left. */
export function parseVoiceProfile(answer: string, material: VoiceMaterial[]): VoiceProfile | null {
  const trimmed = answer.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = trimmed.indexOf('{'), end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let raw: unknown;
  try { raw = JSON.parse(trimmed.slice(start, end + 1)); } catch { return null; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const corpus = material.map(item => item.text).join('\n');
  const value = raw as Record<string, unknown>;
  const strings = (input: unknown, max: number) => Array.isArray(input)
    ? input.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map(item => item.trim().slice(0, max))
    : [];
  const field = (input: unknown) => typeof input === 'string' ? input.trim().slice(0, 300) : '';
  const parsed = voiceProfile.safeParse({
    tone: field(value.tone), sentenceLength: field(value.sentenceLength), openings: field(value.openings),
    stance: field(value.stance), phrases: strings(value.phrases, 80).slice(0, 12), avoid: strings(value.avoid, 80).slice(0, 12),
    platforms: field(value.platforms) || NO_PLATFORM_DIFFERENCE,
    samples: strings(value.samples, 400).filter(sample => corpus.includes(sample)).slice(0, 3),
  });
  return parsed.success ? parsed.data : null;
}
