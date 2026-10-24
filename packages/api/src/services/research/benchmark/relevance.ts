/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// BENCHMARK-COVERAGE PR-5 (plan §2.6): does an account keep making content on the confirmed niche? Code-computed from the
// fetched posts' titles (captions, hashtags included) against the session's confirmed keywords; never a model guess.
// A label for the benchmark table and its order only: it never decides whether an account qualifies (a new rule would
// need an Owner decision).
import { distinctPosts, type EvidenceItem } from './metrics';

export interface TopicRelevance {
  /** Share of analyzed posts whose title names one of the keywords (0–1). */
  value: number;
  matched: number;
  analyzed: number;
  level: 'high' | 'medium' | 'low';
}

const normalize = (text: string) => text.toLowerCase().replace(/#/g, ' ').replace(/[\s_]+/g, ' ').trim();

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const LATIN = /^[a-z0-9]/;

/**
 * Whether one keyword word appears in the title. A short Latin word (under 5 letters) must be a whole word, plural s/es
 * allowed ("art" is not in "party"); a longer one, like Chinese, is a substring so joined hashtags still count
 * (#hardangerembroidery).
 */
function hasWord(title: string, word: string): boolean {
  if (word.length >= 5 || !LATIN.test(word) || !/[a-z0-9]$/.test(word)) return title.includes(word);
  return new RegExp(`(?<![a-z0-9])${escape(word)}(?:e?s)?(?![a-z0-9])`).test(title);
}

/** A keyword is named when every one of its words appears in the title (any order). */
function names(title: string, keyword: string): boolean {
  const words = normalize(keyword).split(' ').filter(Boolean);
  return words.length > 0 && words.every(word => hasWord(title, word));
}

/** null without keywords or without titled posts: nothing to say, not "low". */
export function topicRelevance(posts: EvidenceItem[], keywords: readonly string[]): TopicRelevance | null {
  // Counted over the same distinct posts as the account's other metrics.
  const titled = distinctPosts(posts).slice(0, 30).map(post => post.fields.title).filter((title): title is string => typeof title === 'string');
  const terms = keywords.map(keyword => keyword.trim()).filter(Boolean);
  if (terms.length === 0 || titled.length === 0) return null;
  const matched = titled.filter(title => terms.some(keyword => names(normalize(title), keyword))).length;
  const value = Math.round((matched / titled.length) * 1000) / 1000;
  return { value, matched, analyzed: titled.length, level: value >= 0.5 ? 'high' : value >= 0.2 ? 'medium' : 'low' };
}
