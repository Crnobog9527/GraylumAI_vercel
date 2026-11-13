/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/*
 * VOICE-2 PR-1: writing stats computed by code from the documents a profile was learned from (no model call, no charge).
 * Shown on the voice page and, from PR-2, told to the writer as numbers ("平均每句 14 字，三成句子以问句开头"). Characters are
 * counted as Unicode code points without whitespace, so Chinese and English text are measured the same way.
 */
export type VoiceStats = {
  documents: number; sentences: number;
  /** Average characters per sentence, and the share (0-100) of short (at most 10) and long (at least 30) sentences. */
  avgSentenceChars: number; shortSentenceShare: number; longSentenceShare: number;
  /** How paragraphs open, as shares (0-100): a question, a number or list marker, the first person ("我"/"I"). */
  openings: { question: number; number: number; firstPerson: number };
  /** Marks per 1,000 characters. */
  perThousandChars: { exclamation: number; question: number; ellipsis: number; emoji: number };
  avgParagraphsPerDocument: number; avgParagraphChars: number;
  /** Share (0-100) of paragraphs that are list items. */
  listShare: number;
};

// An English full stop ends a sentence only after a letter, so "1. 先切菜" stays one sentence.
const SENTENCE_END = /(?<=[。！？!?…])|(?<=\p{L}[.])\s+|\n+/u;
/** A sentence has at least one letter or digit: a lone emoji or mark left after a split is not counted. */
const WORDY = /[\p{L}\p{N}]/u;
const EMOJI = /\p{Extended_Pictographic}/gu;
const LIST_ITEM = /^\s*(?:[-*•·]|\d{1,2}[.、)）]|[一二三四五六七八九十]{1,2}[、.])\s*/u;
const NUMBER_START = /^\s*(?:\d|[一二三四五六七八九十]{1,2}[、.个条种])/u;
const FIRST_PERSON = /^\s*(?:我|咱|I\b|I'm|I've|My\b|We\b)/u;

const chars = (text: string) => [...text.replace(/\s+/g, '')].length;
const share = (part: number, whole: number) => (whole ? Math.round((part / whole) * 100) : 0);
const per1000 = (count: number, total: number) => (total ? Math.round((count / total) * 10000) / 10 : 0);
const count = (text: string, pattern: RegExp) => (text.match(pattern) ?? []).length;

export function computeVoiceStats(texts: string[]): VoiceStats {
  const docs = texts.filter(text => text.trim().length > 0);
  const paragraphs = docs.flatMap(text => text.split(/\n\s*\n|\n/).map(p => p.trim()).filter(Boolean));
  const sentences = docs.flatMap(text => text.split(SENTENCE_END).map(s => s.trim()).filter(s => WORDY.test(s)));
  const lengths = sentences.map(chars);
  const total = docs.reduce((sum, text) => sum + chars(text), 0);
  const all = docs.join('\n');
  const firstSentence = (paragraph: string) => paragraph.split(SENTENCE_END).find(s => s.trim()) ?? paragraph;
  return {
    documents: docs.length, sentences: sentences.length,
    avgSentenceChars: lengths.length ? Math.round(lengths.reduce((a, b) => a + b, 0) / lengths.length) : 0,
    shortSentenceShare: share(lengths.filter(n => n <= 10).length, lengths.length),
    longSentenceShare: share(lengths.filter(n => n >= 30).length, lengths.length),
    openings: {
      question: share(paragraphs.filter(p => /[?？]\s*$/u.test(firstSentence(p).trim())).length, paragraphs.length),
      number: share(paragraphs.filter(p => NUMBER_START.test(p)).length, paragraphs.length),
      firstPerson: share(paragraphs.filter(p => FIRST_PERSON.test(p)).length, paragraphs.length),
    },
    perThousandChars: {
      exclamation: per1000(count(all, /[!！]/gu), total), question: per1000(count(all, /[?？]/gu), total),
      ellipsis: per1000(count(all, /…+|\.{3,}/gu), total), emoji: per1000(count(all, EMOJI), total),
    },
    avgParagraphsPerDocument: docs.length ? Math.round((paragraphs.length / docs.length) * 10) / 10 : 0,
    avgParagraphChars: paragraphs.length ? Math.round(paragraphs.reduce((sum, p) => sum + chars(p), 0) / paragraphs.length) : 0,
    listShare: share(paragraphs.filter(p => LIST_ITEM.test(p)).length, paragraphs.length),
  };
}
