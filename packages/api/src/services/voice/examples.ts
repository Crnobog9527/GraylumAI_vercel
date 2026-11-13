/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { VoiceDocumentLabel } from './profile';

/*
 * VOICE-2 PR-2: which of the user's past pieces go with a writing request as voice examples, chosen by code (no model call).
 * Same type as what is asked for, a different topic (so the model has no content to copy), topics differing from each other,
 * at most three, each cut to a short passage. A message that does not ask for writing gets none.
 */
export const VOICE_EXAMPLES_MAX = 3;
/** Characters of each passage given to the model. */
export const VOICE_EXAMPLE_CHARS = 600;

const WRITING = /写|改写|润色|文案|稿|帖|脚本|口播|标题|开头|结尾|draft|write|rewrite|caption|post|script|thread|copy/i;
const TYPES: Array<[VoiceDocumentLabel['type'], RegExp]> = [
  ['script', /口播|视频|脚本|分镜|拍摄|vlog|script|video|reel|tiktok|抖音|youtube/i],
  ['article', /长文|文章|公众号|博客|专栏|newsletter|article|blog|essay/i],
  ['post', /帖|文案|小红书|微博|推文|朋友圈|笔记|caption|post|tweet|thread|instagram|threads|\bx\b/i],
];

export const isWritingRequest = (message: string) => WRITING.test(message);
/** The type the message asks for, or null when it does not say. */
export function requestedType(message: string): VoiceDocumentLabel['type'] | null {
  return TYPES.find(([, pattern]) => pattern.test(message))?.[0] ?? null;
}

const norm = (text: string) => text.toLowerCase().replace(/\s+/g, '');
/** A label's topic is the current one when the message mentions it. */
const sameTopic = (label: VoiceDocumentLabel, message: string) => label.topics.some(topic => norm(message).includes(norm(topic)));
const overlaps = (a: VoiceDocumentLabel, b: VoiceDocumentLabel) => a.topics.some(topic => b.topics.map(norm).includes(norm(topic)));

/** The documents to read as examples, in the order of the labels (the user's preferred documents first, then the newest). */
export function pickExamples(labels: readonly VoiceDocumentLabel[], message: string): string[] {
  if (!isWritingRequest(message)) return [];
  const wanted = requestedType(message);
  const pool = labels.filter(label => (wanted ? label.type === wanted : true) && !sameTopic(label, message));
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

/** The examples as the current message's note: data the model reads, never instructions, and never stored in the history. */
export function voiceExamplesNote(passages: ReadonlyArray<{ text: string }>): string {
  const kept = passages.map(item => excerpt(item.text)).filter(Boolean);
  if (!kept.length) return '';
  return '\n\nWriting voice examples (host rule): below are short passages the user wrote in the past, chosen because their '
    + 'topics differ from this request. Use them only if you write content after loading a writing Skill, and only to match how '
    + 'the user writes: rhythm, sentence length, openings, word choice. Never reuse their facts, events or claims, never copy a '
    + 'sentence or a distinctive phrase from them (no run of 12 or more characters the same), and do not mention them.'
    + '\n<user_voice_examples>' + kept.map((text, index) => `\n<example ${index + 1}>\n${text}\n</example ${index + 1}>`).join('')
    + '\n</user_voice_examples>';
}
