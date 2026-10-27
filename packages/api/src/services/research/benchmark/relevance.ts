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
const CJK = /[\u3400-\u9fff]/;

/**
 * A Chinese keyword is one unspaced phrase the model coined ("上班族快手晚餐"), while titles word it their own way
 * ("打工人快手晚餐"). Beyond the verbatim phrase, it counts when the title holds at least half of the phrase's adjacent
 * character pairs and at least two of them, so a lone shared word ("晚餐") never counts.
 */
const pairsOf = (word: string): string[] => {
  const chars = [...word];
  return chars.slice(1).map((char, index) => chars[index] + char);
};

function sharesMostPairs(title: string, word: string): boolean {
  const pairs = pairsOf(word);
  const found = pairs.filter(pair => title.includes(pair)).length;
  return found >= 2 && found >= pairs.length / 2;
}

/**
 * Whether one keyword word appears in the title. A short Latin word (under 5 letters) must be a whole word, plural s/es
 * allowed ("art" is not in "party"); a longer one, like Chinese, is a substring so joined hashtags still count
 * (#hardangerembroidery).
 */
function hasWord(title: string, word: string): boolean {
  if (CJK.test(word)) return title.includes(word) || sharesMostPairs(title, word);
  if (word.length >= 5 || !LATIN.test(word) || !/[a-z0-9]$/.test(word)) return title.includes(word);
  return new RegExp(`(?<![a-z0-9])${escape(word)}(?:e?s)?(?![a-z0-9])`).test(title);
}

/** A keyword is named when every one of its words appears in the title (any order). */
function names(title: string, keyword: string): boolean {
  const words = normalize(keyword).split(' ').filter(Boolean);
  return words.length > 0 && words.every(word => hasWord(title, word));
}

/**
 * Character pairs that two or more of the confirmed Chinese keywords share ("晚餐" in 上班族快手晚餐 and 工作日晚餐): the niche's
 * core term, which a title can name alone ("打工人晚餐｜青椒肉丝") without repeating a whole phrase.
 */
function coreTerms(terms: readonly string[]): string[] {
  const seen = new Map<string, number>();
  for (const term of terms) {
    for (const pair of new Set(normalize(term).split(' ').filter(word => CJK.test(word)).flatMap(pairsOf))) {
      if (CJK.test(pair[0]) && CJK.test(pair[1])) seen.set(pair, (seen.get(pair) ?? 0) + 1);
    }
  }
  return [...seen].filter(([, count]) => count >= 2).map(([pair]) => pair);
}

/** null without keywords or without titled posts: nothing to say, not "low". */
export function topicRelevance(posts: EvidenceItem[], keywords: readonly string[]): TopicRelevance | null {
  // Counted over the same distinct posts as the account's other metrics.
  const titled = distinctPosts(posts).slice(0, 30).map(post => post.fields.title).filter((title): title is string => typeof title === 'string');
  const terms = keywords.map(keyword => keyword.trim()).filter(Boolean);
  if (terms.length === 0 || titled.length === 0) return null;
  const core = coreTerms(terms);
  const matched = titled.filter(title => {
    const text = normalize(title);
    return terms.some(keyword => names(text, keyword)) || core.some(pair => text.includes(pair));
  }).length;
  const value = Math.round((matched / titled.length) * 1000) / 1000;
  return { value, matched, analyzed: titled.length, level: value >= 0.5 ? 'high' : value >= 0.2 ? 'medium' : 'low' };
}
