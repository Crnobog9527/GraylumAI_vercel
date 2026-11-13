/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { VoiceDocumentLabel } from './profile';

/*
 * VOICE-2 PR-2: the user's past pieces that go with a loaded writing Skill as voice examples, chosen by code from the labels the
 * voice version saved (0539), never from guessing what the message wants (ENGINEERING 6): they are added only when the model
 * itself loads a Skill flagged "使用用户文风", in that load's result. Type: the kind the user writes most (their own documents
 * say what they write). Topic: never one the current message names, and topics differing from each other. At most three,
 * each cut to a short passage.
 */
export const VOICE_EXAMPLES_MAX = 3;
/** Characters of each passage given to the model. */
export const VOICE_EXAMPLE_CHARS = 600;
const TYPE_ORDER: ReadonlyArray<VoiceDocumentLabel['type']> = ['post', 'article', 'script', 'other'];

/** The type most of the user's labelled documents have (ties in TYPE_ORDER), or null without labels. */
export function dominantType(labels: readonly VoiceDocumentLabel[]): VoiceDocumentLabel['type'] | null {
  const counts = new Map<VoiceDocumentLabel['type'], number>();
  for (const label of labels) counts.set(label.type, (counts.get(label.type) ?? 0) + 1);
  let best: VoiceDocumentLabel['type'] | null = null;
  for (const type of TYPE_ORDER) if ((counts.get(type) ?? 0) > (best ? counts.get(best)! : 0)) best = type;
  return best;
}

const norm = (text: string) => text.toLowerCase().replace(/\s+/g, '');
/** A content filter, not an intent guess: a past piece whose topic the message names could lend the model its facts. */
const sameTopic = (label: VoiceDocumentLabel, message: string) => label.topics.some(topic => norm(message).includes(norm(topic)));
const overlaps = (a: VoiceDocumentLabel, b: VoiceDocumentLabel) => a.topics.some(topic => b.topics.map(norm).includes(norm(topic)));

/** The documents to read as examples, in the order of the labels (the user's preferred documents first, then the newest). */
export function pickExamples(labels: readonly VoiceDocumentLabel[], message: string): string[] {
  const wanted = dominantType(labels);
  const pool = labels.filter(label => label.type === wanted && !sameTopic(label, message));
  const chosen: VoiceDocumentLabel[] = [];
  // First pass: topics differing from those already chosen; second pass fills up when the pool is small.
  for (const strict of [true, false]) {
    for (const label of pool) {
      if (chosen.length >= VOICE_EXAMPLES_MAX) break;
      if (chosen.includes(label) || (strict && chosen.some(other => overlaps(label, other)))) continue;
      chosen.push(label);
    }
  }
  return chosen.map(label => label.documentId);
}

/** A passage cut at a sentence end within the limit when there is one. */
export function excerpt(text: string, limit = VOICE_EXAMPLE_CHARS): string {
  const chars = [...text.trim()];
  if (chars.length <= limit) return chars.join('');
  const head = chars.slice(0, limit).join('');
  const end = Math.max(...['。', '！', '？', '!', '?', '\n', '. '].map(mark => head.lastIndexOf(mark)));
  return end >= limit / 2 ? head.slice(0, end + 1).trim() : head;
}

/** How the passages are to be used, then the passages: data the model reads, never stored in the history. */
export function voiceExamplesText(passages: ReadonlyArray<{ text: string }>): string {
  const kept = passages.map(item => excerpt(item.text)).filter(Boolean);
  if (!kept.length) return '';
  return 'Writing voice examples (host rule): short passages the user wrote in the past, on other topics. Use them only to '
    + 'match how the user writes: rhythm, sentence length, openings, word choice. Never reuse their facts, events or claims, never '
    + 'copy a sentence or a distinctive phrase from them (no run of 12 or more characters the same), and do not mention them.'
    + '\n<user_voice_examples>' + kept.map((text, index) => `\n<example ${index + 1}>\n${text}\n</example ${index + 1}>`).join('')
    + '\n</user_voice_examples>';
}

/** The load_skill result (a JSON object as a string) with the examples added as `writingVoiceExamples`, dropping passages from
 * the end until it fits `maxBytes` (what admission reserved for one load); unchanged when nothing fits or the result is not JSON. */
export function withVoiceExamples(result: string, passages: ReadonlyArray<{ text: string }>, maxBytes: number): string {
  return fitVoiceExamples(result, passages, maxBytes).result;
}
/** The same, also saying which passages (as the model was shown them) went in: PR-3 checks the draft against exactly these. */
export function fitVoiceExamples(result: string, passages: ReadonlyArray<{ text: string }>, maxBytes: number):
  { result: string; shown: string[] } {
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(result) as Record<string, unknown>; } catch { return { result, shown: [] }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { result, shown: [] };
  for (let n = passages.length; n > 0; n--) {
    const text = voiceExamplesText(passages.slice(0, n));
    if (!text) return { result, shown: [] };
    const next = JSON.stringify({ ...parsed, writingVoiceExamples: text });
    if (Buffer.byteLength(JSON.stringify(next)) <= maxBytes) {
      return { result: next, shown: passages.slice(0, n).map(item => excerpt(item.text)).filter(Boolean) };
    }
  }
  return { result, shown: [] };
}
