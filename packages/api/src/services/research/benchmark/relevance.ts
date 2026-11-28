/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// BENCHMARK-COVERAGE PR-5 (plan §2.6): does an account keep making content on the confirmed niche? Code-computed from the
// fetched posts' titles (captions, hashtags included) against the niche of the session's confirmed keywords (nicheTerms.ts);
// never a model guess. Owner 2026-11-28 ("现在修" H, pay4): an account that plainly makes other content is not a benchmark, so the
// same count also keeps it off the candidate card and from qualifying (offTopic below).
import { distinctPosts, type EvidenceItem } from './metrics';
import { nicheTerms } from './nicheTerms';

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

/** A term is named when every one of its words appears in the text (any order). */
function names(title: string, keyword: string): boolean {
  const words = normalize(keyword).split(' ').filter(Boolean);
  return words.length > 0 && words.every(word => hasWord(title, word));
}

/** null without keywords or without titled posts: nothing to say, not "low". */
export function topicRelevance(posts: EvidenceItem[], keywords: readonly string[]): TopicRelevance | null {
  // Counted over the same distinct posts as the account's other metrics.
  const titled = distinctPosts(posts).slice(0, 30).map(post => post.fields.title).filter((title): title is string => typeof title === 'string');
  const terms = nicheTerms(keywords);
  if (terms.length === 0 || titled.length === 0) return null;
  const matched = titled.filter(title => namesNiche(title, terms)).length;
  const value = Math.round((matched / titled.length) * 1000) / 1000;
  return { value, matched, analyzed: titled.length, level: value >= 0.5 ? 'high' : value >= 0.2 ? 'medium' : 'low' };
}

/** Whether a title or an account name names one of the niche terms. */
function namesNiche(text: string, terms: readonly string[]): boolean {
  const normalized = normalize(text);
  return terms.some(term => names(normalized, term));
}

/** Below this share of its analyzed posts naming the niche, a fetched account plainly makes other content. */
export const ON_TOPIC_MIN_SHARE = 0.1;

/**
 * Whether an account plainly makes content off the confirmed niche (Owner 2026-11-28, H): its titled posts are known, its name does
 * not name the niche, and fewer than ON_TOPIC_MIN_SHARE of the posts do (in discovery, where only the posts the keyword search
 * found are known, none of them). Without the niche, a name or titled posts there is nothing to judge by: never off topic.
 */
export function offTopic(input: { name?: string | null; posts: EvidenceItem[]; keywords: readonly string[]; minShare?: number }): boolean {
  const terms = nicheTerms(input.keywords);
  if (terms.length === 0) return false;
  if (typeof input.name === 'string' && namesNiche(input.name, terms)) return false;
  const titled = distinctPosts(input.posts).slice(0, 30).map(post => post.fields.title)
    .filter((title): title is string => typeof title === 'string' && title.trim().length > 0);
  if (titled.length === 0) return false;
  const matched = titled.filter(title => namesNiche(title, terms)).length;
  return matched === 0 || matched / titled.length < (input.minShare ?? ON_TOPIC_MIN_SHARE);
}
